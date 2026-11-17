//! Routing (design §8): the local router, which matches the words of a
//! capture against the names and aliases of the core's own projects and
//! sessions with no model call. Its rules are proven as a table on the pure
//! function; a normal build routes with it and answers `route.hint` with the
//! same match.

mod common;

use common::*;
use tasktap_core::route::{Followed, Named, Request, local};
use tasktap_core::state::{Candidate, Destination, Route};
use tasktap_proto::{
    AddProject, Capture, FixtureClock, Hint, Mode, PrefPatch, ProjectId, ProjectPatch, Put,
    PutTarget, QuestionKind, QuestionSource, SessionId, Status, ThoughtId, call,
};

#[test]
fn the_local_router_follows_its_table() {
    let (tasktap, folio, app) = (ProjectId::mint(), ProjectId::mint(), ProjectId::mint());
    let (login, quiet) = (SessionId::mint(), SessionId::mint());
    let project = |id, name: &str, aliases: &[&str]| Named {
        id,
        name: name.into(),
        aliases: aliases.iter().map(|a| (*a).into()).collect(),
    };
    let request = |text: &str, current| Request {
        text: text.into(),
        current,
        projects: vec![
            project(tasktap, "tasktap", &["the core"]),
            project(folio, "folio", &[]),
            project(app, "app", &[]),
        ],
        sessions: vec![
            Followed {
                id: login,
                name: Some("Login fix".into()),
                project: tasktap,
                label: "The claude session in tasktap".into(),
            },
            Followed {
                id: quiet,
                name: None,
                project: folio,
                label: "The codex session in folio".into(),
            },
        ],
    };
    let new = Destination::New;
    let to = Destination::Session;
    let choice = |label: &str, to| Candidate {
        label: label.into(),
        to,
    };
    // (text, current session, where it goes: Ok for clear, the choices otherwise)
    type Goes = Result<Destination, Vec<Candidate>>;
    let table: Vec<(&str, Option<SessionId>, Goes)> = vec![
        // One project named: a new run there, whatever the case.
        ("fix the header in folio", None, Ok(new(folio))),
        ("FOLIO's header is off", None, Ok(new(folio))),
        // An alias names its project, as whole words.
        ("the core tests fail", None, Ok(new(tasktap))),
        // A name inside another word names nothing.
        ("update the portfolio page", None, Err(vec![])),
        ("tasktapper", None, Err(vec![])),
        // Several projects: the person chooses.
        (
            "move the code from folio to app",
            None,
            Err(vec![choice("folio", new(folio)), choice("app", new(app))]),
        ),
        // A session named: a follow-up to it, also with its own project named.
        ("continue the login fix", None, Ok(to(login))),
        ("the login fix in tasktap needs tests", None, Ok(to(login))),
        // A session and another project: the person chooses.
        (
            "the login fix, but in folio",
            None,
            Err(vec![
                choice("folio", new(folio)),
                choice("Login fix", to(login)),
            ]),
        ),
        // Made in a session: a follow-up to it unless another project is named.
        ("also add a footer", Some(quiet), Ok(to(quiet))),
        ("also add a footer to folio", Some(quiet), Ok(to(quiet))),
        ("also add a footer to app", Some(quiet), Ok(new(app))),
        (
            "a named session wins: the login fix",
            Some(quiet),
            Ok(to(login)),
        ),
        (
            "folio and app",
            Some(quiet),
            Err(vec![choice("folio", new(folio)), choice("app", new(app))]),
        ),
        // A current session the records do not offer is no destination.
        ("also add a footer", Some(SessionId::mint()), Err(vec![])),
        // Nothing named: an idea.
        ("buy milk", None, Err(vec![])),
        ("", None, Err(vec![])),
    ];
    for (text, current, expected) in table {
        let route = local(&request(text, current));
        let wanted = match expected {
            Ok(to) => Route::Clear {
                to,
                brief: text.into(),
            },
            Err(candidates) if candidates.is_empty() => Route::Unknown,
            Err(candidates) => Route::Ambiguous {
                prompt: "Where should this go?".into(),
                candidates,
            },
        };
        assert_eq!(route, wanted, "{text:?} with {current:?}");
    }
    // An unnamed session is offered under its label.
    let mut r = request("the login fix or the other one", None);
    r.sessions[1].name = Some("other one".into());
    let Route::Ambiguous { candidates, .. } = local(&r) else {
        panic!("two sessions named")
    };
    assert_eq!(
        candidates,
        [
            choice("Login fix", to(login)),
            choice("other one", to(quiet))
        ]
    );
}

#[test]
fn a_normal_build_routes_by_name_and_hints_the_same() {
    let data = Folder::new("route");
    let core = Core::with_agents(&data.0);
    let mut w = core.watch();
    let mut add = |name: &str| {
        let folder = data.0.join(name);
        std::fs::create_dir_all(&folder).unwrap();
        let add = AddProject {
            id: ProjectId::mint(),
            folder: folder.to_str().unwrap().into(),
            name: None,
        };
        w.ok::<call::ProjectAdd>(&add)
    };
    let (app, folio) = (add("app"), add("folio"));
    let alias = ProjectPatch {
        name: None,
        color: None,
        aliases: Some(vec!["the site".into()]),
        isolate: None,
    };
    w.ok::<call::Put>(&Put {
        target: PutTarget::Projects {
            id: folio,
            patch: alias,
        },
        if_rev: None,
    });
    // The clock stands still, so a hold never ends.
    w.ok::<call::FixtureClock>(&FixtureClock {
        now: time(wall_ms()),
    });
    let hint = |w: &mut Watch, text: &str, current| {
        let text = text.into();
        w.ok::<call::RouteHint>(&Hint { text, current })
    };
    let capture = |w: &mut Watch, text: &str, current| {
        let id = ThoughtId::mint();
        let capture = Capture {
            agent: Some("fixture".into()),
            current,
            ..typed(id, text)
        };
        w.ok::<call::ThoughtCapture>(&capture);
        id
    };

    // One project named: clear, the brief the text unchanged.
    let text = "Fix the header of the site";
    let clear = tasktap_proto::Route::Clear {
        to: tasktap_proto::Place::Project(folio),
        brief: text.into(),
    };
    assert_eq!(hint(&mut w, text, None), clear);
    let t = capture(&mut w, text, None);
    let th = w.model.thought(t);
    assert_eq!(
        (th.status, th.project_id, th.brief.as_deref(), th.mode),
        (Status::Routed, Some(folio), Some(text), Mode::Ask)
    );

    // Two named: a router question with both.
    let text = "move the code from folio to app";
    let t = capture(&mut w, text, None);
    w.until("the router asks", |m| m.glance().question.is_some());
    let q = w.model.question(w.model.glance().question.unwrap()).clone();
    assert_eq!((q.thought_id, q.source), (Some(t), QuestionSource::Router));
    assert_eq!(
        q.kind,
        QuestionKind::Choice {
            choices: vec!["app".into(), "folio".into()]
        }
    );
    assert_eq!(w.model.status(t), Status::NeedsYou);
    let tasktap_proto::Route::Ambiguous { candidates, .. } = hint(&mut w, text, None) else {
        panic!("the hint is ambiguous too")
    };
    assert_eq!(candidates.len(), 2);

    // Nothing named: an idea, and the hint says so.
    let t = capture(&mut w, "buy milk", None);
    let th = w.model.thought(t);
    assert_eq!((th.status, th.mode), (Status::Captured, Mode::Note));
    assert_eq!(
        hint(&mut w, "buy milk", None),
        tasktap_proto::Route::Unknown
    );

    // Made in a running session: a follow-up to it, unless another project
    // is named. A run picked for app starts at once and waits.
    let hold = |w: &mut Watch, seconds| {
        let target = PutTarget::Prefs(PrefPatch::Hold(seconds));
        w.ok::<call::Put>(&Put {
            target,
            if_rev: None,
        });
    };
    hold(&mut w, 0);
    let run = ThoughtId::mint();
    let pick = Capture {
        project_id: Some(app),
        agent: Some("fixture".into()),
        ..typed(run, "wait")
    };
    w.ok::<call::ThoughtCapture>(&pick);
    w.until("the run has a session", |m| {
        m.thoughts[&run].session_id.is_some()
    });
    let session = w.model.thought(run).session_id.unwrap();
    hold(&mut w, 5);
    let text = "and add tests";
    let to_session = tasktap_proto::Place::Session(session);
    assert!(
        matches!(hint(&mut w, text, Some(session)), tasktap_proto::Route::Clear { to, .. } if to == to_session)
    );
    let t = capture(&mut w, text, Some(session));
    let th = w.model.thought(t);
    assert_eq!(
        (th.status, th.session_id, th.mode),
        (Status::Routed, Some(session), Mode::Nudge)
    );
    let elsewhere = "and add tests to folio";
    let t = capture(&mut w, elsewhere, Some(session));
    let th = w.model.thought(t);
    assert_eq!(
        (th.status, th.project_id, th.session_id),
        (Status::Routed, Some(folio), None)
    );
    core.stop();
}
