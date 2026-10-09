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

test('stealth hook manager handles onNoFocusToggle, onTransparencyToggle, onStateChange, onShortcut, onDelete, arrow keys, and onSelectAll callbacks', async () => {
  let toggledNoFocus = false;
  let toggledTransparency = false;
  let stateChanged = null;
  let receivedShortcut = null;
  let receivedDelete = false;
  let receivedLeft = false;
  let receivedRight = false;
  let receivedUp = false;
  let receivedDown = false;
  let receivedPageUp = false;
  let receivedPageDown = false;
  let receivedHome = false;
  let receivedEnd = false;
  let receivedSelectAll = false;
  let receivedHistoryToggle = false;

  const manager = createStealthHookManager({
    onNoFocusToggle: () => { toggledNoFocus = true; },
    onTransparencyToggle: () => { toggledTransparency = true; },
    onStateChange: (state) => { stateChanged = state; },
    onShortcut: (action) => { receivedShortcut = action; },
    onDelete: () => { receivedDelete = true; },
    onArrowLeft: () => { receivedLeft = true; },
    onArrowRight: () => { receivedRight = true; },
    onArrowUp: () => { receivedUp = true; },
    onArrowDown: () => { receivedDown = true; },
    onPageUp: () => { receivedPageUp = true; },
    onPageDown: () => { receivedPageDown = true; },
    onHome: () => { receivedHome = true; },
    onEnd: () => { receivedEnd = true; },
    onSelectAll: () => { receivedSelectAll = true; },
    onHistoryToggle: () => { receivedHistoryToggle = true; }
  });

  assert.equal(manager.isAvailable(), process.platform === 'win32');
  if (process.platform === 'win32') {
    assert.equal(manager.setTransparency(true), true);
    assert.equal(manager.setTransparency(false), true);
  }
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

test('stealth-hook-manager resolves app.asar.unpacked when running from asar', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'stealth-hook-manager.js'), 'utf8');
  assert.match(src, /app\.asar\.unpacked/);
});

