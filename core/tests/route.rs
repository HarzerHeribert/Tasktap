//! Routing (design §8): the local router, which matches the words of a
//! capture against the names and aliases of the core's own projects and
//! sessions with no model call. Its rules are proven as a table on the pure
//! function; a normal build routes with it and answers `route.hint` with the
//! same match.

mod common;

use common::*;
use serde_json::{Value, json};
use tasktap_core::route::{
    CHOICES, Followed, Lexicon, Named, Request, accept, by_names, fill, finds, likely, local,
    offered, order, ranked, request, same, short, unsure,
};
use tasktap_core::state::{Candidate, Destination, Route};
use tasktap_core::store::Store;
use tasktap_proto::{
    AddProject, Capture, FixtureClock, Hint, Mode, Pays, Placed, Placer, PrefPatch, ProjectId,
    ProjectKind, ProjectPatch, Put, PutTarget, QuestionKind, QuestionSource, QuestionState,
    Response, RouteBy, Routing, SessionId, SessionState, Status, Thought, ThoughtId, call,
};

#[test]
fn the_local_router_follows_its_table() {
    let (tasktap, folio, app) = (ProjectId::mint(), ProjectId::mint(), ProjectId::mint());
    let (login, quiet) = (SessionId::mint(), SessionId::mint());
    let project = |id, name: &str, aliases: &[&str]| Named::open(id, name, aliases);
    let request = |text: &str, current| Request {
        last: None,
        scratch: None,
        words: Default::default(),
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
                first: String::new(),
                summary: String::new(),
                ago: None,
                asks: false,
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
                first: String::new(),
                summary: String::new(),
                ago: None,
                asks: false,
            },
        ],
        view: None,
        earlier: Vec::new(),
        top: Vec::new(),
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
                prompt: "Which project is this task for?".into(),
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
    // guessed for, with what its words name or describe (here nothing); with
    // none known, where the agent should work.
    let Route::Ambiguous { candidates, .. } = local(&request("buy milk", None)) else {
        panic!("asked")
    };
    assert_eq!(candidates, []);
    let mut none = request("buy milk", None);
    (none.projects, none.sessions) = (Vec::new(), Vec::new());
    let Route::Ambiguous { prompt, .. } = local(&none) else {
        panic!("asked")
    };
    assert_eq!(prompt, "Where should the agent work?");
}

#[test]
fn one_project_that_clearly_leads_starts_the_thought_and_a_near_miss_asks_with_it_first() {
    let card = |name: &str, about: &str| Named {
        to: Destination::Card(tasktap_proto::CardId::mint()),
        name: name.into(),
        aliases: Vec::new(),
        about: about.into(),
        folder: format!("/home/someone/projects/{name}"),
        used: None,
    };
    let projects = vec![
        card(
            "vexa-widgets",
            "The vexa widgetpack: the widgets we ship and their settings",
        ),
        card("vexa-notes", "Notes on vexa prompts and sessions"),
        card(
            "vexa-snippets",
            "Snippets and slash commands for the vexa agent",
        ),
        card("zentrix-sync", "Syncs zentrix boards to a shared calendar"),
        card("codex-relay", "Relays codex sessions into a tmux pane"),
        card("harbormaster", "Deploys containers to a small fleet"),
        card("cuegrid", "Cue sheets and a rehearsal timer"),
        card("notes", ""),
        card("tmux-layouts", "Window layouts and key bindings for tmux"),
    ];
    let words = tasktap_core::route::Lexicon(vec![
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/words.txt"),
    ]);
    let request = |text: &str| Request {
        text: text.into(),
        projects: projects.clone(),
        words: words.clone(),
        ..Request::default()
    };
    let to = |name: &str| projects.iter().find(|p| p.name == name).unwrap().to;
    // No name said for certain, and one project has what no other has:
    // its whole name nearly said, with a word made up for it, and one thing
    // more. It starts there, saying why; a model the person agreed to is
    // still asked first.
    for (text, name, why, words) in [
        (
            "research a new vexa widget to add to the vexa widgetpack",
            "vexa-widgets",
            "its name and “widgetpack”",
            Some("vexa widget"),
        ),
        (
            "the vexa note about prompts is out of date",
            "vexa-notes",
            "its name and “prompts”",
            Some("vexa note"),
        ),
        // One other project's line has one word of it ("snippets"), and no
        // more: the person's own trial had such a word.
        (
            "write a new vexa widget for the widgetpack that adds snippets",
            "vexa-widgets",
            "its name and “widgetpack”",
            Some("vexa widget"),
        ),
    ] {
        let r = request(text);
        let led = tasktap_core::state::Said::Leads {
            why: why.into(),
            words: words.map(Into::into),
        };
        let wanted = Route::Clear {
            to: to(name),
            brief: text.into(),
            said: Some(led),
        };
        assert_eq!(local(&r), wanted, "{text}");
    }
    // A near miss asks, with the one most pointed at first.
    for (text, first) in [
        // Its name alone; its line alone.
        ("look into the vexa widget list", "vexa-widgets"),
        ("the vexa widgetpack crashes on start", "vexa-widgets"),
        // Another project has more: two words only its line has, or a word
        // only its name has; or two others have one each.
        (
            "research a new vexa widget for the widgetpack and the slash commands",
            "vexa-widgets",
        ),
        (
            "research a new vexa widget for the widgetpack and the zentrix one",
            "vexa-widgets",
        ),
        (
            "research a new vexa widget for the widgetpack, its snippets and the tmux pane",
            "vexa-widgets",
        ),
        // Another project's name is said, in whatever way.
        (
            "the harbor master wants a new vexa widget for the widgetpack",
            "vexa-widgets",
        ),
        // A word only its name has, however much else fits: never a lead.
        ("the zentrix calendar is wrong", "zentrix-sync"),
        (
            "the zentrix boards show up twice in the calendar",
            "zentrix-sync",
        ),
        // A tool's name is no word made up for a name: "tmux layout" is
        // ordinary words, as a thought about tmux says them.
        (
            "the tmux layout keeps resetting the window splits",
            "tmux-layouts",
        ),
        // A name said in ordinary words only, or only as it sounds.
        ("the harbor masters want the fleet list", "harbormaster"),
        ("in queue grid the rehearsal timer is off", "cuegrid"),
        // An agent's name counts for nothing: the thought may be for it.
        ("ask codex to fix the tmux pane resize", "codex-relay"),
    ] {
        match local(&request(text)) {
            Route::Ambiguous { candidates, .. } => {
                assert_eq!(candidates[0].to, to(first), "{text}: {candidates:?}")
            }
            other => panic!("{text}: {other:?}"),
        }
    }
    // Two projects with something only each has: both are asked about.
    let Route::Ambiguous { candidates, .. } =
        local(&request("a vexa widget for the zentrix calendar"))
    else {
        panic!("asked")
    };
    let first: Vec<Destination> = candidates.iter().take(2).map(|c| c.to).collect();
    assert!(first.contains(&to("vexa-widgets")) && first.contains(&to("zentrix-sync")));
    // A name written whole inside another's name nearly said decides
    // nothing: both are asked about, the longer first.
    let mut r = request("the zentrix syncs drop the last board");
    r.projects.push(card("zentrix", ""));
    let Route::Ambiguous { candidates, .. } = local(&r) else {
        panic!("asked")
    };
    let zentrix = r.projects.last().unwrap().to;
    let first: Vec<Destination> = candidates.iter().take(2).map(|c| c.to).collect();
    assert_eq!(first, [to("zentrix-sync"), zentrix]);
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
            create: false,
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
        w.ok::<call::RouteHint>(&Hint {
            text,
            current,
            view: None,
        })
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
    // A name is its own reason: nothing is said after it.
    assert_eq!(q.notes, Some(vec![String::new(), String::new()]));
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
            // The words of the language as this check knows them, the same on every system.
            words: tasktap_core::route::Lexicon(vec![
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/fixtures/words.txt"),
            ]),
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
                prompt: "Which project is this task for?".into(),
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
fn a_question_offers_only_projects_the_words_name_or_clearly_describe() {
    let (earshot, tapped, mods) = (ProjectId::mint(), ProjectId::mint(), ProjectId::mint());
    let project = |id, name: &str, about: &str, used| Named {
        about: about.into(),
        used,
        ..Named::open(id, name, &[])
    };
    let request = |text: &str| Request {
        text: text.into(),
        projects: vec![
            project(
                earshot,
                "earshot",
                "Records audio, shows its loudness on a meter, streams to a small server",
                None,
            ),
            project(
                tapped,
                "tapped",
                "Hands off tasks to coding agents",
                Some(time(wall_ms())),
            ),
            project(
                mods,
                "claude-mods",
                "A theme and a layout for Claude Code",
                None,
            ),
        ],
        // The words of the language as this check knows them, the same on every system.
        words: Lexicon(vec![
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/words.txt"),
        ]),
        ..Request::default()
    };
    let offered = |text: &str| -> Vec<(String, String)> {
        let r = request(text);
        (offered(&r, CHOICES).into_iter())
            .map(|(p, why)| (p.name.clone(), why))
            .collect()
    };
    let one = |name: &str, why: &str| vec![(name.to_owned(), why.to_owned())];
    // The owner's task: "server" is an everyday word of work, the one word
    // it shares with a project's line; tapped was only worked on last.
    // Nothing is offered, and the person is asked all the same.
    let his = "i need a new satisfactory server for a little project";
    assert_eq!(offered(his), []);
    let Route::Ambiguous { candidates, .. } = local(&request(his)) else {
        panic!("asked")
    };
    // Nothing the words name or clearly describe, but what the finder gives
    // for them (`projects.find`) fills the question.
    let found: Vec<_> = (candidates.iter())
        .map(|c| (c.label.as_str(), c.why.as_str()))
        .collect();
    assert_eq!(found, [("earshot", "server")]);
    // Recency alone offers nothing.
    assert_eq!(offered("buy milk"), []);
    // Named as written: the name is the reason; a letter off, said so.
    assert_eq!(offered("the earshot meter clips"), one("earshot", ""));
    assert_eq!(
        offered("fix the earshut levels"),
        one("earshot", "close to “earshut”")
    );
    // Two meaningful words of its line describe it; one alone, however
    // rare, does not.
    assert_eq!(
        offered("the theme and layout look wrong"),
        one("claude-mods", "matches “theme”, “layout”")
    );
    assert_eq!(offered("the loudness drops"), []);
    assert_eq!(offered("the layout jumps"), []);
    // With no project known, it asks where the agent should work.
    let none = Request {
        text: "make the build faster".into(),
        ..Request::default()
    };
    assert_eq!(
        local(&none),
        Route::Ambiguous {
            prompt: "Where should the agent work?".into(),
            candidates: Vec::new(),
            brief: None,
        }
    );
}

#[test]
fn a_first_task_with_no_project_is_asked_about_never_kept_for_later() {
    let data = Folder::new("first");
    let core = Core::with_agents(&data.0);
    let mut w = core.watch();
    let id = ThoughtId::mint();
    w.ok::<call::ThoughtCapture>(&Capture {
        agent: Some("fixture".into()),
        ..typed(id, "make the build faster")
    });
    let th = w.model.thought(id);
    assert_eq!((th.project_id, th.status), (None, Status::NeedsYou));
    assert_ne!(th.mode, Mode::Note, "kept for later unasked");
    let q = (w.model.questions.values())
        .find(|q| q.thought_id == Some(id))
        .expect("asked");
    assert_eq!(q.prompt, "Where should the agent work?");
    assert_eq!(q.places, Some(Vec::new()));
}

#[test]
fn scratch_is_no_place_a_router_offers() {
    let data = Folder::new("scratch");
    let (mut store, _) = Store::open(&data.0.join("core.db"), time(wall_ms())).unwrap();
    let tx = store.begin().unwrap();
    let r = request(&tx, "start from scratch on the landing page", None).unwrap();
    assert_eq!(r.projects, [], "Scratch is offered to the routers");
    // With no other project, the person is asked where the agent works.
    let asked = Route::Ambiguous {
        prompt: "Where should the agent work?".into(),
        candidates: Vec::new(),
        brief: None,
    };
    assert_eq!(local(&r), asked);
    // Said clearly as a place, the Scratchpad is where the task goes; the
    // everyday word never.
    let scratch = r.scratch.expect("the Scratchpad is open");
    for text in [
        "sketch a parser on the scratchpad",
        "put this to the scratch pad",
        "draft it into the Scratchpad",
        "keep the numbers in my scratch pad",
        "leg das bitte im Scratchpad ab",
        "probier das auf dem Scratchpad aus",
        "schreib das ins Scratchpad",
    ] {
        let r = request(&tx, text, None).unwrap();
        let clear = Route::Clear {
            to: Destination::New(scratch),
            brief: text.into(),
            said: None,
        };
        assert_eq!(local(&r), clear, "{text}");
    }
    // "Scratch" alone is no place, however it is used.
    for text in [
        "rewrite the importer from scratch",
        "scratch that, rename the button",
        "remember to scratch the old plan",
        "a scratchpad for notes would help",
        "try the regex in scratch",
        "clean up the temp files in the scratch directory",
        "push the metadata in the scratch org",
        "make a little game in Scratch for the kids",
        "keep notes on scratch paper",
    ] {
        assert_eq!(local(&request(&tx, text, None).unwrap()), asked, "{text}");
    }
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
            create: false,
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
        w.ok::<call::RouteHint>(&Hint {
            text,
            current,
            view: None,
        })
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
        first: String::new(),
        summary: String::new(),
        ago: None,
        asks: false,
    };
    let text = "um, the login fix from before, it still fails on Safari, please look again \
                and don't touch the session cookie, okay";
    let request = Request {
        last: None,
        scratch: None,
        text: text.into(),
        current: None,
        words: Default::default(),
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
        view: None,
        earlier: Vec::new(),
        top: Vec::new(),
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
        refused(&request, follow(quote), "not in the task");
    }
    // A follow-up to the session the capture was made in needs the words
    // too: the view tells which session, not whether.
    let here = Request {
        current: Some(quiet),
        ..request.clone()
    };
    let taken = accept(&here, &answer("clear", "s2", brief).to_string());
    assert_eq!(
        taken.unwrap_err(),
        "the words it quotes for a follow-up are not in the task"
    );
    refused(&here, follow(""), "not in the task");

    // Only what was offered is a destination.
    for to in ["p4", "s3", "p0", "p", "", "x1", "p-1", "folio"] {
        refused(&request, with("to", to.into()), "was not offered");
    }

    // Unsure: one to three different choices, each offered; the brief is
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
    // A session among them needs the words that lean on it, as a sure
    // follow-up does; with them it is offered as the follow-up.
    let mut quoted =
        serde_json::from_str::<Value>(&choices(json!(["p3", "s2", "p3", "s1"]))).unwrap();
    quoted["quote"] = "the login fix from before".into();
    assert_eq!(
        accept(&request, &quoted.to_string()),
        Ok((
            Route::Torn {
                candidates: vec![
                    choice("app", Destination::New(app)),
                    choice("The codex session in folio", Destination::Session(quiet)),
                    choice("Login fix", Destination::Session(login)),
                ],
                brief: Some(brief.into()),
            },
            Routing {
                quote: Some("the login fix from before".into()),
                ..Routing::default()
            }
        ))
    );
    // Without them, each is a new run in its session's project, once.
    assert_eq!(
        accept(&request, &choices(json!(["p3", "s2", "p2", "s1"]))),
        Ok((
            Route::Torn {
                candidates: vec![
                    choice("app", Destination::New(app)),
                    choice("folio", Destination::New(folio)),
                    choice("tasktap", Destination::New(tasktap)),
                ],
                brief: Some(brief.into()),
            },
            Routing::default()
        ))
    );
    // One choice alone is still a decision that waits for the person's key:
    // the one place a model could think of, however often it names it.
    for keys in [json!(["p3"]), json!(["p3", "p3"])] {
        assert_eq!(
            accept(&request, &choices(keys)),
            Ok((
                Route::Torn {
                    candidates: vec![choice("app", Destination::New(app))],
                    brief: Some(brief.into()),
                },
                Routing::default()
            ))
        );
    }
    refused(&request, choices(json!([])), "names no choice");
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
    refused(&request, long(most + 1), "longer than the task allows");

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

/// An agreement to these fixture agents, each switched on, the first asked
/// first, to the terms of this core.
fn agreement(agents: &[&str]) -> RouteBy {
    RouteBy {
        terms: tasktap_core::route::TERMS,
        agents: (agents.iter())
            .map(|agent| Placer {
                agent: (*agent).into(),
                model: "fixture-small".into(),
                on: true,
            })
            .collect(),
    }
}

/// The file of `agent`'s question in the route folder: as named for the
/// fixture agent, with `-silent` or `-probed` after it for the others.
fn of(agent: &str, name: &str) -> String {
    match agent.strip_prefix("fixture-") {
        Some(kind) => format!("{name}-{kind}"),
        None => name.into(),
    }
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
                create: false,
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
    /// Tasktap stops, and starts again with the same records.
    fn restart(&mut self) {
        let retire = tasktap_proto::Retire {
            when: tasktap_proto::When::Now,
        };
        self.core
            .device()
            .call::<call::CoreRetire>(&retire)
            .unwrap()
            .unwrap();
        self.core.wait();
        self.core = Core::with_agents(&self.data.0);
        self.w = self.core.watch();
        self.freeze();
    }

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

    /// The person lets the fixture agent's model place their thoughts.
    fn consent(&mut self, agent: &str) {
        self.agree(&[agent]);
    }

    /// The person lets these fixture agents place their thoughts, the
    /// first asked first.
    fn agree(&mut self, agents: &[&str]) {
        self.pref(PrefPatch::RouteBy(Some(agreement(agents))))
            .unwrap();
    }

    fn file(&self, name: &str) -> std::path::PathBuf {
        self.data.0.join("route").join(name)
    }

    /// The steps the fixture agent's tool runs when it is asked next.
    fn script(&self, steps: &[String]) {
        self.script_of("fixture", steps);
    }

    /// The steps `agent`'s tool runs when it is asked next.
    fn script_of(&self, agent: &str, steps: &[String]) {
        std::fs::write(self.file(&of(agent, "ask")), steps.join("\n")).unwrap();
    }

    /// The tool answers with this.
    fn answers(&self, answer: &Value) {
        self.script(&[format!("print:{answer}")]);
    }

    /// The fixture agent's tool was asked about thought `t`: its words, as
    /// a model is sent them, are the request's.
    fn asked_about(&self, t: ThoughtId) {
        let text = tasktap_core::route::redact(&self.w.model.thought(t).text);
        let asked = self.asked().expect("the model was asked");
        assert_eq!(asked["thought"], json!(text));
    }

    /// The request the fixture agent's tool was last asked with, and
    /// forgets it.
    fn asked(&self) -> Option<Value> {
        self.asked_of("fixture")
    }

    /// The request `agent`'s tool was last asked with, and forgets it.
    fn asked_of(&self, agent: &str) -> Option<Value> {
        let file = self.file(&of(agent, "asked"));
        let asked = std::fs::read_to_string(&file).ok()?;
        std::fs::remove_file(&file).unwrap();
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
fn a_name_that_may_not_be_meant_goes_to_the_model_agreed_to_first_among_its_projects() {
    let mut a = Asking::new("maybe");
    a.consent("fixture");
    // "app" is an everyday word here, not used as a name: the names alone
    // would ask. The model the person agreed to is asked, with it first;
    // the chip says so (the hint names no place).
    let hint = Hint {
        text: "make the app icon bigger".into(),
        current: None,
        view: None,
    };
    let said = a.w.ok::<call::RouteHint>(&hint);
    assert_eq!(said, tasktap_proto::Route::Unknown);
    a.answers(&answer("clear", "p1", "Make the app icon bigger."));
    let t = a.capture("make the app icon bigger", None);
    let th = a.settled(t);
    let asked = a.asked().expect("the model was asked");
    assert_eq!(
        (&asked["projects"][0]["id"], &asked["projects"][0]["name"]),
        (&json!("p1"), &json!("app"))
    );
    assert_eq!(
        (th.project_id, th.placed),
        (Some(a.app), Some(Placed::Model))
    );
    // Torn, it places the thought in the likelier place, the other beside
    // it, and waits for the person's key.
    a.answers(&json!({ "quote": "", "confidence": "ambiguous", "to": "",
        "candidates": ["p1", "p2"], "brief": "Make the app icon bigger.", "title": "" }));
    let t = a.capture("make the app icon bigger", None);
    let th = a.settled(t);
    assert_eq!(
        (th.status, th.project_id, th.hold_until),
        (Status::Routed, Some(a.app), None)
    );
    assert_eq!(
        th.route.unwrap().others,
        [tasktap_proto::Place::Project(a.folio)]
    );
    a.asked_about(t);
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
    // The brief, as the model wrote it, to read during the hold, which is
    // 3 s from the decision (the clock stands still: the capture's time).
    assert_eq!(
        th.brief.as_deref(),
        Some("Keep the header on one line on small screens.")
    );
    let decided = u64::from(tasktap_proto::DECIDED_HOLD) * 1000;
    assert_eq!(th.hold_until, Some(time(th.created.get() + decided)));
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

    // A project's name said is no decision of its own while a model is
    // there: the model decides, the name among what it reads.
    let t = a.capture("fix the header in folio", None);
    let th = a.settled(t);
    assert_eq!((th.status, th.project_id), (Status::Routed, Some(a.folio)));
    assert_eq!(th.route.unwrap().by, "fixture");
    a.asked_about(t);
}

#[test]
fn whatever_goes_wrong_with_the_model_the_person_is_asked_and_told_why() {
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
        // A model is there, so no rule of words starts the thought: the
        // person is asked.
        assert_eq!(
            (th.status, th.project_id),
            (Status::NeedsYou, None),
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
    // Gone for good, it is no placing model: the match on names places that
    // task as with none, and says why.
    let t = a.capture(&text, None);
    let th = a.settled(t);
    assert_eq!((th.status, th.project_id), (Status::Routed, Some(a.folio)));
    let route = th.route.unwrap();
    assert_eq!(
        (route.by.as_str(), route.fallback.as_deref()),
        ("local", Some(gone))
    );
    // The page knows it by its kind, not by these words: it asks for the
    // terms again.
    assert!(route.lost);
    assert_eq!(a.asked().unwrap()["thought"], json!(text));
    // The chip's hint says so: the names decide now.
    let hint = Hint {
        text: "fix the header in folio".into(),
        current: None,
        view: None,
    };
    assert!(matches!(
        a.w.ok::<call::RouteHint>(&hint),
        tasktap_proto::Route::Clear { .. }
    ));
    // It is not asked again while this core runs, whatever it would answer:
    // no model is left, so the match on names places, as with none.
    a.answers(&answer("clear", "p2", "Brief."));
    let t = a.capture(&text, None);
    let th = a.settled(t);
    assert_eq!((th.status, th.project_id), (Status::Routed, Some(a.folio)));
    let route = th.route.unwrap();
    assert_eq!(route.fallback.as_deref(), Some(gone));
    assert!(route.lost);
    assert_eq!(a.asked(), None);
    // Nor is it offered for consent; the other agents are.
    let terms = a.w.ok::<call::RouteTerms>(&tasktap_proto::Empty {});
    let offered: Vec<_> = terms.tools.iter().map(|t| t.agent.as_str()).collect();
    assert!(!offered.contains(&"fixture"), "{offered:?}");
    assert!(offered.contains(&"fixture-silent") && offered.contains(&"codex"));
}

#[test]
fn a_model_that_takes_too_long_is_stopped_and_the_person_is_asked() {
    let mut a = Asking::new("timeout");
    // The silent fixture agent's tool gets one second.
    a.consent("fixture-silent");
    let mut steps = vec!["write:began:1".into(), "sleep:4000".into()];
    steps.extend([
        "write:ended:1".into(),
        format!("print:{}", answer("clear", "p2", "Brief.")),
    ]);
    a.script_of("fixture-silent", &steps);
    let text = format!("{SPOKEN}, that is in folio by the way");
    let began = std::time::Instant::now();
    let t = a.capture(&text, None);
    let th = a.settled(t);
    assert!(began.elapsed() < std::time::Duration::from_millis(3500));
    assert_eq!((th.status, th.project_id), (Status::NeedsYou, None));
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

// The person's agents, one after another (design §8): the first that
// answers places the thought; one that cannot is passed for the next; none
// that can in the time placing waits, and the thought is asked about.

#[test]
fn when_the_first_agent_cannot_place_the_next_does_and_the_thought_says_who_placed_it() {
    let mut a = Asking::new("chain");
    a.agree(&["fixture", "fixture-silent"]);
    // The first says it is signed out; it ends before the second begins.
    a.script(&[
        "sleep:200".into(),
        "write:first-ended:1".into(),
        "print:error:Not logged in · Please run /login".into(),
    ]);
    a.script_of(
        "fixture-silent",
        &[
            "write:second-began:1".into(),
            format!(
                "print:{}",
                answer("clear", "p2", "Keep the header on one line.")
            ),
        ],
    );
    let t = a.capture(SPOKEN, None);
    // Until one answers, the first the person lets place them is named.
    assert_eq!(a.w.model.thought(t).route.as_ref().unwrap().by, "fixture");
    let th = a.settled(t);
    assert_eq!(
        (th.status, th.project_id, th.placed),
        (Status::Routed, Some(a.app), Some(Placed::Model))
    );
    assert_eq!(th.brief.as_deref(), Some("Keep the header on one line."));
    let route = th.route.unwrap();
    assert_eq!(
        (route.by.as_str(), route.model.as_deref(), route.fallback),
        ("fixture-silent", Some("fixture-small"), None)
    );
    // Both were sent the same question, one at a time.
    let (first, second) = (a.asked().unwrap(), a.asked_of("fixture-silent").unwrap());
    assert_eq!(first, second);
    let at = |name: &str| std::fs::metadata(a.file(name)).unwrap().modified().unwrap();
    assert!(at("second-began") >= at("first-ended"));
    // Switched off, an agent is not asked: the second places at once.
    let mut by = agreement(&["fixture", "fixture-silent"]);
    by.agents[0].on = false;
    a.pref(PrefPatch::RouteBy(Some(by))).unwrap();
    a.answers(&answer("clear", "p1", "Brief."));
    a.script_of(
        "fixture-silent",
        &[format!("print:{}", answer("clear", "p1", "Brief."))],
    );
    let t = a.capture(SPOKEN, None);
    assert_eq!(
        a.w.model.thought(t).route.as_ref().unwrap().by,
        "fixture-silent"
    );
    assert_eq!(a.settled(t).route.unwrap().by, "fixture-silent");
    assert_eq!(a.asked(), None);
    assert!(a.asked_of("fixture-silent").is_some());
    // Every one switched off is no agreement: nobody is asked, and nothing
    // is said of it.
    let mut by = agreement(&["fixture", "fixture-silent"]);
    by.agents.iter_mut().for_each(|p| p.on = false);
    a.pref(PrefPatch::RouteBy(Some(by))).unwrap();
    let t = a.capture(SPOKEN, None);
    let th = a.settled(t);
    let route = th.route.unwrap();
    assert_eq!(
        (th.status, route.by.as_str(), route.fallback),
        (Status::NeedsYou, "local", None)
    );
    assert_eq!((a.asked(), a.asked_of("fixture-silent")), (None, None));
}

#[test]
fn when_no_agent_can_place_the_thought_is_asked_about_and_says_why_each_could_not() {
    let mut a = Asking::new("chain-none");
    a.agree(&["fixture", "fixture-silent"]);
    a.script(&["exit:1".into()]);
    a.script_of(
        "fixture-silent",
        &["print:error:the model is overloaded".into()],
    );
    let t = a.capture(SPOKEN, None);
    let th = a.settled(t);
    assert_eq!((th.status, th.mode), (Status::NeedsYou, Mode::Ask));
    let route = th.route.unwrap();
    assert_eq!(route.by, "local");
    assert_eq!(
        route.fallback.as_deref(),
        Some("fixture: it printed no answer; fixture-silent: the model is overloaded")
    );
    assert!(a.asked().is_some() && a.asked_of("fixture-silent").is_some());
    // Naming its folder, a long thought is not placed by the name either:
    // the question offers that folder first.
    let text = format!("{SPOKEN}, that is in folio by the way");
    let t = a.capture(&text, None);
    let th = a.settled(t);
    assert_eq!((th.status, th.project_id), (Status::NeedsYou, None));
    let q =
        a.w.model
            .questions
            .values()
            .find(|q| q.thought_id == Some(t));
    let places = q.unwrap().places.clone().unwrap();
    assert_eq!(places[0], tasktap_proto::Place::Project(a.folio));
}

#[test]
fn an_agent_at_its_usage_limit_is_passed_over_until_the_time_it_named() {
    let mut a = Asking::new("limit");
    a.agree(&["fixture", "fixture-probed"]);
    let start = wall_ms() / 1000 * 1000;
    a.w.ok::<call::FixtureClock>(&FixtureClock { now: time(start) });
    let back = start / 1000 + 1800;
    a.script(&[format!("print:error:Claude AI usage limit reached|{back}")]);
    let places = |a: &Asking, to: &str| {
        a.script_of(
            "fixture-probed",
            &[format!("print:{}", answer("clear", to, "Brief."))],
        );
    };
    places(&a, "p1");
    let t = a.capture(SPOKEN, None);
    let th = a.settled(t);
    assert_eq!(
        (th.project_id, th.route.unwrap().by.as_str()),
        (Some(a.folio), "fixture-probed")
    );
    a.asked_about(t);
    // Its row says until when, and so does what the next core reads.
    let until = time(back * 1000);
    a.w.until("the limit is in the agent's row", |m| {
        m.agents.get("fixture").and_then(|h| h.limited) == Some(until)
    });
    let kept = a.data.0.join("agents.json");
    let mut tries = 0;
    while !std::fs::read_to_string(&kept)
        .is_ok_and(|k| k.contains(&format!("\"limited\":{}", back * 1000)))
    {
        tries += 1;
        assert!(tries < 300, "the limit is kept for the next core");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    // Until then it is not asked: the next places at once.
    a.answers(&answer("clear", "p2", "Brief."));
    places(&a, "p2");
    let t = a.capture(SPOKEN, None);
    assert_eq!(a.settled(t).route.unwrap().by, "fixture-probed");
    assert_eq!(a.asked(), None);
    assert!(a.asked_of("fixture-probed").is_some());
    // Once its time has come, it is asked first again.
    a.w.ok::<call::FixtureClock>(&FixtureClock {
        now: time((back + 1) * 1000),
    });
    let t = a.capture(SPOKEN, None);
    let th = a.settled(t);
    assert_eq!(
        (th.placed, th.route.unwrap().by.as_str()),
        (Some(Placed::Model), "fixture")
    );
    assert!(a.asked().is_some() && a.asked_of("fixture-probed").is_none());
    // A limit that names no time passes it over for an hour; with every
    // agent at its limit, the thought is asked about.
    let now = back + 1;
    a.script(&["print:error:You've hit your limit".into()]);
    a.script_of(
        "fixture-probed",
        &["print:error:You've hit your limit · resets in 2 hours".into()],
    );
    let t = a.capture(SPOKEN, None);
    let th = a.settled(t);
    assert_eq!(th.status, Status::NeedsYou);
    a.w.until("both rows say until when", |m| {
        let limited = |id: &str| m.agents.get(id).and_then(|h| h.limited);
        limited("fixture") == Some(time((now + 3600) * 1000))
            && limited("fixture-probed") == Some(time((now + 7200) * 1000))
    });
    let t = a.capture(SPOKEN, None);
    let route = a.settled(t).route.unwrap();
    assert_eq!(
        route.fallback.as_deref(),
        Some(
            "fixture: its usage limit is reached for now; fixture-probed: its usage limit is reached for now"
        )
    );
    assert!(a.asked().is_some() && a.asked_of("fixture-probed").is_some());
}

#[test]
fn placing_waits_for_the_agents_no_longer_than_its_budget() {
    let mut a = Asking::new("budget");
    a.agree(&["fixture", "fixture-silent"]);
    // The first takes longer than placing waits: it is stopped then, and
    // no time is left to ask the second.
    a.script(&[
        "sleep:9500".into(),
        format!("print:{}", answer("clear", "p1", "Brief.")),
    ]);
    a.script_of(
        "fixture-silent",
        &[format!("print:{}", answer("clear", "p1", "Brief."))],
    );
    let began = std::time::Instant::now();
    let t = a.capture(SPOKEN, None);
    let th = a.settled(t);
    let took = began.elapsed();
    assert!(took >= tasktap_core::route::BUDGET, "{took:?}");
    assert!(
        took < tasktap_core::route::BUDGET + std::time::Duration::from_millis(1500),
        "{took:?}"
    );
    assert_eq!((th.status, th.mode), (Status::NeedsYou, Mode::Ask));
    assert_eq!(
        th.route.unwrap().fallback.as_deref(),
        Some("fixture: it did not answer within 8 s; fixture-silent: no time was left to ask it")
    );
    a.asked_about(t);
    assert_eq!(a.asked_of("fixture-silent"), None);
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
fn a_said_project_name_alone_starts_nothing_while_a_model_is_there() {
    let mut a = Asking::new("named");
    a.consent("fixture");
    // Naming folio, short or long: the model decides, the name first among
    // what it reads, and nothing is placed by the name before it answers.
    for text in [
        "fix the header in folio".to_owned(),
        format!("{SPOKEN}, that is in folio by the way"),
    ] {
        a.answers(&answer("clear", "p2", "Keep the header on one line."));
        let t = a.capture(&text, None);
        assert_eq!(a.w.model.thought(t).status, Status::Captured);
        let th = a.settled(t);
        assert_eq!(
            (th.status, th.project_id, th.placed),
            (Status::Routed, Some(a.app), Some(Placed::Model))
        );
        assert_eq!(th.route.unwrap().by, "fixture");
        let asked = a.asked().unwrap();
        assert_eq!(asked["picked"], json!(null));
        assert_eq!(
            (&asked["projects"][0]["name"], &asked["projects"][1]["name"]),
            (&json!("folio"), &json!("app"))
        );
    }
    // Naming two, the model is asked too; no question the names would ask.
    a.answers(&answer("clear", "p1", "Brief."));
    let t = a.capture(&format!("{SPOKEN}, in folio or in app"), None);
    let th = a.settled(t);
    assert_eq!((th.status, th.project_id), (Status::Routed, Some(a.folio)));
    a.asked_about(t);
}

#[test]
fn a_torn_model_shows_its_choices_on_the_decision_line_and_waits_for_a_key() {
    let mut a = Asking::new("torn");
    a.consent("fixture");
    // A host that shows system notifications, as the app's is.
    let stream = tasktap_core::client::connect(&a.data.0).unwrap();
    #[cfg(unix)]
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(20)))
        .unwrap();
    let hello = tasktap_proto::Hello {
        v: tasktap_proto::Versions(tasktap_proto::VERSION, tasktap_proto::VERSION),
        role: tasktap_proto::Role::Host,
        client: "test host".into(),
        auth: None,
        abilities: vec!["host.notify".into()],
    };
    let mut host = tasktap_core::client::Client::hello(stream, hello)
        .unwrap()
        .unwrap();
    let mut said = answer("ambiguous", "", "Keep the header on one line.");
    said["candidates"] = json!(["p2", "p1"]);
    a.answers(&said);
    let t = a.capture(SPOKEN, None);
    // In the likelier place, the other beside it; no hold runs and no
    // question opens: it waits for the person's key.
    let th = a.settled(t);
    assert_eq!(
        (th.status, th.project_id, th.hold_until, th.placed),
        (Status::Routed, Some(a.app), None, Some(Placed::Model))
    );
    assert_eq!(th.brief.as_deref(), Some("Keep the header on one line."));
    let place = tasktap_proto::Place::Project;
    assert_eq!(th.route.as_ref().unwrap().others, [place(a.folio)]);
    assert!(a.w.model.glance().question.is_none());
    a.asked_about(t);
    // It calls the person as the question did: the host is told it waits,
    // after what waited as it came (nothing).
    let mut next = || loop {
        match host.recv().unwrap() {
            tasktap_proto::Frame::Control(tasktap_proto::Control::Call(r)) => break r,
            _ => continue,
        }
    };
    let came = next();
    let came = <call::HostNotify as tasktap_proto::call::Call>::args(came.args).unwrap();
    assert_eq!(came.waiting, Some(Vec::new()));
    let told = next();
    assert_eq!(told.name, "host.notify");
    let told = <call::HostNotify as tasktap_proto::call::Call>::args(told.args).unwrap();
    assert_eq!(
        (
            told.question,
            told.thought,
            told.title.as_str(),
            told.session
        ),
        (None, Some(t), "Which project is this task for?", None)
    );
    assert!(SPOKEN.starts_with(told.body.trim_end_matches('…')));
    // Nothing starts by itself: no hold runs.
    assert_eq!(a.w.model.thought(t).hold_until, None);
    // The other's key places it there; the hold runs from now, the first
    // stays offered, and nobody is asked again.
    let to = tasktap_proto::Assign {
        id: t,
        project_id: Some(a.folio),
        card_id: None,
        session_id: None,
    };
    a.w.ok::<call::ThoughtUpdate>(&to);
    let th = a.w.model.thought(t).clone();
    assert_eq!(
        (th.status, th.project_id, th.placed),
        (Status::Routed, Some(a.folio), Some(Placed::Picked))
    );
    assert!(th.hold_until.is_some());
    assert_eq!(th.route.unwrap().others, [place(a.app)]);
    assert_eq!(a.asked(), None);
    // Decided by the key, it waits no more: what the host was told of it is
    // taken back.
    let taken = loop {
        match host.recv().unwrap() {
            tasktap_proto::Frame::Control(tasktap_proto::Control::Call(r)) => break r,
            _ => continue,
        }
    };
    let taken = <call::HostNotify as tasktap_proto::call::Call>::args(taken.args).unwrap();
    assert_eq!((taken.thought, taken.withdrawn), (Some(t), true));
    // Started from the line, or undone, it waits no more either.
    let mut told = || loop {
        match host.recv().unwrap() {
            tasktap_proto::Frame::Control(tasktap_proto::Control::Call(r))
                if r.name == "host.notify" =>
            {
                break <call::HostNotify as tasktap_proto::call::Call>::args(r.args).unwrap();
            }
            _ => continue,
        }
    };
    for how in ["started", "undone"] {
        a.answers(&said);
        let t = a.capture(SPOKEN, None);
        a.settled(t);
        let waits = told();
        assert_eq!((waits.thought, waits.withdrawn), (Some(t), false), "{how}");
        match how {
            "started" => a.start(t),
            _ => a.w.ok::<call::ThoughtStop>(&tasktap_proto::Ref { id: t }),
        }
        let taken = told();
        assert_eq!((taken.thought, taken.withdrawn), (Some(t), true), "{how}");
    }
}

#[test]
fn a_model_unsure_of_only_one_place_waits_for_the_persons_key_there() {
    let mut a = Asking::new("torn-one");
    a.consent("fixture");
    let mut said = answer("ambiguous", "", "Keep the header on one line.");
    said["candidates"] = json!(["p2"]);
    a.answers(&said);
    let t = a.capture(SPOKEN, None);
    // In the one place it named, no other beside it; no hold runs and no
    // question opens: it waits for the person's key.
    let th = a.settled(t);
    assert_eq!(
        (th.status, th.project_id, th.hold_until, th.placed),
        (Status::Routed, Some(a.app), None, Some(Placed::Model))
    );
    assert_eq!(th.brief.as_deref(), Some("Keep the header on one line."));
    assert_eq!(th.route.as_ref().unwrap().others, []);
    assert!(a.w.model.glance().question.is_none());
    a.asked_about(t);
    // Return starts it where it is.
    a.start(t);
    assert_eq!(a.w.model.thought(t).project_id, Some(a.app));
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
    assert_eq!(terms.sends.len(), 6);
    // In the words the interface uses (docs/projects-design.md, "Words"):
    // projects, and nothing is "routed".
    assert_eq!(
        terms.sends[1],
        "up to 8 likely projects, each with its names, one line about the project, 5 earlier tasks, which include requests you gave an agent outside Tasktap, and the folder names at the project's top"
    );
    let said = terms.sends.join(" ").to_lowercase();
    // ("folder names" at a project's top are the coordinator's words of
    // 2026-11-22: what is sent of it is its folders' names.)
    for word in ["repositor", "rout"] {
        assert!(!said.contains(word), "{word} in {said}");
    }
    assert_eq!(terms.terms, tasktap_core::route::TERMS);
    // Tasktap's order: ChatGPT first, which starts no agent; then what
    // costs the person nothing more, the fastest first among those; then
    // what their provider bills.
    let tools: Vec<_> = (terms.tools.iter())
        .map(|t| (t.agent.as_str(), t.model.as_str(), t.pays, t.ms))
        .collect();
    assert_eq!(
        tools,
        [
            ("chatgpt", "gpt-6.2-sol", Pays::Plan, Some(4000)),
            ("fixture-silent", "fixture-small", Pays::Plan, Some(600)),
            ("fixture", "fixture-small", Pays::Plan, Some(900)),
            ("claude", "haiku", Pays::Plan, Some(3700)),
            ("codex", "gpt-6-luna", Pays::Plan, Some(4700)),
            ("agy", "gemini-3.8-flash-low", Pays::Plan, Some(5600)),
            ("fixture-probed", "fixture-small", Pays::Billed, Some(500)),
        ]
    );
    // Signed in with a key, an agent is billed by its provider, and goes
    // after those included in a subscription, however fast it is.
    use tasktap_core::route::{pays, proposed};
    assert_eq!(pays("codex", Some("ChatGPT")), Pays::Plan);
    assert_eq!(
        pays("codex", Some("an API key - sk-proj-***")),
        Pays::Billed
    );
    assert_eq!(pays("claude", Some("someone@example.com")), Pays::Plan);
    assert_eq!(pays("claude", Some("api_key")), Pays::Billed);
    assert_eq!(pays("an-agent-of-their-own", None), Pays::Billed);
    let mut keyed = terms.tools.clone();
    keyed[1].pays = pays(&keyed[1].agent, Some("an API key"));
    let order: Vec<_> = proposed(keyed).into_iter().map(|t| t.agent).collect();
    assert_eq!(
        order,
        [
            "chatgpt",
            "fixture",
            "claude",
            "codex",
            "agy",
            "fixture-probed",
            "fixture-silent"
        ]
    );
    let tool = |agent: &str, model: &str| RouteBy {
        terms: tasktap_core::route::TERMS,
        agents: vec![Placer {
            agent: agent.into(),
            model: model.into(),
            on: true,
        }],
    };

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
    // An agreement names agents this core has, each once, the model it
    // would ask of each, and the terms the person was shown.
    let twice = agreement(&["fixture", "fixture-silent", "fixture"]);
    let before = RouteBy {
        terms: tasktap_core::route::TERMS - 1,
        ..agreement(&["fixture"])
    };
    for by in [
        tool("fixture", "another-model"),
        tool("nobody", "fixture-small"),
        tool("copilot", "fixture-small"),
        twice,
        before,
    ] {
        let refused = a.pref(PrefPatch::RouteBy(Some(by))).unwrap_err();
        assert_eq!(refused.code, tasktap_proto::Code::Invalid);
    }
    local(&mut a);
    // Given, the model decides, also of a thought that names its folder;
    // cleared, the match on names again.
    a.consent("fixture");
    a.answers(&answer("clear", "p1", "Brief."));
    let t = a.capture(&text, None);
    let th = a.settled(t);
    assert_eq!(
        (th.project_id, th.brief.as_deref()),
        (Some(a.folio), Some("Brief."))
    );
    assert_eq!(th.route.unwrap().by, "fixture");
    a.asked_about(t);
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
    a.asked_about(routed);
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

/// The eval's projects (core/scripts/place-eval.json), as `place-eval` makes
/// them: the first `size`, with its `more` where `more` says so, and its
/// `tools` where `tools` does, each worked on as many days ago as it says.
fn eval_projects(size: usize, more: bool, tools: bool) -> Vec<Named> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/place-eval.json");
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let list = |key: &str| fixture[key].as_array().cloned().unwrap_or_default();
    let now: u64 = 1_800_000_000_000;
    let card = |p: &Value| Named {
        to: Destination::Card(tasktap_proto::CardId::mint()),
        name: p["name"].as_str().unwrap().into(),
        aliases: Vec::new(),
        about: p["about"].as_str().unwrap_or("").into(),
        folder: format!("/Users/someone/projects/{}", p["name"].as_str().unwrap()),
        used: tasktap_proto::Time::new(now - p["quiet"].as_u64().unwrap() * 86_400_000),
    };
    let all = list("projects").into_iter().take(size);
    let more = list("more").into_iter().filter(|_| more);
    let tools = list("tools").into_iter().filter(|_| tools);
    all.chain(more).chain(tools).map(|p| card(&p)).collect()
}

/// The words of the language as these checks know them, the same on every
/// system: the fixture's.
fn fixture_words() -> Lexicon {
    Lexicon(vec![
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/words.txt"),
    ])
}

#[test]
fn scratch_as_an_adjective_or_a_name_is_no_place() {
    let scratch = ProjectId::mint();
    let request = |text: &str| Request {
        text: text.into(),
        projects: vec![Named::open(ProjectId::mint(), "earshot", &[])],
        scratch: Some(scratch),
        ..Request::default()
    };
    let pad = |r: Route| matches!(r, Route::Clear { to: Destination::New(x), .. } if x == scratch);
    for text in [
        "clean up the temp files in the scratch directory",
        "the build leaves junk in the scratch space on the cluster",
        "make a little game in Scratch for the kids",
        "push the metadata in the scratch org",
        "keep notes on scratch paper",
        "in scratch",
    ] {
        assert!(!pad(local(&request(text))), "{text}");
    }
    for text in [
        "leg das bitte im Scratchpad ab",
        "probier das auf dem Scratchpad aus",
    ] {
        assert!(pad(local(&request(text))), "{text}");
    }
}

#[test]
fn german_function_words_describe_no_project() {
    let p = |name: &str, about: &str| Named {
        about: about.into(),
        ..Named::open(ProjectId::mint(), name, &[])
    };
    let projects = vec![
        p(
            "rechnungsbot",
            "Schreibt Rechnungen und verschickt sie nicht doppelt",
        ),
        p("beetplaner", "Plant den Garten und die Beete"),
        p("earshot", "Records audio, shows its loudness on a meter"),
    ];
    for text in [
        "Ich muss noch die Steuererklärung machen und das Auto waschen",
        "Der Drucker im Büro geht nicht",
        "Kannst du den Zahnarzt anrufen und den Termin verschieben",
    ] {
        let r = Request {
            text: text.into(),
            projects: projects.clone(),
            ..Request::default()
        };
        assert_eq!(offered(&r, CHOICES), [], "{text}");
    }
}

#[test]
fn the_evals_tasks_that_mean_no_project_are_offered_none_by_name_and_the_finders_places_fill_the_question()
 {
    let projects = eval_projects(306, true, true);
    for text in [
        "look at ~/Downloads/invoice.pdf and pay it",
        "Spotify zeigt in der Statistik nur noch Podcasts",
    ] {
        let r = Request {
            text: text.into(),
            projects: projects.clone(),
            ..Request::default()
        };
        assert_eq!(offered(&r, CHOICES), [], "{text}");
        let Route::Ambiguous { candidates, .. } = unsure(&r) else {
            panic!("{text}: asked")
        };
        // The question still offers no place the words only almost name:
        // what it carries is what the finder gives, no more and no other.
        let found: Vec<_> = (likely(&r, CHOICES).into_iter())
            .map(|(p, why)| (p.name.clone(), why))
            .collect();
        let carried: Vec<_> = (candidates.iter())
            .map(|c| (c.label.clone(), c.why.clone()))
            .collect();
        assert_eq!(carried, found, "{text}");
    }
    // And the static site generator is still described by its two words.
    let r = Request {
        text: "make the static site rebuild faster".into(),
        projects,
        ..Request::default()
    };
    let first = (offered(&r, CHOICES).into_iter())
        .map(|(p, why)| (p.name.clone(), why))
        .next();
    assert_eq!(
        first,
        Some(("kiln".into(), "matches “static”, “site”".into()))
    );
}

#[test]
fn a_model_is_shown_the_same_eight_projects_as_before_the_question_was_strict() {
    // Computed at d4505ca, with the same projects and the same lexicon: what
    // the question offers changed, what a model is shown did not.
    for (text, eight) in [
        (
            "the lighting desk needs a blackout button",
            [
                "lumenbox",
                "cuegrid",
                "ledgerline",
                "fieldnotes",
                "tasktap",
                "dotfiles",
                "kiln",
                "pyrite",
            ],
        ),
        (
            "the book typesetting breaks footnotes across pages badly",
            [
                "parcelpath",
                "vellum",
                "cuegrid",
                "ledgerline",
                "fieldnotes",
                "tasktap",
                "dotfiles",
                "kiln",
            ],
        ),
    ] {
        let r = Request {
            text: text.into(),
            projects: eval_projects(36, false, false),
            words: fixture_words(),
            ..Request::default()
        };
        let shown: Vec<&str> = ranked(&r, 8).iter().map(|(p, _)| p.name.as_str()).collect();
        assert_eq!(shown, eight, "{text}");
    }
}

#[test]
fn the_lead_for_a_vexa_widget_holds_at_100_and_306_projects() {
    let text = "write a new vexa widget for the widgetpack that adds snippets";
    // Every word of it ordinary but the two made up for the project.
    let file = std::env::temp_dir().join(format!("tasktap-lead-words-{}.txt", std::process::id()));
    let ordinary = [
        "write", "a", "new", "widget", "for", "the", "that", "adds", "snippets", "snippet",
    ];
    std::fs::write(&file, ordinary.join("\n")).unwrap();
    for size in [100, 306] {
        let projects = eval_projects(size, true, false);
        let to = projects
            .iter()
            .find(|p| p.name == "vexa-widgets")
            .unwrap()
            .to;
        let r = Request {
            text: text.into(),
            projects,
            words: Lexicon(vec![file.clone()]),
            ..Request::default()
        };
        let led = tasktap_core::state::Said::Leads {
            why: "its name and “widgetpack”".into(),
            words: Some("vexa widget".into()),
        };
        let wanted = Route::Clear {
            to,
            brief: text.into(),
            said: Some(led),
        };
        assert_eq!(local(&r), wanted, "{size} projects");
    }
    let _ = std::fs::remove_file(file);
}

#[test]
fn a_model_that_cannot_tell_leaves_the_question_and_starts_nothing() {
    let mut a = Asking::new("unknown");
    a.consent("fixture");
    a.answers(&answer("unknown", "", ""));
    let t = a.capture("make the app icon bigger", None);
    a.w.until("asked", |m| m.thought(t).status == Status::NeedsYou);
    assert!(a.asked().is_some(), "the model was not asked");
    let th = a.w.model.thought(t).clone();
    assert_eq!(
        (th.project_id, th.card_id, th.session_id, th.placed),
        (None, None, None, None)
    );
    assert_ne!(th.mode, Mode::Note, "kept for later unasked");
    let q = (a.w.model.questions.values())
        .find(|q| q.thought_id == Some(t))
        .expect("asked");
    // The question the match on names asks: the everyday word said as a
    // word, with its reason; never a project because it was worked on.
    assert_eq!(q.prompt, "Which project is this task for?");
    assert_eq!(q.places, Some(vec![tasktap_proto::Place::Project(a.app)]));
    assert_eq!(q.notes, Some(vec!["you wrote “app”".into()]));
    // What a model that cannot tell leaves is the question, also where the
    // match on names would start the task by a lead.
    let card = |name: &str, about: &str| Named {
        to: Destination::Card(tasktap_proto::CardId::mint()),
        about: about.into(),
        ..Named::open(ProjectId::mint(), name, &[])
    };
    let r = Request {
        text: "research a new vexa widget to add to the vexa widgetpack".into(),
        projects: vec![
            card(
                "vexa-widgets",
                "The vexa widgetpack: the widgets we ship and their settings",
            ),
            card("vexa-notes", "Notes on vexa prompts and sessions"),
        ],
        words: fixture_words(),
        ..Request::default()
    };
    assert!(
        matches!(local(&r), Route::Clear { .. }),
        "the match on names leads"
    );
    assert!(matches!(unsure(&r), Route::Ambiguous { .. }));
}

// Smart placing (design §8, "The decision"): a model decides every task the
// person did not place, the vehicle with it, and the decision is shown.

impl Asking {
    /// A run of `text` in `project`, picked and started at once: its session.
    fn run(&mut self, project: ProjectId, text: &str) -> SessionId {
        let id = self.capture(text, Some(project));
        self.start(id);
        self.w.until("the run has a session", |m| {
            m.thoughts[&id].session_id.is_some()
        });
        self.w.model.thought(id).session_id.unwrap()
    }

    /// Return on the decision line: the thought starts now.
    fn start(&mut self, id: ThoughtId) {
        let start = tasktap_proto::Start {
            id,
            attempt: tasktap_proto::AttemptId::mint(),
        };
        self.w.ok::<call::ThoughtStart>(&start);
    }

    /// A key of the decision line, or a place picked: the thought goes there.
    fn switch(&mut self, id: ThoughtId, to: tasktap_proto::Place) {
        use tasktap_proto::Place;
        let mut assign = tasktap_proto::Assign {
            id,
            project_id: None,
            card_id: None,
            session_id: None,
        };
        match to {
            Place::Project(p) => assign.project_id = Some(p),
            Place::Session(s) => assign.session_id = Some(s),
            Place::Card(c) => assign.card_id = Some(c),
        }
        self.w.ok::<call::ThoughtUpdate>(&assign);
    }
}

/// A model's answer that follows a session up, with the words that say so.
fn follow(session: &str, quote: &str, brief: &str) -> Value {
    let mut a = answer("clear", session, brief);
    a["quote"] = quote.into();
    a
}

#[test]
fn a_model_that_says_continue_sends_the_task_to_that_session_and_starts_no_run() {
    let mut a = Asking::new("continue");
    a.consent("fixture");
    let s = a.run(a.app, "fix the flaky export test");
    a.answers(&follow("s1", "also", "Also cover an empty export."));
    let t = a.capture("also cover an empty export", None);
    let th = a.settled(t);
    assert_eq!(
        (th.status, th.project_id, th.session_id, th.mode),
        (Status::Routed, Some(a.app), Some(s), Mode::Nudge)
    );
    assert_eq!(th.placed, Some(Placed::Model));
    // The other vehicle stands beside it, on its own key: a new run in app.
    let place = tasktap_proto::Place::Project;
    assert_eq!(th.route.unwrap().others, [place(a.app)]);
    // Started, it goes to that session; no other run begins.
    let sessions = a.w.model.sessions.len();
    a.start(t);
    a.w.until("it went on", |m| m.thoughts[&t].status != Status::Routed);
    let th = a.w.model.thought(t).clone();
    assert_eq!((th.session_id, th.status), (Some(s), Status::Working));
    assert_eq!(a.w.model.sessions.len(), sessions);
}

#[test]
fn a_model_that_says_new_run_starts_one_in_that_project_beside_its_session() {
    let mut a = Asking::new("new-run");
    a.consent("fixture");
    let s = a.run(a.app, "fix the flaky export test");
    a.answers(&answer("clear", "p1", "Add a dark theme."));
    let t = a.capture("add a dark theme to app", None);
    let th = a.settled(t);
    assert_eq!(
        (th.status, th.project_id, th.session_id, th.mode),
        (Status::Routed, Some(a.app), None, Mode::Ask)
    );
    // The other vehicle: the session in app whose last turn is the newest.
    let others = th.route.unwrap().others;
    assert_eq!(others, [tasktap_proto::Place::Session(s)]);
    // Started, it is a run of its own: one session more, and not that one.
    let sessions = a.w.model.sessions.len();
    a.start(t);
    a.w.until("its run has a session", |m| {
        m.thoughts[&t].session_id.is_some()
    });
    assert_ne!(a.w.model.thought(t).session_id, Some(s));
    assert_eq!(a.w.model.sessions.len(), sessions + 1);
}

#[test]
fn the_vehicle_key_turns_a_follow_up_into_a_new_run_and_back() {
    let mut a = Asking::new("vehicle");
    a.consent("fixture");
    let s = a.run(a.app, "fix the flaky export test");
    a.answers(&follow("s1", "also", "Also cover an empty export."));
    let t = a.capture("also cover an empty export", None);
    let th = a.settled(t);
    assert_eq!(th.session_id, Some(s));
    a.asked_about(t);
    use tasktap_proto::Place;
    // A new run in app, the follow-up offered in its place; the hold from now.
    a.switch(t, Place::Project(a.app));
    let th = a.w.model.thought(t).clone();
    assert_eq!(
        (th.project_id, th.session_id, th.mode, th.placed),
        (Some(a.app), None, Mode::Ask, Some(Placed::Picked))
    );
    assert!(th.hold_until.is_some());
    assert_eq!(th.route.unwrap().others, [Place::Session(s)]);
    // And back.
    a.switch(t, Place::Session(s));
    let th = a.w.model.thought(t).clone();
    assert_eq!(
        (th.project_id, th.session_id, th.mode),
        (Some(a.app), Some(s), Mode::Nudge)
    );
    assert_eq!(th.route.unwrap().others, [Place::Project(a.app)]);
    assert_eq!(a.asked(), None);
}

#[test]
fn a_new_project_is_made_only_when_the_person_says_yes_and_the_task_starts_there() {
    let mut a = Asking::new("create");
    a.consent("fixture");
    let mut said = answer("new", "", "Start a tide table app.");
    said["folder"] = "Tide Notes".into();
    a.answers(&said);
    let t = a.capture("start a new app for tide tables", None);
    let th = a.settled(t);
    assert_eq!((th.status, th.project_id), (Status::NeedsYou, None));
    // Asked, with the new project first: a folder name made safe, in the
    // folder that holds the projects Tasktap knows. Nothing is made yet.
    let q =
        a.w.model
            .questions
            .values()
            .find(|q| q.thought_id == Some(t));
    let create = q.unwrap().create.clone().expect("a new project is offered");
    let folder = std::path::PathBuf::from(&create.folder);
    let place = std::fs::canonicalize(folder.parent().unwrap()).unwrap();
    assert_eq!(create.name, "tide-notes");
    assert_eq!(folder.file_name().unwrap(), "tide-notes");
    assert_eq!(place, std::fs::canonicalize(&a.data.0).unwrap());
    assert!(!create.exists && !folder.exists());
    // Its key: the folder is made, opens as a workspace, and the task starts there.
    let add = AddProject {
        id: ProjectId::mint(),
        folder: create.folder.clone(),
        name: None,
        create: true,
    };
    let project = a.w.ok::<call::ProjectAdd>(&add);
    assert!(folder.is_dir());
    a.switch(t, tasktap_proto::Place::Project(project));
    let th = a.w.model.thought(t).clone();
    assert_eq!((th.status, th.project_id), (Status::Routed, Some(project)));
    a.start(t);
    a.w.until("its run has a session", |m| {
        m.thoughts[&t].session_id.is_some()
    });
    // A name that is a project Tasktap knows there is offered as that
    // project; a folder there that is none of its projects never is.
    let offers = |a: &mut Asking, folder: &str| {
        let mut said = answer("new", "", "Start it.");
        said["folder"] = folder.into();
        a.answers(&said);
        let t = a.capture("start a notes app", None);
        a.settled(t);
        let q =
            a.w.model
                .questions
                .values()
                .find(|q| q.thought_id == Some(t));
        q.unwrap().create.clone()
    };
    let known = offers(&mut a, "App").unwrap();
    assert_eq!((known.name.as_str(), known.exists), ("app", true));
    std::fs::create_dir_all(a.data.0.join("music")).unwrap();
    assert_eq!(offers(&mut a, "Music"), None);
    assert_eq!(offers(&mut a, "名前"), None);
}

#[test]
fn undo_takes_back_an_empty_folder_made_for_the_task_and_says_why_one_cannot_be_made() {
    let mut a = Asking::new("unmake");
    a.consent("fixture");
    let mut said = answer("new", "", "Start a tide table app.");
    said["folder"] = "tide-pool".into();
    a.answers(&said);
    let t = a.capture("start a new app for tide tables", None);
    a.settled(t);
    let q =
        a.w.model
            .questions
            .values()
            .find(|q| q.thought_id == Some(t));
    let create = q.unwrap().create.clone().unwrap();
    let add = AddProject {
        id: ProjectId::mint(),
        folder: create.folder.clone(),
        name: None,
        create: true,
    };
    let project = a.w.ok::<call::ProjectAdd>(&add);
    a.switch(t, tasktap_proto::Place::Project(project));
    let folder = std::path::PathBuf::from(&create.folder);
    assert!(folder.is_dir());
    // Undo: the empty folder goes, and the workspace it opened closes.
    a.w.ok::<call::ThoughtStop>(&tasktap_proto::Ref { id: t });
    a.w.until("the workspace closed", |m| !m.projects[&project].open);
    assert!(!folder.exists());
    // A folder that cannot be made says where and why.
    let inside = a.data.0.join("no-such-parent").join("x");
    let add = AddProject {
        id: ProjectId::mint(),
        folder: inside.to_string_lossy().into(),
        name: None,
        create: true,
    };
    let refused = a.w.call::<call::ProjectAdd>(&add).unwrap_err();
    assert!(
        refused
            .message
            .starts_with("Tasktap could not make the folder")
            && refused.message.contains("no-such-parent"),
        "{}",
        refused.message
    );
}

/// Undo takes back a folder made for a task only while nothing else is
/// there (the review's third round): another task placed there keeps it,
/// and once any task has started there it is the person's for good.
#[test]
fn undo_leaves_a_made_folder_where_anything_else_is_there() {
    let mut a = Asking::new("unmake-used");
    a.consent("fixture");
    let mut said = answer("new", "", "Start a tide table app.");
    said["folder"] = "tide-pool".into();
    a.answers(&said);
    let t = a.capture("start a new app for tide tables", None);
    a.settled(t);
    let q =
        a.w.model
            .questions
            .values()
            .find(|q| q.thought_id == Some(t));
    let create = q.unwrap().create.clone().unwrap();
    let add = AddProject {
        id: ProjectId::mint(),
        folder: create.folder.clone(),
        name: None,
        create: true,
    };
    let project = a.w.ok::<call::ProjectAdd>(&add);
    a.switch(t, tasktap_proto::Place::Project(project));
    let folder = std::path::PathBuf::from(&create.folder);
    // Another task placed there: Undo of the first leaves the folder open.
    let other = a.capture("add a readme", Some(project));
    a.w.ok::<call::ThoughtStop>(&tasktap_proto::Ref { id: t });
    a.w.sync();
    assert!(folder.is_dir() && a.w.model.projects[&project].open);
    // That one started there: the folder is the person's; undoing a task
    // placed there later leaves it too.
    a.start(other);
    a.w.until("the readme runs", |m| {
        m.thoughts[&other].session_id.is_some()
    });
    a.switch(t, tasktap_proto::Place::Project(project));
    a.w.ok::<call::ThoughtStop>(&tasktap_proto::Ref { id: t });
    a.w.sync();
    assert!(folder.is_dir() && a.w.model.projects[&project].open);
}

#[test]
fn nothing_that_fits_or_nonsense_asks_the_person() {
    let mut a = Asking::new("unfit");
    a.consent("fixture");
    for said in [
        answer("unknown", "", ""),
        json!({ "confidence": "clear" }),
        answer("new", "", "No folder named."),
    ] {
        a.answers(&said);
        let t = a.capture(SPOKEN, None);
        let th = a.settled(t);
        assert_eq!(
            (th.status, th.mode, th.project_id),
            (Status::NeedsYou, Mode::Ask, None),
            "{said}"
        );
        a.asked_about(t);
    }
}

#[test]
fn the_question_shows_sessions_and_projects_with_what_they_did_and_no_secrets() {
    let mut a = Asking::new("rich");
    a.consent("fixture");
    let key = "ghp_Zq3xY8wV2uT6sR0pO9nM4lK7jI1hG5fE3dC2";
    let secret = format!("deploy with token={key}");
    let s = a.run(a.folio, &secret);
    let t = a.run(a.app, "fix the flaky export test");
    a.answers(&answer("clear", "p1", "Brief."));
    // Said in Tasktap's window with folio in view.
    let id = ThoughtId::mint();
    let capture = Capture {
        agent: Some("fixture".into()),
        view: Some(a.folio),
        ..typed(id, "make the header bigger")
    };
    a.w.ok::<call::ThoughtCapture>(&capture);
    a.settled(id);
    let asked = a.asked().unwrap();
    let text = asked.to_string();
    assert!(!text.contains(key), "{text}");
    // Each session with its first task, state, age and last answer; the one
    // whose text looks like a secret is there, without that text.
    let sessions = asked["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2, "{text}");
    let of = |name: &str| {
        let project = asked["projects"].as_array().unwrap().iter();
        let key = project.clone().find(|p| p["name"] == name).unwrap()["id"].clone();
        sessions
            .iter()
            .find(|s| s["project"] == key)
            .unwrap()
            .clone()
    };
    let (app, folio) = (of("app"), of("folio"));
    assert_eq!(app["first"], "fix the flaky export test");
    let left = json!("deploy with [left out]");
    assert_eq!((&folio["first"], &folio["task"]), (&left, &left));
    // Its last turn began now (the clock stands still), and its agent has
    // answered nothing yet.
    assert_eq!((&app["ago"], &app["summary"]), (&json!("now"), &json!("")));
    for s in [&app, &folio] {
        for field in ["first", "task", "state", "ago", "summary", "agent"] {
            assert!(s.get(field).is_some(), "{field} in {s}");
        }
        assert!(["working", "waiting", "finished"].contains(&s["state"].as_str().unwrap()));
    }
    // The newest last turn first.
    assert_eq!(sessions[0], app);
    // The project in view, first after none named.
    assert_eq!(asked["view"], asked["projects"][0]["id"]);
    assert_eq!(asked["projects"][0]["name"], "folio");
    // From another app, nothing is said of a view.
    a.answers(&answer("clear", "p1", "Brief."));
    let id = a.capture("make the header bigger", None);
    a.settled(id);
    assert_eq!(a.asked().unwrap()["view"], json!(null));
    let _ = (s, t);
}

#[test]
fn where_a_task_ran_in_the_end_is_among_that_projects_earlier_tasks_next_time() {
    let mut a = Asking::new("learn");
    a.consent("fixture");
    let mut said = answer("clear", "p1", "Keep the header on one line.");
    said["title"] = "Header on one line".into();
    a.answers(&said);
    let t = a.capture(SPOKEN, None);
    let placed = a.settled(t).project_id.unwrap();
    // The person moves it to the other project.
    let other = if placed == a.app { a.folio } else { a.app };
    a.switch(t, tasktap_proto::Place::Project(other));
    a.answers(&answer("clear", "p1", "Brief."));
    let next = a.capture("and the footer too", None);
    a.settled(next);
    let asked = a.asked().unwrap();
    let projects = asked["projects"].as_array().unwrap();
    let name = |id: ProjectId| if id == a.app { "app" } else { "folio" };
    let earlier = |n: &str| projects.iter().find(|p| p["name"] == n).unwrap()["earlier"].clone();
    assert_eq!(earlier(name(other)), json!(["Header on one line"]));
    assert_eq!(earlier(name(placed)), json!([]));
}

#[test]
fn an_agreement_to_the_terms_before_asks_again_and_sends_nothing_before_the_yes() {
    let mut a = Asking::new("again");
    a.consent("fixture");
    let Asking {
        core,
        w,
        data,
        app,
        folio,
    } = a;
    drop((w, core));
    // As an agreement under the wording before this one was kept.
    let db = rusqlite::Connection::open(data.0.join("core.db")).unwrap();
    let older = tasktap_core::route::TERMS - 1;
    let set = "UPDATE prefs SET data = json_set(data, '$.value.terms', ?1) WHERE id = 'route_by'";
    assert_eq!(db.execute(set, [older]).unwrap(), 1);
    drop(db);
    let core = Core::with_agents(&data.0);
    let w = core.watch();
    let mut a = Asking {
        core,
        w,
        data,
        app,
        folio,
    };
    a.freeze();
    // Nothing is sent: the match on names places, and says why.
    a.answers(&answer("clear", "p2", "Brief."));
    let t = a.capture("fix the header in folio", None);
    let th = a.settled(t);
    assert_eq!((th.status, th.project_id), (Status::Routed, Some(a.folio)));
    let route = th.route.unwrap();
    assert_eq!(route.by, "local");
    assert!(route.fallback.unwrap().contains("asks you again"));
    assert_eq!(a.asked(), None);
    // The terms to agree to are the new ones; once agreed, a model decides.
    let terms = a.w.ok::<call::RouteTerms>(&tasktap_proto::Empty {});
    assert_eq!(terms.terms, tasktap_core::route::TERMS);
    a.consent("fixture");
    let t = a.capture("fix the header in folio", None);
    assert_eq!(a.settled(t).route.unwrap().by, "fixture");
    a.asked_about(t);
}

// The review of smart placing (2026-11-22): each finding's test.

#[test]
fn switching_the_vehicle_gives_a_new_run_the_persons_words_and_agent_and_back() {
    let mut a = Asking::new("switch-words");
    a.consent("fixture");
    let s = a.run(a.app, "fix the flaky export test");
    a.answers(&follow(
        "s1",
        "also",
        "Also cover an empty export in that test.",
    ));
    let id = ThoughtId::mint();
    let text = "also cover an empty export";
    let capture = Capture {
        agent: Some("codex".into()),
        ..typed(id, text)
    };
    a.w.ok::<call::ThoughtCapture>(&capture);
    let th = a.settled(id);
    assert_eq!(
        (th.session_id, th.agent.as_deref()),
        (Some(s), Some("fixture"))
    );
    assert_eq!(a.asked().unwrap()["thought"], json!(text));
    // A new run by the key: the person's own words, and the agent they chose.
    a.switch(id, tasktap_proto::Place::Project(a.app));
    let th = a.w.model.thought(id).clone();
    assert_eq!(
        (th.session_id, th.brief.as_deref(), th.agent.as_deref()),
        (None, Some(text), Some("codex"))
    );
    // Back: the follow-up as the model decided it.
    a.switch(id, tasktap_proto::Place::Session(s));
    let th = a.w.model.thought(id).clone();
    assert_eq!(
        (th.session_id, th.brief.as_deref(), th.agent.as_deref()),
        (
            Some(s),
            Some("Also cover an empty export in that test."),
            Some("fixture")
        )
    );
}

#[test]
fn a_long_task_placed_by_hand_sends_the_model_the_task_and_that_place_alone() {
    let mut a = Asking::new("picked-alone");
    a.consent("fixture");
    a.run(a.folio, "rotate the staging password to hunter2");
    a.answers(&answer("clear", "p1", "Brief."));
    let t = a.capture(SPOKEN, Some(a.app));
    a.settled(t);
    let asked = a.asked().expect("asked for the brief");
    let names: Vec<_> = asked["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].clone())
        .collect();
    assert_eq!(names, [json!("app")]);
    assert_eq!(asked["picked"], json!("p1"));
    for empty in ["sessions", "recent"] {
        assert_eq!(asked[empty], json!([]), "{empty}");
    }
    assert_eq!(
        (&asked["current"], &asked["view"]),
        (&json!(null), &json!(null))
    );
    assert_eq!(asked["projects"][0]["earlier"], json!([]));
    assert!(!asked.to_string().contains("hunter2"));
}

#[test]
fn a_model_that_cannot_be_reached_leaves_the_question_with_the_place_in_view_first() {
    let mut a = Asking::new("unreached");
    a.consent("fixture");
    a.script(&["exit:1".into()]);
    let id = ThoughtId::mint();
    let capture = Capture {
        agent: Some("fixture".into()),
        view: Some(a.folio),
        ..typed(id, "make the header bigger")
    };
    a.w.ok::<call::ThoughtCapture>(&capture);
    let th = a.settled(id);
    assert_eq!((th.status, th.project_id), (Status::NeedsYou, None));
    let q =
        a.w.model
            .questions
            .values()
            .find(|q| q.thought_id == Some(id));
    let places = q.unwrap().places.clone().unwrap();
    assert_eq!(places[0], tasktap_proto::Place::Project(a.folio));
    assert_eq!(a.asked().unwrap()["view"], json!("p1"));
}

#[test]
fn what_looks_like_a_secret_is_left_out_a_word_at_a_time() {
    use tasktap_core::route::redact;
    let mut wrong = Vec::new();
    // (said, as a model is sent it)
    let out = [
        ("my password is hunter2", "my password is [left out]"),
        ("password hunter2", "password [left out]"),
        ("password to hunter2", "password to [left out]"),
        ("Passwort: Sommer", "Passwort: [left out]"),
        (
            "das Passwort lautet Sommer",
            "das Passwort lautet [left out]",
        ),
        ("Passwort ist Sommer2024", "Passwort ist [left out]"),
        ("password=hunter", "[left out]"),
        // After a password word and a joining word, the sentence's rest,
        // six words at most; a line or a sentence's end stops it.
        (
            "my password is correct horse battery staple",
            "my password is [left out] [left out] [left out] [left out]",
        ),
        (
            "the passphrase is one two three four five six seven",
            "the passphrase is [left out] [left out] [left out] [left out] [left out] [left out] seven",
        ),
        (
            "the password is sunshine. Fix the login",
            "the password is [left out] Fix the login",
        ),
        (
            "password: hunter2\nfix the login",
            "password: [left out]\nfix the login",
        ),
        // A label is never taken for the value.
        (
            "ssh key passphrase: blue-monkey",
            "ssh key passphrase: [left out]",
        ),
        ("token=abc123", "[left out]"),
        ("token=abcdef", "[left out]"),
        ("set the secret to xyz789", "set the secret to [left out]"),
        ("the api key Ab1CdEf", "the api key [left out]"),
        ("the token ghx-0a9f", "the token [left out]"),
        ("the DB_PASS is hunter", "the DB_PASS is [left out]"),
        ("export DB_PASS=s3cr3t now", "export [left out] now"),
        ("MYSQL_PWD=foo", "[left out]"),
        ("PGPASSWORD=hunter2 psql", "[left out] psql"),
        ("SMTPPASS=hunter", "[left out]"),
        ("API_TOKEN: abc", "API_TOKEN: [left out]"),
        ("x-api-key: deadbeefcafe", "x-api-key: [left out]"),
        ("pw: hunter2", "pw: [left out]"),
        ("user root pass hunter2", "user root pass [left out]"),
        ("my pin is 4821", "my pin is [left out]"),
        (
            "login with admin / hunter2",
            "login with admin / [left out]",
        ),
        // In a web address, a user's password and the query's values go;
        // where it leads stays.
        (
            "open https://admin:pw123@db.example.com/x",
            "open https://[left out]@db.example.com/x",
        ),
        (
            "redis://:hunter2@localhost:6379",
            "redis://[left out]@localhost:6379",
        ),
        // Only a parameter that names a secret, or looks like one.
        (
            "curl https://api.example.com/v1/items?api_key=abc&page=2#top",
            "curl https://api.example.com/v1/items?api_key=[left out]&page=2#top",
        ),
        (
            "see https://s3.example.com/f?X-Amz-Signature=ab&code=x&ref=sk-abcdefghijklmnop",
            "see https://s3.example.com/f?X-Amz-Signature=[left out]&code=[left out]&ref=[left out]",
        ),
        // The joiner a few words after "password for".
        (
            "the password for staging is hunter2",
            "the password for staging is [left out]",
        ),
        (
            "the passphrase for the gpg key is correct horse battery staple",
            "the passphrase for the gpg key is [left out] [left out] [left out] [left out]",
        ),
        (
            "set the password for the admin account to hunter2",
            "set the password for the admin account to [left out]",
        ),
        (
            "das Passwort für staging ist Sommer",
            "das Passwort für staging ist [left out]",
        ),
        // A user's password on a command line.
        (
            "curl -u admin:hunter2 https://api.example.com",
            "curl -u [left out] https://api.example.com",
        ),
        (
            "curl --user deploy:s3cret https://api.example.com",
            "curl --user [left out] https://api.example.com",
        ),
        ("curl --user=deploy:s3cret", "curl [left out]"),
        ("use sk-proj-abcdefghijklmnop", "use [left out]"),
        (
            "use ghp_abcdefghijklmnopqrstuvwxyz0123 please",
            "use [left out] please",
        ),
        ("key=xyzAKIAIOSFODNN7EXAMPLE", "[left out]"),
        (
            "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
            "Authorization: Bearer [left out]",
        ),
        (
            "post to https://hooks.slack.com/services/T000/B000/XXXX",
            "post to [left out]",
        ),
        (
            "the jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
            "the jwt [left out]",
        ),
        ("QWxhZGRpbjpvcGVuIHNlc2FtZQBvcGVuIHNlc2FtZQxx", "[left out]"),
        ("ThisIsAVeryLongMixedCaseStringWithoutDigits", "[left out]"),
        ("a1b2c3d4e5f6a7b8c9d0e1f2a3b4", "[left out]"),
    ];
    for (said, sent) in out {
        let got = redact(said);
        if got != sent {
            wrong.push(format!("{said:?} -> {got:?}, not {sent:?}"));
        }
    }
    // The review's (2026-11-22): each loses its secret, and keeps no part
    // of it.
    let left = [
        ("set the db password to hunter2", "hunter2"),
        ("the password is Tr0ub4dor&3", "Tr0ub4dor"),
        ("Passwort ist geheim123", "geheim123"),
        ("pw: hunter2", "hunter2"),
        ("DB_PASS=hunter2", "hunter2"),
        ("MYSQL_PWD=s3cretpass", "s3cretpass"),
        (
            "connect to postgres://admin:Tr0ub4dor@10.0.0.5:5432/app",
            "Tr0ub4dor",
        ),
        (
            "clone https://oauth2:glpat-abcdefghij1234567890@gitlab.com/x/y.git",
            "glpat",
        ),
        (
            "curl https://api.example.com/v1/items?api_key=abc123def456",
            "abc123",
        ),
        (
            "curl https://api.example.com/v1/items?key=abc123def456ghi",
            "abc123",
        ),
        (
            "curl -H 'Authorization: Bearer abc123def456ghi789'",
            "abc123",
        ),
        ("Authorization: Bearer 7f3a9c2e1b", "7f3a9c2e1b"),
        (
            concat!(
                "post to https://hooks.slack.com/services/T0123ABCD",
                "/B0123ABCD/abcdefghijklmnopqrstuvwx"
            ),
            "T0123ABCD",
        ),
        (
            "AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
            "abcdefghij",
        ),
        ("-----BEGIN OPENSSH PRIVATE KEY-----", "BEGIN"),
        ("my password is correct horse battery staple", "horse"),
        ("the wifi password is sunshine", "sunshine"),
        ("das Passwort lautet Sommer2024!", "Sommer2024"),
        ("login with admin / hunter2", "hunter2"),
        ("use password hunter2 for staging", "hunter2"),
        ("user root pass hunter2", "hunter2"),
        ("set GITHUB_TOKEN to ghp_abc", "ghp_abc"),
        ("export OPENAI_API_KEY=sk-proj-abc123", "sk-proj"),
        ("the stripe key is rk_test_51Habc", "rk_test"),
        ("the api key is 3f9a1c2b4d5e6f70", "3f9a1c2b4d5e6f70"),
        ("token=abcdef", "abcdef"),
        ("secret: hunter2", "hunter2"),
        ("redis://:hunter2@localhost:6379", "hunter2"),
        ("mongodb+srv://user:pa55@cluster0.mongodb.net", "pa55"),
        ("PGPASSWORD=hunter2 psql", "hunter2"),
        ("auth-token: abc123", "abc123"),
        ("x-api-key: deadbeefcafe", "deadbeefcafe"),
        ("my pin is 4821", "4821"),
        ("ssh key passphrase: blue-monkey", "blue-monkey"),
    ];
    for (said, secret) in left {
        let got = redact(said);
        if got.contains(secret) || !got.contains("[left out]") {
            wrong.push(format!("{said:?} -> {got:?} keeps {secret:?}"));
        }
    }
    let kept = [
        "fix the flaky export test",
        "make the rehearsal timer readable on mobile",
        "rename getUserById to findUserById",
        "bump the version to 1.2.3",
        "the README links to https://example.com/docs/setup",
        "src/components/Header.tsx wraps on small screens",
        "use the useCallback hook in SettingsPanel",
        "the passwordless login is broken",
        "check the keyboard shortcuts",
        "in folio, the login from before",
        // Key, token and secret are words of everyday tasks.
        "fix the key handler",
        "the token count is wrong",
        "rename secret santa list",
        "primary key column",
        "the auth-token is expired",
        "fix the key handler's bug",
        "set the secret to xyz",
        "the key is wrong",
        // A password's field, not a password.
        "make the password field wider",
        "the password reset mail is late",
        // Pass and pin are verbs too.
        "make the tests pass to unblock the release",
        "pin react to the last minor",
        // The review's (2026-11-22).
        "the token count is too high",
        "fix the key handler in the editor",
        "the secret santa list needs sorting",
        "add a password field to the signup form",
        "the password reset email is broken",
        "password strength meter shows red for hunter2-like words",
        "rename the auth-token header to x-auth",
        "the key is to cache the results",
        "the token is expired after 5 minutes",
        "the secret is in the sauce",
        "look at src/components/HeaderNavigation2",
        "the passwords don't match message is wrong",
        "show the key: value pairs in a table",
        "token: rotate it",
        "secret: santa list",
        "migrate to python3.12 and node20",
        "bump react-router-dom to 6.22.3",
        "the user's key handler",
        "set the timeout to 30s",
        "Passwort vergessen link is broken",
        "credentials are stored in the keychain",
        "the credentials page is blank",
        "image sha256:9b2f0c1d3e4a5b6c7d8e9f00112233445566778899aabbccddeeff0011223344",
        // A search's words and a page's number place the task.
        "open https://example.com/search?q=invoice+export&page=2",
        // "password for" a joiner further on than five words, or in the next
        // sentence, says nothing of a password.
        "the password for the new admin user that we add is fine",
        "check the password for staging. It is broken",
        "git add -u src",
    ];
    for said in kept {
        let got = redact(said);
        if got != said {
            wrong.push(format!("{said:?} -> {got:?}, not kept"));
        }
    }
    // What it still leaves out, as agreed: a hash, a UUID, the words after
    // "password is" or "password:", a very long name.
    let over = [
        "revert 3f9a1c2b4d5e6f708192a3b4c5d6e7f8091a2b3c",
        "uuid 550e8400-e29b-41d4-a716-446655440000 not found",
        "the password is too short error appears twice",
        "make the password: field optional",
        "useInfiniteScrollPagination2Hook breaks",
        "ENABLE_FEATURE_FLAG_FOR_BETA_USERS_2024=true",
        "the test test_user_can_reset_password_with_valid_token2 fails",
    ];
    for said in over {
        let got = redact(said);
        if !got.contains("[left out]") {
            wrong.push(format!("{said:?} -> {got:?}, kept after all"));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

#[test]
fn a_new_projects_name_is_safe_on_every_system_and_its_place_never_an_unknown_folder() {
    use tasktap_core::route::{create, folder_name};
    let named = [
        ("Tide Notes", Some("tide-notes")),
        ("../evil", Some("evil")),
        ("..", None),
        ("...", None),
        (".hidden", Some("hidden")),
        ("-rf", Some("rf")),
        (".. notes", Some("notes")),
        ("con", None),
        ("lpt1", None),
        ("COM3", None),
        ("nul.txt", Some("nul-txt")),
        ("a/b", Some("a-b")),
        ("C:\\Windows\\System32", Some("c-windows-system32")),
        ("foo\u{202E}gpj.exe", Some("foo-gpj-exe")),
        ("名前", None),
        ("🚀", None),
        ("", None),
        ("   ", None),
        ("x.", Some("x")),
    ];
    for (proposed, want) in named {
        assert_eq!(folder_name(proposed).as_deref(), want, "{proposed:?}");
    }
    assert_eq!(folder_name(&"a".repeat(300)).unwrap().len(), 40);
    // Projects right in the home folder: a folder there that is none of them
    // (~/Music) is never offered; a project's own folder is, as it.
    let home = Folder::new("home-place");
    for f in ["tapped", "earshot", "music"] {
        std::fs::create_dir_all(home.0.join(f)).unwrap();
    }
    let unsure = Route::Ambiguous {
        prompt: "Which project is this task for?".into(),
        candidates: Vec::new(),
        brief: None,
    };
    let proposed = |name: &str| Route::Create {
        prompt: String::new(),
        project: tasktap_proto::NewProject {
            name: name.into(),
            place: String::new(),
            folder: String::new(),
            exists: false,
        },
        candidates: Vec::new(),
        brief: Some("Start it.".into()),
    };
    let known = |f: &std::path::Path| f.ends_with("tapped") || f.ends_with("earshot");
    assert_eq!(
        create(proposed("music"), Some(&home.0), &unsure, known),
        unsure
    );
    let Route::Create { project, .. } = create(proposed("tapped"), Some(&home.0), &unsure, known)
    else {
        panic!("a project Tasktap knows is offered");
    };
    assert!(project.exists);
    let Route::Create { project, .. } =
        create(proposed("tide-pool"), Some(&home.0), &unsure, known)
    else {
        panic!("a new name is offered");
    };
    assert!(!project.exists && project.folder.ends_with("tide-pool"));
}

#[test]
fn a_projects_top_is_its_folders_and_well_known_files_read_in_bounded_time() {
    use tasktap_core::route::{top_of, tops};
    let d = Folder::new("tops");
    for f in ["src", "docs", ".git"] {
        std::fs::create_dir_all(d.0.join(f)).unwrap();
    }
    for f in [
        "package.json",
        "README.md",
        "secret-plan.txt",
        "notes.md",
        "CLAUDE.md",
    ] {
        std::fs::write(d.0.join(f), "").unwrap();
    }
    let place = Destination::New(ProjectId::mint());
    let folder = d.0.to_string_lossy().into_owned();
    let began = std::time::Instant::now();
    let read = tops(vec![(place, folder)], std::time::Duration::from_millis(400));
    assert!(began.elapsed() < std::time::Duration::from_secs(2));
    let want = ["CLAUDE.md", "README.md", "docs", "package.json", "src"];
    assert_eq!(read, [(place, want.map(String::from).to_vec())]);
    // The same function the routing lab gives its corpus's lists.
    let listed = [
        ("src", true),
        ("docs", true),
        (".git", true),
        ("package.json", false),
        ("README.md", false),
        ("secret-plan.txt", false),
        ("notes.md", false),
        ("CLAUDE.md", false),
    ];
    assert_eq!(top_of(listed.map(|(n, f)| (n.to_owned(), f))), want);
}

/// The routing lab's top of a corpus project is what the product sends for
/// that project on the disk (the review's third round): a name without a
/// dot is a folder, unless it is a well-known file (gradlew, Brewfile,
/// Procfile, CNAME, Jenkinsfile, Snakefile, Makefile, Dockerfile, LICENSE).
#[test]
fn the_labs_top_of_a_corpus_project_is_what_the_product_reads_from_its_disk() {
    use tasktap_core::route::{folder_named, top_of, tops};
    let files = [
        "gradlew",
        "Brewfile",
        "Procfile",
        "CNAME",
        "Jenkinsfile",
        "Snakefile",
        "Makefile",
        "Dockerfile",
        "LICENSE",
        "README",
        "PROJECT",
        "artisan",
        "_redirects",
    ];
    for f in files {
        assert!(!folder_named(f), "{f}");
    }
    for f in ["src", "R", "Mods-Profile", "2023", "node_modules"] {
        assert!(folder_named(f), "{f}");
    }
    // Every project of the corpus, laid out on the disk as it is: the files
    // above files, every other name without a dot a folder.
    let corpus = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/lab/corpus.json");
    let corpus: Value = serde_json::from_str(&std::fs::read_to_string(corpus).unwrap()).unwrap();
    fn lists(v: &Value, out: &mut Vec<Vec<String>>) {
        match v {
            Value::Object(o) => {
                if let Some(Value::Array(top)) = o.get("top") {
                    out.push(
                        top.iter()
                            .filter_map(|n| n.as_str().map(String::from))
                            .collect(),
                    );
                }
                o.values().for_each(|v| lists(v, out));
            }
            Value::Array(a) => a.iter().for_each(|v| lists(v, out)),
            _ => {}
        }
    }
    let mut all = Vec::new();
    lists(&corpus, &mut all);
    assert!(all.len() > 10, "{}", all.len());
    for (i, top) in all.iter().enumerate() {
        let d = Folder::new(&format!("lab-top-{i}"));
        for n in top {
            let real = !n.contains('.') && !files.contains(&n.as_str());
            match real {
                true => std::fs::create_dir_all(d.0.join(n)).unwrap(),
                false => std::fs::write(d.0.join(n), "").unwrap(),
            }
        }
        let place = Destination::New(ProjectId::mint());
        let folder = d.0.to_string_lossy().into_owned();
        let read = tops(vec![(place, folder)], std::time::Duration::from_secs(2));
        let read = read
            .into_iter()
            .next()
            .map(|(_, names)| names)
            .unwrap_or_default();
        let lab = top_of(top.iter().map(|n| (n.clone(), folder_named(n))));
        assert_eq!(lab, read, "{top:?}");
    }
}

/// Said in Tasktap's window, the chip's default stays as released: a
/// workspace in view is the place, a session in view the follow-up, with
/// nothing sent and the hold from the capture, as at e1443fd. Auto chosen
/// there asks the model and tells it the view.
#[test]
fn in_tasktaps_window_the_place_in_view_goes_at_once_and_auto_asks_the_model() {
    let mut a = Asking::new("in-window");
    a.consent("fixture");
    let hold = |th: &Thought| th.hold_until.map(|h| h.get() - th.created.get());
    // A workspace in view: the chip names it, a pick.
    let t = a.capture("fix the header", Some(a.app));
    let th = a.w.model.thought(t).clone();
    assert_eq!(
        (th.status, th.project_id, th.placed),
        (Status::Routed, Some(a.app), Some(Placed::Picked))
    );
    assert_eq!(hold(&th), Some(5000));
    assert_eq!(a.asked(), None);
    // The chip names the workspace because the names say nothing sure: the
    // hint says nothing, as at e1443fd, though a model is agreed to.
    let app = a.app;
    let hint = |text: &str, current| Hint {
        text: text.into(),
        current,
        view: Some(app),
    };
    let unknown = tasktap_proto::Route::Unknown;
    assert_eq!(
        a.w.ok::<call::RouteHint>(&hint("fix the header", None)),
        unknown
    );
    // Words that name another project are the chip's place there, and the
    // names place the task, nothing sent.
    let named =
        a.w.ok::<call::RouteHint>(&hint("in folio, fix the login", None));
    assert!(
        matches!(named, tasktap_proto::Route::Clear { .. }),
        "{named:?}"
    );
    let id = ThoughtId::mint();
    let capture = Capture {
        agent: Some("fixture".into()),
        view: Some(a.app),
        ..typed(id, "in folio, fix the login")
    };
    a.w.ok::<call::ThoughtCapture>(&capture);
    let th = a.settled(id);
    assert_eq!((th.status, th.project_id), (Status::Routed, Some(a.folio)));
    assert_eq!(hold(&th), Some(5000));
    assert_eq!(th.route.unwrap().by, "local");
    assert_eq!(a.asked(), None);
    // A session in view: the chip says the follow-up; the session gets it,
    // no words needed to lean on it.
    let s = a.run(a.app, "fix the flaky export test");
    let hint = hint("make the empty case pass", Some(s));
    let follows = tasktap_proto::Route::Clear {
        to: tasktap_proto::Place::Session(s),
        brief: "make the empty case pass".into(),
        said: None,
    };
    assert_eq!(a.w.ok::<call::RouteHint>(&hint), follows);
    let id = ThoughtId::mint();
    let capture = Capture {
        agent: Some("fixture".into()),
        current: Some(s),
        view: Some(a.app),
        ..typed(id, "make the empty case pass")
    };
    a.w.ok::<call::ThoughtCapture>(&capture);
    let th = a.settled(id);
    assert_eq!(
        (th.status, th.session_id, th.placed),
        (Status::Routed, Some(s), Some(Placed::FollowUp))
    );
    assert_eq!(hold(&th), Some(5000));
    assert_eq!(a.asked(), None);
    // Auto chosen there: the model decides, told the session and the
    // workspace in view.
    a.answers(&answer("clear", "p1", "Make the empty case pass."));
    let id = ThoughtId::mint();
    let capture = Capture {
        agent: Some("fixture".into()),
        current: Some(s),
        view: Some(a.app),
        auto: true,
        ..typed(id, "make the empty case pass")
    };
    a.w.ok::<call::ThoughtCapture>(&capture);
    let th = a.settled(id);
    assert_eq!(th.route.unwrap().by, "fixture");
    let asked = a.asked().unwrap();
    assert_eq!(
        (&asked["current"], &asked["view"]),
        (&json!("s1"), &json!("p1"))
    );
}

/// A folder whose read hangs is not read again while it does (the review's
/// third round): one reading thread per folder, and the folder is sent
/// without names until its read returns.
#[test]
fn a_folder_whose_read_hangs_is_not_read_again_meanwhile() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tasktap_core::route::tops_by;
    use tasktap_core::state::Destination;
    let reads = Arc::new(AtomicUsize::new(0));
    let (open, gate) = std::sync::mpsc::channel::<()>();
    let gate = Arc::new(Mutex::new(gate));
    let read = {
        let (reads, gate) = (reads.clone(), gate.clone());
        move |_: &str| {
            // The first read hangs until let go; later ones answer at once.
            if reads.fetch_add(1, Ordering::SeqCst) == 0 {
                let _ = gate.lock().unwrap().recv();
            }
            vec!["src".to_owned()]
        }
    };
    let folder = "/hangs/in/the/system/for/this/test".to_owned();
    let place = Destination::New(ProjectId::mint());
    let ask = |within| tops_by(vec![(place, folder.clone())], within, read.clone());
    assert_eq!(ask(Duration::from_millis(50)), []);
    // Asked again while it hangs: not read again, sent without names.
    assert_eq!(ask(Duration::from_millis(50)), []);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    // Its read returned: read again.
    open.send(()).unwrap();
    let back = std::time::Instant::now() + Duration::from_secs(5);
    let mut got = Vec::new();
    while got.is_empty() && std::time::Instant::now() < back {
        got = ask(Duration::from_millis(200));
    }
    assert_eq!(got, [(place, vec!["src".to_owned()])]);
    assert_eq!(reads.load(Ordering::SeqCst), 2);
}

/// After a restart, each task that waits for the person has its
/// notification, and none is left standing for one that no longer waits
/// (the review's third round): a host that comes is told every thought that
/// waits now, then each one's.
#[test]
fn after_a_restart_every_task_that_waits_is_told_and_no_other() {
    let mut a = Asking::new("restart-waits");
    a.consent("fixture");
    // Torn: it waits for a key.
    let mut said = answer("ambiguous", "", "Keep the header on one line.");
    said["candidates"] = json!(["p2", "p1"]);
    a.answers(&said);
    let torn = a.capture(SPOKEN, None);
    a.settled(torn);
    // A decision held: it will wait for Return once Tasktap starts again.
    a.answers(&answer("clear", "p1", "Make the header bigger."));
    let held = a.capture("make the header bigger", None);
    assert!(a.settled(held).hold_until.is_some());
    // One that started waits for nothing.
    let ran = a.capture("fix the footer", Some(a.app));
    a.start(ran);
    a.w.until("it runs", |m| m.thoughts[&ran].session_id.is_some());
    a.restart();
    assert_eq!(a.w.model.thought(held).hold_until, None);
    let stream = tasktap_core::client::connect(&a.data.0).unwrap();
    #[cfg(unix)]
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(20)))
        .unwrap();
    let hello = tasktap_proto::Hello {
        v: tasktap_proto::Versions(tasktap_proto::VERSION, tasktap_proto::VERSION),
        role: tasktap_proto::Role::Host,
        client: "test host".into(),
        auth: None,
        abilities: vec!["host.notify".into()],
    };
    let mut host = tasktap_core::client::Client::hello(stream, hello)
        .unwrap()
        .unwrap();
    let mut told = || loop {
        match host.recv().unwrap() {
            tasktap_proto::Frame::Control(tasktap_proto::Control::Call(r))
                if r.name == "host.notify" =>
            {
                break <call::HostNotify as tasktap_proto::call::Call>::args(r.args).unwrap();
            }
            _ => continue,
        }
    };
    let all = told();
    let mut waiting = all.waiting.unwrap();
    waiting.sort();
    let mut want = vec![torn, held];
    want.sort();
    assert_eq!(waiting, want);
    let mut each: Vec<_> = (0..2).map(|_| told()).collect();
    each.sort_by_key(|n| n.thought);
    assert!(
        each.iter()
            .all(|n| n.title == "Which project is this task for?" && !n.withdrawn)
    );
    let mut thoughts: Vec<_> = each.iter().filter_map(|n| n.thought).collect();
    thoughts.sort();
    assert_eq!(thoughts, want);
    // Started from the line after the restart, it waits no more.
    a.start(held);
    let taken = told();
    assert_eq!((taken.thought, taken.withdrawn), (Some(held), true));
}

#[test]
fn a_model_is_always_given_where_the_last_task_went_and_the_two_worked_on_most_recently() {
    // Twelve projects; the first six have earlier tasks that share words
    // with the thought, the last three are the ones worked on lately.
    let names = [
        "alder", "birch", "cedar", "dogwood", "elm", "fir", "gorse", "hazel", "ivy", "juniper",
        "kauri", "larch",
    ];
    let now: u64 = 1_800_000_000_000;
    let day = 86_400_000;
    let projects: Vec<Named> = (names.iter().enumerate())
        .map(|(i, name)| Named {
            used: tasktap_proto::Time::new(now - (11 - i as u64) * day),
            ..Named::open(ProjectId::mint(), name, &[])
        })
        .collect();
    let to = |name: &str| projects.iter().find(|p| p.name == name).unwrap().to;
    let earlier = projects
        .iter()
        .take(6)
        .map(|p| (p.to, vec!["calibrate zorble flimmer quanta".to_string()]))
        .collect();
    let r = Request {
        text: "calibrate the zorble flimmer quanta again".into(),
        projects: projects.clone(),
        last: Some(to("ivy")),
        earlier,
        ..Request::default()
    };
    let given =
        |r: &Request| -> Vec<String> { r.projects.iter().map(|p| p.name.clone()).collect() };
    // Where the last task went, then the two worked on most recently, then
    // those whose earlier tasks the words are like.
    let shown = given(&order(r.clone()));
    assert_eq!(
        shown,
        [
            "ivy", "larch", "kauri", "fir", "elm", "dogwood", "cedar", "birch"
        ]
    );
    // With no record of either, nothing is put first.
    let none = Request {
        last: None,
        projects: projects
            .iter()
            .map(|p| Named {
                used: None,
                ..p.clone()
            })
            .collect(),
        ..r
    };
    assert_eq!(
        given(&order(none)),
        [
            "fir", "elm", "dogwood", "cedar", "birch", "alder", "larch", "kauri"
        ]
    );
}

/// A question about `projects`, each at the folder given, with what `seeds`
/// says of earlier tasks in the store: `earlier` of each, as a model reads it.
fn earlier_of(
    seeds: &[(&str, &str)],
    projects: &[(&str, &str)],
) -> (String, Vec<(String, Vec<String>)>) {
    let data = Folder::new("seeded");
    let (mut store, _) = Store::open(&data.0.join("core.db"), time(wall_ms())).unwrap();
    let mut tx = store.begin().unwrap();
    let rows: Vec<_> = (seeds.iter().enumerate())
        .map(|(i, (folder, text))| ((*folder).to_owned(), 1_000 - i as u64, (*text).to_owned()))
        .collect();
    tx.replace_seeds("claude", &rows).unwrap();
    let named = projects.iter().map(|(name, folder)| Named {
        folder: (*folder).into(),
        ..Named::open(ProjectId::mint(), name, &[])
    });
    let r = Request {
        text: "fix the cue timer".into(),
        projects: named.collect(),
        ..Request::default()
    };
    let r = tasktap_core::route::narrow(&tx, r, time(wall_ms())).unwrap();
    let asked = tasktap_core::route::question(&r);
    let said = asked.split("<request>\n").nth(1).unwrap();
    let said: Value = serde_json::from_str(said.trim_end().trim_end_matches("</request>")).unwrap();
    let of = (said["projects"].as_array().unwrap().iter())
        .map(|p| {
            let all = p["earlier"].as_array().unwrap();
            let all = all.iter().map(|t| t.as_str().unwrap().to_owned());
            (p["name"].as_str().unwrap().to_owned(), all.collect())
        })
        .collect();
    (asked, of)
}

#[test]
fn earlier_requests_from_agents_fill_a_projects_earlier_tasks_up_to_five_and_pass_the_secret_filter()
 {
    let projects = [("cuegrid", "/h/cuegrid"), ("kiln", "/h/kiln")];
    let key = concat!("sk-", "proj", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4");
    let token = concat!("ghp_", "0123456789abcdefghij", "ABCDEFGHIJ0123456789");
    let rotate = format!("Rotate {key} in the deploy file");
    let paste = format!("Use token {token} for the release");
    let (asked, of) = earlier_of(
        &[
            ("/h/cuegrid", "Add the cue timer"),
            ("/h/kiln", "Tune the ramp"),
            ("/h/cuegrid", &rotate),
            ("/h/cuegrid", &paste),
            ("/h/cuegrid", "Make the list scroll"),
            ("/h/cuegrid", "Show the cue count"),
            ("/h/cuegrid", "Never shown, past five"),
        ],
        &projects,
    );
    // The newest five, never more; the secret-shaped words are left out.
    let five = [
        "Add the cue timer",
        "Rotate [left out] in the deploy file",
        "Use token [left out] for the release",
        "Make the list scroll",
        "Show the cue count",
    ];
    assert_eq!(
        of[0],
        ("cuegrid".to_owned(), five.map(String::from).to_vec())
    );
    assert_eq!(of[1].1, ["Tune the ramp"]);
    assert!(!asked.contains(key) && !asked.contains(token));
    // With no history, or one of other folders, the question is what it is
    // with none at all, byte for byte.
    let (none, of) = earlier_of(&[], &projects);
    assert!(of.iter().all(|(_, e)| e.is_empty()));
    let (elsewhere, _) = earlier_of(&[("/h/other", "Not for these projects")], &projects);
    assert_eq!(elsewhere, none);
    assert!(none.contains(r#""earlier":[]"#));
}

#[test]
fn a_persons_own_tasks_come_first_among_a_projects_earlier_tasks_and_a_seeded_one_makes_no_session_nor_recent_task()
 {
    let mut a = Asking::new("seeds-after");
    a.consent("fixture");
    let mut said = answer("clear", "p1", "Keep the header on one line.");
    said["title"] = "Header on one line".into();
    a.answers(&said);
    let t = a.capture(SPOKEN, None);
    let placed = a.settled(t).project_id.unwrap();
    let other = if placed == a.app { a.folio } else { a.app };
    a.switch(t, tasktap_proto::Place::Project(other));
    let app = a.app;
    let name = |id: ProjectId| if id == app { "app" } else { "folio" };
    // Tasktap stops; what the agents' histories gave is kept beside its own
    // records, in the project's folder; Tasktap starts again.
    let retire = tasktap_proto::Retire {
        when: tasktap_proto::When::Now,
    };
    a.core
        .device()
        .call::<call::CoreRetire>(&retire)
        .unwrap()
        .unwrap();
    a.core.wait();
    let (mut store, _) = Store::open(&a.data.0.join("core.db"), time(wall_ms())).unwrap();
    let mut tx = store.begin().unwrap();
    let folders = tx.folders().unwrap();
    let at = |n: &str| folders.iter().find(|f| f.ends_with(n)).unwrap().clone();
    let rows = [
        (at(name(other)), 5, "Header on one line".to_owned()),
        (at(name(other)), 4, "Set up the footer".to_owned()),
        (at(name(other)), 3, "Add a menu".to_owned()),
        (at(name(other)), 2, "Fix the logo".to_owned()),
        (at(name(other)), 1, "Check the colours".to_owned()),
        (at(name(placed)), 6, "Plan the release".to_owned()),
    ];
    tx.replace_seeds("claude", &rows).unwrap();
    tx.commit().unwrap();
    drop(store);
    a.core = Core::with_agents(&a.data.0);
    a.w = a.core.watch();
    a.freeze();
    a.answers(&answer("clear", "p1", "Brief."));
    let next = a.capture("and the footer too", None);
    a.settled(next);
    let asked = a.asked().unwrap();
    let projects = asked["projects"].as_array().unwrap();
    let earlier = |n: &str| projects.iter().find(|p| p["name"] == n).unwrap()["earlier"].clone();
    // The person's own task first, the same words once, then the newest
    // seeded ones, five in all.
    assert_eq!(
        earlier(name(other)),
        json!([
            "Header on one line",
            "Set up the footer",
            "Add a menu",
            "Fix the logo",
            "Check the colours"
        ])
    );
    // Of a project the person has no task in, only the seeded one.
    assert_eq!(earlier(name(placed)), json!(["Plan the release"]));
    // No session and no recent task is made of one.
    let sessions = asked["sessions"].as_array().unwrap();
    let recent = asked["recent"].as_array().unwrap();
    let said_all = serde_json::to_string(&[sessions, recent]).unwrap();
    assert!(!said_all.contains("Plan the release") && !said_all.contains("Add a menu"));
}

fn place(name: &str) -> Candidate {
    Candidate {
        label: name.into(),
        to: Destination::New(ProjectId::mint()),
        why: String::new(),
    }
}

#[test]
fn a_question_is_filled_up_to_three_places_with_the_finders_the_models_first() {
    let (a, b, c, d) = (
        place("harbormaster"),
        place("tide-notes"),
        place("kelp"),
        place("reef"),
    );
    let mut found = [b.clone(), c.clone(), d.clone()].map(|mut p| {
        p.why = "matches “tide”".into();
        p
    });
    // None from the model: the finder's, in its order.
    let mut got = Vec::new();
    fill(&mut got, &found);
    assert_eq!(got, found);
    // One: it stays first, the finder's follow, three in all.
    let mut got = vec![a.clone()];
    fill(&mut got, &found);
    assert_eq!(got, [a.clone(), found[0].clone(), found[1].clone()]);
    // Three: nothing is added.
    let mut three = vec![a.clone(), d.clone(), place("moss")];
    let before = three.clone();
    fill(&mut three, &found);
    assert_eq!(three, before);
    // A found place equal to the model's choice is there once, in the model's place.
    found[0].to = a.to;
    let mut got = vec![a.clone(), d.clone()];
    fill(&mut got, &found);
    assert_eq!(got, [a.clone(), d, found[1].clone()]);
    // Nothing found: the question stays as it was.
    let mut got = vec![a.clone()];
    fill(&mut got, &[]);
    assert_eq!(got, [a]);
}

#[test]
fn the_finders_places_are_the_projects_the_thoughts_words_name_or_describe() {
    let named = |name: &str, about: &str| Named {
        about: about.into(),
        ..Named::open(ProjectId::mint(), name, &[])
    };
    let r = Request {
        text: "the harbormaster tide chart is wrong".into(),
        projects: vec![
            named("harbormaster", "Berth plans and tide charts"),
            named("tide-notes", "Notes on tides"),
            named("quarry", "Stone counts"),
        ],
        words: fixture_words(),
        ..Request::default()
    };
    let found = finds(&r);
    let said: Vec<_> = (likely(&r, CHOICES).into_iter())
        .map(|(p, why)| (p.name.clone(), why))
        .collect();
    assert!(!found.is_empty() && found.len() <= CHOICES);
    assert_eq!(
        found
            .iter()
            .map(|c| (c.label.clone(), c.why.clone()))
            .collect::<Vec<_>>(),
        said,
        "one finder, one order"
    );
    let Route::Ambiguous { candidates, .. } = unsure(&r) else {
        panic!("asked")
    };
    assert!(candidates.iter().any(|c| c.label == "harbormaster"));
    // Words that point at nothing find nothing, and the question has no places.
    let r = Request {
        text: "zzz qqq".into(),
        ..r
    };
    assert_eq!(finds(&r), []);
}

#[test]
fn a_model_torn_or_unknowing_leaves_a_question_filled_with_the_places_the_words_name() {
    let said = "move the folio header and the app menu down";
    let mut a = Asking::new("fills");
    a.consent("fixture");
    // Torn on one place: it stands first, the project the words also name beside it.
    let mut torn = answer("ambiguous", "", "Move both.");
    torn["candidates"] = json!(["p1"]);
    a.answers(&torn);
    let t = a.capture(said, None);
    let th = a.settled(t);
    let first = th.project_id.expect("placed in the first");
    let others = th.route.as_ref().unwrap().others.clone();
    let other = if first == a.app { a.folio } else { a.app };
    assert_eq!(others, [tasktap_proto::Place::Project(other)]);
    // Unknown: the question carries both, each with the finder's reason.
    a.answers(&answer("unknown", "", ""));
    let u = a.capture(said, None);
    a.w.until("asked", |m| m.thought(u).status == Status::NeedsYou);
    let q = (a.w.model.questions.values())
        .find(|q| q.thought_id == Some(u))
        .expect("asked");
    let mut places = q.places.clone().unwrap();
    places.sort_by_key(|p| format!("{p:?}"));
    let mut both = vec![
        tasktap_proto::Place::Project(a.app),
        tasktap_proto::Place::Project(a.folio),
    ];
    both.sort_by_key(|p| format!("{p:?}"));
    assert_eq!(places, both);
    assert_eq!(q.notes.as_ref().map(Vec::len), Some(2));
    // The record keeps the question: what it offered, then the row taken by its key.
    let q = q.clone();
    a.w.ok::<call::QuestionAnswer>(&tasktap_proto::AnswerQuestion {
        id: q.id,
        response: Response::Choice { choice: 1 },
    });
    a.w.sync();
    let entries = tasktap_core::placings::read(&a.data.0);
    let e = entries
        .iter()
        .find(|e| e["id"] == u.uuid().to_string())
        .expect("the question is in the record");
    assert_eq!(e["offered"].as_array().map(Vec::len), Some(2), "{e}");
    assert_eq!(
        (e["did"].as_str(), e["choice"].as_u64()),
        (Some("row"), Some(2))
    );
}
