# Oracle for cue-windows-overlay-not-visible-for-mic-grant.
# Launches the packaged (unpacked) Windows build on a REAL, non-headless
# desktop session (a GitHub-hosted windows-latest runner has one — unlike
# Linux, no Xvfb needed) and asks Win32 directly whether cue's process owns
# any visible, non-degenerate top-level window. cue deliberately retitles its
# window to "Microsoft Edge Update" (main.js: win.setTitle(...)) so a reporter
# — and this oracle — cannot rely on window title or taskbar/Alt+Tab (the
# window is WS_EX_TOOLWINDOW + skipTaskbar): only PID-owned HWNDs count.
#
# IsWindowVisible() alone is NOT enough: a first run of this oracle (CI run
# 35653908412, https://github.com/Blueturboguy07/cue/actions/runs/35653908412)
# found a window that was IsWindowVisible=true, at the exact expected
# 700x600 centered rect — yet the saved desktop screenshot showed the
# always-on-top ('screen-saver' level) window occluding NOTHING: the terminal
# behind it was perfectly crisp and un-tinted at that exact rect. That is the
# reported bug in pixel form — a window that satisfies the Win32 "visible"
# style bit but paints no human-visible content. So this oracle additionally
# captures the window's own rendered surface directly (PrintWindow with
# PW_RENDERFULLCONTENT, which — unlike a desktop screenshot — asks the window
# to render itself and works for GPU/DirectComposition-backed surfaces like
# Chromium's) and requires real color variance in that capture, not just an
# HWND with the visible bit set.
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
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
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
        $hits = @([Win32Probe]::EnumerateForPids($pidSet))
        $visibleReal = @($hits | Where-Object { $_.Visible -and $_.Width -gt 0 -and $_.Height -gt 0 })
        if ($visibleReal.Count -gt 0) { break }
    }
    Start-Sleep -Milliseconds 1000
}

Write-Output "cue.exe process count: $((Get-Process -Name 'cue' -ErrorAction SilentlyContinue | Measure-Object).Count); PIDs: $($allPids -join ',')"
Write-Output "Total HWNDs owned by cue PIDs: $($hits.Count)"
foreach ($h in $hits) {
    Write-Output ("  HWND=0x{0:X} pid={1} visible={2} title='{3}' rect=({4},{5},{6}x{7})" -f $h.Handle.ToInt64(), $h.Pid, $h.Visible, $h.Title, $h.X, $h.Y, $h.Width, $h.Height)
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Evidence screenshot of the real desktop, regardless of outcome.
try {
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

$visibleReal = @($hits | Where-Object { $_.Visible -and $_.Width -gt 0 -and $_.Height -gt 0 })

# --- Content check: does the window that Win32 calls "visible" actually
# render any human-visible pixels? PrintWindow(hWnd, hdc, PW_RENDERFULLCONTENT)
# asks the window to draw its OWN surface into our bitmap directly (works for
# DirectComposition/GPU content, unlike a plain BitBlt-based capture) — this
# is independent of what a desktop screenshot happens to show underneath.
$contentRendered = $false
$bestHit = $null
$maxSpread = -1
if ($visibleReal.Count -gt 0) {
    $bestHit = $visibleReal | Sort-Object -Property @{Expression = { $_.Width * $_.Height } } -Descending | Select-Object -First 1
    $PW_RENDERFULLCONTENT = 2
    $captureDeadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $captureDeadline -and -not $contentRendered) {
        try {
            $w = [Math]::Max($bestHit.Width, 1)
            $h = [Math]::Max($bestHit.Height, 1)
            $capBmp = New-Object System.Drawing.Bitmap $w, $h
            $capG = [System.Drawing.Graphics]::FromImage($capBmp)
            $hdc = $capG.GetHdc()
            $ok = [Win32Probe]::PrintWindow($bestHit.Handle, $hdc, $PW_RENDERFULLCONTENT)
            $capG.ReleaseHdc($hdc)
            $capG.Dispose()
            if ($ok) {
                $minR = 255; $maxR = 0; $minG = 255; $maxG = 0; $minB = 255; $maxB = 0
                $stepX = [Math]::Max([int]([Math]::Floor($w / 60)), 1)
                $stepY = [Math]::Max([int]([Math]::Floor($h / 60)), 1)
                for ($px = 0; $px -lt $w; $px += $stepX) {
                    for ($py = 0; $py -lt $h; $py += $stepY) {
                        $c = $capBmp.GetPixel($px, $py)
                        if ($c.R -lt $minR) { $minR = $c.R }; if ($c.R -gt $maxR) { $maxR = $c.R }
                        if ($c.G -lt $minG) { $minG = $c.G }; if ($c.G -gt $maxG) { $maxG = $c.G }
                        if ($c.B -lt $minB) { $minB = $c.B }; if ($c.B -gt $maxB) { $maxB = $c.B }
                    }
                }
                $spread = ($maxR - $minR) + ($maxG - $minG) + ($maxB - $minB)
                if ($spread -gt $maxSpread) { $maxSpread = $spread }
                Write-Output "PrintWindow capture: ${w}x${h}, sampled color spread (R+G+B max-min) = $spread"
                # A real UI (toolbar pill, icons, text) spans many colors; a
                # blank/transparent/uncomposited surface is ~flat. 24 is a
                # generous floor — real cue UI in a working capture measured
                # in the hundreds.
                if ($spread -gt 24) {
                    $contentRendered = $true
                    try {
                        $capOutPath = "$env:GITHUB_WORKSPACE\cue-window-capture.png"
                        if (-not $env:GITHUB_WORKSPACE) { $capOutPath = ".\cue-window-capture.png" }
                        $capBmp.Save($capOutPath)
                        Write-Output "Saved rendered window capture to $capOutPath"
                    } catch { Write-Output "Could not save window capture (non-fatal): $_" }
                }
            } else {
                Write-Output "PrintWindow returned false (capture failed) on this attempt"
            }
            $capBmp.Dispose()
        } catch {
            Write-Output "PrintWindow capture attempt threw (non-fatal, retrying): $_"
        }
        if (-not $contentRendered) { Start-Sleep -Milliseconds 1000 }
    }
}

if (-not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
Get-Process -Name "cue" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

if ($visibleReal.Count -eq 0) {
    Write-Result 1 "cue.exe is running (PIDs: $($allPids -join ',')) but EnumWindows found zero visible, non-degenerate top-level windows for it after 30s — this is the reported symptom (no UI surface to grant mic access)."
} elseif (-not $contentRendered) {
    $descs = $visibleReal | ForEach-Object { "$($_.Width)x$($_.Height)@($($_.X),$($_.Y))" }
    $joined = $descs -join '; '
    Write-Result 1 "cue.exe has a Win32-visible top-level window ($joined) but PrintWindow(PW_RENDERFULLCONTENT) captured no meaningful content after 15s of retries (best sampled color spread = $maxSpread, threshold 24) — the window exists but renders nothing a human could see or click, matching the reported symptom."
} else {
    $descs = $visibleReal | ForEach-Object { "$($_.Width)x$($_.Height)@($($_.X),$($_.Y))" }
    $joined = $descs -join '; '
    Write-Result 0 "cue.exe has $($visibleReal.Count) visible top-level window(s) ($joined) and PrintWindow captured real rendered content (color spread = $maxSpread, threshold 24)."
}
