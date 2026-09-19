const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { CURRENT_ANTHROPIC_DEFAULT_FAST, CURRENT_ANTHROPIC_DEFAULT_SMART } = require('../src/llm');

// Anthropic retired claude-3-5-haiku-latest and claude-3-5-sonnet-latest
// (every claude-2.x/claude-3.x id 404s with not_found_error as of Sep 2026) —
// the root cause behind a cluster of "model unavailable (404)" bug reports.
// Before this fix, TWO different files each hardcoded their own copy of the
// Anthropic default: src/llm.js's DEFAULT_MODELS (only a backstop for a
// missing settings.models entry) and src/store.js's DEFAULTS.models (what
// createLLM() actually reads by default for a real install) — the same
// multi-copy drift pattern gemini-model-config.test.js already guards
// against for Gemini. This scans both for a known-dead id so a future
// re-hardcode (or a future retirement of today's default) fails a test
// instead of silently shipping a dead default again.
const DEAD_MODEL_RE = /^claude-(2(?:\.\d+)?(?:-|$)|3-)/i;

const FILES_THAT_CALL_ANTHROPIC = ['src/llm.js', 'src/store.js'];

test('CURRENT_ANTHROPIC_DEFAULT_FAST/_SMART are not known-retired Anthropic model ids', () => {
  assert.ok(!DEAD_MODEL_RE.test(CURRENT_ANTHROPIC_DEFAULT_FAST), `${CURRENT_ANTHROPIC_DEFAULT_FAST} looks retired`);
  assert.ok(!DEAD_MODEL_RE.test(CURRENT_ANTHROPIC_DEFAULT_SMART), `${CURRENT_ANTHROPIC_DEFAULT_SMART} looks retired`);
});

for (const relPath of FILES_THAT_CALL_ANTHROPIC) {
  test(`${relPath} does not hardcode a retired-looking Anthropic model id`, () => {
    const source = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
    const literals = [...source.matchAll(/'(claude-[^']+)'/g)].map(m => m[1]);
    assert.ok(literals.length > 0, `${relPath} has no 'claude-...' literals — did the pattern change? update this test`);
    for (const id of literals) {
      assert.ok(!DEAD_MODEL_RE.test(id), `${relPath} still references a retired-looking model ${id}`);
    }
  });
}

test('store.js default Anthropic models match the shared current defaults', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/store.js'), 'utf8');
  const match = /anthropic:\s*\{\s*fast:\s*'([^']+)',\s*smart:\s*'([^']+)'/.exec(source);
  assert.ok(match, 'could not find the anthropic default models block in store.js');
  assert.equal(match[1], CURRENT_ANTHROPIC_DEFAULT_FAST);
  assert.equal(match[2], CURRENT_ANTHROPIC_DEFAULT_SMART);
});
