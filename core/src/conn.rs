//! One connection: its task, its queue and its bounds (design §2).
//!
//! Each accepted connection is one task on the core's thread. It reads
//! frames and answers them, and writes what is queued for it. Everything
//! sent to a connection, by its own calls or from elsewhere in the core, is
//! queued through its [`Link`], which enforces the bounds.

use crate::calls::{self, Caller};
use crate::handshake;
use crate::records::Subs;
use crate::serve::{self, Core};
use crate::stream::{self, Streams};
use crate::sys;
use std::cell::{Cell, RefCell};
use std::pin::Pin;
use std::rc::Rc;
use std::task::Poll;
use std::time::Duration;
use tasktap_proto::{Control, Decoder, Frame, MAX_PENDING_CALLS, Refuse, encode_control};
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Notify;

/// Connections at once.
pub const MAX_CONNECTIONS: usize = 256;
/// Control bytes queued for one connection, a snapshot included.
pub const MAX_QUEUED: usize = 8 << 20;
/// Bytes read from a connection at once.
const READ: usize = 8 << 10;
/// Most bytes handed to one write. A Windows pipe takes a whole write into
/// a buffer of its own and reports it written, so without this a client
/// that stops reading would hold a second queue beside `MAX_QUEUED`.
const WRITE: usize = 64 << 10;

/// What the handshake established about a connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Peer {
    pub who: Caller,
    /// The version both sides speak; 0 leaves only the bootstrap calls.
    pub v: u32,
}

/// The core's handle on one connection.
#[derive(Default)]
pub struct Link {
    peer: Cell<Option<Peer>>,
    pub streams: RefCell<Streams>,
    /// Frames the task has not taken yet.
    out: RefCell<Vec<u8>>,
    /// Bytes queued and not yet written, including those the task took.
    queued: Cell<usize>,
    /// Calls read whose reply has not been queued.
    pending: Cell<usize>,
    /// Set once the connection is ending: whether what is queued gets one last write.
    closing: Cell<Option<bool>>,
    wake: Notify,
    /// The collections this connection subscribed to.
    pub subs: Cell<Subs>,
}

impl Link {
    /// `None` until the handshake succeeded.
    pub fn peer(&self) -> Option<Peer> {
        self.peer.get()
    }

    pub fn is_closing(&self) -> bool {
        self.closing.get().is_some()
    }

    /// Bytes queued and not yet written.
    pub fn queued(&self) -> usize {
        self.queued.get()
    }

    /// Builds frames straight into the queue: stream data, which
    /// `stream::pull` keeps within its window instead of this bound.
    pub fn append<R>(&self, build: impl FnOnce(&mut Vec<u8>) -> R) -> R {
        let mut out = self.out.borrow_mut();
        let before = out.len();
        let built = build(&mut out);
        self.queued.set(self.queued.get() + out.len() - before);
        built
    }

    /// Has the task look at its streams again.
    pub fn poke(&self) {
        self.wake.notify_one();
    }

    /// Queues a frame. A connection over its bound is dropped instead, so
    /// the core's memory never grows to suit a client that does not read.
    pub fn send(&self, frame: &Control) {
        if self.closing.get().is_some() {
            return;
        }
        if let Control::Reply(_) = frame {
            self.pending.set(self.pending.get().saturating_sub(1));
        }
        let mut out = self.out.borrow_mut();
        let before = out.len();
        // Only a frame over the size limit fails, and no peer could read it.
        let encoded = encode_control(frame, &mut out).is_ok();
        let queued = self.queued.get() + out.len() - before;
        drop(out);
        self.queued.set(queued);
        if !encoded || queued > MAX_QUEUED {
            self.close(false);
        } else {
            self.wake.notify_one();
        }
    }

    /// Queues a frame already encoded, so that a change sent to many
    /// connections is encoded once. Bounded like [`Link::send`].
    pub fn push(&self, frame: &[u8]) {
        if self.closing.get().is_some() {
            return;
        }
        self.out.borrow_mut().extend_from_slice(frame);
        let queued = self.queued.get() + frame.len();
        self.queued.set(queued);
        if queued > MAX_QUEUED {
            self.close(false);
        } else {
            self.wake.notify_one();
        }
    }

    /// Ends the connection. With `flush`, what is queued gets one write
    /// that never waits; without, it ends at once.
    pub fn close(&self, flush: bool) {
        if self.closing.get().is_none() {
            self.closing.set(Some(flush));
        }
        self.wake.notify_one();
    }
}

/// Starts the task of an accepted connection, which must say hello within
/// `hello`. When the core holds as many as it may, the oldest that has not
/// said hello yet makes room, so connections that stay silent cannot keep
/// a client out; with none of those, the new one is closed.
pub fn spawn(core: &Rc<RefCell<Core>>, stream: sys::Stream, hello: Duration) {
    let mut c = core.borrow_mut();
    if c.links.len() >= MAX_CONNECTIONS {
        let Some(silent) = c.links.iter().position(|l| l.peer().is_none()) else {
            return;
        };
        c.links.remove(silent).close(false);
    }
    let link = Rc::new(Link::default());
    c.links.push(link.clone());
    tokio::task::spawn_local(run(core.clone(), link, stream, hello));
}

async fn run(core: Rc<RefCell<Core>>, link: Rc<Link>, stream: sys::Stream, hello: Duration) {
    let (mut rd, mut wr) = tokio::io::split(stream);
    let mut decoder = Decoder::new();
    let mut input = [0; READ];
    // Bytes taken from the link, written from `at` on.
    let (mut out, mut at) = (Vec::new(), 0);
    // Bytes written since incoming frames last had a turn.
    let mut since = 0;
    // One timer, dropped at hello: a connection that said it costs no wakeup.
    let mut deadline = Some(Box::pin(tokio::time::sleep(hello)));
    let flushed = loop {
        stream::pull(&link);
        if at == out.len() {
            // Gives back what a burst took before taking more.
            out.clear();
            out.shrink_to(READ);
            at = 0;
            std::mem::swap(&mut out, &mut *link.out.borrow_mut());
        }
        match link.closing.get() {
            Some(true) => {
                let mut rest = out.split_off(at);
                rest.extend_from_slice(&link.out.take());
                write_once(&mut wr, &rest).await;
                break true;
            }
            Some(false) => break false,
            None => {}
        }
        if since >= stream::TURN {
            // Tokio learns that a socket became readable only when its
            // driver runs, which a task whose writes keep succeeding allows
            // only after 128 of them: megabytes. Yielding runs it, and the
            // read below then goes first.
            since = 0;
            tokio::task::yield_now().await;
        }
        tokio::select! {
            biased;
            read = rd.read(&mut input) => match read {
                Ok(n) if n > 0 => {
                    decoder.push(&input[..n]);
                    if !frames(&core, &link, &mut decoder) {
                        break false;
                    }
                    if link.peer.get().is_some() {
                        deadline = None;
                    }
                }
                _ => break false,
            },
            wrote = wr.write(&out[at..out.len().min(at + WRITE)]), if at < out.len() => match wrote {
                Ok(n) if n > 0 => {
                    at += n;
                    since += n;
                    link.queued.set(link.queued.get() - n);
                }
                _ => break false,
            },
            () = link.wake.notified() => {}
            () = serve::fire(&mut deadline) => break false,
        }
    };
    if !flushed {
        // What is still queued goes with the connection, and the client
        // must see it end now, even one blocked writing to a core that no
        // longer reads.
        sys::hang_up(&rd.unsplit(wr));
    }
    stream::end(&link);
    core.borrow_mut().remove(&link);
}

/// Handles every whole frame read so far; `false` ends the connection.
fn frames(core: &RefCell<Core>, link: &Rc<Link>, decoder: &mut Decoder) -> bool {
    while link.closing.get().is_none() {
        // After a bad frame the bytes no longer line up with frames.
        let Ok(next) = decoder.next_frame() else {
            return false;
        };
        let Some(frame) = next else {
            return true;
        };
        let mut core = core.borrow_mut();
        match (link.peer.get(), frame) {
            (None, Frame::Control(Control::Hello(hello))) => {
                match handshake::hello(&mut core, hello) {
                    Ok((peer, welcome)) => {
                        link.peer.set(Some(peer));
                        link.send(&Control::Welcome(welcome));
                        // A client now: the core looks at its lifetime again.
                        core.events.notify_one();
                    }
                    Err(Some(why)) => {
                        link.send(&Control::Refuse(Refuse { why }));
                        link.close(true);
                    }
                    Err(None) => return false,
                }
            }
            (Some(peer), Frame::Control(Control::Call(request))) => {
                if link.pending.get() >= MAX_PENDING_CALLS {
                    return false;
                }
                link.pending.set(link.pending.get() + 1);
                calls::call(&mut core, link, peer, request);
            }
            (
                Some(_),
                frame @ (Frame::Data(_) | Frame::Control(Control::Credit(_) | Control::Close(_))),
            ) => {
                if !stream::receive(link, frame) {
                    return false;
                }
            }
            // Replies answer calls the core makes, which arrive in Phases 2 and 4.
            (Some(_), Frame::Control(Control::Reply(_))) => {}
            // A call before hello, a second hello, or a frame only the core sends.
            _ => return false,
        }
    }
    true
}

/// Writes what the connection takes at once, without waiting for it to
/// read, so a client that stopped reading cannot hold up the core's exit.
async fn write_once(wr: &mut (impl AsyncWrite + Unpin), bytes: &[u8]) {
    std::future::poll_fn(|cx| {
        let _ = Pin::new(&mut *wr).poll_write(cx, bytes);
        Poll::Ready(())
    })
    .await;
}
