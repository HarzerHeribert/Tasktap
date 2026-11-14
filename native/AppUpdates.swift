import AppKit
import Sparkle

@MainActor
final class AppUpdates: NSObject, SPUUpdaterDelegate {
    private var controller: SPUStandardUpdaterController!
    private var pendingInstall: (() -> Void)?
    var prepareToRestart: ((@escaping () -> Void) -> Void)?
    override init() {
        super.init()
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
    }
    func check() {
        if let pendingInstall { prepareToRestart?(pendingInstall) }
        else { controller.checkForUpdates(nil) }
    }
    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem, untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        guard let prepareToRestart else { return false }
        let resume = { [weak self] in self?.pendingInstall = nil; installHandler() }
        pendingInstall = resume
        prepareToRestart(resume)
        return true
    }
}
