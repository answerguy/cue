#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  SHERPA_ONNX_VERSION,
  getRuntimeTarget,
  getRuntimeExecutablePath
} = require('../src/sherpa-runtime-manifest');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CACHE_ROOT = path.join(PROJECT_ROOT, '.cache', 'sherpa-runtime');
const RUNTIME_MANIFEST_FILENAME = 'runtime.json';

function readArgument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function assertSafeManagedDirectory(targetPath, parentPath) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedParent = path.resolve(parentPath);
  const relativePath = path.relative(resolvedParent, resolvedTarget);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing to replace unmanaged directory: ${resolvedTarget}`);
  }
}

async function findFile(rootDirectory, filename) {
  const pendingDirectories = [rootDirectory];
  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop();
    const entries = await fs.promises.readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) pendingDirectories.push(entryPath);
      if (entry.isFile() && entry.name === filename) return entryPath;
    }
  }
  throw new Error(`Could not find ${filename} in the prepared sherpa-onnx files.`);
}

function shouldCopyRuntimeEntry(filename, executableName) {
  return (
    filename === executableName ||
    filename === 'LICENSE' ||
    filename.endsWith('.dll') ||
    filename.endsWith('.dylib') ||
    filename.includes('.so')
  );
}

async function copyRuntimeDependencies(sourceDirectory, executableName, destinationDirectory) {
  await fs.promises.mkdir(destinationDirectory, { recursive: true });
  const entries = await fs.promises.readdir(sourceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!shouldCopyRuntimeEntry(entry.name, executableName)) continue;
    const sourcePath = path.join(sourceDirectory, entry.name);
    const destinationPath = path.join(destinationDirectory, entry.name);
    await fs.promises.cp(sourcePath, destinationPath, { recursive: false, dereference: false });
  }
  if (process.platform !== 'win32') {
    await fs.promises.chmod(path.join(destinationDirectory, executableName), 0o755);
  }
}

async function downloadArtifact(url, destinationPath) {
  const localCandidates = [
    path.join(PROJECT_ROOT, path.basename(destinationPath)),
    path.join(PROJECT_ROOT, 'test-sherpa-shared.tar.bz2')
  ];

  for (const candidate of localCandidates) {
    if (fs.existsSync(candidate)) {
      try {
        const stats = await fs.promises.stat(candidate);
        if (stats.size > 1000000) {
          await fs.promises.copyFile(candidate, destinationPath);
          return;
        }
      } catch (_) {}
    }
  }

  // Try curl first for reliability on Windows/Linux
  let downloaded = false;
  try {
    const curlExe = process.platform === 'win32' ? 'curl.exe' : 'curl';
    execFileSync(curlExe, ['-L', '-s', '-o', destinationPath, url], {
      stdio: 'inherit',
      timeout: 300000
    });
    downloaded = true;
  } catch (_) {}

  if (!downloaded) {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
    if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}: ${url}`);

    const output = fs.createWriteStream(destinationPath, { flags: 'wx' });
    try {
      for await (const chunk of response.body) {
        if (!output.write(Buffer.from(chunk))) {
          await new Promise((resolve) => output.once('drain', resolve));
        }
      }
    } finally {
      await new Promise((resolve, reject) => output.end((error) => (error ? reject(error) : resolve())));
    }
  }
}

async function extractTarArchive(archivePath, destinationDirectory) {
  const tarExe = process.platform === 'win32' ? 'tar.exe' : 'tar';
  execFileSync(tarExe, ['-xf', archivePath, '-C', destinationDirectory], {
    stdio: 'inherit',
    windowsHide: true
  });
}

async function prepareArchiveTarget(target, temporaryDirectory, destinationDirectory) {
  const archivePath = path.join(temporaryDirectory, target.filename);
  const extractionDirectory = path.join(temporaryDirectory, 'extracted');
  await fs.promises.mkdir(extractionDirectory, { recursive: true });
  await downloadArtifact(target.url, archivePath);
  await extractTarArchive(archivePath, extractionDirectory);

  const executablePath = await findFile(extractionDirectory, target.executable);
  await copyRuntimeDependencies(path.dirname(executablePath), target.executable, destinationDirectory);
}

async function replaceManagedDirectory(sourceDirectory, destinationDirectory, parentDirectory) {
  assertSafeManagedDirectory(destinationDirectory, parentDirectory);
  await fs.promises.mkdir(parentDirectory, { recursive: true });
  await fs.promises.rm(destinationDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await fs.promises.cp(sourceDirectory, destinationDirectory, { recursive: true, dereference: false });
}

async function hasCurrentRuntime(runtimeDirectory, target) {
  const executablePath = getRuntimeExecutablePath(runtimeDirectory, target.key.split('-')[0], target.key.split('-').slice(1).join('-'));
  try {
    const metadata = JSON.parse(await fs.promises.readFile(path.join(runtimeDirectory, RUNTIME_MANIFEST_FILENAME), 'utf8'));
    await fs.promises.access(executablePath, fs.constants.X_OK);
    return metadata.version === SHERPA_ONNX_VERSION && metadata.target === target.key;
  } catch {
    return false;
  }
}

async function prepareSherpaRuntime({
  platform = process.platform,
  architecture = process.arch,
  cacheRoot = DEFAULT_CACHE_ROOT,
  outputDirectory = null,
  useCuda = false
} = {}) {
  const target = getRuntimeTarget(platform, architecture, useCuda);
  const cachedRuntimeDirectory = path.join(cacheRoot, target.key);

  const hasRuntime = await hasCurrentRuntime(cachedRuntimeDirectory, target);
  if (!hasRuntime) {
    const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cue-sherpa-runtime-'));
    const preparedDirectory = path.join(temporaryDirectory, 'prepared');
    try {
      await prepareArchiveTarget(target, temporaryDirectory, preparedDirectory);
      await fs.promises.writeFile(
        path.join(preparedDirectory, RUNTIME_MANIFEST_FILENAME),
        JSON.stringify(
          {
            name: 'sherpa-onnx',
            version: SHERPA_ONNX_VERSION,
            target: target.key,
            cuda: useCuda
          },
          null,
          2
        )
      );
      await replaceManagedDirectory(preparedDirectory, cachedRuntimeDirectory, cacheRoot);
    } finally {
      const resolved = path.resolve(temporaryDirectory);
      if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
        await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  }

  if (outputDirectory) {
    const outputParent = path.dirname(path.resolve(outputDirectory));
    await replaceManagedDirectory(cachedRuntimeDirectory, outputDirectory, outputParent);
  }
  return outputDirectory || cachedRuntimeDirectory;
}

async function main() {
  const outputDirectory = readArgument('output');
  const useCuda = process.argv.includes('--cuda') || process.env.CUE_SHERPA_CUDA === '1';
  const runtimeDirectory = await prepareSherpaRuntime({
    platform: readArgument('platform') || process.platform,
    architecture: readArgument('arch') || process.arch,
    outputDirectory: outputDirectory ? path.resolve(outputDirectory) : null,
    useCuda
  });
  process.stdout.write(`Prepared sherpa-onnx ${SHERPA_ONNX_VERSION} runtime (${useCuda ? 'CUDA' : 'CPU'}) at ${runtimeDirectory}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  prepareSherpaRuntime,
  assertSafeManagedDirectory,
  shouldCopyRuntimeEntry
};
