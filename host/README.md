# Tasktap Next (host)

The rebuilt Tasktap that can be tried: the Mac host (Tauri v2) with the notch and the workspace window, running on the new core in `core/`. Its pages are in `ui/`.

## Build and run

    host/scripts/build.sh --open

It builds the pages, the core and the host, and opens `host/target/release/bundle/macos/Tasktap Next.app`. Needs Rust, Node 22 and macOS 13 or later. Quit the installed Tasktap first: its notch sits in the same place and uses the same shortcuts.

The app has its own identity (`io.github.harzerheribert.tasktap.next`) and keeps everything in `~/Library/Application Support/Tasktap Next`: the core's database, the core's copy of itself in `bin/<build>/`, the host's device key, and `host.json` (the workspace window's frame). It never reads or writes the installed app's data or the trial's.

Tasktap Next is in the Dock and has a menu. Closing the workspace window leaves the notch; the Dock icon brings the workspace back. Quit it with ⌘Q. The core keeps running a minute after the last window is gone, or as long as a terminal runs: quitting never stops a session.

## What works

- **The notch.** Glance, capture with its destination chip (your pick, else where the core's router would send the words, else the default project), Undo, the answer card, results. See the notch section of `docs/rebuild-plan.md`. Its Open shows the session in the workspace.
- **The workspace window**, in Instrument (`design/ui-directions/NOTES.md`; tokens in `ui/src/tokens.css`):
  - Panes with tabs: New terminal (⌘T, or ＋ at the end of the tabs), Split right (⌘D) and Split down (⇧⌘D), nested in both directions; drag a divider to resize, double-click to balance; drag a tab to another pane or to a pane's edge; the focused pane's tab lit, the others' terminals stepped back. No per-pane toolbar: a tab's right-click opens the system's menu with Find, Copy, Paste, text size, Move tab to…, Keep running in background, Stop and Close; the window's menu and keys do the same.
  - Terminals: xterm.js on the core's streams, in one look, Default: Instrument's black, a GitHub-dark palette, Hack 14 with the Nerd Fonts symbols, both shipped with the app, set at the nearest size whose cells are a whole number of pixels wide (so blocks and box lines join) and with every colour kept legible on what it is drawn over; Settings › Terminal sets another installed family, the size and the line height. ⌘C and ⌘V (bracketed paste, no Enter added); ⌘+, ⌘−, ⌘0 per terminal, remembered in the layout; Find in terminal (⌘F); Release mouse capture. Links: a web address, a path that exists (from the terminal's folder; with `:line` and `:line:column` as compilers print them) and a hyperlink a program prints itself are links while ⌘ is held: underlined under the pointer, ⌘-click opens (a web address in the browser, a file of text in the default text editor), ⇧⌘-click shows a file in Finder; where a link's text is not its target, the target stands at the terminal's foot. A plain click is always the program's.
  - A question shows in a strip under its terminal, stated once with its answers as key caps (1 to 9, T to reply, while the strip has the keyboard). A run that worked in its own copy of the project shows its result there with Keep (↩), Discard and Review changes.
  - Every interruption is a sheet hanging from the title bar: closing a live tab (Keep running in background, Stop session, Cancel), stopping a session, closing a workspace, opening a folder, Find, moving a tab, New task (⌘N), a routing question, Keep and Discard and their review, Agents, Settings (⌘,).
  - The sidebar: Home, then each open workspace with its sessions, most urgent first, each with its state mark; a session sent to the background is listed there dimmed, and a click shows its terminal again, continued where it was, with nothing started. ＋ opens a folder or a closed workspace again.
  - Home, in layers: the capture line, what needs you (the first question open in full), changes waiting to be kept, what is running; Results and Ideas as lines that open in place; All results leads to Earlier. The rail at the window's foot says the same in words and opens Agents and Settings.
  - The arrangement is the project's `layouts` record; a terminal it does not mention (a run the core started) gets a place in the selected pane.
- **The light.** Home's light is a few soft pools of the person's motion colour and one low band of the motion's chrome, drawn by `ui/src/motion/`; the sidebar's foot has the same light with a few large chrome glyphs, each a picture drawn once, there only where the rows leave room. At rest all of it is still and costs nothing. While something goes on in the window in use (agents thinking or working, a question waiting) it is a loop for as long as that lasts: the band drifts and pulses (the page draws keyframes of it and the compositor carries it between them, so the page is given no frames while the loop lasts), the pools breathe and the glyphs sway, slowly, on one clock (`--t-ambient`); a change of state blends into the next, a result or a region taking focus is a moment over it. The sidebar's edge and a dropping sheet shed a short wake of the same glyphs. Settings › Appearance chooses the form, the colour or a hue, Lumen, and Effects (Off, Still, Full: the one control over everything that moves by itself; Reduce Motion and Low Power Mode hold Full at Still), all the core's preferences, as are the terminal's font, size and line height; it can try the motion with the microphone while the sheet is open: macOS asks once, with the reason in `Info.plist`. The notch's sheet carries no form; its glow takes Lumen's colours.
- **Keyboard.** A focus move by script never shows a focus ring.

## Deliberately missing

Document and web previews, Preferences, Notebook, Session history and Activity, speech, screen context, the updater, notifications, routing by a model, Windows, and terminal themes other than Default.

## How it fits together

- `src/core.rs`: the data folder, the copy of the core, the device key, start on demand with `start.lock` as `core/src/client.rs` does it, and the host's own connection (it watches `glance` and sends `input`).
- `src/main.rs`: the bridge of design §12. Each page gets its own core connection, said hello to by the host with its device key; after that the bytes pass through untouched both ways (`bridge_open`, `bridge_send`) and `host.*` calls are answered here (`bridge_host`): `host.notch`, `host.show`, `host.ready`, `host.pick`, `host.clipboard` and `host.open`. Also the global shortcuts and the debug channel.
- `src/open.rs`: `host.open` and its rule, which is the host's and not the page's: a web address (http or https), or something that exists inside a folder the person opened in Tasktap or a copy Tasktap made of one, with every link on the way followed first. A file of text opens in the default text editor; anything else, any folder, and anything on request is shown in Finder. Nothing is ever run, and everything else is refused in a sentence. The host knows the folders from the core (`projects`, on its own connection).
- `src/workspace.rs`: the workspace window, its frame, the application menu with the About panel's notices, and Dock reopening.
- `src/notch.rs`, `src/native.rs`, `src/geometry.rs`: the notch panel from `trials/tauri-notch`, with pointer events in place of the 80 ms poll; the folder panel and the clipboard.
- `../ui/`: the pages (`npm run check` type-checks them and tests the shared client and the layout model).

## Checks

    cd ui && npm run check
    cd host && cargo clippy -- -D warnings && cargo fmt --check && cargo test
    host/scripts/smoke.sh        # the notch and the workspace with the core's fixture agent; PASS or FAIL lines
    host/scripts/measure.sh      # idle cost with the workspace on one idle terminal, launch, typing delay, a burst; after build.sh
    MOTION=1 host/scripts/measure.sh   # what the effects cost, per process: at rest behind and in front, agents working and a question waiting on Home (carried, and drawn by the page), beside a terminal, each level's memory
    FLOW=1 host/scripts/measure.sh     # the capture flow, timed: frames and keys while a thought is typed, sent, placed, worked on and answered, at each level
    CADENCE=1 host/scripts/measure.sh  # the band frame by frame: its cadence, its steps and its clocks through a capture and over its pulses
    node scripts/subpixel-check.cjs    # the forms move in hundredths of a pixel (headless; --app for the app's own web view)
    node scripts/carry-check.cjs       # what the compositor carries is the picture the page would draw in every frame (headless, on the graphics card)
    node scripts/measure-all.cjs <folder> --front   # all four in the built app in one run, on every display the Mac has, kept in the folder

`smoke.sh` and `measure.sh` drive the app only through its debug channel (`TASKTAP_DEBUG=1`: one command per line on standard input) and run it passive (`TASKTAP_PASSIVE=1`: no window ever takes the keyboard, the app stays out of the Dock and the menu bar, the person's pointer is not watched, and Copy and Paste use a pasteboard of their own), so they are safe to run while you work. The three measures above say which display their window is on and its refresh rate, put the window where the fewest others are (`DISPLAY_HZ=144` picks the display), and refuse a sleeping, locked or covered screen, on which nothing is drawn. A passive window opens behind the app in use; `--front` on any of the node scripts (the debug channel's `front`) puts it in front of the other apps' windows for the run, without taking the keyboard. `snapshot <page> <file>` on that channel writes a picture of a page as the app itself draws it, with no screen recording permission involved (`SHOTS=<folder> host/scripts/smoke.sh`).
