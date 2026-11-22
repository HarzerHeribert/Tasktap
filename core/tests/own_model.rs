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
