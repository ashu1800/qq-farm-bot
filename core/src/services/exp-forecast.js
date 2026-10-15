/**
 * 经验产出预测（种植结构前瞻口径）
 *
 * 「效率」与「升级预估」都按用户确认的口径计算：
 *
 *   每块已种地块的产出率 = 该作物每季经验 ÷ 该作物整季时长（播种 → 收获）
 *   效率(经验/小时)      = Σ(已种地块产出率) × 3600
 *
 *   升级预估 = 把各块地的收获事件按时间排序、累加经验，
 *              累计值首次达到「本级剩余经验」的时刻就是升级时间。
 *
 * 一轮收完仍不够时按补种继续外推：已种地块收获后补种同作物，空地补种调用方给定的
 * 期望作物（`expectedCrop`，通常来自当前种植策略的最优作物）；自动巡田关闭时只报告缺口。
 *
 * 土地数据由巡田流程通过 `publishLandSnapshot()` 写入进程内快照，本模块不做任何网络请求。
 * 快照超过 `SNAPSHOT_STALE_SEC` 未更新时标记 stale，调用方应停用 ETA 而不是给出过期数字。
 *
 * 口径边界（属保守下界，详见 core/docs 与 CHANGELOG）：
 * - 不建模土地 buff（`LandInfo.buff.plant_exp_bonus`）、变异与被偷带来的经验差异；
 * - 副地（被主地占用的 2x2 从属地块）不计入分母，作物经验只在主地计一次；
 * - 补种耗时按 0 计（自动化在收获后立即补种）。
 */
const { getPlantById, getPlantExp } = require('../config/gameConfig');
const { getFirstSeasonSeconds } = require('./plant-economy');
const { getPlantRankings } = require('./analytics');

const SECONDS_PER_HOUR = 3600;
/** 快照超过该时长未更新则视为过期（巡田间隔为 3-5 秒） */
const SNAPSHOT_STALE_SEC = 600;
/** 外推时最多遍历的收获事件数，超过即认为无法在可见时间内升级 */
const MAX_FORECAST_EVENTS = 100000;
/** 超过该预估时长直接标记为「超过 1 年」 */
const FOREVER_SEC = 365 * 24 * 3600;

/** PlantInfo.phase 粗状态：6=成熟可收、7=枯死 */
const PHASE_MATURE = 6;
const PHASE_DEAD = 7;

/** 种植策略 → 作物排行口径（与 planting-service 的选择逻辑保持一致） */
const STRATEGY_RANKINGS = {
  max_exp: 'exp',
  max_fert_exp: 'fert',
  max_profit: 'profit',
  max_fert_profit: 'fert_profit',
};
/** 期望作物缓存时长：排行是全量作物计算，不能跟着 10 秒一次的状态同步跑 */
const EXPECTED_CROP_TTL_MS = 10 * 60 * 1000;
let expectedCropCache = null;

/**
 * 解析「空地补种时会种什么」：按当前种植策略对应的排行取第一名
 * （`level` / `bag_priority` / `task_priority` 无法直接映射排名，按经验最优处理）
 * @param {string} strategy - store.getPlantingStrategy()
 * @returns {{name: string, expPerSeason: number, seasonDurationSec: number}|null} 期望作物；排行不可用时返回 null
 */
function resolveExpectedCrop(strategy) {
  const key = String(strategy || 'max_exp').trim() || 'max_exp';
  const now = Date.now();
  if (expectedCropCache && expectedCropCache.key === key && now - expectedCropCache.at < EXPECTED_CROP_TTL_MS) {
    return expectedCropCache.value;
  }

  let value = null;
  try {
    const rankings = getPlantRankings(STRATEGY_RANKINGS[key] || 'exp');
    const best = rankings.find(item => item.expPerSeason > 0 && item.firstSeasonSeconds > 0) || null;
    if (best) {
      value = {
        name: String(best.name || ''),
        expPerSeason: toNum(best.expPerSeason),
        seasonDurationSec: toNum(best.firstSeasonSeconds),
      };
    }
  } catch {
    value = null;
  }

  expectedCropCache = { key, at: now, value };
  return value;
}

/** 测试用：清空期望作物缓存 */
function __resetExpectedCropCache() {
  expectedCropCache = null;
}

function toNum(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

let snapshot = null; // { atMs, serverTimeSec, lands: [], totalLands, plantedLands }

/**
 * 把原始地块列表归一化成预测输入
 * @param {Array} lands - getAllLands 返回的原始地块
 * @param {object} [options]
 * @param {number} [options.serverTimeSec] - 服务器时间（秒），默认取本地时间
 * @returns {{atMs: number, serverTimeSec: number, lands: object[], totalLands: number, plantedLands: number}} 归一化快照
 */
function buildLandSnapshot(lands, options = {}) {
  const nowMs = toNum(options.nowMs) || Date.now();
  const serverTimeSec = toNum(options.serverTimeSec) || Math.floor(nowMs / 1000);
  const list = Array.isArray(lands) ? lands : [];

  // 被主地占用的副地不能独立种植，不计入分母；作物经验只在主地计一次
  const occupiedIds = new Set();
  for (const land of list) {
    if (!land || !land.unlocked) continue;
    const plant = land.plant;
    if (!plant || !Array.isArray(plant.phases) || plant.phases.length === 0) continue;
    for (const slaveId of (Array.isArray(land.slave_land_ids) ? land.slave_land_ids : [])) {
      const id = toNum(slaveId);
      if (id > 0) occupiedIds.add(id);
    }
  }

  const plots = [];
  let totalLands = 0;

  for (const land of list) {
    if (!land || !land.unlocked) continue;
    const landId = toNum(land.id);
    if (!landId || occupiedIds.has(landId)) continue;
    totalLands += 1;

    const plant = land.plant;
    const phases = Array.isArray(plant && plant.phases) ? plant.phases : [];
    if (!plant || phases.length === 0) continue; // 空地

    const coarsePhase = toNum(phases[0] && phases[0].phase);
    if (coarsePhase === PHASE_DEAD) continue; // 枯死，等待铲除，不产出经验

    const plantId = toNum(plant.id);
    if (!plantId) continue;

    const expPerSeason = toNum(getPlantExp(plantId));
    const seasonDurationSec = toNum(getFirstSeasonSeconds(plantId));
    if (expPerSeason <= 0 || seasonDurationSec <= 0) continue; // 缺配置的作物不参与预测

    const matureBegin = phases
      .map(item => toNum(item && item.begin_time))
      .filter(value => value > 0)
      .sort((left, right) => right - left)[0] || 0;
    const remainingToHarvestSec = coarsePhase === PHASE_MATURE
      ? 0
      : Math.max(0, matureBegin - serverTimeSec);

    const plantInfo = getPlantById(plantId) || {};
    const seasonIndex = Math.max(1, toNum(plant.season) || 1);
    const totalSeasons = Math.max(seasonIndex, toNum(plantInfo.seasons) || seasonIndex);

    plots.push({
      landId,
      plantId,
      name: String(plantInfo.name || plant.name || `植物${plantId}`),
      expPerSeason,
      seasonDurationSec,
      seasonIndex,
      totalSeasons,
      remainingToHarvestSec,
    });
  }

  return {
    atMs: nowMs,
    serverTimeSec,
    lands: plots,
    totalLands,
    plantedLands: plots.length,
  };
}

/**
 * 写入土地快照（巡田与土地接口调用）
 * @param {Array} lands - 原始地块列表
 * @param {object} [options] - 同 buildLandSnapshot
 * @returns {object} 归一化后的快照
 */
function publishLandSnapshot(lands, options = {}) {
  snapshot = buildLandSnapshot(lands, options);
  return snapshot;
}

/** 读取当前快照（可能为 null） */
function getLandSnapshot() {
  return snapshot;
}

/**
 * 计算效率与升级预估（纯函数）
 * @param {object} input
 * @param {object|null} input.snapshot - buildLandSnapshot 的结果
 * @param {number} input.remainingExp - 本级升级还差多少经验
 * @param {boolean} [input.levelMaxed] - 是否已满级
 * @param {boolean} [input.autoReplant] - 自动巡田是否开启（决定能否按补种外推）
 * @param {object|null} [input.expectedCrop] - 空地补种作物 { expPerSeason, seasonDurationSec, name }
 * @param {number} [input.nowMs] - 当前时间（测试注入）
 * @returns {object} 预测负载
 */
function buildExpForecast(input = {}) {
  const nowMs = toNum(input.nowMs) || Date.now();
  const remainingExp = Math.max(0, toNum(input.remainingExp));
  const levelMaxed = input.levelMaxed === true;
  const autoReplant = input.autoReplant !== false;
  const expectedCrop = input.expectedCrop && toNum(input.expectedCrop.expPerSeason) > 0
    && toNum(input.expectedCrop.seasonDurationSec) > 0
    ? input.expectedCrop
    : null;
  const snap = input.snapshot || null;

  const base = {
    ready: false,
    expPerHour: null,
    expPerHourWithReplant: null,
    plantedLands: 0,
    totalLands: 0,
    nextHarvestInSec: null,
    nextHarvestExp: null,
    etaSeconds: null,
    etaSource: 'none',
    etaBeyond: false,
    expectedCropName: expectedCrop ? String(expectedCrop.name || '') : null,
    missingExp: remainingExp,
    stale: true,
    snapshotAgeSec: null,
    updatedAt: nowMs,
  };

  if (!snap || !Array.isArray(snap.lands) || snap.totalLands <= 0) {
    return { ...base, etaSource: levelMaxed ? 'maxed' : 'none' };
  }

  const snapshotAgeSec = Math.max(0, Math.round((nowMs - toNum(snap.atMs)) / 1000));
  const stale = snapshotAgeSec > SNAPSHOT_STALE_SEC;
  const emptyLands = Math.max(0, toNum(snap.totalLands) - toNum(snap.plantedLands));

  // 效率：只按已种下的作物折算；空地不摊薄，但单独给出「含补种」的参考值
  const plantedRatePerSec = snap.lands.reduce(
    (sum, plot) => sum + plot.expPerSeason / plot.seasonDurationSec,
    0,
  );
  const expPerHour = plantedRatePerSec * SECONDS_PER_HOUR;
  const replantRatePerSec = expectedCrop && emptyLands > 0
    ? emptyLands * (expectedCrop.expPerSeason / expectedCrop.seasonDurationSec)
    : 0;
  const expPerHourWithReplant = (plantedRatePerSec + replantRatePerSec) * SECONDS_PER_HOUR;

  // 各块地的收获事件序列：每季一次、间隔等于整季时长；补种后周期不变
  const plantedPlots = snap.lands.map(plot => ({
    nextAt: plot.remainingToHarvestSec,
    periodSec: plot.seasonDurationSec,
    exp: plot.expPerSeason,
  }));
  const emptyPlots = [];
  if (autoReplant && expectedCrop && emptyLands > 0) {
    for (let index = 0; index < emptyLands; index += 1) {
      emptyPlots.push({
        nextAt: expectedCrop.seasonDurationSec,
        periodSec: expectedCrop.seasonDurationSec,
        exp: expectedCrop.expPerSeason,
      });
    }
  }

  const sorted = snap.lands
    .map(plot => ({ at: plot.remainingToHarvestSec, exp: plot.expPerSeason }))
    .sort((left, right) => left.at - right.at);
  const firstEvent = sorted.length > 0 ? sorted[0] : null;

  const result = {
    ...base,
    ready: true,
    expPerHour: Math.round(expPerHour * 10) / 10,
    expPerHourWithReplant: Math.round(expPerHourWithReplant * 10) / 10,
    plantedLands: toNum(snap.plantedLands),
    totalLands: toNum(snap.totalLands),
    nextHarvestInSec: firstEvent ? firstEvent.at : null,
    nextHarvestExp: firstEvent ? firstEvent.exp : null,
    stale,
    snapshotAgeSec,
  };

  if (levelMaxed) {
    return { ...result, etaSource: 'maxed', missingExp: 0 };
  }
  if (remainingExp <= 0) {
    return { ...result, etaSource: 'none', missingExp: 0 };
  }
  if (stale) {
    // 快照过期时不给出 ETA，避免用过期土地数据报错误时间
    return { ...result, etaSource: 'insufficient', missingExp: remainingExp };
  }

  // 只用「当前已种下的作物」求第一次 ETA；不足时再按补种外推
  let cumulative = 0;
  for (const event of sorted) {
    cumulative += event.exp;
    if (cumulative >= remainingExp) {
      return { ...result, etaSeconds: event.at, etaSource: 'planted', missingExp: 0 };
    }
  }

  if (!autoReplant || (plantedPlots.length === 0 && emptyPlots.length === 0)) {
    return {
      ...result,
      etaSource: 'insufficient',
      missingExp: Math.max(0, remainingExp - cumulative),
    };
  }

  // 补种外推：每块地按固定周期持续产出经验。
  // 已种地块的首季收获已在上面的循环里计入，因此从「下一次收获」开始续排。
  const periods = [
    ...plantedPlots.map(plot => ({ ...plot, nextAt: plot.nextAt + plot.periodSec })),
    ...emptyPlots.map(plot => ({ ...plot })),
  ];
  let total = cumulative;
  let guard = 0;
  while (guard < MAX_FORECAST_EVENTS) {
    guard += 1;
    let earliestIndex = -1;
    for (let index = 0; index < periods.length; index += 1) {
      if (earliestIndex === -1 || periods[index].nextAt < periods[earliestIndex].nextAt) {
        earliestIndex = index;
      }
    }
    const plot = periods[earliestIndex];
    total += plot.exp;
    if (total >= remainingExp) {
      return {
        ...result,
        etaSeconds: plot.nextAt,
        etaSource: 'replanted',
        etaBeyond: plot.nextAt > FOREVER_SEC,
        missingExp: 0,
      };
    }
    plot.nextAt += plot.periodSec;
    if (plot.nextAt > FOREVER_SEC) {
      break;
    }
  }

  return {
    ...result,
    etaSource: 'insufficient',
    etaBeyond: true,
    missingExp: Math.max(0, remainingExp - total),
  };
}

module.exports = {
  SNAPSHOT_STALE_SEC,
  FOREVER_SEC,
  STRATEGY_RANKINGS,
  buildLandSnapshot,
  publishLandSnapshot,
  getLandSnapshot,
  resolveExpectedCrop,
  buildExpForecast,
  __resetForTest() {
    snapshot = null;
    __resetExpectedCropCache();
  },
};
