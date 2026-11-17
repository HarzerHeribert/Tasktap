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
| Whole protocol | about 235 kinds | 65 calls (45 core, 18 host, 1 page, 1 shim) in 10 frame kinds |
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
  | { t: "change"; rev: number; snap?: true; more?: true; sets: { c: Collection; put?: Row[]; del?: Id[] }[] }
  | { t: "credit"; s: number; n: number }      // grant n more bytes on stream s
  | { t: "mark"; s: number; at: number; size?: [cols: number, rows: number]; live?: true; gap?: true; from?: number; exit?: number | null }
  | { t: "close"; s: number; why?: "done" | "overflow" | "gone" | "denied" }
// kind 1: stream bytes = u32 stream id, then raw bytes
```

**Subscriptions.** `sub {collections}` is the only form: no filters, no limits, one subscription per connection (a second `sub` replaces the first; an empty list ends it). The core answers in one step on its single thread: the snapshot as `change` frames marked `snap` (chunks of at most 256 KiB), then `reply {rev: R}`, then every change after R that touches a named collection. Nothing can fall between the snapshot and the first change. The snapshot is read and encoded in that step but sent at the pace the connection drains, like stream data; everything queued for the connection meanwhile, later changes and replies, waits behind it in order. One `change` is one committed transaction, so a client never sees half of it; one too large for a frame is cut like a snapshot, into frames with the same `rev` in a row. In both, every frame but the last is marked `more`, so a client applies a transaction whole when its last frame arrives. Memory-only collections use the same counter. Revisions order changes within one run of the core; a client always starts from a snapshot.

**Live rows only.** Collections hold what is live. A thought is live until it is finished (done or failed, read, settled) and 200 newer finished thoughts exist; its sessions, questions and results are live with it. A row that stops being live is a `del` in the change that caused it. Older thoughts are fetched with `history {before?, after?, limit ≤ 100}`, which returns them with their questions and results in pages whose rows fit one chunk; a page cut among one thought's questions and results names in `after` where the next goes on. They are not subscribed. This bounds every snapshot. I found no case that needs more.

**Plain data and effects.** `put {c, id, patch, if_rev?}` and `delete {c, id}` write the collections that are plain data (`prefs`, `layouts`, `previews`, the editable fields of `projects`, and the text of a thought that is captured and was never launched: a note, an idea, or one undone before it started, which `delete` also removes, so a person who undoes and retypes leaves nothing behind; `state::plain` decides). Everything with an effect is a named call. Fields the state machine owns are refused by `put`.

Calls without a mark are built in Phase 1; (2), (3) and (6) name the phase that adds the rest. The protocol crate holds only what exists.

| Area | Core calls (45) |
| --- | --- |
| Records | `sub`, `put`, `delete`, `history` |
| Thoughts | `thought.capture`, `thought.update`, `thought.start`, `thought.stop`, `thought.retry`, `thought.read`, `thought.settle` (3), `thought.changes` (3) |
| Questions | `question.ask`, `question.answer`, `question.withdraw`, `question.received`, `question.focus` |
| Sessions | `session.event`, `session.adopt` (2), `session.resume` (2) |
| Terminals (2) | `terminal.open`, `terminal.resize`, `terminal.stop` |
| Projects | `project.add`, `project.scan`, `project.close` (2) |
| Files | `preview.open` (2), `file.read` (2), `result.export` (3) |
| Input and voice | `input` (affirm and deny now; hold in 3), `dictation.start` (3), `dictation.finish` (3), `dictation.report` (3) |
| Routing and agents | `route.hint` (2), `connection.set` (3), `connection.remove` (3), `connection.login` (3), `connection.models` (3), `agents.detect` (2), `agents.login` (2) |
| Devices and service | `device.revoke`, `core.status`, `core.retire`, `import.v1` (6), `appearance.import` (2) |

**Host abilities (18, Phase 4):** `host.show`, `host.notch`, `host.chrome`, `host.drag`, `host.pick`, `host.save`, `host.open`, `host.clipboard`, `host.permission`, `host.settings`, `host.update`, `host.notify`, `host.context`, `host.model`, `host.dictate`, `host.speak`, `host.speech_model`, `host.pdf`. A host lists the ones it has in `hello`. **Page ability (1):** `ui.do {action, id?}`: 14 menu actions, `close-front`, `navigate`, `hover-enter`, `hover-exit`, `previous`, `next`, `confirm`, `back`, `prepare-update`. **Shim ability (1):** `shim.hold` (§7).

**Records (15).** Stored: `thoughts`, `projects`, `sessions`, `terminals`, `questions` (with the answer inside), `results`, `layouts`, `prefs`, `devices`, `previews`, `connections`. In memory only: `glance` (counts for working, needs you, done and unread, failed and unread; the focused question; a pending core update), `dictation`, `host` (one row per connected host: abilities, notch geometry, update state, permissions, launch at login, speech engines, screen reader), `agents` (installed CLIs, sign-in state, identity; built in Phase 2, §7).

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
| Bounds | Per connection: 8 MiB of queued control frames (the snapshot being sent does not count, what waits behind it does, so a slow subscriber holds at most one snapshot and 8 MiB), 64 pending calls, 64 open streams. Per terminal: 8 queued chunks from its reader thread, which then waits. At most 256 connections; one that has not said `hello` within 5 s is closed, and at capacity the oldest of those makes room for a new one. No row is larger than one snapshot chunk: the store refuses a transaction that would write one as `invalid`, and each call bounds the texts it writes, which fails earlier and says which. A client over a bound is disconnected; memory never grows to suit a client. | Every queue has a bound. |
| Version | `hello` offers a range; `welcome` names the highest shared integer and lists the call names this core supports, so a newer app disables what an older core lacks. Additions do not bump the version. | A new app can drive an old core that still holds terminals (§3). |
| Bootstrap contract | Frozen forever: the frame layout, `hello.v`, `welcome.v` and `build`, `refuse`, and the calls `core.status` (build, versions, live terminal count) and `core.retire`. With no shared version, `welcome` says `v: 0` and only those two calls work, and they need the local user check and nothing else. With a shared version `core.status` is still anyone's and `core.retire` a device's alone. | Any app can ask any core what it is and ask it to retire; an agent, which holds only a session token, cannot end the core and every terminal in it. |
| Local peer check | On accept: the peer's user id must equal the core's. The data folder must be 0700 and owned by the user, as today. | Keeps today's protections. |
| Device identity | Each host has a row in `devices` and proves a 32-byte key, stored hashed. A local peer that passed the user check may register itself. `device.revoke` drops its connections at once. Pages use the host's connections. | Identity that can be listed and revoked. A program running as the same user can read the data folder anyway, so the key is identity, not a wall. |
| Session tokens | Each terminal the core starts gets a random token in its environment (`TASKTAP_SOCKET`, `TASKTAP_TOKEN`), stored hashed. `TASKTAP_SOCKET` is `<data>/core.sock` on every system; on Windows it only names the folder the pipe's name is made from. | Replaces the per-launch observer token. |

**Authorization is per call.** The core takes the session, the terminal and a question's source from the token, never from arguments.

| Caller | May call |
| --- | --- |
| Device | everything except the token calls below. Only a device may call `question.answer` or `input`. |
| Session token | `session.event`, `session.adopt` (a shell's token), `question.ask`, and `question.withdraw` and `question.received` for its own questions. Nothing else. |
| Nobody | the abilities (`shim.hold`, later `host.*` and `ui.do`): the core calls them on a client that offered them in `hello`. |
| Local peer with neither | the bootstrap calls, and registering a device. Tools outside Tasktap's terminals get nothing more: other apps' sessions are cut. |

**Other machines, later.** Three additions, none of which changes a frame above: a second `auth` variant that proves a public key, a one-time pairing call, and a relay that carries these same frames between a device and a core that both dial out. Snapshots make reconnects cheap, credit handles latency, and `host.*` calls go to the remote device's own host. None of it is in the Phase 1 types.

## 3. Process model

| Topic | Decision |
| --- | --- |
| Lifetime | Runs while any client (a connection that said `hello`) is connected, any terminal is alive, a hold timer is armed or git work for a worktree runs (§7, "Isolation"). When all become false it arms one 60 s timer and exits when it fires. |
| Single instance | An exclusive file lock on `<data>/core.lock`, held for life. A second `serve` exits 0. The lock, not the socket file, is the truth. |
| Start on demand | A client that finds no socket starts `tasktap serve --data <dir>` detached and waits on a pipe for the `ready` line the core writes once it listens. No retry loop. The data folder is always passed; there is no default path (hazard 7). Many clients at once start one core and all get in, waiting for each other on `start.lock` in the kernel: each holds it shared from before it connects until it is welcomed; a starting core holds it alone until it listens. A client that finds no core, or is refused because the listen queue is full (128 on macOS, which refuses at once rather than waiting), takes it alone, which it gets once every client connecting before it is in, and connects again; only when no core holds `core.lock` does it start one, with `--locked`, keeping the lock until it listens. A core that idles out takes `start.lock` alone first and keeps it until it is gone, so no client is left in its queue; with a client connecting it stays. |
| Where it runs from | A copy at `<data>/bin/<build>/tasktap`. Windows cannot replace a running program, and hooks of running sessions keep pointing at the build that started them. Unreferenced builds are deleted at start. |
| Effects happen once | Every call that starts a process names an attempt id. Before spawning, the core commits the attempt with a hash of its arguments. The same id with the same arguments returns the first outcome; with different arguments it is `conflict`. When what was spawned cannot be stored, the core exits non-zero instead of answering, and the next start closes the attempt as `interrupted`. Creates are idempotent on the client-minted id in the same way: each is recorded as an attempt under its id with a hash of all its arguments, checked before anything else. |
| Crash recovery | At start, in one transaction: an attempt with no recorded outcome is `interrupted`; terminals marked running by an earlier boot become `lost`, their sessions `ended`, their thoughts `failed (interrupted)`, their open questions `withdrawn`; so does a session whose terminal a clean shutdown ended (§9). Hold timers are not restored, and none fires once a shutdown has begun: a held thought stays `routed` with no timer and waits for the person to press Start. Then, before the first connection is taken and off the core's thread, the worktrees are swept (§7, "Isolation"): what git shows decides a settle the core stopped during, and only what holds nothing to lose is removed. |
| Never rerun | There is no queue to drain and recovery only closes things. A launch happens only inside a call from a live client. The 1.2 start-up relaunch of jobs without receipts (hazard 12) is gone. |
| Durability | SQLite in WAL mode with `synchronous=FULL`: a reply is sent after its transaction is on disk. Writes are state changes only. **Decided in package E, without `F_FULLFSYNC` on macOS** (`PRAGMA fullfsync` off, set so in the store). There `fsync` hands the commit to the drive, which may still hold it in its cache when the power goes; `F_FULLFSYNC` flushes that cache too. Measured by `core/scripts/measure.sh` (Apple M4 Pro, macOS 27.0.1, 500 commits each of a 400-byte row as the store writes one): `synchronous=FULL` alone 0.039 ms a commit (median; p95 0.049 ms), with `F_FULLFSYNC` 4.03 ms (p95 4.21 ms), a hundred times more. A commit runs on the core's thread, so every commit would hold up a keystroke by 4 ms, thirteen times the 0.3 ms the core may add; the stricter setting was worth it only at a negligible cost. What it buys is small: the records are small and rarely written, and a power cut that loses the last commits leaves an older consistent file that the recovery pass closes as for a crash. The script fails this row should `F_FULLFSYNC` ever cost less than 0.3 ms, so the choice is made again. While another client commits all along, the core adds 0.088 ms to a keystroke (§10). |

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
| `hook <agent>` | an agent's hook, with the payload on standard input. The agent's adapter (§7) runs here, in this process: it maps the payload to one `session.event` in the core's vocabulary, to nothing, or to a question the agent lets the hook decide. Then the hook asks with `question.ask`, waits on the socket, prints the reply the adapter formats and confirms with `question.received`. **Changes the design:** the core never sees an agent's own payload, so one it would not understand never reaches it | `session_observer.py ingest` |
| `event <kind> [TEXT]` | an agent's plugin that can run a command: one `session.event`, `TEXT` in the field its kind has (for `continued`, the key of the waited question it settles), with `--id`, `--turn`, `--subagent`, and for a question `--request`, `--detail`, `--choice`, `--text` | `observers/emit.mjs` |
| `ask [PROMPT...]` | an agent in a Tasktap terminal, with `--request KEY`, `--detail`, `--choice` (repeated) or `--text`; without a prompt the first line of standard input is the prompt and the rest the detail. Sends `question.ask`, sleeps on the socket, prints the answer (`yes` or `no`, the choice, or the text), confirms with `question.received`. The same key asks once: again it gets the stored answer | `ask-user`, and the `agent-tools` MCP server (`report_result` becomes `event turn_finished`) |
| shim: the same file named `claude`, `codex`, … | a person typing the agent's name in a Tasktap shell | `tasktap_shell.py cli`, `Shells/<id>/bin/*` |
| `fixture-agent` | tests, and package C's loop in a real terminal; only in a build with the test fixtures. A scripted agent that prints, reports through its hook, asks and waits, reads a line, sleeps, ignores hang-up and exits with a code | – |

The roles use the blocking client and nothing else: no runtime, no store. `event` takes about 2 ms from start to exit against a running core. Each waits at most 5 s for the core, its lock or its agent's pipe; a question's wait lasts as long as its connection, which the core withdraws the question with. Exit codes: 0 done (for `ask` and a waiting hook, answered); 1 the core refused the call or the connection ended; 3 no answer, the question was withdrawn or its session has ended; 64 wrong arguments; 65 a hook payload the adapter cannot read, nothing sent; 69 no core reached or started in time; 77 the session token refused or malformed; 78 no session token, not in a Tasktap terminal. None is 2, which Claude Code reads as a hook blocking its tool.

**The shim** keeps the rules of `scripts/tasktap_shell.py`. The shim folder is `<data>/shims`: links (copies where links fail) of the binary named after each agent that has an adapter, and `tasktap` itself, which the hooks and `tasktap ask` run; a shell puts it first on its PATH. Every other terminal finds `tasktap` in the core's own folder instead, last on its PATH (§7). The shim finds the real executable on the PATH, skipping that folder and any file that is the shim itself. It steps aside (runs the real CLI directly, unobserved: `exec` on Unix) when input or output is not a terminal, for print, help, version and remote modes, for the listed non-interactive subcommands, when the core does not answer within 5 s, and when the terminal already has a live observed agent, which `session.adopt` reports as `conflict`. Otherwise it calls `session.adopt` on a connection that offers `shim.hold`, adds the hooks (the adapter's `attach`) and what the adapter's probe adds, run with the agent it found (an agent whose probe fails runs unobserved), adds the default approval flag only if the person gave no policy of their own, starts the real CLI as its child, ignores Ctrl-C while it waits, restores the terminal modes, and reports the exit as `session.event exited` on a second connection. It stays the parent because the core parents only the shell, and so it is the one that ends its agent when the person stops the run (`shim.hold {stop}`, §7). The links are symbolic on macOS and hard elsewhere: a hard link gives the binary a second name, and macOS, which reads each program it starts to check it, may then look for it under one link's name in another link's folder, find nothing and kill it, a shim or the binary under its own name alike (`tests/roles.rs`). The adopted session belongs to the adopting connection: when that ends first, a shim killed, the session ends with no exit code.

Improvements on the hypothesis: (1) **a hook can wait**, so a question can be answered from the notch where the agent allows it (§6); (2) **no wrapper for agents the core launches**: the core is their parent and knows start and exit itself, so `present`, `surface.json`, three lock files and three sources of `process_exited` go; (3) **no MCP server**: `tasktap ask` is an ordinary command; (4) **activity is not written to disk**, only state changes are. This removes the 0.7 s receipt poll, the 8 s scan, the 0.2 s answer poll and every run-folder file.

## 5. Data model

One SQLite file, `<data>/core.db`. Ids are UUID v7 text, minted by whoever creates the record; the core mints its own on its clock, which tests may hold. Every row has `rev`. `PRAGMA user_version` is the schema version; migrations are an ordered list of SQL in the binary, applied in one transaction after a backup made with `VACUUM INTO`; a database newer than the binary is refused with a clear message.

**Core id.** `meta.core_id` is minted once. `welcome` names it, so a client can hold records from several cores. It is not a column on every table: a value that is the same in every row is not data. References never cross cores.

| Table | Important fields | Notes |
| --- | --- | --- |
| `thoughts` | `id`, `text`, `strokes`, `reference`, `source` (typed, voice, terminal, import), `mode` (ask, nudge, note), `phase`, `status`, `reason`, `live`, `project_id`, `session_id`, `brief`, `route`, `agent`, `model` (from the capture, §7), `workdir` (path, branch, destination branch or none, base commit, `left_out`, changes: none, pending, kept, discarded, and their `files`, `insertions`, `deletions`; §7, "Isolation"), `hold_until`, `read`, `created`, `updated` | The primary record. A note is a thought with mode `note` that stays captured: **no `notes` table**, and an idea can later be started. |
| `projects` | `id`, `name`, `folder` (canonical, unique), `kind` (folder, scratch), `color`, `aliases`, `git`, `isolate` (busy, always, never), `open`, `available` | The id is random; the folder is a field (hazard 2). One built-in scratch row replaces the virtual `@scratch`: it comes with a new store, its folder is `<data>/scratch`, and no call removes it or changes its kind or folder. |
| `sessions` | `id`, `project_id`, `agent`, `terminal_id`, `adopted`, `state`, `thought_id` (current turn), `turn`, `resume` (the agent's handle, the latest its reports gave), `name`, `named_at`, `model`, `cwd`, `exit`, `error`; memory only: `activity`, last 40 activity lines | `log`, `nameHistory`, `producerKey`, `planAccount` are dropped. |
| `terminals` | `id`, `project_id` (may be empty), `kind` (shell, agent, task), `title`, `cwd`, `argv`, `cols`, `rows`, `state` (running, exited, lost), `exit`, `boot`, `offset`, `token_hash` | A terminal can belong to no project (agent sign-in is a `task`). Closing a tab does not touch the row (§9). |
| `questions` | `id`, `thought_id`, `session_id`, `turn`, `source` (agent, permission, router), `kind` (confirm, choice, text), `prompt`, `detail`, `choices`, `reply_via` (core, terminal), `request_key` (unique), `state` (open, answered, withdrawn) | Everything except `state` is written once. |
| `answers` | `question_id` (primary key), `kind` (affirm, deny, choice, text, terminal), `choice`, `text`, `device_id`, `created`, `delivered` | The receipt. Clients see it inside the question. |
| `results` | `id`, `thought_id`, `session_id`, `turn`, `kind` (answer, failure, changes), `summary`, `body` | `body` is fetched with `file.read`. Replaces `answer-NNNN.txt`, `observedAnswers`, the activity list, `seen`, `observerReads`. |
| `attempts` | `id`, `kind` (launch, resume, terminal, settle; capture and project for a create), `target`, `args_hash`, `started`, `outcome` | §3. A settle's hash says keep, discard, or a tidy the core made itself (§7, "Isolation"). |
| `layouts` | `project_id`, `tree` | Opaque to the core. The UI gives a default place to terminals the tree does not mention. |
| `prefs` | `key`, `value` | Keys and value types are fixed in the protocol crate: `hold` (seconds), `agent` (the default agent, §7). |
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
| hold ends, or `thought.start` | routed → working, after the attempt is committed | new session: starting, in the project folder or a worktree as §7 "Isolation" decides; `conflict` while the thought's worktree is being settled. Follow-up: delivered as §7 allows |
| `prepared` (the launcher made or found the run's worktree, before the run starts) | its owner records the worktree, never in place of another it has not settled, and only one the core makes (`<data>/worktrees/<name>` on `tasktap/<name>`, the name 12 hex digits); anything else is `invalid` | the run's session works in it |
| `thought.stop` before launch (Undo) | routed → captured | – |
| `put` of its text, `delete` | a thought captured and never launched (no launch attempt: a note, an idea, one undone) is plain data: its text changes, or it is removed with its router question; any other is `invalid` | – |
| launch fails | → failed; why the run did not start, or the follow-up was not typed, is its failure result; a follow-up its agent already began (its `turn_started` came first) is left to its turn | a new session ends; a follow-up's session is left as it is |
| `session.adopt` (a shell's token) | – | new adopted session: starting, in the shell's terminal and project (the scratch when it has none). `conflict` while a session in that terminal is alive, or while the worktree it works in is being kept or discarded |
| `ready` | – | starting → idle; what it showed in its terminal before (next row) closes as answered there, as it does when `turn_started` comes straight from starting |
| `shown`: the session's terminal shows what its agent waits on there before it is ready, in words its adapter names (§7) | unchanged (status becomes needs you) | starting: a question answered in the terminal opens; shown again it is the same question; ignored once the session is not starting |
| `turn_started` | working. Binds the waiting follow-up delivered first, as the agent reads typed text in order; a prompt typed by hand creates its thought here | → working; its first activity line says the turn started, since an answer that uses no tool reports no other activity (found live: a trivial prompt left a working thought with none) |
| `turn_started` while a turn is open | the open turn ends first as `turn_interrupted` ends it (its thought → failed, interrupted; its open questions withdrawn), then the row above: the person interrupted the agent in its terminal and the agent did not say so (Claude Code has no interrupt hook), so the next answer must not reach the old thought | working → working, the next turn |
| `activity` | – | – (memory-only text) |
| a question opens | unchanged (status becomes needs you) | unchanged (shows asking) |
| a question is answered or withdrawn | unchanged, except a router question's answer (second row) | unchanged |
| `continued` | –; the turn's terminal-only questions close as answered in the terminal, and so does the waited question its `request` names, whose waiter gets that answer (§7: Claude Code takes an answer in its terminal while its hook waits) | – |
| `turn_finished` | → done, result stored; the turn's open questions are withdrawn | → idle |
| `turn_failed`, `turn_interrupted` | → failed (reason); the turn's open questions are withdrawn | → idle |
| `exited(code)` (the terminal's child exited) | working → failed; done if code 0 from an agent that sends no events | → ended; its open questions are withdrawn |
| `exited(code)` as a `session.event`, or the adopting connection ends (no code) | as `exited(code)`; ignored from a session that was not adopted | as `exited(code)` |
| `lost` (found at core start) | working → failed (interrupted); routed stays routed, timer gone | → ended |
| `thought.stop` after launch | → failed (stopped) | process stopped, → ended; an adopted agent is ended by its shim (`shim.hold {stop}`), never with its terminal, which is the person's shell |
| `thought.retry` | failed → routed, unread | – |
| `thought.read` | done or failed: read (finished once nothing is pending, §1) | – |
| a turn ends, or a session ends, in a worktree | – (the core looks at the worktree) | – |
| `surveyed` (what a look found) | changes pending, or none, with their size: none only when removing the worktree would lose nothing; a settle the core stopped during decided by what git shows; none, or kept, with nothing to lose and nothing working there: tidied. Counts for nothing while a settle runs | – |
| `thought.settle` | done or failed, changes pending: kept or discarded once its git work succeeded; refused, they stay pending; `conflict` while another settle of it runs | no session and no running terminal in the worktree, else `conflict` (§7) |

Guards kept from 1.2: events from an old token, a sub-agent or a different turn are ignored (`session.event` names its turn and whether a sub-agent sent it); event ids are deduplicated; an event that does not fit the current state changes nothing. A question asked in the terminal arrives as such an event and passes the same guards.

## 6. Questions

One record and one flow replace the file inbox (path A) and the observer display (path B).

1. **Ask.** A question is opened by the core's router, by `question.ask` from `tasktap ask`, or by the adapter reading a `session.event`. Its `source` says who asks: an agent's permission request that a hook waits on asks with `source: permission`; without one it is `agent`; only the router's own questions are `router`, which a session asking is `invalid`. It is idempotent on `request_key` (for `ask`, the session and its `request` argument; for a hook, the session, turn and the agent's own call id): the same key with the same content is the same question; different content is an error. The key is per session, so one session's token never reaches another session's question. A request never changes. A session holds at most 8 open questions and all sessions together 64 (`MAX_SESSION_QUESTIONS`, `MAX_OPEN_QUESTIONS`); beyond that a new one is `conflict` until one closes.
2. **Show.** The thought's status becomes needs you, `glance` changes, the core calls `host.notify`. `glance.question` is the focused question (the one that opened first, by the revision it opened at rather than its id, unless `question.focus` chose another), so a host can bind the affirm and deny keys with no page running.
3. **Answer.** `question.answer {id, …}` or `input {answer.affirm | answer.deny, question}`, from a device only. One transaction inserts the `answers` row (its key is the question id, so a question is settled once, and only by an answer that names it) and sets `answered`. Answering a withdrawn question is `gone`.

**Lifetime depends on who is waiting.**

| | Terminal-only question (`reply_via: terminal`) | Waited question (`reply_via: core`) |
| --- | --- | --- |
| Opened by | a hook that reports and exits | `tasktap ask`, or a hook that waits. The pending call is the waiter |
| Bound to | its session and turn | that waiter |
| The card | shows the question and "Answer in terminal", which opens that terminal. Affirm and deny do the same | answers it. Affirm and deny act directly on `confirm` and permission questions |
| Closes | on `continued` (answered, kind `terminal`), or withdrawn at turn end or session end | when answered, or when the agent went on from it in its terminal (`continued` naming it; answered, kind `terminal`): the stored answer is the call's reply; the waiter prints it and sends `question.received`, which sets `delivered` |
| Waiter disconnects | – | withdrawn at once. If the waiter comes back with the same key while the turn is alive, the same question reopens, or, if it was answered meanwhile, the stored answer is returned again |
| Never delivered | – | the answer stays stored with `delivered` empty and the card says so; turn end closes it |

Nothing waits forever (hazard 10). Merged or dropped: `discussion[]` and the discuss key become a text answer (today the first discussion line already ends the agent's wait); `binary` becomes `confirm`; `producerKey` becomes `request_key`; `reconcileAgentQuestions` becomes withdrawal.

## 7. Agents

```rust
trait Agent {
    fn id(&self) -> &'static str;                                  // "claude": the shim's name, `tasktap hook <id>`, a capture's `agent`
    fn program(&self) -> &'static str;                             // looked up on the terminals' PATH
    fn caps(&self) -> Caps;
    fn launch(&self, run: &Run) -> Vec<String>;                    // a new run's or a resume's command line: the program, then its arguments
    fn attach(&self, exe: &Path) -> Vec<OsString>;                 // arguments that make a run call `<exe> hook <id>`; launch and shim
    fn probe(&self, exe: &Path, cwd: &Path) -> Option<Probe>;      // a check that must pass before the spawn; none for most
    fn detect(&self) -> Detect;                                    // its own commands that say installed, signed in, as whom
    fn variables(&self) -> &'static [&'static str];                // of the core's environment, what its runs need: a sign-in key
    fn prompts(&self) -> &'static [Prompt];                        // what it waits on in its terminal before it is ready: words shown, question
    fn event(&self, args: &[String], payload: &[u8]) -> Result<Option<Heard>, String>; // runs in `tasktap hook`: payload → the one vocabulary
    fn reply(&self, args: &[String], payload: &[u8], answer: &Answer) -> Option<String>; // what a hook that waited prints; none leaves it to the agent
}
struct Caps { events: bool, resume: bool, permissions: Option<ReplyVia>, questions: Option<ReplyVia> } // events false: it reports only by exiting, and exit 0 is done
struct Run<'a> { session: SessionId, cwd: &'a Path, prompt: &'a str, model: Option<&'a str>, resume: Option<&'a str>, hook: &'a Path }
struct Detect { version: &[&str], version_of: fn(&str) -> Option<String>, account: &[&str], account_of: fn(Option<i32>, &str) -> (Option<bool>, Option<String>) }
struct Probe { argv: Vec<String>, input: String, read: Box<dyn FnMut(&str) -> Option<Result<Vec<String>, String>> + Send> } // what it adds follows the program
enum Heard { Event(SessionEvent), Wait(Ask) }                      // report and exit, or ask and wait: the agent lets the hook decide
```

An adapter is data and small pure functions: `event` and `reply` do no I/O and run in the `tasktap hook` process (§4), not in the core. What must run a program the adapter describes and `agents::checks` runs, on a thread of its own, with the terminals' fixed environment and PATH: `detect`'s two commands (4 s each) answer `agents.detect {agents?}`, which lists for each agent whether it is installed, its version, whether it is signed in and as whom, and its caps; `probe` runs before a launch (12 s at most). What detection finds is also kept in the `agents` collection, in memory, one row per agent keyed by its id: the fields `agents.detect` returns, with `rev` and `checked`, the time its commands answered. The core detects every agent once as it starts, off its thread and after `ready`, so a page shows them at once; `agents.detect` puts again the rows it found, and its reply is those rows. Nothing repeats it, and the detection keeps no core alive: one that idles out meanwhile ends without the rows. A build with the test fixtures detects at start only with `serve --detect`, and then only the fixture agents, so no test runs a real agent's commands. A launch answers its call at once: its program is looked up on the PATH and its probe run on a thread of their own, since a folder of the PATH may be on a stalled mount, and its outcome reaches the thought's record and the attempt once they have answered (the same `thought.start` repeated meanwhile is `conflict`, as for any attempt without an outcome). The agent's resume handle comes in its reports (`session.event` `resume`), and the session keeps the latest. The token is not the adapter's: the terminal puts it in every child's environment, and both tools pass their environment on to their hooks. An adapter declares the few variables of the core's own environment its runs need (`variables`): Claude Code `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` (the token `claude setup-token` makes for a subscription) and `CLAUDE_CONFIG_DIR`; Codex `OPENAI_API_KEY` and `CODEX_HOME`. So a person who signs an agent in through one is not signed out in Tasktap. Every terminal and every check gets them as the core had them at start, and no value reaches a record or a log. Hooks and settings travel as arguments, and nothing is written to `~/.claude` or `~/.codex`.

`core/src/agents.rs` holds the trait, the registry, the one list that names agents (its first is the default), and the test agents `fixture`, `fixture-silent` (no hooks) and `fixture-probed` (a probe), all the program `fixture-agent`, this binary under that name. `agents/claude.rs` and `agents/codex.rs` are the adapters; `agents/rules.rs` holds the shim's rules (§4) of the agents with an adapter, the only ones a shim is named after, so that an agent without one runs as typed; `agents/checks.rs` runs detection and probes. No other module names an agent.

**Which agent a run uses. Decided in package D.** The capture names it: `thought.capture {agent?, model?}`, an id `agents.detect` lists, `invalid` when this build has none of that name. Without one, the `agent` preference (none by default, passed over when it names an agent this build lacks), else the registry's first, Claude Code. The thought keeps its agent and model; a follow-up uses its session's agent, and a resume keeps its conversation's model. A model is 1 to 250 characters, none a control, not starting with `-`, as 1.2 checked it. In the tests, the agent `fixture.script` names comes before the preference.

Three things are the same for every agent and therefore not in the adapter.

**Environment.** The core builds each child's environment from a fixed list (home, user, language, shell, the computed PATH, terminal variables, `TASKTAP_*`, and the variables the adapters declare, above). Nothing else is inherited from whichever process started the service (hazard 14). The hooks run the core's program by its absolute path; `tasktap ask` runs by name, so every terminal finds `tasktap` on its PATH: a shell in the shim folder, first, so that an agent typed there is adopted; any other terminal in the core's own folder, last, so that it has no shim at all and nothing needs installing.

**Launching** (`core/src/launch.rs`). The launcher asks the adapter for the command line, runs its probe first if it has one (above), looks its program up on the PATH the terminal will have (a program that is not there fails the launch before anything starts), refuses a project that is closed, and starts the agent through `terminal::spawn` as the direct child of a new terminal of kind `agent` in the folder the launch names, with no shell around it. The terminal takes the session's id, as the session takes the attempt's, and the caller stores its row with the token's hash in the transaction that applies `launched`, before anything else runs, so an id the store knows is never started twice. The hooks call the core's own program. When the child exits its session gets `exited` with the code at once, `silent` when its adapter reports no events; an adopted agent's shell is never silent, as its shim reports the agent. `thought.stop` stops the run's terminal (never a shell); for an agent adopted in a shell the core calls `shim.hold {stop: true}` on the adopting connection, and the shim hangs up on its agent, kills it 2 s later if it is still there (on Windows ends its process tree), and reports its exit, leaving the shell. Only the agent is signalled: what it started in its own process group outlives that, as from a shell. A run in a worktree has it made or found first, off the core's thread ("Isolation" below), and its probe and agent then run in it.

**Follow-ups.** A follow-up is typed into a terminal (bracketed paste, then Enter; its text keeps no control character but its line breaks and tabs, a carriage return becoming a line break, so nothing in it can end the paste, start another sequence or make the terminal interrupt, suspend or end the agent's input) only when that terminal's direct child is the agent the core launched, the session is not ended and the child has neither exited nor is being stopped. Then no shell exists underneath that could execute the text. Otherwise nothing is typed and the follow-up fails with the reason as its failure result. For an adopted session (an agent started by hand inside a shell) the follow-up is typed only while the shim holds the terminal, and otherwise fails, its text left to paste. The core calls `shim.hold {hold: true}` on the adopting connection, if it offered the ability; the shim answers once it has checked its child is alive and its process group owns the terminal's foreground, or `gone`. The core then checks for itself, since anything the shell runs has the shell's token and could adopt and say yes: the process at the other end of the adopting connection, as the system names it, must be in the group that has the terminal's foreground, and that must not be the shell's own; otherwise nothing is typed. Windows has no foreground group, so there a follow-up to an adopted session is not typed ("Verify when reached"). The core types the text and calls `shim.hold {hold: false}` only once the terminal's input thread has written all of it, or none of it is still to come: what the core types goes 256 bytes at a time, and past 5 s the core gives up on the rest, which is not written, and waits for the piece on its way. A follow-up is typed when all of it was written, and fails otherwise. A shim whose agent exits meanwhile reads its terminal into nothing, so the core's writing finishes, and waits for that call, or for its connection to end, at most 5 s, before it returns to the shell; it restores the terminal with `TCSAFLUSH` whenever a follow-up was typed during the run, so input the agent never read is discarded, not run, and none is still to come. The core waits 5 s for the answer. The follow-up's outcome reaches its thought's record, not the `thought.start` call, which answers once the hold is asked. This replaces `codex queue`, `pbcopy` and the Copied and Delivered states.

**Isolation** (`core/src/isolate.rs`, Phase 3). A thought can run in a git worktree of its own, so that two agents never write the same files and what one did comes back as changes the person keeps or discards. `state.rs` decides; `isolate.rs` does the git work and nothing else, on threads of their own, so the core's thread never waits on git.

| A new run | Works in |
| --- | --- |
| a follow-up typed into a live session | wherever that session works |
| a run of a thought that has a worktree it has not settled (a retry) | that worktree, made again on its branch where its folder is gone, and anew where its branch is gone too |
| a run that continues the conversation of an ended session that worked in a worktree whose changes wait | that worktree, which stays its owner's |
| a project that is no git repository (no `.git` in its folder: a folder inside a repository counts as none), or the scratch | the project folder |
| `isolate: never` | the project folder |
| `isolate: always` | a new worktree |
| `isolate: busy` (the default), while a session of the project starts or works, or a thought of the project has changes waiting to be kept or discarded | a new worktree |
| `isolate: busy` otherwise | the project folder |

- **Made.** A new worktree is `<data>/worktrees/<name>` on a new branch `tasktap/<name>`, the name the last 12 hex digits of the launch attempt's random end, from the commit the project folder's HEAD is at. Its owner records it before anything runs in it (`prepared`): the path, the branch, the destination (the branch the project folder was on; none on a detached HEAD), the base commit, and `left_out` when the project folder had uncommitted changes of its own. **Decided:** the run starts from what is committed, and the person's uncommitted work stays where it is, outside the worktree. Copied in, it would come back in Keep as the agent's work, committed into the person's branch while it is still uncommitted in their folder, which Keep must then refuse. `left_out` lets the interface say so. The folder is made by that attempt alone (made, never found), and the branch is made only where none of that name is (`git update-ref` with no old value), so two attempts that come to one name, or a branch the person made meanwhile, stop the second attempt, which touches nothing it did not make. A repository with no commits, a folder or branch of that name that exists (never touched), or git failing fails the launch with the reason, and what that attempt made is removed: its folder, and its branch only while it is still at the base. The worktree has the repository's submodules as empty folders, as `git worktree add` leaves them; nothing is cloned or fetched, and Git LFS files stay pointers. The probe and the agent then run in it.
- **A worktree belongs to one thought,** its owner. Follow-ups to its sessions work in it; only the owner settles it; no run starts in it while a settle of it runs.
- **Looked at.** When a turn ends, or a session ends, in a worktree, the core looks at it: the files, lines added and lines removed against the base, committed on the branch or not, untracked files included, read through an index of the look's own so the agent's index is left alone; and whether removing it would lose nothing (below). The changes are `none` only then, and `pending` otherwise, even with no file changed: something staged that the files no longer show, an ignored file, or a folder git no longer ties to its branch is the person's to keep or discard. `thought.changes {id, credit, path?}` reads the same: its reply lists the files (path, added, modified, deleted or type, lines; as many as fit 256 KiB, `more` counting the rest) and opens a stream of the diff as `git diff` prints it, at most 4 MiB (`MAX_DIFF`; `size` and `cut` say when there is more), the whole or one file's. At most 4 diffs are held at once.
- **Tidied.** A worktree whose changes are `none`, once no session and no terminal works in it, is removed with its branch (a tidy, an attempt of kind settle) after one more look, when removing it would lose nothing: its folder is still the worktree git knows by its name (its `.git` names git's record of it, which names it back) and on its branch; its index and files are the branch's, with nothing staged, changed, untracked or ignored beside them (`git status --ignored`); and the branch is at its base or in its destination. One that would lose something stays, and its changes become pending.
- **Removed** only when proven the core's own: the folder exactly `<name>` inside the canonical `<data>/worktrees`, the name one the core makes (12 lowercase hex digits), reached through no link, and the record's branch `tasktap/<name>`; a record naming anything else is refused before git runs, whatever the store holds. Never while any process works in it or below it: on Linux and macOS the core reads every process's working folder (`/proc/<pid>/cwd`, `proc_pidinfo`); on Windows a folder a process works in, or holds a file of, cannot be renamed, and removal begins with a rename. The folder is moved aside to `.<name>.removing` (and back, refused, when a process went into it in between), git's record of it dropped, the folder removed (links inside are removed, never followed), and the branch deleted only from the commit it was seen at (`git update-ref -d` with the old value). A removal the core stopped during is finished at the next start.
- **Settled.** `thought.settle` needs the changes pending and no session and no running terminal of the core in the worktree: an agent stopped is not enough until its process has gone. Otherwise it is `conflict`; the interface confirms, stops the session and asks again. No agent is adopted into a worktree while it settles. The reply waits for the git work; a removal that finds a process working there, a shell that went there by `cd` included, refuses and leaves the changes pending.

| Keep, when the destination | |
| --- | --- |
| has not moved since the base | fast-forwards to the branch |
| moved, and both merge without a conflict | gets a merge commit of both, made without a working tree (`git merge-tree --write-tree`, `git commit-tree`; git 2.38 or newer), and fast-forwards to it |
| moved, and they conflict | refuses: names the files, leaves everything as it was, and says that branch `tasktap/<name>` holds the changes to merge by hand; Keep after that finds it merged and only tidies up |
| holds the branch already (merged by hand) | stays; Keep only tidies up |
| is checked out in a folder, the project folder or another worktree | moves with that folder, as `git merge --ff-only`, which git refuses whole when it would touch an uncommitted change or an untracked or ignored file (`--no-overwrite-ignore`); every option that could change what it does is set on the command (`--no-squash`, `--commit`, no autostash, no hooks, no signature check, `branch.<name>.mergeOptions` emptied), so no preference of the person's turns it into something else. Refused first when a file it writes there has an uncommitted change, exists untracked or ignored, or is where a folder must go, or when that folder is in the middle of a merge, rebase or other git command. Afterwards the destination must be the intended commit; otherwise (the folder switched branches meanwhile, say) what the merge did to the branch the folder was on is undone from that branch's log, and Keep refuses |
| is checked out nowhere | moves alone, from where it was (`git update-ref` with the old value); a folder that checked it out meanwhile, still holding the old files, moves it back, and Keep refuses |
| is gone, or was none (detached HEAD) | refuses; the branch is the person's |

Before that, Keep commits what is uncommitted in the worktree on its branch, once the worktree is still tied to that branch (above) and in the middle of nothing; refused, the branch then holds all of it. A file that a filter configured for the repository applies to (`.gitattributes`, as Git LFS uses) is refused, in the worktree and in the destination's folder: Tasktap runs no filter, so it would commit or write it unfiltered. On success the worktree and the branch are removed and the changes are `kept`; a worktree a process still works in stays, and the next start tidies it. **Decided:** a fast-forward when the destination has not moved, else a merge commit, because neither rewrites anything: the person's branch only gains commits, its history and their commits stay exactly as they were, a fast-forward keeps it straight when nothing happened meanwhile, and a merge commit is one commit that undoes as one. Nothing is rebased (that would rewrite either the person's commits or the agent's, whose tests then never ran) and nothing is forced.

- **Discard** removes the worktree, its uncommitted changes and its branch, commits that are nowhere else too, and marks the changes `discarded`. It never touches the project folder's files. It is how the person removes a worktree that would lose something, one git no longer ties to its branch included, after the checks above. Changes already in their destination (a keep the core stopped during, or merged by hand) are refused: Keep finishes them, so the record says what happened.
- **Held.** Each job that makes, keeps, discards or tidies a worktree holds it, through a lock file `.<name>.lock` beside it, and gives that file to each of its git commands as standard input, so a command that outlives a core that stopped (killed, or crashed) still holds it: on Unix the lock lasts while any process has the file open, and on Windows the file cannot be removed while one has it open. A later job finds it held and refuses, saying an earlier git command is still running; nothing is decided about that worktree meanwhile. **Decided:** the core does not end its git commands when it stops, since ending one midway may leave the person's index or files half written; the command finishes what it began, and the next look sees what it did.
- **Recovery.** The sweep at start (§3) looks at the worktree of every thought whose changes are not settled; one whose last settle the core stopped during only once no git command of that core holds it. A settle the core stopped during (its attempt `interrupted`) happened when git shows it done: a keep whose branch has commits of its own, all in its destination, with nothing uncommitted, or whose folder and branch are both gone, is `kept`, and what is left is tidied; a discard that left neither folder nor branch is `discarded`. Anything else stays pending, and the person's next Keep or Discard finishes it: each step of a keep is skipped when a repeat finds it done. What is left of settled worktrees is tidied when nothing would be lost, and so is a folder under `<data>/worktrees` no thought records only when it is provably a launch's (its name is that of a launch attempt the store records, which stopped between making the worktree and recording it), git still ties it to `tasktap/<name>`, nothing is in it beside the branch's files, and the branch's commits are on another branch too. Anything else there is left alone. Pending changes are never removed by a sweep, however long they wait.
- **Removed or moved behind the core's back.** A worktree folder deleted by hand leaves what its branch holds as the changes; Keep and Discard work on the branch, and a run that needs the worktree makes it again. A project folder moved or deleted stops nothing: Keep refuses, Discard removes the worktree folder, which is Tasktap's, and leaves the branch to the repository wherever it went.
- **Git as the core runs it.** A command, never a library, found on the terminals' PATH, in the checks' fixed environment, with the worktree's lock file as standard input (none when no worktree is held), its output written to files of the core's, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` (a look never takes the project folder's index lock) and `GIT_CEILING_DIRECTORIES` at `<data>/worktrees` (a folder there without its own `.git` is no repository), each with a deadline: 60 s for one that reads, 600 s for one that writes a whole tree. No program the repository or the person configured runs: hooks (`core.hooksPath` pointed at a folder that never exists), filters (every `filter.<name>` configured for the repository or the worktree has its `clean`, `smudge` and `process` emptied and `required` off), merge drivers (every `merge.<name>.driver` becomes `false`, so its file is a conflict), signing, `core.fsmonitor`, the pager, external diffs and text conversion. Also off: color, automatic gc and maintenance, autostash, renormalizing, recursing into submodules, `core.safecrlf`, renames, prefixes other than `a/` and `b/`, and Git LFS fetching (`GIT_LFS_SKIP_SMUDGE`). The rest of the person's configuration applies, such as line endings and excludes; `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM` pass through where the core has them. Tasktap's commits carry the person's configured identity, or `Tasktap <tasktap@localhost>`. **Decided:** no program configured for the repository runs for Tasktap's own git commands: a hook may wait for input, fail or take long, and a filter or merge driver is a program that can change any file of the person's, even during a Keep that is then refused. A file a filter applies to is therefore looked at as stored (an LFS file as its pointer) and never kept by Tasktap: Keep refuses it and the person merges `tasktap/<name>` themselves. The agent's own commands in its worktree run all of these as usual.

| | Claude Code (2.1.326) | Codex (0.169.0) |
| --- | --- | --- |
| New run | `claude [--model M] --settings {hooks} --session-id <session> --permission-mode auto -- <prompt>` | `codex -c hooks.state={…} --no-daemon -c projects={"<cwd>"={trust_level="trusted"}} [--model M] -c hooks.<7>=… --approve-for-me -- <prompt>` |
| Resume | `claude --settings {hooks} --resume <handle> --permission-mode auto -- <prompt>`, its model kept | `codex -c hooks.state={…} --no-daemon -c projects=… -c hooks.<7>=… --approve-for-me resume <thread> -- <prompt>` |
| Resume handle | `session_id` of every payload: our session id, until `/clear` starts another | `session_id` of every payload, the thread id |
| Probe | none | `codex -c hooks.<7>=… app-server --listen stdio://` with `initialize`, `initialized` and `hooks/list` for the run's folder, written at once; all 7 hooks must be listed (0.2 s here). Their hashes, and those of the hooks the person trusted, become `-c hooks.state={…}`, which replaces that table for the run |
| Hooks | `<exe> hook claude`, 8: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest (600 s), Notification, Stop, StopFailure | `<exe> hook codex`, 7: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest (600 s), Stop, Interrupt (3 s, the most Codex allows) |
| Event ids | `<hook>:<prompt_id>`, with the tool call's id where there is one | `<hook>:<turn_id>`, the same |
| Detection | `claude --version`; `claude auth status --json`: `loggedIn`, `email` | `codex --version`; `codex login status`: exit 0 and "Logged in using ChatGPT" |
| Permission requests | `reply_via: core` | `reply_via: core` |
| Questions | `AskUserQuestion` with one question and one answer: `core`, its options the choices; with more: `terminal` | `request_user_input`: `terminal` |

| Hook | Claude Code | Codex |
| --- | --- | --- |
| SessionStart | `ready` | `ready` (Codex runs it with the first prompt, not at start) |
| UserPromptSubmit | `turn_started` with the prompt | the same |
| PreToolUse | `activity`: the tool and what it does; nothing for `AskUserQuestion` | `activity`; for `request_user_input`, a question answered in the terminal |
| PermissionRequest | a confirm question the hook waits on; for `AskUserQuestion`, its question | a confirm question the hook waits on |
| PostToolUse | for `AskUserQuestion`, `continued` naming that question | for `request_user_input`, `continued` |
| Notification `elicitation_dialog` | a question answered in the terminal | – |
| Stop | `turn_finished` with `last_assistant_message` | the same |
| StopFailure | `turn_failed` with the error | – |
| Interrupt | – | `turn_interrupted` |

A payload with `agent_id` comes from a sub-agent, whose reports the guards drop; its permission request maps to nothing, so no hook waits on it (a hook that waited would ask past the guards, as the main agent) and the tool asks in its own terminal. Neither tool numbers its turns (`prompt_id` and `turn_id` are ids), so no `turn` is sent; the event id, which names the turn, makes a repeat ignored. A payload with no event name, or one the core does not keep, maps to nothing and the hook exits 0; only one that is no JSON object is an error (65), which neither tool treats as blocking. The payloads are recorded in `core/tests/fixtures/agents/`, and `core/tests/agents.rs` tests the mapping against them.

**Answering from outside the terminal: the trial (package D).** A waiting hook can decide a permission request in both tools, and Claude Code's questions; a question Codex asks can only be shown. The evidence, from live runs of Claude Code 2.1.326 and Codex 0.169.0:

- Claude Code, permission request: a `PermissionRequest` hook prints `{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}`, or `"deny"` with a `message` (a text answer is that message, as Claude Code's "No, and tell Claude what to do differently"). Run with `--permission-mode default`, a Bash command the hook allowed ran and wrote its file; one it denied after 7 s did not, and the model said it was declined. Claude Code shows its own dialog in the terminal while the hook waits and takes whichever answer comes first.
- Claude Code, question: `AskUserQuestion` asks permission as a tool does, and a hook that allows it with `updatedInput` set to its input plus `answers` (the question's text mapped to the chosen option's label, or to free text) answers it: a choice and a free text both reached the model. Through the core in auto mode (`tests/live.rs`): the question opened with `reply_via: core` and the options as choices, a device answered, the hook printed the answer, the receipt was delivered and the run replied with the choice. Answered in the terminal instead, the hook goes on waiting, so the `PostToolUse` of that call reports `continued` naming it: the core settles it as answered in the terminal, and the hook prints nothing.
- Codex, permission request: the same output decides. Codex waits for the hook before it shows its own approval (during an 8 s wait its terminal showed only "Working"), so while a hook waits the person answers from the notch; an allowed command ran, a denied one did not. After 600 s the hook is ended; that Codex then shows its own approval is not verified.
- Codex, question: `request_user_input` exists in plan mode only, or with the feature `default_mode_request_user_input`. Only `PreToolUse` and `PostToolUse` run around it; `PreToolUse` can allow, deny or change the call's input but not give its result. So the question is shown in the notch and answered in the terminal (`reply_via: terminal`), and its `PostToolUse` closes it. Answering it from the notch would need a hook between the question and its answer whose output carries the answers, as Claude Code's permission request does.
- A plugin a person installs can end a waiting hook early. On the trial's computer a Claude Code plugin's "hook guard" ends any `PermissionRequest` hook after 10 s, 250 ms in auto mode, and Claude Code goes on with its own dialog; with it on, only an answer that fast counts from the notch. Its own setting turns it off; Tasktap leaves the person's plugins alone.

**Trust.** A project the person added to Tasktap is a folder they chose to work in, so a run there must not stall unseen on the tool's folder-trust prompt, and Tasktap never writes the tools' own configuration to arrange it. Codex is told for each run that the run's folder is trusted (`-c projects={"<cwd>"={trust_level="trusted"}}`), as 1.2 trusted a folder the person had chosen, so it neither stops at its trust prompt nor writes `~/.codex/config.toml`. The setting adds to the person's `projects` table, it does not replace it: with a `CODEX_HOME` of its own whose config trusted folder B, a run in B given `-c projects={"/elsewhere"={…}}` showed no prompt, while an untrusted control folder did (Codex 0.169.0). The dotted form `-c projects.<path>.trust_level=…` is not used: Codex splits the key on every `.` and honours no quotes, so it fails for any folder whose path has a dot. Codex runs a hook only once it is trusted: the probe trusts exactly Tasktap's, for that run. Codex 0.169 has `--dangerously-bypass-hook-trust`, which would run every untrusted hook, a project's too; it is not used.

Claude Code 2.1.326 has no way to trust a folder for one interactive run. Its record is `projects[<folder>].hasTrustDialogAccepted` in `~/.claude.json`, which `--settings` cannot set; `--trust-workspace` belongs to `claude ultrareview` alone; `-p` skips the dialog only because it is not interactive; and the variables that skip it are internal (`CLAUDE_CODE_SANDBOXED` also claims a sandbox and lifts other checks; `CLAUDE_BG_WORKSPACE_TRUSTED` is for its own background sessions). In a folder it does not trust it shows its dialog before anything else and runs no hook until it is answered (a `SessionStart` hook ran at once in a trusted folder and not at all while the dialog showed), so the session would stay starting with nothing saying why. So the adapter names the dialog's words (`prompts`), the launcher has the core read the run's terminal for them until the agent is ready, with control sequences read as word breaks since Claude Code places each word with a cursor move, and the state machine opens a question answered in the terminal (`shown`, §5): "Claude Code is asking whether to trust this folder". The notch shows it with "Answer in terminal"; `ready` closes it as answered there; "No, exit" ends the run, which withdraws it.

**Starting with no window.** Both tools ask their terminal questions as they start, found by running each under a pseudo-terminal and logging what it wrote. Codex 0.169.0 asks the kitty keyboard flags (`CSI ? u`), the primary device attributes (`CSI c`), the cursor position (`CSI 6 n`) and the default foreground and background colors (`OSC 10 ; ?` and `OSC 11 ; ?`, ended with ST), and waits for them: unanswered, it went on after about 250 ms with its defaults here, not at once. Claude Code 2.1.326 asks its terminal's version (`CSI > 0 q`), the kitty flags, `OSC 7501 ; ?` and the primary device attributes, and does not wait. A page that attaches later mutes the questions it replays, so while no client is attached the core answers them itself (§9): the device attributes, the cursor position and the two colors, the questions a program waits on. It leaves the kitty flags, the version and `OSC 7501` unanswered, as a terminal without them does, so the tools use their plain keyboard: a device attributes answer that comes with no kitty answer before it tells them so. A live Codex run with no client attached went from capture to its result in 5.9 s.

**Where the installed tools differ from inv. §5.1.** Codex runs `SessionStart` with the first prompt, not at start; it allows an `Interrupt` hook 3 s at most; it no longer accepts `-a untrusted` (only `on-request` and `never`); it stops at its trust prompt unless the run's folder is trusted, which 1.2 set only on its older launch path; and the folder must be named as Codex resolves it (`/private/var/…` on macOS, not `/var/…`). `SessionEnd` is not hooked: the core sees an exit itself. Claude Code gives every hook of a turn `prompt_id` and a sub-agent's `agent_id`, has `StopFailure`, and gives `PermissionRequest` no `tool_use_id`; it asks permission for `AskUserQuestion`, which is what lets a hook answer it. 1.2's own `PermissionRequest` hook only reported, and its hooks ran 3 s.

The other four, when they return: **Pi** and **OpenCode** have plugins (`observers/pi.mjs`, `observers/opencode`); each shrinks to a few lines that run `tasktap event`, with no resume, and brings its shim rules with its adapter. **Cursor** and **Antigravity** have no hooks: their thoughts move on launch and exit only, and they can ask through `tasktap ask` if told to in the prompt.

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
- **The local router (built in Phase 2, `core/src/route.rs`).** A pure function over the request the core builds from its records: the open projects whose folder is there, with their names and aliases, and the sessions a follow-up can reach in them (not ended, or ended with a resume handle). It needs no model, no provider and no setting, so a normal build routes every capture with it; the fixture router replaces it only in a test that scripts a result. A name is named when it appears in the capture as whole words, ignoring case; the brief is the person's text unchanged. `route.hint {text, current?}` answers with the same match and no effect, as the protocol's `Route` (`clear` with `to` and `brief`, `ambiguous` with `prompt` and `candidates`, or `unknown`); `thought.capture {current?}` names the session the person was in, which, unlike `session_id`, is not a pick.

| The capture | Route |
| --- | --- |
| has a project or session the person picked | never asked: routed to it at capture (§5) |
| names one session, and no project but that session's | `clear`: a follow-up to that session |
| names no session, was made in a current session, and names no project but that session's | `clear`: a follow-up to the current session |
| names one project and no session | `clear`: a new run in that project |
| names several projects or sessions | `ambiguous`: those are the choices, projects first |
| names nothing | `unknown`: it stays an idea |
- Session naming runs when a turn event arrives, at most once per 180 s per session. No loop.
- **Dictation** is one in-memory record `{id, phase, text, level, target}`. The host always records. Local engines transcribe in the host and report through `dictation.report`; for cloud engines the host sends the recording as a stream and the core makes the web call. **Narration** is `host.speak`, called by the core once per result.
- Keys live in the OS credential store behind one small module.

## 9. Terminals

| Topic | Decision | Reason |
| --- | --- | --- |
| Library | `portable-pty`. Three sleeping threads per live terminal (one reads, one waits for exit, one writes input, since a write blocks once the program stops reading) report to the core thread through one queue of 8; the reader also starts the child, so a working folder on a stalled mount holds up nothing else | One code path for Mac, Linux and Windows (ConPTY). Rejected: per-platform asynchronous code; an emulator in the core to keep screen state. |
| Calls | `terminal.open {id, start?: {project?, argv, title?}, cols, rows, from?, credit}` starts or attaches and returns a stream; empty `argv` is the person's shell (a login shell on Mac, as a terminal window starts it; an interactive one on Linux, as Linux terminals start it, since a login profile such as Debian's sets PATH anew and would drop the shims), any other runs directly with no shell around it. The id is the attempt (§3): the row is committed before the process starts, the same id and `start` again attaches, another `start` is `conflict`, and an id the store knows is never started again. `terminal.resize`. `terminal.stop` ends the process. The launcher starts an agent's terminal through the same code (`terminal::spawn`, `terminal::stop`). | 12 operations become 3 calls and a stream. Size is given at open (hazard 17). |
| Tabs | Closing a tab closes the stream and nothing else: the process keeps running in the background, as today. Stop ends the process and keeps the record and history. History is deleted only with the record, by `delete {c: terminals, id}` for a terminal that is not running and no session names. `project.close {id, stop}` refuses new terminals in the project until `project.add` names its folder again, and with `stop` stops its running ones in the same step. | Keeps "Keep running in background" and the workspace fence. |
| Output | The core always drains the terminal into a ring of up to 2 MiB, grown on demand. Each attached client has its own position and is sent bytes as its credit allows. A child's exit ends the session in the terminal at once, and the terminal once its output has ended, or 1 s later if something it left running still holds the terminal. What the child left running then ends with the terminal, as a stop ends it (below). | An agent is never blocked because a window is slow or closed. |
| Offsets | A terminal offset counts every byte the terminal wrote; a mark's `at` counts the stream's own bytes. The reply's `from` is the terminal offset of the stream's first byte, and a `gap` mark's `from` that of the byte after it. | Reconnecting names terminal offsets; a stream restarts after a gap. |
| A client that falls behind | Once its position leaves the ring it gets `mark {gap, from}` and a fresh replay, when it next has credit. | The same path as reconnecting. The ring is larger than the 10,000 lines the page keeps. |
| Reconnect | `terminal.open {from: <last offset>}`: if still in the ring, only the missing bytes; otherwise `gap` and a replay from the ring's start. Every stream begins with the size in effect where it starts, has a size mark at each later resize, and `mark {live}` where the ring ended when it opened. The page mutes query replies until `live`. | No reset when nothing was missed. |
| Questions to the terminal | While no client is attached, the core answers what a program asks its terminal and waits on, from the output it drains: primary and secondary device attributes (`\x1b[?62;22c`, `\x1b[>0;276;0c`), the cursor position (`\x1b[1;1R`: the core keeps no screen, and a program asks as it starts), and the default foreground and background colors (`OSC 10`, `OSC 11`, the dark theme's, ended as asked). Once a client is attached everything after its `live` mark is the client's to answer, and the core is quiet, so no question is answered twice. The same scan (`terminal/queries.rs`) answers the one question the Windows console asks itself before it shows anything, the cursor position, always, and takes it out of the output. A client that falls so far behind that its replay skips a question leaves that one unanswered; the program then goes on as with a terminal that does not answer. | A run must start with no window open (§7). Rejected: an emulator in the core. |
| Resize | One size per terminal, last caller wins. The new size is a `mark` at the exact byte offset, and a field of the record, written with the offset. | Replaces `resized` and its accidental firing (hazard 14). |
| Input | Bytes on the same stream, against credit from the core: each attached client may have 64 KiB on its way to the process, granted back as the input thread writes it. No size cap, no chunking rules. Credit is granted, at attach and as input is written, only out of what the terminal does not yet hold for its process, 64 KiB at most counting input a client sent before it closed its stream and what the core typed: a process that reads nothing holds at most that plus what the clients attached now may still send, however often clients come and go. What the core types itself (a follow-up, an answer to a question the program asked) goes the same way, and a follow-up is typed once the input thread has written it. The first write that fails ends the terminal's input: nothing more is granted back, nothing more is taken, and what the core typed and the thread did not write fails with why. | Hazard 18. Nothing is reported written that was not. |
| Scrollback | In memory while the process runs; written to `<data>/scrollback/<id>` (a header line with the ring's start offset and sizes, then the bytes) when it exits, on a thread of its own, and when the core shuts down; read back as a client takes it. The record says the terminal exited once its history is on disk; a client attaching while it is written replays it from memory. The record's `offset` is written at start, at each resize and at exit. | After quit, reboot or update the history is there (hazard 13). Only a core crash loses it, and then its terminals are gone too while thoughts and results are safe. |
| Stopping | Hang-up to every process group of the child's session, kill after 2 s (one timer). The child leads its own session, so that is everything the terminal started, in whatever group, unless a process left the session itself (`setsid`, as a daemon does); the core lists the processes when it hangs up and again when it kills (`/proc` on Linux, `proc_listallpids` on macOS) and signals each group with one in the session. A terminal that ends because its child exited stops what is left of its session the same way, so nothing it started runs on with no terminal to show it and nothing to stop it. Shutting down stops every terminal so and waits for them, at most 4 s, and then for every kill still due, which a terminal that ended before its kill leaves behind when its child ended on hang-up and what ignored it let go of the terminal; the sessions in them are left to the next start, which finds them interrupted (§3), since the core ended them, not their agents. On Windows each terminal's processes are in a job: hang-up closes the console, the kill ends the job, and closing the job's last handle, with the terminal or the core, ends them too. | Only a process that left the session outlives a stop on Mac and Linux. On Windows the job already ended a terminal's processes with it. |
| Environment | The fixed list of §7: `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG` (`en_US.UTF-8` when the core has none), `PATH`, `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=Tasktap`, `TASKTAP_DATA`, `TASKTAP_SOCKET`, `TASKTAP_TOKEN` (every terminal has a session token; the last two come from the roles' one definition, `roles::environment`, §2), and the variables the adapters declare they need (§7), read from the core's environment once at start. `PATH` is `~/.local/bin`, `~/.opencode/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, then the core's own `PATH`, then the system folders, as 1.2 computed it. Windows gets the variables its programs need to find the system, the person's folders and the person's `PATH` instead of the Unix ones. A shell's `PATH` starts with the shim folder (§4), which the core fills from its own program when its first shell starts; every other terminal's ends with the core's own folder, so that `tasktap ask` finds `tasktap` (§7). | Hazard 14. |

## 10. Efficiency

One thread owns all state and runs a single-threaded `tokio` runtime, so there are no locks. Blocking work (terminal reads and writes, waiting for exit, web calls, git, the folder checks of `project.add` and `project.scan`, four at most at once, a launch's search for its program and its probe, and the writing of a terminal's history, since a stalled network mount blocks them for as long as the system lets it) sits on plain threads that sleep in the kernel and send a message when something happens.

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

**Zero idle wakeups.** The core thread waits in the kernel for one of: bytes on a connection, a chunk or an exit from a terminal thread, a signal, or a timer that something armed. Every timer fires once: the hold before launch, the 2 s kill, the 1 s a terminal waits for its output to end after its child exited, the 60 s exit, a new connection's 5 s to say `hello`, a time limit on a web call or spawned command. Nothing repeats. Projects are scanned when a client asks, not watched. SQLite checkpoints on the write path.

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

**Measured in Phase 2 (package E)** by `core/scripts/measure.sh` on an Apple M4 Pro, macOS 27.0.1; every row passes. Idle: 0 wakeups and 0 context switches in 60 s with two clients subscribed and a quiet terminal open, a client attached to it. Memory with no terminals: 2.7 MB. Start: 3.7 ms (median of 25). Stream: 1668 MB/s to the client, 1318 MB/s from it. A keystroke goes in on a terminal's stream and its echo comes back on it (the terminal runs `cat`, so the system echoes it); the core adds the round trip less the same through a bare pseudo-terminal (2.2 µs median): 0.027 ms (median; p95 0.036 ms) of 500 keys, 0.088 ms (p95 0.102 ms) while another client commits 5430 times, 0.037 ms (p95 0.052 ms) beside a second client attached to the same terminal that reads 80 bytes a second. Memory per terminal with its history full: 2.10 MiB for each of 10 more terminals, 2.17 MiB for each of the first 10, which also pay once for what the allocator sets up. The ring grows by doubling to 64 KiB and then takes its 2 MiB at once: doubling all the way left each outgrown buffer with the allocator, 2.7 to 3.2 MiB a terminal. Binary: 5.4 MB. Measured at commit ba25b69 with every review fix in.

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
core/src/terminal.rs, agents.rs (trait, registry), agents/ (claude.rs, codex.rs, rules.rs, checks.rs)  (Phase 2)
core/src/roles.rs        event, hook, ask; roles/shim.rs, roles/fixture.rs; shim.rs: adopted agents (2)
core/src/route.rs        the request a router is asked and the local router (2); its providers (3)
core/src/isolate.rs      worktrees: made, looked at, kept, discarded (3); speech.rs, http.rs, secrets.rs (3)
core/src/import_v1.rs                                                   (Phase 6)
core/tests/              one file per promise, plus fixtures/
```

**Tests** start the real binary on a temporary data folder and speak the protocol through `client.rs`. No test reaches into the core. Fixtures are part of the binary under a test-only feature: `fixture.stream` (a call that opens a stream of known bytes and echoes what it receives, so streams, credit and bounds are tested before terminals exist), a fixture launcher and route provider, and from Phase 2 `tasktap fixture-agent`, which prints, sends events, asks, waits and exits in a real terminal on every platform without shell scripts. `fixture.script {agent}` has the real launcher start that agent, found on the core's PATH as `fixture-agent`; without it the fixture launcher stands in, kept only where a test scripts what the real one cannot do (a launch the store refuses, an answer never confirmed).

**The one check at the end of every phase:** `cargo test -p tasktap-core --test loop`. Capture a thought; route it (the fixture provider answers `clear`); run it; the agent asks; answer it; the agent finishes. It asserts the status sequence captured, routed, working, needs you, working, done; a result tied to the thought; an answer receipt marked delivered; then restarts the core and asserts that every record is still there and that nothing ran again. In Phase 1 a test client holding a session token stands in for the agent; from Phase 2 the fixture agent runs in a real terminal the real launcher started, its steps typed into it and its reports sent through `tasktap hook`, and the assertions do not change. Its restarts end the core as a crash does.

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

### Phase 2 work packages

Phase 2 puts terminals and agents into the core. Claude Code and Codex are carried over first. Critical path: **A → C → D**. B runs beside A; E follows A.

| # | Package and goal | Area | Proving command | Done when | Tier | Needs |
| --- | --- | --- | --- | --- | --- | --- |
| A | **Terminals.** Real terminal processes owned by the core (§9): the ring, attachments over streams at independent positions, marks, reconnect from an offset, resize, input, stop, scrollback kept on exit and shutdown, the environment built from a fixed list, a terminal that belongs to no project, live terminals in the lifetime condition. | `core/src/terminal.rs`, terminal calls and records | `cargo test -p tasktap-core --test terminals` | Output arrives intact and in order through a slow client and a reconnect; an agent is never blocked by a closed window; stop ends the whole process tree; history survives a restart; it builds and passes on Windows. | Opus | – |
| B | **Roles.** The same binary as the tool agents and shells run (§4): `hook`, `event`, `ask`, the shims under an agent's name with `session.adopt` and `shim.hold`, and the test-only `fixture-agent`. A burst of connections starts one core, not many. | `core/src/main.rs`, `roles.rs`, `client.rs`, the adopt call | `cargo test -p tasktap-core --test roles` | Each role does its one call and exits within the start target; `ask` prints the answer; a shim reports its agent's exit; 200 simultaneous starts leave one core. | Opus | – |
| C | **Launcher.** The real launcher behind the state machine's seam: an agent started as the direct child of its terminal with its session token, follow-ups typed only into a live direct child, kill, exit reported as an event. The loop check runs the fixture agent in a real terminal with unchanged assertions. | `core/src/launch.rs`, `effects.rs` seams, `tests/loop.rs` | `cargo test -p tasktap-core --test loop` | The loop passes with a real terminal; nothing reruns after a restart; a follow-up never reaches a shell. | Opus | A, B |
| D | **Claude Code and Codex.** The adapter interface (§7) and the two adapters: launch, hooks, event mapping, resume, detection of installed and signed-in tools. The trial of answering an agent from outside its terminal through a waiting hook. | `core/src/agents/` | `cargo test -p tasktap-core --test agents`, plus a recorded live run of each tool | Recorded hook payloads map to the one vocabulary; a live run of each tool goes from launch to result through the core; the trial's result is recorded here and sets `reply_via`. | Opus | C |
| E | **Measure.** Typing delay through a terminal while the store commits and under a slow client; memory per terminal; the macOS durability setting decided from the numbers. | `core/scripts/measure.sh` | `core/scripts/measure.sh` | Every row passes or the miss is explained; the durability decision is recorded in §3. | Sonnet | A |

### Verify when reached

| Phase | What |
| --- | --- |
| 2 | Done in package E (§10): typing delay while the store commits and while a second client is slow, measured before any efficiency target is claimed. |
| 2 | Done in package D (§7): a waiting hook answers both tools' permission requests and Claude Code's questions (`reply_via: core`); Codex's questions stay `reply_via: terminal`. |
| 2 | Done in the Phase 2 close-out (§7, §9): a Codex run launched with no client attached starts, since the core answers its terminal's questions while no client is attached. |
| 4 | That Codex shows its own approval after a waiting hook's 600 s, and that a person's own Claude Code plugin does not cut a waiting hook short (§7). |
| 3 | Whether macOS asks for the credential store again when the core binary changes with an update. If it does, the host keeps the keys behind one more ability. |
| 4 | Bytes into the page on the Mac: a streamed response on a custom address, or text passed to the page. Trial T measures both. |
| 6 | That the policy for sessions still running in 1.2 (§11) is the only one in code, guide and import report. |
| 7 | Ending a whole process tree on Windows; the order in which ConPTY output drains on close; the pipe's access rules; the shim without `exec`. |
| 7 | A grandchild that escapes the job (Phase 2 review). The job is assigned once `spawn_command` has returned: portable-pty 0.9 starts the child running, with fixed creation flags (`EXTENDED_STARTUPINFO_PRESENT`, `CREATE_UNICODE_ENVIRONMENT`) and an attribute list that holds only the pseudo-console, so whatever the child starts before the core assigns the job is outside it and outlives a stop. The fix needs a ConPTY spawn of the core's own in `sys.rs`: `CreateProcessW` with `CREATE_SUSPENDED`, the job assigned, then the thread resumed; or the job given at creation with `PROC_THREAD_ATTRIBUTE_JOB_LIST`. |
| 7 | Agents installed as batch files (Phase 2 review), as npm installs Codex (`codex.cmd`). `roles::shim::find` accepts `.cmd` and `.bat` from `PATHEXT`, and portable-pty passes the file to `CreateProcessW` as the program. Windows then runs it through `cmd.exe` itself, but `cmd.exe` reads the arguments by its own rules, not the quoting portable-pty applies, so a prompt with `"`, `&`, `|`, `<`, `>`, `^` or `%` can be cut or run as commands (the class of problem known as BatBadBut). Neither starting nor the quoting is verified on Windows yet. The fix: run a batch file as `%ComSpec% /d /s /c "…"` with each argument escaped for `cmd.exe`, refusing what cannot be escaped (a line break), or find the program the batch file runs; a Windows test with a `.cmd` fixture agent and a prompt holding each of those characters proves it. |
| 7 | Isolation on Windows (§7): a worktree is found in use there only because a folder a process works in, or holds a file of, cannot be renamed (the core cannot read another process's working folder), so a process that works there holding nothing open is missed; a worktree's lock file reaches git as standard input, and a process the core starts at the same moment through another path that inherits every handle could hold it too, until it ends; whether git takes every path the core gives it once the `\\?\` of a canonical path is taken off, long paths under `<data>/worktrees` included. |
| 7 | How the core confirms on Windows that the shim holding an adopted agent's console is the program that reads it (the pipe names its client process; a console has no foreground group): until then a follow-up to an adopted session is not typed there (§7). |
## Defaults chosen

Each is the default so that building is not blocked. The owner may overrule any of them.

1. **Voice waits for Enter.** After hold to talk the text is shown, for a thought and for a spoken reply alike. A mishearing should not start work.
2. **Undo is a hold. Changes the plan.** A clear thought shows "Sent to X" at once and launches when the Undo seconds have passed. The duration is a preference; zero launches at once. Stopping an agent after it started could not take back what it did in a project that is not isolated.
3. **A prompt typed by hand becomes a thought**, so Home and the glance list everything in flight.
4. **Sessions still running in 1.2** are imported as interrupted, with Resume (§11).
5. **Dropped:** Resume in Terminal and copy-resume (never worked), the Claude brief session in Terminal.app, the discussion step before an answer (a text reply), the terminal typing trace, questions from tools outside Tasktap's terminals. Agent sign-in moves from Terminal.app into a Tasktap terminal that belongs to no project (Phase 2).

Still open: **one host or two**, which trial T settles.
