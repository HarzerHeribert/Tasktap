//! The loop check (design §13), which every phase must keep passing: a
//! device captures a thought, the router sends it on, the hold passes, the
//! agent runs, asks, gets the device's answer and finishes; then the core
//! restarts and every record is still there and nothing runs again. Then
//! the same restart in the middle of each stage.
//!
//! From Phase 2 the agent is `tasktap fixture-agent` in the real terminal
//! the real launcher started for its session ([`InTerminal`]): its steps are
//! typed into that terminal, and it reports through `tasktap hook` with the
//! session's token. The router is still the fixture's. Every assertion
//! reads records only, so none changed when it replaced Phase 1's client
//! holding the token. A restart ends the core as a crash does, which ends
//! its agents with it. Two tests keep the fixture launcher: one that scripts
//! a launch the store refuses, and one that needs an agent that takes its
//! answer and never confirms it ([`StandIn`]), which the real hook never is.

mod common;

use Status::{Captured, Done, NeedsYou, Routed, Working};
use common::*;
use tasktap_proto::call;
use tasktap_proto::{
    Answer, AnswerQuestion, AttemptId, Candidate, Control, Empty, FixtureScript, Frame, Place,
    QuestionState, Ref, Response, Route, SessionId, SessionState, Start, Status, TerminalState,
};

/// The agent of the loop: the fixture agent in the terminal the launch
/// started, its steps typed as a person types.
struct InTerminal(Screen);

impl InTerminal {
    /// The agent the launch started, once it runs.
    fn start(s: &mut Scene, session: SessionId) -> InTerminal {
        let terminal = s.w.model.session(session).terminal_id;
        let terminal = terminal.expect("the launch stored its terminal");
        let mut screen = Screen::open(&s.core, terminal);
        screen.until("fixture-agent --hook");
        InTerminal(screen)
    }

    fn ready_and_begin(&mut self) {
        self.0.line("event:ready");
        self.0.line("event:turn_started");
    }

    /// Asks through a hook that waits.
    fn ask(&mut self, prompt: &str) {
        self.0.line(&format!("ask:{prompt}"));
    }

    /// The hook printed `said` once the answer came, after confirming it.
    fn answered(&mut self, said: &str) {
        self.0.until(&format!("answer:{said}"));
    }

    fn finish(&mut self, answer: &str) {
        let answer = answer.replace('\n', "\\n");
        self.0.line(&format!("event:turn_finished:{answer}"));
    }
}

/// Phase 1's stand-in: a client holding the session's token, from the
/// fixture launcher.
struct StandIn(Agent);

/// Ends the core as a crash or a power cut would, and starts it again on
/// the same folder, with its fixtures selected again, which start with
/// nothing asked of them.
fn restart(s: Scene) -> Scene {
    let Scene {
        core,
        data,
        w,
        agent,
        ..
    } = s;
    drop((w, core));
    let s = Scene::on(Core::with_agents(&data.0), data);
    match agent {
        Some(agent) => s.running(&agent),
        None => s,
    }
}

/// What a restart must leave: every stored record as it was, the revision
/// going on from where it stood, nothing launched, no hold armed.
fn nothing_ran_again(s: &mut Scene, before: &Model) {
    let after = &s.w.model;
    assert!(
        after.rev > before.top_rev(),
        "the revision went on: {} after {}",
        after.rev,
        before.top_rev()
    );
    assert_eq!(
        after.sessions.len(),
        before.sessions.len(),
        "no new session"
    );
    assert_eq!(
        after.terminals.len(),
        before.terminals.len(),
        "no new terminal"
    );
    assert!(after.thoughts.values().all(|t| t.hold_until.is_none()));
    for t in after.terminals.values() {
        assert_ne!(t.state, TerminalState::Running, "{t:?}");
    }
    for session in after.sessions.values() {
        assert_eq!(session.state, SessionState::Ended, "{session:?}");
    }
    // Time passes far beyond any hold: still nothing starts.
    s.tick(10 * HOLD_MS);
    let log = s.log();
    assert!(log.launched.is_empty(), "{log:?}");
    assert!(log.delivered.is_empty() && log.killed.is_empty());
    let status = s.w.ok::<call::CoreStatus>(&Empty {});
    assert_eq!(status.terminals, 0, "no terminal runs");
}

#[test]
fn the_loop() {
    let mut s = Scene::real("tl", "fixture");
    // A device captures a thought; the fixture router answers clear.
    let t = s.capture("the build fails on main");
    assert_eq!(s.w.model.status(t), Routed);
    // The hold passes; the real launcher starts the agent in a terminal.
    s.tick(HOLD_MS);
    let session = s.w.model.thought(t).session_id.unwrap();

    // The agent reports with its session's token: it is ready, starts its
    // turn, asks and waits.
    let mut agent = InTerminal::start(&mut s, session);
    agent.ready_and_begin();
    agent.ask("Deploy to staging?");
    // The device sees the thought need it, in its records and in glance.
    s.w.until("the thought needs you", |m| {
        m.status(t) == NeedsYou && m.glance().needs_you == 1
    });
    let q =
        s.w.model
            .glance()
            .question
            .expect("glance names the question");
    assert_eq!(s.w.model.question(q).thought_id, Some(t));
    let answer = AnswerQuestion {
        id: q,
        response: Response::Affirm,
    };
    s.w.ok::<call::QuestionAnswer>(&answer);

    // The agent receives the answer, acknowledges it and finishes.
    agent.answered("yes");
    agent.finish("Deployed to staging.\nAll checks green.");
    s.w.until("the thought is done", |m| m.status(t) == Done);
    s.w.sync();

    let m = &s.w.model;
    assert_eq!(
        s.w.statuses[&t],
        [Captured, Routed, Working, NeedsYou, Working, Done]
    );
    let results = m.results_of(t);
    assert_eq!(results.len(), 1, "one result, tied to the thought");
    assert_eq!(
        (results[0].summary.as_str(), results[0].session_id),
        ("Deployed to staging.", Some(session))
    );
    let receipt = m.question(q).answer.clone().expect("the answer is stored");
    assert_eq!(receipt.response, Response::Affirm);
    assert!(
        receipt.delivered.is_some(),
        "the receipt is marked delivered"
    );
    let g = m.glance();
    assert_eq!(
        (g.working, g.needs_you, g.done, g.question),
        (0, 0, 1, None)
    );

    // Restart: every record is still there, and nothing runs again.
    let before = s.w.model.clone();
    let mut s = restart(s);
    assert_eq!(s.w.model.stored(), before.stored());
    assert_eq!(s.w.model.status(t), Done);
    assert_eq!(s.w.model.glance().done, 1, "glance counts what is stored");
    nothing_ran_again(&mut s, &before);
}

#[test]
fn a_restart_with_a_router_question_open_keeps_it_answerable() {
    let mut s = Scene::real("tr", "fixture");
    let other = s.project;
    let route = Route::Ambiguous {
        prompt: "Which project?".into(),
        candidates: vec![Candidate {
            label: "app".into(),
            to: Place::Project(other),
        }],
    };
    s.script(route, None);
    let t = s.capture("tidy the readme");
    let q = s.w.model.glance().question.expect("the router asks");
    assert_eq!(s.w.model.status(t), NeedsYou);

    let before = s.w.model.clone();
    let mut s = restart(s);
    assert_eq!(s.w.model.stored(), before.stored());
    let g = s.w.model.glance();
    assert_eq!((g.needs_you, g.question), (1, Some(q)));
    nothing_ran_again(&mut s, &before);
    let choice = AnswerQuestion {
        id: q,
        response: Response::Choice { choice: 0 },
    };
    s.w.ok::<call::QuestionAnswer>(&choice);
    assert_eq!(s.w.model.status(t), Routed);
}

#[test]
fn a_restart_during_the_hold_restores_no_timer() {
    let mut s = Scene::real("th", "fixture");
    let t = s.capture("bump the version");
    assert!(s.w.model.thought(t).hold_until.is_some());

    let before = s.w.model.clone();
    let mut s = restart(s);
    let th = s.w.model.thought(t);
    assert_eq!((th.status, th.hold_until), (Routed, None));
    nothing_ran_again(&mut s, &before);
    assert_eq!(s.w.model.status(t), Routed);
    // It waits for the person to press Start.
    let start = Start {
        id: t,
        attempt: AttemptId::mint(),
    };
    s.w.ok::<call::ThoughtStart>(&start);
    assert_eq!(s.w.model.status(t), Working);
    let session = s.w.model.thought(t).session_id.unwrap();
    InTerminal::start(&mut s, session);
}

#[test]
fn a_restart_mid_turn_fails_the_thought_and_starts_nothing() {
    let mut s = Scene::real("tw", "fixture");
    let t = s.capture("update the changelog");
    s.tick(HOLD_MS);
    let session = s.w.model.thought(t).session_id.unwrap();
    let mut agent = InTerminal::start(&mut s, session);
    agent.ready_and_begin();
    s.w.until("the turn runs", |m| {
        m.session(session).state == SessionState::Working
    });
    let terminal = s.w.model.session(session).terminal_id.unwrap();

    let before = s.w.model.clone();
    let mut s = restart(s);
    let th = s.w.model.thought(t);
    assert_eq!(
        (th.status, th.reason),
        (Status::Failed, Some(tasktap_proto::Reason::Interrupted))
    );
    assert_eq!(s.w.model.terminals[&terminal].state, TerminalState::Lost);
    nothing_ran_again(&mut s, &before);
    // Its terminal's stream ended with the core.
    while agent.0.pump() {}
    // Retrying routes it again; only Start launches.
    s.w.ok::<call::ThoughtRetry>(&Ref { id: t });
    assert_eq!(s.w.model.status(t), Routed);
    s.tick(10 * HOLD_MS);
    assert_eq!(s.w.model.sessions.len(), before.sessions.len());
}

#[test]
fn a_launch_that_cannot_be_stored_stops_the_core_and_never_runs_again() {
    let mut s = Scene::new("tu");
    let script = FixtureScript {
        route: clear(s.project),
        refuse: None,
        unrecordable: true,
        pause: false,
        agent: None,
    };
    s.w.ok::<call::FixtureScript>(&script);
    let t = s.capture("bump the version");
    let start = Start {
        id: t,
        attempt: AttemptId::mint(),
    };
    // The run starts and storing its launch fails: the core stops without answering.
    s.w.send::<call::ThoughtStart>(&start);
    while let Ok(frame) = s.w.c.recv() {
        assert!(
            !matches!(frame, Frame::Control(Control::Reply(_))),
            "{frame:?}"
        );
    }
    assert!(!s.core.exited().success());

    let Scene { core, data, w, .. } = s;
    drop((w, core));
    let mut s = Scene::on(Core::start(&data.0), data);
    let th = s.w.model.thought(t);
    assert_eq!(
        (th.status, th.reason),
        (Status::Failed, Some(tasktap_proto::Reason::Interrupted))
    );
    let e = s.w.call::<call::ThoughtStart>(&start).unwrap_err();
    assert_eq!(e.code, tasktap_proto::Code::Failed, "{e}");
    assert!(s.log().launched.is_empty());
}

#[test]
fn a_restart_while_the_agent_waits_withdraws_its_question() {
    let mut s = Scene::real("ta", "fixture");
    let t = s.capture("rotate the keys");
    s.tick(HOLD_MS);
    let session = s.w.model.thought(t).session_id.unwrap();
    let mut agent = InTerminal::start(&mut s, session);
    agent.ready_and_begin();
    agent.ask("Rotate now?");
    s.w.until("the question opens", |m| m.glance().question.is_some());
    let q = s.w.model.glance().question.unwrap();

    let before = s.w.model.clone();
    let mut s = restart(s);
    assert_eq!(s.w.model.question(q).state, QuestionState::Withdrawn);
    assert_eq!(s.w.model.status(t), Status::Failed);
    assert_eq!(s.w.model.glance().needs_you, 0);
    nothing_ran_again(&mut s, &before);
}

#[test]
fn a_restart_between_the_answer_and_its_receipt_keeps_the_answer_undelivered() {
    let mut s = Scene::new("tv");
    let (t, session, agent) = s.launch("ship it");
    let mut agent = StandIn(agent);
    agent.0.ask("ship", "Ship?");
    s.w.until("the question opens", |m| m.glance().question.is_some());
    let q = s.w.model.glance().question.unwrap();
    let answer = AnswerQuestion {
        id: q,
        response: Response::Deny,
    };
    s.w.ok::<call::QuestionAnswer>(&answer);
    let got: Answer = agent.0.reply("ship").unwrap();
    assert_eq!(got.response, Response::Deny);

    let before = s.w.model.clone();
    let mut s = restart(s);
    let asked = s.w.model.question(q);
    assert_eq!(asked.state, QuestionState::Answered);
    let receipt = asked.answer.clone().unwrap();
    assert_eq!(
        (receipt.response, receipt.delivered),
        (Response::Deny, None)
    );
    assert_eq!(s.w.model.status(t), Status::Failed);
    assert_eq!(s.w.model.session(session).state, SessionState::Ended);
    nothing_ran_again(&mut s, &before);
}
