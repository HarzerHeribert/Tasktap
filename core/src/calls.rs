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
        Name::ThoughtCapture => {
            |cx, args| now::<call::ThoughtCapture>(cx, args, |cx, c| capture(cx.core, c))
        }
        Name::ThoughtUpdate => |cx, args| now::<call::ThoughtUpdate>(cx, args, update),
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
        Name::RouteTerms => |cx, args| now::<call::RouteTerms>(cx, args, crate::route::terms),
        Name::AgentsDetect => |cx, args| later::<call::AgentsDetect>(cx, args, detect),
        // The core makes this call; it never answers it.
        Name::ShimHold | Name::HostNotify => return None,
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
        Name::DictationStart => {
            |cx, args| now::<call::DictationStart>(cx, args, crate::speech::start)
        }
        Name::DictationReport => {
            |cx, args| now::<call::DictationReport>(cx, args, crate::speech::report)
        }
        Name::DictationFinish => {
            |cx, args| now::<call::DictationFinish>(cx, args, crate::speech::finish)
        }
        Name::DictationCancel => {
            |cx, args| now::<call::DictationCancel>(cx, args, crate::speech::cancel)
        }
        Name::SpeechTerms => |cx, args| now::<call::SpeechTerms>(cx, args, crate::speech::terms),
        Name::KeySet => |cx, args| later::<call::KeySet>(cx, args, crate::speech::set_key),
        Name::KeyRemove => |cx, args| later::<call::KeyRemove>(cx, args, crate::speech::remove_key),
        Name::ProjectAdd => |cx, args| later::<call::ProjectAdd>(cx, args, add_project),
        Name::ProjectScan => |cx, args| later::<call::ProjectScan>(cx, args, scan_projects),
        Name::ProjectClose => {
            |cx, args| now::<call::ProjectClose>(cx, args, terminal::close_project)
        }
        Name::LookAdd => |cx, args| later::<call::LookAdd>(cx, args, crate::map::add_look),
        Name::ProjectsOffer => |cx, args| later::<call::ProjectsOffer>(cx, args, crate::map::offer),
        Name::ProjectsLook => {
            |cx, args| later::<call::ProjectsLook>(cx, args, crate::map::look_call)
        }
        Name::ProjectsFind => |cx, args| now::<call::ProjectsFind>(cx, args, crate::map::find),
        Name::TerminalOpen => |cx, args| now::<call::TerminalOpen>(cx, args, terminal::open),
        Name::TerminalResize => |cx, args| now::<call::TerminalResize>(cx, args, terminal::resize),
        Name::TerminalStop => |cx, args| now::<call::TerminalStop>(cx, args, terminal::stop_call),
        Name::TerminalRuns => |cx, args| now::<call::TerminalRuns>(cx, args, terminal::runs_call),
        Name::FileRead => |cx, args| later::<call::FileRead>(cx, args, read_file),
        Name::PreviewOpen => |cx, args| later::<call::PreviewOpen>(cx, args, open_preview),
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
/// A preference naming an agent this build lacks is passed over. A
/// dictation's transcript is captured here too (design §8).
pub fn capture(core: &mut Core, capture: tasktap_proto::Capture) -> Result<(), Error> {
    check(core, &capture)?;
    let pref = effects::read(core, |tx| tx.pref(PrefKey::Agent))
        .ok()
        .flatten();
    let preferred = match pref.map(|p| p.value) {
        Some(PrefValue::Agent(Some(name))) if crate::agents::live(&name).is_some() => Some(name),
        _ => None,
    };
    let agent = (capture.agent.clone())
        .or_else(|| core.seams.agent())
        .or(preferred)
        .unwrap_or_else(|| crate::agents::all()[0].id().into());
    look(core, &agent);
    let captured = effects::call(core, "thought.capture", Event::Capture { capture, agent });
    // What is kept placed it; whether a look is due is found out after (map.rs).
    crate::map::freshen(core);
    captured
}

/// Whether a capture names an agent this core has, which is neither
/// missing nor signed out as far as detection knows, and a model an agent
/// can be given. The agent a capture names is the one that runs it or
/// nobody: it is refused here rather than run by another.
pub fn check(core: &Core, capture: &tasktap_proto::Capture) -> Result<(), Error> {
    let invalid = |why: String| Error::new(Code::Invalid, why);
    if let Some(name) = &capture.agent {
        let agent = crate::agents::find(name)
            .ok_or_else(|| invalid(format!("Tasktap has no agent {name}")))?;
        // A follow-up keeps its session's agent, whatever the capture names.
        if capture.session_id.is_none() {
            crate::agents::usable(agent, core.detected(name))
                .map_err(|why| Error::new(Code::Failed, why))?;
        }
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
    Ok(())
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

/// `thought.update`: sends a thought to a workspace, or to a project
/// Tasktap knows that opens when the thought starts there.
fn update(cx: &mut Cx, a: tasktap_proto::Assign) -> Result<(), Error> {
    let to = match (a.project_id, a.card_id) {
        (Some(project), None) => Destination::New(project),
        (None, Some(card)) => Destination::Card(card),
        _ => {
            let why = "a task goes to one project: a workspace or a project Tasktap knows";
            return Err(Error::new(Code::Invalid, why));
        }
    };
    let pick = Event::Pick { thought: a.id, to };
    effects::call(cx.core, "thought.update", pick)
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
        // The folder as a person knows it: canonical, and on Windows without
        // the `\\?\` a canonical path begins with there, which no person
        // types and few programs take. It is the path the pages show, the
        // one a terminal starts in and the one agents are told.
        let path = std::fs::canonicalize(folder)
            .ok()
            .filter(|path| path.is_dir())
            .map(crate::terminal::folder);
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
            "{folder} is a longer path than a folder may have"
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
                let why = "the id was used for another folder";
                return Err(Error::new(Code::Conflict, why));
            }
            None => {}
        }
        if let Some(p) = tx.project_by_folder(&folder).map_err(stored)? {
            return reopen(tx, p);
        }
        // Where its agent works, as the person chose it for the folder in
        // Settings › Projects before it was opened.
        let card = tx.card_by_folder(&folder).map_err(stored)?;
        let project = Project {
            id: args.id,
            rev: Rev::ZERO,
            name,
            folder,
            kind: ProjectKind::Folder,
            color: String::new(),
            aliases: Vec::new(),
            git,
            isolate: card.map_or(Isolate::Busy, |c| c.isolate),
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
            let gone = "the task has no copy, or its changes were kept or discarded";
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

/// Files `file.read` holds at once, each at most `MAX_FILE` bytes: those
/// being read and those a stream still has to send.
const FILES: usize = 4;

/// Where Tasktap reads files, shows them and opens them: the folders the
/// person opened, and the copies Tasktap made of them for its runs.
fn roots(core: &mut Core) -> Result<Vec<PathBuf>, Error> {
    let folders = effects::read(core, |tx| tx.folders())?;
    let mut roots: Vec<PathBuf> = folders.into_iter().map(PathBuf::from).collect();
    roots.push(core.terminals.data().join(crate::isolate::FOLDER));
    Ok(roots)
}

/// `file.read`: a file's bytes as a stream, read off the core's thread as
/// a folder check is, under the one rule of what may be read (design §12).
fn read_file(cx: &mut Cx, args: tasktap_proto::ReadFile) -> Option<Control> {
    let refuse = |e| Some(call::FileRead::reply(cx.id, Err(e)));
    if cx.core.files.get() >= FILES {
        let busy = "too many files are being sent; try again soon";
        return refuse(Error::new(Code::Failed, busy));
    }
    let roots = match roots(cx.core) {
        Ok(roots) => roots,
        Err(e) => return refuse(e),
    };
    let files = cx.core.files.clone();
    files.set(files.get() + 1);
    let (link, credit) = (cx.link.clone(), args.credit);
    let look = move || crate::files::read(&args.path, &roots, args.unless.as_deref());
    let refused = off_thread::<call::FileRead, _>(cx, look, move |core, found| {
        // The read is over: from here its stream counts what it holds.
        core.files.set(core.files.get() - 1);
        let found = found?;
        let bytes = |bytes| crate::stream::bytes(&link, credit, bytes, &core.files);
        Ok(tasktap_proto::FileRead {
            stream: found.bytes.map(bytes).transpose()?,
            size: found.size,
            kind: found.kind,
            encoding: found.encoding,
            cut: found.cut,
            stamp: found.stamp,
        })
    });
    // Nothing was read: too many checks were running.
    if refused.is_some() {
        files.set(files.get() - 1);
    }
    refused
}

/// `preview.open`: a file or a web address of this machine shown beside
/// a terminal, the device's choice or the agent's own. What may be shown
/// is decided here, never by the caller: a web address only when it is
/// this machine's, a path only when it is a file inside a folder the
/// person opened (design §12).
fn open_preview(cx: &mut Cx, args: tasktap_proto::OpenPreview) -> Option<Control> {
    use tasktap_proto::{PreviewBy, PreviewKind, Web};
    let refuse =
        |code, why: &str| Some(call::PreviewOpen::reply(cx.id, Err(Error::new(code, why))));
    let (terminal, by) = match (cx.who, args.terminal) {
        (Caller::Session(own), None) => (own, PreviewBy::Agent),
        (Caller::Session(own), Some(named)) if named == own => (own, PreviewBy::Agent),
        (Caller::Session(_), Some(_)) => {
            let why = "an agent shows a preview beside its own terminal only";
            return refuse(Code::Denied, why);
        }
        (_, Some(named)) => (named, PreviewBy::Person),
        (_, None) => {
            let why = "preview.open needs the terminal the preview is shown beside";
            return refuse(Code::Invalid, why);
        }
    };
    let target = args.target;
    match tasktap_proto::web(&target) {
        Web::No => {}
        Web::Local => {
            // Its host and port: what stands between the scheme and the path.
            let from = target.find("://").map_or(0, |at| at + 3);
            let title = target[from..]
                .split(['/', '?', '#'])
                .next()
                .unwrap_or_default();
            let shown = (PreviewKind::Web, target.clone(), title.to_owned());
            let opened = opened(cx.core, terminal, shown, by);
            return Some(call::PreviewOpen::reply(cx.id, opened));
        }
        Web::Remote => {
            let why =
                "A preview shows web addresses of this machine only: this one opens in the browser";
            return refuse(Code::Invalid, why);
        }
        Web::Broken => return refuse(Code::Invalid, "That is not a web address Tasktap can show"),
    }
    let found = effects::read(cx.core, |tx| tx.terminal(terminal));
    let cwd = match found {
        Ok(Some(t)) => args.cwd.unwrap_or(t.cwd),
        Ok(None) => return refuse(Code::Gone, "no such terminal"),
        Err(e) => return Some(call::PreviewOpen::reply(cx.id, Err(e))),
    };
    let roots = match roots(cx.core) {
        Ok(roots) => roots,
        Err(e) => return Some(call::PreviewOpen::reply(cx.id, Err(e))),
    };
    let look = move || crate::files::resolve(&target, Some(&cwd), &roots);
    off_thread::<call::PreviewOpen, _>(cx, look, move |core, found| {
        let path = found?;
        let text = |path: &std::ffi::OsStr| path.to_str().map(str::to_owned);
        let named = text(path.as_os_str()).zip(path.file_name().and_then(text));
        let (target, title) =
            named.ok_or_else(|| Error::new(Code::Invalid, "the file's path is not text"))?;
        opened(core, terminal, (PreviewKind::File, target, title), by)
    })
}

/// Writes the preview once its target is one that may be shown.
fn opened(
    core: &mut Core,
    terminal: TerminalId,
    shown: (tasktap_proto::PreviewKind, String, String),
    by: tasktap_proto::PreviewBy,
) -> Result<tasktap_proto::PreviewId, Error> {
    let now = core.seams.now();
    effects::write(core, |tx| {
        state::preview(tx, now, terminal, shown, by).map_err(|e| match e {
            state::Error::Store(e) => stored(e),
            state::Error::Gone => Error::new(Code::Gone, "no such terminal"),
            state::Error::Conflict(why) => Error::new(Code::Conflict, why),
            e => Error::new(Code::Failed, e.to_string()),
        })
    })
}

/// `agents.detect`: each agent asked for, or every one, as its own commands
/// find it, each agent on a thread of its own; with `unchecked`, only those
/// whose commands this core has not run yet. What it finds goes to the
/// `agents` collection, and the reply is the rows of the agents asked for.
fn detect(cx: &mut Cx, args: DetectAgents) -> Option<Control> {
    let all = crate::agents::all();
    let named: Vec<_> = match &args.agents {
        // Those it lists: in a build with the test fixtures not the real ones.
        None => crate::agents::at_start(),
        Some(names) => {
            let found: Option<Vec<_>> = names.iter().map(|n| crate::agents::live(n)).collect();
            let Some(found) = found else {
                let e = Error::new(
                    Code::Invalid,
                    "agents.detect names an agent Tasktap does not have",
                );
                return Some(call::AgentsDetect::reply(cx.id, Err(e)));
            };
            found
        }
    };
    let looked = &mut cx.core.looked;
    let mut asked = named.clone();
    asked.retain(|a| !(args.unchecked && looked.contains(&a.id())));
    looked.extend(asked.iter().map(|a| a.id()));
    let rows = move |core: &Core| -> Vec<_> {
        let named = |id: &str| named.iter().any(|a| a.id() == id);
        let rows = all.iter().filter_map(|a| core.detected(a.id()));
        rows.filter(|row| named(&row.id)).cloned().collect()
    };
    if asked.is_empty() {
        let agents = rows(cx.core);
        return Some(call::AgentsDetect::reply(cx.id, Ok(Agents { agents })));
    }
    let look = move || crate::agents::checks::detect_all(&asked);
    off_thread::<call::AgentsDetect, _>(cx, look, move |core, found| {
        core.set_agents(found).map_err(effects::stored)?;
        Ok(Agents { agents: rows(core) })
    })
}

/// Looks at an agent by its own commands the first time in this core's life
/// that it is given a thought, beside the run and not before it: what it
/// finds is for the next thought and for the person, who sees it in Settings.
fn look(core: &mut Core, agent: &str) {
    let own = crate::agents::at_start();
    let agent = own.into_iter().find(|a| a.id() == agent);
    let Some(agent) = agent.filter(|a| core.looks && !core.looked.contains(&a.id())) else {
        return;
    };
    core.looked.push(agent.id());
    let look = move || crate::agents::checks::detect(agent);
    aside(core, look, |core, found| {
        let _ = core.set_agents(found.into_iter().collect());
    });
}

/// Takes the agents the person added (the `own_agents` preference) as they
/// are now, when the core starts and when the preference changed, and then
/// lists them: whether each one's program is on the PATH, off this thread.
pub fn own_agents(core: &mut Core) {
    let kept = effects::read(core, |tx| tx.pref(tasktap_proto::PrefKey::OwnAgents));
    let own = match kept.ok().flatten().map(|pref| pref.value) {
        Some(PrefValue::OwnAgents(own)) => own,
        _ => Vec::new(),
    };
    // Checked when it was put: one a newer build refuses stays out.
    if crate::agents::set_own(&own).is_err() {
        return;
    }
    let own = crate::agents::all().into_iter().filter(|a| a.own());
    let own: Vec<_> = own.collect();
    let look = move || -> Vec<_> {
        own.iter()
            .map(|a| crate::agents::checks::found(*a))
            .collect()
    };
    aside(core, look, |core, found| {
        let _ = core.put_own_agents(found.unwrap_or_default());
    });
}

/// Lists the agents once as the core starts, off its thread, so the
/// `agents` collection is filled before a page asks (design §7): which are
/// installed, by their programs on the PATH, and what their own commands
/// said when a core last ran them. No program of theirs runs here. It keeps
/// nothing alive: a core that idles out meanwhile ends without the rows.
pub fn agents_at_start(core: &Core) {
    let agents = crate::agents::at_start();
    if agents.is_empty() {
        return;
    }
    let data = core.terminals.data().to_owned();
    let look = move || -> Vec<_> {
        use crate::agents::checks::{found, said};
        let said = said(&data);
        let row = |agent: &&'static dyn crate::agents::Agent| {
            let found = found(*agent);
            match said.iter().find(|said| said.id == found.id) {
                Some(said) => said.onto(found),
                None => found,
            }
        };
        agents.iter().map(row).collect()
    };
    // Memory only: a revision not taken leaves the collection as it was.
    aside(core, look, |core, found| {
        let _ = core.put_agents(found.unwrap_or_default(), false);
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
