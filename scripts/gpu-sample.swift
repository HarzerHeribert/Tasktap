// What the graphics round (host/scripts/gpu.sh, scripts/gpu-round.cjs) reads each second on the Mac, without a
// password, one JSON object a line at each whole second of the clock:
//   gpu     the graphics processor's own statistics (IOAccelerator, on Apple silicon the AGXAccelerator class, its
//           "PerformanceStatistics": "Device Utilization %", "Renderer Utilization %", "Tiler Utilization %")
//   all, ws, other   graphics time in ns over the second: every process's together, WindowServer's, and the busiest
//           other process's, from the driver's count of each of its clients (the AGXDeviceUserClient entries under
//           the accelerator: "IOUserClientCreator" names the process, "AppUsage" sums its "accumulatedGPUTime" in ns)
//   app     the app's processes over the second, each with its graphics and processor time in ns: the app itself,
//           every process the system holds it responsible for (its WebKit content, GPU and networking processes),
//           whatever runs from its data folder (its core) and everything these started
//   display the display the app's window is on (else the built-in one): its mode's refresh rate and the most frames a
//           second it can show, asleep or not; whether the screen is locked
//   win, notch   the app's window on screen (its frame, the share of it under other apps' windows, whether another
//           app's window lies over it at all) and its notch panel
//   ac, lowPower, thermal, load, idle, pointer   the Mac on its charger or not, Low Power Mode, the thermal state
//           (0 nominal to 3 critical), the 1-minute load average, seconds since the person last used a key, the
//           pointer or the trackpad (the HID system's own count), and where the pointer is
// The app to watch is told on standard input: `app <pid> <data folder>`, `app 0`; `quit` or the end of input ends it.
// Nothing here moves, clicks, types or asks the system for any permission.
// usage: swiftc -O scripts/gpu-sample.swift -o <file>; <file>
import AppKit
import CoreGraphics
import Darwin
import Foundation
import IOKit
import IOKit.ps

setvbuf(stdout, nil, _IOLBF, 0)
var base = mach_timebase_info_data_t()
mach_timebase_info(&base)
func ns(_ t: UInt64) -> UInt64 { t / UInt64(base.denom) * UInt64(base.numer) + t % UInt64(base.denom) * UInt64(base.numer) / UInt64(base.denom) }

typealias Responsible = @convention(c) (pid_t) -> pid_t
let responsible: Responsible? = dlsym(dlopen(nil, RTLD_NOW), "responsibility_get_pid_responsible_for_pid").map { unsafeBitCast($0, to: Responsible.self) }

final class Watched: @unchecked Sendable {
  let lock = NSLock()
  var pid: pid_t = 0
  var data = ""
  func get() -> (pid_t, String) { lock.lock(); defer { lock.unlock() }; return (pid, data) }
  func set(_ p: pid_t, _ d: String) { lock.lock(); pid = p; data = d; lock.unlock() }
}
let watched = Watched()
Thread.detachNewThread {
  while let line = readLine() {
    let parts = line.split(separator: " ", maxSplits: 2).map(String.init)
    if parts.first == "app" { watched.set(pid_t(parts.count > 1 ? parts[1] : "0") ?? 0, parts.count > 2 ? parts[2] : "") }
    if parts.first == "quit" { break }
  }
  exit(0)
}

func property(_ entry: io_registry_entry_t, _ key: String) -> Any? {
  IORegistryEntryCreateCFProperty(entry, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
}
let accelerator = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOAccelerator"))
let hid = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"))
var className = [CChar](repeating: 0, count: 128)
IOObjectGetClass(accelerator, &className)

/// Graphics time each process has used since it began, in ns, summed over its clients of the accelerator; and the
/// name each client gives its process.
var clientNames: [pid_t: String] = [:]
func graphicsTimes() -> [pid_t: UInt64] {
  var out: [pid_t: UInt64] = [:]
  var children = io_iterator_t()
  guard accelerator != 0, IORegistryEntryGetChildIterator(accelerator, kIOServicePlane, &children) == KERN_SUCCESS else { return out }
  defer { IOObjectRelease(children) }
  while true {
    let child = IOIteratorNext(children)
    if child == 0 { break }
    defer { IOObjectRelease(child) }
    // "pid 607, WindowServer"
    guard let creator = property(child, "IOUserClientCreator") as? String, creator.hasPrefix("pid "),
          let pid = pid_t(creator.dropFirst(4).prefix { $0.isNumber }) else { continue }
    if let comma = creator.firstIndex(of: ",") { clientNames[pid] = creator[creator.index(after: comma)...].trimmingCharacters(in: .whitespaces) }
    let usage = property(child, "AppUsage") as? [[String: Any]] ?? []
    out[pid, default: 0] += usage.reduce(0) { $0 + ((($1["accumulatedGPUTime"]) as? NSNumber)?.uint64Value ?? 0) }
  }
  return out
}

/// Every process, as the kernel lists them to anyone (the system's own too): its parent, when it began, its name.
struct Proc { let ppid: pid_t; let start: Double; let name: String }
func processes() -> [pid_t: Proc] {
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
  var size = 0
  sysctl(&mib, 4, nil, &size, nil, 0)
  let stride = MemoryLayout<kinfo_proc>.stride
  var list = [kinfo_proc](repeating: kinfo_proc(), count: size / stride + 64)
  size = list.count * stride
  guard sysctl(&mib, 4, &list, &size, nil, 0) == 0 else { return [:] }
  var out: [pid_t: Proc] = [:]
  for p in list.prefix(size / stride) where p.kp_proc.p_pid > 0 {
    let start = p.kp_proc.p_un.__p_starttime
    let name = withUnsafeBytes(of: p.kp_proc.p_comm) { String(cString: $0.bindMemory(to: CChar.self).baseAddress!) }
    out[p.kp_proc.p_pid] = Proc(ppid: p.kp_eproc.e_ppid, start: Double(start.tv_sec) + Double(start.tv_usec) / 1e6, name: name)
  }
  return out
}
func path(_ pid: pid_t) -> String {
  var buffer = [CChar](repeating: 0, count: 4096)
  return proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 ? String(cString: buffer) : ""
}
func cpuTime(_ pid: pid_t) -> UInt64? {
  var info = rusage_info_v4()
  let ok = withUnsafeMutablePointer(to: &info) { p in
    p.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
  }
  return ok == 0 ? ns(info.ri_user_time + info.ri_system_time) : nil
}
/// The app's processes: the app, those the system holds it responsible for, those running from its data folder, and
/// everything any of them started. An app started from a terminal is not responsible for itself: the terminal is, and
/// for the WebKit processes the app's web views ask for too. Those are the system's WebKit processes the app's
/// responsible process has had since the app began. Not a WebKit of another program's own, as Playwright's that the
/// headless checks run from the same terminal (on 2026-11-20 its nine seconds were counted as the app's at rest).
func family(_ root: pid_t, _ data: String, _ all: [pid_t: Proc]) -> Set<pid_t> {
  guard root > 0, let app = all[root] else { return [] }
  let above = responsible?(root) ?? root
  var mine: Set<pid_t> = [root]
  for (pid, p) in all where pid != root {
    let r = responsible?(pid) ?? 0
    if r == root { mine.insert(pid); continue }
    let file = path(pid)
    if !data.isEmpty, file.hasPrefix(data) { mine.insert(pid) }
    else if r == above, above != root, p.start >= app.start - 0.5, file.hasPrefix("/System/"), file.contains("/com.apple.WebKit.") { mine.insert(pid) }
  }
  var grew = true
  while grew {
    grew = false
    for (pid, p) in all where !mine.contains(pid) && mine.contains(p.ppid) { mine.insert(pid); grew = true }
  }
  return mine
}

func displayInfo(_ id: CGDirectDisplayID) -> [String: Any] {
  let b = CGDisplayBounds(id), mode = CGDisplayCopyDisplayMode(id)
  let screen = NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id }
  // The visible frame (without the menu bar and the Dock), from the bottom-left of the first screen to the top-left.
  let top = NSScreen.screens.first?.frame.height ?? b.height
  let v = screen?.visibleFrame ?? b
  return [
    "id": id, "builtin": CGDisplayIsBuiltin(id) != 0, "main": CGDisplayIsMain(id) != 0, "asleep": CGDisplayIsAsleep(id) != 0,
    "x": b.minX, "y": b.minY, "width": b.width, "height": b.height,
    "visible": [v.minX, top - v.maxY, v.width, v.height],
    "scale": Double(mode?.pixelWidth ?? 0) / max(1, Double(mode?.width ?? 1)),
    "hz": mode?.refreshRate ?? 0, "maxfps": screen?.maximumFramesPerSecond ?? 0,
  ]
}
func displays() -> [CGDirectDisplayID] {
  var ids = [CGDirectDisplayID](repeating: 0, count: 16)
  var count: UInt32 = 0
  CGGetActiveDisplayList(16, &ids, &count)
  return Array(ids.prefix(Int(count)))
}

/// The app's window and its notch panel as they are on screen; windows come front to back, so what is listed before
/// a window lies over it. Ordinary windows of other apps over the window are what can cover it (the system's layers
/// over the whole desktop are see-through).
func windows(_ root: pid_t) -> (win: [String: Any]?, notch: [String: Any]?) {
  guard root > 0 else { return (nil, nil) }
  let all = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
  let frame = { (w: [String: Any]) -> CGRect in CGRect(dictionaryRepresentation: w[kCGWindowBounds as String] as! CFDictionary) ?? .zero }
  let owner = { (w: [String: Any]) -> pid_t in pid_t((w[kCGWindowOwnerPID as String] as? Int) ?? 0) }
  let layer = { (w: [String: Any]) -> Int in (w[kCGWindowLayer as String] as? Int) ?? 0 }
  let alpha = { (w: [String: Any]) -> Double in (w[kCGWindowAlpha as String] as? Double) ?? 1 }
  let mine = all.enumerated().filter { owner($0.element) == root && alpha($0.element) > 0.05 }
  func describe(_ i: Int, _ r: CGRect, ordinary: Bool) -> [String: Any] {
    let above = all[..<i].filter { owner($0) != root && alpha($0) > 0.05 && (!ordinary || layer($0) == 0) }.map(frame).filter { $0.intersects(r) }
    var under = 0
    for y in 0..<16 { for x in 0..<16 {
      let p = CGPoint(x: r.minX + (CGFloat(x) + 0.5) * r.width / 16, y: r.minY + (CGFloat(y) + 0.5) * r.height / 16)
      if above.contains(where: { $0.contains(p) }) { under += 1 }
    } }
    return ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height, "covered": Double(under) / 256, "over": above.count, "layer": layer(all[i])]
  }
  let win = mine.filter { layer($0.element) == 0 }.max { frame($0.element).width * frame($0.element).height < frame($1.element).width * frame($1.element).height }
  let notch = mine.filter { layer($0.element) > 0 }.max { frame($0.element).width * frame($0.element).height < frame($1.element).width * frame($1.element).height }
  return (win.map { describe($0.offset, frame($0.element), ordinary: true) }, notch.map { describe($0.offset, frame($0.element), ordinary: false) })
}

var gpuWas = graphicsTimes()
var cpuWas: [pid_t: UInt64] = [:]
var at = Date().timeIntervalSince1970
var loads = [Double](repeating: 0, count: 3)
print(String(data: try! JSONSerialization.data(withJSONObject: [
  "accelerator": String(cString: className), "model": property(accelerator, "model") as? String ?? "",
  "cores": (property(accelerator, "gpu-core-count") as? NSNumber)?.intValue ?? 0,
  "responsible": responsible != nil, "displays": displays().map(displayInfo), "cpus": ProcessInfo.processInfo.activeProcessorCount,
]), encoding: .utf8)!)
while true {
  // The next whole second of the clock.
  let now = Date().timeIntervalSince1970
  usleep(useconds_t(max(0, (floor(now) + 1 - now) * 1e6 + 2000)))
  let t = Date().timeIntervalSince1970, dt = t - at
  let (root, data) = watched.get()
  let stats = property(accelerator, "PerformanceStatistics") as? [String: Any] ?? [:]
  let gpu = graphicsTimes()
  let all = processes()
  let mine = family(root, data, all)
  // A process that began since the last second counts from nothing; one already known from where it was.
  let since = { (pid: pid_t, now: UInt64, was: [pid_t: UInt64]) -> UInt64 in
    let fresh = (all[pid]?.start ?? 0) > at - 0.5
    let before = was[pid] ?? (fresh ? 0 : now)
    return now >= before ? now - before : 0
  }
  var total: UInt64 = 0, other: (pid_t, UInt64) = (0, 0), server: UInt64 = 0
  for (pid, time) in gpu {
    let d = since(pid, time, gpuWas)
    total += d
    if clientNames[pid] == "WindowServer" { server += d } else if !mine.contains(pid), d > other.1 { other = (pid, d) }
  }
  var procs: [[String: Any]] = [], appGpu: UInt64 = 0, appCpu: UInt64 = 0
  var cpuNow: [pid_t: UInt64] = [:]
  for pid in mine.sorted() {
    let g = gpu[pid].map { since(pid, $0, gpuWas) } ?? 0
    var c: UInt64 = 0
    if let time = cpuTime(pid) { cpuNow[pid] = time; c = since(pid, time, cpuWas) }
    appGpu += g; appCpu += c
    procs.append(["pid": pid, "name": all[pid]?.name ?? "", "path": path(pid), "gpu": g, "cpu": c])
  }
  gpuWas = gpu; cpuWas = cpuNow; at = t
  let (win, notch) = windows(root)
  let ids = displays()
  let on = ids.first { id in win.map { CGDisplayBounds(id).contains(CGPoint(x: ($0["x"] as! CGFloat) + ($0["width"] as! CGFloat) / 2, y: ($0["y"] as! CGFloat) + ($0["height"] as! CGFloat) / 2)) } ?? false }
    ?? ids.first { CGDisplayIsBuiltin($0) != 0 } ?? CGMainDisplayID()
  let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
  let power = IOPSCopyPowerSourcesInfo()?.takeRetainedValue()
  let source = power.flatMap { IOPSGetProvidingPowerSourceType($0)?.takeUnretainedValue() as String? } ?? ""
  getloadavg(&loads, 3)
  let idle = ((property(hid, "HIDIdleTime") as? NSNumber)?.doubleValue ?? 0) / 1e9
  let pointer = CGEvent(source: nil)?.location ?? .zero
  var line: [String: Any] = [
    "t": (t * 1000).rounded() / 1000, "dt": (dt * 1000).rounded() / 1000,
    "gpu": ["device": stats["Device Utilization %"] ?? -1, "renderer": stats["Renderer Utilization %"] ?? -1, "tiler": stats["Tiler Utilization %"] ?? -1],
    "all": total, "ws": server, "other": ["pid": other.0, "name": clientNames[other.0] ?? all[other.0]?.name ?? "", "gpu": other.1],
    "app": ["pid": root, "gpu": appGpu, "cpu": appCpu, "procs": procs],
    "display": displayInfo(on), "locked": (session["CGSSessionScreenIsLocked"] as? Bool) ?? false,
    "console": (session[kCGSessionOnConsoleKey as String] as? Bool) ?? true,
    "ac": source != "Battery Power", "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled,
    "thermal": ProcessInfo.processInfo.thermalState.rawValue, "load": (loads[0] * 100).rounded() / 100,
    "idle": (idle * 10).rounded() / 10, "pointer": [pointer.x, pointer.y],
  ]
  if let win { line["win"] = win }
  if let notch { line["notch"] = notch }
  print(String(data: try! JSONSerialization.data(withJSONObject: line), encoding: .utf8)!)
}
