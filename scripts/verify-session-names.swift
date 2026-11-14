import Foundation
typealias RouterJSON = [String:Any]
struct RouterFailure: Error { init(_ message:String) {} }
@main struct VerifyNames {
 @MainActor static func main() async throws {
  var time=Date(), calls=0, accepted=0
  let names=SessionNames(clock:{time},interval:.milliseconds(20))
  names.generate={ _ in calls += 1; return "Testing signed app updates" }
  names.changed={ _,_,_ in accepted += 1 }
  var row=["id":"fixture","state":"Running","task":"Build updater","activity":"Checking installation"]
  names.receive([row]);try await Task.sleep(for:.milliseconds(120))
  precondition(calls==1 && accepted==1)
  names.receive([row]);try await Task.sleep(for:.milliseconds(80));precondition(calls==1)
  row["activity"]="Checking relaunch";names.receive([row]);try await Task.sleep(for:.milliseconds(80));precondition(calls==1)
  time=time.addingTimeInterval(181);try await Task.sleep(for:.milliseconds(80));precondition(calls==2)
  row["activity"]="Unrelated idle messages";row["state"]="Idle";time=time.addingTimeInterval(181)
  names.receive([row]);try await Task.sleep(for:.milliseconds(80));precondition(calls==2)
  print("Naming skips unchanged and idle sessions and enforces the per-session refresh interval.")
 }
}
