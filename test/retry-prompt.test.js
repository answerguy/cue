const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const iconsSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'icons.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const stylesSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

test('renderer/icons.js contains required icons for retry and action bar', () => {
  assert.match(iconsSrc, /'rotate-cw':/, 'icons.js must contain rotate-cw');
  assert.match(iconsSrc, /copy:/, 'icons.js must contain copy');
  assert.match(iconsSrc, /'thumbs-up':/, 'icons.js must contain thumbs-up');
  assert.match(iconsSrc, /'thumbs-down':/, 'icons.js must contain thumbs-down');
  assert.match(iconsSrc, /check:/, 'icons.js must contain check');
  assert.match(iconsSrc, /'chevron-left':/, 'icons.js must contain chevron-left');
  assert.match(iconsSrc, /'chevron-right':/, 'icons.js must contain chevron-right');
});

test('main.js includes mode and text in llm:start payload for retry tracking', () => {
  assert.match(mainSrc, /send\('llm:start',\s*\{[\s\S]*?mode,[\s\S]*?text:\s*userText/, 'main.js must send mode and text in llm:start');
});

test('renderer.js implements createResponseActions and retryResponse', () => {
  assert.match(rendererSrc, /function createResponseActions\(/, 'createResponseActions must be defined');
  assert.match(rendererSrc, /function retryResponse\(/, 'retryResponse must be defined');
  assert.match(rendererSrc, /resp-act-btn resp-act-retry/, 'retry button must have resp-act-retry class');
  assert.match(rendererSrc, /aria-label.*?Retry/, 'retry button must have an aria-label');
  assert.doesNotMatch(rendererSrc, /resp-act-btn resp-act-retry[\s\S]{0,80}title=/, 'retry button must not use title attribute');
});

test('renderer.js implements forward and backward iteration navigation (< and >)', () => {
  assert.match(rendererSrc, /function showIteration\(/, 'showIteration must be defined');
  assert.match(rendererSrc, /resp-act-prev/, 'backward button must have resp-act-prev class');
  assert.match(rendererSrc, /resp-act-next/, 'forward button must have resp-act-next class');
  assert.match(rendererSrc, /aria-label.*?Previous iteration/, 'backward button has aria-label');
  assert.match(rendererSrc, /aria-label.*?Next iteration/, 'forward button has aria-label');
  assert.doesNotMatch(rendererSrc, /resp-act-prev[\s\S]{0,80}title=/, 'backward button must not use title attribute');
  assert.doesNotMatch(rendererSrc, /resp-act-next[\s\S]{0,80}title=/, 'forward button must not use title attribute');
  assert.match(rendererSrc, /group\._iterations\.push/, 'iterations must be stored on group._iterations');
});

test('renderer.js supports in-place retry in llm:start without clearing other messages', () => {
  assert.match(rendererSrc, /if \(retryingGroup && retryingGroup\.isConnected\)/, 'llm:start must check retryingGroup to update in-place');
  assert.match(rendererSrc, /group\.dataset\.mode = mode/, 'group must store mode in dataset');
  assert.match(rendererSrc, /group\.dataset\.text = text/, 'group must store text in dataset');
});

test('renderer.js attaches retry action bar on both llm:done and llm:error', () => {
  assert.match(rendererSrc, /cue\.on\('llm:done',\s*\(\)\s*=>\s*\{\s*finalizeAi\(false\);/, 'llm:done calls finalizeAi(false)');
  assert.match(rendererSrc, /cue\.on\('llm:error',[\s\S]*?finalizeAi\(true\);/, 'llm:error calls finalizeAi(true)');
  assert.match(rendererSrc, /createResponseActions\(group,\s*raw,\s*isError\)/, 'finalizeAi creates actions for group');
});

test('styles.css defines response-actions, retry button, and error state', () => {
  assert.match(stylesSrc, /\.response-actions\s*\{/, 'styles.css must style .response-actions');
  assert.match(stylesSrc, /\.resp-act-retry/, 'styles.css must style .resp-act-retry');
  assert.match(stylesSrc, /\.ai-text\.error/, 'styles.css must style .ai-text.error');
  assert.match(stylesSrc, /\.resp-pagination/, 'styles.css must style .resp-pagination');
  assert.match(stylesSrc, /\.resp-page-num/, 'styles.css must style .resp-page-num');
});
