const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isTransientNetworkError } = require('../src/utils/network-errors');

test('transient network errors cover connection, timeout and queue pressure', () => {
  for (const message of [
    '连接未打开: GetAllLands',
    '请求超时: GetAllLands (seq=3, pending=2)',
    '请求调度队列已满: queued=100',
    '请求队列已满: GetAllLands (pending=10)',
    '连接已在加密途中关闭',
    'Worker exited',
  ]) {
    assert.equal(isTransientNetworkError(new Error(message)), true, message);
  }
});

test('business and argument errors are not treated as transient', () => {
  for (const message of [
    '账号未运行',
    'code=1002003 封禁',
    '没有可种植的种子',
  ]) {
    assert.equal(isTransientNetworkError(new Error(message)), false, message);
  }
  assert.equal(isTransientNetworkError(null), false);
  assert.equal(isTransientNetworkError(''), false);
});

test('services share one classifier implementation', () => {
  const root = path.join(__dirname, '..', 'src');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full.endsWith('.js')) files.push(full);
    }
  };
  walk(root);

  const definitions = files.filter((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return /function isTransientNetworkError/.test(source);
  });
  assert.deepEqual(
    definitions.map(file => path.relative(root, file)).sort(),
    [path.join('utils', 'network-errors.js')],
    '只允许在 utils/network-errors.js 中定义瞬态错误判定',
  );
});
