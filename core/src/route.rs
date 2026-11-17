//! Routing (design §8): where a captured thought goes. This is the local
//! router the design names as the fallback: the words of the capture
//! matched against the names and aliases of the core's own projects and
//! sessions, with no model call. It routes every capture of a normal build
//! (a build with its test fixtures routes this way too until
//! `fixture.script` scripts another answer) and answers `route.hint`, the
//! destination chip shown while typing, with the same match and no effect.
//! Model-backed routing comes later behind the same seam
//! ([`state::Router`]) and takes the same [`Request`].
//!
//! The rules, simplest first (a destination the person picked never reaches
//! a router: the state machine routes it at capture):
//!
//! | The capture | Route |
//! | --- | --- |
//! | names one session, and no project but that session's | `clear`: a follow-up to it |
//! | names no session, was made in a current session, and names no project but that session's | `clear`: a follow-up to the current session |
//! | names one project and no session | `clear`: a new run in that project |
//! | names several projects or sessions | `ambiguous`: those are the choices |
//! | names nothing | `unknown`: it stays an idea |
//!
//! A name is named when it appears in the text as whole words, ignoring
//! case. The brief is the person's text unchanged.

use tasktap_proto::{Collection, Error, Hint, Place, ProjectId, SessionId, SessionState, Set};

use crate::calls::Cx;
use crate::effects;
use crate::state::{self, Candidate, Destination, Route};
use crate::store::{self, Tx};

/// What a router is asked: the capture and the destinations the core's own
/// records offer (design §8, `RouteRequest`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Request {
    pub text: String,
    /// The session the person was in when they captured.
    pub current: Option<SessionId>,
    /// Projects a run can start in: open, with their folder there.
    pub projects: Vec<Named>,
    /// Sessions a follow-up can go to, each in one of `projects`.
    pub sessions: Vec<Followed>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Named {
    pub id: ProjectId,
    pub name: String,
    pub aliases: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Followed {
    pub id: SessionId,
    pub name: Option<String>,
    pub project: ProjectId,
    /// What a choice says when the session has no name.
    pub label: String,
}

/// The local router, as a seam: [`local`].
pub struct Local;

impl state::Router for Local {
    fn route(&mut self, request: &Request) -> Route {
        local(request)
    }
}

/// The request for `text`, from the records live now.
pub fn request(tx: &Tx, text: &str, current: Option<SessionId>) -> store::Result<Request> {
    let projects = match tx.live(Collection::Projects)? {
        Some(Set::Projects(rows)) => rows.put,
        _ => Vec::new(),
    };
    let sessions = match tx.live(Collection::Sessions)? {
        Some(Set::Sessions(rows)) => rows.put,
        _ => Vec::new(),
    };
    let projects: Vec<_> = (projects.into_iter())
        .filter(|p| p.open && p.available)
        .collect();
    let followed = (sessions.into_iter())
        // A follow-up to an ended session resumes it, when its agent left a handle.
        .filter(|s| s.state != SessionState::Ended || s.resume.is_some())
        .filter_map(|s| {
            let project = projects.iter().find(|p| p.id == s.project_id)?;
            let label = format!("The {} session in {}", s.agent, project.name);
            Some(Followed {
                id: s.id,
                name: s.name,
                project: s.project_id,
                label,
            })
        })
        .collect();
    Ok(Request {
        text: text.to_owned(),
        current,
        projects: (projects.into_iter())
            .map(|p| Named {
                id: p.id,
                name: p.name,
                aliases: p.aliases,
            })
            .collect(),
        sessions: followed,
    })
}

/// The rules of the module's table, over `r` alone.
pub fn local(r: &Request) -> Route {
    let named: Vec<&Named> = (r.projects.iter())
        .filter(|p| {
            std::iter::once(&p.name)
                .chain(&p.aliases)
                .any(|n| mentions(&r.text, n))
        })
        .collect();
    let sessions: Vec<&Followed> = (r.sessions.iter())
        .filter(|s| s.name.as_deref().is_some_and(|n| mentions(&r.text, n)))
        .collect();
    let current = r
        .current
        .and_then(|id| r.sessions.iter().find(|s| s.id == id));
    // No project named, or only the one the session is in.
    let only_in = |project: ProjectId| named.iter().all(|p| p.id == project);
    let clear = |to| Route::Clear {
        to,
        brief: r.text.clone(),
    };
    match (sessions.as_slice(), current, named.as_slice()) {
        ([s], ..) if only_in(s.project) => clear(Destination::Session(s.id)),
        ([], Some(c), _) if only_in(c.project) => clear(Destination::Session(c.id)),
        ([], _, [p]) => clear(Destination::New(p.id)),
        _ => {
            let projects = named.iter().map(|p| Candidate {
                label: p.name.clone(),
                to: Destination::New(p.id),
            });
            let sessions = sessions.iter().map(|s| Candidate {
                label: s.name.clone().unwrap_or_else(|| s.label.clone()),
                to: Destination::Session(s.id),
            });
            let candidates: Vec<_> = projects.chain(sessions).collect();
            match candidates.len() {
                0 | 1 => Route::Unknown,
                _ => Route::Ambiguous {
                    prompt: "Where should this go?".into(),
                    candidates,
                },
            }
        }
    }
}

/// Whether `name` appears in `text` as whole words, ignoring case.
fn mentions(text: &str, name: &str) -> bool {
    let name = name.trim().to_lowercase();
    if name.is_empty() {
        return false;
    }
    let text = text.to_lowercase();
    let word = |c: char| c.is_alphanumeric() || c == '_';
    text.match_indices(&name).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + name.len()..].chars().next();
        !before.is_some_and(word) && !after.is_some_and(word)
    })
}

/// `route.hint`: the local match for a capture being typed. It stores
/// nothing and starts nothing.
pub fn hint(cx: &mut Cx, args: Hint) -> Result<tasktap_proto::Route, Error> {
    let request = effects::read(cx.core, |tx| request(tx, &args.text, args.current))?;
    Ok(wire(local(&request)))
}

/// A route as the protocol says it.
pub fn wire(route: Route) -> tasktap_proto::Route {
    let place = |to| match to {
        Destination::New(p) => Place::Project(p),
        Destination::Session(s) => Place::Session(s),
    };
    match route {
        Route::Clear { to, brief } => tasktap_proto::Route::Clear {
            to: place(to),
            brief,
        },
        Route::Ambiguous { prompt, candidates } => tasktap_proto::Route::Ambiguous {
            prompt,
            candidates: (candidates.into_iter())
                .map(|c| tasktap_proto::Candidate {
                    label: c.label,
                    to: place(c.to),
                })
                .collect(),
        },
        Route::Unknown => tasktap_proto::Route::Unknown,
    }
}

/// A route the protocol says, as the state machine takes it.
#[cfg(feature = "fixtures")]
pub fn unwire(route: tasktap_proto::Route) -> Route {
    let to = |place| match place {
        Place::Project(id) => Destination::New(id),
        Place::Session(id) => Destination::Session(id),
    };
    match route {
        tasktap_proto::Route::Clear { to: place, brief } => Route::Clear {
            to: to(place),
            brief,
        },
        tasktap_proto::Route::Ambiguous { prompt, candidates } => Route::Ambiguous {
            prompt,
            candidates: (candidates.into_iter())
                .map(|c| Candidate {
                    label: c.label,
                    to: to(c.to),
                })
                .collect(),
        },
        tasktap_proto::Route::Unknown => Route::Unknown,
    }
}
