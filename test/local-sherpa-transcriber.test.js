const assert = require('node:assert/strict');
const test = require('node:test');
const { LocalSherpaTranscriber } = require('../src/local-sherpa-transcriber');

test('LocalSherpaTranscriber serializes channels and delivers transcripts', async () => {
  let activeInferences = 0;
  let maximumConcurrency = 0;
  const transcripts = [];

  const fakeSession = {
    startCalls: 0,
    stopCalls: 0,
    async start() { this.startCalls += 1; },
    async transcribe(pcm) {
      activeInferences += 1;
      maximumConcurrency = Math.max(maximumConcurrency, activeInferences);
      await new Promise((resolve) => setImmediate(resolve));
      activeInferences -= 1;
      return pcm.toString();
    },
    abortInferences() {},
    async stop() { this.stopCalls += 1; }
  };

  const transcriber = new LocalSherpaTranscriber({
    sessionOptions: {},
    sessionFactory: () => fakeSession,
    segmenterFactory: (options) => ({
      push(pcm) {
        options.onUtterance(options.channel, Buffer.from(pcm));
      },
      stop() {}
    }),
    rmsGate: 0,
    onTranscript: (channel, text) => transcripts.push({ channel, text })
  });

  await transcriber.start();
  transcriber.push('you', Buffer.from('hello'));
  transcriber.push('them', Buffer.from('world'));
  await transcriber.queueTail;
  await transcriber.stop();

  assert.equal(fakeSession.startCalls, 1);
  assert.equal(fakeSession.stopCalls, 1);
  assert.equal(maximumConcurrency, 1);
  assert.deepEqual(transcripts, [
    { channel: 'you', text: 'hello' },
    { channel: 'them', text: 'world' }
  ]);
});

test('LocalSherpaTranscriber drops hallucination text and skips silent buffers under rms gate', async () => {
  const transcripts = [];
  const fakeSession = {
    async start() {},
    async transcribe(pcm) {
      const str = pcm.toString();
      if (str === 'hallucination') return 'Thank you for watching.';
      return 'Valid speech here.';
    },
    abortInferences() {},
    async stop() {}
  };

  const transcriber = new LocalSherpaTranscriber({
    sessionOptions: {},
    sessionFactory: () => fakeSession,
    segmenterFactory: (options) => ({
      push(pcm) {
        options.onUtterance(options.channel, Buffer.from(pcm));
      },
      stop() {}
    }),
    rmsGate: 100,
    onTranscript: (channel, text) => transcripts.push({ channel, text })
  });

  await transcriber.start();

  // 1. Silent buffer under RMS gate -> skipped
  const silentPcm = Buffer.alloc(1600, 0);
  transcriber.push('you', silentPcm);

  // 2. Buffer that returns hallucination phrase -> dropped
  const loudPcm = Buffer.alloc(1600);
  for (let i = 0; i < 800; i++) loudPcm.writeInt16LE(5000, i * 2);
  // Simulate segmenter emitting 'hallucination'
  transcriber.push('you', Buffer.from('hallucination'));

  await transcriber.queueTail;
  await transcriber.stop();

  assert.equal(transcripts.length, 0);
});
