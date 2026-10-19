const { createScheduler } = require('../services/scheduler');
const wxLoginAdapter = require('../services/wx-login-adapter');
const { getChinaDateKey } = require('../utils/utils');

function createAutoCodeRefreshService(deps) {
  const {
    store,
    getAccounts,
    addOrUpdateAccount,
    resolveWorkerControls,
    log,
    addAccountLog,
    napcatLogin = require('../services/napcat-login'),
  } = deps;

  const scheduler = createScheduler('auto_code_refresh');
  const recoveryState = new Map();
  const MAX_DAILY_RECOVERIES = 8;
  const MAX_CONSECUTIVE_FAILURES = 3;
  // 刷新会切换 NapCat 的 QQ 会话，跨账号必须串行执行。
  let refreshQueue = Promise.resolve();

  function getRecoveryState(accountId) {
    // 每日恢复次数按游戏服使用的 UTC+8 日期统计；用 UTC 日期会在凌晨 0–8 点算错一天。
    const date = getChinaDateKey();
    const current = recoveryState.get(String(accountId));
    if (!current || current.date !== date) {
      const fresh = { date, attempts: 0, failures: 0 };
      recoveryState.set(String(accountId), fresh);
      return fresh;
    }
    return current;
  }

  function isRecoveryReason(reason) {
    return ['ws_400', 'kickout:', 'ws_reconnect_failed:', 'refresh_failed']
      .some(prefix => String(reason || '').includes(prefix));
  }

  function getTaskName(accountId) {
    return `refresh_${  String(accountId || '')}`;
  }

  function getKeepaliveTaskName(accountId) {
    return `wx_keepalive_${String(accountId || '')}`;
  }

  function findAccount(accountId) {
    const data = getAccounts();
    const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
    return accounts.find(acc => String(acc.id) === String(accountId));
  }

  function normalizeConfig(accountId) {
    const cfg = store.getAutoCodeRefresh ? store.getAutoCodeRefresh(accountId) : null;
    return {
      enabled: cfg && cfg.enabled === true,
      intervalMinutes: Math.max(1, Math.min(1440, Number(cfg && cfg.intervalMinutes) || 60)),
    };
  }

  async function requestFarmCode(account) {
    const platform = String(account && account.platform || '').toLowerCase();
    // QQ 扫码账号：通过 NapCat 中保留的 QQ 会话快速登录并重新铸取 Code。
    if (platform !== 'wx') {
      const uin = String(account && (account.uin || account.qq) || '').trim();
      if (!uin) throw new Error('账号缺少 QQ 号，无法自动刷新 Code');
      const result = await napcatLogin.refreshCodeForUin(uin);
      return String(result && result.code || '');
    }

    const wxid = String(account && account.wxid || '').trim();
    if (!wxid) throw new Error('账号缺少 wxid，无法自动刷新 Code');

    if (!account.loginBuffer) throw new Error('账号缺少应用宝登录凭据，请重新扫码登录');
    if (account.refreshtoken) {
      const keepalive = await wxLoginAdapter.keepWxCredentialAlive(account);
      if (!keepalive.Success) throw new Error(keepalive.Message || '微信凭证续期失败');
    }
    const local = await wxLoginAdapter.getFarmCode(wxid, { accountId: account.id });
    if (local.Success && local.Data && local.Data.code) return String(local.Data.code);
    throw new Error(local.Message || '进程内获取 Code 失败');
  }

  async function runRefreshAccountCode(accountId, reason = 'timer') {
    const account = findAccount(accountId);
    if (!account) return false;

    const recovery = isRecoveryReason(reason) ? getRecoveryState(accountId) : null;
    if (recovery && (recovery.attempts >= MAX_DAILY_RECOVERIES
      || recovery.failures >= MAX_CONSECUTIVE_FAILURES)) {
      addAccountLog('auto_relogin_blocked', '自动重登已熔断，请检查网络或重新扫码',
        account.id, account.name, { reason, ...recovery });
      return false;
    }
    if (recovery) recovery.attempts += 1;

    try {
      const code = await requestFarmCode(account);
      const nextAccount = { ...account, code };
      addOrUpdateAccount(nextAccount);

      const controls = typeof resolveWorkerControls === 'function' ? (resolveWorkerControls() || {}) : {};
      if (typeof controls.restartWorker === 'function') controls.restartWorker(nextAccount);

      addAccountLog('auto_code_refresh', `自动刷新 Code 成功，已重启账号: ${  account.name}`,
        account.id, account.name, { reason });
      log('系统', `自动刷新 Code 成功: ${  account.name}`, {
        accountId: String(account.id),
        accountName: account.name,
      });
      if (recovery) recovery.failures = 0;
      return true;
    } catch (err) {
      if (recovery) recovery.failures += 1;
      addAccountLog('auto_code_refresh_failed', `自动刷新 Code 失败: ${  err.message}`,
        account.id, account.name, { reason });
      log('错误', `自动刷新 Code 失败: ${  account.name  } - ${  err.message}`, {
        accountId: String(account.id),
        accountName: account.name,
      });
      return false;
    }
  }

  // 对外入口：跨账号串行，避免并发切换 NapCat 会话。
  function refreshAccountCode(accountId, reason = 'timer') {
    const run = refreshQueue.then(() => runRefreshAccountCode(accountId, reason), () => runRefreshAccountCode(accountId, reason));
    refreshQueue = run.then(() => {}, () => {});
    return run;
  }

  function scheduleAccount(accountId) {
    const cfg = normalizeConfig(accountId);
    const taskName = getTaskName(accountId);
    scheduler.clear(taskName);
    scheduler.clear(getKeepaliveTaskName(accountId));

    const account = findAccount(accountId);
    if (!account) return;

    const platform = String(account.platform || '').toLowerCase();
    const uin = String(account.uin || account.qq || '').trim();
    if (platform === 'wx') {
      if (!String(account.wxid || '').trim()) {
        log('系统', '自动刷新 Code 未启动: 账号缺少 wxid', {
          accountId: String(accountId),
          accountName: account.name || '',
        });
        return;
      }

      if (account.loginBuffer && account.refreshtoken) {
        scheduler.setIntervalTask(getKeepaliveTaskName(accountId), 30 * 60000, async () => {
          const latest = findAccount(accountId);
          if (!latest) return;
          const result = await wxLoginAdapter.keepWxCredentialAlive(latest);
          if (!result.Success) {
            log('错误', `微信凭证保活失败: ${latest.name} - ${result.Message || '未知错误'}`, {
              accountId: String(accountId), accountName: latest.name,
            });
          }
        }, { preventOverlap: true });
      }
    } else if (!uin) {
      // 历史 QQ 账号可能没有记录 QQ 号，无法自动续登；保持静默避免误导。
      return;
    }

    if (!cfg.enabled) return;

    scheduler.setIntervalTask(taskName, cfg.intervalMinutes * 60000, () => {
      refreshAccountCode(accountId, 'timer');
    }, { preventOverlap: true });

    log('系统', `自动刷新 Code 已启用: ${  account.name  }，间隔 ${  cfg.intervalMinutes  } 分钟`, {
      accountId: String(accountId),
      accountName: account.name,
    });
  }

  function rescheduleAll() {
    scheduler.clearAll();
    const data = getAccounts();
    const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
    for (const account of accounts) {
      scheduleAccount(account.id);
    }
  }

  function stopAccount(accountId) {
    scheduler.clear(getTaskName(accountId));
    scheduler.clear(getKeepaliveTaskName(accountId));
    scheduler.clear(`relogin_${String(accountId || '')}`);
  }

  /**
   * 按账号间隔安排一次延迟重登。
   * @param {string} accountId
   * @param {string} [reason]
   * @param {(ok: boolean) => void} [onResult] - 重登尝试结束时回调，供下线提醒等待结果
   * @returns {{ delayMs: number } | null} 排期信息；未排期时返回 null
   */
  function scheduleRelogin(accountId, reason = 'offline', onResult = null) {
    const cfg = normalizeConfig(accountId);
    if (!cfg.enabled) return null;
    const account = findAccount(accountId);
    if (!account) return null;
    const platform = String(account.platform || '').toLowerCase();
    if (platform === 'wx' && !account.loginBuffer) return null;
    if (platform !== 'wx' && !String(account.uin || account.qq || '').trim()) return null;
    const recovery = getRecoveryState(accountId);
    if (recovery.attempts >= MAX_DAILY_RECOVERIES
      || recovery.failures >= MAX_CONSECUTIVE_FAILURES) {
      addAccountLog('auto_relogin_blocked', '自动重登次数已达上限，请检查网络或重新扫码',
        account.id, account.name, { reason, ...recovery });
      return null;
    }
    const delayMs = cfg.intervalMinutes * 60000;
    const taskName = `relogin_${String(accountId || '')}`;
    scheduler.clear(taskName);
    scheduler.setTimeoutTask(taskName, delayMs, () => {
      refreshAccountCode(accountId, reason)
        .then((ok) => {
          if (typeof onResult === 'function') onResult(ok === true);
        })
        .catch(() => null);
    });
    log('系统', `账号 ${account.name} 将在 ${cfg.intervalMinutes} 分钟后自动刷新凭证并重登`, {
      accountId: String(accountId), accountName: account.name, reason,
    });
    return { delayMs };
  }

  return {
    refreshAccountCode,
    scheduleAccount,
    rescheduleAll,
    stopAccount,
    scheduleRelogin,
  };
}

module.exports = { createAutoCodeRefreshService };
