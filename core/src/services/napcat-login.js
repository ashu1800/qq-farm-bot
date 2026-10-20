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

async function clearStaleSession() {
  try {
    const state = await webUi('/QQLogin/CheckLoginStatus');
    if (state?.isLogin === true) {
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
      if (!hasQqSession(state)) return;
    } catch {}
  }
  throw new Error('NapCat 重启后仍未确认退出登录');
}

async function release(task, cleanup = '') {
  if (task.timer) clearTimeout(task.timer);
  if (cleanup === 'restart') await resetNapcat();
  tasks.delete(task.id);
  if (activeTaskId === task.id) activeTaskId = '';
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
    if (refresh) {
      await webUi('/QQLogin/RefreshQRcode');
      await sleep(300);
    }
    let result;
    try {
      result = await webUi('/QQLogin/GetQQLoginQrcode');
    } catch (error) {
      if (/QQ Is Logined/i.test(error.message)) {
        await offlineHotSession();
      } else if (refresh) throw error;
      await webUi('/QQLogin/RefreshQRcode');
      await sleep(300);
      result = await webUi('/QQLogin/GetQQLoginQrcode');
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
  else if (/expired|timeout|过期|失效/.test(text)) task.status = 'expired';
  return taskPublic(task);
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
