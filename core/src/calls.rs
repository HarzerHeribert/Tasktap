//! The call table (design §1, §2): one match from a call's name to its
//! handler, and the one place a call is authorized.
//!
//! A package adds a call with one arm in [`handler`]. From then on `welcome`
//! lists it, and the protocol crate's access rule for it is checked before
//! it runs.

use crate::conn::{Link, Peer};
use crate::effects::{self, stored};
use crate::handshake::SUPPORTED;
use crate::serve::{BUILD, Core};
use crate::state::{self, Destination, Event};
use crate::store::AttemptKind;
use crate::{questions, records, terminal};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use tasktap_proto::call::{self, Call, Code, Error, Name};
use tasktap_proto::{
    AddProject, Agents, CallId, Collection, Control, CoreStatus, DetectAgents, DeviceId, Empty,
    Identity, Isolate, MAX_LINE, NO_SHARED_VERSION, Outcome, PrefKey, PrefValue, Project,
    ProjectId, ProjectKind, Ref, Reply, Request, Retire, Rev, Set, TerminalId, When, json_len,
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
        Name::Sub => |cx, args| now::<call::Sub>(cx, args, records::sub),
        Name::Put => |cx, args| now::<call::Put>(cx, args, records::put),
        Name::Delete => |cx, args| now::<call::Delete>(cx, args, records::delete),
        Name::History => |cx, args| now::<call::History>(cx, args, records::history),
        Name::CoreStatus => |cx, args| now::<call::CoreStatus>(cx, args, status),
        Name::CoreRetire => |cx, args| now::<call::CoreRetire>(cx, args, retire),
        Name::DeviceRevoke => |cx, args| now::<call::DeviceRevoke>(cx, args, revoke),
        Name::ThoughtCapture => |cx, args| now::<call::ThoughtCapture>(cx, args, capture),
        Name::ThoughtUpdate => |cx, args| {
            event::<call::ThoughtUpdate>(cx, args, |a| Event::Pick {
                thought: a.id,
                to: Destination::New(a.project_id),
            })
        },
        Name::ThoughtStart => |cx, args| {
            event::<call::ThoughtStart>(cx, args, |s| Event::Start {
                thought: s.id,
                attempt: s.attempt,
            })
        },
        Name::ThoughtStop => {
            |cx, args| event::<call::ThoughtStop>(cx, args, |r| Event::Stop { thought: r.id })
        }
        Name::ThoughtRetry => {
            |cx, args| event::<call::ThoughtRetry>(cx, args, |r| Event::Retry { thought: r.id })
        }
        Name::ThoughtSettle => |cx, args| {
            event::<call::ThoughtSettle>(cx, args, |s| Event::Settle {
                thought: s.id,
                attempt: s.attempt,
                keep: s.keep,
            })
        },
        Name::ThoughtRead => {
            |cx, args| event::<call::ThoughtRead>(cx, args, |r| Event::Read { thought: r.id })
        }
        Name::SessionEvent => {
            |cx, args| now::<call::SessionEvent>(cx, args, effects::session_event)
        }
        Name::SessionAdopt => |cx, args| now::<call::SessionAdopt>(cx, args, crate::shim::adopt),
        Name::RouteHint => |cx, args| now::<call::RouteHint>(cx, args, crate::route::hint),
        Name::AgentsDetect => |cx, args| later::<call::AgentsDetect>(cx, args, detect),
        // The core makes this call; it never answers it.
        Name::ShimHold => return None,
        Name::QuestionAsk => questions::ask,
        Name::QuestionAnswer => |cx, args| now::<call::QuestionAnswer>(cx, args, questions::answer),
        Name::QuestionWithdraw => {
            |cx, args| now::<call::QuestionWithdraw>(cx, args, questions::withdraw)
        }
        Name::QuestionReceived => {
            |cx, args| now::<call::QuestionReceived>(cx, args, questions::received)
        }
        Name::QuestionFocus => |cx, args| now::<call::QuestionFocus>(cx, args, questions::focus),
        Name::Input => |cx, args| now::<call::Input>(cx, args, questions::input),
        Name::ProjectAdd => |cx, args| later::<call::ProjectAdd>(cx, args, add_project),
        Name::ProjectScan => |cx, args| later::<call::ProjectScan>(cx, args, scan_projects),
        Name::ProjectClose => {
            |cx, args| now::<call::ProjectClose>(cx, args, terminal::close_project)
        }
        Name::TerminalOpen => |cx, args| now::<call::TerminalOpen>(cx, args, terminal::open),
        Name::TerminalResize => |cx, args| now::<call::TerminalResize>(cx, args, terminal::resize),
        Name::TerminalStop => |cx, args| now::<call::TerminalStop>(cx, args, terminal::stop_call),
        #[cfg(feature = "fixtures")]
        Name::FixtureStream => {
            |cx, args| now::<call::FixtureStream>(cx, args, crate::stream::fixture)
        }
        #[cfg(feature = "fixtures")]
        Name::FixtureScript => |cx, args| now::<call::FixtureScript>(cx, args, effects::script),
        #[cfg(feature = "fixtures")]
        Name::FixtureClock => |cx, args| now::<call::FixtureClock>(cx, args, effects::clock),
        #[cfg(feature = "fixtures")]
        Name::FixtureRecords => |cx, args| now::<call::FixtureRecords>(cx, args, records::fixture),
        #[cfg(not(feature = "fixtures"))]
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

/// Runs a handler that may answer later, as [`off_thread`] does.
fn later<C: Call>(
    cx: &mut Cx,
    args: Value,
    handler: fn(&mut Cx, C::Args) -> Option<Control>,
) -> Option<Control> {
    match C::args(args) {
        Ok(args) => handler(cx, args),
        Err(e) => Some(C::reply(cx.id, Err(e))),
    }
}

/// Folder checks running at once.
const CHECKS: usize = 4;

/// Answers a call that needs the file system: `look` runs on a short-lived
/// thread, since a folder on a stalled network mount blocks for as long as
/// the system lets it, and `then` answers on the core's thread once it
/// reports. With [`CHECKS`] running, the call is refused.
fn off_thread<C: Call, T: Send + 'static>(
    cx: &mut Cx,
    look: impl FnOnce() -> T + Send + 'static,
    then: impl FnOnce(&mut Core, T) -> Result<C::Result, Error> + 'static,
) -> Option<Control> {
    if cx.core.checks == CHECKS {
        let busy = Error::new(Code::Failed, "too many checks are running");
        return Some(C::reply(cx.id, Err(busy)));
    }
    cx.core.checks += 1;
    #[cfg(feature = "fixtures")]
    let slow = cx.core.fixture_check;
    let (found, report) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        #[cfg(feature = "fixtures")]
        std::thread::sleep(slow);
        let _ = found.send(look());
    });
    let (core, link, id) = (cx.core.me.clone(), cx.link.clone(), cx.id);
    tokio::task::spawn_local(async move {
        let found = report.await;
        let Some(core) = core.upgrade() else { return };
        let mut core = core.borrow_mut();
        core.checks -= 1;
        let lost = |_| Error::new(Code::Failed, "the folder check ended without an answer");
        let result = found.map_err(lost).and_then(|found| then(&mut core, found));
        link.send(&C::reply(id, result));
    });
    None
}

/// `thought.capture`, naming the agent a new run of the thought would use:
/// the one the capture names, else the one `fixture.script` names in a
/// fixtures build, else the `agent` preference, else the registry's first.
/// A preference naming an agent this build lacks is passed over.
fn capture(cx: &mut Cx, capture: tasktap_proto::Capture) -> Result<(), Error> {
    let invalid = |why: String| Error::new(Code::Invalid, why);
    if let Some(name) = &capture.agent {
        crate::agents::find(name)
            .ok_or_else(|| invalid(format!("this core has no agent {name}")))?;
    }
    if let Some(model) = &capture.model {
        // As 1.2 checked a model: a word an agent takes as its value, never as a flag.
        let fits = !model.is_empty() && model.len() <= 250 && !model.starts_with('-');
        if !fits || model.chars().any(char::is_control) {
            return Err(invalid(
                "a model is 1 to 250 characters, none a control, not starting with -".into(),
            ));
        }
    }
    let pref = effects::read(cx.core, |tx| tx.pref(PrefKey::Agent))
        .ok()
        .flatten();
    let preferred = match pref.map(|p| p.value) {
        Some(PrefValue::Agent(Some(name))) if crate::agents::find(&name).is_some() => Some(name),
        _ => None,
    };
    let agent = (capture.agent.clone())
        .or_else(|| cx.core.seams.agent())
        .or(preferred)
        .unwrap_or_else(|| crate::agents::all()[0].id().into());
    effects::call(
        cx.core,
        "thought.capture",
        Event::Capture { capture, agent },
    )
}

fn event<C: Call<Result = ()>>(
    cx: &mut Cx,
    args: Value,
    event: fn(C::Args) -> Event,
) -> Option<Control> {
    let name = C::NAME.as_str();
    let result = C::args(args).and_then(|args| effects::call(cx.core, name, event(args)));
    Some(C::reply(cx.id, result))
}

fn status(cx: &mut Cx, _: Empty) -> Result<CoreStatus, Error> {
    Ok(CoreStatus {
        build: BUILD.to_owned(),
        v: SUPPORTED,
        terminals: cx.core.terminals(),
    })
}

/// `now` stops the terminals and exits once the reply is written; `idle`
/// once no terminal is alive, whoever is connected (design §3).
fn retire(cx: &mut Cx, args: Retire) -> Result<(), Error> {
    if cx.core.retire != Some(When::Now) {
        cx.core.retire = Some(args.when);
    }
    questions::refresh(cx.core);
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

/// `project.add`: the project that holds the folder, added now unless one
/// does already. The client's id makes it idempotent: the same id for
/// another folder is `conflict`.
fn add_project(cx: &mut Cx, args: AddProject) -> Option<Control> {
    let folder = args.folder.clone();
    let look = move || {
        let path = std::fs::canonicalize(folder)
            .ok()
            .filter(|path| path.is_dir());
        let git = path.as_ref().is_some_and(|path| path.join(".git").exists());
        (path, git)
    };
    off_thread::<call::ProjectAdd, _>(cx, look, |core, found| add_found(core, args, found))
}

/// Adds the project once its folder was looked at.
fn add_found(
    core: &mut Core,
    args: AddProject,
    (path, git): (Option<PathBuf>, bool),
) -> Result<ProjectId, Error> {
    let invalid = |why: String| Error::new(Code::Invalid, why);
    let path = path.ok_or_else(|| invalid(format!("{} is not a folder", args.folder)))?;
    let folder = (path.to_str())
        .ok_or_else(|| invalid("the folder's path is not text".into()))?
        .to_owned();
    // Its canonical form may be longer than what was given.
    if json_len(&folder) > MAX_LINE {
        return Err(invalid(format!(
            "{folder} is a longer path than a project takes"
        )));
    }
    let name = (args.name.clone())
        .or_else(|| Some(path.file_name()?.to_string_lossy().into_owned()))
        .unwrap_or_else(|| folder.clone());
    let now = core.seams.now();
    effects::write(core, |tx| {
        // The id first: the same id with other arguments is a conflict even
        // when another project holds the folder.
        let kind = AttemptKind::Project(args.id);
        match state::create(tx, now, kind, &args) {
            Ok(None) => {}
            Ok(Some(record)) => tx.insert_attempt(&record).map_err(stored)?,
            Err(state::Error::Store(e)) => return Err(stored(e)),
            Err(e) => return Err(Error::new(Code::Conflict, e.to_string())),
        }
        // A project made otherwise, such as the scratch, keeps its folder.
        match tx.project(args.id).map_err(stored)? {
            Some(p) if p.folder == folder => return reopen(tx, p),
            Some(_) => {
                let why = "the project id was used for another folder";
                return Err(Error::new(Code::Conflict, why));
            }
            None => {}
        }
        if let Some(p) = tx.project_by_folder(&folder).map_err(stored)? {
            return reopen(tx, p);
        }
        let project = Project {
            id: args.id,
            rev: Rev::ZERO,
            name,
            folder,
            kind: ProjectKind::Folder,
            color: String::new(),
            aliases: Vec::new(),
            git,
            isolate: Isolate::Busy,
            open: true,
            available: true,
        };
        tx.insert_project(&project).map_err(stored)?;
        Ok(args.id)
    })
}

/// Adding a project closed with `project.close` opens it again.
fn reopen(tx: &mut crate::store::Tx, mut p: Project) -> Result<ProjectId, Error> {
    if !p.open {
        p.open = true;
        tx.update_project(&p).map_err(stored)?;
    }
    Ok(p.id)
}

/// `agents.detect`: each agent asked for, or every one, as its own commands
/// find it, each agent on a thread of its own.
fn detect(cx: &mut Cx, args: DetectAgents) -> Option<Control> {
    let all = crate::agents::all();
    let asked: Vec<_> = match &args.agents {
        None => all.to_vec(),
        Some(names) => {
            let found: Option<Vec<_>> = names.iter().map(|n| crate::agents::find(n)).collect();
            let Some(found) = found else {
                let e = Error::new(
                    Code::Invalid,
                    "agents.detect names an agent this core lacks",
                );
                return Some(call::AgentsDetect::reply(cx.id, Err(e)));
            };
            found
        }
    };
    let look = move || {
        std::thread::scope(|scope| {
            let checks: Vec<_> = (asked.iter())
                .map(|agent| scope.spawn(|| crate::agents::checks::detect(*agent)))
                .collect();
            let found = checks.into_iter().filter_map(|c| c.join().ok());
            found.collect::<Vec<_>>()
        })
    };
    off_thread::<call::AgentsDetect, _>(cx, look, |_, agents| Ok(Agents { agents }))
}

/// `project.scan`: whether each project's folder is still there, and still
/// a git repository. Projects are looked at when a client asks, never watched.
fn scan_projects(cx: &mut Cx, _: Empty) -> Option<Control> {
    let live = effects::read(cx.core, |tx| tx.live(Collection::Projects));
    let folders: Vec<_> = match live {
        Ok(Some(Set::Projects(rows))) => rows.put.into_iter().map(|p| (p.id, p.folder)).collect(),
        Ok(_) => Vec::new(),
        Err(e) => return Some(call::ProjectScan::reply(cx.id, Err(e))),
    };
    let look = move || {
        let found = folders.into_iter().map(|(id, folder)| {
            let folder = Path::new(&folder);
            (id, (folder.is_dir(), folder.join(".git").exists()))
        });
        found.collect::<Vec<_>>()
    };
    off_thread::<call::ProjectScan, _>(cx, look, |core, found| {
        effects::write(core, |tx| {
            for (id, now) in found {
                let Some(mut p) = tx.project(id).map_err(stored)? else {
                    continue;
                };
                if (p.available, p.git) != now {
                    (p.available, p.git) = now;
                    tx.update_project(&p).map_err(stored)?;
                }
            }
            Ok(())
        })
    })
}
