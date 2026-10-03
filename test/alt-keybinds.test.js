const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { DEFAULTS } = require('../src/shortcuts');

const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const jsSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const csSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'native', 'stealth-input.cs'), 'utf8');

test('shortcuts.js assigns previous4 to Alt+B and history to Alt+N', () => {
  assert.equal(DEFAULTS.previous4, 'Alt+B');
  assert.equal(DEFAULTS.history, 'Alt+N');
});

test('index.html displays shortcut hints for Prev 4 and Transcription history', () => {
  assert.match(htmlSrc, /<button[^>]*data-mode="previous4"[^>]*>[\s\S]*?<span[^>]*id="prev4-shortcut-hint"[^>]*>Alt\+B<\/span>/);
  assert.match(htmlSrc, /<button[^>]*id="history-btn"[^>]*>[\s\S]*?<span[^>]*id="history-shortcut-hint"[^>]*>Alt\+N<\/span>/);
});

test('styles.css contains styling for history-btn shortcut hints', () => {
  assert.match(cssSrc, /\.history-btn\s+\.shortcut-hint\s*\{/);
  assert.match(cssSrc, /\.history-btn\.active\s+\.shortcut-hint\s*\{/);
});

test('preload.js allows history:toggle IPC event channel', () => {
  assert.match(preloadSrc, /'history:toggle'/);
});

test('main.js tracks previous4 and history in shortcutState and registers global shortcuts', () => {
  assert.match(mainSrc, /shortcutState\s*=\s*\{[^}]*previous4:\s*false[^}]*history:\s*false/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+B',\s*\(\)\s*=>\s*\{?\s*triggerShortcutAction\('previous4'\)/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+N',\s*\(\)\s*=>\s*\{?\s*send\('history:toggle'\)/);
  assert.match(mainSrc, /onHistoryToggle:\s*\(\)\s*=>\s*send\('history:toggle'\)/);
});

test('renderer.js wires history:toggle IPC and listens for Alt+B and Alt+N keydown', () => {
  assert.match(jsSrc, /cue\.on\('history:toggle',\s*toggleSidebar\)/);
  // input keydown
  assert.match(jsSrc, /e\.altKey\s*&&\s*\(e\.key\s*===\s*'b'\s*\|\|\s*e\.key\s*===\s*'B'\)[\s\S]*?runMode\('previous4',\s*''\)/);
  assert.match(jsSrc, /e\.altKey\s*&&\s*\(e\.key\s*===\s*'n'\s*\|\|\s*e\.key\s*===\s*'N'\)[\s\S]*?toggleSidebar\(\)/);
  // boot shortcut hints
  assert.match(jsSrc, /prev4HintEl\.textContent\s*=\s*isWindows\s*\?\s*'Alt\+B'\s*:\s*'⌥B'/);
  assert.match(jsSrc, /historyHintEl\.textContent\s*=\s*isWindows\s*\?\s*'Alt\+N'\s*:\s*'⌥N'/);
});

test('native stealth-input.cs handles Alt+B (previous4) and Alt+N (history_toggle)', () => {
  assert.match(csSrc, /_lastAltBTicks/);
  assert.match(csSrc, /_lastAltNTicks/);
  assert.match(csSrc, /bool isB\s*=\s*\(vk == 0x42 \|\| vk == 0x62\);/);
  assert.match(csSrc, /bool isN\s*=\s*\(vk == 0x4E \|\| vk == 0x6E\);/);
  assert.match(csSrc, /isB\s*&&\s*\(alt\s*\|\|\s*_altPending\)\s*&&\s*!ctrl\s*&&\s*!win/);
  assert.match(csSrc, /isN\s*&&\s*\(alt\s*\|\|\s*_altPending\)\s*&&\s*!ctrl\s*&&\s*!win/);
  assert.ok(csSrc.includes('\\"event\\":\\"shortcut\\",\\"action\\":\\"previous4\\"'));
  assert.ok(csSrc.includes('\\"event\\":\\"history_toggle\\"'));
});

test('window width is calibrated and action row is dynamic to accommodate all buttons without clipping', () => {
  assert.match(mainSrc, /const MAIN_W\s*=\s*(?:7[2-9]\d|8\d\d)/, 'MAIN_W must be calibrated to accommodate all 4 buttons');
  assert.match(cssSrc, /--main-w:\s*(?:7[2-9]\d|8\d\d)px/, '--main-w must match calibrated MAIN_W');
  assert.match(cssSrc, /#panel-wrap\s*\{[^}]*width:\s*fit-content/, '#panel-wrap must dynamically fit action-row contents');
  assert.match(cssSrc, /#action-row\s*\{[^}]*display:\s*flex/, '#action-row must cleanly flex all 4 buttons');
  assert.match(jsSrc, /function syncWindowWidth\(\)/, 'renderer must dynamically synchronize --main-w with window width');
});

test('shortcuts.js assigns hide to Alt+H and transcription to Alt+T', () => {
  assert.equal(DEFAULTS.hide, 'Alt+H');
  assert.equal(DEFAULTS.transcription, 'Alt+T');
});

test('main.js tracks hide and transcription in shortcutState and registers global shortcuts', () => {
  assert.match(mainSrc, /shortcutState\s*=\s*\{[^}]*hide:\s*false[^}]*transcription:\s*false/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+H',\s*\(\)\s*=>\s*\{?\s*send\('hide:toggle'/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+T',\s*\(\)\s*=>\s*\{?\s*send\('transcription:toggle'/);
  assert.match(mainSrc, /onHideToggle:\s*\(\)\s*=>\s*send\('hide:toggle'\)/);
  assert.match(mainSrc, /onTranscriptionToggle:\s*\(\)\s*=>\s*send\('transcription:toggle'\)/);
});

test('preload.js allows transcription:toggle IPC event channel', () => {
  assert.match(preloadSrc, /'transcription:toggle'/);
});

test('renderer.js wires transcription:toggle IPC and listens for Alt+H and Alt+T keydown', () => {
  assert.match(jsSrc, /cue\.on\('transcription:toggle',\s*toggleTranscription\)/);
  assert.match(jsSrc, /e\.altKey\s*&&\s*\(e\.key\s*===\s*'h'\s*\|\|\s*e\.key\s*===\s*'H'\)[\s\S]*?toggleHide\(\)/);
  assert.match(jsSrc, /e\.altKey\s*&&\s*\(e\.key\s*===\s*'t'\s*\|\|\s*e\.key\s*===\s*'T'\)[\s\S]*?toggleTranscription\(\)/);
});

test('native stealth-input.cs handles Alt+H (hide_toggle) and Alt+T (transcription_toggle)', () => {
  assert.match(csSrc, /_lastAltHTicks/);
  assert.match(csSrc, /_lastAltTTicks/);
  assert.match(csSrc, /bool isH\s*=\s*\(vk == 0x48 \|\| vk == 0x68\);/);
  assert.match(csSrc, /bool isT\s*=\s*\(vk == 0x54 \|\| vk == 0x74\);/);
  assert.match(csSrc, /isH\s*&&\s*\(alt\s*\|\|\s*_altPending\)\s*&&\s*!ctrl\s*&&\s*!win/);
  assert.match(csSrc, /isT\s*&&\s*\(alt\s*\|\|\s*_altPending\)\s*&&\s*!ctrl\s*&&\s*!win/);
  assert.ok(csSrc.includes('\\"event\\":\\"hide_toggle\\"'));
  assert.ok(csSrc.includes('\\"event\\":\\"transcription_toggle\\"'));
});

test('index.html does not hide API keys with dots in settings (uses type="text")', () => {
  const keyIds = [
    'key-cerebras',
    'key-openai',
    'key-anthropic',
    'key-gemini',
    'key-deepgram',
    'key-groq',
    'key-custom',
    'key-minimax',
    'key-deepseek',
    'key-azure'
  ];
  for (const id of keyIds) {
    const re = new RegExp(`id="${id}"[^>]*type="text"`);
    assert.match(htmlSrc, re, `Input #${id} must have type="text" so keys are not hidden with dots`);
  }
});

