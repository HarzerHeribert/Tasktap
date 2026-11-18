# The desktop round: the rows of README.md, "At the desktop", that need no person, run in
# order in the signed-in desktop of the test account, each with a PASS or FAIL and its evidence.
# desktop.sh builds the app, starts this there and fetches what it wrote:
#   <Out>\results.txt   one line per check
#   <Out>\*.png         the app's own window (never the screen), where a picture is the evidence
#   <Out>\*.txt         what the smoke script, the credential test and the app printed
# -DryRun starts nothing and shows no window: it says what each row would do and checks that
# what the round needs is there.
param(
    [string]$Out = "C:\tasktap\desktop-rounds\$(Get-Date -Format 'yyyyMMdd-HHmmss')",
    [string]$Target = $(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }),
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$checkout = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$triple = "$Target-pc-windows-msvc"
$app = "$checkout\host\target\$triple\release\Tasktap Next"
$exe = "$app\Tasktap Next.exe"
$data = "$env:LOCALAPPDATA\Tasktap Next"
$tmp = Join-Path ([IO.Path]::GetTempPath()) "tasktap-desk-$PID"
. "$checkout\host\scripts\app.ps1"

Add-Type -AssemblyName System.Drawing.Common
Add-Type -Namespace Tasktap -Name Desk -UsingNamespace System.Text, System.Collections.Generic -MemberDefinition @'
public delegate bool EnumProc(IntPtr window, IntPtr none);
[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc each, IntPtr none);
[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int size);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
[DllImport("user32.dll")] static extern IntPtr GetMenu(IntPtr window);
[DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr menu);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetMenuString(IntPtr menu, uint item, StringBuilder text, int size, uint flags);
[DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
[DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
[DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
[DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
[DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
public struct Rect { public int Left, Top, Right, Bottom; }
public class Window { public IntPtr Handle; public uint ProcessId; public string Class; public string Title; }
// Every visible top-level window.
public static List<Window> Windows() {
    var all = new List<Window>();
    EnumWindows((window, none) => {
        if (IsWindowVisible(window)) {
            uint process;
            GetWindowThreadProcessId(window, out process);
            var kind = new StringBuilder(256);
            GetClassName(window, kind, 256);
            var title = new StringBuilder(512);
            GetWindowText(window, title, 512);
            all.Add(new Window { Handle = window, ProcessId = process, Class = kind.ToString(), Title = title.ToString() });
        }
        return true;
    }, IntPtr.Zero);
    return all;
}
// The names in a window's menu bar; none when it has no menu bar.
public static string[] Menu(IntPtr window) {
    var menu = GetMenu(window);
    var names = new List<string>();
    for (int i = 0; menu != IntPtr.Zero && i < GetMenuItemCount(menu); i++) {
        var name = new StringBuilder(128);
        GetMenuString(menu, (uint)i, name, 128, 0x400);
        names.Add(name.ToString().Replace("&", ""));
    }
    return names.ToArray();
}
// Asks a window to close, as its close button does.
public static void Close(IntPtr window) { PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero); }
// Presses the keys together, as the keyboard would, and lets them go.
public static void Chord(params byte[] keys) {
    foreach (var key in keys) keybd_event(key, 0, 0, UIntPtr.Zero);
    for (int i = keys.Length - 1; i >= 0; i--) keybd_event(keys[i], 0, 2, UIntPtr.Zero);
}
'@

function Say($verdict, $row, $what, $evidence = '') {
    $line = '{0,-4} {1,-2} {2}{3}' -f $verdict, $row, $what, $(if ("$evidence") { " :: $evidence" })
    Write-Host $line
    if (-not $DryRun) { Add-Content "$Out\results.txt" $line }
}
function Check($row, $what, $ok, $evidence = '') { Say $(if ($ok) { 'PASS' } else { 'FAIL' }) $row $what $evidence }
# The window as it is drawn, into <Out>\<name>.png: the window's own picture, not the screen's.
function Capture([IntPtr]$window, $name) {
    $rect = [Tasktap.Desk+Rect]::new()
    $null = [Tasktap.Desk]::GetWindowRect($window, [ref]$rect)
    $bitmap = [Drawing.Bitmap]::new([Math]::Max(1, $rect.Right - $rect.Left), [Math]::Max(1, $rect.Bottom - $rect.Top))
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $dc = $graphics.GetHdc()
    $drawn = [Tasktap.Desk]::PrintWindow($window, $dc, 2)
    $graphics.ReleaseHdc($dc)
    $bitmap.Save("$Out\$name.png", [Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $bitmap.Dispose()
    "$name.png ($($rect.Right - $rect.Left) x $($rect.Bottom - $rect.Top)$(if (-not $drawn) { ', the system did not draw it' }))"
}
function Window-Of($process, $seconds) {
    $until = (Get-Date).AddSeconds($seconds)
    do {
        $window = [Tasktap.Desk]::Windows() | Where-Object { $_.ProcessId -eq $process.Id -and $_.Title -eq 'Tasktap' } | Select-Object -First 1
        if ($window) { return $window }
        Start-Sleep -Milliseconds 50
    } while ((Get-Date) -lt $until -and -not $process.HasExited)
}
# The cores that run from a data folder, and everything else that does.
function Under($folder) { @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($folder, [StringComparison]::OrdinalIgnoreCase) }) }
function Children($process, $name) { @(Get-Process $name -ErrorAction SilentlyContinue | Where-Object { $_.Parent.Id -eq $process.Id }) }
# The page's answer once it is one: the page and the core need a moment after a command.
function Soon($expr, $want, $tries = 15) {
    $got = $null
    for ($i = 0; $i -lt $tries; $i++) {
        $got = Js $expr 2
        if ("$got" -match $want) { break }
        Start-Sleep -Milliseconds 400
    }
    "$got"
}

$rows = [ordered]@{}

$rows['1'] = 'Starts the app as Explorer would, with no debug channel and its own data folder; waits for one visible window titled Tasktap and times it; reads the menu bar''s names; saves the window''s picture; looks for any new console window; lists the app''s core and web view processes; closes the window as its close button does and times the app''s end; watches the core leave by itself (a minute) and ends it after 90 s if it has not.', {
    $before = @([Tasktap.Desk]::Windows() | ForEach-Object Handle)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $process = Start-Process $exe -PassThru
    $window = Window-Of $process 30
    $ms = [int]$watch.Elapsed.TotalMilliseconds
    Check 1 'one window titled Tasktap appears' ($null -ne $window) "after $ms ms (the checklist asks for two seconds; the web view's first start on a machine takes longer)"
    if (-not $window) { if (-not $process.HasExited) { $process.Kill($true) }; return }
    Start-Sleep -Seconds 4
    $menu = [Tasktap.Desk]::Menu($window.Handle) -join ', '
    Check 1 'its menu bar is Tasktap, File, Edit, View, Window' ($menu -eq 'Tasktap, File, Edit, View, Window') "menu bar: $menu"
    Say 'LOOK' 1 'the window with Home in it, and its backdrop (Mica, not the desktop showing through)' (Capture $window.Handle 'row1-window')
    $new = @([Tasktap.Desk]::Windows() | Where-Object { $_.Handle -notin $before -and $_.Handle -ne $window.Handle })
    $consoles = @($new | Where-Object { $_.Class -match 'ConsoleWindowClass|CASCADIA_HOSTING_WINDOW_CLASS' })
    Check 1 'no console window opens' (-not $consoles) "new windows besides the app's: $(($new | ForEach-Object { "$($_.Class) '$($_.Title)'" }) -join '; ')"
    $core = Under $data | Where-Object Name -eq 'tasktap'
    $views = Children $process 'msedgewebview2'
    Check 1 'the core and the web view run beside the app' ($core -and $views) "tasktap.exe: $(($core | ForEach-Object Path) -join ', '); msedgewebview2.exe under the app: $($views.Count)"
    Check 1 'its data is in %LOCALAPPDATA%\Tasktap Next' (Test-Path "$data\core.db") "$data\core.db"
    $watch.Restart()
    [Tasktap.Desk]::Close($window.Handle)
    $ended = $process.WaitForExit(10000)
    Check 1 'closing the window quits the app' $ended $(if ($ended) { "gone after $([int]$watch.Elapsed.TotalMilliseconds) ms" } else { 'still running 10 s later; this script ended it' })
    if (-not $ended) { $process.Kill($true) }
    $stayed = @(Under $data | Where-Object Name -eq 'tasktap').Count -gt 0
    Check 1 'the core stays behind the closed app' $stayed
    while ($watch.Elapsed.TotalSeconds -lt 90 -and (Under $data)) { Start-Sleep -Milliseconds 500 }
    $left = Under $data
    Check 1 'the core leaves by itself within a minute and a half' (-not $left) $(if ($left) { "still running, ended by this script: $(($left | ForEach-Object Name) -join ', ')" } else { "gone $([int]$watch.Elapsed.TotalSeconds) s after the window closed" })
    $left | Stop-Process -Force -ErrorAction SilentlyContinue
}

$rows['2'] = 'Runs host\scripts\smoke.ps1 against the built app and the fixture core: the app opens its window behind the others for a few seconds, a folder becomes a workspace, a terminal answers what is typed, the app quits when told and leaves nothing running.', {
    pwsh -NoProfile -File "$checkout\host\scripts\smoke.ps1" -Target $Target *> "$Out\row2-smoke.txt"
    $code = $LASTEXITCODE
    $said = @(Get-Content "$Out\row2-smoke.txt")
    $quit = $said | Where-Object { $_ -match 'the app quits when told|NOTE' }
    Check 2 'the smoke script: only PASS lines and all passed' ($code -eq 0 -and $said -contains 'all passed' -and -not ($said -match '^(FAIL|NOTE)')) "exit $code; $(@($said -match '^PASS').Count) PASS, $(@($said -match '^FAIL').Count) FAIL; $($quit -join '; '); row2-smoke.txt"
}

$rows['3'] = 'Nothing: the tab at the top edge is not built yet.', {
    Say 'SKIP' 3 'the tab at the top edge is not built yet'
}

$rows['4'] = 'Starts the app with its debug channel on a data folder of its own (it stays up for rows 5 and 8). Reads the capture-key event: the default must register and be Alt-Shift-Space. Has the page change the key to Control-Alt-T and back to the default through host.capture_key. Opens Notepad in front, presses Alt-Shift-Space as the keyboard would, and expects the Tasktap window in front; says where the caret is.', {
    $said = @($seen | Where-Object { $_ -match '"event":"capture-key"' })[-1]
    if (-not $said) { $said = Until '"event":"capture-key"' 10 }
    $default = "$said" -match '"ok":true' -and "$said" -match '"alt":true' -and "$said" -match '"shift":true' -and "$said" -match '"control":false' -and "$said" -match '"code":"Space"'
    Check 4 'the default capture key registers and is Alt-Shift-Space, not Control-Alt' $default $said
    $other = Js "__ws.call('host.capture_key', { key: { control: true, alt: true, shift: false, meta: false, code: 'KeyT' } }).then(JSON.stringify, e => 'refused: ' + (e.message ?? e))"
    Check 4 'a Control-Alt key registers when asked for' ("$other" -match '"code":"KeyT"') $other
    $back = Js "__ws.call('host.capture_key', { key: null }).then(JSON.stringify, e => 'refused: ' + (e.message ?? e))"
    Check 4 'the default registers again when the preference is cleared' ("$back" -match '"code":"Space"' -and "$back" -match '"shift":true') $back
    $marker = "Tasktap-desk-$PID"
    Set-Content "$tmp\$marker.txt" ''
    Start-Process notepad.exe -ArgumentList "$tmp\$marker.txt"
    $notepad = $null
    for ($i = 0; $i -lt 50 -and -not $notepad; $i++) {
        Start-Sleep -Milliseconds 200
        $notepad = [Tasktap.Desk]::Windows() | Where-Object { $_.Title -like "*$marker*" } | Select-Object -First 1
    }
    if (-not $notepad) { Say 'FAIL' 4 'the shortcut brings Tasktap to the front' 'Notepad did not open, so no other program was in front'; return }
    $null = [Tasktap.Desk]::SetForegroundWindow($notepad.Handle)
    Start-Sleep -Milliseconds 500
    $infront = [Tasktap.Desk]::GetForegroundWindow() -eq $notepad.Handle
    [Tasktap.Desk]::Chord([byte[]](0x12, 0x10, 0x20))
    $front = $false
    for ($i = 0; $i -lt 30 -and -not $front; $i++) { Start-Sleep -Milliseconds 100; $front = [Tasktap.Desk]::GetForegroundWindow() -eq $workspace }
    $caret = Js "(e => e ? e.tagName + ' ' + (e.getAttribute('placeholder') ?? e.className) : 'nothing')(document.activeElement)"
    Check 4 'Alt-Shift-Space pressed over Notepad brings the Tasktap window to the front' $front "Notepad was in front before: $infront; the caret is in: $caret"
    Say 'LOOK' 4 'New Task open with the caret in its field' (Capture $workspace 'row4-shortcut')
    [Tasktap.Desk]::Close($notepad.Handle)
}

$rows['5'] = 'In the same app: makes a folder a workspace, opens a terminal, and types into it: set /a 6*7 (cmd answers 42), ping -t localhost and Control-C (the prompt comes back and answers again), powershell and a line only PowerShell answers. Then looks at the terminal''s console: OpenConsole.exe under the core, and no conhost.exe there.', {
    $folder = "$tmp\project".Replace('\', '\\')
    $null = Js "(__ws.call('project.add', { id: __ws.uuid7(), folder: '$folder' }), 1)"
    $project = Soon "[...__ws.records.projects.values()].find(p => p.kind === 'folder')?.id ?? ''" '.'
    $null = Js "(__ws.show('$project'), __ws.command('new-terminal'), 1)"
    $terminal = Soon "[...__ws.records.terminals.values()].find(t => t.state === 'running')?.id ?? ''" '.'
    Check 5 'New Terminal starts a shell' ([bool]$terminal) "terminal $terminal"
    if (-not $terminal) { return }
    $null = Js "(__ws.type('set /a 6*7'), 1)"
    $screen = Soon '__ws.text()' '(?m)^42'
    Check 5 'cmd.exe answers what is typed' ($screen -match '(?m)^42') (($screen -split "`n")[-3..-1] -join ' | ')
    $null = Js "(__ws.type('ping -t localhost'), 1)"
    $screen = Soon '__ws.text()' '(?m)^(Reply|Antwort)'
    $null = Js "(__ws.engines.get(__ws.current().id).term.input('\x03', true), 1)"
    Start-Sleep -Milliseconds 800
    $null = Js "(__ws.type('set /a 5*5'), 1)"
    $screen = Soon '__ws.text()' '(?m)^25'
    Check 5 'Control-C ends ping and the prompt answers again' ($screen -match '(?m)^25') (($screen -split "`n")[-4..-1] -join ' | ')
    $null = Js "(__ws.type('powershell -NoLogo -NoProfile'), 1)"
    $null = Soon '__ws.text()' '(?m)^PS .*>\s*$'
    $null = Js "(__ws.type('`$PSVersionTable.PSEdition + 6*7'), 1)"
    $screen = Soon '__ws.text()' '(?m)^(Desktop|Core)42'
    Check 5 'PowerShell runs in the terminal and answers' ($screen -match '(?m)^(Desktop|Core)42') (($screen -split "`n")[-3..-1] -join ' | ')
    $core = Under "$tmp\data" | Where-Object Name -eq 'tasktap' | Select-Object -First 1
    $open = Children $core 'OpenConsole'
    $system = Children $core 'conhost'
    Check 5 'the terminal''s console is OpenConsole.exe under the core, not conhost.exe' ($open -and -not $system) "OpenConsole.exe: $(($open | ForEach-Object Path) -join ', '); conhost.exe under the core: $($system.Count)"
    Say 'LOOK' 5 'the terminal after cmd, ping and PowerShell: every line echoed once, no stray characters' (Capture $workspace 'row5-terminal')
    $null = Js "(__ws.type('exit'), 1)"
    $null = Soon '__ws.text()' '(?m)^[A-Z]:\\.*>\s*$' 8
}

$rows['6'] = 'Runs cargo test -p tasktap-core --test secrets -- --ignored in the checkout (the credential store refuses a session without a desktop), then looks for an entry the test left in the store.', {
    Push-Location "$checkout\core"
    try {
        $env:CARGO_BUILD_TARGET = $triple
        cargo test -p tasktap-core --test secrets -- --ignored *> "$Out\row6-secrets.txt"
        $code = $LASTEXITCODE
    } finally { Pop-Location; Remove-Item Env:CARGO_BUILD_TARGET }
    $result = @(Get-Content "$Out\row6-secrets.txt") -match '^test result'
    Check 6 'the credential store keeps and gives back a key' ($code -eq 0 -and "$result" -match 'ok\. [1-9]') "exit $code; $result; row6-secrets.txt"
    $entries = @(cmdkey /list | Select-String -Pattern 'Tasktap test (safe to delete):' -SimpleMatch)
    Check 6 'the test leaves no entry in the store' (-not $entries) "entries of the test's service (Tasktap test (safe to delete)): $($entries.Count) $($entries -join ' ')"
}

$rows['7'] = 'Nothing: whether the web view is granted the microphone without a prompt is for a person to see.', {
    Say 'SKIP' 7 'the microphone: for a person (see the list for the owner)'
}

$rows['8'] = 'In the same app: asks the page which bundled fonts it loaded and what the terminal is set in; types a line of box and block characters into the terminal; saves the window''s picture with the terminal, with Home and with Settings in it.', {
    $loaded = Js "document.fonts.ready.then(() => [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family + ' ' + f.weight).join(', '))" 10
    $terminal = Js "__ws.engines.get(__ws.current()?.id ?? '')?.term.options.fontFamily ?? 'no terminal'"
    Check 8 'the terminal is set in Hack and the page loaded it' ("$terminal" -match 'Hack' -and "$loaded" -match 'Hack') "terminal: $terminal; loaded: $loaded"
    $null = Js "(__ws.type('chcp 65001'), 1)"
    $null = Js "(__ws.type('echo \u250c\u2500\u252c\u2500\u2510 \u2502 \u2588\u2580\u2584 \u2591\u2592\u2593'), 1)"
    Start-Sleep -Seconds 1
    Say 'LOOK' 8 'box lines and blocks join without gaps; text is sharp' (Capture $workspace 'row8-terminal')
    $body = Js "getComputedStyle(document.body).fontFamily"
    $null = Js "(__ws.show('home'), 1)"
    Start-Sleep -Seconds 1
    Say 'LOOK' 8 "Home: no fallback serif face (the page asks for $body)" (Capture $workspace 'row8-home')
    Send 'menu settings'
    Start-Sleep -Seconds 1
    Say 'LOOK' 8 'Settings: no fallback serif face' (Capture $workspace 'row8-settings')
}

$rows['9'] = 'Nothing of its own: a folder given by TASKTAP_PICK becomes a workspace in rows 2 and 5; the folder panel is not built yet.', {
    Say 'SKIP' 9 'the folder panel is not built yet; TASKTAP_PICK is used in rows 2 and 5'
}

$rows['+'] = 'Beyond the checklist: asks taskkill''s and tasklist''s service (Windows Management Instrumentation) for this process, which it refuses the same account over SSH; tells the app with the debug channel to quit and times it, and looks for what it left running.', {
    $listed = & "$env:SystemRoot\System32\tasklist.exe" /FI "PID eq $PID" /NH 2>&1
    Say $(if ($LASTEXITCODE -eq 0) { 'PASS' } else { 'INFO' }) '+' 'the management service answers a standard account at the desktop' "tasklist exit $LASTEXITCODE: $("$listed".Trim())"
}

# What the rows need.
$needs = [ordered]@{
    'the built app' = $exe
    'the bundled console beside it' = "$app\OpenConsole.exe"
    'the fixture core for the smoke script' = "$checkout\host\binaries\fixtures\tasktap.exe"
    'the smoke script' = "$checkout\host\scripts\smoke.ps1"
    'the desktop helper' = 'C:\tasktap\desk.ps1'
}
$missing = @($needs.Keys | Where-Object { -not (Test-Path $needs[$_]) })
$session = (Get-Process -Id $PID).SessionId

if ($DryRun) {
    New-Item -ItemType Directory -Force $Out | Out-Null
    function Tell($line) { Write-Host $line; Add-Content "$Out\dry-run.txt" $line }
    Tell "Dry run in session $session (the active desktop is session $([Tasktap.Desk]::WTSGetActiveConsoleSessionId())): nothing is started."
    Tell "The window helpers compiled; $(@([Tasktap.Desk]::Windows()).Count) visible windows in this session; pictures as $([Drawing.Imaging.ImageFormat]::Png)."
    foreach ($need in $needs.Keys) { Tell ('{0,-7} {1}: {2}' -f $(if ($need -in $missing) { 'MISSING' } else { 'there' }), $need, $needs[$need]) }
    try {
        $scheduler = New-Object -ComObject Schedule.Service
        $scheduler.Connect()
        $task = $scheduler.GetFolder('\').GetTask('Tasktap Desktop')
        Tell "there   the task the helper starts: Tasktap Desktop, enabled $($task.Enabled), state $($task.State)"
    } catch { Tell "MISSING the task the helper starts: $($_.Exception.Message)" }
    Tell "Would write to $Out"
    foreach ($row in $rows.Keys) { Tell ('row {0,-2} {1}' -f $row, $rows[$row][0]) }
    exit [int]($missing.Count -gt 0)
}

if ($missing) { throw "Missing: $($missing -join ', '). Run scripts/winvm/host.sh --tower first." }
if ($session -eq 0 -or $session -ne [Tasktap.Desk]::WTSGetActiveConsoleSessionId()) { throw "This account's desktop is not the one on the screen (session $session). Switch the screen to it first." }
$desktop = [Tasktap.Desk]::OpenInputDesktop(0, $false, 0x0001)
if ($desktop -eq [IntPtr]::Zero) { throw 'The desktop is locked. Unlock it first.' }
$null = [Tasktap.Desk]::CloseDesktop($desktop)
$null = [Tasktap.Desk]::SetProcessDPIAware()
New-Item -ItemType Directory -Force $Out, "$tmp\data", "$tmp\project" | Out-Null
# No test run may change the checkout meanwhile.
$lock = [IO.File]::Open('C:\tasktap\checkout.lock', 'OpenOrCreate', 'ReadWrite', 'None')
$workspace = [IntPtr]::Zero
try {
    Say 'INFO' '' "commit $(git -C $checkout rev-parse HEAD), $triple, $([Environment]::OSVersion.VersionString), session $session"
    foreach ($row in $rows.Keys) {
        try {
            if ($row -eq '4') {
                # Rows 4, 5 and 8 share one app, driven through its debug channel.
                Start-App $exe @{ TASKTAP_DATA = "$tmp\data"; TASKTAP_PICK = "$tmp\project" } 600
                $ready = Until '"event":"ready"' 45
                $page = Soon 'typeof __ws' 'object'
                Send 'state'
                $state = Until '"event":"state"' 5
                if ($state) { $workspace = [IntPtr][long](ConvertFrom-Json $state).workspace }
                Check 4 'the app starts with its debug channel and its page runs' ($ready -and $page -eq 'object' -and $workspace -ne [IntPtr]::Zero) "window $workspace"
            }
            if ($row -in '4', '5', '8' -and ($proc.HasExited -or $workspace -eq [IntPtr]::Zero)) { Say 'FAIL' $row 'not run: the app of rows 4, 5 and 8 is not running'; continue }
            if ($row -eq '+' -and $proc -and -not $proc.HasExited) {
                Send 'call core.retire {"when":"now"}'
                $null = Until '"event":"reply"' 3
                Send 'quit'
                $watch = [Diagnostics.Stopwatch]::StartNew()
                $ended = $proc.WaitForExit(10000)
                Check '+' 'the app quits when told through its debug channel' $ended $(if ($ended) { "gone after $([int]$watch.Elapsed.TotalMilliseconds) ms" } else { 'still running 10 s later' })
                Start-Sleep -Milliseconds 500
                $left = Under $tmp
                Check '+' 'it leaves nothing running' (-not $left) (($left | ForEach-Object Name) -join ', ')
            }
            & $rows[$row][1]
        } catch {
            Say 'FAIL' $row 'the row stopped on an error' "$($_.Exception.Message) ($($_.InvocationInfo.ScriptLineNumber))"
        }
    }
} finally {
    if ($proc -and -not $proc.HasExited) { $proc.Kill($true) }
    Under $tmp | Stop-Process -Force -ErrorAction SilentlyContinue
    if ($seen) { $seen | Set-Content "$Out\rows4-8-app.txt" }
    Start-Sleep -Milliseconds 500
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    $lock.Dispose()
}
$said = @(Get-Content "$Out\results.txt")
Write-Host "$(@($said -match '^PASS').Count) passed, $(@($said -match '^FAIL').Count) failed, $(@($said -match '^LOOK').Count) pictures to look at; all of it is in $Out"
exit [int](@($said -match '^FAIL').Count -gt 0)
