const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { MODES } = require('../src/prompts');
const { buildInterviewContext } = require('../src/interview-context');
const shortcuts = require('../src/shortcuts');

const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const jsSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const csSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'native', 'stealth-input.cs'), 'utf8');

test('MODES.hr is defined with correct properties', () => {
  assert.ok(MODES.hr, 'MODES.hr must exist');
  assert.equal(MODES.hr.needsScreen, false, 'hr mode does not require screen capture');
  assert.equal(MODES.hr.small, false);
  assert.equal(typeof MODES.hr.build, 'function');
  assert.equal(typeof MODES.hr.buildSystem, 'function');
});

test('MODES.hr.buildSystem instructs story continuity, flexibility, and first-person delivery', () => {
  const system = MODES.hr.buildSystem(null);
  assert.match(system, /first person/i, 'must instruct to answer in first person');
  assert.match(system, /continuity/i, 'must instruct to maintain continuity');
  assert.match(system, /prepared/i, 'must refer to prepared stories/questions');
  assert.match(system, /fallback|no prepared stories|own story/i, 'must instruct fallback to make up story if none provided');
  assert.match(system, /invent|extrapolate|add/i, 'must instruct that details can be added or invented as required');
});

test('MODES.hr.buildSystem applies AI rules', () => {
  const rules = 'Never use em-dashes.\nBe very concise.';
  const systemWithRules = MODES.hr.buildSystem(null, rules);
  assert.ok(systemWithRules.includes(rules), 'must include user AI rules');
  assert.match(systemWithRules, /USER RULES/);
});

test('MODES.hr.build formats question and optional prepared stories', () => {
  const withoutStories = MODES.hr.build({ userText: 'What is your biggest flaw?' });
  assert.match(withoutStories, /What is your biggest flaw\?/);

  const withStories = MODES.hr.build({
    userText: 'How do you handle conflict?',
    hrStories: 'Q: Conflict\nA: I talked to my lead.'
  });
  assert.match(withStories, /How do you handle conflict\?/);
  assert.match(withStories, /I talked to my lead/);
});

test('buildInterviewContext injects prepared HR stories when mode is hr', () => {
  const settingsWithHR = {
    hrStories: 'Q: Hardest bug?\nA: Fixed memory leak in worker pool.',
    resumeText: 'Software Engineer at TechCorp'
  };
  const ctx = buildInterviewContext(settingsWithHR, 'hr', []);
  assert.ok(ctx !== null);
  assert.match(ctx, /Prepared HR Questions, Answers & Stories/i);
  assert.match(ctx, /Fixed memory leak in worker pool/);
  assert.match(ctx, /continuity/i);
});

test('buildInterviewContext in hr mode handles empty HR stories gracefully', () => {
  const emptyHR = {
    hrStories: '',
    hrQa: '',
    resumeText: 'Jane Doe Engineer'
  };
  const ctx = buildInterviewContext(emptyHR, 'hr', []);
  assert.ok(ctx !== null);
  assert.match(ctx, /No prepared HR stories provided/i);
  assert.match(ctx, /Jane Doe/);
});

test('shortcuts.js maps hr to Alt+G with no conflicts', () => {
  assert.equal(shortcuts.DEFAULTS.hr, 'Alt+G');
  const conflicts = shortcuts.findConflicts(shortcuts.resolveShortcuts());
  assert.equal(conflicts.length, 0);
});

test('main.js registers Alt+G global shortcut and dispatches hr action', () => {
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+G'/);
  assert.match(mainSrc, /action === 'hr'/);
  assert.match(mainSrc, /send\('hr:trigger'\)/);
  assert.match(mainSrc, /mode === 'hr'/);
});

test('preload.js allows hr:trigger IPC channel', () => {
  assert.match(preloadSrc, /'hr:trigger'/);
});

test('stealth-input.cs defines 0x47 (G) for Alt+G and dispatches hr action', () => {
  assert.match(csSrc, /case 0x47:[\s\S]*?action[\s\S]*?hr/);
  assert.match(csSrc, /bool isG = \(vk == 0x47 \|\| vk == 0x67\);/);
});

test('index.html contains HR button in action-row and HR tab/pane in settings', () => {
  assert.match(htmlSrc, /data-mode="hr"/);
  assert.match(htmlSrc, /id="hr-shortcut-hint">Alt\+G<\/span>/);
  assert.match(htmlSrc, /data-tab="hr"/);
  assert.match(htmlSrc, /data-pane="hr"/);
  assert.match(htmlSrc, /id="hr-qa"/);
});

test('renderer.js supports Alt+G keydown in input and document, and listens to hr:trigger', () => {
  assert.match(jsSrc, /function triggerHrMode\(\)/);
  assert.match(jsSrc, /cue\.on\('hr:trigger'/);
  assert.match(jsSrc, /e\.altKey && \(e\.key === 'g' \|\| e\.key === 'G'\)[\s\S]*?triggerHrMode\(\)/);
});

test('renderer.js strips /hr at start or end of message and triggers hr mode', () => {
  assert.match(jsSrc, /hrStartRegex\s*=\s*\/\^\\\/hr\\b\/i/);
  assert.match(jsSrc, /hrEndRegex\s*=\s*\/\\\/hr\$\/i/);
  assert.match(jsSrc, /isHrMode\s*=\s*true/);
  assert.match(jsSrc, /runMode\('hr',\s*text\)/);
});

test('renderer.js populates and persists hrStories in settings', () => {
  assert.match(jsSrc, /settings\.hrStories\s*\|\|\s*settings\.hrQa/);
  assert.match(jsSrc, /settings\.hrStories\s*=\s*hrQaEl\.value\.trim\(\)/);
});
