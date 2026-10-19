const { createScheduler } = require('../services/scheduler');
const { resourcePolicy, createResourceMonitor } = require('./resource-policy');

/**
 * 创建 Worker 管理器
 * 负责账号 Worker 进程/线程的启动、停止、重启、消息处理和 RPC 调用
 */
function createWorkerManager(deps) {
    const {
        fork,
        WorkerThread,
        runtimeMode = 'thread',
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        addOrUpdateAccount,
        getAccounts,
        deleteAccount,
        scheduleAutoRelogin,
        refreshAccountCode,
        updateSystemClientVersion,
        onStatusSync,
        onWorkerLog
    } = deps;

    const scheduler = createScheduler('worker_manager');
    const resourceMonitor = createResourceMonitor();
    const restartHistory = new Map();
    const credentialRefreshes = new Map();
    const permitQueue = [];
    const activePermits = new Map();
    const WATCHDOG_PING_MS = 30000;
    const WATCHDOG_TIMEOUT_MS = 90000;
    const DEFAULT_API_TIMEOUT_MS = 10000;
    // 按方法名的超时覆盖。萌宠日记单次操作要串行多次 RPC（读组 → 校验 → 操作 → 重读快照），
    // 10 秒默认值会误判超时，取值与上游一致。
    const METHOD_TIMEOUT_MS = {
        // Milk tea mutations validate and refresh through multiple sequential RPCs.
        getMilkTea: 90000,
        operateMilkTea: 180000,
        milkTeaRecords: 90000,
        getPetDiary: 90000,
        operatePetDiary: 180000,
        getPetDiaryRecords: 30000,
        getPetDiaryFriend: 30000,
    };
    const WATCHDOG_MAX_RESTARTS = 3;
    // 普通离线时先等 Worker 自己的重连循环给出结论（重连成功即取消提醒，
    // 重连失败会转成定时重登）。该兜底只覆盖“一直离线但没有任何失败事件”的卡死场景；
    // 重登拿到 Code 后同样用这段时间等连接真正恢复。
    // 注意：只有等待某个具体恢复动作时才启用；定时重登的排期本身不设期限，
    // 以免重登间隔较长（默认 60 分钟）时提前误报。
    const OFFLINE_NOTICE_FALLBACK_MS = (() => {
        const value = Number(processRef.env && processRef.env.FARM_OFFLINE_NOTICE_GRACE_MS);
        return Number.isFinite(value) && value >= 0 ? value : 3 * 60 * 1000;
    })();
    // 重登成功后额外等待连接恢复的时间
    const OFFLINE_NOTICE_RELOGIN_SLACK_MS = 5 * 60 * 1000;

    /** 是否支持 Thread 模式（非 pkg 打包 + Worker 可用） */
    const threadMode = runtimeMode === 'thread' && !processRef.pkg && typeof WorkerThread === 'function';

    function drainPermitQueue() {
        const limit = resourcePolicy.globalTaskConcurrency;
        while (permitQueue.length > 0) {
            if (limit > 0 && activePermits.size >= limit) break;
            const request = permitQueue.shift();
            const wrk = workers[request.accountId];
            if (!wrk || wrk.process !== request.proc || wrk.stopping) continue;
            activePermits.set(request.token, request);
            try { request.proc.send({ type: 'task_permit_granted', token: request.token }); } catch {
                activePermits.delete(request.token);
            }
        }
    }

    function releaseAccountPermits(accountId) {
        for (let i = permitQueue.length - 1; i >= 0; i -= 1) {
            if (String(permitQueue[i].accountId) === String(accountId)) permitQueue.splice(i, 1);
        }
        for (const [token, request] of activePermits.entries()) {
            if (String(request.accountId) === String(accountId)) activePermits.delete(token);
        }
        drainPermitQueue();
    }

    function cleanText(value) {
        return String(value || '').trim();
    }

    /**
     * 下线提醒分两段：
     * - 普通离线 / 被踢 / 重连失败 / 登录失效先挂起（pending），等待自动恢复结果；
     * - 只有恢复失败（重登失败、兜底超时、自动重登不可用）才真正推送提醒。
     * 这样短暂断网或一次成功的自动重登不会再发邮件。
     */
    const pendingOfflineNotices = new Map();

    /** 立即推送（自动恢复已经明确失败或不可用），并清掉同一账号的挂起项 */
    function notifyAbnormalOffline(accountId, wrk, reason, action, message) {
        if (!wrk || wrk.offlineReminderTriggered) return false;
        wrk.offlineReminderTriggered = true;
        wrk.offlineNoticePending = false;

        const pending = pendingOfflineNotices.get(String(accountId));
        if (pending) {
            pendingOfflineNotices.delete(String(accountId));
            clearOfflineNoticeTimer(pending);
        }

        const normalizedReason = cleanText(reason) || 'unknown';
        triggerOfflineReminder({
            accountId,
            accountName: wrk.name,
            username: wrk.username,
            reason: normalizedReason,
            offlineMs: wrk.disconnectedSince
                ? Date.now() - wrk.disconnectedSince
                : (pending ? Date.now() - pending.since : 0)
        });
        if (action && message) {
            addAccountLog(action, message, accountId, wrk.name, { reason: normalizedReason });
        }
        return true;
    }

    function clearOfflineNoticeTimer(pending) {
        if (!pending || !pending.timerTask) return;
        scheduler.clear(pending.timerTask);
        pending.timerTask = '';
    }

    function startOfflineNotice(accountId, wrk, reason, action, message) {
        if (!wrk || wrk.offlineReminderTriggered || wrk.offlineNoticePending) return false;
        const id = String(accountId || '');
        if (!id || pendingOfflineNotices.has(id)) return false;

        wrk.offlineNoticePending = true;
        const pending = {
            id,
            accountId: id,
            accountName: wrk.name || '',
            username: wrk.username || '',
            reason: cleanText(reason) || 'unknown',
            action: action || '',
            message: message || '',
            since: Date.now(),
            timerTask: '',
            reloginAttempted: false,
            reloginScheduled: false,
            reloginWaiter: null,
        };
        // 交给 scheduleAutoRelogin：拿到新 Code 后仍要等真正连上，
        // 只有重登失败或重启后仍未连接才推送提醒。
        pending.reloginWaiter = (ok) => {
            // 账号后来已重新连上（status_sync 已取消挂起项）时忽略迟到的结果
            if (pendingOfflineNotices.get(id) !== pending) return;
            resolvePendingRelogin(id, ok);
        };

        pendingOfflineNotices.set(id, pending);
        armOfflineNoticeTimer(pending, OFFLINE_NOTICE_FALLBACK_MS, 'offline_timeout');
        log('系统', `账号 ${wrk.name} 已离线，等待自动恢复结果后再决定是否发送下线提醒`, {
            accountId: id, accountName: wrk.name, reason: pending.reason
        });
        return true;
    }

    /** 挂起提醒的兜底期限：到点仍未恢复才推送 */
    function armOfflineNoticeTimer(pending, delayMs, reason) {
        clearOfflineNoticeTimer(pending);
        if (!pending || !(delayMs > 0)) return;
        pending.timerTask = `offline_notice_timer_${pending.id}`;
        scheduler.setTimeoutTask(pending.timerTask, delayMs, () => {
            if (pendingOfflineNotices.get(pending.id) !== pending) return;
            pending.timerTask = '';
            pending.reason = reason || pending.reason;
            settleOfflineNotice(pending);
        });
    }

    /** 把自动重登挂到等待恢复的账号上；返回是否排期成功 */
    function schedulePendingRelogin(accountId, reason) {
        const pending = pendingOfflineNotices.get(String(accountId));
        if (!pending || typeof scheduleAutoRelogin !== 'function') return false;
        const scheduled = scheduleAutoRelogin(accountId, reason, pending.reloginWaiter);
        if (!scheduled) return false;
        pending.reloginScheduled = true;
        // 排期成功后以重登结果为界；具体期限在 resolvePendingRelogin 里确定
        clearOfflineNoticeTimer(pending);
        return true;
    }

    /** 恢复动作已有结果时通知挂起项；没有挂起项时返回 false */
    function resolvePendingRelogin(accountId, ok, overrides = {}) {
        const pending = pendingOfflineNotices.get(String(accountId));
        if (!pending) return false;
        pending.reloginAttempted = true;
        if (!ok) {
            settleOfflineNotice(pending, overrides);
            return true;
        }
        // 拿到新 Code 不等于已经连上：等连接恢复事件来取消，
        // 超时仍离线才提醒（避免“重登成功但随后仍然掉线”被静默吞掉）。
        pending.reloginSucceeded = true;
        armOfflineNoticeTimer(pending, OFFLINE_NOTICE_FALLBACK_MS + OFFLINE_NOTICE_RELOGIN_SLACK_MS, 'relogin_no_connection');
        return true;
    }

    function cancelOfflineNotice(accountId, reason = '') {
        const key = String(accountId || '');
        const pending = pendingOfflineNotices.get(key);
        if (!pending) return false;
        pendingOfflineNotices.delete(key);
        clearOfflineNoticeTimer(pending);

        const wrk = workers[key];
        if (wrk) wrk.offlineNoticePending = false;
        log('系统', `账号 ${pending.accountName || key} 已恢复连接，取消下线提醒`, {
            accountId: key, accountName: pending.accountName, reason: reason || 'recovered'
        });
        return true;
    }

    /** 真正推送下线提醒；恢复已经明确失败或兜底期限已到 */
    function settleOfflineNotice(pending, overrides = {}) {
        if (!pending || pendingOfflineNotices.get(pending.id) !== pending) return false;
        pendingOfflineNotices.delete(pending.id);
        clearOfflineNoticeTimer(pending);

        const wrk = workers[pending.id];
        if (wrk && !wrk.stopping) wrk.offlineReminderTriggered = true;
        if (wrk) wrk.offlineNoticePending = false;

        const reason = cleanText(overrides.reason || pending.reason) || 'unknown';
        const offlineMs = Math.max(0, Number(overrides.offlineMs) || (Date.now() - Number(pending.since || Date.now())));
        const minutes = Math.floor(offlineMs / 60000);
        const accountName = pending.accountName || (wrk && wrk.name) || '';
        const username = pending.username || (wrk && wrk.username) || '';
        const message = pending.message
            || `账号 ${accountName || pending.id} 离线 ${minutes} 分钟后仍未恢复（原因: ${reason}），已发送下线提醒`;

        triggerOfflineReminder({
            accountId: pending.accountId,
            accountName,
            username,
            reason,
            offlineMs
        });
        if (pending.action) {
            addAccountLog(pending.action, message, pending.accountId, accountName, {
                reason, offlineMs, reloginAttempted: pending.reloginAttempted
            });
        }
        return true;
    }

    function buildQqAvatarUrl(qq) {
        const value = cleanText(qq);
        if (!/^\d+$/.test(value)) return '';
        return `https://q1.qlogo.cn/g?b=qq&nk=${  value  }&s=100`;
    }

    function resolveLoginProfile(status, worker) {
        const data = status && typeof status === 'object' ? status : {};
        const info = data.status && typeof data.status === 'object' ? data.status : {};
        const platform = cleanText(info.platform || data.platform || worker.platform || 'qq').toLowerCase();
        const gid = cleanText(info.gid || data.gid);
        const openId = cleanText(info.openId || info.open_id || data.openId || data.open_id);
        const avatar = cleanText(info.avatar || info.avatarUrl || info.avatar_url || data.avatar || data.avatarUrl || data.avatar_url);
        const qq = cleanText(info.qq || info.uin || data.qq || data.uin || worker.qq || worker.uin);
        const fallbackAvatar = platform === 'qq' ? buildQqAvatarUrl(qq) : '';

        return {
            platform,
            gid,
            openId,
            qq,
            avatar: avatar || fallbackAvatar
        };
    }

    function syncAccountProfile(accountId, msgData, worker) {
        const profile = resolveLoginProfile(msgData, worker);
        const update = { id: accountId };

        if (profile.openId && worker.openId !== profile.openId) {
            update.openId = profile.openId;
        }
        if (profile.gid && worker.gid !== profile.gid) {
            update.gid = profile.gid;
        }
        if (profile.qq && worker.qq !== profile.qq) {
            update.qq = profile.qq;
            update.uin = profile.qq;
        }
        if (profile.avatar && worker.avatar !== profile.avatar) {
            update.avatar = profile.avatar;
        }

        if (Object.keys(update).length <= 1) return;

        addOrUpdateAccount(update);
        if (update.openId) worker.openId = update.openId;
        if (update.gid) worker.gid = update.gid;
        if (update.qq) {
            worker.qq = update.qq;
            worker.uin = update.uin;
        }
        if (update.avatar) worker.avatar = update.avatar;
    }

    /**
     * 创建 Thread Worker
     */
    function createThreadWorker(account) {
        const worker = new WorkerThread(workerScriptPath, {
            workerData: {
                accountId: String(account.id || ''),
                channel: 'thread'
            }
        });
        // 统一 send/kill 接口
        worker.send = (msg) => worker.postMessage(msg);
        worker.kill = () => worker.terminate();
        return worker;
    }

    /**
     * 创建 Fork Worker
     */
    function createForkWorker(account) {
        if (processRef.pkg) {
            // pkg 打包模式：fork 主入口而不是 worker 脚本
            return fork(mainEntryPath, [], {
                execPath: processRef.execPath,
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
                env: {
                    ...processRef.env,
                    FARM_WORKER: '1',
                    FARM_ACCOUNT_ID: String(account.id || '')
                }
            });
        }
        return fork(workerScriptPath, [], {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            env: {
                ...processRef.env,
                FARM_ACCOUNT_ID: String(account.id || '')
            }
        });
    }

    /**
     * 根据运行模式创建 Worker
     */
    function createWorker(account) {
        if (threadMode) return createThreadWorker(account);
        return createForkWorker(account);
    }

    /**
     * 启动账号 Worker
     */
    function startWorker(account) {
        if (!account || !account.id) return false;
        if (workers[account.id]) return false;

        const runningCount = Object.keys(workers).length;
        if (resourcePolicy.maxRunningAccounts > 0 && runningCount >= resourcePolicy.maxRunningAccounts) {
            log('系统', `低配资源策略已阻止启动账号 ${account.name}：运行账号数达到 ${resourcePolicy.maxRunningAccounts}`, {
                accountId: String(account.id), accountName: account.name
            });
            return false;
        }
        const rssMb = processRef.memoryUsage ? processRef.memoryUsage().rss / 1024 / 1024 : 0;
        if (resourcePolicy.maxRssMb > 0 && rssMb >= resourcePolicy.maxRssMb) {
            log('系统', `资源策略已阻止启动账号 ${account.name}：RSS ${Math.round(rssMb)}MB`, {
                accountId: String(account.id), accountName: account.name
            });
            return false;
        }

        log('系统', `正在启动账号: ${  account.name}`, {
            accountId: String(account.id),
            accountName: account.name
        });

        let proc = null;
        try {
            proc = createWorker(account);
        } catch (err) {
            const errorMsg = err && err.message ? err.message : String(err || 'unknown error');
            log('错误', `账号 ${  account.name  } 启动失败: ${  errorMsg}`, {
                accountId: String(account.id),
                accountName: account.name
            });
            addAccountLog('start_failed', `账号 ${  account.name  } 启动失败`,
                account.id, account.name, { reason: errorMsg });
            return false;
        }

        // 注册 Worker 记录
        workers[account.id] = {
            process: proc,
            status: null,
            logs: [],
            requests: new Map(),
            reqId: 1,
            name: account.name,
            username: account.username || '',
            platform: account.platform || 'qq',
            gid: account.gid || '',
            openId: account.openId || account.open_id || '',
            qq: account.qq || account.uin || '',
            uin: account.uin || account.qq || '',
            avatar: account.avatar || account.avatarUrl || '',
            stopping: false,
            disconnectedSince: 0,
            offlineReminderTriggered: false,
            offlineNoticePending: false,
            autoDeleteTriggered: false,
            wsError: null,
            lastPongAt: Date.now()
        };

        // 发送启动配置
        proc.send({
            type: 'start',
            config: { code: account.code, platform: account.platform, loginType: account.loginType || 'manual' }
        });

        // 发送配置快照
        proc.send({
            type: 'config_sync',
            config: buildConfigSnapshotForAccount(account.id)
        });

        // 监听 Worker 消息
        proc.on('message', (msg) => {
            handleWorkerMessage(account.id, msg);
        });

        // 监听 Worker 错误
        proc.on('error', (err) => {
            log('系统', `账号 ${  account.name  } 子进程启动失败: ${ 
                err && err.message ? err.message : err}`, {
                accountId: String(account.id),
                accountName: account.name
            });
        });

        // 监听 Worker 退出
        proc.on('exit', (code, signal) => {
            const wrk = workers[account.id];
            const displayName = wrk && wrk.name ? wrk.name : account.name;

            log('系统', `账号 ${  displayName  } 进程退出 (code=${  code 
                }, signal=${  signal || 'none'  })`, {
                accountId: String(account.id),
                accountName: displayName,
                runtimeMode: threadMode ? 'thread' : 'fork'
            });

            if (wrk && !wrk.stopping) {
                const reason = `worker_exit:code=${code == null ? 'unknown' : code},signal=${signal || 'none'}`;
                // Worker 退出后自身不会再重连：还有凭据刷新/重登在途时继续等待结果，
                // 否则已没有任何恢复途径，直接结算提醒。
                const pending = pendingOfflineNotices.get(String(account.id));
                if (pending) {
                    pending.reason = reason;
                    const recoveryInFlight = pending.reloginScheduled
                        || pending.reloginSucceeded
                        || credentialRefreshes.has(account.id);
                    if (!recoveryInFlight) settleOfflineNotice(pending);
                } else {
                    notifyAbnormalOffline(account.id, wrk, reason, 'worker_unexpected_exit',
                        `账号 ${displayName} 异常掉线（Worker 进程意外退出）`);
                }
            }

            scheduler.clear(`force_kill_${  account.id}`);
            scheduler.clear(`restart_fallback_${  account.id}`);
            releaseAccountPermits(account.id);

            // 清理所有未完成的 API 请求
            if (wrk && wrk.requests && wrk.requests.size > 0) {
                for (const [reqId, pending] of wrk.requests.entries()) {
                    scheduler.clear(`api_timeout_${  account.id  }_${  reqId}`);
                    try { pending.reject(new Error('Worker exited')); } catch { }
                }
                wrk.requests.clear();
            }

            if (wrk && wrk.process === proc) {
                delete workers[account.id];
            }
        });

        return true;
    }

    /**
     * 停止账号 Worker
     * @param {string} accountId
     * @param {{ userInitiated?: boolean }} [options] - 用户在面板手动停止时不再发送下线提醒
     */
    function stopWorker(accountId, options = {}) {
        const wrk = workers[accountId];
        if (!wrk) return;

        const targetProc = wrk.process;
        wrk.stopping = true;
        if (options.userInitiated) cancelOfflineNotice(accountId, 'user_stop');

        // 发送停止指令
        wrk.process.send({ type: 'stop' });

        // 1 秒后强制杀死
        scheduler.setTimeoutTask(`force_kill_${  accountId}`, 1000, () => {
            const current = workers[accountId];
            if (current && current.process === targetProc) {
                current.process.kill();
                delete workers[accountId];
            }
        });
    }

    /**
     * 重启账号 Worker
     */
    function restartWorker(account) {
        if (!account) return;
        const accountId = account.id;
        const wrk = workers[accountId];

        // 如果未运行，直接启动
        if (!wrk) return startWorker(account);

        const targetProc = wrk.process;
        let restarted = false;

        const doRestart = () => {
            if (restarted) return;
            restarted = true;
            scheduler.clear(`restart_fallback_${  accountId}`);

            const current = workers[accountId];
            if (!current) return startWorker(account);
            if (current.process !== targetProc) return;

            delete workers[accountId];
            startWorker(account);
        };

        const forceKill = () => {
            const current = workers[accountId];
            if (!current || current.process !== targetProc) return false;
            try { current.process.kill(); } catch { }
            delete workers[accountId];
            return true;
        };

        // 如果进程已退出，直接重启
        if (typeof targetProc.exitCode === 'number' || targetProc.signalCode) {
            return doRestart();
        }

        // 先尝试正常停止，再等待退出事件。重启属于自动恢复，不能取消挂起中的下线提醒
        targetProc.once('exit', doRestart);
        stopWorker(accountId);

        // 1500ms 超时回退
        scheduler.setTimeoutTask(`restart_fallback_${  accountId}`, 1500, () => {
            if (restarted) return;
            forceKill();
            doRestart();
        });
    }

    /**
     * 处理 Worker 消息
     */
    function handleWorkerMessage(accountId, msg) {
        const wrk = workers[accountId];
        if (!wrk) return;

        if (msg.type === 'task_permit_request') {
            const token = `${accountId}:${String(msg.token || '')}`;
            permitQueue.push({ accountId, token, proc: wrk.process, requestedAt: Date.now() });
            drainPermitQueue();
        } else if (msg.type === 'task_permit_release') {
            activePermits.delete(`${accountId}:${String(msg.token || '')}`);
            drainPermitQueue();
        } else if (msg.type === 'status_sync') {
            // 状态同步
            wrk.status = normalizeStatusForPanel(msg.data, accountId, wrk.name);
            if (typeof onStatusSync === 'function') {
                onStatusSync(accountId, wrk.status, wrk.name);
            }

            syncAccountProfile(accountId, msg.data, wrk);

            // 同步昵称
            if (msg.data && msg.data.status && msg.data.status.name) {
                const nick = String(msg.data.status.name).trim();
                if (nick && nick !== '未知' && nick !== '未登录') {
                    if (wrk.nick !== nick) {
                        const oldNick = wrk.nick;
                        wrk.nick = nick;
                        addOrUpdateAccount({ id: accountId, nick });
                        if (oldNick !== nick) {
                            log('系统', `已同步账号昵称: ${  oldNick || 'None'  } -> ${  nick}`, {
                                accountId, accountName: wrk.name
                            });
                        }
                    }
                }
            }

            // 连接状态追踪和离线提醒
            const isConnected = !!(msg.data && msg.data.connection && msg.data.connection.connected);
            if (isConnected) {
                wrk.disconnectedSince = 0;
                wrk.offlineReminderTriggered = false;
                wrk.autoDeleteTriggered = false;
                wrk.wsError = null;
                cancelOfflineNotice(accountId, 'reconnected');
            } else if (!wrk.stopping) {
                const now = Date.now();
                if (!wrk.disconnectedSince) wrk.disconnectedSince = now;

                const offlineDuration = now - wrk.disconnectedSince;
                // 先挂起提醒，等 Worker 的重连循环或自动重登给出结果
                if (!wrk.offlineReminderTriggered && !wrk.offlineNoticePending
                    && offlineDuration >= 60000) {
                    startOfflineNotice(accountId, wrk, 'offline', 'offline_reminder', '');
                }

                const autoDeleteMs = typeof getOfflineAutoDeleteMs === 'function'
                    ? getOfflineAutoDeleteMs(wrk.username)
                    : Infinity;
                if (!wrk.autoDeleteTriggered && offlineDuration >= autoDeleteMs) {
                    wrk.autoDeleteTriggered = true;
                    const offlineMinutes = Math.floor(offlineDuration / 60000);
                    log('系统', `账号 ${  wrk.name  } 持续离线 ${  offlineMinutes  } 分钟，自动删除账号信息`, {
                        accountId: String(accountId),
                        accountName: wrk.name
                    });
                    // 复用挂起中的下线提醒，避免同一账号发两封邮件
                    const pendingDeleteNotice = pendingOfflineNotices.get(String(accountId));
                    if (pendingDeleteNotice) {
                        settleOfflineNotice(pendingDeleteNotice, { reason: 'offline_timeout', offlineMs: offlineDuration });
                    } else {
                        triggerOfflineReminder({
                            accountId,
                            accountName: wrk.name,
                            username: wrk.username,
                            reason: 'offline_timeout',
                            offlineMs: offlineDuration
                        });
                    }
                    addAccountLog('offline_delete',
                        `账号 ${  wrk.name  } 持续离线 ${  offlineMinutes  } 分钟，已自动删除`,
                        accountId, wrk.name, { reason: 'offline_timeout', offlineMs: offlineDuration });
                    stopWorker(accountId);
                    try {
                        if (typeof deleteAccount === 'function') deleteAccount(accountId);
                    } catch (err) {
                        log('错误', `删除离线账号失败: ${  err.message}`);
                    }
                }
            }
        } else if (msg.type === 'log') {
            // 日志消息
            const timestamp = Date.now();
            const entry = {
                ...msg.data,
                logId: `worker-${accountId}-${timestamp}-${globalLogs.length}`,
                accountId,
                accountName: wrk.name,
                ts: timestamp,
                level: msg.data && msg.data.isWarn ? 'warn' : 'info',
                source: 'business',
                meta: msg.data && msg.data.meta ? msg.data.meta : {}
            };
            entry._searchText = (`${entry.msg || ''  } ${  entry.tag || '' 
                } ${  JSON.stringify(entry.meta || {})}`).toLowerCase();

            wrk.logs.push(entry);
            if (wrk.logs.length > 1000) wrk.logs.shift();

            globalLogs.push(entry);
            if (globalLogs.length > 2000) globalLogs.shift();

            if (typeof onWorkerLog === 'function') {
                onWorkerLog(entry, accountId, wrk.name);
            }
        } else if (msg.type === 'error') {
            log('错误', `账号[${  accountId  }]进程报错: ${  msg.error}`, {
                accountId: String(accountId),
                accountName: wrk.name
            });
        } else if (msg.type === 'ws_error') {
            // WebSocket 错误
            const code = Number(msg.code) || 0;
            const message = msg.message || '';
            wrk.wsError = { code, message, at: Date.now() };

            // Code 400 = 登录失效
            if (code === 400) {
                startOfflineNotice(accountId, wrk, `ws_400:${message || '登录失效'}`,
                    'offline_reminder', '');
                addAccountLog('ws_400', `账号 ${  wrk.name  } 登录失效，请更新 Code`,
                    accountId, wrk.name);
                if (typeof refreshAccountCode === 'function' && !credentialRefreshes.has(accountId)) {
                    const task = Promise.resolve(refreshAccountCode(accountId, 'ws_400'))
                        .then(ok => {
                            if (ok) return resolvePendingRelogin(accountId, true);
                            // 立即刷新失败后仍会按间隔重登，继续等待那次结果；
                            // 无法排期重登时（关闭/熔断）才在下一步立刻提醒
                            if (schedulePendingRelogin(accountId, 'ws_400_refresh_failed')) return;
                            resolvePendingRelogin(accountId, false, { reason: 'refresh_failed' });
                        })
                        .finally(() => credentialRefreshes.delete(accountId));
                    credentialRefreshes.set(accountId, task);
                }
            }
        } else if (msg.type === 'watchdog_pong') {
            wrk.lastPongAt = Date.now();
        } else if (msg.type === 'account_kicked') {
            // 被踢下线
            const reason = msg.reason || '未知';
            log('系统', `账号 ${  wrk.name  } 被踢下线，已自动停止账号`, {
                accountId: String(accountId),
                accountName: wrk.name
            });

            startOfflineNotice(accountId, wrk, `kickout:${reason}`, 'kickout_stop', '');
            addAccountLog('kickout_stop',
                `账号 ${  wrk.name  } 被踢下线，已自动停止`,
                accountId, wrk.name, { reason });

            stopWorker(accountId);
            const scheduled = schedulePendingRelogin(accountId, `kickout:${reason}`)
                || schedulePendingRelogin(accountId, 'kickout');
            // 未启用自动重登时，停止 Worker 后没有任何恢复途径，需要立即提醒
            if (!scheduled) resolvePendingRelogin(accountId, false, { reason: `kickout:${reason}` });
        } else if (msg.type === 'ws_reconnect_failed') {
            const reason = msg.reason || '未知';
            log('系统', `账号 ${  wrk.name  } 连接多次重试失败，已自动停止账号`, {
                accountId: String(accountId),
                accountName: wrk.name
            });

            startOfflineNotice(accountId, wrk, `ws_reconnect_failed:${reason}`, 'ws_reconnect_failed', '');
            addAccountLog('ws_reconnect_failed',
                `账号 ${  wrk.name  } 连接多次重试失败，已自动停止`,
                accountId, wrk.name, { reason });

            stopWorker(accountId);
            const scheduled = schedulePendingRelogin(accountId, `ws_reconnect_failed:${reason}`)
                || schedulePendingRelogin(accountId, 'ws_reconnect_failed');
            // 未启用自动重登时，停止 Worker 后没有任何恢复途径，需要立即提醒
            if (!scheduled) resolvePendingRelogin(accountId, false, { reason: `ws_reconnect_failed:${reason}` });
        } else if (msg.type === 'client_version_update') {
            const clientVersion = cleanText(msg.clientVersion);
            if (clientVersion && typeof updateSystemClientVersion === 'function') {
                const changed = updateSystemClientVersion(clientVersion);
                if (changed) {
                    log('系统', `已根据服务端 WebSocket 回包更新游戏版本: ${clientVersion}`, {
                        accountId: String(accountId), accountName: wrk.name
                    });
                    addAccountLog('client_version_update',
                        `服务端已自动更新游戏版本: ${clientVersion}`,
                        accountId, wrk.name, { previous: cleanText(msg.previous) });
                }
            }
        } else if (msg.type === 'automation_patch') {
            const patch = msg.patch && typeof msg.patch === 'object' ? msg.patch : {};
            if ((patch.automation && typeof patch.automation === 'object')
                || patch.friendBadRetryDate !== undefined) {
                const store = require('../models/store');
                store.applyConfigSnapshot(patch, { accountId });
                const currentWrk = workers[accountId];
                if (currentWrk && currentWrk.process) {
                    currentWrk.process.send({
                        type: 'config_sync',
                        config: buildConfigSnapshotForAccount(accountId)
                    });
                }
            }
        } else if (msg.type === 'bag_seed_priority_sync') {
            const store = require('../models/store');
            store.applyConfigSnapshot({
                bagSeedPriority: msg.priority,
                bagSeedKnownIds: msg.knownIds
            }, { accountId });
            const currentWrk = workers[accountId];
            if (currentWrk && currentWrk.process) {
                currentWrk.process.send({
                    type: 'config_sync',
                    config: buildConfigSnapshotForAccount(accountId)
                });
            }
        } else if (msg.type === 'api_response') {
            // API 响应
            const { id, result, error } = msg;
            scheduler.clear(`api_timeout_${  accountId  }_${  id}`);

            const pending = wrk.requests.get(id);
            if (pending) {
                if (error) pending.reject(new Error(error));
                else pending.resolve(result);
                wrk.requests.delete(id);
            }
        } else if (msg.type === 'friend_blacklist_add') {
            // 好友黑名单添加
            const gid = Number(msg.gid) || 0;
            if (gid > 0) {
                const { addFriendToBlacklist } = require('../models/store');
                addFriendToBlacklist(accountId, gid);
                log('好友', `已将好友 ${  msg.friendName || `GID:${  gid}`  } 加入黑名单`, {
                    accountId: String(accountId),
                    accountName: wrk.name,
                    friendGid: gid,
                    friendName: msg.friendName,
                    reason: msg.reason
                });

                // 同步黑名单到 Worker
                const currentWrk = workers[accountId];
                if (currentWrk && currentWrk.process) {
                    currentWrk.process.send({
                        type: 'config_sync',
                        config: buildConfigSnapshotForAccount(accountId)
                    });
                }
            }
        }
    }

    function findAccount(accountId) {
        const data = typeof getAccounts === 'function' ? getAccounts() : { accounts: [] };
        return (data.accounts || []).find(account => String(account.id) === String(accountId));
    }

    const persistInactiveActivities = () => {
        try {
            const changed = require('../models/store').persistInactiveActivityAutomation();
            for (const accountId of changed) {
                const wrk = workers[accountId];
                if (wrk?.process && !wrk.stopping) wrk.process.send({
                    type: 'config_sync', config: buildConfigSnapshotForAccount(accountId),
                });
            }
        } catch (error) {
            log('系统', `活动过期开关保存失败：${error.message}`);
        }
    };
    persistInactiveActivities();
    scheduler.setIntervalTask('inactive_activity_config', WATCHDOG_PING_MS, persistInactiveActivities);

    scheduler.setIntervalTask('watchdog_tick', WATCHDOG_PING_MS, () => {
        const now = Date.now();
        for (const [accountId, wrk] of Object.entries(workers)) {
            if (!wrk || wrk.stopping) continue;
            if (now - Number(wrk.lastPongAt || 0) > WATCHDOG_TIMEOUT_MS) {
                const history = (restartHistory.get(accountId) || [])
                    .filter(at => now - at < 60 * 60 * 1000);
                if (history.length >= WATCHDOG_MAX_RESTARTS) {
                    wrk.stopping = true;
                    // 已是最后一次自动恢复（停止账号），不再等待后续重试
                    stopWorker(accountId, { userInitiated: true });
                    notifyAbnormalOffline(accountId, wrk, 'worker_watchdog_stopped',
                        'offline_reminder', `账号 ${wrk.name} Worker 连续无响应，已发送下线提醒`);
                    log('错误', `账号 ${wrk.name} Worker 连续无响应，已停止自动重启`, {
                        accountId, accountName: wrk.name
                    });
                    addAccountLog('worker_watchdog_stopped',
                        `Worker 一小时内已重启 ${WATCHDOG_MAX_RESTARTS} 次，停止账号`,
                        accountId, wrk.name);
                    continue;
                }
                history.push(now);
                restartHistory.set(accountId, history);
                const account = findAccount(accountId);
                log('错误', `账号 ${wrk.name} Worker 超过 90 秒无响应，正在自动重启`, {
                    accountId, accountName: wrk.name
                });
                if (account) restartWorker(account);
                continue;
            }
            try { wrk.process.send({ type: 'watchdog_ping', at: now }); } catch { }
        }
    }, { preventOverlap: true });

    /**
     * 调用 Worker API（RPC）
     */
    function callWorkerApi(accountId, method, ...args) {
        const wrk = workers[accountId];
        if (!wrk) return Promise.reject(new Error('账号未运行'));

        // 检查最后一个参数是否包含 _timeoutMs
        const lastArg = args.at(-1);
        const customTimeout = lastArg && typeof lastArg === 'object' && lastArg._timeoutMs;
        const timeoutMs = customTimeout
            ? Number(lastArg._timeoutMs) || DEFAULT_API_TIMEOUT_MS
            : METHOD_TIMEOUT_MS[method] || DEFAULT_API_TIMEOUT_MS;

        const actualArgs = customTimeout ? args.slice(0, -1) : args;

        return new Promise((resolve, reject) => {
            const reqId = wrk.reqId++;
            wrk.requests.set(reqId, { resolve, reject });

            // API 超时保护
            scheduler.setTimeoutTask(`api_timeout_${  accountId  }_${  reqId}`, timeoutMs, () => {
                if (wrk.requests.has(reqId)) {
                    wrk.requests.delete(reqId);
                    reject(new Error('API Timeout'));
                }
            });

            wrk.process.send({
                type: 'api_call',
                id: reqId,
                method,
                args: actualArgs
            });
        });
    }

    return {
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
        getResourceStatus: () => ({
            policy: resourcePolicy,
            runtime: resourceMonitor.snapshot(),
            governor: { active: activePermits.size, queued: permitQueue.length }
        }),
        dispose: () => {
            scheduler.dispose();
            resourceMonitor.dispose();
        }
    };
}

module.exports = { createWorkerManager };
