//! How a person starts an agent their own way (the `agent_commands`
//! preference): what they would type in a terminal up to where the task
//! goes, such as `caffeinate -i claude --model opus`. The words before the
//! agent's program are a program of theirs that runs it, the words after it
//! their own arguments, and Tasktap's arguments for a run follow. An agent
//! with no command starts as it always did. Real runs are the fixture agent
//! in a core of the test's own, through `/usr/bin/env` as the program of the
//! person's that runs it.

mod common;

use std::path::{Path, PathBuf};

use common::*;
use tasktap_core::agents::{self, Agent, Run, Start};
use tasktap_proto::call::{self, Code};
use tasktap_proto::{AgentCommand, PrefPatch, Put, PutTarget, SessionId};

const RUN: &str = "01930000-0000-7000-8000-0000000000aa";

fn run<'a>(resume: Option<&'a str>, args: &'a [String]) -> Run<'a> {
    Run {
        session: SessionId::try_from(RUN.parse::<tasktap_proto::Uuid>().unwrap()).unwrap(),
        cwd: Path::new("/tmp/project"),
        prompt: "Fix the build",
        words: None,
        model: None,
        resume,
        hook: Path::new("/opt/tasktap/tasktap"),
        home: Path::new("/data/agents/x"),
        allowed: &[],
        args,
    }
}

/// Every program is found, in a folder of its own name.
fn found(word: &str) -> Option<PathBuf> {
    Some(PathBuf::from("/found").join(word))
}

fn at(word: &str) -> String {
    found(word).unwrap().to_string_lossy().into_owned()
}

fn words(line: &str) -> Vec<String> {
    agents::split(line).unwrap()
}

/// The person's command for `agent`, as the core checks it when it is put.
fn checked(agent: &str, command: &str) -> Result<(), String> {
    let command = AgentCommand {
        agent: agent.into(),
        command: command.into(),
    };
    agents::commands(&[command]).map(|_| ())
}

/// A file that may be run, at `path`.
fn runnable(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, "#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

fn put(w: &mut Watch, patch: PrefPatch) -> Result<(), call::Error> {
    let put = Put {
        target: PutTarget::Prefs(patch),
        if_rev: None,
    };
    w.call::<call::Put>(&put).map(|_| ())
}

fn commands(list: &[(&str, &str)]) -> PrefPatch {
    let list = list.iter().map(|(agent, command)| AgentCommand {
        agent: (*agent).into(),
        command: (*command).into(),
    });
    PrefPatch::AgentCommands(list.collect())
}

#[test]
fn an_agent_with_no_command_starts_as_it_always_did() {
    for agent in agents::all() {
        let (name, program) = (agent.name(), agent.program());
        assert!(agents::command(agent).is_empty(), "{name}");
        let start = agents::start(name, program, &[], found).unwrap();
        assert_eq!(
            start,
            Start {
                program: found(program).unwrap(),
                head: Vec::new(),
                args: Vec::new(),
            }
        );
        assert!(start.asks() == [at(program)], "{name}");
        // As the launcher started a run before: its program where it was
        // found, what its check added right after it, then its arguments.
        let launched = agent.launch(&run(None, &[]));
        let more = vec!["--checked".to_owned()];
        let mut before = launched.clone();
        before[0] = at(program);
        before.splice(1..1, more.clone());
        assert_eq!(start.run(more, launched), before, "{name}");
        // Nothing found: it is not installed, as it said before.
        let lost = agents::start(name, program, &[], |_| None).unwrap_err();
        assert_eq!(
            lost,
            format!("{program} is not installed: no folder of the PATH has it")
        );
    }
}

#[test]
fn a_program_of_the_persons_runs_the_agent_with_their_arguments_before_tasktaps() {
    for agent in agents::all() {
        let (name, program) = (agent.name(), agent.program());
        let command = words(&format!("caffeinate -i {program} --verbose 'two words'"));
        let start = agents::start(name, program, &command, found).unwrap();
        assert_eq!(start.program, found("caffeinate").unwrap(), "{name}");
        assert_eq!(start.head, ["-i".to_owned(), at(program)], "{name}");
        assert_eq!(start.args, ["--verbose", "two words"], "{name}");
        let theirs = agents::args(program, &command);
        assert_eq!(theirs, ["--verbose", "two words"]);
        // A new run and one that continues a conversation alike: what
        // starts it, the person's arguments, then Tasktap's, the check's
        // first.
        for resume in [None, Some("abc")] {
            let launched = agent.launch(&run(resume, theirs));
            let mut want = vec![at("caffeinate"), "-i".into(), at(program)];
            want.extend(["--verbose".into(), "two words".into(), "--checked".into()]);
            want.extend(launched[1..].iter().cloned());
            let argv = agents::start(name, program, &command, found)
                .unwrap()
                .run(vec!["--checked".into()], launched);
            assert_eq!(argv, want, "{name}");
        }
        // Tasktap's own questions to it start with the same programs, and
        // without the person's arguments.
        assert_eq!(start.asks(), [at("caffeinate"), "-i".into(), at(program)]);
    }
}

#[test]
fn a_program_tasktap_does_not_find_is_left_for_the_persons_program_to_find() {
    // `env PATH=…` finds what Tasktap's PATH has not.
    let command = words("env PATH=/opt/tools/bin claude --model opus");
    let only_env = |word: &str| (word == "env").then(|| PathBuf::from("/usr/bin/env"));
    let start = agents::start("Claude Code", "claude", &command, only_env).unwrap();
    assert_eq!(start.program, PathBuf::from("/usr/bin/env"));
    assert_eq!(start.head, ["PATH=/opt/tools/bin", "claude"]);
    assert_eq!(start.args, ["--model", "opus"]);
}

#[test]
fn a_path_to_the_program_is_used_as_written() {
    let folder = Folder::new("cp");
    let program = folder.0.join("my tools").join("claude");
    runnable(&program);
    let written = program.to_string_lossy().into_owned();
    // Alone, the program it names is run, with the arguments after it.
    let command = words(&format!("\"{written}\" --model opus"));
    let start = agents::start("Claude Code", "claude", &command, found).unwrap();
    assert_eq!((start.program, start.head), (program.clone(), Vec::new()));
    assert_eq!(start.args, ["--model", "opus"]);
    // After a program of the person's, it is passed on as written.
    let command = words(&format!("caffeinate -i '{written}'"));
    let start = agents::start("Claude Code", "claude", &command, found).unwrap();
    assert_eq!(start.head, ["-i".to_owned(), written.clone()]);
    // A path that is not whole, or names no file that may be run, is said.
    for lost in ["./claude", "bin/claude"] {
        let e = agents::start("Claude Code", "claude", &words(lost), found).unwrap_err();
        assert_eq!(
            e,
            format!("Tasktap finds no program named {lost} for the command of Claude Code")
        );
    }
    let gone = folder.0.join("gone").join("claude");
    let gone = gone.to_string_lossy().into_owned();
    let e = agents::start("Claude Code", "claude", std::slice::from_ref(&gone), found).unwrap_err();
    assert!(e.contains(&gone), "{e}");
    // A leading `~/` is the home folder, as in a shell; nothing else is.
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
    let home = PathBuf::from(home.unwrap());
    let mine = home.join("bin/claude").to_string_lossy().into_owned();
    assert_eq!(words("~/bin/claude ~ $HOME"), [mine.as_str(), "~", "$HOME"]);
}

#[test]
fn a_script_of_the_persons_own_stands_in_for_the_program() {
    let command = words("my-claude --fast");
    assert!(agents::args("claude", &command).is_empty());
    let start = agents::start("Claude Code", "claude", &command, found).unwrap();
    assert_eq!(start.program, found("my-claude").unwrap());
    assert_eq!(
        (start.head.as_slice(), start.args.len()),
        (&["--fast".to_owned()][..], 0)
    );
    let claude = agents::find("claude").unwrap();
    let launched = claude.launch(&run(None, &[]));
    let argv = start.run(Vec::new(), launched.clone());
    assert_eq!(argv[..2], [at("my-claude"), "--fast".into()]);
    assert_eq!(argv[2..], launched[1..]);
    // Its arguments are its own business: none is refused.
    assert!(checked("claude", "my-claude --resume x -p").is_ok());
}

#[test]
fn quotes_group_words_and_no_shell_reads_the_command() {
    assert_eq!(
        words(r#"env "A B=1" claude --append-system-prompt 'be brief' "" $HOME"#),
        [
            "env",
            "A B=1",
            "claude",
            "--append-system-prompt",
            "be brief",
            "",
            "$HOME"
        ]
    );
    assert_eq!(
        checked("claude", "claude 'open").unwrap_err(),
        "A quote in the command is not closed"
    );
}

#[test]
fn what_tasktap_sets_for_a_run_is_refused_in_the_persons_arguments_with_one_sentence() {
    for agent in agents::all() {
        let (id, name, program) = (agent.id(), agent.name(), agent.program());
        for flag in agent.refused() {
            let said =
                format!("Tasktap sets {flag} itself for {name}: take {flag} out of the command");
            let command = format!("caffeinate -i {program} --verbose {flag}");
            assert_eq!(checked(id, &command).unwrap_err(), said);
            if flag.starts_with("--") && flag.len() > 2 {
                let valued = format!("{program} {flag}=x");
                assert_eq!(checked(id, &valued).unwrap_err(), said);
            }
        }
    }
    let claude: Vec<_> = agents::find("claude").unwrap().refused().to_vec();
    #[rustfmt::skip]
    assert_eq!(claude, ["-p", "--print", "-c", "--continue", "-r", "--resume", "--session-id", "--settings", "--"]);
    // What is the person's business stands: a model, a flag that only
    // begins as a refused one does, and the words of the program of theirs
    // that runs the agent.
    assert!(checked("claude", "claude --model opus --setting-sources user").is_ok());
    assert!(checked("claude", "op run -- claude --dangerously-skip-permissions").is_ok());
    assert!(checked("codex", "op run -- codex -c model_reasoning_effort=high").is_ok());
    // A command is one line for one of Tasktap's own agents, each once;
    // an empty one is none.
    assert_eq!(
        checked("claude", "claude\n--model opus").unwrap_err(),
        "The command of Claude Code is too long, or not one line"
    );
    assert_eq!(
        checked("claude", &"x".repeat(2001)).unwrap_err(),
        "The command of Claude Code is too long, or not one line"
    );
    assert_eq!(
        checked("own-a1", "goose").unwrap_err(),
        "Tasktap brings no agent named own-a1"
    );
    let twice =
        [("claude", "claude"), ("claude", "caffeinate claude")].map(|(a, c)| AgentCommand {
            agent: a.into(),
            command: c.into(),
        });
    assert_eq!(
        agents::commands(&twice).err().unwrap(),
        "Claude Code has two commands"
    );
    let empty = AgentCommand {
        agent: "claude".into(),
        command: "  ".into(),
    };
    assert!(agents::commands(&[empty]).unwrap().is_empty());
}

#[test]
fn the_persons_approval_policy_stands_and_tasktaps_is_added_only_without_one() {
    let claude = agents::find("claude").unwrap();
    let codex = agents::find("codex").unwrap();
    let has = |agent: &dyn Agent, args: &[String], word: &str| {
        agent.launch(&run(None, args)).iter().any(|a| a == word)
    };
    assert!(has(claude, &words("--model opus"), "auto"));
    assert!(!has(claude, &words("--permission-mode plan"), "auto"));
    assert!(!has(
        claude,
        &words("--dangerously-skip-permissions"),
        "auto"
    ));
    assert!(has(codex, &[], "--approve-for-me"));
    assert!(!has(codex, &words("-a never"), "--approve-for-me"));
}

#[test]
fn the_command_is_refused_when_put_and_one_tasktap_cannot_start_is_said_in_the_agents_state() {
    let mut s = Scene::real("cs", "fixture");
    s.w.ok::<call::AgentsDetect>(&tasktap_proto::DetectAgents {
        agents: Some(vec!["fixture".into()]),
        unchecked: false,
    });
    s.w.until("the fixture agent is listed", |m| {
        m.agents.get("fixture").is_some_and(|a| a.installed)
    });
    assert_eq!(s.w.model.agents["fixture"].program, "fixture-agent");
    let e = put(&mut s.w, commands(&[("fixture", "fixture-agent --hook x")])).unwrap_err();
    assert_eq!(
        (e.code, e.message.as_str()),
        (
            Code::Invalid,
            "Tasktap sets --hook itself for Fixture agent: take --hook out of the command"
        )
    );
    // A first word that is no program is said where the agent's state is.
    let lost = [("fixture", "no-such-program-of-tasktap fixture-agent")];
    put(&mut s.w, commands(&lost)).unwrap();
    s.w.until("the agent is said to be missing", |m| {
        !m.agents["fixture"].installed
    });
    // Taken away, the agent is there again.
    put(&mut s.w, commands(&[])).unwrap();
    s.w.until("the agent is there again", |m| {
        m.agents["fixture"].installed
    });
}

/// A thought's run started for real through `/usr/bin/env`, with a variable
/// of the person's and an argument of theirs, which the fixture agent prints
/// as it sees them, and then the task.
#[cfg(unix)]
#[test]
fn a_run_starts_through_the_persons_program_and_the_agent_gets_its_task() {
    let mut s = Scene::real("cr", "fixture");
    let wrapped = [(
        "fixture",
        "/usr/bin/env TASKTAP_WRAPPED='by env' fixture-agent env:TASKTAP_WRAPPED",
    )];
    put(&mut s.w, commands(&wrapped)).unwrap();
    let t = s.capture("fix the build");
    s.tick(HOLD_MS);
    s.w.until("the run started", |m| {
        let th = &m.thoughts[&t];
        let session = th.session_id.and_then(|id| m.sessions.get(&id));
        session.is_some_and(|s| s.terminal_id.is_some())
    });
    let session = s.w.model.thought(t).session_id.unwrap();
    let terminal = s.w.model.session(session).terminal_id.unwrap();
    let argv = s.w.model.terminals[&terminal].argv.clone();
    assert_eq!(argv[..2], ["/usr/bin/env", "TASKTAP_WRAPPED=by env"]);
    let program = Path::new(&argv[2]);
    assert!(
        program.is_absolute() && program.ends_with("fixture-agent"),
        "{argv:?}"
    );
    assert_eq!(argv[3..5], ["env:TASKTAP_WRAPPED", "--hook"]);
    assert_eq!(argv.last().unwrap(), "Fix the failing build");
    let mut screen = Screen::open(&s.core, terminal);
    screen.until("fixture-agent env:TASKTAP_WRAPPED --hook");
    screen.until("Fix the failing build");
    screen.until("TASKTAP_WRAPPED=by env");
}

/// A shell of the core's, where typing `fixture` starts the "real" fixture
/// agent, a copy of the binary, through its shim, as a terminal of an agent
/// opened by hand and the one that signs it in do.
#[cfg(unix)]
fn shell(prefix: &str) -> (Scene, PathBuf, Screen) {
    let data = Folder::new(prefix);
    let real = data.0.join("real");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::copy(EXE, real.join("fixture")).unwrap();
    let env = [("SHELL", "/bin/sh"), ("PATH", &path_with(&real))];
    let core = Core::start_env(&data.0, &[], &env);
    let kept = data.0.clone();
    let s = Scene::on(core, data).running("fixture");
    let start = tasktap_proto::StartTerminal {
        project: None,
        argv: Vec::new(),
        title: None,
    };
    let screen = Screen::start(&s.core, tasktap_proto::TerminalId::mint(), Some(start));
    (s, kept, screen)
}

/// Waits until the core has left the agent's command where its shim reads it.
#[cfg(unix)]
fn kept(data: &Path, has: &str) {
    let file = data.join("agents/fixture/command.json");
    for _ in 0..200 {
        if std::fs::read_to_string(&file).is_ok_and(|text| text.contains(has)) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    panic!("{} never held {has}", file.display());
}

#[cfg(unix)]
#[test]
fn an_agent_typed_in_a_shell_starts_as_the_persons_command_says() {
    let (mut s, data, mut screen) = shell("ch");
    let wrapped = [(
        "fixture",
        "/usr/bin/env TASKTAP_WRAPPED=yes fixture env:TASKTAP_WRAPPED",
    )];
    put(&mut s.w, commands(&wrapped)).unwrap();
    kept(&data, "TASKTAP_WRAPPED=yes");
    // Observed: its hooks follow the person's arguments, then what is typed.
    screen.line("fixture");
    screen.until("fixture-agent env:TASKTAP_WRAPPED --hook");
    screen.until("TASKTAP_WRAPPED=yes");
    // The shim lets go of the terminal once its agent has gone.
    screen.until_after(b"\x1b[0m\x1b[?25h");
    // Not observed, as `codex login` signs Codex in: started the same way.
    screen.line("fixture help");
    screen.until("fixture-agent env:TASKTAP_WRAPPED help");
    // Taken away, the agent is started as typed again.
    put(&mut s.w, commands(&[])).unwrap();
    let file = data.join("agents/fixture/command.json");
    for _ in 0..200 {
        if !file.exists() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    assert!(!file.exists());
    screen.line("fixture help print:plain-again");
    screen.until("fixture-agent help print:plain-again");
    screen.line("exit");
}

/// A script of the person's that runs the agent by its name runs it once:
/// the shim it reaches then starts the agent as typed.
#[cfg(unix)]
#[test]
fn a_script_that_runs_the_agent_by_its_name_runs_it_once() {
    let (mut s, data, mut screen) = shell("cx");
    let script = data.join("bin").join("my-fixture");
    runnable(&script);
    // Not as the fixture agent the shim runs, which a test's shim marks.
    let runs = "exec env -u TASKTAP_FIXTURE_AGENT fixture \"$@\"";
    std::fs::write(&script, format!("#!/bin/sh\necho script-ran\n{runs}\n")).unwrap();
    let mine = script.to_string_lossy().into_owned();
    put(
        &mut s.w,
        commands(&[("fixture", &format!("'{mine}' print:mine"))]),
    )
    .unwrap();
    kept(&data, "print:mine");
    // The shim it reaches observes it, as one typed by hand.
    screen.line("fixture help");
    screen.until("--approve print:mine help");
    screen.line("echo shell-$((2+3))");
    screen.until("shell-5");
    let text = screen.text();
    assert_eq!(text.matches("script-ran").count(), 1, "{text}");
    assert_eq!(text.matches("fixture-agent").count(), 1, "{text}");
    screen.line("exit");
}
