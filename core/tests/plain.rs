//! The plain agents (design §7): tools with no hooks, run from a command
//! line in their form for one task, and the ones a person adds themselves.
//! What Aider takes and how it exits are from runs of Aider 0.86.2 in a
//! home of its own; `fixtures/agents/aider/version.txt` is what it printed.

mod common;

use std::path::Path;

use common::*;
use tasktap_core::agents::plain::{self, AIDER};
use tasktap_core::agents::{self, Run};
use tasktap_proto::call::{self, Code};
use tasktap_proto::{
    AttemptId, Capture, OwnAgent, Place, PrefPatch, Put, PutTarget, Ref, Route, SessionId,
    SessionState, Start, Status, ThoughtId,
};

const RUN: &str = "01930000-0000-7000-8000-0000000000aa";

fn run<'a>(prompt: &'a str, model: Option<&'a str>) -> Run<'a> {
    Run {
        session: SessionId::try_from(RUN.parse::<tasktap_proto::Uuid>().unwrap()).unwrap(),
        cwd: Path::new("/tmp/project"),
        prompt,
        words: None,
        model,
        effort: None,
        resume: None,
        hook: Path::new("/opt/tasktap/tasktap"),
        home: Path::new("/data/agents/aider"),
        allowed: &[],
        args: &[],
    }
}

fn own(id: &str, name: &str, command: &str) -> OwnAgent {
    OwnAgent {
        id: id.into(),
        name: name.into(),
        command: command.into(),
        removed: false,
    }
}

#[test]
fn aider_is_started_for_one_task_and_says_only_that_it_ended() {
    let aider = agents::find("aider").unwrap();
    assert_eq!((aider.name(), aider.program()), ("Aider", "aider"));
    // No hooks: its end is all Tasktap hears, and nothing continues it.
    let caps = aider.caps();
    assert!(!caps.events && !caps.resume);
    assert_eq!((caps.permissions, caps.questions), (None, None));
    assert!(aider.attach(Path::new("/x"), Path::new("/y")).is_empty());
    assert!(aider.headless().is_none() && aider.prompts().is_empty());
    assert!(aider.event(&[], b"{}").unwrap().is_none());
    // The message is one argument with its flag, so one that starts with
    // `-` is no option; it says yes to what it would ask in its terminal,
    // and four flags keep that yes from what nobody asked for.
    #[rustfmt::skip]
    assert_eq!(
        aider.launch(&run("Fix the build", None)),
        ["aider", "--yes-always", "--no-analytics", "--no-check-update",
         "--no-show-release-notes", "--no-detect-urls", "--message=Fix the build"]
    );
    let argv = aider.launch(&run("-v is noisy", Some("deepseek/deepseek-chat")));
    assert_eq!(argv[1..3], ["--model", "deepseek/deepseek-chat"]);
    assert_eq!(argv.last().unwrap(), "--message=-v is noisy");
    // `/` and `!` begin commands of its own (`!` a shell command) when they
    // are the first character: a thought that starts so is told after a space.
    for told in ["/tmp is full", "!important: fix the build"] {
        let argv = aider.launch(&run(told, None));
        assert_eq!(*argv.last().unwrap(), format!("--message= {told}"));
    }
    // The person's own words follow a brief, marked as theirs.
    let both = Run {
        words: Some("mach den build heil"),
        ..run("Fix the build.", None)
    };
    let told = aider.launch(&both).pop().unwrap();
    assert!(told.starts_with("--message=Fix the build.\n\n---\n") && told.ends_with("heil"));
    // Its version, as it prints it; whether it has a key it cannot be asked.
    let detect = aider.detect();
    assert_eq!(detect.version, ["--version"]);
    let printed = include_str!("fixtures/agents/aider/version.txt");
    assert_eq!((detect.version_of)(printed).as_deref(), Some("0.86.2"));
    assert!(detect.account.is_empty());
    let row = agents::checks::found(aider);
    assert!(!row.checks && !row.own && !row.events);
    // It exits with 0 also when its key was refused: the row says so.
    assert!(
        row.note
            .unwrap()
            .starts_with("Its terminal says whether it did the work")
    );
    // Nothing of it has been run on Windows yet.
    assert_eq!(aider.supported(), !cfg!(windows));
    assert!(AIDER.variables.contains(&"DEEPSEEK_API_KEY"));
}

#[test]
fn a_command_line_is_words_apart_by_spaces_and_no_shell_reads_it() {
    let words = |line: &str| plain::words(line).unwrap();
    assert_eq!(
        words("goose run -t {prompt}"),
        ["goose", "run", "-t", "{prompt}"]
    );
    assert_eq!(words("  tool   --ask  "), ["tool", "--ask"]);
    // Quotes keep spaces, and an empty pair is an empty word.
    assert_eq!(
        words(r#""/Applications/My Tool/run" --say 'do: {prompt}' """#),
        ["/Applications/My Tool/run", "--say", "do: {prompt}", ""]
    );
    assert_eq!(words(r#"a"b c"d 'x"y'"#), ["ab cd", "x\"y"]);
    // Nothing is expanded, and a backslash is itself.
    assert_eq!(
        words(r"C:\tools\run.exe $HOME ~ * ; rm"),
        [r"C:\tools\run.exe", "$HOME", "~", "*", ";", "rm"]
    );
    assert!(words("").is_empty());
    assert_eq!(
        plain::words("tool 'open").unwrap_err(),
        "A quote in the command is not closed"
    );
}

#[test]
fn an_agent_of_the_persons_own_needs_a_name_a_program_and_a_place_for_the_thought() {
    let refused = |agent: OwnAgent| plain::own(&[agent]).err().unwrap();
    assert!(plain::own(&[own("own-a1", "Goose", "goose run -t {prompt}")]).is_ok());
    assert_eq!(
        refused(own("own-a1", "  ", "goose run -t {prompt}")),
        "Give the agent a name of up to 40 characters"
    );
    assert_eq!(
        refused(own("own-a1", "Goose", "goose run")),
        "The command of Goose needs {prompt} where the task goes"
    );
    assert_eq!(
        refused(own("own-a1", "Goose", "{prompt}")),
        "The command of Goose needs a program before {prompt}"
    );
    assert_eq!(
        refused(own("own-a1", "Goose", "  ")),
        "Goose needs a command"
    );
    assert_eq!(
        refused(own("own-a1", "Goose", "goose 'run {prompt}")),
        "A quote in the command is not closed"
    );
    assert_eq!(
        refused(own("own-a1", "Goose", "goose\n{prompt}")),
        "The command of Goose is too long, or not one line"
    );
    // Its id is Tasktap's own, so it is never one of the agents it brings.
    for id in ["claude", "own-", "own-A1", "own-12345678901234567"] {
        assert_eq!(
            refused(own(id, "Goose", "goose {prompt}")),
            "An agent of your own has an id Tasktap did not give it"
        );
    }
    let twice = [
        own("own-a1", "Goose", "goose {prompt}"),
        own("own-a1", "Crush", "crush {prompt}"),
    ];
    assert_eq!(
        plain::own(&twice).err().unwrap(),
        "Two agents of your own have the same id"
    );
    let many: Vec<_> = (0..17)
        .map(|n| own(&format!("own-n{n}"), "Goose", "goose {prompt}"))
        .collect();
    assert_eq!(
        plain::own(&many).err().unwrap(),
        "Tasktap keeps at most 16 agents of your own"
    );
}

/// Waits until a thought's run has started in its terminal, or failed.
fn launched(s: &mut Scene, t: ThoughtId) {
    s.w.until("the run started or failed", |m| {
        let th = &m.thoughts[&t];
        let session = th.session_id.and_then(|id| m.sessions.get(&id));
        th.status == Status::Failed || session.is_some_and(|s| s.terminal_id.is_some())
    });
}

fn put(w: &mut Watch, patch: PrefPatch) -> Result<(), call::Error> {
    let target = PutTarget::Prefs(patch);
    let put = Put {
        target,
        if_rev: None,
    };
    w.call::<call::Put>(&put).map(|_| ())
}

#[test]
fn an_agent_the_person_added_is_listed_runs_its_command_and_goes_when_removed() {
    let mut s = Scene::real("pa", "own-tidy");
    // The fixture agent under other names: it prints what it is told and
    // exits, one with 0 and one with 3.
    let tidy = own(
        "own-tidy",
        " Tidy ",
        "fixture-agent 'print:{prompt}' exit:0",
    );
    let fails = own(
        "own-fails",
        "Fails",
        "fixture-agent 'print:{prompt}' exit:3",
    );
    let lost = own(
        "own-lost",
        "Lost",
        "no-such-program-of-tasktap --do {prompt}",
    );
    let all = vec![tidy.clone(), fails.clone(), lost.clone()];
    put(&mut s.w, PrefPatch::OwnAgents(all)).unwrap();
    let mut ran = Vec::new();
    // Both are listed after the agents the core brings: what the person
    // called them, that they are theirs, and whether their program is here.
    s.w.until("the person's agents are listed", |m| {
        m.agents.contains_key("own-tidy") && m.agents.contains_key("own-lost")
    });
    let row = s.w.model.agents["own-tidy"].clone();
    assert_eq!(
        (row.name.as_str(), row.own, row.installed),
        ("Tidy", true, true)
    );
    assert_eq!(row.note, None);
    assert!(row.supported && !row.events && !row.resume && !row.checks);
    assert!(!s.w.model.agents["own-lost"].installed);
    // A run is its command with the thought in it, and no hooks; its end is
    // the end of the work: done with 0, failed with anything else.
    let to = Place::Project(s.project);
    let brief = "Tidy the folder.".into();
    s.script(
        Route::Clear {
            said: None,
            to,
            brief,
        },
        None,
    );
    for (agent, exit, status) in [
        ("own-tidy", "exit:0", Status::Done),
        ("own-fails", "exit:3", Status::Failed),
    ] {
        let t = ThoughtId::mint();
        let named = Capture {
            agent: Some(agent.into()),
            ..typed(t, "tidy up")
        };
        s.w.ok::<call::ThoughtCapture>(&named);
        s.tick(HOLD_MS);
        launched(&mut s, t);
        let session = s.w.model.thought(t).session_id.unwrap();
        let terminal = s.w.model.session(session).terminal_id.unwrap();
        let argv = &s.w.model.terminals[&terminal].argv;
        // The brief, then the person's words, in the one argument it names.
        assert_eq!(argv.len(), 3, "{argv:?}");
        assert!(argv[1].starts_with("print:Tidy the folder.\n") && argv[1].ends_with("tidy up"));
        assert_eq!(argv[2], exit);
        s.w.until("the session ends", |m| {
            m.session(session).state == SessionState::Ended
        });
        assert_eq!(s.w.model.status(t), status);
        ran.push(t);
    }
    // One that is no agent is refused in words for the person, and the
    // ones before stay.
    let broken = own("own-tidy", "Tidy", "fixture-agent");
    let e = put(&mut s.w, PrefPatch::OwnAgents(vec![broken])).unwrap_err();
    assert_eq!(e.code, Code::Invalid);
    assert_eq!(
        e.message,
        "The command of Tidy needs {prompt} where the task goes"
    );
    assert!(s.w.model.agents.contains_key("own-lost"));
    // Removed, its row goes and it runs nothing more. It is kept, so that
    // what it ran still says who ran it: a thought that names it, and the
    // one it ran when that is tried again, say that it is no longer set up
    // and how it comes back.
    let removed = OwnAgent {
        removed: true,
        ..fails.clone()
    };
    let now = vec![tidy.clone(), removed, lost];
    put(&mut s.w, PrefPatch::OwnAgents(now)).unwrap();
    s.w.until("the removed agent's row goes", |m| {
        !m.agents.contains_key("own-fails") && m.agents.contains_key("own-tidy")
    });
    let gone = "Fails is no longer set up: add it back in Settings \u{203a} Agents";
    let named = |agent: &str| Capture {
        agent: Some(agent.into()),
        ..typed(ThoughtId::mint(), "tidy up")
    };
    let e =
        s.w.call::<call::ThoughtCapture>(&named("own-fails"))
            .unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (Code::Failed, gone));
    let again = ran[1];
    s.w.ok::<call::ThoughtRetry>(&Ref { id: again });
    let attempt = AttemptId::mint();
    let start = Start { id: again, attempt };
    let e = s.w.call::<call::ThoughtStart>(&start).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (Code::Failed, gone));
    // Added back, it runs as it did.
    let back = vec![tidy.clone(), fails];
    put(&mut s.w, PrefPatch::OwnAgents(back)).unwrap();
    s.w.until("the agent is listed again", |m| {
        m.agents.contains_key("own-fails") && !m.agents.contains_key("own-lost")
    });
    s.w.ok::<call::ThoughtCapture>(&named("own-fails"));
    // One that is forgotten is no agent at all.
    let e =
        s.w.call::<call::ThoughtCapture>(&named("own-lost"))
            .unwrap_err();
    assert_eq!(e.code, Code::Invalid);
    put(&mut s.w, PrefPatch::OwnAgents(vec![tidy])).unwrap();
    s.w.until("the forgotten agent's row goes", |m| {
        !m.agents.contains_key("own-fails")
    });

    // The next core on this folder has the one that stayed, with no call.
    let Scene { core, data, .. } = s;
    drop(core);
    let core = Core::with_agents(&data.0);
    let mut w = core.watch();
    w.until("the kept agent is listed again", |m| {
        m.agents
            .get("own-tidy")
            .is_some_and(|a| a.own && a.installed)
    });
    assert!(!w.model.agents.contains_key("own-lost"));
}

#[test]
fn what_the_person_lets_an_agent_do_reaches_its_runs_and_nothing_else_does() {
    let mut s = Scene::real("po", "fixture");
    let started = |s: &mut Scene| -> Vec<String> {
        let t = s.capture("tidy up");
        s.tick(HOLD_MS);
        launched(s, t);
        let session = s.w.model.thought(t).session_id.unwrap();
        let terminal = s.w.model.session(session).terminal_id.unwrap();
        s.w.model.terminals[&terminal].argv.clone()
    };
    // Off until they turn it on.
    assert!(!started(&mut s).contains(&"--more".to_owned()));
    // Only what an agent of this core has can be turned on.
    for unknown in ["fixture.other", "nobody.more", "more"] {
        let e = put(&mut s.w, PrefPatch::AgentOptions(vec![unknown.into()])).unwrap_err();
        assert_eq!(e.code, Code::Invalid);
        assert_eq!(e.message, format!("no agent has the option {unknown}"));
    }
    put(
        &mut s.w,
        PrefPatch::AgentOptions(vec!["fixture.more".into()]),
    )
    .unwrap();
    let argv = started(&mut s);
    assert!(argv.contains(&"--more".to_owned()), "{argv:?}");
    put(&mut s.w, PrefPatch::AgentOptions(Vec::new())).unwrap();
    assert!(!started(&mut s).contains(&"--more".to_owned()));
}

#[test]
fn a_follow_up_to_a_run_that_reads_nothing_typed_says_to_send_it_when_the_run_has_ended() {
    let mut s = Scene::real("pf", "own-slow");
    // It prints what it is told and then works for a while, reading nothing.
    let slow = own(
        "own-slow",
        "Slow",
        "fixture-agent 'print:{prompt}' sleep:4000",
    );
    put(&mut s.w, PrefPatch::OwnAgents(vec![slow])).unwrap();
    s.w.until("the agent is listed", |m| m.agents.contains_key("own-slow"));
    let t = s.capture("tidy up");
    s.tick(HOLD_MS);
    launched(&mut s, t);
    let session = s.w.model.thought(t).session_id.unwrap();
    // A run of one task takes nothing that is typed: a follow-up while it
    // works is not typed into its terminal, where it would be lost.
    let f = ThoughtId::mint();
    let follow = Capture {
        session_id: Some(session),
        ..typed(f, "and the tests")
    };
    s.w.ok::<call::ThoughtCapture>(&follow);
    s.tick(HOLD_MS);
    s.w.until("the follow-up fails", |m| m.status(f) == Status::Failed);
    assert_eq!(
        s.w.model.results_of(f)[0].summary,
        "Slow runs one task at a time: send this again when it has ended"
    );
    assert_eq!(s.w.model.status(t), Status::Working);
    assert!(!agents::find("aider").unwrap().typed() && agents::find("claude").unwrap().typed());
}
