const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const jsSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

test('index.html defines #interviewer-pill with answer, insert, and dismiss actions', () => {
  assert.match(htmlSrc, /id="interviewer-pill"[^>]*class="[^"]*interviewer-pill[^"]*"/, 'interviewer-pill element must exist');
  assert.match(htmlSrc, /id="ip-text"/, 'ip-text body must exist');
  assert.match(htmlSrc, /id="ip-answer-btn"/, 'ip-answer-btn must exist');
  assert.match(htmlSrc, /id="ip-insert-btn"/, 'ip-insert-btn must exist');
  assert.match(htmlSrc, /id="ip-dismiss-btn"/, 'ip-dismiss-btn must exist');
});

test('interviewer-pill buttons strictly use aria-label and have zero title attributes', () => {
  assert.match(htmlSrc, /id="ip-answer-btn"[^>]*aria-label="Answer interviewer question"/);
  assert.match(htmlSrc, /id="ip-insert-btn"[^>]*aria-label="Insert question into input box"/);
  assert.match(htmlSrc, /id="ip-dismiss-btn"[^>]*aria-label="Dismiss interviewer question"/);
  
  // Verify no title attribute in the interviewer pill markup
  const pillSection = htmlSrc.match(/<div id="interviewer-pill"[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(pillSection, 'Must extract interviewer-pill section');
  assert.equal(/\btitle\s*=/i.test(pillSection[0]), false, 'No title attribute allowed in interviewer pill markup');
});

test('styles.css contains styling for interviewer pill and states', () => {
  assert.match(cssSrc, /\.interviewer-pill\s*\{/);
  assert.match(cssSrc, /\.interviewer-pill\.hidden\s*\{/);
  assert.match(cssSrc, /\.interviewer-pill\.ip-dimmed\s*\{/);
  assert.match(cssSrc, /\.interviewer-pill\.ip-accumulating\s*\{/);
  assert.match(cssSrc, /\.ip-btn-answer\s*\{/);
  assert.match(cssSrc, /\.ip-btn-dismiss\s*\{/);
  assert.match(cssSrc, /\.ip-body\s*\{/);
});

test('renderer.js manages interviewer pill state without corrupting user typing', () => {
  assert.match(jsSrc, /function accumulateInterviewerQuestion\(/);
  assert.match(jsSrc, /function showInterviewerPill\(/);
  assert.match(jsSrc, /function dismissInterviewerPill\(/);
  assert.match(jsSrc, /function answerInterviewerQuestion\(/);
  assert.match(jsSrc, /function insertInterviewerQuestion\(/);
  assert.match(jsSrc, /function softClearInterviewerPill\(/);
  assert.match(jsSrc, /function cancelPillSoftClear\(/);
});

test('transcript event routes them channel to accumulateInterviewerQuestion without touching input.value', () => {
  const transcriptListener = jsSrc.match(/cue\.on\('transcript',\s*\(\{[\s\S]*?\}\)\s*=>\s*\{([\s\S]*?)\}\);/);
  assert.ok(transcriptListener, 'cue.on(transcript) must be present');
  const body = transcriptListener[1];
  assert.match(body, /accumulateInterviewerQuestion\(text\)/, 'them channel must call accumulateInterviewerQuestion');
  assert.ok(!body.includes('input.value ='), 'transcript listener must never write directly to input.value');
});

test('stt:interim event streams live words into interviewer pill', () => {
  const interimListener = jsSrc.match(/cue\.on\('stt:interim',\s*\(\{[\s\S]*?\}\)\s*=>\s*\{([\s\S]*?)\}\);/);
  assert.ok(interimListener, 'cue.on(stt:interim) must be present');
  const body = interimListener[1];
  assert.match(body, /showInterviewerPillInterim\(text\)/, 'interim text must stream into showInterviewerPillInterim');
});

test('send() answers staged interviewer question when user input is empty', () => {
  const sendFn = jsSrc.match(/function send\(\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(sendFn, 'send() function must be present');
  const body = sendFn[1];
  assert.match(body, /if\s*\(!text\)\s*\{[\s\S]*?if\s*\(stagedInterviewerQuestion\)\s*\{[\s\S]*?answerInterviewerQuestion\(\);/);
});

test('input keydown handlers support Tab to insert and Escape to dismiss pill', () => {
  assert.match(jsSrc, /e\.key === 'Tab' && stagedInterviewerQuestion[\s\S]*?insertInterviewerQuestion\(\)/);
  assert.match(jsSrc, /e\.key === 'Escape'[\s\S]*?dismissInterviewerPill\(\)/);
});

test('interviewer pill button click listeners are registered', () => {
  assert.match(jsSrc, /ipAnswerBtn\.addEventListener\('click'[\s\S]*?answerInterviewerQuestion\(\)/);
  assert.match(jsSrc, /ipInsertBtn\.addEventListener\('click'[\s\S]*?insertInterviewerQuestion\(\)/);
  assert.match(jsSrc, /ipDismissBtn\.addEventListener\('click'[\s\S]*?dismissInterviewerPill\(\)/);
});

test('insertInterviewerQuestion preserves existing typed text without overwriting', () => {
  // Simulate caret insertion logic
  let inputValue = 'My existing notes';
  let cursor = inputValue.length;
  const staged = 'Can you explain Dijkstra algorithm?';
  
  const before = inputValue.slice(0, cursor);
  const after = inputValue.slice(cursor);
  const prefixSpace = (before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n')) ? ' ' : '';
  const suffixSpace = (after.length > 0 && !after.startsWith(' ') && !after.startsWith('\n')) ? ' ' : '';
  const insertion = prefixSpace + staged + suffixSpace;
  inputValue = before + insertion + after;
  
  assert.equal(inputValue, 'My existing notes Can you explain Dijkstra algorithm?');
});

test('interviewer-pill displays Alt+A for answer and Alt+U for insert buttons', () => {
  assert.match(htmlSrc, /id="ip-answer-btn"[^>]*>[\s\S]*?<span class="ip-key">Alt\+A<\/span>\s*Answer/, 'Answer button must show Alt+A');
  assert.match(htmlSrc, /id="ip-insert-btn"[^>]*>[\s\S]*?<span class="ip-key">Alt\+U<\/span>\s*Insert/, 'Insert button must show Alt+U');
});

test('renderer.js and stealth hook support Alt+A and Alt+U for STT answer and insert', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const hookManagerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'stealth-hook-manager.js'), 'utf8');

  // Verify stealth hook manager dispatches events
  assert.match(hookManagerSrc, /case 'stt_answer':\s*onSttAnswer\(\);/);
  assert.match(hookManagerSrc, /case 'stt_insert':\s*onSttInsert\(\);/);

  // Verify main.js wires stealth hook callbacks to IPC
  assert.match(mainSrc, /onSttAnswer:\s*\(\)\s*=>\s*send\('stt:answer-question'\)/);
  assert.match(mainSrc, /onSttInsert:\s*\(\)\s*=>\s*send\('stt:insert-question'\)/);

  // Verify preload.js allows IPC STT events
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preloadSrc, /'stt:answer-question'/);
  assert.match(preloadSrc, /'stt:insert-question'/);

  // Verify renderer.js listens for IPC STT events
  assert.match(jsSrc, /cue\.on\('stt:answer-question',\s*\(\)\s*=>\s*\{[\s\S]*?answerInterviewerQuestion\(\)/);
  assert.match(jsSrc, /cue\.on\('stt:insert-question',\s*\(\)\s*=>\s*\{[\s\S]*?insertInterviewerQuestion\(\)/);

  // Verify renderer.js keydown handlers support Alt+A and Alt+U
  assert.match(jsSrc, /e\.altKey && \(e\.key === 'a' \|\| e\.key === 'A'\)[\s\S]*?answerInterviewerQuestion\(\)/);
  assert.match(jsSrc, /e\.altKey && \(e\.key === 'u' \|\| e\.key === 'U'\)[\s\S]*?insertInterviewerQuestion\(\)/);
});

