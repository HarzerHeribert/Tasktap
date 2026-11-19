# The desktop round: the rows of README.md, "At the desktop", that need no person, run in
# order in the signed-in desktop of the test account, each with a PASS or FAIL and its evidence.
# desktop.sh builds the app, starts this there and fetches what it wrote:
#   <Out>\results.txt   one line per check
#   <Out>\*.png         the app's own window, where a picture is the evidence; *-screen.png is the screen inside
#                       the window's edges while it is in front (the frame, a menu, the backdrop as a person sees them)
#   <Out>\*.txt         what the smoke script, the credential test and the app printed (rows4-12-app.txt, row13-app.txt)
# -DryRun starts nothing and shows no window: it says what each row would do and checks that
# what the round needs is there. -Only 3:14 runs those rows alone (5, 8, 10, 11 and 12 need 4, whose app they share,
# and + after them, which ends it).
# The round makes no sound: for as long as it runs, this account's sounds for the system's events and its warning
# beep are off, and they are put back when it ends (a round that was cut short is put right by the next).
param(
    [string]$Out = "C:\tasktap\desktop-rounds\$(Get-Date -Format 'yyyyMMdd-HHmmss')",
    [string]$Target = $(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }),
    [string]$Only = '',
    # The checkout whose build is tried; this script's own unless it is run from somewhere else.
    [string]$Checkout = '',
    # The job that built the app starts the round and holds the checkout for it (host.ps1).
    [switch]$Locked,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$checkout = if ($Checkout) { $Checkout } else { Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
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
[StructLayout(LayoutKind.Sequential)] struct Header { public int Size, Width, Height; public short Planes, Bits; public int Compression, SizeImage, X, Y, Used, Important; }
[DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
[DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref Header info, uint usage, out IntPtr bits, IntPtr section, uint offset);
[DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr thing);
[DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr thing);
[DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
[DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr to, int x, int y, int w, int h, IntPtr from, int fx, int fy, uint how);
[DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
[DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
public static bool Drawn;
// A window as the system draws it for a program that asks, or the screen's own points from (sx, sy): w by h points
// of four bytes (blue, green, red and one unused), top row first, read straight from memory the system drew into.
public static byte[] Bits(IntPtr window, int w, int h, bool screen, int sx, int sy) {
    var info = new Header { Size = 40, Width = w, Height = -h, Planes = 1, Bits = 32 };
    IntPtr bits;
    var all = GetDC(IntPtr.Zero);
    var dc = CreateCompatibleDC(all);
    var picture = CreateDIBSection(dc, ref info, 0, out bits, IntPtr.Zero, 0);
    var old = SelectObject(dc, picture);
    Drawn = screen ? BitBlt(dc, 0, 0, w, h, all, sx, sy, 0x00CC0020) : PrintWindow(window, dc, 2);
    var bytes = new byte[w * h * 4];
    Marshal.Copy(bits, bytes, 0, bytes.Length);
    SelectObject(dc, old); DeleteObject(picture); DeleteDC(dc); ReleaseDC(IntPtr.Zero, all);
    return bytes;
}
// Points that are exactly black with no black point beside them: in the whole picture but a margin of 12 points
// (its round corners), and among those the ones in its foot.
public static int[] Specks(IntPtr scan, int stride, int width, int height) {
    var bytes = new byte[stride * height];
    Marshal.Copy(scan, bytes, 0, bytes.Length);
    Func<int, int, bool> black = (x, y) => { int i = y * stride + x * 4; return bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 0; };
    int all = 0, foot = 0;
    for (int y = 12; y < height - 12; y++) for (int x = 12; x < width - 12; x++) {
        if (!black(x, y)) continue;
        bool alone = true;
        for (int dy = -1; dy <= 1 && alone; dy++) for (int dx = -1; dx <= 1; dx++) if ((dx != 0 || dy != 0) && black(x + dx, y + dy)) { alone = false; break; }
        if (!alone) continue;
        all++;
        if (y > height * 0.55 && x < width * 0.6) foot++;
    }
    return new[] { all, foot };
}
[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint which);
[DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
[DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc each, IntPtr none);
[DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")] static extern IntPtr SendText(IntPtr window, uint message, IntPtr w, string text);
[DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")] static extern IntPtr ReadText(IntPtr window, uint message, IntPtr size, StringBuilder text);
// Every window inside a window, with what it says of itself (a field's text among it); Title of one that is not
// shown begins with "(hidden) ".
public static List<Window> Inside(IntPtr parent) {
    var all = new List<Window>();
    EnumChildWindows(parent, (window, none) => {
        var kind = new StringBuilder(256);
        GetClassName(window, kind, 256);
        var title = new StringBuilder(1024);
        ReadText(window, 0x000D, (IntPtr)1024, title);
        all.Add(new Window { Handle = window, Class = kind.ToString(), Title = (IsWindowVisible(window) ? "" : "(hidden) ") + title.ToString() });
        return true;
    }, IntPtr.Zero);
    return all;
}
// A field's text set as typing sets it, and a dialog's button pressed by its number (1 its default, 2 Cancel).
public static void SetText(IntPtr field, string text) { SendText(field, 0x000C, IntPtr.Zero, text); }
public static void Button(IntPtr dialog, int id) { PostMessage(dialog, 0x0111, (IntPtr)id, IntPtr.Zero); }
// Asks a window to close, as its close button does.
public static void Close(IntPtr window) { PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero); }
// Tells a window something without waiting for it, as the shell tells a window about its icon.
public static void Tell(IntPtr window, uint message, long w, long l) { PostMessage(window, message, (IntPtr)w, (IntPtr)l); }
[DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
// A window's extended styles: 0x8 above every window, 0x20 lets the pointer through, 0x80 no taskbar button and no
// place in Alt+Tab, 0x40000 a taskbar button, 0x80000 layered, 0x8000000 never activated by a click.
public static long Styles(IntPtr window) { return GetWindowLongPtr(window, -20).ToInt64(); }
[DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint which);
// The top-level window that has a point of the screen: the one a click there would reach.
public static IntPtr At(int x, int y) { return GetAncestor(WindowFromPoint(new Point { X = x, Y = y }), 2); }
[StructLayout(LayoutKind.Sequential)] struct IconId { public uint Size; public IntPtr Window; public uint Id; public Guid Item; }
[DllImport("shell32.dll")] static extern int Shell_NotifyIconGetRect(ref IconId id, out Rect where);
// Where the shell has an icon of the notification area, by the window and number it was added with; null when the
// shell has no such icon. An icon in the overflow has its place there.
public static int[] Icon(IntPtr window, uint id) {
    var which = new IconId { Size = (uint)Marshal.SizeOf(typeof(IconId)), Window = window, Id = id };
    Rect r;
    return Shell_NotifyIconGetRect(ref which, out r) == 0 ? new[] { r.Left, r.Top, r.Right, r.Bottom } : null;
}
// A top-level window of a process by its class, shown or not; zero when it has none.
public static IntPtr Find(string kind, uint process) {
    for (var window = FindWindowEx(IntPtr.Zero, IntPtr.Zero, kind, null); window != IntPtr.Zero; window = FindWindowEx(IntPtr.Zero, window, kind, null)) {
        uint its;
        GetWindowThreadProcessId(window, out its);
        if (its == process) return window;
    }
    return IntPtr.Zero;
}
// What a menu the system has open says, by its window (class #32768).
public static string[] Popup(IntPtr menuWindow) {
    var menu = SendMessage(menuWindow, 0x01E1, IntPtr.Zero, IntPtr.Zero);
    var names = new List<string>();
    for (int i = 0; menu != IntPtr.Zero && i < GetMenuItemCount(menu); i++) {
        var name = new StringBuilder(128);
        GetMenuString(menu, (uint)i, name, 128, 0x400);
        names.Add(name.Length > 0 ? name.ToString().Replace("&", "") : "-");
    }
    return names.ToArray();
}
[StructLayout(LayoutKind.Sequential)] struct Gui { public int Size, Flags; public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret; public Rect CaretRect; }
[DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref Gui info);
// The window that has the keyboard inside the window in front; zero when none has.
public static IntPtr Focus() {
    uint process;
    var info = new Gui { Size = Marshal.SizeOf(typeof(Gui)) };
    return GetGUIThreadInfo(GetWindowThreadProcessId(GetForegroundWindow(), out process), ref info) ? info.Focus : IntPtr.Zero;
}
[DllImport("user32.dll")] static extern bool SystemParametersInfo(uint what, uint value, ref int answer, uint how);
// The warning beep of this session, read and set; nothing is written to the account's settings.
public static bool Beep() { int on = 0; SystemParametersInfo(1, 0, ref on, 0); return on != 0; }
public static void Beep(bool on) { int none = 0; SystemParametersInfo(2, on ? 1u : 0u, ref none, 0); }
// What a picture's points are: how many are not black, how many colours there are (up to 64), and how many points
// say how see-through they are (a fourth byte that is neither 0 nor 255).
public static int[] Told(byte[] bits) {
    int lit = 0, partly = 0;
    var colours = new HashSet<int>();
    for (int i = 0; i + 3 < bits.Length; i += 4) {
        if (bits[i] != 0 || bits[i + 1] != 0 || bits[i + 2] != 0) lit++;
        if (bits[i + 3] != 0 && bits[i + 3] != 255) partly++;
        if (colours.Count < 64) colours.Add(bits[i] | bits[i + 1] << 8 | bits[i + 2] << 16);
    }
    return new[] { lit, colours.Count, partly };
}
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
# margins Windows keeps around it, which are cut off. It is drawn straight into memory of the system's own kind
# ([Tasktap.Desk]::Bits). Not through System.Drawing's Graphics: before that library lets the system draw into a
# picture it fills its scratch memory with one colour, rgb 13 11 12, and afterwards takes every point still in that
# colour for one that was not drawn, so each point a window really has in that colour came out as a hole. The page's
# faint light passes through that colour: the "dark points" of the first rounds were holes in their pictures and
# never on the screen. -Library takes the picture that old way, for the count that says so.
function Picture([IntPtr]$window, [switch]$Library) {
    $rect = [Tasktap.Desk+Rect]::new()
    $null = [Tasktap.Desk]::GetWindowRect($window, [ref]$rect)
    $frame = [Tasktap.Desk]::Frame($window)
    $w = [Math]::Max(1, $rect.Right - $rect.Left); $h = [Math]::Max(1, $rect.Bottom - $rect.Top)
    if ($Library) {
        $whole = [Drawing.Bitmap]::new($w, $h)
        $graphics = [Drawing.Graphics]::FromImage($whole)
        $dc = $graphics.GetHdc()
        $script:drawn = [Tasktap.Desk]::PrintWindow($window, $dc, 2)
        $graphics.ReleaseHdc($dc)
        $graphics.Dispose()
    } else {
        $whole = Bitmap-Of ([Tasktap.Desk]::Bits($window, $w, $h, $false, 0, 0)) $w $h
        $script:drawn = [Tasktap.Desk]::Drawn
    }
    $inner = [Drawing.Rectangle]::FromLTRB([Math]::Max(0, $frame.Left - $rect.Left), [Math]::Max(0, $frame.Top - $rect.Top), [Math]::Min($whole.Width, $frame.Right - $rect.Left), [Math]::Min($whole.Height, $frame.Bottom - $rect.Top))
    $bitmap = $whole.Clone($inner, [Drawing.Imaging.PixelFormat]::Format32bppRgb)
    $whole.Dispose()
    $bitmap
}
# A picture of the points [Tasktap.Desk]::Bits read: four bytes a point, no alpha.
function Bitmap-Of([byte[]]$bits, $w, $h) {
    $bitmap = [Drawing.Bitmap]::new($w, $h, [Drawing.Imaging.PixelFormat]::Format32bppRgb)
    $into = $bitmap.LockBits([Drawing.Rectangle]::new(0, 0, $w, $h), 'WriteOnly', 'Format32bppRgb')
    [Runtime.InteropServices.Marshal]::Copy($bits, 0, $into.Scan0, $bits.Length)
    $bitmap.UnlockBits($into)
    $bitmap
}
# Single black points in a picture: points that are exactly black with no black point beside them, counted in the
# whole picture and in its foot (below 55 % of its height, left of 60 % of its width: the foot of Home beside the
# sidebar and the sidebar's own foot, where the faint light is). A line, a letter or a corner is never one.
function Specks([Drawing.Bitmap]$bitmap) {
    $from = $bitmap.LockBits([Drawing.Rectangle]::new(0, 0, $bitmap.Width, $bitmap.Height), 'ReadOnly', 'Format32bppRgb')
    try { , [Tasktap.Desk]::Specks($from.Scan0, $from.Stride, $bitmap.Width, $bitmap.Height) } finally { $bitmap.UnlockBits($from) }
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
            $w = $frame.Right - $frame.Left; $h = $frame.Bottom - $frame.Top
            $shot = Bitmap-Of ([Tasktap.Desk]::Bits([IntPtr]::Zero, $w, $h, $true, $frame.Left, $frame.Top)) $w $h
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
# The page's answer once it is one: the page and the core need a moment after a command. `notch` asks the tab's page.
function Soon($expr, $want, $tries = 15, $page = 'workspace') {
    $got = $null
    for ($i = 0; $i -lt $tries; $i++) {
        $got = Js $expr 2 $page
        if ("$got" -match $want) { break }
        Start-Sleep -Milliseconds 400
    }
    "$got"
}
# What the app says of the tab: its window and where it is, the strip under it, whether Windows says to hide it,
# whether the pointer is being read, the displays as Windows reports them, and the icon.
function Tab {
    Send 'tab'
    $line = Until '"strip-pixels"' 5
    if ($line) { ConvertFrom-Json $line }
}
# The tab once it is as wanted: `$want` is asked of what Tab says, up to three seconds.
function Tab-Soon([scriptblock]$want) {
    $t = $null
    for ($i = 0; $i -lt 15; $i++) {
        $t = Tab
        if ($t -and (& $want $t)) { break }
        Start-Sleep -Milliseconds 200
    }
    $t
}
# The notch's own account of itself (the app's `state`): collapsed or open, whether it has the keyboard.
function Notch {
    Send 'state'
    $line = Until '"event":"state"' 5
    if ($line) { (ConvertFrom-Json $line).notch }
}
# The tab's own window into <Out>\<name>.png, as the system draws it for a program that asks, and into
# <Out>\<name>-screen.png as it stands on the screen: the screen's own points inside the window's edges, with whatever
# of the window behind shows through where the tab draws nothing. What the pictures hold is said with them: a
# picture with one colour is no picture.
function Tab-Picture([IntPtr]$window, $name) {
    $r = [Tasktap.Desk+Rect]::new()
    $null = [Tasktap.Desk]::GetWindowRect($window, [ref]$r)
    $w = [Math]::Max(1, $r.Right - $r.Left); $h = [Math]::Max(1, $r.Bottom - $r.Top)
    $bits = [Tasktap.Desk]::Bits($window, $w, $h, $false, 0, 0)
    $own = [Tasktap.Desk]::Told($bits)
    $picture = Bitmap-Of $bits $w $h
    $picture.Save("$Out\$name.png", [Drawing.Imaging.ImageFormat]::Png)
    $picture.Dispose()
    $bits = [Tasktap.Desk]::Bits([IntPtr]::Zero, $w, $h, $true, $r.Left, $r.Top)
    $shown = [Tasktap.Desk]::Told($bits)
    $picture = Bitmap-Of $bits $w $h
    $picture.Save("$Out\$name-screen.png", [Drawing.Imaging.ImageFormat]::Png)
    $picture.Dispose()
    "$name.png ($w x $h at $($r.Left),$($r.Top); $($own[0]) points not black, $($own[1]) colours, $($own[2]) partly see-through); as on the screen: $name-screen.png ($($shown[1]) colours)"
}
# The icon's menu, asked for as the shell asks for it after a right click on the icon: the app's helper window is
# told, with the icon's own place as the point. The menu's window, or nothing when none opens in two and a half
# seconds. (Windows keeps a new icon in the overflow, which no script can open without the pointer on the taskbar.)
function Icon-Menu([IntPtr]$helper, [uint32]$id, $process) {
    $where = [Tasktap.Desk]::Icon($helper, $id)
    if (-not $where) { return }
    $x = [int](($where[0] + $where[2]) / 2); $y = [int](($where[1] + $where[3]) / 2)
    [Tasktap.Desk]::Tell($helper, 0x8001, ($y -shl 16) -bor ($x -band 0xffff), ([int]$id -shl 16) -bor 0x7B)
    for ($i = 0; $i -lt 25; $i++) {
        Start-Sleep -Milliseconds 100
        $menu = [Tasktap.Desk]::Every() | Where-Object { $_.Class -eq '#32768' -and $_.ProcessId -eq $process.Id } | Select-Object -First 1
        if ($menu) { return $menu }
    }
}
# This account's sounds for the system's events, and its warning beep, off for as long as the round runs: a key
# no window takes, a dialog or an error must not be heard. What they were is kept in a file, so that a round that
# was cut short is put right by the next one.
$sounds = 'C:\tasktap\desktop-rounds\sounds-off.json'
function Sounds-Off {
    if (Test-Path $sounds) { Sounds-On }
    $was = [Collections.Generic.List[object]]::new()
    $apps = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('AppEvents\Schemes\Apps')
    foreach ($program in @(if ($apps) { $apps.GetSubKeyNames() })) {
        $its = $apps.OpenSubKey($program)
        foreach ($occasion in $its.GetSubKeyNames()) {
            $key = $its.OpenSubKey("$occasion\.Current", $true)
            if (-not $key) { continue }
            $value = $key.GetValue('', $null, 'DoNotExpandEnvironmentNames')
            if ($value) { $was.Add(@{ key = "AppEvents\Schemes\Apps\$program\$occasion\.Current"; value = "$value"; kind = "$($key.GetValueKind(''))" }) }
            $key.Dispose()
        }
    }
    ConvertTo-Json @{ beep = [Tasktap.Desk]::Beep(); sounds = $was.ToArray() } -Depth 4 | Set-Content $sounds
    foreach ($sound in $was) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sound.key, $true)
        $key.SetValue('', '', [Microsoft.Win32.RegistryValueKind]$sound.kind)
        $key.Dispose()
    }
    [Tasktap.Desk]::Beep($false)
    $was.Count
}
function Sounds-On {
    if (-not (Test-Path $sounds)) { return 0 }
    $was = Get-Content $sounds -Raw | ConvertFrom-Json
    foreach ($sound in @($was.sounds)) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sound.key, $true)
        if ($key) { $key.SetValue('', $sound.value, [Microsoft.Win32.RegistryValueKind]$sound.kind); $key.Dispose() }
    }
    [Tasktap.Desk]::Beep([bool]$was.beep)
    Remove-Item $sounds
    @($was.sounds).Count
}

$rows = [ordered]@{}

$rows['1'] = 'Starts the app as Explorer would, with no debug channel and its own data folder; waits for one visible window titled Tasktap and times it; reads the menu bar''s names; saves the window''s picture; looks for any new console window; lists the app''s core and web view processes; finds the tab''s window and the icon; closes the window as its close button does, after which the app must run on with its tab and its icon; opens the icon''s menu and chooses Quit, and times the app''s end; watches the core leave by itself (a minute) and ends it after 90 s if it has not.', {
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
    # The faint light at the foot of Home and of the sidebar, point by point; and the same window through the drawing
    # library, as the rounds before this check took their pictures.
    $picture = Picture $window.Handle; $specks = Specks $picture; $picture.Dispose()
    $picture = Picture $window.Handle -Library; $lost = Specks $picture; $picture.Dispose()
    Check 1 'the faint light is drawn whole: no single black point in the window''s picture' ($specks[0] -eq 0) "single black points: $($specks[0]), at the foot of Home and of the sidebar: $($specks[1]); the same window taken through System.Drawing has $($lost[0]) and $($lost[1]): holes of that library's making, wherever the window is rgb 13 11 12"
    $new = @([Tasktap.Desk]::Windows() | Where-Object { $_.Handle -notin $before -and $_.Handle -ne $window.Handle })
    $consoles = @($new | Where-Object { $_.Class -match 'ConsoleWindowClass|CASCADIA_HOSTING_WINDOW_CLASS' })
    Check 1 'no console window opens' (-not $consoles) "new windows besides the app's: $(($new | ForEach-Object { "$($_.Class) '$($_.Title)'" }) -join '; ')"
    $core = Under $data | Where-Object Name -eq 'tasktap'
    $views = Children $process 'msedgewebview2'
    Check 1 'the core and the web view run beside the app' ($core -and $views) "tasktap.exe: $(($core | ForEach-Object Path) -join ', '); msedgewebview2.exe under the app: $($views.Count)"
    Check 1 'its data is in %LOCALAPPDATA%\Tasktap Next' (Test-Path "$data\core.db") "$data\core.db"
    # The tab and the icon: the app is there without its window, as it is on a Mac with its notch.
    $tab = $null
    for ($i = 0; $i -lt 40 -and -not $tab; $i++) { Start-Sleep -Milliseconds 250; $tab = [Tasktap.Desk]::Every() | Where-Object { $_.ProcessId -eq $process.Id -and $_.Title -eq 'Tasktap tab' } | Select-Object -First 1 }
    $helper = [Tasktap.Desk]::Find('TASKTAP_SHELL', $process.Id)
    $icon = if ($helper -ne [IntPtr]::Zero) { [Tasktap.Desk]::Icon($helper, 1) }
    Check 1 'the tab hangs at the top edge and the icon is in the notification area' ($tab -and $icon) "the tab's window: $(if ($tab) { ([Tasktap.Desk]::Frame($tab.Handle) | ForEach-Object { "$($_.Left),$($_.Top) to $($_.Right),$($_.Bottom)" }) } else { 'none' }); the icon: $(if ($icon) { $icon -join ' ' } else { 'not there' })"
    [Tasktap.Desk]::Close($window.Handle)
    Start-Sleep -Seconds 3
    $shown = @([Tasktap.Desk]::Windows() | Where-Object { $_.ProcessId -eq $process.Id -and $_.Title -eq 'Tasktap' })
    $stays = -not $process.HasExited -and -not $shown -and $tab -and ([Tasktap.Desk]::Every() | Where-Object { $_.Handle -eq $tab.Handle })
    Check 1 'closing the window leaves the app running, with its tab and its icon' $stays "the window is gone: $(-not $shown); the app runs: $(-not $process.HasExited); the icon: $(if ($helper -ne [IntPtr]::Zero -and [Tasktap.Desk]::Icon($helper, 1)) { 'there' } else { 'gone' })"
    # Quit, in the icon's menu: its last line, chosen with the keys a person would use in a menu.
    $menu = if (-not $process.HasExited -and $helper -ne [IntPtr]::Zero) { Icon-Menu $helper 1 $process }
    $watch.Restart()
    if ($menu) {
        foreach ($key in 0x26, 0x0D) { [Tasktap.Desk]::Tell($menu.Handle, 0x0100, $key, 0); [Tasktap.Desk]::Tell($menu.Handle, 0x0101, $key, 0); Start-Sleep -Milliseconds 150 }
    }
    $ended = $process.WaitForExit(10000)
    Check 1 'Quit in the icon''s menu ends the app' ($menu -and $ended) $(if (-not $menu) { 'the menu did not open; this script ended the app' } elseif ($ended) { "gone after $([int]$watch.Elapsed.TotalMilliseconds) ms" } else { 'still running 10 s later; this script ended it' })
    if (-not $ended) { $process.Kill($true) }
    $stayed = @(Under $data | Where-Object Name -eq 'tasktap').Count -gt 0
    Check 1 'the core stays behind the app that quit' $stayed
    while ($watch.Elapsed.TotalSeconds -lt 90 -and (Under $data)) { Start-Sleep -Milliseconds 500 }
    $left = Under $data
    Check 1 'the core leaves by itself within a minute and a half' (-not $left) $(if ($left) { "still running, ended by this script: $(($left | ForEach-Object Name) -join ', ')" } else { "gone $([int]$watch.Elapsed.TotalSeconds) s after the app quit" })
    $left | Stop-Process -Force -ErrorAction SilentlyContinue
}

$rows['2'] = 'Runs host\scripts\smoke.ps1 against the built app and the fixture core: the app opens its window behind the others for a few seconds, a folder becomes a workspace, a terminal answers what is typed, the app quits when told and leaves nothing running.', {
    pwsh -NoProfile -File "$checkout\host\scripts\smoke.ps1" -Target $Target *> "$Out\row2-smoke.txt"
    $code = $LASTEXITCODE
    $said = @(Get-Content "$Out\row2-smoke.txt")
    $quit = $said | Where-Object { $_ -match 'the app quits when told|NOTE' }
    Check 2 'the smoke script: only PASS lines and all passed' ($code -eq 0 -and $said -contains 'all passed' -and -not ($said -match '^(FAIL|NOTE)')) "exit $code; $(@($said -match '^PASS').Count) PASS, $(@($said -match '^FAIL').Count) FAIL; $($quit -join '; '); row2-smoke.txt"
}

$rows['3'] = 'Starts the app on a data folder of its own. The tab''s window must hang centred from the top edge of the main display''s work area at the size the arithmetic gives for what Windows reports, above every window, with no taskbar button, never the window in front. Pictures of its own window, collapsed and open. With the script''s Notepad in front and the app''s window under the tab: a point beside the tab belongs to the window below and a click there reaches it; the pointer on the tab opens the sheet without taking the keyboard and leaving folds it (the pointer moves over the tab and the app''s window only and is put back); the capture key opens it with the caret in its field, what is typed lands there, Escape folds it and Notepad has the keyboard again, and so does a click elsewhere. The icon is in the notification area, its menu opens and says Open, Settings and Quit. The app''s own window over the whole display hides the tab; back in its frame the tab shows again. At rest nothing moves: processor time and context switches of the app and its web views over half a minute, with the tab and with it switched off.', {
    New-Item -ItemType Directory -Force "$tmp\data3", "$tmp\project3" | Out-Null
    $window = Start-Own @{ TASKTAP_DATA = "$tmp\data3"; TASKTAP_PICK = "$tmp\project3" } 420
    if ($window -eq [IntPtr]::Zero) { Say 'FAIL' 3 'the app shows no window'; End-Own 'row3-app.txt'; return }
    $made = @($seen | Where-Object { $_ -match '"made":' })[-1]
    if (-not $made) { $made = Until '"made":' 15 }
    $page = Soon 'typeof __records' 'object' 20 'notch'
    $t = Tab-Soon { param($t) $t.shown }
    Check 3 'the tab''s window is made after the workspace has drawn, with the notch''s own page in it, and is shown' ("$made" -match '"made":true' -and $page -eq 'object' -and $t.shown) "the app: $made; the page's records: $page; shown: $($t.shown)"
    if (-not $t -or -not $t.window) { End-Own 'row3-app.txt'; return }
    $tab = [IntPtr][long]$t.window
    # Where the arithmetic puts it, worked out here from what Windows reports of the main display.
    $screen = [Windows.Forms.Screen]::PrimaryScreen
    $scale = [Tasktap.Desk]::GetDpiForWindow($tab) / 96
    $bar = [Math]::Max(0, $screen.WorkingArea.Top - $screen.Bounds.Top)
    $wide = $screen.Bounds.Width / $scale; $high = ($screen.Bounds.Height - $bar) / $scale
    $large = $wide -ge 1920 -or ($wide -ge 1680 -and $high -ge 1000)
    $tw = if ($large) { 104 } else { 120 }; $th = if ($large) { 16 } else { 20 }
    $want = @([int][Math]::Round($screen.Bounds.Left + ($wide / 2 - ($tw + 128) / 2) * $scale), ($screen.Bounds.Top + $bar), [int][Math]::Round(($tw + 128) * $scale), [int][Math]::Round(($th + 40) * $scale))
    Check 3 'it hangs centred from the top edge of the work area, at the arithmetic''s place and size' (($t.pixels -join ' ') -eq ($want -join ' ')) "window (left top width height): $($t.pixels -join ' '); the arithmetic for a display of $($screen.Bounds.Width) x $($screen.Bounds.Height) at $([int]($scale * 100)) %, $bar pixels of taskbar at the top: $($want -join ' ') (the tab $tw x $th points, with room for its light around it)"
    $drawn = Js "(r => [r.x, r.y, r.width, r.height, devicePixelRatio].join(' '))(document.getElementById('tab').getBoundingClientRect())" 5 'notch'
    Check 3 'the page draws the tab at the Mac''s size for a display without a camera housing, centred in the window, a point of the page a point of the display' ($drawn -eq "64 0 $tw $th $scale") "the tab in its page (left top width height, pixels a point): $drawn"
    $styles = [Tasktap.Desk]::Styles($tab)
    $listed = @([Tasktap.Desk]::Windows() | Where-Object { $_.Handle -eq $tab })
    Check 3 'above every window, no taskbar button and no place in Alt+Tab, never activated by a click, and the pointer passes through it' (($styles -band 0x8) -and ($styles -band 0x80) -and -not ($styles -band 0x40000) -and ($styles -band 0x8000000) -and ($styles -band 0x20) -and $listed) ('extended styles 0x{0:x}: topmost {1}, tool window {2}, taskbar button {3}, never activated {4}, pointer passes {5}' -f $styles, [bool]($styles -band 0x8), [bool]($styles -band 0x80), [bool]($styles -band 0x40000), [bool]($styles -band 0x8000000), [bool]($styles -band 0x20))
    Check 3 'showing it took the keyboard from nobody' ([Tasktap.Desk]::GetForegroundWindow() -ne $tab -and -not (Notch).key) "the window in front is the tab: $([Tasktap.Desk]::GetForegroundWindow() -eq $tab)"
    # Two windows under the tab's window, as a person has them there: the app's own, dark, under its left margin, and
    # the script's Notepad, light, in front under the tab itself and the rest.
    $edge = $want[0] + [int](40 * $scale)
    $null = [Tasktap.Desk]::SetWindowPos($window, [IntPtr]::Zero, $edge - 940, $screen.Bounds.Top + $bar, 940, 700, 0x0014)
    $notepad = Other-Program "Tasktap-tab-$PID"
    if (-not $notepad) { Say 'FAIL' 3 'not run further: Notepad could not be put in front'; End-Own 'row3-app.txt'; return }
    $null = [Tasktap.Desk]::SetWindowPos($notepad.Handle, [IntPtr]::Zero, $edge + 4, $screen.Bounds.Top + $bar, 760, 440, 0x0014)
    Start-Sleep -Milliseconds 600
    Say 'LOOK' 3 'the tab collapsed, with nothing running: its own window, and as it stands on the screen over the app''s window and Notepad' (Tab-Picture $tab 'row3-tab-collapsed')
    $was = [Tasktap.Desk+Point]::new()
    $null = [Tasktap.Desk]::GetCursorPos([ref]$was)
    try {
        # Beside the tab, inside its window: the window below has the point, and a click reaches it.
        $cx = $want[0] + [int]($want[2] / 2); $beside = $want[0] + [int](12 * $scale); $below = $want[1] + [int](($th + 14) * $scale)
        $at = @([Tasktap.Desk]::At($beside, $want[1] + 4), [Tasktap.Desk]::At($cx, $below), [Tasktap.Desk]::At($cx, $want[1] + 4))
        Check 3 'beside the tab and under it, inside the tab''s window, a point belongs to the window below; on the tab it does not' ($at[0] -eq $window -and $at[1] -eq $notepad.Handle -and $at[2] -ne $window -and $at[2] -ne $notepad.Handle) "left of the tab: $(if ($at[0] -eq $window) { 'the app''s window below' } else { "window $($at[0])" }); under it: $(if ($at[1] -eq $notepad.Handle) { 'Notepad below' } else { "window $($at[1])" }); on it: $(if ($at[2] -eq [IntPtr][long]$t.strip) { 'the strip under the tab' } elseif ($at[2] -eq $tab) { 'the tab' } else { "window $($at[2])" })"
        [Tasktap.Desk]::Press($beside, $want[1] + 4, $false, 1)
        $reached = $false
        for ($i = 0; $i -lt 15 -and -not $reached; $i++) { Start-Sleep -Milliseconds 100; $reached = [Tasktap.Desk]::GetForegroundWindow() -eq $window }
        Check 3 'a click beside the tab reaches the window below: it comes in front' $reached "Notepad was in front; in front after the click: $(if ($reached) { 'the app''s window' } else { [Tasktap.Desk]::GetForegroundWindow() })"
        $null = Front $notepad.Handle
        # The pointer on the tab: the sheet opens, and nobody loses the keyboard.
        [Tasktap.Desk]::Point_($cx, $want[1] + 6)
        $open = Tab-Soon { param($t) $t.pixels[3] -gt $want[3] -and $t.watching }
        $state = Notch
        $body = Soon "String(document.body.classList.contains('open'))" 'true' 8 'notch'
        Check 3 'the pointer on the tab opens the sheet, and Notepad keeps the keyboard' ($body -eq 'true' -and -not $state.collapsed -and -not $state.key -and [Tasktap.Desk]::GetForegroundWindow() -eq $notepad.Handle) "the page open: $body; the window: $($open.pixels -join ' '); it has the keyboard: $($state.key); Notepad in front: $([Tasktap.Desk]::GetForegroundWindow() -eq $notepad.Handle); the pointer is read: $($open.watching)"
        Start-Sleep -Milliseconds 700
        Say 'LOOK' 3 'the sheet open under the pointer' (Tab-Picture $tab 'row3-tab-open')
        # Away, over the app's own window: it folds, and the reading of the pointer ends.
        [Tasktap.Desk]::Point_($edge - 400, $want[1] + 400)
        $folded = Tab-Soon { param($t) ($t.pixels -join ' ') -eq ($want -join ' ') -and -not $t.watching }
        Check 3 'the pointer away from it folds it, the window is the tab''s again and the pointer is no longer read' (($folded.pixels -join ' ') -eq ($want -join ' ') -and -not $folded.watching -and (Notch).collapsed) "the window: $($folded.pixels -join ' '); the pointer is read: $($folded.watching)"
        # The capture key from Notepad.
        $null = Front $notepad.Handle
        [Tasktap.Desk]::Chord([byte[]](0x12, 0x10, 0x20))
        $front = $false
        for ($i = 0; $i -lt 30 -and -not $front; $i++) { Start-Sleep -Milliseconds 100; $front = [Tasktap.Desk]::GetForegroundWindow() -eq $tab }
        $caret = Soon "document.activeElement?.id ?? ''" 'capture-input' 10 'notch'
        $words = 'Typed into the tab'
        if ($front) { [Windows.Forms.SendKeys]::SendWait($words) }
        $typed = Soon "document.activeElement?.value ?? ''" ([regex]::Escape($words)) 8 'notch'
        Check 3 'Alt-Shift-Space over Notepad opens the sheet with the caret in its field, and what is typed next is there' ($front -and $caret -eq 'capture-input' -and $typed -eq $words) "the tab in front: $front; the caret in: $caret; the field holds: $typed; the workspace window stayed where it was: $([Tasktap.Desk]::GetForegroundWindow() -ne $window)"
        Start-Sleep -Milliseconds 500
        Say 'LOOK' 3 'the sheet opened by the key, a thought typed' (Tab-Picture $tab 'row3-tab-capture')
        if ($front) { [Windows.Forms.SendKeys]::SendWait('{ESC}') }
        $back = $false
        for ($i = 0; $i -lt 20 -and -not $back; $i++) { Start-Sleep -Milliseconds 100; $back = [Tasktap.Desk]::GetForegroundWindow() -eq $notepad.Handle }
        $keys = [Tasktap.Desk]::Focus()
        Check 3 'Escape folds it and Notepad has the keyboard again' ($back -and $keys -ne [IntPtr]::Zero -and (Notch).collapsed) "Notepad in front: $back; the keyboard is in its window $keys; the tab collapsed: $((Notch).collapsed)"
        # Once more, and a click elsewhere: on the app's own window.
        [Tasktap.Desk]::Chord([byte[]](0x12, 0x10, 0x20))
        $front = $false
        for ($i = 0; $i -lt 30 -and -not $front; $i++) { Start-Sleep -Milliseconds 100; $front = [Tasktap.Desk]::GetForegroundWindow() -eq $tab }
        Start-Sleep -Milliseconds 400
        [Tasktap.Desk]::Press($edge - 400, $want[1] + 400, $false, 1)
        $gone = Tab-Soon { param($t) ($t.pixels -join ' ') -eq ($want -join ' ') }
        Check 3 'a click elsewhere folds a sheet the key opened, and the keyboard is where the click was' ($front -and (Notch).collapsed -and [Tasktap.Desk]::GetForegroundWindow() -eq $window) "opened by the key: $front; collapsed after the click: $((Notch).collapsed); in front: $(if ([Tasktap.Desk]::GetForegroundWindow() -eq $window) { 'the app''s window, which was clicked' } else { [Tasktap.Desk]::GetForegroundWindow() })"
        $kept = Js "document.querySelector('#capture-input')?.value ?? ''" 3 'notch'
        Say 'INFO' 3 "what was typed stays for the next time the sheet opens: '$kept'"
    } finally {
        $null = [Tasktap.Desk]::SetCursorPos($was.X, $was.Y)
    }
    # The icon in the notification area, as the shell has it, and its menu, as the shell asks for it.
    $t = Tab
    $where = [Tasktap.Desk]::Icon([IntPtr][long]$t.icon.window, [uint32]$t.icon.id)
    Check 3 'the icon is in the notification area' ($t.icon.added -and $where) "the shell has it at $(if ($where) { $where -join ' ' } else { 'no place' }) (in the overflow until a person drags it out); it shows $($t.icon.waits), for a $(if ($t.icon.light) { 'light' } else { 'dark' }) taskbar, and says '$($t.icon.says)'"
    if ($where) {
        $x = [int](($where[0] + $where[2]) / 2); $y = [int](($where[1] + $where[3]) / 2)
        [Tasktap.Desk]::Tell([IntPtr][long]$t.helper, 0x8001, ($y -shl 16) -bor ($x -band 0xffff), (1 -shl 16) -bor 0x7B)
        $menu = $null
        for ($i = 0; $i -lt 25 -and -not $menu; $i++) { Start-Sleep -Milliseconds 100; $menu = [Tasktap.Desk]::Every() | Where-Object { $_.Class -eq '#32768' -and $_.ProcessId -eq $proc.Id } | Select-Object -First 1 }
        $items = if ($menu) { [Tasktap.Desk]::Popup($menu.Handle) -join ', ' } else { '' }
        Check 3 'a right click on the icon opens a menu of the system''s: Open Tasktap, Settings, Quit Tasktap' ($items -eq 'Open Tasktap, Settings, -, Quit Tasktap') "the menu: $(if ($items) { $items } else { 'none opened' })"
        if ($menu) {
            # (The system fades a menu in.)
            Start-Sleep -Milliseconds 500
            $r = [Tasktap.Desk+Rect]::new()
            $null = [Tasktap.Desk]::GetWindowRect($menu.Handle, [ref]$r)
            $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
            $shot = Bitmap-Of ([Tasktap.Desk]::Bits([IntPtr]::Zero, $w, $h, $true, $r.Left, $r.Top)) $w $h
            $shot.Save("$Out\row3-icon-menu-screen.png", [Drawing.Imaging.ImageFormat]::Png)
            $shot.Dispose()
            Say 'LOOK' 3 'the icon''s menu as it stands on the screen' "row3-icon-menu-screen.png ($w x $h at $($r.Left),$($r.Top))"
            # Closed as a click elsewhere closes it, with nothing chosen.
            [Tasktap.Desk]::Tell([IntPtr][long]$t.helper, 0x001F, 0, 0)
            $closed = $false
            for ($i = 0; $i -lt 20 -and -not $closed; $i++) { Start-Sleep -Milliseconds 100; $closed = -not ([Tasktap.Desk]::Every() | Where-Object { $_.Class -eq '#32768' -and $_.ProcessId -eq $proc.Id }) }
            Check 3 'the menu closes with nothing chosen, and the app runs on' ($closed -and -not $proc.HasExited) "closed: $closed"
        }
    }
    # A click on the icon, as the shell tells of one: the sheet opens. (Whether it also gets the keyboard is the
    # system's to say: it gives it after a real click on the icon, and may not after this telling.)
    if ($where) {
        [Tasktap.Desk]::Tell([IntPtr][long]$t.helper, 0x8001, ($y -shl 16) -bor ($x -band 0xffff), (1 -shl 16) -bor 0x400)
        $body = Soon "String(document.body.classList.contains('open')) + ' ' + (document.activeElement?.id ?? '')" 'true capture-input' 10 'notch'
        $keyed = [Tasktap.Desk]::GetForegroundWindow() -eq $tab
        Check 3 'a click on the icon opens the sheet with its field ready' ($body -eq 'true capture-input') "the page open and where its caret is: $body; the tab got the keyboard: $keyed"
        if ($keyed) { [Windows.Forms.SendKeys]::SendWait('{ESC}') } else { Send 'key notch Escape' }
        $null = Tab-Soon { param($t) -not $t.watching -and $t.pixels[3] -lt 120 }
        Check 3 'and it folds again' ([bool](Notch).collapsed) "collapsed: $((Notch).collapsed)"
    }
    # A window over the whole display: the app's own.
    $null = Front $window
    Send 'fullscreen on'
    $hidden = Tab-Soon { param($t) -not $t.shown }
    Check 3 'the tab hides while a window fills the whole display' (-not $hidden.shown -and $hidden.hidden) "the tab shown: $($hidden.shown); Windows says to hide: $($hidden.hidden)"
    Send 'fullscreen off'
    $shown = Tab-Soon { param($t) $t.shown }
    Check 3 'and shows again when it no longer does' ($shown.shown -and -not $shown.hidden) "the tab shown: $($shown.shown)"
    [Tasktap.Desk]::Close($notepad.Handle)
    # At rest. The app's own processes and the web views under it: processor time and how often the system let
    # their threads run, over half a minute with the tab collapsed and again with the tab switched off.
    if (-not (Notch).collapsed) { Send 'key notch Escape'; $null = Tab-Soon { param($t) -not $t.watching } }
    Say 'INFO' 3 "before the measure the tab is collapsed: $((Notch).collapsed); the pointer is read: $((Tab).watching)"
    $measure = {
        $ids = @($proc.Id) + @((Children $proc 'msedgewebview2') | ForEach-Object { $_.Id; (Children $_ 'msedgewebview2').Id })
        $running = @($ids | Where-Object { $_ } | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        # Every thread's count of the times the system let it run, asked for once and read for these processes.
        $switches = $null; $watch = [Diagnostics.Stopwatch]::StartNew()
        try { $switches = (@(Get-CimInstance Win32_PerfRawData_PerfProc_Thread -Property IDProcess, ContextSwitchesPersec -ErrorAction Stop | Where-Object { $_.IDProcess -in $running.Id }) | Measure-Object ContextSwitchesPersec -Sum).Sum } catch { }
        @{ cpu = ($running | ForEach-Object { $_.Refresh(); $_.TotalProcessorTime.TotalMilliseconds } | Measure-Object -Sum).Sum; switches = $switches; memory = ($running | Measure-Object PrivateMemorySize64 -Sum).Sum; processes = $running.Count; at = [DateTime]::UtcNow; took = $watch.Elapsed.TotalSeconds }
    }
    $rest = {
        param($seconds)
        Start-Sleep -Seconds 5
        $a = & $measure; $before = Tab
        Start-Sleep -Seconds $seconds
        $b = & $measure; $after = Tab
        $over = ($b.at - $a.at).TotalSeconds
        @{ cpu = [int]($b.cpu - $a.cpu); over = [int]$over; switches = if ($null -ne $a.switches -and $null -ne $b.switches) { [Math]::Round(($b.switches - $a.switches) / $over, 1) }; memory = [int]($b.memory / 1MB); processes = $b.processes; moved = ($before.pixels -join ' ') -ne ($after.pixels -join ' ') -or $after.watching }
    }
    $with = & $rest 30
    Send 'tab off'
    $null = Until '"event":"tab","set"' 5
    Start-Sleep -Seconds 3
    $without = & $rest 30
    Send 'tab main'
    $null = Until '"event":"tab","set"' 5
    $again = Tab-Soon { param($t) $t.shown }
    Check 3 'at rest nothing moves: the tab''s window stays, the pointer is not read, and the app with the tab uses no more processor time than without it' (-not $with.moved -and $with.cpu -le $without.cpu + 150) "collapsed, over $($with.over) s: $($with.cpu) ms of processor time in $($with.processes) processes$(if ($null -ne $with.switches) { ", $($with.switches) context switches a second" }), $($with.memory) MB of their own; with the tab switched off, over $($without.over) s: $($without.cpu) ms in $($without.processes) processes$(if ($null -ne $without.switches) { ", $($without.switches) a second" }), $($without.memory) MB"
    Check 3 'switched off the tab is gone, and switched on it is back where it was' ($again.shown -and ($again.pixels -join ' ') -eq ($want -join ' ')) "back: $($again.pixels -join ' ')"
    End-Own 'row3-app.txt'
    Start-Sleep -Milliseconds 500
    $left = Under $tmp
    Check 3 'the app leaves nothing running' (-not $left) (($left | ForEach-Object Name) -join ', ')
    $left | Stop-Process -Force -ErrorAction SilentlyContinue
}

$rows['4'] = 'Starts the app with its debug channel on a data folder of its own (it stays up for rows 5 and 8). Reads the capture-key event: the default must register and be Alt-Shift-Space. Has the page change the key to Control-Alt-T and back to the default through host.capture_key. Opens Notepad in front, presses Alt-Shift-Space as the keyboard would, and expects the tab''s sheet in front with the caret in its field and the Tasktap window where it was; Escape must give Notepad the keyboard back. Presses the key with Home in front: the caret must be in Home''s own field and nothing open over it. Switches the tab off and presses the key over Notepad: the Tasktap window must come forward with the caret in Home''s field.', {
    $said = @($seen | Where-Object { $_ -match '"event":"capture-key"' })[-1]
    if (-not $said) { $said = Until '"event":"capture-key"' 10 }
    $default = "$said" -match '"ok":true' -and "$said" -match '"alt":true' -and "$said" -match '"shift":true' -and "$said" -match '"control":false' -and "$said" -match '"code":"Space"'
    Check 4 'the default capture key registers and is Alt-Shift-Space, not Control-Alt' $default $said
    $other = Js "__ws.call('host.capture_key', { key: { control: true, alt: true, shift: false, meta: false, code: 'KeyT' } }).then(JSON.stringify, e => 'refused: ' + (e.message ?? e))"
    Check 4 'a Control-Alt key registers when asked for' ("$other" -match '"code":"KeyT"') $other
    $back = Js "__ws.call('host.capture_key', { key: null }).then(JSON.stringify, e => 'refused: ' + (e.message ?? e))"
    Check 4 'the default registers again when the preference is cleared' ("$back" -match '"code":"Space"' -and "$back" -match '"shift":true') $back
    $place = Js "__ws.call('host.tab', {}).then(JSON.stringify, e => 'refused: ' + (e.message ?? e))"
    Check 4 'the page is told where the tab hangs and which displays there are (Settings, Thoughts)' ("$place" -match '"display":"main"' -and "$place" -match '"primary":true') $place
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
        $t = Tab-Soon { param($t) $t.shown }
        $tab = [IntPtr][long]$t.window
        [Tasktap.Desk]::Chord([byte[]](0x12, 0x10, 0x20))
        $front = $false
        for ($i = 0; $i -lt 30 -and -not $front; $i++) { Start-Sleep -Milliseconds 100; $front = [Tasktap.Desk]::GetForegroundWindow() -eq $tab }
        $caret = Soon "document.activeElement?.id ?? ''" 'capture-input' 10 'notch'
        Check 4 'Alt-Shift-Space pressed over Notepad opens the tab''s sheet with the caret in its field, and the Tasktap window stays where it is' ($front -and $caret -eq 'capture-input' -and "$(Js 'String(!!__ws.ui.sheet)' 3)" -eq 'false' -and [Tasktap.Desk]::GetForegroundWindow() -ne $workspace) "the tab in front: $front; the caret is in: $caret; a sheet in the window: $(Js 'String(!!__ws.ui.sheet)' 3)"
        Start-Sleep -Milliseconds 500
        Say 'LOOK' 4 'the tab''s sheet open over another program, the caret in its field' (Tab-Picture $tab 'row4-shortcut')
        if ($front) { [Windows.Forms.SendKeys]::SendWait('{ESC}') }
        $back = $false
        for ($i = 0; $i -lt 20 -and -not $back; $i++) { Start-Sleep -Milliseconds 100; $back = [Tasktap.Desk]::GetForegroundWindow() -eq $notepad.Handle }
        Check 4 'Escape folds it and Notepad is in front again' $back "Notepad in front: $back"
        # The key with Home in front: Home has a field for a thought already, so the caret goes there.
        $null = Front $workspace
        $null = Js "(document.activeElement?.blur(), 1)"
        [Tasktap.Desk]::Chord([byte[]](0x12, 0x10, 0x20))
        $onHome = Soon "[__ws.ui.view, document.activeElement?.id, !!document.activeElement?.closest('.hx'), !!__ws.ui.sheet].join(' ')" 'home capture-input true false' 10
        Start-Sleep -Milliseconds 400
        Check 4 'pressed with Home in front, the key puts the caret in Home''s own field: no sheet opens over it and the tab stays folded' ($onHome -eq 'home capture-input true false' -and (Notch).collapsed -and [Tasktap.Desk]::GetForegroundWindow() -eq $workspace) "the view, where the caret is, whether that is Home's, whether a sheet is open: $onHome; the tab collapsed: $((Notch).collapsed)"
        Say 'LOOK' 4 'Home after the key: the caret in its own field, nothing over it' (Capture $workspace 'row4-home')
        # With the tab switched off the key brings the window forward, as before the tab: to Home's field while Home
        # shows.
        Send 'tab off'
        $null = Until '"event":"tab","set"' 5
        $null = Js "(document.activeElement?.blur(), 1)"
        $null = Front $notepad.Handle
        [Tasktap.Desk]::Chord([byte[]](0x12, 0x10, 0x20))
        $front = $false
        for ($i = 0; $i -lt 30 -and -not $front; $i++) { Start-Sleep -Milliseconds 100; $front = [Tasktap.Desk]::GetForegroundWindow() -eq $workspace }
        $onHome = Soon "[__ws.ui.view, document.activeElement?.id, !!__ws.ui.sheet].join(' ')" 'home capture-input false' 10
        Check 4 'with the tab switched off the key brings the Tasktap window forward, the caret in Home''s field' ($front -and $onHome -eq 'home capture-input false') "the window in front: $front; the view, where the caret is, whether a sheet is open: $onHome"
        Send 'tab main'
        $null = Until '"event":"tab","set"' 5
        $null = Tab-Soon { param($t) $t.shown }
    }
    [Tasktap.Desk]::Close($notepad.Handle)
    # Nothing is open: the rows after this one start where a person would.
    $null = Js "(__ws.dismiss(), 1)"
    $closed = Soon 'String(!__ws.ui.sheet)' 'true' 5
    Check 4 'no sheet is left open' ($closed -eq 'true') "no sheet open: $closed"
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


$rows['+'] = 'Beyond the checklist: asks taskkill''s and tasklist''s service (Windows Management Instrumentation) for this process, which it refuses the same account over SSH; tells the app with the debug channel to quit and times it, and looks for what it left running.', {
    $listed = & "$env:SystemRoot\System32\tasklist.exe" /FI "PID eq $PID" /NH 2>&1
    Say $(if ($LASTEXITCODE -eq 0) { 'PASS' } else { 'INFO' }) '+' 'the management service answers a standard account at the desktop' "tasklist exit ${LASTEXITCODE}: $("$listed".Trim())"
}

# An app of a row's own, started with its debug channel: its window once its page runs, or nothing.
function Start-Own($environment, $seconds) {
    Start-App $exe $environment $seconds
    $null = Until '"event":"ready"' 45
    $null = Soon 'typeof __ws' 'object'
    Send 'state'
    $state = Until '"event":"state"' 5
    if ($state) { [IntPtr][long](ConvertFrom-Json $state).workspace } else { [IntPtr]::Zero }
}
# The row's app told to quit, and what it said kept.
function End-Own($name) {
    if ($proc -and -not $proc.HasExited) {
        Send 'call core.retire {"when":"now"}'
        $null = Until '"event":"reply"' 3
        Send 'quit'
        if (-not $proc.WaitForExit(10000)) { $proc.Kill($true) }
    }
    $line = $null
    while ($lines.TryDequeue([ref]$line)) { $seen.Add($line) }
    if ($seen) { $seen | Set-Content "$Out\$name" }
}
# Notepad in front with a file of the round's own, as another program a person is in; nothing when it cannot be.
function Other-Program($marker) {
    Set-Content "$tmp\$marker.txt" ''
    Start-Process notepad.exe -ArgumentList "$tmp\$marker.txt"
    $notepad = $null
    for ($i = 0; $i -lt 50 -and -not $notepad; $i++) {
        Start-Sleep -Milliseconds 200
        $notepad = [Tasktap.Desk]::Windows() | Where-Object { $_.Title -like "*$marker*" } | Select-Object -First 1
    }
    if ($notepad -and (Front $notepad.Handle)) { $notepad }
}

$rows['9'] = 'Starts the app with no folder named for it. With its window in front presses Ctrl+Shift+O and Return, as a person opens a folder: the system''s folder dialog must appear, owned by the app''s window and modal to it; saves the screen''s points inside the dialog; presses its Cancel, after which the page has no workspace, says no failure and has the keyboard again. Opens it once more, puts a folder''s path into its field and presses its button: that folder becomes a workspace, kept as the person wrote it.', {
    New-Item -ItemType Directory -Force "$tmp\data9", "$tmp\chosen folder" | Out-Null
    $window = Start-Own @{ TASKTAP_DATA = "$tmp\data9" } 180
    if ($window -eq [IntPtr]::Zero) { Say 'FAIL' 9 'the app shows no window'; End-Own 'row9-app.txt'; return }
    Start-Sleep -Seconds 2
    # Open Workspace by its key and the sheet's Return, with real keys; then the dialog, a window of the app's process.
    function Ask-Folder {
        if (-not (Front $window)) { return }
        [Tasktap.Desk]::Chord([byte[]](0x11, 0x10, 0x4F))
        $sheet = Soon "document.querySelector('.sheet')?.innerText ?? ''" 'Choose a folder' 10
        [Tasktap.Desk]::Chord([byte[]](0x0D))
        for ($i = 0; $i -lt 50; $i++) {
            Start-Sleep -Milliseconds 200
            $dialog = [Tasktap.Desk]::Windows() | Where-Object { $_.ProcessId -eq $proc.Id -and $_.Class -eq '#32770' } | Select-Object -First 1
            if ($dialog) { Start-Sleep -Milliseconds 1200; return $dialog }
        }
    }
    function Gone($dialog, $tries = 40) {
        for ($i = 0; $i -lt $tries; $i++) {
            if (-not ([Tasktap.Desk]::Windows() | Where-Object { $_.Handle -eq $dialog.Handle })) { return $true }
            Start-Sleep -Milliseconds 150
        }
        $false
    }
    $dialog = Ask-Folder
    Check 9 'Ctrl+Shift+O and Return open the system''s own folder dialog' ($null -ne $dialog) "its title: $($dialog.Title)"
    if (-not $dialog) { End-Own 'row9-app.txt'; return }
    $owner = [Tasktap.Desk]::GetWindow($dialog.Handle, 4)
    $takes = [Tasktap.Desk]::IsWindowEnabled($window)
    Check 9 'the dialog belongs to the app''s window and is modal to it' ($owner -eq $window -and -not $takes) "its owner is the app's window: $($owner -eq $window); the window takes input meanwhile: $takes"
    $inside = [Tasktap.Desk]::Inside($dialog.Handle)
    $at = ($inside | Where-Object { $_.Class -eq 'ToolbarWindow32' -and $_.Title -like 'Address: *' } | Select-Object -First 1).Title
    Say 'INFO' 9 "where the dialog starts: $at (the first time the person's own folder, $env:USERPROFILE; afterwards where Windows keeps for this dialog)"
    $frame = [Tasktap.Desk]::Frame($dialog.Handle)
    if ([Tasktap.Desk]::GetForegroundWindow() -eq $dialog.Handle) {
        $w = $frame.Right - $frame.Left; $h = $frame.Bottom - $frame.Top
        $shot = Bitmap-Of ([Tasktap.Desk]::Bits([IntPtr]::Zero, $w, $h, $true, $frame.Left, $frame.Top)) $w $h
        $shot.Save("$Out\row9-dialog-screen.png", [Drawing.Imaging.ImageFormat]::Png); $shot.Dispose()
        Say 'LOOK' 9 'the folder dialog over the app''s window: the system''s own, in the system''s own colours (light where Windows is set to light, whatever the app is)' "row9-dialog-screen.png ($w x $h): the screen's points inside the dialog's edges"
    } else { Say 'INFO' 9 'no picture of the dialog: it was not the window in front' }
    [Tasktap.Desk]::Button($dialog.Handle, 2)
    $closed = Gone $dialog
    Start-Sleep -Milliseconds 600
    $after = Js "[[...__ws.records.projects.values()].filter((p) => p.kind === 'folder').length, !__ws.ui.sheet, document.querySelector('.fail, .failure, [role=alert]')?.innerText ?? ''].join(' | ')"
    Check 9 'Cancel closes it and is no failure: no workspace, nothing said, and the window has the keyboard again' ($closed -and "$after" -eq '0 | true | ' -and [Tasktap.Desk]::IsWindowEnabled($window) -and [Tasktap.Desk]::GetForegroundWindow() -eq $window) "workspaces, no sheet open, what the page says of a failure: $after; the window in front: $([Tasktap.Desk]::GetForegroundWindow() -eq $window)"
    # A folder chosen through the dialog itself: its path put into the dialog's field, its own button pressed.
    $dialog = Ask-Folder
    $field = if ($dialog) { [Tasktap.Desk]::Inside($dialog.Handle) | Where-Object { $_.Class -eq 'Edit' -and $_.Title -notlike '(hidden)*' } | Select-Object -First 1 }
    if (-not $field) {
        Say 'INFO' 9 'a folder was not chosen through the dialog: its field was not found (a chosen folder is rows 2 and 5, through TASKTAP_PICK)'
        if ($dialog) { [Tasktap.Desk]::Button($dialog.Handle, 2); $null = Gone $dialog }
    } else {
        # As a person does it: the path typed into the field and Return, which goes into that folder; then the
        # dialog's own button, which takes the folder it is in. (While the dialog is open the app's event loop is
        # inside it: the page answers nothing until it closes, so it is never left open.)
        [Tasktap.Desk]::SetText($field.Handle, "$tmp\chosen folder")
        Start-Sleep -Milliseconds 300
        [Tasktap.Desk]::Button($dialog.Handle, 1)
        if (-not (Gone $dialog 12)) {
            $went = ([Tasktap.Desk]::Inside($dialog.Handle) | Where-Object { $_.Class -eq 'ToolbarWindow32' -and $_.Title -like 'Address: *' } | Select-Object -First 1).Title
            Say 'INFO' 9 "after the path and the button the dialog is at: $went; its button once more takes that folder"
            [Tasktap.Desk]::Button($dialog.Handle, 1)
        }
        if (-not (Gone $dialog)) { [Tasktap.Desk]::Button($dialog.Handle, 2); $null = Gone $dialog }
        $want = "$tmp\chosen folder"
        $got = ''
        for ($i = 0; $i -lt 20 -and $got -ne $want; $i++) { Start-Sleep -Milliseconds 300; $got = "$(Js "[...__ws.records.projects.values()].filter((p) => p.kind === 'folder').map((p) => p.folder).join(' | ')" 2)" }
        Check 9 'a folder chosen in the dialog becomes a workspace, kept as the person knows it' ($got -eq $want) "the workspace's folder: $got"
    }
    End-Own 'row9-app.txt'
}

$rows['14'] = 'Starts the app with the core that has the fixture agent, the agent on the PATH of its terminals, and a folder as a workspace. Opens Notepad in front, presses Alt-Shift-Space, types a thought into the tab with the keyboard and presses Return: the thought must be captured, placed in the folder and started, with the fixture agent in a terminal of the workspace, and the tab must fold by itself and leave Notepad the keyboard. Has the agent ask: the tab must open on the question by itself and take the keyboard from nobody. Presses Ctrl+Alt+Y over Notepad: the agent must be answered while Notepad stays in front. Ends the turn and looks for the result''s marks in the window, on the tab and on the icon; puts the pointer on the tab, which must show the result and count it as read. Pictures of the tab with a thought running, a question, and a result.', {
    $fixtures = "$checkout\host\binaries\fixtures"
    New-Item -ItemType Directory -Force "$tmp\data14", "$tmp\project14", "$tmp\agents" | Out-Null
    Copy-Item "$fixtures\tasktap.exe" "$tmp\agents\fixture-agent.exe"
    Copy-Item "$fixtures\tasktap.exe" "$tmp\agents\fixture.exe"
    $window = Start-Own @{ TASKTAP_DATA = "$tmp\data14"; TASKTAP_PICK = "$tmp\project14"; TASKTAP_CORE_EXE = "$fixtures\tasktap.exe"; TASKTAP_CORE_BUILD = (Get-Content "$fixtures\build.txt" -Raw).Trim(); PATH = "$tmp\agents;$env:PATH" } 300
    if ($window -eq [IntPtr]::Zero) { Say 'FAIL' 14 'the app shows no window'; End-Own 'row14-app.txt'; return }
    foreach ($call in 'put {"c":"prefs","id":"agent","patch":"fixture"}', 'put {"c":"prefs","id":"hold","patch":2}', 'agents.detect {}') { Send "call $call"; $null = Until '"event":"reply"' 5 }
    $null = Js "(__ws.call('project.add', { id: __ws.uuid7(), folder: '$("$tmp\project14".Replace('\', '\\'))' }), 1)"
    $project = Soon "[...__ws.records.projects.values()].find((p) => p.kind === 'folder')?.id ?? ''" '-' 10
    $words = 'Ship the header from Notepad'
    $thought = "[...__ws.records.thoughts.values()].find((t) => t.text === '$words')"
    $notepad = Other-Program "Tasktap-flow-$PID"
    if (-not $notepad) { Say 'FAIL' 14 'not run: Notepad could not be put in front of the app, so no other program was in front'; End-Own 'row14-app.txt'; return }
    $t = Tab-Soon { param($t) $t.shown }
    $tab = [IntPtr][long]$t.window
    # Notepad under the tab and all of its sheet: the pictures show them over another program's light window.
    $null = [Tasktap.Desk]::SetWindowPos($notepad.Handle, [IntPtr]::Zero, $t.pixels[0] - 260, $t.pixels[1], 760, 520, 0x0014)
    Start-Sleep -Milliseconds 400
    [Tasktap.Desk]::Chord([byte[]](0x12, 0x10, 0x20))
    $front = $false
    for ($i = 0; $i -lt 30 -and -not $front; $i++) { Start-Sleep -Milliseconds 100; $front = [Tasktap.Desk]::GetForegroundWindow() -eq $tab }
    $null = Soon "document.activeElement?.id ?? ''" 'capture-input' 10 'notch'
    # Typed as a keyboard types, and only into the app's own window: the tab's.
    if ($front) { [Windows.Forms.SendKeys]::SendWait($words) }
    $typed = Soon "document.activeElement?.value ?? ''" ([regex]::Escape($words)) 8 'notch'
    Check 14 'Alt-Shift-Space over Notepad opens the tab, and what is typed next is in its field' ($front -and $typed -eq $words) "the tab in front: $front; the field holds: $typed"
    if ($front -and $typed -eq $words) { [Windows.Forms.SendKeys]::SendWait('{ENTER}') }
    $phase = Soon "String($thought`?.phase)" 'working' 50
    Check 14 'Return sends it: the thought is placed in the open folder and starts after its hold' ($phase -eq 'working') "its phase: $phase; where: $(Js "(p => p?.name ?? 'nowhere')(__ws.records.projects.get($thought`?.project_id))" 2)"
    # Started, the tab has done its job: it folds by itself and Notepad has the keyboard again.
    $back = $false
    for ($i = 0; $i -lt 40 -and -not $back; $i++) { Start-Sleep -Milliseconds 100; $back = [Tasktap.Desk]::GetForegroundWindow() -eq $notepad.Handle -and (Notch).collapsed }
    Check 14 'once the thought has started the tab folds by itself and Notepad is in front again' $back "Notepad in front: $([Tasktap.Desk]::GetForegroundWindow() -eq $notepad.Handle); the tab collapsed: $((Notch).collapsed)"
    Start-Sleep -Milliseconds 600
    Say 'LOOK' 14 'the tab collapsed while a thought runs: the mark for what works' (Tab-Picture $tab 'row14-tab-working')
    $session = Js "$thought`?.session_id ?? ''" 2
    $null = Soon "String(__ws.focusSession('$session'))" 'true' 20
    $screen = Soon '__ws.text()' 'fixture-agent' 25
    Check 14 'the fixture agent works in a terminal of the workspace' ("$screen" -match 'fixture-agent') (("$screen".Trim() -split "`n" | Select-Object -Last 3) -join ' | ')
    foreach ($line in 'event:ready', 'event:turn_started', 'ask:Deploy to staging?') { $null = Js "(__ws.type('$line'), 1)"; Start-Sleep -Milliseconds 400 }
    $strip = Soon "document.querySelector('.strip')?.innerText ?? ''" 'Deploy to staging\?' 25
    $keys = @($seen | Where-Object { $_ -match '"event":"answer-keys"' })[-1]
    Check 14 'its question shows in its pane, and the answer keys are held while it waits' ("$strip" -match 'Deploy to staging\?' -and "$keys" -match '"ok":true' -and "$keys" -match '"on":true') "the strip: $("$strip".Replace("`n", ' ')); the host: $keys"
    # The question opens the tab by itself, and takes the keyboard from nobody.
    $asks = Soon "document.body.classList.contains('open') + ' ' + (document.querySelector('#sheet')?.innerText ?? '').replace(/\s+/g, ' ')" 'true .*Deploy to staging\?' 20 'notch'
    Check 14 'the question opens the tab by itself, in full, and Notepad keeps the keyboard' ("$asks" -match '^true .*Deploy to staging\?' -and [Tasktap.Desk]::GetForegroundWindow() -eq $notepad.Handle -and -not (Notch).key) "the tab's sheet: $("$asks".Substring(0, [Math]::Min(160, "$asks".Length))); Notepad in front: $([Tasktap.Desk]::GetForegroundWindow() -eq $notepad.Handle)"
    Start-Sleep -Milliseconds 700
    Say 'LOOK' 14 'the tab open on a question, over another program' (Tab-Picture $tab 'row14-tab-question')
    # Folded while the question waits, as Escape folds it: the tab says who asks and what, its light is behind it,
    # and the icon is the question's.
    Send 'key notch Escape'
    $line = Soon "String(document.body.classList.contains('open')) + ' ' + (document.querySelector('#tab')?.innerText ?? '').replace(/\s+/g, ' ')" '^false .*Deploy to staging\?' 15 'notch'
    $t = Tab-Soon { param($t) $t.pixels[3] -lt 120 }
    Start-Sleep -Milliseconds 900
    Check 14 'folded while the question waits, the tab says who asks and what, wider by what that needs, and the icon is the question''s' ("$line" -match '^false .*Deploy to staging\?' -and $t.pixels[2] -gt 232 -and $t.icon.waits -eq 'Question') "the tab: $line; its window: $($t.pixels -join ' '); the icon: $($t.icon.waits), '$($t.icon.says)'"
    Say 'LOOK' 14 'the tab collapsed while a question waits: who asks and what, and the light behind it' (Tab-Picture $tab 'row14-tab-asks')
    # Answered from another program, as the global shortcut is for.
    $other = Front $notepad.Handle
    if ($other) { [Tasktap.Desk]::Chord([byte[]](0x11, 0x12, 0x59)) }
    $answered = Soon '__ws.text()' 'answer:yes' 25
    Check 14 'Ctrl+Alt+Y pressed over Notepad answers the agent, and Notepad stays in front' ($other -and "$answered" -match 'answer:yes' -and [Tasktap.Desk]::GetForegroundWindow() -eq $notepad.Handle) "Notepad in front before: $other, after: $([Tasktap.Desk]::GetForegroundWindow() -eq $notepad.Handle); the terminal: $(("$answered".Trim() -split "`n" | Select-Object -Last 2) -join ' | ')"
    $folded = $false
    for ($i = 0; $i -lt 30 -and -not $folded; $i++) { Start-Sleep -Milliseconds 100; $folded = [bool](Notch).collapsed }
    Check 14 'answered, the tab folds by itself' $folded "collapsed: $folded"
    $null = Js "(__ws.type('event:turn_finished:All green.'), 1)"
    $marks = Soon "document.querySelector('.tabw.on .st')?.dataset.s + ' ' + document.querySelector('.row.s.sel .st')?.dataset.s" 'ready ready' 25
    Check 14 'the turn''s end is a result: the tab and the sidebar row mark it unread' ($marks -eq 'ready ready') "the marks: $marks"
    # The result on the tab: its mark while collapsed, the icon's dot, and read once the sheet has shown it.
    $glance = Soon "(g => g.working + ' ' + g.needs_you + ' ' + g.done)(__records.glance)" '0 0 1' 15 'notch'
    $t = Tab
    Check 14 'the collapsed tab counts the result, and the icon shows that one waits' ($glance -eq '0 0 1' -and $t.icon.waits -eq 'Result') "working, needs you, new: $glance; the icon: $($t.icon.waits), '$($t.icon.says)'"
    Start-Sleep -Milliseconds 600
    Say 'LOOK' 14 'the tab collapsed with a result waiting' (Tab-Picture $tab 'row14-tab-result')
    $was = [Tasktap.Desk+Point]::new()
    $null = [Tasktap.Desk]::GetCursorPos([ref]$was)
    try {
        [Tasktap.Desk]::Point_($t.pixels[0] + [int]($t.pixels[2] / 2), $t.pixels[1] + 6)
        $result = Soon "(document.querySelector('#sheet .result')?.innerText ?? '').replace(/\s+/g, ' ')" 'Result .*All green' 15 'notch'
        Start-Sleep -Milliseconds 800
        Say 'LOOK' 14 'the tab open on the result, under the pointer' (Tab-Picture $tab 'row14-tab-result-open')
        $read = Soon "String(__records.glance.done)" '^0$' 15 'notch'
        Check 14 'the pointer on the tab shows the result, and shown for a moment it counts as read' ("$result" -match 'All green' -and $read -eq '0') "the sheet: $("$result".Substring(0, [Math]::Min(120, "$result".Length))); new results after: $read"
        # Away again, over the app's own window.
        $f = [Tasktap.Desk]::Frame($window)
        [Tasktap.Desk]::Point_([int](($f.Left + $f.Right) / 2), [int](($f.Top + $f.Bottom) / 2))
        $null = Tab-Soon { param($t) -not $t.watching }
    } finally {
        $null = [Tasktap.Desk]::SetCursorPos($was.X, $was.Y)
    }
    [Tasktap.Desk]::Close($notepad.Handle)
    $null = Front $window
    $null = Js "(__ws.dismiss(), 1)"
    Start-Sleep -Milliseconds 600
    Say 'LOOK' 14 'the workspace after the thought: the agent''s terminal with its question answered, and the result' (Capture $window 'row14-result')
    End-Own 'row14-app.txt'
    Start-Sleep -Milliseconds 500
    $left = Under $tmp
    Check 14 'the app, its core and the agent leave nothing running' (-not $left) (($left | ForEach-Object Name) -join ', ')
    $left | Stop-Process -Force -ErrorAction SilentlyContinue
}

$rows['13'] = 'Starts the app once more with the system''s own title bar in the page''s colours (TASKTAP_CHROME=native), for one picture to set beside the app''s own top row as the title bar; then tells it to quit.', {
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
# No test run may change the checkout meanwhile: it is held here, unless the job that built the app holds it for
# this round. Another job's end is waited for, five minutes at most.
$lock = $null
for ($tries = 0; -not $lock -and -not $Locked; $tries++) {
    try { $lock = [IO.File]::Open('C:\tasktap\checkout.lock', 'OpenOrCreate', 'ReadWrite', 'None') } catch {
        if ($tries -ge 60) { throw 'Another job has held the checkout for five minutes.' }
        Start-Sleep -Seconds 5
    }
}
$workspace = [IntPtr]::Zero
$chosen = @($Only -split '[ ,:]+' | Where-Object { $_ })
try {
    Say 'INFO' '' "commit $(git -C $checkout rev-parse HEAD), $triple, $([Environment]::OSVersion.VersionString), session $session"
    Say 'INFO' '' "no sound for as long as the round runs: $(Sounds-Off) sounds of this account's for the system's events are off, and its warning beep; both are put back at the end"
    # What Windows reports of the displays: a monitor that is switched off may leave none, or another size.
    $displays = @([Windows.Forms.Screen]::AllScreens | ForEach-Object { "$($_.Bounds.Width) x $($_.Bounds.Height) at $($_.Bounds.Left),$($_.Bounds.Top)$(if ($_.Primary) { ', the main one' }), work area $($_.WorkingArea.Width) x $($_.WorkingArea.Height) at $($_.WorkingArea.Left),$($_.WorkingArea.Top)" })
    Say 'INFO' '' "displays as Windows reports them: $($displays.Count): $($displays -join '; ')"
    if (-not $displays) { throw 'Windows reports no display: nothing can be shown or looked at.' }
    foreach ($row in $rows.Keys) {
        if ($chosen -and $row -notin $chosen) { continue }
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
                if ($seen) { $seen | Set-Content "$Out\rows4-12-app.txt" }
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
    Say 'INFO' '' "the account's sounds are as they were: $(Sounds-On) put back"
    if ($lock) { $lock.Dispose() }
}
$said = @(Get-Content "$Out\results.txt")
Write-Host "$(@($said -match '^PASS').Count) passed, $(@($said -match '^FAIL').Count) failed, $(@($said -match '^LOOK').Count) pictures to look at; all of it is in $Out"
exit [int](@($said -match '^FAIL').Count -gt 0)
