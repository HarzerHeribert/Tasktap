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
//! launcher and the router are the seams later phases fill; each has a
//! fixture here.

use std::collections::BTreeSet;
use std::fmt;

use serde::de::DeserializeOwned;
use serde_json::Value;
use sha2::{Digest, Sha256};
// Short names keep each row of the table on one line: E an event, A what an
// agent said, P a thought's phase, S a session's state, Q a question's state.
use tasktap_proto::{
    Answer, AttemptId, Capture, Changes, Code, DeviceId, Event as A, Mode, Offset, Outcome,
    Phase as P, PrefKey, PrefValue, ProjectId, Question, QuestionId, QuestionKind, QuestionSource,
    QuestionState as Q, Reason, ReplyVia, Response, ResultKind, Rev, Secret, Session, SessionId,
    SessionState as S, Source, Status, Terminal, TerminalId, TerminalKind, TerminalState, Thought,
    ThoughtId, Time, TurnResult,
};

use crate::store::{self, Attempt, AttemptKind, AttemptOutcome, Hash, Tx};

use Event as E;

/// Characters of an answer's first line kept as its result's summary.
const SUMMARY: usize = 200;

/// Everything that can move a thought, a session or a question.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// `thought.capture`, with the agent a new run of the thought would use.
    Capture { capture: Capture, agent: String },
    /// The person picks where a captured thought goes.
    Pick { thought: ThoughtId, to: Destination },
    /// The router's answer for a captured thought.
    Routed { thought: ThoughtId, route: Route },
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
    /// The `Settle` effect finished, or refused with the reason.
    Settled {
        attempt: AttemptId,
        error: Option<String>,
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

/// What the router found, after the acceptance rules of design §8.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Route {
    Clear {
        to: Destination,
        brief: String,
    },
    /// The person chooses in a router question.
    Ambiguous {
        prompt: String,
        candidates: Vec<Candidate>,
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
    Route(ThoughtId),
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
    /// Keep or discard the thought's worktree; report with [`Event::Settled`].
    Settle {
        attempt: AttemptId,
        thought: ThoughtId,
        keep: bool,
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
    pub prompt: String,
    /// The agent's handle of an ended session whose conversation this run continues.
    pub resume: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Deliver {
    pub attempt: AttemptId,
    pub thought: ThoughtId,
    pub session: SessionId,
    pub text: String,
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

/// The launcher seam (Phase 2 fills it with terminals and agent adapters,
/// Phase 3 with worktrees). What it returns goes back in as
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

/// The route-provider seam (Phase 3 fills it with the router of design §8).
/// Its answer goes back in as [`Event::Routed`].
pub trait Router {
    fn route(&mut self, thought: &Thought) -> Route;
}

/// A launcher that starts nothing: it records what it was asked and answers
/// with a running terminal that takes the session's id, or with `refuse`.
/// A terminal it is asked to kill has ended at once.
#[derive(Debug, Default)]
pub struct FixtureLauncher {
    pub refuse: Option<String>,
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
            project_id: Some(launch.project),
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
    fn route(&mut self, _: &Thought) -> Route {
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
        let phase = thought.as_ref().map(|t| t.phase);
        let state = session.as_ref().map(|s| s.state);
        let asked = question.as_ref().map(|q| q.state);
        let alive = matches!(state, Some(S::Starting | S::Idle | S::Working));
        let router = question.as_ref().map(|q| q.source) == Some(QuestionSource::Router);
        match (event, said, phase, state, asked) {
            // thought.capture: → captured.
            (E::Capture { capture, agent }, _, None, ..) => self.capture(capture, agent),
            (E::Capture { capture, .. }, _, Some(_), ..) => same_capture(some(thought)?, capture),
            // route clear; a router question answered; the person picks:
            // captured → routed, and the hold starts.
            (
                E::Routed {
                    route: Route::Clear { to, brief },
                    ..
                },
                _,
                Some(P::Captured),
                ..,
            ) => self.route(some(thought)?, to, Some(brief)),
            (E::Answer { response, by, .. }, _, Some(P::Captured), _, Some(Q::Open)) if router => {
                self.answer_router(some(thought)?, some(question)?, response, by)
            }
            (E::Pick { to, .. }, _, Some(P::Captured), ..) => self.route(some(thought)?, to, None),
            // route ambiguous: stays captured, a router question opens.
            (
                E::Routed {
                    route: Route::Ambiguous { prompt, candidates },
                    ..
                },
                _,
                Some(P::Captured),
                ..,
            ) if !candidates.is_empty() => self.ask_router(some(thought)?, prompt, candidates),
            // route unknown, or ambiguous with nothing to choose: an idea.
            (E::Routed { .. }, _, Some(P::Captured), ..) => self.keep_as_idea(some(thought)?),
            // hold ends, or thought.start: routed → working once the attempt is written.
            (E::HoldEnded { attempt, .. }, _, Some(P::Routed), ..) if due(&thought, self.now) => {
                self.launch(some(thought)?, attempt, false)
            }
            (E::Start { attempt, .. }, _, Some(P::Routed), ..) => {
                self.launch(some(thought)?, attempt, true)
            }
            // thought.stop before launch (Undo): routed → captured.
            (E::Stop { .. }, _, Some(P::Routed), ..) => self.undo(some(thought)?),
            // launch fails: → failed, its session ended. Both reports have
            // already recorded the attempt's outcome.
            (E::LaunchFailed { error, .. }, ..) => self.launch_failed(thought, session, error),
            (E::Launched { terminal, .. }, ..) => self.launched(session, terminal),
            // ready: starting → idle.
            (_, Some(A::Ready), _, Some(S::Starting), _) => self.ready(some(session)?),
            // turn_started: → working. Binds the waiting thought, or makes one
            // from a prompt typed by hand.
            (_, Some(A::TurnStarted { prompt }), _, Some(S::Starting | S::Idle), _) => {
                self.start_turn(some(session)?, prompt)
            }
            // activity: memory-only text, nothing stored.
            (_, Some(A::Activity { text }), ..) if alive => self.activity(some(session)?, text),
            // a question opens: unchanged, the status becomes needs you. The
            // same key must bring the same question (design §6).
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
            (_, Some(A::Continued), _, Some(S::Working), _) => self.continued(some(session)?),
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
            // thought.stop after launch: → failed (stopped); the process is stopped, → ended.
            (E::Stop { .. }, _, Some(P::Working), ..) => self.stop(some(thought)?, session),
            // thought.retry: failed → routed, its next ending unread.
            (E::Retry { .. }, _, Some(P::Failed), ..) => self.retry(some(thought)?),
            // thought.read: a done or failed thought is read; settled too, it is finished.
            (E::Read { .. }, _, Some(P::Done | P::Failed), ..) => self.read(some(thought)?),
            // thought.settle: changes pending → kept or discarded, once the session has ended.
            (E::Settle { .. }, _, Some(P::Done | P::Failed), ..) if alive && pending(&thought) => {
                Err(Error::Conflict(
                    "a thought settles once its session has ended",
                ))
            }
            (E::Settle { attempt, keep, .. }, _, Some(P::Done | P::Failed), ..)
                if pending(&thought) =>
            {
                self.settle(some(thought)?, attempt, keep)
            }
            (E::Settled { error: None, .. }, _, Some(P::Done | P::Failed), ..)
                if pending(&thought) =>
            {
                self.settled(some(thought)?, attempt)
            }
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
            Event::Capture { capture, .. } => s.thought = self.tx.thought(capture.id)?,
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
            Event::Exited { session, .. } => self.of_session(&mut s, *session)?,
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

    fn capture(&mut self, c: Capture, agent: String) -> Result<()> {
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
            agent: Some(agent),
            model: None,
            workdir: None,
            hold_until: None,
            read: false,
            created: self.now,
            updated: self.now,
        };
        self.tx.insert_thought(&t)?;
        match pick {
            Some(to) => self.route(t, to, None),
            None if mode == Mode::Note => Ok(()),
            None => {
                self.effects.push(Effect::Route(t.id));
                Ok(())
            }
        }
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

    fn route(&mut self, mut t: Thought, to: Destination, brief: Option<String>) -> Result<()> {
        let (project, session) = self.target(to)?;
        let pref = self.tx.pref(PrefKey::Hold)?;
        let PrefValue::Hold(hold) = pref.map_or(PrefKey::Hold.default(), |p| p.value);
        let until = Time::new(self.now.get() + u64::from(hold) * 1000).ok_or(Error::Invalid(
            "the hold would end beyond the clock's range",
        ))?;
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

    fn ask_router(&mut self, t: Thought, prompt: String, candidates: Vec<Candidate>) -> Result<()> {
        let id: QuestionId = self.mint(&[b"router", t.id.uuid().as_bytes()])?;
        let key = router_key(id, &candidates);
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
                    .ok_or(Error::Invalid("the router question has no such choice"))?;
                self.target(to)?;
                Some(to)
            }
            // Declining every candidate keeps the thought as an idea, as `unknown` does.
            _ => None,
        };
        self.store_answer(q.id, response, device)?;
        match to {
            Some(to) => self.route(t, to, None),
            None => self.keep_as_idea(t),
        }
    }

    fn keep_as_idea(&mut self, mut t: Thought) -> Result<()> {
        t.mode = Mode::Note;
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
        let text = t.brief.clone().unwrap_or_else(|| t.text.clone());
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
            })
        } else {
            let project = t
                .project_id
                .ok_or(Error::Invalid("a thought starts in a project"))?;
            let folder = self.tx.project(project)?.ok_or(Error::Gone)?.folder;
            let agent = target
                .as_ref()
                .map(|s| s.agent.clone())
                .or_else(|| t.agent.clone())
                .ok_or(Error::Invalid("a thought starts with an agent"))?;
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
                name: None,
                named_at: None,
                model: t.model.clone(),
                cwd: t.workdir.as_ref().map_or(folder, |w| w.path.clone()),
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
                resume: target.and_then(|s| s.resume),
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
        error: String,
    ) -> Result<()> {
        // A launch ends the session it made; a failed follow-up leaves its session alone.
        let own = session.as_ref().map(|s| s.id);
        if let Some(s) = session.filter(|s| s.state != S::Ended) {
            self.end(s, None, Some(error))?;
        }
        match thought {
            Some(mut t) if t.phase == P::Working && (own.is_none() || t.session_id == own) => {
                t.phase = P::Failed;
                t.reason = Some(Reason::Launch);
                self.save(t)
            }
            _ => Ok(()),
        }
    }

    fn ready(&mut self, mut s: Session) -> Result<()> {
        s.state = S::Idle;
        Ok(self.tx.update_session(&s)?)
    }

    fn start_turn(&mut self, mut s: Session, prompt: Option<String>) -> Result<()> {
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
        let q = Question {
            state: Q::Open,
            answer: None,
            ..q
        };
        self.tx.insert_question(&q, &key)?;
        self.effects.push(Effect::Notify(q.id));
        self.refresh(q.thought_id)
    }

    fn reopen(&mut self, q: Question) -> Result<()> {
        self.tx.set_question_state(q.id, Q::Open)?;
        self.effects.push(Effect::Notify(q.id));
        self.refresh(q.thought_id)
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

    fn continued(&mut self, s: Session) -> Result<()> {
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
        t.map_or(Ok(()), |t| self.save(t))
    }

    fn exited(&mut self, s: Session, code: Option<u32>, silent: bool) -> Result<()> {
        let id = s.id;
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
            self.effects.push(Effect::Kill {
                session: id,
                terminal: s.terminal_id,
            });
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

    fn settled(&mut self, mut t: Thought, attempt: Option<Attempt>) -> Result<()> {
        // The attempt's hash says which of the two it was.
        let keep = attempt.is_some_and(|a| a.args_hash == settle_hash(t.id, true));
        if let Some(w) = &mut t.workdir {
            w.changes = if keep {
                Changes::Kept
            } else {
                Changes::Discarded
            };
        }
        self.save(t)
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
        let asking = self
            .tx
            .open_questions()?
            .iter()
            .any(|q| q.thought_id == Some(t.id));
        Ok(if asking {
            Status::NeedsYou
        } else {
            t.phase.into()
        })
    }

    /// A UUID v7 for a record this module creates: the time is now and the
    /// rest comes from what the record is unique to, so applying the same
    /// event twice cannot make two.
    fn mint<I: DeserializeOwned>(&self, parts: &[&[u8]]) -> Result<I> {
        let hash = digest(parts);
        let mut b = [0u8; 16];
        b[..6].copy_from_slice(&self.now.get().to_be_bytes()[2..]);
        b[6..].copy_from_slice(&hash[..10]);
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
        serde_json::from_value(Value::String(text)).map_err(|e| Error::Store(e.into()))
    }
}

fn some<T>(record: Option<T>) -> Result<T> {
    record.ok_or(Error::Gone)
}

fn same_capture(t: Thought, c: Capture) -> Result<()> {
    if (t.text, t.strokes, t.source) == (c.text, c.strokes, c.source) {
        Err(Error::Ignored(Ignored::Repeat))
    } else {
        Err(Error::Conflict(
            "the thought id was used for another capture",
        ))
    }
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
