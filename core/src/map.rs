//! What Tasktap knows of the person's projects (docs/projects-design.md):
//! the looks, places it learns of projects from (an agent's history, a
//! folder the person keeps projects in), and one card per folder.
//!
//! A card is not a workspace: no right to read, show or open anything comes
//! from it (`rules::inside` reads `projects` only). A known project becomes
//! a workspace when a thought starts there (`state.rs`, `Destination::Card`)
//! or the person opens it. No look is needed: with none, a folder the person
//! opens is a project, as before; each look only adds, and what the person
//! did (opened, named, hid, chose a copy) beats what any look says.
//!
//! **The root rule.** A folder is a project's top on this evidence, the
//! strongest first: an agent was started there (its history, or Tasktap's
//! own runs); it is the top of a Git repository; it has a package file and
//! no project above it; an agent's files are in it. A worktree or submodule
//! is no project: work there is work in the repository it belongs to. A
//! folder inside a project is an entry of its own only where an agent was
//! started, and is shown under that project, never offered by itself. The
//! home folder, Desktop, Documents and Downloads are never projects by
//! themselves; the system's folders, temporary folders, Tasktap's own data
//! and other tools' hidden folders (`~/.cache/…`) never are, not even where
//! an agent was started (measured on the owner's machine: every copy of a
//! repository found 151 times was a benchmark tool's under `~/.cache`).
//!
//! **One repository, several copies.** A repository is known by its remote
//! (`remote github.com/owner/name`, its address without user or password)
//! and, without one, by its first commit (`root <commit>`, which git
//! answers in a few milliseconds and is kept on the card). Copies of one
//! repository are one project: the copy the person chose; else one opened
//! in Tasktap; else one in a folder of different projects rather than in a
//! folder of copies of itself; else the one worked in last; else the
//! shortest path. The others are shown under it and never offered.
//!
//! **What is read** is bounded here, and nothing else is: of an agent's
//! history, the folder each session started in and when the session's file
//! last changed, read until the folder is found and no further
//! ([`HISTORY_BYTES`], [`HISTORY_FILES`], [`HISTORY_TIME`]); of a folder to
//! look in, the names directly inside it and one level into a folder there
//! that is no project ([`ENTRIES`]); of a project, the names at its top, its
//! package file's name and description ([`PACKAGE_BYTES`]), its README's
//! first paragraph ([`README_BYTES`], [`ABOUT`] characters kept), and of
//! `.git/config` the remote's address ([`CONFIG_BYTES`]). Never a source
//! file, never what was said in a session, never a file's later bytes.
//!
//! **No timer, no watcher.** A look runs when the person asks for one (the
//! first run, Settings, a look switched on) and when a capture or the list
//! needs what is kept, after one cheap check of the modified times of the
//! looked-at folders found something changed ([`freshen`]). It runs on a
//! thread of its own; the core's thread only merges what it found.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use tasktap_proto::call::{self, Call, Code, Error};
use tasktap_proto::{
    AddLook, CallId, Card, CardId, Control, Empty, Evidence, Find, Finds, Found, Look, LookId,
    LookKind, LookState, Looked, MAX_LINE, Offer, OfferedAgent, OfferedPlace, Place, ProjectId,
    ProjectKind, Rev, Time, json_len,
};

use crate::calls::Cx;
use crate::conn::Link;
use crate::effects::{self, stored};
use crate::serve::Core;
use crate::store::{self, Tx};

/// Files of one agent's history looked at in one look, newest first.
pub const HISTORY_FILES: usize = 5_000;
/// Longest one agent's history is read in one look.
pub const HISTORY_TIME: Duration = Duration::from_secs(3);
/// Most bytes of one session file read, from its start, until the folder
/// it was started in is found (the owner's: 99 of 100 within 11 KiB, all
/// within 80 KiB).
pub const HISTORY_BYTES: usize = 128 << 10;
/// Most entries of a folder to look in, or of a folder in it, listed: one
/// with more is no folder of projects.
pub const ENTRIES: usize = 2_000;
/// Most cards kept.
pub const CARDS: usize = 5_000;
/// Most bytes of a package file read.
pub const PACKAGE_BYTES: usize = 8 << 10;
/// Most bytes of a README read.
pub const README_BYTES: usize = 2 << 10;
/// Most characters of a line about a project kept.
pub const ABOUT: usize = 240;
/// Most bytes of `.git/config` read, for the remote's address.
pub const CONFIG_BYTES: usize = 8 << 10;
/// Most names the person gives one project.
pub const NAMES: usize = 8;

/// What marks a project's top, beside `.git`: package files, and the
/// endings of project files of Xcode and Visual Studio.
const PACKAGES: &[&str] = &[
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "go.mod",
    "Package.swift",
    "Gemfile",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "composer.json",
    "pubspec.yaml",
    "deno.json",
    "mix.exs",
    "CMakeLists.txt",
];
const PROJECT_FILES: &[&str] = &[".xcodeproj", ".sln"];
/// What an agent leaves in a folder it works in.
const SIGNS: &[&str] = &[
    ".claude",
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    ".cursor",
    ".opencode",
    ".github/copilot-instructions.md",
];
/// Folders a look never lists, wherever they are.
const SKIP: &[&str] = &["node_modules", "target", "vendor", "dist", "build"];
/// Folders of the home folder that are never projects by themselves.
const PLAIN: &[&str] = &[
    "Desktop",
    "Documents",
    "Downloads",
    "Movies",
    "Music",
    "Pictures",
    "Public",
    "OneDrive",
];
/// Folders of the home folder nothing inside of which is a project.
const SYSTEM: &[&str] = &["Library", "Applications", "AppData"];
/// Where people keep projects, asked for when no agent's history says.
const USUAL: &[&str] = &[
    "projects",
    "Projects",
    "code",
    "Code",
    "Developer",
    "src",
    "dev",
    "repos",
    "git",
    "work",
    "source/repos",
];

// ——— What an agent's history says ———

/// One folder an agent was started in, as its history says, and when the
/// session last wrote: milliseconds since the Unix epoch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Worked {
    pub folder: PathBuf,
    pub when: u64,
}

/// The limits one history is read within: a deadline and a number of files.
pub struct Within {
    until: Instant,
    files: usize,
}

impl Within {
    pub fn new(time: Duration, files: usize) -> Within {
        Within {
            until: Instant::now() + time,
            files,
        }
    }

    /// Whether one more file may be read, counting it.
    pub fn more(&mut self) -> bool {
        if self.files == 0 || Instant::now() >= self.until {
            return false;
        }
        self.files -= 1;
        true
    }
}

/// An agent's own record of where it was started, as its adapter reads it
/// (`Agent::history`). The shapes are the tools' application data, not
/// interfaces: a file that does not read as expected gives nothing.
pub trait History: Sync {
    /// The folder the history is in, found by `stat` alone when Tasktap
    /// offers to read it.
    fn folder(&self, home: &Path) -> PathBuf;
    /// Where the person worked with the agent and when; nothing else.
    fn read(&self, home: &Path, within: &mut Within) -> Result<Vec<Worked>, String>;
}

/// The value of the first JSON string field `key` in `bytes`, decoded;
/// none when it is not there whole.
pub fn field(bytes: &[u8], key: &str) -> Option<String> {
    let needle = format!("\"{key}\":");
    let mut from = 0;
    while let Some(at) = position(&bytes[from..], needle.as_bytes()) {
        let mut start = from + at + needle.len();
        while bytes.get(start).is_some_and(|b| *b == b' ') {
            start += 1;
        }
        from = start;
        if bytes.get(start) != Some(&b'"') {
            continue;
        }
        let mut end = start + 1;
        while let Some(&b) = bytes.get(end) {
            match b {
                b'\\' => end += 2,
                b'"' => return serde_json::from_slice(&bytes[start..=end]).ok(),
                _ => end += 1,
            }
        }
        return None;
    }
    None
}

fn position(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Reads `path` from its start, 16 KiB at a time, until `found` finds what
/// it looks for in what was read or `most` bytes were read. Only a regular
/// file is read: a FIFO, a device or a socket, under any name, is not even
/// waited on (it is opened without waiting, and left when it is no file).
pub fn head<T>(path: &Path, most: usize, found: impl Fn(&[u8]) -> Option<T>) -> Option<T> {
    if !std::fs::metadata(path).ok()?.is_file() {
        return None;
    }
    let mut open = std::fs::File::options();
    open.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut open, NONBLOCK);
    let mut file = open.open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    loop {
        let start = bytes.len();
        let want = (16 << 10).min(most - start);
        bytes.resize(start + want, 0);
        let mut got = 0;
        while got < want {
            match file.read(&mut bytes[start + got..]) {
                Ok(0) => break,
                Ok(n) => got += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => return None,
            }
        }
        bytes.truncate(start + got);
        if let Some(t) = found(&bytes) {
            return Some(t);
        }
        if got < want || bytes.len() >= most {
            return None;
        }
    }
}

/// `O_NONBLOCK`: opening a FIFO does not wait for a writer.
#[cfg(target_os = "linux")]
const NONBLOCK: i32 = 0o4000;
#[cfg(all(unix, not(target_os = "linux")))]
const NONBLOCK: i32 = 0x0004;

/// When a file or folder last changed: milliseconds since the Unix epoch.
pub fn modified(meta: &std::fs::Metadata) -> u64 {
    let at = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok());
    at.map_or(0, |d| d.as_millis() as u64)
}

/// The person's home folder.
pub fn home() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let home = PathBuf::from(home);
    Some(std::fs::canonicalize(&home).map_or(home, crate::terminal::folder))
}

/// The agents whose history Tasktap can read, in the core's order.
fn histories() -> Vec<(&'static str, &'static str, &'static dyn History)> {
    let all = crate::agents::all();
    let read = all
        .iter()
        .filter_map(|a| Some((a.id(), a.name(), a.history()?)));
    read.collect()
}

// ——— The root rule ———

/// What the root rule makes of a folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Never a project by itself.
    Never,
    /// Not there.
    Gone,
    /// A worktree or a submodule of the repository at that top: work in it
    /// is work in that repository.
    Copy(PathBuf),
    /// Inside the project at that top.
    Inside(PathBuf),
    /// The top of a project, and what marks it.
    Top {
        git: bool,
        package: bool,
        signs: bool,
    },
    /// No mark at all.
    Bare,
}

/// The root rule, for one person's home and Tasktap's data folder.
#[derive(Clone, Debug)]
pub struct Rule {
    home: PathBuf,
    data: PathBuf,
    temp: Vec<PathBuf>,
    volumes: Vec<(PathBuf, usize)>,
}

impl Rule {
    pub fn new(home: &Path, data: &Path) -> Rule {
        let real =
            |p: &Path| std::fs::canonicalize(p).map_or(p.to_owned(), crate::terminal::folder);
        let mut temp: Vec<PathBuf> = [
            "/tmp",
            "/private/tmp",
            "/var/folders",
            "/private/var/folders",
        ]
        .iter()
        .map(PathBuf::from)
        .collect();
        temp.push(real(&std::env::temp_dir()));
        Rule {
            home: real(home),
            data: real(data),
            temp,
            volumes: volumes(),
        }
    }

    /// The rule with other volumes at these roots, each with how many
    /// folders down a volume's root is, and no folder temporary: for a
    /// check, whose volumes are folders it made.
    pub fn with_volumes(mut self, roots: &[(&Path, usize)]) -> Rule {
        self.temp.clear();
        self.volumes = roots.iter().map(|(p, d)| (p.to_path_buf(), *d)).collect();
        self
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    /// Whether a folder can never be a project by itself, whatever is in
    /// it or was done there.
    pub fn never(&self, folder: &Path) -> bool {
        if folder.starts_with(&self.data) {
            return true;
        }
        let named = |part: &OsStr, list: &[&str]| list.iter().any(|n| OsStr::new(n) == part);
        let hidden = |p: &OsStr| p.to_string_lossy().starts_with('.');
        let Ok(rest) = folder.strip_prefix(&self.home) else {
            // On another volume the same rules hold below its root.
            if self.temp.iter().any(|t| folder.starts_with(t)) {
                return true;
            }
            let Some(below) = on_volume(folder, &self.volumes) else {
                return true;
            };
            return below.iter().any(|p| hidden(p) || named(p, SKIP));
        };
        let parts: Vec<&OsStr> = rest.iter().collect();
        match parts.as_slice() {
            [] => return true,
            [one] if named(one, PLAIN) || named(one, SYSTEM) => return true,
            [first, ..] if named(first, SYSTEM) => return true,
            _ => {}
        }
        // Another tool's: a hidden folder on the way, unless the folder is
        // one directly in the home folder (`~/.dotfiles`) or in `~/.config`.
        parts.iter().enumerate().any(|(i, part)| {
            let own = i == 0 && (parts.len() == 1 || (*part == ".config" && parts.len() == 2));
            (hidden(part) && !own) || named(part, SKIP)
        })
    }

    /// What the root rule makes of `folder`, a canonical path. Each mark is
    /// a `stat` or a name of one listing of the folder; above it only
    /// `.git` and package files are looked for, up to the home folder.
    pub fn kind(&self, folder: &Path) -> Kind {
        if !folder.is_dir() {
            return Kind::Gone;
        }
        // A `.git` file: a worktree or a submodule counts for its repository;
        // a git folder kept elsewhere (`--separate-git-dir`, `gitdir: ./.bare`)
        // leaves this folder the repository's top.
        let is_git = match git_link(folder) {
            Some(GitLink::Of(top)) if self.never(&top) => return Kind::Never,
            Some(GitLink::Of(top)) => return Kind::Copy(top),
            Some(GitLink::Own) => true,
            None => false,
        };
        // In a worktree or a submodule, however deep: its repository's.
        if !is_git && let Some(GitLink::Of(top)) = self.above(folder) {
            return match self.never(&top) {
                true => Kind::Never,
                false => Kind::Copy(top),
            };
        }
        if self.never(folder) {
            return Kind::Never;
        }
        if !is_git && let Some(top) = self.inside(folder) {
            return Kind::Inside(top);
        }
        let names = top_names(folder);
        let package = marked(&names);
        let signs = SIGNS.iter().any(|s| match s.split_once('/') {
            Some(_) => folder.join(s).is_file(),
            None => names.contains(*s),
        });
        match (is_git, package, signs) {
            (false, false, false) => Kind::Bare,
            (git, package, signs) => Kind::Top {
                git,
                package,
                signs,
            },
        }
    }

    /// What the nearest `.git` above a folder says: whether the folder lies
    /// in a worktree or a submodule of another repository (one kept in a
    /// hidden folder too: an agent's worktree). Up to the home folder, or to
    /// the volume's root.
    fn above(&self, folder: &Path) -> Option<GitLink> {
        let mut at = folder.parent()?;
        while at != self.home {
            if at.join(".git").exists() {
                return Some(git_link(at).unwrap_or(GitLink::Own));
            }
            at = at.parent()?;
        }
        None
    }

    /// The project a folder is inside: the nearest folder above it with
    /// `.git`, else the outermost with a package file (a package in a
    /// workspace of packages is the workspace's); below the home folder, or
    /// below a volume's root outside it (the rule holds on every volume).
    fn inside(&self, folder: &Path) -> Option<PathBuf> {
        let package = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod"];
        let mut top = None;
        let mut at = folder.parent();
        while let Some(here) = at.filter(|a| !self.never(a)) {
            if here.join(".git").exists() {
                return Some(here.to_owned());
            }
            if package.iter().any(|p| here.join(p).is_file()) {
                top = Some(here.to_owned());
            }
            at = here.parent();
        }
        top
    }
}

/// Where a folder's `.git` leads, when it has one.
#[derive(Clone, Debug, PartialEq, Eq)]
enum GitLink {
    /// The folder is a repository's top: its `.git` is a folder, or names a
    /// git folder kept elsewhere for this folder alone.
    Own,
    /// A worktree or a submodule of the repository at that top.
    Of(PathBuf),
}

/// What a folder's `.git` says, by `stat` and at most two small reads.
fn git_link(folder: &Path) -> Option<GitLink> {
    let git = folder.join(".git");
    let meta = std::fs::symlink_metadata(&git).ok()?;
    if meta.is_dir() {
        return Some(GitLink::Own);
    }
    let gitdir = gitdir(&git)?;
    // A worktree's git folder names the repository's own in `commondir`.
    if let Some(common) = small(&gitdir.join("commondir")) {
        let common = canonical(&gitdir.join(common.trim()));
        return Some(match top_of(&common) {
            Some(top) if top != folder => GitLink::Of(top),
            // A bare repository's worktree with no folder of the repository's
            // own: each worktree is a top, and their first commit folds them.
            _ => GitLink::Own,
        });
    }
    // A submodule's git folder is in its superproject's `.git/modules`.
    let parts: Vec<_> = gitdir.iter().collect();
    if let Some(at) = parts
        .windows(2)
        .position(|w| w[0] == ".git" && w[1] == "modules")
    {
        let top: PathBuf = parts[..at].iter().collect();
        return top.is_dir().then_some(GitLink::Of(top));
    }
    // `--separate-git-dir`, or `gitdir: ./.bare`: this folder is the top.
    Some(GitLink::Own)
}

/// The git folder a `.git` file names, canonical.
fn gitdir(file: &Path) -> Option<PathBuf> {
    let text = small(file)?;
    let to = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    let to = canonical(&file.parent()?.join(to));
    to.is_dir().then_some(to)
}

/// The first KiB of a small file of git's, as text.
fn small(file: &Path) -> Option<String> {
    let text = head(file, 1 << 10, |b| Some(b.to_vec()))?;
    String::from_utf8(text).ok()
}

/// The working folder of a repository's own git folder: the folder `.git`
/// is in; for a bare repository, the folder beside it whose `.git` names it
/// (`proj/.bare` with `proj/.git`), else none.
fn top_of(common: &Path) -> Option<PathBuf> {
    let parent = common.parent()?;
    if common.file_name().is_some_and(|n| n == ".git") {
        return Some(parent.to_owned());
    }
    let pointer = parent.join(".git");
    (pointer.is_file() && gitdir(&pointer).as_deref() == Some(common)).then(|| parent.to_owned())
}

/// The git folder whose `config` holds a repository's remotes: `.git`, or
/// the repository's own that a worktree's or a kept-elsewhere `.git` names.
fn config_of(folder: &Path) -> Option<PathBuf> {
    let git = folder.join(".git");
    if git.is_dir() {
        return Some(git.join("config"));
    }
    let gitdir = gitdir(&git)?;
    let common = match small(&gitdir.join("commondir")) {
        Some(common) => canonical(&gitdir.join(common.trim())),
        None => gitdir,
    };
    Some(common.join("config"))
}

/// Where other volumes are, and how many folders down a volume's root is:
/// `/Volumes/<volume>`, `/mnt/<volume>`, `/media/<person>/<volume>`.
#[cfg(unix)]
fn volumes() -> Vec<(PathBuf, usize)> {
    [("/Volumes", 1), ("/mnt", 1), ("/media", 2)]
        .into_iter()
        .map(|(p, d)| (PathBuf::from(p), d))
        .collect()
}

#[cfg(windows)]
fn volumes() -> Vec<(PathBuf, usize)> {
    Vec::new()
}

/// The part of a folder outside the home folder below the volume it is on,
/// when it is on another volume and not its root. None: the system's,
/// another person's, a volume's root, or no volume.
#[cfg(unix)]
fn on_volume<'a>(folder: &'a Path, volumes: &[(PathBuf, usize)]) -> Option<&'a Path> {
    volumes.iter().find_map(|(root, depth)| {
        let mut parts = folder.strip_prefix(root).ok()?.components();
        for _ in 0..*depth {
            parts.next()?;
        }
        let below = parts.as_path();
        (!below.as_os_str().is_empty()).then_some(below)
    })
}

/// On Windows, a drive's `X:\…`, but not the system's folders or the
/// people's (`X:\Users`).
#[cfg(windows)]
fn on_volume<'a>(folder: &'a Path, volumes: &[(PathBuf, usize)]) -> Option<&'a Path> {
    let text = folder.to_string_lossy().to_lowercase().replace('/', "\\");
    let system = ["\\windows", "\\program files", "\\programdata", "\\users"];
    let rest = text.get(2..).unwrap_or_default();
    if system.iter().any(|s| rest.starts_with(s)) {
        return None;
    }
    if let Some(below) = volumes
        .iter()
        .find_map(|(root, _)| folder.strip_prefix(root).ok())
    {
        return (!below.as_os_str().is_empty()).then_some(below);
    }
    let mut parts = folder.components();
    parts.next()?;
    parts.next()?;
    let below = parts.as_path();
    (!below.as_os_str().is_empty()).then_some(below)
}

/// The names at a folder's top: one listing, nothing opened.
fn top_names(folder: &Path) -> BTreeSet<String> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return BTreeSet::new();
    };
    let names = entries.take(ENTRIES).filter_map(|e| e.ok());
    names
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect()
}

/// Whether names at a folder's top mark a project.
fn marked(names: &BTreeSet<String>) -> bool {
    PACKAGES.iter().any(|p| names.contains(*p))
        || names
            .iter()
            .any(|n| PROJECT_FILES.iter().any(|e| n.ends_with(e)))
}

// ——— What a project's files say ———

/// What a card says that its folder's files give.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Facts {
    /// Names its package file gives it.
    pub names: Vec<String>,
    pub about: String,
    pub about_from: Option<String>,
    /// The remote's address, without user or password.
    pub remote: Option<String>,
}

/// Reads what a card says from a project's top, within the bounds above.
pub fn facts(folder: &Path, git: bool) -> Facts {
    let names = top_names(folder);
    let mut facts = Facts::default();
    let file = |n: &str| names.contains(n).then(|| folder.join(n));
    for (name, read) in [
        (
            "package.json",
            json_package as fn(&[u8]) -> (Option<String>, Option<String>),
        ),
        ("Cargo.toml", toml_package),
        ("pyproject.toml", toml_package),
        ("composer.json", json_package),
        ("pubspec.yaml", yaml_package),
        ("deno.json", json_package),
    ] {
        let Some(path) = file(name) else { continue };
        let Some(bytes) = head(&path, PACKAGE_BYTES, |b| Some(b.to_vec())) else {
            continue;
        };
        let (named, about) = read(&bytes);
        let named = named.map(|n| plain_name(&n));
        if let Some(named) = named.filter(|n| !n.is_empty() && !facts.names.contains(n)) {
            facts.names.push(named);
        }
        if let Some(about) = about.map(|a| line(&a)).filter(|a| !a.is_empty())
            && facts.about.is_empty()
        {
            facts.about = about;
            facts.about_from = Some(name.into());
        }
    }
    if facts.about.is_empty() {
        let readme = [
            "README.md",
            "readme.md",
            "Readme.md",
            "README",
            "README.rst",
            "README.txt",
        ];
        if let Some(name) = readme.iter().find(|n| names.contains(**n))
            && let Some(bytes) = head(&folder.join(name), README_BYTES, |b| Some(b.to_vec()))
        {
            let about = readme_line(&String::from_utf8_lossy(&bytes), folder);
            if !about.is_empty() {
                facts.about = about;
                facts.about_from = Some((*name).into());
            }
        }
    }
    if git && let Some(config) = config_of(folder) {
        facts.remote = head(&config, CONFIG_BYTES, |b| Some(b.to_vec()))
            .and_then(|b| remote(&String::from_utf8_lossy(&b)));
    }
    facts
}

/// A package's name as a person would say it: without an npm scope.
fn plain_name(name: &str) -> String {
    let name = name.rsplit('/').next().unwrap_or(name).trim();
    name.chars().take(100).collect()
}

/// The name and description of a JSON package file.
fn json_package(bytes: &[u8]) -> (Option<String>, Option<String>) {
    (field(bytes, "name"), field(bytes, "description"))
}

/// The name and description of a TOML package file: the first of each,
/// one line each, as `[package]` and `[project]` write them.
fn toml_package(bytes: &[u8]) -> (Option<String>, Option<String>) {
    let text = String::from_utf8_lossy(bytes);
    let value = |key: &str| {
        text.lines().find_map(|l| {
            let (k, v) = l.split_once('=')?;
            let v = v.trim();
            (k.trim() == key && v.starts_with('"')).then(|| v.trim_matches('"').to_owned())
        })
    };
    (value("name"), value("description"))
}

/// The name and description of a YAML package file, at its top level.
fn yaml_package(bytes: &[u8]) -> (Option<String>, Option<String>) {
    let text = String::from_utf8_lossy(bytes);
    let value = |key: &str| {
        let line = text
            .lines()
            .find_map(|l| l.strip_prefix(key)?.strip_prefix(':'))?;
        Some(line.trim().trim_matches(['"', '\'']).to_owned()).filter(|v| !v.is_empty())
    };
    (value("name"), value("description"))
}

/// A line about a project: one line, plain words, at most [`ABOUT`]
/// characters, cut at a word.
fn line(text: &str) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= ABOUT {
        return text;
    }
    let cut: String = text.chars().take(ABOUT - 1).collect();
    let cut = cut.rsplit_once(' ').map_or(cut.as_str(), |(head, _)| head);
    format!("{}…", cut.trim_end_matches([',', ';', ':', '.']))
}

/// The first paragraph of a README in plain words: past headings, badges,
/// pictures, markup and code; the first heading when there is no paragraph
/// and it says more than the folder's name.
fn readme_line(text: &str, folder: &Path) -> String {
    let mut heading = String::new();
    let mut paragraph: Vec<&str> = Vec::new();
    let mut code = false;
    for l in text.lines() {
        let t = l.trim();
        if t.starts_with("```") || t.starts_with("~~~") {
            code = !code;
            continue;
        }
        let markup = t.starts_with('<')
            || t.starts_with("![")
            || t.starts_with("[![")
            || t.starts_with("---")
            || t.starts_with("===")
            || t.starts_with('|')
            || t.starts_with("[!")
            || t.starts_with("..");
        if code || markup {
            if !paragraph.is_empty() {
                break;
            }
            continue;
        }
        if let Some(h) = t.strip_prefix('#') {
            if !paragraph.is_empty() {
                break;
            }
            if heading.is_empty() {
                heading = h.trim_start_matches('#').trim().to_owned();
            }
            continue;
        }
        if t.is_empty() {
            if !paragraph.is_empty() {
                break;
            }
            continue;
        }
        paragraph.push(t);
    }
    let words = match paragraph.is_empty() {
        false => paragraph.join(" "),
        true => {
            let name = folder
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase());
            match Some(heading.to_lowercase()) == name {
                true => String::new(),
                false => heading,
            }
        }
    };
    line(&unmark(&words))
}

/// Markdown links as their words, and emphasis and code marks taken out.
fn unmark(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after
            .find("](")
            .and_then(|mid| Some((mid, after[mid..].find(')')? + mid)))
        {
            Some((mid, close)) => {
                out.push_str(&after[..mid]);
                rest = &after[close + 1..];
            }
            None => {
                out.push('[');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out.replace("**", "").replace("__", "").replace('`', "")
}

/// The address of a repository's remote (`origin`, else the first), as
/// `host/path`: without scheme, user, password, port or `.git`, lowercase.
/// None for a remote that is a folder of this machine: such a clone is
/// known by its first commit, as the repository it was made from is.
pub fn remote(config: &str) -> Option<String> {
    let mut section = None;
    let mut urls: Vec<(String, String)> = Vec::new();
    for l in config.lines() {
        let t = l.trim();
        if let Some(rest) = t.strip_prefix("[remote \"") {
            section = rest.strip_suffix("\"]").map(str::to_owned);
            continue;
        }
        if t.starts_with('[') {
            section = None;
            continue;
        }
        if let (Some(s), Some((k, v))) = (&section, t.split_once('='))
            && k.trim() == "url"
            && !urls.iter().any(|(n, _)| n == s)
        {
            urls.push((s.clone(), v.trim().to_owned()));
        }
    }
    let url = (urls.iter().find(|(n, _)| n == "origin").or(urls.first()))?
        .1
        .clone();
    address(&url)
}

/// A remote's address as [`remote`] keeps it.
pub fn address(url: &str) -> Option<String> {
    let local = url.starts_with('/')
        || url.starts_with('.')
        || url.starts_with('~')
        || url.starts_with("file:")
        || url.get(1..3) == Some(":\\");
    if local || url.is_empty() {
        return None;
    }
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    // `user:password@host` and `git@host` alike.
    let (host, path) = match rest.split_once('/') {
        Some((host, path)) if url.contains("://") => (host, path.to_owned()),
        _ => {
            let (host, path) = rest.split_once(':')?;
            (host, path.to_owned())
        }
    };
    let host = host.rsplit('@').next()?;
    let host = host.split(':').next()?;
    let path = path
        .trim_matches('/')
        .trim_end_matches(".git")
        .trim_matches('/');
    match host.is_empty() || path.is_empty() {
        true => None,
        false => Some(format!("{host}/{path}").to_lowercase()),
    }
}

// ——— Looking ———

/// What a look is given, read on the core's thread.
pub struct Input {
    pub rule: Rule,
    pub data: PathBuf,
    pub looks: Vec<Look>,
    /// Every workspace that is a folder: its id, its folder, and when a
    /// thought last started there.
    pub opened: Vec<(ProjectId, String, Option<Time>)>,
    /// The cards there are: their folders and the repository each is,
    /// which is not asked of git again.
    pub known: BTreeMap<String, Option<String>>,
}

/// What a look found, made on a thread of its own.
#[derive(Debug, Default)]
pub struct Output {
    pub looks: Vec<(LookId, LookState, u32, Option<String>)>,
    pub cards: Vec<Made>,
    /// Folders of known cards that are not there now.
    pub gone: Vec<String>,
    /// Folders the looks read now would have found but the root rule refused.
    pub refused: usize,
}

/// One card as a look made it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Made {
    pub folder: String,
    pub name: String,
    pub facts: Facts,
    pub why: Vec<Evidence>,
    pub agents: Vec<String>,
    pub used: Option<u64>,
    pub looks: Vec<LookId>,
    pub inside: Option<String>,
    pub repo: Option<String>,
    pub project: Option<ProjectId>,
}

#[derive(Default)]
struct Seen {
    why: BTreeSet<u8>,
    agents: BTreeSet<String>,
    used: u64,
    looks: BTreeSet<LookId>,
    inside: Option<PathBuf>,
    project: Option<ProjectId>,
    git: bool,
}

fn rank(e: Evidence) -> u8 {
    Evidence::ALL.iter().position(|x| *x == e).unwrap_or(0) as u8
}

impl Seen {
    fn add(&mut self, e: Evidence) {
        self.why.insert(rank(e));
    }
}

/// Reads every look that is on and makes the cards: on a thread of its own.
pub fn read(input: Input) -> Output {
    let Input {
        rule,
        data,
        looks,
        opened,
        known,
    } = input;
    let mut seen: BTreeMap<PathBuf, Seen> = BTreeMap::new();
    let mut out = Output::default();
    let mark = |seen: &mut BTreeMap<PathBuf, Seen>, folder: &Path, kind: &Kind| {
        if let Kind::Top {
            git,
            package,
            signs,
        } = kind
        {
            let s = seen.entry(folder.to_owned()).or_default();
            s.git |= git;
            for (on, e) in [
                (git, Evidence::Git),
                (package, Evidence::Package),
                (signs, Evidence::Signs),
            ] {
                if *on {
                    s.add(e);
                }
            }
        }
    };
    for look in looks.iter().filter(|l| l.on) {
        let mut found: BTreeSet<PathBuf> = BTreeSet::new();
        let (state, note) = match (look.kind, &look.agent, &look.folder) {
            (LookKind::Agent, Some(agent), _) => {
                let history = histories().into_iter().find(|(id, ..)| id == agent);
                let Some((id, _, history)) = history else {
                    out.looks.push((
                        look.id,
                        LookState::Failed,
                        0,
                        Some(format!("Tasktap has no agent {agent}")),
                    ));
                    continue;
                };
                if !history.folder(rule.home()).is_dir() {
                    out.looks.push((look.id, LookState::Gone, 0, None));
                    continue;
                }
                let mut within = Within::new(HISTORY_TIME, HISTORY_FILES);
                match history.read(rule.home(), &mut within) {
                    Err(why) => (LookState::Failed, Some(why)),
                    Ok(worked) => {
                        for w in worked {
                            let folder = canonical(&w.folder);
                            let kind = rule.kind(&folder);
                            let (top, inside) = match &kind {
                                Kind::Never | Kind::Gone => {
                                    out.refused += 1;
                                    continue;
                                }
                                Kind::Copy(top) => (top.clone(), None),
                                Kind::Inside(top) => (top.clone(), Some(folder.clone())),
                                Kind::Top { .. } | Kind::Bare => (folder.clone(), None),
                            };
                            let tops = std::iter::once(&top).chain(inside.as_ref());
                            for at in tops {
                                let s = seen.entry(at.clone()).or_default();
                                s.add(Evidence::Agent);
                                s.agents.insert(id.to_owned());
                                s.used = s.used.max(w.when);
                                s.looks.insert(look.id);
                            }
                            if let Some(inside) = &inside {
                                seen.entry(inside.clone()).or_default().inside = Some(top.clone());
                            }
                            match &kind {
                                Kind::Copy(_) | Kind::Inside(_) => {
                                    let top_kind = rule.kind(&top);
                                    mark(&mut seen, &top, &top_kind);
                                }
                                k => mark(&mut seen, &folder, k),
                            }
                            found.insert(top);
                        }
                        (LookState::Ready, None)
                    }
                }
            }
            (LookKind::Folder, _, Some(folder)) => {
                let folder = PathBuf::from(folder);
                match list(&rule, &folder) {
                    Err(state) => (state, None),
                    Ok(tops) => {
                        for (top, kind) in tops {
                            mark(&mut seen, &top, &kind);
                            seen.entry(top.clone()).or_default().looks.insert(look.id);
                            found.insert(top);
                        }
                        (LookState::Ready, None)
                    }
                }
            }
            _ => (
                LookState::Failed,
                Some("it names nothing to look at".into()),
            ),
        };
        out.looks.push((look.id, state, found.len() as u32, note));
    }
    for (project, folder, used) in &opened {
        let s = seen.entry(PathBuf::from(folder)).or_default();
        s.add(Evidence::Opened);
        s.project = Some(*project);
        s.used = s.used.max(used.map_or(0, u64::from));
        if !s.git && git_link(Path::new(folder)).is_some() {
            s.git = true;
            s.add(Evidence::Git);
        }
    }
    // The newest first, so that a bound keeps what is alive.
    let mut seen: Vec<(PathBuf, Seen)> = seen.into_iter().collect();
    seen.sort_by(|a, b| b.1.used.cmp(&a.1.used).then_with(|| a.0.cmp(&b.0)));
    seen.truncate(CARDS);
    let git = crate::isolate::Git::new(&data, Vec::new()).ok();
    for (folder, s) in seen {
        let Some(text) = folder.to_str().map(str::to_owned) else {
            continue;
        };
        if json_len(&text) > MAX_LINE {
            continue;
        }
        let facts = facts(&folder, s.git);
        let repo = match (&facts.remote, s.git) {
            (Some(remote), _) => Some(format!("remote {remote}")),
            (None, true) => match known.get(&text).cloned().flatten() {
                Some(root) if root.starts_with("root ") => Some(root),
                _ => git
                    .as_ref()
                    .and_then(|g| g.root(&folder).ok())
                    .map(|r| format!("root {r}")),
            },
            (None, false) => None,
        };
        let name = folder
            .file_name()
            .map_or(text.clone(), |n| n.to_string_lossy().into_owned());
        let why = s.why.iter().map(|r| Evidence::ALL[*r as usize]).collect();
        out.cards.push(Made {
            name,
            folder: text,
            facts,
            why,
            agents: s.agents.into_iter().collect(),
            used: (s.used > 0).then_some(s.used),
            looks: s.looks.into_iter().collect(),
            inside: s.inside.and_then(|p| p.to_str().map(str::to_owned)),
            repo,
            project: s.project,
        });
    }
    let made: BTreeSet<&str> = out.cards.iter().map(|m| m.folder.as_str()).collect();
    out.gone = (known.keys())
        .filter(|f| !made.contains(f.as_str()) && !Path::new(f).is_dir())
        .cloned()
        .collect();
    out
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).map_or(path.to_owned(), crate::terminal::folder)
}

/// The projects in a folder to look in: directly inside it, and one level
/// into a folder there that is no project.
fn list(rule: &Rule, folder: &Path) -> Result<Vec<(PathBuf, Kind)>, LookState> {
    if !folder.is_dir() {
        return Err(LookState::Gone);
    }
    let entries = |at: &Path| -> Result<Vec<PathBuf>, LookState> {
        let read = std::fs::read_dir(at).map_err(|_| LookState::Failed)?;
        let mut all = Vec::new();
        for e in read.filter_map(|e| e.ok()) {
            if all.len() == ENTRIES {
                return Err(LookState::Many);
            }
            let name = e.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || SKIP.contains(&name.as_ref()) {
                continue;
            }
            // A link is followed once: its card is the real folder's.
            let path = e.path();
            if path.is_dir() {
                all.push(canonical(&path));
            }
        }
        Ok(all)
    };
    let mut found = Vec::new();
    for entry in entries(folder)? {
        match rule.kind(&entry) {
            k @ Kind::Top { .. } => found.push((entry, k)),
            Kind::Bare => {
                for inner in entries(&entry).unwrap_or_default() {
                    if let k @ Kind::Top { .. } = rule.kind(&inner) {
                        found.push((inner, k));
                    }
                }
            }
            _ => {}
        }
    }
    Ok(found)
}

/// Writes what a look found: each card made again or anew, keeping what
/// the person gave it; the copies of one repository under the one taken as
/// the project. A card no look finds any more goes, unless it is a
/// workspace or the person gave it something.
pub fn merge(tx: &mut Tx, out: Output, read: &[LookId], now: Time) -> store::Result<u32> {
    let mut cards: BTreeMap<String, Card> = (tx.cards()?.into_iter())
        .map(|c| (c.folder.clone(), c))
        .collect();
    let mut made: BTreeSet<String> = BTreeSet::new();
    let mut inside: Vec<(String, String)> = Vec::new();
    for m in out.cards {
        made.insert(m.folder.clone());
        let fresh = || -> store::Result<Card> {
            Ok(Card {
                id: crate::state::fresh(now)?,
                rev: Rev::ZERO,
                folder: m.folder.clone(),
                name: String::new(),
                names: Vec::new(),
                about: String::new(),
                about_from: None,
                why: Vec::new(),
                agents: Vec::new(),
                repo: None,
                copy_of: None,
                inside: None,
                project_id: None,
                used: None,
                looks: Vec::new(),
                hidden: false,
                main: false,
                available: true,
            })
        };
        let mut c = match cards.remove(&m.folder) {
            Some(c) => c,
            None => fresh()?,
        };
        let before = c.clone();
        c.name = m.name;
        for n in m.facts.names {
            if n != c.name && !c.names.contains(&n) {
                c.names.push(n);
            }
        }
        c.about = m.facts.about;
        c.about_from = m.facts.about_from;
        c.why = m.why;
        c.agents = m.agents;
        c.repo = m.repo;
        c.used = match (c.used, m.used) {
            (Some(a), Some(b)) => Some(a.max(Time::new(b).unwrap_or(a))),
            (a, b) => a.or(b.and_then(Time::new)),
        };
        c.looks = m.looks;
        c.project_id = m.project.or(c.project_id);
        c.available = true;
        if let Some(top) = m.inside {
            inside.push((m.folder.clone(), top));
        }
        if c != before {
            tx.put_card(&c)?;
        }
        cards.insert(m.folder, c);
    }
    let gone: BTreeSet<&String> = out.gone.iter().collect();
    let mut forgotten = Vec::new();
    for (folder, c) in cards.iter_mut() {
        if made.contains(folder) {
            continue;
        }
        let before = c.clone();
        c.looks.retain(|l| !read.contains(l));
        c.available = !gone.contains(folder);
        let kept = c.project_id.is_some() || c.hidden || c.main || !c.looks.is_empty();
        if !kept && !tx.bound(c.id)? {
            tx.delete_card(c.id)?;
            forgotten.push(folder.clone());
        } else if *c != before {
            tx.put_card(c)?;
        }
    }
    for folder in forgotten {
        cards.remove(&folder);
    }
    let ids: BTreeMap<String, CardId> = cards.iter().map(|(f, c)| (f.clone(), c.id)).collect();
    for (folder, top) in inside {
        if let (Some(c), Some(top)) = (cards.get_mut(&folder), ids.get(&top))
            && c.inside != Some(*top)
        {
            c.inside = Some(*top);
            tx.put_card(c)?;
        }
    }
    copies(tx)?;
    for (id, state, found, note) in out.looks {
        if let Some(mut l) = tx.look(id)? {
            (l.state, l.found, l.note, l.looked) = (state, found, note, Some(now));
            tx.put_look(&l)?;
        }
    }
    let projects = tx.cards()?.iter().filter(|c| offered(c)).count();
    Ok(projects as u32)
}

/// Whether a card is a project of its own that placing may offer: not a
/// copy, not inside another, not hidden, there.
pub fn offered(c: &Card) -> bool {
    c.copy_of.is_none() && c.inside.is_none() && !c.hidden && c.available
}

/// Groups the copies of each repository under the one taken as the
/// project (the module's rule) and writes the cards that changed.
pub fn copies(tx: &mut Tx) -> store::Result<()> {
    let cards = tx.cards()?;
    let mut by_repo: BTreeMap<&str, Vec<&Card>> = BTreeMap::new();
    for c in cards.iter().filter(|c| !c.hidden) {
        if let Some(repo) = &c.repo {
            by_repo.entry(repo).or_default().push(c);
        }
    }
    let parent = |c: &Card| Path::new(&c.folder).parent().map(Path::to_owned);
    let mut wanted: BTreeMap<CardId, Option<CardId>> = BTreeMap::new();
    for group in by_repo.values() {
        // A folder of copies: its other folders are copies of the same repository.
        // In a folder of projects: beside another project, not only beside
        // copies of itself (a tool's folder of copies, `workspaces/<repo>/…`).
        let among_projects = |c: &Card| {
            let p = parent(c);
            cards
                .iter()
                .any(|o| o.id != c.id && parent(o) == p && o.repo != c.repo)
        };
        let main = group.iter().max_by(|a, b| {
            let key = |c: &Card| {
                (
                    c.main,
                    c.project_id.is_some(),
                    among_projects(c),
                    c.used,
                    std::cmp::Reverse(c.folder.len()),
                )
            };
            key(a).cmp(&key(b))
        });
        let Some(main) = main else { continue };
        for c in group {
            wanted.insert(c.id, (c.id != main.id).then_some(main.id));
        }
    }
    for mut c in cards {
        let want = wanted.get(&c.id).copied().flatten();
        if c.copy_of != want {
            c.copy_of = want;
            tx.put_card(&c)?;
        }
    }
    Ok(())
}

/// Forgets what only a look found, when it is removed or switched off.
pub fn unlook(tx: &mut Tx, look: LookId) -> store::Result<()> {
    for mut c in tx.cards()? {
        if !c.looks.contains(&look) {
            continue;
        }
        c.looks.retain(|l| *l != look);
        let kept = c.project_id.is_some() || c.hidden || c.main || !c.looks.is_empty();
        if kept || tx.bound(c.id)? {
            tx.put_card(&c)?;
        } else {
            tx.delete_card(c.id)?;
        }
    }
    copies(tx)
}

// ——— The core's side: when to look, and the calls ———

/// The core's state of looking: one look at a time, and the calls waiting
/// for it. In memory only; the modified times are those the last look saw.
#[derive(Default)]
pub struct Map {
    looking: bool,
    again: bool,
    waiting: Vec<(Rc<Link>, CallId)>,
    stamps: Option<Vec<u64>>,
}

impl Map {
    pub fn busy(&self) -> bool {
        self.looking
    }
}

/// Where to `stat` for the cheap check: each agent's history folder that
/// is on (and the newest folder in it, where an agent keeps dated folders),
/// and each folder to look in.
fn watched(rule: &Rule, looks: &[Look]) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for l in looks.iter().filter(|l| l.on) {
        match (&l.agent, &l.folder) {
            (Some(agent), _) => {
                if let Some((.., h)) = histories().into_iter().find(|(id, ..)| id == agent) {
                    paths.push(h.folder(rule.home()));
                }
            }
            (None, Some(folder)) => paths.push(PathBuf::from(folder)),
            _ => {}
        }
    }
    paths
}

/// The modified time of each path, and of the folders directly in it: a
/// session in a folder an agent already had, a project cloned into a
/// group folder. A few hundred `stat`s, under a millisecond.
fn stamps(paths: &[PathBuf]) -> Vec<u64> {
    let mut all = Vec::new();
    for p in paths {
        let Ok(meta) = std::fs::metadata(p) else {
            all.push(0);
            continue;
        };
        let mut newest = modified(&meta);
        if let Ok(entries) = std::fs::read_dir(p) {
            for e in entries.take(ENTRIES).filter_map(|e| e.ok()) {
                if let Some(m) = e.metadata().ok().filter(|m| m.is_dir()) {
                    newest = newest.max(modified(&m));
                }
            }
        }
        all.push(newest);
    }
    all
}

/// What a look is given, from the records.
fn input(core: &mut Core) -> Result<Input, Error> {
    let home =
        home().ok_or_else(|| Error::new(Code::Failed, "this system names no home folder"))?;
    let data = core.terminals.data().to_owned();
    effects::read(core, |tx| {
        let looks = tx.looks()?;
        let used = tx.last_started()?;
        let opened = (tx.projects()?.into_iter())
            .filter(|p| p.kind == ProjectKind::Folder)
            .map(|p| (p.id, p.folder, used.get(&p.id).copied()))
            .collect();
        let known = tx
            .cards()?
            .into_iter()
            .map(|c| (c.folder, c.repo))
            .collect();
        Ok(Input {
            rule: Rule::new(&home, &data),
            data: data.clone(),
            looks,
            opened,
            known,
        })
    })
}

/// Looks now, at every look that is on, unless a look runs already: then
/// once more after it. `link` and `id`, when given, are answered when done.
pub fn look(core: &mut Core, waiting: Option<(Rc<Link>, CallId)>) {
    core.map.waiting.extend(waiting);
    if core.map.looking {
        core.map.again = true;
        return;
    }
    let input = match input(core) {
        Ok(input) => input,
        Err(e) => return answer(core, Err(e)),
    };
    core.map.looking = true;
    let read: Vec<LookId> = input.looks.iter().filter(|l| l.on).map(|l| l.id).collect();
    let paths = watched(&input.rule, &input.looks);
    let started = Instant::now();
    crate::calls::aside(
        core,
        move || {
            let out = self::read(input);
            (out, stamps(&paths))
        },
        move |core, found| {
            core.map.looking = false;
            let Some((out, stamps)) = found else {
                let lost = Error::new(Code::Failed, "the look ended without an answer");
                return answer(core, Err(lost));
            };
            core.map.stamps = Some(stamps);
            let now = core.seams.now();
            let merged = effects::write(core, |tx| merge(tx, out, &read, now).map_err(stored));
            let ms = started.elapsed().as_millis().min(u32::MAX as u128) as u32;
            if std::mem::take(&mut core.map.again) {
                return look(core, None);
            }
            answer(core, merged.map(|projects| Looked { projects, ms }));
            core.events.notify_one();
        },
    );
}

fn answer(core: &mut Core, result: Result<Looked, Error>) {
    for (link, id) in std::mem::take(&mut core.map.waiting) {
        link.send(&call::ProjectsLook::reply(id, result.clone()));
    }
}

/// When a capture or the list needs what is kept: one `stat` of each
/// looked-at folder and of the folders directly in it, off the core's
/// thread, and a look when any changed since the last. Nothing when no
/// look is on.
pub fn freshen(core: &mut Core) {
    if core.map.looking {
        return;
    }
    let Some(home) = home() else { return };
    let rule = Rule::new(&home, core.terminals.data());
    let looks = effects::read(core, |tx| tx.looks()).unwrap_or_default();
    let paths = watched(&rule, &looks);
    if paths.is_empty() {
        return;
    }
    let was = core.map.stamps.clone();
    crate::calls::aside(
        core,
        move || stamps(&paths),
        move |core, now| {
            if now.is_some() && now != was {
                look(core, None);
            }
        },
    );
}

/// `projects.look`: every look that is on, read again; answered when done.
pub fn look_call(cx: &mut Cx, _: Empty) -> Option<Control> {
    look(cx.core, Some((cx.link.clone(), cx.id)));
    None
}

/// `look.add`: a folder to look in, or an agent's history, as a look,
/// read at once unless the person said not now.
pub fn add_look(cx: &mut Cx, args: AddLook) -> Option<Control> {
    let reply = |cx: &mut Cx, r| Some(call::LookAdd::reply(cx.id, r));
    let invalid = |why: String| Err(Error::new(Code::Invalid, why));
    let on = args.on.unwrap_or(true);
    let (kind, agent, folder) = match (&args.agent, &args.folder) {
        (Some(agent), None) => match histories().iter().any(|(id, ..)| id == agent) {
            true => (LookKind::Agent, Some(agent.clone()), None),
            false => {
                return reply(
                    cx,
                    invalid(format!("Tasktap does not read {agent}'s history")),
                );
            }
        },
        (None, Some(folder)) => {
            let Some(home) = home() else {
                return reply(cx, invalid("this system names no home folder".into()));
            };
            let rule = Rule::new(&home, cx.core.terminals.data());
            let path = canonical(Path::new(folder));
            let refused = !path.is_dir() || (rule.never(&path) && !named_plain(&rule, &path));
            if refused || !path.is_absolute() {
                let why = format!(
                    "{folder} is no folder Tasktap may look in: name one inside your home folder or on another volume"
                );
                return reply(cx, invalid(why));
            }
            match path.to_str() {
                Some(p) => (LookKind::Folder, None, Some(p.to_owned())),
                None => return reply(cx, invalid("the folder's path is not text".into())),
            }
        }
        _ => return reply(cx, invalid("a look names a folder or an agent".into())),
    };
    let written = effects::write(cx.core, |tx| {
        let same = tx.looks().map_err(stored)?.into_iter().find(|l| {
            (agent.is_some() && l.agent == agent) || (folder.is_some() && l.folder == folder)
        });
        let mut l = same.unwrap_or(Look {
            id: args.id,
            rev: Rev::ZERO,
            kind,
            agent: agent.clone(),
            folder: folder.clone(),
            on,
            state: LookState::New,
            found: 0,
            looked: None,
            note: None,
        });
        let was = l.on;
        l.on = on;
        tx.put_look(&l).map_err(stored)?;
        if was && !on {
            unlook(tx, l.id).map_err(stored)?;
        }
        Ok(l.id)
    });
    if written.is_ok() && on {
        look(cx.core, None);
    }
    reply(cx, written)
}

/// Desktop, Documents and the like may be named to look in, though none
/// is a project by itself.
fn named_plain(rule: &Rule, path: &Path) -> bool {
    let rest = path.strip_prefix(rule.home()).ok();
    let one: Vec<_> = rest.map(|r| r.iter().collect()).unwrap_or_default();
    matches!(one.as_slice(), [one] if PLAIN.iter().any(|n| OsStr::new(n) == *one))
}

/// `projects.offer`: the agents whose history is on this machine and the
/// folders a person may keep projects in, by `stat` alone: the usual ones
/// that exist, and those that hold several projects Tasktap knows.
pub fn offer(cx: &mut Cx, _: Empty) -> Option<Control> {
    let (id, link) = (cx.id, cx.link.clone());
    let reply = |r| Some(call::ProjectsOffer::reply(id, r));
    let Some(home) = home() else {
        return reply(Err(Error::new(
            Code::Failed,
            "this system names no home folder",
        )));
    };
    let cards = match effects::read(cx.core, |tx| Ok((tx.cards()?, tx.looks()?))) {
        Ok(found) => found,
        Err(e) => return reply(Err(e)),
    };
    crate::calls::aside(
        cx.core,
        move || offered_now(&home, &cards.0, &cards.1),
        move |_, found| {
            let lost = || Error::new(Code::Failed, "the look ended without an answer");
            link.send(&call::ProjectsOffer::reply(id, found.ok_or_else(lost)));
        },
    );
    None
}

/// What [`offer`] finds.
pub fn offered_now(home: &Path, cards: &[Card], looks: &[Look]) -> Offer {
    let agents = (histories().into_iter())
        .filter(|(_, _, h)| h.folder(home).is_dir())
        .map(|(id, name, _)| OfferedAgent {
            agent: id.into(),
            name: name.into(),
        })
        .collect();
    let looked: BTreeSet<&str> = looks.iter().filter_map(|l| l.folder.as_deref()).collect();
    let mut by_parent: BTreeMap<PathBuf, u32> = BTreeMap::new();
    for c in cards.iter().filter(|c| offered(c)) {
        if let Some(p) = Path::new(&c.folder).parent()
            && p != home
            && p.starts_with(home)
        {
            *by_parent.entry(p.to_owned()).or_default() += 1;
        }
    }
    let mut places: Vec<OfferedPlace> = (by_parent.iter())
        .filter(|(_, n)| **n >= 2)
        .filter_map(|(p, n)| {
            Some(OfferedPlace {
                folder: p.to_str()?.into(),
                projects: *n,
            })
        })
        .collect();
    for usual in USUAL {
        let p = canonical(&home.join(usual));
        if p.is_dir()
            && !by_parent.contains_key(&p)
            && let Some(folder) = p.to_str()
        {
            places.push(OfferedPlace {
                folder: folder.into(),
                projects: 0,
            });
        }
    }
    places.retain(|p| !looked.contains(p.folder.as_str()));
    places.sort_by(|a, b| {
        b.projects
            .cmp(&a.projects)
            .then_with(|| a.folder.cmp(&b.folder))
    });
    places.dedup_by(|a, b| a.folder == b.folder);
    places.truncate(6);
    Offer { agents, places }
}

/// `projects.find`: the projects a text names or points at, the likeliest
/// first; and a cheap check whether a look is due.
pub fn find(cx: &mut Cx, args: Find) -> Result<Finds, Error> {
    let limit = args.limit.unwrap_or(3).clamp(1, 8) as usize;
    let request = effects::read(cx.core, |tx| crate::route::request(tx, &args.text, None))?;
    let home = home();
    let shown = |folder: &str| match home
        .as_ref()
        .and_then(|h| Path::new(folder).strip_prefix(h).ok())
    {
        Some(rest) => format!("~/{}", rest.display()),
        None => folder.to_owned(),
    };
    let found = crate::route::ranked(&request, limit)
        .into_iter()
        .map(|(named, why)| Found {
            to: Place::from(named.to),
            name: named.name.clone(),
            folder: shown(&named.folder),
            why,
        })
        .collect();
    freshen(cx.core);
    Ok(Finds { found })
}
