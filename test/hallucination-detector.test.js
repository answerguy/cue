const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  HallucinationDetector,
  looksLikeHallucination,
  hasRepetitionLoop
} = require('../src/hallucination-detector');

test('looksLikeHallucination drops base Whisper silence artifacts', () => {
  const artifacts = [
    '',
    '   ',
    'Thank you.',
    'Thank you for watching.',
    'thanks for watching',
    'Thank you so much',
    'Thank you so much for watching.',
    'Thanks for listening.',
    'Thank you. Thank you!',
    'Bye-bye!',
    'you',
    'okay',
    '👍👍'
  ];
  for (const s of artifacts) {
    assert.equal(looksLikeHallucination(s), true, `Expected "${s}" to be dropped`);
  }
});

test('looksLikeHallucination drops new artifacts loaded from en.txt', () => {
  const newArtifacts = [
    'Thank you so much for joining us.',
    'Thank you for having me.',
    'Thank you for your time.',
    'Thank you very much for coming.',
    'Thanks for watching, and I\'ll see you next time.',
    'Have a good night, guys.',
    'Next slide, next slide.',
    'Let\'s do that again.',
    'We\'ll be right back.',
    'Do you want me to turn it off?'
  ];
  for (const s of newArtifacts) {
    assert.equal(looksLikeHallucination(s), true, `Expected en.txt entry "${s}" to be dropped`);
  }
});

test('looksLikeHallucination drops subtitle and watermark credits', () => {
  const watermarks = [
    'Subtitles by the Amara.org community',
    'subtitles by the Amara.org community',
    'Captioned by the Whisper team',
    'transcription by Google',
    'Translated by community'
  ];
  for (const s of watermarks) {
    assert.equal(looksLikeHallucination(s), true, `Expected watermark "${s}" to be dropped`);
  }
});

test('hasRepetitionLoop and looksLikeHallucination drop generic infinite repetition loops', () => {
  const loops = [
    'Thank you, Mr. President, thank you, Mr. President, thank you, Mr. President',
    'I am going to be a bad person, I am going to be a bad person, I am going to be a bad person.',
    'I am speaking, I am speaking, I am speaking.',
    'right here, right here, right here, right here',
    'Next slide, next slide, next slide, next slide'
  ];
  for (const s of loops) {
    assert.equal(hasRepetitionLoop(s), true, `Expected repetition loop detected for "${s}"`);
    assert.equal(looksLikeHallucination(s), true, `Expected looksLikeHallucination=true for loop "${s}"`);
  }
});

test('looksLikeHallucination preserves valid conversational speech', () => {
  const validSpeech = [
    'Tell me about your experience with Kubernetes.',
    'You know, I led the migration.',
    'Thank you for explaining the microservices architecture.',
    'The plan was good, really good, and finalized.',
    'Yes, I have worked with Docker and Kubernetes for three years.',
    'Can I ask a question about the team structure?'
  ];
  for (const s of validSpeech) {
    assert.equal(looksLikeHallucination(s), false, `Expected valid speech to be kept: "${s}"`);
  }
});

test('HallucinationDetector supports multi-language folder expansion (e.g. de.txt)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-hallucinations-test-'));
  try {
    fs.writeFileSync(
      path.join(tmpDir, 'de.txt'),
      '# German silence hallucinations\nVielen Dank fürs Zuschauen.\nAbonnieren nicht vergessen.\nTschüss!\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'en.txt'),
      'Thank you for watching.\nBye-bye.\n'
    );

    const detector = new HallucinationDetector(tmpDir);
    const languages = detector.getLoadedLanguages();
    assert.ok(languages.includes('de'), 'Should detect and load de.txt');
    assert.ok(languages.includes('en'), 'Should detect and load en.txt');

    // German hallucinations
    assert.equal(detector.looksLikeHallucination('Vielen Dank fürs Zuschauen.', { language: 'de' }), true);
    assert.equal(detector.looksLikeHallucination('Abonnieren nicht vergessen.', { language: 'de' }), true);
    assert.equal(detector.looksLikeHallucination('Tschüss!', { language: 'de' }), true);

    // Also caught globally across all languages
    assert.equal(detector.looksLikeHallucination('Vielen Dank fürs Zuschauen.'), true);

    // Real German speech kept
    assert.equal(detector.looksLikeHallucination('Ich habe viel Erfahrung mit Cloud-Architektur.', { language: 'de' }), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('looksLikeHallucination execution is near-instant (< 0.05ms per check)', () => {
  const samples = [
    'Tell me about your experience with Kubernetes and how you deployed microservices.',
    'Thank you for watching.',
    'Thank you, Mr. President, thank you, Mr. President, thank you, Mr. President',
    'I led the DevOps team at my previous company for three years.'
  ];

  // Warmup
  for (let i = 0; i < 50; i++) {
    for (const s of samples) looksLikeHallucination(s);
  }

  const iterations = 1000;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    for (const s of samples) {
      looksLikeHallucination(s);
    }
  }
  const totalMs = performance.now() - start;
  const avgMsPerCheck = totalMs / (iterations * samples.length);

  assert.ok(
    avgMsPerCheck < 0.05,
    `Average check latency was ${avgMsPerCheck.toFixed(4)}ms, expected < 0.05ms`
  );
});
