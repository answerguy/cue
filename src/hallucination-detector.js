const fs = require('fs');
const path = require('path');

// Base fallback artifacts guaranteed even if no text files exist on disk
const BASE_FALLBACK_ARTIFACTS = Object.freeze([
  'thank you', 'thank you very much', 'thank you for watching', 'thanks for watching',
  'thank you so much', 'thank you so much for watching', 'thanks for listening',
  'thank you for listening', 'please subscribe', 'like and subscribe', 'please like and subscribe',
  'subscribe', 'bye-bye', 'bye bye', 'bye', 'you', 'okay', 'subtitles by'
]);

const EMOJI_REGEX = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u;
const WATERMARK_PREFIX_REGEX = /^(?:subtitles?|caption(?:s|ed)?|transcription|transcribed|translated)\s+(?:by|provided|from)/i;
const REPEATING_CLAUSE_REGEX = /([a-z0-9 '’-]{3,40}?)(?:[.,!?:;…\s]+\1){2,}/i;

function normalizeArtifact(str) {
  return (str || '')
    .trim()
    .toLowerCase()
    .replace(/^[.,!?:;…'"]+|[.,!?:;…'"]+$/g, '')
    .trim();
}

/**
 * Detects generic repetition loops in text (e.g. "Thank you, Mr. President, thank you, Mr. President...")
 * independently of any blocklist.
 * Designed to execute in sub-millisecond time.
 */
function hasRepetitionLoop(rawText) {
  if (!rawText || rawText.length < 15) return false;
  const normalizedText = rawText.toLowerCase().trim();

  // 1. Fast regex match for repeating phrases
  if (REPEATING_CLAUSE_REGEX.test(normalizedText)) return true;

  // 2. Tokenize words for n-gram repetition
  const words = normalizedText
    .split(/\s+/)
    .map(w => w.replace(/^[.,!?:;…'"]+|[.,!?:;…'"]+$/g, ''))
    .filter(Boolean);

  if (words.length < 6) return false;

  // Check n-gram loops (1 to 8 words repeating 3+ consecutive times)
  const maxN = Math.min(8, Math.floor(words.length / 3));
  for (let n = 1; n <= maxN; n++) {
    for (let i = 0; i <= words.length - n * 3; i++) {
      const p1 = words.slice(i, i + n).join(' ');
      const p2 = words.slice(i + n, i + 2 * n).join(' ');
      const p3 = words.slice(i + 2 * n, i + 3 * n).join(' ');
      if (p1 === p2 && p2 === p3) {
        return true;
      }
    }
  }

  // 3. Overall skew: if 50%+ of an utterance is the exact same word repeated 5+ times
  const wordFreq = new Map();
  for (const w of words) {
    wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
  }
  for (const count of wordFreq.values()) {
    if (count >= 5 && count / words.length >= 0.5) return true;
  }

  return false;
}

class HallucinationDetector {
  constructor(customDirectory) {
    this.byLanguage = new Map();
    this.allArtifacts = new Set();
    this.init(customDirectory);
  }

  init(customDirectory) {
    this.byLanguage.clear();
    this.allArtifacts.clear();

    // Seed defaults
    const enSet = new Set(BASE_FALLBACK_ARTIFACTS.map(normalizeArtifact));
    this.byLanguage.set('en', enSet);
    for (const a of enSet) this.allArtifacts.add(a);

    // Look for hallucinations directories
    const directories = [
      customDirectory,
      path.join(__dirname, 'hallucinations'),
      path.join(process.cwd(), 'hallucinations')
    ].filter(Boolean);

    for (const dir of directories) {
      if (fs.existsSync(dir)) {
        this.loadDirectory(dir);
        break; // prioritize first found directory
      }
    }
  }

  loadDirectory(dirPath) {
    try {
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.txt'));
      for (const file of files) {
        const lang = path.basename(file, '.txt').toLowerCase();
        let langSet = this.byLanguage.get(lang);
        if (!langSet) {
          langSet = new Set();
          this.byLanguage.set(lang, langSet);
        }

        const fullPath = path.join(dirPath, file);
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split(/\r?\n/);

        for (let line of lines) {
          line = line.trim();
          if (!line || line.startsWith('#') || line === '.') continue;
          const normalized = normalizeArtifact(line);
          if (normalized) {
            langSet.add(normalized);
            this.allArtifacts.add(normalized);
          }
        }
      }
    } catch (err) {
      console.error('[hallucinations] Error loading directory:', dirPath, err);
    }
  }

  getLoadedLanguages() {
    return Array.from(this.byLanguage.keys());
  }

  looksLikeHallucination(raw, options = {}) {
    const trimmed = (raw || '').trim();
    if (!trimmed) return true;

    // 1. Emoji-only strings (common Whisper silence artifact)
    if (EMOJI_REGEX.test(trimmed)) return true;

    // Normalize text
    const t = trimmed.replace(/^[.,!?:;…\s]+|[.,!?:;…\s]+$/g, '').trim().toLowerCase();
    if (!t) return true;

    // 2. Subtitle / Watermark artifacts (prefix or substring)
    if (WATERMARK_PREFIX_REGEX.test(t) || t.includes('amara.org')) return true;

    // 3. Fast O(1) set lookup
    const lang = typeof options === 'string' ? options : (options && options.language);
    const langSet = lang ? this.byLanguage.get(lang.toLowerCase()) : null;

    if (langSet && langSet.has(t)) return true;
    if (this.allArtifacts.has(t)) return true;

    // 4. Multiple repeated known artifacts (e.g. "Thank you. Thank you!")
    const phrases = t.split(/[.,!?:;…\n]+/).map(s => s.trim()).filter(Boolean);
    if (phrases.length > 1 && phrases.every(p => this.allArtifacts.has(p))) return true;

    // 5. Generic infinite repetition loop detection
    if (hasRepetitionLoop(t)) return true;

    return false;
  }
}

// Singleton instance for the process with hot-reload capability
const defaultDetector = new HallucinationDetector();

function looksLikeHallucination(raw, options) {
  return defaultDetector.looksLikeHallucination(raw, options);
}

module.exports = {
  HallucinationDetector,
  looksLikeHallucination,
  hasRepetitionLoop,
  defaultDetector,
  normalizeArtifact,
  BASE_FALLBACK_ARTIFACTS
};
