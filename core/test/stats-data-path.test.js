const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// stats 必须和其它数据文件使用同一个数据目录（runtime-paths.getDataDir）。
// 旧实现直接用 __dirname 推导，pkg 打包版会把统计写到快照内的不可写路径。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-stats-path-'));
const previousDataDir = process.env.FARM_DATA_DIR;
process.env.FARM_DATA_DIR = dataDir;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.FARM_DATA_DIR;
  else process.env.FARM_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const { getDataDir } = require('../src/config/runtime-paths');
const stats = require('../src/services/stats');

test('stats persistence follows the shared data directory', () => {
  stats.initStatsWithPersistence('path-check', 100, 200, 0);
  stats.recordOperation('harvest', 1);
  stats.saveStats();

  const expected = path.join(getDataDir(), 'stats', 'path-check.json');
  assert.ok(fs.existsSync(expected), `stats file should exist at ${expected}`);
  assert.equal(getDataDir(), dataDir);
});
