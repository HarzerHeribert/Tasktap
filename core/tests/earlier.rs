//! This build's client against a core of Tasktap 2.0.0 that an update leaves
//! running while its terminals last. `TASKTAP_EARLIER_CORE` names a 2.0.0
//! core built with the fixtures (its agents and `fixture.*` calls are what
//! this harness expects); without it every test skips. Made-up names and
//! temporary folders only. With `TASKTAP_EARLIER_RECORDS` naming a file, the
//! scenario writes there the rows of every collection as the 2.0.0 core sent
//! them on the wire.

mod common;

use common::*;
use serde_json::{Map, Value, json};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tasktap_core::client;
use tasktap_proto::call::{self, Call, Code};
use tasktap_proto::{
    AddProject, AnswerQuestion, AttemptId, Auth, CallId, Candidate, Capture, Changes, Control,
    DetectAgents, DeviceId, Empty, Hello, Hint, Isolate, Place, PrefPatch, ProjectId, ProjectPatch,
    Put, PutTarget, QuestionSource, QuestionState, Ref, Register, Response, Role, Route, Secret,
    SessionId, Settle, StartTerminal, Status, Subscribe, TerminalId, ThoughtId, VERSION, Versions,
    Weight,
};

/// The calls only this build has.
const NEWER: [&str; 9] = [
    "route.guess",
    "route.preview",
    "placings.count",
    "placings.clear",
    "chatgpt.sign_in",
    "chatgpt.sign_out",
    "own_model.set",
    "own_model.remove",
    "own_model.list",
];

fn patience() -> Duration {
    Duration::from_secs(120)
}

/// A scene on a 2.0.0 core, whose fixture agents are its own build; with a
/// `repo`, its project is that folder, and git is the test's own.
fn scene(exe: &Path, prefix: &str, repo: Option<&Path>, agent: &str) -> Scene {
    let data = Folder::new(prefix);
    let path = path_with(&agents_of(exe, &data.0));
    let config = data.0.join("gitconfig");
    std::fs::write(&config, "").unwrap();
    let env = [
        ("PATH", path.as_str()),
        ("GIT_CONFIG_GLOBAL", config.to_str().unwrap()),
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("SHELL", "/bin/sh"),
    ];
    let core = Core::start_exe(exe, &data.0, &[], &env, patience());
    match repo {
        Some(repo) => Scene::in_folder(core, data, repo, agent),
        None => Scene::on(core, data).running(agent),
    }
}

/// The agent the launch started, as a person sees it in its terminal.
fn screen(s: &mut Scene, t: ThoughtId) -> Screen {
    s.w.until("its launch stored its terminal", |m| {
        let session = m.thoughts[&t].session_id;
        session.is_some_and(|id| m.sessions[&id].terminal_id.is_some())
    });
    let session = s.w.model.thought(t).session_id.unwrap();
    let terminal = s.w.model.session(session).terminal_id.unwrap();
    let mut screen = Screen::open(&s.core, terminal);
    screen.until("fixture-agent --hook");
    screen
}

/// A thought placed in the scene's project, launched after its hold.
fn launched(s: &mut Scene, c: Capture) -> (ThoughtId, SessionId) {
    let t = c.id;
    s.w.ok::<call::ThoughtCapture>(&c);
    assert_eq!(s.w.model.status(t), Status::Routed);
    s.tick(HOLD_MS);
    s.w.until("it works", |m| m.status(t) == Status::Working);
    (t, s.w.model.thought(t).session_id.unwrap())
}

/// The rows of every collection, as the core wrote them: a plain connection
/// that subscribes and keeps the frames as JSON.
fn on_the_wire(core: &Core) -> Value {
    let mut stream = client::connect(&core.data).unwrap();
    #[cfg(unix)]
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    let auth = Auth::Device {
        device: DeviceId::mint(),
        key: Secret([2; 32]),
        register: Some(Register {
            name: "wire".into(),
        }),
    };
    let hello = Hello {
        v: Versions(VERSION, VERSION),
        role: Role::Cli,
        client: "test".into(),
        auth: Some(auth),
        abilities: Vec::new(),
    };
    let sub = Subscribe {
        collections: ALL.to_vec(),
    };
    let sub = call::Sub::request(CallId(1), &sub);
    // A frame is its length, its kind (0, a control) and its JSON.
    let mut out = Vec::new();
    for control in [Control::Hello(hello), sub] {
        let json = serde_json::to_vec(&control).unwrap();
        out.extend(((json.len() + 1) as u32).to_le_bytes());
        out.push(0);
        out.extend(json);
    }
    stream.write_all(&out).unwrap();
    let mut all = Map::new();
    loop {
        let mut head = [0; 5];
        stream.read_exact(&mut head).unwrap();
        let len = u32::from_le_bytes(head[..4].try_into().unwrap()) as usize;
        let mut payload = vec![0; len - 1];
        stream.read_exact(&mut payload).unwrap();
        let frame: Value = serde_json::from_slice(&payload).unwrap();
        match frame["t"].as_str() {
            Some("change") => {
                for set in frame["sets"].as_array().unwrap() {
                    let rows = all.entry(set["c"].as_str().unwrap()).or_insert(json!([]));
                    let put = set["put"].as_array().cloned().unwrap_or_default();
                    rows.as_array_mut().unwrap().extend(put);
                }
            }
            Some("reply") => {
                assert!(frame.get("ok").is_some(), "{frame}");
                return Value::Object(all);
            }
            _ => {}
        }
    }
}

#[test]
fn an_earlier_core_lacks_the_newer_calls_and_refuses_them_as_unknown() {
    let Some(exe) = std::env::var_os("TASKTAP_EARLIER_CORE") else {
        return eprintln!("skipped: TASKTAP_EARLIER_CORE names no 2.0.0 core");
    };
    let data = Folder::new("ea");
    let core = Core::start_exe(Path::new(&exe), &data.0, &[], &[], patience());
    let mut c = core.device();
    // a. none of the newer calls is listed, and each is refused, not dropped.
    let calls = c.welcome.calls.clone();
    assert!(calls.contains(&"thought.capture".to_owned()), "{calls:?}");
    for name in NEWER {
        assert!(!calls.iter().any(|c| c == name), "{name} is listed");
        let args = json!({ "text": "check the berths", "task": ThoughtId::mint() });
        assert_eq!(code(raw(&mut c, name, args)), Code::Unknown, "{name}");
    }
    // The connection lives on.
    <call::CoreStatus as Call>::result(raw(&mut c, "core.status", json!({}))).unwrap();
    // b. the snapshot of every collection parses, agents and all.
    let mut w = core.watch();
    let detect = DetectAgents {
        agents: None,
        unchecked: false,
    };
    let found = w.ok::<call::AgentsDetect>(&detect).agents;
    w.sync();
    assert!(!found.is_empty() && found.iter().all(|a| w.model.agents.contains_key(&a.id)));
    core.stop();
}

#[test]
fn this_builds_page_runs_every_step_of_a_task_on_an_earlier_core() {
    let Some(exe) = std::env::var_os("TASKTAP_EARLIER_CORE") else {
        return eprintln!("skipped: TASKTAP_EARLIER_CORE names no 2.0.0 core");
    };
    let mut s = scene(Path::new(&exe), "eb", None, "fixture");
    let tide = s.project("tide-notes");
    let harbor = s.project;

    // b. this build's types read the replies of these calls too.
    let terms = s.w.ok::<call::RouteTerms>(&Empty {});
    assert!(terms.terms > 0 && !terms.instructions.is_empty());
    assert!(terms.cuts.is_empty(), "2.0.0 says nothing of cuts");
    let detect = DetectAgents {
        agents: None,
        unchecked: false,
    };
    let found = s.w.ok::<call::AgentsDetect>(&detect).agents;
    assert!(found.iter().any(|a| a.id == "fixture"), "{found:?}");
    assert!(s.w.model.agents.contains_key("fixture"));

    // c. a task with a place, sent as this build's page sends it: the newer
    // fields are ignored, and the agent runs it to done.
    let first = Capture {
        project_id: Some(harbor),
        view: Some(harbor),
        auto: true,
        weight: Some(Weight::Heavy),
        taken: Some(0),
        ..typed(ThoughtId::mint(), "fix the buoy lights")
    };
    let (t1, session) = launched(&mut s, first);
    let mut agent = screen(&mut s, t1);
    agent.line("event:ready");
    agent.line("event:turn_started");
    agent.line("event:turn_finished:Lights fixed.");
    s.w.until("it is done", |m| m.status(t1) == Status::Done);
    assert_eq!(s.w.model.thought(t1).project_id, Some(harbor));

    // e. a follow-up continues the finished session and runs in it.
    let again = Capture {
        session_id: Some(session),
        ..typed(ThoughtId::mint(), "and the fog horn")
    };
    let t2 = again.id;
    s.w.ok::<call::ThoughtCapture>(&again);
    s.tick(HOLD_MS);
    agent.until("prompt:and the fog horn");
    s.w.until("it works in that session", |m| {
        m.status(t2) == Status::Working
    });
    assert_eq!(s.w.model.thought(t2).session_id, Some(session));

    // f. the agent asks; the question is open; the agent gets the answer.
    agent.line("ask:Sound it at noon?");
    s.w.until("it needs you", |m| m.status(t2) == Status::NeedsYou);
    let q = s.shown();
    let row = s.w.model.question(q).clone();
    assert_eq!(
        (row.source, row.state, row.thought_id),
        (QuestionSource::Agent, QuestionState::Open, Some(t2))
    );
    let answer = AnswerQuestion {
        id: q,
        response: Response::Affirm,
    };
    s.w.ok::<call::QuestionAnswer>(&answer);
    agent.until("answer:yes");
    agent.line("event:turn_finished:Horn sounded.");
    s.w.until("it is done", |m| m.status(t2) == Status::Done);
    assert_eq!(s.w.model.results_of(t2).len(), 1);

    // d. a task with no place: the router asks, and a choice places it.
    let both = Route::Ambiguous {
        prompt: "Which project?".into(),
        candidates: [(harbor, "harbormaster"), (tide, "tide-notes")]
            .map(|(to, label)| Candidate {
                label: label.into(),
                to: Place::Project(to),
                why: String::new(),
            })
            .to_vec(),
    };
    s.script(both, None);
    let asked = s.capture("sort the buoy photos");
    s.w.until("the router asks", |m| m.status(asked) == Status::NeedsYou);
    let q = s.shown();
    assert_eq!(s.w.model.question(q).source, QuestionSource::Router);
    let choice = AnswerQuestion {
        id: q,
        response: Response::Choice { choice: 1 },
    };
    s.w.ok::<call::QuestionAnswer>(&choice);
    assert_eq!(s.w.model.status(asked), Status::Routed);
    assert_eq!(s.w.model.thought(asked).project_id, Some(tide));
    s.tick(HOLD_MS);
    s.w.until("the placed task works", |m| {
        m.status(asked) == Status::Working
    });
    let mut shown = screen(&mut s, asked);
    shown.line("event:ready");
    shown.line("event:turn_started");
    shown.line("event:turn_finished:Sorted.");
    s.w.until("it is done", |m| m.status(asked) == Status::Done);
    // The page's other way to answer: the project goes on the thought.
    let other = s.capture("check the tide tables");
    s.w.until("the router asks again", |m| {
        m.status(other) == Status::NeedsYou
    });
    let assign = tasktap_proto::Assign {
        id: other,
        project_id: Some(harbor),
        card_id: None,
        session_id: None,
    };
    s.w.ok::<call::ThoughtUpdate>(&assign);
    s.w.until("it is placed", |m| m.status(other) == Status::Routed);
    assert_eq!(s.w.model.thought(other).project_id, Some(harbor));
    // `route.hint` with the newer `view` is answered: with no model agreed,
    // 2.0.0 says `unknown`, as for a task it cannot place by name.
    let hint = Hint {
        text: "check the berths".into(),
        current: None,
        view: Some(harbor),
    };
    let route = s.w.ok::<call::RouteHint>(&hint);
    assert_eq!(route, Route::Unknown);

    // g. a terminal: a line written is read back from the stream.
    let id = TerminalId::mint();
    let shell = StartTerminal {
        project: Some(tide),
        argv: Vec::new(),
        title: None,
    };
    let mut sh = Screen::start(&s.core, id, Some(shell));
    sh.line("echo tide-notes-$((40 + 2))");
    sh.until("tide-notes-42");
    s.w.ok::<call::TerminalStop>(&Ref { id });
    sh.ended();

    // i. preferences only this build knows are refused as invalid.
    for patch in [
        PrefPatch::ShowTarget(true),
        PrefPatch::AgentWeights(Vec::new()),
        PrefPatch::AgentCommands(Vec::new()),
    ] {
        let put = Put {
            target: PutTarget::Prefs(patch),
            if_rev: None,
        };
        assert_eq!(s.w.refused::<call::Put>(&put).code, Code::Invalid);
    }

    // j. `project.add` with `create`: 2.0.0 ignores the field, so a folder
    // that is not there is refused as it is without it.
    let folder = s.data.0.join("fog-horn");
    let add = |create| AddProject {
        id: ProjectId::mint(),
        folder: folder.to_str().unwrap().into(),
        name: None,
        create,
    };
    let refused = s.w.refused::<call::ProjectAdd>(&add(true));
    assert_eq!(refused.code, Code::Invalid, "{refused}");
    assert!(!folder.exists(), "2.0.0 does not make the folder");

    // b. every row still reads as this build's records.
    s.w.sync();
    let wire = on_the_wire(&s.core);
    for (collection, rows) in wire.as_object().unwrap() {
        eprintln!("{collection}: {} rows", rows.as_array().unwrap().len());
    }
    if let Some(file) = std::env::var_os("TASKTAP_EARLIER_RECORDS") {
        std::fs::write(file, serde_json::to_vec_pretty(&wire).unwrap()).unwrap();
    }
    let fresh = s.core.watch();
    assert_eq!(fresh.model.thoughts, s.w.model.thoughts);
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "init.defaultBranch=main",
            "-c",
            "commit.gpgSign=false",
        ])
        .args(["-c", "core.hooksPath=tasktap-tests-no-hooks"])
        .args(args)
        .env("GIT_CONFIG_GLOBAL", dir.parent().unwrap().join("gitconfig"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Person")
        .env("GIT_AUTHOR_EMAIL", "person@example.com")
        .env("GIT_COMMITTER_NAME", "Person")
        .env("GIT_COMMITTER_EMAIL", "person@example.com")
        .output()
        .unwrap();
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "git {args:?}: {err}");
}

#[test]
fn keep_and_discard_on_an_earlier_core_change_the_project_as_they_say() {
    let Some(exe) = std::env::var_os("TASKTAP_EARLIER_CORE") else {
        return eprintln!("skipped: TASKTAP_EARLIER_CORE names no 2.0.0 core");
    };
    if Command::new("git").arg("--version").output().is_err() {
        return eprintln!("skipped: git is not installed");
    }
    let work = Folder::new("ec");
    std::fs::write(work.0.join("gitconfig"), "").unwrap();
    let repo: PathBuf = work.0.join("harbormaster");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "first"]);
    let repo = std::fs::canonicalize(repo).unwrap();
    let mut s = scene(Path::new(&exe), "ec", Some(&repo), "fixture-silent");
    let patch = ProjectPatch {
        isolate: Some(Isolate::Always),
        ..ProjectPatch::default()
    };
    let target = PutTarget::Projects {
        id: s.project,
        patch,
    };
    s.w.ok::<call::Put>(&Put {
        target,
        if_rev: None,
    });
    let to = Place::Project(s.project);
    let leave = |s: &mut Scene, step: &str| -> ThoughtId {
        let brief = step.into();
        s.script(
            Route::Clear {
                said: None,
                to,
                brief,
            },
            None,
        );
        let t = s.capture(step);
        s.tick(HOLD_MS);
        s.w.until("its changes are pending", |m| {
            let w = m.thoughts[&t].workdir.as_ref();
            w.is_some_and(|w| w.changes == Changes::Pending)
        });
        t
    };
    let settle = |s: &mut Scene, t: ThoughtId, keep: bool| {
        let attempt = AttemptId::mint();
        s.w.ok::<call::ThoughtSettle>(&Settle {
            id: t,
            attempt,
            keep,
        });
    };
    let kept = leave(&mut s, "write:tide.txt:kept");
    assert!(!repo.join("tide.txt").exists(), "nothing before the keep");
    settle(&mut s, kept, true);
    let changes = |s: &Scene, t: ThoughtId| s.w.model.thought(t).workdir.clone().unwrap().changes;
    assert_eq!(changes(&s, kept), Changes::Kept);
    assert_eq!(
        std::fs::read_to_string(repo.join("tide.txt")).unwrap(),
        "kept"
    );
    let dropped = leave(&mut s, "write:buoy.txt:dropped");
    settle(&mut s, dropped, false);
    assert_eq!(changes(&s, dropped), Changes::Discarded);
    assert!(!repo.join("buoy.txt").exists(), "the discard left no trace");
    assert_eq!(
        std::fs::read_to_string(repo.join("a.txt")).unwrap(),
        "one\n"
    );
}
