//! A terminal's output (design §9): the ring the core always drains it
//! into, the sizes it had where, the history kept on disk, and the clients
//! attached to it, each an [`Endpoint`] at its own position.
//!
//! Positions are terminal offsets: byte `n` of everything the terminal ever
//! wrote. A stream counts its own bytes from 0, so it says once where it
//! starts (`Opened.from`) and again after each gap (`Mark.from`).

use super::queries::Queries;
use crate::stream::{Endpoint, Handle, Next, Room};
use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::rc::Rc;
use std::sync::mpsc as plain;
use tasktap_proto::{CloseWhy, MAX_SAFE, Mark, Offset, Size, Terminal, TerminalState};

/// Output kept per terminal (design §10: 2 MiB at full scrollback).
pub const RING: usize = 2 << 20;
/// History a ring grows to by doubling; past it the ring takes all of
/// [`RING`] at once. Each buffer a ring outgrows goes back to the allocator,
/// which keeps it: doubling all the way left 0.6 to 1 MiB a terminal more
/// than its 2 MiB (measured by `scripts/measure.sh`).
const GROWN: usize = 64 << 10;
/// Input one attached client may have on its way to the process.
pub const INPUT: u32 = 64 << 10;
/// Sizes remembered for the bytes in the ring. A client resizing faster
/// than the terminal writes costs the oldest bytes, never more memory.
const SIZES: usize = 1024;

/// What a terminal shares with its attached clients.
pub struct Term {
    ring: VecDeque<u8>,
    /// The offset of the ring's first byte.
    start: u64,
    /// The size in effect from each offset on, the first at or before `start`.
    sizes: Vec<(u64, Size)>,
    /// Once the terminal has ended: its exit code, none when it has none.
    exit: Option<Option<u32>>,
    readers: Vec<Handle>,
    input: Option<plain::Sender<Vec<u8>>>,
    /// Input handed to the input thread and not yet written, in order: whom
    /// to grant it back to once it is, none for what the core typed.
    owed: VecDeque<(Option<Handle>, u32)>,
    /// What the program asks its terminal, which the core answers while no
    /// client is attached.
    queries: Queries,
}

impl Term {
    pub fn new(size: Size, input: plain::Sender<Vec<u8>>) -> Term {
        Term {
            ring: VecDeque::new(),
            start: 0,
            sizes: vec![(0, size)],
            exit: None,
            readers: Vec::new(),
            input: Some(input),
            owed: VecDeque::new(),
            queries: Queries::new(),
        }
    }

    pub fn end(&self) -> u64 {
        self.start + self.ring.len() as u64
    }

    pub fn size(&self) -> Size {
        self.sizes.last().map_or(Size(0, 0), |&(_, size)| size)
    }

    pub fn attach(&mut self, reader: Handle) {
        self.readers.push(reader);
    }

    /// Appends output, dropping the oldest bytes beyond [`RING`], and
    /// answers what it asks the terminal while no client is attached to
    /// answer it (`queries`).
    pub fn push(&mut self, bytes: &[u8]) {
        self.readers.retain(Handle::is_open);
        let found = self.queries.scan(bytes, !self.readers.is_empty());
        let kept;
        let bytes = match found.hidden {
            Some(hidden) => {
                kept = [&bytes[..hidden.start], &bytes[hidden.end..]].concat();
                &kept[..]
            }
            None => bytes,
        };
        if !found.answers.is_empty() {
            self.send(None, &found.answers);
        }
        let over = (self.ring.len() + bytes.len()).saturating_sub(RING);
        self.discard(self.start + over as u64);
        let need = self.ring.len() + bytes.len();
        if need > self.ring.capacity() {
            // Doubling while small, then the whole ring: a full ring holds
            // 2 MiB, not the 4 a doubling buffer would reach.
            let room = match need > GROWN {
                true => RING,
                false => need.next_power_of_two(),
            };
            self.ring.reserve_exact(room - self.ring.len());
        }
        self.ring.extend(bytes);
        self.wake();
    }

    /// A new size from the current offset on; false when it is the size already.
    pub fn resize(&mut self, size: Size) -> bool {
        if self.size() == size {
            return false;
        }
        let end = self.end();
        if self.sizes.last().is_some_and(|&(at, _)| at == end) {
            self.sizes.pop();
        }
        // After that pop the size before may be this one again.
        if self.size() != size {
            self.sizes.push((end, size));
        }
        if self.sizes.len() > SIZES {
            self.discard(self.sizes[1].0);
        }
        self.wake();
        true
    }

    /// The process has ended: no more output or input.
    pub fn ended(&mut self, exit: Option<u32>) {
        self.exit = Some(exit);
        self.input = None;
        self.owed.clear();
        self.wake();
    }

    /// Input from an attached client, granted back to it once written.
    fn take(&mut self, from: &Handle, bytes: &[u8]) {
        self.send(Some(from), bytes);
    }

    /// Input for the process; what the core types itself, as the launcher
    /// types a follow-up, has no client. False when the process takes no more.
    pub fn send(&mut self, from: Option<&Handle>, bytes: &[u8]) -> bool {
        let input = self.input.as_ref();
        let sent = input.is_some_and(|input| input.send(bytes.to_vec()).is_ok());
        if sent {
            self.owed.push_back((from.cloned(), bytes.len() as u32));
        }
        sent
    }

    /// The input thread wrote the oldest chunk.
    pub fn wrote(&mut self) {
        if let Some((Some(from), n)) = self.owed.pop_front() {
            from.grant(n);
        }
    }

    /// Writes the history to `path`, replacing what was there in one step.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        write(path, &self.history())
    }

    /// The history as it is written: a header line with the ring's start
    /// offset and sizes, then the bytes.
    pub fn history(&self) -> Vec<u8> {
        let mut history = serde_json::to_vec(&(self.start, &self.sizes)).unwrap_or_default();
        history.push(b'\n');
        let (a, b) = self.ring.as_slices();
        history.reserve_exact(a.len() + b.len());
        history.extend_from_slice(a);
        history.extend_from_slice(b);
        history
    }

    fn discard(&mut self, until: u64) {
        let n = (until.saturating_sub(self.start) as usize).min(self.ring.len());
        self.ring.drain(..n);
        self.start += n as u64;
        // Of the sizes before the new start only the last still applies.
        let before = self.sizes.partition_point(|&(at, _)| at <= self.start);
        self.sizes.drain(..before.saturating_sub(1));
    }

    fn wake(&mut self) {
        self.readers.retain(Handle::is_open);
        for reader in &self.readers {
            reader.wake();
        }
    }

    fn copy(&self, pos: u64, until: u64, room: &mut Room<'_>) -> usize {
        let from = (pos - self.start) as usize;
        let to = (until.min(self.end()) - self.start) as usize;
        let (a, b) = self.ring.as_slices();
        let (first, second) = if from < a.len() {
            (&a[from..to.min(a.len())], &b[..to.saturating_sub(a.len())])
        } else {
            (&b[from - a.len()..to - a.len()], &b[..0])
        };
        let n = room.put(first);
        if n < first.len() {
            n
        } else {
            n + room.put(second)
        }
    }
}

/// The history of a terminal that is no longer running, read from disk as
/// a client takes it.
pub struct Saved {
    file: Option<File>,
    /// Where the bytes start in the file, after the header line.
    body: u64,
    start: u64,
    end: u64,
    sizes: Vec<(u64, Size)>,
    exit: Option<u32>,
    buf: Vec<u8>,
}

impl Saved {
    /// What `path` holds for terminal `t`; nothing when it holds nothing,
    /// as for a terminal lost with the core.
    pub fn open(path: &Path, t: &Terminal) -> Saved {
        let exit = if t.state == TerminalState::Exited {
            t.exit
        } else {
            None
        };
        let mut saved = Saved {
            file: None,
            body: 0,
            start: t.offset.get(),
            end: t.offset.get(),
            sizes: vec![(t.offset.get(), Size(t.cols, t.rows))],
            exit,
            buf: Vec::new(),
        };
        if let Ok((file, body, start, sizes, len)) = header(path) {
            (saved.body, saved.start, saved.end) = (body, start, start + len);
            saved.file = Some(file);
            saved.sizes = sizes;
        }
        saved
    }

    fn copy(&mut self, pos: u64, until: u64, room: &mut Room<'_>) -> io::Result<usize> {
        let Some(file) = &mut self.file else {
            return Ok(0);
        };
        let n = ((until - pos) as usize).min(room.left());
        self.buf.resize(n, 0);
        file.seek(SeekFrom::Start(self.body + pos - self.start))?;
        file.read_exact(&mut self.buf)?;
        Ok(room.put(&self.buf))
    }
}

type Header = (File, u64, u64, Vec<(u64, Size)>, u64);

/// Writes a history to `path`, replacing what was there in one step.
pub fn write(path: &Path, history: &[u8]) -> io::Result<()> {
    if let Some(folder) = path.parent() {
        fs::create_dir_all(folder)?;
    }
    let new = path.with_extension("new");
    let mut file = File::create(&new)?;
    file.write_all(history)?;
    drop(file);
    fs::rename(new, path)
}

fn header(path: &Path) -> io::Result<Header> {
    let mut file = BufReader::new(File::open(path)?);
    let mut line = Vec::new();
    // The header is a few dozen bytes per size it remembers.
    (&mut file).take(64 << 10).read_until(b'\n', &mut line)?;
    let (start, sizes): (u64, Vec<(u64, Size)>) = serde_json::from_slice(&line)?;
    let file = file.into_inner();
    let len = file.metadata()?.len().saturating_sub(line.len() as u64);
    if sizes.is_empty() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok((file, line.len() as u64, start, sizes, len))
}

/// One client's attachment to a terminal: the far end of its stream.
pub struct Attachment {
    feed: Feed,
    handle: Handle,
    /// The offset of the next byte to send.
    pos: u64,
    /// A gap mark goes first.
    gap: bool,
    /// The size last sent.
    size: Option<Size>,
    /// Where the replay ends and the `live` mark goes.
    live: Option<u64>,
    /// The `exit` mark has gone.
    exited: bool,
}

pub enum Feed {
    Live(Rc<std::cell::RefCell<Term>>),
    Saved(Saved),
}

/// What a client at one position needs to know.
struct Here {
    start: u64,
    end: u64,
    size: Size,
    /// The offset of the next size change after the position.
    change: u64,
    exit: Option<Option<u32>>,
}

impl Feed {
    /// The terminal's first and last offset now.
    pub fn bounds(&self) -> (u64, u64) {
        match self {
            Feed::Live(term) => {
                let t = term.borrow();
                (t.start, t.end())
            }
            Feed::Saved(s) => (s.start, s.end),
        }
    }

    fn here(&self, pos: u64) -> Here {
        let at = |sizes: &[(u64, Size)]| {
            let next = sizes.partition_point(|&(at, _)| at <= pos);
            let size = sizes[next.saturating_sub(1)].1;
            (size, sizes.get(next).map_or(u64::MAX, |&(at, _)| at))
        };
        match self {
            Feed::Live(term) => {
                let t = term.borrow();
                let (size, change) = at(&t.sizes);
                let (start, end, exit) = (t.start, t.end(), t.exit);
                Here {
                    start,
                    end,
                    size,
                    change,
                    exit,
                }
            }
            Feed::Saved(s) => {
                let (size, change) = at(&s.sizes);
                let exit = Some(s.exit);
                Here {
                    start: s.start,
                    end: s.end,
                    size,
                    change,
                    exit,
                }
            }
        }
    }

    fn copy(&mut self, pos: u64, until: u64, room: &mut Room<'_>) -> io::Result<usize> {
        match self {
            Feed::Live(term) => Ok(term.borrow().copy(pos, until, room)),
            Feed::Saved(s) => s.copy(pos, until, room),
        }
    }
}

impl Attachment {
    /// Starts at `pos`, after a gap mark with `gap`; the replay ends where
    /// the terminal's output ends now.
    pub fn new(feed: Feed, handle: Handle, pos: u64, gap: bool) -> Attachment {
        let live = Some(feed.bounds().1);
        Attachment {
            feed,
            handle,
            pos,
            gap,
            size: None,
            live,
            exited: false,
        }
    }

    fn mark(&self, set: impl FnOnce(&mut Mark)) -> Next {
        let mut mark = Mark {
            s: self.handle.id(),
            at: Offset::ZERO,
            size: None,
            live: false,
            gap: false,
            from: None,
            exit: None,
        };
        set(&mut mark);
        Next::Mark(mark)
    }
}

impl Endpoint for Attachment {
    fn next(&mut self, room: &mut Room<'_>) -> Next {
        let mut here = self.feed.here(self.pos);
        if self.pos < here.start {
            // A client without credit learns of the gap once it has some:
            // marks need none, and the ring may move on many times before.
            if room.left() == 0 {
                return Next::More;
            }
            // The ring moved past this client: a gap, then a replay.
            (self.pos, self.gap, self.size, self.live) = (here.start, true, None, Some(here.end));
            here = self.feed.here(self.pos);
        }
        if std::mem::take(&mut self.gap) {
            let from = Offset::new(self.pos.min(MAX_SAFE));
            return self.mark(|m| (m.gap, m.from) = (true, from));
        }
        if self.size != Some(here.size) {
            self.size = Some(here.size);
            return self.mark(|m| m.size = Some(here.size));
        }
        if self.live == Some(self.pos) {
            self.live = None;
            return self.mark(|m| m.live = true);
        }
        let until = here.end.min(here.change).min(self.live.unwrap_or(u64::MAX));
        if self.pos < until {
            return match self.feed.copy(self.pos, until, room) {
                Ok(n) => {
                    self.pos += n as u64;
                    Next::More
                }
                // The history on disk is unreadable from here on.
                Err(_) => Next::End(CloseWhy::Gone),
            };
        }
        match here.exit {
            Some(exit) if !self.exited => {
                self.exited = true;
                self.mark(|m| m.exit = Some(exit))
            }
            Some(_) => Next::End(CloseWhy::Done),
            None => Next::Wait,
        }
    }

    fn write(&mut self, bytes: &[u8]) {
        if let Feed::Live(term) = &self.feed {
            term.borrow_mut().take(&self.handle, bytes);
        }
    }
}
