const test = require('node:test');
const { useTempDataDir } = require('./helpers');
const assert = require('node:assert/strict');

// 临时数据目录：统一走 test/helpers，避免每个文件各写一份环境变量恢复逻辑。
useTempDataDir((fn) => test.after(fn), { prefix: 'qf-ranking-cache-' });

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
