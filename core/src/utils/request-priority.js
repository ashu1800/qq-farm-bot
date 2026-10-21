const { AsyncLocalStorage } = require('node:async_hooks');

const PRIORITIES = Object.freeze({
  critical: 0,
  foreground: 1,
  farm: 2,
  friend: 3,
  background: 4,
});

const priorityContext = new AsyncLocalStorage();

function normalizePriority(value) {
  const key = String(value || '').toLowerCase();
  return Object.hasOwn(PRIORITIES, key) ? key : 'foreground';
}

function runWithRequestPriority(priority, fn) {
  return priorityContext.run(normalizePriority(priority), fn);
}

function getRequestPriority(fallback = 'foreground') {
  return normalizePriority(priorityContext.getStore() || fallback);
}

// 拟真真机小程序的网络模型：同时最多 2 条在途请求，出队基线间隔 250ms，
// 再叠加 0~150ms 随机抖动（单次出队约 250~400ms），避免瞬间打出上百个包被网关风控。
const DEFAULT_MAX_ACTIVE = 2;
const DEFAULT_MAX_QUEUED = 500;
const DEFAULT_MIN_INTERVAL_MS = 250;
const DEFAULT_JITTER_MS = 150;

function toPositiveInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 1 ? Math.floor(num) : fallback;
}

function toNonNegative(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

/** 计算相邻两次出队之间的间隔：基线 + [0, jitter] 内的均匀随机抖动 */
function computeDispatchDelay(options = {}) {
  const minIntervalMs = toNonNegative(options.minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
  const jitterMs = toNonNegative(options.jitterMs, DEFAULT_JITTER_MS);
  if (jitterMs <= 0) return minIntervalMs;
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const sample = Number(random());
  const ratio = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  return minIntervalMs + jitterMs * ratio;
}

function createRequestGate(options = {}) {
  const maxActive = toPositiveInt(options.maxActive, DEFAULT_MAX_ACTIVE);
  const maxQueued = toPositiveInt(options.maxQueued, DEFAULT_MAX_QUEUED);
  const minIntervalMs = toNonNegative(options.minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
  const jitterMs = toNonNegative(options.jitterMs, DEFAULT_JITTER_MS);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const random = typeof options.random === 'function' ? options.random : Math.random;
  let active = 0;
  let order = 0;
  let nextDispatchAt = 0;
  let drainTimer = null;
  const queue = [];

  function scheduleDrain(delayMs) {
    if (drainTimer) return;
    drainTimer = setTimeout(() => {
      drainTimer = null;
      drain();
    }, Math.max(1, Math.ceil(delayMs)));
  }

  function drain() {
    queue.sort((a, b) => PRIORITIES[a.priority] - PRIORITIES[b.priority] || a.order - b.order);
    while (active < maxActive && queue.length > 0) {
      // 全局限速：无论上层并发多少，出队时刻之间始终保留 250ms 基线 + 随机抖动
      const waitMs = nextDispatchAt - now();
      if (waitMs > 0) {
        scheduleDrain(waitMs);
        return;
      }
      const entry = queue.shift();
      active++;
      nextDispatchAt = now() + computeDispatchDelay({ minIntervalMs, jitterMs, random });
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
        drain();
      });
    }
  }

  function acquire(priority) {
    if (queue.length >= maxQueued) {
      return Promise.reject(new Error(`请求调度队列已满: queued=${queue.length}`));
    }
    return new Promise((resolve, reject) => {
      queue.push({ priority: normalizePriority(priority), order: order++, resolve, reject });
      drain();
    });
  }

  // 连接中断时丢弃仍在排队的请求：否则旧队列会按节流节奏慢慢出队，拖住重连后的新请求
  function flush(reason = '请求已中断') {
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
    nextDispatchAt = 0;
    const dropped = queue.splice(0, queue.length);
    for (const entry of dropped) {
      entry.reject(reason instanceof Error ? reason : new Error(String(reason)));
    }
    return dropped.length;
  }

  function snapshot() {
    return {
      active,
      queued: queue.length,
      nextDispatchInMs: Math.max(0, Math.round(nextDispatchAt - now())),
      pacing: { maxActive, maxQueued, minIntervalMs, jitterMs },
      byPriority: queue.reduce((result, item) => {
        result[item.priority] = (result[item.priority] || 0) + 1;
        return result;
      }, {}),
    };
  }

  return { acquire, flush, snapshot };
}

module.exports = {
  PRIORITIES,
  DEFAULT_MAX_ACTIVE,
  DEFAULT_MAX_QUEUED,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_JITTER_MS,
  normalizePriority,
  runWithRequestPriority,
  getRequestPriority,
  computeDispatchDelay,
  createRequestGate,
};
