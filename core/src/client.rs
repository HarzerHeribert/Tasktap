//! The client the roles and the tests use (design §13): connect, or start the
//! core and connect; say hello; make calls; receive frames. It blocks, so a
//! short-lived role needs no runtime.

use crate::sys;
use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use tasktap_proto::{
    Call, CallId, Control, Decoder, Error, Frame, Hello, Refuse, Welcome, encode_control,
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
/// when none answers.
pub fn connect_or_start(exe: &Path, data: &Path) -> io::Result<Stream> {
    connect(data).or_else(|_| {
        start(serve_command(exe, data))?;
        connect(data)
    })
}

/// A connection the core welcomed.
pub struct Client {
    stream: Stream,
    decoder: Decoder,
    /// Frames that arrived while a call waited for its reply.
    held: VecDeque<Frame>,
    next: u32,
    pub welcome: Welcome,
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
            match read(&mut self.stream, &mut self.decoder)? {
                Frame::Control(Control::Reply(reply)) if reply.id == id => {
                    return Ok(C::result(reply.outcome));
                }
                other => self.held.push_back(other),
            }
        }
    }

    pub fn send(&mut self, frame: &Control) -> io::Result<()> {
        write(&mut self.stream, frame)
    }

    /// The next frame from the core.
    pub fn recv(&mut self) -> io::Result<Frame> {
        match self.held.pop_front() {
            Some(frame) => Ok(frame),
            None => read(&mut self.stream, &mut self.decoder),
        }
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
    let mut buf = [0; 8 << 10];
    loop {
        let next = decoder.next_frame();
        if let Some(frame) = next.map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))? {
            return Ok(frame);
        }
        match stream.read(&mut buf)? {
            0 => return Err(io::ErrorKind::UnexpectedEof.into()),
            n => decoder.push(&buf[..n]),
        }
    }
}
