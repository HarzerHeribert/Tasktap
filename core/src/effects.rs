//! The calls with effects (design §5, §14 package 7). Each turns into one
//! state-machine event, applied in one transaction that is committed and
//! published in the same step. The effects the machine returns are then
//! carried out: they go to the router, the launcher, the hold timers, the
//! host and the waiting askers, and what those report comes back as events.
//! The rules stay in `state.rs`; this module only moves things between it
//! and the world.
//!
//! The launcher is `launch.rs`, which starts runs in real terminals. The
//! router, and the worktrees a settle needs, are still the state machine's
//! fixtures, which only a core built with its test fixtures has, once
//! `fixture.script` selects them; the fixture launcher stands in for the
//! real one only where a test scripts what the real one cannot do. Without
//! them an event whose effects need one is refused with `failed` before
//! anything is committed: the core never pretends to route or settle.

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tasktap_proto::call::{Code, Error};
use tasktap_proto::{
    AttemptId, Change, Offset, Outcome, QuestionId, Secret, SessionEvent, TerminalId,
    TerminalState, ThoughtId, Time,
};
use tokio::task::AbortHandle;

use crate::calls::{Caller, Cx};
use crate::serve::Core;
use crate::state::{self, Deliver, Effect, Event, Launch, Launcher, Report, Router};
use crate::store::{self, AttemptOutcome, Tx};
use crate::{agents, questions};

/// The agent a new run uses until package D detects the installed ones.
pub const AGENT: &str = "claude";

const NO_ROUTER: &str = "this build has no router yet";
const NO_ISOLATION: &str = "this build has no worktrees to settle yet";

/// Why an event was not applied.
#[derive(Debug)]
pub enum Refusal {
    State(state::Error),
    /// This build has no router or no worktrees yet.
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
/// | this build has no router or no worktrees yet | `failed` |
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

/// The clock and the hold timers, and in a fixtures build the fixture
/// router, launcher and host.
#[derive(Default)]
pub struct Seams {
    /// One one-shot timer per held thought; nothing else is ever armed here.
    timers: HashMap<ThoughtId, Timer>,
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
            Effect::Route(_) if !self.selected() => Some(NO_ROUTER),
            Effect::Settle { .. } if !self.stands_in() => Some(NO_ISOLATION),
            _ => None,
        })
    }

    /// The agent a new capture names.
    pub fn agent(&self) -> String {
        #[cfg(feature = "fixtures")]
        if let Some(agent) = self.fixture.as_ref().and_then(|f| f.agent.clone()) {
            return agent;
        }
        AGENT.into()
    }

    #[cfg(feature = "fixtures")]
    fn manual(&self) -> Option<Time> {
        self.clock
    }

    #[cfg(not(feature = "fixtures"))]
    fn manual(&self) -> Option<Time> {
        None
    }

    #[cfg(feature = "fixtures")]
    fn selected(&self) -> bool {
        self.fixture.is_some()
    }

    #[cfg(not(feature = "fixtures"))]
    fn selected(&self) -> bool {
        false
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

    #[cfg(feature = "fixtures")]
    fn router(&mut self) -> Option<&mut dyn Router> {
        let f = self.fixture.as_mut()?;
        Some(&mut f.router)
    }

    #[cfg(not(feature = "fixtures"))]
    fn router(&mut self) -> Option<&mut dyn Router> {
        None
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
    let report = Report {
        session: session.id,
        terminal,
        id: args.id,
        turn: args.turn,
        subagent: args.subagent,
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
            Effect::Route(thought) => {
                route(core, thought);
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
            Effect::Launch(launch) => Some(self::launch(core, launch)),
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

fn route(core: &mut Core, id: ThoughtId) {
    let Ok(Some(thought)) = read(core, |tx| tx.thought(id)) else {
        return;
    };
    let Some(router) = core.seams.router() else {
        return;
    };
    let route = router.route(&thought);
    report(core, Event::Routed { thought: id, route }, |_| Ok(()));
}

fn launch(core: &mut Core, launch: Launch) -> Outcome {
    let token = Secret::mint();
    let started = match core.seams.launcher() {
        Some(launcher) => launcher.launch(&launch, &token),
        None => crate::launch::launch(core, &launch, &token),
    };
    let attempt = launch.attempt;
    match started {
        Ok(terminal) => {
            let hash = crate::handshake::hash(&token);
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
    crate::shim::deliver(core, deliver).map(|deliver| typed(core, deliver, false))
}

/// Has the launcher type a follow-up into its session's terminal, `held`
/// when the shim of an adopted session holds it, and reports how that went.
pub fn typed(core: &mut Core, deliver: Deliver, held: bool) -> Outcome {
    let handed = match core.seams.launcher() {
        Some(launcher) => launcher.deliver(&deliver),
        None => crate::launch::deliver(core, &deliver, held),
    };
    let attempt = deliver.attempt;
    match handed {
        Ok(()) => {
            let event = Event::Launched {
                attempt,
                terminal: None,
            };
            report(core, event, |_| Ok(()));
            Outcome::Ok(Value::Null)
        }
        Err(error) => failed(core, attempt, error),
    }
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
        // In Phase 1 every launch and settle reports before its call returns.
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
/// already ended ends now.
fn arm(core: &mut Core, thought: ThoughtId, until: Time) {
    cancel(core, thought);
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
    // The last hold may have kept the core alive.
    core.events.notify_one();
    // The timer counts on a steady clock; when the wall clock lags it, the rest is slept.
    if core.seams.now() < until {
        return arm(core, thought, until);
    }
    let attempt = state::fresh(core.seams.now()).unwrap_or_else(|e| stop(e));
    report(core, Event::HoldEnded { thought, attempt }, |_| Ok(()));
}

/// `fixture.script`: selects the fixture router, and the fixture launcher
/// or with `agent` the real one, and scripts them; the reply is everything
/// they were asked since.
#[cfg(feature = "fixtures")]
pub fn script(
    cx: &mut Cx,
    args: tasktap_proto::FixtureScript,
) -> Result<tasktap_proto::FixtureLog, Error> {
    use state::{Candidate, Destination, FixtureLauncher, FixtureRouter, Route};
    use tasktap_proto::{FixtureLaunch, FixtureLog, FixtureRoute, Place};
    let to = |place| match place {
        Place::Project(id) => Destination::New(id),
        Place::Session(id) => Destination::Session(id),
    };
    let route = match args.route {
        FixtureRoute::Clear { to: place, brief } => Route::Clear {
            to: to(place),
            brief,
        },
        FixtureRoute::Ambiguous { prompt, candidates } => Route::Ambiguous {
            prompt,
            candidates: (candidates.into_iter())
                .map(|c| Candidate {
                    label: c.label,
                    to: to(c.to),
                })
                .collect(),
        },
        FixtureRoute::Unknown => Route::Unknown,
    };
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
