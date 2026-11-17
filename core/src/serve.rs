//! The service (design §3): one core per data folder, started on demand,
//! alive while anyone is connected, gone a minute after the last one left.

use crate::conn::{self, Link};
use crate::store::Store;
use crate::sys;
use std::cell::RefCell;
use std::fs::{File, TryLockError};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::rc::Rc;
use std::rc::Weak;
use std::time::Duration;
use tasktap_proto::{Change, When};
use tokio::sync::Notify;
use tokio::time::Sleep;

/// How long the core stays with nobody connected and no terminal alive.
pub const IDLE: Duration = Duration::from_secs(60);
/// How long a connection may take to say hello before it is closed.
pub const HELLO: Duration = Duration::from_secs(5);

/// This build in `welcome` and `core.status`. A release stamps it at compile
/// time with `TASKTAP_BUILD`.
pub const BUILD: &str = match option_env!("TASKTAP_BUILD") {
    Some(build) => build,
    None => env!("CARGO_PKG_VERSION"),
};

pub struct Options {
    /// Always given: there is no default folder (hazard 7).
    pub data: PathBuf,
    pub idle: Duration,
    /// How long a connection may take to say hello.
    pub hello: Duration,
    /// The client that started this core holds `start.lock` for it until it
    /// reads `ready` (`client::admit`).
    pub locked: bool,
    /// A session token that names no terminal, for tests (design §13).
    #[cfg(feature = "fixtures")]
    pub token: Option<tasktap_proto::Secret>,
    /// How long each folder check waits first, for tests.
    #[cfg(feature = "fixtures")]
    pub check: Duration,
}

/// Everything the core's thread owns. Tasks borrow it between awaits, never across one.
pub struct Core {
    pub store: Store,
    pub links: Vec<Rc<Link>>,
    pub retire: Option<When>,
    pub memory: crate::records::Memory,
    /// The clock, the hold timers, and the router and launcher when this build has them.
    pub seams: crate::effects::Seams,
    /// Who waits for which question, and what `glance` counts.
    pub questions: crate::questions::Questions,
    /// The core itself, for a timer that fires later.
    pub me: Weak<RefCell<Core>>,
    /// Wakes the main loop to look at the lifetime again.
    pub events: Rc<Notify>,
    /// Folder checks running on their own threads (`calls::off_thread`).
    pub checks: usize,
    /// How long each folder check waits first, for tests (design §13).
    #[cfg(feature = "fixtures")]
    pub fixture_check: Duration,
    #[cfg(feature = "fixtures")]
    pub fixture_token: Option<(crate::store::Hash, tasktap_proto::TerminalId)>,
}

impl Core {
    /// Live terminals; Phase 2 counts them.
    pub fn terminals(&self) -> u32 {
        0
    }

    /// The lifetime condition: a client connected, a terminal alive or a
    /// hold armed, which would be lost with the core. A connection is a
    /// client once it said hello.
    pub fn busy(&self) -> bool {
        self.links.iter().any(|l| l.peer().is_some())
            || self.terminals() > 0
            || self.seams.holding()
    }

    /// Every committed change passes here, in the step that committed it,
    /// and is queued at once for the links subscribed to its collections.
    pub fn publish(&mut self, change: Option<Change>) {
        if let Some(mut change) = change {
            self.memory.overlay(&mut change.sets);
            crate::records::publish(&self.links, change);
        }
    }

    /// A connection ended; the questions only it waited for are withdrawn.
    pub fn remove(&mut self, link: &Rc<Link>) {
        self.links.retain(|l| !Rc::ptr_eq(l, link));
        crate::questions::left(self, link);
        self.events.notify_one();
    }
}

/// Runs `tasktap serve` until it retires, idles out or is stopped. Returns
/// at once, successfully, when another core holds the folder.
pub fn run(opts: Options) -> io::Result<()> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()?;
    tokio::task::LocalSet::new().block_on(&rt, serve(opts))
}

async fn serve(opts: Options) -> io::Result<()> {
    sys::prepare(&opts.data)?;
    // A second `serve` waits here until the first listens, then finds the
    // lock taken and exits: the client that started it can connect at once.
    let starting = match opts.locked {
        true => None,
        false => Some(lock(&opts.data.join("start.lock"))?),
    };
    let life = open(&opts.data.join("core.lock"))?;
    match life.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => {
            ready();
            return Ok(());
        }
        Err(TryLockError::Error(e)) => return Err(e),
    }
    let db = opts.data.join("core.db");
    let (store, _) = Store::open(&db, crate::effects::wall()).map_err(io::Error::other)?;
    let mut listener = sys::Listener::bind(&opts.data)?;
    let terminated = sys::terminated()?;
    drop(starting);
    ready();

    let events = Rc::new(Notify::new());
    let core = Rc::new_cyclic(|me| {
        RefCell::new(Core {
            store,
            links: Vec::new(),
            retire: None,
            memory: Default::default(),
            seams: Default::default(),
            questions: Default::default(),
            me: me.clone(),
            events: events.clone(),
            checks: 0,
            #[cfg(feature = "fixtures")]
            fixture_check: opts.check,
            #[cfg(feature = "fixtures")]
            fixture_token: opts.token.map(|t| {
                (
                    crate::handshake::hash(&t),
                    tasktap_proto::TerminalId::mint(),
                )
            }),
        })
    });
    crate::questions::start(&mut core.borrow_mut()).map_err(io::Error::other)?;
    tokio::pin!(terminated);
    let mut idle = None;
    let mut accepting = true;
    loop {
        {
            let c = core.borrow();
            match c.retire {
                Some(When::Now) => break,
                Some(When::Idle) if c.terminals() == 0 => break,
                _ => {}
            }
            if c.busy() {
                // Dropping the timer takes it out of the runtime: no wakeup.
                idle = None;
            } else if idle.is_none() {
                idle = Some(Box::pin(tokio::time::sleep(opts.idle)));
            }
        }
        tokio::select! {
            biased;
            () = &mut terminated => break,
            accepted = listener.accept(), if accepting => match accepted {
                Ok(stream) => conn::spawn(&core, stream, opts.hello),
                Err(e) if core.borrow().links.is_empty() => return Err(e),
                // Out of descriptors, say: wait for a connection to end
                // rather than spin on the error.
                Err(_) => accepting = false,
            },
            () = events.notified() => accepting = true,
            () = fire(&mut idle) => match closing(&opts.data) {
                Some(gate) => {
                    // Held until the process is gone: a client that comes
                    // now waits for that in the kernel and starts a new core.
                    std::mem::forget(gate);
                    break;
                }
                // A client is between connecting and its hello: stay for it.
                None => idle = None,
            },
        }
    }
    // What is queued, such as the reply to `core.retire`, gets one write.
    for link in &core.borrow().links {
        link.close(true);
    }
    while !core.borrow().links.is_empty() {
        events.notified().await;
    }
    Ok(())
}

/// Tells the client that started this `serve` that a core listens on the
/// folder (`client::start`). Every outcome writes one line, so that client
/// never waits for the pipe to end, which a write end inherited by some
/// other process could delay.
fn ready() {
    let _ = writeln!(io::stdout(), "ready");
}

/// Completes when the armed timer fires, never while none is armed.
pub(crate) async fn fire(timer: &mut Option<Pin<Box<Sleep>>>) {
    match timer {
        Some(timer) => timer.as_mut().await,
        None => std::future::pending().await,
    }
}

fn open(path: &Path) -> io::Result<File> {
    File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)
}

/// `start.lock` taken alone, which no client connecting through
/// `client::admit` holds: none of them can be left in the listen queue of a
/// core that is about to exit.
fn closing(data: &Path) -> Option<File> {
    let gate = open(&data.join("start.lock")).ok()?;
    gate.try_lock().ok().map(|()| gate)
}

fn lock(path: &Path) -> io::Result<File> {
    let file = open(path)?;
    file.lock()?;
    Ok(file)
}
