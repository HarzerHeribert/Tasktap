//! The records of the collections that exist in Phase 1 (design §1, §5, §6).
//!
//! Rows arrive whole: an optional field is written as `null`, never left out.
//! Columns only the core reads (`token_hash`, `key_hash`, `boot`,
//! `request_key`) and a result's `body` (fetched with `file.read`) are not
//! on the wire. Every row is keyed by `id`, so one client loop merges them all.

use crate::ids::{
    CardId, DeviceId, DictationId, LookId, Offset, PreviewId, ProjectId, QuestionId, ResultId, Rev,
    SessionId, TerminalId, ThoughtId, Time,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

words! {
    pub enum Collection { Thoughts, Projects, Sessions, Terminals, Questions, Results, Layouts, Prefs, Devices, Previews, Looks, Cards, Glance, Agents, Dictations }
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
    Previews(Rows<Preview, PreviewId>),
    /// Where Tasktap looks for the person's projects (docs/projects-design.md).
    Looks(Rows<Look, LookId>),
    /// What Tasktap knows of the person's projects, one row per folder.
    Cards(Rows<Card, CardId>),
    /// One row that always exists, so it is only ever put.
    Glance {
        put: Vec<Glance>,
    },
    /// In memory: one row per agent this core has, once it has been
    /// listed; only the row of an agent the person removed is deleted.
    Agents(Rows<crate::args::AgentHealth, String>),
    /// In memory: the dictations under way or failed (design §8).
    Dictations(Rows<Dictation, DictationId>),
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
    /// The project Tasktap knows and the person has not opened that the
    /// thought goes to: it becomes a workspace, its `project_id`, when the
    /// thought starts there, and stays named here, so what is said of the
    /// thought can say it is new there. None in a row older than the field.
    #[serde(default)]
    pub card_id: Option<CardId>,
    pub session_id: Option<SessionId>,
    pub brief: Option<String>,
    /// How it found its destination and its brief; none when no router was
    /// asked: a note, or a pick whose words go on as they are.
    #[serde(default)]
    pub route: Option<Routing>,
    /// How its place came about, written when it is placed or kept for
    /// later; none until then, and in a row older than the field.
    #[serde(default)]
    pub placed: Option<Placed>,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub workdir: Option<Workdir>,
    pub hold_until: Option<Time>,
    pub read: bool,
    pub created: Time,
    pub updated: Time,
}

/// How a thought found its destination and its brief (design §8).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Routing {
    /// Who was asked: an agent's id for the model behind its tool, or
    /// `local` for the match on names.
    pub by: String,
    /// The model asked, when one was.
    pub model: Option<String>,
    /// Still being asked: the thought does not launch before the answer
    /// or the end of its time limit.
    pub pending: bool,
    /// Why the model was not asked or its answer not used, and the match
    /// on names, or the person's words as they are, were.
    pub fallback: Option<String>,
    /// The person's words that justify a follow-up to a session.
    pub quote: Option<String>,
    /// A few words a model gave the work for a name: the name of the
    /// session a new run of the thought starts.
    #[serde(default)]
    pub title: Option<String>,
    /// Why the match on names started it where it did when no name was
    /// said for certain, in a few words: what only that project has
    /// ("its name and “widgetpack”").
    #[serde(default)]
    pub lead: Option<String>,
    /// Milliseconds the answer took.
    pub ms: Option<u32>,
}

words! {
    /// How a thought's place came about (design §5): who decided where it
    /// goes, or that it waits for later. The last decision counts: a
    /// thought kept for later that the person then sends somewhere is
    /// `picked`.
    pub enum Placed {
        /// The person picked the destination, at capture or later, or
        /// typed the prompt into the session's terminal themselves.
        Picked,
        /// The match on names found the folder or session the words name.
        Name,
        /// A model placed it somewhere other than the session it was captured in.
        Model,
        /// It went on to the session the person was in when they captured it.
        FollowUp,
        /// The person chose the destination in the router's question.
        Answer,
        /// For later: the person saved it so at capture.
        Kept,
        /// For later: the person declined the choices of the router's question.
        KeptAnswer,
        /// For later: the match on names found no place for it.
        KeptName,
        /// For later: a model found no place for it.
        KeptModel,
    }
}

/// One handwritten stroke: `[x, y]` points on a 600 × 176 canvas.
pub type Stroke = Vec<[f64; 2]>;

words! {
    pub enum Source { Typed, Voice, Terminal }
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

/// The worktree a thought runs in when its project isolates (design §7,
/// "Isolation"). It belongs to this thought alone; follow-ups to its
/// sessions work in it too.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Workdir {
    /// `<data>/worktrees/<name>`, canonical.
    pub path: String,
    /// `tasktap/<name>`, made for this worktree from `base`.
    pub branch: String,
    /// The branch Keep brings the changes into, recorded at creation: the
    /// one the project folder was on. None when it was on no branch (a
    /// detached HEAD); Keep then refuses and the branch is the person's to merge.
    pub destination: Option<String>,
    /// The commit the worktree started from: the project folder's HEAD then.
    pub base: String,
    /// The project folder had uncommitted changes of its own when the
    /// worktree was made. The run started from `base` without them, and
    /// they stay where they are.
    #[serde(default)]
    pub left_out: bool,
    pub changes: Changes,
    /// The changes against `base`, committed on the branch or not, as the
    /// last look found them: files changed, lines added, lines removed.
    #[serde(default)]
    pub files: u32,
    #[serde(default)]
    pub insertions: u32,
    #[serde(default)]
    pub deletions: u32,
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

/// What Tasktap knows of one folder that is, or holds a copy of, a
/// project (docs/projects-design.md): not a workspace, and no right to
/// read, show or open anything in it. A card becomes a workspace, a
/// `projects` row, when a thought starts there or the person opens it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Card {
    pub id: CardId,
    pub rev: Rev,
    /// Canonical and unique among cards.
    pub folder: String,
    /// What it is called: the folder's name.
    pub name: String,
    /// Other names it goes by: the one its package file gives, when that
    /// differs, and those the person gave it.
    pub names: Vec<String>,
    /// Of `names`, those the person gave it: kept whatever a look finds.
    #[serde(default)]
    pub given: Vec<String>,
    /// Names a look found that the person took away: not given it again.
    #[serde(default)]
    pub dropped: Vec<String>,
    /// One line about it, from its README or its package file; empty when none says.
    pub about: String,
    /// The file the line is from.
    pub about_from: Option<String>,
    /// Why Tasktap takes it for a project, strongest first.
    pub why: Vec<Evidence>,
    /// The agents whose history names it, by id.
    pub agents: Vec<String>,
    /// Which repository it is: `remote <host/path>` for one with a remote,
    /// `root <commit>` by its first commit for one without; none for a
    /// folder without Git. Copies of one repository share it.
    pub repo: Option<String>,
    /// The repository's first commit (`root <commit>`), for one with Git
    /// whether or not it has a remote: a clone of a folder on this machine
    /// has no remote of its own, and is a copy of the repository it was
    /// made from by this.
    #[serde(default)]
    pub root: Option<String>,
    /// Another copy of the repository of that card, which is the project:
    /// shown under it, never as a project of its own.
    pub copy_of: Option<CardId>,
    /// A folder inside that card's project where an agent was started.
    pub inside: Option<CardId>,
    /// The workspace of this folder, once it is one.
    pub project_id: Option<ProjectId>,
    /// When work last happened in it as far as Tasktap knows: an agent's
    /// history, or a thought of Tasktap's.
    pub used: Option<Time>,
    /// The looks that found it the last time each was read.
    pub looks: Vec<LookId>,
    /// The person said it is not a project: never offered, never placed
    /// into, and kept so that a look does not bring it back.
    pub hidden: bool,
    /// The person chose this copy as the project.
    pub main: bool,
    /// Its folder was there the last time Tasktap looked.
    pub available: bool,
    /// Where its agent works (design §7, "Isolation"), as the person chose
    /// it in Settings: its workspace takes it when it is made, and follows
    /// it whenever it is changed (`put cards`).
    #[serde(default)]
    pub isolate: Isolate,
}

words! {
    /// Why a folder is taken for a project, strongest first.
    pub enum Evidence {
        /// The person opened it in Tasktap.
        Opened,
        /// An agent was started in it (an agent's history, or Tasktap's own).
        Agent,
        /// It is the top of a Git repository.
        Git,
        /// It has a package file, and no project is above it.
        Package,
        /// An agent's files are in it (`AGENTS.md`, `CLAUDE.md`, `.claude`…).
        Signs,
    }
}

/// One place Tasktap looks for projects (docs/projects-design.md): an
/// agent's history, or a folder the person keeps projects in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Look {
    pub id: LookId,
    pub rev: Rev,
    pub kind: LookKind,
    /// Of an agent's history: the agent, by its id.
    pub agent: Option<String>,
    /// Of a folder to look in: the folder, canonical.
    pub folder: Option<String>,
    /// Read when Tasktap looks. The person switches it; an agent's history
    /// is off until they turn it on.
    pub on: bool,
    pub state: LookState,
    /// The projects it found the last time it was read.
    pub found: u32,
    /// When it was last read.
    pub looked: Option<Time>,
    /// What stopped it, in words, when it read nothing.
    pub note: Option<String>,
    /// What it reads as it was when it was last read: the modified times
    /// of its folders, as one value. When they are the same, nothing new
    /// is there to find and it is not read again.
    #[serde(default)]
    pub stamp: Option<String>,
}

words! {
    /// What a look reads. Another kind (an account on a code host) is one
    /// more word here and one more row of the core's table of kinds.
    pub enum LookKind { Agent, Folder }
}

words! {
    pub enum LookState {
        /// Not read yet.
        New,
        /// Read; `found` says what it found.
        Ready,
        /// It is not there now: what it found is kept.
        Gone,
        /// Too many folders to be a folder of projects: nothing listed.
        Many,
        /// It could not be read; `note` says why.
        Failed,
    }
}

words! {
    /// When a thought gets its own worktree; `busy` means when the project has
    /// a session that is not idle or ended.
    #[derive(Default)]
    pub enum Isolate { #[default] Busy, Always, Never }
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
    /// Of a router's question (`source: router`): where each of its
    /// `choices` sends the thought, in their order, a folder or a session
    /// by its id. None for every other question, and in a row older than
    /// the field.
    #[serde(default)]
    pub places: Option<Vec<crate::args::Place>>,
    /// Of a router's question: why each of its `choices` is there, in a
    /// few words ("named in it", "invoices, export"), or empty. None for
    /// every other question, and in a row older than the field.
    #[serde(default)]
    pub notes: Option<Vec<String>>,
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

/// Something shown beside a terminal (design §9, "Previews"): a file, or a
/// web address of this machine. `preview.open` writes it, under the rules
/// of what may be shown, and `delete` closes it; it goes with its
/// terminal's record. Where it stands is the layout's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Preview {
    pub id: PreviewId,
    pub rev: Rev,
    /// The terminal it is shown beside, a session's or a shell's.
    pub terminal_id: TerminalId,
    pub kind: PreviewKind,
    /// A file's whole path with every link followed, as `file.read` takes
    /// it; or the web address, as it was given.
    pub target: String,
    /// The file's name, or the address's host and port.
    pub title: String,
    /// Who opened it: the person at a device, or the agent in the
    /// terminal with `tasktap preview`.
    pub by: PreviewBy,
}

words! {
    pub enum PreviewKind { File, Web }
}

words! {
    pub enum PreviewBy { Person, Agent }
}

/// Previews one terminal has open at once; `preview.open` of one more is
/// `conflict`.
pub const MAX_PREVIEWS: usize = 8;

words! {
    /// What a file is, by its first bytes and then by its name
    /// (`file.read`): the formats a web view draws, text, and everything
    /// else, which no preview shows.
    pub enum FileKind { Text, Markdown, Html, Svg, Png, Jpeg, Gif, Webp, Pdf, Other }
}

/// How a file of text is encoded, in the words a page's `TextDecoder`
/// takes. UTF-16 only where the file says so with its first bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Encoding {
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-16le")]
    Utf16le,
    #[serde(rename = "utf-16be")]
    Utf16be,
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
    /// The person's consent to route by a model (design §8): the agent
    /// whose tool is asked and the model it asks, which is all the consent
    /// covers. None, or one that names another model than this core would
    /// ask: thoughts are routed by the match on names alone.
    RouteBy(Option<RouteBy>),
    /// The form the app's motion draws in the open notch and the workspace.
    MotionStyle(MotionStyle),
    /// The colour of the motion's lights; custom takes `motion_hue`.
    MotionPalette(MotionPalette),
    /// Degrees on the colour wheel for the custom palette; the pages read it modulo 360.
    MotionHue(u16),
    /// Lumen's light (coloured light behind the form and a beam across it) is on.
    MotionLumen(bool),
    /// The light in the window's black: none, held still, or breathing while something happens.
    MotionAmbient(MotionAmbient),
    /// The terminals' font family; empty: the look's own.
    TerminalFont(String),
    /// The terminals' text size in CSS pixels.
    TerminalSize(u8),
    /// The terminals' line height in hundredths of the font's own: 100 is the font's.
    TerminalLineHeight(u16),
    /// The person's consent to a speech service (design §8): the server
    /// their recordings are sent to and the model it is asked for, which
    /// is all the consent covers. None: nothing is sent, and whoever
    /// records transcribes.
    SpeechBy(Option<SpeechBy>),
    /// The languages the person speaks, as a hint to whoever transcribes:
    /// ISO 639-1 codes, at most four. Empty: no hint.
    SpeechLanguages(Vec<String>),
    /// The servers a key is stored for in the system's credential store.
    /// Only the core writes it, with `key.set` and `key.remove`; the
    /// keys themselves are in no record.
    Keys(Vec<String>),
    /// What Return does in the Composer. True: Return sends and
    /// Shift-Return makes a new line. False: Command-Return (Control-Return
    /// off the Mac) sends and Return makes a new line. The pages read it.
    ReturnSends(bool),
    /// The key that opens capture from any app, which the host registers
    /// (design §12). None: the system's own, [`Shortcut::capture`].
    CaptureKey(Option<Shortcut>),
    /// The key held to talk in the Composer, which the pages read. None:
    /// the pages' own, Option-Space.
    TalkKey(Option<Shortcut>),
    /// The key that goes to a waiting question from any app, which the host
    /// registers only while a question waits (design §12). None: the
    /// system's own, [`Shortcut::answer`].
    QuestionKey(Option<Shortcut>),
    /// The key that answers Yes from any app, as `question_key` is.
    YesKey(Option<Shortcut>),
    /// The key that answers No from any app, as `question_key` is.
    NoKey(Option<Shortcut>),
    /// Days a finished thought is kept after it last changed, with its
    /// questions and results and what its session left (design §5,
    /// "pruned"). 0: forever.
    KeepDays(u16),
    /// The terminals draw bold text in the bright colours, as most
    /// terminals do. False: bold text keeps its colour.
    TerminalBoldBright(bool),
    /// The terminals lift a colour a program painted until it reads on what
    /// is behind it (4.5 : 1). False: colours are drawn as painted.
    TerminalContrast(bool),
    /// The size of the interface's text: a scale the pages apply to their
    /// type roles.
    TextSize(TextSize),
    /// What the person lets an agent do beyond its default, each as
    /// `<agent>.<option>`, an option its row of the `agents` collection
    /// lists (`options`). One that is not here is off.
    AgentOptions(Vec<String>),
    /// The agents the person added themselves, in their order: each a name
    /// and a command line. They follow the core's own in the `agents`
    /// collection.
    OwnAgents(Vec<OwnAgent>),
    /// The person put Setup away on Home (design/ui-directions/NOTES.md §13):
    /// its one-time offers stay in Settings, and Home shows it no more.
    /// False: Home shows it while one of its steps is not done.
    SetupHidden(bool),
    /// Tasktap asks GitHub for a new version by itself (host/src/update.rs):
    /// when About is shown and at the first capture of a day. False: never
    /// unless the person asks for one check (`host.update {look, now}`).
    UpdateChecks(bool),
}

/// An agent the person added (design §7): any program that takes what it is
/// told as an argument, does the work and exits. Tasktap hears nothing of
/// it but its end.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct OwnAgent {
    /// `own-` and 1 to 16 lower-case letters and digits, made where it is
    /// added and never changed: thoughts and sessions keep it.
    pub id: String,
    /// As the person calls it, 1 to 40 characters.
    pub name: String,
    /// Its command line: the program, then its arguments, apart by spaces,
    /// with quotes around one that has spaces; `{prompt}` in an argument
    /// is what the run is told. No shell reads it.
    pub command: String,
    /// The person removed it: it runs nothing and is not listed, and is
    /// kept so that what it ran still says who ran it, and so that it can
    /// be added back as it was.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub removed: bool,
}

/// A key combination in a portable form: the modifiers held, and the key
/// by its place on the keyboard, the `code` of a keyboard event in a page
/// (`Space`, `KeyJ`, `F5`). Never a display string: each side writes it
/// out in its system's own words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Shortcut {
    pub control: bool,
    /// Option on a Mac.
    pub alt: bool,
    pub shift: bool,
    /// Command on a Mac, the Windows key elsewhere.
    pub meta: bool,
    #[serde(deserialize_with = "crate::within::<32, _, _>")]
    pub code: String,
}

/// The keys a shortcut can end in beside a letter (`KeyA`), a digit
/// (`Digit1`) and `F1` to `F12`: those every host can register.
const KEYS: [&str; 25] = [
    "Space",
    "Enter",
    "Tab",
    "Escape",
    "Backspace",
    "Delete",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Minus",
    "Equal",
    "BracketLeft",
    "BracketRight",
    "Backslash",
    "Semicolon",
    "Quote",
    "Backquote",
    "Comma",
    "Period",
    "Slash",
];

/// Combinations a system keeps for itself, as control, alt, shift, meta
/// and the key: switching apps and windows, Spotlight and the input
/// menu, quitting, locking, closing, the screenshots of a Mac, Force
/// Quit, and the Task Manager and secure screen of Windows. A system
/// refuses more than these when asked to register them; these are refused
/// before it is asked, on every system, so a preference means the same
/// wherever it is read.
const RESERVED: [(bool, bool, bool, bool, &str); 18] = [
    (false, false, false, true, "Space"),
    (false, false, false, true, "Tab"),
    (false, false, true, true, "Tab"),
    (false, true, false, false, "Tab"),
    (false, true, true, false, "Tab"),
    (false, false, false, true, "Backquote"),
    (false, false, false, true, "KeyQ"),
    (true, false, false, true, "KeyQ"),
    (false, false, false, true, "KeyL"),
    (false, false, false, true, "KeyW"),
    (false, true, false, false, "F4"),
    (false, true, false, true, "Escape"),
    (true, false, false, false, "Escape"),
    (true, false, true, false, "Escape"),
    (true, true, false, false, "Delete"),
    (false, false, true, true, "Digit3"),
    (false, false, true, true, "Digit4"),
    (false, false, true, true, "Digit5"),
];

impl Shortcut {
    pub const NO_KEY: &'static str = "That is not a key a shortcut can end in";
    pub const BARE: &'static str =
        "A shortcut needs Control, Option (Alt) or Command (the Windows key) held with its key";
    pub const RESERVED: &'static str = "The system keeps that combination for itself";

    /// Why this combination cannot be a shortcut, in a sentence the
    /// interface shows as it is; none when it can. The one rule of every
    /// key preference (`capture_key`, `talk_key` and the three answer
    /// keys), which the core applies to a `put` and the host before it asks
    /// the system. That two of Tasktap's keys are not one is [`clash`]; that
    /// one is not a key of Tasktap's own window, nor of every app, is
    /// [`crate::own_key`], which depends on the system.
    pub fn refused(&self) -> Option<&'static str> {
        let code = self.code.as_str();
        let after = |prefix: &str| code.strip_prefix(prefix).map(str::as_bytes);
        let function = code.strip_prefix('F').filter(|n| !n.starts_with('0'));
        let keyed = matches!(after("Key"), Some([b'A'..=b'Z']))
            || matches!(after("Digit"), Some([b'0'..=b'9']))
            || function.is_some_and(|n| n.parse().is_ok_and(|n: u8| (1..=12).contains(&n)))
            || KEYS.contains(&code);
        let held = (self.control, self.alt, self.shift, self.meta);
        if !keyed {
            Some(Self::NO_KEY)
        } else if !(self.control || self.alt || self.meta) {
            Some(Self::BARE)
        } else if RESERVED.contains(&(held.0, held.1, held.2, held.3, code)) {
            Some(Self::RESERVED)
        } else {
            None
        }
    }

    /// The key that answers a waiting question while its preference is
    /// unset (design §12): J goes to the question, Y says yes and N says
    /// no, with Control-Option on a Mac, as in 1.2. Elsewhere Alt-Shift, as
    /// the capture key there: Control-Alt is AltGr on a German keyboard,
    /// among others, and a key with it would type a character there.
    pub fn answer(mac: bool, which: AnswerKey) -> Shortcut {
        Shortcut {
            control: mac,
            alt: true,
            shift: !mac,
            meta: false,
            code: which.code().into(),
        }
    }

    /// The key held to talk while the `talk_key` preference is unset, as
    /// the pages have it (ui/src/keys.ts `TALK`): Option-Space on a Mac,
    /// Control-Space elsewhere, where Alt-Space opens a window's own menu
    /// and Control-Alt is AltGr.
    pub fn talk(mac: bool) -> Shortcut {
        Shortcut {
            control: !mac,
            alt: mac,
            shift: false,
            meta: false,
            code: "Space".into(),
        }
    }

    /// A key preference's value while it is unset: the capture key and the
    /// answer keys are this system's own, the talk key the pages' own.
    pub fn usual(id: PrefKey, mac: bool) -> Option<Shortcut> {
        match id {
            PrefKey::CaptureKey => Some(Shortcut::capture(mac)),
            PrefKey::TalkKey => Some(Shortcut::talk(mac)),
            _ => AnswerKey::of(id).map(|which| Shortcut::answer(mac, which)),
        }
    }

    /// What Tasktap already does with the key of the key preference `id`:
    /// the sentence that refuses another key preference the same key.
    pub fn taken(id: PrefKey) -> Option<&'static str> {
        Some(match id {
            PrefKey::CaptureKey => "Tasktap already uses that combination to start a task",
            PrefKey::QuestionKey => {
                "Tasktap already uses that combination to go to an agent’s question"
            }
            PrefKey::YesKey => "Tasktap already uses that combination to answer Yes",
            PrefKey::NoKey => "Tasktap already uses that combination to answer No",
            PrefKey::TalkKey => {
                "Tasktap already uses that combination as the key to hold while you talk"
            }
            _ => return None,
        })
    }
}

/// Every key preference: the capture key, the three answer keys and the
/// talk key, the keys a person records.
pub const KEY_PREFS: [PrefKey; 5] = [
    PrefKey::CaptureKey,
    PrefKey::QuestionKey,
    PrefKey::YesKey,
    PrefKey::NoKey,
    PrefKey::TalkKey,
];

/// The keys that answer a waiting question from any app, which the host
/// registers only while one waits (design §12), in the order of its table.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AnswerKey {
    /// Goes to the question: the notch, or the window, with the keyboard
    /// on its answers.
    Question,
    Yes,
    No,
}

impl AnswerKey {
    pub const ALL: [AnswerKey; 3] = [AnswerKey::Question, AnswerKey::Yes, AnswerKey::No];

    /// The preference that holds it.
    pub fn pref(self) -> PrefKey {
        match self {
            AnswerKey::Question => PrefKey::QuestionKey,
            AnswerKey::Yes => PrefKey::YesKey,
            AnswerKey::No => PrefKey::NoKey,
        }
    }

    /// The answer key a preference holds, if it holds one.
    pub fn of(id: PrefKey) -> Option<AnswerKey> {
        AnswerKey::ALL.into_iter().find(|which| which.pref() == id)
    }

    /// The key it ends in while its preference is unset.
    fn code(self) -> &'static str {
        match self {
            AnswerKey::Question => "KeyJ",
            AnswerKey::Yes => "KeyY",
            AnswerKey::No => "KeyN",
        }
    }
}

impl PrefValue {
    /// A key preference's key: none for any other preference, and for a key
    /// preference that is unset `Some(None)`.
    pub fn shortcut(&self) -> Option<Option<&Shortcut>> {
        match self {
            PrefValue::CaptureKey(k)
            | PrefValue::TalkKey(k)
            | PrefValue::QuestionKey(k)
            | PrefValue::YesKey(k)
            | PrefValue::NoKey(k) => Some(k.as_ref()),
            _ => None,
        }
    }
}

/// Every key a person records as it is now (`KEY_PREFS`): each its
/// preference as `stored` has it, or else this system's own.
pub fn keys_in_use(
    mac: bool,
    stored: impl Fn(PrefKey) -> Option<Shortcut>,
) -> Vec<(PrefKey, Shortcut)> {
    (KEY_PREFS.into_iter())
        .filter_map(|id| Some((id, stored(id).or_else(|| Shortcut::usual(id, mac))?)))
        .collect()
}

/// Why `key` cannot be the key preference `id` beside Tasktap's other keys
/// as they are now (`in_use`, each preference with its key): no two of the
/// five are one, whichever is recorded, since one would take it from the
/// other (a global key from the page's talk key, the capture key from an
/// answer key while a question waits). The sentence says which key has it
/// already (`Shortcut::taken`). None when it can be.
pub fn clash(id: PrefKey, key: &Shortcut, in_use: &[(PrefKey, Shortcut)]) -> Option<&'static str> {
    let other = in_use.iter().find(|(other, k)| *other != id && k == key)?.0;
    Shortcut::taken(other)
}

impl Shortcut {
    /// The capture key while the `capture_key` preference is unset:
    /// Control-Option-Space on a Mac, as in 1.2. Elsewhere Alt-Shift-Space:
    /// Control-Alt is AltGr on a German keyboard, among others, and the
    /// Windows key's combinations are the system's.
    pub fn capture(mac: bool) -> Shortcut {
        Shortcut {
            control: mac,
            alt: true,
            shift: !mac,
            meta: false,
            code: "Space".into(),
        }
    }
}

/// What the `speech_by` preference names: a server that speaks the
/// OpenAI transcription endpoint, and the model it is asked for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct SpeechBy {
    /// Where `/v1/audio/transcriptions` is added: `https://api.openai.com`.
    #[serde(deserialize_with = "crate::within::<{ crate::MAX_LINE }, _, _>")]
    pub server: String,
    #[serde(deserialize_with = "crate::within::<{ crate::MAX_LINE }, _, _>")]
    pub model: String,
}

/// What the `route_by` preference holds (design §8): the person's one
/// agreement that Tasktap may place thoughts with their own agents, and
/// which of them, in the order they are asked. A consent to one agent that
/// a core before this one kept reads as a list of that agent alone (the
/// store's fourth migration).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct RouteBy {
    /// The agents, the first asked first, each once. One switched off is
    /// never asked.
    #[serde(deserialize_with = "crate::within::<{ crate::MAX_LINE }, _, _>")]
    pub agents: Vec<Placer>,
    /// The version of what is sent that the person saw, as `route.terms`
    /// names it. An agreement to another version than the core's covers
    /// nothing.
    pub terms: u32,
}

/// One agent of an agreement to place thoughts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Placer {
    /// The agent, by the id `agents.detect` lists.
    pub agent: String,
    /// The model its tool is asked for, as `route.terms` names it: the
    /// agreement covers that model alone.
    pub model: String,
    /// The person lets it place thoughts.
    pub on: bool,
}

words! {
    /// What placing a thought with an agent costs the person (design §8):
    /// nothing more than they pay already, as a subscription's small model
    /// is included in it (`plan`), or what their provider bills for each
    /// use, as with a key, or where Tasktap cannot know (`billed`).
    pub enum Pays { Plan, Billed }
}

words! {
    pub enum PrefKey {
        Hold, Agent, RouteBy, MotionStyle, MotionPalette, MotionHue, MotionLumen, MotionAmbient,
        TerminalFont, TerminalSize, TerminalLineHeight, SpeechBy, SpeechLanguages, Keys,
        ReturnSends, CaptureKey, TalkKey, KeepDays, TerminalBoldBright, TerminalContrast, TextSize,
        AgentOptions, OwnAgents, SetupHidden, UpdateChecks, QuestionKey, YesKey, NoKey
    }
}

words! {
    pub enum TextSize { Small, Default, Large }
}

words! {
    pub enum MotionStyle { Slats, Glyphs, Resonator }
}

words! {
    pub enum MotionPalette { Chrome, Chromatic, Warm, Cool, Custom }
}

words! {
    pub enum MotionAmbient { Off, Still, Breathing }
}

/// Seconds a routed thought is held while the `hold` preference is unset.
pub const DEFAULT_HOLD: u32 = 5;

/// Seconds a route or a brief is there to read before its thought launches:
/// a hold ends no earlier than this after either arrived, or than the hold
/// itself after it where the person set a shorter one.
pub const READ_HOLD: u32 = 2;

impl PrefKey {
    /// The value of a preference while none is stored: deleting it restores this.
    pub const fn default(self) -> PrefValue {
        match self {
            PrefKey::Hold => PrefValue::Hold(DEFAULT_HOLD),
            PrefKey::Agent => PrefValue::Agent(None),
            PrefKey::RouteBy => PrefValue::RouteBy(None),
            PrefKey::MotionStyle => PrefValue::MotionStyle(MotionStyle::Slats),
            PrefKey::MotionPalette => PrefValue::MotionPalette(MotionPalette::Chromatic),
            PrefKey::MotionHue => PrefValue::MotionHue(265),
            PrefKey::MotionLumen => PrefValue::MotionLumen(false),
            PrefKey::MotionAmbient => PrefValue::MotionAmbient(MotionAmbient::Breathing),
            PrefKey::TerminalFont => PrefValue::TerminalFont(String::new()),
            PrefKey::TerminalSize => PrefValue::TerminalSize(14),
            PrefKey::TerminalLineHeight => PrefValue::TerminalLineHeight(100),
            PrefKey::SpeechBy => PrefValue::SpeechBy(None),
            PrefKey::SpeechLanguages => PrefValue::SpeechLanguages(Vec::new()),
            PrefKey::Keys => PrefValue::Keys(Vec::new()),
            PrefKey::ReturnSends => PrefValue::ReturnSends(true),
            PrefKey::CaptureKey => PrefValue::CaptureKey(None),
            PrefKey::TalkKey => PrefValue::TalkKey(None),
            PrefKey::KeepDays => PrefValue::KeepDays(0),
            PrefKey::TerminalBoldBright => PrefValue::TerminalBoldBright(true),
            PrefKey::TerminalContrast => PrefValue::TerminalContrast(true),
            PrefKey::TextSize => PrefValue::TextSize(TextSize::Default),
            PrefKey::AgentOptions => PrefValue::AgentOptions(Vec::new()),
            PrefKey::OwnAgents => PrefValue::OwnAgents(Vec::new()),
            PrefKey::SetupHidden => PrefValue::SetupHidden(false),
            PrefKey::UpdateChecks => PrefValue::UpdateChecks(true),
            PrefKey::QuestionKey => PrefValue::QuestionKey(None),
            PrefKey::YesKey => PrefValue::YesKey(None),
            PrefKey::NoKey => PrefValue::NoKey(None),
        }
    }
}

impl PrefValue {
    pub fn key(&self) -> PrefKey {
        match self {
            PrefValue::Hold(_) => PrefKey::Hold,
            PrefValue::Agent(_) => PrefKey::Agent,
            PrefValue::RouteBy(_) => PrefKey::RouteBy,
            PrefValue::MotionStyle(_) => PrefKey::MotionStyle,
            PrefValue::MotionPalette(_) => PrefKey::MotionPalette,
            PrefValue::MotionHue(_) => PrefKey::MotionHue,
            PrefValue::MotionLumen(_) => PrefKey::MotionLumen,
            PrefValue::MotionAmbient(_) => PrefKey::MotionAmbient,
            PrefValue::TerminalFont(_) => PrefKey::TerminalFont,
            PrefValue::TerminalSize(_) => PrefKey::TerminalSize,
            PrefValue::TerminalLineHeight(_) => PrefKey::TerminalLineHeight,
            PrefValue::SpeechBy(_) => PrefKey::SpeechBy,
            PrefValue::SpeechLanguages(_) => PrefKey::SpeechLanguages,
            PrefValue::Keys(_) => PrefKey::Keys,
            PrefValue::ReturnSends(_) => PrefKey::ReturnSends,
            PrefValue::CaptureKey(_) => PrefKey::CaptureKey,
            PrefValue::TalkKey(_) => PrefKey::TalkKey,
            PrefValue::KeepDays(_) => PrefKey::KeepDays,
            PrefValue::TerminalBoldBright(_) => PrefKey::TerminalBoldBright,
            PrefValue::TerminalContrast(_) => PrefKey::TerminalContrast,
            PrefValue::TextSize(_) => PrefKey::TextSize,
            PrefValue::AgentOptions(_) => PrefKey::AgentOptions,
            PrefValue::OwnAgents(_) => PrefKey::OwnAgents,
            PrefValue::SetupHidden(_) => PrefKey::SetupHidden,
            PrefValue::UpdateChecks(_) => PrefKey::UpdateChecks,
            PrefValue::QuestionKey(_) => PrefKey::QuestionKey,
            PrefValue::YesKey(_) => PrefKey::YesKey,
            PrefValue::NoKey(_) => PrefKey::NoKey,
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

/// A dictation that is under way or has ended without becoming a thought
/// (design §8): its words are there to be placed in a field, or it failed.
/// Memory only: one that became its thought has no row.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Dictation {
    pub id: DictationId,
    pub rev: Rev,
    pub phase: DictationPhase,
    /// What was heard: the transcript so far while a recorder that
    /// transcribes reports it, and the whole of it once it is `heard`, or
    /// when it could not be captured.
    pub text: String,
    /// How loud the microphone is, 0 to 100, while recording.
    pub level: u8,
    pub target: DictationTarget,
    /// Why it failed, in words the interface shows as they are.
    pub error: Option<String>,
}

words! {
    /// `heard`: the words are in `text`, and the core does nothing with
    /// them; the interface places them in its field.
    pub enum DictationPhase { Recording, Transcribing, Heard, Failed }
}

/// What a dictation becomes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum DictationTarget {
    /// A new thought: a capture as `thought.capture` takes it, its
    /// `source` `voice` and its `text` empty, since the transcript is
    /// its text. It is captured, routed and held as a typed one is.
    Thought(Box<crate::args::Capture>),
    /// Only the words: the dictation ends as `heard` with them in its
    /// row, and nothing is captured or sent. For speech into a field, an
    /// answer or a thought half typed, which the person sends themselves.
    Text,
}
