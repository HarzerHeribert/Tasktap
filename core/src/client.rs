//! The client the roles and the tests use (design §13): connect, or start the
//! core and connect; say hello; make calls; receive frames; open streams and
//! read and write them within credit. It blocks, so a short-lived role needs
//! no runtime.

use crate::sys;
use std::collections::{HashMap, VecDeque};
use std::fs::{File, TryLockError};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use tasktap_proto::{
    Call, CallId, Close, Control, Credit, Data, Decoder, Error, Frame, Hello, MAX_DATA, Opened,
    Refuse, StreamId, Welcome, encode_control, encode_data,
};

pub use crate::sys::ClientStream as Stream;

/// `<exe> serve --data <data>`, to pass to [`start`].
pub fn serve_command(exe: &Path, data: &Path) -> Command {
    let mut serve = Command::new(exe);
    serve.arg("serve").arg("--data").arg(data);
    serve
}

/// Starts a core detached and returns once a core listens on the folder:
/// this one, or the one that held it already, in which case this one exits.
/// There is no retry and no sleep: one read waits for the line `serve`
/// writes, `ready` or why it failed.
pub fn start(mut serve: Command) -> io::Result<Child> {
    let (reader, writer) = io::pipe()?;
    serve
        .stdin(Stdio::null())
        .stdout(writer.try_clone()?)
        .stderr(writer);
    sys::detach(&mut serve);
    let child = serve.spawn()?;
    // `serve` keeps this process's copies of the write end; the pipe only
    // ends once every copy is closed.
    drop(serve);
    let mut said = String::new();
    match BufReader::new(reader).read_line(&mut said) {
        Err(e) if e.kind() != io::ErrorKind::BrokenPipe => return Err(e),
        _ => {}
    }
    match said.trim_end() {
        "ready" => Ok(child),
        "" => Err(io::Error::other("the core ended before it listened")),
        why => Err(io::Error::other(why.to_owned())),
    }
}

/// Connects to the core serving `data`.
pub fn connect(data: &Path) -> io::Result<Stream> {
    sys::connect(data)
}

/// Connects to the core serving `data`, starting `exe` as that core first
/// when none runs, as [`admit`] does.
pub fn connect_or_start(exe: &Path, data: &Path) -> io::Result<Stream> {
    enter(serve_command(exe, data), data).map(|(stream, _)| stream)
}

/// Connects to the core serving `data` and says hello, starting `serve` (a
/// [`serve_command`]) first when no core runs; a refusal is the inner `Err`.
/// However many clients do this at once, one core starts and every client
/// gets in, with no retry and no timer: they wait for each other on
/// `start.lock` in the kernel.
pub fn admit(serve: Command, data: &Path, hello: Hello) -> io::Result<Result<Client, Refuse>> {
    // The lock is held through hello: the core has accepted this connection
    // once it answers.
    let (stream, _held) = enter(serve, data)?;
    Client::hello(stream, hello)
}

/// Connects, with `start.lock` held until the caller lets it go. A client
/// holds it shared while it connects, and a starting core holds it alone
/// until it listens, so a client waits for a core that is starting. A client
/// that finds no core, or one whose listen queue is full (it holds 128 on
/// macOS, and a full one refuses at once), takes the lock alone. It gets it
/// once every client connecting before it has been let in, so the queue
/// has room again: only a core that refuses for some other reason fails it
/// now. When no core holds `core.lock` it starts one with `--locked` and
/// keeps the lock until it listens, so it alone starts one; the clients
/// waiting behind it connect to that core.
fn enter(mut serve: Command, data: &Path) -> io::Result<(Stream, File)> {
    let gate = open(&data.join("start.lock"))?;
    gate.lock_shared()?;
    if let Ok(stream) = connect(data) {
        return Ok((stream, gate));
    }
    gate.unlock()?;
    gate.lock()?;
    let stream = match connect(data) {
        Ok(stream) => stream,
        Err(e) if running(data)? => return Err(e),
        Err(_) => {
            serve.arg("--locked");
            start(serve)?;
            connect(data)?
        }
    };
    Ok((stream, gate))
}

/// Whether a core holds `core.lock`, which it does for life. Asked only with
/// `start.lock` held, when no core can be between taking one and the other.
fn running(data: &Path) -> io::Result<bool> {
    match open(&data.join("core.lock"))?.try_lock_shared() {
        Ok(()) => Ok(false),
        Err(TryLockError::WouldBlock) => Ok(true),
        Err(TryLockError::Error(e)) => Err(e),
    }
}

fn open(path: &Path) -> io::Result<File> {
    let mut options = File::options();
    options.create(true).truncate(false).write(true).open(path)
}

/// A connection the core welcomed.
pub struct Client {
    stream: Stream,
    decoder: Decoder,
    /// Frames that arrived while a call waited for its reply.
    held: VecDeque<Frame>,
    next: u32,
    /// Every stream the core opened for this client; `None` once closed,
    /// so late frames for it are told from a core that broke the protocol.
    streams: HashMap<StreamId, Option<Flow>>,
    pub welcome: Welcome,
}

/// One open stream as this client counts it.
struct Flow {
    /// Bytes the core may still send.
    granted: u64,
    /// Bytes this client may still send.
    credit: u64,
    /// With automatic credit: the grant to keep open, and what was handed
    /// out since the last grant.
    auto: Option<(u32, u32)>,
}

impl Client {
    /// Says hello; a refusal is the inner `Err`.
    pub fn hello(mut stream: Stream, hello: Hello) -> io::Result<Result<Client, Refuse>> {
        let mut decoder = Decoder::new();
        write(&mut stream, &Control::Hello(hello))?;
        match read(&mut stream, &mut decoder)? {
            Frame::Control(Control::Welcome(welcome)) => Ok(Ok(Client {
                stream,
                decoder,
                held: VecDeque::new(),
                next: 0,
                streams: HashMap::new(),
                welcome,
            })),
            Frame::Control(Control::Refuse(refuse)) => Ok(Err(refuse)),
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the core answered hello with neither welcome nor refuse",
            )),
        }
    }

    /// Makes a call and waits for its reply.
    pub fn call<C: Call>(&mut self, args: &C::Args) -> io::Result<Result<C::Result, Error>> {
        let id = CallId(self.next);
        self.next = self.next.wrapping_add(1);
        self.send(&C::request(id, args))?;
        loop {
            match self.take()? {
                Frame::Control(Control::Reply(reply)) if reply.id == id => {
                    return Ok(C::result(reply.outcome));
                }
                other => self.hold(other),
            }
        }
    }

    pub fn send(&mut self, frame: &Control) -> io::Result<()> {
        write(&mut self.stream, frame)
    }

    /// The next frame from the core. Data for a stream with automatic credit
    /// is granted back as it is handed out here. A `credit` frame read here
    /// is handed out too, so a caller can send what it now allows; those
    /// read while waiting in [`Client::call`] or [`Client::write`] only count.
    pub fn recv(&mut self) -> io::Result<Frame> {
        let frame = match self.held.pop_front() {
            Some(frame) => frame,
            None => self.take()?,
        };
        if let Frame::Data(Data { s, bytes }) = &frame
            && let Some(Some(Flow {
                auto: Some((window, owed)),
                ..
            })) = self.streams.get_mut(s)
        {
            *owed += bytes.len() as u32;
            if *owed >= (*window / 2).max(1) {
                let n = std::mem::take(owed);
                self.grant(*s, n)?;
            }
        }
        Ok(frame)
    }

    /// Makes a call that opens a stream; `credit` is what its args grant the
    /// core. With `auto`, [`Client::recv`] grants back what it hands out, so
    /// the core can stay `credit` bytes ahead; without, see [`Client::grant`].
    pub fn open<C: Call<Result = Opened>>(
        &mut self,
        args: &C::Args,
        credit: u32,
        auto: bool,
    ) -> io::Result<Result<StreamId, Error>> {
        Ok(self.opened::<C>(args, credit, auto)?.map(|opened| opened.s))
    }

    /// [`Client::open`], with the whole reply: a terminal's says where its
    /// stream starts.
    pub fn opened<C: Call<Result = Opened>>(
        &mut self,
        args: &C::Args,
        credit: u32,
        auto: bool,
    ) -> io::Result<Result<Opened, Error>> {
        let opened = match self.call::<C>(args)? {
            Ok(opened) => opened,
            Err(e) => return Ok(Err(e)),
        };
        self.track(&opened, credit, auto);
        Ok(Ok(opened))
    }

    /// Follows a stream that a call's reply names among other things, as
    /// [`Client::opened`] follows one that is the whole reply.
    pub fn track(&mut self, opened: &Opened, credit: u32, auto: bool) {
        let flow = Flow {
            granted: credit.into(),
            credit: opened.credit.into(),
            auto: auto.then_some((credit, 0)),
        };
        self.streams.insert(opened.s, Some(flow));
    }

    /// Lets the core send `n` more bytes on `s`.
    pub fn grant(&mut self, s: StreamId, n: u32) -> io::Result<()> {
        if let Some(Some(flow)) = self.streams.get_mut(&s) {
            flow.granted += u64::from(n);
        }
        self.send(&Control::Credit(Credit { s, n }))
    }

    /// Bytes this client may send on `s` now.
    pub fn credit(&self, s: StreamId) -> u64 {
        match self.streams.get(&s) {
            Some(Some(flow)) => flow.credit,
            _ => 0,
        }
    }

    /// Sends as much of `bytes` as the credit allows, without waiting for
    /// more; returns how many. A closed stream is `BrokenPipe`.
    pub fn send_some(&mut self, s: StreamId, bytes: &[u8]) -> io::Result<usize> {
        let Some(Some(flow)) = self.streams.get_mut(&s) else {
            return Err(io::ErrorKind::BrokenPipe.into());
        };
        let n = bytes
            .len()
            .min(usize::try_from(flow.credit).unwrap_or(usize::MAX));
        flow.credit -= n as u64;
        let mut frames = Vec::with_capacity(n + n.div_ceil(MAX_DATA) * 9);
        for chunk in bytes[..n].chunks(MAX_DATA) {
            // Chunks are within the limit, so this cannot fail.
            let _ = encode_data(s, chunk, &mut frames);
        }
        self.stream.write_all(&frames)?;
        Ok(n)
    }

    /// Sends all of `bytes`, waiting for credit; frames that arrive
    /// meanwhile wait for [`Client::recv`].
    pub fn write(&mut self, s: StreamId, mut bytes: &[u8]) -> io::Result<()> {
        while !bytes.is_empty() {
            let n = self.send_some(s, bytes)?;
            bytes = &bytes[n..];
            if n == 0 {
                let frame = self.take()?;
                self.hold(frame);
            }
        }
        Ok(())
    }

    /// Ends a stream; frames for it that are still on their way are handed
    /// out as they come.
    pub fn close(&mut self, s: StreamId) -> io::Result<()> {
        if let Some(flow) = self.streams.get_mut(&s) {
            *flow = None;
        }
        self.send(&Control::Close(Close { s, why: None }))
    }

    /// Keeps a frame for [`Client::recv`]; a credit frame has done its work.
    fn hold(&mut self, frame: Frame) {
        if !matches!(frame, Frame::Control(Control::Credit(_))) {
            self.held.push_back(frame);
        }
    }

    /// The next frame from the connection, counted against its stream: data
    /// beyond what this client granted is an error, as it is in the core.
    fn take(&mut self) -> io::Result<Frame> {
        let frame = read(&mut self.stream, &mut self.decoder)?;
        let broken = |why: &str| io::Error::new(io::ErrorKind::InvalidData, why);
        match &frame {
            Frame::Data(Data { s, bytes }) => match self.streams.get_mut(s) {
                Some(Some(flow)) => {
                    flow.granted = (flow.granted.checked_sub(bytes.len() as u64))
                        .ok_or_else(|| broken("the core sent beyond its credit"))?;
                }
                Some(None) => {}
                None => return Err(broken("data on a stream the core never opened")),
            },
            Frame::Control(Control::Credit(Credit { s, n })) => {
                if let Some(Some(flow)) = self.streams.get_mut(s) {
                    flow.credit += u64::from(*n);
                }
            }
            Frame::Control(Control::Close(Close { s, .. })) => {
                if let Some(flow) = self.streams.get_mut(s) {
                    *flow = None;
                }
            }
            _ => {}
        }
        Ok(frame)
    }

    /// The connection itself, for bytes the protocol would not produce.
    pub fn stream(&mut self) -> &mut Stream {
        &mut self.stream
    }
}

fn write(stream: &mut Stream, frame: &Control) -> io::Result<()> {
    let mut bytes = Vec::new();
    encode_control(frame, &mut bytes)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    stream.write_all(&bytes)
}

fn read(stream: &mut Stream, decoder: &mut Decoder) -> io::Result<Frame> {
    // One read can bring a whole data frame.
    let mut buf = [0; 64 << 10];
    loop {
        let next = decoder.next_frame();
        if let Some(frame) = next.map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))? {
            return Ok(frame);
        }
        match stream.read(&mut buf) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => decoder.push(&buf[..n]),
            // A signal arriving mid-read is not an error of the connection.
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
}
