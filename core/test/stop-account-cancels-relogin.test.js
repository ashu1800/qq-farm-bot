const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAutoCodeRefreshService } = require('../src/runtime/auto-code-refresh');
const { createDataProvider } = require('../src/runtime/data-provider');
const { getSchedulerRegistrySnapshot } = require('../src/services/scheduler');

function createRefreshService(t) {
  const service = createAutoCodeRefreshService({
    store: { getAutoCodeRefresh: () => ({ enabled: true, intervalMinutes: 60 }) },
    getAccounts: () => ({ accounts: [{ id: 'a1', name: '测试账号', platform: 'qq', uin: '12345' }] }),
    addOrUpdateAccount: () => {},
    resolveWorkerControls: () => ({}),
    log: () => {},
    addAccountLog: () => {},
    napcatLogin: { refreshCodeForUin: async () => ({ code: 'x' }) },
  });
  t.after(() => service.stopAccount('a1'));
  return service;
}

function reloginTaskExists() {
  const snapshot = getSchedulerRegistrySnapshot('auto_code_refresh');
  const tasks = snapshot.schedulers.flatMap(item => item.tasks.map(task => task.name));
  return tasks.includes('relogin_a1');
}

test('stopAccount clears a pending relogin timer', (t) => {
  const service = createRefreshService(t);
  const scheduled = service.scheduleRelogin('a1', 'kickout:异地登录');
  assert.ok(scheduled, 'relogin should be scheduled');
  assert.equal(reloginTaskExists(), true);

  service.stopAccount('a1');

  assert.equal(reloginTaskExists(), false);
});

test('provider.stopAccount cancels scheduled relogin before stopping the worker', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-stop-account-'));
  const previousDataDir = process.env.FARM_DATA_DIR;
  process.env.FARM_DATA_DIR = dataDir;
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.FARM_DATA_DIR;
    else process.env.FARM_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const service = createRefreshService(t);
  service.scheduleRelogin('a1', 'kickout:异地登录');
  assert.equal(reloginTaskExists(), true);

  let stoppedWorkerId = '';
  const provider = createDataProvider({
    workers: {},
    globalLogs: [],
    accountLogs: [],
    store: { setAutomation() {}, getAutomation() { return {}; }, getConfigSnapshot() { return {}; } },
    getAccounts: () => ({ accounts: [{ id: 'a1', name: '测试账号' }] }),
    callWorkerApi: async () => {},
    buildDefaultStatus: () => ({}),
    normalizeStatusForPanel: value => value,
    filterLogs: logs => logs,
    nextConfigRevision: () => 1,
    broadcastConfigToWorkers: () => {},
    startWorker: () => {},
    stopWorker: id => { stoppedWorkerId = id; },
    restartWorker: () => {},
    getResourceStatus: () => null,
    stopAutoCodeRefresh: service.stopAccount,
  });

  assert.equal(provider.stopAccount('a1'), true);
  assert.equal(stoppedWorkerId, 'a1');
  assert.equal(reloginTaskExists(), false);
});
