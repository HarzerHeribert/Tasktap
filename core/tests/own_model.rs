//! Placing by a model at an address the person names (design §8, "Your own
//! model"): setting it up, the question it is asked and the answers it gives,
//! what it is allowed to reach and what a key may do, through the real binary.
//!
//! No test reaches a real model: the server is one of this file on this
//! machine, which answers in the chat-completions form and writes down every
//! request it gets, its headers among them. The credential store of a core
//! built with its fixtures is in memory. A key is built from parts, as the
//! secret-shaped strings of tests are, since GitHub refuses a push that holds
//! one.

mod common;

use common::*;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tasktap_core::route::{INSTRUCTIONS, SCHEMA, TERMS};
use tasktap_proto::{
    AddProject, Code, Empty, FixtureClock, ListModels, OwnModel, Pays, Placed, Placer, PrefKey,
    PrefValue, ProjectId, RouteBy, SetOwnModel, Status, ThoughtId, call,
};

/// What the made-up server answers a question with.
#[derive(Clone)]
enum Reply {
    /// A completion whose message holds this text.
    Says(String),
    /// A refusal with this status and body.
    Status(u16, Value),
    /// A redirect to another address.
    Redirect(String),
    /// The reply after this many milliseconds.
    After(u64, Box<Reply>),
}

/// One request the server got.
#[derive(Clone, Debug)]
struct Seen {
    method: String,
    path: String,
    authorization: Option<String>,
    body: Value,
}

#[derive(Default)]
struct State {
    seen: Vec<Seen>,
    replies: VecDeque<Reply>,
    /// The `response_format` types it answers with 400.
    rejects: Vec<&'static str>,
    models: Vec<&'static str>,
    /// It answers a list of models with this status.
    list_status: Option<u16>,
}

struct Server {
    base: String,
    st: Arc<Mutex<State>>,
}

impl Server {
    fn start() -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let st: Arc<Mutex<State>> = Default::default();
        let shared = st.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                let st = shared.clone();
                std::thread::spawn(move || serve(conn, &st));
            }
        });
        Server { base, st }
    }

    /// The address a model is at on this server.
    fn address(&self) -> String {
        format!("{}/v1", self.base)
    }

    fn with<T>(&self, f: impl FnOnce(&mut State) -> T) -> T {
        f(&mut self.st.lock().unwrap())
    }

    fn says(&self, reply: Reply) {
        self.with(|s| s.replies.push_back(reply));
    }

    /// The questions it was asked, in order.
    fn asked(&self) -> Vec<Seen> {
        let all = self.with(|s| s.seen.clone());
        all.into_iter().filter(|r| r.method == "POST").collect()
    }
}

fn serve(mut conn: TcpStream, st: &Mutex<State>) {
    let (mut data, mut chunk) = (Vec::new(), [0; 16 << 10]);
    let split = loop {
        if let Some(at) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            break at;
        }
        match conn.read(&mut chunk) {
            Ok(n @ 1..) => data.extend_from_slice(&chunk[..n]),
            _ => return,
        }
    };
    let head = String::from_utf8_lossy(&data[..split]).into_owned();
    let header = |name: &str| {
        (head.lines().skip(1))
            .find_map(|l| {
                l.split_once(':')
                    .filter(|(k, _)| k.eq_ignore_ascii_case(name))
            })
            .map(|(_, v)| v.trim().to_owned())
    };
    let length: usize = header("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = data[split + 4..].to_vec();
    while body.len() < length {
        match conn.read(&mut chunk) {
            Ok(n @ 1..) => body.extend_from_slice(&chunk[..n]),
            _ => return,
        }
    }
    let line = head.lines().next().unwrap_or_default();
    let mut parts = line.split(' ');
    let (method, path) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    );
    let body: Value = serde_json::from_slice(&body).unwrap_or_default();
    let mut reply = {
        let mut s = st.lock().unwrap();
        s.seen.push(Seen {
            method: method.into(),
            path: path.into(),
            authorization: header("authorization"),
            body: body.clone(),
        });
        match path {
            "/v1/models" => {
                let data: Vec<_> = s
                    .models
                    .iter()
                    .map(|m| json!({ "id": m, "object": "model" }))
                    .collect();
                let status = s.list_status.unwrap_or(200);
                Reply::Status(status, json!({ "object": "list", "data": data }))
            }
            "/v1/chat/completions" => {
                let format = body["response_format"]["type"].as_str().unwrap_or_default();
                match s.rejects.contains(&format) {
                    true => Reply::Status(
                        400,
                        json!({ "error": { "message": format!("{format} is not supported") } }),
                    ),
                    false => s
                        .replies
                        .pop_front()
                        .unwrap_or(Reply::Status(500, json!({}))),
                }
            }
            _ => Reply::Status(404, json!({})),
        }
    };
    while let Reply::After(ms, then) = reply {
        std::thread::sleep(Duration::from_millis(ms));
        reply = *then;
    }
    let (status, extra, text) = match reply {
        Reply::Says(text) => {
            let completion = json!({ "choices": [{ "index": 0, "finish_reason": "stop",
                "message": { "role": "assistant", "content": text } }] });
            (200, String::new(), completion.to_string())
        }
        Reply::Status(status, body) => (status, String::new(), body.to_string()),
        Reply::Redirect(to) => (307, format!("Location: {to}\r\n"), String::new()),
        Reply::After(..) => unreachable!(),
    };
    let head = format!(
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
        text.len()
    );
    let _ = conn.write_all(head.as_bytes());
    let _ = conn.write_all(text.as_bytes());
}

/// A model's answer, as the schema has it.
fn answer(confidence: &str, to: &str, brief: &str) -> String {
    json!({ "quote": "", "confidence": confidence, "to": to, "candidates": [],
            "brief": brief, "title": "" })
    .to_string()
}

const SPOKEN: &str = "um so the thing with the header, the one we did last week, it wraps on small screens \
    and, well, I want it to stay on one line, just let the menu collapse earlier";

/// A key as a service's are shaped, built from parts.
const KEY: &str = concat!("sk", "-", "proj", "-", "Zq81mXp0aLd7", "TeSt", "kEy99");

/// A core with two projects, its clock standing still, and a server of this
/// file to place with.
struct Placing {
    // First, so the core ends before its folder is removed.
    _core: Core,
    w: Watch,
    data: Folder,
    server: Server,
    app: ProjectId,
    folio: ProjectId,
}

impl Placing {
    fn new(prefix: &str) -> Placing {
        Placing::with(prefix, &[])
    }

    /// The same, the core told `env` (name, value).
    fn with(prefix: &str, env: &[(&str, &str)]) -> Placing {
        let data = Folder::new(prefix);
        let server = Server::start();
        let path = path_with(&agents(&data.0));
        let mut all = vec![("PATH", path.as_str())];
        all.extend_from_slice(env);
        let core = Core::start_env(&data.0, &[], &all);
        let mut w = core.watch();
        let mut add = |name: &str| {
            let folder = data.0.join(name);
            std::fs::create_dir_all(&folder).unwrap();
            let add = AddProject {
                id: ProjectId::mint(),
                folder: folder.to_str().unwrap().into(),
                name: None,
                create: false,
            };
            w.ok::<call::ProjectAdd>(&add)
        };
        let (app, folio) = (add("app"), add("folio"));
        std::fs::create_dir_all(data.0.join("route")).unwrap();
        w.ok::<call::FixtureClock>(&FixtureClock {
            now: time(wall_ms()),
        });
        Placing {
            _core: core,
            w,
            data,
            server,
            app,
            folio,
        }
    }

    fn set_up(&mut self, address: &str, model: &str, key: Option<&str>) {
        let args = SetOwnModel {
            address: address.into(),
            model: model.into(),
            key: key.map(Into::into),
        };
        self.w.ok::<call::OwnModelSet>(&args);
        self.w.sync();
    }

    fn own(&self) -> Option<OwnModel> {
        match self.w.model.prefs.get(&PrefKey::OwnModel) {
            Some(PrefValue::OwnModel(own)) => own.clone(),
            _ => None,
        }
    }

    fn route_by(&self) -> Option<RouteBy> {
        match self.w.model.prefs.get(&PrefKey::RouteBy) {
            Some(PrefValue::RouteBy(by)) => by.clone(),
            _ => None,
        }
    }

    fn keys(&self) -> Vec<String> {
        match self.w.model.prefs.get(&PrefKey::Keys) {
            Some(PrefValue::Keys(keys)) => keys.clone(),
            _ => Vec::new(),
        }
    }

    fn capture(&mut self, text: &str) -> ThoughtId {
        let id = ThoughtId::mint();
        let capture = tasktap_proto::Capture {
            agent: Some("fixture".into()),
            ..typed(id, text)
        };
        self.w.ok::<call::ThoughtCapture>(&capture);
        id
    }

    fn settled(&mut self, id: ThoughtId) -> tasktap_proto::Thought {
        self.w.until("placed", |m| {
            !m.thought(id).route.as_ref().is_some_and(|r| r.pending)
        });
        self.w.model.thought(id).clone()
    }

    /// A thought captured and placed, after the server was told to answer `reply`.
    fn placed(&mut self, reply: Reply) -> tasktap_proto::Thought {
        self.server.says(reply);
        let t = self.capture(SPOKEN);
        self.settled(t)
    }

    /// Who placed the thought, and why not the model where it did not.
    fn by(th: &tasktap_proto::Thought) -> (String, String) {
        let route = th.route.clone().unwrap();
        (route.by, route.fallback.unwrap_or_default())
    }

    /// The key is in no file of the data folder and no record the pages got.
    fn key_kept_nowhere(&self, key: &str) {
        let fixture = |path: &std::path::Path| {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            path.parent() == Some(&*self.data.0.join("agents")) && name.starts_with("fixture-agent")
        };
        let mut files = vec![self.data.0.clone()];
        let mut texts = Vec::new();
        while let Some(path) = files.pop() {
            match std::fs::read_dir(&path) {
                Ok(dir) => files.extend(dir.flatten().map(|e| e.path())),
                Err(_) if fixture(&path) => {}
                Err(_) => texts.push((path.clone(), std::fs::read(&path).unwrap_or_default())),
            }
        }
        let records = json!({ "stored": self.w.model.stored(),
            "prefs": self.w.model.prefs.values().collect::<Vec<_>>() });
        texts.push(("records".into(), records.to_string().into_bytes()));
        for (path, bytes) in &texts {
            assert!(
                !bytes.windows(key.len()).any(|w| w == key.as_bytes()),
                "the key is in {}",
                path.display()
            );
        }
    }
}

#[test]
fn a_sure_answer_places_a_task_a_torn_one_waits_for_a_key_and_removing_the_model_takes_its_row_out()
{
    let mut p = Placing::new("own-sure");
    let address = p.server.address();
    // Before one is set up it is not offered, and nothing is asked of it.
    let terms = p.w.ok::<call::RouteTerms>(&Empty {});
    assert!(terms.tools.iter().all(|t| t.agent != "own"));
    assert_eq!((p.own(), p.route_by()), (None, None));

    // Setting up is the agreement for its row alone, on this machine at no cost.
    p.set_up(&address, "tiny", None);
    assert_eq!(
        p.own(),
        Some(OwnModel {
            address: address.clone(),
            model: "tiny".into()
        })
    );
    let row = Placer {
        agent: "own".into(),
        model: "tiny".into(),
        on: true,
    };
    assert_eq!(
        p.route_by(),
        Some(RouteBy {
            agents: vec![row],
            terms: TERMS
        })
    );
    let terms = p.w.ok::<call::RouteTerms>(&Empty {});
    let own = terms.tools.iter().find(|t| t.agent == "own").unwrap();
    assert_eq!(
        (own.model.as_str(), own.pays, own.ms),
        ("tiny", Pays::Plan, None)
    );

    // A sure answer is taken as any model's is.
    let th = p.placed(Reply::Says(answer(
        "clear",
        "p2",
        "Keep the header on one line.",
    )));
    assert_eq!(
        (th.status, th.project_id, th.placed),
        (Status::Routed, Some(p.app), Some(Placed::Model))
    );
    assert_eq!(th.brief.as_deref(), Some("Keep the header on one line."));
    let route = th.route.unwrap();
    assert_eq!(
        (route.by.as_str(), route.model.as_deref(), route.fallback),
        ("own", Some("tiny"), None)
    );
    // It is asked what ChatGPT is: the instructions, then the request, the
    // answer held to the schema.
    let asked = p.server.asked();
    assert_eq!(asked.len(), 1);
    let body = &asked[0].body;
    assert_eq!(body["model"], "tiny");
    assert_eq!(body["stream"], false);
    assert_eq!(
        body["messages"][0],
        json!({ "role": "system", "content": INSTRUCTIONS })
    );
    assert_eq!(body["messages"][1]["role"], "user");
    let schema: Value = serde_json::from_str(SCHEMA).unwrap();
    assert_eq!(
        body["response_format"],
        json!({ "type": "json_schema", "json_schema": { "name": "placing", "strict": true, "schema": schema } })
    );
    assert_eq!(asked[0].authorization, None);

    // A torn one goes to the likelier place and waits for the person's key.
    let mut torn: Value =
        serde_json::from_str(&answer("ambiguous", "", "Keep the header on one line.")).unwrap();
    // The place the last task went to is the first the model is shown: p1.
    torn["candidates"] = json!(["p1", "p2"]);
    let th = p.placed(Reply::Says(torn.to_string()));
    assert_eq!(
        (th.status, th.project_id, th.hold_until, th.placed),
        (Status::Routed, Some(p.app), None, Some(Placed::Model))
    );
    assert_eq!(
        th.route.unwrap().others,
        [tasktap_proto::Place::Project(p.folio)]
    );

    // Removing it takes its row out; with no row left, placing is as it was.
    p.w.ok::<call::OwnModelRemove>(&Empty {});
    p.w.sync();
    assert_eq!((p.own(), p.route_by()), (None, None));
    let refused = p.w.refused::<call::Delete>(&tasktap_proto::Delete::Prefs {
        id: PrefKey::OwnModel,
    });
    assert_eq!(refused.code, Code::Invalid);
    let t = p.capture(SPOKEN);
    assert_eq!(Placing::by(&p.settled(t)).0, "local");
    assert_eq!(p.server.asked().len(), 2);
}

#[test]
fn an_answer_that_cannot_be_read_or_a_server_that_refuses_gives_the_question_card() {
    let mut p = Placing::new("own-unreadable");
    p.set_up(&p.server.address(), "tiny", None);
    let fenced = format!(
        "Here you go:\n```json\n{}\n```",
        answer("clear", "p2", "Brief.")
    );
    let cases = [
        (
            Reply::Says("I would say the app project.".into()),
            "own: its answer holds no JSON",
        ),
        (
            Reply::Says("{\"to\": \"p1\"}".into()),
            "own: its answer holds no JSON",
        ),
        (
            Reply::Says(answer("clear", "p9", "Brief.")),
            "own: it names \"p9\", which it was not offered",
        ),
        (
            Reply::Status(500, json!({ "error": { "message": "out of memory" } })),
            "own: the server did not take the question (out of memory)",
        ),
        (
            Reply::Status(404, json!({ "error": { "message": "model not found" } })),
            "own: the server has no model tiny (model not found)",
        ),
        (
            Reply::Status(429, json!({})),
            "own: the server is at its limit for now",
        ),
        (
            Reply::Status(200, json!({ "choices": [] })),
            "own: its answer holds no text",
        ),
    ];
    for (reply, said) in cases {
        let th = p.placed(reply);
        let (by, fallback) = Placing::by(&th);
        // Nothing is guessed: the person is asked where the task goes.
        assert_eq!(
            (by.as_str(), th.status),
            ("local", Status::NeedsYou),
            "{said}"
        );
        assert!(fallback.starts_with(said), "{fallback}");
    }
    // Nothing listens: the same.
    p.set_up("http://127.0.0.1:9/v1", "tiny", None);
    let t = p.capture(SPOKEN);
    let (by, fallback) = Placing::by(&p.settled(t));
    assert_eq!(by, "local");
    assert!(
        fallback.starts_with("own: the server could not be reached"),
        "{fallback}"
    );
    // Text that holds its JSON is read, as a model that was not held to JSON writes it.
    p.set_up(&p.server.address(), "tiny", None);
    let th = p.placed(Reply::Says(fenced));
    assert_eq!(
        (th.status, Placing::by(&th).0.as_str()),
        (Status::Routed, "own")
    );
}

#[test]
fn the_strictest_form_the_server_accepts_is_asked_and_remembered() {
    let mut p = Placing::new("own-forms");
    p.set_up(&p.server.address(), "tiny", None);
    let types = |p: &Placing| -> Vec<Value> {
        p.server
            .asked()
            .iter()
            .map(|r| r.body["response_format"]["type"].clone())
            .collect()
    };
    // A server that has no JSON schema: the next form is asked, within the one placing.
    p.server.with(|s| s.rejects = vec!["json_schema"]);
    let th = p.placed(Reply::Says(answer("clear", "p2", "Brief.")));
    assert_eq!(Placing::by(&th).0, "own");
    assert_eq!(types(&p), [json!("json_schema"), json!("json_object")]);
    // What worked is asked first from then on.
    p.placed(Reply::Says(answer("clear", "p2", "Brief.")));
    assert_eq!(types(&p).len(), 3);
    assert_eq!(types(&p)[2], json!("json_object"));
    // A server with neither: plain text, read for its JSON.
    p.set_up(&p.server.address(), "other", None);
    p.server
        .with(|s| s.rejects = vec!["json_schema", "json_object"]);
    let before = p.server.asked().len();
    let th = p.placed(Reply::Says(format!(
        "```json\n{}\n```",
        answer("clear", "p1", "Brief.")
    )));
    assert_eq!(
        (th.project_id, Placing::by(&th).0.as_str()),
        (Some(p.folio), "own")
    );
    let sent = p.server.asked();
    assert_eq!(sent.len() - before, 3);
    assert!(sent.last().unwrap().body.get("response_format").is_none());
}

#[test]
fn the_first_answer_after_a_start_may_take_longer_than_later_ones() {
    // The limits are 3 s, then 1 s (the product's are 60 s and 20 s).
    let mut p = Placing::with("own-slow", &[("TASKTAP_OWN_LIMITS", "3000,1000")]);
    p.set_up(&p.server.address(), "tiny", None);
    let slow = |ms| Reply::After(ms, Box::new(Reply::Says(answer("clear", "p2", "Brief."))));
    let th = p.placed(slow(1800));
    assert_eq!(Placing::by(&th), ("own".into(), String::new()));
    let (by, fallback) = Placing::by(&p.placed(slow(1800)));
    assert_eq!(by, "local");
    assert_eq!(fallback, "own: it did not answer within 1 s");
    // That server is left out now (see below); a fast one is taken as ever.
    let other = Server::start();
    p.set_up(&other.address(), "tiny", None);
    other.says(slow(100));
    let t = p.capture(SPOKEN);
    assert_eq!(Placing::by(&p.settled(t)).0, "own");
}

#[test]
fn plain_http_goes_only_to_this_machine_or_a_private_network_and_a_key_only_over_https_or_here() {
    let mut p = Placing::new("own-reach");
    let set = |address: &str, key: Option<&str>| SetOwnModel {
        address: address.into(),
        model: "tiny".into(),
        key: key.map(Into::into),
    };
    for address in [
        "http://example.com/v1",
        "http://8.8.8.8/v1",
        "http://172.32.0.1/v1",
        "http://[2001:db8::1]/v1",
        "ftp://127.0.0.1/v1",
        "127.0.0.1/v1",
        "http://127.0.0.1:11434/v1/",
        "http://127.0.0.1:11434/v1?x=1",
        "http://user@127.0.0.1/v1",
        // curl would take these for patterns, and call several hosts.
        "https://{a.com,b.com}/v1",
        "https://api[1-9].example.com/v1",
        "https://api.example.com/{v1,v2}",
        "http://[1-9]/v1",
        "http://[127.0.0.1]/v1",
    ] {
        let refused = p.w.refused::<call::OwnModelSet>(&set(address, None));
        assert_eq!(refused.code, Code::Invalid, "{address}");
        let listed = ListModels {
            address: address.into(),
        };
        assert_eq!(
            p.w.refused::<call::OwnModelList>(&listed).code,
            Code::Invalid,
            "{address}"
        );
    }
    assert_eq!(p.own(), None);
    for address in [
        "http://127.0.0.1:11434/v1",
        "http://localhost:11434/v1",
        "http://[::1]:11434/v1",
        "http://10.1.2.3:8000/v1",
        "http://172.16.0.9/v1",
        "http://192.168.1.20:1234/v1",
        "http://169.254.1.1/v1",
        "http://[fd00::1]:8080/v1",
        "https://api.example.com/v1",
    ] {
        p.w.ok::<call::OwnModelSet>(&set(address, None));
    }
    // A key goes over https or to this machine, not over a network's plain http.
    let lan =
        p.w.refused::<call::OwnModelSet>(&set("http://192.168.1.20:1234/v1", Some(KEY)));
    assert_eq!(lan.code, Code::Invalid);
    assert!(!lan.message.contains(KEY));
    p.w.ok::<call::OwnModelSet>(&set("https://api.example.com/v1", Some(KEY)));
    p.w.ok::<call::OwnModelSet>(&set("http://127.0.0.1:11434/v1", Some(KEY)));
    // A name that is no model's.
    let odd = SetOwnModel {
        model: "two words".into(),
        ..set("http://127.0.0.1:11434/v1", None)
    };
    assert_eq!(p.w.refused::<call::OwnModelSet>(&odd).code, Code::Invalid);
    // A key with a space is no key.
    let spaced =
        p.w.refused::<call::OwnModelSet>(&set("http://127.0.0.1:11434/v1", Some("two words")));
    assert_eq!(spaced.code, Code::Invalid);
    // Billed where it is not on this machine or a network.
    let terms = p.w.ok::<call::RouteTerms>(&Empty {});
    assert_eq!(
        terms.tools.iter().find(|t| t.agent == "own").unwrap().pays,
        Pays::Plan
    );
    p.w.ok::<call::OwnModelSet>(&set("https://api.example.com/v1", None));
    let terms = p.w.ok::<call::RouteTerms>(&Empty {});
    assert_eq!(
        terms.tools.iter().find(|t| t.agent == "own").unwrap().pays,
        Pays::Billed
    );
}

#[test]
fn a_key_goes_only_to_its_address_follows_no_redirect_and_is_struck_from_what_is_said() {
    let mut p = Placing::new("own-key");
    let elsewhere = Server::start();
    let address = p.server.address();
    p.set_up(&address, "tiny", Some(KEY));
    assert_eq!(p.keys(), std::slice::from_ref(&address));
    // It is sent to its own address, as a bearer.
    p.server.with(|s| s.models = vec!["tiny"]);
    p.placed(Reply::Says(answer("clear", "p2", "Brief.")));
    assert_eq!(
        p.server.asked()[0].authorization.as_deref(),
        Some(format!("Bearer {KEY}").as_str())
    );
    // A redirect to another host is not followed: nothing reaches it, and the person is asked.
    let to = format!("{}/v1/chat/completions", elsewhere.base);
    let th = p.placed(Reply::Redirect(to));
    assert_eq!(Placing::by(&th).0, "local");
    assert_eq!(elsewhere.with(|s| s.seen.len()), 0);
    // A server that repeats the key in its refusal: the text has it struck.
    let echo = json!({ "error": { "message": format!("Incorrect API key provided: {KEY}.") } });
    let th = p.placed(Reply::Status(401, echo));
    let (_, fallback) = Placing::by(&th);
    assert!(
        fallback.starts_with(
            "own: the server did not take the key (Incorrect API key provided: (key).)"
        ),
        "{fallback}"
    );
    assert!(!fallback.contains(KEY));
    // Set again at its address with no key, the key stays; with a new model it is used still.
    p.set_up(&address, "small", None);
    assert_eq!(p.keys(), std::slice::from_ref(&address));
    p.placed(Reply::Says(answer("clear", "p2", "Brief.")));
    assert_eq!(
        p.server.asked().last().unwrap().authorization.as_deref(),
        Some(format!("Bearer {KEY}").as_str())
    );
    p.key_kept_nowhere(KEY);
    // A changed address drops the key: the new address is sent none, and no key is kept.
    p.set_up(&elsewhere.address(), "tiny", None);
    assert_eq!(p.keys(), Vec::<String>::new());
    elsewhere.says(Reply::Says(answer("clear", "p2", "Brief.")));
    let t = p.capture(SPOKEN);
    p.settled(t);
    assert_eq!(elsewhere.asked()[0].authorization, None);
    // Back at the first address it has none either.
    p.set_up(&address, "tiny", None);
    let before = p.server.asked().len();
    p.placed(Reply::Says(answer("clear", "p2", "Brief.")));
    assert_eq!(p.server.asked()[before].authorization, None);
    p.key_kept_nowhere(KEY);
    // Removing the model takes a key with it.
    p.set_up(&address, "tiny", Some(KEY));
    p.w.ok::<call::OwnModelRemove>(&Empty {});
    p.w.sync();
    assert_eq!(p.keys(), Vec::<String>::new());
}

#[test]
fn the_models_a_server_lists_are_listed_for_the_chooser_with_no_key() {
    let mut p = Placing::new("own-models");
    let address = p.server.address();
    p.server
        .with(|s| s.models = vec!["llama3.1:8b", "qwen2.5-coder:7b"]);
    let list = |address: &str| ListModels {
        address: address.into(),
    };
    let models = p.w.ok::<call::OwnModelList>(&list(&address)).models;
    assert_eq!(models, ["llama3.1:8b", "qwen2.5-coder:7b"]);
    assert_eq!(p.server.with(|s| s.seen[0].path.clone()), "/v1/models");
    // The address may be half typed: no key is sent with a look, not even
    // the one stored for this very address.
    p.set_up(&address, "llama3.1:8b", Some(KEY));
    p.w.ok::<call::OwnModelList>(&list(&address));
    assert_eq!(
        p.server.with(|s| s.seen.last().unwrap().path.clone()),
        "/v1/models"
    );
    assert!(
        p.server
            .with(|s| s.seen.iter().all(|r| r.authorization.is_none()))
    );
    // A server that refuses, and one nobody listens at, say so.
    p.server.with(|s| s.list_status = Some(401));
    let refused = p.w.refused::<call::OwnModelList>(&list(&address));
    assert_eq!(refused.code, Code::Failed);
    assert!(!refused.message.contains(KEY));
    let none =
        p.w.refused::<call::OwnModelList>(&list("http://127.0.0.1:9/v1"));
    assert_eq!(none.code, Code::Failed);
    p.key_kept_nowhere(KEY);
}

/// The agreement as it stands: `(agent, model, on)` of each row.
fn rows(p: &Placing) -> Vec<(String, String, bool)> {
    let by = p.route_by().unwrap();
    (by.agents.into_iter())
        .map(|a| (a.agent, a.model, a.on))
        .collect()
}

impl Placing {
    /// Agrees to these rows, `(agent, model, on)`, in this order.
    fn agree(&mut self, rows: &[(&str, &str, bool)]) {
        let agents = (rows.iter())
            .map(|(agent, model, on)| Placer {
                agent: (*agent).into(),
                model: (*model).into(),
                on: *on,
            })
            .collect();
        let target =
            tasktap_proto::PutTarget::Prefs(tasktap_proto::PrefPatch::RouteBy(Some(RouteBy {
                agents,
                terms: TERMS,
            })));
        self.w.ok::<call::Put>(&tasktap_proto::Put {
            target,
            if_rev: None,
        });
    }
}

#[test]
fn a_call_to_this_machine_goes_by_no_proxy_whatever_the_environment_says() {
    let proxy = Server::start();
    let url = proxy.base.clone();
    let mut p = Placing::with(
        "own-proxy",
        &[
            ("http_proxy", &url),
            ("HTTP_PROXY", &url),
            ("all_proxy", &url),
            // Nothing in the machine's own environment may let the test pass.
            ("no_proxy", ""),
            ("NO_PROXY", ""),
        ],
    );
    p.set_up(&p.server.address(), "tiny", None);
    let th = p.placed(Reply::Says(answer("clear", "p2", "Brief.")));
    assert_eq!(Placing::by(&th).0, "own");
    let address = p.server.address();
    p.w.ok::<call::OwnModelList>(&ListModels { address });
    assert_eq!(proxy.with(|s| s.seen.len()), 0);
}

#[test]
fn a_key_kept_for_speech_at_the_address_stays_when_the_own_model_is_set_up_or_removed() {
    let mut p = Placing::new("own-shared-key");
    let address = p.server.address();
    let key = tasktap_proto::SetKey {
        server: address.clone(),
        key: KEY.into(),
    };
    p.w.ok::<call::KeySet>(&key);
    let by = tasktap_proto::SpeechBy {
        server: address.clone(),
        model: "whisper".into(),
    };
    let target = tasktap_proto::PutTarget::Prefs(tasktap_proto::PrefPatch::SpeechBy(Some(by)));
    p.w.ok::<call::Put>(&tasktap_proto::Put {
        target,
        if_rev: None,
    });
    // Set up with no key typed, the address stays among the keys.
    p.set_up(&address, "tiny", None);
    p.w.sync();
    assert_eq!(p.keys(), std::slice::from_ref(&address));
    // So does it when the own model's key goes with a removal.
    p.set_up(&address, "tiny", Some(KEY));
    p.w.ok::<call::OwnModelRemove>(&Empty {});
    p.w.sync();
    assert_eq!(p.keys(), std::slice::from_ref(&address));
    // Another address, left for this one, takes its key and nothing more.
    let elsewhere = Server::start();
    p.set_up(&elsewhere.address(), "tiny", Some(KEY));
    p.set_up(&address, "tiny", None);
    assert_eq!(p.keys(), std::slice::from_ref(&address));
}

#[test]
fn what_a_server_repeats_of_the_key_is_struck_before_the_message_is_cut() {
    let mut p = Placing::new("own-strike");
    p.set_up(&p.server.address(), "tiny", Some(KEY));
    // The key stands where a cut at 200 characters would leave half of it.
    let message = format!("{}{KEY}", "x".repeat(190));
    let th = p.placed(Reply::Status(
        401,
        json!({ "error": { "message": message } }),
    ));
    let (_, fallback) = Placing::by(&th);
    assert!(fallback.contains("(key)"), "{fallback}");
    assert!(!fallback.contains(&KEY[..8]), "{fallback}");
}

#[test]
fn each_server_has_its_own_first_time_and_one_that_did_not_answer_is_left_out() {
    // The limits are 3 s, then 1 s.
    let mut p = Placing::with("own-per-server", &[("TASKTAP_OWN_LIMITS", "3000,1000")]);
    p.set_up(&p.server.address(), "tiny", None);
    let slow = |ms| Reply::After(ms, Box::new(Reply::Says(answer("clear", "p2", "Brief."))));
    assert_eq!(Placing::by(&p.placed(slow(0))).0, "own");
    // Another server has not answered yet: it has the first time too.
    let other = Server::start();
    p.set_up(&other.address(), "tiny", None);
    other.says(slow(1800));
    let t = p.capture(SPOKEN);
    assert_eq!(Placing::by(&p.settled(t)).0, "own");
    // One that does not answer within its time is left out: no task asks it
    // again, and none waits for it.
    p.set_up(&p.server.address(), "tiny", None);
    let (by, fallback) = Placing::by(&p.placed(slow(2500)));
    assert_eq!(by, "local");
    assert!(
        fallback.starts_with("own: it did not answer within 1 s"),
        "{fallback}"
    );
    let asked = p.server.asked().len();
    let began = std::time::Instant::now();
    let t = p.capture(SPOKEN);
    let (by, fallback) = Placing::by(&p.settled(t));
    assert_eq!(by, "local");
    assert!(fallback.contains("left out"), "{fallback}");
    assert!(began.elapsed() < Duration::from_millis(900));
    assert_eq!(p.server.asked().len(), asked);
}

#[test]
fn the_time_the_own_model_waited_takes_nothing_from_the_next_placers() {
    // The own model may wait 9.5 s, more than the 8 s the others share.
    let mut p = Placing::with("own-budget", &[("TASKTAP_OWN_LIMITS", "9500,9500")]);
    p.set_up(&p.server.address(), "tiny", None);
    p.agree(&[("own", "tiny", true), ("fixture", "fixture-small", true)]);
    std::fs::write(
        p.data.0.join("route").join("ask"),
        format!("print:{}", answer("clear", "p1", "Brief.")),
    )
    .unwrap();
    let silent = Reply::After(
        11_000,
        Box::new(Reply::Says(answer("clear", "p2", "Brief."))),
    );
    let th = p.placed(silent);
    let (by, fallback) = Placing::by(&th);
    assert_eq!(by, "fixture", "{fallback}");
}

#[test]
fn changing_the_own_model_keeps_its_switch_and_its_place_in_the_order() {
    let mut p = Placing::new("own-change");
    p.set_up(&p.server.address(), "tiny", None);
    p.agree(&[("fixture", "fixture-small", true), ("own", "tiny", false)]);
    p.set_up(&p.server.address(), "small", None);
    assert_eq!(
        rows(&p),
        [
            ("fixture".into(), "fixture-small".into(), true),
            ("own".into(), "small".into(), false)
        ]
    );
}

#[test]
fn speech_cannot_remove_a_key_the_own_model_uses_and_a_first_set_up_switches_its_row_on() {
    let mut p = Placing::new("own-keepers");
    let address = p.server.address();
    // A row of the own model that was left switched off before it was set up.
    p.agree(&[("fixture", "fixture-small", true), ("own", "tiny", false)]);
    p.set_up(&address, "tiny", Some(KEY));
    assert_eq!(
        rows(&p),
        [
            ("own".into(), "tiny".into(), true),
            ("fixture".into(), "fixture-small".into(), true)
        ]
    );
    // Speech's own removal leaves the key where the own model uses it.
    let server = tasktap_proto::Server {
        server: address.clone(),
    };
    let refused = p.w.refused::<call::KeyRemove>(&server);
    assert_eq!(refused.code, Code::Invalid);
    p.w.sync();
    assert_eq!(p.keys(), std::slice::from_ref(&address));
    // Once the own model is gone the key can go.
    p.w.ok::<call::OwnModelRemove>(&Empty {});
    p.w.sync();
    assert_eq!(p.keys(), Vec::<String>::new());
}

/// What the person does with a decision on its line: Return starts it.
fn start(p: &mut Placing, id: ThoughtId) {
    let start = tasktap_proto::Start {
        id,
        attempt: tasktap_proto::AttemptId::mint(),
    };
    p.w.ok::<call::ThoughtStart>(&start);
}

/// A key of the decision line, or a place picked: the task goes to that project.
fn assign(id: ThoughtId, project: ProjectId) -> tasktap_proto::Assign {
    tasktap_proto::Assign {
        id,
        project_id: Some(project),
        card_id: None,
        session_id: None,
    }
}

#[test]
fn the_record_keeps_every_task_a_model_placed_with_what_the_person_did_and_goes_in_no_request() {
    let mut p = Placing::new("own-record");
    let address = p.server.address();
    p.set_up(&address, "tiny", None);
    let said = format!("fix the header, the key is {KEY}");
    let place = |p: &mut Placing, reply: Value| {
        p.server.says(Reply::Says(reply.to_string()));
        let t = p.capture(&said);
        p.settled(t);
        t
    };
    let sure = |brief: &str| serde_json::from_str::<Value>(&answer("clear", "p2", brief)).unwrap();
    // The decision stands.
    let first = place(&mut p, sure("Brief of the first."));
    start(&mut p, first);
    // Torn: another choice is taken, on its key.
    let mut torn = sure("Brief of the second.");
    torn["confidence"] = "ambiguous".into();
    torn["candidates"] = json!(["p1", "p2"]);
    let second = place(&mut p, torn);
    let other = p.w.model.thought(second).route.as_ref().unwrap().others[0];
    let tasktap_proto::Place::Project(other) = other else {
        panic!("a project")
    };
    p.w.ok::<call::ThoughtUpdate>(&assign(second, other));
    // The start is undone.
    let third = place(&mut p, sure("Brief of the third."));
    p.w.ok::<call::ThoughtStop>(&tasktap_proto::Ref { id: third });
    // The task is placed by hand: to the project the model did not choose.
    let fourth = place(&mut p, sure("Brief of the fourth."));
    let chosen = p.w.model.thought(fourth).project_id.unwrap();
    let elsewhere = [p.app, p.folio].into_iter().find(|x| *x != chosen).unwrap();
    p.w.ok::<call::ThoughtUpdate>(&assign(fourth, elsewhere));
    p.w.sync();

    let entries = tasktap_core::placings::read(&p.data.0);
    assert_eq!(entries.len(), 4, "{entries:?}");
    let did: Vec<_> = entries
        .iter()
        .map(|e| (e["did"].as_str().unwrap(), e["choice"].clone()))
        .collect();
    let none = Value::Null;
    assert_eq!(
        did,
        [
            ("stood", none.clone()),
            ("other", json!(2)),
            ("undone", none.clone()),
            ("hand", none)
        ]
    );
    for (n, e) in entries.iter().enumerate() {
        assert_eq!(
            (e["placer"].as_str(), e["model"].as_str()),
            (Some("own"), Some("tiny"))
        );
        assert!(e["at"].as_u64().unwrap() > 0 && e["previews"] == 0);
        // The words as they were sent: what looks like a key is left out.
        let words = e["words"].as_str().unwrap();
        assert!(
            words.starts_with("fix the header") && !words.contains(KEY),
            "{words}"
        );
        let mut names: Vec<_> = (e["candidates"].as_array().unwrap().iter())
            .map(|c| c["name"].as_str().unwrap())
            .collect();
        names.sort_unstable();
        // The projects, then the sessions a started task left.
        assert!(
            names.contains(&"app") && names.contains(&"folio"),
            "{names:?}"
        );
        assert!(e["candidates"][0]["id"].as_str().unwrap().starts_with('p'));
        let brief = ["first", "second", "third", "fourth"][n];
        assert!(
            e["answer"]
                .as_str()
                .unwrap()
                .contains(&format!("Brief of the {brief}."))
        );
    }
    let text = std::fs::read_to_string(tasktap_core::placings::file(&p.data.0)).unwrap();
    assert!(!text.contains(KEY));
    // The record is in no request: not what was done, nor an earlier answer.
    let asked = p.server.asked();
    assert_eq!(asked.len(), 4);
    for (n, a) in asked.iter().enumerate() {
        let body = a.body.to_string();
        assert!(
            !body.contains("placings") && !body.contains("\"did\""),
            "{body}"
        );
        for earlier in ["first", "second", "third", "fourth"].iter().take(n) {
            assert!(
                !body.contains(&format!("Brief of the {earlier}.")),
                "request {n} holds an earlier answer"
            );
        }
    }
    // Its count, and its end.
    assert_eq!(p.w.ok::<call::PlacingsCount>(&Empty {}), 4);
    p.w.ok::<call::PlacingsClear>(&Empty {});
    assert_eq!(p.w.ok::<call::PlacingsCount>(&Empty {}), 0);
    assert!(tasktap_core::placings::read(&p.data.0).is_empty());
}

// ——— The live target: previews of the words so far ———

/// A preview of \`text\` for the task \`task\`: where the model put it.
fn preview(p: &mut Placing, task: ThoughtId, text: &str) -> Vec<tasktap_proto::Place> {
    p.w.ok::<call::RoutePreview>(&words(task, text)).choices
}

/// The same data folder and server, the core started again after `change` was made to its store.
fn restarted(p: Placing, change: impl FnOnce(&rusqlite::Connection)) -> Placing {
    let Placing {
        _core,
        w,
        data,
        server,
        app,
        folio,
    } = p;
    drop(w);
    _core.stop();
    change(&rusqlite::Connection::open(data.0.join("core.db")).unwrap());
    let path = path_with(&agents(&data.0));
    let core = Core::start_env(&data.0, &[], &[("PATH", path.as_str())]);
    let w = core.watch();
    Placing {
        _core: core,
        w,
        data,
        server,
        app,
        folio,
    }
}

fn words(task: ThoughtId, text: &str) -> tasktap_proto::PreviewWords {
    tasktap_proto::PreviewWords {
        task,
        text: text.into(),
        current: None,
        view: None,
    }
}

/// Return on the target the person saw: the task goes with the choice it took.
fn send(p: &mut Placing, id: ThoughtId, text: &str, taken: Option<u8>) {
    let capture = tasktap_proto::Capture {
        agent: Some("fixture".into()),
        taken,
        ..typed(id, text)
    };
    p.w.ok::<call::ThoughtCapture>(&capture);
}

const WORDS: &str = "make the header stay on one line on small screens";

fn project(p: ProjectId) -> tasktap_proto::Place {
    tasktap_proto::Place::Project(p)
}

#[test]
fn a_preview_starts_nothing_makes_no_task_and_is_in_no_record() {
    let mut p = Placing::new("own-preview");
    let address = p.server.address();
    p.set_up(&address, "tiny", None);
    p.server.says(Reply::Says(answer(
        "clear",
        "p2",
        "Keep the header on one line.",
    )));
    let task = ThoughtId::mint();
    assert_eq!(preview(&mut p, task, WORDS), [project(p.app)]);
    p.w.sync();
    // It asked the model once, as a sent task is asked, and made nothing.
    let asked = p.server.asked();
    assert_eq!(asked.len(), 1);
    assert_eq!(
        asked[0].body["messages"][0],
        json!({ "role": "system", "content": INSTRUCTIONS })
    );
    assert!(
        asked[0].body["messages"][1]["content"]
            .as_str()
            .unwrap()
            .contains(WORDS)
    );
    assert!(p.w.model.thoughts.is_empty() && p.w.model.sessions.is_empty());
    assert!(tasktap_core::placings::read(&p.data.0).is_empty());
    // The words of a sent task are exactly what the preview sent, so the
    // task, sent as it stood, is not asked about again.
    send(&mut p, task, WORDS, Some(0));
    let th = p.settled(task);
    assert_eq!(
        (th.status, th.project_id, th.placed),
        (Status::Routed, Some(p.app), Some(Placed::Model))
    );
    assert!(th.hold_until.is_some());
    assert_eq!(th.brief.as_deref(), Some("Keep the header on one line."));
    assert_eq!(p.server.asked().len(), 1);
    // It is in the record with the number of previews that went before it.
    let entries = tasktap_core::placings::read(&p.data.0);
    assert_eq!(
        (entries.len(), entries[0]["previews"].as_u64()),
        (1, Some(1))
    );
}

#[test]
fn return_with_changed_words_or_without_the_target_taken_asks_again() {
    let mut p = Placing::new("own-changed");
    let address = p.server.address();
    p.set_up(&address, "tiny", None);
    let task = ThoughtId::mint();
    p.server.says(Reply::Says(answer("clear", "p2", "Brief.")));
    preview(&mut p, task, WORDS);
    // Words changed after the preview: the model is asked about the words sent.
    p.server.says(Reply::Says(answer(
        "clear",
        "p2",
        "Brief of the changed words.",
    )));
    send(&mut p, task, &format!("{WORDS} please"), Some(0));
    let th = p.settled(task);
    assert_eq!(th.brief.as_deref(), Some("Brief of the changed words."));
    assert_eq!(p.server.asked().len(), 2);
    // The target not taken (not shown, or not the one the person saw): asked again too.
    let other = ThoughtId::mint();
    p.server.says(Reply::Says(answer("clear", "p2", "Brief.")));
    preview(&mut p, other, WORDS);
    p.server
        .says(Reply::Says(answer("clear", "p2", "Brief, asked again.")));
    send(&mut p, other, WORDS, None);
    assert_eq!(
        p.settled(other).brief.as_deref(),
        Some("Brief, asked again.")
    );
    assert_eq!(p.server.asked().len(), 4);
    // A preview serves one task only, and once.
    let third = ThoughtId::mint();
    p.server
        .says(Reply::Says(answer("clear", "p2", "Brief of the third.")));
    send(&mut p, third, WORDS, Some(0));
    assert_eq!(
        p.settled(third).brief.as_deref(),
        Some("Brief of the third.")
    );
    assert_eq!(p.server.asked().len(), 5);
}

#[test]
fn a_torn_preview_is_a_choice_before_sending_and_the_choice_taken_is_decided() {
    let mut p = Placing::new("own-torn-preview");
    let address = p.server.address();
    p.set_up(&address, "tiny", None);
    let mut torn: Value =
        serde_json::from_str(&answer("ambiguous", "", "Keep the header on one line.")).unwrap();
    torn["candidates"] = json!(["p1", "p2"]);
    p.server.says(Reply::Says(torn.to_string()));
    let task = ThoughtId::mint();
    let choices = preview(&mut p, task, WORDS);
    assert_eq!(choices.len(), 2);
    // The second choice taken: the task goes there with a hold, not waiting for a key, the first on key 2.
    send(&mut p, task, WORDS, Some(1));
    let th = p.settled(task);
    assert_eq!(project(th.project_id.unwrap()), choices[1]);
    assert!(th.hold_until.is_some());
    assert_eq!(th.route.unwrap().others, [choices[0]]);
    assert_eq!(p.server.asked().len(), 1);
}

#[test]
fn a_newer_preview_drops_the_answer_of_an_older_and_at_most_four_are_sent() {
    let mut p = Placing::new("own-newer");
    let address = p.server.address();
    p.set_up(&address, "tiny", None);
    let task = ThoughtId::mint();
    // The older is slow; the newer is asked once the older is under way.
    p.server.says(Reply::After(
        700,
        Box::new(Reply::Says(answer("clear", "p1", "Slow."))),
    ));
    let older =
        p.w.send::<call::RoutePreview>(&words(task, "make the header stay"));
    while p.server.asked().is_empty() {
        std::thread::sleep(Duration::from_millis(10));
    }
    p.server.says(Reply::Says(answer("clear", "p2", "Quick.")));
    let newer =
        p.w.send::<call::RoutePreview>(&words(task, "make the header stay on one line"));
    let both = p.w.replies::<call::RoutePreview>(&[older, newer]);
    assert!(both[0].as_ref().unwrap().choices.is_empty());
    assert_eq!(both[1].as_ref().unwrap().choices, [project(p.app)]);
    // Only the newer one's answer is kept for the task.
    send(&mut p, task, "make the header stay on one line", Some(0));
    assert_eq!(p.settled(task).brief.as_deref(), Some("Quick."));
    assert_eq!(p.server.asked().len(), 2);

    // At most four are sent for one task; a fifth is answered with none and asks no one.
    let busy = ThoughtId::mint();
    for n in 0..tasktap_proto::PREVIEWS {
        p.server.says(Reply::Says(answer("clear", "p2", "Brief.")));
        assert_eq!(preview(&mut p, busy, &format!("{WORDS} {n}")).len(), 1);
    }
    let before = p.server.asked().len();
    assert!(preview(&mut p, busy, &format!("{WORDS} again")).is_empty());
    assert_eq!(p.server.asked().len(), before);
}

#[test]
fn nothing_is_previewed_before_the_terms_are_agreed_with_agents_as_placers_in_the_window_or_with_the_switch_off()
 {
    let mut p = Placing::new("own-no-preview");
    let address = p.server.address();
    let task = ThoughtId::mint();
    // No agreement at all.
    assert!(preview(&mut p, task, WORDS).is_empty());
    p.set_up(&address, "tiny", None);
    let put = |p: &mut Placing, patch| {
        let target = tasktap_proto::PutTarget::Prefs(patch);
        p.w.ok::<call::Put>(&tasktap_proto::Put {
            target,
            if_rev: None,
        });
    };
    // An agreement to the terms before the live target is not to these: the core
    // reads the stored one as it was, and sends no preview until it is agreed to again.
    p = restarted(p, |db| {
        let old =
            "UPDATE prefs SET data = json_set(data, '$.value.terms', ?1) WHERE id = 'route_by'";
        db.execute(old, [TERMS - 1]).unwrap();
    });
    assert!(preview(&mut p, task, WORDS).is_empty());
    p.set_up(&address, "tiny", None);
    // An agent first in the order: no agent is started for a preview, nobody is asked.
    let agents = RouteBy {
        agents: vec![
            Placer {
                agent: "fixture".into(),
                model: "fixture-small".into(),
                on: true,
            },
            Placer {
                agent: "own".into(),
                model: "tiny".into(),
                on: true,
            },
        ],
        terms: TERMS,
    };
    put(&mut p, tasktap_proto::PrefPatch::RouteBy(Some(agents)));
    assert!(preview(&mut p, task, WORDS).is_empty());
    assert!(!p.data.0.join("route").join("asked").exists());
    // Said in Tasktap's window: the names decide, no model is asked.
    let own = Placer {
        agent: "own".into(),
        model: "tiny".into(),
        on: true,
    };
    let alone = RouteBy {
        agents: vec![own],
        terms: TERMS,
    };
    put(&mut p, tasktap_proto::PrefPatch::RouteBy(Some(alone)));
    let window = tasktap_proto::PreviewWords {
        view: Some(p.app),
        ..words(task, WORDS)
    };
    assert!(p.w.ok::<call::RoutePreview>(&window).choices.is_empty());
    // The switch off: none; on again, one.
    put(&mut p, tasktap_proto::PrefPatch::ShowTarget(false));
    assert!(preview(&mut p, task, WORDS).is_empty());
    assert_eq!(p.server.asked().len(), 0);
    put(&mut p, tasktap_proto::PrefPatch::ShowTarget(true));
    p.server.says(Reply::Says(answer("clear", "p2", "Brief.")));
    assert_eq!(preview(&mut p, task, WORDS), [project(p.app)]);
    assert_eq!(p.server.asked().len(), 1);
}

#[test]
fn the_secret_filter_runs_over_a_preview_and_a_refused_or_unreadable_one_shows_nothing() {
    let mut p = Placing::new("own-preview-secret");
    let address = p.server.address();
    p.set_up(&address, "tiny", None);
    let task = ThoughtId::mint();
    p.server.says(Reply::Says(answer("clear", "p2", "Brief.")));
    let said = format!("use the key {KEY} for the header on small screens");
    assert_eq!(preview(&mut p, task, &said), [project(p.app)]);
    let body = p.server.asked()[0].body.to_string();
    assert!(!body.contains(KEY) && body.contains("[left out]"), "{body}");
    // A server that refuses, and one whose answer is no JSON: nothing is shown, nothing kept.
    let other = ThoughtId::mint();
    p.server
        .says(Reply::Status(500, json!({ "error": { "message": "no" } })));
    assert!(preview(&mut p, other, WORDS).is_empty());
    // (Another, an answer that is no JSON, in a core of its own: nothing shown either.)
    let mut q = Placing::new("own-preview-unreadable");
    let address = q.server.address();
    q.set_up(&address, "tiny", None);
    q.server.says(Reply::Says("not json".into()));
    assert!(preview(&mut q, ThoughtId::mint(), WORDS).is_empty());
    // So the task sent after the refused one asks the model as any task does.
    p.server
        .says(Reply::Says(answer("clear", "p2", "Brief of the task.")));
    send(&mut p, other, WORDS, Some(0));
    assert_eq!(
        p.settled(other).brief.as_deref(),
        Some("Brief of the task.")
    );
}

// ——— A preview leaves a placer's standing as it was ———

/// The form of each request the server got, in order.
fn forms(p: &Placing) -> Vec<String> {
    let kind = |a: &Seen| {
        a.body["response_format"]["type"]
            .as_str()
            .unwrap_or("none")
            .to_owned()
    };
    p.server.asked().iter().map(kind).collect()
}

#[test]
fn a_preview_changes_nothing_a_placing_goes_by() {
    // The form a server takes is learned by a placing, not by a preview.
    let mut p = Placing::new("own-preview-form");
    let address = p.server.address();
    p.set_up(&address, "tiny", None);
    p.server.with(|s| s.rejects = vec!["json_schema"]);
    p.server.says(Reply::Says(answer("clear", "p2", "Brief.")));
    assert_eq!(preview(&mut p, ThoughtId::mint(), WORDS).len(), 1);
    p.server.says(Reply::Says(answer("clear", "p2", "Brief.")));
    let task = p.capture(SPOKEN);
    p.settled(task);
    assert_eq!(
        forms(&p),
        ["json_schema", "json_object", "json_schema", "json_object"]
    );
}

#[test]
fn a_preview_that_gets_no_answer_does_not_leave_the_server_out_for_the_tasks_sent() {
    let mut p = Placing::with("own-preview-silent", &[("TASKTAP_OWN_LIMITS", "1500,1500")]);
    let address = p.server.address();
    p.set_up(&address, "tiny", None);
    p.server.says(Reply::After(
        4000,
        Box::new(Reply::Says(answer("clear", "p2", "Late."))),
    ));
    assert!(preview(&mut p, ThoughtId::mint(), WORDS).is_empty());
    // The task sent after it is asked of the same server, which is not left out.
    p.server
        .says(Reply::Says(answer("clear", "p2", "Brief of the task.")));
    let task = p.capture(SPOKEN);
    let th = p.settled(task);
    assert_eq!(
        Placing::by(&th),
        ("own".into(), String::new()),
        "{:?}",
        th.route
    );
}

#[test]
fn a_newer_preview_and_a_sent_task_stop_the_preview_in_flight() {
    use std::time::Instant;
    let mut p = Placing::new("own-preview-stopped");
    let address = p.server.address();
    p.set_up(&address, "tiny", None);
    let slow = || Reply::After(4000, Box::new(Reply::Says(answer("clear", "p2", "Slow."))));
    // A newer preview, of another task: the older is ended, not left to run.
    p.server.says(slow());
    let older =
        p.w.send::<call::RoutePreview>(&words(ThoughtId::mint(), "make the header stay"));
    while p.server.asked().is_empty() {
        std::thread::sleep(Duration::from_millis(10));
    }
    p.server.says(Reply::Says(answer("clear", "p2", "Quick.")));
    let began = Instant::now();
    let newer =
        p.w.send::<call::RoutePreview>(&words(ThoughtId::mint(), WORDS));
    let both = p.w.replies::<call::RoutePreview>(&[older, newer]);
    assert!(
        both[0].as_ref().unwrap().choices.is_empty()
            && both[1].as_ref().unwrap().choices.len() == 1
    );
    assert!(
        began.elapsed() < Duration::from_millis(2500),
        "{:?}",
        began.elapsed()
    );
    // A task that is sent: the preview in flight is ended before its own question goes out.
    p.server.says(slow());
    let older =
        p.w.send::<call::RoutePreview>(&words(ThoughtId::mint(), "make the header stay"));
    while p.server.asked().len() < 3 {
        std::thread::sleep(Duration::from_millis(10));
    }
    p.server
        .says(Reply::Says(answer("clear", "p2", "Brief of the task.")));
    let began = Instant::now();
    let task = ThoughtId::mint();
    let capture = tasktap_proto::Capture {
        agent: Some("fixture".into()),
        ..typed(task, SPOKEN)
    };
    p.w.send::<call::ThoughtCapture>(&capture);
    let ended = p.w.replies::<call::RoutePreview>(&[older]);
    assert!(ended[0].as_ref().unwrap().choices.is_empty());
    assert!(
        began.elapsed() < Duration::from_millis(2500),
        "{:?}",
        began.elapsed()
    );
    assert_eq!(p.settled(task).brief.as_deref(), Some("Brief of the task."));
}

#[test]
fn the_core_holds_the_limits_of_previews_whatever_the_page_does() {
    let mut p = Placing::new("own-preview-limits");
    let address = p.server.address();
    p.set_up(&address, "tiny", None);
    // Eight a minute from one page, for as many tasks as it names: the cap is not reset by a new field.
    for _ in 0..8 {
        p.server.says(Reply::Says(answer("clear", "p2", "Brief.")));
        assert_eq!(preview(&mut p, ThoughtId::mint(), WORDS).len(), 1);
    }
    let before = p.server.asked().len();
    assert!(preview(&mut p, ThoughtId::mint(), WORDS).is_empty());
    assert_eq!(p.server.asked().len(), before);

    // After one fails, none is sent for a while: not for the same words, not for others.
    let mut q = Placing::new("own-preview-quiet");
    let address = q.server.address();
    q.set_up(&address, "tiny", None);
    q.server
        .says(Reply::Status(500, json!({ "error": { "message": "no" } })));
    assert!(preview(&mut q, ThoughtId::mint(), WORDS).is_empty());
    q.server.says(Reply::Says(answer("clear", "p2", "Brief.")));
    assert!(preview(&mut q, ThoughtId::mint(), "move the footer to the bottom").is_empty());
    assert_eq!(q.server.asked().len(), 1);
}

#[test]
fn the_last_word_is_left_out_of_a_preview_while_it_looks_like_the_start_of_a_key() {
    let mut p = Placing::new("own-preview-partial");
    let address = p.server.address();
    p.set_up(&address, "tiny", None);
    p.server.says(Reply::Says(answer("clear", "p2", "Brief.")));
    let partial = &KEY[..16];
    let said = format!("fix the header on small screens {partial}");
    assert_eq!(preview(&mut p, ThoughtId::mint(), &said).len(), 1);
    let body = p.server.asked()[0].body.to_string();
    assert!(
        !body.contains(partial) && body.contains("small screens"),
        "{body}"
    );
    // An ordinary last word is sent, and so is a whole word followed by a space.
    p.server.says(Reply::Says(answer("clear", "p2", "Brief.")));
    assert_eq!(
        preview(
            &mut p,
            ThoughtId::mint(),
            "fix the header on small screens please"
        )
        .len(),
        1
    );
    assert!(p.server.asked()[1].body.to_string().contains("please"));
}

#[test]
fn nothing_is_guessed_or_previewed_for_a_task_said_in_the_window_and_a_task_placed_by_hand_is_no_models_placing()
 {
    let mut p = Placing::new("own-window-hand");
    let address = p.server.address();
    p.set_up(&address, "tiny", None);
    let hint = |view| tasktap_proto::Hint {
        text: WORDS.into(),
        current: None,
        view,
    };
    assert!(p.w.ok::<call::RouteGuess>(&hint(None)).to.is_some());
    assert!(p.w.ok::<call::RouteGuess>(&hint(Some(p.app))).to.is_none());
    let current = tasktap_proto::PreviewWords {
        current: Some(tasktap_proto::SessionId::mint()),
        ..words(ThoughtId::mint(), WORDS)
    };
    assert!(p.w.ok::<call::RoutePreview>(&current).choices.is_empty());
    assert_eq!(p.server.asked().len(), 0);
    // Placed by hand, a long task is asked of the model for its brief only; the record says who placed it.
    p.server.says(Reply::Says(answer(
        "clear",
        "p1",
        "Brief of the long task.",
    )));
    let id = ThoughtId::mint();
    let capture = tasktap_proto::Capture {
        agent: Some("fixture".into()),
        project_id: Some(p.app),
        ..typed(id, SPOKEN)
    };
    p.w.ok::<call::ThoughtCapture>(&capture);
    p.settled(id);
    let entries = tasktap_core::placings::read(&p.data.0);
    assert_eq!(entries.len(), 1);
    let e = &entries[0];
    assert_eq!(
        (
            e["placer"].as_str(),
            e["model"].is_null(),
            e["candidates"].as_array().unwrap().len()
        ),
        (Some("hand"), true, 0)
    );
}

#[test]
fn a_final_path_is_previewed_whole_and_its_answer_is_reused_at_return() {
    let mut p = Placing::new("own-preview-path");
    let address = p.server.address();
    p.set_up(&address, "tiny", None);
    p.server.says(Reply::Says(answer(
        "clear",
        "p2",
        "Brief of the path task.",
    )));
    let task = ThoughtId::mint();
    let said = "fix the layout in src/capture.tsx";
    let got = p.w.ok::<call::RoutePreview>(&words(task, said));
    assert!(got.whole && got.choices.len() == 1);
    assert!(
        p.server.asked()[0]
            .body
            .to_string()
            .contains("src/capture.tsx")
    );
    send(&mut p, task, said, Some(0));
    assert_eq!(
        p.settled(task).brief.as_deref(),
        Some("Brief of the path task.")
    );
    assert_eq!(p.server.asked().len(), 1, "no second question");
    // A last word that looks like a key's start is left out, and the answer is said to be for fewer words.
    p.server.says(Reply::Says(answer("clear", "p2", "Brief.")));
    let partial = format!("fix the header on small screens {}", &KEY[..16]);
    let got =
        p.w.ok::<call::RoutePreview>(&words(ThoughtId::mint(), &partial));
    assert!(!got.whole && got.choices.len() == 1);
}

#[test]
fn a_preview_that_was_stopped_counts_toward_no_limit() {
    let mut p = Placing::new("own-preview-stopped-count");
    let address = p.server.address();
    p.set_up(&address, "tiny", None);
    let slow = || Reply::After(4000, Box::new(Reply::Says(answer("clear", "p2", "Slow."))));
    // One for the task, stopped by a newer one of the same task: it does not count among the four.
    let task = ThoughtId::mint();
    p.server.says(slow());
    let older =
        p.w.send::<call::RoutePreview>(&words(task, "make the header stay"));
    while p.server.asked().is_empty() {
        std::thread::sleep(Duration::from_millis(10));
    }
    p.server.says(Reply::Says(answer("clear", "p2", "Brief.")));
    let newer =
        p.w.send::<call::RoutePreview>(&words(task, "make the header stay on"));
    p.w.replies::<call::RoutePreview>(&[older, newer]);
    for n in 0..3 {
        p.server.says(Reply::Says(answer("clear", "p2", "Brief.")));
        assert_eq!(
            preview(&mut p, task, &format!("{WORDS} {n}")).len(),
            1,
            "preview {n}"
        );
    }
    p.server.says(Reply::Says(answer("clear", "p2", "Brief.")));
    assert!(
        preview(&mut p, task, "one more of the words").is_empty(),
        "four counted: the stopped one is not among them"
    );
    // And not among the eight of the minute: the stopped one and eight others.
    let mut q = Placing::new("own-preview-stopped-minute");
    let address = q.server.address();
    q.set_up(&address, "tiny", None);
    q.server.says(slow());
    let older =
        q.w.send::<call::RoutePreview>(&words(ThoughtId::mint(), "make the header stay"));
    while q.server.asked().is_empty() {
        std::thread::sleep(Duration::from_millis(10));
    }
    q.server.says(Reply::Says(answer("clear", "p2", "Brief.")));
    let newer =
        q.w.send::<call::RoutePreview>(&words(ThoughtId::mint(), WORDS));
    q.w.replies::<call::RoutePreview>(&[older, newer]);
    for n in 0..7 {
        q.server.says(Reply::Says(answer("clear", "p2", "Brief.")));
        assert_eq!(
            preview(&mut q, ThoughtId::mint(), WORDS).len(),
            1,
            "preview {n}"
        );
    }
    let before = q.server.asked().len();
    assert!(preview(&mut q, ThoughtId::mint(), WORDS).is_empty());
    assert_eq!(q.server.asked().len(), before);
}
