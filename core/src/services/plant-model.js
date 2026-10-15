/**
 * 植物模型校准存储
 *
 * 作物每季生长时长、化肥减秒都是**游戏常数**，与账号无关，因此存全局文件
 * `data/plant-model.json`，不做账号分区。
 *
 * 采样来源：
 * - 季时长：巡田时从地块阶段时间线推导（farm-land-analyzer），见 recordSeasonObservation。
 * - 化肥减秒：施肥成功后从 FertilizeReply 与地块前后剩余成熟时间推导，见 recordFertilizerObservation。
 *
 * 采样策略：每个 key 只保留最近 MAX_SAMPLES_PER_KEY 条观测待取中位数；稳定后不再写盘
 * （新样本与当前中位数偏差不超过 1% 时丢弃），避免巡田频率带来越写越大的文件。
 * 读取方在样本不足时必须回退到配置值或显式假定值，不允许猜测。
 */
const fs = require('node:fs');
const { getDataFile } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('./json-db');

const MODEL_VERSION = 1;
const MODEL_FILENAME = 'plant-model.json';

/** 季时长取中位数所需最少样本 */
const SEASON_MIN_SAMPLES = 2;
/** 化肥减秒取中位数所需最少样本 */
const FERTILIZER_MIN_SAMPLES = 3;
/** 每个 key 保留的观测条数上限 */
const MAX_SAMPLES_PER_KEY = 20;
/** 同一 key 两次观测的最小间隔 */
const RECORD_COOLDOWN_MS = 10 * 60 * 1000;
/** 新样本与当前中位数的相对偏差低于该比例时视为无信息量，不记录 */
const STABLE_DEVIATION_RATIO = 0.01;
/** 单条观测的合法区间（秒） */
const MIN_VALID_SECONDS = 1;
const MAX_VALID_SECONDS = 30 * 24 * 3600;
/** 写盘防抖 */
const FLUSH_DEBOUNCE_MS = 5000;

const FERTILIZER_TYPES = new Set(['normal', 'organic']);

const lastRecordAt = new Map();
let cache = null;
let flushTimer = null;
let pendingWrite = false;

function getModelFilePath() {
  return getDataFile(MODEL_FILENAME);
}

function createEmptyModel() {
  return { version: MODEL_VERSION, seasons: {}, fertilizer: {}, updatedAt: 0 };
}

function toValidSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < MIN_VALID_SECONDS || seconds > MAX_VALID_SECONDS) return 0;
  return Math.round(seconds);
}

function median(list) {
  const values = (Array.isArray(list) ? list : [])
    .map(item => Number(item))
    .filter(item => Number.isFinite(item))
    .sort((left, right) => left - right);
  if (values.length === 0) return 0;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1
    ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
}

/** 读取模型（带 mtime 缓存；文件被外部改写时自动重载） */
function load({ force = false } = {}) {
  const filePath = getModelFilePath();
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    mtimeMs = -1;
  }

  if (!force && cache && cache.mtimeMs === mtimeMs) return cache.data;

  const raw = mtimeMs === -1
    ? createEmptyModel()
    : readJsonFile(filePath, createEmptyModel);
  const data = raw && typeof raw === 'object' ? raw : createEmptyModel();
  if (data.version !== MODEL_VERSION) {
    // 版本不匹配时只保留可识别字段，避免旧结构污染模型。
    data.version = MODEL_VERSION;
    data.seasons = data.seasons && typeof data.seasons === 'object' ? data.seasons : {};
    data.fertilizer = data.fertilizer && typeof data.fertilizer === 'object' ? data.fertilizer : {};
  }
  if (!data.seasons || typeof data.seasons !== 'object') data.seasons = {};
  if (!data.fertilizer || typeof data.fertilizer !== 'object') data.fertilizer = {};

  cache = { data, mtimeMs };
  return data;
}

function scheduleFlush() {
  pendingWrite = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_DEBOUNCE_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/** 立即写盘（测试与退出前使用） */
function flush() {
  if (!pendingWrite) return false;
  const data = load();
  data.updatedAt = Date.now();
  try {
    writeJsonFileAtomic(getModelFilePath(), data);
    pendingWrite = false;
    cache = null;
    return true;
  } catch {
    // 写盘失败不阻断业务，保留 pendingWrite 以便下次重试。
    return false;
  }
}

function shouldRecord(key, seconds, sampleList, minSamples) {
  const now = Date.now();
  const lastAt = lastRecordAt.get(key) || 0;
  if (now - lastAt < RECORD_COOLDOWN_MS) return false;
  const samples = Array.isArray(sampleList) ? sampleList : [];
  if (samples.length < minSamples) return true;
  const current = median(samples);
  if (!current) return true;
  return Math.abs(seconds - current) / current > STABLE_DEVIATION_RATIO;
}

function pushSample(samples, seconds) {
  const list = Array.isArray(samples) ? samples.slice() : [];
  list.push(seconds);
  while (list.length > MAX_SAMPLES_PER_KEY) list.shift();
  return list;
}

/**
 * 记录一次「某植物第 N 季时长」观测
 * @param {number} plantId - 植物 ID
 * @param {number} seasonIndex - 季序号，从 1 开始
 * @param {number} seconds - 观测到的该季总时长（秒）
 * @param {object} [meta] - 附加信息，仅用于日志排查
 * @returns {{recorded: boolean, reason?: string}} 是否写入样本及被拒绝原因
 */
function recordSeasonObservation(plantId, seasonIndex, seconds, meta = {}) {
  const id = Number(plantId);
  const season = Number(seasonIndex);
  const value = toValidSeconds(seconds);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(season) || season < 1) {
    return { recorded: false, reason: 'invalid-key' };
  }
  if (!value) return { recorded: false, reason: 'invalid-seconds' };

  const data = load();
  const key = `${id}:${season}`;
  const bucketKey = String(id);
  const seasonKey = String(season);
  const bucket = data.seasons[bucketKey] && typeof data.seasons[bucketKey] === 'object'
    ? data.seasons[bucketKey]
    : {};
  const entry = bucket[seasonKey] && typeof bucket[seasonKey] === 'object' ? bucket[seasonKey] : { samples: [] };

  if (!shouldRecord(key, value, entry.samples, SEASON_MIN_SAMPLES)) {
    return { recorded: false, reason: 'stable-or-cooldown' };
  }

  entry.samples = pushSample(entry.samples, value);
  entry.updatedAt = Date.now();
  entry.source = String(meta.source || 'land');
  bucket[seasonKey] = entry;
  data.seasons[bucketKey] = bucket;
  lastRecordAt.set(key, Date.now());
  scheduleFlush();
  return { recorded: true };
}

/**
 * 记录一次「化肥单次减少生长时间」观测
 * @param {'normal'|'organic'} type - 化肥类型
 * @param {number} seconds - 观测到的减秒
 */
function recordFertilizerObservation(type, seconds) {
  const kind = String(type || '').trim().toLowerCase();
  if (!FERTILIZER_TYPES.has(kind)) return { recorded: false, reason: 'invalid-type' };
  const value = toValidSeconds(seconds);
  if (!value) return { recorded: false, reason: 'invalid-seconds' };

  const data = load();
  const key = `fert:${kind}`;
  const entry = data.fertilizer[kind] && typeof data.fertilizer[kind] === 'object'
    ? data.fertilizer[kind]
    : { samples: [] };

  if (!shouldRecord(key, value, entry.samples, FERTILIZER_MIN_SAMPLES)) {
    return { recorded: false, reason: 'stable-or-cooldown' };
  }

  entry.samples = pushSample(entry.samples, value);
  entry.updatedAt = Date.now();
  data.fertilizer[kind] = entry;
  lastRecordAt.set(key, Date.now());
  scheduleFlush();
  return { recorded: true };
}

/**
 * 读取某植物第 N 季的实测时长
 * @returns {{seconds: number, samples: number, source: 'measured'}|null} 样本不足时返回 null
 */
function getSeasonSeconds(plantId, seasonIndex) {
  const id = Number(plantId);
  const season = Number(seasonIndex);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(season) || season < 1) return null;
  const data = load();
  const entry = data.seasons?.[String(id)]?.[String(season)];
  const samples = Array.isArray(entry?.samples) ? entry.samples : [];
  if (samples.length < SEASON_MIN_SAMPLES) return null;
  const seconds = median(samples);
  if (!seconds) return null;
  return { seconds: Math.round(seconds), samples: samples.length, source: 'measured' };
}

/**
 * 读取某类化肥的实测单次减秒
 * @returns {{seconds: number, samples: number, source: 'measured'}|null} 样本不足时返回 null
 */
function getFertilizerReduceSec(type) {
  const kind = String(type || '').trim().toLowerCase();
  if (!FERTILIZER_TYPES.has(kind)) return null;
  const data = load();
  const entry = data.fertilizer?.[kind];
  const samples = Array.isArray(entry?.samples) ? entry.samples : [];
  if (samples.length < FERTILIZER_MIN_SAMPLES) return null;
  const seconds = median(samples);
  if (!seconds) return null;
  return { seconds: Math.round(seconds), samples: samples.length, source: 'measured' };
}

/** 导出原始模型（诊断与测试用） */
function getSnapshot() {
  return load();
}

/** 强制重新读取文件 */
function reload() {
  return load({ force: true });
}

/**
 * 测试用：清空采样冷却与待写状态
 * @param {object} [options]
 * @param {boolean} [options.keepData] - true（默认）保留内存中的模型数据，只清冷却；
 *   false 时同时丢弃内存缓存，下次读取重新从文件加载。
 */
function __resetForTest({ keepData = true } = {}) {
  pendingWrite = false;
  lastRecordAt.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!keepData) cache = null;
}

module.exports = {
  MODEL_FILENAME,
  MODEL_VERSION,
  MAX_SAMPLES_PER_KEY,
  SEASON_MIN_SAMPLES,
  FERTILIZER_MIN_SAMPLES,
  getModelFilePath,
  recordSeasonObservation,
  recordFertilizerObservation,
  getSeasonSeconds,
  getFertilizerReduceSec,
  getSnapshot,
  flush,
  reload,
  __resetForTest,
};
