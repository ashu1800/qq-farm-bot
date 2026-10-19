const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createWorkerManager } = require('../src/runtime/worker-manager');

function createHarness(t, options = {}) {
  const proc = new EventEmitter();
  proc.send = () => {};
  proc.kill = () => {};
  const workers = {};
  const reminders = [];
  const accountLogs = [];
  const manager = createWorkerManager({
    fork: () => proc,
    runtimeMode: 'fork',
    processRef: { pkg: false, env: options.env || {}, execPath: process.execPath },
    mainEntryPath: '',
    workerScriptPath: '',
    workers,
    globalLogs: [],
    log: () => {},
    addAccountLog: (...args) => accountLogs.push(args),
    normalizeStatusForPanel: value => value,
    buildConfigSnapshotForAccount: () => ({}),
    getOfflineAutoDeleteMs: () => Infinity,
    triggerOfflineReminder: params => reminders.push(params),
    addOrUpdateAccount: () => {},
    getAccounts: () => ({ accounts: [] }),
    deleteAccount: () => {},
    ...(options.relogin ? { scheduleAutoRelogin: options.relogin } : {}),
  });
  t.after(() => manager.dispose());
  manager.startWorker({ id: 'a1', name: '测试账号', username: 'owner', code: 'code' });
  return { proc, workers, reminders, accountLogs };
}

test('WS 400 登录失效先挂起提醒，等待自动重登结果', (t) => {
  const { proc, reminders } = createHarness(t);
  proc.emit('message', { type: 'ws_error', code: 400, message: 'token expired' });

  assert.equal(reminders.length, 0);
});

test('立即刷新重登成功后不发送下线提醒', (t) => {
  const refreshes = [];
  const proc = new EventEmitter();
  proc.send = () => {};
  proc.kill = () => {};
  const reminders = [];
  const manager = createWorkerManager({
    fork: () => proc,
    runtimeMode: 'fork',
    processRef: { pkg: false, env: {}, execPath: process.execPath },
    mainEntryPath: '',
    workerScriptPath: '',
    workers: {},
    globalLogs: [],
    log: () => {},
    addAccountLog: () => {},
    normalizeStatusForPanel: value => value,
    buildConfigSnapshotForAccount: () => ({}),
    getOfflineAutoDeleteMs: () => Infinity,
    triggerOfflineReminder: params => reminders.push(params),
    addOrUpdateAccount: () => {},
    getAccounts: () => ({ accounts: [] }),
    deleteAccount: () => {},
    refreshAccountCode: async (accountId, reason) => {
      refreshes.push({ accountId, reason });
      return true;
    },
    scheduleAutoRelogin: () => ({ delayMs: 1000 }),
  });
  t.after(() => manager.dispose());
  manager.startWorker({ id: 'a1', name: '测试账号', username: 'owner', code: 'code' });

  proc.emit('message', { type: 'ws_error', code: 400, message: 'token expired' });
  assert.equal(reminders.length, 0);

  return new Promise((resolve) => {
    setImmediate(() => {
      assert.deepEqual(refreshes, [{ accountId: 'a1', reason: 'ws_400' }]);
      assert.equal(reminders.length, 0);
      resolve();
    });
  });
});

test('立即刷新失败但已安排延时重登时继续等待', (t) => {
  const proc = new EventEmitter();
  proc.send = () => {};
  proc.kill = () => {};
  const reminders = [];
  const relogins = [];
  const manager = createWorkerManager({
    fork: () => proc,
    runtimeMode: 'fork',
    processRef: { pkg: false, env: {}, execPath: process.execPath },
    mainEntryPath: '',
    workerScriptPath: '',
    workers: {},
    globalLogs: [],
    log: () => {},
    addAccountLog: () => {},
    normalizeStatusForPanel: value => value,
    buildConfigSnapshotForAccount: () => ({}),
    getOfflineAutoDeleteMs: () => Infinity,
    triggerOfflineReminder: params => reminders.push(params),
    addOrUpdateAccount: () => {},
    getAccounts: () => ({ accounts: [] }),
    deleteAccount: () => {},
    refreshAccountCode: async () => false,
    scheduleAutoRelogin: (accountId, reason, onResult) => {
      relogins.push({ accountId, reason, onResult });
      return { delayMs: 1000 };
    },
  });
  t.after(() => manager.dispose());
  manager.startWorker({ id: 'a1', name: '测试账号', username: 'owner', code: 'code' });

  proc.emit('message', { type: 'ws_error', code: 400, message: 'token expired' });

  return new Promise((resolve) => {
    setImmediate(() => {
      assert.equal(relogins.length, 1);
      assert.equal(relogins[0].reason, 'ws_400_refresh_failed');
      assert.equal(reminders.length, 0);

      relogins[0].onResult(false);
      assert.equal(reminders.length, 1);
      assert.equal(reminders[0].reason, 'ws_400:token expired');
      resolve();
    });
  });
});

test('立即刷新失败且无法安排重登时才发送下线提醒', (t) => {
  const proc = new EventEmitter();
  proc.send = () => {};
  proc.kill = () => {};
  const reminders = [];
  const manager = createWorkerManager({
    fork: () => proc,
    runtimeMode: 'fork',
    processRef: { pkg: false, env: {}, execPath: process.execPath },
    mainEntryPath: '',
    workerScriptPath: '',
    workers: {},
    globalLogs: [],
    log: () => {},
    addAccountLog: () => {},
    normalizeStatusForPanel: value => value,
    buildConfigSnapshotForAccount: () => ({}),
    getOfflineAutoDeleteMs: () => Infinity,
    triggerOfflineReminder: params => reminders.push(params),
    addOrUpdateAccount: () => {},
    getAccounts: () => ({ accounts: [] }),
    deleteAccount: () => {},
    refreshAccountCode: async () => false,
    scheduleAutoRelogin: () => null,
  });
  t.after(() => manager.dispose());
  manager.startWorker({ id: 'a1', name: '测试账号', username: 'owner', code: 'code' });

  proc.emit('message', { type: 'ws_error', code: 400, message: 'token expired' });

  return new Promise((resolve) => {
    setImmediate(() => {
      assert.equal(reminders.length, 1);
      assert.equal(reminders[0].reason, 'refresh_failed');
      resolve();
    });
  });
});

test('定时自动重登成功时先等待连接恢复', (t) => {
  let waiter = null;
  const { proc, reminders } = createHarness(t, {
    relogin: (accountId, reason, onResult) => {
      waiter = onResult;
      return { delayMs: 1000 };
    },
  });

  proc.emit('message', { type: 'account_kicked', reason: '异地登录' });
  assert.equal(reminders.length, 0);
  assert.equal(typeof waiter, 'function');

  waiter(true);
  // 拿到新 Code 后仍在等 status_sync 报告已连接
  assert.equal(reminders.length, 0);

  proc.emit('message', {
    type: 'status_sync',
    data: { connection: { connected: true } },
  });
  assert.equal(reminders.length, 0);
});

test('定时自动重登失败后才发送下线提醒', (t) => {
  let waiter = null;
  const { proc, reminders } = createHarness(t, {
    relogin: (accountId, reason, onResult) => {
      waiter = onResult;
      return { delayMs: 1000 };
    },
  });

  proc.emit('message', { type: 'account_kicked', reason: '异地登录' });
  assert.equal(reminders.length, 0);

  waiter(false);
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].username, 'owner');
  assert.equal(reminders[0].reason, 'kickout:异地登录');
});

test('自动重登被禁用时立即发送下线提醒', (t) => {
  const { proc, reminders } = createHarness(t, { relogin: () => null });

  proc.emit('message', { type: 'ws_reconnect_failed', reason: 'timeout' });

  assert.equal(reminders.length, 1);
  assert.match(reminders[0].reason, /^ws_reconnect_failed:/);
});

test('重连成功后取消挂起的下线提醒', (t) => {
  const { proc, reminders } = createHarness(t);

  proc.emit('message', {
    type: 'status_sync',
    data: { connection: { connected: false } },
  });
  proc.emit('message', { type: 'ws_error', code: 400, message: 'token expired' });
  assert.equal(reminders.length, 0);

  proc.emit('message', {
    type: 'status_sync',
    data: { connection: { connected: true } },
  });
  // 恢复后再断开也不会立刻复用旧提醒
  assert.equal(reminders.length, 0);
});

test('Worker 意外退出触发提醒，正常停止退出不触发', (t) => {
  const unexpected = createHarness(t);
  unexpected.proc.emit('exit', 1, null);
  assert.equal(unexpected.reminders.length, 1);
  assert.match(unexpected.reminders[0].reason, /^worker_exit:/);

  const normal = createHarness(t);
  normal.workers.a1.stopping = true;
  normal.proc.emit('exit', 0, null);
  assert.equal(normal.reminders.length, 0);
});

test('踢下线后 Worker 退出不会重复发送提醒', (t) => {
  const { proc, reminders } = createHarness(t, { relogin: () => ({ delayMs: 1000 }) });
  proc.emit('message', { type: 'account_kicked', reason: '异地登录' });
  proc.emit('exit', 0, null);

  // 已排期重登的账号在 Worker 正常退出后仍保留挂起，等重登结果
  assert.equal(reminders.length, 0);
});

test('被踢后未启用自动重登时立即发送一次提醒', (t) => {
  const { proc, reminders } = createHarness(t, { relogin: () => null });
  proc.emit('message', { type: 'account_kicked', reason: '异地登录' });
  proc.emit('exit', 0, null);

  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].username, 'owner');
  assert.equal(reminders[0].reason, 'kickout:异地登录');
});

test('用户手动停止账号时不发送下线提醒', (t) => {
  const proc = new EventEmitter();
  proc.send = () => {};
  proc.kill = () => {};
  const reminders = [];
  const manager = createWorkerManager({
    fork: () => proc,
    runtimeMode: 'fork',
    processRef: { pkg: false, env: {}, execPath: process.execPath },
    mainEntryPath: '',
    workerScriptPath: '',
    workers: {},
    globalLogs: [],
    log: () => {},
    addAccountLog: () => {},
    normalizeStatusForPanel: value => value,
    buildConfigSnapshotForAccount: () => ({}),
    getOfflineAutoDeleteMs: () => Infinity,
    triggerOfflineReminder: params => reminders.push(params),
    addOrUpdateAccount: () => {},
    getAccounts: () => ({ accounts: [] }),
    deleteAccount: () => {},
  });
  t.after(() => manager.dispose());
  manager.startWorker({ id: 'a1', name: '测试账号', username: 'owner', code: 'code' });

  proc.emit('message', { type: 'ws_error', code: 400, message: 'token expired' });
  manager.stopWorker('a1', { userInitiated: true });
  proc.emit('exit', 0, null);

  assert.equal(reminders.length, 0);
});
