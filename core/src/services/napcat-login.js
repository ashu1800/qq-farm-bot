const crypto = require('node:crypto');
const fs = require('node:fs');
const QRCode = require('qrcode');

const APP_ID = '1112386029';
const TTL_MS = Math.max(30000, Number(process.env.NAPCAT_LOGIN_TTL_MS) || 120000);
const REFRESH_LOGIN_TIMEOUT_MS = Math.max(15000, Number(process.env.NAPCAT_REFRESH_LOGIN_TIMEOUT_MS) || 60000);
const REFRESH_POLL_MS = Math.max(50, Number(process.env.NAPCAT_REFRESH_POLL_MS) || 1500);
const tasks = new Map();
let activeTaskId = '';
let webUiCredential = '';
// NapCat 同一时间只能持有一个 QQ 会话：扫码取码与自动续登都涉及会话切换，必须串行。
let sessionOpQueue = Promise.resolve();

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function withSessionLock(operation) {
  const run = sessionOpQueue.then(operation, operation);
  sessionOpQueue = run.then(() => {}, () => {});
  return run;
}

function trimUrl(value) { return String(value || '').trim().replace(/\/+$/, ''); }
function authToken() {
  const tokenFile = process.env.NAPCAT_TOKEN_FILE || '/app/napcat-auth/token';
  try { return fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return String(process.env.NAPCAT_TOKEN || '').trim(); }
}
function config() {
  const token = authToken();
  return {
    webui: trimUrl(process.env.NAPCAT_WEBUI_URL || 'http://napcat:6099/api'),
    webuiToken: token,
    plugin: trimUrl(process.env.NAPCAT_OPENAUTH_URL || 'http://napcat:6099/plugin/qq-miniapp-openauth/api'),
    pluginToken: token,
  };
}

function isConfigured() {
  const cfg = config();
  return /^(?:1|true|yes|on)$/i.test(String(process.env.NAPCAT_LOGIN_ENABLED || ''))
    && Boolean(cfg.webui && cfg.webuiToken && cfg.plugin && cfg.pluginToken);
}

async function requestJson(url, { method = 'POST', body, token = '', timeout = 15000 } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new Error(`无法连接 NapCat: ${error.message}`);
  }
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok) throw new Error(payload.error || payload.message || `NapCat HTTP ${response.status}`);
  return payload;
}

function normalize(value) {
  if (!value || typeof value !== 'object') return value;
  return { ...value, ...(value.data || {}), ...(value.result || {}), ...(value.data?.result || {}) };
}

async function webUiRequest(action, body = {}) {
  const cfg = config();
  if (!webUiCredential) {
    const hash = crypto.createHash('sha256').update(`${cfg.webuiToken}.napcat`).digest('hex');
    const login = await requestJson(`${cfg.webui}/auth/login`, { body: { hash } });
    webUiCredential = login?.data?.Credential || '';
    if (!webUiCredential) throw new Error('NapCat WebUI 登录失败，请检查 Token 或关闭 2FA');
  }
  try {
    const payload = await requestJson(`${cfg.webui}${action}`, { body, token: webUiCredential });
    if (payload.code !== undefined && Number(payload.code) !== 0) throw new Error(payload.message || 'NapCat WebUI 请求失败');
    return payload;
  } catch (error) {
    if (/unauthorized|credential|凭证|认证/i.test(error.message)) webUiCredential = '';
    throw error;
  }
}

async function webUi(action, body = {}) {
  return normalize(await webUiRequest(action, body));
}

function taskPublic(task) {
  return { taskId: task.id, status: task.status, qrImage: task.qrImage || '', expiresAt: task.expiresAt, error: task.error || '' };
}
function profile(value) {
  const user = normalize(value) || {};
  return {
    uin: String(user.uin || user.user_id || user.qq || '').trim(),
    nickname: String(user.nickname || user.nick || user.name || '').trim(),
  };
}
function ownedTask(id, owner) {
  const task = tasks.get(String(id || ''));
  if (!task || task.owner !== owner) throw new Error('登录任务不存在或已过期');
  return task;
}

function hasQqSession(state) {
  return state?.isLogin === true || state?.isOffline === true;
}

// 非破坏性下线：完整注销会清空快速登录票据，导致该 QQ 之后无法静默续登；
// 改为清除自动登录账号并重启 NapCat，会话票据保留在磁盘上。
async function offlineHotSession() {
  await webUi('/QQLogin/SetQuickLoginQQ', { uin: '' }).catch(() => {});
  await webUi('/QQLogin/RestartNapCat');
  const deadline = Date.now() + REFRESH_LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(REFRESH_POLL_MS);
    try {
      const state = await webUi('/QQLogin/CheckLoginStatus');
      if (state?.isLogin !== true) return; // 已回到登录界面；isOffline 代表票据仍在，属预期
    } catch {}
  }
  throw new Error('NapCat 重启后仍未回到登录界面');
}

// QQ 内核冷启动期间 CheckLoginStatus 会先返回 isLogin/isOffline 都为 false，
// 此时 GetQQLoginQrcode 拿到的是半初始化上下文里的码，扫上去一律提示已失效。
// 必须等到 NapCat 真正能给出稳定二维码再取码，否则每次续扫都要重来一遍。
const QR_READY_TIMEOUT_MS = Math.max(5000, Number(process.env.NAPCAT_QR_READY_TIMEOUT_MS) || 45000);
const QR_READY_SETTLE_MS = Math.max(0, Number(process.env.NAPCAT_QR_READY_SETTLE_MS) || 300);
// 前端 1.5 秒轮询一次 status；换码最小间隔用于避免会话冲突时反复重启 NapCat。
const RENEW_MIN_INTERVAL_MS = Math.max(2000, Number(process.env.NAPCAT_RENEW_MIN_INTERVAL_MS) || 10000);

function qrUrlOf(state) {
  return String(state?.qrcodeurl || state?.qrcodeUrl || state?.qrcode_url || '').trim();
}

// 只有 NapCat 已经准备好二维码（或本地已有 QQ 会话）时才允许取码。
// 连续两次拿到同一个非空 qrcodeurl 才认为服务稳定，避免刚重启时拿到瞬时值。
// 若 NapCat 版本根本不返回 qrcodeurl，则降级为短暂等待后放行，不能把用户卡死。
const QR_READY_FALLBACK_CHECKS = 5;

// NapCat 只承载一个 QQ 会话。若它仍占着某个账号，新二维码会被 QQ 服务端立刻判废
// （实测 loginError: 当前账号(...)已登录,无法重复登录）。必须显式识别这类冲突。
function hasConflictSession(state) {
  const text = String(state?.loginError || '');
  return /已登录|重复登录|already\s*(?:logged|login)|logged\s*in/i.test(text);
}

async function waitQrReady() {
  const deadline = Date.now() + QR_READY_TIMEOUT_MS;
  let lastUrl = '';
  let lastChangeAt = 0;
  let lastError = '';
  let emptyChecks = 0;
  while (Date.now() < deadline) {
    try {
      const state = await webUi('/QQLogin/CheckLoginStatus');
      // 账号仍被占用时 NapCat 返回的是过期缓存码，不能当作就绪。
      if (hasConflictSession(state)) {
        lastError = state.loginError;
        await sleep(REFRESH_POLL_MS);
        continue;
      }
      // 已有会话：不是给新账号扫码的场景，无需等待二维码就绪。
      if (hasQqSession(state)) return state;
      const url = qrUrlOf(state);
      if (url) {
        const now = Date.now();
        if (url === lastUrl && now - lastChangeAt >= QR_READY_SETTLE_MS) {
          await sleep(QR_READY_SETTLE_MS);
          return state;
        }
        if (url !== lastUrl) {
          lastUrl = url;
          lastChangeAt = now;
        }
        emptyChecks = 0;
      } else {
        emptyChecks += 1;
        // 该 NapCat 版本不提供 qrcodeurl：短暂等待后按旧行为放行。
        if (emptyChecks >= QR_READY_FALLBACK_CHECKS) {
          await sleep(QR_READY_SETTLE_MS);
          return state;
        }
      }
    } catch (error) {
      // NapCat 正在重启时 WebUI 可能短暂不可用，继续重试而不是直接失败。
      lastError = error.message || '';
    }
    await sleep(REFRESH_POLL_MS);
  }
  throw new Error(`NapCat 未能在 ${Math.round(QR_READY_TIMEOUT_MS / 1000)} 秒内提供可扫码的二维码${lastError ? `: ${lastError}` : ''}，请稍后重试`);
}

// 二维码被 QQ 服务端判失效时 NapCat 会在状态里带上 expired/超时类文案。
// 注意：qrcodeurl 为空只代表"还没生成码"，不能据此判定失效，否则换码流程会死等。
function qrNeedsReissue(state) {
  if (!state || typeof state !== 'object') return false;
  if (hasConflictSession(state)) return true;
  const text = `${state.status || ''} ${state.message || ''} ${state.loginError || ''}`.toLowerCase();
  return /expired|expire|timeout|invalid|过期|失效|超时/.test(text);
}

async function clearStaleSession() {
  try {
    const state = await webUi('/QQLogin/CheckLoginStatus');
    // 账号被占用的表现可能是 isLogin=false 但 loginError 明确说已登录，
    // 只判断 isLogin 会漏掉这种冲突，随后取到的码必然被判废。
    if (state?.isLogin === true || hasConflictSession(state)) {
      await offlineHotSession();
    }
    // isOffline=true 表示已在登录界面且会话票据保留，直接取码即可
  } catch (error) {
    if (!/QQ Is Logined/i.test(error.message)) return;
    await offlineHotSession();
  }
}

async function resetNapcat() {
  await webUi('/QQLogin/RestartNapCat');
  for (let i = 0; i < 24; i += 1) {
    await new Promise(resolve => setTimeout(resolve, i ? 250 : 1000));
    try {
      const state = await webUi('/QQLogin/CheckLoginStatus');
      // 仅有 isLogin/isOffline 都为 false 并不代表就绪：QQ 内核刚被杀掉时也是这个状态。
      // 必须等到 NapCat 重新给出二维码（或已有会话）才算重启完成，否则下一个账号会拿到死码。
      if (hasQqSession(state) || qrUrlOf(state)) return;
    } catch {}
  }
  throw new Error('NapCat 重启后仍未确认退出登录');
}

async function release(task, cleanup = '') {
  if (task.timer) clearTimeout(task.timer);
  try {
    if (cleanup === 'restart') await resetNapcat();
  } finally {
    // 清理失败也必须释放任务，否则前端会一直拿着一个已经无效的 taskId 轮询。
    tasks.delete(task.id);
    if (activeTaskId === task.id) activeTaskId = '';
  }
}

async function currentLoginProfile() {
  try {
    const state = await webUi('/QQLogin/CheckLoginStatus');
    if (state?.isLogin !== true) return null;
    const user = profile(await webUi('/QQLogin/GetQQLoginInfo'));
    return user.uin ? user : null;
  } catch {
    return null;
  }
}

async function quickLoginUins() {
  try {
    const payload = await webUiRequest('/QQLogin/GetQuickLoginList');
    const raw = payload?.data ?? payload?.result ?? payload;
    const items = Array.isArray(raw) ? raw : [];
    return items.map(item => String(item?.uin ?? item ?? '').trim()).filter(Boolean);
  } catch {
    return null;
  }
}

async function waitPluginReady() {
  const cfg = config();
  for (let i = 0; i < 40; i += 1) {
    try {
      const health = await requestJson(`${cfg.plugin}/status`, { method: 'GET', token: cfg.pluginToken, timeout: 5000 });
      if (health.ok === true && health.ready === true) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function mintFarmCode(fallbackUin = '') {
  const cfg = config();
  if (!(await waitPluginReady())) throw new Error('QQ 已确认登录，但 NapCat 上下文尚未就绪，请稍后重试');
  const result = await requestJson(`${cfg.plugin}/miniapp`, { body: { appId: APP_ID, interactive: true }, token: cfg.pluginToken, timeout: TTL_MS });
  const authCode = String(result.code || (result.operation === 'loginWithAppId' ? result.result : '') || '').trim();
  if (!result.ok || !authCode) throw new Error(result.error || 'NapCat 未返回小程序授权 Code');
  return {
    code: authCode,
    uin: String(result.uin || fallbackUin || '').trim(),
    nickname: String(result.nickname || '').trim(),
  };
}

// 取一张确定是新的二维码。
// NapCat 在账号被占用或内核未就绪时会反复返回同一张陈旧码，用户扫上去一律提示失效。
// 因此显式 RefreshQRcode，并要求刷新前后的 qrcodeurl 不同；不变则继续重试。
async function fetchFreshQr({ keepExisting = false, attempts = 3 } = {}) {
  const readRaw = (result) => result.qrcode || result.qrCode || result.qrUrl || result.qr_url || result.image || result.base64;
  if (keepExisting) {
    // 已有 QQ 会话时不存在“陈旧二维码”问题，直接取当前码。
    const result = await webUi('/QQLogin/GetQQLoginQrcode');
    if (!readRaw(result)) throw new Error('NapCat 未返回登录二维码');
    return result;
  }
  let before = qrUrlOf(await webUi('/QQLogin/CheckLoginStatus').catch(() => null));
  let lastResult = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await webUi('/QQLogin/RefreshQRcode');
    await sleep(300);
    lastResult = await webUi('/QQLogin/GetQQLoginQrcode');
    if (!readRaw(lastResult)) throw new Error('NapCat 未返回登录二维码');
    const after = qrUrlOf(await webUi('/QQLogin/CheckLoginStatus').catch(() => null));
    // 拿不到 qrcodeurl（该版本不提供）时无法比较，直接接受取到的码。
    if (!before || !after) return lastResult;
    if (after !== before) return lastResult;
    // 码没变：说明 NapCat 仍在复用旧码，记录并重试。
    before = after;
    await sleep(REFRESH_POLL_MS);
  }
  // 多次刷新仍拿到同一张码：交给调用方判定，不在此处静默成功。
  const reason = 'NapCat 持续返回同一张二维码，可能仍处于旧会话中';
  if (lastResult) {
    lastResult.qrStale = true;
    lastResult.qrStaleReason = reason;
  }
  return lastResult;
}

async function create(owner, { refresh = false } = {}) {
  if (!isConfigured()) throw new Error('NapCat 扫码登录未配置');
  const current = tasks.get(activeTaskId);
  if (current && current.status === 'done') {
    await release(current).catch(() => {});
  } else if (current && current.expiresAt > Date.now()) {
    if (current.owner !== owner) throw new Error('已有 QQ 扫码任务正在进行，请稍后再试');
    if (current.status === 'cleaning') throw new Error('上一账号正在清理 QQ 会话，请稍候');
    if (current.status === 'cleanup_failed') await release(current, 'restart');
    else if (refresh) {
      // 主动刷新必须换一张新码：复用旧任务会让用户扫到已经确认过的二维码。
      await release(current).catch(() => {});
    } else return taskPublic(current);
  } else if (current) {
    await release(current).catch(() => {});
  }
  let qrImage = '';
  await withSessionLock(async () => {
    await clearStaleSession();
    // 关键：QQ 内核冷启动期间拿到的码不可扫，必须等 NapCat 稳定后再取。
    // 第二个、第三个账号连着扫时 NapCat 刚被 RestartNapCat 重启过，正是这个窗口。
    const readyState = await waitQrReady();
    // 已有 QQ 会话时 NapCat 不给新码，直接取当前码；否则必须刷新出一张新码。
    let result = await fetchFreshQr({ keepExisting: hasQqSession(readyState) });
    if (result.qrStale) {
      // 刷新多次仍是同一张码，通常是旧会话没让出来：清掉会话后重取一次。
      await offlineHotSession();
      await waitQrReady();
      result = await fetchFreshQr();
      if (result.qrStale) throw new Error(result.qrStaleReason || 'NapCat 未能生成新的登录二维码');
    }
    // 取到码后再看一次状态：NapCat 若已判定这张码失效或存在账号占用，换一张再交给用户。
    const state = await webUi('/QQLogin/CheckLoginStatus').catch(() => null);
    if (state && hasConflictSession(state)) {
      await offlineHotSession();
      await waitQrReady();
      result = await fetchFreshQr();
      if (result.qrStale) throw new Error(result.qrStaleReason || 'NapCat 未能生成新的登录二维码');
    }
    const raw = result.qrcode || result.qrCode || result.qrUrl || result.qr_url || result.image || result.base64;
    if (!raw) throw new Error('NapCat 未返回登录二维码');
    qrImage = /^data:image\//i.test(raw) ? raw : (/^[a-z0-9+/]+={0,2}$/i.test(raw) && raw.length > 128 ? `data:image/png;base64,${raw}` : await QRCode.toDataURL(raw, { width: 280, margin: 1 }));
  });
  const task = { id: crypto.randomBytes(18).toString('hex'), owner, status: 'waiting_scan', qrImage, expiresAt: Date.now() + TTL_MS };
  task.timer = setTimeout(() => { void release(task).catch(() => {}); }, TTL_MS + 10);
  task.timer.unref?.();
  tasks.set(task.id, task);
  activeTaskId = task.id;
  return taskPublic(task);
}

async function status(id, owner) {
  const task = ownedTask(id, owner);
  if (task.result) return taskPublic(task);
  if (task.expiresAt <= Date.now()) { await release(task).catch(() => {}); throw new Error('登录任务已过期'); }
  const state = await webUi('/QQLogin/CheckLoginStatus');
  const text = `${state.status || ''} ${state.message || ''}`.toLowerCase();
  if (state.isLogin === true) {
    try {
      const user = profile(await webUi('/QQLogin/GetQQLoginInfo'));
      if (user.uin) {
        task.user = user;
        task.status = 'confirmed';
      }
    } catch {}
  } else if (/scanned|待确认|等待确认/.test(text)) task.status = 'scanned';
  else if (qrNeedsReissue(state)) {
    // QQ 服务端判码失效时直接原地换一张，而不是把“已过期”丢给用户重来。
    // 换码失败不应让轮询整体失败：保留当前任务，下次轮询再试。
    await reissueQr(task).catch(error => { task.error = error.message; });
  }
  return taskPublic(task);
}

// 同一任务内换码：保持 taskId 不变，前端轮询无需重建任务。
// 前端 1.5 秒轮询一次，必须节流，否则一次会话冲突会触发重启风暴。
async function reissueQr(task) {
  const now = Date.now();
  if (task.reissuePromise) return task.reissuePromise;
  if (task.lastReissueAt && now - task.lastReissueAt < RENEW_MIN_INTERVAL_MS) return;
  task.lastReissueAt = now;
  task.reissuePromise = withSessionLock(async () => {
    await waitQrReady();
    const result = await fetchFreshQr();
    if (result.qrStale) {
      await offlineHotSession();
      await waitQrReady();
      const retry = await fetchFreshQr();
      if (retry.qrStale) throw new Error(retry.qrStaleReason || 'NapCat 未能生成新的登录二维码');
      Object.assign(result, retry);
    }
    const raw = result.qrcode || result.qrCode || result.qrUrl || result.qr_url || result.image || result.base64;
    if (!raw) throw new Error('NapCat 未返回登录二维码');
    task.qrImage = /^data:image\//i.test(raw) ? raw : (/^[a-z0-9+/]+={0,2}$/i.test(raw) && raw.length > 128 ? `data:image/png;base64,${raw}` : await QRCode.toDataURL(raw, { width: 280, margin: 1 }));
    task.status = 'waiting_scan';
    task.expiresAt = Date.now() + TTL_MS;
    if (task.timer) clearTimeout(task.timer);
    task.timer = setTimeout(() => { void release(task).catch(() => {}); }, TTL_MS + 10);
    task.timer.unref?.();
  }).finally(() => { task.reissuePromise = null; });
  return task.reissuePromise;
}

async function code(id, owner) {
  const task = ownedTask(id, owner);
  if (task.result) return task.result;
  if (task.status !== 'confirmed') throw new Error('请先完成 QQ 扫码确认');
  if (!task.codePromise) {
    task.codePromise = (async () => {
      const minted = await mintFarmCode(String(task.user?.uin || ''));
      const identity = {
        uin: minted.uin || String(task.user?.uin || ''),
        nickname: minted.nickname || String(task.user?.nickname || ''),
      };
      task.result = { code: minted.code, ...identity };
      task.status = 'done';
      if (task.timer) clearTimeout(task.timer);
      // 保留 QQ 会话供 Code 失效后自动续登，并固定 NapCat 重启后的快速登录账号。
      await webUi('/QQLogin/SetQuickLoginQQ', { uin: identity.uin }).catch(() => {});
      task.timer = setTimeout(() => { void release(task).catch(() => {}); }, TTL_MS);
      task.timer.unref?.();
      return task.result;
    })().catch(error => { task.error = error.message; task.codePromise = null; throw error; });
  }
  return task.codePromise;
}

async function cancel(id, owner) {
  const task = tasks.get(String(id || ''));
  if (!task) return;
  if (task.owner !== owner) throw new Error('无权取消此登录任务');
  // done 任务的 QQ 会话仍然是热的：不让出来，下一个账号就得先经历
  // RestartNapCat + 被踢下线的窗口，期间扫到的码一律提示已失效。
  await release(task, task.status === 'done' ? 'restart' : task.status === 'scanned' ? 'restart' : '');
}

// Code 失效后的静默续登：利用 NapCat 中保留的 QQ 会话快速登录并重新铸取 Code，无需重新扫码。
async function refreshCodeForUin(uin) {
  if (!isConfigured()) throw new Error('NapCat 扫码登录未配置');
  const target = String(uin || '').trim();
  if (!/^\d{5,12}$/.test(target)) throw new Error('账号缺少有效的 QQ 号，无法自动续登');
  return withSessionLock(async () => {
    const live = tasks.get(activeTaskId);
    if (live && live.status !== 'done') throw new Error('QQ 扫码任务正在进行，稍后自动重试');
    let current = await currentLoginProfile();
    if (current && current.uin !== target) {
      await offlineHotSession();
      current = null;
    }
    if (!current) {
      const known = await quickLoginUins();
      if (known && known.length > 0 && !known.includes(target)) {
        throw new Error(`QQ ${target} 没有可用的快速登录会话，请重新扫码`);
      }
      await webUi('/QQLogin/SetQuickLogin', { uin: target });
      const deadline = Date.now() + REFRESH_LOGIN_TIMEOUT_MS;
      while (!current && Date.now() < deadline) {
        await sleep(REFRESH_POLL_MS);
        current = await currentLoginProfile();
        if (current && current.uin !== target) current = null;
      }
      if (!current) throw new Error('QQ 快速登录未完成，请重新扫码');
    }
    await webUi('/QQLogin/SetQuickLoginQQ', { uin: target }).catch(() => {});
    return await mintFarmCode(target);
  });
}

module.exports = { APP_ID, isConfigured, create, status, code, cancel, refreshCodeForUin };
