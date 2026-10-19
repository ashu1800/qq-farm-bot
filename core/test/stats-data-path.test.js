const test = require('node:test');
const { useTempDataDir } = require('./helpers');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// stats 必须和其它数据文件使用同一个数据目录（runtime-paths.getDataDir）。
// 旧实现直接用 __dirname 推导，pkg 打包版会把统计写到快照内的不可写路径。
// 临时数据目录：统一走 test/helpers，避免每个文件各写一份环境变量恢复逻辑。
const { dataDir } = useTempDataDir((fn) => test.after(fn), { prefix: 'qf-stats-data-path-' });

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
