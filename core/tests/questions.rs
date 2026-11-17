//! Questions and the calls with effects (design §2, §5, §6), through the
//! real binary: devices and stand-in agents speak to it through `client.rs`
//! and watch its records. Holds end on the core's fixture clock, so no test
//! waits for one, except the one that proves the real timer.

mod common;

use common::*;
use serde_json::{Value, json};
use std::fmt::Debug;
use std::time::{Duration, Instant};
use tasktap_core::client::Client;
use tasktap_proto::call::{self, Call, Code, Error};
use tasktap_proto::{
    Action, AddProject, AnswerQuestion, Ask, Assign, AttemptId, CallId, Capture, Changes, Control,
    Event as Said, FixtureCandidate, FixtureClock, FixtureRoute, Frame, History, Input, Limit,
    Mode, Outcome, Phase, Place, PrefPatch, ProjectId, Put, PutTarget, QuestionId, QuestionKind,
    QuestionSource, QuestionState, Reason, Ref, ReplyVia, Response, Retire, Rev, Secret,
    SessionState, Settle, Source, Start, Status, TerminalState, Thought, ThoughtId, When, Workdir,
};

fn code<T: Debug>(result: Result<T, Error>) -> Code {
    match result {
        Ok(v) => panic!("expected a refusal, got {v:?}"),
        Err(e) => e.code,
    }
}

fn answer(s: &mut Scene, id: QuestionId, response: Response) -> Result<(), Error> {
    s.w.call::<call::QuestionAnswer>(&AnswerQuestion { id, response })
}

fn input(s: &mut Scene, question: QuestionId, action: Action) -> Result<(), Error> {
    s.w.call::<call::Input>(&Input { action, question })
}

fn set_hold(s: &mut Scene, seconds: u32) {
    let target = PutTarget::Prefs(PrefPatch::Hold(seconds));
    s.w.ok::<call::Put>(&Put {
        target,
        if_rev: None,
    });
}

fn start(s: &mut Scene, id: ThoughtId, attempt: AttemptId) -> Result<(), Error> {
    s.w.call::<call::ThoughtStart>(&Start { id, attempt })
}

/// The open question with this prompt.
fn asked(s: &Scene, prompt: &str) -> QuestionId {
    let mut found = s.w.model.questions.values().filter(|q| q.prompt == prompt);
    let q = found.next().expect("no question with that prompt");
    q.id
}

fn choice(request: &str, prompt: &str, choices: &[&str]) -> Ask {
    Ask {
        kind: QuestionKind::Choice {
            choices: choices.iter().map(|c| c.to_string()).collect(),
        },
        ..confirm(request, prompt)
    }
}

// Thoughts, routing and the hold.

#[test]
fn a_capture_is_routed_held_and_launched_when_the_hold_ends() {
    let mut s = Scene::new("qa");
    let t = s.capture("the login page is blank");
    let th = s.w.model.thought(t).clone();
    let until = Some(time(s.now + HOLD_MS));
    assert_eq!(
        (th.status, th.project_id, th.hold_until, th.mode),
        (Status::Routed, Some(s.project), until, Mode::Ask)
    );
    assert_eq!(th.brief.as_deref(), Some("Fix the failing build"));

    // One millisecond before the hold ends nothing has started.
    s.tick(HOLD_MS - 1);
    assert_eq!(s.w.model.status(t), Status::Routed);
    assert!(s.log().launched.is_empty());
    s.tick(1);
    let th = s.w.model.thought(t).clone();
    assert_eq!((th.status, th.hold_until), (Status::Working, None));
    let log = s.log();
    assert_eq!(log.launched.len(), 1);
    assert_eq!(
        (log.launched[0].thought, log.launched[0].prompt.as_str()),
        (t, "Fix the failing build")
    );
    let session = th.session_id.unwrap();
    assert_eq!(log.launched[0].session, session);
    s.w.sync();
    let sess = s.w.model.session(session).clone();
    assert_eq!(
        (sess.state, sess.thought_id, sess.project_id),
        (SessionState::Starting, Some(t), s.project)
    );
    let terminal = sess.terminal_id.expect("the launch names its terminal");
    assert_eq!(s.w.model.terminals[&terminal].state, TerminalState::Running);
    assert_eq!(
        s.w.statuses[&t],
        [Status::Captured, Status::Routed, Status::Working]
    );
    assert_eq!(s.w.model.glance().working, 1);

    // The terminal's token is the session's: what the agent says reaches it.
    let mut agent = s.agent(session);
    agent.ready();
    s.w.sync();
    assert_eq!(s.w.model.session(session).state, SessionState::Idle);
}

#[test]
fn undo_cancels_the_hold_and_start_launches_at_once_and_only_once() {
    let mut s = Scene::new("qu");
    let t = s.capture("rename the module");
    s.w.ok::<call::ThoughtStop>(&Ref { id: t });
    let th = s.w.model.thought(t);
    assert_eq!((th.status, th.hold_until), (Status::Captured, None));
    // The cancelled hold never fires.
    s.tick(2 * HOLD_MS);
    assert_eq!(s.w.model.status(t), Status::Captured);
    assert!(s.log().launched.is_empty());

    // The person picks the project again: held again.
    let pick = Assign {
        id: t,
        project_id: s.project,
    };
    s.w.ok::<call::ThoughtUpdate>(&pick);
    let th = s.w.model.thought(t);
    assert_eq!(
        (th.status, th.hold_until),
        (Status::Routed, Some(time(s.now + HOLD_MS)))
    );
    // Start during the hold launches now and the hold never fires.
    let attempt = AttemptId::mint();
    start(&mut s, t, attempt).unwrap();
    assert_eq!(s.w.model.status(t), Status::Working);
    s.tick(2 * HOLD_MS);
    // The same attempt again answers from its record and launches nothing.
    start(&mut s, t, attempt).unwrap();
    assert_eq!(s.log().launched.len(), 1);
    // The same attempt id for another thought is a conflict.
    let other = s.capture("another");
    assert_eq!(code(start(&mut s, other, attempt)), Code::Conflict);
}

#[test]
fn a_zero_hold_launches_before_the_capture_returns() {
    let mut s = Scene::wall("qz");
    set_hold(&mut s, 0);
    let t = s.capture("now please");
    assert_eq!(s.w.model.status(t), Status::Working);
    assert_eq!(s.log().launched.len(), 1);
}

#[test]
fn a_hold_ends_on_a_real_timer_on_the_wall_clock() {
    let mut s = Scene::wall("qw");
    set_hold(&mut s, 1);
    let began = Instant::now();
    let t = s.capture("in a second");
    assert_eq!(s.w.model.status(t), Status::Routed);
    s.w.until("the hold ends", |m| m.status(t) == Status::Working);
    assert!(began.elapsed().as_millis() >= 900, "{:?}", began.elapsed());
    assert_eq!(s.log().launched.len(), 1);
}

#[test]
fn a_held_thought_keeps_the_core_alive_after_its_clients_leave() {
    let data = Folder::new("qalive");
    let core = Core::start_with(&data.0, &["--idle-ms", "200"]);
    let mut s = Scene::on(core, data);
    let t = s.capture("fix the build");
    assert_eq!(s.w.model.status(t), Status::Routed);
    let Scene {
        mut core, w, now, ..
    } = s;
    drop(w);
    // Elapsed time is what is being tested here, not a way to wait for an event.
    std::thread::sleep(Duration::from_millis(600));
    assert!(core.running(), "the core left with a hold armed");

    // The hold ends and launches; then nothing keeps the core.
    let mut w = core.watch();
    let now = time(now + HOLD_MS);
    w.ok::<call::FixtureClock>(&FixtureClock { now });
    assert_eq!(w.model.status(t), Status::Working);
    drop(w);
    core.wait();
}

#[test]
fn a_hold_that_ends_with_nobody_connected_lets_the_core_go() {
    let data = Folder::new("qgone");
    let mut core = Core::start_with(&data.0, &["--idle-ms", "100"]);
    let mut w = core.watch();
    let folder = data.0.join("app");
    std::fs::create_dir_all(&folder).unwrap();
    let add = AddProject {
        id: ProjectId::mint(),
        folder: folder.to_str().unwrap().into(),
        name: None,
    };
    let route = clear(w.ok::<call::ProjectAdd>(&add));
    w.ok::<call::FixtureScript>(&tasktap_proto::FixtureScript {
        route,
        refuse: None,
        unrecordable: false,
    });
    let target = PutTarget::Prefs(PrefPatch::Hold(1));
    w.ok::<call::Put>(&Put {
        target,
        if_rev: None,
    });
    w.ok::<call::ThoughtCapture>(&typed(ThoughtId::mint(), "fix the build"));
    drop(w);
    // The process ending is what is being waited for; it has no event to wait on.
    let left = Instant::now();
    while core.running() {
        assert!(
            left.elapsed() < Duration::from_secs(20),
            "the core never left"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(left.elapsed() >= Duration::from_millis(900));
}

#[test]
fn an_ambiguous_route_asks_and_an_unknown_one_keeps_an_idea() {
    let mut s = Scene::new("qr");
    let site = s.project("site");
    let candidates = vec![
        FixtureCandidate {
            label: "app".into(),
            to: Place::Project(s.project),
        },
        FixtureCandidate {
            label: "site".into(),
            to: Place::Project(site),
        },
    ];
    let route = FixtureRoute::Ambiguous {
        prompt: "Which project?".into(),
        candidates,
    };
    s.script(route, None);
    let t = s.capture("update the docs");
    let q = s.shown();
    let row = s.w.model.question(q).clone();
    assert_eq!(
        (row.source, row.reply_via, row.thought_id),
        (QuestionSource::Router, ReplyVia::Core, Some(t))
    );
    let choices = vec!["app".to_string(), "site".to_string()];
    assert_eq!(row.kind, QuestionKind::Choice { choices });
    assert_eq!(s.w.model.status(t), Status::NeedsYou);
    assert_eq!(s.w.model.glance().needs_you, 1);
    assert_eq!(s.log().notified, [q]);
    // The answer routes it where the choice goes.
    answer(&mut s, q, Response::Choice { choice: 1 }).unwrap();
    let th = s.w.model.thought(t);
    assert_eq!((th.status, th.project_id), (Status::Routed, Some(site)));

    s.script(FixtureRoute::Unknown, None);
    let idea = s.capture("someday: dark mode");
    let th = s.w.model.thought(idea);
    assert_eq!((th.status, th.mode), (Status::Captured, Mode::Note));
    // Assigning the idea to a project starts it.
    let pick = Assign {
        id: idea,
        project_id: s.project,
    };
    s.w.ok::<call::ThoughtUpdate>(&pick);
    let th = s.w.model.thought(idea);
    assert_eq!((th.status, th.mode), (Status::Routed, Mode::Ask));
}

#[test]
fn a_capture_repeats_by_id_and_calls_that_do_not_fit_are_refused() {
    let mut s = Scene::new("qc");
    let id = ThoughtId::mint();
    s.w.ok::<call::ThoughtCapture>(&typed(id, "fix the build"));
    s.w.ok::<call::ThoughtCapture>(&typed(id, "fix the build"));
    assert_eq!(s.w.model.thoughts.len(), 1);
    let other = typed(id, "something else");
    assert_eq!(
        code(s.w.call::<call::ThoughtCapture>(&other)),
        Code::Conflict
    );
    // Every argument counts: the same text for a project, or as a note, is another capture.
    let elsewhere = Capture {
        project_id: Some(s.project),
        ..typed(id, "fix the build")
    };
    let note = Capture {
        mode: Some(Mode::Note),
        ..typed(id, "fix the build")
    };
    for other in [elsewhere, note] {
        let refused = s.w.call::<call::ThoughtCapture>(&other);
        assert_eq!(code(refused), Code::Conflict);
    }

    let missing = Ref {
        id: ThoughtId::mint(),
    };
    assert_eq!(code(s.w.call::<call::ThoughtStop>(&missing)), Code::Gone);
    // Retry fits only a failed thought, start only a routed one.
    assert_eq!(
        code(s.w.call::<call::ThoughtRetry>(&Ref { id })),
        Code::Conflict
    );
    s.script(FixtureRoute::Unknown, None);
    let idea = s.capture("an idea");
    assert_eq!(code(start(&mut s, idea, AttemptId::mint())), Code::Conflict);
    // A working thought cannot be picked again.
    s.tick(HOLD_MS);
    assert_eq!(s.w.model.status(id), Status::Working);
    let pick = Assign {
        id,
        project_id: s.project,
    };
    assert_eq!(code(s.w.call::<call::ThoughtUpdate>(&pick)), Code::Conflict);
    let nowhere = Assign {
        id: idea,
        project_id: ProjectId::mint(),
    };
    assert_eq!(code(s.w.call::<call::ThoughtUpdate>(&nowhere)), Code::Gone);
}

#[test]
fn a_refused_launch_fails_the_thought_and_answers_the_start() {
    let mut s = Scene::new("qf");
    let route = clear(s.project);
    s.script(route.clone(), Some("claude is not installed"));
    let t = s.capture("fix it");
    let attempt = AttemptId::mint();
    let refused = start(&mut s, t, attempt).unwrap_err();
    assert_eq!(
        (refused.code, refused.message.as_str()),
        (Code::Failed, "claude is not installed")
    );
    let th = s.w.model.thought(t).clone();
    assert_eq!(
        (th.status, th.reason),
        (Status::Failed, Some(Reason::Launch))
    );
    s.w.sync();
    let session = s.w.model.session(th.session_id.unwrap());
    assert_eq!(session.state, SessionState::Ended);
    // Its repeat answers the same, from the record.
    assert_eq!(start(&mut s, t, attempt).unwrap_err(), refused);

    s.w.ok::<call::ThoughtRetry>(&Ref { id: t });
    assert_eq!(s.w.model.status(t), Status::Routed);
    s.script(route, None);
    start(&mut s, t, AttemptId::mint()).unwrap();
    assert_eq!(s.w.model.status(t), Status::Working);
    assert_eq!(s.log().launched.len(), 2);
}

#[test]
fn stopping_after_the_launch_kills_the_process_and_fails_the_thought() {
    let mut s = Scene::new("qk");
    let (t, session, mut agent) = s.launch("a long job");
    let terminal = s.w.model.session(session).terminal_id.unwrap();
    s.w.ok::<call::ThoughtStop>(&Ref { id: t });
    s.w.sync();
    let th = s.w.model.thought(t);
    assert_eq!(
        (th.status, th.reason),
        (Status::Failed, Some(Reason::Stopped))
    );
    assert_eq!(s.w.model.session(session).state, SessionState::Ended);
    assert_eq!(s.w.model.terminals[&terminal].state, TerminalState::Exited);
    assert_eq!(s.log().killed, [terminal]);
    // No session runs in that terminal any more.
    let late = Said::TurnFinished { answer: None };
    assert_eq!(code(agent.try_say(late)), Code::Gone);
}

#[test]
fn a_follow_up_is_delivered_to_its_running_session() {
    let mut s = Scene::new("qd");
    let (_, session, mut agent) = s.launch("first");
    agent.finish("Done.");
    let f = ThoughtId::mint();
    let follow = Capture {
        session_id: Some(session),
        ..typed(f, "and the tests too")
    };
    s.w.ok::<call::ThoughtCapture>(&follow);
    assert_eq!(s.w.model.thought(f).mode, Mode::Nudge);
    s.tick(HOLD_MS);
    let log = s.log();
    assert_eq!((log.delivered, log.launched.len()), (vec![f], 1));
    assert_eq!(s.w.model.status(f), Status::Working);
    agent.begin();
    s.w.sync();
    assert_eq!(s.w.model.session(session).thought_id, Some(f));
}

#[test]
fn follow_ups_are_bound_in_the_order_they_were_delivered_whatever_their_ids() {
    for reversed in [false, true] {
        let mut s = Scene::new("qo");
        let (_, session, mut agent) = s.launch("first");
        agent.finish("Done.");
        let mut ids = [ThoughtId::mint(), ThoughtId::mint()];
        ids.sort();
        if reversed {
            ids.reverse();
        }
        let [b, c] = ids;
        for id in [b, c] {
            let follow = Capture {
                session_id: Some(session),
                ..typed(id, "and more")
            };
            s.w.ok::<call::ThoughtCapture>(&follow);
            start(&mut s, id, AttemptId::mint()).unwrap();
        }
        assert_eq!(s.log().delivered, [b, c]);
        for (id, answer) in [(b, "Tests added."), (c, "Docs written.")] {
            agent.begin();
            s.w.sync();
            assert_eq!(s.w.model.session(session).thought_id, Some(id));
            agent.finish(answer);
            s.w.sync();
            assert_eq!(s.w.model.results_of(id)[0].summary, answer);
        }
    }
}

#[test]
fn settling_keeps_or_discards_pending_changes_through_the_launcher() {
    let mut s = Scene::new("qe");
    let pending = |s: &Scene, text: &str| Thought {
        id: ThoughtId::mint(),
        rev: Rev::ZERO,
        text: text.into(),
        strokes: Vec::new(),
        source: Source::Typed,
        mode: Mode::Ask,
        phase: Phase::Done,
        status: Status::Done,
        reason: None,
        live: true,
        project_id: Some(s.project),
        session_id: None,
        brief: None,
        agent: Some("claude".into()),
        model: None,
        workdir: Some(Workdir {
            path: "/worktrees/one".into(),
            branch: "tasktap/one".into(),
            destination: "main".into(),
            base: "0123abc".into(),
            changes: Changes::Pending,
        }),
        hold_until: None,
        read: false,
        created: time(s.now),
        updated: time(s.now),
    };
    // Isolation arrives in Phase 3; until then such a thought comes from the records fixture.
    let (kept, refused) = (pending(&s, "keep me"), pending(&s, "not yet"));
    let sets = json!([{ "c": "thoughts", "put": [kept, refused] }]);
    assert!(matches!(
        s.w.raw("fixture.records", json!({ "sets": sets })),
        Outcome::Ok(_)
    ));

    let attempt = AttemptId::mint();
    let keep = Settle {
        id: kept.id,
        attempt,
        keep: true,
    };
    s.w.ok::<call::ThoughtSettle>(&keep);
    let changes = |s: &Scene, id| s.w.model.thought(id).workdir.as_ref().unwrap().changes;
    assert_eq!(changes(&s, kept.id), Changes::Kept);
    // The same attempt answers from its record; nothing settles twice.
    s.w.ok::<call::ThoughtSettle>(&keep);
    assert_eq!(s.log().settled, [kept.id]);
    // Settled already: nothing pending to settle.
    let again = Settle {
        attempt: AttemptId::mint(),
        ..keep
    };
    assert_eq!(
        code(s.w.call::<call::ThoughtSettle>(&again)),
        Code::Conflict
    );

    // A refused settle says why and leaves the changes pending.
    s.script(clear(s.project), Some("main moved"));
    let discard = Settle {
        id: refused.id,
        attempt: AttemptId::mint(),
        keep: false,
    };
    let e = s.w.call::<call::ThoughtSettle>(&discard).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (Code::Failed, "main moved"));
    assert_eq!(changes(&s, refused.id), Changes::Pending);
}

#[test]
fn reading_an_ended_thought_clears_done_and_lets_it_leave_for_history() {
    let mut s = Scene::new("qread");
    let (t, _, mut agent) = s.launch("fix the build");
    let read = Ref { id: t };
    assert_eq!(code(s.w.call::<call::ThoughtRead>(&read)), Code::Conflict);
    agent.finish("Fixed.");
    s.w.sync();
    let done = (s.w.model.status(t), s.w.model.glance().done);
    assert_eq!(done, (Status::Done, 1));

    // 200 newer finished thoughts; unread, this one stays live all the same.
    let row = s.w.model.thought(t).clone();
    let newer: Vec<Thought> = (0..200)
        .map(|i| Thought {
            id: ThoughtId::mint(),
            text: format!("newer {i}"),
            session_id: None,
            read: true,
            ..row.clone()
        })
        .collect();
    let sets = json!([{ "c": "thoughts", "put": newer }]);
    let written = s.w.raw("fixture.records", json!({ "sets": sets }));
    assert!(matches!(written, Outcome::Ok(_)));
    assert!(s.w.model.thoughts.contains_key(&t));

    // Read, ended and with nothing to settle, it is finished: it leaves for history.
    s.w.ok::<call::ThoughtRead>(&read);
    assert_eq!(s.w.model.glance().done, 0);
    assert!(!s.w.model.thoughts.contains_key(&t));
    assert!(s.w.model.results.is_empty());
    let page = s.w.ok::<call::History>(&History {
        before: None,
        limit: Limit::MAX,
    });
    let left: Vec<_> = page.thoughts.iter().map(|h| (h.id, h.read)).collect();
    assert_eq!(left, [(t, true)]);
    assert!(page.results.iter().any(|r| r.thought_id == t));
    // Reading it again changes nothing.
    s.w.ok::<call::ThoughtRead>(&read);
}

#[test]
fn without_its_fixtures_a_build_neither_routes_nor_launches() {
    let data = Folder::new("qn");
    let core = Core::start(&data.0);
    let mut w = core.watch();
    let folder = data.0.join("app");
    std::fs::create_dir_all(&folder).unwrap();
    let add = AddProject {
        id: ProjectId::mint(),
        folder: folder.to_str().unwrap().into(),
        name: None,
    };
    let project = w.ok::<call::ProjectAdd>(&add);

    // Routing needs the router: refused, and nothing is stored.
    let t = ThoughtId::mint();
    let e = w
        .call::<call::ThoughtCapture>(&typed(t, "fix it"))
        .unwrap_err();
    assert_eq!(
        (e.code, e.message.as_str()),
        (Code::Failed, "this build has no router yet")
    );
    // A pick needs the launcher, since a hold ends only in a launch.
    let picked = Capture {
        project_id: Some(project),
        ..typed(ThoughtId::mint(), "fix it")
    };
    let e = w.call::<call::ThoughtCapture>(&picked).unwrap_err();
    assert_eq!(
        (e.code, e.message.as_str()),
        (Code::Failed, "this build has no launcher yet")
    );
    w.sync();
    assert!(w.model.thoughts.is_empty());

    // A note needs neither.
    let n = ThoughtId::mint();
    let note = Capture {
        mode: Some(Mode::Note),
        ..typed(n, "an idea")
    };
    w.ok::<call::ThoughtCapture>(&note);
    let pick = Assign {
        id: n,
        project_id: project,
    };
    assert_eq!(code(w.call::<call::ThoughtUpdate>(&pick)), Code::Failed);
    let th = w.model.thought(n);
    assert_eq!((th.status, th.mode), (Status::Captured, Mode::Note));
}

// Sessions.

#[test]
fn session_events_come_from_the_token_and_drive_its_session() {
    let mut s = Scene::new("qs");
    let t = s.capture("fix it");
    s.tick(HOLD_MS);
    let session = s.w.model.thought(t).session_id.unwrap();
    let mut agent = s.agent(session);
    agent.ready();
    s.w.sync();
    assert_eq!(s.w.model.session(session).state, SessionState::Idle);
    // A second ready does not fit an idle session and changes nothing.
    let rev = s.w.model.session(session).rev;
    agent.ready();
    s.w.sync();
    assert_eq!(s.w.model.session(session).rev, rev);

    agent.begin();
    s.w.sync();
    let sess = s.w.model.session(session);
    assert_eq!(
        (sess.state, sess.turn, sess.thought_id),
        (SessionState::Working, 1, Some(t))
    );
    // Activity is kept in memory, sent with the session, and stays on it.
    let line = "Editing src/lib.rs";
    agent.say(Said::Activity { text: line.into() });
    s.w.until("the activity", |m| m.session(session).activity == [line]);
    agent.finish("Fixed.\nThe login works again.");
    s.w.sync();
    let sess = s.w.model.session(session);
    assert_eq!(
        (sess.state, sess.activity.clone()),
        (SessionState::Idle, vec![line.into()])
    );
    assert_eq!(s.w.model.status(t), Status::Done);
    assert_eq!(s.w.model.results_of(t)[0].summary, "Fixed.");
    let fresh = s.core.watch();
    assert_eq!(fresh.model.session(session).activity, [line]);

    // The same event id again is applied once.
    agent.repeat(Said::TurnStarted { prompt: None });
    s.w.sync();
    assert_eq!(s.w.model.session(session).state, SessionState::Idle);
}

#[test]
fn an_event_for_another_turn_or_from_a_sub_agent_changes_nothing() {
    let mut s = Scene::new("qe");
    let (_, session, mut agent) = s.launch("fix it");
    agent.finish("Fixed.");
    agent.say(Said::TurnStarted {
        prompt: Some("and the docs".into()),
    });
    s.w.sync();
    let second = s.w.model.session(session).thought_id.unwrap();
    let ask = |request: &str| Said::Question {
        question: confirm(request, "Allow?"),
    };
    // A late failure of turn 1, a sub-agent's ending, and their questions.
    for (turn, subagent, said) in [
        (Some(1), false, Said::TurnFailed { error: None }),
        (None, true, Said::TurnInterrupted),
        (Some(1), false, ask("late")),
        (None, true, ask("sub")),
        (Some(3), false, Said::TurnStarted { prompt: None }),
    ] {
        agent.try_say_as(turn, subagent, said).unwrap();
    }
    s.w.sync();
    assert_eq!(s.w.model.status(second), Status::Working);
    assert_eq!(s.w.model.session(session).turn, 2);
    assert!(s.w.model.questions.is_empty(), "{:?}", s.w.model.questions);
    // The same events for this turn apply.
    agent.try_say_as(Some(2), false, ask("now")).unwrap();
    let q = s.shown();
    assert_eq!(s.w.model.question(q).turn, Some(2));
    let fail = Said::TurnFailed { error: None };
    agent.try_say_as(Some(2), false, fail).unwrap();
    s.w.sync();
    assert_eq!(s.w.model.status(second), Status::Failed);
}

#[test]
fn a_token_whose_terminal_runs_no_session_reaches_nothing() {
    let data = Folder::new("qt");
    let token = Secret([7; 32]);
    let hex = serde_json::to_value(&token).unwrap();
    let core = Core::start_with(&data.0, &["--fixture-token", hex.as_str().unwrap()]);
    let mut agent = core.agent(&token);
    assert_eq!(code(agent.try_say(Said::Ready)), Code::Gone);
    assert_eq!(code(agent.ask_now(confirm("k", "Go?"))), Code::Gone);
    assert_eq!(code(agent.withdraw("k")), Code::Gone);
    assert_eq!(code(agent.received("k")), Code::Gone);
}

// Questions (design §6).

#[test]
fn a_waited_question_needs_you_until_answered_and_its_waiter_gets_the_stored_answer() {
    let mut s = Scene::new("qq");
    let (t, session, mut agent) = s.launch("deploy");
    let ask = Ask {
        detail: Some("to staging".into()),
        ..confirm("deploy", "Deploy?")
    };
    agent.ask_with(ask);
    let q = s.shown();
    let row = s.w.model.question(q).clone();
    assert_eq!(
        (row.source, row.reply_via, row.state),
        (QuestionSource::Agent, ReplyVia::Core, QuestionState::Open)
    );
    assert_eq!(
        (row.thought_id, row.session_id, row.turn),
        (Some(t), Some(session), Some(1))
    );
    assert_eq!(row.detail.as_deref(), Some("to staging"));
    assert_eq!(s.w.model.status(t), Status::NeedsYou);
    assert_eq!(s.w.model.session(session).state, SessionState::Working);
    let g = s.w.model.glance();
    assert_eq!((g.working, g.needs_you), (0, 1));
    assert_eq!(s.log().notified, [q]);

    answer(&mut s, q, Response::Affirm).unwrap();
    // Stored before it is sent: the receipt is there, not delivered yet.
    let stored = s.w.model.question(q).answer.clone().unwrap();
    assert_eq!(stored.response, Response::Affirm);
    assert!(stored.device_id.is_some() && stored.delivered.is_none());
    assert_eq!(s.w.model.status(t), Status::Working);
    let got = agent.reply("deploy").unwrap();
    assert_eq!(got, stored);

    agent.received("deploy").unwrap();
    s.w.until("the receipt", |m| {
        m.question(q).answer.as_ref().unwrap().delivered.is_some()
    });
    let receipt = s.w.model.question(q).answer.clone();
    // Acknowledging again changes nothing.
    agent.received("deploy").unwrap();
    s.w.sync();
    assert_eq!(s.w.model.question(q).answer, receipt);
    let g = s.w.model.glance();
    assert_eq!((g.working, g.needs_you, g.question), (1, 0, None));
}

#[test]
fn the_same_key_reaches_the_same_question_and_other_content_is_a_conflict() {
    let mut s = Scene::new("qk");
    let (_, session, mut agent) = s.launch("go");
    agent.ask("k", "Go?");
    let q = s.shown();
    // A second waiter with the same key waits on the same question.
    let mut second = s.agent(session);
    second.ask("k", "Go?");
    second.sync();
    s.w.sync();
    let of = |s: &Scene| {
        (s.w.model.questions.values())
            .filter(|q| q.session_id == Some(session))
            .count()
    };
    assert_eq!(of(&s), 1);
    // Other content under the same key is a conflict.
    let mut third = s.agent(session);
    let other = third.ask_now(confirm("k", "Delete everything?"));
    assert_eq!(code(other), Code::Conflict);

    answer(&mut s, q, Response::Affirm).unwrap();
    assert_eq!(agent.reply("k").unwrap().response, Response::Affirm);
    assert_eq!(second.reply("k").unwrap().response, Response::Affirm);
    // Asking again returns the stored answer at once.
    let again = third.ask_now(confirm("k", "Go?")).unwrap();
    assert_eq!(again.response, Response::Affirm);
    assert_eq!(of(&s), 1);
}

#[test]
fn several_open_questions_keep_needs_you_and_glance_shows_the_focused_one() {
    let mut s = Scene::new("qo");
    let (t, _, mut agent) = s.launch("migrate");
    for (key, prompt) in [("a", "A?"), ("b", "B?"), ("c", "C?")] {
        agent.ask(key, prompt);
    }
    agent.sync();
    s.w.sync();
    let [a, b, c] = ["A?", "B?", "C?"].map(|p| asked(&s, p));
    let g = s.w.model.glance();
    assert_eq!((g.needs_you, g.question), (1, Some(a)), "the oldest");

    answer(&mut s, a, Response::Affirm).unwrap();
    assert_eq!(s.w.model.status(t), Status::NeedsYou, "two still open");
    s.w.sync();
    assert_eq!(s.w.model.glance().question, Some(b));
    s.w.ok::<call::QuestionFocus>(&Ref { id: c });
    assert_eq!(s.w.model.glance().question, Some(c));
    // Only an open question can be focused.
    assert_eq!(
        code(s.w.call::<call::QuestionFocus>(&Ref { id: a })),
        Code::Gone
    );
    // Once the focused one is answered, the oldest open one is shown again.
    input(&mut s, c, Action::Deny).unwrap();
    s.w.sync();
    assert_eq!(s.w.model.glance().question, Some(b));
    input(&mut s, b, Action::Affirm).unwrap();
    s.w.sync();
    assert_eq!(s.w.model.status(t), Status::Working);
    let g = s.w.model.glance();
    assert_eq!((g.needs_you, g.question), (0, None));
    for (key, response) in [
        ("a", Response::Affirm),
        ("b", Response::Affirm),
        ("c", Response::Deny),
    ] {
        assert_eq!(agent.reply(key).unwrap().response, response);
    }
}

#[test]
fn affirm_and_deny_act_through_input_and_answers_must_fit() {
    let mut s = Scene::new("qi");
    let (_, _, mut agent) = s.launch("choose");
    agent.ask("yes", "Proceed?");
    agent.ask("no", "Delete?");
    agent.ask_with(choice("pick", "Which?", &["red", "blue"]));
    agent.ask_with(Ask {
        kind: QuestionKind::Text,
        ..confirm("name", "Name it?")
    });
    agent.sync();
    s.w.sync();
    let [yes, no, pick, name] = ["Proceed?", "Delete?", "Which?", "Name it?"].map(|p| asked(&s, p));

    input(&mut s, yes, Action::Affirm).unwrap();
    input(&mut s, no, Action::Deny).unwrap();
    // Affirm fits a confirm only; a choice must be one of the question's.
    assert_eq!(code(input(&mut s, pick, Action::Affirm)), Code::Invalid);
    let out_of_range = Response::Choice { choice: 2 };
    assert_eq!(code(answer(&mut s, pick, out_of_range)), Code::Invalid);
    assert_eq!(
        code(answer(&mut s, pick, Response::Terminal)),
        Code::Invalid
    );
    answer(&mut s, pick, Response::Choice { choice: 1 }).unwrap();
    let text = Response::Text {
        text: "Blue".into(),
    };
    answer(&mut s, name, text.clone()).unwrap();
    let unknown = QuestionId::mint();
    assert_eq!(code(input(&mut s, unknown, Action::Affirm)), Code::Gone);

    for (key, response) in [
        ("yes", Response::Affirm),
        ("no", Response::Deny),
        ("pick", Response::Choice { choice: 1 }),
        ("name", text),
    ] {
        assert_eq!(agent.reply(key).unwrap().response, response);
    }
}

#[test]
fn a_waiter_that_disconnects_withdraws_its_question_and_reopens_it_on_return() {
    let mut s = Scene::new("qx");
    let (t, session, mut agent) = s.launch("go");
    agent.ask("k", "Go?");
    let q = s.shown();
    drop(agent);
    s.w.until("the question is withdrawn", |m| {
        m.question(q).state == QuestionState::Withdrawn
    });
    s.w.sync();
    assert_eq!(s.w.model.status(t), Status::Working);
    assert_eq!(s.w.model.glance().needs_you, 0);
    let e = answer(&mut s, q, Response::Affirm).unwrap_err();
    assert_eq!(
        (e.code, e.message.as_str()),
        (Code::Gone, "the question was withdrawn")
    );

    // Back with the same key while the turn is alive: the same question reopens.
    let mut back = s.agent(session);
    back.ask("k", "Go?");
    s.w.until("it reopens", |m| m.question(q).state == QuestionState::Open);
    assert_eq!(s.w.model.questions.len(), 1);
    assert_eq!(s.w.model.status(t), Status::NeedsYou);
    answer(&mut s, q, Response::Deny).unwrap();
    assert_eq!(back.reply("k").unwrap().response, Response::Deny);
}

#[test]
fn an_answer_stored_while_its_waiter_was_away_is_returned_again() {
    let mut s = Scene::new("qy");
    let (_, session, mut agent) = s.launch("go");
    agent.ask("k", "Go?");
    let q = s.shown();
    answer(&mut s, q, Response::Affirm).unwrap();
    // The waiter goes before it reads the answer.
    drop(agent);
    let mut back = s.agent(session);
    back.sync();
    s.w.sync();
    let row = s.w.model.question(q).clone();
    assert_eq!(row.state, QuestionState::Answered);
    assert_eq!(row.answer.as_ref().unwrap().delivered, None);
    let again = back.ask_now(confirm("k", "Go?")).unwrap();
    assert_eq!(again.response, Response::Affirm);
    back.received("k").unwrap();
    s.w.until("the receipt", |m| {
        m.question(q).answer.as_ref().unwrap().delivered.is_some()
    });
}

#[test]
fn of_two_devices_answering_at_once_exactly_one_wins() {
    let mut s = Scene::new("q2");
    let (_, _, mut agent) = s.launch("go");
    agent.ask("k", "Go?");
    let q = s.shown();
    let (mut one, mut two) = (s.core.device(), s.core.device());
    let send = |c: &mut Client, response| {
        let args = AnswerQuestion { id: q, response };
        c.send(&call::QuestionAnswer::request(CallId(1), &args))
            .unwrap();
    };
    send(&mut one, Response::Affirm);
    send(&mut two, Response::Deny);
    let reply = |c: &mut Client| loop {
        if let Frame::Control(Control::Reply(r)) = c.recv().unwrap() {
            return call::QuestionAnswer::result(r.outcome);
        }
    };
    let (first, second) = (reply(&mut one), reply(&mut two));
    let lost = match (&first, &second) {
        (Ok(()), Err(e)) | (Err(e), Ok(())) => e.clone(),
        _ => panic!("{first:?} and {second:?}"),
    };
    assert_eq!(
        (lost.code, lost.message.as_str()),
        (Code::Gone, "the question was answered already")
    );
    let won = if first.is_ok() {
        Response::Affirm
    } else {
        Response::Deny
    };
    assert_eq!(agent.reply("k").unwrap().response, won);
}

#[test]
fn the_asker_withdraws_its_own_question_and_the_wait_ends() {
    let mut s = Scene::new("qv");
    let (t, session, mut agent) = s.launch("go");
    agent.ask("k", "Go?");
    let q = s.shown();
    let mut other = s.agent(session);
    other.withdraw("k").unwrap();
    assert_eq!(
        code(agent.reply("k")),
        Code::Gone,
        "the waiter stops waiting"
    );
    s.w.sync();
    assert_eq!(s.w.model.question(q).state, QuestionState::Withdrawn);
    assert_eq!(s.w.model.status(t), Status::Working);
    // Withdrawing again is a repeat; an unknown key is gone.
    other.withdraw("k").unwrap();
    assert_eq!(code(other.withdraw("nope")), Code::Gone);
    // A receipt needs an answer.
    assert_eq!(code(other.received("k")), Code::Gone);
    agent.ask("j", "J?");
    agent.sync();
    assert_eq!(code(other.received("j")), Code::Conflict);
    let j = s.shown();
    answer(&mut s, j, Response::Affirm).unwrap();
    // An answered question can no longer be withdrawn.
    assert_eq!(code(other.withdraw("j")), Code::Conflict);
    assert_eq!(agent.reply("j").unwrap().response, Response::Affirm);
}

#[test]
fn a_question_asked_in_the_terminal_closes_on_continue_turn_end_or_session_end() {
    let mut s = Scene::new("qh");
    let (t, session, mut agent) = s.launch("clean up");
    let asked_in_terminal = |request: &str, prompt: &str| Said::Question {
        question: confirm(request, prompt),
    };
    // A hook reports it and exits; nobody waits on the core for it.
    let mut hook = s.agent(session);
    hook.say(asked_in_terminal("call-1", "Allow rm -rf build?"));
    drop(hook);
    let q = s.shown();
    agent.sync();
    s.w.sync();
    let row = s.w.model.question(q).clone();
    assert_eq!(
        row.state,
        QuestionState::Open,
        "still open after the hook left"
    );
    assert_eq!(
        (row.reply_via, row.turn, row.thought_id),
        (ReplyVia::Terminal, Some(1), Some(t))
    );
    assert_eq!(s.w.model.status(t), Status::NeedsYou);
    // The same call reported again is the same question; other content is a conflict.
    agent.say(asked_in_terminal("call-1", "Allow rm -rf build?"));
    let other = agent.try_say(asked_in_terminal("call-1", "Allow rm -rf /?"));
    assert_eq!(code(other), Code::Conflict);
    s.w.sync();
    assert_eq!(s.w.model.questions.len(), 1);
    // It is answered in the terminal, not from a device.
    assert_eq!(code(answer(&mut s, q, Response::Affirm)), Code::Invalid);
    assert_eq!(code(input(&mut s, q, Action::Deny)), Code::Invalid);
    // The agent goes on: it was answered in the terminal.
    agent.say(Said::Continued);
    s.w.sync();
    let row = s.w.model.question(q);
    assert_eq!(row.state, QuestionState::Answered);
    assert_eq!(row.answer.as_ref().unwrap().response, Response::Terminal);
    assert_eq!(s.w.model.status(t), Status::Working);

    // Turn end withdraws one still open.
    agent.say(asked_in_terminal("call-2", "Overwrite?"));
    let q2 = s.shown();
    agent.finish("Cleaned.");
    s.w.sync();
    assert_eq!(s.w.model.question(q2).state, QuestionState::Withdrawn);
    assert_eq!(s.w.model.status(t), Status::Done);

    // Session end withdraws one still open: a prompt typed by hand starts a
    // turn and its own thought, which is stopped.
    agent.say(Said::TurnStarted {
        prompt: Some("and the caches".into()),
    });
    agent.say(asked_in_terminal("call-3", "Clear ~/.cache?"));
    let q3 = s.shown();
    let typed = s.w.model.question(q3).thought_id.unwrap();
    assert_ne!(typed, t);
    assert_eq!(s.w.model.thought(typed).source, Source::Terminal);
    s.w.ok::<call::ThoughtStop>(&Ref { id: typed });
    s.w.sync();
    assert_eq!(s.w.model.question(q3).state, QuestionState::Withdrawn);
    assert_eq!(s.w.model.session(session).state, SessionState::Ended);
}

#[test]
fn open_questions_are_bounded_per_session_and_in_all() {
    use tasktap_proto::{MAX_OPEN_QUESTIONS, MAX_SESSION_QUESTIONS};
    let mut s = Scene::new("qm");
    let hook = |n: usize| Said::Question {
        question: confirm(&format!("call-{n}"), "Allow?"),
    };
    let (t, _, mut agent) = s.launch("go");
    for n in 0..MAX_SESSION_QUESTIONS {
        agent.say(hook(n));
    }
    // One more, asked in the terminal or waited on, is refused; a repeat is not.
    assert_eq!(code(agent.try_say(hook(99))), Code::Conflict);
    assert_eq!(code(agent.ask_now(confirm("wait", "Go?"))), Code::Conflict);
    agent.say(hook(0));
    // Once they close there is room again.
    agent.say(Said::Continued);
    agent.ask("wait", "Go?");
    agent.sync();
    s.w.sync();
    assert_eq!(s.w.model.status(t), Status::NeedsYou);
    agent.finish("Done.");
    assert_eq!(code(agent.reply("wait")), Code::Gone);

    // All sessions together hold no more than the total.
    for _ in 0..MAX_OPEN_QUESTIONS / MAX_SESSION_QUESTIONS {
        let (_, _, mut agent) = s.launch("go");
        for n in 0..MAX_SESSION_QUESTIONS {
            agent.say(hook(n));
        }
    }
    let (_, _, mut last) = s.launch("one more");
    assert_eq!(code(last.try_say(hook(0))), Code::Conflict);
    s.w.sync();
    let open = s.w.model.questions.values();
    let open = open.filter(|q| q.state == QuestionState::Open).count();
    assert_eq!(open, MAX_OPEN_QUESTIONS);
}

#[test]
fn an_answer_never_acknowledged_stays_undelivered_and_turn_end_withdraws_the_rest() {
    let mut s = Scene::new("qg");
    let (t, _, mut agent) = s.launch("go");
    agent.ask("a", "A?");
    agent.ask("b", "B?");
    agent.sync();
    s.w.sync();
    let [a, b] = ["A?", "B?"].map(|p| asked(&s, p));
    answer(&mut s, a, Response::Affirm).unwrap();
    // The agent prints the answer and never sends the receipt.
    assert_eq!(agent.reply("a").unwrap().response, Response::Affirm);
    agent.finish("Done.");
    s.w.sync();
    let row = s.w.model.question(a);
    assert_eq!(row.state, QuestionState::Answered);
    assert_eq!(row.answer.as_ref().unwrap().delivered, None);
    assert_eq!(s.w.model.question(b).state, QuestionState::Withdrawn);
    assert_eq!(code(agent.reply("b")), Code::Gone, "nothing waits forever");
    assert_eq!(s.w.model.status(t), Status::Done);
}

#[test]
fn an_ask_outside_a_turn_is_refused_and_an_old_key_does_not_come_back() {
    let mut s = Scene::new("qb");
    let t = s.capture("go");
    s.tick(HOLD_MS);
    let session = s.w.model.thought(t).session_id.unwrap();
    let mut agent = s.agent(session);
    agent.ready();
    assert_eq!(code(agent.ask_now(confirm("k", "Go?"))), Code::Conflict);
    agent.begin();
    agent.ask("k", "Go?");
    let q = s.shown();
    s.agent(session).withdraw("k").unwrap();
    assert_eq!(code(agent.reply("k")), Code::Gone);
    agent.finish("Done.");
    agent.say(Said::TurnStarted {
        prompt: Some("one more".into()),
    });
    // Its turn has ended: the key cannot bring it back.
    assert_eq!(code(agent.ask_now(confirm("k", "Go?"))), Code::Gone);
    s.w.sync();
    assert_eq!(s.w.model.question(q).state, QuestionState::Withdrawn);
}

#[test]
fn each_caller_reaches_only_its_own_calls_and_its_own_session() {
    let mut s = Scene::new("qp");
    let (ta, _, mut a) = s.launch("first");
    let (tb, _, mut b) = s.launch("second");
    a.ask("k", "From A?");
    let qa = s.shown();

    // A session token answers nothing and acts on no thought.
    let calls: [(&str, Value); 6] = [
        ("question.answer", json!({ "id": qa, "kind": "affirm" })),
        (
            "input",
            json!({ "action": "answer.affirm", "question": qa }),
        ),
        ("question.focus", json!({ "id": qa })),
        ("thought.capture", json!(typed(ThoughtId::mint(), "x"))),
        ("thought.stop", json!({ "id": ta })),
        ("project.scan", json!({})),
    ];
    for (name, args) in calls {
        assert_eq!(code_of(b.raw(name, args)), Code::Denied, "{name}");
    }
    // A device cannot ask, report or acknowledge as a session.
    for name in [
        "question.ask",
        "session.event",
        "question.withdraw",
        "question.received",
    ] {
        assert_eq!(code_of(s.w.raw(name, json!({}))), Code::Denied, "{name}");
    }

    // One token never reaches another session's question: the key is its own.
    assert_eq!(code(b.withdraw("k")), Code::Gone);
    assert_eq!(code(b.received("k")), Code::Gone);
    b.ask("k", "From B?");
    b.sync();
    s.w.sync();
    let qb = asked(&s, "From B?");
    assert_ne!(qa, qb);
    assert_eq!(s.w.model.question(qa).state, QuestionState::Open);
    // What B says moves only B.
    b.finish("Done.");
    s.w.sync();
    assert_eq!(s.w.model.status(tb), Status::Done);
    assert_eq!(s.w.model.status(ta), Status::NeedsYou);
    assert_eq!(s.w.model.question(qa).state, QuestionState::Open);
    assert_eq!(s.w.model.question(qb).state, QuestionState::Withdrawn);
    assert_eq!(code(b.reply("k")), Code::Gone);
}

fn code_of(outcome: Outcome) -> Code {
    common::code(outcome)
}

#[test]
fn glance_shows_the_oldest_open_question_whichever_clock_runs() {
    let mut s = Scene::new("qk");
    // The held clock runs a day ahead of the system's.
    s.tick(24 * 60 * 60 * 1000);
    let route = FixtureRoute::Ambiguous {
        prompt: "Which project?".into(),
        candidates: vec![FixtureCandidate {
            label: "app".into(),
            to: Place::Project(s.project),
        }],
    };
    s.script(route, None);
    s.capture("update the docs");
    let router = s.shown();
    s.script(clear(s.project), None);
    let (_, _, mut agent) = s.launch("go");
    agent.ask("k", "Go?");
    agent.sync();
    s.w.sync();
    assert_eq!(s.w.model.glance().question, Some(router));
    // Every id the core mints carries its clock.
    assert!(asked(&s, "Go?") > router);
}

#[test]
fn glance_counts_working_needs_you_and_done_and_shows_retiring() {
    let mut s = Scene::new("ql");
    let (_, _, _working) = s.launch("one");
    let (_, _, mut asking) = s.launch("two");
    asking.ask("k", "Go?");
    s.shown();
    let (_, _, mut done) = s.launch("three");
    done.finish("Done.");
    s.capture("held, not counted");
    s.w.sync();
    let g = s.w.model.glance().clone();
    // No Phase 1 call marks a thought read, so every done thought counts.
    assert_eq!(
        (g.working, g.needs_you, g.done, g.retiring),
        (1, 1, 1, false)
    );
    // A fresh subscriber's snapshot holds the same row.
    assert_eq!(s.core.watch().model.glance(), &g);

    // Retiring when idle is shown before the core goes.
    let retire = Retire { when: When::Idle };
    s.w.ok::<call::CoreRetire>(&retire);
    assert!(s.w.model.glance().retiring);
    s.core.wait();
}

#[test]
fn projects_are_added_once_per_folder_and_scanned_when_asked() {
    let data = Folder::new("qj");
    let core = Core::start(&data.0);
    let mut w = core.watch();
    let folder = data.0.join("site");
    std::fs::create_dir_all(folder.join(".git")).unwrap();
    let id = ProjectId::mint();
    let add = |id, folder: &std::path::Path, name: Option<&str>| AddProject {
        id,
        folder: folder.to_str().unwrap().into(),
        name: name.map(Into::into),
    };
    assert_eq!(w.ok::<call::ProjectAdd>(&add(id, &folder, None)), id);
    let p = w.model.projects[&id].clone();
    let canonical = std::fs::canonicalize(&folder).unwrap();
    assert_eq!(
        (p.name.as_str(), p.folder.as_str(), p.git, p.available),
        ("site", canonical.to_str().unwrap(), true, true)
    );
    // The same folder under another id and spelling is the project that holds it.
    let spelled = folder.join("..").join("site");
    let again = add(ProjectId::mint(), &spelled, Some("other"));
    assert_eq!(w.ok::<call::ProjectAdd>(&again), id);
    assert_eq!(w.model.projects.len(), 1);
    // The same id for another folder is a conflict; a missing folder is invalid.
    let elsewhere = data.0.join("docs");
    std::fs::create_dir_all(&elsewhere).unwrap();
    assert_eq!(
        code(w.call::<call::ProjectAdd>(&add(id, &elsewhere, None))),
        Code::Conflict
    );
    let missing = add(ProjectId::mint(), &data.0.join("nowhere"), None);
    assert_eq!(code(w.call::<call::ProjectAdd>(&missing)), Code::Invalid);
    // The id is checked before the folder, over every argument; the same call
    // again is answered as the first time.
    let other = ProjectId::mint();
    assert_eq!(
        w.ok::<call::ProjectAdd>(&add(other, &elsewhere, None)),
        other
    );
    for reused in [add(id, &elsewhere, None), add(id, &folder, Some("site 2"))] {
        assert_eq!(code(w.call::<call::ProjectAdd>(&reused)), Code::Conflict);
    }
    assert_eq!(w.ok::<call::ProjectAdd>(&add(id, &folder, None)), id);
    assert_eq!(w.ok::<call::ProjectAdd>(&again), id);

    // Scanning finds the folder gone, then back without git.
    std::fs::remove_dir_all(&folder).unwrap();
    w.ok::<call::ProjectScan>(&tasktap_proto::Empty {});
    assert!(!w.model.projects[&id].available);
    std::fs::create_dir_all(&folder).unwrap();
    w.ok::<call::ProjectScan>(&tasktap_proto::Empty {});
    let p = &w.model.projects[&id];
    assert_eq!((p.available, p.git), (true, false));
    // Nothing changed: the scan writes nothing.
    let rev = w.model.rev;
    w.ok::<call::ProjectScan>(&tasktap_proto::Empty {});
    assert_eq!(w.model.rev, rev);
}
