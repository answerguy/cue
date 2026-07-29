const test = require('node:test');
const assert = require('node:assert/strict');
const { MODES } = require('../src/prompts');

test('assist mode prefers a direct paragraph answer', () => {
  const text = MODES.assist.system + '\n' + MODES.assist.build({ transcript: [], userText: '' });
  assert.match(text, /paragraph/i);
  assert.match(text, /follow-up question/i);
});

test('say mode produces a spoken answer, not a question', () => {
  const text = MODES.say.system + '\n' + MODES.say.build({ transcript: [], userText: '' });
  assert.match(text, /paragraph/i);
  assert.match(text, /not as a question/i);
});
