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

**Decided on 2026-11-17: one host.** Tauri on Mac and Windows. The trial reproduced the notch with about 60 lines of Mac-specific code using public interfaces only. With the screen unlocked, its focus behavior measured the same as 1.2 wherever a person can see it, and better in one place: after the notch closes, typing returns to the app in use, where 1.2 keeps the keyboard until that app is clicked. The owner judged the backdrop and the open notch fine. Local speech and screen context stay Swift, as small helpers. What follows is the reasoning as it stood before the trial.

- **One host:** Tauri on Mac and Windows, with Swift kept only for the local speech helper and the few pieces that need it. Least code, one updater, Linux nearly free.
- **Two hosts:** Swift on Mac, Tauri on Windows. More code, but no risk to the notch.

The trial builds the notch panel in Tauri on the Mac: reveal without taking focus, camera-aware placement, the metallic glow, the translucent backdrop. If it matches the 1.2 references, one host wins. Phase 4 builds whichever host the trial chooses.

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
9. **Ambient light.** Soft pools of coloured light breathe slowly behind Home, in the colours of the chosen palette, tinted by state. It is light, not a picture: no edges, never behind terminal text, still when idle. The sharp chrome form sits in it as an object. A rendered chrome form behind text was tried and rejected.

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
