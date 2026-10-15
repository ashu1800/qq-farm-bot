/**
 * 作物排名测试
 *
 * 排名是自动选种与「分析」页的共同入口，因此这里锁三件事：
 * 1. 排序方向与未知收益的排序位置正确；
 * 2. 每条记录都来自 plant-economy（不存在第二套时长/收益口径）；
 * 3. 覆盖全部可建模作物。
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { getPlantRankings, SORT_METRICS } = require('../src/services/analytics');
const { getPlantEconomy } = require('../src/services/plant-economy');
const { getAllPlants } = require('../src/config/gameConfig');

function expectedPlantIds() {
  const ids = new Set();
  for (const plant of getAllPlants()) {
    if (!(plant.seed_id > 0) || !plant.grow_phases) continue;
    const economy = getPlantEconomy(plant);
    if (economy && economy.cycleSeconds > 0) ids.add(Number(plant.id));
  }
  return ids;
}

test('经验排序按每小时经验降序，且覆盖全部可建模作物', () => {
  const rankings = getPlantRankings('exp');
  assert.ok(rankings.length > 100, `排名数量异常偏少: ${rankings.length}`);

  for (let index = 1; index < rankings.length; index += 1) {
    assert.ok(
      rankings[index - 1].expPerHour >= rankings[index].expPerHour,
      `${rankings[index - 1].name} (${rankings[index - 1].expPerHour}) 应不低于 ${rankings[index].name} (${rankings[index].expPerHour})`,
    );
  }

  const ids = new Set(rankings.map(item => Number(item.id)));
  const expected = expectedPlantIds();
  assert.equal(ids.size, expected.size);
  for (const id of expected) assert.ok(ids.has(id), `缺少作物 ${id}`);
});

test('排名记录与 plant-economy 模型逐字段一致', () => {
  for (const rank of getPlantRankings('exp').slice(0, 20)) {
    const economy = getPlantEconomy(getAllPlants().find(plant => Number(plant.id) === Number(rank.id)));
    assert.ok(economy);
    for (const key of [
      'seedId', 'name', 'seasons', 'cycleSeconds', 'expPerSeason', 'cycleExp',
      'expPerHour', 'normalFertilizerExpPerHour', 'profitPerHour', 'goldPerHour',
      'priceKnown', 'fruitPrice', 'seedPrice',
    ]) {
      assert.deepEqual(rank[key], economy[key], `${rank.name} 字段 ${key} 与模型不一致`);
    }
    assert.equal(rank.seasonSecondsSource, economy.seasonSecondsSource);
  }
});

test('利润排序：未知收益排在最后，其余按每小时利润降序', () => {
  const rankings = getPlantRankings('profit');
  assert.ok(rankings.length > 100);

  let seenUnknown = false;
  let previous = Number.POSITIVE_INFINITY;
  for (const item of rankings) {
    if (item.profitPerHour === null) {
      seenUnknown = true;
      continue;
    }
    assert.equal(seenUnknown, false, `${item.name} 的可用利润排在未知收益之后`);
    assert.ok(item.profitPerHour <= previous, `${item.name} 利润排序错误`);
    previous = item.profitPerHour;
  }
  assert.ok(seenUnknown, '应当存在收益未知（果实无定价）的作物');
});

test('未知收益作物暴露 priceKnown 供利润策略过滤', () => {
  const unknown = getPlantRankings('profit').filter(item => item.priceKnown === false);
  assert.ok(unknown.length > 0);
  for (const item of unknown) {
    assert.equal(item.profitPerHour, null, `${item.name} 收益未知时应输出 null`);
  }
});

test('等级排序按所需等级降序，缺等级的排在最后', () => {
  const rankings = getPlantRankings('level');
  assert.ok(rankings.length > 100);
  let seenNull = false;
  let previous = Number.POSITIVE_INFINITY;
  for (const item of rankings) {
    if (!Number.isFinite(item.level)) {
      seenNull = true;
      continue;
    }
    assert.equal(seenNull, false, `${item.name} 的等级排在未知等级之后`);
    assert.ok(item.level <= previous, `${item.name} 等级排序错误`);
    previous = item.level;
  }
});

test('四种策略排序键与模型字段对应，未知排序键回退到经验', () => {
  assert.deepEqual(SORT_METRICS, {
    exp: 'expPerHour',
    fert: 'normalFertilizerExpPerHour',
    gold: 'goldPerHour',
    profit: 'profitPerHour',
    fert_profit: 'normalFertilizerProfitPerHour',
  });

  const fallback = getPlantRankings('not-a-metric');
  const byExp = getPlantRankings('exp');
  assert.equal(fallback.length, byExp.length);
  assert.equal(fallback[0].id, byExp[0].id);

  // 未知收益作物的金币/化肥利润为 null，必须排在数值之后而不是当作 0
  for (const [sortBy, metric] of Object.entries(SORT_METRICS)) {
    const list = getPlantRankings(sortBy);
    assert.ok(list.length > 100, `${sortBy} 排名数量异常`);
    let seenNull = false;
    for (const item of list) {
      if (item[metric] === null) {
        seenNull = true;
        continue;
      }
      assert.equal(seenNull, false, `${sortBy}: ${item.name} 的数值排在 null 之后`);
    }
  }
});
