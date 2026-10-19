const test = require('node:test');
const { useTempDataDir } = require('./helpers');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// Worker 通过 IPC 上报好友 GID 变更、主进程负责落盘。
// 这里使用临时数据目录，避免触碰真实 core/data。
// 临时数据目录：统一走 test/helpers，避免每个文件各写一份环境变量恢复逻辑。
const { dataDir } = useTempDataDir((fn) => test.after(fn), { prefix: 'qf-friend-gid-sync-' });

const { createWorkerManager } = require('../src/runtime/worker-manager');
const store = require('../src/models/store');

function createHarness(t) {
  const proc = new EventEmitter();
  proc.send = () => {};
  proc.kill = () => {};
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
    triggerOfflineReminder: () => {},
    addOrUpdateAccount: () => {},
    getAccounts: () => ({ accounts: [] }),
    deleteAccount: () => {},
  });
  t.after(() => manager.dispose());
  manager.startWorker({ id: 'a1', name: '测试账号', username: 'owner', code: 'code' });
  return { proc };
}

test('known_friend_gids_sync from worker is persisted by the master process', (t) => {
  const { proc } = createHarness(t);

  proc.emit('message', { type: 'known_friend_gids_sync', gids: [101, 202, 303] });

  assert.deepEqual(store.getKnownFriendGids('a1'), [101, 202, 303]);
  const cacheFile = path.join(dataDir, 'known_friend_gids', 'a1.json');
  assert.ok(fs.existsSync(cacheFile), 'known gid cache should be written');
  assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).gids, [101, 202, 303]);
});

test('known_friend_gid_remove removes the gid from persisted state', (t) => {
  const { proc } = createHarness(t);
  store.setKnownFriendGids('a1', [101, 202, 303]);

  proc.emit('message', { type: 'known_friend_gid_remove', gid: 202, friendName: '旧好友' });

  assert.deepEqual(store.getKnownFriendGids('a1'), [101, 303]);
});
