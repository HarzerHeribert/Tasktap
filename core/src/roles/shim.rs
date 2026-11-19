//! The shim (design §4): this program named after an agent, in the shim
//! folder a Tasktap shell puts first on its PATH. When a person types the
//! agent's name it finds the real agent and either steps aside, running it
//! untouched, or adopts it: the core makes it a session of the shell's
//! terminal, and the shim runs it as its child with its hooks attached,
//! waits, restores the terminal and reports the exit, since the core is the
//! parent of the shell only. Until the agent exits it answers `shim.hold`.
//!
//! The rules of when to step aside and which approval policy to add are
//! those of `scripts/tasktap_shell.py`, carried over as they were; they
//! live with the agents (`agents::rules`).

use std::ffi::{OsStr, OsString};
use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, mpsc};
use std::time::Instant;

use tasktap_proto::call::{self, Call, Code, Error};
use tasktap_proto::{Adopt, Control, Event, Frame, Outcome, Reply, SessionEvent, Uuid};

use super::{Bound, FAILED, Fail, SOCKET, TOKEN, WAIT};
pub use crate::agents::rules::{Rules, named};
use crate::agents::{self, Agent};
use crate::client::Client;
use crate::sys;

/// The shim folder of a data folder: `<data>/shims`.
pub const SHIMS: &str = "shims";

/// Makes `<data>/shims` hold this program under each agent's name and as
/// `tasktap`, which hooks and `tasktap ask` run; a link where the system
/// allows one. The core's shells put the folder first on their PATH.
///
/// On macOS the link is symbolic. A hard link gives the program a second
/// name, and the system's check of each program it starts may then look
/// for it under one name in the other's folder, a file that does not
/// exist, and kill the program it could not read: a shim, or a core or
/// hook started under the program's own name. A symbolic link leaves the
/// program one name.
pub fn install(data: &Path, exe: &Path) -> io::Result<PathBuf> {
    let folder = data.join(SHIMS);
    // A core a hook started runs from the folder, which is filled already.
    if exe.parent() == Some(folder.as_path()) {
        return Ok(folder);
    }
    std::fs::create_dir_all(&folder)?;
    for name in agents::rules::shimmed().chain(["tasktap"]) {
        let shim = folder
            .join(name)
            .with_extension(std::env::consts::EXE_EXTENSION);
        match std::fs::remove_file(&shim) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
        if link(exe, &shim).is_err() {
            std::fs::copy(exe, &shim)?;
        }
    }
    Ok(folder)
}

pub fn run(rules: &'static Rules, args: Vec<OsString>) -> ExitCode {
    #[cfg(feature = "fixtures")]
    if rules.agent == super::fixture::AGENT && std::env::var_os(super::fixture::REAL).is_some() {
        return super::fixture::run(args);
    }
    let Some(real) = real(rules.agent) else {
        let _ = writeln!(
            io::stderr(),
            "tasktap: {} is not installed on this shell's PATH",
            rules.agent
        );
        return ExitCode::from(127);
    };
    let words: Vec<String> = (args.iter())
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let observed = agents::find(rules.agent)
        .filter(|_| terminal() && std::env::var_os(TOKEN).is_some() && rules.interactive(&words));
    let Some(agent) = observed else {
        return pass(&real, args);
    };
    // A core that does not answer never keeps the person from their agent.
    let (adopted, waited) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = adopted.send(adopt(agent));
    });
    let adopted = waited.recv_timeout(WAIT).unwrap_or_else(|_| {
        let why = format!("the core did not answer within {} s", WAIT.as_secs());
        Err(Some(Fail(FAILED, why)))
    });
    match adopted {
        Ok(link) => observe(agent, rules, &real, args, &words, link),
        // The terminal has an observed agent already: this one runs inside it.
        Err(None) => pass(&real, args),
        Err(Some(Fail(_, why))) => {
            let _ = writeln!(
                io::stderr(),
                "tasktap: {} runs unobserved: {why}",
                rules.agent
            );
            pass(&real, args)
        }
    }
}

/// Standard input and output are a terminal a person types in.
#[cfg(target_os = "macos")]
fn link(exe: &Path, shim: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(exe, shim)
}

#[cfg(not(target_os = "macos"))]
fn link(exe: &Path, shim: &Path) -> io::Result<()> {
    std::fs::hard_link(exe, shim)
}

fn terminal() -> bool {
    #[cfg(feature = "fixtures")]
    if std::env::var_os(super::fixture::TTY).is_some() {
        return true;
    }
    io::stdin().is_terminal() && io::stdout().is_terminal()
}

/// The agent's own executable: the first on the PATH that is no shim. The
/// shim folder of the core this shell belongs to is skipped, and so is any
/// file that is this program.
fn real(name: &str) -> Option<PathBuf> {
    let me = std::env::current_exe().ok();
    let shims = std::env::var_os(SOCKET)
        .and_then(|socket| Some(Path::new(&socket).parent()?.join(SHIMS)))
        .and_then(|shims| std::fs::canonicalize(shims).ok());
    find(name, &std::env::var_os("PATH")?, |folder, file| {
        !(shims.is_some() && std::fs::canonicalize(folder).ok() == shims)
            && !me.as_deref().is_some_and(|me| same(me, file))
    })
}

/// The first runnable file named `name` in the folders of `path`, as a
/// shell finds a program, that `take` accepts given its folder.
pub fn find(name: &str, path: &OsStr, take: impl Fn(&Path, &Path) -> bool) -> Option<PathBuf> {
    for folder in std::env::split_paths(path) {
        if folder.as_os_str().is_empty() {
            continue;
        }
        for file in candidates(&folder, name) {
            if runnable(&file) && take(&folder, &file) {
                return Some(file);
            }
        }
    }
    None
}

#[cfg(unix)]
fn candidates(folder: &Path, name: &str) -> Vec<PathBuf> {
    vec![folder.join(name)]
}

/// Each extension of `PATHEXT`, as the command prompt tries them.
#[cfg(windows)]
fn candidates(folder: &Path, name: &str) -> Vec<PathBuf> {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    (exts.split(';').filter(|e| !e.is_empty()))
        .map(|ext| folder.join(format!("{name}{}", ext.to_ascii_lowercase())))
        .collect()
}

#[cfg(unix)]
fn runnable(file: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(file).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
fn runnable(file: &Path) -> bool {
    file.is_file()
}

/// Whether two paths name one file, through any link.
#[cfg(unix)]
fn same(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(a), Ok(b)) => (a.dev(), a.ino()) == (b.dev(), b.ino()),
        _ => false,
    }
}

/// A hard link is not told apart here; the shim folder is skipped by name.
#[cfg(windows)]
fn same(a: &Path, b: &Path) -> bool {
    std::fs::canonicalize(a).ok() == std::fs::canonicalize(b).ok()
}

/// Runs the real agent untouched, as if the shim were not there.
fn pass(real: &Path, args: Vec<OsString>) -> ExitCode {
    let mut agent = Command::new(real);
    agent.args(args);
    #[cfg(feature = "fixtures")]
    agent.env(super::fixture::REAL, "1");
    #[cfg(unix)]
    {
        let e = std::os::unix::process::CommandExt::exec(&mut agent);
        let _ = writeln!(
            io::stderr(),
            "tasktap: {} could not run: {e}",
            real.display()
        );
        ExitCode::from(126)
    }
    // No exec: the shim waits and passes the exit on.
    #[cfg(windows)]
    match agent.status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(e) => {
            let _ = writeln!(
                io::stderr(),
                "tasktap: {} could not run: {e}",
                real.display()
            );
            ExitCode::from(126)
        }
    }
}

/// `session.adopt` on a connection that offers `shim.hold`. `Err(None)` when
/// the terminal already has a live session.
fn adopt(agent: &'static dyn Agent) -> Result<Client, Option<Fail>> {
    let hold = call::Name::ShimHold.as_str().to_owned();
    let mut link = super::session("shim", vec![hold])?;
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned());
    let adopt = Adopt {
        agent: agent.id().into(),
        cwd: cwd.unwrap_or_default(),
    };
    match link.call::<call::SessionAdopt>(&adopt) {
        Ok(Ok(_)) => Ok(link),
        Ok(Err(e)) if e.code == Code::Conflict => Err(None),
        Ok(Err(e)) => Err(Some(Fail(FAILED, e.message))),
        Err(e) => Err(Some(super::ended(e))),
    }
}

/// Runs the adopted agent as this process's child and returns its exit.
fn observe(
    agent: &dyn Agent,
    rules: &Rules,
    real: &Path,
    args: Vec<OsString>,
    words: &[String],
    link: Client,
) -> ExitCode {
    let exe = super::program().unwrap_or_else(|_| "tasktap".into());
    let mut run = Command::new(real);
    // Its files, where it reads its hooks from one, in its folder of the
    // data folder; one that cannot be written leaves it to run untouched.
    let data = std::env::var_os("TASKTAP_DATA").unwrap_or_default();
    let home = agents::home(Path::new(&data), agent);
    if let Err(why) = agents::checks::keep(&home, &agent.files(&exe)) {
        let _ = writeln!(
            io::stderr(),
            "tasktap: {} runs unobserved: {why}",
            rules.agent
        );
        drop(link);
        return pass(real, args);
    }
    run.args(agent.attach(&exe, &home));
    run.envs(agent.environment(&exe, &home));
    // The check its hooks need, with the agent the shim found. One that
    // fails leaves the agent to run untouched, its session ended with this
    // connection.
    let cwd = std::env::current_dir().unwrap_or_default();
    if let Some(mut probe) = agent.probe(&exe, &cwd) {
        probe.argv[0] = real.to_string_lossy().into_owned();
        match agents::checks::probe(probe, &cwd) {
            Ok(more) => {
                run.args(more);
            }
            Err(why) => {
                let _ = writeln!(
                    io::stderr(),
                    "tasktap: {} runs unobserved: {why}",
                    rules.agent
                );
                drop(link);
                return pass(real, args);
            }
        }
    }
    run.args(rules.approval(words)).args(args);
    #[cfg(feature = "fixtures")]
    run.env(super::fixture::REAL, "1");
    let modes = sys::modes();
    let (mut child, tree) = match sys::Tree::attached(&mut run) {
        Ok(spawned) => spawned,
        // The adopted session ends with this connection.
        Err(e) => {
            let _ = writeln!(
                io::stderr(),
                "tasktap: {} could not run: {e}",
                real.display()
            );
            return ExitCode::from(126);
        }
    };
    let hold = Arc::new(Hold::default());
    let tty = io::stdin().is_terminal();
    let agent = child.id();
    std::thread::spawn({
        let hold = hold.clone();
        move || answer(link, &hold, tty, agent, &tree)
    });
    let status = {
        let _interrupts = sys::ignore_interrupts();
        child.wait()
    };
    let typed = hold.ended();
    if let Some(modes) = &modes {
        // Leaves the modes a full-screen agent set, without clearing the screen.
        if io::stdout().is_terminal() {
            let _ = io::stdout().write_all(RELEASE);
        }
        // A follow-up the agent never read must not reach the shell.
        sys::restore(modes, typed);
    }
    let code = status.map_or(1, |status| code(&status));
    report(code);
    std::process::exit(code)
}

/// Mouse, focus, paste, keyboard and screen modes off, the cursor shown.
pub(crate) const RELEASE: &[u8] = b"\x1b[?9;1000;1002;1003;1004;1005;1006;1015;1016;2004;2026l\x1b[?1l\x1b>\x1b[<u\x1b[=0u\x1b[>4;0m\x1b[?47l\x1b[0m\x1b[?25h";

#[cfg(unix)]
fn code(status: &std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
}

#[cfg(windows)]
fn code(status: &std::process::ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

/// Tells the core the agent exited, on a connection of its own: the first is
/// read on another thread, which a Windows pipe does not allow beside a write.
/// If this fails the first connection's end, as the process exits, ends the
/// session all the same.
fn report(code: i32) {
    let _bound = Bound::new(code);
    let exited = SessionEvent {
        id: format!("exited {}", Uuid::now_v7()),
        turn: None,
        subagent: false,
        resume: None,
        event: Event::Exited {
            code: u32::try_from(code).ok(),
        },
    };
    let sent = super::session("shim", Vec::new()).and_then(|mut c| {
        match c.call::<call::SessionEvent>(&exited) {
            // Its session ended before, as when the person stopped it in Tasktap.
            Ok(Ok(()))
            | Ok(Err(Error {
                code: Code::Gone, ..
            })) => Ok(()),
            Ok(Err(e)) => Err(Fail(FAILED, format!("the core refused it: {}", e.message))),
            Err(e) => Err(super::ended(e)),
        }
    });
    if let Err(Fail(_, why)) = sent {
        let _ = writeln!(
            io::stderr(),
            "tasktap: the agent's exit was not reported: {why}"
        );
    }
}

/// Whether the core may type into the terminal, as `shim.hold` asks.
#[derive(Default)]
struct Hold {
    state: Mutex<State>,
    changed: Condvar,
}

#[derive(Default)]
struct State {
    /// The agent has exited.
    ended: bool,
    /// The core is typing a follow-up.
    held: bool,
    /// A follow-up was typed during the agent's run.
    typed: bool,
    /// The connection ended: nothing will be typed any more.
    gone: bool,
}

impl Hold {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn set(&self, hold: bool, tty: bool) -> Result<(), Error> {
        let mut s = self.state();
        if !hold {
            s.held = false;
            self.changed.notify_all();
        } else if s.ended || tty && !sys::foreground() {
            return Err(Error::new(
                Code::Gone,
                "the agent does not run in the foreground",
            ));
        } else {
            (s.held, s.typed) = (true, true);
        }
        Ok(())
    }

    fn gone(&self) {
        let mut s = self.state();
        (s.gone, s.held) = (true, false);
        self.changed.notify_all();
    }

    /// The agent exited: refuses any hold from now on and waits, within
    /// [`WAIT`], for one under way to end. Whether anything was typed.
    fn ended(&self) -> bool {
        let deadline = Instant::now() + WAIT;
        let mut s = self.state();
        s.ended = true;
        if s.held && !s.gone {
            drain();
        }
        while s.held && !s.gone {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            s = (self.changed.wait_timeout(s, left))
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        s.typed
    }
}

/// Reads the terminal into nothing from now on. The agent has gone while
/// the core types a follow-up it will never read: what the core is still
/// writing goes nowhere, so the core can finish and let go, and none of it
/// is left for the shell once this returns to it. The thread ends with the
/// process.
fn drain() {
    if !io::stdin().is_terminal() {
        return;
    }
    let reads = || {
        let mut buf = [0; 4096];
        let mut input = io::stdin().lock();
        while input.read(&mut buf).is_ok_and(|n| n > 0) {}
    };
    let _ = std::thread::Builder::new()
        .name("drain".into())
        .spawn(reads);
}

/// Ends the agent, as the core asks once its run was stopped: hang-up, and
/// the kill after 2 s if it has not exited by then; on Windows the agent's
/// process tree at once. Only the agent: this shim and the shell it runs
/// in go on, and once the agent has gone the shim reports its exit.
fn end(hold: &Arc<Hold>, agent: u32, tree: &sys::Tree) {
    #[cfg(unix)]
    {
        sys::signal_process(agent, false);
        let hold = hold.clone();
        let _ = std::thread::Builder::new()
            .name("kill".into())
            .spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                if !hold.state().ended {
                    sys::signal_process(agent, true);
                }
            });
    }
    #[cfg(windows)]
    let _ = (hold, agent);
    tree.kill();
}

/// Answers the core's calls on the adopting connection until it ends.
fn answer(mut link: Client, hold: &Arc<Hold>, tty: bool, agent: u32, tree: &sys::Tree) {
    loop {
        let request = match link.recv() {
            Ok(Frame::Control(Control::Call(request))) => request,
            Ok(_) => continue,
            Err(_) => return hold.gone(),
        };
        let reply = if request.name == call::ShimHold::NAME.as_str() {
            let held = call::ShimHold::args(request.args).and_then(|h| match h.stop {
                true => {
                    end(hold, agent, tree);
                    Ok(())
                }
                false => hold.set(h.hold, tty),
            });
            call::ShimHold::reply(request.id, held)
        } else {
            let why = format!("a shim answers no {}", request.name);
            let outcome = Outcome::Err(Error::new(Code::Unknown, why));
            Control::Reply(Reply {
                id: request.id,
                outcome,
            })
        };
        if link.send(&reply).is_err() {
            return hold.gone();
        }
    }
}
