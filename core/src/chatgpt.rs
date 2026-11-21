//! Placing on the person's own ChatGPT plan (design §8, "ChatGPT"): the
//! sign-in with ChatGPT as a desktop app makes it, and the one direct call a
//! placing makes on it, with no agent started. Written from OpenAI's pages
//! as the trial in `trials/siwc` proved them (its README names them).
//!
//! The sign-in: the core listens on 127.0.0.1 at a port the system picks,
//! `chatgpt.sign_in` answers with the address of OpenAI's authorisation
//! page, which the host opens in the system's browser, and the browser comes
//! back to the listener with a one-time code, exchanged with PKCE. The first
//! time, Tasktap registers itself with OpenAI as "Tasktap"; the client id
//! OpenAI issues and the host id Tasktap made are no secrets and are kept in
//! `<data>/chatgpt.json` across sign-outs, so a sign-in after registers
//! nothing anew unless OpenAI refuses the kept client id. The ID token that
//! comes with the tokens is checked: from OpenAI's sign-in, for the client
//! OpenAI issued, not expired, of this attempt. At most five minutes of
//! waiting and one sign-in at a time; the listener closes after. The
//! account's models are asked once: placing asks [`MODEL`], and an account
//! whose list does not offer it is not signed in.
//!
//! The sign-in is kept in the system's credential store (`secrets.rs`), as a
//! speech service's key is: never in the database, a record, a reply or a
//! log. The `chatgpt` preference is all a page sees of it: waiting, signed
//! in with a model, or why not. Signing in is the agreement for ChatGPT's
//! row of placing and puts it first ([`agree`]); signing out takes it out.
//!
//! There is no timer: a placing that finds the access token (an hour) with
//! under ten minutes left renews it first, one renewal at a time, and keeps
//! the refresh token that replaces the old one (30 days). A renewal has a
//! time of its own and runs to its end whatever the placing's time, since
//! OpenAI replaces the refresh token at every use and one given up on would
//! be lost; the placing passes the thought on when its own time is up. A
//! renewal OpenAI refuses deletes the sign-in, and the preference says
//! OpenAI signed Tasktap out. `chatgpt.sign_out` ends the sign-in at OpenAI
//! too.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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
/// The model placing asks for (the owner's decision of 2026-11-21: the
/// newest, 14 of 14 right), and no other.
pub const MODEL: &str = "gpt-6.2-sol";
/// The reasoning effort it is asked with, as Codex is.
const EFFORT: &str = "low";
/// Longest a placing may take, as long as the slowest agent's; what is
/// left of [`route::BUDGET`] bounds it.
pub const LIMIT: Duration = Duration::from_secs(15);
/// Least time worth a call to OpenAI: with less left, a placing passes on.
const LEAST: Duration = Duration::from_millis(500);
/// Why a placing passed the thought on, as an agent's says it.
const LATE: &str = "no time was left to ask it";
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
/// Seconds the browser is waited for, and longest one connection to the
/// listener takes.
const WAIT: u32 = 5 * 60;
const ONE: Duration = Duration::from_secs(2);
/// Longest one call of the sign-in takes, a renewal's among them.
const CALL: Duration = Duration::from_secs(15);
/// Milliseconds an access token has left when a placing renews it first.
const RENEW: u64 = 10 * 60 * 1000;
/// Characters of the kept sign-in in one entry of the credential store: a
/// name holds at most 512 (`secrets::plain`), and Windows 2560 bytes.
const PART: usize = 500;
/// Entries of a kept sign-in: the first says how many follow and what they
/// are, and is written last; at most 15 follow.
const PARTS: usize = 16;
/// The file in the data folder that keeps what Tasktap registered as.
const REGISTRATION: &str = "chatgpt.json";

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
    /// The sign-in as last read from or kept in the credential store. Its
    /// lock keeps one renewal at a time: a refresh token is good once.
    held: Arc<Mutex<Held>>,
    /// OpenAI did not take the sign-in for a question: the next placing
    /// renews it first.
    stale: Arc<AtomicBool>,
    waiting: Option<Waiting>,
    attempts: u64,
    /// How long a second of the wait for the browser lasts: shorter only in
    /// a test.
    second: Duration,
}

/// A sign-in that waits for the browser: its number, what ends the wait,
/// the preference as it was before, which a cancel puts back, and, for one
/// asked under a kept client id, the registration with that id forgotten,
/// which a cancel before the browser came back keeps.
struct Waiting {
    number: u64,
    stop: mpsc::Sender<()>,
    before: Option<Seen>,
    unknown: Option<(PathBuf, Registration)>,
    called: Arc<AtomicBool>,
}

impl ChatGpt {
    pub fn new(second: Duration) -> ChatGpt {
        ChatGpt {
            vault: secrets::vault(),
            held: Default::default(),
            stale: Default::default(),
            waiting: None,
            attempts: 0,
            second,
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
            stale: self.stale.clone(),
        }
    }
}

/// The sign-in as the credential store keeps it.
#[derive(Clone, Serialize, Deserialize)]
struct Kept {
    /// The client id OpenAI issued Tasktap when it registered.
    client: String,
    access: String,
    refresh: Option<String>,
    /// When the access token ends, in milliseconds since 1970.
    until: u64,
}

/// The kept sign-in once it was read: none, or one.
#[derive(Default)]
struct Held {
    read: bool,
    kept: Option<Kept>,
}

impl Held {
    fn get(&mut self, vault: &dyn Vault) -> Result<Option<Kept>, String> {
        if !self.read {
            self.kept = kept(vault)?;
            self.read = true;
        }
        Ok(self.kept.clone())
    }

    fn set(&mut self, kept: Option<Kept>) {
        (self.read, self.kept) = (true, kept);
    }
}

fn part(i: usize) -> String {
    format!("{ID}.{i}")
}

/// The first 8 bytes of a text's SHA-256, in hex: what tells a whole record.
fn digest(text: &str) -> String {
    let all = Sha256::digest(text.as_bytes());
    all[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// The kept sign-in. One that does not read whole (a part missing, parts of
/// two sign-ins, a first part never written) is none, and its parts go.
fn kept(vault: &dyn Vault) -> Result<Option<Kept>, String> {
    let whole = |head: &str| -> Result<Option<Kept>, String> {
        let Some((n, sum)) = head.split_once('-') else {
            return Ok(None);
        };
        let n = n.parse().ok().filter(|n| (1..PARTS).contains(n));
        let Some(n) = n else { return Ok(None) };
        let mut text = String::new();
        for i in 1..=n {
            match vault.get(&part(i))? {
                Some(part) => text.push_str(&part),
                None => return Ok(None),
            }
        }
        if digest(&text) != sum {
            return Ok(None);
        }
        Ok(unb64(&text).and_then(|bytes| serde_json::from_slice(&bytes).ok()))
    };
    let read = match vault.get(&part(0))? {
        Some(head) => whole(&head)?,
        None if vault.get(&part(1))?.is_none() => return Ok(None),
        None => None,
    };
    if read.is_none() {
        remove(vault)?;
    }
    Ok(read)
}

/// Keeps a sign-in: the parts first, any a longer one left behind removed,
/// the first part last, so that one stopped half-way never reads whole.
fn keep(vault: &dyn Vault, kept: &Kept) -> Result<(), String> {
    let json = serde_json::to_vec(kept).map_err(|e| e.to_string())?;
    let text = b64(&json);
    let parts: Vec<_> = text.as_bytes().chunks(PART).collect();
    if parts.len() >= PARTS {
        return Err("the sign-in is too large to keep".into());
    }
    for (i, bytes) in parts.iter().enumerate() {
        vault.set(&part(i + 1), &String::from_utf8_lossy(bytes))?;
    }
    for i in parts.len() + 1..PARTS {
        vault.remove(&part(i))?;
    }
    vault.set(&part(0), &format!("{}-{}", parts.len(), digest(&text)))
}

/// Removes every part a sign-in can have, whatever is missing among them.
fn remove(vault: &dyn Vault) -> Result<(), String> {
    (0..PARTS).try_for_each(|i| vault.remove(&part(i)))
}

/// Ends a refresh token at OpenAI, at the revocation endpoint OpenAI's
/// configuration names, as far as OpenAI can be reached.
fn revoke(openai: &OpenAi, client: &str, refresh: &str) {
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
            ("token", refresh),
            ("token_type_hint", "refresh_token"),
            ("client_id", client),
        ];
        let request = Request {
            url,
            key: None,
            body: Body::Fields(&fields),
            limit: CALL,
        };
        let _ = http::send(&request, mpsc::channel());
    }
}

/// Deletes the sign-in, ended at OpenAI first.
fn forget(vault: &dyn Vault, held: &mut Held, openai: &OpenAi) -> Result<(), String> {
    if let Ok(Some(Kept {
        client,
        refresh: Some(refresh),
        ..
    })) = held.get(vault)
    {
        revoke(openai, &client, &refresh);
    }
    held.set(None);
    remove(vault)
}

/// What Tasktap registered as at OpenAI, kept across sign-outs: the host id
/// it made once, and the client id OpenAI issued it. Neither is a secret.
#[derive(Clone, Serialize, Deserialize)]
struct Registration {
    host: String,
    client: Option<String>,
}

/// The registration kept in `data`, or a new host id.
fn registration(data: &Path) -> Registration {
    let file = std::fs::read(data.join(REGISTRATION)).ok();
    let kept = file.and_then(|bytes| serde_json::from_slice::<Registration>(&bytes).ok());
    let host = |r: &Registration| r.host.starts_with("urn:uuid:");
    kept.filter(host).unwrap_or_else(|| Registration {
        host: host_id(),
        client: None,
    })
}

/// Keeps the registration, whole or not at all; one not kept only means
/// Tasktap registers again next time.
fn register(data: &Path, registration: &Registration) {
    if let Ok(json) = serde_json::to_vec(registration) {
        let _ = crate::agents::checks::whole(&data.join(REGISTRATION), &json);
    }
}

/// "urn:uuid:" and a version 4 UUID, which the first half of a fresh secret
/// is: a host id that stands for nothing of the person's.
fn host_id() -> String {
    let hex: String = (Secret::mint().0[..16].iter())
        .map(|b| format!("{b:02x}"))
        .collect();
    let (a, b, c) = (&hex[..8], &hex[8..12], &hex[12..16]);
    format!("urn:uuid:{a}-{b}-{c}-{}-{}", &hex[16..20], &hex[20..])
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

/// Signing out takes ChatGPT's row out of the agreement. Where it was the
/// only row, there is no agreement left: placing is as it was before the
/// sign-in, not answered.
fn unagree(tx: &mut Tx) -> store::Result<()> {
    if let Some(PrefValue::RouteBy(Some(mut by))) = tx.pref(PrefKey::RouteBy)?.map(|p| p.value) {
        by.agents.retain(|p| p.agent != ID);
        match by.agents.is_empty() {
            true => drop(tx.delete_pref(PrefKey::RouteBy)?),
            false => tx.put_pref(&PrefValue::RouteBy(Some(by)))?,
        }
    }
    Ok(())
}

/// Writes the preference, and the agreement with it as `row` says.
fn write(core: &mut Core, seen: Option<Seen>, row: impl FnOnce(&mut Tx) -> store::Result<()>) {
    let wrote = effects::write(core, |tx| {
        let put = tx.put_pref(&PrefValue::Chatgpt(seen));
        put.and_then(|()| row(tx)).map_err(effects::stored)
    });
    if let Err(e) = wrote {
        effects::stop(e.message)
    }
}

/// Writes the preference alone.
fn put(core: &mut Core, seen: Option<Seen>) {
    write(core, seen, |_| Ok(()))
}

fn state(state: SignIn) -> Seen {
    Seen {
        state,
        model: None,
        name: None,
        error: None,
    }
}

fn failed_with(why: String) -> Seen {
    Seen {
        error: Some(why),
        ..state(SignIn::Failed)
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
        put(core, None);
    }
    Ok(())
}

/// What a placing finds of the sign-in, renewed first where it has to be.
enum Renewal {
    /// The access token to ask with.
    Fresh(String),
    /// Renewed, but the credential store did not keep it, for this reason:
    /// this placing asks with it, and it is not signed in after.
    NotKept(String, String),
    /// No sign-in is kept: signed out meanwhile, or one that did not read
    /// whole, or ended with no way to renew it.
    None,
    /// OpenAI refused to renew the sign-in that was kept: it is deleted.
    Refused,
    /// Why there is no access token now, as the thought says it.
    Failed(String),
}

/// The sign-in, renewed when its access token has under ten minutes left,
/// or with `force`, in a call of its own time ([`CALL`]); the refresh token
/// that replaces the old one is kept at once.
fn renewal(vault: &dyn Vault, held: &Mutex<Held>, openai: &OpenAi, force: bool) -> Renewal {
    let mut held = held.lock().unwrap_or_else(PoisonError::into_inner);
    let kept = match held.get(vault) {
        Ok(Some(kept)) => kept,
        Ok(None) => return Renewal::None,
        Err(why) => return Renewal::Failed(format!("the sign-in could not be read ({why})")),
    };
    let now = effects::wall().get();
    if !force && kept.until > now + RENEW {
        return Renewal::Fresh(kept.access);
    }
    let Some(refresh) = kept.refresh.clone() else {
        return match kept.until > now {
            true => Renewal::Fresh(kept.access),
            false => {
                forget(vault, &mut held, openai).map_or_else(Renewal::Failed, |()| Renewal::None)
            }
        };
    };
    let fields = [
        ("grant_type", "refresh_token"),
        ("client_id", &kept.client),
        ("refresh_token", &refresh),
        ("resource", RESOURCE),
    ];
    match token(openai, &fields, CALL) {
        Ok(tokens) => {
            let renewed = Kept {
                access: tokens["access_token"].as_str().unwrap_or_default().into(),
                refresh: tokens["refresh_token"]
                    .as_str()
                    .map(Into::into)
                    .or(kept.refresh),
                until: until(&tokens),
                client: kept.client,
            };
            match keep(vault, &renewed) {
                Ok(()) => {
                    held.set(Some(renewed.clone()));
                    Renewal::Fresh(renewed.access)
                }
                // The old refresh token is used up: what is kept of it goes.
                Err(why) => {
                    held.set(None);
                    let _ = remove(vault);
                    Renewal::NotKept(renewed.access, why)
                }
            }
        }
        Err(Refused(_)) => {
            held.set(None);
            let _ = remove(vault);
            Renewal::Refused
        }
        Err(Unanswered(why)) => Renewal::Failed(format!(
            "the sign-in with ChatGPT could not be renewed ({why})"
        )),
    }
}

/// Starts what a placing needs first, off the core's thread: the sign-in,
/// renewed where it has to be. It runs to its end whatever the placing's
/// time, and tells the placing on `gave`, if it still waits, the access
/// token or why there is none. What the person should see of it goes into
/// the preference, never over what a sign-out left there.
pub fn renew(core: &mut Core, gave: mpsc::Sender<Result<String, String>>) {
    let (vault, held) = (core.chatgpt.vault.clone(), core.chatgpt.held.clone());
    let stale = core.chatgpt.stale.clone();
    let work = move || {
        let force = stale.swap(false, Ordering::Relaxed);
        let renewal = renewal(&*vault, &held, &openai(), force);
        let _ = gave.send(match &renewal {
            Renewal::Fresh(access) | Renewal::NotKept(access, _) => Ok(access.clone()),
            Renewal::None => Err("ChatGPT is not signed in".into()),
            Renewal::Refused => Err("ChatGPT signed Tasktap out".into()),
            Renewal::Failed(why) => Err(why.clone()),
        });
        renewal
    };
    crate::calls::aside(core, work, |core, renewal| {
        if effects::read(core, model).ok().flatten().is_none() {
            return;
        }
        match renewal {
            Some(Renewal::Refused) => put(core, Some(state(SignIn::SignedOut))),
            Some(Renewal::NotKept(_, why)) => {
                let why = format!("the system's credential store did not keep it ({why})");
                put(core, Some(failed_with(why)));
            }
            Some(Renewal::None) => put(core, None),
            _ => {}
        }
    });
}

/// One sign-in's values: what Tasktap is registered as, PKCE's verifier
/// (S256), the state its callback must bring back and the nonce its ID
/// token must hold, 244 random bits each, 43 characters.
struct Attempt {
    registration: Registration,
    verifier: String,
    state: String,
    nonce: String,
}

impl Attempt {
    fn new(registration: Registration) -> Attempt {
        let random = || b64(&Secret::mint().0);
        Attempt {
            registration,
            verifier: random(),
            state: random(),
            nonce: random(),
        }
    }

    /// OpenAI's authorisation page for this attempt. It holds no token.
    fn address(&self, openai: &OpenAi, redirect: &str) -> String {
        let challenge = b64(&Sha256::digest(self.verifier.as_bytes()));
        let client = self.registration.client.as_deref();
        let mut params = vec![("client_id", client.unwrap_or(FIRST_CLIENT))];
        // A first registration names the app; signing in again does not.
        if client.is_none() {
            params.push(("agent_name_hint", NAME));
        }
        params.extend([
            ("ext_agent_host_id", self.registration.host.as_str()),
            ("response_type", "code"),
            ("redirect_uri", redirect),
            ("scope", SCOPES),
            ("resource", RESOURCE),
            ("state", &self.state),
            ("nonce", &self.nonce),
            ("code_challenge_method", "S256"),
            ("code_challenge", &challenge),
        ]);
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
    NoModel,
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
    let data = core.terminals.data().to_owned();
    let (openai, attempt) = (openai(), Attempt::new(registration(&data)));
    let address = attempt.address(&openai, &redirect);
    let before = effects::read(core, |tx| tx.pref(PrefKey::Chatgpt))?;
    let before = match before.map(|p| p.value) {
        Some(PrefValue::Chatgpt(seen)) => seen,
        _ => None,
    };
    put(core, Some(state(SignIn::Waiting)));
    let (stop, stopped) = mpsc::channel();
    core.chatgpt.attempts += 1;
    let number = core.chatgpt.attempts;
    // OpenAI tells the person of a client id it no longer knows (they
    // removed Tasktap in ChatGPT's settings) on its own page, and sends the
    // browser nowhere: an attempt under a kept one that ends with no
    // callback, by its time or a cancel, forgets it, and the next registers
    // anew. The host id stays.
    let unknown = (attempt.registration.client.is_some()).then(|| {
        let forgotten = Registration {
            client: None,
            ..attempt.registration.clone()
        };
        (data.clone(), forgotten)
    });
    let called = Arc::new(AtomicBool::new(false));
    core.chatgpt.waiting = Some(Waiting {
        number,
        stop,
        before,
        unknown: unknown.clone(),
        called: called.clone(),
    });
    let wait = core.chatgpt.second * WAIT;
    let (vault, held) = (core.chatgpt.vault.clone(), core.chatgpt.held.clone());
    let work = move || {
        // The host id is kept from its first use.
        if attempt.registration.client.is_none() {
            register(&data, &attempt.registration);
        }
        let back = match listen(listener, &attempt.state, &stopped, wait) {
            Ok(back) => back,
            Err(None) => return None,
            Err(Some(why)) => {
                if let Some((data, forgotten)) = &unknown {
                    register(data, forgotten);
                }
                return Some(Ended::Failed(why));
            }
        };
        called.store(true, Ordering::Relaxed);
        let done = signed_in(
            &*vault, &held, &openai, &attempt, &redirect, &back, &data, &stopped,
        );
        done.unwrap_or_else(|why| Some(Ended::Failed(why)))
    };
    let (vault, held) = (core.chatgpt.vault.clone(), core.chatgpt.held.clone());
    crate::calls::aside(core, work, move |core, ended| {
        let ended = ended.flatten();
        if core.chatgpt.waiting.as_ref().map(|w| w.number) != Some(number) {
            // Cancelled: one that got through all the same is ended at
            // OpenAI and not kept.
            if let Some(Ended::SignedIn { .. }) = ended {
                let forget = move || {
                    let mut held = held.lock().unwrap_or_else(PoisonError::into_inner);
                    forget(&*vault, &mut held, &self::openai())
                };
                crate::calls::aside(core, forget, |_, _| {});
            }
            return;
        }
        core.chatgpt.waiting = None;
        core.events.notify_one();
        match ended.unwrap_or(Ended::Failed("the sign-in ended without an answer".into())) {
            Ended::SignedIn { model, name } => {
                let seen = Seen {
                    model: Some(model.clone()),
                    name: Some(name),
                    ..state(SignIn::SignedIn)
                };
                write(core, Some(seen), |tx| agree(tx, &model));
            }
            Ended::NoPlan => put(core, Some(state(SignIn::NoPlan))),
            Ended::NoModel => put(core, Some(state(SignIn::NoModel))),
            Ended::Failed(why) => put(core, Some(failed_with(why))),
        }
    });
    Ok(address)
}

/// `chatgpt.sign_out`: ends the wait for a sign-in, which puts back what
/// was there before it, or the sign-in: at OpenAI, as far as it can be
/// reached, and in the credential store. ChatGPT's row leaves the
/// agreement. What Tasktap registered as at OpenAI is kept.
pub fn sign_out(cx: &mut Cx, _: Empty) -> Option<Control> {
    let (link, id) = (cx.link.clone(), cx.id);
    let core = &mut *cx.core;
    if let Some(waiting) = core.chatgpt.waiting.take() {
        let Waiting {
            stop,
            before,
            unknown,
            called,
            ..
        } = waiting;
        let _ = stop.send(());
        if let Some((data, forgotten)) = unknown.filter(|_| !called.load(Ordering::Relaxed)) {
            register(&data, &forgotten);
        }
        core.events.notify_one();
        put(core, before);
        return Some(call::ChatgptSignOut::reply(id, Ok(())));
    }
    let (vault, held) = (core.chatgpt.vault.clone(), core.chatgpt.held.clone());
    let work = move || {
        let mut held = held.lock().unwrap_or_else(PoisonError::into_inner);
        forget(&*vault, &mut held, &openai())
    };
    crate::calls::aside(core, work, move |core, done| {
        let lost = || Err("the credential store ended without an answer".to_owned());
        let result = done.unwrap_or_else(lost);
        if result.is_ok() {
            write(core, None, unagree);
        }
        let result = result.map_err(|why| Error::new(Code::Failed, why));
        link.send(&call::ChatgptSignOut::reply(id, result));
    });
    None
}

/// Whether a word came on `stop`, or nobody can send one any more.
fn stopped(stop: &mpsc::Receiver<()>) -> bool {
    stop.try_recv() != Err(TryRecvError::Empty)
}

/// Waits for the browser to come back with this attempt's `state`, until
/// `wait` or a word on `stop`, looked at between connections: what it
/// brought. One that does not bring it is answered and ends nothing.
/// `Err(None)`: stopped.
fn listen(
    listener: TcpListener,
    state: &str,
    stop: &mpsc::Receiver<()>,
    wait: Duration,
) -> Result<HashMap<String, String>, Option<String>> {
    let failed = |e: std::io::Error| Some(format!("the browser could not be listened for: {e}"));
    listener.set_nonblocking(true).map_err(failed)?;
    let until = Instant::now() + wait;
    loop {
        if stopped(stop) {
            return Err(None);
        }
        if Instant::now() > until {
            let why = "no answer came from the browser within 5 minutes";
            return Err(Some(why.into()));
        }
        match listener.accept() {
            Ok((conn, _)) => {
                if let Some(back) = answer(conn, state) {
                    return Ok(back);
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50))
            }
            Err(e) => return Err(failed(e)),
        }
    }
}

/// Reads one request, in [`ONE`] at most however its bytes come, and
/// answers it with a page: what the callback brought when it is this
/// attempt's.
fn answer(mut conn: TcpStream, state: &str) -> Option<HashMap<String, String>> {
    conn.set_nonblocking(false).ok()?;
    let until = Instant::now() + ONE;
    let (mut head, mut chunk) = (Vec::new(), [0; 2048]);
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() || head.len() > 16 << 10 {
            return None;
        }
        conn.set_read_timeout(Some(left)).ok()?;
        match conn.read(&mut chunk) {
            Ok(n @ 1..) => head.extend_from_slice(&chunk[..n]),
            _ => return None,
        }
    }
    let head = String::from_utf8_lossy(&head);
    let line = head.lines().next().unwrap_or_default();
    let target = line.strip_prefix("GET ").and_then(|l| l.split(' ').next());
    let target = target.unwrap_or_default();
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
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

/// What OpenAI says when it no longer knows a client id it issued.
fn unknown(said: &str) -> bool {
    ["invalid_client", "unauthorized_client"]
        .iter()
        .any(|code| said.starts_with(code))
}

/// The rest of a sign-in once the browser came back: the code exchanged
/// under the client id kept or just issued, the ID token checked, the model
/// asked for, the sign-in kept. Tokens it does not keep it ends at OpenAI:
/// of an account not offered the model, or not allowing the use of its
/// plan, or a sign-in cancelled meanwhile (`None`). A kept client id OpenAI
/// refuses is forgotten, so that the next sign-in registers anew.
#[allow(clippy::too_many_arguments)]
fn signed_in(
    vault: &dyn Vault,
    held: &Mutex<Held>,
    openai: &OpenAi,
    attempt: &Attempt,
    redirect: &str,
    back: &HashMap<String, String>,
    data: &Path,
    stop: &mpsc::Receiver<()>,
) -> Result<Option<Ended>, String> {
    let refused = |said: String| {
        if attempt.registration.client.is_some() && unknown(&said) {
            let forgotten = Registration {
                client: None,
                ..attempt.registration.clone()
            };
            register(data, &forgotten);
        }
        said
    };
    if let Some(error) = back.get("error") {
        let words = back.get("error_description").filter(|d| !d.is_empty());
        let said = words.map_or(error.clone(), |words| format!("{error}: {words}"));
        return Err(refused(said));
    }
    let code = back
        .get("code")
        .ok_or("the browser came back without a code")?;
    let issued = back
        .get("client_id")
        .filter(|c| !c.is_empty() && *c != FIRST_CLIENT);
    let client = match (issued, &attempt.registration.client) {
        (Some(issued), _) => issued.clone(),
        (None, Some(kept)) => kept.clone(),
        (None, None) => {
            return Err("the browser came back without the client id OpenAI issued".into());
        }
    };
    if issued.is_some() {
        // Kept before the code is exchanged, so a failed exchange does not
        // register Tasktap a second time.
        let issued = Registration {
            client: Some(client.clone()),
            ..attempt.registration.clone()
        };
        register(data, &issued);
    }
    let fields = [
        ("grant_type", "authorization_code"),
        ("client_id", &client),
        ("code", code),
        ("code_verifier", &attempt.verifier),
        ("redirect_uri", redirect),
        ("resource", RESOURCE),
    ];
    let tokens = match token(openai, &fields, CALL) {
        Ok(tokens) => tokens,
        Err(Refused(said)) => return Err(refused(said)),
        Err(Unanswered(why)) => return Err(why),
    };
    let refresh = tokens["refresh_token"].as_str();
    let end = || {
        if let Some(refresh) = refresh {
            revoke(openai, &client, refresh);
        }
    };
    let id_token = tokens["id_token"]
        .as_str()
        .ok_or("OpenAI answered without an ID token")?;
    if let Err(why) = checked(openai, id_token, &client, &attempt.nonce) {
        end();
        return Err(why);
    }
    let plan = tokens["scope"]
        .as_str()
        .unwrap_or_default()
        .split(' ')
        .any(|s| s == PLAN);
    let access = tokens["access_token"].as_str().unwrap_or_default();
    let offered = match plan {
        true => offered(openai, access),
        false => Ok(None),
    };
    let ended = match offered {
        _ if stopped(stop) => None,
        Ok(Some(name)) => Some(Ended::SignedIn {
            model: MODEL.into(),
            name,
        }),
        Ok(None) if plan => Some(Ended::NoModel),
        Ok(None) => Some(Ended::NoPlan),
        Err(why) => Some(Ended::Failed(why)),
    };
    if !matches!(ended, Some(Ended::SignedIn { .. })) {
        end();
        return Ok(ended);
    }
    let kept = Kept {
        client: client.clone(),
        access: access.into(),
        refresh: refresh.map(Into::into),
        until: until(&tokens),
    };
    let mut held = held.lock().unwrap_or_else(PoisonError::into_inner);
    if let Err(why) = keep(vault, &kept) {
        let _ = remove(vault);
        end();
        return Err(format!(
            "the system's credential store did not keep it ({why})"
        ));
    }
    held.set(Some(kept));
    Ok(ended)
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

/// Whether the account's list offers [`MODEL`], and the name it shows for
/// it. One request, made once at sign-in.
fn offered(openai: &OpenAi, access: &str) -> Result<Option<String>, String> {
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
    let slug = |m: &Value| m["slug"].as_str().or(m["id"].as_str()).map(str::to_owned);
    let shown = |m: &&Value| m["visibility"].as_str().is_none_or(|v| v == "list");
    let model = (all.into_iter().flatten()).find(|m| shown(m) && slug(m).as_deref() == Some(MODEL));
    Ok(model.map(|m| {
        let name = m["display_name"].as_str().filter(|n| !n.trim().is_empty());
        name.map_or(MODEL.into(), |n| cut(n, 100))
    }))
}

/// What a placing asks ChatGPT with.
pub struct Asking {
    stale: Arc<AtomicBool>,
}

impl Asking {
    /// Asks ChatGPT one placing question on the person's plan, within
    /// `limit`: the instructions in a field of their own, `request`
    /// (route.rs `asked`) as the one message, and the answer held to
    /// route.rs `SCHEMA`. The access token comes on `renewed`, from
    /// [`renew`]; when it does not come in time, or no time is left for the
    /// call, the thought is passed on. The answer's JSON text. A `Stop` on
    /// `wait` ends the call.
    pub fn ask(
        &self,
        model: &str,
        request: &str,
        limit: Duration,
        renewed: mpsc::Receiver<Result<String, String>>,
        wait: Wait,
    ) -> Result<String, Failed> {
        let began = Instant::now();
        let access = match renewed.recv_timeout(limit) {
            Ok(Ok(access)) => access,
            Ok(Err(why)) => return Err(Failed::Why(why)),
            Err(_) => return Err(Failed::Why(LATE.into())),
        };
        let left = limit.saturating_sub(began.elapsed());
        if left < LEAST {
            return Err(Failed::Why(LATE.into()));
        }
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
        let url = format!("{}/responses", openai().api);
        let request = Request {
            url: &url,
            key: Some(&access),
            body: Body::Json(&body),
            limit: left,
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
            401 => {
                self.stale.store(true, Ordering::Relaxed);
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
    let refresh = body["refresh_token"].as_str();
    match status {
        200 if body["access_token"].as_str().is_some_and(usable) && refresh.is_none_or(usable) => {
            Ok(body)
        }
        200 => Err(Unanswered(
            "OpenAI answered without a token Tasktap can send".into(),
        )),
        400 | 401 => Err(Refused(said(&body, status))),
        _ => Err(Unanswered(said(&body, status))),
    }
}

/// Whether a token can be sent: of any length, as OpenAI's signed tokens
/// are long, and with no control character, which no header holds.
fn usable(token: &str) -> bool {
    !token.is_empty() && !token.chars().any(char::is_control)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// A credential store in memory.
    #[derive(Default)]
    struct Store(Mutex<BTreeMap<String, String>>);

    impl Vault for Store {
        fn set(&self, name: &str, key: &str) -> Result<(), String> {
            assert!(secrets::plain(name) && secrets::plain(key), "{name}");
            self.0.lock().unwrap().insert(name.into(), key.into());
            Ok(())
        }

        fn get(&self, name: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(name).cloned())
        }

        fn remove(&self, name: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(name);
            Ok(())
        }
    }

    impl Store {
        fn names(&self) -> Vec<String> {
            self.0.lock().unwrap().keys().cloned().collect()
        }
    }

    /// A sign-in with tokens of the length OpenAI's are.
    fn signed(n: u8) -> Kept {
        Kept {
            client: "oaiapp_0123456789".into(),
            access: format!("eyJ{}", char::from(b'a' + n).to_string().repeat(2300)),
            refresh: Some(format!("rt_{}", "r".repeat(200))),
            until: 1,
        }
    }

    #[test]
    fn a_long_sign_in_is_kept_in_parts_and_read_back_whole() {
        let store = Store::default();
        assert!(kept(&store).unwrap().is_none());
        keep(&store, &signed(0)).unwrap();
        // The first part says how many follow and what they hold.
        let head = store.get(&part(0)).unwrap().unwrap();
        let n: usize = head.split_once('-').unwrap().0.parse().unwrap();
        assert!(n >= 6, "{head}");
        assert_eq!(kept(&store).unwrap().unwrap().access, signed(0).access);
        // A shorter one leaves no part of the longer behind.
        let short = Kept {
            access: "eyJshort".into(),
            ..signed(1)
        };
        keep(&store, &short).unwrap();
        assert_eq!(store.names(), [part(0), part(1)]);
        assert_eq!(kept(&store).unwrap().unwrap().access, "eyJshort");
    }

    #[test]
    fn a_record_that_does_not_read_whole_is_no_sign_in_and_leaves_no_part() {
        // A renewal stopped half-way: the new parts written, the first part
        // still the old one's.
        let store = Store::default();
        keep(&store, &signed(0)).unwrap();
        let old = store.get(&part(0)).unwrap().unwrap();
        keep(&store, &signed(1)).unwrap();
        store.set(&part(0), &old).unwrap();
        assert!(kept(&store).unwrap().is_none());
        assert_eq!(store.names(), Vec::<String>::new());
        // A first sign-in stopped before its first part.
        keep(&store, &signed(2)).unwrap();
        store.remove(&part(0)).unwrap();
        assert!(kept(&store).unwrap().is_none());
        assert_eq!(store.names(), Vec::<String>::new());
        // A part missing.
        keep(&store, &signed(3)).unwrap();
        store.remove(&part(3)).unwrap();
        assert!(kept(&store).unwrap().is_none());
        assert_eq!(store.names(), Vec::<String>::new());
    }

    #[test]
    fn removing_clears_every_part_whatever_the_gaps() {
        let store = Store::default();
        for i in [0, 3, 9, PARTS - 1] {
            store.set(&part(i), "piece").unwrap();
        }
        remove(&store).unwrap();
        assert_eq!(store.names(), Vec::<String>::new());
    }
}
