const { prepareWhisperRuntime } = require('../scripts/prepare-whisper-runtime');

async function test() {
  console.log('Starting prepareWhisperRuntime...');
  try {
    const res = await prepareWhisperRuntime();
    console.log('Result:', res);
  } catch (err) {
    console.error('Caught error:', err);
  }
}

test();
