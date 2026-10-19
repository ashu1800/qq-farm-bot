const { sendMsgAsync } = require('../utils/network');
const { isTransientNetworkError } = require('../utils/network-errors');
const { types } = require('../utils/proto');
const { PlantPhase } = require('../config/config');
const { toNum, toTimeSec, getServerTimeSec, log, logWarn, randomDelay } = require('../utils/utils');
const { getAutomation } = require('../models/store');
const { recordOperation } = require('./stats');
const { getAllLands, fertilize, NORMAL_FERTILIZER_ID, ORGANIC_FERTILIZER_ID } = require('./farm-api');
const { getCurrentPhase } = require('./farm-land-analyzer');
const { recordFertilizerObservation } = require('./plant-model');

// ─── 常量 ───

/** 全部可施肥土地类型 */
const ALL_FERTILIZER_LAND_TYPES = ['purple', 'gold', 'black', 'red', 'normal'];

/** 土地类型中文标签 */
const FERTILIZER_LAND_TYPE_LABELS = {
  purple: '紫土地',
  gold: '金土地',
  black: '黑土地',
  red: '红土地',
  normal: '普通土地'
};

// ─── 辅助函数 ───

/** 从原始地块数据推导剩余成熟秒数（无法推导时返回 null） */
function getRemainingMatureSec(land) {
  const plant = land && land.plant;
  const phases = Array.isArray(plant && plant.phases) ? plant.phases : [];
  const maturePhase = phases.find(phase => toNum(phase && phase.phase) === 6);
  const matureAt = toTimeSec(maturePhase && maturePhase.begin_time);
  if (matureAt <= 0) return null;
  return Math.max(0, matureAt - getServerTimeSec());
}

/** 构建「地块 ID → 施肥前剩余成熟秒数」映射 */
function buildRemainingMatureMap(lands) {
  const map = new Map();
  for (const land of (Array.isArray(lands) ? lands : [])) {
    const landId = toNum(land && land.id);
    if (!landId) continue;
    const remain = getRemainingMatureSec(land);
    if (Number.isFinite(remain)) map.set(landId, remain);
  }
  return map;
}

/** 记录一条化肥减秒样本，并在与容器消耗不一致时打一条受样本节流约束的 warn */
function applyFertilizerReduction({ type, reduceSec, consumedSec, landId }) {
  if (!reduceSec || reduceSec <= 0) return;
  const result = recordFertilizerObservation(type, reduceSec);
  if (result.recorded && consumedSec > 0 && Math.abs(reduceSec - consumedSec) / consumedSec > 0.1) {
    logWarn('施肥', `化肥减秒与消耗秒数不一致：地块实际减少 ${reduceSec}s，容器消耗 ${consumedSec}s`, {
      module: 'farm', event: '化肥减秒校准', result: 'warn',
      landId: toNum(landId), type, reduceSec, consumedSec
    });
  }
}

/** 由「剩余成熟时间差值」与「容器消耗秒数」推导本次减秒 */
function resolveReduceSec(before, after, consumedSec) {
  if (Number.isFinite(before) && Number.isFinite(after)) return Math.max(0, before - after);
  return consumedSec > 0 ? consumedSec : 0;
}

/**
 * 解析一次施肥回复，记录化肥减秒实测样本
 *
 * 减秒优先取「施肥前后剩余成熟时间的差值」（真实效果），缺地块数据时退回
 * `FertilizeReply.fertilizer_use.consumed`（本次消耗的肥料秒数）。
 */
function collectFertilizerReduction({ body, landId, fertilizerId, beforeMap }) {
  try {
    const reply = types.FertilizeReply.decode(body);
    const consumedSec = Math.max(0, toNum(reply && reply.fertilizer_use && reply.fertilizer_use.consumed && reply.fertilizer_use.consumed.count));
    const afterLands = (reply && reply.land) || [];
    const after = getRemainingMatureSec(afterLands.length > 0 ? afterLands[0] : null);
    const before = beforeMap && beforeMap instanceof Map ? beforeMap.get(toNum(landId)) : null;
    const type = toNum(fertilizerId) === toNum(ORGANIC_FERTILIZER_ID) ? 'organic' : 'normal';
    applyFertilizerReduction({ type, reduceSec: resolveReduceSec(before, after, consumedSec), consumedSec, landId });
  } catch { }
}

/** 处理 farm-api.fertilize 返回的减秒明细（已解码，含施肥后的地块） */
function recordFertilizeResult(result, beforeMap) {
  const reductions = (result && result.reductions) || [];
  for (const item of reductions) {
    try {
      const after = getRemainingMatureSec(item.lands && item.lands[0]);
      const before = beforeMap && beforeMap instanceof Map ? beforeMap.get(toNum(item.landId)) : null;
      const type = toNum(item.fertilizerId) === toNum(ORGANIC_FERTILIZER_ID) ? 'organic' : 'normal';
      applyFertilizerReduction({
        type,
        reduceSec: resolveReduceSec(before, after, toNum(item.consumedSec)),
        consumedSec: toNum(item.consumedSec),
        landId: item.landId
      });
    } catch { }
  }
}

/**
 * 有机化肥循环施肥（逐块施肥直到失败）
 * @param {number[]} landIds - 地块 ID 列表
 * @param {Map<number, number>} [beforeMap] - 施肥前各地块剩余成熟秒数，用于化肥减秒实测
 * @returns {number} 成功施肥次数
 */
async function fertilizeOrganicLoop(landIds, beforeMap = null) {
  const ids = (Array.isArray(landIds) ? landIds : []).filter(Boolean);
  if (ids.length === 0) return 0;

  let successCount = 0;
  let index = 0;
  while (true) {
    const landId = ids[index];
    try {
      const payload = types.FertilizeRequest.encode(types.FertilizeRequest.create({
        land_ids: [toNum(landId)],
        fertilizer_id: toNum(ORGANIC_FERTILIZER_ID)
      })).finish();
      const { body } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', payload);
      successCount++;
      collectFertilizerReduction({ body, landId, fertilizerId: ORGANIC_FERTILIZER_ID, beforeMap });
    } catch {
      break;
    }
    index = (index + 1) % ids.length;
    await randomDelay(200, 300);
  }
  return successCount;
}

/**
 * 从地块列表获取可施有机肥的目标
 * @param {Array} lands - 地块数据列表
 * @returns {number[]} 可施有机肥的地块 ID
 */
function getOrganicFertilizerTargetsFromLands(lands) {
  const list = Array.isArray(lands) ? lands : [];
  const targets = [];
  for (const land of list) {
    if (!land || !land.unlocked) continue;
    const landId = toNum(land.id);
    if (!landId) continue;

    const plant = land.plant;
    if (!plant || !plant.phases || plant.phases.length === 0) continue;

    const currentPhase = getCurrentPhase(plant.phases, false, '', plant.id);
    if (!currentPhase) continue;
    if (currentPhase.phase === PlantPhase.DEAD) continue;

    // 检查剩余有机肥次数
    if (Object.hasOwn(plant, 'left_inorc_fert_times')) {
      const remaining = toNum(plant.left_inorc_fert_times);
      if (remaining <= 0) continue;
    }
    targets.push(landId);
  }
  return targets;
}

/**
 * 获取即将成熟的地块（用于智能施肥）
 * @param {Array} lands - 地块数据
 * @param {number} thresholdSec - 距成熟时间阈值（秒），默认 3600（1小时）
 */
function getFastMatureLands(lands, thresholdSec = 3600) {
  const list = Array.isArray(lands) ? lands : [];
  const result = [];
  const serverTime = getServerTimeSec();
  const threshold = Math.max(0, toNum(thresholdSec) || 3600);

  for (const land of list) {
    if (!land || !land.unlocked) continue;
    const landId = toNum(land.id);
    if (!landId) continue;

    const plant = land.plant;
    if (!plant || !plant.phases || plant.phases.length === 0) continue;

    const currentPhase = getCurrentPhase(plant.phases, false, '', plant.id);
    if (!currentPhase) continue;
    if (currentPhase.phase === PlantPhase.DEAD) continue;
    if (currentPhase.phase === PlantPhase.MATURE) continue;

    // 查找成熟阶段
    const maturePhase = plant.phases
      .filter(p => p && toTimeSec(p.begin_time) > 0)
      .sort((left, right) => toTimeSec(right.begin_time) - toTimeSec(left.begin_time))[0];
    if (!maturePhase) continue;

    const matureTime = toTimeSec(maturePhase.begin_time);
    if (matureTime <= 0) continue;

    const remaining = matureTime - serverTime;
    if (remaining <= threshold && remaining >= 0) {
      // 检查剩余有机肥次数
      if (Object.hasOwn(plant, 'left_inorc_fert_times')) {
        const left = toNum(plant.left_inorc_fert_times);
        if (left <= 0) continue;
      }
      result.push(landId);
    }
  }
  return result;
}

/**
 * 获取处于成熟前最后一个生长阶段的地块（用于最终阶段施肥）
 * @param {Array} lands - 地块数据
 * @param {object} options - { organicOnly }
 * @returns {number[]} 最终阶段地块 ID
 */
function getFinalStageLands(lands, options = {}) {
  const list = Array.isArray(lands) ? lands : [];
  const result = [];
  const organicOnly = !!options.organicOnly;

  for (const land of list) {
    if (!land || !land.unlocked) continue;
    const landId = toNum(land.id);
    if (!landId) continue;

    const plant = land.plant;
    if (!plant || !Array.isArray(plant.phases) || plant.phases.length === 0) continue;

    const currentPhase = getCurrentPhase(plant.phases, false, '', plant.id);
    if (!currentPhase) continue;

    const currentPhaseValue = toNum(currentPhase.phase);
    if (currentPhaseValue === PlantPhase.DEAD) continue;
    if (currentPhaseValue === PlantPhase.MATURE) continue;

    const orderedPhases = plant.phases
      .map((phase, index) => ({
        phase,
        index,
        beginTime: toTimeSec(phase && phase.begin_time)
      }))
      .filter(item => item.beginTime > 0)
      .sort((a, b) => (a.beginTime - b.beginTime) || (a.index - b.index));

    const matureIndex = orderedPhases.findIndex(item => toNum(item.phase && item.phase.phase) === PlantPhase.MATURE);
    if (matureIndex <= 0) continue;

    const currentIndex = orderedPhases.findIndex(item => item.phase === currentPhase);
    if (currentIndex !== matureIndex - 1) continue;

    if (organicOnly && Object.hasOwn(plant, 'left_inorc_fert_times')) {
      const left = toNum(plant.left_inorc_fert_times);
      if (left <= 0) continue;
    }

    result.push(landId);
  }

  return result;
}

/** 根据等级获取土地类型 */
function getLandTypeByLevel(level) {
  const lv = toNum(level);
  if (lv === 5) return 'purple';   // 紫土地
  if (lv === 4) return 'gold';     // 金土地
  if (lv === 3) return 'black';    // 黑土地
  if (lv === 2) return 'red';      // 红土地
  return 'normal';
}

/** 标准化施肥土地类型列表 */
function normalizeFertilizerLandTypes(types) {
  const input = Array.isArray(types) ? types : ALL_FERTILIZER_LAND_TYPES;
  const result = [];
  for (const t of input) {
    const normalized = String(t || '').trim().toLowerCase();
    if (!ALL_FERTILIZER_LAND_TYPES.includes(normalized)) continue;
    if (result.includes(normalized)) continue;
    result.push(normalized);
  }
  return result;
}

/** 按土地类型过滤地块 ID */
function filterLandIdsByTypes(landIds, landTypeMap, allowedTypes) {
  const ids = Array.isArray(landIds) ? landIds : [];
  const typeSet = new Set(normalizeFertilizerLandTypes(allowedTypes));
  if (typeSet.size === 0) return [];
  if (typeSet.size === ALL_FERTILIZER_LAND_TYPES.length) return [...ids];

  const result = [];
  for (const landId of ids) {
    const landType = String(landTypeMap.get(landId) || '');
    if (!landType) continue;
    if (typeSet.has(landType)) result.push(landId);
  }
  return result;
}

/** 格式化土地类型为中文标签 */
function formatFertilizerLandTypes(types) {
  return normalizeFertilizerLandTypes(types).map(t => FERTILIZER_LAND_TYPE_LABELS[t] || t);
}

// ─── 核心施肥逻辑 ───

/**
 * 根据配置执行施肥
 * @param {number[]} explicitLandIds - 指定地块 ID（空数组则自动获取）
 * @param {object} options - { reason, skipNormal }
 * @returns {{ normal: number, organic: number }}
 */
async function runFertilizerByConfig(explicitLandIds = [], options = {}) {
  const automation = getAutomation() || {};
  const mode = automation.fertilizer || 'none';
  const reason = String(options.reason || '').trim().toLowerCase() === 'multi_season' ? 'multi_season' : 'normal';
  const label = reason === 'multi_season' ? '多季补肥' : '常规施肥';
  const eventLabel = reason === 'multi_season' ? '多季节施肥' : '常规施肥';
  const landTypes = normalizeFertilizerLandTypes(automation.fertilizer_land_types);
  const landTypeLabels = formatFertilizerLandTypes(landTypes);

  if (reason === 'multi_season' && mode === 'final_normal') {
    log('施肥', '多季补肥：当前策略为最终阶段普通肥，跳过本轮多季补肥', {
      module: 'farm', event: eventLabel, result: 'skip', reason, type: 'normal'
    });
    return { normal: 0, organic: 0 };
  }

  const explicitIds = [...new Set(
    (Array.isArray(explicitLandIds) ? explicitLandIds : [])
      .map(id => toNum(id))
      .filter(Boolean)
  )];

  // 没有选中土地类型 → 跳过
  if (landTypes.length === 0) {
    log('施肥', `${label}：未勾选施肥范围，跳过本轮施肥`, {
      module: 'farm', event: eventLabel, result: 'skip', reason, scope: 'none'
    });
    return { normal: 0, organic: 0 };
  }

  const { skipNormal = false } = options;

  // 没有指定地块且非有机模式 → 空返回
  if (explicitIds.length === 0 &&
      mode !== 'organic' && mode !== 'both' &&
      mode !== 'smart' && mode !== 'smart_only' && mode !== 'smart_normal' &&
      mode !== 'final_normal' && mode !== 'final_organic') {
    return { normal: 0, organic: 0 };
  }

  // 获取全农场土地信息构建类型映射
  let allLands = [];
  const landTypeMap = new Map();
  try {
    const landsReply = await getAllLands();
    allLands = Array.isArray(landsReply && landsReply.lands) ? landsReply.lands : [];
    for (const land of allLands) {
      if (!land) continue;
      const landId = toNum(land.id);
      if (!landId) continue;
      landTypeMap.set(landId, getLandTypeByLevel(land.level));
    }
  } catch (err) {
    if (!isTransientNetworkError(err)) {
      logWarn('施肥', `${label}：获取土地信息失败，按已知地块继续: ${err.message}`, {
        module: 'farm', event: eventLabel, result: 'error', reason
      });
    }
  }

  const isAllTypes = landTypes.length === ALL_FERTILIZER_LAND_TYPES.length;

  if (landTypeMap.size === 0 && !isAllTypes) {
    logWarn('施肥', `${label}：无法确认土地类型，已跳过本轮施肥`, {
      module: 'farm', event: eventLabel, result: 'skip', reason, landTypes
    });
    return { normal: 0, organic: 0 };
  }

  let targetIds = explicitIds;
  if (landTypeMap.size > 0) {
    targetIds = filterLandIdsByTypes(explicitIds, landTypeMap, landTypes);
  }

  let normalCount = 0;
  let organicCount = 0;

  // 普通化肥
  if (!skipNormal && (mode === 'normal' || mode === 'both' || mode === 'smart') && targetIds.length > 0) {
    const fertilizeResult = await fertilize(targetIds, NORMAL_FERTILIZER_ID);
    normalCount = fertilizeResult.count;
    recordFertilizeResult(fertilizeResult, buildRemainingMatureMap(allLands));
    if (normalCount > 0) {
      log('施肥', `${label}：已为 ${normalCount}/${targetIds.length} 块地施普通化肥（范围: ${landTypeLabels.join('、')}）`, {
        module: 'farm', event: eventLabel, result: 'ok', reason, type: 'normal',
        count: normalCount, landTypes
      });
      recordOperation('fertilize', normalCount);
    }
  }

  // 有机化肥
  if (mode === 'organic' || mode === 'both') {
    let organicTargets = explicitIds;
    if (allLands.length > 0) {
      organicTargets = getOrganicFertilizerTargetsFromLands(allLands);
    }
    if (landTypeMap.size > 0) {
      organicTargets = filterLandIdsByTypes(organicTargets, landTypeMap, landTypes);
    }
    organicCount = await fertilizeOrganicLoop(organicTargets, buildRemainingMatureMap(allLands));
    if (organicCount > 0) {
      log('施肥', `${label}：有机化肥循环施肥完成，共施 ${organicCount} 次（范围: ${landTypeLabels.join('、')}）`, {
        module: 'farm', event: eventLabel, result: 'ok', reason, type: 'organic',
        count: organicCount, landTypes
      });
      recordOperation('fertilize', organicCount);
    }
  } else if (mode === 'smart' || mode === 'smart_only' || mode === 'smart_normal' ||
      mode === 'final_normal' || mode === 'final_organic') {
    // 智能/最终阶段施肥：寻找目标作物施肥
    let targetFertilizerLands = [];
    // 用于化肥减秒实测的「施肥前」地块快照
    let calibrationLands = allLands;
    const isFinalStageMode = mode === 'final_normal' || mode === 'final_organic';
    const explicitIdSet = new Set(explicitIds);

    if (isFinalStageMode) {
      targetFertilizerLands = getFinalStageLands(allLands, { organicOnly: mode === 'final_organic' });
      if (explicitIdSet.size > 0) {
        targetFertilizerLands = targetFertilizerLands.filter(id => explicitIdSet.has(id));
      }
    } else {
      const smartSeconds = toNum(automation.fertilizer_smart_seconds) || 3600;

      try {
        const landsReply = await getAllLands();
        calibrationLands = (landsReply && landsReply.lands) || allLands;
        targetFertilizerLands = getFastMatureLands(landsReply && landsReply.lands, smartSeconds);
      } catch (err) {
        if (!isTransientNetworkError(err)) {
          logWarn('施肥', `获取全农场地块失败: ${err.message}`);
        }
      }
    }

    if (landTypeMap.size > 0) {
      targetFertilizerLands = filterLandIdsByTypes(targetFertilizerLands, landTypeMap, landTypes);
    }

    if (targetFertilizerLands.length > 0) {
      const useOrganic = mode === 'smart' || mode === 'smart_only' || mode === 'final_organic';
      const typeLabel = useOrganic ? '有机' : '普通';
      const fertId = useOrganic ? ORGANIC_FERTILIZER_ID : NORMAL_FERTILIZER_ID;
      const modeLabel = isFinalStageMode ? '最终阶段' : '快成熟';
      const beforeMap = buildRemainingMatureMap(calibrationLands);

      if (useOrganic) {
        organicCount = await fertilizeOrganicLoop(targetFertilizerLands, beforeMap);
      } else {
        const fertilizeResult = await fertilize(targetFertilizerLands, fertId);
        normalCount = fertilizeResult.count;
        recordFertilizeResult(fertilizeResult, beforeMap);
      }

      const totalCount = useOrganic ? organicCount : normalCount;
      if (totalCount > 0) {
        log('施肥', `${typeLabel}化肥${modeLabel}施肥完成，共施 ${totalCount} 次（范围: ${landTypeLabels.join('、')}）`, {
          module: 'farm', event: '施肥', result: 'ok',
          type: useOrganic ? 'organic' : 'normal', count: totalCount
        });
        recordOperation('fertilize', totalCount);
      }
    }
  }

  return { normal: normalCount, organic: organicCount };
}

module.exports = {
  ALL_FERTILIZER_LAND_TYPES,
  FERTILIZER_LAND_TYPE_LABELS,
  runFertilizerByConfig
};
