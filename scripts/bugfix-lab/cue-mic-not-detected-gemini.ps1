param(
  [Parameter(Mandatory = $true)][string]$TargetDir
)

# Runs mic-double-start-harness.mjs (extracts + executes the REAL
# startMic()/stopMic() + cue.on('capture:state', ...) code, verbatim, out of
# $TargetDir/renderer/renderer.js) on a real Windows runner, to rule out any
# macOS-only timing quirk in the local repro. Node's await/microtask ordering
# is defined by the ECMAScript spec, not the OS, but this cluster's repro_env
# is windows-ci and the report is from Windows, so confirm here too.

node --version
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$harness = Join-Path $scriptDir "mic-double-start-harness.mjs"

node $harness $TargetDir
$exitCode = $LASTEXITCODE
Write-Host "harness exit code: $exitCode"

if ($exitCode -eq 1) {
  Write-Host "BUGFIX_LAB_PRESENT"
} elseif ($exitCode -eq 0) {
  Write-Host "BUGFIX_LAB_ABSENT"
} else {
  Write-Host "BUGFIX_LAB_ORACLE_COULD_NOT_RUN"
}
exit $exitCode
