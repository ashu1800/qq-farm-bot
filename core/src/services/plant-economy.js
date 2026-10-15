/**
 * 植物经济模型（单株时长 / 收益 / 效率）
 *
 * 这是「作物效率」的唯一口径来源：analytics 排序、2x2 预留与铲除时机估算、
 * 种子商城展示都必须走这里，避免同一个作物在不同页面算出不同数值。
 *
 * 三个已确认的口径：
 * 1. `Plant.json` 的 `exp` 是**每次收获（每季）经验**，`seasons` 是收获次数。
 * 2. 多季作物「每季时长 = 首季时长」（MULTI_SEASON_RULE），首季时长由 `grow_phases` 求和得到。
 * 3. 效率一律折算为「每小时」；果价统一走 `getFruitPrice(fruit.id)`，取不到时收益标记为未知。
 *
 * 校准值来自 `plant-model.js`（全局、与账号无关）：
 * - 第二季及以后的实际时长有实测样本时用实测中位数，否则等于首季时长并标记为假定值。
 * - 化肥单次减秒有实测样本时用实测值，否则沿用历史实现（首阶段时长）并标记为假定值。
 * 任何假定值都会通过 `seasonSecondsSource` / `fert.*.reduceSource` 透出给前端标注。
 */
const {
  getPlantById,
  getPlantBySeedId,
  getFruitPrice,
  getSeedPrice,
  getItemImageById,
  getSeedLevel,
} = require('../config/gameConfig');
const plantModel = require('./plant-model');

const SECONDS_PER_HOUR = 3600;

/** 已确认：多季作物第 k 季时长取首季时长 */
const MULTI_SEASON_RULE = 'perSeasonEqualsFirst';

/**
 * 解析生长阶段字符串中的阶段列表
 * 格式如 "种子:30;发芽:30;成熟:0"
 * @returns {{name: string, sec: number}[]} 阶段名称与秒数
 */
function parseGrowPhases(growPhases) {
  if (!growPhases) return [];
  return String(growPhases)
    .split(';')
    .filter(part => part.length > 0)
    .map((part) => {
      const match = part.match(/^(.*):(\d+)$/);
      if (!match) return null;
      return { name: match[1], sec: Number.parseInt(match[2], 10) || 0 };
    })
    .filter(Boolean);
}

/** 首季总生长时长（秒） */
function parseGrowTime(growPhases) {
  return parseGrowPhases(growPhases).reduce((sum, phase) => sum + phase.sec, 0);
}

/**
 * 历史实现：把「第一个阶段的时长」当作普通化肥单次减秒
 * 仅作为无实测数据时的兼容值，会被 plant-model 的实测值取代。
 * @returns {number} 首阶段秒数
 */
function parseNormalFertilizerReduceSec(growPhases) {
  const phases = parseGrowPhases(growPhases);
  return phases.length > 0 ? phases[0].sec : 0;
}

/** 格式化秒数为可读时长 */
function formatTime(secs) {
  const seconds = Math.max(0, Math.round(Number(secs) || 0));
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < SECONDS_PER_HOUR) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  const hours = Math.floor(seconds / SECONDS_PER_HOUR);
  const mins = Math.floor((seconds % SECONDS_PER_HOUR) / 60);
  return mins > 0 ? `${hours}时${mins}分` : `${hours}时`;
}

function round2(value) {
  return Number.parseFloat((Number(value) || 0).toFixed(2));
}

/**
 * 解析每季时长
 * @returns {{seconds: number[], source: 'config'|'measured'|'assumed', sourceBySeason: string[]}} 每季秒数与来源标记
 */
function resolveSeasonSeconds(plant, calibration = plantModel) {
  const seasons = Math.max(1, Number(plant && plant.seasons) || 1);
  const firstSeasonSeconds = parseGrowTime(plant && plant.grow_phases);
  const seconds = [firstSeasonSeconds];
  const sourceBySeason = ['config'];

  for (let season = 2; season <= seasons; season += 1) {
    const measured = calibration && typeof calibration.getSeasonSeconds === 'function'
      ? calibration.getSeasonSeconds(Number(plant.id), season)
      : null;
    if (measured && measured.seconds > 0) {
      seconds.push(measured.seconds);
      sourceBySeason.push('measured');
    } else {
      // 多季作物的第 2 季及以后没有实测样本时，按已确认规则取首季时长。
      seconds.push(firstSeasonSeconds);
      sourceBySeason.push('assumed');
    }
  }

  let source = 'config';
  if (sourceBySeason.includes('assumed')) source = 'assumed';
  else if (sourceBySeason.includes('measured')) source = 'measured';

  return { seconds, source, sourceBySeason };
}

/**
 * 解析化肥模型
 * @returns {{normal: object, organic: object}} 普通与有机化肥的单次减秒、来源与有效时长
 */
function resolveFertilizer(plant, seasonCount, cycleSeconds, calibration = plantModel) {
  const legacyReduceSec = parseNormalFertilizerReduceSec(plant && plant.grow_phases);

  function build(type, fallbackReduceSec) {
    const measured = calibration && typeof calibration.getFertilizerReduceSec === 'function'
      ? calibration.getFertilizerReduceSec(type)
      : null;
    const useMeasured = !!(measured && measured.seconds > 0);
    const reduceSec = useMeasured ? measured.seconds : fallbackReduceSec;
    // 一次种植周期内按「每季施用一次」计算化肥总减秒。
    const appliedReduceSec = reduceSec * seasonCount;
    const effectiveSeconds = Math.max(1, cycleSeconds - appliedReduceSec);
    return {
      type,
      reduceSec,
      reduceSource: useMeasured ? 'measured' : 'assumed',
      samples: useMeasured ? measured.samples : 0,
      appliedReduceSec,
      effectiveSeconds,
    };
  }

  return {
    normal: build('normal', legacyReduceSec),
    organic: build('organic', legacyReduceSec),
  };
}

/**
 * 计算单株经济模型
 * @param {object} plant - Plant.json 中的植物配置
 * @param {object} [options]
 * @param {object} [options.calibration] - 校准数据源（默认 plant-model，测试可注入夹具）
 * @returns {object} 兼容既有 analytics 字段，并补充来源标记
 */
function getPlantEconomy(plant, options = {}) {
  if (!plant) return null;
  const calibration = options.calibration === undefined ? plantModel : options.calibration;

  const seasonCount = Math.max(1, Number(plant.seasons) || 1);
  const { seconds: seasonSeconds, source: seasonSecondsSource, sourceBySeason } =
    resolveSeasonSeconds(plant, calibration);
  const cycleSeconds = seasonSeconds.reduce((sum, seconds) => sum + seconds, 0);
  if (!(cycleSeconds > 0)) return null;

  const expPerSeason = Number.parseInt(plant.exp, 10) || 0;
  const cycleExp = expPerSeason * seasonCount;

  const fruitId = Number(plant.fruit && plant.fruit.id) || 0;
  const fruitPerSeason = Number(plant.fruit && plant.fruit.count) || 0;
  const fruitUnitPrice = getFruitPrice(fruitId);
  const priceKnown = fruitUnitPrice > 0;
  const seedId = Number(plant.seed_id) || 0;
  const seedPrice = getSeedPrice(seedId);

  const income = priceKnown ? fruitPerSeason * fruitUnitPrice * seasonCount : null;
  const netProfit = priceKnown ? income - seedPrice : null;

  const fert = resolveFertilizer(plant, seasonCount, cycleSeconds, calibration);
  const normalFert = fert.normal;
  const organicFert = fert.organic;

  const level = getSeedLevel(seedId);
  const levelOrNull = Number.isFinite(level) && level > 0 ? level : null;

  const expPerHour = cycleExp / cycleSeconds * SECONDS_PER_HOUR;

  return {
    // ── 既有字段（名称保持不变，避免破坏前端与种植策略） ──
    id: plant.id,
    seedId,
    name: plant.name,
    seasons: seasonCount,
    level: levelOrNull,
    growTime: cycleSeconds,
    growTimeStr: formatTime(cycleSeconds),
    reduceSec: normalFert.reduceSec,
    reduceSecApplied: normalFert.appliedReduceSec,
    expPerHour: round2(expPerHour),
    normalFertilizerExpPerHour: round2(cycleExp / normalFert.effectiveSeconds * SECONDS_PER_HOUR),
    goldPerHour: priceKnown ? round2(income / cycleSeconds * SECONDS_PER_HOUR) : null,
    profitPerHour: priceKnown ? round2(netProfit / cycleSeconds * SECONDS_PER_HOUR) : null,
    normalFertilizerProfitPerHour: priceKnown
      ? round2(netProfit / normalFert.effectiveSeconds * SECONDS_PER_HOUR)
      : null,
    income: priceKnown ? income : 0,
    netProfit: priceKnown ? netProfit : 0,
    fruitId,
    fruitCount: fruitPerSeason,
    fruitPrice: fruitUnitPrice,
    seedPrice,
    image: getItemImageById(seedId),

    // ── 新增：口径与来源标记 ──
    expPerSeason,
    cycleExp,
    cycleSeconds,
    firstSeasonSeconds: seasonSeconds[0],
    seasonSeconds: seasonSeconds.slice(),
    seasonSecondsSource,
    seasonSecondsSourceBySeason: sourceBySeason,
    priceKnown,
    calibrated: seasonSecondsSource === 'measured'
      && normalFert.reduceSource === 'measured'
      && organicFert.reduceSource === 'measured',
    fert: {
      normal: { ...normalFert },
      organic: {
        ...organicFert,
        expPerHour: round2(cycleExp / organicFert.effectiveSeconds * SECONDS_PER_HOUR),
        profitPerHour: priceKnown
          ? round2(netProfit / organicFert.effectiveSeconds * SECONDS_PER_HOUR)
          : null,
      },
    },
    multiSeasonRule: MULTI_SEASON_RULE,
  };
}

/** 按植物 ID 取模型 */
function getEconomyByPlantId(plantId, options) {
  return getPlantEconomy(getPlantById(Number(plantId)), options);
}

/** 按种子 ID 取模型 */
function getEconomyBySeedId(seedId, options) {
  return getPlantEconomy(getPlantBySeedId(Number(seedId)), options);
}

/** 一个完整种植周期（收完所有季）的总时长，秒 */
function getCycleSeconds(plantId, options) {
  const economy = getEconomyByPlantId(plantId, options);
  return economy ? economy.cycleSeconds : 0;
}

/** 首季时长，秒（用于按剩余季数外推土地清空时间） */
function getFirstSeasonSeconds(plantId, options) {
  const economy = getEconomyByPlantId(plantId, options);
  return economy ? economy.firstSeasonSeconds : 0;
}

module.exports = {
  MULTI_SEASON_RULE,
  SECONDS_PER_HOUR,
  parseGrowPhases,
  parseGrowTime,
  parseNormalFertilizerReduceSec,
  formatTime,
  resolveSeasonSeconds,
  getPlantEconomy,
  getEconomyByPlantId,
  getEconomyBySeedId,
  getCycleSeconds,
  getFirstSeasonSeconds,
};
