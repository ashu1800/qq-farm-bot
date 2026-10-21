const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createRequestGate,
  computeDispatchDelay,
  getRequestPriority,
  runWithRequestPriority,
  DEFAULT_MAX_ACTIVE,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_JITTER_MS,
} = require('../src/utils/request-priority');

// 测试里关闭节流间隔，避免用例被 250ms 基线拖慢；节流本身另有专用用例覆盖。
function createFastGate(options = {}) {
  return createRequestGate({ minIntervalMs: 0, jitterMs: 0, ...options });
}

test('request gate dispatches queued work by priority then FIFO', async () => {
  const gate = createFastGate({ maxActive: 1 });
  const firstRelease = await gate.acquire('background');
  const order = [];
  const queued = [
    gate.acquire('friend').then(release => { order.push('friend'); release(); }),
    gate.acquire('critical').then(release => { order.push('critical'); release(); }),
    gate.acquire('farm').then(release => { order.push('farm'); release(); }),
  ];
  firstRelease();
  await Promise.all(queued);
  assert.deepEqual(order, ['critical', 'farm', 'friend']);
});

test('request priority context is inherited across async work', async () => {
  const observed = await runWithRequestPriority('background', async () => {
    await Promise.resolve();
    return getRequestPriority();
  });
  assert.equal(observed, 'background');
  assert.equal(getRequestPriority(), 'foreground');
});

test('request gate defaults to a 2-in-flight human-like pacing model', () => {
  const gate = createRequestGate();
  const snapshot = gate.snapshot();
  assert.equal(snapshot.pacing.maxActive, DEFAULT_MAX_ACTIVE);
  assert.equal(snapshot.pacing.minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
  assert.equal(snapshot.pacing.jitterMs, DEFAULT_JITTER_MS);
  assert.equal(DEFAULT_MAX_ACTIVE, 2);
  assert.equal(DEFAULT_MIN_INTERVAL_MS, 250);
  assert.equal(DEFAULT_JITTER_MS, 150);
});

test('dispatch delay stays within the 250~400ms budget', () => {
  assert.equal(computeDispatchDelay({ random: () => 0 }), 250);
  assert.equal(computeDispatchDelay({ random: () => 1 }), 400);
  assert.equal(computeDispatchDelay({ random: () => 0.5 }), 325);
  // 异常随机源退化为基线间隔，不能产生负数或超出上限
  assert.equal(computeDispatchDelay({ random: () => Number.NaN }), 250);
  assert.equal(computeDispatchDelay({ random: () => 42 }), 400);
  assert.equal(computeDispatchDelay({ random: () => -1 }), 250);
});

test('request gate keeps the baseline interval between dispatches', async () => {
  const gate = createRequestGate({ maxActive: 4, minIntervalMs: 40, jitterMs: 0 });
  const startedAt = [];
  const releases = await Promise.all(
    [0, 1, 2, 3].map(() => gate.acquire('foreground').then((release) => {
      startedAt.push(Date.now());
      return release;
    })),
  );
  releases.forEach(release => release());
  const gaps = startedAt.slice(1).map((at, index) => at - startedAt[index]);
  assert.equal(gaps.length, 3);
  for (const gap of gaps) {
    assert.ok(gap >= 35, `出队间隔应不短于基线（实际 ${gap}ms）`);
  }
});

test('request gate caps in-flight requests and queues the rest', async () => {
  const gate = createFastGate({ maxActive: 2 });
  const releaseA = await gate.acquire('farm');
  const releaseB = await gate.acquire('farm');
  let thirdStarted = false;
  const third = gate.acquire('farm').then((release) => {
    thirdStarted = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(gate.snapshot().active, 2);
  assert.equal(gate.snapshot().queued, 1);
  assert.equal(thirdStarted, false);
  releaseA();
  const releaseC = await third;
  assert.equal(thirdStarted, true);
  releaseB();
  releaseC();
});

test('request gate rejects when the queue is full', async () => {
  const gate = createFastGate({ maxActive: 1, maxQueued: 1 });
  const release = await gate.acquire('farm');
  const queued = gate.acquire('farm');
  await assert.rejects(() => gate.acquire('farm'), /请求调度队列已满/);
  release();
  (await queued)();
});

test('request gate flushes queued work when the connection drops', async () => {
  const gate = createFastGate({ maxActive: 1 });
  const release = await gate.acquire('farm');
  const queuedA = gate.acquire('farm');
  const queuedB = gate.acquire('friend');
  assert.equal(gate.snapshot().queued, 2);
  assert.equal(gate.flush('请求已中断: 主动重连'), 2);
  await assert.rejects(queuedA, /请求已中断/);
  await assert.rejects(queuedB, /请求已中断/);
  assert.equal(gate.snapshot().queued, 0);
  release();
  // flush 之后新请求应立即获得槽位，不必等待旧队列排空
  const releaseAgain = await gate.acquire('critical');
  releaseAgain();
});
