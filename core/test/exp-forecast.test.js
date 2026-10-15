/**
 * 经验产出预测（种植结构前瞻口径）测试
 *
 * 基准用例来自用户确认的公式：
 * - 10 块地 × 每块 1000 经验 ÷ 8 小时 → 效率 1250/小时
 * - 经验 0、升级需 1000、10 块地 8 小时后共收 2000 经验 → 升级预估 8 小时
 * 全部使用夹具与真实配置值，不连服务端、不发请求。
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  SNAPSHOT_STALE_SEC,
  buildLandSnapshot,
  publishLandSnapshot,
  getLandSnapshot,
  resolveExpectedCrop,
  buildExpForecast,
  __resetForTest,
} = require('../src/services/exp-forecast');

const HOUR = 3600;
const NOW_MS = 1_700_000_000_000;
const SERVER_SEC = Math.floor(NOW_MS / 1000);

/** 构造纯算法用的快照（绕过原始土地解析） */
function makeSnapshot(plots, { totalLands = plots.length, ageSec = 0 } = {}) {
  return {
    atMs: NOW_MS - ageSec * 1000,
    serverTimeSec: SERVER_SEC,
    lands: plots.map(plot => ({
      landId: plot.landId || 1,
      plantId: plot.plantId || 1,
      name: plot.name || '测试作物',
      expPerSeason: plot.expPerSeason,
      seasonDurationSec: plot.seasonDurationSec,
      seasonIndex: plot.seasonIndex || 1,
      totalSeasons: plot.totalSeasons || 1,
      remainingToHarvestSec: plot.remainingToHarvestSec,
    })),
    totalLands,
    plantedLands: plots.length,
  };
}

/** 构造原始土地（用于归一化测试）：白萝卜植物 ID 1020002，经验 1、整季 60 秒 */
const RADISH_PLANT_ID = 1020002;

function makeRawLand({
  landId = 1,
  plantId = RADISH_PLANT_ID,
  season = 1,
  coarsePhase = 2,
  remainingSec = 60,
  slaveLandIds = [],
} = {}) {
  return {
    id: landId,
    unlocked: true,
    slave_land_ids: slaveLandIds,
    plant: {
      id: plantId,
      season,
      phases: [
        { phase: coarsePhase, begin_time: SERVER_SEC + Math.max(0, remainingSec) },
      ],
    },
  };
}

test('效率：10 块地 × 1000 经验 ÷ 8 小时 = 1250/小时', () => {
  const snapshot = makeSnapshot(Array.from({ length: 10 }, (_, index) => ({
    landId: index + 1,
    expPerSeason: 1000,
    seasonDurationSec: 8 * HOUR,
    remainingToHarvestSec: 8 * HOUR,
  })));

  const forecast = buildExpForecast({ snapshot, remainingExp: 1000, nowMs: NOW_MS });
  assert.equal(forecast.ready, true);
  assert.equal(forecast.expPerHour, 1250);
  assert.equal(forecast.plantedLands, 10);
  assert.equal(forecast.totalLands, 10);
  assert.equal(forecast.nextHarvestInSec, 8 * HOUR);
  assert.equal(forecast.nextHarvestExp, 1000);
});

test('升级预估：第一次收获就够升级时，预估等于该收获时间', () => {
  const snapshot = makeSnapshot(Array.from({ length: 10 }, (_, index) => ({
    landId: index + 1,
    expPerSeason: 1000,
    seasonDurationSec: 8 * HOUR,
    remainingToHarvestSec: 8 * HOUR,
  })));

  // 10 块地共 2000 经验，升级需要 1000 → 8 小时后（第一次收获）即可升级
  const forecast = buildExpForecast({ snapshot, remainingExp: 1000, nowMs: NOW_MS });
  assert.equal(forecast.etaSeconds, 8 * HOUR);
  assert.equal(forecast.etaSource, 'planted');
  assert.equal(forecast.missingExp, 0);
  assert.equal(forecast.etaBeyond, false);
});

test('已成熟待收的地块按 t=0 计入，混合成熟时间按时间表累加', () => {
  const snapshot = makeSnapshot([
    { landId: 1, expPerSeason: 300, seasonDurationSec: 8 * HOUR, remainingToHarvestSec: 8 * HOUR },
    { landId: 2, expPerSeason: 200, seasonDurationSec: 5 * HOUR, remainingToHarvestSec: 5 * HOUR },
    { landId: 3, expPerSeason: 200, seasonDurationSec: 3 * HOUR, remainingToHarvestSec: 3 * HOUR },
    { landId: 4, expPerSeason: 100, seasonDurationSec: 3 * HOUR, remainingToHarvestSec: 0 },
  ]);

  // 时间表：t=0 → 100，t=3h → 300，t=5h → 500，t=8h → 800
  const forecast = buildExpForecast({ snapshot, remainingExp: 250, nowMs: NOW_MS });
  assert.equal(forecast.etaSeconds, 3 * HOUR);
  assert.equal(forecast.etaSource, 'planted');

  // 只差 50 时立即满足（已成熟地块的 t=0 事件）
  const immediate = buildExpForecast({ snapshot, remainingExp: 50, nowMs: NOW_MS });
  assert.equal(immediate.etaSeconds, 0);

  // 目标更高时继续等到下一个收获点
  assert.equal(buildExpForecast({ snapshot, remainingExp: 500, nowMs: NOW_MS }).etaSeconds, 5 * HOUR);
  assert.equal(buildExpForecast({ snapshot, remainingExp: 700, nowMs: NOW_MS }).etaSeconds, 8 * HOUR);
  // 一轮收完（800）仍不够时进入补种外推
  assert.equal(buildExpForecast({ snapshot, remainingExp: 900, nowMs: NOW_MS }).etaSource, 'replanted');
});

test('两季作物按整季节奏续排，不会把首季重复计数', () => {
  const snapshot = makeSnapshot([
    {
      landId: 1,
      expPerSeason: 500,
      seasonDurationSec: 4 * HOUR,
      remainingToHarvestSec: 4 * HOUR,
      seasonIndex: 1,
      totalSeasons: 2,
    },
  ]);

  // 首季 4h 收 500（不够 900），下一季 8h 再收 500 → 1000
  const forecast = buildExpForecast({ snapshot, remainingExp: 900, nowMs: NOW_MS });
  assert.equal(forecast.etaSeconds, 8 * HOUR);
  assert.equal(forecast.etaSource, 'replanted');
  assert.equal(forecast.expPerHour, 125); // 500 / 4h
});

test('一轮不够时按补种外推，并给出补种作物名', () => {
  const snapshot = makeSnapshot([
    { landId: 1, expPerSeason: 100, seasonDurationSec: 2 * HOUR, remainingToHarvestSec: 2 * HOUR },
  ]);

  const forecast = buildExpForecast({
    snapshot,
    remainingExp: 250,
    expectedCrop: { name: '蘑菇', expPerSeason: 50, seasonDurationSec: HOUR },
    nowMs: NOW_MS,
  });

  // 2h→100，4h→200，6h→300 ≥ 250
  assert.equal(forecast.etaSeconds, 6 * HOUR);
  assert.equal(forecast.etaSource, 'replanted');
  assert.equal(forecast.expectedCropName, '蘑菇');
});

test('自动巡田关闭时不外推，只报告缺口', () => {
  const snapshot = makeSnapshot([
    { landId: 1, expPerSeason: 100, seasonDurationSec: 2 * HOUR, remainingToHarvestSec: 2 * HOUR },
  ]);

  const forecast = buildExpForecast({ snapshot, remainingExp: 250, autoReplant: false, nowMs: NOW_MS });
  assert.equal(forecast.etaSeconds, null);
  assert.equal(forecast.etaSource, 'insufficient');
  assert.equal(forecast.missingExp, 150);
});

test('空地不摊薄效率，但给出补满后的参考值', () => {
  const snapshot = makeSnapshot(
    [{ landId: 1, expPerSeason: 800, seasonDurationSec: 8 * HOUR, remainingToHarvestSec: 8 * HOUR }],
    { totalLands: 10 },
  );

  const forecast = buildExpForecast({
    snapshot,
    remainingExp: 100,
    expectedCrop: { name: '小麦', expPerSeason: 800, seasonDurationSec: 8 * HOUR },
    nowMs: NOW_MS,
  });

  assert.equal(forecast.expPerHour, 100); // 只有已种的那块计入
  assert.equal(forecast.expPerHourWithReplant, 1000); // 10 块都种上后的稳定产出率
  assert.equal(forecast.plantedLands, 1);
  assert.equal(forecast.totalLands, 10);
});

test('快照过期时不给出 ETA，只标记 stale', () => {
  const snapshot = makeSnapshot(
    [{ landId: 1, expPerSeason: 1000, seasonDurationSec: HOUR, remainingToHarvestSec: HOUR }],
    { ageSec: SNAPSHOT_STALE_SEC + 60 },
  );

  const forecast = buildExpForecast({ snapshot, remainingExp: 100, nowMs: NOW_MS });
  assert.equal(forecast.stale, true);
  assert.equal(forecast.etaSeconds, null);
  assert.equal(forecast.etaSource, 'insufficient');
  assert.ok(forecast.snapshotAgeSec > SNAPSHOT_STALE_SEC);
  // 效率仍按最后一份土地数据给出
  assert.equal(forecast.expPerHour, 1000);
});

test('无快照、满级、剩余经验为 0 的分支', () => {
  const none = buildExpForecast({ snapshot: null, remainingExp: 500, nowMs: NOW_MS });
  assert.equal(none.ready, false);
  assert.equal(none.stale, true);
  assert.equal(none.etaSeconds, null);

  const snapshot = makeSnapshot([
    { landId: 1, expPerSeason: 1000, seasonDurationSec: HOUR, remainingToHarvestSec: HOUR },
  ]);
  const maxed = buildExpForecast({ snapshot, remainingExp: 0, levelMaxed: true, nowMs: NOW_MS });
  assert.equal(maxed.etaSource, 'maxed');
  assert.equal(maxed.etaSeconds, null);

  const zeroNeed = buildExpForecast({ snapshot, remainingExp: 0, nowMs: NOW_MS });
  assert.equal(zeroNeed.etaSource, 'none');
  assert.equal(zeroNeed.etaSeconds, null);
});

test('原始土地归一化：枯死与空置不产出，副地不计入分母', () => {
  const lands = [
    makeRawLand({ landId: 1, remainingSec: 60, slaveLandIds: [2] }), // 主地（2x2 主）
    makeRawLand({ landId: 2, remainingSec: 60 }), // 副地：被主地占用
    makeRawLand({ landId: 3, coarsePhase: 7, remainingSec: 0 }), // 枯死
    { id: 4, unlocked: true, plant: null }, // 空地
    makeRawLand({ landId: 5, coarsePhase: 6, remainingSec: 0 }), // 已成熟可收
  ];

  const snapshot = buildLandSnapshot(lands, { serverTimeSec: SERVER_SEC, nowMs: NOW_MS });
  assert.equal(snapshot.totalLands, 4); // 副地不计入分母
  assert.equal(snapshot.plantedLands, 2); // 主地 + 已成熟地块
  assert.deepEqual(snapshot.lands.map(plot => plot.landId).sort(), [1, 5]);
  assert.equal(snapshot.lands.find(plot => plot.landId === 5).remainingToHarvestSec, 0);

  const forecast = buildExpForecast({ snapshot, remainingExp: 1, nowMs: NOW_MS });
  assert.equal(forecast.expPerHour, 120); // 每块 1 经验 / 60 秒 × 2 块
});

test('发布与读取快照（巡田接线）', () => {
  __resetForTest();
  assert.equal(getLandSnapshot(), null);

  publishLandSnapshot([makeRawLand({ remainingSec: 30 })], { serverTimeSec: SERVER_SEC, nowMs: NOW_MS });
  const snapshot = getLandSnapshot();
  assert.equal(snapshot.totalLands, 1);
  assert.equal(snapshot.lands[0].remainingToHarvestSec, 30);
  __resetForTest();
  assert.equal(getLandSnapshot(), null);
});

test('期望补种作物可按种植策略解析并缓存', () => {
  __resetForTest();
  const crop = resolveExpectedCrop('max_exp');
  assert.ok(crop, '应能解析出期望补种作物');
  assert.ok(crop.expPerSeason > 0);
  assert.ok(crop.seasonDurationSec > 0);
  assert.ok(String(crop.name).length > 0);

  // 第二次命中缓存，返回同一对象
  assert.equal(resolveExpectedCrop('max_exp'), crop);

  // 未知策略回退经验最优，同样可用
  const fallback = resolveExpectedCrop('task_priority');
  assert.ok(fallback && fallback.expPerSeason > 0);
  __resetForTest();
});
