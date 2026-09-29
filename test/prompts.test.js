const test = require('node:test');
const assert = require('node:assert/strict');
const { MODES } = require('../src/prompts');

test('assist mode gives a direct answer in first person', () => {
  const system = MODES.assist.buildSystem(null);
  const text = system + '\n' + MODES.assist.build({ transcript: [], userText: '' });
  // System prompt must instruct to answer in first person with no preamble
  assert.match(text, /first person/i);
  assert.match(text, /no preamble|preamble/i);
});

test('say mode produces a spoken answer not a question', () => {
  const system = MODES.say.buildSystem(null);
  const text = system + '\n' + MODES.say.build({ transcript: [], userText: '' });
  assert.match(text, /say out loud|in first person/i);
  // Must instruct to write actual spoken words (not meta-instructions)
  assert.match(text, /actual words|Write the|2.5 sentences/i);
});

test('leetcode mode ignores context block and returns coding prompt', () => {
  const system = MODES.leetcode.buildSystem('IGNORED_CONTEXT');
  assert.match(system, /competitive programmer|coding problem/i);
  assert.ok(!system.includes('IGNORED_CONTEXT'), 'leetcode should not include context block');
});

test('recap is grounded in the transcript and does not presume an interview', () => {
  const system = MODES.recap.buildSystem(null);
  assert.match(system, /actually said|only what is in the transcript/i, 'recap must be grounded in the transcript');
  assert.match(system, /generic/i, 'recap must forbid generic filler');
  // The only mention of interviews allowed is the conditional "if the context block says so".
  const unconditional = system.replace(/If the context block shows this is a job interview[^\n]*/g, '');
  assert.ok(!/\binterview/i.test(unconditional), 'recap must not assume the conversation is an interview');
  assert.equal(MODES.recap.transcriptRequired, true, 'recap needs a transcript to be meaningful');
  // Modes that also take a screenshot can run on an empty transcript.
  assert.ok(!MODES.assist.transcriptRequired);
  assert.ok(!MODES.ask.transcriptRequired);
  assert.ok(!MODES.leetcode.transcriptRequired);
});

test('recap user turn carries the real conversation', () => {
  const transcript = [
    { channel: 'them', text: 'We shipped the Terraform pipeline on Tuesday.', ts: 1 },
    { channel: 'you', text: 'How long did the deploy take?', ts: 2 }
  ];
  const turn = MODES.recap.build({ transcript, userText: '' });
  assert.match(turn, /Them: We shipped the Terraform pipeline on Tuesday\./);
  assert.match(turn, /You: How long did the deploy take\?/);
});

test('previous4 requires transcript and enforces interview first-person explaining terms', () => {
  assert.equal(MODES.previous4.transcriptRequired, true, 'previous4 must require transcript');
  assert.equal(MODES.previous4.userBubble, 'Prev 4', 'userBubble must be Prev 4');
  const system = MODES.previous4.buildSystem(null);
  assert.match(system, /first-person|first person/i, 'must instruct first person');
  assert.match(system, /clear|confident/i, 'must instruct clear confident tone');
  assert.match(system, /interview/i, 'must instruct interview perspective');
  assert.match(system, /thank you/i, 'must instruct to ignore thank you');
  assert.match(system, /let me think about it/i, 'must instruct to ignore let me think about it');
  assert.match(system, /give me a minute/i, 'must instruct to ignore give me a minute');
  assert.match(system, /precision, recall/i, 'must mention terms without full questions');
  assert.match(system, /newest|most recent|increasing importance/i, 'must specify newest importance');
  assert.match(system, /answer all/i, 'must instruct to answer all');
  assert.match(system, /first priority|answered first/i, 'must instruct that newest is answered first');
  assert.match(system, /thorough|not too short/i, 'must instruct thorough, not too short explanations');
  assert.match(system, /textbook/i, 'must instruct to avoid dry textbook definitions');
  assert.match(system, /no analogies/i, 'must forbid analogies');
  assert.match(system, /accurate/i, 'must instruct accurate explanations');
});

test('previous4 builds latest up to 4 messages with increasing importance (last > second last > third last > fourth last)', () => {
  const transcript = [
    { channel: 'them', text: 'old message 0', ts: 0 },
    { channel: 'them', text: 'message 1: sharding', ts: 1 },
    { channel: 'you', text: 'message 2: replication', ts: 2 },
    { channel: 'them', text: 'message 3: consistency', ts: 3 },
    { channel: 'them', text: 'message 4: precision and recall', ts: 4 }
  ];

  const turn = MODES.previous4.build({ transcript });
  // Should only take the last 4 (messages 1 to 4), dropping message 0
  assert.ok(!turn.includes('old message 0'), 'must not include message older than the 4 most recent');
  assert.match(turn, /message 1: sharding/);
  assert.match(turn, /message 2: replication/);
  assert.match(turn, /message 3: consistency/);
  assert.match(turn, /message 4: precision and recall/);

  // Check that importance is clearly tagged with newest having highest importance
  assert.match(turn, /HIGHEST IMPORTANCE/);
  assert.match(turn, /Last > Second last > Third last > Fourth last/i);
  assert.match(turn, /ANSWER ALL/i);
  assert.match(turn, /first priority and be answered FIRST/i);
});

test('previous4 is robust when transcript has fewer than 4 messages', () => {
  const twoMessages = [
    { channel: 'them', text: 'give me a minute, what about F1 score?', ts: 1 },
    { channel: 'them', text: 'precision, recall', ts: 2 }
  ];
  const turn = MODES.previous4.build({ transcript: twoMessages });
  assert.match(turn, /precision, recall/);
  assert.match(turn, /F1 score/);
  assert.match(turn, /HIGHEST IMPORTANCE/);
  assert.match(turn, /2 messages/);

  const emptyTurn = MODES.previous4.build({ transcript: [] });
  assert.match(emptyTurn, /No recent transcript messages/i);
});

test('all modes have a build function', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    assert.equal(typeof mode.build, 'function', `${name}.build must be a function`);
    assert.equal(typeof mode.buildSystem, 'function', `${name}.buildSystem must be a function`);
  }
});

// ── AI rules ────────────────────────────────────────────────────────────────
const RULES = 'Never use em-dashes.\nReply in 2-3 short bullet points.\nUse a casual tone.';

test('every non-leetcode mode injects AI rules into its system prompt', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    if (name === 'leetcode') continue;
    const withRules = mode.buildSystem(null, RULES);
    assert.match(withRules, /--- USER RULES ---/, `${name}.buildSystem should append USER RULES block`);
    assert.ok(withRules.includes(RULES), `${name}.buildSystem should include the user's rules verbatim`);
  }
});

test('every non-leetcode mode returns the base prompt unchanged when no rules are set', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    if (name === 'leetcode') continue;
    const without = mode.buildSystem(null, '');
    const blank = mode.buildSystem(null, null);
    assert.ok(!without.includes('USER RULES'), `${name} should not include USER RULES when aiRules is empty`);
    assert.ok(!blank.includes('USER RULES'), `${name} should not include USER RULES when aiRules is null`);
  }
});

test('leetcode mode never applies AI rules (coding answers stay strict)', () => {
  const withRules = MODES.leetcode.buildSystem(null, RULES);
  assert.ok(!withRules.includes('USER RULES'), 'leetcode must not include USER RULES');
  assert.ok(!withRules.includes(RULES), 'leetcode must not leak user rules into the prompt');
  assert.match(withRules, /competitive programmer/);
});