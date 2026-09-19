# Oracle for cluster cue-windows-whisper-runtime-missing.
#
# Does exactly what the Windows install guide's "Install dependencies" and
# "Build the installer" steps do (rendered from ~/publik/lib/guides/cue.ts via
# render-guide.mts: `npm.cmd ci` then `npm.cmd run dist:win`), on a real
# windows-latest runner, then inspects the REAL packaged output the way cue's
# own main process does: it loads the shipped `src/whisper-runtime.js` out of
# the packaged app directory and calls the exact function
# (`locateWhisperRuntime`) that `main.js`'s `getWhisperRuntime()` calls, with
# the same isPackaged/resourcesPath/appPath shape a running packaged app would
# have. This is not a source grep for a patch -- it runs the real build and
# then runs the real runtime-location code against the real build output.
#
# Exit 1 = bug PRESENT (packaged win32-x64 whisper runtime missing).
# Exit 0 = bug ABSENT (runtime present and locateWhisperRuntime finds it).
# Exit 2 = oracle could not run (build itself failed, or output layout
#          wasn't what we expected -- not evidence either way).
#
# Optional: set $env:CUE_BUNDLE_WHISPER = "1" before calling this script to
# run the opt-in bundling path instead (used as a sensitivity / negative
# control run, never as the default reproduction).

$ErrorActionPreference = "Stop"
$repoRoot = (Get-Location).Path

Write-Host "=== environment ==="
Write-Host "CUE_BUNDLE_WHISPER = '$($env:CUE_BUNDLE_WHISPER)'"
node --version
npm --version

Write-Host "`n=== step: npm.cmd ci (rendered guide step 'Install dependencies') ==="
npm.cmd ci
if ($LASTEXITCODE -ne 0) {
  Write-Host "npm ci failed -- oracle could not run."
  exit 2
}

Write-Host "`n=== step: npm.cmd run dist:win (rendered guide step 'Build the installer') ==="
npm.cmd run dist:win
if ($LASTEXITCODE -ne 0) {
  Write-Host "dist:win build failed -- oracle could not run."
  exit 2
}

Write-Host "`n=== locate the packaged resources/app directory under dist/ ==="
$distDir = Join-Path $repoRoot "dist"
if (-not (Test-Path $distDir)) {
  Write-Host "No dist/ directory was produced -- oracle could not run."
  exit 2
}

$resourcesDir = Get-ChildItem -Path $distDir -Recurse -Directory -Filter "resources" -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName "app") -PathType Container } |
  Select-Object -First 1

if (-not $resourcesDir) {
  Write-Host "Could not find a packaged resources/app directory under dist/ -- build layout was not what we expected."
  Write-Host "-- full dist/ listing --"
  Get-ChildItem -Path $distDir -Recurse | ForEach-Object { Write-Host $_.FullName }
  exit 2
}

$appDir = Join-Path $resourcesDir.FullName "app"
$runtimeExe = Join-Path (Join-Path $resourcesDir.FullName "whisper-runtime") "whisper-server.exe"

Write-Host "resources dir : $($resourcesDir.FullName)"
Write-Host "app dir       : $appDir"
Write-Host "runtime exe   : $runtimeExe"
Write-Host "runtime exe present on disk: $(Test-Path $runtimeExe)"
Write-Host "-- resources/ listing (top 2 levels) --"
Get-ChildItem -Path $resourcesDir.FullName -Depth 1 | ForEach-Object { Write-Host $_.FullName }

Write-Host "`n=== running the SHIPPED src/whisper-runtime.js locateWhisperRuntime(), exactly as main.js's getWhisperRuntime() calls it for a packaged app ==="
$nodeScript = @'
const path = require("path");
const appDir = process.argv[2];
const resourcesDir = process.argv[3];
const { locateWhisperRuntime } = require(path.join(appDir, "src", "whisper-runtime.js"));
const result = locateWhisperRuntime({
  isPackaged: true,
  resourcesPath: resourcesDir,
  appPath: appDir,
  platform: "win32",
  architecture: "x64",
  environment: process.env
});
console.log(JSON.stringify(result, null, 2));
if (!result.available) {
  console.log("BUGFIX_LAB_PRESENT");
  process.exitCode = 1;
} else {
  console.log("BUGFIX_LAB_ABSENT");
  process.exitCode = 0;
}
'@

$nodeScriptPath = Join-Path $env:RUNNER_TEMP "whisper-oracle-check.js"
Set-Content -Path $nodeScriptPath -Value $nodeScript -Encoding UTF8
node $nodeScriptPath $appDir $resourcesDir.FullName
$nodeExit = $LASTEXITCODE
Write-Host "`nnode check exit code: $nodeExit"
exit $nodeExit
