#!/usr/bin/env node

/**
 * setup-runtimes.js
 *
 * Downloads and prepares necessary speech-to-text runtimes (whisper.cpp and sherpa-onnx)
 * on developer setup or postinstall so that anyone cloning the repository has working
 * local STT without committing large binary archives to git.
 */

const { prepareWhisperRuntime } = require('./prepare-whisper-runtime');
const { prepareSherpaRuntime } = require('./prepare-sherpa-runtime');
const { getRuntimeTarget } = require('../src/whisper-runtime-manifest');

async function setup() {
  const platform = process.platform;
  const architecture = process.arch;
  console.log(`[cue] Preparing speech-to-text runtimes for ${platform}-${architecture}...`);

  // 1. Prepare whisper.cpp runtime
  try {
    const target = getRuntimeTarget(platform, architecture);
    if (target.kind === 'archive') {
      console.log('[cue] Downloading and verifying whisper.cpp runtime...');
      await prepareWhisperRuntime({ platform, architecture });
      console.log('[cue] ✓ whisper.cpp runtime ready');
    } else {
      console.log('[cue] Note: macOS whisper.cpp builds from source on demand (run "npm run prepare:whisper").');
    }
  } catch (error) {
    console.warn(`[cue] Notice: whisper.cpp runtime setup was skipped: ${error.message}`);
    console.warn(`[cue] You can run "npm run prepare:whisper" once connected to the internet.`);
  }

  // 2. Prepare sherpa-onnx runtime
  try {
    console.log('[cue] Downloading and verifying sherpa-onnx runtime...');
    await prepareSherpaRuntime({ platform, architecture });
    console.log('[cue] ✓ sherpa-onnx runtime ready');
  } catch (error) {
    console.warn(`[cue] Notice: sherpa-onnx runtime setup was skipped: ${error.message}`);
    console.warn(`[cue] You can run "npm run prepare:sherpa" once connected to the internet.`);
  }
}

if (require.main === module) {
  setup().catch((error) => {
    console.error('[cue] setup-runtimes encountered an error:', error);
  });
}

module.exports = { setup };
