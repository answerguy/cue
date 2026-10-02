const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULTS } = require('../src/shortcuts');

test('shortcuts default set includes transparency mode bound to Alt+V', () => {
  assert.equal(DEFAULTS.transparency, 'Alt+V');
});

test('preload.js exposes transparency APIs and allowed IPC channels', () => {
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preloadSrc, /transparencyGet:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('transparency:get'\)/);
  assert.match(preloadSrc, /transparencySet:\s*\(enabled\)\s*=>\s*ipcRenderer\.invoke\('transparency:set',\s*enabled\)/);
  assert.match(preloadSrc, /transparencyToggle:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('transparency:toggle'\)/);
  assert.match(preloadSrc, /'transparency:state'/);
  assert.match(preloadSrc, /'stealth:arrow-up'/);
  assert.match(preloadSrc, /'stealth:arrow-down'/);
  assert.match(preloadSrc, /'stealth:page-up'/);
  assert.match(preloadSrc, /'stealth:page-down'/);
});

test('main.js handles transparency mode, global shortcut, and guards mouse:ignore', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(mainSrc, /shortcutState\s*=\s*\{[^}]*transparency:\s*false/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+V'/);
  assert.match(mainSrc, /function setTransparencyMode\(enabled/);
  assert.match(mainSrc, /win\.setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*false\s*\}\)/);
  assert.match(mainSrc, /ipcMain\.on\('mouse:ignore',\s*\(_e,\s*v\)\s*=>\s*\{[^}]*if\s*\(isTransparencyMode\)\s*return;/);
  assert.match(mainSrc, /ipcMain\.handle\('transparency:get'/);
  assert.match(mainSrc, /ipcMain\.handle\('transparency:set'/);
  assert.match(mainSrc, /ipcMain\.handle\('transparency:toggle'/);
  assert.match(mainSrc, /send\('transparency:state'/);
});

test('renderer.js guards mousemove during transparency mode and handles arrow key scrolling', () => {
  const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(rendererSrc, /let\s+isTransparencyMode\s*=\s*false;/);
  assert.match(rendererSrc, /cue\.on\('transparency:state'/);
  assert.match(rendererSrc, /document\.addEventListener\('mousemove',\s*\(e\)\s*=>\s*\{\s*if\s*\(isTransparencyMode\)\s*return;/);
  assert.match(rendererSrc, /cue\.on\('stealth:arrow-up'/);
  assert.match(rendererSrc, /cue\.on\('stealth:arrow-down'/);
  assert.match(rendererSrc, /cue\.on\('stealth:page-up'/);
  assert.match(rendererSrc, /cue\.on\('stealth:page-down'/);
});

test('native stealth-input.cs defines Alt+V swallowing, arrow keys, and transparency state', () => {
  const csSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'native', 'stealth-input.cs'), 'utf8');
  assert.match(csSrc, /VK_UP\s*=\s*0x26/);
  assert.match(csSrc, /VK_DOWN\s*=\s*0x28/);
  assert.match(csSrc, /VK_PRIOR\s*=\s*0x21/);
  assert.match(csSrc, /VK_NEXT\s*=\s*0x22/);
  assert.match(csSrc, /_transparencyMode/);
  assert.match(csSrc, /_lastAltVTicks/);
  assert.match(csSrc, /isV\s*&&\s*\(alt\s*\|\|\s*_altPending\)\s*&&\s*!ctrl\s*&&\s*!win/);
  assert.ok(csSrc.includes('transparency_toggle'));
  assert.ok(csSrc.includes('arrow_up'));
  assert.ok(csSrc.includes('arrow_down'));
  assert.ok(csSrc.includes('ReleaseAllModifiers'));
  assert.ok(csSrc.includes('CleanUp'));
});

test('renderer.js routes arrow keys to input box during typing mode and gives typing preference when both modes are active', () => {
  const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(rendererSrc, /function moveStealthCaretVertical/);
  assert.match(rendererSrc, /cue\.on\('stealth:arrow-up',\s*\(\)\s*=>\s*\{[^}]*if\s*\(isStealthTypingActive\)\s*\{[^}]*moveStealthCaretVertical\(-1\);[^}]*\}\s*else if\s*\(isTransparencyMode\)\s*\{/s);
  assert.match(rendererSrc, /cue\.on\('stealth:arrow-down',\s*\(\)\s*=>\s*\{[^}]*if\s*\(isStealthTypingActive\)\s*\{[^}]*moveStealthCaretVertical\(1\);[^}]*\}\s*else if\s*\(isTransparencyMode\)\s*\{/s);
});

test('stealth-input.cs strictly reserves Up/Down arrows in either mode and guarantees clean modifier release without leaks', () => {
  const csSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'native', 'stealth-input.cs'), 'utf8');
  // Strict arrow key reservation whenever Cue is in stealth typing or transparency mode
  assert.match(csSrc, /if\s*\(_capturing\s*\|\|\s*_transparencyMode\)[\s\S]*?VK_UP/);
  assert.match(csSrc, /if\s*\(_capturing\s*\|\|\s*_transparencyMode\)[\s\S]*?VK_DOWN/);
  // Auto-repeat swallowing for Alt when _altSwallowed is true
  assert.match(csSrc, /if\s*\(_altSwallowed\)\s*\{[\s\S]*?return\s*\(IntPtr\)1;\s*\}/);
  // ReleaseAllModifiers called when leaving modes or releasing swallowed Alt
  assert.match(csSrc, /_altSwallowed\s*=\s*false;[\s\S]*?ReleaseAllModifiers\(\);/);
});

