/**
 * 经验效率（在线活跃滑动窗口）与升级预估测试
 *
 * 覆盖：稳态斜率、离线空洞剔除、worker 重启后从样本恢复、经验倒退与等级回退、
 * 采样去重与窗口裁剪、样本不足降级、ETA 的正常/零速率/超 30 天/满级分支。
 * 全部使用固定时钟与内存夹具，不连真实服务端。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createExpRateTracker,
  pruneSamples,
  EXP_SAMPLE_MAX,
  EXP_SAMPLE_WINDOW_SEC,
  MAX_SAMPLE_GAP_SEC,
  RATE_WINDOW_SEC,
  ETA_MAX_SEC,
  recordExpSample,
  getExpRate,
  __resetForTest,
} = require('../src/services/exp-rate');

const MINUTE_MS = 60 * 1000;
const START_MS = 1_700_000_000_000;

function buildTracker() {
  const state = { now: START_MS };
  const tracker = createExpRateTracker({ now: () => state.now });
  return {
    tracker,
    state,
    advance(ms) { state.now += ms; },
  };
}

test('稳态：在线 30 分钟的经验增量换算为每小时速率', () => {
  const { tracker, state } = buildTracker();
  let exp = 0;
  tracker.record({ exp, level: 10, online: true });
  for (let index = 1; index <= 6; index += 1) {
    state.now += 5 * MINUTE_MS;
    exp += 300;
    tracker.record({ exp, level: 10, online: true });
  }

  const result = tracker.compute({ online: true, remainingExp: 3600 });
  assert.equal(result.ready, true);
  assert.equal(result.activeSeconds, 1800);
  assert.equal(result.sampleCount, 7);
  assert.equal(result.windowSeconds, RATE_WINDOW_SEC);
  assert.equal(result.source, 'window');
  assert.equal(result.confidence, 'medium');
  // 1800 经验 / 0.5 小时
  assert.equal(result.expPerHour, 3600);
  // 还差 3600 经验，按 3600/小时 → 1 小时
  assert.equal(result.etaSeconds, 3600);
  assert.equal(result.etaBeyond, false);
});

test('离线空洞不计入有效观测时长', () => {
  const { tracker, state } = buildTracker();
  let exp = 0;
  tracker.record({ exp, level: 5, online: true });
  for (let index = 0; index < 4; index += 1) {
    if (index === 2) {
      // 第 3 个采样点前离线 1 小时：这段空洞必须被剔除
      state.now += 60 * MINUTE_MS;
      tracker.record({ exp, level: 5, online: false });
      state.now += 1000;
    } else {
      state.now += 5 * MINUTE_MS;
    }
    exp += 100;
    tracker.record({ exp, level: 5, online: true });
  }

  const result = tracker.compute({ online: true });
  assert.equal(result.ready, true);
  // 有效区间只有 3 段 × 300 秒：跨离线空洞的两个样本对都不计入
  assert.equal(result.activeSeconds, 900);
  // 300 经验 / (900/3600) 小时
  assert.equal(result.expPerHour, 1200);
});

test('worker 重启后从持久化样本恢复，速率不归零', () => {
  const { tracker, state } = buildTracker();
  let exp = 0;
  tracker.record({ exp, level: 20, online: true });
  for (let index = 1; index <= 6; index += 1) {
    state.now += 5 * MINUTE_MS;
    exp += 600;
    tracker.record({ exp, level: 20, online: true });
  }

  const persisted = tracker.getSamples();
  assert.equal(persisted.length, 7);

  const restarted = createExpRateTracker({ now: () => state.now });
  const restored = restarted.init('account-1', persisted);
  assert.equal(restored, 7);

  const after = restarted.compute({ online: true });
  assert.equal(after.ready, true);
  assert.equal(after.activeSeconds, 1800);
  assert.equal(after.expPerHour, 7200);
  assert.equal(after.accountId, 'account-1');
});

test('经验倒退（服务端修正）的样本对被丢弃，不产生负速率', () => {
  const { tracker, state } = buildTracker();
  const sequence = [0, 1000, 500, 1500, 2500];
  tracker.record({ exp: sequence[0], level: 7, online: true });
  for (let index = 1; index < sequence.length; index += 1) {
    state.now += 5 * MINUTE_MS;
    tracker.record({ exp: sequence[index], level: 7, online: true });
  }

  const result = tracker.compute({ online: true });
  assert.equal(result.ready, true);
  // 3000 经验 / 900 秒（1000→500 的倒退对不计入）
  assert.equal(result.activeSeconds, 900);
  assert.equal(result.expPerHour, 12000);
  assert.ok(result.expPerHour > 0);
});

test('升级不打断统计，等级回退的样本对被丢弃', () => {
  const { tracker, state } = buildTracker();
  tracker.record({ exp: 0, level: 10, online: true });
  state.now += 5 * MINUTE_MS;
  tracker.record({ exp: 500, level: 10, online: true });
  state.now += 5 * MINUTE_MS;
  // 升级：等级 +1，经验继续累计
  tracker.record({ exp: 1000, level: 11, online: true });
  state.now += 5 * MINUTE_MS;
  tracker.record({ exp: 1500, level: 11, online: true });

  const upgraded = tracker.compute({ online: true });
  assert.equal(upgraded.ready, true);
  assert.equal(upgraded.activeSeconds, 900);
  assert.equal(upgraded.expPerHour, 6000);

  // 等级回退（异常样本）不应被计入
  const other = buildTracker();
  const fallbackSequence = [
    [0, 11], [100, 11], [200, 10], [300, 10], [400, 10],
  ];
  other.tracker.record({ exp: fallbackSequence[0][0], level: fallbackSequence[0][1], online: true });
  for (let index = 1; index < fallbackSequence.length; index += 1) {
    other.state.now += 5 * MINUTE_MS;
    other.tracker.record({
      exp: fallbackSequence[index][0],
      level: fallbackSequence[index][1],
      online: true,
    });
  }
  const fallback = other.tracker.compute({ online: true });
  // 300 经验 / 900 秒（等级 11→10 的样本对被丢弃）
  assert.equal(fallback.activeSeconds, 900);
  assert.equal(fallback.expPerHour, 1200);
});

test('样本不足时降级为「正在积累」，不给数字也不给 ETA', () => {
  const { tracker } = buildTracker();
  tracker.record({ exp: 0, level: 3, online: true });
  const result = tracker.compute({ online: true, remainingExp: 100 });

  assert.equal(result.ready, false);
  assert.equal(result.expPerHour, null);
  assert.equal(result.confidence, 'insufficient');
  assert.equal(result.etaSeconds, null);
  assert.equal(result.etaBeyond, false);
});

test('ETA：零速率、剩余经验为 0、超 30 天与满级分支', () => {
  const { tracker, state } = buildTracker();
  tracker.record({ exp: 100, level: 4, online: true });
  for (let index = 0; index < 3; index += 1) {
    state.now += 5 * MINUTE_MS;
    // 在线但经验没有增长
    tracker.record({ exp: 100, level: 4, online: true });
  }

  const idle = tracker.compute({ online: true, remainingExp: 1000 });
  assert.equal(idle.ready, true);
  assert.equal(idle.expPerHour, 0);
  assert.equal(idle.etaSeconds, null);

  const gained = buildTracker();
  let exp = 0;
  gained.tracker.record({ exp, level: 4, online: true });
  for (let index = 0; index < 3; index += 1) {
    gained.state.now += 5 * MINUTE_MS;
    exp += 3600;
    gained.tracker.record({ exp, level: 4, online: true });
  }

  const noNeed = gained.tracker.compute({ online: true, remainingExp: 0 });
  assert.equal(noNeed.etaSeconds, null);

  const far = gained.tracker.compute({ online: true, remainingExp: 43200 * 24 * 40 });
  assert.ok(far.etaSeconds > ETA_MAX_SEC);
  assert.equal(far.etaBeyond, true);

  const maxed = gained.tracker.compute({ online: true, remainingExp: 3600, levelMaxed: true });
  assert.equal(maxed.etaSeconds, null);
  assert.equal(maxed.etaBeyond, false);
});

test('离线时不输出效率对象', () => {
  const { tracker } = buildTracker();
  tracker.record({ exp: 0, level: 1, online: true });
  assert.equal(tracker.compute({ online: false }), null);
});

test('同一采样点重复写入被去重，间隔足够则照常记录', () => {
  const { tracker, state } = buildTracker();
  tracker.record({ exp: 0, level: 1, online: true });
  state.now += 500;
  assert.equal(tracker.record({ exp: 0, level: 1, online: true }), false);
  assert.equal(tracker.getSamples().length, 1);

  state.now += 10 * 1000;
  assert.equal(tracker.record({ exp: 0, level: 1, online: true }), true);
  assert.equal(tracker.getSamples().length, 2);
});

test('样本按时间窗口裁剪，历史采样点抽稀但不破坏可计算性', () => {
  const now = START_MS;
  const samples = [
    { t: now - (EXP_SAMPLE_WINDOW_SEC + 60) * 1000, exp: 0, level: 1, online: true },
    { t: now - 60 * 1000, exp: 10, level: 1, online: true },
    { t: now, exp: 20, level: 1, online: true },
  ];
  assert.equal(pruneSamples(samples, now).length, 2);

  // 1 秒一个采样点、共约 18 分钟：抽稀后条数显著下降
  const many = [];
  const count = 1080;
  for (let index = 0; index < count; index += 1) {
    many.push({ t: now - (count - index) * 1000, exp: index, level: 1, online: true });
  }
  const compacted = pruneSamples(many, now);
  assert.ok(compacted.length < count, '历史采样点应被抽稀');
  assert.ok(compacted.length <= EXP_SAMPLE_MAX);
  // 最近的采样点必须保留，且相邻间隔仍在有效区间上限内
  assert.equal(compacted[compacted.length - 1].t, now - 1000);
  for (let index = 1; index < compacted.length; index += 1) {
    const gap = compacted[index].t - compacted[index - 1].t;
    assert.ok(gap > 0 && gap <= MAX_SAMPLE_GAP_SEC * 1000, `抽稀后间隔 ${gap}ms 超出有效上限`);
  }

  // 离线样本必须保留，否则会把离线空洞并进有效观测区间
  const withOffline = [
    { t: now - 40 * 60 * 1000, exp: 0, level: 1, online: true },
    { t: now - 39 * 60 * 1000, exp: 0, level: 1, online: false },
    { t: now - 2 * 60 * 1000, exp: 0, level: 1, online: true },
    { t: now, exp: 0, level: 1, online: true },
  ];
  const keptOffline = pruneSamples(withOffline, now);
  assert.ok(keptOffline.some(sample => sample.online === false), '离线样本不能被抽稀掉');

  const tracker = createExpRateTracker({ now: () => now });
  tracker.setSamples(many);
  assert.ok(tracker.getSamples().length < count);
  assert.equal(tracker.getSamples()[tracker.getSamples().length - 1].exp, count - 1);
});

test('默认跟踪器导出的便捷入口可用', () => {
  __resetForTest();
  assert.equal(recordExpSample({ exp: 100, level: 2, online: true }), true);
  assert.equal(getExpRate({ online: false }), null);
  const result = getExpRate({ online: true, remainingExp: 50 });
  assert.equal(result.ready, false);
  __resetForTest();
});

test('stats 快照携带 expRate 与剩余经验，离线时为 null', () => {
  // 隔离数据目录，避免污染仓库 data/
  process.env.FARM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-exp-rate-'));
  const stats = require('../src/services/stats');

  stats.initStatsWithPersistence('account-integration', 0, 0, 0);
  const status = stats.getStats(
    { level: 10, exp: 0 },
    { gold: 0, exp: 0, level: 10 },
    true,
    {},
    { levelProgress: { current: 10, needed: 100, maxed: false } },
  );

  assert.ok(status.expRate, '在线账号必须携带 expRate');
  assert.equal(status.expRate.remainingExp, 90);
  assert.equal(status.expRate.ready, false, '刚启动时样本不足，应降级而不是给 0');
  assert.equal(status.expRate.etaSeconds, null);
  // 旧的会话字段保留，不受影响
  assert.equal(status.sessionExpGained, 0);

  const offline = stats.getStats({ level: 10, exp: 0 }, { gold: 0, exp: 0, level: 10 }, false, {});
  assert.equal(offline.expRate, null);

  __resetForTest();
});
