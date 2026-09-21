# Oracle for cue-windows-overlay-not-visible-for-mic-grant.
# Launches the packaged (unpacked) Windows build on a REAL, non-headless
# desktop session (a GitHub-hosted windows-latest runner has one — unlike
# Linux, no Xvfb needed) and asks Win32 directly whether cue's process owns
# any visible, non-degenerate top-level window. cue deliberately retitles its
# window to "Microsoft Edge Update" (main.js: win.setTitle(...)) so a reporter
# — and this oracle — cannot rely on window title or taskbar/Alt+Tab (the
# window is WS_EX_TOOLWINDOW + skipTaskbar): only PID-owned HWNDs count.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Result($code, $msg) {
    if ($code -eq 1) { Write-Output "BUGFIX_LAB_PRESENT: $msg" }
    else { Write-Output "BUGFIX_LAB_ABSENT: $msg" }
    exit $code
}

npm ci
if ($LASTEXITCODE -ne 0) { Write-Result 2 "npm ci failed with exit $LASTEXITCODE" }

npm run pack:win
if ($LASTEXITCODE -ne 0) { Write-Result 2 "npm run pack:win failed with exit $LASTEXITCODE" }

$exe = Get-ChildItem -Path "dist" -Recurse -Filter "cue.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $exe) {
    Write-Result 2 "no cue.exe found under dist/ after pack:win"
}
Write-Output "Found packaged exe: $($exe.FullName)"

# --- Win32 P/Invoke: enumerate ALL top-level windows, resolve each to its
# owning process id, and report visibility + bounding rect. ---
$sig = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class Win32Probe {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public class Hit {
        public IntPtr Handle; public uint Pid; public bool Visible; public string Title;
        public int Width; public int Height; public int X; public int Y;
    }

    public static List<Hit> EnumerateForPids(HashSet<uint> pids) {
        var results = new List<Hit>();
        EnumWindows((hWnd, lParam) => {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pids.Contains(pid)) {
                var sb = new StringBuilder(256);
                GetWindowText(hWnd, sb, sb.Capacity);
                RECT r;
                GetWindowRect(hWnd, out r);
                results.Add(new Hit {
                    Handle = hWnd, Pid = pid, Visible = IsWindowVisible(hWnd), Title = sb.ToString(),
                    Width = r.Right - r.Left, Height = r.Bottom - r.Top, X = r.Left, Y = r.Top
                });
            }
            return true;
        }, IntPtr.Zero);
        return results;
    }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp

Write-Output "Launching cue.exe: $($exe.FullName)"
$proc = Start-Process -FilePath $exe.FullName -PassThru
Start-Sleep -Seconds 3
if ($proc.HasExited) {
    Write-Result 1 "cue.exe process exited immediately (code $($proc.ExitCode)) — no window could ever appear"
}

# Give the renderer time to load (did-finish-load -> showInactive()). Electron
# on a fresh npm-ci'd unpacked build is slow on CI; poll instead of one sleep.
$deadline = (Get-Date).AddSeconds(30)
$hits = @()
$allPids = @()
while ((Get-Date) -lt $deadline) {
    $cueProcs = Get-Process -Name "cue" -ErrorAction SilentlyContinue
    if ($cueProcs) {
        $allPids = $cueProcs | Select-Object -ExpandProperty Id
        $pidSet = New-Object 'System.Collections.Generic.HashSet[uint32]'
        foreach ($p in $allPids) { [void]$pidSet.Add([uint32]$p) }
        $hits = [Win32Probe]::EnumerateForPids($pidSet)
        $visibleReal = $hits | Where-Object { $_.Visible -and $_.Width -gt 0 -and $_.Height -gt 0 }
        if ($visibleReal.Count -gt 0) { break }
    }
    Start-Sleep -Milliseconds 1000
}

Write-Output "cue.exe process count: $((Get-Process -Name 'cue' -ErrorAction SilentlyContinue | Measure-Object).Count); PIDs: $($allPids -join ',')"
Write-Output "Total HWNDs owned by cue PIDs: $($hits.Count)"
foreach ($h in $hits) {
    Write-Output ("  HWND=0x{0:X} pid={1} visible={2} title='{3}' rect=({4},{5},{6}x{7})" -f $h.Handle.ToInt64(), $h.Pid, $h.Visible, $h.Title, $h.X, $h.Y, $h.Width, $h.Height)
}

# Evidence screenshot of the real desktop, regardless of outcome.
try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $outPath = "$env:GITHUB_WORKSPACE\bugfix-lab-desktop.png"
    if (-not $env:GITHUB_WORKSPACE) { $outPath = ".\bugfix-lab-desktop.png" }
    $bmp.Save($outPath)
    Write-Output "Saved desktop screenshot to $outPath"
} catch {
    Write-Output "Screenshot capture failed (non-fatal): $_"
}

$visibleReal = $hits | Where-Object { $_.Visible -and $_.Width -gt 0 -and $_.Height -gt 0 }

if (-not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
Get-Process -Name "cue" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

if ($visibleReal.Count -eq 0) {
    Write-Result 1 "cue.exe is running (PIDs: $($allPids -join ',')) but EnumWindows found zero visible, non-degenerate top-level windows for it after 30s — this is the reported symptom (no UI surface to grant mic access)."
} else {
    $descs = $visibleReal | ForEach-Object { "$($_.Width)x$($_.Height)@($($_.X),$($_.Y))" }
    $joined = $descs -join '; '
    Write-Result 0 "cue.exe has $($visibleReal.Count) visible top-level window(s): $joined"
}
