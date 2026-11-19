//! Routing (design §8): the local router, which matches the words of a
//! capture against the names and aliases of the core's own projects and
//! sessions with no model call. Its rules are proven as a table on the pure
//! function; a normal build routes with it and answers `route.hint` with the
//! same match.

mod common;

use common::*;
use serde_json::{Value, json};
use tasktap_core::route::{
    Followed, Named, Request, accept, by_names, local, request, same, short,
};
use tasktap_core::state::{Candidate, Destination, Route};
use tasktap_core::store::Store;
use tasktap_proto::{
    AddProject, Capture, FixtureClock, Hint, Mode, Placed, PrefPatch, ProjectId, ProjectKind,
    ProjectPatch, Put, PutTarget, QuestionKind, QuestionSource, QuestionState, Response, RouteBy,
    Routing, SessionId, SessionState, Status, Thought, ThoughtId, call,
};

#[test]
fn the_local_router_follows_its_table() {
    let (tasktap, folio, app) = (ProjectId::mint(), ProjectId::mint(), ProjectId::mint());
    let (login, quiet) = (SessionId::mint(), SessionId::mint());
    let project = |id, name: &str, aliases: &[&str]| Named::open(id, name, aliases);
    let request = |text: &str, current| Request {
        last: None,
        text: text.into(),
        current,
        picked: None,
        recent: Vec::new(),
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
                agent: "claude".into(),
                state: SessionState::Idle,
                thought: None,
                task: String::new(),
            },
            Followed {
                id: quiet,
                name: None,
                project: folio,
                label: "The codex session in folio".into(),
                agent: "codex".into(),
                state: SessionState::Idle,
                thought: None,
                task: String::new(),
            },
        ],
    };
    let new = Destination::New;
    let to = Destination::Session;
    let choice = |label: &str, to| Candidate {
        why: String::new(),
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
    // What the names decide; why each choice is there aside.
    let plain = |route: Route| match route {
        Route::Ambiguous {
            prompt,
            candidates,
            brief,
        } => Route::Ambiguous {
            prompt,
            brief,
            candidates: (candidates.into_iter())
                .map(|c| Candidate {
                    why: String::new(),
                    ..c
                })
                .collect(),
        },
        route => route,
    };
    for (text, current, expected) in table {
        let route = plain(by_names(&request(text, current)).unwrap_or(Route::Unknown));
        let wanted = match expected {
            Ok(to) => Route::Clear {
                said: None,
                to,
                brief: text.into(),
            },
            Err(candidates) if candidates.is_empty() => Route::Unknown,
            Err(candidates) => Route::Ambiguous {
                prompt: "Where should this go?".into(),
                candidates,
                brief: None,
            },
        };
        assert_eq!(route, wanted, "{text:?} with {current:?}");
    }
    // An unnamed session is offered under its label.
    let mut r = request("the login fix or the other one", None);
    r.sessions[1].name = Some("other one".into());
    let Route::Ambiguous { candidates, .. } = plain(local(&r)) else {
        panic!("two sessions named")
    };
    assert_eq!(
        candidates,
        [
            choice("Login fix", to(login)),
            choice("other one", to(quiet))
        ]
    );
    // Named nothing, with projects known: the person is asked, never
    // guessed for, with at most three; with none known, it is an idea.
    let Route::Ambiguous { candidates, .. } = local(&request("buy milk", None)) else {
        panic!("asked")
    };
    assert!(!candidates.is_empty() && candidates.len() <= tasktap_core::route::CHOICES);
    let mut none = request("buy milk", None);
    (none.projects, none.sessions) = (Vec::new(), Vec::new());
    assert_eq!(local(&none), Route::Unknown);
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
        said: None,
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
    assert_eq!(th.placed, Some(Placed::Name));

    // Two named: a router question with both.
    let text = "move the code from folio to app";
    let t = capture(&mut w, text, None);
    w.until("the router asks", |m| m.glance().question.is_some());
    let q = w.model.question(w.model.glance().question.unwrap()).clone();
    assert_eq!((q.thought_id, q.source), (Some(t), QuestionSource::Router));
    // The longer name first, each with why it is a choice.
    assert_eq!(
        q.kind,
        QuestionKind::Choice {
            choices: vec!["folio".into(), "app".into()]
        }
    );
    assert_eq!(
        q.notes,
        Some(vec!["named in it".into(), "named in it".into()])
    );
    // What each choice is, so no page tells a folder from a session by its name.
    let places = vec![
        tasktap_proto::Place::Project(folio),
        tasktap_proto::Place::Project(app),
    ];
    assert_eq!(q.places, Some(places));
    assert_eq!(w.model.status(t), Status::NeedsYou);
    let tasktap_proto::Route::Ambiguous { candidates, .. } = hint(&mut w, text, None) else {
        panic!("the hint is ambiguous too")
    };
    assert_eq!(candidates.len(), 2);

    // Nothing named: the person is asked where it goes, never guessed for,
    // and "Keep for later" keeps it; the hint says nothing is named.
    let t = capture(&mut w, "buy milk", None);
    assert_eq!(w.model.thought(t).status, Status::NeedsYou);
    let q = (w.model.questions.values())
        .find(|q| q.thought_id == Some(t) && q.state == QuestionState::Open)
        .unwrap()
        .clone();
    w.ok::<call::QuestionAnswer>(&tasktap_proto::AnswerQuestion {
        id: q.id,
        response: Response::Deny,
    });
    let th = w.model.thought(t);
    assert_eq!((th.status, th.mode), (Status::Captured, Mode::Note));
    assert_eq!(th.placed, Some(Placed::KeptAnswer));
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
    assert_eq!(w.model.thought(run).placed, Some(Placed::Picked));
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
    assert_eq!(th.placed, Some(Placed::FollowUp));
    let elsewhere = "and add tests to folio";
    let t = capture(&mut w, elsewhere, Some(session));
    let th = w.model.thought(t);
    assert_eq!(
        (th.status, th.project_id, th.session_id),
        (Status::Routed, Some(folio), None)
    );
    assert_eq!(th.placed, Some(Placed::Name));
    core.stop();
}

#[test]
fn the_longest_name_said_wins_and_names_said_alike_are_a_choice() {
    // Near-duplicate names, as core/scripts/place-eval.json has them, with
    // the words of a name joined by hyphens, underscores and spaces.
    let names = [
        "tidepool",
        "tidepool-mobile",
        "tidepool-mobile-api",
        "ledgerline",
        "ledger-api",
        "lumenbox",
        "lumenbox_firmware",
        "kiln",
        "kiln themes",
        "cuegrid-web",
        "cuegrid_web",
    ];
    let projects: Vec<Named> = (names.iter())
        .map(|n| Named::open(ProjectId::mint(), n, &[]))
        .collect();
    let id = |name: &str| match projects.iter().find(|p| p.name == name).unwrap().to {
        Destination::New(id) => id,
        _ => unreachable!(),
    };
    // (text, where it goes: Ok for clear, the choices otherwise)
    let table: Vec<(&str, Result<&str, Vec<&str>>)> = vec![
        // The longest name said wins, written as the name joins its parts
        // or joined otherwise, whatever the case; its words written apart
        // are words as well: the name is asked about first, unless they
        // are used as a name ("to kiln themes").
        (
            "tidepool mobile drains the battery while uploading",
            Err(vec!["tidepool-mobile"]),
        ),
        ("tidepool-mobile drains the battery", Ok("tidepool-mobile")),
        (
            "Tidepool  Mobile drains the battery",
            Err(vec!["tidepool-mobile"]),
        ),
        (
            "the tidepool mobile api returns 500",
            Err(vec!["tidepool-mobile-api"]),
        ),
        ("In Tidepool the face grouping merges twins", Ok("tidepool")),
        (
            "ledger api should return 404 for a customer",
            Err(vec!["ledger-api"]),
        ),
        ("in ledger api the invoices return 404", Ok("ledger-api")),
        (
            "ledgerline: the reminder mails go out twice",
            Ok("ledgerline"),
        ),
        (
            "the lumenbox firmware drops frames at 44 hertz",
            Err(vec!["lumenbox_firmware"]),
        ),
        ("lumenbox_firmware drops frames", Ok("lumenbox_firmware")),
        ("lumenbox-firmware drops frames", Ok("lumenbox_firmware")),
        ("add a dark theme to kiln themes", Ok("kiln themes")),
        ("add a dark theme to kiln-themes", Ok("kiln themes")),
        ("kiln builds are slow", Ok("kiln")),
        // The shorter said on its own as well: both are named.
        (
            "tidepool mobile and tidepool both crash on start",
            Err(vec!["tidepool-mobile", "tidepool"]),
        ),
        // Two names said alike: the person chooses, nothing is guessed.
        (
            "cuegrid web has a typo",
            Err(vec!["cuegrid-web", "cuegrid_web"]),
        ),
        // An underscore joins words: a name inside a longer word is none.
        ("fix the tidepool_v2 sync", Err(vec![])),
    ];
    for (text, expected) in table {
        let request = Request {
            text: text.into(),
            projects: projects.clone(),
            ..Request::default()
        };
        let wanted = match expected {
            Ok(name) => Route::Clear {
                said: None,
                to: Destination::New(id(name)),
                brief: text.into(),
            },
            Err(names) if names.is_empty() => Route::Unknown,
            Err(names) => Route::Ambiguous {
                prompt: "Where should this go?".into(),
                candidates: (names.iter())
                    .map(|n| Candidate {
                        why: String::new(),
                        label: (*n).into(),
                        to: Destination::New(id(n)),
                    })
                    .collect(),
                brief: None,
            },
        };
        // The choices it begins with: those named, first.
        let first = match &wanted {
            Route::Ambiguous { candidates, .. } => candidates.len(),
            _ => 0,
        };
        let route = match by_names(&request).unwrap_or(Route::Unknown) {
            Route::Ambiguous {
                prompt,
                candidates,
                brief,
            } => Route::Ambiguous {
                prompt,
                brief,
                candidates: (candidates.into_iter().take(first))
                    .map(|c| Candidate {
                        why: String::new(),
                        ..c
                    })
                    .collect(),
            },
            route => route,
        };
        assert_eq!(route, wanted, "{text:?}");
    }
}

#[test]
fn scratch_is_no_place_a_router_offers() {
    let data = Folder::new("scratch");
    let (mut store, _) = Store::open(&data.0.join("core.db"), time(wall_ms())).unwrap();
    let tx = store.begin().unwrap();
    let r = request(&tx, "start from scratch on the landing page", None).unwrap();
    assert_eq!(r.projects, [], "Scratch is offered to the routers");
    assert_eq!(local(&r), Route::Unknown);
}

#[test]
fn a_normal_build_places_by_the_longest_name_and_never_in_scratch_unless_picked() {
    let data = Folder::new("place");
    let core = Core::with_agents(&data.0);
    let mut w = core.watch();
    let mut add = |path: &str, name: &str| {
        let folder = data.0.join(path);
        std::fs::create_dir_all(&folder).unwrap();
        let add = AddProject {
            id: ProjectId::mint(),
            folder: folder.to_str().unwrap().into(),
            name: Some(name.into()),
        };
        w.ok::<call::ProjectAdd>(&add)
    };
    let (_, mobile) = (
        add("tidepool", "tidepool"),
        add("tidepool-mobile", "tidepool-mobile"),
    );
    let (kiln, other) = (add("a/kiln", "kiln"), add("b/kiln", "kiln"));
    let scratch = (w.model.projects.values())
        .find(|p| p.kind == ProjectKind::Scratch)
        .map(|p| p.id)
        .unwrap();
    // The clock stands still, so a hold never ends.
    w.ok::<call::FixtureClock>(&FixtureClock {
        now: time(wall_ms()),
    });
    let hint = |w: &mut Watch, text: &str, current| {
        let text = text.into();
        w.ok::<call::RouteHint>(&Hint { text, current })
    };
    let capture = |w: &mut Watch, capture: Capture| {
        w.ok::<call::ThoughtCapture>(&Capture {
            agent: Some("fixture".into()),
            ..capture
        });
        capture.id
    };

    // The longest name said wins.
    let text = "tidepool-mobile drains the battery while uploading";
    let clear = tasktap_proto::Route::Clear {
        said: None,
        to: tasktap_proto::Place::Project(mobile),
        brief: text.into(),
    };
    assert_eq!(hint(&mut w, text, None), clear);
    let t = capture(&mut w, typed(ThoughtId::mint(), text));
    let th = w.model.thought(t);
    assert_eq!(
        (th.project_id, th.placed),
        (Some(mobile), Some(Placed::Name))
    );

    // One name two projects have: the router asks, with both.
    let t = capture(&mut w, typed(ThoughtId::mint(), "kiln builds are slow"));
    w.until("the router asks", |m| m.glance().question.is_some());
    let q = w.model.question(w.model.glance().question.unwrap()).clone();
    assert_eq!(q.thought_id, Some(t));
    let mut places = q.places.unwrap();
    places.sort_by_key(|p| format!("{p:?}"));
    let mut both = vec![
        tasktap_proto::Place::Project(kiln),
        tasktap_proto::Place::Project(other),
    ];
    both.sort_by_key(|p| format!("{p:?}"));
    assert_eq!(places, both);

    // The word "scratch" places nothing in Scratch: the person is asked,
    // and Scratch is no choice.
    let text = "start from scratch on the landing page";
    assert_eq!(hint(&mut w, text, None), tasktap_proto::Route::Unknown);
    let t = capture(&mut w, typed(ThoughtId::mint(), text));
    let th = w.model.thought(t);
    assert_eq!((th.project_id, th.status), (None, Status::NeedsYou));
    let q = (w.model.questions.values())
        .find(|q| q.thought_id == Some(t))
        .unwrap();
    let places = q.places.clone().unwrap();
    assert!(!places.contains(&tasktap_proto::Place::Project(scratch)));
    assert!(places.len() <= tasktap_core::route::CHOICES);

    // Picked, Scratch is a place, and a session there is followed up as
    // any other.
    let hold = |w: &mut Watch, seconds| {
        let target = PutTarget::Prefs(PrefPatch::Hold(seconds));
        w.ok::<call::Put>(&Put {
            target,
            if_rev: None,
        });
    };
    hold(&mut w, 0);
    let run = ThoughtId::mint();
    let picked = Capture {
        project_id: Some(scratch),
        ..typed(run, "wait")
    };
    capture(&mut w, picked);
    w.until("the run has a session", |m| {
        m.thoughts[&run].session_id.is_some()
    });
    let th = w.model.thought(run);
    assert_eq!(
        (th.project_id, th.placed),
        (Some(scratch), Some(Placed::Picked))
    );
    let session = th.session_id.unwrap();
    hold(&mut w, 5);
    let text = "and add tests";
    let follow = Capture {
        current: Some(session),
        ..typed(ThoughtId::mint(), text)
    };
    let t = capture(&mut w, follow);
    let th = w.model.thought(t);
    assert_eq!(
        (th.session_id, th.placed),
        (Some(session), Some(Placed::FollowUp))
    );
    core.stop();
}

// Routing by a model (design §8). The acceptance rules are proven as a
// table on the pure function. Everything around them runs in a core whose
// "model" is the fixture agent asked headless: a real process, which keeps
// what it was asked as `route/asked` in the data folder and runs the steps
// a test wrote there as `route/ask`; the last line it prints is its answer.

/// A thought as it is spoken: too long to go on as it is, and naming
/// nothing the match on names knows.
const SPOKEN: &str = "um so the thing with the header, the one we did last week, it wraps on small screens \
    and, well, I want it to stay on one line, don't change the font size though, just let the menu \
    collapse earlier or something like that";

/// A model's answer as its tool prints it.
fn answer(confidence: &str, to: &str, brief: &str) -> Value {
    json!({ "quote": "", "confidence": confidence, "to": to, "candidates": [],
            "brief": brief, "title": "" })
}

#[test]
fn a_models_answer_is_taken_only_as_the_rules_allow() {
    let (tasktap, folio, app) = (ProjectId::mint(), ProjectId::mint(), ProjectId::mint());
    let (login, quiet) = (SessionId::mint(), SessionId::mint());
    let project = |id, name: &str| Named::open(id, name, &[]);
    let session = |id, name: Option<&str>, project| Followed {
        id,
        name: name.map(Into::into),
        project,
        label: "The codex session in folio".into(),
        agent: "codex".into(),
        state: SessionState::Idle,
        thought: None,
        task: String::new(),
    };
    let text = "um, the login fix from before, it still fails on Safari, please look again \
                and don't touch the session cookie, okay";
    let request = Request {
        last: None,
        text: text.into(),
        current: None,
        picked: None,
        projects: vec![
            project(tasktap, "tasktap"),
            project(folio, "folio"),
            project(app, "app"),
        ],
        sessions: vec![
            session(login, Some("Login fix"), tasktap),
            session(quiet, None, folio),
        ],
        recent: Vec::new(),
    };
    let brief = "Look again at why the login fix fails on Safari.";
    let with = |field: &str, value: Value| {
        let mut a = answer("clear", "p2", brief);
        a[field] = value;
        a.to_string()
    };
    let clear = |to, brief: &str| Route::Clear {
        said: None,
        to,
        brief: brief.into(),
    };
    let refused = |r: &Request, answer: String, why: &str| {
        let said = accept(r, &answer).expect_err(&answer);
        assert!(said.contains(why), "{said:?} for {answer}");
    };

    // A new run in a project that was offered, by its key.
    let taken = accept(&request, &answer("clear", "p2", brief).to_string());
    assert_eq!(
        taken,
        Ok((clear(Destination::New(folio), brief), Routing::default()))
    );
    // The brief without the space around it.
    let taken = accept(&request, &with("brief", json!(format!("  {brief}\n"))));
    assert_eq!(
        taken,
        Ok((clear(Destination::New(folio), brief), Routing::default()))
    );

    // A follow-up needs words of the capture that justify it: found word
    // for word, whatever the case and the punctuation, 3 characters at least.
    let follow = |quote: &str| {
        let mut a = answer("clear", "s1", brief);
        a["quote"] = quote.into();
        a.to_string()
    };
    for quote in ["the login fix from before", "The Login-Fix, from BEFORE"] {
        let taken = accept(&request, &follow(quote));
        let to = Destination::Session(login);
        let quoted = Routing {
            quote: Some(quote.into()),
            ..Routing::default()
        };
        assert_eq!(taken, Ok((clear(to, brief), quoted)));
    }
    for quote in ["", "it", "the login bug", "login from before"] {
        refused(&request, follow(quote), "not in the thought");
    }
    // A follow-up to the session the capture was made in needs none.
    let here = Request {
        current: Some(quiet),
        ..request.clone()
    };
    let taken = accept(&here, &answer("clear", "s2", brief).to_string());
    assert_eq!(
        taken,
        Ok((
            clear(Destination::Session(quiet), brief),
            Routing::default()
        ))
    );
    refused(&here, follow(""), "not in the thought");

    // Only what was offered is a destination.
    for to in ["p4", "s3", "p0", "p", "", "x1", "p-1", "folio"] {
        refused(&request, with("to", to.into()), "was not offered");
    }

    // Unsure: at least two different choices, each offered; the brief is
    // kept for wherever the person sends it.
    let choices = |keys: Value| {
        let mut a = answer("ambiguous", "", brief);
        a["candidates"] = keys;
        a.to_string()
    };
    let choice = |label: &str, to| Candidate {
        why: String::new(),
        label: label.into(),
        to,
    };
    assert_eq!(
        accept(&request, &choices(json!(["p3", "s2", "p3", "s1"]))),
        Ok((
            Route::Ambiguous {
                prompt: "Where should this go?".into(),
                candidates: vec![
                    choice("app", Destination::New(app)),
                    choice("The codex session in folio", Destination::Session(quiet)),
                    choice("Login fix", Destination::Session(login)),
                ],
                brief: Some(brief.into()),
            },
            Routing::default()
        ))
    );
    for keys in [json!([]), json!(["p1"]), json!(["p1", "p1"])] {
        refused(&request, choices(keys), "fewer than two choices");
    }
    refused(&request, choices(json!(["p1", "p9"])), "was not offered");

    // Nowhere to send it: an idea, whatever else the answer says.
    let unknown = answer("unknown", "p9", "").to_string();
    assert_eq!(
        accept(&request, &unknown),
        Ok((Route::Unknown, Routing::default()))
    );

    // A brief is there, and no longer than the thought allows.
    refused(&request, with("brief", " \n".into()), "no brief");
    let most = 2 * text.chars().count() + 400;
    let long = |chars: usize| with("brief", "ä".repeat(chars).into());
    assert!(accept(&request, &long(most)).is_ok());
    refused(&request, long(most + 1), "longer than the thought allows");

    // A title is one plain line of at most 60 characters. Another is no
    // title, and the rest of the answer is taken all the same.
    let titled = |title: &str| {
        let (route, found) = accept(&request, &with("title", title.into())).unwrap();
        assert_eq!(route, clear(Destination::New(folio), brief));
        found.title
    };
    assert_eq!(
        titled("  Login fix on Safari\n"),
        Some("Login fix on Safari".into())
    );
    assert_eq!(titled(&"ä".repeat(60)), Some("ä".repeat(60)));
    for title in [
        "",
        "  ",
        &"a".repeat(61),
        "Login fix\non Safari",
        "Login\tfix",
    ] {
        assert_eq!(titled(title), None, "{title:?}");
    }
    // Where it goes nowhere it has none.
    let mut idea = answer("unknown", "", "");
    idea["title"] = "Call the accountant".into();
    assert_eq!(accept(&request, &idea.to_string()).unwrap().1.title, None);

    // Anything but the one object asked for is no answer.
    let mut more = answer("clear", "p2", brief);
    more["agent"] = "claude".into();
    let mut less = answer("clear", "p2", brief);
    less.as_object_mut().unwrap().remove("quote");
    for malformed in [
        "".into(),
        "not json".into(),
        "[]".into(),
        format!("Here it is: {}", answer("clear", "p2", brief)),
        more.to_string(),
        less.to_string(),
        with("confidence", "sure".into()),
        with("candidates", "p1".into()),
        with("brief", json!(null)),
        with("title", json!(["Login fix"])),
        with("constraints", json!([])),
    ] {
        refused(&request, malformed, "not the JSON it was asked for");
    }
    refused(
        &request,
        with("quote", "x".repeat(64 << 10).into()),
        "too large",
    );

    // Where the person picked the destination only the brief and the
    // title are taken.
    let picked = Request {
        picked: Some(Destination::New(app)),
        ..request.clone()
    };
    for confidence in ["clear", "ambiguous", "unknown"] {
        let taken = accept(&picked, &answer(confidence, "s1", brief).to_string());
        assert_eq!(
            taken,
            Ok((clear(Destination::New(app), brief), Routing::default()))
        );
    }
    refused(&picked, answer("clear", "p3", "").to_string(), "no brief");
}

#[test]
fn a_short_thought_goes_on_as_it_is_and_a_brief_in_the_same_words_adds_nothing() {
    assert!(short("Run the tests in kiln and fix whatever fails."));
    assert!(short(&"a".repeat(160)));
    assert!(!short(&"a".repeat(161)));
    assert!(!short("first this\nthen that"));
    assert!(same("Fix the build.", "fix the build"));
    assert!(same("  Fix,   the BUILD!", "fix the build"));
    assert!(!same("Fix the build", "fix the builds"));
    assert!(!same("Fix the build", "the build fix"));
}

/// A core whose router may ask the fixture agent's tool, with two projects.
struct Asking {
    core: Core,
    w: Watch,
    data: Folder,
    app: ProjectId,
    folio: ProjectId,
}

impl Asking {
    fn new(prefix: &str) -> Asking {
        let data = Folder::new(prefix);
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
        std::fs::create_dir_all(data.0.join("route")).unwrap();
        let mut asking = Asking {
            core,
            w,
            data,
            app,
            folio,
        };
        asking.freeze();
        asking
    }

    /// The clock stands still, so a hold never ends by itself.
    fn freeze(&mut self) {
        let now = time(wall_ms());
        self.w.ok::<call::FixtureClock>(&FixtureClock { now });
    }

    fn pref(&mut self, patch: PrefPatch) -> Result<tasktap_proto::Revision, tasktap_proto::Error> {
        let target = PutTarget::Prefs(patch);
        self.w.call::<call::Put>(&Put {
            target,
            if_rev: None,
        })
    }

    /// The person consents to routing by the fixture agent's model.
    fn consent(&mut self, agent: &str) {
        let by = RouteBy {
            terms: tasktap_core::route::TERMS,
            agent: agent.into(),
            model: "fixture-small".into(),
        };
        self.pref(PrefPatch::RouteBy(Some(by))).unwrap();
    }

    fn file(&self, name: &str) -> std::path::PathBuf {
        self.data.0.join("route").join(name)
    }

    /// The steps the tool runs when it is asked next.
    fn script(&self, steps: &[String]) {
        std::fs::write(self.file("ask"), steps.join("\n")).unwrap();
    }

    /// The tool answers with this.
    fn answers(&self, answer: &Value) {
        self.script(&[format!("print:{answer}")]);
    }

    /// The request the tool was last asked with, and forgets it.
    fn asked(&self) -> Option<Value> {
        let asked = std::fs::read_to_string(self.file("asked")).ok()?;
        std::fs::remove_file(self.file("asked")).unwrap();
        assert!(asked.starts_with(tasktap_core::route::INSTRUCTIONS));
        let request = asked.split("<request>\n").nth(1).unwrap();
        let request = request.trim_end().trim_end_matches("</request>");
        Some(serde_json::from_str(request).unwrap())
    }

    fn capture(&mut self, text: &str, pick: Option<ProjectId>) -> ThoughtId {
        let id = ThoughtId::mint();
        let capture = Capture {
            agent: Some("fixture".into()),
            project_id: pick,
            ..typed(id, text)
        };
        self.w.ok::<call::ThoughtCapture>(&capture);
        id
    }

    /// The thought once nobody is asked about it any more.
    fn settled(&mut self, id: ThoughtId) -> Thought {
        self.w.until("the router has answered", |m| {
            !m.thought(id).route.as_ref().is_some_and(|r| r.pending)
        });
        self.w.model.thought(id).clone()
    }
}

#[test]
fn a_model_routes_a_thought_and_writes_its_brief() {
    let mut a = Asking::new("model");
    a.consent("fixture");
    // The newest project is the first it is offered.
    let mut said = answer(
        "clear",
        "p1",
        "Keep the header on one line on small screens.",
    );
    said["title"] = "Header on one line".into();
    a.answers(&said);
    let t = a.capture(SPOKEN, None);
    // Captured, and marked as asked about, until the answer is in.
    let asked = a.w.model.thought(t).clone();
    let route = asked.route.unwrap();
    assert_eq!(
        (
            asked.status,
            route.by.as_str(),
            route.model.as_deref(),
            route.pending
        ),
        (Status::Captured, "fixture", Some("fixture-small"), true)
    );
    let th = a.settled(t);
    assert_eq!(
        (th.status, th.project_id, th.mode),
        (Status::Routed, Some(a.folio), Mode::Ask)
    );
    assert_eq!(th.placed, Some(Placed::Model));
    // The brief, as the model wrote it, to read during the hold, which
    // counts from the capture.
    assert_eq!(
        th.brief.as_deref(),
        Some("Keep the header on one line on small screens.")
    );
    assert_eq!(th.hold_until, Some(time(th.created.get() + 5000)));
    let route = th.route.unwrap();
    assert_eq!(
        (
            route.by.as_str(),
            route.model.as_deref(),
            route.pending,
            route.fallback
        ),
        ("fixture", Some("fixture-small"), false, None)
    );
    assert!(route.ms.is_some());
    assert_eq!(route.title.as_deref(), Some("Header on one line"));
    // What it was sent: the thought, and the projects under short keys.
    let sent = a.asked().unwrap();
    assert_eq!(sent["thought"], SPOKEN);
    let names: Vec<_> = (sent["projects"].as_array().unwrap().iter())
        .map(|p| (p["id"].as_str().unwrap(), p["name"].as_str().unwrap()))
        .collect();
    assert_eq!(names[..2], [("p1", "folio"), ("p2", "app")]);
    assert_eq!(
        (&sent["current"], &sent["picked"]),
        (&json!(null), &json!(null))
    );
    assert!(!sent.to_string().contains(&a.folio.uuid().to_string()));

    // A short thought the match on names is sure of is not sent anywhere.
    let t = a.capture("fix the header in folio", None);
    let th = a.settled(t);
    assert_eq!((th.status, th.project_id), (Status::Routed, Some(a.folio)));
    assert_eq!(th.route.unwrap().by, "local");
    assert_eq!(a.asked(), None);
}

#[test]
fn whatever_goes_wrong_with_the_model_the_match_on_names_routes_and_says_why() {
    let mut a = Asking::new("fallback");
    a.consent("fixture");
    // Long, and naming a project: the match on names sends it there.
    let text = format!("{SPOKEN}, that is in folio by the way");
    let mut extra = answer("clear", "p1", "Brief.");
    extra["agent"] = "claude".into();
    let failures: Vec<(Vec<String>, &str)> = vec![
        // No answer at all, with or without a failing exit.
        (
            vec!["print:Sorry, I cannot help with that.".into()],
            "it printed no answer",
        ),
        (vec!["exit:3".into()], "it printed no answer"),
        // The tool says why it failed.
        (
            vec!["print:error:the model is overloaded".into()],
            "the model is overloaded",
        ),
        // An answer the rules refuse.
        (
            vec![format!("print:{}", answer("clear", "p1", ""))],
            "it wrote no brief",
        ),
        (
            vec![format!("print:{extra}")],
            "not the JSON it was asked for",
        ),
        (
            vec![format!("print:{}", "x".repeat(70 << 10))],
            "its answer is too large",
        ),
    ];
    for (steps, why) in failures {
        a.script(&steps);
        let t = a.capture(&text, None);
        let th = a.settled(t);
        assert_eq!(
            (th.status, th.project_id, th.brief.as_deref()),
            (Status::Routed, Some(a.folio), Some(text.as_str())),
            "{why}"
        );
        let route = th.route.unwrap();
        let fallback = route.fallback.unwrap_or_default();
        assert_eq!((route.by.as_str(), route.model), ("local", None), "{why}");
        assert!(
            fallback.starts_with("fixture: ") && fallback.contains(why),
            "{fallback:?} for {why}"
        );
        assert!(a.asked().is_some(), "{why}");
    }
    // No steps to run stands for a tool that is broken.
    std::fs::remove_file(a.file("ask")).unwrap();
    let t = a.capture(&text, None);
    let route = a.settled(t).route.unwrap();
    assert!(route.fallback.unwrap().contains("no steps in ask"));
    // Without a place the match on names knows, the person is asked.
    for (steps, why) in [
        (vec!["exit:1".into()], "it printed no answer"),
        (
            vec![format!("print:{}", answer("clear", "p9", "Brief."))],
            "was not offered",
        ),
    ] {
        a.script(&steps);
        let t = a.capture(SPOKEN, None);
        let th = a.settled(t);
        assert_eq!((th.status, th.mode), (Status::NeedsYou, Mode::Ask));
        assert!(th.route.unwrap().fallback.unwrap().contains(why), "{why}");
    }
}

#[test]
fn a_tool_that_no_longer_offers_its_model_says_so_and_is_not_asked_again() {
    let mut a = Asking::new("gone");
    a.consent("fixture");
    a.script(&["print:error:no such model".into()]);
    let text = format!("{SPOKEN}, that is in folio by the way");
    let gone = "Fixture agent no longer offers the model Tasktap asks for placing; \
                placing by name until Tasktap is updated";
    let t = a.capture(&text, None);
    let th = a.settled(t);
    assert_eq!((th.status, th.project_id), (Status::Routed, Some(a.folio)));
    let route = th.route.unwrap();
    assert_eq!(
        (route.by.as_str(), route.fallback.as_deref()),
        ("local", Some(gone))
    );
    assert!(a.asked().is_some());
    // It is not asked again while this core runs, whatever it would answer.
    a.answers(&answer("clear", "p2", "Brief."));
    let t = a.capture(&text, None);
    let th = a.settled(t);
    assert_eq!((th.status, th.project_id), (Status::Routed, Some(a.folio)));
    assert_eq!(th.route.unwrap().fallback.as_deref(), Some(gone));
    assert_eq!(a.asked(), None);
    // Nor is it offered for consent; the other agents are.
    let terms = a.w.ok::<call::RouteTerms>(&tasktap_proto::Empty {});
    let offered: Vec<_> = terms.tools.iter().map(|t| t.agent.as_str()).collect();
    assert!(!offered.contains(&"fixture"), "{offered:?}");
    assert!(offered.contains(&"fixture-silent") && offered.contains(&"codex"));
}

#[test]
fn a_model_that_takes_too_long_is_stopped_and_the_match_on_names_routes() {
    let mut a = Asking::new("timeout");
    // The silent fixture agent's tool gets one second.
    a.consent("fixture-silent");
    let mut steps = vec!["write:began:1".into(), "sleep:4000".into()];
    steps.extend([
        "write:ended:1".into(),
        format!("print:{}", answer("clear", "p2", "Brief.")),
    ]);
    a.script(&steps);
    let text = format!("{SPOKEN}, that is in folio by the way");
    let began = std::time::Instant::now();
    let t = a.capture(&text, None);
    let th = a.settled(t);
    assert!(began.elapsed() < std::time::Duration::from_millis(3500));
    assert_eq!((th.status, th.project_id), (Status::Routed, Some(a.folio)));
    let route = th.route.unwrap();
    assert_eq!(
        (route.by.as_str(), route.fallback.as_deref()),
        (
            "local",
            Some("fixture-silent: it did not answer within 1 s")
        )
    );
    // The tool was ended, not left to finish. Installed as a batch file it
    // is what the command prompt ran: ended with the prompt, at once. (Its
    // one second is the prompt's too, which on a slow machine can use it up
    // before the tool begins.)
    assert!(as_batch_files() || a.file("began").exists());
    #[cfg(windows)]
    if as_batch_files() {
        let tool = batch_file(&agents(&a.data.0), "fixture-agent");
        let ended = std::time::Instant::now();
        while runs(&tool) {
            let why = "the tool behind the batch file runs on";
            assert!(ended.elapsed() < std::time::Duration::from_secs(2), "{why}");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    std::thread::sleep(std::time::Duration::from_millis(3500));
    assert!(!a.file("ended").exists());
}

#[test]
fn undo_while_a_model_is_asked_stops_its_tool() {
    let mut a = Asking::new("undo");
    a.consent("fixture");
    let mut steps = vec!["write:began:1".into(), "sleep:1500".into()];
    steps.extend([
        "write:ended:1".into(),
        format!("print:{}", answer("clear", "p1", "Brief.")),
    ]);
    a.script(&steps);
    let t = a.capture(SPOKEN, None);
    let began = a.file("began");
    for _ in 0..500 {
        if began.exists() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(began.exists(), "the tool was started");
    // While it is asked the thought is not to be edited.
    let put = Put {
        target: PutTarget::Thoughts {
            id: t,
            patch: tasktap_proto::NotePatch {
                text: Some("something else".into()),
                strokes: None,
            },
        },
        if_rev: None,
    };
    assert_eq!(
        a.w.refused::<call::Put>(&put).code,
        tasktap_proto::Code::Invalid
    );
    a.w.ok::<call::ThoughtStop>(&tasktap_proto::Ref { id: t });
    let th = a.w.model.thought(t).clone();
    let route = th.route.unwrap();
    assert_eq!(
        (th.status, route.pending, route.fallback.as_deref()),
        (Status::Captured, false, Some("it was undone"))
    );
    // The tool is ended at once, and its answer never arrives.
    std::thread::sleep(std::time::Duration::from_millis(2500));
    assert!(!a.file("ended").exists());
    a.w.sync();
    let th = a.w.model.thought(t).clone();
    assert_eq!(
        (th.status, th.project_id, th.brief),
        (Status::Captured, None, None)
    );
    // Undone, it is the person's to edit again.
    a.w.ok::<call::Put>(&put);
}

#[test]
fn with_a_model_what_the_match_on_names_finds_it_places_and_the_model_only_briefs() {
    let mut a = Asking::new("named");
    a.consent("fixture");
    // Long and naming folio: placed there by name at once, though the model
    // would send it elsewhere; only its brief is taken.
    a.answers(&answer("clear", "p2", "Keep the header on one line."));
    let text = format!("{SPOKEN}, that is in folio by the way");
    let t = a.capture(&text, None);
    let th = a.settled(t);
    assert_eq!(
        (th.status, th.project_id, th.placed),
        (Status::Routed, Some(a.folio), Some(Placed::Name))
    );
    assert_eq!(th.brief.as_deref(), Some("Keep the header on one line."));
    assert_eq!(th.route.unwrap().by, "fixture");
    assert_eq!(a.asked().unwrap()["picked"], "p1");
    // Naming two: the person is asked which, and no model places it.
    a.answers(&answer("clear", "p2", "Brief."));
    let t = a.capture(&format!("{SPOKEN}, in folio or in app"), None);
    a.w.until("the router asks", |m| m.glance().question.is_some());
    let q =
        a.w.model
            .question(a.w.model.glance().question.unwrap())
            .clone();
    assert_eq!((q.thought_id, q.source), (Some(t), QuestionSource::Router));
    assert_eq!(q.places.map(|p| p.len()), Some(2));
    assert_eq!(a.asked(), None);
}

#[test]
fn an_ambiguous_answer_asks_the_person_and_their_choice_routes_the_thought() {
    let mut a = Asking::new("ambiguous");
    a.consent("fixture");
    let mut said = answer("ambiguous", "", "Keep the header on one line.");
    said["candidates"] = json!(["p2", "p1"]);
    a.answers(&said);
    let t = a.capture(SPOKEN, None);
    a.w.until("the router asks", |m| m.glance().question.is_some());
    let q =
        a.w.model
            .question(a.w.model.glance().question.unwrap())
            .clone();
    assert_eq!((q.thought_id, q.source), (Some(t), QuestionSource::Router));
    assert_eq!(
        q.kind,
        QuestionKind::Choice {
            choices: vec!["app".into(), "folio".into()]
        }
    );
    // The brief is there to read with the question.
    let th = a.w.model.thought(t).clone();
    assert_eq!(
        (th.status, th.brief.as_deref()),
        (Status::NeedsYou, Some("Keep the header on one line."))
    );
    assert!(a.asked().is_some());
    // Their answer routes it; nobody is asked again.
    let choice = tasktap_proto::Response::Choice { choice: 1 };
    a.w.ok::<call::QuestionAnswer>(&tasktap_proto::AnswerQuestion {
        id: q.id,
        response: choice,
    });
    let th = a.settled(t);
    assert_eq!(
        (th.status, th.project_id, th.brief.as_deref()),
        (
            Status::Routed,
            Some(a.folio),
            Some("Keep the header on one line.")
        )
    );
    assert_eq!(th.placed, Some(Placed::Answer));
    assert_eq!(a.asked(), None);
}

#[test]
fn a_destination_the_person_picked_is_never_routed_by_the_model_only_briefed() {
    let mut a = Asking::new("picked");
    a.consent("fixture");
    // Short: it goes on as it is, and nobody is asked.
    let t = a.capture("fix the header", Some(a.app));
    let th = a.w.model.thought(t).clone();
    assert_eq!(
        (th.status, th.project_id, th.brief, th.route),
        (Status::Routed, Some(a.app), None, None)
    );
    // Spoken: routed at once to where the person said. The model writes
    // the brief; where it would have sent the thought counts for nothing.
    a.answers(&answer("clear", "p1", "Keep the header on one line."));
    let t = a.capture(SPOKEN, Some(a.app));
    assert_eq!(a.w.model.thought(t).status, Status::Routed);
    let th = a.settled(t);
    assert_eq!(
        (th.status, th.project_id, th.brief.as_deref()),
        (
            Status::Routed,
            Some(a.app),
            Some("Keep the header on one line.")
        )
    );
    assert_eq!(th.route.unwrap().by, "fixture");
    let sent = a.asked().unwrap();
    // The key of the folder picked, wherever the ranking put it.
    let app = (sent["projects"].as_array().unwrap().iter())
        .position(|p| p["name"] == "app")
        .unwrap();
    assert_eq!(sent["picked"], format!("p{}", app + 1));
    assert_eq!(a.asked(), None);
    // A model that fails leaves the person's words as they are.
    a.script(&["exit:1".into()]);
    let t = a.capture(SPOKEN, Some(a.app));
    let th = a.settled(t);
    assert_eq!(
        (th.status, th.project_id, th.brief.as_deref()),
        (Status::Routed, Some(a.app), Some(SPOKEN))
    );
    assert!(th.route.unwrap().fallback.is_some());
    // Undone and given other words, it has no brief: that was of the old ones.
    a.w.ok::<call::ThoughtStop>(&tasktap_proto::Ref { id: t });
    let patch = tasktap_proto::NotePatch {
        text: Some("fix the footer instead".into()),
        strokes: None,
    };
    a.w.ok::<call::Put>(&Put {
        target: PutTarget::Thoughts { id: t, patch },
        if_rev: None,
    });
    let th = a.w.model.thought(t).clone();
    assert_eq!(
        (th.status, th.brief, th.route),
        (Status::Captured, None, None)
    );
}

#[test]
fn a_picked_thought_launches_once_its_hold_has_ended_and_its_brief_is_in() {
    let mut a = Asking::new("both");
    a.consent("fixture");
    a.pref(PrefPatch::Hold(0)).unwrap();
    let mut steps = vec!["sleep:700".into()];
    steps.push(format!("print:{}", answer("clear", "p1", "wait")));
    a.script(&steps);
    let t = a.capture(SPOKEN, Some(a.app));
    // The hold is over at once; the brief is not in: nothing runs yet.
    let th = a.w.model.thought(t).clone();
    assert_eq!((th.status, th.session_id), (Status::Routed, None));
    assert!(th.route.unwrap().pending);
    // The brief arrives: it starts, told the brief.
    a.w.until("the run has its terminal", |m| {
        let session = m.thought(t).session_id;
        session.is_some_and(|s| m.session(s).terminal_id.is_some())
    });
    let th = a.w.model.thought(t).clone();
    assert_eq!(
        (th.status, th.brief.as_deref()),
        (Status::Working, Some("wait"))
    );
    let terminal =
        a.w.model
            .session(th.session_id.unwrap())
            .terminal_id
            .unwrap();
    assert_eq!(a.w.model.terminals[&terminal].argv.last().unwrap(), "wait");
}

#[test]
fn no_model_is_asked_without_the_persons_consent_for_what_this_core_would_ask() {
    let mut a = Asking::new("consent");
    // `route.terms` says what is sent and to whom, before any consent.
    let terms = a.w.ok::<call::RouteTerms>(&tasktap_proto::Empty {});
    assert_eq!(terms.instructions, tasktap_core::route::INSTRUCTIONS);
    assert!(
        terms
            .instructions
            .contains("Add nothing the person did not say")
    );
    assert_eq!(terms.sends.len(), 4);
    // In the words the interface uses (docs/projects-design.md, "Words"):
    // projects, and nothing is "routed".
    assert_eq!(
        terms.sends[1],
        "of up to 8 of your projects, those this Mac ranks likeliest: the name, the other names it goes by and one line about it"
    );
    let said = terms.sends.join(" ").to_lowercase();
    for word in ["folder", "repositor", "rout"] {
        assert!(!said.contains(word), "{word} in {said}");
    }
    let tool = |agent: &str, model: &str| RouteBy {
        terms: tasktap_core::route::TERMS,
        agent: agent.into(),
        model: model.into(),
    };
    assert_eq!(
        terms.tools[..2],
        [tool("claude", "haiku"), tool("codex", "gpt-6-luna")]
    );
    assert!(terms.tools.contains(&tool("fixture", "fixture-small")));

    a.answers(&answer("clear", "p2", "Brief."));
    let text = format!("{SPOKEN}, that is in folio by the way");
    let local = |a: &mut Asking| {
        let t = a.capture(&text, None);
        let th = a.settled(t);
        assert_eq!((th.status, th.project_id), (Status::Routed, Some(a.folio)));
        let route = th.route.unwrap();
        assert_eq!((route.by.as_str(), route.fallback), ("local", None));
        assert_eq!(a.asked(), None);
    };
    // None given: the match on names, and nothing leaves the core.
    local(&mut a);
    // A consent names an agent this core has and the model it would ask.
    for by in [
        tool("fixture", "another-model"),
        tool("nobody", "fixture-small"),
    ] {
        let refused = a.pref(PrefPatch::RouteBy(Some(by))).unwrap_err();
        assert_eq!(refused.code, tasktap_proto::Code::Invalid);
    }
    local(&mut a);
    // Given, the model is asked (of a thought that names its folder, only
    // for the brief); cleared, the match on names again.
    a.consent("fixture");
    let t = a.capture(&text, None);
    let th = a.settled(t);
    assert_eq!(
        (th.project_id, th.brief.as_deref()),
        (Some(a.folio), Some("Brief."))
    );
    assert!(a.asked().is_some());
    a.pref(PrefPatch::RouteBy(None)).unwrap();
    local(&mut a);
    a.consent("fixture");
    a.w.ok::<call::Delete>(&tasktap_proto::Delete::Prefs {
        id: tasktap_proto::PrefKey::RouteBy,
    });
    local(&mut a);
}

#[test]
fn a_core_that_stops_while_a_model_is_asked_asks_nobody_again_and_launches_nothing() {
    let mut a = Asking::new("crash");
    a.consent("fixture");
    // One thought whose answer is in and whose hold runs, one still asked.
    a.pref(PrefPatch::Hold(600)).unwrap();
    a.answers(&answer("clear", "p1", "Keep the header on one line."));
    let routed = a.capture(SPOKEN, None);
    assert_eq!(a.settled(routed).status, Status::Routed);
    assert!(a.asked().is_some());
    a.script(&["sleep:5000".into()]);
    let asked = a.capture(SPOKEN, None);
    assert!(a.w.model.thought(asked).route.as_ref().unwrap().pending);
    for _ in 0..500 {
        if a.file("asked").exists() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    // The core ends as in a crash, and starts again on the same folder.
    let Asking {
        core,
        w,
        data,
        app,
        folio,
    } = a;
    drop((w, core));
    std::fs::remove_file(data.0.join("route/asked")).unwrap();
    let core = Core::with_agents(&data.0);
    let w = core.watch();
    let mut a = Asking {
        core,
        w,
        data,
        app,
        folio,
    };
    // Routed, with its brief and no hold; captured, and no longer asked.
    let th = a.w.model.thought(routed).clone();
    assert_eq!(
        (th.status, th.hold_until, th.brief.as_deref(), th.session_id),
        (
            Status::Routed,
            None,
            Some("Keep the header on one line."),
            None
        )
    );
    let th = a.w.model.thought(asked).clone();
    let route = th.route.unwrap();
    assert_eq!(
        (th.status, route.pending, route.fallback.as_deref()),
        (
            Status::Captured,
            false,
            Some("Tasktap stopped while it was asked")
        )
    );
    // Nothing was asked again and nothing started.
    std::thread::sleep(std::time::Duration::from_millis(300));
    a.w.sync();
    assert!(!a.file("asked").exists());
    assert!(a.w.model.sessions.is_empty());
    // The person starts the routed one: it runs once.
    let attempt = tasktap_proto::AttemptId::mint();
    let start = tasktap_proto::Start {
        id: routed,
        attempt,
    };
    a.w.ok::<call::ThoughtStart>(&start);
    a.w.until("the run has its terminal", |m| {
        m.sessions.values().any(|s| s.terminal_id.is_some())
    });
    // The same start again answers as the first did and starts nothing.
    a.w.ok::<call::ThoughtStart>(&start);
    a.w.sync();
    assert_eq!(a.w.model.sessions.len(), 1);
}
