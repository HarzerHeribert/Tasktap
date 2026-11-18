//! A terminal's output (design §9): the ring the core always drains it
//! into, the sizes it had where, the history kept on disk, and the clients
//! attached to it, each an [`Endpoint`] at its own position.
//!
//! Positions are terminal offsets: byte `n` of everything the terminal ever
//! wrote. A stream counts its own bytes from 0, so it says once where it
//! starts (`Opened.from`) and again after each gap (`Mark.from`).

use super::process::Input;
use super::queries::Queries;
use crate::stream::{Endpoint, Handle, Next, Room};
use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc as plain;
use tasktap_proto::{
    CloseWhy, MAX_SAFE, MAX_TERMINAL_CLIENTS, Mark, Offset, Size, Terminal, TerminalState,
};
use tokio::sync::oneshot;

/// Whether what the core typed was written: `Err` says why not.
pub type Typed = Result<(), String>;

/// Why typed text was not written, once the terminal took no more input.
const UNWRITABLE: &str = "the terminal no longer takes input";
/// Why typed text was not written whole, once the core gave up on it.
const UNTAKEN: &str = "the agent did not take the text in time";

/// Output kept per terminal (design §10: 2 MiB at full scrollback).
pub const RING: usize = 2 << 20;
/// History a ring grows to by doubling; past it the ring takes all of
/// [`RING`] at once. Each buffer a ring outgrows goes back to the allocator,
/// which keeps it: doubling all the way left 0.6 to 1 MiB a terminal more
/// than its 2 MiB (measured by `scripts/measure.sh`).
const GROWN: usize = 64 << 10;
/// Input one attached client may have on its way to the process, and the
/// most a terminal holds for its process before it grants any more: what
/// a client sent and closed its stream on, and what the core typed, count.
/// With at most [`MAX_TERMINAL_CLIENTS`] attached at once, a process that
/// reads nothing has less than that many times this, and once more, held
/// for it: every grant is made while less than this is held, and no
/// client ever has more than this granted and unwritten.
pub const INPUT: u32 = 64 << 10;
/// Answers to what the program asked its terminal that the core may have
/// typed and the input thread not yet written (design §9, "Questions to
/// the terminal"). A program asks five things as it starts, 77 bytes of
/// answers, so this is a dozen such bursts; one that keeps asking and
/// reads nothing is left unanswered beyond it, and holds no more memory.
const ANSWERS: u32 = 1 << 10;
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
    readers: Vec<Reader>,
    /// Bytes of input handed to the input thread and not yet written.
    queued: u32,
    /// How many of them are the core's answers to what the program asked.
    answering: u32,
    input: Option<plain::Sender<Input>>,
    /// Input handed to the input thread and not yet written, in order.
    owed: VecDeque<(Owner, u32)>,
    /// Why the input thread stopped writing, once it did.
    unwritable: Option<String>,
    /// What the program asks its terminal, which the core answers while no
    /// client is attached.
    queries: Queries,
}

impl Term {
    pub fn new(size: Size, input: plain::Sender<Input>) -> Term {
        Term {
            ring: VecDeque::new(),
            start: 0,
            sizes: vec![(0, size)],
            exit: None,
            readers: Vec::new(),
            queued: 0,
            answering: 0,
            input: Some(input),
            owed: VecDeque::new(),
            unwritable: None,
            queries: Queries::new(),
        }
    }

    pub fn end(&self) -> u64 {
        self.start + self.ring.len() as u64
    }

    pub fn size(&self) -> Size {
        self.sizes.last().map_or(Size(0, 0), |&(_, size)| size)
    }

    /// What a client attaching now is granted: as much as one client may
    /// have on its way, while the terminal holds less than that for its
    /// process; never what input already waiting there takes. None while
    /// as many clients are attached as a terminal takes.
    pub fn grantable(&mut self) -> Option<u32> {
        self.readers.retain(|r| r.handle.is_open());
        (self.readers.len() < MAX_TERMINAL_CLIENTS).then(|| INPUT.saturating_sub(self.queued))
    }

    /// A client attached, `granted` what [`Term::grantable`] said.
    pub fn attach(&mut self, handle: Handle, granted: u32) {
        self.readers.push(Reader {
            handle,
            unused: granted,
            sent: 0,
        });
    }

    /// Appends output, dropping the oldest bytes beyond [`RING`], and
    /// answers what it asks the terminal while no client is attached to
    /// answer it (`queries`), within [`ANSWERS`] not yet written.
    pub fn push(&mut self, bytes: &[u8]) {
        self.readers.retain(|r| r.handle.is_open());
        let room = ANSWERS.saturating_sub(self.answering) as usize;
        let found = self.queries.scan(bytes, !self.readers.is_empty(), room);
        let kept;
        let bytes = match found.hidden {
            Some(hidden) => {
                kept = [&bytes[..hidden.start], &bytes[hidden.end..]].concat();
                &kept[..]
            }
            None => bytes,
        };
        if !found.answers.is_empty() && self.hand(Owner::Answer, &found.answers, None) {
            self.answering = self.answering.saturating_add(found.answers.len() as u32);
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
        self.unwritten("the terminal has ended");
        self.wake();
    }

    /// The input thread could not write and stopped: no more input. Nothing
    /// it held is granted back, and what the core typed was not written.
    pub fn unwritable(&mut self, why: String) {
        self.input = None;
        self.unwritten(&format!("{UNWRITABLE}: {why}"));
        self.unwritable = Some(why);
    }

    /// Everything still owed was not written: whoever typed it learns so.
    fn unwritten(&mut self, why: &str) {
        self.queued = 0;
        self.answering = 0;
        for (owner, _) in self.owed.drain(..) {
            if let Owner::Core(typist) = owner {
                let _ = typist.send(Err(why.into()));
            }
        }
    }

    /// Input from an attached client, within what it was granted.
    fn take(&mut self, from: &Handle, bytes: &[u8]) {
        let n = bytes.len() as u32;
        if let Some(r) = self.readers.iter_mut().find(|r| r.handle.same(from)) {
            r.unused = r.unused.saturating_sub(n);
            r.sent += n;
        }
        self.hand(Owner::Client(from.clone()), bytes, None);
    }

    /// Text the core types, as the launcher types a follow-up, and how its
    /// writing went once the input thread has written it, could not, or
    /// stopped because `cancel` was set; `Err` with why when the process
    /// takes no input any more.
    pub fn type_text(
        &mut self,
        bytes: &[u8],
        cancel: Arc<AtomicBool>,
    ) -> Result<oneshot::Receiver<Typed>, String> {
        if let Some(why) = &self.unwritable {
            return Err(format!("{UNWRITABLE}: {why}"));
        }
        let (typist, typed) = oneshot::channel();
        match self.hand(Owner::Core(typist), bytes, Some(cancel)) {
            true => Ok(typed),
            false => Err("the terminal has ended".into()),
        }
    }

    /// Input for the process, on its way to the input thread. False when
    /// the process takes no more.
    fn hand(&mut self, owner: Owner, bytes: &[u8], cancel: Option<Arc<AtomicBool>>) -> bool {
        let input = self.input.as_ref();
        let chunk = || Input {
            bytes: bytes.to_vec(),
            cancel: cancel.clone(),
        };
        let sent = input.is_some_and(|input| input.send(chunk()).is_ok());
        if sent {
            self.owed.push_back((owner, bytes.len() as u32));
            self.queued = self.queued.saturating_add(bytes.len() as u32);
        }
        sent
    }

    /// The input thread wrote the oldest chunk, `whole` or only until the
    /// core gave up on it: a client may send as much again, and the core's
    /// typist learns how it went.
    pub fn wrote(&mut self, whole: bool) {
        let Some((owner, n)) = self.owed.pop_front() else {
            return;
        };
        self.queued = self.queued.saturating_sub(n);
        match owner {
            Owner::Client(from) => {
                if let Some(r) = self.readers.iter_mut().find(|r| r.handle.same(&from)) {
                    r.sent = r.sent.saturating_sub(n);
                }
            }
            Owner::Core(typist) => {
                drop(typist.send(if whole { Ok(()) } else { Err(UNTAKEN.into()) }));
            }
            Owner::Answer => self.answering = self.answering.saturating_sub(n),
        }
        self.top_up();
    }

    /// Grants each attached client what it may have on its way again, out
    /// of what the terminal does not hold for its process yet. A client
    /// that closed its stream gave up what it was granted.
    fn top_up(&mut self) {
        self.readers.retain(|r| r.handle.is_open());
        let mut room = INPUT.saturating_sub(self.queued);
        for r in &mut self.readers {
            let grant = INPUT.saturating_sub(r.unused + r.sent).min(room);
            if grant > 0 {
                r.handle.grant(grant);
                r.unused += grant;
                room -= grant;
            }
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
        self.readers.retain(|r| r.handle.is_open());
        for r in &self.readers {
            r.handle.wake();
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

/// An attached client, and the input it may send.
struct Reader {
    handle: Handle,
    /// Granted and not sent yet.
    unused: u32,
    /// Sent and not written yet.
    sent: u32,
}

/// Who sent input on its way to the process.
enum Owner {
    /// A client, granted it back once it is written.
    Client(Handle),
    /// The core, whose typist waits to learn whether it was written.
    Core(oneshot::Sender<Typed>),
    /// The core, answering what the program asked its terminal.
    Answer,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// What a program asks as it starts: what its terminal is, twice, where
    /// the cursor is, and its two colors.
    const ASKS: &[u8] = b"\x1b[c\x1b[>c\x1b[6n\x1b]10;?\x07\x1b]11;?\x1b\\";
    const ANSWERED: &[u8] = b"\x1b[?62;22c\x1b[>0;276;0c\x1b[1;1R\
        \x1b]10;rgb:e4e4/e6e6/eded\x07\x1b]11;rgb:1111/1313/1818\x1b\\";

    /// A terminal nobody is attached to, and what its input thread would
    /// take. Its output is past where the Windows console asks its own
    /// question, so every question is the program's.
    fn term() -> (Term, plain::Receiver<Input>) {
        let (input, inputs) = plain::channel();
        let mut term = Term::new(Size(80, 24), input);
        term.push(&[b' '; 64]);
        (term, inputs)
    }

    /// The chunks handed to the input thread since the last look.
    fn handed(inputs: &plain::Receiver<Input>) -> Vec<Vec<u8>> {
        inputs.try_iter().map(|input| input.bytes).collect()
    }

    #[test]
    fn answers_to_a_program_that_never_reads_stay_bounded() {
        let (mut term, inputs) = term();
        // Asked one write at a time, then in chunks as large as a read.
        for _ in 0..5000 {
            term.push(ASKS);
        }
        for _ in 0..100 {
            term.push(&ASKS.repeat(500));
        }
        // The input thread wrote nothing: this is all the core holds.
        let pending = handed(&inputs);
        let bytes: usize = pending.iter().map(Vec::len).sum();
        assert!(bytes <= ANSWERS as usize, "{bytes} bytes of answers");
        assert!(bytes >= ANSWERED.len() * 12, "{bytes} bytes of answers");
        assert_eq!(term.queued as usize, bytes);
        // Unanswered until what is pending has been written, then again.
        for _ in &pending {
            term.wrote(true);
        }
        assert_eq!((term.queued, term.answering), (0, 0));
        term.push(ASKS);
        assert_eq!(handed(&inputs), [ANSWERED]);
    }

    #[test]
    fn a_program_that_reads_gets_every_answer() {
        let (mut term, inputs) = term();
        // A burst of forty questions before it reads any answer.
        term.push(&ASKS.repeat(8));
        assert_eq!(handed(&inputs), [ANSWERED.repeat(8)]);
        term.wrote(true);
        // And as often as it likes while it reads.
        for _ in 0..5000 {
            term.push(ASKS);
            assert_eq!(handed(&inputs), [ANSWERED]);
            term.wrote(true);
        }
    }

    #[test]
    fn a_terminal_that_ended_owes_no_answers() {
        let (mut term, inputs) = term();
        term.push(&ASKS.repeat(8));
        term.unwritable("gone".into());
        assert_eq!((term.queued, term.answering), (0, 0));
        assert_eq!(handed(&inputs).len(), 1);
    }
}
