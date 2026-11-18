# The desktop round: the rows of README.md, "At the desktop", that need no person, run in
# order in the signed-in desktop of the test account, each with a PASS or FAIL and its evidence.
# desktop.sh builds the app, starts this there and fetches what it wrote:
#   <Out>\results.txt   one line per check
#   <Out>\*.png         the app's own window, where a picture is the evidence; *-screen.png is the screen inside
#                       the window's edges while it is in front (the frame, a menu, the backdrop as a person sees them)
#   <Out>\*.txt         what the smoke script, the credential test and the app printed (rows4-12-app.txt, row13-app.txt)
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
Add-Type -AssemblyName System.Windows.Forms
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
[DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect value, int size);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string kind, string title);
// Every visible top-level window, those of the system's own layers among them (its flyouts), which EnumWindows
// leaves out.
public static List<Window> Every() {
    var all = new List<Window>();
    for (var window = FindWindowEx(IntPtr.Zero, IntPtr.Zero, null, null); window != IntPtr.Zero; window = FindWindowEx(IntPtr.Zero, window, null, null)) {
        if (!IsWindowVisible(window)) continue;
        uint process;
        GetWindowThreadProcessId(window, out process);
        var kind = new StringBuilder(256);
        GetClassName(window, kind, 256);
        var title = new StringBuilder(512);
        GetWindowText(window, title, 512);
        all.Add(new Window { Handle = window, ProcessId = process, Class = kind.ToString(), Title = title.ToString() });
    }
    return all;
}
[DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
[DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
[DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point at);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out Point at);
[DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int how);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int w, int h, uint flags);
public struct Point { public int X, Y; }
public struct Rect { public int Left, Top, Right, Bottom; }
// The window as a person sees it: without the unseen margins Windows keeps around it for resizing.
public static Rect Frame(IntPtr window) {
    Rect r;
    if (DwmGetWindowAttribute(window, 9, out r, 16) != 0) GetWindowRect(window, out r);
    return r;
}
// What the window under a point of the screen says that point is: 1 its inside, 2 its title bar, 8, 9 and 20 its
// Minimize, Maximize and Close, 12 its top edge.
public static int HitTest(int x, int y) {
    var window = WindowFromPoint(new Point { X = x, Y = y });
    return (int)SendMessage(window, 0x0084, IntPtr.Zero, (IntPtr)(((y & 0xffff) << 16) | (x & 0xffff)));
}
// The pointer put somewhere, and pressed there: the left button, or the right; once or twice.
public static void Point_(int x, int y) { SetCursorPos(x, y); mouse_event(1, 0, 0, 0, UIntPtr.Zero); }
public static void Press(int x, int y, bool right, int times) {
    Point_(x, y);
    for (int i = 0; i < times; i++) {
        mouse_event(right ? 8u : 2u, 0, 0, 0, UIntPtr.Zero);
        mouse_event(right ? 16u : 4u, 0, 0, 0, UIntPtr.Zero);
    }
}
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
# The window's own picture, as the system draws the window for a program that asks: the whole window with the unseen
# margins Windows keeps around it, which are cut off.
function Picture([IntPtr]$window) {
    $rect = [Tasktap.Desk+Rect]::new()
    $null = [Tasktap.Desk]::GetWindowRect($window, [ref]$rect)
    $frame = [Tasktap.Desk]::Frame($window)
    $whole = [Drawing.Bitmap]::new([Math]::Max(1, $rect.Right - $rect.Left), [Math]::Max(1, $rect.Bottom - $rect.Top))
    $graphics = [Drawing.Graphics]::FromImage($whole)
    $dc = $graphics.GetHdc()
    $script:drawn = [Tasktap.Desk]::PrintWindow($window, $dc, 2)
    $graphics.ReleaseHdc($dc)
    $graphics.Dispose()
    $inner = [Drawing.Rectangle]::FromLTRB([Math]::Max(0, $frame.Left - $rect.Left), [Math]::Max(0, $frame.Top - $rect.Top), [Math]::Min($whole.Width, $frame.Right - $rect.Left), [Math]::Min($whole.Height, $frame.Bottom - $rect.Top))
    $bitmap = $whole.Clone($inner, $whole.PixelFormat)
    $whole.Dispose()
    $bitmap
}
# How light a picture is, 0 to 255: the mean over a grid of its points.
function Light([Drawing.Bitmap]$bitmap) {
    $sum = 0; $n = 0
    for ($x = 0; $x -lt 24; $x++) { for ($y = 0; $y -lt 16; $y++) {
        $c = $bitmap.GetPixel([int](($x + 0.5) * $bitmap.Width / 24), [int](($y + 0.5) * $bitmap.Height / 16))
        $sum += ($c.R + $c.G + $c.B) / 3; $n++
    } }
    [int]($sum / $n)
}
# The window as it is drawn, into <Out>\<name>.png. With -Screen also as it stands on the screen, into
# <Out>\<name>-screen.png: the screen's own points inside the window's edges and nowhere else, taken only while the
# window is the one in front and nothing covers it. That is the only picture with the frame's hairline, the round
# corners and the backdrop as a person sees them.
function Capture([IntPtr]$window, $name, [switch]$Screen) {
    $bitmap = Picture $window
    $bitmap.Save("$Out\$name.png", [Drawing.Imaging.ImageFormat]::Png)
    $said = "$name.png ($($bitmap.Width) x $($bitmap.Height)$(if (-not $drawn) { ', the system did not draw it' }))"
    $bitmap.Dispose()
    if ($Screen) {
        $frame = [Tasktap.Desk]::Frame($window)
        if ([Tasktap.Desk]::GetForegroundWindow() -eq $window) {
            $shot = [Drawing.Bitmap]::new($frame.Right - $frame.Left, $frame.Bottom - $frame.Top)
            $graphics = [Drawing.Graphics]::FromImage($shot)
            $graphics.CopyFromScreen($frame.Left, $frame.Top, 0, 0, $shot.Size)
            $graphics.Dispose()
            $shot.Save("$Out\$name-screen.png", [Drawing.Imaging.ImageFormat]::Png)
            $shot.Dispose()
            $said += "; as on the screen: $name-screen.png"
        } else { $said += '; not taken from the screen: the window was not the one in front' }
    }
    $said
}
# The app's window in front, as a click on it would put it: Windows lets a program in the background bring a window
# forward only after a key press.
function Front([IntPtr]$window) {
    if ([Tasktap.Desk]::GetForegroundWindow() -eq $window) { return $true }
    [Tasktap.Desk]::Chord([byte[]](0x12))
    $null = [Tasktap.Desk]::SetForegroundWindow($window)
    Start-Sleep -Milliseconds 400
    [Tasktap.Desk]::GetForegroundWindow() -eq $window
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
    # What the window shows from the moment it can be seen: never a light window before the page has drawn.
    $lights = @(for ($i = 0; $i -lt 12; $i++) { $first = Picture $window.Handle; Light $first; if ($i -eq 0) { $first.Save("$Out\row1-first.png", [Drawing.Imaging.ImageFormat]::Png) }; $first.Dispose(); Start-Sleep -Milliseconds 25 })
    Check 1 'the window is dark from the first moment it is seen' (($lights | Measure-Object -Maximum).Maximum -lt 60) "how light its first twelve pictures are, of 255: $($lights -join ' '); the first is row1-first.png"
    Start-Sleep -Seconds 4
    $menu = [Tasktap.Desk]::Menu($window.Handle) -join ', '
    Check 1 'the window has no menu bar of the system''s' (-not $menu) "menu bar: $(if ($menu) { $menu } else { 'none' })"
    Say 'LOOK' 1 'the window with Home in it: one dark surface, the page''s top row as its title bar' (Capture $window.Handle 'row1-window' -Screen)
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
    # Windows lets a program in the background bring a window forward only after a key press.
    if ([Tasktap.Desk]::GetForegroundWindow() -ne $notepad.Handle) {
        [Tasktap.Desk]::Chord([byte[]](0x12))
        $null = [Tasktap.Desk]::SetForegroundWindow($notepad.Handle)
        Start-Sleep -Milliseconds 500
    }
    if ([Tasktap.Desk]::GetForegroundWindow() -ne $notepad.Handle) {
        Say 'INFO' 4 'the shortcut was not pressed: Notepad could not be put in front of the app, so a press would prove nothing'
    } else {
        [Tasktap.Desk]::Chord([byte[]](0x12, 0x10, 0x20))
        $front = $false
        for ($i = 0; $i -lt 30 -and -not $front; $i++) { Start-Sleep -Milliseconds 100; $front = [Tasktap.Desk]::GetForegroundWindow() -eq $workspace }
        $caret = Js "(e => e ? e.tagName + ' ' + (e.getAttribute('placeholder') ?? e.className) : 'nothing')(document.activeElement)"
        Check 4 'Alt-Shift-Space pressed over Notepad brings the Tasktap window to the front' $front "the caret is in: $caret"
        Say 'LOOK' 4 'New Task open with the caret in its field' (Capture $workspace 'row4-shortcut')
    }
    [Tasktap.Desk]::Close($notepad.Handle)
    # The sheet is closed again: the rows after this one start where a person would, with nothing open.
    $null = Js "(__ws.dismiss(), 1)"
    $closed = Soon 'String(!__ws.ui.sheet)' 'true' 5
    Check 4 'the New Task sheet closes again' ($closed -eq 'true') "no sheet open: $closed"
}

$rows['5'] = 'In the same app: makes a folder a workspace, opens a terminal, and types into it: set /a 6*7 (cmd answers 42), ping -t localhost and Control-C (the prompt comes back and answers again), powershell and a line only PowerShell answers. Then looks at the terminal''s console: OpenConsole.exe under the core, and no conhost.exe there.', {
    $folder = "$tmp\project".Replace('\', '\\')
    $null = Js "(__ws.call('project.add', { id: __ws.uuid7(), folder: '$folder' }), 1)"
    $project = Soon "[...__ws.records.projects.values()].find(p => p.kind === 'folder')?.id ?? ''" '.'
    $null = Js "(__ws.show('$project'), __ws.command('new-terminal'), 1)"
    $terminal = Soon "[...__ws.records.terminals.values()].find(t => t.state === 'running')?.id ?? ''" '.'
    Check 5 'New Terminal starts a shell' ([bool]$terminal) "terminal $terminal"
    if (-not $terminal) { return }
    # The terminal's size: what the core keeps, what the page's screen has and what the console says, all the size
    # its pane has room for; and it was never another. (The first round's terminal was started two columns wide.)
    $sizes = "(e => JSON.stringify({ core: [__ws.records.terminals.get(e.id).cols, __ws.records.terminals.get(e.id).rows], screen: [e.term.cols, e.term.rows], room: (d => [d.cols, d.rows])(e.fit.proposeDimensions()) }))(__ws.engines.get(__ws.current().id))"
    Start-Sleep -Milliseconds 600
    $size = Js $sizes
    $at = ConvertFrom-Json $size
    $null = Js "(__ws.type('mode con'), 1)"
    $screen = Soon '__ws.text()' "(?m):\s+$($at.screen[0])\s*$"
    $said = @([regex]::Matches($screen, '(?m)^\s+\S[^:\n]*:\s+(\d+)\s*$') | ForEach-Object { $_.Groups[1].Value })
    Check 5 'the terminal has the size its pane has room for, and the console says the same' ("$($at.core)" -eq "$($at.screen)" -and "$($at.core)" -eq "$($at.room)" -and $at.core[0] -ge 20 -and $said.Count -ge 2 -and $said[1] -eq "$($at.core[0])" -and $said[0] -eq "$($at.core[1])") "$size; mode con: $($said[1]) columns, $($said[0]) lines"
    $first = ($screen -split "`n") | Where-Object { $_ } | Select-Object -First 4
    Check 5 'the first prompt is drawn once, on one line' (@($first | Where-Object { $_ -match '^[A-Z]:\\.*>' }).Count -ge 1 -and -not ($screen -match '(?m)^.{1,2}$\n^.{1,2}$\n^.{1,2}$')) (($first -join ' | '))
    # A sheet over the terminal, as a person meets it: the pane keeps its size and so does the terminal.
    $null = Js "(__ws.command('new-task'), 1)"
    $open = Soon 'String(!!__ws.ui.sheet)' 'true' 5
    Start-Sleep -Milliseconds 700
    $under = Js $sizes
    $null = Js "(__ws.dismiss(), 1)"
    Start-Sleep -Milliseconds 500
    $after = Js $sizes
    Check 5 'New Task opened over the terminal leaves its size alone, and so does closing it' ($open -eq 'true' -and $under -eq $size -and $after -eq $size) "under the sheet: $under; after it: $after"
    $null = Js "(__ws.type('cls'), 1)"
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
    $null = Js "(__ws.dismiss(), 1)"
}

$rows['10'] = 'In the same app, with its window in front and the pointer used on it (put back where it was afterwards): the window has no menu bar; the points where the page draws Minimize, Maximize and Close answer as those buttons, and the edges and a corner as places to resize by; hovering Maximize lights it and opens the Snap layouts; a click on it maximises and another puts the window back; a double click on the top row does the same; a right click there and Alt-Space open the window''s own menu; Alt alone and F10 open the app''s menu; Minimize minimises. Pictures of the window restored, maximised, and with another window in front.', {
    $null = Js "(__ws.show('home'), 1)"
    $front = Front $workspace
    Check 10 'the app''s window comes to the front' $front
    $scale = [Tasktap.Desk]::GetDpiForWindow($workspace) / 96
    Say 'INFO' 10 "the window's display is at $([int]($scale * 100)) %; $([Windows.Forms.Screen]::AllScreens.Count) display(s): $(([Windows.Forms.Screen]::AllScreens | ForEach-Object { "$($_.Bounds.Width) x $($_.Bounds.Height)" }) -join ', ')"
    Check 10 'the window has no menu bar of the system''s' (-not [Tasktap.Desk]::Menu($workspace))
    Start-Sleep -Milliseconds 500
    Say 'LOOK' 10 'the window restored: one dark surface to its edges, round corners, no light caption, frame or border' (Capture $workspace 'row10-restored' -Screen)
    # Where the page draws the three buttons (window.css .wbs: 46 wide each, in a top row 38 high), and the middle of
    # the top row, where nothing is pressed.
    $buttons = { $f = [Tasktap.Desk]::Frame($workspace); foreach ($i in 2, 1, 0) { , @(($f.Right - [int]((23 + 46 * $i) * $scale)), ($f.Top + [int](21 * $scale))) } }
    $bar = { $f = [Tasktap.Desk]::Frame($workspace); @([int]($f.Left + ($f.Right - $f.Left) * 0.55), ($f.Top + [int](21 * $scale))) }
    $hits = { (& $buttons | ForEach-Object { [Tasktap.Desk]::HitTest($_[0], $_[1]) }) -join ' ' }
    $said = & $hits
    Check 10 'where the page draws Minimize, Maximize and Close, the window answers as those buttons' ($said -eq '8 9 20') "hit tests: $said (8, 9 and 20 are the three)"
    $f = [Tasktap.Desk]::Frame($workspace)
    $middle = @([int](($f.Left + $f.Right) / 2), [int](($f.Top + $f.Bottom) / 2))
    $edges = @([Tasktap.Desk]::HitTest($middle[0], $f.Top + 1), [Tasktap.Desk]::HitTest($f.Left - 3, $middle[1]), [Tasktap.Desk]::HitTest($f.Right + 2, $middle[1]), [Tasktap.Desk]::HitTest($middle[0], $f.Bottom + 2), [Tasktap.Desk]::HitTest($f.Right + 2, $f.Bottom + 2)) -join ' '
    Check 10 'the top, left, right and bottom edges and the bottom right corner resize' ($edges -eq '12 10 11 15 17') "hit tests: $edges (12, 10, 11, 15 and 17 are those)"
    $pointer = [Tasktap.Desk+Point]::new()
    $null = [Tasktap.Desk]::GetCursorPos([ref]$pointer)
    $menus = { @([Tasktap.Desk]::Windows() | Where-Object { $_.Class -eq '#32768' }).Count }
    $escape = { [Tasktap.Desk]::Chord([byte[]](0x1B)); Start-Sleep -Milliseconds 300 }
    try {
        $max = (& $buttons)[1]
        $before = @([Tasktap.Desk]::Every() | ForEach-Object Handle)
        [Tasktap.Desk]::Point_($max[0] - 4, $max[1])
        Start-Sleep -Milliseconds 150
        [Tasktap.Desk]::Point_($max[0], $max[1])
        Start-Sleep -Milliseconds 1600
        $lit = Js "document.querySelector('.wb.maximize')?.className ?? 'no button'"
        Check 10 'the page lights Maximize under the pointer' ("$lit" -match 'over') "the button's classes: $lit"
        $new = @([Tasktap.Desk]::Every() | Where-Object { $_.Handle -notin $before })
        Check 10 'hovering Maximize opens the Snap layouts' ($new.Count -gt 0) "windows that appeared: $(($new | ForEach-Object { "$($_.Class) '$($_.Title)'" }) -join '; ')"
        Say 'LOOK' 10 'Maximize under the pointer, and the Snap layouts under it' (Capture $workspace 'row10-hover' -Screen)
        $away = & $bar
        [Tasktap.Desk]::Point_($away[0], $away[1])
        Start-Sleep -Milliseconds 900
        [Tasktap.Desk]::Press($max[0], $max[1], $false, 1)
        Start-Sleep -Milliseconds 1200
        Check 10 'a click on Maximize maximises the window' ([Tasktap.Desk]::IsZoomed($workspace))
        $away = & $bar
        [Tasktap.Desk]::Point_($away[0], $away[1])
        Start-Sleep -Milliseconds 600
        $said = & $hits
        Check 10 'maximised, the three buttons answer where the page draws them' ($said -eq '8 9 20') "hit tests: $said"
        Say 'LOOK' 10 'the window maximised: dark to the screen''s edges' (Capture $workspace 'row10-maximized' -Screen)
        $max = (& $buttons)[1]
        [Tasktap.Desk]::Press($max[0], $max[1], $false, 1)
        Start-Sleep -Milliseconds 1200
        Check 10 'a click on it again puts the window back' (-not [Tasktap.Desk]::IsZoomed($workspace))
        $at = & $bar
        [Tasktap.Desk]::Press($at[0], $at[1], $false, 2)
        Start-Sleep -Milliseconds 1200
        $zoomed = [Tasktap.Desk]::IsZoomed($workspace)
        $at = & $bar
        [Tasktap.Desk]::Press($at[0], $at[1], $false, 2)
        Start-Sleep -Milliseconds 1200
        Check 10 'a double click on the top row maximises the window, and another puts it back' ($zoomed -and -not [Tasktap.Desk]::IsZoomed($workspace)) "maximised after the first: $zoomed"
        $at = & $bar
        [Tasktap.Desk]::Press($at[0], $at[1], $true, 1)
        Start-Sleep -Milliseconds 700
        $opened = & $menus
        & $escape
        Check 10 'a right click on the top row opens the window''s own menu' ($opened -gt 0 -and (& $menus) -eq 0) "menus open: $opened"
        [Tasktap.Desk]::Chord([byte[]](0x12, 0x20))
        Start-Sleep -Milliseconds 700
        $opened = & $menus
        & $escape
        Check 10 'Alt-Space opens the window''s own menu' ($opened -gt 0 -and (& $menus) -eq 0) "menus open: $opened"
        foreach ($key in @('Alt alone', 0x12), @('F10', 0x79)) {
            $null = Js "(__ws.menu.items = [], 1)"
            [Tasktap.Desk]::Chord([byte[]]($key[1]))
            Start-Sleep -Milliseconds 900
            $opened = & $menus
            if ($key[1] -eq 0x12) { Say 'LOOK' 10 'the app''s menu open under its button: dark, each command with its Windows key' (Capture $workspace 'row10-menu' -Screen) }
            & $escape
            & $escape
            # (Asked once the menu is closed: the page answers nothing while a menu of the system's is open.)
            $items = Js "__ws.menu.items.map(i => i === '-' ? '-' : 'items' in i ? i.text + ' (' + i.items.filter(x => x !== '-').map(x => x.text + (x.key ? ' ' + x.key : '')).join(', ') + ')' : i.text).join('; ')"
            Check 10 "$($key[0]) opens the app's menu, and Escape closes it" ($opened -gt 0 -and "$items" -match 'File' -and (& $menus) -eq 0) "menus open: $opened; its items: $items"
        }
        # A browser's own keys do nothing: F5 and Ctrl+R would load the page anew, and what it holds would be gone.
        $null = Js "(window.__kept = 1, document.activeElement?.blur(), 1)"
        [Tasktap.Desk]::Chord([byte[]](0x74))
        Start-Sleep -Milliseconds 400
        [Tasktap.Desk]::Chord([byte[]](0x11, 0x52))
        Start-Sleep -Milliseconds 1500
        $kept = Soon 'typeof window.__kept' 'number' 8
        Check 10 'F5 and Ctrl+R do not load the page anew' ($kept -eq 'number') "what the page kept: $kept"
        $min = (& $buttons)[0]
        [Tasktap.Desk]::Press($min[0], $min[1], $false, 1)
        Start-Sleep -Milliseconds 900
        $gone = [Tasktap.Desk]::IsIconic($workspace)
        $null = [Tasktap.Desk]::ShowWindow($workspace, 9)
        Start-Sleep -Milliseconds 700
        Check 10 'a click on Minimize minimises the window' $gone
    } finally { $null = [Tasktap.Desk]::SetCursorPos($pointer.X, $pointer.Y) }
    # With another window in front: the app's window as one that is not in use.
    $marker = "Tasktap-desk-$PID-b"
    Set-Content "$tmp\$marker.txt" ''
    Start-Process notepad.exe -ArgumentList "$tmp\$marker.txt"
    $notepad = $null
    for ($i = 0; $i -lt 50 -and -not $notepad; $i++) { Start-Sleep -Milliseconds 200; $notepad = [Tasktap.Desk]::Windows() | Where-Object { $_.Title -like "*$marker*" } | Select-Object -First 1 }
    if ($notepad) {
        $null = Front $notepad.Handle
        Start-Sleep -Milliseconds 600
        Say 'LOOK' 10 'the window with another in front of it: as dark, its buttons quieter' (Capture $workspace 'row10-unfocused')
        [Tasktap.Desk]::Close($notepad.Handle)
        Start-Sleep -Milliseconds 500
    }
    $null = Front $workspace
}

$rows['11'] = 'In the same app: reads every key hint and tooltip in the workspace, on Home, in New Task and in each section of Settings, and expects none of the Mac''s signs; reads the folder in the header; saves a picture of each section of Settings.', {
    $mac = '[\u2318\u2325\u2303\u21E7\u238B\u232B]'
    $hints = "[...new Set([...document.querySelectorAll('kbd')].map(e => e.textContent).concat([...document.querySelectorAll('[title]')].map(e => e.getAttribute('title')).filter(t => /  /.test(t)).map(t => t.split('  ').pop())))].join(' | ')"
    $project = Js "[...__ws.records.projects.values()].find(p => p.kind === 'folder')?.id ?? ''"
    $read = [ordered]@{}
    $null = Js "(__ws.show('$project'), 1)"
    Start-Sleep -Milliseconds 600
    $read['a workspace'] = Js $hints
    $path = Js "document.querySelector('.crumb .path')?.textContent ?? ''"
    Check 11 'the folder in the header is a path a person knows' ("$path" -match '^[A-Z]:\\' -and "$path" -notmatch '\?') $path
    $null = Js "(__ws.show('home'), 1)"
    Start-Sleep -Milliseconds 600
    $read['Home'] = Js $hints
    $null = Js "(__ws.command('new-task'), 1)"
    Start-Sleep -Milliseconds 700
    $read['New Task'] = Js $hints
    $null = Js "(__ws.dismiss(), 1)"
    foreach ($section in 'thoughts', 'voice', 'agents', 'appearance', 'terminal', 'about') {
        $null = Js "(__ws.open({ kind: 'settings', at: '$section' }), 1)"
        Start-Sleep -Milliseconds 900
        $read["Settings, $section"] = Js $hints
        Say 'LOOK' 11 "Settings, $section" (Capture $workspace "row11-settings-$section")
    }
    $null = Js "(__ws.dismiss(), 1)"
    $wrong = @($read.Keys | Where-Object { "$($read[$_])" -match $mac })
    Check 11 'every key is named as Windows names it: none of the Mac''s signs anywhere' (-not $wrong -and $read['a workspace']) (($read.Keys | ForEach-Object { "${_}: $($read[$_])" }) -join ' ;; ')
}

$rows['12'] = 'In the same app: makes the window larger with the terminal in front and expects the terminal, the core and the console to agree on the larger size, then makes it as it was; lets the backdrop through the page for one picture of the screen inside the window''s edges, to say what Mica is behind it.', {
    $project = Js "[...__ws.records.projects.values()].find(p => p.kind === 'folder')?.id ?? ''"
    $null = Js "(__ws.show('$project'), 1)"
    Start-Sleep -Milliseconds 600
    $sizes = "(e => e ? JSON.stringify({ core: [__ws.records.terminals.get(e.id).cols, __ws.records.terminals.get(e.id).rows], screen: [e.term.cols, e.term.rows] }) : 'no terminal')(__ws.engines.get(__ws.current()?.id ?? ''))"
    $was = Js $sizes
    $rect = [Tasktap.Desk+Rect]::new()
    $null = [Tasktap.Desk]::GetWindowRect($workspace, [ref]$rect)
    $null = [Tasktap.Desk]::SetWindowPos($workspace, [IntPtr]::Zero, 0, 0, $rect.Right - $rect.Left + 240, $rect.Bottom - $rect.Top + 120, 0x16)
    Start-Sleep -Milliseconds 1200
    $now = Js $sizes
    $null = Js "(__ws.type('cls'), 1)"
    $null = Js "(__ws.type('mode con'), 1)"
    $at = ConvertFrom-Json $now
    $screen = Soon '__ws.text()' "(?m):\s+$($at.screen[0])\s*$"
    $said = @([regex]::Matches($screen, '(?m)^\s+\S[^:\n]*:\s+(\d+)\s*$') | ForEach-Object { $_.Groups[1].Value })
    $grew = (ConvertFrom-Json $was).screen[0] -lt $at.screen[0] -and (ConvertFrom-Json $was).screen[1] -lt $at.screen[1]
    Check 12 'a larger window gives the terminal more columns and rows, and the core and the console agree' ($grew -and "$($at.core)" -eq "$($at.screen)" -and $said.Count -ge 2 -and $said[1] -eq "$($at.screen[0])" -and $said[0] -eq "$($at.screen[1])") "before: $was; after: $now; mode con: $($said[1]) columns, $($said[0]) lines"
    Say 'LOOK' 12 'the larger window with its terminal: the prompt drawn once, no stray characters' (Capture $workspace 'row12-larger')
    $null = [Tasktap.Desk]::SetWindowPos($workspace, [IntPtr]::Zero, 0, 0, $rect.Right - $rect.Left, $rect.Bottom - $rect.Top, 0x16)
    Start-Sleep -Milliseconds 1200
    $back = Js $sizes
    Check 12 'made as it was, the terminal has its first size again' ($back -eq $was) "now: $back"
    $null = Js "(__ws.show('home'), document.documentElement.style.setProperty('--window-opacity', '0.35'), document.body.style.opacity = '0.35', 1)"
    $null = Front $workspace
    Start-Sleep -Milliseconds 900
    Say 'LOOK' 12 'the backdrop let through the page (the page at a third of its strength): what Mica is behind it' (Capture $workspace 'row12-backdrop' -Screen)
    $null = Js "(document.documentElement.style.removeProperty('--window-opacity'), document.body.style.opacity = '', 1)"
}

$rows['9'] = 'Nothing of its own: a folder given by TASKTAP_PICK becomes a workspace in rows 2 and 5; the folder panel is not built yet.', {
    Say 'SKIP' 9 'the folder panel is not built yet; TASKTAP_PICK is used in rows 2 and 5'
}

$rows['+'] = 'Beyond the checklist: asks taskkill''s and tasklist''s service (Windows Management Instrumentation) for this process, which it refuses the same account over SSH; tells the app with the debug channel to quit and times it, and looks for what it left running.', {
    $listed = & "$env:SystemRoot\System32\tasklist.exe" /FI "PID eq $PID" /NH 2>&1
    Say $(if ($LASTEXITCODE -eq 0) { 'PASS' } else { 'INFO' }) '+' 'the management service answers a standard account at the desktop' "tasklist exit ${LASTEXITCODE}: $("$listed".Trim())"
}

$rows['13'] = 'Starts the app once more with the system''s own title bar in the page''s colours (TASKTAP_CHROME=native), for one picture to set beside the app''s own top row as the title bar; then tells it to quit.', {
    if ($seen) { $seen | Set-Content "$Out\rows4-12-app.txt" }
    Start-App $exe @{ TASKTAP_DATA = "$tmp\data"; TASKTAP_PICK = "$tmp\project"; TASKTAP_CHROME = 'native' } 120
    $null = Until '"event":"ready"' 45
    $null = Soon 'typeof __ws' 'object'
    Send 'state'
    $state = Until '"event":"state"' 5
    $native = if ($state) { [IntPtr][long](ConvertFrom-Json $state).workspace } else { [IntPtr]::Zero }
    if ($native -eq [IntPtr]::Zero) { Say 'FAIL' 13 'the app with the system''s title bar shows no window'; return }
    Start-Sleep -Seconds 2
    $null = Front $native
    Start-Sleep -Milliseconds 500
    Say 'LOOK' 13 'the other way, for comparison: the system''s own title bar in the page''s colours, the app''s top row under it' (Capture $native 'row13-native' -Screen)
    Send 'call core.retire {"when":"now"}'
    $null = Until '"event":"reply"' 3
    Send 'quit'
    $null = $proc.WaitForExit(10000)
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
                # Rows 4, 5, 8, 10, 11 and 12 share one app, driven through its debug channel.
                Start-App $exe @{ TASKTAP_DATA = "$tmp\data"; TASKTAP_PICK = "$tmp\project" } 600
                $ready = Until '"event":"ready"' 45
                $page = Soon 'typeof __ws' 'object'
                Send 'state'
                $state = Until '"event":"state"' 5
                if ($state) { $workspace = [IntPtr][long](ConvertFrom-Json $state).workspace }
                Check 4 'the app starts with its debug channel and its page runs' ($ready -and $page -eq 'object' -and $workspace -ne [IntPtr]::Zero) "window $workspace"
            }
            if ($row -in '4', '5', '8', '10', '11', '12' -and ($proc.HasExited -or $workspace -eq [IntPtr]::Zero)) { Say 'FAIL' $row 'not run: the app of rows 4 to 12 is not running'; continue }
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
    if ($seen) { $seen | Set-Content "$Out\row13-app.txt" }
    Start-Sleep -Milliseconds 500
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    $lock.Dispose()
}
$said = @(Get-Content "$Out\results.txt")
Write-Host "$(@($said -match '^PASS').Count) passed, $(@($said -match '^FAIL').Count) failed, $(@($said -match '^LOOK').Count) pictures to look at; all of it is in $Out"
exit [int](@($said -match '^FAIL').Count -gt 0)
