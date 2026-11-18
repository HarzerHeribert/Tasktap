//! What differs between platforms, and nothing else (design §2, §9): the data
//! folder, the listener and its peer check, the client's end, starting the
//! service detached, the signals that end it, and ending a terminal's
//! processes. Mac and Linux use the socket file `<data>/core.sock`; Windows
//! uses a named pipe. Also what a shim does to the terminal it shares with its
//! agent (design §4).

pub use tty::*;

/// What a worktree is called for the moment Windows is asked whether it is in
/// use (`in_use` there), after its own name.
pub const PROBE: &str = ".probe";
#[cfg(unix)]
pub use unix::*;
#[cfg(windows)]
pub use windows::*;

/// The terminal a shim shares with its agent, through the C library: std
/// has no terminal modes, process groups or signal dispositions.
#[cfg(unix)]
#[allow(unsafe_code)]
mod tty {
    use std::ffi::c_int;

    unsafe extern "C" {
        fn signal(signal: c_int, handler: usize) -> usize;
        fn tcgetattr(fd: c_int, modes: *mut u64) -> c_int;
        fn tcsetattr(fd: c_int, when: c_int, modes: *const u64) -> c_int;
        fn tcgetpgrp(fd: c_int) -> i32;
        fn getpgrp() -> i32;
        #[cfg(feature = "fixtures")]
        fn dup2(old: c_int, new: c_int) -> c_int;
    }

    // The same numbers on Mac and Linux.
    #[cfg(feature = "fixtures")]
    const SIGHUP: c_int = 1;
    const SIGINT: c_int = 2;
    const SIG_IGN: usize = 1;
    const TCSANOW: c_int = 0;
    const TCSAFLUSH: c_int = 2;

    /// The modes of the terminal on standard input. `struct termios` stays
    /// opaque bytes, more than any system's, since only the system reads it.
    pub struct Modes([u64; 32]);

    /// `None` when standard input is no terminal.
    pub fn modes() -> Option<Modes> {
        let mut modes = Modes([0; 32]);
        // SAFETY: the buffer is larger than any `struct termios` and outlives the call.
        (unsafe { tcgetattr(0, modes.0.as_mut_ptr()) } == 0).then_some(modes)
    }

    /// Puts the modes back; with `discard`, input not read yet is dropped too.
    pub fn restore(modes: &Modes, discard: bool) {
        let when = if discard { TCSAFLUSH } else { TCSANOW };
        // SAFETY: `modes` holds what `tcgetattr` wrote.
        unsafe { tcsetattr(0, when, modes.0.as_ptr()) };
    }

    /// Whether this process's group, which its children share, owns the
    /// terminal's foreground: its agent is neither stopped nor sent to the
    /// background, and nothing it started took the terminal.
    pub fn foreground() -> bool {
        // SAFETY: plain calls on standard input and this process.
        unsafe { tcgetpgrp(0) == getpgrp() }
    }

    /// Ignores Ctrl-C until dropped, as a shell does while its job runs: the
    /// agent, started before, keeps the default and gets it alone.
    pub struct Interrupts(usize);

    pub fn ignore_interrupts() -> Interrupts {
        // SAFETY: ignoring a signal installs no code.
        Interrupts(unsafe { signal(SIGINT, SIG_IGN) })
    }

    impl Drop for Interrupts {
        fn drop(&mut self) {
            // SAFETY: puts back the disposition `signal` returned.
            unsafe { signal(SIGINT, self.0) };
        }
    }

    /// Keeps this process running when its terminal hangs up.
    #[cfg(feature = "fixtures")]
    pub fn ignore_hangup() {
        // SAFETY: ignoring a signal installs no code.
        unsafe { signal(SIGHUP, SIG_IGN) };
    }

    /// Lets go of the terminal while this process goes on: its standard
    /// input, output and error become the null device.
    #[cfg(feature = "fixtures")]
    pub fn let_go() {
        use std::os::fd::AsRawFd;
        let null = std::fs::File::options()
            .read(true)
            .write(true)
            .open("/dev/null");
        if let Ok(null) = null {
            for fd in 0..3 {
                // SAFETY: both are open descriptors; dup2 touches no memory.
                unsafe { dup2(null.as_raw_fd(), fd) };
            }
        }
    }
}

/// Windows has no terminal modes to restore from here, no foreground group
/// and no hang-up; what a shim needs instead waits for the Windows phase.
#[cfg(windows)]
mod tty {
    pub struct Modes;

    pub fn modes() -> Option<Modes> {
        None
    }

    pub fn restore(_: &Modes, _: bool) {}

    pub fn foreground() -> bool {
        true
    }

    pub struct Interrupts;

    pub fn ignore_interrupts() -> Interrupts {
        Interrupts
    }

    #[cfg(feature = "fixtures")]
    pub fn ignore_hangup() {}

    #[cfg(feature = "fixtures")]
    pub fn let_go() {}
}

#[cfg(unix)]
mod unix {
    use std::fs::{self, Permissions};
    use std::io::{self, ErrorKind};
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use tokio::net::{UnixListener, UnixStream};
    use tokio::signal::unix::{SignalKind, signal};

    /// A connection the core accepted.
    pub type Stream = UnixStream;
    /// The client's end; blocking.
    pub type ClientStream = std::os::unix::net::UnixStream;

    fn socket(data: &Path) -> PathBuf {
        data.join("core.sock")
    }

    /// A program run to its end by the core (`command.rs`, the agents'
    /// checks). On Windows it holds everything the program started too.
    pub struct Tree;

    impl Tree {
        pub fn spawn(command: &mut Command) -> io::Result<(std::process::Child, Tree)> {
            Ok((command.spawn()?, Tree))
        }

        /// An agent a shim runs in its own terminal. Here it is the shim's
        /// plain child, which the shim ends by signal.
        pub fn attached(command: &mut Command) -> io::Result<(std::process::Child, Tree)> {
            Self::spawn(command)
        }

        /// Ends what the program started; the program is the caller's to end.
        pub fn kill(&self) {}
    }

    /// Only Windows opens a window for a program that has none to write in.
    pub fn no_window(_: &mut Command) {}

    /// The process at the other end of a connection, as the kernel says.
    pub fn peer_pid(stream: &Stream) -> Option<u32> {
        let pid = stream.peer_cred().ok()?.pid()?;
        u32::try_from(pid).ok()
    }

    /// The process group of process `pid`.
    #[allow(unsafe_code)]
    pub fn group_of(pid: u32) -> Option<u32> {
        // SAFETY: getpgid(2) takes and returns a pid_t, a 32-bit integer on
        // Linux and macOS, and touches no memory.
        unsafe extern "C" {
            safe fn getpgid(pid: i32) -> i32;
        }
        let group = getpgid(i32::try_from(pid).ok()?);
        u32::try_from(group).ok().filter(|&g| g > 0)
    }

    /// Sends hang-up, or with `kill` the kill signal, to every process in
    /// process group `group`. Never to the core's own group, nor to 0 or 1,
    /// which `kill` reads as "this group" and "every process".
    #[allow(unsafe_code)]
    pub fn signal_group(group: u32, kill: bool) {
        // SAFETY: the signature of kill(2) on Linux and macOS, where pid_t
        // is a 32-bit integer. It takes two integers and touches no memory
        // of this process, so calling it is safe.
        unsafe extern "C" {
            #[link_name = "kill"]
            safe fn kill_group(pid: i32, sig: i32) -> i32;
        }
        // SIGHUP and SIGKILL have these numbers on every Unix.
        let (hang_up, kill_signal) = (1, 9);
        let Ok(id) = i32::try_from(group) else { return };
        if id > 1 && group != std::process::id() {
            kill_group(-id, if kill { kill_signal } else { hang_up });
        }
    }

    /// Whether process group `group` still has a process.
    #[allow(unsafe_code)]
    pub fn group_alive(group: u32) -> bool {
        // SAFETY: as in `signal_group`; signal 0 only checks.
        unsafe extern "C" {
            #[link_name = "kill"]
            safe fn probe(pid: i32, sig: i32) -> i32;
        }
        i32::try_from(group).is_ok_and(|id| id > 1 && probe(-id, 0) == 0)
    }

    /// The process groups that have a process in session `session`, the
    /// id of the process that leads it or led it: every process a
    /// terminal's child started, unless it left the session itself (with
    /// `setsid`, as a daemon does). Empty where the processes cannot be
    /// listed.
    #[allow(unsafe_code)]
    pub fn session_groups(session: u32) -> Vec<u32> {
        // SAFETY: the signatures of getsid(2) and getpgid(2) on Linux and
        // macOS: an integer in, an integer out, no memory touched.
        unsafe extern "C" {
            safe fn getsid(pid: i32) -> i32;
            safe fn getpgid(pid: i32) -> i32;
        }
        let Ok(sid) = i32::try_from(session) else {
            return Vec::new();
        };
        let mut groups: Vec<u32> = (processes().into_iter())
            .filter(|&pid| pid > 1 && getsid(pid) == sid)
            .filter_map(|pid| u32::try_from(getpgid(pid)).ok())
            .collect();
        groups.sort_unstable();
        groups.dedup();
        groups
    }

    /// Whether a process works in `folder` or below it. A process of one of
    /// `sessions`, those of the core's terminals, whose working folder the
    /// system does not show counts as working there. None where the
    /// processes cannot be listed.
    #[allow(unsafe_code)]
    pub fn in_use(folder: &Path, sessions: &[u32]) -> Option<bool> {
        // SAFETY: the signature of getsid(2) on Linux and macOS: an integer
        // in, an integer out, no memory touched.
        unsafe extern "C" {
            safe fn getsid(pid: i32) -> i32;
        }
        let pids = processes();
        if pids.is_empty() || blind("processes") {
            return None;
        }
        let ours = |pid| u32::try_from(getsid(pid)).is_ok_and(|s| sessions.contains(&s));
        let works = |pid| match working_folder(pid).filter(|_| !blind("folders")) {
            Some(cwd) => cwd.starts_with(folder),
            None => ours(pid),
        };
        Some(pids.into_iter().filter(|&pid| pid > 0).any(works))
    }

    /// In a build with the test fixtures, what `TASKTAP_FIXTURE_BLIND` says
    /// the system does not show: `processes`, or their working `folders`.
    fn blind(what: &str) -> bool {
        cfg!(feature = "fixtures")
            && std::env::var("TASKTAP_FIXTURE_BLIND").is_ok_and(|b| b == what)
    }

    #[cfg(target_os = "linux")]
    fn working_folder(pid: i32) -> Option<PathBuf> {
        fs::read_link(format!("/proc/{pid}/cwd")).ok()
    }

    #[cfg(target_os = "macos")]
    #[allow(unsafe_code)]
    fn working_folder(pid: i32) -> Option<PathBuf> {
        use std::ffi::{CStr, OsStr, c_int, c_void};
        use std::os::unix::ffi::OsStrExt;
        // SAFETY: the signature of proc_pidinfo in libproc, part of the
        // system library: it writes at most `size` bytes into `buffer`
        // and returns how many it wrote.
        unsafe extern "C" {
            fn proc_pidinfo(
                pid: c_int,
                flavor: c_int,
                arg: u64,
                buffer: *mut c_void,
                size: c_int,
            ) -> c_int;
        }
        // PROC_PIDVNODEPATHINFO: a `proc_vnodepathinfo`, the working
        // folder's `vnode_info_path` (a 152-byte `vnode_info`, then the
        // path in MAXPATHLEN bytes ending in a NUL) and the root's.
        const FLAVOR: c_int = 9;
        const SIZE: usize = 2 * (152 + 1024);
        let mut info = vec![0u8; SIZE];
        // SAFETY: `info` holds SIZE bytes and lives through the call.
        let got = unsafe { proc_pidinfo(pid, FLAVOR, 0, info.as_mut_ptr().cast(), SIZE as c_int) };
        if usize::try_from(got).ok()? < SIZE {
            return None;
        }
        let path = CStr::from_bytes_until_nul(&info[152..152 + 1024]).ok()?;
        let path = path.to_bytes();
        (!path.is_empty()).then(|| PathBuf::from(OsStr::from_bytes(path)))
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn working_folder(_: i32) -> Option<PathBuf> {
        None
    }

    /// Every process's id.
    #[cfg(target_os = "linux")]
    fn processes() -> Vec<i32> {
        let entries = fs::read_dir("/proc").into_iter().flatten().flatten();
        entries
            .filter_map(|e| e.file_name().to_str()?.parse().ok())
            .collect()
    }

    /// Every process's id.
    #[cfg(target_os = "macos")]
    #[allow(unsafe_code)]
    fn processes() -> Vec<i32> {
        use std::ffi::{c_int, c_void};
        // SAFETY: the signature of proc_listallpids in libproc, part of
        // the system library: it writes at most `size` bytes of process
        // ids into `buffer` and returns how many it wrote; with no buffer
        // it returns how many there are.
        unsafe extern "C" {
            fn proc_listallpids(buffer: *mut c_void, size: c_int) -> c_int;
        }
        // SAFETY: no buffer: nothing is written.
        let n = unsafe { proc_listallpids(std::ptr::null_mut(), 0) };
        let Ok(n) = usize::try_from(n) else {
            return Vec::new();
        };
        // Room for processes started since.
        let mut pids = vec![0i32; n + 64];
        let size = c_int::try_from(pids.len() * size_of::<i32>()).unwrap_or(c_int::MAX);
        // SAFETY: `pids` holds `size` bytes and lives through the call.
        let got = unsafe { proc_listallpids(pids.as_mut_ptr().cast(), size) };
        pids.truncate(usize::try_from(got).unwrap_or(0).min(pids.len()));
        pids
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn processes() -> Vec<i32> {
        Vec::new()
    }

    /// Sends hang-up, or with `kill` the kill signal, to process `pid` alone.
    /// Never to this process, nor to 0 or 1.
    #[allow(unsafe_code)]
    pub fn signal_process(pid: u32, kill: bool) {
        // SAFETY: as for `signal_group`: kill(2) takes two integers and
        // touches no memory of this process.
        unsafe extern "C" {
            #[link_name = "kill"]
            safe fn kill_process(pid: i32, sig: i32) -> i32;
        }
        let (hang_up, kill_signal) = (1, 9);
        let Ok(id) = i32::try_from(pid) else { return };
        if id > 1 && pid != std::process::id() {
            kill_process(id, if kill { kill_signal } else { hang_up });
        }
    }

    /// The size of the terminal on standard output, `(cols, rows)`, for the
    /// test role that reports it (design §13).
    #[cfg(feature = "fixtures")]
    #[allow(unsafe_code)]
    pub fn window() -> Option<(u16, u16)> {
        #[repr(C)]
        #[derive(Default)]
        struct Winsize {
            rows: u16,
            cols: u16,
            width: u16,
            height: u16,
        }
        #[cfg(target_os = "linux")]
        const TIOCGWINSZ: std::ffi::c_ulong = 0x5413;
        #[cfg(not(target_os = "linux"))]
        const TIOCGWINSZ: std::ffi::c_ulong = 0x4008_7468;
        // SAFETY: the signature of ioctl(2) on Linux and macOS.
        unsafe extern "C" {
            fn ioctl(fd: i32, request: std::ffi::c_ulong, ...) -> i32;
        }
        let mut size = Winsize::default();
        // SAFETY: TIOCGWINSZ writes one `struct winsize`, which `Winsize`
        // lays out, into `size`, which lives through the call.
        let ok = unsafe { ioctl(1, TIOCGWINSZ, &mut size as *mut Winsize) } == 0;
        ok.then_some((size.cols, size.rows))
    }

    /// This process's effective user id. std has no `geteuid`, but the kernel
    /// reports the creator of a socket pair, which is this process, through
    /// the same call the peer check uses: both sides of that comparison come
    /// from one source.
    fn own_uid() -> io::Result<u32> {
        Ok(UnixStream::pair()?.0.peer_cred()?.uid())
    }

    /// Creates the data folder 0700, or makes one the user owns 0700.
    pub fn prepare(data: &Path) -> io::Result<()> {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(data)?;
        let meta = fs::metadata(data)?;
        if meta.uid() != own_uid()? {
            let why = format!("{} belongs to another user", data.display());
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, why));
        }
        if meta.mode() & 0o777 != 0o700 {
            fs::set_permissions(data, Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    pub struct Listener {
        socket: UnixListener,
        path: PathBuf,
        uid: u32,
    }

    impl Listener {
        /// Only the holder of the lock binds, so a socket file already there is stale.
        pub fn bind(data: &Path) -> io::Result<Listener> {
            let path = socket(data);
            match fs::remove_file(&path) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                _ => {}
            }
            let socket = UnixListener::bind(&path)?;
            fs::set_permissions(&path, Permissions::from_mode(0o600))?;
            let uid = own_uid()?;
            Ok(Listener { socket, path, uid })
        }

        /// The next connection from a process of the core's own user; any
        /// other is closed unanswered.
        pub async fn accept(&mut self) -> io::Result<Stream> {
            loop {
                match self.socket.accept().await {
                    Ok((stream, _)) if stream.peer_cred().is_ok_and(|c| c.uid() == self.uid) => {
                        return Ok(stream);
                    }
                    Ok(_) => {}
                    Err(e) if gone_before_accepted(&e) => {}
                    Err(e) => return Err(e),
                }
            }
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    /// An error about one connection that never got going, not the listener.
    fn gone_before_accepted(e: &io::Error) -> bool {
        let kind = e.kind();
        kind == ErrorKind::ConnectionAborted || kind == ErrorKind::ConnectionReset
    }

    pub fn connect(data: &Path) -> io::Result<ClientStream> {
        ClientStream::connect(socket(data))
    }

    /// Nothing to do: a socket ends with its last descriptor, which the
    /// caller drops next.
    pub fn hang_up(_: &Stream) {}

    /// Keeps a terminal's Ctrl-C and hang-up away from a core a client started.
    pub fn detach(cmd: &mut Command) {
        cmd.process_group(0);
    }

    /// Completes on SIGTERM or SIGINT. Registered before it is awaited, so a
    /// signal that arrives early is not lost.
    pub fn terminated() -> io::Result<impl Future<Output = ()>> {
        let mut term = signal(SignalKind::terminate())?;
        let mut int = signal(SignalKind::interrupt())?;
        Ok(async move {
            tokio::select! {
                _ = term.recv() => {}
                _ = int.recv() => {}
            }
        })
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
mod windows {
    use sha2::{Digest, Sha256};
    use std::ffi::OsStr;
    use std::fs::{self, OpenOptions};
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, RawHandle};
    use std::os::windows::process::CommandExt;
    use std::path::Path;
    use std::process::Command;
    use std::ptr::{null, null_mut};
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_PIPE_BUSY, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation,
    };
    use windows_sys::Win32::Security::{
        GetLengthSid, GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows_sys::Win32::System::IO::CancelIoEx;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Pipes::{
        GetNamedPipeClientProcessId, GetNamedPipeServerProcessId, NMPWAIT_WAIT_FOREVER,
        WaitNamedPipeW,
    };
    use windows_sys::Win32::System::Threading::{
        CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS, GetCurrentProcess, OpenProcess,
        OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::core::BOOL;

    /// A connection the core accepted.
    pub type Stream = NamedPipeServer;
    /// The client's end; blocking.
    pub type ClientStream = fs::File;

    /// `\\.\pipe\tasktap-<digest of the data folder>`: one name per folder,
    /// as the socket file is on Unix.
    fn pipe(data: &Path) -> io::Result<String> {
        let folder = fs::canonicalize(data)?;
        let digest = Sha256::digest(folder.as_os_str().as_encoded_bytes());
        let hex: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
        Ok(format!(r"\\.\pipe\tasktap-{hex}"))
    }

    /// Whether a process works in `folder` or below it, or holds a file of
    /// it. Windows does not say where another process works without reading
    /// its memory, but refuses to rename a folder in use: one that takes
    /// another name for a moment is in use by none. What only looks at a
    /// file, such as a virus scanner, refuses it for a moment too, so it is
    /// tried for a few seconds. A folder that could not be given its name
    /// back counts as in use, and the next start gives it back.
    pub fn in_use(folder: &Path, _: &[u32]) -> Option<bool> {
        let mut aside = folder.as_os_str().to_owned();
        aside.push(super::PROBE);
        let aside = Path::new(&aside);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let patiently = |from: &Path, to: &Path| {
            while fs::rename(from, to).is_err() {
                if std::time::Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            true
        };
        Some(!(patiently(folder, aside) && patiently(aside, folder)))
    }

    /// Ends process `pid` at once: a git command past its time.
    pub fn end_process(pid: u32) {
        use windows_sys::Win32::System::Threading::{PROCESS_TERMINATE, TerminateProcess};
        // SAFETY: OpenProcess returns a handle or null; a handle is used
        // once and closed once.
        unsafe {
            let process = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !process.is_null() {
                TerminateProcess(process, 1);
                CloseHandle(process);
            }
        }
    }

    /// A job object holding a terminal's process and every process it
    /// starts, so that ending the job ends the whole tree (design §9). Its
    /// processes also end when the job's last handle closes: when the
    /// terminal has ended, or with the core.
    pub struct Job(HANDLE);

    // SAFETY: a job handle may be used and closed from any thread.
    unsafe impl Send for Job {}

    impl Job {
        /// A new job with no process in it yet. A terminal's child is created
        /// in its job ([`console::Console::spawn`]), so nothing it starts is
        /// ever outside it.
        pub fn new() -> io::Result<Job> {
            let job = Job::lasting()?;
            // SAFETY: an all-zero JOBOBJECT_EXTENDED_LIMIT_INFORMATION is a
            // valid value: no limits.
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let size = std::mem::size_of_val(&info) as u32;
            // SAFETY: `info` is the structure this class names, `size`
            // its size, and it lives through the call.
            let set = unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    (&raw const info).cast(),
                    size,
                )
            };
            if set == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }

        /// A job whose processes run on when its last handle closes: only
        /// [`Job::kill`] ends them.
        fn lasting() -> io::Result<Job> {
            // SAFETY: null attributes and name ask for an unnamed job with
            // default security; the handle is checked before use.
            let job = unsafe { CreateJobObjectW(null(), null()) };
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            Ok(Job(job))
        }

        /// Puts `process`, a process handle, in the job, and with it every
        /// process it starts from then on.
        pub fn hold(&self, process: RawHandle) -> io::Result<()> {
            // SAFETY: both handles are open for the call.
            if unsafe { AssignProcessToJobObject(self.0, process as HANDLE) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        /// Ends every process in the job.
        pub fn kill(&self) {
            // SAFETY: the handle is open while `self` lives.
            unsafe { TerminateJobObject(self.0, 1) };
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: `Job` holds the handle it created and closes it once.
            unsafe { CloseHandle(self.0) };
        }
    }

    /// The size of the console on standard output, `(cols, rows)`, for the
    /// test role that reports it (design §13).
    #[cfg(feature = "fixtures")]
    pub fn window() -> Option<(u16, u16)> {
        use windows_sys::Win32::System::Console::{
            CONSOLE_SCREEN_BUFFER_INFO, GetConsoleScreenBufferInfo, GetStdHandle, STD_OUTPUT_HANDLE,
        };
        // SAFETY: an all-zero CONSOLE_SCREEN_BUFFER_INFO is a valid value,
        // the standard handle needs no closing, and the call writes only
        // into `info`, which lives through it.
        let ok = unsafe {
            let mut info: CONSOLE_SCREEN_BUFFER_INFO = std::mem::zeroed();
            let ok = GetConsoleScreenBufferInfo(GetStdHandle(STD_OUTPUT_HANDLE), &mut info) != 0;
            ok.then_some(info.srWindow)
        };
        let window = ok?;
        let cols = window.Right - window.Left + 1;
        let rows = window.Bottom - window.Top + 1;
        Some((u16::try_from(cols).ok()?, u16::try_from(rows).ok()?))
    }

    /// The folder lives in the user's profile, whose access list already
    /// keeps other users out.
    pub fn prepare(data: &Path) -> io::Result<()> {
        fs::create_dir_all(data)
    }

    pub struct Listener {
        /// The instance the next client connects to.
        next: NamedPipeServer,
        name: String,
        user: Vec<u8>,
    }

    impl Listener {
        pub fn bind(data: &Path) -> io::Result<Listener> {
            let name = pipe(data)?;
            // Fails when any process, of any user, holds the name already:
            // the core never shares its name.
            let next = ServerOptions::new()
                .first_pipe_instance(true)
                .create(&name)?;
            let user = user_of(current())?;
            Ok(Listener { next, name, user })
        }

        /// The next connection from a process of the core's own user, which
        /// is the Unix peer check; any other is closed unanswered.
        pub async fn accept(&mut self) -> io::Result<Stream> {
            loop {
                let connected = self.next.connect().await;
                // The next instance exists before this one is handed over, so
                // a client finds the name busy only for that moment.
                let fresh = ServerOptions::new().create(&self.name)?;
                let stream = std::mem::replace(&mut self.next, fresh);
                // An error is a client that left before it was accepted.
                if connected.is_ok()
                    && same_user(peer(&stream, GetNamedPipeClientProcessId), &self.user)
                {
                    return Ok(stream);
                }
            }
        }
    }

    pub fn connect(data: &Path) -> io::Result<ClientStream> {
        let name = pipe(data)?;
        let pipe = loop {
            match OpenOptions::new().read(true).write(true).open(&name) {
                // Every instance is taken this moment: wait in the kernel
                // until the core offers the next one, as a Unix client waits
                // in the listen backlog.
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                    let wide: Vec<u16> = OsStr::new(&name).encode_wide().chain([0]).collect();
                    // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the call.
                    if unsafe { WaitNamedPipeW(wide.as_ptr(), NMPWAIT_WAIT_FOREVER) } == 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                opened => break opened?,
            }
        };
        // Pipe names are global: another user may have taken this one while
        // no core ran. Never send a key to them.
        if !same_user(
            peer(&pipe, GetNamedPipeServerProcessId),
            &user_of(current())?,
        ) {
            let why = "the core's pipe belongs to another user";
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, why));
        }
        Ok(pipe)
    }

    /// Lets the drop that follows close the pipe at once. Otherwise mio
    /// keeps an unfinished write in flight, and with it the pipe open, until
    /// the client reads; a client that stopped reading and blocks writing
    /// to a core that no longer reads would wait forever. With the write
    /// cancelled the pipe closes as a socket does: the client reads what
    /// the pipe already holds and then the end, and its blocked write fails.
    /// (`disconnect` would also free it, but discards what the pipe holds and
    /// fails the client's reads instead of ending them.)
    /// Not asked on Windows, where no program holds a console the way a
    /// foreground group holds a terminal (design §14, "Verify when reached").
    pub fn peer_pid(_: &Stream) -> Option<u32> {
        None
    }

    pub fn hang_up(pipe: &Stream) {
        // SAFETY: the handle is open for the call, and a null OVERLAPPED
        // cancels every I/O in flight on it; mio takes a cancelled
        // operation back like any failed one.
        unsafe { CancelIoEx(pipe.as_raw_handle() as HANDLE, null()) };
    }

    /// No console, so the client's Ctrl-C and closing its window leave it
    /// running. Windows hands a child every handle that may be inherited, and
    /// this process's standard handles may, having been inherited themselves:
    /// a core a hook started would keep that hook's output open, and its agent
    /// would wait for the end of it as long as the core lives. A child of this
    /// process still gets them, as std passes standard handles as copies.
    pub fn detach(cmd: &mut Command) {
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        let std = [
            io::stdin().as_raw_handle(),
            io::stdout().as_raw_handle(),
            io::stderr().as_raw_handle(),
        ];
        for handle in std {
            // SAFETY: changes one flag of a handle this process holds; one it
            // has not is refused, which changes nothing.
            unsafe { SetHandleInformation(handle as HANDLE, HANDLE_FLAG_INHERIT, 0) };
        }
    }

    /// Completes on Ctrl-C, Ctrl-Break, closing the console, or shutdown.
    pub fn terminated() -> io::Result<impl Future<Output = ()>> {
        use tokio::signal::windows::{ctrl_break, ctrl_c, ctrl_close, ctrl_shutdown};
        let (mut c, mut b) = (ctrl_c()?, ctrl_break()?);
        let (mut close, mut shutdown) = (ctrl_close()?, ctrl_shutdown()?);
        Ok(async move {
            tokio::select! {
                _ = c.recv() => {}
                _ = b.recv() => {}
                _ = close.recv() => {}
                _ = shutdown.recv() => {}
            }
        })
    }

    type PidQuery = unsafe extern "system" fn(HANDLE, *mut u32) -> BOOL;

    /// The process at the other end of a pipe, as `query` names it.
    fn peer(pipe: &impl AsRawHandle, query: PidQuery) -> Option<u32> {
        let mut pid = 0;
        // SAFETY: the handle is an open pipe handle borrowed for the call,
        // and `pid` is a valid place for the one u32 written.
        let ok = unsafe { query(pipe.as_raw_handle() as HANDLE, &mut pid) };
        (ok != 0).then_some(pid)
    }

    fn same_user(pid: Option<u32>, user: &[u8]) -> bool {
        let Some(pid) = pid else { return false };
        // SAFETY: plain call; a null result is checked before use.
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            // A process this user may not even inspect is not this user's.
            return false;
        }
        let process = Owned(process);
        user_of(process.0).is_ok_and(|u| u == user)
    }

    fn current() -> HANDLE {
        // SAFETY: returns a constant pseudo handle; it needs no closing.
        unsafe { GetCurrentProcess() }
    }

    /// The user SID of a process, copied out of its access token. SIDs are
    /// canonical, so equal bytes mean the same user.
    fn user_of(process: HANDLE) -> io::Result<Vec<u8>> {
        let mut token = null_mut();
        // SAFETY: `process` is a process handle; `token` receives a handle
        // that `Owned` closes.
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = Owned(token);
        let mut len = 0;
        // SAFETY: a null buffer of length 0 only asks for the size, written to `len`.
        unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut len) };
        // Whole u64 words, so the TOKEN_USER at the start is aligned.
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        // SAFETY: `buf` has room for `len` bytes.
        let ok = unsafe {
            GetTokenInformation(token.0, TokenUser, buf.as_mut_ptr().cast(), len, &mut len)
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: on success `buf` starts with a TOKEN_USER whose SID points
        // into `buf`, which outlives this read, and GetLengthSid is its size.
        unsafe {
            let sid = (*buf.as_ptr().cast::<TOKEN_USER>()).User.Sid;
            let size = GetLengthSid(sid) as usize;
            Ok(std::slice::from_raw_parts(sid.cast::<u8>(), size).to_vec())
        }
    }

    struct Owned(HANDLE);

    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: `Owned` holds a handle it opened and closes it once.
            unsafe { CloseHandle(self.0) };
        }
    }

    /// A program the core runs for its output, such as git, must not open a
    /// console window: the core has no console, and Windows gives a program
    /// that needs one a window of its own.
    pub fn no_window(command: &mut Command) {
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }

    /// A program run to its end by the core (`command.rs`, the agents'
    /// checks), with everything it starts: a tool installed as a batch file
    /// is the command prompt running the tool, and ending the command prompt
    /// alone leaves the tool running. The program starts suspended, is put
    /// in a job, and only then runs, so nothing it starts is outside it;
    /// the job ends with [`Tree::kill`] or when the tree is dropped.
    pub struct Tree(Job);

    impl Tree {
        pub fn spawn(command: &mut Command) -> io::Result<(std::process::Child, Tree)> {
            use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
            // No console window of its own either: the core has none to share.
            Self::start(command, Job::new()?, CREATE_NO_WINDOW)
        }

        /// An agent a shim runs in its own terminal, with everything the
        /// agent starts: the agent may be a batch file around the program.
        /// It shares the shim's console, and a shim that dies leaves it
        /// running, as on Unix; [`Tree::kill`] is how the shim ends it. The
        /// job is the terminal's way too (design §9), and asks nothing of
        /// the system's management service, which `taskkill` needs and
        /// which refuses some sign-ins.
        pub fn attached(command: &mut Command) -> io::Result<(std::process::Child, Tree)> {
            Self::start(command, Job::lasting()?, 0)
        }

        fn start(
            command: &mut Command,
            job: Job,
            flags: u32,
        ) -> io::Result<(std::process::Child, Tree)> {
            use windows_sys::Win32::System::Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First,
                Thread32Next,
            };
            use windows_sys::Win32::System::Threading::{
                CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
            };
            let mut child = command.creation_flags(CREATE_SUSPENDED | flags).spawn()?;
            let held = job.hold(child.as_raw_handle());
            // Resumed whether or not the job took it: its one thread, found
            // among the system's by the process it belongs to.
            let mut resumed = false;
            // SAFETY: the snapshot is a handle closed below; `entry` is a
            // valid THREADENTRY32 with its size set, as the calls require;
            // each thread handle is used once and closed once.
            unsafe {
                let threads = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
                let mut entry: THREADENTRY32 = std::mem::zeroed();
                entry.dwSize = size_of::<THREADENTRY32>() as u32;
                let mut more = Thread32First(threads, &mut entry) != 0;
                while more {
                    if entry.th32OwnerProcessID == child.id() {
                        let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                        if !thread.is_null() {
                            resumed |= ResumeThread(thread) != u32::MAX;
                            CloseHandle(thread);
                        }
                    }
                    more = Thread32Next(threads, &mut entry) != 0;
                }
                CloseHandle(threads);
            }
            if let Err(e) = held.and_then(|()| match resumed {
                true => Ok(()),
                false => Err(io::Error::other("the program could not be let run")),
            }) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
            Ok((child, Tree(job)))
        }

        /// Ends the program and everything it started.
        pub fn kill(&self) {
            self.0.kill();
        }
    }

    /// A pseudo-console and the child that runs in it (design §9). The core
    /// creates both itself: the child is in its job from its first
    /// instruction, where a job assigned after the start would miss what the
    /// child had started by then, and a batch file's arguments are written
    /// for the command prompt that reads them, or refused.
    pub mod console {
        use super::Job;
        use std::ffi::{OsStr, OsString, c_void};
        use std::fs::File;
        use std::io;
        use std::os::windows::ffi::OsStrExt;
        use std::os::windows::io::FromRawHandle;
        use std::path::{Path, PathBuf};
        use std::ptr::{null, null_mut};
        use std::sync::OnceLock;
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Console::{
            COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole,
        };
        use windows_sys::Win32::System::LibraryLoader::{
            GetProcAddress, LOAD_WITH_ALTERED_SEARCH_PATH, LoadLibraryExW,
        };
        use windows_sys::Win32::System::Pipes::CreatePipe;
        use windows_sys::Win32::System::Threading::{
            CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
            EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE,
            InitializeProcThreadAttributeList, PROC_THREAD_ATTRIBUTE_JOB_LIST,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, STARTF_USESTDHANDLES,
            STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
        };
        use windows_sys::core::HRESULT;

        /// The three calls of a pseudo-console.
        struct Api {
            create: unsafe extern "system" fn(COORD, HANDLE, HANDLE, u32, *mut HPCON) -> HRESULT,
            resize: unsafe extern "system" fn(HPCON, COORD) -> HRESULT,
            close: unsafe extern "system" fn(HPCON),
        }

        /// Microsoft's current console when it lies beside this program
        /// (`conpty.dll`, which runs the `OpenConsole.exe` beside it), else the
        /// one that ships with Windows, which can hold a typed line back
        /// (design §9, "Input"). Loaded by its whole path, so only from this
        /// program's own folder.
        fn api() -> &'static Api {
            static API: OnceLock<Api> = OnceLock::new();
            API.get_or_init(|| {
                let system = Api {
                    create: CreatePseudoConsole,
                    resize: ResizePseudoConsole,
                    close: ClosePseudoConsole,
                };
                let Ok(exe) = std::env::current_exe() else {
                    return system;
                };
                let beside = wide(exe.with_file_name("conpty.dll").as_os_str());
                // SAFETY: `beside` is a NUL-terminated path; a module that
                // loaded stays loaded for the life of the process; each name
                // is a NUL-terminated string, and a function found under it
                // has the signature the console's header declares for it.
                unsafe {
                    let module =
                        LoadLibraryExW(beside.as_ptr(), null_mut(), LOAD_WITH_ALTERED_SEARCH_PATH);
                    if module.is_null() {
                        return system;
                    }
                    let find = |name: &[u8]| GetProcAddress(module, name.as_ptr());
                    match (
                        find(b"CreatePseudoConsole\0"),
                        find(b"ResizePseudoConsole\0"),
                        find(b"ClosePseudoConsole\0"),
                    ) {
                        (Some(create), Some(resize), Some(close)) => Api {
                            create: std::mem::transmute::<
                                unsafe extern "system" fn() -> isize,
                                unsafe extern "system" fn(
                                    COORD,
                                    HANDLE,
                                    HANDLE,
                                    u32,
                                    *mut HPCON,
                                )
                                    -> HRESULT,
                            >(create),
                            resize: std::mem::transmute::<
                                unsafe extern "system" fn() -> isize,
                                unsafe extern "system" fn(HPCON, COORD) -> HRESULT,
                            >(resize),
                            close: std::mem::transmute::<
                                unsafe extern "system" fn() -> isize,
                                unsafe extern "system" fn(HPCON),
                            >(close),
                        },
                        _ => system,
                    }
                }
            })
        }

        fn wide(text: &OsStr) -> Vec<u16> {
            text.encode_wide().chain([0]).collect()
        }

        fn coord(cols: u16, rows: u16) -> COORD {
            COORD {
                X: cols.min(i16::MAX as u16) as i16,
                Y: rows.min(i16::MAX as u16) as i16,
            }
        }

        fn failed(what: &str, result: HRESULT) -> io::Error {
            io::Error::other(format!("{what}: HRESULT {result:#010x}"))
        }

        pub struct Console(HPCON);

        // SAFETY: a pseudo-console may be resized, used to start a process
        // and closed from any thread.
        unsafe impl Send for Console {}
        unsafe impl Sync for Console {}

        /// A process handle, closed with the value.
        pub struct Child(HANDLE);

        // SAFETY: a process handle may be waited on and closed from any thread.
        unsafe impl Send for Child {}

        /// Opens a console of `cols` by `rows`, and returns it with its
        /// output to read and its input to write.
        pub fn open(cols: u16, rows: u16) -> io::Result<(Console, File, File)> {
            let pipe = || {
                let (mut read, mut write) = (null_mut(), null_mut());
                // SAFETY: both places are valid; the handles are not inherited.
                if unsafe { CreatePipe(&mut read, &mut write, null(), 0) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                // SAFETY: both handles were just made and are owned from here on.
                Ok(unsafe { (File::from_raw_handle(read), File::from_raw_handle(write)) })
            };
            let (input_read, input) = pipe()?;
            let (output, output_write) = pipe()?;
            let mut console: HPCON = 0;
            // What portable-pty asked for: the console takes over the
            // cursor (it asks for its position first, `terminal/queries.rs`),
            // rewraps on resize, and sends keys as Windows programs read them.
            const INHERIT_CURSOR: u32 = 0x1;
            const RESIZE_QUIRK: u32 = 0x2;
            const WIN32_INPUT_MODE: u32 = 0x4;
            use std::os::windows::io::AsRawHandle;
            // SAFETY: both pipe ends are open for the call, after which the
            // console holds its own copies and these close; `console` is a
            // valid place for the handle.
            let result = unsafe {
                (api().create)(
                    coord(cols, rows),
                    input_read.as_raw_handle(),
                    output_write.as_raw_handle(),
                    INHERIT_CURSOR | RESIZE_QUIRK | WIN32_INPUT_MODE,
                    &mut console,
                )
            };
            if result != 0 {
                return Err(failed("the console could not be made", result));
            }
            Ok((Console(console), output, input))
        }

        impl Console {
            pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
                // SAFETY: the console is open while `self` lives.
                match unsafe { (api().resize)(self.0, coord(cols, rows)) } {
                    0 => Ok(()),
                    result => Err(failed("the console could not be resized", result)),
                }
            }

            /// Starts `argv` in the console with exactly the environment
            /// `env`, in `cwd` when that is a folder, and in `job` from its
            /// first instruction. `argv[0]` is the program's file; a batch
            /// file runs in the command prompt ([`command_line`]).
            pub fn spawn(
                &self,
                argv: &[OsString],
                env: &[(String, OsString)],
                cwd: &Path,
                job: &Job,
            ) -> io::Result<Child> {
                // Found on the PATH the child will have, as its shell would find it.
                let path = env.iter().find(|(key, _)| key.eq_ignore_ascii_case("PATH"));
                let (program, mut line) =
                    command_line(argv, path.map(|(_, path)| path.as_os_str()))?;
                let program = wide(program.as_os_str());
                let mut block = environment(env);
                let cwd = cwd.is_dir().then(|| wide(cwd.as_os_str()));
                let jobs = [job.0];
                // SAFETY: the attribute list is sized by the system, lives in
                // `list` until it is deleted below, and points at the console
                // handle and at `jobs`, which outlive the call that reads
                // them; every string is NUL-terminated and outlives it too;
                // `info` and `made` are valid for the call, which closes over
                // nothing else. The standard handles are named and invalid,
                // so the child takes the console's and never this process's.
                unsafe {
                    let mut size = 0;
                    InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut size);
                    let mut list = vec![0u64; size.div_ceil(8)];
                    let attributes = list.as_mut_ptr().cast::<c_void>();
                    if InitializeProcThreadAttributeList(attributes, 2, 0, &mut size) == 0 {
                        return Err(io::Error::last_os_error());
                    }
                    let set = |attribute: u32, value: *const c_void, size: usize| {
                        let attribute = attribute as usize;
                        UpdateProcThreadAttribute(
                            attributes,
                            0,
                            attribute,
                            value,
                            size,
                            null_mut(),
                            null(),
                        ) != 0
                    };
                    let mut info: STARTUPINFOEXW = std::mem::zeroed();
                    info.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
                    info.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                    info.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
                    info.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
                    info.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
                    info.lpAttributeList = attributes;
                    let mut made: PROCESS_INFORMATION = std::mem::zeroed();
                    let started = set(
                        PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                        self.0 as *const c_void,
                        size_of::<HPCON>(),
                    ) && set(
                        PROC_THREAD_ATTRIBUTE_JOB_LIST,
                        jobs.as_ptr().cast(),
                        size_of::<HANDLE>(),
                    ) && CreateProcessW(
                        program.as_ptr(),
                        line.as_mut_ptr(),
                        null(),
                        null(),
                        0,
                        EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                        block.as_mut_ptr().cast(),
                        cwd.as_ref().map_or(null(), |cwd| cwd.as_ptr()),
                        &info.StartupInfo,
                        &mut made,
                    ) != 0;
                    let error = io::Error::last_os_error();
                    DeleteProcThreadAttributeList(attributes);
                    if !started {
                        return Err(error);
                    }
                    CloseHandle(made.hThread);
                    Ok(Child(made.hProcess))
                }
            }
        }

        impl Drop for Console {
            fn drop(&mut self) {
                // SAFETY: `Console` holds the console it made and closes it once.
                unsafe { (api().close)(self.0) };
            }
        }

        impl Child {
            /// Waits for the process to end: its exit code.
            pub fn wait(&self) -> Option<u32> {
                let mut code = 0;
                // SAFETY: the handle is open while `self` lives, and `code`
                // is a valid place for the one u32 written.
                let known = unsafe {
                    WaitForSingleObject(self.0, INFINITE);
                    GetExitCodeProcess(self.0, &mut code) != 0
                };
                known.then_some(code)
            }
        }

        impl Drop for Child {
            fn drop(&mut self) {
                // SAFETY: `Child` holds the handle it was given and closes it once.
                unsafe { CloseHandle(self.0) };
            }
        }

        /// The environment block of a process: `key=value` strings, each
        /// ended by a NUL, in the order Windows keeps them, and one NUL more.
        fn environment(env: &[(String, OsString)]) -> Vec<u16> {
            let mut vars = std::collections::BTreeMap::new();
            for (key, value) in env {
                vars.insert(key.to_uppercase(), (key, value));
            }
            let mut block = Vec::new();
            for (key, value) in vars.values() {
                block.extend(key.encode_utf16());
                block.push(u16::from(b'='));
                block.extend(value.encode_wide());
                block.push(0);
            }
            if block.is_empty() {
                block.push(0);
            }
            block.push(0);
            block
        }

        /// The program Windows is to start for `argv` and the command line
        /// it is given. A program named without a folder is found as the
        /// command prompt finds it, in the folders of `path` with the
        /// extensions of `PATHEXT`.
        ///
        /// A batch file (`.cmd`, `.bat`: how npm installs a tool) is not a
        /// program: the command prompt runs it, and reads the line by its
        /// own rules, under which an argument written for a program can end
        /// early and the rest of it run as commands. The line is therefore
        /// written as the Rust standard library writes one for a batch file
        /// (`std::process::Command`, "Windows argument splitting"), and
        /// what cannot be written safely, a line break in an argument, is
        /// refused.
        pub fn command_line(
            argv: &[OsString],
            path: Option<&OsStr>,
        ) -> io::Result<(PathBuf, Vec<u16>)> {
            let invalid = |why: &str| io::Error::new(io::ErrorKind::InvalidInput, why.to_owned());
            let (name, args) = argv
                .split_first()
                .ok_or_else(|| invalid("no program is named"))?;
            if argv.iter().any(|arg| arg.encode_wide().any(|c| c == 0)) {
                return Err(invalid("an argument holds a NUL character"));
            }
            let named = Path::new(name);
            let bare = named.components().count() == 1 && !named.has_root();
            let found = path.filter(|_| bare).and_then(|path| {
                let name = name.to_str()?;
                let exact = std::env::split_paths(path)
                    .map(|folder| folder.join(name))
                    .find(|file| file.is_file());
                exact.or_else(|| crate::roles::shim::find(name, path, |_, _| true))
            });
            let program = found.unwrap_or_else(|| named.to_owned());
            let batch = program.extension().is_some_and(|ext| {
                ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat")
            });
            let mut line = Vec::new();
            if !batch {
                quote(program.as_os_str(), &mut line);
                for arg in args {
                    line.push(u16::from(b' '));
                    quote(arg, &mut line);
                }
                line.push(0);
                return Ok((program, line));
            }
            let script: Vec<u16> = program.as_os_str().encode_wide().collect();
            if script.contains(&u16::from(b'"')) || script.last() == Some(&u16::from(b'\\')) {
                return Err(invalid("a batch file's name may not hold a quote"));
            }
            // /e:ON has the prompt read `%cd:~,%` as nothing, which is what
            // keeps a percent sign a percent sign; /v:OFF leaves `!` alone;
            // /d runs no AutoRun command; the whole command is quoted once
            // more, as /c takes it.
            line.extend("cmd.exe /e:ON /v:OFF /d /c \"\"".encode_utf16());
            line.extend(&script);
            line.push(u16::from(b'"'));
            for arg in args {
                if arg.encode_wide().any(|c| c == 13 || c == 10) {
                    let why = "a tool installed as a batch file cannot be given an argument with a line break";
                    return Err(invalid(why));
                }
                line.push(u16::from(b' '));
                quote_for_batch(arg, &mut line);
            }
            line.extend([u16::from(b'"'), 0]);
            let system = std::env::var_os("SystemRoot").map(PathBuf::from);
            let prompt = system
                .map(|root| root.join("System32").join("cmd.exe"))
                .filter(|prompt| prompt.is_file())
                .ok_or_else(|| invalid("Windows' command prompt was not found"))?;
            Ok((prompt, line))
        }

        /// One argument as a program's start-up code reads it back
        /// (`CommandLineToArgvW` and the C runtime): quoted when it is empty
        /// or holds a blank or a quote, with backslashes doubled only where
        /// a quote follows.
        fn quote(arg: &OsStr, line: &mut Vec<u16>) {
            let (quote, slash) = (u16::from(b'"'), u16::from(b'\\'));
            let plain = !arg.is_empty()
                && !arg
                    .encode_wide()
                    .any(|c| matches!(c, 0x20 | 0x09 | 0x0a | 0x0b | 0x22));
            if plain {
                line.extend(arg.encode_wide());
                return;
            }
            line.push(quote);
            let mut slashes = 0;
            for c in arg.encode_wide() {
                if c == slash {
                    slashes += 1;
                } else {
                    if c == quote {
                        line.extend(std::iter::repeat_n(slash, slashes + 1));
                    }
                    slashes = 0;
                }
                line.push(c);
            }
            line.extend(std::iter::repeat_n(slash, slashes));
            line.push(quote);
        }

        /// One argument as the command prompt hands it on to the program a
        /// batch file starts with `%*`: quoted unless it is made of letters,
        /// digits and a few signs the prompt gives no meaning, a quote
        /// doubled (which the prompt and the program both read as one), and
        /// each percent sign preceded by `%%cd:~,`, which the prompt reads
        /// as the start of nothing, so that no variable is put in its place.
        fn quote_for_batch(arg: &OsStr, line: &mut Vec<u16>) {
            let (quote, slash) = (u16::from(b'"'), u16::from(b'\\'));
            let chars: Vec<u16> = arg.encode_wide().collect();
            let known = |c: &u16| {
                let c = char::from_u32(u32::from(*c));
                c.is_some_and(|c| {
                    !c.is_control()
                        && (!c.is_ascii()
                            || c.is_ascii_alphanumeric()
                            || r"#$*+-./:?@\_".contains(c))
                })
            };
            let quoted =
                chars.is_empty() || chars.last() == Some(&slash) || !chars.iter().all(known);
            if quoted {
                line.push(quote);
            }
            let mut slashes = 0;
            for &c in &chars {
                if c == slash {
                    slashes += 1;
                } else {
                    if c == quote {
                        line.extend(std::iter::repeat_n(slash, slashes));
                        line.push(quote);
                    } else if c == u16::from(b'%') {
                        line.extend("%%cd:~,".encode_utf16());
                    }
                    slashes = 0;
                }
                line.push(c);
            }
            if quoted {
                line.extend(std::iter::repeat_n(slash, slashes));
                line.push(quote);
            }
        }

        #[cfg(test)]
        mod tests {
            use super::*;

            fn text(line: &[u16]) -> String {
                String::from_utf16(line.strip_suffix(&[0]).unwrap()).unwrap()
            }

            fn args(args: &[&str]) -> Vec<OsString> {
                args.iter().map(OsString::from).collect()
            }

            #[test]
            fn a_program_s_arguments_are_quoted_as_its_start_up_code_reads_them() {
                let argv = args(&[
                    r"C:\tools\tool.exe",
                    "plain",
                    "two words",
                    "",
                    r#"say "hi""#,
                    r"ends in a slash\",
                    r#"{"a":"b\"}"#,
                ]);
                let (program, line) = command_line(&argv, None).unwrap();
                assert_eq!(program, Path::new(r"C:\tools\tool.exe"));
                assert_eq!(
                    text(&line),
                    r#"C:\tools\tool.exe plain "two words" "" "say \"hi\"" "ends in a slash\\" "{\"a\":\"b\\\"}""#
                );
            }

            #[test]
            fn a_batch_file_s_arguments_are_written_for_the_command_prompt() {
                let argv = args(&[
                    r"C:\npm\tool.cmd",
                    "plain",
                    "two words",
                    r#"{"hooks":{"Stop":"a & b"}}"#,
                    "100%",
                    "a&b|c<d>e^f",
                    r"ends in a slash\",
                ]);
                let (program, line) = command_line(&argv, None).unwrap();
                assert!(program.ends_with(r"System32\cmd.exe"), "{program:?}");
                assert_eq!(
                    text(&line),
                    r#"cmd.exe /e:ON /v:OFF /d /c ""C:\npm\tool.cmd" plain "two words" "{""hooks"":{""Stop"":""a & b""}}" "100%%cd:~,%" "a&b|c<d>e^f" "ends in a slash\\"""#
                );
            }

            #[test]
            fn a_batch_file_is_refused_an_argument_with_a_line_break() {
                for bad in ["two\nlines", "two\rlines"] {
                    let argv = args(&[r"C:\npm\tool.CMD", bad]);
                    let refused = command_line(&argv, None).unwrap_err();
                    assert_eq!(refused.kind(), io::ErrorKind::InvalidInput);
                    assert!(refused.to_string().contains("line break"), "{refused}");
                }
                // A program takes it as it is.
                assert!(command_line(&args(&[r"C:\tools\tool.exe", "two\nlines"]), None).is_ok());
                assert!(command_line(&args(&[r#"C:\npm\a"b.cmd"#]), None).is_err());
            }
        }
    }

    /// The person's Credential Manager (design §8, "Keys"): one generic
    /// credential by name, kept on this machine for this user.
    pub mod credential {
        use std::io;
        use std::ptr::null_mut;
        use windows_sys::Win32::Foundation::ERROR_NOT_FOUND;
        use windows_sys::Win32::Security::Credentials::{
            CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree,
            CredReadW, CredWriteW,
        };

        fn wide(text: &str) -> Vec<u16> {
            text.encode_utf16().chain([0]).collect()
        }

        /// The last error, or nothing when it says there is no such credential.
        fn unless_absent() -> io::Result<()> {
            let e = io::Error::last_os_error();
            match e.raw_os_error() == Some(ERROR_NOT_FOUND as i32) {
                true => Ok(()),
                false => Err(e),
            }
        }

        /// Stores `secret` under `target`, in place of any before.
        pub fn write(target: &str, secret: &[u8]) -> io::Result<()> {
            let (mut name, mut user) = (wide(target), wide("Tasktap"));
            let mut secret = secret.to_vec();
            // SAFETY: a CREDENTIALW of zeros is a valid one with nothing set.
            let mut credential: CREDENTIALW = unsafe { std::mem::zeroed() };
            credential.Type = CRED_TYPE_GENERIC;
            credential.TargetName = name.as_mut_ptr();
            credential.UserName = user.as_mut_ptr();
            credential.CredentialBlobSize = secret.len() as u32;
            credential.CredentialBlob = secret.as_mut_ptr();
            credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
            // SAFETY: every pointer in `credential` is to a buffer that
            // outlives the call, the texts ending in a zero, the secret of
            // the size given; the system copies what it keeps.
            match unsafe { CredWriteW(&credential, 0) } {
                0 => Err(io::Error::last_os_error()),
                _ => Ok(()),
            }
        }

        /// The secret under `target`, or none.
        pub fn read(target: &str) -> io::Result<Option<Vec<u8>>> {
            let name = wide(target);
            let mut found: *mut CREDENTIALW = null_mut();
            // SAFETY: `name` ends in a zero and `found` is a valid place for
            // the one pointer written.
            if unsafe { CredReadW(name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut found) } == 0 {
                return unless_absent().map(|()| None);
            }
            // SAFETY: on success `found` points to a credential the system
            // keeps until CredFree, which is called once, after the copy;
            // its blob is of the size it names, and is not read when empty.
            let secret = unsafe {
                let credential = &*found;
                let secret = match credential.CredentialBlobSize as usize {
                    0 => Vec::new(),
                    size => std::slice::from_raw_parts(credential.CredentialBlob, size).to_vec(),
                };
                CredFree(found.cast());
                secret
            };
            Ok(Some(secret))
        }

        /// Removes the credential under `target`; none there is no failure.
        pub fn delete(target: &str) -> io::Result<()> {
            let name = wide(target);
            // SAFETY: `name` ends in a zero and is borrowed for the call.
            match unsafe { CredDeleteW(name.as_ptr(), CRED_TYPE_GENERIC, 0) } {
                0 => unless_absent(),
                _ => Ok(()),
            }
        }
    }
}
