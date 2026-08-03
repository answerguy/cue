const path = require('path');
const { Arch } = require('builder-util');
const { prepareWhisperRuntime } = require('./prepare-whisper-runtime');

/** Add the matching native runtime after Electron has assembled each target. */
module.exports = async function afterPack(context) {
  const platform = context.packager.platform.nodeName;
  const architecture = typeof context.arch === 'number' ? Arch[context.arch] : context.arch;
  if (!platform || !architecture) throw new Error('electron-builder did not provide a runtime target.');

  const outputDirectory = path.join(context.appOutDir, 'resources', 'whisper-runtime');
  await prepareWhisperRuntime({ platform, architecture, outputDirectory });
};
