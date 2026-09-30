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

test('renderer/index.html contains focus-btn defaulting to active on startup with no title attribute', () => {
  assert.match(htmlSrc, /<button\s+class="tb-focus active"\s+id="focus-btn"/);
  assert.match(htmlSrc, /id="focus-btn"[^>]*aria-label="No-focus mode active/);
  assert.match(htmlSrc, /No-focus ON/);
  assert.ok(!htmlSrc.includes('id="focus-btn" title='), 'focus-btn must not use title attribute');
});

test('preload.js exposes nofocus APIs and allowed IPC channels', () => {
  assert.match(preloadSrc, /nofocusGet:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('nofocus:get'\)/);
  assert.match(preloadSrc, /nofocusSet:\s*\(enabled\)\s*=>\s*ipcRenderer\.invoke\('nofocus:set',\s*enabled\)/);
  assert.match(preloadSrc, /nofocusToggle:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('nofocus:toggle'\)/);
  assert.match(preloadSrc, /stealthGet:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('stealth:get'\)/);
  assert.match(preloadSrc, /stealthToggle:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('stealth:toggle'\)/);
  assert.match(preloadSrc, /'nofocus:state'/);
  assert.match(preloadSrc, /'composer:focus'/);
  assert.match(preloadSrc, /'stealth:char'/);
  assert.match(preloadSrc, /'stealth:state'/);
});

test('main.js registers global shortcuts and IPC handlers for nofocus mode', () => {
  assert.match(mainSrc, /let isNoFocusMode = true;/);
  assert.match(mainSrc, /focusable:\s*!isNoFocusMode/);
  assert.match(mainSrc, /ipcMain\.handle\('nofocus:get'/);
  assert.match(mainSrc, /ipcMain\.handle\('nofocus:set'/);
  assert.match(mainSrc, /ipcMain\.handle\('nofocus:toggle'/);
  assert.match(mainSrc, /ipcMain\.handle\('stealth:get'/);
  assert.match(mainSrc, /ipcMain\.handle\('stealth:toggle'/);
  assert.match(mainSrc, /globalShortcut\.register\('CommandOrControl\+Shift\+F'/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+C'/);
  assert.match(mainSrc, /win\.setFocusable\(!isNoFocusMode\)/);
});

test('renderer.js implements setNoFocusUI and dynamic placeholder with shortcuts', () => {
  assert.match(jsSrc, /let isNoFocusMode = true;/);
  assert.match(jsSrc, /function setNoFocusUI\(/);
  assert.match(jsSrc, /function updatePlaceholder\(/);
  assert.match(jsSrc, /No-focus mode active · <span class="keycap">/);
  assert.match(jsSrc, /cue\.on\('nofocus:state'/);
  assert.match(jsSrc, /cue\.on\('composer:focus'/);
  assert.match(jsSrc, /cue\.on\('stealth:state'/);
  assert.match(jsSrc, /cue\.on\('stealth:char'/);
  assert.match(jsSrc, /cue\.on\('stealth:submit'/);
  assert.match(jsSrc, /#focus-btn/);
});

test('composer input area includes blinking caret mirror and fixed delete button', () => {
  const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

  // HTML structure
  assert.match(htmlSrc, /<div\s+id="stealth-caret-mirror"\s+class="stealth-caret-mirror"/);
  assert.match(htmlSrc, /<span\s+id="stealth-caret-text"><\/span><span\s+id="stealth-caret"\s+class="stealth-caret"><\/span>/);
  assert.match(htmlSrc, /<button\s+id="clear-input-btn"\s+class="input-delete-btn hidden"\s+aria-label="Clear input">✕<\/button>/);
  assert.ok(!htmlSrc.includes('id="clear-input-btn" title='), 'clear-input-btn must not use native title attribute');

  // CSS rules
  assert.match(cssSrc, /\.stealth-caret-mirror\s*\{/);
  assert.match(cssSrc, /#composer\.stealth-active \.stealth-caret-mirror\s*\{/);
  assert.match(cssSrc, /@keyframes stealth-caret-blink/);
  assert.match(cssSrc, /\.input-delete-btn\s*\{/);
  assert.match(cssSrc, /#composer\.stealth-active \.input-delete-btn/);

  // Preload IPC allowed channels
  assert.match(preloadSrc, /'stealth:delete'/);

  // Renderer logic
  assert.match(jsSrc, /cue\.on\('stealth:delete'/);
  assert.match(jsSrc, /clearComposerInput/);
  assert.match(jsSrc, /syncCaretMirror/);
  assert.match(jsSrc, /updateDeleteButton/);

  // Main logic for masked shortcuts and delete
  assert.match(mainSrc, /triggerShortcutAction/);
  assert.match(mainSrc, /onShortcut:\s*\(action\)\s*=>\s*triggerShortcutAction\(action\)/);
  assert.match(mainSrc, /onDelete:\s*\(\)\s*=>\s*send\('stealth:delete'\)/);
});
