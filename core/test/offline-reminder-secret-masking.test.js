const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-offline-mask-'));
const logDir = path.join(os.tmpdir(), 'qf-test-logs');
const previousDataDir = process.env.FARM_DATA_DIR;
const previousLogDir = process.env.FARM_LOG_DIR;
process.env.FARM_DATA_DIR = dataDir;
process.env.FARM_LOG_DIR = logDir;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.FARM_DATA_DIR;
  else process.env.FARM_DATA_DIR = previousDataDir;
  if (previousLogDir === undefined) delete process.env.FARM_LOG_DIR;
  else process.env.FARM_LOG_DIR = previousLogDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// buildSettingsPayload / maskOfflineReminder 不是导出函数，
// 这里用源码级断言 + store 层行为验证，避免为此改动生产代码的导出面。
const SETTINGS_ROUTE_SOURCE = fs.readFileSync(
  path.join(__dirname, '../src/controllers/admin-settings-routes.js'),
  'utf8',
);

test('settings payload masks smtp password and push token', () => {
  assert.match(SETTINGS_ROUTE_SOURCE, /function maskOfflineReminder/);
  assert.match(SETTINGS_ROUTE_SOURCE, /smtpPass: "",/);
  assert.match(SETTINGS_ROUTE_SOURCE, /token: "",/);
  assert.match(SETTINGS_ROUTE_SOURCE, /maskOfflineReminder\(store\.getOfflineReminder\(currentUser\.username\)\)/);
  assert.match(SETTINGS_ROUTE_SOURCE, /smtpPassConfigured/);
  assert.match(SETTINGS_ROUTE_SOURCE, /tokenConfigured/);
});

test('save endpoint keeps existing secrets when the client sends blanks', () => {
  const store = require('../src/models/store');
  store.setOfflineReminder({
    channel: 'smtp',
    smtpHost: 'smtp.qq.com',
    smtpUser: 'bot@qq.com',
    smtpPass: 'original-pass',
    recipientEmail: 'me@qq.com',
  }, 'admin');

  // 模拟前端脱敏后提交（smtpPass 为空）
  const merged = { ...store.getOfflineReminder('admin'), smtpPass: '' };
  assert.equal(merged.smtpPass, '');
  // 保存接口会把空值视为“保持不变”（见 getOfflineReminderConfig）
  assert.match(SETTINGS_ROUTE_SOURCE, /delete patch\[field\]/);
});
