# Tasktap core design

Written 2026-11-17, revised the same day after two reviews. It follows [rebuild-plan.md](rebuild-plan.md) and uses [rebuild-inventory.md](rebuild-inventory.md) ("inv. §n", "hazard n") as the description of 1.2. A line marked **Changes the plan** departs from the plan's wording. The core is built on its own first; the 1.2 app is not wired into it and keeps working untouched until cutover (§14).

## Summary

1. The core is one small program, written in Rust, that owns everything that is not pixels: the data, the terminals, the agents, the questions, routing and cloud speech.
2. All data lives in one database file that only the core writes. Windows keep nothing. The notch therefore works when the workspace was never opened, and clearing a window's storage loses nothing.
3. Everything that talks to the core uses three ideas and no others: **records** a client can watch, **calls** it can make, and **streams** for terminal bytes. Today about 235 kinds of message, command and file do this work.
4. The same program is also the small tool agents run to say "I started", "I have a question", "I am done". Their reports arrive the moment they happen, so nothing looks at files on a timer any more.
5. The main record is the thought, with one status. One table of rules, in one place, decides every status change. Today four parts of the app write the same status field.
6. An agent's question and a routing question are the same record and the same answer card. An answer is stored before it is sent, and can settle only the question it was shown for.
7. When nothing happens the core does nothing at all: no timers, no wakeups, under 8 MB of memory.
8. Sessions survive closing and quitting the app. An update never ends running work. After a crash or restart nothing starts again by itself.
9. The core is built and proven by itself first. The new notch and workspace are then built on it. Data from 1.2 is copied in once at cutover; the old files are only read.
10. Every window and tool identifies itself, and what each may do is decided call by call. Controlling a core on another machine later adds to the protocol without changing what exists.

## What the design removes

| | 1.2 | This design |
| --- | --- | --- |
| Mechanisms | bespoke messages on 9 channels (inv. §0) | 3 mechanisms on 1 channel |
| UI → host message types | 92, plus 2 clipboard ops | 40 calls (25 core, 15 host); 22 types disappear |
| Host → UI | 50 named entry points + 45 `workspaceCommand` actions | 0 events: 15 record collections; 1 call `ui.do` with 23 actions |
| Terminal protocol | 12 socket ops + 9 bridge ops, base64 in JSON lines | 3 calls + 1 binary stream |
| Agent ↔ app | about 25 kinds of run-folder, inbox and service file; 2 MCP tools | 6 calls: `session.event`, `session.adopt`, `question.ask`, `question.withdraw`, `question.received`, `shim.hold` |
| Whole protocol | about 235 kinds | 64 calls (44 core, 18 host, 1 page, 1 shim) in 10 frame kinds |
| Recurring timers | 7: 50 ms, 80 ms, 0.2 s, 0.7 s, 8 s, 20 s, 24 h (inv. §10) | core 0. App 1 (the daily update check) once Phase 4 replaces the 80 ms hover timer |
| Long-lived processes, one agent running | 4: app, Python bridge, Python service, Python `present` wrapper; +1 polling `ask-user` per open question; a Python start per hook event and per 8 s scan | 2: app and core; one native start (about 2 ms) per hook event. An agent started by hand in a shell keeps one sleeping shim, as today |
| Languages in the core's area | Python, Swift, JavaScript, Node (observers), AppleScript, shell | Rust |

## 1. Shape of the protocol

Commands and host abilities are the same mechanism pointed in different directions, so there are **three** mechanisms, not four.

| Mechanism | What it is | Covers |
| --- | --- | --- |
| **Records** | A connection subscribes to whole collections. It gets a snapshot at revision R, then every later change in order. Rows arrive whole. The core is the only writer, so there is nothing to merge. | all state: what `shared-state`, the 50 entry points and every "status" query do today |
| **Calls** | `call {id, name, args}` → `reply {id, ok \| err}`. Any side can call another: pages and tools call the core; the core and the pages call `host.*`; the host calls `ui.do`; the core calls `shim.hold`. One name table, one error shape. | every action, and every host ability |
| **Streams** | Numbered byte channels opened by a call. Raw binary frames with byte credit in both directions. | terminal output and input, file and preview bytes, dictation audio |

```ts
type Frame =                                   // kind 0: one JSON object
  | { t: "hello"; v: [min: number, max: number]; role: "page" | "host" | "cli"; client: string;
      auth?: { device: Id; key: string; register?: { name: string } } | { token: string }; abilities?: string[] }
  | { t: "welcome"; v: number; core: Id; build: string; as: "device" | "session" | "none"; calls: string[] }
  | { t: "refuse"; why: "auth" | "revoked" }
  | { t: "call"; id: number; name: string; args: object }
  | { t: "reply"; id: number; ok?: unknown; err?: { code: "unknown" | "invalid" | "denied" | "conflict" | "gone" | "failed"; message: string } }
  | { t: "change"; rev: number; snap?: true; sets: { c: Collection; put?: Row[]; del?: Id[] }[] }
  | { t: "credit"; s: number; n: number }      // grant n more bytes on stream s
  | { t: "mark"; s: number; at: number; size?: [cols: number, rows: number]; live?: true; gap?: true; exit?: number | null }
  | { t: "close"; s: number; why?: "done" | "overflow" | "gone" | "denied" }
// kind 1: stream bytes = u32 stream id, then raw bytes
```

**Subscriptions.** `sub {collections}` is the only form: no filters, no limits, one subscription per connection (a second `sub` replaces the first; an empty list ends it). The core answers in one step on its single thread: the snapshot as `change` frames marked `snap` (chunks of at most 256 KiB), then `reply {rev: R}`, then every change after R that touches a named collection. Nothing can fall between the snapshot and the first change. One `change` is one committed transaction, so a client never sees half of it; one too large for a frame is cut like a snapshot, into frames with the same `rev` in a row. Memory-only collections use the same counter. Revisions order changes within one run of the core; a client always starts from a snapshot.

**Live rows only.** Collections hold what is live. A thought is live until it is finished (done or failed, read, settled) and 200 newer finished thoughts exist; its sessions, questions and results are live with it. A row that stops being live is a `del` in the change that caused it. Older thoughts are fetched with `history {before?, limit ≤ 100}`, which returns them with their questions and results; they are not subscribed. This bounds every snapshot. I found no case that needs more.

**Plain data and effects.** `put {c, id, patch, if_rev?}` and `delete {c, id}` write the collections that are plain data (`prefs`, `layouts`, `previews`, the editable fields of `projects` and of notes). Everything with an effect is a named call. Fields the state machine owns are refused by `put`.

Calls without a mark are built in Phase 1; (2), (3) and (6) name the phase that adds the rest. The protocol crate holds only what exists.

| Area | Core calls (44) |
| --- | --- |
| Records | `sub`, `put`, `delete`, `history` |
| Thoughts | `thought.capture`, `thought.update`, `thought.start`, `thought.stop`, `thought.retry`, `thought.read`, `thought.settle` (3; in Phase 1 through the fixture launcher only) |
| Questions | `question.ask`, `question.answer`, `question.withdraw`, `question.received`, `question.focus` |
| Sessions | `session.event`, `session.adopt` (2), `session.resume` (2) |
| Terminals (2) | `terminal.open`, `terminal.resize`, `terminal.stop` |
| Projects | `project.add`, `project.scan`, `project.close` (2) |
| Files | `preview.open` (2), `file.read` (2), `result.export` (3) |
| Input and voice | `input` (affirm and deny now; hold in 3), `dictation.start` (3), `dictation.finish` (3), `dictation.report` (3) |
| Routing and agents | `route.hint` (3), `connection.set` (3), `connection.remove` (3), `connection.login` (3), `connection.models` (3), `agents.detect` (2), `agents.login` (2) |
| Devices and service | `device.revoke`, `core.status`, `core.retire`, `import.v1` (6), `appearance.import` (2) |

**Host abilities (18, Phase 4):** `host.show`, `host.notch`, `host.chrome`, `host.drag`, `host.pick`, `host.save`, `host.open`, `host.clipboard`, `host.permission`, `host.settings`, `host.update`, `host.notify`, `host.context`, `host.model`, `host.dictate`, `host.speak`, `host.speech_model`, `host.pdf`. A host lists the ones it has in `hello`. **Page ability (1):** `ui.do {action, id?}`: 14 menu actions, `close-front`, `navigate`, `hover-enter`, `hover-exit`, `previous`, `next`, `confirm`, `back`, `prepare-update`. **Shim ability (1):** `shim.hold` (§7).

**Records (15).** Stored: `thoughts`, `projects`, `sessions`, `terminals`, `questions` (with the answer inside), `results`, `layouts`, `prefs`, `devices`, `previews`, `connections`. In memory only: `glance` (counts for working, needs you, done; the focused question; a pending core update), `dictation`, `host` (one row per connected host: abilities, notch geometry, update state, permissions, launch at login, speech engines, screen reader), `agents` (installed CLIs, sign-in state, identity).

### How the inventory maps

| Inventory group | Types | Becomes | Disappears |
| --- | --- | --- | --- |
| §1.1 windows, notch, menus | 19 | `host.show {surface, open, key?, at?}` (show and hide workspace, show notch, focus capture, and the five "open the workspace at X" relays), `host.notch`, `host.chrome` (menu state, cursor, backdrop), `host.drag` | `ready` (the handshake), `notch-onboarding` (a preference), `shared-state` (records), `status` and `binary` (the host watches `glance` itself) |
| §1.2 settings, updates, notifications | 11 | `host.settings`, `host.update`, `host.open` (URLs and settings panes), `host.permission` | `application-settings`, `notification-status` (fields of `host`); `notify`, `clear`, `disableNotifications` (the core decides once and calls `host.notify`, which ends the double side effects of hazard 8) |
| §1.3 folders, files, previews | 11 | `host.pick` then `project.add`, `put prefs` or `preview.open`; `preview.open` also resolves relative and file links; `file.read`; `host.pdf`; `host.open`; `result.export` | none |
| §1.4 terminals | 3 (+2) | `terminal.open`, `terminal.resize`, `terminal.stop` and a stream; `appearance.import` (the core runs `ghostty +show-config`); `host.clipboard` | `terminal-input-trace` (typing delay is measured through the protocol) |
| §1.5 sessions, agents, questions | 16 | `thought.capture`, `thought.start`, `thought.retry`, `thought.update` (assign a note), `session.resume`, `question.answer`, `file.read` (answer text), `agents.detect`, `agents.login`, `host.clipboard`, `host.save`, `host.open` | `refresh` (records are pushed), `resume-terminal` and `copy-resume` (already dead: they need `conversation.json`, which nothing writes, hazard 23), `worker-usage` (cut) |
| §1.6 routing, connections, context | 16 | `thought.capture` (routing is part of capture), `thought.stop`, `route.hint` (the destination chip), `connection.*`, `host.context`, `host.pick`, `host.open` | `prepare-open`, `prepare-reply` (the Claude brief session in Terminal.app, cut with the other Terminal.app launches), `ai-settings` (`connections`), `ai-codex-identity` (`agents`), `context-begin` (the host freezes the source app when it opens capture) |
| §1.7 speech | 16 | `dictation.start`, `dictation.finish` (also cancel), `put prefs`, `connection.set`/`remove` (speech keys are connections), `host.speech_model`, `host.permission`, `host.open`, `host.speak` | `speech-status`, `check-kokoro` (fields of `host`) |
| §2 host → UI | 50 + 45 | record changes, call replies, `ui.do` | all 50 entry points; `live-error` and `toast` (a failed call returns `err`); the `hw-*` actions (they go to the core as `input`); 22 actions in all |
| §4 terminal service | 12 + 9 | 3 calls, 1 stream, the `terminals` collection, `project.close` | `watch`, `list`, `attach`, `detach`, `input`, `focus`, `observe`, `open-workspace`, `stop-workspace`, `reconnect`, `resized`, `session-cancelled` |
| §5, §6 agents and questions | files | rows, `session.event`, `question.*` | every run-folder and inbox file, the MCP server, `run-agent`, the receipt and row vocabularies |

The inventory's headings say 15 and 17 types for §1.5 and §1.6; its tables list 16 and 16. The total is 92 either way. Per hazard: versions (1), ids (2), string values (3), state writers (4), growth (5) are settled in §1 and §5; job order (6) and data-path fallback (7) in §3 and §4; page sync (8, 9, 10, 22) by records; backpressure and caps (11, 17, 18) in §2 and §9; reruns (12) in §3; scrollback (13) in §9; schema disagreements (15, 16, 19, 20, 21) by generated types; dead code (23, 24) dropped; test hooks into page internals (25) by §13; socket trust (26) in §2.

## 2. Framing, transport and trust

| Topic | Decision | Reason |
| --- | --- | --- |
| Transport | Unix socket `<data>/core.sock` (mode 0600 in a 0700 folder) on Mac and Linux; an owner-only named pipe on Windows | The plan's private local channel. No loopback TCP: any local program or web page could reach it. |
| Framing | `u32` length (little-endian, counts kind and payload), `u8` kind, payload. Kind 0 is one JSON object in UTF-8, kind 1 is a `u32` little-endian stream id and raw bytes. At most 1 MiB per frame, 64 KiB per data frame. Call ids are `u32`, unique among the caller's pending calls. Revisions and byte offsets are JSON integers below 2^53. | Terminal bytes travel raw: no base64, no escaping, one copy. Control stays JSON, so it is readable and the TypeScript types are generated. Rejected: WebSocket locally; a binary format for control. |
| Streams | Only the core opens a stream, as the result of a call. The caller's args carry the credit it grants for bytes toward it; the reply carries the stream id and the credit the core grants the other way. `credit` adds to a grant, up to 4 MiB outstanding. Either side ends a stream with `close`; frames for a closed stream are dropped and its id is not reused on that connection. Bytes beyond the grant end the connection. | Real backpressure that also works over a slow link. Replaces the 15 s awaited-promise kill (hazard 11) and four different input caps (hazard 18). |
| Bounds | Per connection: 8 MiB of queued control frames (a snapshot counts), 64 pending calls, 64 open streams. Per terminal: 8 queued chunks from its reader thread, which then waits. At most 256 connections. A client over a bound is disconnected; memory never grows to suit a client. | Every queue has a bound. |
| Version | `hello` offers a range; `welcome` names the highest shared integer and lists the call names this core supports, so a newer app disables what an older core lacks. Additions do not bump the version. | A new app can drive an old core that still holds terminals (§3). |
| Bootstrap contract | Frozen forever: the frame layout, `hello.v`, `welcome.v` and `build`, `refuse`, and the calls `core.status` (build, versions, live terminal count) and `core.retire`. With no shared version, `welcome` says `v: 0` and only those two calls work. They need the local user check and nothing else. | Any app can ask any core what it is and ask it to retire. |
| Local peer check | On accept: the peer's user id must equal the core's. The data folder must be 0700 and owned by the user, as today. | Keeps today's protections. |
| Device identity | Each host has a row in `devices` and proves a 32-byte key, stored hashed. A local peer that passed the user check may register itself. `device.revoke` drops its connections at once. Pages use the host's connections. | Identity that can be listed and revoked. A program running as the same user can read the data folder anyway, so the key is identity, not a wall. |
| Session tokens | Each terminal the core starts gets a random token in its environment (`TASKTAP_SOCKET`, `TASKTAP_TOKEN`), stored hashed. | Replaces the per-launch observer token. |

**Authorization is per call.** The core takes the session, the terminal and a question's source from the token, never from arguments.

| Caller | May call |
| --- | --- |
| Device | everything except the token calls below. Only a device may call `question.answer` or `input`. |
| Session token | `session.event`, `session.adopt` (a shell's token), `question.ask`, and `question.withdraw` and `question.received` for its own questions. Nothing else. |
| Local peer with neither | the bootstrap calls, and registering a device. Tools outside Tasktap's terminals get nothing more: other apps' sessions are cut. |

**Other machines, later.** Three additions, none of which changes a frame above: a second `auth` variant that proves a public key, a one-time pairing call, and a relay that carries these same frames between a device and a core that both dial out. Snapshots make reconnects cheap, credit handles latency, and `host.*` calls go to the remote device's own host. None of it is in the Phase 1 types.

## 3. Process model

| Topic | Decision |
| --- | --- |
| Lifetime | Runs while any client is connected, any terminal is alive or a hold timer is armed. When all become false it arms one 60 s timer and exits when it fires. |
| Single instance | An exclusive file lock on `<data>/core.lock`, held for life. A second `serve` exits 0. The lock, not the socket file, is the truth. |
| Start on demand | A client that finds no socket starts `tasktap serve --data <dir>` detached and waits on a pipe for the `ready` line the core writes once it listens. No retry loop. The data folder is always passed; there is no default path (hazard 7). |
| Where it runs from | A copy at `<data>/bin/<build>/tasktap`. Windows cannot replace a running program, and hooks of running sessions keep pointing at the build that started them. Unreferenced builds are deleted at start. |
| Effects happen once | Every call that starts a process names an attempt id. Before spawning, the core commits the attempt with a hash of its arguments. The same id with the same arguments returns the first outcome; with different arguments it is `conflict`. When what was spawned cannot be stored, the core exits non-zero instead of answering, and the next start closes the attempt as `interrupted`. Creates are idempotent on the client-minted id in the same way. |
| Crash recovery | At start, in one transaction: an attempt with no recorded outcome is `interrupted`; terminals marked running by an earlier boot become `lost`, their sessions `ended`, their thoughts `failed (interrupted)`, their open questions `withdrawn`. Hold timers are not restored: a held thought stays `routed` with no timer and waits for the person to press Start. |
| Never rerun | There is no queue to drain and recovery only closes things. A launch happens only inside a call from a live client. The 1.2 start-up relaunch of jobs without receipts (hazard 12) is gone. |
| Durability | SQLite in WAL mode with `synchronous=FULL`: a reply is sent after its transaction is on disk. Writes are state changes only. Whether a commit delays typing is measured before the targets are claimed (§14). |

When a newer app meets a running core it calls `core.status`:

| Running core | Terminals alive | What happens |
| --- | --- | --- |
| Same build | any | Use it. |
| Older | no | `core.retire`: it exits cleanly, the app starts the new one. |
| Older, shared version | yes | Use the old core, with the calls it lists. `core.retire {when: "idle"}` makes it exit when its last terminal ends. `glance` reports the pending update; the UI shows "Finishes updating when running work ends" and "Restart now (ends N sessions)". |
| Older, no shared version | yes | The same two choices from the bootstrap contract, with the workspace waiting. Sessions are never ended without the button. |
| Newer than the app | any | Use it at the shared version. Never retire a newer core. |

Rejected: handing live terminals to a new process (Unix only, and it freezes an in-memory format). Rejected: launchd or systemd activation (a per-platform install step).

## 4. One binary, several roles

The binary is `tasktap` (the service is still "tasktap-core"). All roles but `serve` arrive in Phase 2.

| Role | Run by | Replaces |
| --- | --- | --- |
| `serve` | the host, or any client on demand | `workspace_terminal.py` (service and bridge), `run-agent`, `LiveWorkspace`'s runner, `QuestionInbox` |
| `hook <agent>` / `event <kind>` | an agent's hook or plugin. Forwards the agent's payload unchanged in one `session.event`; the adapter inside the core interprets it. Exits, or waits for an answer when the core says the question can be answered in place | `session_observer.py ingest`, `observers/emit.mjs` |
| `ask` | an agent in a Tasktap terminal. Sends `question.ask`, sleeps on the socket, prints the answer, confirms with `question.received` | `ask-user`, and the `agent-tools` MCP server (`report_result` becomes `event result`) |
| shim: the same file named `claude`, `codex`, … | a person typing the agent's name in a Tasktap shell | `tasktap_shell.py cli`, `Shells/<id>/bin/*` |

**The shim** keeps the rules of `scripts/tasktap_shell.py`. It finds the real executable on the PATH, skipping shim folders. It steps aside (runs the real CLI directly, unobserved) when input or output is not a terminal, for print, help, version and remote modes, for the listed non-interactive subcommands, and when the terminal already has a live observed agent. Otherwise it calls `session.adopt`, adds the hooks, adds the default approval flag only if the person gave no policy of their own, starts the real CLI as its child, waits, restores the terminal modes, and reports the exit. It stays the parent because the core parents only the shell.

Improvements on the hypothesis: (1) **a hook can wait**, so a question can be answered from the notch where the agent allows it (§6); (2) **no wrapper for agents the core launches**: the core is their parent and knows start and exit itself, so `present`, `surface.json`, three lock files and three sources of `process_exited` go; (3) **no MCP server**: `tasktap ask` is an ordinary command; (4) **activity is not written to disk**, only state changes are. This removes the 0.7 s receipt poll, the 8 s scan, the 0.2 s answer poll and every run-folder file.

## 5. Data model

One SQLite file, `<data>/core.db`. Ids are UUID v7 text, minted by whoever creates the record. Every row has `rev`. `PRAGMA user_version` is the schema version; migrations are an ordered list of SQL in the binary, applied in one transaction after a backup made with `VACUUM INTO`; a database newer than the binary is refused with a clear message.

**Core id.** `meta.core_id` is minted once. `welcome` names it, so a client can hold records from several cores. It is not a column on every table: a value that is the same in every row is not data. References never cross cores.

| Table | Important fields | Notes |
| --- | --- | --- |
| `thoughts` | `id`, `text`, `strokes`, `reference`, `source` (typed, voice, terminal, import), `mode` (ask, nudge, note), `phase`, `status`, `reason`, `live`, `project_id`, `session_id`, `brief`, `route`, `agent`, `model`, `workdir` (path, branch, destination branch, base commit, changes: none, pending, kept, discarded), `hold_until`, `read`, `created`, `updated` | The primary record. A note is a thought with mode `note` that stays captured: **no `notes` table**, and an idea can later be started. |
| `projects` | `id`, `name`, `folder` (canonical, unique), `kind` (folder, scratch), `color`, `aliases`, `git`, `isolate` (busy, always, never), `open`, `available` | The id is random; the folder is a field (hazard 2). One built-in scratch row replaces the virtual `@scratch`. |
| `sessions` | `id`, `project_id`, `agent`, `terminal_id`, `adopted`, `state`, `thought_id` (current turn), `turn`, `resume`, `name`, `named_at`, `model`, `cwd`, `exit`, `error`; memory only: `activity`, last 40 activity lines | `log`, `nameHistory`, `producerKey`, `planAccount` are dropped. |
| `terminals` | `id`, `project_id` (may be empty), `kind` (shell, agent, task), `title`, `cwd`, `argv`, `cols`, `rows`, `state` (running, exited, lost), `exit`, `boot`, `offset`, `token_hash` | A terminal can belong to no project (agent sign-in is a `task`). Closing a tab does not touch the row (§9). |
| `questions` | `id`, `thought_id`, `session_id`, `turn`, `source` (agent, permission, router), `kind` (confirm, choice, text), `prompt`, `detail`, `choices`, `reply_via` (core, terminal), `request_key` (unique), `state` (open, answered, withdrawn) | Everything except `state` is written once. |
| `answers` | `question_id` (primary key), `kind` (affirm, deny, choice, text, terminal), `choice`, `text`, `device_id`, `created`, `delivered` | The receipt. Clients see it inside the question. |
| `results` | `id`, `thought_id`, `session_id`, `turn`, `kind` (answer, failure, changes), `summary`, `body` | `body` is fetched with `file.read`. Replaces `answer-NNNN.txt`, `observedAnswers`, the activity list, `seen`, `observerReads`. |
| `attempts` | `id`, `kind` (launch, resume, terminal, settle), `target`, `args_hash`, `started`, `outcome` | §3. |
| `layouts` | `project_id`, `tree` | Opaque to the core. The UI gives a default place to terminals the tree does not mention. |
| `prefs` | `key`, `value` | Keys and value types are fixed in the protocol crate. |
| `devices` | `id`, `name`, `key_hash`, `last_seen`, `revoked` | |
| `previews` (2) | `id`, `project_id`, `path`, `kind`, `title` | Replaces `WorkspaceMedia.json`, which never shrinks. |
| `connections` (3) | `id` (route or speech provider), `model`, `server`, `account`, `has_key`, `consent` | Secrets stay in the OS credential store. |
| `seen_events` | `session_id`, `event` | The event ids already applied, so a repeat is ignored (the guards below). Emptied at start. |
| `meta` | `core_id`, `boot`, `import_v1` | |

### One state machine

Only `state::apply(event)` writes a thought's `phase` and a session's `state`, apart from the store's recovery pass at open (§3). A thought's **status** is derived in the same transaction: **needs you** while the thought has any open question, otherwise its phase (captured, routed, working, done, failed). A session shows `asking` by the same rule. So answering one of several questions does not clear needs you. Event names are the observer's (inv. §5.3). The receipt, row and JS vocabularies (Opening, Opened, Closed, Copied, Delivered, Complete, Connected, Queued, Saved, Last seen, Awaiting agent) are dropped.

| Event | Thought phase | Session state |
| --- | --- | --- |
| `thought.capture` | → captured | – |
| route `clear`; a router question answered; the person picks a destination | captured → routed. The hold timer starts (a preference, 5 s by default; 0 means none) | – |
| route `ambiguous` | stays captured; a router question opens | – |
| route `unknown` | stays captured, mode becomes `note` (an idea) | – |
| hold ends, or `thought.start` | routed → working, after the attempt is committed | new session: starting. Follow-up: delivered as §7 allows |
| `thought.stop` before launch (Undo) | routed → captured | – |
| launch fails | → failed | a new session ends; a follow-up's session is left as it is |
| `ready` | – | starting → idle |
| `turn_started` | working. Binds the waiting follow-up; a prompt typed by hand creates its thought here | → working |
| `activity` | – | – (memory-only text) |
| a question opens | unchanged (status becomes needs you) | unchanged (shows asking) |
| a question is answered or withdrawn | unchanged, except a router question's answer (second row) | unchanged |
| `continued` | –; the turn's terminal-only questions close as answered in the terminal | – |
| `turn_finished` | → done, result stored; the turn's open questions are withdrawn | → idle |
| `turn_failed`, `turn_interrupted` | → failed (reason); the turn's open questions are withdrawn | → idle |
| `exited(code)` | working → failed; done if code 0 from an agent that sends no events | → ended; its open questions are withdrawn |
| `lost` (found at core start) | working → failed (interrupted); routed stays routed, timer gone | → ended |
| `thought.stop` after launch | → failed (stopped) | process stopped, → ended |
| `thought.retry` | failed → routed, unread | – |
| `thought.read` | done or failed: read (finished once nothing is pending, §1) | – |
| `thought.settle` | done or failed; changes pending → kept or discarded | must be ended (§7) |

Guards kept from 1.2: events from an old token, a sub-agent or a different turn are ignored (`session.event` names its turn and whether a sub-agent sent it); event ids are deduplicated; an event that does not fit the current state changes nothing. A question asked in the terminal arrives as such an event and passes the same guards.

## 6. Questions

One record and one flow replace the file inbox (path A) and the observer display (path B).

1. **Ask.** A question is opened by the core's router, by `question.ask` from `tasktap ask`, or by the adapter reading a `session.event`. It is idempotent on `request_key` (for `ask`, the session and its `request` argument; for a hook, the session, turn and the agent's own call id): the same key with the same content is the same question; different content is an error. The key is per session, so one session's token never reaches another session's question. A request never changes. A session holds at most 8 open questions and all sessions together 64 (`MAX_SESSION_QUESTIONS`, `MAX_OPEN_QUESTIONS`); beyond that a new one is `conflict` until one closes.
2. **Show.** The thought's status becomes needs you, `glance` changes, the core calls `host.notify`. `glance.question` is the focused question (the oldest open one unless `question.focus` chose another), so a host can bind the affirm and deny keys with no page running.
3. **Answer.** `question.answer {id, …}` or `input {answer.affirm | answer.deny, question}`, from a device only. One transaction inserts the `answers` row (its key is the question id, so a question is settled once, and only by an answer that names it) and sets `answered`. Answering a withdrawn question is `gone`.

**Lifetime depends on who is waiting.**

| | Terminal-only question (`reply_via: terminal`) | Waited question (`reply_via: core`) |
| --- | --- | --- |
| Opened by | a hook that reports and exits | `tasktap ask`, or a hook that waits. The pending call is the waiter |
| Bound to | its session and turn | that waiter |
| The card | shows the question and "Answer in terminal", which opens that terminal. Affirm and deny do the same | answers it. Affirm and deny act directly on `confirm` and permission questions |
| Closes | on `continued` (answered, kind `terminal`), or withdrawn at turn end or session end | when answered: the stored answer is the call's reply; the waiter prints it and sends `question.received`, which sets `delivered` |
| Waiter disconnects | – | withdrawn at once. If the waiter comes back with the same key while the turn is alive, the same question reopens, or, if it was answered meanwhile, the stored answer is returned again |
| Never delivered | – | the answer stays stored with `delivered` empty and the card says so; turn end closes it |

Nothing waits forever (hazard 10). Merged or dropped: `discussion[]` and the discuss key become a text answer (today the first discussion line already ends the agent's wait); `binary` becomes `confirm`; `producerKey` becomes `request_key`; `reconcileAgentQuestions` becomes withdrawal.

## 7. Agents

```rust
trait Agent {
    fn id(&self) -> &'static str;                                  // "claude"
    fn caps(&self) -> Caps;                                        // events, resume, questions: Core | Terminal | None
    fn detect(&self, env: &Env) -> Health;                         // installed, signed in, identity
    fn launch(&self, l: &Launch) -> Result<Spawn, Error>;          // new run or resume
    fn event(&self, hook: &str, payload: &Value) -> Option<Event>; // runs in the core: the agent's payload → the one vocabulary
    fn reply(&self, hook: &str, answer: &Answer) -> Option<String>;// hook output that answers in place, if the agent allows it
}
struct Launch<'a> { session: Id, cwd: &'a Path, prompt: &'a str, model: Option<&'a str>, resume: Option<&'a str>, hook: &'a Path, token: &'a str }
struct Spawn { argv: Vec<String>, env: Vec<(String, String)>, probe: Option<Probe> }  // probe: a check that must pass before the spawn
```

Three things are the same for every agent and therefore not in the adapter.

**Environment.** The core builds each child's environment from a fixed list (home, user, language, shell, the computed PATH, terminal variables, `TASKTAP_*`). Nothing is inherited from whichever process started the service (hazard 14).

**Follow-ups.** A follow-up is typed into a terminal (bracketed paste, then Enter) only when that terminal's direct child is the agent the core launched and the session is not ended. Then no shell exists underneath that could execute the text. For an adopted session (an agent started by hand inside a shell) the follow-up is offered as text to paste, unless the shim answers `shim.hold`: it confirms its child is alive and in the foreground and keeps the terminal until the core has written the text; if the agent exits meanwhile, the shim discards unread input before it returns to the shell. This replaces `codex queue`, `pbcopy` and the Copied and Delivered states.

**Isolation.** `isolate::prepare(project, thought)` returns the folder to launch in: the project folder, or a new `git worktree` under `<data>/worktrees/` when the project's setting says so (busy means it has a session that is not idle or ended). Git is run as a command.

- A worktree belongs to exactly one thought. Its branch, the destination branch and the base commit are recorded when it is created. Follow-ups to that session work in it; only the owning thought settles it.
- `thought.settle` requires the session to be ended. If it is not, the call is `conflict`; the UI confirms and repeats it with `stop`.
- **Keep** commits what is uncommitted and merges into the recorded destination. It refuses, leaves the branch and worktree in place and says why when the destination has moved in a way that does not merge cleanly, or the worktree is in a state it cannot commit (a merge or rebase in progress, a lock, conflicts).
- **Discard** removes the worktree and branch, and never while any terminal of the core runs inside it.

| | Claude Code | Codex |
| --- | --- | --- |
| New run | `claude [--model M] --settings {hooks} --session-id <session> --permission-mode auto -- <prompt>` | `codex --no-daemon -c hooks.state=… [-c projects={dir trusted}] [--model M] -c hooks.<8>=… --approve-for-me -- <prompt>` |
| Probe | none | `codex app-server` `hooks/list` must show 8 trusted hooks (12 s) |
| Hook command | `tasktap hook claude`, 10 hooks (inv. §5.1) | `tasktap hook codex`, 7 shared hooks + `Interrupt` |
| Events | SessionStart → `ready`; UserPromptSubmit → `turn_started`; Pre/PostToolUse → `activity`; `AskUserQuestion`, PermissionRequest, Notification → a question; Stop → `turn_finished`; StopFailure → `turn_failed` | the same, plus Interrupt → `turn_interrupted`; `request_user_input` → a question |
| Resume | `--resume <session>` once a turn has started (the id is ours) | `resume <thread id>` taken from the hook payload |
| Questions | `terminal` at first; `core` if the Phase 2 trial shows a waiting hook can answer | `terminal` |

The other four, when they return: **Pi** and **OpenCode** have plugins (`observers/pi.mjs`, `observers/opencode`); each shrinks to a few lines that run `tasktap event`, with no resume. **Cursor** and **Antigravity** have no hooks: their thoughts move on launch and exit only, and they can ask through `tasktap ask` if told to in the prompt.

## 8. Routing and speech

```ts
type RouteRequest = { thought: Id; text: string; current?: Id; estimate: boolean;
  projects: { id: Id; name: string; aliases: string[] }[];                                        // ≤ 8
  sessions: { id: Id; name: string; task: string; project: Id; agent: string; state: string }[];  // ≤ 8
  recent: { session: Id; request: string; status: string; result: string }[] }                    // ≤ 3
type RouteResult = { confidence: "clear" | "ambiguous" | "unknown"; mode: "ask" | "nudge" | "note";
  project?: Id; session?: Id; brief: string; quote?: string; evidence?: string; candidates: Id[];
  constraints: string[]; difficulty?: number; scopeEvidence?: string; provider: string; error?: string }
```

- The core builds the request from its own records and applies the acceptance rules of inv. §7.2 once: a session is taken only when confidence is clear, the quote appears in the capture and the session is still eligible; a constraint of 3 to 1000 characters found word for word in the capture but missing from the brief is appended; difficulty counts only for ask, as a whole number 1 to 10, with `scopeEvidence` found in the capture. Ids replace indexes. `agent`, `viewer`, `note` and `question` leave the schema (hazard 20).
- **Consent.** Today a hosted provider is used only after the person has seen the payload and the instructions. With automatic routing that consent is given once per connection: the setup screen shows the instructions and exactly which fields are sent, and the answer is stored in `connections.consent` with the provider, server and model it covers. Changing any of them clears it. Without it, routing uses only the on-device model or the name match.
- Three kinds of provider behind one function: **web** (OpenAI, ChatGPT sign-in, Anthropic, a model server) called by the core; **command** (`codex exec`, `claude -p`) spawned with a time limit; **host** (the on-device model) through `host.model`. A local match on names and aliases answers `route.hint` and is the fallback.
- Session naming runs when a turn event arrives, at most once per 180 s per session. No loop.
- **Dictation** is one in-memory record `{id, phase, text, level, target}`. The host always records. Local engines transcribe in the host and report through `dictation.report`; for cloud engines the host sends the recording as a stream and the core makes the web call. **Narration** is `host.speak`, called by the core once per result.
- Keys live in the OS credential store behind one small module.

## 9. Terminals

| Topic | Decision | Reason |
| --- | --- | --- |
| Library | `portable-pty`. Two sleeping threads per live terminal (one reads, one waits for exit) hand chunks to the core thread through a bounded queue | One code path for Mac, Linux and Windows (ConPTY). Rejected: per-platform asynchronous code; an emulator in the core to keep screen state. |
| Calls | `terminal.open {id, attempt?, project?, shell? \| session? \| task?, cols, rows, from?, credit}` starts or attaches and returns a stream. `terminal.resize`. `terminal.stop` ends the process. | 12 operations become 3 calls and a stream. Size is given at open (hazard 17). |
| Tabs | Closing a tab closes the stream and nothing else: the process keeps running in the background, as today. Stop ends the process and keeps the record and history. History is deleted only by an explicit action, or when the record of a stopped terminal is deleted. `project.close {id, stop}` stops the named terminals and refuses new ones until the project is reopened. | Keeps "Keep running in background" and the workspace fence. |
| Output | The core always drains the terminal into a ring of up to 2 MiB, grown on demand. Each attached client has its own position and is sent bytes as its credit allows. | An agent is never blocked because a window is slow or closed. |
| A client that falls behind | Once its position leaves the ring it gets `mark {gap}` and a fresh replay. | The same path as reconnecting. The ring is larger than the 10,000 lines the page keeps. |
| Reconnect | `terminal.open {from: <last offset>}`: if still in the ring, only the missing bytes; otherwise `gap` and a replay: size marks and bytes from the ring's start, then `mark {live}`. The page mutes query replies until `live`. | No reset when nothing was missed. |
| Resize | One size per terminal, last caller wins. The new size is a `mark` at the exact byte offset, and a field of the record. | Replaces `resized` and its accidental firing (hazard 14). |
| Input | Bytes on the same stream, against credit from the core. No size cap, no chunking rules. | Hazard 18. |
| Scrollback | In memory while the process runs; written to `<data>/scrollback/<id>` when it exits and when the core shuts down; read back on demand. | After quit, reboot or update the history is there (hazard 13). Only a core crash loses it, and then its terminals are gone too while thoughts and results are safe. |
| Stopping | Hang-up to the process group and the foreground group, kill after 2 s (one timer). | As today. |

## 10. Efficiency

One thread owns all state and runs a single-threaded `tokio` runtime, so there are no locks. Blocking work (terminal reads, waiting for exit, web calls, git) sits on plain threads that sleep in the kernel and send a message when something happens.

| Dependency | Why it earns its place | Phase |
| --- | --- | --- |
| `tokio` (current-thread; `net`, `io-util`, `time`, `process`, `signal`, `sync`) | Sockets, named pipes, peer credentials, one-shot timers, child processes with time limits and signals on three systems from one crate | 1 |
| `rusqlite` (bundled SQLite) | The store; calls are synchronous on the core thread | 1 |
| `serde`, `serde_json` | The protocol | 1 |
| `uuid` (v7) | Time-ordered ids clients can mint | 1 |
| `sha2` | Key, token and argument hashes | 1 |
| `ts-rs` (build only) | TypeScript types generated from the Rust protocol types | 1 |
| `portable-pty` | Terminals | 2 |
| `ureq` (rustls) | Web calls on a short-lived thread | 3 |
| `keyring` | API keys in the OS credential store | 3 |

Not used: an argument parser, error or logging crates, an asynchronous HTTP stack, a file watcher, a git library, an MCP library, a terminal emulator.

**Zero idle wakeups.** The core thread waits in the kernel for one of: bytes on a connection, a chunk or an exit from a terminal thread, a signal, or a timer that something armed. Every timer fires once: the hold before launch, the 2 s kill, the 60 s exit, a time limit on a web call or spawned command. Nothing repeats. Projects are scanned when a client asks, not watched. SQLite checkpoints on the write path.

| Measure | Target | 1.2 |
| --- | --- | --- |
| Wakeups while idle (clients connected, terminals quiet), 60 s | 0 | service loop 20 per second, plus 0.7 s and 8 s timers |
| Processor while idle | 0.0 % | from the Phase 0 baseline |
| Memory, no terminals | ≤ 8 MB | two Python processes |
| Memory per running terminal | ≤ 2.2 MiB at full scrollback | 2 MiB in the service + 2 MiB in the bridge |
| Start to accepting connections | ≤ 30 ms | Python start, then up to 60 × 50 ms |
| `tasktap hook` start to exit | ≤ 10 ms | one Python start per event |
| Stream bytes, core to client | ≥ 200 MB/s, and ≥ baseline end to end | base64 JSON, one event per 16 KiB read |
| Delay the core adds to a keystroke | < 0.3 ms, also during a commit and with a slow second client | two JSON hops |
| Binary size | ≤ 6 MB, ≤ 9 MB with TLS | – |

These are targets, not results. Phase 1 measures the first three, start time and stream rate; Phase 2 measures the rest. None is claimed before it is measured.

## 11. Import from 1.2 (Phase 6)

The new store is a new folder, `<appData>/Core/`. The importer opens the old files for reading only, so 1.2 can still run on its own data afterwards.

| Step | Decision |
| --- | --- |
| When | Once, at cutover: the host calls `import.v1` before it connects any page. A store that already imported returns its stored report. |
| Browser storage | Only a page on the old `file://` origin can read `tasktap-live-v1`. The host loads a hidden five-line page from that origin and sends the raw string. This page stays in 2.0 for as long as upgrades from 1.2 are supported. |
| Files | The core reads `Runs/`, `Notes/`, `Scratch/`, `Agent Inbox/`, `WorkspaceFolders.json`, `WorkspaceMedia.json`, `Speech/preferences.json`, `Terminals/Replay/` itself. |
| Settings and keys | The host reads its own `router.*` defaults and keychain items and sends them in the same call. |
| Once, safely | A pure function turns the inputs into rows; one transaction writes them and `meta.import_v1` (time, counts, hash of the blob). A bad row is skipped and counted, never fatal. |
| Mixed ids | Every project gets a new id. A lookup from old id, folder and canonical folder to the new id resolves `session.project`, note assignments and layout keys; two entries for one folder merge; `@scratch` and anything unresolved go to the scratch project. |
| String values | One function reads booleans (`true`, `'true'`, `'yes'`, `1`) and applies each key's default when absent (`useScreenContext` absent means on). Numbers are parsed from strings; ranges are clamped; an unknown theme becomes `ghostty`. |
| Sessions still running in 1.2 | They live in the old Python service and cannot be moved. They are imported as interrupted, with Resume where a handle exists (`observer.json`, `thread.json`), and the app says so once. Nothing is started. |
| Records | `captures` → thoughts by receipt: Saved → captured; Complete, Closed, Delivered, Copied → done; Failed → failed; Queued, Opening, Opened, Running → failed (interrupted), per the row above. `notes`, `Notes/`, `Scratch/` → thoughts with mode `note`, merged by capture id. `decisions`, `answeredDecisions` and inbox files → questions and answers. `session.result`, `observedAnswers`, `answer-NNNN.txt` → results. `layouts`, `media` and the other deck fields → `layouts`, `previews` (only those a tab refers to) and `prefs`. |
| Left behind | `session.log`, name history, the activity list, `notificationFailure`, an unfinished first-run step, plan usage settings, sessions marked `external`, `observer-events.jsonl`, `sessions.json`, `lifecycle.json`. |
| Proof | Fixtures are synthetic, written from the formats in the inventory, with the edge cases (string booleans, mixed ids, external sessions, bad rows). The owner's real data is never copied into the repository, which is public. The test compares the source folder's hashes before and after. |

## 12. Host boundary (Phase 4)

| Stays in the host | Reached through |
| --- | --- |
| Workspace window, notch panel (no focus stealing, camera-aware geometry, hover, screens), decision glow, translucent backdrop | `host.show`, `host.notch`, `host.chrome`, `host.drag`; the host reads `glance` |
| Global shortcuts | the host sends `input`; it binds affirm and deny from `glance.question` |
| Menus and status item | `ui.do`; counts from `glance` |
| Notification delivery and clicks | `host.notify` from the core; a click is `ui.do navigate` |
| Launch at login, updater | `host.settings`, `host.update`, the `host` record |
| Microphone, local dictation engines, their downloads, local voices | `host.dictate`, `host.speech_model`, `host.speak`, `dictation.report` |
| On-device model | `host.model` |
| Screen context (Accessibility, Apple Events) | `host.context` |
| File, folder and save panels; clipboard; opening URLs, apps, Finder, settings panes | `host.pick`, `host.save`, `host.clipboard`, `host.open` |
| Permission prompts (notifications, microphone, automation) | `host.permission`, the `host` record |
| PDF page images, result as PDF | `host.pdf` (bytes come from the core) |
| Preview address handler and navigation policy | serves `file.read` streams from the core; rules unchanged |
| Starting the core, copying its binary, the device key, the import page | host start-up |
| One app instance, VoiceOver flag, window size and position | host only; the flag is a field of `host` |

**The single pass-through.** The host gives each page one object and nothing else:

```ts
interface Bridge { send(frame: string | Uint8Array): void; host(frame: string): void; onframe: (frame: string | Uint8Array) => void }
```

`send` and `onframe` are an untouched pipe to that page's core connection; the host does not parse core-bound frames. `host` carries the `host.*` calls, which the host answers itself, so a window drag never waits for the core. The shared client decides by the call's name; pages never ask which platform they are on. The host is also a client of its own: it declares its abilities, publishes the `host` record, and answers `host.*` calls from the core.

## 13. Layout and tests

```
core/Cargo.toml          workspace of two crates
core/proto/              the wire types that exist: frames, calls, records, errors; exports protocol.ts and JSON samples
core/src/main.rs         picks the role from the program name or first argument
core/src/serve.rs        listener, handshake, authorization table, bounds, exit and retire
core/src/client.rs       the client the roles and the tests use
core/src/store.rs        SQLite, migrations, transactions that yield a revision and a change set
core/src/records.rs      sub, put, delete, history;   stream.rs: open, credit, close
core/src/calls.rs        the call table: one match from name to handler
core/src/state.rs        the state machine and attempts;   questions.rs: ask, answer, withdraw, received
core/src/terminal.rs, agents/ (trait, claude.rs, codex.rs), shim.rs     (Phase 2)
core/src/route.rs, isolate.rs, speech.rs, http.rs, secrets.rs           (Phase 3)
core/src/import_v1.rs                                                   (Phase 6)
core/tests/              one file per promise, plus fixtures/
```

**Tests** start the real binary on a temporary data folder and speak the protocol through `client.rs`. No test reaches into the core. Fixtures are part of the binary under a test-only feature: `fixture.stream` (a call that opens a stream of known bytes and echoes what it receives, so streams, credit and bounds are tested before terminals exist), a fixture launcher and route provider, and from Phase 2 `tasktap fixture-agent`, which prints, sends events, asks, waits and exits in a real terminal on every platform without shell scripts.

**The one check at the end of every phase:** `cargo test -p tasktap-core --test loop`. Capture a thought; route it (the fixture provider answers `clear`); run it; the agent asks; answer it; the agent finishes. It asserts the status sequence captured, routed, working, needs you, working, done; a result tied to the thought; an answer receipt marked delivered; then restarts the core and asserts that every record is still there and that nothing ran again. In Phase 1 a test client holding a session token stands in for the agent; from Phase 2 the fixture agent runs in a real terminal and the assertions do not change.

## 14. Build order

### Phase 1 work packages

Phase 1 builds the core alone: protocol, store, service, records, streams, state machine and questions, and measures it idle. It adds `core/` and `trials/` and changes nothing else. Critical path: **1 → 2 → 3 → 5 → 7**; package 4 must also be done before 7.

| # | Package and goal | Area | Must not change | Proving command | Done when | Tier | Beside others |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T | **One-host trial.** Build the notch panel in Tauri on the Mac and measure the page pass-through in both hosts (binary frames into the page; key echo). | new `trials/tauri-notch/` | everything else | `trials/tauri-notch/check.sh` | It reports pass or fail for: reveal leaves the front app unchanged; the frame matches `NotchGeometry` within 1 px; glow and backdrop captures saved beside the 1.2 references; throughput and echo numbers for both hosts. The coordinator records the decision. | Opus | yes, all |
| 1 | **Protocol crate.** The ten frames, the codec, the bootstrap contract, and the Phase 1 calls and records as Rust types; generated TypeScript; JSON samples. | `core/Cargo.toml`, `core/proto/` | the app | `cargo test -p tasktap-proto` | Round trips, size limits and integer encodings pass; samples for the frozen bootstrap frames are checked in and a test fails if they change; generated files are committed and a test fails when stale. | Opus | with T |
| 2 | **Store.** Schema version 1 (§5: all tables without a phase mark, including `devices` and `attempts`), migrations with `VACUUM INTO` backup, transactions that return a revision and change set, the live rule, the recovery pass. | `core/src/store.rs` | `core/proto/` | `cargo test -p tasktap-core --test store` | Empty start, reopen, refusal of a newer schema, backup before migration, live-set eviction and recovery marks are tested. | Opus | with T |
| 3 | **Service.** Roles, lock, start on demand, listener, handshake (version, user check, device register, key, revoke), the bootstrap calls, the per-call authorization table, connection bounds, exit timer. | `core/src/main.rs`, `serve.rs`, `client.rs`, `calls.rs` | `core/proto/`, `store.rs` | `cargo test -p tasktap-core --test service` | A second instance exits; a wrong or revoked key is refused; a client with no shared version can still call `core.status` and `core.retire`; a token cannot call a device call; a client over a bound is dropped. | Opus | with 4 (needs 2) |
| 4 | **State machine.** `state.rs` as a library on the store: every row of the §5 table, derived status, attempts, hold timer, the launcher and route-provider seams with their fixtures. | `core/src/state.rs` | `core/proto/`, `store.rs` | `cargo test -p tasktap-core --test state` | Each table row, each guard and each recovery rule has a test; the same attempt id with other arguments is `conflict`; a restart restores no timer. | Opus | with 3, 5, 6 (needs 2) |
| 5 | **Records.** `sub`, `put`, `delete`, `history`, change frames, chunked snapshots, the in-memory collections. | `core/src/records.rs`, lines in `calls.rs` | store schema | `cargo test -p tasktap-core --test records` | Two clients see the same ordered changes with no gap between snapshot and first change; `if_rev` conflicts are reported; a row leaving the live set is a `del`; `history` pages. | Opus | with 4, 6 (needs 3) |
| 6 | **Streams.** Open, credit both ways, `mark`, `close`, the stream bounds, and the `fixture.stream` call. | `core/src/stream.rs`, lines in `calls.rs` | `records.rs` | `cargo test -p tasktap-core --test streams` | Bytes arrive intact under small credit; bytes beyond a grant end the connection; closed ids are not reused; a stalled reader never grows the core's memory. | Opus | with 4, 5 (needs 3) |
| 7 | **Questions and the calls with effects.** `questions.rs`, the thought, question, session, project and `input` calls wired to the state machine, `glance`. | `core/src/questions.rs`, `calls.rs` | `state.rs` semantics, wire types | `cargo test -p tasktap-core --test questions --test loop` | Every guarantee and every cell of the §6 lifetime table has a test; the loop check passes with the stand-in agent. | Opus | with 8 (needs 4, 5) |
| 8 | **Measure.** `core/scripts/measure.sh`: idle wakeups over 60 s with clients subscribed, memory, start time, stream rate through the fixture. | `core/scripts/` | `core/src/` | `core/scripts/measure.sh` | It prints each number beside its §10 target and fails when wakeups are not 0; the numbers are handed to the coordinator for the plan. | Sonnet | with 7 (needs 5, 6) |

### Later phases

| Phase | Lands |
| --- | --- |
| 2. Terminals and agents | `terminal.rs`, the adapters for Claude Code and Codex, the roles `hook`, `event`, `ask`, the shim, `fixture-agent`, previews and file streams, agent sign-in in a project-less terminal. Starts with the trial for answering agents through a waiting hook. |
| 3. Flow | Routing and consent, the hold and Undo, ideas, isolation and settlement, connections and keys, cloud speech. |
| 4. Host and notch | The host the trial chose, the pass-through, the host abilities, input actions, and the new notch page as the first real client. |
| 5. Workspace | The workspace UI in TypeScript on the core. |
| 6. Cutover | Import from 1.2 (§11), switch over, delete the old native, prototype and Python code. |
| 7. Windows | Named pipe, ConPTY, the Windows host. |

### Verify when reached

| Phase | What |
| --- | --- |
| 2 | Typing delay while the store commits and while a second client is slow, before any efficiency target is claimed. |
| 2 | Whether a waiting hook can answer Claude Code's and Codex's permission requests and questions. Until it passes they are `reply_via: terminal`. |
| 3 | Whether macOS asks for the credential store again when the core binary changes with an update. If it does, the host keeps the keys behind one more ability. |
| 4 | Bytes into the page on the Mac: a streamed response on a custom address, or text passed to the page. Trial T measures both. |
| 6 | That the policy for sessions still running in 1.2 (§11) is the only one in code, guide and import report. |
| 7 | Ending a whole process tree on Windows; the order in which ConPTY output drains on close; the pipe's access rules; the shim without `exec`. |

## Defaults chosen

Each is the default so that building is not blocked. The owner may overrule any of them.

1. **Voice waits for Enter.** After hold to talk the text is shown, for a thought and for a spoken reply alike. A mishearing should not start work.
2. **Undo is a hold. Changes the plan.** A clear thought shows "Sent to X" at once and launches when the Undo seconds have passed. The duration is a preference; zero launches at once. Stopping an agent after it started could not take back what it did in a project that is not isolated.
3. **A prompt typed by hand becomes a thought**, so Home and the glance list everything in flight.
4. **Sessions still running in 1.2** are imported as interrupted, with Resume (§11).
5. **Dropped:** Resume in Terminal and copy-resume (never worked), the Claude brief session in Terminal.app, the discussion step before an answer (a text reply), the terminal typing trace, questions from tools outside Tasktap's terminals. Agent sign-in moves from Terminal.app into a Tasktap terminal that belongs to no project (Phase 2).

Still open: **one host or two**, which trial T settles.
