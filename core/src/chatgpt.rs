//! Placing on the person's own ChatGPT plan (design §8, "ChatGPT"): the
//! sign-in with ChatGPT as a desktop app makes it, and the one direct call a
//! placing makes on it, with no agent started. Written from OpenAI's pages
//! as the trial in `trials/siwc` proved them (its README names them).
//!
//! The sign-in: the core listens on 127.0.0.1 at a port the system picks,
//! `chatgpt.sign_in` answers with the address of OpenAI's authorisation
//! page, which the host opens in the system's browser, and the browser comes
//! back to the listener with a one-time code, exchanged with PKCE. Tasktap
//! registers itself with OpenAI as "Tasktap" each time it signs in. The ID
//! token that comes with the tokens is checked: from OpenAI's sign-in, for
//! the client OpenAI issued, not expired, of this attempt. At most five
//! minutes of waiting and one sign-in at a time; the listener closes after.
//! The account's models are asked once, and the model placing asks for is
//! kept: [`MODEL`] where the list shows it, else the first it shows.
//!
//! The sign-in is kept in the system's credential store (`secrets.rs`), as a
//! speech service's key is: never in the database, a record, a reply or a
//! log. The `chatgpt` preference is all a page sees of it: waiting, signed
//! in with a model, or why not. Signing in is the agreement for ChatGPT's
//! row of placing and puts it first ([`agree`]); signing out takes it out.
//!
//! There is no timer: a placing that finds the access token (an hour) with
//! under ten minutes left renews it first and stores the refresh token
//! that replaces the old one (30 days) at once, one renewal at a time. A
//! refused renewal deletes the sign-in, and the preference says OpenAI
//! signed Tasktap out. `chatgpt.sign_out` ends the sign-in at OpenAI too.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, TryRecvError};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tasktap_proto::call::{self, Call, Code, Error};
use tasktap_proto::{
    ChatGpt as Seen, Control, Empty, Placer, PrefKey, PrefValue, RouteBy, Secret, SignIn,
};

use crate::agents::checks::Failed;
use crate::calls::Cx;
use crate::command::Wait;
use crate::http::{self, Body, Request};
use crate::secrets::{self, Vault};
use crate::serve::Core;
use crate::store::{self, Tx};
use crate::{effects, route};

/// ChatGPT's id where an agreement and a thought's `route` name who placed.
pub const ID: &str = "chatgpt";
/// The model placing asks for where the account's list shows it (the
/// owner's decision of 2026-11-21: the newest, 14 of 14 right).
pub const MODEL: &str = "gpt-6.2-sol";
/// The reasoning effort it is asked with, as Codex is.
const EFFORT: &str = "low";
/// Longest a placing may take, as long as the slowest agent's; what is
/// left of [`route::BUDGET`] bounds it.
pub const LIMIT: Duration = Duration::from_secs(15);
/// What the person sees Tasktap called while approving it, and in ChatGPT's
/// settings after.
const NAME: &str = "Tasktap";
/// Who the person is, staying signed in, and using their ChatGPT plan.
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/// Without this one granted, nothing may be asked on the person's plan.
const PLAN: &str = "chatgpt.tokens.use.direct";
const RESOURCE: &str = "https://api.openai.com/v1";
/// The first registration's entry point; never kept.
const FIRST_CLIENT: &str = "dynamic_agent_client";
const CALLBACK: &str = "/auth/callback";
/// Longest the browser is waited for.
const WAIT: Duration = Duration::from_secs(5 * 60);
/// Longest one call of the sign-in takes.
const CALL: Duration = Duration::from_secs(15);
/// Milliseconds an access token has left when a placing renews it first.
const RENEW: u64 = 10 * 60 * 1000;
/// Characters of the kept sign-in in one entry of the credential store: a
/// name holds at most 512 (`secrets::plain`), and Windows 2560 bytes.
const PART: usize = 500;

/// Where OpenAI's sign-in and API are; a build with the test fixtures takes
/// a stand-in on this machine from `TASKTAP_CHATGPT`.
struct OpenAi {
    auth: String,
    api: String,
}

fn openai() -> OpenAi {
    #[cfg(feature = "fixtures")]
    if let Ok(base) = std::env::var("TASKTAP_CHATGPT") {
        let api = format!("{base}/v1");
        return OpenAi { auth: base, api };
    }
    OpenAi {
        auth: "https://auth.openai.com".into(),
        api: RESOURCE.into(),
    }
}

/// The sign-in that waits for the browser, and what placings share.
pub struct ChatGpt {
    vault: Arc<dyn Vault>,
    /// One renewal at a time: a refresh token is good once.
    renewing: Arc<Mutex<()>>,
    /// The sign-in waiting for the browser, by its number, and what ends
    /// its wait.
    waiting: Option<(u64, mpsc::Sender<()>)>,
    attempts: u64,
}

impl Default for ChatGpt {
    fn default() -> Self {
        ChatGpt {
            vault: secrets::vault(),
            renewing: Default::default(),
            waiting: None,
            attempts: 0,
        }
    }
}

impl ChatGpt {
    /// A sign-in waits for the browser, which would be lost with the core.
    pub fn busy(&self) -> bool {
        self.waiting.is_some()
    }

    /// What a placing asks ChatGPT with, off the core's thread.
    pub fn asking(&self) -> Asking {
        Asking {
            vault: self.vault.clone(),
            renewing: self.renewing.clone(),
        }
    }
}

/// The sign-in as the credential store keeps it, in parts of [`PART`].
#[derive(Serialize, Deserialize)]
struct Kept {
    /// The client id OpenAI issued Tasktap when it registered.
    client: String,
    access: String,
    refresh: Option<String>,
    /// When the access token ends, in milliseconds since 1970.
    until: u64,
}

fn part(i: usize) -> String {
    format!("{ID}.{i}")
}

fn kept(vault: &dyn Vault) -> Result<Option<Kept>, String> {
    let mut text = String::new();
    for i in 0.. {
        match vault.get(&part(i))? {
            Some(part) => text.push_str(&part),
            None => break,
        }
    }
    let read = unb64(&text).and_then(|bytes| serde_json::from_slice(&bytes).ok());
    Ok(read.filter(|_| !text.is_empty()))
}

fn keep(vault: &dyn Vault, kept: &Kept) -> Result<(), String> {
    let json = serde_json::to_vec(kept).map_err(|e| e.to_string())?;
    let text = b64(&json);
    let parts: Vec<_> = text.as_bytes().chunks(PART).collect();
    for (i, bytes) in parts.iter().enumerate() {
        vault.set(&part(i), &String::from_utf8_lossy(bytes))?;
    }
    remove(vault, parts.len())
}

/// Removes the parts from `from` on: a shorter sign-in leaves none behind.
fn remove(vault: &dyn Vault, from: usize) -> Result<(), String> {
    let mut i = from;
    while vault.get(&part(i))?.is_some() {
        vault.remove(&part(i))?;
        i += 1;
    }
    Ok(())
}

/// Deletes the sign-in; with `end`, ends it at OpenAI first, as far as
/// OpenAI can be reached, as the revocation endpoint it publishes allows.
fn forget(vault: &dyn Vault, openai: &OpenAi, end: bool) -> Result<(), String> {
    if let Some(Kept {
        client,
        refresh: Some(refresh),
        ..
    }) = kept(vault).ok().flatten().filter(|_| end)
    {
        let url = format!("{}/.well-known/openid-configuration", openai.auth);
        let found = json_call(&Request {
            url: &url,
            key: None,
            body: Body::None,
            limit: CALL,
        });
        let own = format!("{}/", openai.auth);
        if let Ok((200, config)) = found
            && config["issuer"] == openai.auth
            && let Some(url) = config["revocation_endpoint"].as_str()
            && url.starts_with(&own)
        {
            let fields = [
                ("token", refresh.as_str()),
                ("token_type_hint", "refresh_token"),
                ("client_id", &client),
            ];
            let body = Body::Fields(&fields);
            let request = Request {
                url,
                key: None,
                body,
                limit: CALL,
            };
            let _ = http::send(&request, mpsc::channel());
        }
    }
    remove(vault, 0)
}

/// The model placing asks ChatGPT for, while signed in.
pub fn model(tx: &Tx) -> store::Result<Option<String>> {
    Ok(match tx.pref(PrefKey::Chatgpt)?.map(|p| p.value) {
        Some(PrefValue::Chatgpt(Some(Seen {
            state: SignIn::SignedIn,
            model,
            ..
        }))) => model,
        _ => None,
    })
}

/// Signing in is the agreement for ChatGPT's row alone (design §8): it is
/// put first and switched on, the other rows of an agreement to these terms
/// as they are; an agreement to other terms covers nothing and goes.
fn agree(tx: &mut Tx, model: &str) -> store::Result<()> {
    let mut agents = match tx.pref(PrefKey::RouteBy)?.map(|p| p.value) {
        Some(PrefValue::RouteBy(Some(by))) if by.terms == route::TERMS => by.agents,
        _ => Vec::new(),
    };
    agents.retain(|p| p.agent != ID);
    let row = Placer {
        agent: ID.into(),
        model: model.into(),
        on: true,
    };
    agents.insert(0, row);
    let terms = route::TERMS;
    tx.put_pref(&PrefValue::RouteBy(Some(RouteBy { agents, terms })))
}

/// Signing out takes ChatGPT's row out of the agreement.
fn unagree(tx: &mut Tx) -> store::Result<()> {
    if let Some(PrefValue::RouteBy(Some(mut by))) = tx.pref(PrefKey::RouteBy)?.map(|p| p.value) {
        by.agents.retain(|p| p.agent != ID);
        tx.put_pref(&PrefValue::RouteBy(Some(by)))?;
    }
    Ok(())
}

/// Puts the `chatgpt` preference; with a model, ChatGPT's row is agreed to.
fn seen(core: &mut Core, seen: Option<Seen>) {
    let agreed = seen.as_ref().and_then(|s| s.model.clone());
    let signed_out = seen.is_none();
    let wrote = effects::write(core, |tx| {
        let put = tx.put_pref(&PrefValue::Chatgpt(seen));
        let row = match (agreed, signed_out) {
            (Some(model), _) => agree(tx, &model),
            (None, true) => unagree(tx),
            (None, false) => Ok(()),
        };
        put.and(row).map_err(effects::stored)
    });
    if let Err(e) = wrote {
        effects::stop(e.message)
    }
}

fn state(state: SignIn) -> Seen {
    Seen {
        state,
        model: None,
        name: None,
        error: None,
    }
}

/// At start: a sign-in a core before this one waited for waits no more, and
/// the agreement stays as it is.
pub fn start(core: &mut Core) -> Result<(), String> {
    let stored = effects::read(core, |tx| tx.pref(PrefKey::Chatgpt));
    let stored = stored.map_err(|e| e.message)?.map(|p| p.value);
    if let Some(PrefValue::Chatgpt(Some(Seen {
        state: SignIn::Waiting,
        ..
    }))) = stored
    {
        let put = |tx: &mut Tx| tx.put_pref(&PrefValue::Chatgpt(None));
        effects::write(core, |tx| put(tx).map_err(effects::stored)).map_err(|e| e.message)?;
    }
    Ok(())
}

/// A placing found the sign-in ended: its renewal was refused, and it is
/// deleted. The preference says OpenAI signed Tasktap out; the agreement
/// keeps ChatGPT's row for when the person signs in again. Why the placing
/// passed the thought on, as its `route` says it.
pub fn ended(core: &mut Core) -> String {
    seen(core, Some(state(SignIn::SignedOut)));
    format!("{ID}: ChatGPT signed Tasktap out")
}

/// One sign-in's values: PKCE's verifier (S256), the state its callback
/// must bring back and the nonce its ID token must hold. 244 random bits
/// each, 43 characters.
struct Attempt {
    verifier: String,
    state: String,
    nonce: String,
}

impl Attempt {
    fn new() -> Attempt {
        let random = || b64(&Secret::mint().0);
        Attempt {
            verifier: random(),
            state: random(),
            nonce: random(),
        }
    }

    /// OpenAI's authorisation page for this attempt. It holds no token.
    fn address(&self, openai: &OpenAi, redirect: &str) -> String {
        let challenge = b64(&Sha256::digest(self.verifier.as_bytes()));
        // "urn:uuid:" and a version 4 UUID, which the first half of a
        // fresh secret is: a host id that stands for nothing of the person's.
        let hex: String = Secret::mint().0[..16]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let (a, b, c, d, e) = (
            &hex[..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..],
        );
        let host = format!("urn:uuid:{a}-{b}-{c}-{d}-{e}");
        let params = [
            ("client_id", FIRST_CLIENT),
            ("agent_name_hint", NAME),
            ("ext_agent_host_id", &host),
            ("response_type", "code"),
            ("redirect_uri", redirect),
            ("scope", SCOPES),
            ("resource", RESOURCE),
            ("state", &self.state),
            ("nonce", &self.nonce),
            ("code_challenge_method", "S256"),
            ("code_challenge", &challenge),
        ];
        let query: Vec<_> = (params.iter())
            .map(|(name, value)| format!("{name}={}", http::escaped(value)))
            .collect();
        format!("{}/api/accounts/authorize?{}", openai.auth, query.join("&"))
    }
}

/// How a sign-in ended, unless it was cancelled.
enum Ended {
    SignedIn { model: String, name: String },
    NoPlan,
    Failed(String),
}

/// `chatgpt.sign_in`: starts a sign-in and answers with the address of
/// OpenAI's page, which the host opens in the system's browser. How it
/// ends is the `chatgpt` preference: `waiting` at once, then signed in, or
/// why not.
pub fn sign_in(cx: &mut Cx, _: Empty) -> Result<String, Error> {
    let core = &mut *cx.core;
    let conflict = |why: &str| Err(Error::new(Code::Conflict, why));
    if core.chatgpt.waiting.is_some() {
        return conflict("a sign-in with ChatGPT is waiting for the browser already");
    }
    if effects::read(core, model)?.is_some() {
        return conflict("ChatGPT is signed in already");
    }
    let failed = |e: std::io::Error| {
        let why = format!("Tasktap could not listen for the browser: {e}");
        Error::new(Code::Failed, why)
    };
    let listener = TcpListener::bind("127.0.0.1:0").map_err(failed)?;
    let port = listener.local_addr().map_err(failed)?.port();
    let redirect = format!("http://127.0.0.1:{port}{CALLBACK}");
    let (openai, attempt) = (openai(), Attempt::new());
    let address = attempt.address(&openai, &redirect);
    seen(core, Some(state(SignIn::Waiting)));
    let (stop, stopped) = mpsc::channel();
    core.chatgpt.attempts += 1;
    let number = core.chatgpt.attempts;
    core.chatgpt.waiting = Some((number, stop));
    let vault = core.chatgpt.vault.clone();
    let work = move || {
        let back = match listen(listener, &attempt.state, &stopped) {
            Ok(back) => back,
            Err(None) => return None,
            Err(Some(why)) => return Some(Ended::Failed(why)),
        };
        let done = signed_in(&*vault, &openai, &attempt, &redirect, &back);
        Some(done.unwrap_or_else(Ended::Failed))
    };
    let vault = core.chatgpt.vault.clone();
    crate::calls::aside(core, work, move |core, ended| {
        let ended = ended.flatten();
        if core.chatgpt.waiting.as_ref().map(|w| w.0) != Some(number) {
            // Cancelled: one that got through all the same is not kept.
            if let Some(Ended::SignedIn { .. }) = ended {
                crate::calls::aside(core, move || remove(&*vault, 0), |_, _| {});
            }
            return;
        }
        core.chatgpt.waiting = None;
        core.events.notify_one();
        let ended = ended.unwrap_or(Ended::Failed("the sign-in ended without an answer".into()));
        seen(
            core,
            Some(match ended {
                Ended::SignedIn { model, name } => Seen {
                    model: Some(model),
                    name: Some(name),
                    ..state(SignIn::SignedIn)
                },
                Ended::NoPlan => state(SignIn::NoPlan),
                Ended::Failed(why) => Seen {
                    error: Some(why),
                    ..state(SignIn::Failed)
                },
            }),
        );
    });
    Ok(address)
}

/// `chatgpt.sign_out`: ends the wait for a sign-in, or the sign-in: at
/// OpenAI, as far as it can be reached, and in the credential store.
/// ChatGPT's row leaves the agreement.
pub fn sign_out(cx: &mut Cx, _: Empty) -> Option<Control> {
    let (link, id) = (cx.link.clone(), cx.id);
    let core = &mut *cx.core;
    if let Some((_, stop)) = core.chatgpt.waiting.take() {
        let _ = stop.send(());
        core.events.notify_one();
        seen(core, None);
        return Some(call::ChatgptSignOut::reply(id, Ok(())));
    }
    let Asking { vault, renewing } = core.chatgpt.asking();
    let work = move || {
        let _one = renewing.lock().unwrap_or_else(PoisonError::into_inner);
        forget(&*vault, &openai(), true)
    };
    crate::calls::aside(core, work, move |core, done| {
        let lost = || Err("the credential store ended without an answer".to_owned());
        let result = done.unwrap_or_else(lost);
        if result.is_ok() {
            seen(core, None);
        }
        let result = result.map_err(|why| Error::new(Code::Failed, why));
        link.send(&call::ChatgptSignOut::reply(id, result));
    });
    None
}

/// Waits for the browser to come back with this attempt's `state`, until
/// [`WAIT`] or a word on `stop`: what it brought. One that does not bring
/// it is answered and ends nothing. `Err(None)`: stopped.
fn listen(
    listener: TcpListener,
    state: &str,
    stop: &mpsc::Receiver<()>,
) -> Result<HashMap<String, String>, Option<String>> {
    let failed = |e: std::io::Error| Some(format!("the browser could not be listened for: {e}"));
    listener.set_nonblocking(true).map_err(failed)?;
    let until = Instant::now() + WAIT;
    loop {
        match listener.accept() {
            Ok((conn, _)) => {
                if let Some(back) = answer(conn, state) {
                    return Ok(back);
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                if stop.try_recv() != Err(TryRecvError::Empty) {
                    return Err(None);
                }
                if Instant::now() > until {
                    let why = "no answer came from the browser within 5 minutes";
                    return Err(Some(why.into()));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(failed(e)),
        }
    }
}

/// Reads one request and answers it with a page: what the callback brought
/// when it is this attempt's.
fn answer(mut conn: TcpStream, state: &str) -> Option<HashMap<String, String>> {
    conn.set_nonblocking(false).ok()?;
    conn.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let (mut reader, mut line, mut head) = (
        BufReader::new((&conn).take(16 << 10)),
        String::new(),
        String::new(),
    );
    reader.read_line(&mut line).ok()?;
    // The rest of its head is read, so the browser is not cut off.
    while reader.read_line(&mut head).is_ok_and(|n| n > 2) {
        head.clear();
    }
    let target = line.strip_prefix("GET ").and_then(|l| l.split(' ').next());
    let (path, query) = target
        .unwrap_or_default()
        .split_once('?')
        .unwrap_or((target.unwrap_or_default(), ""));
    let back: HashMap<_, _> = (query.split('&'))
        .filter_map(|pair| pair.split_once('='))
        .map(|(name, value)| (unescape(name), unescape(value)))
        .collect();
    let (status, said) = match () {
        _ if path != CALLBACK => ("404 Not Found", "Nothing here."),
        _ if back.get("state").map(String::as_str) != Some(state) => (
            "400 Bad Request",
            "This answer does not belong to the sign-in with ChatGPT that Tasktap waits for. Nothing was done.",
        ),
        _ if back.contains_key("error") => (
            "200 OK",
            "The sign-in with ChatGPT did not finish. You can close this tab.",
        ),
        _ => (
            "200 OK",
            "You can close this tab: Tasktap finishes the sign-in with ChatGPT and says how it went.",
        ),
    };
    let page = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Tasktap</title><p style=\"font:16px system-ui\">{said}</p>"
    );
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        page.len()
    );
    let _ = conn.write_all(format!("{head}{page}").as_bytes());
    status.starts_with("200").then_some(back)
}

/// A part of an address as it was before it was escaped.
fn unescape(text: &str) -> String {
    let mut bytes = Vec::with_capacity(text.len());
    let mut rest = text.as_bytes();
    while let [first, more @ ..] = rest {
        rest = more;
        let hex = more.get(..2).and_then(|h| std::str::from_utf8(h).ok());
        match (first, hex.and_then(|h| u8::from_str_radix(h, 16).ok())) {
            (b'+', _) => bytes.push(b' '),
            (b'%', Some(b)) => {
                bytes.push(b);
                rest = &more[2..];
            }
            (&b, _) => bytes.push(b),
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// The rest of a sign-in once the browser came back: the code exchanged,
/// the ID token checked, the models asked, the sign-in kept.
fn signed_in(
    vault: &dyn Vault,
    openai: &OpenAi,
    attempt: &Attempt,
    redirect: &str,
    back: &HashMap<String, String>,
) -> Result<Ended, String> {
    if let Some(error) = back.get("error") {
        return Err(
            match back.get("error_description").filter(|d| !d.is_empty()) {
                Some(words) => format!("{error}: {words}"),
                None => error.clone(),
            },
        );
    }
    let code = back
        .get("code")
        .ok_or("the browser came back without a code")?;
    let client = back
        .get("client_id")
        .filter(|c| !c.is_empty() && *c != FIRST_CLIENT);
    let client = client.ok_or("the browser came back without the client id OpenAI issued")?;
    let fields = [
        ("grant_type", "authorization_code"),
        ("client_id", client),
        ("code", code),
        ("code_verifier", &attempt.verifier),
        ("redirect_uri", redirect),
        ("resource", RESOURCE),
    ];
    let tokens = token(openai, &fields, CALL).map_err(|(Refused(why) | Unanswered(why))| why)?;
    let id_token = tokens["id_token"]
        .as_str()
        .ok_or("OpenAI answered without an ID token")?;
    checked(openai, id_token, client, &attempt.nonce)?;
    let scopes = tokens["scope"].as_str().unwrap_or_default();
    if !scopes.split(' ').any(|s| s == PLAN) {
        return Ok(Ended::NoPlan);
    }
    let access = tokens["access_token"].as_str().unwrap_or_default();
    let (model, name) = chosen(openai, access)?;
    let kept = Kept {
        client: client.clone(),
        access: access.into(),
        refresh: tokens["refresh_token"].as_str().map(Into::into),
        until: until(&tokens),
    };
    keep(vault, &kept)?;
    Ok(Ended::SignedIn { model, name })
}

/// The ID token, as it came straight from OpenAI's token endpoint over a
/// connection whose certificate the system trusts, which OpenID Connect lets
/// stand for its signature (Core 1.0, 3.1.3.7): from OpenAI's sign-in, for
/// the client OpenAI issued, not expired, of this attempt, naming someone.
fn checked(openai: &OpenAi, token: &str, client: &str, nonce: &str) -> Result<(), String> {
    let claims = token.split('.').nth(1).and_then(unb64);
    let claims: Value = claims
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or("the ID token cannot be read")?;
    let now = effects::wall().get() / 1000;
    let audience = match &claims["aud"] {
        Value::Array(all) => all.iter().any(|a| a == client),
        one => one == client,
    };
    let expired = claims["exp"].as_u64().is_none_or(|exp| exp + 60 < now);
    let named = claims["sub"].as_str().is_some_and(|s| !s.is_empty());
    let why = match () {
        _ if claims["iss"] != openai.auth => "the ID token comes from another issuer",
        _ if !audience => "the ID token is for another client",
        _ if expired => "the ID token has expired",
        _ if claims["nonce"] != nonce => "the ID token belongs to another sign-in attempt",
        _ if !named => "the ID token names nobody",
        _ => return Ok(()),
    };
    Err(why.into())
}

/// The model placing asks for, and the name the account's list shows for
/// it: [`MODEL`] where the list shows it, else the first it shows. One
/// request, made once at sign-in.
fn chosen(openai: &OpenAi, access: &str) -> Result<(String, String), String> {
    let url = format!("{}/models", openai.api);
    let request = Request {
        url: &url,
        key: Some(access),
        body: Body::None,
        limit: CALL,
    };
    let (status, list) = json_call(&request)?;
    if status != 200 {
        let why = said(&list, status);
        return Err(format!("the list of ChatGPT's models did not load ({why})"));
    }
    let all = list["models"].as_array().or(list["data"].as_array());
    let slug = |m: &Value| m["slug"].as_str().or(m["id"].as_str()).map(|s| cut(s, 100));
    let shown: Vec<_> = (all.into_iter().flatten())
        .filter(|m| slug(m).is_some() && m["visibility"].as_str().is_none_or(|v| v == "list"))
        .collect();
    let model = (shown.iter().find(|m| slug(m).as_deref() == Some(MODEL)))
        .or(shown.first())
        .ok_or("ChatGPT offers your account no model")?;
    let slug = slug(model).unwrap_or_default();
    let name = model["display_name"]
        .as_str()
        .filter(|n| !n.trim().is_empty());
    let name = name.map_or(slug.clone(), |n| cut(n, 100));
    Ok((slug, name))
}

/// What a placing asks ChatGPT with: the sign-in, and the lock that keeps
/// one renewal at a time.
pub struct Asking {
    vault: Arc<dyn Vault>,
    renewing: Arc<Mutex<()>>,
}

impl Asking {
    /// Asks ChatGPT one placing question on the person's plan: the
    /// instructions in a field of their own, `request` (route.rs `asked`)
    /// as the one message, and the answer held to route.rs `SCHEMA`; within
    /// `limit`, a renewal it needs first counted in it. The answer's JSON
    /// text. A `Stop` on `wait` ends the call.
    pub fn ask(
        &self,
        model: &str,
        request: &str,
        limit: Duration,
        wait: Wait,
    ) -> Result<String, Failed> {
        let began = Instant::now();
        let openai = openai();
        let kept = self.fresh(&openai, false, limit)?;
        let schema: Value = serde_json::from_str(route::SCHEMA).unwrap_or_default();
        let body = json!({
            "model": model,
            "instructions": route::INSTRUCTIONS,
            "input": [{ "role": "user", "content": request }],
            "reasoning": { "effort": EFFORT },
            "text": { "format": { "type": "json_schema", "name": "placing", "schema": schema, "strict": true } },
            "store": false,
            "stream": true,
        });
        let body = http::plain_json(&body.to_string());
        let url = format!("{}/responses", openai.api);
        let request = Request {
            url: &url,
            key: Some(&kept.access),
            body: Body::Json(&body),
            limit: limit.saturating_sub(began.elapsed()),
        };
        let answer = http::send(&request, wait).map_err(|e| match e {
            http::Failed::Slow => format!(
                "it did not answer within {} s",
                limit.as_millis().div_ceil(1000)
            ),
            e => failed(e),
        })?;
        let text = String::from_utf8_lossy(&answer.body);
        let words = || {
            said(
                &serde_json::from_str(&text).unwrap_or_default(),
                answer.status,
            )
        };
        let why = match answer.status {
            200 => return stream(&text),
            // Renewed, or found ended, for the next thought, in what is left of
            // the time and at least 2 s.
            401 => {
                let left = limit.saturating_sub(began.elapsed());
                self.fresh(&openai, true, left.max(Duration::from_secs(2)))?;
                "ChatGPT did not take the sign-in, which is renewed for the next task".into()
            }
            429 => format!(
                "your ChatGPT plan has reached its limit for now ({})",
                words()
            ),
            403 => format!("ChatGPT does not let Tasktap use your plan ({})", words()),
            _ => format!("ChatGPT did not take the question ({})", words()),
        };
        Err(Failed::Why(why))
    }

    /// The sign-in, renewed first when its access token has under ten
    /// minutes left, or with `force`; the refresh token that replaces the
    /// old one is kept at once. A refused renewal deletes the sign-in.
    fn fresh(&self, openai: &OpenAi, force: bool, limit: Duration) -> Result<Kept, Failed> {
        let _one = self.renewing.lock().unwrap_or_else(PoisonError::into_inner);
        let mut kept = kept(&*self.vault)?.ok_or(Failed::SignedOut)?;
        if !force && kept.until > effects::wall().get() + RENEW {
            return Ok(kept);
        }
        let ended = |vault: &dyn Vault| {
            forget(vault, openai, false).map_or_else(Failed::Why, |()| Failed::SignedOut)
        };
        let Some(refresh) = kept.refresh.clone() else {
            return Err(ended(&*self.vault));
        };
        let fields = [
            ("grant_type", "refresh_token"),
            ("client_id", &kept.client),
            ("refresh_token", &refresh),
            ("resource", RESOURCE),
        ];
        match token(openai, &fields, limit) {
            Ok(tokens) => {
                kept.access = tokens["access_token"].as_str().unwrap_or_default().into();
                kept.refresh = tokens["refresh_token"]
                    .as_str()
                    .map(Into::into)
                    .or(kept.refresh);
                kept.until = until(&tokens);
                keep(&*self.vault, &kept)?;
                Ok(kept)
            }
            Err(Refused(_)) => Err(ended(&*self.vault)),
            Err(Unanswered(why)) => {
                Err(format!("the sign-in with ChatGPT could not be renewed ({why})").into())
            }
        }
    }
}

/// Why a token request gave no tokens: OpenAI refused it (the sign-in or
/// the code is no good), or did not answer it.
enum Token {
    Refused(String),
    Unanswered(String),
}
use Token::{Refused, Unanswered};

/// A request to OpenAI's token endpoint: its tokens, or why there are none,
/// in OpenAI's words.
fn token(openai: &OpenAi, fields: &[(&str, &str)], limit: Duration) -> Result<Value, Token> {
    let url = format!("{}/api/accounts/oauth/token", openai.auth);
    let request = Request {
        url: &url,
        key: None,
        body: Body::Fields(fields),
        limit,
    };
    let (status, body) = json_call(&request).map_err(Unanswered)?;
    match status {
        // A token goes into curl's configuration: it must be one line.
        200 if body["access_token"].as_str().is_some_and(secrets::plain) => Ok(body),
        200 => Err(Unanswered("OpenAI answered without an access token".into())),
        400 | 401 => Err(Refused(said(&body, status))),
        _ => Err(Unanswered(said(&body, status))),
    }
}

/// When the access token in `tokens` ends: an hour unless they say.
fn until(tokens: &Value) -> u64 {
    effects::wall().get() + tokens["expires_in"].as_u64().unwrap_or(3600) * 1000
}

/// A call to OpenAI: its status and its body as JSON (null where it is
/// none), or why there is no answer.
fn json_call(request: &Request) -> Result<(u16, Value), String> {
    let answer = http::send(request, mpsc::channel()).map_err(failed)?;
    Ok((
        answer.status,
        serde_json::from_slice(&answer.body).unwrap_or_default(),
    ))
}

/// Why a call to OpenAI has no answer, in a few words.
fn failed(e: http::Failed) -> String {
    match e {
        http::Failed::Missing => {
            "this system has no curl, which Tasktap makes web calls with".into()
        }
        http::Failed::Stopped => "it was not waited for".into(),
        http::Failed::Slow => "OpenAI did not answer in time".into(),
        http::Failed::Unreachable(_) => "OpenAI could not be reached".into(),
        http::Failed::Untrusted(why) => format!("the connection to OpenAI is not trusted ({why})"),
        http::Failed::Other(why) => why,
    }
}

/// What OpenAI said of a refusal, in its words: its code and its message,
/// in one line of at most 200 characters.
fn said(body: &Value, status: u16) -> String {
    let error = &body["error"];
    let code = error
        .as_str()
        .or(error["code"].as_str())
        .filter(|c| !c.is_empty());
    let words = (body["error_description"].as_str())
        .or(error["message"].as_str())
        .or(body["detail"].as_str())
        .filter(|w| !w.trim().is_empty());
    let text = match (code, words) {
        (Some(code), Some(words)) => format!("{code}: {words}"),
        (Some(text), None) | (None, Some(text)) => text.into(),
        (None, None) => format!("HTTP {status}"),
    };
    cut(&text.split_whitespace().collect::<Vec<_>>().join(" "), 200)
}

fn cut(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
}

/// The answer in a Responses stream of server-sent events: the text of
/// `response.completed`, or its deltas where it holds none. Why there is
/// none: `response.failed` (a limit reached in the middle of an answer
/// among them), `response.incomplete`, an `error`, or a stream that ended
/// first. An event the stream ended in the middle of is not read.
fn stream(text: &str) -> Result<String, Failed> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut events: Vec<_> = text.split("\n\n").collect();
    events.pop();
    let mut deltas = String::new();
    for event in events {
        let data: Vec<_> = (event.lines())
            .filter_map(|line| line.strip_prefix("data:"))
            .map(|data| data.strip_prefix(' ').unwrap_or(data))
            .collect();
        let Ok(event) = serde_json::from_str::<Value>(&data.join("\n")) else {
            continue;
        };
        let response = &event["response"];
        let stopped = |e: &Value| {
            let code = e["code"].as_str().or(e["error"]["code"].as_str());
            let words = e["message"].as_str().or(e["error"]["message"].as_str());
            let said = [code, words]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(": ");
            Err(format!("ChatGPT stopped its answer ({})", cut(&said, 200)).into())
        };
        match event["type"].as_str().unwrap_or_default() {
            "response.output_text.delta" => {
                deltas.push_str(event["delta"].as_str().unwrap_or_default())
            }
            "response.completed" => return Ok(output(response).unwrap_or(deltas)),
            "response.failed" => return stopped(&response["error"]),
            "response.incomplete" => {
                let why = response["incomplete_details"]["reason"].as_str();
                return Err(format!(
                    "its answer is incomplete ({})",
                    why.unwrap_or("no reason given")
                )
                .into());
            }
            "error" => return stopped(&event),
            _ => {}
        }
    }
    Err("its answer ended before it was whole".to_owned().into())
}

/// The text of a finished response's messages.
fn output(response: &Value) -> Option<String> {
    let messages = response["output"]
        .as_array()?
        .iter()
        .filter(|o| o["type"] == "message");
    let texts: Vec<_> = (messages.flat_map(|m| m["content"].as_array().into_iter().flatten()))
        .filter(|c| c["type"] == "output_text")
        .filter_map(|c| c["text"].as_str())
        .collect();
    (!texts.is_empty()).then(|| texts.concat())
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Base64 for addresses (RFC 4648 §5), without padding.
fn b64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n =
            (chunk.iter().enumerate()).fold(0u32, |n, (i, &b)| n | u32::from(b) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(char::from(B64[(n >> (18 - 6 * i) & 63) as usize]));
        }
    }
    out
}

fn unb64(text: &str) -> Option<Vec<u8>> {
    let (mut out, mut n, mut bits) = (Vec::new(), 0u32, 0);
    for c in text.trim_end_matches('=').bytes() {
        n = n << 6 | B64.iter().position(|&b| b == c)? as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((n >> bits) as u8);
            n &= (1 << bits) - 1;
        }
    }
    Some(out)
}
