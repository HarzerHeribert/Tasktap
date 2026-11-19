//! Routing (design §8): where a captured thought goes and the brief its
//! agent reads. Two routers answer the same [`Request`].
//!
//! The local router matches the words of the capture against the names and
//! aliases of the core's own projects and sessions, and of the projects
//! Tasktap knows that are not open (`map.rs`, its cards), with no model
//! call (`names.rs`: as written, joined, as speech writes them). It
//! answers `route.hint`, the destination chip shown while typing, routes
//! every capture until the person consents to a model and, after, every
//! capture it finds a place for (a model then only writes the brief of one
//! too long to go as it is), and is what a capture falls back to whenever
//! the model gives no answer the core accepts (a build with its test
//! fixtures has `fixture.script` script it).
//!
//! The model is the one behind the person's own agent, asked headless
//! (`agents::Headless`): one question, [`question`], carries the
//! [`INSTRUCTIONS`] and what the core's records offer, and its answer is
//! taken only as [`accept`] allows. Nothing here runs a tool or waits:
//! `effects.rs` runs the tool off the core's thread, and `state.rs` holds
//! the rules of when a thought is asked about and when it launches.
//!
//! The rules, simplest first (a destination the person picked never reaches
//! a router: the state machine routes it at capture):
//!
//! | The capture | Route |
//! | --- | --- |
//! | names one session, and no project but that session's | `clear`: a follow-up to it |
//! | names no session, was made in a current session, and names no project but that session's | `clear`: a follow-up to the current session |
//! | names one project and no session | `clear`: a new run in that project, opened there if it is a known project and not a workspace |
//! | names several projects or sessions, or one name two projects have, or a name one letter off | `ambiguous`: those are the choices, at most three |
//! | names nothing, and projects are known | `ambiguous`: at most three, those whose line about them shares the rarest words first, then where the last thought went, then the most recently worked on |
//! | names nothing, and no project is known | `unknown`: it stays an idea |
//!
//! A name is said as `names.rs` finds it. Where one project's name is said
//! inside a longer name of another ("tidepool" in "tidepool mobile"), the
//! longer is meant; two said alike are a choice. A name said as written
//! or joined outweighs one said only as it sounds, which outweighs one a
//! letter off. How recently a project was worked on orders the choices and
//! never decides alone. Scratch is never offered: a thought goes there
//! only when the person picks it. The brief is the person's text unchanged.
//!
//! What the core enforces on a model's answer, whatever the instructions
//! made of it ([`accept`]); an answer that breaks a rule is not used at
//! all, and the local router's is:
//!
//! | Rule | Otherwise |
//! | --- | --- |
//! | at most 64 KiB, the one JSON object of [`SCHEMA`] with no other field | rejected |
//! | a destination and every choice is a key the request offered | rejected |
//! | a follow-up to a session other than the current one quotes at least 3 characters found word for word in the capture | rejected |
//! | `ambiguous` names at least two different choices | rejected |
//! | a brief is there, and no longer than twice the capture and 400 characters | rejected |
//! | a title is one line of at most 60 characters | it has none |
//! | the person picked the destination | only the brief and the title are taken |

use std::collections::BTreeMap;
use std::ops::Range;

use serde_json::{Value, json};
use tasktap_proto::{
    Collection, Error, Hint, ProjectId, ProjectKind, RouteBy, RouteTerms, Routing, SessionId,
    SessionState, Set, Status, ThoughtId, Time,
};

use crate::agents::{self, Agent, Headless};
use crate::calls::Cx;
use crate::effects;
use crate::state::{self, Candidate, Destination, Route};
use crate::store::{self, Tx};

mod names;
pub use names::{How, parts, sound};
use names::{Said, Words, said, words as name_words};

/// What a model is told with every thought, in full: the person reads it
/// before they consent (`route.terms`).
pub const INSTRUCTIONS: &str = include_str!("route/instructions.md");

/// The JSON schema of a model's answer, which its tool holds it to. Every
/// field is required and none may be added, as the strictest of the tools
/// wants a schema; an empty text or list says there is none. The fields
/// come in the order a model should write them: its evidence first, its
/// brief last.
pub const SCHEMA: &str = concat!(
    r#"{"type":"object","additionalProperties":false,"#,
    r#""required":["quote","confidence","to","candidates","brief","title"],"#,
    r#""properties":{"quote":{"type":"string"},"#,
    r#""confidence":{"type":"string","enum":["clear","ambiguous","unknown"]},"#,
    r#""to":{"type":"string"},"candidates":{"type":"array","items":{"type":"string"}},"#,
    r#""brief":{"type":"string"},"title":{"type":"string"}}}"#,
);

/// What routing by a model sends, as `route.terms` lists it.
const SENDS: &[&str] = &[
    "the thought, as you said or typed it",
    "of up to 8 of your projects, those this Mac ranks likeliest: the name, the other names it goes by and one line about it",
    "of up to 8 sessions in them: the name, the last request (180 characters), the agent and whether it is working",
    "of up to 3 recent exchanges: the request (320 characters), how it ended and the first line of the result (160 characters)",
];

/// The version of what is sent, which a consent names (`RouteBy::terms`):
/// 2 since a model is given a line about each project, and projects that
/// are not open. A consent to another version covers nothing.
pub const TERMS: u32 = 2;

/// Most projects, sessions and recent exchanges a model is given (design §8).
const OFFERED: usize = 8;
/// Most choices a question of where a thought goes has (the owner's
/// decision of 2026-11-19), beside "Another project…" and "Keep for later".
pub const CHOICES: usize = 3;
const RECENT: usize = 3;
/// Most characters of a title a model gives the work.
const MAX_TITLE: usize = 60;
/// Most characters of a thought a model is asked about.
const MAX_THOUGHT: usize = 8000;
/// Most characters of a thought that goes to a destination the person
/// picked, or that the local router is sure of, as it is: no brief is
/// written for it.
const SHORT: usize = 160;

/// What a router is asked: the capture and the destinations the core's own
/// records offer (design §8, `RouteRequest`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Request {
    pub text: String,
    /// The session the person was in when they captured.
    pub current: Option<SessionId>,
    /// The destination the person picked themselves: only the brief is open.
    pub picked: Option<Destination>,
    /// Projects a run can start in: open, with their folder there, and
    /// never Scratch, which only the person picks.
    pub projects: Vec<Named>,
    /// Sessions a follow-up can go to, each in one of `projects`.
    pub sessions: Vec<Followed>,
    /// The latest exchanges with those sessions, newest first; only a
    /// model is given them ([`narrow`]).
    pub recent: Vec<Exchange>,
    /// Where the newest thought that has a place went.
    pub last: Option<Destination>,
}

/// A project a thought can go to: a workspace (`Destination::New`), or a
/// project Tasktap knows that is not open (`Destination::Card`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Named {
    pub to: Destination,
    pub name: String,
    /// The other names it goes by: the person's, and its package file's.
    pub aliases: Vec<String>,
    /// One line about it, from its README or package file; or empty.
    pub about: String,
    pub folder: String,
    /// When work last happened there, as far as Tasktap knows.
    pub used: Option<Time>,
}

impl Named {
    /// A workspace with no card: its name and aliases alone.
    pub fn open(id: ProjectId, name: &str, aliases: &[&str]) -> Named {
        Named {
            to: Destination::New(id),
            name: name.into(),
            aliases: aliases.iter().map(|a| (*a).into()).collect(),
            about: String::new(),
            folder: String::new(),
            used: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Followed {
    pub id: SessionId,
    pub name: Option<String>,
    pub project: ProjectId,
    /// What a choice says when the session has no name.
    pub label: String,
    pub agent: String,
    pub state: SessionState,
    /// The thought of its current turn, whose text is its `task`.
    pub thought: Option<ThoughtId>,
    /// The last request it got; only a model is given it ([`narrow`]).
    pub task: String,
}

/// One recent exchange with a session: what was asked and how it ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Exchange {
    pub session: SessionId,
    pub request: String,
    pub status: Status,
    pub result: String,
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
    let cards = tx.cards()?;
    let started = tx.last_started()?;
    let last = tx
        .last_placed()?
        .and_then(|t| match (t.project_id, t.card_id) {
            (Some(p), _) => Some(Destination::New(p)),
            (None, Some(c)) => Some(Destination::Card(c)),
            _ => None,
        });
    let (projects, scratch): (Vec<_>, Vec<_>) = (projects.into_iter())
        .filter(|p| p.open && p.available)
        .partition(|p| p.kind != ProjectKind::Scratch);
    // A session in Scratch is followed up as any other, when the person is
    // in it or names it.
    let followed = (sessions.into_iter())
        // A follow-up to an ended session resumes it, when its agent left a handle.
        .filter(|s| s.state != SessionState::Ended || s.resume.is_some())
        .filter_map(|s| {
            let project = (projects.iter().chain(&scratch)).find(|p| p.id == s.project_id)?;
            let label = format!("The {} session in {}", s.agent, project.name);
            Some(Followed {
                id: s.id,
                name: s.name,
                project: s.project_id,
                label,
                agent: s.agent,
                state: s.state,
                thought: s.thought_id,
                task: String::new(),
            })
        })
        .collect();
    // A workspace with its card's line and names; then every project Tasktap
    // knows that is not an open workspace, copies and hidden ones not.
    let card_of: BTreeMap<ProjectId, &tasktap_proto::Card> = (cards.iter())
        .filter_map(|c| Some((c.project_id?, c)))
        .collect();
    let mut named: Vec<Named> = (projects.iter())
        .map(|p| {
            let card = card_of.get(&p.id);
            let mut aliases = p.aliases.clone();
            for n in card.map(|c| c.names.as_slice()).unwrap_or_default() {
                if !aliases.contains(n) && *n != p.name {
                    aliases.push(n.clone());
                }
            }
            let used = [card.and_then(|c| c.used), started.get(&p.id).copied()];
            Named {
                to: Destination::New(p.id),
                name: p.name.clone(),
                aliases,
                about: card.map(|c| c.about.clone()).unwrap_or_default(),
                folder: p.folder.clone(),
                used: used.into_iter().flatten().max(),
            }
        })
        .collect();
    let open = |c: &tasktap_proto::Card| {
        (projects.iter().chain(&scratch))
            .any(|p| Some(p.id) == c.project_id || p.folder == c.folder)
    };
    for c in cards.iter().filter(|c| crate::map::offered(c) && !open(c)) {
        named.push(Named {
            to: Destination::Card(c.id),
            name: c.name.clone(),
            aliases: c.names.clone(),
            about: c.about.clone(),
            folder: c.folder.clone(),
            used: c.used,
        });
    }
    Ok(Request {
        text: text.to_owned(),
        current,
        picked: None,
        recent: Vec::new(),
        projects: named,
        sessions: followed,
        last,
    })
}

/// Where the capture says one of the project's names, and how.
fn said_at(w: &Words, p: &Named) -> Vec<Said> {
    let all = std::iter::once(&p.name).chain(&p.aliases);
    all.flat_map(|n| said(w, n)).collect()
}

/// One project the capture names: where, and how.
#[derive(Clone, Debug)]
struct Hit<'r> {
    p: &'r Named,
    said: Said,
}

/// The projects the capture names, each once, at its strongest: a name
/// said inside a longer name of another project is not; one said only
/// as it sounds is not when another is written or joined; one a letter
/// off is not when another is said otherwise. The strongest and longest
/// first, then the most recently worked on.
fn hits(r: &Request) -> Vec<Hit<'_>> {
    let w = name_words(&r.text);
    let all: Vec<Hit> = (r.projects.iter())
        .flat_map(|p| said_at(&w, p).into_iter().map(move |said| Hit { p, said }))
        .collect();
    let inside = |h: &Hit| {
        all.iter().any(|o| {
            o.p.to != h.p.to
                && o.said.at.start <= h.said.at.start
                && h.said.at.end <= o.said.at.end
                && (o.said.len > h.said.len || o.said.at.len() > h.said.at.len())
                && strength(o.said.how) >= strength(h.said.how)
        })
    };
    let kept: Vec<&Hit> = all.iter().filter(|h| !inside(h)).collect();
    let best = kept.iter().map(|h| strength(h.said.how)).max();
    let mut out: Vec<Hit> = Vec::new();
    for h in kept
        .into_iter()
        .filter(|h| Some(strength(h.said.how)) == best)
    {
        match out.iter_mut().find(|o| o.p.to == h.p.to) {
            Some(o) if (h.said.how, h.said.len) > (o.said.how, o.said.len) => *o = h.clone(),
            Some(_) => {}
            None => out.push(h.clone()),
        }
    }
    out.sort_by_key(|h| std::cmp::Reverse((h.said.how, h.said.len, h.p.used)));
    out
}

/// A name written or joined is as strong as another: both are what the
/// person meant to say.
fn strength(how: How) -> u8 {
    match how {
        How::Near => 0,
        How::Sounds => 1,
        How::Joined | How::Written => 2,
    }
}

/// What the person's words were, when they named a project otherwise
/// than as its name is written.
fn quoted(r: &Request, h: &Hit) -> Option<String> {
    (h.said.how != How::Written).then(|| r.text[h.said.span.clone()].to_owned())
}

/// Why a project named is a choice, in a few words.
fn why_named(r: &Request, h: &Hit) -> String {
    let words = &r.text[h.said.span.clone()];
    match h.said.how {
        How::Written => "named in it".into(),
        How::Joined | How::Sounds => format!("said as “{words}”"),
        How::Near => format!("you wrote “{words}”"),
    }
}

/// Whether the capture names the project, by any of its names.
fn names(text: &str, p: &Named) -> bool {
    !said_at(&name_words(text), p).is_empty()
}

/// Whether the capture names the session.
fn follows(text: &str, s: &Followed) -> bool {
    s.name
        .as_deref()
        .is_some_and(|n| !spans(text, n).is_empty())
}

/// The rules of the module's table, over `r` alone.
pub fn local(r: &Request) -> Route {
    by_names(r).unwrap_or_else(|| unsure(r))
}

/// Whether the names the capture says, or the session it was made in,
/// decide where it goes: then the match is sure and no model is asked.
pub fn sure(r: &Request) -> bool {
    by_names(r).is_some()
}

/// The route the names the capture says decide, or the session it was
/// made in; none when neither says anything.
pub fn by_names(r: &Request) -> Option<Route> {
    let named = hits(r);
    let sessions: Vec<&Followed> = (r.sessions.iter())
        .filter(|s| follows(&r.text, s))
        .collect();
    let current = r
        .current
        .and_then(|id| r.sessions.iter().find(|s| s.id == id));
    // No project named, or only the one the session is in.
    let only_in = |project: ProjectId| named.iter().all(|h| h.p.to == Destination::New(project));
    let clear = |to, said| Route::Clear {
        to,
        brief: r.text.clone(),
        said,
    };
    let sure = |h: &Hit| h.said.how != How::Near;
    match (sessions.as_slice(), current, named.as_slice()) {
        ([s], ..) if only_in(s.project) => Some(clear(Destination::Session(s.id), None)),
        ([], Some(c), _) if only_in(c.project) => Some(clear(Destination::Session(c.id), None)),
        ([], _, [h]) if sure(h) => Some(clear(h.p.to, quoted(r, h))),
        ([], _, []) => None,
        _ => {
            // A name a letter off ("carrier" for `farrier`) is asked about
            // among what else fits, which a line that fits well comes before.
            let near = sessions.is_empty() && named.iter().all(|h| h.said.how == How::Near);
            let projects = named.iter().map(|h| Candidate {
                label: h.p.name.clone(),
                to: h.p.to,
                why: why_named(r, h),
            });
            let sessions = sessions.iter().map(|s| Candidate {
                label: s.name.clone().unwrap_or_else(|| s.label.clone()),
                to: Destination::Session(s.id),
                why: "named in it".into(),
            });
            let mut candidates: Vec<_> = match near {
                false => projects.chain(sessions).collect(),
                true => (ranked(r, CHOICES).into_iter())
                    .map(|(p, why)| Candidate {
                        label: p.name.clone(),
                        to: p.to,
                        why,
                    })
                    .collect(),
            };
            candidates.truncate(CHOICES);
            Some(Route::Ambiguous {
                prompt: WHERE.into(),
                candidates,
                brief: None,
            })
        }
    }
}

/// Where a capture that names nothing may go: asked about, with at most
/// three choices; an idea when no project is known at all.
fn unsure(r: &Request) -> Route {
    let candidates: Vec<Candidate> = (ranked(r, CHOICES).into_iter())
        .map(|(p, why)| Candidate {
            label: p.name.clone(),
            to: p.to,
            why,
        })
        .collect();
    match candidates.is_empty() {
        true => Route::Unknown,
        false => Route::Ambiguous {
            prompt: WHERE.into(),
            candidates,
            brief: None,
        },
    }
}

/// The projects likeliest for a capture, at most `most`, each with why:
/// those it names; then those whose line about them shares its rarer
/// words; then where the last thought went; then the most recently worked
/// on. Recency orders and never adds a reason of its own beyond that.
pub fn ranked(r: &Request, most: usize) -> Vec<(&Named, String)> {
    let mut out: Vec<(&Named, String)> = Vec::new();
    let add = |p, why: String, out: &mut Vec<_>| push(out, most, p, why);
    let named = hits(r);
    let (near, said): (Vec<&Hit>, Vec<&Hit>) = named.iter().partition(|h| h.said.how == How::Near);
    for h in said {
        add(h.p, why_named(r, h), &mut out);
    }
    let lines: Vec<String> = (r.projects.iter())
        .map(|p| {
            let names = std::iter::once(&p.name).chain(&p.aliases);
            let names: Vec<String> = names.flat_map(|n| parts(n)).collect();
            format!("{} {}", names.join(" "), p.about)
        })
        .collect();
    let fits = names::fit(&r.text, &lines);
    let mut described: Vec<(usize, f64)> = (fits.iter().enumerate())
        .filter(|(_, (score, _))| *score > 0.0)
        .map(|(i, (score, _))| (i, *score))
        .collect();
    described.sort_by(|a, b| {
        let (pa, pb) = (&r.projects[a.0], &r.projects[b.0]);
        b.1.total_cmp(&a.1).then_with(|| pb.used.cmp(&pa.used))
    });
    // A name a letter off comes after a line that shares two words or more.
    let mut near = near.into_iter();
    for (i, _) in described {
        let shared = &fits[i].1;
        if shared.len() < 2 {
            for h in near.by_ref() {
                add(h.p, why_named(r, h), &mut out);
            }
        }
        add(
            &r.projects[i],
            shared
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<_>>()
                .join(", "),
            &mut out,
        );
    }
    for h in near {
        add(h.p, why_named(r, h), &mut out);
    }
    if let Some(last) = r.last
        && let Some(p) = r.projects.iter().find(|p| p.to == last)
    {
        add(p, "where your last thought went".into(), &mut out);
    }
    let mut recent: Vec<&Named> = r.projects.iter().filter(|p| p.used.is_some()).collect();
    recent.sort_by_key(|p| std::cmp::Reverse(p.used));
    for (i, p) in recent.into_iter().enumerate() {
        add(
            p,
            if i == 0 {
                "worked on last".into()
            } else {
                String::new()
            },
            &mut out,
        );
    }
    // Then the workspaces, the newest first, before the projects not open.
    let open = |p: &&Named| matches!(p.to, Destination::New(_));
    for p in r.projects.iter().rev().filter(open) {
        add(p, String::new(), &mut out);
    }
    for p in r.projects.iter().rev() {
        add(p, String::new(), &mut out);
    }
    out
}

/// Adds a project to a list of at most `most`, once.
fn push<'r>(out: &mut Vec<(&'r Named, String)>, most: usize, p: &'r Named, why: String) {
    if out.len() < most && !out.iter().any(|(q, _)| q.to == p.to) {
        out.push((p, why));
    }
}

/// What a field to find a project finds for `r.text`: with nothing typed,
/// the most recently worked on; with a few words, the projects whose name
/// they say or begin, then those whose line about them they fit; with a
/// whole thought, its likeliest places ([`ranked`]).
pub fn find(r: &Request, most: usize) -> Vec<(&Named, String)> {
    let typed = name_words(&r.text);
    if typed.words.len() > 3 {
        return ranked(r, most);
    }
    let mut out: Vec<(&Named, String)> = Vec::new();
    if typed.words.is_empty() {
        let mut recent: Vec<&Named> = r.projects.iter().collect();
        recent.sort_by(|a, b| b.used.cmp(&a.used).then_with(|| a.name.cmp(&b.name)));
        return recent
            .into_iter()
            .take(most)
            .map(|p| (p, String::new()))
            .collect();
    }
    let query: String = typed.words.concat();
    for h in hits(r) {
        if out.len() < most && !out.iter().any(|(q, _)| q.to == h.p.to) {
            out.push((h.p, why_named(r, &h)));
        }
    }
    let mut begun: Vec<&Named> = (r.projects.iter())
        .filter(|p| {
            let names = std::iter::once(&p.name).chain(&p.aliases);
            names.map(|n| parts(n).concat()).any(|n| n.contains(&query))
        })
        .collect();
    begun.sort_by(|a, b| b.used.cmp(&a.used).then_with(|| a.name.cmp(&b.name)));
    for p in begun {
        if out.len() < most && !out.iter().any(|(q, _)| q.to == p.to) {
            out.push((p, String::new()));
        }
    }
    let lines: Vec<String> = r.projects.iter().map(|p| p.about.clone()).collect();
    let fits = names::fit(&r.text, &lines);
    let mut described: Vec<usize> = (0..fits.len()).filter(|i| fits[*i].0 > 0.0).collect();
    described.sort_by(|a, b| fits[*b].0.total_cmp(&fits[*a].0));
    for i in described {
        let p = &r.projects[i];
        if out.len() < most && !out.iter().any(|(q, _)| q.to == p.to) {
            out.push((p, fits[i].1.join(", ")));
        }
    }
    out
}

/// What a router question asks.
const WHERE: &str = "Where should this go?";

/// The request as a model is given it (design §8): at most 8 projects and
/// 8 sessions. The projects: those the capture names, then the current
/// session's, then the others this machine ranks likeliest ([`ranked`]:
/// by the line about each, where the last thought went, how recently each
/// was worked on), workspaces and known projects alike; never all of them.
/// The sessions: those it names, then the current one, then the newest;
/// each with its last request, and the 3 latest exchanges with them.
pub fn narrow(tx: &Tx, mut r: Request) -> store::Result<Request> {
    let (current, text) = (r.current, r.text.clone());
    // Newest first, then what the capture points at before the rest. (No
    // sort: one for each of the two kinds would be 24 KiB of the binary.)
    r.sessions.reverse();
    r.sessions = first(r.sessions, |s| Some(s.id) == current);
    r.sessions = first(r.sessions, |s| follows(&text, s));
    r.sessions.truncate(OFFERED);
    let order: Vec<Destination> = ranked(&r, r.projects.len())
        .iter()
        .map(|(p, _)| p.to)
        .collect();
    let mut rest = std::mem::take(&mut r.projects);
    rest.sort_by_key(|p| order.iter().position(|o| *o == p.to).unwrap_or(usize::MAX));
    let named = rest.iter().take_while(|p| names(&text, p)).count();
    r.projects = rest.drain(..named).collect();
    let session = r
        .current
        .and_then(|c| r.sessions.iter().find(|s| s.id == c));
    if let Some(s) = session
        && let Some(at) = rest
            .iter()
            .position(|p| p.to == Destination::New(s.project))
    {
        r.projects.push(rest.remove(at));
    }
    r.projects.extend(rest);
    r.projects.truncate(OFFERED);
    r.sessions.retain(|s| {
        r.projects
            .iter()
            .any(|p| p.to == Destination::New(s.project))
    });
    for s in &mut r.sessions {
        let asked = s.thought.map(|t| tx.thought(t)).transpose()?.flatten();
        s.task = asked.map(|t| cut(&t.text, 180)).unwrap_or_default();
    }
    for (t, result) in tx.exchanges(4 * OFFERED)? {
        let session = t
            .session_id
            .filter(|id| r.sessions.iter().any(|s| s.id == *id));
        if let (Some(session), true) = (session, r.recent.len() < RECENT) {
            r.recent.push(Exchange {
                session,
                request: cut(&t.text, 320),
                status: t.status,
                result: cut(&result.unwrap_or_default(), 160),
            });
        }
    }
    Ok(r)
}

/// `all` with those that are `first` before the others, each in their order.
fn first<T>(all: Vec<T>, first: impl Fn(&T) -> bool) -> Vec<T> {
    let (mut front, back): (Vec<T>, Vec<T>) = all.into_iter().partition(first);
    front.extend(back);
    front
}

/// The first `chars` characters of `text` on one line.
fn cut(text: &str, chars: usize) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    line.chars().take(chars).collect()
}

/// The key a model names a destination by: `p1`, `s2`, by its place in
/// the request. Short, so a small model copies it without error, and the
/// core's ids never leave it.
fn key(r: &Request, to: Destination) -> Option<String> {
    match to {
        Destination::Session(id) => {
            let at = r.sessions.iter().position(|s| s.id == id)?;
            Some(format!("s{}", at + 1))
        }
        to => {
            let at = r.projects.iter().position(|p| p.to == to)?;
            Some(format!("p{}", at + 1))
        }
    }
}

/// The destination a key names, and what a choice of it says.
fn place(r: &Request, key: &str) -> Option<Candidate> {
    let at = key.get(1..)?.parse::<usize>().ok()?.checked_sub(1)?;
    match key.as_bytes().first()? {
        b'p' => r.projects.get(at).map(|p| Candidate {
            label: p.name.clone(),
            to: p.to,
            why: String::new(),
        }),
        b's' => r.sessions.get(at).map(|s| Candidate {
            label: s.name.clone().unwrap_or_else(|| s.label.clone()),
            to: Destination::Session(s.id),
            why: String::new(),
        }),
        _ => None,
    }
}

/// What a model is asked about a narrowed request: the instructions, then
/// the request as JSON.
pub fn question(r: &Request) -> String {
    let project = |id: ProjectId| key(r, Destination::New(id));
    let session = |id: SessionId| key(r, Destination::Session(id));
    let projects: Vec<_> = (r.projects.iter())
        .map(|p| {
            let aliases: Vec<_> = p.aliases.iter().take(3).map(|a| cut(a, 60)).collect();
            json!({ "id": key(r, p.to), "name": cut(&p.name, 100), "aliases": aliases,
                    "about": cut(&p.about, 160) })
        })
        .collect();
    let sessions: Vec<_> = (r.sessions.iter())
        .map(|s| {
            json!({ "id": session(s.id), "name": s.name.as_deref().map(|n| cut(n, 140)),
                    "task": s.task, "project": project(s.project), "agent": s.agent,
                    "state": word(&s.state) })
        })
        .collect();
    let recent: Vec<_> = (r.recent.iter())
        .map(|e| {
            json!({ "session": session(e.session), "request": e.request,
                    "status": word(&e.status), "result": e.result })
        })
        .collect();
    let request = json!({
        "thought": r.text,
        "current": r.current.and_then(session),
        "picked": r.picked.and_then(|to| key(r, to)),
        "projects": projects,
        "sessions": sessions,
        "recent": recent,
    });
    format!("{INSTRUCTIONS}\n<request>\n{request}\n</request>\n")
}

/// A word of the protocol as the protocol writes it.
fn word(word: &impl serde::Serialize) -> String {
    let value = serde_json::to_value(word).unwrap_or_default();
    value.as_str().unwrap_or_default().to_owned()
}

/// A model's answer, as [`SCHEMA`] says it.
struct Answer {
    quote: String,
    confidence: Confidence,
    to: String,
    candidates: Vec<String>,
    brief: String,
    title: String,
}

enum Confidence {
    Clear,
    Ambiguous,
    Unknown,
}

impl Answer {
    /// Reads an answer strictly: the one object, each field there and of
    /// its kind, and no other. (By hand: a derived reader is 9 KiB of the
    /// binary for this one type.)
    fn read(answer: &str) -> Result<Answer, String> {
        let wrong = |what: &str| format!("its answer is not the JSON it was asked for: {what}");
        let Ok(Value::Object(mut fields)) = serde_json::from_str(answer) else {
            return Err(wrong("it is no JSON object"));
        };
        let mut text = |key: &str| match fields.remove(key) {
            Some(Value::String(text)) => Ok(text),
            _ => Err(wrong(&format!("{key} is no text"))),
        };
        let (quote, to, brief) = (text("quote")?, text("to")?, text("brief")?);
        let title = text("title")?;
        let confidence = match text("confidence")?.as_str() {
            "clear" => Confidence::Clear,
            "ambiguous" => Confidence::Ambiguous,
            "unknown" => Confidence::Unknown,
            other => return Err(wrong(&format!("its confidence is {other:?}"))),
        };
        let Some(Value::Array(keys)) = fields.remove("candidates") else {
            return Err(wrong("candidates is no list"));
        };
        let keys = keys.into_iter().map(|key| match key {
            Value::String(key) => Ok(key),
            _ => Err(wrong("candidates holds what is no text")),
        });
        let candidates = keys.collect::<Result<Vec<_>, _>>()?;
        match fields.keys().next() {
            Some(more) => Err(wrong(&format!("it has {more}, which was not asked for"))),
            None => Ok(Answer {
                quote,
                confidence,
                to,
                candidates,
                brief,
                title,
            }),
        }
    }
}

/// The acceptance rules of the module's second table: the route a model's
/// `answer` to `r` gives, and of how it came what the answer itself says
/// (the words it quoted for a follow-up, the title it gave the work); or
/// why it is not used.
pub fn accept(r: &Request, answer: &str) -> Result<(Route, Routing), String> {
    if answer.len() > 64 << 10 {
        return Err("its answer is too large".into());
    }
    let a = Answer::read(answer)?;
    let offered = |key: &str| {
        place(r, key).ok_or_else(|| format!("it names {key:?}, which it was not offered"))
    };
    let brief = || {
        let brief = a.brief.trim();
        let most = 2 * r.text.chars().count() + 400;
        match brief.chars().count() {
            0 => Err("it wrote no brief".to_owned()),
            n if n > most => Err("its brief is longer than the thought allows".to_owned()),
            _ => Ok(brief.to_owned()),
        }
    };
    // A title is plain: one line, short. Another is no title, and no
    // reason to refuse the rest.
    let title = a.title.trim();
    let plain = !title.is_empty()
        && title.chars().count() <= MAX_TITLE
        && !title.chars().any(char::is_control);
    let found = |quote: Option<&str>| Routing {
        quote: quote.map(Into::into),
        title: plain.then(|| title.to_owned()),
        ..Routing::default()
    };
    if let Some(to) = r.picked {
        let brief = brief()?;
        let said = None;
        return Ok((Route::Clear { to, brief, said }, found(None)));
    }
    match a.confidence {
        Confidence::Unknown => Ok((Route::Unknown, Routing::default())),
        Confidence::Clear => {
            let to = offered(&a.to)?.to;
            let quote = a.quote.trim();
            let quoted = quote.chars().count() >= 3 && says(&r.text, quote);
            let follows = matches!(to, Destination::Session(id) if Some(id) != r.current);
            if follows && !quoted {
                return Err("the words it quotes for a follow-up are not in the thought".into());
            }
            let brief = brief()?;
            let said = None;
            Ok((
                Route::Clear { to, brief, said },
                found(quoted.then_some(quote)),
            ))
        }
        Confidence::Ambiguous => {
            let mut candidates: Vec<Candidate> = Vec::new();
            for key in &a.candidates {
                let choice = offered(key)?;
                if !candidates.contains(&choice) {
                    candidates.push(choice);
                }
            }
            if candidates.len() < 2 {
                return Err("it is unsure and names fewer than two choices".into());
            }
            // At most three choices, the likeliest first as it gave them.
            candidates.truncate(CHOICES);
            let route = Route::Ambiguous {
                prompt: WHERE.into(),
                candidates,
                brief: Some(brief()?),
            };
            Ok((route, found(None)))
        }
    }
}

/// What a thought's `route` says when its tool no longer offers the model
/// it is asked for: words for the person, as the interface shows them.
pub fn gone(tool: &str) -> String {
    format!(
        "{tool} no longer offers the model Tasktap asks for placing; \
         placing by name until Tasktap is updated"
    )
}

/// The words of a text, lower-cased, with one space between them: what
/// "word for word" compares, whatever the punctuation and spacing.
fn words(text: &str) -> String {
    let lower = text.to_lowercase();
    let words = lower.split(|c: char| !c.is_alphanumeric());
    words
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether `text` has `part` word for word.
fn says(text: &str, part: &str) -> bool {
    let part = words(part);
    !part.is_empty() && format!(" {} ", words(text)).contains(&format!(" {part} "))
}

/// Whether two texts say the same words: then a brief adds nothing to the
/// person's own, and they are sent once.
pub fn same(brief: &str, text: &str) -> bool {
    words(brief) == words(text)
}

/// Whether a thought is short enough to go on as it is.
pub fn short(text: &str) -> bool {
    text.chars().count() <= SHORT && !text.trim().contains('\n')
}

/// Whether a model can be asked about a thought at all.
pub fn askable(text: &str) -> Result<(), String> {
    match text.chars().count() <= MAX_THOUGHT {
        true => Ok(()),
        false => Err(format!(
            "the thought is longer than {MAX_THOUGHT} characters"
        )),
    }
}

/// The agent a consent names and how its tool is asked, when the consent
/// covers what this core would ask: that tool, with that model.
pub fn consented(by: &RouteBy) -> Result<(&'static dyn Agent, Headless), String> {
    if by.terms != TERMS {
        return Err("the agreement was to what was sent before: placing by a model now sends a line about each project, and asks again".into());
    }
    let agent = agents::live(&by.agent).ok_or(format!("Tasktap has no agent {}", by.agent))?;
    let how = agent
        .headless()
        .ok_or(format!("{} cannot be asked to place thoughts", by.agent))?;
    match how.model == by.model {
        true => Ok((agent, how)),
        false => Err(format!(
            "the consent is for {}, and {} is now asked as {}",
            by.model, by.agent, how.model
        )),
    }
}

/// `route.terms`: what routing by a model sends and to whom. A tool that
/// was found not to offer its model any more is not among them.
pub fn terms(cx: &mut Cx, _: tasktap_proto::Empty) -> Result<RouteTerms, Error> {
    let offered = |a: &&&dyn Agent| !cx.core.seams.gone(a.id());
    let all = agents::all();
    let tools = all.iter().filter(offered).filter_map(|a| {
        Some(RouteBy {
            agent: a.id().into(),
            model: a.headless()?.model.into(),
            terms: TERMS,
        })
    });
    Ok(RouteTerms {
        instructions: INSTRUCTIONS.into(),
        sends: SENDS.iter().map(|s| (*s).into()).collect(),
        tools: tools.collect(),
    })
}

/// Where `name` appears in `text` as whole words, ignoring case: the
/// byte ranges in the lower-cased text. The words of a name joined by
/// hyphens, underscores or spaces may be joined by any of those there.
fn spans(text: &str, name: &str) -> Vec<Range<usize>> {
    let joint = |c: char| c == '-' || c == '_' || c.is_whitespace();
    let word = |c: char| c.is_alphanumeric() || c == '_';
    let name = name.to_lowercase();
    let parts: Vec<&str> = name.split(joint).filter(|p| !p.is_empty()).collect();
    let Some((head, tail)) = parts.split_first() else {
        return Vec::new();
    };
    let text = text.to_lowercase();
    let mut found = Vec::new();
    for (at, _) in text.match_indices(head) {
        if text[..at].chars().next_back().is_some_and(word) {
            continue;
        }
        let mut end = at + head.len();
        let whole = tail.iter().all(|part| {
            let rest = &text[end..];
            let gap = rest.len() - rest.trim_start_matches(joint).len();
            let next = gap > 0 && rest[gap..].starts_with(part);
            end += if next { gap + part.len() } else { 0 };
            next
        });
        if whole && !text[end..].chars().next().is_some_and(word) {
            found.push(at..end);
        }
    }
    found
}

/// `route.hint`: the match on names for a capture being typed, which the
/// chip says: where the names it says send it, or `unknown` while they say
/// nothing (the capture then asks, or a model places it). It stores
/// nothing and starts nothing.
pub fn hint(cx: &mut Cx, args: Hint) -> Result<tasktap_proto::Route, Error> {
    let request = effects::read(cx.core, |tx| request(tx, &args.text, args.current))?;
    Ok(wire(by_names(&request).unwrap_or(Route::Unknown)))
}

/// A route as the protocol says it.
pub fn wire(route: Route) -> tasktap_proto::Route {
    match route {
        Route::Clear { to, brief, said } => tasktap_proto::Route::Clear {
            to: to.into(),
            brief,
            said,
        },
        Route::Ambiguous {
            prompt, candidates, ..
        } => tasktap_proto::Route::Ambiguous {
            prompt,
            candidates: (candidates.into_iter())
                .map(|c| tasktap_proto::Candidate {
                    label: c.label,
                    to: c.to.into(),
                    why: c.why,
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
        tasktap_proto::Place::Project(id) => Destination::New(id),
        tasktap_proto::Place::Session(id) => Destination::Session(id),
        tasktap_proto::Place::Card(id) => Destination::Card(id),
    };
    match route {
        tasktap_proto::Route::Clear {
            to: place,
            brief,
            said,
        } => Route::Clear {
            to: to(place),
            brief,
            said,
        },
        tasktap_proto::Route::Ambiguous { prompt, candidates } => Route::Ambiguous {
            brief: None,
            prompt,
            candidates: (candidates.into_iter())
                .map(|c| Candidate {
                    label: c.label,
                    to: to(c.to),
                    why: c.why,
                })
                .collect(),
        },
        tasktap_proto::Route::Unknown => Route::Unknown,
    }
}
