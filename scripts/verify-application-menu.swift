import AppKit

final class MenuTarget: NSObject {
    var received: String?
    @objc func performCommand(_ item: NSMenuItem) { received = item.representedObject as? String }
}

@main struct VerifyApplicationMenu {
    static func main() {
        _ = NSApplication.shared
        let target = MenuTarget()
        ApplicationMenu.install(target: target, action: #selector(MenuTarget.performCommand(_:)))
        let menu = NSApp.mainMenu!
        precondition(menu.items.map(\.title) == ["Tasktap", "File", "Edit", "View", "Window", "Help"])
        var equivalents = Set<String>()
        for section in menu.items {
            for item in section.submenu!.items where !item.isSeparatorItem {
                if !item.keyEquivalent.isEmpty {
                    let chord = "\(item.keyEquivalentModifierMask.rawValue):\(item.keyEquivalent)"
                    precondition(equivalents.insert(chord).inserted, "Duplicate shortcut: \(item.title)")
                }
                if let command = item.representedObject as? String {
                    precondition(NSApp.sendAction(item.action!, to: item.target, from: item))
                    precondition(target.received == command, "Menu command failed: \(item.title)")
                } else if section.title == "Edit", item.action != nil {
                    precondition(item.target == nil, "Standard actions must follow the responder chain")
                }
            }
        }
        precondition(NSApp.windowsMenu === menu.item(withTitle: "Window")?.submenu)
        precondition(NSApp.helpMenu === menu.item(withTitle: "Help")?.submenu)
        print("PASS: six native menus, unique keyboard shortcuts, command dispatch, editing responder chain, and system Window/Help registration.")
    }
}
