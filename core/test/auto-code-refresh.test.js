const test = require('node:test');
const assert = require('node:assert/strict');

const { createAutoCodeRefreshService } = require('../src/runtime/auto-code-refresh');

function createService(account, logs) {
  return createAutoCodeRefreshService({
    store: {
      getAutoCodeRefresh: () => ({ enabled: false, intervalMinutes: 60 }),
    },
    getAccounts: () => ({ accounts: [account] }),
    addOrUpdateAccount: () => {},
    resolveWorkerControls: () => ({}),
    log: (...args) => logs.push(args),
    addAccountLog: () => {},
  });
}

test('QQ accounts do not emit a missing wxid warning during Code refresh scheduling', () => {
  const logs = [];
  const service = createService({ id: 'qq-1', name: 'QQ account', platform: 'qq' }, logs);

  service.scheduleAccount('qq-1');

  assert.deepEqual(logs, []);
});

test('WeChat accounts still report a missing wxid during Code refresh scheduling', () => {
  const logs = [];
  const service = createService({ id: 'wx-1', name: 'WeChat account', platform: 'wx' }, logs);

  service.scheduleAccount('wx-1');

  assert.equal(logs.length, 1);
  assert.equal(logs[0][1], '自动刷新 Code 未启动: 账号缺少 wxid');
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('QQ accounts refresh codes through the NapCat quick-login path', async () => {
  const updated = [];
  const restarted = [];
  const napcatCalls = [];
  const service = createAutoCodeRefreshService({
    store: { getAutoCodeRefresh: () => ({ enabled: false, intervalMinutes: 60 }) },
    getAccounts: () => ({ accounts: [{ id: 'qq-1', name: 'QQ 账号', platform: 'qq', uin: '12345' }] }),
    addOrUpdateAccount: account => updated.push(account),
    resolveWorkerControls: () => ({ restartWorker: account => restarted.push(account) }),
    log: () => {},
    addAccountLog: () => {},
    napcatLogin: {
      refreshCodeForUin: async (uin) => {
        napcatCalls.push(uin);
        return { code: 'nap-code', uin };
      },
    },
  });

  const ok = await service.refreshAccountCode('qq-1', 'ws_400');

  assert.equal(ok, true);
  assert.deepEqual(napcatCalls, ['12345']);
  assert.equal(updated[0].code, 'nap-code');
  assert.equal(restarted.length, 1);
});

test('QQ accounts without a uin fail code refresh without calling NapCat', async () => {
  let napcatCalled = false;
  const service = createAutoCodeRefreshService({
    store: { getAutoCodeRefresh: () => ({ enabled: false, intervalMinutes: 60 }) },
    getAccounts: () => ({ accounts: [{ id: 'qq-2', name: 'QQ 账号', platform: 'qq' }] }),
    addOrUpdateAccount: () => {},
    resolveWorkerControls: () => ({}),
    log: () => {},
    addAccountLog: () => {},
    napcatLogin: {
      refreshCodeForUin: async () => {
        napcatCalled = true;
        return { code: 'should-not-happen' };
      },
    },
  });

  const ok = await service.refreshAccountCode('qq-2', 'ws_400');

  assert.equal(ok, false);
  assert.equal(napcatCalled, false);
});

test('WeChat accounts never route code refresh through NapCat', async () => {
  const service = createAutoCodeRefreshService({
    store: { getAutoCodeRefresh: () => ({ enabled: false, intervalMinutes: 60 }) },
    getAccounts: () => ({ accounts: [{ id: 'wx-2', name: 'WeChat 账号', platform: 'wx', wxid: 'wx-abc' }] }),
    addOrUpdateAccount: () => {},
    resolveWorkerControls: () => ({}),
    log: () => {},
    addAccountLog: () => {},
    napcatLogin: {
      refreshCodeForUin: async () => {
        throw new Error('NapCat must not be used for WeChat accounts');
      },
    },
  });

  const ok = await service.refreshAccountCode('wx-2', 'ws_400');

  assert.equal(ok, false);
});

test('concurrent refreshes are serialized across accounts', async () => {
  let running = 0;
  let maxConcurrent = 0;
  const service = createAutoCodeRefreshService({
    store: { getAutoCodeRefresh: () => ({ enabled: false, intervalMinutes: 60 }) },
    getAccounts: () => ({
      accounts: [
        { id: 'qq-a', name: 'A', platform: 'qq', uin: '111' },
        { id: 'qq-b', name: 'B', platform: 'qq', uin: '222' },
      ],
    }),
    addOrUpdateAccount: () => {},
    resolveWorkerControls: () => ({}),
    log: () => {},
    addAccountLog: () => {},
    napcatLogin: {
      refreshCodeForUin: async (uin) => {
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        await sleep(20);
        running -= 1;
        return { code: `code-${uin}`, uin };
      },
    },
  });

  const results = await Promise.all([
    service.refreshAccountCode('qq-a', 'ws_400'),
    service.refreshAccountCode('qq-b', 'ws_400'),
  ]);

  assert.deepEqual(results, [true, true]);
  assert.equal(maxConcurrent, 1);
});

test('QQ accounts schedule timed refresh when enabled and a uin is present', () => {
  const logs = [];
  const service = createAutoCodeRefreshService({
    store: { getAutoCodeRefresh: () => ({ enabled: true, intervalMinutes: 60 }) },
    getAccounts: () => ({ accounts: [{ id: 'qq-3', name: 'QQ 账号', platform: 'qq', uin: '12345' }] }),
    addOrUpdateAccount: () => {},
    resolveWorkerControls: () => ({}),
    log: (...args) => logs.push(args),
    addAccountLog: () => {},
    napcatLogin: { refreshCodeForUin: async () => ({ code: 'x' }) },
  });

  service.scheduleAccount('qq-3');

  assert.equal(logs.length, 1);
  assert.match(logs[0][1], /自动刷新 Code 已启用/);
  service.stopAccount('qq-3');
});
