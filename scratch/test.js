const { prepareWhisperRuntime } = require('../scripts/prepare-whisper-runtime');

async function main() {
  try {
    const res = await prepareWhisperRuntime();
    console.log('RESULT:', res);
  } catch (err) {
    console.error('ERROR:', err);
  }
}

main();
