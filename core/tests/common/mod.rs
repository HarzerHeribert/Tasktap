//! What the questions and loop tests share: the real binary on its own
//! folder, devices and stand-in agents that speak to it through `client.rs`,
//! a model of every record a device sees, and the fixture router, launcher
//! and clock (design §13). No test reaches into the core.
#![allow(dead_code, reason = "each test file uses its own part")]

use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tasktap_core::client::{self, Client};
use tasktap_proto::call::{self, Call, Code, Error};
use tasktap_proto::{
    Answer, Ask, AskKey, Auth, CallId, Capture, Change, Collection, Control, DeviceId, Empty,
    Event as Said, FixtureClock, FixtureLog, FixtureRoute, Frame, Glance, Hello, Identity, Outcome,
    Place, Project, ProjectId, Question, QuestionId, QuestionKind, Register, Request, ResultId,
    Retire, Role, Secret, Session, SessionEvent, SessionId, Set, Source, Status, Subscribe,
    Terminal, TerminalId, Thought, ThoughtId, Time, TurnResult, VERSION, Versions, When,
};

mod watchdog;
pub use watchdog::Watchdog;

pub const EXE: &str = env!("CARGO_BIN_EXE_tasktap");
/// Milliseconds a thought is held while the preference is unset.
pub const HOLD_MS: u64 = match tasktap_proto::PrefKey::Hold.default() {
    tasktap_proto::PrefValue::Hold(seconds) => seconds as u64 * 1000,
};
pub const ALL: [Collection; 10] = [
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

/// A core this test started; killed if the test ends with it still running.
pub struct Core {
    child: Child,
    pub data: PathBuf,
    _watchdog: Watchdog,
}

impl Core {
    pub fn start(data: &Path) -> Core {
        Self::start_with(data, &[])
    }

    pub fn start_with(data: &Path, extra: &[&str]) -> Core {
        let mut serve = client::serve_command(Path::new(EXE), data);
        serve.args(["--idle-ms", "600000"]).args(extra);
        let child = client::start(serve).unwrap();
        Core {
            _watchdog: Watchdog::new(&child),
            child,
            data: data.to_owned(),
        }
    }

    fn hello(&self, auth: Auth) -> Client {
        let stream = client::connect(&self.data).unwrap();
        // A frame that never comes fails the test instead of hanging it.
        #[cfg(unix)]
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(20)))
            .unwrap();
        let hello = Hello {
            v: Versions(VERSION, VERSION),
            role: Role::Cli,
            client: "questions test".into(),
            auth: Some(auth),
            abilities: Vec::new(),
        };
        Client::hello(stream, hello).unwrap().unwrap()
    }

    /// A new connection, as a newly registered device.
    pub fn device(&self) -> Client {
        let c = self.hello(Auth::Device {
            device: DeviceId::mint(),
            key: Secret([1; 32]),
            register: Some(Register {
                name: "test".into(),
            }),
        });
        assert_eq!(c.welcome.identity, Identity::Device);
        c
    }

    /// A connection with a session token, as `tasktap ask` or a hook makes.
    pub fn agent(&self, token: &Secret) -> Agent {
        let c = self.hello(Auth::Session {
            token: token.clone(),
        });
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
        Watch::new(self.device())
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

    pub fn wait(&mut self) {
        assert!(self.child.wait().unwrap().success());
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
        match self.c.recv().unwrap() {
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
        self.c.send(&C::request(id, args)).unwrap();
        id
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
    events: u32,
    /// Asks sent and not answered yet, by request key.
    asked: Vec<(String, CallId)>,
    /// Replies that came before they were looked for.
    early: Vec<(CallId, Outcome)>,
    next: u32,
}

impl Agent {
    pub fn try_say(&mut self, event: Said) -> Result<(), Error> {
        self.events += 1;
        let id = format!("event-{}", self.events);
        self.c
            .call::<call::SessionEvent>(&SessionEvent { id, event })
            .unwrap()
    }

    pub fn say(&mut self, event: Said) {
        let shown = format!("{event:?}");
        self.try_say(event)
            .unwrap_or_else(|e| panic!("{shown} was refused: {e}"));
    }

    /// The same event id again.
    pub fn repeat(&mut self, event: Said) {
        let id = format!("event-{}", self.events);
        let call = SessionEvent { id, event };
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
        };
        self.c.call::<call::QuestionReceived>(&key).unwrap()
    }

    pub fn withdraw(&mut self, request: &str) -> Result<(), Error> {
        let key = AskKey {
            request: request.into(),
        };
        self.c.call::<call::QuestionWithdraw>(&key).unwrap()
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
            if let Frame::Control(Control::Reply(reply)) = self.c.recv().unwrap()
                && reply.id == id
            {
                return reply.outcome;
            }
        }
    }
}

pub fn confirm(request: &str, prompt: &str) -> Ask {
    Ask {
        request: request.into(),
        kind: QuestionKind::Confirm,
        prompt: prompt.into(),
        detail: None,
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
        session_id: None,
    }
}

pub fn clear(project: ProjectId) -> FixtureRoute {
    FixtureRoute::Clear {
        to: Place::Project(project),
        brief: "Fix the failing build".into(),
    }
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
    route: FixtureRoute,
    refuse: Option<String>,
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

    /// The scene on a core that is already running, as after a restart.
    pub fn on(core: Core, data: Folder) -> Scene {
        Self::build(core, data, true)
    }

    fn build(core: Core, data: Folder, manual: bool) -> Scene {
        let mut w = core.watch();
        let folder = data.0.join("app");
        std::fs::create_dir_all(&folder).unwrap();
        let add = tasktap_proto::AddProject {
            id: ProjectId::mint(),
            folder: folder.to_str().unwrap().into(),
            name: None,
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

    pub fn script(&mut self, route: FixtureRoute, refuse: Option<&str>) -> FixtureLog {
        self.route = route;
        self.refuse = refuse.map(Into::into);
        self.log()
    }

    /// What the fixture launcher and host were asked so far.
    pub fn log(&mut self) -> FixtureLog {
        let script = tasktap_proto::FixtureScript {
            route: self.route.clone(),
            refuse: self.refuse.clone(),
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
