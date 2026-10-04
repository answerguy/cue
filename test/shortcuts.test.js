const test = require('node:test');
const assert = require('node:assert');
const { DEFAULTS, resolveShortcuts, findConflicts, isValid } = require('../src/shortcuts');

test('defaults cover the core actions', () => {
  assert.strictEqual(DEFAULTS.say, 'CommandOrControl+Return');
  assert.strictEqual(DEFAULTS.assist, 'CommandOrControl+Shift+Return');
  assert.strictEqual(DEFAULTS.nofocus, 'CommandOrControl+Shift+F');
  assert.strictEqual(DEFAULTS.type, 'Alt+C');
  assert.strictEqual(DEFAULTS.transparency, 'Alt+V');
  assert.strictEqual(DEFAULTS.previous4, 'Alt+B');
  assert.strictEqual(DEFAULTS.history, 'Alt+N');
  assert.strictEqual(DEFAULTS.hide, 'Alt+H');
  assert.strictEqual(DEFAULTS.transcription, 'Alt+Y');
  assert.strictEqual(DEFAULTS.model, 'Alt+M');
  assert.strictEqual(DEFAULTS.smart, 'Alt+S');
  assert.strictEqual(DEFAULTS.recap, 'Alt+Q');
  assert.strictEqual(DEFAULTS.retry, 'Alt+R');
  assert.strictEqual(DEFAULTS.previousPrompt, 'Alt+W');
  assert.strictEqual(DEFAULTS.prevAnswer, 'Alt+E');
  assert.strictEqual(DEFAULTS.nextAnswer, 'Alt+T');
  assert.strictEqual(DEFAULTS.opacityDown, 'Alt+O');
  assert.strictEqual(DEFAULTS.opacityUp, 'Alt+P');
  assert.strictEqual(DEFAULTS.hr, 'Alt+G');
  assert.ok(DEFAULTS.leetcode);
  assert.ok(DEFAULTS.quit);
});

test('resolveShortcuts merges overrides', () => {
  const map = resolveShortcuts({ leetcode: 'CommandOrControl+L' });
  assert.strictEqual(map.leetcode, 'CommandOrControl+L');
  assert.strictEqual(map.assist, DEFAULTS.assist);
});

test('findConflicts detects duplicate accelerators', () => {
  const map = resolveShortcuts({ leetcode: 'CommandOrControl+Shift+Return' });
  const conflicts = findConflicts(map);
  assert.ok(conflicts.some(([a, b]) => (a === 'assist' && b === 'leetcode') || (a === 'leetcode' && b === 'assist')));
});

test('no conflicts in the default set', () => {
  assert.strictEqual(findConflicts(resolveShortcuts()).length, 0);
});

test('isValid accepts good accelerators and rejects junk', () => {
  assert.ok(isValid('CommandOrControl+Return'));
  assert.ok(isValid('Shift+Q'));
  assert.ok(isValid('F1'));
  assert.strictEqual(isValid(''), false);
  assert.strictEqual(isValid('++'), false);
  assert.strictEqual(isValid(null), false);
});