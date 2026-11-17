//! The clients `scripts/measure.sh` needs; the script does the measuring and
//! the printing, this only plays the part of a client.
//!
//!     measure hold <data>              connect, register, subscribe to everything, then block on a read
//!     measure cold <exe> <n>           n cold starts on fresh folders; prints milliseconds, one per line
//!     measure stream <data> <MiB> <n>  n runs of `fixture.stream` each way; prints MB/s, one per line
//!
//! `stream` needs a core built with the `fixtures` feature; the others work with any build.

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;
use tasktap_core::client::{self, Client};
use tasktap_proto::call;
use tasktap_proto::{
    Auth, Collection, Control, DeviceId, FixtureStream, Frame, Hello, MAX_CREDIT, Offset, Register,
    Role, Secret, StreamId, Subscribe, VERSION, Versions,
};

const ALL: [Collection; 10] = [
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
        "cold" => cold(Path::new(arg(1)), number(2)?),
        "stream" => stream(Path::new(arg(1)), number(2)? << 20, number(3)?),
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
