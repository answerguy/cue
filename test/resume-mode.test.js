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

test('MODES.resume is defined with correct properties', () => {
  assert.ok(MODES.resume, 'MODES.resume must exist');
  assert.equal(MODES.resume.needsScreen, false, 'resume mode does not require screen capture');
  assert.equal(MODES.resume.small, false);
  assert.equal(typeof MODES.resume.build, 'function');
  assert.equal(typeof MODES.resume.buildSystem, 'function');
});

test('MODES.resume.buildSystem instructs first-person delivery, resume/project alignment, technical depth, and fallback/extrapolation', () => {
  const system = MODES.resume.buildSystem(null);
  assert.match(system, /first person/i, 'must instruct to answer in first person');
  assert.match(system, /resume|projects|experience/i, 'must refer to resume, projects, or experience');
  assert.match(system, /technical|authority|architecture|depth/i, 'must instruct technical depth and authority');
  assert.match(system, /fallback|extrapolate/i, 'must instruct plausible extrapolation / fallback');
});

test('MODES.resume.buildSystem applies AI rules', () => {
  const rules = 'Never use em-dashes.\nBe very concise.';
  const systemWithRules = MODES.resume.buildSystem(null, rules);
  assert.ok(systemWithRules.includes(rules), 'must include user AI rules');
  assert.match(systemWithRules, /USER RULES/);
});

test('MODES.resume.build formats question and optional resume text', () => {
  const withoutResume = MODES.resume.build({ userText: 'Can you walk me through your microservices project?' });
  assert.match(withoutResume, /Can you walk me through your microservices project\?/);

  const withResume = MODES.resume.build({
    userText: 'Tell me about the payments pipeline?',
    resumeText: 'Payment platform migration on AWS ECS and Aurora.'
  });
  assert.match(withResume, /Tell me about the payments pipeline\?/);
  assert.match(withResume, /Payment platform migration on AWS ECS and Aurora/);
});

test('buildInterviewContext injects candidate resume, projects, and detailed working when mode is resume', () => {
  const settingsWithResume = {
    resumeConfig: 'Senior Backend Engineer: Designed Kafka streaming pipeline processing 50k eps.',
    jobDescription: 'Distributed Systems Lead'
  };
  const ctx = buildInterviewContext(settingsWithResume, 'resume', []);
  assert.ok(ctx !== null);
  assert.match(ctx, /Candidate Resume, Projects & Experience Context/i);
  assert.match(ctx, /Kafka streaming pipeline processing 50k eps/);
});

test('buildInterviewContext in resume mode handles empty resume gracefully', () => {
  const emptyResume = {
    resumeText: '',
    jobDescription: ''
  };
  const ctx = buildInterviewContext(emptyResume, 'resume', []);
  assert.ok(ctx !== null);
  assert.match(ctx, /No resume text provided/i);
});

test('shortcuts.js maps resume to Alt+F with no conflicts', () => {
  assert.equal(shortcuts.DEFAULTS.resume, 'Alt+F');
  const conflicts = shortcuts.findConflicts(shortcuts.resolveShortcuts());
  assert.equal(conflicts.length, 0);
});

test('main.js registers Alt+F global shortcut and dispatches resume action', () => {
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+F'/);
  assert.match(mainSrc, /action === 'resume'/);
  assert.match(mainSrc, /send\('resume:trigger'\)/);
  assert.match(mainSrc, /mode === 'resume'/);
});

test('preload.js allows resume:trigger IPC channel', () => {
  assert.match(preloadSrc, /'resume:trigger'/);
});

test('stealth-input.cs defines 0x46 (F) for Alt+F and dispatches resume action', () => {
  assert.match(csSrc, /case 0x46:[\s\S]*?action[\s\S]*?resume/);
  assert.match(csSrc, /bool isF = \(vk == 0x46 \|\| vk == 0x66\);/);
});

test('index.html contains Resume button in action-row and Resume tab/pane in settings', () => {
  assert.match(htmlSrc, /data-mode="resume"/);
  assert.match(htmlSrc, /id="resume-shortcut-hint">Alt\+F<\/span>/);
  assert.match(htmlSrc, /data-tab="resume"/);
  assert.match(htmlSrc, /data-pane="resume"/);
  assert.match(htmlSrc, /id="resume-text"/);
});

test('renderer.js supports Alt+F keydown in input and document, and listens to resume:trigger', () => {
  assert.match(jsSrc, /function triggerResumeMode\(\)/);
  assert.match(jsSrc, /cue\.on\('resume:trigger'/);
  assert.match(jsSrc, /e\.altKey && \(e\.key === 'f' \|\| e\.key === 'F'\)[\s\S]*?triggerResumeMode\(\)/);
});

test('renderer.js strips /resume or /r at start or end of message and triggers resume mode', () => {
  assert.match(jsSrc, /resumeStartRegex\s*=\s*\/\^\\\/resume\\b\/i/);
  assert.match(jsSrc, /resumeEndRegex\s*=\s*\/\\\/resume\$\/i/);
  assert.match(jsSrc, /rStartRegex\s*=\s*\/\^\\\/r\\b\/i/);
  assert.match(jsSrc, /rEndRegex\s*=\s*\/\\\/r\$\/i/);
  assert.match(jsSrc, /isResumeMode\s*=\s*true/);
  assert.match(jsSrc, /runMode\('resume',\s*text\)/);
});

test('renderer.js populates and persists resumeConfig in settings', () => {
  assert.match(jsSrc, /resumeEl\.value\s*=\s*settings\.resumeConfig/);
  assert.match(jsSrc, /settings\.resumeConfig\s*=\s*resumeEl\.value\.trim\(\)/);
});
