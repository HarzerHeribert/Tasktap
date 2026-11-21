//! Placing on the person's own ChatGPT plan (design §8, "ChatGPT"): the
//! sign-in with ChatGPT, its renewal and its end, and the placing it makes,
//! through the real binary.
//!
//! No test reaches OpenAI: OpenAI's sign-in and Responses endpoints are a
//! server of this file on this machine, which holds every request to what
//! OpenAI's pages ask and writes down what it finds wrong, as
//! `trials/siwc/standin.mjs` does; the core is pointed at it with
//! `TASKTAP_CHATGPT`, which only a build with the test fixtures reads. Its
//! tokens are made up. No test touches the real credential store: a core
//! built with its fixtures keeps the sign-in in memory. The test is the
//! browser: it follows the address the core answers with.

mod common;

use common::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use tasktap_core::route::{INSTRUCTIONS, SCHEMA, TERMS};
use tasktap_proto::{
    AddProject, ChatGpt, Code, Empty, FixtureClock, Placed, Placer, PrefKey, PrefPatch, PrefValue,
    ProjectId, Put, PutTarget, RouteBy, SignIn, Status, Thought, ThoughtId, call,
};

/// What the stand-in answers a placing call with.
#[derive(Clone)]
enum Reply {
    /// A whole stream with this text.
    Answer(String),
    /// A refusal before any stream, with OpenAI's code.
    Refuse(u16, &'static str),
    /// A stream that fails in the middle: a limit reached.
    Limit,
    /// A stream that ends before it is complete.
    Cut,
}

/// One authorisation code the stand-in gave out.
struct Grant {
    challenge: String,
    redirect: String,
    nonce: String,
    used: bool,
}

/// What the stand-in was asked and gave out, and what the test tells it.
#[derive(Default)]
struct State {
    /// The client id it issues Tasktap.
    issued: String,
    grants: HashMap<String, Grant>,
    /// Each refresh token it gave out, and whether it was used.
    refresh: HashMap<String, bool>,
    access: Vec<String>,
    /// Every token it gave out, for the search that none was kept or shown.
    secrets: Vec<String>,
    /// "METHOD path" of each request, in order.
    seen: Vec<String>,
    /// What it found wrong in a request.
    problems: Vec<String>,
    /// Each placing call's body.
    bodies: Vec<Value>,
    /// Each refresh token it was asked to end.
    revoked: Vec<String>,
    /// Each authorisation address it was opened at, as its fields.
    opened: Vec<HashMap<String, String>>,
    // What the test tells it:
    expires_in: u64,
    wrong_nonce: bool,
    no_plan: bool,
    deny: bool,
    refuse_renewal: bool,
    replies: VecDeque<Reply>,
}

struct StandIn {
    base: String,
    st: Arc<Mutex<State>>,
}

impl StandIn {
    fn start() -> StandIn {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let st = Arc::new(Mutex::new(State {
            issued: "oaiapp_standin0123456789".into(),
            expires_in: 3600,
            ..State::default()
        }));
        let (shared, at) = (st.clone(), base.clone());
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                let (st, base) = (shared.clone(), at.clone());
                std::thread::spawn(move || serve(conn, &base, &st));
            }
        });
        StandIn { base, st }
    }

    fn with<T>(&self, f: impl FnOnce(&mut State) -> T) -> T {
        f(&mut self.st.lock().unwrap())
    }

    fn seen(&self, what: &str) -> usize {
        self.with(|s| s.seen.iter().filter(|r| *r == what).count())
    }

    fn answers(&self, reply: Reply) {
        self.with(|s| s.replies.push_back(reply));
    }

    fn no_problems(&self) {
        let problems = self.with(|s| s.problems.clone());
        assert!(problems.is_empty(), "{problems:?}");
    }
}

fn b64(bytes: &[u8]) -> String {
    const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n =
            (chunk.iter().enumerate()).fold(0u32, |n, (i, &b)| n | u32::from(b) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(char::from(B64[(n >> (18 - 6 * i) & 63) as usize]));
        }
    }
    out
}

/// The fields of a query or a URL-encoded form.
fn fields(text: &str) -> HashMap<String, String> {
    let unescape = |t: &str| {
        let t = t.replace('+', " ");
        let mut out = Vec::new();
        let mut bytes = t.bytes();
        while let Some(b) = bytes.next() {
            match b {
                b'%' => {
                    let hex: String = bytes.by_ref().take(2).map(char::from).collect();
                    out.push(u8::from_str_radix(&hex, 16).unwrap());
                }
                b => out.push(b),
            }
        }
        String::from_utf8(out).unwrap()
    };
    (text.split('&'))
        .filter_map(|pair| pair.split_once('='))
        .map(|(k, v)| (unescape(k), unescape(v)))
        .collect()
}

fn mint(prefix: &str) -> String {
    format!("{prefix}{}", ThoughtId::mint().uuid().simple())
}

/// Answers one request as OpenAI's sign-in or API would.
fn serve(mut conn: TcpStream, base: &str, st: &Mutex<State>) {
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
    let text = String::from_utf8_lossy(&body).into_owned();
    let line = head.lines().next().unwrap_or_default();
    let mut parts = line.split(' ');
    let (method, target) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    );
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let q = fields(query);
    let form = fields(&text);
    let bearer = header("authorization")
        .unwrap_or_default()
        .trim_start_matches("Bearer ")
        .to_owned();
    let mut s = st.lock().unwrap();
    s.seen.push(format!("{method} {path}"));
    let s = &mut *s;
    let mut found: Vec<String> = Vec::new();
    let json = |status: &str, value: Value| {
        (
            status.to_owned(),
            "application/json",
            value.to_string(),
            None,
        )
    };
    let (status, kind, out, location): (String, &str, String, Option<String>) = match (method, path)
    {
        ("GET", "/.well-known/openid-configuration") => json(
            "200 OK",
            json!({ "issuer": base, "token_endpoint": format!("{base}/api/accounts/oauth/token"),
                    "authorization_endpoint": format!("{base}/api/accounts/authorize"),
                    "revocation_endpoint": format!("{base}/api/accounts/oauth/revoke") }),
        ),
        ("GET", "/api/accounts/authorize") => {
            let want = [
                ("client_id", "dynamic_agent_client"),
                ("agent_name_hint", "Tasktap"),
                ("response_type", "code"),
                ("resource", "https://api.openai.com/v1"),
                ("code_challenge_method", "S256"),
                (
                    "scope",
                    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
                ),
            ];
            for (k, v) in want {
                if q.get(k).map(String::as_str) != Some(v) {
                    found.push(format!("authorize: {k} {:?}", q.get(k)));
                }
            }
            let host = q.get("ext_agent_host_id").cloned().unwrap_or_default();
            let uuid = host.strip_prefix("urn:uuid:").unwrap_or_default();
            if uuid.len() != 36
                || uuid.as_bytes()[14] != b'4'
                || !"89ab".contains(uuid.as_bytes()[19] as char)
            {
                found.push(format!("authorize: ext_agent_host_id {host}"));
            }
            let redirect = q.get("redirect_uri").cloned().unwrap_or_default();
            if !redirect.starts_with("http://127.0.0.1:") || !redirect.ends_with("/auth/callback") {
                found.push(format!("authorize: redirect_uri {redirect}"));
            }
            let challenge = q.get("code_challenge").cloned().unwrap_or_default();
            if challenge.len() != 43
                || q.get("state").is_none_or(|v| v.len() < 32)
                || q.get("nonce").is_none_or(|v| v.len() < 32)
            {
                found.push("authorize: code_challenge, state or nonce".into());
            }
            if q.contains_key("id_token_hint") {
                found.push("authorize: a token in the address".into());
            }
            s.opened.push(q.clone());
            let mut back = format!(
                "{redirect}?state={}",
                q.get("state").cloned().unwrap_or_default()
            );
            if s.deny {
                back.push_str("&error=access_denied");
            } else {
                let code = mint("code-");
                s.secrets.push(code.clone());
                let nonce = q.get("nonce").cloned().unwrap_or_default();
                s.grants.insert(
                    code.clone(),
                    Grant {
                        challenge,
                        redirect: redirect.clone(),
                        nonce,
                        used: false,
                    },
                );
                back.push_str(&format!("&code={code}&client_id={}", s.issued));
            }
            ("302 Found".into(), "text/plain", String::new(), Some(back))
        }
        ("POST", "/api/accounts/oauth/token") => {
            if !header("content-type")
                .unwrap_or_default()
                .contains("application/x-www-form-urlencoded")
            {
                found.push("token: not form-encoded".into());
            }
            if form.get("client_id") != Some(&s.issued) {
                found.push(format!("token: client_id {:?}", form.get("client_id")));
            }
            if form.get("resource").map(String::as_str) != Some("https://api.openai.com/v1") {
                found.push("token: resource".into());
            }
            if form.contains_key("client_secret") || form.contains_key("scope") {
                found.push("token: a secret or a scope".into());
            }
            let grant = form.get("grant_type").cloned().unwrap_or_default();
            let tokens = |s: &mut State, nonce: Option<String>| {
                let (access, refresh) = (mint("at-"), mint("rt-"));
                s.access.push(access.clone());
                s.refresh.insert(refresh.clone(), false);
                let now = wall_ms() / 1000;
                let nonce = if s.wrong_nonce {
                    Some("another".into())
                } else {
                    nonce
                };
                let claims = json!({ "iss": base, "aud": s.issued, "sub": "user-standin", "email": "person@example.com",
                                     "iat": now, "exp": now + 3600, "nonce": nonce });
                let id = format!(
                    "{}.{}.{}",
                    b64(br#"{"alg":"RS256","kid":"k"}"#),
                    b64(claims.to_string().as_bytes()),
                    b64(b"signature")
                );
                s.secrets
                    .extend([access.clone(), refresh.clone(), id.clone()]);
                let scope = match s.no_plan {
                    true => "email offline_access openid profile",
                    false => {
                        "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke"
                    }
                };
                let mut out = json!({ "access_token": access, "refresh_token": refresh, "token_type": "Bearer",
                                      "expires_in": s.expires_in, "scope": scope });
                if nonce.is_some() || grant == "authorization_code" {
                    out["id_token"] = id.into();
                }
                out
            };
            match grant.as_str() {
                "authorization_code" => {
                    let code = form.get("code").cloned().unwrap_or_default();
                    match s.grants.get_mut(&code) {
                        Some(g) if !g.used => {
                            g.used = true;
                            let verifier = form.get("code_verifier").cloned().unwrap_or_default();
                            if b64(&Sha256::digest(verifier.as_bytes())) != g.challenge {
                                found.push("token: code_verifier".into());
                            }
                            if form.get("redirect_uri") != Some(&g.redirect) {
                                found.push("token: redirect_uri".into());
                            }
                            let nonce = Some(g.nonce.clone());
                            json("200 OK", tokens(s, nonce))
                        }
                        _ => json("400 Bad Request", json!({ "error": "invalid_grant" })),
                    }
                }
                "refresh_token" => {
                    let token = form.get("refresh_token").cloned().unwrap_or_default();
                    match s.refresh.get(&token).copied() {
                        _ if s.refuse_renewal => json(
                            "400 Bad Request",
                            json!({ "error": "invalid_grant", "error_description": "The refresh token is no longer valid." }),
                        ),
                        Some(false) => {
                            s.refresh.insert(token, true);
                            json("200 OK", tokens(s, None))
                        }
                        Some(true) => {
                            found.push("token: a refresh token used twice".into());
                            json(
                                "400 Bad Request",
                                json!({ "error": "refresh_token_reused" }),
                            )
                        }
                        None => json("400 Bad Request", json!({ "error": "invalid_grant" })),
                    }
                }
                _ => json(
                    "400 Bad Request",
                    json!({ "error": "unsupported_grant_type" }),
                ),
            }
        }
        ("POST", "/api/accounts/oauth/revoke") => {
            if form.get("token_type_hint").map(String::as_str) != Some("refresh_token")
                || form.get("client_id") != Some(&s.issued)
            {
                found.push("revoke: fields".into());
            }
            s.revoked
                .push(form.get("token").cloned().unwrap_or_default());
            ("200 OK".into(), "text/plain", String::new(), None)
        }
        (_, p) if p.starts_with("/v1/") && !s.access.contains(&bearer) => {
            json("401 Unauthorized", json!({ "detail": "not signed in" }))
        }
        ("GET", "/v1/models") => json(
            "200 OK",
            json!({ "models": [
                { "slug": "internal-mini", "display_name": "Internal mini", "visibility": "hide" },
                { "slug": "gpt-6-luna", "display_name": "GPT-6 Luna", "visibility": "list" },
                { "slug": "gpt-6.2-sol", "display_name": "GPT-6.2 Sol", "visibility": "list" },
            ] }),
        ),
        ("POST", "/v1/responses") => {
            let body: Value = serde_json::from_str(&text).unwrap_or_default();
            if body["store"] != false || body["stream"] != true {
                found.push("responses: store and stream".into());
            }
            for f in [
                "max_output_tokens",
                "temperature",
                "top_p",
                "previous_response_id",
                "user",
                "metadata",
            ] {
                if body.get(f).is_some() {
                    found.push(format!("responses: {f}"));
                }
            }
            if !header("content-type")
                .unwrap_or_default()
                .contains("application/json")
            {
                found.push("responses: not JSON".into());
            }
            s.bodies.push(body);
            let event = |e: Value| format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap());
            match s.replies.pop_front().unwrap_or(Reply::Cut) {
                Reply::Refuse(code, error) => {
                    let status = match code {
                        429 => "429 Too Many Requests",
                        403 => "403 Forbidden",
                        _ => "400 Bad Request",
                    };
                    json(
                        status,
                        json!({ "error": { "code": error, "message": "Not now." } }),
                    )
                }
                reply => {
                    let mut out = event(
                        json!({ "type": "response.created", "response": { "id": "resp_1", "status": "in_progress" } }),
                    );
                    match reply {
                        Reply::Limit => {
                            out += &event(
                                json!({ "type": "response.failed", "response": { "id": "resp_1", "status": "failed",
                            "error": { "code": "subscription_sharing_usage_limit_exceeded", "message": "Usage limit reached." } } }),
                            )
                        }
                        Reply::Answer(text) => {
                            let half = text.len() / 2;
                            for piece in [&text[..half], &text[half..]] {
                                out += &event(
                                    json!({ "type": "response.output_text.delta", "delta": piece }),
                                );
                            }
                            out += &event(
                                json!({ "type": "response.completed", "response": { "id": "resp_1", "status": "completed",
                                "output": [{ "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": text }] }] } }),
                            );
                        }
                        _ => {
                            out += &event(
                                json!({ "type": "response.output_text.delta", "delta": "{\"quote\":" }),
                            )
                        }
                    }
                    ("200 OK".into(), "text/event-stream", out, None)
                }
            }
        }
        _ => json("404 Not Found", json!({ "error": "not here" })),
    };
    s.problems.extend(found);
    let location = location
        .map(|l| format!("Location: {l}\r\n"))
        .unwrap_or_default();
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\n{location}Content-Length: {}\r\nConnection: close\r\n\r\n",
        out.len()
    );
    let _ = conn.write_all(format!("{head}{out}").as_bytes());
}

/// A GET as a browser makes it: the status, where it is sent next, and
/// the page.
fn get(url: &str) -> (u16, Option<String>, String) {
    let rest = url.strip_prefix("http://").unwrap();
    let (host, path) = rest.split_at(rest.find('/').unwrap());
    let mut conn = TcpStream::connect(host).unwrap();
    write!(
        conn,
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut answer = String::new();
    conn.read_to_string(&mut answer).unwrap();
    let status = answer.split(' ').nth(1).unwrap().parse().unwrap();
    let location = (answer.lines())
        .find_map(|l| l.strip_prefix("Location: "))
        .map(str::to_owned);
    let page = answer
        .split("\r\n\r\n")
        .nth(1)
        .unwrap_or_default()
        .to_owned();
    (status, location, page)
}

/// A model's answer, as the schema has it.
fn answer(confidence: &str, to: &str, brief: &str) -> String {
    json!({ "quote": "", "confidence": confidence, "to": to, "candidates": [],
            "brief": brief, "title": "" })
    .to_string()
}

const SPOKEN: &str = "um so the thing with the header, the one we did last week, it wraps on small screens \
    and, well, I want it to stay on one line, just let the menu collapse earlier";

/// A core pointed at the stand-in, with two projects and the fixture
/// agent's program, its clock standing still.
struct Placing {
    // First, so the core ends before its folder is removed.
    _core: Core,
    w: Watch,
    data: Folder,
    openai: StandIn,
    app: ProjectId,
}

impl Placing {
    fn new(prefix: &str) -> Placing {
        let data = Folder::new(prefix);
        let openai = StandIn::start();
        let path = path_with(&agents(&data.0));
        let core = Core::start_env(
            &data.0,
            &[],
            &[("PATH", &path), ("TASKTAP_CHATGPT", &openai.base)],
        );
        let mut w = core.watch();
        let mut add = |name: &str| {
            let folder = data.0.join(name);
            std::fs::create_dir_all(&folder).unwrap();
            let add = AddProject {
                id: ProjectId::mint(),
                folder: folder.to_str().unwrap().into(),
                name: None,
            };
            w.ok::<call::ProjectAdd>(&add)
        };
        let (app, _folio) = (add("app"), add("folio"));
        std::fs::create_dir_all(data.0.join("route")).unwrap();
        w.ok::<call::FixtureClock>(&FixtureClock {
            now: time(wall_ms()),
        });
        Placing {
            _core: core,
            w,
            data,
            openai,
            app,
        }
    }

    fn chatgpt(&self) -> Option<ChatGpt> {
        match self.w.model.prefs.get(&PrefKey::Chatgpt) {
            Some(PrefValue::Chatgpt(seen)) => seen.clone(),
            _ => None,
        }
    }

    fn state(&self) -> Option<SignIn> {
        self.chatgpt().map(|c| c.state)
    }

    fn route_by(&self) -> Option<RouteBy> {
        match self.w.model.prefs.get(&PrefKey::RouteBy) {
            Some(PrefValue::RouteBy(by)) => by.clone(),
            _ => None,
        }
    }

    fn agree(&mut self, agents: &[&str]) {
        let agents = (agents.iter())
            .map(|a| Placer {
                agent: (*a).into(),
                model: if *a == "chatgpt" {
                    "gpt-6.2-sol"
                } else {
                    "fixture-small"
                }
                .into(),
                on: true,
            })
            .collect();
        let target = PutTarget::Prefs(PrefPatch::RouteBy(Some(RouteBy {
            agents,
            terms: TERMS,
        })));
        self.w.ok::<call::Put>(&Put {
            target,
            if_rev: None,
        });
    }

    /// Starts a sign-in: the address the core answers with.
    fn start(&mut self) -> String {
        let address = self.w.ok::<call::ChatgptSignIn>(&Empty {});
        self.w.until("waiting", |m| {
            matches!(m.prefs.get(&PrefKey::Chatgpt), Some(PrefValue::Chatgpt(Some(c))) if c.state == SignIn::Waiting)
        });
        address
    }

    /// The browser at OpenAI's page, sent back to the core: what the
    /// core's page says.
    fn browse(&mut self, address: &str) -> (u16, String) {
        let (status, back, _) = get(address);
        assert_eq!(status, 302);
        let (status, _, page) = get(&back.unwrap());
        (status, page)
    }

    /// The sign-in once it no longer waits.
    fn ended(&mut self) -> ChatGpt {
        self.w.until("the sign-in ended", |m| {
            matches!(m.prefs.get(&PrefKey::Chatgpt), Some(PrefValue::Chatgpt(Some(c))) if c.state != SignIn::Waiting)
        });
        self.chatgpt().unwrap()
    }

    fn sign_in(&mut self) {
        let address = self.start();
        let (status, page) = self.browse(&address);
        assert_eq!(status, 200);
        assert!(page.contains("Tasktap finishes the sign-in"), "{page}");
        assert_eq!(self.ended().state, SignIn::SignedIn);
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

    fn settled(&mut self, id: ThoughtId) -> Thought {
        self.w.until("placed", |m| {
            !m.thought(id).route.as_ref().is_some_and(|r| r.pending)
        });
        self.w.model.thought(id).clone()
    }

    /// The steps the fixture agent's tool runs when it is asked next.
    fn script(&self, steps: &[String]) {
        std::fs::write(self.data.0.join("route").join("ask"), steps.join("\n")).unwrap();
    }

    /// No token the stand-in gave out is in any file of the data folder
    /// (the database, its journal, anything else the core wrote), nor in a
    /// record the pages were sent.
    fn kept_nowhere(&self) {
        let secrets = self.openai.with(|s| s.secrets.clone());
        assert!(secrets.len() >= 4, "{secrets:?}");
        let mut files = vec![self.data.0.clone()];
        let mut texts = Vec::new();
        while let Some(path) = files.pop() {
            match std::fs::read_dir(&path) {
                Ok(dir) => files.extend(dir.flatten().map(|e| e.path())),
                Err(_) => texts.push((path.clone(), std::fs::read(&path).unwrap_or_default())),
            }
        }
        let records = json!({
            "stored": self.w.model.stored(),
            "prefs": self.w.model.prefs.values().collect::<Vec<_>>(),
        })
        .to_string();
        texts.push(("records".into(), records.into_bytes()));
        for secret in &secrets {
            for (path, bytes) in &texts {
                let found = bytes.windows(secret.len()).any(|w| w == secret.as_bytes());
                assert!(!found, "a token is in {}", path.display());
            }
        }
    }
}

#[test]
fn signing_in_with_chatgpt_agrees_to_its_row_alone_and_places_by_one_direct_call() {
    let mut p = Placing::new("chatgpt-sign-in");
    // Before any sign-in ChatGPT is offered first, with the model it would
    // ask, and asks nothing: placing is off.
    let terms = p.w.ok::<call::RouteTerms>(&Empty {});
    let first = &terms.tools[0];
    assert_eq!(
        (first.agent.as_str(), first.model.as_str(), first.ms),
        ("chatgpt", "gpt-6.2-sol", Some(4000))
    );
    assert_eq!((p.chatgpt(), p.route_by()), (None, None));
    let address = p.start();
    assert!(
        address.starts_with(&format!("{}/api/accounts/authorize?", p.openai.base)),
        "{address}"
    );
    // One sign-in at a time.
    let again = p.w.refused::<call::ChatgptSignIn>(&Empty {});
    assert_eq!(again.code, Code::Conflict);
    let (status, page) = p.browse(&address);
    assert_eq!(status, 200);
    assert!(page.contains("Tasktap finishes the sign-in"), "{page}");
    let signed = p.ended();
    assert_eq!(
        signed,
        ChatGpt {
            state: SignIn::SignedIn,
            model: Some("gpt-6.2-sol".into()),
            name: Some("GPT-6.2 Sol".into()),
            error: None,
        }
    );
    // The account's models were asked once; the listener is closed.
    assert_eq!(p.openai.seen("GET /v1/models"), 1);
    let port = address
        .split("127.0.0.1%3A")
        .nth(1)
        .unwrap()
        .split('%')
        .next()
        .unwrap();
    assert!(TcpStream::connect(format!("127.0.0.1:{port}")).is_err());
    // Never agreed before: placing is on, with ChatGPT's row alone.
    let row = Placer {
        agent: "chatgpt".into(),
        model: "gpt-6.2-sol".into(),
        on: true,
    };
    assert_eq!(
        p.route_by(),
        Some(RouteBy {
            agents: vec![row],
            terms: TERMS
        })
    );
    let refused = p.w.refused::<call::ChatgptSignIn>(&Empty {});
    assert_eq!(refused.code, Code::Conflict);

    // A thought the names do not place goes to ChatGPT, asked as an agent
    // is, and its answer is taken as an agent's is.
    p.openai.answers(Reply::Answer(answer(
        "clear",
        "p2",
        "Keep the header on one line.",
    )));
    let t = p.capture(SPOKEN);
    let th = p.settled(t);
    assert_eq!(
        (th.status, th.project_id, th.placed),
        (Status::Routed, Some(p.app), Some(Placed::Model))
    );
    assert_eq!(th.brief.as_deref(), Some("Keep the header on one line."));
    let route = th.route.unwrap();
    assert_eq!(
        (route.by.as_str(), route.model.as_deref(), route.fallback),
        ("chatgpt", Some("gpt-6.2-sol"), None)
    );
    let body = p.openai.with(|s| s.bodies[0].clone());
    assert_eq!(body["model"], "gpt-6.2-sol");
    assert_eq!(body["instructions"], INSTRUCTIONS);
    assert_eq!(body["reasoning"], json!({ "effort": "low" }));
    let schema: Value = serde_json::from_str(SCHEMA).unwrap();
    assert_eq!(
        body["text"],
        json!({ "format": { "type": "json_schema", "name": "placing", "schema": schema, "strict": true } })
    );
    let input = body["input"].as_array().unwrap();
    assert_eq!((input.len(), &input[0]["role"]), (1, &json!("user")));
    p.openai.no_problems();
    p.kept_nowhere();

    // Signing out ends the sign-in at OpenAI and takes the row out.
    let refresh = p.openai.with(|s| s.refresh.keys().next().cloned().unwrap());
    p.w.ok::<call::ChatgptSignOut>(&Empty {});
    p.w.sync();
    assert_eq!(p.openai.with(|s| s.revoked.clone()), [refresh.as_str()]);
    assert_eq!(p.chatgpt(), None);
    // And deletes it: signing out again finds nothing to end.
    p.w.ok::<call::ChatgptSignOut>(&Empty {});
    assert_eq!(p.openai.with(|s| s.revoked.clone()), [refresh.as_str()]);
    assert_eq!(p.openai.seen("GET /.well-known/openid-configuration"), 1);
    assert_eq!(
        p.route_by(),
        Some(RouteBy {
            agents: vec![],
            terms: TERMS
        })
    );
    // Nothing is asked of ChatGPT any more.
    let t = p.capture(SPOKEN);
    let th = p.settled(t);
    assert_eq!(th.route.unwrap().by, "local");
    assert_eq!(p.openai.seen("POST /v1/responses"), 1);
    // The sign-in was deleted: the next one registers anew and asks for a
    // new host id.
    p.sign_in();
    let opened = p.openai.with(|s| s.opened.clone());
    assert_eq!(opened.len(), 2);
    assert_ne!(
        opened[0]["ext_agent_host_id"],
        opened[1]["ext_agent_host_id"]
    );
    p.openai.no_problems();
    p.kept_nowhere();
}

#[test]
fn the_question_is_an_agents_and_what_chatgpt_cannot_answer_passes_to_the_next() {
    let mut p = Placing::new("chatgpt-question");
    p.sign_in();
    // The agent first, which fails; ChatGPT next is sent exactly what the
    // agent was: the instructions in their own field, the request after.
    p.agree(&["fixture", "chatgpt"]);
    p.script(&["exit:3".into()]);
    p.openai
        .answers(Reply::Answer(answer("clear", "p2", "Brief.")));
    let t = p.capture(SPOKEN);
    assert_eq!(p.settled(t).route.unwrap().by, "chatgpt");
    let agent = std::fs::read_to_string(p.data.0.join("route").join("asked")).unwrap();
    let body = p.openai.with(|s| s.bodies.pop().unwrap());
    let sent = format!(
        "{}\n{}",
        body["instructions"].as_str().unwrap(),
        body["input"][0]["content"].as_str().unwrap()
    );
    assert_eq!(sent, agent);

    // ChatGPT alone: what it could not answer is said where an agent's is,
    // and the names place the thought.
    p.agree(&["chatgpt"]);
    let cases = [
        (
            Reply::Refuse(429, "subscription_sharing_usage_limit_exceeded"),
            "chatgpt: your ChatGPT plan has reached its limit for now (subscription_sharing_usage_limit_exceeded: Not now.)",
        ),
        (
            Reply::Refuse(403, "subscription_sharing_user_not_eligible"),
            "chatgpt: ChatGPT does not let Tasktap use your plan (subscription_sharing_user_not_eligible: Not now.)",
        ),
        (
            Reply::Limit,
            "chatgpt: ChatGPT stopped its answer (subscription_sharing_usage_limit_exceeded: Usage limit reached.)",
        ),
        (Reply::Cut, "chatgpt: its answer ended before it was whole"),
        (
            Reply::Answer("{\"to\": \"p1\"}".into()),
            "chatgpt: its answer is not the JSON it was asked for",
        ),
        (
            Reply::Answer(answer("clear", "p9", "Brief.")),
            "chatgpt: it names \"p9\", which it was not offered",
        ),
    ];
    for (reply, said) in cases {
        p.openai.answers(reply);
        let t = p.capture(SPOKEN);
        let th = p.settled(t);
        let route = th.route.unwrap();
        assert_eq!(route.by, "local");
        let fallback = route.fallback.unwrap();
        assert!(fallback.starts_with(said), "{fallback}");
    }
    // Before another: each of those passes the thought to the next.
    p.agree(&["chatgpt", "fixture"]);
    for reply in [
        Reply::Refuse(429, "subscription_sharing_usage_limit_exceeded"),
        Reply::Refuse(403, "x"),
        Reply::Answer("[]".into()),
    ] {
        p.openai.answers(reply);
        p.script(&[format!("print:{}", answer("clear", "p1", "Brief."))]);
        let t = p.capture(SPOKEN);
        let route = p.settled(t).route.unwrap();
        assert_eq!((route.by.as_str(), route.fallback), ("fixture", None));
    }
    p.openai.no_problems();
    p.kept_nowhere();
}

#[test]
fn a_sign_in_near_its_end_is_renewed_first_and_one_openai_refuses_signs_out() {
    let mut p = Placing::new("chatgpt-renew");
    // Five minutes: every placing finds under ten left and renews first.
    p.openai.with(|s| s.expires_in = 300);
    p.sign_in();
    for _ in 0..2 {
        p.openai
            .answers(Reply::Answer(answer("clear", "p2", "Brief.")));
        let t = p.capture(SPOKEN);
        assert_eq!(p.settled(t).route.unwrap().by, "chatgpt");
    }
    // Each renewal sent the refresh token the one before it gave: the
    // stand-in refuses one used twice, and three were given out.
    assert_eq!(p.openai.seen("POST /api/accounts/oauth/token"), 3);
    let used = p
        .openai
        .with(|s| s.refresh.values().filter(|used| **used).count());
    assert_eq!(used, 2);
    p.openai.no_problems();

    // An hour left: no renewal. A question OpenAI then does not take the
    // sign-in for renews it at once, for the next thought.
    p.openai.with(|s| s.expires_in = 3600);
    p.openai
        .answers(Reply::Answer(answer("clear", "p2", "Brief.")));
    let t = p.capture(SPOKEN);
    assert_eq!(p.settled(t).route.unwrap().by, "chatgpt");
    p.openai.with(|s| {
        s.access.clear();
        s.expires_in = 300;
    });
    let t = p.capture(SPOKEN);
    let fallback = p.settled(t).route.unwrap().fallback.unwrap();
    let said = "chatgpt: ChatGPT did not take the sign-in, which is renewed for the next task";
    assert!(fallback.starts_with(said), "{fallback}");
    assert_eq!(p.openai.seen("POST /api/accounts/oauth/token"), 5);
    p.openai
        .answers(Reply::Answer(answer("clear", "p2", "Brief.")));
    let t = p.capture(SPOKEN);
    assert_eq!(p.settled(t).route.unwrap().by, "chatgpt");
    p.openai.no_problems();

    // OpenAI refuses the next renewal: the row is signed out, why is said,
    // and the next in the order places the thought.
    p.agree(&["chatgpt", "fixture"]);
    p.openai.with(|s| s.refuse_renewal = true);
    p.script(&[format!("print:{}", answer("clear", "p1", "Brief."))]);
    let t = p.capture(SPOKEN);
    assert_eq!(p.settled(t).route.unwrap().by, "fixture");
    assert_eq!(p.state(), Some(SignIn::SignedOut));
    let by = p.route_by().unwrap();
    assert_eq!(by.agents[0].agent, "chatgpt");
    // ChatGPT alone, signed out: the thought says so.
    p.agree(&["chatgpt"]);
    let t = p.capture(SPOKEN);
    let route = p.settled(t).route.unwrap();
    assert_eq!(
        (route.by.as_str(), route.fallback.as_deref()),
        ("local", Some("ChatGPT is not signed in"))
    );
    assert_eq!(p.openai.seen("POST /v1/responses"), 5);
    p.kept_nowhere();
}

#[test]
fn a_sign_in_that_does_not_finish_says_why_and_keeps_nothing() {
    let mut p = Placing::new("chatgpt-refused");
    // An answer with another state is refused, and the wait goes on.
    let address = p.start();
    let (_, back, _) = get(&address);
    let back = back.unwrap();
    let state = fields(back.split_once('?').unwrap().1)["state"].clone();
    let (status, _, page) = get(&back.replace(&state, "another-state"));
    assert_eq!(status, 400);
    assert!(page.contains("does not belong"), "{page}");
    assert_eq!(p.state(), Some(SignIn::Waiting));
    let (status, _, _) = get(&back);
    assert_eq!(status, 200);
    assert_eq!(p.ended().state, SignIn::SignedIn);
    p.w.ok::<call::ChatgptSignOut>(&Empty {});
    p.w.sync();

    // An ID token of another attempt, a person who declines, and one who
    // does not allow the use of their plan.
    p.openai.with(|s| s.wrong_nonce = true);
    let address = p.start();
    p.browse(&address);
    let ended = p.ended();
    assert_eq!(
        (ended.state, ended.error.as_deref()),
        (
            SignIn::Failed,
            Some("the ID token belongs to another sign-in attempt")
        )
    );
    p.openai.with(|s| (s.wrong_nonce, s.deny) = (false, true));
    let address = p.start();
    let (_, page) = p.browse(&address);
    assert!(page.contains("did not finish"), "{page}");
    let ended = p.ended();
    assert_eq!(
        (ended.state, ended.error.as_deref()),
        (SignIn::Failed, Some("access_denied"))
    );
    p.openai.with(|s| (s.deny, s.no_plan) = (false, true));
    let address = p.start();
    p.browse(&address);
    assert_eq!(p.ended().state, SignIn::NoPlan);
    // None of them agreed to anything or kept a sign-in.
    assert_eq!(
        p.route_by(),
        Some(RouteBy {
            agents: vec![],
            terms: TERMS
        })
    );
    assert_eq!(p.openai.seen("GET /v1/models"), 1);

    // Cancelled, the wait ends and the listener closes.
    p.openai.with(|s| s.no_plan = false);
    let address = p.start();
    p.w.ok::<call::ChatgptSignOut>(&Empty {});
    p.w.sync();
    assert_eq!(p.chatgpt(), None);
    let (_, back, _) = get(&address);
    let port = back
        .unwrap()
        .split(':')
        .nth(2)
        .unwrap()
        .split('/')
        .next()
        .unwrap()
        .to_owned();
    // It looks for the word every 50 ms.
    let closed = (0..40).any(|_| {
        let refused = TcpStream::connect(format!("127.0.0.1:{port}")).is_err();
        if !refused {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        refused
    });
    assert!(closed, "the listener is still open");
    // Only the core writes the sign-in's record.
    let refused = p.w.refused::<call::Delete>(&tasktap_proto::Delete::Prefs {
        id: PrefKey::Chatgpt,
    });
    assert_eq!(refused.code, Code::Invalid);
    p.openai.no_problems();
    p.kept_nowhere();

    // A core that stops while a sign-in waits leaves none waiting.
    p.start();
    let Placing {
        _core: core,
        w,
        data,
        openai,
        ..
    } = p;
    drop(w);
    core.stop();
    let core = Core::start_env(&data.0, &[], &[("TASKTAP_CHATGPT", &openai.base)]);
    let w = core.watch();
    let none = PrefValue::Chatgpt(None);
    assert_eq!(w.model.prefs.get(&PrefKey::Chatgpt), Some(&none));
}
