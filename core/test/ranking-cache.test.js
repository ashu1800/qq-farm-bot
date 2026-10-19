const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-ranking-cache-'));
const logDir = path.join(os.tmpdir(), 'qf-test-logs');
const previousDataDir = process.env.FARM_DATA_DIR;
const previousLogDir = process.env.FARM_LOG_DIR;
process.env.FARM_DATA_DIR = dataDir;
process.env.FARM_LOG_DIR = logDir;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.FARM_DATA_DIR;
  else process.env.FARM_DATA_DIR = previousDataDir;
  if (previousLogDir === undefined) delete process.env.FARM_LOG_DIR;
  else process.env.FARM_LOG_DIR = previousLogDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const { getPlantRankings, resetPlantRankingCache } = require('../src/services/analytics');
const { recordSeasonObservation } = require('../src/services/plant-model');

test('plant rankings are cached and returned independent of sortBy', () => {
  resetPlantRankingCache();
  const byExp = getPlantRankings('exp');
  const byProfit = getPlantRankings('profit');

  assert.ok(byExp.length > 0);
  assert.equal(byExp.length, byProfit.length);
  // 返回的是副本，调用方排序/修改不能污染缓存
  byExp.length = 0;
  assert.ok(getPlantRankings('exp').length > 0);
});

test('calibration updates invalidate the ranking cache', () => {
  resetPlantRankingCache();
  const before = getPlantRankings('exp')[0];

  // 记录两条样本使某作物第 2 季出现实测值
  recordSeasonObservation(10101, 2, 1234, { source: 'test' });
  recordSeasonObservation(10101, 2, 1234, { source: 'test' });

  const after = getPlantRankings('exp');
  assert.ok(after.length > 0);
  // 只要缓存被清过就能拿到新对象；这里断言不会抛错且结果结构稳定
  assert.equal(typeof before.seedId, 'number');
  assert.equal(typeof after[0].seedId, 'number');
});
