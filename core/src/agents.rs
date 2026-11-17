//! The agents the core knows (design §7), as far as their hooks go: what a
//! hook's payload says in the core's one vocabulary, what a hook that waited
//! prints for its agent, and the arguments that attach the hooks to a run.
//! It runs in `tasktap hook`, so a payload the core would not understand
//! never reaches it. Package D adds launching and detection, and the
//! adapters of Claude Code and Codex.

use std::ffi::OsString;
use std::path::Path;

use tasktap_proto::{Answer, Ask, SessionEvent};

/// What one hook says.
pub enum Heard {
    /// Reported, and the hook exits.
    Event(SessionEvent),
    /// Asked through the core: the agent lets this hook decide, so it waits
    /// for the answer and prints [`Agent::reply`].
    Wait(Ask),
}

pub trait Agent: Sync {
    /// Its name: the shim's program name and the `<agent>` of `tasktap hook`.
    fn id(&self) -> &'static str;

    /// Arguments, put before the person's own, with which a run of the agent
    /// calls `<exe> hook <id>` on its hook events.
    fn attach(&self, exe: &Path) -> Vec<OsString>;

    /// What a hook says, from the arguments after `hook <id>` and the
    /// payload on standard input: `None` when nothing the core keeps, `Err`
    /// when it is no payload this agent sends.
    fn event(&self, args: &[String], payload: &[u8]) -> Result<Option<Heard>, String>;

    /// What a hook that asked prints for its agent once the answer came.
    fn reply(&self, args: &[String], payload: &[u8], answer: &Answer) -> Option<String>;
}

/// The agent named `id`.
pub fn find(id: &str) -> Option<&'static dyn Agent> {
    AGENTS.iter().copied().find(|agent| agent.id() == id)
}

const AGENTS: &[&dyn Agent] = &[
    #[cfg(feature = "fixtures")]
    &Fixture,
];

/// The stand-in agent of the tests (`tasktap fixture-agent`). Its payloads
/// are already in the core's words: a `session.event`'s arguments, and a
/// question with `"wait": true` waits.
#[cfg(feature = "fixtures")]
struct Fixture;

#[cfg(feature = "fixtures")]
impl Fixture {
    fn said(payload: &[u8]) -> Result<(bool, SessionEvent), String> {
        let mut said: serde_json::Value =
            serde_json::from_slice(payload).map_err(|e| e.to_string())?;
        let wait = (said.as_object_mut())
            .and_then(|fields| fields.remove("wait"))
            .is_some_and(|wait| wait == true);
        Ok((
            wait,
            serde_json::from_value(said).map_err(|e| e.to_string())?,
        ))
    }
}

#[cfg(feature = "fixtures")]
impl Agent for Fixture {
    fn id(&self) -> &'static str {
        "fixture"
    }

    fn attach(&self, exe: &Path) -> Vec<OsString> {
        vec!["--hook".into(), exe.into()]
    }

    fn event(&self, _: &[String], payload: &[u8]) -> Result<Option<Heard>, String> {
        use tasktap_proto::Event;
        match Self::said(payload)? {
            (false, event) => Ok(Some(Heard::Event(event))),
            (
                true,
                SessionEvent {
                    event: Event::Question { question },
                    ..
                },
            ) => Ok(Some(Heard::Wait(question))),
            (true, _) => Err("only a question waits".into()),
        }
    }

    fn reply(&self, _: &[String], payload: &[u8], answer: &Answer) -> Option<String> {
        use tasktap_proto::{Event, QuestionKind};
        let choices = match Self::said(payload).ok()?.1.event {
            Event::Question { question } => match question.kind {
                QuestionKind::Choice { choices } => choices,
                _ => Vec::new(),
            },
            _ => Vec::new(),
        };
        Some(crate::roles::said(answer, &choices))
    }
}
