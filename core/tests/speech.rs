//! Speech through the real binary (design §8, "Speech"): a dictation from
//! the recorder's call to the thought or the answer it becomes, the bounds
//! of its stream, every failure of the speech service in the words the
//! interface shows, consent, and keys.
//!
//! No test calls a real provider: the speech service is a server of this
//! file on this machine, which answers by the name of the model it is asked
//! for. No test touches the real credential store: a core built with its
//! fixtures keeps keys in memory. The rules themselves are proven on the
//! pure function in `tests/state.rs`.

mod common;

use common::*;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tasktap_core::client::Client;
use tasktap_proto::call::{self, Code, Error};
use tasktap_proto::{
    Ask, Capture, CloseWhy, Control, Delete, Dictation, DictationId, DictationPhase,
    DictationTarget, Empty, FinishAs, FinishDictation, Frame, Listening, MAX_CREDIT, Outcome,
    PrefKey, PrefPatch, PrefValue, Put, PutTarget, QuestionKind, Ref, ReportDictation, Request,
    Response, Server, SetKey, Source, SpeechBy, StartDictation, Status, StreamId, ThoughtId,
    encode_data,
};

/// What the fixture service hears in every recording.
const HEARD: &str = "Bitte den Login-Bug fixen, also the tests.";
/// A key no provider ever issued.
const KEY: &str = "sk-test_SECRET-0123456789abcdef";
/// The most audio one dictation holds: 300 s at 32 000 bytes a second.
const CAP: usize = 9_600_000;

/// One request as the fixture service received it.
#[derive(Clone)]
struct Seen {
    head: String,
    body: Vec<u8>,
}

impl Seen {
    fn header(&self, name: &str) -> Option<String> {
        self.head.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name)
                .then(|| value.trim().to_owned())
        })
    }

    /// The values of the form's fields called `name`, in order.
    fn fields(&self, name: &str) -> Vec<String> {
        let label = format!("name=\"{name}\"\r\n\r\n");
        let mut found = Vec::new();
        let mut rest = &self.body[..];
        while let Some(at) = find(rest, label.as_bytes()) {
            rest = &rest[at + label.len()..];
            let end = find(rest, b"\r\n").unwrap_or(rest.len());
            found.push(String::from_utf8_lossy(&rest[..end]).into_owned());
        }
        found
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// A stand-in for a speech service, on this machine: it speaks the
/// transcription endpoint and answers by the model it is asked for.
struct Service {
    port: u16,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Service {
    fn start() -> Service {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::<Mutex<Vec<Seen>>>::default();
        let log = seen.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                let log = log.clone();
                std::thread::spawn(move || answer(conn, &log));
            }
        });
        Service { port, seen }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

fn answer(mut conn: TcpStream, log: &Mutex<Vec<Seen>>) {
    let (mut data, mut chunk) = (Vec::new(), vec![0; 64 << 10]);
    let split = loop {
        if let Some(at) = find(&data, b"\r\n\r\n") {
            break at;
        }
        match conn.read(&mut chunk) {
            Ok(n @ 1..) => data.extend_from_slice(&chunk[..n]),
            _ => return,
        }
    };
    let head = String::from_utf8_lossy(&data[..split]).into_owned();
    let mut seen = Seen {
        head,
        body: data[split + 4..].to_vec(),
    };
    let length: usize = (seen.header("content-length"))
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    // curl waits for this before it sends a large recording.
    if seen.header("expect").is_some() {
        let _ = conn.write_all(b"HTTP/1.1 100 Continue\r\n\r\n");
    }
    while seen.body.len() < length {
        match conn.read(&mut chunk) {
            Ok(n @ 1..) => seen.body.extend_from_slice(&chunk[..n]),
            _ => return,
        }
    }
    let model = seen.fields("model").pop().unwrap_or_default();
    let sent = seen.header("authorization").unwrap_or_default();
    log.lock().unwrap().push(seen);
    let heard = json!({"text": format!(" {HEARD}\n")}).to_string();
    let said = |message: String| json!({"error": {"message": message}}).to_string();
    let (status, body) = match model.as_str() {
        "ok" | "gpt-transcribe" => ("200 OK", heard),
        "empty" => ("200 OK", json!({"text": " \n"}).to_string()),
        "plain" => ("200 OK", "just words".to_owned()),
        "huge" => ("200 OK", json!({"text": "x".repeat(2 << 20)}).to_string()),
        "long" => ("200 OK", json!({"text": "x".repeat(70 << 10)}).to_string()),
        // As a provider that repeats what it was sent.
        "refuse" => (
            "401 Unauthorized",
            said(format!("Incorrect API key provided: {sent}")),
        ),
        "large" => ("413 Payload Too Large", "{}".to_owned()),
        "limit" => ("429 Too Many Requests", said("Rate limit reached".into())),
        "unknown" => ("404 Not Found", said("no such model".into())),
        "bad" => (
            "400 Bad Request",
            said(format!("could not decode\n  the audio, sent with {sent}")),
        ),
        "broken" => (
            "500 Internal Server Error",
            json!({"error": "upstream failed"}).to_string(),
        ),
        "slow" => {
            std::thread::sleep(Duration::from_secs(3));
            ("200 OK", heard)
        }
        // The connection ends with no answer.
        "cut" => return,
        _ => ("500 Internal Server Error", "{}".to_owned()),
    };
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    let _ = conn.write_all(head.as_bytes());
    let _ = conn.write_all(body.as_bytes());
}

/// A scene on a core started with `extra`, and a speech service.
fn stage(prefix: &str, extra: &[&str]) -> (Scene, Service) {
    let data = Folder::new(prefix);
    let core = Core::start_with(&data.0, extra);
    (Scene::on(core, data), Service::start())
}

fn put(w: &mut Watch, patch: PrefPatch) -> Result<(), Error> {
    let put = Put {
        target: PutTarget::Prefs(patch),
        if_rev: None,
    };
    w.call::<call::Put>(&put).map(|_| ())
}

/// Consents to `server` asked for `model`.
fn consent(w: &mut Watch, server: &str, model: &str) {
    let by = SpeechBy {
        server: server.into(),
        model: model.into(),
    };
    put(w, PrefPatch::SpeechBy(Some(by))).unwrap();
}

fn set_key(w: &mut Watch, server: &str, key: &str) -> Result<(), Error> {
    let (server, key) = (server.into(), key.into());
    w.call::<call::KeySet>(&SetKey { server, key })
}

/// The servers a key is stored for, as a client sees them.
fn keys(w: &Watch) -> Vec<String> {
    match w.model.prefs.get(&PrefKey::Keys) {
        Some(PrefValue::Keys(keys)) => keys.clone(),
        _ => Vec::new(),
    }
}

/// A spoken thought with nothing typed before it.
fn spoken() -> (ThoughtId, Capture) {
    let id = ThoughtId::mint();
    let capture = Capture {
        source: Source::Voice,
        ..typed(id, "")
    };
    (id, capture)
}

fn thought() -> (ThoughtId, DictationTarget) {
    let (id, capture) = spoken();
    (id, DictationTarget::Thought(Box::new(capture)))
}

/// `ms` of a 200 Hz square wave whose samples are `loud` or its negative.
fn tone(ms: usize, loud: i16) -> Vec<u8> {
    (0..ms * 16)
        .flat_map(|i| match (i / 40) % 2 {
            0 => loud.to_le_bytes(),
            _ => (-loud).to_le_bytes(),
        })
        .collect()
}

/// A connection that records a dictation.
struct Recorder {
    c: Client,
    id: DictationId,
    s: Option<StreamId>,
}

impl Recorder {
    fn start(core: &Core, target: DictationTarget, local: bool) -> Result<Recorder, Error> {
        Self::start_on(core.device(), target, local)
    }

    fn start_on(mut c: Client, target: DictationTarget, local: bool) -> Result<Recorder, Error> {
        let id = DictationId::mint();
        let start = StartDictation { id, target, local };
        let Listening { stream, seconds } = c.call::<call::DictationStart>(&start).unwrap()?;
        assert_eq!(seconds, 300);
        if let Some(stream) = &stream {
            assert_eq!(stream.credit, MAX_CREDIT);
            c.track(stream, 0, false);
        }
        let s = stream.map(|stream| stream.s);
        Ok(Recorder { c, id, s })
    }

    /// Sends samples on the stream, waiting for credit as it runs out.
    fn hear(&mut self, pcm: &[u8]) {
        self.c.write(self.s.expect("a stream"), pcm).unwrap();
    }

    fn finish(&mut self) -> Result<(), Error> {
        self.finish_as(None)
    }

    /// Finishes, with `as: "text"` as words only.
    fn finish_as(&mut self, words: Option<FinishAs>) -> Result<(), Error> {
        let finish = FinishDictation { id: self.id, words };
        self.c.call::<call::DictationFinish>(&finish).unwrap()
    }

    fn report(&mut self, text: Option<&str>, level: Option<u8>) -> Result<(), Error> {
        let report = ReportDictation {
            id: self.id,
            text: text.map(String::from),
            level,
        };
        self.c.call::<call::DictationReport>(&report).unwrap()
    }

    /// How the core closed the stream.
    fn closed(&mut self) -> Option<CloseWhy> {
        loop {
            if let Frame::Control(Control::Close(close)) = self.c.recv().unwrap() {
                return close.why;
            }
        }
    }
}

/// Starts a dictation the core transcribes and has it hear `pcm`.
fn recorded(s: &Scene, target: DictationTarget, pcm: &[u8]) -> Recorder {
    let mut r = Recorder::start(&s.core, target, false).unwrap();
    r.hear(pcm);
    r
}

/// The dictation's row once it failed.
fn failed(w: &mut Watch, id: DictationId) -> Dictation {
    let failed =
        |m: &Model| (m.dictations.get(&id)).is_some_and(|d| d.phase == DictationPhase::Failed);
    w.until("the dictation fails", failed);
    let row = w.model.dictations[&id].clone();
    assert_eq!(row.level, 0);
    row
}

/// The thought a dictation became, once its row is gone.
fn delivered(w: &mut Watch, id: DictationId, thought: ThoughtId) {
    let done = |m: &Model| m.thoughts.contains_key(&thought) && !m.dictations.contains_key(&id);
    w.until("the dictation becomes its thought", done);
}

/// No recording is left on its way to the speech service.
fn nothing_left(data: &Path) {
    let folder = data.join("speech");
    let left: Vec<_> = (std::fs::read_dir(&folder).into_iter().flatten())
        .flatten()
        .map(|entry| entry.file_name())
        .collect();
    assert!(left.is_empty(), "left in {}: {left:?}", folder.display());
}

fn cancel(w: &mut Watch, id: DictationId) {
    w.ok::<call::DictationCancel>(&Ref { id });
}

#[test]
fn a_spoken_thought_is_captured_routed_and_held_as_a_typed_one_is() {
    let (mut s, service) = stage("speech-thought", &[]);
    consent(&mut s.w, &service.url(), "ok");
    set_key(&mut s.w, &service.url(), KEY).unwrap();
    assert_eq!(keys(&s.w), [service.url()]);
    put(&mut s.w, PrefPatch::SpeechLanguages(vec!["de-DE".into()])).unwrap();

    let (t, target) = thought();
    let mut r = recorded(&s, target.clone(), &tone(1000, 8000));
    let id = r.id;
    let loud = |m: &Model| m.dictations.get(&id).is_some_and(|d| d.level > 0);
    s.w.until("the level of what is said", loud);
    let row = s.w.model.dictations[&id].clone();
    assert_eq!(
        (row.phase, row.text.as_str()),
        (DictationPhase::Recording, "")
    );
    assert_eq!((row.target, row.error), (target, None));
    // -12.2 dBFS on the scale from -55 to -6.
    assert_eq!(row.level, 87);
    r.finish().unwrap();
    assert_eq!(r.closed(), Some(CloseWhy::Done));
    delivered(&mut s.w, id, t);

    // Exactly what typing it would have been, but for its source: routed by
    // the router, held with Undo, and launched when the hold ends.
    let thought = s.w.model.thought(t).clone();
    assert_eq!(
        (thought.text.as_str(), thought.source),
        (HEARD, Source::Voice)
    );
    assert_eq!(thought.status, Status::Routed);
    assert_eq!(thought.project_id, Some(s.project));
    s.w.ok::<call::ThoughtStop>(&Ref { id: t });
    assert_eq!(s.w.model.status(t), Status::Captured);

    // What was sent, and that it was all that was sent.
    let [seen] = &service.seen()[..] else {
        panic!("one request");
    };
    assert!(
        seen.head
            .starts_with("POST /v1/audio/transcriptions HTTP/1.1\r\n")
    );
    assert_eq!(seen.header("authorization"), Some(format!("Bearer {KEY}")));
    assert_eq!(seen.fields("model"), ["ok"]);
    assert_eq!(seen.fields("response_format"), ["json"]);
    // One language, without its region, for a model that takes one.
    assert_eq!(seen.fields("language"), ["de"]);
    assert!(seen.fields("languages[]").is_empty() && seen.fields("prompt").is_empty());
    let file = b"name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n";
    let at = find(&seen.body, file).expect("the recording as a file") + file.len();
    let wav = &seen.body[at..at + 44 + 32_000];
    assert_eq!((&wav[..4], &wav[8..16]), (&b"RIFF"[..], &b"WAVEfmt "[..]));
    // PCM, one channel, 16 kHz, 16 bits, and the second that was said.
    assert_eq!(wav[20..24], [1, 0, 1, 0]);
    assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
    assert_eq!(wav[34..36], [16, 0]);
    assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 32_000);
    assert_eq!(wav[44..], tone(1000, 8000)[..]);
    nothing_left(&s.data.0);

    // A picked destination is the person's: the router is not asked.
    let other = s.project("other");
    let (t, mut capture) = spoken();
    capture.project_id = Some(other);
    let mut r = recorded(
        &s,
        DictationTarget::Thought(Box::new(capture)),
        &tone(300, 8000),
    );
    r.finish().unwrap();
    delivered(&mut s.w, r.id, t);
    let thought = s.w.model.thought(t).clone();
    assert_eq!(thought.text, HEARD);
    assert_eq!(
        (thought.project_id, thought.status),
        (Some(other), Status::Routed)
    );
    s.tick(HOLD_MS);
    assert_eq!(s.w.model.status(t), Status::Working);
}

/// The person spoke a new thought, let go, and wants to edit before
/// sending: `dictation.finish {as: "text"}` ends it as the text target
/// does (design §8).
#[test]
fn a_spoken_thought_finished_as_text_leaves_its_words_and_captures_nothing() {
    let (mut s, service) = stage("speech-words", &[]);
    consent(&mut s.w, &service.url(), "ok");
    let heard = |w: &mut Watch, id: DictationId| {
        let heard =
            |m: &Model| (m.dictations.get(&id)).is_some_and(|d| d.phase == DictationPhase::Heard);
        w.until("the words", heard);
        w.model.dictations[&id].clone()
    };
    // From the empty Composer: started for a thought, finished as text.
    let (t, target) = thought();
    let mut r = recorded(&s, target, &tone(300, 8000));
    r.finish_as(Some(FinishAs::Text)).unwrap();
    assert_eq!(r.closed(), Some(CloseWhy::Done));
    let row = heard(&mut s.w, r.id);
    assert_eq!((row.text.as_str(), row.error), (HEARD, None));
    assert_eq!(row.target, DictationTarget::Text);
    s.w.sync();
    assert!(s.w.model.thoughts.is_empty(), "{t:?} was not captured");
    nothing_left(&s.data.0);
    cancel(&mut s.w, r.id);

    // Decided after letting go, while the speech service still answers.
    consent(&mut s.w, &service.url(), "slow");
    let mut r = recorded(&s, thought_target(), &tone(300, 8000));
    r.finish().unwrap();
    r.finish_as(Some(FinishAs::Text)).unwrap();
    let row = heard(&mut s.w, r.id);
    assert_eq!(
        (row.text.as_str(), row.target),
        (HEARD, DictationTarget::Text)
    );
    s.w.sync();
    assert!(s.w.model.thoughts.is_empty());
    cancel(&mut s.w, r.id);

    // Too late once its thought is captured: there is no dictation any more.
    consent(&mut s.w, &service.url(), "ok");
    let (t, target) = thought();
    let mut r = recorded(&s, target, &tone(300, 8000));
    r.finish().unwrap();
    delivered(&mut s.w, r.id, t);
    let late = r.finish_as(Some(FinishAs::Text)).unwrap_err();
    assert_eq!(late.code, Code::Gone);
    assert_eq!(s.w.model.thoughts.len(), 1);
}

#[test]
fn words_for_a_field_are_only_heard_and_a_spoken_follow_up_is_a_thought() {
    let (mut s, service) = stage("speech-reply", &[]);
    consent(&mut s.w, &service.url(), "ok");
    let (first, session, mut agent) = s.launch("Fix the build");
    let ask = Ask {
        kind: QuestionKind::Text,
        ..confirm("r1", "Which branch?")
    };
    agent.ask_with(ask);
    let question = s.shown();
    let thoughts = s.w.model.thoughts.len();

    // Speech into the answer's field, or into a thought half typed: the
    // words are there to read, and the core does nothing with them.
    let mut r = recorded(&s, DictationTarget::Text, &tone(300, 8000));
    let id = r.id;
    r.finish().unwrap();
    assert_eq!(r.closed(), Some(CloseWhy::Done));
    let heard =
        |m: &Model| (m.dictations.get(&id)).is_some_and(|d| d.phase == DictationPhase::Heard);
    s.w.until("the words", heard);
    let row = s.w.model.dictations[&id].clone();
    assert_eq!((row.text.as_str(), row.level, row.error), (HEARD, 0, None));
    assert_eq!(row.target, DictationTarget::Text);
    // No language was set, so none was sent, and no key was stored.
    let seen = service.seen().pop().unwrap();
    assert!(seen.fields("language").is_empty() && seen.header("authorization").is_none());
    // Nothing was captured and nothing answered: the question waits for
    // the person, who sends what they read, as typed.
    s.w.sync();
    assert_eq!(s.w.model.thoughts.len(), thoughts);
    assert_eq!(s.w.model.glance().question, Some(question));
    assert_eq!(
        s.w.model.question(question).state,
        tasktap_proto::QuestionState::Open
    );
    nothing_left(&s.data.0);
    // It is over for its recorder, and stays until it is dismissed.
    assert_eq!(r.finish().unwrap_err().code, Code::Gone);
    let answered = tasktap_proto::AnswerQuestion {
        id: question,
        response: Response::Text { text: row.text },
    };
    s.w.ok::<call::QuestionAnswer>(&answered);
    let answer = agent.reply("r1").unwrap();
    let text = HEARD.to_owned();
    assert_eq!(answer.response, Response::Text { text });
    cancel(&mut s.w, id);
    assert!(s.w.model.dictations.is_empty());
    // A recorder that transcribes itself leaves its words the same way,
    // and the next start clears them.
    s.w.ok::<call::Delete>(&Delete::Prefs {
        id: PrefKey::SpeechBy,
    });
    let mut r = Recorder::start(&s.core, DictationTarget::Text, true).unwrap();
    r.finish().unwrap();
    r.report(Some("Nein, lass es."), None).unwrap();
    s.w.sync();
    let row = s.w.model.dictations[&r.id].clone();
    assert_eq!(
        (row.phase, row.text.as_str()),
        (DictationPhase::Heard, "Nein, lass es.")
    );
    consent(&mut s.w, &service.url(), "ok");

    // A follow-up to the session, once its turn is over, is a thought.
    agent.finish("Built.");
    s.w.until("the first is done", |m| m.status(first) == Status::Done);
    let (t, mut capture) = spoken();
    capture.session_id = Some(session);
    let mut r = recorded(
        &s,
        DictationTarget::Thought(Box::new(capture)),
        &tone(300, 8000),
    );
    r.finish().unwrap();
    delivered(&mut s.w, r.id, t);
    assert!(
        s.w.model.dictations.is_empty(),
        "the start cleared the words"
    );
    assert_eq!(s.w.model.status(t), Status::Routed);
    s.tick(HOLD_MS);
    let log = s.log();
    assert!(log.delivered.contains(&t), "{log:?}");
}

#[test]
fn the_newer_model_is_given_every_language_and_a_key_goes_only_to_its_server() {
    let (mut s, service) = stage("speech-languages", &[]);
    let other = Service::start();
    // The key is another server's: this one is sent none.
    set_key(&mut s.w, &other.url(), KEY).unwrap();
    consent(&mut s.w, &service.url(), "gpt-transcribe");
    put(
        &mut s.w,
        PrefPatch::SpeechLanguages(vec!["de".into(), "en-GB".into()]),
    )
    .unwrap();
    let (t, target) = thought();
    let mut r = recorded(&s, target, &tone(300, 8000));
    r.finish().unwrap();
    delivered(&mut s.w, r.id, t);
    let seen = service.seen().pop().unwrap();
    assert_eq!(seen.fields("languages[]"), ["de", "en"]);
    assert!(seen.fields("language").is_empty());
    assert_eq!(seen.header("authorization"), None);
    assert!(other.seen().is_empty());
    // Consenting to the other server sends it its key, and this one nothing.
    consent(&mut s.w, &other.url(), "ok");
    let (t, target) = thought();
    let mut r = recorded(&s, target, &tone(300, 8000));
    r.finish().unwrap();
    delivered(&mut s.w, r.id, t);
    assert_eq!(
        other.seen()[0].header("authorization"),
        Some(format!("Bearer {KEY}"))
    );
    // A model that takes one language is told none of two: told the
    // first, it would translate what is said in the other.
    assert!(other.seen()[0].fields("language").is_empty());
    assert!(other.seen()[0].fields("languages[]").is_empty());
    assert_eq!(service.seen().len(), 1);
}

#[test]
fn every_failure_of_the_speech_service_says_what_the_interface_shows() {
    // A second of this core's limits lasts 20 ms: the call's 90 s are 1.8 s,
    // which the slow answer of the service, after 3 s, misses.
    let (mut s, service) = stage("speech-failures", &["--second-ms", "20"]);
    set_key(&mut s.w, &service.url(), KEY).unwrap();
    let cases = [
        ("refuse", "The speech service refused the key"),
        ("large", "The recording is too long for the speech service"),
        (
            "limit",
            "The speech service is over its limit; try again later",
        ),
        (
            "unknown",
            "The speech service does not know the model unknown, or its address is wrong",
        ),
        (
            "bad",
            "The speech service did not accept the recording (400): \
             could not decode the audio, sent with Bearer (key)",
        ),
        ("broken", "The speech service failed (500): upstream failed"),
        ("empty", "Nothing was heard"),
        ("plain", "The speech service's answer is not a transcript"),
        ("long", "The transcript is too long"),
        (
            "huge",
            "The speech service could not be called (the answer is too large)",
        ),
        ("slow", "The speech service did not answer within 90 s"),
    ];
    for (model, shown) in cases {
        consent(&mut s.w, &service.url(), model);
        let (t, target) = thought();
        let mut r = recorded(&s, target, &tone(300, 8000));
        r.finish().unwrap();
        let row = failed(&mut s.w, r.id);
        assert_eq!(row.error.as_deref(), Some(shown), "{model}");
        // Nothing was captured, and the next start clears what failed.
        assert!(!s.w.model.thoughts.contains_key(&t), "{model}");
        nothing_left(&s.data.0);
    }
    // A connection that ends with no answer: curl's own reason is shown
    // ("(52) Empty reply from server"; a reset where the system sends one).
    consent(&mut s.w, &service.url(), "cut");
    let mut r = recorded(&s, thought().1, &tone(300, 8000));
    r.finish().unwrap();
    let error = failed(&mut s.w, r.id).error.unwrap();
    assert!(
        error.starts_with("The speech service could not be called (("),
        "{error}"
    );
    assert_eq!(
        s.w.model.dictations.len(),
        1,
        "each start cleared the last failure"
    );

    // Without a key the service is sent none, and says it wants one.
    s.w.ok::<call::KeyRemove>(&Server {
        server: service.url(),
    });
    assert!(keys(&s.w).is_empty());
    consent(&mut s.w, &service.url(), "refuse");
    let mut r = recorded(&s, thought().1, &tone(300, 8000));
    r.finish().unwrap();
    let row = failed(&mut s.w, r.id);
    let wants = "The speech service wants a key, and none is stored for it";
    assert_eq!(row.error.as_deref(), Some(wants));
    assert_eq!(service.seen().pop().unwrap().header("authorization"), None);
}

#[test]
fn a_server_that_cannot_be_reached_says_no_network() {
    // On a core with its real limits: Windows takes two seconds to say
    // that nothing listens on a port.
    let (mut s, service) = stage("speech-nowhere", &[]);
    consent(&mut s.w, "http://127.0.0.1:1", "ok");
    let mut r = recorded(&s, thought_target(), &tone(300, 8000));
    r.finish().unwrap();
    let row = failed(&mut s.w, r.id);
    let shown = "No network: the speech service could not be reached";
    assert_eq!(row.error.as_deref(), Some(shown));
    assert!(service.seen().is_empty() && s.w.model.thoughts.is_empty());
    nothing_left(&s.data.0);
}

#[test]
fn nothing_leaves_the_machine_without_consent_or_when_nothing_was_heard() {
    let (mut s, service) = stage("speech-consent", &[]);
    // The default: no speech service, so a recorder with no engine of its
    // own is refused before anyone speaks.
    let refused = Recorder::start(&s.core, thought().1, false).err().unwrap();
    assert_eq!(
        (refused.code, refused.message.as_str()),
        (Code::Failed, "No speech service is set up")
    );
    assert!(s.w.model.dictations.is_empty());

    consent(&mut s.w, &service.url(), "ok");
    // A microphone that is muted or refused gives zeros; a tap gives
    // next to nothing; very quiet noise is below the floor.
    for pcm in [vec![0; 32_000], tone(50, 8000), tone(1000, 40), Vec::new()] {
        let mut r = recorded(&s, thought().1, &pcm);
        r.finish().unwrap();
        assert_eq!(r.closed(), Some(CloseWhy::Gone));
        let row = failed(&mut s.w, r.id);
        assert_eq!(row.error.as_deref(), Some("Nothing was heard"));
    }
    // The consent taken back while the person speaks: nothing is sent.
    let mut r = recorded(&s, thought().1, &tone(500, 8000));
    s.w.ok::<call::Delete>(&Delete::Prefs {
        id: PrefKey::SpeechBy,
    });
    r.finish().unwrap();
    let row = failed(&mut s.w, r.id);
    assert_eq!(row.error.as_deref(), Some("No speech service is set up"));
    assert!(service.seen().is_empty());
    nothing_left(&s.data.0);

    // What a dictation may become is checked before anyone speaks.
    consent(&mut s.w, &service.url(), "ok");
    let typed_one = DictationTarget::Thought(Box::new(typed(ThoughtId::mint(), "")));
    let strange = Capture {
        agent: Some("nobody".into()),
        ..spoken().1
    };
    let existing = Capture {
        id: s.capture("Typed before"),
        ..spoken().1
    };
    let half_typed = Capture {
        text: "Noch etwas:".into(),
        ..spoken().1
    };
    // An agent detection found missing runs nothing: its thought is
    // refused before it is spoken, not run by another.
    let asked = tasktap_proto::DetectAgents {
        agents: Some(vec!["fixture".into()]),
    };
    let found = s.w.ok::<call::AgentsDetect>(&asked);
    assert!(!found.agents[0].installed);
    let missing = Capture {
        agent: Some("fixture".into()),
        ..spoken().1
    };
    for (target, code) in [
        (typed_one, Code::Invalid),
        (DictationTarget::Thought(Box::new(strange)), Code::Invalid),
        (DictationTarget::Thought(Box::new(missing)), Code::Failed),
        (DictationTarget::Thought(Box::new(existing)), Code::Conflict),
        // Speech into a field that holds text is the text target's: a
        // spoken thought's text is its transcript and nothing else.
        (
            DictationTarget::Thought(Box::new(half_typed)),
            Code::Invalid,
        ),
    ] {
        let refused = Recorder::start(&s.core, target, true).err().unwrap();
        assert_eq!(refused.code, code, "{refused}");
    }
    assert_eq!(s.w.model.dictations.len(), 1, "only the one that failed");
}

/// `ms` of what an empty room gives a microphone: even noise, its samples
/// within `loud`, the same for the same `seed`.
fn room(ms: usize, loud: i32, seed: u32) -> Vec<i16> {
    let mut state = seed;
    let noise = |_| {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        ((state >> 8) as i32 % (2 * loud + 1) - loud) as i16
    };
    (0..ms * 16).map(noise).collect()
}

/// A sound added to a recording from `at_ms` on for `ms`: a 200 Hz square
/// wave of this loudness.
fn sound(recording: &mut [i16], at_ms: usize, ms: usize, loud: i16) {
    for (i, sample) in recording[at_ms * 16..][..ms * 16].iter_mut().enumerate() {
        *sample += if (i / 40) % 2 == 0 { loud } else { -loud };
    }
}

fn samples(recording: &[i16]) -> Vec<u8> {
    recording.iter().flat_map(|s| s.to_le_bytes()).collect()
}

#[test]
fn an_even_room_is_not_sent_and_a_word_barely_above_its_noise_is() {
    let (mut s, service) = stage("speech-room", &[]);
    consent(&mut s.w, &service.url(), "ok");
    // The noise of this room is at -45 dBFS, well above the floor below
    // which a microphone counts as muted.
    let quiet = |ms| room(ms, 300, 7);
    let mut word = quiet(3000);
    // A short word 1 dB above the room's own noise, not on a window's edge.
    sound(&mut word, 1275, 200, 200);
    let mut click = quiet(3000);
    sound(&mut click, 1000, 10, 6000);
    let mut pause = quiet(3000);
    pause[16_000..24_000].fill(0);
    let said = [
        ("a word barely above the noise", word),
        // Not told from a word, and so sent: the side to err on.
        ("a click", click),
        ("a gap in the noise", pause),
        ("too short to tell", quiet(400)),
        ("a place that is loud throughout", room(3000, 3000, 7)),
    ];
    for (what, recording) in said {
        let mut r = recorded(&s, DictationTarget::Text, &samples(&recording));
        let id = r.id;
        r.finish().unwrap();
        let heard =
            |m: &Model| (m.dictations.get(&id)).is_some_and(|d| d.phase == DictationPhase::Heard);
        s.w.until(what, heard);
    }
    assert_eq!(service.seen().len(), 5);
    // Nothing but the room, for three seconds and for a minute; and, the
    // known limit, a steady hum quieter than -30 dBFS.
    let even = [
        ("an empty room", samples(&quiet(3000))),
        ("an empty room, for a minute", samples(&quiet(60_000))),
        ("a steady hum", tone(3000, 300)),
    ];
    for (what, recording) in even {
        let mut r = recorded(&s, DictationTarget::Text, &recording);
        r.finish().unwrap();
        let row = failed(&mut s.w, r.id);
        assert_eq!(row.error.as_deref(), Some("Nothing was heard"), "{what}");
    }
    assert_eq!(service.seen().len(), 5, "nothing more was sent");
}

#[test]
fn a_consent_names_a_server_and_a_model_and_the_terms_say_what_is_sent() {
    let (mut s, _) = stage("speech-terms", &[]);
    let terms = s.w.ok::<call::SpeechTerms>(&Empty {});
    assert_eq!(
        (terms.path.as_str(), terms.seconds),
        ("/v1/audio/transcriptions", 300)
    );
    let [recording, model, languages, key] = &terms.sent[..] else {
        panic!("{:?}", terms.sent);
    };
    assert!(recording.starts_with("The recording") && model.contains("model"));
    assert!(languages.contains("languages") && key.contains("key"));

    let by = |server: &str, model: &str| {
        PrefPatch::SpeechBy(Some(SpeechBy {
            server: server.into(),
            model: model.into(),
        }))
    };
    for server in [
        "https://api.openai.com",
        "https://api.groq.com/openai",
        "http://192.168.1.5:8000",
        "http://[::1]:8000",
    ] {
        put(&mut s.w, by(server, "whisper-large-v3-turbo")).unwrap();
    }
    let long = format!("https://{}", "a".repeat(200));
    for (server, model) in [
        ("ftp://speech.example", "m"),
        ("api.openai.com", "m"),
        ("https://", "m"),
        ("https://api.openai.com/", "m"),
        ("https://api.openai.com/v1?key=1", "m"),
        ("https://user@api.openai.com", "m"),
        ("https://api.openai.com/a b", "m"),
        ("https://api.openai.com/\"", "m"),
        (long.as_str(), "m"),
        ("https://api.openai.com", ""),
        ("https://api.openai.com", "two words"),
        ("https://api.openai.com", "new\nline"),
    ] {
        let refused = put(&mut s.w, by(server, model)).unwrap_err();
        assert_eq!(refused.code, Code::Invalid, "{server} {model}");
    }
    let languages = |codes: &[&str]| {
        PrefPatch::SpeechLanguages(codes.iter().map(|c| (*c).to_owned()).collect())
    };
    for fine in [&["de", "en-GB", "yue"][..], &[]] {
        put(&mut s.w, languages(fine)).unwrap();
    }
    for odd in [
        &["german"][..],
        &["DE"],
        &["de-"],
        &["d"],
        &["de", "en", "fr", "es", "it"],
    ] {
        let refused = put(&mut s.w, languages(odd)).unwrap_err();
        assert_eq!(refused.code, Code::Invalid, "{odd:?}");
    }
    // The consent as stored is the last one that was accepted.
    let stored = s.w.model.prefs.get(&PrefKey::SpeechBy).cloned();
    let PrefValue::SpeechBy(Some(stored)) = stored.unwrap() else {
        panic!("a consent");
    };
    assert_eq!(stored.server, "http://[::1]:8000");
}

#[test]
fn a_recorder_that_transcribes_reports_and_its_deadlines_end_what_never_comes() {
    // A second lasts 5 ms: a recording's 310 s are 1.55 s, a transcript's
    // 120 s are 0.6 s.
    let (mut s, _) = stage("speech-local", &["--second-ms", "5"]);
    let (t, target) = thought();
    let mut r = Recorder::start(&s.core, target, true).unwrap();
    let id = r.id;
    assert_eq!(r.s, None, "no speech service: the recorder transcribes");
    r.report(Some("Bitte den"), Some(35)).unwrap();
    s.w.sync();
    let row = s.w.model.dictations[&id].clone();
    assert_eq!(
        (row.phase, row.text.as_str(), row.level),
        (DictationPhase::Recording, "Bitte den", 35)
    );
    r.finish().unwrap();
    s.w.sync();
    let row = s.w.model.dictations[&id].clone();
    assert_eq!((row.phase, row.level), (DictationPhase::Transcribing, 0));
    r.report(Some(HEARD), None).unwrap();
    delivered(&mut s.w, id, t);
    let thought = s.w.model.thought(t).clone();
    assert_eq!(
        (thought.text.as_str(), thought.source),
        (HEARD, Source::Voice)
    );
    // Reported again, it is gone.
    assert_eq!(r.report(Some("late"), None).unwrap_err().code, Code::Gone);

    // A transcript that never comes.
    let mut r = Recorder::start(&s.core, thought_target(), true).unwrap();
    r.finish().unwrap();
    let row = failed(&mut s.w, r.id);
    let late = "The transcript did not arrive within 2 minutes";
    assert_eq!(row.error.as_deref(), Some(late));
    assert_eq!(
        r.report(Some("late"), None).unwrap_err().code,
        Code::Conflict
    );
    // A recording that never ends.
    let r = Recorder::start(&s.core, thought_target(), true).unwrap();
    let row = failed(&mut s.w, r.id);
    let endless = "The recording did not end within 5 minutes";
    assert_eq!(row.error.as_deref(), Some(endless));
    assert_eq!(s.w.model.dictations.len(), 1);
    assert_eq!(
        s.w.model.thoughts.len(),
        1,
        "only the one that was delivered"
    );
}

fn thought_target() -> DictationTarget {
    thought().1
}

#[test]
fn only_the_recorder_finishes_and_one_records_while_four_are_under_way() {
    let (mut s, service) = stage("speech-many", &[]);
    consent(&mut s.w, &service.url(), "slow");
    let mut first = recorded(&s, thought_target(), &tone(300, 8000));
    // Another connection, of the same device or not, cannot finish it: its
    // call could arrive before the recorder's last samples.
    let finish = FinishDictation {
        id: first.id,
        words: None,
    };
    assert_eq!(
        s.w.refused::<call::DictationFinish>(&finish).code,
        Code::Denied
    );
    // One microphone: a second start while one records is refused.
    let second = Recorder::start(&s.core, thought_target(), false)
        .err()
        .unwrap();
    assert_eq!(
        (second.code, second.message.as_str()),
        (Code::Conflict, "another dictation is recording")
    );
    // A report is for a recorder that transcribes.
    assert_eq!(
        first.report(Some("x"), None).unwrap_err().code,
        Code::Conflict
    );
    first.finish().unwrap();
    // The same finish again is a repeat.
    first.finish().unwrap();
    // The next thought is spoken while the last is being transcribed.
    let mut all = vec![first];
    for _ in 1..4 {
        let mut next = recorded(&s, thought_target(), &tone(300, 8000));
        next.finish().unwrap();
        all.push(next);
    }
    let fifth = Recorder::start(&s.core, thought_target(), false)
        .err()
        .unwrap();
    assert_eq!(fifth.code, Code::Conflict);
    assert!(fifth.message.contains("four"), "{fifth}");
    s.w.sync();
    assert_eq!(s.w.model.dictations.len(), 4);
    // Cancelled while the speech service is asked: its call ends, nothing
    // is captured, and the recording is not left behind.
    for r in &all {
        cancel(&mut s.w, r.id);
    }
    assert!(s.w.model.dictations.is_empty());
    let deadline = Instant::now() + Duration::from_secs(10);
    while std::fs::read_dir(s.data.0.join("speech")).is_ok_and(|mut d| d.next().is_some()) {
        assert!(Instant::now() < deadline, "a recording was left behind");
        std::thread::sleep(Duration::from_millis(10));
    }
    std::thread::sleep(Duration::from_millis(3500));
    s.w.sync();
    assert!(s.w.model.thoughts.is_empty() && s.w.model.dictations.is_empty());
}

#[test]
fn cancel_ends_a_dictation_at_every_point_from_any_device() {
    let (mut s, service) = stage("speech-cancel", &[]);
    // While recording, by a recorder that transcribes.
    let mut r = Recorder::start(&s.core, thought_target(), true).unwrap();
    r.report(Some("Bitte"), None).unwrap();
    cancel(&mut s.w, r.id);
    assert!(s.w.model.dictations.is_empty());
    assert_eq!(
        r.report(Some("Bitte den"), None).unwrap_err().code,
        Code::Gone
    );
    assert_eq!(r.finish().unwrap_err().code, Code::Gone);
    // While it transcribes.
    let mut r = Recorder::start(&s.core, thought_target(), true).unwrap();
    r.finish().unwrap();
    cancel(&mut s.w, r.id);
    assert_eq!(r.report(Some(HEARD), None).unwrap_err().code, Code::Gone);
    // While recording on a stream: the stream's end tells the recorder to
    // stop the microphone.
    consent(&mut s.w, &service.url(), "ok");
    let mut r = recorded(&s, thought_target(), &tone(300, 8000));
    cancel(&mut s.w, r.id);
    assert_eq!(r.closed(), Some(CloseWhy::Gone));
    assert_eq!(r.finish().unwrap_err().code, Code::Gone);
    // One that failed is dismissed; one that is not there is no failure.
    let mut r = recorded(&s, thought_target(), &[]);
    r.finish().unwrap();
    let row = failed(&mut s.w, r.id);
    cancel(&mut s.w, row.id);
    cancel(&mut s.w, row.id);
    cancel(&mut s.w, DictationId::mint());
    assert!(s.w.model.dictations.is_empty() && s.w.model.thoughts.is_empty());
    assert!(service.seen().is_empty());
}

#[test]
fn a_recorder_that_leaves_interrupts_a_recording_but_not_what_the_core_has_whole() {
    let (mut s, service) = stage("speech-left", &[]);
    consent(&mut s.w, &service.url(), "ok");
    // Gone while recording: half a sentence starts nothing.
    let r = recorded(&s, thought_target(), &tone(500, 8000));
    let id = r.id;
    drop(r);
    let row = failed(&mut s.w, id);
    assert_eq!(row.error.as_deref(), Some("The recording was interrupted"));
    assert!(service.seen().is_empty());
    // Gone right after its finish: the core has all of it and goes on.
    let (t, target) = thought();
    let mut r = recorded(&s, target, &tone(500, 8000));
    let id = r.id;
    r.finish().unwrap();
    drop(r);
    delivered(&mut s.w, id, t);
    assert_eq!(s.w.model.thought(t).text, HEARD);
    // Gone while its own engine transcribes: the transcript never comes.
    s.w.ok::<call::Delete>(&Delete::Prefs {
        id: PrefKey::SpeechBy,
    });
    let mut r = Recorder::start(&s.core, thought_target(), true).unwrap();
    let id = r.id;
    r.finish().unwrap();
    drop(r);
    let row = failed(&mut s.w, id);
    assert_eq!(row.error.as_deref(), Some("The recording was interrupted"));
}

#[test]
fn a_recording_is_bounded_by_the_credit_of_its_stream() {
    let (mut s, service) = stage("speech-bounds", &[]);
    consent(&mut s.w, &service.url(), "ok");
    // Five minutes are taken whole, and transcribed whole.
    let (t, target) = thought();
    let mut r = recorded(&s, target, &tone(300_000, 8000));
    let stream = r.s.unwrap();
    // Every credit the core will ever grant has arrived with the reply.
    r.c.call::<call::CoreStatus>(&Empty {}).unwrap().unwrap();
    assert_eq!(r.c.credit(stream), 0, "no credit beyond {CAP} bytes");
    r.finish().unwrap();
    delivered(&mut s.w, r.id, t);
    let seen = service.seen().pop().unwrap();
    let length: usize = seen.header("content-length").unwrap().parse().unwrap();
    assert!((CAP + 44..CAP + 2048).contains(&length), "{length}");
    nothing_left(&s.data.0);

    // A byte beyond the credit ends the connection, as on every stream,
    // and with it the recording.
    let mut r = recorded(&s, thought_target(), &tone(300_000, 8000));
    let id = r.id;
    let mut frame = Vec::new();
    encode_data(r.s.unwrap(), &[0], &mut frame).unwrap();
    r.c.stream().write_all(&frame).unwrap();
    dropped(&mut r.c);
    let row = failed(&mut s.w, id);
    assert_eq!(row.error.as_deref(), Some("The recording was interrupted"));
    assert_eq!(service.seen().len(), 1);
}

#[test]
fn the_level_follows_how_loud_the_microphone_is() {
    let (mut s, service) = stage("speech-level", &[]);
    consent(&mut s.w, &service.url(), "ok");
    let mut r = Recorder::start(&s.core, thought_target(), false).unwrap();
    let id = r.id;
    // -30 dBFS, full scale, a whisper below the floor, and silence, each
    // for a little over one window of 100 ms; an odd number of bytes is
    // carried over to the next.
    for (loud, level) in [(1036, 51), (i16::MAX, 100), (1036, 51), (50, 0)] {
        let pcm = tone(250, loud);
        let (head, tail) = pcm.split_at(4001);
        r.hear(head);
        r.hear(tail);
        let at = |m: &Model| m.dictations.get(&id).is_some_and(|d| d.level == level);
        s.w.until("the level", at);
    }
    cancel(&mut s.w, id);
    assert!(service.seen().is_empty());
}

#[test]
fn keys_are_set_and_removed_by_server_and_a_client_sees_only_that_one_is_stored() {
    let (mut s, service) = stage("speech-keys", &[]);
    let openai = "https://api.openai.com";
    set_key(&mut s.w, openai, KEY).unwrap();
    // Setting again replaces it; the list of servers is all there is to see.
    set_key(&mut s.w, openai, "sk-another").unwrap();
    set_key(&mut s.w, "http://localhost:8000", KEY).unwrap();
    set_key(&mut s.w, "http://[::1]:9000/api", KEY).unwrap();
    assert_eq!(
        keys(&s.w),
        [openai, "http://localhost:8000", "http://[::1]:9000/api"]
    );
    // Over plain http a key goes only to this machine.
    for (server, key) in [
        ("http://192.168.1.5:8000", KEY),
        ("http://speech.example", KEY),
        ("https://api.openai.com/", KEY),
        ("api.openai.com", KEY),
        (openai, ""),
        (openai, "two words"),
        (openai, "quote\"d"),
        (openai, "back\\slash"),
    ] {
        let refused = set_key(&mut s.w, server, key).unwrap_err();
        assert_eq!(refused.code, Code::Invalid, "{server} {key}");
        // Why a key was refused never repeats it.
        assert!(
            key.is_empty() || !refused.message.contains(key),
            "{refused}"
        );
    }
    // Only these two calls change the list.
    let by_put = json!({"c": "prefs", "id": "keys", "patch": [openai]});
    assert_eq!(code(s.w.raw("put", by_put)), Code::Invalid);
    let by_delete = Delete::Prefs { id: PrefKey::Keys };
    assert_eq!(s.w.refused::<call::Delete>(&by_delete).code, Code::Invalid);
    for n in 0..5 {
        set_key(&mut s.w, &format!("https://speech{n}.example"), KEY).unwrap();
    }
    let ninth = set_key(&mut s.w, "https://one-more.example", KEY).unwrap_err();
    assert_eq!(ninth.code, Code::Invalid);
    for n in 0..5 {
        let server = format!("https://speech{n}.example");
        s.w.ok::<call::KeyRemove>(&Server { server });
    }
    // Removing what is not there is no failure.
    let server = "https://never-set.example".to_owned();
    s.w.ok::<call::KeyRemove>(&Server { server });
    assert_eq!(keys(&s.w).len(), 3);

    // A key the store no longer has: the dictation says so, and the
    // server leaves the list. This core's keys are in memory, so a new
    // core has none, as when the entry was removed by hand.
    set_key(&mut s.w, &service.url(), KEY).unwrap();
    consent(&mut s.w, &service.url(), "ok");
    let Scene { core, data, w, .. } = s;
    drop((w, core));
    let mut s = Scene::on(Core::start(&data.0), data);
    assert!(keys(&s.w).contains(&service.url()));
    let mut r = recorded(&s, thought_target(), &tone(300, 8000));
    r.finish().unwrap();
    let row = failed(&mut s.w, r.id);
    let gone = format!(
        "The key for {} is no longer in the system's credential store",
        service.url()
    );
    assert_eq!(row.error, Some(gone));
    s.w.until("the server leaves the list", |m| {
        !matches!(m.prefs.get(&PrefKey::Keys), Some(PrefValue::Keys(k)) if k.contains(&service.url()))
    });
    assert!(service.seen().is_empty());
}

#[test]
fn a_dictation_does_not_survive_the_core_and_a_recording_left_behind_is_removed() {
    let (mut s, service) = stage("speech-restart", &[]);
    consent(&mut s.w, &service.url(), "ok");
    let mut r = recorded(&s, thought_target(), &tone(500, 8000));
    s.w.sync();
    assert_eq!(s.w.model.dictations.len(), 1);
    // As a crash on the way to the speech service would leave it.
    let left = s.data.0.join("speech");
    std::fs::create_dir_all(&left).unwrap();
    std::fs::write(left.join("left.wav"), b"RIFF").unwrap();
    let Scene { core, data, w, .. } = s;
    drop((w, core));
    // The recorder's stream ended with its connection: it stops the microphone.
    assert!(r.finish_io().is_err());
    let s = Scene::on(Core::start(&data.0), data);
    // The new snapshot has no dictation, and nothing was captured.
    assert!(s.w.model.dictations.is_empty() && s.w.model.thoughts.is_empty());
    assert!(!left.exists());
    assert!(service.seen().is_empty());
}

impl Recorder {
    /// `dictation.finish` on a connection that may have ended.
    fn finish_io(&mut self) -> std::io::Result<Result<(), Error>> {
        let finish = FinishDictation {
            id: self.id,
            words: None,
        };
        self.c.call::<call::DictationFinish>(&finish)
    }
}

/// A connection that keeps every frame the core sends it, as text.
struct Tap {
    c: Client,
    said: String,
    next: u32,
}

impl Tap {
    fn call(&mut self, name: &str, args: Value) -> Outcome {
        let id = tasktap_proto::CallId(1000 + self.next);
        self.next += 1;
        let name = name.to_owned();
        self.c
            .send(&Control::Call(Request { id, name, args }))
            .unwrap();
        loop {
            let frame = self.c.recv().unwrap();
            self.said.push_str(&format!("{frame:?}\n"));
            match frame {
                Frame::Control(Control::Reply(reply)) if reply.id == id => return reply.outcome,
                _ => {}
            }
        }
    }

    fn ok(&mut self, name: &str, args: Value) -> Value {
        match self.call(name, args) {
            Outcome::Ok(value) => value,
            Outcome::Err(e) => panic!("{name} was refused: {e}"),
        }
    }
}

/// A core this file started itself, ended when the test ends, however it ends.
struct Ended(std::process::Child);

impl Ended {
    fn end(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl Drop for Ended {
    fn drop(&mut self) {
        self.end();
    }
}

/// Every file below `folder`, with its bytes.
fn files(folder: &Path, found: &mut Vec<(std::path::PathBuf, Vec<u8>)>) {
    for entry in std::fs::read_dir(folder).into_iter().flatten().flatten() {
        let path = entry.path();
        match entry.file_type().map(|t| t.is_dir()) {
            Ok(true) => files(&path, found),
            _ => {
                if let Ok(bytes) = std::fs::read(&path) {
                    found.push((path, bytes));
                }
            }
        }
    }
}

#[test]
fn a_key_reaches_no_record_no_reply_no_file_and_nothing_the_core_prints() {
    let data = Folder::new("speech-secret");
    let service = Service::start();
    // This core is started here, so that what it prints is kept.
    let printed = data.0.join("printed.txt");
    let out = std::fs::File::create(&printed).unwrap();
    let mut serve = tasktap_core::client::serve_command(Path::new(EXE), &data.0);
    serve
        .args(["--idle-ms", "600000"])
        .stdin(std::process::Stdio::null())
        .stdout(out.try_clone().unwrap())
        .stderr(out);
    let mut core = Ended(serve.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(20);
    while !std::fs::read_to_string(&printed).unwrap().contains("ready") {
        assert!(Instant::now() < deadline, "the core never listened");
        std::thread::sleep(Duration::from_millis(5));
    }
    let hello = tasktap_proto::Hello {
        v: tasktap_proto::Versions(tasktap_proto::VERSION, tasktap_proto::VERSION),
        role: tasktap_proto::Role::Cli,
        client: "test".into(),
        auth: Some(tasktap_proto::Auth::Device {
            device: tasktap_proto::DeviceId::mint(),
            key: tasktap_proto::Secret([1; 32]),
            register: Some(tasktap_proto::Register {
                name: "test".into(),
            }),
        }),
        abilities: Vec::new(),
    };
    let stream = tasktap_core::client::connect(&data.0).unwrap();
    let c = Client::hello(stream, hello).unwrap().unwrap();
    let mut tap = Tap {
        c,
        said: String::new(),
        next: 0,
    };
    let collections: Vec<&str> = vec![
        "thoughts",
        "projects",
        "sessions",
        "terminals",
        "questions",
        "results",
        "layouts",
        "prefs",
        "devices",
        "glance",
        "agents",
        "dictations",
    ];
    tap.ok("sub", json!({"collections": collections}));
    let server = service.url();
    tap.ok("key.set", json!({"server": server, "key": KEY}));
    // Calls that mention the key and are refused.
    for (name, args) in [
        (
            "key.set",
            json!({"server": "http://192.168.1.5", "key": KEY}),
        ),
        (
            "key.set",
            json!({"server": server, "key": format!("{KEY} {KEY}")}),
        ),
        ("key.set", json!({"server": server, "key": [KEY]})),
        ("put", json!({"c": "prefs", "id": "keys", "patch": [KEY]})),
    ] {
        assert!(matches!(tap.call(name, args), Outcome::Err(_)), "{name}");
    }
    // A service that repeats the key in what it says, as a refusal, as a
    // bad request, and as its transcript's failure.
    for model in ["refuse", "bad", "ok"] {
        tap.ok(
            "put",
            json!({"c": "prefs", "id": "speech_by", "patch": {"server": server, "model": model}}),
        );
        let id = DictationId::mint();
        let target =
            json!({"kind": "thought", "id": ThoughtId::mint(), "text": "", "source": "voice"});
        let start = tap.ok(
            "dictation.start",
            json!({"id": id, "target": target, "local": false}),
        );
        let opened: tasktap_proto::Opened =
            serde_json::from_value(start["stream"].clone()).unwrap();
        tap.c.track(&opened, 0, false);
        tap.c.write(opened.s, &tone(300, 8000)).unwrap();
        tap.ok("dictation.finish", json!({"id": id}));
        // Until its row failed or went.
        let deadline = Instant::now() + Duration::from_secs(20);
        let ended =
            |said: &str| said.matches("Failed").count() + said.matches("del: [DictationId").count();
        let before = ended(&tap.said);
        while ended(&tap.said) == before {
            assert!(Instant::now() < deadline, "{model} never ended");
            tap.ok("core.status", json!({}));
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    tap.ok("key.remove", json!({"server": server}));
    tap.ok("core.status", json!({}));

    // The key was sent to the service, each time, and is nowhere else.
    let seen = service.seen();
    assert_eq!(seen.len(), 3);
    assert!(
        seen.iter()
            .all(|s| s.header("authorization") == Some(format!("Bearer {KEY}")))
    );
    assert!(
        tap.said.contains("The speech service refused the key"),
        "{}",
        tap.said
    );
    assert!(tap.said.contains("sent with Bearer (key)"), "{}", tap.said);
    assert!(
        tap.said.contains(&server),
        "the server is what a client sees"
    );
    assert!(!tap.said.contains(KEY), "a key in what the core sent");
    core.end();
    let mut found = Vec::new();
    files(&data.0, &mut found);
    assert!(found.iter().any(|(path, _)| path.ends_with("core.db")));
    for (path, bytes) in found {
        assert!(
            find(&bytes, KEY.as_bytes()).is_none(),
            "a key in {}",
            path.display()
        );
    }
}

/// A real speech service, asked with a real key: never part of the suite,
/// since every run is a call on somebody's account. One command, with the
/// key in the environment of that command alone:
///
/// `TASKTAP_SPEECH_SERVER=https://api.groq.com/openai TASKTAP_SPEECH_MODEL=whisper-large-v3-turbo
/// TASKTAP_SPEECH_KEY=… cargo test -p tasktap-core --test speech -- --ignored real --nocapture`
///
/// It goes the whole way a dictation goes, through a core of its own with
/// its keys in memory, and prints what was heard. The sentence is spoken
/// by the system's own voice on a Mac (no microphone); elsewhere, or for
/// another sentence, `TASKTAP_SPEECH_WAV` names a 16 kHz mono 16-bit WAV
/// file. `TASKTAP_SPEECH_LANGUAGES` is the hint, as `de,en`; without a
/// key, for a server of one's own, none is sent.
#[test]
#[ignore = "calls a real speech service with a real key: run by hand"]
fn a_real_speech_service_hears_a_sentence() {
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    let need = |name: &str| var(name).unwrap_or_else(|| panic!("set {name}"));
    let (server, model) = (need("TASKTAP_SPEECH_SERVER"), need("TASKTAP_SPEECH_MODEL"));
    let (mut s, _) = stage("speech-real", &[]);
    let said = "Bitte den Login-Bug fixen und danach die Tests laufen lassen. \
                Also, the build should be green before we merge.";
    let file = var("TASKTAP_SPEECH_WAV").unwrap_or_else(|| {
        let file = s.data.0.join("said.wav");
        let spoken = std::process::Command::new("/usr/bin/say")
            .args([
                "-v",
                "Anna",
                "--file-format=WAVE",
                "--data-format=LEI16@16000",
                "-o",
            ])
            .arg(&file)
            .arg(said)
            .status();
        assert!(spoken.is_ok_and(|s| s.success()), "set TASKTAP_SPEECH_WAV");
        file.to_str().unwrap().to_owned()
    });
    let wav = std::fs::read(&file).unwrap();
    let pcm = &wav[find(&wav, b"data").expect("a WAV file") + 8..];
    if let Some(key) = var("TASKTAP_SPEECH_KEY") {
        set_key(&mut s.w, &server, &key).unwrap();
    }
    consent(&mut s.w, &server, &model);
    if let Some(languages) = var("TASKTAP_SPEECH_LANGUAGES") {
        let languages = languages.split(',').map(String::from).collect();
        put(&mut s.w, PrefPatch::SpeechLanguages(languages)).unwrap();
    }
    let (t, target) = thought();
    let began = Instant::now();
    let mut r = recorded(&s, target, pcm);
    let id = r.id;
    r.finish().unwrap();
    let ended = |m: &Model| {
        let failed = |d: &Dictation| d.phase == DictationPhase::Failed;
        m.thoughts.contains_key(&t) || m.dictations.get(&id).is_some_and(failed)
    };
    s.w.until("the speech service's answer", ended);
    let took = began.elapsed().as_millis();
    let seconds = pcm.len() / 32_000;
    match s.w.model.thoughts.get(&t) {
        Some(thought) => println!("heard in {took} ms, of {seconds} s: {}", thought.text),
        None => panic!("{model} at {server}: {:?}", s.w.model.dictations[&id].error),
    }
}
