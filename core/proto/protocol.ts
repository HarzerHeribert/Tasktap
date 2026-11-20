// Generated from core/proto. Do not edit: run `BLESS=1 cargo test -p tasktap-proto`.

export const VERSION = 1;
export const MAX_FRAME = 1048576;
export const MAX_DATA_FRAME = 65536;
export const MAX_DATA = 65531;
export const MAX_CREDIT = 4194304;
export const MAX_PENDING_CALLS = 64;
export const MAX_STREAMS = 64;
export const MAX_TERMINAL_CLIENTS = 8;
export const MAX_TERMINAL_SIZE = 1000;
export const READ_HOLD = 2;
// Bounds of what a call writes into a row; a call over one is `invalid`. MAX_TEXT: a thought's
// text, a question's detail, a text answer. MAX_LINE: a question's prompt and its choices, a
// router's brief, a session's error, a project's name, color, folder and aliases, a device's
// name. Both count bytes of JSON: `new TextEncoder().encode(JSON.stringify(value)).length`.
// MAX_POINTS: the points of a thought's strokes, an empty stroke counting as one.
export const MAX_TEXT = 65536;
export const MAX_LINE = 8192;
export const MAX_POINTS = 2048;
/** The value of each preference while none is stored: deleting one restores it. */
export const PREF_DEFAULTS: { [K in PrefKey]: Extract<Pref, { id: K }>["value"] } = {"agent":null,"agent_options":[],"capture_key":null,"hold":5,"keep_days":0,"keys":[],"motion_ambient":"breathing","motion_hue":265,"motion_lumen":false,"motion_palette":"chromatic","motion_style":"slats","no_key":null,"own_agents":[],"question_key":null,"return_sends":true,"route_by":null,"setup_hidden":false,"speech_by":null,"speech_languages":[],"talk_key":null,"terminal_bold_bright":true,"terminal_contrast":true,"terminal_font":"","terminal_line_height":100,"terminal_size":14,"text_size":"default","update_checks":true,"yes_key":null};

/**
 * Who may make a call (design §2): authorization is per call.
 */
export type Access = "anyone" | "device" | "session" | "either" | "ability";

export type Action = "answer.affirm" | "answer.deny";

/**
 * `look.add`: a folder the person keeps projects in, or an agent's
 * history (`agent`), as a look; read at once unless `on` is false
 * (the person said "Not now"). The reply names the look, an older one
 * when that folder or agent has one already, which is then switched as
 * `on` says.
 */
export type AddLook = { id: LookId, folder?: string | null, agent?: string | null, on?: boolean | null, };

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
 * One agent as found on this computer, and what its runs can do: a row of
 * the in-memory `agents` collection, and of the reply of `agents.detect`.
 */
export type AgentHealth = {
/**
 * Its id, as a capture and `tasktap hook` name it.
 */
id: string,
/**
 * Its name, as every sentence about it says it.
 */
name: string,
/**
 * It runs on this system. One that does not yet is listed, and runs nothing.
 */
supported: boolean,
/**
 * The revision of the change that last put the row.
 */
rev: Rev,
/**
 * When its commands last said what follows; zero while they never have.
 */
checked: Time,
/**
 * The person added it (the `own_agents` preference): it can be changed
 * and removed.
 */
own: boolean,
/**
 * What a person should know of it that nothing else here says.
 */
note: string | null,
/**
 * Its own commands say whether it is signed in. One whose do not is
 * never shown as signed in or out: `signed_in` stays none.
 */
checks: boolean,
/**
 * What the person can let it do beyond its default (the
 * `agent_options` preference).
 */
options: Array<AgentOption>,
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
 * What follows is what its commands said at `checked` and not since:
 * this core has not run them yet and a core before it kept their answer,
 * or they could not say this time whether it is signed in.
 */
stale: boolean,
/**
 * Its tool said, asked to place a thought, that the person's plan or
 * key has reached its usage limit: it is not asked again before this
 * time (design §8). Kept for the next core.
 */
limited: Time | null,
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
 * Something an agent does only when the person lets it: a switch in its
 * row, off until they turn it on.
 */
export type AgentOption = {
/**
 * Its name in the `agent_options` preference, after the agent's id and a dot.
 */
id: string,
/**
 * The switch's name.
 */
name: string,
/**
 * What turning it on allows, as a sentence for the person.
 */
allows: string, };

/**
 * The reply of `agents.detect`: the rows of the agents asked about, as
 * they are now, in the order the core lists its agents.
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
export type Assign = { id: ThoughtId,
/**
 * A workspace; or, in its place, `card_id`: a project Tasktap knows
 * that is not open, which opens when the thought starts there.
 */
project_id?: ProjectId, card_id?: CardId, };

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
export type Candidate = { label: string, to: Place,
/**
 * Why it is a choice, in a few words; empty when nothing says.
 */
why: string, };

/**
 * `thought.capture`. A project or session given here is the person's own
 * pick, which routes the thought without asking the router.
 */
export type Capture = { id: ThoughtId, text: string, strokes: Array<Array<[number, number]>>, source: Source, mode?: Mode | null, project_id?: ProjectId | null,
/**
 * A project Tasktap knows that is not open, picked by the person: it
 * opens when the thought starts there, not before.
 */
card_id?: CardId | null, session_id?: SessionId | null,
/**
 * The agent a new run of the thought uses, by the id `agents.detect`
 * lists; without one, the `agent` preference, else the first agent
 * this core has. The agent named runs the thought or nobody does: one
 * its row of the `agents` collection says is not installed, or not
 * signed in, is refused as `failed` with that for a message, and one
 * no build has as `invalid`. A follow-up uses its session's agent,
 * whatever is named here.
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
 * What Tasktap knows of one folder that is, or holds a copy of, a
 * project (docs/projects-design.md): not a workspace, and no right to
 * read, show or open anything in it. A card becomes a workspace, a
 * `projects` row, when a thought starts there or the person opens it.
 */
export type Card = { id: CardId, rev: Rev,
/**
 * Canonical and unique among cards.
 */
folder: string,
/**
 * What it is called: the folder's name.
 */
name: string,
/**
 * Other names it goes by: the one its package file gives, when that
 * differs, and those the person gave it.
 */
names: Array<string>,
/**
 * Of `names`, those the person gave it: kept whatever a look finds.
 */
given: Array<string>,
/**
 * Names a look found that the person took away: not given it again.
 */
dropped: Array<string>,
/**
 * One line about it, from its README or its package file; empty when none says.
 */
about: string,
/**
 * The file the line is from.
 */
about_from: string | null,
/**
 * Why Tasktap takes it for a project, strongest first.
 */
why: Array<Evidence>,
/**
 * The agents whose history names it, by id.
 */
agents: Array<string>,
/**
 * Which repository it is: `remote <host/path>` for one with a remote,
 * `root <commit>` by its first commit for one without; none for a
 * folder without Git. Copies of one repository share it.
 */
repo: string | null,
/**
 * The repository's first commit (`root <commit>`), for one with Git
 * whether or not it has a remote: a clone of a folder on this machine
 * has no remote of its own, and is a copy of the repository it was
 * made from by this.
 */
root: string | null,
/**
 * Another copy of the repository of that card, which is the project:
 * shown under it, never as a project of its own.
 */
copy_of: CardId | null,
/**
 * A folder inside that card's project where an agent was started.
 */
inside: CardId | null,
/**
 * The workspace of this folder, once it is one.
 */
project_id: ProjectId | null,
/**
 * When work last happened in it as far as Tasktap knows: an agent's
 * history, or a thought of Tasktap's.
 */
used: Time | null,
/**
 * The looks that found it the last time each was read.
 */
looks: Array<LookId>,
/**
 * The person said it is not a project: never offered, never placed
 * into, and kept so that a look does not bring it back.
 */
hidden: boolean,
/**
 * The person chose this copy as the project.
 */
main: boolean,
/**
 * Its folder was there the last time Tasktap looked.
 */
available: boolean,
/**
 * Where its agent works (design §7, "Isolation"), as the person chose
 * it in Settings: its workspace takes it when it is made, and follows
 * it whenever it is changed (`put cards`).
 */
isolate: Isolate, };

/**
 * A UUID v7 in text, minted by whoever creates the record.
 * What Tasktap knows of one folder that is, or holds a copy of, a project.
 */
export type CardId = string;

/**
 * What the person corrects of a card; a missing field is left as it is.
 */
export type CardPatch = {
/**
 * The names the person gives it, beside its own.
 */
names?: Array<string> | null,
/**
 * Not a project: never offered, never placed into.
 */
hidden?: boolean | null,
/**
 * This copy is the project, not another of its copies.
 */
main?: boolean | null,
/**
 * Where its agent works: kept on the card, and given to its workspace
 * too, now or when it is made.
 */
isolate?: Isolate | null, };

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

/**
 * One file of a worktree's changes. A binary file counts no lines.
 */
export type ChangedFile = { path: string, change: FileChange, insertions: number | null, deletions: number | null, };

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

export type Collection = "thoughts" | "projects" | "sessions" | "terminals" | "questions" | "results" | "layouts" | "prefs" | "devices" | "previews" | "looks" | "cards" | "glance" | "agents" | "dictations";

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
 * `delete`: removes plain data, a preview, and a terminal that is not
 * running with its history and its previews, the only way history is
 * removed by hand; one a session refers to is `conflict`. Deleting a
 * preference restores its default.
 */
export type Delete = { "c": "prefs", id: PrefKey, } | { "c": "layouts", id: ProjectId, } | { "c": "thoughts", id: ThoughtId, } | { "c": "terminals", id: TerminalId, } | { "c": "previews", id: PreviewId, } | { "c": "cards", id: CardId, } | { "c": "looks", id: LookId, };

/**
 * `agents.detect`: whether each agent this core can run is installed on the
 * PATH its terminals get and signed in, as the agent itself says. Without
 * `agents`, every one. Each check runs the agent's own commands, each at
 * most 4 s. A core runs them only here and the first time in its life that
 * a thought is given to the agent, never as it starts: a client calls this
 * when the person looks at their agents, picks one, or asks to check again.
 * With `unchecked`, only the agents whose commands this core has not run
 * yet are checked, so the call may be made each time the person looks.
 */
export type DetectAgents = { agents?: Array<string> | null, unchecked: boolean, };

export type Device = { id: DeviceId, rev: Rev, name: string, last_seen: Time | null, revoked: boolean, };

/**
 * A UUID v7 in text, minted by whoever creates the record.
 */
export type DeviceId = string;

/**
 * A dictation that is under way or has ended without becoming a thought
 * (design §8): its words are there to be placed in a field, or it failed.
 * Memory only: one that became its thought has no row.
 */
export type Dictation = { id: DictationId, rev: Rev, phase: DictationPhase,
/**
 * What was heard: the transcript so far while a recorder that
 * transcribes reports it, and the whole of it once it is `heard`, or
 * when it could not be captured.
 */
text: string,
/**
 * How loud the microphone is, 0 to 100, while recording.
 */
level: number, target: DictationTarget,
/**
 * Why it failed, in words the interface shows as they are.
 */
error: string | null, };

/**
 * A UUID v7 in text, minted by whoever creates the record.
 */
export type DictationId = string;

/**
 * `heard`: the words are in `text`, and the core does nothing with
 * them; the interface places them in its field.
 */
export type DictationPhase = "recording" | "transcribing" | "heard" | "failed";

/**
 * What a dictation becomes.
 */
export type DictationTarget = { "kind": "thought" } & Capture | { "kind": "text" };

/**
 * The reply of `thought.changes`: the files, and the stream of the diff
 * as `git diff` prints it, which ends once all of it is sent.
 */
export type Diff = { stream: Opened,
/**
 * The files changed, by path, as many as fit a reply.
 */
files: Array<ChangedFile>,
/**
 * Files changed that `files` leaves out.
 */
more: number,
/**
 * Bytes of the diff. The stream carries at most [`MAX_DIFF`] of them.
 */
size: number,
/**
 * The stream ends before the diff does.
 */
cut: boolean, };

/**
 * Arguments of a call that takes none: `{}`.
 */
export type Empty = Record<string, never>;

/**
 * How a file of text is encoded, in the words a page's `TextDecoder`
 * takes. UTF-16 only where the file says so with its first bytes.
 */
export type Encoding = "utf-8" | "utf-16le" | "utf-16be";

/**
 * The one error shape of every failed call.
 */
export type Error = { code: Code, message: string, };

/**
 * Why a folder is taken for a project, strongest first.
 */
export type Evidence = "opened" | "agent" | "git" | "package" | "signs";

/**
 * `type`: a file became a link, or the reverse.
 */
export type FileChange = "added" | "modified" | "deleted" | "type";

/**
 * What a file is, by its first bytes and then by its name
 * (`file.read`): the formats a web view draws, text, and everything
 * else, which no preview shows.
 */
export type FileKind = "text" | "markdown" | "html" | "svg" | "png" | "jpeg" | "gif" | "webp" | "pdf" | "other";

/**
 * The reply of `file.read`.
 */
export type FileRead = {
/**
 * The file's bytes from its first, which ends once all of them are
 * sent, or at the cut. None when there is nothing to send: the file
 * still has the stamp `unless` named, or it is of the kind `other`.
 */
stream: Opened | null,
/**
 * Bytes in the file.
 */
size: number, kind: FileKind,
/**
 * For text of every kind (text, markdown, html, svg): how to decode it.
 */
encoding: Encoding | null,
/**
 * The stream ends before the file does: text of more than
 * [`MAX_FILE_TEXT`] bytes is cut there, between two characters.
 */
cut: boolean,
/**
 * Changes whenever the file does: its size and when it was last
 * written. To be handed back as `unless`.
 */
stamp: string, };

/**
 * `projects.find`: the projects a text names or points at, the likeliest
 * first: by name as written, as speech writes it, and by the line about
 * each. With no text, the most recently used.
 */
export type Find = { text: string,
/**
 * At most 8; 3 without.
 */
limit?: number | null,
/**
 * `text` is a whole thought: the places its own words name or
 * describe. Otherwise it is typed into a field to find a project: the
 * projects whose names it matches.
 */
thought: boolean, };

export type Finds = { found: Array<Found>, };

/**
 * What `dictation.finish` may turn a dictation into: only the words.
 */
export type FinishAs = "text";

/**
 * `dictation.finish`: the recording is over. With `as: "text"` a
 * dictation started for a new thought ends as words only, as one started
 * with the `text` target does: the person let go and wants to read or
 * edit before sending, so nothing is captured and the words are in its
 * row once it is `heard`. It counts until the thought is captured: also
 * in a second finish while the words are still on their way.
 */
export type FinishDictation = { id: DictationId, as?: FinishAs | null, };

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
 * One project `projects.find` found.
 */
export type Found = {
/**
 * A workspace, or a project Tasktap knows that is not open.
 */
to: Place, name: string,
/**
 * Its folder as a person reads it: `~/work/cuegrid`.
 */
folder: string,
/**
 * Why it is found, in a few words.
 */
why: string, };

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
 * A question opened. `title` and `body` are the words a system
 * notification says; `session` is the session whose terminal shows the
 * question (a click brings the window there), none for the router's
 * question, which Home shows.
 */
export type HostNotify = { question: QuestionId, title: string, body: string, session: SessionId | null, };

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
 * The reply to `dictation.start`.
 */
export type Listening = {
/**
 * Where the samples go, 16 kHz, one channel, signed 16-bit
 * little-endian, when the core transcribes; none: the caller
 * transcribes and reports with `dictation.report`.
 */
stream: Opened | null,
/**
 * The longest a recording lasts.
 */
seconds: number, };

/**
 * One place Tasktap looks for projects (docs/projects-design.md): an
 * agent's history, or a folder the person keeps projects in.
 */
export type Look = { id: LookId, rev: Rev, kind: LookKind,
/**
 * Of an agent's history: the agent, by its id.
 */
agent: string | null,
/**
 * Of a folder to look in: the folder, canonical.
 */
folder: string | null,
/**
 * Read when Tasktap looks. The person switches it; an agent's history
 * is off until they turn it on.
 */
on: boolean, state: LookState,
/**
 * The projects it found the last time it was read.
 */
found: number,
/**
 * When it was last read.
 */
looked: Time | null,
/**
 * What stopped it, in words, when it read nothing.
 */
note: string | null,
/**
 * What it reads as it was when it was last read: the modified times
 * of its folders, as one value. When they are the same, nothing new
 * is there to find and it is not read again.
 */
stamp: string | null, };

/**
 * A UUID v7 in text, minted by whoever creates the record.
 * One place Tasktap learns of projects from: an agent's history, or a folder to look in.
 */
export type LookId = string;

/**
 * What a look reads. Another kind (an account on a code host) is one
 * more word here and one more row of the core's table of kinds.
 */
export type LookKind = "agent" | "folder";

/**
 * What the person changes of a look.
 */
export type LookPatch = { on?: boolean | null, };

export type LookState = "new" | "ready" | "gone" | "many" | "failed";

/**
 * `projects.look`: every look that is on, read again; what it found is
 * in the `looks` and `cards` records.
 */
export type Looked = {
/**
 * The projects Tasktap knows now, copies not counted.
 */
projects: number,
/**
 * Milliseconds the looking took.
 */
ms: number, };

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

export type MotionAmbient = "off" | "still" | "breathing";

export type MotionPalette = "chrome" | "chromatic" | "warm" | "cool" | "custom";

export type MotionStyle = "slats" | "glyphs" | "resonator";

/**
 * The editable fields of a note; a missing one is left as it is.
 */
export type NotePatch = { text?: string | null, strokes?: Array<Array<[number, number]>> | null, };

/**
 * `projects.offer`: what Tasktap can look at, found by `stat` alone,
 * with nothing inside read: the agents whose history is on this machine
 * and the folders a person may keep projects in.
 */
export type Offer = { agents: Array<OfferedAgent>, places: Array<OfferedPlace>, };

export type OfferedAgent = {
/**
 * By the id `agents.detect` lists.
 */
agent: string, name: string, };

export type OfferedPlace = {
/**
 * Canonical.
 */
folder: string,
/**
 * The projects Tasktap knows directly in it: a folder derived from
 * them has some; one of the usual names (`~/projects`) may have none.
 */
projects: number, };

/**
 * A byte position in a stream since it opened.
 */
export type Offset = number;

/**
 * `preview.open`: shows a file, or a web address of this machine, beside
 * a terminal. The same target beside the same terminal again is the
 * preview it already has.
 */
export type OpenPreview = {
/**
 * The terminal it is shown beside. A device names it; an agent's is
 * the terminal of its token, and it may name no other.
 */
terminal?: TerminalId | null,
/**
 * A path, whole, from `cwd` or from the home folder with `~/`; or a
 * web address.
 */
target: string,
/**
 * The folder a path that is not whole is taken from; without it, the
 * folder the terminal started in.
 */
cwd?: string | null, };

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
 * terminal: the last caller wins. Input is accepted while the process runs,
 * from at most `MAX_TERMINAL_CLIENTS` clients attached at once: one more
 * open of a running terminal is `conflict` until one closes its stream.
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
 * An agent the person added (design §7): any program that takes what it is
 * told as an argument, does the work and exits. Tasktap hears nothing of
 * it but its end.
 */
export type OwnAgent = {
/**
 * `own-` and 1 to 16 lower-case letters and digits, made where it is
 * added and never changed: thoughts and sessions keep it.
 */
id: string,
/**
 * As the person calls it, 1 to 40 characters.
 */
name: string,
/**
 * Its command line: the program, then its arguments, apart by spaces,
 * with quotes around one that has spaces; `{prompt}` in an argument
 * is what the run is told. No shell reads it.
 */
command: string,
/**
 * The person removed it: it runs nothing and is not listed, and is
 * kept so that what it ran still says who ran it, and so that it can
 * be added back as it was.
 */
removed?: boolean, };

/**
 * What placing a thought with an agent costs the person (design §8):
 * nothing more than they pay already, as a subscription's small model
 * is included in it (`plan`), or what their provider bills for each
 * use, as with a key, or where Tasktap cannot know (`billed`).
 */
export type Pays = "plan" | "billed";

/**
 * Written only by the state machine.
 */
export type Phase = "captured" | "routed" | "working" | "done" | "failed";

/**
 * Where a thought goes: a new run in a project, or a follow-up to a session.
 */
export type Place = { "project": ProjectId } | { "session": SessionId } | { "card": CardId };

/**
 * An agent that can place thoughts, as `route.terms` lists it.
 */
export type PlaceTool = {
/**
 * The agent, by the id `agents.detect` lists.
 */
agent: string,
/**
 * The model its tool is asked for.
 */
model: string,
/**
 * What a placing costs the person, as far as Tasktap can tell.
 */
pays: Pays,
/**
 * About how long it takes to place a spoken thought, in milliseconds,
 * as measured; none where it was not.
 */
ms: number | null, };

/**
 * How a thought's place came about (design §5): who decided where it
 * goes, or that it waits for later. The last decision counts: a
 * thought kept for later that the person then sends somewhere is
 * `picked`.
 */
export type Placed = "picked" | "name" | "model" | "follow_up" | "answer" | "kept" | "kept_answer" | "kept_name" | "kept_model";

/**
 * One agent of an agreement to place thoughts.
 */
export type Placer = {
/**
 * The agent, by the id `agents.detect` lists.
 */
agent: string,
/**
 * The model its tool is asked for, as `route.terms` names it: the
 * agreement covers that model alone.
 */
model: string,
/**
 * The person lets it place thoughts.
 */
on: boolean, };

/**
 * A preference row: `{id, value, rev}`, where the key fixes the value's type.
 */
export type Pref = { rev: Rev, } & ({ "id": "hold", "value": number } | { "id": "agent", "value": string | null } | { "id": "route_by", "value": RouteBy | null } | { "id": "motion_style", "value": MotionStyle } | { "id": "motion_palette", "value": MotionPalette } | { "id": "motion_hue", "value": number } | { "id": "motion_lumen", "value": boolean } | { "id": "motion_ambient", "value": MotionAmbient } | { "id": "terminal_font", "value": string } | { "id": "terminal_size", "value": number } | { "id": "terminal_line_height", "value": number } | { "id": "speech_by", "value": SpeechBy | null } | { "id": "speech_languages", "value": Array<string> } | { "id": "keys", "value": Array<string> } | { "id": "return_sends", "value": boolean } | { "id": "capture_key", "value": Shortcut | null } | { "id": "talk_key", "value": Shortcut | null } | { "id": "question_key", "value": Shortcut | null } | { "id": "yes_key", "value": Shortcut | null } | { "id": "no_key", "value": Shortcut | null } | { "id": "keep_days", "value": number } | { "id": "terminal_bold_bright", "value": boolean } | { "id": "terminal_contrast", "value": boolean } | { "id": "text_size", "value": TextSize } | { "id": "agent_options", "value": Array<string> } | { "id": "own_agents", "value": Array<OwnAgent> } | { "id": "setup_hidden", "value": boolean } | { "id": "update_checks", "value": boolean });

export type PrefKey = "hold" | "agent" | "route_by" | "motion_style" | "motion_palette" | "motion_hue" | "motion_lumen" | "motion_ambient" | "terminal_font" | "terminal_size" | "terminal_line_height" | "speech_by" | "speech_languages" | "keys" | "return_sends" | "capture_key" | "talk_key" | "keep_days" | "terminal_bold_bright" | "terminal_contrast" | "text_size" | "agent_options" | "own_agents" | "setup_hidden" | "update_checks" | "question_key" | "yes_key" | "no_key";

/**
 * A preference write: `{id, patch}`, where the key fixes the value's type.
 */
export type PrefPatch = { "id": "hold", "patch": number } | { "id": "agent", "patch": string | null } | { "id": "route_by", "patch": RouteBy | null } | { "id": "motion_style", "patch": MotionStyle } | { "id": "motion_palette", "patch": MotionPalette } | { "id": "motion_hue", "patch": number } | { "id": "motion_lumen", "patch": boolean } | { "id": "motion_ambient", "patch": MotionAmbient } | { "id": "terminal_font", "patch": string } | { "id": "terminal_size", "patch": number } | { "id": "terminal_line_height", "patch": number } | { "id": "speech_by", "patch": SpeechBy | null } | { "id": "speech_languages", "patch": Array<string> } | { "id": "return_sends", "patch": boolean } | { "id": "capture_key", "patch": Shortcut | null } | { "id": "talk_key", "patch": Shortcut | null } | { "id": "question_key", "patch": Shortcut | null } | { "id": "yes_key", "patch": Shortcut | null } | { "id": "no_key", "patch": Shortcut | null } | { "id": "keep_days", "patch": number } | { "id": "terminal_bold_bright", "patch": boolean } | { "id": "terminal_contrast", "patch": boolean } | { "id": "text_size", "patch": TextSize } | { "id": "agent_options", "patch": Array<string> } | { "id": "own_agents", "patch": Array<OwnAgent> } | { "id": "setup_hidden", "patch": boolean } | { "id": "update_checks", "patch": boolean };

/**
 * Something shown beside a terminal (design §9, "Previews"): a file, or a
 * web address of this machine. `preview.open` writes it, under the rules
 * of what may be shown, and `delete` closes it; it goes with its
 * terminal's record. Where it stands is the layout's.
 */
export type Preview = { id: PreviewId, rev: Rev,
/**
 * The terminal it is shown beside, a session's or a shell's.
 */
terminal_id: TerminalId, kind: PreviewKind,
/**
 * A file's whole path with every link followed, as `file.read` takes
 * it; or the web address, as it was given.
 */
target: string,
/**
 * The file's name, or the address's host and port.
 */
title: string,
/**
 * Who opened it: the person at a device, or the agent in the
 * terminal with `tasktap preview`.
 */
by: PreviewBy, };

export type PreviewBy = "person" | "agent";

/**
 * A UUID v7 in text, minted by whoever creates the record.
 */
export type PreviewId = string;

export type PreviewKind = "file" | "web";

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
if_rev?: Rev | null, } & ({ "c": "prefs" } & PrefPatch | { "c": "layouts", id: ProjectId, patch: LayoutPatch, } | { "c": "projects", id: ProjectId, patch: ProjectPatch, } | { "c": "cards", id: CardId, patch: CardPatch, } | { "c": "looks", id: LookId, patch: LookPatch, } | { "c": "thoughts", id: ThoughtId, patch: NotePatch, });

/**
 * Everything except `state` and `answer` is written once.
 */
export type Question = { id: QuestionId, rev: Rev, thought_id: ThoughtId | null, session_id: SessionId | null, turn: number | null, source: QuestionSource,
/**
 * Of a router's question (`source: router`): where each of its
 * `choices` sends the thought, in their order, a folder or a session
 * by its id. None for every other question, and in a row older than
 * the field.
 */
places: Array<Place> | null,
/**
 * Of a router's question: why each of its `choices` is there, in a
 * few words ("named in it", "invoices, export"), or empty. None for
 * every other question, and in a row older than the field.
 */
notes: Array<string> | null, prompt: string, detail: string | null, reply_via: ReplyVia, state: QuestionState, answer: Answer | null, } & ({ "kind": "confirm" } | { "kind": "choice", choices: Array<string>, } | { "kind": "text" });

/**
 * A UUID v7 in text, minted by whoever creates the record.
 */
export type QuestionId = string;

export type QuestionSource = "agent" | "permission" | "router";

export type QuestionState = "open" | "answered" | "withdrawn";

/**
 * `thought.changes`: the changes of a thought's worktree against the
 * commit it started from, committed on its branch or not. The reply lists
 * the files; the stream carries the diff, the whole or one file's.
 */
export type ReadChanges = { id: ThoughtId,
/**
 * What the caller grants the core on the stream at once.
 */
credit: number,
/**
 * One file's diff instead of the whole: a path the list names.
 */
path?: string | null, };

/**
 * `file.read`: the bytes of a file inside a folder the person opened in
 * Tasktap, or inside a copy Tasktap made of one, as a stream.
 */
export type ReadFile = {
/**
 * The file's whole path. Links on the way to it are followed before
 * the rule is applied.
 */
path: string,
/**
 * What the caller grants the core on the stream at once.
 */
credit: number,
/**
 * The `stamp` of an earlier reply: when the file still has it, nothing
 * is read and the reply has no stream. How a preview asks whether its
 * file changed.
 */
unless?: string | null, };

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
 * `dictation.report`, from a recorder that transcribes: while recording,
 * the transcript so far and the level; once finished, the transcript.
 */
export type ReportDictation = { id: DictationId, text?: string | null,
/**
 * 0 to 100.
 */
level?: number | null, };

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
export type Route = { "confidence": "clear", to: Place, brief: string, said: string | null, } | { "confidence": "ambiguous", prompt: string, candidates: Array<Candidate>, } | { "confidence": "unknown" };

/**
 * What the `route_by` preference holds (design §8): the person's one
 * agreement that Tasktap may place thoughts with their own agents, and
 * which of them, in the order they are asked. A consent to one agent that
 * a core before this one kept reads as a list of that agent alone (the
 * store's fourth migration).
 */
export type RouteBy = {
/**
 * The agents, the first asked first, each once. One switched off is
 * never asked.
 */
agents: Array<Placer>,
/**
 * The version of what is sent that the person saw, as `route.terms`
 * names it. An agreement to another version than the core's covers
 * nothing.
 */
terms: number, };

/**
 * `route.terms`: what placing by a model sends and to whom (design §8),
 * for the person to read before they agree with the `route_by`
 * preference.
 */
export type RouteTerms = {
/**
 * The instructions the model gets with every thought, in full.
 */
instructions: string,
/**
 * What is sent with them, one line for each kind of field.
 */
sends: Array<string>,
/**
 * The version of these terms, which an agreement names: one to an
 * older version covers nothing.
 */
terms: number,
/**
 * The agents whose tool can be asked, in the order Tasktap proposes:
 * those that cost the person nothing more first, then the fastest.
 */
tools: Array<PlaceTool>, };

/**
 * How a thought found its destination and its brief (design §8).
 */
export type Routing = {
/**
 * Who was asked: an agent's id for the model behind its tool, or
 * `local` for the match on names.
 */
by: string,
/**
 * The model asked, when one was.
 */
model: string | null,
/**
 * Still being asked: the thought does not launch before the answer
 * or the end of its time limit.
 */
pending: boolean,
/**
 * Why the model was not asked or its answer not used, and the match
 * on names, or the person's words as they are, were.
 */
fallback: string | null,
/**
 * The person's words that justify a follow-up to a session.
 */
quote: string | null,
/**
 * A few words a model gave the work for a name: the name of the
 * session a new run of the thought starts.
 */
title: string | null,
/**
 * Why the match on names started it where it did when no name was
 * said for certain, in a few words: what only that project has
 * ("its name and “widgetpack”").
 */
lead: string | null,
/**
 * Milliseconds the answer took.
 */
ms: number | null, };

/**
 * Rows put whole, and ids of rows that stopped being live.
 */
export type Rows<R, I> = { put?: Array<R>, del?: Array<I>, };

/**
 * `idle`: a shell with nothing running in it, waiting for a command;
 * `running`: a program, a job or an agent's session (`what`); `ended`:
 * its program exited; `unknown`: the system does not say.
 */
export type RunState = "idle" | "running" | "ended" | "unknown";

/**
 * `terminal.runs`: what runs in a terminal, as the core sees it when asked,
 * which is when the person closes it; nothing watches it meanwhile.
 */
export type Runs = { state: RunState,
/**
 * What runs, by name, what has the terminal's foreground first: an
 * agent's live session by its agent's name, a program by its command
 * line, a job left in the background by its own.
 */
what: Array<string>,
/**
 * The live session of an agent in it, idle or not.
 */
session: SessionId | null, };

/**
 * 32 random bytes as 64 hex digits: a device key or a session token.
 */
export type Secret = string;

/**
 * `key.remove`: the server whose key goes.
 */
export type Server = { server: string, };

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
export type Set = { "c": "thoughts" } & Rows<Thought, ThoughtId> | { "c": "projects" } & Rows<Project, ProjectId> | { "c": "sessions" } & Rows<Session, SessionId> | { "c": "terminals" } & Rows<Terminal, TerminalId> | { "c": "questions" } & Rows<Question, QuestionId> | { "c": "results" } & Rows<TurnResult, ResultId> | { "c": "layouts" } & Rows<Layout, ProjectId> | { "c": "prefs" } & Rows<Pref, PrefKey> | { "c": "devices" } & Rows<Device, DeviceId> | { "c": "previews" } & Rows<Preview, PreviewId> | { "c": "looks" } & Rows<Look, LookId> | { "c": "cards" } & Rows<Card, CardId> | { "c": "glance", put: Array<Glance>, } | { "c": "agents" } & Rows<AgentHealth, string> | { "c": "dictations" } & Rows<Dictation, DictationId>;

/**
 * `key.set`: stores the key of a server in the system's credential
 * store. No call returns a key.
 */
export type SetKey = { server: string, key: string, };

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
 * A key combination in a portable form: the modifiers held, and the key
 * by its place on the keyboard, the `code` of a keyboard event in a page
 * (`Space`, `KeyJ`, `F5`). Never a display string: each side writes it
 * out in its system's own words.
 */
export type Shortcut = { control: boolean,
/**
 * Option on a Mac.
 */
alt: boolean, shift: boolean,
/**
 * Command on a Mac, the Windows key elsewhere.
 */
meta: boolean, code: string, };

/**
 * A terminal size: `[cols, rows]`.
 */
export type Size = [number, number];

export type Source = "typed" | "voice" | "terminal";

/**
 * What the `speech_by` preference names: a server that speaks the
 * OpenAI transcription endpoint, and the model it is asked for.
 */
export type SpeechBy = {
/**
 * Where `/v1/audio/transcriptions` is added: `https://api.openai.com`.
 */
server: string, model: string, };

/**
 * `speech.terms`: what a speech service is sent (design §8), for the
 * person to read before they consent with the `speech_by` preference.
 */
export type SpeechTerms = {
/**
 * What is sent, one line for each thing.
 */
sent: Array<string>,
/**
 * What is added to the server's address: where it is sent.
 */
path: string,
/**
 * The longest recording, which is the most that is sent at once.
 */
seconds: number, };

/**
 * `thought.start`. The attempt is committed before anything is spawned, so
 * repeating this call never launches twice.
 */
export type Start = { id: ThoughtId, attempt: AttemptId, };

/**
 * `dictation.start` (design §8): the caller records, and is the only one
 * that may finish the dictation.
 */
export type StartDictation = { id: DictationId, target: DictationTarget,
/**
 * The caller can transcribe by itself when no speech service is set up.
 */
local: boolean, };

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

export type TextSize = "small" | "default" | "large";

/**
 * The primary record. A note is a thought with mode `note`.
 */
export type Thought = { id: ThoughtId, rev: Rev, text: string, strokes: Array<Array<[number, number]>>, source: Source, mode: Mode, phase: Phase, status: Status, reason: Reason | null, live: boolean, project_id: ProjectId | null,
/**
 * The project Tasktap knows and the person has not opened that the
 * thought goes to: it becomes a workspace, its `project_id`, when the
 * thought starts there, and stays named here, so what is said of the
 * thought can say it is new there. None in a row older than the field.
 */
card_id: CardId | null, session_id: SessionId | null, brief: string | null,
/**
 * How it found its destination and its brief; none when no router was
 * asked: a note, or a pick whose words go on as they are.
 */
route: Routing | null,
/**
 * How its place came about, written when it is placed or kept for
 * later; none until then, and in a row older than the field.
 */
placed: Placed | null, agent: string | null, model: string | null, workdir: Workdir | null, hold_until: Time | null, read: boolean, created: Time, updated: Time, };

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
 * The worktree a thought runs in when its project isolates (design §7,
 * "Isolation"). It belongs to this thought alone; follow-ups to its
 * sessions work in it too.
 */
export type Workdir = {
/**
 * `<data>/worktrees/<name>`, canonical.
 */
path: string,
/**
 * `tasktap/<name>`, made for this worktree from `base`.
 */
branch: string,
/**
 * The branch Keep brings the changes into, recorded at creation: the
 * one the project folder was on. None when it was on no branch (a
 * detached HEAD); Keep then refuses and the branch is the person's to merge.
 */
destination: string | null,
/**
 * The commit the worktree started from: the project folder's HEAD then.
 */
base: string,
/**
 * The project folder had uncommitted changes of its own when the
 * worktree was made. The run started from `base` without them, and
 * they stay where they are.
 */
left_out: boolean, changes: Changes,
/**
 * The changes against `base`, committed on the branch or not, as the
 * last look found them: files changed, lines added, lines removed.
 */
files: number, insertions: number, deletions: number, };

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
  "thought.changes": { args: ReadChanges; result: Diff; access: "device" };
  "question.ask": { args: Ask; result: Answer; access: "session" };
  "question.answer": { args: AnswerQuestion; result: null; access: "device" };
  "question.withdraw": { args: AskKey; result: null; access: "session" };
  "question.received": { args: AskKey; result: null; access: "session" };
  "question.focus": { args: Ref<QuestionId>; result: null; access: "device" };
  "session.event": { args: SessionEvent; result: null; access: "session" };
  "session.adopt": { args: Adopt; result: SessionId; access: "session" };
  "route.hint": { args: Hint; result: Route; access: "device" };
  "route.terms": { args: Empty; result: RouteTerms; access: "device" };
  "agents.detect": { args: DetectAgents; result: Agents; access: "device" };
  "terminal.open": { args: OpenTerminal; result: Opened; access: "device" };
  "terminal.resize": { args: ResizeTerminal; result: null; access: "device" };
  "terminal.stop": { args: Ref<TerminalId>; result: null; access: "device" };
  "terminal.runs": { args: Ref<TerminalId>; result: Runs; access: "device" };
  "project.add": { args: AddProject; result: ProjectId; access: "device" };
  "project.scan": { args: Empty; result: null; access: "device" };
  "project.close": { args: CloseProject; result: null; access: "device" };
  "look.add": { args: AddLook; result: LookId; access: "device" };
  "projects.offer": { args: Empty; result: Offer; access: "device" };
  "projects.look": { args: Empty; result: Looked; access: "device" };
  "projects.find": { args: Find; result: Finds; access: "device" };
  "file.read": { args: ReadFile; result: FileRead; access: "device" };
  "preview.open": { args: OpenPreview; result: PreviewId; access: "either" };
  "input": { args: Input; result: null; access: "device" };
  "dictation.start": { args: StartDictation; result: Listening; access: "device" };
  "dictation.report": { args: ReportDictation; result: null; access: "device" };
  "dictation.finish": { args: FinishDictation; result: null; access: "device" };
  "dictation.cancel": { args: Ref<DictationId>; result: null; access: "device" };
  "speech.terms": { args: Empty; result: SpeechTerms; access: "device" };
  "key.set": { args: SetKey; result: null; access: "device" };
  "key.remove": { args: Server; result: null; access: "device" };
  "device.revoke": { args: Ref<DeviceId>; result: null; access: "device" };
  "core.status": { args: Empty; result: CoreStatus; access: "anyone" };
  "core.retire": { args: Retire; result: null; access: "device" };
  "shim.hold": { args: ShimHold; result: null; access: "ability" };
  "host.notify": { args: HostNotify; result: null; access: "ability" };
  "fixture.stream": { args: FixtureStream; result: Opened; access: "device" };
  "fixture.script": { args: FixtureScript; result: FixtureLog; access: "device" };
  "fixture.clock": { args: FixtureClock; result: null; access: "device" };
  "fixture.records": { args: FixtureRecords; result: Revision; access: "device" };
};
