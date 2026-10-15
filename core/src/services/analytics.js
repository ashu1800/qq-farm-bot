/**
 * 种植分析服务 - 植物排名计算
 *
 * 只负责「取模型 + 排序」，单株时长/收益/效率的口径全部来自
 * `plant-economy.js`（唯一来源）。历史实现在此处重复计算，已移除。
 */
const { getAllPlants } = require('../config/gameConfig');
const { getPlantEconomy } = require('./plant-economy');

const NUMERIC_METRICS = new Set([
  'expPerHour',
  'normalFertilizerExpPerHour',
  'goldPerHour',
  'profitPerHour',
  'normalFertilizerProfitPerHour',
]);

const SORT_METRICS = {
  exp: 'expPerHour',
  fert: 'normalFertilizerExpPerHour',
  gold: 'goldPerHour',
  profit: 'profitPerHour',
  fert_profit: 'normalFertilizerProfitPerHour',
};

/** 数值降序；null/undefined（例如收益未知）排在最后，且不参与比较 */
function compareMetricDesc(key) {
  return (left, right) => {
    const a = left?.[key];
    const b = right?.[key];
    const aValid = Number.isFinite(a);
    const bValid = Number.isFinite(b);
    if (!aValid && !bValid) return 0;
    if (!aValid) return 1;
    if (!bValid) return -1;
    return b - a;
  };
}

/**
 * 获取植物排名列表
 * @param {'exp'|'fert'|'gold'|'profit'|'fert_profit'|'level'} sortBy - 排序方式
 * @returns {object[]} 每项为 plant-economy 的模型结果
 */
function getPlantRankings(sortBy = 'exp') {
  const rankings = [];

  for (const plant of getAllPlants()) {
    if (!(plant.seed_id > 0) || !plant.grow_phases) continue;
    const economy = getPlantEconomy(plant);
    if (!economy || !(economy.cycleSeconds > 0)) continue;
    rankings.push(economy);
  }

  const metric = SORT_METRICS[sortBy];
  if (metric && NUMERIC_METRICS.has(metric)) {
    rankings.sort(compareMetricDesc(metric));
  } else if (sortBy === 'level') {
    rankings.sort(compareMetricDesc('level'));
  } else {
    rankings.sort(compareMetricDesc('expPerHour'));
  }

  return rankings;
}

module.exports = {
  getPlantRankings,
  SORT_METRICS,
};
