//! The state machine (design §5, "One state machine"): the only writer of a
//! thought's phase and status, of a session's state, and of the question
//! states the table names.
//!
//! [`apply`] takes an open transaction, one [`Event`] and the time. It changes
//! the records as the table says and returns the [`Effect`]s the caller
//! carries out once the transaction is committed. It does no I/O and reads no
//! clock, so every rule is proven without a service. A thought's status is
//! derived on every write: `needs_you` while it has an open question,
//! otherwise its phase. A session shows asking by the same rule, read from
//! its questions.
//!
//! Every effect that spawns something (a launch, a follow-up, a settle) is
//! preceded by its attempt, written in the same transaction with a hash of
//! its arguments (design §3), so repeating the call never spawns twice. The
//! launcher and the router are seams, each with a fixture here.
//!
//! A router is asked about a thought as it is captured and may take
//! seconds (design §8): the thought's `route` says so while it does, and no
//! thought launches before its router has answered or been stopped.

use std::collections::BTreeSet;
use std::fmt;
use std::path::Path;

use serde::de::DeserializeOwned;
use serde_json::Value;
use sha2::{Digest, Sha256};
// Short names keep each row of the table on one line: E an event, A what an
// agent said, P a thought's phase, S a session's state, Q a question's state.
use tasktap_proto::{
    Answer, AttemptId, Capture, Changes, Code, DeviceId, Event as A, Isolate, MAX_OPEN_QUESTIONS,
    MAX_PREVIEWS, MAX_SESSION_QUESTIONS, Mode, Offset, Outcome, Phase as P, Placed, PrefKey,
    PrefValue, Preview, PreviewBy, PreviewId, PreviewKind, Project, ProjectId, ProjectKind,
    Question, QuestionId, QuestionKind, QuestionSource, QuestionState as Q, READ_HOLD, Reason,
    ReplyVia, Response, ResultKind, Rev, RouteBy, Routing, Secret, Session, SessionId,
    SessionState as S, Source, Status, Terminal, TerminalId, TerminalKind, TerminalState, Thought,
    ThoughtId, Time, TurnResult, Workdir,
};

use crate::store::{self, Attempt, AttemptKind, AttemptOutcome, Hash, Tx};

use Event as E;

/// Characters of an answer's first line kept as its result's summary.
const SUMMARY: usize = 200;
/// Hex digits of a launch attempt's id, from its random end, that name a
/// new worktree and its branch.
const NAME: usize = 12;
const SETTLING: &str = "its changes are being kept or discarded; try again once that is done";
/// The activity line a turn starts with.
pub const TURN_STARTED: &str = "Started on the prompt";

/// Everything that can move a thought, a session or a question.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// `thought.capture`, with the agent a new run of the thought would use.
    Capture { capture: Capture, agent: String },
    /// The person picks where a captured thought goes.
    Pick { thought: ThoughtId, to: Destination },
    /// The router's answer for a thought it was asked about, and `how` it
    /// came by it: who answered, and why not the model that was asked.
    /// `current` is the session the thought was captured in, as the
    /// router was told it.
    Routed {
        thought: ThoughtId,
        route: Route,
        how: Routing,
        current: Option<SessionId>,
    },
    /// The thought's hold timer fired. The core mints the attempt.
    HoldEnded {
        thought: ThoughtId,
        attempt: AttemptId,
    },
    /// `thought.start`.
    Start {
        thought: ThoughtId,
        attempt: AttemptId,
    },
    /// `thought.stop`: Undo before the launch, stop after it.
    Stop { thought: ThoughtId },
    /// `thought.retry`.
    Retry { thought: ThoughtId },
    /// `thought.settle`: keep or discard the changes of the thought's worktree.
    Settle {
        thought: ThoughtId,
        attempt: AttemptId,
        keep: bool,
    },
    /// `thought.read`: the person has seen how a thought ended.
    Read { thought: ThoughtId },
    /// The launcher did what a `Launch` or `Deliver` effect asked. A launch
    /// names the terminal it started, which the caller has stored.
    Launched {
        attempt: AttemptId,
        terminal: Option<TerminalId>,
    },
    /// The launcher could not do it.
    LaunchFailed { attempt: AttemptId, error: String },
    /// The `Settle` or `Tidy` effect finished, or refused with the reason.
    /// `kept` says what a settle that finished did: a Keep, or a Discard
    /// that found all of it in its destination already, kept.
    Settled {
        kept: bool,
        attempt: AttemptId,
        error: Option<String>,
    },
    /// A launch's worktree was made, or found again, before its run
    /// starts: `owner`'s record, which the run's session works in.
    Prepared {
        attempt: AttemptId,
        owner: ThoughtId,
        workdir: Workdir,
    },
    /// What a look at the thought's worktree at `path` found.
    Surveyed {
        thought: ThoughtId,
        path: String,
        found: Found,
    },
    /// A session's process ended. `silent` when its agent sends no events,
    /// so the exit is its only report.
    Exited {
        session: SessionId,
        code: Option<u32>,
        silent: bool,
    },
    /// What a session's agent says (`session.event`).
    Report(Report),
    /// A session's terminal shows what its agent waits on there before it
    /// is ready, which its adapter names (`Agent::prompts`): the prompt of
    /// the question that opens for it.
    Shown { session: SessionId, prompt: String },
    /// `session.adopt`: an agent a person started in a shell becomes a
    /// session of the shell's terminal, under an id the core minted.
    Adopt {
        session: SessionId,
        terminal: TerminalId,
        agent: String,
        cwd: String,
    },
    /// An agent's question opens, or a withdrawn one reopens because its
    /// waiter came back. The caller has matched the request key (design §6).
    Ask { question: Question, key: String },
    /// A device answers a question.
    Answer {
        question: QuestionId,
        response: Response,
        by: Option<DeviceId>,
    },
    /// The asker withdraws its question.
    Withdraw { question: QuestionId },
}

/// A `session.event` with what the guards need: who sent it and for which turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    pub session: SessionId,
    /// The terminal whose token sent the event.
    pub terminal: TerminalId,
    /// The sender's own id for the event; a repeat is ignored.
    pub id: String,
    /// The session's turn the event belongs to, when the sender knows it; a
    /// turn start names the turn it begins.
    pub turn: Option<u32>,
    /// Sent for one of the agent's sub-agents.
    pub subagent: bool,
    /// The agent's handle for resuming, when the report carries one.
    pub resume: Option<String>,
    pub event: A,
}

/// Where a thought goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Destination {
    /// A new run in a project.
    New(ProjectId),
    /// A follow-up to a session.
    Session(SessionId),
}

impl From<Destination> for tasktap_proto::Place {
    fn from(to: Destination) -> Self {
        match to {
            Destination::New(project) => Self::Project(project),
            Destination::Session(session) => Self::Session(session),
        }
    }
}

/// What the router found, after the acceptance rules of design §8.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Route {
    Clear {
        to: Destination,
        brief: String,
    },
    /// The person chooses in a router question. `brief` is the one a
    /// model wrote already, which holds wherever the thought goes.
    Ambiguous {
        prompt: String,
        candidates: Vec<Candidate>,
        brief: Option<String>,
    },
    /// Nowhere to send it, or a note: it stays captured as an idea.
    Unknown,
}

/// One choice of a router question.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub label: String,
    pub to: Destination,
}

/// What the caller must do once the transaction is committed.
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    /// Ask the router; its answer comes back as [`Event::Routed`].
    /// `current` is the session the capture was made in. `by` is the
    /// person's consent to ask a model, without which the match on names
    /// answers. With `picked`, the person chose the destination and only
    /// the brief is asked for.
    Route {
        thought: ThoughtId,
        current: Option<SessionId>,
        by: Option<RouteBy>,
        picked: Option<Destination>,
    },
    /// Stop asking the router about the thought: its answer is not wanted.
    Unroute(ThoughtId),
    /// Arm the hold timer and apply [`Event::HoldEnded`] at `until`, which
    /// is now when the hold is zero.
    Hold { thought: ThoughtId, until: Time },
    /// Cancel the thought's hold timer.
    Unhold(ThoughtId),
    /// Start a run; report with [`Event::Launched`] or [`Event::LaunchFailed`].
    Launch(Launch),
    /// Hand a follow-up to its running session as design §7 allows; report the same way.
    Deliver(Deliver),
    /// End the session's process. Without a terminal yet, the launch's report
    /// asks again once it names one.
    Kill {
        session: SessionId,
        terminal: Option<TerminalId>,
    },
    /// End the agent of an adopted session through the shim that adopted
    /// it, which ends its own child and never the person's shell.
    StopAdopted(SessionId),
    /// Keep or discard the thought's worktree; report with [`Event::Settled`].
    Settle {
        attempt: AttemptId,
        thought: ThoughtId,
        keep: bool,
    },
    /// Look at the changes of the thought's worktree; report with
    /// [`Event::Surveyed`].
    Survey(ThoughtId),
    /// Remove the thought's worktree and branch where git itself agrees
    /// nothing is in them. Report what is there instead with
    /// [`Event::Surveyed`], and the end with [`Event::Settled`].
    Tidy {
        attempt: AttemptId,
        thought: ThoughtId,
    },
    /// A question opened: tell the person.
    Notify(QuestionId),
    /// A waited question was answered: its stored answer is the waiter's reply.
    Answer(QuestionId),
    /// A line for the session's memory-only activity.
    Activity { session: SessionId, text: String },
    /// The attempt was made before: reply with its first outcome, or wait
    /// for it when there is none yet. Nothing is spawned again.
    Repeat(Option<AttemptOutcome>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launch {
    pub attempt: AttemptId,
    pub thought: ThoughtId,
    /// Already stored as starting. It takes the attempt's id, so one attempt
    /// can never make two sessions.
    pub session: SessionId,
    pub project: ProjectId,
    pub cwd: String,
    pub agent: String,
    pub model: Option<String>,
    /// What the run is told: the thought's brief, or its text.
    pub prompt: String,
    /// The person's own words, when `prompt` is a brief that says them
    /// differently: the agent gets both (design §8).
    pub words: Option<String>,
    /// The agent's handle of an ended session whose conversation this run continues.
    pub resume: Option<String>,
    /// The worktree the run works in, made or found before it starts; none
    /// runs it in `cwd`, the project folder.
    pub worktree: Option<Worktree>,
}

/// The worktree a launch runs in (design §7, "Isolation").
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Worktree {
    /// A new one, `tasktap/<name>` in `<data>/worktrees/<name>`, from the
    /// project folder's HEAD, which the launch's thought owns.
    New { name: String },
    /// `owner`'s, made again where it is gone.
    Again {
        owner: ThoughtId,
        workdir: Box<Workdir>,
    },
}

/// What a look at a worktree found (`isolate.rs`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Found {
    /// Files changed against the worktree's base, committed or not, and
    /// their lines added and removed.
    pub files: u32,
    pub insertions: u32,
    pub deletions: u32,
    /// Neither its folder nor its branch is there any more.
    pub gone: bool,
    /// Removing it would lose nothing: its folder, where it is there, is
    /// still a worktree on its branch, with nothing staged, changed,
    /// untracked or ignored beside the branch's files, and the branch is
    /// at its base.
    pub spare: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Deliver {
    pub attempt: AttemptId,
    pub thought: ThoughtId,
    pub session: SessionId,
    /// What is typed: the thought's brief, or its text.
    pub text: String,
    /// The person's own words, as in [`Launch::words`].
    pub words: Option<String>,
}

/// Why an event changed nothing, or could not be applied. On `Err` the
/// caller drops the transaction.
#[derive(Debug)]
pub enum Error {
    /// The event changes nothing and is dropped; a call answers as for a repeat.
    Ignored(Ignored),
    /// The record the event names does not exist, or the question is settled.
    Gone,
    /// An id came back with other arguments, or the call must wait for
    /// something else first.
    Conflict(&'static str),
    /// The event carries a value the transition refuses.
    Invalid(&'static str),
    Store(store::Error),
}

/// The guards of design §5.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ignored {
    /// The same event, capture or question came before.
    Repeat,
    /// Sent with the token of a terminal that is not the session's.
    OldToken,
    Subagent,
    OtherTurn,
    /// The event does not fit the current state.
    State,
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Ignored(why) => write!(f, "ignored: {why:?}"),
            Error::Gone => f.write_str("no such record, or it is settled"),
            Error::Conflict(why) | Error::Invalid(why) => f.write_str(why),
            Error::Store(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<store::Error> for Error {
    fn from(e: store::Error) -> Self {
        Error::Store(e)
    }
}

/// Applies one event. On success the caller commits and then carries out
/// the effects in order.
pub fn apply(tx: &mut Tx<'_>, now: Time, event: Event) -> Result<Vec<Effect>> {
    let mut machine = Machine {
        tx,
        now,
        effects: Vec::new(),
    };
    machine.apply(event)?;
    Ok(machine.effects)
}

/// The launcher seam: `launch.rs` carries it out with terminals and agent
/// adapters (Phase 3 adds worktrees), and [`FixtureLauncher`] stands in for
/// it where a test scripts what it cannot do. What it returns goes back in as
/// [`Event::Launched`], [`Event::LaunchFailed`] or [`Event::Settled`]; the end
/// of the process later as [`Event::Exited`].
pub trait Launcher {
    /// Starts the run in a new terminal whose environment carries the session
    /// `token`, and returns that terminal, which the caller stores with the
    /// token's hash in the transaction that applies `Launched`.
    fn launch(&mut self, launch: &Launch, token: &Secret) -> Result<Terminal, String>;
    /// Hands a follow-up to its session.
    fn deliver(&mut self, deliver: &Deliver) -> Result<(), String>;
    /// Ends the process of a terminal. True when it has ended already, so the
    /// caller records the exit at once; otherwise the end is reported when it
    /// happens.
    fn kill(&mut self, terminal: TerminalId) -> bool;
    /// Keeps or discards the changes of a thought's worktree.
    fn settle(&mut self, thought: ThoughtId, keep: bool) -> Result<(), String>;
}

/// The seam of the router that answers at once: the local router of
/// design §8 (`route::Local`), or a fixture. It is asked with what the
/// core's records offer, and its answer goes back in as [`Event::Routed`],
/// as a model's does when the person consented to one (`effects.rs`).
pub trait Router {
    fn route(&mut self, request: &crate::route::Request) -> Route;
}

/// A launcher that starts nothing: it records what it was asked and answers
/// with a running terminal that takes the session's id, or with `refuse`.
/// A terminal it is asked to kill has ended at once.
#[derive(Debug, Default)]
pub struct FixtureLauncher {
    pub refuse: Option<String>,
    /// Each terminal names a project that does not exist, so storing it fails.
    pub unrecordable: bool,
    pub launched: Vec<Launch>,
    /// The token of each launch, in the same order.
    pub tokens: Vec<Secret>,
    pub delivered: Vec<Deliver>,
    pub killed: Vec<TerminalId>,
    pub settled: Vec<(ThoughtId, bool)>,
}

impl Launcher for FixtureLauncher {
    fn launch(&mut self, launch: &Launch, token: &Secret) -> Result<Terminal, String> {
        self.launched.push(launch.clone());
        self.tokens.push(token.clone());
        if let Some(why) = &self.refuse {
            return Err(why.clone());
        }
        Ok(Terminal {
            id: TerminalId::try_from(launch.session.uuid()).map_err(|e| e.to_string())?,
            rev: Rev::ZERO,
            project_id: Some(if self.unrecordable {
                ProjectId::mint()
            } else {
                launch.project
            }),
            kind: TerminalKind::Agent,
            title: launch.agent.clone(),
            cwd: launch.cwd.clone(),
            argv: vec![launch.agent.clone(), "--".into(), launch.prompt.clone()],
            cols: 80,
            rows: 24,
            state: TerminalState::Running,
            exit: None,
            offset: Offset::ZERO,
        })
    }

    fn deliver(&mut self, deliver: &Deliver) -> Result<(), String> {
        self.delivered.push(deliver.clone());
        self.refuse.clone().map_or(Ok(()), Err)
    }

    fn kill(&mut self, terminal: TerminalId) -> bool {
        self.killed.push(terminal);
        true
    }

    fn settle(&mut self, thought: ThoughtId, keep: bool) -> Result<(), String> {
        self.settled.push((thought, keep));
        self.refuse.clone().map_or(Ok(()), Err)
    }
}

/// A router that gives every thought the same answer.
#[derive(Clone, Debug)]
pub struct FixtureRouter(pub Route);

impl Router for FixtureRouter {
    fn route(&mut self, _: &crate::route::Request) -> Route {
        self.0.clone()
    }
}

struct Machine<'a, 's> {
    tx: &'a mut Tx<'s>,
    now: Time,
    effects: Vec<Effect>,
}

/// The records an event concerns, read before the table decides.
#[derive(Default)]
struct Subject {
    thought: Option<Thought>,
    session: Option<Session>,
    question: Option<Question>,
    attempt: Option<Attempt>,
}

enum Ending {
    Finished(Option<String>),
    Failed(Reason, Option<String>),
}

impl Machine<'_, '_> {
    /// The table of design §5, row by row. `said` is what a session reported.
    fn apply(&mut self, event: Event) -> Result<()> {
        let Some(Subject {
            thought,
            session,
            question,
            attempt,
        }) = self.subject(&event)?
        else {
            return Ok(());
        };
        let said = match &event {
            E::Report(r) => Some(r.event.clone()),
            _ => None,
        };
        // The agent's handle for resuming, kept as its latest report gives it.
        let mut session = session;
        if let (E::Report(r), Some(s)) = (&event, session.as_mut())
            && r.resume.is_some()
            && r.resume != s.resume
        {
            s.resume = r.resume.clone();
            self.tx.update_session(s)?;
        }
        let phase = thought.as_ref().map(|t| t.phase);
        let state = session.as_ref().map(|s| s.state);
        let asked = question.as_ref().map(|q| q.state);
        let alive = matches!(state, Some(S::Starting | S::Idle | S::Working));
        // A worktree settles only once nothing works in it and no other
        // settle of it is under way.
        let (occupied, settling) = match (&event, &thought) {
            (E::Settle { .. }, Some(t)) => (alive || self.occupied(t)?, self.settling(t.id)?),
            _ => (false, false),
        };
        let adopted = session.as_ref().is_some_and(|s| s.adopted);
        let router = question.as_ref().map(|q| q.source) == Some(QuestionSource::Router);
        match (event, said, phase, state, asked) {
            // thought.capture: → captured.
            (E::Capture { capture, agent }, _, None, ..) => {
                self.capture(capture, agent, some(attempt)?)
            }
            (E::Capture { .. }, _, Some(_), ..) => Err(Error::Conflict(
                "the thought id was used for another capture",
            )),
            // route clear; a router question answered; the person picks:
            // captured → routed, and the hold starts. A router's answer
            // counts only while it is waited for.
            (
                E::Routed {
                    route: Route::Clear { to, brief },
                    how,
                    current,
                    ..
                },
                _,
                Some(P::Captured),
                ..,
            ) if routing(&thought) => self.routed(some(thought)?, to, brief, how, current),
            // the brief of a thought whose destination the person picked.
            (
                E::Routed {
                    route: Route::Clear { brief, .. },
                    how,
                    ..
                },
                _,
                Some(P::Routed),
                ..,
            ) if routing(&thought) => self.briefed(some(thought)?, brief, how),
            (E::Answer { response, by, .. }, _, Some(P::Captured), _, Some(Q::Open)) if router => {
                self.answer_router(some(thought)?, some(question)?, response, by)
            }
            (E::Pick { to, .. }, _, Some(P::Captured), ..) => {
                let now = self.now;
                self.route(some(thought)?, to, None, now, Placed::Picked)
            }
            // route ambiguous: stays captured, a router question opens.
            (
                E::Routed {
                    route:
                        Route::Ambiguous {
                            prompt,
                            candidates,
                            brief,
                        },
                    how,
                    ..
                },
                _,
                Some(P::Captured),
                ..,
            ) if routing(&thought) && !candidates.is_empty() => {
                self.ask_router(some(thought)?, prompt, candidates, brief, how)
            }
            // route unknown, or ambiguous with nothing to choose: an idea.
            (E::Routed { how, .. }, _, Some(P::Captured), ..) if routing(&thought) => {
                let placed = unplaced(&how);
                self.keep_as_idea(some(thought)?, Some(how), placed)
            }
            // hold ends, or thought.start: routed → working once the attempt
            // is written. A hold that ends while the router still writes the
            // brief launches nothing: the brief's arrival does.
            (E::HoldEnded { attempt, .. }, _, Some(P::Routed), ..)
                if due(&thought, self.now) && !routing(&thought) =>
            {
                self.launch(some(thought)?, attempt, false)
            }
            (E::Start { attempt, .. }, _, Some(P::Routed), ..) => {
                self.launch(some(thought)?, attempt, true)
            }
            // thought.stop before launch (Undo): routed → captured; a router
            // still asked about it is stopped, also before it is routed.
            (E::Stop { .. }, _, Some(P::Routed), ..) => self.undo(some(thought)?),
            (E::Stop { .. }, _, Some(P::Captured), ..) if routing(&thought) => {
                self.undo(some(thought)?)
            }
            // launch fails: → failed, its session ended, why kept as the
            // thought's failure. Both reports have already recorded the
            // attempt's outcome.
            (E::LaunchFailed { attempt, error }, ..) => {
                self.launch_failed(thought, session, attempt, error)
            }
            (E::Launched { terminal, .. }, ..) => self.launched(session, terminal),
            // A launch's worktree was made: its owner records it, and the
            // run's session works in it.
            (E::Prepared { workdir, .. }, ..) => self.prepared(some(thought)?, session, workdir),
            // A look at a worktree: its changes pending or none, a settle the
            // core stopped during decided, and one with nothing to lose tidied.
            (E::Surveyed { path, found, .. }, ..) => self.surveyed(some(thought)?, path, found),
            // session.adopt: a new adopted session, starting, in a shell where
            // no session is alive.
            (
                E::Adopt {
                    session: id,
                    terminal,
                    agent,
                    cwd,
                },
                _,
                _,
                None,
                _,
            ) => self.adopt(id, terminal, agent, cwd),
            (E::Adopt { .. }, ..) => Err(Error::Conflict("an agent already runs in this terminal")),
            // ready: starting → idle; what it showed in its terminal before
            // closes as answered there.
            (_, Some(A::Ready), _, Some(S::Starting), _) => self.ready(some(session)?),
            // shown: what an agent waits on in its terminal before it is
            // ready opens as a question answered there.
            (E::Shown { prompt, .. }, _, _, Some(S::Starting), _) => {
                self.shown(some(session)?, prompt)
            }
            // turn_started: → working. Binds the waiting thought, or makes one
            // from a prompt typed by hand.
            (_, Some(A::TurnStarted { prompt }), _, Some(S::Starting | S::Idle), _) => {
                self.start_turn(some(session)?, prompt)
            }
            // turn_started without a prompt while a turn is open: an agent that
            // reports its state, not what happened, says it is at work, as
            // often as that state comes. The turn goes on, and what it asked
            // in its terminal was answered there.
            (_, Some(A::TurnStarted { prompt: None }), _, Some(S::Working), _) => {
                self.continued(some(session)?, None)
            }
            // turn_started while a turn is open: the person interrupted it in
            // the terminal and the agent did not say so, as an agent with no
            // interrupt hook cannot. That turn ends as turn_interrupted would
            // end it, then the new one starts.
            (_, Some(A::TurnStarted { prompt }), _, Some(S::Working), _) => {
                let s = some(session)?;
                let id = s.id;
                self.end_turn(s, thought, Ending::Failed(Reason::Interrupted, None))?;
                let s = self.tx.session(id)?.ok_or(Error::Gone)?;
                self.start_turn(s, prompt)
            }
            // activity: memory-only text, nothing stored.
            (_, Some(A::Activity { text }), ..) if alive => self.activity(some(session)?, text),
            // a question asked in the agent's terminal opens as the agent's
            // question of this turn, once it passed the guards of every event.
            (_, Some(A::Question { question: ask }), _, Some(S::Working), _) => {
                self.hook(some(session)?, ask)
            }
            // a question opens: unchanged, the status becomes needs you. The
            // same key must bring the same question, and beyond the bound of
            // open questions a new one is refused (design §6). Only the
            // router asks as the router, and never through this row.
            (E::Ask { question: q, .. }, ..) if q.source == QuestionSource::Router => {
                Err(Error::Invalid("only Tasktap asks where a thought goes"))
            }
            (E::Ask { question: q, .. }, .., Some(_)) if !same_ask(&q, question.as_ref()) => Err(
                Error::Conflict("the request key was used for another question"),
            ),
            (E::Ask { question: q, key }, _, _, Some(S::Working), None)
                if this_turn(&q, &session) =>
            {
                self.open(q, key)
            }
            // Its waiter came back while the turn it was asked in is alive.
            (E::Ask { .. }, _, _, Some(S::Working), Some(Q::Withdrawn))
                if question.as_ref().is_some_and(|q| this_turn(q, &session)) =>
            {
                self.reopen(some(question)?)
            }
            (E::Ask { .. }, .., Some(Q::Withdrawn)) => Err(Error::Gone),
            (E::Ask { .. }, .., Some(Q::Open | Q::Answered)) => {
                Err(Error::Ignored(Ignored::Repeat))
            }
            // a question is answered or withdrawn: unchanged.
            (E::Answer { response, by, .. }, .., Some(Q::Open)) => {
                self.answer(some(question)?, response, by)
            }
            (E::Answer { .. }, .., Some(_)) => Err(Error::Gone),
            (E::Withdraw { .. }, .., Some(Q::Open)) => self.withdraw(some(question)?),
            (E::Withdraw { .. }, .., Some(Q::Withdrawn)) => Err(Error::Ignored(Ignored::Repeat)),
            // continued: the turn's terminal-only questions close as answered in the terminal.
            (_, Some(A::Continued { request }), _, Some(S::Working), _) => {
                self.continued(some(session)?, request)
            }
            // turn_finished: → done with its result; turn_failed, turn_interrupted:
            // → failed. The turn's open questions are withdrawn; the session is idle.
            (_, Some(A::TurnFinished { answer }), _, Some(S::Working), _) => {
                self.end_turn(some(session)?, thought, Ending::Finished(answer))
            }
            (_, Some(A::TurnFailed { error }), _, Some(S::Working), _) => {
                let ending = Ending::Failed(Reason::TurnFailed, error);
                self.end_turn(some(session)?, thought, ending)
            }
            (_, Some(A::TurnInterrupted), _, Some(S::Working), _) => {
                let ending = Ending::Failed(Reason::Interrupted, None);
                self.end_turn(some(session)?, thought, ending)
            }
            // exited(code): working → failed, or done when a silent agent exits
            // cleanly; the session ends and its open questions are withdrawn.
            (E::Exited { code, silent, .. }, ..) if alive => {
                self.exited(some(session)?, code, silent)
            }
            // The same, reported by the shim of an adopted session, which
            // alone sees that agent exit.
            (_, Some(A::Exited { code }), ..) if alive && adopted => {
                self.exited(some(session)?, code, false)
            }
            // thought.stop after launch: → failed (stopped); the process is stopped, → ended.
            (E::Stop { .. }, _, Some(P::Working), ..) => self.stop(some(thought)?, session),
            // thought.retry: failed → routed, its next ending unread.
            (E::Retry { .. }, _, Some(P::Failed), ..) => self.retry(some(thought)?),
            // thought.read: a done or failed thought is read; settled too, it is finished.
            (E::Read { .. }, _, Some(P::Done | P::Failed), ..) => self.read(some(thought)?),
            // thought.settle: changes pending → kept or discarded, once no
            // session and no terminal works in the worktree.
            (E::Settle { .. }, _, Some(P::Done | P::Failed), ..)
                if occupied && pending(&thought) =>
            {
                Err(Error::Conflict(
                    "a thought settles once its session has ended",
                ))
            }
            (E::Settle { .. }, _, Some(P::Done | P::Failed), ..)
                if settling && pending(&thought) =>
            {
                Err(Error::Conflict(SETTLING))
            }
            (E::Settle { attempt, keep, .. }, _, Some(P::Done | P::Failed), ..)
                if pending(&thought) =>
            {
                self.settle(some(thought)?, attempt, keep)
            }
            (
                E::Settled {
                    error: None, kept, ..
                },
                ..,
            ) if pending(&thought) => self.settled(some(thought)?, attempt, kept),
            // A refused settle leaves the changes pending; the outcome is recorded.
            (E::Settled { .. }, ..) => Ok(()),
            // Anything else does not fit the current state and changes nothing.
            _ => Err(Error::Ignored(Ignored::State)),
        }
    }

    /// Reads what the event concerns and applies the guards that do not
    /// depend on the state. `None` when the event repeats an attempt, which is
    /// answered from the attempt alone.
    fn subject(&mut self, event: &Event) -> Result<Option<Subject>> {
        let mut s = Subject::default();
        match event {
            Event::Capture { capture, .. } => {
                let kind = AttemptKind::Capture(capture.id);
                s.attempt = create(self.tx, self.now, kind, capture)?;
                if s.attempt.is_none() {
                    return Err(Error::Ignored(Ignored::Repeat));
                }
                s.thought = self.tx.thought(capture.id)?;
            }
            Event::Pick { thought, .. }
            | Event::Routed { thought, .. }
            | Event::Stop { thought }
            | Event::Retry { thought }
            | Event::Read { thought } => self.of_thought(&mut s, *thought)?,
            Event::HoldEnded { thought, attempt } | Event::Start { thought, attempt } => {
                let kind = AttemptKind::Launch(*thought);
                if self.repeated(*attempt, kind, launch_hash(*thought))? {
                    return Ok(None);
                }
                self.of_thought(&mut s, *thought)?;
            }
            Event::Settle {
                thought,
                attempt,
                keep,
            } => {
                let kind = AttemptKind::Settle(*thought);
                if self.repeated(*attempt, kind, settle_hash(*thought, *keep))? {
                    return Ok(None);
                }
                self.of_thought(&mut s, *thought)?;
            }
            Event::Launched { attempt, .. }
            | Event::LaunchFailed { attempt, .. }
            | Event::Settled { attempt, .. } => {
                let a = self.tx.attempt(*attempt)?.ok_or(Error::Gone)?;
                if a.outcome.is_some() {
                    return Err(Error::Ignored(Ignored::Repeat));
                }
                let thought = match (event, a.kind) {
                    (Event::Settled { .. }, AttemptKind::Settle(t)) => t,
                    (
                        Event::Launched { .. } | Event::LaunchFailed { .. },
                        AttemptKind::Launch(t),
                    ) => {
                        // A launch made the session that carries its id; a follow-up made none.
                        s.session = self.tx.session(own_session(a.id)?)?;
                        t
                    }
                    _ => {
                        return Err(Error::Invalid(
                            "the report names an attempt of another kind",
                        ));
                    }
                };
                let reply = match event {
                    Event::LaunchFailed { error, .. }
                    | Event::Settled {
                        error: Some(error), ..
                    } => Outcome::Err(tasktap_proto::Error::new(Code::Failed, error.clone())),
                    _ => Outcome::Ok(Value::Null),
                };
                self.tx.set_outcome(a.id, &AttemptOutcome::Reply(reply))?;
                s.thought = self.tx.thought(thought)?;
                s.attempt = Some(a);
            }
            Event::Prepared { attempt, owner, .. } => {
                let a = self.tx.attempt(*attempt)?.ok_or(Error::Gone)?;
                if a.outcome.is_some() || !matches!(a.kind, AttemptKind::Launch(_)) {
                    return Err(Error::Ignored(Ignored::Repeat));
                }
                s.session = self.tx.session(own_session(a.id)?)?;
                s.thought = self.tx.thought(*owner)?;
            }
            Event::Surveyed { thought, .. } => self.of_thought(&mut s, *thought)?,
            Event::Exited { session, .. } | Event::Shown { session, .. } => {
                self.of_session(&mut s, *session)?
            }
            Event::Adopt { terminal, .. } => s.session = self.tx.terminal_session(*terminal)?,
            Event::Report(r) => {
                let session = self.tx.session(r.session)?.ok_or(Error::Gone)?;
                let turn = match r.event {
                    A::TurnStarted { .. } => session.turn.saturating_add(1),
                    _ => session.turn,
                };
                let ignored = if session.terminal_id != Some(r.terminal) {
                    Some(Ignored::OldToken)
                } else if r.subagent {
                    Some(Ignored::Subagent)
                } else if r.turn.is_some_and(|t| t != turn) {
                    Some(Ignored::OtherTurn)
                // Activity stores nothing, so it is not worth remembering.
                } else if !matches!(r.event, A::Activity { .. })
                    && !self.tx.see_event(session.id, &r.id)?
                {
                    Some(Ignored::Repeat)
                } else {
                    None
                };
                if let Some(why) = ignored {
                    return Err(Error::Ignored(why));
                }
                self.of_session(&mut s, session.id)?;
            }
            Event::Ask { question, .. } => {
                s.question = self.tx.question(question.id)?;
                self.around(&mut s, question.thought_id, question.session_id)?;
            }
            Event::Answer { question, .. } | Event::Withdraw { question } => {
                let q = self.tx.question(*question)?.ok_or(Error::Gone)?;
                self.around(&mut s, q.thought_id, q.session_id)?;
                s.question = Some(q);
            }
        }
        Ok(Some(s))
    }

    fn of_thought(&mut self, s: &mut Subject, id: ThoughtId) -> Result<()> {
        let t = self.tx.thought(id)?.ok_or(Error::Gone)?;
        self.around(s, None, t.session_id)?;
        s.thought = Some(t);
        Ok(())
    }

    fn of_session(&mut self, s: &mut Subject, id: SessionId) -> Result<()> {
        let session = self.tx.session(id)?.ok_or(Error::Gone)?;
        self.around(s, session.thought_id, None)?;
        s.session = Some(session);
        Ok(())
    }

    fn around(
        &mut self,
        s: &mut Subject,
        thought: Option<ThoughtId>,
        session: Option<SessionId>,
    ) -> Result<()> {
        if let Some(id) = thought {
            s.thought = self.tx.thought(id)?;
        }
        if let Some(id) = session {
            s.session = self.tx.session(id)?;
        }
        Ok(())
    }

    /// Whether the attempt was made before with these arguments; another
    /// kind, record or argument hash under the same id is a conflict.
    fn repeated(&mut self, id: AttemptId, kind: AttemptKind, hash: Hash) -> Result<bool> {
        match self.tx.attempt(id)? {
            None => Ok(false),
            Some(a) if a.kind == kind && a.args_hash == hash => {
                self.effects.push(Effect::Repeat(a.outcome));
                Ok(true)
            }
            Some(_) => Err(Error::Conflict(
                "the attempt id was used with other arguments",
            )),
        }
    }

    fn capture(&mut self, c: Capture, agent: String, record: Attempt) -> Result<()> {
        let mode = c.mode.unwrap_or(Mode::Ask);
        // A destination given at capture is the person's own pick.
        let pick = match (mode, c.session_id, c.project_id) {
            (Mode::Note, ..) | (_, None, None) => None,
            (_, Some(session), _) => Some(Destination::Session(session)),
            (_, None, Some(project)) => Some(Destination::New(project)),
        };
        if let Some(to) = pick {
            self.target(to)?;
        }
        let t = Thought {
            id: c.id,
            rev: Rev::ZERO,
            text: c.text,
            strokes: c.strokes,
            source: c.source,
            mode,
            phase: P::Captured,
            status: Status::Captured,
            reason: None,
            live: false,
            project_id: c.project_id,
            session_id: None,
            brief: None,
            route: None,
            // Saved for later by the person: nobody is asked about a note.
            placed: (mode == Mode::Note).then_some(Placed::Kept),
            agent: Some(agent),
            model: c.model,
            workdir: None,
            hold_until: None,
            read: false,
            created: self.now,
            updated: self.now,
        };
        self.tx.insert_thought(&t)?;
        self.tx.insert_attempt(&record)?;
        match pick {
            Some(to) => {
                let now = self.now;
                self.route(t, to, None, now, Placed::Picked)
            }
            None if mode == Mode::Note => Ok(()),
            None => {
                let mut t = t;
                let by = self.consent()?;
                self.ask(&mut t, c.current, by, None);
                self.save(t)
            }
        }
    }

    /// The person's consent to route by a model: the tool and the model it covers.
    fn consent(&self) -> Result<Option<RouteBy>> {
        Ok(match self.tx.pref(PrefKey::RouteBy)?.map(|p| p.value) {
            Some(PrefValue::RouteBy(by)) => by,
            _ => None,
        })
    }

    /// Asks the router about a thought: a model with the person's consent
    /// `by`, else the match on names. Until it answers the thought's
    /// `route` is pending.
    fn ask(
        &mut self,
        t: &mut Thought,
        current: Option<SessionId>,
        by: Option<RouteBy>,
        picked: Option<Destination>,
    ) {
        t.route = Some(Routing {
            by: by.as_ref().map_or(LOCAL.into(), |by| by.agent.clone()),
            model: by.as_ref().map(|by| by.model.clone()),
            pending: true,
            ..Routing::default()
        });
        self.effects.push(Effect::Route {
            thought: t.id,
            current,
            by,
            picked,
        });
    }

    /// The router's answer is no longer waited for: it is stopped.
    fn unask(&mut self, t: &mut Thought, why: &str) {
        if let Some(route) = t.route.as_mut().filter(|r| r.pending) {
            route.pending = false;
            route.fallback = Some(why.into());
            self.effects.push(Effect::Unroute(t.id));
        }
    }

    /// The router found one destination. The hold counts from the capture,
    /// so the time the router took is not added to it. A destination that
    /// went meanwhile leaves the thought an idea. One that stays in the
    /// session it was captured in is a follow-up there, whoever answered.
    fn routed(
        &mut self,
        mut t: Thought,
        to: Destination,
        brief: String,
        how: Routing,
        current: Option<SessionId>,
    ) -> Result<()> {
        let kept = unplaced(&how);
        let placed = match to {
            Destination::Session(s) if current == Some(s) => Placed::FollowUp,
            _ if how.by == LOCAL => Placed::Name,
            _ => Placed::Model,
        };
        t.route = Some(how);
        match self.target(to) {
            Ok(_) => {
                let since = t.created;
                self.route(t, to, Some(brief), since, placed)
            }
            Err(Error::Gone) => {
                let route = t.route.as_mut().expect("set above");
                route.fallback = Some("the folder or session it found is gone".into());
                self.keep_as_idea(t, None, kept)
            }
            Err(e) => Err(e),
        }
    }

    /// The brief of a thought the person picked the destination of
    /// arrived. Its hold goes on for as long as the brief is to be read.
    fn briefed(&mut self, mut t: Thought, brief: String, how: Routing) -> Result<()> {
        t.brief = Some(brief);
        t.route = Some(how);
        if let Some(held) = t.hold_until {
            let until = self.held(held)?;
            t.hold_until = Some(until);
            self.effects.push(Effect::Hold {
                thought: t.id,
                until,
            });
        }
        self.save(t)
    }

    /// The seconds the person has a routed thought held: a preference.
    fn hold(&self) -> Result<u64> {
        let pref = self.tx.pref(PrefKey::Hold)?;
        Ok(match pref.map_or(PrefKey::Hold.default(), |p| p.value) {
            PrefValue::Hold(hold) => u64::from(hold),
            _ => 0,
        })
    }

    /// When a hold ends, for a route or a brief that arrives now (design
    /// §5): at `planned`, the end the person's hold gives it, and no
    /// earlier than [`READ_HOLD`] from now, so that what arrived is there
    /// to read before the launch. Where the person's hold is shorter than
    /// that, it is their hold from now; with no hold it ends at once.
    fn held(&self, planned: Time) -> Result<Time> {
        let read = self.hold()?.min(u64::from(READ_HOLD));
        Ok(planned.max(after(self.now, read)?))
    }

    /// The project a destination is in, and its session for a follow-up.
    fn target(&self, to: Destination) -> Result<(ProjectId, Option<Session>)> {
        match to {
            Destination::New(project) => {
                self.tx.project(project)?.ok_or(Error::Gone)?;
                Ok((project, None))
            }
            Destination::Session(id) => {
                let s = self.tx.session(id)?.ok_or(Error::Gone)?;
                Ok((s.project_id, Some(s)))
            }
        }
    }

    /// Routes a thought to `to`; its hold counts from `since` and ends no
    /// earlier than now. Without a brief, one the person picked the
    /// destination of, the router is asked for the brief alone when the
    /// person consented to a model, unless the thought is short enough to
    /// go on as it is or a model was asked about it before and failed.
    fn route(
        &mut self,
        mut t: Thought,
        to: Destination,
        brief: Option<String>,
        since: Time,
        placed: Placed,
    ) -> Result<()> {
        let (project, session) = self.target(to)?;
        t.placed = Some(placed);
        let until = self.held(after(since, self.hold()?)?)?;
        // Picked while the router was still asked where it goes.
        self.unask(&mut t, "you picked where it goes");
        let failed = t.route.as_ref().is_some_and(|r| r.fallback.is_some());
        let wordy = brief.is_none() && t.brief.is_none() && !crate::route::short(&t.text);
        if let (true, false, Some(by)) = (wordy, failed, self.consent()?) {
            self.ask(&mut t, None, Some(by), Some(to));
        }
        // Picked while the router's question was still open: that question is moot.
        let id = t.id;
        self.close(
            |q| q.thought_id == Some(id) && q.source == QuestionSource::Router,
            Q::Withdrawn,
        )?;
        t.project_id = Some(project);
        t.mode = if session.is_some() {
            Mode::Nudge
        } else {
            Mode::Ask
        };
        if let Some(s) = &session {
            t.agent = Some(s.agent.clone());
        }
        t.session_id = session.map(|s| s.id);
        if brief.is_some() {
            t.brief = brief;
        }
        t.phase = P::Routed;
        t.hold_until = Some(until);
        self.effects.push(Effect::Hold { thought: id, until });
        self.save(t)
    }

    fn ask_router(
        &mut self,
        mut t: Thought,
        prompt: String,
        candidates: Vec<Candidate>,
        brief: Option<String>,
        how: Routing,
    ) -> Result<()> {
        t.route = Some(how);
        t.brief = brief.or(t.brief);
        let id: QuestionId = self.mint(&[b"router", t.id.uuid().as_bytes()])?;
        let key = router_key(id, &candidates);
        let places = candidates.iter().map(|c| c.to.into()).collect();
        let q = Question {
            id,
            rev: Rev::ZERO,
            thought_id: Some(t.id),
            session_id: None,
            turn: None,
            source: QuestionSource::Router,
            kind: QuestionKind::Choice {
                choices: candidates.into_iter().map(|c| c.label).collect(),
            },
            places: Some(places),
            prompt,
            detail: None,
            reply_via: ReplyVia::Core,
            state: Q::Open,
            answer: None,
        };
        self.tx.insert_question(&q, &key)?;
        self.effects.push(Effect::Notify(id));
        self.save(t)
    }

    fn answer_router(
        &mut self,
        t: Thought,
        q: Question,
        response: Response,
        device: Option<DeviceId>,
    ) -> Result<()> {
        fits(&q, &response)?;
        let to = match &response {
            Response::Choice { choice } => {
                let key = self.tx.request_key(q.id)?.unwrap_or_default();
                let to = *destinations(&key)
                    .get(*choice as usize)
                    .ok_or(Error::Invalid("the question has no such choice"))?;
                self.target(to)?;
                Some(to)
            }
            // Declining every candidate keeps the thought as an idea, as `unknown` does.
            _ => None,
        };
        self.store_answer(q.id, response, device)?;
        match to {
            Some(to) => {
                let now = self.now;
                self.route(t, to, None, now, Placed::Answer)
            }
            None => self.keep_as_idea(t, None, Placed::KeptAnswer),
        }
    }

    fn keep_as_idea(&mut self, mut t: Thought, how: Option<Routing>, why: Placed) -> Result<()> {
        t.mode = Mode::Note;
        t.route = how.or(t.route);
        t.placed = Some(why);
        self.save(t)
    }

    /// Starts a routed thought: a nudge goes to its session while that runs;
    /// anything else starts a new session, which continues the conversation
    /// of a nudge's ended session.
    fn launch(&mut self, mut t: Thought, attempt: AttemptId, by_hand: bool) -> Result<()> {
        let target = match (t.mode, t.session_id) {
            (Mode::Nudge, Some(id)) => self.tx.session(id)?,
            _ => None,
        };
        // Started by hand while its brief was still being written: it goes without.
        self.unask(&mut t, "it was started before its brief arrived");
        // The brief, and with it the person's own words unless it says the same.
        let brief = t.brief.clone();
        let (text, words) = match brief.filter(|b| !crate::route::same(b, &t.text)) {
            Some(brief) => (brief, Some(t.text.clone())),
            None => (t.text.clone(), None),
        };
        let running = target
            .as_ref()
            .filter(|s| s.state != S::Ended)
            .map(|s| s.id);
        let effect = if let Some(session) = running {
            Effect::Deliver(Deliver {
                attempt,
                thought: t.id,
                session,
                text,
                words,
            })
        } else {
            let project = t
                .project_id
                .ok_or(Error::Invalid("a thought starts in a folder"))?;
            let p = self.tx.project(project)?.ok_or(Error::Gone)?;
            let (cwd, worktree) = self.place(&t, &p, target.as_ref(), attempt)?;
            let agent = target
                .as_ref()
                .map(|s| s.agent.clone())
                .or_else(|| t.agent.clone())
                .ok_or(Error::Invalid("a thought starts with an agent"))?;
            // A new run is named by the title a model gave the work.
            let title = t.route.as_ref().and_then(|r| r.title.clone());
            let title = title.filter(|_| target.is_none());
            let session = Session {
                id: own_session(attempt)?,
                rev: Rev::ZERO,
                project_id: project,
                agent: agent.clone(),
                terminal_id: None,
                adopted: false,
                state: S::Starting,
                thought_id: Some(t.id),
                turn: 0,
                resume: None,
                named_at: title.as_ref().map(|_| self.now),
                name: title,
                model: t.model.clone(),
                cwd,
                exit: None,
                error: None,
                activity: Vec::new(),
            };
            self.tx.insert_session(&session)?;
            t.session_id = Some(session.id);
            Effect::Launch(Launch {
                attempt,
                thought: t.id,
                session: session.id,
                project,
                cwd: session.cwd,
                agent,
                model: t.model.clone(),
                prompt: text,
                words,
                resume: target.and_then(|s| s.resume),
                worktree,
            })
        };
        self.tx.insert_attempt(&Attempt {
            id: attempt,
            kind: AttemptKind::Launch(t.id),
            args_hash: launch_hash(t.id),
            started: self.now,
            outcome: None,
        })?;
        // A fired timer needs no cancelling; a Start during the hold does.
        if t.hold_until.take().is_some() && by_hand {
            self.effects.push(Effect::Unhold(t.id));
        }
        self.effects.push(effect);
        t.phase = P::Working;
        self.save(t)
    }

    fn undo(&mut self, mut t: Thought) -> Result<()> {
        self.unask(&mut t, "it was undone");
        if t.hold_until.take().is_some() {
            self.effects.push(Effect::Unhold(t.id));
        }
        t.phase = P::Captured;
        self.save(t)
    }

    fn launched(&mut self, session: Option<Session>, terminal: Option<TerminalId>) -> Result<()> {
        let (Some(mut s), Some(terminal)) = (session, terminal) else {
            return Ok(());
        };
        s.terminal_id = Some(terminal);
        // Stopped before its launch was reported: what it started must end too.
        if s.state == S::Ended {
            self.effects.push(Effect::Kill {
                session: s.id,
                terminal: Some(terminal),
            });
        }
        Ok(self.tx.update_session(&s)?)
    }

    fn launch_failed(
        &mut self,
        thought: Option<Thought>,
        session: Option<Session>,
        attempt: AttemptId,
        error: String,
    ) -> Result<()> {
        // A launch ends the session it made; a failed follow-up leaves its session alone.
        let own = session.as_ref().map(|s| s.id);
        if let Some(s) = session.filter(|s| s.state != S::Ended) {
            self.look(&s)?;
            self.end(s, None, Some(error.clone()))?;
        }
        // A follow-up its agent began already (its turn_started came first)
        // was typed after all: its turn decides how it ends.
        let begun = match (&thought, own) {
            (Some(t), None) => match t.session_id {
                Some(id) => (self.tx.session(id)?)
                    .is_some_and(|s| s.state == S::Working && s.thought_id == Some(t.id)),
                None => false,
            },
            _ => false,
        };
        match thought {
            Some(mut t)
                if t.phase == P::Working && !begun && (own.is_none() || t.session_id == own) =>
            {
                t.phase = P::Failed;
                t.reason = Some(Reason::Launch);
                // Why the run did not start, or the follow-up was not typed.
                let result = TurnResult {
                    id: self.mint(&[b"failure", attempt.uuid().as_bytes()])?,
                    rev: Rev::ZERO,
                    thought_id: t.id,
                    session_id: t.session_id,
                    turn: None,
                    kind: ResultKind::Failure,
                    summary: summary(&error),
                };
                self.tx.insert_result(&result, &error)?;
                self.save(t)
            }
            _ => Ok(()),
        }
    }

    /// An agent started by hand in a shell: a new session of the shell's
    /// terminal, in the shell's project or else the scratch.
    fn adopt(
        &mut self,
        id: SessionId,
        terminal: TerminalId,
        agent: String,
        cwd: String,
    ) -> Result<()> {
        let shell = self.tx.terminal(terminal)?.ok_or(Error::Gone)?;
        if shell.kind != TerminalKind::Shell || shell.state != TerminalState::Running {
            return Err(Error::Invalid(
                "an agent is adopted only in a running shell",
            ));
        }
        // Nothing starts to work in a worktree that is being kept or discarded.
        if let Some(owner) = self.owner(&cwd)?
            && self.settling(owner.id)?
        {
            return Err(Error::Conflict(SETTLING));
        }
        let project_id = match shell.project_id {
            Some(project) => project,
            None => self.tx.scratch()?.ok_or(Error::Gone)?.id,
        };
        let session = Session {
            id,
            rev: Rev::ZERO,
            project_id,
            agent,
            terminal_id: Some(terminal),
            adopted: true,
            state: S::Starting,
            thought_id: None,
            turn: 0,
            resume: None,
            name: None,
            named_at: None,
            model: None,
            cwd,
            exit: None,
            error: None,
            activity: Vec::new(),
        };
        Ok(self.tx.insert_session(&session)?)
    }

    fn ready(&mut self, mut s: Session) -> Result<()> {
        self.went_on(&s)?;
        s.state = S::Idle;
        Ok(self.tx.update_session(&s)?)
    }

    /// The agent went on from what it showed in its terminal before it was
    /// ready: the person answered there.
    fn went_on(&mut self, s: &Session) -> Result<()> {
        let (id, turn) = (s.id, s.turn);
        self.close(
            |q| {
                q.session_id == Some(id)
                    && q.turn == Some(turn)
                    && q.reply_via == ReplyVia::Terminal
            },
            Q::Answered,
        )
    }

    fn start_turn(&mut self, mut s: Session, prompt: Option<String>) -> Result<()> {
        if s.state == S::Starting {
            self.went_on(&s)?;
        }
        s.turn = s.turn.saturating_add(1);
        s.state = S::Working;
        let waiting = self
            .tx
            .thoughts_in_flight(s.id)?
            .into_iter()
            .find(|t| t.phase == P::Working);
        s.thought_id = match (waiting, prompt) {
            (Some(t), _) => Some(t.id),
            (None, Some(text)) => Some(self.typed(&s, text)?),
            (None, None) => None,
        };
        // The turn's first activity line: an answer that uses no tool
        // reports no other, and a working thought should show it is under way.
        self.effects.push(Effect::Activity {
            session: s.id,
            text: TURN_STARTED.into(),
        });
        Ok(self.tx.update_session(&s)?)
    }

    /// A prompt typed by hand into the agent's terminal becomes a thought,
    /// so everything in flight is listed (design, Defaults chosen 3).
    fn typed(&mut self, s: &Session, text: String) -> Result<ThoughtId> {
        let id = self.mint(&[b"typed", s.id.uuid().as_bytes(), &s.turn.to_be_bytes()])?;
        self.tx.insert_thought(&Thought {
            id,
            rev: Rev::ZERO,
            text,
            strokes: Vec::new(),
            source: Source::Terminal,
            mode: Mode::Ask,
            phase: P::Working,
            status: Status::Working,
            reason: None,
            live: false,
            project_id: Some(s.project_id),
            session_id: Some(s.id),
            brief: None,
            route: None,
            placed: Some(Placed::Picked),
            agent: Some(s.agent.clone()),
            model: s.model.clone(),
            workdir: None,
            hold_until: None,
            read: false,
            created: self.now,
            updated: self.now,
        })?;
        Ok(id)
    }

    fn activity(&mut self, s: Session, text: String) -> Result<()> {
        self.effects.push(Effect::Activity {
            session: s.id,
            text,
        });
        Ok(())
    }

    fn open(&mut self, q: Question, key: String) -> Result<()> {
        self.room(&q)?;
        let q = Question {
            state: Q::Open,
            answer: None,
            ..q
        };
        self.tx.insert_question(&q, &key)?;
        self.effects.push(Effect::Notify(q.id));
        self.refresh(q.thought_id)
    }

    /// What its agent waits on in its terminal before it is ready, as a
    /// question answered there; shown again it is the same question.
    fn shown(&mut self, s: Session, prompt: String) -> Result<()> {
        let ask = tasktap_proto::Ask {
            request: format!("shown {prompt}"),
            kind: QuestionKind::Confirm,
            prompt,
            detail: None,
            source: None,
        };
        let (question, key) = self.in_terminal(&s, ask)?;
        if self.tx.question_by_request(&key)?.is_some() {
            return Err(Error::Ignored(Ignored::Repeat));
        }
        self.open(question, key)
    }

    /// A terminal-only question (design §6), keyed by the session, its turn
    /// and the agent's own id for the call.
    fn hook(&mut self, s: Session, ask: tasktap_proto::Ask) -> Result<()> {
        let (question, key) = self.in_terminal(&s, ask)?;
        self.apply(E::Ask { question, key })
    }

    fn in_terminal(&mut self, s: &Session, ask: tasktap_proto::Ask) -> Result<(Question, String)> {
        let key = format!("hook {} {} {}", s.id.uuid(), s.turn, ask.request);
        let id = match self.tx.question_by_request(&key)? {
            Some(q) => q.id,
            None => self.mint(&[b"hook", key.as_bytes()])?,
        };
        let question = Question {
            id,
            rev: Rev::ZERO,
            thought_id: s.thought_id,
            session_id: Some(s.id),
            turn: Some(s.turn),
            source: ask.source.unwrap_or(QuestionSource::Agent),
            kind: ask.kind,
            places: None,
            prompt: ask.prompt,
            detail: ask.detail,
            reply_via: ReplyVia::Terminal,
            state: Q::Open,
            answer: None,
        };
        Ok((question, key))
    }

    fn reopen(&mut self, q: Question) -> Result<()> {
        self.room(&q)?;
        self.tx.set_question_state(q.id, Q::Open)?;
        self.effects.push(Effect::Notify(q.id));
        self.refresh(q.thought_id)
    }

    /// Open questions are bounded per session and in all (design §6): beyond
    /// that an agent's question waits until one closes.
    fn room(&self, q: &Question) -> Result<()> {
        let Some(session) = q.session_id else {
            return Ok(());
        };
        let (mine, all) = self.tx.open_asked(session)?;
        if mine >= MAX_SESSION_QUESTIONS || all >= MAX_OPEN_QUESTIONS {
            return Err(Error::Conflict(
                "too many questions are open; one must close before another opens",
            ));
        }
        Ok(())
    }

    fn answer(&mut self, q: Question, response: Response, device: Option<DeviceId>) -> Result<()> {
        fits(&q, &response)?;
        self.store_answer(q.id, response, device)?;
        if q.reply_via == ReplyVia::Core {
            self.effects.push(Effect::Answer(q.id));
        }
        self.refresh(q.thought_id)
    }

    fn store_answer(
        &mut self,
        question: QuestionId,
        response: Response,
        device: Option<DeviceId>,
    ) -> Result<()> {
        self.tx.insert_answer(
            question,
            &Answer {
                response,
                device_id: device,
                created: self.now,
                delivered: None,
            },
        )?;
        Ok(self.tx.set_question_state(question, Q::Answered)?)
    }

    fn withdraw(&mut self, q: Question) -> Result<()> {
        self.tx.set_question_state(q.id, Q::Withdrawn)?;
        self.refresh(q.thought_id)
    }

    /// The agent went on: the turn's terminal-only questions were answered
    /// in the terminal, and so was the waited question `request` names, if
    /// it is still open; its waiter gets that answer.
    fn continued(&mut self, s: Session, request: Option<String>) -> Result<()> {
        let (id, turn) = (s.id, s.turn);
        let waited = match request {
            Some(request) => self.tx.question_by_request(&ask_key(id, &request))?,
            None => None,
        };
        let waited = waited.filter(|q| {
            q.state == Q::Open && q.reply_via == ReplyVia::Core && q.turn == Some(turn)
        });
        let waited = waited.map(|q| q.id);
        self.close(
            |q| {
                q.session_id == Some(id)
                    && q.turn == Some(turn)
                    && (q.reply_via == ReplyVia::Terminal || Some(q.id) == waited)
            },
            Q::Answered,
        )?;
        self.effects.extend(waited.map(Effect::Answer));
        Ok(())
    }

    fn end_turn(&mut self, mut s: Session, thought: Option<Thought>, ending: Ending) -> Result<()> {
        let (id, turn) = (s.id, s.turn);
        self.close(
            |q| q.session_id == Some(id) && q.turn == Some(turn),
            Q::Withdrawn,
        )?;
        s.state = S::Idle;
        let mut t = thought.filter(|t| t.phase == P::Working && t.session_id == Some(id));
        match ending {
            Ending::Finished(answer) => {
                if let (Some(t), Some(body)) = (&mut t, answer) {
                    let result = TurnResult {
                        id: self.mint(&[
                            b"result",
                            t.id.uuid().as_bytes(),
                            id.uuid().as_bytes(),
                        ])?,
                        rev: Rev::ZERO,
                        thought_id: t.id,
                        session_id: Some(id),
                        turn: Some(turn),
                        kind: ResultKind::Answer,
                        summary: summary(&body),
                    };
                    self.tx.insert_result(&result, &body)?;
                }
                if let Some(t) = &mut t {
                    t.phase = P::Done;
                }
            }
            Ending::Failed(reason, error) => {
                s.error = error.or(s.error);
                if let Some(t) = &mut t {
                    t.phase = P::Failed;
                    t.reason = Some(reason);
                }
            }
        }
        self.tx.update_session(&s)?;
        self.look(&s)?;
        t.map_or(Ok(()), |t| self.save(t))
    }

    fn exited(&mut self, s: Session, code: Option<u32>, silent: bool) -> Result<()> {
        let id = s.id;
        self.look(&s)?;
        self.end(s, code, None)?;
        // An agent that sends no events reports its work only by exiting.
        let done = silent && code == Some(0);
        for mut t in self.tx.thoughts_in_flight(id)? {
            if t.phase == P::Working {
                (t.phase, t.reason) = if done {
                    (P::Done, None)
                } else {
                    (P::Failed, Some(Reason::Exited))
                };
                self.save(t)?;
            }
        }
        Ok(())
    }

    fn stop(&mut self, mut t: Thought, session: Option<Session>) -> Result<()> {
        if let Some(s) = session.filter(|s| s.state != S::Ended) {
            let id = s.id;
            // An adopted agent's terminal runs the person's shell, which
            // stopping the agent must not end: its shim ends the agent.
            self.effects.push(match s.adopted {
                true => Effect::StopAdopted(id),
                false => Effect::Kill {
                    session: id,
                    terminal: s.terminal_id,
                },
            });
            self.look(&s)?;
            self.end(s, None, None)?;
            // Follow-ups waiting in the same process are stopped with it.
            for mut other in self.tx.thoughts_in_flight(id)? {
                if other.phase == P::Working && other.id != t.id {
                    other.phase = P::Failed;
                    other.reason = Some(Reason::Stopped);
                    self.save(other)?;
                }
            }
        }
        t.phase = P::Failed;
        t.reason = Some(Reason::Stopped);
        self.save(t)
    }

    fn retry(&mut self, mut t: Thought) -> Result<()> {
        t.phase = P::Routed;
        t.reason = None;
        t.read = false;
        self.save(t)
    }

    fn read(&mut self, mut t: Thought) -> Result<()> {
        if t.read {
            return Err(Error::Ignored(Ignored::Repeat));
        }
        t.read = true;
        self.save(t)
    }

    fn settle(&mut self, t: Thought, attempt: AttemptId, keep: bool) -> Result<()> {
        self.tx.insert_attempt(&Attempt {
            id: attempt,
            kind: AttemptKind::Settle(t.id),
            args_hash: settle_hash(t.id, keep),
            started: self.now,
            outcome: None,
        })?;
        self.effects.push(Effect::Settle {
            attempt,
            thought: t.id,
            keep,
        });
        Ok(())
    }

    fn settled(&mut self, mut t: Thought, attempt: Option<Attempt>, kept: bool) -> Result<()> {
        // The attempt's hash says whether it was a tidy, which changes no record.
        if attempt.map(|a| a.args_hash) == Some(tidy_hash(t.id)) {
            return Ok(());
        }
        if let Some(w) = &mut t.workdir {
            w.changes = match kept {
                true => Changes::Kept,
                false => Changes::Discarded,
            };
        }
        self.save(t)
    }

    /// Where a new run of `t` works (design §7, "Isolation"): the thought's
    /// own worktree while it holds anything unsettled; the worktree whose
    /// changes wait for the conversation it continues; otherwise a new
    /// worktree when the project is a git repository whose setting says so
    /// (`always`, or `busy` while one of its sessions starts or works or
    /// another thought's changes wait there); otherwise the project folder.
    fn place(
        &self,
        t: &Thought,
        p: &Project,
        resumed: Option<&Session>,
        attempt: AttemptId,
    ) -> Result<(String, Option<Worktree>)> {
        let again = |owner: ThoughtId, w: &Workdir| {
            let workdir = Box::new(w.clone());
            (w.path.clone(), Some(Worktree::Again { owner, workdir }))
        };
        if let Some(w) = t.workdir.as_ref().filter(|w| open(w)) {
            if self.settling(t.id)? {
                return Err(Error::Conflict(SETTLING));
            }
            return Ok(again(t.id, w));
        }
        if let Some(owner) = resumed.map(|s| self.owner(&s.cwd)).transpose()?.flatten()
            && pending(&Some(owner.clone()))
            && !self.settling(owner.id)?
            && let Some(w) = &owner.workdir
        {
            return Ok(again(owner.id, w));
        }
        let isolated = p.git
            && p.kind == ProjectKind::Folder
            && match p.isolate {
                Isolate::Never => false,
                Isolate::Always => true,
                Isolate::Busy => self.tx.busy(p.id)?,
            };
        let hex = attempt.uuid().simple().to_string();
        let name = hex[hex.len() - NAME..].to_owned();
        Ok((p.folder.clone(), isolated.then_some(Worktree::New { name })))
    }

    /// Records the worktree a launch made on its owner, never in place of
    /// another that holds something unsettled, and has the launch's session
    /// work in it. Found again unchanged, what was looked at still holds.
    fn prepared(&mut self, mut t: Thought, session: Option<Session>, w: Workdir) -> Result<()> {
        if !made(&w) {
            return Err(Error::Invalid("that is no copy Tasktap makes"));
        }
        match &t.workdir {
            Some(old) if open(old) && old.branch != w.branch => {
                return Err(Error::Ignored(Ignored::State));
            }
            Some(old) if old.branch == w.branch && old.base == w.base => {}
            _ => {
                t.workdir = Some(w.clone());
                self.save(t)?;
            }
        }
        if let Some(mut s) = session {
            s.cwd = w.path;
            self.tx.update_session(&s)?;
        }
        Ok(())
    }

    /// What a look found: the changes pending or none, with their size. A
    /// settle the core stopped during happened when it left neither the
    /// folder nor the branch; anything it left is pending again, for the
    /// person's next Keep or Discard. A worktree with nothing to lose is
    /// tidied once nothing works in it. While a settle or tidy runs, a look
    /// counts for nothing.
    fn surveyed(&mut self, mut t: Thought, path: String, found: Found) -> Result<()> {
        // A look from before a settle under way would undo what it records.
        if self.settling(t.id)? {
            return Err(Error::Ignored(Ignored::State));
        }
        let stopped = self.tx.settles(t.id)?.pop();
        let stopped = stopped.filter(|a| a.outcome == Some(AttemptOutcome::Interrupted));
        let was = |keep| stopped.as_ref().map(|a| a.args_hash) == Some(settle_hash(t.id, keep));
        let (keep, discard) = (was(true), was(false));
        let Some(w) = t.workdir.as_mut().filter(|w| w.path == path && open(w)) else {
            return Err(Error::Ignored(Ignored::State));
        };
        // None only where nothing would be lost: anything staged, untracked
        // or ignored, or a worktree git no longer ties to its branch, waits
        // for the person.
        w.changes = match () {
            () if keep && found.gone => Changes::Kept,
            () if discard && found.gone => Changes::Discarded,
            () if found.gone || found.spare => Changes::Clean,
            () => Changes::Pending,
        };
        if matches!(w.changes, Changes::Pending | Changes::Clean) {
            (w.files, w.insertions, w.deletions) = (found.files, found.insertions, found.deletions);
        }
        let tidy = w.changes == Changes::Clean
            && found.spare
            && !found.gone
            && !self.tx.occupied(&path)?
            && !self.settling(t.id)?;
        if tidy {
            let n = self.tx.settles(t.id)?.len() as u64;
            let attempt = self.mint(&[b"tidy", t.id.uuid().as_bytes(), &n.to_be_bytes()])?;
            self.tx.insert_attempt(&Attempt {
                id: attempt,
                kind: AttemptKind::Settle(t.id),
                args_hash: tidy_hash(t.id),
                started: self.now,
                outcome: None,
            })?;
            self.effects.push(Effect::Tidy {
                attempt,
                thought: t.id,
            });
        }
        self.save(t)
    }

    /// A run in a worktree paused or ended: its changes are looked at again.
    fn look(&mut self, s: &Session) -> Result<()> {
        if let Some(owner) = self.owner(&s.cwd)? {
            self.effects.push(Effect::Survey(owner.id));
        }
        Ok(())
    }

    /// The thought whose unsettled worktree holds `cwd`.
    fn owner(&self, cwd: &str) -> Result<Option<Thought>> {
        let inside = |t: &Thought| {
            (t.workdir.as_ref()).is_some_and(|w| open(w) && Path::new(cwd).starts_with(&w.path))
        };
        Ok(self.tx.worktrees()?.into_iter().find(inside))
    }

    /// Whether a session or a terminal works in the thought's worktree.
    fn occupied(&self, t: &Thought) -> Result<bool> {
        match &t.workdir {
            Some(w) => Ok(self.tx.occupied(&w.path)?),
            None => Ok(false),
        }
    }

    /// Whether a settle or tidy of the thought's worktree is under way.
    fn settling(&self, thought: ThoughtId) -> Result<bool> {
        Ok(self
            .tx
            .settles(thought)?
            .iter()
            .any(|a| a.outcome.is_none()))
    }

    fn end(&mut self, mut s: Session, exit: Option<u32>, error: Option<String>) -> Result<()> {
        s.state = S::Ended;
        s.exit = exit.or(s.exit);
        s.error = error.or(s.error);
        self.tx.update_session(&s)?;
        let id = s.id;
        self.close(|q| q.session_id == Some(id), Q::Withdrawn)
    }

    /// Closes the open questions `which` picks. `Answered` is only ever the
    /// person answering in the agent's terminal.
    fn close(&mut self, which: impl Fn(&Question) -> bool, to: Q) -> Result<()> {
        let mut thoughts = BTreeSet::new();
        for q in self.tx.open_questions()?.into_iter().filter(|q| which(q)) {
            if to == Q::Answered {
                self.tx.insert_answer(
                    q.id,
                    &Answer {
                        response: Response::Terminal,
                        device_id: None,
                        created: self.now,
                        delivered: None,
                    },
                )?;
            }
            self.tx.set_question_state(q.id, to)?;
            thoughts.extend(q.thought_id);
        }
        for id in thoughts {
            self.refresh(Some(id))?;
        }
        Ok(())
    }

    /// Re-derives a thought's status after its questions changed.
    fn refresh(&mut self, thought: Option<ThoughtId>) -> Result<()> {
        let Some(t) = thought.map(|id| self.tx.thought(id)).transpose()?.flatten() else {
            return Ok(());
        };
        if self.status(&t)? != t.status {
            self.save(t)?;
        }
        Ok(())
    }

    /// Every thought is written here, so its status is always derived.
    fn save(&mut self, mut t: Thought) -> Result<()> {
        t.status = self.status(&t)?;
        t.updated = self.now;
        Ok(self.tx.update_thought(&t)?)
    }

    fn status(&self, t: &Thought) -> Result<Status> {
        Ok(if self.tx.asking(t.id)? {
            Status::NeedsYou
        } else {
            t.phase.into()
        })
    }

    /// A UUID v7 for a record this module creates: the time is now and the
    /// rest comes from what the record is unique to, so applying the same
    /// event twice cannot make two.
    fn mint<I: DeserializeOwned>(&self, parts: &[&[u8]]) -> Result<I> {
        Ok(uuid(self.now, &digest(parts))?)
    }
}

/// A new random id at `now`, the core's clock, for a record the core creates
/// outside an event, so every id it mints carries the same clock.
/// `preview.open`, once its target is one a preview may show (design §9,
/// "Previews"): a file inside a folder the person opened, by its real
/// path, or a web address of this machine. The preview is shown beside a
/// terminal the store knows, running or not, and lasts as long as that
/// terminal's record: it is closed by `delete`, and goes with the terminal
/// when that is deleted or pruned. The same target beside the same
/// terminal is the preview that is open already, whoever opens it again;
/// one more than [`MAX_PREVIEWS`] beside one terminal is `conflict`, so
/// neither a page nor an agent can pile them up.
pub fn preview(
    tx: &mut Tx<'_>,
    now: Time,
    terminal: TerminalId,
    (kind, target, title): (PreviewKind, String, String),
    by: PreviewBy,
) -> Result<PreviewId> {
    if tx.terminal(terminal)?.is_none() {
        return Err(Error::Gone);
    }
    let open = tx.previews_of(terminal)?;
    if let Some(same) = open.iter().find(|p| p.target == target) {
        return Ok(same.id);
    }
    if open.len() >= MAX_PREVIEWS {
        return Err(Error::Conflict(
            "this terminal has 8 previews open already: close one first",
        ));
    }
    let id = fresh(now)?;
    tx.insert_preview(&Preview {
        id,
        rev: Rev::ZERO,
        terminal_id: terminal,
        kind,
        target,
        title,
        by,
    })?;
    Ok(id)
}

/// Milliseconds in a day of the `keep_days` preference.
pub const DAY: u64 = 24 * 60 * 60 * 1000;
/// Thoughts, and sessions, one step of pruning removes at most: a step is
/// one transaction on the core's thread, and the next one waits its turn.
pub const PRUNE_STEP: usize = 50;

/// What one step of pruning removed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Pruned {
    pub thoughts: usize,
    pub sessions: usize,
    /// The terminals that went with their sessions: their history files
    /// are the caller's to remove once the step is committed.
    pub terminals: Vec<TerminalId>,
    /// The step was full: another has more to remove.
    pub more: bool,
}

/// One step of pruning (design §5, row "pruned"): removes what the person
/// keeps for `days` days and is older, and nothing else.
///
/// A thought goes, with its questions, their answers, its results and the
/// attempts made for it, when it is finished (done or failed, read, no
/// changes waiting to be kept or discarded), was last changed more than
/// `days` days before `now`, has no worktree left to settle, and no
/// session that has not ended is at it as its turn. An ended session goes
/// once no thought, question or result refers to it, and the terminal an
/// agent ran in goes with its last session, with its history. Nothing that
/// is captured, routed, working, unread or pending is ever touched, nor a
/// shell, which is the person's own. With 0 days nothing goes at all.
pub fn prune(tx: &mut Tx<'_>, now: Time, days: u16) -> store::Result<Pruned> {
    let mut pruned = Pruned::default();
    if days == 0 {
        return Ok(pruned);
    }
    let kept = u64::from(days) * DAY;
    let Some(before) = now.get().checked_sub(kept).and_then(Time::new) else {
        return Ok(pruned);
    };
    let expired = tx.expired(before, PRUNE_STEP + 1)?;
    pruned.more = expired.len() > PRUNE_STEP;
    for t in expired.into_iter().take(PRUNE_STEP) {
        // An ended session is at no turn once its last one is gone.
        for s in tx.sessions_at(t.id)? {
            tx.update_session(&Session {
                thought_id: None,
                ..s
            })?;
        }
        tx.delete_thought(t.id)?;
        tx.delete_attempts(t.id)?;
        pruned.thoughts += 1;
    }
    let spent = tx.spent(PRUNE_STEP + 1)?;
    pruned.more |= spent.len() > PRUNE_STEP;
    for s in spent.into_iter().take(PRUNE_STEP) {
        tx.delete_session(s.id)?;
        pruned.sessions += 1;
        let terminal = s.terminal_id.map(|id| tx.terminal(id)).transpose()?;
        let Some(terminal) = terminal.flatten() else {
            continue;
        };
        let ended = terminal.state != TerminalState::Running;
        if terminal.kind != TerminalKind::Agent || !ended {
            continue;
        }
        match tx.delete_terminal(terminal.id) {
            // Another session ran in it and is still there.
            Err(store::Error::Reference) => {}
            deleted => {
                deleted?;
                pruned.terminals.push(terminal.id);
            }
        }
    }
    Ok(pruned)
}

/// Whether `put` and `delete` may treat a thought as plain data, editing
/// its text or removing it (design §1, §5): while it is captured and nothing
/// of it was ever launched. A note, an idea the router found no place for,
/// and a thought the person undid before it started are such; one that ever
/// ran belongs to the state machine, with its sessions, results and attempts.
pub fn plain(tx: &Tx, t: &Thought) -> store::Result<bool> {
    let asked = t.route.as_ref().is_some_and(|r| r.pending);
    Ok(t.phase == P::Captured && !asked && !tx.launched(t.id)?)
}

pub fn fresh<I: DeserializeOwned>(now: Time) -> store::Result<I> {
    uuid(now, &digest(&[&Secret::mint().0]))
}

/// A UUID v7 at `at` whose other bits are the first ten bytes of `rest`.
fn uuid<I: DeserializeOwned>(at: Time, rest: &[u8; 32]) -> store::Result<I> {
    let mut b = [0u8; 16];
    b[..6].copy_from_slice(&at.get().to_be_bytes()[2..]);
    b[6..].copy_from_slice(&rest[..10]);
    b[6] = 0x70 | (b[6] & 0x0f);
    b[8] = 0x80 | (b[8] & 0x3f);
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let text = format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    );
    Ok(serde_json::from_value(Value::String(text))?)
}

fn some<T>(record: Option<T>) -> Result<T> {
    record.ok_or(Error::Gone)
}

/// Creates are idempotent on the client's id like attempts (design §3): a
/// create is recorded as an attempt under the record's id with a hash of all
/// its arguments. Returns that record, for the caller to store with what it
/// creates, when the id is new; `None` when it came with the same arguments
/// before; `Conflict` when with others.
pub fn create(
    tx: &Tx,
    now: Time,
    kind: AttemptKind,
    args: &impl serde::Serialize,
) -> Result<Option<Attempt>> {
    let id = match kind {
        AttemptKind::Capture(t) => AttemptId::try_from(t.uuid()),
        AttemptKind::Project(p) => AttemptId::try_from(p.uuid()),
        AttemptKind::Terminal(t) => AttemptId::try_from(t.uuid()),
        _ => {
            return Err(Error::Invalid(
                "only a capture, folder or terminal is a create",
            ));
        }
    };
    let id = id.map_err(|_| Error::Invalid("ids are UUID v7"))?;
    let args = serde_json::to_vec(args).map_err(|e| Error::Store(e.into()))?;
    let args_hash = digest(&[&args]);
    match tx.attempt(id)? {
        Some(a) if (a.kind, a.args_hash) == (kind, args_hash) => Ok(None),
        Some(_) => Err(Error::Conflict("the id was used with other arguments")),
        None => Ok(Some(Attempt {
            id,
            kind,
            args_hash,
            started: now,
            outcome: Some(AttemptOutcome::Reply(Outcome::Ok(Value::Null))),
        })),
    }
}

/// `seconds` after `from`.
fn after(from: Time, seconds: u64) -> Result<Time> {
    Time::new(from.get() + seconds * 1000).ok_or(Error::Invalid(
        "the hold would end beyond the clock's range",
    ))
}

/// Who routes without a model: the match on names (`Routing::by`).
pub const LOCAL: &str = "local";

/// The match on names answered, as a route's `how`; with `why`, in place
/// of a model.
pub fn locally(why: Option<String>) -> Routing {
    Routing {
        by: LOCAL.into(),
        fallback: why,
        ..Routing::default()
    }
}

/// Why a thought the router found no place for is kept for later: by
/// the match on names, or by the model that answered.
fn unplaced(how: &Routing) -> Placed {
    match how.by == LOCAL {
        true => Placed::KeptName,
        false => Placed::KeptModel,
    }
}

/// Whether the router is still asked about the thought.
fn routing(thought: &Option<Thought>) -> bool {
    let route = thought.as_ref().and_then(|t| t.route.as_ref());
    route.is_some_and(|r| r.pending)
}

/// A timer that fires before the hold ends is stale: Undo and a new pick re-armed it.
fn due(thought: &Option<Thought>, now: Time) -> bool {
    thought
        .as_ref()
        .and_then(|t| t.hold_until)
        .is_some_and(|until| until <= now)
}

fn pending(thought: &Option<Thought>) -> bool {
    thought
        .as_ref()
        .and_then(|t| t.workdir.as_ref())
        .is_some_and(|w| w.changes == Changes::Pending)
}

/// Whether an answer from a device fits its question: affirm only a confirm,
/// a choice only one of the question's own, deny and text any of them. A
/// question asked in the agent's terminal is answered there, which the core
/// records itself as `terminal` (design §6).
fn fits(q: &Question, response: &Response) -> Result<()> {
    if q.reply_via == ReplyVia::Terminal {
        return Err(Error::Invalid("this question is answered in its terminal"));
    }
    match (&q.kind, response) {
        (_, Response::Deny | Response::Text { .. }) | (QuestionKind::Confirm, Response::Affirm) => {
            Ok(())
        }
        (QuestionKind::Choice { choices }, Response::Choice { choice })
            if (*choice as usize) < choices.len() =>
        {
            Ok(())
        }
        _ => Err(Error::Invalid("the answer does not fit the question")),
    }
}

/// The key of a question a session's agent asks through the core with
/// `question.ask`: its `request`, kept per session (design §6).
pub fn ask_key(session: SessionId, request: &str) -> String {
    format!("ask {} {request}", session.uuid())
}

/// Whether an ask brings the question its key already names: the same asker
/// and the same content. Its thought and turn are the asker's current ones,
/// so they are not compared.
fn same_ask(q: &Question, stored: Option<&Question>) -> bool {
    stored.is_some_and(|s| {
        (
            s.session_id,
            s.source,
            &s.kind,
            &s.prompt,
            &s.detail,
            s.reply_via,
        ) == (
            q.session_id,
            q.source,
            &q.kind,
            &q.prompt,
            &q.detail,
            q.reply_via,
        )
    })
}

fn this_turn(q: &Question, session: &Option<Session>) -> bool {
    q.source != QuestionSource::Router
        && session
            .as_ref()
            .is_some_and(|s| q.session_id == Some(s.id) && q.turn == Some(s.turn))
}

fn own_session(attempt: AttemptId) -> Result<SessionId> {
    SessionId::try_from(attempt.uuid()).map_err(|_| Error::Invalid("attempt ids are UUID v7"))
}

fn launch_hash(thought: ThoughtId) -> Hash {
    digest(&[b"launch", thought.uuid().as_bytes()])
}

fn settle_hash(thought: ThoughtId, keep: bool) -> Hash {
    digest(&[b"settle", thought.uuid().as_bytes(), &[u8::from(keep)]])
}

fn tidy_hash(thought: ThoughtId) -> Hash {
    digest(&[b"tidy", thought.uuid().as_bytes()])
}

/// Whether a worktree's record names one the core makes: `tasktap/<name>`
/// in a folder `<name>` of a folder `worktrees`, `<name>` its twelve
/// lowercase hex digits, the path reached through no `..`. `isolate.rs`
/// proves the rest on disk before it touches one.
fn made(w: &Workdir) -> bool {
    use std::path::Component;
    let path = Path::new(&w.path);
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let parent = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str());
    let plain = path
        .components()
        .all(|c| !matches!(c, Component::ParentDir | Component::CurDir));
    crate::isolate::named(name)
        && w.branch == format!("{}{name}", crate::isolate::PREFIX)
        && parent == Some(crate::isolate::FOLDER)
        && plain
}

/// A worktree not settled: its changes none or pending.
fn open(w: &Workdir) -> bool {
    matches!(w.changes, Changes::Clean | Changes::Pending)
}

/// SHA-256 over the parts, each prefixed with its length so no two lists collide.
fn digest(parts: &[&[u8]]) -> Hash {
    let mut h = Sha256::new();
    for part in parts {
        h.update((part.len() as u64).to_le_bytes());
        h.update(part);
    }
    h.finalize().into()
}

/// A router question's request key also records where each choice goes;
/// only the core reads the key.
fn router_key(question: QuestionId, candidates: &[Candidate]) -> String {
    let mut key = format!("router {}", question.uuid());
    for c in candidates {
        match c.to {
            Destination::New(p) => key += &format!(" n:{}", p.uuid()),
            Destination::Session(s) => key += &format!(" s:{}", s.uuid()),
        }
    }
    key
}

fn destinations(key: &str) -> Vec<Destination> {
    fn id<I: DeserializeOwned>(text: &str) -> Option<I> {
        serde_json::from_value(Value::String(text.into())).ok()
    }
    key.split(' ')
        .skip(2)
        .filter_map(|part| match part.split_once(':')? {
            ("n", p) => id(p).map(Destination::New),
            ("s", s) => id(s).map(Destination::Session),
            _ => None,
        })
        .collect()
}

/// The answer's first non-empty line, cut to [`SUMMARY`] characters.
fn summary(answer: &str) -> String {
    let line = answer
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    line.chars().take(SUMMARY).collect()
}

// Dictations (design §8, "Speech"). They live in memory only, so their
// rules take no transaction: one function over the rows, with no I/O and no
// clock, as `apply` is for the stored records.

use tasktap_proto::{Dictation, DictationId, DictationPhase, DictationTarget};

/// Seconds a recording lasts at most; at 16 kHz, one channel and 16 bits
/// that is the most audio the core holds for one dictation.
pub const RECORDING: u32 = 300;
/// Seconds after [`RECORDING`] at which a recording that has not ended fails.
const GRACE: u32 = 10;
/// Seconds a recorder that transcribes has for its transcript.
const REPORT: u32 = 120;
/// Dictations under way at once: one recording, the others being transcribed.
pub const DICTATIONS: usize = 4;
pub const NOTHING_HEARD: &str = "Nothing was heard";
pub const INTERRUPTED: &str = "The recording was interrupted";

/// A dictation as its rules see it: its row, and who transcribes.
#[derive(Clone, Debug, PartialEq)]
pub struct Dictating {
    pub row: Dictation,
    /// The core transcribes, from the stream it opened; otherwise the
    /// recorder does and reports.
    pub stream: bool,
}

/// What happens to a dictation.
#[derive(Clone, Debug, PartialEq)]
pub enum Spoken {
    /// `dictation.start`.
    Start {
        id: DictationId,
        target: DictationTarget,
        stream: bool,
    },
    /// How loud the audio on its stream is now.
    Level {
        id: DictationId,
        level: u8,
    },
    /// `dictation.report`.
    Report {
        id: DictationId,
        text: Option<String>,
        level: Option<u8>,
    },
    /// `dictation.finish`; `heard` is whether its stream carried anything
    /// to transcribe.
    Finish {
        id: DictationId,
        heard: bool,
    },
    /// `dictation.finish {as: "text"}`: it is to end as words only,
    /// whatever it was started for.
    Words {
        id: DictationId,
    },
    /// The speech service's answer, or why there is none.
    Transcribed {
        id: DictationId,
        transcript: std::result::Result<String, String>,
    },
    /// The transcript was captured as a thought, or refused.
    Delivered {
        id: DictationId,
        refused: Option<String>,
    },
    /// `dictation.cancel`.
    Cancel {
        id: DictationId,
    },
    /// The recorder's connection ended.
    Left {
        id: DictationId,
    },
    Deadline {
        id: DictationId,
    },
}

/// What the caller does once a dictation's event is applied, in order.
#[derive(Clone, Debug, PartialEq)]
pub enum Heard {
    /// The row changed, or is new.
    Put(DictationId),
    /// The row is gone.
    Del(DictationId),
    /// [`Spoken::Deadline`] comes back after this many seconds, once,
    /// unless `End` comes first.
    Deadline { id: DictationId, seconds: u32 },
    /// Nothing of it goes on: no deadline, no stream, no web call.
    End(DictationId),
    /// The speech service is asked for the transcript of its audio.
    Transcribe(DictationId),
    /// The transcript is captured as the thought it was spoken as; what
    /// came of it returns as [`Spoken::Delivered`].
    Deliver {
        id: DictationId,
        capture: Box<tasktap_proto::Capture>,
        text: String,
    },
}

/// Applies one event to the dictations (design §8, the table of "Speech").
pub fn dictate(all: &mut Vec<Dictating>, event: Spoken) -> Result<Vec<Heard>> {
    use DictationPhase::{Failed, Heard as Words, Recording, Transcribing};
    let at = |all: &[Dictating], id| all.iter().position(|d| d.row.id == id);
    // Neither recording nor being transcribed any more.
    let ended = |d: &Dictating| matches!(d.row.phase, Failed | Words);
    let fail = |d: &mut Dictating, why: &str| {
        (d.row.phase, d.row.level, d.row.error) = (Failed, 0, Some(why.to_owned()));
        vec![Heard::Put(d.row.id), Heard::End(d.row.id)]
    };
    Ok(match event {
        Spoken::Start { id, target, stream } => {
            let under_way = all.iter().filter(|d| !ended(d)).count();
            if at(all, id).is_some() {
                return Err(Error::Conflict("a dictation with this id exists"));
            } else if all.iter().any(|d| d.row.phase == Recording) {
                return Err(Error::Conflict("another dictation is recording"));
            } else if under_way >= DICTATIONS {
                return Err(Error::Conflict(
                    "four dictations are still being transcribed",
                ));
            }
            // The person moved on from what ended before.
            let mut told: Vec<Heard> = (all.iter().filter(|d| ended(d)))
                .flat_map(|d| [Heard::Del(d.row.id), Heard::End(d.row.id)])
                .collect();
            all.retain(|d| !ended(d));
            let row = Dictation {
                id,
                rev: Rev::ZERO,
                phase: Recording,
                text: String::new(),
                level: 0,
                target,
                error: None,
            };
            all.push(Dictating { row, stream });
            let seconds = RECORDING + GRACE;
            told.extend([Heard::Put(id), Heard::Deadline { id, seconds }]);
            told
        }
        Spoken::Level { id, level } => match at(all, id).map(|i| &mut all[i]) {
            Some(d) if d.stream && d.row.phase == Recording && d.row.level != level => {
                d.row.level = level.min(100);
                vec![Heard::Put(id)]
            }
            _ => Vec::new(),
        },
        Spoken::Report { id, text, level } => {
            let i = at(all, id).ok_or(Error::Gone)?;
            let d = &mut all[i];
            match (d.row.phase, text) {
                _ if d.stream => {
                    return Err(Error::Conflict("Tasktap transcribes this dictation"));
                }
                (Recording, text) => {
                    let before = (d.row.text.clone(), d.row.level);
                    d.row.text = text.unwrap_or(before.0.clone());
                    d.row.level = level.unwrap_or(before.1).min(100);
                    match (&d.row.text, d.row.level) != (&before.0, before.1) {
                        true => vec![Heard::Put(id)],
                        false => Vec::new(),
                    }
                }
                (Transcribing, Some(text)) => {
                    let transcript = Ok(text);
                    return dictate(all, Spoken::Transcribed { id, transcript });
                }
                (Transcribing, None) => {
                    return Err(Error::Invalid(
                        "the report of a finished dictation carries its transcript",
                    ));
                }
                (Failed | Words, _) => return Err(Error::Ignored(Ignored::State)),
            }
        }
        Spoken::Finish { id, heard } => {
            let i = at(all, id).ok_or(Error::Gone)?;
            let d = &mut all[i];
            match d.row.phase {
                Recording if d.stream && !heard => fail(d, NOTHING_HEARD),
                Recording => {
                    (d.row.phase, d.row.level) = (Transcribing, 0);
                    match d.stream {
                        true => vec![Heard::Put(id), Heard::End(id), Heard::Transcribe(id)],
                        false => {
                            let seconds = REPORT;
                            vec![Heard::Put(id), Heard::Deadline { id, seconds }]
                        }
                    }
                }
                // Finished already: a repeat.
                Transcribing => Vec::new(),
                Failed | Words => return Err(Error::Ignored(Ignored::State)),
            }
        }
        Spoken::Words { id } => {
            let i = at(all, id).ok_or(Error::Gone)?;
            let d = &mut all[i];
            match (d.row.phase, &d.row.target) {
                (Failed | Words, _) => return Err(Error::Ignored(Ignored::State)),
                (_, DictationTarget::Text) => Vec::new(),
                // Not captured yet: from here on it is the text target's.
                (Recording | Transcribing, DictationTarget::Thought(_)) => {
                    d.row.target = DictationTarget::Text;
                    vec![Heard::Put(id)]
                }
            }
        }
        Spoken::Transcribed { id, transcript } => {
            // Cancelled meanwhile: nobody waits for it.
            let Some(d) = at(all, id).map(|i| &mut all[i]) else {
                return Ok(Vec::new());
            };
            match transcript.map(|text| text.trim().to_owned()) {
                _ if d.row.phase != Transcribing => Vec::new(),
                Err(why) => fail(d, &why),
                Ok(text) if text.is_empty() => fail(d, NOTHING_HEARD),
                Ok(text) => {
                    d.row.text = text.clone();
                    match d.row.target.clone() {
                        DictationTarget::Thought(capture) => {
                            vec![Heard::Deliver { id, capture, text }]
                        }
                        // Only the words were asked for: there they are.
                        DictationTarget::Text => {
                            d.row.phase = Words;
                            vec![Heard::Put(id), Heard::End(id)]
                        }
                    }
                }
            }
        }
        Spoken::Delivered { id, refused } => match (at(all, id), refused) {
            (Some(i), None) => {
                all.remove(i);
                vec![Heard::Del(id), Heard::End(id)]
            }
            (Some(i), Some(why)) => fail(&mut all[i], &why),
            (None, _) => Vec::new(),
        },
        Spoken::Cancel { id } => match at(all, id) {
            Some(i) => {
                all.remove(i);
                vec![Heard::Del(id), Heard::End(id)]
            }
            // Nothing to cancel: as for a repeat.
            None => Vec::new(),
        },
        Spoken::Left { id } => match at(all, id).map(|i| &mut all[i]) {
            // What the core transcribes it has whole: its recorder may go.
            Some(d) if d.row.phase == Recording || (d.row.phase == Transcribing && !d.stream) => {
                fail(d, INTERRUPTED)
            }
            _ => Vec::new(),
        },
        Spoken::Deadline { id } => match at(all, id).map(|i| &mut all[i]) {
            Some(d) if d.row.phase == Recording => {
                fail(d, "The recording did not end within 5 minutes")
            }
            Some(d) if d.row.phase == Transcribing && !d.stream => {
                fail(d, "The transcript did not arrive within 2 minutes")
            }
            _ => Vec::new(),
        },
    })
}
