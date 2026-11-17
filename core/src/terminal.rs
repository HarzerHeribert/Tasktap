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
use std::ffi::OsString;
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
    /// What a terminal's processes connect to (`TASKTAP_SOCKET`).
    socket: OsString,
    /// The core is shutting down: nothing new starts.
    closing: bool,
}

struct Live {
    term: Rc<RefCell<Term>>,
    process: Process,
    project: Option<ProjectId>,
    stopping: bool,
    /// The child exited with this code.
    exited: Option<Option<u32>>,
    /// The output ended.
    closed: bool,
}

impl Terminals {
    pub fn new(data: &Path) -> std::io::Result<Terminals> {
        Ok(Terminals {
            live: HashMap::new(),
            data: data.to_owned(),
            socket: crate::sys::address(data)?,
            closing: false,
        })
    }

    /// Live terminals, which keep the core running (design §3).
    pub fn count(&self) -> u32 {
        self.live.len() as u32
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
            tokio::task::spawn_local(async move {
                tokio::time::sleep(KILL).await;
                doomed.kill();
            });
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
        effects::exited(core, id, None, Some(Offset::ZERO));
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
    let size = Size(t.cols, t.rows);
    let plan = Plan {
        argv: if t.kind == TerminalKind::Shell {
            Vec::new()
        } else {
            t.argv.clone()
        },
        cwd: PathBuf::from(&t.cwd),
        env: process::environment(&terminals.data, &terminals.socket, token),
        size,
    };
    let (process, input, reports) = Process::start(plan)?;
    let live = Live {
        term: Rc::new(RefCell::new(Term::new(size, input))),
        process,
        project: t.project_id,
        stopping: false,
        exited: None,
        closed: false,
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
                continue;
            }
            Some(Report::Wrote) => {
                live.term.borrow_mut().wrote();
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
                if !live.closed {
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
/// history goes to disk, and its row and session learn of it.
fn end(core: &mut Core, id: TerminalId, exit: Option<u32>) {
    let Some(live) = core.terminals.live.remove(&id) else {
        return;
    };
    let mut term = live.term.borrow_mut();
    term.ended(exit);
    // A history that cannot be written is lost; the terminal still ends.
    let _ = term.save(&core.terminals.history(id));
    let offset = Offset::new(term.end());
    drop(term);
    live.process.end();
    effects::exited(core, id, exit, offset);
    core.events.notify_one();
}

fn attach(cx: &mut Cx, t: &Terminal, from: Option<Offset>, credit: u32) -> Result<Opened, Error> {
    let terminals = &cx.core.terminals;
    let live = terminals.live.get(&t.id).map(|live| live.term.clone());
    let feed = match &live {
        Some(term) => Feed::Live(term.clone()),
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
/// and the next start finds it lost.
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
    let mut core = core.borrow_mut();
    let left: Vec<_> = core.terminals.live.drain().collect();
    for (id, live) in left {
        let _ = live.term.borrow().save(&core.terminals.history(id));
        live.process.end();
    }
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
