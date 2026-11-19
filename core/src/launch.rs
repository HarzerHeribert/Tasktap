//! The launcher (design §7, §14 C): the state machine's `Launch`, `Deliver`
//! and `Kill` effects carried out with real terminals. An agent runs as the
//! direct child of its own terminal, with no shell underneath that could run
//! what is typed into it, and its session's token in its environment. The
//! command line is its adapter's, with what its probe added when it has one
//! (`effects.rs` runs that off the core's thread); starting and stopping is
//! the terminal layer's. What it did goes back to the state machine as
//! `Launched` or `LaunchFailed` (`effects.rs`), and the end of its process as
//! `Exited`.

use std::path::{Path, PathBuf};

use tasktap_proto::{
    Offset, Rev, Secret, SessionState, Terminal, TerminalId, TerminalKind, TerminalState,
};

use crate::agents::{self, Agent, Probe, Run};
use crate::effects;
use crate::serve::Core;
use crate::state::{Deliver, Launch};
use crate::terminal;

const EXITED: &str = "the agent has exited, so the follow-up was not typed";
const UNHELD: &str = "no shim holds the agent's shell, so the follow-up was not typed";
const BACKGROUND: &str =
    "the shim that holds the shell does not have its terminal, so the follow-up was not typed";

/// The shim that holds an adopted agent's shell for a follow-up: the
/// process at the other end of its connection, as the system names it.
pub struct Holder(pub Option<u32>);
const INDIRECT: &str =
    "the agent is not its terminal's direct child, so the follow-up was not typed";

/// A run's command line, and the check it needs before it starts, if any.
pub struct Prepared {
    agent: &'static dyn Agent,
    argv: Vec<String>,
    probe: Option<Probe>,
    /// The agent's folder in the data folder, and the files it reads there.
    home: PathBuf,
    files: Vec<(&'static str, String)>,
    /// Variables the run is given beside its terminal's own.
    env: Vec<(&'static str, String)>,
}

/// The command line of a run. Its program is found, and the check its
/// agent needs is run, off the core's thread (`Prepared::look`); `start`
/// takes what they found. `allowed` is what the person lets agents do
/// beyond their default (the `agent_options` preference).
pub fn prepare(l: &Launch, data: &Path, allowed: &[String]) -> Result<Prepared, String> {
    let agent =
        agents::find(&l.agent).ok_or_else(|| format!("this build cannot run {}", l.agent))?;
    let hook =
        crate::roles::program().map_err(|e| format!("Tasktap cannot find its own program: {e}"))?;
    let home = agents::home(data, agent);
    let run = Run {
        session: l.session,
        cwd: Path::new(&l.cwd),
        prompt: &l.prompt,
        words: l.words.as_deref(),
        model: l.model.as_deref(),
        resume: l.resume.as_deref(),
        hook: &hook,
        home: &home,
        allowed,
    };
    let argv = agent.launch(&run);
    let probe = agent.probe(&hook, Path::new(&l.cwd));
    let (files, env) = (agent.files(&hook), agent.environment(&hook, &home));
    Ok(Prepared {
        agent,
        argv,
        probe,
        home,
        files,
        env,
    })
}

impl Prepared {
    /// What finds the run's program on the PATH its terminal will have
    /// and then runs its check, if it has one, on a thread that may block:
    /// the program, and the arguments the check adds. A program that is not
    /// there fails the launch before anything starts.
    pub fn look(
        &mut self,
        l: &Launch,
    ) -> impl FnOnce() -> Result<(PathBuf, Vec<String>), String> + Send + 'static {
        let name = self.argv.first().cloned().unwrap_or_default();
        let (probe, cwd) = (self.probe.take(), PathBuf::from(&l.cwd));
        let (home, files) = (self.home.clone(), std::mem::take(&mut self.files));
        move || {
            // The files its hooks are read from, before anything reads them.
            agents::checks::keep(&home, &files)?;
            let program = terminal::find(&name)
                .ok_or_else(|| format!("{name} is not installed: no folder of the PATH has it"))?;
            let more = match probe {
                Some(probe) => agents::checks::probe(probe, &cwd)?,
                None => Vec::new(),
            };
            Ok((program, more))
        }
    }
}

/// Starts a prepared run in a new terminal and returns that terminal, which
/// the caller stores in the same step, before anything else runs (design
/// §3). `program` is where its program was found, and `more` are the
/// arguments its check added, which follow the program. It takes the
/// session's id, as the session takes the attempt's, so one attempt never
/// starts two. A failure leaves nothing running.
pub fn start(
    core: &mut Core,
    l: &Launch,
    prepared: Prepared,
    program: PathBuf,
    more: Vec<String>,
    token: &Secret,
) -> Result<Terminal, String> {
    let Prepared {
        agent,
        mut argv,
        env,
        ..
    } = prepared;
    argv[0] = program.to_string_lossy().into_owned();
    argv.splice(1..1, more);
    let id = TerminalId::try_from(l.session.uuid()).map_err(|e| e.to_string())?;
    let (known, project) = effects::read(core, |tx| Ok((tx.terminal(id)?, tx.project(l.project)?)))
        .map_err(|e| e.to_string())?;
    if known.is_some() {
        return Err("this run's terminal was started before".into());
    }
    if !project.is_some_and(|p| p.open) {
        return Err("the folder is closed".into());
    }
    let t = Terminal {
        id,
        rev: Rev::ZERO,
        project_id: Some(l.project),
        kind: TerminalKind::Agent,
        // What the person types to start it; what they called one of their own.
        title: if agent.own() {
            agent.name()
        } else {
            agent.id()
        }
        .into(),
        cwd: l.cwd.clone(),
        argv,
        cols: 80,
        rows: 24,
        state: TerminalState::Running,
        exit: None,
        offset: Offset::ZERO,
    };
    let env = env
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.into()));
    terminal::spawn_with(core, &t, token, env.collect())
        .map_err(|e| format!("cannot open a terminal: {e}"))?;
    if let Some(watch) = agents::Watch::new(agent.prompts()) {
        terminal::watch(core, id, watch);
    }
    Ok(t)
}

/// Types a follow-up into its session's terminal as a bracketed paste and
/// Enter (design §7), only where no shell can run it: the terminal's direct
/// child is the agent this core launched and has not exited, or the shim of
/// an agent adopted in a shell holds that shell (`held`) and the core sees
/// that shim's group have the terminal's foreground, not the shell's own.
/// Otherwise nothing is typed and the reason is the thought's. What is typed
/// is a follow-up once the input thread has written it.
pub fn deliver(
    core: &mut Core,
    d: &Deliver,
    held: Option<&Holder>,
) -> Result<terminal::Typing, String> {
    let found = effects::read(core, |tx| {
        let s = tx.session(d.session)?;
        let t = s.as_ref().and_then(|s| s.terminal_id);
        Ok((s, t.map(|t| tx.terminal(t)).transpose()?.flatten()))
    });
    let (Some(s), Some(t)) = found.map_err(|e| e.to_string())? else {
        return Err(EXITED.into());
    };
    match (s.adopted, held, t.kind) {
        (true, None, _) => Err(UNHELD.into()),
        (true, Some(Holder(pid)), _) if !terminal::foreground_is(core, t.id, *pid) => {
            Err(BACKGROUND.into())
        }
        (false, _, kind) if kind != TerminalKind::Agent => Err(INDIRECT.into()),
        _ if s.state == SessionState::Ended => Err(EXITED.into()),
        _ => match terminal::paste(core, t.id, &told(&s.agent, d)) {
            None => Err(EXITED.into()),
            Some(Err(why)) => Err(unwritten(why)),
            Some(Ok(typing)) => Ok(typing),
        },
    }
}

/// What a follow-up types: its brief, with the person's own words as the
/// session's agent takes them when the brief says them differently.
fn told(agent: &str, d: &Deliver) -> String {
    match (&d.words, agents::find(agent)) {
        (Some(words), Some(agent)) => agent.told(&d.text, words),
        _ => d.text.clone(),
    }
}

/// Why a follow-up handed to the input thread was not written.
pub fn unwritten(why: String) -> String {
    format!("{why}, so the follow-up was not typed")
}

/// Stops a run's terminal. The state machine never names an adopted
/// agent's, which is the person's shell, and a shell is never stopped here.
/// The end is reported when it comes, so this never says it has ended.
pub fn kill(core: &mut Core, id: TerminalId) -> bool {
    let row = effects::read(core, |tx| tx.terminal(id)).ok().flatten();
    if row.is_some_and(|t| t.kind == TerminalKind::Agent) {
        terminal::stop(core, id);
    }
    false
}
