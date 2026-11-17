//! The state machine's promises (design §5 "One state machine", §3, §6),
//! proven on a real store in temporary folders: every row of the table,
//! every guard, the recovery rules across a reopen, the hold, attempts, and a
//! sweep that feeds every event to every reachable state.

use std::collections::{BTreeSet, HashSet, VecDeque};
use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use serde_json::Value;
use tasktap_core::state::{
    self, Candidate, DEFAULT_HOLD, Deliver, Destination, Effect, Error, Event, FixtureLauncher,
    FixtureRouter, Ignored, Launch, Launcher, Report, Route, Router,
};
use tasktap_core::store::{AttemptKind, AttemptOutcome, Store, Tx};
use tasktap_proto::{
    AttemptId, Capture, Change, Changes, Code, Collection, Device, DeviceId, Event as Said,
    Isolate, Mode, Offset, Outcome, Phase, PrefKey, PrefValue, Project, ProjectId, ProjectKind,
    Question, QuestionId, QuestionKind, QuestionSource, QuestionState, Reason, ReplyVia, Response,
    ResultKind, Rev, Session, SessionId, SessionState, Set, Source, Status, Terminal, TerminalId,
    TerminalKind, TerminalState, Thought, ThoughtId, Time, TurnResult, Workdir,
};

/// A fresh folder under the system's temporary folder, removed afterwards.
struct Dir(PathBuf);

impl Dir {
    fn new(name: &str) -> Dir {
        let path =
            std::env::temp_dir().join(format!("tasktap-state-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Dir(path)
    }

    fn db(&self) -> PathBuf {
        self.0.join("core.db")
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const START: u64 = 1_800_000_000_000;
/// No effects.
const NONE: [Effect; 0] = [];
const AGENT: &str = "claude";
const FOLDER: &str = "/work/app";

fn time(ms: u64) -> Time {
    Time::new(ms).unwrap()
}

fn project(folder: &str) -> Project {
    Project {
        id: ProjectId::mint(),
        rev: Rev::ZERO,
        name: folder.into(),
        folder: folder.into(),
        kind: ProjectKind::Folder,
        color: "teal".into(),
        aliases: Vec::new(),
        git: true,
        isolate: Isolate::Never,
        open: true,
        available: true,
    }
}

fn capture(id: ThoughtId, text: &str) -> Capture {
    Capture {
        id,
        text: text.into(),
        strokes: Vec::new(),
        source: Source::Typed,
        mode: None,
        project_id: None,
        session_id: None,
    }
}

fn captured(capture: Capture) -> Event {
    Event::Capture {
        capture,
        agent: AGENT.into(),
    }
}

/// An agent's question in the session's current turn.
fn question(s: &Session, via: ReplyVia) -> Question {
    Question {
        id: QuestionId::mint(),
        rev: Rev::ZERO,
        thought_id: s.thought_id,
        session_id: Some(s.id),
        turn: Some(s.turn),
        source: QuestionSource::Agent,
        kind: QuestionKind::Confirm,
        prompt: "Deploy?".into(),
        detail: None,
        reply_via: via,
        state: QuestionState::Open,
        answer: None,
    }
}

fn ask(question: Question) -> Event {
    Event::Ask {
        key: format!("ask {}", question.id.uuid()),
        question,
    }
}

fn workdir(changes: Changes) -> Workdir {
    Workdir {
        path: "/work/app-tasktap".into(),
        branch: "tasktap/fix".into(),
        destination: "main".into(),
        base: "0123abc".into(),
        changes,
    }
}

fn ok_reply() -> Option<AttemptOutcome> {
    Some(AttemptOutcome::Reply(Outcome::Ok(Value::Null)))
}

fn failed_reply(message: &str) -> Option<AttemptOutcome> {
    let error = tasktap_proto::Error::new(Code::Failed, message);
    Some(AttemptOutcome::Reply(Outcome::Err(error)))
}

/// A store with one project and one device, the time, and the caller's part
/// of every effect: the fixture launcher.
struct World {
    dir: Dir,
    store: Store,
    now: u64,
    project: ProjectId,
    device: DeviceId,
    launcher: FixtureLauncher,
    events: u32,
    /// What the last applied event committed.
    change: Option<Change>,
}

impl World {
    fn new(name: &str) -> World {
        let dir = Dir::new(name);
        let (mut store, _) = Store::open(&dir.db()).unwrap();
        let p = project(FOLDER);
        let device = Device {
            id: DeviceId::mint(),
            rev: Rev::ZERO,
            name: "mac".into(),
            last_seen: None,
            revoked: false,
        };
        let mut tx = store.begin().unwrap();
        tx.insert_project(&p).unwrap();
        tx.insert_device(&device, &[7; 32]).unwrap();
        tx.commit().unwrap();
        World {
            dir,
            store,
            now: START,
            project: p.id,
            device: device.id,
            launcher: FixtureLauncher::default(),
            events: 0,
            change: None,
        }
    }

    fn now(&self) -> Time {
        time(self.now)
    }

    fn tick(&mut self, ms: u64) {
        self.now += ms;
    }

    /// Applies one event in its own transaction, committed only on success.
    fn apply(&mut self, event: Event) -> Result<Vec<Effect>, Error> {
        let now = self.now();
        let mut tx = self.store.begin().unwrap();
        let effects = state::apply(&mut tx, now, event)?;
        self.change = tx.commit().unwrap();
        Ok(effects)
    }

    fn ok(&mut self, event: Event) -> Vec<Effect> {
        let shown = format!("{event:?}");
        self.apply(event)
            .unwrap_or_else(|e| panic!("{shown} was refused: {e}"))
    }

    fn ignored(&mut self, event: Event) -> Ignored {
        match self.apply(event) {
            Err(Error::Ignored(why)) => why,
            other => panic!("expected the event to be ignored: {other:?}"),
        }
    }

    fn read<T>(&mut self, f: impl FnOnce(&Tx) -> T) -> T {
        f(&self.store.begin().unwrap())
    }

    fn thought(&mut self, id: ThoughtId) -> Thought {
        self.read(|tx| tx.thought(id).unwrap().unwrap())
    }

    fn session(&mut self, id: SessionId) -> Session {
        self.read(|tx| tx.session(id).unwrap().unwrap())
    }

    fn question(&mut self, id: QuestionId) -> Question {
        self.read(|tx| tx.question(id).unwrap().unwrap())
    }

    fn outcome(&mut self, id: AttemptId) -> Option<AttemptOutcome> {
        self.read(|tx| tx.attempt(id).unwrap().unwrap().outcome)
    }

    fn results(&mut self) -> Vec<TurnResult> {
        match self.read(|tx| tx.live(Collection::Results).unwrap()) {
            Some(Set::Results(rows)) => rows.put,
            other => panic!("{other:?}"),
        }
    }

    fn write(&mut self, f: impl FnOnce(&mut Tx)) {
        let mut tx = self.store.begin().unwrap();
        f(&mut tx);
        tx.commit().unwrap();
    }

    fn set_hold(&mut self, seconds: u32) {
        self.write(|tx| tx.put_pref(&PrefValue::Hold(seconds)).unwrap());
    }

    /// Starts the core again on the same folder: the recovery pass runs.
    fn reopen(&mut self) {
        self.store = Store::open(&self.dir.db()).unwrap().0;
    }

    /// Does the caller's part of launch and delivery effects: asks the
    /// launcher, stores the terminal it started, and reports back.
    fn carry(&mut self, effects: &[Effect]) -> Vec<Effect> {
        let mut out = Vec::new();
        for effect in effects {
            let report = match effect {
                Effect::Launch(l) => match self.launcher.launch(l) {
                    Ok(terminal) => {
                        let now = self.now();
                        let mut tx = self.store.begin().unwrap();
                        tx.insert_terminal(&terminal, None).unwrap();
                        let report = Event::Launched {
                            attempt: l.attempt,
                            terminal: Some(terminal.id),
                        };
                        out.extend(state::apply(&mut tx, now, report).unwrap());
                        tx.commit().unwrap();
                        continue;
                    }
                    Err(error) => Event::LaunchFailed {
                        attempt: l.attempt,
                        error,
                    },
                },
                Effect::Deliver(d) => match self.launcher.deliver(d) {
                    Ok(()) => Event::Launched {
                        attempt: d.attempt,
                        terminal: None,
                    },
                    Err(error) => Event::LaunchFailed {
                        attempt: d.attempt,
                        error,
                    },
                },
                _ => continue,
            };
            out.extend(self.ok(report));
        }
        out
    }

    fn capture(&mut self, text: &str) -> ThoughtId {
        let id = ThoughtId::mint();
        assert_eq!(self.ok(captured(capture(id, text))), [Effect::Route(id)]);
        id
    }

    fn routed(&mut self, text: &str) -> ThoughtId {
        let id = self.capture(text);
        let to = Destination::New(self.project);
        self.ok(Event::Pick { thought: id, to });
        id
    }

    /// A thought whose launch was reported: working, its session starting
    /// in a running terminal.
    fn running(&mut self) -> (ThoughtId, SessionId) {
        let t = self.routed("fix the build");
        let attempt = AttemptId::mint();
        let effects = self.ok(Event::Start {
            thought: t,
            attempt,
        });
        assert!(self.carry(&effects).is_empty());
        (t, self.thought(t).session_id.unwrap())
    }

    /// The same, with the agent ready and in its first turn.
    fn turn(&mut self) -> (ThoughtId, SessionId) {
        let (t, s) = self.running();
        self.say(s, Said::Ready).unwrap();
        self.say(s, Said::TurnStarted { prompt: None }).unwrap();
        (t, s)
    }

    /// A report from the session's own terminal with a fresh event id.
    fn report(&mut self, session: SessionId, event: Said) -> Report {
        self.events += 1;
        Report {
            session,
            terminal: self.session(session).terminal_id.unwrap(),
            id: format!("event-{}", self.events),
            turn: None,
            subagent: false,
            event,
        }
    }

    fn say(&mut self, session: SessionId, event: Said) -> Result<Vec<Effect>, Error> {
        let report = self.report(session, event);
        self.apply(Event::Report(report))
    }

    fn ask(&mut self, session: SessionId, via: ReplyVia) -> QuestionId {
        let q = question(&self.session(session), via);
        let id = q.id;
        assert_eq!(self.ok(ask(q)), [Effect::Notify(id)]);
        id
    }

    fn answer(&mut self, question: QuestionId, response: Response) -> Result<Vec<Effect>, Error> {
        let by = Some(self.device);
        self.apply(Event::Answer {
            question,
            response,
            by,
        })
    }
}

fn shape(t: &Thought) -> (Phase, Status, Option<Reason>) {
    (t.phase, t.status, t.reason)
}

// One test per row of the table in design §5, in its order.

#[test]
fn row_capture_makes_a_captured_thought_and_asks_the_router() {
    let mut w = World::new("capture");
    let id = ThoughtId::mint();
    let c = capture(id, "fix the build");
    assert_eq!(w.ok(captured(c.clone())), [Effect::Route(id)]);
    let t = w.thought(id);
    assert_eq!(shape(&t), (Phase::Captured, Status::Captured, None));
    assert_eq!(
        (t.mode, t.source, t.agent.as_deref()),
        (Mode::Ask, Source::Typed, Some(AGENT))
    );
    assert_eq!(
        (t.created, t.hold_until, t.session_id),
        (w.now(), None, None)
    );

    // Creates are idempotent on the client's id: the same capture is a repeat,
    // another one under that id a conflict.
    assert_eq!(w.ignored(captured(c.clone())), Ignored::Repeat);
    let other = capture(id, "something else");
    assert!(matches!(w.apply(captured(other)), Err(Error::Conflict(_))));

    // A note stays captured, keeps its project and is never routed.
    let note = Capture {
        mode: Some(Mode::Note),
        project_id: Some(w.project),
        ..capture(ThoughtId::mint(), "buy milk")
    };
    assert_eq!(w.ok(captured(note.clone())), NONE);
    let t = w.thought(note.id);
    assert_eq!(
        (t.phase, t.mode, t.project_id),
        (Phase::Captured, Mode::Note, Some(w.project))
    );
}

#[test]
fn row_route_clear_and_the_persons_pick_route_and_start_the_hold() {
    let mut w = World::new("route-clear");
    w.set_hold(3);
    let t = w.capture("fix the build");
    let route = Route::Clear {
        to: Destination::New(w.project),
        brief: "Fix the failing build".into(),
    };
    let until = time(w.now + 3000);
    let effects = w.ok(Event::Routed { thought: t, route });
    assert_eq!(effects, [Effect::Hold { thought: t, until }]);
    let th = w.thought(t);
    assert_eq!(shape(&th), (Phase::Routed, Status::Routed, None));
    assert_eq!(
        (th.mode, th.project_id, th.session_id),
        (Mode::Ask, Some(w.project), None)
    );
    assert_eq!(
        (th.hold_until, th.brief.as_deref()),
        (Some(until), Some("Fix the failing build"))
    );
    // The router answering after the thought left captured changes nothing.
    let late = Event::Routed {
        thought: t,
        route: Route::Unknown,
    };
    assert_eq!(w.ignored(late), Ignored::State);

    // The person picks a session: a follow-up, routed the same way.
    let (_, s) = w.running();
    let f = w.capture("and the docs");
    w.ok(Event::Pick {
        thought: f,
        to: Destination::Session(s),
    });
    let th = w.thought(f);
    assert_eq!((th.phase, th.mode), (Phase::Routed, Mode::Nudge));
    assert_eq!((th.session_id, th.project_id), (Some(s), Some(w.project)));

    // A destination given at capture is the person's pick, routed at once.
    let id = ThoughtId::mint();
    let pick = Capture {
        project_id: Some(w.project),
        ..capture(id, "lint")
    };
    let until = time(w.now + 3000);
    assert_eq!(w.ok(captured(pick)), [Effect::Hold { thought: id, until }]);
    assert_eq!(w.thought(id).phase, Phase::Routed);

    // A pick of a project that does not exist is gone and changes nothing.
    let x = w.capture("x");
    let nowhere = Event::Pick {
        thought: x,
        to: Destination::New(ProjectId::mint()),
    };
    assert!(matches!(w.apply(nowhere), Err(Error::Gone)));
    assert_eq!(w.thought(x).phase, Phase::Captured);
}

#[test]
fn row_route_ambiguous_asks_and_the_answer_routes() {
    let mut w = World::new("route-ambiguous");
    let site = project("/work/site");
    w.write(|tx| tx.insert_project(&site).unwrap());
    let t = w.capture("deploy it");
    let candidates = vec![
        Candidate {
            label: "app".into(),
            to: Destination::New(w.project),
        },
        Candidate {
            label: "site".into(),
            to: Destination::New(site.id),
        },
    ];
    let route = Route::Ambiguous {
        prompt: "Which project?".into(),
        candidates,
    };
    let effects = w.ok(Event::Routed { thought: t, route });
    let &[Effect::Notify(q)] = effects.as_slice() else {
        panic!("{effects:?}")
    };
    assert_eq!(
        shape(&w.thought(t)),
        (Phase::Captured, Status::NeedsYou, None)
    );
    let asked = w.question(q);
    assert_eq!(
        (asked.source, asked.reply_via),
        (QuestionSource::Router, ReplyVia::Core)
    );
    assert_eq!(
        (asked.thought_id, asked.session_id, asked.state),
        (Some(t), None, QuestionState::Open)
    );
    assert_eq!(asked.prompt, "Which project?");
    let choices = vec!["app".to_string(), "site".to_string()];
    assert_eq!(asked.kind, QuestionKind::Choice { choices });

    // A choice that does not exist is refused and changes nothing.
    let wrong = w.answer(q, Response::Choice { choice: 2 });
    assert!(matches!(wrong, Err(Error::Invalid(_))), "{wrong:?}");
    assert_eq!(w.question(q).state, QuestionState::Open);

    // Choosing routes it there and starts the hold.
    let effects = w.answer(q, Response::Choice { choice: 1 }).unwrap();
    let until = time(w.now + u64::from(DEFAULT_HOLD) * 1000);
    assert_eq!(effects, [Effect::Hold { thought: t, until }]);
    let th = w.thought(t);
    assert_eq!(shape(&th), (Phase::Routed, Status::Routed, None));
    assert_eq!(th.project_id, Some(site.id));
    let asked = w.question(q);
    assert_eq!(asked.state, QuestionState::Answered);
    let answer = asked.answer.unwrap();
    assert_eq!(
        (answer.response, answer.device_id),
        (Response::Choice { choice: 1 }, Some(w.device))
    );
    // It is settled: a second answer is gone.
    let again = w.answer(q, Response::Choice { choice: 0 });
    assert!(matches!(again, Err(Error::Gone)), "{again:?}");
}

#[test]
fn a_router_question_declined_or_bypassed_closes() {
    let mut w = World::new("route-declined");
    let ambiguous = |w: &World| Route::Ambiguous {
        prompt: "Where?".into(),
        candidates: vec![Candidate {
            label: "app".into(),
            to: Destination::New(w.project),
        }],
    };
    let notified = |effects: Vec<Effect>| match effects.as_slice() {
        &[Effect::Notify(q)] => q,
        other => panic!("{other:?}"),
    };

    // Declined: the thought stays captured, as an idea.
    let t = w.capture("maybe later");
    let route = ambiguous(&w);
    let q = notified(w.ok(Event::Routed { thought: t, route }));
    assert_eq!(w.answer(q, Response::Deny).unwrap(), NONE);
    let th = w.thought(t);
    assert_eq!(
        (shape(&th), th.mode),
        ((Phase::Captured, Status::Captured, None), Mode::Note)
    );
    assert_eq!(w.question(q).state, QuestionState::Answered);

    // Bypassed: the person picks while the router asks; its question is withdrawn.
    let t = w.capture("ship it");
    let route = ambiguous(&w);
    let q = notified(w.ok(Event::Routed { thought: t, route }));
    let to = Destination::New(w.project);
    w.ok(Event::Pick { thought: t, to });
    assert_eq!(shape(&w.thought(t)), (Phase::Routed, Status::Routed, None));
    assert_eq!(w.question(q).state, QuestionState::Withdrawn);

    // Ambiguous with nobody to choose is an idea, as unknown is.
    let t = w.capture("hmm");
    let route = Route::Ambiguous {
        prompt: "Where?".into(),
        candidates: Vec::new(),
    };
    assert_eq!(w.ok(Event::Routed { thought: t, route }), NONE);
    assert_eq!(w.thought(t).mode, Mode::Note);
}

#[test]
fn row_route_unknown_keeps_an_idea_that_can_start_later() {
    let mut w = World::new("route-unknown");
    let t = w.capture("an idea");
    let route = Route::Unknown;
    assert_eq!(w.ok(Event::Routed { thought: t, route }), NONE);
    let th = w.thought(t);
    assert_eq!(
        (shape(&th), th.mode, th.hold_until),
        ((Phase::Captured, Status::Captured, None), Mode::Note, None)
    );
    // Picking a destination starts the idea.
    let to = Destination::New(w.project);
    w.ok(Event::Pick { thought: t, to });
    let th = w.thought(t);
    assert_eq!((th.phase, th.mode), (Phase::Routed, Mode::Ask));
}

#[test]
fn row_hold_end_launches_once_the_attempt_is_written() {
    let mut w = World::new("hold-end");
    let t = w.routed("fix the build");
    let until = w.thought(t).hold_until.unwrap();
    assert_eq!(until, time(w.now + u64::from(DEFAULT_HOLD) * 1000));

    // A timer that fires before the hold ends is stale and changes nothing.
    w.now = until.get() - 1;
    let early = AttemptId::mint();
    let fired = Event::HoldEnded {
        thought: t,
        attempt: early,
    };
    assert_eq!(w.ignored(fired), Ignored::State);
    assert!(w.read(|tx| tx.attempt(early).unwrap()).is_none());

    w.now = until.get();
    let attempt = AttemptId::mint();
    let session = SessionId::try_from(attempt.uuid()).unwrap();
    let effects = w.ok(Event::HoldEnded {
        thought: t,
        attempt,
    });
    let launch = Launch {
        attempt,
        thought: t,
        session,
        project: w.project,
        cwd: FOLDER.into(),
        agent: AGENT.into(),
        model: None,
        prompt: "fix the build".into(),
        resume: None,
    };
    assert_eq!(effects, [Effect::Launch(launch)]);
    // The attempt is written before anything is spawned.
    let a = w.read(|tx| tx.attempt(attempt).unwrap().unwrap());
    assert_eq!(
        (a.kind, a.started, a.outcome),
        (AttemptKind::Launch(t), w.now(), None)
    );
    let th = w.thought(t);
    assert_eq!(shape(&th), (Phase::Working, Status::Working, None));
    assert_eq!((th.session_id, th.hold_until), (Some(session), None));
    let s = w.session(session);
    assert_eq!(
        (s.state, s.thought_id, s.turn, s.terminal_id),
        (SessionState::Starting, Some(t), 0, None)
    );
    assert_eq!(
        (s.agent.as_str(), s.cwd.as_str(), s.project_id),
        (AGENT, FOLDER, w.project)
    );

    // The launch reported, the session names its terminal.
    assert_eq!(w.carry(&effects), NONE);
    assert_eq!(
        w.session(session).terminal_id,
        Some(TerminalId::try_from(session.uuid()).unwrap())
    );
    assert_eq!(w.outcome(attempt), ok_reply());
}

#[test]
fn row_start_during_the_hold_cancels_it() {
    let mut w = World::new("start");
    let t = w.routed("fix the build");
    let attempt = AttemptId::mint();
    let effects = w.ok(Event::Start {
        thought: t,
        attempt,
    });
    assert!(
        matches!(&effects[..], [Effect::Unhold(u), Effect::Launch(l)] if *u == t && l.attempt == attempt)
    );
    assert_eq!(w.thought(t).phase, Phase::Working);
    // Starting a captured thought does not fit: it has no destination yet.
    let c = w.capture("not yet");
    let start = Event::Start {
        thought: c,
        attempt: AttemptId::mint(),
    };
    assert_eq!(w.ignored(start), Ignored::State);
}

#[test]
fn row_follow_up_is_delivered_and_bound_at_turn_start() {
    let mut w = World::new("follow-up");
    let (t, s) = w.turn();
    w.say(
        s,
        Said::TurnFinished {
            answer: Some("Built.".into()),
        },
    )
    .unwrap();
    let f = ThoughtId::mint();
    let follow = Capture {
        session_id: Some(s),
        ..capture(f, "now run the tests")
    };
    w.ok(captured(follow));
    assert_eq!(w.thought(f).mode, Mode::Nudge);
    let attempt = AttemptId::mint();
    let effects = w.ok(Event::Start {
        thought: f,
        attempt,
    });
    let deliver = Deliver {
        attempt,
        thought: f,
        session: s,
        text: "now run the tests".into(),
    };
    assert_eq!(
        effects,
        [Effect::Unhold(f), Effect::Deliver(deliver.clone())]
    );
    assert!(w.carry(&effects).is_empty());
    assert_eq!(w.launcher.delivered, [deliver]);
    assert_eq!(w.outcome(attempt), ok_reply());
    let th = w.thought(f);
    assert_eq!((th.phase, th.session_id), (Phase::Working, Some(s)));
    // Delivered, but the agent has not taken it up yet.
    assert_eq!(w.session(s).thought_id, Some(t));

    // turn_started binds the waiting follow-up; its prompt makes no second thought.
    let prompt = Some("now run the tests".into());
    w.say(s, Said::TurnStarted { prompt }).unwrap();
    let session = w.session(s);
    assert_eq!(
        (session.state, session.turn, session.thought_id),
        (SessionState::Working, 2, Some(f))
    );
    let live = w.read(|tx| tx.thoughts_in_flight(s).unwrap());
    assert_eq!(live.iter().map(|t| t.id).collect::<Vec<_>>(), [f]);
    w.say(s, Said::TurnFinished { answer: None }).unwrap();
    assert_eq!(w.thought(f).phase, Phase::Done);
    assert_eq!(w.thought(t).phase, Phase::Done);
}

#[test]
fn a_follow_up_to_an_ended_session_continues_it_in_a_new_one() {
    let mut w = World::new("follow-up-ended");
    let (_, s) = w.turn();
    w.write(|tx| {
        let mut session = tx.session(s).unwrap().unwrap();
        session.resume = Some("conversation-1".into());
        tx.update_session(&session).unwrap();
    });
    w.say(s, Said::TurnFinished { answer: None }).unwrap();
    w.ok(Event::Exited {
        session: s,
        code: Some(0),
        silent: false,
    });
    let f = w.capture("one more thing");
    w.ok(Event::Pick {
        thought: f,
        to: Destination::Session(s),
    });
    let attempt = AttemptId::mint();
    let effects = w.ok(Event::Start {
        thought: f,
        attempt,
    });
    let session = SessionId::try_from(attempt.uuid()).unwrap();
    let launch = Launch {
        attempt,
        thought: f,
        session,
        project: w.project,
        cwd: FOLDER.into(),
        agent: AGENT.into(),
        model: None,
        prompt: "one more thing".into(),
        resume: Some("conversation-1".into()),
    };
    assert_eq!(effects, [Effect::Unhold(f), Effect::Launch(launch)]);
    assert_eq!(w.thought(f).session_id, Some(session));
}

#[test]
fn row_stop_before_launch_is_undo() {
    let mut w = World::new("undo");
    let t = w.routed("fix the build");
    assert_eq!(w.ok(Event::Stop { thought: t }), [Effect::Unhold(t)]);
    let th = w.thought(t);
    assert_eq!(
        (shape(&th), th.hold_until),
        ((Phase::Captured, Status::Captured, None), None)
    );

    // Its timer, had it fired anyway, changes nothing and writes no attempt.
    w.tick(u64::from(DEFAULT_HOLD) * 1000);
    let attempt = AttemptId::mint();
    assert_eq!(
        w.ignored(Event::HoldEnded {
            thought: t,
            attempt
        }),
        Ignored::State
    );
    assert!(w.read(|tx| tx.attempt(attempt).unwrap()).is_none());

    // Picked again, only the new hold launches it.
    let to = Destination::New(w.project);
    w.ok(Event::Pick { thought: t, to });
    w.tick(1);
    let attempt = AttemptId::mint();
    assert_eq!(
        w.ignored(Event::HoldEnded {
            thought: t,
            attempt
        }),
        Ignored::State
    );
    w.tick(u64::from(DEFAULT_HOLD) * 1000);
    let effects = w.ok(Event::HoldEnded {
        thought: t,
        attempt,
    });
    assert!(matches!(&effects[..], [Effect::Launch(_)]), "{effects:?}");
}

#[test]
fn row_launch_fails_fails_the_thought_and_ends_its_session() {
    let mut w = World::new("launch-fails");
    w.launcher.refuse = Some("claude is not installed".into());
    let t = w.routed("fix the build");
    let attempt = AttemptId::mint();
    let effects = w.ok(Event::Start {
        thought: t,
        attempt,
    });
    assert_eq!(w.carry(&effects), NONE);
    assert_eq!(
        shape(&w.thought(t)),
        (Phase::Failed, Status::Failed, Some(Reason::Launch))
    );
    let s = w.session(SessionId::try_from(attempt.uuid()).unwrap());
    assert_eq!(
        (s.state, s.error.as_deref(), s.terminal_id),
        (SessionState::Ended, Some("claude is not installed"), None)
    );
    let outcome = failed_reply("claude is not installed");
    assert_eq!(w.outcome(attempt), outcome);
    // Repeating the start answers with that outcome and launches nothing.
    assert_eq!(
        w.ok(Event::Start {
            thought: t,
            attempt
        }),
        [Effect::Repeat(outcome)]
    );
    assert_eq!(w.launcher.launched.len(), 1);

    // A follow-up that cannot be delivered fails without ending its session.
    w.launcher.refuse = None;
    let (_, s) = w.turn();
    let f = w.capture("more");
    let to = Destination::Session(s);
    w.ok(Event::Pick { thought: f, to });
    w.launcher.refuse = Some("the terminal is gone".into());
    let effects = w.ok(Event::Start {
        thought: f,
        attempt: AttemptId::mint(),
    });
    w.carry(&effects);
    assert_eq!(
        shape(&w.thought(f)),
        (Phase::Failed, Status::Failed, Some(Reason::Launch))
    );
    assert_eq!(w.session(s).state, SessionState::Working);
}

#[test]
fn row_ready_makes_a_starting_session_idle() {
    let mut w = World::new("ready");
    let (t, s) = w.running();
    assert_eq!(w.session(s).state, SessionState::Starting);
    assert_eq!(w.say(s, Said::Ready).unwrap(), NONE);
    assert_eq!(w.session(s).state, SessionState::Idle);
    assert_eq!(w.thought(t).phase, Phase::Working);
    let again = w.report(s, Said::Ready);
    assert_eq!(w.ignored(Event::Report(again)), Ignored::State);
}

#[test]
fn row_turn_started_binds_the_launched_thought() {
    let mut w = World::new("turn-started");
    let (t, s) = w.running();
    // An agent that sends no ready starts its turn straight from starting.
    assert_eq!(w.say(s, Said::TurnStarted { prompt: None }).unwrap(), NONE);
    let session = w.session(s);
    assert_eq!(
        (session.state, session.turn, session.thought_id),
        (SessionState::Working, 1, Some(t))
    );
    assert_eq!(
        shape(&w.thought(t)),
        (Phase::Working, Status::Working, None)
    );
    // A second start while the turn runs does not fit.
    let again = w.report(s, Said::TurnStarted { prompt: None });
    assert_eq!(w.ignored(Event::Report(again)), Ignored::State);
}

#[test]
fn row_turn_started_by_hand_creates_its_thought() {
    let mut w = World::new("typed");
    let (t, s) = w.turn();
    w.say(s, Said::TurnFinished { answer: None }).unwrap();
    let prompt = Some("now also update the docs".to_string());
    w.say(s, Said::TurnStarted { prompt }).unwrap();
    let session = w.session(s);
    let typed = session.thought_id.unwrap();
    assert_ne!(typed, t);
    assert_eq!((session.state, session.turn), (SessionState::Working, 2));
    let th = w.thought(typed);
    assert_eq!(shape(&th), (Phase::Working, Status::Working, None));
    assert_eq!(
        (th.source, th.mode, th.text.as_str()),
        (Source::Terminal, Mode::Ask, "now also update the docs")
    );
    assert_eq!(
        (th.session_id, th.project_id, th.agent.as_deref()),
        (Some(s), Some(w.project), Some(AGENT))
    );
    assert_eq!(th.created, w.now());

    let answer = Some("Docs updated.\nThree files changed.".to_string());
    w.say(s, Said::TurnFinished { answer }).unwrap();
    assert_eq!(w.thought(typed).phase, Phase::Done);
    let results = w.results();
    assert_eq!(results.len(), 1);
    assert_eq!(
        (results[0].thought_id, results[0].summary.as_str()),
        (typed, "Docs updated.")
    );

    // A turn with no waiting thought and no prompt runs without one.
    w.say(s, Said::TurnStarted { prompt: None }).unwrap();
    assert_eq!(w.session(s).thought_id, None);
}

#[test]
fn row_activity_stores_nothing() {
    let mut w = World::new("activity");
    let (t, s) = w.turn();
    let before = w.thought(t);
    let effects = w
        .say(
            s,
            Said::Activity {
                text: "Reading files".into(),
            },
        )
        .unwrap();
    assert_eq!(
        effects,
        [Effect::Activity {
            session: s,
            text: "Reading files".into()
        }]
    );
    assert_eq!(w.change, None, "activity committed a change");
    assert_eq!(w.thought(t), before);
    w.ok(Event::Exited {
        session: s,
        code: None,
        silent: false,
    });
    let late = w.report(
        s,
        Said::Activity {
            text: "late".into(),
        },
    );
    assert_eq!(w.ignored(Event::Report(late)), Ignored::State);
}

#[test]
fn row_questions_drive_needs_you_until_the_last_one_closes() {
    let mut w = World::new("questions");
    let (t, s) = w.turn();
    let waited = w.ask(s, ReplyVia::Core);
    let in_terminal = w.ask(s, ReplyVia::Terminal);
    // A question opening leaves the phase and the session state as they are.
    assert_eq!(
        shape(&w.thought(t)),
        (Phase::Working, Status::NeedsYou, None)
    );
    assert_eq!(w.session(s).state, SessionState::Working);

    // Answering one of several does not clear needs you; the waiter gets the answer.
    assert_eq!(
        w.answer(waited, Response::Affirm).unwrap(),
        [Effect::Answer(waited)]
    );
    assert_eq!(w.thought(t).status, Status::NeedsYou);
    let answered = w.question(waited);
    assert_eq!(answered.state, QuestionState::Answered);
    assert_eq!(answered.answer.unwrap().response, Response::Affirm);

    // Withdrawal closes the other: working again.
    assert_eq!(
        w.ok(Event::Withdraw {
            question: in_terminal
        }),
        NONE
    );
    assert_eq!(
        shape(&w.thought(t)),
        (Phase::Working, Status::Working, None)
    );
    assert_eq!(w.question(in_terminal).state, QuestionState::Withdrawn);

    // Settled questions: answering a withdrawn one is gone; withdrawing an answered one does not fit.
    assert!(matches!(
        w.answer(in_terminal, Response::Deny),
        Err(Error::Gone)
    ));
    let withdraw = Event::Withdraw { question: waited };
    assert_eq!(w.ignored(withdraw), Ignored::State);

    // The waiter comes back with the same key while the turn is alive: it reopens.
    let back = w.question(in_terminal);
    assert_eq!(w.ok(ask(back.clone())), [Effect::Notify(in_terminal)]);
    assert_eq!(w.question(in_terminal).state, QuestionState::Open);
    assert_eq!(w.thought(t).status, Status::NeedsYou);
    // Asking again for an open or an answered question is a repeat.
    assert_eq!(w.ignored(ask(back)), Ignored::Repeat);
    let answered = w.question(waited);
    assert_eq!(w.ignored(ask(answered)), Ignored::Repeat);
}

#[test]
fn a_question_from_another_turn_or_between_turns_is_ignored() {
    let mut w = World::new("question-turn");
    let (t, s) = w.turn();
    let stale = Question {
        turn: Some(0),
        ..question(&w.session(s), ReplyVia::Core)
    };
    assert_eq!(w.ignored(ask(stale)), Ignored::State);
    w.say(s, Said::TurnFinished { answer: None }).unwrap();
    let idle = question(&w.session(s), ReplyVia::Core);
    assert_eq!(w.ignored(ask(idle)), Ignored::State);
    assert_eq!(w.thought(t).status, Status::Done);
}

#[test]
fn row_continued_answers_the_turns_terminal_questions() {
    let mut w = World::new("continued");
    let (t, s) = w.turn();
    let waited = w.ask(s, ReplyVia::Core);
    let in_terminal = w.ask(s, ReplyVia::Terminal);
    assert_eq!(w.say(s, Said::Continued).unwrap(), NONE);
    let closed = w.question(in_terminal);
    assert_eq!(closed.state, QuestionState::Answered);
    let answer = closed.answer.unwrap();
    assert_eq!(
        (answer.response, answer.device_id, answer.created),
        (Response::Terminal, None, w.now())
    );
    assert_eq!(w.question(waited).state, QuestionState::Open);
    assert_eq!(
        shape(&w.thought(t)),
        (Phase::Working, Status::NeedsYou, None)
    );
    assert_eq!(w.session(s).state, SessionState::Working);
}

#[test]
fn row_turn_finished_is_done_with_its_result() {
    let mut w = World::new("turn-finished");
    let (t, s) = w.turn();
    let q = w.ask(s, ReplyVia::Terminal);
    let answer = "All green.\n\nThe build passes on every target.";
    let effects = w
        .say(
            s,
            Said::TurnFinished {
                answer: Some(answer.into()),
            },
        )
        .unwrap();
    assert_eq!(effects, []);
    let th = w.thought(t);
    assert_eq!(shape(&th), (Phase::Done, Status::Done, None));
    assert_eq!(th.updated, w.now());
    assert_eq!(w.question(q).state, QuestionState::Withdrawn);
    let session = w.session(s);
    assert_eq!(
        (session.state, session.thought_id),
        (SessionState::Idle, Some(t))
    );
    let results = w.results();
    assert_eq!(results.len(), 1);
    let r = &results[0];
    assert_eq!(
        (r.thought_id, r.session_id, r.turn, r.kind),
        (t, Some(s), Some(1), ResultKind::Answer)
    );
    assert_eq!(r.summary, "All green.");
    assert_eq!(
        w.read(|tx| tx.result_body(r.id).unwrap()).as_deref(),
        Some(answer)
    );
    // A second finish does not fit an idle session.
    let again = w.report(s, Said::TurnFinished { answer: None });
    assert_eq!(w.ignored(Event::Report(again)), Ignored::State);
}

#[test]
fn row_turn_failed_and_interrupted_fail_the_thought() {
    let mut w = World::new("turn-failed");
    for (said, reason, error) in [
        (
            Said::TurnFailed {
                error: Some("rate limited".into()),
            },
            Reason::TurnFailed,
            Some("rate limited"),
        ),
        (Said::TurnInterrupted, Reason::Interrupted, None),
    ] {
        let (t, s) = w.turn();
        let q = w.ask(s, ReplyVia::Core);
        assert_eq!(w.say(s, said).unwrap(), NONE);
        assert_eq!(
            shape(&w.thought(t)),
            (Phase::Failed, Status::Failed, Some(reason))
        );
        assert_eq!(w.question(q).state, QuestionState::Withdrawn);
        let session = w.session(s);
        assert_eq!(
            (session.state, session.error.as_deref()),
            (SessionState::Idle, error)
        );
        assert!(w.results().is_empty());
    }
}

#[test]
fn row_exited_fails_a_working_thought_or_finishes_a_silent_one() {
    let mut w = World::new("exited");
    let (t, s) = w.turn();
    let q = w.ask(s, ReplyVia::Core);
    let exited = |session, code, silent| Event::Exited {
        session,
        code,
        silent,
    };
    assert_eq!(w.ok(exited(s, Some(1), false)), NONE);
    assert_eq!(
        shape(&w.thought(t)),
        (Phase::Failed, Status::Failed, Some(Reason::Exited))
    );
    let session = w.session(s);
    assert_eq!(
        (session.state, session.exit),
        (SessionState::Ended, Some(1))
    );
    assert_eq!(w.question(q).state, QuestionState::Withdrawn);
    // Ended is final: a second exit, or anything the agent still says, changes nothing.
    assert_eq!(w.ignored(exited(s, Some(0), false)), Ignored::State);
    let late = w.report(s, Said::TurnFinished { answer: None });
    assert_eq!(w.ignored(Event::Report(late)), Ignored::State);

    // An agent that sends no events reports its work by exiting cleanly.
    let (t, s) = w.running();
    w.ok(exited(s, Some(0), true));
    assert_eq!(shape(&w.thought(t)), (Phase::Done, Status::Done, None));
    // One that does send events and exits mid-turn has not finished.
    let (t, s) = w.turn();
    w.ok(exited(s, Some(0), false));
    assert_eq!(
        shape(&w.thought(t)),
        (Phase::Failed, Status::Failed, Some(Reason::Exited))
    );
    // After its turn finished, an exit leaves the done thought done.
    let (t, s) = w.turn();
    w.say(s, Said::TurnFinished { answer: None }).unwrap();
    w.ok(exited(s, Some(0), false));
    assert_eq!(w.thought(t).phase, Phase::Done);
    assert_eq!(w.session(s).state, SessionState::Ended);
}

#[test]
fn row_stop_after_launch_stops_the_process() {
    let mut w = World::new("stop");
    let (t, s) = w.turn();
    let q = w.ask(s, ReplyVia::Core);
    let terminal = w.session(s).terminal_id;
    assert_eq!(
        w.ok(Event::Stop { thought: t }),
        [Effect::Kill {
            session: s,
            terminal
        }]
    );
    assert_eq!(
        shape(&w.thought(t)),
        (Phase::Failed, Status::Failed, Some(Reason::Stopped))
    );
    assert_eq!(w.session(s).state, SessionState::Ended);
    assert_eq!(w.question(q).state, QuestionState::Withdrawn);
    // The exit that follows changes nothing more.
    let exit = Event::Exited {
        session: s,
        code: None,
        silent: false,
    };
    assert_eq!(w.ignored(exit), Ignored::State);
    assert_eq!(w.ignored(Event::Stop { thought: t }), Ignored::State);

    // Stopped before the launch was reported: the report asks to end what it started.
    let t = w.routed("again");
    let attempt = AttemptId::mint();
    let launch = w.ok(Event::Start {
        thought: t,
        attempt,
    });
    let s = SessionId::try_from(attempt.uuid()).unwrap();
    let stop = w.ok(Event::Stop { thought: t });
    assert_eq!(
        stop,
        [Effect::Kill {
            session: s,
            terminal: None
        }]
    );
    let terminal = Some(TerminalId::try_from(s.uuid()).unwrap());
    assert_eq!(
        w.carry(&launch),
        [Effect::Kill {
            session: s,
            terminal
        }]
    );
    assert_eq!(w.session(s).terminal_id, terminal);
    assert_eq!(w.thought(t).reason, Some(Reason::Stopped));
}

#[test]
fn row_retry_routes_a_failed_thought_again() {
    let mut w = World::new("retry");
    let (t, s) = w.turn();
    w.say(s, Said::TurnFailed { error: None }).unwrap();
    assert_eq!(w.ok(Event::Retry { thought: t }), NONE);
    let th = w.thought(t);
    assert_eq!(
        (shape(&th), th.hold_until),
        ((Phase::Routed, Status::Routed, None), None)
    );
    // It waits for Start, which runs it in a new session; the old one is untouched.
    let attempt = AttemptId::mint();
    let effects = w.ok(Event::Start {
        thought: t,
        attempt,
    });
    assert!(
        matches!(&effects[..], [Effect::Launch(l)] if l.session != s && l.resume.is_none()),
        "{effects:?}"
    );
    assert_eq!(w.session(s).state, SessionState::Idle);
    assert_eq!(w.ignored(Event::Retry { thought: t }), Ignored::State);
}

#[test]
fn row_settle_keeps_or_discards_pending_changes_once_the_session_ended() {
    let mut w = World::new("settle");
    let (t, s) = w.turn();
    w.say(s, Said::TurnFinished { answer: None }).unwrap();
    // Phase 3 records the worktree and its changes; the state machine settles them.
    w.write(|tx| {
        let mut th = tx.thought(t).unwrap().unwrap();
        th.workdir = Some(workdir(Changes::Pending));
        tx.update_thought(&th).unwrap();
    });
    let settle = |attempt, keep| Event::Settle {
        thought: t,
        attempt,
        keep,
    };
    let first = AttemptId::mint();
    assert!(matches!(
        w.apply(settle(first, true)),
        Err(Error::Conflict(_))
    ));
    w.ok(Event::Exited {
        session: s,
        code: Some(0),
        silent: false,
    });

    // Keep refused (say the destination moved): the changes stay pending.
    let effects = w.ok(settle(first, true));
    assert_eq!(
        effects,
        [Effect::Settle {
            attempt: first,
            thought: t,
            keep: true
        }]
    );
    let a = w.read(|tx| tx.attempt(first).unwrap().unwrap());
    assert_eq!((a.kind, a.outcome), (AttemptKind::Settle(t), None));
    // The same id for the other choice is a conflict.
    assert!(matches!(
        w.apply(settle(first, false)),
        Err(Error::Conflict(_))
    ));
    let refused = Event::Settled {
        attempt: first,
        error: Some("main moved".into()),
    };
    assert_eq!(w.ok(refused), NONE);
    assert_eq!(w.thought(t).workdir.unwrap().changes, Changes::Pending);
    assert_eq!(w.outcome(first), failed_reply("main moved"));
    assert_eq!(
        w.ok(settle(first, true)),
        [Effect::Repeat(failed_reply("main moved"))]
    );

    // Discard succeeds.
    let second = AttemptId::mint();
    w.ok(settle(second, false));
    w.ok(Event::Settled {
        attempt: second,
        error: None,
    });
    let th = w.thought(t);
    assert_eq!(
        (th.phase, th.workdir.unwrap().changes),
        (Phase::Done, Changes::Discarded)
    );
    // Nothing is pending any more.
    let third = AttemptId::mint();
    assert_eq!(w.ignored(settle(third, true)), Ignored::State);

    // Keep on another thought.
    let (k, s) = w.turn();
    w.say(s, Said::TurnFinished { answer: None }).unwrap();
    w.write(|tx| {
        let mut th = tx.thought(k).unwrap().unwrap();
        th.workdir = Some(workdir(Changes::Pending));
        tx.update_thought(&th).unwrap();
    });
    w.ok(Event::Exited {
        session: s,
        code: Some(0),
        silent: false,
    });
    let keep = AttemptId::mint();
    w.ok(Event::Settle {
        thought: k,
        attempt: keep,
        keep: true,
    });
    w.ok(Event::Settled {
        attempt: keep,
        error: None,
    });
    assert_eq!(w.thought(k).workdir.unwrap().changes, Changes::Kept);
}

// Guards.

#[test]
fn events_from_an_old_token_a_sub_agent_or_another_turn_are_ignored() {
    let mut w = World::new("guards");
    let (t, s) = w.turn();
    let finish = |w: &mut World| w.report(s, Said::TurnFinished { answer: None });
    let old = Report {
        terminal: TerminalId::mint(),
        ..finish(&mut w)
    };
    assert_eq!(w.ignored(Event::Report(old)), Ignored::OldToken);
    let sub = Report {
        subagent: true,
        ..finish(&mut w)
    };
    assert_eq!(w.ignored(Event::Report(sub)), Ignored::Subagent);
    let other = Report {
        turn: Some(2),
        ..finish(&mut w)
    };
    assert_eq!(w.ignored(Event::Report(other)), Ignored::OtherTurn);
    // A turn start names the turn it begins.
    let restart = Report {
        turn: Some(1),
        ..w.report(s, Said::TurnStarted { prompt: None })
    };
    assert_eq!(w.ignored(Event::Report(restart)), Ignored::OtherTurn);
    assert_eq!(w.thought(t).phase, Phase::Working);
    // The right turn applies.
    let this = Report {
        turn: Some(1),
        ..finish(&mut w)
    };
    w.ok(Event::Report(this));
    assert_eq!(w.thought(t).phase, Phase::Done);
}

#[test]
fn a_repeated_event_id_is_applied_once() {
    let mut w = World::new("dedup");
    let (_, s) = w.running();
    let start = w.report(
        s,
        Said::TurnStarted {
            prompt: Some("typed".into()),
        },
    );
    w.ok(Event::Report(start.clone()));
    w.say(s, Said::TurnFinished { answer: None }).unwrap();
    // The same start again, say a retried hook call, does not open a second turn.
    assert_eq!(w.ignored(Event::Report(start)), Ignored::Repeat);
    let session = w.session(s);
    assert_eq!((session.state, session.turn), (SessionState::Idle, 1));
    // Activity is not remembered, so a repeat of it is shown again and stores nothing.
    let line = w.report(s, Said::Activity { text: "x".into() });
    w.ok(Event::Report(line.clone()));
    w.ok(Event::Report(line));
    assert_eq!(w.change, None);
}

#[test]
fn an_event_that_does_not_fit_changes_nothing() {
    let mut w = World::new("misfit");
    let c = w.capture("captured");
    let (t, s) = w.turn();
    let rev = w.store.rev();
    let misfits = [
        Event::Stop { thought: c },
        Event::Retry { thought: c },
        Event::Retry { thought: t },
        Event::Start {
            thought: c,
            attempt: AttemptId::mint(),
        },
        Event::HoldEnded {
            thought: t,
            attempt: AttemptId::mint(),
        },
        Event::Pick {
            thought: t,
            to: Destination::New(w.project),
        },
        Event::Routed {
            thought: t,
            route: Route::Unknown,
        },
        Event::Settle {
            thought: t,
            attempt: AttemptId::mint(),
            keep: true,
        },
    ];
    for event in misfits {
        let shown = format!("{event:?}");
        assert_eq!(w.ignored(event), Ignored::State, "{shown}");
    }
    for said in [Said::Ready, Said::TurnStarted { prompt: None }] {
        let report = w.report(s, said);
        assert_eq!(w.ignored(Event::Report(report)), Ignored::State);
    }
    assert_eq!(w.store.rev(), rev);
    // Records that do not exist are gone.
    let missing = Event::Stop {
        thought: ThoughtId::mint(),
    };
    assert!(matches!(w.apply(missing), Err(Error::Gone)));
    let unknown = Event::Launched {
        attempt: AttemptId::mint(),
        terminal: None,
    };
    assert!(matches!(w.apply(unknown), Err(Error::Gone)));
}

// Attempts (design §3).

#[test]
fn an_attempt_repeated_with_the_same_arguments_spawns_nothing() {
    let mut w = World::new("attempt-repeat");
    let t = w.routed("fix the build");
    let attempt = AttemptId::mint();
    let start = Event::Start {
        thought: t,
        attempt,
    };
    let effects = w.ok(start.clone());
    // Repeated while the first is under way: wait for it.
    assert_eq!(w.ok(start.clone()), [Effect::Repeat(None)]);
    w.carry(&effects);
    // Repeated after: the first outcome again.
    assert_eq!(w.ok(start.clone()), [Effect::Repeat(ok_reply())]);
    // A late hold timer under the same attempt is the same call.
    let hold = Event::HoldEnded {
        thought: t,
        attempt,
    };
    assert_eq!(w.ok(hold), [Effect::Repeat(ok_reply())]);
    assert_eq!(w.launcher.launched.len(), 1);
    // A second report of the same launch is a repeat.
    let again = Event::Launched {
        attempt,
        terminal: None,
    };
    assert_eq!(w.ignored(again), Ignored::Repeat);
}

#[test]
fn an_attempt_id_reused_with_other_arguments_is_a_conflict() {
    let mut w = World::new("attempt-conflict");
    let t = w.routed("one");
    let other = w.routed("two");
    let attempt = AttemptId::mint();
    w.ok(Event::Start {
        thought: t,
        attempt,
    });
    let elsewhere = Event::Start {
        thought: other,
        attempt,
    };
    assert!(matches!(w.apply(elsewhere), Err(Error::Conflict(_))));
    let settle = Event::Settle {
        thought: t,
        attempt,
        keep: true,
    };
    assert!(matches!(w.apply(settle), Err(Error::Conflict(_))));
    assert_eq!(w.thought(other).phase, Phase::Routed);
    let report = Event::Settled {
        attempt,
        error: None,
    };
    assert!(matches!(w.apply(report), Err(Error::Invalid(_))));
}

// Recovery (design §3), with the store's recovery pass at reopen.

#[test]
fn reopening_mid_turn_closes_everything_and_starts_nothing() {
    let mut w = World::new("recover-turn");
    let attempt_of = |w: &mut World, t| {
        let session = w.thought(t).session_id.unwrap();
        AttemptId::try_from(session.uuid()).unwrap()
    };
    let (t, s) = w.turn();
    let attempt = attempt_of(&mut w, t);
    let q = w.ask(s, ReplyVia::Core);
    let waiting = w.routed("held");
    w.reopen();

    // lost: working → failed (interrupted), the session ended, its questions withdrawn.
    assert_eq!(
        shape(&w.thought(t)),
        (Phase::Failed, Status::Failed, Some(Reason::Interrupted))
    );
    assert_eq!(w.session(s).state, SessionState::Ended);
    assert_eq!(w.question(q).state, QuestionState::Withdrawn);
    let terminal = w.session(s).terminal_id.unwrap();
    assert_eq!(
        w.read(|tx| tx.terminal(terminal).unwrap().unwrap().state),
        TerminalState::Lost
    );
    // routed stays routed, its timer gone.
    let held = w.thought(waiting);
    assert_eq!((held.phase, held.hold_until), (Phase::Routed, None));

    // The start that launched it answers from its record: nothing launches again.
    let repeat = Event::Start {
        thought: t,
        attempt,
    };
    assert_eq!(w.ok(repeat), [Effect::Repeat(ok_reply())]);
    // What the old session still says changes nothing.
    let late = w.report(s, Said::TurnFinished { answer: None });
    assert_eq!(w.ignored(Event::Report(late)), Ignored::State);
    let answer = w.answer(q, Response::Affirm);
    assert!(matches!(answer, Err(Error::Gone)), "{answer:?}");
    // The person retries and starts it: a new launch, by their hand.
    w.ok(Event::Retry { thought: t });
    let effects = w.ok(Event::Start {
        thought: t,
        attempt: AttemptId::mint(),
    });
    assert!(matches!(&effects[..], [Effect::Launch(_)]));
    assert_eq!(
        w.launcher.launched.len(),
        1,
        "only the first run was carried out"
    );
}

#[test]
fn reopening_while_held_restores_no_timer() {
    let mut w = World::new("recover-hold");
    let t = w.routed("fix the build");
    w.reopen();
    let th = w.thought(t);
    assert_eq!(
        (th.phase, th.status, th.hold_until),
        (Phase::Routed, Status::Routed, None)
    );
    // The old timer is gone with the old core; one that fired anyway is stale.
    w.tick(60_000);
    let fired = Event::HoldEnded {
        thought: t,
        attempt: AttemptId::mint(),
    };
    assert_eq!(w.ignored(fired), Ignored::State);
    // It waits for the person to press Start: no timer to cancel.
    let effects = w.ok(Event::Start {
        thought: t,
        attempt: AttemptId::mint(),
    });
    assert!(matches!(&effects[..], [Effect::Launch(_)]), "{effects:?}");
}

#[test]
fn an_uncertain_attempt_is_interrupted_and_never_relaunched() {
    let mut w = World::new("recover-attempt");
    let t = w.routed("fix the build");
    let attempt = AttemptId::mint();
    // The attempt is committed; the core stops before the launch is reported.
    let effects = w.ok(Event::Start {
        thought: t,
        attempt,
    });
    assert!(matches!(
        &effects[..],
        [Effect::Unhold(_), Effect::Launch(_)]
    ));
    w.reopen();
    assert_eq!(w.outcome(attempt), Some(AttemptOutcome::Interrupted));
    assert_eq!(
        shape(&w.thought(t)),
        (Phase::Failed, Status::Failed, Some(Reason::Interrupted))
    );
    let s = w.session(SessionId::try_from(attempt.uuid()).unwrap());
    assert_eq!(s.state, SessionState::Ended);
    // Asked again, it answers interrupted and starts nothing.
    let repeat = Event::Start {
        thought: t,
        attempt,
    };
    assert_eq!(
        w.ok(repeat),
        [Effect::Repeat(Some(AttemptOutcome::Interrupted))]
    );
    let late = Event::Launched {
        attempt,
        terminal: None,
    };
    assert_eq!(w.ignored(late), Ignored::Repeat);
}

#[test]
fn a_router_question_survives_a_restart_and_still_routes() {
    let mut w = World::new("recover-router");
    let t = w.capture("deploy");
    let route = Route::Ambiguous {
        prompt: "Which?".into(),
        candidates: vec![Candidate {
            label: "app".into(),
            to: Destination::New(w.project),
        }],
    };
    let effects = w.ok(Event::Routed { thought: t, route });
    let &[Effect::Notify(q)] = effects.as_slice() else {
        panic!("{effects:?}")
    };
    w.reopen();
    assert_eq!(
        (w.question(q).state, w.thought(t).status),
        (QuestionState::Open, Status::NeedsYou)
    );
    w.answer(q, Response::Choice { choice: 0 }).unwrap();
    assert_eq!(w.thought(t).phase, Phase::Routed);
}

// The hold.

#[test]
fn the_hold_follows_the_preference_and_zero_launches_at_once() {
    let mut w = World::new("hold-pref");
    w.set_hold(0);
    let t = w.capture("now");
    let to = Destination::New(w.project);
    assert_eq!(
        w.ok(Event::Pick { thought: t, to }),
        [Effect::Hold {
            thought: t,
            until: w.now()
        }]
    );
    // The timer is already due: the caller fires it at once.
    let attempt = AttemptId::mint();
    let effects = w.ok(Event::HoldEnded {
        thought: t,
        attempt,
    });
    assert!(matches!(&effects[..], [Effect::Launch(l)] if l.attempt == attempt));
    // Without the preference the default applies.
    w.write(|tx| {
        tx.delete_pref(PrefKey::Hold).unwrap();
    });
    let t = w.capture("later");
    let to = Destination::New(w.project);
    let until = time(w.now + u64::from(DEFAULT_HOLD) * 1000);
    assert_eq!(
        w.ok(Event::Pick { thought: t, to }),
        [Effect::Hold { thought: t, until }]
    );
}

// The happy path of the loop check (design §13), with both fixtures.

#[test]
fn a_thought_runs_captured_routed_working_needs_you_working_done() {
    let mut w = World::new("happy");
    let mut statuses = Vec::new();
    let mut seen = |w: &mut World, t| {
        let status = w.thought(t).status;
        if statuses.last() != Some(&status) {
            statuses.push(status);
        }
    };
    let t = w.capture("fix the build");
    seen(&mut w, t);
    let mut router = FixtureRouter(Route::Clear {
        to: Destination::New(w.project),
        brief: "Fix the failing build".into(),
    });
    let route = router.route(&w.thought(t));
    let effects = w.ok(Event::Routed { thought: t, route });
    seen(&mut w, t);
    let &[Effect::Hold { until, .. }] = effects.as_slice() else {
        panic!("{effects:?}")
    };
    w.now = until.get();
    let attempt = AttemptId::mint();
    let effects = w.ok(Event::HoldEnded {
        thought: t,
        attempt,
    });
    seen(&mut w, t);
    w.carry(&effects);
    assert_eq!(w.launcher.launched[0].prompt, "Fix the failing build");
    let s = w.thought(t).session_id.unwrap();
    w.say(s, Said::Ready).unwrap();
    w.say(s, Said::TurnStarted { prompt: None }).unwrap();
    seen(&mut w, t);
    let q = w.ask(s, ReplyVia::Core);
    seen(&mut w, t);
    assert_eq!(w.answer(q, Response::Affirm).unwrap(), [Effect::Answer(q)]);
    seen(&mut w, t);
    let answer = Some("Fixed: a missing import.".into());
    w.say(s, Said::TurnFinished { answer }).unwrap();
    seen(&mut w, t);

    use Status::*;
    assert_eq!(
        statuses,
        [Captured, Routed, Working, NeedsYou, Working, Done]
    );
    let results = w.results();
    assert_eq!((results.len(), results[0].thought_id), (1, t));
    assert_eq!(w.question(q).answer.unwrap().response, Response::Affirm);
    // Restarted, every record is there and nothing runs again.
    w.reopen();
    assert_eq!(w.thought(t).status, Done);
    assert_eq!(w.results().len(), 1);
    assert_eq!(
        w.ok(Event::Start {
            thought: t,
            attempt
        }),
        [Effect::Repeat(ok_reply())]
    );
    assert_eq!(w.launcher.launched.len(), 1);
}

// The sweep: every event, fed to every reachable state.

/// One step of a path through the machine.
#[derive(Clone, Debug)]
enum Step {
    Apply(Box<Event>),
    /// The launcher started this attempt's run: its terminal is stored, then `Launched` applied.
    Launched(AttemptId),
    /// Phase 3 found changes in a finished thought's worktree.
    Changes(ThoughtId),
}

/// Every state reachable in fewer steps than this is fed every event. Seven
/// steps reach every row: a settle, for one, is capture, pick, start, launch
/// failed, changes, settle, settled. Depth 9 also passes, in about 16 s.
const SWEEP_DEPTH: usize = 8;

/// Each step of a path happens 10 s after the one before, past the 5 s hold.
fn at_step(i: usize) -> Time {
    time(START + (i as u64 + 1) * 10_000)
}

impl Step {
    fn event(&self) -> Option<&Event> {
        match self {
            Step::Apply(event) => Some(event),
            _ => None,
        }
    }
}

fn own(attempt: AttemptId) -> SessionId {
    SessionId::try_from(attempt.uuid()).unwrap()
}

fn run(tx: &mut Tx, now: Time, step: &Step) -> Result<Vec<Effect>, Error> {
    match step {
        Step::Apply(event) => state::apply(tx, now, (**event).clone()),
        Step::Launched(attempt) => {
            let terminal = tx.session(own(*attempt)).unwrap().map(|s| {
                let t = Terminal {
                    id: TerminalId::try_from(attempt.uuid()).unwrap(),
                    rev: Rev::ZERO,
                    project_id: Some(s.project_id),
                    kind: TerminalKind::Agent,
                    title: s.agent,
                    cwd: s.cwd,
                    argv: Vec::new(),
                    cols: 80,
                    rows: 24,
                    state: TerminalState::Running,
                    exit: None,
                    offset: Offset::ZERO,
                };
                if tx.terminal(t.id).unwrap().is_none() {
                    tx.insert_terminal(&t, None).unwrap();
                }
                t.id
            });
            let attempt = *attempt;
            state::apply(tx, now, Event::Launched { attempt, terminal })
        }
        Step::Changes(id) => {
            let mut t = tx.thought(*id).unwrap().unwrap();
            t.workdir = Some(workdir(Changes::Pending));
            tx.update_thought(&t).unwrap();
            Ok(Vec::new())
        }
    }
}

/// The ids a path's records are read by: rows a transaction wrote are not
/// live until it commits, and the sweep never commits.
#[derive(Clone, Default)]
struct Known {
    thoughts: BTreeSet<ThoughtId>,
    sessions: BTreeSet<SessionId>,
    questions: BTreeSet<QuestionId>,
}

impl Known {
    /// Learns the ids of what an applied step made.
    fn learn(&mut self, tx: &Tx, step: &Step) {
        match step.event() {
            Some(Event::Capture { capture, .. }) => {
                self.thoughts.insert(capture.id);
            }
            Some(Event::Start { attempt, .. } | Event::HoldEnded { attempt, .. })
                if tx.session(own(*attempt)).unwrap().is_some() =>
            {
                self.sessions.insert(own(*attempt));
            }
            _ => {}
        }
        self.questions
            .extend(tx.open_questions().unwrap().iter().map(|q| q.id));
        for s in self.sessions(tx) {
            self.thoughts.extend(s.thought_id);
        }
    }

    fn thoughts(&self, tx: &Tx) -> Vec<Thought> {
        let read = |id: &ThoughtId| tx.thought(*id).unwrap();
        self.thoughts.iter().filter_map(read).collect()
    }

    fn sessions(&self, tx: &Tx) -> Vec<Session> {
        let read = |id: &SessionId| tx.session(*id).unwrap();
        self.sessions.iter().filter_map(read).collect()
    }

    fn questions(&self, tx: &Tx) -> Vec<Question> {
        let read = |id: &QuestionId| tx.question(*id).unwrap();
        self.questions.iter().filter_map(read).collect()
    }

    /// Everything a client could see of the path's records.
    fn snapshot(&self, tx: &Tx) -> String {
        let sessions = self.sessions(tx);
        let terminals: Vec<_> = sessions
            .iter()
            .filter_map(|s| s.terminal_id.and_then(|t| tx.terminal(t).unwrap()))
            .collect();
        format!(
            "{:?}{sessions:?}{:?}{terminals:?}",
            self.thoughts(tx),
            self.questions(tx)
        )
    }

    /// The state as the table sees it: ids replaced by positions, turns capped.
    fn signature(&self, tx: &Tx, path: &[Step]) -> String {
        let (ts, ss, qs) = (self.thoughts(tx), self.sessions(tx), self.questions(tx));
        let at = |id: Option<SessionId>| id.and_then(|id| ss.iter().position(|s| s.id == id));
        let mut sig = String::new();
        for t in &ts {
            let changes = t.workdir.as_ref().map(|w| w.changes);
            let (held, session) = (t.hold_until.is_some(), at(t.session_id));
            let (phase, status, reason, mode) = (t.phase, t.status, t.reason, t.mode);
            write!(
                sig,
                "T{phase:?}{status:?}{reason:?}{mode:?}{held}{session:?}{changes:?};"
            )
            .unwrap();
        }
        for s in &ss {
            let current = s
                .thought_id
                .and_then(|id| ts.iter().position(|t| t.id == id));
            let (state, turn, terminal) = (s.state, s.turn.min(2), s.terminal_id.is_some());
            write!(sig, "S{state:?}{turn}{terminal}{current:?};").unwrap();
        }
        for q in &qs {
            let now = ss
                .iter()
                .any(|s| Some(s.id) == q.session_id && Some(s.turn) == q.turn);
            write!(sig, "Q{:?}{:?}{:?}{now};", q.state, q.source, q.reply_via).unwrap();
        }
        for settle in [false, true] {
            let pending = last_attempt(path, settle)
                .map(|(_, a)| tx.attempt(a).unwrap().is_some_and(|a| a.outcome.is_none()));
            write!(sig, "A{pending:?};").unwrap();
        }
        sig
    }
}

/// The state a path leads to, in a transaction that is never committed.
fn replay<'s>(store: &'s mut Store, path: &[Step]) -> Tx<'s> {
    let mut tx = store.begin().unwrap();
    for (i, step) in path.iter().enumerate() {
        run(&mut tx, at_step(i), step).unwrap();
    }
    tx
}

fn last_attempt(path: &[Step], settle: bool) -> Option<(ThoughtId, AttemptId)> {
    path.iter().rev().find_map(|step| match step.event()? {
        Event::Start { thought, attempt } | Event::HoldEnded { thought, attempt } if !settle => {
            Some((*thought, *attempt))
        }
        Event::Settle {
            thought, attempt, ..
        } if settle => Some((*thought, *attempt)),
        _ => None,
    })
}

struct Sweep {
    project: ProjectId,
    first: ThoughtId,
    second: ThoughtId,
    events: u64,
}

impl Sweep {
    fn report(&mut self, s: &Session, event: Said) -> Report {
        self.events += 1;
        Report {
            session: s.id,
            terminal: s
                .terminal_id
                .unwrap_or_else(|| TerminalId::try_from(s.id.uuid()).unwrap()),
            id: format!("event-{}", self.events),
            turn: None,
            subagent: false,
            event,
        }
    }

    /// Every event the state can be fed, with fresh ids where an event brings one.
    fn moves(&mut self, tx: &Tx, known: &Known, path: &[Step]) -> Vec<Step> {
        let p = Destination::New(self.project);
        let mut moves = vec![captured(capture(self.first, "fix the build"))];
        if let Some(s) = tx.thought(self.first).unwrap().and_then(|t| t.session_id) {
            moves.push(captured(Capture {
                session_id: Some(s),
                ..capture(self.second, "and the docs")
            }));
        }
        let mut steps = Vec::new();
        for id in [self.first, self.second] {
            let Some(t) = tx.thought(id).unwrap() else {
                continue;
            };
            let candidates = vec![Candidate {
                label: "app".into(),
                to: p,
            }];
            let routes = [
                Route::Clear {
                    to: p,
                    brief: "Fix it".into(),
                },
                Route::Ambiguous {
                    prompt: "Where?".into(),
                    candidates,
                },
                Route::Unknown,
            ];
            moves.extend(routes.map(|route| Event::Routed { thought: id, route }));
            moves.extend([
                Event::Pick { thought: id, to: p },
                Event::HoldEnded {
                    thought: id,
                    attempt: AttemptId::mint(),
                },
                Event::Start {
                    thought: id,
                    attempt: AttemptId::mint(),
                },
                Event::Stop { thought: id },
                Event::Retry { thought: id },
            ]);
            for keep in [true, false] {
                let attempt = AttemptId::mint();
                moves.push(Event::Settle {
                    thought: id,
                    attempt,
                    keep,
                });
            }
            if matches!(t.phase, Phase::Done | Phase::Failed) && t.workdir.is_none() {
                steps.push(Step::Changes(id));
            }
        }
        if let Some((thought, attempt)) = last_attempt(path, false) {
            moves.push(Event::Start { thought, attempt });
            let error = "refused".to_string();
            moves.push(Event::LaunchFailed { attempt, error });
            steps.push(Step::Launched(attempt));
        }
        if let Some((_, attempt)) = last_attempt(path, true) {
            for error in [None, Some("main moved".to_string())] {
                moves.push(Event::Settled { attempt, error });
            }
        }
        if let Some(s) = known.sessions(tx).last() {
            for said in [
                Said::Ready,
                Said::TurnStarted {
                    prompt: Some("typed by hand".into()),
                },
                Said::Activity {
                    text: "reading".into(),
                },
                Said::Continued,
                Said::TurnFinished {
                    answer: Some("Done.\nAll green.".into()),
                },
                Said::TurnFailed {
                    error: Some("rate limited".into()),
                },
                Said::TurnInterrupted,
            ] {
                moves.push(Event::Report(self.report(s, said)));
            }
            let finish = Said::TurnFinished { answer: None };
            let guarded = [
                Report {
                    terminal: TerminalId::mint(),
                    ..self.report(s, finish.clone())
                },
                Report {
                    subagent: true,
                    ..self.report(s, finish.clone())
                },
                Report {
                    turn: Some(s.turn + 7),
                    ..self.report(s, finish)
                },
            ];
            moves.extend(guarded.map(Event::Report));
            for (code, silent) in [(Some(1), false), (Some(0), true)] {
                let session = s.id;
                moves.push(Event::Exited {
                    session,
                    code,
                    silent,
                });
            }
            moves.push(ask(question(s, ReplyVia::Core)));
            moves.push(ask(question(s, ReplyVia::Terminal)));
        }
        let open = known.questions(tx).into_iter();
        if let Some(q) = open.rev().find(|q| q.state == QuestionState::Open) {
            for response in [Response::Choice { choice: 0 }, Response::Deny] {
                moves.push(Event::Answer {
                    question: q.id,
                    response,
                    by: None,
                });
            }
            moves.push(Event::Withdraw { question: q.id });
        }
        let apply = |event| Step::Apply(Box::new(event));
        moves.into_iter().map(apply).chain(steps).collect()
    }
}

/// What must hold after every applied event.
fn check(tx: &Tx, known: &Known, effects: &[Effect], step: &Step) {
    let (ts, ss, qs) = (known.thoughts(tx), known.sessions(tx), known.questions(tx));
    let session = |id: SessionId| ss.iter().find(|s| s.id == id).unwrap();
    let thought = |id: ThoughtId| ts.iter().find(|t| t.id == id).unwrap();
    let open: Vec<&Question> = qs
        .iter()
        .filter(|q| q.state == QuestionState::Open)
        .collect();
    for t in &ts {
        let asking = open.iter().any(|q| q.thought_id == Some(t.id));
        let status = if asking {
            Status::NeedsYou
        } else {
            t.phase.into()
        };
        assert_eq!(t.status, status, "status not derived after {step:?}: {t:?}");
        assert_eq!(t.phase == Phase::Failed, t.reason.is_some(), "{t:?}");
        assert!(t.hold_until.is_none() || t.phase == Phase::Routed, "{t:?}");
        if matches!(t.phase, Phase::Routed | Phase::Working) {
            assert_ne!(t.mode, Mode::Note, "a note left captured: {t:?}");
        }
        if t.phase == Phase::Working {
            let s = session(t.session_id.expect("a working thought has a session"));
            assert_ne!(
                s.state,
                SessionState::Ended,
                "working in an ended session: {t:?}"
            );
        }
    }
    for s in &ss {
        assert!(s.state != SessionState::Working || s.turn >= 1, "{s:?}");
        // A session in a turn drives the thought it names. An idle one only
        // remembers its last turn's thought, which a retry may run elsewhere.
        if let Some(t) = s.thought_id.filter(|_| s.state == SessionState::Working) {
            let t = thought(t);
            assert_eq!(
                (t.phase, t.session_id),
                (Phase::Working, Some(s.id)),
                "{s:?}"
            );
        }
    }
    for q in open {
        if q.source == QuestionSource::Router {
            let t = thought(q.thought_id.unwrap());
            assert_eq!(t.phase, Phase::Captured, "{q:?}");
        } else {
            let s = session(q.session_id.unwrap());
            assert_ne!(
                s.state,
                SessionState::Ended,
                "open in an ended session: {q:?}"
            );
            assert_eq!(q.turn, Some(s.turn), "open from another turn: {q:?}");
        }
    }
    for effect in effects {
        let (attempt, kind) = match effect {
            Effect::Launch(l) => {
                let s = session(l.session);
                assert_eq!(
                    (s.state, s.thought_id),
                    (SessionState::Starting, Some(l.thought))
                );
                (l.attempt, AttemptKind::Launch(l.thought))
            }
            Effect::Deliver(d) => {
                assert_ne!(session(d.session).state, SessionState::Ended);
                (d.attempt, AttemptKind::Launch(d.thought))
            }
            Effect::Settle {
                attempt, thought, ..
            } => (*attempt, AttemptKind::Settle(*thought)),
            _ => continue,
        };
        let written = tx.attempt(attempt).unwrap();
        let a = written.unwrap_or_else(|| panic!("{effect:?} without a written attempt"));
        assert_eq!((a.kind, a.outcome), (kind, None), "{effect:?}");
        if let AttemptKind::Launch(t) = kind {
            assert_eq!(thought(t).phase, Phase::Working, "{effect:?}");
        }
    }
}

/// The kind of a step: its event's name, a route's or a report's.
fn label(step: &Step) -> String {
    let text = match step.event() {
        Some(Event::Report(r)) => format!("{:?}", r.event),
        Some(Event::Routed { route, .. }) => format!("{route:?}"),
        Some(event) => format!("{event:?}"),
        None => format!("{step:?}"),
    };
    text.split([' ', '(', '{']).next().unwrap().into()
}

#[test]
fn every_event_in_every_reachable_state_keeps_the_rules() {
    let dir = Dir::new("sweep");
    let (mut store, _) = Store::open(&dir.db()).unwrap();
    let p = project(FOLDER);
    let mut tx = store.begin().unwrap();
    tx.insert_project(&p).unwrap();
    tx.commit().unwrap();
    let mut sweep = Sweep {
        project: p.id,
        first: ThoughtId::mint(),
        second: ThoughtId::mint(),
        events: 0,
    };
    let began = Instant::now();
    let mut queue = VecDeque::from([(Vec::<Step>::new(), Known::default())]);
    let mut states = HashSet::new();
    let (mut explored, mut fed, mut applied) = (0, 0, BTreeSet::new());
    while let Some((path, known)) = queue.pop_front() {
        explored += 1;
        let mut tx = replay(&mut store, &path);
        let before = known.snapshot(&tx);
        let now = at_step(path.len());
        for step in sweep.moves(&tx, &known, &path) {
            fed += 1;
            match run(&mut tx, now, &step) {
                Err(Error::Store(e)) => panic!("{step:?} after {path:?}: {e}"),
                // Refused: nothing changed, so the same transaction serves the next move.
                Err(_) => assert_eq!(
                    known.snapshot(&tx),
                    before,
                    "{step:?} was refused but wrote"
                ),
                Ok(effects) => {
                    let mut learned = known.clone();
                    learned.learn(&tx, &step);
                    check(&tx, &learned, &effects, &step);
                    applied.insert(label(&step));
                    let mut next = path.clone();
                    next.push(step);
                    let state = learned.signature(&tx, &next);
                    if next.len() < SWEEP_DEPTH && states.insert(state) {
                        queue.push_back((next, learned));
                    }
                    drop(tx);
                    tx = replay(&mut store, &path);
                }
            }
        }
    }
    eprintln!(
        "sweep: {explored} states fed {fed} events, {} distinct states found, {:?}",
        states.len(),
        began.elapsed()
    );
    let every = [
        "Capture",
        "Pick",
        "Clear",
        "Ambiguous",
        "Unknown",
        "HoldEnded",
        "Start",
        "Stop",
        "Retry",
        "Settle",
        "Settled",
        "Launched",
        "LaunchFailed",
        "Exited",
        "Ready",
        "TurnStarted",
        "Activity",
        "Continued",
        "TurnFinished",
        "TurnFailed",
        "TurnInterrupted",
        "Ask",
        "Answer",
        "Withdraw",
        "Changes",
    ];
    let missing: Vec<_> = every.iter().filter(|l| !applied.contains(**l)).collect();
    assert!(missing.is_empty(), "never applied: {missing:?}");
}
