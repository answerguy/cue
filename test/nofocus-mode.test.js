const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const jsSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const { DEFAULTS } = require('../src/shortcuts');

test('shortcuts include nofocus toggle and stealth typing', () => {
  assert.equal(DEFAULTS.nofocus, 'CommandOrControl+Shift+F');
  assert.equal(DEFAULTS.type, 'Alt+C');
});

test('renderer/index.html contains focus-btn with aria-label and no title attribute', () => {
  assert.match(htmlSrc, /<button\s+class="tb-focus"\s+id="focus-btn"/);
  assert.match(htmlSrc, /id="focus-btn"[^>]*aria-label="Toggle no-focus mode/);
  assert.ok(!htmlSrc.includes('id="focus-btn" title='), 'focus-btn must not use title attribute');
});

test('preload.js exposes nofocus APIs and allowed IPC channels', () => {
  assert.match(preloadSrc, /nofocusGet:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('nofocus:get'\)/);
  assert.match(preloadSrc, /nofocusSet:\s*\(enabled\)\s*=>\s*ipcRenderer\.invoke\('nofocus:set',\s*enabled\)/);
  assert.match(preloadSrc, /nofocusToggle:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('nofocus:toggle'\)/);
  assert.match(preloadSrc, /'nofocus:state'/);
  assert.match(preloadSrc, /'composer:focus'/);
});

test('main.js registers global shortcuts and IPC handlers for nofocus mode', () => {
  assert.match(mainSrc, /ipcMain\.handle\('nofocus:get'/);
  assert.match(mainSrc, /ipcMain\.handle\('nofocus:set'/);
  assert.match(mainSrc, /ipcMain\.handle\('nofocus:toggle'/);
  assert.match(mainSrc, /globalShortcut\.register\('CommandOrControl\+Shift\+F'/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+C'/);
  assert.match(mainSrc, /win\.setFocusable\(!isNoFocusMode\)/);
});

test('renderer.js implements setNoFocusUI and dynamic placeholder with shortcuts', () => {
  assert.match(jsSrc, /function setNoFocusUI\(/);
  assert.match(jsSrc, /function updatePlaceholder\(/);
  assert.match(jsSrc, /No-focus mode active · <span class="keycap">/);
  assert.match(jsSrc, /cue\.on\('nofocus:state'/);
  assert.match(jsSrc, /cue\.on\('composer:focus'/);
  assert.match(jsSrc, /#focus-btn/);
});
