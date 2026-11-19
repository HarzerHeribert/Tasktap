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
    self, Candidate, Deliver, Destination, Effect, Error, Event, FixtureLauncher, FixtureRouter,
    Ignored, Launch, Launcher, Report, Route, Router, locally,
};
use tasktap_core::store::{AttemptKind, AttemptOutcome, Store, Tx};
use tasktap_proto::{
    AttemptId, Capture, Change, Changes, Code, Collection, Device, DeviceId, Event as Said,
    Isolate, Mode, Offset, Outcome, Phase, Place, Placed, PrefKey, PrefValue, Project, ProjectId,
    ProjectKind, Question, QuestionId, QuestionKind, QuestionSource, QuestionState, READ_HOLD,
    Reason, ReplyVia, Response, ResultKind, Rev, RouteBy, Routing, Secret, Session, SessionId,
    SessionState, Set, Source, Status, Terminal, TerminalId, TerminalKind, TerminalState, Thought,
    ThoughtId, Time, TurnResult, Workdir,
};

/// Seconds a thought is held while the preference is unset.
const DEFAULT_HOLD: u32 = tasktap_proto::DEFAULT_HOLD;

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
        agent: None,
        model: None,
        current: None,
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
        places: None,
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
        destination: Some("main".into()),
        base: "0123abc".into(),
        left_out: false,
        changes,
        files: 1,
        insertions: 1,
        deletions: 0,
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
    store: Store,
    now: u64,
    project: ProjectId,
    device: DeviceId,
    launcher: FixtureLauncher,
    events: u32,
    /// What the last applied event committed.
    change: Option<Change>,
    /// Last, so that it is dropped last: fields go in this order, and Windows
    /// removes no folder while the store still has its database open in it.
    dir: Dir,
}

impl World {
    fn new(name: &str) -> World {
        let dir = Dir::new(name);
        let (mut store, _) = Store::open(&dir.db(), time(START)).unwrap();
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
        self.store = Store::open(&self.dir.db(), self.now()).unwrap().0;
    }

    /// Does the caller's part of launch and delivery effects: asks the
    /// launcher, stores the terminal it started, and reports back.
    fn carry(&mut self, effects: &[Effect]) -> Vec<Effect> {
        let mut out = Vec::new();
        for effect in effects {
            let report = match effect {
                Effect::Launch(l) => match self.launcher.launch(l, &Secret([3; 32])) {
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
        assert_eq!(
            self.ok(captured(capture(id, text))),
            [Effect::Route {
                thought: id,
                current: None,
                by: None,
                picked: None,
            }]
        );
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
            resume: None,
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

    /// Sets the project's isolation and whether it is a git repository.
    fn isolate(&mut self, isolate: Isolate, git: bool) {
        let id = self.project;
        self.write(|tx| {
            let mut p = tx.project(id).unwrap().unwrap();
            (p.isolate, p.git) = (isolate, git);
            tx.update_project(&p).unwrap();
        });
    }

    /// Starts a routed thought by hand and returns its launch.
    fn start(&mut self, t: ThoughtId) -> Launch {
        let attempt = AttemptId::mint();
        let effects = self.ok(Event::Start {
            thought: t,
            attempt,
        });
        match &effects[..] {
            [Effect::Unhold(_), Effect::Launch(l)] | [Effect::Launch(l)] => l.clone(),
            other => panic!("no launch: {other:?}"),
        }
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

/// What a turn's start does besides its records: its first activity line.
fn started(session: SessionId) -> [Effect; 1] {
    [Effect::Activity {
        session,
        text: state::TURN_STARTED.into(),
    }]
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
    assert_eq!(
        w.ok(captured(c.clone())),
        [Effect::Route {
            thought: id,
            current: None,
            by: None,
            picked: None,
        }]
    );
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
    let effects = w.ok(Event::Routed {
        thought: t,
        route,
        how: locally(None),
        current: None,
    });
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
        how: locally(None),
        current: None,
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
        brief: None,
    };
    let effects = w.ok(Event::Routed {
        thought: t,
        route,
        how: locally(None),
        current: None,
    });
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
    // Each choice says what it is: here two folders, by their ids.
    assert_eq!(
        asked.places,
        Some(vec![Place::Project(w.project), Place::Project(site.id)])
    );
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
        brief: None,
    };
    let notified = |effects: Vec<Effect>| match effects.as_slice() {
        &[Effect::Notify(q)] => q,
        other => panic!("{other:?}"),
    };

    // Declined: the thought stays captured, as an idea.
    let t = w.capture("maybe later");
    let route = ambiguous(&w);
    let q = notified(w.ok(Event::Routed {
        thought: t,
        route,
        how: locally(None),
        current: None,
    }));
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
    let q = notified(w.ok(Event::Routed {
        thought: t,
        route,
        how: locally(None),
        current: None,
    }));
    let to = Destination::New(w.project);
    w.ok(Event::Pick { thought: t, to });
    assert_eq!(shape(&w.thought(t)), (Phase::Routed, Status::Routed, None));
    assert_eq!(w.question(q).state, QuestionState::Withdrawn);

    // Ambiguous with nobody to choose is an idea, as unknown is.
    let t = w.capture("hmm");
    let route = Route::Ambiguous {
        prompt: "Where?".into(),
        candidates: Vec::new(),
        brief: None,
    };
    assert_eq!(
        w.ok(Event::Routed {
            thought: t,
            route,
            how: locally(None),
            current: None,
        }),
        NONE
    );
    assert_eq!(w.thought(t).mode, Mode::Note);
}

#[test]
fn row_route_unknown_keeps_an_idea_that_can_start_later() {
    let mut w = World::new("route-unknown");
    let t = w.capture("an idea");
    let route = Route::Unknown;
    assert_eq!(
        w.ok(Event::Routed {
            thought: t,
            route,
            how: locally(None),
            current: None,
        }),
        NONE
    );
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
        worktree: None,
        words: None,
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
        words: None,
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

/// A follow-up whose delivery is reported failed after its agent's
/// turn_started bound it was typed after all: its turn decides how it ends.
#[test]
fn a_follow_up_its_agent_began_is_left_to_its_turn_when_its_delivery_is_reported_failed() {
    let mut w = World::new("follow-up-late");
    let (_, s) = w.turn();
    w.say(s, Said::TurnFinished { answer: None }).unwrap();
    let f = ThoughtId::mint();
    let follow = Capture {
        session_id: Some(s),
        ..capture(f, "now run the tests")
    };
    w.ok(captured(follow));
    let attempt = AttemptId::mint();
    w.ok(Event::Start {
        thought: f,
        attempt,
    });
    let prompt = Some("now run the tests".into());
    w.say(s, Said::TurnStarted { prompt }).unwrap();
    assert_eq!(w.session(s).thought_id, Some(f));
    let error = "late".to_string();
    assert_eq!(w.ok(Event::LaunchFailed { attempt, error }), []);
    assert_eq!(w.thought(f).phase, Phase::Working);
    assert!(w.outcome(attempt).is_some(), "the attempt has its outcome");
    let answer = Some("Tested.".into());
    w.say(s, Said::TurnFinished { answer }).unwrap();
    assert_eq!(w.thought(f).phase, Phase::Done);
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
        worktree: None,
        words: None,
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
fn row_launch_fails_fails_the_thought_says_why_and_ends_its_session() {
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
    let why: Vec<_> = (w.results().into_iter())
        .map(|r| (r.thought_id, r.kind, r.summary))
        .collect();
    let said = (t, ResultKind::Failure, "claude is not installed".to_owned());
    assert_eq!(why, [said]);
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
    let why = w.results().into_iter().find(|r| r.thought_id == f).unwrap();
    assert_eq!(
        (why.kind, why.session_id, why.summary.as_str()),
        (ResultKind::Failure, Some(s), "the terminal is gone")
    );
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
fn row_shown_asks_in_the_terminal_until_the_agent_is_ready() {
    let mut w = World::new("shown");
    let (t, s) = w.running();
    let shown = || Event::Shown {
        session: s,
        prompt: "Trust this folder?".into(),
    };
    let effects = w.ok(shown());
    let [Effect::Notify(q)] = effects[..] else {
        panic!("{effects:?}")
    };
    let asked = w.question(q);
    assert_eq!(
        (asked.reply_via, asked.source, asked.turn, asked.thought_id),
        (ReplyVia::Terminal, QuestionSource::Agent, Some(0), Some(t))
    );
    assert_eq!(w.thought(t).status, Status::NeedsYou);
    assert_eq!(w.session(s).state, SessionState::Starting);
    // Drawn again: the same question.
    assert_eq!(w.ignored(shown()), Ignored::Repeat);
    // Ready: the person answered it there.
    w.say(s, Said::Ready).unwrap();
    let answered = w.question(q);
    assert_eq!(answered.state, QuestionState::Answered);
    assert_eq!(answered.answer.unwrap().response, Response::Terminal);
    assert_eq!(w.thought(t).status, Status::Working);
    // Once ready, nothing it shows asks.
    assert_eq!(w.ignored(shown()), Ignored::State);
    // An agent that sends no ready goes on by starting its turn.
    let (t, s) = w.running();
    let effects = w.ok(Event::Shown {
        session: s,
        prompt: "Trust this folder?".into(),
    });
    let [Effect::Notify(q)] = effects[..] else {
        panic!("{effects:?}")
    };
    w.say(s, Said::TurnStarted { prompt: None }).unwrap();
    assert_eq!(w.question(q).state, QuestionState::Answered);
    assert_eq!(w.thought(t).status, Status::Working);
}

#[test]
fn row_turn_started_binds_the_launched_thought() {
    let mut w = World::new("turn-started");
    let (t, s) = w.running();
    // An agent that sends no ready starts its turn straight from starting.
    assert_eq!(
        w.say(s, Said::TurnStarted { prompt: None }).unwrap(),
        started(s)
    );
    let session = w.session(s);
    assert_eq!(
        (session.state, session.turn, session.thought_id),
        (SessionState::Working, 1, Some(t))
    );
    assert_eq!(
        shape(&w.thought(t)),
        (Phase::Working, Status::Working, None)
    );
}

#[test]
fn row_turn_started_in_an_open_turn_interrupts_it_first() {
    let mut w = World::new("restarted");
    let (t, s) = w.turn();
    let q = w.ask(s, ReplyVia::Core);
    // Interrupted in the terminal without a word, the agent takes the next
    // prompt: the open turn ends as turn_interrupted ends it, then the new
    // turn starts with a thought of its own.
    let prompt = Some("do this instead".to_string());
    assert_eq!(w.say(s, Said::TurnStarted { prompt }).unwrap(), started(s));
    assert_eq!(
        shape(&w.thought(t)),
        (Phase::Failed, Status::Failed, Some(Reason::Interrupted))
    );
    assert_eq!(w.question(q).state, QuestionState::Withdrawn);
    let session = w.session(s);
    let typed = session.thought_id.unwrap();
    assert_ne!(typed, t);
    assert_eq!((session.state, session.turn), (SessionState::Working, 2));
    assert_eq!(
        (w.thought(typed).text.as_str(), w.thought(typed).phase),
        ("do this instead", Phase::Working)
    );
    // The answer that ends the new turn is the new thought's, not the old one's.
    let answer = Some("done instead".to_string());
    w.say(s, Said::TurnFinished { answer }).unwrap();
    assert_eq!(w.thought(typed).phase, Phase::Done);
    assert_eq!(w.thought(t).phase, Phase::Failed);
    let results = w.results();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].thought_id, typed);
}

#[test]
fn row_turn_started_without_a_prompt_in_an_open_turn_goes_on() {
    let mut w = World::new("goes-on");
    let (t, s) = w.turn();
    let waited = w.ask(s, ReplyVia::Core);
    let in_terminal = w.ask(s, ReplyVia::Terminal);
    // An agent that reports its state says it is at work whenever that
    // state comes: the turn is the same one, and what it asked in its
    // terminal was answered there.
    assert_eq!(w.say(s, Said::TurnStarted { prompt: None }).unwrap(), NONE);
    assert_eq!(w.question(in_terminal).state, QuestionState::Answered);
    assert_eq!(w.question(waited).state, QuestionState::Open);
    let session = w.session(s);
    assert_eq!((session.state, session.turn), (SessionState::Working, 1));
    assert_eq!(session.thought_id, Some(t));
    assert_eq!(w.thought(t).phase, Phase::Working);
    // Said again with nothing open, nothing changes; its end is the thought's.
    assert_eq!(w.say(s, Said::TurnStarted { prompt: None }).unwrap(), NONE);
    let answer = Some("done".to_string());
    w.say(s, Said::TurnFinished { answer }).unwrap();
    assert_eq!(w.thought(t).phase, Phase::Done);
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
fn an_answer_must_fit_its_question_and_a_key_its_content() {
    let mut w = World::new("fits");
    let (_, s) = w.turn();
    let waited = w.ask(s, ReplyVia::Core);
    let in_terminal = w.ask(s, ReplyVia::Terminal);
    // A question asked in the terminal is answered there, never by a device.
    let text = Response::Text { text: "no".into() };
    for response in [Response::Affirm, Response::Deny, text] {
        let refused = w.answer(in_terminal, response);
        assert!(matches!(refused, Err(Error::Invalid(_))), "{refused:?}");
    }
    // Affirm fits only a confirm, a choice only a choice question's own;
    // `terminal` is the core's to record.
    for response in [Response::Choice { choice: 0 }, Response::Terminal] {
        let refused = w.answer(waited, response);
        assert!(matches!(refused, Err(Error::Invalid(_))), "{refused:?}");
    }
    assert_eq!(w.question(waited).state, QuestionState::Open);

    // The same key with other content is a conflict; with the same, a repeat.
    let stored = w.question(waited);
    let other = Question {
        prompt: "Delete everything?".into(),
        ..stored.clone()
    };
    assert!(matches!(w.apply(ask(other)), Err(Error::Conflict(_))));
    assert_eq!(w.ignored(ask(stored.clone())), Ignored::Repeat);

    // Withdrawing twice is a repeat. Once its turn has ended it cannot reopen.
    w.ok(Event::Withdraw { question: waited });
    let again = Event::Withdraw { question: waited };
    assert_eq!(w.ignored(again), Ignored::Repeat);
    w.say(s, Said::TurnFinished { answer: None }).unwrap();
    let typed = Said::TurnStarted {
        prompt: Some("and the docs".into()),
    };
    w.say(s, typed).unwrap();
    let now = w.session(s);
    let back = Question {
        turn: Some(now.turn),
        thought_id: now.thought_id,
        ..stored
    };
    assert!(matches!(w.apply(ask(back)), Err(Error::Gone)));
    assert_eq!(w.question(waited).state, QuestionState::Withdrawn);
}

#[test]
fn row_continued_answers_the_turns_terminal_questions() {
    let mut w = World::new("continued");
    let (t, s) = w.turn();
    let waited = w.ask(s, ReplyVia::Core);
    let in_terminal = w.ask(s, ReplyVia::Terminal);
    assert_eq!(w.say(s, Said::Continued { request: None }).unwrap(), NONE);
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

/// A shell terminal of the project, running, as an agent is adopted in.
fn shell(tx: &mut Tx, project: ProjectId) -> TerminalId {
    let t = Terminal {
        id: TerminalId::mint(),
        rev: Rev::ZERO,
        project_id: Some(project),
        kind: TerminalKind::Shell,
        title: "sh".into(),
        cwd: FOLDER.into(),
        argv: Vec::new(),
        cols: 80,
        rows: 24,
        state: TerminalState::Running,
        exit: None,
        offset: Offset::ZERO,
    };
    tx.insert_terminal(&t, None).unwrap();
    t.id
}

#[test]
fn row_stop_of_an_adopted_agent_has_its_shim_end_it_and_never_the_shell() {
    let mut w = World::new("stop-adopted");
    let project = w.project;
    let mut terminal = None;
    w.write(|tx| terminal = Some(shell(tx, project)));
    let terminal = terminal.unwrap();
    let s = SessionId::mint();
    let adopt = Event::Adopt {
        session: s,
        terminal,
        agent: "fixture".into(),
        cwd: FOLDER.into(),
    };
    assert_eq!(w.ok(adopt), []);
    let f = ThoughtId::mint();
    let follow = Capture {
        session_id: Some(s),
        ..capture(f, "and the docs")
    };
    w.ok(captured(follow));
    let attempt = AttemptId::mint();
    let started = w.ok(Event::Start {
        thought: f,
        attempt,
    });
    assert!(w.carry(&started).is_empty());
    assert_eq!(w.thought(f).phase, Phase::Working);
    assert_eq!(w.ok(Event::Stop { thought: f }), [Effect::StopAdopted(s)]);
    assert_eq!(
        shape(&w.thought(f)),
        (Phase::Failed, Status::Failed, Some(Reason::Stopped))
    );
    assert_eq!(w.session(s).state, SessionState::Ended);
    // The shim's report of the agent's exit changes nothing more.
    let exited = w.report(s, Said::Exited { code: Some(129) });
    assert_eq!(w.ignored(Event::Report(exited)), Ignored::State);
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
fn row_read_marks_an_ended_thought_read_until_it_is_retried() {
    let mut w = World::new("read");
    let (t, s) = w.turn();
    assert_eq!(w.ignored(Event::Read { thought: t }), Ignored::State);
    w.say(s, Said::TurnFailed { error: None }).unwrap();
    assert_eq!(w.ok(Event::Read { thought: t }), NONE);
    assert!(w.thought(t).read);
    assert_eq!(w.ignored(Event::Read { thought: t }), Ignored::Repeat);
    w.ok(Event::Retry { thought: t });
    assert!(!w.thought(t).read);
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
        kept: false,
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
        kept: false,
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

    // Keep on another thought; and a discard that found all of it in its
    // destination already, which is kept too.
    for keep in [true, false] {
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
        let attempt = AttemptId::mint();
        w.ok(Event::Settle {
            thought: k,
            attempt,
            keep,
        });
        w.ok(Event::Settled {
            attempt,
            kept: true,
            error: None,
        });
        assert_eq!(w.thought(k).workdir.unwrap().changes, Changes::Kept);
    }
}

// Pruning (the row "pruned"), on the rule alone, with the test's own clock.

const DAY: u64 = state::DAY;

/// A thought that is finished, last changed at `updated`: done and read.
fn finished(project: ProjectId, updated: u64) -> Thought {
    Thought {
        id: ThoughtId::mint(),
        rev: Rev::ZERO,
        text: "fix the build".into(),
        strokes: Vec::new(),
        source: Source::Typed,
        mode: Mode::Ask,
        phase: Phase::Done,
        status: Status::Done,
        reason: None,
        live: true,
        project_id: Some(project),
        session_id: None,
        brief: None,
        route: None,
        placed: None,
        agent: Some(AGENT.into()),
        model: None,
        workdir: None,
        hold_until: None,
        read: true,
        created: time(updated),
        updated: time(updated),
    }
}

/// A session at `turn` as its turn, in a terminal of its own of the kind.
fn session_in(
    tx: &mut Tx,
    project: ProjectId,
    kind: TerminalKind,
    turn: Option<ThoughtId>,
) -> Session {
    let terminal = shell(tx, project);
    let mut t = tx.terminal(terminal).unwrap().unwrap();
    (t.kind, t.state) = (kind, TerminalState::Exited);
    tx.update_terminal(&t).unwrap();
    let s = Session {
        id: SessionId::mint(),
        rev: Rev::ZERO,
        project_id: project,
        agent: AGENT.into(),
        terminal_id: Some(terminal),
        adopted: kind == TerminalKind::Shell,
        state: SessionState::Ended,
        thought_id: turn,
        turn: 1,
        resume: None,
        name: None,
        named_at: None,
        model: None,
        cwd: FOLDER.into(),
        exit: Some(0),
        error: None,
        activity: Vec::new(),
    };
    tx.insert_session(&s).unwrap();
    s
}

fn prune(w: &mut World, days: u16) -> state::Pruned {
    let now = w.now();
    let mut tx = w.store.begin().unwrap();
    let pruned = state::prune(&mut tx, now, days).unwrap();
    w.change = tx.commit().unwrap();
    pruned
}

fn nothing() -> state::Pruned {
    state::Pruned::default()
}

#[test]
fn row_pruned_removes_what_a_real_turn_left_at_the_limit_and_not_a_millisecond_before() {
    let mut w = World::new("pruned-turn");
    let (t, s) = w.turn();
    let q = w.ask(s, ReplyVia::Terminal);
    let answer = Some("All green.".to_owned());
    w.say(s, Said::TurnFinished { answer }).unwrap();
    w.tick(1000);
    w.ok(Event::Read { thought: t });
    let read_at = w.thought(t).updated.get();
    assert_eq!(read_at, w.now);
    let terminal = w.session(s).terminal_id.unwrap();
    let launch = w.read(|tx| tx.launch_names().unwrap());
    assert_eq!(launch.len(), 1);

    // Finished, and a hundred days old: its session is still there, idle,
    // and at it as its turn, so it stays.
    w.tick(100 * DAY);
    assert_eq!(prune(&mut w, 7), nothing());
    let exit = Event::Exited {
        session: s,
        code: Some(0),
        silent: false,
    };
    w.ok(exit);
    w.write(|tx| {
        let t = tx.terminal(terminal).unwrap().unwrap();
        let state = TerminalState::Exited;
        tx.update_terminal(&Terminal { state, ..t }).unwrap();
    });
    assert_eq!(w.thought(t).updated.get(), read_at, "an exit is no change");

    // For ever keeps it, whatever the time.
    assert_eq!(prune(&mut w, 0), nothing());
    // Kept for 100 days it goes once it is older than that, by one millisecond.
    w.now = read_at + 100 * DAY;
    assert_eq!(prune(&mut w, 100), nothing());
    assert_eq!(prune(&mut w, 101), nothing());
    w.now += 1;
    let pruned = prune(&mut w, 100);
    let gone = state::Pruned {
        thoughts: 1,
        sessions: 1,
        terminals: vec![terminal],
        more: false,
    };
    assert_eq!(pruned, gone);
    // Its question, its result, its session, its terminal and its attempt went with it,
    // and a client that saw them is told.
    w.read(|tx| {
        assert_eq!(tx.thought(t).unwrap(), None);
        assert_eq!(tx.session(s).unwrap(), None);
        assert_eq!(tx.question(q).unwrap(), None);
        assert_eq!(tx.terminal(terminal).unwrap(), None);
        assert!(tx.launch_names().unwrap().is_empty());
        for c in [Collection::Results, Collection::Questions] {
            let rows = serde_json::to_value(tx.live(c).unwrap()).unwrap();
            assert!(rows.get("put").is_none(), "{c:?}: {rows}");
        }
    });
    let told = serde_json::to_value(w.change.take().unwrap().sets).unwrap();
    let dels: Vec<_> = told.as_array().unwrap().iter().collect();
    let of = |c: &str| dels.iter().find(|set| set["c"] == c).map(|set| &set["del"]);
    assert_eq!(of("thoughts"), Some(&serde_json::json!([t])));
    assert_eq!(of("questions"), Some(&serde_json::json!([q])));
    assert_eq!(of("terminals"), Some(&serde_json::json!([terminal])));
    assert_eq!(of("results").map(|d| d.as_array().unwrap().len()), Some(1));
    // Nothing is left to prune.
    assert_eq!(prune(&mut w, 100), nothing());
}

#[test]
fn row_pruned_never_touches_what_is_live_unread_pending_or_the_persons_own() {
    let mut w = World::new("pruned-kept");
    let p = w.project;
    let old = START;
    // Each of these is a hundred days old and not finished, or not settled.
    let idea = w.capture("an idea for later");
    let routed = w.routed("wait for me");
    let (working, _) = w.turn();
    let unread = Thought {
        read: false,
        ..finished(p, old)
    };
    let failed_unread = Thought {
        phase: Phase::Failed,
        status: Status::Failed,
        reason: Some(Reason::Stopped),
        read: false,
        ..finished(p, old)
    };
    let pending = Thought {
        workdir: Some(workdir(Changes::Pending)),
        ..finished(p, old)
    };
    let unsettled = Thought {
        workdir: Some(workdir(Changes::Clean)),
        ..finished(p, old)
    };
    // Settled ones, and one with no copy at all, are finished for good.
    let kept = Thought {
        workdir: Some(workdir(Changes::Kept)),
        ..finished(p, old)
    };
    let discarded = Thought {
        phase: Phase::Failed,
        status: Status::Failed,
        reason: Some(Reason::TurnFailed),
        workdir: Some(workdir(Changes::Discarded)),
        ..finished(p, old)
    };
    let plain = finished(p, old);
    let stay = [&unread, &failed_unread, &pending, &unsettled];
    let go = [&kept, &discarded, &plain];
    let mut person = None;
    w.write(|tx| {
        for t in stay.iter().chain(&go) {
            tx.insert_thought(t).unwrap();
        }
        // A shell the person opened and left, with no session in it.
        person = Some(shell(tx, p));
    });
    w.tick(100 * DAY);
    let pruned = prune(&mut w, 1);
    assert_eq!((pruned.thoughts, pruned.more), (3, false));
    w.read(|tx| {
        for id in [idea, routed, working] {
            assert!(tx.thought(id).unwrap().is_some());
        }
        for t in stay {
            assert!(tx.thought(t.id).unwrap().is_some(), "{t:?}");
        }
        for t in go {
            assert_eq!(tx.thought(t.id).unwrap(), None, "{t:?}");
        }
        assert!(tx.terminal(person.unwrap()).unwrap().is_some());
    });
    // Once read, the unread one is a day's change old, not a hundred.
    w.ok(Event::Read { thought: unread.id });
    assert_eq!(prune(&mut w, 1), nothing());
    w.tick(DAY + 1);
    assert_eq!(prune(&mut w, 1).thoughts, 1);
    assert_eq!(w.read(|tx| tx.thought(unread.id).unwrap()), None);
}

#[test]
fn row_pruned_takes_an_ended_session_with_its_last_thought_and_an_agents_terminal_with_it() {
    let mut w = World::new("pruned-sessions");
    let p = w.project;
    let (first, last) = (finished(p, START), finished(p, START + 10 * DAY));
    let (mut agent, mut adopted, mut bare) = (None, None, None);
    let typed = finished(p, START);
    w.write(|tx| {
        for t in [&first, &last, &typed] {
            tx.insert_thought(t).unwrap();
        }
        // An agent's session of two turns, at the later one.
        let s = session_in(tx, p, TerminalKind::Agent, Some(last.id));
        for t in [&first, &last] {
            let session_id = Some(s.id);
            let t = Thought {
                session_id,
                ..(*t).clone()
            };
            tx.update_thought(&t).unwrap();
            let r = TurnResult {
                id: tasktap_proto::ResultId::mint(),
                rev: Rev::ZERO,
                thought_id: t.id,
                session_id,
                turn: Some(1),
                kind: ResultKind::Answer,
                summary: "Done.".into(),
            };
            tx.insert_result(&r, "Done.").unwrap();
        }
        agent = Some(s);
        // An agent the person ran in a shell of their own, and one that never had a turn.
        let s = session_in(tx, p, TerminalKind::Shell, Some(typed.id));
        let session_id = Some(s.id);
        let t = Thought {
            session_id,
            ..typed.clone()
        };
        tx.update_thought(&t).unwrap();
        adopted = Some(s);
        bare = Some(session_in(tx, p, TerminalKind::Agent, None));
    });
    let (agent, adopted, bare) = (agent.unwrap(), adopted.unwrap(), bare.unwrap());

    // Five days after the later turn: the first turn and the shell's are
    // older than three days, the later turn is not.
    w.now = START + 13 * DAY - 1;
    let pruned = prune(&mut w, 3);
    assert_eq!((pruned.thoughts, pruned.sessions), (2, 2));
    // The agent's terminal with no turn went with its session; the shell stayed.
    assert_eq!(pruned.terminals, [bare.terminal_id.unwrap()]);
    w.read(|tx| {
        assert_eq!(tx.thought(first.id).unwrap(), None);
        assert!(tx.thought(last.id).unwrap().is_some());
        assert_eq!(
            tx.session(agent.id).unwrap().unwrap().thought_id,
            Some(last.id)
        );
        assert!(tx.terminal(agent.terminal_id.unwrap()).unwrap().is_some());
        assert_eq!(tx.session(adopted.id).unwrap(), None);
        assert!(tx.terminal(adopted.terminal_id.unwrap()).unwrap().is_some());
        assert_eq!(tx.session(bare.id).unwrap(), None);
    });
    // Then the later turn, and with it the session and the terminal it ran in.
    w.now += 2;
    let pruned = prune(&mut w, 3);
    assert_eq!((pruned.thoughts, pruned.sessions), (1, 1));
    assert_eq!(pruned.terminals, [agent.terminal_id.unwrap()]);
    w.read(|tx| {
        assert_eq!(tx.session(agent.id).unwrap(), None);
        assert_eq!(tx.terminal(agent.terminal_id.unwrap()).unwrap(), None);
    });

    // A terminal still running, whatever its session's record says, is never removed.
    let mut left = None;
    w.write(|tx| {
        let s = session_in(tx, p, TerminalKind::Agent, None);
        let t = tx.terminal(s.terminal_id.unwrap()).unwrap().unwrap();
        let state = TerminalState::Running;
        tx.update_terminal(&Terminal { state, ..t }).unwrap();
        left = s.terminal_id;
    });
    let pruned = prune(&mut w, 3);
    assert_eq!((pruned.sessions, pruned.terminals.len()), (1, 0));
    assert!(w.read(|tx| tx.terminal(left.unwrap()).unwrap()).is_some());
}

#[test]
fn row_pruned_goes_in_steps_of_fifty_oldest_first_and_says_when_more_is_left() {
    let mut w = World::new("pruned-steps");
    let p = w.project;
    let all: Vec<Thought> = (0..state::PRUNE_STEP as u64 + 3)
        .map(|n| Thought {
            id: uuid_at(START + n),
            ..finished(p, START + n)
        })
        .collect();
    w.write(|tx| {
        for t in &all {
            tx.insert_thought(t).unwrap();
        }
    });
    w.now = START + 2 * DAY;
    let step = prune(&mut w, 1);
    assert_eq!((step.thoughts, step.more), (state::PRUNE_STEP, true));
    w.read(|tx| {
        let left = all.iter().filter(|t| tx.thought(t.id).unwrap().is_some());
        let left: Vec<_> = left.map(|t| t.id).collect();
        let newest: Vec<_> = all[state::PRUNE_STEP..].iter().map(|t| t.id).collect();
        assert_eq!(left, newest);
    });
    let step = prune(&mut w, 1);
    assert_eq!((step.thoughts, step.more), (3, false));
    assert_eq!(prune(&mut w, 1), nothing());
}

// Previews (design §9), on the rule alone.

#[test]
fn a_preview_is_one_per_target_beside_a_terminal_and_goes_with_the_terminals_record() {
    use tasktap_proto::{MAX_PREVIEWS, PreviewBy, PreviewKind};
    let mut w = World::new("previews");
    let p = w.project;
    let (mut person, mut agent) = (None, None);
    w.write(|tx| {
        person = Some(shell(tx, p));
        agent = Some(session_in(tx, p, TerminalKind::Agent, None));
    });
    let (person, agent) = (person.unwrap(), agent.unwrap().terminal_id.unwrap());
    let open = |w: &mut World, terminal, target: &str, by| {
        let now = w.now();
        let mut tx = w.store.begin().unwrap();
        let shown = (PreviewKind::Web, target.to_owned(), "localhost".to_owned());
        let opened = state::preview(&mut tx, now, terminal, shown, by);
        if opened.is_ok() {
            w.change = tx.commit().unwrap();
        }
        opened
    };
    // Beside a terminal the store knows, running or ended.
    let unknown = open(
        &mut w,
        TerminalId::mint(),
        "http://localhost:1/",
        PreviewBy::Person,
    );
    assert!(matches!(unknown, Err(Error::Gone)), "{unknown:?}");
    let first = open(&mut w, person, "http://localhost:1/", PreviewBy::Person).unwrap();
    let row = w.read(|tx| tx.previews_of(person).unwrap());
    assert_eq!(row.len(), 1);
    assert_eq!(
        (row[0].id, row[0].terminal_id, row[0].by),
        (first, person, PreviewBy::Person)
    );
    // The same target again is that preview, whoever asks, and writes nothing.
    w.change = None;
    let again = open(&mut w, person, "http://localhost:1/", PreviewBy::Agent).unwrap();
    assert_eq!((again, w.change.take()), (first, None));
    // Beside another terminal it is another preview.
    let beside = open(&mut w, agent, "http://localhost:1/", PreviewBy::Agent).unwrap();
    assert_ne!(beside, first);
    // Eight beside one terminal; the ninth is refused, and one of the eight is still found.
    for n in 2..=MAX_PREVIEWS {
        open(
            &mut w,
            person,
            &format!("http://localhost:{n}/"),
            PreviewBy::Person,
        )
        .unwrap();
    }
    let ninth = open(&mut w, person, "http://localhost:9/", PreviewBy::Person);
    assert!(matches!(ninth, Err(Error::Conflict(_))), "{ninth:?}");
    assert_eq!(
        open(&mut w, person, "http://localhost:8/", PreviewBy::Agent)
            .ok()
            .map(|_| ()),
        Some(())
    );
    assert_eq!(
        w.read(|tx| tx.previews_of(person).unwrap()).len(),
        MAX_PREVIEWS
    );

    // Pruning takes the agent's terminal, whose session is spent, and its preview with it.
    let pruned = prune(&mut w, 1);
    assert_eq!(pruned.terminals, [agent]);
    let told = serde_json::to_value(w.change.take().unwrap().sets).unwrap();
    let closed = told
        .as_array()
        .unwrap()
        .iter()
        .find(|set| set["c"] == "previews");
    assert_eq!(
        closed.map(|set| &set["del"]),
        Some(&serde_json::json!([beside]))
    );
    // Deleting the person's terminal closes all of its.
    w.write(|tx| assert!(tx.delete_terminal(person).unwrap()));
    assert!(w.read(|tx| tx.previews_of(person).unwrap()).is_empty());
}

/// An id minted at `ms`, so that ids order as their thoughts were made.
fn uuid_at(ms: u64) -> ThoughtId {
    state::fresh(time(ms)).unwrap()
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
    // The router found no place for it: nothing is asked about it any more.
    w.ok(Event::Routed {
        thought: c,
        route: Route::Unknown,
        how: locally(None),
        current: None,
    });
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
            how: locally(None),
            current: None,
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
    // Ready while a turn runs; a turn start there is a row of its own.
    let report = w.report(s, Said::Ready);
    assert_eq!(w.ignored(Event::Report(report)), Ignored::State);
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
        kept: true,
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
        brief: None,
    };
    let effects = w.ok(Event::Routed {
        thought: t,
        route,
        how: locally(None),
        current: None,
    });
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
    // Picked while the router is still asked: that is stopped.
    assert_eq!(
        w.ok(Event::Pick { thought: t, to }),
        [
            Effect::Unroute(t),
            Effect::Hold {
                thought: t,
                until: w.now()
            }
        ]
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
        [Effect::Unroute(t), Effect::Hold { thought: t, until }]
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
    let route = router.route(&tasktap_core::route::Request::default());
    let effects = w.ok(Event::Routed {
        thought: t,
        route,
        how: locally(None),
        current: None,
    });
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
            Some(Event::Adopt { session, .. }) => {
                self.sessions.insert(*session);
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
            let (phase, status, reason, mode, read) = (t.phase, t.status, t.reason, t.mode, t.read);
            write!(
                sig,
                "T{phase:?}{status:?}{reason:?}{mode:?}{read}{held}{session:?}{changes:?};"
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
    /// A shell terminal, and the session an agent adopted in it gets.
    shell: TerminalId,
    adopted: SessionId,
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
            resume: None,
            event,
        }
    }

    /// Every event the state can be fed, with fresh ids where an event brings one.
    fn moves(&mut self, tx: &Tx, known: &Known, path: &[Step]) -> Vec<Step> {
        let p = Destination::New(self.project);
        // Either the first thought runs and the second follows it up, or an
        // agent adopted in a shell, from the start, takes the second.
        let launched = tx.thought(self.first).unwrap().and_then(|t| t.session_id);
        let adopted = tx.session(self.adopted).unwrap().map(|s| s.id);
        let mut moves = Vec::new();
        if adopted.is_none() {
            moves.push(captured(capture(self.first, "fix the build")));
        }
        if path.is_empty() {
            moves.push(Event::Adopt {
                session: self.adopted,
                terminal: self.shell,
                agent: "fixture".into(),
                cwd: FOLDER.into(),
            });
        }
        if let Some(s) = adopted.or(launched) {
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
                    brief: None,
                },
                Route::Unknown,
            ];
            moves.extend(routes.map(|route| Event::Routed {
                thought: id,
                route,
                how: locally(None),
                current: None,
            }));
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
                Event::Read { thought: id },
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
            for (kept, error) in [
                (true, None),
                (false, None),
                (false, Some("main moved".to_string())),
            ] {
                let settled = Event::Settled {
                    attempt,
                    kept,
                    error,
                };
                moves.push(settled);
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
                Said::Continued { request: None },
                Said::TurnFinished {
                    answer: Some("Done.\nAll green.".into()),
                },
                Said::TurnFailed {
                    error: Some("rate limited".into()),
                },
                Said::TurnInterrupted,
                Said::Question {
                    question: tasktap_proto::Ask {
                        request: "call-1".into(),
                        kind: QuestionKind::Confirm,
                        prompt: "Allow rm?".into(),
                        detail: None,
                        source: None,
                    },
                },
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
            moves.push(Event::Shown {
                session: s.id,
                prompt: "Trust this folder?".into(),
            });
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
        // Plain data, which put and delete touch, was never run: no
        // session names it, so deleting it takes nothing of a run with it.
        if state::plain(tx, t).unwrap() {
            assert_eq!(t.phase, Phase::Captured, "{t:?}");
            assert!(!ss.iter().any(|s| s.thought_id == Some(t.id)), "{t:?}");
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
                "{s:?} after {step:?}"
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
            // An adopted agent is ended by its shim, never its shell's terminal.
            Effect::Kill {
                session: s,
                terminal: Some(_),
            } => {
                assert!(!session(*s).adopted, "{effect:?} would end a shell");
                continue;
            }
            Effect::StopAdopted(s) => {
                let s = session(*s);
                assert_eq!((s.adopted, s.state), (true, SessionState::Ended));
                continue;
            }
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
            }
            | Effect::Tidy { attempt, thought } => (*attempt, AttemptKind::Settle(*thought)),
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

/// Whether `step` starts a turn in a session whose turn is still open.
fn restarts(tx: &Tx, step: &Step) -> bool {
    let Some(Event::Report(r)) = step.event() else {
        return false;
    };
    let session = tx.session(r.session).unwrap();
    matches!(r.event, Said::TurnStarted { .. })
        && session.is_some_and(|s| s.state == SessionState::Working)
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

/// A worktree as the launcher reports it made.
fn made(name: &str) -> Workdir {
    Workdir {
        path: format!("/data/worktrees/{name}"),
        branch: format!("tasktap/{name}"),
        changes: Changes::Clean,
        files: 0,
        insertions: 0,
        ..workdir(Changes::Clean)
    }
}

/// What a look finds with `files` changed; with none, nothing would be lost.
fn found(files: u32) -> state::Found {
    state::Found {
        files,
        insertions: files * 2,
        deletions: files,
        gone: false,
        spare: files == 0,
    }
}

#[test]
fn row_launch_places_a_run_as_the_project_and_its_busyness_say() {
    let mut w = World::new("place");
    w.isolate(Isolate::Busy, true);
    // Nothing runs: in place. Its session then starts, which makes the project busy.
    let first = w.routed("one");
    let l = w.start(first);
    assert_eq!((l.cwd.as_str(), l.worktree), (FOLDER, None));
    let second = w.routed("two");
    let l = w.start(second);
    let hex = l.attempt.uuid().simple().to_string();
    let name = hex[hex.len() - 12..].to_owned();
    assert_eq!(l.worktree, Some(state::Worktree::New { name }));
    // Never, or no repository: in place, busy or not.
    w.isolate(Isolate::Never, true);
    let t = w.routed("three");
    assert_eq!(w.start(t).worktree, None);
    w.isolate(Isolate::Always, false);
    let t = w.routed("four");
    assert_eq!(w.start(t).worktree, None);
    // Always: a worktree, busy or not.
    w.isolate(Isolate::Always, true);
    let t = w.routed("five");
    assert!(matches!(
        w.start(t).worktree,
        Some(state::Worktree::New { .. })
    ));
}

#[test]
fn rows_a_worktree_is_recorded_looked_at_and_tidied_once_it_holds_nothing() {
    let mut w = World::new("worktree");
    w.isolate(Isolate::Always, true);
    let t = w.routed("fix the build");
    let l = w.start(t);
    let s = l.session;
    // Recorded on its owner before anything runs in it; the session works there.
    let tree = made("abcabcabcabc");
    let prepared = Event::Prepared {
        attempt: l.attempt,
        owner: t,
        workdir: tree.clone(),
    };
    assert_eq!(w.ok(prepared), NONE);
    assert_eq!(w.thought(t).workdir, Some(tree.clone()));
    assert_eq!(w.session(s).cwd, tree.path);
    // Never another in place of one not settled.
    let other = Event::Prepared {
        attempt: l.attempt,
        owner: t,
        workdir: made("0123456789ab"),
    };
    assert_eq!(w.ignored(other), Ignored::State);
    assert!(w.carry(&[Effect::Launch(l)]).is_empty());
    w.say(s, Said::Ready).unwrap();
    w.say(s, Said::TurnStarted { prompt: None }).unwrap();

    // A turn's end has the worktree looked at; what the look found is recorded.
    let effects = w.say(s, Said::TurnFinished { answer: None }).unwrap();
    assert!(effects.contains(&Effect::Survey(t)), "{effects:?}");
    let surveyed = |files, path: &str| Event::Surveyed {
        thought: t,
        path: path.into(),
        found: found(files),
    };
    assert_eq!(w.ok(surveyed(2, &tree.path)), NONE);
    let wd = w.thought(t).workdir.unwrap();
    assert_eq!(
        (wd.changes, wd.files, wd.insertions, wd.deletions),
        (Changes::Pending, 2, 4, 2)
    );
    // A look at another worktree's path changes nothing.
    assert_eq!(
        w.ignored(surveyed(0, "/data/worktrees/zzz")),
        Ignored::State
    );
    // Its session idle there: neither settled nor tidied.
    let settle = |attempt, keep| Event::Settle {
        thought: t,
        attempt,
        keep,
    };
    assert!(matches!(
        w.apply(settle(AttemptId::mint(), true)),
        Err(Error::Conflict(_))
    ));
    assert_eq!(w.ok(surveyed(0, &tree.path)), NONE);
    assert_eq!(w.thought(t).workdir.unwrap().changes, Changes::Clean);

    // Its session ends: looked at again, and with nothing in it, tidied.
    let effects = w.ok(Event::Exited {
        session: s,
        code: Some(0),
        silent: false,
    });
    assert!(effects.contains(&Effect::Survey(t)), "{effects:?}");
    let effects = w.ok(surveyed(0, &tree.path));
    let [Effect::Tidy { attempt, thought }] = effects[..] else {
        panic!("no tidy: {effects:?}");
    };
    assert_eq!(thought, t);
    let a = w.read(|tx| tx.attempt(attempt).unwrap().unwrap());
    assert_eq!((a.kind, a.outcome), (AttemptKind::Settle(t), None));
    // While it runs, a look counts for nothing.
    assert_eq!(w.ignored(surveyed(3, &tree.path)), Ignored::State);
    // It found changes after all: they wait to be kept or discarded.
    let refused = Event::Settled {
        attempt,
        kept: false,
        error: Some("it has changes".into()),
    };
    assert_eq!(w.ok(refused), NONE);
    assert_eq!(w.ok(surveyed(1, &tree.path)), NONE);
    assert_eq!(w.thought(t).workdir.unwrap().changes, Changes::Pending);
    // A terminal of the core in the worktree holds a settle off too.
    let shell = w.read(|tx| {
        tx.terminal(TerminalId::try_from(s.uuid()).unwrap())
            .unwrap()
    });
    let mut running = shell.unwrap();
    running.id = TerminalId::mint();
    running.cwd = format!("{}/src", tree.path);
    running.state = TerminalState::Running;
    w.write(|tx| tx.insert_terminal(&running, None).unwrap());
    assert!(matches!(
        w.apply(settle(AttemptId::mint(), false)),
        Err(Error::Conflict(_))
    ));
    w.write(|tx| {
        running.state = TerminalState::Exited;
        tx.update_terminal(&running).unwrap();
    });
    // One settle at a time.
    let first = AttemptId::mint();
    assert!(matches!(
        &w.ok(settle(first, false))[..],
        [Effect::Settle { .. }]
    ));
    assert!(matches!(
        w.apply(settle(AttemptId::mint(), true)),
        Err(Error::Conflict(_))
    ));
    // Nor does an agent started by hand in it while it settles get adopted.
    let project = w.project;
    let mut shell_terminal = None;
    w.write(|tx| shell_terminal = Some(crate::shell(tx, project)));
    let adopt = Event::Adopt {
        session: SessionId::mint(),
        terminal: shell_terminal.unwrap(),
        agent: AGENT.into(),
        cwd: format!("{}/src", tree.path),
    };
    assert!(matches!(w.apply(adopt), Err(Error::Conflict(_))));
    w.ok(Event::Settled {
        attempt: first,
        kept: false,
        error: None,
    });
    assert_eq!(w.thought(t).workdir.unwrap().changes, Changes::Discarded);
}

#[test]
fn row_surveyed_decides_a_settle_the_core_stopped_during_only_when_it_left_nothing() {
    let gone = state::Found {
        gone: true,
        ..found(0)
    };
    // What a keep left, in its destination or not, is pending again; what a
    // discard left with nothing in it is none, and tidied.
    for (keep, found, after) in [
        (true, gone, Changes::Kept),
        (true, found(1), Changes::Pending),
        (false, gone, Changes::Discarded),
        (false, found(1), Changes::Pending),
        (false, found(0), Changes::Clean),
    ] {
        let mut w = World::new("stopped");
        let (t, s) = w.turn();
        w.say(s, Said::TurnFinished { answer: None }).unwrap();
        w.write(|tx| {
            let mut th = tx.thought(t).unwrap().unwrap();
            th.workdir = Some(workdir(Changes::Pending));
            tx.update_thought(&th).unwrap();
        });
        w.ok(Event::Exited {
            session: s,
            code: Some(0),
            silent: false,
        });
        let attempt = AttemptId::mint();
        w.ok(Event::Settle {
            thought: t,
            attempt,
            keep,
        });
        // The core stops before the settle reports.
        w.reopen();
        assert_eq!(w.outcome(attempt), Some(AttemptOutcome::Interrupted));
        let effects = w.ok(Event::Surveyed {
            thought: t,
            path: workdir(Changes::Pending).path,
            found,
        });
        assert_eq!(
            w.thought(t).workdir.unwrap().changes,
            after,
            "{keep} {found:?}"
        );
        let tidied = after == Changes::Clean;
        assert_eq!(
            matches!(&effects[..], [Effect::Tidy { .. }]),
            tidied,
            "{effects:?}"
        );
    }
}

#[test]
fn every_event_in_every_reachable_state_keeps_the_rules() {
    let dir = Dir::new("sweep");
    let (mut store, _) = Store::open(&dir.db(), time(START)).unwrap();
    let p = project(FOLDER);
    let mut tx = store.begin().unwrap();
    tx.insert_project(&p).unwrap();
    let terminal = shell(&mut tx, p.id);
    tx.commit().unwrap();
    let mut sweep = Sweep {
        project: p.id,
        first: ThoughtId::mint(),
        second: ThoughtId::mint(),
        shell: terminal,
        adopted: SessionId::mint(),
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
            let restart = restarts(&tx, &step);
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
                    if restart {
                        applied.insert("TurnStarted in an open turn".into());
                    }
                    let mut next = path.clone();
                    next.push(step);
                    let state = learned.signature(&tx, &next);
                    // An adopted agent takes reports from the first step on,
                    // so its paths are cut shorter; the rest is the same.
                    let adopted = matches!(next[0].event(), Some(Event::Adopt { .. }));
                    let depth = if adopted {
                        SWEEP_DEPTH - 2
                    } else {
                        SWEEP_DEPTH
                    };
                    if next.len() < depth && states.insert(state) {
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
        "Adopt",
        "Pick",
        "Clear",
        "Ambiguous",
        "Unknown",
        "HoldEnded",
        "Start",
        "Stop",
        "Retry",
        "Read",
        "Settle",
        "Settled",
        "Launched",
        "LaunchFailed",
        "Exited",
        "Ready",
        "TurnStarted",
        "TurnStarted in an open turn",
        "Activity",
        "Continued",
        "TurnFinished",
        "TurnFailed",
        "TurnInterrupted",
        "Question",
        "Shown",
        "Ask",
        "Answer",
        "Withdraw",
        "Changes",
    ];
    let missing: Vec<_> = every.iter().filter(|l| !applied.contains(**l)).collect();
    assert!(missing.is_empty(), "never applied: {missing:?}");
}

// Routing by a model (design §8): when it is asked, what waits for it, and
// what the agent is told.

/// A thought as it is spoken: too long to go on as it is.
const SPOKEN: &str = "so, um, the build is broken again since this morning, I think it is the linker flags we \
    changed, anyway please get it green again and do not touch the release profile, that one is fine as it is";
const BRIEF: &str = "Get the build green again. Do not touch the release profile.";

fn consent() -> RouteBy {
    RouteBy {
        agent: "claude".into(),
        model: "haiku".into(),
    }
}

/// How a model's answer came.
fn by_model() -> Routing {
    Routing {
        by: "claude".into(),
        model: Some("haiku".into()),
        ms: Some(2300),
        ..Routing::default()
    }
}

impl World {
    fn consents(&mut self) {
        self.write(|tx| tx.put_pref(&PrefValue::RouteBy(Some(consent()))).unwrap());
    }

    /// A capture with no destination, which the router is asked about.
    fn asked(&mut self, text: &str) -> ThoughtId {
        let id = ThoughtId::mint();
        let effects = self.ok(captured(capture(id, text)));
        assert!(
            matches!(effects.as_slice(), [Effect::Route { .. }]),
            "{effects:?}"
        );
        id
    }

    fn answers(&mut self, thought: ThoughtId, route: Route) -> Result<Vec<Effect>, Error> {
        self.apply(Event::Routed {
            thought,
            route,
            how: by_model(),
            current: None,
        })
    }

    fn clear(&self, brief: &str) -> Route {
        Route::Clear {
            to: Destination::New(self.project),
            brief: brief.into(),
        }
    }
}

#[test]
fn row_capture_asks_a_model_only_with_the_persons_consent() {
    let mut w = World::new("consent");
    // Without it the match on names is asked.
    let t = w.capture("fix the build");
    let route = w.thought(t).route.unwrap();
    assert_eq!(
        (route.by.as_str(), route.model, route.pending),
        ("local", None, true)
    );
    // With it, the tool and the model it covers.
    w.consents();
    let id = ThoughtId::mint();
    assert_eq!(
        w.ok(captured(capture(id, "fix the build"))),
        [Effect::Route {
            thought: id,
            current: None,
            by: Some(consent()),
            picked: None,
        }]
    );
    let t = w.thought(id);
    let route = t.route.unwrap();
    assert_eq!(
        (route.by.as_str(), route.model.as_deref(), route.pending),
        ("claude", Some("haiku"), true)
    );
    assert_eq!(t.phase, Phase::Captured);
    // While the router is asked the thought is not plain data to edit.
    assert!(!w.read(|tx| state::plain(tx, &tx.thought(id).unwrap().unwrap()).unwrap()));
    // Cleared, it is the match on names again; `capture` checks that.
    w.write(|tx| {
        tx.delete_pref(PrefKey::RouteBy).unwrap();
    });
    let t = w.capture("fix it");
    assert_eq!(w.thought(t).route.unwrap().by, "local");
}

#[test]
fn row_route_clear_holds_from_the_capture_and_records_how_it_was_routed() {
    let mut w = World::new("since");
    w.consents();
    let id = w.asked(SPOKEN);
    let captured_at = w.now;
    // The model took 3 s of the 5 the hold lasts: 2 s are left.
    w.tick(3000);
    let until = time(captured_at + 5000);
    let route = w.clear(BRIEF);
    assert_eq!(
        w.answers(id, route.clone()).unwrap(),
        [Effect::Hold { thought: id, until }]
    );
    let t = w.thought(id);
    assert_eq!(
        (t.phase, t.brief.as_deref(), t.hold_until),
        (Phase::Routed, Some(BRIEF), Some(until))
    );
    assert_eq!(t.route, Some(by_model()));
    // An answer nobody waits for changes nothing.
    assert!(matches!(
        w.answers(id, route.clone()),
        Err(Error::Ignored(Ignored::State))
    ));
    // One that left less of the hold than it takes to read the route, or
    // took longer than the hold: the hold ends 2 s after it arrived.
    for took in [3001, 4000, 7000] {
        let late = w.asked(SPOKEN);
        w.tick(took);
        let until = time(w.now + 1000 * u64::from(READ_HOLD));
        assert_eq!(
            w.answers(late, route.clone()).unwrap(),
            [Effect::Hold {
                thought: late,
                until
            }],
            "after {took} ms"
        );
        assert_eq!(w.thought(late).hold_until, Some(until));
    }
    // A shorter hold is itself the time to read; with none, there is none.
    for hold in [1, 0] {
        w.set_hold(hold);
        let late = w.asked(SPOKEN);
        w.tick(7000);
        let until = time(w.now + 1000 * u64::from(hold));
        assert_eq!(
            w.answers(late, route.clone()).unwrap(),
            [Effect::Hold {
                thought: late,
                until
            }]
        );
    }
}

#[test]
fn rows_start_and_undo_act_at_once_while_a_late_route_is_there_to_read() {
    let mut w = World::new("read");
    w.consents();
    let route = w.clear(BRIEF);
    // Start: it launches now, with its brief, and the timer is cancelled.
    let id = w.asked(SPOKEN);
    w.tick(9000);
    w.answers(id, route.clone()).unwrap();
    w.tick(500);
    let effects = w.ok(Event::Start {
        thought: id,
        attempt: AttemptId::mint(),
    });
    assert!(
        matches!(effects.as_slice(), [Effect::Unhold(held), Effect::Launch(l)]
            if *held == id && l.prompt == BRIEF),
        "{effects:?}"
    );
    // Undo: captured again, the timer cancelled, nothing launched; the
    // timer that still fires finds no hold.
    let id = w.asked(SPOKEN);
    w.tick(9000);
    w.answers(id, route.clone()).unwrap();
    w.tick(500);
    assert_eq!(w.ok(Event::Stop { thought: id }), [Effect::Unhold(id)]);
    let t = w.thought(id);
    assert_eq!((t.phase, t.hold_until), (Phase::Captured, None));
    w.tick(1500);
    let ended = Event::HoldEnded {
        thought: id,
        attempt: AttemptId::mint(),
    };
    assert_eq!(w.ignored(ended), Ignored::State);
    // Before the time to read is over the hold has not ended.
    let id = w.asked(SPOKEN);
    w.tick(9000);
    w.answers(id, route).unwrap();
    w.tick(1999);
    let early = Event::HoldEnded {
        thought: id,
        attempt: AttemptId::mint(),
    };
    assert_eq!(w.ignored(early), Ignored::State);
    w.tick(1);
    let effects = w.ok(Event::HoldEnded {
        thought: id,
        attempt: AttemptId::mint(),
    });
    assert!(
        matches!(effects.as_slice(), [Effect::Launch(_)]),
        "{effects:?}"
    );
}

/// A router question's choices carry what they are, a folder or a session
/// and its id, beside their labels (design §6); no other question does.
#[test]
fn a_router_questions_choices_say_what_they_are() {
    let mut w = World::new("places");
    let (_, s) = w.running();
    w.say(s, Said::Ready).unwrap();
    let t = w.capture("and the docs");
    let candidates = vec![
        Candidate {
            label: "The claude session in app".into(),
            to: Destination::Session(s),
        },
        Candidate {
            label: "app".into(),
            to: Destination::New(w.project),
        },
    ];
    let route = Route::Ambiguous {
        prompt: "Where should this go?".into(),
        candidates,
        brief: None,
    };
    let effects = w.ok(Event::Routed {
        thought: t,
        route,
        how: locally(None),
        current: None,
    });
    let &[Effect::Notify(q)] = effects.as_slice() else {
        panic!("{effects:?}")
    };
    let asked = w.question(q);
    let choices = vec!["The claude session in app".into(), "app".into()];
    assert_eq!(asked.kind, QuestionKind::Choice { choices });
    assert_eq!(
        asked.places,
        Some(vec![Place::Session(s), Place::Project(w.project)])
    );
    // The answer is an index, as for any choice, and goes where its place says.
    w.answer(q, Response::Choice { choice: 0 }).unwrap();
    let th = w.thought(t);
    assert_eq!((th.session_id, th.mode), (Some(s), Mode::Nudge));

    // An agent's choice question has labels only.
    w.say(s, Said::TurnStarted { prompt: None }).unwrap();
    let session = w.session(s);
    let agents = Question {
        kind: QuestionKind::Choice {
            choices: vec!["yes".into(), "no".into()],
        },
        ..question(&session, ReplyVia::Core)
    };
    let id = agents.id;
    w.ok(ask(agents));
    assert_eq!(w.question(id).places, None);
}

/// Every way a thought comes by its place, and every reason it waits for
/// later (design §5, `placed`): the closed set, each from the event that
/// decides it.
#[test]
fn row_placed_says_how_a_thought_came_by_its_place_or_why_it_waits() {
    let mut w = World::new("placed");
    let site = project("/work/site");
    w.write(|tx| tx.insert_project(&site).unwrap());
    let (_, s) = w.running();
    w.say(s, Said::Ready).unwrap();
    let (_, other) = w.running();
    let app = Destination::New(w.project);
    let placed = |w: &mut World, t| (w.thought(t).placed, w.thought(t).mode);
    let clear = |to| Route::Clear {
        to,
        brief: "Do it.".into(),
    };
    let ambiguous = || Route::Ambiguous {
        prompt: "Where should this go?".into(),
        candidates: vec![
            Candidate {
                label: "app".into(),
                to: app,
            },
            Candidate {
                label: "site".into(),
                to: Destination::New(site.id),
            },
        ],
        brief: None,
    };
    let answered = |w: &mut World, route, how, current| {
        let t = w.capture("do it");
        // Nothing is recorded while the router is still asked.
        assert_eq!(w.thought(t).placed, None);
        let effects = w.ok(Event::Routed {
            thought: t,
            route,
            how,
            current,
        });
        (t, effects)
    };

    // The person picked: at capture, later, and by typing in a session's terminal.
    let t = ThoughtId::mint();
    let picked = Capture {
        project_id: Some(w.project),
        ..capture(t, "fix the build")
    };
    w.ok(captured(picked));
    assert_eq!(placed(&mut w, t), (Some(Placed::Picked), Mode::Ask));
    let t = w.routed("and the docs");
    assert_eq!(placed(&mut w, t), (Some(Placed::Picked), Mode::Ask));
    let prompt = Some("by hand".to_string());
    w.say(s, Said::TurnStarted { prompt }).unwrap();
    let typed = w.session(s).thought_id.unwrap();
    assert_eq!(w.thought(typed).placed, Some(Placed::Picked));
    w.say(s, Said::TurnFinished { answer: None }).unwrap();

    // The router found one place: the match on names, or a model.
    let (t, _) = answered(&mut w, clear(app), locally(None), None);
    assert_eq!(placed(&mut w, t), (Some(Placed::Name), Mode::Ask));
    let (t, _) = answered(&mut w, clear(app), by_model(), None);
    assert_eq!(placed(&mut w, t), (Some(Placed::Model), Mode::Ask));
    // A model that failed left it to the match on names.
    let fell_back = locally(Some("claude: it ended without an answer".into()));
    let (t, _) = answered(&mut w, clear(app), fell_back, None);
    assert_eq!(placed(&mut w, t), (Some(Placed::Name), Mode::Ask));

    // It stays in the session it was captured in: a follow-up there,
    // whoever answered; to any other session it was placed as above.
    let here = Destination::Session(s);
    for how in [locally(None), by_model()] {
        let (t, _) = answered(&mut w, clear(here), how, Some(s));
        assert_eq!(placed(&mut w, t), (Some(Placed::FollowUp), Mode::Nudge));
    }
    let (t, _) = answered(&mut w, clear(here), locally(None), None);
    assert_eq!(placed(&mut w, t), (Some(Placed::Name), Mode::Nudge));
    let (t, _) = answered(&mut w, clear(here), by_model(), Some(other));
    assert_eq!(placed(&mut w, t), (Some(Placed::Model), Mode::Nudge));

    // The router asked, and the person chose or declined. Until then
    // nothing is recorded.
    let question = |effects: Vec<Effect>| match effects.as_slice() {
        &[Effect::Notify(q)] => q,
        other => panic!("{other:?}"),
    };
    let (t, effects) = answered(&mut w, ambiguous(), by_model(), None);
    assert_eq!(placed(&mut w, t), (None, Mode::Ask));
    let choice = Response::Choice { choice: 1 };
    w.answer(question(effects), choice).unwrap();
    assert_eq!(placed(&mut w, t), (Some(Placed::Answer), Mode::Ask));
    assert_eq!(w.thought(t).project_id, Some(site.id));
    let (t, effects) = answered(&mut w, ambiguous(), locally(None), None);
    w.answer(question(effects), Response::Deny).unwrap();
    assert_eq!(placed(&mut w, t), (Some(Placed::KeptAnswer), Mode::Note));
    // Picked while the question was open: the person's pick.
    let (t, _) = answered(&mut w, ambiguous(), locally(None), None);
    w.ok(Event::Pick {
        thought: t,
        to: app,
    });
    assert_eq!(placed(&mut w, t), (Some(Placed::Picked), Mode::Ask));

    // For later: saved so by the person, or no place was found, by the
    // match on names or by a model.
    let t = ThoughtId::mint();
    let note = Capture {
        mode: Some(Mode::Note),
        ..capture(t, "an idea")
    };
    assert_eq!(w.ok(captured(note)), NONE);
    assert_eq!(placed(&mut w, t), (Some(Placed::Kept), Mode::Note));
    let (t, _) = answered(&mut w, Route::Unknown, locally(None), None);
    assert_eq!(placed(&mut w, t), (Some(Placed::KeptName), Mode::Note));
    let (t, _) = answered(&mut w, Route::Unknown, by_model(), Some(s));
    assert_eq!(placed(&mut w, t), (Some(Placed::KeptModel), Mode::Note));
    // A place that went while the router answered is no place.
    let nowhere = Destination::New(ProjectId::mint());
    let (t, _) = answered(&mut w, clear(nowhere), by_model(), None);
    assert_eq!(placed(&mut w, t), (Some(Placed::KeptModel), Mode::Note));
    let (t, _) = answered(&mut w, clear(nowhere), locally(None), None);
    assert_eq!(placed(&mut w, t), (Some(Placed::KeptName), Mode::Note));

    // The last decision counts: an idea the person then sends somewhere
    // is their pick, and Undo leaves the place and how it came about.
    w.ok(Event::Pick {
        thought: t,
        to: app,
    });
    assert_eq!(placed(&mut w, t), (Some(Placed::Picked), Mode::Ask));
    let (t, _) = answered(&mut w, clear(app), by_model(), None);
    w.ok(Event::Stop { thought: t });
    let th = w.thought(t);
    assert_eq!(
        (th.phase, th.placed, th.project_id),
        (Phase::Captured, Some(Placed::Model), Some(w.project))
    );
}

#[test]
fn row_a_new_run_is_named_by_the_title_a_model_gave_the_work() {
    let mut w = World::new("title");
    let titled = Routing {
        title: Some("Green build".into()),
        ..by_model()
    };
    let start = |w: &mut World, id| {
        let effects = w.ok(Event::Start {
            thought: id,
            attempt: AttemptId::mint(),
        });
        assert!(w.carry(&effects).is_empty());
        w.thought(id).session_id.unwrap()
    };
    // A new run: its session has the title for a name.
    let id = w.capture(SPOKEN);
    let route = w.clear(BRIEF);
    w.ok(Event::Routed {
        thought: id,
        route,
        how: titled.clone(),
        current: None,
    });
    let s = start(&mut w, id);
    let session = w.session(s);
    assert_eq!(
        (session.name.as_deref(), session.named_at),
        (Some("Green build"), Some(w.now()))
    );
    // A follow-up leaves its session's name as it is.
    w.say(s, Said::Ready).unwrap();
    let f = w.capture("uh, and now, well, run the tests too");
    let route = Route::Clear {
        to: Destination::Session(s),
        brief: "Run the tests too.".into(),
    };
    let follow = Routing {
        title: Some("Run the tests".into()),
        ..by_model()
    };
    w.ok(Event::Routed {
        thought: f,
        route,
        how: follow,
        current: None,
    });
    assert_eq!(start(&mut w, f), s);
    assert_eq!(w.session(s).name.as_deref(), Some("Green build"));
    // A run nobody gave a title has no name.
    let plain = w.routed("fix the build");
    let s = start(&mut w, plain);
    assert_eq!(w.session(s).name, None);
}

#[test]
fn row_stop_while_the_router_is_asked_stops_it_and_its_answer_no_longer_counts() {
    let mut w = World::new("unask");
    w.consents();
    let id = w.asked(SPOKEN);
    assert_eq!(w.ok(Event::Stop { thought: id }), [Effect::Unroute(id)]);
    let t = w.thought(id);
    let route = t.route.clone().unwrap();
    assert_eq!(
        (t.phase, route.pending, route.fallback.as_deref()),
        (Phase::Captured, false, Some("it was undone"))
    );
    let route = w.clear(BRIEF);
    assert!(matches!(
        w.answers(id, route),
        Err(Error::Ignored(Ignored::State))
    ));
    assert_eq!(w.thought(id).phase, Phase::Captured);
    // It is plain data again: the person may edit or delete it.
    assert!(w.read(|tx| state::plain(tx, &t).unwrap()));
}

#[test]
fn rows_a_picked_thought_is_briefed_by_the_model_and_launches_once_both_are_in() {
    let mut w = World::new("picked");
    let to = Destination::New(w.project);
    let pick = |w: &World, id, text: &str| {
        captured(Capture {
            project_id: Some(w.project),
            ..capture(id, text)
        })
    };
    // Without consent nobody is asked, however long the thought.
    let plain = ThoughtId::mint();
    let effects = w.ok(pick(&w, plain, SPOKEN));
    assert!(
        matches!(effects.as_slice(), [Effect::Hold { .. }]),
        "{effects:?}"
    );
    w.consents();
    // Short enough to go on as it is: nobody is asked either.
    let short = ThoughtId::mint();
    let effects = w.ok(pick(&w, short, "fix the build"));
    assert!(
        matches!(effects.as_slice(), [Effect::Hold { .. }]),
        "{effects:?}"
    );
    assert_eq!(w.thought(short).route, None);
    // A spoken one: routed at once to where the person said, and the model
    // asked for the brief alone.
    let id = ThoughtId::mint();
    let until = time(w.now + 5000);
    assert_eq!(
        w.ok(pick(&w, id, SPOKEN)),
        [
            Effect::Route {
                thought: id,
                current: None,
                by: Some(consent()),
                picked: Some(to),
            },
            Effect::Hold { thought: id, until }
        ]
    );
    let t = w.thought(id);
    assert_eq!(
        (t.phase, t.project_id, t.brief),
        (Phase::Routed, Some(w.project), None)
    );
    assert!(t.route.unwrap().pending);
    // The hold ends first: nothing launches without the brief.
    w.tick(5000);
    let ended = Event::HoldEnded {
        thought: id,
        attempt: AttemptId::mint(),
    };
    assert_eq!(w.ignored(ended), Ignored::State);
    // The brief arrives. The destination stays the person's, whatever the
    // model named, and the hold, long over, goes on for the 2 s the brief
    // is there to read.
    w.tick(1000);
    let elsewhere = Route::Clear {
        to: Destination::New(ProjectId::mint()),
        brief: BRIEF.into(),
    };
    let until = time(w.now + 1000 * u64::from(READ_HOLD));
    assert_eq!(
        w.answers(id, elsewhere).unwrap(),
        [Effect::Hold { thought: id, until }]
    );
    let t = w.thought(id);
    assert_eq!(
        (t.phase, t.project_id, t.brief.as_deref(), t.hold_until),
        (Phase::Routed, Some(w.project), Some(BRIEF), Some(until))
    );
    assert_eq!(t.route, Some(by_model()));
    let early = Event::HoldEnded {
        thought: id,
        attempt: AttemptId::mint(),
    };
    assert_eq!(w.ignored(early), Ignored::State);
    w.tick(2000);
    let attempt = AttemptId::mint();
    let effects = w.ok(Event::HoldEnded {
        thought: id,
        attempt,
    });
    let [Effect::Launch(l)] = effects.as_slice() else {
        panic!("{effects:?}")
    };
    // The agent gets the brief, and the person's own words with it.
    assert_eq!(
        (l.prompt.as_str(), l.words.as_deref()),
        (BRIEF, Some(SPOKEN))
    );
    // The same attempt again starts nothing more.
    let again = w.ok(Event::HoldEnded {
        thought: id,
        attempt,
    });
    assert!(matches!(again.as_slice(), [Effect::Repeat(_)]), "{again:?}");
    // A brief that arrives with more of the hold left than it takes to
    // read leaves the hold as it is.
    let id = ThoughtId::mint();
    let until = time(w.now + 5000);
    w.ok(pick(&w, id, SPOKEN));
    w.tick(2500);
    let route = w.clear(BRIEF);
    assert_eq!(
        w.answers(id, route).unwrap(),
        [Effect::Hold { thought: id, until }]
    );
    assert_eq!(w.thought(id).hold_until, Some(until));
}

#[test]
fn row_start_by_hand_does_not_wait_for_the_brief() {
    let mut w = World::new("impatient");
    w.consents();
    let id = ThoughtId::mint();
    w.ok(captured(Capture {
        project_id: Some(w.project),
        ..capture(id, SPOKEN)
    }));
    let effects = w.ok(Event::Start {
        thought: id,
        attempt: AttemptId::mint(),
    });
    assert!(
        matches!(effects.as_slice(), [Effect::Unroute(stopped), Effect::Unhold(_), Effect::Launch(l)]
            if *stopped == id && l.prompt == SPOKEN && l.words.is_none()),
        "{effects:?}"
    );
    let route = w.thought(id).route.unwrap();
    assert_eq!(
        (route.pending, route.fallback.as_deref()),
        (false, Some("it was started before its brief arrived"))
    );
    // The brief that arrives late changes nothing.
    let route = w.clear(BRIEF);
    assert!(matches!(
        w.answers(id, route),
        Err(Error::Ignored(Ignored::State))
    ));
}

#[test]
fn row_route_ambiguous_keeps_the_models_brief_for_where_the_person_sends_it() {
    let mut w = World::new("ambiguous-brief");
    w.consents();
    let id = w.asked(SPOKEN);
    let to = Destination::New(w.project);
    let choice = |label: &str| Candidate {
        label: label.into(),
        to,
    };
    let route = Route::Ambiguous {
        prompt: "Where should this go?".into(),
        candidates: vec![choice("app"), choice("the other app")],
        brief: Some(BRIEF.into()),
    };
    let effects = w.answers(id, route).unwrap();
    let &[Effect::Notify(q)] = effects.as_slice() else {
        panic!("{effects:?}")
    };
    // The brief is there to read while the question is open.
    let t = w.thought(id);
    assert_eq!(
        (t.phase, t.status, t.brief.as_deref()),
        (Phase::Captured, Status::NeedsYou, Some(BRIEF))
    );
    assert_eq!(t.route, Some(by_model()));
    // The answer routes it, and nobody is asked for a brief again.
    let effects = w.answer(q, Response::Choice { choice: 1 }).unwrap();
    assert!(effects.iter().any(|e| matches!(e, Effect::Hold { .. })));
    assert!(!effects.iter().any(|e| matches!(e, Effect::Route { .. })));
    let t = w.thought(id);
    assert_eq!((t.phase, t.brief.as_deref()), (Phase::Routed, Some(BRIEF)));
    assert_eq!(t.route, Some(by_model()));
}

#[test]
fn row_a_destination_that_went_while_the_router_was_asked_leaves_an_idea() {
    let mut w = World::new("gone");
    w.consents();
    let id = w.asked(SPOKEN);
    let gone = Route::Clear {
        to: Destination::New(ProjectId::mint()),
        brief: BRIEF.into(),
    };
    assert_eq!(w.answers(id, gone).unwrap(), NONE);
    let t = w.thought(id);
    assert_eq!((t.phase, t.mode), (Phase::Captured, Mode::Note));
    let route = t.route.unwrap();
    assert_eq!(
        (route.pending, route.fallback.as_deref()),
        (false, Some("the folder or session it found is gone"))
    );
}

#[test]
fn the_persons_words_go_with_a_brief_unless_it_says_the_same() {
    let mut w = World::new("words");
    let launched = |w: &mut World, text: &str, brief: &str| {
        let id = w.capture(text);
        let route = w.clear(brief);
        w.answers(id, route).unwrap();
        let effects = w.ok(Event::Start {
            thought: id,
            attempt: AttemptId::mint(),
        });
        let launch = effects.into_iter().find_map(|e| match e {
            Effect::Launch(l) => Some((l.prompt, l.words)),
            _ => None,
        });
        launch.expect("it launches")
    };
    // A brief in other words: both go, the brief first.
    assert_eq!(
        launched(&mut w, "um, fix the build", "Fix the build."),
        ("Fix the build.".into(), Some("um, fix the build".into()))
    );
    // The same words, whatever the case and the punctuation: the person's
    // own, once.
    assert_eq!(
        launched(&mut w, "fix the build", "Fix the build."),
        ("fix the build".into(), None)
    );
    // A follow-up is typed the same way.
    let (_, s) = w.turn();
    let finished = Said::TurnFinished {
        answer: Some("Built.".into()),
    };
    w.say(s, finished).unwrap();
    let f = w.capture("uh, and now, well, run the tests too");
    let route = Route::Clear {
        to: Destination::Session(s),
        brief: "Run the tests too.".into(),
    };
    w.answers(f, route).unwrap();
    let effects = w.ok(Event::Start {
        thought: f,
        attempt: AttemptId::mint(),
    });
    let deliver = effects.into_iter().find_map(|e| match e {
        Effect::Deliver(d) => Some((d.text, d.words)),
        _ => None,
    });
    assert_eq!(
        deliver,
        Some((
            "Run the tests too.".into(),
            Some("uh, and now, well, run the tests too".into())
        ))
    );
}

#[test]
fn a_restart_between_the_routers_answer_and_the_launch_runs_nothing_again() {
    let mut w = World::new("route-crash");
    w.consents();
    let id = w.asked(SPOKEN);
    let route = w.clear(BRIEF);
    w.answers(id, route.clone()).unwrap();
    w.tick(6000);
    w.reopen();
    // Routed, with its brief, and no hold: it waits for the person.
    let t = w.thought(id);
    assert_eq!(
        (t.phase, t.hold_until, t.brief.as_deref()),
        (Phase::Routed, None, Some(BRIEF))
    );
    // The timer went with the core; one that still fired finds no hold,
    // and the router's answer is not taken a second time.
    let ended = Event::HoldEnded {
        thought: id,
        attempt: AttemptId::mint(),
    };
    assert_eq!(w.ignored(ended), Ignored::State);
    assert!(matches!(
        w.answers(id, route.clone()),
        Err(Error::Ignored(Ignored::State))
    ));
    // The person starts it, once.
    let attempt = AttemptId::mint();
    let start = Event::Start {
        thought: id,
        attempt,
    };
    let effects = w.ok(start.clone());
    assert!(
        matches!(effects.as_slice(), [Effect::Launch(_)]),
        "{effects:?}"
    );
    let again = w.ok(start);
    assert!(matches!(again.as_slice(), [Effect::Repeat(_)]), "{again:?}");

    // A restart while the router was asked: nobody is asked again, and the
    // answer that was under way does not count.
    let asked = w.asked(SPOKEN);
    w.reopen();
    let t = w.thought(asked);
    let how = t.route.unwrap();
    assert_eq!(
        (t.phase, how.pending, how.fallback.as_deref()),
        (
            Phase::Captured,
            false,
            Some("Tasktap stopped while it was asked")
        )
    );
    assert!(matches!(
        w.answers(asked, route),
        Err(Error::Ignored(Ignored::State))
    ));
}

// Dictations (design §8, "Speech"): the rows of its table, on the pure
// function. What moves audio, time and the speech service around them is
// proven through the binary in `tests/speech.rs`.

mod dictations {
    use tasktap_core::state::{
        DICTATIONS, Dictating, Error, Heard, INTERRUPTED, Ignored, NOTHING_HEARD, RECORDING,
        Spoken, dictate,
    };
    use tasktap_proto::{
        Capture, DictationId, DictationPhase as P, DictationTarget, Source, ThoughtId,
    };

    fn thought() -> DictationTarget {
        DictationTarget::Thought(Box::new(Capture {
            id: ThoughtId::mint(),
            text: String::new(),
            strokes: Vec::new(),
            source: Source::Voice,
            mode: None,
            project_id: None,
            session_id: None,
            agent: None,
            model: None,
            current: None,
        }))
    }

    /// A dictation that is recording, transcribed by the core (`stream`)
    /// or by its recorder.
    fn recording(all: &mut Vec<Dictating>, stream: bool) -> DictationId {
        let (id, target) = (DictationId::mint(), thought());
        let told = dictate(all, Spoken::Start { id, target, stream }).unwrap();
        let seconds = RECORDING + 10;
        let tail = [Heard::Put(id), Heard::Deadline { id, seconds }];
        assert!(told.ends_with(&tail), "{told:?}");
        id
    }

    fn transcribing(all: &mut Vec<Dictating>, stream: bool) -> DictationId {
        let id = recording(all, stream);
        dictate(all, Spoken::Finish { id, heard: true }).unwrap();
        id
    }

    /// A dictation whose words are there for a field, and nothing more.
    fn heard(all: &mut Vec<Dictating>) -> DictationId {
        let (id, target) = (DictationId::mint(), DictationTarget::Text);
        let stream = true;
        dictate(all, Spoken::Start { id, target, stream }).unwrap();
        dictate(all, Spoken::Finish { id, heard: true }).unwrap();
        let transcript = Ok("Ja, mach das.".to_owned());
        let told = dictate(all, Spoken::Transcribed { id, transcript }).unwrap();
        assert_eq!(told, [Heard::Put(id), Heard::End(id)]);
        id
    }

    fn failed(all: &mut Vec<Dictating>) -> DictationId {
        let id = recording(all, true);
        dictate(all, Spoken::Deadline { id }).unwrap();
        id
    }

    fn row(all: &[Dictating], id: DictationId) -> &tasktap_proto::Dictation {
        &all.iter().find(|d| d.row.id == id).expect("its row").row
    }

    fn gone(all: &[Dictating], id: DictationId) -> bool {
        all.iter().all(|d| d.row.id != id)
    }

    /// The effects of a failure, and the row it leaves.
    fn fails(all: &[Dictating], id: DictationId, told: Vec<Heard>, why: &str) {
        assert_eq!(told, [Heard::Put(id), Heard::End(id)]);
        let row = row(all, id);
        assert_eq!((row.phase, row.level), (P::Failed, 0));
        assert_eq!(row.error.as_deref(), Some(why));
    }

    #[test]
    fn a_start_records_with_a_deadline_and_one_records_at_a_time() {
        let mut all = Vec::new();
        let id = recording(&mut all, true);
        let r = row(&all, id);
        assert_eq!((r.phase, r.level, r.text.as_str()), (P::Recording, 0, ""));
        assert_eq!(r.error, None);
        // A second start while one records, and the same id again.
        for (id, why) in [
            (DictationId::mint(), "another dictation is recording"),
            (id, "a dictation with this id exists"),
        ] {
            let (target, stream) = (thought(), false);
            let refused = dictate(&mut all, Spoken::Start { id, target, stream });
            assert!(matches!(refused, Err(Error::Conflict(w)) if w == why));
        }
        assert_eq!(all.len(), 1);
    }

    #[test]
    fn the_next_starts_while_the_last_is_transcribed_up_to_four() {
        let mut all = Vec::new();
        for _ in 0..DICTATIONS {
            transcribing(&mut all, true);
        }
        let (id, target) = (DictationId::mint(), thought());
        let refused = dictate(
            &mut all,
            Spoken::Start {
                id,
                target,
                stream: true,
            },
        );
        assert!(matches!(refused, Err(Error::Conflict(w)) if w.contains("four")));
        // One of them done makes room.
        let first = all[0].row.id;
        dictate(&mut all, Spoken::Cancel { id: first }).unwrap();
        recording(&mut all, true);
        assert_eq!(all.len(), DICTATIONS);
    }

    #[test]
    fn a_start_clears_what_failed_before() {
        let mut all = Vec::new();
        let old = failed(&mut all);
        let (id, target) = (DictationId::mint(), thought());
        let told = dictate(
            &mut all,
            Spoken::Start {
                id,
                target,
                stream: false,
            },
        )
        .unwrap();
        assert_eq!(told[..2], [Heard::Del(old), Heard::End(old)]);
        assert!(gone(&all, old) && row(&all, id).phase == P::Recording);
    }

    #[test]
    fn the_level_follows_the_stream_and_only_while_recording() {
        let mut all = Vec::new();
        let id = recording(&mut all, true);
        let level = |all: &mut Vec<Dictating>, level| dictate(all, Spoken::Level { id, level });
        assert_eq!(level(&mut all, 40).unwrap(), [Heard::Put(id)]);
        assert_eq!(row(&all, id).level, 40);
        // The same level again changes nothing, so nothing is sent.
        assert_eq!(level(&mut all, 40).unwrap(), []);
        assert_eq!(level(&mut all, 250).unwrap(), [Heard::Put(id)]);
        assert_eq!(row(&all, id).level, 100);
        dictate(&mut all, Spoken::Finish { id, heard: true }).unwrap();
        assert_eq!(row(&all, id).level, 0);
        assert_eq!(level(&mut all, 40).unwrap(), []);
        assert_eq!(row(&all, id).level, 0);
        // The core transcribes this one: nobody reports for it.
        let report = Spoken::Report {
            id,
            text: Some("x".into()),
            level: None,
        };
        assert!(matches!(dictate(&mut all, report), Err(Error::Conflict(_))));
    }

    #[test]
    fn a_recorder_that_transcribes_reports_the_words_so_far_and_then_all_of_them() {
        let mut all = Vec::new();
        let id = recording(&mut all, false);
        let report = |all: &mut Vec<Dictating>, text: Option<&str>, level| {
            let text = text.map(String::from);
            dictate(all, Spoken::Report { id, text, level })
        };
        assert_eq!(
            report(&mut all, Some("Bitte den"), Some(30)).unwrap(),
            [Heard::Put(id)]
        );
        assert_eq!(report(&mut all, None, Some(55)).unwrap(), [Heard::Put(id)]);
        let r = row(&all, id);
        assert_eq!((r.text.as_str(), r.level), ("Bitte den", 55));
        assert_eq!(report(&mut all, Some("Bitte den"), Some(55)).unwrap(), []);
        // Its level is none of the stream's.
        assert_eq!(
            dictate(&mut all, Spoken::Level { id, level: 9 }).unwrap(),
            []
        );
        let told = dictate(&mut all, Spoken::Finish { id, heard: true }).unwrap();
        assert_eq!(told, [Heard::Put(id), Heard::Deadline { id, seconds: 120 }]);
        assert_eq!(row(&all, id).phase, P::Transcribing);
        // Once finished a report is the transcript, and it must carry one.
        assert!(matches!(
            report(&mut all, None, Some(1)),
            Err(Error::Invalid(_))
        ));
        let told = report(&mut all, Some(" Bitte den Bug fixen. "), None).unwrap();
        let [Heard::Deliver { id: to, text, .. }] = &told[..] else {
            panic!("{told:?}");
        };
        assert_eq!((*to, text.as_str()), (id, "Bitte den Bug fixen."));
        assert!(matches!(
            report(&mut all, Some("x"), None).map(|_| ()).and(dictate(
                &mut all,
                Spoken::Report {
                    id: DictationId::mint(),
                    text: None,
                    level: None
                }
            )),
            Err(Error::Gone)
        ));
    }

    #[test]
    fn a_finish_starts_the_transcription_unless_nothing_was_heard() {
        let mut all = Vec::new();
        let id = recording(&mut all, true);
        let told = dictate(&mut all, Spoken::Finish { id, heard: true }).unwrap();
        assert_eq!(
            told,
            [Heard::Put(id), Heard::End(id), Heard::Transcribe(id)]
        );
        assert_eq!(row(&all, id).phase, P::Transcribing);
        // A repeat changes nothing and transcribes nothing again.
        assert_eq!(
            dictate(&mut all, Spoken::Finish { id, heard: true }).unwrap(),
            []
        );
        // No audio, or silence: nothing is sent anywhere.
        let quiet = recording(&mut all, true);
        let told = dictate(
            &mut all,
            Spoken::Finish {
                id: quiet,
                heard: false,
            },
        )
        .unwrap();
        fails(&all, quiet, told, NOTHING_HEARD);
        // What failed is not finished, and what is not there is gone.
        let again = dictate(
            &mut all,
            Spoken::Finish {
                id: quiet,
                heard: true,
            },
        );
        assert!(matches!(again, Err(Error::Ignored(Ignored::State))));
        let unknown = Spoken::Finish {
            id: DictationId::mint(),
            heard: true,
        };
        assert!(matches!(dictate(&mut all, unknown), Err(Error::Gone)));
    }

    #[test]
    fn a_spoken_thought_is_captured_and_its_row_goes() {
        let mut all = Vec::new();
        let target = thought();
        let DictationTarget::Thought(capture) = target.clone() else {
            panic!("a thought");
        };
        let id = DictationId::mint();
        let stream = true;
        dictate(&mut all, Spoken::Start { id, target, stream }).unwrap();
        dictate(&mut all, Spoken::Finish { id, heard: true }).unwrap();
        let transcript = Ok("  Mach das Fenster zu.\n".to_owned());
        let told = dictate(&mut all, Spoken::Transcribed { id, transcript }).unwrap();
        let text = "Mach das Fenster zu.".to_owned();
        assert_eq!(told, [Heard::Deliver { id, capture, text }]);
        // Still transcribing until its capture is known.
        assert_eq!(row(&all, id).phase, P::Transcribing);
        let told = dictate(&mut all, Spoken::Delivered { id, refused: None }).unwrap();
        assert_eq!(told, [Heard::Del(id), Heard::End(id)]);
        assert!(gone(&all, id));
    }

    /// `dictation.finish {as: "text"}`: the person let go and wants the
    /// words to edit, so a dictation started for a thought ends as the
    /// text target does, from any point before its thought is captured.
    #[test]
    fn a_spoken_thought_finished_as_text_is_only_heard_and_nothing_is_delivered() {
        let mut all = Vec::new();
        // At the finish, transcribed by the core and by the recorder.
        for stream in [true, false] {
            let id = recording(&mut all, stream);
            let told = dictate(&mut all, Spoken::Words { id }).unwrap();
            assert_eq!(told, [Heard::Put(id)]);
            assert_eq!(row(&all, id).target, DictationTarget::Text);
            // Said twice it is said once.
            assert_eq!(dictate(&mut all, Spoken::Words { id }).unwrap(), []);
            dictate(&mut all, Spoken::Finish { id, heard: true }).unwrap();
            let transcript = Ok(" Hallo ".to_owned());
            let told = dictate(&mut all, Spoken::Transcribed { id, transcript }).unwrap();
            assert_eq!(told, [Heard::Put(id), Heard::End(id)]);
            let r = row(&all, id);
            assert_eq!((r.phase, r.text.as_str()), (P::Heard, "Hallo"));
            dictate(&mut all, Spoken::Cancel { id }).unwrap();
        }
        // Decided after letting go, while the words are on their way.
        let id = transcribing(&mut all, true);
        assert_eq!(
            dictate(&mut all, Spoken::Words { id }).unwrap(),
            [Heard::Put(id)]
        );
        let transcript = Ok("Hallo".to_owned());
        let told = dictate(&mut all, Spoken::Transcribed { id, transcript }).unwrap();
        assert_eq!(told, [Heard::Put(id), Heard::End(id)]);
        assert_eq!(row(&all, id).phase, P::Heard);
        // Once it has ended there is nothing to turn, and none that is unknown.
        // (The next start clears a row that ended, so each is asked in turn.)
        let told = dictate(&mut all, Spoken::Words { id });
        assert!(matches!(told, Err(Error::Ignored(Ignored::State))));
        let id = failed(&mut all);
        let told = dictate(&mut all, Spoken::Words { id });
        assert!(matches!(told, Err(Error::Ignored(Ignored::State))));
        let unknown = Spoken::Words {
            id: DictationId::mint(),
        };
        assert!(matches!(dictate(&mut all, unknown), Err(Error::Gone)));
    }

    #[test]
    fn words_for_a_field_are_only_heard_and_nothing_is_delivered() {
        let mut all = Vec::new();
        // From the speech service, and from a recorder that transcribes.
        let by_service = heard(&mut all);
        let r = row(&all, by_service);
        assert_eq!(
            (r.phase, r.text.as_str(), r.level),
            (P::Heard, "Ja, mach das.", 0)
        );
        assert_eq!(r.error, None);
        let (id, target) = (DictationId::mint(), DictationTarget::Text);
        // The start of the next clears the one that ended.
        let told = dictate(
            &mut all,
            Spoken::Start {
                id,
                target,
                stream: false,
            },
        )
        .unwrap();
        assert_eq!(told[..2], [Heard::Del(by_service), Heard::End(by_service)]);
        dictate(&mut all, Spoken::Finish { id, heard: true }).unwrap();
        let text = Some(" Nein, lass es. ".to_owned());
        let told = dictate(
            &mut all,
            Spoken::Report {
                id,
                text,
                level: None,
            },
        )
        .unwrap();
        assert_eq!(told, [Heard::Put(id), Heard::End(id)]);
        let r = row(&all, id);
        assert_eq!((r.phase, r.text.as_str()), (P::Heard, "Nein, lass es."));
        // It is over: nothing more is finished, reported or interrupted.
        for event in [
            Spoken::Finish { id, heard: true },
            Spoken::Report {
                id,
                text: Some("x".into()),
                level: None,
            },
        ] {
            let refused = dictate(&mut all, event);
            assert!(matches!(refused, Err(Error::Ignored(Ignored::State))));
        }
        for event in [Spoken::Left { id }, Spoken::Deadline { id }] {
            assert_eq!(dictate(&mut all, event).unwrap(), []);
        }
        assert_eq!(row(&all, id).text, "Nein, lass es.");
        // The interface took the words: the row is dismissed.
        let told = dictate(&mut all, Spoken::Cancel { id }).unwrap();
        assert_eq!(told, [Heard::Del(id), Heard::End(id)]);
        assert!(all.is_empty());
        // Words that are none are nothing heard, for a field too.
        let (id, target) = (DictationId::mint(), DictationTarget::Text);
        dictate(
            &mut all,
            Spoken::Start {
                id,
                target,
                stream: true,
            },
        )
        .unwrap();
        dictate(&mut all, Spoken::Finish { id, heard: true }).unwrap();
        let transcript = Ok(" ".to_owned());
        let told = dictate(&mut all, Spoken::Transcribed { id, transcript }).unwrap();
        fails(&all, id, told, NOTHING_HEARD);
    }

    #[test]
    fn what_cannot_be_transcribed_or_delivered_fails_and_keeps_the_words() {
        let mut all = Vec::new();
        // The speech service failed.
        let id = transcribing(&mut all, true);
        let transcript = Err("The speech service refused the key".to_owned());
        let told = dictate(&mut all, Spoken::Transcribed { id, transcript }).unwrap();
        fails(&all, id, told, "The speech service refused the key");
        // It heard nothing in what it was sent.
        let id = transcribing(&mut all, true);
        let transcript = Ok(" \n".to_owned());
        let told = dictate(&mut all, Spoken::Transcribed { id, transcript }).unwrap();
        fails(&all, id, told, NOTHING_HEARD);
        // The target refused it: the words stay with why.
        let id = transcribing(&mut all, true);
        let transcript = Ok("Ja, mach das.".to_owned());
        dictate(&mut all, Spoken::Transcribed { id, transcript }).unwrap();
        let refused = Some("the question was answered already".to_owned());
        let told = dictate(&mut all, Spoken::Delivered { id, refused }).unwrap();
        fails(&all, id, told, "the question was answered already");
        assert_eq!(row(&all, id).text, "Ja, mach das.");
        // An answer for what was cancelled meanwhile, or failed, is dropped.
        for id in [id, DictationId::mint()] {
            let transcript = Ok("late".to_owned());
            assert_eq!(
                dictate(&mut all, Spoken::Transcribed { id, transcript }).unwrap(),
                []
            );
        }
        assert_eq!(row(&all, id).text, "Ja, mach das.");
    }

    #[test]
    fn cancel_removes_a_dictation_at_every_point() {
        let mut all = Vec::new();
        let made: [fn(&mut Vec<Dictating>) -> DictationId; 5] = [
            |all| recording(all, true),
            |all| recording(all, false),
            |all| transcribing(all, true),
            |all| transcribing(all, false),
            failed,
        ];
        for make in made {
            let id = make(&mut all);
            let told = dictate(&mut all, Spoken::Cancel { id }).unwrap();
            assert_eq!(told, [Heard::Del(id), Heard::End(id)]);
            assert!(all.is_empty());
            // Again, or for one that never was: nothing, as for a repeat.
            assert_eq!(dictate(&mut all, Spoken::Cancel { id }).unwrap(), []);
        }
        // Between its transcript and its delivery too: the delivery's
        // outcome then finds no row.
        let id = transcribing(&mut all, true);
        dictate(&mut all, Spoken::Cancel { id }).unwrap();
        assert_eq!(
            dictate(&mut all, Spoken::Delivered { id, refused: None }).unwrap(),
            []
        );
    }

    #[test]
    fn a_recorder_that_leaves_interrupts_what_only_it_could_finish() {
        let mut all = Vec::new();
        for stream in [true, false] {
            let id = recording(&mut all, stream);
            let told = dictate(&mut all, Spoken::Left { id }).unwrap();
            fails(&all, id, told, INTERRUPTED);
            dictate(&mut all, Spoken::Cancel { id }).unwrap();
        }
        let id = transcribing(&mut all, false);
        let told = dictate(&mut all, Spoken::Left { id }).unwrap();
        fails(&all, id, told, INTERRUPTED);
        // What the core transcribes it has whole: it goes on.
        let id = transcribing(&mut all, true);
        assert_eq!(dictate(&mut all, Spoken::Left { id }).unwrap(), []);
        assert_eq!(row(&all, id).phase, P::Transcribing);
        // One that failed already stays as it failed.
        let id = failed(&mut all);
        assert_eq!(dictate(&mut all, Spoken::Left { id }).unwrap(), []);
    }

    #[test]
    fn the_deadline_ends_a_recording_and_a_wait_for_the_recorder() {
        let mut all = Vec::new();
        let id = recording(&mut all, true);
        let told = dictate(&mut all, Spoken::Deadline { id }).unwrap();
        fails(&all, id, told, "The recording did not end within 5 minutes");
        dictate(&mut all, Spoken::Cancel { id }).unwrap();
        let id = transcribing(&mut all, false);
        let told = dictate(&mut all, Spoken::Deadline { id }).unwrap();
        fails(
            &all,
            id,
            told,
            "The transcript did not arrive within 2 minutes",
        );
        // The speech service's call has its own limit; an old deadline, or
        // one for a dictation that is gone, changes nothing.
        let id = transcribing(&mut all, true);
        for id in [id, DictationId::mint()] {
            assert_eq!(dictate(&mut all, Spoken::Deadline { id }).unwrap(), []);
        }
        assert_eq!(row(&all, id).phase, P::Transcribing);
    }

    /// Every event in every state: none panics, at most one dictation
    /// records, at most four are under way, only a failed one has an
    /// error, and a refusal changes nothing.
    #[test]
    fn every_event_in_every_state_keeps_the_rules() {
        let states: [fn(&mut Vec<Dictating>) -> DictationId; 7] = [
            |_| DictationId::mint(),
            |all| recording(all, true),
            |all| recording(all, false),
            |all| transcribing(all, true),
            |all| transcribing(all, false),
            heard,
            failed,
        ];
        let events = |id: DictationId| {
            let text = || Some("Hallo".to_owned());
            vec![
                Spoken::Start {
                    id,
                    target: thought(),
                    stream: true,
                },
                Spoken::Start {
                    id: DictationId::mint(),
                    target: thought(),
                    stream: false,
                },
                Spoken::Level { id, level: 60 },
                Spoken::Report {
                    id,
                    text: text(),
                    level: Some(7),
                },
                Spoken::Report {
                    id,
                    text: None,
                    level: None,
                },
                Spoken::Finish { id, heard: true },
                Spoken::Finish { id, heard: false },
                Spoken::Words { id },
                Spoken::Transcribed {
                    id,
                    transcript: Ok("Hallo".into()),
                },
                Spoken::Transcribed {
                    id,
                    transcript: Err("No network".into()),
                },
                Spoken::Delivered { id, refused: None },
                Spoken::Delivered {
                    id,
                    refused: Some("gone".into()),
                },
                Spoken::Cancel { id },
                Spoken::Left { id },
                Spoken::Deadline { id },
            ]
        };
        for (s, state) in states.iter().enumerate() {
            for e in 0..events(DictationId::mint()).len() {
                let mut all = Vec::new();
                // Beside two others that are being transcribed.
                transcribing(&mut all, true);
                transcribing(&mut all, false);
                let id = state(&mut all);
                let before = all.clone();
                let event = events(id).swap_remove(e);
                let told = dictate(&mut all, event.clone());
                let what = format!("state {s}, {event:?}: {told:?}");
                if told.is_err() {
                    assert_eq!(all, before, "{what}");
                }
                let recording = all.iter().filter(|d| d.row.phase == P::Recording).count();
                let ended = |d: &&Dictating| matches!(d.row.phase, P::Failed | P::Heard);
                let under_way = all.len() - all.iter().filter(ended).count();
                assert!(recording <= 1 && under_way <= DICTATIONS, "{what}");
                for d in &all {
                    let failed = d.row.phase == P::Failed;
                    assert_eq!(d.row.error.is_some(), failed, "{what}");
                    assert!(d.row.level == 0 || d.row.phase == P::Recording, "{what}");
                }
                // The others are never touched by an event of this one.
                assert_eq!(all[..2], before[..2], "{what}");
            }
        }
    }
}
