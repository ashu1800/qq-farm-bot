/**
 * 作物排行缓存失效信号
 *
 * `analytics.js` 会缓存所有作物的经济模型（单次计算约 47ms）。
 * 校准数据（plant-model）更新后必须让缓存失效，否则新样本要等 TTL 才生效。
 *
 * 单独成模块是为了避免 `plant-model → analytics → plant-economy → plant-model`
 * 的循环依赖：两边都只依赖这个没有其它依赖的小模块。
 */

const listeners = new Set();

/** 注册缓存失效回调，返回取消订阅函数 */
function onRankingCacheInvalidate(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 通知所有订阅者清空缓存 */
function invalidateRankingCache() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // 缓存失效失败不应影响校准数据写入
    }
  }
}

module.exports = { onRankingCacheInvalidate, invalidateRankingCache };
