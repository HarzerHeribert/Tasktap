import Foundation
import FoundationModels

// Default checks are deterministic. --model also exercises real on-device preparation.
@main struct VerifyHandoffRouter {
    @MainActor static func main() async throws {
        let input: [String:Any] = [
            "capture":"Could you follow that up to the testing, not the adjustment session? The glow on the note, I mean notch, should be better. On any screen without a notch use a small tab from the screen top, above the menu bar. Keep the physical camera cutout unchanged.",
            "estimateDifficulty":false,
            "projects":[["index":0,"name":"Tasktap"]],
            "sessions":[["index":0,"name":"Verify monitor overlays","originalTask":"Test Tasktap screen geometry","project":0,"agent":"codex","state":"Running"],
                        ["index":1,"name":"Adjust notch appearance","originalTask":"Refine the notch shape","project":0,"agent":"codex","state":"Running"]],
            "recentCaptures":[["session":0,"request":"Test Tasktap on screens without a physical notch.","state":"Delivered"]],
            "selection":["project":-1,"session":-1,"mode":"nudge"]
        ]
        let sessions = input["sessions"] as! [[String:Any]]
        precondition(HandoffRouter.explicitContrast(input,sessions:sessions)?["session"] as? Int == 0)
        var duplicate = sessions[0]; duplicate["index"] = 2
        precondition(HandoffRouter.explicitContrast(input,sessions:sessions+[duplicate])?["routeConfidence"] as? String == "ambiguous")
        var locked = input; locked["selection"] = ["session":1,"project":0,"mode":"nudge"]
        precondition(HandoffRouter.explicitContrast(locked,sessions:sessions) == nil)
        var corrected = input; corrected["capture"] = (input["capture"] as! String) + " Actually the adjustment, not testing session."
        precondition(HandoffRouter.explicitContrast(corrected,sessions:sessions)?["session"] as? Int == 1)
        print("PASS: explicit destination contrast, later correction, ambiguity, and manual selection isolation.")
        guard CommandLine.arguments.contains("--model") else { return }
        guard SystemLanguageModel.default.isAvailable else {
            print("SKIP: Apple's on-device model is unavailable; browser fixtures do not establish model quality.")
            return
        }
        let result = await HandoffRouter.suggest(input) { _ in }
        let output = try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys])
        FileHandle.standardOutput.write(output + Data("\n".utf8))
        guard result["source"] as? String == "apple" else {
            throw NSError(domain:"VerifyHandoffRouter",code:1,userInfo:[NSLocalizedDescriptionKey:"The local model did not complete the smoke test."])
        }
        precondition(result["mode"] as? String == "nudge", "Lost follow-up intent")
        precondition(result["session"] as? Int == 0, "Ignored the testing, not adjustment correction")
        let quote = result["routeQuote"] as? String ?? ""
        let evidence = result["routeEvidence"] as? String ?? ""
        let sources = [input["capture"] as? String ?? "", "Test Tasktap on screens without a physical notch.", "Verify monitor overlays", "Test Tasktap screen geometry"]
        precondition(!quote.isEmpty && sources.contains { $0.lowercased().contains(quote.lowercased()) }, "Destination quote is not grounded in supplied context")
        precondition(evidence.contains("Verify monitor overlays") || evidence.contains("Test Tasktap screen geometry") || evidence.contains("Test Tasktap on screens without a physical notch."), "Destination evidence does not identify an actual candidate or its linked request")
        let quotes = (result["constraints"] as? [String] ?? []).filter { (input["capture"] as? String ?? "").contains($0) }
        let brief = ((result["brief"] as? String ?? "") + " " + quotes.joined(separator:" ")).lowercased()
        precondition(brief.contains("glow") && brief.contains("tab") && brief.contains("above the menu bar"), "Lost requested appearance or placement")
        precondition(brief.contains("physical") && brief.contains("unchanged"), "Lost physical cutout constraint")
        print("PASS: real on-device preparation preserved the corrected testing destination. Review the printed brief for semantic quality.")
    }
}
