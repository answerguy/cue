const assert = require('node:assert/strict');
const test = require('node:test');
const { createAutotyper, extractTextToAutotype } = require('../src/autotyper');

test('extractTextToAutotype extracts code from fenced blocks', () => {
  const markdown = `
Here is the solution to Two Sum:
\`\`\`python
def twoSum(nums, target):
    seen = {}
    for i, n in enumerate(nums):
        if target - n in seen:
            return [seen[target - n], i]
        seen[n] = i
\`\`\`
Complexity is O(n).
`;
  const extracted = extractTextToAutotype(markdown);
  assert.ok(extracted.startsWith('def twoSum('));
  assert.ok(extracted.includes('seen = {}'));
  assert.ok(!extracted.includes('Here is the solution'));
  assert.ok(!extracted.includes('Complexity is O(n)'));
});

test('extractTextToAutotype returns clean plain text when no code fences exist', () => {
  const plain = 'Hello world! This is a simple explanation.';
  assert.equal(extractTextToAutotype(plain), plain);
});

test('extractTextToAutotype picks the longest code block if multiple exist', () => {
  const multi = `
Short block:
\`\`\`bash
npm test
\`\`\`

Main solution:
\`\`\`javascript
function longFunction() {
  const x = 1;
  const y = 2;
  return x + y;
}
\`\`\`
`;
  const extracted = extractTextToAutotype(multi);
  assert.ok(extracted.includes('longFunction'));
  assert.ok(!extracted.includes('npm test'));
});

test('createAutotyper handles start, pause, resume, toggle, and completion with injector', async () => {
  const typedCodes = [];
  const backspaces = [];
  const states = [];

  const autotyper = createAutotyper({
    injector: {
      typeCodePoint: (cp) => typedCodes.push(cp),
      typeBackspace: () => backspaces.push(true)
    },
    errorRate: 0, // Deterministic for unit test
    speedMultiplier: 100, // Very fast for testing
    onStateChange: (s) => states.push(s.status)
  });

  assert.equal(autotyper.getStatus(), 'idle');
  assert.equal(autotyper.isBusy(), false);

  // Start typing
  const started = autotyper.start('Hi');
  assert.equal(started, true);
  assert.equal(autotyper.getStatus(), 'typing');
  assert.equal(autotyper.isBusy(), true);

  // Pause
  autotyper.pause();
  assert.equal(autotyper.getStatus(), 'paused');

  // Resume
  autotyper.resume();
  assert.equal(autotyper.getStatus(), 'typing');

  // Wait for completion
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (autotyper.getStatus() === 'idle') {
        clearInterval(check);
        resolve();
      }
    }, 10);
  });

  // Verify typed characters ('H' and 'i')
  assert.equal(typedCodes.length, 2);
  assert.equal(String.fromCharCode(typedCodes[0]), 'H');
  assert.equal(String.fromCharCode(typedCodes[1]), 'i');
  assert.equal(autotyper.getStatus(), 'idle');
  assert.equal(autotyper.isBusy(), false);
});

test('createAutotyper toggle pauses when typing and resumes when paused', () => {
  const autotyper = createAutotyper({
    injector: {
      typeCodePoint: () => {},
      typeBackspace: () => {}
    },
    errorRate: 0,
    speedMultiplier: 0.1 // very slow so it stays in typing
  });

  autotyper.start('testing toggle');
  assert.equal(autotyper.getStatus(), 'typing');

  const res1 = autotyper.toggle();
  assert.equal(res1, 'paused');
  assert.equal(autotyper.getStatus(), 'paused');

  const res2 = autotyper.toggle();
  assert.equal(res2, 'typing');
  assert.equal(autotyper.getStatus(), 'typing');

  autotyper.stop();
  assert.equal(autotyper.getStatus(), 'idle');
});

test('createAutotyper switches to new code when resumed with a new prompt answer', () => {
  const autotyper = createAutotyper({
    injector: {
      typeCodePoint: () => {},
      typeBackspace: () => {}
    },
    errorRate: 0,
    speedMultiplier: 0.1
  });

  autotyper.start('prompt1 code');
  assert.equal(autotyper.getStatus(), 'typing');
  assert.equal(autotyper.getFullText(), 'prompt1 code');

  // Pause
  const pauseStatus = autotyper.toggle();
  assert.equal(pauseStatus, 'paused');
  assert.equal(autotyper.getStatus(), 'paused');

  // Resume with identical prompt answer -> resumes existing
  const resumeSame = autotyper.toggle('prompt1 code');
  assert.equal(resumeSame, 'typing');
  assert.equal(autotyper.getFullText(), 'prompt1 code');

  // Pause again
  autotyper.pause();
  assert.equal(autotyper.getStatus(), 'paused');

  // Resume with NEW prompt answer -> must discard old and start typing new code
  const resumeNew = autotyper.toggle('```python\ndef newSolution():\n    return 42\n```');
  assert.equal(resumeNew, 'typing');
  assert.equal(autotyper.getFullText(), 'def newSolution():\n    return 42');

  autotyper.stop();
  assert.equal(autotyper.getStatus(), 'idle');
});

test('stealth-input.cs, stealth-hook-manager, preload, main, and renderer wire autotyper correctly', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  const csSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'native', 'stealth-input.cs'), 'utf8');
  assert.match(csSrc, /SendInput\(uint nInputs/);
  assert.match(csSrc, /KEYEVENTF_UNICODE/);
  assert.match(csSrc, /TYPE_CODEPOINT/);
  assert.match(csSrc, /TYPE_BACKSPACE/);

  const hookManagerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'stealth-hook-manager.js'), 'utf8');
  assert.match(hookManagerSrc, /function typeCodePoint\(cp\)/);
  assert.match(hookManagerSrc, /function typeBackspace\(\)/);
  assert.match(hookManagerSrc, /typeCodePoint,\s*typeBackspace/);

  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preloadSrc, /autotypeToggle:\s*\(text\)\s*=>\s*ipcRenderer\.invoke\('autotype:toggle',\s*text\)/);
  assert.match(preloadSrc, /'autotype:state'/);

  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(mainSrc, /const \{ createAutotyper \} = require\('\.\/src\/autotyper'\);/);
  assert.match(mainSrc, /ipcMain\.handle\('autotype:toggle'/);
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+A'/);
  assert.match(mainSrc, /autotyper\.stop\(\)/);

  const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(rendererSrc, /function toggleAutotyper/);
  assert.match(rendererSrc, /cue\.on\('stt:answer-question'/);
  assert.match(rendererSrc, /resp-act-autotype/);
});

