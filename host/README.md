# Tasktap Next (host)

The rebuilt Tasktap that can be tried: the Mac host (Tauri v2) with the notch and the workspace window, running on the new core in `core/`. Its pages are in `ui/`.

## Build and run

    host/scripts/build.sh --open

It builds the pages, the core and the host, and opens `host/target/release/bundle/macos/Tasktap Next.app`. Needs Rust, Node 22 and macOS 13 or later. Quit the installed Tasktap first: its notch sits in the same place and uses the same shortcuts.

The app has its own identity (`io.github.harzerheribert.tasktap.next`) and keeps everything in `~/Library/Application Support/Tasktap Next`: the core's database, the core's copy of itself in `bin/<build>/`, the host's device key, and `host.json` (the workspace window's frame and whether its colours follow Ghostty). It never reads or writes the installed app's data or the trial's.

Tasktap Next is in the Dock and has a menu. Closing the workspace window leaves the notch; the Dock icon brings the workspace back. Quit it with ⌘Q. The core keeps running a minute after the last window is gone, or as long as a terminal runs: quitting never stops a session.

## What works

- **The notch.** Glance, capture with its destination chip (your pick, else where the core's router would send the words, else the default project), Undo, the answer card, results. See the notch section of `docs/rebuild-plan.md`. Its Open shows the session in the workspace.
- **The workspace window.** 1.2's sidebar and surfaces, in 1.2's stylesheets:
  - Surfaces with tabs: New terminal, Split right (⌘D) and Split down (⇧⌘D), nested in both directions; drag a divider to resize, double-click to balance; drag a tab to another surface or to a surface's edge; Move tab to…; Focus surface.
  - Terminals: xterm.js on the core's streams; Menlo 14 on Midnight, or Ghostty's font, colours, cursor, padding and opacity with Follow Ghostty (View menu, on by default, as in 1.2); ⌘C and ⌘V (bracketed paste, no Enter added) and the Copy and Paste buttons; ⌘+, ⌘−, ⌘0 per terminal, remembered in the layout; Find in terminal (⌘F); Release mouse capture.
  - Closing a tab with a live process offers Keep running in background, Stop session and Cancel. Background sessions are listed under their workspace in the sidebar, with their state and a Stop control; clicking one shows its terminal again, continued where it was, with nothing started.
  - The sidebar: Home, then one heading per open workspace, with its attention mark (needs input pulses, a check for an unread result), and its close control, which asks before stopping its sessions. + opens a folder or a closed workspace again, with its layout and history and nothing rerun.
  - A pane shows its session's state (working, needs input, ready, failed, ended) and its question, with the notch's answers (Yes and No, the choices, a reply in your words; a question only the terminal can answer sends the keyboard there).
  - Home lists what needs you, what is in progress and the recent results; a row opens its session's terminal. It lists the agents this Mac has, with a terminal that belongs to no project for signing one in.
  - New task (⌘N) opens the shared capture line, its chip on the workspace shown. The + menu starts a shell or any installed agent in a shell of the workspace.
  - The arrangement is the project's `layouts` record; a terminal it does not mention (a run the core started) gets a place in the selected surface.
- **The motion.** The motion lab's Slats (the default), Glyphs and Resonator, drawn live by `ui/src/motion/` as a backdrop: a band rising from the open notch's foot and across Home's header, never under a word. Its state follows the product (needs you, thinking, working, done, failed, idle), Lumen lays the lab's coloured light and beam over it and then tints the notch's glow too, and it draws nothing while it is still, hidden or under Reduce Motion. View › Appearance… (or the button on Home's header) chooses the style, the palette or a hue, and Lumen, all kept as the core's preferences, and can try the motion with the microphone while the panel is open: macOS asks once, with the reason in `Info.plist`.
- **Keyboard.** A focus move by script never shows a focus ring.

## Deliberately missing

Document and web previews, Preferences, Notebook, Session history and Activity, speech, screen context, the updater, notifications, routing by a model, isolated runs, import from 1.2, Windows, and the themes other than Midnight and Follow Ghostty.

## How it fits together

- `src/core.rs`: the data folder, the copy of the core, the device key, start on demand with `start.lock` as `core/src/client.rs` does it, and the host's own connection (it watches `glance` and sends `input`).
- `src/main.rs`: the bridge of design §12. Each page gets its own core connection, said hello to by the host with its device key; after that the bytes pass through untouched both ways (`bridge_open`, `bridge_send`) and `host.*` calls are answered here (`bridge_host`): `host.notch`, `host.show`, `host.ready`, `host.pick`, `host.clipboard` and `host.appearance`. Also the global shortcuts and the debug channel.
- `src/workspace.rs`: the workspace window, its frame, the application menu and Dock reopening, and Ghostty's configuration (`ghostty +show-config`, appearance keys only).
- `src/notch.rs`, `src/native.rs`, `src/geometry.rs`: the notch panel from `trials/tauri-notch`, with pointer events in place of the 80 ms poll; the folder panel and the clipboard.
- `../ui/`: the pages (`npm run check` type-checks them and tests the shared client and the layout model).

## Checks

    cd ui && npm run check
    cd host && cargo clippy -- -D warnings && cargo fmt --check
    host/scripts/smoke.sh        # the notch and the workspace with the core's fixture agent; PASS or FAIL lines
    host/scripts/measure.sh      # idle cost with the workspace on one idle terminal, launch, typing delay, a burst; after build.sh
    MOTION=1 host/scripts/measure.sh   # the whole app idle on Home, then each backdrop placement drawing at 30 and 60 a second

`smoke.sh` and `measure.sh` drive the app only through its debug channel (`TASKTAP_DEBUG=1`: one command per line on standard input) and run it passive (`TASKTAP_PASSIVE=1`: no window ever takes the keyboard, the app stays out of the Dock and the menu bar, the person's pointer is not watched, and Copy and Paste use a pasteboard of their own), so they are safe to run while you work.
