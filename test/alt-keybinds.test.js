const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const shortcuts = require('../src/shortcuts');

const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const jsSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const stealthHookSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'stealth-hook-manager.js'), 'utf8');
const csSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'native', 'stealth-input.cs'), 'utf8');

test('shortcuts.js includes recap, opacityDown, and opacityUp defaults', () => {
  const defaults = shortcuts.DEFAULTS;
  assert.equal(defaults.recap, 'Alt+Q');
  assert.equal(defaults.opacityDown, 'Alt+O');
  assert.equal(defaults.opacityUp, 'Alt+P');
});

test('opacity sliders in index.html allow 0% to 100%', () => {
  assert.match(htmlSrc, /id="tb-opacity-slider"[^>]*min="0"[^>]*max="100"/);
  assert.match(htmlSrc, /id="s-opacity-slider"[^>]*min="0"[^>]*max="100"/);
});

test('index.html displays Alt+Q hint for recap, Alt+U for insert, Alt+H for hide, and Alt+Y for start session', () => {
  assert.match(htmlSrc, /id="recap-shortcut-hint">Alt\+Q<\/span>/);
  assert.match(htmlSrc, /id="ip-insert-btn"[^>]*>[\s\S]*?<span class="ip-key">Alt\+U<\/span>\s*Insert/);
  assert.match(htmlSrc, /id="hide-shortcut-hint">Alt\+H<\/span>/);
  assert.match(htmlSrc, /id="stop-shortcut-hint">Alt\+Y<\/span>/);
});

test('renderer.js clamps opacity between 0.0 and 1.0 (0% to 100%)', () => {
  assert.match(jsSrc, /const OPACITY_MIN = 0\.0;/);
  assert.match(jsSrc, /function changeOpacityBy\(deltaPercent\)/);
  assert.match(jsSrc, /Math\.min\(100,\s*Math\.max\(0,\s*currentPercent \+ deltaPercent\)\)/);
  assert.match(jsSrc, /cue\.on\('opacity:step',\s*\(\{\s*delta\s*\}\)\s*=>/);
});

test('renderer.js binds Alt+Q to recap, Alt+W to previous prompt, Alt+E to prev answer, Alt+R to retry, Alt+T to next answer, Alt+Y to transcription', () => {
  // Input keydown handlers
  assert.match(jsSrc, /e\.altKey && \(e\.key === 'u' \|\| e\.key === 'U'\)[\s\S]*?insertInterviewerQuestion\(\)/);
  assert.match(jsSrc, /e\.altKey && \(e\.key === 'q' \|\| e\.key === 'Q'\)[\s\S]*?runMode\('recap',\s*''\)/);
  assert.match(jsSrc, /e\.altKey && \(e\.key === 'w' \|\| e\.key === 'W'\)[\s\S]*?restorePreviousPrompt\(\)/);
  assert.match(jsSrc, /e\.altKey && \(e\.key === 'e' \|\| e\.key === 'E'\)[\s\S]*?goToPreviousAnswer\(\)/);
  assert.match(jsSrc, /e\.altKey && \(e\.key === 'r' \|\| e\.key === 'R'\)[\s\S]*?retryResponse/);
  assert.match(jsSrc, /e\.altKey && \(e\.key === 't' \|\| e\.key === 'T'\)[\s\S]*?goToNextAnswer\(\)/);
  assert.match(jsSrc, /e\.altKey && \(e\.key === 'y' \|\| e\.key === 'Y'\)[\s\S]*?toggleTranscription\(\)/);
  assert.match(jsSrc, /e\.altKey && \(e\.key === 'o' \|\| e\.key === 'O'\)[\s\S]*?changeOpacityBy\(-5\)/);
  assert.match(jsSrc, /e\.altKey && \(e\.key === 'p' \|\| e\.key === 'P'\)[\s\S]*?changeOpacityBy\(5\)/);
  assert.match(jsSrc, /cue\.windowMove\(dir\)/);

  // Document keydown handlers
  const docHandlerMatch = jsSrc.match(/document\.addEventListener\('keydown',[\s\S]*?\}\);/);
  assert.ok(docHandlerMatch, 'document keydown listener must exist');
  const docBody = docHandlerMatch[0];
  assert.match(docBody, /e\.altKey && \(e\.key === 'u' \|\| e\.key === 'U'\)/);
  assert.match(docBody, /e\.altKey && \(e\.key === 'q' \|\| e\.key === 'Q'\)/);
  assert.match(docBody, /e\.altKey && \(e\.key === 'w' \|\| e\.key === 'W'\)/);
  assert.match(docBody, /e\.altKey && \(e\.key === 'e' \|\| e\.key === 'E'\)/);
  assert.match(docBody, /e\.altKey && \(e\.key === 'r' \|\| e\.key === 'R'\)/);
  assert.match(docBody, /e\.altKey && \(e\.key === 't' \|\| e\.key === 'T'\)/);
  assert.match(docBody, /e\.altKey && \(e\.key === 'y' \|\| e\.key === 'Y'\)/);
  assert.match(docBody, /e\.altKey && \(e\.key === 'o' \|\| e\.key === 'O'\)/);
  assert.match(docBody, /e\.altKey && \(e\.key === 'p' \|\| e\.key === 'P'\)/);
});

test('preload.js exposes windowMove and allows opacity:step event', () => {
  assert.match(preloadSrc, /windowMove:\s*\(direction\)\s*=>\s*ipcRenderer\.send\('window:move',\s*direction\)/);
  assert.match(preloadSrc, /'opacity:step'/);
});

test('stealth-hook-manager dispatches opacity_step and window_move', () => {
  assert.match(stealthHookSrc, /case 'opacity_step':[\s\S]*?onOpacityStep\(msg\.delta\);/);
  assert.match(stealthHookSrc, /case 'window_move':[\s\S]*?onWindowMove\(msg\.direction\);/);
});

test('main.js handles window movement and opacity stepping from stealth hook and shortcuts', () => {
  assert.match(mainSrc, /onOpacityStep:\s*\(delta\)\s*=>\s*send\('opacity:step',\s*\{\s*delta\s*\}\)/);
  assert.match(mainSrc, /onWindowMove:\s*\(direction\)\s*=>\s*moveWindow\(direction\)/);
  assert.match(mainSrc, /function moveWindow\(direction\)/);
  assert.match(mainSrc, /ipcMain\.on\('window:move',\s*\(_e,\s*direction\)\s*=>\s*moveWindow\(direction\)\)/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+Q'/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+W'/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+E'/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+R'/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+T'/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+Y'/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+O'/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+P'/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+I'/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+J'/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+K'/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+L'/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+U'/);
});

test('stealth-input.cs defines and masks Alt+U, Alt+R, Alt+O, Alt+P, and Alt+(I,J,K,L)', () => {
  // Key flags
  assert.match(csSrc, /bool isU = \(vk == 0x55 \|\| vk == 0x75\);/);
  assert.match(csSrc, /bool isR = \(vk == 0x52 \|\| vk == 0x72\);/);
  assert.match(csSrc, /bool isO = \(vk == 0x4F \|\| vk == 0x6F\);/);
  assert.match(csSrc, /bool isP = \(vk == 0x50 \|\| vk == 0x70\);/);
  assert.match(csSrc, /bool isI = \(vk == 0x49 \|\| vk == 0x69\);/);
  assert.match(csSrc, /bool isJ = \(vk == 0x4A \|\| vk == 0x6A\);/);
  assert.match(csSrc, /bool isK = \(vk == 0x4B \|\| vk == 0x6B\);/);
  assert.match(csSrc, /bool isL = \(vk == 0x4C \|\| vk == 0x6C\);/);

  // Events emitted
  assert.match(csSrc, /\\"event\\":\\"stt_insert\\"/);
  assert.match(csSrc, /\\"event\\":\\"shortcut\\",\\"action\\":\\"recap\\"/);
  assert.match(csSrc, /\\"event\\":\\"opacity_step\\",\\"delta\\":-5/);
  assert.match(csSrc, /\\"event\\":\\"opacity_step\\",\\"delta\\":5/);
  assert.match(csSrc, /\\"event\\":\\"window_move\\",\\"direction\\":\\"up\\"/);
  assert.match(csSrc, /\\"event\\":\\"window_move\\",\\"direction\\":\\"left\\"/);
  assert.match(csSrc, /\\"event\\":\\"window_move\\",\\"direction\\":\\"down\\"/);
  assert.match(csSrc, /\\"event\\":\\"window_move\\",\\"direction\\":\\"right\\"/);

  // Swallowed / masked check
  assert.match(csSrc, /_altSwallowed = true; \/\/ Mark Alt completely swallowed!/);
});
