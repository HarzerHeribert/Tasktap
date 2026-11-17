//! Agents a person started by hand in a Tasktap shell (design §4, §7), as the
//! core sees them; the shim itself is `roles::shim`.
//!
//! `session.adopt` makes such an agent a session of the shell's terminal. The
//! session belongs to the shim's connection: when that ends before the shim
//! reported the agent's exit, the session ends with it. A follow-up is typed
//! into that terminal only while the shim holds it (`shim.hold`): the shim has
//! confirmed its agent still runs in the foreground and keeps the terminal
//! until the text is written, so the text never reaches the shell beneath.

use std::rc::Rc;
use std::time::Duration;

use tasktap_proto::call::{self, Code, Error};
use tasktap_proto::{Adopt, Outcome, SessionId, ShimHold};

use crate::calls::{Caller, Cx};
use crate::conn::Link;
use crate::effects;
use crate::serve::Core;
use crate::state::{self, Deliver, Event};

/// Longest a shim may take to answer `shim.hold`.
const ANSWER: Duration = Duration::from_secs(5);

const UNHELD: &str = "the agent no longer runs in its shell, so the follow-up was not typed";

#[derive(Default)]
pub struct Shims {
    /// Each adopted session with the connection of the shim that adopted it.
    adopted: Vec<(SessionId, Rc<Link>)>,
    /// Set by `fixture.script`'s `pause`: follow-ups not typed yet, each
    /// with the shim that holds its terminal, if its session is adopted.
    #[cfg(feature = "fixtures")]
    paused: Option<Vec<(Deliver, Option<Rc<Link>>)>>,
}

/// `session.adopt`: a new session in the caller's shell, owned by this connection.
pub fn adopt(cx: &mut Cx, args: Adopt) -> Result<SessionId, Error> {
    let Caller::Session(terminal) = cx.who else {
        return Err(Error::new(Code::Denied, "only a shell's token adopts"));
    };
    let session = state::fresh(cx.core.seams.now()).map_err(effects::stored)?;
    let event = Event::Adopt {
        session,
        terminal,
        agent: args.agent,
        cwd: args.cwd,
    };
    if let Err(r) = effects::run(cx.core, event) {
        let why = effects::refusal("session.adopt", r);
        return Err(why.unwrap_or_else(|| Error::new(Code::Conflict, "session.adopt repeated")));
    }
    cx.core.shims.adopted.push((session, cx.link.clone()));
    Ok(session)
}

/// A connection ended: the sessions its shim adopted end with it. One whose
/// exit the shim reported has ended already, and this changes nothing.
pub fn left(core: &mut Core, link: &Rc<Link>) {
    let mut ended = Vec::new();
    core.shims.adopted.retain(|(session, l)| {
        let mine = Rc::ptr_eq(l, link);
        if mine {
            ended.push(*session);
        }
        !mine
    });
    for session in ended {
        let event = Event::Exited {
            session,
            code: None,
            silent: false,
        };
        let _ = effects::run(core, event);
    }
}

/// Takes a follow-up for an adopted session and types it once its shim holds
/// the terminal; reports a failure instead when it cannot hold it. Any other
/// follow-up is handed back for the launcher, unless paused.
pub fn deliver(core: &mut Core, d: Deliver) -> Option<Deliver> {
    let session = effects::read(core, |tx| tx.session(d.session));
    if !session.ok().flatten().is_some_and(|s| s.adopted) {
        #[cfg(feature = "fixtures")]
        if let Some(paused) = &mut core.shims.paused {
            paused.push((d, None));
            return None;
        }
        return Some(d);
    }
    let shim = core.shims.adopted.iter().find(|(session, link)| {
        *session == d.session && link.peer().is_some_and(|peer| peer.holds)
    });
    let Some(link) = shim.map(|(_, link)| link.clone()) else {
        effects::failed(core, d.attempt, UNHELD.into());
        return None;
    };
    let held = link.call::<call::ShimHold>(&ShimHold { hold: true });
    let me = core.me.clone();
    tokio::task::spawn_local(async move {
        let held = tokio::time::timeout(ANSWER, held).await;
        let Some(core) = me.upgrade() else { return };
        let mut core = core.borrow_mut();
        if !matches!(held, Ok(Ok(Outcome::Ok(_)))) {
            // A late yes must not keep the shim waiting for a release.
            link.call::<call::ShimHold>(&ShimHold { hold: false });
            effects::failed(&mut core, d.attempt, UNHELD.into());
            return;
        }
        #[cfg(feature = "fixtures")]
        if let Some(paused) = &mut core.shims.paused {
            paused.push((d, Some(link)));
            return;
        }
        type_held(&mut core, d, link);
    });
    None
}

/// Types a follow-up while its shim holds the terminal, and lets the shim
/// go once the text is written, or none of it is still to come.
fn type_held(core: &mut Core, d: Deliver, link: Rc<Link>) {
    let held = effects::Held {
        by: crate::launch::Holder(link.pid.get()),
        release: Box::new(move |_| {
            link.call::<call::ShimHold>(&ShimHold { hold: false });
        }),
    };
    effects::typed(core, d, Some(held));
}

/// `fixture.script`'s `pause`: follow-ups wait untyped until a script
/// without it, which has the launcher type each one, and one held by its
/// shim only while that shim is still connected. A shim that left gave up
/// the terminal, so its text is dropped.
#[cfg(feature = "fixtures")]
pub fn pause(core: &mut Core, pause: bool) {
    let waiting = core.shims.paused.take();
    if pause {
        core.shims.paused = Some(waiting.unwrap_or_default());
        return;
    }
    for (d, link) in waiting.unwrap_or_default() {
        match link {
            None => drop(effects::typed(core, d, None)),
            Some(link) if core.links.iter().any(|l| Rc::ptr_eq(l, &link)) => {
                type_held(core, d, link);
            }
            Some(_) => drop(effects::failed(core, d.attempt, UNHELD.into())),
        }
    }
}

/// The follow-ups waiting while paused.
#[cfg(feature = "fixtures")]
pub fn held(core: &Core) -> Vec<tasktap_proto::ThoughtId> {
    let paused = core.shims.paused.iter().flatten();
    paused.map(|(d, _)| d.thought).collect()
}

/// `serve --fixture-token`: the token of a shell terminal that has a record
/// and no process, so tests can adopt agents before the core runs shells.
#[cfg(feature = "fixtures")]
pub fn fixture_shell(
    store: &mut crate::store::Store,
    token: &tasktap_proto::Secret,
    now: tasktap_proto::Time,
) -> crate::store::Result<()> {
    use tasktap_proto::{Offset, Rev, Terminal, TerminalKind, TerminalState};
    let hash = crate::handshake::hash(token);
    let mut tx = store.begin()?;
    match tx.terminal_by_token(&hash)? {
        // Recovery marked it lost with the boot before.
        Some(mut shell) => {
            shell.state = TerminalState::Running;
            tx.update_terminal(&shell)?;
        }
        None => {
            let shell = Terminal {
                id: state::fresh(now)?,
                rev: Rev::ZERO,
                project_id: None,
                kind: TerminalKind::Shell,
                title: "shell".into(),
                cwd: String::new(),
                argv: Vec::new(),
                cols: 80,
                rows: 24,
                state: TerminalState::Running,
                exit: None,
                offset: Offset::ZERO,
            };
            tx.insert_terminal(&shell, Some(&hash))?;
        }
    }
    tx.commit().map(drop)
}
