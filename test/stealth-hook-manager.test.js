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
    manager.stop();
    assert.equal(manager.isCapturing(), false);
  }
  manager.dispose();
});
