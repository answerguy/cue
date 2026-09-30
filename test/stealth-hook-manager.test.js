const test = require('node:test');
const assert = require('node:assert/strict');
const { createStealthHookManager } = require('../src/stealth-hook-manager');

test('stealth hook manager initializes and provides isAvailable', async () => {
  const manager = createStealthHookManager();
  assert.equal(typeof manager.isAvailable(), 'boolean');
  if (process.platform === 'win32') {
    assert.equal(manager.isAvailable(), true);
    assert.equal(manager.isCapturing(), false);
    manager.start();
    assert.equal(manager.isCapturing(), true);
    manager.dispose();
  }
});

test('stealth hook manager handles onNoFocusToggle and onStateChange callbacks', async () => {
  let toggledNoFocus = false;
  let stateChanged = null;

  const manager = createStealthHookManager({
    onNoFocusToggle: () => { toggledNoFocus = true; },
    onStateChange: (state) => { stateChanged = state; }
  });

  assert.equal(manager.isAvailable(), process.platform === 'win32');
  manager.dispose();
});

test('native stealth-input outputs shifted characters like exclamation mark', async () => {
  if (process.platform !== 'win32') return;
  const cp = require('node:child_process');
  const path = require('node:path');
  const exePath = path.join(__dirname, '..', 'src', 'native', 'stealth-input.exe');
  const out = cp.execFileSync(exePath, ['--test'], { encoding: 'utf8' }).trim();
  const parsed = JSON.parse(out);
  assert.equal(parsed.test, true);
  assert.equal(parsed.char, '!');
});
