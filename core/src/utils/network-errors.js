/**
 * 网络瞬态错误判定
 *
 * 历史上 worker、farm-*、friend-* 各自维护一份关键字列表，内容已经漂移
 * （有的缺「请求调度队列已满」，有的多了 worker 退出相关的消息）。
 * 统一到这里，避免同一类错误在不同调用点被当成“真实失败”打 warn 日志。
 */

/** 请求队列 / 发送阶段的瞬时错误 */
const TRANSIENT_PATTERNS = [
  '连接未打开',
  '请求超时',
  '请求已中断',
  '连接关闭',
  '连接已在加密途中关闭',
  '发送失败',
  '请求队列已满',
  '请求调度队列已满',
  'worker exited',
];

/**
 * 是否为可重试的网络/调度瞬态错误
 * @param {Error|string|*} err
 * @returns {boolean}
 */
function isTransientNetworkError(err) {
  const message = String((err && err.message) || err || '');
  if (!message) return false;
  // 英文关键字大小写不统一（"Worker exited" / "worker exited"），统一转小写比较
  const lower = message.toLowerCase();
  return TRANSIENT_PATTERNS.some(pattern => lower.includes(pattern.toLowerCase()));
}

module.exports = { isTransientNetworkError, TRANSIENT_PATTERNS };
