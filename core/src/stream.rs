//! Streams (design §1, §2): numbered byte channels opened by a call, with
//! byte credit in both directions.
//!
//! Inside the core, the far end of a stream is an [`Endpoint`]: in Phase 2 a
//! client's attachment to a terminal (output from the terminal's ring, input
//! to its process), here the fixture. The connection asks an endpoint for
//! bytes only while the client has credit and the socket keeps up, so a
//! reader that stops costs nothing: unsent bytes stay wherever the endpoint
//! keeps them, never in a queue here. Several clients read one source at
//! independent positions by each having their own endpoint over it, which
//! remembers its own offset.
//!
//! Control frames are queued the moment they exist; stream data is queued
//! only while fewer than [`WINDOW`] bytes wait to be written. So a reply
//! waits behind at most `WINDOW` plus one data frame, and data waits only for
//! the control frames queued before it, which the connection's 8 MiB bound
//! limits. The streams of one connection take turns, one frame each.
//!
//! Incoming frames come first: the connection reads before it writes
//! whenever input is known to wait, and yields after every [`TURN`] bytes
//! written so the runtime notices new input at all. A call that arrives
//! while a stream is saturated is read after at most `TURN` and one more
//! write, then answered behind at most `WINDOW` and one frame: at most
//! `TURN + 2 × (WINDOW + MAX_DATA_FRAME)`, 512 KiB, of stream data reaches
//! the client after the call could be read and before its reply, whatever
//! the socket buffers. Input cannot shut output out for long either: it is
//! bounded by the credit and pending calls that only output replenishes,
//! and a client that floods frames needing no answer delays only itself.

use crate::conn::Link;
use std::cell::Cell;
use std::rc::{Rc, Weak};
use tasktap_proto::{
    Close, CloseWhy, Code, Control, Credit, Data, Error, Frame, MAX_CREDIT, MAX_DATA, MAX_STREAMS,
    Mark, Offset, Opened, StreamId, encode_data_in,
};

/// Unwritten bytes on a connection below which stream data is queued.
pub const WINDOW: usize = 128 << 10;
/// Bytes a connection writes before it looks for incoming frames again.
pub const TURN: usize = 128 << 10;

/// The core's end of a stream. Both methods run on the core's thread and
/// must not block. `write` runs while the connection holds `Core`, so an
/// endpoint keeps what it needs itself, a terminal's ring behind an `Rc`.
pub trait Endpoint {
    /// Puts the next bytes for the client in `room`, as many as it has up to
    /// [`Room::left`], and says what follows them. Asked again after `More`
    /// with bytes put, once the client grants credit, or after
    /// [`Handle::wake`].
    fn next(&mut self, room: &mut Room<'_>) -> Next {
        let _ = room;
        Next::Wait
    }

    /// Bytes from the client, never more than the core granted. The endpoint
    /// grants more with [`Handle::grant`] once it has room for them.
    fn write(&mut self, bytes: &[u8]) {
        let _ = bytes;
    }
}

/// What follows the bytes an endpoint put.
pub enum Next {
    /// More bytes, once there is credit and room.
    More,
    /// A mark at the offset after those bytes; `s` and `at` are set here.
    Mark(Mark),
    /// Nothing until [`Handle::wake`].
    Wait,
    End(CloseWhy),
}

/// Where an endpoint puts bytes: the data frame being built, in the
/// connection's queue. It takes no more than the client's credit and one
/// frame allow, so no endpoint can make the core send beyond a grant.
pub struct Room<'a> {
    out: &'a mut Vec<u8>,
    left: usize,
}

impl Room<'_> {
    pub fn left(&self) -> usize {
        self.left
    }

    /// Copies as much of `bytes` as fits; returns how many.
    pub fn put(&mut self, bytes: &[u8]) -> usize {
        let n = bytes.len().min(self.left);
        self.out.extend_from_slice(&bytes[..n]);
        self.left -= n;
        n
    }
}

/// An endpoint's hold on its stream. It only sets flags that the connection
/// acts on in its next turn, so it may be used anywhere, inside an
/// endpoint's own methods too.
#[derive(Clone)]
pub struct Handle {
    s: StreamId,
    shared: Rc<Shared>,
    link: Weak<Link>,
}

#[derive(Default)]
struct Shared {
    woken: Cell<bool>,
    grant: Cell<u32>,
    close: Cell<Option<CloseWhy>>,
    closed: Cell<bool>,
}

impl Handle {
    pub fn id(&self) -> StreamId {
        self.s
    }

    /// The endpoint has bytes or a mark again after it said `Wait`.
    pub fn wake(&self) {
        self.shared.woken.set(true);
        self.poke();
    }

    /// Lets the client send `n` more bytes, never more than `MAX_CREDIT`
    /// outstanding: the rest is not granted.
    pub fn grant(&self, n: u32) {
        let grant = &self.shared.grant;
        grant.set(grant.get().saturating_add(n));
        self.poke();
    }

    /// Ends the stream from the core's side, after what is already queued.
    pub fn close(&self, why: CloseWhy) {
        if self.shared.close.get().is_none() {
            self.shared.close.set(Some(why));
        }
        self.poke();
    }

    /// False once either side closed the stream or its connection ended.
    pub fn is_open(&self) -> bool {
        !self.shared.closed.get()
    }

    fn poke(&self) {
        if let Some(link) = self.link.upgrade() {
            link.poke();
        }
    }
}

/// Opens a stream on `link` for a call that replies with the returned
/// [`Opened`]. `credit` is what the call's args grant the core, `grant` what
/// the core grants the client; `end` builds the endpoint around its handle.
pub fn open(
    link: &Rc<Link>,
    credit: u32,
    grant: u32,
    end: impl FnOnce(Handle) -> Box<dyn Endpoint>,
) -> Result<Opened, Error> {
    if credit > MAX_CREDIT {
        return Err(Error::new(Code::Invalid, "credit is over MAX_CREDIT"));
    }
    let mut streams = link.streams.borrow_mut();
    let next = streams.used.checked_add(1);
    let Some(next) = next.filter(|_| streams.open.len() < MAX_STREAMS) else {
        // A client over a bound is dropped (design §2).
        link.close(false);
        return Err(Error::new(Code::Denied, "too many streams"));
    };
    streams.used = next;
    let s = StreamId(next);
    let shared = Rc::<Shared>::default();
    let link = Rc::downgrade(link);
    let handle = Handle {
        s,
        shared: shared.clone(),
        link,
    };
    let granted = grant.min(MAX_CREDIT);
    streams.open.push(Stream {
        s,
        end: end(handle),
        shared,
        credit,
        granted,
        sent: 0,
        parked: false,
        ended: false,
    });
    Ok(Opened { s, credit: granted })
}

/// The streams of one connection.
#[derive(Default)]
pub struct Streams {
    open: Vec<Stream>,
    /// Ids 1 to `used` were given out; none is given twice.
    used: u32,
    /// The stream whose turn came last.
    turn: usize,
}

struct Stream {
    s: StreamId,
    end: Box<dyn Endpoint>,
    shared: Rc<Shared>,
    /// Bytes the client still lets the core send.
    credit: u32,
    /// Bytes the core still lets the client send.
    granted: u32,
    /// Bytes sent, which is the offset of the next one.
    sent: u64,
    /// Left out of turns until credit arrives or the endpoint wakes it.
    parked: bool,
    /// Its close is queued; it goes at the end of this pull.
    ended: bool,
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.shared.closed.set(true);
    }
}

impl Stream {
    /// One data frame, mark or close; false when the endpoint had none.
    fn step(&mut self, link: &Link) -> bool {
        let (s, end) = (self.s, &mut self.end);
        let left = (self.credit as usize).min(MAX_DATA);
        let framed = link.append(|out| {
            out.reserve(4 + 1 + 4 + left);
            encode_data_in(s, out, |out| {
                let mut room = Room { out, left };
                let next = end.next(&mut room);
                (left - room.left, next)
            })
        });
        // A room never holds more than a frame does.
        let Ok((put, next)) = framed else {
            link.close(false);
            return false;
        };
        self.credit -= put as u32;
        self.sent += put as u64;
        let Some(at) = Offset::new(self.sent) else {
            // 2^53 bytes, 104 days at 1 GB/s: an offset JSON cannot carry exactly.
            self.end(link, CloseWhy::Overflow);
            return true;
        };
        match next {
            Next::More => {
                self.parked = put == 0;
                put > 0
            }
            Next::Wait => {
                self.parked = true;
                put > 0
            }
            Next::Mark(mark) => {
                link.send(&Control::Mark(Mark { s, at, ..mark }));
                true
            }
            Next::End(why) => {
                self.end(link, why);
                true
            }
        }
    }

    fn end(&mut self, link: &Link, why: CloseWhy) {
        self.ended = true;
        let why = Some(why);
        link.send(&Control::Close(Close { s: self.s, why }));
    }
}

/// Queues what a connection's streams have for the client: the grants and
/// closes their endpoints asked for, then, while fewer than [`WINDOW`]
/// bytes wait, a frame from each stream in turn.
pub(crate) fn pull(link: &Link) {
    if link.is_closing() {
        return;
    }
    let mut streams = link.streams.borrow_mut();
    let Streams { open, turn, .. } = &mut *streams;
    for st in open.iter_mut() {
        if st.shared.woken.take() {
            st.parked = false;
        }
        let n = st.shared.grant.take().min(MAX_CREDIT - st.granted);
        if n > 0 {
            st.granted += n;
            link.send(&Control::Credit(Credit { s: st.s, n }));
        }
        if let Some(why) = st.shared.close.take() {
            st.end(link, why);
        }
    }
    // Ends after a whole round in which no stream had anything.
    let mut idle = 0;
    while idle < open.len() && link.queued() < WINDOW {
        *turn = (*turn + 1) % open.len();
        let st = &mut open[*turn];
        if !st.parked && !st.ended && st.step(link) {
            idle = 0;
        } else {
            idle += 1;
        }
    }
    open.retain(|st| !st.ended);
}

/// A data, credit or close frame from the client; `false` ends the
/// connection.
pub(crate) fn receive(link: &Link, frame: Frame) -> bool {
    let mut streams = link.streams.borrow_mut();
    let s = match &frame {
        Frame::Data(Data { s, .. }) => *s,
        Frame::Control(Control::Credit(Credit { s, .. }) | Control::Close(Close { s, .. })) => *s,
        _ => return false,
    };
    let Some(i) = streams.open.iter().position(|st| st.s == s) else {
        // Frames for a closed stream may still be on their way and are
        // dropped; one for a stream never opened comes from a broken client.
        return (1..=streams.used).contains(&s.0);
    };
    let st = &mut streams.open[i];
    match frame {
        Frame::Data(Data { bytes, .. }) => {
            // Bytes beyond the grant end the connection (design §2).
            let Some(left) = st.granted.checked_sub(bytes.len() as u32) else {
                return false;
            };
            st.granted = left;
            if !bytes.is_empty() {
                st.end.write(&bytes);
            }
        }
        Frame::Control(Control::Credit(Credit { n, .. })) => {
            let Some(credit) = st.credit.checked_add(n).filter(|&c| c <= MAX_CREDIT) else {
                return false;
            };
            st.credit = credit;
            st.parked = false;
        }
        // The client closed it: nothing more either way.
        _ => drop(streams.open.remove(i)),
    }
    true
}

/// Drops the streams of a connection that ended, and their endpoints with
/// them, even while something else still holds the connection.
pub(crate) fn end(link: &Link) {
    link.streams.take();
}

#[cfg(feature = "fixtures")]
pub(crate) use fixture::fixture;

#[cfg(feature = "fixtures")]
mod fixture {
    use super::{Endpoint, Handle, Next, Room, open};
    use crate::calls::Cx;
    use tasktap_proto::{CloseWhy, Code, Error, FixtureStream, MAX_CREDIT, Mark, Offset, Opened};

    const PERIOD: usize = FixtureStream::PERIOD as usize;

    /// One period of the fixture's bytes. Sending copies from it once, as
    /// sending from a terminal's ring will.
    static PATTERN: [u8; PERIOD] = {
        let mut pattern = [0; PERIOD];
        let mut i = 0;
        while i < PERIOD {
            pattern[i] = FixtureStream::byte(i as u64);
            i += 1;
        }
        pattern
    };

    /// `fixture.stream`: the reply is the stream.
    pub fn fixture(cx: &mut Cx, args: FixtureStream) -> Result<Opened, Error> {
        let invalid = |why: &str| Err(Error::new(Code::Invalid, why));
        if !(1..=MAX_CREDIT).contains(&args.chunk) {
            return invalid("chunk must be 1 to MAX_CREDIT");
        }
        if !args.marks.is_sorted() || args.marks.last().is_some_and(|&at| at > args.send) {
            return invalid("marks must ascend and lie within send");
        }
        let receive = args.receive.get();
        let granted = u32::try_from(receive).map_or(args.chunk, |r| r.min(args.chunk));
        open(cx.link, args.credit, granted, |handle| {
            Box::new(Fixture {
                handle,
                send: args.send.get(),
                sent: 0,
                marks: args.marks,
                mark: 0,
                receive,
                got: 0,
                granted,
                chunk: args.chunk,
            })
        })
    }

    struct Fixture {
        handle: Handle,
        send: u64,
        sent: u64,
        marks: Vec<Offset>,
        /// The next mark to put.
        mark: usize,
        receive: u64,
        got: u64,
        /// What the core still lets the client send.
        granted: u32,
        chunk: u32,
    }

    impl Fixture {
        fn mark_due(&mut self) -> bool {
            let due = self.marks.get(self.mark).map(|at| at.get()) == Some(self.sent);
            self.mark += usize::from(due);
            due
        }
    }

    impl Endpoint for Fixture {
        fn next(&mut self, room: &mut Room<'_>) -> Next {
            if !self.mark_due() {
                let until = self.marks.get(self.mark).map_or(self.send, |at| at.get());
                let want = (until - self.sent).min(self.chunk.into());
                let mut want = want.min(room.left() as u64) as usize;
                while want > 0 {
                    let at = (self.sent % PERIOD as u64) as usize;
                    let n = room.put(&PATTERN[at..][..want.min(PERIOD - at)]);
                    self.sent += n as u64;
                    want -= n;
                }
                if !self.mark_due() {
                    return if self.sent < self.send {
                        Next::More
                    } else if self.got < self.receive {
                        Next::Wait
                    } else {
                        Next::End(CloseWhy::Done)
                    };
                }
            }
            Next::Mark(Mark {
                s: self.handle.id(),
                at: Offset::ZERO,
                size: None,
                live: false,
                gap: false,
                exit: None,
            })
        }

        fn write(&mut self, bytes: &[u8]) {
            let mut rest = bytes;
            while !rest.is_empty() {
                let at = (self.got % PERIOD as u64) as usize;
                let n = rest.len().min(PERIOD - at);
                if rest[..n] != PATTERN[at..at + n] {
                    self.handle.close(CloseWhy::Denied);
                    return;
                }
                self.got += n as u64;
                rest = &rest[n..];
            }
            self.granted -= bytes.len() as u32;
            // Keeps `chunk` granted, never more than is still to come.
            let want = (self.receive - self.got).min(self.chunk.into()) as u32;
            if want > self.granted {
                self.handle.grant(want - self.granted);
                self.granted = want;
            }
            if self.got == self.receive {
                self.handle.wake();
            }
        }
    }
}
