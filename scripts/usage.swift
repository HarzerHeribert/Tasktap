// What processes have used since they began, as the system itself counts it (proc_pid_rusage), one JSON object by
// process id: processor time in ns and the part of it on the performance cores, instructions and cycles, wakeups from
// idle (package idle exits and interrupts), and energy in nJ. Two readings some time apart say what an interval cost.
// Instructions say how much work was done whichever cores did it and however fast they ran; processor time alone
// reads about twice as high for the same work once the system has moved it to the efficiency cores.
// usage: swift scripts/usage.swift <pid> ...   (processes of the same user)
import Darwin
import Foundation

var base = mach_timebase_info_data_t()
mach_timebase_info(&base)
let ns = { (t: UInt64) -> UInt64 in t * UInt64(base.numer) / UInt64(base.denom) }
var out: [String: [String: UInt64]] = [:]
for arg in CommandLine.arguments.dropFirst() {
  guard let pid = Int32(arg) else { continue }
  var info = rusage_info_v6()
  let ok = withUnsafeMutablePointer(to: &info) { p in
    p.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V6, $0) }
  }
  if ok != 0 { continue }
  out[arg] = [
    "cpu": ns(info.ri_user_time + info.ri_system_time), "fast": ns(info.ri_user_ptime + info.ri_system_ptime),
    "instructions": info.ri_instructions, "cycles": info.ri_cycles,
    "wakeups": info.ri_pkg_idle_wkups + info.ri_interrupt_wkups, "energy": info.ri_energy_nj,
  ]
}
print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
