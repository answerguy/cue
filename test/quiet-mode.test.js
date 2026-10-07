const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { MODES } = require('../src/prompts');
const { windowFor } = require('../src/context');
const { buildInterviewContext } = require('../src/interview-context');

const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
const jsSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

test('MODES.quiet is defined with strict concise and clean code system prompt', () => {
  const quietMode = MODES.quiet;
  assert.ok(quietMode, 'MODES.quiet must exist');
  assert.equal(quietMode.needsScreen, false);
  assert.equal(quietMode.small, true);
  assert.equal(typeof quietMode.buildSystem, 'function');
  assert.equal(typeof quietMode.build, 'function');

  const system = quietMode.buildSystem(null);
  assert.match(system, /Quiet Mode/i);
  assert.match(system, /ONLY the clean, working code with NO comments/i);
  assert.match(system, /DO NOT include any explanations, walkthroughs, time complexity, space complexity, analysis/i);
  assert.match(system, /ONLY a direct, extremely concise answer \(1–3 sentences maximum\)/i);
  assert.match(system, /No preambles, no greetings/i);

  const userTurn = quietMode.build({ userText: 'write binary search in python' });
  assert.equal(userTurn, 'write binary search in python');
});

test('context.js and interview-context.js isolate quiet mode', () => {
  assert.equal(windowFor('quiet'), 0, 'quiet mode should not carry transcript window turns');
  const ctx = buildInterviewContext({ resumeText: 'Resume' }, 'quiet', []);
  assert.equal(ctx, null, 'quiet mode must never inject interview context');
});

test('main.js excludes quiet mode from meeting memory and routes Alt+Q recap to quiet:toggle', () => {
  assert.match(mainSrc, /mode !== 'quiet'/);
  assert.match(mainSrc, /send\('quiet:toggle'\)/);
});

test('preload.js includes quiet:toggle in allowed IPC events', () => {
  assert.match(preloadSrc, /'quiet:toggle'/);
});

test('index.html contains quiet mode container and elements', () => {
  assert.match(htmlSrc, /id="quiet-container"/);
  assert.match(htmlSrc, /id="quiet-input-box"/);
  assert.match(htmlSrc, /id="quiet-input"/);
  assert.match(htmlSrc, /id="quiet-caret-mirror"/);
  assert.match(htmlSrc, /id="quiet-output-box"/);
  assert.match(htmlSrc, /id="quiet-output-text"/);
});

test('styles.css contains .quiet-mode rules to hide default Cue UI and style quiet box', () => {
  assert.match(cssSrc, /body\.quiet-mode\s+#toolbar/);
  assert.match(cssSrc, /body\.quiet-mode\s+#live-dot/);
  assert.match(cssSrc, /body\.quiet-mode\s+#stt-status/);
  assert.match(cssSrc, /body\.quiet-mode\s+#titlebar/);
  assert.match(cssSrc, /body\.quiet-mode\s+#panel-columns/);
  assert.match(cssSrc, /body\.quiet-mode\s+#transcript-sidebar/);
  assert.match(cssSrc, /\.quiet-container/);
  assert.match(cssSrc, /\.quiet-box/);
  assert.match(cssSrc, /\.quiet-input/);
  assert.match(cssSrc, /\.quiet-caret-mirror/);
  assert.match(cssSrc, /\.quiet-caret/);
  assert.match(cssSrc, /\.quiet-output-box/);
});

test('renderer.js manages quiet mode lifecycle, 5% opacity, and Alt+C/Escape clearing', () => {
  assert.match(jsSrc, /function toggleQuietMode/);
  assert.match(jsSrc, /applyOpacity\(0\.05,\s*false\)/, 'quiet mode must start with 5% opacity');
  assert.match(jsSrc, /function sendQuiet/);
  assert.match(jsSrc, /function clearQuietOutput/);
  assert.match(jsSrc, /cue\.on\('quiet:toggle'/);
});

test('renderer.js routes stealth typing into quiet input box and renders tokens in quiet output', () => {
  assert.match(jsSrc, /cue\.on\('stealth:char'[\s\S]*?if \(isQuietMode\)[\s\S]*?quietInput\.value/);
  assert.match(jsSrc, /cue\.on\('stealth:submit'[\s\S]*?if \(isQuietMode\)[\s\S]*?sendQuiet\(\)/);
  assert.match(jsSrc, /cue\.on\('llm:token'[\s\S]*?if \(isQuietMode\)[\s\S]*?quietOutputText\.innerHTML\s*=\s*renderMarkdown\(quietCurrentOutput\)/);
});

test('renderer.js filters keybinds in quiet mode (suppresses history, HR, prev4, STT insert)', () => {
  // Alt+N (sidebar) suppressed
  assert.match(jsSrc, /function toggleSidebar\(\) \{\s*if \(isQuietMode\) return;/);
  // Alt+U (insert) suppressed
  assert.match(jsSrc, /cue\.on\('stt:insert-question',\s*\(\)\s*=>\s*\{\s*if \(isQuietMode\) return;/);
  // Alt+A (autotype) active in quiet mode
  assert.match(jsSrc, /cue\.on\('stt:answer-question',\s*\(\)\s*=>\s*\{\s*if \(isQuietMode\) \{\s*toggleAutotyper\(\);/);
});

test('quiet box resizing with Alt+plus (widen) and Alt+minus (narrow) is wired across full stack', () => {
  const hookManagerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'stealth-hook-manager.js'), 'utf8');
  const csSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'native', 'stealth-input.cs'), 'utf8');

  // styles.css uses --quiet-w variable for input and output boxes
  assert.match(cssSrc, /\.quiet-box\s*\{[\s\S]*?width:\s*var\(--quiet-w,\s*360px\)/);
  assert.match(cssSrc, /\.quiet-output-box\s*\{[\s\S]*?width:\s*var\(--quiet-w,\s*360px\)/);

  // preload.js allows quiet:resize IPC channel
  assert.match(preloadSrc, /'quiet:resize'/);

  // renderer.js handles resizeQuietBox and binds Alt+Plus / Alt+Minus
  assert.match(jsSrc, /function resizeQuietBox\(delta\)/);
  assert.match(jsSrc, /cue\.on\('quiet:resize'/);
  assert.match(jsSrc, /document\.documentElement\.style\.setProperty\('--quiet-w'/);

  // main.js forwards stealthHook quiet_resize and registers global shortcuts
  assert.match(mainSrc, /onQuietResize:\s*\(delta\)\s*=>\s*send\('quiet:resize',\s*\{\s*delta\s*\}\)/);
  assert.match(mainSrc, /globalShortcut\.register\(k,\s*\(\)\s*=>\s*send\('quiet:resize',\s*\{\s*delta:\s*1\s*\}\)/);
  assert.match(mainSrc, /globalShortcut\.register\(k,\s*\(\)\s*=>\s*send\('quiet:resize',\s*\{\s*delta:\s*-1\s*\}\)/);

  // stealth-hook-manager parses quiet_resize message
  assert.match(hookManagerSrc, /case 'quiet_resize':[\s\S]*?onQuietResize\(msg\.delta\);/);

  // stealth-input.cs detects 0xBB (+) and 0xBD (-) and emits quiet_resize events
  assert.match(csSrc, /bool isPlus = \(vk == 0xBB\);/);
  assert.match(csSrc, /bool isMinus = \(vk == 0xBD\);/);
  assert.match(csSrc, /\\"event\\":\\"quiet_resize\\",\\"delta\\":1/);
  assert.match(csSrc, /\\"event\\":\\"quiet_resize\\",\\"delta\\":-1/);
});

