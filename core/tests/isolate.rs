//! Isolated runs (design §7, "Isolation") through the real binary, with
//! real git repositories in temporary folders. Each run is a fixture agent
//! the real launcher starts, which changes files in its working folder
//! with its `write` step. The tests try to break the promise that nothing of
//! the person's is lost or altered except by a Keep that succeeded: their
//! uncommitted work, their ignored files and their branches, across
//! refusals, a crash in the middle of a keep, a worktree removed behind the
//! core's back, hooks that fail or hang, and a configuration that would
//! sign, stash, page or color. Git runs with no configuration of whoever runs
//! the tests; where git is not installed every test says so and passes.

mod common;

use common::*;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, Instant};
use tasktap_proto::call::{self, Error};
use tasktap_proto::{
    AttemptId, Changes, Code, Control, Data, Diff, Empty, FileChange, Frame, Isolate, MAX_DIFF,
    Place, ProjectPatch, Put, PutTarget, ReadChanges, Reason, Ref, ResultKind, Route, SessionState,
    Settle, Start, Status, ThoughtId, Workdir,
};

/// Reports by exiting: done when it exits with 0.
const SILENT: &str = "fixture-silent";
/// Reports through its hooks and reads its steps from its terminal.
const TALKS: &str = "fixture";

fn have_git() -> bool {
    let found = Command::new("git").arg("--version").output();
    let found = found.is_ok_and(|o| o.status.success());
    if !found {
        eprintln!("skipped: git is not installed");
    }
    found
}

/// The folder the repositories of a test live in, with the global git
/// configuration of the test's own git (empty) and of the core's.
struct Work(Folder);

impl Work {
    fn new(prefix: &str) -> Work {
        let work = Work(Folder::new(prefix));
        std::fs::write(work.0.0.join("gitconfig"), "").unwrap();
        std::fs::write(work.core_config(), "").unwrap();
        work
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.0.join(name)
    }

    /// What the core's git reads as the person's global configuration.
    fn core_config(&self) -> PathBuf {
        self.path("core-gitconfig")
    }

    fn try_git(&self, dir: &Path, args: &[&str]) -> Output {
        Command::new("git")
            .arg("-C")
            .arg(plain(dir))
            .args([
                "-c",
                "init.defaultBranch=main",
                "-c",
                "commit.gpgSign=false",
            ])
            .args(["-c", "core.hooksPath=tasktap-tests-no-hooks"])
            .args([
                "-c",
                "protocol.file.allow=always",
                "-c",
                "core.autocrlf=false",
            ])
            .args(args)
            .env("GIT_CONFIG_GLOBAL", self.path("gitconfig"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_AUTHOR_NAME", "Person")
            .env("GIT_AUTHOR_EMAIL", "person@example.com")
            .env("GIT_COMMITTER_NAME", "Person")
            .env("GIT_COMMITTER_EMAIL", "person@example.com")
            .output()
            .unwrap()
    }

    fn git(&self, dir: &Path, args: &[&str]) -> String {
        let out = self.try_git(dir, args);
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(out.status.success(), "git {args:?} in {dir:?}: {err}");
        String::from_utf8_lossy(&out.stdout).trim_end().to_owned()
    }

    /// A repository on `main` with one commit of `a.txt`, `b.txt` and a
    /// `.gitignore` that ignores `*.log`.
    fn repo(&self, name: &str) -> PathBuf {
        let repo = self.path(name);
        std::fs::create_dir_all(&repo).unwrap();
        self.git(&repo, &["init", "-q"]);
        write(&repo.join("a.txt"), "one\ntwo\nthree\n");
        write(&repo.join("b.txt"), "bee\n");
        write(&repo.join(".gitignore"), "*.log\n");
        self.git(&repo, &["add", "-A"]);
        self.git(&repo, &["commit", "-q", "-m", "first"]);
        std::fs::canonicalize(repo).unwrap()
    }

    fn commit(&self, repo: &Path, file: &str, text: &str, message: &str) -> String {
        write(&repo.join(file), text);
        self.git(repo, &["add", "--", file]);
        self.git(repo, &["commit", "-q", "-m", message]);
        self.git(repo, &["rev-parse", "HEAD"])
    }

    fn branch(&self, repo: &Path, branch: &str) -> Option<String> {
        let out = self.try_git(
            repo,
            &[
                "rev-parse",
                "-q",
                "--verify",
                &format!("refs/heads/{branch}"),
            ],
        );
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
    }

    fn ours(&self, repo: &Path) -> String {
        self.git(repo, &["branch", "--list", "tasktap/*"])
    }
}

/// A path as git takes it: on Windows without the `\\?\` of a canonical one.
fn plain(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref().to_string_lossy();
    PathBuf::from(path.strip_prefix(r"\\?\").unwrap_or(&path).to_owned())
}

fn write(path: &Path, text: &str) {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).unwrap();
    }
    std::fs::write(path, text).unwrap();
}

fn read(path: impl AsRef<Path>) -> String {
    std::fs::read_to_string(path).unwrap()
}

/// A core whose runs are fixture agents and whose git reads the work's
/// core configuration as the person's.
fn start(data: &Folder, work: &Work, extra: &[&str]) -> Core {
    let path = path_with(&agents(&data.0));
    let config = work.core_config();
    let env = [
        ("PATH", path.as_str()),
        ("GIT_CONFIG_GLOBAL", config.to_str().unwrap()),
        ("GIT_CONFIG_NOSYSTEM", "1"),
    ];
    // Git is slow on a busy Windows runner; a hook that hung would still
    // outlast this.
    Core::start_patient(&data.0, extra, &env, Duration::from_secs(240))
}

fn scene(prefix: &str, work: &Work, repo: &Path, agent: &str) -> Scene {
    let data = Folder::new(prefix);
    let core = start(&data, work, &[]);
    Scene::in_folder(core, data, repo, agent)
}

/// The same scene on a core started again after a crash.
fn crashed(s: Scene, work: &Work, repo: &Path) -> Scene {
    let Scene {
        core,
        data,
        w,
        agent,
        ..
    } = s;
    drop((w, core));
    let core = start(&data, work, &[]);
    Scene::in_folder(core, data, repo, &agent.unwrap())
}

fn isolate(s: &mut Scene, how: Isolate) {
    let patch = ProjectPatch {
        isolate: Some(how),
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
}

/// A thought whose agent's prompt is `step`, launched once its hold ends.
fn capture(s: &mut Scene, step: &str) -> ThoughtId {
    let to = Place::Project(s.project);
    s.script(
        Route::Clear {
            to,
            brief: step.into(),
        },
        None,
    );
    let t = s.capture(step);
    s.tick(HOLD_MS);
    t
}

/// A run of the agent that does `step` and exits, once its changes were
/// looked at and found pending.
fn pending(s: &mut Scene, step: &str) -> ThoughtId {
    let t = capture(s, step);
    s.w.until("its changes are pending", |m| {
        let w = m.thoughts[&t].workdir.as_ref();
        w.is_some_and(|w| w.changes == Changes::Pending)
    });
    t
}

fn workdir(s: &Scene, t: ThoughtId) -> Workdir {
    s.w.model
        .thought(t)
        .workdir
        .clone()
        .expect("it has a worktree")
}

fn changes(s: &Scene, t: ThoughtId) -> Changes {
    workdir(s, t).changes
}

fn settle(s: &mut Scene, t: ThoughtId, keep: bool) -> Result<(), Error> {
    let settle = Settle {
        id: t,
        attempt: AttemptId::mint(),
        keep,
    };
    s.w.call::<call::ThoughtSettle>(&settle)
}

/// Waits for something the core does on its own off its thread.
fn eventually(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !done() {
        assert!(Instant::now() < deadline, "{what} never happened");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The changes of a thought: the reply, and the diff its stream carried.
fn diff(s: &Scene, t: ThoughtId, path: Option<&str>) -> (Diff, Vec<u8>) {
    let mut c = s.core.device();
    let credit = 64 << 10;
    let read = ReadChanges {
        id: t,
        credit,
        path: path.map(Into::into),
    };
    let diff = c.call::<call::ThoughtChanges>(&read).unwrap().unwrap();
    c.track(&diff.stream, credit, true);
    let mut bytes = Vec::new();
    loop {
        match c.recv().unwrap() {
            Frame::Data(Data { s, bytes: b }) if s == diff.stream.s => bytes.extend(b),
            Frame::Control(Control::Close(close)) if close.s == diff.stream.s => break,
            _ => {}
        }
    }
    (diff, bytes)
}

fn under(path: &str, folder: &Path) -> bool {
    let folder = std::fs::canonicalize(folder).unwrap();
    Path::new(path).starts_with(folder)
}

#[test]
fn a_busy_project_gives_a_new_run_a_worktree_and_a_quiet_one_runs_in_place() {
    if !have_git() {
        return;
    }
    let work = Work::new("ib");
    let repo = work.repo("app");
    let head = work.git(&repo, &["rev-parse", "HEAD"]);
    let mut s = scene("ib", &work, &repo, TALKS);
    // Nothing runs: the first run works in the project folder, and its agent
    // waits there, starting, for its steps.
    let a = capture(&mut s, "start");
    s.w.until("it started", |m| {
        let session = m.thoughts[&a].session_id.map(|id| &m.sessions[&id]);
        session.is_some_and(|s| s.terminal_id.is_some())
    });
    let session = s.w.model.thought(a).session_id.unwrap();
    assert_eq!(s.w.model.thought(a).workdir, None);
    assert_eq!(s.w.model.session(session).cwd, repo.to_str().unwrap());

    // The project is busy: the next run gets a worktree of its own.
    let mut s = s.running(SILENT);
    let b = pending(&mut s, "write:fresh.txt:from b");
    let w = workdir(&s, b);
    assert!(under(&w.path, &s.data.0.join("worktrees")), "{w:?}");
    assert!(w.branch.starts_with("tasktap/"), "{w:?}");
    assert_eq!(
        (w.destination.as_deref(), w.base.as_str(), w.left_out),
        (Some("main"), head.as_str(), false)
    );
    assert_eq!((w.files, w.insertions, w.deletions), (1, 1, 0));
    let session = s.w.model.thought(b).session_id.unwrap();
    assert_eq!(s.w.model.session(session).cwd, w.path);
    assert_eq!(read(Path::new(&w.path).join("fresh.txt")), "from b");
    assert!(!repo.join("fresh.txt").exists());

    // The first run stopped, its changes pending keep it busy.
    s.w.ok::<call::ThoughtStop>(&Ref { id: a });
    let c = pending(&mut s, "write:c.txt:from c");
    assert_ne!(workdir(&s, c).path, w.path);

    // With nothing running and nothing pending, a run works in place again.
    settle(&mut s, b, false).unwrap();
    settle(&mut s, c, false).unwrap();
    let d = capture(&mut s, "write:d.txt:in place");
    s.w.until("it is done", |m| m.thoughts[&d].status == Status::Done);
    assert_eq!(s.w.model.thought(d).workdir, None);
    assert_eq!(read(repo.join("d.txt")), "in place");
}

#[test]
fn the_setting_and_git_decide_where_a_run_works() {
    if !have_git() {
        return;
    }
    let work = Work::new("is");
    let repo = work.repo("app");
    let mut s = scene("is", &work, &repo, SILENT);
    // Always: a worktree, with nothing else running.
    isolate(&mut s, Isolate::Always);
    let a = pending(&mut s, "write:a.txt:changed");
    // Never: in place, even with changes pending there.
    isolate(&mut s, Isolate::Never);
    let b = capture(&mut s, "write:never.txt:here");
    s.w.until("it is done", |m| m.thoughts[&b].status == Status::Done);
    assert_eq!(s.w.model.thought(b).workdir, None);
    assert_eq!(read(repo.join("never.txt")), "here");
    assert_eq!(changes(&s, a), Changes::Pending);

    // A folder that is no git repository runs in place, always or not.
    let plain = work.path("plain");
    std::fs::create_dir_all(&plain).unwrap();
    let Scene { core, data, w, .. } = s;
    drop(w);
    let mut s = Scene::in_folder(core, data, &plain, SILENT);
    isolate(&mut s, Isolate::Always);
    assert!(!s.w.model.projects[&s.project].git);
    let c = capture(&mut s, "write:here.txt:plain");
    s.w.until("it is done", |m| m.thoughts[&c].status == Status::Done);
    assert_eq!(s.w.model.thought(c).workdir, None);
    assert_eq!(read(plain.join("here.txt")), "plain");
}

#[test]
fn keep_brings_the_changes_into_the_branch_and_leaves_the_persons_own_work_alone() {
    if !have_git() {
        return;
    }
    let work = Work::new("ik");
    let repo = work.repo("app");
    // The person's own, uncommitted: a change, a new file, an ignored file.
    write(&repo.join("b.txt"), "my change\n");
    write(&repo.join("notes.txt"), "my notes\n");
    write(&repo.join("mine.log"), "my log\n");
    let status = work.git(&repo, &["status", "--porcelain"]);
    let head = work.git(&repo, &["rev-parse", "HEAD"]);
    let mut s = scene("ik", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:new.txt:hello");
    let w = workdir(&s, t);
    // It started from what is committed, without the person's changes, and says so.
    assert!(w.left_out);
    assert_eq!(read(Path::new(&w.path).join("b.txt")), "bee\n");
    assert!(!Path::new(&w.path).join("notes.txt").exists());

    // The changes, listed and as a diff.
    let (listed, bytes) = diff(&s, t, None);
    assert_eq!(listed.files.len(), 1);
    let file = &listed.files[0];
    assert_eq!(
        (
            file.path.as_str(),
            file.change,
            file.insertions,
            file.deletions
        ),
        ("new.txt", FileChange::Added, Some(1), Some(0))
    );
    assert_eq!((listed.more, listed.cut), (0, false));
    assert_eq!(listed.size, bytes.len() as u64);
    let text = String::from_utf8(bytes).unwrap();
    assert!(
        text.contains("+++ b/new.txt") && text.contains("+hello"),
        "{text}"
    );

    settle(&mut s, t, true).unwrap();
    assert_eq!(changes(&s, t), Changes::Kept);
    // A fast-forward: the branch's commit is now main's, and in the folder.
    assert_eq!(work.git(&repo, &["rev-parse", "HEAD^"]), head);
    let subject = work.git(&repo, &["log", "-1", "--format=%s"]);
    assert_eq!(subject, "write:new.txt:hello");
    assert_eq!(read(repo.join("new.txt")), "hello");
    // The person's own work is as it was.
    assert_eq!(read(repo.join("b.txt")), "my change\n");
    assert_eq!(read(repo.join("notes.txt")), "my notes\n");
    assert_eq!(read(repo.join("mine.log")), "my log\n");
    assert_eq!(work.git(&repo, &["status", "--porcelain"]), status);
    // Nothing of the worktree is left.
    assert!(!Path::new(&w.path).exists());
    assert_eq!(work.ours(&repo), "");
    // Kept: nothing more to show or settle.
    let read_changes = ReadChanges {
        id: t,
        credit: 1024,
        path: None,
    };
    let e = s.w.refused::<call::ThoughtChanges>(&read_changes);
    assert_eq!(e.code, Code::Gone);
    assert_eq!(settle(&mut s, t, true).unwrap_err().code, Code::Conflict);
}

#[test]
fn keep_refuses_to_touch_a_file_the_person_changed_or_has_ignored_there() {
    if !have_git() {
        return;
    }
    let work = Work::new("id");
    let repo = work.repo("app");
    let mut s = scene("id", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:a.txt:agent");
    let w = workdir(&s, t);
    let head = work.git(&repo, &["rev-parse", "HEAD"]);
    write(&repo.join("a.txt"), "mine\n");

    let e = settle(&mut s, t, true).unwrap_err();
    assert_eq!(e.code, Code::Failed);
    assert!(
        e.message.contains("a.txt") && e.message.contains(&w.branch),
        "{e}"
    );
    assert_eq!(read(repo.join("a.txt")), "mine\n");
    assert_eq!(work.git(&repo, &["rev-parse", "HEAD"]), head);
    assert_eq!(changes(&s, t), Changes::Pending);
    assert!(work.branch(&repo, &w.branch).is_some());
    assert!(Path::new(&w.path).join(".git").exists());

    // An ignored file of the person's where the keep adds one: git would
    // write over it, so the keep refuses first.
    work.git(&repo, &["checkout", "--", "a.txt"]);
    write(&Path::new(&w.path).join("out.log"), "agent's log\n");
    work.git(Path::new(&w.path), &["add", "-f", "out.log"]);
    work.git(
        Path::new(&w.path),
        &["commit", "-q", "-m", "the agent's log"],
    );
    write(&repo.join("out.log"), "my log\n");
    let e = settle(&mut s, t, true).unwrap_err();
    assert!(e.message.contains("out.log"), "{e}");
    assert_eq!(read(repo.join("out.log")), "my log\n");
    assert_eq!(work.git(&repo, &["rev-parse", "HEAD"]), head);

    // The person moves their file aside: the keep goes through.
    std::fs::remove_file(repo.join("out.log")).unwrap();
    settle(&mut s, t, true).unwrap();
    assert_eq!(read(repo.join("a.txt")), "agent");
    assert_eq!(read(repo.join("out.log")), "agent's log\n");
}

#[test]
fn keep_merges_when_the_branch_moved_and_refuses_a_conflict_leaving_the_branch_to_merge_by_hand() {
    if !have_git() {
        return;
    }
    let work = Work::new("im");
    let repo = work.repo("app");
    let mut s = scene("im", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);

    // Moved without conflict: a merge commit of both.
    let t = pending(&mut s, "write:b.txt:agent");
    let moved = work.commit(&repo, "a.txt", "person\n", "the person's");
    settle(&mut s, t, true).unwrap();
    assert_eq!(work.git(&repo, &["rev-parse", "HEAD^1"]), moved);
    work.git(&repo, &["rev-parse", "--verify", "HEAD^2"]);
    let subject = work.git(&repo, &["log", "-1", "--format=%s"]);
    assert!(subject.starts_with("Merge branch 'tasktap/"), "{subject}");
    assert_eq!(read(repo.join("b.txt")), "agent");
    assert_eq!(read(repo.join("a.txt")), "person\n");

    // Moved with a conflict: nothing changes, and the branch is the person's to merge.
    let t = pending(&mut s, "write:a.txt:agent");
    let w = workdir(&s, t);
    let moved = work.commit(&repo, "a.txt", "person again\n", "the person's again");
    let e = settle(&mut s, t, true).unwrap_err();
    assert_eq!(e.code, Code::Failed);
    assert!(
        e.message.contains("a.txt") && e.message.contains(&w.branch),
        "{e}"
    );
    assert_eq!(work.git(&repo, &["rev-parse", "HEAD"]), moved);
    assert!(!repo.join(".git/MERGE_HEAD").exists());
    assert_eq!(work.git(&repo, &["status", "--porcelain"]), "");
    assert_eq!(read(repo.join("a.txt")), "person again\n");
    assert_eq!(changes(&s, t), Changes::Pending);
    assert!(work.branch(&repo, &w.branch).is_some());

    // Merged by hand, Keep then only tidies up.
    let out = work.try_git(&repo, &["merge", "--no-edit", &w.branch]);
    assert!(!out.status.success());
    write(&repo.join("a.txt"), "both\n");
    work.git(&repo, &["commit", "-q", "-am", "merged by hand"]);
    let merged = work.git(&repo, &["rev-parse", "HEAD"]);
    settle(&mut s, t, true).unwrap();
    assert_eq!(changes(&s, t), Changes::Kept);
    assert_eq!(work.git(&repo, &["rev-parse", "HEAD"]), merged);
    assert!(!Path::new(&w.path).exists());
    assert_eq!(work.ours(&repo), "");
}

#[test]
fn keep_into_a_branch_checked_out_nowhere_moves_only_the_branch() {
    if !have_git() {
        return;
    }
    let work = Work::new("iu");
    let repo = work.repo("app");
    let mut s = scene("iu", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:n.txt:n");
    // The person went on to another branch, with a change of their own.
    work.git(&repo, &["checkout", "-q", "-b", "elsewhere"]);
    write(&repo.join("b.txt"), "my change\n");
    settle(&mut s, t, true).unwrap();
    assert_eq!(work.git(&repo, &["show", "main:n.txt"]), "n");
    assert_eq!(
        work.git(&repo, &["symbolic-ref", "HEAD"]),
        "refs/heads/elsewhere"
    );
    assert!(!repo.join("n.txt").exists());
    assert_eq!(read(repo.join("b.txt")), "my change\n");
}

#[test]
fn keep_and_discard_wait_until_nothing_runs_in_the_worktree() {
    if !have_git() {
        return;
    }
    let work = Work::new("iw");
    let repo = work.repo("app");
    let mut s = scene("iw", &work, &repo, TALKS);
    isolate(&mut s, Isolate::Always);
    let t = capture(&mut s, "start");
    s.w.until("it started", |m| {
        let session = m.thoughts[&t].session_id.map(|id| &m.sessions[&id]);
        session.is_some_and(|s| s.terminal_id.is_some())
    });
    let session = s.w.model.thought(t).session_id.unwrap();
    let terminal = s.w.model.session(session).terminal_id.unwrap();
    let mut agent = Screen::open(&s.core, terminal);
    agent.until("fixture-agent");
    for step in [
        "event:ready",
        "event:turn_started:go",
        "write:w.txt:working",
        "event:turn_finished:done",
    ] {
        agent.line(step);
    }
    s.w.until("the turn's changes are pending", |m| {
        let th = &m.thoughts[&t];
        let w = th.workdir.as_ref();
        th.status == Status::Done && w.is_some_and(|w| w.changes == Changes::Pending)
    });
    // The agent is still there, idle: neither keep nor discard.
    for keep in [true, false] {
        let e = settle(&mut s, t, keep).unwrap_err();
        assert_eq!(e.code, Code::Conflict, "{e}");
    }
    let w = workdir(&s, t);
    assert_eq!(read(Path::new(&w.path).join("w.txt")), "working");
    agent.line("exit:0");
    s.w.until("its session ended", |m| {
        m.sessions[&session].state == SessionState::Ended
    });
    // Until its terminal has gone too, a process may still be in the worktree.
    let e = settle(&mut s, t, false);
    s.w.until("its terminal ended", |m| {
        m.terminals[&terminal].state != tasktap_proto::TerminalState::Running
    });
    if let Err(e) = e {
        assert_eq!(e.code, Code::Conflict, "{e}");
        settle(&mut s, t, false).unwrap();
    }
    assert_eq!(changes(&s, t), Changes::Discarded);
    assert!(!Path::new(&w.path).exists());
}

#[test]
fn discard_removes_the_worktree_and_its_unmerged_commits_and_nothing_of_the_persons() {
    if !have_git() {
        return;
    }
    let work = Work::new("ix");
    let repo = work.repo("app");
    write(&repo.join("b.txt"), "my change\n");
    write(&repo.join("notes.txt"), "my notes\n");
    let mut s = scene("ix", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:c.txt:agent");
    let w = workdir(&s, t);
    // The agent committed some of its work and left the rest.
    let wt = Path::new(&w.path);
    work.git(wt, &["add", "-A"]);
    work.git(wt, &["commit", "-q", "-m", "the agent's commit"]);
    write(&wt.join("d.txt"), "more");
    let refs = work.git(&repo, &["for-each-ref", "refs/heads/main"]);
    let status = work.git(&repo, &["status", "--porcelain"]);

    settle(&mut s, t, false).unwrap();
    assert_eq!(changes(&s, t), Changes::Discarded);
    assert!(!wt.exists());
    assert_eq!(work.branch(&repo, &w.branch), None);
    assert_eq!(work.git(&repo, &["for-each-ref", "refs/heads/main"]), refs);
    assert_eq!(work.git(&repo, &["status", "--porcelain"]), status);
    assert_eq!(read(repo.join("b.txt")), "my change\n");
    assert!(!repo.join("c.txt").exists());
    // Discarded: it is not settled again, and the project is quiet once more.
    assert_eq!(settle(&mut s, t, false).unwrap_err().code, Code::Conflict);
}

#[test]
fn two_isolated_thoughts_in_one_project_are_kept_in_either_order() {
    if !have_git() {
        return;
    }
    for first in [0, 1] {
        let work = Work::new("i2");
        let repo = work.repo("app");
        let mut s = scene("i2", &work, &repo, SILENT);
        isolate(&mut s, Isolate::Always);
        let both = [
            pending(&mut s, "write:x.txt:x"),
            pending(&mut s, "write:y.txt:y"),
        ];
        let head = work.git(&repo, &["rev-parse", "HEAD"]);
        settle(&mut s, both[first], true).unwrap();
        assert_eq!(
            work.git(&repo, &["rev-parse", "HEAD^"]),
            head,
            "a fast-forward"
        );
        // The second meets a destination that moved: a merge commit.
        settle(&mut s, both[1 - first], true).unwrap();
        work.git(&repo, &["rev-parse", "--verify", "HEAD^2"]);
        assert_eq!(
            (read(repo.join("x.txt")), read(repo.join("y.txt"))),
            ("x".into(), "y".into())
        );
        assert_eq!(work.git(&repo, &["status", "--porcelain"]), "");
        assert_eq!(work.ours(&repo), "");
    }
    // Two that change the same file: the second refuses, then is discarded.
    let work = Work::new("i2c");
    let repo = work.repo("app");
    let mut s = scene("i2c", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let x = pending(&mut s, "write:a.txt:x");
    let y = pending(&mut s, "write:a.txt:y");
    settle(&mut s, y, true).unwrap();
    let e = settle(&mut s, x, true).unwrap_err();
    assert!(e.message.contains("a.txt"), "{e}");
    assert_eq!(read(repo.join("a.txt")), "y");
    settle(&mut s, x, false).unwrap();
    assert_eq!(read(repo.join("a.txt")), "y");
    assert_eq!(work.ours(&repo), "");
}

/// A keep the core crashed during, before it did anything; `then` leaves
/// what the keep would have left where the crash came later. The core
/// starts again on it.
fn stopped_during(
    prefix: &str,
    keep: bool,
    then: impl FnOnce(&Work, &Path, &Workdir),
) -> (Scene, ThoughtId, Work, PathBuf, Workdir) {
    let work = Work::new(prefix);
    let repo = work.repo("app");
    let mut s = scene(prefix, &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:k.txt:kept");
    let w = workdir(&s, t);
    // Again with every git job held back, and a crash while the settle waits.
    let Scene {
        core,
        data,
        w: watch,
        ..
    } = s;
    drop((watch, core));
    let held = core_held(&data, &work);
    let mut c = held.watch();
    let settle = Settle {
        id: t,
        attempt: AttemptId::mint(),
        keep,
    };
    // Its attempt is committed before the next call is answered.
    c.send::<call::ThoughtSettle>(&settle);
    c.sync();
    drop((c, held));
    then(&work, &repo, &w);
    let s = Scene::in_folder(start(&data, &work, &[]), data, &repo, SILENT);
    (s, t, work, repo, w)
}

/// A core whose every job off its thread waits 2 s first.
fn core_held(data: &Folder, work: &Work) -> Core {
    start(data, work, &["--check-ms", "2000"])
}

#[test]
fn a_keep_the_core_stopped_during_is_decided_by_what_git_shows_at_the_next_start() {
    if !have_git() {
        return;
    }
    // Stopped before the merge, its changes committed: still pending, and a
    // new keep finishes it.
    {
        let (mut s, t, work, repo, w) = stopped_during("ic1", true, |work, _, w| {
            let wt = Path::new(&w.path);
            work.git(wt, &["add", "-A"]);
            work.git(wt, &["commit", "-q", "-m", "committed by the keep"]);
        });
        let head = work.git(&repo, &["rev-parse", "HEAD"]);
        s.w.sync();
        assert_eq!(changes(&s, t), Changes::Pending);
        assert_eq!(work.git(&repo, &["rev-parse", "HEAD"]), head);
        assert!(work.branch(&repo, &w.branch).is_some());
        settle(&mut s, t, true).unwrap();
        assert_eq!(read(repo.join("k.txt")), "kept");
        let subject = work.git(&repo, &["log", "-1", "--format=%s"]);
        assert_eq!(subject, "committed by the keep");
    }
    // Stopped after the merge: kept, and what is left is tidied away.
    {
        let (mut s, t, work, repo, w) = stopped_during("ic2", true, |work, repo, w| {
            let wt = Path::new(&w.path);
            work.git(wt, &["add", "-A"]);
            work.git(wt, &["commit", "-q", "-m", "committed by the keep"]);
            work.git(repo, &["merge", "-q", "--ff-only", &w.branch]);
        });
        s.w.until("the start decided it", |m| {
            m.thoughts[&t].workdir.as_ref().unwrap().changes == Changes::Kept
        });
        eventually("the worktree is tidied", || !Path::new(&w.path).exists());
        eventually("the branch is deleted", || {
            work.branch(&repo, &w.branch).is_none()
        });
        assert_eq!(read(repo.join("k.txt")), "kept");
        assert_eq!(settle(&mut s, t, true).unwrap_err().code, Code::Conflict);
    }
    // Stopped after it tidied up: kept.
    {
        let (mut s, t, _work, _repo, _) = stopped_during("ic3", true, |work, repo, w| {
            let wt = Path::new(&w.path);
            work.git(wt, &["add", "-A"]);
            work.git(wt, &["commit", "-q", "-m", "committed by the keep"]);
            work.git(repo, &["merge", "-q", "--ff-only", &w.branch]);
            let wt = plain(&w.path);
            let wt = wt.to_str().unwrap();
            work.git(repo, &["worktree", "remove", "--force", wt]);
            work.git(repo, &["branch", "-D", &w.branch]);
        });
        s.w.until("the start decided it", |m| {
            m.thoughts[&t].workdir.as_ref().unwrap().changes == Changes::Kept
        });
    }
    // A discard stopped after it removed everything: discarded.
    {
        let (mut s, t, _work, _repo, _) = stopped_during("ic4", false, |work, repo, w| {
            let wt = plain(&w.path);
            let wt = wt.to_str().unwrap();
            work.git(repo, &["worktree", "remove", "--force", wt]);
            work.git(repo, &["branch", "-D", &w.branch]);
        });
        s.w.until("the start decided it", |m| {
            m.thoughts[&t].workdir.as_ref().unwrap().changes == Changes::Discarded
        });
    }
    // One stopped before it did anything: still pending, nothing lost.
    let (mut s, t, _work, _repo, w) = stopped_during("ic5", false, |_, _, _| {});
    s.w.sync();
    assert_eq!(changes(&s, t), Changes::Pending);
    assert_eq!(read(Path::new(&w.path).join("k.txt")), "kept");
}

#[test]
fn a_worktree_removed_behind_the_cores_back_breaks_nothing() {
    if !have_git() {
        return;
    }
    let work = Work::new("ir");
    let repo = work.repo("app");
    let mut s = scene("ir", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    // Its work committed on its branch, then its folder deleted by hand.
    let t = pending(&mut s, "write:z.txt:z");
    let w = workdir(&s, t);
    work.git(Path::new(&w.path), &["add", "-A"]);
    work.git(Path::new(&w.path), &["commit", "-q", "-m", "the agent's"]);
    std::fs::remove_dir_all(&w.path).unwrap();
    let (listed, bytes) = diff(&s, t, None);
    assert_eq!(listed.files.len(), 1);
    assert!(String::from_utf8_lossy(&bytes).contains("+z"));
    let mut s = crashed(s, &work, &repo);
    s.w.sync();
    assert_eq!(changes(&s, t), Changes::Pending);
    settle(&mut s, t, true).unwrap();
    assert_eq!(read(repo.join("z.txt")), "z");
    assert_eq!(work.ours(&repo), "");

    // Uncommitted work deleted by hand: nothing is left to keep, and what
    // is left of the worktree goes.
    let u = pending(&mut s, "write:u.txt:u");
    let w = workdir(&s, u);
    std::fs::remove_dir_all(&w.path).unwrap();
    let mut s = crashed(s, &work, &repo);
    s.w.until("the start looked at it", |m| {
        m.thoughts[&u].workdir.as_ref().unwrap().changes == Changes::Clean
    });
    eventually("the branch is deleted", || {
        work.branch(&repo, &w.branch).is_none()
    });
    // The core goes on: another run works.
    let v = pending(&mut s, "write:v.txt:v");
    settle(&mut s, v, false).unwrap();
}

#[test]
fn a_project_whose_dot_git_is_a_file_isolates_too() {
    if !have_git() {
        return;
    }
    // A worktree of another repository as the project: its own branch is the destination.
    let work = Work::new("ig");
    let main = work.repo("main");
    let linked = work.path("linked");
    work.git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            linked.to_str().unwrap(),
        ],
    );
    let linked = std::fs::canonicalize(linked).unwrap();
    let main_head = work.git(&main, &["rev-parse", "main"]);
    let mut s = scene("ig", &work, &linked, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:f.txt:feature work");
    assert_eq!(workdir(&s, t).destination.as_deref(), Some("feature"));
    settle(&mut s, t, true).unwrap();
    assert_eq!(read(linked.join("f.txt")), "feature work");
    assert!(!main.join("f.txt").exists());
    assert_eq!(work.git(&main, &["rev-parse", "main"]), main_head);
    drop(s);

    // A submodule as the project.
    let lib = work.repo("lib");
    let outer = work.repo("outer");
    let source = plain(&lib);
    work.git(
        &outer,
        &["submodule", "add", "-q", source.to_str().unwrap(), "lib"],
    );
    work.git(&outer, &["commit", "-q", "-m", "the library"]);
    let sub = outer.join("lib");
    let outer_head = work.git(&outer, &["rev-parse", "HEAD"]);
    let mut s = scene("ig2", &work, &sub, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:g.txt:in the library");
    settle(&mut s, t, true).unwrap();
    assert_eq!(read(sub.join("g.txt")), "in the library");
    assert_eq!(work.git(&outer, &["rev-parse", "HEAD"]), outer_head);
    drop(s);

    // A project with a submodule in it: the worktree has its folder, empty,
    // and the project's submodule is left as it is.
    let sub_head = work.git(&sub, &["rev-parse", "HEAD"]);
    let mut s = scene("ig3", &work, &outer, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:h.txt:top");
    let w = workdir(&s, t);
    assert_eq!(
        std::fs::read_dir(Path::new(&w.path).join("lib"))
            .unwrap()
            .count(),
        0
    );
    assert_eq!(workdir(&s, t).files, 1);
    settle(&mut s, t, true).unwrap();
    assert_eq!(read(outer.join("h.txt")), "top");
    assert_eq!(work.git(&sub, &["rev-parse", "HEAD"]), sub_head);
    assert_eq!(read(sub.join("g.txt")), "in the library");
}

#[test]
fn paths_with_spaces_and_letters_beyond_ascii_are_kept_whole() {
    if !have_git() {
        return;
    }
    let work = Work::new("i ü");
    let repo = work.repo("my répo");
    let mut s = scene("d ä", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:dir with space/ñandú.txt:sí");
    assert!(workdir(&s, t).path.contains("d ä"));
    let (listed, _) = diff(&s, t, Some("dir with space/ñandú.txt"));
    assert_eq!(listed.files[0].path, "dir with space/ñandú.txt");
    settle(&mut s, t, true).unwrap();
    assert_eq!(read(repo.join("dir with space").join("ñandú.txt")), "sí");
}

#[test]
fn hooks_signing_and_the_persons_configuration_neither_break_nor_hold_up_git() {
    if !have_git() {
        return;
    }
    let work = Work::new("ih");
    let repo = work.repo("app");
    // Hooks that would fail or hang, in the repository and where the
    // person's configuration points, each leaving a mark if it ran.
    let marks = work.path("marks");
    std::fs::create_dir_all(&marks).unwrap();
    let hooks = work.path("hooks");
    for dir in [repo.join(".git/hooks"), hooks.clone()] {
        std::fs::create_dir_all(&dir).unwrap();
        for (hook, then) in [
            ("pre-commit", "exit 1"),
            ("commit-msg", "exit 1"),
            ("post-commit", "sleep 600"),
            ("post-checkout", "read answer; sleep 600"),
            ("pre-merge-commit", "exit 1"),
            ("post-merge", "sleep 600"),
            ("reference-transaction", "exit 1"),
        ] {
            let mark = marks.join(hook);
            let script = format!("#!/bin/sh\necho ran >> '{}'\n{then}\n", mark.display());
            let path = dir.join(hook);
            write(&path, &script);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
    }
    let fail = work.path("fail.sh");
    write(&fail, "#!/bin/sh\nexit 1\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fail, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let (hooks, fail) = (hooks.display(), fail.display());
    let config = format!(
        "[core]\n\thooksPath = {hooks}\n\tfsmonitor = {fail}\n\tpager = {fail}\n\teditor = {fail}\n\tsafecrlf = true\n\
         [commit]\n\tgpgSign = true\n[gpg]\n\tprogram = {fail}\n[color]\n\tui = always\n\
         [merge]\n\tff = false\n\tautoStash = true\n[rebase]\n\tautoStash = true\n\
         [status]\n\tshowUntrackedFiles = no\n\trenames = copies\n\
         [diff]\n\texternal = {fail}\n\tnoprefix = true\n\trelative = true\n\trenames = copies\n\
         [submodule]\n\trecurse = true\n[user]\n\tuseConfigOnly = true\n"
    )
    .replace('\\', "/");
    std::fs::write(work.core_config(), config).unwrap();

    let started = Instant::now();
    let mut s = scene("ih", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:hooked.txt:x");
    let (_, bytes) = diff(&s, t, None);
    let text = String::from_utf8(bytes).unwrap();
    assert!(
        text.contains("+++ b/hooked.txt") && !text.contains('\x1b'),
        "{text}"
    );
    // A dirty file of the person's, which a stash around the merge would touch.
    write(&repo.join("b.txt"), "my change\n");
    settle(&mut s, t, true).unwrap();
    assert_eq!(
        work.git(&repo, &["log", "-1", "--format=%an <%ae>"]),
        "Tasktap <tasktap@localhost>"
    );
    // The branch moved: a merge commit, and the folder follows.
    let u = pending(&mut s, "write:other.txt:y");
    work.commit(&repo, "a.txt", "person\n", "the person's");
    write(&repo.join("b.txt"), "my change\n");
    settle(&mut s, u, true).unwrap();
    assert_eq!(read(repo.join("other.txt")), "y");
    assert_eq!(read(repo.join("b.txt")), "my change\n");
    assert!(
        started.elapsed() < Duration::from_secs(200),
        "{:?}",
        started.elapsed()
    );
    let ran: Vec<_> = std::fs::read_dir(&marks)
        .unwrap()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    assert!(ran.is_empty(), "hooks ran: {ran:?}");
}

#[test]
fn a_run_that_cannot_have_its_worktree_fails_and_leaves_nothing_behind() {
    if !have_git() {
        return;
    }
    // A repository with no commits.
    let work = Work::new("in");
    let empty = work.path("empty");
    std::fs::create_dir_all(&empty).unwrap();
    work.git(&empty, &["init", "-q"]);
    let mut s = scene("in", &work, &empty, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = capture(&mut s, "write:a.txt:x");
    s.w.until("it failed", |m| m.thoughts[&t].status == Status::Failed);
    let th = s.w.model.thought(t);
    assert_eq!(
        (th.reason, th.workdir.clone()),
        (Some(Reason::Launch), None)
    );
    let why = &s.w.model.results_of(t)[0];
    assert_eq!(why.kind, ResultKind::Failure);
    assert!(why.summary.contains("no commits"), "{}", why.summary);
    let made = s.data.0.join("worktrees");
    let left = std::fs::read_dir(&made).map_or(0, |d| d.count());
    assert_eq!(left, 0);
    assert!(!empty.join("a.txt").exists());
    drop(s);

    // A branch of the person's with the name the launch would take.
    let repo = work.repo("app");
    let mut s = scene("in2", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let attempt = AttemptId::mint();
    let hex = attempt.uuid().simple().to_string();
    let theirs = format!("tasktap/{}", &hex[hex.len() - 12..]);
    let mine = work.commit(&repo, "mine.txt", "mine", "mine");
    work.git(&repo, &["branch", &theirs]);
    work.git(&repo, &["reset", "-q", "--hard", "HEAD^"]);
    let to = Place::Project(s.project);
    s.script(
        Route::Clear {
            to,
            brief: "write:a.txt:x".into(),
        },
        None,
    );
    let t = s.capture("write:a.txt:x");
    s.w.ok::<call::ThoughtStart>(&Start { id: t, attempt });
    s.w.until("it failed", |m| m.thoughts[&t].status == Status::Failed);
    let why = &s.w.model.results_of(t)[0];
    assert!(why.summary.contains("exists already"), "{}", why.summary);
    assert_eq!(work.branch(&repo, &theirs), Some(mine));
    let left = std::fs::read_dir(s.data.0.join("worktrees"))
        .unwrap()
        .count();
    assert_eq!(left, 0);
}

#[test]
fn a_detached_head_isolates_but_keep_leaves_the_branch_to_the_person() {
    if !have_git() {
        return;
    }
    let work = Work::new("it");
    let repo = work.repo("app");
    work.git(&repo, &["checkout", "-q", "--detach"]);
    let head = work.git(&repo, &["rev-parse", "HEAD"]);
    let mut s = scene("it", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:a.txt:x");
    let w = workdir(&s, t);
    assert_eq!((w.destination, w.base.as_str()), (None, head.as_str()));
    let e = settle(&mut s, t, true).unwrap_err();
    assert!(
        e.message.contains("detached") && e.message.contains(&w.branch),
        "{e}"
    );
    assert!(work.branch(&repo, &w.branch).is_some());
    assert_eq!(work.git(&repo, &["rev-parse", "HEAD"]), head);
    settle(&mut s, t, false).unwrap();
    assert_eq!(work.ours(&repo), "");
}

#[test]
fn a_project_moved_on_disk_does_not_stop_the_core() {
    if !have_git() {
        return;
    }
    let work = Work::new("iv");
    let repo = work.repo("app");
    let mut s = scene("iv", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:m.txt:m");
    let w = workdir(&s, t);
    std::fs::rename(&repo, work.path("moved")).unwrap();
    let e = settle(&mut s, t, true).unwrap_err();
    assert!(e.message.contains("not there"), "{e}");
    let mut s = crashed(s, &work, &work.path("elsewhere"));
    s.w.sync();
    assert_eq!(changes(&s, t), Changes::Pending);
    // Discard takes what is Tasktap's.
    settle(&mut s, t, false).unwrap();
    assert!(!Path::new(&w.path).exists());
    assert_eq!(changes(&s, t), Changes::Discarded);
}

#[test]
fn the_diff_is_a_bounded_stream_beside_a_list_of_the_files() {
    if !have_git() {
        return;
    }
    let work = Work::new("if");
    let repo = work.repo("app");
    let mut s = scene("if", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:one.txt:1");
    let wt = PathBuf::from(workdir(&s, t).path);
    write(&wt.join("two.txt"), "2\n");
    write(&wt.join("big.txt"), &"x\n".repeat(MAX_DIFF));
    std::fs::remove_file(wt.join("b.txt")).unwrap();
    let (listed, bytes) = diff(&s, t, None);
    let files: Vec<_> = listed
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.change))
        .collect();
    assert_eq!(
        files,
        [
            ("b.txt", FileChange::Deleted),
            ("big.txt", FileChange::Added),
            ("one.txt", FileChange::Added),
            ("two.txt", FileChange::Added)
        ]
    );
    assert!(listed.cut && listed.size > MAX_DIFF as u64, "{listed:?}");
    assert_eq!(bytes.len(), MAX_DIFF);
    let (one, bytes) = diff(&s, t, Some("two.txt"));
    let text = String::from_utf8(bytes).unwrap();
    assert!(
        !one.cut && text.contains("+2") && !text.contains("big.txt"),
        "{text}"
    );
}

#[test]
fn making_a_worktree_does_not_hold_up_the_core() {
    if !have_git() {
        return;
    }
    let work = Work::new("iy");
    let repo = work.repo("app");
    let data = Folder::new("iy");
    let core = core_held(&data, &work);
    let mut s = Scene::in_folder(core, data, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = capture(&mut s, "write:a.txt:x");
    // Its worktree is being made, off the core's thread, for 2 s at least.
    let asked = Instant::now();
    s.w.ok::<call::CoreStatus>(&Empty {});
    assert!(
        asked.elapsed() < Duration::from_secs(1),
        "{:?}",
        asked.elapsed()
    );
    assert_eq!(s.w.model.thought(t).workdir, None);
    s.w.until("its changes are pending", |m| {
        let w = m.thoughts[&t].workdir.as_ref();
        w.is_some_and(|w| w.changes == Changes::Pending)
    });
}

#[test]
fn a_run_that_changes_nothing_leaves_no_worktree_and_a_retry_works_where_it_began() {
    if !have_git() {
        return;
    }
    let work = Work::new("io");
    let repo = work.repo("app");
    let mut s = scene("io", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = capture(&mut s, "print:nothing to change");
    s.w.until("it is done and looked at", |m| {
        let th = &m.thoughts[&t];
        th.status == Status::Done && th.workdir.is_some()
    });
    let w = workdir(&s, t);
    eventually("the worktree is tidied", || !Path::new(&w.path).exists());
    eventually("the branch is deleted", || {
        work.branch(&repo, &w.branch).is_none()
    });
    assert_eq!(changes(&s, t), Changes::Clean);

    // A run that fails with its changes made: a retry works on them, there.
    let mut s = s.running(TALKS);
    let f = capture(&mut s, "start");
    s.w.until("it started", |m| {
        let session = m.thoughts[&f].session_id.map(|id| &m.sessions[&id]);
        session.is_some_and(|s| s.terminal_id.is_some())
    });
    let session = s.w.model.thought(f).session_id.unwrap();
    let terminal = s.w.model.session(session).terminal_id.unwrap();
    let mut agent = Screen::open(&s.core, terminal);
    agent.until("fixture-agent");
    agent.line("write:r.txt:first try");
    agent.line("exit:1");
    s.w.until("it failed with changes", |m| {
        let th = &m.thoughts[&f];
        th.status == Status::Failed
            && th
                .workdir
                .as_ref()
                .is_some_and(|w| w.changes == Changes::Pending)
    });
    let w = workdir(&s, f);
    s.w.ok::<call::ThoughtRetry>(&Ref { id: f });
    let start = Start {
        id: f,
        attempt: AttemptId::mint(),
    };
    s.w.ok::<call::ThoughtStart>(&start);
    s.w.until("it runs again", |m| {
        let th = &m.thoughts[&f];
        th.session_id != Some(session) && th.status == Status::Working
    });
    let again = s.w.model.thought(f).session_id.unwrap();
    assert_eq!(s.w.model.session(again).cwd, w.path);
    assert_eq!(read(Path::new(&w.path).join("r.txt")), "first try");
    s.w.ok::<call::ThoughtStop>(&Ref { id: f });
}

#[test]
fn the_start_sweep_removes_what_a_stopped_launch_left_and_keeps_anything_with_work_in_it() {
    if !have_git() {
        return;
    }
    let work = Work::new("iz");
    let repo = work.repo("app");
    let data = Folder::new("iz");
    std::fs::create_dir_all(data.0.join("worktrees")).unwrap();
    let made = std::fs::canonicalize(data.0.join("worktrees")).unwrap();
    let left = made.join("leftover");
    let busy = made.join("busy");
    for (path, branch) in [(&left, "tasktap/leftover"), (&busy, "tasktap/busy")] {
        let path = plain(path);
        work.git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                branch,
                path.to_str().unwrap(),
            ],
        );
    }
    write(&busy.join("work.txt"), "someone's work");
    write(&made.join(".look-0a1b2c.index"), "stale");
    let s = Scene::in_folder(start(&data, &work, &[]), data, &repo, SILENT);
    eventually("the leftover is removed", || !left.exists());
    eventually("its branch is deleted", || {
        work.branch(&repo, "tasktap/leftover").is_none()
    });
    eventually("the stale index is removed", || {
        !made.join(".look-0a1b2c.index").exists()
    });
    assert_eq!(read(busy.join("work.txt")), "someone's work");
    assert!(work.branch(&repo, "tasktap/busy").is_some());
    drop(s);
}
