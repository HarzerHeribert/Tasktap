//! Isolated runs (design §7, "Isolation"): the git work, and nothing else.
//! The state machine decides when a run gets a worktree, what a look at one
//! means and when one may go (`state.rs`); this module makes, reads, keeps
//! and removes worktrees as `effects.rs` asks, on threads of their own.
//!
//! Git runs as a command, never as a library, each command with a deadline
//! of its own, no prompt for credentials, and its output in files of the
//! core's, so a command whose core stopped can finish what it began. No
//! program the person or the repository configured runs in these commands:
//! hooks, filters, merge drivers, signing, the file system monitor, the
//! pager, external diff and text conversion are all turned off, as are
//! color, automatic upkeep, stashing around a merge, recursing into
//! submodules and fetching large files. A filter does nothing and a merge
//! driver fails, which makes its file a conflict. Everything else of the
//! person's configuration applies, such as line endings and excludes; what
//! would change what Keep does is set on its command. What Tasktap commits
//! carries the identity the person configured, or Tasktap's where there is
//! none.
//!
//! Only what this core made is ever removed, and only once proven: a
//! folder whose name is one the core makes, exactly one level inside the
//! canonical `<data>/worktrees`, reached through no link, and a branch
//! named `tasktap/` and that name, deleted only from the commit it was seen
//! at. A folder is removed only when no process works in it. Removed on its
//! own, without the person asking, only when nothing would be lost: its
//! git link still names it, its index and files are those of its branch
//! with nothing untracked or ignored beside them, and the branch holds
//! nothing that is not elsewhere.
//!
//! Every job that changes a worktree holds it for as long as it runs, and
//! every git command of the job holds it too, as its standard input: a
//! command that outlives a core that stopped keeps the worktree held, and
//! nothing touches it, or decides what happened to it, until that ends.

use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
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
/// Longest a job waits for another of this core to let go of a worktree.
const HOLD: Duration = Duration::from_secs(3);
/// Who Tasktap commits as where the person configured nobody.
const AUTHOR: &str = "Tasktap";
const EMAIL: &str = "tasktap@localhost";
const NO_COMMITS: &str = "the repository has no commits yet, so the run cannot start from one \
     in a worktree of its own: commit once, or set the project to never isolate";
const BUSY: &str = "an earlier git command for this worktree is still running, perhaps left \
     by a Tasktap that stopped; try again once it has ended";

/// Set on every command (see the module's notes). Hooks go to a folder
/// that never exists, added in [`Git::command`].
const SETTINGS: [&str; 17] = [
    "core.fsmonitor=false",
    "core.safecrlf=false",
    "core.pager=cat",
    "color.ui=false",
    "commit.gpgSign=false",
    "tag.gpgSign=false",
    "gc.auto=0",
    "maintenance.auto=false",
    "merge.autoStash=false",
    "merge.renormalize=false",
    "rebase.autoStash=false",
    "submodule.recurse=false",
    "diff.noprefix=false",
    "diff.mnemonicPrefix=false",
    "diff.relative=false",
    "status.renames=false",
    "advice.detachedHead=false",
];

/// Git as the core runs it, for one job on one repository.
pub struct Git {
    program: PathBuf,
    /// `<data>/worktrees`, canonical.
    root: PathBuf,
    env: Vec<(String, OsString)>,
    /// Settings that come after [`SETTINGS`], given through the
    /// environment, where a name may hold any character.
    config: Vec<(String, String)>,
    /// The filters the person configured, by name: none of them runs.
    filters: Vec<String>,
    /// The folders whose configuration was read for them.
    quieted: Vec<PathBuf>,
    /// The worktree this job holds, by name, and the file that holds it.
    hold: Option<(String, File)>,
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
    /// The core stopped during its last settle or tidy, so a git command of
    /// that core may still be working on it.
    pub stopped: bool,
}

/// A worktree proven to be one this core made (see the module's notes).
struct Own {
    name: String,
    path: PathBuf,
    branch: String,
}

/// What a worktree's folder holds against its branch.
struct Status {
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
    /// Git found on the terminals' PATH, for the data folder `data` and a
    /// job on the repository at `repo`, whose configured filters and merge
    /// drivers it keeps from running.
    pub fn new(data: &Path, repo: &Path) -> Result<Git, String> {
        let program = crate::terminal::find("git")
            .ok_or("git is not installed: no folder of the PATH has it")?;
        let root = data.join(FOLDER);
        let root = std::fs::create_dir_all(&root)
            .and_then(|()| std::fs::canonicalize(&root))
            .map_err(|e| format!("the worktrees' folder cannot be made: {e}"))?;
        let mut git = Git {
            program,
            env: environment(&root),
            root,
            config: Vec::new(),
            filters: Vec::new(),
            quieted: Vec::new(),
            hold: None,
        };
        if repo.is_dir() {
            git.quiet(repo)?;
        }
        Ok(git)
    }

    /// Keeps every filter and merge driver configured for commands in `dir`
    /// from running: a filter that does nothing, a driver that fails, which
    /// makes its file a conflict. A worktree may have settings of its own,
    /// so each folder git works in is read.
    fn quiet(&mut self, dir: &Path) -> Result<(), String> {
        if self.quieted.iter().any(|d| d == dir) {
            return Ok(());
        }
        let repo = dir;
        let list = [
            "config",
            "-z",
            "--name-only",
            "--get-regexp",
            r"^(filter|merge)\.",
        ];
        let ran = self.run(repo, &list, LOOK, &[], OUTPUT)?;
        // 1 is no such setting.
        if !matches!(ran.code, Some(0 | 1)) {
            return Err(failed("config", &ran));
        }
        for key in ran.out.split(|&b| b == 0) {
            let key = String::from_utf8_lossy(key);
            let (Some(first), Some(last)) = (key.find('.'), key.rfind('.')) else {
                continue;
            };
            if first == last {
                continue;
            }
            let (section, name, var) = (&key[..first], &key[first + 1..last], &key[last + 1..]);
            if section == "filter" && !self.filters.iter().any(|f| f == name) {
                self.filters.push(name.to_owned());
                for (var, value) in [
                    ("clean", ""),
                    ("smudge", ""),
                    ("process", ""),
                    ("required", "false"),
                ] {
                    self.config
                        .push((format!("filter.{name}.{var}"), value.into()));
                }
            } else if section == "merge" && var == "driver" {
                let key = format!("merge.{name}.driver");
                if !self.config.iter().any(|(k, _)| *k == key) {
                    self.config.push((key, "false".into()));
                }
            }
        }
        self.quieted.push(dir.to_owned());
        Ok(())
    }

    /// Holds a worktree for this job (see the module's notes), waiting a
    /// moment for another job of this core that holds it. Refused while a
    /// git command left by a core that stopped holds it: on Unix through
    /// the lock of its file, which lasts while any process has it open, and
    /// on Windows because a file a process has open without leave to delete
    /// it cannot be removed.
    fn hold(&mut self, name: &str) -> Result<(), String> {
        if self.hold.as_ref().is_some_and(|(held, _)| held == name) {
            return Ok(());
        }
        let deadline = std::time::Instant::now() + HOLD;
        loop {
            match self.try_hold(name) {
                Err(e) if e == BUSY && std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                done => return done,
            }
        }
    }

    fn try_hold(&mut self, name: &str) -> Result<(), String> {
        let path = self.root.join(format!(".{name}.lock"));
        #[cfg(unix)]
        let file = {
            let file = (std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true))
            .truncate(false)
            .open(&path)
            .map_err(|e| format!("{} cannot be opened: {e}", path.display()))?;
            match file.try_lock() {
                Ok(()) => file,
                Err(std::fs::TryLockError::WouldBlock) => return Err(BUSY.into()),
                Err(std::fs::TryLockError::Error(e)) => return Err(e.to_string()),
            }
        };
        #[cfg(windows)]
        let file = {
            use std::os::windows::fs::OpenOptionsExt;
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(BUSY.into()),
            }
            // Shared for reading and writing, never for removing.
            let open = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .share_mode(1 | 2)
                .open(&path);
            open.map_err(|_| BUSY.to_owned())?
        };
        self.hold = Some((name.to_owned(), file));
        Ok(())
    }

    /// Holds the worktree a record names, for a look that may decide a
    /// settle the core stopped during: refused while a git command of that
    /// core still works on it.
    pub fn hold_for(&mut self, w: &Workdir) -> Result<(), String> {
        let own = self.own(w)?;
        self.hold(&own.name)
    }

    /// The worktree a record names, proven to be one this core made, with
    /// what is configured for it kept from running.
    fn own(&mut self, w: &Workdir) -> Result<Own, String> {
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
        let name = name.ok_or_else(bad)?.to_owned();
        if path != self.root.join(&name) || w.branch != format!("{PREFIX}{name}") {
            return Err(bad());
        }
        // The worktrees' folder is canonical: only the worktree could be a link.
        if path.symlink_metadata().is_ok_and(|m| !m.is_dir()) {
            return Err(bad());
        }
        // Where its configuration cannot be read, no git command there can.
        if path.join(".git").is_file() {
            let _ = self.quiet(&path);
        }
        Ok(Own {
            name,
            path,
            branch: w.branch.clone(),
        })
    }

    // Making and finding.

    /// Makes the worktree a run works in, or finds it again (design §7): a
    /// new one on a new branch from the project folder's HEAD, or the
    /// thought's own, made again where it is gone.
    pub fn prepare(&mut self, repo: &Path, worktree: &Worktree) -> Result<Workdir, String> {
        match worktree {
            Worktree::New { name } => self.make(repo, name),
            Worktree::Again { workdir, .. } => self.again(repo, workdir),
        }
    }

    fn make(&mut self, repo: &Path, name: &str) -> Result<Workdir, String> {
        if !named(name) {
            return Err(format!("{name} is no name Tasktap gives a worktree"));
        }
        self.hold(name)?;
        let own = Own {
            name: name.into(),
            path: self.root.join(name),
            branch: format!("{PREFIX}{name}"),
        };
        // Made here and now by this attempt alone: another that came to the
        // same name finds it there and stops, touching nothing.
        std::fs::create_dir(&own.path).map_err(|e| {
            format!(
                "{} exists already, or cannot be made: {e}",
                own.path.display()
            )
        })?;
        let mut branched = None;
        let made = self.fill(repo, &own, &mut branched);
        if made.is_err() {
            // What this attempt made, and only that.
            let _ = std::fs::remove_dir_all(&own.path);
            self.forget(repo, &own);
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
    fn again(&mut self, repo: &Path, w: &Workdir) -> Result<Workdir, String> {
        let own = self.own(w)?;
        self.hold(&own.name)?;
        if own.path.symlink_metadata().is_ok() {
            if self.ties(&own) {
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
            return self.make(repo, &own.name);
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
    /// and lines; whether its branch has commits of its own, all in its
    /// destination, with nothing uncommitted beside them (what a Keep
    /// leaves before it tidies); whether removing it would lose nothing;
    /// and whether the folder and the branch are both gone.
    pub fn survey(&mut self, repo: &Path, w: &Workdir) -> Result<Found, String> {
        let own = self.own(w)?;
        let here = own.path.symlink_metadata().is_ok();
        let ties = here && self.ties(&own);
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
        let listed = self.list(repo, w, None)?;
        let in_destination = match (&tip, &w.destination) {
            (Some(tip), Some(to)) if *tip != w.base => {
                self.contains(repo, &format!("refs/heads/{to}"), tip)?
            }
            _ => false,
        };
        let status = match ties {
            true => Some(self.status(&own.path)?),
            false => None,
        };
        let changed = status.as_ref().is_none_or(|s| s.changed) && here;
        let bare = !here || status.is_some_and(|s| !s.changed && !s.ignored);
        let lines = |f: fn(&ChangedFile) -> Option<u32>| listed.files.iter().filter_map(f).sum();
        Ok(Found {
            files: listed.files.len() as u32,
            insertions: lines(|f| f.insertions),
            deletions: lines(|f| f.deletions),
            merged: in_destination && !changed,
            gone: false,
            spare: bare && (tip.as_deref() == Some(w.base.as_str()) || in_destination),
        })
    }

    /// Whether a worktree's folder is still the worktree git knows by its
    /// name, on its branch: its `.git` names git's record of it, which
    /// names it back.
    fn ties(&self, own: &Own) -> bool {
        if !own.path.join(".git").is_file() {
            return false;
        }
        let Ok(dir) = self.line(&own.path, &["rev-parse", "--absolute-git-dir"]) else {
            return false;
        };
        let back = std::fs::read_to_string(Path::new(&dir).join("gitdir")).ok();
        let back = back.and_then(|b| std::fs::canonicalize(b.trim()).ok());
        let mine = std::fs::canonicalize(own.path.join(".git")).ok();
        let head = self.line(&own.path, &["symbolic-ref", "-q", "HEAD"]).ok();
        let on = format!("refs/heads/{}", own.branch);
        back.is_some() && back == mine && head.as_deref() == Some(on.as_str())
    }

    /// What a folder holds beside its HEAD: staged, changed, untracked and
    /// ignored files.
    fn status(&self, dir: &Path) -> Result<Status, String> {
        let mut args = STATUS.to_vec();
        args.push("--ignored=matching");
        let out = self.ok(dir, &args, LOOK)?;
        let entries = out.split(|&b| b == 0).filter(|e| e.len() > 3);
        let (ignored, changed): (Vec<_>, Vec<_>) = entries.partition(|e| e.starts_with(b"!! "));
        Ok(Status {
            changed: !changed.is_empty(),
            ignored: !ignored.is_empty(),
        })
    }

    /// The worktree's changes against its base: the files, and with `diff`
    /// the patch, of everything or of the one path named. Untracked files
    /// count: they are read through an index of this look's own, so the
    /// worktree's index, which its agent may be using, stays as it is.
    /// With the folder gone or no longer tied to it, what its branch holds.
    pub fn list(
        &mut self,
        repo: &Path,
        w: &Workdir,
        diff: Option<Option<&str>>,
    ) -> Result<Listed, String> {
        let own = self.own(w)?;
        if own.path.symlink_metadata().is_ok() && self.ties(&own) {
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
        let own = self.line(
            path,
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        )?;
        let index = folder(&self.temporary("index"));
        // Without the copy, adding reads every file instead of what changed.
        let _ = std::fs::copy(&own, &index);
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
    /// branch, brings the branch into its destination when that touches
    /// nothing of the person's, then removes the worktree and the branch.
    /// The destination moves by a fast-forward when it has not moved since,
    /// and otherwise by a merge commit made without a working tree, only
    /// when it merges cleanly; nothing is rebased or forced. Where the
    /// destination is checked out, that folder follows by a fast-forward
    /// that git refuses whole when it would touch an uncommitted change or
    /// an untracked or ignored file, every option of which is set on the
    /// command, and which is checked afterwards to have done exactly that;
    /// otherwise it is undone. A refusal leaves everything as it was and
    /// says what the person can do.
    pub fn keep(&mut self, repo: &Path, w: &Workdir, title: &str) -> Result<(), String> {
        let own = self.own(w)?;
        self.hold(&own.name)?;
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
        if own.path.symlink_metadata().is_ok() {
            if !self.ties(&own) {
                return Err(format!(
                    "{} is no longer the worktree of {}: its link to git is gone or changed. Discard it, or take what is in it yourself",
                    own.path.display(),
                    own.branch
                ));
            }
            self.commit_all(&own, title)?;
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
            self.advance(repo, to, &head, &target)
                .map_err(|why| format!("{why}. {by_hand}"))?;
        }
        // Kept: the worktree and its branch go, as Keep says they do; one a
        // process works in waits, kept, for a later look.
        let _ = self.remove(repo, &own, Some(&tip));
        Ok(())
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
        let status = self.ok(&own.path, &STATUS, LOOK)?;
        let paths: Vec<String> = (status.split(|&b| b == 0))
            .filter(|e| e.len() > 3)
            .map(|e| String::from_utf8_lossy(&e[3..]).into_owned())
            .collect();
        if paths.is_empty() {
            return Ok(());
        }
        self.unfiltered(&own.path, &paths)?;
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

    /// Refuses files a filter the person configured applies to: Tasktap
    /// runs none, so it would commit or write them unfiltered.
    fn unfiltered(&self, dir: &Path, paths: &[String]) -> Result<(), String> {
        if self.filters.is_empty() {
            return Ok(());
        }
        let mut filtered = Vec::new();
        for chunk in paths.chunks(200) {
            let mut args = vec!["check-attr", "-z", "filter", "--"];
            args.extend(chunk.iter().map(String::as_str));
            let out = self.ok(dir, &args, LOOK)?;
            let mut parts = out.split(|&b| b == 0);
            while let (Some(path), Some(_), Some(value)) =
                (parts.next(), parts.next(), parts.next())
            {
                if self.filters.iter().any(|f| f.as_bytes() == value) {
                    filtered.push(String::from_utf8_lossy(path).into_owned());
                }
            }
        }
        match filtered.is_empty() {
            true => Ok(()),
            false => Err(format!(
                "{} go through a filter configured for this repository, which Tasktap does not run",
                shown(&filtered)
            )),
        }
    }

    /// A merge commit of `head` and `tip`, made without a working tree, or
    /// the files that conflict. No merge driver runs: one the person
    /// configured fails, and its file conflicts.
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
    /// it. Checked out nowhere, only the branch moves, from where it was.
    /// Checked out in a folder, that folder follows (see [`Git::keep`]).
    fn advance(&mut self, repo: &Path, to: &str, head: &str, target: &str) -> Result<(), String> {
        let branch = format!("refs/heads/{to}");
        let out: Vec<_> = (self.worktrees(repo)?.into_iter())
            .filter(|(_, on)| on.as_deref() == Some(branch.as_str()))
            .map(|(path, _)| path)
            .collect();
        let folder = match &out[..] {
            [] => return self.move_alone(repo, to, head, target),
            [folder] => folder.clone(),
            _ => return Err(format!("{to} is checked out in more than one folder")),
        };
        self.quiet(&folder)?;
        let dir = PathBuf::from(self.line(&folder, &["rev-parse", "--absolute-git-dir"])?);
        if let Some(what) = midway(&dir) {
            return Err(format!(
                "{} is in the middle of {what}, so {to} is not moved",
                folder.display()
            ));
        }
        let names = ["diff", "--name-status", "-z", "--no-renames", head, target];
        let changed = self.ok(&folder, &names, LOOK)?;
        let paths: Vec<String> = (changed.split(|&b| b == 0).skip(1).step_by(2))
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect();
        self.unfiltered(&folder, &paths)?;
        let clashes = self.clashes(&folder, &changed)?;
        if !clashes.is_empty() {
            return Err(format!(
                "{} has changes of its own to files this keep would change: {}. Commit them or put them aside there, then press Keep again",
                folder.display(),
                shown(&clashes)
            ));
        }
        pause("keep");
        // Nothing of the person's preferences decides what this does, and
        // the branch's log says where it was, should it need undoing.
        self.config
            .push((format!("branch.{to}.mergeOptions"), String::new()));
        self.config
            .push(("core.logAllRefUpdates".into(), "true".into()));
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
        let merged = self.ok(&folder, &merge, WRITE);
        // Exactly what was asked, or nothing: `to` is now `target`, or what
        // the merge did to whatever the folder was on instead is undone.
        if merged.is_ok() && self.commit_of(&folder, to)?.as_deref() == Some(target) {
            return Ok(());
        }
        let undone = self.undo(&folder, target);
        Err(match (merged, undone) {
            (Err(e), _) => format!("{} could not follow {to}: {e}", folder.display()),
            (Ok(_), Ok(())) => format!(
                "{} changed while keeping, so nothing was kept and what the keep did there was undone",
                folder.display()
            ),
            (Ok(_), Err(left)) => format!(
                "{} changed while keeping, so nothing was kept; {left}",
                folder.display()
            ),
        })
    }

    /// Undoes a fast-forward that did not do what Keep asked: the ref the
    /// folder is on (a branch, or its detached HEAD), which this merge moved
    /// to `target` as its log says, goes back to where it was, with the
    /// files; files and index written for `target` without the ref moving go
    /// back to that ref's commit. Anything else is not the merge's to undo.
    fn undo(&self, folder: &Path, target: &str) -> Result<(), String> {
        let on = self.line(folder, &["symbolic-ref", "-q", "HEAD"]);
        let on = on.unwrap_or_else(|_| "HEAD".into());
        let now = self.line(folder, &["rev-parse", "--verify", "-q", &on])?;
        let back = if now == target {
            let last = ["log", "-g", "-1", "--format=%gs", &on];
            if !self
                .line(folder, &last)?
                .starts_with(&format!("merge {target}"))
            {
                return Ok(());
            }
            self.line(
                folder,
                &["rev-parse", "--verify", "-q", &format!("{on}@{{1}}")],
            )?
        } else {
            let index = ["diff-index", "--cached", "--quiet", target, "--"];
            if self.run(folder, &index, LOOK, &[], 0)?.code != Some(0) {
                return Ok(());
            }
            now.clone()
        };
        if back == target {
            return Ok(());
        }
        let left = |e: String| format!("put {on} back with `git reset --keep {back}` there ({e})");
        self.ok(folder, &["read-tree", "-m", "-u", target, &back], WRITE)
            .map_err(left)?;
        if now == target {
            let update = ["update-ref", "--no-deref", &on, &back, target];
            self.ok(folder, &update, LOOK).map_err(left)?;
        }
        Ok(())
    }

    /// Moves `to`, checked out nowhere, from `head` to `target`, and only
    /// from there. A folder that took it meanwhile, still holding `head`'s
    /// files, would then hold files that are not its branch's: the branch
    /// goes back, and nothing is kept.
    fn move_alone(&self, repo: &Path, to: &str, head: &str, target: &str) -> Result<(), String> {
        let branch = format!("refs/heads/{to}");
        let note = format!("tasktap: keep into {to}");
        pause("keep");
        let update = ["update-ref", "-m", &note, &branch, target, head];
        self.ok(repo, &update, LOOK)?;
        let taken = (self.worktrees(repo)?.into_iter())
            .filter(|(_, on)| on.as_deref() == Some(branch.as_str()))
            .map(|(path, _)| path);
        for folder in taken {
            let index = ["diff-index", "--cached", "--quiet", head, "--"];
            if self.run(&folder, &index, LOOK, &[], 0)?.code == Some(0) {
                let back = ["update-ref", "-m", &note, &branch, head, target];
                self.ok(repo, &back, LOOK)?;
                return Err(format!(
                    "{to} was checked out in {} while keeping, so nothing was kept",
                    folder.display()
                ));
            }
        }
        Ok(())
    }

    /// The files a fast-forward of `folder` would write, as `git diff
    /// --name-status -z` lists them, that hold something of the person's:
    /// an uncommitted change, a file that is not tracked (ignored ones
    /// too), or a file where the keep needs a folder. Git refuses all of
    /// these as it writes; this says which, before it begins.
    fn clashes(&self, folder: &Path, changed: &[u8]) -> Result<Vec<String>, String> {
        let status = self.ok(folder, &STATUS, LOOK)?;
        let mine: BTreeSet<&[u8]> = (status.split(|&b| b == 0))
            .filter(|e| e.len() > 3)
            .map(|e| &e[3..])
            .collect();
        let mut parts = changed.split(|&b| b == 0);
        let mut clashes = Vec::new();
        while let (Some(how), Some(name)) = (parts.next(), parts.next()) {
            let on_disk = |p: &Path| folder.join(p).symlink_metadata();
            let file = bytes_path(name);
            let blocked = (file.ancestors().skip(1))
                .filter(|a| !a.as_os_str().is_empty())
                .any(|a| on_disk(a).is_ok_and(|m| !m.is_dir()));
            if mine.contains(name) || blocked || (how == b"A" && on_disk(&file).is_ok()) {
                clashes.push(String::from_utf8_lossy(name).into_owned());
            }
        }
        Ok(clashes)
    }

    /// Discard (design §7): removes the worktree, its uncommitted changes
    /// and its branch, commits that are nowhere else too. The project
    /// folder's files are never touched. Changes already in their
    /// destination are a Keep's to finish.
    pub fn discard(&mut self, repo: &Path, w: &Workdir) -> Result<(), String> {
        let own = self.own(w)?;
        self.hold(&own.name)?;
        let tip = match repo.is_dir() {
            true => self.commit_of(repo, &own.branch)?,
            false => None,
        };
        if tip.is_some() && self.survey(repo, w).is_ok_and(|f| f.merged) {
            return Err(format!(
                "these changes are in {} already, kept by a Keep Tasktap stopped during or merged by hand: press Keep to tidy up",
                w.destination.as_deref().unwrap_or("their branch")
            ));
        }
        self.remove(repo, &own, tip.as_deref())
    }

    /// Removes a worktree and its branch when nothing would be lost (see
    /// the module's notes). Otherwise returns what it found and removes
    /// nothing.
    pub fn tidy(&mut self, repo: &Path, w: &Workdir) -> Result<Option<Found>, String> {
        let own = self.own(w)?;
        self.hold(&own.name)?;
        let found = self.survey(repo, w)?;
        if found.gone {
            return Ok(None);
        }
        if !found.spare {
            return Ok(Some(found));
        }
        let tip = self.commit_of(repo, &own.branch)?;
        self.remove(repo, &own, tip.as_deref()).map(|()| None)
    }

    // Parts.

    /// Removes a worktree of this core's: never while a process works in
    /// it; moved aside first, which on Windows a folder in use refuses and
    /// after which nothing reaches it by its name; then git's record of it,
    /// the folder, and its branch where that still points at `tip`.
    fn remove(&self, repo: &Path, own: &Own, tip: Option<&str>) -> Result<(), String> {
        if own.path.symlink_metadata().is_ok() {
            let in_use = || {
                format!(
                    "{} is in use by a process working there",
                    own.path.display()
                )
            };
            if crate::sys::working_folders()
                .iter()
                .any(|cwd| cwd.starts_with(&own.path))
            {
                return Err(in_use());
            }
            let aside = self.root.join(format!(".{}.removing", own.name));
            if aside.symlink_metadata().is_ok_and(|m| m.is_dir()) {
                std::fs::remove_dir_all(&aside).map_err(|e| e.to_string())?;
            }
            std::fs::rename(&own.path, &aside).map_err(|e| format!("{}: {e}", in_use()))?;
            self.forget(repo, own);
            std::fs::remove_dir_all(&aside)
                .map_err(|e| format!("{} could not be removed: {e}", aside.display()))?;
        } else {
            self.forget(repo, own);
        }
        if let Some(tip) = tip.filter(|_| repo.is_dir()) {
            let at = format!("refs/heads/{}", own.branch);
            if self.commit_of(repo, &own.branch)?.is_some() {
                self.ok(repo, &["update-ref", "-d", &at, tip], LOOK)
                    .map_err(|e| format!("the branch {} was left: {e}", own.branch))?;
            }
        }
        Ok(())
    }

    /// Drops git's record of a worktree whose folder is gone.
    fn forget(&self, repo: &Path, own: &Own) {
        if repo.is_dir() && own.path.symlink_metadata().is_err() {
            let forget = os(&["worktree", "remove", "--force"], &own.path, &[]);
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

    /// Every worktree of the repository, with the branch it is on.
    fn worktrees(&self, repo: &Path) -> Result<Vec<(PathBuf, Option<String>)>, String> {
        let out = self.ok(repo, &["worktree", "list", "--porcelain", "-z"], LOOK)?;
        let mut all = Vec::new();
        for field in out.split(|&b| b == 0) {
            if let Some(path) = field.strip_prefix(b"worktree ") {
                all.push((bytes_path(path), None));
            } else if let (Some(branch), Some(last)) =
                (field.strip_prefix(b"branch "), all.last_mut())
            {
                last.1 = Some(String::from_utf8_lossy(branch).into_owned());
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
        command.env("GIT_CONFIG_COUNT", self.config.len().to_string());
        for (n, (key, value)) in self.config.iter().enumerate() {
            command.env(format!("GIT_CONFIG_KEY_{n}"), key);
            command.env(format!("GIT_CONFIG_VALUE_{n}"), value);
        }
        command
    }

    /// Runs git in `dir` within `limit`, which ends it when it is up, and
    /// keeps the first `keep` bytes of what it printed. Its output goes to
    /// files, so a command that outlives a core that stopped is never
    /// ended by writing to nobody; its input is the worktree's hold.
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
        let input = match &self.hold {
            Some((_, hold)) => Stdio::from(hold.try_clone().map_err(|e| e.to_string())?),
            None => Stdio::null(),
        };
        let mut child = self
            .command(dir)
            .args(args)
            .envs(env.iter().copied())
            .stdin(input)
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
/// every thought not settled and returns what it found; tidies what is left
/// of settled ones, and the worktrees no thought records that a launch
/// recorded in `launched` made and stopped before recording, when nothing
/// would be lost; finishes removing what a removal stopped during; and
/// removes the files of looks and commands that stopped. `there` is what
/// the worktrees' folder held before any job of this run began. A worktree
/// still held by a git command of a core that stopped is left until the
/// next start, undecided. Anything it cannot tie to the core is left alone.
pub fn sweep(
    data: &Path,
    owners: &[Owner],
    there: &[PathBuf],
    launched: &BTreeSet<String>,
) -> Vec<(ThoughtId, String, Found)> {
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
        let Ok(mut git) = Git::new(data, &o.repo) else {
            continue;
        };
        let Ok(own) = git.own(&o.workdir) else {
            continue;
        };
        // Nothing is decided while a git command of the core that stopped
        // still works on it.
        if o.stopped && git.hold(&own.name).is_err() {
            continue;
        }
        match o.workdir.changes {
            Changes::Clean | Changes::Pending => {
                if let Ok(f) = git.survey(&o.repo, &o.workdir) {
                    found.push((o.thought, o.workdir.path.clone(), f));
                }
            }
            Changes::Kept | Changes::Discarded => drop(git.tidy(&o.repo, &o.workdir)),
        }
    }
    for path in there {
        let Some(name) = path.file_name().and_then(OsStr::to_str) else {
            continue;
        };
        if name.starts_with(".tmp-") {
            let _ = std::fs::remove_file(path);
        } else if let Some(name) = name
            .strip_prefix('.')
            .and_then(|n| n.strip_suffix(".removing"))
        {
            finish_removing(data, name);
        } else if named(name) && !known.contains(name) && launched.contains(name) {
            stray(data, name);
        }
    }
    found
}

/// Finishes removing a worktree a removal moved aside and stopped during.
fn finish_removing(data: &Path, name: &str) {
    let Ok(mut git) = Git::new(data, Path::new("")) else {
        return;
    };
    let aside = git.root.join(format!(".{name}.removing"));
    if named(name) && git.hold(name).is_ok() && aside.symlink_metadata().is_ok_and(|m| m.is_dir()) {
        let _ = std::fs::remove_dir_all(&aside);
    }
}

/// A worktree no thought records, which a launch of this core made and
/// stopped before recording: removed with its branch only when git still
/// ties it to that branch, nothing is in it beside the branch's files and
/// the branch's commits are on another branch too.
fn stray(data: &Path, name: &str) {
    let Ok(probe) = Git::new(data, Path::new("")) else {
        return;
    };
    let path = probe.root.join(name);
    let common = probe.line(
        &path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    );
    let Ok(common) = common.map(PathBuf::from) else {
        return;
    };
    let Ok(mut git) = Git::new(data, &common) else {
        return;
    };
    let own = Own {
        name: name.into(),
        path,
        branch: format!("{PREFIX}{name}"),
    };
    if git.hold(name).is_err() || !git.ties(&own) {
        return;
    }
    let bare = git
        .status(&own.path)
        .is_ok_and(|s| !s.changed && !s.ignored);
    let Ok(Some(tip)) = git.commit_of(&common, &own.branch) else {
        return;
    };
    let refs = [
        "for-each-ref",
        "--format=%(refname)",
        "--contains",
        &tip,
        "refs/heads",
    ];
    let mine = format!("refs/heads/{}", own.branch);
    let elsewhere = git.ok(&common, &refs, LOOK).is_ok_and(|out| {
        (out.split(|&c| c == b'\n')).any(|r| !r.is_empty() && r != mine.as_bytes())
    });
    if bare && elsewhere {
        let _ = git.remove(&common, &own, Some(&tip));
    }
}

/// The status of a folder as Keep reads it: every untracked file listed
/// on its own.
const STATUS: [&str; 5] = [
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
    "--no-renames",
];

/// The core's checks' environment, never asking anyone anything, never
/// looking for a repository above the worktrees' folder, and with how a
/// person keeps git from their configuration where they did.
fn environment(root: &Path) -> Vec<(String, OsString)> {
    let mut env = crate::terminal::environment_of_checks();
    for (key, value) in [
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GIT_OPTIONAL_LOCKS", "0"),
        ("GIT_LITERAL_PATHSPECS", "1"),
        ("GIT_LFS_SKIP_SMUDGE", "1"),
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

/// What a git folder is in the middle of, if anything.
fn midway(git_dir: &Path) -> Option<&'static str> {
    let marks = [
        ("MERGE_HEAD", "a merge"),
        ("rebase-merge", "a rebase"),
        ("rebase-apply", "a rebase"),
        ("CHERRY_PICK_HEAD", "a cherry-pick"),
        ("REVERT_HEAD", "a revert"),
        ("BISECT_LOG", "a bisect"),
        (
            "index.lock",
            "another git command, or one that stopped holding its index",
        ),
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
