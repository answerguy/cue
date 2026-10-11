const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  GEMINI_LIVE_DEFAULT_FAST,
  GEMINI_LIVE_DEFAULT_SMART,
  resolveGeminiLiveModel,
  buildLiveHelpSystem,
  GeminiLiveHelpSession
} = require('../src/gemini-live-help');
const shortcuts = require('../src/shortcuts');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const csSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'native', 'stealth-input.cs'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const stylesSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

test('defines Gemini 3.8 Live and Gemini 3.8 Live Extended Thinking as default models', () => {
  assert.equal(GEMINI_LIVE_DEFAULT_FAST, 'gemini-3.8-live');
  assert.equal(GEMINI_LIVE_DEFAULT_SMART, 'gemini-3.8-live-extended-thinking');
});

test('resolveGeminiLiveModel uses fast model by default and smart model when smart is enabled', () => {
  // Fast tier (smart: false)
  assert.equal(resolveGeminiLiveModel({ smart: false }), 'gemini-3.8-live');
  assert.equal(resolveGeminiLiveModel({}), 'gemini-3.8-live');

  // Smart tier (smart: true)
  assert.equal(resolveGeminiLiveModel({ smart: true }), 'gemini-3.8-live-extended-thinking');
});

test('resolveGeminiLiveModel allows user customization of both fast and smart models', () => {
  // User customized in liveHelp.models
  const customLiveHelp = {
    smart: false,
    liveHelp: {
      models: {
        fast: 'my-custom-fast-live-model',
        smart: 'my-custom-smart-live-model'
      }
    }
  };
  assert.equal(resolveGeminiLiveModel(customLiveHelp), 'my-custom-fast-live-model');

  customLiveHelp.smart = true;
  assert.equal(resolveGeminiLiveModel(customLiveHelp), 'my-custom-smart-live-model');

  // User customized in models.geminiLive
  const customModels = {
    smart: false,
    models: {
      geminiLive: {
        fast: 'custom-gemini-live-fast',
        smart: 'custom-gemini-live-smart'
      }
    }
  };
  assert.equal(resolveGeminiLiveModel(customModels), 'custom-gemini-live-fast');

  customModels.smart = true;
  assert.equal(resolveGeminiLiveModel(customModels), 'custom-gemini-live-smart');
});

test('buildLiveHelpSystem creates first-person copilot prompt with resume and rules context', () => {
  const prompt = buildLiveHelpSystem({
    resumeConfig: 'Senior Full Stack Engineer with 7 years of distributed systems experience',
    hrConfig: 'Handled high pressure incident by leading post-mortem',
    aiRules: 'Keep responses under 3 sentences.'
  });

  assert.match(prompt, /invisible real-time copilot/i);
  assert.match(prompt, /first person/i);
  assert.match(prompt, /Senior Full Stack Engineer/i);
  assert.match(prompt, /Handled high pressure incident/i);
  assert.match(prompt, /Keep responses under 3 sentences/i);
});

test('GeminiLiveHelpSession connects and streams tokens over live session', async () => {
  const tokens = [];
  let turnResult = null;
  const statuses = [];

  const fakeSession = {
    closed: false,
    sentRealtime: [],
    sentClient: [],
    sendRealtimeInput(input) { this.sentRealtime.push(input); },
    sendClientContent(content) { this.sentClient.push(content); },
    close() { this.closed = true; }
  };

  const fakeClient = {
    live: {
      connect: async (params) => {
        // simulate async server turn
        setTimeout(() => {
          params.callbacks.onmessage({
            serverContent: {
              modelTurn: {
                parts: [{ text: 'Here ' }, { text: 'is live ' }, { text: 'help.' }]
              }
            }
          });
          params.callbacks.onmessage({
            serverContent: {
              turnComplete: true
            }
          });
        }, 10);
        return fakeSession;
      }
    }
  };

  const session = new GeminiLiveHelpSession({
    apiKey: 'test-gemini-key',
    model: 'gemini-3.8-live',
    createClient: () => fakeClient,
    onStatusChange: (s) => statuses.push(s),
    onToken: (t) => tokens.push(t),
    onTurnComplete: (full) => { turnResult = full; }
  });

  await session.connect();
  assert.equal(session.connected, true);
  assert.ok(statuses.includes('connected'));

  // Test audio sending
  session.sendAudio(Buffer.from([0, 1, 2, 3]));
  assert.equal(fakeSession.sentRealtime.length, 1);
  assert.equal(fakeSession.sentRealtime[0].audio.mimeType, 'audio/pcm;rate=16000');

  // Test text sending
  session.sendText('Explain this algorithm');
  assert.equal(fakeSession.sentClient.length, 1);
  assert.equal(fakeSession.sentClient[0].turns[0].parts[0].text, 'Explain this algorithm');

  // Wait for turn emission
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(tokens, ['Here ', 'is live ', 'help.']);
  assert.equal(turnResult, 'Here is live help.');

  session.close();
  assert.equal(session.connected, false);
  assert.equal(fakeSession.closed, true);
});

test('GeminiLiveHelpSession rejects cleanly when API key is missing', async () => {
  let errorCaught = null;
  const session = new GeminiLiveHelpSession({
    apiKey: '',
    onError: (err) => { errorCaught = err; }
  });

  await session.connect();
  assert.equal(session.connected, false);
  assert.ok(errorCaught);
  assert.match(errorCaught.message, /Gemini API key is required/i);
});

test('shortcuts.js maps liveHelp to Alt+D with zero conflicts', () => {
  assert.equal(shortcuts.DEFAULTS.liveHelp, 'Alt+D');
  const conflicts = shortcuts.findConflicts(shortcuts.resolveShortcuts());
  assert.equal(conflicts.length, 0);
});

test('main.js registers Alt+D global shortcut and routes live_help action', () => {
  assert.match(mainSrc, /globalShortcut\.register\('Alt\+D'/);
  assert.match(mainSrc, /action === 'live_help'/);
  assert.match(mainSrc, /toggleLiveHelp\(\)/);
  assert.match(mainSrc, /ipcMain\.handle\('live-help:toggle'/);
  assert.match(mainSrc, /ipcMain\.handle\('live-help:get'/);
});

test('main.js only routes interviewer audio and transcripts to Gemini Live to prevent feedback loop', () => {
  assert.match(mainSrc, /if \(isLiveHelpActive && liveHelpSession && channel === 'them'\) \{\s*liveHelpSession\.sendAudio\(buf\);/);
  assert.match(mainSrc, /if \(isLiveHelpActive && liveHelpSession && channel === 'them'\) \{\s*liveHelpSession\.sendText\(`Interviewer: \${turn\.text}`\);/);
  assert.doesNotMatch(mainSrc, /Candidate: \${turn\.text}/);
});

test('preload.js exposes liveHelp APIs and allows live-help IPC channels', () => {
  assert.match(preloadSrc, /liveHelpToggle:\s*\(\)\s*=>/);
  assert.match(preloadSrc, /liveHelpGet:\s*\(\)\s*=>/);
  assert.match(preloadSrc, /liveHelpAsk:\s*\(text\)\s*=>/);
  assert.match(preloadSrc, /'live-help:state'/);
  assert.match(preloadSrc, /'live-help:status'/);
  assert.match(preloadSrc, /'live-help:turn-start'/);
  assert.match(preloadSrc, /'live-help:token'/);
  assert.match(preloadSrc, /'live-help:done'/);
  assert.match(preloadSrc, /'live-help:error'/);
});

test('stealth-input.cs defines 0x44 (D) for Alt+D and dispatches live_help action', () => {
  assert.match(csSrc, /case 0x44:[\s\S]*?action[\s\S]*?live_help/);
  assert.match(csSrc, /bool isD = \(vk == 0x44 \|\| vk == 0x64\);/);
});

test('index.html contains Live Help button in action-row and dedicated live-help-sidebar container', () => {
  assert.match(htmlSrc, /data-mode="live_help"/);
  assert.match(htmlSrc, /id="live-help-shortcut-hint">Alt\+D<\/span>/);
  assert.match(htmlSrc, /id="gemini-live-model-fast"/);
  assert.match(htmlSrc, /id="gemini-live-model-smart"/);
  assert.match(htmlSrc, /id="live-help-sidebar" class="live-help-sidebar"/);
  assert.match(htmlSrc, /id="lh-list"/);
  assert.match(htmlSrc, /id="clear-live-help-btn"/);
});

test('styles.css lays out live-help-sidebar to the left of the main panel', () => {
  assert.match(stylesSrc, /\.live-help-sidebar\s*\{[\s\S]*?right:\s*calc\(100%\s*\+\s*12px\);/);
  assert.match(stylesSrc, /\.live-help-sidebar\.open\s*\{/);
  assert.match(stylesSrc, /#live-help-sidebar[\s\S]*?pointer-events:\s*auto;/);
});

test('renderer.js supports Alt+D keydown, manages live-help-sidebar container, and listens to live-help events', () => {
  assert.match(rendererSrc, /async function toggleLiveHelp\(\)/);
  assert.match(rendererSrc, /cue\.on\('live-help:trigger'/);
  assert.match(rendererSrc, /cue\.on\('live-help:state'/);
  assert.match(rendererSrc, /cue\.on\('live-help:turn-start'/);
  assert.match(rendererSrc, /cue\.on\('live-help:token'/);
  assert.match(rendererSrc, /cue\.on\('live-help:done'/);
  assert.match(rendererSrc, /showLiveHelpSidebar/);
  assert.match(rendererSrc, /e\.altKey && \(e\.key === 'd' \|\| e\.key === 'D'\)[\s\S]*?toggleLiveHelp\(\)/);
});

test('renderer.js populates and persists geminiLive models in settings', () => {
  assert.match(rendererSrc, /liveFastEl\.value[\s\S]*?geminiLive\.fast[\s\S]*?gemini-3\.8-live/);
  assert.match(rendererSrc, /liveSmartEl\.value[\s\S]*?geminiLive\.smart[\s\S]*?gemini-3\.8-live-extended-thinking/);
  assert.match(rendererSrc, /settings\.models\.geminiLive\.fast\s*=\s*liveFastVal/);
  assert.match(rendererSrc, /settings\.models\.geminiLive\.smart\s*=\s*liveSmartVal/);
});

test('GeminiLiveHelpSession uses AUDIO modality, enables outputAudioTranscription, and buffers audio before connect', async () => {
  let capturedConfig = null;
  const sentRealtime = [];
  const tokens = [];
  let turnResult = null;

  const fakeSession = {
    closed: false,
    sendRealtimeInput(input) { sentRealtime.push(input); },
    sendClientContent() {},
    close() { this.closed = true; }
  };

  const fakeClient = {
    live: {
      connect: async (params) => {
        capturedConfig = params.config;
        return fakeSession;
      }
    }
  };

  const session = new GeminiLiveHelpSession({
    apiKey: 'test-key',
    model: 'gemini-3.8-live',
    createClient: () => fakeClient,
    onToken: (t) => tokens.push(t),
    onTurnComplete: (full) => { turnResult = full; }
  });

  // Buffer audio before connection
  session.sendAudio(Buffer.from([10, 20]));
  session.sendAudio(Buffer.from([30, 40]));
  assert.equal(sentRealtime.length, 0, 'audio should be buffered before connect');

  await session.connect();

  // Verify modal configuration complies with Gemini Live API requirements
  assert.deepEqual(capturedConfig.responseModalities, ['AUDIO']);
  assert.ok(typeof capturedConfig.outputAudioTranscription === 'object');
  assert.ok(typeof capturedConfig.inputAudioTranscription === 'object');

  // Verify buffered audio was flushed immediately upon connect
  assert.equal(sentRealtime.length, 2, 'buffered audio should be flushed upon connect');

  // Test server streaming outputAudioTranscription / outputTranscription
  session._handleMessage({
    serverContent: {
      outputTranscription: { text: 'To implement a binary search' }
    }
  });
  session._handleMessage({
    serverContent: {
      outputTranscription: { text: 'To implement a binary search, maintain two pointers.' }
    }
  });
  session._handleMessage({
    serverContent: {
      turnComplete: true
    }
  });

  assert.deepEqual(tokens, [
    'To implement a binary search',
    ', maintain two pointers.'
  ]);
  assert.equal(turnResult, 'To implement a binary search, maintain two pointers.');
});

