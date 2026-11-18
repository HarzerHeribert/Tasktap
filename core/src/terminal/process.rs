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
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as plain;
use std::time::Duration;
use tasktap_proto::{Secret, Size};
use tokio::sync::mpsc;

/// Reports a terminal's threads may have waiting for the core's thread
/// before the reader waits too (design §2).
pub const QUEUE: usize = 8;
/// Most bytes one read takes.
const READ: usize = 16 << 10;
/// None of the threads keeps a buffer on its stack.
const STACK: usize = 128 << 10;
/// What the core types is written this much at a time, so that once it
/// gives up on it no more than this is still on its way.
const PIECE: usize = 256;

/// A chunk of input for the input thread.
pub struct Input {
    pub bytes: Vec<u8>,
    /// For what the core types: set when the core gives up on it, after
    /// which none of it that is still to come is written.
    pub cancel: Option<Arc<AtomicBool>>,
}

/// What a terminal's threads tell the core's thread.
pub enum Report {
    /// The child runs.
    Started(Group),
    /// The child could not be started: why.
    Failed(String),
    Output(Vec<u8>),
    /// The output ended: nothing holds the terminal's other side any more.
    Closed,
    /// One chunk of input went to the process, whole, or with `false` only
    /// the part written before the core gave up on it.
    Wrote(bool),
    /// Input could not be written, and none will be: why. The input thread
    /// has ended, so what was on its way is not written either.
    Unwritable(String),
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
pub type Started = (Process, plain::Sender<Input>, mpsc::Receiver<Report>);

/// What [`Process::hang_up`] asked to end, for the timer that kills it.
/// On Mac and Linux that is every process group in the child's session,
/// which it leads: what the terminal started, in whatever group, unless a
/// process left the session itself. On Windows it is the job.
pub struct Doomed {
    #[cfg(unix)]
    session: u32,
    /// The groups hang-up was sent to, in case the processes cannot be listed.
    #[cfg(unix)]
    groups: Vec<u32>,
    #[cfg(windows)]
    job: Rc<Group>,
}

impl Doomed {
    pub fn kill(self) {
        #[cfg(unix)]
        for group in self.groups() {
            sys::signal_group(group, true);
        }
        #[cfg(windows)]
        self.job.kill();
    }

    /// Whether anything it would kill is left. On Windows closing the job,
    /// as the core does when it exits, ends what is left without waiting.
    pub fn alive(&self) -> bool {
        #[cfg(unix)]
        let alive = self.groups().into_iter().any(sys::group_alive);
        #[cfg(windows)]
        let alive = false;
        alive
    }

    #[cfg(unix)]
    fn groups(&self) -> Vec<u32> {
        let mut groups = sys::session_groups(self.session);
        groups.extend(&self.groups);
        groups.sort_unstable();
        groups.dedup();
        groups
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

    /// The session the child leads, once it runs: every process the terminal
    /// started is in it, unless it left it itself. None on Windows.
    pub fn session(&self) -> Option<u32> {
        #[cfg(unix)]
        let session = self.group.as_deref().copied();
        #[cfg(windows)]
        let session = None;
        session
    }

    /// The terminal's foreground process group, and the group of its own
    /// child, once it runs; none on Windows.
    pub fn foreground(&self) -> Option<(u32, u32)> {
        #[cfg(unix)]
        {
            let fg = self.master.as_ref()?.process_group_leader()?;
            Some((u32::try_from(fg).ok()?, **self.group.as_ref()?))
        }
        #[cfg(windows)]
        None
    }

    /// Hangs up on every process group of the child's session, the
    /// foreground group among them, or on Windows closes the console, which
    /// asks its processes to end. Returns what to kill if they have not
    /// ended by the deadline; nothing before the child has started, nor on
    /// Mac and Linux when nothing is left.
    pub fn hang_up(&mut self) -> Option<Doomed> {
        let group = self.group.clone()?;
        #[cfg(unix)]
        {
            let mut groups = vec![*group];
            let foreground = self.master.as_ref().and_then(|m| m.process_group_leader());
            groups.extend(foreground.and_then(|fg| u32::try_from(fg).ok()));
            let doomed = Doomed {
                session: *group,
                groups,
            };
            if !doomed.alive() {
                return None;
            }
            for group in doomed.groups() {
                sys::signal_group(group, false);
            }
            Some(doomed)
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
pub fn folder(path: PathBuf) -> PathBuf {
    let plain = path.to_str().and_then(|p| p.strip_prefix(r"\\?\"));
    match plain {
        Some(plain) if plain.as_bytes().get(1) == Some(&b':') => PathBuf::from(plain),
        _ => path,
    }
}

#[cfg(unix)]
pub fn folder(path: PathBuf) -> PathBuf {
    path
}

/// How long after input was written the Windows console is sent [`WAKE`].
const SETTLE: Duration = Duration::from_millis(50);
/// A key event that is no key: virtual key 0 released, with no character,
/// as the console's own input mode writes one (`CSI Vk;Sc;Uc;Kd;Cs;Rc _`).
/// A program reading lines never sees it, and one reading keys acts on
/// keys pressed.
const WAKE: &[u8] = b"\x1b[0;0;0;0;0;1_";

/// The input thread: writes each chunk whole, in order, and says so, which
/// is when the client that sent it may send more. The first write that
/// fails ends it, and it says why instead: what it did not write is never
/// reported written.
///
/// On Windows the console host is between the core and the program, and
/// input that reaches it just as the program begins to read can stay
/// there: the console has it, echoes nothing, and the program waits on in
/// its read until any other input event arrives (seen on Windows 11 24H2
/// under load, for about one line in a hundred typed to a program that
/// reads a line right after it printed: the line reached it only with the
/// next key, focus event or change of size, and a size set to what it was
/// did nothing). So once what was typed has been written and nothing more
/// came for [`SETTLE`], the thread writes [`WAKE`]: by then the program
/// waits in its read, and the event has the console pass on what it held.
/// Mac and Linux terminals hold nothing back, and nothing is sent there.
fn write(
    mut writer: Box<dyn Write + Send>,
    inputs: plain::Receiver<Input>,
    tx: mpsc::Sender<Report>,
) {
    // Input was written that no later event has followed yet.
    let mut owed = false;
    loop {
        let input = match owed {
            true => match inputs.recv_timeout(SETTLE) {
                Ok(input) => input,
                Err(plain::RecvTimeoutError::Timeout) => {
                    owed = false;
                    // A failure shows at the next write of what was typed.
                    let _ = writer.write_all(WAKE).and_then(|()| writer.flush());
                    continue;
                }
                Err(plain::RecvTimeoutError::Disconnected) => break,
            },
            false => match inputs.recv() {
                Ok(input) => input,
                Err(_) => break,
            },
        };
        owed = cfg!(windows);
        let report = match pieces(&mut *writer, &input) {
            Ok(whole) => Report::Wrote(whole),
            Err(e) => Report::Unwritable(e.to_string()),
        };
        let failed = matches!(report, Report::Unwritable(_));
        if tx.blocking_send(report).is_err() || failed {
            break;
        }
    }
}

/// Writes a chunk: a client's whole, what the core types a piece at a
/// time until it is written or the core gives up on it. Whether it was
/// written whole.
fn pieces(writer: &mut dyn Write, input: &Input) -> io::Result<bool> {
    let Some(cancel) = &input.cancel else {
        writer.write_all(&input.bytes)?;
        return writer.flush().map(|()| true);
    };
    for piece in input.bytes.chunks(PIECE) {
        if cancel.load(Ordering::SeqCst) {
            return Ok(false);
        }
        writer.write_all(piece)?;
        writer.flush()?;
    }
    Ok(true)
}

/// The environment of every child, built from a fixed list and never
/// inherited whole from whoever started the core (design §7, hazard 14):
/// the person's home, user, language and shell, the PATH computed from the
/// usual tool folders, the terminal variables, the variables the agents
/// declare they need ([`declared`]), and how to reach the core.
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
    for (key, value) in declared() {
        put(key, value.clone());
    }
    env
}

/// The variables the agents declare they need (`Agent::variables`), as the
/// core's own environment had them when it started, and nothing else. Their
/// values, a person's keys among them, go to children only, never to a
/// record or a log.
pub fn declared() -> &'static [(&'static str, OsString)] {
    static DECLARED: std::sync::OnceLock<Vec<(&'static str, OsString)>> =
        std::sync::OnceLock::new();
    DECLARED.get_or_init(|| {
        let set = crate::agents::variables().into_iter();
        set.filter_map(|key| Some((key, std::env::var_os(key).filter(|v| !v.is_empty())?)))
            .collect()
    })
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
