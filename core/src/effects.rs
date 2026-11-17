//! The calls with effects (design §5, §14 package 7). Each turns into one
//! state-machine event, applied in one transaction that is committed and
//! published in the same step. The effects the machine returns are then
//! carried out: they go to the router, the launcher, the hold timers, the
//! host and the waiting askers, and what those report comes back as events.
//! The rules stay in `state.rs`; this module only moves things between it
//! and the world.
//!
//! The launcher is `launch.rs`, which starts runs in real terminals; the
//! router is `route.rs`'s local match, unless `fixture.script` has
//! selected the fixture router in a core built with its test fixtures. The
//! worktrees a settle needs are still the state machine's fixture, which
//! only such a core has; the fixture launcher stands in for the real one
//! only where a test scripts what the real one cannot do. Without it a
//! settle is refused with `failed` before anything is committed: the core
//! never pretends to settle.

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tasktap_proto::call::{Code, Error};
use tasktap_proto::{
    AttemptId, Change, Offset, Outcome, QuestionId, Secret, SessionEvent, SessionId, TerminalId,
    TerminalState, ThoughtId, Time,
};
use tokio::task::AbortHandle;

use crate::calls::{Caller, Cx};
use crate::serve::Core;
use crate::state::{self, Deliver, Effect, Event, Launch, Launcher, Report, Router};
use crate::store::{self, AttemptOutcome, Tx};
use crate::{agents, questions};

const NO_ISOLATION: &str = "this build has no worktrees to settle yet";

/// Why an event was not applied.
#[derive(Debug)]
pub enum Refusal {
    State(state::Error),
    /// This build has no worktrees yet.
    Unbuilt(&'static str),
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
/// | this build has no worktrees yet | `failed` |
/// | the store failed | `failed`; `gone` for a missing row, `conflict` for a duplicate |
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
        Refusal::Unbuilt(why) => (Code::Failed, why.into()),
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
    /// One one-shot timer per held thought; nothing else is ever armed here.
    timers: HashMap<ThoughtId, Timer>,
    /// The core is shutting down: no hold is armed or ends any more.
    closing: bool,
    /// Set by `fixture.clock`: the time stands still until it is called again.
    #[cfg(feature = "fixtures")]
    clock: Option<Time>,
    #[cfg(feature = "fixtures")]
    fixture: Option<Fixture>,
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
    /// Whether a hold timer is armed.
    pub fn holding(&self) -> bool {
        !self.timers.is_empty()
    }

    pub fn now(&self) -> Time {
        self.manual().unwrap_or_else(wall)
    }

    /// Why this build cannot carry out the effects, when it cannot.
    fn unbuilt(&self, effects: &[Effect]) -> Option<&'static str> {
        effects.iter().find_map(|effect| match effect {
            Effect::Settle { .. } if !self.stands_in() => Some(NO_ISOLATION),
            _ => None,
        })
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

    /// The fixture launcher stands in for the real one.
    #[cfg(feature = "fixtures")]
    fn stands_in(&self) -> bool {
        self.fixture.as_ref().is_some_and(|f| f.agent.is_none())
    }

    #[cfg(not(feature = "fixtures"))]
    fn stands_in(&self) -> bool {
        false
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
    if let Some(why) = core.seams.unbuilt(&effects) {
        return Err(Refusal::Unbuilt(why));
    }
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
            Effect::Route { thought, current } => {
                route(core, thought, current);
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
            } => Some(settle(core, attempt, thought, keep)),
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

fn route(core: &mut Core, id: ThoughtId, current: Option<SessionId>) {
    let request = read(core, |tx| {
        let thought = tx.thought(id)?;
        (thought.map(|t| crate::route::request(tx, &t.text, current))).transpose()
    });
    let Ok(Some(request)) = request else {
        return;
    };
    let route = core.seams.route(&request);
    report(core, Event::Routed { thought: id, route }, |_| Ok(()));
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
    let mut prepared = match crate::launch::prepare(&launch) {
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

fn settle(core: &mut Core, attempt: AttemptId, thought: ThoughtId, keep: bool) -> Outcome {
    let settled = match core.seams.launcher() {
        Some(launcher) => launcher.settle(thought, keep),
        None => Err(NO_ISOLATION.into()),
    };
    let error = settled.err();
    let event = Event::Settled {
        attempt,
        error: error.clone(),
    };
    report(core, event, |_| Ok(()));
    match error {
        None => Outcome::Ok(Value::Null),
        Some(why) => Outcome::Err(Error::new(Code::Failed, why)),
    }
}

/// A repeated attempt answers with the outcome of its first call.
fn repeated(first: Option<AttemptOutcome>) -> Outcome {
    match first {
        Some(AttemptOutcome::Reply(reply)) => reply,
        Some(AttemptOutcome::Interrupted) => Outcome::Err(Error::new(
            Code::Failed,
            "the core stopped during this attempt; nothing was started again",
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

/// The core is shutting down: every hold timer ends without firing, and
/// none is armed again, so a held thought stays routed with no timer, as a
/// restart leaves it (design §3), and nothing launches while the core goes.
pub fn close(core: &mut Core) {
    core.seams.closing = true;
    for (_, timer) in core.seams.timers.drain() {
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
    use state::{FixtureLauncher, FixtureRouter, Route};
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
    Ok(())
}
