# What Tasktap costs the graphics processor, measured as a person runs it: in the test account's signed-in desktop,
# the app's window on the screen and not covered, about a minute in each state (README.md, "What the graphics
# processor costs"). gpu.sh builds the app, starts this there through the tower's desktop helper and fetches what it
# wrote:
#   <Out>\table.txt     one row per state: the app's own use of the graphics processor (Windows' counters for each
#                       process, summed over the app, its web views and its core, by kind of engine), its memory on
#                       the card, the compositor's use beside it, the card's utilisation and power against the floor,
#                       the frames the page drew, the card's performance state and memory clock, and the main
#                       processor's use
#   <Out>\samples.csv   every second of the round
#   <Out>\results.txt   what was done, PASS or FAIL for the proof at rest, and why a round was stopped
# The floor is measured first, with no app: the card idle, and what the measurement shows when nothing of the app runs.
#
# The card is watched every second, on a thread of its own (the driver's library, or nvidia-smi), and the app is
# ended at once and the round with it when the card passes 70 °C, draws more than 120 W over the floor's power, or the
# app's use (or the card's above the floor) stays over 40 % for ten seconds. Nothing is measured while another program
# already uses the card (a game). A round stays under a quarter of an hour: one that would not is refused before
# anything starts. The round makes no sound (sounds.ps1). Listening is shown with the level the checks' tone makes,
# never with the microphone: before anything else the round takes the microphone away from both of the app's pages.
# The app runs as a person runs it, not passive: a passive window is never the one in front (its host does not watch
# for it), so its light rests whatever it shows (the tower's first round, 2026-11-19).
#
# -DryRun starts nothing and shows no window: it says whether this account's desktop is the one on the screen and
# unlocked, whether the card and the counters answer, and what the round would measure. -Rehearse runs every state
# for a few seconds with no desktop and no card (the VM, over SSH): it proves the round's mechanics, never its figures.
param(
    [string]$Out = "C:\tasktap\gpu-rounds\$(Get-Date -Format 'yyyyMMdd-HHmmss')",
    [string]$Target = $(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }),
    # `window`: the window at the size it opens at; `full`: over the whole display, as `fullscreen on` puts it.
    [ValidateSet('window', 'full')] [string]$Size = 'window',
    # The levels of Settings › Appearance › Effects to measure each state at, in this order.
    [string]$Effects = 'full',
    # Lumen on, off or both, for the states it changes; empty: as the app starts.
    [string]$Lumen = '',
    # The states, in the round's order; empty: all of them.
    [string]$States = '',
    [int]$Seconds = 60,
    [string]$Checkout = '',
    # The commit the checkout must be at (gpu.sh --no-build): another worktree's job may have moved it since the build.
    [string]$Commit = '',
    [switch]$Locked,
    [switch]$DryRun,
    [switch]$Rehearse
)
$ErrorActionPreference = 'Stop'
$checkout = if ($Checkout) { $Checkout } else { Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
$triple = "$Target-pc-windows-msvc"
$app = "$checkout\host\target\$triple\release\Tasktap"
$exe = "$app\tasktap-app.exe"
$core = "$checkout\host\binaries\fixtures\tasktap.exe"
$tmp = Join-Path ([IO.Path]::GetTempPath()) "tasktap-gpu-$PID"
if ($Rehearse) { $Seconds = [Math]::Min($Seconds, 5) }
. "$checkout\host\scripts\app.ps1"
. "$PSScriptRoot\sounds.ps1"

Add-Type -Namespace Tasktap -Name Meter -UsingNamespace System.Text, System.Collections.Generic, System.Text.RegularExpressions -MemberDefinition @'
[DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhOpenQueryW(string source, IntPtr user, out IntPtr query);
[DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhAddEnglishCounterW(IntPtr query, string path, IntPtr user, out IntPtr counter);
[DllImport("pdh.dll")] static extern uint PdhCollectQueryData(IntPtr query);
[DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhGetFormattedCounterArrayW(IntPtr counter, uint format, ref uint size, out uint count, IntPtr items);
static IntPtr query, engines, memory;
// Windows' counters for each process's use of the graphics processor: the share of each second in which an engine
// ran that process's work (one instance a process and engine: pid_<id>_luid_<adapter>_phys_0_eng_<n>_engtype_<kind>),
// and the memory on the card each process holds (pid_<id>_luid_<adapter>_phys_0). Instances that come and go (a
// web view's process started later) are read as they are there at each collection. Null when it worked, else why not.
public static string Open() {
    uint s = PdhOpenQueryW(null, IntPtr.Zero, out query);
    if (s != 0) return "PdhOpenQuery: 0x" + s.ToString("x");
    s = PdhAddEnglishCounterW(query, @"\GPU Engine(*)\Utilization Percentage", IntPtr.Zero, out engines);
    if (s != 0) return @"\GPU Engine(*)\Utilization Percentage: 0x" + s.ToString("x");
    s = PdhAddEnglishCounterW(query, @"\GPU Process Memory(*)\Dedicated Usage", IntPtr.Zero, out memory);
    if (s != 0) return @"\GPU Process Memory(*)\Dedicated Usage: 0x" + s.ToString("x");
    s = PdhCollectQueryData(query);
    return s == 0 ? null : "PdhCollectQueryData: 0x" + s.ToString("x");
}
// Every instance's value at the last collection; an instance seen for the first time has none yet.
static Dictionary<string, double> Values(IntPtr counter) {
    var all = new Dictionary<string, double>();
    uint size = 0, count;
    const uint DOUBLE_NOCAP = 0x200 | 0x8000;
    if (PdhGetFormattedCounterArrayW(counter, DOUBLE_NOCAP, ref size, out count, IntPtr.Zero) != 0x800007D2) return all;
    var buffer = Marshal.AllocHGlobal((int)size);
    try {
        if (PdhGetFormattedCounterArrayW(counter, DOUBLE_NOCAP, ref size, out count, buffer) != 0) return all;
        // PDH_FMT_COUNTERVALUE_ITEM_W: the name, then { status, 8-byte aligned union }.
        int at = (IntPtr.Size + 7) / 8 * 8, item = at + 16;
        for (int i = 0; i < count; i++) {
            var row = buffer + i * item;
            var name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(row));
            var status = (uint)Marshal.ReadInt32(row + at);
            if (name == null || status > 1) continue;
            var value = BitConverter.Int64BitsToDouble(Marshal.ReadInt64(row + at + 8));
            double was;
            all[name] = all.TryGetValue(name, out was) ? was + value : value;
        }
    } finally { Marshal.FreeHGlobal(buffer); }
    return all;
}
static readonly Regex Engine = new Regex(@"^pid_(\d+)_luid_(\w+?_\w+?)_phys_\d+_eng_\d+_engtype_(.*)$");
static readonly Regex Owner = new Regex(@"^pid_(\d+)_");
public class Tick {
    // Per kind of engine (3D, Copy, VideoDecode, Compute_0, ...): the share of the second, in %, summed over the
    // app's processes, over the compositor's, and over every other process.
    public Dictionary<string, double> App = new Dictionary<string, double>(), Compositor = new Dictionary<string, double>(), Others = new Dictionary<string, double>();
    public double AppMemory, CompositorMemory;
    // The other process that used the card most this second, and how much (its busiest engine).
    public int TopPid; public double TopUse; public string TopKind = "";
    public int Instances, Invalid; public string Adapters = "";
}
static void Add(Dictionary<string, double> to, string kind, double value) { double was; to[kind] = (to.TryGetValue(kind, out was) ? was : 0) + value; }
public static Tick Sample(HashSet<int> app, int compositor) {
    var t = new Tick();
    if (PdhCollectQueryData(query) != 0) return t;
    var others = new Dictionary<int, Dictionary<string, double>>();
    var adapters = new HashSet<string>();
    foreach (var e in Values(engines)) {
        var m = Engine.Match(e.Key);
        if (!m.Success) continue;
        // A process that came in the last moment can read nonsense once (seen on the tower: 10^14 %); no share of a
        // second is outside 0 to 100.
        if (double.IsNaN(e.Value) || e.Value < 0 || e.Value > 100) { t.Invalid++; continue; }
        t.Instances++;
        int pid = int.Parse(m.Groups[1].Value);
        string kind = m.Groups[3].Value;
        if (app.Contains(pid)) { Add(t.App, kind, e.Value); if (e.Value > 0) adapters.Add(m.Groups[2].Value); }
        else if (pid == compositor) Add(t.Compositor, kind, e.Value);
        else {
            Add(t.Others, kind, e.Value);
            Dictionary<string, double> its;
            if (!others.TryGetValue(pid, out its)) others[pid] = its = new Dictionary<string, double>();
            Add(its, kind, e.Value);
        }
    }
    foreach (var p in others) foreach (var k in p.Value) if (k.Value > t.TopUse) { t.TopUse = k.Value; t.TopPid = p.Key; t.TopKind = k.Key; }
    foreach (var e in Values(memory)) {
        var m = Owner.Match(e.Key);
        if (!m.Success) continue;
        int pid = int.Parse(m.Groups[1].Value);
        if (app.Contains(pid)) t.AppMemory += e.Value; else if (pid == compositor) t.CompositorMemory += e.Value;
    }
    t.Adapters = string.Join(" ", adapters);
    return t;
}

[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int how);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
[DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
public static void Alt() { keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); }
[DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
[DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
[DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
public struct Point { public int X, Y; }
public struct Rect { public int Left, Top, Right, Bottom; }
[DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect value, int size);
[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
[DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point at);
[DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint which);
// The window as a person sees it, without the unseen margins Windows keeps around it for resizing.
public static Rect Frame(IntPtr window) {
    Rect r;
    if (DwmGetWindowAttribute(window, 9, out r, 16) != 0) GetWindowRect(window, out r);
    return r;
}
// How many of nine points inside the window (across at a sixth, a half and five sixths of it; down at a third, a half
// and five sixths) belong to it on the screen, and not to a window over it. Nothing near the top edge is asked: the
// tab hangs there.
public static int Seen(IntPtr window) {
    var r = Frame(window);
    int seen = 0, w = r.Right - r.Left, h = r.Bottom - r.Top;
    foreach (var fx in new[] { 1, 3, 5 }) foreach (var fy in new[] { 2, 3, 5 }) {
        var at = new Point { X = r.Left + w * fx / 6, Y = r.Top + h * fy / 6 };
        if (GetAncestor(WindowFromPoint(at), 2) == window) seen++;
    }
    return seen;
}

// The card, through the library its driver installs (nvml.dll; reading needs no administrator). Null when it
// answers, else why not.
[DllImport("nvml.dll")] static extern int nvmlInit_v2();
[DllImport("nvml.dll")] static extern int nvmlDeviceGetHandleByIndex_v2(uint index, out IntPtr device);
[DllImport("nvml.dll", CharSet = CharSet.Ansi)] static extern int nvmlDeviceGetName(IntPtr device, StringBuilder name, uint length);
[DllImport("nvml.dll")] static extern int nvmlDeviceGetTemperature(IntPtr device, int sensor, out uint celsius);
[DllImport("nvml.dll")] static extern int nvmlDeviceGetPowerUsage(IntPtr device, out uint milliwatts);
public struct Rates { public uint Gpu, Memory; }
[DllImport("nvml.dll")] static extern int nvmlDeviceGetUtilizationRates(IntPtr device, out Rates rates);
[DllImport("nvml.dll")] static extern int nvmlDeviceGetFanSpeed(IntPtr device, out uint percent);
[DllImport("nvml.dll")] static extern int nvmlDeviceGetClockInfo(IntPtr device, int type, out uint mhz);
[DllImport("nvml.dll")] static extern int nvmlDeviceGetPerformanceState(IntPtr device, out int state);
static IntPtr card;
public static string CardName = "";
public static string CardOpen() {
    try {
        int r = nvmlInit_v2();
        if (r != 0) return "nvmlInit: " + r;
        r = nvmlDeviceGetHandleByIndex_v2(0, out card);
        if (r != 0) return "nvmlDeviceGetHandleByIndex: " + r;
        var name = new StringBuilder(96);
        if (nvmlDeviceGetName(card, name, 96) == 0) CardName = name.ToString();
        return null;
    } catch (ArgumentNullException) { return "nvml.dll not found"; } catch (Exception e) { return e.GetType().Name + ": " + e.Message; }
}
// Or nvidia-smi, asked each time, where the library does not answer.
static string smi;
public static void UseSmi(string path) { smi = path; }
// Its utilisation (% of the last moment in which it ran any work), power (W), temperature (°C), fan (%), graphics
// and memory clocks (MHz) and performance state (0 the fastest, 8 the idle one); NaN for what it does not say; null
// when it does not answer.
public static double[] CardRead() {
    if (smi != null) return Smi();
    uint v; int ps; Rates rates;
    return new[] {
        nvmlDeviceGetUtilizationRates(card, out rates) == 0 ? rates.Gpu : double.NaN,
        nvmlDeviceGetPowerUsage(card, out v) == 0 ? v / 1000.0 : double.NaN,
        nvmlDeviceGetTemperature(card, 0, out v) == 0 ? v : double.NaN,
        nvmlDeviceGetFanSpeed(card, out v) == 0 ? v : double.NaN,
        nvmlDeviceGetClockInfo(card, 0, out v) == 0 ? v : double.NaN,
        nvmlDeviceGetClockInfo(card, 2, out v) == 0 ? v : double.NaN,
        nvmlDeviceGetPerformanceState(card, out ps) == 0 && ps < 32 ? ps : double.NaN,
    };
}
static double[] Smi() {
    var start = new System.Diagnostics.ProcessStartInfo(smi, "--query-gpu=utilization.gpu,power.draw,temperature.gpu,fan.speed,clocks.gr,clocks.mem,pstate --format=csv,noheader,nounits") { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true };
    using (var p = System.Diagnostics.Process.Start(start)) {
        var line = p.StandardOutput.ReadLine();
        p.WaitForExit(3000);
        if (line == null) return null;
        var parts = line.Split(',');
        if (parts.Length < 7) return null;
        var v = new double[7];
        for (int i = 0; i < 7; i++) if (!double.TryParse(parts[i].Trim().TrimStart('P'), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out v[i])) v[i] = double.NaN;
        return v;
    }
}

// The watch over the card: once a second, on a thread of its own, whatever the round is doing meanwhile. It ends the
// app at once, its whole tree, when the card passes 70 °C, draws more than 120 W over the floor's power, or stays more
// than 40 % above the floor's utilisation for ten seconds; or when the card stops saying its temperature for five.
// What tripped it is in Tripped; the newest reading in Last; the highest in the Peak fields.
public static volatile double[] Last;
public static volatile string Tripped;
public static double IdleUtil = double.NaN, IdlePower = double.NaN;
public static double PeakTemp = double.NaN, PeakPower = double.NaN, PeakFan = double.NaN, PeakUtil = double.NaN;
public static int App;
static System.Threading.Timer timer;
static readonly System.Diagnostics.Stopwatch since = System.Diagnostics.Stopwatch.StartNew();
static double heard;
static int above, beating;
public static double Age() { return since.Elapsed.TotalSeconds - heard; }
public static void Watch() { heard = since.Elapsed.TotalSeconds; timer = new System.Threading.Timer(_ => Beat(), null, 0, 1000); }
public static void Unwatch() { if (timer != null) timer.Dispose(); timer = null; }
static double Higher(double peak, double v) { return double.IsNaN(v) ? peak : double.IsNaN(peak) || v > peak ? v : peak; }
static void Beat() {
    if (System.Threading.Interlocked.Exchange(ref beating, 1) == 1) return;
    try {
        double[] v = null;
        try { v = CardRead(); } catch { }
        if (v == null || double.IsNaN(v[2])) {
            if (Age() > 5) Trip("the card has not said its temperature for five seconds: it is not watched");
            return;
        }
        Last = v;
        heard = since.Elapsed.TotalSeconds;
        PeakUtil = Higher(PeakUtil, v[0]); PeakPower = Higher(PeakPower, v[1]); PeakTemp = Higher(PeakTemp, v[2]); PeakFan = Higher(PeakFan, v[3]);
        if (v[2] > 70) Trip("the card's temperature is " + v[2] + " °C, over 70 °C");
        if (!double.IsNaN(IdlePower) && v[1] > IdlePower + 120) Trip("the card draws " + v[1].ToString("F1") + " W, more than 120 W over the floor's " + IdlePower.ToString("F1") + " W");
        if (!double.IsNaN(IdleUtil) && v[0] - IdleUtil > 40) { if (++above >= 10) Trip("for ten seconds the card was more than 40 % busier than at the floor (" + v[0] + " % against " + IdleUtil.ToString("F1") + " %)"); }
        else above = 0;
    } finally { beating = 0; }
}
public static void Trip(string why) {
    if (Tripped != null) return;
    Tripped = why;
    try { if (App > 0) System.Diagnostics.Process.GetProcessById(App).Kill(true); } catch { }
}

// Whose session the screen shows, and whether it is locked, asked from any session (over SSH too): the account's
// name ("" for the sign-in screen) and 1 unlocked, 0 locked, -1 not known.
[DllImport("wtsapi32.dll", CharSet = CharSet.Unicode)] static extern bool WTSQuerySessionInformationW(IntPtr server, uint session, int what, out IntPtr buffer, out int bytes);
[DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
public static string ScreenUser() {
    IntPtr b; int n;
    if (!WTSQuerySessionInformationW(IntPtr.Zero, WTSGetActiveConsoleSessionId(), 5, out b, out n)) return null;
    try { return Marshal.PtrToStringUni(b); } finally { WTSFreeMemory(b); }
}
public static int ScreenUnlocked() {
    IntPtr b; int n;
    if (!WTSQuerySessionInformationW(IntPtr.Zero, WTSGetActiveConsoleSessionId(), 25, out b, out n)) return -1;
    // WTSINFOEXW: its level, then (8-byte aligned, for the times in it) the session's id, state and flags.
    try { return Marshal.ReadInt32(b) == 1 ? Marshal.ReadInt32(b, 16) : -1; } finally { WTSFreeMemory(b); }
}

// The main display's refresh rate, as it is set now.
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
struct Mode {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    public short SpecVersion, DriverVersion, Size, DriverExtra;
    public int Fields, X, Y, Orientation, FixedOutput;
    public short Color, Duplex, YResolution, TTOption, Collate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string FormName;
    public short LogPixels;
    public int BitsPerPel, PelsWidth, PelsHeight, DisplayFlags, DisplayFrequency, ICMMethod, ICMIntent, MediaType, DitherType, Reserved1, Reserved2, PanningWidth, PanningHeight;
}
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettingsW(string device, int which, ref Mode mode);
public static int Refresh() {
    var m = new Mode { Size = (short)Marshal.SizeOf(typeof(Mode)) };
    return EnumDisplaySettingsW(null, -1, ref m) ? m.DisplayFrequency : 0;
}
'@

function Say($verdict, $what, $evidence = '') {
    $line = '{0,-4} {1}{2}' -f $verdict, $what, $(if ("$evidence") { " :: $evidence" })
    Write-Host $line
    if (-not $DryRun) { Add-Content "$Out\results.txt" $line }
}
# A number as the table writes it; '-' for one that is not known.
function F($x, $digits = 1) { if ($null -eq $x -or [double]::IsNaN([double]$x)) { '-' } else { ([double]$x).ToString("F$digits", [Globalization.CultureInfo]::InvariantCulture) } }
function Kind($use, $kind) { $v = 0.0; if ($use.TryGetValue($kind, [ref]$v)) { $v } else { 0.0 } }
function Total($use) { $s = 0.0; foreach ($v in $use.Values) { $s += $v }; $s }
function Lower($was, $now) { if ([double]::IsNaN($now) -or (-not [double]::IsNaN($was) -and $was -le $now)) { $was } else { $now } }
function Higher($was, $now) { if ([double]::IsNaN($now) -or (-not [double]::IsNaN($was) -and $was -ge $now)) { $was } else { $now } }
function Most($use) { $m = 0.0; foreach ($v in $use.Values) { if ($v -gt $m) { $m = $v } }; $m }
function Under($folder) { @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($folder, [StringComparison]::OrdinalIgnoreCase) }) }
function Who($id) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { "$($p.ProcessName) ($id)" } else { "process $id" } }

# Whose desktop the screen shows, and whether it is locked: the round needs this account's, unlocked.
function Screen {
    $user = [Tasktap.Meter]::ScreenUser()
    $unlocked = [Tasktap.Meter]::ScreenUnlocked()
    $whose = if ($null -eq $user) { 'a session whose account cannot be asked' } elseif (-not $user) { 'the sign-in screen' } elseif ($user -eq $env:USERNAME) { "this account's desktop" } else { "another account's desktop" }
    $lock = switch ($unlocked) { 1 { 'unlocked' } 0 { 'locked' } default { 'whether locked cannot be told' } }
    @{ ready = ($user -eq $env:USERNAME -and $unlocked -ne 0); said = "the screen shows $whose (session $([Tasktap.Meter]::WTSGetActiveConsoleSessionId())), $lock" }
}

# The card: the driver's library, or nvidia-smi asked each time; neither, and nothing is measured on it. Card-Open
# says how it is read, or nothing when it is not.
$cardWhy = ''
function Card-Open {
    $why = [Tasktap.Meter]::CardOpen()
    if (-not $why) { return "the driver's library (NVML): $([Tasktap.Meter]::CardName)" }
    $path = @((Get-Command nvidia-smi -ErrorAction SilentlyContinue).Source, "$env:ProgramFiles\NVIDIA Corporation\NVSMI\nvidia-smi.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if ($path) {
        [Tasktap.Meter]::UseSmi($path)
        $v = [Tasktap.Meter]::CardRead()
        if ($v -and -not [double]::IsNaN($v[2])) { return "nvidia-smi, asked once a second (the library: $why)" }
    }
    $script:cardWhy = "the library: $why; nvidia-smi: $(if ($path) { 'no temperature from it' } else { 'not found' })"
    $null
}
# Utilisation %, power W, temperature °C, fan %, graphics and memory clock MHz, performance state (NaN for what the
# card does not say), as the watch
# read them in the last two seconds; nothing when it did not.
function Card-Read { $v = [Tasktap.Meter]::Last; if ($v -and [Tasktap.Meter]::Age() -lt 2) { , $v } }

# ——— The states, in the round's order. `window`: the app's window in front and seen (else it is minimised and the
# tab is what shows); `lumen`: Lumen changes what it draws; `settle`: seconds before the measure (focus entering the
# window sends a pulse of 7.2 s); `enter`, `tick` (each second, measured or not), `leave`; `read`: a number read at
# both ends of the measure, said a second (not `count`, which a table answers with its own number of keys).
$catalogue = [ordered]@{
    'rest'         = @{ what = 'at rest on Home, nothing running'; window = $true; settle = 10; enter = { Up; Show 'home' } }
    'rest-unfocused' = @{ what = 'at rest on Home, nothing running, the caret taken out of its field'; window = $true; settle = 10; enter = { Up; Show 'home'; $null = Js '(document.activeElement?.blur(), 1)' } }
    'tab-rest'     = @{ what = 'the tab at the top edge at rest, the window minimised'; settle = 6; enter = { Down } }
    # Opened as the capture key opens it: told `hover in`, the tab of an app that is not passive folds again at once,
    # since the real pointer is not on it (the tower's round, 2026-11-19).
    'tab-open'     = @{ what = 'the tab open with the caret in its field, as the capture key opens it, the window minimised'; settle = 3; leave = { Send 'key notch Escape' }
        enter = { Down; Send 'capture'; Start-Sleep -Seconds 1; if (-not (Tab-Open)) { $script:noted = 'the tab DID NOT OPEN' } } }
    'sidebar'      = @{ what = 'Home, the sidebar opening and closing: one slide a second'; window = $true; lumen = $true; settle = 3
        enter = { Up; Show 'home'; $script:slides = 0 }
        tick = { Send "eval workspace (__ws.command('sidebar'), 1)"; $script:slides++ }
        leave = { if ($slides % 2) { Start-Sleep -Milliseconds 400; $null = Js "(__ws.command('sidebar'), 1)" } } }
    'terminal'     = @{ what = 'a terminal printing fast: cmd counting lines as fast as it can'; window = $true; settle = 3
        enter = { Up; Printing }
        read = { $n = Js "Math.max(0, ...(__ws.text().match(/^\d+(?= a line)/gm) ?? ['0']).map(Number))" 3; if ("$n" -match '^\d+$') { [double]$n } }
        leave = { $null = Js "(__ws.engines.get('$shell')?.term.input('\x03', true), 1)"; Start-Sleep -Seconds 1; $null = Js "(__ws.call('terminal.stop', { id: '$shell' }), 1)"; Show 'home' } }
    'listening'    = @{ what = 'listening on Home, to the level the checks'' tone makes (no microphone)'; window = $true; lumen = $true; settle = 4; enter = { Up; Show 'home'; Tone $true }; leave = { Tone $false } }
    'thinking'     = @{ what = 'a thought on its way: placed and held before it starts'; window = $true; lumen = $true; settle = 4; enter = { Up; Held; Show 'home' } }
    'working'      = @{ what = 'agents working: the fixture agent in its turn'; window = $true; lumen = $true; settle = 4; enter = { Up; Working; Show 'home' } }
    'question'     = @{ what = 'a question waiting, on Home'; window = $true; lumen = $true; settle = 4; enter = { Up; Asking; Show 'home' } }
    'tab-question' = @{ what = 'the tab glowing for a question, folded, the window minimised'; lumen = $true; settle = 4; enter = { Asking; Down; Folded } }
}

# ——— Driving the app through its debug channel (app.ps1), as the smoke script does.
function Has($expr, $want, $seconds = 10, $page = 'workspace') {
    $until = (Get-Date).AddSeconds($seconds)
    do {
        $script:last = "$(Js $expr 3 $page)"
        if ($last.Contains($want)) { return $true }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $until)
    $false
}
function Call($name, $json) { Send "call $name $json"; $null = Until "`"event`":`"reply`",`"name`":`"$name`"" 5 }
function Line($line) { $null = Js "(__ws.type('$line'), 1)"; Start-Sleep -Milliseconds 400 }
function Show($view) { $null = Js "(__ws.show('$view'), 1)" }
# The window in front, as a click would put it (Windows lets a program in the background bring a window forward
# only after a key press); minimised; and seen.
function Up {
    Send 'where system'
    if ($Rehearse) { return }
    if ([Tasktap.Meter]::IsIconic($workspace)) { $null = [Tasktap.Meter]::ShowWindow($workspace, 9); Start-Sleep -Milliseconds 500 }
    if ([Tasktap.Meter]::GetForegroundWindow() -ne $workspace) { [Tasktap.Meter]::Alt(); $null = [Tasktap.Meter]::SetForegroundWindow($workspace); Start-Sleep -Milliseconds 500 }
    if ([Tasktap.Meter]::GetForegroundWindow() -ne $workspace) { throw 'the app''s window cannot be brought in front' }
}
# Minimised, the host is told that the window is not in front, as it learns when a person goes to another program: in
# the test account's empty desktop no other window takes the front, and the host, which hears of the window in front
# only when another comes there, went on taking the minimised window for the one in front, so its light went on
# drawing unseen (the tower's round, 2026-11-19: a question waiting, 80 frames a second, 9.9 % of the 3D engine).
function Down {
    $null = [Tasktap.Meter]::ShowWindow($workspace, 6)
    Start-Sleep -Milliseconds 500
    if (-not $Rehearse -and -not [Tasktap.Meter]::IsIconic($workspace)) { throw 'the app''s window does not minimise' }
    Send 'where behind'
}
# Whether the tab is open, as the app says; and the tab folded, as Escape folds it: a question may open it by itself.
function Tab-Open {
    Send 'state'
    $state = Until '"event":"state"' 5
    [bool]($state -and -not (ConvertFrom-Json $state).notch.collapsed)
}
function Folded {
    if (Tab-Open) {
        Send 'key notch Escape'
        Start-Sleep -Seconds 1
        $script:noted = "the tab had opened on the question by itself and was folded$(if (Tab-Open) { ', and it STAYED OPEN' })"
    }
}
# The level the checks' tone gives a recording (a 220 Hz tone swelling three times a second: record.ts), reported ten
# times a second as the core reports a recording's level. It goes where the core's report goes (the page's records), so
# the page draws listening as it does while a person speaks; no microphone is opened and nothing is played.
function Tone($on) {
    if ($on) {
        $said = Js "(() => { const r = __ws.records, id = 'gpu-round-tone', t0 = performance.now(); clearInterval(window.__tone); r.dictations.set(id, { id, rev: 0, phase: 'recording', text: '', level: 0, target: { kind: 'text' }, error: null }); window.__tone = setInterval(() => { r.dictations.get(id).level = Math.round(45 + 35 * Math.sin(2 * Math.PI * 3 * (performance.now() - t0) / 1000)); r.onchange(); }, 100); r.onchange(); return String(__ws.ui.voice); })()" 5
        if ("$said" -ne 'true') { throw "the page does not listen to the tone's level (it said: $said)" }
    } else {
        $null = Js "(clearInterval(window.__tone), __ws.records.dictations.delete('gpu-round-tone'), __ws.records.onchange(), 1)" 5
    }
}
# The fixture agent's thought: held on its way (the hold set long), started, in its turn, asking.
$agent = 'none'
function Held {
    if ($agent -ne 'none') { return }
    Call 'put' '{"c":"prefs","id":"hold","patch":900}'
    $script:thought = Js '__ws.uuid7()' 3
    $null = Js "(__ws.call('thought.capture', { id: '$thought', text: 'Measure what the light costs', strokes: [], source: 'typed', project_id: '$project' }), 1)"
    if (-not (Has "String([...__ws.records.thoughts.values()].find(t => t.id === '$thought')?.phase)" 'routed' 15)) { throw "the thought is not held on its way (its phase: $last)" }
    $script:agent = 'held'
}
function Working {
    if ($agent -eq 'none') { Held }
    if ($agent -ne 'held') { return }
    $null = Js "(__ws.call('thought.start', { id: '$thought', attempt: __ws.uuid7() }), 1)"
    if (-not (Has "String([...__ws.records.thoughts.values()].find(t => t.id === '$thought')?.phase)" 'working' 20)) { throw "the thought does not start (its phase: $last)" }
    $script:agentSession = Js "[...__ws.records.thoughts.values()].find(t => t.id === '$thought')?.session_id ?? ''" 3
    $null = Has "String(__ws.focusSession('$agentSession'))" 'true' 10
    if (-not (Has '__ws.text()' 'fixture-agent' 10)) { throw 'the fixture agent''s terminal does not show it' }
    Line 'event:ready'
    Line 'event:turn_started'
    $script:agent = 'working'
}
function Asking {
    if ($agent -ne 'asking') { Working } else { return }
    $null = Has "String(__ws.focusSession('$agentSession'))" 'true' 10
    Line 'ask:Deploy to staging?'
    Show 'home'
    if (-not (Has "(document.querySelector('.needs')?.innerText ?? '')" 'Deploy to staging?' 10)) { throw 'the question does not show on Home' }
    $script:agent = 'asking'
}
# A shell in the project, counting as fast as cmd prints: a build's log, without end until Control-C.
function Printing {
    Show $project
    $script:shell = Js "__ws.newTerminal('$project')" 5
    if (-not (Has "__ws.records.terminals.get('$shell')?.state + ' ' + __ws.engines.get('$shell')?.attached" 'running true' 10)) { throw "the terminal does not start ($last)" }
    Start-Sleep -Seconds 1
    Line 'for /L %i in (1,1,2000000000) do @echo %i a line of a build that prints as fast as it can, as a compiler or a test run does'
}

# ——— The app's processes: the app, every process under it (its web views, its core and what that starts) and
# whatever runs from the round's own folder (the core runs from its data folder); read again every five seconds.
$ids = [Collections.Generic.HashSet[int]]::new()
$tracked = @{}
$cpuWas = @{}
$idsAt = -10.0
$proc = $null
function Refresh-Ids {
    $script:idsAt = $clock.Elapsed.TotalSeconds
    $ids.Clear()
    if (-not $proc -or $proc.HasExited) { $script:tracked = @{}; return }
    $mine = @(Get-Process | Where-Object { $_.SessionId -eq $session })
    $parent = @{}
    foreach ($p in $mine) { try { if ($p.Parent) { $parent[$p.Id] = $p.Parent.Id } } catch { } }
    $null = $ids.Add($proc.Id)
    foreach ($p in $mine) { if ($p.Path -and $p.Path.StartsWith($tmp, [StringComparison]::OrdinalIgnoreCase)) { $null = $ids.Add($p.Id) } }
    do {
        $grew = $false
        foreach ($child in @($parent.Keys)) { if (-not $ids.Contains($child) -and $ids.Contains($parent[$child])) { $null = $ids.Add($child); $grew = $true } }
    } while ($grew)
    $now = @{}
    foreach ($p in $mine) { if ($ids.Contains($p.Id)) { $now[$p.Id] = $p } }
    $script:tracked = $now
}

# ——— One second: waits for the next whole second of the round's clock, then reads the counters, the card and the
# app's processor time, keeps them, and applies the rules for the card. A rule that trips ends the app at once.
$clock = [Diagnostics.Stopwatch]::StartNew()
$samples = [Collections.Generic.List[string]]::new()
$samples.Add('second,cell,app 3D %,app other engines %,app GPU MB,compositor 3D %,others busiest %,busiest other,card %,card W,card C,card fan %,card MHz,card memory MHz,card P-state,app CPU ms,invalid counter values')
$cell = $null
$name = 'setup'
$over = 0; $busy = 0
$idle = $null
$stopped = $null
$noted = ''
function Stop($why) {
    $script:stopped = $why
    if ($proc -and -not $proc.HasExited) { $proc.Kill($true) }
    Under $tmp | Stop-Process -Force -ErrorAction SilentlyContinue
    Say 'STOP' $why
    throw "STOP $why"
}
function Second {
    $left = [int](([Math]::Floor($clock.Elapsed.TotalSeconds) + 1) * 1000 - $clock.ElapsedMilliseconds)
    if ($left -gt 0) { Start-Sleep -Milliseconds $left }
    if ($clock.Elapsed.TotalSeconds - $idsAt -ge 5) { Refresh-Ids }
    $t = [Tasktap.Meter]::Sample($ids, $dwm)
    $c = Card-Read
    $cpu = 0.0
    foreach ($p in @($tracked.Values)) {
        try { $p.Refresh(); $ms = $p.TotalProcessorTime.TotalMilliseconds } catch { continue }
        if ($cpuWas.ContainsKey($p.Id)) { $cpu += $ms - $cpuWas[$p.Id] }
        $cpuWas[$p.Id] = $ms
    }
    $app3d = Kind $t.App '3D'; $all = Total $t.App; $most = Most $t.App; $comp = Kind $t.Compositor '3D'
    # The card's own rules are the watch's (Tasktap.Meter.Beat), which has ended the app already when one tripped.
    if ([Tasktap.Meter]::Tripped) { Stop ([Tasktap.Meter]::Tripped) }
    if ($most -gt 40) { $script:over++ } else { $script:over = 0 }
    if ($over -ge 10) { Stop "for ten seconds the app used more than 40 % of an engine of the card (now $(F $most) % of its busiest)" }
    if ($t.TopUse -gt 25) { $script:busy++ } else { $script:busy = 0 }
    if ($busy -ge 10) { Stop "another program has used the card for ten seconds ($(Who $t.TopPid), $(F $t.TopUse) % of its $($t.TopKind) engine): the round ends" }
    if ($cell) {
        $cell.n++
        $cell.app3d += $app3d
        $cell.max3d = [Math]::Max($cell.max3d, $app3d)
        $cell.other += $all - $app3d
        $cell.maxall = [Math]::Max($cell.maxall, $all)
        if ($all -gt 0) { $cell.nonzero++ }
        $cell.memory = $t.AppMemory
        $cell.comp += $comp
        $cell.cpu += $cpu
        if ($c) {
            $cell.cards++
            $cell.util += $c[0]; $cell.utilsq += $c[0] * $c[0]
            $cell.power += $c[1]; $cell.powersq += $c[1] * $c[1]
            $cell.temp = Higher $cell.temp $c[2]; $cell.fan = Higher $cell.fan $c[3]
            $cell.memclock = Higher $cell.memclock $c[5]; $cell.pstate = Lower $cell.pstate $c[6]
        }
        $cell.others = [Math]::Max($cell.others, $t.TopUse)
    }
    $samples.Add((@([int]$clock.Elapsed.TotalSeconds, $name, (F $app3d 3), (F ($all - $app3d) 3), (F ($t.AppMemory / 1MB) 1), (F $comp 3), (F $t.TopUse 2), $(if ($t.TopUse -gt 0) { "$($t.TopPid) $($t.TopKind)" } else { '' }),
        $(if ($c) { (F $c[0] 0), (F $c[1] 1), (F $c[2] 0), (F $c[3] 0), (F $c[4] 0), (F $c[5] 0), (F $c[6] 0) } else { '', '', '', '', '', '', '' }), (F $cpu 0), $t.Invalid) | ForEach-Object { $_ }) -join ',')
}
function Wait($seconds, $tick) { for ($i = 0; $i -lt $seconds; $i++) { Second; if ($tick) { & $tick } } }

# ——— One state measured: settled, then $Seconds of it, with what the page drew. (Not named
# `Measure`: that is Measure-Object's alias, and an alias goes before a function.)
$rows = [Collections.Generic.List[object]]::new()
function Page-Now { if ($proc -and -not $proc.HasExited) { Js "[__motion.stats.frames, document.querySelector('.light')?.dataset.state ?? 'none', (c => c ? c.width + 'x' + c.height : 'none')(document.querySelector('.band canvas')), document.querySelectorAll('canvas').length, document.activeElement?.id || document.activeElement?.tagName || 'none']" 3 } }
function Measure-State($state, $effects, $lumen, $settle, $length = $Seconds) {
    $spec = if ($state -eq 'floor') { @{ settle = 0 } } else { $catalogue[$state] }
    $script:name = "$state $effects$(if ($lumen) { " lumen $lumen" })"
    Wait $settle $spec.tick
    $window = $spec.window -and -not $Rehearse
    $visible = if ($window) { [Tasktap.Meter]::Seen($workspace) } else { 9 }
    $before = Page-Now; $count = if ($spec.read) { & $spec.read }
    $script:cell = @{ n = 0; app3d = 0.0; max3d = 0.0; other = 0.0; maxall = 0.0; nonzero = 0; memory = 0.0; comp = 0.0; cpu = 0.0; cards = 0; util = 0.0; utilsq = 0.0; power = 0.0; powersq = 0.0; temp = [double]::NaN; fan = [double]::NaN; memclock = [double]::NaN; pstate = [double]::NaN; others = 0.0 }
    Wait $length $spec.tick
    $c = $cell; $script:cell = $null
    $after = Page-Now
    $counted = if ($spec.read) { & $spec.read }
    $visibleAfter = if ($window) { [Tasktap.Meter]::Seen($workspace) } else { 9 }
    $n = [Math]::Max(1, $c.n)
    $util = if ($c.cards) { $c.util / $c.cards } else { [double]::NaN }
    $power = if ($c.cards) { $c.power / $c.cards } else { [double]::NaN }
    $frames = if ($before -and $after) { ($after[0] - $before[0]) / $n } else { $null }
    $notes = @()
    if ($after) { $notes += "light $($after[1]), band canvas $($after[2]), canvases $($after[3]), focus $($after[4])" }
    if ($null -ne $count -and $null -ne $counted) { $notes += "$(F (($counted - $count) / $n) 0) lines/s" }
    if ($state -eq 'sidebar') { $notes += "$slides slides" }
    if ($noted) { $notes += $noted; $script:noted = '' }
    if ($visible -lt 9 -or $visibleAfter -lt 9) { $notes += "COVERED: $visible and $visibleAfter of 9 points seen" }
    if ($c.others -gt 5) { $notes += "another program up to $(F $c.others) % of an engine" }
    $row = [ordered]@{
        state = $state; effects = $effects; lumen = $lumen; s = $c.n
        app3d = $c.app3d / $n; max3d = $c.max3d; other = $c.other / $n; mb = $c.memory / 1MB; comp = $c.comp / $n
        util = $util; utilsd = $(if ($c.cards) { [Math]::Sqrt([Math]::Max(0, $c.utilsq / $c.cards - $util * $util)) } else { [double]::NaN })
        power = $power; powersd = $(if ($c.cards) { [Math]::Sqrt([Math]::Max(0, $c.powersq / $c.cards - $power * $power)) } else { [double]::NaN })
        temp = $c.temp; fan = $c.fan; memclock = $c.memclock; pstate = $c.pstate
        frames = $frames
        cpu = $c.cpu / ($n * 1000) * 100; nonzero = $c.nonzero; maxall = $c.maxall; notes = $notes -join '; '
    }
    $rows.Add($row)
    Say 'ROW' $name "app 3D $(F $row.app3d 3) % (most $(F $row.max3d 3)), other engines $(F $row.other 3) %, $(F $row.mb) MB; compositor $(F $row.comp 3) %; card $(F $util) %, $(F $power) W; page $(F $frames) frames/s; card P$(F $row.pstate 0), memory $(F $row.memclock 0) MHz; processor $(F $row.cpu 2) % of a core$(if ($row.notes) { "; $($row.notes)" })"
    if ($state -in 'rest', 'rest-unfocused', 'tab-rest') {
        Check-Rest $row "$($spec.what), effects $effects"
    }
    $row
}
# Item 35 of the trial checklist: at rest the app's figure is zero.
function Check-Rest($row, $what) {
    $zero = $row.nonzero -eq 0 -and (-not $row.frames)
    $evidence = "in $($row.s) one-second samples the app's processes used $(if ($row.nonzero) { "some engine in $($row.nonzero) (at most $(F $row.maxall 3) % of one)" } else { 'no engine at all: 0.000 % each second' }); the page drew $(F $row.frames) frames a second; the compositor $(F $row.comp 3) % against the floor's $(F $rows[0].comp 3) %"
    Say $(if ($zero) { 'PASS' } else { 'FAIL' }) "at rest the app uses no graphics processor: $what" $evidence
}

# ——— The table: one row a state, the floor first.
function Table {
    $head = '{0,-13} {1,-6} {2,-5} {3,4} {4,8} {5,8} {6,8} {7,7} {8,8} {9,12} {10,14} {11,8} {12,8} {13,7}  {14}' -f 'state', 'effect', 'lumen', 's', 'app 3D%', 'max 3D%', 'other%', 'app MB', 'dwm 3D%', 'card % (+fl)', 'card W (+fl)', 'page f/s', 'P/mem', 'CPU %', 'notes'
    $text = @($head, ('-' * $head.Length))
    foreach ($r in $rows) {
        $floor = $r.state -eq 'floor'
        $card = if ($floor) { "$(F $r.util)±$(F $r.utilsd)" } else { "$(F $r.util) ($(if ($idle) { F ($r.util - $idle.util) } else { '-' }))" }
        $watt = if ($floor) { "$(F $r.power)±$(F $r.powersd)" } else { "$(F $r.power) ($(if ($idle) { F ($r.power - $idle.power) } else { '-' }))" }
        $text += '{0,-13} {1,-6} {2,-5} {3,4} {4,8} {5,8} {6,8} {7,7} {8,8} {9,12} {10,14} {11,8} {12,8} {13,7}  {14}' -f $r.state, $r.effects, $r.lumen, $r.s,
            $(if ($floor) { '-' } else { F $r.app3d 3 }), $(if ($floor) { '-' } else { F $r.max3d 3 }), $(if ($floor) { '-' } else { F $r.other 3 }), $(if ($floor) { '-' } else { F $r.mb 0 }),
            (F $r.comp 3), $card, $watt, (F $r.frames), "P$(F $r.pstate 0)/$(F $r.memclock 0)", $(if ($floor) { '-' } else { F $r.cpu 2 }), $r.notes
    }
    $text += ''
    $text += "app 3D% and max 3D%: the share of each second in which the card's 3D engine ran the app's work (its processes summed: the app, its web views, its core), mean and busiest second; other%: every other engine (copy, video, compute) summed; app MB: the app's memory on the card; dwm 3D%: the compositor's, which draws every window; card %: the card busy at all, with (+fl) above the floor; card W: its power, with (+fl) over the floor; page f/s: frames the page's light drew; P/mem: the card's fastest performance state and highest memory clock (MHz) in the minute (P8 is its idle one); CPU %: the app's processes, of one core."
    $text += "Highest during the round: the card at $(F ([Tasktap.Meter]::PeakTemp) 0) °C, $(F ([Tasktap.Meter]::PeakPower)) W, fan $(F ([Tasktap.Meter]::PeakFan) 0) %, $(F ([Tasktap.Meter]::PeakUtil) 0) % busy$(if ($idle) { "; at the floor $(F $idle.temp 0) °C, $(F $idle.power) W, fan $(F $idle.fan 0) %, $(F $idle.util) % busy" })."
    if ($stopped) { $text += "The round was stopped: $stopped" }
    $text | Set-Content "$Out\table.txt"
    $text | ForEach-Object { Write-Host $_ }
}

# ——— What the round would measure, and how long it takes.
$chosen = @($States -split '[ ,:]+' | Where-Object { $_ })
$unknown = @($chosen | Where-Object { -not $catalogue.Contains($_) })
if ($unknown) { throw "No such state: $($unknown -join ', '). The states: $($catalogue.Keys -join ', ')" }
$levels = @($Effects -split '[ ,:]+' | Where-Object { $_ })
if (@($levels | Where-Object { $_ -notin 'full', 'still', 'off' })) { throw "Effects are full, still or off; not $Effects" }
$lumens = @($Lumen -split '[ ,:]+' | Where-Object { $_ })
$plan = [Collections.Generic.List[object]]::new()
$skipped = @()
foreach ($state in $catalogue.Keys) {
    if ($chosen -and $state -notin $chosen) { continue }
    if ($Size -eq 'full' -and -not $catalogue[$state].window) { $skipped += $state; continue }
    foreach ($level in $levels) {
        $applies = $catalogue[$state].lumen -and ($level -ne 'off' -or $state -eq 'tab-question')
        # The focus' pulse is settled once, at the state's first level; a later one needs a moment for the change.
        foreach ($l in $(if ($lumens -and $applies) { $lumens } else { @('') })) { $plan.Add(@{ state = $state; effects = $level; lumen = $l; settle = $(if ($plan.Count -and $plan[$plan.Count - 1].state -eq $state) { [Math]::Min(3, $catalogue[$state].settle) } else { $catalogue[$state].settle }) }) }
    }
}
# As the tower's rounds take it: the floor, the app's start, each state's minute and settling, and entering each state.
$estimate = $Seconds + 20 + ($plan | ForEach-Object { $Seconds + $_.settle + 1 } | Measure-Object -Sum).Sum + 4 * @($plan.state | Select-Object -Unique).Count
$needs = [ordered]@{ 'the built app' = $exe; 'the fixture core' = $core; 'its build stamp' = "$(Split-Path $core -Parent)\build.txt" }
$missing = @($needs.Keys | Where-Object { -not (Test-Path $needs[$_]) })
$session = (Get-Process -Id $PID).SessionId
$dwm = [int](@(Get-Process dwm -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq [Tasktap.Meter]::WTSGetActiveConsoleSessionId() })[0].Id)
$counters = [Tasktap.Meter]::Open()

if ($DryRun) {
    New-Item -ItemType Directory -Force $Out | Out-Null
    function Tell($line) { Write-Host $line; Add-Content "$Out\dry-run.txt" $line }
    $screen = Screen
    Tell "Dry run in session ${session}: nothing is started. $($screen.said): $(if ($screen.ready) { 'a round can start' } else { 'a round cannot start until the owner signs in to this account and leaves its desktop showing' })."
    $source = Card-Open
    if ($source) {
        $now = [Tasktap.Meter]::CardRead()
        Tell "The card answers through $source; now: $(F $now[0] 0) % busy, $(F $now[1]) W, $(F $now[2] 0) °C, fan $(F $now[3] 0) %, $(F $now[4] 0) MHz, memory $(F $now[5] 0) MHz, P$(F $now[6] 0)."
    } else { Tell "The card does not answer ($cardWhy): a round would refuse to start." }
    # A standard account signed in over SSH may not read the counters' names (they are the interactive account's:
    # PDH_CANNOT_READ_NAME_STRINGS); at the desktop it may (seen on the tower, 2026-11-19).
    $remote = $counters -and $session -eq 0 -and $counters -match 'c0000bc8'
    if ($remote) { Tell "Windows' counters for the graphics processor are not readable over SSH (${counters}: their names are read only by an account signed in at the screen); the round reads them at the desktop." }
    elseif ($counters) { Tell "Windows' counters for the graphics processor cannot be read: $counters." } else {
        Start-Sleep -Seconds 1
        $t = [Tasktap.Meter]::Sample($ids, $dwm)
        Tell "Windows' counters answer: $($t.Instances) engines of processes; the busiest process now: $(if ($t.TopUse -gt 0) { "$(Who $t.TopPid), $(F $t.TopUse 2) % of its $($t.TopKind) engine" } else { 'none' }); the compositor $(F (Kind $t.Compositor '3D') 2) % of its 3D engine."
    }
    foreach ($need in $needs.Keys) { Tell ('{0,-7} {1}: {2}' -f $(if ($need -in $missing) { 'MISSING' } else { 'there' }), $need, $needs[$need]) }
    Tell "The round: the floor, then $($plan.Count) states of $Seconds s at the window's size '$Size', effects $($levels -join ', ')$(if ($lumens) { ", Lumen $($lumens -join ', ') where it applies" }): about $([Math]::Ceiling($estimate / 60)) minutes$(if ($estimate -gt 900) { ', OVER the quarter of an hour: a round this long is refused' })."
    foreach ($p in $plan) { Tell "  $($p.state), effects $($p.effects)$(if ($p.lumen) { ", Lumen $($p.lumen)" }): $($catalogue[$p.state].what)" }
    foreach ($s in $skipped) { Tell "  not at full size: $s (the window is minimised for it, so its size changes nothing)" }
    exit [int]($missing.Count -gt 0 -or -not $screen.ready -or -not $source -or ($counters -and -not $remote))
}

if ($missing) { throw "Missing: $($missing -join ', '). Run scripts/winvm/host.sh --tower first." }
if ($counters) { throw "Windows' counters for the graphics processor cannot be read: $counters" }
if (-not $plan.Count) { throw 'Nothing to measure.' }
if ($estimate -gt 900 -and -not $Rehearse) { throw "This round would take about $([Math]::Ceiling($estimate / 60)) minutes, over a quarter of an hour: measure fewer states, levels or seconds in one round." }
if (-not $Rehearse) {
    $screen = Screen
    if ($session -eq 0 -or $session -ne [Tasktap.Meter]::WTSGetActiveConsoleSessionId() -or -not $screen.ready) { throw "This account's desktop is not the one on the screen ($($screen.said)). The owner signs in to it and leaves it showing." }
    $desktop = [Tasktap.Meter]::OpenInputDesktop(0, $false, 0x0001)
    if ($desktop -eq [IntPtr]::Zero) { throw 'The desktop is locked. Unlock it first.' }
    $null = [Tasktap.Meter]::CloseDesktop($desktop)
}
$source = Card-Open
if (-not $source -and -not $Rehearse) { throw "The card does not answer ($cardWhy): its temperature and power cannot be watched, so nothing is measured." }
# The watch over the card starts now and runs to the end, on a thread of its own (Tasktap.Meter.Watch).
if ($source) { [Tasktap.Meter]::Watch() }
$null = [Tasktap.Meter]::SetProcessDPIAware()
New-Item -ItemType Directory -Force $Out, "$tmp\data", "$tmp\project", "$tmp\agents" | Out-Null
# What an earlier round that was cut short left running.
$left = @(Get-Process | Where-Object { $_.Path -and $_.Path -like "$([IO.Path]::GetTempPath())tasktap-gpu-*" -and -not $_.Path.StartsWith($tmp, [StringComparison]::OrdinalIgnoreCase) })
if ($left) { $left | Stop-Process -Force -ErrorAction SilentlyContinue }
# No other job may change the checkout meanwhile, unless the job that built the app holds it for this round.
$lock = $null
for ($tries = 0; -not $lock -and -not $Locked; $tries++) {
    try { $lock = [IO.File]::Open('C:\tasktap\checkout.lock', 'OpenOrCreate', 'ReadWrite', 'None') } catch {
        if ($tries -ge 60) { throw 'Another job has held the checkout for five minutes.' }
        Start-Sleep -Seconds 5
    }
}
try {
    $at = "$(git -C $checkout rev-parse HEAD)"
    if ($Commit -and $at -ne $Commit) { throw "the checkout is at $at, not ${Commit}: another job has moved it since the build (gpu.sh without --no-build builds it again)" }
    Add-Type -AssemblyName System.Windows.Forms
    Say 'INFO' "commit $at, $triple, $([Environment]::OSVersion.VersionString), session $session$(if ($Rehearse) { ', a REHEARSAL: no desktop and no card, every figure meaningless' })"
    Say 'INFO' "no sound for as long as the round runs: $(Sounds-Off) sounds of this account's for the system's events are off, and its warning beep; both are put back at the end"
    $screen = [Windows.Forms.Screen]::PrimaryScreen
    Say 'INFO' "the main display: $($screen.Bounds.Width) x $($screen.Bounds.Height) at $([Tasktap.Meter]::Refresh()) Hz; the card read through $(if ($source) { $source } else { 'nothing' }); the compositor is process $dwm; $(if ($lumens) { "Lumen $($lumens -join ', ') where it applies; " })about $([Math]::Ceiling($estimate / 60)) minutes"
    foreach ($s in $skipped) { Say 'SKIP' "$s at full size: the window is minimised for it, so its size changes nothing" }

    # The floor: the card with no app, and whether another program uses it already (a game): then nothing is measured.
    $name = 'floor'
    Wait 5
    $first = [Tasktap.Meter]::Sample($ids, $dwm)
    $now = Card-Read
    if ($first.TopUse -gt 15 -or ($now -and $now[0] -gt 25)) {
        Stop "the card is in use already ($(if ($now) { F $now[0] 0 } else { '-' }) % busy; the busiest program $(Who $first.TopPid), $(F $first.TopUse) % of its $($first.TopKind) engine): nothing is measured while another program uses it"
    }
    # Until the floor is known, the first seconds stand in for it in the watch's rules.
    if ($now) { [Tasktap.Meter]::IdleUtil = $now[0]; [Tasktap.Meter]::IdlePower = $now[1] }
    $null = Measure-State 'floor' '' '' 0
    $floor = $rows[0]
    if ($floor.s -and -not [double]::IsNaN($floor.power)) {
        $idle = @{ util = $floor.util; power = $floor.power; temp = $floor.temp; fan = $floor.fan }
        [Tasktap.Meter]::IdleUtil = $idle.util; [Tasktap.Meter]::IdlePower = $idle.power
    }
    Say 'INFO' "the floor, with no app: the card $(F $floor.util) ± $(F $floor.utilsd) % busy, $(F $floor.power) ± $(F $floor.powersd) W, $(F $floor.temp 0) °C, fan $(F $floor.fan 0) %; P$(F $floor.pstate 0), memory clock up to $(F $floor.memclock 0) MHz; the compositor $(F $floor.comp 3) % of its 3D engine. A process that gives the card no work reads 0.000 % in Windows' counters, which count its engines' time to the tenth of a microsecond."

    # The app as a person runs it (not passive: see the top), on a data folder of the round's own, with the core that
    # has the fixture agent, as the smoke script starts it.
    Copy-Item $core "$tmp\agents\fixture-agent.exe"
    Copy-Item $core "$tmp\agents\fixture.exe"
    Set-Content "$tmp\opener.cmd" "@echo %* >> `"$tmp\opened`""
    $name = 'start'
    Start-App $exe @{
        TASKTAP_DATA = "$tmp\data"; TASKTAP_OPEN = "$tmp\opener.cmd"
        TASKTAP_CORE_EXE = $core; TASKTAP_CORE_BUILD = (Get-Content "$(Split-Path $core -Parent)\build.txt" -Raw).Trim()
        PATH = "$tmp\agents;$env:PATH"
    } 1500
    [Tasktap.Meter]::App = $proc.Id
    if (-not (Until '"event":"ready"' 45)) { throw 'the app did not start' }
    if (-not (Has 'typeof __ws' 'object' 20)) { throw 'the workspace page does not run' }
    # No microphone, whatever happens: in both pages asking for one fails before the system is asked, and the recorder's
    # source is the checks' tone. Nothing in the round asks; this makes sure nothing can.
    $deaf = "(Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: () => Promise.reject(new DOMException('The graphics round never opens the microphone.', 'NotAllowedError')) }), typeof __speech === 'object' && (__speech.talk.source = 'tone'), String(navigator.mediaDevices.getUserMedia).includes('graphics round'))"
    if (-not (Has 'typeof __records' 'object' 20 'notch')) { throw 'the tab''s page does not run' }
    if ("$(Js $deaf 3)" -ne 'true' -or "$(Js $deaf 3 'notch')" -ne 'true') { throw 'the microphone could not be taken away from the app''s pages: nothing is measured' }
    Send 'state'
    $state = Until '"event":"state"' 5
    $workspace = if ($state) { [IntPtr][long](ConvertFrom-Json $state).workspace } else { [IntPtr]::Zero }
    if ($workspace -eq [IntPtr]::Zero) { throw 'the app shows no window' }
    Call 'put' '{"c":"prefs","id":"agent","patch":"fixture"}'
    Call 'agents.detect' '{}'
    $null = Js "(__ws.call('project.add', { id: __ws.uuid7(), folder: '$("$tmp\project".Replace('\', '\\'))' }), 1)"
    $project = $null
    for ($i = 0; $i -lt 10 -and -not $project; $i++) { $project = Js "[...__ws.records.projects.values()].find(p => p.kind === 'folder')?.id ?? ''" 2 }
    if (-not $project) { throw 'the round''s folder does not become a workspace' }
    Refresh-Ids
    Up
    if ($Size -eq 'full') { Send 'fullscreen on'; Start-Sleep -Seconds 2 }
    $frame = [Tasktap.Meter]::Frame($workspace)
    $page = Js "JSON.stringify({ dpr: devicePixelRatio, inner: [innerWidth, innerHeight] })" 3
    Say 'INFO' "the app's window: $($frame.Right - $frame.Left) x $($frame.Bottom - $frame.Top) at $($frame.Left),$($frame.Top) ($Size); the page: $page; $($ids.Count) processes"

    $was = $null
    foreach ($p in $plan) {
        if ($clock.Elapsed.TotalSeconds -gt 900 -and -not $Rehearse) { Say 'STOP' 'the round''s quarter of an hour is up: the states after this were not measured'; break }
        if ($p.state -ne $was) {
            if ($was -and $catalogue[$was].leave) { & $catalogue[$was].leave }
            $script:name = "enter $($p.state)"
            & $catalogue[$p.state].enter
            $was = $p.state
        }
        Call 'put' "{`"c`":`"prefs`",`"id`":`"motion_ambient`",`"patch`":`"$(@{ full = 'breathing'; still = 'still'; off = 'off' }[$p.effects])`"}"
        if ($p.lumen) { Call 'put' "{`"c`":`"prefs`",`"id`":`"motion_lumen`",`"patch`":$(if ($p.lumen -eq 'on') { 'true' } else { 'false' })}" }
        $null = Measure-State $p.state $p.effects $p.lumen $p.settle
    }
    if ($was -and $catalogue[$was].leave) { & $catalogue[$was].leave }
    # The floor once more, the app gone: the card's idle power is not one figure (on the tower it sat at 13 W before a
    # round and at 30 W, in the same P8, after one), so a round says whether its floor held.
    $script:name = 'quit'
    Send 'call core.retire {"when":"now"}'
    $null = Until '"event":"reply"' 3
    Send 'quit'
    if (-not $proc.WaitForExit(10000)) { $proc.Kill($true) }
    Refresh-Ids
    if ($clock.Elapsed.TotalSeconds -lt 860 -or $Rehearse) {
        $null = Measure-State 'floor' 'after' '' 5 ([Math]::Min(30, $Seconds))
        $after = $rows[$rows.Count - 1]
        Say 'INFO' "the floor again, the app gone: the card $(F $after.util) % busy, $(F $after.power) ± $(F $after.powersd) W, P$(F $after.pstate 0), memory clock up to $(F $after.memclock 0) MHz, against $(F $floor.power) W and P$(F $floor.pstate 0), $(F $floor.memclock 0) MHz before"
    }
} catch {
    # A rule of the watch's that tripped meanwhile (it has ended the app) is why whatever was waiting for it failed.
    if (-not $stopped -and [Tasktap.Meter]::Tripped) { $stopped = [Tasktap.Meter]::Tripped; Say 'STOP' $stopped }
    if (-not $stopped) { Say 'FAIL' "the round stopped on an error, in $name" "$($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))" }
} finally {
    [Tasktap.Meter]::Unwatch()
    if ($proc -and -not $proc.HasExited) {
        Send 'call core.retire {"when":"now"}'
        $null = Until '"event":"reply"' 3
        Send 'quit'
        if (-not $proc.WaitForExit(10000)) { $proc.Kill($true) }
    }
    Start-Sleep -Milliseconds 500
    $left = Under $tmp
    $left | Stop-Process -Force -ErrorAction SilentlyContinue
    if (Test-Path $Out) {
        $samples | Set-Content "$Out\samples.csv"
        if ($seen) { $seen | Where-Object { $_ -notmatch '"event":"report"' } | Set-Content "$Out\app.txt" }
        if ($rows.Count) { Table }
        Say 'INFO' "the app has quit$(if ($left) { "; left running and ended: $(($left | ForEach-Object Name) -join ', ')" } else { ' and left nothing running' }); the account's sounds are as they were: $(Sounds-On) put back"
    }
    Start-Sleep -Milliseconds 500
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    if ($lock) { $lock.Dispose() }
}
$said = @(Get-Content "$Out\results.txt")
Write-Host "$(@($said -match '^PASS').Count) passed, $(@($said -match '^FAIL').Count) failed$(if ($stopped) { ", stopped: $stopped" }); all of it is in $Out"
exit [int](@($said -match '^(FAIL|STOP)').Count -gt 0)
