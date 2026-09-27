const fs = require('fs');
const path = require('path');
const { getRuntimeExecutablePath, getRuntimeTarget, WHISPER_CPP_VERSION } = require('./whisper-runtime-manifest');

/** Locate only prepackaged or explicitly prepared runtimes; never fetch code. */
function locateWhisperRuntime({
  isPackaged,
  resourcesPath,
  appPath,
  platform = process.platform,
  architecture = process.arch,
  environment = process.env
}) {
  const target = getRuntimeTarget(platform, architecture);
  const candidates = [];

  // 1. Explicit override via environment variables (directory or direct executable path)
  if (environment.CUE_WHISPER_RUNTIME) {
    candidates.push(path.resolve(environment.CUE_WHISPER_RUNTIME));
  }
  if (environment.CUE_WHISPER_PATH) {
    candidates.push(path.resolve(environment.CUE_WHISPER_PATH));
  }

  // 2. Packaged resources directory
  if (isPackaged && resourcesPath) {
    candidates.push(path.join(resourcesPath, 'whisper-runtime'));
  }

  // 3. Local build cache / prepared directory
  if (appPath) {
    candidates.push(path.join(appPath, '.cache', 'whisper-runtime', target.key));
  }
  candidates.push(path.join(process.cwd(), '.cache', 'whisper-runtime', target.key));

  // 4. System PATH directories (e.g. whisper.cpp installed on user's PC)
  const pathEnv = environment.PATH || environment.Path || '';
  if (pathEnv) {
    const pathDirs = pathEnv
      .split(path.delimiter)
      .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
      .filter(Boolean);
    for (const dir of pathDirs) {
      candidates.push(dir);
    }
  }

  // 5. Common system installation locations
  if (platform === 'win32') {
    candidates.push('C:\\src\\whisper-cublas');
    candidates.push('C:\\src\\whisper.cpp');
    candidates.push('C:\\whisper.cpp');
    candidates.push('C:\\Program Files\\whisper.cpp');
    if (environment.LOCALAPPDATA) candidates.push(path.join(environment.LOCALAPPDATA, 'whisper.cpp'));
    if (environment.USERPROFILE) candidates.push(path.join(environment.USERPROFILE, 'whisper.cpp'));
  } else {
    candidates.push('/usr/local/bin');
    candidates.push('/opt/homebrew/bin');
    candidates.push('/usr/bin');
    candidates.push('/usr/local/share/whisper.cpp');
    if (environment.HOME) candidates.push(path.join(environment.HOME, '.local', 'bin'));
  }

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') continue;
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    let runtimeDirectory = resolved;
    let executablePath = null;

    try {
      if (fs.existsSync(resolved)) {
        const stats = fs.statSync(resolved);
        if (stats.isFile()) {
          executablePath = resolved;
          runtimeDirectory = path.dirname(resolved);
        } else if (stats.isDirectory()) {
          const potentialExe = getRuntimeExecutablePath(resolved, platform, architecture);
          if (fs.existsSync(potentialExe)) {
            executablePath = potentialExe;
          } else if (platform === 'win32') {
            const noExt = path.join(resolved, 'whisper-server');
            if (fs.existsSync(noExt)) executablePath = noExt;
          }
        }
      }
    } catch {
      continue;
    }

    if (executablePath && fs.existsSync(executablePath)) {
      return {
        available: true,
        version: WHISPER_CPP_VERSION,
        target: target.key,
        runtimeDirectory,
        executablePath
      };
    }
  }

  return {
    available: false,
    version: WHISPER_CPP_VERSION,
    target: target.key,
    runtimeDirectory: candidates[0] || null,
    executablePath: null,
    message: isPackaged
      ? `The packaged Whisper runtime for ${target.key} is missing.`
      : 'Run npm run prepare:whisper before using local transcription from source.'
  };
}

module.exports = { locateWhisperRuntime };
