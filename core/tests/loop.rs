//! The loop check (design §13), which every phase must keep passing: a
//! device captures a thought, the router sends it on, the hold passes, the
//! agent runs, asks, gets the device's answer and finishes; then the core
//! restarts and every record is still there and nothing runs again. Then
//! the same restart in the middle of each stage.
//!
//! In Phase 1 a client holding the session's token stands in for the agent
//! ([`StandIn`]). Phase 2 puts the fixture agent in a real terminal behind
//! the same methods; every assertion reads records only, so none changes.

mod common;

use Status::{Captured, Done, NeedsYou, Routed, Working};
use common::*;
use tasktap_proto::call;
use tasktap_proto::{
    Answer, AnswerQuestion, AttemptId, FixtureCandidate, FixtureRoute, Place, QuestionState, Ref,
    Response, SessionId, SessionState, Start, Status, TerminalState,
};

/// The agent of the loop: what `tasktap fixture-agent` does in Phase 2.
struct StandIn(Agent);

impl StandIn {
    /// The agent starts in the session's terminal, with its token.
    fn start(s: &mut Scene, session: SessionId) -> StandIn {
        StandIn(s.agent(session))
    }

    fn ready_and_begin(&mut self) {
        self.0.ready();
        self.0.begin();
    }

    /// `tasktap ask`: asks and waits.
    fn ask(&mut self, request: &str, prompt: &str) {
        self.0.ask(request, prompt);
    }

    fn answer(&mut self, request: &str) -> Answer {
        self.0.reply(request).expect("the agent gets its answer")
    }

    fn acknowledge(&mut self, request: &str) {
        self.0.received(request).unwrap();
    }

    fn finish(&mut self, answer: &str) {
        self.0.finish(answer);
    }
}

/// Stops the core and starts it again on the same folder, with its fixtures
/// selected again, which start with nothing asked of them.
fn restart(s: Scene) -> Scene {
    let Scene { core, data, w, .. } = s;
    drop(w);
    core.stop();
    let core = Core::start(&data.0);
    Scene::on(core, data)
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
}

#[test]
fn the_loop() {
    let mut s = Scene::new("tl");
    // A device captures a thought; the fixture router answers clear.
    let t = s.capture("the build fails on main");
    assert_eq!(s.w.model.status(t), Routed);
    // The hold passes; the fixture launcher launches.
    s.tick(HOLD_MS);
    let session = s.w.model.thought(t).session_id.unwrap();
    assert_eq!(s.log().launched.len(), 1);

    // The agent connects with its session's token, is ready, starts its
    // turn, asks and waits.
    let mut agent = StandIn::start(&mut s, session);
    agent.ready_and_begin();
    agent.ask("deploy", "Deploy to staging?");
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
    assert_eq!(agent.answer("deploy").response, Response::Affirm);
    agent.acknowledge("deploy");
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
    let mut s = Scene::new("tr");
    let other = s.project;
    let route = FixtureRoute::Ambiguous {
        prompt: "Which project?".into(),
        candidates: vec![FixtureCandidate {
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
    let mut s = Scene::new("th");
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
}

#[test]
fn a_restart_mid_turn_fails_the_thought_and_starts_nothing() {
    let mut s = Scene::new("tw");
    let (t, session, mut agent) = s.launch("update the changelog");
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
    // The agent's connection ended with the core.
    assert!(agent.c.recv().is_err());
    // Retrying routes it again; only Start launches.
    s.w.ok::<call::ThoughtRetry>(&Ref { id: t });
    assert_eq!(s.w.model.status(t), Routed);
    assert!(s.log().launched.is_empty());
}

#[test]
fn a_restart_while_the_agent_waits_withdraws_its_question() {
    let mut s = Scene::new("ta");
    let (t, _, mut agent) = s.launch("rotate the keys");
    agent.ask("rotate", "Rotate now?");
    s.w.until("the question opens", |m| m.glance().question.is_some());
    let q = s.w.model.glance().question.unwrap();

    let before = s.w.model.clone();
    let mut s = restart(s);
    assert_eq!(s.w.model.question(q).state, QuestionState::Withdrawn);
    assert_eq!(s.w.model.status(t), Status::Failed);
    assert_eq!(s.w.model.glance().needs_you, 0);
    nothing_ran_again(&mut s, &before);
    assert!(
        agent.c.recv().is_err(),
        "the waiter's call ends with the core"
    );
}

#[test]
fn a_restart_between_the_answer_and_its_receipt_keeps_the_answer_undelivered() {
    let mut s = Scene::new("tv");
    let (t, session, mut agent) = s.launch("ship it");
    agent.ask("ship", "Ship?");
    s.w.until("the question opens", |m| m.glance().question.is_some());
    let q = s.w.model.glance().question.unwrap();
    let answer = AnswerQuestion {
        id: q,
        response: Response::Deny,
    };
    s.w.ok::<call::QuestionAnswer>(&answer);
    assert_eq!(agent.reply("ship").unwrap().response, Response::Deny);

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
