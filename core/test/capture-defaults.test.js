const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 抓包服务「默认开启」是 README、DEFAULT_CAPTURE_CONFIG、启动流程三方共同承诺的行为。
// 这里同时约束配置默认值和 startAdminServer 里的启动调用，避免再出现
// 「配置默认开启但启动时没人调用」的回归。

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('capture config defaults to enabled and embedded', () => {
  // store 在加载时会创建 winston transport，日志目录必须持续存在；
  // 因此日志写到固定的测试目录，只清理数据目录。
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-capture-defaults-'));
  const logDir = path.join(os.tmpdir(), 'qf-test-logs');
  const previousDataDir = process.env.FARM_DATA_DIR;
  const previousLogDir = process.env.FARM_LOG_DIR;
  process.env.FARM_DATA_DIR = dataDir;
  process.env.FARM_LOG_DIR = logDir;

  delete require.cache[require.resolve('../src/models/store')];
  const store = require('../src/models/store');

  try {
    assert.equal(store.DEFAULT_CAPTURE_CONFIG.enabled, true);
    assert.equal(store.DEFAULT_CAPTURE_CONFIG.embedded, true);
    assert.equal(store.getCaptureConfig().enabled, true);
    assert.equal(store.getCaptureConfig().embedded, true);
  } finally {
    if (previousDataDir === undefined) delete process.env.FARM_DATA_DIR;
    else process.env.FARM_DATA_DIR = previousDataDir;
    if (previousLogDir === undefined) delete process.env.FARM_LOG_DIR;
    else process.env.FARM_LOG_DIR = previousLogDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('admin server starts the embedded capture service on boot', () => {
  const source = readSource('src/controllers/admin.js');

  // 启动流程里必须真的调用，而不是只打一句“默认关闭”的日志
  assert.match(source, /startEmbeddedCaptureService\(\);/);
  assert.doesNotMatch(source, /抓包服务默认关闭/);
});

test('README claim matches the default-on behaviour', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
  assert.match(readme, /抓包服务均默认开启/);
});
