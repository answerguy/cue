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
  assert.match(preloadSrc, /stealthSet:\s*\(enabled\)\s*=>\s*ipcRenderer\.invoke\('stealth:set',\s*enabled\)/);
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
  assert.match(mainSrc, /ipcMain\.handle\('stealth:set'/);
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

test('stealth typing activates on textbox click and deactivates on click outside or hide button collapse', () => {
  // Renderer code structure checks
  assert.match(jsSrc, /function isInsideInputArea\(/);
  assert.match(jsSrc, /function activateStealthTyping\(/);
  assert.match(jsSrc, /function deactivateStealthTyping\(/);
  assert.match(jsSrc, /document\.addEventListener\('pointerdown',\s*\(e\)\s*=>\s*\{\s*if\s*\(isStealthTypingActive\s*&&\s*!isInsideInputArea\(e\.target\)\)\s*\{\s*deactivateStealthTyping\(\);/);
  assert.match(jsSrc, /document\.addEventListener\('click',\s*\(e\)\s*=>\s*\{\s*if\s*\(isStealthTypingActive\s*&&\s*!isInsideInputArea\(e\.target\)\)\s*\{\s*deactivateStealthTyping\(\);/);
  assert.match(jsSrc, /if\s*\(collapsed\)\s*\{\s*deactivateStealthTyping\(\);/);

  // Behavioral test of isInsideInputArea logic
  class MockNode {
    constructor(id = '', parent = null) {
      this.id = id;
      this.parent = parent;
      this.nodeType = 1;
    }
    get parentElement() {
      return this.parent;
    }
    closest(selector) {
      let cur = this;
      while (cur) {
        if (selector === '#input-area' && cur.id === 'input-area') return cur;
        cur = cur.parent;
      }
      return null;
    }
  }

  function isInsideInputArea(target) {
    if (!target) return false;
    const el = target.nodeType === 1 ? target : target.parentElement;
    return Boolean(el && typeof el.closest === 'function' && el.closest('#input-area'));
  }

  const app = new MockNode('app');
  const panelWrap = new MockNode('panel-wrap', app);
  const panel = new MockNode('panel', panelWrap);
  const panelColumns = new MockNode('panel-columns', panel);
  const panelMain = new MockNode('panel-main', panelColumns);
  const messages = new MockNode('messages', panelMain);
  const answerBubble = new MockNode('answer-bubble', messages);
  const transcriptSidebar = new MockNode('transcript-sidebar', panelWrap);
  const transcriptItem = new MockNode('ts-item', transcriptSidebar);
  const toolbar = new MockNode('toolbar', app);
  const hideBtn = new MockNode('hide-btn', toolbar);

  const composer = new MockNode('composer', panelMain);
  const inputArea = new MockNode('input-area', composer);
  const input = new MockNode('input', inputArea);
  const placeholder = new MockNode('placeholder', inputArea);
  const caretMirror = new MockNode('stealth-caret-mirror', inputArea);
  const clearBtn = new MockNode('clear-input-btn', inputArea);

  // Inside input area elements
  assert.equal(isInsideInputArea(inputArea), true);
  assert.equal(isInsideInputArea(input), true);
  assert.equal(isInsideInputArea(placeholder), true);
  assert.equal(isInsideInputArea(caretMirror), true);
  assert.equal(isInsideInputArea(clearBtn), true);

  // Outside input area elements
  assert.equal(isInsideInputArea(messages), false, 'Messages/answer area must be outside input area');
  assert.equal(isInsideInputArea(answerBubble), false, 'Answer bubble must be outside input area');
  assert.equal(isInsideInputArea(transcriptSidebar), false, 'Transcription history sidebar must be outside input area');
  assert.equal(isInsideInputArea(transcriptItem), false, 'Transcription history item must be outside input area');
  assert.equal(isInsideInputArea(hideBtn), false, 'Hide button must be outside input area');
  assert.equal(isInsideInputArea(toolbar), false, 'Toolbar must be outside input area');
  assert.equal(isInsideInputArea(app), false, 'App root must be outside input area');
  assert.equal(isInsideInputArea(null), false, 'Null target must be outside input area');
});

test('stealth typing supports persistent indicator, Ctrl+A selection, caret arrow navigation, and scroll sync', () => {
  const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

  // HTML persistent indicator and caret after elements
  assert.match(htmlSrc, /<div\s+id="stealth-indicator"\s+class="stealth-pill hidden"\s+aria-label="Stealth typing active">/);
  assert.ok(!htmlSrc.includes('id="stealth-indicator" title='), 'stealth-indicator must not use native title attribute');
  assert.match(htmlSrc, /<span\s+id="stealth-caret-after"\s+class="stealth-caret-after"><\/span>/);

  // CSS styling
  assert.match(cssSrc, /\.stealth-pill\s*\{/);
  assert.match(cssSrc, /\.stealth-pill-dot\s*\{/);
  assert.match(cssSrc, /@keyframes stealth-dot-pulse/);
  assert.match(cssSrc, /#composer\.stealth-active \.stealth-caret-mirror \.selected\s*\{/);
  assert.match(cssSrc, /\.stealth-caret-mirror\s*\{[^}]*overflow:\s*hidden;/);

  // Preload allowed IPC channels
  assert.match(preloadSrc, /'stealth:arrow-left'/);
  assert.match(preloadSrc, /'stealth:arrow-right'/);
  assert.match(preloadSrc, /'stealth:home'/);
  assert.match(preloadSrc, /'stealth:end'/);

  // Main process forwarding
  assert.match(mainSrc, /onArrowLeft:\s*\(\)\s*=>\s*send\('stealth:arrow-left'\)/);
  assert.match(mainSrc, /onArrowRight:\s*\(\)\s*=>\s*send\('stealth:arrow-right'\)/);
  assert.match(mainSrc, /onHome:\s*\(\)\s*=>\s*send\('stealth:home'\)/);
  assert.match(mainSrc, /onEnd:\s*\(\)\s*=>\s*send\('stealth:end'\)/);

  // Renderer event handlers & logic
  assert.match(jsSrc, /cue\.on\('stealth:arrow-left'/);
  assert.match(jsSrc, /cue\.on\('stealth:arrow-right'/);
  assert.match(jsSrc, /cue\.on\('stealth:home'/);
  assert.match(jsSrc, /cue\.on\('stealth:end'/);
  assert.match(jsSrc, /cue\.on\('stealth:select-all'/);
  assert.match(jsSrc, /isStealthSelectAll/);
  assert.match(jsSrc, /stealthIndicator\.classList\.toggle\('hidden',\s*!isStealthTypingActive\)/);
  assert.match(jsSrc, /input\.addEventListener\('scroll',\s*\(\)\s*=>\s*\{/);
  assert.match(jsSrc, /caretMirror\.scrollTop\s*=\s*input\.scrollTop/);
});

