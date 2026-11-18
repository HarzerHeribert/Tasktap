//! Speech (design §8, "Speech"): dictations, from the recorder's call to
//! the thought they become or the words they leave for a field. The rules are `state::dictate`;
//! this module moves things between them and the world, as `effects.rs`
//! does for the stored records: the audio arriving on a stream and its
//! level, the one deadline of a dictation, the call to the speech service
//! on a thread of its own, the delivery, and the keys of servers.
//!
//! A speech service is any server that speaks the OpenAI transcription
//! endpoint. Nothing is sent to one the person did not consent to (the
//! `speech_by` preference), and a key only ever goes to the server it was
//! stored for.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::rc::{Rc, Weak};
use std::sync::{Arc, mpsc};
use std::time::Duration;

use serde_json::Value;
use tasktap_proto::call::{self, Call, Code, Error};
use tasktap_proto::{
    CloseWhy, Control, DictationId, DictationPhase, DictationTarget, Empty, Listening, MAX_CREDIT,
    MAX_TEXT, PrefKey, PrefValue, Ref, ReportDictation, Server, SetKey, Source, SpeechBy,
    SpeechTerms, StartDictation, json_len,
};
use tokio::task::AbortHandle;

use crate::calls::Cx;
use crate::command::Signal;
use crate::conn::Link;
use crate::effects::{self, Refusal};
use crate::http;
use crate::secrets::{self, Vault};
use crate::serve::Core;
use crate::state::{self, Dictating, Heard, RECORDING, Spoken};
use crate::stream::{self, Endpoint, Handle};

/// The audio of a dictation: 16 kHz, one channel, signed 16-bit
/// little-endian samples.
const RATE: u32 = 16_000;
const BYTES_A_SECOND: usize = RATE as usize * 2;
/// The most audio one dictation holds: the credit ever granted on its stream.
pub const CAP: usize = RECORDING as usize * BYTES_A_SECOND;
/// The audio a level is taken from: 100 ms. Less than this is no recording.
const WINDOW: usize = BYTES_A_SECOND / 10;
/// Whole windows a recording needs before a room can be told from a word.
const TELLING: u32 = 5;
/// The sum of the squares of a window's samples at -30 dBFS: no quiet
/// room is that strong, so a window that is counts as said.
const STRONG: u64 = 1_717_986_918;
/// A level of 0 is this many dBFS, and 100 is `FLOOR + SPAN` (as in 1.2).
const FLOOR: f32 = -55.0;
const SPAN: f32 = 49.0;
/// Seconds the call to a speech service takes at most.
const CALL: u32 = 90;
/// What is added to a server's address.
const PATH: &str = "/v1/audio/transcriptions";
/// Servers a key is stored for at most.
const KEYS: usize = 8;

/// The dictations, and what each holds outside its row.
pub struct Speech {
    all: Vec<Dictating>,
    live: HashMap<DictationId, Live>,
    vault: Arc<dyn Vault>,
    /// How long a second of a deadline, or of the call's limit, lasts:
    /// shorter only in a test.
    second: Duration,
}

struct Live {
    /// The connection that records: only it may finish the dictation.
    recorder: Weak<Link>,
    audio: Option<Rc<RefCell<Audio>>>,
    stream: Option<Handle>,
    deadline: Option<AbortHandle>,
    /// Ends the call to the speech service.
    stop: Option<mpsc::Sender<Signal>>,
}

impl Speech {
    pub fn new(second: Duration) -> Speech {
        Speech {
            all: Vec::new(),
            live: HashMap::new(),
            vault: secrets::vault(),
            second,
        }
    }

    /// Whether a dictation is under way, which would be lost with the core.
    pub fn busy(&self) -> bool {
        let under_way = [DictationPhase::Recording, DictationPhase::Transcribing];
        (self.all.iter()).any(|d| under_way.contains(&d.row.phase))
    }
}

/// What a stream brought so far.
#[derive(Default)]
struct Audio {
    pcm: Vec<u8>,
    /// Bytes of `pcm` whose samples were looked at; even.
    scanned: usize,
    /// Bytes looked at of the window being heard.
    heard: usize,
    /// The loudest sample of that window, and of every window before.
    window: u16,
    peak: u16,
    /// The sum of the squares of that window's samples, and the largest and
    /// the smallest such sum of the whole windows before it.
    energy: u64,
    strongest: u64,
    weakest: u64,
    /// Whole windows heard.
    windows: u32,
    level: u8,
    /// A change of the level waits to be published.
    told: bool,
    /// Credit granted on the stream in all; never over [`CAP`].
    granted: usize,
    /// The recording ended: what still arrives is dropped.
    ended: bool,
}

impl Audio {
    /// Keeps `bytes` and follows their level. Never more than [`CAP`]:
    /// the stream's credit is the bound, and the buffer grows by doubling
    /// up to it and no further.
    fn take(&mut self, bytes: &[u8]) {
        let bytes = &bytes[..bytes.len().min(CAP - self.pcm.len())];
        if self.ended || bytes.is_empty() {
            return;
        }
        if self.pcm.capacity() - self.pcm.len() < bytes.len() {
            let more = self.pcm.len().max(64 << 10).max(bytes.len());
            self.pcm.reserve_exact(more.min(CAP - self.pcm.len()));
        }
        self.pcm.extend_from_slice(bytes);
        while self.pcm.len() - self.scanned >= 2 {
            let whole = self.pcm.len() & !1;
            let end = (self.scanned + WINDOW - self.heard).min(whole);
            for sample in self.pcm[self.scanned..end].as_chunks::<2>().0 {
                let loud = i16::from_le_bytes(*sample).unsigned_abs();
                self.window = self.window.max(loud);
                self.energy += u64::from(loud) * u64::from(loud);
            }
            self.heard += end - self.scanned;
            self.scanned = end;
            if self.heard == WINDOW {
                self.level = level(self.window);
                self.peak = self.peak.max(self.window);
                self.strongest = self.strongest.max(self.energy);
                self.weakest = match self.windows {
                    0 => self.energy,
                    _ => self.weakest.min(self.energy),
                };
                self.windows += 1;
                (self.window, self.heard, self.energy) = (0, 0, 0);
            }
        }
    }

    /// Whether there is anything to transcribe (design §8, "Nothing was
    /// said"). Not when there is less than one window of audio, or none of
    /// it above the floor: a microphone that is muted or refused gives
    /// zeros. And not when a recording long enough to tell is as even as an
    /// empty room is: no window twice as strong (3 dB) as its weakest, and
    /// none strong in itself. Anything else is sent: a word no louder
    /// than the room's own noise still stands out of its weakest window.
    fn heard(&self) -> bool {
        if self.pcm.len() < WINDOW || level(self.peak.max(self.window)) == 0 {
            return false;
        }
        let even = self.strongest < self.weakest.saturating_mul(2);
        self.windows < TELLING || !even || self.strongest >= STRONG
    }
}

/// A sample's loudness from 0 to 100.
fn level(peak: u16) -> u8 {
    if peak == 0 {
        return 0;
    }
    let db = 20.0 * (f32::from(peak) / 32768.0).log10();
    (((db - FLOOR) / SPAN).clamp(0.0, 1.0) * 100.0).round() as u8
}

/// The core's end of a dictation's stream.
struct Ear {
    id: DictationId,
    audio: Rc<RefCell<Audio>>,
    handle: Handle,
    core: Weak<RefCell<Core>>,
}

impl Endpoint for Ear {
    fn write(&mut self, bytes: &[u8]) {
        let mut audio = self.audio.borrow_mut();
        let before = audio.level;
        audio.take(bytes);
        // The credit used is granted again until the cap is granted in all.
        let more = bytes.len().min(CAP - audio.granted);
        if more > 0 {
            audio.granted += more;
            self.handle.grant(more as u32);
        }
        if audio.level != before && !audio.told {
            audio.told = true;
            // The connection holds the core while it hands over bytes.
            let (core, id) = (self.core.clone(), self.id);
            tokio::task::spawn_local(async move {
                if let Some(core) = core.upgrade() {
                    told(&mut core.borrow_mut(), id);
                }
            });
        }
    }
}

/// Publishes the level a dictation's stream is at.
fn told(core: &mut Core, id: DictationId) {
    let audio = core.speech.live.get(&id).and_then(|l| l.audio.clone());
    if let Some(audio) = audio {
        let level = {
            let mut audio = audio.borrow_mut();
            audio.told = false;
            audio.level
        };
        let _ = apply(core, Spoken::Level { id, level });
    }
}

/// Applies one event to the dictations and carries out what follows.
fn apply(core: &mut Core, event: Spoken) -> Result<(), state::Error> {
    let heard = state::dictate(&mut core.speech.all, event)?;
    for effect in heard {
        carry(core, effect);
    }
    Ok(())
}

fn carry(core: &mut Core, effect: Heard) {
    let row =
        |core: &Core, id| (core.speech.all.iter().find(|d| d.row.id == id)).map(|d| d.row.clone());
    match effect {
        // Memory only: a failure loses one change and nothing else.
        Heard::Put(id) => {
            let row = row(core, id);
            let _ = core.set_dictation(id, row);
        }
        Heard::Del(id) => {
            let _ = core.set_dictation(id, None);
        }
        Heard::Deadline { id, seconds } => {
            let (me, wait) = (core.me.clone(), core.speech.second * seconds);
            let task = tokio::task::spawn_local(async move {
                tokio::time::sleep(wait).await;
                if let Some(core) = me.upgrade() {
                    let _ = apply(&mut core.borrow_mut(), Spoken::Deadline { id });
                }
            });
            let before = (core.speech.live.get_mut(&id))
                .and_then(|live| live.deadline.replace(task.abort_handle()));
            if let Some(before) = before {
                before.abort();
            }
        }
        Heard::End(id) => {
            let phase = row(core, id).map(|row| row.phase);
            let finished = phase == Some(DictationPhase::Transcribing);
            if let Some(live) = core.speech.live.get_mut(&id) {
                if let Some(deadline) = live.deadline.take() {
                    deadline.abort();
                }
                if let Some(stream) = live.stream.take() {
                    // `gone` is how a recorder learns to stop the microphone.
                    stream.close(match finished {
                        true => CloseWhy::Done,
                        false => CloseWhy::Gone,
                    });
                }
                if let Some(stop) = live.stop.take() {
                    let _ = stop.send(Signal::Stop);
                }
            }
            if !finished {
                core.speech.live.remove(&id);
            }
            // The last dictation may have kept the core alive.
            core.events.notify_one();
        }
        Heard::Transcribe(id) => transcribe(core, id),
        // The transcript is the thought's text: exactly the capture that
        // typing it would have been.
        Heard::Deliver { id, capture, text } => {
            let capture = tasktap_proto::Capture { text, ..*capture };
            let refused = (crate::calls::capture(core, capture).err()).map(|e| e.message);
            let _ = apply(core, Spoken::Delivered { id, refused });
        }
    }
}

/// Refuses a target typing could not have had, before anyone speaks.
fn fits(core: &mut Core, target: &DictationTarget) -> Result<(), Error> {
    match target {
        DictationTarget::Thought(capture) => {
            if capture.source != Source::Voice {
                let why = "the capture of a dictation has the source voice";
                return Err(Error::new(Code::Invalid, why));
            }
            // One mechanism for speech into a field that holds text: the
            // text target, whose words the page places itself.
            if !capture.text.is_empty() {
                let why = "a spoken thought's text is its transcript; \
                           speech into a field that holds text has the target text";
                return Err(Error::new(Code::Invalid, why));
            }
            crate::calls::check(core, capture)?;
            match effects::read(core, |tx| tx.thought(capture.id))? {
                Some(_) => Err(Error::new(Code::Conflict, "a thought with this id exists")),
                None => Ok(()),
            }
        }
        DictationTarget::Text => Ok(()),
    }
}

fn refused(name: &str, e: state::Error) -> Result<(), Error> {
    effects::refusal(name, Refusal::State(e)).map_or(Ok(()), Err)
}

/// `dictation.start`: the caller records. With a speech service consented
/// to, the reply carries the stream its samples go on.
pub fn start(cx: &mut Cx, args: StartDictation) -> Result<Listening, Error> {
    let StartDictation { id, target, local } = args;
    let service = service(cx.core)?;
    if service.is_none() && !local {
        let why = "No speech service is set up";
        return Err(Error::new(Code::Failed, why));
    }
    fits(cx.core, &target)?;
    if cx.core.speech.live.contains_key(&id) {
        return Err(Error::new(
            Code::Conflict,
            "a dictation with this id exists",
        ));
    }
    let stream = service.is_some();
    let audio = stream.then(Rc::<RefCell<Audio>>::default);
    let live = Live {
        recorder: Rc::downgrade(cx.link),
        audio: audio.clone(),
        stream: None,
        deadline: None,
        stop: None,
    };
    cx.core.speech.live.insert(id, live);
    if let Err(e) = apply(cx.core, Spoken::Start { id, target, stream }) {
        cx.core.speech.live.remove(&id);
        let conflict = || Error::new(Code::Conflict, "the dictation could not start");
        return Err(refused("dictation.start", e).err().unwrap_or_else(conflict));
    }
    let mut opened = None;
    if let Some(audio) = audio {
        let first = CAP.min(MAX_CREDIT as usize);
        audio.borrow_mut().granted = first;
        let me = cx.core.me.clone();
        let mut held = None;
        let open = stream::open(cx.link, 0, first as u32, |handle| {
            held = Some(handle.clone());
            let core = me;
            Box::new(Ear {
                id,
                audio,
                handle,
                core,
            })
        });
        match open {
            Ok(stream) => opened = Some(stream),
            Err(e) => {
                let _ = apply(cx.core, Spoken::Cancel { id });
                return Err(e);
            }
        }
        if let Some(live) = cx.core.speech.live.get_mut(&id) {
            live.stream = held;
        }
    }
    Ok(Listening {
        stream: opened,
        seconds: RECORDING,
    })
}

/// `dictation.report`, from a recorder that transcribes.
pub fn report(cx: &mut Cx, args: ReportDictation) -> Result<(), Error> {
    let ReportDictation { id, text, level } = args;
    let event = Spoken::Report { id, text, level };
    apply(cx.core, event).or_else(|e| refused("dictation.report", e))
}

/// `dictation.finish`: only on the recorder's connection, where it comes
/// after the last of the audio.
pub fn finish(cx: &mut Cx, args: tasktap_proto::FinishDictation) -> Result<(), Error> {
    let id = args.id;
    let Some(live) = cx.core.speech.live.get(&id) else {
        return Err(Error::new(Code::Gone, "no such dictation"));
    };
    if !live.recorder.ptr_eq(&Rc::downgrade(cx.link)) {
        let why = "only the connection that records finishes a dictation";
        return Err(Error::new(Code::Denied, why));
    }
    let heard = live.audio.as_ref().is_none_or(|audio| {
        let mut audio = audio.borrow_mut();
        audio.ended = true;
        audio.heard()
    });
    let words = match args.words {
        Some(tasktap_proto::FinishAs::Text) => apply(cx.core, Spoken::Words { id }),
        None => Ok(()),
    };
    words
        .and_then(|()| apply(cx.core, Spoken::Finish { id, heard }))
        .or_else(|e| refused("dictation.finish", e))
}

/// `dictation.cancel`: from any device, at any point.
pub fn cancel(cx: &mut Cx, args: Ref<DictationId>) -> Result<(), Error> {
    apply(cx.core, Spoken::Cancel { id: args.id }).or_else(|e| refused("dictation.cancel", e))
}

/// A connection ended: what it was recording is interrupted.
pub fn left(core: &mut Core, link: &Rc<Link>) {
    let link = Rc::downgrade(link);
    let recorded = |(id, live): (&DictationId, &Live)| live.recorder.ptr_eq(&link).then_some(*id);
    let ids: Vec<DictationId> = core.speech.live.iter().filter_map(recorded).collect();
    for id in ids {
        let _ = apply(core, Spoken::Left { id });
    }
}

/// The core is shutting down: no deadline fires and no call goes on.
pub fn close(core: &mut Core) {
    for (_, live) in core.speech.live.drain() {
        if let Some(deadline) = live.deadline {
            deadline.abort();
        }
        if let Some(stop) = live.stop {
            let _ = stop.send(Signal::Stop);
        }
    }
}

/// At start: a recording a crash left on its way to the speech service
/// is removed.
pub fn sweep(data: &Path) {
    let _ = std::fs::remove_dir_all(data.join("speech"));
}

/// `speech.terms`: what a speech service is sent.
pub fn terms(_: &mut Cx, _: Empty) -> Result<SpeechTerms, Error> {
    let sent = [
        "The recording: what the microphone heard from the start of a dictation to its end, \
         at most 5 minutes, as 16 kHz mono audio",
        "The name of the model",
        "The languages you set as a hint, when you set any",
        "Your key for that server, when one is stored",
    ];
    Ok(SpeechTerms {
        sent: sent.map(String::from).into(),
        path: PATH.into(),
        seconds: RECORDING,
    })
}

/// Who transcribes for the core, and how.
struct Service {
    server: String,
    model: String,
    languages: Vec<String>,
    /// A key is stored for the server.
    keyed: bool,
}

/// The speech service the person consented to, if any.
fn service(core: &mut Core) -> Result<Option<Service>, Error> {
    let (by, languages, keys) = effects::read(core, |tx| {
        let value = |key| tx.pref(key).map(|pref| pref.map(|pref| pref.value));
        Ok((
            value(PrefKey::SpeechBy)?,
            value(PrefKey::SpeechLanguages)?,
            value(PrefKey::Keys)?,
        ))
    })?;
    let Some(PrefValue::SpeechBy(Some(by))) = by else {
        return Ok(None);
    };
    // One stored by an older build with other rules covers something else.
    if consented(&by).is_err() {
        return Ok(None);
    }
    let languages = match languages {
        Some(PrefValue::SpeechLanguages(languages)) => languages,
        _ => Vec::new(),
    };
    let keyed = matches!(keys, Some(PrefValue::Keys(keys)) if keys.contains(&by.server));
    Ok(Some(Service {
        server: by.server,
        model: by.model,
        languages,
        keyed,
    }))
}

/// Whether a server's address is one the core calls, and whether a key
/// may go to it: over `https`, or to this machine.
fn server(server: &str) -> Result<bool, String> {
    let (secure, rest) = match (
        server.strip_prefix("https://"),
        server.strip_prefix("http://"),
    ) {
        (Some(rest), _) => (true, rest),
        (_, Some(rest)) => (false, rest),
        _ => return Err("a server's address begins with https:// or http://".into()),
    };
    let host = rest.split('/').next().unwrap_or_default();
    let name = match host.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or_default(),
        None => host.split(':').next().unwrap_or_default(),
    };
    let odd = |c: char| "?#@".contains(c);
    if name.is_empty() || server.len() > 200 || !secrets::plain(server) || server.contains(odd) {
        return Err(
            "a server's address is a host and at most a path, in at most 200 characters, \
             with no space, quote, backslash, ?, # or @"
                .into(),
        );
    }
    if server.ends_with('/') {
        return Err("a server's address does not end with /".into());
    }
    Ok(secure || ["localhost", "127.0.0.1", "::1"].contains(&name))
}

/// Whether a consent names a server and a model the core can ask: what
/// `put` checks before it stores `speech_by`.
pub fn consented(by: &SpeechBy) -> Result<(), String> {
    server(&by.server)?;
    match secrets::plain(&by.model) && by.model.len() <= 200 {
        true => Ok(()),
        false => Err("a model's name is 1 to 200 printable characters, \
                      none a space, a quote or a backslash"
            .into()),
    }
}

/// Whether a list of languages is one: what `put` checks before it stores
/// `speech_languages`.
pub fn spoken(languages: &[String]) -> Result<(), String> {
    let code = |language: &String| {
        let (first, region) = language
            .split_once('-')
            .unwrap_or((language.as_str(), "aa"));
        (2..=3).contains(&first.len())
            && first.bytes().all(|b| b.is_ascii_lowercase())
            && (2..=4).contains(&region.len())
            && region.bytes().all(|b| b.is_ascii_alphabetic())
    };
    match languages.len() <= 4 && languages.iter().all(code) {
        true => Ok(()),
        false => Err("at most 4 languages, each a code such as de or en-GB".into()),
    }
}

/// Asks the speech service for the transcript of a dictation's audio, off
/// the core's thread, and applies its answer.
fn transcribe(core: &mut Core, id: DictationId) {
    let service = service(core);
    let Some(live) = core.speech.live.get_mut(&id) else {
        return;
    };
    let audio = live.audio.take();
    let pcm = audio.map(|audio| std::mem::take(&mut audio.borrow_mut().pcm));
    let (Ok(Some(service)), Some(pcm)) = (service, pcm) else {
        // The consent went while the person spoke.
        let transcript = Err("No speech service is set up".to_owned());
        let _ = apply(core, Spoken::Transcribed { id, transcript });
        return;
    };
    let (hear, heard) = mpsc::channel();
    live.stop = Some(hear.clone());
    let vault = core.speech.vault.clone();
    let folder = core.terminals.data().join("speech");
    let limit = core.speech.second * CALL;
    let name = format!("{}.wav", id.uuid());
    let work = move || {
        ask(
            &service,
            pcm,
            &*vault,
            (&folder, &name),
            limit,
            (hear, heard),
        )
    };
    crate::calls::aside(core, work, move |core, answer| {
        let lost = || {
            (
                Err("The speech service's call ended without an answer".to_owned()),
                None,
            )
        };
        let (transcript, forget) = answer.unwrap_or_else(lost);
        if let Some(server) = forget {
            let _ = listed(core, &server, false);
        }
        let _ = apply(core, Spoken::Transcribed { id, transcript });
        core.events.notify_one();
    });
}

/// The header of a WAV file of `len` bytes of the dictations' audio.
fn wav(len: u32) -> Vec<u8> {
    let mut header = Vec::with_capacity(44);
    header.extend_from_slice(b"RIFF");
    header.extend_from_slice(&(36 + len).to_le_bytes());
    header.extend_from_slice(b"WAVEfmt ");
    header.extend_from_slice(&16u32.to_le_bytes());
    // PCM, one channel.
    header.extend_from_slice(&1u16.to_le_bytes());
    header.extend_from_slice(&1u16.to_le_bytes());
    header.extend_from_slice(&RATE.to_le_bytes());
    header.extend_from_slice(&(RATE * 2).to_le_bytes());
    // Two bytes a sample, 16 bits each.
    header.extend_from_slice(&2u16.to_le_bytes());
    header.extend_from_slice(&16u16.to_le_bytes());
    header.extend_from_slice(b"data");
    header.extend_from_slice(&len.to_le_bytes());
    header
}

/// Writes the recording where curl reads it: a file only the person reads.
fn save(folder: &Path, name: &str, pcm: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(folder)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(folder.join(name))?;
    // Whole samples only: half of one may have arrived last.
    let pcm = &pcm[..pcm.len() & !1];
    file.write_all(&wav(pcm.len() as u32))?;
    file.write_all(pcm)
}

/// The blocking part of a transcription: the key from the credential
/// store, the recording to its file, the call, the file removed. Returns
/// the transcript, or why there is none in words the interface shows, and
/// the server whose key the store no longer has.
fn ask(
    service: &Service,
    pcm: Vec<u8>,
    vault: &dyn Vault,
    (folder, name): (&Path, &str),
    limit: Duration,
    wait: crate::command::Wait,
) -> (Result<String, String>, Option<String>) {
    let key = match service.keyed.then(|| vault.get(&service.server)) {
        None => None,
        Some(Ok(Some(key))) => Some(key),
        Some(Ok(None)) => {
            let why = format!(
                "The key for {} is no longer in the system's credential store",
                service.server
            );
            return (Err(why), Some(service.server.clone()));
        }
        Some(Err(why)) => return (Err(why), None),
    };
    if let Err(e) = save(folder, name, &pcm) {
        return (
            Err(format!("The recording could not be written: {e}")),
            None,
        );
    }
    drop(pcm);
    // The newer model of OpenAI takes several languages, in a field of its
    // own, and refuses the other. A model that takes one is told it only
    // when the person speaks one: told the first of several, Whisper
    // translates what is said in another, so it is left to hear which.
    let languages = (service.languages.iter()).map(|l| l.split('-').next().unwrap_or(l));
    let one = service.languages.len() == 1;
    let mut fields = vec![
        ("model", service.model.as_str()),
        ("response_format", "json"),
    ];
    match service.model.starts_with("gpt-transcribe") {
        true => fields.extend(languages.map(|l| ("languages[]", l))),
        false => fields.extend(languages.filter(|_| one).map(|l| ("language", l))),
    }
    let url = format!("{}{PATH}", service.server);
    let post = http::Post {
        url: &url,
        key: key.as_deref(),
        fields: &fields,
        file: (folder, name, "audio.wav", "audio/wav"),
        limit,
    };
    let answer = http::post(&post, wait);
    let _ = std::fs::remove_file(folder.join(name));
    (read(answer, service, key.as_deref()), None)
}

/// A text from outside in one line of at most 200 characters, with the key
/// struck from it: a service may repeat what it was sent.
fn clean(text: &str, key: Option<&str>) -> String {
    let text = match key {
        Some(key) => text.replace(key, "(key)"),
        None => text.to_owned(),
    };
    let line: Vec<&str> = text.split_whitespace().collect();
    line.join(" ").chars().take(200).collect()
}

/// The transcript in a service's answer, or why there is none.
fn read(
    answer: Result<http::Answer, http::Failed>,
    service: &Service,
    key: Option<&str>,
) -> Result<String, String> {
    use http::Failed;
    let answer = answer.map_err(|e| match e {
        Failed::Missing => "This system has no curl, which Tasktap makes web calls with".into(),
        Failed::Stopped => "The dictation was cancelled".into(),
        Failed::Slow => format!("The speech service did not answer within {CALL} s"),
        Failed::Unreachable(_) => "No network: the speech service could not be reached".into(),
        Failed::Untrusted(why) => format!(
            "The connection to the speech service is not trusted ({})",
            clean(&why, key)
        ),
        Failed::Other(why) => format!(
            "The speech service could not be called ({})",
            clean(&why, key)
        ),
    })?;
    let json: Option<Value> = serde_json::from_slice(&answer.body).ok();
    // What the service says of its failure, as OpenAI and Groq word it.
    let with = |what: String| {
        let said = json.as_ref().and_then(|json| {
            let error = &json["error"];
            error["message"].as_str().or(error.as_str())
        });
        match said.map(|said| clean(said, key)) {
            Some(said) if !said.is_empty() => format!("{what}: {said}"),
            _ => what,
        }
    };
    match answer.status {
        200..=299 => {
            let text = json.as_ref().and_then(|json| json["text"].as_str());
            let text = text.ok_or("The speech service's answer is not a transcript")?;
            match json_len(&text) > MAX_TEXT {
                true => Err("The transcript is too long".into()),
                false => Ok(text.to_owned()),
            }
        }
        // Its own words are not shown here: some repeat part of the key.
        401 | 403 if key.is_some() => Err("The speech service refused the key".into()),
        401 | 403 => Err("The speech service wants a key, and none is stored for it".into()),
        404 => Err(format!(
            "The speech service does not know the model {}, or its address is wrong",
            service.model
        )),
        413 => Err("The recording is too long for the speech service".into()),
        429 => Err("The speech service is over its limit; try again later".into()),
        status @ 400..=499 => Err(with(format!(
            "The speech service did not accept the recording ({status})"
        ))),
        status => Err(with(format!("The speech service failed ({status})"))),
    }
}

/// Adds a server to the `keys` preference, or takes it out: the one thing
/// a client sees of a key.
fn listed(core: &mut Core, server: &str, has: bool) -> Result<(), Error> {
    effects::write(core, |tx| {
        let stored = tx.pref(PrefKey::Keys).map_err(effects::stored)?;
        let mut keys = match stored.map(|pref| pref.value) {
            Some(PrefValue::Keys(keys)) => keys,
            _ => Vec::new(),
        };
        let had = keys.iter().any(|k| k == server);
        match (had, has) {
            (false, true) => keys.push(server.to_owned()),
            (true, false) => keys.retain(|k| k != server),
            _ => return Ok(()),
        }
        tx.put_pref(&PrefValue::Keys(keys)).map_err(effects::stored)
    })
}

/// Answers a key call once the credential store, asked off the core's
/// thread, has answered: the server joins or leaves `keys` with it.
fn keyed<C: Call<Result = ()>>(
    cx: &mut Cx,
    server: String,
    has: bool,
    work: impl FnOnce(&dyn Vault) -> Result<(), String> + Send + 'static,
) -> Option<Control> {
    let vault = cx.core.speech.vault.clone();
    let (link, id) = (cx.link.clone(), cx.id);
    crate::calls::aside(
        cx.core,
        move || work(&*vault),
        move |core, done| {
            let lost = || Err("the credential store ended without an answer".to_owned());
            let result = (done.unwrap_or_else(lost))
                .map_err(|why| Error::new(Code::Failed, why))
                .and_then(|()| listed(core, &server, has));
            link.send(&C::reply(id, result));
        },
    );
    None
}

/// `key.set`: the key of a server goes to the system's credential store,
/// and nowhere else.
pub fn set_key(cx: &mut Cx, args: SetKey) -> Option<Control> {
    let SetKey { server: name, key } = args;
    let invalid = |why: String| {
        Some(call::KeySet::reply(
            cx.id,
            Err(Error::new(Code::Invalid, why)),
        ))
    };
    match server(&name) {
        Err(why) => return invalid(why),
        Ok(false) => {
            let why = "a key is only stored for an https server or one on this machine";
            return invalid(why.into());
        }
        Ok(true) => {}
    }
    if !secrets::plain(&key) {
        let why = "a key is 1 to 512 printable characters, none a space, a quote or a backslash";
        return invalid(why.into());
    }
    let keys = effects::read(cx.core, |tx| tx.pref(PrefKey::Keys))
        .ok()
        .flatten();
    if matches!(keys.map(|p| p.value), Some(PrefValue::Keys(keys)) if keys.len() >= KEYS && !keys.contains(&name))
    {
        return invalid(format!("keys are stored for at most {KEYS} servers"));
    }
    let server = name.clone();
    keyed::<call::KeySet>(cx, server, true, move |vault| vault.set(&name, &key))
}

/// `key.remove`: the key of a server leaves the credential store.
pub fn remove_key(cx: &mut Cx, args: Server) -> Option<Control> {
    let name = args.server;
    if let Err(why) = server(&name) {
        return Some(call::KeyRemove::reply(
            cx.id,
            Err(Error::new(Code::Invalid, why)),
        ));
    }
    let server = name.clone();
    keyed::<call::KeyRemove>(cx, server, false, move |vault| vault.remove(&name))
}
