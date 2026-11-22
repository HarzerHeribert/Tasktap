//! Placing by a model at an address the person names (design §8, "Your own
//! model"): a server in the OpenAI chat-completions form, which Ollama, LM
//! Studio, llama.cpp, vLLM and most hosted services offer, so that one layer
//! serves all of them and no code is written for any one. It is asked the
//! very question ChatGPT is asked (`route.rs` `asked`, with the instructions
//! as the system message), and its answer goes through the same reading and
//! the same rules; a placing that fails passes on as ChatGPT's does.
//!
//! What the person sets is an address (up to `/chat/completions` and
//! `/models`, as `http://127.0.0.1:11434/v1`), a model's name and, where the
//! server wants one, a key (`own_model.set`). The address and the name are
//! the `own_model` preference, which only the core writes; setting up is the
//! agreement for this row ([`chatgpt::agree`]) and `own_model.remove` takes
//! the row out. Plain `http` goes only to this machine or to an address on a
//! private network, any other address is `https`; no redirect is followed,
//! so a request never leaves for another host. The key is kept as a speech
//! service's key is (`secrets.rs`, under the address it was entered for, which
//! `keys` lists), sent only to that address and only over `https` or to
//! this machine, struck from every text a server sends back, and dropped with
//! a change of address.
//!
//! The answer is asked for as JSON in the strictest form the server accepts:
//! a JSON schema as `response_format`, else `json_object`, else plain text
//! from which its JSON is read. A server that refuses one form (400 or 422)
//! is asked again with the next, within the same time, and what worked is
//! remembered for that server until the core ends. An answer that cannot be
//! read is no answer. A model on this machine may need long to load, so
//! the first answer after a start may take [`FIRST`], later ones [`LATER`],
//! whatever [`route::BUDGET`] says of the agents.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tasktap_proto::call::{self, Call, Code, Error};
use tasktap_proto::{
    Control, Empty, ListModels, Models, OwnModel, PrefKey, PrefValue, SetOwnModel,
};

use crate::agents::checks::Failed;
use crate::calls::Cx;
use crate::command::{Signal, Wait};
use crate::http::{self, Body, Request};
use crate::secrets::{self, Vault};
use crate::store::{self, Tx};
use crate::{chatgpt, effects, route, speech};

/// The own model's id where an agreement and a thought's `route` name who
/// placed.
pub const ID: &str = "own";
/// Longest the first answer after a start may take: a model on this machine
/// may be loading.
pub const FIRST: Duration = Duration::from_secs(60);
/// Longest a later answer may take.
pub const LATER: Duration = Duration::from_secs(20);
/// Longest a look at a server's list of models takes.
const LIST: Duration = Duration::from_secs(5);
/// Least time worth a call: with less left, a placing passes on.
const LEAST: Duration = Duration::from_millis(500);
/// Most models of a server's list that are kept.
const MODELS: usize = 200;
/// Longest a model's name is.
const NAME: usize = 200;
/// Why a placing passed the thought on, as an agent's says it.
const LATE: &str = "no time was left to ask it";
/// Who a failed call says it could not reach.
const WHO: &str = "the server";

/// An own model as a placing asks it: where, which, and whether a key is
/// stored for that address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Placing {
    pub address: String,
    pub model: String,
    pub keyed: bool,
}

/// The own model that is set up, if any.
pub fn placing(tx: &Tx) -> store::Result<Option<Placing>> {
    let Some(PrefValue::OwnModel(Some(own))) = tx.pref(PrefKey::OwnModel)?.map(|p| p.value) else {
        return Ok(None);
    };
    let keys = tx.pref(PrefKey::Keys)?.map(|p| p.value);
    let keyed = matches!(keys, Some(PrefValue::Keys(keys)) if keys.contains(&own.address));
    Ok(Some(Placing {
        address: own.address,
        model: own.model,
        keyed,
    }))
}

/// What a placing costs the person: nothing more where the model is on this
/// machine or a private network, what the provider bills where it is not.
pub fn pays(address: &str) -> tasktap_proto::Pays {
    match speech::server(address) {
        Ok(reach) if reach.here || reach.near => tasktap_proto::Pays::Plan,
        _ => tasktap_proto::Pays::Billed,
    }
}

/// How the answer is asked for, the strictest first.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Form {
    Schema,
    Object,
    Plain,
}

impl Form {
    fn next(self) -> Option<Form> {
        match self {
            Form::Schema => Some(Form::Object),
            Form::Object => Some(Form::Plain),
            Form::Plain => None,
        }
    }

    fn format(self) -> Option<Value> {
        let schema: Value = serde_json::from_str(route::SCHEMA).unwrap_or_default();
        match self {
            Form::Schema => Some(json!({ "type": "json_schema",
                "json_schema": { "name": "placing", "strict": true, "schema": schema } })),
            Form::Object => Some(json!({ "type": "json_object" })),
            Form::Plain => None,
        }
    }
}

/// What the own model shares between placings: the credential store, whether
/// a server answered since the core started, and the form each server took.
#[derive(Clone)]
pub struct Own {
    vault: Arc<dyn Vault>,
    warm: Arc<AtomicBool>,
    form: Arc<Mutex<Option<(String, Form)>>>,
}

impl Default for Own {
    fn default() -> Own {
        Own {
            vault: secrets::vault(),
            warm: Default::default(),
            form: Default::default(),
        }
    }
}

impl Own {
    /// How long the next placing may take: [`FIRST`] until a server has
    /// answered, then [`LATER`]. A build with the test fixtures takes both
    /// from `TASKTAP_OWN_LIMITS`, in milliseconds as `first,later`.
    pub fn limit(&self) -> Duration {
        #[cfg(feature = "fixtures")]
        let (first, later) = match std::env::var("TASKTAP_OWN_LIMITS") {
            Ok(limits) => {
                let ms = |t: &str| Duration::from_millis(t.parse().unwrap_or_default());
                (limits.split_once(',')).map_or((FIRST, LATER), |(a, b)| (ms(a), ms(b)))
            }
            Err(_) => (FIRST, LATER),
        };
        #[cfg(not(feature = "fixtures"))]
        let (first, later) = (FIRST, LATER);
        match self.warm.load(Ordering::Relaxed) {
            true => later,
            false => first,
        }
    }

    /// Asks the model one placing question within `limit`: the instructions
    /// as the system message, `request` (route.rs `asked`) as the user's. The
    /// answer's JSON text, or why there is none.
    pub fn ask(
        &self,
        to: &Placing,
        request: &str,
        limit: Duration,
        stop: &Stop,
    ) -> Result<String, Failed> {
        let key = match to.keyed.then(|| self.vault.get(&to.address)) {
            None => None,
            Some(Ok(Some(key))) => Some(key),
            Some(Ok(None)) => {
                return Err(why(
                    "its key is no longer in the system's credential store",
                    None,
                ));
            }
            Some(Err(e)) => return Err(why(&e, None)),
        };
        self.send(to, key.as_deref(), request, limit, stop)
    }

    /// The same with the key given.
    fn send(
        &self,
        to: &Placing,
        key: Option<&str>,
        request: &str,
        limit: Duration,
        stop: &Stop,
    ) -> Result<String, Failed> {
        let (began, same) = (Instant::now(), format!("{} {}", to.address, to.model));
        let mut form = match &*self.form.lock().unwrap_or_else(PoisonError::into_inner) {
            Some((was, form)) if *was == same => *form,
            _ => Form::Schema,
        };
        loop {
            let left = limit.saturating_sub(began.elapsed());
            let Some(wait) = stop.attempt() else {
                return Err(why("it was not waited for", key));
            };
            if left < LEAST {
                return Err(why(LATE, key));
            }
            let mut body = json!({
                "model": to.model,
                "messages": [
                    { "role": "system", "content": route::INSTRUCTIONS },
                    { "role": "user", "content": request },
                ],
                "stream": false,
            });
            if let Some(format) = form.format() {
                body["response_format"] = format;
            }
            let body = http::plain_json(&body.to_string());
            let url = format!("{}/chat/completions", to.address);
            let post = Request {
                url: &url,
                key,
                body: Body::Json(&body),
                limit: left,
            };
            let answer = http::send(&post, wait)
                .map_err(|e| why(&chatgpt::unanswered(e, WHO, limit), key))?;
            let text = String::from_utf8_lossy(&answer.body);
            let parsed: Value = serde_json::from_str(&text).unwrap_or_default();
            let words = || chatgpt::said(&parsed, answer.status);
            let sentence = match answer.status {
                200 => {
                    self.warm.store(true, Ordering::Relaxed);
                    let text = reply(&parsed).map_err(|e| why(&e, key))?;
                    *self.form.lock().unwrap_or_else(PoisonError::into_inner) = Some((same, form));
                    return Ok(text);
                }
                // The form is what a server may refuse: the next is asked.
                400 | 422 if form.next().is_some() => {
                    form = form.next().unwrap_or(form);
                    continue;
                }
                401 | 403 => format!("the server did not take the key ({})", words()),
                404 => format!("the server has no model {} ({})", to.model, words()),
                429 => format!("the server is at its limit for now ({})", words()),
                _ => format!("the server did not take the question ({})", words()),
            };
            return Err(why(&sentence, key));
        }
    }
}

/// A text from a server or from here, with the key struck from it, as the
/// reason a placing gives for passing on.
fn why(text: &str, key: Option<&str>) -> Failed {
    Failed::Why(strike(text, key))
}

fn strike(text: &str, key: Option<&str>) -> String {
    match key {
        Some(key) => text.replace(key, "(key)"),
        None => text.to_owned(),
    }
}

/// The JSON text in a chat completion's answer, or why there is none.
fn reply(answer: &Value) -> Result<String, String> {
    let choice = &answer["choices"][0];
    let Some(text) = choice["message"]["content"].as_str() else {
        return Err("its answer holds no text".into());
    };
    if choice["finish_reason"] == "length" {
        return Err("its answer was cut short".into());
    }
    json_in(text).ok_or_else(|| "its answer holds no JSON".into())
}

/// The first JSON object in `text` that has a confidence, as a text: a model
/// that was not held to JSON may fence it, or think aloud before it.
fn json_in(text: &str) -> Option<String> {
    text.match_indices('{').find_map(|(at, _)| {
        let mut values = serde_json::Deserializer::from_str(&text[at..]).into_iter::<Value>();
        let value = values.next()?.ok()?;
        let end = at + values.byte_offset();
        value.get("confidence").map(|_| text[at..end].to_owned())
    })
}

/// What stops a call: the attempt under way ends and no other is made. Undo
/// stops a placing as it stops a tool.
#[derive(Clone, Default)]
pub struct Stop(Arc<Mutex<(bool, Option<Sender<Signal>>)>>);

impl Stop {
    pub fn now(&self) {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        state.0 = true;
        if let Some(sender) = state.1.take() {
            let _ = sender.send(Signal::Stop);
        }
    }

    /// The wait of one attempt, none once stopped.
    fn attempt(&self) -> Option<Wait> {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let (sender, receiver) = mpsc::channel();
        match state.0 {
            true => None,
            false => {
                state.1 = Some(sender.clone());
                Some((sender, receiver))
            }
        }
    }
}

/// The question `route-lab` asks of a server, in the product's own way: the
/// same call a placing makes, with no core and nothing remembered.
pub fn lab(address: &str, model: &str, key: Option<&str>, request: &str) -> Result<String, String> {
    let to = Placing {
        address: address.into(),
        model: model.into(),
        keyed: key.is_some(),
    };
    match Own::default().send(&to, key, request, FIRST, &Stop::default()) {
        Ok(text) => Ok(text),
        Err(Failed::Why(why)) => Err(why),
        Err(_) => Err("it gave no answer".into()),
    }
}

/// Whether an address is one an own model may be at: `https`, or `http` on
/// this machine or a private network. Where it leads, or why it is no
/// address.
fn reached(address: &str) -> Result<speech::Reach, String> {
    let reach = speech::server(address)?;
    match reach.secure || reach.here || reach.near {
        true => Ok(reach),
        false => {
            Err("a model's address is https, or http on this machine or a private network".into())
        }
    }
}

/// `own_model.set`: the model at an address is the one placing asks, ChatGPT's
/// row beside it. A key is kept for the address; a changed address drops the
/// key of the old one.
pub fn save(cx: &mut Cx, args: SetOwnModel) -> Option<Control> {
    let SetOwnModel {
        address,
        model,
        key,
    } = args;
    let (link, id) = (cx.link.clone(), cx.id);
    let invalid = |why: &str| {
        Some(call::OwnModelSet::reply(
            id,
            Err(Error::new(Code::Invalid, why)),
        ))
    };
    let reach = match reached(&address) {
        Ok(reach) => reach,
        Err(why) => return invalid(&why),
    };
    if !(secrets::plain(&model) && model.len() <= NAME) {
        return invalid(
            "a model's name is 1 to 200 printable characters, none a space, a quote or a backslash",
        );
    }
    let key = key.filter(|key| !key.is_empty());
    if let Some(key) = &key {
        if !reach.keeps() {
            return invalid("a key is only sent over https or to this machine");
        }
        if !secrets::plain(key) {
            return invalid(
                "a key is 1 to 512 printable characters, none a space, a quote or a backslash",
            );
        }
    }
    let known = effects::read(cx.core, |tx| {
        let speech = tx.pref(PrefKey::SpeechBy)?.map(|p| p.value);
        Ok((placing(tx)?, speech))
    });
    let (before, speech) = match known {
        Ok(known) => known,
        Err(e) => return Some(call::OwnModelSet::reply(id, Err(e))),
    };
    // The key of the address it was for goes with that address, unless a speech service
    // is at that very address.
    let spoken = |address: &str| matches!(&speech, Some(PrefValue::SpeechBy(Some(by))) if by.server == address);
    let dropped = before
        .clone()
        .filter(|p| p.address != address && p.keyed && !spoken(&p.address));
    let kept = before
        .as_ref()
        .is_some_and(|p| p.address == address && p.keyed);
    let (vault, own) = (cx.core.own.vault.clone(), (address.clone(), model));
    let work = {
        let (address, key, dropped) = (address.clone(), key.clone(), dropped.clone());
        move || -> Result<(), String> {
            if let Some(key) = &key {
                vault.set(&address, key)?;
            }
            dropped.map_or(Ok(()), |p| vault.remove(&p.address))
        }
    };
    crate::calls::aside(cx.core, work, move |core, done| {
        let lost = || Err("the credential store ended without an answer".to_owned());
        let (address, model) = own;
        let result = (done.unwrap_or_else(lost))
            .map_err(|e| Error::new(Code::Failed, strike(&e, key.as_deref())))
            .and_then(|()| {
                effects::write(core, |tx| {
                    let own = PrefValue::OwnModel(Some(OwnModel {
                        address: address.clone(),
                        model: model.clone(),
                    }));
                    let put = tx.put_pref(&own);
                    put.and_then(|()| chatgpt::agree(tx, ID, &model))
                        .map_err(effects::stored)
                })
            })
            .and_then(|()| match &dropped {
                Some(p) => speech::listed(core, &p.address, false),
                None => Ok(()),
            })
            .and_then(|()| speech::listed(core, &address, key.is_some() || kept));
        link.send(&call::OwnModelSet::reply(id, result));
    });
    None
}

/// `own_model.remove`: no own model is set up; its row leaves the agreement,
/// and its key the credential store.
pub fn remove(cx: &mut Cx, _: Empty) -> Option<Control> {
    let (link, id) = (cx.link.clone(), cx.id);
    let before = match effects::read(cx.core, placing) {
        Ok(before) => before,
        Err(e) => return Some(call::OwnModelRemove::reply(id, Err(e))),
    };
    let vault = cx.core.own.vault.clone();
    let keyed = before.clone().filter(|p| p.keyed);
    let work = move || keyed.map_or(Ok(()), |p| vault.remove(&p.address));
    crate::calls::aside(cx.core, work, move |core, done| {
        let lost = || Err("the credential store ended without an answer".to_owned());
        let result = (done.unwrap_or_else(lost))
            .map_err(|e| Error::new(Code::Failed, e))
            .and_then(|()| {
                effects::write(core, |tx| {
                    let none = PrefValue::OwnModel(None);
                    let put = tx.put_pref(&none);
                    put.and_then(|()| chatgpt::unagree(tx, ID))
                        .map_err(effects::stored)
                })
            })
            .and_then(|()| match &before {
                Some(p) if p.keyed => speech::listed(core, &p.address, false),
                _ => Ok(()),
            });
        link.send(&call::OwnModelRemove::reply(id, result));
    });
    None
}

/// `own_model.list`: the models the server at an address lists, for the
/// chooser. A server that does not answer is an error the page may ignore:
/// that is how one on this machine is found, or not.
pub fn list(cx: &mut Cx, args: ListModels) -> Option<Control> {
    let ListModels { address, key } = args;
    let (link, id) = (cx.link.clone(), cx.id);
    let refused = |why: String| {
        Some(call::OwnModelList::reply(
            id,
            Err(Error::new(Code::Invalid, why)),
        ))
    };
    let reach = match reached(&address) {
        Ok(reach) => reach,
        Err(why) => return refused(why),
    };
    let key = key.filter(|key| !key.is_empty());
    if key
        .as_ref()
        .is_some_and(|key| !reach.keeps() || !secrets::plain(key))
    {
        return refused("a key is only sent over https or to this machine, and is 1 to 512 printable characters".into());
    }
    // No key typed: the one stored for this address, where the model is set up at it.
    let stored = match effects::read(cx.core, placing) {
        Ok(set) => set.filter(|p| p.keyed && p.address == address && key.is_none()),
        Err(e) => return Some(call::OwnModelList::reply(id, Err(e))),
    };
    let vault = cx.core.own.vault.clone();
    let work = move || -> Result<Vec<String>, String> {
        let key = match (key, stored) {
            (Some(key), _) => Some(key),
            (None, Some(_)) => vault.get(&address)?,
            (None, None) => None,
        };
        models(&address, key.as_deref()).map_err(|e| strike(&e, key.as_deref()))
    };
    crate::calls::aside(cx.core, work, move |_, done| {
        let lost = || Err("it ended without an answer".to_owned());
        let result = (done.unwrap_or_else(lost))
            .map(|models| Models { models })
            .map_err(|e| Error::new(Code::Failed, e));
        link.send(&call::OwnModelList::reply(id, result));
    });
    None
}

/// The names of the models a server lists (`GET {address}/models`).
fn models(address: &str, key: Option<&str>) -> Result<Vec<String>, String> {
    let url = format!("{address}/models");
    let get = Request {
        url: &url,
        key,
        body: Body::None,
        limit: LIST,
    };
    let answer = http::send(&get, mpsc::channel()).map_err(|e| chatgpt::failed(e, WHO))?;
    let body: Value = serde_json::from_slice(&answer.body).unwrap_or_default();
    if answer.status != 200 {
        return Err(format!(
            "the server did not list its models ({})",
            chatgpt::said(&body, answer.status)
        ));
    }
    let listed = (body["data"].as_array())
        .ok_or("the server's list of models is not in the form a list of models has")?;
    let name = |m: &Value| {
        m["id"]
            .as_str()
            .filter(|n| secrets::plain(n) && n.len() <= NAME)
            .map(str::to_owned)
    };
    Ok(listed.iter().filter_map(name).take(MODELS).collect())
}
