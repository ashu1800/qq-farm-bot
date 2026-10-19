/**
 * 种植分析服务 - 植物排名计算
 *
 * 只负责「取模型 + 排序」，单株时长/收益/效率的口径全部来自
 * `plant-economy.js`（唯一来源）。历史实现在此处重复计算，已移除。
 *
 * 性能：`getPlantEconomy` 会为每种作物重新解析生长阶段、查价格、算化肥模型，
 * 291 种作物单次约 47ms。选种是 3–5 秒一次巡田的热路径，因此这里缓存
 * 「未排序的经济模型」，各排序方式再基于缓存做一次轻量排序。
 * 作物配置在运行期不变；校准数据变化时可以调用 `resetPlantRankingCache()`。
 */
const { getAllPlants } = require('../config/gameConfig');
const { getPlantEconomy } = require('./plant-economy');
const { onRankingCacheInvalidate } = require('./ranking-cache');

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

/** 缓存失效上限：作物配置通常不变，这里的 TTL 只是兜底 */
const ECONOMY_CACHE_TTL_MS = 10 * 60 * 1000;

let economyCache = null;
/** 各排序方式的结果缓存：排序只在数据变化时做一次 */
const rankingCache = new Map();

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

/** 计算所有作物的经济模型（未排序），结果按 TTL 缓存 */
function getEconomyModels() {
  const now = Date.now();
  if (economyCache && now - economyCache.at < ECONOMY_CACHE_TTL_MS) {
    return economyCache.models;
  }

  const models = [];
  for (const plant of getAllPlants()) {
    if (!(plant.seed_id > 0) || !plant.grow_phases) continue;
    const economy = getPlantEconomy(plant);
    if (!economy || !(economy.cycleSeconds > 0)) continue;
    models.push(economy);
  }

  economyCache = { at: now, models };
  return models;
}

/** 清空排行缓存（作物配置或校准数据变化后调用） */
function resetPlantRankingCache() {
  economyCache = null;
  rankingCache.clear();
}

// 校准数据更新时自动失效，避免新样本要等 TTL 才生效。
onRankingCacheInvalidate(resetPlantRankingCache);

/**
 * 获取植物排名列表
 * @param {'exp'|'fert'|'gold'|'profit'|'fert_profit'|'level'} sortBy - 排序方式
 * @returns {object[]} 每项为 plant-economy 的模型结果
 */
function getPlantRankings(sortBy = 'exp') {
  const cached = rankingCache.get(sortBy);
  // 排序结果按 sortBy 缓存；返回浅拷贝，调用方修改数组不会污染缓存。
  if (cached) return [...cached];

  const rankings = [...getEconomyModels()];
  const metric = SORT_METRICS[sortBy];
  if (metric && NUMERIC_METRICS.has(metric)) {
    rankings.sort(compareMetricDesc(metric));
  } else if (sortBy === 'level') {
    rankings.sort(compareMetricDesc('level'));
  } else {
    rankings.sort(compareMetricDesc('expPerHour'));
  }

  rankingCache.set(sortBy, rankings);
  return [...rankings];
}

module.exports = {
  getPlantRankings,
  resetPlantRankingCache,
  SORT_METRICS,
};
