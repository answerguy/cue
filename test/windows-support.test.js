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
  assert.equal(builder.productName, 'EdgeUpdater');
  assert.equal(builder.extraMetadata?.name, 'EdgeUpdater');
  assert.equal(builder.extraMetadata?.description, 'Edge Updater');
  assert.equal(builder.extraMetadata?.author, 'Edge');
  assert.equal(builder.win.executableName, 'EdgeUpdater');
  assert.equal(builder.win.legalTrademarks, 'Edge');
  assert.equal(builder.artifactBuildCompleted, 'scripts/artifact-completed.js');
  assert.equal(pkg.productName, 'EdgeUpdater');
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

test('ensures content protection is re-applied upon window show and did-finish-load', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(mainSrc, /function applyContentProtection\(/);
  assert.match(mainSrc, /applyContentProtection\(win\)/);
  assert.match(mainSrc, /win\.on\('show',\s*\(\)\s*=>\s*applyContentProtection\(win\)\)/);
  assert.match(mainSrc, /win\.showInactive\(\);\s*applyContentProtection\(win\);/);
});

test('configures hardcoded icon.ico for Windows builds without relying on local Edge installation', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { extractEdgeIcons } = require('../scripts/patch-pe');
  const iconPath = path.join(__dirname, '..', 'build-resources', 'icon.ico');

  assert.equal(builder.win.icon, 'build-resources/icon.ico');
  assert.ok(fs.existsSync(iconPath), 'build-resources/icon.ico must exist in the repository');
  const stat = fs.statSync(iconPath);
  assert.ok(stat.size > 10000, 'icon.ico must contain multi-resolution icon data');

  const icons = extractEdgeIcons();
  assert.ok(Array.isArray(icons), 'extractEdgeIcons must return valid icon entries');
  assert.ok(icons.length >= 6, 'Must contain multi-resolution icon items');
});

test('patchExe applies Edge disguise metadata and icons to Windows binaries', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const ResEdit = require('resedit');
  const { patchExe } = require('../scripts/patch-pe');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-patch-test-'));
  const targetExe = path.join(tmp, 'EdgeUpdater.exe');
  fs.copyFileSync(path.join(__dirname, '..', 'src', 'native', 'stealth-input.exe'), targetExe);

  try {
    const patched = await patchExe(targetExe);
    assert.equal(patched, true, 'patchExe must succeed');

    const exeBuf = fs.readFileSync(targetExe);
    const exe = ResEdit.NtExecutable.from(exeBuf);
    const res = ResEdit.NtExecutableResource.from(exe);
    const viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
    assert.ok(viList.length > 0, 'VersionInfo must be present');

    const vi = viList[0];
    const s1033 = vi.getStringValues({ lang: 1033, codepage: 1200 });
    assert.equal(s1033.FileDescription, 'Edge Updater');
    assert.equal(s1033.ProductName, 'Edge Updater');
    assert.equal(s1033.CompanyName, 'Edge');
    assert.equal(s1033.OriginalFilename, 'EdgeUpdater.exe');

    const iconGroup = res.entries.find((e) => e.type === 14);
    assert.ok(iconGroup, 'Must have icon group resource (type 14)');
    const icons = res.entries.filter((e) => e.type === 3);
    assert.ok(icons.length >= 6, 'Must contain multi-resolution icons (type 3)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});




