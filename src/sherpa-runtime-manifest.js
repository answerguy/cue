const path = require('path');

const SHERPA_ONNX_VERSION = '1.13.8';
const RELEASE_BASE_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_ONNX_VERSION}`;

const RUNTIME_TARGETS = Object.freeze({
  'win32-x64': Object.freeze({
    kind: 'archive',
    archiveType: 'tar.bz2',
    filename: `sherpa-onnx-v${SHERPA_ONNX_VERSION}-win-x64-shared-MT-Release.tar.bz2`,
    executable: 'sherpa-onnx-offline-websocket-server.exe'
  }),
  'linux-x64': Object.freeze({
    kind: 'archive',
    archiveType: 'tar.bz2',
    filename: `sherpa-onnx-v${SHERPA_ONNX_VERSION}-linux-x64-shared.tar.bz2`,
    executable: 'sherpa-onnx-offline-websocket-server'
  }),
  'linux-arm64': Object.freeze({
    kind: 'archive',
    archiveType: 'tar.bz2',
    filename: `sherpa-onnx-v${SHERPA_ONNX_VERSION}-linux-aarch64-shared-cpu.tar.bz2`,
    executable: 'sherpa-onnx-offline-websocket-server'
  }),
  'darwin-x64': Object.freeze({
    kind: 'archive',
    archiveType: 'tar.bz2',
    filename: `sherpa-onnx-v${SHERPA_ONNX_VERSION}-osx-x64-shared.tar.bz2`,
    executable: 'sherpa-onnx-offline-websocket-server'
  }),
  'darwin-arm64': Object.freeze({
    kind: 'archive',
    archiveType: 'tar.bz2',
    filename: `sherpa-onnx-v${SHERPA_ONNX_VERSION}-osx-arm64-shared.tar.bz2`,
    executable: 'sherpa-onnx-offline-websocket-server'
  })
});

function getRuntimeTarget(platform = process.platform, architecture = process.arch, useCuda = false) {
  const key = `${platform}-${architecture}`;
  const target = RUNTIME_TARGETS[key];
  if (!target) throw new Error(`Sherpa-ONNX is not packaged for ${key}.`);
  let filename = target.filename;
  if (useCuda && key === 'win32-x64') {
    filename = `sherpa-onnx-v${SHERPA_ONNX_VERSION}-cuda-12.x-cudnn-9.x-onnxruntime1.28.2-win-x64-cuda.tar.bz2`;
  }
  return {
    ...target,
    filename,
    key,
    url: `${RELEASE_BASE_URL}/${filename}`
  };
}

function getRuntimeExecutablePath(runtimeDirectory, platform = process.platform, architecture = process.arch) {
  const target = getRuntimeTarget(platform, architecture);
  return path.join(runtimeDirectory, target.executable);
}

module.exports = {
  SHERPA_ONNX_VERSION,
  RUNTIME_TARGETS,
  getRuntimeTarget,
  getRuntimeExecutablePath
};
