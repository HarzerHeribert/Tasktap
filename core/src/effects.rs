//! The calls with effects (design §5, §14 package 7). Each turns into one
//! state-machine event, applied in one transaction that is committed and
//! published in the same step. The effects the machine returns are then
//! carried out: they go to the router, the launcher, the hold timers, the
//! host and the waiting askers, and what those report comes back as events.
//! The rules stay in `state.rs`; this module only moves things between it
//! and the world.
//!
//! The launcher is `launch.rs`, which starts runs in real terminals, in
//! the worktrees `isolate.rs` makes, keeps and removes on threads of their
//! own; the router is `route.rs`'s local match (the fixture router once
//! `fixture.script` has selected it in a core built with its test
//! fixtures), and with the person's consent the model behind their own
//! agent, asked on a thread of its own with a time limit.
//! The fixture launcher stands in for the real one only where a test
//! scripts what the real one cannot do.

use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tasktap_proto::call::{self, Call, Code, Error};
use tasktap_proto::{
    AttemptId, CallId, Change, Offset, Outcome, PrefKey, PrefValue, QuestionId, RouteBy, Routing,
    Secret, SessionEvent, SessionId, Settle, TerminalId, TerminalState, Thought, ThoughtId, Time,
    Workdir,
};
use tokio::task::AbortHandle;

use crate::agents::checks::{self, Asked, Failed};
use crate::calls::{Caller, Cx};
use crate::conn::Link;
use crate::isolate::{Git, Owner};
use crate::serve::Core;
use crate::state::{
    self, Deliver, Destination, Effect, Event, Launch, Launcher, Report, Route, Router, Worktree,
};
use crate::store::{self, AttemptOutcome, Tx};
use crate::{agents, questions};

/// Characters of a thought's first line that title what Keep commits.
const TITLE: usize = 72;

/// Why an event was not applied.
#[derive(Debug)]
pub enum Refusal {
    State(state::Error),
}

impl From<state::Error> for Refusal {
    fn from(e: state::Error) -> Self {
        Refusal::State(e)
    }
}

impl From<store::Error> for Refusal {
    fn from(e: store::Error) -> Self {
        Refusal::State(state::Error::Store(e))
    }
}

/// The one mapping from a refusal to the protocol's error codes. `None`
/// answers the call as if it succeeded.
///
/// | Refusal | Code |
/// | --- | --- |
/// | the same event, capture, attempt or question again | none: a repeat answers like the first |
/// | an event that does not fit the current state | `conflict`; `session.event` answers none |
/// | an agent's event the guards drop (old token, sub-agent, other turn) | none |
/// | the record named does not exist, or the question is settled | `gone` |
/// | an id or request key reused with other content; something must happen first | `conflict` |
/// | a value the transition refuses; an answer that does not fit its question | `invalid` |
/// | the store failed | `failed`; `gone` for a missing row, `conflict` for a duplicate |
/// | git refused a keep or a discard, or could not run | `failed`, saying why and what the person can do |
///
/// What the launcher reports as a failure, and an attempt the core stopped
/// during, reach a call as its attempt's outcome: `failed` too.
pub fn refusal(call: &str, r: Refusal) -> Option<Error> {
    use state::{Error as E, Ignored};
    let (code, message) = match r {
        Refusal::State(E::Ignored(Ignored::State)) => (
            Code::Conflict,
            format!("{call} does not fit the current state"),
        ),
        Refusal::State(E::Ignored(_)) => return None,
        Refusal::State(E::Gone) => (
            Code::Gone,
            format!("{call}: no such record, or it is settled"),
        ),
        Refusal::State(E::Conflict(why)) => (Code::Conflict, why.into()),
        Refusal::State(E::Invalid(why)) => (Code::Invalid, why.into()),
        Refusal::State(E::Store(e)) => return Some(stored(e)),
    };
    Some(Error::new(code, message))
}

pub fn stored(e: store::Error) -> Error {
    let code = match e {
        store::Error::NotFound | store::Error::Reference => Code::Gone,
        store::Error::Duplicate(_) => Code::Conflict,
        store::Error::TooLarge(_) => Code::Invalid,
        _ => Code::Failed,
    };
    Error::new(code, e.to_string())
}

/// The clock, the hold timers and the router, and in a fixtures build the
/// fixture router, launcher and host.
#[derive(Default)]
pub struct Seams {
    /// One one-shot timer per held thought; nothing else is ever armed here
    /// but `prune`.
    timers: HashMap<ThoughtId, Timer>,
    /// The one-shot timer of the next pruning, a day after the last one;
    /// none while finished thoughts are kept for ever (`keep`). It keeps
    /// no core alive: one that idles out prunes when it next starts.
    prune: Option<Timer>,
    /// The core is shutting down: no hold is armed or ends any more.
    closing: bool,
    /// Set by `fixture.clock`: the time stands still until it is called again.
    #[cfg(feature = "fixtures")]
    clock: Option<Time>,
    #[cfg(feature = "fixtures")]
    fixture: Option<Fixture>,
    /// Git work running on its own threads (`isolate.rs`).
    git: usize,
    /// The `thought.settle` calls waiting for their attempt's git work.
    settling: HashMap<AttemptId, Vec<(Rc<Link>, CallId)>>,
    /// The thoughts a model is being asked about, each with the number of
    /// its question and what stops its tool (design §8).
    routes: HashMap<ThoughtId, (u64, mpsc::Sender<Asked>)>,
    /// Questions asked so far: a later one for the same thought is another.
    asked: u64,
    /// The agents whose tool said it no longer offers the model it is
    /// asked for: none is asked again while this core runs.
    gone: Vec<&'static str>,
}

struct Timer {
    /// Only `fixture.clock` looks again at when a timer ends.
    #[cfg_attr(not(feature = "fixtures"), expect(dead_code))]
    until: Time,
    /// The sleeping task on the wall clock; none while `fixture.clock` holds the time.
    task: Option<AbortHandle>,
}

#[cfg(feature = "fixtures")]
struct Fixture {
    router: state::FixtureRouter,
    launcher: state::FixtureLauncher,
    /// Runs start for real, and new captures name this agent.
    agent: Option<String>,
    notified: Vec<QuestionId>,
}

impl Seams {
    /// Whether a hold timer is armed, git work runs or a model is asked
    /// about a thought, each of which would be lost with the core.
    pub fn holding(&self) -> bool {
        !self.timers.is_empty() || self.git > 0 || !self.routes.is_empty()
    }

    pub fn now(&self) -> Time {
        self.manual().unwrap_or_else(wall)
    }

    /// Whether the agent's tool was found not to offer its model any more.
    pub fn gone(&self, agent: &str) -> bool {
        self.gone.contains(&agent)
    }

    /// The agent `fixture.script` has new captures name, in a fixtures build.
    pub fn agent(&self) -> Option<String> {
        #[cfg(feature = "fixtures")]
        if let Some(agent) = self.fixture.as_ref().and_then(|f| f.agent.clone()) {
            return Some(agent);
        }
        None
    }

    #[cfg(feature = "fixtures")]
    fn manual(&self) -> Option<Time> {
        self.clock
    }

    #[cfg(not(feature = "fixtures"))]
    fn manual(&self) -> Option<Time> {
        None
    }

    /// The local router's answer, or the fixture router's once
    /// `fixture.script` selected it.
    fn route(&mut self, request: &crate::route::Request) -> state::Route {
        #[cfg(feature = "fixtures")]
        if let Some(f) = self.fixture.as_mut() {
            return f.router.route(request);
        }
        crate::route::Local.route(request)
    }

    /// Whether the router's answer settles where the thought goes: the
    /// names it says decide, or the fixture router answered.
    fn sure(&self, request: &crate::route::Request) -> bool {
        #[cfg(feature = "fixtures")]
        if self.fixture.is_some() {
            return true;
        }
        crate::route::sure(request)
    }

    /// The fixture launcher, where it stands in for the real one.
    #[cfg(feature = "fixtures")]
    fn launcher(&mut self) -> Option<&mut dyn Launcher> {
        let f = self.fixture.as_mut().filter(|f| f.agent.is_none())?;
        Some(&mut f.launcher)
    }

    #[cfg(not(feature = "fixtures"))]
    fn launcher(&mut self) -> Option<&mut dyn Launcher> {
        None
    }
}

/// The system's clock, which the core reads unless `fixture.clock` holds it.
pub fn wall() -> Time {
    let since = SystemTime::now().duration_since(UNIX_EPOCH);
    Time::new(since.map_or(0, |d| d.as_millis() as u64)).unwrap_or(Time::ZERO)
}

/// Applies one event and carries out its effects. Returns the outcome a
/// call that starts something replies with: that of its attempt.
pub fn run(core: &mut Core, event: Event) -> Result<Option<Outcome>, Refusal> {
    let effects = commit(core, event, |_| Ok(()))?;
    Ok(carry(core, effects))
}

/// A device's call that is one event: it answers as the event went, or
/// with the outcome of what the event started.
pub fn call(core: &mut Core, name: &str, event: Event) -> Result<(), Error> {
    match run(core, event) {
        Ok(Some(Outcome::Err(e))) => Err(e),
        Ok(_) => Ok(()),
        Err(r) => refusal(name, r).map_or(Ok(()), Err),
    }
}

/// `session.event`: the session is the one running in the caller's
/// terminal, never one the arguments name.
pub fn session_event(cx: &mut Cx, args: SessionEvent) -> Result<(), Error> {
    let Caller::Session(terminal) = cx.who else {
        return Err(Error::new(
            Code::Denied,
            "session.event needs a session token",
        ));
    };
    let session = questions::session(cx.core, terminal)?;
    // Ready, the agent shows nothing more to wait on before it is.
    if args.event == tasktap_proto::Event::Ready {
        crate::terminal::unwatch(cx.core, terminal);
    }
    let report = Report {
        session: session.id,
        terminal,
        id: args.id,
        turn: args.turn,
        subagent: args.subagent,
        resume: args.resume,
        event: args.event,
    };
    match run(cx.core, Event::Report(report)) {
        // What the guards drop is dropped; the agent can do nothing about it.
        Ok(_) | Err(Refusal::State(state::Error::Ignored(_))) => Ok(()),
        Err(r) => refusal("session.event", r).map_or(Ok(()), Err),
    }
}

/// Applies one event in one transaction, after `first` wrote what must be
/// stored with it, and publishes what it committed in the same step.
fn commit(
    core: &mut Core,
    event: Event,
    first: impl FnOnce(&mut Tx) -> store::Result<()>,
) -> Result<Vec<Effect>, Refusal> {
    let now = core.seams.now();
    let mut tx = core.store.begin()?;
    first(&mut tx)?;
    let effects = state::apply(&mut tx, now, event)?;
    let change = tx.commit()?;
    published(core, change);
    Ok(effects)
}

/// Commits writes no event carries (a project, a receipt) and publishes them
/// like an event's.
pub fn write<T>(core: &mut Core, f: impl FnOnce(&mut Tx) -> Result<T, Error>) -> Result<T, Error> {
    let mut tx = core.store.begin().map_err(stored)?;
    let value = f(&mut tx)?;
    let change = tx.commit().map_err(stored)?;
    published(core, change);
    Ok(value)
}

pub fn read<T>(core: &mut Core, f: impl FnOnce(&Tx) -> store::Result<T>) -> Result<T, Error> {
    let tx = core.store.begin().map_err(stored)?;
    f(&tx).map_err(stored)
}

/// Every commit of a record `glance` counts passes here: the change is
/// published, `glance` follows what it changed, and askers whose question it
/// withdrew stop waiting.
pub fn published(core: &mut Core, change: Option<Change>) {
    let Some(change) = change else {
        return;
    };
    let withdrawn = questions::absorb(core, &change);
    core.publish(Some(change));
    questions::release(core, &withdrawn);
    questions::refresh(core);
}

fn carry(core: &mut Core, effects: Vec<Effect>) -> Option<Outcome> {
    let mut outcome = None;
    for effect in effects {
        let reply = match effect {
            Effect::Route {
                thought,
                current,
                by,
                picked,
            } => {
                route(core, thought, current, by, picked);
                None
            }
            Effect::Unroute(thought) => {
                unroute(core, thought);
                None
            }
            Effect::Hold { thought, until } => {
                arm(core, thought, until);
                None
            }
            Effect::Unhold(thought) => {
                cancel(core, thought);
                None
            }
            Effect::Launch(launch) => self::launch(core, launch),
            Effect::Deliver(deliver) => self::deliver(core, deliver),
            Effect::Kill {
                terminal: Some(terminal),
                ..
            } => {
                kill(core, terminal);
                None
            }
            // The launch's report asks again once it names the terminal.
            Effect::Kill { terminal: None, .. } => None,
            Effect::StopAdopted(session) => {
                crate::shim::stop(core, session);
                None
            }
            Effect::Settle {
                attempt,
                thought,
                keep,
            } => settle(core, attempt, thought, keep),
            Effect::Survey(thought) => {
                survey(core, thought);
                None
            }
            Effect::Tidy { attempt, thought } => {
                tidy(core, attempt, thought);
                None
            }
            Effect::Notify(question) => {
                notify(core, question);
                None
            }
            Effect::Answer(question) => {
                questions::deliver(core, question);
                None
            }
            Effect::Activity { session, text } => {
                // Memory only: a failure loses one line and nothing else.
                let _ = core.add_activity(session, text);
                None
            }
            Effect::Repeat(first) => Some(repeated(first)),
        };
        outcome = reply.or(outcome);
    }
    outcome
}

/// Applies what a seam reported and carries out what follows. Nobody waits
/// on it, so a refusal is dropped: it changed nothing.
fn report(core: &mut Core, event: Event, first: impl FnOnce(&mut Tx) -> store::Result<()>) {
    match commit(core, event, first) {
        Ok(effects) => {
            carry(core, effects);
        }
        Err(Refusal::State(state::Error::Store(e))) => stop(e),
        Err(_) => {}
    }
}

/// What a seam did, or that it did nothing, cannot be stored. Going on would
/// answer as if it had been; exiting leaves the attempt without an outcome,
/// which the next start's recovery closes as interrupted (design §3).
fn stop(why: impl std::fmt::Display) -> ! {
    // Nobody may read stderr any more: a failed write must not stop the exit.
    let what = format!("tasktap: stopping, what was done cannot be stored: {why}\n");
    let _ = std::io::Write::write_all(&mut std::io::stderr(), what.as_bytes());
    std::process::exit(1)
}

/// Asks the router about a thought (design §8). The match on names
/// answers at once, and what it finds it places: a project or session the
/// thought names, the session it was made in, or a question when it names
/// several. With the person's consent `by`, the model behind their agent
/// is asked, off the core's thread, to place a thought the match finds
/// nothing for: its answer is used as `route::accept` allows, and whenever
/// it is not, the match's is, with why. With `picked` (by the person, or by
/// the match for a thought too long to go as it is) only the brief is open,
/// and the fallback is the person's own words.
fn route(
    core: &mut Core,
    id: ThoughtId,
    current: Option<SessionId>,
    by: Option<RouteBy>,
    picked: Option<Destination>,
) {
    use crate::route::{accept, askable, consented, narrow, question, request, short};
    let found = read(core, |tx| {
        let thought = tx.thought(id)?;
        (thought.map(|t| request(tx, &t.text, current))).transpose()
    });
    let Ok(Some(mut asked)) = found else {
        return;
    };
    asked.picked = picked;
    let local = match picked {
        Some(to) => Route::Clear {
            to,
            brief: asked.text.clone(),
            said: None,
        },
        None => core.seams.route(&asked),
    };
    // Sure: the names the thought says decide (or, scripted, the fixture
    // router did). A question the match would ask by the lines about the
    // projects is no reason not to ask a model the person agreed to.
    let sure = match picked {
        Some(_) => short(&asked.text),
        None => !matches!(local, Route::Unknown) && core.seams.sure(&asked),
    };
    let tool = match by.filter(|_| !sure) {
        Some(by) => consented(&by).and_then(|tool| askable(&asked.text).map(|()| tool)),
        None => return routed(core, id, local, state::locally(None), current),
    };
    let narrowed = read(core, |tx| narrow(tx, asked)).map_err(|e| e.message);
    let (agent, how, asked) = match (tool, narrowed) {
        (Ok((agent, _)), _) if core.seams.gone(agent.id()) => {
            let why = crate::route::gone(agent.name());
            return routed(core, id, local, state::locally(Some(why)), current);
        }
        (Ok((agent, how)), Ok(asked)) => (agent, how, asked),
        (Err(why), _) | (_, Err(why)) => {
            return routed(core, id, local, state::locally(Some(why)), current);
        }
    };
    let folder = core.terminals.data().join("route");
    let (hear, heard) = mpsc::channel();
    core.seams.asked += 1;
    let number = core.seams.asked;
    core.seams.routes.insert(id, (number, hear.clone()));
    let (began, model, tool) = (Instant::now(), how.model, agent.name());
    let text = question(&asked);
    let ask = move || {
        checks::ask(
            agent,
            &how,
            text,
            crate::route::SCHEMA,
            &folder,
            (hear, heard),
        )
    };
    crate::calls::aside(core, ask, move |core, answer| {
        // Stopped, or asked anew since: nobody waits for this answer.
        if core.seams.routes.get(&id).map(|(n, _)| *n) != Some(number) {
            return;
        }
        core.seams.routes.remove(&id);
        // The last question may have kept the core alive.
        core.events.notify_one();
        let ms = Some(u32::try_from(began.elapsed().as_millis()).unwrap_or(u32::MAX));
        let lost = || Err(Failed::Why("it ended without an answer".into()));
        let accepted = answer
            .unwrap_or_else(lost)
            .and_then(|answer| Ok(accept(&asked, &answer)?));
        let (route, how) = match accepted {
            Ok((route, found)) => {
                let how = Routing {
                    by: agent.id().into(),
                    model: Some(model.into()),
                    ms,
                    ..found
                };
                (route, how)
            }
            Err(failed) => {
                let why = match failed {
                    Failed::Gone => {
                        core.seams.gone.push(agent.id());
                        crate::route::gone(tool)
                    }
                    Failed::Why(why) => format!("{}: {why}", agent.id()),
                };
                (
                    local,
                    Routing {
                        ms,
                        ..state::locally(Some(why))
                    },
                )
            }
        };
        routed(core, id, route, how, current);
    });
}

fn routed(
    core: &mut Core,
    thought: ThoughtId,
    route: Route,
    how: Routing,
    current: Option<SessionId>,
) {
    let routed = Event::Routed {
        thought,
        route,
        how,
        current,
    };
    report(core, routed, |_| Ok(()));
}

/// Stops the tool that is asked about a thought; its answer is dropped.
fn unroute(core: &mut Core, thought: ThoughtId) {
    if let Some((_, hear)) = core.seams.routes.remove(&thought) {
        let _ = hear.send(Asked::Stop);
        core.events.notify_one();
    }
}

/// Starts a run. Its program is looked up on the PATH, and the check its
/// agent needs before it starts run (design §7, an adapter's probe), on a
/// thread of their own, since a folder of the PATH may be on a stalled
/// mount; the run starts once they have answered, and its outcome then
/// reaches its thought's record and attempt, not the call that started it,
/// which answers at once. What the fixture launcher does, and a run this
/// build cannot prepare, answer the call.
fn launch(core: &mut Core, launch: Launch) -> Option<Outcome> {
    let token = Secret::mint();
    let attempt = launch.attempt;
    if let Some(launcher) = core.seams.launcher() {
        let started = launcher.launch(&launch, &token);
        return Some(launched(core, attempt, started, &token));
    }
    let Some(worktree) = launch.worktree.clone() else {
        return begin(core, launch, token);
    };
    // Its worktree first, which the session then works in.
    let repo = read(core, |tx| tx.project(launch.project)).ok().flatten();
    let Some(repo) = repo.map(|p| PathBuf::from(p.folder)) else {
        return Some(failed(
            core,
            attempt,
            "the folder is no longer in Tasktap".into(),
        ));
    };
    let owner = match &worktree {
        Worktree::New { .. } => launch.thought,
        Worktree::Again { owner, .. } => *owner,
    };
    git(
        core,
        move |git| git.prepare(&repo, &worktree),
        move |core, made| match made {
            Ok(workdir) => {
                let cwd = workdir.path.clone();
                let made = Event::Prepared {
                    attempt,
                    owner,
                    workdir,
                };
                // Recorded before anything runs in it; a worktree no thought
                // records is never run in, and the next start tidies it.
                match commit(core, made, |_| Ok(())) {
                    Ok(effects) => {
                        carry(core, effects);
                        begin(core, Launch { cwd, ..launch }, token);
                    }
                    Err(Refusal::State(state::Error::Store(e))) => stop(e),
                    Err(_) => {
                        let why = "the run's copy could not be recorded";
                        drop(failed(core, attempt, why.into()));
                    }
                }
            }
            Err(e) => drop(failed(core, attempt, e)),
        },
    );
    None
}

/// Starts a run in the folder it names: its command line, then its program
/// found and its check run off the core's thread, then its terminal.
fn begin(core: &mut Core, launch: Launch, token: Secret) -> Option<Outcome> {
    let attempt = launch.attempt;
    let data = core.terminals.data().to_owned();
    let allowed = match read(core, |tx| tx.pref(PrefKey::AgentOptions)) {
        Ok(Some(pref)) => match pref.value {
            PrefValue::AgentOptions(allowed) => allowed,
            _ => Vec::new(),
        },
        _ => Vec::new(),
    };
    let mut prepared = match crate::launch::prepare(&launch, &data, &allowed) {
        Ok(prepared) => prepared,
        Err(error) => return Some(failed(core, attempt, error)),
    };
    let look = prepared.look(&launch);
    crate::calls::aside(core, look, move |core, found| {
        let lost = || "the check before the start ended without an answer".to_owned();
        let found = found.ok_or_else(lost).flatten();
        let started = found.and_then(|(program, more)| {
            crate::launch::start(core, &launch, prepared, program, more, &token)
        });
        launched(core, attempt, started, &token);
    });
    None
}

/// Records a started run's terminal, or why it did not start.
fn launched(
    core: &mut Core,
    attempt: AttemptId,
    started: Result<tasktap_proto::Terminal, String>,
    token: &Secret,
) -> Outcome {
    match started {
        Ok(terminal) => {
            let hash = crate::handshake::hash(token);
            let event = Event::Launched {
                attempt,
                terminal: Some(terminal.id),
            };
            report(core, event, |tx| tx.insert_terminal(&terminal, Some(&hash)));
            Outcome::Ok(Value::Null)
        }
        Err(error) => failed(core, attempt, error),
    }
}

/// A follow-up for an adopted session waits for its shim to hold the
/// terminal, and its outcome reaches the thought's records, not the call.
fn deliver(core: &mut Core, deliver: Deliver) -> Option<Outcome> {
    crate::shim::deliver(core, deliver).map(|deliver| typed(core, deliver, None))
}

/// The shim that holds the terminal for a follow-up, and what runs once the
/// follow-up is written, or will not be: its release.
pub struct Held {
    pub by: crate::launch::Holder,
    pub release: Box<dyn FnOnce(&mut Core)>,
}

/// How long a follow-up its shim holds the terminal for may take to be
/// written. Past it the rest is not typed, and the hold ends once the piece
/// on its way is written, so the shim, which waits for that, never returns
/// to the shell with any of it still to come.
const TYPING: Duration = Duration::from_secs(5);

/// Has the launcher type a follow-up into its session's terminal, `held`
/// with the release of the shim of an adopted session that holds it, and
/// reports how that went: typed once the terminal's input thread has written
/// it, failed when it could not. The release runs only after that. The
/// answer is the call's when it is known at once.
pub fn typed(core: &mut Core, deliver: Deliver, held: Option<Held>) -> Outcome {
    let attempt = deliver.attempt;
    let handed = match core.seams.launcher() {
        Some(launcher) => launcher.deliver(&deliver),
        None => match crate::launch::deliver(core, &deliver, held.as_ref().map(|h| &h.by)) {
            Ok(typing) => {
                let me = core.me.clone();
                tokio::task::spawn_local(async move {
                    let written = written(typing, held.is_some()).await;
                    let Some(core) = me.upgrade() else { return };
                    let mut core = core.borrow_mut();
                    match written {
                        Ok(()) => drop(written_by(&mut core, attempt)),
                        Err(why) => drop(failed(&mut core, attempt, crate::launch::unwritten(why))),
                    }
                    if let Some(held) = held {
                        (held.release)(&mut core);
                    }
                });
                return Outcome::Ok(Value::Null);
            }
            Err(error) => Err(error),
        },
    };
    let outcome = match handed {
        Ok(()) => written_by(core, attempt),
        Err(error) => failed(core, attempt, error),
    };
    if let Some(held) = held {
        (held.release)(core);
    }
    outcome
}

/// Waits until a follow-up is written or will not be; one its shim holds
/// for is given up past [`TYPING`], and still waited for until the input
/// thread says it wrote no more.
async fn written(mut typing: crate::terminal::Typing, held: bool) -> Result<(), String> {
    let gone = |_| "the terminal has ended".to_owned();
    if held {
        match tokio::time::timeout(TYPING, &mut typing.done).await {
            Ok(done) => return done.map_err(gone)?,
            Err(_) => typing
                .cancel
                .store(true, std::sync::atomic::Ordering::SeqCst),
        }
    }
    typing.done.await.map_err(gone)?
}

/// A follow-up was typed.
fn written_by(core: &mut Core, attempt: AttemptId) -> Outcome {
    let event = Event::Launched {
        attempt,
        terminal: None,
    };
    report(core, event, |_| Ok(()));
    Outcome::Ok(Value::Null)
}

pub fn failed(core: &mut Core, attempt: AttemptId, error: String) -> Outcome {
    let event = Event::LaunchFailed {
        attempt,
        error: error.clone(),
    };
    report(core, event, |_| Ok(()));
    Outcome::Err(Error::new(Code::Failed, error))
}

fn kill(core: &mut Core, terminal: TerminalId) {
    let gone = match core.seams.launcher() {
        Some(launcher) => launcher.kill(terminal),
        None => crate::launch::kill(core, terminal),
    };
    if gone {
        ended(core, terminal, None, None);
        exited(core, terminal, None);
    }
}

/// A terminal ended: its row records it, with the offset its output ended
/// at when known.
pub(crate) fn ended(core: &mut Core, terminal: TerminalId, code: Option<u32>, end: Option<Offset>) {
    let written = write(core, |tx| {
        if let Some(mut t) = tx.terminal(terminal).map_err(stored)? {
            t.state = TerminalState::Exited;
            t.exit = code;
            t.offset = end.unwrap_or(t.offset);
            tx.update_terminal(&t).map_err(stored)?;
        }
        Ok(())
    });
    written.unwrap_or_else(|e| stop(e));
}

/// A terminal shows what its agent waits on there before it is ready: the
/// session running in it asks the person to answer there.
pub(crate) fn shown(core: &mut Core, terminal: TerminalId, prompt: &str) {
    let session = read(core, |tx| tx.terminal_session(terminal));
    if let Some(s) = session.unwrap_or_else(|e| stop(e)) {
        let prompt = prompt.to_owned();
        report(
            core,
            Event::Shown {
                session: s.id,
                prompt,
            },
            |_| Ok(()),
        );
    }
}

/// The direct child of a terminal exited: the session still running in it
/// ends, silent when its agent reports only by exiting (design §5).
pub(crate) fn exited(core: &mut Core, terminal: TerminalId, code: Option<u32>) {
    let session = read(core, |tx| tx.terminal_session(terminal));
    if let Some(s) = session.unwrap_or_else(|e| stop(e)) {
        let quiet = agents::find(&s.agent).is_some_and(|agent| !agent.caps().events);
        let event = Event::Exited {
            session: s.id,
            code,
            // An adopted agent's exit is its shim's report; the shell's is not it.
            silent: quiet && !s.adopted,
        };
        report(core, event, |_| Ok(()));
    }
}

/// `thought.settle`: answered once its git work has, which takes as long
/// as the repository needs. A repeat while it runs is `conflict`, as for
/// any attempt without an outcome; the same attempt afterwards answers as
/// the first did.
pub fn settle_call(cx: &mut Cx, args: Value) -> Option<tasktap_proto::Control> {
    let reply = |result| Some(call::ThoughtSettle::reply(cx.id, result));
    let s: Settle = match call::ThoughtSettle::args(args) {
        Ok(s) => s,
        Err(e) => return reply(Err(e)),
    };
    let event = Event::Settle {
        thought: s.id,
        attempt: s.attempt,
        keep: s.keep,
    };
    match run(cx.core, event) {
        Ok(Some(Outcome::Err(e))) => reply(Err(e)),
        Ok(Some(_)) => reply(Ok(())),
        // Its git work runs: the reply waits for it.
        Ok(None) => {
            let waiting = cx.core.seams.settling.entry(s.attempt).or_default();
            waiting.push((cx.link.clone(), cx.id));
            None
        }
        Err(r) => reply(refusal("thought.settle", r).map_or(Ok(()), Err)),
    }
}

/// Keeps or discards a thought's worktree (`isolate.rs`) off the core's
/// thread; the fixture launcher's settle where it stands in, at once.
fn settle(core: &mut Core, attempt: AttemptId, thought: ThoughtId, keep: bool) -> Option<Outcome> {
    if let Some(launcher) = core.seams.launcher() {
        let done = launcher.settle(thought, keep).map(|()| keep);
        return Some(settled(core, attempt, done));
    }
    let Some((repo, workdir, title)) = worktree_of(core, thought) else {
        let gone = "the thought's copy is gone".to_owned();
        return Some(settled(core, attempt, Err(gone)));
    };
    // A discard that finds all of it kept already reports it kept.
    let work = move |git: &Git| match keep {
        true => git.keep(&repo, &workdir, &title).map(|()| true),
        false => git.discard(&repo, &workdir),
    };
    git(core, work, move |core, done| {
        let outcome = settled(core, attempt, done);
        let reply = match outcome {
            Outcome::Ok(_) => Ok(()),
            Outcome::Err(e) => Err(e),
        };
        for (link, id) in core.seams.settling.remove(&attempt).unwrap_or_default() {
            link.send(&call::ThoughtSettle::reply(id, reply.clone()));
        }
    });
    None
}

/// Records how a settle or a tidy went (whether it kept, or why it did
/// not happen), and returns it as a call's outcome.
fn settled(core: &mut Core, attempt: AttemptId, done: Result<bool, String>) -> Outcome {
    let error = done.as_ref().err().cloned();
    let event = Event::Settled {
        attempt,
        kept: done.unwrap_or(false),
        error: error.clone(),
    };
    report(core, event, |_| Ok(()));
    match error {
        None => Outcome::Ok(Value::Null),
        Some(why) => Outcome::Err(Error::new(Code::Failed, why)),
    }
}

/// Looks at a thought's worktree off the core's thread.
fn survey(core: &mut Core, thought: ThoughtId) {
    let Some((repo, workdir, _)) = worktree_of(core, thought) else {
        return;
    };
    let path = workdir.path.clone();
    git(
        core,
        move |git| git.survey(&repo, &workdir),
        move |core, found| {
            // A look that failed changes nothing: the next one may do better.
            if let Ok(found) = found {
                report(
                    core,
                    Event::Surveyed {
                        thought,
                        path,
                        found,
                    },
                    |_| Ok(()),
                );
            }
        },
    );
}

/// Removes a thought's worktree off the core's thread if nothing would be
/// lost, and otherwise records the changes it found there.
fn tidy(core: &mut Core, attempt: AttemptId, thought: ThoughtId) {
    let Some((repo, workdir, _)) = worktree_of(core, thought) else {
        let gone = "the thought's copy is gone".to_owned();
        drop(settled(core, attempt, Err(gone)));
        return;
    };
    let path = workdir.path.clone();
    git(
        core,
        move |git| git.tidy(&repo, &workdir),
        move |core, done| {
            let (done, found) = match done {
                Ok(None) => (Ok(false), None),
                Ok(Some(found)) => (Err("it holds something, so it stays".into()), Some(found)),
                Err(e) => (Err(e), None),
            };
            drop(settled(core, attempt, done));
            // Once the tidy has ended, what it found counts.
            if let Some(found) = found {
                report(
                    core,
                    Event::Surveyed {
                        thought,
                        path,
                        found,
                    },
                    |_| Ok(()),
                );
            }
        },
    );
}

/// A thought's worktree, its project's folder, and the title what Keep
/// commits gets: the first line of its brief, or of its text.
fn worktree_of(core: &mut Core, thought: ThoughtId) -> Option<(PathBuf, Workdir, String)> {
    let found = read(core, |tx| {
        let Some(t) = tx.thought(thought)? else {
            return Ok(None);
        };
        let project = t.project_id.map(|p| tx.project(p)).transpose()?.flatten();
        Ok(project.map(|p| (t, p.folder)))
    });
    let (t, folder) = found.ok().flatten()?;
    let title = title(&t);
    Some((PathBuf::from(folder), t.workdir?, title))
}

fn title(t: &Thought) -> String {
    let text = t.brief.as_deref().unwrap_or(&t.text);
    let line = text.lines().map(str::trim).find(|l| !l.is_empty());
    let line: String = line.unwrap_or("Changes").chars().take(TITLE).collect();
    line
}

/// Runs git work on a thread of its own and `then` on the core's thread
/// with what it returned. The core stays while any runs, so a keep is not
/// cut short by the core idling out.
fn git<T: Send + 'static>(
    core: &mut Core,
    work: impl FnOnce(&Git) -> Result<T, String> + Send + 'static,
    then: impl FnOnce(&mut Core, Result<T, String>) + 'static,
) {
    let data = core.terminals.data().to_owned();
    let sessions = core.terminals.sessions();
    let work = move || Git::new(&data, sessions).and_then(|git| work(&git));
    job(core, work, then);
}

/// Runs `work` on a thread of its own, counted while it runs, and `then`
/// on the core's thread with what it returned.
fn job<T: Send + 'static>(
    core: &mut Core,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
    then: impl FnOnce(&mut Core, Result<T, String>) + 'static,
) {
    core.seams.git += 1;
    crate::calls::aside(core, work, move |core, done| {
        core.seams.git -= 1;
        core.events.notify_one();
        let lost = || Err("the git work ended without an answer".to_owned());
        then(core, done.unwrap_or_else(lost));
    });
}

/// At start, off the core's thread (design §3): the worktrees of the
/// thoughts not settled are looked at, which also decides a settle the core
/// stopped during and has what holds nothing tidied; a worktree a launch
/// made and never recorded goes when git agrees nothing is in it. Only what
/// was there before any launch of this run of the core is looked at, since
/// none has started yet.
pub fn sweep(core: &mut Core) {
    let owners = read(core, |tx| {
        let mut owners = Vec::new();
        for t in tx.worktrees()? {
            let project = t.project_id.map(|p| tx.project(p)).transpose()?.flatten();
            if let (Some(p), Some(workdir)) = (project, t.workdir) {
                owners.push(Owner {
                    thought: t.id,
                    repo: PathBuf::from(p.folder),
                    workdir,
                });
            }
        }
        Ok(owners)
    });
    let owners = owners.unwrap_or_else(|e| stop(e));
    let data = core.terminals.data().to_owned();
    let there: Vec<_> = std::fs::read_dir(data.join(crate::isolate::FOLDER))
        .map(|entries| entries.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    if owners.is_empty() && there.is_empty() {
        return;
    }
    // The names the launches of this store gave worktrees: a folder with
    // one is a worktree this core made.
    let launched = read(core, |tx| tx.launch_names()).unwrap_or_else(|e| stop(e));
    job(
        core,
        move || Ok(crate::isolate::sweep(&data, &owners, &there, &launched)),
        |core, found| {
            for (thought, path, found) in found.unwrap_or_default() {
                report(
                    core,
                    Event::Surveyed {
                        thought,
                        path,
                        found,
                    },
                    |_| Ok(()),
                );
            }
        },
    );
}

/// A repeated attempt answers with the outcome of its first call.
fn repeated(first: Option<AttemptOutcome>) -> Outcome {
    match first {
        Some(AttemptOutcome::Reply(reply)) => reply,
        Some(AttemptOutcome::Interrupted) => Outcome::Err(Error::new(
            Code::Failed,
            "Tasktap stopped during this attempt; nothing was started again",
        )),
        // A launch whose check still runs; every other reports before its call returns.
        None => Outcome::Err(Error::new(
            Code::Conflict,
            "the attempt has not finished yet",
        )),
    }
}

/// Tells the person a question opened: `host.notify` on the connected host
/// (Phase 4). With no host connected, always so before then, there is
/// nobody to tell; the fixtures note it.
#[cfg_attr(not(feature = "fixtures"), expect(unused_variables))]
fn notify(core: &mut Core, question: QuestionId) {
    #[cfg(feature = "fixtures")]
    if let Some(f) = &mut core.seams.fixture {
        f.notified.push(question);
    }
}

/// Arms the hold timer of a thought, replacing any it had. A hold that has
/// already ended ends now. Not while the core shuts down (`close`).
fn arm(core: &mut Core, thought: ThoughtId, until: Time) {
    cancel(core, thought);
    if core.seams.closing {
        return;
    }
    let now = core.seams.now();
    if until <= now {
        return fire(core, thought, until);
    }
    let task = core.seams.manual().is_none().then(|| {
        let me = core.me.clone();
        let wait = Duration::from_millis(until.get() - now.get());
        let task = tokio::task::spawn_local(async move {
            tokio::time::sleep(wait).await;
            if let Some(core) = me.upgrade() {
                fire(&mut core.borrow_mut(), thought, until);
            }
        });
        task.abort_handle()
    });
    core.seams.timers.insert(thought, Timer { until, task });
}

fn cancel(core: &mut Core, thought: ThoughtId) {
    if let Some(Timer {
        task: Some(task), ..
    }) = core.seams.timers.remove(&thought)
    {
        task.abort();
    }
}

fn fire(core: &mut Core, thought: ThoughtId, until: Time) {
    core.seams.timers.remove(&thought);
    if core.seams.closing {
        return;
    }
    // The last hold may have kept the core alive.
    core.events.notify_one();
    // The timer counts on a steady clock; when the wall clock lags it, the rest is slept.
    if core.seams.now() < until {
        return arm(core, thought, until);
    }
    let attempt = state::fresh(core.seams.now()).unwrap_or_else(|e| stop(e));
    report(core, Event::HoldEnded { thought, attempt }, |_| Ok(()));
}

/// Days finished thoughts are kept: the `keep_days` preference, 0 for ever.
fn kept(core: &mut Core) -> u16 {
    match read(core, |tx| tx.pref(PrefKey::KeepDays)) {
        Ok(Some(tasktap_proto::Pref {
            value: PrefValue::KeepDays(days),
            ..
        })) => days,
        _ => 0,
    }
}

/// Carries out the `keep_days` preference (design §5, row "pruned"): what
/// is older goes once as the core starts and then once a day while it
/// runs, by a one-shot timer armed anew after each pruning. With the
/// preference at for ever nothing is armed. A change of the preference
/// removes nothing in that moment, so a number half typed deletes nothing:
/// it takes effect at the next pruning, a day on where none was due.
pub fn keep(core: &mut Core, start: bool) {
    if kept(core) == 0 {
        if let Some(Timer {
            task: Some(task), ..
        }) = core.seams.prune.take()
        {
            task.abort();
        }
        core.seams.prune = None;
    } else if start {
        prune(core);
    } else if core.seams.prune.is_none() {
        arm_prune(core);
    }
}

/// One pruning, in bounded steps (`state::prune`): each is one transaction,
/// and the next waits until whatever else wants the core's thread had its
/// turn. Then the timer of the next pruning is armed.
fn prune(core: &mut Core) {
    core.seams.prune = None;
    loop {
        if core.seams.closing {
            return;
        }
        let (now, days) = (core.seams.now(), kept(core));
        let step = write(core, |tx| state::prune(tx, now, days).map_err(stored));
        // A step the store refused is tried again with the next pruning.
        let pruned = step.unwrap_or_default();
        for &terminal in &pruned.terminals {
            crate::terminal::forget(core, terminal);
        }
        if !pruned.more {
            break;
        }
        if core.seams.manual().is_none() {
            let me = core.me.clone();
            tokio::task::spawn_local(async move {
                tokio::task::yield_now().await;
                if let Some(core) = me.upgrade() {
                    prune(&mut core.borrow_mut());
                }
            });
            return;
        }
    }
    if kept(core) > 0 {
        arm_prune(core);
    }
}

fn arm_prune(core: &mut Core) {
    let day = Duration::from_millis(state::DAY);
    let now = core.seams.now();
    let until = Time::new(now.get() + state::DAY).unwrap_or(now);
    let task = core.seams.manual().is_none().then(|| {
        let me = core.me.clone();
        let task = tokio::task::spawn_local(async move {
            tokio::time::sleep(day).await;
            if let Some(core) = me.upgrade() {
                prune(&mut core.borrow_mut());
            }
        });
        task.abort_handle()
    });
    core.seams.prune = Some(Timer { until, task });
}

/// The core is shutting down: every hold timer ends without firing, and
/// none is armed again, so a held thought stays routed with no timer, as a
/// restart leaves it (design §3), and nothing launches while the core goes.
pub fn close(core: &mut Core) {
    core.seams.closing = true;
    crate::speech::close(core);
    for (_, (_, hear)) in core.seams.routes.drain() {
        let _ = hear.send(Asked::Stop);
    }
    let timers = core.seams.timers.drain().map(|(_, timer)| timer);
    for timer in timers.chain(core.seams.prune.take()) {
        if let Some(task) = timer.task {
            task.abort();
        }
    }
}

/// `fixture.script`: selects the fixture router, and the fixture launcher
/// or with `agent` the real one, and scripts them; the reply is everything
/// they were asked since.
#[cfg(feature = "fixtures")]
pub fn script(
    cx: &mut Cx,
    args: tasktap_proto::FixtureScript,
) -> Result<tasktap_proto::FixtureLog, Error> {
    use state::{FixtureLauncher, FixtureRouter};
    use tasktap_proto::{FixtureLaunch, FixtureLog};
    let route = crate::route::unwire(args.route);
    let f = cx.core.seams.fixture.get_or_insert_with(|| Fixture {
        router: FixtureRouter(Route::Unknown),
        launcher: FixtureLauncher::default(),
        agent: None,
        notified: Vec::new(),
    });
    f.router = FixtureRouter(route);
    f.agent = args.agent;
    f.launcher.refuse = args.refuse;
    f.launcher.unrecordable = args.unrecordable;
    crate::shim::pause(cx.core, args.pause);
    let held = crate::shim::held(cx.core);
    let f = (cx.core.seams.fixture.as_ref()).expect("selected above");
    let l = &f.launcher;
    let launched = l.launched.iter().zip(&l.tokens);
    Ok(FixtureLog {
        launched: launched
            .map(|(launch, token)| FixtureLaunch {
                thought: launch.thought,
                session: launch.session,
                prompt: launch.prompt.clone(),
                token: token.clone(),
            })
            .collect(),
        delivered: l.delivered.iter().map(|d| d.thought).collect(),
        held,
        killed: l.killed.clone(),
        settled: l.settled.iter().map(|&(thought, _)| thought).collect(),
        notified: f.notified.clone(),
    })
}

/// `fixture.clock`: the clock reads `now` from here on, and every hold that
/// has ended by then ends, oldest first, before the reply.
#[cfg(feature = "fixtures")]
pub fn clock(cx: &mut Cx, args: tasktap_proto::FixtureClock) -> Result<(), Error> {
    let core = &mut *cx.core;
    core.seams.clock = Some(args.now);
    let mut due = Vec::new();
    for (&thought, timer) in &mut core.seams.timers {
        if let Some(task) = timer.task.take() {
            task.abort();
        }
        if timer.until <= args.now {
            due.push((timer.until, thought));
        }
    }
    due.sort();
    for (until, thought) in due {
        // An earlier one's effects may have cancelled or moved it.
        if core
            .seams
            .timers
            .get(&thought)
            .is_some_and(|t| t.until == until)
        {
            fire(core, thought, until);
        }
    }
    // The next pruning, as its timer would have it.
    if let Some(timer) = &mut core.seams.prune {
        if let Some(task) = timer.task.take() {
            task.abort();
        }
        if timer.until <= args.now {
            prune(core);
        }
    }
    Ok(())
}
