//! Isolated runs (design §7, "Isolation"): the git work, and nothing else.
//! The state machine decides when a run gets a worktree, what a look at one
//! means and when one may go (`state.rs`); this module makes, reads, keeps
//! and removes worktrees as `effects.rs` asks, on threads of their own.
//!
//! Git runs as a command, never as a library, each command with a deadline
//! of its own, standard input closed and no prompt for credentials. The
//! settings that could run a program of the person's or the repository's,
//! wait on someone, or change what git prints are turned off for every
//! command: hooks, signing, the file system monitor, the pager, color,
//! external diff and text conversion, automatic upkeep, stashing around a
//! merge, recursing into submodules, fetching large files, refusing an add
//! over line endings. Everything else
//! of the person's configuration applies, such as line endings and filters.
//! What Tasktap commits carries the identity the person configured, or
//! Tasktap's where there is none.
//!
//! Only what this module made is removed: a folder under
//! `<data>/worktrees/` and a branch named `tasktap/…`; anything else is
//! refused before git runs.

use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

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
/// Who Tasktap commits as where the person configured nobody.
const NAME: &str = "Tasktap";
const EMAIL: &str = "tasktap@localhost";
const NO_COMMITS: &str = "the repository has no commits yet, so the run cannot start from one \
     in a worktree of its own: commit once, or set the project to never isolate";

/// Set on every command (see the module's notes). Hooks go to a folder
/// that never exists, added in [`Git::command`].
const SETTINGS: [&str; 16] = [
    "core.fsmonitor=false",
    "core.safecrlf=false",
    "core.pager=cat",
    "color.ui=false",
    "commit.gpgSign=false",
    "tag.gpgSign=false",
    "gc.auto=0",
    "maintenance.auto=false",
    "merge.autoStash=false",
    "rebase.autoStash=false",
    "submodule.recurse=false",
    "diff.noprefix=false",
    "diff.mnemonicPrefix=false",
    "diff.relative=false",
    "status.renames=false",
    "advice.detachedHead=false",
];

/// Git as the core runs it, for one data folder.
pub struct Git {
    program: PathBuf,
    /// `<data>/worktrees`, canonical.
    root: PathBuf,
    env: Vec<(String, OsString)>,
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

impl Git {
    /// Git found on the terminals' PATH, for the data folder `data`.
    pub fn new(data: &Path) -> Result<Git, String> {
        let program = crate::terminal::find("git")
            .ok_or("git is not installed: no folder of the PATH has it")?;
        let root = data.join(FOLDER);
        std::fs::create_dir_all(&root)
            .and_then(|()| std::fs::canonicalize(&root))
            .map(|root| Git {
                program,
                root,
                env: environment(),
            })
            .map_err(|e| format!("the worktrees' folder cannot be made: {e}"))
    }

    // Making and finding.

    /// Makes the worktree a run works in, or finds it again (design §7): a
    /// new one on a new branch from the project folder's HEAD, or the
    /// thought's own, made again where it is gone.
    pub fn prepare(&self, repo: &Path, worktree: &Worktree) -> Result<Workdir, String> {
        match worktree {
            Worktree::New { name } => self.make(repo, name),
            Worktree::Again { workdir, .. } => self.again(repo, workdir),
        }
    }

    fn make(&self, repo: &Path, name: &str) -> Result<Workdir, String> {
        let path = self.root.join(name);
        let branch = format!("{PREFIX}{name}");
        self.ours(&path, &branch)?;
        if path.exists() {
            return Err(format!("{} exists already", path.display()));
        }
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
        if self.commit_of(repo, &branch)?.is_some() {
            return Err(format!(
                "a branch {branch} exists already, and Tasktap does not take over a branch it did not make"
            ));
        }
        // The person's own uncommitted work stays in the project folder; the
        // run starts from what is committed, and its record says so.
        let status = ["status", "--porcelain", "-z", "--untracked-files=normal"];
        let left_out = !self.ok(repo, &status, LOOK)?.is_empty();
        let path_arg = folder(&path);
        let add: [&OsStr; 7] = [
            "worktree".as_ref(),
            "add".as_ref(),
            "--quiet".as_ref(),
            "-b".as_ref(),
            branch.as_ref(),
            path_arg.as_os_str(),
            base.as_ref(),
        ];
        if let Err(e) = self.ok(repo, &add, WRITE) {
            // The branch did not exist before, so it is this attempt's.
            self.remove(repo, &path, Some(&branch));
            return Err(format!("the worktree could not be made: {e}"));
        }
        Ok(Workdir {
            path: path.to_string_lossy().into_owned(),
            branch,
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
        let path = PathBuf::from(&w.path);
        self.ours(&path, &w.branch)?;
        if path.join(".git").exists() {
            return Ok(w.clone());
        }
        if path.exists() {
            return Err(format!(
                "{} is there but is no worktree any more; keep or discard its changes first",
                path.display()
            ));
        }
        // What git still knows of the folder that is gone.
        let _ = self.run(
            repo,
            &os(&["worktree", "remove", "--force"], &path),
            LOOK,
            &[],
            0,
        );
        if self.commit_of(repo, &w.branch)?.is_none() {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
            return self.make(repo, &name.unwrap_or_default());
        }
        let mut add = os(&["worktree", "add", "--quiet"], &path);
        add.push(w.branch.clone().into());
        self.ok(repo, &add, WRITE)
            .map_err(|e| format!("the worktree could not be made again: {e}"))?;
        Ok(w.clone())
    }

    // Looking.

    /// What a worktree holds against the commit it started from: its files
    /// and lines, whether its branch has commits of its own that are all in
    /// its destination with nothing left uncommitted (a Keep happened), and
    /// whether the folder and the branch are both gone.
    pub fn survey(&self, repo: &Path, w: &Workdir) -> Result<Found, String> {
        let path = Path::new(&w.path);
        let here = path.join(".git").exists();
        let dir = match (here, repo.is_dir()) {
            (true, _) => path,
            (false, true) => repo,
            (false, false) => return Ok(gone()),
        };
        let tip = self.commit_of(dir, &w.branch)?;
        if !here && tip.is_none() {
            return Ok(gone());
        }
        let listed = self.list(repo, w, None)?;
        // Only a branch with commits of its own can be in its destination.
        let merged = match (&tip, &w.destination) {
            (Some(tip), Some(to)) if *tip != w.base => {
                let uncommitted = here && !self.ok(path, &STATUS, LOOK)?.is_empty();
                !uncommitted && self.contains(dir, &format!("refs/heads/{to}"), tip)?
            }
            _ => false,
        };
        let lines = |f: fn(&ChangedFile) -> Option<u32>| listed.files.iter().filter_map(f).sum();
        Ok(Found {
            files: listed.files.len() as u32,
            insertions: lines(|f| f.insertions),
            deletions: lines(|f| f.deletions),
            merged,
            gone: false,
        })
    }

    /// The worktree's changes against its base: the files, and with `diff`
    /// the patch, of everything or of the one path named. Untracked files
    /// count: they are read through an index of this look's own, so the
    /// worktree's index, which its agent may be using, stays as it is. With
    /// the folder gone, what its branch holds.
    pub fn list(
        &self,
        repo: &Path,
        w: &Workdir,
        diff: Option<Option<&str>>,
    ) -> Result<Listed, String> {
        let path = Path::new(&w.path);
        if path.join(".git").exists() {
            let revs = ["--cached", w.base.as_str()];
            return self.with_index(path, |index| self.diffs(path, &revs, diff, index));
        }
        // Its folder gone, what its branch holds; with the branch gone, nothing.
        if self.commit_of(repo, &w.branch)?.is_none() {
            return Ok(Listed::default());
        }
        let tip = format!("refs/heads/{}", w.branch);
        self.diffs(repo, &[w.base.as_str(), tip.as_str()], diff, None)
    }

    fn diffs(
        &self,
        dir: &Path,
        revs: &[&str],
        diff: Option<Option<&str>>,
        index: Option<&Path>,
    ) -> Result<Listed, String> {
        let env: Vec<_> = index
            .map(|i| ("GIT_INDEX_FILE", i.as_os_str()))
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
            diff: Vec::new(),
            size: 0,
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
        let tag: String = tasktap_proto::Secret::mint().0[..6]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let index = folder(&self.root.join(format!(".look-{tag}.index")));
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
    /// destination is checked out, that folder is updated as a fast-forward
    /// that git refuses whole when it would touch an uncommitted change, and
    /// that is refused here first when it would write over any file the
    /// person has there, ignored ones too. A refusal leaves everything as it
    /// was and says what the person can do.
    pub fn keep(&self, repo: &Path, w: &Workdir, title: &str) -> Result<(), String> {
        let path = Path::new(&w.path);
        self.ours(path, &w.branch)?;
        if !repo.is_dir() {
            return Err(format!(
                "the project folder {} is not there, so nothing can be kept into it",
                repo.display()
            ));
        }
        let by_hand = format!(
            "Branch {} holds this thought's changes: merge it yourself and press Keep again, which then only tidies up, or Discard",
            w.branch
        );
        let Some(to) = &w.destination else {
            return Err(format!(
                "the project folder was on no branch (a detached HEAD) when this run started, so there is no branch to keep it into. {by_hand}"
            ));
        };
        if path.join(".git").exists() {
            self.commit_all(path, w, title)?;
        }
        let Some(tip) = self.commit_of(repo, &w.branch)? else {
            return Err(format!(
                "the branch {} is gone, so nothing is left to keep",
                w.branch
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
            let merged = format!("Merge branch '{}' into {to}\n\n{title}\n", w.branch);
            self.merged(repo, &head, &tip, &merged).map_err(|why| {
                format!("{to} has moved since this run started, and {why}. {by_hand}")
            })?
        };
        if target != head {
            self.advance(repo, to, &head, &target)
                .map_err(|why| format!("{why}. {by_hand}"))?;
        }
        // Kept: what is left goes, and failing that the next start's sweep
        // removes it, since the branch is in its destination.
        self.remove(repo, path, Some(&w.branch));
        Ok(())
    }

    /// Commits everything uncommitted in the worktree on its branch, once
    /// it is clear the worktree is on that branch with nothing half done.
    fn commit_all(&self, path: &Path, w: &Workdir, title: &str) -> Result<(), String> {
        let dir = PathBuf::from(self.line(path, &["rev-parse", "--absolute-git-dir"])?);
        if let Some(what) = midway(&dir) {
            return Err(format!(
                "the worktree is in the middle of {what}; finish or abort it in {} first",
                path.display()
            ));
        }
        let head = self.run(path, &["symbolic-ref", "-q", "HEAD"], LOOK, &[], ERRORS)?;
        let on = text(&head.out);
        if head.code != Some(0) || on.strip_prefix("refs/heads/") != Some(w.branch.as_str()) {
            return Err(format!(
                "the worktree is not on its branch {} any more; put it back there, or keep the changes yourself",
                w.branch
            ));
        }
        if self.ok(path, &STATUS, LOOK)?.is_empty() {
            return Ok(());
        }
        self.ok(path, &["add", "--all"], WRITE)?;
        let message = format!("{title}\n\nCommitted by Tasktap when its changes were kept.\n");
        let identity = self.identity(path);
        let commit = ["commit", "--quiet", "--no-verify", "-m", &message];
        let ran = self.run(path, &commit, WRITE, &identity, ERRORS)?;
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
    /// it. Where `to` is checked out, that folder follows as a fast-forward.
    fn advance(&self, repo: &Path, to: &str, head: &str, target: &str) -> Result<(), String> {
        let branch = format!("refs/heads/{to}");
        let out: Vec<_> = (self.worktrees(repo)?.into_iter())
            .filter(|(_, on)| on.as_deref() == Some(branch.as_str()))
            .map(|(path, _)| path)
            .collect();
        let Some(folder) = out.first() else {
            // Checked out nowhere: only the branch moves, and only from where it was.
            let note = format!("tasktap: keep into {to}");
            let update = ["update-ref", "-m", &note, &branch, target, head];
            return self.ok(repo, &update, LOOK).map(drop);
        };
        let dir = PathBuf::from(self.line(folder, &["rev-parse", "--absolute-git-dir"])?);
        if let Some(what) = midway(&dir) {
            return Err(format!(
                "{} is in the middle of {what}, so {to} is not moved",
                folder.display()
            ));
        }
        let clashes = self.clashes(folder, head, target)?;
        if !clashes.is_empty() {
            return Err(format!(
                "{} has changes of its own to files this keep would change: {}. Commit them or put them aside there, then press Keep again",
                folder.display(),
                shown(&clashes)
            ));
        }
        let merge = [
            "merge",
            "--ff-only",
            "--no-autostash",
            "--no-stat",
            "--quiet",
            target,
        ];
        self.ok(folder, &merge, WRITE)
            .map(drop)
            .map_err(|e| format!("{} could not follow {to}: {e}", folder.display()))
    }

    /// The files a fast-forward of `folder` from `head` to `target` would
    /// write that hold something of the person's: an uncommitted change, a
    /// file that is not tracked (ignored ones too, which git would write
    /// over), or a file where the keep needs a folder.
    fn clashes(&self, folder: &Path, head: &str, target: &str) -> Result<Vec<String>, String> {
        let status = self.ok(folder, &STATUS, LOOK)?;
        let mine: BTreeSet<&[u8]> = (status.split(|&b| b == 0))
            .filter(|e| e.len() > 3)
            .map(|e| &e[3..])
            .collect();
        let names = ["diff", "--name-status", "-z", "--no-renames", head, target];
        let changed = self.ok(folder, &names, LOOK)?;
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
    /// folder's files are never touched.
    pub fn discard(&self, repo: &Path, w: &Workdir) -> Result<(), String> {
        let path = Path::new(&w.path);
        self.ours(path, &w.branch)?;
        self.remove(repo, path, None);
        if path.exists() {
            std::fs::remove_dir_all(path)
                .map_err(|e| format!("{} could not be removed: {e}", path.display()))?;
            // What git knows of it, now that the folder is gone.
            let _ = self.run(
                repo,
                &os(&["worktree", "remove", "--force"], path),
                LOOK,
                &[],
                0,
            );
        }
        if repo.is_dir() && self.commit_of(repo, &w.branch)?.is_some() {
            self.ok(repo, &["branch", "-D", &w.branch], LOOK)?;
        }
        Ok(())
    }

    /// Removes a worktree and its branch when nothing would be lost: no
    /// changes against its base, or all of them in its destination with
    /// nothing uncommitted. Otherwise returns what it found and removes
    /// nothing.
    pub fn tidy(&self, repo: &Path, w: &Workdir) -> Result<Option<Found>, String> {
        let found = self.survey(repo, w)?;
        if found.gone {
            return Ok(None);
        }
        if found.files > 0 && !found.merged {
            return Ok(Some(found));
        }
        self.discard(repo, w).map(|()| None)
    }

    /// At start (design §3): looks at every worktree a thought has not
    /// settled and returns what it found; tidies the worktrees of settled
    /// thoughts, and of `there`, what the worktrees' folder held before
    /// any launch, those no thought records, which a launch that stopped
    /// before recording one left, where nothing would be lost; and removes
    /// the indexes of looks that stopped. Each worktree is taken on its
    /// own, so one that git cannot read holds up no other.
    pub fn sweep(&self, owners: &[Owner], there: &[PathBuf]) -> Vec<(ThoughtId, String, Found)> {
        let mut found = Vec::new();
        let mut known = BTreeSet::new();
        for o in owners {
            let path = PathBuf::from(&o.workdir.path);
            // A folder that is gone and holds nothing pending needs nothing.
            if o.workdir.changes != Changes::Pending && !path.exists() {
                continue;
            }
            known.insert(path);
            match o.workdir.changes {
                Changes::Clean | Changes::Pending => {
                    if let Ok(f) = self.survey(&o.repo, &o.workdir) {
                        found.push((o.thought, o.workdir.path.clone(), f));
                    }
                }
                Changes::Kept | Changes::Discarded => {
                    let _ = self.tidy(&o.repo, &o.workdir);
                }
            }
        }
        for name in there.iter().filter_map(|p| p.file_name()) {
            let path = self.root.join(name);
            if name.to_string_lossy().starts_with(".look-") {
                let _ = std::fs::remove_file(&path);
            } else if path.is_dir() && !known.contains(&path) {
                self.stray(&path);
            }
        }
        found
    }

    /// A worktree folder no thought records: removed with its branch when
    /// it holds nothing uncommitted and its branch's commits are on another
    /// branch too; a folder that is no worktree at all is removed.
    fn stray(&self, path: &Path) {
        let common = self.line(
            path,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        );
        let Ok(common) = common.map(PathBuf::from) else {
            if !path.join(".git").exists() {
                let _ = std::fs::remove_dir_all(path);
            }
            return;
        };
        let branch = (self.line(path, &["symbolic-ref", "-q", "HEAD"]).ok())
            .and_then(|b| b.strip_prefix("refs/heads/").map(str::to_owned))
            .filter(|b| b.starts_with(PREFIX));
        let clean = self.ok(path, &STATUS, LOOK).is_ok_and(|s| s.is_empty());
        let elsewhere = branch.as_ref().is_some_and(|b| {
            let refs = [
                "for-each-ref",
                "--format=%(refname)",
                "--contains",
                b,
                "refs/heads",
            ];
            self.ok(path, &refs, LOOK).is_ok_and(|out| {
                (out.split(|&c| c == b'\n'))
                    .any(|r| !r.is_empty() && r != format!("refs/heads/{b}").as_bytes())
            })
        });
        if let (true, true, Some(branch)) = (clean, elsewhere, branch) {
            self.remove(&common, path, Some(&branch));
        }
    }

    // Parts.

    /// Removes a worktree of ours with git, and then the branch when one is
    /// named, ignoring what fails: each caller checks what is left.
    fn remove(&self, repo: &Path, path: &Path, branch: Option<&str>) {
        if self.ours(path, branch.unwrap_or(PREFIX)).is_err() || !repo.is_dir() {
            return;
        }
        // Twice: also when its agent locked it.
        let remove = os(&["worktree", "remove", "--force", "--force"], path);
        let _ = self.run(repo, &remove, WRITE, &[], 0);
        if let Some(branch) = branch {
            let _ = self.run(repo, &["branch", "-D", branch], LOOK, &[], 0);
        }
    }

    /// Refuses a folder that is not one of ours or a branch not named as ours.
    fn ours(&self, path: &Path, branch: &str) -> Result<(), String> {
        let inside = path.starts_with(&self.root) && path != self.root;
        if inside && branch.starts_with(PREFIX) {
            Ok(())
        } else {
            Err(format!(
                "{} on {branch} is not a worktree Tasktap made, so it is left alone",
                path.display()
            ))
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
        let ran = self.run(
            dir,
            &["merge-base", "--is-ancestor", commit, of],
            LOOK,
            &[],
            ERRORS,
        )?;
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
        let (name, email) = (OsStr::new(NAME), OsStr::new(EMAIL));
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
    /// keeps the first `keep` bytes of what it printed.
    fn run(
        &self,
        dir: &Path,
        args: &[impl AsRef<OsStr>],
        limit: Duration,
        env: &[(&str, &OsStr)],
        keep: usize,
    ) -> Result<Ran, String> {
        let mut child = self
            .command(dir)
            .args(args)
            .envs(env.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("git could not run: {e}"))?;
        let (done, read) = mpsc::channel();
        if let Some(out) = child.stdout.take() {
            drain(out, keep, true, done.clone());
        }
        if let Some(err) = child.stderr.take() {
            drain(err, ERRORS, false, done.clone());
        }
        drop(done);
        let deadline = Instant::now() + limit;
        let mut ran = Ran {
            code: None,
            out: Vec::new(),
            size: 0,
            err: String::new(),
        };
        for _ in 0..2 {
            match read.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok((true, out, size)) => (ran.out, ran.size) = (out, size),
                Ok((false, err, _)) => ran.err = String::from_utf8_lossy(&err).into_owned(),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "git {} did not finish within {} s",
                        verb(args),
                        limit.as_secs()
                    ));
                }
            }
        }
        // Both outputs have ended, as they do when git exits.
        ran.code = child.wait().map_err(|e| e.to_string())?.code();
        Ok(ran)
    }
}

/// Reads one of a command's outputs to its end on a thread of its own,
/// keeping its first `keep` bytes and counting the rest, and sends them
/// with `out`, which says which output it was.
fn drain(
    mut output: impl Read + Send + 'static,
    keep: usize,
    out: bool,
    done: mpsc::Sender<(bool, Vec<u8>, u64)>,
) {
    std::thread::spawn(move || {
        let (mut kept, mut size, mut buf) = (Vec::new(), 0u64, [0u8; 64 << 10]);
        while let Ok(n @ 1..) = output.read(&mut buf) {
            let room = keep.saturating_sub(kept.len()).min(n);
            kept.extend_from_slice(&buf[..room]);
            size += n as u64;
        }
        let _ = done.send((out, kept, size));
    });
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

/// The core's checks' environment, never asking anyone anything, and with
/// how a person keeps git from their configuration where they did.
fn environment() -> Vec<(String, OsString)> {
    let mut env = crate::terminal::environment_of_checks();
    for (key, value) in [
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GIT_OPTIONAL_LOCKS", "0"),
        ("GIT_LITERAL_PATHSPECS", "1"),
        ("GIT_LFS_SKIP_SMUDGE", "1"),
    ] {
        env.push((key.into(), value.into()));
    }
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
            files.insert(
                path.clone(),
                ChangedFile {
                    path,
                    change,
                    insertions: None,
                    deletions: None,
                },
            );
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

fn gone() -> Found {
    Found {
        gone: true,
        ..Found::default()
    }
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

/// Arguments, and then a path as the last.
fn os(args: &[&str], path: &Path) -> Vec<OsString> {
    let mut all: Vec<OsString> = args.iter().map(OsString::from).collect();
    all.push(folder(path).into_os_string());
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
