const fs = require('fs');
const path = require('path');
const { getRuntimeExecutablePath, getRuntimeTarget, SHERPA_ONNX_VERSION } = require('./sherpa-runtime-manifest');

/** Locate only prepackaged or explicitly prepared runtimes; never fetch code dynamically. */
function locateSherpaRuntime({
  isPackaged,
  resourcesPath,
  appPath,
  platform = process.platform,
  architecture = process.arch,
  environment = process.env
} = {}) {
  let target;
  try {
    target = getRuntimeTarget(platform, architecture);
  } catch (err) {
    return {
      available: false,
      version: SHERPA_ONNX_VERSION,
      target: `${platform}-${architecture}`,
      runtimeDirectory: null,
      executablePath: null,
      message: err.message
    };
  }

  const candidates = [];

  // 1. Explicit override via environment variables (directory or direct executable path)
  if (environment.CUE_SHERPA_RUNTIME) {
    candidates.push(path.resolve(environment.CUE_SHERPA_RUNTIME));
  }
  if (environment.CUE_SHERPA_PATH) {
    candidates.push(path.resolve(environment.CUE_SHERPA_PATH));
  }

  // 2. Packaged resources directory
  if (isPackaged && resourcesPath) {
    candidates.push(path.join(resourcesPath, 'sherpa-runtime'));
  }

  // 3. Local build cache / prepared directory
  if (appPath) {
    candidates.push(path.join(appPath, '.cache', 'sherpa-runtime', target.key));
  } else {
    candidates.push(path.join(process.cwd(), '.cache', 'sherpa-runtime', target.key));
  }

  // 4. System PATH directories (e.g. sherpa-onnx installed on user's PC)
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
    candidates.push('C:\\sherpa-onnx');
    candidates.push('C:\\src\\sherpa-onnx');
    candidates.push('C:\\Program Files\\sherpa-onnx');
    if (environment.LOCALAPPDATA) candidates.push(path.join(environment.LOCALAPPDATA, 'sherpa-onnx'));
    if (environment.USERPROFILE) candidates.push(path.join(environment.USERPROFILE, 'sherpa-onnx'));
  } else {
    candidates.push('/usr/local/bin');
    candidates.push('/opt/homebrew/bin');
    candidates.push('/usr/bin');
    candidates.push('/usr/local/share/sherpa-onnx');
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
            const noExt = path.join(resolved, 'sherpa-onnx-offline-websocket-server');
            if (fs.existsSync(noExt)) executablePath = noExt;
            const offlineCli = path.join(resolved, 'sherpa-onnx-offline.exe');
            if (fs.existsSync(offlineCli)) executablePath = offlineCli;
          }
        }
      }
    } catch {
      continue;
    }

    if (executablePath && fs.existsSync(executablePath)) {
      return {
        available: true,
        version: SHERPA_ONNX_VERSION,
        target: target.key,
        runtimeDirectory,
        executablePath
      };
    }
  }

  return {
    available: false,
    version: SHERPA_ONNX_VERSION,
    target: target.key,
    runtimeDirectory: candidates[0] || null,
    executablePath: null,
    message: isPackaged
      ? `The packaged Sherpa-ONNX runtime for ${target.key} is missing.`
      : `Sherpa-ONNX runtime binary (${target.executable}) not found in PATH or .cache/sherpa-runtime.`
  };
}

module.exports = { locateSherpaRuntime };
