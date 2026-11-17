//! Isolated runs (design §7, "Isolation"): the git work, and nothing else.
//! The state machine decides when a run gets a worktree, what a look at one
//! means and when one may go (`state.rs`); this module makes, reads, keeps
//! and removes worktrees as `effects.rs` asks, on threads of their own.
//!
//! What it promises is the design's, in three tiers. The person's folder
//! and branches are written by nothing but a Keep, and by that only as a
//! fast-forward of the person's own would: every command that writes
//! outside `<data>/worktrees` is listed there, and none of them restores,
//! resets or deletes. Nothing is undone: what git did is reported as it
//! is. A worktree of the core's goes on the person's Discard, after a Keep
//! that brought all of it into its destination, or on the core's own
//! account only by commands of git's that refuse when anything is in it.
//! And git runs as the person's own would, filters and merge drivers
//! included, with hooks off, no prompt, and a deadline on every command,
//! whose output goes to files of the core's so that one that outlives a
//! core that stopped finishes what it began.

use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Condvar, Mutex, PoisonError, mpsc};
use std::time::Duration;

use tasktap_proto::{ChangedFile, Changes, FileChange, MAX_DIFF, ThoughtId, Workdir};

use crate::state::{Found, Worktree};

/// Longest a command that only reads runs.
const LOOK: Duration = Duration::from_secs(60);
/// Longest a command that writes a whole tree runs: making, updating or
/// removing a worktree, or adding all of one, which in a large repository
/// takes long.
const WRITE: Duration = Duration::from_secs(600);
/// Most bytes kept of what a command prints; it is counted beyond that.
const OUTPUT: usize = 16 << 20;
/// Most bytes kept of what a command says went wrong.
const ERRORS: usize = 16 << 10;
/// The prefix of every branch this module makes.
pub const PREFIX: &str = "tasktap/";
/// The folder of the data folder that holds the worktrees.
pub const FOLDER: &str = "worktrees";
/// Hex digits of a worktree's name.
pub const NAME: usize = 12;
/// Who Tasktap commits as where the person configured nobody.
const AUTHOR: &str = "Tasktap";
const EMAIL: &str = "tasktap@localhost";
const NO_COMMITS: &str = "the repository has no commits yet, so the run cannot start from one \
     in a worktree of its own: commit once, or set the project to never isolate";

/// Set on every command: no program that could wait on the person or run
/// for long, the answers in the form this module reads, and untracked
/// files seen wherever git itself decides whether a worktree is clean.
/// Hooks go to a folder that never exists, added in [`Git::command`].
const SETTINGS: [&str; 11] = [
    "core.fsmonitor=false",
    "core.safecrlf=false",
    "color.ui=false",
    "commit.gpgSign=false",
    "gc.auto=0",
    "maintenance.auto=false",
    "submodule.recurse=false",
    "status.showUntrackedFiles=normal",
    "diff.noprefix=false",
    "diff.mnemonicPrefix=false",
    "diff.relative=false",
];

/// Git as the core runs it.
pub struct Git {
    program: PathBuf,
    /// `<data>/worktrees`, canonical.
    root: PathBuf,
    env: Vec<(String, OsString)>,
    /// The sessions of the core's running terminals (`sys::in_use`).
    sessions: Vec<u32>,
}

/// What a command did.
struct Ran {
    code: Option<i32>,
    /// What it printed, up to the bound asked for.
    out: Vec<u8>,
    /// Bytes it printed in all.
    size: u64,
    err: String,
}

/// A worktree's changes: the files, and the diff when one was asked for.
#[derive(Default)]
pub struct Listed {
    pub files: Vec<ChangedFile>,
    pub diff: Vec<u8>,
    pub size: u64,
}

/// A worktree the start sweep looks at, with what records it.
pub struct Owner {
    pub thought: ThoughtId,
    pub repo: PathBuf,
    pub workdir: Workdir,
}

/// A worktree proven to be one this core made ([`Git::own`]), for the job
/// whose turn on it this is.
struct Own {
    path: PathBuf,
    branch: String,
    _turn: Turn,
}

/// A job's turn on a worktree. The jobs of this core on one worktree take
/// turns, a look and a removal too, so that no git command of the core's
/// own is at work in a folder another job asks whether anything works in,
/// or removes. A job ends, since each of its commands does.
struct Turn(PathBuf);

static TURNS: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());
static NEXT: Condvar = Condvar::new();

impl Turn {
    fn take(path: &Path) -> Turn {
        let mut turns = TURNS.lock().unwrap_or_else(PoisonError::into_inner);
        while turns.contains(path) {
            turns = NEXT.wait(turns).unwrap_or_else(PoisonError::into_inner);
        }
        turns.insert(path.to_owned());
        Turn(path.to_owned())
    }
}

impl Drop for Turn {
    fn drop(&mut self) {
        let mut turns = TURNS.lock().unwrap_or_else(PoisonError::into_inner);
        turns.remove(&self.0);
        NEXT.notify_all();
    }
}

/// What a folder holds beside the commit its HEAD is at.
struct Status {
    /// The branch its HEAD is on, as git names a branch for short.
    on: String,
    /// The commit its HEAD is at.
    at: String,
    /// Something staged, changed or untracked.
    changed: bool,
    /// Ignored files beside the tracked ones.
    ignored: bool,
}

/// Whether `name` is one this module makes: [`NAME`] lowercase hex digits.
pub fn named(name: &str) -> bool {
    name.len() == NAME && name.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

impl Git {
    /// Git found on the terminals' PATH, for the data folder `data`.
    /// `sessions` are those of the core's running terminals, a process of
    /// which holds a worktree it may be working in.
    pub fn new(data: &Path, sessions: Vec<u32>) -> Result<Git, String> {
        let program = crate::terminal::find("git")
            .ok_or("git is not installed: no folder of the PATH has it")?;
        let root = data.join(FOLDER);
        let root = std::fs::create_dir_all(&root)
            .and_then(|()| std::fs::canonicalize(&root))
            .map_err(|e| format!("the worktrees' folder cannot be made: {e}"))?;
        Ok(Git {
            program,
            env: environment(&root),
            root,
            sessions,
        })
    }

    /// The worktree a record names, proven to be one this core made: a
    /// folder whose name is one the core gives, exactly one level inside
    /// the canonical `<data>/worktrees`, reached through no link, and the
    /// branch of that name. Anything else is refused before git runs.
    fn own(&self, w: &Workdir) -> Result<Own, String> {
        let path = PathBuf::from(&w.path);
        let bad = || {
            format!(
                "{} is not a worktree Tasktap made, so it is left alone",
                w.path
            )
        };
        let name = path
            .file_name()
            .and_then(OsStr::to_str)
            .filter(|n| named(n));
        let name = name.ok_or_else(bad)?;
        if path != self.root.join(name) || w.branch != format!("{PREFIX}{name}") {
            return Err(bad());
        }
        // The worktrees' folder is canonical: only the worktree could be a link.
        if path.symlink_metadata().is_ok_and(|m| !m.is_dir()) {
            return Err(bad());
        }
        Ok(self.mine(name))
    }

    /// The worktree of the name `name`, one the core gives, once it is this
    /// job's turn on it.
    fn mine(&self, name: &str) -> Own {
        let path = self.root.join(name);
        Own {
            _turn: Turn::take(&path),
            path,
            branch: format!("{PREFIX}{name}"),
        }
    }

    // Making and finding.

    /// Makes the worktree a run works in, or finds it again (design §7): a
    /// new one on a new branch from the project folder's HEAD, or the
    /// thought's own, made again where it is gone.
    pub fn prepare(&self, repo: &Path, worktree: &Worktree) -> Result<Workdir, String> {
        match worktree {
            Worktree::New { name } if named(name) => self.make(repo, &self.mine(name)),
            Worktree::New { name } => Err(format!("{name} is no name Tasktap gives a worktree")),
            Worktree::Again { workdir, .. } => self.again(repo, workdir),
        }
    }

    fn make(&self, repo: &Path, own: &Own) -> Result<Workdir, String> {
        // Made here and now by this attempt alone: another that came to the
        // same name finds it there and stops, touching nothing.
        std::fs::create_dir(&own.path).map_err(|e| {
            format!(
                "{} exists already, or cannot be made: {e}",
                own.path.display()
            )
        })?;
        let mut branched = None;
        let made = self.fill(repo, own, &mut branched);
        if made.is_err() {
            // What this attempt made a moment ago, and only that: nothing
            // has run in it.
            let _ = std::fs::remove_dir_all(&own.path);
            self.forget(repo, own);
            if let Some(base) = branched {
                let at = format!("refs/heads/{}", own.branch);
                let _ = self.run(repo, &["update-ref", "-d", &at, &base], LOOK, &[], 0);
            }
        }
        made
    }

    /// Fills a folder just made with a worktree on a new branch from the
    /// project folder's HEAD; `branched` says when the branch was made.
    fn fill(
        &self,
        repo: &Path,
        own: &Own,
        branched: &mut Option<String>,
    ) -> Result<Workdir, String> {
        // The branch the project folder is on is where Keep brings the
        // changes; on none (a detached HEAD) Keep has nowhere to.
        let head = self.run(repo, &["symbolic-ref", "-q", "HEAD"], LOOK, &[], ERRORS)?;
        let destination = match head.code {
            Some(0) => text(&head.out).strip_prefix("refs/heads/").map(Into::into),
            Some(1) => None,
            _ => return Err(failed("symbolic-ref", &head)),
        };
        let base = self
            .line(repo, &["rev-parse", "-q", "--verify", "HEAD^{commit}"])
            .map_err(|_| NO_COMMITS.to_owned())?;
        // The person's own uncommitted work stays in the project folder; the
        // run starts from what is committed, and its record says so.
        let status = ["status", "--porcelain", "-z", "--untracked-files=normal"];
        let left_out = !self.ok(repo, &status, LOOK)?.is_empty();
        // Made only where no branch of that name is: one of the person's is
        // never taken over, nor removed when this attempt fails.
        let at = format!("refs/heads/{}", own.branch);
        let create = ["update-ref", "-m", "tasktap: new worktree", &at, &base, ""];
        self.ok(repo, &create, LOOK).map_err(|e| {
            format!("a branch {} exists already, and Tasktap does not take over a branch it did not make: {e}", own.branch)
        })?;
        *branched = Some(base.clone());
        let add = os(&["worktree", "add", "--quiet"], &own.path, &[&own.branch]);
        self.ok(repo, &add, WRITE)
            .map_err(|e| format!("the worktree could not be made: {e}"))?;
        Ok(Workdir {
            path: own.path.to_string_lossy().into_owned(),
            branch: own.branch.clone(),
            destination,
            base,
            left_out,
            changes: Changes::Clean,
            files: 0,
            insertions: 0,
            deletions: 0,
        })
    }

    /// The thought's own worktree: as it is, put back on its branch where
    /// its folder is gone, or begun anew at the same place where its branch
    /// is gone too, which leaves nothing of it to lose.
    fn again(&self, repo: &Path, w: &Workdir) -> Result<Workdir, String> {
        let own = self.own(w)?;
        if own.path.symlink_metadata().is_ok() {
            if self.on_branch(&own).is_some() {
                return Ok(w.clone());
            }
            return Err(format!(
                "{} is there but is no longer its worktree; keep or discard its changes first",
                own.path.display()
            ));
        }
        // What git still knows of the folder that is gone.
        self.forget(repo, &own);
        if self.commit_of(repo, &own.branch)?.is_none() {
            return self.make(repo, &own);
        }
        std::fs::create_dir(&own.path).map_err(|e| e.to_string())?;
        let add = os(&["worktree", "add", "--quiet"], &own.path, &[&own.branch]);
        if let Err(e) = self.ok(repo, &add, WRITE) {
            let _ = std::fs::remove_dir_all(&own.path);
            self.forget(repo, &own);
            return Err(format!("the worktree could not be made again: {e}"));
        }
        Ok(w.clone())
    }

    // Looking.

    /// What a worktree holds against the commit it started from: its files
    /// and lines; whether removing it would lose nothing; and whether the
    /// folder and the branch are both gone.
    pub fn survey(&self, repo: &Path, w: &Workdir) -> Result<Found, String> {
        self.look(repo, w, &self.own(w)?)
    }

    fn look(&self, repo: &Path, w: &Workdir, own: &Own) -> Result<Found, String> {
        let here = own.path.symlink_metadata().is_ok();
        if !repo.is_dir() {
            return Err(format!(
                "the project folder {} is not there",
                repo.display()
            ));
        }
        let tip = self.commit_of(repo, &own.branch)?;
        if !here && tip.is_none() {
            return Ok(Found {
                gone: true,
                ..Found::default()
            });
        }
        let status = self.on_branch(own);
        let listed = self.listed(repo, w, own, status.is_some(), None)?;
        let bare = !here || status.is_some_and(|s| !s.changed && !s.ignored);
        let lines = |f: fn(&ChangedFile) -> Option<u32>| listed.files.iter().filter_map(f).sum();
        Ok(Found {
            files: listed.files.len() as u32,
            insertions: lines(|f| f.insertions),
            deletions: lines(|f| f.deletions),
            gone: false,
            spare: bare && tip.as_deref() == Some(w.base.as_str()),
        })
    }

    /// What a worktree's folder holds, when it is there and still the
    /// worktree git knows, on its branch: its `.git` names git's record of
    /// it, which names it back, so a command run in it reads and writes
    /// that record's index and HEAD and no other.
    fn on_branch(&self, own: &Own) -> Option<Status> {
        // Relative paths are git's too, from the folder of the file.
        let record = record(&own.path)?;
        let back = std::fs::read_to_string(record.join("gitdir")).ok()?;
        let back = std::fs::canonicalize(folder(&record).join(back.trim())).ok()?;
        if back != std::fs::canonicalize(own.path.join(".git")).ok()? {
            return None;
        }
        let status = self.status(&own.path).ok()?;
        (status.on == own.branch).then_some(status)
    }

    /// What a folder holds beside its HEAD, and where that is: one command,
    /// which the removal of a worktree nothing asked for reads again.
    fn status(&self, dir: &Path) -> Result<Status, String> {
        let args = [
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=normal",
            "--ignored",
            "--no-renames",
            "--ignore-submodules=none",
        ];
        let out = self.ok(dir, &args, LOOK)?;
        let mut status = Status {
            on: String::new(),
            at: String::new(),
            changed: false,
            ignored: false,
        };
        for entry in out.split(|&b| b == 0).filter(|e| !e.is_empty()) {
            let entry = String::from_utf8_lossy(entry);
            if let Some(on) = entry.strip_prefix("# branch.head ") {
                status.on = on.to_owned();
            } else if let Some(at) = entry.strip_prefix("# branch.oid ") {
                status.at = at.to_owned();
            } else if entry.starts_with("! ") {
                status.ignored = true;
            } else if !entry.starts_with("# ") {
                status.changed = true;
            }
        }
        Ok(status)
    }

    /// The worktree's changes against its base: the files, and with `diff`
    /// the patch, of everything or of the one path named. Untracked files
    /// count: they are read through an index of this look's own, so the
    /// worktree's index, which its agent may be using, stays as it is.
    /// With the folder gone or no longer tied to it, what its branch holds.
    pub fn list(
        &self,
        repo: &Path,
        w: &Workdir,
        diff: Option<Option<&str>>,
    ) -> Result<Listed, String> {
        let own = self.own(w)?;
        let tied = self.on_branch(&own).is_some();
        self.listed(repo, w, &own, tied, diff)
    }

    /// [`Git::list`], for a worktree known to be tied to its folder or not.
    fn listed(
        &self,
        repo: &Path,
        w: &Workdir,
        own: &Own,
        tied: bool,
        diff: Option<Option<&str>>,
    ) -> Result<Listed, String> {
        if tied {
            let revs = ["--cached", w.base.as_str()];
            return self.with_index(&own.path, |index| self.diffs(&own.path, &revs, diff, index));
        }
        if !repo.is_dir() || self.commit_of(repo, &own.branch)?.is_none() {
            return Ok(Listed::default());
        }
        let tip = format!("refs/heads/{}", own.branch);
        self.diffs(repo, &[w.base.as_str(), tip.as_str()], diff, None)
    }

    fn diffs(
        &self,
        dir: &Path,
        revs: &[&str],
        diff: Option<Option<&str>>,
        index: Option<&Path>,
    ) -> Result<Listed, String> {
        let env: Vec<_> = (index.map(|i| ("GIT_INDEX_FILE", i.as_os_str())))
            .into_iter()
            .collect();
        let args = |more: &[&'static str]| {
            let mut args = vec!["diff", "--no-renames", "--no-ext-diff", "--no-textconv"];
            args.extend(more);
            args.extend(revs);
            args
        };
        let ran = self.run(
            dir,
            &args(&["--raw", "--numstat", "-z"]),
            LOOK,
            &env,
            OUTPUT,
        )?;
        if ran.code != Some(0) {
            return Err(failed("diff", &ran));
        }
        let mut listed = Listed {
            files: files(&ran.out),
            ..Listed::default()
        };
        if let Some(only) = diff {
            let mut patch = args(&["--no-color"]);
            if let Some(only) = only {
                patch.extend(["--", only]);
            }
            let ran = self.run(dir, &patch, LOOK, &env, MAX_DIFF)?;
            if ran.code != Some(0) {
                return Err(failed("diff", &ran));
            }
            (listed.diff, listed.size) = (ran.out, ran.size);
        }
        Ok(listed)
    }

    /// Runs `f` with an index of its own holding all of the worktree at
    /// `path`, untracked files too, and removes it afterwards. It starts as
    /// a copy of the worktree's, so only what changed is read again.
    fn with_index<T>(
        &self,
        path: &Path,
        f: impl FnOnce(Option<&Path>) -> Result<T, String>,
    ) -> Result<T, String> {
        let index = folder(&self.temporary("index"));
        // Without the copy, adding reads every file instead of what changed.
        if let Some(record) = record(path) {
            let _ = std::fs::copy(record.join("index"), &index);
        }
        let env = [("GIT_INDEX_FILE", index.as_os_str())];
        let added = self.run(path, &["add", "--all"], WRITE, &env, ERRORS);
        let result = match added {
            Ok(ran) if ran.code == Some(0) => f(Some(&index)),
            Ok(ran) => Err(failed("add", &ran)),
            Err(e) => Err(e),
        };
        let _ = std::fs::remove_file(&index);
        result
    }

    // Keeping and discarding.

    /// Keep (design §7): commits what is uncommitted in the worktree on its
    /// branch, brings the branch into its destination, then removes the
    /// worktree and the branch. The destination moves by a fast-forward
    /// when it has not moved since, and otherwise by a merge commit made
    /// without a working tree, only when it merges cleanly; nothing is
    /// rebased or forced. A refusal of git's leaves everything as it was.
    /// Nothing is ever undone: where git did something else than was asked,
    /// because the folder changed at that moment, the reply says what is
    /// where, and the next Keep or Discard goes on from there.
    pub fn keep(&self, repo: &Path, w: &Workdir, title: &str) -> Result<(), String> {
        let own = self.own(w)?;
        if !repo.is_dir() {
            return Err(format!(
                "the project folder {} is not there, so nothing can be kept into it",
                repo.display()
            ));
        }
        let by_hand = format!(
            "Branch {} holds this thought's changes: merge it yourself and press Keep again, which then only tidies up, or Discard",
            own.branch
        );
        let Some(to) = &w.destination else {
            return Err(format!(
                "the project folder was on no branch (a detached HEAD) when this run started, so there is no branch to keep it into. {by_hand}"
            ));
        };
        pause("commit");
        if own.path.symlink_metadata().is_ok() {
            let Some(status) = self.on_branch(&own) else {
                return Err(format!(
                    "{} is no longer the worktree of {}: its link to git is gone or changed. Discard it, or take what is in it yourself",
                    own.path.display(),
                    own.branch
                ));
            };
            if status.changed {
                self.commit_all(&own, title)?;
            }
        }
        let Some(tip) = self.commit_of(repo, &own.branch)? else {
            return Err(format!(
                "the branch {} is gone, so nothing is left to keep",
                own.branch
            ));
        };
        let destination = format!("refs/heads/{to}");
        let Some(head) = self.commit_of(repo, to)? else {
            return Err(format!("the branch {to} is gone. {by_hand}"));
        };
        let target = if self.contains(repo, &destination, &tip)? {
            head.clone()
        } else if self.contains(repo, &tip, &head)? {
            tip.clone()
        } else {
            let merged = format!("Merge branch '{}' into {to}\n\n{title}\n", own.branch);
            self.merged(repo, &head, &tip, &merged).map_err(|why| {
                format!("{to} has moved since this run started, and {why}. {by_hand}")
            })?
        };
        if target != head {
            self.advance(repo, to, &head, &target, &by_hand)?;
        }
        // Kept. The worktree goes only as git lets it: with something new
        // in it, or a process working there, it stays and is said to.
        let removed = self.free(&own, true);
        let removed = removed.and_then(|()| self.remove(repo, &own, false, &tip));
        removed.map_err(|why| {
            format!(
                "The changes are in {to}. The worktree stays, since {why}: Keep again tidies up once that is over, and Discard removes what is left"
            )
        })
    }

    /// Commits everything uncommitted in the worktree on its branch, once
    /// it is clear the worktree is in the middle of nothing.
    fn commit_all(&self, own: &Own, title: &str) -> Result<(), String> {
        let dir = PathBuf::from(self.line(&own.path, &["rev-parse", "--absolute-git-dir"])?);
        if let Some(what) = midway(&dir) {
            return Err(format!(
                "the worktree is in the middle of {what}; finish or abort it in {} first",
                own.path.display()
            ));
        }
        self.ok(&own.path, &["add", "--all"], WRITE)?;
        let message = format!("{title}\n\nCommitted by Tasktap when its changes were kept.\n");
        let identity = self.identity(&own.path);
        let commit = ["commit", "--quiet", "--no-verify", "-m", &message];
        let ran = self.run(&own.path, &commit, WRITE, &identity, ERRORS)?;
        match ran.code {
            Some(0) => Ok(()),
            _ => Err(format!(
                "the worktree's changes could not be committed: {}",
                failed("commit", &ran)
            )),
        }
    }

    /// A merge commit of `head` and `tip`, made without a working tree, or
    /// the files that conflict.
    fn merged(&self, repo: &Path, head: &str, tip: &str, message: &str) -> Result<String, String> {
        let check = [
            "merge-tree",
            "--write-tree",
            "--no-messages",
            "--name-only",
            "-z",
            head,
            tip,
        ];
        let ran = self.run(repo, &check, WRITE, &[], OUTPUT)?;
        let mut parts = ran.out.split(|&b| b == 0);
        let tree = text(parts.next().unwrap_or_default());
        match ran.code {
            Some(0) => {}
            Some(1) => {
                let files: Vec<_> = (parts.take_while(|p| !p.is_empty()))
                    .map(|p| String::from_utf8_lossy(p).into_owned())
                    .collect();
                return Err(format!(
                    "its changes conflict with this thought's in {}",
                    shown(&files)
                ));
            }
            _ => {
                return Err(format!(
                    "this git cannot check a merge without a working tree (it needs 2.38 or newer): {}",
                    failed("merge-tree", &ran)
                ));
            }
        }
        let identity = self.identity(repo);
        let commit = [
            "commit-tree",
            tree.as_str(),
            "-p",
            head,
            "-p",
            tip,
            "-m",
            message,
        ];
        let ran = self.run(repo, &commit, LOOK, &identity, ERRORS)?;
        match ran.code {
            Some(0) => Ok(text(&ran.out)),
            _ => Err(format!(
                "the merge could not be made: {}",
                failed("commit-tree", &ran)
            )),
        }
    }

    /// Moves the branch `to` from `head` to `target`, which descends from
    /// it. Checked out nowhere, only the branch moves, and only from where
    /// it was. Checked out in a folder, that folder follows by git's own
    /// fast-forward, which refuses whole when it would touch an uncommitted
    /// change or an untracked or ignored file; every option that decides
    /// what it does is on the command. Afterwards `to` holds `target`, or
    /// the reply says what happened instead.
    fn advance(
        &self,
        repo: &Path,
        to: &str,
        head: &str,
        target: &str,
        by_hand: &str,
    ) -> Result<(), String> {
        let branch = format!("refs/heads/{to}");
        let folder = match &self.holding(repo, &branch)?[..] {
            [] => None,
            [folder] => Some(folder.clone()),
            _ => return Err(format!("{to} is checked out in more than one folder")),
        };
        pause("keep");
        let Some(folder) = folder else {
            let note = format!("tasktap: keep into {to}");
            let update = ["update-ref", "-m", &note, &branch, target, head];
            self.ok(repo, &update, LOOK).map_err(|e| {
                format!("{to} moved at that moment and was left alone ({e}). Press Keep again")
            })?;
            // A folder that took the branch at that moment holds the files
            // from before.
            for folder in self.holding(repo, &branch)? {
                let index = ["diff-index", "--cached", "--quiet", head, "--"];
                if self.run(&folder, &index, LOOK, &[], 0)?.code == Some(0) {
                    return Err(format!(
                        "The changes are in {to}, but {} checked {to} out at that moment and still holds the files from before: `git read-tree -m -u {head} {target}` there brings them in and touches nothing you changed. Keep again tidies up",
                        folder.display()
                    ));
                }
            }
            return Ok(());
        };
        let merge = [
            "merge",
            "--ff-only",
            "--no-squash",
            "--commit",
            "--no-edit",
            "--no-overwrite-ignore",
            "--no-autostash",
            "--no-verify",
            "--no-stat",
            "--no-log",
            "--no-signoff",
            "--no-gpg-sign",
            "--no-verify-signatures",
            "--no-rerere-autoupdate",
            "--quiet",
            target,
        ];
        let ran = self.run(&folder, &merge, WRITE, &[], ERRORS)?;
        if ran.code != Some(0) {
            let said: Vec<_> = (ran.err.lines().map(str::trim))
                .filter(|l| !l.is_empty())
                .take(12)
                .collect();
            return Err(format!(
                "git did not bring the changes into {} and left it as it was: {}. {by_hand}",
                folder.display(),
                said.join(" ")
            ));
        }
        if self.contains(repo, &branch, target)? {
            return Ok(());
        }
        // The folder went to another branch at that moment. Nothing is undone.
        let on = self.line(&folder, &["rev-parse", "--abbrev-ref", "HEAD"]);
        let on = on.unwrap_or_else(|_| "another branch".into());
        Err(format!(
            "{} was no longer on {to} when git merged there: it merged into {on}, which the folder had switched to, and {to} is as it was. Nothing was undone: `git reset --keep ORIG_HEAD` there takes the changes out of {on} again, if it gained them. {by_hand}",
            folder.display()
        ))
    }

    /// Discard (design §7): removes the worktree, its uncommitted changes
    /// and its branch, commits that are nowhere else too. The project
    /// folder's files are never touched. Returns whether all of it was in
    /// its destination already, which is then a Keep that only tidied up.
    pub fn discard(&self, repo: &Path, w: &Workdir) -> Result<bool, String> {
        let own = self.own(w)?;
        let tip = match repo.is_dir() {
            true => self.commit_of(repo, &own.branch)?,
            false => None,
        };
        let kept = match (&tip, &w.destination) {
            (Some(tip), Some(to)) if *tip != w.base => {
                let here = own.path.symlink_metadata().is_ok();
                let whole = !here || self.on_branch(&own).is_some_and(|s| !s.changed);
                let to = format!("refs/heads/{to}");
                // A destination that is gone holds nothing.
                whole && self.contains(repo, &to, tip).unwrap_or(false)
            }
            _ => false,
        };
        self.free(&own, true)?;
        self.remove(repo, &own, true, tip.as_deref().unwrap_or(&w.base))?;
        Ok(kept)
    }

    /// Removes a worktree and its branch on the core's own account, when
    /// git itself agrees nothing is in it. Otherwise returns what is there
    /// and removes nothing more.
    pub fn tidy(&self, repo: &Path, w: &Workdir) -> Result<Option<Found>, String> {
        let own = self.own(w)?;
        pause("tidy");
        // In use: it stays as it is, for a later look.
        self.free(&own, false)?;
        if self.spare(repo, &own, &w.base).is_ok() {
            return Ok(None);
        }
        // Something is in it, or git will not remove it: the person's to
        // keep or discard.
        let found = self.look(repo, w, &own)?;
        Ok(Some(Found {
            spare: false,
            ..found
        }))
    }

    // Parts.

    /// Refuses while a process works in the worktree or below it. Where the
    /// system does not say, a removal the person asked for goes on, and one
    /// they did not ask for does not.
    fn free(&self, own: &Own, asked: bool) -> Result<(), String> {
        if own.path.symlink_metadata().is_err() {
            return Ok(());
        }
        match crate::sys::in_use(&own.path, &self.sessions) {
            Some(false) => Ok(()),
            None if asked => Ok(()),
            _ => Err(format!(
                "{} is in use by a process working there",
                own.path.display()
            )),
        }
    }

    /// Removes a worktree nothing asked to be removed, and its branch from
    /// `at`: only one still on its branch at that commit with nothing
    /// staged, changed, untracked or ignored in it, and then only by the
    /// commands of [`Git::remove`], which refuse what came since.
    fn spare(&self, repo: &Path, own: &Own, at: &str) -> Result<(), String> {
        if own.path.symlink_metadata().is_ok() {
            let bare = |s: Status| s.at == at && !s.changed && !s.ignored;
            if !self.on_branch(own).is_some_and(bare) {
                return Err(format!("{} holds something", own.path.display()));
            }
        }
        self.remove(repo, own, false, at)
    }

    /// Removes a worktree of this core's, then its branch where that is
    /// still at `at`: a commit made since stays on it (`git update-ref -d`
    /// with the old value). With `force`, on the person's Discard, the
    /// folder goes whatever is in it. Otherwise git removes it (`git
    /// worktree remove`), which refuses a folder that is not its worktree
    /// any more or that holds a change or an untracked file.
    fn remove(&self, repo: &Path, own: &Own, force: bool, at: &str) -> Result<(), String> {
        pause("remove");
        if own.path.symlink_metadata().is_ok() {
            if force {
                patiently(|| std::fs::remove_dir_all(&own.path))
                    .map_err(|e| format!("{} could not be removed: {e}", own.path.display()))?;
            } else {
                let remove = os(&["worktree", "remove"], &own.path, &[]);
                self.ok(repo, &remove, WRITE)?;
            }
        }
        pause("branch");
        self.forget(repo, own);
        if repo.is_dir() && self.commit_of(repo, &own.branch)?.is_some() {
            let branch = format!("refs/heads/{}", own.branch);
            self.ok(repo, &["update-ref", "-d", &branch, at], LOOK)
                .map_err(|e| format!("the branch {} was left: {e}", own.branch))?;
        }
        pause("done");
        Ok(())
    }

    /// Drops git's record of a worktree whose folder is gone, a locked one too.
    fn forget(&self, repo: &Path, own: &Own) {
        if repo.is_dir() && own.path.symlink_metadata().is_err() {
            let forget = os(&["worktree", "remove", "-f", "-f"], &own.path, &[]);
            let _ = self.run(repo, &forget, LOOK, &[], 0);
        }
    }

    /// The commit a branch points at, if it exists.
    fn commit_of(&self, dir: &Path, branch: &str) -> Result<Option<String>, String> {
        let name = format!("refs/heads/{branch}^{{commit}}");
        let ran = self.run(
            dir,
            &["rev-parse", "-q", "--verify", &name],
            LOOK,
            &[],
            ERRORS,
        )?;
        match ran.code {
            Some(0) => Ok(Some(text(&ran.out))),
            Some(1) => Ok(None),
            _ => Err(failed("rev-parse", &ran)),
        }
    }

    /// Whether `commit` is in the history of `of` (both names git takes).
    fn contains(&self, dir: &Path, of: &str, commit: &str) -> Result<bool, String> {
        let check = ["merge-base", "--is-ancestor", commit, of];
        let ran = self.run(dir, &check, LOOK, &[], ERRORS)?;
        match ran.code {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            _ => Err(failed("merge-base", &ran)),
        }
    }

    /// The folders of the repository that have `branch` checked out.
    fn holding(&self, repo: &Path, branch: &str) -> Result<Vec<PathBuf>, String> {
        let out = self.ok(repo, &["worktree", "list", "--porcelain", "-z"], LOOK)?;
        let (mut all, mut path) = (Vec::new(), None);
        for field in out.split(|&b| b == 0) {
            if let Some(folder) = field.strip_prefix(b"worktree ") {
                path = Some(bytes_path(folder));
            } else if field.strip_prefix(b"branch ") == Some(branch.as_bytes()) {
                all.extend(path.take());
            }
        }
        Ok(all)
    }

    /// The identity a commit of Tasktap's is made with: none to add when
    /// the person configured one, Tasktap's otherwise.
    fn identity(&self, dir: &Path) -> Vec<(&'static str, &'static OsStr)> {
        let ask = [
            "-c",
            "user.useConfigOnly=true",
            "var",
            "GIT_COMMITTER_IDENT",
        ];
        if self
            .run(dir, &ask, LOOK, &[], ERRORS)
            .is_ok_and(|r| r.code == Some(0))
        {
            return Vec::new();
        }
        let (name, email) = (OsStr::new(AUTHOR), OsStr::new(EMAIL));
        vec![
            ("GIT_AUTHOR_NAME", name),
            ("GIT_AUTHOR_EMAIL", email),
            ("GIT_COMMITTER_NAME", name),
            ("GIT_COMMITTER_EMAIL", email),
        ]
    }

    /// What a command printed, when it succeeded.
    fn ok(
        &self,
        dir: &Path,
        args: &[impl AsRef<OsStr>],
        limit: Duration,
    ) -> Result<Vec<u8>, String> {
        let ran = self.run(dir, args, limit, &[], OUTPUT)?;
        match ran.code {
            Some(0) => Ok(ran.out),
            _ => Err(failed(&verb(args), &ran)),
        }
    }

    /// The one line a command printed, when it succeeded.
    fn line(&self, dir: &Path, args: &[&str]) -> Result<String, String> {
        self.ok(dir, args, LOOK).map(|out| text(&out))
    }

    /// A file of this core's for a moment: a look's index, a command's output.
    fn temporary(&self, kind: &str) -> PathBuf {
        let tag: String = (tasktap_proto::Secret::mint().0[..6].iter())
            .map(|b| format!("{b:02x}"))
            .collect();
        self.root.join(format!(".tmp-{tag}.{kind}"))
    }

    fn command(&self, dir: &Path) -> Command {
        let mut command = Command::new(&self.program);
        command.arg("-C").arg(folder(dir));
        let mut hooks = OsString::from("core.hooksPath=");
        hooks.push(folder(&self.root.join(".no-hooks")));
        command.arg("-c").arg(hooks);
        for setting in SETTINGS {
            command.arg("-c").arg(setting);
        }
        command
            .env_clear()
            .envs(self.env.iter().map(|(k, v)| (k, v)));
        command
    }

    /// Runs git in `dir` within `limit`, which ends it when it is up, and
    /// keeps the first `keep` bytes of what it printed. Its output goes to
    /// files, so a command that outlives a core that stopped is never
    /// ended by writing to nobody.
    fn run(
        &self,
        dir: &Path,
        args: &[impl AsRef<OsStr>],
        limit: Duration,
        env: &[(&str, &OsStr)],
        keep: usize,
    ) -> Result<Ran, String> {
        let (out, err) = (self.temporary("out"), self.temporary("err"));
        let ran = self.spawn(dir, args, limit, env, &out, &err);
        let ran = ran.map(|code| Ran {
            code,
            out: kept(&out, keep),
            size: std::fs::metadata(&out).map_or(0, |m| m.len()),
            err: String::from_utf8_lossy(&kept(&err, ERRORS)).into_owned(),
        });
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&err);
        ran
    }

    fn spawn(
        &self,
        dir: &Path,
        args: &[impl AsRef<OsStr>],
        limit: Duration,
        env: &[(&str, &OsStr)],
        out: &Path,
        err: &Path,
    ) -> Result<Option<i32>, String> {
        let file = |path: &Path| File::create(path).map_err(|e| e.to_string());
        let mut child = self
            .command(dir)
            .args(args)
            .envs(env.iter().copied())
            .stdin(Stdio::null())
            .stdout(file(out)?)
            .stderr(file(err)?)
            .spawn()
            .map_err(|e| format!("git could not run: {e}"))?;
        let pid = child.id();
        let (done, ended) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(child.wait());
        });
        match ended.recv_timeout(limit) {
            Ok(status) => Ok(status.map_err(|e| e.to_string())?.code()),
            Err(_) => {
                #[cfg(unix)]
                crate::sys::signal_process(pid, true);
                #[cfg(windows)]
                crate::sys::end_process(pid);
                let _ = ended.recv();
                Err(format!(
                    "git {} did not finish within {} s",
                    verb(args),
                    limit.as_secs()
                ))
            }
        }
    }
}

/// At start (design §3), off the core's thread: looks at the worktree of
/// every thought not settled and returns what it found, which decides a
/// settle the core stopped during and what is tidied; removes a worktree
/// no thought records that a launch recorded in `launched` made and
/// stopped before recording, when git agrees nothing is in it; and removes
/// the files of looks and commands that stopped. `there` is what the
/// worktrees' folder held before any job of this run began. No folder is
/// removed for its name.
pub fn sweep(
    data: &Path,
    owners: &[Owner],
    there: &[PathBuf],
    launched: &BTreeSet<String>,
) -> Vec<(ThoughtId, String, Found)> {
    let Ok(git) = Git::new(data, Vec::new()) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    let mut known = BTreeSet::new();
    for o in owners {
        let path = PathBuf::from(&o.workdir.path);
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
        known.extend(name);
        // A folder that is gone and holds nothing pending needs nothing.
        if o.workdir.changes != Changes::Pending && path.symlink_metadata().is_err() {
            continue;
        }
        if let Ok(f) = git.survey(&o.repo, &o.workdir) {
            found.push((o.thought, o.workdir.path.clone(), f));
        }
    }
    for path in there {
        let Some(name) = path.file_name().and_then(OsStr::to_str) else {
            continue;
        };
        if name.starts_with(".tmp-") {
            let _ = std::fs::remove_file(path);
        } else if let Some(name) = name.strip_suffix(crate::sys::PROBE) {
            // What looking whether a worktree is in use moved aside on
            // Windows, when the core stopped at that moment, goes back.
            let back = git.root.join(name);
            if named(name) && back.symlink_metadata().is_err() {
                let _ = std::fs::rename(path, back);
            }
        } else if named(name) && !known.contains(name) && launched.contains(name) {
            git.stray(name);
        }
    }
    found
}

impl Git {
    /// A worktree no thought records, which a launch of this core made and
    /// stopped before recording, so no run began in it: removed as a tidy
    /// removes one, its branch from the commit it is at only when the
    /// project folder's HEAD holds that commit too.
    fn stray(&self, name: &str) {
        let own = self.mine(name);
        let common = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
        let Ok(common) = self.line(&own.path, &common).map(PathBuf::from) else {
            return;
        };
        if let Ok(Some(tip)) = self.commit_of(&common, &own.branch)
            && self.contains(&common, "HEAD", &tip).unwrap_or(false)
            && self.free(&own, false).is_ok()
        {
            let _ = self.spare(&common, &own, &tip);
        }
    }
}

/// The core's checks' environment, never asking anyone anything, never
/// taking a lock a look does not need, never fetching what a partial clone
/// left out, never looking for a repository above the worktrees' folder,
/// and with how a person keeps git from their configuration where they did.
fn environment(root: &Path) -> Vec<(String, OsString)> {
    let mut env = crate::terminal::environment_of_checks();
    for (key, value) in [
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GIT_OPTIONAL_LOCKS", "0"),
        ("GIT_LITERAL_PATHSPECS", "1"),
        ("GIT_NO_LAZY_FETCH", "1"),
    ] {
        env.push((key.into(), value.into()));
    }
    env.push(("GIT_CEILING_DIRECTORIES".into(), folder(root).into()));
    for key in ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] {
        if let Some(value) = std::env::var_os(key) {
            env.push((key.into(), value));
        }
    }
    env
}

/// Git's record of the worktree at `path`: the folder its `.git` file names.
fn record(path: &Path) -> Option<PathBuf> {
    let link = std::fs::read_to_string(path.join(".git")).ok()?;
    let dir = link.strip_prefix("gitdir:")?.trim();
    std::fs::canonicalize(folder(path).join(dir)).ok()
}

/// What a git folder is in the middle of, if anything.
fn midway(git_dir: &Path) -> Option<&'static str> {
    let marks = [
        ("MERGE_HEAD", "a merge"),
        ("rebase-merge", "a rebase"),
        ("rebase-apply", "a rebase"),
        ("CHERRY_PICK_HEAD", "a cherry-pick"),
        ("REVERT_HEAD", "a revert"),
        ("BISECT_LOG", "a bisect"),
    ];
    let found = marks
        .into_iter()
        .find(|(mark, _)| git_dir.join(mark).exists());
    found.map(|(_, what)| what)
}

/// In a build with the test fixtures, waits where a test asked it to:
/// `TASKTAP_FIXTURE_PAUSE` names a folder; with `<step>.wait` there, it
/// writes `<step>.ready` and goes on once `<step>.go` is there, or after 30 s.
#[cfg(feature = "fixtures")]
fn pause(step: &str) {
    let Some(dir) = std::env::var_os("TASKTAP_FIXTURE_PAUSE").map(PathBuf::from) else {
        return;
    };
    if !dir.join(format!("{step}.wait")).exists() {
        return;
    }
    let _ = std::fs::write(dir.join(format!("{step}.ready")), "");
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !dir.join(format!("{step}.go")).exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(not(feature = "fixtures"))]
fn pause(_: &str) {}

/// A change to a folder, tried again for a few seconds on Windows, where
/// what only looks at a file for a moment, such as a virus scanner, refuses
/// it meanwhile.
fn patiently(mut change: impl FnMut() -> std::io::Result<()>) -> std::io::Result<()> {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match change() {
            Err(_) if cfg!(windows) && std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(100));
            }
            done => return done,
        }
    }
}

/// The first `keep` bytes of a file.
fn kept(path: &Path, keep: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    if let Ok(file) = File::open(path) {
        let _ = file.take(keep as u64).read_to_end(&mut bytes);
    }
    bytes
}

/// The files `git diff --raw --numstat -z` lists, by path.
fn files(out: &[u8]) -> Vec<ChangedFile> {
    let mut files = std::collections::BTreeMap::<String, ChangedFile>::new();
    let mut parts = out.split(|&b| b == 0).filter(|p| !p.is_empty());
    while let Some(part) = parts.next() {
        if part.starts_with(b":") {
            let Some(path) = parts.next() else { break };
            let change = match part.last() {
                Some(b'A') => FileChange::Added,
                Some(b'D') => FileChange::Deleted,
                Some(b'T') => FileChange::Type,
                _ => FileChange::Modified,
            };
            let path = String::from_utf8_lossy(path).into_owned();
            let file = ChangedFile {
                path: path.clone(),
                change,
                insertions: None,
                deletions: None,
            };
            files.insert(path, file);
        } else {
            let mut fields = part.splitn(3, |&b| b == b'\t');
            let (Some(add), Some(del), Some(path)) = (fields.next(), fields.next(), fields.next())
            else {
                continue;
            };
            let count = |n: &[u8]| std::str::from_utf8(n).ok()?.parse().ok();
            if let Some(f) = files.get_mut(String::from_utf8_lossy(path).as_ref()) {
                (f.insertions, f.deletions) = (count(add), count(del));
            }
        }
    }
    files.into_values().collect()
}

/// Some files, by name, for a message.
fn shown(files: &[String]) -> String {
    let mut shown = files.iter().take(5).cloned().collect::<Vec<_>>().join(", ");
    if files.len() > 5 {
        shown += &format!(" and {} more", files.len() - 5);
    }
    shown
}

fn text(out: &[u8]) -> String {
    String::from_utf8_lossy(out).trim_end().to_owned()
}

/// The subcommand of a command line, for a message.
fn verb(args: &[impl AsRef<OsStr>]) -> String {
    let words = args.iter().map(|a| a.as_ref().to_string_lossy());
    let mut words = words.skip_while(|w| w == "-c" || w.contains('='));
    words.next().map(|w| w.into_owned()).unwrap_or_default()
}

fn failed(what: &str, ran: &Ran) -> String {
    let why = ran.err.lines().map(str::trim).find(|l| !l.is_empty());
    match (why, ran.code) {
        (Some(why), _) => format!("git {what}: {why}"),
        (None, Some(code)) => format!("git {what} ended with {code}"),
        (None, None) => format!("git {what} was ended"),
    }
}

/// Arguments, then a path, then more arguments.
fn os(args: &[&str], path: &Path, more: &[&str]) -> Vec<OsString> {
    let mut all: Vec<OsString> = args.iter().map(OsString::from).collect();
    all.push(folder(path).into_os_string());
    all.extend(more.iter().map(OsString::from));
    all
}

/// A path as git printed it.
fn bytes_path(bytes: &[u8]) -> PathBuf {
    #[cfg(unix)]
    return PathBuf::from(<OsStr as std::os::unix::ffi::OsStrExt>::from_bytes(bytes));
    #[cfg(not(unix))]
    return PathBuf::from(String::from_utf8_lossy(bytes).into_owned());
}

/// A path as git takes it: on Windows without the `\\?\` of a canonical one.
fn folder(path: &Path) -> PathBuf {
    crate::terminal::folder(path.to_owned())
}
