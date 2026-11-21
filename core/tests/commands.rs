//! How a person starts an agent their own way (the `agent_commands`
//! preference): what they would type in a terminal up to where the task
//! goes, such as `caffeinate -i claude --model opus`. Their words run as
//! written, the first found as a program, and Tasktap's arguments for a run
//! follow the last. An agent with no command starts as it always did. Real
//! runs are the fixture agent in a core of the test's own, through
//! `/usr/bin/env` as the program of the person's that runs it.

mod common;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use common::*;
use tasktap_core::agents::{self, Agent, Run, Start};
use tasktap_proto::call::{self, Code};
use tasktap_proto::{AgentCommand, PrefPatch, Put, PutTarget, SessionId};

const RUN: &str = "01930000-0000-7000-8000-0000000000aa";

/// The tests that set the person's commands in this process, one at a time.
static COMMANDS: Mutex<()> = Mutex::new(());

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

/// The person's command for `agent`, as the core judges it.
fn judged(agent: &str, command: &str) -> Result<Vec<String>, String> {
    agents::judge(agents::find(agent).unwrap(), command)
}

fn refused(agent: &str, command: &str) -> String {
    judged(agent, command).unwrap_err()
}

/// What judging `command` says: `said`, but on Windows, where a command
/// starts with the agent's program, that it must ([`agents::windows`]).
fn on(agent: &dyn Agent, command: &str, said: String) -> String {
    let first = words(command).into_iter().next().unwrap_or_default();
    let windows = agents::windows(agent.name(), agent.program(), &first);
    windows.filter(|_| cfg!(windows)).unwrap_or(said)
}
fn line(agent: &str, command: &str) -> AgentCommand {
    AgentCommand {
        agent: agent.into(),
        command: command.into(),
    }
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
    let list = list.iter().map(|(agent, command)| line(agent, command));
    PrefPatch::AgentCommands(list.collect())
}

#[test]
fn an_agent_with_no_command_starts_as_it_always_did() {
    for agent in agents::all() {
        let (name, program) = (agent.name(), agent.program());
        let start = agents::start(name, program, &[], found).unwrap();
        assert_eq!(
            start,
            Start {
                program: found(program).unwrap(),
                head: Vec::new(),
                theirs: false,
            }
        );
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
fn the_persons_command_runs_as_written_and_tasktaps_arguments_follow_its_last_word() {
    for agent in agents::all() {
        let (name, program) = (agent.name(), agent.program());
        let command = words(&format!("caffeinate -i {program} --verbose 'two words'"));
        let start = agents::start(name, program, &command, found).unwrap();
        assert_eq!(start.program, found("caffeinate").unwrap(), "{name}");
        assert_eq!(start.head, command[1..], "{name}");
        assert!(start.theirs);
        // A new run and one that continues a conversation alike: the
        // command word for word, then Tasktap's, the check's first; and
        // Tasktap's own questions start with the same words.
        for resume in [None, Some("abc")] {
            let theirs = agents::theirs(program, &command);
            assert_eq!(theirs, ["--verbose", "two words"]);
            let launched = agent.launch(&run(resume, theirs));
            let mut want = vec![at("caffeinate")];
            want.extend(command[1..].iter().cloned());
            want.push("--checked".into());
            want.extend(launched[1..].iter().cloned());
            assert_eq!(start.run(vec!["--checked".into()], launched), want);
        }
        assert_eq!(start.asks()[1..], command[1..]);
    }
    // Nothing in the words is found again or put in another place: each of
    // these names the agent's program before it is the program.
    for typed in [
        "docker run --name claude img claude",
        "mise exec -- claude",
        "env FOO=/x/claude claude",
        "firejail --profile=/etc/firejail/claude.profile claude",
        "env PATH=/opt/tools/bin claude --model-free-words",
    ] {
        let command = words(typed);
        let start = agents::start("Claude Code", "claude", &command, found).unwrap();
        assert_eq!(start.program, found(&command[0]).unwrap(), "{typed}");
        assert_eq!(start.head, command[1..], "{typed}");
    }
}

#[test]
fn a_path_is_used_as_written_and_a_first_word_tasktap_does_not_find_is_said() {
    let folder = Folder::new("cp");
    let program = folder.0.join("my tools").join("claude");
    runnable(&program);
    let written = program.to_string_lossy().into_owned();
    let command = words(&format!("\"{written}\" --model-free"));
    let start = agents::start("Claude Code", "claude", &command, found).unwrap();
    assert_eq!(
        (start.program, start.head),
        (program, words("--model-free"))
    );
    // A path that is not whole, or names no file that may be run, and a
    // name not on the PATH, are said, with the word as written.
    let gone = folder.0.join("gone").join("claude");
    let gone = gone.to_string_lossy().into_owned();
    for lost in ["./claude", "bin/claude", "cluade", gone.as_str()] {
        let none = |word: &str| (word != "cluade").then(|| PathBuf::from("/found").join(word));
        let e = agents::start("Claude Code", "claude", &words(&format!("'{lost}'")), none);
        assert_eq!(
            e.unwrap_err(),
            format!("Tasktap finds no program named {lost} for the command of Claude Code")
        );
    }
    // A leading `~/` is the home folder, as in a shell; nothing else is.
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
    let mine = PathBuf::from(home.unwrap()).join("bin/claude");
    let mine = mine.to_string_lossy().into_owned();
    assert_eq!(words("~/bin/claude ~ $HOME"), [mine.as_str(), "~", "$HOME"]);
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
        refused("claude", "claude 'open"),
        "A quote in the command is not closed"
    );
    assert_eq!(
        refused("claude", r#""" claude"#),
        "The command of Claude Code needs a program as its first word"
    );
    assert_eq!(judged("claude", "   "), Ok(Vec::new()));
}

#[test]
fn what_tasktap_sets_for_a_run_is_refused_in_the_persons_arguments_with_one_sentence() {
    let says = |flag: &str, name: &str| {
        format!("Tasktap sets {flag} itself for {name}: take {flag} out of the command")
    };
    // As the shim reads what is typed: what makes nobody type to the agent,
    // a subcommand or an alias of one, also given together or with a value.
    for (agent, name, command, flag) in [
        ("claude", "Claude Code", "claude -p", "-p"),
        ("claude", "Claude Code", "claude --print", "--print"),
        ("claude", "Claude Code", "claude -pc", "-p"),
        ("claude", "Claude Code", "claude --help", "--help"),
        ("claude", "Claude Code", "claude --version", "--version"),
        ("claude", "Claude Code", "claude mcp", "mcp"),
        ("claude", "Claude Code", "claude --resume=abc", "--resume"),
        ("claude", "Claude Code", "claude -c", "-c"),
        (
            "claude",
            "Claude Code",
            "claude --session-id x",
            "--session-id",
        ),
        (
            "claude",
            "Claude Code",
            "claude --settings x.json",
            "--settings",
        ),
        ("claude", "Claude Code", "claude --model opus", "--model"),
        ("claude", "Claude Code", "caffeinate -i claude -- hi", "--"),
        ("codex", "Codex", "codex e", "e"),
        ("codex", "Codex", "codex exec", "exec"),
        ("codex", "Codex", "codex review", "review"),
        ("codex", "Codex", "codex resume", "resume"),
        ("codex", "Codex", "codex --json", "--json"),
        ("codex", "Codex", "codex --remote=x", "--remote"),
        ("codex", "Codex", "codex -C/tmp/x", "-C"),
        ("codex", "Codex", "codex -C=/tmp/x", "-C"),
        ("codex", "Codex", "codex --cd /tmp/x", "--cd"),
        ("codex", "Codex", "op run -- codex --model o3", "--model"),
        ("codex", "Codex", "codex -m o3", "-m"),
        (
            "agy",
            "Antigravity",
            "agy --conversation x",
            "--conversation",
        ),
        ("pi", "Pi", "pi --mode json", "--mode"),
        ("opencode", "OpenCode", "opencode run", "run"),
        ("copilot", "Copilot", "copilot --prompt=hi", "--prompt"),
        ("qwen", "Qwen Code", "qwen -m x", "-m"),
        ("goose", "Goose", "goose run", "run"),
        ("crush", "Crush", "crush -c/tmp/x", "-c"),
        ("droid", "Droid", "droid --model x", "--model"),
        ("aider", "Aider", "aider --message=x", "--message"),
    ] {
        if let Some(found) = agents::find(agent) {
            assert_eq!(
                refused(agent, command),
                on(found, command, says(flag, name)),
                "{command}"
            );
        }
    }
    // Only the words after the last that names the agent's program are its
    // arguments, and none where no word does: the rest is the person's.
    for fine in [
        "claude",
        "caffeinate -i claude --verbose",
        "op run -- claude --dangerously-skip-permissions",
        "docker run --name claude --model x img claude",
        "my-claude --resume x -p",
        "claude --setting-sources user",
        "claude -dhooks",
        "codex -p work",
        "codex -c model_reasoning_effort=high",
    ] {
        let agent = if fine.contains("codex") {
            "codex"
        } else {
            "claude"
        };
        let found = agents::find(agent).unwrap();
        let said = judged(agent, fine).err().unwrap_or_default();
        assert_eq!(said, on(found, fine, String::new()), "{fine}");
    }
    assert_eq!(
        refused("claude", "claude\n--verbose"),
        "The command of Claude Code is too long, or not one line"
    );
    // The length in bytes, as it is stored.
    assert!(judged("claude", &format!("claude {}", "é".repeat(996))).is_ok());
    assert_eq!(
        refused("claude", &format!("claude {}", "é".repeat(997))),
        "The command of Claude Code is too long, or not one line"
    );
}

#[test]
fn a_stored_command_this_build_refuses_harms_only_its_own_agent() {
    let _one = COMMANDS.lock().unwrap_or_else(|e| e.into_inner());
    let bad = line("claude", "claude --model opus");
    let good = line("codex", "codex -c model_reasoning_effort=high");
    // Put: a command kept as it was stands; one new or changed is judged.
    let was = [bad.clone()];
    assert!(agents::check_commands(&[bad.clone(), good.clone()], &was).is_ok());
    let said = "Tasktap sets --model itself for Claude Code: take --model out of the command";
    assert_eq!(
        agents::check_commands(std::slice::from_ref(&bad), &[]).unwrap_err(),
        said
    );
    assert_eq!(
        agents::check_commands(&[line("own-a1", "x")], &[]).unwrap_err(),
        "Tasktap brings no agent named own-a1"
    );
    let twice = [good.clone(), line("codex", "codex")];
    assert_eq!(
        agents::check_commands(&twice, &[]).unwrap_err(),
        "Codex has two commands"
    );
    // Taken as the core starts: the good one holds, the bad one is not used
    // and its row says why.
    let (claude, codex) = (
        agents::find("claude").unwrap(),
        agents::find("codex").unwrap(),
    );
    let changed = agents::set_commands(&[bad, good]);
    assert!(
        changed.iter().any(|a| a.id() == "claude") && changed.iter().any(|a| a.id() == "codex")
    );
    assert_eq!(
        agents::command(codex),
        words("codex -c model_reasoning_effort=high")
    );
    assert!(agents::command(claude).is_empty());
    assert_eq!(agents::command_refused(claude).as_deref(), Some(said));
    assert_eq!(
        agents::checks::found(claude).command_fails.as_deref(),
        Some(said)
    );
    assert_eq!(agents::command_refused(codex), None);
    agents::set_commands(&[]);
}

#[test]
fn on_windows_the_command_starts_with_the_agents_own_program() {
    let windows = |first: &str| agents::windows("Claude Code", "claude", first);
    for first in [
        "claude",
        "/opt/tools/claude",
        r"C:\npm\claude.cmd",
        "C:/x/claude.EXE",
        "claude.bat",
    ] {
        assert_eq!(windows(first), None, "{first}");
    }
    for first in [
        "op",
        "caffeinate",
        r"C:\tools\wrap.exe",
        "claude-code",
        "my-claude.cmd",
    ] {
        assert_eq!(
            windows(first).as_deref(),
            Some(
                "On Windows the command of Claude Code must start with claude: Windows cannot pass a task safely through another program"
            ),
            "{first}"
        );
    }
}

#[test]
fn the_persons_approval_policy_stands_and_tasktaps_is_added_only_without_one() {
    let claude = agents::find("claude").unwrap();
    let codex = agents::find("codex").unwrap();
    let has = |agent: &dyn Agent, args: &[String], word: &str| {
        agent.launch(&run(None, args)).iter().any(|a| a == word)
    };
    assert!(has(claude, &words("--verbose"), "auto"));
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
fn a_command_is_refused_when_it_is_put_in_one_sentence() {
    let mut s = Scene::real("cq", "fixture");
    let e = put(&mut s.w, commands(&[("fixture", "fixture-agent --hook x")])).unwrap_err();
    assert_eq!(
        (e.code, e.message.as_str()),
        (
            Code::Invalid,
            "Tasktap sets --hook itself for Fixture agent: take --hook out of the command"
        )
    );
    assert!(
        put(
            &mut s.w,
            commands(&[("fixture", "fixture-agent --verbose")])
        )
        .is_ok()
    );
}

#[cfg(unix)]
#[test]
fn a_command_that_does_not_start_the_agent_says_so() {
    let mut s = Scene::real("cs", "fixture");
    let detect = |s: &mut Scene| {
        s.w.ok::<call::AgentsDetect>(&tasktap_proto::DetectAgents {
            agents: Some(vec!["fixture".into()]),
            unchecked: false,
        });
    };
    detect(&mut s);
    s.w.until("the fixture agent is signed in", |m| {
        m.agents
            .get("fixture")
            .is_some_and(|a| a.signed_in == Some(true))
    });
    assert_eq!(s.w.model.agents["fixture"].program, "fixture-agent");
    // A first word that is no program is said where the agent's state is.
    put(&mut s.w, commands(&[("fixture", "cluade")])).unwrap();
    s.w.until("the agent is said to be missing", |m| {
        let a = &m.agents["fixture"];
        !a.installed
            && a.command_fails.as_deref()
                == Some("Tasktap finds no program named cluade for the command of Fixture agent")
    });
    // A program of the person's that does not start the agent: asked for its
    // version it printed no version, and nothing of a sign-in counts. What
    // it printed is said as it printed it, which is env's own wording: on a
    // Mac "env: cluade: No such file or directory", with GNU's env
    // "/usr/bin/env: ‘cluade’: No such file or directory".
    for (typed, missing) in [
        ("/usr/bin/env cluade", "cluade"),
        (
            "/usr/bin/env no-such-agent-of-tasktap",
            "no-such-agent-of-tasktap",
        ),
    ] {
        // The look the change itself asks for, before the one asked here.
        put(&mut s.w, commands(&[("fixture", typed)])).unwrap();
        s.w.until("the agent's first word is found", |m| {
            let a = &m.agents["fixture"];
            a.installed && a.command_fails.is_none()
        });
        detect(&mut s);
        let says = |fails: &str| {
            fails
                .strip_prefix("The command of Fixture agent did not start Fixture agent: ")
                .is_some_and(|said| {
                    said.contains(missing) && said.ends_with("No such file or directory")
                })
        };
        s.w.until("the agent says its command did not start it", |m| {
            m.agents["fixture"]
                .command_fails
                .as_deref()
                .is_some_and(says)
        });
        let a = &s.w.model.agents["fixture"];
        assert!(a.installed, "{typed}");
        assert_eq!((a.signed_in, a.version.as_deref()), (None, None), "{typed}");
    }
    // Taken away, the agent is there again as it was.
    put(&mut s.w, commands(&[])).unwrap();
    detect(&mut s);
    s.w.until("the agent is there again", |m| {
        let a = &m.agents["fixture"];
        a.installed && a.command_fails.is_none() && a.signed_in == Some(true)
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
    // As written: `env` finds the agent's program itself.
    #[rustfmt::skip]
    assert_eq!(
        argv[..5],
        ["/usr/bin/env", "TASKTAP_WRAPPED=by env", "fixture-agent", "env:TASKTAP_WRAPPED", "--hook"]
    );
    assert_eq!(argv.last().unwrap(), "Fix the failing build");
    let mut screen = Screen::open(&s.core, terminal);
    screen.until("fixture-agent env:TASKTAP_WRAPPED --hook");
    screen.until("Fix the failing build");
    screen.until("TASKTAP_WRAPPED=by env");
}

/// The shim reads nothing of the person's commands: an agent typed in a
/// Tasktap shell runs as typed, also one whose command is set, with no data
/// folder named, from a folder that holds a file the shim once read.
#[cfg(unix)]
#[test]
fn an_agent_typed_in_a_shell_runs_as_typed_and_the_shim_reads_no_file_of_commands() {
    let data = Folder::new("ch");
    let real = data.0.join("real");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::copy(EXE, real.join("fixture")).unwrap();
    let env = [("SHELL", "/bin/sh"), ("PATH", &path_with(&real))];
    let core = Core::start_env(&data.0, &[], &env);
    let project = data.0.join("project");
    let mut s = Scene::on(core, data).running("fixture");
    let wrapped = [(
        "fixture",
        "/usr/bin/env FROM_LINE=yes fixture print:from-line",
    )];
    put(&mut s.w, commands(&wrapped)).unwrap();
    // What a cloned project could hold, in its folder and in the data folder.
    let file = r#"["/bin/echo","from-a-file"]"#;
    for folder in [
        project.join("agents/fixture"),
        s.data.0.join("agents/fixture"),
    ] {
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("command.json"), file).unwrap();
    }
    let start = tasktap_proto::StartTerminal {
        project: None,
        argv: Vec::new(),
        title: None,
    };
    let mut screen = Screen::start(&s.core, tasktap_proto::TerminalId::mint(), Some(start));
    screen.line(&format!("cd '{}'", project.display()));
    screen.line("fixture help print:as-typed");
    screen.until("fixture-agent help print:as-typed");
    screen.line("env -u TASKTAP_DATA fixture help print:no-data");
    screen.until("fixture-agent help print:no-data");
    screen.line("echo shell-$((2+3))");
    screen.until("shell-5");
    let text = screen.text();
    assert!(
        !text.contains("from-a-file") && !text.contains("from-line"),
        "{text}"
    );
    screen.line("exit");
}

/// A question of Tasktap's own to an agent the person starts through a
/// program of theirs that keeps the agent as its child (`sh`, after
/// `/usr/bin/env`), which outlives its time: the program and the agent end
/// with it, and the agent does nothing after.
#[cfg(unix)]
#[test]
fn a_question_that_outlives_its_time_ends_the_persons_program_and_the_agent_it_started() {
    use std::time::{Duration, Instant};
    let _one = COMMANDS.lock().unwrap_or_else(|e| e.into_inner());
    let data = Folder::new("ct");
    let fixture = common::agents(&data.0).join("fixture-agent");
    let wrap = data.0.join("wrap.sh");
    std::fs::write(
        &wrap,
        format!("'{}' \"$@\"\necho after\n", fixture.display()),
    )
    .unwrap();
    // Asked, the silent fixture agent has a second to answer; it sleeps
    // longer, then would write a file.
    let folder = data.0.join("asked");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("ask-silent"), "sleep:2000\nwrite:late:yes\n").unwrap();
    let command = line(
        "fixture-silent",
        &format!("/usr/bin/env sh '{}'", wrap.display()),
    );
    agents::set_commands(&[command]);
    let agent = agents::find("fixture-silent").unwrap();
    let how = agent.headless().unwrap();
    let asked = Instant::now();
    let channel = std::sync::mpsc::channel();
    let e = agents::checks::ask(agent, &how, "where?".into(), "{}", &folder, channel);
    agents::set_commands(&[]);
    let why = format!("{:?}", e.unwrap_err());
    assert!(why.contains("did not answer within 1 s"), "{why}");
    assert!(
        asked.elapsed() < Duration::from_secs(2),
        "{:?}",
        asked.elapsed()
    );
    assert!(folder.join("asked-silent").exists(), "it was asked");
    std::thread::sleep(Duration::from_millis(2500));
    assert!(
        !folder.join("late").exists(),
        "the agent ran on after its question"
    );
}
