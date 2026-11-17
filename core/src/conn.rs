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
use std::collections::{HashMap, VecDeque};
use std::pin::Pin;
use std::rc::Rc;
use std::task::Poll;
use std::time::Duration;
use tasktap_proto::{
    Call, CallId, Change, Control, Decoder, Frame, MAX_PENDING_CALLS, Outcome, Refuse,
    encode_control,
};
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Notify, oneshot};

/// Connections at once.
pub const MAX_CONNECTIONS: usize = 256;
/// Control bytes queued for one connection, apart from the snapshot it is
/// being sent.
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
    /// The client offered `shim.hold` in its hello.
    pub holds: bool,
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
    /// Frames that wait behind a snapshot going out: its chunks, then all
    /// that was queued after them, in order; each with whether `held`
    /// counts it, which all but the chunks of that snapshot are.
    later: RefCell<VecDeque<(bool, Vec<u8>)>>,
    held: Cell<usize>,
    /// Calls read whose reply has not been queued.
    pending: Cell<usize>,
    /// Set once the connection is ending: whether what is queued gets one last write.
    closing: Cell<Option<bool>>,
    /// The client no longer reads: nothing more is queued for it.
    deaf: Cell<bool>,
    wake: Notify,
    /// The collections this connection subscribed to.
    pub subs: Cell<Subs>,
    /// Calls the core made on the client, waiting for their replies; dropped
    /// with the connection, which their waiters see as an error.
    calls: RefCell<HashMap<CallId, oneshot::Sender<Outcome>>>,
    next: Cell<u32>,
    /// The process at the other end, where the system says.
    pub pid: Cell<Option<u32>>,
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
        let mut bytes = Vec::new();
        match encode_control(frame, &mut bytes) {
            Ok(()) => self.push(&bytes),
            // Only a frame over the size limit fails, and no peer could read it.
            Err(_) => self.close(false),
        }
    }

    /// Queues a frame already encoded, so that a change sent to many
    /// connections is encoded once. Bounded like [`Link::send`].
    pub fn push(&self, frame: &[u8]) {
        if self.closing.get().is_some() || self.deaf.get() {
            return;
        }
        let mut later = self.later.borrow_mut();
        if later.is_empty() {
            self.out.borrow_mut().extend_from_slice(frame);
            self.queued.set(self.queued.get() + frame.len());
        } else {
            later.push_back((true, frame.to_vec()));
            self.held.set(self.held.get() + frame.len());
        }
        drop(later);
        if self.queued.get() + self.held.get() > MAX_QUEUED {
            self.close(false);
        } else {
            self.wake.notify_one();
        }
    }

    /// Queues a snapshot to go out as the connection drains, at the pace of
    /// stream data, so that one larger than `MAX_QUEUED` reaches a client
    /// that reads. All queued after it waits behind it, in order, and counts
    /// toward the bound; so does a snapshot queued behind another, so a
    /// client holds at most one uncounted.
    pub fn snapshot(&self, chunks: Vec<Change>) {
        if self.deaf.get() {
            return;
        }
        let paced = self.later.borrow().is_empty();
        for change in chunks {
            let mut frame = Vec::new();
            if self.is_closing() || encode_control(&Control::Change(change), &mut frame).is_err() {
                return self.close(false);
            }
            if paced {
                self.later.borrow_mut().push_back((false, frame));
            } else {
                self.push(&frame);
            }
        }
        self.wake.notify_one();
    }

    /// Moves what waits behind a snapshot into the queue while fewer than
    /// [`stream::WINDOW`] bytes wait to be written. True once nothing waits.
    pub(crate) fn feed(&self) -> bool {
        let mut later = self.later.borrow_mut();
        while self.queued.get() < stream::WINDOW
            && let Some((counted, frame)) = later.pop_front()
        {
            if counted {
                self.held.set(self.held.get() - frame.len());
            }
            self.queued.set(self.queued.get() + frame.len());
            self.out.borrow_mut().extend_from_slice(&frame);
        }
        later.is_empty()
    }

    /// Makes a call on the client (design §1: any side can call another).
    pub fn call<C: Call>(&self, args: &C::Args) -> oneshot::Receiver<Outcome> {
        let id = CallId(self.next.get());
        self.next.set(id.0.wrapping_add(1));
        let (reply, replied) = oneshot::channel();
        if !self.is_closing() && !self.deaf.get() {
            self.calls.borrow_mut().insert(id, reply);
        }
        self.send(&C::request(id, args));
        replied
    }

    /// The client no longer reads: what is queued for it is dropped, and
    /// nothing more is queued.
    fn deafen(&self) {
        self.deaf.set(true);
        self.out.borrow_mut().clear();
        self.later.borrow_mut().clear();
        self.queued.set(0);
        self.held.set(0);
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
    link.pid.set(sys::peer_pid(&stream));
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
    // A write to the client failed: it is gone, and nothing more is written
    // to it. What it sent before it went is still read, to its end: the
    // core may learn that a client left from a write before it has read
    // what the client sent last, and that is not lost.
    let mut gone = false;
    let flushed = loop {
        if !gone {
            stream::pull(&link);
            if at == out.len() {
                // Gives back what a burst took before taking more.
                out.clear();
                out.shrink_to(READ);
                at = 0;
                std::mem::swap(&mut out, &mut *link.out.borrow_mut());
            }
        }
        match link.closing.get() {
            Some(_) if gone => break false,
            Some(true) => {
                let mut rest = out.split_off(at);
                rest.extend_from_slice(&link.out.take());
                rest.extend(link.later.take().into_iter().flat_map(|(_, frame)| frame));
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
                _ => {
                    gone = true;
                    link.deafen();
                    out.clear();
                    at = 0;
                }
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
    link.calls.take();
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
            // A reply to a call the core made; one nobody waits for any more is dropped.
            (Some(_), Frame::Control(Control::Reply(reply))) => {
                let waiter = link.calls.borrow_mut().remove(&reply.id);
                if let Some(waiter) = waiter {
                    let _ = waiter.send(reply.outcome);
                }
            }
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
