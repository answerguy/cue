// preboot.js — executes in <head> before DOM parsing to prevent UI flash
try {
  if (window.cue && window.cue.initialQuietMode) {
    document.documentElement.classList.add('quiet-mode');
  }
} catch (_) {}
