//! What the questions and loop tests share: the real binary on its own
//! folder, devices and stand-in agents that speak to it through `client.rs`,
//! a model of every record a device sees, and the fixture router, launcher
//! and clock (design §13). No test reaches into the core.
#![allow(dead_code, reason = "each test file uses its own part")]

use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tasktap_core::client::{self, Client};
use tasktap_proto::call::{self, Call, Code, Error};
use tasktap_proto::{
    Answer, Ask, AskKey, Auth, CallId, Capture, Change, Collection, Control, Data, DeviceId, Empty,
    Event as Said, FixtureClock, FixtureLog, Frame, Glance, Hello, Identity, OpenTerminal, Outcome,
    Place, Project, ProjectId, Question, QuestionId, QuestionKind, Refuse, Register, Request,
    ResultId, Retire, Role, Route, Secret, Session, SessionEvent, SessionId, Set, Source,
    StartTerminal, Status, StreamId, Subscribe, Terminal, TerminalId, Thought, ThoughtId, Time,
    TurnResult, VERSION, Versions, When,
};

pub mod watchdog;
pub use watchdog::Watchdog;

/// What each test did and saw, by its thread's name, with the time: shown
/// when its watchdog fires, so that a test that hangs says what it had
/// done and what it never saw. Kept in memory, so noting a step takes no
/// time and changes no race.
static NOTES: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

/// Notes a step of the test running on this thread.
pub fn note(what: &str) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    let (s, us) = (now.as_secs() % 100_000, now.subsec_micros());
    let test = std::thread::current().name().unwrap_or("a test").to_owned();
    let mut notes = NOTES.lock().unwrap_or_else(|e| e.into_inner());
    notes.push((test, format!("{s:>5}.{us:06} {what}")));
}

/// What a core wrote after it was ready, its last lines: a panic's
/// message, or why it stopped. One that runs well writes none.
pub fn last_words(said: &client::Said) -> String {
    let said = said.lock().unwrap_or_else(|e| e.into_inner());
    match said.is_empty() {
        true => "the core wrote nothing after it was ready".into(),
        false => said
            .iter()
            .fold("what the core wrote:\n".to_owned(), |all, line| {
                all + "  " + line + "\n"
            }),
    }
}

/// The notes of `test`, one a line.
pub fn notes(test: &str) -> String {
    let notes = NOTES.lock().unwrap_or_else(|e| e.into_inner());
    let own = notes.iter().filter(|(t, _)| t == test);
    own.map(|(_, line)| format!("  {line}\n")).collect()
}

pub const EXE: &str = env!("CARGO_BIN_EXE_tasktap");
/// Milliseconds a thought is held while the preference is unset.
pub const HOLD_MS: u64 = tasktap_proto::DEFAULT_HOLD as u64 * 1000;
pub const ALL: [Collection; 15] = [
    Collection::Thoughts,
    Collection::Projects,
    Collection::Sessions,
    Collection::Terminals,
    Collection::Questions,
    Collection::Results,
    Collection::Layouts,
    Collection::Prefs,
    Collection::Devices,
    Collection::Previews,
    Collection::Looks,
    Collection::Cards,
    Collection::Glance,
    Collection::Agents,
    Collection::Dictations,
];

pub fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

pub fn time(ms: u64) -> Time {
    Time::new(ms).unwrap()
}

/// A fresh data folder, removed afterwards.
pub struct Folder(pub PathBuf);

impl Folder {
    pub fn new(prefix: &str) -> Folder {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        // Short: a socket path has a length limit.
        let path = std::env::temp_dir().join(format!("{prefix}-{}-{n}", std::process::id()));
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

impl AsRef<Path> for Folder {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

/// A core this test started; killed if the test ends with it still running.
pub struct Core {
    child: Child,
    pub data: PathBuf,
    _watchdog: Watchdog,
    /// The last lines the core wrote after `ready`.
    pub said: client::Said,
}

impl Core {
    /// A core whose idle delay is long enough never to matter.
    pub fn start(data: impl AsRef<Path>) -> Core {
        Self::start_with(data, &[])
    }

    /// The same with more arguments, which may set another idle delay.
    pub fn start_with(data: impl AsRef<Path>, extra: &[&str]) -> Core {
        Self::start_env(data, extra, &[])
    }

    /// A core that finds the fixture agent's program on its PATH.
    pub fn with_agents(data: impl AsRef<Path>) -> Core {
        let data = data.as_ref();
        Self::start_env(data, &[], &[("PATH", &path_with(&agents(data)))])
    }

    /// A core for a live agent's runs (`tests/live.rs`): its watchdog
    /// waits `patience`.
    pub fn live(data: impl AsRef<Path>, patience: std::time::Duration) -> Core {
        let data = data.as_ref();
        let mut serve = client::serve_command(Path::new(EXE), data);
        serve.args(["--idle-ms", "600000"]);
        let (child, said) = client::start_said(serve).unwrap();
        Core {
            _watchdog: Watchdog::patient(&child, patience, said.clone()),
            child,
            data: data.to_owned(),
            said,
        }
    }

    /// The same with these variables added to the core's environment.
    pub fn start_env(data: impl AsRef<Path>, extra: &[&str], env: &[(&str, &str)]) -> Core {
        Self::start_patient(data, extra, env, watchdog::PATIENCE)
    }

    /// The same, killed only once the test held it for `patience`.
    pub fn start_patient(
        data: impl AsRef<Path>,
        extra: &[&str],
        env: &[(&str, &str)],
        patience: std::time::Duration,
    ) -> Core {
        Self::start_exe(Path::new(EXE), data, extra, env, patience)
    }

    /// The same with the core of another binary, an earlier build.
    pub fn start_exe(
        exe: &Path,
        data: impl AsRef<Path>,
        extra: &[&str],
        env: &[(&str, &str)],
        patience: std::time::Duration,
    ) -> Core {
        let data = data.as_ref();
        let mut serve = client::serve_command(exe, data);
        serve.args(["--idle-ms", "600000"]).args(extra);
        // Every shell a test's core starts, also the one that follows an
        // agent's end, is `sh` in a home of the test's own: never the
        // person's shell with their files, whose history it would write.
        // On Windows the home folder is the profile's: a home a test names
        // is named there too, unless the test names that one apart.
        let home = data.join("home");
        std::fs::create_dir_all(&home).unwrap();
        serve.env("HOME", &home).env("SHELL", "/bin/sh");
        if cfg!(windows) {
            let named = env.iter().find(|(key, _)| *key == "HOME");
            serve.env(
                "USERPROFILE",
                named.map_or(home.as_os_str(), |(_, h)| h.as_ref()),
            );
        }
        serve.envs(env.iter().copied());
        let (child, said) = client::start_said(serve).unwrap();
        note(&format!("core {} started", child.id()));
        Core {
            _watchdog: Watchdog::patient(&child, patience, said.clone()),
            child,
            data: data.to_owned(),
            said,
        }
    }

    /// A new connection that offers versions `v` and proves `auth`; a
    /// refusal is the `Err`.
    pub fn hello_with(&self, v: Versions, auth: Option<Auth>) -> Result<Client, Refuse> {
        let stream = client::connect(&self.data).unwrap();
        // A frame that never comes fails the test instead of hanging it.
        #[cfg(unix)]
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(20)))
            .unwrap();
        let hello = Hello {
            v,
            role: Role::Cli,
            client: "test".into(),
            auth,
            abilities: Vec::new(),
        };
        Client::hello(stream, hello).unwrap()
    }

    /// A new connection with neither a device key nor a session token.
    pub fn anonymous(&self) -> Client {
        self.hello_with(Versions(VERSION, VERSION), None).unwrap()
    }

    /// A new connection as device `id` proving the key `[key; 32]`, which
    /// registers it under `name` if given.
    pub fn device_as(&self, id: DeviceId, key: u8, name: Option<&str>) -> Result<Client, Refuse> {
        let auth = Auth::Device {
            device: id,
            key: Secret([key; 32]),
            register: name.map(|name| Register { name: name.into() }),
        };
        self.hello_with(Versions(VERSION, VERSION), Some(auth))
    }

    /// A new connection, as a newly registered device.
    pub fn device(&self) -> Client {
        let c = self.device_as(DeviceId::mint(), 1, Some("test")).unwrap();
        assert_eq!(c.welcome.identity, Identity::Device);
        c
    }

    /// A connection with a session token, as `tasktap ask` or a hook makes.
    pub fn agent(&self, token: &Secret) -> Agent {
        let auth = Auth::Session {
            token: token.clone(),
        };
        let c = self
            .hello_with(Versions(VERSION, VERSION), Some(auth))
            .unwrap();
        assert_eq!(c.welcome.identity, Identity::Session);
        Agent {
            c,
            events: 0,
            asked: Vec::new(),
            early: Vec::new(),
            next: 1000,
        }
    }

    /// A device watching every collection.
    pub fn watch(&self) -> Watch {
        Watch {
            said: Some(self.said.clone()),
            ..Watch::new(self.device())
        }
    }

    /// Retires the core and waits until it has exited.
    pub fn stop(mut self) {
        let mut c = self.device();
        let retire = Retire { when: When::Now };
        c.call::<call::CoreRetire>(&retire).unwrap().unwrap();
        assert!(self.child.wait().unwrap().success());
    }

    pub fn running(&mut self) -> bool {
        self.child.try_wait().unwrap().is_none()
    }

    /// Waits for the core to exit.
    pub fn exit(&mut self) -> ExitStatus {
        self.child.wait().unwrap()
    }

    pub fn wait(&mut self) {
        assert!(self.exit().success());
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Waits until the core has exited on its own, and says how.
    pub fn exited(&mut self) -> std::process::ExitStatus {
        self.child.wait().unwrap()
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        if self.child.try_wait().unwrap().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// Every row a subscriber holds, applied from its snapshot and changes.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Model {
    pub rev: u64,
    pub thoughts: BTreeMap<ThoughtId, Thought>,
    pub projects: BTreeMap<ProjectId, Project>,
    pub sessions: BTreeMap<SessionId, Session>,
    pub terminals: BTreeMap<TerminalId, Terminal>,
    pub questions: BTreeMap<QuestionId, Question>,
    pub results: BTreeMap<ResultId, TurnResult>,
    pub glance: Option<Glance>,
    pub agents: BTreeMap<String, tasktap_proto::AgentHealth>,
    /// The preferences that are stored; one that is not has its default.
    pub prefs: HashMap<tasktap_proto::PrefKey, tasktap_proto::PrefValue>,
    pub dictations: BTreeMap<tasktap_proto::DictationId, tasktap_proto::Dictation>,
    pub previews: BTreeMap<tasktap_proto::PreviewId, tasktap_proto::Preview>,
    pub cards: BTreeMap<tasktap_proto::CardId, tasktap_proto::Card>,
    pub looks: BTreeMap<tasktap_proto::LookId, tasktap_proto::Look>,
}

impl Model {
    fn apply(&mut self, change: &Change) {
        assert!(change.snap || change.rev.get() > self.rev, "out of order");
        self.rev = change.rev.get();
        macro_rules! rows {
            ($map:ident, $rows:expr) => {{
                for row in &$rows.put {
                    self.$map.insert(row.id, row.clone());
                }
                for id in &$rows.del {
                    assert!(
                        self.$map.remove(id).is_some(),
                        "a delete of {id:?}, never put"
                    );
                }
            }};
        }
        for set in &change.sets {
            match set {
                Set::Thoughts(r) => rows!(thoughts, r),
                Set::Projects(r) => rows!(projects, r),
                Set::Sessions(r) => rows!(sessions, r),
                Set::Terminals(r) => rows!(terminals, r),
                Set::Questions(r) => rows!(questions, r),
                Set::Results(r) => rows!(results, r),
                Set::Glance { put } => self.glance = put.last().cloned(),
                Set::Agents(r) => {
                    for a in &r.put {
                        self.agents.insert(a.id.clone(), a.clone());
                    }
                    for id in &r.del {
                        self.agents.remove(id);
                    }
                }
                Set::Prefs(r) => {
                    for p in &r.put {
                        self.prefs.insert(p.value.key(), p.value.clone());
                    }
                    for key in &r.del {
                        self.prefs.remove(key);
                    }
                }
                Set::Dictations(r) => rows!(dictations, r),
                Set::Previews(r) => rows!(previews, r),
                Set::Cards(r) => rows!(cards, r),
                Set::Looks(r) => rows!(looks, r),
                _ => {}
            }
        }
    }

    pub fn thought(&self, id: ThoughtId) -> &Thought {
        self.thoughts.get(&id).expect("no such thought")
    }

    pub fn status(&self, id: ThoughtId) -> Status {
        self.thought(id).status
    }

    pub fn session(&self, id: SessionId) -> &Session {
        self.sessions.get(&id).expect("no such session")
    }

    pub fn question(&self, id: QuestionId) -> &Question {
        self.questions.get(&id).expect("no such question")
    }

    pub fn glance(&self) -> &Glance {
        self.glance.as_ref().expect("no glance")
    }

    /// The results of a thought.
    pub fn results_of(&self, id: ThoughtId) -> Vec<&TurnResult> {
        self.results
            .values()
            .filter(|r| r.thought_id == id)
            .collect()
    }

    /// Every stored row as it stands, without revisions or memory-only
    /// fields: what must survive a restart.
    pub fn stored(&self) -> Value {
        fn rows<'a, R: serde::Serialize + 'a>(rows: impl Iterator<Item = &'a R>) -> Value {
            let strip = |row: &R| {
                let mut v = json!(row);
                v.as_object_mut().unwrap().remove("rev");
                v.as_object_mut().unwrap().remove("activity");
                v
            };
            Value::Array(rows.map(strip).collect())
        }
        json!({
            "thoughts": rows(self.thoughts.values()),
            "projects": rows(self.projects.values()),
            "questions": rows(self.questions.values()),
            "results": rows(self.results.values()),
        })
    }

    /// The highest revision any row carries.
    pub fn top_rev(&self) -> u64 {
        let revs = (self.thoughts.values().map(|r| r.rev))
            .chain(self.projects.values().map(|r| r.rev))
            .chain(self.sessions.values().map(|r| r.rev))
            .chain(self.terminals.values().map(|r| r.rev))
            .chain(self.questions.values().map(|r| r.rev))
            .chain(self.results.values().map(|r| r.rev));
        revs.map(|r| r.get()).max().unwrap_or(0)
    }
}

/// A device subscribed to every collection, as a page is. Its calls apply
/// the changes that arrive meanwhile, in order.
pub struct Watch {
    pub c: Client,
    pub model: Model,
    /// Each thought's statuses in the order its rows arrived, repeats folded.
    pub statuses: HashMap<ThoughtId, Vec<Status>>,
    /// The frames of a change cut into several, until its last arrives.
    part: Option<Change>,
    next: u32,
    /// What the core wrote, said when it is gone.
    pub said: Option<client::Said>,
}

impl Watch {
    pub fn new(mut c: Client) -> Watch {
        let id = CallId(1);
        let sub = Subscribe {
            collections: ALL.to_vec(),
        };
        c.send(&call::Sub::request(id, &sub)).unwrap();
        let mut w = Watch {
            c,
            model: Model::default(),
            statuses: HashMap::new(),
            part: None,
            next: 10,
            said: None,
        };
        loop {
            match w.c.recv().unwrap() {
                Frame::Control(Control::Change(change)) => w.apply(change),
                Frame::Control(Control::Reply(reply)) if reply.id == id => {
                    call::Sub::result(reply.outcome).unwrap();
                    return w;
                }
                other => panic!("unexpected {other:?}"),
            }
        }
    }

    /// Applies a change whole: one cut into several frames once its last,
    /// the one not marked `more`, has arrived.
    fn apply(&mut self, change: Change) {
        let change = match self.part.take() {
            Some(mut whole) => {
                assert_eq!(whole.rev, change.rev, "a frame of another change");
                whole.sets.extend(change.sets);
                Change {
                    more: change.more,
                    ..whole
                }
            }
            None => change,
        };
        if change.more {
            self.part = Some(change);
            return;
        }
        self.model.apply(&change);
        for set in &change.sets {
            match set {
                Set::Sessions(rows) => {
                    for s in &rows.put {
                        note(&format!("session {} is {:?}", s.id.uuid(), s.state));
                    }
                }
                Set::Terminals(rows) => {
                    for t in &rows.put {
                        note(&format!("terminal {} is {:?}", t.id.uuid(), t.state));
                    }
                }
                _ => {}
            }
            if let Set::Thoughts(rows) = set {
                for t in &rows.put {
                    let seen = self.statuses.entry(t.id).or_default();
                    if seen.last() != Some(&t.status) {
                        seen.push(t.status);
                    }
                }
            }
        }
    }

    /// Takes the next frame: a change is applied, a reply returned.
    fn step(&mut self) -> Option<(CallId, Outcome)> {
        let frame = match self.c.recv() {
            Ok(frame) => frame,
            Err(e) => self.gone(e),
        };
        match frame {
            Frame::Control(Control::Change(change)) => {
                self.apply(change);
                None
            }
            Frame::Control(Control::Reply(reply)) => Some((reply.id, reply.outcome)),
            other => panic!("unexpected {other:?}"),
        }
    }

    pub fn send<C: Call>(&mut self, args: &C::Args) -> CallId {
        let id = CallId(self.next);
        self.next += 1;
        if let Err(e) = self.c.send(&C::request(id, args)) {
            self.gone(e)
        }
        id
    }

    /// The core is gone, or does not answer: with what it wrote last.
    fn gone(&self, e: std::io::Error) -> ! {
        let said = self.said.as_ref().map(last_words).unwrap_or_default();
        panic!("{e}: the core is gone, or does not answer\n{said}")
    }

    /// Waits for the reply to a call sent with [`Watch::send`].
    pub fn reply<C: Call>(&mut self, id: CallId) -> Result<C::Result, Error> {
        loop {
            if let Some((got, outcome)) = self.step() {
                assert_eq!(got, id, "a reply to another call");
                return C::result(outcome);
            }
        }
    }

    /// Waits for the replies to calls sent with [`Watch::send`], which may
    /// come in any order: the results, in the order of `ids`. A reply to
    /// another call is not waited for.
    pub fn replies<C: Call>(&mut self, ids: &[CallId]) -> Vec<Result<C::Result, Error>> {
        let mut got: Vec<Option<Result<C::Result, Error>>> = ids.iter().map(|_| None).collect();
        while got.iter().any(Option::is_none) {
            if let Some((id, outcome)) = self.step()
                && let Some(at) = ids.iter().position(|i| *i == id)
            {
                got[at] = Some(C::result(outcome));
            }
        }
        got.into_iter().flatten().collect()
    }

    pub fn call<C: Call>(&mut self, args: &C::Args) -> Result<C::Result, Error> {
        let id = self.send::<C>(args);
        self.reply::<C>(id)
    }

    pub fn ok<C: Call>(&mut self, args: &C::Args) -> C::Result {
        self.call::<C>(args)
            .unwrap_or_else(|e| panic!("{} was refused: {e}", C::NAME.as_str()))
    }

    pub fn refused<C: Call>(&mut self, args: &C::Args) -> Error
    where
        C::Result: std::fmt::Debug,
    {
        match self.call::<C>(args) {
            Ok(r) => panic!("{} was not refused: {r:?}", C::NAME.as_str()),
            Err(e) => e,
        }
    }

    /// Every change committed before now has arrived: the core answers a
    /// call only after what it already sent.
    pub fn sync(&mut self) {
        self.ok::<call::CoreStatus>(&Empty {});
    }

    /// Applies changes until `ready` holds.
    pub fn until(&mut self, what: &str, ready: impl Fn(&Model) -> bool) {
        while !ready(&self.model) {
            if let Some((id, _)) = self.step() {
                panic!("a reply to {id:?} while waiting for {what}");
            }
        }
    }

    /// A call by name with any arguments.
    pub fn raw(&mut self, name: &str, args: Value) -> Outcome {
        let id = CallId(self.next);
        self.next += 1;
        let name = name.to_owned();
        self.c
            .send(&Control::Call(Request { id, name, args }))
            .unwrap();
        loop {
            if let Some((got, outcome)) = self.step() {
                assert_eq!(got, id);
                return outcome;
            }
        }
    }
}

/// A connection holding a session token, standing in for an agent: what
/// `tasktap hook`, `tasktap event` and `tasktap ask` will send (design §4).
pub struct Agent {
    pub c: Client,
    /// The id of the last event sent; unique in the test, as a hook's own ids are.
    events: usize,
    /// Asks sent and not answered yet, by request key.
    asked: Vec<(String, CallId)>,
    /// Replies that came before they were looked for.
    early: Vec<(CallId, Outcome)>,
    next: u32,
}

impl Agent {
    pub fn try_say(&mut self, event: Said) -> Result<(), Error> {
        self.try_say_as(None, false, event)
    }

    /// An event that names its turn, or comes from a sub-agent.
    pub fn try_say_as(
        &mut self,
        turn: Option<u32>,
        subagent: bool,
        event: Said,
    ) -> Result<(), Error> {
        static NEXT: AtomicUsize = AtomicUsize::new(1);
        self.events = NEXT.fetch_add(1, Ordering::Relaxed);
        let id = format!("event-{}", self.events);
        let event = SessionEvent {
            id,
            turn,
            subagent,
            event,
            resume: None,
        };
        self.c.call::<call::SessionEvent>(&event).unwrap()
    }

    pub fn say(&mut self, event: Said) {
        let shown = format!("{event:?}");
        self.try_say(event)
            .unwrap_or_else(|e| panic!("{shown} was refused: {e}"));
    }

    /// The same event id again.
    pub fn repeat(&mut self, event: Said) {
        let id = format!("event-{}", self.events);
        let call = SessionEvent {
            id,
            turn: None,
            subagent: false,
            event,
            resume: None,
        };
        self.c.call::<call::SessionEvent>(&call).unwrap().unwrap();
    }

    pub fn ready(&mut self) {
        self.say(Said::Ready);
    }

    pub fn begin(&mut self) {
        self.say(Said::TurnStarted { prompt: None });
    }

    pub fn finish(&mut self, answer: &str) {
        self.say(Said::TurnFinished {
            answer: Some(answer.into()),
        });
    }

    /// `question.ask` for a confirm question, without waiting for the reply.
    pub fn ask(&mut self, request: &str, prompt: &str) {
        self.ask_with(confirm(request, prompt));
    }

    pub fn ask_with(&mut self, ask: Ask) {
        let id = CallId(self.next);
        self.next += 1;
        self.asked.push((ask.request.clone(), id));
        self.c.send(&call::QuestionAsk::request(id, &ask)).unwrap();
    }

    /// The reply to the ask sent with this key: the answer, or why there is none.
    pub fn reply(&mut self, request: &str) -> Result<Answer, Error> {
        let at = (self.asked.iter())
            .position(|(r, _)| r == request)
            .expect("no such ask pending");
        let (_, id) = self.asked.remove(at);
        if let Some(i) = self.early.iter().position(|(c, _)| *c == id) {
            return call::QuestionAsk::result(self.early.remove(i).1);
        }
        loop {
            match self.c.recv().unwrap() {
                Frame::Control(Control::Reply(reply)) if reply.id == id => {
                    return call::QuestionAsk::result(reply.outcome);
                }
                Frame::Control(Control::Reply(reply)) => self.early.push((reply.id, reply.outcome)),
                other => panic!("unexpected {other:?}"),
            }
        }
    }

    /// Everything this connection sent before has been handled.
    pub fn sync(&mut self) {
        self.c.call::<call::CoreStatus>(&Empty {}).unwrap().unwrap();
    }

    /// `question.ask` and its reply.
    pub fn ask_now(&mut self, ask: Ask) -> Result<Answer, Error> {
        let request = ask.request.clone();
        self.ask_with(ask);
        self.reply(&request)
    }

    pub fn received(&mut self, request: &str) -> Result<(), Error> {
        let key = AskKey {
            request: request.into(),
            undelivered: false,
        };
        self.c.call::<call::QuestionReceived>(&key).unwrap()
    }

    pub fn withdraw(&mut self, request: &str) -> Result<(), Error> {
        let key = AskKey {
            request: request.into(),
            undelivered: false,
        };
        self.c.call::<call::QuestionWithdraw>(&key).unwrap()
    }

    /// A call by name with any arguments.
    pub fn raw(&mut self, name: &str, args: Value) -> Outcome {
        raw(&mut self.c, name, args)
    }
}

/// A call by name, for names and arguments the typed calls cannot make.
/// Other frames are dropped meanwhile.
pub fn raw(c: &mut Client, name: &str, args: Value) -> Outcome {
    let id = CallId(9000);
    let name = name.to_owned();
    c.send(&Control::Call(Request { id, name, args })).unwrap();
    loop {
        if let Frame::Control(Control::Reply(reply)) = c.recv().unwrap()
            && reply.id == id
        {
            return reply.outcome;
        }
    }
}

/// `core.status` answers, at the version this build speaks and with no terminal.
pub fn status(c: &mut Client) {
    let status = c.call::<call::CoreStatus>(&Empty {}).unwrap().unwrap();
    assert_eq!(status.v, Versions(VERSION, VERSION));
    assert_eq!(status.terminals, 0);
}

/// The core closed this connection.
pub fn dropped(c: &mut Client) {
    loop {
        match c.recv() {
            Err(e) => {
                let ended = [ErrorKind::UnexpectedEof, ErrorKind::ConnectionReset];
                assert!(ended.contains(&e.kind()), "{e}");
                return;
            }
            // What was queued before the connection ended may still arrive.
            Ok(Frame::Data(_) | Frame::Control(Control::Credit(_))) => {}
            Ok(frame) => panic!("expected the connection to end, got {frame:?}"),
        }
    }
}

pub fn confirm(request: &str, prompt: &str) -> Ask {
    Ask {
        request: request.into(),
        kind: QuestionKind::Confirm,
        prompt: prompt.into(),
        detail: None,
        source: None,
    }
}

pub fn code(outcome: Outcome) -> Code {
    match outcome {
        Outcome::Err(e) => e.code,
        Outcome::Ok(v) => panic!("expected an error, got {v}"),
    }
}

pub fn typed(id: ThoughtId, text: &str) -> Capture {
    Capture {
        id,
        text: text.into(),
        strokes: Vec::new(),
        source: Source::Typed,
        mode: None,
        project_id: None,
        card_id: None,
        session_id: None,
        agent: None,
        model: None,
        weight: None,
        current: None,
        view: None,
        auto: false,
        taken: None,
    }
}

pub fn clear(project: ProjectId) -> Route {
    Route::Clear {
        to: Place::Project(project),
        brief: "Fix the failing build".into(),
        said: None,
    }
}

/// A folder of `data` that holds this binary as `fixture-agent`, the
/// program the core launches for the fixture agents.
pub fn agents(data: &Path) -> PathBuf {
    agents_of(Path::new(EXE), data)
}

/// The same with `exe` as that program: the agents a core of another build
/// starts are that build's own.
pub fn agents_of(exe: &Path, data: &Path) -> PathBuf {
    let folder = data.join("agents");
    std::fs::create_dir_all(&folder).unwrap();
    if as_batch_files() {
        assert_eq!(exe, Path::new(EXE), "batch files wrap this build only");
        batch_file(&folder, "fixture-agent");
        return folder;
    }
    let program = folder
        .join("fixture-agent")
        .with_extension(std::env::consts::EXE_EXTENSION);
    // Never a copy onto a link to the binary itself, which would empty it.
    if !program.exists() && link(exe, &program).is_err() {
        std::fs::copy(exe, &program).unwrap();
    }
    folder
}

/// A link to the binary `exe` at `to`: symbolic on macOS, where a second name
/// for the binary can get it killed as the shims' links would
/// (`roles::shim::install`).
fn link(exe: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    return std::os::unix::fs::symlink(exe, to);
    #[cfg(not(target_os = "macos"))]
    return std::fs::hard_link(exe, to);
}

/// Whether the tests install their agents as npm installs a tool on Windows
/// (`TASKTAP_TEST_BATCH_AGENTS`): a batch file that runs the program, which
/// the command prompt runs. The suite passes either way.
pub fn as_batch_files() -> bool {
    cfg!(windows) && std::env::var_os("TASKTAP_TEST_BATCH_AGENTS").is_some()
}

/// What npm's cmd-shim writes for a tool, with `RUN` where the program and
/// its script are named.
pub const NPM_SHIM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & RUN %*\r\n";

/// Installs this binary in `folder` under `name` as a batch file around a
/// copy of it (a link would be the binary itself, which the core runs too),
/// and returns the copy.
pub fn batch_file(folder: &Path, name: &str) -> PathBuf {
    let module = folder.join("node_modules").join(name);
    std::fs::create_dir_all(&module).unwrap();
    let program = module.join(name).with_extension("exe");
    if !program.exists() {
        std::fs::copy(EXE, &program).unwrap();
        let run = format!(r#""%dp0%\node_modules\{name}\{name}.exe""#);
        let shim = NPM_SHIM.replace("RUN", &run);
        std::fs::write(folder.join(name).with_extension("cmd"), shim).unwrap();
    }
    program
}

/// Whether a process runs `program`, a file of its own: Windows lets
/// nobody write to a program that runs.
#[cfg(windows)]
pub fn runs(program: &Path) -> bool {
    std::fs::OpenOptions::new()
        .write(true)
        .open(program)
        .is_err()
}

/// This process's PATH with `first` before it.
pub fn path_with(first: &Path) -> String {
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let dirs = std::iter::once(first.to_owned()).chain(std::env::split_paths(&inherited));
    std::env::join_paths(dirs).unwrap().into_string().unwrap()
}

/// What a terminal shows, without escapes and line ends.
pub fn plain(bytes: &[u8]) -> String {
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

/// A device attached to one terminal: what it shows, and typing into it as
/// a person does.
pub struct Screen {
    c: Client,
    s: StreamId,
    bytes: Vec<u8>,
    closed: bool,
}

impl Screen {
    /// Attaches to terminal `id` from the start of what it kept.
    pub fn open(core: &Core, id: TerminalId) -> Screen {
        Self::start(core, id, None)
    }

    /// Starts terminal `id` as `start` says, and attaches to it.
    pub fn start(core: &Core, id: TerminalId, start: Option<StartTerminal>) -> Screen {
        let mut c = core.device();
        let open = OpenTerminal {
            id,
            start,
            cols: 100,
            rows: 30,
            from: None,
            credit: 1 << 20,
        };
        let opened = c.opened::<call::TerminalOpen>(&open, 1 << 20, true);
        let opened = opened.unwrap().expect("the terminal opens");
        note(&format!("a screen opened on terminal {}", id.uuid()));
        Screen {
            c,
            s: opened.s,
            bytes: Vec::new(),
            closed: false,
        }
    }

    /// Types `line` and Enter.
    pub fn line(&mut self, line: &str) {
        self.c
            .write(self.s, format!("{line}\r").as_bytes())
            .unwrap();
        note(&format!("a screen typed {line:?}"));
    }

    /// Types one byte and says whether the core granted it back, as it does
    /// once the byte is written, within `wait`.
    #[cfg(unix)]
    pub fn acknowledged(&mut self, wait: std::time::Duration) -> bool {
        let before = self.c.credit(self.s);
        assert_eq!(self.c.send_some(self.s, b" ").unwrap(), 1, "no credit");
        let patience = self.c.stream().read_timeout().unwrap();
        self.c.stream().set_read_timeout(Some(wait)).unwrap();
        let deadline = std::time::Instant::now() + wait;
        while self.c.credit(self.s) < before && std::time::Instant::now() < deadline {
            match self.c.recv() {
                Ok(Frame::Data(Data { s, bytes })) if s == self.s => self.bytes.extend(bytes),
                Ok(_) => {}
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => break,
                Err(e) => panic!("the core went away: {e}"),
            }
        }
        self.c.stream().set_read_timeout(patience).unwrap();
        self.c.credit(self.s) >= before
    }

    /// Sends `bytes` as they are, as a terminal answers its program.
    pub fn write(&mut self, bytes: &[u8]) {
        self.c.write(self.s, bytes).unwrap();
    }

    /// What it received, escapes and all.
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn text(&self) -> String {
        plain(&self.bytes)
    }

    /// Reads until the bytes received hold `what` and something after it.
    pub fn until_after(&mut self, what: &[u8]) {
        let after = |bytes: &[u8]| {
            let at = bytes.windows(what.len()).position(|w| w == what);
            at.is_some_and(|at| bytes.len() > at + what.len())
        };
        while !after(&self.bytes) {
            let gone = self.closed || !self.pump();
            assert!(!gone, "it ended before {what:?}: {:?}", self.text());
        }
    }

    /// Reads until the bytes received hold `what`, escapes and all.
    pub fn until_bytes(&mut self, what: &[u8]) {
        while !self.bytes.windows(what.len()).any(|w| w == what) {
            let gone = self.closed || !self.pump();
            assert!(!gone, "it ended before {what:?}: {:?}", self.text());
        }
    }

    /// Reads until it shows `what`.
    pub fn until(&mut self, what: &str) {
        while !self.text().contains(what) {
            let gone = self.closed || !self.pump();
            assert!(!gone, "it ended before {what:?}: {:?}", self.text());
        }
    }

    /// Reads until the terminal has ended.
    pub fn ended(&mut self) {
        while !self.closed {
            assert!(self.pump(), "the core went away first");
        }
    }

    /// Takes the next frame; false once the core is gone.
    pub fn pump(&mut self) -> bool {
        match self.c.recv() {
            Ok(Frame::Data(Data { s, bytes })) if s == self.s => self.bytes.extend(bytes),
            Ok(Frame::Control(Control::Close(close))) if close.s == self.s => self.closed = true,
            Ok(_) => {}
            Err(_) => return false,
        }
        true
    }
}

impl Drop for Screen {
    fn drop(&mut self) {
        note("a screen closed");
    }
}

/// A folder as the core keeps it (`project.add`): canonical, and on Windows
/// without the `\\?\` a canonical path begins with there.
#[allow(dead_code)]
pub fn kept(folder: impl AsRef<Path>) -> PathBuf {
    let path = std::fs::canonicalize(folder).unwrap();
    let text = path.to_string_lossy();
    PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned())
}

/// A core with a project and its fixtures selected, the router answering
/// `clear` for that project and the clock held at the wall time.
pub struct Scene {
    // Declared first, so the core ends before its folder is removed.
    pub core: Core,
    pub w: Watch,
    pub data: Folder,
    pub project: ProjectId,
    pub now: u64,
    route: Route,
    refuse: Option<String>,
    /// Follow-ups wait, untyped, until the next script without it.
    pub pause: bool,
    /// Runs start for real, with this agent, through the real launcher.
    pub agent: Option<String>,
}

impl Scene {
    pub fn new(prefix: &str) -> Scene {
        let data = Folder::new(prefix);
        let core = Core::start(&data.0);
        Self::on(core, data)
    }

    /// The scene with the core's own clock: holds end on real timers.
    pub fn wall(prefix: &str) -> Scene {
        let data = Folder::new(prefix);
        let core = Core::start(&data.0);
        Self::build(core, data, false)
    }

    /// A scene whose runs start for real: the real launcher starts `agent`,
    /// found on the core's PATH, in real terminals. The router is still the
    /// fixture's.
    pub fn real(prefix: &str, agent: &str) -> Scene {
        let data = Folder::new(prefix);
        let core = Core::with_agents(&data.0);
        Self::on(core, data).running(agent)
    }

    /// The same scene with its runs started for real, with `agent`.
    pub fn running(mut self, agent: &str) -> Scene {
        self.agent = Some(agent.into());
        self.log();
        self
    }

    /// The scene on a core that is already running, as after a restart.
    pub fn on(core: Core, data: Folder) -> Scene {
        Self::build(core, data, true)
    }

    /// The scene on `core` with its project in `folder`, its runs started
    /// for real with `agent`.
    pub fn in_folder(core: Core, data: Folder, folder: &Path, agent: &str) -> Scene {
        Self::built(core, data, folder.to_owned(), true).running(agent)
    }

    fn build(core: Core, data: Folder, manual: bool) -> Scene {
        let folder = data.0.join("app");
        Self::built(core, data, folder, manual)
    }

    fn built(core: Core, data: Folder, folder: PathBuf, manual: bool) -> Scene {
        let mut w = core.watch();
        std::fs::create_dir_all(&folder).unwrap();
        let add = tasktap_proto::AddProject {
            id: ProjectId::mint(),
            folder: folder.to_str().unwrap().into(),
            name: None,
            create: false,
        };
        let project = w.ok::<call::ProjectAdd>(&add);
        let mut scene = Scene {
            core,
            w,
            data,
            project,
            now: wall_ms(),
            route: clear(project),
            refuse: None,
            pause: false,
            agent: None,
        };
        scene.log();
        if manual {
            scene.tick(0);
        }
        scene
    }

    /// Adds a project for another folder of the data folder.
    pub fn project(&mut self, name: &str) -> ProjectId {
        let folder = self.data.0.join(name);
        std::fs::create_dir_all(&folder).unwrap();
        let add = tasktap_proto::AddProject {
            id: ProjectId::mint(),
            folder: folder.to_str().unwrap().into(),
            name: None,
            create: false,
        };
        self.w.ok::<call::ProjectAdd>(&add)
    }

    /// The question `glance` shows, once the change that opened one has arrived.
    pub fn shown(&mut self) -> QuestionId {
        self.w
            .until("a question opens", |m| m.glance().question.is_some());
        self.w.model.glance().question.unwrap()
    }

    /// Moves the core's clock on; holds that end by then end before it returns.
    pub fn tick(&mut self, ms: u64) {
        self.now += ms;
        let now = time(self.now);
        self.w.ok::<call::FixtureClock>(&FixtureClock { now });
    }

    pub fn script(&mut self, route: Route, refuse: Option<&str>) -> FixtureLog {
        self.route = route;
        self.refuse = refuse.map(Into::into);
        self.log()
    }

    /// What the fixture launcher and host were asked so far.
    pub fn log(&mut self) -> FixtureLog {
        let script = tasktap_proto::FixtureScript {
            route: self.route.clone(),
            refuse: self.refuse.clone(),
            unrecordable: false,
            pause: self.pause,
            agent: self.agent.clone(),
        };
        self.w.ok::<call::FixtureScript>(&script)
    }

    pub fn capture(&mut self, text: &str) -> ThoughtId {
        let id = ThoughtId::mint();
        self.w.ok::<call::ThoughtCapture>(&typed(id, text));
        id
    }

    /// A thought launched after its hold, with the stand-in agent of its
    /// session connected, ready and in its first turn.
    pub fn launch(&mut self, text: &str) -> (ThoughtId, SessionId, Agent) {
        let t = self.capture(text);
        assert_eq!(self.w.model.status(t), Status::Routed);
        self.tick(HOLD_MS);
        assert_eq!(self.w.model.status(t), Status::Working);
        let s = self.w.model.thought(t).session_id.unwrap();
        let mut agent = self.agent(s);
        agent.ready();
        agent.begin();
        self.w.sync();
        (t, s, agent)
    }

    /// A stand-in agent with the token the session's launch was given.
    pub fn agent(&mut self, session: SessionId) -> Agent {
        let log = self.log();
        let launch = (log.launched.iter())
            .find(|l| l.session == session)
            .expect("the session was never launched");
        self.core.agent(&launch.token)
    }
}
