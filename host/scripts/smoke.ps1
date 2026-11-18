# host\scripts\smoke.ps1: the first part of smoke.sh for Windows. It starts the built app on a
# temporary data folder, passive (it takes no keyboard and uses a clipboard of its own), drives
# it only through its debug channel (one command per line on standard input), and says PASS or
# FAIL for: the core starting and the host reaching it over its pipe, the workspace page running,
# the page having the core's records through the bridge, a terminal with the system's shell
# echoing what is typed into it, and the app quitting with nothing left running.
#   pwsh host\scripts\build.ps1 -Fixtures
#   pwsh host\scripts\smoke.ps1
# What smoke.sh checks beyond this (the notch, capture, questions, results, speech, pictures)
# waits for the tab and for a desktop: see scripts\winvm\README.md, "At the desktop".
param(
    [string]$Target = $(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }),
    [string]$App = (Join-Path (Split-Path $PSScriptRoot -Parent) "target\$Target-pc-windows-msvc\release\Tasktap Next"),
    [string]$Core = (Join-Path (Split-Path $PSScriptRoot -Parent) 'binaries\fixtures\tasktap.exe'),
    [int]$Seconds = 30
)
$ErrorActionPreference = 'Stop'
$tmp = Join-Path ([IO.Path]::GetTempPath()) "tasktap-smoke-$PID"
New-Item -ItemType Directory -Force "$tmp\data", "$tmp\project" | Out-Null
$failed = 0
function Pass($what) { Write-Host "PASS $what" }
function Fail($what) { Write-Host "FAIL $what"; $script:failed++ }

$start = [Diagnostics.ProcessStartInfo]::new((Join-Path $App 'Tasktap Next.exe'))
$start.UseShellExecute = $false
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.Environment['TASKTAP_DEBUG'] = '1'
$start.Environment['TASKTAP_PASSIVE'] = '1'
$start.Environment['TASKTAP_DATA'] = "$tmp\data"
$start.Environment['TASKTAP_PICK'] = "$tmp\project"
$start.Environment['TASKTAP_CORE_EXE'] = $Core
$start.Environment['TASKTAP_CORE_BUILD'] = (Get-Content (Join-Path (Split-Path $Core -Parent) 'build.txt') -Raw).Trim()
$lines = [Collections.Concurrent.ConcurrentQueue[string]]::new()
$proc = [Diagnostics.Process]::new()
$proc.StartInfo = $start
$seen = [Collections.Generic.List[string]]::new()
$null = Register-ObjectEvent $proc OutputDataReceived -MessageData $lines -Action { if ($EventArgs.Data) { $Event.MessageData.Enqueue($EventArgs.Data) } }
$null = Register-ObjectEvent $proc ErrorDataReceived -MessageData $lines -Action { if ($EventArgs.Data) { $Event.MessageData.Enqueue("stderr: $($EventArgs.Data)") } }
$null = $proc.Start()
$proc.BeginOutputReadLine()
$proc.BeginErrorReadLine()
$deadline = (Get-Date).AddSeconds($Seconds)

# The next line the app prints that matches, within the run's time; every line is kept.
function Until($pattern, $seconds = 10) {
    $until = (Get-Date).AddSeconds($seconds)
    if ($until -gt $deadline) { $until = $deadline }
    while ($true) {
        $line = $null
        while ($lines.TryDequeue([ref]$line)) {
            $seen.Add($line)
            if ($line -match $pattern) { return $line }
        }
        if ((Get-Date) -ge $until -or $proc.HasExited) { return $null }
        Start-Sleep -Milliseconds 50
    }
}
function Send($line) { $proc.StandardInput.WriteLine($line); $proc.StandardInput.Flush() }
# The value of an expression in the workspace page, as text; $null when the page does not answer.
function Js($expr, $seconds = 5) {
    Send "eval workspace $expr"
    $line = Until '"event":"report"' $seconds
    if ($line) { (ConvertFrom-Json $line).data } else { $null }
}

try {
    if (Until '"event":"ready"' 15) { Pass 'the core starts and the host reaches it over its pipe' } else { Fail 'the core starts and the host reaches it' }
    Send 'call core.status {}'
    $status = Until '"event":"reply"' 5
    if ($status -match '"terminals":0') { Pass 'the core answers the host: no terminal runs' } else { Fail "the core answers the host: $status" }
    # The page runs once its window exists; over SSH there is no desktop to show it on.
    $page = $null
    for ($i = 0; $i -lt 10 -and $page -ne 'object'; $i++) { $page = Js 'typeof __ws' 2 }
    if ($page -eq 'object') { Pass 'the workspace page runs in its web view' } else { Fail "the workspace page runs in its web view (it said: $page)" }
    if ($page -eq 'object') {
        $records = $null
        for ($i = 0; $i -lt 10 -and $records -ne 'true'; $i++) { $records = "$(Js "String(__ws.records.prefs !== undefined && __ws.records.projects !== undefined)" 2)".ToLower() }
        if ($records -eq 'true') { Pass 'the page has the core''s records through the bridge' } else { Fail "the page has the core's records (it said: $records)" }
        Send 'menu new-terminal'
        $typed = $null
        for ($i = 0; $i -lt 15 -and -not $typed; $i++) {
            Start-Sleep -Milliseconds 400
            $terminal = Js "(() => { const t = [...__ws.records.terminals.values()].find(t => t.state === 'running'); return t ? t.id : '' })()" 2
            if ($terminal) { $typed = $terminal }
        }
        if ($typed) { Pass 'New Terminal starts the system''s shell' } else { Fail 'New Terminal starts the system''s shell' }
    }
    Send 'state'
    if (Until '"event":"state"' 5) { Pass 'the app says its state' } else { Fail 'the app says its state' }
} finally {
    if (-not $proc.HasExited) {
        Send 'call core.retire {"when":"now"}'
        $null = Until '"event":"reply"' 3
        Send 'quit'
        if (-not $proc.WaitForExit(5000)) { $proc.Kill($true); Fail 'the app quits when told' } else { Pass 'the app quits when told' }
    } else {
        Fail "the app ended by itself with exit code $($proc.ExitCode)"
    }
    Start-Sleep -Milliseconds 500
    $line = $null
    while ($lines.TryDequeue([ref]$line)) { $seen.Add($line) }
    # Nothing of this run stays behind: its core and what the core started.
    $left = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($tmp) })
    if ($left.Count) { Fail "left running: $(($left | ForEach-Object Name) -join ', ')"; $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } } else { Pass 'nothing is left running' }
    if ($failed) { Write-Host '--- what the app said'; $seen | Select-Object -First 60 | ForEach-Object { Write-Host "  $($_.Substring(0, [Math]::Min(300, $_.Length)))" } }
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host $(if ($failed) { "$failed FAILED" } else { 'all passed' })
exit $failed