//! The host's side of the core (design §2, §3, §12): its data folder and copy of the core, the
//! device key, start on demand, one connection per page passed through untouched, and the
//! host's own connection, which watches `glance` and makes the calls the shortcuts stand for.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File, TryLockError};
use std::io::{self, BufRead, BufReader, Read, Write};
#[cfg(unix)]
use std::os::unix::{
    fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    process::CommandExt,
};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tasktap_proto::{
    encode_control, Auth, CallId, Control, Decoder, DeviceId, Frame, Glance, Hello, Outcome, PrefKey, PrefValue,
    Register, Request, Role, Secret, Set, Shortcut, Versions, Welcome, VERSION,
};

/// What the host's own connection watches: `glance`, the folders, and the capture key among the preferences.
const WATCHED: [&str; 3] = ["glance", "projects", "prefs"];

/// A connection to the core: its socket in the data folder, or on Windows its named pipe.
#[cfg(unix)]
pub type Stream = std::os::unix::net::UnixStream;
#[cfg(windows)]
pub type Stream = crate::native::Pipe;

fn dial(data: &Path) -> io::Result<Stream> {
    #[cfg(unix)]
    return Stream::connect(data.join("core.sock"));
    #[cfg(windows)]
    return Stream::connect(data);
}

pub struct Core {
    pub data: PathBuf,
    exe: PathBuf,
    pub build: String,
    device: DeviceId,
    key: Secret,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct DeviceFile {
    device: DeviceId,
    key: Secret,
}

impl Core {
    /// Makes the data folder (0700), copies the core to `<data>/bin/<build>/tasktap`, where it runs
    /// from so a later app can replace its own copy while this one runs, and loads or mints the
    /// device key.
    pub fn prepare(data: PathBuf, bundled: &Path, build: String) -> io::Result<Core> {
        #[cfg(unix)]
        {
            fs::DirBuilder::new().recursive(true).mode(0o700).create(&data)?;
            fs::set_permissions(&data, fs::Permissions::from_mode(0o700))?;
        }
        // On Windows the folder is in the person's profile, whose access list keeps others out.
        #[cfg(windows)]
        fs::create_dir_all(&data)?;
        let exe = data.join("bin").join(&build).join(format!("tasktap{}", std::env::consts::EXE_SUFFIX));
        if !exe.exists() {
            fs::create_dir_all(exe.parent().unwrap())?;
            let partial = exe.with_extension("partial");
            fs::copy(bundled, &partial)?;
            #[cfg(unix)]
            fs::set_permissions(&partial, fs::Permissions::from_mode(0o755))?;
            // Microsoft's console travels with the core, which loads it from its own folder
            // (design §9, "Input"); there before the core is, so no core runs without it.
            #[cfg(windows)]
            for beside in ["conpty.dll", "OpenConsole.exe"] {
                let from = bundled.with_file_name(beside);
                if from.exists() {
                    fs::copy(&from, exe.with_file_name(beside))?;
                }
            }
            fs::rename(&partial, &exe)?;
        }
        let path = data.join("host-device.json");
        let device = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                let minted = DeviceFile { device: DeviceId::mint(), key: Secret::mint() };
                let mut options = File::options();
                options.write(true).create_new(true);
                #[cfg(unix)]
                options.mode(0o600);
                let mut file = options.open(&path)?;
                file.write_all(&serde_json::to_vec(&minted)?)?;
                minted
            }
            Err(e) => return Err(e),
        };
        Ok(Core { data, exe, build, device: device.device, key: device.key })
    }

    /// Connects, with `start.lock` held until the caller lets it go (design §3, as
    /// core/src/client.rs does it): shared while connecting, alone to start a core.
    fn enter(&self) -> io::Result<(Stream, File)> {
        let gate = File::options().create(true).truncate(false).write(true).open(self.data.join("start.lock"))?;
        gate.lock_shared()?;
        if let Ok(stream) = dial(&self.data) {
            return Ok((stream, gate));
        }
        gate.unlock()?;
        gate.lock()?;
        if let Ok(stream) = dial(&self.data) {
            return Ok((stream, gate));
        }
        let held = File::options().create(true).truncate(false).write(true).open(self.data.join("core.lock"))?;
        match held.try_lock_shared() {
            Ok(()) => drop(held),
            Err(TryLockError::WouldBlock) => {
                return Err(io::Error::other("a core holds the folder but does not listen"))
            }
            Err(TryLockError::Error(e)) => return Err(e),
        }
        self.start()?;
        Ok((dial(&self.data)?, gate))
    }

    /// Starts `tasktap serve` detached and waits for the one line it writes once it listens.
    fn start(&self) -> io::Result<()> {
        let (reader, writer) = io::pipe()?;
        let mut serve = Command::new(&self.exe);
        serve.arg("serve").arg("--data").arg(&self.data).arg("--locked");
        serve.stdin(Stdio::null()).stdout(writer.try_clone()?).stderr(writer);
        #[cfg(unix)]
        serve.process_group(0);
        #[cfg(windows)]
        crate::native::detach(&mut serve);
        let mut child = serve.spawn()?;
        drop(serve);
        let mut said = String::new();
        // On Windows a pipe whose other end closed is an error, not an end.
        match BufReader::new(reader).read_line(&mut said) {
            Err(e) if e.kind() != io::ErrorKind::BrokenPipe => return Err(e),
            _ => {}
        }
        // Reaped here when it exits, so it never lingers as a zombie of the host.
        std::thread::spawn(move || child.wait());
        match said.trim_end() {
            "ready" => Ok(()),
            "" => Err(io::Error::other("the core ended before it listened")),
            why => Err(io::Error::other(why.to_owned())),
        }
    }

    /// A connection that said hello as this device; the bytes read so far hold the core's
    /// answer, `welcome` or `refuse`, whole, and possibly more.
    pub fn connect(&self, role: Role, client: &str) -> io::Result<(Stream, Vec<u8>)> {
        let (mut stream, gate) = self.enter()?;
        let hello = Hello {
            v: Versions(VERSION, VERSION),
            role,
            client: client.into(),
            auth: Some(Auth::Device {
                device: self.device,
                key: self.key.clone(),
                register: Some(Register { name: crate::NAME.into() }),
            }),
            abilities: Vec::new(),
        };
        let mut bytes = Vec::new();
        encode_control(&Control::Hello(hello), &mut bytes).map_err(io::Error::other)?;
        stream.write_all(&bytes)?;
        let mut got = Vec::new();
        let mut buf = [0u8; 16 << 10];
        while got.len() < 4 || got.len() < 4 + u32::from_le_bytes(got[..4].try_into().unwrap()) as usize {
            let n = stream.read(&mut buf)?;
            if n == 0 {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            got.extend_from_slice(&buf[..n]);
        }
        drop(gate);
        Ok((stream, got))
    }
}

type Waiter = Box<dyn FnOnce(Outcome) + Send>;

/// The host's own connection: `glance`, the folders the person opened, the capture key, and calls.
pub struct Link {
    /// Every project's folder, as the core has them: what `host.open` may open is inside one.
    pub folders: Mutex<Vec<(tasktap_proto::ProjectId, PathBuf)>>,
    /// The `capture_key` preference as stored; none while it is unset.
    capture: Mutex<Option<Shortcut>>,
    writer: Mutex<Option<Stream>>,
    waiting: Mutex<HashMap<u32, Waiter>>,
    next: Mutex<u32>,
}

impl Link {
    /// Connects, retires a running core of another build that has no terminals so this app's
    /// core starts instead, and from then on hands every `glance` to `glance`, and the capture key
    /// the preferences name to `capture`: once the records have arrived, and whenever it changes.
    /// The connection is made again whenever it ends.
    pub fn start(
        core: Arc<Core>,
        glance: impl Fn(Glance) + Send + 'static,
        capture: impl Fn(Option<Shortcut>) + Send + 'static,
    ) -> io::Result<Arc<Link>> {
        let link = Arc::new(Link {
            folders: Mutex::default(),
            capture: Mutex::default(),
            writer: Mutex::new(None),
            waiting: Mutex::default(),
            next: Mutex::new(1),
        });
        let mut decoder = Decoder::new();
        let mut stream = Self::open(&core, &link, &mut decoder)?;
        let me = link.clone();
        std::thread::spawn(move || loop {
            me.read(&mut stream, &mut decoder, &glance, &capture);
            me.writer.lock().unwrap().take();
            for (_, waiter) in me.waiting.lock().unwrap().drain() {
                waiter(Outcome::Err(tasktap_proto::Error::new(tasktap_proto::Code::Gone, "the core went away")));
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
            decoder = Decoder::new();
            match Self::open(&core, &me, &mut decoder) {
                Ok(s) => stream = s,
                Err(e) => eprintln!("tasktap-app: cannot reach the core: {e}"),
            }
        });
        Ok(link)
    }

    fn open(core: &Core, link: &Arc<Link>, decoder: &mut Decoder) -> io::Result<Stream> {
        let mut retired = false;
        loop {
            // A retired core may still accept a connection while it exits; it ends that one
            // unanswered, so for a second after retiring a failed hello is tried again.
            let mut attempts = 0;
            let (stream, first) = loop {
                match core.connect(Role::Host, "tasktap-app host") {
                    Ok(connected) => break connected,
                    Err(_) if retired && attempts < 20 => {
                        attempts += 1;
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    Err(e) => return Err(e),
                }
            };
            decoder.push(&first);
            let welcome: Welcome = match decoder.next_frame().map_err(io::Error::other)? {
                Some(Frame::Control(Control::Welcome(w))) => w,
                other => return Err(io::Error::other(format!("the core refused: {other:?}"))),
            };
            *link.writer.lock().unwrap() = Some(stream.try_clone()?);
            // A snapshot holds only the preferences that are stored.
            *link.capture.lock().unwrap() = None;
            if welcome.build == core.build || retired {
                link.call("sub", json!({"collections": WATCHED}), |_| {});
                return Ok(stream);
            }
            // Design §3: an older core with no terminals retires; one with terminals stays in use.
            let mut reader = stream.try_clone()?;
            let status = link.wait(&mut reader, decoder, "core.status", json!({}))?;
            if status.get("terminals").and_then(Value::as_u64) != Some(0) {
                link.call("sub", json!({"collections": WATCHED}), |_| {});
                return Ok(stream);
            }
            let _ = link.wait(&mut reader, decoder, "core.retire", json!({"when": "now"}));
            retired = true;
            *decoder = Decoder::new();
            let mut rest = Vec::new();
            let _ = reader.read_to_end(&mut rest);
        }
    }

    /// A call answered on this thread, before the reader runs.
    fn wait(&self, stream: &mut Stream, decoder: &mut Decoder, name: &str, args: Value) -> io::Result<Value> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.call(name, args, move |o| {
            let _ = tx.send(o);
        });
        let mut buf = [0u8; 16 << 10];
        loop {
            while let Some(frame) = decoder.next_frame().map_err(io::Error::other)? {
                if let Frame::Control(Control::Reply(r)) = frame {
                    if let Some(w) = self.waiting.lock().unwrap().remove(&r.id.0) {
                        w(r.outcome)
                    }
                }
            }
            if let Ok(outcome) = rx.try_recv() {
                return match outcome {
                    Outcome::Ok(v) => Ok(v),
                    Outcome::Err(e) => Err(io::Error::other(e.message)),
                };
            }
            match stream.read(&mut buf)? {
                0 => return Err(io::ErrorKind::UnexpectedEof.into()),
                n => decoder.push(&buf[..n]),
            }
        }
    }

    fn read(
        &self,
        stream: &mut Stream,
        decoder: &mut Decoder,
        glance: &impl Fn(Glance),
        capture: &impl Fn(Option<Shortcut>),
    ) {
        let mut buf = vec![0u8; 64 << 10];
        loop {
            loop {
                match decoder.next_frame() {
                    Ok(Some(Frame::Control(Control::Reply(r)))) => {
                        if let Some(w) = self.waiting.lock().unwrap().remove(&r.id.0) {
                            w(r.outcome)
                        }
                    }
                    Ok(Some(Frame::Control(Control::Change(c)))) => {
                        // The key is known once a snapshot is whole, stored or not, and anew when its row changes.
                        let mut key = c.snap && !c.more;
                        for set in c.sets {
                            match set {
                                Set::Prefs(rows) => {
                                    let mut stored = self.capture.lock().unwrap();
                                    if rows.del.contains(&PrefKey::CaptureKey) {
                                        (*stored, key) = (None, true);
                                    }
                                    for pref in rows.put {
                                        if let PrefValue::CaptureKey(now) = pref.value {
                                            (*stored, key) = (now, true);
                                        }
                                    }
                                }
                                Set::Glance { put } => put.into_iter().for_each(glance),
                                Set::Projects(rows) => {
                                    let mut folders = self.folders.lock().unwrap();
                                    folders.retain(|(id, _)| {
                                        !rows.del.contains(id) && rows.put.iter().all(|p| p.id != *id)
                                    });
                                    folders.extend(rows.put.into_iter().map(|p| (p.id, p.folder.into())));
                                }
                                _ => {}
                            }
                        }
                        if key {
                            capture(self.capture.lock().unwrap().clone());
                        }
                    }
                    Ok(Some(_)) => {}
                    Ok(None) => break,
                    Err(_) => return,
                }
            }
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => decoder.push(&buf[..n]),
            }
        }
    }

    /// Sends a call; `then` gets its outcome on the reader's thread.
    pub fn call(&self, name: &str, args: Value, then: impl FnOnce(Outcome) + Send + 'static) {
        let id = {
            let mut next = self.next.lock().unwrap();
            *next = next.wrapping_add(1).max(1);
            *next
        };
        let request = Control::Call(Request { id: CallId(id), name: name.into(), args });
        let mut bytes = Vec::new();
        self.waiting.lock().unwrap().insert(id, Box::new(then));
        let sent = encode_control(&request, &mut bytes).is_ok()
            && self.writer.lock().unwrap().as_mut().is_some_and(|w| w.write_all(&bytes).is_ok());
        if let Some(then) = (!sent).then(|| self.waiting.lock().unwrap().remove(&id)).flatten() {
            then(Outcome::Err(tasktap_proto::Error::new(tasktap_proto::Code::Gone, "no core connection")))
        }
    }
}
