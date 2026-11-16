import AppKit
import Sparkle

@MainActor
final class AppUpdates: NSObject, SPUUpdaterDelegate, @preconcurrency SPUStandardUserDriverDelegate {
    private var controller: SPUStandardUpdaterController!
    private var pendingInstall: (() -> Void)?
    private(set) var availableVersion: String?
    var changed: (() -> Void)?
    var prepareToRestart: ((@escaping () -> Void) -> Void)?
    override init() {
        super.init()
        controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: self)
    }
    var automaticallyChecks: Bool { controller.updater.automaticallyChecksForUpdates }
    var snapshot: [String: Any] {
        ["available": availableVersion != nil, "version": availableVersion ?? "",
         "automatic": automaticallyChecks, "readyToRestart": pendingInstall != nil]
    }
    func start() {
        controller.startUpdater()
        changed?()
    }
    func setAutomaticallyChecks(_ enabled: Bool) {
        controller.updater.automaticallyChecksForUpdates = enabled
        changed?()
    }
    func check() {
        if let pendingInstall {
            let alert = NSAlert()
            alert.messageText = "Install update and restart Tasktap?"
            alert.informativeText = "The update is downloaded. Tasktap will save your request before restarting. Embedded terminal processes keep running."
            alert.addButton(withTitle: "Install and Restart")
            alert.addButton(withTitle: "Later")
            if alert.runModal() == .alertFirstButtonReturn { prepareToRestart?(pendingInstall) }
        }
        else { controller.checkForUpdates(nil) }
    }
    // Scheduled checks only raise our badge. Sparkle's standard confirmation,
    // download, signature verification and restart UI opens on an explicit click.
    var supportsGentleScheduledUpdateReminders: Bool { true }
    func standardUserDriverShouldHandleShowingScheduledUpdate(_ update: SUAppcastItem, andInImmediateFocus immediateFocus: Bool) -> Bool { false }
    func standardUserDriverWillHandleShowingUpdate(_ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState) {
        availableVersion = update.displayVersionString
        changed?()
    }
    func standardUserDriverWillFinishUpdateSession() {
        if pendingInstall == nil { availableVersion = nil }
        changed?()
    }
    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem, untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        guard let prepareToRestart else { return false }
        let resume = { [weak self] in self?.pendingInstall = nil; installHandler() }
        pendingInstall = resume
        availableVersion = item.displayVersionString
        changed?()
        prepareToRestart(resume)
        return true
    }
}
