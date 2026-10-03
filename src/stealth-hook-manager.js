const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');

function createStealthHookManager(options = {}) {
  const {
    onChar = () => {},
    onBackspace = () => {},
    onDelete = () => {},
    onArrowLeft = () => {},
    onArrowRight = () => {},
    onArrowUp = () => {},
    onArrowDown = () => {},
    onPageUp = () => {},
    onPageDown = () => {},
    onHome = () => {},
    onEnd = () => {},
    onEnter = () => {},
    onEscape = () => {},
    onPaste = () => {},
    onSelectAll = () => {},
    onStateChange = () => {},
    onNoFocusToggle = () => {},
    onTransparencyToggle = () => {},
    onTransparencyState = () => {},
    onShortcut = () => {},
    onSttAnswer = () => {},
    onSttInsert = () => {},
    onHistoryToggle = () => {},
    onHideToggle = () => {},
    onTranscriptionToggle = () => {},
    log = console.log
  } = options;

  let child = null;
  let capturing = false;
  let ready = false;
  let lineBuffer = '';

  const exePath = path.join(__dirname, 'native', 'stealth-input.exe');

  function isAvailable() {
    return process.platform === 'win32' && fs.existsSync(exePath);
  }

  function spawnHelper() {
    if (!isAvailable()) return;
    if (child && !child.killed) return;

    try {
      child = cp.spawn(exePath, [], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore']
      });

      if (child.stdin) {
        child.stdin.on('error', () => {});
      }

      child.stdout.on('data', (data) => {
        lineBuffer += data.toString('utf8');
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';

        for (const raw of lines) {
          const trimmed = raw.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed);
            handleMessage(msg);
          } catch (_) {
            // Non-JSON or log message
          }
        }
      });

      child.on('error', (err) => {
        log('[stealth-hook] child error: ' + err.message);
        ready = false;
        capturing = false;
        onStateChange(false);
      });

      child.on('exit', (code) => {
        log(`[stealth-hook] child exited with code ${code}`);
        child = null;
        ready = false;
        if (capturing) {
          capturing = false;
          onStateChange(false);
        }
      });
    } catch (e) {
      log('[stealth-hook] failed to spawn helper: ' + e.message);
    }
  }

  function handleMessage(msg) {
    if (!msg || !msg.event) return;
    switch (msg.event) {
      case 'ready':
        ready = true;
        break;
      case 'state':
        capturing = Boolean(msg.capturing);
        onStateChange(capturing);
        break;
      case 'toggle':
        lastToggleTime = Date.now();
        capturing = Boolean(msg.capturing);
        onStateChange(capturing);
        break;
      case 'nofocus_toggle':
        onNoFocusToggle();
        break;
      case 'transparency_toggle':
        onTransparencyToggle(msg.enabled);
        break;
      case 'transparency_state':
        onTransparencyState(msg.enabled);
        break;
      case 'toggle_off':
        lastToggleTime = Date.now();
        capturing = false;
        onStateChange(false);
        break;
      case 'char':
        if (typeof msg.char === 'string') {
          onChar(msg.char);
        }
        break;
      case 'backspace':
        onBackspace();
        break;
      case 'enter':
        lastToggleTime = Date.now();
        capturing = false;
        onStateChange(false);
        onEnter();
        break;
      case 'escape':
        lastToggleTime = Date.now();
        capturing = false;
        onStateChange(false);
        onEscape();
        break;
      case 'paste':
        onPaste();
        break;
      case 'select_all':
        onSelectAll();
        break;
      case 'delete':
        onDelete();
        break;
      case 'arrow_left':
        onArrowLeft();
        break;
      case 'arrow_right':
        onArrowRight();
        break;
      case 'arrow_up':
        onArrowUp();
        break;
      case 'arrow_down':
        onArrowDown();
        break;
      case 'page_up':
        onPageUp();
        break;
      case 'page_down':
        onPageDown();
        break;
      case 'home':
        onHome();
        break;
      case 'end':
        onEnd();
        break;
      case 'shortcut':
        if (typeof msg.action === 'string') {
          onShortcut(msg.action);
        }
        break;
      case 'stt_answer':
        onSttAnswer();
        break;
      case 'stt_insert':
        onSttInsert();
        break;
      case 'history_toggle':
        onHistoryToggle();
        break;
      case 'hide_toggle':
        onHideToggle();
        break;
      case 'transcription_toggle':
        onTranscriptionToggle();
        break;
    }
  }

  let lastToggleTime = 0;

  function sendCommand(cmd) {
    if (!child || child.killed) {
      spawnHelper();
    }
    if (child && child.stdin && child.stdin.writable) {
      try {
        child.stdin.write(cmd + '\n');
      } catch (_) {}
    }
  }

  function start() {
    if (!isAvailable()) return false;
    if (capturing) return true;
    lastToggleTime = Date.now();
    sendCommand('START');
    capturing = true;
    onStateChange(true);
    return true;
  }

  function stop() {
    if (!isAvailable()) return false;
    if (!capturing) return true;
    lastToggleTime = Date.now();
    sendCommand('STOP');
    capturing = false;
    onStateChange(false);
    return true;
  }

  function toggle() {
    const now = Date.now();
    if (now - lastToggleTime < 300) {
      return capturing;
    }
    lastToggleTime = now;
    if (capturing) {
      stop();
    } else {
      start();
    }
    return capturing;
  }

  function isCapturing() {
    return capturing;
  }

  function dispose() {
    if (child) {
      try {
        child.stdin.write('QUIT\n');
        child.stdin.end();
      } catch (_) {}
      try {
        if (!child.killed) {
          child.kill();
        }
      } catch (_) {}
      child = null;
      ready = false;
      capturing = false;
    }
  }

  process.once('exit', dispose);
  process.once('SIGINT', dispose);
  process.once('SIGTERM', dispose);

  // Pre-spawn helper if available
  if (isAvailable()) {
    spawnHelper();
  }

  function setTransparency(enabled) {
    if (!isAvailable()) return false;
    sendCommand(`SET_TRANSPARENCY ${enabled ? 'true' : 'false'}`);
    return true;
  }

  return {
    isAvailable,
    start,
    stop,
    toggle,
    setTransparency,
    isCapturing,
    dispose
  };
}

module.exports = { createStealthHookManager };
