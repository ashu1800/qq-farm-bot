const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LOG_RETENTION_MS,
  buildHourlyLogFilename,
  cleanupExpiredLogFiles,
  sanitizeAuditFile
} = require('../src/services/logger');

test('builds hourly log filenames in local time', () => {
  const date = new Date(2026, 6, 11, 15, 42, 30);
  assert.equal(buildHourlyLogFilename('combined', date), 'combined-2026-07-11-15.log');
  assert.equal(buildHourlyLogFilename('error', date), 'error-2026-07-11-15.log');
});

test('removes only managed log files older than 72 hours', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-logs-'));
  const now = new Date(2026, 6, 11, 15).getTime();
  const oldTime = new Date(now - LOG_RETENTION_MS - 1000);
  const recentTime = new Date(now - LOG_RETENTION_MS + 1000);
  const oldCombined = path.join(logDir, 'combined-2026-07-08-14.log');
  const recentError = path.join(logDir, 'error-2026-07-08-15.log');
  const unrelated = path.join(logDir, 'custom.log');

  try {
    fs.writeFileSync(oldCombined, 'old');
    fs.writeFileSync(recentError, 'recent');
    fs.writeFileSync(unrelated, 'keep');
    fs.utimesSync(oldCombined, oldTime, oldTime);
    fs.utimesSync(recentError, recentTime, recentTime);
    fs.utimesSync(unrelated, oldTime, oldTime);

    assert.equal(cleanupExpiredLogFiles(logDir, now), 1);
    assert.equal(fs.existsSync(oldCombined), false);
    assert.equal(fs.existsSync(recentError), true);
    assert.equal(fs.existsSync(unrelated), true);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('rejects audit files whose recorded path belongs to another log directory', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-audit-'));
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-legacy-'));
  const auditFile = path.join(logDir, '.combined-log-audit.json');
  const legacyAudit = path.join(legacyDir, '.combined-log-audit.json');

  try {
    // 从旧目录整体拷过来的 audit 文件：记录路径不在当前日志目录 → 必须重置
    fs.writeFileSync(auditFile, JSON.stringify({ auditLog: legacyAudit, files: [] }));
    assert.equal(sanitizeAuditFile(auditFile, logDir), true);
    assert.equal(fs.existsSync(auditFile), false);

    // 记录路径正确 → 保留
    fs.writeFileSync(auditFile, JSON.stringify({ auditLog: auditFile, files: [] }));
    assert.equal(sanitizeAuditFile(auditFile, logDir), false);
    assert.equal(fs.existsSync(auditFile), true);

    // 内容损坏 → 重置，避免轮转继续写到无法解析的路径
    fs.writeFileSync(auditFile, '{not-json');
    assert.equal(sanitizeAuditFile(auditFile, logDir), true);
    assert.equal(fs.existsSync(auditFile), false);

    // 文件不存在 → 不报错
    assert.equal(sanitizeAuditFile(auditFile, logDir), false);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
});
