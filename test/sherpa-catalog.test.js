const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DEFAULT_SHERPA_MODEL_ID, SHERPA_MODELS, getSherpaModel, requireSherpaModel } = require('../src/sherpa-model-catalog');
const { RUNTIME_TARGETS, getRuntimeTarget, getRuntimeExecutablePath } = require('../src/sherpa-runtime-manifest');
const { locateSherpaRuntime } = require('../src/sherpa-runtime');
const { SherpaModelManager } = require('../src/sherpa-model-manager');

test('publishes supported Sherpa-ONNX Parakeet models', () => {
  assert.ok(SHERPA_MODELS.length >= 3);
  assert.equal(requireSherpaModel(DEFAULT_SHERPA_MODEL_ID).id, 'parakeet-ctc-0.6b');
  assert.equal(getSherpaModel('parakeet-ctc-0.6b').architecture, 'nemo_ctc');
  assert.equal(getSherpaModel('parakeet-tdt-0.6b').architecture, 'nemo_transducer');
  assert.throws(() => requireSherpaModel('non-existent-model'), /Unknown Sherpa-ONNX model/);
});

test('defines Sherpa runtime targets across platforms', () => {
  assert.deepEqual(Object.keys(RUNTIME_TARGETS).sort(), [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-x64'
  ]);
  assert.equal(getRuntimeTarget('win32', 'x64').executable, 'sherpa-onnx-offline-websocket-server.exe');
  assert.equal(getRuntimeTarget('linux', 'x64').executable, 'sherpa-onnx-offline-websocket-server');
});

test('locates packaged and environment-specified Sherpa runtimes', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-sherpa-runtime-locator-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const resourcesPath = path.join(root, 'resources');
  const packagedRuntime = path.join(resourcesPath, 'sherpa-runtime');
  fs.mkdirSync(packagedRuntime, { recursive: true });
  fs.writeFileSync(getRuntimeExecutablePath(packagedRuntime, 'win32', 'x64'), 'runtime');

  const packaged = locateSherpaRuntime({
    isPackaged: true,
    resourcesPath,
    appPath: root,
    platform: 'win32',
    architecture: 'x64',
    environment: {}
  });
  assert.equal(packaged.available, true);
  assert.equal(packaged.target, 'win32-x64');

  const missing = locateSherpaRuntime({
    isPackaged: false,
    resourcesPath,
    appPath: root,
    platform: 'win32',
    architecture: 'x64',
    environment: {}
  });
  assert.equal(missing.available, false);
});

test('SherpaModelManager downloads, verifies, and deletes model artifacts with real progress', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-sherpa-model-mgr-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const progressUpdates = [];
  const fakeFetch = async (url) => {
    // Return dummy content of size matching file.bytes
    const model = SHERPA_MODELS.find((m) => m.files.some((f) => f.url === url));
    const file = model.files.find((f) => f.url === url);
    const content = Buffer.alloc(file.bytes, 42);
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        const chunkSize = 16384;
        for (let i = 0; i < content.length; i += chunkSize) {
          yield content.subarray(i, i + chunkSize);
        }
      })()
    };
  };

  const manager = new SherpaModelManager({
    userDataPath: root,
    fetchImpl: fakeFetch,
    models: [SHERPA_MODELS[0]]
  });

  const listBefore = await manager.listModels();
  assert.equal(listBefore[0].installed, false);
  assert.equal(listBefore[0].installedBytes, 0);

  const res = await manager.download('parakeet-ctc-0.6b', (p) => progressUpdates.push(p));
  assert.equal(res.installed, true);
  assert.ok(progressUpdates.length > 0);
  assert.equal(progressUpdates[progressUpdates.length - 1].percent, 100);

  const verified = await manager.verifyInstalledModel('parakeet-ctc-0.6b');
  assert.equal(verified.modelId, 'parakeet-ctc-0.6b');
  assert.ok(fs.existsSync(verified.modelPath));
  assert.ok(fs.existsSync(verified.tokensPath));

  const listAfter = await manager.listModels();
  assert.equal(listAfter[0].installed, true);
  assert.equal(listAfter[0].installedBytes, SHERPA_MODELS[0].bytes);

  await manager.deleteModel('parakeet-ctc-0.6b');
  const listDeleted = await manager.listModels();
  assert.equal(listDeleted[0].installed, false);
});
