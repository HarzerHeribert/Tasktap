# Tasktap rebuild plan

Written 2026-11-17. This plan replaces [implementation-gap-plan.md](implementation-gap-plan.md) for anything about structure. [requirements.md](requirements.md) still defines behavior, except where this plan changes it; each change is marked **Changes a requirement**.

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

Open until a trial at the start of Phase 1 settles it.

- **One host:** Tauri on Mac and Windows, with Swift kept only for the local speech helper and the few pieces that need it. Least code, one updater, Linux nearly free.
- **Two hosts:** Swift on Mac, Tauri on Windows. More code, but no risk to the notch.

The trial builds the notch panel in Tauri on the Mac: reveal without taking focus, camera-aware placement, the metallic glow, the translucent backdrop. If it matches the 1.2 references, one host wins. Phases 6 and 7 are then rewritten to match.

### Input actions

The core accepts three actions from any source: `capture.hold` (push to talk), `answer.affirm`, `answer.deny`. Keyboard shortcuts are the first source. A Codex Micro, a Stream Deck or a foot pedal can map onto the same three later without touching the rest of the app. This is the hole left for the Micro.

### Speech

Speech sits behind one interface with two directions, dictation (speech to text) and narration (text to speech).

- Local dictation (WhisperKit) and local voices stay in the Mac shell.
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

**Changes a requirement.** [interaction-design.md](interaction-design.md) says Tasktap creates no branch or worktree. Starting work without review is only safe if two thoughts in one project cannot overwrite each other.

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
- The app launches and the capture to result loop works at the end of each phase.
- No features outside this plan.
- The user guide changes in the same change as the behavior.
- No public release until Phase 6 is done, apart from fixes to 1.2. The rebuild ships as 2.0.

| Phase | Work | Done when |
| --- | --- | --- |
| 0. Cut and prepare | Give development builds their own app name and data folder. Record the 1.2 baseline numbers. Apply the cut list to the current app. | A development build cannot read or change the installed app's data or sessions. The baseline is recorded in this plan. The app builds, remaining checks pass, and the cut features are gone from the UI, preferences and guide. |
| 1. Core and data | Rust service, SQLite store, protocol, event stream. One-time import from browser storage and the JSON files. Both web views read and write through the core. | The notch works when the workspace window was never opened. Data survives clearing web view storage. |
| 2. Terminals and agents | Terminal processes, session lifecycle, the question inbox and agent launchers move into the core. Python is removed. | Python 3 is no longer required. Sessions survive quitting the app. Nothing reruns after a reboot. |
| 3. Thoughts and flow | Thought record, routing in the core, start without review, undo, ideas in Notebook, isolated runs with Keep and Discard. | A clear thought starts with no review step. Two thoughts in one git project cannot overwrite each other. |
| 4. Notch | New notch page in TypeScript, global shortcut, glance, capture, answer, input actions. This sets up the UI toolchain. | The notch page shares no code with the workspace page. A question can be answered with one key from any app. |
| 5. Workspace UI | Move the workspace to TypeScript components. Rename `prototype/` to `ui/`. Demo data becomes a separate mode. | The type check passes in strict mode. No page is built from joined strings. Screens and animations match the 1.2 references. |
| 6. Mac shell | Split `main.swift`. The shell keeps only windows, notch panel, local speech, screen context, updater, menus. | No Swift file over 400 lines. The shell handles host abilities and the pass-through, nothing else. |
| 7. Windows | Tauri host, named pipe, Windows terminals, a top-edge pill or tray flyout in place of the notch, cloud dictation, typing first. | The capture to result loop works on Windows 11 with at least one agent. |

Phase 0 notes: `TASKTAP_DEV=1 ./scripts/build-mac.sh` builds `build/Tasktap Dev.app` (bundle id `io.github.harzerheribert.tasktap.dev`); launch it with `open "build/Tasktap Dev.app"`. It keeps its data, terminal service socket and logs in `~/Library/Application Support/Tasktap Dev`, its settings, web storage, keychain items and notifications under its own bundle id, and has no update feed. A plain `./scripts/build-mac.sh` still builds the release identity, which shares the installed app's data, so do not launch that build during the rebuild.

Phase 2 has one loose end: `scripts/kokoro-voice` is a local voice helper that currently runs through Python. Port it into the Mac speech helper or make it an optional download.

Phase 7 notes: check which agent command line tools run natively on Windows at that time, and offer WSL terminals if some do not. Linux is close to free once Windows works. Signing comes when the app leaves the owner's own machines.

## Who builds what

| Work | Agent |
| --- | --- |
| Protocol, data model, thought flow, isolation rules, notch interaction, writing work packages, accepting a phase | Claude Code on the top model (Fable) |
| Building the core in Rust, splitting the Swift shell, the Windows host, the workspace splits and terminals in Phase 5 | Claude Code on Opus |
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

- Phase 0: in progress since 2026-11-17.
- Phases 1 to 7: not started.

## Open decisions for the owner

1. **Isolated runs.** This reverses the earlier rule that Tasktap never creates a branch or worktree. Recommended: yes, as described above.
2. **Agents.** Six are supported today (Claude Code, Codex, Antigravity, Cursor, Pi, OpenCode). Recommended: carry Claude Code and Codex into the core first and add the others back as they are actually used.
