const assert = require('node:assert/strict');
const test = require('node:test');

const builder = require('../electron-builder.cjs');
const pkg = require('../package.json');
const { patchExe } = require('../scripts/patch-pe');

test('defines an explicit Windows x64 package target', () => {
  assert.equal(pkg.scripts['pack:win'], 'electron-builder --win --dir');
  assert.equal(pkg.scripts['dist:win'], 'electron-builder --win');
  assert.equal(pkg.scripts['dist:win:portable'], 'electron-builder --win portable');
  assert.deepEqual(builder.win.target, [{ target: 'portable', arch: ['x64'] }]);
});

test('configures Edge Updater identity for Windows releases', () => {
  assert.equal(builder.extraMetadata?.description, 'Edge Updater');
  assert.equal(builder.extraMetadata?.author, 'Edge');
  assert.equal(builder.win.executableName, 'EdgeUpdater');
  assert.equal(builder.win.legalTrademarks, 'Edge');
  assert.equal(builder.artifactBuildCompleted, 'scripts/artifact-completed.js');
});

test('ships every runtime directory in packaged builds', () => {
  assert.ok(builder.files.includes('main.js'));
  assert.ok(builder.files.includes('preload.js'));
  assert.ok(builder.files.includes('src/**/*'));
  assert.ok(builder.files.includes('renderer/**/*'));
});
