# Tasktap rebuild plan

Written 2026-11-17. This plan replaces [implementation-gap-plan.md](https://github.com/HarzerHeribert/Tasktap/blob/v1.2.0/docs/implementation-gap-plan.md) for anything about structure. [requirements.md](https://github.com/HarzerHeribert/Tasktap/blob/v1.2.0/docs/requirements.md) still defines behavior, except where this plan changes it; each change is marked **Changes a requirement**.

**Since the repository cutover** (see [the last section](#repository-cutover)) this plan is the record of what was decided and why. The paths it names under `native/`, `prototype/` and `scripts/`, the trial's `check.sh` and the documents of 1.0 to 1.2 are no longer in the repository; the links to those documents lead to the tag `v1.2.0`.

## Why rebuild now

The first version was discovery. The idea is now clear:

> Put a thought in. Tasktap works out where it belongs, starts the work, and comes back only when it needs you or has a result.

The current build proves the idea but is shaped by how it grew:

- The app's memory lives in the workspace window's browser storage. The notch gets a relayed copy, so it depends on a window the user may never open.
- One Swift class (`native/main.swift`, about 1,850 lines) handles roughly 90 message types.
- Terminals and agent watching run in about 4,300 lines of Python, so users need Python 3.
- The notch is the whole app loaded a second time in a "notch mode". Eighteen UI files carry notch branches.
- The UI (about 7,900 lines in `prototype/`) builds pages from joined strings, with no types.
- The checks (about 7,700 lines) are as large as the UI and tied to its current markup.

## Goal and quality bar

The end state: one portable core with no Python in it, one shared UI, and a host on each platform that is as thin as it can be made.

The owner set these on 2026-11-17. They outrank convenience in every package.

- **Better, not only rebuilt.** Each phase ends with something the owner can feel is better, or with less code. Preferably both.
- **Least code.** Nothing is carried over because it exists. Each package names what it removes. Every layer ends smaller than it was in 1.2. A new dependency or abstraction must remove more than it adds.
- **One mechanism over several.** Prefer the design that serves many needs with one idea: three input actions for every device, one answer card for agent questions and routing questions, one protocol for this machine and other machines.
- **Fast and light.** The core is driven by events and never polls. Idle means no wakeups. The collapsed notch costs close to nothing. Phase 0 records idle processor use, memory, cold launch time, terminal throughput and typing delay for 1.2, and every later phase must beat or match each number.
- **Decide by evidence.** Where two designs are both plausible, a short trial decides and the result is recorded here.

## Decisions already made

Agreed with the owner on 2026-11-16 and 2026-11-17.

| Topic | Decision |
| --- | --- |
| Structure | Move everything that is not pixels into one headless local service, the core. |
| Flow | Review becomes the exception. A confident route starts at once, with a short undo. |
| Notch | Rebuild as its own small surface with three jobs: glance, capture, answer. |
| Windows | Wanted, after the Mac rebuild. Signing waits until the app leaves the owner's own machines. |
| Other apps' sessions and terminals | Cut. They predate the built-in terminals. |
| Plan usage display | Cut. It reads other apps' stored credentials. |
| Codex Micro | Cut for now. Leave a hole: push to talk, affirm, deny (see [Input actions](#input-actions)). |
| Cloud speech | Keep. Local accuracy is still unproven and larger paid models should stay possible. |
| Checks | Replace most of the 84 scripts with fewer checks against the core. |
| Docs | One short spec. README cut to pitch and install. |

Chosen by the plan's author, open to change before Phase 1 starts:

- **Core language: Rust.** One binary, no Python requirement, terminals on Mac and Windows through one library (`portable-pty`), and the same language as the Windows host (Tauri).
- **UI: TypeScript, strict, with Preact and Vite.** Nobody reads this code by hand, so the type checker is the reviewer that never tires.

## Target structure

```
core/            Rust service "tasktap-core": data, terminals, agents, questions, routing, cloud speech
ui/              TypeScript. Two entry points: workspace and notch. One shared client for the core.
shell/           The host: windows, notch panel, local speech, screen context, updater, menus
```

**Core.** Owns the data in SQLite: thoughts, projects, sessions, questions and answers, results, notes, layout, preferences. Owns every terminal process. Keeps running when the window closes, as the terminal service does today. Never reruns a command after a restart.

**Protocol.** One versioned set of JSON messages: commands with replies, plus an event stream. It is defined in one place and the TypeScript types are generated from it. Transport is a private local socket on Mac and a named pipe on Windows. Keep today's protections: a private folder only the owner can read, an owner check, and a per-launch token.

**Shell.** Gives the UI one pass-through channel to the core, plus a small set of host abilities (windows, file pickers, local speech, permissions). The UI never asks which platform it is on.

**UI.** Holds no durable data. It renders what the core reports and sends commands.

### One host or two

**Decided on 2026-11-17: one host.** Tauri on Mac and Windows. The trial reproduced the notch with about 60 lines of Mac-specific code using public interfaces only. With the screen unlocked, its focus behavior measured the same as 1.2 wherever a person can see it, and better in one place: after the notch closes, typing returns to the app in use, where 1.2 keeps the keyboard until that app is clicked. The owner judged the backdrop and the open notch fine. Local speech and screen context stay Swift, as small helpers. What follows is the reasoning as it stood before the trial.

- **One host:** Tauri on Mac and Windows, with Swift kept only for the local speech helper and the few pieces that need it. Least code, one updater, Linux nearly free.
- **Two hosts:** Swift on Mac, Tauri on Windows. More code, but no risk to the notch.

The trial builds the notch panel in Tauri on the Mac: reveal without taking focus, camera-aware placement, the metallic glow, the translucent backdrop. If it matches the 1.2 references, one host wins. Phase 4 builds whichever host the trial chooses.

### Input actions

The core accepts three actions from any source: `capture.hold` (push to talk), `answer.affirm`, `answer.deny`. Keyboard shortcuts are the first source. A Codex Micro, a Stream Deck or a foot pedal can map onto the same three later without touching the rest of the app. This is the hole left for the Micro.

### Keys on Windows (decided 2026-11-18)

Every key the app shows or acts on comes from one place, `ui/src/keys.ts`: the code writes a key as the Mac has it ("⌘T") and asks that file for this system's key, its name, and whether a key press is it. The Mac's keys are unchanged. On Windows the rule is one a person can say:

1. **Ctrl stands where the Mac has Command.**
2. **With a letter, Shift is held too:** New Terminal is Ctrl+Shift+T, New Task Ctrl+Shift+N, Close Tab Ctrl+Shift+W, Find Ctrl+Shift+F. Ctrl with a letter alone belongs to the program in the terminal (Ctrl+C, Ctrl+D, Ctrl+R, Ctrl+W), as in Windows Terminal, and the key is the same wherever the keyboard is: in a terminal, on Home, in the sidebar. One command, one key.
3. **With anything that is not a letter, Ctrl alone:** Ctrl+, opens Settings; Ctrl+=, Ctrl+- and Ctrl+0 size the text; Ctrl+1 to Ctrl+6 are Settings' sections; Ctrl+Backspace is a sheet's dangerous answer (left to a field while one is typed in, where it takes a word out); Ctrl+Enter sends a thought where Return starts a new line.
4. **Four keys are as Windows itself has them:** Undo of a sent thought is Ctrl+Z; back to Home is Alt+Left (Ctrl+[ is Escape to a terminal); a terminal scrolled back returns to its end with Ctrl+End; Split Down is Ctrl+Shift+E, beside Split Right's Ctrl+Shift+D.

In a terminal, Ctrl+Shift+C copies the selection and Ctrl+Shift+V pastes; as in Windows Terminal, Ctrl+C also copies while text is selected (and is the program's otherwise) and Ctrl+V pastes. A link a terminal printed is one while Ctrl is held. Ctrl+Shift with a letter is never passed to the program. Keys are written as Windows writes them: "Ctrl+Shift+T", "Alt+Space", "Esc", "Backspace".

**Hold to talk** is Ctrl+Space where the Mac has Option-Space: Alt+Space opens the window's own menu on Windows, and Ctrl+Alt is AltGr, which types on a German keyboard. **The capture key** stays Alt+Shift+Space. Both can be recorded anew in Settings.

**The app's commands** are behind one menu button at the left of the top row, grouped as the Mac's menus are (File, Edit, View, Window), each with its key; Alt pressed alone, or F10, opens it. The web view's own browser keys are off (F5, Ctrl+R, Ctrl+P, Ctrl+F do nothing of a browser's).

### Speech

Speech sits behind one interface with two directions, dictation (speech to text) and narration (text to speech).

- Local dictation and local voices stay in the Mac shell. The engine was decided by trial on 2026-11-18 (design §8, "On this device"): Whisper large-v3 turbo through whisper.cpp, not WhisperKit and not the system's own recognition, in a helper that lives for one dictation. It is C++ against a C interface, so it is no Swift, and it can be built for Windows later.
- Cloud speech moves into the core. It then works on Windows unchanged, where it will be the main dictation path.

### Door left open: cores on other machines

A possible later product is a "Tasktap agent": the core installed on another machine, controlled from here, with an optional relay to connect them. It is not built in this rebuild. Three rules keep it possible at no real cost now:

- The protocol never assumes the UI and the core share a machine. The UI asks the core for file contents and previews instead of reading the disk itself.
- Every record names the core it belongs to, so one client can later show thoughts from several machines.
- Access is granted per device with a key that can be revoked, not by "same user on the same machine" alone.

## What makes Tasktap different

Two additions. Both exist to make "put a thought in" true, and both are cheap to add while the data model is being rebuilt. Nothing else is added during the rebuild.

### 1. The thought is the main record

Today the app is organised around sessions and terminals, which makes it read as one more terminal multiplexer. In the core, the main record is the thought: what was said, where it went, what is running, what it asked, what came back.

- Every thought has one status: captured, routed, working, needs you, done, failed.
- The notch glance and Home list thoughts, not terminals.
- A terminal is where a thought happens to be running.

### 2. Each thought can run in isolation

**Changes a requirement.** [interaction-design.md](https://github.com/HarzerHeribert/Tasktap/blob/v1.2.0/docs/interaction-design.md) says Tasktap creates no branch or worktree. Starting work without review is only safe if two thoughts in one project cannot overwrite each other.

- In a git project that already has running work, a new thought gets its own worktree and branch.
- The result comes back as a summary plus the changes, with **Keep** and **Discard**.
- Tasktap merges or deletes only when the owner presses one of those.
- Per project setting: isolate when busy (default), always, never.
- Folders without git run in place, as today.

### Deliberately not added

Routing that learns from corrections, phone capture, team sharing. All fit the new structure later. None is needed to make the idea land.

## New flow

**Changes a requirement.** Review is no longer a required step.

1. **Capture.** Global shortcut or notch. Type one line, or hold to talk.
2. **Route.** The router already reports `clear`, `ambiguous` or `unknown`.
   - `clear`: start at once. Show "Sent to X" with **Undo** and **Edit** for a few seconds.
   - `ambiguous`: ask one question, in the same answer card agents use.
   - `unknown`: save as an idea in Notebook. Nothing starts.
3. **Work.** The thought shows as working in the glance.
4. **Needs you.** The notch opens by itself with the question.
5. **Result.** Summary, and changes when isolated, tied to the original thought.

A preference restores "always review first".

## Notch

A separate page with its own entry point. It subscribes to core events and shares no page code with the workspace.

| Job | Behavior |
| --- | --- |
| Glance | Collapsed. Shows counts for working, needs you and done. No hover needed to know if something wants attention. |
| Capture | Global shortcut opens one line. Type and press Enter, or hold to talk. The predicted destination shows as a chip. |
| Answer | Opens by itself when an agent asks. Choices on 1, 2, 3. Hold to talk for a free reply. A visible "1 of 3" when several are waiting. |

- The shortcut is the main way in. Hover stays as a second way.
- Everything else opens the workspace at the right place: routing dialogs, the review sheet, setup, navigation, preferences.
- Keep from today: no focus stealing on passive reveal, camera-aware geometry, the menu-bar fallback on displays without a notch, reduced motion.

### The notch on Windows (proposal, 2026-11-18)

Windows has no notch, and the three jobs are the same. The proposal is the Mac's form for a display without a camera housing, plus one anchor that Windows owns:

- **The tab.** A small frameless, transparent, always-on-top window that hangs centred from the top edge of one display and opens downwards into the same sheet. It is the same page (`notch.html`) on the same geometry: 104 × 16 points on a large display, 120 × 20 on a smaller one, the sheet 420 points wide. Collapsed it shows the glance and lets every click through.
- **The notification-area icon.** Always there, also while the tab is hidden: its tooltip says the counts, a click opens the sheet, its menu has Workspace, New Task and Quit. It is not the glance by itself, because Windows keeps a new icon in the overflow until the person drags it out.
- **The shortcut.** As on the Mac it is the main way in: it opens the sheet with the keyboard, on the display the pointer is on.

How it behaves:

| Case | Behavior |
| --- | --- |
| Taskbar at the bottom or a side | Nothing to do: the tab is at the top, and the sheet ends 12 points above the work area's lower edge. |
| Taskbar docked at the top | The tab hangs from the taskbar's lower edge, never over it. An auto-hidden one leaves the tab at the display's edge, where it covers the strip that reveals the taskbar for the tab's own width only. |
| Several displays | Collapsed, the tab is on the primary display. The shortcut opens the sheet on the display under the pointer, and it folds back to where it was. |
| Different scale factors | The geometry is in points per display; Windows reports pixels. The window is placed and sized again when its display's scale changes. |
| Full-screen apps | The tab hides while Windows says a full-screen app, a presentation or an exclusive Direct3D app is running (`SHQueryUserNotificationState`, the documented rule for notification UI). The shortcut still opens the sheet, since the person asked. A question that arrives meanwhile changes the icon. |
| Keyboard | A passive reveal never takes it: the window is made unfocused and not focusable. For capture and answer it is made focusable and focused, and the window that had the keyboard gets it back at fold. |
| Pointer | Tauri's click-through is the whole window or nothing, so the host turns it on and off from a pointer watcher against the outline the page sends, as on the Mac (Raw Input with `RIDEV_INPUTSINK`, which Microsoft recommends over a low-level hook). |

**What Tauri and WebView2 support, checked on 2026-11-18** against the sources this app builds with (tauri 2.12.6, tao 0.37.2, wry 0.57.2, global-hotkey 0.8.0, tray-icon 0.25.1) and Microsoft's documentation:

- Transparent: `transparent(true)` sets WebView2's background to alpha 0 (it supports only 0 and 255) and the window behind it to DWM's blur with an empty region. `shadow(false)` is needed, or an undecorated window gets a 1-pixel border and, on Windows 11, rounded corners.
- Always on top: `WS_EX_TOPMOST`, set without activating. Microsoft documents only "above all non-topmost windows".
- Not taking the keyboard: `focused(false)` holds for the first show only; every later `show()` is `SW_SHOW`, which activates. So the window is shown once and never hidden by `hide()`, or shown by the host's own call. `focusable(false)` and `set_focusable` (`WS_EX_NOACTIVATE`, since tauri 2.8) keep clicks from activating it.
- Click-through: `set_ignore_cursor_events` adds `WS_EX_TRANSPARENT | WS_EX_LAYERED` to the whole window.
- Taskbar and task switcher: `skip_taskbar` removes the taskbar button (`ITaskbarList::DeleteTab`). `visible_on_all_workspaces` does nothing on Windows.
- Displays: positions and sizes are pixels of the virtual screen with the primary display at the origin; `Monitor::work_area` is what the taskbar leaves; the app is per-monitor DPI aware (set by tao at run time).
- Icon: tauri's `tray-icon` feature (not enabled yet) changes icon and tooltip at run time and reports clicks. A toast needs a Start-menu shortcut with an app id, so it comes with the installer.
- Shortcuts: `RegisterHotKey`; a combination another program holds fails (the app then starts without it and says so in its log). Microsoft advises against Ctrl+Alt combinations, which some keyboard layouts read as AltGr. Today's keys (Ctrl+Alt+Space, J, Y, N) are kept until they are tried on the owner's layout; they should become a preference.
- The microphone: the permission handler the Mac uses exists on Windows too (`PermissionRequested`), and WebView2 remembers the answer in the profile.

**Built now:** the arithmetic (`host/src/tab.rs`: Windows' pixels to the notch's geometry and back, the taskbar and scale cases above, tested on every system) and a Windows host without the tab: the capture shortcut opens the workspace's New Task, Ctrl+Alt+Y and N answer the waiting question, closing the workspace window quits the app (the core and its sessions run on). **Not built, and only checkable at a desktop:** the tab's window, the pointer watcher, the icon, the full-screen rule, handing the keyboard back; whether `SW_SHOW` activates a window that is not focusable, whether a hot key lets the app take the foreground, how a topmost window sits over the taskbar and over full-screen video, whether `DeleteTab` also removes the window from Alt+Tab, and what the tab does across virtual desktops.

## Cut list

Trace callers before deleting. Remove the matching preferences, setup steps, guide text and checks in the same change.

| Cut | Known files |
| --- | --- |
| Other apps' sessions and terminals | `scripts/cmux_host.py`, `cmux_sessions.py`, `cmux-sessions`, `claude_desktop.py`, `desktop_sessions.py`, `extra_terminals.py`, `terminal_hosts.py`, `observer-poc`; `native/TerminalCatalog.swift`; `prototype/terminal-hosts.js`; the external scan in `native/LiveWorkspace.swift` |
| Plan usage | `scripts/plan_usage.py`, `codex_plan.py`, `plan-credentials.swift`, `preview-plan-usage.cjs`; `prototype/plan-usage.js`, `plan-usage.css`. Check whether `worker_usage.py` serves anything else. |
| Codex Micro | `native/Micro.swift` and the hardware requirements that name it |
| Checks | Each phase deletes the scripts it replaces |
| Docs | `implementation-gap-plan.md`, `agent-runtime-report.md` once this plan is done; README sections that repeat the user guide |

Keep, and carry into the core unchanged in behavior:

- The question protocol: requests never change, answers leave a durable receipt.
- Never rerunning a command after restart.
- Routing confidence, and the choice of local or hosted router models.
- Ghostty color import, document and web previews, the signed updater.

## Keep the look

The owner wants the current design and its animations kept. The rebuild changes how the UI is built, not how it looks.

- **Carry over unchanged:** the palette and themes, the layout, and all 26 stylesheets in `prototype/`. New components produce the same class names so the styles keep applying.
- **The chrome and color motion stays:** the rendered loops in `prototype/assets/motion/` (glyph, orbit, phase, relay) with `motion.js` and `motion.css`, the chrome voice wave (`voice-wave.js`), the metallic decision glow (`native/WorkspaceDecisionRim.swift`), and the state animations for working, attention, answer and failure.
- **Keep the tools that make them:** `scripts/render-resonator.py`, `scripts/artwork/`, `render-motion.cjs`.
- **The new notch uses the same visual language.** Its structure is new; its materials, type and motion are not.
- **Proof:** before Phase 4, capture reference screenshots and short clips of every screen and animation from 1.2. Phases 4 and 5 compare against them. Any visible difference is either listed in this plan or a defect.

## Phases

Rules for every phase:

- All work lives on the `rebuild` branch until 2.0. Each phase is built on its own branch and merged into `rebuild` when the owner accepts it. `main` stays 1.2 plus fixes.
- The 1.2 app is left untouched and working until Phase 6 replaces it.
- From Phase 1 on, one check drives the real core through capture, route, run, question, answer and result. It must pass at the end of every phase.
- No features outside this plan.
- The user guide changes in the same change as the behavior.
- No public release until Phase 6 is done, apart from fixes to 1.2. The rebuild ships as 2.0.

| Phase | Work | Done when |
| --- | --- | --- |
| 0. Cut and prepare | Give development builds their own app name and data folder. Record the 1.2 baseline numbers. Apply the cut list to the current app. | A development build cannot read or change the installed app's data or sessions. The baseline is recorded in this plan. The app builds, remaining checks pass, and the cut features are gone from the UI, preferences and guide. |
| 1. Core foundation | The Rust service on its own: protocol, store, records, the state machine and questions. The one-host trial. | The loop check passes against the real service. The idle core shows zero wakeups and memory within target, with the numbers recorded here. |
| 2. Terminals and agents | Terminal processes, sessions, agent launchers and the question flow in the core, proven with a fixture agent and with Claude Code and Codex. A trial of answering agents from outside their terminal. | The loop check runs a real agent in a real terminal. Sessions survive a client disconnecting. Nothing reruns after a restart. |
| 3. Thoughts and flow | Routing, start without review, the Undo hold, ideas, isolated runs with Keep and Discard, cloud speech. | A clear thought starts with no review step. Two thoughts in one git project cannot overwrite each other. |
| 4. Host and notch | The host the trial chose, and the new notch page as the first real client of the core: glance, capture, answer, global shortcut, input actions. | The first build the owner can try. The notch works with no workspace window. A question can be answered with one key from any app. |
| 5. Workspace UI | The workspace in TypeScript components on the core, with the 1.2 look. | The type check passes in strict mode. No page is built from joined strings. Screens and animations match the 1.2 references. |
| 6. Cutover | One-time import from 1.2. Delete the old native code, the old pages and every Python helper. Release 2.0. | Python 3 is no longer required. Imported data matches the source. The old code is gone. |
| 7. Windows | Tauri host, named pipe, Windows terminals, a top-edge pill or tray flyout in place of the notch, cloud dictation, typing first. | The capture to result loop works on Windows 11 with at least one agent. |

Phase 0 notes: `TASKTAP_DEV=1 ./scripts/build-mac.sh` builds `build/Tasktap Dev.app` (bundle id `io.github.harzerheribert.tasktap.dev`); launch it with `open "build/Tasktap Dev.app"`. It keeps its data, terminal service socket and logs in `~/Library/Application Support/Tasktap Dev`, its settings, web storage, keychain items and notifications under its own bundle id, and has no update feed. A plain `./scripts/build-mac.sh` still builds the release identity, which shares the installed app's data, so do not launch that build during the rebuild.

Phase 2 has one loose end: `scripts/kokoro-voice` is a local voice helper that currently runs through Python. Port it into the Mac speech helper or make it an optional download.

Phase 7 notes: check which agent command line tools run natively on Windows at that time, and offer WSL terminals if some do not. Linux is close to free once Windows works. Signing comes when the app leaves the owner's own machines.

## Who builds what

| Work | Agent |
| --- | --- |
| Protocol, data model, thought flow, isolation rules, notch interaction, writing work packages, accepting a phase | Claude Code on the top model (Fable) |
| Building the core in Rust, splitting the Swift shell, the Windows host, the workspace splits and terminals in Phase 5 | Claude Code on Fable (owner's choice from 2026-11-17; Opus before that) |
| Cuts with caller tracing, the file-by-file UI port, rewriting checks, guide updates | Claude Code on Sonnet, several in parallel |
| Independent review of every phase before the owner tries it | Codex on its top model, given the diff and the "done when" line, not the builder's reasoning |

The builder never reviews its own phase. Using a second vendor for review also exercises both agent launchers in daily use.

## Work packages

Packages are written at the start of each phase, not all up front. Later phases depend on what the protocol turns out to be and on what earlier phases teach.

- One package is one agent session and one reviewable change, a few hours of work.
- Each package states: the goal, the files or area, what must not change, the command that proves it, and what done means.
- A package that cannot name its proving command is not ready to hand out.
- Packages within a phase are marked as safe to run side by side or not.

## Checks

Aim for under 20 checks, each named after a promise to the user.

- **Core:** tests that drive the real service through the protocol with real terminal processes running fixture commands. These carry most of the weight.
- **UI:** strict type check, plus a few end-to-end runs: capture to result, answer from the notch, split and restore a workspace.
- **Mac:** build and signature, notch geometry.
- **Windows:** added to CI in Phase 7.

## Status

**Waiting for the owner**

1. Done: `trials/tauri-notch/check.sh` was run. Two focus checks failed and are being investigated against how 1.2 behaves; the look was judged fine apart from a focus outline.
2. Done: the 1.2 baseline is measured and recorded below.
3. Done: Phase 0 was tried. Two defects were found, listed at the end of this plan.
4. Overrule anything in "Changes made while the owner was away" that should not stand.

**Phases**

- Phase 0: built and checked on `rebuild-phase-0` (2026-11-17). 3,979 lines removed, 522 added.
- Phase 1: built, reviewed and fixed on `rebuild-phase-1` (2026-11-17). The core runs the whole loop on its own, from capture to result, with a stand-in for the agent and the router. 167 tests pass on Linux, macOS and Windows. Codex reviewed the design before building and the code after; every finding is fixed. About 8,900 lines of Rust and 10,400 lines of tests. It is not connected to any interface yet, so there is nothing to try by hand. The design is in [core-design.md](core-design.md); the description of 1.2 it was built from is in [rebuild-inventory.md](rebuild-inventory.md).
- Phase 2: started 2026-11-17. Its packages are listed in the design under "Phase 2 work packages".
- Phases 3 to 7: not started.

**Core, measured on 2026-11-17** with `core/scripts/measure.sh` (Apple M4 Pro, two clients subscribed, no terminals, end of Phase 1):

| Measure | Measured | Target |
| --- | --- | --- |
| Idle wakeups and context switches over 60 s | 0 | 0 |
| Processor use while idle | 0.0 % | 0.0 % |
| Memory | 2.5 MB | at most 8 MB |
| Start to accepting connections | 3.1 ms (median of 25, warm) | at most 30 ms |
| Stream rate, core to client | 1,106 MB/s | at least 200 MB/s |
| Stream rate, client to core | 1,039 MB/s | at least 200 MB/s |
| Program size | 4.4 MB | at most 6 MB |

**1.2 baseline, measured on 2026-11-17** on the development build from before the cuts (same machine; one workspace, one idle shell terminal, notch collapsed):

| Measure | 1.2 | How |
| --- | --- | --- |
| Processor use while idle, all processes | 1.1 to 1.3 % | `top` over 60 s, 3 runs |
| Idle wakeups over 60 s, all processes | 77 to 120 | same |
| Context switches over 60 s, all processes | about 10,200 to 11,400 | same; the host's pointer-hover timer accounts for most |
| Memory, all processes | 281 to 282 MB | physical footprint, 3 runs: host 34, workspace page 120, notch page 48, graphics and network 27, Python service and bridge 25, the rest helpers |
| Start to window on screen | 553 ms | median of 3 launches after a full quit |
| Typing delay, key to echo on screen | about 21 ms | median of 3 runs of 30 keys, with the window behind another app |
| Terminal output rate | not measured | a 1.3 MB burst made 1.2 lose its terminal connection after about 5,900 lines |

These are whole-app numbers. The core's numbers above cover only the part that replaces the Python service and the host's logic; the fair comparison is made once the new host and pages exist.

**One-host trial:** finished, and the decision is one host. Every automated check passes on an unlocked screen. Two focus checks first failed because they compared two different measures; measured the same way, 1.2 and the trial behave alike. Idle memory including the web view processes was 74 MB for the trial against 208 MB for 1.2, mostly because 1.2 loads its full page twice. Still to be checked by eye in Phase 4: other Spaces and full-screen apps, whether the tab blinks when the notch folds, and VoiceOver.

**Carried into Phase 2:** the stricter macOS durability setting, to be decided against measured typing delay; a burst of connections can make clients start extra copies of the core; the Windows pipe relies on a peer check and not yet on an owner-only access list; agent sign-in moves into a Tasktap terminal that belongs to no project.

## Changes made on 2026-11-17 while the owner was away

Each can be overruled. Nothing built so far depends on the answer.

- **The core is built on its own first.** The earlier plan wired the old app into the new core step by step. That needed two temporary layers inside code that is replaced anyway, and all of it would be thrown away if the one-host trial succeeds. Now Phases 1 to 3 build and prove the core through its own protocol, and Phase 4 is the first build the owner can try. This sets aside "each phase ends with something the owner can feel" for Phases 1 to 3.
- **Two more removals in Phase 0**, both found by review: the "Copy & open Claude Code" way of preparing a request, which drove Apple Terminal, and "Resume in Terminal" with "Copy resume command", which could never succeed because nothing wrote the file they read.
- **Agent sign-in still opens Apple Terminal** until Phase 2. Moving it needs a terminal that belongs to no project.
- **Defaults chosen for questions the design raised:** spoken text waits for Enter before it is sent; a clear thought shows "Sent to X" at once and launches when the Undo seconds have passed; a prompt typed by hand into an agent's terminal becomes a thought; sessions still running in 1.2 at the first start of 2.0 are imported as interrupted, with Resume.

## Decisions by the owner on 2026-11-17

1. **Isolated runs: yes.** The owner left this to the plan's author. A thought in a busy git project runs in its own worktree and comes back with Keep and Discard, as described above. Reason: starting work without review is only safe if two thoughts cannot overwrite each other.
2. **Agents: Claude Code and Codex first.** They are the main focus. More agents must be easy to add later: every agent goes through the one adapter interface in the core, and no other part of the core knows an agent by name.
3. **The leftover 1.2 sessions were stopped** with the owner's permission.

## Found by the owner in the Phase 0 build

- The window's close, minimise and zoom buttons are missing.
- Clicking an element shows a focus outline around it, including around the notch.

Neither came from the cuts; both exist in 1.2. The buttons are hidden because the window's background is set while its content view is being installed, which on this macOS leaves the title bar under the page; it is not fixed, since the new host replaces that window. The outline is a keyboard-focus ring: the page moves focus to the notch tab by script whenever the notch opens or folds, and the browser treats that as keyboard focus. The cuts removed a row that used to cover most of it. Fixed for the notch tab on `rebuild-phase-0`. Rule for the new interface: a focus move made by script, not by the keyboard, must not show the ring.

## State on 2026-11-17, evening

**Order changed.** The tryable app was pulled forward: the new host, the notch and the workspace were built before Phase 3, so the owner can use and judge the product while the remaining core work continues.

**Done and merged on `rebuild-phase-2`:**

- Phase 2: terminals, roles, the launcher, the Claude Code and Codex adapters, the local router.
- "Tasktap Next": the Tauri host, the notch and the workspace (terminals, tabs and nested splits, sidebar, Home, keep-in-background, a real window with its buttons, menu and Dock icon). Build with `host/scripts/build.sh`, open `host/target/release/bundle/macos/Tasktap Next.app`. It uses its own data folder and never touches 1.2.
- The notch's new shape and glow, and the question-first view.

**Measured against 1.2**, workspace open on one idle shell:

| Measure | 1.2 | New |
| --- | --- | --- |
| Processor use while idle | 1.1–1.3% | 0.0% |
| Idle wakeups over 60 s | 77–120 | 0–9 |
| Memory | 281 MB | 114–116 MB |
| Launch to window | 553 ms | 321–417 ms |
| Printing 1.3 MB at once | connection lost | 141 ms, every line |

**In progress:** isolated runs with Keep and Discard (core); the chrome motion as a backdrop with its preferences; the layered Home design.

**Still to come:** building the Instrument look into the app; model-backed routing and cloud speech; previews, Preferences, session details, terminal links; cutover and import from 1.2 with deletion of `native/`, `prototype/` and the Python service; Windows; one independent review per phase.

**Known open items:** keyboard shortcuts in the workspace were never pressed with real keys; Claude Code's folder-trust prompt starts on "No, exit"; Codex questions can only be answered in the terminal; a hook guard in one of the owner's Claude plugins cuts waiting permission hooks short and must be switched off for notch answers; Stop also ends `nohup` jobs (owner to confirm that is wanted).

## Design decisions by the owner on 2026-11-17

These replace "Keep the look" for the interface. The chrome identity and motion stay.

1. **The look is Instrument.** The notch grown to window size: one black, hairlines, small radii, a five-bar wave from the icon for state, a chromatic lit edge on the focused tab, metal key caps, sheets hanging from the title bar. Dark only. Mock-ups, tokens and the build brief are in `design/ui-directions/`. 1.2's stylesheets are deleted when it is built.
2. **Home is a layered dashboard.** First layer: what needs the person, what is running, the capture line. Everything else is one step away. It must neither flood nor look empty. The Notebook, Session history and Activity views stay gone.
3. **The notch never says something needs you without showing what.** With a question waiting, the open notch shows the question in full with its answers. No text the person needs in order to act is cut with an ellipsis.
4. **Notch shape.** No outline anywhere. On a display without a camera cutout the collapsed tab has sloped sides (the medium lean); the open sheet is a plain rectangle with straight sides. Attention is a glow from behind the shape, chromatic by default, growing with it.
5. **Motion is live, not video.** Three generated chrome styles: Slats (default), Glyphs, Resonator. The light effect (Lumen) is a switch. Colour is the person's choice, including a free hue. Drop and Ribbon were rejected. The lab is in `design/motion-lab/`.
6. **Motion sits behind the content as a backdrop**, in the open notch and in the workspace, never in a box in a corner, never behind terminal text. Idle is a still frame.
7. **Appearance choices are preferences stored in the core**, so every window follows them. Themes are sets of design values, not a general template engine.
8. **Standing rules:** an icon and its label form one centred row; a focus ring shows for keyboard focus only.
9. **Ambient light.** Soft pools of coloured light breathe slowly behind Home, in the colours of the chosen palette, tinted by state. It is light, not a picture: no edges, never behind terminal text, still at rest and a loop while something goes on (the rule below). The sharp chrome form sits in it as an object. A rendered chrome form behind text was tried and rejected.

**The owner's choices on the first Instrument build (2026-11-17), all built:**

- The capture field is the Composer: the thought, then a row with the destination and a button that says what Return does. The other two variants are gone. Its destinations open in its own row, so they cover nothing.
- The ambient light keeps its default strength and one tempo (`--t-ambient`; 24 s then, 12 s since the second build, below); the fainter and stronger lights and the other tempos are gone.
- The sidebar's glyphs stay at its foot: few, large (100, 76 and 64 px), there only where the rows leave room, each a picture drawn once that sways and never turns edge-on.
- The wiper's trail stays, as a wake: three to five of the same glyphs, each readable, shed in order by the moving edge and gone within half a second.
- The ambient light's setting and the terminal's font, size and line height are preferences of the core (`motion_ambient`, `terminal_font`, `terminal_size`, `terminal_line_height`); the pages keep nothing of their own.
- The terminal's cells are a whole number of pixels wide, as a native terminal's are (Default's 14 is 13.3 px in cells of 8), and every colour keeps 4.5 : 1 on what it is drawn over. Decided by looking at the real app: blocks and bars showed a seam at every cell, and black on a coloured badge could not be read.

Measured, for the app's own processes: light breathing and glyphs swaying 1.6 to 1.7 % of a core on Home and 0.9 % beside a terminal with the machine quiet (2.0 to 2.1 % and 1.6 % with it busy), against 3.1 to 4.6 % before; idle 0.0 %. The pools are most of it: each step of their opacity makes the system composite the window, so they step twice a second, and the compositor carries each glyph to one pose a second. Memory is 131 MB against 129 MB measured back to back on a 2x display.

**The owner's choices on the second Instrument build (2026-11-17 and 18), all built** (`design/ui-directions/NOTES.md` has each in full):

- **One material system.** Every control is one of four materials on one ground: the surface (the Composer), metal (the key, which is the one primary action in view, and key caps: a flat, evenly lit face with the metal at its edges, never a band behind its words), quiet (everything else), and the lit edge (focus and what is live). The Composer's key and Open a folder are the same key.
- **First run is one composition**, centred on the Composer, with Open a folder on its edges. A thought with no folder to go to is **saved for later** ("Save for later", "For later", "Saved for later": one word everywhere; "idea" is gone), and lands on Home with Send to a folder on it.
- **The agents are rings** in the Composer: the lit one runs the next thought, a click on another picks it; an open ring is not signed in; a ring turns while its sessions work and takes the attention colour when one asks. No table of agents on Home; no usage is shown, since the core has none.
- **The sidebar slides with its content**, the whole way on one curve, and its wake lies behind its edge: left of it opening, right of it closing.
- **No scrollbars anywhere.** Where there is more beyond an edge, the content dissolves at that edge only; a terminal scrolled back shows how far and the way to the end.
- **At rest the ambient layer is still** (the owner, 2026-11-18, replacing the rule of the second build that it moves whenever its surface is shown in the window in use). With nothing going on, Home's light and band and the sidebar's glyphs are a still picture and the app's processes use nothing, in front or in the background.
  - **While something goes on it is a loop**, for as long as that lasts, on its own clock and whether or not anything new arrives from the core: agents thinking or working (the band's form drifts, a pulse passes through it every breath or so at uneven intervals, the light breathes, the glyphs sway, at the one tempo and amount); a question waiting (its own gentler insistence, until it is answered: two slow beats in the band, the light and the glyphs at half the amount, no pulse); the voice (the form follows it).
  - **A change of state is a blend from one loop into the next**, from the pose and the pace on screen, beginning small. Only the latest state counts: nothing is queued, nothing replays, nothing starts again from nothing, and nothing freezes afterwards.
  - **A moment is an accent laid over whatever is running**: a result arriving (the light lifts and light passes once along the band), a failure, a region taking focus or the window coming back into use (one reaction). After it the loop goes on, or rest returns.
  - **Rest is the only stillness**: idle; the window not the one in use, hidden, minimised or covered (so a Tasktap in the background costs nothing even while agents work); Home not the view shown (beside terminals only the sidebar's glyphs move, on the same rule); and the effects control below Full.
  - **While anything moves it is drawn at one even cadence from the first frame of a movement to its last, however slow the movement**: in every frame the page is given, up to about 60 a second, whatever the display's rate and however it varies from frame to frame (nothing asks what the rate is: every frame given is drawn except one that comes within 10 ms of the last drawn, and everything moves by the time that passed, never by a count of frames, and by no more than three frames' worth after a stall). Cost is saved by not drawing at rest, never by drawing slowly. What the compositor carries (the light's breath, the glyphs' sway) runs at the display's own rate; and it carries the band too through a lasting loop (agents working, a question waiting): the page draws keyframes of it, each a whole interval early and sooner the faster the form moves, and the compositor fades each into the next, so the page is given no frames while the loop lasts, and what is on screen is no further from the picture drawn in every frame than that picture moves in one refresh (`scripts/carry-check.cjs`; `NOTES.md`, "The lasting loop is carried by the compositor"). A change of state, a moment or the voice is drawn by the page in every frame, as before, and the hand-over either way is at the clocks of that moment. A row or a receipt that comes to Home arrives over a fifth of a second, and the light under its words gives way in the same time.
- **One control for every effect** (the owner, 2026-11-18): Settings › Appearance › Effects, the core's `motion_ambient` as it was (`off`, `still`, `breathing`), now Off, Still and Full. Full is all of the above. Still shows the light and the chrome as a fixed picture and nothing moves by itself: no loop, no pulse, no reaction to focus, no wake, no glint, the marks of work hold a pose, the Composer's lit rim comes and goes at once. Off draws none of it: plain black, no canvas and no WebGL context. What the interface does to show a change of its own (a sheet dropping, the sidebar sliding) stays at every level. The app follows two system settings: while Reduce Motion or Low Power Mode is on, Full behaves as Still (the host tells the page when Low Power Mode begins and ends: `host.power` and the `ui` event `power`, from `NSProcessInfo`).
  Measured in the built app on 2026-11-18 (`scripts/cadence-check.cjs`, `flow-check.cjs`, `cost-check.cjs`, `subpixel-check.cjs`; `scripts/measure-all.cjs` runs them all). Before, through one capture (a thought typed, sent, placed, worked on, answered) the band was drawn in 359 of 636 frames: 60 a second while a state blended in, then 12, then 6, then not at all for up to 451 ms, then a burst; over a pulse, 68 drawings in 7.2 s. After, it is drawn in 638 of 641 frames of the same capture on the 240 Hz display and in 1799 of 1801 frames of 30 s of work on the built-in variable-rate panel (which hands the page frames 13 to 19 ms apart), with no wait over 27 ms. Typing through the capture was never held up, before or after, at any level of the effects: frames at their pace (95th percentile 18 to 19 ms where the page is given 59 a second, worst 24) and a key shown within 19 ms at the 95th percentile, worst 22, none lost; so what was seen as lag was the layer's cadence, not the page. Cost of the app's own processes: at rest 0.0 % of a core, in front or behind; agents working behind other windows, at Still, at Off: 0.0 %; beside a terminal (the glyphs alone) 1.4 %; **Home in front with agents working: 9 to 18 % of one core** (9 % as host 2.9, page 4.0, graphics process 2.2 on the built-in panel and the same on the 240 Hz display; the 60 s run read 18 %), most of it the price of the page being given frames at all, which is why the compositor now carries the loop (built the same day; its cost in the built app is still to be measured, since the screen was locked: `node scripts/cost-check.cjs --minutes 5 --steps 0.8,1.2`). Memory, the app started at each level on the built-in panel at 2x: Full 171 MB, Still 170 MB, Off 118 MB, with no canvas and no WebGL context at Off.
- **The band is a pulsing wave, not a sine, and never straight.** It stands in the icon's S and stays there; a pulse swells its heights from the centre outward and settles, at uneven intervals, its faces turning a little as it passes. Calm: the middle of three amounts. A pulse rises in a second, falls in a little over four and is then at rest (no tail that never ends); one that begins while the last settles joins it.
- **A region answers when it takes focus**: the sidebar's glyphs, Home's light and chrome, or the focused tab's lit edge among terminals; once per entry, and once when the window comes back into use.
- **Settings, the sheets and the keys are one family** (the owner, 2026-11-18; `design/ui-directions/NOTES.md`, section 11). Every sheet is one frame in three sizes, centred on the window whatever the sidebar does, with one foot, a plain drop and no wake: the wake is the sidebar's, where no words are. Settings is one sheet with its sections at its left (Thoughts, Voice, Agents, Appearance, Terminal, About); the Agents sheet is a section of it. Every key is one component in one role, never under 12 px, a hint after its label and gone where there is no room. The core has no preference yet for what Return does, a capture key of the person's own, the hold-to-talk key, or a terminal's colours; none is shown.
- **Frozen by the owner:** how the Appearance settings look, and how the chrome pieces look (their material, lighting, palettes and resolution). The band's pose and motion are the one exception he made.

## The brief: requirements for the routing phase

Every thought keeps the person's words exactly as said, and a **brief**, which is what the agent receives. Spoken thoughts ramble; the gain for large agents is less in deleting filler than in resolving what the rambling leaves unclear.

1. **Clean-up at the speech stage.** Fillers, restarts and self-corrections are removed when speech becomes text.
2. **One fast model call does routing and the brief together**, inside the hold, so it adds no waiting. The brief states the goal, the constraints the person gave, references resolved against the project and the recent session, and what counts as done.
3. **The person's words always travel with the brief**, so the agent can check one against the other.
4. **The brief adds nothing the person did not say.** It may resolve and structure; it may not invent requirements.
5. **An ambiguous thought becomes a question to the person**, not a guess.
6. **The brief is visible during the hold**, so a wrong reading is caught before anything starts.
7. **A short, clear thought passes through unchanged.**
8. **Proof before default.** A set of real rambling thoughts is run raw and briefed through the same agent and the results compared. If the brief does not clearly win, it stays off by default.

## What isolated runs guarantee

Two independent reviews of Keep and Discard kept finding new edge cases in guards added for earlier ones. The feature is therefore being simplified to a guarantee that can be checked, in three tiers:

1. **The promise:** Tasktap never deletes or rewrites anything outside its own folder and its own branches. The only effect on the person's project is that a Keep adds the agent's commits, by the same fast-forward the person would run themselves, and it is as safe as that command: git refuses to overwrite uncommitted, untracked or ignored files, but an edit saved in the very instant git is writing can be lost, exactly as with the person's own `git pull`. There is no undo that touches their folder; if something unexpected happens, Tasktap stops and reports the real state.
2. **As strong as git makes it:** Tasktap's own copies are removed only by Discard, by a successful Keep, or when git itself agrees they are empty at the moment of removal.
3. **Not a goal:** protecting against programs the person configured in their own git settings. Hooks are off and every command is bounded; Tasktap is not a sandbox.

**Isolated runs are finished** (2026-11-17): built, reviewed three times, simplified, and closed. No further review is planned for them. The Windows launch test that failed in about one run in five was a real defect in the core, found and fixed on 2026-11-17: what a client sent just before it disconnected could be dropped while the core was writing to it (for example a keystroke followed by closing the window). Still open on Windows: one large-output test stalled once; real tools and the real app have never run there; CI's old "UI, behavior and documentation" job belongs to 1.2 and fails on this branch until cutover removes it.

**No import from 1.2, no legacy support** (owner, 2026-11-17): "I don't need legacy support; breaking changes welcome and allowed." The import of projects, sessions and history from 1.2 is cut, with its section of the core design (§11). Cutover becomes: the new app replaces the old one and starts empty; `native/`, `prototype/` and the Python service are deleted. Nothing in the new code needs to read, migrate or stay compatible with 1.2's data, protocol or settings.

## Repository cutover

Done on 2026-11-17, on top of `rebuild-phase-2`. The repository now holds one product: `core/`, `ui/` and `host/`, with their design (`design/`), this plan and the core's specification.

- **Removed:** `native/` (the Swift shell), `prototype/` (the pages), the Python terminal service and the agent helpers, the scripts that built, packaged and updated the 1.2 app, its checks, the renderers of its artwork, its design previews, and the documents of 1.0 to 1.2 (requirements, interaction design, controls, releases and their notes). 295 files and about 30,700 lines. Nothing in the new code read any of them. The code of the one-host trial went too, because it compiled 1.2's sources; its result and measurements stay in `trials/tauri-notch/`.
- **Where 1.2 is:** on `main` until this is merged, and at the tag `v1.2.0` for good. The inventory of its contracts stays in [rebuild-inventory.md](rebuild-inventory.md) as history.
- **The public site is untouched,** apart from two links in the guide that now lead to the tag. It still describes 1.2 and still serves 1.2's installer (`site/install.sh`) and update feed (`site/appcast.xml`). Three scripts stay for it: `scripts/build-site.py`, `verify-pages.cjs` and `verify-installer.sh`. Rewriting it is release work.
- **CI checks what exists:** the core on Linux, macOS and Windows; the interface (types, tests, build, and the pages rendered headless on fixture records); the host on macOS (format, lint, the release build, the smoke run); the site and its installer; the Pages deployment from `main` only. The job that tested 1.2 is gone.
- **Left for the release, and not decided here:** the site's wording and pictures; the name (the app is still "Tasktap Next", with its own identifier and data folder); signing, since the built app is not sealed and carries only the linker's ad-hoc signature; an updater for the new app, and what an installed 1.2 is told through the feed it still reads. The key that signs that feed is in the owner's Keychain; how to use it was written in `docs/releases.md`, which is in the history at `v1.2.0`.

**Windows test machine** (2026-11-18): a Windows 11 ARM64 virtual machine in VMware Fusion on the owner's Mac, reached over SSH. `scripts/winvm/test.sh` pushes the current commit into it and runs the core's checks as CI does (x64 under emulation by default, `--arm64` natively); a warm x64 run takes under three minutes against thirteen in CI. `scripts/winvm/README.md` says how it was built and how to restore it. Windows is unactivated; a licence is the owner's decision. First finding from it: the large-output test `tens_of_megabytes_arrive_intact_through_a_slow_client_and_a_reconnect` stalled once on ARM64, the same test that stalled once in CI.

**Owner's picks after the third interface round** (2026-11-18): the tempo and the amount of movement are fine as built. At rest the ambient layer is still; it moves for events (agents working, a question, a result, a capture, a region taking focus). A click on an agent's ring picks the agent for the next thought. Some processor and memory cost for the effects is accepted, with one setting that turns all of them off for people who care or have weak hardware. Open: small hiccups when the app's state changes, felt while typing, are being measured and fixed.

**Core findings of 2026-11-18.** Three unreliable tests were chased to their causes. Two were faults in the tests. One was a product defect, now fixed: a terminal that had just ended could be deleted while its history was still being written, leaving a file nothing would remove. A new test holds that the core changes nothing in the agents' own folders. Known and open on Windows: the system's console host can hold back a line typed in the instant a program's output finishes, until the next key, focus change or resize; that includes an answer Tasktap types into a terminal. Waking the console from the core made the console host itself crash, so it was reverted. To try in the Windows phase: shipping Microsoft's current console (`conpty.dll`, `OpenConsole.exe`) beside the core. Workers that test in Docker must use a build volume of their own; a shared one mixes builds between worktrees.

**The public site in the new design** (owner, 2026-11-18): now that the app's final form and look are settled, the GitHub Pages site is rebuilt in the Instrument look and describes the new app. It is built on this branch and reaches the public only when the rebuild is merged into `main`, where Pages deploys from. Its wording is the owner's to approve. It shows only what is built, uses captures of the new app made from invented data, and replaces the one live screenshot that was taken from the owner's own Mac.

**There are no 1.2 users** (owner, 2026-11-18): he was the only one. The old installer and update feed on the site (`site/install.sh`, `site/appcast.xml`) and their checks are removed with the site rebuild, and the new app simply replaces the old one at release; nothing has to keep working for an installed 1.2.

**The installed 1.2 is gone** (owner, 2026-11-18): the old app, its data and its traces were removed from his Mac at his word. What remains before the new app takes the name: signing, an updater, and renaming "Tasktap Next" to "Tasktap".

**The site as built** (2026-11-18): one product page and a short guide in `site/`, on the app's own token file. At the page's top the app's notch page itself plays one thought from start to result (the built page from `ui/dist`, answered by the stand-in for the host and the core that the page checks use), and the chrome beside it is the app's motion engine in the state the notch shows; the rest are pictures of Home and the workspace on fixture records, cut at the size they are shown, at 1x and 2x. All of that is made by `scripts/render-site.cjs` on a Mac and committed in `site/app/`, so what is published is what was looked at; `build-site.py` only assembles it and refuses anything incomplete or private, and `verify-pages.cjs` holds the pages to their sizes, their words, Reduce Motion, scripts off and the 4.5 : 1 floor. Removed: every capture of 1.2 (the one from the owner's Mac among them), its artwork, guide, installer, update feed and the installer's check and job. Open, and the owner's: the wording, the download area once there is a signed build, and whether Windows is named.

**Windows phase, first pass (2026-11-18).** Done as far as a machine without a signed-in desktop allows; `scripts/winvm/README.md`, "At the desktop", lists what a person has to run and look at next.

- **The host builds and starts.** It compiles and links for x64 and ARM64 with Clippy clean (`scripts/winvm/host.sh`), and `host/scripts/build.ps1` makes a folder that runs as it is, and its zip (about 7 MB): the app, the core, Microsoft's console and the licences. Nothing is signed. The Mac's native code, window chrome and notch panel are behind their platform; on Windows the host reaches the core over its named pipe, each page through a connection of its own. Started over SSH, with no desktop, the built app starts the core, runs the workspace page in WebView2, opens a folder as a workspace and a terminal in it, and `cmd.exe` there answers what is typed (`host/scripts/smoke.ps1`). It does not end when told to quit there, in the VM and on real x64 hardware alike: it says `quitting`, never `quit`, and then sits idle. Whether that is the missing desktop is the first thing the desktop round looks at.
- **The notch on Windows** is proposed in its section above. Only its arithmetic is built; the capture shortcut opens the workspace's New Task meanwhile.
- **The console defect is closed by shipping Microsoft's console.** The typed line that the system's console holds back failed 9 runs of 10 with the system's console and none of 86 with Microsoft's (ConPTY 1.25.261109001), on both architectures, with no console host crash logged. The build bundles it with its licence; the core loads it from its own folder.
- **Real tools' way of being installed is covered.** A tool installed as npm installs it, a batch file around a Node script, gets its arguments intact and none of them runs as a command; a line break in one is refused. A terminal's child is made in its job, so a stop ends everything it started, and so is every program the core runs for its output and the agent a shim adopts. The whole suite passes on both architectures with the tests' agents installed as batch files. No real tool has run there yet: that needs an account, which is the owner's to decide.
- **Open.** What the desktop checklist leaves to a person. The tab's window, its pointer watcher and the notification-area icon. A folder panel (`TASKTAP_PICK` meanwhile). (The workspace's keys on Windows are decided: "Keys on Windows" above.) A proxy configured by script (`HTTPS_PROXY` from the system's settings) is not done. Signing and an installer. PowerShell as the default shell instead of `cmd.exe` is a choice not made.

**Windows on real hardware (2026-11-18).** A second machine runs the Windows checks: a person's x64 PC, "the tower", through the VM's scripts with `--tower` (`scripts/winvm/README.md`). It has a standard account, and while its owner uses it a run takes half its cores at low priority and shows nothing on its screen.

- **A defect the VM could not show, fixed.** A shim ended its agent with `taskkill`, which asks Windows Management Instrumentation, and that service refuses a standard account signed in over SSH; so when a run adopted from a shell was stopped, its agent ran on. One test held it: 13 failures of 13 runs on the tower, with Microsoft's console and the system's, and none ever in the VM, whose account is an administrator. The shim now runs its agent in a job, as terminals and the core's own commands already were, and ends it through that: none of 40 runs failed there, the agent a program or a batch file, and the VM, macOS and Linux pass as before. The tests' watchdog killed through `taskkill` too, so on that machine a stuck test would have waited for ever; it ends the core itself now.
- **What looked like a hang was a minute's wait per run.** The agent the failing test left behind ended when the test's process did; its shim then reported that, found no core, started one, and that core stayed its idle minute holding the run's output open. Nothing in the suite waited for ever.
- **What passes there.** The core, x64 natively: format, Clippy, and the whole suite, now run with `--no-fail-fast` so that one failing file never hides the rest: 383 passed in each of 10 runs, plain and with the agents as batch files, with Microsoft's console and with the system's (10 are ignored: they need a real agent, a key or a desktop). The host: build, Clippy, 19 tests, the folder and its 7.3 MB zip, and the smoke script over SSH. The capture key cannot be registered without a desktop ("requires an interactive window station"); the host then holds none, says so, and refuses a key asked for as taken, which the smoke script now checks.
- **Timings.** The whole of `test.sh` takes 2m 35s there from an empty build folder and about 1m 40s after, on 8 of 16 logical cores at low priority; in the VM today 5m 29s for x64, which is emulated, and 4m 05s for ARM64, each with the core rebuilt. The suite itself, without building, runs 93 to 111 s on the tower, 127 s in the VM natively and 224 s there emulated: most of it is waiting, which hardware does not shorten.
- **Open.** (The desktop round has run: the next paragraph.) ARM64 cannot be built on the tower: its Build Tools have no ARM64 compiler, and adding one needs an administrator. The fixture agent ends by a panic when its output has gone, which Windows records as a crash; that happens only after a test has failed and left it behind.

**Windows at a desktop (2026-11-18).** The tower's owner handed its desktop over, and `scripts/winvm/desktop.sh` ran there: first 23 passes and 2 failures with six pictures, last 50 passes and none with twenty (`scripts/winvm/README.md`, "The rounds of 2026-11-18").

- **A terminal was started two columns wide.** A workspace's deck draws its panes before it knows its own size, and xterm.js's fit answers 2 columns by 1 row for a pane with no room. The page opened every terminal of a workspace it showed at that size and asked for the real one a tenth of a second later; a new shell drew its first prompt in between. On the Mac the shell redraws and little is seen; on Windows `cmd.exe` breaks its prompt after every second character and the console keeps what was drawn. Now the deck measures itself before a pane is drawn, a terminal is opened at the size its pane has, and a size below 20 by 4 is never sent: the terminal keeps the size it has and its pane shows a part of it (`ui/src/workspace/terminal.ts` FLOOR; `scripts/terminal-size-check.cjs` fails on every system without it). The core keeps taking 1 to 1000 columns and rows: it cannot tell a pane from a measurement, and a small screen of another device is a real size.
- **Control-C ended nothing on Windows.** The core is started in a process group of its own so that a client's Control-C leaves it running; Windows takes that as "ignore Control-C" and a process hands it on to what it starts, so every shell and every program in it ignored the key. The core now puts normal handling back before it starts a terminal's program (`core/src/sys.rs`); `control_c_ends_what_runs_in_a_shell_and_the_shell_reads_on` failed there before and holds it on every system.
- **Keys are Windows' own** ("Keys on Windows" above), from `ui/src/keys.ts`; what the pages say names this PC, File Explorer, Credential Manager and Windows Settings there (`ui/src/system.ts`).
- **The window is one dark surface.** No title bar, menu bar or frame of the system's drawing: the page's top row is the title bar, with the menu button at its left and Minimize, Maximize and Close at its right, drawn by the page as Windows 11 draws its own (`host/src/chrome.rs`, `ui/src/workspace/chrome.tsx`). The window keeps a titled window's styles, so Windows still gives it its shadow and round corners, snaps it and opens its menu on Alt-Space; the top row is dragged, double-clicked and right-clicked as a title bar is (WebView2's `app-region`); a small window with nothing to draw lies over the three buttons and answers for them, as Windows Terminal's does, which is what makes Windows offer the Snap layouts under Maximize. Menus the system draws are dark, the frame's hairline is the page's own line colour, and the window is dark from its first picture. The other way, the system's own title bar in the page's colours, is a tenth of the code and was built for one picture (`TASKTAP_CHROME=native`): it is dark too, and it is a second bar above the app's own with the system's icon and name in it, which the Mac's window does not have. No small maintained crate was found that does the first way with real hit-testing (tauri-plugin-decorum, the one usually named, is understood to open the Snap layouts by sending the Win+Z key, which was not verified here), and WebView2's own caption buttons (its window controls overlay) are not in the bindings this version of Tauri builds with; when they are, they can replace the page's three buttons and the window over them.
- **Mica stays.** It is the Windows counterpart of the Mac's material, and with the window dark it is the dark one (the first round's light frame was the light one showing). Behind the page at full strength it shows nothing; it is what the window has behind it where the page lets something through.
- **A folder is kept as a person knows it.** `project.add` kept the canonical path, which on Windows begins with `\\?\`; it keeps the same path without that now, and the pages show any path that way.
- **Closed.** The app that does not end over SSH: at a desktop it is gone within tens of milliseconds.
- **Open.** The dark points in Home's light on a display in high dynamic range (the README's account); the microphone, a second display scale, dragging and Win+arrows, for a person; the capture flow with the fixture agent and a preview beside a terminal, not yet run there.
