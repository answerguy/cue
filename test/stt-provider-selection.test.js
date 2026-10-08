const assert = require('node:assert/strict');
const test = require('node:test');
const { createSTT } = require('../src/stt');
const { createStreamingSTT } = require('../src/stt-streaming');
const { CURRENT_GEMINI_DEFAULT } = require('../src/llm');

const callbacks = {
  onTranscript() {},
  onInterim() {},
  onError() {},
  onStatusChange() {}
};

test('explicit local mode never constructs a cloud fallback', () => {
  const settings = {
    sttProvider: 'local',
    apiKeys: { openai: 'openai-key', gemini: 'gemini-key', deepgram: 'deepgram-key' }
  };
  assert.equal(createSTT(settings).available, false);
  assert.deepEqual(createStreamingSTT(settings, 'you', callbacks), {
    type: 'batch',
    provider: 'local',
    instance: null
  });
});

test('explicit sherpa-onnx selection also keeps audio local with zero cloud fallback', () => {
  const settings = {
    sttProvider: 'sherpa-onnx',
    apiKeys: { openai: 'openai-key', gemini: 'gemini-key', deepgram: 'deepgram-key' }
  };
  assert.equal(createSTT(settings).available, false);
  assert.deepEqual(createStreamingSTT(settings, 'you', callbacks), {
    type: 'batch',
    provider: 'sherpa-onnx',
    instance: null
  });
});

test('explicit cloud selection does not cross-fallback to another provider', () => {
  const openai = createSTT({
    sttProvider: 'openai',
    apiKeys: { openai: 'openai-key', gemini: 'gemini-key' }
  });
  const gemini = createSTT({
    sttProvider: 'gemini',
    apiKeys: { openai: 'openai-key', gemini: 'gemini-key' }
  });
  assert.deepEqual(openai.providers, ['openai']);
  assert.deepEqual(gemini.providers, ['gemini']);
});

test('explicit Custom selection with a base URL and key is offered and usable for STT', () => {
  const settings = {
    sttProvider: 'custom',
    baseUrl: 'http://127.0.0.1:18789/v1',
    apiKeys: { custom: 'test-custom-key' }
  };
  const batch = createSTT(settings);
  assert.equal(batch.available, true);
  assert.deepEqual(batch.providers, ['custom']);
  assert.deepEqual(createStreamingSTT(settings, 'you', callbacks), {
    type: 'batch',
    provider: 'custom',
    instance: null
  });
});

test('explicit Custom selection without both a base URL and a key stays unavailable (no silent partial send)', () => {
  assert.equal(createSTT({ sttProvider: 'custom', apiKeys: { custom: 'test-custom-key' } }).available, false);
  assert.equal(createSTT({ sttProvider: 'custom', baseUrl: 'http://127.0.0.1:18789/v1', apiKeys: {} }).available, false);
});

test('auto mode still never reaches for the Custom chat key for STT (unchanged from before)', () => {
  const speechToText = createSTT({
    sttProvider: 'auto',
    baseUrl: 'http://127.0.0.1:18789/v1',
    apiKeys: { custom: 'gateway-token' }
  });
  assert.equal(speechToText.available, false);
  assert.deepEqual(speechToText.providers, []);
});

// Regression for issue #25: Settings held a working Gemini model, but the STT
// path ignored settings.models entirely and hardcoded its own id — so
// transcription 404'd against a model the user had never selected, and the
// error text named that unfamiliar id back at them.
test('Gemini STT transcribes with the model configured in Settings', () => {
  const stt = createSTT({
    sttProvider: 'gemini',
    apiKeys: { gemini: 'gemini-key' },
    models: { gemini: { fast: 'gemini-3.5-flash-lite', smart: 'gemini-3.6-flash' } }
  });
  assert.deepEqual(stt.models, ['gemini-3.5-flash-lite']);
});

test('Gemini STT honours the smart tier the same way the chat path does', () => {
  const stt = createSTT({
    sttProvider: 'gemini',
    smart: true,
    apiKeys: { gemini: 'gemini-key' },
    models: { gemini: { fast: 'gemini-3.5-flash-lite', smart: 'gemini-3.6-flash' } }
  });
  assert.deepEqual(stt.models, ['gemini-3.6-flash']);
});

test('Gemini STT migrates a retired model saved on disk instead of 404ing forever', () => {
  const stt = createSTT({
    sttProvider: 'gemini',
    apiKeys: { gemini: 'gemini-key' },
    models: { gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-flash' } }
  });
  assert.deepEqual(stt.models, [CURRENT_GEMINI_DEFAULT]);
});

test('index.html and renderer.js expose and wire Deepgram and Custom STT options and inputs', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

  // stt-provider-seg includes Deepgram button
  assert.match(html, /data-stt-provider="deepgram"/);
  assert.match(html, /data-stt-provider="custom"/);

  // Audio tab has dedicated Deepgram key input and Custom STT fields
  assert.match(html, /id="deepgram-stt-group"/);
  assert.match(html, /id="key-deepgram-audio"/);
  assert.match(html, /id="custom-stt-group"/);
  assert.match(html, /id="custom-stt-base-url"/);
  assert.match(html, /id="custom-stt-key"/);

  // Keys tab has Deepgram input not hidden behind data-key-for
  assert.match(html, /id="key-deepgram"/);
  assert.doesNotMatch(html, /data-key-for="deepgram"/);

  // renderer.js handles sttProvider update and saves deepgram + custom settings
  assert.match(js, /updateSttProviderUI/);
  assert.match(js, /key-deepgram-audio/);
  assert.match(js, /custom-stt-base-url/);
  assert.match(js, /settings\.sttProvider =/);
});

