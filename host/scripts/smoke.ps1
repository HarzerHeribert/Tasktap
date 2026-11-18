# host\scripts\smoke.ps1: the first part of smoke.sh for Windows. It starts the built app on a
# temporary data folder, passive (it takes no keyboard and uses a clipboard of its own), drives
# it only through its debug channel (one command per line on standard input), and says PASS or
# FAIL for: the core starting and the host reaching it over its pipe, the workspace page running,
# the page having the core's records through the bridge, a folder becoming a workspace, a
# terminal with the system's shell answering what is typed into it, and the app quitting with
# nothing left running.
#   pwsh host\scripts\build.ps1 -Fixtures
#   pwsh host\scripts\smoke.ps1
# What smoke.sh checks beyond this (the notch, capture, questions, results, speech, pictures)
# waits for the tab and for a desktop: see scripts\winvm\README.md, "At the desktop".
param(
    [string]$Target = $(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }),
    [string]$App = (Join-Path (Split-Path $PSScriptRoot -Parent) "target\$Target-pc-windows-msvc\release\Tasktap Next"),
    [string]$Core = (Join-Path (Split-Path $PSScriptRoot -Parent) 'binaries\fixtures\tasktap.exe'),
    [int]$Seconds = 120
)
$ErrorActionPreference = 'Stop'
$tmp = Join-Path ([IO.Path]::GetTempPath()) "tasktap-smoke-$PID"
New-Item -ItemType Directory -Force "$tmp\data", "$tmp\project" | Out-Null
$failed = 0
function Pass($what) { Write-Host "PASS $what" }
function Fail($what) { Write-Host "FAIL $what"; $script:failed++ }

. (Join-Path $PSScriptRoot 'app.ps1')
Start-App (Join-Path $App 'Tasktap Next.exe') @{
    TASKTAP_PASSIVE = '1'
    TASKTAP_DATA = "$tmp\data"
    TASKTAP_PICK = "$tmp\project"
    TASKTAP_CORE_EXE = $Core
    TASKTAP_CORE_BUILD = (Get-Content (Join-Path (Split-Path $Core -Parent) 'build.txt') -Raw).Trim()
} $Seconds

try {
    # The first start of the web view on a machine takes its time.
    if (Until '"event":"ready"' 45) { Pass 'the core starts and the host reaches it over its pipe' } else { Fail 'the core starts and the host reaches it' }
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
        # A folder as a workspace, and in it a terminal with the system's shell, typed into.
        $folder = "$tmp\project".Replace('\', '\\')
        $null = Js "(__ws.call('project.add', { id: __ws.uuid7(), folder: '$folder' }), 1)"
        $project = $null
        for ($i = 0; $i -lt 10 -and -not $project; $i++) { $project = Js "[...__ws.records.projects.values()].find(p => p.kind === 'folder')?.id ?? ''" 2 }
        if ($project) { Pass 'a folder becomes a workspace' } else { Fail 'a folder becomes a workspace' }
        $null = Js "(__ws.show('$project'), __ws.command('new-terminal'), 1)"
        $terminal = $null
        for ($i = 0; $i -lt 15 -and -not $terminal; $i++) {
            Start-Sleep -Milliseconds 400
            $terminal = Js "[...__ws.records.terminals.values()].find(t => t.state === 'running')?.id ?? ''" 2
        }
        if ($terminal) { Pass 'New Terminal starts the system''s shell' } else { Fail 'New Terminal starts the system''s shell' }
        if ($terminal) {
            # The command prompt reckons: the answer is nowhere in what was typed.
            $null = Js "(__ws.type('set /a 6*7'), 1)"
            $screen = ''
            for ($i = 0; $i -lt 15 -and "$screen" -notmatch '(?m)^42'; $i++) { Start-Sleep -Milliseconds 400; $screen = Js '__ws.text()' 2 }
            if ("$screen" -match '(?m)^42') { Pass 'the shell is typed into and answers' } else { Fail "the shell is typed into and answers (its screen: $("$screen".Trim()))" }
            $null = Js "(__ws.call('terminal.stop', { id: '$terminal' }), 1)"
        }
    }
    if ($page -eq 'object') {
        # The capture key (design §12). At a desktop this system's own registers; a session
        # without one is refused every key, and the host says so, holds none and goes on.
        $refused = "e => 'refused: ' + (e.message ?? e)"
        $key = Js "__ws.call('host.capture_key', {}).then(JSON.stringify, $refused)"
        if ([Diagnostics.Process]::GetCurrentProcess().SessionId -ne 0) {
            if ("$key" -match '"alt":true' -and "$key" -match '"shift":true' -and "$key" -match '"code":"Space"') { Pass 'the capture key registers: Alt-Shift-Space' } else { Fail "the capture key registers (the host said: $key)" }
        } else {
            $asked = Js "__ws.call('host.capture_key', { key: { control: true, alt: true, shift: false, meta: false, code: 'KeyT' } }).then(JSON.stringify, $refused)"
            if ($key -eq '{"key":null}' -and "$asked" -match '^refused: .*taken') { Pass 'no desktop here (session 0): the host holds no capture key and says that one asked for is taken' } else { Fail "the capture key without a desktop (the host said: $key, then: $asked)" }
        }
    }
    Send 'state'
    if (Until '"event":"state"' 5) { Pass 'the app says its state' } else { Fail 'the app says its state' }
} finally {
    if (-not $proc.HasExited) {
        Send 'call core.retire {"when":"now"}'
        $null = Until '"event":"reply"' 3
        Send 'quit'
        $asked = Get-Date
        $heard = Until '"event":"quitting"' 5
        if ($proc.WaitForExit(10000)) {
            Pass "the app quits when told ($([int]((Get-Date) - $asked).TotalMilliseconds) ms)"
        } else {
            $proc.Kill($true)
            # Seen over SSH on 2026-11-18: the app takes the request ("quitting") and its event
            # loop never ends. With no desktop (session 0) that is not known to be the app's
            # fault, so there it is said and not counted; at a desktop it is a failure.
            $why = "the app $(if ($heard) { 'took the request and' } else { 'never took the request and' }) was still running 10 s later; this script ended it"
            if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { Write-Host "NOTE  no desktop here (session 0): $why" } else { Fail "the app quits when told: $why" }
        }
    } else {
        Fail "the app ended by itself with exit code $($proc.ExitCode)"
    }
    Start-Sleep -Milliseconds 500
    $line = $null
    while ($lines.TryDequeue([ref]$line)) { $seen.Add($line) }
    # Nothing of this run stays behind: its core and the shims run from the data folder. Found by
    # their paths, not their command lines: those only the management service tells
    # (Win32_Process), and it refuses a standard account signed in over SSH.
    $left = @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($tmp, [StringComparison]::OrdinalIgnoreCase) })
    if ($left.Count) { Fail "left running: $(($left | ForEach-Object Name) -join ', ')"; $left | Stop-Process -Force -ErrorAction SilentlyContinue } else { Pass 'nothing is left running' }
    if ($failed) { Write-Host '--- what the app said'; $seen | Select-Object -First 60 | ForEach-Object { Write-Host "  $($_.Substring(0, [Math]::Min(300, $_.Length)))" } }
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host $(if ($failed) { "$failed FAILED" } else { 'all passed' })
exit $failed