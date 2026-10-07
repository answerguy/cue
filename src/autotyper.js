// Human-mimicking autotyper engine for Cue
// Types text smoothly into the active application window without stealing focus.

const KEY_NEIGHBORS = {
  q: ['w', 'a', 's'],
  w: ['q', 'e', 's', 'a', 'd'],
  e: ['w', 'r', 'd', 's', 'f'],
  r: ['e', 't', 'f', 'd', 'g'],
  t: ['r', 'y', 'g', 'f', 'h'],
  y: ['t', 'u', 'h', 'g', 'j'],
  u: ['y', 'i', 'j', 'h', 'k'],
  i: ['u', 'o', 'k', 'j', 'l'],
  o: ['i', 'p', 'l', 'k'],
  p: ['o', 'l'],
  a: ['q', 'w', 's', 'z'],
  s: ['a', 'w', 'e', 'd', 'x', 'z'],
  d: ['s', 'e', 'r', 'f', 'c', 'x'],
  f: ['d', 'r', 't', 'g', 'v', 'c'],
  g: ['f', 't', 'y', 'h', 'b', 'v'],
  h: ['g', 'y', 'u', 'j', 'n', 'b'],
  j: ['h', 'u', 'i', 'k', 'm', 'n'],
  k: ['j', 'i', 'o', 'l', 'm'],
  l: ['k', 'o', 'p'],
  z: ['a', 's', 'x'],
  x: ['z', 's', 'd', 'c'],
  c: ['x', 'd', 'f', 'v'],
  v: ['c', 'f', 'g', 'b'],
  b: ['v', 'g', 'h', 'n'],
  n: ['b', 'h', 'j', 'm'],
  m: ['n', 'j', 'k']
};

/**
 * Extracts the primary text to type from raw LLM output.
 * If the output contains fenced code blocks (e.g. from LeetCode or coding problems),
 * extracts the code inside the block so the autotyper enters valid code rather than markdown.
 */
function extractTextToAutotype(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  const text = rawText.trim();
  if (!text) return '';

  // Look for fenced code blocks ```[lang]\n...\n```
  const codeBlockRegex = /```(?:[a-zA-Z0-9_+#.-]*)\r?\n([\s\S]*?)```/g;
  const matches = [...text.matchAll(codeBlockRegex)];
  if (matches.length > 0) {
    // If multiple code blocks exist, pick the longest one (primary solution)
    let best = matches[0][1];
    for (let i = 1; i < matches.length; i++) {
      if (matches[i][1].length > best.length) {
        best = matches[i][1];
      }
    }
    return best.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
  }

  // No code blocks: return plain text normalized
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Creates a human-like autotyper instance.
 */
function createAutotyper(options = {}) {
  const {
    injector = {},
    errorRate = 0.02, // 2% typo rate on letters
    speedMultiplier = 0.75, // Increased by 50% from 0.5 for balanced interview pacing
    onStateChange = () => {}
  } = options;

  let timer = null;
  let status = 'idle'; // 'idle' | 'typing' | 'paused'
  let chars = [];
  let index = 0;
  let fullText = '';

  function notify() {
    const total = chars.length;
    const progress = total > 0 ? Math.min(1, index / total) : 0;
    try {
      onStateChange({
        status,
        progress,
        index,
        total,
        text: fullText
      });
    } catch (_) {}
  }

  function getHumanDelay(char, prevChar) {
    // Base inter-keystroke interval for a thinking candidate (~120ms - 240ms)
    let delay = 120 + Math.random() * 120;

    // Slight burst for fluent adjacent letters
    if (prevChar && /[a-z]/.test(prevChar) && /[a-z]/.test(char)) {
      delay -= 20 + Math.random() * 20;
    }

    // Shift key cognitive delay for uppercase / symbols
    if (/[A-Z!@#$%^&*()_{}:"<>?]/.test(char)) {
      delay += 80 + Math.random() * 90;
    }

    // Word boundary pause
    if (char === ' ') {
      delay += 100 + Math.random() * 160;
    }

    // Punctuation and bracket/operator thinking pauses
    if (/[.,;:?!]/.test(char)) {
      delay += 400 + Math.random() * 450;
    } else if (/[()[\]{}=+\-*/<>]/.test(char)) {
      delay += 200 + Math.random() * 250;
    }

    // Newline thinking/explaining pause:
    // In an interview, the candidate pauses between lines to explain their thought process (~1.2s - 2.4s)
    if (char === '\n') {
      delay += 1200 + Math.random() * 1400;
    }

    // Occasional candidate hesitation (e.g. 8% chance on spaces or operators)
    if ((char === ' ' || char === ';' || char === ',') && Math.random() < 0.08) {
      delay += 450 + Math.random() * 600;
    }

    delay = delay / Math.max(0.1, speedMultiplier);
    return Math.max(30, Math.floor(delay));
  }

  async function typeNext() {
    timer = null;
    if (status !== 'typing') return;

    if (index >= chars.length) {
      status = 'idle';
      notify();
      return;
    }

    const char = chars[index];
    const prevChar = index > 0 ? chars[index - 1] : '';

    // Check for realistic human typo
    const isLetter = /[a-zA-Z]/.test(char);
    if (isLetter && Math.random() < errorRate) {
      const lower = char.toLowerCase();
      const neighbors = KEY_NEIGHBORS[lower];
      if (neighbors && neighbors.length > 0) {
        const wrongKey = neighbors[Math.floor(Math.random() * neighbors.length)];
        const wrongChar = (char === char.toUpperCase()) ? wrongKey.toUpperCase() : wrongKey;

        // 1. Type incorrect neighbor character
        if (typeof injector.typeCodePoint === 'function') {
          injector.typeCodePoint(wrongChar.codePointAt(0));
        }

        // 2. Pause to "realize" mistake (120ms - 240ms)
        const realizeDelay = Math.floor(120 + Math.random() * 120);
        await new Promise((r) => setTimeout(r, realizeDelay));

        if (status !== 'typing') return;

        // 3. Send Backspace
        if (typeof injector.typeBackspace === 'function') {
          injector.typeBackspace();
        }

        // 4. Pause before typing correct character (80ms - 150ms)
        const correctDelay = Math.floor(80 + Math.random() * 70);
        await new Promise((r) => setTimeout(r, correctDelay));

        if (status !== 'typing') return;
      }
    }

    // Type the correct character
    if (typeof injector.typeCodePoint === 'function') {
      injector.typeCodePoint(char.codePointAt(0));
    }

    index++;
    notify();

    if (index >= chars.length) {
      status = 'idle';
      notify();
      return;
    }

    const nextDelay = getHumanDelay(chars[index], prevChar);
    timer = setTimeout(typeNext, nextDelay);
  }

  function start(text) {
    stop();
    const clean = extractTextToAutotype(text);
    if (!clean) return false;

    fullText = clean;
    chars = Array.from(clean);
    index = 0;
    status = 'typing';
    notify();

    // Small initial grace period (200ms) before typing begins
    timer = setTimeout(typeNext, 200);
    return true;
  }

  function pause() {
    if (status !== 'typing') return false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    status = 'paused';
    notify();
    return true;
  }

  function resume(text) {
    if (status !== 'paused') return false;
    const clean = text ? extractTextToAutotype(text) : '';
    if (clean && clean !== fullText) {
      return start(text);
    }
    status = 'typing';
    notify();
    timer = setTimeout(typeNext, 150);
    return true;
  }

  function toggle(text) {
    const clean = text ? extractTextToAutotype(text) : '';

    // If a new prompt answer was generated (different from what was loaded/typed),
    // start typing the new code instead of resuming the stale previous code
    if (clean && clean !== fullText) {
      const ok = start(text);
      return ok ? 'typing' : 'idle';
    }

    if (status === 'typing') {
      pause();
      return 'paused';
    }

    if (status === 'paused') {
      resume();
      return 'typing';
    }

    if (text) {
      const ok = start(text);
      return ok ? 'typing' : 'idle';
    }

    return 'idle';
  }

  function setText(text) {
    const clean = extractTextToAutotype(text);
    if (!clean) return;
    if (clean !== fullText) {
      stop();
    }
  }

  function getFullText() {
    return fullText;
  }

  function stop() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    status = 'idle';
    chars = [];
    index = 0;
    fullText = '';
    notify();
  }

  function getStatus() {
    return status;
  }

  function isBusy() {
    return status === 'typing' || status === 'paused';
  }

  function getCurrentProgress() {
    const total = chars.length;
    return {
      status,
      progress: total > 0 ? index / total : 0,
      index,
      total
    };
  }

  return {
    start,
    pause,
    resume,
    toggle,
    stop,
    setText,
    getFullText,
    getStatus,
    isBusy,
    getCurrentProgress,
    extractTextToAutotype
  };
}

module.exports = {
  createAutotyper,
  extractTextToAutotype,
  KEY_NEIGHBORS
};
