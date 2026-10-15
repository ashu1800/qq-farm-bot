const assert = require('node:assert/strict');
const test = require('node:test');

function json(payload) {
  return { ok: true, status: 200, async text() { return JSON.stringify(payload); } };
}

test('NapCat login stays disabled unless explicitly enabled', () => {
  process.env.NAPCAT_LOGIN_ENABLED = 'false';
  delete require.cache[require.resolve('../src/services/napcat-login')];
  const service = require('../src/services/napcat-login');
  assert.equal(service.isConfigured(), false);
});

test('NapCat QR flow obtains code, keeps the QQ session, and pins auto login', async (t) => {
  Object.assign(process.env, {
    NAPCAT_LOGIN_ENABLED: 'true',
    NAPCAT_TOKEN: 'napcat-test-token',
    NAPCAT_WEBUI_URL: 'http://napcat.test/api',
    NAPCAT_OPENAUTH_URL: 'http://napcat.test/plugin',
    NAPCAT_REFRESH_POLL_MS: '10',
  });
  const originalFetch = globalThis.fetch;
  const calls = [];
  let pluginStatusChecks = 0;
  let loginStatusChecks = 0;
  let loggedOut = false;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/login')) return json({ code: 0, data: { Credential: 'credential' } });
    if (String(url).endsWith('/status')) return json({ ok: true, ready: ++pluginStatusChecks > 1 });
    if (String(url).endsWith('/QQLogin/GetQQLoginQrcode')) return json({ code: 0, data: { qrcode: 'https://example.test/qr' } });
    if (String(url).endsWith('/QQLogin/GetQQLoginInfo')) return json({ code: 0, data: { uin: '12345', nickname: '测试昵称' } });
    if (String(url).endsWith('/QQLogin/CheckLoginStatus')) {
      loginStatusChecks += 1;
      return json({ code: 0, status: 'success', data: { isLogin: !loggedOut && loginStatusChecks > 2 } });
    }
    if (String(url).endsWith('/QQLogin/RestartNapCat')) {
      loggedOut = true;
      return json({ code: 0 });
    }
    if (String(url).endsWith('/miniapp')) return json({ ok: true, operation: 'loginWithAppId', code: 'farm-code', uin: '12345', nickname: '插件昵称' });
    if (String(url).endsWith('/logout')) {
      loggedOut = true;
      return json({ ok: true, loggedOut: true });
    }
    return json({ code: 0 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  delete require.cache[require.resolve('../src/services/napcat-login')];
  const service = require('../src/services/napcat-login');
  const task = await service.create('alice');
  assert.match(task.qrImage, /^data:image\/png;base64,/);
  assert.equal(calls.some(call => call.url.endsWith('/QQLogin/RefreshQRcode')), false);
  await assert.rejects(() => service.status(task.taskId, 'bob'), /不存在或已过期/);
  assert.equal((await service.status(task.taskId, 'alice')).status, 'waiting_scan');
  assert.equal((await service.status(task.taskId, 'alice')).status, 'confirmed');
  assert.deepEqual(await service.code(task.taskId, 'alice'), { code: 'farm-code', uin: '12345', nickname: '插件昵称' });
  assert.equal(pluginStatusChecks, 2);
  assert.equal(calls.some(call => call.url.endsWith('/logout')), false);
  assert.ok(calls.some(call => call.url.endsWith('/QQLogin/SetQuickLoginQQ')));
  assert.equal(calls.some(call => call.url.endsWith('/QQLogin/RestartNapCat')), false);

  const refreshed = await service.create('alice', { refresh: true });
  assert.ok(calls.some(call => call.url.endsWith('/QQLogin/RefreshQRcode')));
  await service.cancel(refreshed.taskId, 'alice');
});

test('NapCat restarts out of a hot session before requesting a new QR code', async (t) => {
  Object.assign(process.env, {
    NAPCAT_LOGIN_ENABLED: 'true',
    NAPCAT_TOKEN: 'napcat-test-token',
    NAPCAT_WEBUI_URL: 'http://napcat-stale.test/api',
    NAPCAT_OPENAUTH_URL: 'http://napcat-stale.test/plugin',
    NAPCAT_REFRESH_POLL_MS: '10',
  });
  const originalFetch = globalThis.fetch;
  const calls = [];
  let phase = 'logged_in';
  globalThis.fetch = async (url, options) => {
    const pathname = new URL(String(url)).pathname;
    calls.push(pathname);
    if (pathname.endsWith('/auth/login')) return json({ code: 0, data: { Credential: 'credential' } });
    if (pathname.endsWith('/QQLogin/CheckLoginStatus')) {
      if (phase === 'logged_in') return json({ code: 0, data: { isLogin: true, isOffline: false } });
      if (phase === 'offline') return json({ code: 0, data: { isLogin: false, isOffline: true } });
      return json({ code: 0, data: { isLogin: false, isOffline: false } });
    }
    if (pathname.endsWith('/QQLogin/SetQuickLoginQQ')) return json({ code: 0 });
    if (pathname.endsWith('/QQLogin/RestartNapCat')) {
      phase = 'logged_out';
      return json({ code: 0 });
    }
    if (pathname.endsWith('/QQLogin/GetQQLoginQrcode')) return json({ code: 0, data: { qrcode: 'https://example.test/new-qr' } });
    return json({ code: 0 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  delete require.cache[require.resolve('../src/services/napcat-login')];
  const service = require('../src/services/napcat-login');
  const task = await service.create('alice');
  assert.match(task.qrImage, /^data:image\/png;base64,/);
  assert.ok(calls.some(pathname => pathname.endsWith('/QQLogin/SetQuickLoginQQ')));
  assert.ok(calls.some(pathname => pathname.endsWith('/QQLogin/RestartNapCat')));
  assert.equal(calls.some(pathname => pathname.endsWith('/logout')), false);
  assert.ok(calls.indexOf('/api/QQLogin/RestartNapCat') < calls.indexOf('/api/QQLogin/GetQQLoginQrcode'));
  await service.cancel(task.taskId, 'alice');
});

test('NapCat keeps an offline session ticket and fetches the QR code directly', async (t) => {
  Object.assign(process.env, {
    NAPCAT_LOGIN_ENABLED: 'true',
    NAPCAT_TOKEN: 'napcat-test-token',
    NAPCAT_WEBUI_URL: 'http://napcat-offline.test/api',
    NAPCAT_OPENAUTH_URL: 'http://napcat-offline.test/plugin',
    NAPCAT_REFRESH_POLL_MS: '10',
  });
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const pathname = new URL(String(url)).pathname;
    calls.push(pathname);
    if (pathname.endsWith('/auth/login')) return json({ code: 0, data: { Credential: 'credential' } });
    if (pathname.endsWith('/QQLogin/CheckLoginStatus')) return json({ code: 0, data: { isLogin: false, isOffline: true } });
    if (pathname.endsWith('/QQLogin/GetQQLoginQrcode')) return json({ code: 0, data: { qrcode: 'https://example.test/offline-qr' } });
    return json({ code: 0 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  delete require.cache[require.resolve('../src/services/napcat-login')];
  const service = require('../src/services/napcat-login');
  const task = await service.create('alice');
  assert.match(task.qrImage, /^data:image\/png;base64,/);
  assert.equal(calls.some(pathname => pathname.endsWith('/QQLogin/RestartNapCat')), false);
  assert.equal(calls.some(pathname => pathname.endsWith('/logout')), false);
  await service.cancel(task.taskId, 'alice');
});

const refreshEnv = {
  NAPCAT_LOGIN_ENABLED: 'true',
  NAPCAT_TOKEN: 'napcat-test-token',
  NAPCAT_WEBUI_URL: 'http://napcat-refresh.test/api',
  NAPCAT_OPENAUTH_URL: 'http://napcat-refresh.test/plugin',
  NAPCAT_REFRESH_POLL_MS: '10',
  NAPCAT_REFRESH_LOGIN_TIMEOUT_MS: '1500',
};

function refreshJson(payload) {
  return { ok: true, status: 200, async text() { return JSON.stringify(payload); } };
}

test('NapCat refresh quick-logs-in a known offline account and mints a fresh code', async (t) => {
  Object.assign(process.env, refreshEnv);
  const originalFetch = globalThis.fetch;
  const calls = [];
  let quickLoginRequested = false;
  globalThis.fetch = async (url, options) => {
    const pathname = new URL(String(url)).pathname;
    calls.push({ pathname, body: options?.body ? JSON.parse(String(options.body)) : null });
    if (pathname.endsWith('/auth/login')) return refreshJson({ code: 0, data: { Credential: 'credential' } });
    if (pathname.endsWith('/QQLogin/GetQuickLoginList')) return refreshJson({ code: 0, data: [{ uin: '12345' }, { uin: '67890' }] });
    if (pathname.endsWith('/QQLogin/SetQuickLogin')) {
      quickLoginRequested = true;
      return refreshJson({ code: 0 });
    }
    if (pathname.endsWith('/QQLogin/CheckLoginStatus')) return refreshJson({ code: 0, data: { isLogin: quickLoginRequested, isOffline: false } });
    if (pathname.endsWith('/QQLogin/GetQQLoginInfo')) return refreshJson({ code: 0, data: { uin: '12345', nickname: '快速登录' } });
    if (pathname.endsWith('/QQLogin/SetQuickLoginQQ')) return refreshJson({ code: 0 });
    if (pathname.endsWith('/status')) return refreshJson({ ok: true, ready: true });
    if (pathname.endsWith('/miniapp')) return refreshJson({ ok: true, operation: 'getOpenAuth', code: 'refreshed-code', uin: '12345', nickname: '快速登录' });
    return refreshJson({ code: 0 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  delete require.cache[require.resolve('../src/services/napcat-login')];
  const service = require('../src/services/napcat-login');
  const result = await service.refreshCodeForUin('12345');
  assert.deepEqual(result, { code: 'refreshed-code', uin: '12345', nickname: '快速登录' });
  assert.ok(quickLoginRequested);
  assert.ok(calls.some(call => call.pathname.endsWith('/QQLogin/SetQuickLoginQQ')));
  assert.equal(calls.some(call => call.pathname.endsWith('/logout')), false);
});

test('NapCat refresh restarts away a different hot account before quick login', async (t) => {
  Object.assign(process.env, refreshEnv);
  const originalFetch = globalThis.fetch;
  const calls = [];
  let hotUin = '999';
  globalThis.fetch = async (url, options) => {
    const pathname = new URL(String(url)).pathname;
    calls.push(pathname);
    if (pathname.endsWith('/auth/login')) return refreshJson({ code: 0, data: { Credential: 'credential' } });
    if (pathname.endsWith('/QQLogin/GetQuickLoginList')) return refreshJson({ code: 0, data: [{ uin: '12345' }, { uin: '999' }] });
    if (pathname.endsWith('/QQLogin/RestartNapCat')) {
      hotUin = '';
      return refreshJson({ code: 0 });
    }
    if (pathname.endsWith('/QQLogin/SetQuickLogin')) {
      hotUin = '12345';
      return refreshJson({ code: 0 });
    }
    if (pathname.endsWith('/QQLogin/CheckLoginStatus')) return refreshJson({ code: 0, data: { isLogin: Boolean(hotUin), isOffline: false } });
    if (pathname.endsWith('/QQLogin/GetQQLoginInfo')) return refreshJson({ code: 0, data: { uin: hotUin, nickname: hotUin === '12345' ? '目标' : '其他' } });
    if (pathname.endsWith('/QQLogin/SetQuickLoginQQ')) return refreshJson({ code: 0 });
    if (pathname.endsWith('/status')) return refreshJson({ ok: true, ready: true });
    if (pathname.endsWith('/miniapp')) return refreshJson({ ok: true, operation: 'getOpenAuth', code: 'switched-code', uin: '12345', nickname: '目标' });
    return refreshJson({ code: 0 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  delete require.cache[require.resolve('../src/services/napcat-login')];
  const service = require('../src/services/napcat-login');
  const result = await service.refreshCodeForUin('12345');
  assert.deepEqual(result, { code: 'switched-code', uin: '12345', nickname: '目标' });
  assert.equal(calls.some(pathname => pathname.endsWith('/logout')), false);
  const restartIndex = calls.findIndex(pathname => pathname.endsWith('/QQLogin/RestartNapCat'));
  const quickLoginIndex = calls.findIndex(pathname => pathname.endsWith('/QQLogin/SetQuickLogin'));
  assert.ok(restartIndex >= 0);
  assert.ok(restartIndex < quickLoginIndex);
});

test('NapCat refresh fails fast when the account has no persisted quick-login session', async (t) => {
  Object.assign(process.env, refreshEnv);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const pathname = new URL(String(url)).pathname;
    calls.push(pathname);
    if (pathname.endsWith('/auth/login')) return refreshJson({ code: 0, data: { Credential: 'credential' } });
    if (pathname.endsWith('/QQLogin/GetQuickLoginList')) return refreshJson({ code: 0, data: [{ uin: '67890' }] });
    return refreshJson({ code: 0 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  delete require.cache[require.resolve('../src/services/napcat-login')];
  const service = require('../src/services/napcat-login');
  await assert.rejects(() => service.refreshCodeForUin('12345'), /请重新扫码/);
  assert.equal(calls.some(pathname => pathname.endsWith('/QQLogin/SetQuickLogin')), false);
});

test('NapCat refresh is rejected while a QR scan task is in progress', async (t) => {
  Object.assign(process.env, refreshEnv);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname.endsWith('/auth/login')) return refreshJson({ code: 0, data: { Credential: 'credential' } });
    if (pathname.endsWith('/QQLogin/CheckLoginStatus')) return refreshJson({ code: 0, data: { isLogin: false, isOffline: false } });
    if (pathname.endsWith('/QQLogin/GetQQLoginQrcode')) return refreshJson({ code: 0, data: { qrcode: 'https://example.test/qr' } });
    return refreshJson({ code: 0 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  delete require.cache[require.resolve('../src/services/napcat-login')];
  const service = require('../src/services/napcat-login');
  const task = await service.create('alice');
  await assert.rejects(() => service.refreshCodeForUin('12345'), /扫码任务正在进行/);
  await service.cancel(task.taskId, 'alice');
});
