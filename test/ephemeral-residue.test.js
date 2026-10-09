const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

test('install.ps1 places cue in volatile TEMP folder, creates no shortcuts, and avoids registry modifications', () => {
  const installPs1 = fs.readFileSync(path.join(__dirname, '..', 'install.ps1'), 'utf8');

  // Must target %TEMP%\cue for natural reboot volatility
  assert.match(installPs1, /Join-Path\s+\$env:TEMP\s+"cue"/);

  // Must NOT create shortcuts
  assert.ok(!installPs1.includes('CreateShortcut'), 'install.ps1 must not create any shortcuts');

  // Must remove residual desktop/programs shortcuts
  assert.match(installPs1, /Remove Residual Shortcuts|Remove Any Shortcuts/i);
  assert.match(installPs1, /Cue\.lnk/);
  assert.match(installPs1, /Desktop/);

  // Must NOT write to RunOnce registry
  assert.ok(!installPs1.includes('Set-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce"'), 'install.ps1 must not write to RunOnce registry');
});

test('main.js performs pure in-process Node.js cleanup without background jobs, hidden processes, or registry edits', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  // Must NOT contain hidden process spawns or registry modifications
  assert.ok(!mainSrc.includes('registerRebootCleanup'), 'main.js must not contain registerRebootCleanup');
  assert.ok(!mainSrc.includes('scheduleSelfDeletion'), 'main.js must not contain scheduleSelfDeletion');
  assert.ok(!mainSrc.includes('-WindowStyle'), 'main.js must not spawn hidden PowerShell processes');
  assert.ok(!mainSrc.includes('reg add'), 'main.js must not execute reg add');

  // Pure in-process shortcut cleanup
  assert.match(mainSrc, /function removeResidualShortcuts\(\)/);
  assert.match(mainSrc, /removeResidualShortcuts\(\);/);

  // Pure in-process purgeAppData removes config, shortcuts, and appdata
  assert.match(mainSrc, /function purgeAppData\(\)/);
  assert.match(mainSrc, /findExternalConfig\(\)/);
  assert.match(mainSrc, /config\.json/);

  // Signal handlers for clean exit on SIGINT and SIGTERM
  assert.match(mainSrc, /process\.on\('SIGINT'/);
  assert.match(mainSrc, /process\.on\('SIGTERM'/);
});

test('store maintains ephemeral in-memory state when portable config is loaded, even if config file is deleted', () => {
  const originalModuleLoad = Module._load;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-ephem-test-'));
  const tempConfigFile = path.join(dir, 'test-portable-config.json');

  const configData = {
    provider: 'gemini',
    apiKeys: { gemini: 'test-ephemeral-key' },
    quietMode: true
  };
  fs.writeFileSync(tempConfigFile, JSON.stringify(configData, null, 2));
  process.env.CUE_PORTABLE_CONFIG_PATH = tempConfigFile;

  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => dir } };
    return originalModuleLoad.call(this, request, parent, isMain);
  };

  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/settings-store-core')];
  const store = require('../src/store');
  Module._load = originalModuleLoad;

  try {
    assert.equal(store.getSettings().provider, 'gemini');
    assert.equal(store.isPortableConfigActive(), true);

    // Simulate deleting the config file from disk (as happens on cleanup/exit)
    fs.rmSync(tempConfigFile, { force: true });
    assert.equal(fs.existsSync(tempConfigFile), false, 'Config file should be deleted');

    // Store must still recognize the session as portable and NOT write cue-data.json
    assert.equal(store.isPortableConfigActive(), true);
    store.setSettings({ opacity: 0.5 });
    assert.equal(store.getSettings().opacity, 0.5);

    const appDataFile = path.join(dir, 'cue-data.json');
    assert.equal(fs.existsSync(appDataFile), false, 'Must never create cue-data.json in user data');
  } finally {
    delete process.env.CUE_PORTABLE_CONFIG_PATH;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('main.js preserves whisper-models and sherpa-models directories during purgeAppData', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(mainSrc, /function purgeDirectoryExceptModels\(/);
  assert.match(mainSrc, /whisper-models/);
  assert.match(mainSrc, /sherpa-models/);
  assert.match(mainSrc, /getPersistentModelsPath\(\)/);
});

test('main.js only deletes config file when running in portable mode', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(mainSrc, /function isPortableMode\(\)/);
  assert.match(mainSrc, /if\s*\(isPortableMode\(\)\)\s*\{/);
});


