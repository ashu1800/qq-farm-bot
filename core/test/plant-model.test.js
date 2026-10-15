/**
 * 植物模型校准采集测试
 *
 * 覆盖：季时长推导（含「服务端 phases 是配置后缀」的季中推导）、首季自校验门禁、
 * 土地 buff / 化肥 / 催熟地块的跳过、样本中位数与最少样本、化肥减秒样本、非法值拒绝。
 * 校准文件被重定向到临时目录，不写仓库 data 目录、不连服务端。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// 必须在首次读取模型之前隔离数据目录
process.env.FARM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-plant-model-'));

const plantModel = require('../src/services/plant-model');
const analyzer = require('../src/services/farm-land-analyzer');
const { observePlantModel } = analyzer;
const analyzerTest = analyzer._test;

// 蘑菇：植物 ID 1020050，阶段 3600×4 + 成熟 0 = 14400 秒/季，共 2 季
const MUSHROOM_PLANT_ID = 1020050;
const MUSHROOM_SEASON_SEC = 14400;

const T0 = 1_700_000_000;

function buildPlant({ plantId = MUSHROOM_PLANT_ID, season = 1, beginTimes = [], extra = {} } = {}) {
  return {
    id: plantId,
    season,
    phases: beginTimes.map(begin => ({ begin_time: begin })),
    ...extra,
  };
}

/** 整季：从季初开始，phases 覆盖配置全部阶段 */
function fullSeasonLand(plantId, season, seasonSec = MUSHROOM_SEASON_SEC, extra = {}) {
  const step = seasonSec / 4;
  return {
    id: 1,
    unlocked: true,
    plant: buildPlant({
      plantId,
      season,
      beginTimes: [T0, T0 + step, T0 + step * 2, T0 + step * 3, T0 + seasonSec],
      extra,
    }),
  };
}

function resetAll() {
  plantModel.__resetForTest();
  analyzerTest.resetSeasonDerivation();
}

test('首季自校验通过：整季与季中推导都能还原配置时长', () => {
  resetAll();
  // 整季
  observePlantModel([fullSeasonLand(MUSHROOM_PLANT_ID, 1)]);
  assert.equal(analyzerTest.isSeasonDerivationVerified(), true);

  // 季中：phases 是「当前阶段开始的配置后缀」，已过阶段时长从配置补齐
  resetAll();
  const midSeason = {
    id: 2,
    unlocked: true,
    plant: buildPlant({
      plantId: MUSHROOM_PLANT_ID,
      season: 1,
      // 当前处于第 3 个阶段（前两阶段各 3600 秒已过）
      beginTimes: [T0 + 7200, T0 + 10800, T0 + MUSHROOM_SEASON_SEC],
    }),
  };
  observePlantModel([midSeason]);
  assert.equal(analyzerTest.isSeasonDerivationVerified(), true);
});

test('首季推导与配置不符时不采信，也不记录后续季', () => {
  resetAll();
  // 首季比配置多 300 秒，超出 60 秒容差
  const wrong = fullSeasonLand(MUSHROOM_PLANT_ID, 1, MUSHROOM_SEASON_SEC + 300);
  observePlantModel([wrong]);
  assert.equal(analyzerTest.isSeasonDerivationVerified(), false);

  // 未通过自校验前，第 2 季的观测必须被丢弃
  plantModel.__resetForTest();
  observePlantModel([fullSeasonLand(MUSHROOM_PLANT_ID, 2, 7200)]);
  assert.equal(plantModel.getSeasonSeconds(MUSHROOM_PLANT_ID, 2), null);
});

test('自校验通过后记录第 2 季实测时长并取中位数', () => {
  resetAll();
  observePlantModel([fullSeasonLand(MUSHROOM_PLANT_ID, 1)]);
  assert.equal(analyzerTest.isSeasonDerivationVerified(), true);

  plantModel.__resetForTest();
  observePlantModel([fullSeasonLand(MUSHROOM_PLANT_ID, 2, 7200)]);
  assert.equal(plantModel.getSeasonSeconds(MUSHROOM_PLANT_ID, 2), null, '单条样本不足以取中位数');

  // 冷却只用于限制写盘频率，测试里显式重置
  plantModel.__resetForTest();
  observePlantModel([fullSeasonLand(MUSHROOM_PLANT_ID, 2, 7200)]);
  const measured = plantModel.getSeasonSeconds(MUSHROOM_PLANT_ID, 2);
  assert.ok(measured);
  assert.equal(measured.seconds, 7200);
  assert.equal(measured.samples, 2);
  assert.equal(measured.source, 'measured');
});

test('带 planting_time_reduction 的地块不作为时长基线', () => {
  resetAll();
  const land = fullSeasonLand(MUSHROOM_PLANT_ID, 1);
  land.buff = { planting_time_reduction: 3600 };
  observePlantModel([land]);
  assert.equal(analyzerTest.isSeasonDerivationVerified(), false);
});

test('用过化肥或被催熟的地块跳过', () => {
  resetAll();
  const fertilized = fullSeasonLand(MUSHROOM_PLANT_ID, 1);
  fertilized.plant.phases[0].ferts_used = { 1011: 1 };
  observePlantModel([fertilized]);
  assert.equal(analyzerTest.isSeasonDerivationVerified(), false);

  resetAll();
  const nudged = fullSeasonLand(MUSHROOM_PLANT_ID, 1, MUSHROOM_SEASON_SEC, { is_nudged: true });
  observePlantModel([nudged]);
  assert.equal(analyzerTest.isSeasonDerivationVerified(), false);
});

test('化肥减秒样本需要 3 条才生效', () => {
  plantModel.__resetForTest();
  plantModel.recordFertilizerObservation('normal', 3600);
  plantModel.recordFertilizerObservation('normal', 3600);
  assert.equal(plantModel.getFertilizerReduceSec('normal'), null);

  plantModel.__resetForTest();
  plantModel.recordFertilizerObservation('normal', 3600);
  plantModel.__resetForTest();
  plantModel.recordFertilizerObservation('normal', 7200);
  plantModel.__resetForTest();
  plantModel.recordFertilizerObservation('normal', 3600);
  const measured = plantModel.getFertilizerReduceSec('normal');
  assert.ok(measured);
  assert.equal(measured.seconds, 3600);
  assert.equal(measured.samples, 3);

  // 没有样本的类型仍然返回 null，调用方据此退回假定值
  assert.equal(plantModel.getFertilizerReduceSec('organic'), null);
});

test('非法观测被拒绝，冷却期内相同值不重复记录', () => {
  plantModel.__resetForTest();
  assert.equal(plantModel.recordSeasonObservation(MUSHROOM_PLANT_ID, 2, 0).recorded, false);
  assert.equal(plantModel.recordSeasonObservation(MUSHROOM_PLANT_ID, 2, -100).recorded, false);
  assert.equal(plantModel.recordSeasonObservation(MUSHROOM_PLANT_ID, 2, 40 * 24 * 3600).recorded, false);
  assert.equal(plantModel.recordSeasonObservation(0, 2, 3600).recorded, false);
  assert.equal(plantModel.recordFertilizerObservation('unknown-type', 3600).recorded, false);

  // 使用未被其它用例占用的键，验证「冷却期内相同值不再写入」
  const freshPlantId = 1020002;
  plantModel.__resetForTest();
  assert.equal(plantModel.recordSeasonObservation(freshPlantId, 3, 7200).recorded, true);
  plantModel.__resetForTest();
  assert.equal(plantModel.recordSeasonObservation(freshPlantId, 3, 7200).recorded, true);
  const blocked = plantModel.recordSeasonObservation(freshPlantId, 3, 7200);
  assert.equal(blocked.recorded, false);
  assert.equal(blocked.reason, 'stable-or-cooldown');
  assert.equal(plantModel.getSeasonSeconds(freshPlantId, 3).seconds, 7200);
});
