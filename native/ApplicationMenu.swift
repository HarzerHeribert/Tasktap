import AppKit

/// App menus use the same commands as the workspace and status item. Standard
/// editing and window actions stay in AppKit's responder chain.
enum ApplicationMenu {
    static func install(target: AnyObject, action: Selector) {
        let bar = NSMenu()
        func section(_ title: String) -> NSMenu {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let menu = NSMenu(title: title)
            item.submenu = menu; bar.addItem(item)
            return menu
        }
        func command(_ title: String, _ name: String, _ menu: NSMenu, key: String = "",
                     modifiers: NSEvent.ModifierFlags = .command) {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.target = target; item.representedObject = name
            item.keyEquivalentModifierMask = modifiers; menu.addItem(item)
        }
        func standard(_ title: String, _ selector: String, _ menu: NSMenu, key: String = "",
                      modifiers: NSEvent.ModifierFlags = .command) {
            let item = NSMenuItem(title: title, action: Selector(selector), keyEquivalent: key)
            item.keyEquivalentModifierMask = modifiers; menu.addItem(item)
        }

        let app = section("Tasktap")
        standard("About Tasktap", "orderFrontStandardAboutPanel:", app)
        command("Check for Updates…", "updates", app)
        app.addItem(.separator())
        command("Settings…", "prefs", app, key: ",")
        app.addItem(.separator())
        let services = NSMenu(title: "Services")
        let servicesItem = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        servicesItem.submenu = services; app.addItem(servicesItem); NSApp.servicesMenu = services
        app.addItem(.separator())
        standard("Hide Tasktap", "hide:", app, key: "h")
        standard("Hide Others", "hideOtherApplications:", app, key: "h", modifiers: [.command, .option])
        standard("Show All", "unhideAllApplications:", app)
        app.addItem(.separator())
        command("Quit Tasktap", "quit", app, key: "q")

        let file = section("File")
        command("New Capture", "capture", file, key: "n")
        command("Open Workspace…", "menu-open-workspace", file, key: "o")
        file.addItem(.separator())
        command("New Terminal", "menu-pane-terminal", file, key: "t")
        command("New Browser Preview…", "menu-pane-browser", file, key: "t", modifiers: [.command, .option])
        file.addItem(.separator())
        command("Close View", "menu-close", file, key: "w")

        let edit = section("Edit")
        standard("Undo", "undo:", edit, key: "z")
        standard("Redo", "redo:", edit, key: "z", modifiers: [.command, .shift])
        edit.addItem(.separator())
        standard("Cut", "cut:", edit, key: "x")
        command("Copy", "menu-edit-copy", edit, key: "c")
        command("Paste", "menu-edit-paste", edit, key: "v")
        standard("Select All", "selectAll:", edit, key: "a")
        edit.addItem(.separator())
        command("Compose Text…", "menu-pane-compose", edit)

        let view = section("View")
        command("Home", "menu-home", view, key: "1")
        command("Notebook", "menu-notebook", view, key: "2")
        command("Session History", "menu-history", view, key: "3")
        command("Activity", "menu-activity", view, key: "4")
        view.addItem(.separator())
        command("Toggle Sidebar", "menu-sidebar", view, key: "b")
        command("Split Right", "menu-pane-split-right", view, key: "d")
        command("Split Down", "menu-pane-split-down", view, key: "d", modifiers: [.command, .shift])
        view.addItem(.separator())
        command("Increase Text Size", "menu-pane-text-increase", view, key: "+")
        command("Decrease Text Size", "menu-pane-text-decrease", view, key: "-")
        command("Reset Text Size", "menu-pane-text-reset", view, key: "0")
        view.addItem(.separator())
        command("Show Notch", "home", view)
        command("Review Decisions", "requests", view)
        view.addItem(.separator())
        standard("Enter Full Screen", "toggleFullScreen:", view, key: "f", modifiers: [.command, .control])

        let window = section("Window")
        standard("Minimize", "performMiniaturize:", window, key: "m")
        standard("Zoom", "performZoom:", window)
        window.addItem(.separator())
        command("Open Workspace Window", "workspace", window)
        standard("Bring All to Front", "arrangeInFront:", window)
        NSApp.windowsMenu = window

        let help = section("Help")
        command("Tasktap Help", "menu-help", help)
        command("Run Setup…", "run-setup", help)
        NSApp.helpMenu = help
        NSApp.mainMenu = bar
    }
}
