// Generated from core/proto. Do not edit: run `BLESS=1 cargo test -p tasktap-proto`.

export const VERSION = 1;
export const MAX_FRAME = 1048576;
export const MAX_DATA_FRAME = 65536;
export const MAX_DATA = 65531;
export const MAX_CREDIT = 4194304;
export const MAX_PENDING_CALLS = 64;
export const MAX_STREAMS = 64;
export const MAX_TERMINAL_SIZE = 1000;
// Bounds of what a call writes into a row; a call over one is `invalid`. MAX_TEXT: a thought's
// text, a question's detail, a text answer. MAX_LINE: a question's prompt and its choices, a
// router's brief, a session's error, a project's name, color, folder and aliases, a device's
// name. Both count bytes of JSON: `new TextEncoder().encode(JSON.stringify(value)).length`.
// MAX_POINTS: the points of a thought's strokes, an empty stroke counting as one.
export const MAX_TEXT = 65536;
export const MAX_LINE = 8192;
export const MAX_POINTS = 2048;
/** The value of each preference while none is stored: deleting one restores it. */
export const PREF_DEFAULTS: { [K in PrefKey]: Extract<Pref, { id: K }>["value"] } = {"agent":null,"hold":5};

/**
 * Who may make a call (design §2): authorization is per call.
 */
export type Access = "anyone" | "device" | "session" | "ability";

export type Action = "answer.affirm" | "answer.deny";

/**
 * `project.add`. The reply is the id of the project that holds the folder,
 * which is an older one when the folder was already added.
 */
export type AddProject = { id: ProjectId, folder: string, name?: string | null, };

/**
 * `session.adopt`: an agent a person started by hand in a Tasktap shell
 * becomes a session of that shell's terminal (design §4). The token names
 * the terminal; the reply is the new session. The session belongs to the
 * connection that adopted it and ends with it.
 */
export type Adopt = {
/**
 * The agent's name, as `tasktap hook <agent>` takes it.
 */
agent: string,
/**
 * The folder the person started it in.
 */
cwd: string, };

/**
 * One agent as found on this computer, and what its runs can do.
 */
export type AgentHealth = {
/**
 * Its id, as a capture and `tasktap hook` name it.
 */
id: string,
/**
 * Its program is on the PATH the core's terminals get.
 */
installed: boolean,
/**
 * As it reports its version.
 */
version: string | null,
/**
 * Whether it is signed in; none when it could not be told.
 */
signed_in: boolean | null,
/**
 * Whom it is signed in as, or how, as it says.
 */
identity: string | null,
/**
 * Its runs report through hooks; one that does not reports by exiting.
 */
events: boolean,
/**
 * A new run can continue an ended session's conversation.
 */
resume: boolean,
/**
 * Where its permission requests are answered; none: none are heard.
 */
permissions: ReplyVia | null,
/**
 * Where the questions it asks the person are answered; none: none are heard.
 */
questions: ReplyVia | null, };

/**
 * The reply of `agents.detect`, in the order the core lists its agents.
 */
export type Agents = { agents: Array<AgentHealth>, };

/**
 * The receipt of an answer, stored before it is sent.
 */
export type Answer = { device_id: DeviceId | null, created: Time,
/**
 * When the waiter confirmed it with `question.received`.
 */
delivered: Time | null, } & ({ "kind": "affirm" } | { "kind": "deny" } | { "kind": "choice", choice: number, } | { "kind": "text", text: string, } | { "kind": "terminal" });

/**
 * `question.answer`. Settles only the question it names.
 */
export type AnswerQuestion = { id: QuestionId, } & ({ "kind": "affirm" } | { "kind": "deny" } | { "kind": "choice", choice: number, } | { "kind": "text", text: string, } | { "kind": "terminal" });

/**
 * `question.ask`: the reply is the answer, once there is one.
 */
export type Ask = {
/**
 * The asker's key, kept per session: asking again with it reaches the
 * same question, and the same key from another session is another one.
 */
request: string, prompt: string, detail?: string | null,
/**
 * What asks: `permission` for a permission request a hook waits on;
 * without it, `agent`, a question of the agent's own. A session never
 * asks as the `router`: that is `invalid`.
 */
source?: QuestionSource | null, } & ({ "kind": "confirm" } | { "kind": "choice", choices: Array<string>, } | { "kind": "text" });

/**
 * `question.withdraw` and `question.received`: the asker names its question
 * by its own key, the only name it holds while it waits. The key reaches
 * only its own session's questions.
 */
export type AskKey = { request: string, };

/**
 * `thought.update`: assigns a note to a project.
 */
export type Assign = { id: ThoughtId, project_id: ProjectId, };

/**
 * A UUID v7 in text, minted by whoever creates the record.
 * Names one attempt to start a process, so a repeated call never starts it twice.
 */
export type AttemptId = string;

export type Auth = { device: DeviceId, key: Secret,
/**
 * Present when a local peer registers this device on first contact.
 */
register?: Register | null, } | { token: Secret, };

/**
 * A call id, unique among the caller's pending calls.
 */
export type CallId = number;

/**
 * One choice of an ambiguous route, as its question shows it.
 */
export type Candidate = { label: string, to: Place, };

/**
 * `thought.capture`. A project or session given here is the person's own
 * pick, which routes the thought without asking the router.
 */
export type Capture = { id: ThoughtId, text: string, strokes: Array<Array<[number, number]>>, source: Source, mode?: Mode | null, project_id?: ProjectId | null, session_id?: SessionId | null,
/**
 * The agent a new run of the thought uses, by the id `agents.detect`
 * lists; without one, the `agent` preference, else the first agent
 * this core has. A follow-up uses its session's agent.
 */
agent?: string | null,
/**
 * The model a new run asks its agent for; without one, the agent's own default.
 */
model?: string | null,
/**
 * The session the person was in when they captured, which the router
 * sends the thought on to unless its text names another project. Not
 * a pick: unlike `session_id`, the router still decides (design §8).
 */
current?: SessionId | null, };

/**
 * One committed transaction, or one chunk of a snapshot.
 *
 * A snapshot arrives before the reply to `sub` as frames marked `snap`, of
 * at most 256 KiB of JSON each. A transaction too large for one frame is cut
 * the same way, without `snap`: several frames in a row with the same `rev`
 * and nothing between them, each holding whole rows, a set's rows before its
 * deletions (so a collection may appear in more than one set). Every frame
 * of a snapshot or a transaction but the last is marked `more`, so a client
 * applies a transaction whole once its last frame has arrived.
 */
export type Change = { rev: Rev, snap?: boolean, more?: boolean, sets: Array<Set>, };

export type Changes = "none" | "pending" | "kept" | "discarded";

export type Close = { s: StreamId, why?: CloseWhy | null, };

/**
 * `project.close`: no terminal starts in the project until `project.add`
 * names its folder again. With `stop`, its running terminals are stopped in
 * the same step, as `terminal.stop` does; without, they keep running.
 */
export type CloseProject = { id: ProjectId, stop: boolean, };

export type CloseWhy = "done" | "overflow" | "gone" | "denied";

export type Code = "unknown" | "invalid" | "denied" | "conflict" | "gone" | "failed";

export type Collection = "thoughts" | "projects" | "sessions" | "terminals" | "questions" | "results" | "layouts" | "prefs" | "devices" | "glance";

/**
 * A kind 0 frame. Unknown fields are ignored, so a newer peer may add fields
 * without bumping the version.
 */
export type Control = { "t": "hello" } & Hello | { "t": "welcome" } & Welcome | { "t": "refuse" } & Refuse | { "t": "call" } & Request | { "t": "reply" } & Reply | { "t": "change" } & Change | { "t": "credit" } & Credit | { "t": "mark" } & Mark | { "t": "close" } & Close;

/**
 * A UUID v7 in text, minted by whoever creates the record.
 * The core itself, named in `welcome` so a client can hold records from several cores.
 */
export type CoreId = string;

/**
 * The result of `core.status`.
 */
export type CoreStatus = { build: string, v: Versions,
/**
 * Live terminals, which retiring now would end.
 */
terminals: number, };

/**
 * Grants `n` more bytes on stream `s`.
 */
export type Credit = { s: StreamId, n: number, };

/**
 * `delete`: removes plain data, and a terminal that is not running with its
 * history, the only way history is removed; one a session refers to is
 * `conflict`. Deleting a preference restores its default.
 */
export type Delete = { "c": "prefs", id: PrefKey, } | { "c": "layouts", id: ProjectId, } | { "c": "thoughts", id: ThoughtId, } | { "c": "terminals", id: TerminalId, };

/**
 * `agents.detect`: whether each agent this core can run is installed on the
 * PATH its terminals get and signed in, as the agent itself says. Without
 * `agents`, every one. Each check runs the agent's own command, at most 4 s.
 */
export type DetectAgents = { agents?: Array<string> | null, };

export type Device = { id: DeviceId, rev: Rev, name: string, last_seen: Time | null, revoked: boolean, };

/**
 * A UUID v7 in text, minted by whoever creates the record.
 */
export type DeviceId = string;

/**
 * Arguments of a call that takes none: `{}`.
 */
export type Empty = Record<string, never>;

/**
 * The one error shape of every failed call.
 */
export type Error = { code: Code, message: string, };

/**
 * `fixture.clock`: from now on the core's clock reads `now` and moves only
 * when called again; every hold that has ended by then ends before the reply.
 */
export type FixtureClock = { now: Time, };

/**
 * One launch: the terminal it started takes the session's id, and carries
 * the session token a real launch puts in the agent's environment.
 */
export type FixtureLaunch = { thought: ThoughtId, session: SessionId, prompt: string, token: Secret, };

/**
 * What the fixture launcher and host were asked, oldest first.
 */
export type FixtureLog = { launched: Array<FixtureLaunch>,
/**
 * The thoughts of the follow-ups handed to a running session.
 */
delivered: Array<ThoughtId>,
/**
 * Follow-ups that `pause` keeps untyped, one to an adopted session while
 * its shim holds the terminal for it.
 */
held: Array<ThoughtId>, killed: Array<TerminalId>, settled: Array<ThoughtId>,
/**
 * The questions the host would have been told about.
 */
notified: Array<QuestionId>, };

/**
 * `fixture.records`: writes rows only the state machine writes otherwise, so
 * records can be proven without it (design §13): the thoughts and projects
 * given are inserted or replaced and the questions, with their answers,
 * and results inserted, in one
 * transaction published like a `put`'s. Other collections are `invalid`.
 * Only a core built with its test fixtures answers it.
 */
export type FixtureRecords = { sets: Array<Set>, };

/**
 * `fixture.script`: selects the fixture router and launcher, which a core
 * built with its test fixtures has instead of the real ones (design §13), and
 * scripts them. Until it is called such a core has neither, like a release
 * build. The reply is everything they were asked since.
 */
export type FixtureScript = {
/**
 * What the router answers for every thought from now on.
 */
route: Route,
/**
 * The launcher refuses every launch, delivery and settle with this.
 */
refuse?: string | null,
/**
 * The launcher starts each run in a terminal the store refuses (one of a
 * project that does not exist), so recording the launch fails.
 */
unrecordable: boolean,
/**
 * A follow-up waits untyped, one to an adopted session held by its
 * shim, until a script without `pause` arrives.
 */
pause: boolean,
/**
 * Runs start for real: new captures name this agent, and the core's
 * launcher starts them in terminals. Without it the fixture launcher
 * only records what it is asked, as `refuse` and `unrecordable` say.
 */
agent?: string | null, };

/**
 * `fixture.stream`: a stream of known bytes with no terminal behind it, for
 * tests and measurement (design §13). Only a core built with its test
 * fixtures answers it. The reply is the stream.
 *
 * Both directions carry the fixture's bytes from offset 0: byte `i` is the
 * top byte of the 32-bit product `(i mod 65521) × 0x9E3779B1`. The core
 * closes the stream with `done` once it sent `send` bytes and took
 * `receive` bytes, or with `denied` at the first byte taken that differs.
 */
export type FixtureStream = {
/**
 * What the caller grants the core on this stream at once.
 */
credit: number,
/**
 * Bytes the core sends.
 */
send: Offset,
/**
 * Bytes the core takes. It never grants more than are still to come.
 */
receive: Offset,
/**
 * Most bytes the core puts in one data frame, and the credit it keeps
 * granted toward it; up to `MAX_CREDIT`.
 */
chunk: number,
/**
 * Offsets of the sent bytes where the core puts a plain mark, ascending.
 */
marks?: Array<Offset>, };

/**
 * What a host shows with no page running. Memory only.
 */
export type Glance = { rev: Rev, working: number, needs_you: number,
/**
 * Done and not read yet.
 */
done: number,
/**
 * Failed and not read yet: stopped, refused, interrupted or ended
 * without an answer, and not yet seen (`thought.read`) or retried.
 */
failed: number,
/**
 * The question affirm and deny act on: the oldest open one unless
 * `question.focus` chose another.
 */
question: QuestionId | null,
/**
 * `core.retire {when: idle}` was called: the core exits when its last terminal ends.
 */
retiring: boolean, };

export type Hello = { v: Versions, role: Role,
/**
 * Free text naming the program, for logs.
 */
client: string, auth?: Auth | null,
/**
 * The `host.*` calls a host answers.
 */
abilities?: Array<string>, };

/**
 * `route.hint`: where a capture would go, asked while it is typed (the
 * destination chip). The same match the router makes, with no effect.
 */
export type Hint = { text: string,
/**
 * As `thought.capture`'s `current`.
 */
current?: SessionId | null, };

/**
 * `history`: finished thoughts older than `before`, newest first; with
 * `after`, first the questions and results of `before` after that id.
 */
export type History = { before?: ThoughtId | null, after?: string | null, limit: Limit, };

/**
 * Thoughts that left the live set, each with its questions and results,
 * cut where the rows stop fitting one snapshot chunk: a short page is not
 * the end, an empty one is.
 */
export type HistoryPage = { thoughts: Array<Thought>, questions: Array<Question>, results: Array<TurnResult>,
/**
 * Set when the page was cut among a thought's questions and results:
 * the id of the last it holds, in id order (nil for none). The next
 * page asks with it as `after` and that thought as `before`: the last
 * in `thoughts`, or the `before` this page was asked with.
 */
after?: string, };

/**
 * Who the core took the connection to be.
 */
export type Identity = "device" | "session" | "none";

/**
 * `input`: a key press from any device, bound to the question it was shown for.
 */
export type Input = { action: Action, question: QuestionId, };

/**
 * When a thought gets its own worktree; `busy` means when the project has
 * a session that is not idle or ended.
 */
export type Isolate = "busy" | "always" | "never";

/**
 * A project's workspace layout; the tree is the UI's and opaque to the core.
 */
export type Layout = {
/**
 * The project's id.
 */
id: ProjectId, rev: Rev, tree: unknown, };

export type LayoutPatch = { tree: unknown, };

/**
 * A page size from 1 to 100, which bounds every history reply.
 */
export type Limit = number;

/**
 * Something that happened at byte offset `at` of stream `s`.
 */
export type Mark = { s: StreamId, at: Offset, size?: Size | null,
/**
 * Replay is over; bytes from here on are live.
 */
live?: boolean,
/**
 * The reader fell out of the ring, or reconnected from an offset no
 * longer in it; a replay follows.
 */
gap?: boolean,
/**
 * With `gap`: the source offset of the byte after this mark, where the
 * replay starts. From here on stream offset `at + k` is source offset
 * `from + k`, as `Opened.from` says for stream offset 0.
 */
from?: Offset | null,
/**
 * Present once the process exited: its code, or null when it has none.
 */
exit?: number | null, };

export type Mode = "ask" | "nudge" | "note";

/**
 * The editable fields of a note; a missing one is left as it is.
 */
export type NotePatch = { text?: string | null, strokes?: Array<Array<[number, number]>> | null, };

/**
 * A byte position in a stream since it opened.
 */
export type Offset = number;

/**
 * `terminal.open`: attaches to terminal `id` and replies with a stream of
 * its output, which also carries input to it. With `start`, a terminal no
 * record has yet is started first; the same id with the same `start`
 * attaches, with another is `conflict`. Without `start`, an id no record
 * has is `gone`. A terminal is never started twice: one that exited or was
 * lost is replayed from its history (design §3, §9).
 *
 * The stream starts at `from` while that offset is still in the
 * terminal's ring; otherwise with a `gap` mark and a replay from the ring's
 * start, and at the ring's start when `from` is left out. The reply's
 * `from` says where it started. Then come a size mark with the size in
 * effect there, the bytes, a size mark at each later resize, a `live` mark
 * where the ring ended at the time of opening, an `exit` mark after the
 * last byte, and the close, `done`. `cols` and `rows` resize a running
 * terminal: the last caller wins. Input is accepted while the process runs.
 */
export type OpenTerminal = { id: TerminalId, start?: StartTerminal | null, cols: number, rows: number,
/**
 * The terminal offset the caller has everything before.
 */
from?: Offset | null,
/**
 * What the caller grants the core on this stream at once.
 */
credit: number, };

/**
 * The reply of a call that opens a stream; that call's args carry the
 * credit the caller grants toward it.
 */
export type Opened = { s: StreamId,
/**
 * Bytes the core lets the caller send on this stream.
 */
credit: number,
/**
 * For a source with offsets of its own, a terminal's output: the offset
 * in that source of the stream's first byte. Stream offsets (a mark's
 * `at`) count from 0 on every stream; source offsets are what a
 * reconnect names.
 */
from?: Offset | null, };

/**
 * Written only by the state machine.
 */
export type Phase = "captured" | "routed" | "working" | "done" | "failed";

/**
 * Where a thought goes: a new run in a project, or a follow-up to a session.
 */
export type Place = { "project": ProjectId } | { "session": SessionId };

/**
 * A preference row: `{id, value, rev}`, where the key fixes the value's type.
 */
export type Pref = { rev: Rev, } & ({ "id": "hold", "value": number } | { "id": "agent", "value": string | null });

export type PrefKey = "hold" | "agent";

/**
 * A preference write: `{id, patch}`, where the key fixes the value's type.
 */
export type PrefPatch = { "id": "hold", "patch": number } | { "id": "agent", "patch": string | null };

export type Project = { id: ProjectId, rev: Rev, name: string,
/**
 * Canonical and unique among projects.
 */
folder: string, kind: ProjectKind, color: string, aliases: Array<string>, git: boolean, isolate: Isolate, open: boolean, available: boolean, };

/**
 * A UUID v7 in text, minted by whoever creates the record.
 */
export type ProjectId = string;

export type ProjectKind = "folder" | "scratch";

/**
 * The editable fields of a project; a missing one is left as it is.
 */
export type ProjectPatch = { name?: string | null, color?: string | null, aliases?: Array<string> | null, isolate?: Isolate | null, };

/**
 * `put`: writes plain data. Fields the state machine owns cannot be named
 * here: a patch with a field it does not have is `invalid`.
 */
export type Put = {
/**
 * Refused with `conflict` unless the row is still at this revision.
 */
if_rev?: Rev | null, } & ({ "c": "prefs" } & PrefPatch | { "c": "layouts", id: ProjectId, patch: LayoutPatch, } | { "c": "projects", id: ProjectId, patch: ProjectPatch, } | { "c": "thoughts", id: ThoughtId, patch: NotePatch, });

/**
 * Everything except `state` and `answer` is written once.
 */
export type Question = { id: QuestionId, rev: Rev, thought_id: ThoughtId | null, session_id: SessionId | null, turn: number | null, source: QuestionSource, prompt: string, detail: string | null, reply_via: ReplyVia, state: QuestionState, answer: Answer | null, } & ({ "kind": "confirm" } | { "kind": "choice", choices: Array<string>, } | { "kind": "text" });

/**
 * A UUID v7 in text, minted by whoever creates the record.
 */
export type QuestionId = string;

export type QuestionSource = "agent" | "permission" | "router";

export type QuestionState = "open" | "answered" | "withdrawn";

/**
 * Why a thought failed.
 */
export type Reason = "launch" | "turn_failed" | "interrupted" | "exited" | "stopped";

/**
 * Arguments that name one record.
 */
export type Ref<I> = { id: I, };

export type Refuse = { why: RefuseWhy, };

export type RefuseWhy = "auth" | "revoked";

export type Register = { name: string, };

export type Reply = { id: CallId, } & ({ "ok": unknown } | { "err": Error });

/**
 * `core`: a waiting caller receives the answer. `terminal`: the person
 * answers in the agent's terminal.
 */
export type ReplyVia = "core" | "terminal";

/**
 * A `call` frame. The name stays text so that a name this side does not know
 * still gets a `reply` with `unknown` instead of ending the connection.
 */
export type Request = { id: CallId, name: string, args: object, };

/**
 * `terminal.resize`: one size per terminal, the last caller's. It reaches
 * the process and becomes a size mark at the offset where it happened.
 */
export type ResizeTerminal = { id: TerminalId, cols: number, rows: number, };

/**
 * A UUID v7 in text, minted by whoever creates the record.
 */
export type ResultId = string;

export type ResultKind = "answer" | "failure" | "changes";

/**
 * The arguments of `core.retire`.
 */
export type Retire = { when: When, };

/**
 * Orders committed changes within one run of the core.
 */
export type Rev = number;

/**
 * The revision a snapshot was taken at, or a write committed at.
 */
export type Revision = { rev: Rev, };

export type Role = "page" | "host" | "cli";

/**
 * Where a router sends a thought (design §8): the answer of `route.hint`,
 * and what `fixture.script` has the fixture router answer.
 */
export type Route = { "confidence": "clear", to: Place, brief: string, } | { "confidence": "ambiguous", prompt: string, candidates: Array<Candidate>, } | { "confidence": "unknown" };

/**
 * Rows put whole, and ids of rows that stopped being live.
 */
export type Rows<R, I> = { put?: Array<R>, del?: Array<I>, };

/**
 * 32 random bytes as 64 hex digits: a device key or a session token.
 */
export type Secret = string;

export type Session = { id: SessionId, rev: Rev, project_id: ProjectId, agent: string, terminal_id: TerminalId | null,
/**
 * Started by hand in a shell rather than launched by the core.
 */
adopted: boolean, state: SessionState,
/**
 * The thought of the current turn.
 */
thought_id: ThoughtId | null, turn: number,
/**
 * The agent's own handle for resuming.
 */
resume: string | null, name: string | null, named_at: Time | null, model: string | null, cwd: string, exit: number | null, error: string | null,
/**
 * The last 40 activity lines, oldest first; kept in memory only.
 */
activity: Array<string>, };

/**
 * `session.event`: what the session's agent reports, in the core's one vocabulary.
 */
export type SessionEvent = {
/**
 * The sender's own id for this event; the core ignores a repeat.
 */
id: string,
/**
 * The session's turn the event belongs to, when the sender knows it; a
 * turn start names the turn it begins. The core ignores an event for
 * another turn (design §5).
 */
turn?: number | null,
/**
 * Sent for one of the agent's sub-agents, whose events the core ignores.
 */
subagent?: boolean,
/**
 * The agent's own handle for continuing this conversation in a later
 * run, when its report carries one; the session keeps the latest.
 */
resume?: string | null, } & ({ "kind": "ready" } | { "kind": "turn_started", prompt?: string | null, } | { "kind": "activity", text: string, } | { "kind": "continued", request?: string | null, } | { "kind": "turn_finished", answer?: string | null, } | { "kind": "turn_failed", error?: string | null, } | { "kind": "turn_interrupted" } | { "kind": "question", question: Ask, } | { "kind": "exited", code?: number | null, });

/**
 * A UUID v7 in text, minted by whoever creates the record.
 */
export type SessionId = string;

/**
 * Written only by the state machine. A session with an open question
 * shows asking; that is read from its questions, not stored here.
 */
export type SessionState = "starting" | "idle" | "working" | "ended";

/**
 * The rows of one collection that one change touches.
 */
export type Set = { "c": "thoughts" } & Rows<Thought, ThoughtId> | { "c": "projects" } & Rows<Project, ProjectId> | { "c": "sessions" } & Rows<Session, SessionId> | { "c": "terminals" } & Rows<Terminal, TerminalId> | { "c": "questions" } & Rows<Question, QuestionId> | { "c": "results" } & Rows<TurnResult, ResultId> | { "c": "layouts" } & Rows<Layout, ProjectId> | { "c": "prefs" } & Rows<Pref, PrefKey> | { "c": "devices" } & Rows<Device, DeviceId> | { "c": "glance", put: Array<Glance>, };

/**
 * `thought.settle`: keeps or discards the changes of a thought's worktree,
 * once its session has ended. The attempt makes a repeat answer from its record.
 */
export type Settle = { id: ThoughtId, attempt: AttemptId, keep: boolean, };

/**
 * `shim.hold`, which the core calls on the shim of an adopted session before
 * it types a follow-up into the shell's terminal (design §7). With `hold` the
 * shim confirms its agent runs in the foreground and keeps the terminal
 * until a call without it, sent once the text is written; a shim whose agent
 * has ended answers `gone`. With `stop` the shim ends its agent, as
 * `thought.stop` stops a run, and never the shell it runs in.
 */
export type ShimHold = { hold: boolean, stop: boolean, };

/**
 * A terminal size: `[cols, rows]`.
 */
export type Size = [number, number];

export type Source = "typed" | "voice" | "terminal" | "import";

/**
 * `thought.start`. The attempt is committed before anything is spawned, so
 * repeating this call never launches twice.
 */
export type Start = { id: ThoughtId, attempt: AttemptId, };

/**
 * What a new terminal runs.
 */
export type StartTerminal = {
/**
 * The open project whose folder it runs in; without one it runs in the
 * person's home folder and belongs to no project.
 */
project?: ProjectId | null,
/**
 * The program and its arguments, started directly with no shell around
 * it; empty starts the person's login shell.
 */
argv: Array<string>,
/**
 * By default the program's name.
 */
title?: string | null, };

/**
 * Derived in the same transaction as the phase: `needs_you` while the
 * thought has any open question, otherwise its phase.
 */
export type Status = "needs_you" | "captured" | "routed" | "working" | "done" | "failed";

/**
 * A stream id, never reused on its connection.
 */
export type StreamId = number;

/**
 * `sub`: a second one replaces the first; an empty list ends it.
 */
export type Subscribe = { collections: Array<Collection>, };

export type Terminal = { id: TerminalId, rev: Rev, project_id: ProjectId | null, kind: TerminalKind, title: string, cwd: string, argv: Array<string>, cols: number, rows: number, state: TerminalState, exit: number | null,
/**
 * Bytes of output, as of the row's last write: at start, at each
 * resize, and at exit, when it is final. A stream counts the rest.
 */
offset: Offset, };

/**
 * A UUID v7 in text, minted by whoever creates the record.
 */
export type TerminalId = string;

export type TerminalKind = "shell" | "agent" | "task";

export type TerminalState = "running" | "exited" | "lost";

/**
 * The primary record. A note is a thought with mode `note`.
 */
export type Thought = { id: ThoughtId, rev: Rev, text: string, strokes: Array<Array<[number, number]>>, source: Source, mode: Mode, phase: Phase, status: Status, reason: Reason | null, live: boolean, project_id: ProjectId | null, session_id: SessionId | null, brief: string | null, agent: string | null, model: string | null, workdir: Workdir | null, hold_until: Time | null, read: boolean, created: Time, updated: Time, };

/**
 * A UUID v7 in text, minted by whoever creates the record.
 */
export type ThoughtId = string;

/**
 * Milliseconds since the Unix epoch.
 */
export type Time = number;

/**
 * A result of a turn.
 */
export type TurnResult = { id: ResultId, rev: Rev, thought_id: ThoughtId, session_id: SessionId | null, turn: number | null, kind: ResultKind, summary: string, };

/**
 * `[min, max]`, both inclusive.
 */
export type Versions = [number, number];

export type Welcome = {
/**
 * The highest shared version, or 0 when none is shared.
 */
v: number, core: CoreId, build: string, as: Identity,
/**
 * Names rather than typed calls: a newer core lists calls this crate does not know.
 */
calls: Array<string>, };

export type When = "now" | "idle";

/**
 * The worktree a thought runs in when its project isolates.
 */
export type Workdir = { path: string, branch: string,
/**
 * The branch Keep merges into, recorded at creation.
 */
destination: string,
/**
 * The commit the worktree started from.
 */
base: string, changes: Changes, };

/** Every call: its arguments, its result, and who may make it. */
export type Calls = {
  "sub": { args: Subscribe; result: Revision; access: "device" };
  "put": { args: Put; result: Revision; access: "device" };
  "delete": { args: Delete; result: Revision; access: "device" };
  "history": { args: History; result: HistoryPage; access: "device" };
  "thought.capture": { args: Capture; result: null; access: "device" };
  "thought.update": { args: Assign; result: null; access: "device" };
  "thought.start": { args: Start; result: null; access: "device" };
  "thought.stop": { args: Ref<ThoughtId>; result: null; access: "device" };
  "thought.retry": { args: Ref<ThoughtId>; result: null; access: "device" };
  "thought.settle": { args: Settle; result: null; access: "device" };
  "thought.read": { args: Ref<ThoughtId>; result: null; access: "device" };
  "question.ask": { args: Ask; result: Answer; access: "session" };
  "question.answer": { args: AnswerQuestion; result: null; access: "device" };
  "question.withdraw": { args: AskKey; result: null; access: "session" };
  "question.received": { args: AskKey; result: null; access: "session" };
  "question.focus": { args: Ref<QuestionId>; result: null; access: "device" };
  "session.event": { args: SessionEvent; result: null; access: "session" };
  "session.adopt": { args: Adopt; result: SessionId; access: "session" };
  "route.hint": { args: Hint; result: Route; access: "device" };
  "agents.detect": { args: DetectAgents; result: Agents; access: "device" };
  "terminal.open": { args: OpenTerminal; result: Opened; access: "device" };
  "terminal.resize": { args: ResizeTerminal; result: null; access: "device" };
  "terminal.stop": { args: Ref<TerminalId>; result: null; access: "device" };
  "project.add": { args: AddProject; result: ProjectId; access: "device" };
  "project.scan": { args: Empty; result: null; access: "device" };
  "project.close": { args: CloseProject; result: null; access: "device" };
  "input": { args: Input; result: null; access: "device" };
  "device.revoke": { args: Ref<DeviceId>; result: null; access: "device" };
  "core.status": { args: Empty; result: CoreStatus; access: "anyone" };
  "core.retire": { args: Retire; result: null; access: "device" };
  "shim.hold": { args: ShimHold; result: null; access: "ability" };
  "fixture.stream": { args: FixtureStream; result: Opened; access: "device" };
  "fixture.script": { args: FixtureScript; result: FixtureLog; access: "device" };
  "fixture.clock": { args: FixtureClock; result: null; access: "device" };
  "fixture.records": { args: FixtureRecords; result: Revision; access: "device" };
};
