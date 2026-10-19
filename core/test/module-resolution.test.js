const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 静态检查所有 core/src 下的相对 require 都能解析。
// 历史问题：worker.js 曾引用不存在的 services/farm-scene，调用时才抛 MODULE_NOT_FOUND。
const SRC_ROOT = path.join(__dirname, '..', 'src');

function listJsFiles(dir, output = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) listJsFiles(fullPath, output);
    else if (fullPath.endsWith('.js')) output.push(fullPath);
  }
  return output;
}

test('every relative require in core/src resolves', () => {
  const missing = [];
  for (const file of listJsFiles(SRC_ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/require\('(\.[^']+)'\)/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      const candidates = [target, `${target}.js`, path.join(target, 'index.js')];
      if (!candidates.some(candidate => fs.existsSync(candidate))) {
        missing.push(`${path.relative(SRC_ROOT, file)} -> ${match[1]}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
