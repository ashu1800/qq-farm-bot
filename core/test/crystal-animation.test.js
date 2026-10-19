const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

/**
 * 找到可用的 Python 3。
 *
 * Windows 上 `python3` 常常只是 Microsoft Store 的占位符（退出码 9009），
 * 真正可用的是 `py` 或 `python`。这里按顺序探测，跳过不可执行的占位符。
 */
function resolvePython() {
  for (const command of ['python3', 'python', 'py']) {
    const probe = spawnSync(command, ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) continue;
    if (!/^Python 3\./i.test(String(probe.stdout || probe.stderr || '').trim())) continue;
    return command;
  }
  return null;
}

test('official crystal resources match recorded hashes and default clip', () => {
  const root = path.join(__dirname, '../src/gameConfig/effect_images/mutant/jinghui');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'sources.json')));
  for (const entry of manifest.files) {
    const bytes = fs.readFileSync(path.join(root, entry.file));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.file);
  }
  const clip = JSON.parse(fs.readFileSync(path.join(root, 'anim_loop_1.json'))).document[0];
  assert.equal(clip._name, manifest.defaultClip);
  assert.equal(clip.sample, 60);
  assert.equal(clip._duration, 80 / 60);
});

test('offline curve extraction reproduces checked-in animation and preserves key values', (t) => {
  const python = resolvePython();
  if (!python) {
    t.skip('未找到可用的 Python 3');
    return;
  }
  const result = spawnSync(python, ['-c', `
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location('crystal', 'scripts/generate-crystal-animation.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
assert m.generate() == (m.ROOT / 'web/src/styles/official-crystal-animation.css').read_text()
doc = json.loads((m.ASSETS / 'anim_loop_1.json').read_text())['document']
binary = (m.ASSETS / 'anim_loop_1.bin').read_bytes()
for item in doc:
    if item.get('__type__') != 'cc.RealCurve': continue
    keys = m.read_curve(item['bytes'], binary)
    for key in keys:
        assert abs(m.evaluate(keys, key['time']) - key['value']) < 1e-6
`], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
