const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Module = require('node:module');
// electron-builder's Arch enum, inlined rather than imported: `builder-util` is a
// transitive dependency of electron-builder, not a declared one, so requiring it made
// this script (and its test) fail wherever electron-builder is not installed.
const Arch = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal',
               ia32: 0, x64: 1, armv7l: 2, arm64: 3, universal: 4 };

// Regression test for cue-windows-whisper-runtime-missing: packaged Windows
// (and Linux) installers shipped without resources/whisper-runtime, so local
// Whisper transcription always reported "The packaged Whisper runtime for
// win32-x64 is missing." — even though the README promises "Packaged builds
// include a pinned whisper.cpp runtime." Root cause: scripts/after-pack.js's
// bundling step was gated entirely behind CUE_BUNDLE_WHISPER=1, which no
// build script or CI workflow (dist:win, dist:linux, release.yml) ever set.
//
// Windows/Linux fetch a checksum-verified upstream release archive over the
// network only (no local toolchain), so they must bundle by default. macOS
// builds from source with cmake and a source-archive checksum that is known
// to be fragile (see whisper-runtime-manifest.js), so it stays opt-in.

let capturedPrepareCalls = [];
const originalModuleLoad = Module._load;

Module._load = function loadWithPrepareWhisperStub(request, parent, isMain) {
  if (request === './prepare-whisper-runtime' || request === '../scripts/prepare-whisper-runtime') {
    return {
      prepareWhisperRuntime: async (options) => {
        capturedPrepareCalls.push(options);
      }
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

delete require.cache[require.resolve('../scripts/after-pack.js')];
const afterPack = require('../scripts/after-pack.js');

test.after(() => {
  Module._load = originalModuleLoad;
  delete require.cache[require.resolve('../scripts/after-pack.js')];
});

function fakeContext(nodeName, archName) {
  const archNumber = Number(Object.keys(Arch).find((key) => Arch[key] === archName));
  return {
    packager: { platform: { nodeName } },
    arch: archNumber,
    appOutDir: path.join('fake', 'appOutDir')
  };
}

test.beforeEach(() => {
  capturedPrepareCalls = [];
  delete process.env.CUE_BUNDLE_WHISPER;
});

test.after(() => {
  delete process.env.CUE_BUNDLE_WHISPER;
});

test('bundles the checksum-verified archive runtime by default on win32-x64', async () => {
  await afterPack(fakeContext('win32', 'x64'));
  assert.equal(capturedPrepareCalls.length, 1);
  assert.equal(capturedPrepareCalls[0].platform, 'win32');
  assert.equal(capturedPrepareCalls[0].architecture, 'x64');
});

test('bundles the checksum-verified archive runtime by default on linux-x64', async () => {
  await afterPack(fakeContext('linux', 'x64'));
  assert.equal(capturedPrepareCalls.length, 1);
});

test('does not bundle the from-source macOS runtime by default (needs cmake/Xcode)', async () => {
  await afterPack(fakeContext('darwin', 'arm64'));
  assert.equal(capturedPrepareCalls.length, 0);
});

test('CUE_BUNDLE_WHISPER=1 still opts macOS in explicitly', async () => {
  process.env.CUE_BUNDLE_WHISPER = '1';
  await afterPack(fakeContext('darwin', 'x64'));
  assert.equal(capturedPrepareCalls.length, 1);
});

test('CUE_BUNDLE_WHISPER=0 still opts win32 out explicitly (fast local pack)', async () => {
  process.env.CUE_BUNDLE_WHISPER = '0';
  await afterPack(fakeContext('win32', 'x64'));
  assert.equal(capturedPrepareCalls.length, 0);
});
