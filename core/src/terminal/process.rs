//! A terminal's process (design §7, §9, §10): its pseudo-terminal, the
//! environment it gets, the plain threads that block on it so the core's
//! thread never does, and ending its process tree.
//!
//! Three threads per terminal sleep in the kernel until something happens:
//! one reads output, one waits for the child's exit, one writes input, since
//! a write blocks once a child stops reading. They report to the core's
//! thread through one bounded queue: a reader ahead of the core by
//! [`QUEUE`] chunks waits, and an idle terminal sends nothing, so the core
//! is not woken.

use crate::sys;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, SlavePty, native_pty_system};
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::mpsc as plain;
use tasktap_proto::{Secret, Size};
use tokio::sync::mpsc;

/// Reports a terminal's threads may have waiting for the core's thread
/// before the reader waits too (design §2).
pub const QUEUE: usize = 8;
/// Most bytes one read takes.
const READ: usize = 16 << 10;
/// None of the threads keeps a buffer on its stack.
const STACK: usize = 128 << 10;

/// What a terminal's threads tell the core's thread.
pub enum Report {
    /// The child runs.
    Started(Group),
    /// The child could not be started: why.
    Failed(String),
    Output(Vec<u8>),
    /// The output ended: nothing holds the terminal's other side any more.
    Closed,
    /// One chunk of input went to the process, or was dropped because it
    /// no longer takes any.
    Wrote,
    /// The child exited: its code, none when a signal ended it.
    Exited(Option<u32>),
}

/// What ends a terminal's process tree: on Unix the child's process group,
/// which it leads as the leader of its own session; on Windows a job.
#[cfg(unix)]
pub type Group = u32;
#[cfg(windows)]
pub type Group = sys::Job;

/// What a new terminal runs, and where.
pub struct Plan {
    /// Started directly; empty starts the person's login shell.
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, OsString)>,
    pub size: Size,
}

/// The core's side of a running terminal.
pub struct Process {
    master: Option<Box<dyn MasterPty + Send>>,
    group: Option<Rc<Group>>,
}

/// What [`Process::start`] hands over: the process, where its input goes
/// (to the input thread, which writes it in order), and its reports.
pub type Started = (Process, plain::Sender<Vec<u8>>, mpsc::Receiver<Report>);

/// What [`Process::hang_up`] asked to end, for the timer that kills it.
pub struct Doomed {
    #[cfg(unix)]
    groups: Vec<u32>,
    #[cfg(windows)]
    job: Rc<Group>,
}

impl Doomed {
    pub fn kill(self) {
        #[cfg(unix)]
        for group in self.groups {
            sys::signal_group(group, true);
        }
        #[cfg(windows)]
        self.job.kill();
    }
}

impl Process {
    /// Opens the pseudo-terminal and starts the threads. The reader thread
    /// starts the child, so that a folder on a stalled mount holds up no
    /// other terminal, and reports [`Report::Started`] or
    /// [`Report::Failed`] before any output.
    pub fn start(plan: Plan) -> io::Result<Started> {
        let size = PtySize {
            rows: plan.size.1,
            cols: plan.size.0,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = native_pty_system()
            .openpty(size)
            .map_err(io::Error::other)?;
        let reader = pair.master.try_clone_reader().map_err(io::Error::other)?;
        let writer = pair.master.take_writer().map_err(io::Error::other)?;
        let (tx, rx) = mpsc::channel(QUEUE);
        let (input, inputs) = plain::channel();
        let wrote = tx.clone();
        thread("terminal-input", move || write(writer, inputs, wrote))?;
        let slave = pair.slave;
        thread("terminal-output", move || read(slave, plan, reader, tx))?;
        let process = Process {
            master: Some(pair.master),
            group: None,
        };
        Ok((process, input, rx))
    }

    pub fn started(&mut self, group: Group) {
        self.group = Some(Rc::new(group));
    }

    pub fn resize(&self, size: Size) {
        if let Some(master) = &self.master {
            let size = PtySize {
                rows: size.1,
                cols: size.0,
                pixel_width: 0,
                pixel_height: 0,
            };
            // A terminal whose child has gone has nothing to tell.
            let _ = master.resize(size);
        }
    }

    /// Hangs up on the process group and the foreground group, or on
    /// Windows closes the console, which asks its processes to end. Returns
    /// what to kill if they have not ended by the deadline; nothing before
    /// the child has started.
    pub fn hang_up(&mut self) -> Option<Doomed> {
        let group = self.group.clone()?;
        #[cfg(unix)]
        {
            let mut groups = vec![*group];
            let foreground = self.master.as_ref().and_then(|m| m.process_group_leader());
            if let Some(fg) = foreground.and_then(|fg| u32::try_from(fg).ok())
                && fg != *group
            {
                groups.push(fg);
            }
            for &group in &groups {
                sys::signal_group(group, false);
            }
            Some(Doomed { groups })
        }
        #[cfg(windows)]
        {
            self.close_console();
            Some(Doomed { job: group })
        }
    }

    /// The child exited. On Windows the console keeps its output until it
    /// is closed, and only then does the output end.
    pub fn exited(&mut self) {
        #[cfg(windows)]
        self.close_console();
    }

    /// The terminal ended: it closes.
    pub fn end(self) {
        #[cfg(windows)]
        {
            let mut this = self;
            this.close_console();
        }
    }

    /// Closing a console waits until its last output is read, so it
    /// happens on a thread of its own while the reader keeps reading.
    #[cfg(windows)]
    fn close_console(&mut self) {
        if let Some(master) = self.master.take() {
            let _ = thread("terminal-close", move || drop(master));
        }
    }
}

fn thread(name: &str, run: impl FnOnce() + Send + 'static) -> io::Result<()> {
    let builder = std::thread::Builder::new().name(name.into());
    builder.stack_size(STACK).spawn(run).map(drop)
}

/// The reader thread: starts the child and its waiter, then reads until the
/// output ends. Once the core no longer listens it still reads, so that
/// whatever holds the terminal is never blocked writing to it.
fn read(
    slave: Box<dyn SlavePty + Send>,
    plan: Plan,
    mut reader: Box<dyn Read + Send>,
    tx: mpsc::Sender<Report>,
) {
    let child = slave.spawn_command(command(plan));
    // From here on only the child's tree holds its side of the terminal, so
    // the output ends when the last of them lets go.
    drop(slave);
    let started = child
        .map_err(|e| e.to_string())
        .and_then(|child| watch(child, &tx));
    let mut listening = match started {
        Ok(group) => tx.blocking_send(Report::Started(group)).is_ok(),
        Err(why) => {
            let _ = tx.blocking_send(Report::Failed(why));
            return;
        }
    };
    let mut buf = vec![0; READ];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        if listening {
            let chunk = buf[..n].to_vec();
            listening = tx.blocking_send(Report::Output(chunk)).is_ok();
        }
    }
    let _ = tx.blocking_send(Report::Closed);
}

/// Starts the thread that waits for the child's exit, and returns what ends
/// its tree.
fn watch(
    mut child: Box<dyn Child + Send + Sync>,
    tx: &mpsc::Sender<Report>,
) -> Result<Group, String> {
    let mut killer = child.clone_killer();
    // Without a group or a waiter nothing could end it or learn of its
    // exit: it must not run.
    let group = match group(&*child) {
        Ok(group) => group,
        Err(why) => {
            let _ = killer.kill();
            return Err(why);
        }
    };
    let exited = tx.clone();
    let wait = move || {
        let status = child.wait().ok();
        let code = status.and_then(|s| s.signal().is_none().then(|| s.exit_code()));
        let _ = exited.blocking_send(Report::Exited(code));
    };
    if let Err(e) = thread("terminal-exit", wait) {
        let _ = killer.kill();
        return Err(e.to_string());
    }
    Ok(group)
}

#[cfg(unix)]
fn group(child: &(dyn Child + Send + Sync)) -> Result<Group, String> {
    child
        .process_id()
        .ok_or_else(|| "the child has no process id".into())
}

#[cfg(windows)]
fn group(child: &(dyn Child + Send + Sync)) -> Result<Group, String> {
    let handle = child
        .as_raw_handle()
        .ok_or_else(|| io::Error::other("no handle"));
    let job = handle.and_then(sys::Job::new);
    job.map_err(|e| format!("cannot hold the child's processes together: {e}"))
}

fn command(plan: Plan) -> CommandBuilder {
    let mut cmd = match plan.argv.is_empty() {
        // The person's shell as a Linux terminal starts it: interactive, not
        // a login shell, whose profile may set PATH anew (Debian's does) and
        // drop the shims (design §4).
        true if cfg!(target_os = "linux") => CommandBuilder::new(shell()),
        // Elsewhere its login shell, as a terminal window starts it.
        true => CommandBuilder::new_default_prog(),
        false => CommandBuilder::from_argv(plan.argv.into_iter().map(OsString::from).collect()),
    };
    cmd.env_clear();
    for (key, value) in plan.env {
        cmd.env(key, value);
    }
    cmd.cwd(folder(plan.cwd));
    cmd
}

/// A canonical Windows path (`\\?\C:\…`, as `project.add` stores it) is
/// no working folder Windows takes; the same path without the prefix is.
#[cfg(windows)]
fn folder(path: PathBuf) -> PathBuf {
    let plain = path.to_str().and_then(|p| p.strip_prefix(r"\\?\"));
    match plain {
        Some(plain) if plain.as_bytes().get(1) == Some(&b':') => PathBuf::from(plain),
        _ => path,
    }
}

#[cfg(unix)]
fn folder(path: PathBuf) -> PathBuf {
    path
}

/// The input thread: writes each chunk whole, in order, and says so, which
/// is when the client that sent it may send more.
fn write(
    mut writer: Box<dyn Write + Send>,
    inputs: plain::Receiver<Vec<u8>>,
    tx: mpsc::Sender<Report>,
) {
    let mut taking = true;
    while let Ok(bytes) = inputs.recv() {
        taking = taking
            && writer
                .write_all(&bytes)
                .and_then(|()| writer.flush())
                .is_ok();
        if tx.blocking_send(Report::Wrote).is_err() {
            break;
        }
    }
}

/// The environment of every child, built from a fixed list and never
/// inherited whole from whoever started the core (design §7, hazard 14):
/// the person's home, user, language and shell, the PATH computed from the
/// usual tool folders, the terminal variables, and how to reach the core.
/// `path` is the child's PATH (`path`).
pub fn environment(data: &Path, token: &Secret, path: OsString) -> Vec<(String, OsString)> {
    let mut env = fixed(path);
    env.push(("TASKTAP_DATA".into(), data.into()));
    for (key, value) in crate::roles::environment(data, token) {
        env.push((key.into(), value));
    }
    env
}

/// The same list without how to reach the core: what the checks of an
/// agent's own program get (`agents::checks`).
pub fn fixed(path: OsString) -> Vec<(String, OsString)> {
    let var = |key: &str| std::env::var_os(key).filter(|v| !v.is_empty());
    let mut env = Vec::new();
    let mut put = |key: &str, value: OsString| env.push((key.to_owned(), value));
    #[cfg(unix)]
    {
        let home = var("HOME");
        let user = var("USER").or_else(|| var("LOGNAME"));
        if let Some(home) = &home {
            put("HOME", home.clone());
        }
        if let Some(user) = user {
            put("USER", user.clone());
            put("LOGNAME", user);
        }
        put("SHELL", var("SHELL").unwrap_or_else(|| "/bin/sh".into()));
        put("LANG", var("LANG").unwrap_or_else(|| "en_US.UTF-8".into()));
    }
    put("PATH", path);
    // What Windows programs need to find the system, the person's folders
    // and their tools. The PATH is the person's: Windows keeps it in the
    // registry, and the core received it from there.
    #[cfg(windows)]
    for key in [
        "SystemRoot",
        "SystemDrive",
        "windir",
        "ComSpec",
        "PATHEXT",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "ProgramData",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "CommonProgramFiles",
        "TEMP",
        "TMP",
        "USERNAME",
        "USERDOMAIN",
        "COMPUTERNAME",
        "OS",
        "PROCESSOR_ARCHITECTURE",
        "NUMBER_OF_PROCESSORS",
    ] {
        if let Some(value) = var(key) {
            put(key, value);
        }
    }
    put("TERM", "xterm-256color".into());
    put("COLORTERM", "truecolor".into());
    put("TERM_PROGRAM", "Tasktap".into());
    env
}

/// A child's PATH: `first` when given, then on Mac and Linux the folders
/// where people's tools live, the core's own PATH and the system's, each
/// once (as 1.2 computed it), since a core started by the app has the
/// system's short PATH, which finds none of them, and `last` at the end.
/// Windows keeps the person's PATH in the registry, and the core received
/// it from there.
pub fn path(first: Option<&Path>, last: Option<&Path>) -> OsString {
    let mut dirs: Vec<PathBuf> = first.map(Path::to_owned).into_iter().collect();
    #[cfg(unix)]
    if let Some(home) = std::env::var_os("HOME").filter(|h| !h.is_empty()) {
        dirs.push(Path::new(&home).join(".local/bin"));
        dirs.push(Path::new(&home).join(".opencode/bin"));
    }
    #[cfg(unix)]
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    dirs.extend(std::env::split_paths(&inherited));
    #[cfg(unix)]
    dirs.extend(["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(PathBuf::from));
    dirs.extend(last.map(Path::to_owned));
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|dir| !dir.as_os_str().is_empty() && seen.insert(dir.clone()));
    std::env::join_paths(dirs).unwrap_or_default()
}

/// The person's shell, which a terminal of kind `shell` runs.
pub fn shell() -> String {
    let (key, default) = if cfg!(windows) {
        ("ComSpec", "cmd.exe")
    } else {
        ("SHELL", "/bin/sh")
    };
    let shell = std::env::var(key).ok().filter(|s| !s.is_empty());
    shell.unwrap_or_else(|| default.into())
}

/// The folder a terminal with no project starts in.
pub fn home() -> PathBuf {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(key).map(PathBuf::from).unwrap_or_default()
}
