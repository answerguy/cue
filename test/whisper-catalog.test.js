const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DEFAULT_MODEL_ID, WHISPER_MODELS, requireWhisperModel } = require('../src/whisper-model-catalog');
const { RUNTIME_TARGETS, getRuntimeTarget, getRuntimeExecutablePath } = require('../src/whisper-runtime-manifest');
const { locateWhisperRuntime } = require('../src/whisper-runtime');

test('publishes all 30 official model choices with immutable integrity metadata', () => {
  assert.equal(WHISPER_MODELS.length, 30);
  assert.equal(new Set(WHISPER_MODELS.map((model) => model.id)).size, 30);
  assert.equal(requireWhisperModel(DEFAULT_MODEL_ID).recommended, true);

  for (const model of WHISPER_MODELS) {
    assert.match(model.sha256, /^[a-f0-9]{64}$/);
    assert.ok(model.bytes > 30_000_000);
    assert.equal(new URL(model.url).protocol, 'https:');
    assert.equal(model.filename, `ggml-${model.id}.bin`);
  }
  assert.throws(() => requireWhisperModel('../../outside'), /Unsupported Whisper model/);
});

test('defines runtime targets for Windows, Linux, and both macOS architectures', () => {
  assert.deepEqual(Object.keys(RUNTIME_TARGETS).sort(), [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-x64'
  ]);
  assert.equal(getRuntimeTarget('win32', 'x64').executable, 'whisper-server.exe');
  assert.equal(getRuntimeTarget('darwin', 'arm64').kind, 'source');
  assert.throws(() => getRuntimeTarget('win32', 'arm64'), /not packaged/);
});

test('locates packaged and prepared development runtimes without downloading code', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-runtime-locator-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const resourcesPath = path.join(root, 'resources');
  const packagedRuntime = path.join(resourcesPath, 'whisper-runtime');
  fs.mkdirSync(packagedRuntime, { recursive: true });
  fs.writeFileSync(getRuntimeExecutablePath(packagedRuntime, 'win32', 'x64'), 'runtime');

  const packaged = locateWhisperRuntime({
    isPackaged: true,
    resourcesPath,
    appPath: root,
    platform: 'win32',
    architecture: 'x64',
    environment: {}
  });
  assert.equal(packaged.available, true);
  assert.equal(packaged.target, 'win32-x64');

  const missing = locateWhisperRuntime({
    isPackaged: false,
    resourcesPath,
    appPath: root,
    platform: 'linux',
    architecture: 'arm64',
    environment: {}
  });
  assert.equal(missing.available, false);
  assert.match(missing.message, /npm run prepare:whisper/);
});

test('locates system-installed whisper-server from PATH and environment overrides', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-runtime-path-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const binDir = path.join(root, 'custom-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const exePath = getRuntimeExecutablePath(binDir, 'win32', 'x64');
  fs.writeFileSync(exePath, 'custom-runtime');

  // 1. Found via PATH even when packaged and resourcesPath has no runtime
  const fromPath = locateWhisperRuntime({
    isPackaged: true,
    resourcesPath: path.join(root, 'non-existent-resources'),
    appPath: root,
    platform: 'win32',
    architecture: 'x64',
    environment: { PATH: `${binDir}${path.delimiter}C:\\some\\other\\dir` }
  });
  assert.equal(fromPath.available, true);
  assert.equal(fromPath.executablePath, exePath);
  assert.equal(fromPath.runtimeDirectory, binDir);

  // 2. Found via CUE_WHISPER_RUNTIME pointing directly to executable
  const fromExeOverride = locateWhisperRuntime({
    isPackaged: false,
    platform: 'win32',
    architecture: 'x64',
    environment: { CUE_WHISPER_RUNTIME: exePath }
  });
  assert.equal(fromExeOverride.available, true);
  assert.equal(fromExeOverride.executablePath, exePath);
  assert.equal(fromExeOverride.runtimeDirectory, binDir);
});

