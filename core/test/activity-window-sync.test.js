const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// core/src/models/store.js 的 TIMED_ACTIVITY_AUTOMATION_GROUPS 与
// web/src/constants/activity-windows.ts 是两份手工同步的字面量（CommonJS 与 TS 无法共享模块）。
// 一旦只改一边，设置页会显示后端已经强制关闭的开关，或反过来在活动结束后仍可开启自动化。
//
// 之前只有萌宠日记有同类断言；这里把整体分组结构都纳入检查。

const STORE_PATH = path.join(__dirname, '../src/models/store.js');
const WINDOW_PATH = path.join(__dirname, '../../web/src/constants/activity-windows.ts');

function parseBackendGroups() {
  const source = fs.readFileSync(STORE_PATH, 'utf8');
  const start = source.indexOf('const TIMED_ACTIVITY_AUTOMATION_GROUPS');
  assert.ok(start >= 0, 'TIMED_ACTIVITY_AUTOMATION_GROUPS should exist');
  const end = source.indexOf('\n];', start);
  assert.ok(end > start, 'TIMED_ACTIVITY_AUTOMATION_GROUPS should be a literal array');
  const block = source.slice(start, end);

  const groups = [];
  // 匹配 `startTime: N, endTime: M, keys: [...]`，兼容跨行和 keys 变量引用
  const re = /startTime:\s*(\d+)\s*,\s*endTime:\s*(\d+)\s*,\s*keys:\s*([A-Z_]+|\[[^\]]*\])/g;
  for (const match of block.matchAll(re)) {
    groups.push({ startTime: Number(match[1]), endTime: Number(match[2]), keys: match[3] });
  }
  return groups;
}

function parseFrontendWindows() {
  const source = fs.readFileSync(WINDOW_PATH, 'utf8');
  const windows = [];
  const re = /export const (\w+_ACTIVITY_WINDOW)\s*=\s*\{[^}]*startMs:\s*(\d+)\s*\*\s*1000[^}]*endMs:\s*(\d+)\s*\*\s*1000/g;
  for (const match of source.matchAll(re)) {
    windows.push({ name: match[1], startMs: Number(match[2]) * 1000, endMs: Number(match[3]) * 1000 });
  }
  // 也支持直接写毫秒的形式
  const reMs = /export const (\w+_ACTIVITY_WINDOW)\s*=\s*\{\s*startMs:\s*(\d{12,})\s*,\s*endMs:\s*(\d{12,})/g;
  for (const match of source.matchAll(reMs)) {
    windows.push({ name: match[1], startMs: Number(match[2]), endMs: Number(match[3]) });
  }
  // 展开展示的派生窗口，例如 MILK_TEA_BUSINESS_WINDOW = { ...MILK_TEA_ACTIVITY_WINDOW, endMs: N }
  const byName = new Map(windows.map(window => [window.name, window]));
  const reSpread = /export const (\w+)\s*=\s*\{\s*\.\.\.(\w+)\s*,\s*endMs:\s*(\d+)\s*(?:,\s*)?\}/g;
  for (const match of source.matchAll(reSpread)) {
    const base = byName.get(match[2]);
    if (!base) continue;
    windows.push({ name: match[1], startMs: base.startMs, endMs: Number(match[3]) });
  }
  return windows;
}

test('every timed activity window in store.js has a matching frontend window', () => {
  const backend = parseBackendGroups();
  const frontendSeconds = new Set(parseFrontendWindows().map(w => `${w.startMs / 1000}-${w.endMs / 1000}`));

  assert.ok(backend.length >= 5, `expected several timed groups, got ${backend.length}`);

  const missing = backend
    .filter(group => !frontendSeconds.has(`${group.startTime}-${group.endTime}`))
    .map(group => `${group.startTime}-${group.endTime} (${group.keys})`);

  assert.deepEqual(missing, [], 'store.js 中存在前端 activity-windows.ts 未登记的活动时间窗');
});

test('activity window parser finds the expected registered windows', () => {
  const frontend = parseFrontendWindows();
  const names = frontend.map(w => w.name).sort();
  // 覆盖当前所有已登记的活动；新增活动时这里会提醒同步检查解析逻辑
  for (const expected of [
    'CHARITY_FLOWER_ACTIVITY_WINDOW',
    'MILK_TEA_ACTIVITY_WINDOW',
    'PET_DIARY_ACTIVITY_WINDOW',
    'RAIN_POEM_ACTIVITY_WINDOW',
    'SHARE_REWARD_ACTIVITY_WINDOW',
    'WISH_SIGN_ACTIVITY_WINDOW',
  ]) {
    assert.ok(names.includes(expected), `${expected} should be parsed from activity-windows.ts`);
  }
});
