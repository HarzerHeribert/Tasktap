//! What `native.rs` is on the Mac, on Windows: the core's named pipe as a stream the bridge can
//! read on one thread and write on another, the clipboard and the power state, the folder dialog and what a
//! web view is held to. What the notch asks of a panel is the tab's window, in `edge.rs`.
pub use crate::edge::{
    app_active, focusable, frame, geometry, give_back_key, hidden, home, ignore_mouse, is_key, make_key, outline,
    pointer, screen_frame, screens, set_frame, show, watching, window_number, within, Screen,
};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, SetHandleInformation, ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_OPERATION_ABORTED,
    ERROR_PIPE_BUSY, HANDLE, HANDLE_FLAG_INHERIT,
};
use windows_sys::Win32::Security::{GetLengthSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile, FILE_FLAG_OVERLAPPED};
use windows_sys::Win32::System::Pipes::{GetNamedPipeServerProcessId, WaitNamedPipeW, NMPWAIT_WAIT_FOREVER};
use windows_sys::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, OpenProcess, OpenProcessToken, CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

// ---------------------------------------------------------------------------------------------
// The core's pipe.

struct Shared {
    file: File,
    /// `shutdown` was called: no read or write begins or stays waiting.
    closed: AtomicBool,
}

/// One end of the core's pipe (`\\.\pipe\tasktap-<digest of the data folder>`, as
/// core/src/sys.rs names it). A pipe opened the plain way lets one operation run at a time, so a
/// thread waiting to read would hold up every write; this one is opened for overlapped I/O and
/// each call waits for its own operation. A clone is the same pipe with an event of its own.
pub struct Pipe {
    shared: Arc<Shared>,
    event: Event,
}

struct Event(HANDLE);
// SAFETY: an event handle may be used and closed from any thread.
unsafe impl Send for Event {}
impl Event {
    fn new() -> io::Result<Event> {
        // SAFETY: no attributes and no name: a private, manual-reset event, not set.
        let event = unsafe { CreateEventW(null(), 1, 0, null()) };
        if event.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Event(event))
    }
}
impl Drop for Event {
    fn drop(&mut self) {
        // SAFETY: the handle is this value's own and closed once.
        unsafe { CloseHandle(self.0) };
    }
}

impl Pipe {
    /// Connects to the core serving `data`, if one listens; never to another user's process.
    pub fn connect(data: &Path) -> io::Result<Pipe> {
        let folder = std::fs::canonicalize(data)?;
        let digest = Sha256::digest(folder.as_os_str().as_encoded_bytes());
        let hex: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
        let name = format!(r"\\.\pipe\tasktap-{hex}");
        let file = loop {
            match OpenOptions::new().read(true).write(true).custom_flags(FILE_FLAG_OVERLAPPED).open(&name) {
                // Every instance is taken this moment: wait until the core offers the next.
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                    let wide: Vec<u16> = std::ffi::OsStr::new(&name).encode_wide().chain([0]).collect();
                    // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the call.
                    if unsafe { WaitNamedPipeW(wide.as_ptr(), NMPWAIT_WAIT_FOREVER) } == 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                opened => break opened?,
            }
        };
        // Pipe names are global: another user may hold this one while no core runs, and must
        // never be sent the device key.
        let mut server = 0;
        // SAFETY: the handle is an open pipe, and `server` a place for the one u32 written.
        let known = unsafe { GetNamedPipeServerProcessId(file.as_raw_handle() as HANDLE, &mut server) } != 0;
        // SAFETY: a constant pseudo handle that needs no closing.
        let me = user_of(unsafe { GetCurrentProcess() })?;
        if !known || !user_of_process(server).is_some_and(|user| user == me) {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "the core's pipe belongs to another user"));
        }
        Ok(Pipe { shared: Arc::new(Shared { file, closed: AtomicBool::new(false) }), event: Event::new()? })
    }

    pub fn try_clone(&self) -> io::Result<Pipe> {
        Ok(Pipe { shared: self.shared.clone(), event: Event::new()? })
    }

    /// Ends every read and write on the pipe, waiting or yet to come, on every clone: the
    /// threads that hold clones let go of them, and the core sees the pipe close.
    pub fn shutdown(&self, _: Shutdown) -> io::Result<()> {
        self.shared.closed.store(true, Ordering::SeqCst);
        // SAFETY: the handle is open while `shared` lives; a null OVERLAPPED cancels all of its I/O.
        unsafe { CancelIoEx(self.handle(), null()) };
        Ok(())
    }

    fn handle(&self) -> HANDLE {
        self.shared.file.as_raw_handle() as HANDLE
    }

    /// Starts one operation and waits for it. `None` is the pipe's end: the core closed it, or
    /// `shutdown` ended it.
    fn run(&mut self, start: impl FnOnce(HANDLE, *mut OVERLAPPED) -> BOOL) -> io::Result<Option<usize>> {
        if self.shared.closed.load(Ordering::SeqCst) {
            return Ok(None);
        }
        // SAFETY: an all-zero OVERLAPPED is valid; the event is this clone's own.
        let mut state: OVERLAPPED = unsafe { std::mem::zeroed() };
        state.hEvent = self.event.0;
        if start(self.handle(), &mut state) == 0 {
            // SAFETY: reads this thread's last error.
            match unsafe { GetLastError() } {
                ERROR_IO_PENDING => {}
                ERROR_BROKEN_PIPE => return Ok(None),
                code => return Err(io::Error::from_raw_os_error(code as i32)),
            }
        }
        // A shutdown that came before this operation began did not cancel it.
        if self.shared.closed.load(Ordering::SeqCst) {
            // SAFETY: cancels this operation only; `state` lives until its result is taken below.
            unsafe { CancelIoEx(self.handle(), &state) };
        }
        let mut done = 0;
        // SAFETY: `state` is the operation started above and lives through the wait, which ends
        // only once the system no longer uses it or the buffer.
        if unsafe { GetOverlappedResult(self.handle(), &state, &mut done, 1) } == 0 {
            // SAFETY: reads this thread's last error.
            return match unsafe { GetLastError() } {
                ERROR_BROKEN_PIPE | ERROR_OPERATION_ABORTED => Ok(None),
                code => Err(io::Error::from_raw_os_error(code as i32)),
            };
        }
        Ok(Some(done as usize))
    }
}

impl Read for Pipe {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let len = buf.len().min(u32::MAX as usize) as u32;
        // SAFETY: `buf` is valid for `len` bytes until `run` has the operation's result.
        let read = self.run(|pipe, state| unsafe { ReadFile(pipe, buf.as_mut_ptr(), len, null_mut(), state) })?;
        Ok(read.unwrap_or(0))
    }
}

impl Write for Pipe {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let len = buf.len().min(u32::MAX as usize) as u32;
        // SAFETY: `buf` is valid for `len` bytes until `run` has the operation's result.
        let wrote = self.run(|pipe, state| unsafe { WriteFile(pipe, buf.as_ptr(), len, null_mut(), state) })?;
        wrote.ok_or_else(|| io::ErrorKind::BrokenPipe.into())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn user_of_process(pid: u32) -> Option<Vec<u8>> {
    // SAFETY: plain call; a null result is checked before use, and the handle closed once.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            // A process this user may not even inspect is not this user's.
            return None;
        }
        let user = user_of(process).ok();
        CloseHandle(process);
        user
    }
}

/// The user SID of a process, copied out of its access token (as core/src/sys.rs reads it).
/// SIDs are canonical, so equal bytes mean the same user.
fn user_of(process: HANDLE) -> io::Result<Vec<u8>> {
    let mut token = null_mut();
    // SAFETY: `process` is a process handle; `token` receives a handle closed below.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut len = 0;
    // SAFETY: a null buffer of length 0 only asks for the size, written to `len`.
    unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut len) };
    // Whole u64 words, so the TOKEN_USER at the start is aligned.
    let mut buf = vec![0u64; (len as usize).div_ceil(8)];
    // SAFETY: `buf` has room for `len` bytes; the token is open and closed once.
    let ok = unsafe {
        let ok = GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), len, &mut len);
        CloseHandle(token);
        ok
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: on success `buf` starts with a TOKEN_USER whose SID points into `buf`, which
    // outlives this read, and GetLengthSid is its size.
    unsafe {
        let sid = (*buf.as_ptr().cast::<TOKEN_USER>()).User.Sid;
        Ok(std::slice::from_raw_parts(sid.cast::<u8>(), GetLengthSid(sid) as usize).to_vec())
    }
}

/// A core started by this app has no console and outlives it (as core/src/sys.rs detaches one).
/// Windows hands a child every handle that may be inherited, and this process's standard
/// handles may, having been inherited themselves: the core would keep them open for as long as
/// it runs, and whoever started this app would wait for their end.
pub fn detach(serve: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    serve.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    for handle in [io::stdin().as_raw_handle(), io::stdout().as_raw_handle(), io::stderr().as_raw_handle()] {
        // SAFETY: changes one flag of a handle this process holds; one it has not is refused.
        unsafe { SetHandleInformation(handle as HANDLE, HANDLE_FLAG_INHERIT, 0) };
    }
}

// ---------------------------------------------------------------------------------------------
// The clipboard and the power state.

/// A passive run's clipboard (the checks): its own, never the person's.
static PRIVATE: Mutex<Option<String>> = Mutex::new(None);

/// The clipboard's text, or with `text`, the clipboard set to it.
pub fn clipboard(text: Option<&str>, private: bool) -> Option<String> {
    if private {
        let mut held = PRIVATE.lock().unwrap();
        return match text {
            Some(text) => {
                *held = Some(text.to_owned());
                None
            }
            None => held.clone(),
        };
    }
    match text {
        Some(text) => {
            clipboard::set(text);
            None
        }
        None => clipboard::get(),
    }
}

mod clipboard {
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{GlobalFree, HANDLE};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    /// CF_UNICODETEXT: UTF-16 text ended by a NUL.
    const TEXT: u32 = 13;

    pub fn get() -> Option<String> {
        // SAFETY: the clipboard is opened and closed in this call; the block it hands out stays
        // the clipboard's, is locked while read, and holds NUL-terminated UTF-16 text.
        unsafe {
            if OpenClipboard(null_mut()) == 0 {
                return None;
            }
            let block = GetClipboardData(TEXT);
            let chars = if block.is_null() { null_mut() } else { GlobalLock(block).cast::<u16>() };
            let text = (!chars.is_null()).then(|| {
                let len = (0..).take_while(|&i| *chars.add(i) != 0).count();
                let text = String::from_utf16_lossy(std::slice::from_raw_parts(chars, len));
                GlobalUnlock(block);
                text
            });
            CloseClipboard();
            text
        }
    }

    pub fn set(text: &str) {
        let wide: Vec<u16> = text.encode_utf16().chain([0]).collect();
        // SAFETY: the block is this call's until the clipboard takes it, and is freed here when
        // it does not; it is written within its size while locked.
        unsafe {
            let block = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2);
            if block.is_null() {
                return;
            }
            let to = GlobalLock(block).cast::<u16>();
            if to.is_null() {
                GlobalFree(block);
                return;
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), to, wide.len());
            GlobalUnlock(block);
            let taken = OpenClipboard(null_mut()) != 0 && {
                EmptyClipboard();
                let taken = !SetClipboardData(TEXT, block as HANDLE).is_null();
                CloseClipboard();
                taken
            };
            if !taken {
                GlobalFree(block);
            }
        }
    }
}

/// Whether Windows saves energy (battery saver), as Low Power Mode is on the Mac.
pub fn low_power() -> bool {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    // SAFETY: an all-zero SYSTEM_POWER_STATUS is valid, and the call writes only into it.
    unsafe {
        let mut status: SYSTEM_POWER_STATUS = std::mem::zeroed();
        GetSystemPowerStatus(&mut status) != 0 && status.SystemStatusFlag == 1
    }
}

/// Not built: the page asks `host.power` once and is not told of a change (it needs a window
/// to receive `WM_POWERBROADCAST`).
pub fn watch_power(_changed: impl Fn() + 'static) {}

// ---------------------------------------------------------------------------------------------
// The folder dialog, what a web view is held to, and a page's picture.

/// The system's own folder dialog, modal to the window `owner`: the folder the person chose, as they know it (no
/// `\\?\` in front), or none when they closed it without choosing, which is no error. It starts where Windows
/// keeps for this app: in the folder last chosen from, and the first time in the person's own folder; or in `at`,
/// where the person keeps their projects, when the page names it. It runs a
/// message loop of its own until it is closed, so it must be called from the event loop and never from inside one
/// of the web view's callbacks (WebView2 allows no nested loop there: main.rs, `bridge_host`).
pub fn pick_folder(owner: Option<isize>, at: Option<&str>) -> Result<Option<PathBuf>, String> {
    use windows::core::{GUID, HSTRING};
    use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, IShellItem, SHCreateItemFromParsingName, FOS_FORCEFILESYSTEM,
        FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
    };
    /// What Windows keeps this dialog's last folder under: this app's Open Workspace, and no other dialog's.
    const OPEN_WORKSPACE: GUID = GUID::from_u128(0x7a51_c6f2_3b0e_4d7a_9c41_5e0f_2a8d_b613);
    let said = |e: windows::core::Error| format!("The folder dialog could not be shown: {}", e.message());
    // SAFETY: on the thread of the event loop, which tao has made a COM apartment; every pointer is one the
    // call just returned, and the name is freed with the allocator that made it.
    unsafe {
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).map_err(said)?;
        let options = dialog.GetOptions().map_err(said)?;
        dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST).map_err(said)?;
        let _ = dialog.SetClientGuid(&OPEN_WORKSPACE);
        if let Some(home) = std::env::var_os("USERPROFILE") {
            let home: windows::core::Result<IShellItem> =
                SHCreateItemFromParsingName(&HSTRING::from(home.as_os_str()), None);
            if let Ok(home) = home {
                let _ = dialog.SetDefaultFolder(&home);
            }
        }
        // Where the person keeps their projects, when the page knows it: over the folder last chosen from.
        if let Some(at) = at {
            let at: windows::core::Result<IShellItem> = SHCreateItemFromParsingName(&HSTRING::from(at), None);
            if let Ok(at) = at {
                let _ = dialog.SetFolder(&at);
            }
        }
        match dialog.Show(owner.map(|window| HWND(window as *mut _))) {
            Ok(()) => {}
            Err(e) if e.code() == ERROR_CANCELLED.to_hresult() => return Ok(None),
            Err(e) => return Err(said(e)),
        }
        let name = dialog.GetResult().and_then(|item| item.GetDisplayName(SIGDN_FILESYSPATH)).map_err(said)?;
        let folder = name.to_string().map_err(|_| "The folder's name is not one Tasktap can keep".to_owned());
        CoTaskMemFree(Some(name.0.cast()));
        folder.map(|folder| Some(PathBuf::from(folder)))
    }
}

/// Holds the workspace's web view to what a preview's frame may do (frames.rs), by WebView2's own means, since
/// WebView2 has no rule list as WebKit has:
///
/// - **Where a frame may go.** WebView2 asks about every frame's navigation apart from the top one's, redirects
///   among them: only this machine's own addresses and an empty frame go on (`frames::goes`); anything else is
///   cancelled and told to `stopped`. (The top frame is Tauri's to ask about, and a window a frame asks for is
///   Tauri's to deny: workspace.rs, on every system.)
/// - **What may be loaded.** Every request of the web view, of any kind, from any frame or worker, is asked about
///   before it is sent: one that would leave this machine is answered here with a refusal (`frames::loads`). A
///   socket is not asked about; it is stopped by what the browser is started with (`frames::BROWSER`), as is
///   anything else that would get past this.
///
/// False when the web view is too old to ask about every request (before 1.0.2478); then no preview gets a frame.
pub fn confine(view: &tauri::webview::PlatformWebview, stopped: impl Fn(&str) + 'static) -> bool {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_22, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
    };
    use webview2_com::{take_pwstr, NavigationStartingEventHandler, WebResourceRequestedEventHandler};
    use windows_core::{Interface, HSTRING, PWSTR};
    let environment = view.environment();
    // SAFETY: on the web view's own thread, where Tauri runs this, on a view that is open; each string is the
    // web view's to give and is taken over as it asks.
    let done: windows_core::Result<()> = (|| unsafe {
        let core = view.controller().CoreWebView2()?;
        let mut token = 0i64;
        core.add_FrameNavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                if !crate::frames::goes(&uri) {
                    args.SetCancel(true)?;
                    stopped(&uri);
                }
                Ok(())
            })),
            &mut token,
        )?;
        core.cast::<ICoreWebView2_22>()?.AddWebResourceRequestedFilterWithRequestSourceKinds(
            &HSTRING::from("*"),
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
        )?;
        core.add_WebResourceRequested(
            &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = PWSTR::null();
                args.Request()?.Uri(&mut uri)?;
                if !crate::frames::loads(&take_pwstr(uri)) {
                    let refusal = environment.CreateWebResourceResponse(
                        None,
                        403,
                        &HSTRING::from("Forbidden"),
                        &HSTRING::from("Content-Type: text/plain"),
                    )?;
                    args.SetResponse(&refusal)?;
                }
                Ok(())
            })),
            &mut token,
        )?;
        Ok(())
    })();
    done.is_ok()
}

/// Whether a window's web view is seen: WebView2 goes on drawing a page whose window is minimised, and makes it hidden
/// (`document.hidden`, no frames, timers slowed) only when told. Told only when it changes.
pub fn seen(window: &tauri::WebviewWindow, on: bool) {
    static SEEN: AtomicBool = AtomicBool::new(true);
    if SEEN.swap(on, Ordering::Relaxed) == on {
        return;
    }
    // SAFETY: on the web view's own thread, where Tauri runs this, on a view that is open.
    let _ = window.with_webview(move |view| unsafe {
        let _ = view.controller().SetIsVisible(on);
    });
    crate::log(serde_json::json!({"event": "window", "seen": on}));
}

/// A page as its web view draws it, written to `path` as PNG; `done` is told whether it was.
pub fn snapshot(view: &tauri::webview::PlatformWebview, path: &Path, done: impl Fn(bool) + 'static) {
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::Win32::System::Com::{STGM_CREATE, STGM_SHARE_DENY_WRITE, STGM_WRITE};
    use windows::Win32::UI::Shell::SHCreateStreamOnFileEx;
    use windows_core::HSTRING;
    let done = std::rc::Rc::new(done);
    let told = done.clone();
    // SAFETY: on the web view's own thread, on a view that is open; the file is the stream's until the web view
    // lets go of it, after the picture is written.
    let asked: windows_core::Result<()> = (|| unsafe {
        let file = SHCreateStreamOnFileEx(
            &HSTRING::from(path.as_os_str()),
            (STGM_CREATE | STGM_WRITE | STGM_SHARE_DENY_WRITE).0,
            0x80,
            true,
            None,
        )?;
        view.controller().CoreWebView2()?.CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
            &file,
            &CapturePreviewCompletedHandler::create(Box::new(move |result| {
                told(result.is_ok());
                Ok(())
            })),
        )
    })();
    if asked.is_err() {
        done(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_passive_run_keeps_a_clipboard_of_its_own() {
        assert_eq!(clipboard(Some("copied by a check"), true), None);
        assert_eq!(clipboard(None, true).as_deref(), Some("copied by a check"));
    }

    #[test]
    fn a_folder_no_core_serves_has_no_pipe() {
        let folder = std::env::temp_dir();
        assert!(Pipe::connect(&folder).is_err());
    }

    /// Both ends of a pipe of this process's own, opened as `connect` opens the core's: a read
    /// that waits does not hold up a write, and `shutdown` ends a read that waits.
    #[test]
    fn a_waiting_read_holds_up_no_write_and_shutdown_ends_it() {
        use std::os::windows::io::FromRawHandle;
        use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
        use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, PIPE_TYPE_BYTE};
        let name = format!(r"\\.\pipe\tasktap-host-test-{}", std::process::id());
        let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
        // SAFETY: a NUL-terminated name, default security, one instance; the handle is checked.
        let server =
            unsafe { CreateNamedPipeW(wide.as_ptr(), PIPE_ACCESS_DUPLEX, PIPE_TYPE_BYTE, 1, 4096, 4096, 0, null()) };
        assert!(!server.is_null() && server as isize != -1, "{}", io::Error::last_os_error());
        // SAFETY: the handle was just made and is owned by this file from here on.
        let mut server = unsafe { File::from_raw_handle(server.cast()) };
        let file = OpenOptions::new().read(true).write(true).custom_flags(FILE_FLAG_OVERLAPPED).open(&name).unwrap();
        // SAFETY: the server's handle is open; the client connected already, which is no error.
        unsafe { ConnectNamedPipe(server.as_raw_handle() as HANDLE, null_mut()) };
        let mut client =
            Pipe { shared: Arc::new(Shared { file, closed: AtomicBool::new(false) }), event: Event::new().unwrap() };
        let mut reader = client.try_clone().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let reading = std::thread::spawn(move || {
            let mut buf = [0u8; 64];
            loop {
                let n = reader.read(&mut buf).unwrap();
                tx.send(buf[..n].to_vec()).unwrap();
                if n == 0 {
                    break;
                }
            }
        });
        // The reader waits; a write on the same pipe goes through at once all the same.
        std::thread::sleep(std::time::Duration::from_millis(100));
        client.write_all(b"from the page").unwrap();
        let mut got = [0u8; 13];
        server.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"from the page");
        server.write_all(b"from the core").unwrap();
        assert_eq!(rx.recv().unwrap(), b"from the core");
        client.shutdown(Shutdown::Both).unwrap();
        assert_eq!(rx.recv().unwrap(), b"", "shutdown ends the read that waits");
        reading.join().unwrap();
        assert_eq!(client.read(&mut got).unwrap(), 0);
        assert!(client.write(b"more").is_err());
    }
}
