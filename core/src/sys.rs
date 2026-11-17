//! What differs between platforms, and nothing else (design §2): the data
//! folder, the listener and its peer check, the client's end, starting the
//! service detached, and the signals that end it. Mac and Linux use the socket
//! file `<data>/core.sock`; Windows uses a named pipe. Also what a shim does
//! to the terminal it shares with its agent (design §4).

pub use tty::*;
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
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::path::Path;
    use std::process::Command;
    use std::ptr::{null, null_mut};
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_PIPE_BUSY, HANDLE};
    use windows_sys::Win32::Security::{
        GetLengthSid, GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows_sys::Win32::System::IO::CancelIoEx;
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
    pub fn hang_up(pipe: &Stream) {
        // SAFETY: the handle is open for the call, and a null OVERLAPPED
        // cancels every I/O in flight on it; mio takes a cancelled
        // operation back like any failed one.
        unsafe { CancelIoEx(pipe.as_raw_handle() as HANDLE, null()) };
    }

    /// No console, so the client's Ctrl-C and closing its window leave it running.
    pub fn detach(cmd: &mut Command) {
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
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
}
