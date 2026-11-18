// The displays as the measurements need them, one JSON object: whether the main display is asleep, whether the
// screen is locked, each display's frame in the desktop, its scale and its refresh rate, and the frames of the large
// windows on screen (frames only: whose they are is nobody's business). With a process id, also that process's
// windows on screen: each one's frame and the share of it that lies under other windows.
// usage: swift scripts/displays.swift [pid]
import CoreGraphics
import Foundation

var ids = [CGDirectDisplayID](repeating: 0, count: 8)
var count: UInt32 = 0
CGGetActiveDisplayList(8, &ids, &count)
let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
let displays = ids.prefix(Int(count)).map { id -> [String: Any] in
  let b = CGDisplayBounds(id), mode = CGDisplayCopyDisplayMode(id)
  return [
    "main": CGDisplayIsMain(id) != 0, "x": b.origin.x, "y": b.origin.y, "width": b.width, "height": b.height,
    "scale": Double(mode?.pixelWidth ?? 0) / max(1, Double(mode?.width ?? 1)), "hz": mode?.refreshRate ?? 0,
  ]
}
var out: [String: Any] = [
  "asleep": CGDisplayIsAsleep(CGMainDisplayID()) != 0, "locked": (session["CGSSessionScreenIsLocked"] as? Bool) ?? false, "displays": displays,
]
// On-screen windows come front to back: what is listed before a window lies over it.
let all = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
let frame = { (w: [String: Any]) -> CGRect in CGRect(dictionaryRepresentation: w[kCGWindowBounds as String] as! CFDictionary) ?? .zero }
out["others"] = all.filter { ($0[kCGWindowAlpha as String] as? Double ?? 1) > 0.05 && ($0[kCGWindowLayer as String] as? Int ?? 0) == 0 }.map(frame)
  .filter { $0.width >= 300 && $0.height >= 200 }.map { ["x": $0.minX, "y": $0.minY, "width": $0.width, "height": $0.height] }
if CommandLine.arguments.count > 1, let pid = Int(CommandLine.arguments[1]) {
  var windows: [[String: Any]] = []
  for (i, w) in all.enumerated() where (w[kCGWindowOwnerPID as String] as? Int) == pid {
    let r = frame(w)
    if r.width < 300 || r.height < 200 { continue }
    // Ordinary windows only: the system's own layers over the whole desktop are see-through.
    let above = all[..<i].filter { ($0[kCGWindowAlpha as String] as? Double ?? 1) > 0.05 && ($0[kCGWindowLayer as String] as? Int ?? 0) == 0 && ($0[kCGWindowOwnerPID as String] as? Int) != pid }.map(frame)
    var under = 0
    for y in 0..<16 { for x in 0..<16 {
      let p = CGPoint(x: r.minX + (CGFloat(x) + 0.5) * r.width / 16, y: r.minY + (CGFloat(y) + 0.5) * r.height / 16)
      if above.contains(where: { $0.contains(p) }) { under += 1 }
    } }
    windows.append(["x": r.minX, "y": r.minY, "width": r.width, "height": r.height, "covered": Double(under) / 256])
  }
  out["windows"] = windows
}
print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
