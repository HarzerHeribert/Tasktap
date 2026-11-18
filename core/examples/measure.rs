//! The clients `scripts/measure.sh` needs; the script does the measuring and
//! the printing, this only plays the part of a client.
//!
//!     measure hold <data>              connect, register, subscribe to everything, then block on a read
//!     measure quiet <data>             open a terminal running `cat`, attached, then block on a read
//!     measure cold <exe> <n>           n cold starts on fresh folders; prints milliseconds, one per line
//!     measure stream <data> <MiB> <n>  n runs of `fixture.stream` each way; prints MB/s, one per line
//!     measure keys <data> <n> <load>   n keys typed into a terminal running `cat`, each timed from its
//!                                      write on the stream to its echo on the stream; prints
//!                                      microseconds, one per line. <load>: `none`; `commits`, another
//!                                      client commits to the store all along; `slow`, a second client
//!                                      attached to the same terminal reads 16 bytes every 200 ms
//!     measure pty <n>                  the same n keys through a bare pseudo-terminal, no core
//!     measure terminals <data> <n>     starts n terminals that each write 2.5 MB, so their history is
//!                                      full, and then wait; prints `filled` and holds until killed
//!     measure commits <folder> <n> <fullfsync>
//!                                      n small SQLite commits as the store makes them (WAL,
//!                                      synchronous=FULL), with F_FULLFSYNC when <fullfsync> is 1;
//!                                      prints microseconds, one per line
//!
//! `stream` needs a core built with the `fixtures` feature; the others work with any build.

#[cfg(unix)]
use std::io::Read;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tasktap_core::client::{self, Client};
use tasktap_proto::call;
use tasktap_proto::{
    Auth, Collection, Control, DeviceId, FixtureStream, Frame, Hello, MAX_CREDIT, Offset,
    OpenTerminal, PrefPatch, Put, PutTarget, Register, Role, Secret, Set, StartTerminal, StreamId,
    Subscribe, TerminalId, VERSION, Versions,
};

/// Keys typed before the timed ones, while `cat` starts.
const WARM: u64 = 20;

const ALL: [Collection; 11] = [
    Collection::Thoughts,
    Collection::Projects,
    Collection::Sessions,
    Collection::Terminals,
    Collection::Questions,
    Collection::Results,
    Collection::Layouts,
    Collection::Prefs,
    Collection::Devices,
    Collection::Glance,
    Collection::Agents,
];

fn main() -> io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |i: usize| args.get(i).map(String::as_str).unwrap_or("");
    let number = |i: usize| {
        arg(i)
            .parse::<u64>()
            .map_err(|_| io::Error::other("usage: see the top of examples/measure.rs"))
    };
    match arg(0) {
        "hold" => hold(Path::new(arg(1))),
        "quiet" => quiet(Path::new(arg(1))),
        "cold" => cold(Path::new(arg(1)), number(2)?),
        "stream" => stream(Path::new(arg(1)), number(2)? << 20, number(3)?),
        "keys" => keys(Path::new(arg(1)), number(2)?, arg(3)),
        "pty" => pty(number(1)?),
        "terminals" => terminals(Path::new(arg(1)), number(2)?),
        "commits" => commits(Path::new(arg(1)), number(2)?, arg(3) == "1"),
        _ => Err(io::Error::other(
            "usage: see the top of examples/measure.rs",
        )),
    }
}

/// A new connection as a newly registered device.
fn device(data: &Path) -> io::Result<Client> {
    let hello = Hello {
        v: Versions(VERSION, VERSION),
        role: Role::Page,
        client: "measure".into(),
        auth: Some(Auth::Device {
            device: DeviceId::mint(),
            key: Secret([1; 32]),
            register: Some(Register {
                name: "measure".into(),
            }),
        }),
        abilities: Vec::new(),
    };
    Client::hello(client::connect(data)?, hello)?
        .map_err(|refused| io::Error::other(format!("refused: {refused:?}")))
}

/// Subscribes to every collection, says so, and then does nothing but wait
/// in `read` until the core or the script ends it.
fn hold(data: &Path) -> io::Result<()> {
    let mut c = device(data)?;
    let sub = Subscribe {
        collections: ALL.to_vec(),
    };
    c.call::<call::Sub>(&sub)?
        .map_err(|e| io::Error::other(format!("sub: {e:?}")))?;
    println!("subscribed");
    io::stdout().flush()?;
    // The agents the core detects as it starts come as one change.
    let mut detected = false;
    loop {
        if let Frame::Control(Control::Change(change)) = c.recv()? {
            let agents = |set: &Set| matches!(set, Set::Agents(rows) if !rows.put.is_empty());
            if !detected && change.sets.iter().any(agents) {
                detected = true;
                println!("detected");
                io::stdout().flush()?;
            }
        }
    }
}

/// A terminal that writes nothing, with this client attached to it.
fn quiet(data: &Path) -> io::Result<()> {
    let mut c = device(data)?;
    terminal(
        &mut c,
        TerminalId::mint(),
        Some(&["/bin/cat"]),
        MAX_CREDIT,
        true,
    )?;
    println!("open");
    io::stdout().flush()?;
    loop {
        c.recv()?;
    }
}

/// Starts `n` cores one after another, each on a folder that does not exist
/// yet, and times each from the spawn to the line `ready`.
fn cold(exe: &Path, n: u64) -> io::Result<()> {
    let root = std::env::temp_dir().join(format!("tm-{}", std::process::id()));
    for i in 0..n {
        let data: PathBuf = root.join(i.to_string());
        std::fs::create_dir_all(&data)?;
        let at = Instant::now();
        let mut core = client::start(client::serve_command(exe, &data))?;
        let took = at.elapsed();
        core.kill()?;
        core.wait()?;
        std::fs::remove_dir_all(&data)?;
        println!("{:.3}", took.as_secs_f64() * 1e3);
    }
    let _ = std::fs::remove_dir(&root);
    Ok(())
}

/// `runs` times: `bytes` from the core to this client, then `bytes` from
/// this client to the core, each timed from the call to the core's close.
fn stream(data: &Path, bytes: u64, runs: u64) -> io::Result<()> {
    let mut c = device(data)?;
    let pattern: Vec<u8> = (0..FixtureStream::PERIOD + (4 << 20))
        .map(FixtureStream::byte)
        .collect();
    let offset = |n| Offset::new(n).ok_or_else(|| io::Error::other("too many bytes"));
    for _ in 0..runs {
        let down = FixtureStream {
            credit: MAX_CREDIT,
            send: offset(bytes)?,
            receive: offset(0)?,
            chunk: MAX_CREDIT,
            marks: Vec::new(),
        };
        let at = Instant::now();
        let s = open(&mut c, &down, true)?;
        let got = drain(&mut c, s)?;
        report("down", got, at)?;

        let up = FixtureStream {
            send: offset(0)?,
            receive: offset(bytes)?,
            ..down
        };
        let at = Instant::now();
        let s = open(&mut c, &up, false)?;
        let mut sent = 0;
        while sent < bytes {
            let start = (sent % FixtureStream::PERIOD) as usize;
            let len = (bytes - sent).min(4 << 20) as usize;
            c.write(s, &pattern[start..start + len])?;
            sent += len as u64;
        }
        drain(&mut c, s)?;
        report("up", sent, at)?;
    }
    Ok(())
}

/// Opens a terminal that runs `argv`, or attaches to it without.
fn terminal(
    c: &mut Client,
    id: TerminalId,
    argv: Option<&[&str]>,
    credit: u32,
    auto: bool,
) -> io::Result<StreamId> {
    let start = argv.map(|argv| StartTerminal {
        project: None,
        argv: argv.iter().map(|a| (*a).to_owned()).collect(),
        title: None,
    });
    let open = OpenTerminal {
        id,
        start,
        cols: 80,
        rows: 24,
        from: None,
        credit,
    };
    c.open::<call::TerminalOpen>(&open, credit, auto)?
        .map_err(|e| io::Error::other(format!("terminal.open: {e:?}")))
}

/// Types key `b` and reads until its echo; the time between, in microseconds.
fn key(c: &mut Client, s: StreamId, b: u8) -> io::Result<f64> {
    let at = Instant::now();
    c.write(s, &[b])?;
    loop {
        match c.recv()? {
            Frame::Data(d) if d.s == s && d.bytes.contains(&b) => {
                return Ok(at.elapsed().as_secs_f64() * 1e6);
            }
            Frame::Control(Control::Close(close)) if close.s == s => {
                return Err(io::Error::other("the terminal ended"));
            }
            _ => {}
        }
    }
}

/// The key of the `i`th keystroke: letters in turn, each echoed as itself.
fn letter(i: u64) -> u8 {
    b'a' + (i % 26) as u8
}

fn keys(data: &Path, n: u64, load: &str) -> io::Result<()> {
    let mut c = device(data)?;
    let id = TerminalId::mint();
    let s = terminal(&mut c, id, Some(&["/bin/cat"]), MAX_CREDIT, true)?;
    for i in 0..WARM {
        key(&mut c, s, letter(i))?;
    }
    let stop = Arc::new(AtomicBool::new(false));
    let mut d = device(data)?;
    let busy = stop.clone();
    let load = match load {
        // Each put is one transaction, committed and on disk before its reply.
        "commits" => std::thread::spawn(move || -> io::Result<u64> {
            let mut commits = 0;
            while !busy.load(Ordering::Relaxed) {
                let target = PutTarget::Prefs(PrefPatch::Hold(5 + (commits % 2) as u32));
                d.call::<call::Put>(&Put {
                    target,
                    if_rev: None,
                })?
                .map_err(|e| io::Error::other(format!("put: {e:?}")))?;
                commits += 1;
            }
            Ok(commits)
        }),
        // Attached to the same terminal, far behind it and taking little.
        "slow" => {
            let slow = terminal(&mut d, id, None, 16, false)?;
            std::thread::spawn(move || -> io::Result<u64> {
                let mut frames = 0;
                while !busy.load(Ordering::Relaxed) {
                    d.recv()?;
                    frames += 1;
                    std::thread::sleep(Duration::from_millis(200));
                    d.grant(slow, 16)?;
                }
                Ok(frames)
            })
        }
        _ => std::thread::spawn(|| Ok(0)),
    };
    // The load gets going first.
    std::thread::sleep(Duration::from_millis(200));
    let mut took = Vec::new();
    for i in 0..n {
        took.push(key(&mut c, s, letter(WARM + i))?);
    }
    stop.store(true, Ordering::Relaxed);
    let done = load
        .join()
        .map_err(|_| io::Error::other("the load panicked"))??;
    for t in took {
        println!("{t:.1}");
    }
    eprintln!("load: {done}");
    io::stdout().flush()
}

/// The library the core's terminals use on Mac and Linux, measured by itself;
/// on Windows the core makes its console itself, and there is no such floor.
#[cfg(windows)]
fn pty(_: u64) -> io::Result<()> {
    Err(io::Error::other("this measure runs on Mac and Linux only"))
}

#[cfg(unix)]
fn pty(n: u64) -> io::Result<()> {
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    let size = PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(io::Error::other)?;
    let mut child = (pair.slave)
        .spawn_command(CommandBuilder::new("/bin/cat"))
        .map_err(io::Error::other)?;
    let mut reader = pair.master.try_clone_reader().map_err(io::Error::other)?;
    let mut writer = pair.master.take_writer().map_err(io::Error::other)?;
    let mut buf = [0; 256];
    let mut type_one = |b: u8| -> io::Result<f64> {
        let at = Instant::now();
        writer.write_all(&[b])?;
        writer.flush()?;
        loop {
            let got = reader.read(&mut buf)?;
            if got == 0 {
                return Err(io::Error::other("the terminal ended"));
            }
            if buf[..got].contains(&b) {
                return Ok(at.elapsed().as_secs_f64() * 1e6);
            }
        }
    };
    for i in 0..WARM {
        type_one(letter(i))?;
    }
    let mut took = Vec::new();
    for i in 0..n {
        took.push(type_one(letter(WARM + i))?);
    }
    let _ = child.kill();
    for t in took {
        println!("{t:.1}");
    }
    io::stdout().flush()
}

/// What each terminal writes: more than the 2 MiB its history keeps.
const FILL: u64 = 2_500_000;

/// Starts the terminals with no credit, so no output is sent anywhere and
/// only the terminals hold it, and waits until each has written it all: an
/// attachment from offset [`FILL`] starts there only once its output has
/// reached it. Then it leaves, and the terminals run on.
fn terminals(data: &Path, n: u64) -> io::Result<()> {
    let mut c = device(data)?;
    let script = format!("head -c {FILL} /dev/zero | tr '\\000' x; exec cat");
    let argv = ["/bin/sh", "-c", script.as_str()];
    let mut ids = Vec::new();
    for _ in 0..n {
        let id = TerminalId::mint();
        let s = terminal(&mut c, id, Some(&argv), 0, false)?;
        c.close(s)?;
        ids.push(id);
    }
    let fill = Offset::new(FILL).ok_or_else(|| io::Error::other("too many bytes"))?;
    for id in ids {
        loop {
            let open = OpenTerminal {
                id,
                start: None,
                cols: 80,
                rows: 24,
                from: Some(fill),
                credit: 0,
            };
            let opened = c
                .opened::<call::TerminalOpen>(&open, 0, false)?
                .map_err(|e| io::Error::other(format!("terminal.open: {e:?}")))?;
            c.close(opened.s)?;
            if opened.from == Some(fill) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    println!("filled");
    io::stdout().flush()
}

fn commits(folder: &Path, n: u64, fullfsync: bool) -> io::Result<()> {
    let sql = |e: rusqlite::Error| io::Error::other(e.to_string());
    std::fs::create_dir_all(folder)?;
    let path = folder.join(format!("commits-{}.db", u8::from(fullfsync)));
    let _ = std::fs::remove_file(&path);
    let db = rusqlite::Connection::open(&path).map_err(sql)?;
    db.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get::<_, String>(0))
        .map_err(sql)?;
    db.pragma_update(None, "synchronous", "FULL").map_err(sql)?;
    db.pragma_update(None, "fullfsync", fullfsync)
        .map_err(sql)?;
    db.execute_batch("CREATE TABLE rows (id INTEGER PRIMARY KEY, rev INTEGER, body TEXT)")
        .map_err(sql)?;
    // A row of about the size a thought's is, rewritten, as a state change is.
    let body = "x".repeat(400);
    let mut took = Vec::new();
    for i in 0..n + WARM {
        let at = Instant::now();
        db.execute(
            "INSERT OR REPLACE INTO rows (id, rev, body) VALUES (?1, ?2, ?3)",
            ((i % 16) as i64, i as i64, &body),
        )
        .map_err(sql)?;
        if i >= WARM {
            took.push(at.elapsed().as_secs_f64() * 1e6);
        }
    }
    drop(db);
    for ext in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{ext}", path.display()));
    }
    for t in took {
        println!("{t:.1}");
    }
    io::stdout().flush()
}

fn open(c: &mut Client, args: &FixtureStream, auto: bool) -> io::Result<StreamId> {
    c.open::<call::FixtureStream>(args, args.credit, auto)?
        .map_err(|e| io::Error::other(format!("fixture.stream: {e:?}")))
}

/// Reads until the core closes `s`, counting its bytes.
fn drain(c: &mut Client, s: StreamId) -> io::Result<u64> {
    let mut got = 0;
    loop {
        match c.recv()? {
            Frame::Data(d) if d.s == s => got += d.bytes.len() as u64,
            Frame::Control(Control::Close(close)) if close.s == s => {
                return match close.why {
                    Some(tasktap_proto::CloseWhy::Done) => Ok(got),
                    why => Err(io::Error::other(format!("stream closed: {why:?}"))),
                };
            }
            _ => {}
        }
    }
}

/// One line: the direction and the rate in MB/s (10^6 bytes per second).
fn report(way: &str, bytes: u64, since: Instant) -> io::Result<()> {
    println!(
        "{way} {:.1}",
        bytes as f64 / since.elapsed().as_secs_f64() / 1e6
    );
    io::stdout().flush()
}
