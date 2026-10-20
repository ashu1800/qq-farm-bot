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
  let scanned = false;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/login')) return json({ code: 0, data: { Credential: 'credential' } });
    if (String(url).endsWith('/status')) return json({ ok: true, ready: ++pluginStatusChecks > 1 });
    if (String(url).endsWith('/QQLogin/GetQQLoginQrcode')) return json({ code: 0, data: { qrcode: 'https://example.test/qr' } });
    if (String(url).endsWith('/QQLogin/GetQQLoginInfo')) return json({ code: 0, data: { uin: '12345', nickname: '测试昵称' } });
    if (String(url).endsWith('/QQLogin/CheckLoginStatus')) {
      // 扫码确认是外部事件，由测试显式翻转，不能由查询次数推导。
      return json({ code: 0, status: 'success', data: { isLogin: scanned, isOffline: false, qrcodeurl: 'https://example.test/qr' } });
    }
    if (String(url).endsWith('/QQLogin/RestartNapCat')) {
      scanned = false;
      return json({ code: 0 });
    }
    if (String(url).endsWith('/miniapp')) return json({ ok: true, operation: 'loginWithAppId', code: 'farm-code', uin: '12345', nickname: '插件昵称' });
    if (String(url).endsWith('/logout')) {
      scanned = false;
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
  scanned = true;
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
  globalThis.fetch = async (url) => {
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
  globalThis.fetch = async (url) => {
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

// 复现用户反馈：第一次扫码成功后，再点刷新拿第二个账号的二维码，
// 前端会立刻收到「登录任务已过期」。
//
// 根因一：create() 在已有未过期任务时无条件复用它，忽略 refresh 参数。
//   前端点二维码图片刷新时先 cancel 当前任务再 create(refresh:true)，
//   但 cancel 之后 activeTaskId 已被清空，于是走正常分支——这条路是通的；
//   真正失效的是 auto-refresh 那条路：任务还在，refresh 被静默丢弃，
//   用户以为换了新码，扫的其实还是那张已经确认过的旧码。
// 根因二：cancel() 对 done 状态的任务只从 map 删除、不重启 NapCat，
//   而 done 任务的 QQ 会话仍热着；下一次 create() 走 clearStaleSession，
//   需要 RestartNapCat + 轮询等待，期间会被踢下线并产生一段不可扫码的窗口。
test('create(refresh:true) replaces an in-flight task instead of silently reusing it', async (t) => {
  Object.assign(process.env, {
    NAPCAT_LOGIN_ENABLED: 'true',
    NAPCAT_TOKEN: 'napcat-test-token',
    NAPCAT_WEBUI_URL: 'http://napcat-refresh-reuse.test/api',
    NAPCAT_OPENAUTH_URL: 'http://napcat-refresh-reuse.test/plugin',
    NAPCAT_REFRESH_POLL_MS: '10',
  });
  const originalFetch = globalThis.fetch;
  const calls = [];
  let qrSeq = 0;
  globalThis.fetch = async (url) => {
    const pathname = new URL(String(url)).pathname;
    calls.push(pathname);
    if (pathname.endsWith('/auth/login')) return json({ code: 0, data: { Credential: 'credential' } });
    if (pathname.endsWith('/QQLogin/CheckLoginStatus')) return json({ code: 0, data: { isLogin: false, isOffline: false } });
    if (pathname.endsWith('/QQLogin/RefreshQRcode')) return json({ code: 0, data: null });
    if (pathname.endsWith('/QQLogin/GetQQLoginQrcode')) {
      qrSeq += 1;
      return json({ code: 0, data: { qrcode: `https://example.test/qr-${qrSeq}` } });
    }
    return json({ code: 0 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  delete require.cache[require.resolve('../src/services/napcat-login')];
  const service = require('../src/services/napcat-login');
  const first = await service.create('alice');

  const refreshed = await service.create('alice', { refresh: true });
  // 必须拿到新任务、新二维码；复用旧任务会让用户扫到已确认过的码。
  assert.notEqual(refreshed.taskId, first.taskId);
  assert.notEqual(refreshed.qrImage, first.qrImage);
  assert.ok(calls.includes('/api/QQLogin/RefreshQRcode'));
  // 旧任务应立刻失效，避免前端拿旧 id 继续轮询。
  await assert.rejects(() => service.status(first.taskId, 'alice'), /不存在或已过期/);
  assert.equal((await service.status(refreshed.taskId, 'alice')).status, 'waiting_scan');
  await service.cancel(refreshed.taskId, 'alice');
});

// 关掉已扫码成功的任务后，下一次取码必须能直接扫码，
// 不能因为上一个账号还热着而返回一段「不可扫」的窗口期。
test('cancel of a finished task releases the hot QQ session for the next scan', async (t) => {
  Object.assign(process.env, {
    NAPCAT_LOGIN_ENABLED: 'true',
    NAPCAT_TOKEN: 'napcat-test-token',
    NAPCAT_WEBUI_URL: 'http://napcat-finished.test/api',
    NAPCAT_OPENAUTH_URL: 'http://napcat-finished.test/plugin',
    NAPCAT_REFRESH_POLL_MS: '10',
  });
  const originalFetch = globalThis.fetch;
  const calls = [];
  let hot = false;
  let statusCalls = 0;
  globalThis.fetch = async (url) => {
    const pathname = new URL(String(url)).pathname;
    calls.push(pathname);
    if (pathname.endsWith('/auth/login')) return json({ code: 0, data: { Credential: 'credential' } });
    if (pathname.endsWith('/QQLogin/CheckLoginStatus')) {
      statusCalls += 1;
      // create() 里的 clearStaleSession 也会查一次；之后视为用户已在手机上确认。
      if (statusCalls > 1) hot = true;
      // 未登录时必须带 qrcodeurl，贴近真实 NapCat：重启后它一定会重建二维码，
      // 这也是 resetNapcat 判定"内核已就绪"的依据。
      return json({ code: 0, data: { isLogin: hot, isOffline: false, ...(hot ? {} : { qrcodeurl: 'https://example.test/qr' }) } });
    }
    if (pathname.endsWith('/QQLogin/GetQQLoginInfo')) return json({ code: 0, data: { uin: '12345', nickname: '一号' } });
    if (pathname.endsWith('/QQLogin/GetQQLoginQrcode')) return json({ code: 0, data: { qrcode: 'https://example.test/qr' } });
    if (pathname.endsWith('/QQLogin/RestartNapCat')) { hot = false; statusCalls = 0; return json({ code: 0 }); }
    if (pathname.endsWith('/status')) return json({ ok: true, ready: true });
    if (pathname.endsWith('/miniapp')) { hot = true; return json({ ok: true, operation: 'loginWithAppId', code: 'code-1', uin: '12345', nickname: '一号' }); }
    return json({ code: 0 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  delete require.cache[require.resolve('../src/services/napcat-login')];
  const service = require('../src/services/napcat-login');
  const task = await service.create('alice');
  // 轮询到 NapCat 报告 isLogin 为止（前几次仍可能是未登录）。
  let state = '';
  for (let index = 0; index < 3 && state !== 'confirmed'; index += 1) {
    state = (await service.status(task.taskId, 'alice')).status;
  }
  assert.equal(state, 'confirmed');
  await service.code(task.taskId, 'alice');
  assert.equal(hot, true);

  // 用户关掉弹窗/换账号：done 任务的 QQ 会话必须被让出来。
  await service.cancel(task.taskId, 'alice');
  assert.equal(hot, false);
  assert.ok(calls.some(pathname => pathname.endsWith('/QQLogin/RestartNapCat')));
});

// 复现第三个账号扫码总是提示二维码过期：
// QQ 内核刚被 RestartNapCat 重启时，CheckLoginStatus 会先返回 isLogin/isOffline 都为 false
// 且 qrcodeurl 为空。旧实现此时直接 GetQQLoginQrcode，拿到的是半初始化上下文的码，
// 用户扫上去一律提示已失效，2 分钟 TTL 到期后又重复一遍。
test('create() waits for a stable QR before handing it to the user', async (t) => {
  Object.assign(process.env, {
    NAPCAT_LOGIN_ENABLED: 'true',
    NAPCAT_TOKEN: 'napcat-test-token',
    NAPCAT_WEBUI_URL: 'http://napcat-cold.test/api',
    NAPCAT_OPENAUTH_URL: 'http://napcat-cold.test/plugin',
    NAPCAT_REFRESH_POLL_MS: '10',
    NAPCAT_QR_READY_SETTLE_MS: '20',
  });
  const originalFetch = globalThis.fetch;
  const calls = [];
  let statusChecks = 0;
  // 冷启动：前 3 次状态查询拿不到 qrcodeurl，之后稳定给出同一张码。
  globalThis.fetch = async (url) => {
    const pathname = new URL(String(url)).pathname;
    calls.push(pathname);
    if (pathname.endsWith('/auth/login')) return json({ code: 0, data: { Credential: 'credential' } });
    if (pathname.endsWith('/QQLogin/CheckLoginStatus')) {
      statusChecks += 1;
      if (statusChecks <= 3) return json({ code: 0, data: { isLogin: false, isOffline: false, qrcodeurl: '' } });
      return json({ code: 0, data: { isLogin: false, isOffline: false, qrcodeurl: 'https://example.test/stable-qr' } });
    }
    if (pathname.endsWith('/QQLogin/GetQQLoginQrcode')) return json({ code: 0, data: { qrcode: 'https://example.test/stable-qr' } });
    return json({ code: 0 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  delete require.cache[require.resolve('../src/services/napcat-login')];
  const service = require('../src/services/napcat-login');
  const task = await service.create('alice');
  assert.match(task.qrImage, /^data:image\/png;base64,/);
  // 必须先经历冷启动等待，才允许真正取码。
  assert.ok(statusChecks > 3, `expected to wait past the cold-start window, got ${statusChecks} checks`);
  await service.cancel(task.taskId, 'alice');
});

test('create() reissues when NapCat reports the obtained QR as already expired', async (t) => {
  Object.assign(process.env, {
    NAPCAT_LOGIN_ENABLED: 'true',
    NAPCAT_TOKEN: 'napcat-test-token',
    NAPCAT_WEBUI_URL: 'http://napcat-expired.test/api',
    NAPCAT_OPENAUTH_URL: 'http://napcat-expired.test/plugin',
    NAPCAT_REFRESH_POLL_MS: '10',
    NAPCAT_QR_READY_SETTLE_MS: '20',
  });
  const originalFetch = globalThis.fetch;
  const calls = [];
  let statusChecks = 0;
  let qrSeq = 0;
  globalThis.fetch = async (url) => {
    const pathname = new URL(String(url)).pathname;
    calls.push(pathname);
    if (pathname.endsWith('/auth/login')) return json({ code: 0, data: { Credential: 'credential' } });
    if (pathname.endsWith('/QQLogin/CheckLoginStatus')) {
      statusChecks += 1;
      // 取码后第一次状态查询报告码已失效，迫使服务端换码。
      if (statusChecks === 4) return json({ code: 0, data: { isLogin: false, isOffline: false, qrcodeurl: '', loginError: '二维码已过期' } });
      return json({ code: 0, data: { isLogin: false, isOffline: false, qrcodeurl: 'https://example.test/junk' } });
    }
    if (pathname.endsWith('/QQLogin/RefreshQRcode')) return json({ code: 0, data: null });
    if (pathname.endsWith('/QQLogin/GetQQLoginQrcode')) {
      qrSeq += 1;
      return json({ code: 0, data: { qrcode: `https://example.test/qr-${qrSeq}` } });
    }
    return json({ code: 0 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  delete require.cache[require.resolve('../src/services/napcat-login')];
  const service = require('../src/services/napcat-login');
  const task = await service.create('alice');
  // 不能把死码交给用户：必须换过码，最终拿到的是第二张。
  assert.ok(calls.includes('/api/QQLogin/RefreshQRcode'));
  assert.equal(qrSeq, 2);
  await service.cancel(task.taskId, 'alice');
});

test('status() reissues an expired QR in place instead of failing the task', async (t) => {
  Object.assign(process.env, {
    NAPCAT_LOGIN_ENABLED: 'true',
    NAPCAT_TOKEN: 'napcat-test-token',
    NAPCAT_WEBUI_URL: 'http://napcat-status-expired.test/api',
    NAPCAT_OPENAUTH_URL: 'http://napcat-status-expired.test/plugin',
    NAPCAT_REFRESH_POLL_MS: '10',
    NAPCAT_QR_READY_SETTLE_MS: '20',
  });
  const originalFetch = globalThis.fetch;
  let expired = false;
  let qrSeq = 0;
  globalThis.fetch = async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname.endsWith('/auth/login')) return json({ code: 0, data: { Credential: 'credential' } });
    if (pathname.endsWith('/QQLogin/CheckLoginStatus')) {
      if (expired) return json({ code: 0, data: { isLogin: false, isOffline: false, qrcodeurl: '', loginError: '二维码已过期' } });
      return json({ code: 0, data: { isLogin: false, isOffline: false, qrcodeurl: `https://example.test/live-${qrSeq}` } });
    }
    if (pathname.endsWith('/QQLogin/RefreshQRcode')) { expired = false; return json({ code: 0, data: null }); }
    if (pathname.endsWith('/QQLogin/GetQQLoginQrcode')) {
      qrSeq += 1;
      return json({ code: 0, data: { qrcode: `https://example.test/status-qr-${qrSeq}` } });
    }
    return json({ code: 0 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  delete require.cache[require.resolve('../src/services/napcat-login')];
  const service = require('../src/services/napcat-login');
  const task = await service.create('alice');
  const firstImage = task.qrImage;

  // 用户拿着手机还没扫，QQ 服务端先把码判失效了。
  expired = true;
  const next = await service.status(task.taskId, 'alice');
  // 任务不能被判死；必须原地换码并让前端看到新图。
  assert.equal(next.status, 'waiting_scan');
  assert.notEqual(next.qrImage, firstImage);
  assert.equal(next.taskId, task.taskId);
  await service.cancel(task.taskId, 'alice');
});
