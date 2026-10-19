/**
 * 游戏服日期键（UTC+8）
 *
 * 单独成叶子模块：`store.js` 等被每个 worker 和大量测试在启动时 require 的模块
 * 只需要这个函数，不应该为此把 `utils/utils`（连带 winston 日志栈）拉进冷启动路径。
 * `utils/utils.js` 会 re-export 这里的实现，调用方仍可继续从 utils 导入。
 */

/**
 * @param {number} [timestampMs] - 毫秒时间戳，默认当前时间
 * @returns {string} YYYY-MM-DD（UTC+8）
 */
function getChinaDateKey(timestampMs = Date.now()) {
  // 无效时间戳回退到当前时间，保证调用方永远拿到合法日期键。
  const raw = Number(timestampMs);
  const date = new Date(Number.isFinite(raw) ? raw : Date.now());
  // UTC+8 = UTC + 8h；用 getUTC* 读取可避免受宿主机时区影响。
  const shifted = date.getTime() + 8 * 3600 * 1000;
  const utc = new Date(shifted);
  const year = utc.getUTCFullYear();
  const month = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const day = String(utc.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

module.exports = { getChinaDateKey };
