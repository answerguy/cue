const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform === 'win32') {
  const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  const src = path.join(__dirname, '..', 'src', 'native', 'stealth-input.cs');
  const out = path.join(__dirname, '..', 'src', 'native', 'stealth-input.exe');
  if (fs.existsSync(csc) && fs.existsSync(src)) {
    try {
      cp.execFileSync(csc, ['/target:exe', '/optimize+', `/out:${out}`, src]);
      console.log('[build] compiled stealth-input.exe');
    } catch (e) {
      console.warn('[build] could not compile stealth-input.exe:', e.message);
    }
  }
}
