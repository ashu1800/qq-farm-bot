const test = require('node:test');
const assert = require('node:assert/strict');

const { getChinaDateKey } = require('../src/utils/utils');

// 游戏服每日刷新按 UTC+8 计算。历史上 auto-code-refresh 和 worker 的每日状态
// 用的是 toISOString() 的 UTC 日期，在 UTC+8 的 00:00–08:00 会算成前一天。
test('getChinaDateKey uses UTC+8 rather than UTC or host timezone', () => {
  // 2026-10-19 00:30 CST === 2026-10-18 16:30 UTC
  assert.equal(getChinaDateKey(Date.UTC(2026, 9, 18, 16, 30)), '2026-10-19');
  // 2026-10-19 07:59 CST === 2026-10-18 23:59 UTC（边界前）
  assert.equal(getChinaDateKey(Date.UTC(2026, 9, 18, 23, 59)), '2026-10-19');
  // 2026-10-19 08:00 CST === 2026-10-19 00:00 UTC（边界后）
  assert.equal(getChinaDateKey(Date.UTC(2026, 9, 19, 0, 0)), '2026-10-19');
  // 2026-10-19 23:59 CST === 2026-10-19 15:59 UTC
  assert.equal(getChinaDateKey(Date.UTC(2026, 9, 19, 15, 59)), '2026-10-19');
});

test('getChinaDateKey falls back to now for invalid input', () => {
  // 无效时间戳回退到当前时间，保证调用方永远拿到合法的 YYYY-MM-DD。
  assert.match(getChinaDateKey(Number.NaN), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(getChinaDateKey(), /^\d{4}-\d{2}-\d{2}$/);
});
