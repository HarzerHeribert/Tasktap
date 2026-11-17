//! The call table (design §1, §2): one match from a call's name to its
//! handler, and the one place a call is authorized.
//!
//! A package adds a call with one arm in [`handler`]. From then on `welcome`
//! lists it, and the protocol crate's access rule for it is checked before
//! it runs.

use crate::conn::{Link, Peer};
use crate::handshake::SUPPORTED;
use crate::serve::{BUILD, Core};
use serde_json::Value;
use std::rc::Rc;
use tasktap_proto::call::{self, Call, Code, Error, Name};
use tasktap_proto::{
    CallId, Control, CoreStatus, DeviceId, Empty, Identity, NO_SHARED_VERSION, Outcome, Ref, Reply,
    Request, Retire, TerminalId, When,
};

/// Who made a call, as the handshake established it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Caller {
    /// A local peer with neither a device key nor a session token.
    Anonymous,
    Device(DeviceId),
    /// A session token: the terminal it was minted for.
    Session(TerminalId),
}

impl Caller {
    pub fn identity(self) -> Identity {
        match self {
            Caller::Anonymous => Identity::Anonymous,
            Caller::Device(_) => Identity::Device,
            Caller::Session(_) => Identity::Session,
        }
    }
}

/// What a handler is given.
#[expect(
    dead_code,
    reason = "`link` and `who` wait for the handlers of packages 5 to 7"
)]
pub struct Cx<'a> {
    pub core: &'a mut Core,
    /// The caller's connection. A handler that answers later keeps it and `id`.
    pub link: &'a Rc<Link>,
    pub who: Caller,
    pub id: CallId,
}

/// The reply to send now, or `None` from a handler that kept `cx.link` and
/// `cx.id` to send it later (a waiting `question.ask`); until then the call
/// counts toward the connection's pending calls.
pub type Handler = fn(&mut Cx, Value) -> Option<Control>;

/// The calls this build answers.
fn handler(name: Name) -> Option<Handler> {
    let handler: Handler = match name {
        Name::CoreStatus => |cx, args| now::<call::CoreStatus>(cx, args, status),
        Name::CoreRetire => |cx, args| now::<call::CoreRetire>(cx, args, retire),
        Name::DeviceRevoke => |cx, args| now::<call::DeviceRevoke>(cx, args, revoke),
        _ => return None,
    };
    Some(handler)
}

/// All that works without a shared version (design §2).
const BOOTSTRAP: [Name; 2] = [Name::CoreStatus, Name::CoreRetire];

fn offered(name: Name, v: u32) -> bool {
    v != NO_SHARED_VERSION || BOOTSTRAP.contains(&name)
}

/// What `welcome` lists: the calls this build answers at version `v`.
pub fn supported(v: u32) -> Vec<String> {
    let names = Name::ALL.iter().copied();
    names
        .filter(|&n| offered(n, v) && handler(n).is_some())
        .map(|n| n.as_str().to_owned())
        .collect()
}

/// Answers one call. Authorization happens here, before any handler runs,
/// and nowhere else.
pub fn call(core: &mut Core, link: &Rc<Link>, peer: Peer, request: Request) {
    let Request { id, name, args } = request;
    let reply = match Name::parse(&name).filter(|&n| offered(n, peer.v)) {
        None => Some(refuse(id, Code::Unknown, format!("no call {name}"))),
        Some(n) if !n.access().permits(peer.who.identity()) => Some(refuse(
            id,
            Code::Denied,
            format!("{name} is not for this caller"),
        )),
        Some(n) => match handler(n) {
            None => Some(refuse(
                id,
                Code::Unknown,
                format!("{name} is not in this build"),
            )),
            Some(handler) => {
                let who = peer.who;
                handler(
                    &mut Cx {
                        core,
                        link,
                        who,
                        id,
                    },
                    args,
                )
            }
        },
    };
    if let Some(reply) = reply {
        link.send(&reply);
    }
}

fn refuse(id: CallId, code: Code, message: String) -> Control {
    let outcome = Outcome::Err(Error::new(code, message));
    Control::Reply(Reply { id, outcome })
}

/// Runs a handler that answers at once.
fn now<C: Call>(
    cx: &mut Cx,
    args: Value,
    handler: fn(&mut Cx, C::Args) -> Result<C::Result, Error>,
) -> Option<Control> {
    let result = C::args(args).and_then(|args| handler(cx, args));
    Some(C::reply(cx.id, result))
}

fn status(cx: &mut Cx, _: Empty) -> Result<CoreStatus, Error> {
    Ok(CoreStatus {
        build: BUILD.to_owned(),
        v: SUPPORTED,
        terminals: cx.core.terminals(),
    })
}

/// `now` exits once the reply is written; `idle` once no terminal is alive,
/// whoever is connected (design §3), which in Phase 1 is at once too.
fn retire(cx: &mut Cx, args: Retire) -> Result<(), Error> {
    if cx.core.retire != Some(When::Now) {
        cx.core.retire = Some(args.when);
    }
    cx.core.events.notify_one();
    Ok(())
}

/// Marks the device revoked and drops its connections at once.
fn revoke(cx: &mut Cx, args: Ref<DeviceId>) -> Result<(), Error> {
    let failed = |e: crate::store::Error| Error::new(Code::Failed, e.to_string());
    let mut tx = cx.core.store.begin().map_err(failed)?;
    let Some((mut device, _)) = tx.device(args.id).map_err(failed)? else {
        return Err(Error::new(Code::Gone, "no such device"));
    };
    if !device.revoked {
        device.revoked = true;
        tx.update_device(&device).map_err(failed)?;
    }
    let change = tx.commit().map_err(failed)?;
    cx.core.publish(change);
    let revoked = Caller::Device(args.id);
    for link in &cx.core.links {
        if link.peer().is_some_and(|p| p.who == revoked) {
            link.close(false);
        }
    }
    Ok(())
}
