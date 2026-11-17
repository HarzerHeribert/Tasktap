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
    ProjectId, Ref, ResizeTerminal, Retire, Size, StartTerminal, StreamId, TerminalId,
    TerminalKind, TerminalState, When,
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
    // Within the ring: nothing is lost however slowly it is read.
    let n = 12_000;
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
    // stays within the ring: a slow client loses nothing then.
    let (batch, batches) = (4096, 70);
    let mut v = open(
        &mut c,
        &args(id, Some(fixture(&["serve"])), None, 16 << 10),
        true,
    );
    let mut all = Vec::new();
    for b in 0..batches {
        let before = v.pos();
        c.write(v.s, format!("{batch}\r").as_bytes()).unwrap();
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
        }
        until(&mut c, &mut v, &format!("batch {b}"), |v| {
            shows(v.bytes(), last)
        });
    }
    all.extend_from_slice(v.bytes());
    assert!(v.marks.iter().all(|(_, m)| !m.gap), "no gap");
    let total = batch * batches;
    assert!(
        all.len() as u64 > 20 << 20,
        "tens of megabytes: {}",
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
    let held = || {
        let file = std::fs::File::open(&lock);
        file.is_ok_and(|f| f.try_lock().is_err())
    };
    let waited = Instant::now();
    while !held() {
        assert!(
            waited.elapsed() < PATIENCE,
            "the descendant never took its lock"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
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
    while held() {
        assert!(
            stopped.elapsed() < Duration::from_secs(5),
            "the descendant outlived the stop"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    state(&mut w, id, TerminalState::Exited);
    // Stopping what has stopped does nothing; what never was is gone.
    w.ok::<call::TerminalStop>(&Ref { id });
    let never = Ref {
        id: TerminalId::mint(),
    };
    assert_eq!(w.refused::<call::TerminalStop>(&never).code, Code::Gone);
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
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap();
    assert_eq!(Path::new(&t.cwd), Path::new(&home));
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
    let canonical = std::fs::canonicalize(&folder.0).unwrap();
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
    let leak = [
        ("TASKTAP_LEAK", "1"),
        ("USER", "someone"),
        ("LANG", "de_DE.UTF-8"),
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
    ]
    .into_iter()
    .map(fold)
    .collect();
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
    assert!(!said("found:").is_empty(), "{shown}");
    let last = std::fs::canonicalize(said("last:")).ok();
    let own = std::fs::canonicalize(Path::new(EXE).parent().unwrap()).unwrap();
    assert_eq!(last, Some(own), "{shown}");
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
