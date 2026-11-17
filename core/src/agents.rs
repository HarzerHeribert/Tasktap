//! The agents the core knows (design §7): how a run of each starts, what its
//! hooks say in the core's one vocabulary, and what a hook that waited
//! prints for its agent. The hook half runs in `tasktap hook`, so a payload
//! the core would not understand never reaches it; the launcher reads the
//! rest. Package D adds detection and the adapters of Claude Code and Codex.

use std::ffi::OsString;
use std::path::Path;

use tasktap_proto::{Answer, Ask, SessionEvent, SessionId};

/// What one hook says.
pub enum Heard {
    /// Reported, and the hook exits.
    Event(SessionEvent),
    /// Asked through the core: the agent lets this hook decide, so it waits
    /// for the answer and prints [`Agent::reply`].
    Wait(Ask),
}

/// What an agent's runs can do, read where the core decides.
#[derive(Clone, Copy, Debug)]
pub struct Caps {
    /// Its runs report through hooks. One that does not finishes its work
    /// by exiting 0 (design §5, `exited`).
    pub events: bool,
}

/// A new run, as the launcher starts it.
pub struct Run<'a> {
    pub session: SessionId,
    /// The folder it runs in.
    pub cwd: &'a Path,
    pub prompt: &'a str,
    pub model: Option<&'a str>,
    /// The agent's handle of the conversation this run continues.
    pub resume: Option<&'a str>,
    /// This program, which the hooks run as `<hook> hook <id>`.
    pub hook: &'a Path,
}

pub trait Agent: Sync {
    /// Its name: the shim's program name and the `<agent>` of `tasktap hook`.
    fn id(&self) -> &'static str;

    fn caps(&self) -> Caps;

    /// The command line of a run: first the program, a name the launcher
    /// looks up on the PATH of the run's terminal, then its arguments, with
    /// the hooks attached as [`Agent::attach`] does. The core starts it as
    /// the terminal's direct child, with no shell around it.
    fn launch(&self, run: &Run) -> Vec<String>;

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
    &Fixture { events: true },
    #[cfg(feature = "fixtures")]
    &Fixture { events: false },
];

/// The stand-in agent of the tests: the program `fixture-agent`, this
/// binary under that name (design §13). As `fixture` its payloads are
/// already in the core's words: a `session.event`'s arguments, and a
/// question with `"wait": true` waits. As `fixture-silent` it has no hooks
/// and reports only by exiting.
#[cfg(feature = "fixtures")]
struct Fixture {
    events: bool,
}

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
        if self.events {
            "fixture"
        } else {
            "fixture-silent"
        }
    }

    fn caps(&self) -> Caps {
        Caps {
            events: self.events,
        }
    }

    fn launch(&self, run: &Run) -> Vec<String> {
        let hooks = self.events.then(|| self.attach(run.hook));
        let hooks = hooks.into_iter().flatten();
        let mut argv = vec![crate::roles::fixture::PROGRAM.to_owned()];
        argv.extend(hooks.map(|a| a.to_string_lossy().into_owned()));
        argv.push(run.prompt.to_owned());
        argv
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
