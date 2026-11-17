//! The agents' own stores (design §7): Tasktap never writes the tools' own
//! configuration. Hooks and settings go on each command line; nothing of
//! `~/.claude`, `~/.codex` or anything else of the person's home outside
//! the core's own data folder is made, changed or removed by the core, its
//! launcher, its adapters, its shims or its hooks.
//!
//! No real tool runs here. `claude` and `codex` are stand-ins in the home's
//! `~/.local/bin`, where a terminal looks first: each prints its command
//! line, answers Codex's check of its hooks as the app server does, and
//! then runs the hook command it was given, as the tool runs it, on a
//! payload recorded from the real tool for every line `hook:NAME` typed
//! into it. What the real tools write to their own stores when they run is
//! theirs, and is not tested here.
#![cfg(unix)]

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use common::*;
use tasktap_proto::{
    AddProject, AnswerQuestion, Capture, PrefPatch, ProjectId, Put, PutTarget, QuestionId, Ref,
    Response, SessionState, StartTerminal, Status, TerminalId, TerminalState, ThoughtId, call,
};

/// A file, folder or link of the home, as it is on disk.
#[derive(Debug, PartialEq, Eq)]
enum Entry {
    Folder {
        mode: u32,
        modified: (i64, i64),
    },
    File {
        mode: u32,
        modified: (i64, i64),
        bytes: Vec<u8>,
    },
    Link(PathBuf),
}

impl Entry {
    fn says(entry: Option<&Entry>) -> String {
        match entry {
            None => "nothing".into(),
            Some(Entry::Folder { mode, modified }) => {
                format!("a folder, mode {mode:o}, modified {modified:?}")
            }
            Some(Entry::File {
                mode,
                modified,
                bytes,
            }) => format!(
                "a file of {} bytes, mode {mode:o}, modified {modified:?}",
                bytes.len()
            ),
            Some(Entry::Link(to)) => format!("a link to {}", to.display()),
        }
    }
}

/// Everything under `root` but `skip`: names, kinds, modes, contents, and
/// when each was last written, which a file rewritten with the same bytes
/// and a folder something was made and removed in both show.
fn snapshot(root: &Path, skip: &Path) -> BTreeMap<PathBuf, Entry> {
    let mut found = BTreeMap::new();
    let mut folders = vec![root.to_owned()];
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(&folder).unwrap() {
            let path = entry.unwrap().path();
            if path == skip {
                continue;
            }
            let meta = std::fs::symlink_metadata(&path).unwrap();
            let mode = meta.permissions().mode() & 0o7777;
            let modified = (meta.mtime(), meta.mtime_nsec());
            let entry = if meta.file_type().is_symlink() {
                Entry::Link(std::fs::read_link(&path).unwrap())
            } else if meta.is_dir() {
                folders.push(path.clone());
                Entry::Folder { mode, modified }
            } else {
                let bytes = std::fs::read(&path).unwrap();
                Entry::File {
                    mode,
                    modified,
                    bytes,
                }
            };
            found.insert(path.strip_prefix(root).unwrap().to_owned(), entry);
        }
    }
    found
}

fn put(path: &Path, bytes: &[u8], mode: u32) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// A home as a person who uses both tools has it: their stores, with
/// settings, credentials, sessions and a database, and the same in a
/// project's folder.
fn populate(home: &Path) {
    let files: [(&str, &[u8], u32); 14] = [
        (
            ".claude.json",
            br#"{"numStartups":41,"projects":{}}"#,
            0o600,
        ),
        (
            ".claude/settings.json",
            br#"{"model":"opus","hooks":{}}"#,
            0o644,
        ),
        (".claude/CLAUDE.md", b"Answer briefly.\n", 0o644),
        (".claude/.credentials.json", br#"{"token":"secret"}"#, 0o600),
        (
            ".claude/history.jsonl",
            b"{\"display\":\"fix it\"}\n",
            0o600,
        ),
        (
            ".claude/projects/-home-projects-shop/3f6a.jsonl",
            b"{\"type\":\"user\"}\n",
            0o600,
        ),
        (
            ".codex/config.toml",
            b"model = \"gpt-5\"\n[projects]\n",
            0o600,
        ),
        (
            ".codex/auth.json",
            br#"{"tokens":{"id_token":"secret"}}"#,
            0o600,
        ),
        (
            ".codex/sessions/2026/11/17/rollout-1.jsonl",
            b"{\"type\":\"session_meta\"}\n",
            0o644,
        ),
        (
            ".codex/state_5.sqlite",
            b"SQLite format 3\0\x10\0\x01\x01\0\x40\x20\x20",
            0o644,
        ),
        (".codex/state_5.sqlite-wal", b"\x37\x7f\x06\x82", 0o644),
        ("projects/shop/README.md", b"# Shop\n", 0o644),
        (
            "projects/shop/.claude/settings.local.json",
            br#"{"permissions":{"allow":[]}}"#,
            0o644,
        ),
        (
            "projects/shop/.codex/config.toml",
            b"approval_policy = \"never\"\n",
            0o644,
        ),
    ];
    for (name, bytes, mode) in files {
        put(&home.join(name), bytes, mode);
    }
    let private = std::fs::Permissions::from_mode(0o700);
    std::fs::set_permissions(home.join(".claude"), private.clone()).unwrap();
    std::fs::set_permissions(home.join(".codex"), private).unwrap();
}

/// The stand-in for `name` (`claude` or `codex`) in the home's own
/// programs, and the fixture agent beside it.
fn stand_ins(home: &Path) {
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agents");
    let fixtures = fixtures.to_str().unwrap();
    let bin = home.join(".local/bin");
    for name in ["claude", "codex"] {
        let script = format!(
            r#"#!/bin/sh
# Stands in for {name} in core/tests/stores.rs: no real tool runs there.
hook=$(printf '%s\n' "$*" | sed -n "s/.*\('[^']*' hook {name}\).*/\1/p" | head -n 1)
case " $* " in
*" app-server "*)
  echo '{{"id":1,"result":{{}}}}'
  sed "s|'/tmp/tasktap' hook codex|$hook|g" '{fixtures}/codex/hooks-list.json'
  echo
  cat > /dev/null
  exit 0 ;;
esac
echo "fake-{name} $*"
[ -n "$hook" ] || {{ echo "fake-{name}: no hooks attached"; exit 1; }}
while IFS= read -r line; do
  case "$line" in
  hook:*)
    eval "$hook" < '{fixtures}/{name}/'"${{line#hook:}}.json"
    echo " hooked:${{line#hook:}}:$?" ;;
  quit) exit 0 ;;
  esac
done
"#
        );
        put(&bin.join(name), script.as_bytes(), 0o755);
    }
    std::os::unix::fs::symlink(EXE, bin.join("fixture-agent")).unwrap();
}

struct Run {
    thought: ThoughtId,
    screen: Screen,
}

/// A thought for `agent` that names the project, routed there by its name
/// and launched at once: the agent's screen, once the stand-in runs.
fn launch(core: &Core, w: &mut Watch, project: ProjectId, agent: &str, shows: &str) -> Run {
    let thought = ThoughtId::mint();
    let capture = Capture {
        agent: Some(agent.into()),
        ..typed(thought, "Fix the header of the shop")
    };
    w.ok::<call::ThoughtCapture>(&capture);
    w.until("the run started or failed", |m| {
        let th = &m.thoughts[&thought];
        let session = th.session_id.and_then(|id| m.sessions.get(&id));
        th.status == Status::Failed || session.is_some_and(|s| s.terminal_id.is_some())
    });
    let th = w.model.thought(thought).clone();
    assert_eq!(
        th.status,
        Status::Working,
        "{:?}",
        w.model.results_of(thought)
    );
    assert_eq!(
        th.project_id,
        Some(project),
        "routed to the project it names"
    );
    assert_eq!(th.route.unwrap().by, "local", "by the name match");
    let terminal = w.model.session(th.session_id.unwrap()).terminal_id.unwrap();
    let mut screen = Screen::open(core, terminal);
    screen.until(shows);
    Run { thought, screen }
}

/// Types `hook:NAME` into a stand-in, which runs its hook on that payload.
fn hook(screen: &mut Screen, name: &str) {
    screen.line(&format!("hook:{name}"));
    screen.until(&format!("hooked:{name}:0"));
}

/// The same for a hook that waits on the person: the question it opens.
fn asked(w: &mut Watch, screen: &mut Screen, name: &str) -> QuestionId {
    screen.line(&format!("hook:{name}"));
    w.until("a question opens", |m| m.glance().question.is_some());
    w.model.glance().question.unwrap()
}

fn answer(w: &mut Watch, screen: &mut Screen, id: QuestionId, response: Response, name: &str) {
    w.ok::<call::QuestionAnswer>(&AnswerQuestion { id, response });
    screen.until(&format!("hooked:{name}:0"));
    w.until("the answer arrived", |m| {
        let answer = m.question(id).answer.as_ref();
        answer.is_some_and(|a| a.delivered.is_some())
    });
}

#[test]
fn nothing_of_the_persons_home_changes_outside_the_cores_data_folder() {
    let root = Folder::new("st");
    let home = root.0.join("h");
    let data = home.join("data");
    std::fs::create_dir_all(&data).unwrap();
    populate(&home);
    stand_ins(&home);
    let before = snapshot(&home, &data);
    assert!(before.len() > 20, "the home is populated: {}", before.len());

    let env = [
        ("HOME", home.to_str().unwrap()),
        ("SHELL", "/bin/sh"),
        ("PATH", "/usr/bin:/bin"),
    ];
    let core = Core::start_env(&data, &[], &env);
    let mut w = core.watch();
    let shop = home.join("projects/shop");
    let project = w.ok::<call::ProjectAdd>(&AddProject {
        id: ProjectId::mint(),
        folder: shop.to_str().unwrap().into(),
        name: None,
    });
    // No hold: a routed thought launches at once.
    w.ok::<call::Put>(&Put {
        target: PutTarget::Prefs(PrefPatch::Hold(0)),
        if_rev: None,
    });

    // Claude Code: launched, a whole turn with a question answered, and
    // its own exit.
    let mut run = launch(&core, &mut w, project, "claude", "fake-claude --settings");
    hook(&mut run.screen, "session-start");
    hook(&mut run.screen, "user-prompt-submit");
    let q = asked(&mut w, &mut run.screen, "permission-request-bash");
    let name = "permission-request-bash";
    answer(&mut w, &mut run.screen, q, Response::Affirm, name);
    assert!(run.screen.text().contains(r#""behavior":"allow""#));
    hook(&mut run.screen, "stop");
    w.until("the turn is done", |m| {
        m.status(run.thought) == Status::Done
    });
    run.screen.line("quit");
    run.screen.ended();

    // Codex: its hooks checked first, launched, a question refused, and
    // stopped while it works.
    // Its hooks are trusted by a setting on its command line.
    let mut run = launch(
        &core,
        &mut w,
        project,
        "codex",
        "fake-codex -c hooks.state=",
    );
    hook(&mut run.screen, "session-start");
    hook(&mut run.screen, "user-prompt-submit");
    let q = asked(&mut w, &mut run.screen, name);
    answer(&mut w, &mut run.screen, q, Response::Deny, name);
    w.ok::<call::ThoughtStop>(&Ref { id: run.thought });
    run.screen.ended();
    let session = w.model.thought(run.thought).session_id.unwrap();
    assert_eq!(w.model.session(session).state, SessionState::Ended);

    // The fixture agent, with its own hooks.
    let mut run = launch(&core, &mut w, project, "fixture", "fixture-agent --hook");
    run.screen.line("event:ready");
    run.screen.line("event:turn_started");
    run.screen.line("event:turn_finished:Header fixed.");
    w.until("the fixture's turn is done", |m| {
        m.status(run.thought) == Status::Done
    });
    run.screen.line("exit:0");
    run.screen.ended();

    // A shell in the home, as a person opens one, where typing an agent's
    // name runs it through its shim, which attaches the hooks and adopts
    // the session.
    let shell = TerminalId::mint();
    let start = StartTerminal {
        project: None,
        argv: Vec::new(),
        title: None,
    };
    let mut screen = Screen::start(&core, shell, Some(start));
    // The shell's own history file is the shell's, and stays unwritten.
    screen.line("unset HISTFILE");
    screen.line("command -v claude; command -v codex; echo found-$((40+2))");
    screen.until("found-42");
    let found = screen.text();
    for name in ["claude", "codex"] {
        let shim = format!("/data/shims/{name}");
        assert!(
            found.contains(&shim),
            "the shell finds no shim of {name}: {found}"
        );
    }
    for (name, shows) in [
        ("claude", "fake-claude --settings"),
        ("codex", "fake-codex -c"),
    ] {
        screen.line(name);
        screen.until(shows);
        w.until("the session is adopted", |m| {
            m.sessions.values().any(|s| s.adopted && s.agent == name)
        });
        let mut adopted = w.model.sessions.values().filter(|s| s.adopted);
        let session = adopted.find(|s| s.agent == name);
        let session = session.expect("adopted for the agent typed").clone();
        hook(&mut screen, "session-start");
        w.until("the adopted session is ready", |m| {
            m.session(session.id).state == SessionState::Idle
        });
        screen.line("quit");
        w.until("the adopted session ended", |m| {
            (m.sessions.get(&session.id)).is_none_or(|s| s.state == SessionState::Ended)
        });
    }
    screen.line("exit");
    screen.ended();
    w.until("the shell exited", |m| {
        m.terminals[&shell].state == TerminalState::Exited
    });
    drop(w);
    core.stop();

    // The core kept what it did in its own folder, and only there.
    assert!(data.join("core.db").is_file());
    let after = snapshot(&home, &data);
    let mut changed = Vec::new();
    let paths: BTreeSet<&PathBuf> = before.keys().chain(after.keys()).collect();
    for path in paths {
        let (was, is) = (before.get(path), after.get(path));
        if was != is {
            let (was, is) = (Entry::says(was), Entry::says(is));
            changed.push(format!("{}: {was} became {is}", path.display()));
        }
    }
    assert!(
        changed.is_empty(),
        "the home changed:\n{}",
        changed.join("\n")
    );
}
