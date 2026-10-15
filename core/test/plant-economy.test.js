/**
 * 植物经济模型测试
 *
 * 覆盖：单季/双季时长口径、实测校准替换假定值、化肥减秒来源、收益未知的降级输出，
 * 以及全部配置作物的模型自洽性（防止再次出现两套口径）。
 * 全部使用仓库内配置与注入的夹具，不连真实服务端、不写盘。
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getPlantEconomy,
  getEconomyBySeedId,
  getCycleSeconds,
  getFirstSeasonSeconds,
  parseGrowPhases,
  MULTI_SEASON_RULE,
} = require('../src/services/plant-economy');
const { getPlantBySeedId, getAllPlants, getSeedHarvestInfo } = require('../src/config/gameConfig');

/** 无任何实测数据：模型必须退回配置值或显式假定值 */
const NO_CALIBRATION = {
  getSeasonSeconds: () => null,
  getFertilizerReduceSec: () => null,
};

function round2(value) {
  return Number.parseFloat((Number(value) || 0).toFixed(2));
}

test('生长阶段解析保留名称与秒数', () => {
  const phases = parseGrowPhases('种子:30;发芽:30;成熟:0');
  assert.deepEqual(phases, [
    { name: '种子', sec: 30 },
    { name: '发芽', sec: 30 },
    { name: '成熟', sec: 0 },
  ]);
  assert.deepEqual(parseGrowPhases(''), []);
  assert.deepEqual(parseGrowPhases(null), []);
});

test('单季作物：周期等于首季时长，效率与收益按配置计算', () => {
  // 白萝卜：种子 20002，经验 1，阶段 30+30=60 秒，果实 40002 ×5，单价 2，种子价 2
  const economy = getEconomyBySeedId(20002, { calibration: NO_CALIBRATION });

  assert.equal(economy.name, '白萝卜');
  assert.equal(economy.seasons, 1);
  assert.equal(economy.firstSeasonSeconds, 60);
  assert.equal(economy.cycleSeconds, 60);
  assert.equal(economy.seasonSecondsSource, 'config');
  assert.deepEqual(economy.seasonSecondsSourceBySeason, ['config']);
  assert.equal(economy.expPerSeason, 1);
  assert.equal(economy.cycleExp, 1);
  assert.equal(economy.expPerHour, 60);
  assert.equal(economy.fruitCount, 5);
  assert.equal(economy.fruitPrice, 2);
  assert.equal(economy.seedPrice, 2);
  assert.equal(economy.priceKnown, true);
  assert.equal(economy.income, 10);
  assert.equal(economy.netProfit, 8);
  assert.equal(economy.profitPerHour, 480); // 8 经验币 / (1/60 小时)
  assert.equal(economy.goldPerHour, 600);
});

test('双季作物：每季时长按首季计，不再使用历史 1.5 系数', () => {
  // 蘑菇：种子 20050，经验 429，阶段 4×3600=14400 秒/季，共 2 季
  const economy = getEconomyBySeedId(20050, { calibration: NO_CALIBRATION });

  assert.equal(economy.seasons, 2);
  assert.equal(economy.firstSeasonSeconds, 14400);
  // 旧实现为 14400 × 1.5 = 21600，已统一为「每季 = 首季」
  assert.equal(economy.cycleSeconds, 28800);
  assert.deepEqual(economy.seasonSeconds, [14400, 14400]);
  assert.equal(economy.seasonSecondsSource, 'assumed');
  assert.deepEqual(economy.seasonSecondsSourceBySeason, ['config', 'assumed']);
  assert.equal(economy.multiSeasonRule, MULTI_SEASON_RULE);
  assert.equal(economy.expPerSeason, 429);
  assert.equal(economy.cycleExp, 858);
  assert.equal(economy.expPerHour, 107.25);
});

test('注入实测季时长后替换假定值并标记来源', () => {
  // plant-model 以「植物 ID + 季序号」为键：蘑菇植物 ID 为 1020050
  const calibration = {
    getSeasonSeconds: (plantId, season) => (
      Number(plantId) === 1020050 && Number(season) === 2
        ? { seconds: 7200, samples: 3, source: 'measured' }
        : null
    ),
    getFertilizerReduceSec: () => null,
  };

  const economy = getEconomyBySeedId(20050, { calibration });
  assert.equal(economy.firstSeasonSeconds, 14400);
  assert.equal(economy.cycleSeconds, 21600);
  assert.deepEqual(economy.seasonSeconds, [14400, 7200]);
  assert.equal(economy.seasonSecondsSource, 'measured');
  assert.deepEqual(economy.seasonSecondsSourceBySeason, ['config', 'measured']);
  assert.equal(economy.expPerHour, round2(858 / 21600 * 3600));
});

test('化肥减秒：无实测沿用首阶段时长并标记，实测优先', () => {
  const assumed = getEconomyBySeedId(20050, { calibration: NO_CALIBRATION });
  assert.equal(assumed.fert.normal.reduceSource, 'assumed');
  assert.equal(assumed.fert.normal.reduceSec, 3600); // 首阶段时长
  // 一次种植周期按每季施用一次累计
  assert.equal(assumed.fert.normal.appliedReduceSec, 7200);
  assert.equal(assumed.fert.normal.effectiveSeconds, 28800 - 7200);
  assert.equal(assumed.normalFertilizerExpPerHour, round2(858 / 21600 * 3600));
  // 兼容字段与化肥模型保持一致
  assert.equal(assumed.reduceSec, assumed.fert.normal.reduceSec);
  assert.equal(assumed.reduceSecApplied, assumed.fert.normal.appliedReduceSec);

  const calibration = {
    getSeasonSeconds: () => null,
    getFertilizerReduceSec: type => (type === 'normal' ? { seconds: 1800, samples: 4, source: 'measured' } : null),
  };
  const measured = getEconomyBySeedId(20050, { calibration });
  assert.equal(measured.fert.normal.reduceSource, 'measured');
  assert.equal(measured.fert.normal.reduceSec, 1800);
  assert.equal(measured.fert.normal.appliedReduceSec, 3600);
  assert.equal(measured.fert.normal.effectiveSeconds, 28800 - 3600);
  assert.equal(measured.normalFertilizerExpPerHour, round2(858 / 25200 * 3600));
  // 有机化肥没有实测样本，仍然标记为假定值
  assert.equal(measured.fert.organic.reduceSource, 'assumed');
});

test('收益未知的作物输出 null 而不是 0 或负数', () => {
  // 琉璃宝荷（活动作物）：果实不在物品表中，没有价格
  const economy = getEconomyBySeedId(21032, { calibration: NO_CALIBRATION });

  assert.equal(economy.priceKnown, false);
  assert.equal(economy.fruitPrice, 0);
  assert.equal(economy.profitPerHour, null);
  assert.equal(economy.goldPerHour, null);
  assert.equal(economy.normalFertilizerProfitPerHour, null);
  assert.equal(economy.income, 0);
  assert.equal(economy.netProfit, 0);
  // 经验效率不依赖价格，仍然可用
  assert.equal(economy.expPerHour, 640);
  assert.equal(economy.normalFertilizerExpPerHour, 800);
});

test('周期时长辅助函数与模型一致', () => {
  const economy = getEconomyBySeedId(20050, { calibration: NO_CALIBRATION });
  assert.equal(getCycleSeconds(economy.id), economy.cycleSeconds);
  assert.equal(getFirstSeasonSeconds(economy.id), economy.firstSeasonSeconds);
  assert.equal(getCycleSeconds(-1), 0);
  assert.equal(getFirstSeasonSeconds(-1), 0);
});

test('缺少配置时返回 null 而不是抛错', () => {
  assert.equal(getPlantEconomy(null), null);
  assert.equal(getPlantEconomy({ id: 1, seed_id: 1 }), null);
});

test('全部配置作物的模型自洽且不存在第二套时长口径', () => {
  const plants = getAllPlants();
  let ranked = 0;
  for (const plant of plants) {
    if (!(plant.seed_id > 0) || !plant.grow_phases) continue;
    const economy = getPlantEconomy(plant, { calibration: NO_CALIBRATION });
    if (!economy) continue;
    ranked += 1;

    const label = `${economy.name}(${economy.seedId})`;
    const seasonSum = economy.seasonSeconds.reduce((sum, seconds) => sum + seconds, 0);
    assert.equal(economy.cycleSeconds, seasonSum, label);
    assert.equal(economy.seasonSeconds.length, economy.seasons, label);
    assert.equal(economy.cycleExp, economy.expPerSeason * economy.seasons, label);
    assert.equal(
      economy.expPerHour,
      round2(economy.cycleExp / economy.cycleSeconds * 3600),
      label,
    );
    assert.equal(economy.priceKnown, economy.fruitPrice > 0, label);
    if (!economy.priceKnown) {
      assert.equal(economy.profitPerHour, null, label);
      assert.equal(economy.goldPerHour, null, label);
      assert.equal(economy.normalFertilizerProfitPerHour, null, label);
    } else {
      assert.equal(typeof economy.profitPerHour, 'number', label);
    }
    assert.ok(economy.fert.normal.effectiveSeconds > 0, label);
    assert.ok(Number.isFinite(economy.growTime) && economy.growTime > 0, label);
    assert.ok(['config', 'measured', 'assumed'].includes(economy.seasonSecondsSource), label);

    // 回归：多季作物每季时长必须等于首季时长，不能再出现 ×1.5 这类无依据系数
    if (economy.seasons > 1) {
      assert.equal(economy.cycleSeconds, economy.firstSeasonSeconds * economy.seasons, label);
      assert.equal(economy.seasonSecondsSource, 'assumed', label);
    }
  }
  assert.ok(ranked > 100, `可建模作物数量异常偏少: ${ranked}`);
});

test('种子收获信息与作物模型口径一致（果实定价只有一套）', () => {
  for (const seedId of [20002, 20050, 21032]) {
    const economy = getEconomyBySeedId(seedId, { calibration: NO_CALIBRATION });
    const harvest = getSeedHarvestInfo(seedId);
    const label = `${economy.name}(${seedId})`;

    assert.equal(harvest.expPerSeason, economy.expPerSeason, label);
    assert.equal(harvest.seasons, economy.seasons, label);
    assert.equal(harvest.incomePerSeason, economy.fruitPrice * economy.fruitCount, label);
    assert.equal(harvest.priceKnown, economy.priceKnown, label);
  }
});

test('种子配置存在但缺少阶段数据时不会进入排名模型', () => {
  const plant = getPlantBySeedId(20002);
  assert.ok(plant);
  const broken = { ...plant, grow_phases: '' };
  assert.equal(getPlantEconomy(broken, { calibration: NO_CALIBRATION }), null);
});
