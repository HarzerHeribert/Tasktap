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
        Name::ThoughtSettle => effects::settle_call,
        Name::ThoughtChanges => |cx, args| later::<call::ThoughtChanges>(cx, args, changes),
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

/// Who may make a call: who its access names, except that with no shared
/// version the bootstrap calls are anyone's (`bootstrap.rs`).
fn permitted(name: Name, peer: &Peer) -> bool {
    name.access().permits(peer.who.identity())
        || (peer.v == NO_SHARED_VERSION && BOOTSTRAP.contains(&name))
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
        Some(n) if !permitted(n, &peer) => Some(refuse(
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
    let (link, id) = (cx.link.clone(), cx.id);
    aside(cx.core, look, move |core, found| {
        core.checks -= 1;
        let lost = || Error::new(Code::Failed, "the folder check ended without an answer");
        let result = found.ok_or_else(lost).and_then(|found| then(core, found));
        link.send(&C::reply(id, result));
    });
    None
}

/// Runs `work` on a short-lived thread, since the file system may block
/// for as long as the system lets it (a stalled network mount), and then
/// `then` on the core's thread with what it returned, or with nothing when
/// the thread ended without an answer. The folder checks, a launch's search
/// for its program and the saving of a terminal's history run so. In a
/// build with the test fixtures `--check-ms` has each wait first.
pub fn aside<T: Send + 'static>(
    core: &Core,
    work: impl FnOnce() -> T + Send + 'static,
    then: impl FnOnce(&mut Core, Option<T>) + 'static,
) {
    #[cfg(feature = "fixtures")]
    let slow = core.fixture_check;
    let (found, report) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        #[cfg(feature = "fixtures")]
        std::thread::sleep(slow);
        let _ = found.send(work());
    });
    let me = core.me.clone();
    tokio::task::spawn_local(async move {
        let found = report.await.ok();
        let Some(core) = me.upgrade() else { return };
        then(&mut core.borrow_mut(), found);
    });
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

/// Diffs held by open `thought.changes` streams at once, each at most
/// `MAX_DIFF` bytes: what they may hold together is bounded.
const DIFFS: usize = 4;

/// `thought.changes`: the changes of a thought's worktree not settled yet,
/// read off the core's thread as a folder check is: the files in the reply,
/// as many as fit it, and the diff as a stream.
fn changes(cx: &mut Cx, args: tasktap_proto::ReadChanges) -> Option<Control> {
    let found = effects::read(cx.core, |tx| {
        let Some(t) = tx.thought(args.id)? else {
            return Ok(None);
        };
        let open = |w: &tasktap_proto::Workdir| {
            matches!(
                w.changes,
                tasktap_proto::Changes::Clean | tasktap_proto::Changes::Pending
            )
        };
        let project = t.project_id.map(|p| tx.project(p)).transpose()?.flatten();
        Ok(project.zip(t.workdir.filter(open)))
    });
    let (project, workdir) = match found {
        Ok(Some(found)) => found,
        Ok(None) => {
            let gone = "the thought has no worktree, or its changes were kept or discarded";
            return Some(call::ThoughtChanges::reply(
                cx.id,
                Err(Error::new(Code::Gone, gone)),
            ));
        }
        Err(e) => return Some(call::ThoughtChanges::reply(cx.id, Err(e))),
    };
    if cx.core.diffs.get() >= DIFFS {
        let busy = Error::new(
            Code::Failed,
            "too many diffs are being sent; try again soon",
        );
        return Some(call::ThoughtChanges::reply(cx.id, Err(busy)));
    }
    let data = cx.core.terminals.data().to_owned();
    let repo = PathBuf::from(project.folder);
    let (link, path, credit) = (cx.link.clone(), args.path, args.credit);
    let only = path.clone();
    let look = move || {
        let git = crate::isolate::Git::new(&data, Vec::new())?;
        git.list(&repo, &workdir, Some(only.as_deref()))
    };
    off_thread::<call::ThoughtChanges, _>(cx, look, move |core, listed| {
        let listed = listed.map_err(|e| Error::new(Code::Failed, e))?;
        let cut = listed.size > listed.diff.len() as u64;
        let mut files = listed.files;
        let mut room = MAX_LINE * 32;
        let fit = files.iter().take_while(|f| {
            room = room.saturating_sub(json_len(f));
            room > 0
        });
        let fit = fit.count();
        let more = (files.len() - fit) as u32;
        files.truncate(fit);
        let stream = crate::stream::bytes(&link, credit, listed.diff, &core.diffs)?;
        Ok(tasktap_proto::Diff {
            stream,
            files,
            more,
            size: listed.size,
            cut,
        })
    })
}

/// `agents.detect`: each agent asked for, or every one, as its own commands
/// find it, each agent on a thread of its own. What it finds goes to the
/// `agents` collection too, and the reply is those rows.
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
    let look = move || crate::agents::checks::detect_all(&asked);
    off_thread::<call::AgentsDetect, _>(cx, look, |core, found| {
        let agents = core.set_agents(found).map_err(effects::stored)?;
        Ok(Agents { agents })
    })
}

/// Detects the agents once as the core starts, off its thread, so the
/// `agents` collection is filled before a page asks (design §7). It keeps
/// nothing alive: a core that idles out meanwhile ends without the rows.
pub fn detect_at_start(core: &Core) {
    let agents = crate::agents::at_start();
    if agents.is_empty() {
        return;
    }
    let look = move || crate::agents::checks::detect_all(&agents);
    aside(core, look, |core, found| {
        // Memory only: a revision not taken leaves the collection as it was.
        let _ = core.set_agents(found.unwrap_or_default());
    });
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
