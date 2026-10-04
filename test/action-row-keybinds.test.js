const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

test('action-row buttons display keybinds on the line below text labels', () => {
  // All 5 action buttons: What should I say?, Smart assist, Recap, Prev 4, and HR
  const sayMatch = htmlSrc.match(/<button[^>]*data-mode="say"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(sayMatch, 'say button exists');
  assert.match(sayMatch[1], /class="act-top"[^>]*>[\s\S]*?What should I say\?[\s\S]*?<\/span>/);
  assert.match(sayMatch[1], /id="say-shortcut-hint"/);

  const assistMatch = htmlSrc.match(/<button[^>]*data-mode="assist"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(assistMatch, 'assist button exists');
  assert.match(assistMatch[1], /class="act-top"[^>]*>[\s\S]*?Smart assist[\s\S]*?<\/span>/);
  assert.match(assistMatch[1], /id="assist-shortcut-hint"/);

  const recapMatch = htmlSrc.match(/<button[^>]*data-mode="recap"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(recapMatch, 'recap button exists');
  assert.match(recapMatch[1], /class="act-top"[^>]*>[\s\S]*?Recap[\s\S]*?<\/span>/);
  assert.match(recapMatch[1], /id="recap-shortcut-hint">Alt\+Q<\/span>/);

  const prev4Match = htmlSrc.match(/<button[^>]*data-mode="previous4"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(prev4Match, 'prev4 button exists');
  assert.match(prev4Match[1], /class="act-top"[^>]*>[\s\S]*?Prev 4[\s\S]*?<\/span>/);
  assert.match(prev4Match[1], /id="prev4-shortcut-hint">Alt\+B<\/span>/);

  const hrMatch = htmlSrc.match(/<button[^>]*data-mode="hr"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(hrMatch, 'hr button exists');
  assert.match(hrMatch[1], /class="act-top"[^>]*>[\s\S]*?HR[\s\S]*?<\/span>/);
  assert.match(hrMatch[1], /id="hr-shortcut-hint">Alt\+G<\/span>/);

  const leetcodeMatch = htmlSrc.match(/<button[^>]*data-mode="leetcode"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(leetcodeMatch, 'leetcode button exists');
  assert.match(leetcodeMatch[1], /class="act-top"[^>]*>[\s\S]*?LeetCode[\s\S]*?<\/span>/);
  assert.match(leetcodeMatch[1], /id="leetcode-shortcut-hint">Ctrl\+H<\/span>/);
});

test('styles.css lays out action-row buttons in column orientation to save horizontal space', () => {
  // .act must be flex-direction: column to stack text and keybind
  assert.match(cssSrc, /\.act\s*\{[\s\S]*?flex-direction:\s*column;/);
  assert.match(cssSrc, /\.act-top\s*\{[\s\S]*?display:\s*inline-flex;/);
  assert.match(cssSrc, /\.act\s+\.shortcut-hint\s*\{[\s\S]*?margin-left:\s*0;/);
});

test('all action-row buttons are normalized with button outline like smart assist', () => {
  // All buttons in action row use .act with button outline
  assert.match(cssSrc, /\.act\s*\{[\s\S]*?border:\s*1px\s+solid\s+rgba\(255,\s*255,\s*255,\s*0\.14\);/);
  assert.match(cssSrc, /\.act\s*\{[\s\S]*?border-radius:\s*8px;/);
  // No blue background for what should I say / act-primary
  assert.doesNotMatch(cssSrc, /\.act-primary\s*\{[\s\S]*?background:\s*rgba\(60/);
});

test('keybind hints have high opacity and use button text white color for readability', () => {
  // .act .shortcut-hint, .history-btn .shortcut-hint, .resp-act-hint use var(--tx-2) and opacity: 1
  assert.match(cssSrc, /\.act\s+\.shortcut-hint\s*\{[\s\S]*?color:\s*var\(--tx-2\);/);
  assert.match(cssSrc, /\.act\s+\.shortcut-hint\s*\{[\s\S]*?opacity:\s*1;/);
  assert.match(cssSrc, /\.history-btn\s+\.shortcut-hint\s*\{[\s\S]*?color:\s*var\(--tx-2\);/);
  assert.match(cssSrc, /\.resp-act-hint\s*\{[\s\S]*?color:\s*var\(--tx-2\);/);
});


