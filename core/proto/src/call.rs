//! The one table of calls (design §1, §2): the 45 of the 51 core calls built
//! so far, the shim's ability, and the test fixtures.
//!
//! Each call is a type here, named for the call (`thought.capture` is
//! `call::ThoughtCapture`), that ties its name to its
//! argument type, its result type and who may make it, so code that makes or
//! answers a call never writes the name as text.

use crate::args::{
    AddProject, Adopt, Agents, AnswerQuestion, Ask, AskKey, Assign, Capture, CloseProject,
    DetectAgents, Diff, Empty, FixtureLog, Hint, HistoryPage, OpenTerminal, ReadChanges, Ref,
    ResizeTerminal, Revision, Route, Settle, Start, Subscribe,
};
use crate::bootstrap::{Identity, Retire};
use crate::frame::{Control, Outcome, Reply, Request};
use crate::ids::{CallId, DeviceId, ProjectId, QuestionId, SessionId, TerminalId, ThoughtId};
use crate::records::Answer;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

macro_rules! table {
    ($($marker:ident $name:literal $access:ident ($args:ty) -> $result:ty;)*) => {
        /// A call name this crate knows.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum Name { $($marker),* }

        impl Name {
            pub const ALL: &'static [Name] = &[$(Name::$marker),*];

            pub fn as_str(self) -> &'static str {
                match self { $(Name::$marker => $name),* }
            }

            /// `None` for a name this crate does not know; the core answers it with `unknown`.
            pub fn parse(name: &str) -> Option<Name> {
                match name { $($name => Some(Name::$marker),)* _ => None }
            }

            pub fn access(self) -> Access {
                match self { $(Name::$marker => Access::$access),* }
            }
        }

        $(
            #[doc = concat!("`", $name, "`")]
            pub enum $marker {}

            impl Call for $marker {
                const NAME: Name = Name::$marker;
                type Args = $args;
                type Result = $result;
            }
        )*

        #[cfg(test)]
        pub(crate) fn each(v: &mut impl Visit) {
            $(v.call::<$marker>();)*
        }
    };
}

table! {
    // Records
    Sub "sub" Device (Subscribe) -> Revision;
    Put "put" Device (crate::args::Put) -> Revision;
    Delete "delete" Device (crate::args::Delete) -> Revision;
    History "history" Device (crate::args::History) -> HistoryPage;
    // Thoughts
    ThoughtCapture "thought.capture" Device (Capture) -> ();
    ThoughtUpdate "thought.update" Device (Assign) -> ();
    ThoughtStart "thought.start" Device (Start) -> ();
    ThoughtStop "thought.stop" Device (Ref<ThoughtId>) -> ();
    ThoughtRetry "thought.retry" Device (Ref<ThoughtId>) -> ();
    ThoughtSettle "thought.settle" Device (Settle) -> ();
    ThoughtRead "thought.read" Device (Ref<ThoughtId>) -> ();
    ThoughtChanges "thought.changes" Device (ReadChanges) -> Diff;
    // Questions
    QuestionAsk "question.ask" Session (Ask) -> Answer;
    QuestionAnswer "question.answer" Device (AnswerQuestion) -> ();
    QuestionWithdraw "question.withdraw" Session (AskKey) -> ();
    QuestionReceived "question.received" Session (AskKey) -> ();
    QuestionFocus "question.focus" Device (Ref<QuestionId>) -> ();
    // Sessions
    SessionEvent "session.event" Session (crate::args::SessionEvent) -> ();
    SessionAdopt "session.adopt" Session (Adopt) -> SessionId;
    // Routing and agents
    RouteHint "route.hint" Device (Hint) -> Route;
    RouteTerms "route.terms" Device (Empty) -> crate::args::RouteTerms;
    AgentsDetect "agents.detect" Device (DetectAgents) -> Agents;
    // Terminals
    TerminalOpen "terminal.open" Device (OpenTerminal) -> crate::frame::Opened;
    TerminalResize "terminal.resize" Device (ResizeTerminal) -> ();
    TerminalStop "terminal.stop" Device (Ref<TerminalId>) -> ();
    // Projects
    ProjectAdd "project.add" Device (AddProject) -> ProjectId;
    ProjectScan "project.scan" Device (Empty) -> ();
    ProjectClose "project.close" Device (CloseProject) -> ();
    // What Tasktap knows of the person's projects (docs/projects-design.md)
    LookAdd "look.add" Device (crate::args::AddLook) -> crate::ids::LookId;
    ProjectsOffer "projects.offer" Device (Empty) -> crate::args::Offer;
    ProjectsLook "projects.look" Device (Empty) -> crate::args::Looked;
    ProjectsFind "projects.find" Device (crate::args::Find) -> crate::args::Finds;
    // Files and previews (design §9)
    FileRead "file.read" Device (crate::args::ReadFile) -> crate::args::FileRead;
    PreviewOpen "preview.open" Either (crate::args::OpenPreview) -> crate::ids::PreviewId;
    // Input
    Input "input" Device (crate::args::Input) -> ();
    // Speech (design §8)
    DictationStart "dictation.start" Device (crate::args::StartDictation) -> crate::args::Listening;
    DictationReport "dictation.report" Device (crate::args::ReportDictation) -> ();
    DictationFinish "dictation.finish" Device (crate::args::FinishDictation) -> ();
    DictationCancel "dictation.cancel" Device (Ref<crate::ids::DictationId>) -> ();
    SpeechTerms "speech.terms" Device (Empty) -> crate::args::SpeechTerms;
    KeySet "key.set" Device (crate::args::SetKey) -> ();
    KeyRemove "key.remove" Device (crate::args::Server) -> ();
    // Devices and service; the last two are the frozen bootstrap calls, which
    // with no shared version anyone the user check admits may make (bootstrap.rs).
    DeviceRevoke "device.revoke" Device (Ref<DeviceId>) -> ();
    CoreStatus "core.status" Anyone (Empty) -> crate::bootstrap::CoreStatus;
    CoreRetire "core.retire" Device (Retire) -> ();
    // The shim's ability (design §7): the core calls it on a shim.
    ShimHold "shim.hold" Ability (crate::args::ShimHold) -> ();
    // Fixtures (design §13): only a core built with its test fixtures answers these.
    FixtureStream "fixture.stream" Device (crate::args::FixtureStream) -> crate::frame::Opened;
    FixtureScript "fixture.script" Device (crate::args::FixtureScript) -> FixtureLog;
    FixtureClock "fixture.clock" Device (crate::args::FixtureClock) -> ();
    FixtureRecords "fixture.records" Device (crate::args::FixtureRecords) -> Revision;
}

/// Who may make a call (design §2): authorization is per call.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Access {
    /// Any local peer that passed the user check: the bootstrap calls.
    Anyone,
    Device,
    /// A session token, acting only for its own session.
    Session,
    /// A device, or a session token acting only for its own terminal.
    Either,
    /// A call the core makes on a client that offered it in `hello`; no
    /// client may make it.
    Ability,
}

impl Access {
    pub fn permits(self, who: Identity) -> bool {
        match self {
            Access::Anyone => true,
            Access::Device => who == Identity::Device,
            Access::Session => who == Identity::Session,
            Access::Either => who != Identity::Anonymous,
            Access::Ability => false,
        }
    }
}

/// Every protocol type: JSON both ways, and TypeScript when generating it.
#[cfg(not(test))]
pub trait Wire: Serialize + DeserializeOwned {}
#[cfg(not(test))]
impl<T: Serialize + DeserializeOwned> Wire for T {}
#[cfg(test)]
pub trait Wire: Serialize + DeserializeOwned + ts_rs::TS + 'static {}
#[cfg(test)]
impl<T: Serialize + DeserializeOwned + ts_rs::TS + 'static> Wire for T {}

pub trait Call {
    const NAME: Name;
    type Args: Wire;
    type Result: Wire;

    fn request(id: CallId, args: &Self::Args) -> Control {
        let name = Self::NAME.as_str().to_owned();
        Control::Call(Request {
            id,
            name,
            args: to_value(args),
        })
    }

    /// Decodes a call's arguments; the wrong shape is `invalid`.
    fn args(args: Value) -> Result<Self::Args, Error> {
        serde_json::from_value(args).map_err(|e| Error::new(Code::Invalid, e.to_string()))
    }

    fn reply(id: CallId, result: Result<Self::Result, Error>) -> Control {
        let outcome = match result {
            Ok(value) => Outcome::Ok(to_value(&value)),
            Err(e) => Outcome::Err(e),
        };
        Control::Reply(Reply { id, outcome })
    }

    /// Decodes a reply; a result of the wrong shape is `invalid`.
    fn result(outcome: Outcome) -> Result<Self::Result, Error> {
        match outcome {
            Outcome::Ok(value) => {
                serde_json::from_value(value).map_err(|e| Error::new(Code::Invalid, e.to_string()))
            }
            Outcome::Err(e) => Err(e),
        }
    }
}

fn to_value(value: &impl Serialize) -> Value {
    // Every protocol type has string keys and checked integers, so this cannot fail.
    serde_json::to_value(value).expect("protocol types serialize to JSON")
}

#[cfg(test)]
pub(crate) trait Visit {
    fn call<C: Call>(&mut self);
}

/// The one error shape of every failed call.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Error {
    pub code: Code,
    pub message: String,
}

impl Error {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for Error {}

words! {
    pub enum Code {
        /// No call by that name.
        Unknown,
        /// Arguments of the wrong shape, or a value the call refuses.
        Invalid,
        /// The caller may not make this call.
        Denied,
        /// The state changed under the caller, or an id was reused with other arguments.
        Conflict,
        /// The thing named no longer exists or is settled.
        Gone,
        Failed,
    }
}
