//! Arguments and results of the Phase 1 calls that are not records themselves.
//!
//! An optional argument may be left out or sent as `null`.

use crate::ids::{
    AttemptId, Invalid, Offset, ProjectId, QuestionId, Rev, Secret, SessionId, TerminalId,
    ThoughtId, Time,
};
use crate::records::{
    Collection, Isolate, Mode, PrefKey, PrefValue, Question, QuestionKind, QuestionSource,
    Response, Set, Source, Stroke, Thought, TurnResult,
};
use crate::{MAX_LINE, MAX_TEXT};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// Arguments of a call that takes none: `{}`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Empty {}

/// Arguments that name one record.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Ref<I> {
    pub id: I,
}

/// `sub`: a second one replaces the first; an empty list ends it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Subscribe {
    pub collections: Vec<Collection>,
}

/// The revision a snapshot was taken at, or a write committed at.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Revision {
    pub rev: Rev,
}

/// `put`: writes plain data. Fields the state machine owns cannot be named
/// here: a patch with a field it does not have is `invalid`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields = nullable))]
pub struct Put {
    #[serde(flatten)]
    pub target: PutTarget,
    /// Refused with `conflict` unless the row is still at this revision.
    pub if_rev: Option<Rev>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "c", rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum PutTarget {
    Prefs(PrefPatch),
    Layouts {
        id: ProjectId,
        patch: LayoutPatch,
    },
    Projects {
        id: ProjectId,
        patch: ProjectPatch,
    },
    /// The text of a thought that is captured and never started: a note,
    /// an idea, or one undone before its launch; the core refuses any other.
    Thoughts {
        id: ThoughtId,
        patch: NotePatch,
    },
}

/// A preference write: `{id, patch}`, where the key fixes the value's type.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "id", content = "patch", rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum PrefPatch {
    Hold(u32),
    Agent(#[serde(deserialize_with = "crate::within::<MAX_LINE, _, _>")] Option<String>),
}

impl From<PrefPatch> for PrefValue {
    fn from(patch: PrefPatch) -> Self {
        match patch {
            PrefPatch::Hold(seconds) => PrefValue::Hold(seconds),
            PrefPatch::Agent(agent) => PrefValue::Agent(agent),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct LayoutPatch {
    #[cfg_attr(test, ts(type = "unknown"))]
    pub tree: Value,
}

/// The editable fields of a project; a missing one is left as it is.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields = nullable))]
pub struct ProjectPatch {
    #[serde(default, deserialize_with = "crate::within::<MAX_LINE, _, _>")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "crate::within::<MAX_LINE, _, _>")]
    pub color: Option<String>,
    #[serde(default, deserialize_with = "crate::within::<MAX_LINE, _, _>")]
    pub aliases: Option<Vec<String>>,
    pub isolate: Option<Isolate>,
}

/// The editable fields of a note; a missing one is left as it is.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields = nullable))]
pub struct NotePatch {
    #[serde(default, deserialize_with = "crate::within::<MAX_TEXT, _, _>")]
    pub text: Option<String>,
    #[serde(default, deserialize_with = "crate::drawn")]
    pub strokes: Option<Vec<Stroke>>,
}

/// `delete`: removes plain data, and a terminal that is not running with its
/// history, the only way history is removed; one a session refers to is
/// `conflict`. Deleting a preference restores its default.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "c", rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Delete {
    Prefs { id: PrefKey },
    Layouts { id: ProjectId },
    Thoughts { id: ThoughtId },
    Terminals { id: TerminalId },
}

/// `history`: finished thoughts older than `before`, newest first; with
/// `after`, first the questions and results of `before` after that id.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields = nullable))]
pub struct History {
    pub before: Option<ThoughtId>,
    #[cfg_attr(test, ts(as = "Option<String>"))]
    pub after: Option<Uuid>,
    pub limit: Limit,
}

/// A page size from 1 to 100, which bounds every history reply.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u32", into = "u32")]
#[cfg_attr(test, derive(ts_rs::TS), ts(type = "number"))]
pub struct Limit(u8);

impl Limit {
    pub const MAX: Limit = Limit(100);

    pub fn new(n: u32) -> Option<Self> {
        (1..=100).contains(&n).then_some(Self(n as u8))
    }

    pub const fn get(self) -> u32 {
        self.0 as u32
    }
}

impl TryFrom<u32> for Limit {
    type Error = Invalid;
    fn try_from(n: u32) -> Result<Self, Invalid> {
        Self::new(n).ok_or(Invalid("a history limit is 1 to 100"))
    }
}

impl From<Limit> for u32 {
    fn from(limit: Limit) -> u32 {
        limit.get()
    }
}

/// Thoughts that left the live set, each with its questions and results,
/// cut where the rows stop fitting one snapshot chunk: a short page is not
/// the end, an empty one is.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct HistoryPage {
    pub thoughts: Vec<Thought>,
    pub questions: Vec<Question>,
    pub results: Vec<TurnResult>,
    /// Set when the page was cut among a thought's questions and results:
    /// the id of the last it holds, in id order (nil for none). The next
    /// page asks with it as `after` and that thought as `before`: the last
    /// in `thoughts`, or the `before` this page was asked with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(as = "Option<String>", optional))]
    pub after: Option<Uuid>,
}

/// `thought.capture`. A project or session given here is the person's own
/// pick, which routes the thought without asking the router.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields = nullable))]
pub struct Capture {
    pub id: ThoughtId,
    #[serde(deserialize_with = "crate::within::<MAX_TEXT, _, _>")]
    pub text: String,
    #[serde(default, deserialize_with = "crate::drawn")]
    pub strokes: Vec<Stroke>,
    pub source: Source,
    pub mode: Option<Mode>,
    pub project_id: Option<ProjectId>,
    pub session_id: Option<SessionId>,
    /// The agent a new run of the thought uses, by the id `agents.detect`
    /// lists; without one, the `agent` preference, else the first agent
    /// this core has. A follow-up uses its session's agent.
    #[serde(default, deserialize_with = "crate::within::<MAX_LINE, _, _>")]
    pub agent: Option<String>,
    /// The model a new run asks its agent for; without one, the agent's own default.
    #[serde(default, deserialize_with = "crate::within::<MAX_LINE, _, _>")]
    pub model: Option<String>,
    /// The session the person was in when they captured, which the router
    /// sends the thought on to unless its text names another project. Not
    /// a pick: unlike `session_id`, the router still decides (design §8).
    #[serde(default)]
    pub current: Option<SessionId>,
}

/// `route.hint`: where a capture would go, asked while it is typed (the
/// destination chip). The same match the router makes, with no effect.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields = nullable))]
pub struct Hint {
    #[serde(deserialize_with = "crate::within::<MAX_TEXT, _, _>")]
    pub text: String,
    /// As `thought.capture`'s `current`.
    #[serde(default)]
    pub current: Option<SessionId>,
}

/// `thought.update`: assigns a note to a project.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Assign {
    pub id: ThoughtId,
    pub project_id: ProjectId,
}

/// `thought.start`. The attempt is committed before anything is spawned, so
/// repeating this call never launches twice.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Start {
    pub id: ThoughtId,
    pub attempt: AttemptId,
}

/// `thought.settle`: keeps or discards the changes of a thought's worktree,
/// once its session has ended. The attempt makes a repeat answer from its record.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Settle {
    pub id: ThoughtId,
    pub attempt: AttemptId,
    pub keep: bool,
}

/// `question.ask`: the reply is the answer, once there is one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields = nullable))]
pub struct Ask {
    /// The asker's key, kept per session: asking again with it reaches the
    /// same question, and the same key from another session is another one.
    pub request: String,
    #[serde(flatten, deserialize_with = "crate::asked")]
    pub kind: QuestionKind,
    #[serde(deserialize_with = "crate::within::<MAX_LINE, _, _>")]
    pub prompt: String,
    #[serde(default, deserialize_with = "crate::within::<MAX_TEXT, _, _>")]
    pub detail: Option<String>,
    /// What asks: `permission` for a permission request a hook waits on;
    /// without it, `agent`, a question of the agent's own. A session never
    /// asks as the `router`: that is `invalid`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<QuestionSource>,
}

/// `session.adopt`: an agent a person started by hand in a Tasktap shell
/// becomes a session of that shell's terminal (design §4). The token names
/// the terminal; the reply is the new session. The session belongs to the
/// connection that adopted it and ends with it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Adopt {
    /// The agent's name, as `tasktap hook <agent>` takes it.
    #[serde(deserialize_with = "crate::within::<MAX_LINE, _, _>")]
    pub agent: String,
    /// The folder the person started it in.
    #[serde(deserialize_with = "crate::within::<MAX_LINE, _, _>")]
    pub cwd: String,
}

/// `agents.detect`: whether each agent this core can run is installed on the
/// PATH its terminals get and signed in, as the agent itself says. Without
/// `agents`, every one. Each check runs the agent's own command, at most 4 s.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields = nullable))]
pub struct DetectAgents {
    #[serde(default, deserialize_with = "crate::within::<MAX_LINE, _, _>")]
    pub agents: Option<Vec<String>>,
}

/// The reply of `agents.detect`, in the order the core lists its agents.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Agents {
    pub agents: Vec<AgentHealth>,
}

/// One agent as found on this computer, and what its runs can do.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AgentHealth {
    /// Its id, as a capture and `tasktap hook` name it.
    pub id: String,
    /// Its program is on the PATH the core's terminals get.
    pub installed: bool,
    /// As it reports its version.
    pub version: Option<String>,
    /// Whether it is signed in; none when it could not be told.
    pub signed_in: Option<bool>,
    /// Whom it is signed in as, or how, as it says.
    pub identity: Option<String>,
    /// Its runs report through hooks; one that does not reports by exiting.
    pub events: bool,
    /// A new run can continue an ended session's conversation.
    pub resume: bool,
    /// Where its permission requests are answered; none: none are heard.
    pub permissions: Option<crate::records::ReplyVia>,
    /// Where the questions it asks the person are answered; none: none are heard.
    pub questions: Option<crate::records::ReplyVia>,
}

/// `shim.hold`, which the core calls on the shim of an adopted session before
/// it types a follow-up into the shell's terminal (design §7). With `hold` the
/// shim confirms its agent runs in the foreground and keeps the terminal
/// until a call without it, sent once the text is written; a shim whose agent
/// has ended answers `gone`. With `stop` the shim ends its agent, as
/// `thought.stop` stops a run, and never the shell it runs in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ShimHold {
    pub hold: bool,
    #[serde(default)]
    pub stop: bool,
}

/// `question.withdraw` and `question.received`: the asker names its question
/// by its own key, the only name it holds while it waits. The key reaches
/// only its own session's questions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AskKey {
    pub request: String,
}

/// `question.answer`. Settles only the question it names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AnswerQuestion {
    pub id: QuestionId,
    #[serde(flatten, deserialize_with = "crate::answered")]
    pub response: Response,
}

/// `session.event`: what the session's agent reports, in the core's one vocabulary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields = nullable))]
pub struct SessionEvent {
    /// The sender's own id for this event; the core ignores a repeat.
    pub id: String,
    /// The session's turn the event belongs to, when the sender knows it; a
    /// turn start names the turn it begins. The core ignores an event for
    /// another turn (design §5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<u32>,
    /// Sent for one of the agent's sub-agents, whose events the core ignores.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[cfg_attr(test, ts(as = "Option<bool>", optional))]
    pub subagent: bool,
    /// The agent's own handle for continuing this conversation in a later
    /// run, when its report carries one; the session keeps the latest.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::within::<MAX_LINE, _, _>"
    )]
    pub resume: Option<String>,
    #[serde(flatten)]
    pub event: Event,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields = nullable))]
pub enum Event {
    Ready,
    /// `prompt` is set for a turn the person typed by hand; it becomes a thought.
    TurnStarted {
        #[serde(default, deserialize_with = "crate::within::<MAX_TEXT, _, _>")]
        prompt: Option<String>,
    },
    Activity {
        text: String,
    },
    /// The agent went on after a question answered in its terminal. With
    /// `request`, the key of a question its hook asked through the core
    /// (`question.ask`) and still waits on: the person answered it in the
    /// terminal instead, so it is settled as answered there, and the hook
    /// that waits gets that answer.
    Continued {
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::within::<MAX_LINE, _, _>"
        )]
        request: Option<String>,
    },
    TurnFinished {
        answer: Option<String>,
    },
    TurnFailed {
        #[serde(default, deserialize_with = "crate::within::<MAX_LINE, _, _>")]
        error: Option<String>,
    },
    TurnInterrupted,
    /// The agent asked in its terminal and waits there, not on the core: a
    /// terminal-only question (design §6), bound to the session's turn and
    /// keyed by the session, the turn and `request`, the agent's own id for
    /// the call.
    Question {
        question: Ask,
    },
    /// The agent a shim adopted has exited (design §4). Only the shim of an
    /// adopted session sends it: the core sees a launched agent exit itself.
    Exited {
        code: Option<u32>,
    },
}

/// `input`: a key press from any device, bound to the question it was shown for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Input {
    pub action: Action,
    pub question: QuestionId,
}

words! {
    pub enum Action {
        #[serde(rename = "answer.affirm")]
        Affirm,
        #[serde(rename = "answer.deny")]
        Deny,
    }
}

/// `fixture.stream`: a stream of known bytes with no terminal behind it, for
/// tests and measurement (design §13). Only a core built with its test
/// fixtures answers it. The reply is the stream.
///
/// Both directions carry the fixture's bytes from offset 0: byte `i` is the
/// top byte of the 32-bit product `(i mod 65521) × 0x9E3779B1`. The core
/// closes the stream with `done` once it sent `send` bytes and took
/// `receive` bytes, or with `denied` at the first byte taken that differs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FixtureStream {
    /// What the caller grants the core on this stream at once.
    pub credit: u32,
    /// Bytes the core sends.
    #[serde(default)]
    pub send: Offset,
    /// Bytes the core takes. It never grants more than are still to come.
    #[serde(default)]
    pub receive: Offset,
    /// Most bytes the core puts in one data frame, and the credit it keeps
    /// granted toward it; up to `MAX_CREDIT`.
    pub chunk: u32,
    /// Offsets of the sent bytes where the core puts a plain mark, ascending.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub marks: Vec<Offset>,
}

impl FixtureStream {
    /// A prime, so no frame size lines up with the pattern.
    pub const PERIOD: u64 = 65521;

    /// Byte `at` of the fixture's bytes.
    pub const fn byte(at: u64) -> u8 {
        ((at % Self::PERIOD) as u32)
            .wrapping_mul(0x9E37_79B1)
            .to_be_bytes()[0]
    }
}

/// `fixture.script`: selects the fixture router and launcher, which a core
/// built with its test fixtures has instead of the real ones (design §13), and
/// scripts them. Until it is called such a core has neither, like a release
/// build. The reply is everything they were asked since.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields = nullable))]
pub struct FixtureScript {
    /// What the router answers for every thought from now on.
    pub route: Route,
    /// The launcher refuses every launch, delivery and settle with this.
    #[serde(default, deserialize_with = "crate::within::<MAX_LINE, _, _>")]
    pub refuse: Option<String>,
    /// The launcher starts each run in a terminal the store refuses (one of a
    /// project that does not exist), so recording the launch fails.
    #[serde(default)]
    pub unrecordable: bool,
    /// A follow-up waits untyped, one to an adopted session held by its
    /// shim, until a script without `pause` arrives.
    #[serde(default)]
    pub pause: bool,
    /// Runs start for real: new captures name this agent, and the core's
    /// launcher starts them in terminals. Without it the fixture launcher
    /// only records what it is asked, as `refuse` and `unrecordable` say.
    #[serde(default, deserialize_with = "crate::within::<MAX_LINE, _, _>")]
    pub agent: Option<String>,
}

/// Where a router sends a thought (design §8): the answer of `route.hint`,
/// and what `fixture.script` has the fixture router answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "confidence", rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Route {
    /// One destination; `brief` is what the run is told.
    Clear {
        to: Place,
        #[serde(deserialize_with = "crate::within::<MAX_LINE, _, _>")]
        brief: String,
    },
    Ambiguous {
        #[serde(deserialize_with = "crate::within::<MAX_LINE, _, _>")]
        prompt: String,
        #[serde(deserialize_with = "crate::within::<MAX_LINE, _, _>")]
        candidates: Vec<Candidate>,
    },
    /// Nowhere: the thought stays an idea.
    Unknown,
}

/// Where a thought goes: a new run in a project, or a follow-up to a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Place {
    Project(ProjectId),
    Session(SessionId),
}

/// One choice of an ambiguous route, as its question shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Candidate {
    pub label: String,
    pub to: Place,
}

/// What the fixture launcher and host were asked, oldest first.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FixtureLog {
    pub launched: Vec<FixtureLaunch>,
    /// The thoughts of the follow-ups handed to a running session.
    pub delivered: Vec<ThoughtId>,
    /// Follow-ups that `pause` keeps untyped, one to an adopted session while
    /// its shim holds the terminal for it.
    #[serde(default)]
    pub held: Vec<ThoughtId>,
    pub killed: Vec<TerminalId>,
    pub settled: Vec<ThoughtId>,
    /// The questions the host would have been told about.
    pub notified: Vec<QuestionId>,
}

/// One launch: the terminal it started takes the session's id, and carries
/// the session token a real launch puts in the agent's environment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FixtureLaunch {
    pub thought: ThoughtId,
    pub session: SessionId,
    pub prompt: String,
    pub token: Secret,
}

/// `fixture.clock`: from now on the core's clock reads `now` and moves only
/// when called again; every hold that has ended by then ends before the reply.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FixtureClock {
    pub now: Time,
}

/// `fixture.records`: writes rows only the state machine writes otherwise, so
/// records can be proven without it (design §13): the thoughts and projects
/// given are inserted or replaced and the questions, with their answers,
/// and results inserted, in one
/// transaction published like a `put`'s. Other collections are `invalid`.
/// Only a core built with its test fixtures answers it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FixtureRecords {
    pub sets: Vec<Set>,
}

/// `project.add`. The reply is the id of the project that holds the folder,
/// which is an older one when the folder was already added.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields = nullable))]
pub struct AddProject {
    pub id: ProjectId,
    #[serde(deserialize_with = "crate::within::<MAX_LINE, _, _>")]
    pub folder: String,
    #[serde(default, deserialize_with = "crate::within::<MAX_LINE, _, _>")]
    pub name: Option<String>,
}

/// `terminal.open`: attaches to terminal `id` and replies with a stream of
/// its output, which also carries input to it. With `start`, a terminal no
/// record has yet is started first; the same id with the same `start`
/// attaches, with another is `conflict`. Without `start`, an id no record
/// has is `gone`. A terminal is never started twice: one that exited or was
/// lost is replayed from its history (design §3, §9).
///
/// The stream starts at `from` while that offset is still in the
/// terminal's ring; otherwise with a `gap` mark and a replay from the ring's
/// start, and at the ring's start when `from` is left out. The reply's
/// `from` says where it started. Then come a size mark with the size in
/// effect there, the bytes, a size mark at each later resize, a `live` mark
/// where the ring ended at the time of opening, an `exit` mark after the
/// last byte, and the close, `done`. `cols` and `rows` resize a running
/// terminal: the last caller wins. Input is accepted while the process runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields = nullable))]
pub struct OpenTerminal {
    pub id: TerminalId,
    #[serde(default)]
    pub start: Option<StartTerminal>,
    pub cols: u16,
    pub rows: u16,
    /// The terminal offset the caller has everything before.
    #[serde(default)]
    pub from: Option<Offset>,
    /// What the caller grants the core on this stream at once.
    pub credit: u32,
}

/// What a new terminal runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields = nullable))]
pub struct StartTerminal {
    /// The open project whose folder it runs in; without one it runs in the
    /// person's home folder and belongs to no project.
    #[serde(default)]
    pub project: Option<ProjectId>,
    /// The program and its arguments, started directly with no shell around
    /// it; empty starts the person's login shell.
    #[serde(default, deserialize_with = "crate::within::<MAX_TEXT, _, _>")]
    pub argv: Vec<String>,
    /// By default the program's name.
    #[serde(default, deserialize_with = "crate::within::<MAX_LINE, _, _>")]
    pub title: Option<String>,
}

/// `terminal.resize`: one size per terminal, the last caller's. It reaches
/// the process and becomes a size mark at the offset where it happened.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ResizeTerminal {
    pub id: TerminalId,
    pub cols: u16,
    pub rows: u16,
}

/// `project.close`: no terminal starts in the project until `project.add`
/// names its folder again. With `stop`, its running terminals are stopped in
/// the same step, as `terminal.stop` does; without, they keep running.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CloseProject {
    pub id: ProjectId,
    #[serde(default)]
    pub stop: bool,
}
