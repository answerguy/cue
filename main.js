const DEBUG = false; // Set to false to disable debug logging
const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell, dialog } = require('electron');
const path = require('path');
const store = require('./src/store');
const { captureScreenshot } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { createStreamingSTT } = require('./src/stt-stream');
const { createLLM } = require('./src/llm');
const { MODES } = require('./src/prompts');
const { rms16 } = require('./src/wav');
const { parseDocumentFile } = require('./src/resume');
const transcriptStore = require('./src/transcript-store');

let win = null;

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false; // set when the key can't reach any speech model (stops retry spam)
const buffers = { you: [], them: [] };
const transcript = []; // { channel, text, ts }
const FLUSH_MS = 3500;
const MIN_BYTES = Math.floor(16000 * 2 * 0.6); // ~0.6s
const RMS_GATE = 240;
const STREAM_INACTIVITY_MS = 25000; // abort a stalled LLM stream so busy can't wedge forever
let flushTimer = null;

// -------- streaming STT (Deepgram) state --------
// When a Deepgram key is set, mic:pcm/system:pcm go straight to a live WS connection
// instead of the batch buffers above. Falls back to the batch path automatically.
let streamingSTT = null;
let lastAutoTrigger = 0;
const AUTO_TRIGGER_COOLDOWN_MS = 8000;

function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

// -------- window --------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 700, H = 600;
  win = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: workArea.y + 6,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // Invisibility + overlay behavior. Set CUE_NO_PROTECT=1 to disable for debugging.
  win.setContentProtection(!process.env.CUE_NO_PROTECT);            // excluded from screen capture (best-effort)
  if (process.platform === 'darwin') {
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(true);
  } else {
    win.setAlwaysOnTop(true);
  }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.on('did-finish-load', () => win.showInactive());
  win.webContents.on('render-process-gone', (_e, d) => console.log('[cue] renderer gone', JSON.stringify(d)));
}

// -------- STT flushing --------
async function flushChannel(channel) {
  if (state.transcribing[channel]) return;
  const chunks = buffers[channel];
  if (!chunks.length) { console.log('[stt-batch]', channel, 'flush: buffer empty (no PCM arrived from renderer this cycle)'); return; }
  const pcm = Buffer.concat(chunks);
  buffers[channel] = [];
  if (pcm.length < MIN_BYTES) { console.log('[stt-batch]', channel, 'flush: too short —', pcm.length, 'bytes, need', MIN_BYTES); return; }
  const loudness = rms16(pcm);
  if (loudness < RMS_GATE) { console.log('[stt-batch]', channel, 'flush: too quiet — rms', loudness.toFixed(1), 'below gate', RMS_GATE); return; } // silence gate
  console.log('[stt-batch]', channel, 'flush: sending', pcm.length, 'bytes to STT (rms', loudness.toFixed(1) + ')');

  state.transcribing[channel] = true;
  try {
    const settings = store.getSettings();
    const stt = createSTT(settings);
    if (!stt.available) {
      if (!sttDisabled) { sttDisabled = true; send('status', { message: 'No transcription key set. Add an OpenAI (Whisper) or Gemini key in Settings to enable listening. Screen/LeetCode features work without it.' }); }
      return;
    }
    const res = await stt.transcribe(pcm);
    if (res.error) {
      console.log('[stt-batch]', channel, 'STT call failed:', res.error);
      handleSttError(res.error, settings);
      return;
    }
    if (res.text && res.text.trim()) {
      const turn = { channel, text: res.text.trim(), ts: Date.now() };
      transcript.push(turn);
      transcriptStore.append(turn);
      console.log(`[stt-batch] ${channel} transcribed:`, turn.text);
      send('transcript', turn);
    } else {
      console.log('[stt-batch]', channel, 'STT returned empty text (provider:', res.provider + ')');
    }
  } catch (e) {
    console.log('[stt] error', e && e.message);
  } finally {
    state.transcribing[channel] = false;
  }
}

function handleSttError(err, settings) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  if (sttDisabled) return;
  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found';
  sttDisabled = true; // stop hammering the API every few seconds
  if (noAccess) {
    send('status', { message: 'Transcription off: your ' + err.provider + ' key has no access to a speech-to-text model (403). Screen + LeetCode still work. To enable listening: give the key Whisper/transcription access, or add a Gemini key in Settings and reopen.' });
  } else {
    send('status', { message: 'Transcription error (' + err.provider + '): ' + err.message });
  }
}

function startFlushLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushChannel('you'); flushChannel('them'); }, FLUSH_MS);
}
function stopFlushLoop() { if (flushTimer) { clearInterval(flushTimer); flushTimer = null; } }

// -------- streaming STT callbacks --------
function handleStreamingPartial(channel, text) { send('transcript:partial', { channel, text }); }

async function handleStreamingFinal(channel, text) {
  const turn = { channel, text, ts: Date.now() };
  transcript.push(turn);
  transcriptStore.append(turn);
  if (DEBUG) console.log(`[TRANSCRIPT] ${channel === 'you' ? 'You' : 'Them'}:`, text);
  send('transcript', turn);
  if (channel === 'them') maybeAutoTrigger(text);
}

function handleStreamingError(channel, err) {
  console.log('[stt-stream] error', channel, err && err.message);
}

// If Them just said something that sounds like a question, fire "What should I say?"
// automatically — gated by a cooldown so back-and-forth doesn't spam LLM calls.
async function maybeAutoTrigger(text) {
  if (state.busy) return;
  const now = Date.now();
  if (now - lastAutoTrigger < AUTO_TRIGGER_COOLDOWN_MS) return;
  const settings = store.getSettings();
  const llm = createLLM(settings);
  if (!llm.ready) return;
  let isQuestion = false;
  try {
    const full = await llm.stream({
      system: 'Reply with exactly one word, YES or NO. YES if the following line — said by the other ' +
        'person in a live conversation — is a question or request that deserves a spoken answer. ' +
        'NO for small talk, filler, or statements needing no reply.',
      turns: [{ role: 'user', text }],
      maxTokens: 3,
      onToken: () => {}
    });
    isQuestion = /yes/i.test(full);
  } catch (e) {
    return; // classifier failure just skips auto-trigger, no user-facing error
  }
  if (isQuestion && !state.busy) {
    lastAutoTrigger = now;
    runFeature('say', '');
  }
}

// -------- capture toggle --------
// Mic + system audio are both captured in the RENDERER (getUserMedia for the mic,
// getDisplayMedia loopback for system audio) so they run inside cue's own process
// and use cue's own Screen-Recording grant — no separate helper binary to authorize.
function setCapturing(active) {
  state.capturing = active;
  if (active) {
    const settings = store.getSettings();
    streamingSTT = createStreamingSTT(settings, {
      onPartial: handleStreamingPartial,
      onFinal: handleStreamingFinal,
      onError: handleStreamingError
    });
    if (!streamingSTT.available) startFlushLoop(); // no Deepgram key — batch pipeline instead
  } else {
    stopFlushLoop();
    if (streamingSTT) { streamingSTT.close(); streamingSTT = null; }
    buffers.you = []; buffers.them = [];
  }
  send('capture:state', { active });
  return active;
}

// -------- feature runner --------
async function runFeature(mode, userText) {
  if (DEBUG) console.log('[DEBUG MAIN] runFeature called:', { mode, userText, isBusy: state.busy });
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) {
    if (DEBUG) console.log('[DEBUG MAIN] mode not found:', mode);
    return;
  }
  state.busy = true;
  let streamSettled = false; // drop stray tokens from a stream we've already aborted
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings);
    const userBubble = def.userBubble !== null ? def.userBubble : (mode === 'ask' ? userText : null);
    if (DEBUG) console.log('[DEBUG MAIN] LLM settings loaded:', { provider: settings.provider, smart: settings.smart });
    send('llm:start', { userBubble, small: !!def.small });

    if (!llm.ready) {
      if (DEBUG) console.log('[DEBUG MAIN] LLM not ready (missing key or model).');
      send('llm:error', { message: 'Add your ' + settings.provider + ' API key in Settings (gear icon) to start. Model: ' + (llm.model || 'unset') + '.' });
      return;
    }

    let imageDataUrl = null;
    if (def.needsScreen) {
      if (DEBUG) console.log('[DEBUG MAIN] Feature needs screen. Capturing screenshot...');
      try { 
        imageDataUrl = await captureScreenshot(); 
        if (DEBUG) console.log('[DEBUG MAIN] Screenshot captured successfully (length:', imageDataUrl.length, ')');
      }
      catch (e) { 
        if (DEBUG) console.error('[DEBUG MAIN] Screenshot capture failed:', e);
        send('status', { message: 'Screen capture needs permission — grant Screen Recording to cue in System Settings.' }); 
      }
    }

    const built = def.build({ transcript, userText: userText || '', profile: settings.profile });
    if (DEBUG) console.log('[DEBUG MAIN] Built prompt. Starting LLM stream...');

    // Watchdog: if the provider stalls (no token for STREAM_INACTIVITY_MS) the awaited stream
    // can hang forever, which used to leave state.busy=true permanently and freeze every later
    // question until an app restart. Re-arm the timer on each token; if it fires, reject the race
    // so we fall into catch → finally, which releases the lock and lets the next question run.
    let watchdog = null;
    let rearm = () => {};
    const stalled = new Promise((_res, reject) => {
      rearm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => reject(new Error('the model stopped responding (timed out). Please try again.')), STREAM_INACTIVITY_MS);
      };
      rearm(); // start the clock before the first token arrives
    });

    const fullText = await Promise.race([
      llm.stream({
        system: def.system,
        turns: [{ role: 'user', text: built }],
        imageDataUrl,
        onToken: (t) => { if (streamSettled) return; rearm(); send('llm:token', { text: t }); }
      }),
      stalled
    ]);
    streamSettled = true; clearTimeout(watchdog);
    if (DEBUG) console.log('[DEBUG MAIN] Full LLM Output:\n', fullText);
    send('llm:done', {});
  } catch (e) {
    send('llm:error', { message: 'Error: ' + (e && e.message ? e.message : String(e)) });
  } finally {
    streamSettled = true;
    state.busy = false;
  }
}

// -------- IPC --------
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => { sttDisabled = false; return store.setSettings(patch); });
ipcMain.handle('capture:toggle', () => setCapturing(!state.capturing));
ipcMain.handle('capture:state', () => ({ active: state.capturing }));
ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text));
ipcMain.on('mic:pcm', (_e, arrayBuffer) => {
  if (!state.capturing) return;
  const buf = Buffer.from(arrayBuffer);
  if (streamingSTT && streamingSTT.available) streamingSTT.send('you', buf);
  else buffers.you.push(buf);
});
ipcMain.on('system:pcm', (_e, arrayBuffer) => {
  if (!state.capturing) return;
  const buf = Buffer.from(arrayBuffer);
  if (streamingSTT && streamingSTT.available) streamingSTT.send('them', buf);
  else buffers.them.push(buf);
});
ipcMain.on('mouse:ignore', (_e, v) => { if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); });
ipcMain.on('open-pane', (_e, url) => { shell.openExternal(url).catch(() => {}); });
ipcMain.on('app:quit', () => app.quit());
ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg));

// -------- resume / job-description upload --------
async function pickAndParseDocument() {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Resume / Job description', extensions: ['pdf', 'docx'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const text = await parseDocumentFile(filePath);
  return { fileName: path.basename(filePath), text };
}

ipcMain.handle('profile:pickResume', async () => {
  try {
    const picked = await pickAndParseDocument();
    if (!picked) return { canceled: true };
    store.setSettings({ profile: { resumeText: picked.text, resumeFileName: picked.fileName } });
    return { canceled: false, fileName: picked.fileName };
  } catch (e) {
    return { canceled: false, error: (e && e.message) || String(e) };
  }
});
ipcMain.handle('profile:pickJobDescription', async () => {
  try {
    const picked = await pickAndParseDocument();
    if (!picked) return { canceled: true };
    store.setSettings({ profile: { jdText: picked.text, jdFileName: picked.fileName } });
    return { canceled: false, fileName: picked.fileName };
  } catch (e) {
    return { canceled: false, error: (e && e.message) || String(e) };
  }
});

// -------- persisted conversation history (separate from the in-memory `transcript` --------
// used for live LLM context — this one survives restarts and only feeds the History panel).
ipcMain.handle('transcript:getAll', () => transcriptStore.getAll());
ipcMain.handle('transcript:clear', () => { transcriptStore.clear(); return true; });

// -------- shortcuts --------
function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Return', () => runFeature('assist', ''));
  globalShortcut.register('CommandOrControl+H', () => runFeature('leetcode', ''));
  globalShortcut.register('CommandOrControl+/', () => send('hide:toggle', {}));
  globalShortcut.register('CommandOrControl+Shift+X', () => app.quit());
}

// -------- lifecycle --------
app.whenReady().then(() => {
  if (app.dock) app.dock.hide();

  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  // System-audio loopback for getDisplayMedia: hand back a screen source with 'loopback'
  // audio so the renderer can capture what's playing (Zoom/Meet) using cue's own grant.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (sources.length) callback({ video: sources[0], audio: 'loopback' });
      else callback();
    }).catch(() => callback());
  }, { useSystemPicker: false });

  createWindow();
  registerShortcuts();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); if (streamingSTT) streamingSTT.close(); });
app.on('window-all-closed', () => app.quit());
