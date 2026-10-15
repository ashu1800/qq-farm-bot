/**
 * 经验效率（在线活跃滑动窗口）与升级预估
 *
 * 为什么要重做：历史实现在前端用 `sessionExpGained / process.uptime()` 计算「效率」，
 * 分母是进程运行时长而不是经验累积时长，且不剔除离线时段，worker 重启即归零，
 * 导致重启、重登、长期挂机后数字完全失真。
 *
 * 现在的口径：
 * - 采样：经验每次变化（BasicNotify）以及每次状态同步（默认 10 秒）各记一条样本。
 * - 有效区间：相邻样本两端都在线、间隔不超过 MAX_SAMPLE_GAP_SEC、经验不倒退。
 * - 速率：ΣΔexp / ΣΔt，按有效观测时长加权，先看最近 1 小时，样本不足时放宽到 6 小时。
 * - ETA：本级剩余经验 / 速率；满级或样本不足时不输出数字。
 *
 * 样本随 `data/stats/<accountId>.json` 持久化，worker 重启后效率不会归零。
 */

/** 样本保留窗口（6 小时） */
const EXP_SAMPLE_WINDOW_SEC = 6 * 3600;
/** 样本条数上限 */
const EXP_SAMPLE_MAX = 1024;
/** 抽稀时最近这段时间保留全部采样点 */
const COMPACT_RECENT_SEC = 300;
/** 更早的采样点每这么多秒保留一个（抽稀后相邻间隔仍远小于 MAX_SAMPLE_GAP_SEC） */
const COMPACT_INTERVAL_SEC = 120;
/** 首选统计窗口：最近 1 小时 */
const RATE_WINDOW_SEC = 3600;
/** 有效区间允许的最大采样间隔，超过视为离线/停机空洞 */
const MAX_SAMPLE_GAP_SEC = 300;
/** 判定「可以给出数字」所需的最少有效观测时长 */
const MIN_ACTIVE_SEC = 600;
/** 判定「可以给出数字」所需的最少有效样本对 */
const MIN_PAIRS = 3;
/** 超过该时长的升级预估直接标记为「超过 30 天」 */
const ETA_MAX_SEC = 30 * 24 * 3600;
/** 同一采样点重复写入的最小间隔 */
const DEDUPE_INTERVAL_MS = 1000;

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeSample(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = toFiniteNumber(raw.t);
  const exp = toFiniteNumber(raw.exp);
  const level = toFiniteNumber(raw.level);
  if (t === null || exp === null || level === null) return null;
  return { t: Math.round(t), exp, level, online: raw.online === true || raw.online === 1 };
}

/**
 * 抽稀历史采样点，避免样本数组与持久化文件无限增长
 *
 * 抽稀不改变 `ΣΔexp / ΣΔt`：丢掉一个中间采样点只是把相邻两段合并成一段，
 * 分子分母同时相加。离线样本（online=false）一律保留，避免把离线空洞并进有效区间。
 */
function compactSamples(samples, nowMs) {
  const recentFrom = nowMs - COMPACT_RECENT_SEC * 1000;
  const result = [];
  let previousKept = null;

  for (const sample of samples) {
    const keep = sample.t >= recentFrom
      || !sample.online
      || !previousKept
      || sample.t - previousKept.t >= COMPACT_INTERVAL_SEC * 1000;
    if (!keep) continue;
    result.push(sample);
    previousKept = sample;
  }

  return result;
}

/** 按时间保留窗口内、数量上限内的样本，并抽稀历史点 */
function pruneSamples(samples, nowMs) {
  const cutoff = nowMs - EXP_SAMPLE_WINDOW_SEC * 1000;
  const sorted = (Array.isArray(samples) ? samples : [])
    .map(normalizeSample)
    .filter(Boolean)
    .filter(sample => sample.t >= cutoff)
    .sort((left, right) => left.t - right.t);
  const capped = sorted.length > EXP_SAMPLE_MAX ? sorted.slice(sorted.length - EXP_SAMPLE_MAX) : sorted;
  return compactSamples(capped, nowMs);
}

/**
 * 计算窗口内的在线活跃速率（纯函数，便于测试）
 * @param {object[]} samples - 已按时间升序排列的样本
 * @param {number} windowSec - 统计窗口（秒）
 * @param {number} nowMs - 当前时间
 * @returns {{expPerHour: number, activeSeconds: number, pairCount: number, sampleCount: number}|null} 有效观测不足时返回 null
 */
function computeWindowRate(samples, windowSec, nowMs) {
  const from = nowMs - windowSec * 1000;
  const inWindow = samples.filter(sample => sample.t >= from);
  let activeMs = 0;
  let deltaExp = 0;
  let pairCount = 0;

  for (let index = 1; index < inWindow.length; index += 1) {
    const previous = inWindow[index - 1];
    const current = inWindow[index];
    if (!previous.online || !current.online) continue;
    const deltaMs = current.t - previous.t;
    if (deltaMs <= 0 || deltaMs > MAX_SAMPLE_GAP_SEC * 1000) continue;
    // 经验倒退（服务端修正、账号切换）与等级回退的样本对整体丢弃。
    if (current.exp < previous.exp) continue;
    if (current.level < previous.level) continue;
    activeMs += deltaMs;
    deltaExp += current.exp - previous.exp;
    pairCount += 1;
  }

  if (pairCount < MIN_PAIRS || activeMs < MIN_ACTIVE_SEC * 1000) return null;

  return {
    expPerHour: deltaExp / (activeMs / 3600000),
    activeSeconds: Math.round(activeMs / 1000),
    pairCount,
    sampleCount: inWindow.length,
  };
}

function resolveConfidence(activeSeconds, sampleCount) {
  if (activeSeconds >= 1800 && sampleCount >= 20) return 'high';
  if (activeSeconds >= 600) return 'medium';
  return 'low';
}

/**
 * 创建一个经验效率跟踪器
 * @param {object} [options]
 * @param {Function} [options.now] - 时间源，测试可注入固定时钟
 */
function createExpRateTracker(options = {}) {
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
  let accountId = '';
  let samples = [];

  /** 载入持久化样本（worker 启动时调用一次） */
  function init(id, persistedSamples = []) {
    accountId = String(id || '');
    samples = pruneSamples(persistedSamples, nowFn());
    return samples.length;
  }

  /** 记录一次经验观测 */
  function record({ exp, level, online, now } = {}) {
    const expValue = toFiniteNumber(exp);
    const levelValue = toFiniteNumber(level);
    if (expValue === null || expValue < 0) return false;
    const timestamp = Math.round(toFiniteNumber(now) ?? nowFn());
    const isOnline = online !== false;

    const last = samples.length > 0 ? samples[samples.length - 1] : null;
    if (last && last.exp === expValue && last.level === (levelValue ?? last.level)) {
      // 经验没变时，过密的重复观测没有信息量（采样间隔本身已覆盖空闲时长）。
      if (timestamp - last.t < DEDUPE_INTERVAL_MS) return false;
    }

    samples = pruneSamples(samples.concat([{
      t: timestamp,
      exp: expValue,
      level: levelValue ?? 0,
      online: isOnline,
    }]), timestamp);
    return true;
  }

  /**
   * 计算效率与升级预估
   * @param {object} [input]
   * @param {boolean} [input.online] - 账号当前是否在线；离线时返回 null
   * @param {number} [input.remainingExp] - 升到下一级所需剩余经验
   * @param {boolean} [input.levelMaxed] - 是否已满级
   * @param {number} [input.now] - 计算时刻（测试可注入）
   * @returns {object|null} 效率与 ETA 负载；离线返回 null
   */
  function compute({ online = true, remainingExp = 0, levelMaxed = false, now } = {}) {
    if (online === false) return null;
    const timestamp = Math.round(toFiniteNumber(now) ?? nowFn());
    const isMaxed = levelMaxed === true;
    const remaining = Math.max(0, Number(remainingExp) || 0);

    let stats = computeWindowRate(samples, RATE_WINDOW_SEC, timestamp);
    let source = 'window';
    let windowSeconds = RATE_WINDOW_SEC;
    if (!stats) {
      stats = computeWindowRate(samples, EXP_SAMPLE_WINDOW_SEC, timestamp);
      source = 'extended';
      windowSeconds = EXP_SAMPLE_WINDOW_SEC;
    }

    if (!stats) {
      return {
        ready: false,
        expPerHour: null,
        activeSeconds: 0,
        sampleCount: samples.length,
        windowSeconds,
        source,
        confidence: 'insufficient',
        remainingExp: remaining,
        etaSeconds: null,
        etaBeyond: false,
        updatedAt: timestamp,
        accountId,
      };
    }

    const expPerHour = Math.max(0, Number(stats.expPerHour) || 0);
    let etaSeconds = null;
    if (!isMaxed && remaining > 0 && expPerHour > 0) {
      etaSeconds = Math.round(remaining / (expPerHour / 3600));
    }

    return {
      // 有足够观测时长即可给出数字；速率为 0 也是有效结论（在线但没有经验增长）。
      ready: true,
      expPerHour: Math.round(expPerHour * 10) / 10,
      activeSeconds: stats.activeSeconds,
      sampleCount: stats.sampleCount,
      windowSeconds,
      source,
      confidence: resolveConfidence(stats.activeSeconds, stats.sampleCount),
      remainingExp: remaining,
      etaSeconds,
      etaBeyond: etaSeconds !== null && etaSeconds > ETA_MAX_SEC,
      updatedAt: timestamp,
      accountId,
    };
  }

  return {
    init,
    record,
    compute,
    getAccountId: () => accountId,
    getSamples: () => samples.slice(),
    setSamples: (next) => { samples = pruneSamples(next, nowFn()); },
    reset: () => { samples = []; accountId = ''; },
  };
}

/** 进程内默认跟踪器（每个 worker 进程/线程一个账号） */
const defaultTracker = createExpRateTracker();

module.exports = {
  EXP_SAMPLE_WINDOW_SEC,
  EXP_SAMPLE_MAX,
  COMPACT_RECENT_SEC,
  COMPACT_INTERVAL_SEC,
  RATE_WINDOW_SEC,
  MAX_SAMPLE_GAP_SEC,
  MIN_ACTIVE_SEC,
  MIN_PAIRS,
  ETA_MAX_SEC,
  createExpRateTracker,
  computeWindowRate,
  compactSamples,
  pruneSamples,
  initExpRate: defaultTracker.init,
  recordExpSample: defaultTracker.record,
  getExpRate: defaultTracker.compute,
  getExpSamples: defaultTracker.getSamples,
  __resetForTest: defaultTracker.reset,
};
