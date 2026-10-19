/**
 * 测试夹具：临时数据目录
 *
 * 多个测试文件都需要把 `FARM_DATA_DIR` / `FARM_LOG_DIR` 指向临时目录，
 * 并在结束时恢复原值。这里集中实现，避免每个文件各写一份环境变量恢复逻辑
 * （漏掉任何一个分支都会污染同进程内其它测试文件）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 测试日志固定写到这里，不随数据目录一起删除（winston transport 会一直持有句柄） */
const SHARED_TEST_LOG_DIR = path.join(os.tmpdir(), 'qf-test-logs');

function restoreEnv(name, previous) {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

/**
 * 创建临时数据目录并切换环境变量，测试结束后自动恢复并删除目录。
 * @param {import('node:test').TestContext|Function} context - 测试上下文（用其 after），或直接传 after 注册函数
 * @param {object} [options]
 * @param {string} [options.prefix] - 临时目录前缀
 * @returns {{ dataDir: string, logDir: string }}
 */
function useTempDataDir(context, options = {}) {
  const registerCleanup = typeof context === 'function'
    ? context
    : (fn) => context.after(fn);
  const prefix = String(options.prefix || 'qf-test-');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const logDir = String(options.logDir || SHARED_TEST_LOG_DIR);
  const previousDataDir = process.env.FARM_DATA_DIR;
  const previousLogDir = process.env.FARM_LOG_DIR;

  fs.mkdirSync(logDir, { recursive: true });
  process.env.FARM_DATA_DIR = dataDir;
  process.env.FARM_LOG_DIR = logDir;

  registerCleanup(() => {
    restoreEnv('FARM_DATA_DIR', previousDataDir);
    restoreEnv('FARM_LOG_DIR', previousLogDir);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  return { dataDir, logDir };
}

module.exports = { useTempDataDir, SHARED_TEST_LOG_DIR };
