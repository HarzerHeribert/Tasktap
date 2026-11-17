//! Streams (design §1, §2): each test starts the real binary and speaks the
//! protocol through `client.rs`, with `fixture.stream` in place of a terminal.

use std::collections::HashSet;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use tasktap_core::client::{self, Client};
use tasktap_core::stream::{TURN, WINDOW};
use tasktap_proto::call::{self, Call, Code};
use tasktap_proto::{
    CallId, CloseWhy, Control, DeviceId, Empty, FixtureStream, Frame, Hello, MAX_CREDIT,
    MAX_DATA_FRAME, MAX_STREAMS, Offset, Register, Role, Secret, StreamId, VERSION, Versions,
    encode_data,
};

mod common;

const EXE: &str = env!("CARGO_BIN_EXE_tasktap");
const MIB: u64 = 1 << 20;
/// More than any stream sends here: the fixture keeps going until closed.
const ENDLESS: u64 = 1 << 50;

/// A fresh data folder, removed afterwards.
struct Folder(PathBuf);

impl Folder {
    fn new() -> Folder {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        // Short: a socket path has a length limit.
        let path = std::env::temp_dir().join(format!("ts-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Folder(path)
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A core this test started; killed if the test ends with it still running.
struct Core<'a> {
    child: Child,
    data: &'a Path,
    _watchdog: common::Watchdog,
}

impl<'a> Core<'a> {
    fn start(data: &'a Folder) -> Core<'a> {
        Core::idle(data, 600_000)
    }

    fn idle(data: &'a Folder, ms: u32) -> Core<'a> {
        let mut serve = client::serve_command(Path::new(EXE), &data.0);
        serve.args(["--idle-ms", &ms.to_string()]);
        let child = client::start(serve).unwrap();
        Core {
            _watchdog: common::Watchdog::new(&child),
            child,
            data: &data.0,
        }
    }

    fn hello(&self, auth: bool) -> Client {
        let auth = auth.then(|| tasktap_proto::Auth::Device {
            device: DeviceId::mint(),
            key: Secret([1; 32]),
            register: Some(Register {
                name: "streams test".into(),
            }),
        });
        let hello = Hello {
            v: Versions(VERSION, VERSION),
            role: Role::Cli,
            client: "streams test".into(),
            auth,
            abilities: Vec::new(),
        };
        Client::hello(client::connect(self.data).unwrap(), hello)
            .unwrap()
            .unwrap()
    }

    fn device(&self) -> Client {
        self.hello(true)
    }

    /// The core's resident size in KiB. Windows has no `ps`: there the
    /// size reads as zero, so the tests still drive the same path and only
    /// the comparison says nothing.
    fn rss(&self) -> u64 {
        if cfg!(windows) {
            return 0;
        }
        let pid = self.child.id().to_string();
        let ps = Command::new("ps")
            .args(["-o", "rss=", "-p", &pid])
            .output()
            .unwrap();
        String::from_utf8(ps.stdout)
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }

    /// Waits up to `limit` for the core to exit by itself.
    fn exits_within(&mut self, limit: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < limit {
            if self.child.try_wait().unwrap().is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }
}

impl Drop for Core<'_> {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn fixture(credit: u32, send: u64, receive: u64, chunk: u32, marks: &[u64]) -> FixtureStream {
    let offset = |n: u64| Offset::new(n).unwrap();
    FixtureStream {
        credit,
        send: offset(send),
        receive: offset(receive),
        chunk,
        marks: marks.iter().copied().map(offset).collect(),
    }
}

fn open(c: &mut Client, args: FixtureStream, auto: bool) -> StreamId {
    let credit = args.credit;
    c.open::<call::FixtureStream>(&args, credit, auto)
        .unwrap()
        .unwrap()
}

/// The fixture's bytes, laid out so any offset is one slice of up to 4 MiB.
fn pattern(at: u64, len: usize) -> &'static [u8] {
    static BYTES: OnceLock<Vec<u8>> = OnceLock::new();
    let period = FixtureStream::PERIOD;
    let bytes = BYTES.get_or_init(|| {
        (0..period + 4 * MIB)
            .map(FixtureStream::byte)
            .collect::<Vec<_>>()
    });
    let start = (at % period) as usize;
    &bytes[start..start + len]
}

/// FNV-1a: a checksum that rolls over the bytes in order.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Sum(u64);

impl Default for Sum {
    fn default() -> Sum {
        Sum(0xcbf2_9ce4_8422_2325)
    }
}

impl Sum {
    fn add(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0 ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
        }
    }

    /// The checksum of the first `len` bytes of the fixture.
    fn of_pattern(len: u64) -> Sum {
        let mut sum = Sum::default();
        let mut at = 0;
        while at < len {
            let n = (len - at).min(4 * MIB);
            sum.add(pattern(at, n as usize));
            at += n;
        }
        sum
    }
}

/// One stream as a test drives it.
#[derive(Default)]
struct Flow {
    s: Option<StreamId>,
    /// Bytes to send it, and how many went.
    send: u64,
    sent: u64,
    /// Credit granted by hand this many bytes at a time; automatic if none.
    manual: Option<u32>,
    since: u32,
    got: u64,
    sum: Sum,
    marks: Vec<u64>,
    close: Option<Option<CloseWhy>>,
}

impl Flow {
    fn new(s: StreamId) -> Flow {
        Flow {
            s: Some(s),
            ..Flow::default()
        }
    }

    fn sending(self, send: u64) -> Flow {
        Flow { send, ..self }
    }

    fn manual(self, n: u32) -> Flow {
        Flow {
            manual: Some(n),
            ..self
        }
    }

    fn done(&self, got: u64) {
        assert_eq!(self.close, Some(Some(CloseWhy::Done)));
        assert_eq!(self.got, got, "every byte, none twice");
        assert_eq!(self.sum, Sum::of_pattern(got), "the bytes, in order");
    }
}

/// Drives streams until each is closed: sends what credit allows, reads
/// what arrives, and checks each mark sits at its exact offset. Returns the
/// stream of each data frame, in the order they came.
fn run(c: &mut Client, flows: &mut [Flow]) -> Vec<StreamId> {
    let mut order = Vec::new();
    while flows.iter().any(|f| f.close.is_none()) {
        for f in flows.iter_mut().filter(|f| f.close.is_none()) {
            if f.sent < f.send {
                let len = (f.send - f.sent).min(MIB) as usize;
                f.sent += c.send_some(f.s.unwrap(), pattern(f.sent, len)).unwrap() as u64;
            }
        }
        let frame = c.recv().unwrap();
        let s = match &frame {
            Frame::Data(d) => d.s,
            Frame::Control(Control::Mark(m)) => m.s,
            Frame::Control(Control::Close(cl)) => cl.s,
            Frame::Control(Control::Credit(_)) => continue,
            other => panic!("unexpected {other:?}"),
        };
        let f = flows.iter_mut().find(|f| f.s == Some(s)).unwrap();
        assert!(f.close.is_none(), "a frame after its stream closed");
        match frame {
            Frame::Data(d) => {
                order.push(s);
                f.got += d.bytes.len() as u64;
                f.sum.add(&d.bytes);
                if let Some(n) = f.manual {
                    f.since += d.bytes.len() as u32;
                    assert!(f.since <= n, "the core sent beyond the grant");
                    if f.since == n {
                        f.since = 0;
                        c.grant(s, n).unwrap();
                    }
                }
            }
            Frame::Control(Control::Mark(m)) => {
                assert_eq!(m.at.get(), f.got, "a mark at its exact offset");
                f.marks.push(m.at.get());
            }
            Frame::Control(Control::Close(cl)) => f.close = Some(cl.why),
            _ => unreachable!(),
        }
    }
    order
}

/// Reads until stream `s` has brought `n` more bytes; other frames are dropped.
fn read(c: &mut Client, s: StreamId, n: u64) {
    let mut got = 0;
    while got < n {
        if let Frame::Data(d) = c.recv().unwrap()
            && d.s == s
        {
            got += d.bytes.len() as u64;
        }
    }
}

/// The core closed this connection.
fn dropped(c: &mut Client) {
    loop {
        match c.recv() {
            Err(e) => {
                assert!(
                    matches!(
                        e.kind(),
                        ErrorKind::UnexpectedEof | ErrorKind::ConnectionReset
                    ),
                    "{e}"
                );
                return;
            }
            // What was queued before the violation may still arrive.
            Ok(Frame::Data(_) | Frame::Control(Control::Credit(_))) => {}
            Ok(frame) => panic!("expected the connection to end, got {frame:?}"),
        }
    }
}

fn status(c: &mut Client) {
    c.call::<call::CoreStatus>(&Empty {}).unwrap().unwrap();
}

#[test]
fn bytes_arrive_intact_and_in_order_from_the_core() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut c = core.device();
    assert!(c.welcome.calls.iter().any(|n| n == "fixture.stream"));
    // A byte at a time and 7 at a time granted by hand, then the largest
    // grant kept open automatically.
    for (credit, send) in [(1, 64 << 10), (7, 512 << 10), (MAX_CREDIT, 64 * MIB)] {
        let auto = credit == MAX_CREDIT;
        let s = open(&mut c, fixture(credit, send, 0, MAX_CREDIT, &[]), auto);
        let flow = Flow::new(s);
        let mut flows = [if auto { flow } else { flow.manual(credit) }];
        run(&mut c, &mut flows);
        flows[0].done(send);
    }
}

#[test]
fn bytes_arrive_intact_and_in_order_at_the_core() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut c = core.device();
    // The core grants `chunk` at a time; it closes with `done` only when
    // every byte matched.
    for (chunk, receive) in [(1, 64 << 10), (7, 512 << 10), (MAX_CREDIT, 64 * MIB)] {
        let s = open(&mut c, fixture(0, 0, receive, chunk, &[]), false);
        assert_eq!(c.credit(s), u64::from(chunk).min(receive));
        let mut flows = [Flow::new(s).sending(receive)];
        run(&mut c, &mut flows);
        assert_eq!(flows[0].close, Some(Some(CloseWhy::Done)));
    }
    // One wrong byte, and the fixture refuses the stream.
    let s = open(&mut c, fixture(0, 0, 100, 100, &[]), false);
    let mut bytes = pattern(0, 100).to_vec();
    bytes[57] ^= 1;
    c.write(s, &bytes).unwrap();
    let mut flows = [Flow::new(s)];
    run(&mut c, &mut flows);
    assert_eq!(flows[0].close, Some(Some(CloseWhy::Denied)));
}

#[test]
fn marks_arrive_at_exactly_their_byte_offsets() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut c = core.device();
    let marks = [0, 0, 1, 7, 8, 65520, 65521, 65531, 65532, 99_999, 200_000];
    for (credit, chunk) in [
        (7, MAX_CREDIT),
        (MAX_CREDIT, 1000),
        (MAX_CREDIT, MAX_CREDIT),
    ] {
        let auto = credit == MAX_CREDIT;
        let s = open(&mut c, fixture(credit, 200_000, 0, chunk, &marks), auto);
        let flow = Flow::new(s);
        let mut flows = [if auto { flow } else { flow.manual(credit) }];
        run(&mut c, &mut flows);
        flows[0].done(200_000);
        assert_eq!(flows[0].marks, marks);
    }
}

#[test]
fn several_streams_on_one_connection_interleave_without_corruption() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut c = core.device();
    // (credit, bytes from the core, bytes to it, chunk)
    let specs = [
        (MAX_CREDIT, 24 * MIB, 0, MAX_CREDIT),
        (MAX_CREDIT, 16 * MIB, 8 * MIB, MAX_CREDIT),
        (1 << 20, 12 * MIB, 0, 4096),
        (64 << 10, 8 * MIB, 4 * MIB, 64 << 10),
        (MAX_CREDIT, 0, 16 * MIB, 1 << 20),
        (7 << 10, 2 * MIB, 0, 7),
        (MAX_CREDIT, 20 * MIB, 0, 1000),
        (300, 1 << 18, 1 << 18, 300),
    ];
    let mut flows: Vec<Flow> = specs
        .iter()
        .map(|&(credit, send, receive, chunk)| {
            let s = open(&mut c, fixture(credit, send, receive, chunk, &[]), true);
            Flow::new(s).sending(receive)
        })
        .collect();
    let order = run(&mut c, &mut flows);
    for (f, &(_, send, _, _)) in flows.iter().zip(&specs) {
        f.done(send);
    }
    // They took turns: while the largest was sending, every other stream
    // that sends was sent to as well.
    let first_done = order
        .iter()
        .rposition(|&s| s == flows[0].s.unwrap())
        .unwrap();
    let during: HashSet<_> = order[..first_done].iter().collect();
    for f in flows.iter().filter(|f| f.got > 0) {
        assert!(during.contains(&f.s.unwrap()), "{:?} waited", f.s);
    }
}

#[test]
fn bytes_beyond_a_grant_end_the_connection() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut other = core.device();
    let raw = |c: &mut Client, s: StreamId, bytes: &[u8]| {
        let mut frame = Vec::new();
        encode_data(s, bytes, &mut frame).unwrap();
        c.stream().write_all(&frame).unwrap();
    };

    // One byte more than the core granted.
    let mut c = core.device();
    let s = open(&mut c, fixture(0, 0, 100, 10, &[]), false);
    assert_eq!(c.credit(s), 10);
    raw(&mut c, s, pattern(0, 11));
    dropped(&mut c);

    // Bytes for a stream the core never opened.
    let mut c = core.device();
    let s = open(&mut c, fixture(0, 0, 100, 10, &[]), false);
    raw(&mut c, StreamId(s.0 + 1), b"x");
    dropped(&mut c);

    // More credit outstanding than MAX_CREDIT.
    let mut c = core.device();
    let s = open(&mut c, fixture(MAX_CREDIT, 0, 1, 1, &[]), false);
    c.grant(s, 1).unwrap();
    dropped(&mut c);

    // Bytes for a stream this client closed are dropped, not a violation:
    // they may have been on their way.
    let mut c = core.device();
    let s = open(&mut c, fixture(0, 0, 100, 10, &[]), false);
    c.close(s).unwrap();
    raw(&mut c, s, pattern(0, 10));
    raw(&mut c, s, pattern(0, 10));
    status(&mut c);

    status(&mut other);
}

#[test]
fn closing_a_stream_stops_delivery_and_its_id_is_never_reused() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut c = core.device();
    let endless = open(
        &mut c,
        fixture(MAX_CREDIT, ENDLESS, 0, MAX_CREDIT, &[]),
        true,
    );
    let other = open(
        &mut c,
        fixture(MAX_CREDIT, 16 * MIB, 0, MAX_CREDIT, &[]),
        true,
    );
    let mut flows = [Flow::new(other)];
    // Reads until `until` arrives: data for `other` is checked, the rest dropped.
    let mut read_until = |c: &mut Client, until: &mut dyn FnMut(&Frame) -> bool| loop {
        let frame = c.recv().unwrap();
        if until(&frame) {
            break;
        }
        if let Frame::Data(d) = frame
            && d.s == other
        {
            flows[0].got += d.bytes.len() as u64;
            flows[0].sum.add(&d.bytes);
        }
    };
    let mut endless_got = 0;
    read_until(&mut c, &mut |frame| {
        matches!(frame, Frame::Data(d) if d.s == endless) && {
            endless_got += 1;
            endless_got > 64
        }
    });
    c.close(endless).unwrap();
    // The core handles the close before this call, so nothing for the
    // closed stream may come after the reply.
    let id = CallId(500);
    c.send(&call::CoreStatus::request(id, &Empty {})).unwrap();
    read_until(
        &mut c,
        &mut |frame| matches!(frame, Frame::Control(Control::Reply(r)) if r.id == id),
    );
    run(&mut c, &mut flows);
    flows[0].done(16 * MIB);

    // Closed by the client or by the core, far more than MAX_STREAMS of
    // them: every id is new.
    let mut seen = HashSet::from([endless, other]);
    for i in 0..3 * MAX_STREAMS {
        let s = if i % 2 == 0 {
            let s = open(&mut c, fixture(0, 1, 0, 1, &[]), false);
            c.close(s).unwrap();
            s
        } else {
            let s = open(&mut c, fixture(0, 0, 0, 1, &[]), false);
            let mut flows = [Flow::new(s)];
            run(&mut c, &mut flows);
            flows[0].done(0);
            s
        };
        assert!(seen.insert(s), "{s:?} was given twice");
    }
}

/// Resident sizes move by allocator pages, so the test allows this much,
/// against a gibibyte of credit.
const RSS_TOLERANCE_KIB: u64 = 8 << 10;

#[cfg(unix)]
#[test]
fn a_stalled_reader_costs_a_fixed_bound_and_holds_up_nobody() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut warm = core.device();
    let s = open(
        &mut warm,
        fixture(MAX_CREDIT, 8 * MIB, 0, MAX_CREDIT, &[]),
        true,
    );
    run(&mut warm, &mut [Flow::new(s)]);
    let before = core.rss();

    // 4 connections × 64 streams × 4 MiB: a gibibyte granted, and far more
    // asked for, by clients that never read.
    let stalled: Vec<Client> = (0..4)
        .map(|_| {
            let mut c = core.device();
            let streams: Vec<_> = (0..MAX_STREAMS)
                .map(|_| open(&mut c, fixture(0, ENDLESS, 0, MAX_CREDIT, &[]), false))
                .collect();
            for s in streams {
                c.grant(s, MAX_CREDIT).unwrap();
            }
            c
        })
        .collect();

    // Another connection still streams, both ways.
    let mut c = core.device();
    let s = open(
        &mut c,
        fixture(MAX_CREDIT, 32 * MIB, 8 * MIB, MAX_CREDIT, &[]),
        true,
    );
    let mut flows = [Flow::new(s).sending(8 * MIB)];
    run(&mut c, &mut flows);
    flows[0].done(32 * MIB);

    let after = core.rss();
    eprintln!(
        "stalled readers: core resident {before} KiB before, {after} KiB with 1 GiB granted and unread"
    );
    assert!(
        after < before + RSS_TOLERANCE_KIB,
        "{before} KiB grew to {after} KiB"
    );
    // The core did push to them: what the window held is there to read.
    let mut reader = stalled.into_iter().next().unwrap();
    assert!(matches!(reader.recv().unwrap(), Frame::Data(_)));
}

#[test]
fn a_connection_dropped_mid_stream_is_cleaned_up() {
    let data = Folder::new();
    let mut core = Core::idle(&data, 300);
    let mut probe = core.device();
    let before = core.rss();
    for _ in 0..8 {
        let mut c = core.device();
        let streams: Vec<_> = (0..MAX_STREAMS)
            .map(|_| {
                open(
                    &mut c,
                    fixture(MAX_CREDIT, ENDLESS, ENDLESS, MAX_CREDIT, &[]),
                    true,
                )
            })
            .collect();
        c.write(streams[0], pattern(0, MIB as usize)).unwrap();
        read(&mut c, streams[MAX_STREAMS - 1], MIB);
        drop(c);
    }
    status(&mut probe);
    let after = core.rss();
    assert!(
        after < before + RSS_TOLERANCE_KIB,
        "{before} KiB grew to {after} KiB"
    );
    // With its streams gone and nobody connected, the core idles out.
    drop(probe);
    assert!(core.exits_within(Duration::from_secs(10)));
}

#[test]
fn calls_are_answered_promptly_while_a_stream_is_saturated() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut c = core.device();
    let s = open(
        &mut c,
        fixture(MAX_CREDIT, ENDLESS, 0, MAX_CREDIT, &[]),
        true,
    );
    read(&mut c, s, 16 * MIB);
    let (mut most_behind, mut slowest, mut between) = (0, Duration::ZERO, 0);
    // Many calls: a reader that is late is late only now and then.
    for i in 0..200 {
        let id = CallId(1000 + i);
        let start = Instant::now();
        c.send(&call::CoreStatus::request(id, &Empty {})).unwrap();
        let mut behind = 0;
        loop {
            match c.recv().unwrap() {
                Frame::Data(d) => behind += d.bytes.len() as u64,
                Frame::Control(Control::Reply(r)) if r.id == id => break,
                _ => {}
            }
        }
        slowest = slowest.max(start.elapsed());
        most_behind = most_behind.max(behind);
        between += behind;
        read(&mut c, s, MIB);
    }
    // What the core controls (stream.rs): after a call can be read, at most
    // TURN + 2 × (WINDOW + one frame) of data before its reply. What was
    // already in the socket or this client's 64 KiB reads when the call was
    // sent comes on top; it depends on the platform, so it is measured.
    let core = (TURN + 2 * (WINDOW + MAX_DATA_FRAME)) as u64;
    let allowed = core + socket_holds() + 2 * (64 << 10);
    eprintln!(
        "saturated stream: slowest reply {slowest:?}, at most {most_behind} data bytes ahead of it, {allowed} allowed"
    );
    assert!(
        most_behind <= allowed,
        "{most_behind} bytes ahead of a reply"
    );
    assert!(between > 0, "data kept flowing while calls were answered");
}

/// What one local socket holds while nobody reads it.
#[cfg(unix)]
fn socket_holds() -> u64 {
    let (mut socket, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
    socket.set_nonblocking(true).unwrap();
    let chunk = vec![0; 256 << 10];
    let mut held = 0;
    while let Ok(n @ 1..) = socket.write(&chunk) {
        held += n as u64;
    }
    held
}

/// A named pipe's 64 KiB buffer and the write the runtime keeps in flight,
/// which std cannot measure.
#[cfg(not(unix))]
fn socket_holds() -> u64 {
    512 << 10
}

#[test]
fn fixture_arguments_and_the_stream_bound_are_checked() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut c = core.device();
    let code = |c: &mut Client, args: FixtureStream| {
        c.call::<call::FixtureStream>(&args)
            .unwrap()
            .unwrap_err()
            .code
    };
    assert_eq!(code(&mut c, fixture(0, 1, 0, 0, &[])), Code::Invalid);
    assert_eq!(
        code(&mut c, fixture(0, 1, 0, MAX_CREDIT + 1, &[])),
        Code::Invalid
    );
    assert_eq!(code(&mut c, fixture(0, 9, 0, 1, &[5, 4])), Code::Invalid);
    assert_eq!(code(&mut c, fixture(0, 9, 0, 1, &[10])), Code::Invalid);
    assert_eq!(
        code(&mut c, fixture(MAX_CREDIT + 1, 9, 0, 1, &[])),
        Code::Invalid
    );
    let mut anonymous = core.hello(false);
    assert_eq!(code(&mut anonymous, fixture(0, 1, 0, 1, &[])), Code::Denied);

    // MAX_STREAMS open at once; one more and the client is over a bound.
    for _ in 0..MAX_STREAMS {
        open(&mut c, fixture(0, 1, 0, 1, &[]), false);
    }
    let over = c.call::<call::FixtureStream>(&fixture(0, 1, 0, 1, &[]));
    assert!(over.is_err(), "the connection ended");
    status(&mut anonymous);
}

#[test]
fn throughput_through_the_fixture() {
    let data = Folder::new();
    let core = Core::start(&data);
    let mut c = core.device();
    let total = 256 * MIB;
    let start = Instant::now();
    let s = open(&mut c, fixture(MAX_CREDIT, total, 0, MAX_CREDIT, &[]), true);
    let mut got = 0;
    loop {
        match c.recv().unwrap() {
            Frame::Data(d) => {
                assert!(d.bytes == pattern(got, d.bytes.len()));
                got += d.bytes.len() as u64;
            }
            Frame::Control(Control::Close(cl)) if cl.s == s => break,
            _ => {}
        }
    }
    let out = start.elapsed();
    assert_eq!(got, total);

    let start = Instant::now();
    let s = open(&mut c, fixture(0, 0, total, MAX_CREDIT, &[]), false);
    let mut sent = 0;
    while sent < total {
        let n = (4 * MIB).min(total - sent);
        c.write(s, pattern(sent, n as usize)).unwrap();
        sent += n;
    }
    let mut flows = [Flow::new(s)];
    run(&mut c, &mut flows);
    let into = start.elapsed();
    assert_eq!(flows[0].close, Some(Some(CloseWhy::Done)));

    let rate = |d: Duration| total as f64 / d.as_secs_f64() / 1e6;
    eprintln!(
        "fixture throughput ({} build of the core): core to client {:.0} MB/s, client to core {:.0} MB/s",
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        rate(out),
        rate(into)
    );
}
