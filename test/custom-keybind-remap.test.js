const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const shortcuts = require('../src/shortcuts');

const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const jsSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const csSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'native', 'stealth-input.cs'), 'utf8');

test('shortcuts.js maps recap to Alt+Q and transcription to Alt+Y', () => {
  assert.equal(shortcuts.DEFAULTS.recap, 'Alt+Q');
  assert.equal(shortcuts.DEFAULTS.transcription, 'Alt+Y');
  assert.equal(shortcuts.DEFAULTS.retry, 'Alt+R');
  assert.equal(shortcuts.DEFAULTS.previousPrompt, 'Alt+W');
  assert.equal(shortcuts.DEFAULTS.prevAnswer, 'Alt+E');
  assert.equal(shortcuts.DEFAULTS.nextAnswer, 'Alt+T');
});

test('index.html toolbar displays keybinds for hide (Alt+H) and start session (Alt+Y)', () => {
  assert.match(htmlSrc, /id="hide-btn"[\s\S]*?id="hide-shortcut-hint">Alt\+H<\/span>/);
  assert.match(htmlSrc, /id="stop-btn"[\s\S]*?id="stop-shortcut-hint">Alt\+Y<\/span>/);
  assert.match(htmlSrc, /id="recap-shortcut-hint">Alt\+Q<\/span>/);
});

test('renderer.js removes like, dislike, and 3 dots buttons from response actions', () => {
  // Thumbs up / down buttons must not be created in createResponseActions
  assert.doesNotMatch(jsSrc, /thumbsUpBtn/);
  assert.doesNotMatch(jsSrc, /thumbsDownBtn/);
  assert.doesNotMatch(jsSrc, /resp-act-thumbs-up/);
  assert.doesNotMatch(jsSrc, /resp-act-thumbs-down/);

  // 3 dots / more button must not be created in createResponseActions
  assert.doesNotMatch(jsSrc, /resp-act-more/);
  assert.doesNotMatch(jsSrc, /resp-more-menu/);
});

test('renderer.js displays Alt+E, Alt+T, and Alt+R hints below their respective buttons', () => {
  assert.match(jsSrc, /resp-act-prev[\s\S]*?Alt\+E/);
  assert.match(jsSrc, /resp-act-next[\s\S]*?Alt\+T/);
  assert.match(jsSrc, /resp-act-retry[\s\S]*?Alt\+R/);
});

test('renderer.js implements restorePreviousPrompt without touching Alt+C typing status', () => {
  assert.match(jsSrc, /function restorePreviousPrompt\(\)/);
  const start = jsSrc.indexOf('function restorePreviousPrompt()');
  const end = jsSrc.indexOf('function restoreLastQuestion()');
  const fnBody = jsSrc.slice(start, end);
  // Must preserve isStealthTypingActive without toggling or forcing it on
  assert.match(fnBody, /if \(isStealthTypingActive\) \{[\s\S]*?setStealthCaretPos\(text\.length\);/);
  assert.doesNotMatch(fnBody, /activateStealthTyping/);
  assert.doesNotMatch(fnBody, /deactivateStealthTyping/);
  assert.doesNotMatch(fnBody, /input\.focus/);
});

test('renderer.js and main.js handle all remapped keyboard shortcuts', () => {
  // Alt+Q (Recap)
  assert.match(jsSrc, /e\.altKey && \(e\.key === 'q' \|\| e\.key === 'Q'\)[\s\S]*?runMode\('recap', ''\)/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+Q'/);

  // Alt+W (Previous prompt)
  assert.match(jsSrc, /e\.altKey && \(e\.key === 'w' \|\| e\.key === 'W'\)[\s\S]*?restorePreviousPrompt\(\)/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+W'/);

  // Alt+E (Previous answer)
  assert.match(jsSrc, /e\.altKey && \(e\.key === 'e' \|\| e\.key === 'E'\)[\s\S]*?goToPreviousAnswer\(\)/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+E'/);

  // Alt+R (Retry prompt)
  assert.match(jsSrc, /e\.altKey && \(e\.key === 'r' \|\| e\.key === 'R'\)[\s\S]*?retryResponse/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+R'/);

  // Alt+T (Next answer)
  assert.match(jsSrc, /e\.altKey && \(e\.key === 't' \|\| e\.key === 'T'\)[\s\S]*?goToNextAnswer\(\)/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+T'/);

  // Alt+Y (Transcription / Start session)
  assert.match(jsSrc, /e\.altKey && \(e\.key === 'y' \|\| e\.key === 'Y'\)[\s\S]*?toggleTranscription\(\)/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+Y'/);
});

test('stealth-input.cs defines and swallows Alt+Q, Alt+W, Alt+E, Alt+R, Alt+T, and Alt+Y', () => {
  // Virtual key definitions
  assert.match(csSrc, /bool isQ = \(vk == 0x51 \|\| vk == 0x71\);/);
  assert.match(csSrc, /bool isW = \(vk == 0x57 \|\| vk == 0x77\);/);
  assert.match(csSrc, /bool isE = \(vk == 0x45 \|\| vk == 0x65\);/);
  assert.match(csSrc, /bool isR = \(vk == 0x52 \|\| vk == 0x72\);/);
  assert.match(csSrc, /bool isT = \(vk == 0x54 \|\| vk == 0x74\);/);
  assert.match(csSrc, /bool isY = \(vk == 0x59 \|\| vk == 0x79\);/);

  // Switch cases
  assert.match(csSrc, /case 0x51:[\s\S]*?recap/);
  assert.match(csSrc, /case 0x57:[\s\S]*?previous_prompt/);
  assert.match(csSrc, /case 0x45:[\s\S]*?previous_answer/);
  assert.match(csSrc, /case 0x52:[\s\S]*?retry/);
  assert.match(csSrc, /case 0x54:[\s\S]*?next_answer/);
  assert.match(csSrc, /case 0x59:[\s\S]*?transcription_toggle/);
});
