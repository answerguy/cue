const assert = require('node:assert/strict');
const test = require('node:test');
const { LocalWhisperTranscriber } = require('../src/local-whisper-transcriber');

test('serializes both channels through one persistent session', async () => {
  let activeInferences = 0;
  let maximumConcurrency = 0;
  const transcribedChannels = [];
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

  const transcriber = new LocalWhisperTranscriber({
    sessionOptions: {},
    sessionFactory: () => fakeSession,
    segmenterFactory: (options) => ({
      push(pcm) {
        transcribedChannels.push(options.channel);
        options.onUtterance(options.channel, Buffer.from(pcm));
      },
      stop() {}
    }),
    onTranscript: (channel, text) => transcripts.push({ channel, text })
  });

  await transcriber.start();
  transcriber.push('you', Buffer.from('first'));
  transcriber.push('them', Buffer.from('second'));
  await transcriber.queueTail;
  await transcriber.stop();

  assert.equal(fakeSession.startCalls, 1);
  assert.equal(fakeSession.stopCalls, 1);
  assert.equal(maximumConcurrency, 1);
  assert.deepEqual(transcribedChannels, ['you', 'them']);
  assert.deepEqual(transcripts, [
    { channel: 'you', text: 'first' },
    { channel: 'them', text: 'second' }
  ]);
});

test('bounds shutdown drain time before aborting an in-flight inference', async () => {
  let rejectInference;
  const stopOptions = [];
  const reportedErrors = [];
  let abortCalls = 0;
  let transcribeCalls = 0;
  const fakeSession = {
    async start() {},
    async transcribe() {
      transcribeCalls += 1;
      return new Promise((_resolve, reject) => { rejectInference = reject; });
    },
    abortInferences() {
      abortCalls += 1;
      rejectInference(new Error('inference aborted'));
    },
    async stop(options) { stopOptions.push(options); }
  };
  const transcriber = new LocalWhisperTranscriber({
    sessionOptions: {},
    sessionFactory: () => fakeSession,
    segmenterFactory: (options) => ({
      push(pcm) { options.onUtterance(options.channel, Buffer.from(pcm)); },
      stop() {}
    }),
    drainTimeoutMs: 0,
    onError: (error) => reportedErrors.push(error)
  });

  await transcriber.start();
  transcriber.push('you', Buffer.from('pending'));
  transcriber.push('them', Buffer.from('discard me'));
  await transcriber.stop();
  await transcriber.queueTail;

  assert.equal(abortCalls, 1);
  assert.equal(transcribeCalls, 1);
  assert.deepEqual(reportedErrors, []);
  assert.deepEqual(stopOptions, [{ force: true }]);
});

test('drops Whisper silence hallucinations and skips inference for silent buffers under rms gate', async () => {
  let transcribeCalls = 0;
  const transcripts = [];
  const fakeSession = {
    async start() {},
    async transcribe(pcm) {
      transcribeCalls += 1;
      const str = pcm.toString();
      if (str === 'hallucination') return 'Thank you for watching.';
      if (str === 'repetition') return 'Thank you. Thank you!';
      if (str === 'speech') return 'Tell me about Kubernetes.';
      return '';
    },
    abortInferences() {},
    async stop() {}
  };

  const transcriber = new LocalWhisperTranscriber({
    sessionOptions: {},
    sessionFactory: () => fakeSession,
    segmenterFactory: (options) => ({
      push(pcm) { options.onUtterance(options.channel, Buffer.from(pcm)); },
      stop() {}
    }),
    rmsGate: 100,
    onTranscript: (channel, text) => transcripts.push({ channel, text })
  });

  await transcriber.start();

  // 1. Silent buffer (all zeros, RMS = 0 < 100) -> should be skipped entirely
  const silentBuffer = Buffer.alloc(1600);
  transcriber.push('you', silentBuffer);
  await transcriber.queueTail;
  assert.equal(transcribeCalls, 0, 'Silent buffer below RMS gate must not trigger Whisper inference');

  // 2. Audio that Whisper transcribes as a known hallucination -> dropped from onTranscript
  transcriber.push('you', Buffer.from('hallucination'));
  await transcriber.queueTail;
  assert.equal(transcribeCalls, 1);
  assert.deepEqual(transcripts, []);

  // 3. Audio that Whisper transcribes as repeated hallucination -> dropped from onTranscript
  transcriber.push('them', Buffer.from('repetition'));
  await transcriber.queueTail;
  assert.equal(transcribeCalls, 2);
  assert.deepEqual(transcripts, []);

  // 4. Real speech -> emitted normally
  transcriber.push('you', Buffer.from('speech'));
  await transcriber.queueTail;
  assert.equal(transcribeCalls, 3);
  assert.deepEqual(transcripts, [{ channel: 'you', text: 'Tell me about Kubernetes.' }]);

  await transcriber.stop();
});

