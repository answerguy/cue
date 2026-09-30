const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');

function createStealthHookManager(options = {}) {
  const {
    onChar = () => {},
    onBackspace = () => {},
    onEnter = () => {},
    onEscape = () => {},
    onPaste = () => {},
    onSelectAll = () => {},
    onStateChange = () => {},
    onNoFocusToggle = () => {},
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
    lastToggleTime = Date.now();
    sendCommand('START');
    capturing = true;
    onStateChange(true);
    return true;
  }

  function stop() {
    if (!isAvailable()) return false;
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
      } catch (_) {}
      setTimeout(() => {
        if (child && !child.killed) {
          try { child.kill(); } catch (_) {}
        }
        child = null;
      }, 200);
    }
  }

  // Pre-spawn helper if available
  if (isAvailable()) {
    spawnHelper();
  }

  return {
    isAvailable,
    start,
    stop,
    toggle,
    isCapturing,
    dispose
  };
}

module.exports = { createStealthHookManager };
