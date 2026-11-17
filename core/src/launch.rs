//! The launcher (design §7, §14 C): the state machine's `Launch`, `Deliver`
//! and `Kill` effects carried out with real terminals. An agent runs as the
//! direct child of its own terminal, with no shell underneath that could run
//! what is typed into it, and its session's token in its environment. The
//! command line is its adapter's, with what its probe added when it has one
//! (`effects.rs` runs that off the core's thread); starting and stopping is
//! the terminal layer's. What it did goes back to the state machine as
//! `Launched` or `LaunchFailed` (`effects.rs`), and the end of its process as
//! `Exited`.

use std::path::Path;

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
const INDIRECT: &str =
    "the agent is not its terminal's direct child, so the follow-up was not typed";

/// A run's command line, its program found, and the check it needs before
/// it starts, if any.
pub struct Prepared {
    agent: &'static dyn Agent,
    argv: Vec<String>,
    pub probe: Option<Probe>,
}

/// The command line of a run, with its program found on the PATH its
/// terminal will have; a program that is not there fails the launch before
/// anything starts. A check the agent needs is left to the caller, which
/// runs it off the core's thread and adds what it says (`start`).
pub fn prepare(l: &Launch) -> Result<Prepared, String> {
    let agent =
        agents::find(&l.agent).ok_or_else(|| format!("this build cannot run {}", l.agent))?;
    let hook = crate::roles::program().map_err(|e| format!("the core cannot find itself: {e}"))?;
    let run = Run {
        session: l.session,
        cwd: Path::new(&l.cwd),
        prompt: &l.prompt,
        model: l.model.as_deref(),
        resume: l.resume.as_deref(),
        hook: &hook,
    };
    let mut argv = agent.launch(&run);
    let name = argv.first().cloned().unwrap_or_default();
    let program = terminal::find(&name)
        .ok_or_else(|| format!("{name} is not installed: no folder of the PATH has it"))?;
    argv[0] = program.to_string_lossy().into_owned();
    let probe = agent.probe(&hook, Path::new(&l.cwd));
    Ok(Prepared { agent, argv, probe })
}

/// Starts a prepared run in a new terminal and returns that terminal, which
/// the caller stores in the same step, before anything else runs (design
/// §3). `more` are the arguments its check added, which follow the
/// program. It takes the session's id, as the session takes the attempt's,
/// so one attempt never starts two. A failure leaves nothing running.
pub fn start(
    core: &mut Core,
    l: &Launch,
    prepared: Prepared,
    more: Vec<String>,
    token: &Secret,
) -> Result<Terminal, String> {
    let Prepared {
        agent, mut argv, ..
    } = prepared;
    argv.splice(1..1, more);
    let id = TerminalId::try_from(l.session.uuid()).map_err(|e| e.to_string())?;
    let (known, project) = effects::read(core, |tx| Ok((tx.terminal(id)?, tx.project(l.project)?)))
        .map_err(|e| e.to_string())?;
    if known.is_some() {
        return Err("this run's terminal was started before".into());
    }
    if !project.is_some_and(|p| p.open) {
        return Err("the project is closed".into());
    }
    let t = Terminal {
        id,
        rev: Rev::ZERO,
        project_id: Some(l.project),
        kind: TerminalKind::Agent,
        title: agent.id().into(),
        cwd: l.cwd.clone(),
        argv,
        cols: 80,
        rows: 24,
        state: TerminalState::Running,
        exit: None,
        offset: Offset::ZERO,
    };
    terminal::spawn(core, &t, token).map_err(|e| format!("cannot open a terminal: {e}"))?;
    Ok(t)
}

/// Types a follow-up into its session's terminal as a bracketed paste and
/// Enter (design §7), only where no shell can run it: the terminal's direct
/// child is the agent this core launched and has not exited, or the shim of
/// an agent adopted in a shell holds that shell (`held`). Otherwise nothing
/// is typed and the reason is the thought's.
pub fn deliver(core: &mut Core, d: &Deliver, held: bool) -> Result<(), String> {
    let found = effects::read(core, |tx| {
        let s = tx.session(d.session)?;
        let t = s.as_ref().and_then(|s| s.terminal_id);
        Ok((s, t.map(|t| tx.terminal(t)).transpose()?.flatten()))
    });
    let (Some(s), Some(t)) = found.map_err(|e| e.to_string())? else {
        return Err(EXITED.into());
    };
    match (s.adopted, held, t.kind) {
        (true, false, _) => Err(UNHELD.into()),
        (false, _, kind) if kind != TerminalKind::Agent => Err(INDIRECT.into()),
        _ if s.state == SessionState::Ended || !terminal::paste(core, t.id, &d.text) => {
            Err(EXITED.into())
        }
        _ => Ok(()),
    }
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
