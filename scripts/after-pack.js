const path = require('path');
const { Arch } = require('builder-util');
const { prepareWhisperRuntime } = require('./prepare-whisper-runtime');
const { getRuntimeTarget } = require('../src/whisper-runtime-manifest');

/** Add the matching native runtime after Electron has assembled each target.
 *
 * On by default for Windows and Linux: those targets fetch a checksum-verified
 * upstream release archive over the network only, no local toolchain, so
 * every packaged Windows/Linux build ships local transcription, matching what
 * the README promises ("Packaged builds include a pinned whisper.cpp
 * runtime"). macOS instead builds whisper.cpp from source with cmake, which
 * needs Xcode command-line tools and a slower, toolchain-dependent build —
 * and its pinned source-archive checksum is the fragile one (see the note in
 * whisper-runtime-manifest.js) — so macOS stays opt-in via CUE_BUNDLE_WHISPER=1
 * to keep `npm run dist:mac`/`dist` and the signed macOS release from
 * suddenly requiring a local C++ toolchain. Set CUE_BUNDLE_WHISPER=0 to skip
 * bundling on Windows/Linux too (a faster pack for local iteration).
 */
module.exports = async function afterPack(context) {
  const platform = context.packager.platform.nodeName;
  const architecture = typeof context.arch === 'number' ? Arch[context.arch] : context.arch;
  if (!platform || !architecture) throw new Error('electron-builder did not provide a runtime target.');

  const target = getRuntimeTarget(platform, architecture);
  const explicitChoice = process.env.CUE_BUNDLE_WHISPER;
  const bundleWhisper = explicitChoice ? explicitChoice !== '0' : target.kind === 'archive';
  if (!bundleWhisper) {
    console.log('[cue] Skipping the bundled whisper runtime (set CUE_BUNDLE_WHISPER=1 to include it on this platform).');
    return;
  }

  const outputDirectory = path.join(context.appOutDir, 'resources', 'whisper-runtime');
  await prepareWhisperRuntime({ platform, architecture, outputDirectory });
};
