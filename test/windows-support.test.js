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

test('enables asar for fast portable launch while unpacking native stealth binary', () => {
  assert.equal(builder.asar, true);
  assert.ok(Array.isArray(builder.asarUnpack) && builder.asarUnpack.includes('src/native/**/*'));
});

test('after-pack copies src/portable-config.json to appOutDir if present', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const afterPack = require('../scripts/after-pack');
  const tempOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-afterpack-test-'));
  const srcConfig = path.join(__dirname, '..', 'src', 'portable-config.json');
  const createdMock = !fs.existsSync(srcConfig);
  if (createdMock) {
    fs.writeFileSync(srcConfig, JSON.stringify({ provider: 'test' }));
  }
  try {
    await afterPack({
      packager: { platform: { nodeName: 'win32' } },
      arch: 'x64',
      appOutDir: tempOutDir
    });
    const copiedConfig = path.join(tempOutDir, 'portable-config.json');
    assert.ok(fs.existsSync(copiedConfig));
  } finally {
    if (createdMock) {
      try { fs.rmSync(srcConfig, { force: true }); } catch (_) {}
    }
    try { fs.rmSync(tempOutDir, { recursive: true, force: true }); } catch (_) {}
  }
});


