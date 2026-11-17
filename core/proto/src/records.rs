//! The records of the collections that exist in Phase 1 (design §1, §5, §6).
//!
//! Rows arrive whole: an optional field is written as `null`, never left out.
//! Columns only the core reads (`token_hash`, `key_hash`, `boot`,
//! `request_key`) and a result's `body` (fetched with `file.read`) are not
//! on the wire. Every row is keyed by `id`, so one client loop merges them all.

use crate::ids::{
    DeviceId, Offset, ProjectId, QuestionId, ResultId, Rev, SessionId, TerminalId, ThoughtId, Time,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

words! {
    pub enum Collection { Thoughts, Projects, Sessions, Terminals, Questions, Results, Layouts, Prefs, Devices, Glance, Agents }
}

/// The rows of one collection that one change touches.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "c", rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Set {
    Thoughts(Rows<Thought, ThoughtId>),
    Projects(Rows<Project, ProjectId>),
    Sessions(Rows<Session, SessionId>),
    Terminals(Rows<Terminal, TerminalId>),
    Questions(Rows<Question, QuestionId>),
    Results(Rows<TurnResult, ResultId>),
    Layouts(Rows<Layout, ProjectId>),
    Prefs(Rows<Pref, PrefKey>),
    Devices(Rows<Device, DeviceId>),
    /// One row that always exists, so it is only ever put.
    Glance {
        put: Vec<Glance>,
    },
    /// In memory: one row per agent this core has, once it has been
    /// detected; rows are only ever put.
    Agents(Rows<crate::args::AgentHealth, String>),
}

/// Rows put whole, and ids of rows that stopped being live.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Rows<R, I> {
    #[serde(default = "Vec::new", skip_serializing_if = "Vec::is_empty")]
    pub put: Vec<R>,
    #[serde(default = "Vec::new", skip_serializing_if = "Vec::is_empty")]
    pub del: Vec<I>,
}

/// The primary record. A note is a thought with mode `note`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Thought {
    pub id: ThoughtId,
    pub rev: Rev,
    pub text: String,
    pub strokes: Vec<Stroke>,
    pub source: Source,
    pub mode: Mode,
    pub phase: Phase,
    pub status: Status,
    pub reason: Option<Reason>,
    pub live: bool,
    pub project_id: Option<ProjectId>,
    pub session_id: Option<SessionId>,
    pub brief: Option<String>,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub workdir: Option<Workdir>,
    pub hold_until: Option<Time>,
    pub read: bool,
    pub created: Time,
    pub updated: Time,
}

/// One handwritten stroke: `[x, y]` points on a 600 × 176 canvas.
pub type Stroke = Vec<[f64; 2]>;

words! {
    pub enum Source { Typed, Voice, Terminal, Import }
}

words! {
    pub enum Mode { Ask, Nudge, Note }
}

words! {
    /// Written only by the state machine.
    pub enum Phase { Captured, Routed, Working, Done, Failed }
}

words! {
    /// Derived in the same transaction as the phase: `needs_you` while the
    /// thought has any open question, otherwise its phase.
    pub enum Status { NeedsYou, Captured, Routed, Working, Done, Failed }
}

impl From<Phase> for Status {
    fn from(phase: Phase) -> Self {
        match phase {
            Phase::Captured => Status::Captured,
            Phase::Routed => Status::Routed,
            Phase::Working => Status::Working,
            Phase::Done => Status::Done,
            Phase::Failed => Status::Failed,
        }
    }
}

words! {
    /// Why a thought failed.
    pub enum Reason {
        /// The launch did not start the agent.
        Launch,
        /// The agent reported a failed turn.
        TurnFailed,
        /// The turn was interrupted, or the core found it lost at start.
        Interrupted,
        /// The agent exited mid-turn.
        Exited,
        /// The person stopped it.
        Stopped,
    }
}

/// The worktree a thought runs in when its project isolates.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Workdir {
    pub path: String,
    pub branch: String,
    /// The branch Keep merges into, recorded at creation.
    pub destination: String,
    /// The commit the worktree started from.
    pub base: String,
    pub changes: Changes,
}

words! {
    pub enum Changes {
        #[serde(rename = "none")]
        Clean,
        Pending,
        Kept,
        Discarded,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Project {
    pub id: ProjectId,
    pub rev: Rev,
    pub name: String,
    /// Canonical and unique among projects.
    pub folder: String,
    pub kind: ProjectKind,
    pub color: String,
    pub aliases: Vec<String>,
    pub git: bool,
    pub isolate: Isolate,
    pub open: bool,
    pub available: bool,
}

words! {
    pub enum ProjectKind { Folder, Scratch }
}

words! {
    /// When a thought gets its own worktree; `busy` means when the project has
    /// a session that is not idle or ended.
    pub enum Isolate { Busy, Always, Never }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Session {
    pub id: SessionId,
    pub rev: Rev,
    pub project_id: ProjectId,
    pub agent: String,
    pub terminal_id: Option<TerminalId>,
    /// Started by hand in a shell rather than launched by the core.
    pub adopted: bool,
    pub state: SessionState,
    /// The thought of the current turn.
    pub thought_id: Option<ThoughtId>,
    pub turn: u32,
    /// The agent's own handle for resuming.
    pub resume: Option<String>,
    pub name: Option<String>,
    pub named_at: Option<Time>,
    pub model: Option<String>,
    pub cwd: String,
    pub exit: Option<u32>,
    pub error: Option<String>,
    /// The last 40 activity lines, oldest first; kept in memory only.
    pub activity: Vec<String>,
}

words! {
    /// Written only by the state machine. A session with an open question
    /// shows asking; that is read from its questions, not stored here.
    pub enum SessionState { Starting, Idle, Working, Ended }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Terminal {
    pub id: TerminalId,
    pub rev: Rev,
    pub project_id: Option<ProjectId>,
    pub kind: TerminalKind,
    pub title: String,
    pub cwd: String,
    pub argv: Vec<String>,
    pub cols: u16,
    pub rows: u16,
    pub state: TerminalState,
    pub exit: Option<u32>,
    /// Bytes of output, as of the row's last write: at start, at each
    /// resize, and at exit, when it is final. A stream counts the rest.
    pub offset: Offset,
}

words! {
    pub enum TerminalKind { Shell, Agent, Task }
}

words! {
    pub enum TerminalState { Running, Exited, Lost }
}

/// Everything except `state` and `answer` is written once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Question {
    pub id: QuestionId,
    pub rev: Rev,
    pub thought_id: Option<ThoughtId>,
    pub session_id: Option<SessionId>,
    pub turn: Option<u32>,
    pub source: QuestionSource,
    #[serde(flatten)]
    pub kind: QuestionKind,
    pub prompt: String,
    pub detail: Option<String>,
    pub reply_via: ReplyVia,
    pub state: QuestionState,
    pub answer: Option<Answer>,
}

words! {
    pub enum QuestionSource { Agent, Permission, Router }
}

/// The kind of a question, with the choices only a `choice` question has.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum QuestionKind {
    Confirm,
    Choice { choices: Vec<String> },
    Text,
}

words! {
    /// `core`: a waiting caller receives the answer. `terminal`: the person
    /// answers in the agent's terminal.
    pub enum ReplyVia { Core, Terminal }
}

words! {
    pub enum QuestionState { Open, Answered, Withdrawn }
}

/// The receipt of an answer, stored before it is sent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Answer {
    #[serde(flatten)]
    pub response: Response,
    pub device_id: Option<DeviceId>,
    pub created: Time,
    /// When the waiter confirmed it with `question.received`.
    pub delivered: Option<Time>,
}

/// What the answer says. A device sends any but `terminal`, which the core
/// records when the agent continues after a question answered in its terminal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Response {
    Affirm,
    Deny,
    /// An index into the question's choices.
    Choice {
        choice: u32,
    },
    Text {
        text: String,
    },
    Terminal,
}

/// A result of a turn.
// Not called `Result`, which would shadow the standard one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct TurnResult {
    pub id: ResultId,
    pub rev: Rev,
    pub thought_id: ThoughtId,
    pub session_id: Option<SessionId>,
    pub turn: Option<u32>,
    pub kind: ResultKind,
    pub summary: String,
}

words! {
    pub enum ResultKind { Answer, Failure, Changes }
}

/// A project's workspace layout; the tree is the UI's and opaque to the core.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Layout {
    /// The project's id.
    pub id: ProjectId,
    pub rev: Rev,
    #[cfg_attr(test, ts(type = "unknown"))]
    pub tree: Value,
}

/// A preference row: `{id, value, rev}`, where the key fixes the value's type.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Pref {
    #[serde(flatten)]
    pub value: PrefValue,
    pub rev: Rev,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "id", content = "value", rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum PrefValue {
    /// Seconds a routed thought waits before it launches; 0 launches at once.
    Hold(u32),
    /// The agent a new run uses when its capture names none; none: the
    /// first agent the core has.
    Agent(Option<String>),
    /// The form the app's motion draws in the open notch and the workspace.
    MotionStyle(MotionStyle),
    /// The colour of the motion's lights; custom takes `motion_hue`.
    MotionPalette(MotionPalette),
    /// Degrees on the colour wheel for the custom palette; the pages read it modulo 360.
    MotionHue(u16),
    /// Lumen's light (coloured light behind the form and a beam across it) is on.
    MotionLumen(bool),
}

words! {
    pub enum PrefKey { Hold, Agent, MotionStyle, MotionPalette, MotionHue, MotionLumen }
}

words! {
    pub enum MotionStyle { Slats, Glyphs, Resonator }
}

words! {
    pub enum MotionPalette { Chrome, Chromatic, Warm, Cool, Custom }
}

/// Seconds a routed thought is held while the `hold` preference is unset.
pub const DEFAULT_HOLD: u32 = 5;

impl PrefKey {
    /// The value of a preference while none is stored: deleting it restores this.
    pub const fn default(self) -> PrefValue {
        match self {
            PrefKey::Hold => PrefValue::Hold(DEFAULT_HOLD),
            PrefKey::Agent => PrefValue::Agent(None),
            PrefKey::MotionStyle => PrefValue::MotionStyle(MotionStyle::Slats),
            PrefKey::MotionPalette => PrefValue::MotionPalette(MotionPalette::Chromatic),
            PrefKey::MotionHue => PrefValue::MotionHue(265),
            PrefKey::MotionLumen => PrefValue::MotionLumen(false),
        }
    }
}

impl PrefValue {
    pub fn key(&self) -> PrefKey {
        match self {
            PrefValue::Hold(_) => PrefKey::Hold,
            PrefValue::Agent(_) => PrefKey::Agent,
            PrefValue::MotionStyle(_) => PrefKey::MotionStyle,
            PrefValue::MotionPalette(_) => PrefKey::MotionPalette,
            PrefValue::MotionHue(_) => PrefKey::MotionHue,
            PrefValue::MotionLumen(_) => PrefKey::MotionLumen,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Device {
    pub id: DeviceId,
    pub rev: Rev,
    pub name: String,
    pub last_seen: Option<Time>,
    pub revoked: bool,
}

/// What a host shows with no page running. Memory only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Glance {
    pub rev: Rev,
    pub working: u32,
    pub needs_you: u32,
    /// Done and not read yet.
    pub done: u32,
    /// Failed and not read yet: stopped, refused, interrupted or ended
    /// without an answer, and not yet seen (`thought.read`) or retried.
    pub failed: u32,
    /// The question affirm and deny act on: the oldest open one unless
    /// `question.focus` chose another.
    pub question: Option<QuestionId>,
    /// `core.retire {when: idle}` was called: the core exits when its last terminal ends.
    pub retiring: bool,
}
