//! Terminals (design §9): each test starts the real binary, which runs
//! `tasktap fixture-terminal` in real pseudo-terminals, and speaks the
//! protocol through `client.rs`.
//!
//! On Mac and Linux a terminal passes printable output through unchanged,
//! so output is compared byte for byte. Windows' console renders what a
//! program writes and sends its own rendering, so there output is compared
//! by the fixture's lines, found in order in the text without escapes.

use std::collections::BTreeSet;
use std::path::Path;
use std::time::{Duration, Instant};
use tasktap_core::client::Client;
use tasktap_core::{fixture_fold, fixture_line as line};
use tasktap_proto::call::{self, Code};
use tasktap_proto::{
    CloseProject, CloseWhy, Control, Data, Delete, Empty, Frame, Mark, Offset, OpenTerminal,
    ProjectId, Ref, ResizeTerminal, Retire, RunState, Runs, Size, StartTerminal, StreamId,
    TerminalId, TerminalKind, TerminalState, When,
};

mod common;

use common::*;

/// Bytes of a fixture line once a terminal has made `\r\n` of its newline.
const LINE: u64 = 72 + 2;
const RING: u64 = 2 << 20;
/// Longest any wait here may take.
const PATIENCE: Duration = Duration::from_secs(30);

fn fixture(steps: &[&str]) -> StartTerminal {
    let mut argv = vec![EXE.to_owned(), "fixture-terminal".to_owned()];
    argv.extend(steps.iter().map(|s| s.to_string()));
    StartTerminal {
        project: None,
        argv,
        title: None,
    }
}

fn args(
    id: TerminalId,
    start: Option<StartTerminal>,
    from: Option<u64>,
    credit: u32,
) -> OpenTerminal {
    OpenTerminal {
        id,
        start,
        cols: 100,
        rows: 30,
        from: from.map(|f| Offset::new(f).unwrap()),
        credit,
    }
}

/// What one client received on one terminal stream, by terminal offset.
struct View {
    s: StreamId,
    /// Runs of bytes: the first from where the stream started, one more
    /// after each gap.
    runs: Vec<(u64, Vec<u8>)>,
    /// Stream bytes so far, which marks count.
    at: u64,
    /// Every mark, at the terminal offset it came at.
    marks: Vec<(u64, Mark)>,
    closed: Option<Option<CloseWhy>>,
}

impl View {
    fn pos(&self) -> u64 {
        let (start, bytes) = self.runs.last().unwrap();
        start + bytes.len() as u64
    }

    /// The bytes since the stream, or its last replay, started.
    fn bytes(&self) -> &[u8] {
        &self.runs.last().unwrap().1
    }

    fn start(&self) -> u64 {
        self.runs.last().unwrap().0
    }

    fn exit(&self) -> Option<Option<u32>> {
        self.marks.iter().find_map(|(_, m)| m.exit)
    }

    fn sizes(&self) -> Vec<(u64, Size)> {
        (self.marks.iter())
            .filter_map(|&(at, m)| Some((at, m.size?)))
            .collect()
    }

    fn lives(&self) -> Vec<u64> {
        self.marks
            .iter()
            .filter(|(_, m)| m.live)
            .map(|&(at, _)| at)
            .collect()
    }
}

fn open(c: &mut Client, args: &OpenTerminal, auto: bool) -> View {
    let opened = c
        .opened::<call::TerminalOpen>(args, args.credit, auto)
        .unwrap();
    let opened = opened.unwrap_or_else(|e| panic!("terminal.open was refused: {e}"));
    View {
        s: opened.s,
        runs: vec![(
            opened.from.expect("where the stream starts").get(),
            Vec::new(),
        )],
        at: 0,
        marks: Vec::new(),
        closed: None,
    }
}

/// Takes one frame and applies it to `v`.
fn pump(c: &mut Client, v: &mut View) {
    let frame = c.recv().unwrap_or_else(|e| {
        let tail = &v.bytes()[v.bytes().len().saturating_sub(600)..];
        panic!(
            "{e} at offset {}, after {:?}",
            v.pos(),
            String::from_utf8_lossy(tail)
        )
    });
    match frame {
        Frame::Data(Data { s, bytes }) if s == v.s => {
            v.at += bytes.len() as u64;
            v.runs.last_mut().unwrap().1.extend(bytes);
        }
        Frame::Control(Control::Mark(m)) if m.s == v.s => {
            assert_eq!(
                m.at.get(),
                v.at,
                "a mark is where the stream bytes before it end"
            );
            if m.gap {
                let from = m.from.expect("a gap says where the replay starts").get();
                v.runs.push((from, Vec::new()));
            }
            v.marks.push((v.pos(), m));
        }
        Frame::Control(Control::Close(close)) if close.s == v.s => v.closed = Some(close.why),
        // Credit, and what other streams of the same client have.
        Frame::Control(Control::Credit(_) | Control::Mark(_) | Control::Close(_)) => {}
        Frame::Data(_) => {}
        other => panic!("unexpected {other:?}"),
    }
}

/// Takes frames until `done` holds.
fn until(c: &mut Client, v: &mut View, what: &str, done: impl Fn(&View) -> bool) {
    let start = Instant::now();
    while !done(v) {
        assert!(
            v.closed.is_none(),
            "the stream closed while waiting for {what}"
        );
        assert!(start.elapsed() < PATIENCE, "no {what} after {PATIENCE:?}");
        pump(c, v);
    }
}

fn closed(c: &mut Client, v: &mut View) {
    let start = Instant::now();
    while v.closed.is_none() {
        assert!(start.elapsed() < PATIENCE, "the stream never closed");
        pump(c, v);
    }
}

/// Lines `first..first + n` as a Unix terminal shows them.
fn lines(first: u64, n: u64) -> Vec<u8> {
    let lines = (first..first + n).map(|i| line(i) + "\r\n");
    lines.collect::<String>().into_bytes()
}

/// The text of terminal output without escape sequences or line breaks.
fn text(bytes: &[u8]) -> String {
    let mut text = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            0x1b if bytes.get(i + 1) == Some(&b'[') => {
                i += 2;
                while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                    i += 1;
                }
                i += 1;
            }
            0x1b if bytes.get(i + 1) == Some(&b']') => {
                while i < bytes.len() && bytes[i] != 0x07 && !bytes[i..].starts_with(b"\x1b\\") {
                    i += 1;
                }
                i += if bytes.get(i) == Some(&0x07) { 1 } else { 2 };
            }
            0x1b => i += 2,
            b'\r' | b'\n' => i += 1,
            b => {
                text.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&text).into_owned()
}

/// Whether `bytes` hold line `i` in their last 8 KiB: on Windows, after
/// the last line, the console may repaint its screen.
fn shows(bytes: &[u8], i: u64) -> bool {
    let tail = &bytes[bytes.len().saturating_sub(8 << 10)..];
    text(tail).contains(&line(i))
}

/// Lines `first..first + n` were printed, all, in order, and nothing else:
/// byte for byte on Mac and Linux, by text on Windows.
fn assert_printed(bytes: &[u8], first: u64, n: u64) {
    if cfg!(windows) {
        let text = text(bytes);
        let mut at = 0;
        for i in first..first + n {
            let found = text[at..].find(&line(i));
            at += found.unwrap_or_else(|| panic!("line {i} is missing or out of order")) + 72;
        }
    } else {
        let want = lines(first, n);
        if let Some(i) = (0..bytes.len().min(want.len())).find(|&i| bytes[i] != want[i]) {
            panic!("output differs at byte {i} of {}", want.len());
        }
        assert_eq!(bytes.len(), want.len(), "output length");
    }
}

/// The first `n` lines' bytes, where they can be counted.
fn head(bytes: &[u8], n: u64) -> &[u8] {
    if cfg!(windows) {
        bytes
    } else {
        &bytes[..bytes.len().min((n * LINE) as usize)]
    }
}

/// Whether lines `first..first + n` are all there, as far as `assert_printed` looks.
fn printed(bytes: &[u8], first: u64, n: u64) -> bool {
    if cfg!(windows) {
        shows(bytes, first + n - 1)
    } else {
        bytes.len() as u64 >= n * LINE
    }
}

fn exits_within(core: &mut Core, limit: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < limit {
        if !core.running() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

fn state(w: &mut Watch, id: TerminalId, state: TerminalState) {
    w.until("a terminal's state", |m| {
        m.terminals.get(&id).is_some_and(|t| t.state == state)
    });
}

#[test]
fn output_arrives_intact_and_in_order_through_tiny_credit() {
    let data = Folder::new("tt-tiny");
    let core = Core::start(&data);
    let mut c = core.device();
    // Within the ring: nothing is lost however slowly it is read. Every 13
    // bytes are a round trip, which a Windows pipe and console make several
    // times slower than Mac and Linux do: up to 18 s of the 60 a test may
    // take there. So Windows reads a third as many lines, still far more
    // than any pipe or console holds.
    let n = if cfg!(windows) { 4_000 } else { 12_000 };
    let start = fixture(&[&format!("print {n}"), "sleep 30000"]);
    let mut v = open(
        &mut c,
        &args(TerminalId::mint(), Some(start), None, 13),
        false,
    );
    let mut granted = 13;
    while !printed(v.bytes(), 0, n) {
        if v.at == granted {
            c.grant(v.s, 13).unwrap();
            granted += 13;
        }
        pump(&mut c, &mut v);
    }
    assert_printed(v.bytes(), 0, n);
    assert_eq!(v.sizes(), [(0, Size(100, 30))]);
    assert!(v.marks.iter().all(|(_, m)| !m.gap));
}

#[test]
fn tens_of_megabytes_arrive_intact_through_a_slow_client_and_a_reconnect() {
    let data = Folder::new("tt-mb");
    let core = Core::start(&data);
    let mut c = core.device();
    let id = TerminalId::mint();
    // The fixture prints each batch when asked, so the client, however slow,
    // stays within the ring: a slow client loses nothing then. Windows'
    // console renders each line before it passes it on, several times
    // slower than a Mac or Linux terminal: up to 10 s of the 60 a test may
    // take there. So Windows prints a third as much, still three times what
    // the ring holds.
    let (batch, batches) = (4096, if cfg!(windows) { 24 } else { 70 });
    // Windows' console can hold back a line typed as a burst ends, with its
    // program waiting to read it (the test of a line typed so, below). So
    // there each request is typed a batch early, while the batch before it
    // still comes: the program finds it when it reads, and the client is
    // at most two batches behind, a third of the ring.
    let early = u64::from(cfg!(windows));
    let ask = |c: &mut Client, v: &View, b: u64| {
        if b < batches {
            c.write(v.s, format!("{batch}\r").as_bytes()).unwrap();
        }
    };
    let mut v = open(
        &mut c,
        &args(id, Some(fixture(&["serve"])), None, 16 << 10),
        true,
    );
    let mut all = Vec::new();
    // Where in the view the search for a batch's last line goes on: with a
    // request typed early the next batch follows at once.
    let searched = std::cell::Cell::new(0);
    for b in 0..early {
        ask(&mut c, &v, b);
    }
    for b in 0..batches {
        let before = v.pos();
        ask(&mut c, &v, b + early);
        let last = (b + 1) * batch - 1;
        if b == batches / 2 {
            // Mid-stream, away with the whole connection, then on from
            // where it was: only the missing bytes come.
            until(&mut c, &mut v, "part of a batch", |v| {
                v.pos() > before + 100_000
            });
            let from = v.pos();
            all.extend_from_slice(v.bytes());
            drop(c);
            c = core.device();
            v = open(&mut c, &args(id, None, Some(from), 16 << 10), true);
            assert_eq!(v.start(), from, "the stream goes on where it was");
            searched.set(0);
        }
        until(&mut c, &mut v, &format!("batch {b}"), |v| {
            if early == 0 {
                return shows(v.bytes(), last);
            }
            let bytes = v.bytes();
            let found = text(&bytes[searched.get()..]).contains(&line(last));
            if !found {
                // Less than the line and what the console wraps it in.
                searched.set(searched.get().max(bytes.len().saturating_sub(4 << 10)));
            }
            found
        });
    }
    all.extend_from_slice(v.bytes());
    assert!(v.marks.iter().all(|(_, m)| !m.gap), "no gap");
    let total = batch * batches;
    let least = if cfg!(windows) { 3 * RING } else { 20 << 20 };
    assert!(
        all.len() as u64 > least,
        "more than {least} bytes: {}",
        all.len()
    );
    if cfg!(windows) {
        let text = text(&all);
        let mut at = 0;
        for i in 0..total {
            let found = text[at..].find(&line(i));
            at += found.unwrap_or_else(|| panic!("line {i} is missing or out of order")) + 72;
        }
    } else {
        // Each request comes back first as the terminal echoes it.
        let mut want = Vec::new();
        for b in 0..batches {
            want.extend_from_slice(format!("{batch}\r\n").as_bytes());
            want.extend(lines(b * batch, batch));
        }
        assert!(all == want, "{total} lines intact and in order");
    }
}

#[test]
fn a_client_that_falls_behind_gets_a_gap_and_a_replay() {
    let data = Folder::new("tt-gap");
    let core = Core::start(&data);
    let mut w = core.watch();
    let mut c = core.device();
    let id = TerminalId::mint();
    let n = 60_000;
    let start = fixture(&[&format!("print {n}"), "exit 0"]);
    let mut v = open(&mut c, &args(id, Some(start), None, 1024), false);
    until(&mut c, &mut v, "the first KiB", |v| v.at == 1024);
    // Meanwhile the terminal wrote twice what the ring holds, and ended.
    state(&mut w, id, TerminalState::Exited);
    let end = w.model.terminals[&id].offset.get();
    c.grant(v.s, 4 << 20).unwrap();
    closed(&mut c, &mut v);
    assert_eq!(v.closed, Some(Some(CloseWhy::Done)));
    assert_eq!(v.runs.len(), 2, "one gap");
    let from = v.start();
    assert_eq!(
        (from, v.pos()),
        (end - RING, end),
        "a replay of the whole ring"
    );
    let kinds: Vec<_> = (v.marks.iter())
        .map(|(at, m)| (*at, m.gap, m.size.is_some(), m.live, m.exit))
        .collect();
    assert_eq!(
        kinds,
        [
            (0, false, true, false, None),
            (0, false, false, true, None),
            (from, true, false, false, None),
            (from, false, true, false, None),
            (end, false, false, true, None),
            (end, false, false, false, Some(Some(0))),
        ]
    );
    if cfg!(windows) {
        assert!(
            shows(v.bytes(), n - 1),
            "the replay ends with the last line"
        );
    } else {
        assert_eq!(end, n * LINE);
        assert!(
            v.bytes() == &lines(0, n)[from as usize..],
            "the replay is the ring"
        );
    }
}

/// Both views hold the same bytes where they overlap. A Windows console may
/// keep writing after one of them stopped reading, so they may end apart.
fn same(a: &View, b: &View, why: &str) {
    let (start, end) = (a.start().max(b.start()), a.pos().min(b.pos()));
    assert!(start < end, "{why}: the views do not overlap");
    let range = |v: &View| (start - v.start()) as usize..(end - v.start()) as usize;
    assert!(a.bytes()[range(a)] == b.bytes()[range(b)], "{why}");
}

#[test]
fn two_clients_at_different_positions_each_get_their_own_stream() {
    let data = Folder::new("tt-two");
    let core = Core::start(&data);
    let (mut a, mut b) = (core.device(), core.device());
    let id = TerminalId::mint();
    let start = fixture(&["print 10000", "serve"]);
    let mut va = open(&mut a, &args(id, Some(start), None, 64 << 10), true);
    until(&mut a, &mut va, "the lines", |v| {
        printed(v.bytes(), 0, 10_000)
    });
    assert_printed(head(va.bytes(), 10_000), 0, 10_000);
    // B comes in halfway.
    let from = va.pos() / 2;
    let mut vb = open(&mut b, &args(id, None, Some(from), 4096), true);
    assert_eq!(vb.start(), from);
    let caught_up = va.pos();
    until(&mut b, &mut vb, "B to catch up", |v| v.pos() >= caught_up);
    same(&va, &vb, "B has A's bytes from its offset on");
    // Both see what comes next.
    a.write(va.s, b"300\r").unwrap();
    until(&mut a, &mut va, "more", |v| shows(v.bytes(), 10_299));
    let end = va.pos();
    until(&mut b, &mut vb, "more", |v| v.pos() >= end);
    same(&va, &vb, "and the same bytes after");
    assert_eq!(vb.lives().len(), 1);
    if cfg!(unix) {
        assert_eq!(
            vb.lives(),
            [caught_up],
            "live where the ring ended when B came"
        );
    }
    assert_eq!(vb.sizes(), [(from, Size(100, 30))]);
}

#[test]
fn the_process_is_never_blocked_while_no_client_is_attached() {
    let data = Folder::new("tt-free");
    let core = Core::start(&data);
    let mut w = core.watch();
    let id = TerminalId::mint();
    let n = 100_000;
    {
        let mut c = core.device();
        let start = fixture(&[&format!("print {n}"), "exit 3"]);
        let v = open(&mut c, &args(id, Some(start), None, 1), false);
        // Nothing reads: the tab is closed and its window gone.
        c.close(v.s).unwrap();
    }
    // Far more than the ring holds, written to the end.
    state(&mut w, id, TerminalState::Exited);
    let t = &w.model.terminals[&id];
    assert_eq!(t.exit, Some(3));
    let mut c = core.device();
    let mut v = open(&mut c, &args(id, None, None, 4 << 20), true);
    closed(&mut c, &mut v);
    assert_eq!(v.exit(), Some(Some(3)));
    assert_eq!(v.pos() - v.start(), RING);
    if cfg!(windows) {
        assert!(shows(v.bytes(), n - 1));
    } else {
        assert_eq!(v.pos(), n * LINE);
        assert!(v.bytes() == &lines(0, n)[v.start() as usize..]);
    }
}

#[test]
fn input_reaches_the_process_and_comes_back() {
    let data = Folder::new("tt-input");
    let core = Core::start(&data);
    let mut c = core.device();
    let start = fixture(&["serve"]);
    let mut v = open(
        &mut c,
        &args(TerminalId::mint(), Some(start), None, 1 << 20),
        true,
    );
    c.write(v.s, b"hello\r").unwrap();
    until(&mut c, &mut v, "the echo", |v| {
        text(v.bytes()).contains("<hello>")
    });
    // More input than the core lets one client have on its way at once:
    // credit comes back as the process takes it.
    let row = "x".repeat(100);
    let lines: Vec<String> = (0..2000).map(|i| format!("{i:04}{row}")).collect();
    let input: String = lines.iter().map(|l| format!("{l}\r")).collect();
    c.write(v.s, input.as_bytes()).unwrap();
    c.write(v.s, b"sum\r").unwrap();
    // The process saw every line, whole and in order: one more than "hello".
    let hash = lines
        .iter()
        .fold(fixture_fold(FNV, "hello"), |h, l| fixture_fold(h, l));
    let sum = format!("sum 2001 {hash:016x}");
    until(&mut c, &mut v, "the sum", |v| {
        text(&v.bytes()[v.bytes().len().saturating_sub(1000)..]).contains("sum ")
    });
    assert!(text(v.bytes()).contains(&sum), "{sum}");
}

const FNV: u64 = 0xcbf2_9ce4_8422_2325;

/// A line typed the moment a program's output has come reaches the program.
/// Each terminal here answers a line with a burst of output and reads the
/// next, and its client types that line as soon as the burst is whole, on
/// several terminals at once so that the machine is busy.
///
/// The console host that ships with Windows fails this, not the core: about
/// one such line in a hundred stays in the console, which echoes nothing and
/// leaves the program waiting in its read, until any other input event
/// comes (a key, a focus event, a size that changed; seen with conhost
/// 10.0.26100.4202, on ARM64 and x64, in every run of this test). The core
/// has written the line by then, and has passed on everything the console
/// gave it. Sending such an event after each typed line ended the waiting
/// and now and then crashed the console host instead, so the core sends
/// none. Microsoft's current console (ConPTY 1.25) passes every line on, in
/// 86 runs of this test out of 86 on both architectures, so the core runs
/// its terminals in that one when it lies beside it (design §9, "Input"):
/// `core/scripts/conpty.ps1` puts it there, for the app's build and for the
/// checks. Beside a core without it there is nothing to test.
#[test]
fn a_line_typed_as_a_burst_ends_reaches_the_program() {
    if cfg!(windows) && !Path::new(EXE).with_file_name("conpty.dll").exists() {
        eprintln!("skipped: no conpty.dll beside the core (core/scripts/conpty.ps1)");
        return;
    }
    let typists: Vec<_> = (0..8)
        .map(|t| {
            let run = move || {
                let data = Folder::new(&format!("tt-type{t}"));
                let core = Core::start(&data);
                let mut c = core.device();
                let id = TerminalId::mint();
                let start = Some(fixture(&["serve"]));
                let mut v = open(&mut c, &args(id, start, None, 16 << 10), true);
                let (burst, bursts) = (150, 300);
                for b in 0..bursts {
                    c.write(v.s, format!("{burst}\r").as_bytes()).unwrap();
                    let last = (b + 1) * burst - 1;
                    until(&mut c, &mut v, &format!("burst {b}"), |v| {
                        shows(v.bytes(), last)
                    });
                }
            };
            let name = format!("a_line_typed_as_a_burst_ends_reaches_the_program-{t}");
            std::thread::Builder::new().name(name).spawn(run).unwrap()
        })
        .collect();
    let held = typists.into_iter().filter_map(|t| t.join().err()).count();
    assert_eq!(held, 0, "terminals whose program never got a line typed");
}

/// What a client typed before it left reaches the process, even when the
/// core learns that the client is gone from a write of the output still
/// flowing to it, before it has read what the client sent last. Each
/// client here types a line and leaves at once, while the core replays
/// the terminal's output to it.
#[test]
fn what_a_client_typed_before_it_left_reaches_the_process() {
    let data = Folder::new("tt-left");
    let core = Core::start(&data);
    let id = TerminalId::mint();
    let mut start = Some(fixture(&["print 30000", "serve"]));
    let mut hash = FNV;
    for i in 0..8 {
        let mut c = core.device();
        let mut v = open(&mut c, &args(id, start.take(), None, 1 << 20), true);
        until(&mut c, &mut v, "output under way", |v| {
            !v.bytes().is_empty()
        });
        let typed = format!("left {i}");
        c.write(v.s, format!("{typed}\r").as_bytes()).unwrap();
        drop(c);
        hash = fixture_fold(hash, &typed);
    }
    let mut c = core.device();
    let mut v = open(&mut c, &args(id, None, None, 1 << 20), true);
    c.write(v.s, b"sum\r").unwrap();
    let tail = |v: &View| text(&v.bytes()[v.bytes().len().saturating_sub(1000)..]);
    until(&mut c, &mut v, "the sum", |v| tail(v).contains("sum "));
    let sum = format!("sum 8 {hash:016x}");
    assert!(tail(&v).contains(&sum), "{sum}: {}", tail(&v));
}

/// Input a process does not read stays bounded: a client that sends what it
/// was granted and closes its stream leaves that input waiting, and a
/// client attaching after it is granted only what the terminal's budget
/// leaves, not 64 KiB more each time.
///
/// The bound is on what the core holds, so the test keeps the system's own
/// terminal out of the count. The process says it stalls only once its
/// terminal is raw (`stty`: Mac and Linux): one still in its line mode
/// takes whatever is written and drops what it has no room for, so the
/// core would hold nothing and rightly grant again. And the input comes in
/// one frame larger than a raw terminal holds unread (about 1 KiB on a
/// Mac, between 12 and 20 KiB on Linux, by how it is written), so the
/// input thread never writes it whole and none of it counts as written.
/// Control-C typed into a terminal ends the program in front, and the shell
/// reads on. On Windows that is the console's doing: it tells every program
/// attached to it, and a program told to ignore Control-C never hears of it.
/// A process started in a group of its own is told to ignore it, and what it
/// starts after that inherits the same; the core is started that way
/// (`sys::detach`), so its shells must not inherit it.
#[test]
fn control_c_ends_what_runs_in_a_shell_and_the_shell_reads_on() {
    let data = Folder::new("tt-control-c");
    let core = Core::start(&data);
    // What the program itself prints says that it runs in front: a shell
    // that has not handed it the terminal yet takes the Control-C itself.
    #[cfg(windows)]
    let (shell, runs, running, next) = (
        std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_owned()),
        "ping -t localhost",
        ["::1", "127.0.0.1"],
        "set /a 7*191",
    );
    #[cfg(unix)]
    let (shell, runs, running, next) = (
        "/bin/sh".to_owned(),
        "sh -c 'echo $((3*271)); exec sleep 600'",
        ["813", "813"],
        "echo $((7*191))",
    );
    let start = StartTerminal {
        project: None,
        argv: vec![shell],
        title: None,
    };
    let mut screen = Screen::start(&core, TerminalId::mint(), Some(start));
    screen.line(runs);
    while !running.iter().any(|said| screen.text().contains(said)) {
        assert!(screen.pump(), "the core went away first");
    }
    screen.write(b"\x03");
    std::thread::sleep(Duration::from_millis(500));
    screen.line(next);
    screen.until("1337");
}

fn runs_of(c: &mut Client, id: TerminalId) -> Result<Runs, tasktap_proto::Error> {
    c.call::<call::TerminalRuns>(&Ref { id }).unwrap()
}

/// What the core says runs in a terminal, asked until it says `want` or
/// [`PATIENCE`] has passed: a shell starts its program a moment after the
/// line is typed.
fn runs_until(c: &mut Client, id: TerminalId, want: impl Fn(&Runs) -> bool) -> Runs {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let runs = runs_of(c, id).unwrap();
        if want(&runs) || Instant::now() >= deadline {
            return runs;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// What runs in a person's shell, as the core says when it is closed
/// (`terminal.runs`): nothing while it waits for a command; a program in
/// front, and jobs left in the background, running or stopped, each by its
/// command line, what has the foreground first; once it exited, it ended.
#[cfg(unix)]
#[test]
fn a_shell_says_what_runs_in_it_and_nothing_when_it_waits_for_a_command() {
    let data = Folder::new("tt-runs");
    let core = Core::start(&data);
    let mut c = core.device();
    let id = TerminalId::mint();
    let start = StartTerminal {
        project: None,
        argv: Vec::new(),
        title: None,
    };
    let mut screen = Screen::start(&core, id, Some(start));
    screen.line("echo $((3*271))");
    screen.until("813");
    let idle = |r: &Runs| r.state == RunState::Idle;
    let runs = runs_until(&mut c, id, idle);
    assert_eq!(
        (runs.state, runs.what, runs.session),
        (RunState::Idle, vec![], None)
    );

    screen.line("sleep 30");
    // Named once its process runs the program, a moment after the fork.
    let runs = runs_until(&mut c, id, |r| r.what == ["sleep 30"]);
    assert_eq!(
        (runs.state, runs.what),
        (RunState::Running, vec!["sleep 30".into()])
    );
    screen.write(b"\x03");
    assert!(idle(&runs_until(&mut c, id, idle)));

    // Left in the background, and one stopped there: both run.
    screen.line("sleep 31 &");
    screen.line("echo $((7*191))");
    screen.until("1337");
    let runs = runs_until(&mut c, id, |r| r.what == ["sleep 31"]);
    assert_eq!(runs.state, RunState::Running);
    screen.line("sleep 32");
    let two = |r: &Runs| r.what == ["sleep 32", "sleep 31"];
    assert!(two(&runs_until(&mut c, id, two)));
    screen.write(b"\x1a");
    screen.until("Stopped");
    let runs = runs_until(&mut c, id, |r| r.what.len() == 2);
    assert_eq!(runs.state, RunState::Running);
    assert_eq!(
        BTreeSet::from_iter(runs.what),
        BTreeSet::from(["sleep 31".into(), "sleep 32".into()])
    );
    screen.line("kill -9 %1 %2");
    assert!(idle(&runs_until(&mut c, id, idle)));

    // The shell learns what became of its jobs, which dash does only at its
    // next command: until then it refuses `exit` for a job it thinks stopped.
    screen.line("wait");
    screen.line("exit");
    screen.ended();
    assert_eq!(runs_of(&mut c, id).unwrap().state, RunState::Ended);
    let gone = runs_of(&mut c, TerminalId::mint());
    assert_eq!(gone.unwrap_err().code, Code::Gone);
}

/// On Windows the console's job says what runs: nothing but the shell and
/// the consoles' hosts while it waits; a program in front, and one started
/// to run on beside the prompt, by its program's name; once it exited, it
/// ended.
#[cfg(windows)]
#[test]
fn a_console_says_through_its_job_what_runs_in_it() {
    let data = Folder::new("tt-runs-job");
    let core = Core::start(&data);
    let mut c = core.device();
    let id = TerminalId::mint();
    let start = StartTerminal {
        project: None,
        argv: Vec::new(),
        title: None,
    };
    let mut screen = Screen::start(&core, id, Some(start));
    screen.line("set /a 3*271");
    screen.until("813");
    let idle = |r: &Runs| r.state == RunState::Idle;
    let runs = runs_until(&mut c, id, idle);
    assert_eq!((runs.state, runs.what), (RunState::Idle, vec![]));
    let ping = |r: &Runs| r.what.iter().any(|w| w.eq_ignore_ascii_case("ping"));
    screen.line("ping -n 60 127.0.0.1");
    let runs = runs_until(&mut c, id, ping);
    assert_eq!(runs.state, RunState::Running, "{:?}", runs.what);
    assert!(ping(&runs), "{:?}", runs.what);
    screen.write(b"\x03");
    assert!(idle(&runs_until(&mut c, id, idle)));
    // Started to run on beside the prompt: it runs.
    screen.line("start /b ping -n 60 127.0.0.1 > nul");
    let runs = runs_until(&mut c, id, ping);
    assert_eq!(runs.state, RunState::Running, "{:?}", runs.what);
    let stopped = c.call::<call::TerminalStop>(&Ref { id }).unwrap();
    assert!(stopped.is_ok());
    screen.ended();
    assert_eq!(runs_of(&mut c, id).unwrap().state, RunState::Ended);
}

/// Where the system does not list processes, the core does not guess: it
/// cannot tell, and closing the terminal asks.
#[cfg(unix)]
#[test]
fn a_shell_whose_processes_the_system_does_not_list_cannot_tell() {
    let data = Folder::new("tt-runs-blind");
    let core = Core::start_env(&data, &[], &[("TASKTAP_FIXTURE_BLIND", "processes")]);
    let mut c = core.device();
    let id = TerminalId::mint();
    let start = StartTerminal {
        project: None,
        argv: Vec::new(),
        title: None,
    };
    let mut screen = Screen::start(&core, id, Some(start));
    screen.line("echo $((3*271))");
    screen.until("813");
    let runs = runs_of(&mut c, id).unwrap();
    assert_eq!((runs.state, runs.what), (RunState::Unknown, vec![]));
}

/// A program a terminal runs with no shell around it runs until it exits.
#[test]
fn a_program_runs_until_it_exits() {
    let data = Folder::new("tt-runs-program");
    let core = Core::start(&data);
    let mut c = core.device();
    let id = TerminalId::mint();
    let mut screen = Screen::start(&core, id, Some(fixture(&["serve"])));
    let running = runs_of(&mut c, id).unwrap();
    assert_eq!(
        (running.state, running.what),
        (RunState::Running, vec!["tasktap".into()])
    );
    screen.line("exit 0");
    screen.ended();
    assert_eq!(runs_of(&mut c, id).unwrap().state, RunState::Ended);
}

#[cfg(unix)]
#[test]
fn input_a_process_does_not_read_stays_bounded_however_often_clients_reattach() {
    const INPUT: usize = 64 << 10;
    let data = Folder::new("tt-bound");
    let core = Core::start(&data);
    let mut c = core.device();
    let id = TerminalId::mint();
    let start = StartTerminal {
        project: None,
        argv: vec![EXE.into(), "fixture-agent".into(), "stall:30000".into()],
        title: None,
    };
    let mut v = open(&mut c, &args(id, Some(start), None, 1 << 20), true);
    until(&mut c, &mut v, "the process stalls", |v| {
        text(v.bytes()).contains("stalling")
    });
    let first = c.credit(v.s) as usize;
    assert_eq!(first, INPUT, "what one attached client may have on its way");
    let mut sent = 0;
    for round in 0..5 {
        let credit = c.credit(v.s) as usize;
        sent += c.send_some(v.s, &vec![b'x'; credit]).unwrap();
        c.close(v.s).unwrap();
        // The last one comes once the input thread has had time to write
        // what the terminal takes: the rest is still the core's to hold.
        if round == 4 {
            std::thread::sleep(Duration::from_millis(200));
        }
        v = open(&mut c, &args(id, None, None, 1 << 20), true);
    }
    sent += c.credit(v.s) as usize;
    assert!(
        sent <= INPUT,
        "{sent} bytes accepted for a process that reads none"
    );
    // Nothing of it was written as if to a terminal in its line mode,
    // which would have echoed it.
    until(&mut c, &mut v, "the replay", |v| !v.lives().is_empty());
    let shown = text(v.bytes());
    assert!(
        !shown.contains("xxxx"),
        "the terminal was not raw: {shown:?}"
    );
}

/// The bound with several clients attached at once (design §9, "Input"):
/// each may have 64 KiB on its way, so the terminal takes no more than
/// `MAX_TERMINAL_CLIENTS` of them, and a process that reads nothing has
/// less than that many times 64 KiB, and once more, held for it, however
/// the clients come and go. The process stalls with its terminal raw, as
/// in the test before this one, so that what the core holds is counted.
#[cfg(unix)]
#[test]
fn input_a_stalled_process_does_not_read_is_bounded_with_every_client_a_terminal_takes_attached() {
    use tasktap_proto::MAX_TERMINAL_CLIENTS;
    const INPUT: usize = 64 << 10;
    let data = Folder::new("tt-many");
    let core = Core::start(&data);
    let id = TerminalId::mint();
    let start = StartTerminal {
        project: None,
        argv: vec![EXE.into(), "fixture-agent".into(), "stall:30000".into()],
        title: None,
    };
    let mut first = core.device();
    let mut v = open(&mut first, &args(id, Some(start), None, 1 << 20), true);
    until(&mut first, &mut v, "the process stalls", |v| {
        text(v.bytes()).contains("stalling")
    });
    // Every client the terminal takes, each on a connection of its own,
    // attached before any of them sends: each is granted its 64 KiB.
    let mut clients = vec![(first, v)];
    for _ in 1..MAX_TERMINAL_CLIENTS {
        let mut c = core.device();
        let v = open(&mut c, &args(id, None, None, 1 << 20), true);
        clients.push((c, v));
    }
    for (c, v) in &clients {
        assert_eq!(c.credit(v.s) as usize, INPUT);
    }
    // One more is refused, and takes nothing from the others.
    let mut late = core.device();
    let attach = args(id, None, None, 1 << 20);
    let refused = late
        .opened::<call::TerminalOpen>(&attach, attach.credit, true)
        .unwrap()
        .unwrap_err();
    assert_eq!(
        (refused.code, refused.message.as_str()),
        (
            tasktap_proto::Code::Conflict,
            "this terminal is open in 8 places already"
        )
    );
    // All of them send all they may. The process reads none of it.
    let mut sent = 0;
    for (c, v) in &mut clients {
        let credit = c.credit(v.s) as usize;
        sent += c.send_some(v.s, &vec![b'x'; credit]).unwrap();
    }
    assert_eq!(sent, MAX_TERMINAL_CLIENTS * INPUT);
    // Clients go and others come, as often as they like: a place is free
    // again, and what the terminal holds leaves nothing to grant.
    let mut came = Vec::new();
    for _ in 0..3 {
        let (mut c, v) = clients.remove(0);
        c.close(v.s).unwrap();
        let mut next = core.device();
        // The place is free once the core has seen the stream close.
        let since = Instant::now();
        let opened = loop {
            let opened = next.opened::<call::TerminalOpen>(&attach, attach.credit, true);
            match opened.unwrap() {
                Ok(opened) => break opened,
                Err(e) => assert_eq!(e.code, tasktap_proto::Code::Conflict, "{e}"),
            }
            assert!(
                since.elapsed() < Duration::from_secs(10),
                "no place was freed"
            );
            std::thread::sleep(Duration::from_millis(20));
        };
        // Whatever it is granted counts as accepted: it could send it.
        sent += next.credit(opened.s) as usize;
        came.push(next);
    }
    let bound = (MAX_TERMINAL_CLIENTS + 1) * INPUT;
    assert!(
        sent < bound,
        "{sent} bytes accepted for a process that reads none; the bound is {bound}"
    );
}

#[test]
fn a_resize_reaches_the_process_and_is_a_mark_where_it_happened() {
    let data = Folder::new("tt-size");
    let core = Core::start(&data);
    let mut w = core.watch();
    let mut c = core.device();
    let id = TerminalId::mint();
    let mut v = open(
        &mut c,
        &args(id, Some(fixture(&["serve"])), None, 1 << 20),
        true,
    );
    c.write(v.s, b"size\r").unwrap();
    until(&mut c, &mut v, "the size", |v| {
        text(v.bytes()).contains("size 100x30")
    });
    // Everything before the resize has arrived once the echo has.
    std::thread::sleep(Duration::from_millis(200));
    w.ok::<call::TerminalResize>(&ResizeTerminal {
        id,
        cols: 120,
        rows: 40,
    });
    until(&mut c, &mut v, "the mark", |v| v.sizes().len() == 2);
    let at = v.sizes()[1].0;
    w.until("the row", |m| m.terminals[&id].cols == 120);
    let t = &w.model.terminals[&id];
    assert_eq!(
        (t.cols, t.rows, t.offset.get()),
        (120, 40, at),
        "the row has the size and where"
    );
    // Windows' console takes a new size apart from the input: ask until it has.
    let asked = Instant::now();
    while !text(v.bytes()).contains("size 120x40") {
        assert!(
            asked.elapsed() < PATIENCE,
            "the process never saw the new size"
        );
        let answers = text(v.bytes()).matches("size ").count();
        c.write(v.s, b"size\r").unwrap();
        until(&mut c, &mut v, "the new size", |v| {
            text(v.bytes()).matches("size ").count() > answers
        });
    }
    // The same size again changes nothing.
    w.ok::<call::TerminalResize>(&ResizeTerminal {
        id,
        cols: 120,
        rows: 40,
    });
    // A client that comes later gets both sizes where they were.
    let mut later = core.device();
    let mut replay = open(&mut later, &args(id, None, None, 1 << 20), true);
    let end = v.pos();
    until(&mut later, &mut replay, "the replay", |r| r.pos() >= end);
    assert_eq!(replay.sizes(), [(0, Size(100, 30)), (at, Size(120, 40))]);
    let bad = ResizeTerminal {
        id,
        cols: 0,
        rows: 40,
    };
    assert_eq!(w.refused::<call::TerminalResize>(&bad).code, Code::Invalid);
}

#[test]
fn stop_ends_a_process_that_ignores_hang_up_and_its_descendants() {
    let data = Folder::new("tt-stop");
    let core = Core::start(&data);
    let mut w = core.watch();
    let mut c = core.device();
    let lock = data.0.join("child.lock");
    let id = TerminalId::mint();
    let child = format!("spawn ignore-hup;lock {};sleep 30000", lock.display());
    let start = fixture(&["ignore-hup", &child, "print 1", "sleep 30000"]);
    let mut v = open(&mut c, &args(id, Some(start), None, 1 << 20), true);
    until(&mut c, &mut v, "the first line", |v| shows(v.bytes(), 0));
    taken(&lock);
    let stopped = Instant::now();
    w.ok::<call::TerminalStop>(&Ref { id });
    closed(&mut c, &mut v);
    let took = stopped.elapsed();
    assert!(v.exit().is_some());
    if cfg!(unix) {
        assert!(
            took >= Duration::from_millis(1900),
            "hang-up was ignored: {took:?}"
        );
    }
    assert!(
        took < Duration::from_millis(4500),
        "ended by the deadline: {took:?}"
    );
    let why = "the descendant outlived the stop";
    released(&lock, stopped, Duration::from_secs(5), why);
    state(&mut w, id, TerminalState::Exited);
    // Stopping what has stopped does nothing; what never was is gone.
    w.ok::<call::TerminalStop>(&Ref { id });
    let never = Ref {
        id: TerminalId::mint(),
    };
    assert_eq!(w.refused::<call::TerminalStop>(&never).code, Code::Gone);
}

/// Waits until a process holds the lock on `file`.
fn taken(file: &Path) {
    let waited = Instant::now();
    while !locked(file) {
        assert!(waited.elapsed() < PATIENCE, "nothing ever took {file:?}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// What a program starts as its very first act ends with its terminal too.
/// On Windows the child is made in its job (design §9, "Stopping"): a job
/// it is put in once it runs misses whatever it had started by then.
#[test]
fn what_a_program_starts_first_thing_ends_with_its_terminal() {
    let terminals: Vec<_> = (0..4)
        .map(|t| {
            let run = move || {
                let data = Folder::new(&format!("tt-first{t}"));
                let core = Core::start(&data);
                let mut w = core.watch();
                let mut c = core.device();
                let lock = data.0.join("child.lock");
                let id = TerminalId::mint();
                let child = format!("spawn lock {};sleep 30000", lock.display());
                let start = fixture(&[&child, "print 1", "sleep 30000"]);
                let mut v = open(&mut c, &args(id, Some(start), None, 1 << 20), true);
                until(&mut c, &mut v, "the first line", |v| shows(v.bytes(), 0));
                taken(&lock);
                let stopped = Instant::now();
                w.ok::<call::TerminalStop>(&Ref { id });
                closed(&mut c, &mut v);
                let why = "what the program started first outlived the stop";
                released(&lock, stopped, Duration::from_secs(5), why);
            };
            let name = format!("what_a_program_starts_first_thing-{t}");
            std::thread::Builder::new().name(name).spawn(run).unwrap()
        })
        .collect();
    let escaped = terminals.into_iter().filter_map(|t| t.join().err()).count();
    assert_eq!(escaped, 0, "terminals whose stop left a process running");
}

/// Tools as npm installs them on Windows (design §7): `tool.cmd`, a batch
/// file the command prompt runs, which runs Node on the tool's script. The
/// stand-in's script writes down the arguments it got, or serves a named
/// pipe for as long as it runs. Needs `node` on the PATH.
#[cfg(windows)]
mod batch_files {
    use super::*;
    use std::path::PathBuf;

    const SCRIPT: &str = r#"
const fs = require('fs'), net = require('net');
const [verb, where, ...rest] = process.argv.slice(2);
if (verb === 'args') { fs.writeFileSync(where, JSON.stringify(rest)); console.log('written'); }
if (verb === 'serve') net.createServer(() => {}).listen(where, () => console.log('serving'));
"#;

    fn tool(folder: &Path) -> PathBuf {
        let module = folder.join("node_modules").join("tool");
        std::fs::create_dir_all(&module).unwrap();
        std::fs::write(module.join("cli.js"), SCRIPT).unwrap();
        let run = r#""%_prog%"  "%dp0%\node_modules\tool\cli.js""#;
        let file = folder.join("tool.cmd");
        std::fs::write(&file, NPM_SHIM.replace("RUN", run)).unwrap();
        file
    }

    fn start(argv: &[&str]) -> StartTerminal {
        StartTerminal {
            project: None,
            argv: argv.iter().map(|a| a.to_string()).collect(),
            title: None,
        }
    }

    /// The tool is found by its bare name, as a shell finds it, and every
    /// argument reaches its script as it was given: blanks, quotes, the
    /// JSON of hook settings, and each sign the command prompt gives a
    /// meaning. None of them runs as a command.
    #[test]
    fn a_tool_installed_as_a_batch_file_is_found_and_gets_its_arguments_as_they_are() {
        let data = Folder::new("tt-batch");
        let tools = data.0.join("tools");
        tool(&tools);
        let core = Core::start_env(&data.0, &[], &[("PATH", &path_with(&tools))]);
        let mut c = core.device();
        let (out, marker) = (data.0.join("got.json"), data.0.join("injected"));
        let hooks = r#"{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"\"C:\\Program Files\\Tasktap\\tasktap.exe\" hook claude"}]}]}}"#;
        let inject = format!(r#"" & echo x > "{}" & ""#, marker.display());
        let given = [
            "plain",
            "two words",
            r#"say "hi""#,
            hooks,
            "100% %PATH% %USERNAME% %%",
            "a&b|c<d>e^f",
            "!bang! !PATH!",
            r"ends in a slash\",
            "",
            "(round) ; , = [square]",
            "ünïcödé ✓ 日本語",
            &inject,
            "caret^ & echo INJECTED",
            r#"\"quoted\" \\"#,
        ];
        let out_arg = out.display().to_string();
        let mut argv = vec!["tool", "args", &out_arg];
        argv.extend(given);
        let open_args = args(TerminalId::mint(), Some(start(&argv)), None, 1 << 20);
        let mut v = open(&mut c, &open_args, true);
        closed(&mut c, &mut v);
        let said = text(v.bytes());
        let got = std::fs::read(&out).unwrap_or_else(|e| panic!("nothing written ({e}): {said}"));
        let got: Vec<String> = serde_json::from_slice(&got).unwrap();
        assert_eq!(got, given);
        assert!(!marker.exists(), "an argument ran as a command");
        assert!(
            !said.contains("INJECTED"),
            "an argument ran as a command: {said}"
        );
        assert_eq!(v.exit(), Some(Some(0)), "{said}");
    }

    /// The command prompt ends an argument at a line break, so a batch
    /// file is never started with one: the terminal says why instead.
    #[test]
    fn a_batch_file_is_not_started_with_an_argument_it_cannot_be_given() {
        let data = Folder::new("tt-batch-refused");
        let tool = tool(&data.0.join("tools")).display().to_string();
        let core = Core::start(&data);
        let mut c = core.device();
        let out = data.0.join("got.json").display().to_string();
        let argv = [tool.as_str(), "args", &out, "two\nlines"];
        let open_args = args(TerminalId::mint(), Some(start(&argv)), None, 1 << 20);
        let mut v = open(&mut c, &open_args, true);
        closed(&mut c, &mut v);
        let said = text(v.bytes());
        assert!(
            said.contains("cannot start this terminal") && said.contains("line break"),
            "{said}"
        );
        assert!(!Path::new(&out).exists());
    }

    fn serving(pipe: &str) -> bool {
        let opened = std::fs::OpenOptions::new().read(true).open(pipe);
        opened.map_or_else(|e| e.kind() != std::io::ErrorKind::NotFound, |_| true)
    }

    /// Stopping the terminal ends the whole tree: the command prompt that
    /// runs the batch file and the Node process behind it.
    #[test]
    fn stop_ends_the_program_a_batch_file_runs() {
        let data = Folder::new("tt-batch-stop");
        let tool = tool(&data.0.join("tools")).display().to_string();
        let core = Core::start(&data);
        let mut w = core.watch();
        let mut c = core.device();
        let pipe = format!(r"\\.\pipe\tasktap-test-tool-{}", std::process::id());
        let id = TerminalId::mint();
        let argv = [tool.as_str(), "serve", &pipe];
        let mut v = open(&mut c, &args(id, Some(start(&argv)), None, 1 << 20), true);
        until(&mut c, &mut v, "the tool serving", |v| {
            text(v.bytes()).contains("serving")
        });
        assert!(serving(&pipe));
        let stopped = Instant::now();
        w.ok::<call::TerminalStop>(&Ref { id });
        closed(&mut c, &mut v);
        while serving(&pipe) {
            let why = "the program behind the batch file outlived the stop";
            assert!(stopped.elapsed() < Duration::from_secs(5), "{why}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// Waits until nothing holds the lock on `file`, `limit` after `since` at most.
fn released(file: &Path, since: Instant, limit: Duration, why: &str) {
    while locked(file) {
        assert!(since.elapsed() < limit, "{why}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn locked(file: &Path) -> bool {
    std::fs::File::open(file).is_ok_and(|f| f.try_lock().is_err())
}

/// A stop ends every process the terminal started, also one a program put
/// in a process group of its own that ignores hang-up and lets go of the
/// terminal (design §9): what is in the child's session.
#[cfg(unix)]
#[test]
fn stop_ends_descendants_in_process_groups_of_their_own() {
    let data = Folder::new("tt-groups");
    let core = Core::start(&data);
    let mut w = core.watch();
    let mut c = core.device();
    let lock = data.0.join("child.lock");
    let id = TerminalId::mint();
    let child = format!("spawn-group ignore-hup;lock {};sleep 30000", lock.display());
    let start = fixture(&[&child, "print 1", "sleep 30000"]);
    let mut v = open(&mut c, &args(id, Some(start), None, 1 << 20), true);
    until(&mut c, &mut v, "the first line", |v| shows(v.bytes(), 0));
    taken(&lock);
    let stopped = Instant::now();
    w.ok::<call::TerminalStop>(&Ref { id });
    closed(&mut c, &mut v);
    let why = "the descendant in a group of its own outlived the stop";
    released(&lock, stopped, Duration::from_secs(5), why);
}

/// Shutting down waits for the kill of every terminal it stopped, also of
/// one that ended before its kill was due: its child ended on hang-up and
/// what ignored hang-up let go of the terminal (design §9).
#[test]
fn shutdown_carries_out_the_kills_it_armed() {
    let data = Folder::new("tt-shut");
    let core = Core::start(&data);
    let mut c = core.device();
    let lock = data.0.join("child.lock");
    let id = TerminalId::mint();
    let child = format!("spawn ignore-hup;lock {};sleep 30000", lock.display());
    let start = fixture(&[&child, "print 1", "sleep 30000"]);
    let mut v = open(&mut c, &args(id, Some(start), None, 1 << 20), true);
    until(&mut c, &mut v, "the first line", |v| shows(v.bytes(), 0));
    taken(&lock);
    core.stop();
    let why = "the descendant outlived the core";
    released(&lock, Instant::now(), Duration::from_secs(1), why);
}

/// What a terminal's child started and left running when it exited ends
/// with the terminal, as a stop ends it, also when it ignores hang-up and
/// holds the terminal (which then ends a second after the child, design
/// §9): it would otherwise run on with nothing to show or stop it.
#[cfg(unix)]
#[test]
fn what_a_terminal_left_running_ends_with_it() {
    let data = Folder::new("tt-held");
    let core = Core::start(&data);
    let mut c = core.device();
    let lock = data.0.join("child.lock");
    let id = TerminalId::mint();
    let child = format!("spawn-held ignore-hup;lock {};sleep 30000", lock.display());
    let start = fixture(&[&child, "print 1", "sleep 3000", "exit 0"]);
    let mut v = open(&mut c, &args(id, Some(start), None, 1 << 20), true);
    until(&mut c, &mut v, "the first line", |v| shows(v.bytes(), 0));
    taken(&lock);
    closed(&mut c, &mut v);
    assert_eq!(v.exit(), Some(Some(0)));
    let why = "what held the terminal outlived it";
    released(&lock, Instant::now(), Duration::from_secs(4), why);
}

#[test]
fn closing_a_stream_leaves_the_process_running() {
    let data = Folder::new("tt-tab");
    let core = Core::start(&data);
    let mut w = core.watch();
    let mut c = core.device();
    let id = TerminalId::mint();
    let mut v = open(
        &mut c,
        &args(id, Some(fixture(&["serve"])), None, 1 << 20),
        true,
    );
    c.write(v.s, b"one\r").unwrap();
    until(&mut c, &mut v, "the echo", |v| {
        text(v.bytes()).contains("<one>")
    });
    let from = v.pos();
    c.close(v.s).unwrap();
    drop(c);
    w.sync();
    assert_eq!(w.model.terminals[&id].state, TerminalState::Running);
    let mut c = core.device();
    let mut v = open(&mut c, &args(id, None, Some(from), 1 << 20), true);
    assert_eq!(v.start(), from, "on from where it was");
    c.write(v.s, b"two\r").unwrap();
    until(&mut c, &mut v, "the echo", |v| {
        text(v.bytes()).contains("<two>")
    });
    assert!(!text(v.bytes()).contains("<one>"), "only what came after");
}

#[test]
fn the_exit_code_is_recorded_and_marked() {
    let data = Folder::new("tt-exit");
    let core = Core::start(&data);
    let mut w = core.watch();
    let mut c = core.device();
    let id = TerminalId::mint();
    let mut v = open(
        &mut c,
        &args(id, Some(fixture(&["print 2", "exit 7"])), None, 1 << 20),
        true,
    );
    closed(&mut c, &mut v);
    assert_eq!(v.closed, Some(Some(CloseWhy::Done)));
    assert_eq!(
        v.marks.last().map(|&(at, m)| (at, m.exit)),
        Some((v.pos(), Some(Some(7))))
    );
    assert_printed(v.bytes(), 0, 2);
    state(&mut w, id, TerminalState::Exited);
    let t = &w.model.terminals[&id];
    assert_eq!((t.exit, t.offset.get()), (Some(7), v.pos()));
    // Input is not taken from a terminal that has ended.
    let mut again = core.device();
    let opened = again.opened::<call::TerminalOpen>(&args(id, None, None, 1024), 1024, true);
    assert_eq!(opened.unwrap().unwrap().credit, 0);
}

/// A terminal's history is written off the core's thread (design §10): a
/// data folder that stalls, here a pipe nobody reads where the history is
/// written, holds up nothing else. Until the history is on disk the row
/// says the terminal runs, and a client attaching meanwhile replays it from
/// memory; once it is written the row says it exited.
#[cfg(unix)]
#[test]
fn a_stalled_history_write_holds_up_nothing_else() {
    let data = Folder::new("tt-stall");
    let core = Core::start(&data);
    let mut w = core.watch();
    let mut c = core.device();
    let id = TerminalId::mint();
    let folder = data.0.join("scrollback");
    std::fs::create_dir_all(&folder).unwrap();
    let pipe = folder.join(format!("{}.new", id.uuid()));
    let made = std::process::Command::new("mkfifo").arg(&pipe).status();
    assert!(made.unwrap().success(), "mkfifo");
    let start = fixture(&["print 3"]);
    let mut v = open(&mut c, &args(id, Some(start), None, 1 << 20), true);
    closed(&mut c, &mut v);
    assert_eq!(v.exit(), Some(Some(0)));
    let asked = Instant::now();
    w.ok::<call::CoreStatus>(&Empty {});
    assert!(asked.elapsed() < Duration::from_secs(2), "the core waited");
    let mut again = open(&mut c, &args(id, None, Some(0), 1 << 20), true);
    closed(&mut c, &mut again);
    assert_printed(again.bytes(), 0, 3);
    w.sync();
    assert_eq!(w.model.terminals[&id].state, TerminalState::Running);
    // Someone reads the pipe: the history is written, and the terminal exited.
    let reader = std::thread::spawn(move || std::fs::read(pipe).unwrap());
    state(&mut w, id, TerminalState::Exited);
    let written = reader.join().unwrap();
    assert!(String::from_utf8_lossy(&written).contains(&line(2)));
}

#[test]
fn history_survives_a_clean_restart() {
    let data = Folder::new("tt-keep");
    let (ended, running) = (TerminalId::mint(), TerminalId::mint());
    let mut seen = Vec::new();
    {
        let core = Core::start(&data);
        let mut w = core.watch();
        let mut c = core.device();
        let mut v = open(
            &mut c,
            &args(
                ended,
                Some(fixture(&["print 1000", "exit 0"])),
                None,
                1 << 20,
            ),
            true,
        );
        closed(&mut c, &mut v);
        seen.push(v.bytes().to_vec());
        let start = fixture(&["print 500", "sleep 30000"]);
        let mut v = open(&mut c, &args(running, Some(start), None, 1 << 20), true);
        until(&mut c, &mut v, "the lines", |v| printed(v.bytes(), 0, 500));
        seen.push(head(v.bytes(), 500).to_vec());
        state(&mut w, ended, TerminalState::Exited);
        drop((w, c));
        // Retiring stops what runs, and keeps what it wrote.
        core.stop();
    }
    let core = Core::start(&data);
    let mut w = core.watch();
    assert_eq!(w.model.terminals[&ended].exit, Some(0));
    assert_eq!(w.model.terminals[&running].state, TerminalState::Exited);
    let mut c = core.device();
    for (id, lines) in [(ended, 1000), (running, 500)] {
        let mut v = open(&mut c, &args(id, None, None, 1 << 20), true);
        closed(&mut c, &mut v);
        assert_printed(head(v.bytes(), lines), 0, lines);
        assert_eq!(v.lives(), [v.pos()]);
        assert!(v.exit().is_some());
    }
    assert!(
        seen[0] == open_all(&mut c, ended),
        "the same bytes as before"
    );
    // From the end only the marks come.
    let end = w.model.terminals[&ended].offset.get();
    let mut v = open(&mut c, &args(ended, None, Some(end), 1 << 20), true);
    closed(&mut c, &mut v);
    assert_eq!((v.start(), v.pos(), v.exit()), (end, end, Some(Some(0))));
    w.sync();
}

fn open_all(c: &mut Client, id: TerminalId) -> Vec<u8> {
    let mut v = open(c, &args(id, None, None, 1 << 20), true);
    closed(c, &mut v);
    v.bytes().to_vec()
}

#[test]
fn a_terminal_may_belong_to_no_project_and_a_closed_project_starts_none() {
    let data = Folder::new("tt-proj");
    let core = Core::start(&data);
    let mut w = core.watch();
    let mut c = core.device();
    let loose = TerminalId::mint();
    let mut v = open(
        &mut c,
        &args(loose, Some(fixture(&["print 1", "exit 0"])), None, 1 << 20),
        true,
    );
    closed(&mut c, &mut v);
    w.sync();
    let t = &w.model.terminals[&loose];
    assert_eq!((t.project_id, t.kind), (None, TerminalKind::Task));
    // The core's home, which the tests give it (on Windows the profile's).
    let home = data.0.join("home");
    assert_eq!(Path::new(&t.cwd), home);
    // In a project: its folder, until the project is closed.
    let folder = Folder::new("tt-proj-folder");
    let p = ProjectId::mint();
    let add = tasktap_proto::AddProject {
        id: p,
        folder: folder.0.to_string_lossy().into_owned(),
        name: None,
    };
    w.ok::<call::ProjectAdd>(&add);
    let mut inside = fixture(&["print 1", "serve"]);
    inside.project = Some(p);
    let first = TerminalId::mint();
    let mut v = open(
        &mut c,
        &args(first, Some(inside.clone()), None, 1 << 20),
        true,
    );
    until(&mut c, &mut v, "the line", |v| shows(v.bytes(), 0));
    w.sync();
    assert_eq!(w.model.terminals[&first].project_id, Some(p));
    let canonical = kept(&folder.0);
    assert_eq!(Path::new(&w.model.terminals[&first].cwd), canonical);
    w.ok::<call::ProjectClose>(&CloseProject { id: p, stop: true });
    state(&mut w, first, TerminalState::Exited);
    let refused = c.opened::<call::TerminalOpen>(
        &args(TerminalId::mint(), Some(inside.clone()), None, 1),
        1,
        true,
    );
    assert_eq!(refused.unwrap().unwrap_err().code, Code::Conflict);
    w.ok::<call::ProjectAdd>(&add);
    let _v = open(
        &mut c,
        &args(TerminalId::mint(), Some(inside), None, 1 << 20),
        true,
    );
    // A shell: the person's own, as its login shell.
    let shell = TerminalId::mint();
    let mut start = fixture(&[]);
    start.argv.clear();
    let _v = open(&mut c, &args(shell, Some(start), None, 1 << 20), true);
    w.sync();
    assert_eq!(w.model.terminals[&shell].kind, TerminalKind::Shell);
    w.ok::<call::TerminalStop>(&Ref { id: shell });
    state(&mut w, shell, TerminalState::Exited);
}

#[test]
fn the_environment_holds_exactly_the_fixed_list() {
    let data = Folder::new("tt-env");
    // The fixture agent declares FIXTURE_AGENT_KEY, as an adapter declares
    // the key a person signs in with; nothing else of the core's own
    // environment passes.
    let leak = [
        ("TASKTAP_LEAK", "1"),
        ("USER", "someone"),
        ("LANG", "de_DE.UTF-8"),
        ("FIXTURE_AGENT_KEY", "not-a-real-key"),
        ("OTHER_API_KEY", "not-declared"),
    ];
    let core = Core::start_env(&data, &[], &leak);
    let mut c = core.device();
    let mut v = open(
        &mut c,
        &args(
            TerminalId::mint(),
            Some(fixture(&["env", "exit 0"])),
            None,
            1 << 20,
        ),
        true,
    );
    closed(&mut c, &mut v);
    let fold = |key: &str| {
        if cfg!(windows) {
            key.to_uppercase()
        } else {
            key.to_owned()
        }
    };
    let got: BTreeSet<String> = (text(v.bytes()).split('|'))
        .filter_map(|l| l.rsplit_once("env:").map(|(_, key)| key))
        // Windows keeps each drive's folder in variables named `=C:`.
        .filter(|key| !key.starts_with('='))
        .map(fold)
        .collect();
    let mut want: BTreeSet<String> = [
        "TERM",
        "COLORTERM",
        "TERM_PROGRAM",
        "TASKTAP_DATA",
        "TASKTAP_SOCKET",
        "TASKTAP_TOKEN",
        "FIXTURE_AGENT_KEY",
    ]
    .into_iter()
    .map(fold)
    .collect();
    // What the real adapters declare passes too, when whoever runs the
    // tests has it.
    let declared = tasktap_core::agents::variables().into_iter();
    want.extend(
        declared
            .filter(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty()))
            .map(fold),
    );
    if cfg!(windows) {
        let fixed = [
            "SystemRoot",
            "SystemDrive",
            "windir",
            "ComSpec",
            "PATHEXT",
            "PATH",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
            "APPDATA",
            "LOCALAPPDATA",
            "ProgramData",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramW6432",
            "CommonProgramFiles",
            "TEMP",
            "TMP",
            "USERNAME",
            "USERDOMAIN",
            "COMPUTERNAME",
            "OS",
            "PROCESSOR_ARCHITECTURE",
            "NUMBER_OF_PROCESSORS",
        ];
        let present = fixed
            .into_iter()
            .filter(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty()));
        want.extend(present.map(fold));
    } else {
        want.extend(["HOME", "USER", "LOGNAME", "SHELL", "LANG", "PATH"].map(String::from));
    }
    assert_eq!(got, want);
}

#[test]
fn a_terminal_other_than_a_shell_finds_tasktap_in_the_cores_folder() {
    // An agent's hooks run the core's program by its path; `tasktap ask` by
    // its name, found in the core's folder, last on the PATH of every
    // terminal but a shell, where no shim is.
    let data = Folder::new("tt-path");
    let core = Core::start(&data);
    let mut c = core.device();
    let mut v = open(
        &mut c,
        &args(
            TerminalId::mint(),
            Some(fixture(&["find tasktap", "exit 0"])),
            None,
            1 << 20,
        ),
        true,
    );
    closed(&mut c, &mut v);
    let shown = text(v.bytes());
    let said = |what: &str| {
        (shown.split('|'))
            .find_map(|l| l.rsplit_once(what).map(|(_, path)| path.trim().to_owned()))
            .expect("it looked")
    };
    let found = said("found:");
    let folder = Path::new(&found).parent().map(std::fs::canonicalize);
    let own = std::fs::canonicalize(Path::new(EXE).parent().unwrap()).unwrap();
    assert_eq!(folder.and_then(Result::ok), Some(own.clone()), "{shown}");
    // Last, unless the core's own PATH has it already, as cargo's on Windows.
    if cfg!(unix) {
        let last = std::fs::canonicalize(said("last:")).ok();
        assert_eq!(last, Some(own), "{shown}");
    }
    assert!(!data.0.join("shims").exists(), "no shim was needed");
}

#[test]
fn the_core_stays_while_a_terminal_lives_and_retires_after_it() {
    let data = Folder::new("tt-life");
    let mut core = Core::start_with(&data, &["--idle-ms", "200"]);
    {
        let mut c = core.device();
        let _v = open(
            &mut c,
            &args(TerminalId::mint(), Some(fixture(&["sleep 1500"])), None, 1),
            false,
        );
        let status = c.call::<call::CoreStatus>(&Empty {}).unwrap().unwrap();
        assert_eq!(status.terminals, 1);
    }
    // Nobody is connected, but a terminal lives.
    std::thread::sleep(Duration::from_millis(800));
    assert!(core.running(), "a live terminal keeps the core");
    assert!(
        exits_within(&mut core, Duration::from_secs(5)),
        "gone once it ended"
    );

    let data = Folder::new("tt-retire");
    let mut core = Core::start(&data);
    let mut c = core.device();
    let _v = open(
        &mut c,
        &args(TerminalId::mint(), Some(fixture(&["sleep 1500"])), None, 1),
        false,
    );
    let idle = Retire { when: When::Idle };
    c.call::<call::CoreRetire>(&idle).unwrap().unwrap();
    std::thread::sleep(Duration::from_millis(500));
    assert!(core.running(), "retiring when idle waits for the terminal");
    assert!(
        exits_within(&mut core, Duration::from_secs(5)),
        "and then goes, a client or not"
    );
}

#[test]
fn nothing_reruns_after_a_crash() {
    let data = Folder::new("tt-crash");
    let mark = data.0.join("ran");
    let id = TerminalId::mint();
    let start = fixture(&[&format!("mark {}", mark.display()), "serve"]);
    {
        let core = Core::start(&data);
        let mut c = core.device();
        let _v = open(&mut c, &args(id, Some(start.clone()), None, 1), false);
        let waited = Instant::now();
        while !mark.exists() {
            assert!(waited.elapsed() < PATIENCE, "the fixture never ran");
            std::thread::sleep(Duration::from_millis(20));
        }
        // Dropping the core kills it.
    }
    let core = Core::start(&data);
    let mut w = core.watch();
    assert_eq!(w.model.terminals[&id].state, TerminalState::Lost);
    let mut c = core.device();
    for start in [Some(start.clone()), None] {
        let mut v = open(&mut c, &args(id, start, None, 1 << 20), true);
        closed(&mut c, &mut v);
        assert_eq!(
            (v.pos(), v.exit()),
            (v.start(), Some(None)),
            "an empty history that ended"
        );
    }
    let mut other = start.clone();
    other.argv.push("print 1".into());
    let refused = c.opened::<call::TerminalOpen>(&args(id, Some(other), None, 1), 1, true);
    assert_eq!(refused.unwrap().unwrap_err().code, Code::Conflict);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        std::fs::read_to_string(&mark).unwrap(),
        "ran\n",
        "it ran once"
    );
    w.sync();
}

#[test]
fn deleting_a_terminal_that_ended_removes_its_history() {
    let data = Folder::new("tt-del");
    let core = Core::start(&data);
    let mut w = core.watch();
    let mut c = core.device();
    let (ended, running) = (TerminalId::mint(), TerminalId::mint());
    let start = fixture(&["print 10", "exit 0"]);
    let mut v = open(
        &mut c,
        &args(ended, Some(start.clone()), None, 1 << 20),
        true,
    );
    closed(&mut c, &mut v);
    let _r = open(
        &mut c,
        &args(running, Some(fixture(&["serve"])), None, 1),
        false,
    );
    // Its stream closes as it ends; its history is written off the core's
    // thread, and the record says exited once it is on disk.
    state(&mut w, ended, TerminalState::Exited);
    let history = data.0.join("scrollback").join(ended.uuid().to_string());
    assert!(history.exists());
    let busy = w.refused::<call::Delete>(&Delete::Terminals { id: running });
    assert_eq!(busy.code, Code::Conflict);
    w.ok::<call::Delete>(&Delete::Terminals { id: ended });
    assert!(!history.exists());
    assert!(!w.model.terminals.contains_key(&ended));
    for start in [None, Some(start)] {
        let gone = c.opened::<call::TerminalOpen>(&args(ended, start, None, 1), 1, true);
        assert_eq!(
            gone.unwrap().unwrap_err().code,
            Code::Gone,
            "never started again"
        );
    }
}

/// A terminal that ended is deleted only once its history is on disk. Until
/// then its record says running, though its clients saw it end: a delete in
/// between would remove the record and then find the history written after
/// it, left behind for good.
#[test]
fn a_terminal_whose_history_is_still_on_its_way_to_disk_is_not_deleted() {
    let data = Folder::new("tt-late");
    // Whatever runs off the core's thread waits this long first.
    let core = Core::start_with(&data, &["--check-ms", "2000"]);
    let mut w = core.watch();
    let mut c = core.device();
    let id = TerminalId::mint();
    let start = fixture(&["print 3", "exit 0"]);
    let mut v = open(&mut c, &args(id, Some(start), None, 1 << 20), true);
    closed(&mut c, &mut v);
    assert_eq!(v.exit(), Some(Some(0)));
    let history = data.0.join("scrollback").join(id.uuid().to_string());
    let early = w.refused::<call::Delete>(&Delete::Terminals { id });
    assert_eq!(early.code, Code::Conflict);
    assert_eq!(w.model.terminals[&id].state, TerminalState::Running);
    state(&mut w, id, TerminalState::Exited);
    assert!(history.exists(), "exited, so its history is on disk");
    w.ok::<call::Delete>(&Delete::Terminals { id });
    assert!(!history.exists());
    assert!(!w.model.terminals.contains_key(&id));
}

/// Memory per terminal (design §10: at most 2.2 MiB at full scrollback),
/// measured from the core's resident size once what the first terminals set
/// up for good is in place. Windows has no `ps`.
#[test]
#[cfg(unix)]
fn memory_per_terminal_is_within_its_target() {
    let data = Folder::new("tt-mem");
    let core = Core::start(&data);
    let mut c = core.device();
    let rss = || {
        let pid = core.pid().to_string();
        let mut ps = std::process::Command::new("ps");
        let ps = ps.args(["-o", "rss=", "-p", &pid]).output().unwrap();
        String::from_utf8(ps.stdout)
            .unwrap()
            .trim()
            .parse::<u64>()
            .unwrap()
    };
    let n = 10;
    let full = fixture(&["print 30000", "serve"]);
    let fill = |c: &mut Client| {
        for _ in 0..n {
            let args = args(TerminalId::mint(), Some(full.clone()), None, 4 << 20);
            let mut v = open(c, &args, true);
            until(c, &mut v, "the lines", |v| printed(v.bytes(), 0, 30_000));
            c.close(v.s).unwrap();
        }
        std::thread::sleep(Duration::from_millis(400));
    };
    fill(&mut c);
    let before = rss();
    let mut quiet = Vec::new();
    for _ in 0..n {
        let start = fixture(&["serve"]);
        quiet.push(open(
            &mut c,
            &args(TerminalId::mint(), Some(start), None, 1),
            false,
        ));
    }
    std::thread::sleep(Duration::from_millis(400));
    let idle = rss();
    fill(&mut c);
    let filled = rss();
    let quiet_kib = idle.saturating_sub(before) / n;
    let full_kib = filled.saturating_sub(idle) / n;
    eprintln!("memory per terminal: {quiet_kib} KiB quiet, {full_kib} KiB with a full ring");
    assert!(
        full_kib <= 2253,
        "{full_kib} KiB per terminal at full scrollback"
    );
}
