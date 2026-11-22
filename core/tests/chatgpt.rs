//! Placing on the person's own ChatGPT plan (design §8, "ChatGPT"): the
//! sign-in with ChatGPT, its renewal and its end, and the placing it makes,
//! through the real binary.
//!
//! No test reaches OpenAI: OpenAI's sign-in and Responses endpoints are a
//! server of this file on this machine, which holds every request to what
//! OpenAI's pages ask and writes down what it finds wrong, as
//! `trials/siwc/standin.mjs` does, and hands out tokens of the length
//! OpenAI's are (an access token of about 2,000 characters, a signed JWT as
//! OpenAI's is). The core is pointed at it with `TASKTAP_CHATGPT`, which only
//! a build with the test fixtures reads. No test touches the real
//! credential store: a core built with its fixtures keeps the sign-in in
//! memory, which refuses to keep anything while the file `TASKTAP_VAULT_REFUSES`
//! names is there. The test is the browser: it follows the address the core
//! answers with.

mod common;

use common::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;
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
    client: String,
    used: bool,
}

/// What the stand-in was asked and gave out, and what the test tells it.
#[derive(Default)]
struct State {
    /// The client ids it issued, one for each registration, the last last.
    clients: Vec<String>,
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
    /// The account's list has no gpt-6.2-sol.
    no_sol: bool,
    deny: bool,
    refuse_renewal: bool,
    /// It no longer knows the client ids it issued.
    refuse_client: bool,
    /// It no longer knows the client ids it issued, and says so on its own
    /// page, sending the browser nowhere.
    reject_client: bool,
    /// Milliseconds it takes to answer a renewal, and a code's exchange.
    renew_delay: u64,
    code_delay: u64,
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

    /// Until `ready` holds of what it saw, for at most 10 s.
    fn until(&self, what: &str, ready: impl Fn(&State) -> bool) {
        note(&format!("until the stand-in saw {what}"));
        for _ in 0..200 {
            if self.with(|s| ready(s)) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("the stand-in never saw {what}");
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

/// A token shaped as OpenAI's are: a JWT signed with RS256, whose 2048-bit
/// signature alone is 342 characters.
fn jwt(claims: &Value) -> String {
    let signature: Vec<u8> = (0..256).map(|i| (i * 7 + 3) as u8).collect();
    let head = b64(br#"{"alg":"RS256","kid":"stand-in","typ":"JWT"}"#);
    format!(
        "{head}.{}.{}",
        b64(claims.to_string().as_bytes()),
        b64(&signature)
    )
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
    // A slow answer keeps nobody else waiting.
    if path == "/api/accounts/oauth/token" {
        let grant = form.get("grant_type").map(String::as_str);
        let delay = st
            .lock()
            .map(|s| {
                if grant == Some("refresh_token") {
                    s.renew_delay
                } else {
                    s.code_delay
                }
            })
            .unwrap();
        std::thread::sleep(Duration::from_millis(delay));
    }
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
        ("GET", "/api/accounts/authorize")
            if s.reject_client
                && q.get("client_id")
                    .is_some_and(|c| c != "dynamic_agent_client") =>
        {
            s.opened.push(q.clone());
            let page = "<p>This app is not known to ChatGPT.</p>".to_owned();
            ("400 Bad Request".into(), "text/html", page, None)
        }
        ("GET", "/api/accounts/authorize") => {
            // A first registration, or a sign-in under a client id it issued.
            let client = q.get("client_id").cloned().unwrap_or_default();
            let first = client == "dynamic_agent_client";
            match first {
                true if q.get("agent_name_hint").map(String::as_str) != Some("Tasktap") => {
                    found.push("authorize: agent_name_hint".into())
                }
                false if q.contains_key("agent_name_hint") => {
                    found.push("authorize: agent_name_hint when signing in again".into())
                }
                false if !s.clients.contains(&client) => {
                    found.push(format!("authorize: client_id {client}"))
                }
                _ => {}
            }
            let want = [
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
            } else if !first && s.refuse_client {
                back.push_str("&error=invalid_client&error_description=Unknown+client.");
            } else {
                let client = match first {
                    true => {
                        s.clients.push(mint("oaiapp_"));
                        s.clients.last().unwrap().clone()
                    }
                    false => client,
                };
                let code = mint("code-");
                s.secrets.push(code.clone());
                let nonce = q.get("nonce").cloned().unwrap_or_default();
                let grant = Grant {
                    challenge,
                    redirect: redirect.clone(),
                    nonce,
                    client: client.clone(),
                    used: false,
                };
                s.grants.insert(code.clone(), grant);
                back.push_str(&format!("&code={code}"));
                if first {
                    back.push_str(&format!("&client_id={client}"));
                }
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
            let client = form.get("client_id").cloned().unwrap_or_default();
            if !s.clients.contains(&client) {
                found.push(format!("token: client_id {client}"));
            }
            if form.get("resource").map(String::as_str) != Some("https://api.openai.com/v1") {
                found.push("token: resource".into());
            }
            if form.contains_key("client_secret") || form.contains_key("scope") {
                found.push("token: a secret or a scope".into());
            }
            let grant = form.get("grant_type").cloned().unwrap_or_default();
            let tokens = |s: &mut State, nonce: Option<String>| {
                let access = jwt(
                    &json!({ "jti": mint(""), "aud": "https://api.openai.com/v1", "scp": "x".repeat(1400) }),
                );
                let refresh = format!("rt_{}", (0..6).map(|_| mint("")).collect::<String>());
                s.access.push(access.clone());
                s.refresh.insert(refresh.clone(), false);
                let now = wall_ms() / 1000;
                let nonce = if s.wrong_nonce {
                    Some("another".into())
                } else {
                    nonce
                };
                let claims = json!({ "iss": base, "aud": client, "sub": "user-standin", "email": "person@example.com",
                                     "iat": now, "exp": now + 3600, "nonce": nonce });
                let id = jwt(&claims);
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
                if grant == "authorization_code" {
                    out["id_token"] = id.into();
                }
                out
            };
            match grant.as_str() {
                "authorization_code" => {
                    let code = form.get("code").cloned().unwrap_or_default();
                    match s.grants.get_mut(&code) {
                        Some(g) if !g.used && g.client == client => {
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
            let client = form.get("client_id").cloned().unwrap_or_default();
            if form.get("token_type_hint").map(String::as_str) != Some("refresh_token")
                || !s.clients.contains(&client)
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
        ("GET", "/v1/models") => {
            let mut models = vec![
                json!({ "slug": "internal-mini", "display_name": "Internal mini", "visibility": "hide" }),
                json!({ "slug": "gpt-6-luna", "display_name": "GPT-6 Luna", "visibility": "list" }),
            ];
            if !s.no_sol {
                models.push(json!({ "slug": "gpt-6.2-sol", "display_name": "GPT-6.2 Sol", "visibility": "list" }));
            }
            json("200 OK", json!({ "models": models }))
        }
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

/// The port of the core's listener, from the address it answered with.
fn port(address: &str) -> String {
    let redirect = fields(address.split_once('?').unwrap().1)["redirect_uri"].clone();
    redirect
        .split(':')
        .nth(2)
        .unwrap()
        .split('/')
        .next()
        .unwrap()
        .to_owned()
}

/// Whether nothing listens on `port` any more, within `ms`.
fn closed(port: &str, ms: u64) -> bool {
    (0..ms / 50).any(|_| {
        let refused = TcpStream::connect(format!("127.0.0.1:{port}")).is_err();
        if !refused {
            std::thread::sleep(Duration::from_millis(50));
        }
        refused
    })
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
        Placing::with(prefix, &[])
    }

    /// The same, the core started with `extra`.
    fn with(prefix: &str, extra: &[&str]) -> Placing {
        Placing::built(prefix, extra, true)
    }

    /// The same with no project known (`app` names none).
    fn bare(prefix: &str) -> Placing {
        Placing::built(prefix, &[], false)
    }

    fn built(prefix: &str, extra: &[&str], projects: bool) -> Placing {
        let data = Folder::new(prefix);
        let openai = StandIn::start();
        let core = Placing::core(&data, &openai, extra);
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
        let app = match projects {
            true => (add("app"), add("folio")).0,
            false => ProjectId::mint(),
        };
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

    fn core(data: &Folder, openai: &StandIn, extra: &[&str]) -> Core {
        let path = path_with(&agents(&data.0));
        let refuses = data.0.join("vault-refuses");
        let env = [
            ("PATH", path.as_str()),
            ("TASKTAP_CHATGPT", &openai.base),
            ("TASKTAP_VAULT_REFUSES", refuses.to_str().unwrap()),
        ];
        Core::start_env(&data.0, extra, &env)
    }

    /// The credential store refuses to keep anything, or keeps again.
    fn vault_refuses(&self, refuses: bool) {
        let file = self.data.0.join("vault-refuses");
        match refuses {
            true => std::fs::write(file, "").unwrap(),
            false => std::fs::remove_file(file).unwrap(),
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
        note("chatgpt.sign_in");
        let address = self.w.ok::<call::ChatgptSignIn>(&Empty {});
        self.w.until("waiting", |m| {
            matches!(m.prefs.get(&PrefKey::Chatgpt), Some(PrefValue::Chatgpt(Some(c))) if c.state == SignIn::Waiting)
        });
        address
    }

    /// The browser at OpenAI's page, sent back to the core: what the
    /// core's page says.
    fn browse(&mut self, address: &str) -> (u16, String) {
        note("the browser at OpenAI's page");
        let (status, back, _) = get(address);
        assert_eq!(status, 302);
        note("the browser back at the core");
        let (status, _, page) = get(&back.unwrap());
        note(&format!("the core's page: {status}"));
        (status, page)
    }

    /// The sign-in once it no longer waits.
    fn ended(&mut self) -> ChatGpt {
        note("until the sign-in ends");
        self.w.until("the sign-in ended", |m| {
            matches!(m.prefs.get(&PrefKey::Chatgpt), Some(PrefValue::Chatgpt(Some(c))) if c.state != SignIn::Waiting)
        });
        note(&format!("it ended: {:?}", self.state()));
        self.chatgpt().unwrap()
    }

    fn sign_in(&mut self) {
        let address = self.start();
        let (status, page) = self.browse(&address);
        assert_eq!(status, 200);
        assert!(page.contains("Tasktap finishes the sign-in"), "{page}");
        assert_eq!(self.ended().state, SignIn::SignedIn);
    }

    fn sign_out(&mut self) {
        note("chatgpt.sign_out");
        self.w.ok::<call::ChatgptSignOut>(&Empty {});
        self.w.sync();
        note("signed out");
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

    /// Who placed a thought ChatGPT is asked about first, and why the others
    /// did not.
    fn placed(&mut self, reply: Option<Reply>) -> (String, Option<String>) {
        if let Some(reply) = reply {
            self.openai.answers(reply);
        }
        note("a thought captured");
        let t = self.capture(SPOKEN);
        let route = self.settled(t).route.unwrap();
        note(&format!("placed by {}", route.by));
        (route.by, route.fallback)
    }

    /// The steps the fixture agent's tool runs when it is asked next.
    fn script(&self, steps: &[String]) {
        std::fs::write(self.data.0.join("route").join("ask"), steps.join("\n")).unwrap();
    }

    /// No token the stand-in gave out is in any file of the data folder
    /// (the database, its journal, anything else the core wrote), nor in a
    /// record the pages were sent. The fixture agent's program, which the
    /// test put there (a link to the core's own binary, tens of megabytes
    /// in a debug build), is not the core's writing and is not read.
    fn kept_nowhere(&self) {
        note("searching the data folder and the records for the tokens");
        let secrets = self.openai.with(|s| s.secrets.clone());
        assert!(secrets.len() >= 4, "{secrets:?}");
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
        note("no token found");
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
    assert!(TcpStream::connect(format!("127.0.0.1:{}", port(&address))).is_err());
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

    // Signing out ends the sign-in at OpenAI, and with no agreement before
    // it, leaves none: placing is as it was, not answered.
    let refresh = p.openai.with(|s| s.refresh.keys().next().cloned().unwrap());
    p.sign_out();
    assert_eq!(p.openai.with(|s| s.revoked.clone()), [refresh.as_str()]);
    assert_eq!(p.chatgpt(), None);
    assert!(!p.w.model.prefs.contains_key(&PrefKey::RouteBy));
    // And deletes it: signing out again finds nothing to end.
    p.sign_out();
    assert_eq!(p.openai.with(|s| s.revoked.clone()), [refresh.as_str()]);
    assert_eq!(p.openai.seen("GET /.well-known/openid-configuration"), 1);
    // Nothing is asked of ChatGPT any more.
    assert_eq!(p.placed(None).0, "local");
    assert_eq!(p.openai.seen("POST /v1/responses"), 1);
    // Signing in again reuses the registration: OpenAI's client id and the
    // host id, kept across the sign-out; nothing registers anew.
    p.sign_in();
    let opened = p.openai.with(|s| s.opened.clone());
    let client = p.openai.with(|s| s.clients.clone());
    assert_eq!(client.len(), 1);
    assert_eq!(opened[1]["client_id"], client[0]);
    assert!(!opened[1].contains_key("agent_name_hint"));
    assert_eq!(
        opened[0]["ext_agent_host_id"],
        opened[1]["ext_agent_host_id"]
    );
    p.openai.no_problems();
    p.kept_nowhere();
}

#[test]
fn with_no_project_known_chatgpt_is_asked_nothing_and_the_person_is_asked() {
    let mut p = Placing::bare("chatgpt-no-project");
    p.sign_in();
    assert!(
        p.route_by()
            .is_some_and(|by| by.agents.iter().any(|a| a.on))
    );
    let t = p.capture(SPOKEN);
    let th = p.settled(t);
    assert_eq!((th.project_id, th.status), (None, Status::NeedsYou));
    assert_eq!(th.route.unwrap().by, "local");
    let q = (p.w.model.questions.values())
        .find(|q| q.thought_id == Some(t))
        .expect("asked");
    assert_eq!(q.prompt, "Where should the agent work?");
    assert_eq!(p.openai.seen("POST /v1/responses"), 0);
    p.openai.no_problems();
}

#[test]
fn the_question_is_an_agents_and_what_chatgpt_cannot_answer_passes_to_the_next() {
    let mut p = Placing::new("chatgpt-question");
    p.sign_in();
    // The agent first, which fails; ChatGPT next is sent exactly what the
    // agent was: the instructions in their own field, the request after.
    p.agree(&["fixture", "chatgpt"]);
    p.script(&["exit:3".into()]);
    let (by, _) = p.placed(Some(Reply::Answer(answer("clear", "p2", "Brief."))));
    assert_eq!(by, "chatgpt");
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
        let (by, fallback) = p.placed(Some(reply));
        assert_eq!(by, "local");
        let fallback = fallback.unwrap();
        assert!(fallback.starts_with(said), "{fallback}");
    }
    // Before another: each of those passes the thought to the next.
    p.agree(&["chatgpt", "fixture"]);
    for reply in [
        Reply::Refuse(429, "subscription_sharing_usage_limit_exceeded"),
        Reply::Refuse(403, "x"),
        Reply::Answer("[]".into()),
    ] {
        p.script(&[format!("print:{}", answer("clear", "p1", "Brief."))]);
        assert_eq!(p.placed(Some(reply)), ("fixture".into(), None));
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
        let (by, _) = p.placed(Some(Reply::Answer(answer("clear", "p2", "Brief."))));
        assert_eq!(by, "chatgpt");
    }
    // Each renewal sent the refresh token the one before it gave: the
    // stand-in refuses one used twice, and three were given out.
    assert_eq!(p.openai.seen("POST /api/accounts/oauth/token"), 3);
    let used = p
        .openai
        .with(|s| s.refresh.values().filter(|used| **used).count());
    assert_eq!(used, 2);
    p.openai.no_problems();

    // A renewal slower than the placing's time: the placing passes the
    // thought on, and the renewal runs to its end and keeps what replaces
    // the refresh token, so the next placing renews with that, and nobody
    // is signed out.
    p.agree(&["chatgpt", "fixture"]);
    p.openai.with(|s| s.renew_delay = 9000);
    let (by, fallback) = p.placed(None);
    assert_eq!(by, "local");
    assert!(
        fallback
            .as_deref()
            .is_some_and(|f| f.starts_with("chatgpt: no time was left to ask it")),
        "{fallback:?}"
    );
    p.openai.until("the slow renewal answered", |s| {
        s.refresh.values().filter(|used| **used).count() == 3
    });
    std::thread::sleep(Duration::from_millis(500));
    p.openai.with(|s| s.renew_delay = 0);
    let (by, _) = p.placed(Some(Reply::Answer(answer("clear", "p2", "Brief."))));
    assert_eq!(by, "chatgpt");
    assert_eq!(p.state(), Some(SignIn::SignedIn));
    p.openai.no_problems();

    // An hour left: no renewal. A question OpenAI then does not take the
    // sign-in for says so, and the next placing renews first.
    p.agree(&["chatgpt"]);
    p.openai.with(|s| s.expires_in = 3600);
    let (by, _) = p.placed(Some(Reply::Answer(answer("clear", "p2", "Brief."))));
    assert_eq!(by, "chatgpt");
    let renewals = p.openai.seen("POST /api/accounts/oauth/token");
    // (What it renews to has five minutes, so the next renews again.)
    p.openai.with(|s| {
        s.access.clear();
        s.expires_in = 300;
    });
    let (_, fallback) = p.placed(None);
    let said = "chatgpt: ChatGPT did not take the sign-in, which is renewed for the next task";
    assert!(
        fallback.as_deref().is_some_and(|f| f.starts_with(said)),
        "{fallback:?}"
    );
    let (by, _) = p.placed(Some(Reply::Answer(answer("clear", "p2", "Brief."))));
    assert_eq!(by, "chatgpt");
    assert_eq!(
        p.openai.seen("POST /api/accounts/oauth/token"),
        renewals + 1
    );

    // The credential store does not keep a renewed sign-in: this placing
    // asks with it all the same, and the row says why it is not signed in.
    p.vault_refuses(true);
    let (by, _) = p.placed(Some(Reply::Answer(answer("clear", "p2", "Brief."))));
    assert_eq!(by, "chatgpt");
    p.w.until("the row says why", |m| !matches!(m.prefs.get(&PrefKey::Chatgpt), Some(PrefValue::Chatgpt(Some(c))) if c.state == SignIn::SignedIn));
    let row = p.chatgpt().unwrap();
    assert_eq!(row.state, SignIn::Failed);
    assert!(
        row.error
            .as_deref()
            .is_some_and(|e| e.contains("the credential store refused")),
        "{row:?}"
    );
    p.vault_refuses(false);
    p.openai.no_problems();

    // OpenAI refuses a renewal: the row is signed out, why is said, and the
    // next in the order places the thought.
    p.sign_in();
    p.agree(&["chatgpt", "fixture"]);
    p.openai.with(|s| s.refuse_renewal = true);
    p.script(&[format!("print:{}", answer("clear", "p1", "Brief."))]);
    assert_eq!(p.placed(None).0, "fixture");
    p.w.until("signed out", |m| matches!(m.prefs.get(&PrefKey::Chatgpt), Some(PrefValue::Chatgpt(Some(c))) if c.state == SignIn::SignedOut));
    let kept = p.route_by().unwrap();
    assert_eq!(kept.agents[0].agent, "chatgpt");
    // A sign-in begun then and cancelled puts back what was there: the
    // row kept for the next sign-in, and why it is not signed in.
    p.start();
    p.sign_out();
    assert_eq!(p.state(), Some(SignIn::SignedOut));
    assert_eq!(p.route_by(), Some(kept));
    // ChatGPT alone, signed out: the thought says so.
    p.agree(&["chatgpt"]);
    assert_eq!(
        p.placed(None),
        ("local".into(), Some("ChatGPT is not signed in".into()))
    );
    p.kept_nowhere();
}

#[test]
fn signing_out_while_a_thought_is_placed_leaves_the_row_as_signing_out_left_it() {
    let mut p = Placing::new("chatgpt-meanwhile");
    p.sign_in();
    // The agent first takes its time; meanwhile the person signs out.
    p.agree(&["fixture", "chatgpt"]);
    p.script(&["sleep:2000".into(), "exit:3".into()]);
    let t = p.capture(SPOKEN);
    p.sign_out();
    let fallback = p.settled(t).route.unwrap().fallback.unwrap();
    assert!(
        fallback.ends_with("chatgpt: ChatGPT is not signed in"),
        "{fallback}"
    );
    p.w.sync();
    assert_eq!(p.chatgpt(), None);
    assert_eq!(p.openai.seen("POST /v1/responses"), 0);
    p.openai.no_problems();
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
    p.sign_out();

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
    // An account whose list has no gpt-6.2-sol: the sign-in ends at OpenAI.
    p.openai.with(|s| (s.no_plan, s.no_sol) = (false, true));
    let revoked = p.openai.with(|s| s.revoked.len());
    let address = p.start();
    p.browse(&address);
    assert_eq!(p.ended().state, SignIn::NoModel);
    p.openai
        .until("the tokens ended", |s| s.revoked.len() == revoked + 1);
    // None of them agreed to anything or kept a sign-in.
    assert!(!p.w.model.prefs.contains_key(&PrefKey::RouteBy));
    p.openai.with(|s| s.no_sol = false);

    // Cancelled, the wait ends and the listener closes, also while a client
    // holds a connection open a byte at a time.
    let address = p.start();
    let port = port(&address);
    let at = format!("127.0.0.1:{port}");
    let drip = std::thread::spawn(move || {
        let mut c = TcpStream::connect(at).unwrap();
        for b in b"GET /auth/callback?state=x HTTP/1.1\r\nHost: x\r\n".iter() {
            if c.write_all(&[*b]).is_err() {
                break;
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    });
    std::thread::sleep(Duration::from_millis(300));
    p.sign_out();
    assert_eq!(p.state(), Some(SignIn::NoModel));
    assert!(closed(&port, 3000), "the listener is still open");
    drop(drip);
    // Cancelled once the code was exchanged: what OpenAI gave is ended there.
    p.openai.with(|s| s.code_delay = 1500);
    let revoked = p.openai.with(|s| s.revoked.len());
    let address = p.start();
    p.browse(&address);
    p.sign_out();
    p.openai.until("the cancelled sign-in ended", |s| {
        s.revoked.len() == revoked + 1
    });
    p.openai.with(|s| s.code_delay = 0);
    std::thread::sleep(Duration::from_millis(300));
    p.w.sync();
    assert_eq!(p.state(), Some(SignIn::NoModel));

    // OpenAI no longer knows the client id it issued: the sign-in says so,
    // and the next registers anew, with the same host id.
    let clients = p.openai.with(|s| s.clients.len());
    p.openai.with(|s| s.refuse_client = true);
    let address = p.start();
    p.browse(&address);
    let ended = p.ended();
    assert_eq!(
        (ended.state, ended.error.as_deref()),
        (SignIn::Failed, Some("invalid_client: Unknown client."))
    );
    p.openai.with(|s| s.refuse_client = false);
    p.sign_in();
    let opened = p.openai.with(|s| s.opened.clone());
    let last = opened.last().unwrap();
    assert_eq!(last["client_id"], "dynamic_agent_client");
    assert_eq!(last["ext_agent_host_id"], opened[0]["ext_agent_host_id"]);
    assert_eq!(p.openai.with(|s| s.clients.len()), clients + 1);
    p.sign_out();
    // Only the core writes the sign-in's record.
    let refused = p.w.refused::<call::Delete>(&tasktap_proto::Delete::Prefs {
        id: PrefKey::Chatgpt,
    });
    assert_eq!(refused.code, Code::Invalid);
    p.openai.no_problems();
    p.kept_nowhere();

    // A core that stops while a sign-in waits leaves none waiting, and the
    // next core signs in under the registration kept.
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
    let core = Placing::core(&data, &openai, &[]);
    let mut w = core.watch();
    let none = PrefValue::Chatgpt(None);
    assert_eq!(w.model.prefs.get(&PrefKey::Chatgpt), Some(&none));
    let address = w.ok::<call::ChatgptSignIn>(&Empty {});
    let client = openai.with(|s| s.clients.last().cloned().unwrap());
    assert_eq!(
        fields(address.split_once('?').unwrap().1)["client_id"],
        client
    );
}

#[test]
fn a_client_id_openai_no_longer_knows_is_forgotten_when_the_browser_never_comes_back() {
    // A second of 10 ms: the browser is waited for 3 s.
    let mut p = Placing::with("chatgpt-unknown", &["--second-ms", "10"]);
    p.sign_in();
    p.sign_out();
    let host = p.openai.with(|s| s.opened[0]["ext_agent_host_id"].clone());
    for cancelled in [true, false] {
        // The person removed Tasktap in ChatGPT's settings: OpenAI's page
        // says so, and sends the browser nowhere.
        p.openai.with(|s| s.reject_client = true);
        let address = p.start();
        let (status, back, _) = get(&address);
        assert_eq!((status, back), (400, None));
        match cancelled {
            true => p.sign_out(),
            false => {
                let ended = p.ended();
                let why = "no answer came from the browser within 5 minutes";
                assert_eq!(
                    (ended.state, ended.error.as_deref()),
                    (SignIn::Failed, Some(why))
                );
            }
        }
        // The next sign-in registers anew, under the same host id, and
        // signs in.
        p.openai.with(|s| s.reject_client = false);
        let clients = p.openai.with(|s| s.clients.len());
        p.sign_in();
        let last = p.openai.with(|s| s.opened.last().cloned().unwrap());
        assert_eq!(last["client_id"], "dynamic_agent_client");
        assert_eq!(last["ext_agent_host_id"], host);
        assert_eq!(p.openai.with(|s| s.clients.len()), clients + 1);
        p.sign_out();
    }
    p.openai.no_problems();
}
