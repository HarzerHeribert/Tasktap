//! Terminals (design §9): real processes the core owns, their output always
//! drained into a ring whether or not anyone watches, clients attached over
//! streams at positions of their own, and history kept across exits and
//! restarts.
//!
//! A terminal's row is committed before its process starts, so an id the
//! store knows is never started again (design §3): a terminal that exited,
//! or was lost with a core that crashed, is replayed from its history.
//! Closing a tab closes its stream and nothing else.

#[cfg(feature = "fixtures")]
pub mod fixture;
mod process;
mod queries;
mod ring;

use crate::calls::Cx;
use crate::effects::{self, stored};
use crate::serve::{self, Core};
use crate::state::{self, Error as Refused};
use crate::store::AttemptKind;
use crate::stream;
use process::{Plan, Process, Report};
use ring::{Attachment, Feed, INPUT, Saved, Term};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::{Rc, Weak};
use std::time::Duration;
use tasktap_proto::{
    CloseProject, Code, Error, MAX_TERMINAL_SIZE, Offset, OpenTerminal, Opened, ProjectId, Ref,
    ResizeTerminal, Rev, Secret, Size, StartTerminal, Terminal, TerminalId, TerminalKind,
    TerminalState,
};
use tokio::sync::mpsc;

/// How long a stopped process tree has after hang-up before it is killed.
pub const KILL: Duration = Duration::from_secs(2);
/// How long output may go on after the child exited, from processes it
/// left holding the terminal, before the terminal ends without it.
const LINGER: Duration = Duration::from_secs(1);

/// The terminals running in this core.
pub struct Terminals {
    live: HashMap<TerminalId, Live>,
    data: PathBuf,
    /// The shim folder a shell puts first on its PATH, installed when the
    /// first shell starts.
    shims: std::cell::OnceCell<Option<PathBuf>>,
    /// The core is shutting down: nothing new starts.
    closing: bool,
    kills: Kills,
    /// Terminals that ended and whose history is being written, off the
    /// core's thread: a client attaching meanwhile replays it from memory.
    saving: HashMap<TerminalId, Rc<RefCell<Term>>>,
}

/// The kills that stops armed, each due at its deadline: a stop's kill
/// outlives its terminal, and shutdown carries out the ones still armed
/// before the core exits, so that what ignored hang-up never outlives it.
#[derive(Clone, Default)]
struct Kills(Rc<RefCell<Armed>>);

#[derive(Default)]
struct Armed {
    next: u64,
    due: HashMap<u64, (tokio::time::Instant, process::Doomed)>,
}

impl Kills {
    /// Kills what `doomed` names [`KILL`] from now: one timer, which fires once.
    fn arm(&self, doomed: process::Doomed) {
        let at = tokio::time::Instant::now() + KILL;
        let id = {
            let mut armed = self.0.borrow_mut();
            armed.next += 1;
            let id = armed.next;
            armed.due.insert(id, (at, doomed));
            id
        };
        let kills = self.clone();
        tokio::task::spawn_local(async move {
            tokio::time::sleep_until(at).await;
            let due = kills.0.borrow_mut().due.remove(&id);
            if let Some((_, doomed)) = due {
                doomed.kill();
            }
        });
    }

    /// Carries out every kill still armed, each at its deadline, unless
    /// what it names has ended by itself.
    async fn finish(&self) {
        let mut due: Vec<_> = self.0.borrow_mut().due.drain().map(|(_, d)| d).collect();
        due.sort_by_key(|&(at, _)| at);
        for (at, doomed) in due {
            if doomed.alive() {
                tokio::time::sleep_until(at).await;
                doomed.kill();
            }
        }
    }
}

struct Live {
    term: Rc<RefCell<Term>>,
    process: Process,
    kills: Kills,
    project: Option<ProjectId>,
    stopping: bool,
    /// The child exited with this code.
    exited: Option<Option<u32>>,
    /// The output ended.
    closed: bool,
    /// Reads the output for what its agent waits on before it is ready.
    watch: Option<crate::agents::Watch>,
}

impl Terminals {
    pub fn new(data: &Path) -> Terminals {
        // Taken at start, from the environment the core was started with.
        process::declared();
        Terminals {
            live: HashMap::new(),
            data: data.to_owned(),
            shims: Default::default(),
            closing: false,
            kills: Kills::default(),
            saving: HashMap::new(),
        }
    }

    /// The shim folder, filled from this program. Where it cannot be, as on
    /// Windows while one of the shims runs, the folder an earlier core
    /// filled serves.
    fn shims(&self) -> Option<&Path> {
        let shims = self.shims.get_or_init(|| {
            let exe = std::env::current_exe();
            let installed = exe.and_then(|exe| crate::roles::shim::install(&self.data, &exe));
            let folder = self.data.join(crate::roles::shim::SHIMS);
            installed.ok().or_else(|| folder.is_dir().then_some(folder))
        });
        shims.as_deref()
    }

    /// Live terminals, which keep the core running (design §3).
    pub fn count(&self) -> u32 {
        (self.live.len() + self.saving.len()) as u32
    }

    pub fn running(&self, id: TerminalId) -> bool {
        self.live.contains_key(&id)
    }

    /// Where a terminal's history is kept once it is not running.
    fn history(&self, id: TerminalId) -> PathBuf {
        self.data.join("scrollback").join(id.uuid().to_string())
    }
}

impl Live {
    /// Hang-up now, the kill after [`KILL`]: one timer, which fires once.
    /// Before the child has started this waits for it.
    fn stop(&mut self) {
        if !self.stopping {
            self.stopping = true;
            self.hang_up();
        }
    }

    fn hang_up(&mut self) {
        if let Some(doomed) = self.process.hang_up() {
            self.kills.arm(doomed);
        }
    }
}

/// `terminal.open`: starts the terminal if asked and new, then attaches.
pub fn open(cx: &mut Cx, args: OpenTerminal) -> Result<Opened, Error> {
    let size = size(args.cols, args.rows)?;
    let row = match args.start {
        Some(start) => start_once(cx.core, args.id, start, size)?,
        None => effects::read(cx.core, |tx| tx.terminal(args.id))?.ok_or_else(|| gone(args.id))?,
    };
    resized(cx.core, row.id, size)?;
    attach(cx, &row, args.from, args.credit)
}

/// The terminal `start` describes, started now unless the id was started
/// with it before; with something else it is `conflict`.
fn start_once(
    core: &mut Core,
    id: TerminalId,
    start: StartTerminal,
    size: Size,
) -> Result<Terminal, Error> {
    let (now, token) = (core.seams.now(), Secret::mint());
    let closing = core.terminals.closing;
    let (row, new) = effects::write(core, |tx| {
        let record = match state::create(tx, now, AttemptKind::Terminal(id), &start) {
            Ok(record) => record,
            Err(Refused::Store(e)) => return Err(stored(e)),
            Err(e) => return Err(Error::new(Code::Conflict, e.to_string())),
        };
        let record = match (record, tx.terminal(id).map_err(stored)?) {
            (None, Some(row)) => return Ok((row, false)),
            (None, None) => return Err(gone(id)),
            (Some(_), Some(_)) => {
                let why = "the terminal id was used for another terminal";
                return Err(Error::new(Code::Conflict, why));
            }
            (Some(record), None) => record,
        };
        if closing {
            return Err(Error::new(Code::Failed, "the core is shutting down"));
        }
        let (project_id, cwd) = match start.project {
            Some(p) => {
                let p = tx.project(p).map_err(stored)?;
                let p = p.ok_or_else(|| Error::new(Code::Gone, "no such project"))?;
                if !p.open {
                    return Err(Error::new(Code::Conflict, "the project is closed"));
                }
                (Some(p.id), p.folder)
            }
            None => (None, process::home().to_string_lossy().into_owned()),
        };
        let (kind, argv) = match start.argv {
            argv if argv.is_empty() => (TerminalKind::Shell, vec![process::shell()]),
            argv => (TerminalKind::Task, argv),
        };
        let row = Terminal {
            id,
            rev: Rev::ZERO,
            project_id,
            kind,
            title: start.title.clone().unwrap_or_else(|| name(&argv[0])),
            cwd,
            argv,
            cols: size.0,
            rows: size.1,
            state: TerminalState::Running,
            exit: None,
            offset: Offset::ZERO,
        };
        tx.insert_attempt(&record).map_err(stored)?;
        let hash = crate::handshake::hash(&token);
        tx.insert_terminal(&row, Some(&hash)).map_err(stored)?;
        Ok((row, true))
    })?;
    if new && let Err(e) = spawn(core, &row, &token) {
        effects::ended(core, id, None, Some(Offset::ZERO));
        return Err(Error::new(
            Code::Failed,
            format!("cannot open a terminal: {e}"),
        ));
    }
    Ok(row)
}

/// Starts the process of `t`, a row its caller stores, with `token` in its
/// environment. The seam for the launcher (design §14 C), which starts an
/// agent as the direct child of its terminal: `t.kind` `agent` or `task`
/// runs `t.argv` directly, `shell` the person's login shell. Fails only when
/// no pseudo-terminal could be opened; a child that cannot be started ends
/// the terminal at once, with the reason as its output.
pub fn spawn(core: &mut Core, t: &Terminal, token: &Secret) -> std::io::Result<()> {
    let terminals = &mut core.terminals;
    if terminals.closing {
        return Err(std::io::Error::other("the core is shutting down"));
    }
    let shell = t.kind == TerminalKind::Shell;
    let size = Size(t.cols, t.rows);
    // A shell finds the shims first, so that an agent typed there is
    // adopted; any other child finds `tasktap`, for `tasktap ask`, in the
    // core's own folder, last, with no shim on its PATH at all.
    let own = crate::roles::program().ok();
    let own = own.as_deref().and_then(Path::parent);
    let path = match shell {
        true => process::path(terminals.shims(), None),
        false => process::path(None, own),
    };
    let plan = Plan {
        argv: if shell { Vec::new() } else { t.argv.clone() },
        cwd: PathBuf::from(&t.cwd),
        env: process::environment(&terminals.data, token, path),
        size,
    };
    let (process, input, reports) = Process::start(plan)?;
    let live = Live {
        term: Rc::new(RefCell::new(Term::new(size, input))),
        process,
        kills: terminals.kills.clone(),
        project: t.project_id,
        stopping: false,
        exited: None,
        closed: false,
        watch: None,
    };
    terminals.live.insert(t.id, live);
    tokio::task::spawn_local(run(core.me.clone(), t.id, reports));
    core.events.notify_one();
    Ok(())
}

/// Takes in what a terminal's threads report until the terminal ends.
async fn run(core: Weak<RefCell<Core>>, id: TerminalId, mut reports: mpsc::Receiver<Report>) {
    let mut linger = None;
    loop {
        let report = tokio::select! {
            report = reports.recv() => report,
            () = serve::fire(&mut linger) => None,
        };
        let Some(me) = core.upgrade() else { return };
        let mut core = me.borrow_mut();
        let Some(live) = core.terminals.live.get_mut(&id) else {
            return;
        };
        let exit = match report {
            Some(Report::Output(bytes)) => {
                live.term.borrow_mut().push(&bytes);
                let shown = live.watch.as_mut().and_then(|w| w.read(&bytes));
                if let Some(prompt) = shown {
                    effects::shown(&mut core, id, prompt.asks);
                }
                continue;
            }
            Some(Report::Wrote) => {
                live.term.borrow_mut().wrote();
                continue;
            }
            Some(Report::Unwritable(why)) => {
                live.term.borrow_mut().unwritable(why);
                continue;
            }
            Some(Report::Started(group)) => {
                live.process.started(group);
                if live.stopping {
                    live.hang_up();
                }
                continue;
            }
            Some(Report::Failed(why)) => {
                let says = format!("tasktap: cannot start this terminal: {why}\r\n");
                live.term.borrow_mut().push(says.as_bytes());
                None
            }
            Some(Report::Exited(code)) => {
                live.exited = Some(code);
                live.process.exited();
                let closed = live.closed;
                // The direct child is the session's agent, or the shell an
                // adopted agent ran in: the session ends with it, not with
                // what it left holding the terminal.
                left(&mut core, id, code);
                if !closed {
                    linger = Some(Box::pin(tokio::time::sleep(LINGER)));
                    continue;
                }
                code
            }
            Some(Report::Closed) => {
                live.closed = true;
                match live.exited {
                    Some(code) => code,
                    None => continue,
                }
            }
            // Lingered long enough, or every thread is gone.
            None => live.exited.flatten(),
        };
        end(&mut core, id, exit);
        return;
    }
}

/// The terminal has ended: its clients get the rest and an `exit` mark, its
/// history goes to disk, and its row and session learn of it. What it
/// started and left running ends with it, as a stop ends it: it would
/// otherwise run on with no terminal to show it and nothing to stop it.
///
/// The history is written off the core's thread, since the data folder may
/// stall; the row says the terminal exited once it is on disk, so a client
/// that finds it exited reads it from there, and one that attaches before
/// replays it from memory.
fn end(core: &mut Core, id: TerminalId, exit: Option<u32>) {
    let Some(mut live) = core.terminals.live.remove(&id) else {
        return;
    };
    live.stop();
    let mut term = live.term.borrow_mut();
    term.ended(exit);
    let (history, offset) = (term.history(), Offset::new(term.end()));
    drop(term);
    live.process.end();
    core.terminals.saving.insert(id, live.term);
    let path = core.terminals.history(id);
    // A history that cannot be written is lost; the terminal still ends.
    let write = move || drop(ring::write(&path, &history));
    crate::calls::aside(core, write, move |core, _| {
        core.terminals.saving.remove(&id);
        effects::ended(core, id, exit, offset);
        left(core, id, exit);
        core.events.notify_one();
    });
}

/// The session running in a terminal whose child has exited ends. Not while
/// the core shuts down: the core ended it, not its agent, and the next
/// start finds the session interrupted (design §3).
fn left(core: &mut Core, id: TerminalId, exit: Option<u32>) {
    if !core.terminals.closing {
        effects::exited(core, id, exit);
    }
}

/// Reads a running terminal's output for what its agent waits on before it
/// is ready (design §7), until it is.
pub fn watch(core: &mut Core, id: TerminalId, watch: crate::agents::Watch) {
    if let Some(live) = core.terminals.live.get_mut(&id) {
        live.watch = Some(watch);
    }
}

pub fn unwatch(core: &mut Core, id: TerminalId) {
    if let Some(live) = core.terminals.live.get_mut(&id) {
        live.watch = None;
    }
}

/// Where a terminal's direct child finds `program`: on the PATH every
/// terminal but a shell gets, before the shims.
pub fn find(program: &str) -> Option<PathBuf> {
    crate::roles::shim::find(program, &process::path(None, None), |_, _| true)
}

/// The environment of a check of an agent's own program: a terminal's,
/// without how to reach the core.
pub fn environment_of_checks() -> Vec<(String, std::ffi::OsString)> {
    process::fixed(process::path(None, None))
}

/// Types `text` into a terminal as a bracketed paste and Enter, as the
/// launcher types a follow-up (design §7), and says once the input thread
/// has written it, or why it did not. `None`, with nothing typed, when its
/// child has exited or is being stopped; `Some(Err)` when the terminal
/// takes no input.
pub fn paste(core: &mut Core, id: TerminalId, text: &str) -> Option<Result<Typing, String>> {
    const PASTE: (&str, &str) = ("\x1b[200~", "\x1b[201~");
    let live = core.terminals.live.get(&id)?;
    if live.exited.is_some() || live.stopping {
        return None;
    }
    let typed = [PASTE.0, &pasteable(text), PASTE.1, "\r"].concat();
    Some(live.term.borrow_mut().type_text(typed.as_bytes()))
}

/// What the core typed, until the input thread has written it or could not.
pub type Typing = tokio::sync::oneshot::Receiver<ring::Typed>;

/// The text a paste may carry: no control character but its own line
/// breaks and tabs. Without ESC the text cannot end the paste early or
/// start any other sequence, whatever it holds, and without the others the
/// terminal's line discipline acts on none of it (interrupt, suspend, end
/// of input, erase). A line break is part of the text a raw agent reads
/// inside a paste; a carriage return, alone or before a line feed, is one.
fn pasteable(text: &str) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    text.chars()
        .filter(|&c| c == '\n' || c == '\t' || !c.is_control())
        .collect()
}

fn attach(cx: &mut Cx, t: &Terminal, from: Option<Offset>, credit: u32) -> Result<Opened, Error> {
    let terminals = &cx.core.terminals;
    let live = terminals.live.get(&t.id).map(|live| live.term.clone());
    let saving = terminals.saving.get(&t.id).cloned();
    let feed = match live.clone().or(saving) {
        Some(term) => Feed::Live(term),
        None => Feed::Saved(Saved::open(&terminals.history(t.id), t)),
    };
    let (start, end) = feed.bounds();
    let (pos, gap) = match from.map(Offset::get) {
        Some(from) if (start..=end).contains(&from) => (from, false),
        Some(_) => (start, true),
        None => (start, false),
    };
    // Input only while there is a process to take it.
    let grant = if live.is_some() { INPUT } else { 0 };
    let opened = stream::open(cx.link, credit, grant, |handle| {
        if let Some(term) = &live {
            term.borrow_mut().attach(handle.clone());
        }
        Box::new(Attachment::new(feed, handle, pos, gap))
    })?;
    Ok(Opened {
        from: Offset::new(pos),
        ..opened
    })
}

/// `terminal.resize`.
pub fn resize(cx: &mut Cx, args: ResizeTerminal) -> Result<(), Error> {
    let size = size(args.cols, args.rows)?;
    known(cx.core, args.id)?;
    resized(cx.core, args.id, size)
}

/// The last caller's size: a mark at the offset where it changed, the
/// process told, and the row written. A terminal that is not running keeps
/// the size it ended with.
fn resized(core: &mut Core, id: TerminalId, size: Size) -> Result<(), Error> {
    let Some(live) = core.terminals.live.get_mut(&id) else {
        return Ok(());
    };
    let mut term = live.term.borrow_mut();
    if !term.resize(size) {
        return Ok(());
    }
    let offset = Offset::new(term.end());
    drop(term);
    // After the mark: what the child draws for the new size comes after it.
    live.process.resize(size);
    effects::write(core, |tx| {
        if let Some(mut t) = tx.terminal(id).map_err(stored)? {
            (t.cols, t.rows) = (size.0, size.1);
            t.offset = offset.unwrap_or(t.offset);
            tx.update_terminal(&t).map_err(stored)?;
        }
        Ok(())
    })
}

/// `terminal.stop`: one that is not running has nothing to stop.
pub fn stop_call(cx: &mut Cx, args: Ref<TerminalId>) -> Result<(), Error> {
    known(cx.core, args.id)?;
    stop(cx.core, args.id);
    Ok(())
}

/// Ends a terminal's process tree: hang-up to its process group and its
/// foreground group, the kill [`KILL`] later. Its row becomes `exited` when
/// the exit arrives. True when it was not running. The seam for the
/// launcher's kill (design §14 C).
pub fn stop(core: &mut Core, id: TerminalId) -> bool {
    match core.terminals.live.get_mut(&id) {
        Some(live) => {
            live.stop();
            false
        }
        None => true,
    }
}

/// `project.close`.
pub fn close_project(cx: &mut Cx, args: CloseProject) -> Result<(), Error> {
    effects::write(cx.core, |tx| {
        let p = tx.project(args.id).map_err(stored)?;
        let mut p = p.ok_or_else(|| Error::new(Code::Gone, "no such project"))?;
        if p.open {
            p.open = false;
            tx.update_project(&p).map_err(stored)?;
        }
        Ok(())
    })?;
    if args.stop {
        for live in cx.core.terminals.live.values_mut() {
            if live.project == Some(args.id) {
                live.stop();
            }
        }
    }
    Ok(())
}

/// A terminal's record was deleted: its history goes with it.
pub fn forget(core: &Core, id: TerminalId) {
    let _ = std::fs::remove_file(core.terminals.history(id));
}

/// Stops every terminal and waits until they have ended or the kill had its
/// time (design §3). One that outlives even that keeps the history it has,
/// and the next start finds it lost. A terminal can end before its kill is
/// due, when its child ended on hang-up and what ignored it let go of the
/// terminal: every kill still armed is carried out at its deadline first.
pub async fn shutdown(core: &Rc<RefCell<Core>>) {
    let events = {
        let mut core = core.borrow_mut();
        core.terminals.closing = true;
        for live in core.terminals.live.values_mut() {
            live.stop();
        }
        core.events.clone()
    };
    let deadline = tokio::time::sleep(KILL + LINGER + Duration::from_secs(1));
    tokio::pin!(deadline);
    while core.borrow().terminals.count() > 0 {
        tokio::select! {
            () = events.notified() => {}
            () = &mut deadline => break,
        }
    }
    let kills = {
        let mut core = core.borrow_mut();
        let left: Vec<_> = core.terminals.live.drain().collect();
        for (id, live) in left {
            let _ = live.term.borrow().save(&core.terminals.history(id));
            live.process.end();
        }
        core.terminals.kills.clone()
    };
    kills.finish().await;
}

fn known(core: &mut Core, id: TerminalId) -> Result<(), Error> {
    match effects::read(core, |tx| tx.terminal(id))? {
        Some(_) => Ok(()),
        None => Err(gone(id)),
    }
}

fn size(cols: u16, rows: u16) -> Result<Size, Error> {
    let fits = |n: u16| (1..=MAX_TERMINAL_SIZE).contains(&n);
    if fits(cols) && fits(rows) {
        Ok(Size(cols, rows))
    } else {
        let why = format!("a terminal has 1 to {MAX_TERMINAL_SIZE} columns and rows");
        Err(Error::new(Code::Invalid, why))
    }
}

fn gone(id: TerminalId) -> Error {
    Error::new(Code::Gone, format!("no terminal {}", id.uuid()))
}

/// A program's name without its folder or extension.
fn name(program: &str) -> String {
    let path = Path::new(program);
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned());
    stem.unwrap_or_else(|| program.to_owned())
}
