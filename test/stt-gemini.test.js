const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { extractGeminiTranscript } = require('../src/stt');
const { GEMINI_TRANSCRIBE_MODEL, CURRENT_GEMINI_DEFAULT } = require('../src/llm');

const candidate = (parts) => ({ candidates: [{ content: { parts, role: 'model' }, finishReason: 'STOP' }] });

test('extractGeminiTranscript reads the audioTranscription part gemini-*-transcribe models return', () => {
  const res = candidate([{ audioTranscription: { text: '  We deployed the cluster on Tuesday.  ' } }]);
  assert.equal(extractGeminiTranscript(res), 'We deployed the cluster on Tuesday.');
});

test('extractGeminiTranscript still reads plain text parts from the chat-model fallback', () => {
  const res = candidate([
    { text: 'thinking…', thought: true, thoughtSignature: 'abc' },
    { text: 'Hello ', thoughtSignature: 'abc' },
    { text: 'world.' }
  ]);
  assert.equal(extractGeminiTranscript(res), 'Hello world.');
});

test('extractGeminiTranscript returns an empty string for silence and malformed responses', () => {
  assert.equal(extractGeminiTranscript(candidate([])), '');
  assert.equal(extractGeminiTranscript({ candidates: [] }), '');
  assert.equal(extractGeminiTranscript(undefined), '');
  assert.equal(extractGeminiTranscript({ candidates: [{ content: {} }] }), '');
});

test('GEMINI_TRANSCRIBE_MODEL is a dedicated transcribe model distinct from the chat default', () => {
  assert.match(GEMINI_TRANSCRIBE_MODEL, /^gemini-[\d.]+-transcribe$/);
  assert.notEqual(GEMINI_TRANSCRIBE_MODEL, CURRENT_GEMINI_DEFAULT);
});

test('both Gemini transcription paths go through the shared transcribeGemini', () => {
  const stt = fs.readFileSync(path.join(__dirname, '..', 'src/stt.js'), 'utf8');
  const streaming = fs.readFileSync(path.join(__dirname, '..', 'src/stt-streaming.js'), 'utf8');
  assert.ok(stt.includes('model: GEMINI_TRANSCRIBE_MODEL'), 'stt.js does not use GEMINI_TRANSCRIBE_MODEL');
  assert.ok(streaming.includes('const transcribeBatchGemini = transcribeGemini'), 'stt-streaming.js has drifted from stt.js');
  assert.ok(!streaming.includes('GoogleGenAI'), 'stt-streaming.js should not construct its own Gemini client');
});
