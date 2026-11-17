# Tasktap Next (host)

The first build of the rebuilt Tasktap that can be tried: the Mac host (Tauri v2) and the new notch, running on the new core in `core/`. Its pages are in `ui/`.

## Build and run

    host/scripts/build.sh --open

It builds the pages, the core and the host, and opens `host/target/release/bundle/macos/Tasktap Next.app`. Needs Rust, Node 22 and macOS 13 or later. Quit the installed Tasktap first: its notch sits in the same place and uses the same shortcuts.

The app has its own identity (`io.github.harzerheribert.tasktap.next`) and keeps everything in `~/Library/Application Support/Tasktap Next`: the core's database, the core's copy of itself in `bin/<build>/`, and the host's device key. It never reads or writes the installed app's data or the trial's.

Quit it with ⌘Q while the notch or Peek has the keyboard. The core keeps running a minute after the last window is gone, or as long as an agent's terminal runs.

## What works

- **Glance.** The collapsed tab widens into small wings when something happens: on the left how many thoughts are working, on the right how many need you, are done and unread, or failed. A waiting question also lights the decision rim.
- **Capture.** ⌃⌥Space opens one line with the keyboard in it; Enter sends. The chip under it is the destination: Tab to it, then ↑↓ and Enter pick a project, the Scratch project, or Idea (kept as a note, nothing starts). The first time, Enter or "Add project…" opens a folder panel and adds that folder. After sending, "Sent to X · starts in N s" offers Undo (⌘Z, or the button) until the hold ends; Undo puts the text back in the field.
- **Work.** The thought starts in the core with the default agent (Claude Code first) and shows as working with the agent's last activity line. Click a row, or Tab to it and press Enter, to open Peek. The first run in a folder Claude Code has not seen asks in its terminal whether to trust it; the row then says "Waiting in its terminal", and Peek is where you answer.
- **Answer.** A question opens the notch by itself, without taking the keyboard. It shows the project, agent and thought it belongs to, the prompt and detail, and the choices on 1, 2, 3; Yes and No for a confirm. ⌃⌥Y and ⌃⌥N answer the focused question from any app; ⌃⌥J opens the card with the keyboard. T starts a reply in your own words. With several questions: "1 of N", ←→ or Previous and Next. A question the agent asked in its terminal offers one action: Peek on that session.
- **Results.** A finished thought shows its summary with Open (Peek); a failed one says why. Seen in the open notch for a moment, it is marked read and leaves the glance.
- **Peek.** A plain window with one session's terminal (xterm.js): watch the agent and type into it.
- **Keyboard.** Escape folds the notch and the keyboard goes back to the app in use. A focus move by script never shows a focus ring.

## Deliberately missing

The workspace, speech, screen context, the updater, notifications, routing by a model (pick the project yourself), isolated runs, import from 1.2, Windows, a menu bar item, preferences and themes (the default dark look only).

## How it fits together

- `src/core.rs`: the data folder, the copy of the core, the device key, start on demand with `start.lock` as `core/src/client.rs` does it, and the host's own connection (it watches `glance` and sends `input`).
- `src/main.rs`: the bridge of design §12. Each page gets its own core connection, said hello to by the host with its device key; after that the bytes pass through untouched both ways (`bridge_open`, `bridge_send`) and `host.*` calls are answered here (`bridge_host`): `host.notch`, `host.show` (Peek) and `host.pick`. Also the global shortcuts and the debug channel.
- `src/notch.rs`, `src/native.rs`, `src/geometry.rs`: the notch panel from `trials/tauri-notch`, with pointer events in place of the 80 ms poll.
- `../ui/`: the pages (`npm run check` type-checks them and tests the shared client).

## Checks

    cd ui && npm run check
    cd host && cargo clippy -- -D warnings && cargo fmt --check
    host/scripts/smoke.sh        # the whole loop with the core's fixture agent; prints PASS or FAIL lines
    host/scripts/measure.sh      # idle cost with the notch collapsed, after build.sh

`smoke.sh` drives the app only through its debug channel (`TASKTAP_DEBUG=1`: one command per line on standard input) and runs it passive (`TASKTAP_PASSIVE=1`: no window ever takes the keyboard), so it is safe to run while you work.
