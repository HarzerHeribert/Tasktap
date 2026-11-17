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
        /// Puts `process`, a process handle, in a new job.
        pub fn new(process: RawHandle) -> io::Result<Job> {
            // SAFETY: null attributes and name ask for an unnamed job with
            // default security; the handle is checked before use.
            let job = unsafe { CreateJobObjectW(null(), null()) };
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Job(job);
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
            // SAFETY: both handles are open for the call.
            if set == 0 || unsafe { AssignProcessToJobObject(job.0, process as HANDLE) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
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
