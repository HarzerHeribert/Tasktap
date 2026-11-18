//! Speech on this machine (design §8, "On this device"): the model's file and its download, and the helper that turns
//! a recording into text. The page records, as it does for a speech service, and hands the samples here; this file
//! starts `tasktap-speech` (host/speech/engine.cpp) for that one dictation, writes the samples to its input and
//! passes its lines back to the page, which reports them to the core. Nothing is started before a dictation and
//! nothing is left after it: no process, no model in memory, no timer.
//!
//! The model is fetched only when the person asks for it in Settings, by the system's `curl` from the address
//! whisper.cpp's own download script uses, continued where an earlier attempt stopped, checked against its SHA-256
//! before it gets its name, and kept in `<data>/models/`. Local speech never uses the network after that.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::{Channel, InvokeBody};
use tauri::{AppHandle, Emitter};

/// Where a model comes from and what it must be.
pub struct Source {
    pub url: String,
    pub sha256: String,
    pub bytes: u64,
}

/// Whisper large-v3 turbo, quantised to 5 bits (q5_0), in whisper.cpp's format: the default on every Mac, since it
/// is the smallest download of the model that the trial found accurate in German, English and both mixed
/// (design §8). From the repository whisper.cpp's `models/download-ggml-model.sh` fetches from, at a fixed revision.
const NAME: &str = "ggml-large-v3-turbo-q5_0.bin";
const URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin";
const SHA256: &str = "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2";
const BYTES: u64 = 574_041_195;

pub struct Speech {
    /// The helper, next to the host's own program.
    exe: PathBuf,
    /// Where the model is kept.
    folder: PathBuf,
    /// A model that is already somewhere, which a check names, in place of one fetched.
    given: Option<PathBuf>,
    source: Source,
    now: Mutex<Now>,
}

#[derive(Default)]
struct Now {
    /// The model is being fetched or checked; `curl`, while it runs; and how much of the model is here.
    busy: bool,
    fetching: Option<Child>,
    have: u64,
    /// The person stopped the download: its end is not a failure.
    stopped: bool,
    failed: Option<String>,
    /// The dictation that records, and its helper's input.
    feeding: Option<(String, ChildStdin)>,
    /// Every helper that runs, by its dictation: the one fed, and those still writing down.
    engines: HashMap<String, Arc<Mutex<Child>>>,
}

fn told(code: Option<i32>) -> String {
    match code {
        Some(6 | 7) => {
            "No network: the model could not be fetched. What arrived is kept; try again when you are online.".into()
        }
        Some(28) => "The download stalled. What arrived is kept; try again.".into(),
        Some(22) => "The model's source refused the download. Try again later.".into(),
        Some(23) => "The model could not be written: the disk may be full.".into(),
        Some(n) => format!("The download failed (curl {n}). What arrived is kept; try again."),
        None => "The download was interrupted. What arrived is kept; try again.".into(),
    }
}

impl Speech {
    pub fn new(exe: PathBuf, folder: PathBuf, given: Option<PathBuf>, source: Source) -> Arc<Self> {
        Arc::new(Self { exe, folder, given, source, now: Mutex::default() })
    }

    fn file(&self) -> PathBuf {
        self.folder.join(NAME)
    }
    fn part(&self) -> PathBuf {
        self.folder.join(format!("{NAME}.part"))
    }
    /// The model, when it is here whole: a file gets its name only once its checksum matched.
    fn model(&self) -> Option<PathBuf> {
        if let Some(given) = self.given.as_ref().filter(|p| p.is_file()) {
            return Some(given.clone());
        }
        let file = self.file();
        (fs::metadata(&file).ok()?.len() == self.source.bytes).then_some(file)
    }

    /// What Settings shows: whether this system has the helper, and where the model stands.
    pub fn status(&self) -> Value {
        let now = self.now.lock().unwrap();
        let ready = self.model().is_some();
        let model = if ready {
            "ready"
        } else if now.busy {
            "fetching"
        } else if now.failed.is_some() {
            "failed"
        } else {
            "none"
        };
        let have = match model {
            "ready" => self.source.bytes,
            "fetching" => now.have,
            _ => fs::metadata(self.part()).map_or(0, |m| m.len()),
        };
        json!({"supported": self.exe.is_file(), "model": model, "have": have, "of": self.source.bytes, "error": now.failed})
    }

    /// Fetches the model, from where an earlier attempt stopped; `notify` gets the status as it changes, at most
    /// two hundred times on the way and once at the end.
    pub fn install(self: &Arc<Self>, notify: impl Fn(Value) + Send + 'static) -> Result<(), String> {
        let mut now = self.now.lock().unwrap();
        if now.busy || self.model().is_some() {
            return Ok(());
        }
        fs::create_dir_all(&self.folder).map_err(|e| format!("The folder for the model could not be made: {e}"))?;
        let _ = fs::remove_file(self.file());
        let mut have = fs::metadata(self.part()).map_or(0, |m| m.len());
        if have > self.source.bytes {
            let _ = fs::remove_file(self.part());
            have = 0;
        }
        // With everything here already only the check is left.
        let out = if have < self.source.bytes {
            let mut curl = Command::new("curl")
                .args([
                    "-q",
                    "-fsSL",
                    "--speed-limit",
                    "1024",
                    "--speed-time",
                    "60",
                    "-C",
                    &have.to_string(),
                    "-o",
                    "-",
                    &self.source.url,
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| "This system has no curl, which Tasktap downloads with.".to_owned())?;
            let out = curl.stdout.take();
            now.fetching = Some(curl);
            out
        } else {
            None
        };
        (now.busy, now.have, now.stopped, now.failed) = (true, have, false, None);
        drop(now);
        let me = self.clone();
        std::thread::spawn(move || {
            let outcome = me.fetch(out, have, &notify);
            let mut now = me.now.lock().unwrap();
            (now.busy, now.fetching) = (false, None);
            now.failed = if std::mem::take(&mut now.stopped) { None } else { outcome.err() };
            drop(now);
            notify(me.status());
        });
        Ok(())
    }

    fn fetch(&self, mut out: Option<ChildStdout>, mut have: u64, notify: &dyn Fn(Value)) -> Result<(), String> {
        let write = |e: std::io::Error| format!("The model could not be written: {e}");
        let mut part = fs::OpenOptions::new().create(true).append(true).open(self.part()).map_err(write)?;
        let (mut buf, step) = (vec![0u8; 256 << 10], (self.source.bytes / 200).max(1));
        notify(self.status());
        while let Some(Ok(n @ 1..)) = out.as_mut().map(|o| o.read(&mut buf)) {
            part.write_all(&buf[..n]).map_err(write)?;
            let before = have / step;
            have += n as u64;
            self.now.lock().unwrap().have = have;
            if have / step != before {
                notify(self.status());
            }
        }
        drop(part);
        if let Some(mut curl) = self.now.lock().unwrap().fetching.take() {
            let code = curl.wait().ok().and_then(|s| s.code());
            // 33: the source cannot continue a download; it starts over the next time.
            if code == Some(33) {
                let _ = fs::remove_file(self.part());
            }
            if code != Some(0) {
                return Err(told(code));
            }
        }
        if have != self.source.bytes {
            let _ = fs::remove_file(self.part());
            return Err(
                "The model that arrived is not the size it should be. It was removed; download it again.".into()
            );
        }
        let sum = Command::new("shasum")
            .args(["-a", "256"])
            .arg(self.part())
            .output()
            .map_err(|e| format!("The model could not be checked: {e}"))?;
        if String::from_utf8_lossy(&sum.stdout).split_whitespace().next() != Some(self.source.sha256.as_str()) {
            let _ = fs::remove_file(self.part());
            return Err(
                "The model that arrived is damaged: its checksum does not match. It was removed; download it again."
                    .into(),
            );
        }
        fs::rename(self.part(), self.file()).map_err(write)
    }

    /// Stops a download; what arrived is kept for the next attempt.
    pub fn stop(&self) {
        let mut now = self.now.lock().unwrap();
        now.stopped = now.busy;
        if let Some(curl) = now.fetching.as_mut() {
            let _ = curl.kill();
        }
    }

    /// Removes the model and whatever part of it was fetched. Not while it is in use.
    pub fn remove(&self) -> Result<(), String> {
        self.stop();
        let mut now = self.now.lock().unwrap();
        if !now.engines.is_empty() {
            return Err("The model is in use: a dictation is being written down.".into());
        }
        now.failed = None;
        let _ = fs::remove_file(self.part());
        match fs::remove_file(self.file()) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("The model could not be removed: {e}")),
            _ => Ok(()),
        }
    }

    /// Starts the helper for the dictation `id`; `on` gets each line it prints, and `{"error": "engine"}` when it ends
    /// without a transcript. `Err("model")` when there is no model, `Err("engine")` when the helper does not start.
    pub fn listen(
        self: &Arc<Self>,
        id: &str,
        languages: &[String],
        on: impl Fn(Value) + Send + 'static,
    ) -> Result<(), String> {
        let model = self.model().ok_or("model")?;
        let languages = languages
            .iter()
            .filter(|l| (2..=10).contains(&l.len()) && l.bytes().all(|b| b.is_ascii_alphabetic() || b == b'-'))
            .take(4);
        let mut child = Command::new(&self.exe)
            .arg(model)
            .args(languages)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "engine")?;
        let (input, out) = (child.stdin.take().expect("piped"), child.stdout.take().expect("piped"));
        let child = Arc::new(Mutex::new(child));
        let mut now = self.now.lock().unwrap();
        // One records at a time: an earlier one that was never ended is ended now.
        if let Some((old, _)) = now.feeding.replace((id.to_owned(), input)) {
            if let Some(engine) = now.engines.remove(&old) {
                let _ = engine.lock().unwrap().kill();
            }
        }
        now.engines.insert(id.to_owned(), child.clone());
        drop(now);
        let (me, id) = (self.clone(), id.to_owned());
        std::thread::spawn(move || {
            let mut ended = false;
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let Ok(said) = serde_json::from_str::<Value>(&line) else { continue };
                ended |= said.get("final").is_some() || said.get("error").is_some();
                // A model the helper cannot read is damaged: it is removed, so Settings offers it again.
                if said["error"] == "model" && me.given.is_none() {
                    let _ = fs::remove_file(me.file());
                }
                on(said);
            }
            let _ = child.lock().unwrap().wait();
            let mut now = me.now.lock().unwrap();
            if now.engines.get(&id).is_some_and(|e| Arc::ptr_eq(e, &child)) {
                now.engines.remove(&id);
                if now.feeding.as_ref().is_some_and(|(of, _)| *of == id) {
                    now.feeding = None;
                }
            }
            drop(now);
            if !ended {
                on(json!({"error": "engine"}));
            }
        });
        Ok(())
    }

    /// Samples for the dictation that records: 16 kHz, one channel, signed 16-bit little-endian.
    pub fn audio(&self, bytes: &[u8]) -> Result<(), String> {
        let mut now = self.now.lock().unwrap();
        let (_, input) = now.feeding.as_mut().ok_or("no dictation records")?;
        input.write_all(bytes).map_err(|e| e.to_string())
    }

    /// The person let go: the helper's input ends and it writes down what is left. With `cancel` it is ended now.
    pub fn end(&self, id: &str, cancel: bool) {
        let mut now = self.now.lock().unwrap();
        if now.feeding.as_ref().is_some_and(|(of, _)| of == id) {
            now.feeding = None;
        }
        if cancel {
            if let Some(engine) = now.engines.remove(id) {
                let _ = engine.lock().unwrap().kill();
            }
        }
    }
}

/// The app's own: the helper beside the host's program and the model in the data folder, unless a check names
/// others (`TASKTAP_SPEECH_EXE`, `TASKTAP_SPEECH_MODEL`, and `TASKTAP_SPEECH_SOURCE` as "url sha256 bytes").
fn speech() -> &'static Arc<Speech> {
    static SPEECH: OnceLock<Arc<Speech>> = OnceLock::new();
    SPEECH.get_or_init(|| {
        let exe = std::env::var_os("TASKTAP_SPEECH_EXE")
            .map(PathBuf::from)
            .or_else(|| Some(std::env::current_exe().ok()?.with_file_name("tasktap-speech")));
        let source = std::env::var("TASKTAP_SPEECH_SOURCE").ok().and_then(|s| {
            let mut s = s.split_whitespace().map(str::to_owned);
            Some(Source { url: s.next()?, sha256: s.next()?, bytes: s.next()?.parse().ok()? })
        });
        Speech::new(
            exe.unwrap_or_default(),
            crate::data_folder().join("models"),
            std::env::var_os("TASKTAP_SPEECH_MODEL").map(PathBuf::from),
            source.unwrap_or(Source { url: URL.into(), sha256: SHA256.into(), bytes: BYTES }),
        )
    })
}

/// Settings asks where local speech stands, or for the model to be fetched (`install`), the download stopped
/// (`stop`) or the model removed (`remove`). The answer is the status; while a download runs every page hears it
/// again as the event `speech`.
#[tauri::command]
pub fn speech_model(app: AppHandle, act: Option<String>) -> Result<Value, String> {
    let speech = speech();
    match act.as_deref() {
        Some("install") => speech.install(move |status| drop(app.emit("speech", status)))?,
        Some("stop") => speech.stop(),
        Some("remove") => speech.remove()?,
        _ => {}
    }
    Ok(speech.status())
}

/// A page begins a dictation it transcribes here: the helper starts, and its lines arrive on `heard`.
#[tauri::command]
pub fn speech_listen(id: String, languages: Vec<String>, heard: Channel<Value>) -> Result<(), String> {
    speech().listen(&id, &languages, move |said| drop(heard.send(said)))
}

/// What the page recorded since the last call.
#[tauri::command]
pub fn speech_audio(request: tauri::ipc::Request) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err("samples travel as bytes".into()) };
    speech().audio(bytes)
}

/// The recording is over, or with `cancel` the whole dictation is.
#[tauri::command]
pub fn speech_end(id: String, cancel: bool) {
    speech().end(&id, cancel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};
    use std::os::unix::fs::PermissionsExt;
    use std::sync::mpsc;
    use std::time::Duration;

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tasktap-speech-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn sha256(bytes: &[u8], dir: &std::path::Path) -> String {
        fs::write(dir.join("sum"), bytes).unwrap();
        let out = Command::new("shasum").args(["-a", "256"]).arg(dir.join("sum")).output().unwrap();
        String::from_utf8_lossy(&out.stdout).split_whitespace().next().unwrap().to_owned()
    }

    /// A source of the test's own on this machine. It serves `body` and honours `Range`; the first `cut` requests
    /// each end after a third of what they were asked for, as a connection that drops does. Returns its address and
    /// the ranges it was asked for.
    fn source(body: Vec<u8>, cut: usize) -> (String, mpsc::Receiver<u64>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/model.bin", listener.local_addr().unwrap());
        let (asked, ranges) = mpsc::channel();
        std::thread::spawn(move || {
            for (n, stream) in listener.incoming().enumerate() {
                let Ok(mut stream): Result<TcpStream, _> = stream else { break };
                let mut head = String::new();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut from = 0u64;
                while reader.read_line(&mut head).is_ok_and(|n| n > 2) {
                    if let Some(range) = head.to_ascii_lowercase().strip_prefix("range: bytes=") {
                        from = range.trim().trim_end_matches('-').parse().unwrap_or(0);
                    }
                    head.clear();
                }
                let _ = asked.send(from);
                let rest = &body[(from as usize).min(body.len())..];
                let status = if from > 0 { "206 Partial Content" } else { "200 OK" };
                let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Range: bytes {from}-{}/{}\r\nConnection: close\r\n\r\n", rest.len(), body.len() - 1, body.len());
                let _ = stream.write_all(if n < cut { &rest[..rest.len() / 3] } else { rest });
            }
        });
        (url, ranges)
    }

    /// Fetches until the download ends, and returns every status on the way.
    fn fetched(speech: &Arc<Speech>) -> Vec<Value> {
        let (tell, told) = mpsc::channel();
        speech.install(move |s| drop(tell.send(s))).unwrap();
        let mut all = Vec::new();
        while let Ok(status) = told.recv_timeout(Duration::from_secs(20)) {
            let done = status["model"] != "fetching";
            all.push(status);
            if done {
                break;
            }
        }
        all
    }

    #[test]
    fn the_model_is_fetched_with_progress_continued_checked_and_removed() {
        let dir = folder("fetch");
        let body: Vec<u8> = (0..3_000_000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 24) as u8).collect();
        let sum = sha256(&body, &dir);
        // The connection drops once: a third arrives and is kept.
        let (url, ranges) = source(body.clone(), 1);
        let speech = Speech::new(
            "/nowhere".into(),
            dir.join("models"),
            None,
            Source { url, sha256: sum.clone(), bytes: body.len() as u64 },
        );
        assert_eq!(speech.status()["model"], "none");
        let first = fetched(&speech);
        let last = first.last().unwrap();
        assert_eq!(last["model"], "failed", "{last}");
        assert_eq!(last["have"], 1_000_000, "what arrived is kept: {last}");
        assert!(last["error"].as_str().unwrap().contains("try again"), "{last}");
        assert!(
            first.iter().any(|s| s["model"] == "fetching" && s["have"].as_u64() > Some(0)),
            "progress on the way: {first:?}"
        );
        // The next attempt asks for the rest only, and the whole is checked before it gets its name.
        let second = fetched(&speech);
        assert_eq!(ranges.try_iter().collect::<Vec<_>>(), [0, 1_000_000]);
        assert!(second.windows(2).all(|w| w[0]["have"].as_u64() <= w[1]["have"].as_u64()), "{second:?}");
        assert!(second.len() > 5, "progress is reported on the way: {} statuses", second.len());
        let last = second.last().unwrap();
        assert_eq!(
            (last["model"].as_str(), last["have"].as_u64(), last["error"].is_null()),
            (Some("ready"), Some(3_000_000), true),
            "{last}"
        );
        assert_eq!(fs::read(dir.join("models").join(NAME)).unwrap(), body);
        assert!(!speech.part().exists());
        // Removed: nothing of it is left.
        speech.remove().unwrap();
        assert_eq!(speech.status()["model"], "none");
        assert_eq!(fs::read_dir(dir.join("models")).unwrap().count(), 0);

        // A model that arrives damaged never gets its name, and is not kept.
        let (url, _) = source(body.iter().map(|b| b ^ 1).collect(), 0);
        let speech = Speech::new(
            "/nowhere".into(),
            dir.join("damaged"),
            None,
            Source { url, sha256: sum, bytes: body.len() as u64 },
        );
        let last = fetched(&speech).pop().unwrap();
        assert_eq!(last["model"], "failed");
        assert!(last["error"].as_str().unwrap().contains("checksum does not match"), "{last}");
        assert_eq!(fs::read_dir(dir.join("damaged")).unwrap().count(), 0);

        // No source at all: said in plain words, and the download can be stopped without a failure.
        let speech = Speech::new(
            "/nowhere".into(),
            dir.join("offline"),
            None,
            Source { url: "http://127.0.0.1:9/model.bin".into(), sha256: String::new(), bytes: 10 },
        );
        let last = fetched(&speech).pop().unwrap();
        assert!(last["error"].as_str().unwrap().starts_with("No network"), "{last}");
        let _ = fs::remove_dir_all(dir);
    }

    /// A helper of the test's own: it says it is ready, reads the recording to its end and answers with how many
    /// bytes it got and their checksum, or fails the way `how` says.
    fn engine(dir: &std::path::Path, how: &str) -> PathBuf {
        let exe = dir.join(format!("engine-{how}"));
        let script = match how {
            "works" => "#!/bin/sh\necho '{\"ready\":true}'\necho \"{\\\"partial\\\":\\\"$*\\\"}\"\nsum=$(cksum)\necho \"{\\\"final\\\":\\\"$sum\\\"}\"\n",
            "dies" => "#!/bin/sh\necho '{\"ready\":true}'\ncat > /dev/null\nexit 4\n",
            _ => "#!/bin/sh\necho '{\"error\":\"model\"}'\nexit 3\n",
        };
        fs::write(&exe, script).unwrap();
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
        exe
    }
    fn lines(speech: &Arc<Speech>, id: &str, languages: &[&str]) -> mpsc::Receiver<Value> {
        let (tell, told) = mpsc::channel();
        let languages: Vec<String> = languages.iter().map(|l| (*l).to_owned()).collect();
        speech.listen(id, &languages, move |said| drop(tell.send(said))).unwrap();
        told
    }
    fn next(told: &mpsc::Receiver<Value>) -> Value {
        told.recv_timeout(Duration::from_secs(10)).expect("the helper says something")
    }

    #[test]
    fn a_recording_reaches_the_helper_intact_and_its_lines_come_back() {
        let dir = folder("listen");
        let model = dir.join("model.bin");
        fs::write(&model, b"model").unwrap();
        let none = || Source { url: String::new(), sha256: String::new(), bytes: 0 };
        // Three seconds of a 440 Hz tone, as the page hands it over: a tenth of a second at a time.
        let signal: Vec<u8> = (0..48_000)
            .flat_map(|i| {
                (((f64::from(i) * 440.0 * std::f64::consts::TAU / 16_000.0).sin() * 16_383.0).round() as i16)
                    .to_le_bytes()
            })
            .collect();
        fs::write(dir.join("signal"), &signal).unwrap();
        let expected = Command::new("cksum").arg(dir.join("signal")).output().unwrap();
        let expected =
            String::from_utf8_lossy(&expected.stdout).split_whitespace().take(2).collect::<Vec<_>>().join(" ");

        let speech = Speech::new(engine(&dir, "works"), dir.join("models"), Some(model.clone()), none());
        assert_eq!(
            (speech.status()["supported"].as_bool(), speech.status()["model"].as_str()),
            (Some(true), Some("ready"))
        );
        // Only what is a language is passed on, four at most.
        let told = lines(&speech, "one", &["de", "en-GB", "; rm -rf", "x", "fr", "it", "nl"]);
        assert_eq!(next(&told), json!({"ready": true}));
        assert_eq!(next(&told), json!({"partial": format!("{} de en-GB fr it", model.display())}));
        for chunk in signal.chunks(3200) {
            speech.audio(chunk).unwrap();
        }
        speech.end("one", false);
        assert_eq!(next(&told), json!({"final": expected}), "every byte, in order");
        assert!(speech.audio(&[0, 0]).is_err(), "nothing records after the end");
        std::thread::sleep(Duration::from_millis(200));
        assert!(speech.now.lock().unwrap().engines.is_empty(), "no helper is left");

        // Cancelled while it records: the helper is ended, and no transcript arrives.
        let told = lines(&speech, "two", &[]);
        assert_eq!(next(&told), json!({"ready": true}));
        next(&told);
        speech.audio(&signal[..3200]).unwrap();
        speech.end("two", true);
        assert_eq!(next(&told), json!({"error": "engine"}));
        // A helper that dies, and one that cannot read its model, are told apart.
        let speech = Speech::new(engine(&dir, "dies"), dir.join("models"), Some(model.clone()), none());
        let told = lines(&speech, "three", &[]);
        assert_eq!(next(&told), json!({"ready": true}));
        speech.end("three", false);
        assert_eq!(next(&told), json!({"error": "engine"}));
        let speech = Speech::new(engine(&dir, "unreadable"), dir.join("models"), Some(model.clone()), none());
        assert_eq!(next(&lines(&speech, "four", &[])), json!({"error": "model"}));
        // No model, and no helper: each refused before anything starts.
        let speech = Speech::new(engine(&dir, "works"), dir.join("models"), None, none());
        assert_eq!(speech.listen("five", &[], |_| {}).unwrap_err(), "model");
        let speech = Speech::new(dir.join("missing"), dir.join("models"), Some(model), none());
        assert_eq!(speech.status()["supported"], false);
        assert_eq!(speech.listen("six", &[], |_| {}).unwrap_err(), "engine");
        let _ = fs::remove_dir_all(dir);
    }
}
