const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const protobuf = require('protobufjs');
const {
  MILK_TEA_ACTIVITY_ID,
  MILK_TEA_SUB_ACTIVITY_IDS,
  MILK_TEA_SHOP_ACTIVITY_ID,
  MILK_TEA_SHARE_ACTIVITY_ID,
  MILK_TEA_START_TIME,
  MILK_TEA_END_TIME,
  isMilkTeaActive,
  normalizeMilkTeaNode,
  normalizeMilkTeaShopItems,
  normalizeMilkTeaShareRewards,
} = require('../src/services/activity');

let protoRoot;
async function getProtocol() {
  if (!protoRoot) {
    protoRoot = new protobuf.Root();
    await protoRoot.load([
      path.join(__dirname, '../src/proto/corepb.proto'),
      path.join(__dirname, '../src/proto/activitypb.proto'),
    ], { keepCase: true });
  }
  return protoRoot;
}

test('milk tea activity registers stable IDs and sub-activity roster', () => {
  assert.equal(MILK_TEA_ACTIVITY_ID, 2026110100);
  assert.deepEqual(MILK_TEA_SUB_ACTIVITY_IDS, [2026110101, 2026110102, 2026110103, 2026110104]);
  assert.equal(MILK_TEA_START_TIME, 1792029600);
  assert.equal(MILK_TEA_END_TIME, 1794844799);
});

test('milk tea enforces the exact inclusive time window', () => {
  assert.equal(isMilkTeaActive(MILK_TEA_START_TIME - 1), false);
  assert.equal(isMilkTeaActive(MILK_TEA_START_TIME), true);
  assert.equal(isMilkTeaActive((MILK_TEA_START_TIME + MILK_TEA_END_TIME) / 2), true);
  assert.equal(isMilkTeaActive(MILK_TEA_END_TIME), true);
  assert.equal(isMilkTeaActive(MILK_TEA_END_TIME + 1), false);
});

test('normalizeMilkTeaNode extracts generic fields, payload JSON, and feature flags', () => {
  const node = {
    activity: { id: 2026110102, title: '兑换商店', start_time: 1792029600, end_time: 1794844799, payload: '{"goods":[{"id":1}]}' },
    exchange_shop: { goods: [] },
  };
  const normalized = normalizeMilkTeaNode(node);
  assert.equal(normalized.id, 2026110102);
  assert.equal(normalized.title, '兑换商店');
  assert.deepEqual(normalized.payload, { goods: [{ id: 1 }] });
  assert.equal(normalized.features.exchangeShop, true);
  assert.equal(normalized.features.randomShop, false);
  assert.deepEqual(normalized.unknownFieldNames, []);
});

test('normalizeMilkTeaNode keeps invalid payload as text and lists unknown body fields', () => {
  const normalized = normalizeMilkTeaNode({
    activity: { id: 2026110103, payload: 'not-json' },
    mystery_body: { level: 1 },
    star_record: {},
  });
  assert.deepEqual(normalized.payload, { text: 'not-json' });
  assert.equal(normalized.features.starRecord, true);
  assert.deepEqual(normalized.unknownFieldNames, ['mystery_body']);
});

test('milk tea window literal stays in sync with the frontend activity-windows constant', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../web/src/constants/activity-windows.ts'),
    'utf8',
  );
  const match = source.match(/MILK_TEA_ACTIVITY_WINDOW = \{\s*startMs: (\d+) \* 1000,\s*endMs: (\d+) \* 1000,\s*updatedMs: (\d+) \* 1000,/);
  assert.ok(match, 'activity-windows.ts 缺少 MILK_TEA_ACTIVITY_WINDOW 字面量');
  assert.equal(Number(match[1]), MILK_TEA_START_TIME);
  assert.equal(Number(match[2]), MILK_TEA_END_TIME);
});

test('milk tea operate requests encode with confirmed and reused commands', async () => {
  const type = (await getProtocol()).lookupType('gamepb.activitypb.OperateRequest');
  const cases = [
    // 兑换商店：通用 exchange_shop_operate（cmd 1，与雨落成诗/星砂商店同款）
    [{ id: MILK_TEA_SHOP_ACTIVITY_ID, cmd: 1, exchange_shop_operate: { id: 308, count: 1 } }, '0896f98fc6071001aa060508b4021001'],
    // 每日领取/档位领取：share_reward 体与快乐不独享逐字段同构，cmd 73/70 强证据复用
    [{ id: MILK_TEA_SHARE_ACTIVITY_ID, cmd: 73 }, '0898f98fc6071049'],
    [{ id: MILK_TEA_SHARE_ACTIVITY_ID, cmd: 70 }, '0898f98fc6071046'],
  ];
  for (const [input, hex] of cases) {
    const encoded = Buffer.from(type.encode(type.create(input)).finish());
    assert.equal(encoded.toString('hex'), hex);
    assert.equal(type.decode(encoded).id.toString(), String(input.id));
  }
});

test('milk tea shop and share rewards normalize from captured payload shapes', () => {
  const items = normalizeMilkTeaShopItems([
    { id: '308', item: { id: '29005', count: '1' }, cost: { id: '1041', count: '8000' }, status: 1, name: '森野黄金芽种子' },
    { id: '334', item: { id: '80011', count: '1' }, cost: { id: '1041', count: '500' }, status: 130, name: '有机化肥(1小时)' },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0].slotId, 308);
  assert.equal(items[0].itemId, 29005);
  assert.equal(items[0].costItemId, 1041);
  assert.equal(items[0].costItemCount, 8000);
  assert.equal(items[0].status, 1);
  assert.equal(items[1].status, 130);

  const share = normalizeMilkTeaShareRewards({
    daily: { claim_limit: 3 },
    my_pool: { claim_limit: 5 },
    milestones: [
      { tier_id: 3, threshold: 30, rewards: [{ id: '1042', count: '5' }], state: 2 },
      { tier_id: 4, threshold: 60, rewards: [{ id: '210048', count: '1' }], state: 1 },
    ],
    daily_reward: 5,
    first_share_reward: 5,
    red_dots: { daily: true, first_share: false },
  });
  assert.equal(share.dailyClaimLimit, 3);
  assert.equal(share.poolClaimLimit, 5);
  assert.equal(share.dailyReward, 5);
  assert.equal(share.unclaimed.daily, true);
  assert.equal(share.unclaimed.firstShare, false);
  assert.equal(share.milestones[0].state, 2);
  assert.equal(share.milestones[0].rewards[0].itemId, 1042);
  assert.equal(share.milestones[0].rewards[0].itemName, '宣传喇叭');
  assert.equal(share.milestones[0].rewards[0].itemCount, 5);
});

test('milk tea automation window and switches are registered in the account store', () => {
  const storeSource = fs.readFileSync(path.join(__dirname, '../src/models/store.js'), 'utf8');
  assert.match(storeSource, /milk_tea_daily: false/);
  assert.match(storeSource, /milk_tea_milestones: false/);
  assert.match(storeSource, /MILK_TEA_AUTOMATION_KEYS = \['milk_tea_daily', 'milk_tea_milestones'\]/);
  assert.match(storeSource, /startTime: 1792029600,\s+endTime: 1794844799,\s+keys: MILK_TEA_AUTOMATION_KEYS/);
});

test('milk tea auto-claim gates on red dots and claimable tiers inside the activity window', async () => {
  const workerSource = fs.readFileSync(path.join(__dirname, '../src/core/worker.js'), 'utf8');
  const start = workerSource.indexOf('        if (claimMilkTeaDailyEnabled');
  const end = workerSource.indexOf('        if (buyRainPoemBottleEnabled', start);
  assert.ok(start >= 0 && end > start);
  const block = workerSource.slice(start, end);

  async function run({ dailyEnabled = true, milestonesEnabled = true, active = true, unclaimedDaily = true, claimableTier = true, fail = false } = {}) {
    const calls = [];
    const errors = [];
    let dailyUnclaimed = unclaimedDaily;
    let tierClaimable = claimableTier;
    const service = {
      isMilkTeaActive: () => active,
      getMilkTeaActivity: async () => {
        calls.push('query');
        return {
          active,
          shareRewards: {
            unclaimed: { daily: dailyUnclaimed, firstShare: false },
            milestones: [{ state: tierClaimable ? 2 : 1 }],
          },
        };
      },
      operateMilkTea: async (action) => {
        calls.push(action);
        if (fail) throw new Error('fixture failure');
        if (action === 'daily') dailyUnclaimed = false;
        if (action === 'milestones') tierClaimable = false;
      },
    };
    const vm = require('node:vm');
    await vm.runInNewContext(`(async () => { ${block} })()`, {
      claimMilkTeaDailyEnabled: dailyEnabled,
      claimMilkTeaMilestonesEnabled: milestonesEnabled,
      require: () => service,
      log: (...args) => errors.push(args),
    });
    return { calls, errors };
  }

  assert.deepEqual((await run()).calls, ['query', 'daily', 'query', 'milestones']);
  assert.deepEqual((await run({ unclaimedDaily: false, claimableTier: true })).calls, ['query', 'milestones']);
  assert.deepEqual((await run({ dailyEnabled: false, milestonesEnabled: false })).calls, []);
  assert.deepEqual((await run({ active: false })).calls, []);
  const failure = await run({ fail: true });
  assert.deepEqual(failure.calls, ['query', 'daily']);
  assert.equal(failure.errors.length, 1);
});
