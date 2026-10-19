const test = require('node:test');
const { useTempDataDir } = require('./helpers');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// 临时数据目录：统一走 test/helpers，避免每个文件各写一份环境变量恢复逻辑。
useTempDataDir((fn) => test.after(fn), { prefix: 'qf-automation-batch-' });

const store = require('../src/models/store');
const { createDataProvider } = require('../src/runtime/data-provider');

function countConfigSaves() {
  let writes = 0;
  const original = fs.writeFileSync;
  fs.writeFileSync = (target, ...rest) => {
    if (String(target).includes('store.json')) writes += 1;
    return original(target, ...rest);
  };
  return {
    get value() { return writes; },
    restore() { fs.writeFileSync = original; },
  };
}

test('setAutomationBatch applies many keys with a single persistence pass', (t) => {
  const keys = Object.keys(store.getAutomation('batch-account'));
  const patch = {};
  for (const key of keys) patch[key] = false;
  patch.farm = true;
  patch.friend = true;

  const counter = countConfigSaves();
  t.after(() => counter.restore());
  store.setAutomationBatch(patch, 'batch-account');

  const automation = store.getAutomation('batch-account');
  assert.equal(automation.farm, true);
  assert.equal(automation.friend, true);
  assert.equal(automation.sell, false);
  assert.ok(counter.value <= 1, `expected at most one store.json write, got ${counter.value}`);
});

test('setAutomationBatch keeps single-key setAutomation semantics', () => {
  store.setAutomation('friend_bad', true, 'batch-account');
  assert.equal(store.getAutomation('batch-account').friend_bad, true);
  // 开启捣乱时清空历史重试日期
  assert.equal(store.getFriendBadRetryDate('batch-account'), '');
});

test('provider.setAutomationBatch broadcasts config once', async () => {
  let broadcasts = 0;
  const provider = createDataProvider({
    workers: {},
    globalLogs: [],
    accountLogs: [],
    store,
    getAccounts: () => ({ accounts: [{ id: 'batch-account' }] }),
    callWorkerApi: async () => {},
    buildDefaultStatus: () => ({}),
    normalizeStatusForPanel: value => value,
    filterLogs: logs => logs,
    nextConfigRevision: () => 1,
    broadcastConfigToWorkers: () => { broadcasts += 1; },
    startWorker: () => {},
    stopWorker: () => {},
    restartWorker: () => {},
    getResourceStatus: () => null,
  });

  const keys = Object.keys(store.getAutomation('batch-account'));
  const patch = {};
  for (const key of keys) patch[key] = false;

  const result = await provider.setAutomationBatch('batch-account', patch);

  assert.equal(broadcasts, 1);
  assert.ok(result && result.automation);
  assert.equal(result.automation.farm, false);
});
