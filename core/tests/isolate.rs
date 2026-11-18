//! Isolated runs (design §7, "Isolation") through the real binary, with
//! real git repositories in temporary folders. Each run is a fixture agent
//! the real launcher starts, which changes files in its working folder
//! with its `write` step. The tests try to break the design's promise in
//! its three tiers. Nothing of the person's is lost or altered except that
//! a Keep adds commits as a fast-forward of their own would: their
//! uncommitted work, their ignored files and their branches, across
//! refusals, a crash before every step of a keep and of a discard, a folder
//! that switches branch at that moment, and a worktree removed behind the
//! core's back. A worktree goes only on a Discard, after a Keep, or when git
//! itself agrees nothing is in it, whatever came after the core looked. And
//! git runs as the person's own, with hooks off and nothing that hangs. Git
//! runs with no configuration of whoever runs the tests; where git is not
//! installed every test says so and passes.

mod common;

use common::*;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, Instant};
use tasktap_proto::call::{self, Error};
use tasktap_proto::{
    AttemptId, Changes, Code, Control, Data, Diff, Empty, FileChange, Frame, Isolate, MAX_DIFF,
    Mode, Outcome, Phase, Place, ProjectPatch, Put, PutTarget, ReadChanges, Reason, Ref,
    ResultKind, Rev, Route, SessionState, Settle, Source, Start, StartTerminal, Status, TerminalId,
    Thought, ThoughtId, Uuid, Workdir,
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
        std::fs::create_dir_all(work.pause()).unwrap();
        work
    }

    /// Where a test holds the core at a step of its git work.
    fn pause(&self) -> PathBuf {
        self.path("pause")
    }

    /// The core stops before `step` from now on, until [`Work::release`].
    fn hold(&self, step: &str) {
        for done in ["ready", "go"] {
            let _ = std::fs::remove_file(self.pause().join(format!("{step}.{done}")));
        }
        write(&self.pause().join(format!("{step}.wait")), "");
    }

    /// Waits until the core stopped before `step`.
    fn held(&self, step: &str) {
        let ready = self.pause().join(format!("{step}.ready"));
        eventually("the core stops where it was asked to", || ready.exists());
    }

    fn release(&self, step: &str) {
        write(&self.pause().join(format!("{step}.go")), "");
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
            // No upkeep left running in a worktree after a commit there: for
            // the moment it runs it is a process working in that worktree.
            .args(["-c", "maintenance.auto=false", "-c", "gc.auto=0"])
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
    start_blind(data, work, extra, "")
}

/// [`start`], on a system that does not show the core what `blind` names:
/// `processes`, or their working `folders`.
fn start_blind(data: &Folder, work: &Work, extra: &[&str], blind: &str) -> Core {
    let path = path_with(&agents(&data.0));
    let config = work.core_config();
    let pause = work.pause();
    let env = [
        ("PATH", path.as_str()),
        ("GIT_CONFIG_GLOBAL", config.to_str().unwrap()),
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("TASKTAP_FIXTURE_PAUSE", pause.to_str().unwrap()),
        ("TASKTAP_FIXTURE_BLIND", blind),
        ("SHELL", "/bin/sh"),
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
    s.w.until("its changes are pending, or it failed", |m| {
        let th = &m.thoughts[&t];
        let w = th.workdir.as_ref();
        th.status == Status::Failed || w.is_some_and(|w| w.changes == Changes::Pending)
    });
    let failed =
        s.w.model
            .results_of(t)
            .iter()
            .map(|r| r.summary.clone())
            .collect::<Vec<_>>();
    assert_ne!(s.w.model.thought(t).status, Status::Failed, "{failed:?}");
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
/// A busy Windows runner starts each git command slowly, and a look or a
/// tidy runs a dozen of them.
fn eventually(what: &str, done: impl FnMut() -> bool) {
    eventually_shown(what, done, String::new);
}

/// [`eventually`], saying what `shown` finds when it never happens.
fn eventually_shown(what: &str, mut done: impl FnMut() -> bool, shown: impl Fn() -> String) {
    let patience = if cfg!(windows) { 120 } else { 20 };
    let deadline = Instant::now() + Duration::from_secs(patience);
    while !done() {
        assert!(
            Instant::now() < deadline,
            "{what} never happened {}",
            shown()
        );
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

/// A settle the core crashed during, just before its step `step`, of a
/// thought that wrote `k.txt`, in a project folder that holds a change, a
/// new file and an ignored file of the person's; and the core started again,
/// its sweep done.
struct Crashed {
    s: Scene,
    t: ThoughtId,
    work: Work,
    repo: PathBuf,
    w: Workdir,
    head: String,
}

fn crashed_before(prefix: &str, keep: bool, step: &str) -> Crashed {
    let work = Work::new(prefix);
    let repo = work.repo("app");
    write(&repo.join("b.txt"), "my change\n");
    write(&repo.join("notes.txt"), "my notes\n");
    write(&repo.join("mine.log"), "my log\n");
    let head = work.git(&repo, &["rev-parse", "HEAD"]);
    let mut s = scene(prefix, &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:k.txt:kept");
    let w = workdir(&s, t);
    work.hold(step);
    let settle = Settle {
        id: t,
        attempt: AttemptId::mint(),
        keep,
    };
    s.w.send::<call::ThoughtSettle>(&settle);
    work.held(step);
    // The core that starts again stops nowhere.
    std::fs::remove_file(work.pause().join(format!("{step}.wait"))).unwrap();
    let swept = sentinel(&s.data);
    let mut s = crashed(s, &work, &repo);
    eventually("the start sweep ran", || !swept.exists());
    s.w.sync();
    Crashed {
        s,
        t,
        work,
        repo,
        w,
        head,
    }
}

impl Crashed {
    /// Nothing of the person's is lost or altered: what they had changed,
    /// untracked and ignored is as it was, and `main` is where it was or
    /// one fast-forward on, with the thought's file. Returns which.
    fn kept(&self) -> bool {
        assert_eq!(read(self.repo.join("b.txt")), "my change\n");
        assert_eq!(read(self.repo.join("notes.txt")), "my notes\n");
        assert_eq!(read(self.repo.join("mine.log")), "my log\n");
        let on = self.work.git(&self.repo, &["symbolic-ref", "HEAD"]);
        assert_eq!(on, "refs/heads/main");
        if self.work.git(&self.repo, &["rev-parse", "main"]) == self.head {
            assert!(!self.repo.join("k.txt").exists());
            return false;
        }
        assert_eq!(
            self.work.git(&self.repo, &["rev-parse", "main^"]),
            self.head
        );
        assert_eq!(read(self.repo.join("k.txt")), "kept");
        true
    }

    fn changes(&self) -> Changes {
        changes(&self.s, self.t)
    }

    /// Nothing is left of the worktree, nor of its branch.
    fn gone(&self) -> bool {
        !Path::new(&self.w.path).exists() && self.work.ours(&self.repo).is_empty()
    }
}

#[test]
fn a_crash_before_any_step_of_a_keep_loses_nothing_and_the_next_keep_or_discard_decides_it() {
    if !have_git() {
        return;
    }
    // Before it commits, before it moves the branch, before it removes the
    // worktree, and before it deletes the worktree's branch.
    for step in ["commit", "keep", "remove", "branch"] {
        for again in [true, false] {
            let mut c = crashed_before("ck", true, step);
            let merged = c.kept();
            assert_eq!(merged, matches!(step, "remove" | "branch"), "{step}");
            assert_eq!(c.changes(), Changes::Pending, "{step}");
            settle(&mut c.s, c.t, again).unwrap_or_else(|e| panic!("{step} {again}: {e}"));
            // Kept by the Keep, or found kept by the Discard; discarded only
            // where nothing had reached main.
            let kept = again || merged;
            let settled = if kept {
                Changes::Kept
            } else {
                Changes::Discarded
            };
            assert_eq!(c.changes(), settled, "{step} {again}");
            assert_eq!(c.kept(), kept, "{step} {again}");
            assert!(c.gone(), "{step} {again}");
        }
    }
    // After its last step, before the record: kept, as git shows.
    let mut c = crashed_before("ck", true, "done");
    let t = c.t;
    c.s.w.until("the start decided it", |m| {
        m.thoughts[&t].workdir.as_ref().unwrap().changes == Changes::Kept
    });
    assert!(c.kept() && c.gone());
}

#[test]
fn a_crash_before_any_step_of_a_discard_loses_nothing_of_the_persons_and_leaves_it_decidable() {
    if !have_git() {
        return;
    }
    // Before it removed anything: still pending, all of it there.
    for again in [true, false] {
        let mut c = crashed_before("cd", false, "remove");
        assert!(!c.kept());
        assert_eq!(c.changes(), Changes::Pending);
        assert_eq!(read(Path::new(&c.w.path).join("k.txt")), "kept");
        settle(&mut c.s, c.t, again).unwrap();
        let settled = if again {
            Changes::Kept
        } else {
            Changes::Discarded
        };
        assert_eq!(c.changes(), settled);
        assert_eq!(c.kept(), again);
        assert!(c.gone());
    }
    // Between the folder and its branch: what is left holds nothing, and goes.
    let mut c = crashed_before("cd", false, "branch");
    let t = c.t;
    c.s.w.until("the start looked at it", |m| {
        m.thoughts[&t].workdir.as_ref().unwrap().changes == Changes::Clean
    });
    eventually("the branch is deleted", || c.gone());
    assert!(!c.kept());
    // After its last step, before the record: discarded, as git shows.
    let mut c = crashed_before("cd", false, "done");
    let t = c.t;
    c.s.w.until("the start decided it", |m| {
        m.thoughts[&t].workdir.as_ref().unwrap().changes == Changes::Discarded
    });
    assert!(!c.kept() && c.gone());
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
         [submodule]\n\trecurse = true\n[user]\n\tuseConfigOnly = true\n\
         [worktree]\n\tuseRelativePaths = true\n"
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
    let left = std::fs::read_dir(&made).map_or(Vec::new(), |d| d.flatten().collect());
    let left: Vec<_> = (left.iter().map(|e| e.file_name()))
        .filter(|n| !n.to_string_lossy().starts_with('.'))
        .collect();
    assert!(left.is_empty(), "{left:?}");
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
    let left: Vec<_> = (std::fs::read_dir(s.data.0.join("worktrees"))
        .unwrap()
        .flatten())
    .map(|e| e.file_name())
    .filter(|n| !n.to_string_lossy().starts_with('.'))
    .collect();
    assert!(left.is_empty(), "{left:?}");
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
    // Every job off the core's thread waits 2 s first.
    let core = start(&data, &work, &["--check-ms", "2000"]);
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
    let root = s.data.0.join("worktrees");
    let left = || {
        let status = ["status", "--porcelain", "--ignored=matching", "-uall"];
        let wt = Path::new(&w.path);
        let status = wt.exists().then(|| work.git(wt, &status));
        format!("{:?} {status:?}", files_in(&root))
    };
    eventually_shown(
        "the worktree is tidied",
        || !Path::new(&w.path).exists(),
        left,
    );
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
fn the_start_sweep_removes_what_a_stopped_launch_left_and_keeps_anything_else() {
    if !have_git() {
        return;
    }
    let work = Work::new("iz");
    let repo = work.repo("app");
    let data = Folder::new("iz");
    let mut s = Scene::in_folder(start(&data, &work, &[]), data, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    // Launches the store records, the fixture launcher standing in.
    s.agent = None;
    s.log();
    let names: Vec<String> = (0..2)
        .map(|_| {
            let t = s.capture("one");
            let attempt = AttemptId::mint();
            s.w.ok::<call::ThoughtStart>(&Start { id: t, attempt });
            let hex = attempt.uuid().simple().to_string();
            hex[hex.len() - 12..].to_owned()
        })
        .collect();
    let Scene { core, data, w, .. } = s;
    drop((w, core));
    // Each made its worktree and stopped before recording it; one has work
    // in it. A third no launch made.
    std::fs::create_dir_all(data.0.join("worktrees")).unwrap();
    let made = std::fs::canonicalize(data.0.join("worktrees")).unwrap();
    let paths: Vec<_> = (names.iter().map(String::as_str))
        .chain(["0123456789ab"])
        .map(|name| {
            let path = made.join(name);
            let branch = format!("tasktap/{name}");
            let at = plain(&path);
            work.git(
                &repo,
                &["worktree", "add", "-q", "-b", &branch, at.to_str().unwrap()],
            );
            (path, branch)
        })
        .collect();
    write(&paths[1].0.join("work.txt"), "someone's work");
    write(&paths[2].0.join("draft.txt"), "mine");
    write(&made.join(".tmp-0a1b2c.index"), "stale");
    let s = Scene::in_folder(start(&data, &work, &[]), data, &repo, SILENT);
    eventually("the leftover is removed", || !paths[0].0.exists());
    eventually("its branch is deleted", || {
        work.branch(&repo, &paths[0].1).is_none()
    });
    eventually("the stale index is removed", || {
        !made.join(".tmp-0a1b2c.index").exists()
    });
    assert_eq!(read(paths[1].0.join("work.txt")), "someone's work");
    assert_eq!(read(paths[2].0.join("draft.txt")), "mine");
    assert!(work.branch(&repo, &paths[1].1).is_some());
    assert!(work.branch(&repo, &paths[2].1).is_some());
    drop(s);
}

// The findings of two independent reviews, each first reproduced, then
// closed: by a fix, or by removing what it was a finding of.

/// A thought whose record says it ran in `workdir`, its changes pending,
/// written straight into the store as a damaged or forged record would be.
fn forge(s: &mut Scene, workdir: Workdir) -> ThoughtId {
    let t = Thought {
        id: ThoughtId::mint(),
        rev: Rev::ZERO,
        text: "forged".into(),
        strokes: Vec::new(),
        source: Source::Typed,
        mode: Mode::Ask,
        phase: Phase::Done,
        status: Status::Done,
        reason: None,
        live: true,
        project_id: Some(s.project),
        session_id: None,
        brief: None,
        route: None,
        placed: None,
        agent: Some(SILENT.into()),
        model: None,
        workdir: Some(workdir),
        hold_until: None,
        read: false,
        created: time(s.now),
        updated: time(s.now),
    };
    let sets = serde_json::json!([{ "c": "thoughts", "put": [t] }]);
    let written =
        s.w.raw("fixture.records", serde_json::json!({ "sets": sets }));
    assert!(matches!(written, Outcome::Ok(_)), "{written:?}");
    t.id
}

/// A file the start sweep removes once it has looked at every recorded
/// worktree.
fn sentinel(data: &Folder) -> PathBuf {
    let path = data.0.join("worktrees").join(".tmp-sentinel.out");
    write(&path, "");
    path
}

fn files_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<_> = (std::fs::read_dir(dir).unwrap().flatten())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn review_1_nothing_outside_the_worktrees_the_core_made_is_ever_removed() {
    if !have_git() {
        return;
    }
    let work = Work::new("r1");
    let repo = work.repo("app");
    let mut s = scene("r1", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:a.txt:x");
    let real = workdir(&s, t);
    let root = std::fs::canonicalize(s.data.0.join("worktrees")).unwrap();
    // A folder beside the worktrees, and records that name it.
    let victim = s.data.0.join("victim");
    write(&victim.join("precious.txt"), "mine");
    let forged = |path: PathBuf, name: &str| Workdir {
        path: path.to_string_lossy().into_owned(),
        branch: format!("tasktap/{name}"),
        ..real.clone()
    };
    let up = forge(
        &mut s,
        forged(root.join("..").join("victim"), "aaaaaaaaaaaa"),
    );
    let nested = forge(
        &mut s,
        forged(
            root.join("x").join("..").join("..").join("victim"),
            "victim",
        ),
    );
    for t in [up, nested] {
        assert!(settle(&mut s, t, false).is_err());
        assert!(settle(&mut s, t, true).is_err());
        assert_eq!(read(victim.join("precious.txt")), "mine");
    }
    // Reached through a link from inside the worktrees' folder.
    #[cfg(unix)]
    {
        let elsewhere = s.data.0.join("elsewhere");
        write(&elsewhere.join("precious.txt"), "mine");
        let link = root.join("bbbbbbbbbbbb");
        std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
        let linked = forge(&mut s, forged(link.clone(), "bbbbbbbbbbbb"));
        assert!(settle(&mut s, linked, false).is_err());
        assert_eq!(read(elsewhere.join("precious.txt")), "mine");
        assert!(link.symlink_metadata().is_ok());
    }
    // Folders under the worktrees' folder no record names and git cannot
    // tie to anything the core made stay through a start.
    write(&root.join("notes").join("todo.txt"), "mine");
    write(&root.join("cccccccccccc").join("draft.txt"), "mine");
    let swept = sentinel(&s.data);
    let mut s = crashed(s, &work, &repo);
    eventually("the start sweep ran", || !swept.exists());
    s.w.sync();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(read(root.join("notes").join("todo.txt")), "mine");
    assert_eq!(read(root.join("cccccccccccc").join("draft.txt")), "mine");
    assert_eq!(read(victim.join("precious.txt")), "mine");
    // The real one is still what the core made, and discards.
    settle(&mut s, t, false).unwrap();
    assert!(!Path::new(&real.path).exists());
}

#[test]
fn review_2_keep_never_writes_over_an_ignored_file_that_appears_after_its_check() {
    if !have_git() {
        return;
    }
    let work = Work::new("r2");
    let repo = work.repo("app");
    let mut s = scene("r2", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:x.txt:x");
    let wt = PathBuf::from(workdir(&s, t).path);
    write(&wt.join("out.log"), "agent's log\n");
    work.git(&wt, &["add", "-f", "out.log"]);
    work.git(&wt, &["commit", "-q", "-m", "the agent's log"]);
    let head = work.git(&repo, &["rev-parse", "HEAD"]);
    work.hold("keep");
    let settle_args = Settle {
        id: t,
        attempt: AttemptId::mint(),
        keep: true,
    };
    let call = s.w.send::<call::ThoughtSettle>(&settle_args);
    work.held("keep");
    // The person's build writes an ignored file where the keep adds one.
    write(&repo.join("out.log"), "my log\n");
    work.release("keep");
    assert!(s.w.reply::<call::ThoughtSettle>(call).is_err());
    assert_eq!(read(repo.join("out.log")), "my log\n");
    assert_eq!(work.git(&repo, &["rev-parse", "HEAD"]), head);
    assert_eq!(changes(&s, t), Changes::Pending);
}

/// Another attempt id that names the same worktree: the same last twelve
/// hex digits.
fn twin(a: AttemptId) -> AttemptId {
    let text = a.uuid().to_string();
    let first = u32::from_str_radix(&text[..8], 16).unwrap().wrapping_add(1);
    let other = format!("{first:08x}{}", &text[8..]);
    AttemptId::try_from(Uuid::parse_str(&other).unwrap()).unwrap()
}

#[test]
fn review_3_two_starts_that_would_take_one_worktree_never_undo_each_other() {
    if !have_git() {
        return;
    }
    let work = Work::new("r3");
    let repo = work.repo("app");
    let data = Folder::new("r3");
    // Every job waits a little first, so both makings run at once.
    let core = start(&data, &work, &["--check-ms", "1500"]);
    let mut s = Scene::in_folder(core, data, &repo, TALKS);
    isolate(&mut s, Isolate::Always);
    let to = Place::Project(s.project);
    s.script(
        Route::Clear {
            to,
            brief: "start".into(),
        },
        None,
    );
    let (a, b) = (s.capture("one"), s.capture("two"));
    let first = AttemptId::mint();
    for (t, attempt) in [(a, first), (b, twin(first))] {
        s.w.ok::<call::ThoughtStart>(&Start { id: t, attempt });
    }
    s.w.until("one runs and the other failed", |m| {
        let runs = |t| {
            let th = &m.thoughts[&t];
            let session = th.session_id.map(|id| &m.sessions[&id]);
            th.workdir.is_some() && session.is_some_and(|s| s.terminal_id.is_some())
        };
        let failed = |t| m.thoughts[&t].status == Status::Failed;
        (runs(a) && failed(b)) || (runs(b) && failed(a))
    });
    let winner = if s.w.model.thought(a).status == Status::Failed {
        b
    } else {
        a
    };
    let w = workdir(&s, winner);
    assert!(Path::new(&w.path).join(".git").exists(), "{w:?}");
    assert!(work.branch(&repo, &w.branch).is_some());
    let session = s.w.model.thought(winner).session_id.unwrap();
    let terminal = s.w.model.session(session).terminal_id.unwrap();
    assert_eq!(
        s.w.model.terminals[&terminal].state,
        tasktap_proto::TerminalState::Running
    );
    s.w.ok::<call::ThoughtStop>(&Ref { id: winner });
}

#[test]
fn review_4_a_git_command_that_outlives_a_crashed_core_finishes_and_keep_goes_on_from_there() {
    if !have_git() {
        return;
    }
    let work = Work::new("r4");
    // The person's git waits for a ref lock rather than failing at once.
    std::fs::write(
        work.core_config(),
        "[core]\n\tfilesRefLockTimeout = 600000\n",
    )
    .unwrap();
    let repo = work.repo("app");
    let head = work.git(&repo, &["rev-parse", "HEAD"]);
    let mut s = scene("r4", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:k.txt:kept");
    let w = workdir(&s, t);
    // A git command of the person's holds main, so the keep's merge waits.
    let lock = repo
        .join(".git")
        .join("refs")
        .join("heads")
        .join("main.lock");
    write(&lock, "");
    let settle_args = Settle {
        id: t,
        attempt: AttemptId::mint(),
        keep: true,
    };
    s.w.send::<call::ThoughtSettle>(&settle_args);
    eventually("the merge waits on the lock", || {
        repo.join("k.txt").exists()
    });
    // The core stops; its git goes on waiting. Nothing is decided for it:
    // the changes are pending, as git shows them.
    let mut s = crashed(s, &work, &repo);
    s.w.sync();
    assert_eq!(changes(&s, t), Changes::Pending);
    assert_eq!(work.git(&repo, &["rev-parse", "main"]), head);
    assert!(Path::new(&w.path).exists());
    // It ends: the keep it was part of happened, and Keep only tidies up.
    std::fs::remove_file(&lock).unwrap();
    eventually("the old merge finishes", || {
        work.git(&repo, &["log", "-1", "--format=%s"]) == "write:k.txt:kept"
    });
    settle(&mut s, t, true).unwrap();
    assert_eq!(changes(&s, t), Changes::Kept);
    assert_eq!(work.git(&repo, &["rev-parse", "main^"]), head);
    assert!(!Path::new(&w.path).exists());
    assert_eq!(work.ours(&repo), "");
}

#[test]
fn review_5_a_filter_runs_as_the_persons_git_runs_it_so_its_files_are_kept_as_theirs_are() {
    if !have_git() {
        return;
    }
    let work = Work::new("r5");
    let repo = work.repo("app");
    // A filter as Git LFS is one: what is stored is not what the folder holds.
    let config = "[filter \"x\"]\n\tclean = tr a-z A-Z\n\tsmudge = tr A-Z a-z\n";
    std::fs::write(work.core_config(), config).unwrap();
    work.commit(&repo, ".gitattributes", "*.dat filter=x\n", "attributes");
    let mut s = scene("r5", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:d.dat:data");
    let (listed, _) = diff(&s, t, None);
    assert!(listed.files.iter().any(|f| f.path == "d.dat"));
    settle(&mut s, t, true).unwrap();
    assert_eq!(changes(&s, t), Changes::Kept);
    // Stored as the filter cleans it, and in the folder as it smudges it.
    assert_eq!(work.git(&repo, &["show", "main:d.dat"]), "DATA");
    assert_eq!(read(repo.join("d.dat")), "data");
}

#[test]
fn review_6_a_worktree_with_anything_staged_or_ignored_in_it_is_never_tidied_away() {
    if !have_git() {
        return;
    }
    let work = Work::new("r6");
    let repo = work.repo("app");
    let mut s = scene("r6", &work, &repo, TALKS);
    isolate(&mut s, Isolate::Always);
    let t = capture(&mut s, "start");
    s.w.until("it started", |m| {
        let session = m.thoughts[&t].session_id.map(|id| &m.sessions[&id]);
        session.is_some_and(|s| s.terminal_id.is_some())
    });
    let wt = PathBuf::from(workdir(&s, t).path);
    // Staged, then the working copy put back: only the index differs.
    write(&wt.join("b.txt"), "staged\n");
    work.git(&wt, &["add", "b.txt"]);
    write(&wt.join("b.txt"), "bee\n");
    let session = s.w.model.thought(t).session_id.unwrap();
    let terminal = s.w.model.session(session).terminal_id.unwrap();
    let mut agent = Screen::open(&s.core, terminal);
    agent.until("fixture-agent");
    agent.line("exit:0");
    s.w.until("its changes are pending", |m| {
        let w = m.thoughts[&t].workdir.as_ref();
        w.is_some_and(|w| w.changes == Changes::Pending)
    });
    // Only an ignored file.
    let mut s = s.running(SILENT);
    let i = pending(&mut s, "write:out.log:built");
    let iw = PathBuf::from(workdir(&s, i).path);
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(work.git(&wt, &["diff", "--cached", "--name-only"]), "b.txt");
    assert_eq!(read(iw.join("out.log")), "built");
}

#[test]
fn review_7_a_worktree_whose_git_link_is_gone_is_left_for_the_person_to_discard() {
    if !have_git() {
        return;
    }
    let work = Work::new("r7");
    let repo = work.repo("app");
    let mut s = scene("r7", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:u.txt:mine");
    let wt = PathBuf::from(workdir(&s, t).path);
    std::fs::remove_file(wt.join(".git")).unwrap();
    let swept = sentinel(&s.data);
    let mut s = crashed(s, &work, &repo);
    eventually("the start sweep ran", || !swept.exists());
    s.w.sync();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(read(wt.join("u.txt")), "mine");
    assert_eq!(changes(&s, t), Changes::Pending);
    // Kept, it cannot be; discarded on the person's word, it goes.
    assert!(settle(&mut s, t, true).is_err());
    settle(&mut s, t, false).unwrap();
    assert!(!wt.exists());
}

#[test]
fn review_8_a_merge_preference_of_the_persons_does_not_change_what_keep_does() {
    if !have_git() {
        return;
    }
    let work = Work::new("r8");
    let config = "[branch \"main\"]\n\tmergeOptions = --squash\n[merge]\n\tff = false\n";
    std::fs::write(work.core_config(), config).unwrap();
    let repo = work.repo("app");
    let head = work.git(&repo, &["rev-parse", "HEAD"]);
    let mut s = scene("r8", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:n.txt:n");
    settle(&mut s, t, true).unwrap();
    assert_eq!(work.git(&repo, &["rev-parse", "HEAD^"]), head);
    assert_eq!(
        work.git(&repo, &["log", "-1", "--format=%s"]),
        "write:n.txt:n"
    );
    assert_eq!(work.git(&repo, &["status", "--porcelain"]), "");
}

#[test]
fn review_9_a_folder_that_switches_branch_during_a_keep_is_reported_as_it_is_and_nothing_undone() {
    if !have_git() {
        return;
    }
    let work = Work::new("r9");
    let repo = work.repo("app");
    let head = work.git(&repo, &["rev-parse", "HEAD"]);
    work.git(&repo, &["branch", "other"]);
    let mut s = scene("r9", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:n.txt:n");
    let w = workdir(&s, t);
    // Stopped before git merges into the folder that has main, which then
    // switches to another branch.
    work.hold("keep");
    let held = |s: &mut Scene, t| {
        let settle = Settle {
            id: t,
            attempt: AttemptId::mint(),
            keep: true,
        };
        let call = s.w.send::<call::ThoughtSettle>(&settle);
        work.held("keep");
        call
    };
    let call = held(&mut s, t);
    work.git(&repo, &["checkout", "-q", "other"]);
    work.release("keep");
    let e = s.w.reply::<call::ThoughtSettle>(call).unwrap_err();
    for part in ["merged into other", "ORIG_HEAD", w.branch.as_str()] {
        assert!(e.message.contains(part), "{e}");
    }
    // What git did is left as it is, and said: the branch the folder went
    // to has the commit, main is where it was, and the changes still wait.
    let tip = work.branch(&repo, &w.branch).unwrap();
    assert_eq!(work.git(&repo, &["rev-parse", "other"]), tip);
    assert_eq!(work.git(&repo, &["rev-parse", "main"]), head);
    assert_eq!(
        work.git(&repo, &["symbolic-ref", "HEAD"]),
        "refs/heads/other"
    );
    assert_eq!(read(repo.join("n.txt")), "n");
    assert_eq!(work.git(&repo, &["status", "--porcelain"]), "");
    assert!(Path::new(&w.path).join("n.txt").exists());
    assert_eq!(changes(&s, t), Changes::Pending);
    // The next Keep goes on from there: main, checked out nowhere now.
    std::fs::remove_file(work.pause().join("keep.wait")).unwrap();
    settle(&mut s, t, true).unwrap();
    assert_eq!(work.git(&repo, &["rev-parse", "main"]), tip);
    assert_eq!(changes(&s, t), Changes::Kept);

    // Checked out nowhere when the keep looked, and checked out before it
    // moved the branch: main has the commit, and the folder that took it is
    // said to hold the files from before, with the command that brings
    // them in.
    work.git(&repo, &["checkout", "-q", "main"]);
    let u = pending(&mut s, "write:m.txt:m");
    let w = workdir(&s, u);
    work.git(&repo, &["checkout", "-q", "other"]);
    write(&repo.join("b.txt"), "my change\n");
    work.hold("keep");
    let call = held(&mut s, u);
    work.git(&repo, &["checkout", "-q", "main"]);
    work.release("keep");
    let e = s.w.reply::<call::ThoughtSettle>(call).unwrap_err();
    assert!(e.message.contains("The changes are in main"), "{e}");
    let now = work.git(&repo, &["rev-parse", "main"]);
    assert_eq!(work.git(&repo, &["rev-parse", "main^"]), tip);
    assert!(!repo.join("m.txt").exists());
    assert_eq!(read(repo.join("b.txt")), "my change\n");
    assert_eq!(changes(&s, u), Changes::Pending);
    let bring = format!("git read-tree -m -u {tip} {now}");
    assert!(e.message.contains(&bring), "{e}");
    work.git(&repo, &["read-tree", "-m", "-u", &tip, &now]);
    assert_eq!(read(repo.join("m.txt")), "m");
    assert_eq!(read(repo.join("b.txt")), "my change\n");
    assert_eq!(work.git(&repo, &["status", "--porcelain"]), " M b.txt");
    // Keep again only tidies up.
    std::fs::remove_file(work.pause().join("keep.wait")).unwrap();
    settle(&mut s, u, true).unwrap();
    assert_eq!(changes(&s, u), Changes::Kept);
    assert_eq!(work.git(&repo, &["rev-parse", "main"]), now);
    assert!(!Path::new(&w.path).exists());
    assert_eq!(work.ours(&repo), "");
}

#[test]
fn review_10_a_shell_of_the_core_that_went_into_a_worktree_holds_it() {
    if !have_git() {
        return;
    }
    let work = Work::new("r10");
    let repo = work.repo("app");
    let mut s = scene("r10", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:a.txt:x");
    let wt = PathBuf::from(workdir(&s, t).path);
    let start = StartTerminal {
        project: Some(s.project),
        argv: Vec::new(),
        title: None,
    };
    let mut shell = Screen::start(&s.core, TerminalId::mint(), Some(start));
    let (said, shown) = if cfg!(windows) {
        ("echo in^side", "inside")
    } else {
        ("echo in''side", "inside")
    };
    shell.line(&format!("cd \"{}\" && {said}", plain(&wt).display()));
    shell.until(shown);
    let e = settle(&mut s, t, false).unwrap_err();
    assert!(e.message.contains("in use"), "{e}");
    assert_eq!(read(wt.join("a.txt")), "x");
    let (said, shown) = if cfg!(windows) {
        ("echo out^side", "outside")
    } else {
        ("echo out''side", "outside")
    };
    shell.line(&format!("cd .. && {said}"));
    shell.until(shown);
    settle(&mut s, t, false).unwrap();
    assert!(!wt.exists());
}

// The second review's findings that the simpler contract answers with a
// rule of its own.

#[test]
fn review2_6_what_comes_after_the_look_keeps_the_core_from_removing_a_worktree() {
    if !have_git() {
        return;
    }
    let work = Work::new("s6");
    // A preference that would hide untracked files from git's own check.
    std::fs::write(work.core_config(), "[status]\n\tshowUntrackedFiles = no\n").unwrap();
    let repo = work.repo("app");
    let mut s = scene("s6", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let wt_arg = |w: &Workdir| plain(&w.path).to_string_lossy().into_owned();
    // Each run changes nothing, so the core goes to remove its worktree,
    // and is stopped before it looks again (`tidy`), or after that and
    // before git removes it (`remove`); then something arrives there.
    type Arrives<'a> = &'a dyn Fn(&Workdir) -> Option<&'static str>;
    let file: Arrives = &|w| {
        write(&Path::new(&w.path).join("late.txt"), "late");
        Some("late.txt")
    };
    let ignored: Arrives = &|w| {
        write(&Path::new(&w.path).join("late.log"), "late");
        Some("late.log")
    };
    let commit: Arrives = &|w| {
        let commit = ["commit", "-q", "--allow-empty", "-m", "late"];
        work.git(Path::new(&w.path), &commit);
        None
    };
    let lock: Arrives = &|w| {
        work.git(&repo, &["worktree", "lock", &wt_arg(w)]);
        None
    };
    let cases = [
        ("a file", "tidy", file),
        ("an ignored file", "tidy", ignored),
        ("a commit", "tidy", commit),
        ("a lock of the person's, which git honours", "tidy", lock),
        // Git's own check, whatever the person's preference hides.
        ("a file", "remove", file),
        // The folder holds nothing but the commit, so git removes it; the
        // branch, which is not where it was, stays with the commit.
        ("a commit", "remove", commit),
    ];
    for (what, step, arrives) in cases {
        work.hold(step);
        let t = capture(&mut s, "print:nothing to change");
        work.held(step);
        s.w.sync();
        let w = workdir(&s, t);
        assert_eq!(w.changes, Changes::Clean, "{what}");
        let late = arrives(&w);
        let tip = work.branch(&repo, &w.branch);
        work.release(step);
        // What arrived stays, and is the person's to keep or discard.
        s.w.until("it is found to hold something", |m| {
            m.thoughts[&t].workdir.as_ref().unwrap().changes == Changes::Pending
        });
        let stays = (what, step) != ("a commit", "remove");
        assert_eq!(Path::new(&w.path).join("a.txt").exists(), stays, "{what}");
        if let Some(late) = late {
            assert_eq!(read(Path::new(&w.path).join(late)), "late", "{what}");
        }
        assert_eq!(work.branch(&repo, &w.branch), tip, "{what}");
        settle(&mut s, t, false).unwrap();
        assert!(!Path::new(&w.path).exists(), "{what}");
        assert_eq!(work.branch(&repo, &w.branch), None, "{what}");
    }
}

#[test]
fn a_worktree_git_will_not_remove_stays_after_a_keep_and_a_discard_then_only_tidies_up() {
    if !have_git() {
        return;
    }
    let work = Work::new("il");
    let repo = work.repo("app");
    let mut s = scene("il", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:n.txt:n");
    let w = workdir(&s, t);
    let at = plain(&w.path);
    work.git(&repo, &["worktree", "lock", at.to_str().unwrap()]);
    // Kept, and said so; the worktree is not removed against git's word.
    for _ in 0..2 {
        let e = settle(&mut s, t, true).unwrap_err();
        assert!(e.message.contains("The changes are in main"), "{e}");
        assert_eq!(read(repo.join("n.txt")), "n");
        assert_eq!(changes(&s, t), Changes::Pending);
        assert!(Path::new(&w.path).join("n.txt").exists());
    }
    // Discard removes what is left. Nothing was discarded: it is kept.
    settle(&mut s, t, false).unwrap();
    assert_eq!(changes(&s, t), Changes::Kept);
    assert_eq!(read(repo.join("n.txt")), "n");
    assert!(!Path::new(&w.path).exists());
    assert_eq!(work.ours(&repo), "");
}

#[cfg(unix)]
#[test]
fn review2_8_a_process_the_core_cannot_see_holds_a_worktree() {
    if !have_git() {
        return;
    }
    // No process shows where it works: one in a terminal of the core counts
    // as working in the worktree, and no other does.
    let work = Work::new("s8");
    let repo = work.repo("app");
    let data = Folder::new("s8");
    let core = start_blind(&data, &work, &[], "folders");
    let mut s = Scene::in_folder(core, data, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:a.txt:x");
    let wt = PathBuf::from(workdir(&s, t).path);
    let start = StartTerminal {
        project: Some(s.project),
        argv: Vec::new(),
        title: None,
    };
    let id = TerminalId::mint();
    let mut shell = Screen::start(&s.core, id, Some(start));
    shell.line("echo in''side");
    shell.until("inside");
    let e = settle(&mut s, t, false).unwrap_err();
    assert!(e.message.contains("in use"), "{e}");
    assert_eq!(read(wt.join("a.txt")), "x");
    // A Keep keeps, and leaves the worktree where it is.
    let e = settle(&mut s, t, true).unwrap_err();
    assert!(
        e.message.contains("The changes are in main") && e.message.contains("in use"),
        "{e}"
    );
    assert_eq!(read(repo.join("a.txt")), "x");
    assert!(wt.exists());
    assert_eq!(changes(&s, t), Changes::Pending);
    s.w.ok::<call::TerminalStop>(&Ref { id });
    s.w.until("the shell ended", |m| {
        m.terminals[&id].state != tasktap_proto::TerminalState::Running
    });
    eventually("its processes have gone", || {
        settle(&mut s, t, true).is_ok()
    });
    assert_eq!(changes(&s, t), Changes::Kept);
    assert!(!wt.exists());

    // No process can be listed at all: the core removes nothing on its own
    // account, and what the person asks for goes.
    let work = Work::new("s8");
    let repo = work.repo("app");
    let data = Folder::new("s8");
    let core = start_blind(&data, &work, &[], "processes");
    let mut s = Scene::in_folder(core, data, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let idle = capture(&mut s, "print:nothing to change");
    s.w.until("it is done and looked at", |m| {
        let th = &m.thoughts[&idle];
        th.status == Status::Done && th.workdir.is_some()
    });
    let t = pending(&mut s, "write:a.txt:x");
    let wt = PathBuf::from(workdir(&s, t).path);
    settle(&mut s, t, false).unwrap();
    assert!(!wt.exists());
    let left = workdir(&s, idle);
    assert_eq!(left.changes, Changes::Clean);
    assert!(Path::new(&left.path).join("a.txt").exists());
    assert!(work.branch(&repo, &left.branch).is_some());
}

// The third review, of the promise about the person's own (design §7):
// what could reach beyond Tasktap's folder and branches, each closed.

#[test]
fn review3_1_a_runs_branch_made_a_symbolic_ref_never_leads_to_the_branch_it_names() {
    if !have_git() {
        return;
    }
    let work = Work::new("t1");
    let repo = work.repo("app");
    let base = work.git(&repo, &["rev-parse", "HEAD"]);
    work.git(&repo, &["branch", "mine"]);
    let mut s = scene("t1", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let aliased = |w: &Workdir, to: &str| {
        let run = format!("refs/heads/{}", w.branch);
        work.git(&repo, &["symbolic-ref", &run, &format!("refs/heads/{to}")]);
        run
    };
    // The run's branch becomes another name for a branch of the person's:
    // neither Discard nor Keep reads, moves or deletes anything through it.
    let t = pending(&mut s, "write:n.txt:n");
    let w = workdir(&s, t);
    let run = aliased(&w, "mine");
    for keep in [false, true] {
        let e = settle(&mut s, t, keep).unwrap_err();
        assert!(e.message.contains("symbolic ref"), "{e}");
        assert_eq!(work.branch(&repo, "mine"), Some(base.clone()), "{keep}");
        assert_eq!(read(Path::new(&w.path).join("n.txt")), "n");
    }
    // The person removes that name: what is left is discarded.
    work.git(&repo, &["symbolic-ref", "--delete", &run]);
    settle(&mut s, t, false).unwrap();
    assert!(!Path::new(&w.path).exists());
    assert_eq!(work.branch(&repo, "mine"), Some(base.clone()));

    // Nor does the core's own removal of a worktree with nothing in it,
    // stopped here between removing the folder and deleting the branch,
    // where no look stands between the new name and the deletion.
    work.hold("branch");
    let u = capture(&mut s, "print:nothing to change");
    work.held("branch");
    s.w.sync();
    let w = workdir(&s, u);
    let run = aliased(&w, "mine");
    work.release("branch");
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(work.branch(&repo, "mine"), Some(base.clone()));
    assert_eq!(work.git(&repo, &["symbolic-ref", &run]), "refs/heads/mine");

    // And a launch does not make its branch through a symbolic ref that
    // has its name: the branch that names is not made, and the launch fails.
    let attempt = AttemptId::mint();
    let hex = attempt.uuid().simple().to_string();
    let taken = format!("refs/heads/tasktap/{}", &hex[hex.len() - 12..]);
    work.git(&repo, &["symbolic-ref", &taken, "refs/heads/unborn"]);
    let to = Place::Project(s.project);
    s.script(
        Route::Clear {
            to,
            brief: "write:a.txt:x".into(),
        },
        None,
    );
    let v = s.capture("write:a.txt:x");
    s.w.ok::<call::ThoughtStart>(&Start { id: v, attempt });
    s.w.until("it failed", |m| m.thoughts[&v].status == Status::Failed);
    let why = &s.w.model.results_of(v)[0];
    assert!(why.summary.contains("symbolic ref"), "{}", why.summary);
    assert_eq!(work.branch(&repo, "unborn"), None);
    assert_eq!(
        work.git(&repo, &["symbolic-ref", &taken]),
        "refs/heads/unborn"
    );
}

#[test]
fn review3_2_a_git_link_changed_after_keep_checked_it_sends_nothing_into_the_persons_repository() {
    if !have_git() {
        return;
    }
    let work = Work::new("t2");
    let repo = work.repo("app");
    // Something of the person's, staged in the project folder.
    write(&repo.join("s.txt"), "staged\n");
    work.git(&repo, &["add", "s.txt"]);
    let mut s = scene("t2", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:k.txt:kept");
    let w = workdir(&s, t);
    // Keep has checked the worktree and is stopped before it commits there;
    // then the worktree's `.git` names the project's own git folder.
    work.hold("commit");
    let settle_args = Settle {
        id: t,
        attempt: AttemptId::mint(),
        keep: true,
    };
    let call = s.w.send::<call::ThoughtSettle>(&settle_args);
    work.held("commit");
    let link = format!("gitdir: {}\n", plain(repo.join(".git")).display());
    write(&Path::new(&w.path).join(".git"), &link);
    work.release("commit");
    // Git no longer takes the folder for its worktree, so it stays.
    let e = s.w.reply::<call::ThoughtSettle>(call).unwrap_err();
    assert!(e.message.contains("The changes are in main"), "{e}");
    // The commit was made in the worktree's own record, and kept; what the
    // person had staged is staged as it was.
    assert_eq!(
        work.git(&repo, &["diff", "--cached", "--name-only"]),
        "s.txt"
    );
    assert_eq!(read(repo.join("k.txt")), "kept");
    assert_eq!(
        work.git(&repo, &["log", "-1", "--format=%s: %b"]),
        "write:k.txt:kept: Committed by Tasktap when its changes were kept."
    );
}

#[test]
fn review3_3_a_replacement_ref_does_not_make_keep_drop_the_persons_commits() {
    if !have_git() {
        return;
    }
    let work = Work::new("t3");
    let repo = work.repo("app");
    let mut s = scene("t3", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:n.txt:n");
    let w = workdir(&s, t);
    let wt = Path::new(&w.path);
    work.git(wt, &["add", "-A"]);
    work.git(wt, &["commit", "-q", "-m", "the agent's"]);
    let tip = work.branch(&repo, &w.branch).unwrap();
    let moved = work.commit(&repo, "a.txt", "person\n", "the person's");
    // A replacement that shows the run's commit as made after the person's,
    // which it was not.
    work.git(&repo, &["replace", "--graft", &tip, &moved]);
    settle(&mut s, t, true).unwrap();
    // Main as it really is still holds the person's commit, and its file.
    let real = ["--no-replace-objects", "merge-base", "--is-ancestor"];
    let real = work.try_git(&repo, &[&real[..], &[&moved, "main"]].concat());
    assert!(real.status.success(), "main lost the person's commit");
    assert_eq!(read(repo.join("a.txt")), "person\n");
    assert_eq!(read(repo.join("n.txt")), "n");
}

#[test]
fn review3_4_a_strategy_the_person_prefers_does_not_replace_the_fast_forward() {
    if !have_git() {
        return;
    }
    let work = Work::new("t4");
    let config = "[branch \"main\"]\n\tmergeOptions = -s subtree\n[pull]\n\ttwohead = subtree\n";
    std::fs::write(work.core_config(), config).unwrap();
    let repo = work.repo("app");
    let head = work.git(&repo, &["rev-parse", "HEAD"]);
    let mut s = scene("t4", &work, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = pending(&mut s, "write:x.txt:x");
    let wt = PathBuf::from(workdir(&s, t).path);
    write(&wt.join("out.log"), "agent's log\n");
    work.git(&wt, &["add", "-f", "out.log"]);
    work.git(&wt, &["commit", "-q", "-m", "the agent's log"]);
    // An ignored file of the person's where the keep brings a tracked one.
    write(&repo.join("out.log"), "my log\n");
    let e = settle(&mut s, t, true).unwrap_err();
    assert!(e.message.contains("out.log"), "{e}");
    assert_eq!(read(repo.join("out.log")), "my log\n");
    assert_eq!(work.git(&repo, &["rev-parse", "HEAD"]), head);
    // Out of the way, the keep is the fast-forward it was asked to be.
    std::fs::remove_file(repo.join("out.log")).unwrap();
    settle(&mut s, t, true).unwrap();
    assert_eq!(work.git(&repo, &["rev-parse", "HEAD~2"]), head);
    let merges = ["rev-list", "--merges", &format!("{head}..HEAD")];
    assert_eq!(work.git(&repo, &merges), "");
    assert_eq!(read(repo.join("out.log")), "agent's log\n");
}

#[cfg(unix)]
#[test]
fn review3_5_a_worktrees_folder_that_is_a_link_elsewhere_is_never_worked_in() {
    if !have_git() {
        return;
    }
    let work = Work::new("t5");
    let repo = work.repo("app");
    let data = Folder::new("t5");
    // The worktrees' folder leads into a folder of the person's, which
    // holds a file with a name the core would give one of its own.
    let theirs = work.path("theirs");
    write(&theirs.join(".tmp-notes.txt"), "mine");
    std::os::unix::fs::symlink(&theirs, data.0.join("worktrees")).unwrap();
    let mut s = Scene::in_folder(start(&data, &work, &[]), data, &repo, SILENT);
    isolate(&mut s, Isolate::Always);
    let t = capture(&mut s, "write:a.txt:x");
    s.w.until("it failed", |m| m.thoughts[&t].status == Status::Failed);
    let why = &s.w.model.results_of(t)[0];
    assert!(why.summary.contains("is a link"), "{}", why.summary);
    assert_eq!(files_in(&theirs), [".tmp-notes.txt"]);
    assert_eq!(read(theirs.join(".tmp-notes.txt")), "mine");
    assert_eq!(work.ours(&repo), "");
}
