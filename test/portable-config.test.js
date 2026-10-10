const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const originalModuleLoad = Module._load;

function openStoreWithConfig({ configData, userDataDir }) {
  const dir = userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'cue-port-test-'));
  const tempConfigFile = path.join(dir, 'test-portable-config.json');
  if (configData !== undefined) {
    fs.writeFileSync(tempConfigFile, JSON.stringify(configData, null, 2));
    process.env.CUE_PORTABLE_CONFIG_PATH = tempConfigFile;
  } else {
    delete process.env.CUE_PORTABLE_CONFIG_PATH;
  }

  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => dir } };
    return originalModuleLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/settings-store-core')];
  const store = require('../src/store');
  Module._load = originalModuleLoad;

  return {
    store,
    dir,
    tempConfigFile,
    cleanup: () => {
      delete process.env.CUE_PORTABLE_CONFIG_PATH;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  };
}

test('portable-config.example.json exists, is valid JSON, and defines all schema fields', () => {
  const examplePath = path.join(__dirname, '..', 'src', 'portable-config.example.json');
  assert.ok(fs.existsSync(examplePath), 'portable-config.example.json must exist');
  const content = JSON.parse(fs.readFileSync(examplePath, 'utf8'));

  assert.equal(typeof content.provider, 'string');
  assert.equal(typeof content.sttProvider, 'string');
  assert.equal(typeof content.apiKeys, 'object');
  assert.ok('anthropic' in content.apiKeys);
  assert.ok('openai' in content.apiKeys);
  assert.ok('gemini' in content.apiKeys);
  assert.ok('groq' in content.apiKeys);
  assert.ok('deepgram' in content.apiKeys);
  assert.equal(typeof content.models, 'object');
  assert.ok('anthropic' in content.models);
  assert.ok('openai' in content.models);
  assert.ok('gemini' in content.models);
  assert.ok('hrConfig' in content);
  assert.ok('resumeConfig' in content);
  assert.equal(content.quietMode, true);
});

test('store uses portable-config as the sole source of truth when present', () => {
  const customConfig = {
    provider: 'anthropic',
    sttProvider: 'deepgram',
    quietMode: true,
    apiKeys: {
      anthropic: 'sk-ant-test-deploy-key',
      openai: 'sk-proj-test-deploy-key',
      deepgram: 'dg-test-deploy-key'
    },
    hrConfig: 'My prepared behavioral stories for associates',
    resumeConfig: 'Full candidate experience details'
  };

  const { store, dir, cleanup } = openStoreWithConfig({ configData: customConfig });
  try {
    const settings = store.getSettings();
    assert.equal(settings.provider, 'anthropic');
    assert.equal(settings.sttProvider, 'deepgram');
    assert.equal(settings.quietMode, true);
    assert.equal(settings.apiKeys.anthropic, 'sk-ant-test-deploy-key');
    assert.equal(settings.apiKeys.openai, 'sk-proj-test-deploy-key');
    assert.equal(settings.apiKeys.deepgram, 'dg-test-deploy-key');
    assert.equal(settings.hrConfig, 'My prepared behavioral stories for associates');
    assert.equal(settings.resumeConfig, 'Full candidate experience details');

    // Verify it did NOT create or persist cue-data.json in userData
    const appDataFile = path.join(dir, 'cue-data.json');
    assert.equal(fs.existsSync(appDataFile), false, 'Must not touch cue-data.json in appdata');

    // Updating settings in memory does not write cue-data.json
    store.setSettings({ opacity: 0.8 });
    assert.equal(store.getSettings().opacity, 0.8);
    assert.equal(fs.existsSync(appDataFile), false, 'Must not write cue-data.json on save');

    // publik auto-default never overrides the configured provider
    assert.equal(store.applyPublikDefault({ available: true, appToken: 'token' }), false);
    assert.equal(store.getSettings().provider, 'anthropic');
  } finally {
    cleanup();
  }
});

test('quietMode startup setting is integrated across store defaults, renderer boot, and settings UI', () => {
  const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'store.js'), 'utf8');
  const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

  // store DEFAULTS includes quietMode: false
  assert.match(storeSrc, /quietMode:\s*false/);

  // Settings UI has s-quiet-mode toggle checkbox
  assert.match(indexHtml, /id="s-quiet-mode"/);

  // renderer.js reads s-quiet-mode in openSettings and saves it in saveSettings
  assert.match(rendererSrc, /const quietModeEl = \$\('#s-quiet-mode'\)/);
  assert.match(rendererSrc, /settings\.quietMode = !!quietModeEl\.checked/);

  // renderer boot checks settings.quietMode and invokes toggleQuietMode(true)
  assert.match(rendererSrc, /if \(settings && settings\.quietMode\) \{\s*toggleQuietMode\(true\);/);
});

test('store supports custom provider baseUrl inside models.custom as well as root baseUrl', () => {
  const customConfig = {
    provider: 'custom',
    models: {
      custom: {
        baseUrl: 'https://api.together.xyz/v1',
        fast: 'meta-llama/Llama-3-8b-chat-hf',
        smart: 'meta-llama/Llama-3-70b-chat-hf'
      }
    },
    apiKeys: {
      custom: 'custom-api-key-test'
    }
  };

  const { store, cleanup } = openStoreWithConfig({ configData: customConfig });
  try {
    const settings = store.getSettings();
    assert.equal(settings.provider, 'custom');
    assert.equal(settings.baseUrl, 'https://api.together.xyz/v1');
    assert.equal(settings.models.custom.baseUrl, 'https://api.together.xyz/v1');
    assert.equal(settings.models.custom.fast, 'meta-llama/Llama-3-8b-chat-hf');
  } finally {
    cleanup();
  }
});

test('store detects config.json in PORTABLE_EXECUTABLE_DIR next to portable executable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-port-folder-test-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    provider: 'gemini',
    apiKeys: { gemini: 'test-gemini-key-from-config-json' }
  }));

  process.env.PORTABLE_EXECUTABLE_DIR = dir;
  process.env.CUE_PORTABLE_CONFIG = '1';

  const { store, cleanup } = openStoreWithConfig({ configData: undefined, userDataDir: dir });

  try {
    assert.equal(store.getPortableConfigPath(), configPath);
    assert.equal(store.isPortableConfigActive(), true);
    const settings = store.getSettings();
    assert.equal(settings.provider, 'gemini');
    assert.equal(settings.apiKeys.gemini, 'test-gemini-key-from-config-json');
  } finally {
    delete process.env.PORTABLE_EXECUTABLE_DIR;
    delete process.env.CUE_PORTABLE_CONFIG;
    cleanup();
  }
});

test('store starts with blank slate when no config.json exists in PORTABLE_EXECUTABLE_DIR', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-port-empty-test-'));
  process.env.PORTABLE_EXECUTABLE_DIR = dir;
  process.env.CUE_PORTABLE_CONFIG = '1';

  const { store, cleanup } = openStoreWithConfig({ configData: undefined, userDataDir: dir });

  try {
    assert.equal(store.getPortableConfigPath(), null);
    assert.equal(store.isPortableConfigActive(), false);
    const settings = store.getSettings();
    assert.equal(settings.provider, 'openai');
    assert.equal(settings.apiKeys.openai, '');
    assert.equal(settings.apiKeys.gemini, '');
    assert.equal(settings.apiKeys.anthropic, '');
  } finally {
    delete process.env.PORTABLE_EXECUTABLE_DIR;
    delete process.env.CUE_PORTABLE_CONFIG;
    cleanup();
  }
});
