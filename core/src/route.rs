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
//! The models are those behind the person's own agents, asked headless
//! (`agents::Headless`), and ChatGPT on the person's own plan once they
//! signed in with it (`chatgpt.rs`, one direct call, no agent started),
//! one after another in the order the person agreed to ([`agreed`];
//! Tasktap proposes one, [`proposed`]), within [`BUDGET`]: one question,
//! [`question`], carries the [`INSTRUCTIONS`] and what the core's records
//! offer, and an answer is taken only as [`accept`] allows.
//! Nothing here runs a tool or waits: `effects.rs` runs the tools off the
//! core's thread, one at a time, and `state.rs` holds the rules of when a
//! thought is asked about and when it launches.
//!
//! The rules, simplest first (a destination the person picked never reaches
//! a router: the state machine routes it at capture):
//!
//! | The capture | Route |
//! | --- | --- |
//! | names one session, and no project but that session's | `clear`: a follow-up to it |
//! | names no session, was made in a current session, and names no project but that session's | `clear`: a follow-up to the current session |
//! | names one project, as written or with its parts said apart, and no session | `clear`: a new run in that project, opened there if it is a known project and not a workspace |
//! | names several projects or sessions, or one name two projects have, or one inside another's name nearly said ("the zentrix syncs" with `zentrix` and `zentrix-sync`); or says a name only as it sounds, one letter off, or an everyday word that is a project's name ("test", "app") not used as a name | `ambiguous`: those are the choices first, at most three |
//! | names no session and no project for certain, and one project clearly leads by what only it has ([`LEAD`]: its whole name nearly said, "vexa widget" for `vexa-widgets`, and a word only its line has, "widgetpack") | `clear`: a new run there, held to be undone as any; its line says why; with a model agreed to, the model is asked first, given it first |
//! | names nothing, and projects are known | `ambiguous`, "Which project is this task for?": at most three, the ones it names (with how, where not as written) and those whose line about them it clearly describes ([`offered`]); none when nothing points anywhere, never one only because it was worked on lately, and the person is asked all the same. A model is shown its eight as before ([`ranked`]) |
//! | names nothing, and no project is known | `ambiguous` with no choice, "Where should the agent work?": never kept for later unasked, and no model is asked, since it would be shown nothing to choose from (`effects.rs`) |
//!
//! A name is said as `names.rs` finds it. Where one project's name is said
//! inside a longer name of another ("tidepool" in "tidepool mobile"), the
//! longer is meant; two said alike are a choice. A name said as written
//! or joined outweighs one said only as it sounds, which outweighs one a
//! letter off or an everyday word said as that word. An everyday word is
//! used as a name after "in" or "to", before "project" or "repo", in
//! backticks or quotes, at the end of a path, or beside another project's
//! name ("folio and app"). How recently a project was worked on orders the
//! choices and never decides alone. The Scratchpad is never offered: a thought
//! goes there only when the person picks it, or says it as a place ("on the
//! scratchpad", "im Scratchpad"; never the word "scratch" alone). The brief
//! is the person's text unchanged.
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
//! | `ambiguous` names at least one choice (one alone waits for the person's key, as several do) | rejected |
//! | a brief is there, and no longer than twice the capture and 400 characters | rejected |
//! | a title is one line of at most 60 characters | it has none |
//! | the person picked the destination | only the brief and the title are taken |

use std::collections::BTreeMap;
use std::ops::Range;

use serde_json::{Value, json};
use tasktap_proto::{
    Collection, Error, Hint, NewProject, Pays, Phase, PlaceTool, Placer, ProjectId, ProjectKind,
    RouteBy, RouteTerms, Routing, SessionId, SessionState, Set, Status, ThoughtId, Time,
};

use crate::agents::{self, Agent, Headless};
use crate::calls::Cx;
use crate::effects;
use crate::state::{self, Candidate, Destination, Route};
use crate::store::{self, Tx};

mod names;
pub use names::{How, Lexicon, parts, sound};
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
    r#""required":["quote","confidence","to","candidates","brief","folder","title"],"#,
    r#""properties":{"quote":{"type":"string"},"#,
    r#""confidence":{"type":"string","enum":["clear","new","ambiguous","unknown"]},"#,
    r#""to":{"type":"string"},"candidates":{"type":"array","items":{"type":"string"}},"#,
    r#""brief":{"type":"string"},"folder":{"type":"string"},"title":{"type":"string"}}}"#,
);

/// What routing by a model sends, as `route.terms` lists it.
const SENDS: &[&str] = &[
    "the task in your words, and the project or session open in Tasktap's window",
    "up to 8 likely projects, each with its names, one line about the project, 5 earlier tasks and the folder names at the project's top",
    "the sessions in those projects, each with its name, first and last request, its agent, the agent's state, how long ago it last ran and the start of the agent's last answer",
    "your 3 most recent tasks in those sessions and how each ended",
    "a text that looks like a key, a token or a password is left out, also from the task",
];

/// How much of each text is sent, in one sentence: `route.terms` says it
/// with the instructions, where the person reads how it is asked.
const CUTS: &str = "How much of each text is sent at most: a name 100 characters, a line about a project 160, an earlier task 80, a request 180, an agent's last answer 160, a recent task 320 and how it ended 160.";

/// The version of what is sent and to whom, which an agreement names
/// (`RouteBy::terms`): 4 since a model is given each project's earlier
/// tasks and folder, each session's first task, state, age and last
/// answer, and what is in view, and decides every task the person did not
/// place; 3 since it lists the person's agents, asked one after another
/// until one answers; 2 since a model is given a line about each project,
/// and projects that are not open. An agreement to another version covers
/// nothing.
pub const TERMS: u32 = 4;

/// Most projects, sessions and recent exchanges a model is given (design §8).
const OFFERED: usize = 8;
/// Most choices a question of where a thought goes has (the owner's
/// decision of 2026-11-19), beside "Another project…" and "Keep for later".
pub const CHOICES: usize = 3;
const RECENT: usize = 3;
/// Most projects, besides where the last task went, that a model is given
/// for being the most recently worked on ([`order`]).
const RECENT_PROJECTS: usize = 2;
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
    /// The Scratchpad, when it is open: a run starts there only when the
    /// capture says it as a place ([`scratchpad`]), and it is never a choice.
    pub scratch: Option<ProjectId>,
    /// Sessions a follow-up can go to, each in one of `projects`.
    pub sessions: Vec<Followed>,
    /// The latest exchanges with those sessions, newest first; only a
    /// model is given them ([`narrow`]).
    pub recent: Vec<Exchange>,
    /// Where the newest thought that has a place went.
    pub last: Option<Destination>,
    /// Where the words of the language are, to tell an ordinary word from
    /// one made up for a name ([`Lexicon`]).
    pub words: Lexicon,
    /// The workspace in view when the capture was said in Tasktap's
    /// window; a model is told of it, the match on names is not.
    pub view: Option<ProjectId>,
    /// Of each project a model is offered ([`narrow`]): the titles of the
    /// latest tasks that ran there, the newest first.
    pub earlier: Vec<(Destination, Vec<String>)>,
    /// Of each project a model is offered: the names at the top of its
    /// folder.
    pub top: Vec<(Destination, Vec<String>)>,
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
    /// The request it began with; only a model is given it.
    pub first: String,
    /// What its agent last answered: its latest result's summary.
    pub summary: String,
    /// Milliseconds since its latest turn began, as far as Tasktap knows.
    pub ago: Option<u64>,
    /// It waits on a question its agent asked.
    pub asks: bool,
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
            let place = match project.kind {
                ProjectKind::Scratch => store::SCRATCHPAD,
                ProjectKind::Folder => &project.name,
            };
            let label = format!("The {} session in {place}", s.agent);
            Some(Followed {
                id: s.id,
                name: s.name,
                project: s.project_id,
                label,
                agent: s.agent,
                state: s.state,
                thought: s.thought_id,
                task: String::new(),
                first: String::new(),
                summary: String::new(),
                ago: None,
                asks: false,
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
        scratch: scratch.first().map(|p| p.id),
        projects: named,
        sessions: followed,
        last,
        words: Lexicon::default(),
        view: None,
        earlier: Vec::new(),
        top: Vec::new(),
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
    /// Words that are a name but not used as one (an everyday word, "app";
    /// ordinary words written apart, "harbor master"): as weak as a name a
    /// letter off.
    plain: bool,
    /// The name said is an everyday word's ([`EVERYDAY`]).
    everyday: bool,
}

/// Names that are everyday words of a person's work: a project called so
/// is named by a thought only when the thought uses the word as a name.
const EVERYDAY: &[&str] = &[
    "admin",
    "api",
    "app",
    "apps",
    "assets",
    "backend",
    "blog",
    "bot",
    "build",
    "cli",
    "client",
    "code",
    "common",
    "config",
    "core",
    "dashboard",
    "data",
    "demo",
    "deploy",
    "design",
    "dev",
    "doc",
    "docs",
    "dotfiles",
    "example",
    "examples",
    "experiments",
    "frontend",
    "game",
    "home",
    "infra",
    "lib",
    "main",
    "misc",
    "mobile",
    "notes",
    "old",
    "personal",
    "playground",
    "project",
    "projects",
    "prototype",
    "sandbox",
    "scripts",
    "sdk",
    "server",
    "service",
    "services",
    "shared",
    "site",
    "src",
    "temp",
    "test",
    "tests",
    "tmp",
    "todo",
    "tools",
    "ui",
    "utils",
    "web",
    "website",
    "www",
];

/// Words before a name that say it is one: "in app", "to docs".
const BEFORE_NAME: &[&str] = &["in", "into", "to", "for", "from", "inside", "at"];
/// Words after a name that say it is one: "the app project". ("folder" is
/// not: "the scripts folder" is as often a folder in a project.)
const AFTER_NAME: &[&str] = &["project", "repo", "repository", "workspace", "codebase"];

/// Whether a project's name is everyday words alone.
fn everyday(name: &str) -> bool {
    let p = parts(name);
    !p.is_empty() && p.iter().all(|w| EVERYDAY.contains(&w.as_str()))
}

/// Everyday-word names that are also verbs: after "to" they are the verb
/// ("remember to test the export", "time to deploy").
const VERBS: &[&str] = &[
    "build",
    "code",
    "config",
    "demo",
    "deploy",
    "design",
    "prototype",
    "service",
    "test",
];
/// Verbs of moving something somewhere: "move the fixtures to test".
const MOVES: &[&str] = &[
    "add", "bring", "copy", "migrate", "move", "port", "push", "put", "send", "upload",
];

/// Whether the capture says `name` as a name where it says it: after "in"
/// or "to", before "project" or "repo", in backticks or quotes, in a path
/// to the project or one that begins with it, or written whole with what
/// joins its parts ("my-app").
fn as_name(r: &Request, w: &Words, said: &Said, name: &str) -> bool {
    let word = |i: usize| w.words.get(i).map(String::as_str);
    let before = said.at.start.checked_sub(1).and_then(word);
    let after = word(said.at.end);
    // "to" before a name that is also a verb is the verb's, unless
    // something is moved to it.
    let verb = parts(name).len() == 1 && VERBS.contains(&parts(name)[0].as_str());
    let moved = (said.at.start.saturating_sub(5)..said.at.start.saturating_sub(1))
        .filter_map(word)
        .any(|x| MOVES.contains(&x));
    let to = |b: &str| b != "to" || !verb || moved;
    if before.is_some_and(|b| BEFORE_NAME.contains(&b) && to(b))
        || after.is_some_and(|a| AFTER_NAME.contains(&a))
    {
        return true;
    }
    let (head, tail) = (&r.text[..said.span.start], &r.text[said.span.end..]);
    let open = head.chars().next_back();
    let close = tail.chars().next();
    let quoted = matches!(
        (open, close),
        (Some('`'), Some('`'))
            | (Some('"'), Some('"'))
            | (Some('\''), Some('\''))
            | (Some('“'), Some('”'))
            | (Some('‘'), Some('’'))
    );
    // In a path: one that ends at the project's own folder (`~/code/app`),
    // or begins with it (`app/src/main.rs`); never a folder of the same name
    // inside another (`src/app/page.tsx`).
    let lead = head
        .rfind(char::is_whitespace)
        .map_or(head, |i| &head[i + 1..]);
    let rest = tail.find(char::is_whitespace).map_or(tail, |i| &tail[..i]);
    let lead = lead.trim_start_matches(['`', '"', '\'', '“', '‘', '(']);
    let rest = rest.trim_end_matches(['`', '"', '\'', '”', '’', ')', ',', '.', ':', ';']);
    let slash = |s: &str| s.starts_with(['/', '\\']);
    let begins = lead.is_empty() && slash(rest);
    let ends = (lead.starts_with(['/', '~']) || lead.get(1..2) == Some(":"))
        && lead.ends_with(['/', '\\'])
        && (rest.is_empty() || rest == "/" || rest == "\\");
    let whole = parts(name).len() > 1 && r.text[said.span.clone()].eq_ignore_ascii_case(name);
    quoted || begins || ends || whole
}

/// The projects the capture names, each once, at its strongest: a name
/// said inside a longer name of another project is not; one said only
/// as it sounds is not when another is written or joined; one a letter
/// off, or an everyday word not said as a name, is not when another is
/// said otherwise. The strongest and longest first, then the most
/// recently worked on.
fn hits(r: &Request) -> Vec<Hit<'_>> {
    let w = name_words(&r.text);
    let all: Vec<Hit> = (r.projects.iter())
        .flat_map(|p| {
            let names = std::iter::once(&p.name).chain(&p.aliases);
            let w = &w;
            names.flat_map(move |n| {
                said(w, n).into_iter().map(move |said| {
                    let everyday = everyday(n);
                    let plain = (everyday || apart(r, w, &said)) && !as_name(r, w, &said, n);
                    Hit {
                        p,
                        said,
                        plain,
                        everyday,
                    }
                })
            })
        })
        .collect();
    // A name written apart is asked about only when every one of its words
    // is an ordinary word of the language, or another project's name is
    // said in the same words: "harbor master", "tidepool mobile" (`tidepool`
    // too). One with a word made up for it cannot be said by accident:
    // "tasktap api" places in `tasktap-api`.
    let loose: Vec<usize> = (0..all.len())
        .filter(|i| all[*i].plain && !all[*i].everyday)
        .collect();
    let mut wanted: Vec<&str> = Vec::new();
    for i in &loose {
        for x in &w.words[all[*i].said.at.clone()] {
            if !wanted.contains(&x.as_str()) {
                wanted.push(x);
            }
        }
    }
    let known = match wanted.is_empty() {
        true => Vec::new(),
        false => r.words.each(&wanted),
    };
    let ordinary = |x: &str| wanted.iter().position(|y| *y == x).is_none_or(|i| known[i]);
    let shared = |h: &Hit| {
        all.iter().any(|o| {
            o.p.to != h.p.to && o.said.at.start < h.said.at.end && h.said.at.start < o.said.at.end
        })
    };
    let placed: Vec<usize> = (loose.iter().copied())
        .filter(|i| {
            let h = &all[*i];
            let words = &w.words[h.said.at.clone()];
            !words.iter().all(|x| ordinary(x)) && !shared(h)
        })
        .collect();
    let all: Vec<Hit> = (all.into_iter().enumerate())
        .map(|(i, h)| Hit {
            plain: h.plain && !placed.contains(&i),
            ..h
        })
        .collect();
    // An everyday word beside another project's name, "and" or "or"
    // between, is a name too: "folio and app".
    let listed = |h: &Hit| {
        let and = |i: usize| w.words.get(i).is_some_and(|x| x == "and" || x == "or");
        all.iter().any(|o| {
            o.p.to != h.p.to
                && !o.plain
                && ((o.said.at.end + 1 == h.said.at.start && and(o.said.at.end))
                    || (h.said.at.end + 1 == o.said.at.start && and(h.said.at.end)))
        })
    };
    let named: Vec<bool> = all.iter().map(|h| h.plain && listed(h)).collect();
    let all: Vec<Hit> = (all.into_iter().zip(named))
        .map(|(h, named)| Hit {
            plain: h.plain && !named,
            ..h
        })
        .collect();
    // By how each is said, whether used as a name or not: "tidepool mobile"
    // is never `tidepool`, though it asks about `tidepool-mobile`.
    let inside = |h: &Hit| {
        all.iter().any(|o| {
            o.p.to != h.p.to
                && o.said.at.start <= h.said.at.start
                && h.said.at.end <= o.said.at.end
                && (o.said.len > h.said.len || o.said.at.len() > h.said.at.len())
                && said_as(o.said.how) >= said_as(h.said.how)
        })
    };
    let kept: Vec<&Hit> = all.iter().filter(|h| !inside(h)).collect();
    let best = kept.iter().map(|h| strength(h)).max();
    let mut out: Vec<Hit> = Vec::new();
    for h in kept.into_iter().filter(|h| Some(strength(h)) == best) {
        match out.iter_mut().find(|o| o.p.to == h.p.to) {
            Some(o) if (h.said.how, h.said.len) > (o.said.how, o.said.len) => *o = h.clone(),
            Some(_) => {}
            None => out.push(h.clone()),
        }
    }
    out.sort_by_key(|h| std::cmp::Reverse((h.said.len, h.said.how, h.p.used)));
    out
}

/// How strongly the words say a name, by how alone: written or joined, as
/// it sounds, a letter off.
fn said_as(how: How) -> u8 {
    match how {
        How::Near => 0,
        How::Sounds => 1,
        How::Joined | How::Written => 2,
    }
}

/// A name written or joined is as strong as another: both are what the
/// person meant to say. One said as it sounds is weaker; one a letter off,
/// or words that are a name but not used as one, the weakest.
fn strength(h: &Hit) -> u8 {
    match h.plain {
        true => 0,
        false => said_as(h.said.how),
    }
}

/// Whether the words that say a name are words of their own, with spaces
/// between, each of two letters or more: "harbor master" for
/// `harbormaster`, "snow line" for `snow-line`. Such words are as likely to
/// be meant as words. Not letters said one by one ("ledger A P I"), a
/// number, or the name written with what joins its parts (`snow-line`,
/// `snow_line`).
fn apart(r: &Request, w: &Words, said: &Said) -> bool {
    let at = said.at.clone();
    let spaced = (at.start..at.end - 1).all(|i| {
        let between = &r.text[w.spans[i].end..w.spans[i + 1].start];
        between.chars().all(char::is_whitespace)
    });
    at.len() >= 2
        && spaced
        && (w.words[at].iter())
            .all(|x| x.chars().count() >= 2 && x.chars().all(char::is_alphabetic))
}

/// Whether a name said decides alone where a thought goes: written or
/// joined and used as a name, where it is everyday words or words written
/// apart. A name said only as it sounds is proposed and asked about.
fn decides(h: &Hit) -> bool {
    strength(h) == 2
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
        _ if h.plain && h.said.at.len() == 1 => format!("you wrote “{words}”"),
        _ if h.plain => format!("said as “{words}”"),
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
/// decide where it goes: in Tasktap's window the chip says that place, as
/// before a model decided every task ([`hint`]). A question the names
/// alone would ask (two projects named alike) is sure too; one they ask
/// only because a name may not be meant is not.
pub fn sure(r: &Request) -> bool {
    match by_names(r) {
        Some(Route::Ambiguous { .. }) => {
            let named = hits(r);
            let sessions = r.sessions.iter().any(|s| follows(&r.text, s));
            sessions || named.iter().any(decides)
        }
        // One project only leads: not said for certain.
        Some(Route::Clear {
            said: Some(state::Said::Leads { .. }),
            ..
        }) => false,
        Some(_) => true,
        None => false,
    }
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
    // The Scratchpad said as a place, with no project or session named: a
    // new run there, unless the person is in a session there already.
    let scratch = (r.scratch.filter(|_| scratchpad(&r.text)))
        .filter(|&p| current.is_none_or(|c| c.project != p));
    match (sessions.as_slice(), current, named.as_slice()) {
        ([s], ..) if only_in(s.project) => Some(clear(Destination::Session(s.id), None)),
        ([], _, []) if scratch.is_some() => scratch.map(|p| clear(Destination::New(p), None)),
        ([], Some(c), _) if only_in(c.project) => Some(clear(Destination::Session(c.id), None)),
        ([], _, [h]) if decides(h) => match around(r, h) {
            // A name written inside another's name nearly said decides
            // nothing: both are asked about, the longer first.
            Some(q) => Some(Route::Ambiguous {
                prompt: WHERE.into(),
                candidates: vec![
                    Candidate {
                        label: q.name.clone(),
                        to: q.to,
                        why: close_to(r, q),
                    },
                    Candidate {
                        label: h.p.name.clone(),
                        to: h.p.to,
                        why: why_said(r, h),
                    },
                ],
                brief: None,
            }),
            None => Some(clear(h.p.to, quoted(r, h).map(state::Said::As))),
        },
        // Where no name is said for certain, the project that clearly
        // leads; else nothing decides.
        ([], _, []) => lead(r),
        _ => {
            // A name said as it sounds ("queue grid" for `cuegrid`), a letter
            // off ("carrier" for `farrier`), or an everyday word ("write a
            // test") is asked about, first among what else fits; unless one
            // project clearly leads.
            let near = sessions.is_empty() && !named.iter().any(decides);
            if let Some(lead) = lead(r).filter(|_| near) {
                return Some(lead);
            }
            // A name written as it is is its own reason; otherwise the
            // question says how it was said ([`why_said`]).
            let projects = named.iter().map(|h| Candidate {
                label: h.p.name.clone(),
                to: h.p.to,
                why: why_said(r, h),
            });
            let sessions = sessions.iter().map(|s| Candidate {
                label: s.name.clone().unwrap_or_else(|| s.label.clone()),
                to: Destination::Session(s.id),
                why: String::new(),
            });
            let mut candidates: Vec<_> = match near {
                false => projects.chain(sessions).collect(),
                true => (offered(r, CHOICES).into_iter())
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

/// Words before the Scratchpad said as a place, in English and German, as
/// they end: "on the scratchpad", "in my scratch pad", "im Scratchpad",
/// "auf dem Scratchpad".
const ON_PAD: &[&[&str]] = &[
    &["in"],
    &["into"],
    &["inside"],
    &["on"],
    &["to"],
    &["in", "the"],
    &["into", "the"],
    &["inside", "the"],
    &["on", "the"],
    &["to", "the"],
    &["in", "my"],
    &["into", "my"],
    &["inside", "my"],
    &["on", "my"],
    &["to", "my"],
    &["im"],
    &["ins"],
    &["aufs"],
    &["in", "das"],
    &["in", "dem"],
    &["auf", "dem"],
];

/// Whether a request's capture says the Scratchpad as a place, where there
/// is one: the person's own place, as a pick is ([`scratchpad`]).
pub fn on_pad(r: &Request) -> bool {
    r.scratch.is_some() && scratchpad(&r.text)
}

/// The request for the brief of a thought the person placed at `to`: the
/// task and that place, nothing more; no other project or session, no
/// earlier task, nothing in view.
pub fn only(mut r: Request, to: Destination) -> Request {
    let project = match to {
        Destination::Session(id) => (r.sessions.iter())
            .find(|s| s.id == id)
            .map(|s| Destination::New(s.project)),
        place => Some(place),
    };
    r.sessions.retain(|s| Destination::Session(s.id) == to);
    r.projects.retain(|p| Some(p.to) == project);
    (r.current, r.view) = (None, None);
    (r.recent, r.earlier, r.top) = (Vec::new(), Vec::new(), Vec::new());
    r
}

/// Whether the capture says the Scratchpad as a place: "scratchpad" or
/// "scratch pad" right after one of [`ON_PAD`]. Never the word "scratch"
/// alone: "from scratch", "the scratch directory", "a game in Scratch",
/// "scratch paper" name no place; nor "a scratchpad".
fn scratchpad(text: &str) -> bool {
    let w = names::words(text).words;
    let word = |i: usize| w.get(i).map(String::as_str);
    (0..w.len()).any(|i| {
        let pad = word(i) == Some("scratchpad")
            || (word(i) == Some("scratch") && word(i + 1) == Some("pad"));
        let before = |n: usize| i.checked_sub(n).map(|at| &w[at..i]);
        let said = |on: &&[&str]| {
            before(on.len()).is_some_and(|b| b.iter().map(String::as_str).eq(on.iter().copied()))
        };
        pad && ON_PAD.iter().any(said)
    })
}

/// Another project whose name the words nearly say around a name said
/// ([`names::nearly`]: "the zentrix syncs" around "zentrix", with
/// `zentrix-sync`): the longer is as likely meant.
fn around<'r>(r: &'r Request, h: &Hit) -> Option<&'r Named> {
    let w = name_words(&r.text);
    let at = &h.said.at;
    let holds = |o: &Range<usize>| o.start <= at.start && at.end <= o.end && o.len() > at.len();
    (r.projects.iter()).filter(|q| q.to != h.p.to).find(|q| {
        let names = std::iter::once(&q.name).chain(&q.aliases);
        names
            .into_iter()
            .any(|n| names::nearly(&w, n).iter().any(holds))
    })
}

/// Whether a thought no name places for certain starts in the project that
/// clearly leads ([`lead`]). `false` asks, as before there was the rule.
pub const LEAD: bool = true;

/// What a thought's words give each project and no other
/// ([`names::evidence`]). An everyday word, one or many ("note" as
/// "notes"), and the name of an agent (a thought names the agent it is for
/// as often as its project), count for nothing.
fn weigh(r: &Request) -> Vec<Vec<names::Evidence>> {
    let agents = agent_words();
    let none = |x: &str| {
        let many = format!("{x}s");
        EVERYDAY.contains(&x) || EVERYDAY.contains(&many.as_str()) || agents.iter().any(|a| a == x)
    };
    let known: Vec<names::Known> = (r.projects.iter())
        .map(|p| names::Known {
            names: (std::iter::once(&p.name).chain(&p.aliases))
                .map(String::as_str)
                .collect(),
            about: &p.about,
        })
        .collect();
    names::evidence(&name_words(&r.text), &known, &r.words, &none)
}

/// The words of every agent's id and name: a thought names the agent it is
/// for as often as its project.
fn agent_words() -> Vec<String> {
    (agents::all().into_iter())
        .flat_map(|a| [parts(a.id()), parts(a.name())].concat())
        .collect()
}

/// How much a project's evidence weighs: its whole name nearly said 2, a
/// word only its name has 1, a word only its line has 1.
fn score(e: &[names::Evidence]) -> usize {
    (e.iter())
        .map(|e| match e.piece {
            names::Piece::Name => 2,
            names::Piece::Word | names::Piece::About => 1,
        })
        .sum()
}

/// The project the thought's words point at more than at any other, by
/// what only it has, something of its name among it; none where two tie.
fn top(weighed: &[Vec<names::Evidence>]) -> Option<usize> {
    let scores: Vec<usize> = weighed.iter().map(|e| score(e)).collect();
    let best = (0..scores.len()).max_by_key(|k| scores[*k])?;
    let alone = scores.iter().filter(|s| **s == scores[best]).count() == 1;
    let named = weighed[best].iter().any(|e| e.piece != names::Piece::About);
    (alone && named).then_some(best)
}

/// Why a project leads, in a few words: "its name and “widgetpack”".
fn why_led(r: &Request, e: &[names::Evidence]) -> String {
    let w = name_words(&r.text);
    let all: Vec<String> = (e.iter())
        .map(|e| match e.piece {
            names::Piece::Name => "its name".to_owned(),
            _ => format!(
                "“{}”",
                &r.text[w.spans[e.at.start].start..w.spans[e.at.end - 1].end]
            ),
        })
        .collect();
    match all.split_last() {
        Some((last, [])) => last.clone(),
        Some((last, rest)) => format!("{} and {last}", rest.join(", ")),
        None => String::new(),
    }
}

/// Where no name is said for certain, the project that clearly leads: its
/// whole name nearly said, with a word made up for it, and one thing more
/// only it has (at least 3 by [`score`], from two words of the thought or
/// more). A word of its name alone never leads, however much else fits: a
/// project named after a tool ("jira-bot") is not meant whenever the tool
/// is. Of every other project nothing is said but words several share,
/// but for one word only one other's line has ("snippets", where
/// `vexa-snippets` says it): never anything of another's name, and never a
/// name the thought says in any way, but an everyday word's. It starts
/// there, held to be undone as any thought; its line says why. A name said
/// only as it sounds, a letter off or in ordinary words alone ("harbor
/// master"), or in a tool's name and ordinary words ("tmux layout"), is no
/// evidence of its own: never a lead. With no dictionary to read (on
/// Windows) every word is ordinary, so nothing leads.
fn lead(r: &Request) -> Option<Route> {
    if !LEAD {
        return None;
    }
    let weighed = weigh(r);
    let k = top(&weighed)?;
    let (p, e) = (&r.projects[k], &weighed[k]);
    let others: Vec<&Vec<names::Evidence>> = (weighed.iter().enumerate())
        .filter(|(o, e)| *o != k && !e.is_empty())
        .map(|(_, e)| e)
        .collect();
    let little = match others.as_slice() {
        [] => true,
        [one] => matches!(one.as_slice(), [e] if e.piece == names::Piece::About),
        _ => false,
    };
    let whole = e.iter().any(|e| e.piece == names::Piece::Name);
    if !whole || score(e) < 3 || e.len() < 2 || !little {
        return None;
    }
    let w = name_words(&r.text);
    let said = |q: &Named| {
        let names = std::iter::once(&q.name).chain(&q.aliases);
        names
            .filter(|n| !everyday(n))
            .any(|n| !said(&w, n).is_empty())
    };
    if r.projects.iter().any(|q| q.to != p.to && said(q)) {
        return None;
    }
    let words = (e.iter())
        .find(|e| e.piece == names::Piece::Name)
        .map(|e| r.text[w.spans[e.at.start].start..w.spans[e.at.end - 1].end].to_owned());
    Some(Route::Clear {
        to: p.to,
        brief: r.text.clone(),
        said: Some(state::Said::Leads {
            why: why_led(r, e),
            words,
        }),
    })
}

/// Where a capture that names nothing may go: always asked about, with the
/// projects it names or clearly describes ([`offered`], three at most),
/// which may be none; where the agent should work when no project is known
/// at all. Never a project only because it was worked on lately.
pub fn unsure(r: &Request) -> Route {
    let mut candidates: Vec<Candidate> = (offered(r, CHOICES).into_iter())
        .map(|(p, why)| Candidate {
            label: p.name.clone(),
            to: p.to,
            why,
        })
        .collect();
    // The workspace in view leads, where a model was to decide (only then
    // is it told).
    let view = r.view.map(Destination::New);
    if let Some(p) = r.projects.iter().find(|p| Some(p.to) == view) {
        candidates.retain(|c| c.to != p.to);
        let why = String::new();
        let (label, to) = (p.name.clone(), p.to);
        candidates.insert(0, Candidate { label, to, why });
        candidates.truncate(CHOICES);
    }
    let prompt = match r.projects.is_empty() {
        true => WORK,
        false => WHERE,
    };
    Route::Ambiguous {
        prompt: prompt.into(),
        candidates,
        brief: None,
    }
}

/// The order a model is shown the projects in ([`narrow`]), at most `most`:
/// those a capture points at by its own words ([`likely`]); then where the
/// last thought went; then the most recently worked on. Never what the
/// person is offered: recency is no reason a task belongs somewhere.
pub fn ranked(r: &Request, most: usize) -> Vec<(&Named, String)> {
    let mut out = likely(r, most);
    let add = |p, why: String, out: &mut Vec<_>| push(out, most, p, why);
    if let Some(last) = r.last
        && let Some(p) = r.projects.iter().find(|p| p.to == last)
    {
        add(p, "where your last task went".into(), &mut out);
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

/// The projects a capture points at by its own words, at most `most`,
/// each with why: the one it points at most by what only that one has
/// ([`top`]); those it names, also those whose name its words are without
/// using them as one (asked about with it first); those it gives something
/// of their name only they have, the most first; then those whose line
/// about them shares its rarer words; a name a letter off after the lines
/// that share two words or more. Nothing else: none when its words point
/// at none.
pub fn likely(r: &Request, most: usize) -> Vec<(&Named, String)> {
    let mut out: Vec<(&Named, String)> = Vec::new();
    let add = |p, why: String, out: &mut Vec<_>| push(out, most, p, why);
    let weighed = weigh(r);
    if let Some(k) = top(&weighed) {
        add(&r.projects[k], why_led(r, &weighed[k]), &mut out);
    }
    let named = hits(r);
    let (near, said): (Vec<&Hit>, Vec<&Hit>) = named.iter().partition(|h| h.said.how == How::Near);
    for h in said {
        add(h.p, why_named(r, h), &mut out);
    }
    let mut of_name: Vec<usize> = (0..weighed.len())
        .filter(|k| weighed[*k].iter().any(|e| e.piece != names::Piece::About))
        .collect();
    of_name.sort_by_key(|k| std::cmp::Reverse((score(&weighed[*k]), r.projects[*k].used)));
    for k in of_name {
        add(&r.projects[k], why_led(r, &weighed[k]), &mut out);
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
    out
}

/// What the router's question offers the person (the owner's rule of
/// 2026-11-21), at most `most`, each with its reason: the projects the
/// capture names, as written (nothing is said after it), otherwise as
/// [`why_said`] says; then those whose line about them it clearly
/// describes ([`clearly`]), with the words it matches; then those a
/// letter off, and those whose name it says only as words. Nothing else: never a project only because it was worked on
/// lately, nor for evidence of these kinds alone; none when nothing of
/// these points anywhere. Unlike [`likely`] (what a field finds, and the
/// order a model is shown), it reads no dictionary of its own.
pub fn offered(r: &Request, most: usize) -> Vec<(&Named, String)> {
    let mut out: Vec<(&Named, String)> = Vec::new();
    let named = hits(r);
    // A name a letter off, or words that are a name but not used as one,
    // come after the lines it clearly describes.
    let (weak, said): (Vec<&Hit>, Vec<&Hit>) =
        (named.iter()).partition(|h| h.plain || h.said.how == How::Near);
    for h in said {
        push(&mut out, most, h.p, why_said(r, h));
    }
    let lines: Vec<String> = (r.projects.iter())
        .map(|p| {
            let names = std::iter::once(&p.name).chain(&p.aliases);
            let names: Vec<String> = names.flat_map(|n| parts(n)).collect();
            format!("{} {}", names.join(" "), p.about)
        })
        .collect();
    let agents = agent_words();
    let fits = names::fit(&r.text, &lines);
    let mut described: Vec<(usize, f64, Vec<&String>)> = (fits.iter().enumerate())
        .filter_map(|(i, (score, shared))| {
            let meant: Vec<&String> = (shared.iter()).filter(|x| meaningful(x, &agents)).collect();
            clearly(&meant).then_some((i, *score, meant))
        })
        .collect();
    described.sort_by(|a, b| {
        let (pa, pb) = (&r.projects[a.0], &r.projects[b.0]);
        b.1.total_cmp(&a.1).then_with(|| pb.used.cmp(&pa.used))
    });
    for (i, _, meant) in described {
        let words: Vec<String> = (meant.iter().take(3)).map(|x| format!("“{x}”")).collect();
        push(
            &mut out,
            most,
            &r.projects[i],
            format!("matches {}", words.join(", ")),
        );
    }
    for h in weak {
        push(&mut out, most, h.p, why_said(r, h));
    }
    // A name nearly said, as a plural or with its parts apart ("the harbor
    // masters" for `harbormaster`), as a letter off is; never an everyday
    // word's.
    for p in r.projects.iter().filter(|p| !everyday(&p.name)) {
        let close = close_to(r, p);
        if !close.is_empty() {
            push(&mut out, most, p, close);
        }
    }
    out
}

/// Why the question offers a project the capture names: nothing where its
/// name is written as it is; "written as “cue grid”" where its parts are
/// written apart; "sounds like “pie right”"; "close to “earshut”" a letter
/// off; "you wrote “test”" for an everyday word, or ordinary words, not used
/// as a name.
fn why_said(r: &Request, h: &Hit) -> String {
    let words = &r.text[h.said.span.clone()];
    match h.said.how {
        How::Near => format!("close to “{words}”"),
        How::Sounds => format!("sounds like “{words}”"),
        _ if h.plain => format!("you wrote “{words}”"),
        How::Joined => format!("written as “{words}”"),
        How::Written => String::new(),
    }
}

/// Why the question offers a project whose name the capture nearly says
/// ([`names::nearly`]): the words it nearly says; nothing where it says
/// none of its names nearly.
fn close_to(r: &Request, q: &Named) -> String {
    let w = name_words(&r.text);
    let names = std::iter::once(&q.name).chain(&q.aliases);
    let at = names.flat_map(|n| names::nearly(&w, n)).next();
    at.filter(|at| !at.is_empty())
        .map(|at| {
            format!(
                "close to “{}”",
                &r.text[w.spans[at.start].start..w.spans[at.end - 1].end]
            )
        })
        .unwrap_or_default()
}

/// Words that say nothing of which project is meant, beside the common ones
/// [`names::telling`] leaves out already: function words of English and of
/// German, and words that only say a name is one.
const FUNCTION: &[&str] = &[
    // English
    "across",
    "another",
    "each",
    "every",
    "few",
    "here",
    "little",
    "many",
    "most",
    "much",
    "never",
    "off",
    "other",
    "over",
    "small",
    "big",
    "large",
    "through",
    "today",
    "tomorrow",
    "under",
    "within",
    "without",
    "yesterday",
    "repository",
    "workspace",
    "codebase",
    "repo",
    "project",
    // German
    "aber",
    "alle",
    "alles",
    "auch",
    "auf",
    "aufs",
    "aus",
    "beim",
    "bin",
    "bist",
    "bitte",
    "dann",
    "das",
    "dass",
    "dein",
    "deine",
    "dem",
    "den",
    "der",
    "des",
    "die",
    "dir",
    "doch",
    "durch",
    "ein",
    "eine",
    "einem",
    "einen",
    "einer",
    "eines",
    "etwas",
    "euch",
    "für",
    "gegen",
    "geht",
    "gibt",
    "habe",
    "haben",
    "hat",
    "heute",
    "hier",
    "ich",
    "ihr",
    "ihre",
    "ins",
    "ist",
    "jetzt",
    "kann",
    "kannst",
    "kein",
    "keine",
    "können",
    "mal",
    "man",
    "mehr",
    "mein",
    "meine",
    "mich",
    "mir",
    "mit",
    "morgen",
    "muss",
    "musst",
    "müssen",
    "nach",
    "nein",
    "neu",
    "neue",
    "neuen",
    "nicht",
    "noch",
    "nur",
    "oder",
    "ohne",
    "projekt",
    "schon",
    "sehr",
    "sein",
    "seine",
    "sich",
    "sie",
    "sind",
    "soll",
    "sollte",
    "über",
    "und",
    "uns",
    "unser",
    "unter",
    "vom",
    "von",
    "vor",
    "war",
    "was",
    "weil",
    "wenn",
    "werden",
    "wie",
    "will",
    "wir",
    "wird",
    "zum",
    "zur",
];

/// Everyday words of a person's work beyond the names [`EVERYDAY`] holds:
/// one of them and another word is a description; alone, none.
const OF_WORK: &[&str] = &[
    "download", "file", "folder", "page", "pdf", "podcast", "tool",
];

/// A word and the forms it is listed in: as it is, and without its plural's
/// ending ("podcasts", "files", "boxes").
fn forms(x: &str) -> [&str; 3] {
    [
        x,
        x.strip_suffix('s').unwrap_or(x),
        x.strip_suffix("es").unwrap_or(x),
    ]
}

/// Whether a word a capture shares with a project's line says something of
/// which project is meant: no function word ([`FUNCTION`]), no word that
/// says a name is one, no agent's name.
fn meaningful(x: &str, agents: &[String]) -> bool {
    !forms(x)
        .iter()
        .any(|f| FUNCTION.contains(f) || AFTER_NAME.contains(f))
        && !agents.iter().any(|a| a == x)
}

/// Whether the meaningful words a capture shares with a project's line
/// clearly describe it: two of them at least, and not only everyday words
/// of work ("server", "site", "pdf"): "static site" describes a static site
/// generator; "server" alone, or "pdf downloads", describes nothing.
fn clearly(meant: &[&String]) -> bool {
    let work = |x: &&String| {
        forms(x)
            .iter()
            .any(|f| EVERYDAY.contains(f) || OF_WORK.contains(f))
    };
    meant.len() >= 2 && !meant.iter().all(work)
}

/// Adds a project to a list of at most `most`, once.
fn push<'r>(out: &mut Vec<(&'r Named, String)>, most: usize, p: &'r Named, why: String) {
    if out.len() < most && !out.iter().any(|(q, _)| q.to == p.to) {
        out.push((p, why));
    }
}

/// How well what is typed in a field to find a project matches one of its
/// names, the best first; none when it does not.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Typed {
    /// The name, its parts joined or split as typed: "cue grid", "cuegrid".
    Whole,
    /// The name's beginning: "harb" for `harbormaster`.
    Begins,
    /// The beginnings of its parts, each typed word one: "led ap" for
    /// `ledger-api`, "api" for `ledger-api`.
    Parts,
    /// Somewhere in it, two letters or more: "master" for `harbormaster`.
    Within,
    /// The beginnings of words of the line about it, three letters or more
    /// each: "invoic" for "Invoicing for freelancers".
    About,
    /// Only as it sounds, or a letter off: asked only when nothing else is.
    Sounds,
}

/// What a field to find a project finds for the words typed in it
/// (`r.text`): the projects whose names they match, by the beginning, the
/// beginnings of its parts, joined or split, anywhere in it, or the line
/// about it; only when none does, those it sounds like or is a letter off
/// from. At most `most`, the best match first, then the most recently
/// worked on. Nothing for nothing typed, and nothing when nothing matches:
/// never a project only because it was worked on lately.
pub fn typed(r: &Request, most: usize) -> Vec<(&Named, String)> {
    let w = name_words(&r.text);
    if w.words.is_empty() {
        return Vec::new();
    }
    let query: String = w.words.concat();
    let long = query.chars().count();
    let folder_name = |p: &Named| {
        std::path::Path::new(&p.folder)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
    };
    let mut found: Vec<(Typed, &Named, String)> = Vec::new();
    for p in &r.projects {
        let names: Vec<String> = std::iter::once(p.name.clone())
            .chain(p.aliases.iter().cloned())
            .chain(folder_name(p))
            .collect();
        let by_name = names.iter().filter_map(|n| {
            let parts = parts(n);
            let joined = parts.concat();
            match () {
                _ if joined.is_empty() => None,
                _ if joined == query => Some(Typed::Whole),
                _ if joined.starts_with(&query) => Some(Typed::Begins),
                _ if w
                    .words
                    .iter()
                    .all(|t| parts.iter().any(|p| p.starts_with(t.as_str()))) =>
                {
                    Some(Typed::Parts)
                }
                _ if long >= 2 && joined.contains(&query) => Some(Typed::Within),
                _ => None,
            }
        });
        if let Some(best) = by_name.min() {
            found.push((best, p, String::new()));
            continue;
        }
        let about = name_words(&p.about).words;
        let fits =
            |t: &String| t.chars().count() >= 3 && about.iter().any(|a| a.starts_with(t.as_str()));
        if !about.is_empty() && w.words.iter().all(fits) {
            let shared = (about.iter())
                .filter(|a| w.words.iter().any(|t| a.starts_with(t.as_str())))
                .take(3)
                .cloned()
                .collect::<Vec<_>>();
            found.push((Typed::About, p, shared.join(", ")));
        }
    }
    if found.is_empty() && long >= 4 {
        let key = sound(&query);
        for p in &r.projects {
            let names = std::iter::once(&p.name).chain(&p.aliases);
            let alike = names.map(|n| parts(n).concat()).any(|n| {
                (key.chars().count() >= 3 && sound(&n) == key) || names::one_off(&n, &query)
            });
            if alike {
                found.push((Typed::Sounds, p, "sounds like it".into()));
            }
        }
    }
    found.sort_by(|a, b| {
        (a.0.cmp(&b.0))
            .then_with(|| b.1.used.cmp(&a.1.used))
            .then_with(|| a.1.name.cmp(&b.1.name))
    });
    let mut out = Vec::new();
    for (_, p, why) in found {
        push(&mut out, most, p, why);
    }
    out
}

/// What a router question asks.
pub const WHERE: &str = "Which project is this task for?";
/// What it asks when no project is known at all.
const WORK: &str = "Where should the agent work?";

/// The request as a model is given it (design §8), read from the store:
/// each session's first and last request, how long ago its last turn
/// began (`now`: the time the ages count to), what its agent last answered
/// and whether it waits on a question; each project's earlier tasks; then
/// [`order`]'s 8 projects and 8 sessions, and the 3 latest exchanges with
/// those sessions. The tops of their folders are read after, off the
/// core's thread ([`tops`]).
pub fn narrow(tx: &Tx, mut r: Request, now: Time) -> store::Result<Request> {
    for s in &mut r.sessions {
        let turns = tx.turns(s.id)?;
        let latest = turns.iter().rev().find(|t| t.phase != Phase::Captured);
        let last = turns.iter().find(|t| Some(t.id) == s.thought);
        s.first = turns.first().map(|t| cut(&t.text, 180)).unwrap_or_default();
        s.task = last.map(|t| cut(&t.text, 180)).unwrap_or_default();
        s.ago = latest.map(|t| now.get().saturating_sub(t.created.get()));
        s.summary = match latest {
            Some(t) => cut(&tx.summary(t.id)?.unwrap_or_default(), 160),
            None => String::new(),
        };
        s.asks = tx.open_asked(s.id)?.0 > 0;
    }
    r.earlier = earlier(tx, &r)?;
    let mut r = order(r);
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

/// Which of the request's projects and sessions a model is given, and in
/// what order: at most 8 of each, never all of them. The projects: those
/// the capture names, then the current session's, then the workspace in
/// view, then where the last task went and the [`RECENT_PROJECTS`] worked
/// on most recently, then those whose earlier tasks its words are like,
/// then the others this machine ranks likeliest ([`ranked`]: by the line about
/// each, where the last thought went, how recently each was worked on),
/// workspaces and known projects alike. The sessions: those it names, then
/// the current one, then by how recent their last turn is; only those in
/// the projects given. What the request holds of the others goes.
pub fn order(mut r: Request) -> Request {
    let (current, text) = (r.current, r.text.clone());
    // The most recent turn first, the newest of those with none after them;
    // then what the capture points at before the rest.
    r.sessions.reverse();
    let mut sessions: Vec<Followed> = Vec::new();
    for s in std::mem::take(&mut r.sessions) {
        let later = |o: &Followed| o.ago.is_none_or(|o| s.ago.is_some_and(|s| o > s));
        let at = s.ago.and_then(|_| sessions.iter().position(later));
        sessions.insert(at.unwrap_or(sessions.len()), s);
    }
    r.sessions = first(sessions, |s| Some(s.id) == current);
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
    let next = |to: Destination, rest: &mut Vec<Named>, projects: &mut Vec<Named>| {
        if let Some(at) = rest.iter().position(|p| p.to == to) {
            projects.push(rest.remove(at));
        }
    };
    let session = r
        .current
        .and_then(|c| r.sessions.iter().find(|s| s.id == c));
    if let Some(project) = session.map(|s| s.project) {
        next(Destination::New(project), &mut rest, &mut r.projects);
    }
    if let Some(view) = r.view {
        next(Destination::New(view), &mut rest, &mut r.projects);
    }
    // Words that only hint never push out where the person worked last.
    if let Some(last) = r.last {
        next(last, &mut rest, &mut r.projects);
    }
    let mut used: Vec<(Time, Destination)> = (rest.iter())
        .filter_map(|p| Some((p.used?, p.to)))
        .collect();
    used.sort_by_key(|(used, _)| std::cmp::Reverse(*used));
    for (_, to) in used.into_iter().take(RECENT_PROJECTS) {
        next(to, &mut rest, &mut r.projects);
    }
    for to in like_earlier(&text, &rest, &r.earlier) {
        next(to, &mut rest, &mut r.projects);
    }
    r.projects.extend(rest);
    r.projects.truncate(OFFERED);
    let given = |to: &Destination| r.projects.iter().any(|p| p.to == *to);
    r.sessions.retain(|s| given(&Destination::New(s.project)));
    r.earlier.retain(|(to, _)| given(to));
    r.top.retain(|(to, _)| given(to));
    r
}

/// Most earlier tasks of a project a model is shown, and most characters
/// of each one's title.
const EARLIER: usize = 5;
pub const EARLIER_TITLE: usize = 80;
/// Most names at the top of a project's folder a model is shown.
const TOP: usize = 15;

/// The titles of the latest tasks that ran in each project, the newest
/// first, as Tasktap keeps them: where a task ran in the end counts, after
/// a switch, an Undo and a new place, or an answer (`Tx::ran`). A title is
/// the one a model gave the work, else the task's first line.
fn earlier(tx: &Tx, r: &Request) -> store::Result<Vec<(Destination, Vec<String>)>> {
    let mut out: Vec<(Destination, Vec<String>)> = Vec::new();
    // A known project that opened as a task started there is that workspace.
    let card_of = |p: ProjectId| {
        (r.projects.iter())
            .find(|n| n.to == Destination::New(p))
            .map_or(Destination::New(p), |n| n.to)
    };
    for t in tx.ran(400)? {
        let to = match (t.project_id, t.card_id) {
            (Some(p), _) => card_of(p),
            (None, Some(c)) => Destination::Card(c),
            _ => continue,
        };
        let title = (t.route.as_ref().and_then(|r| r.title.clone()))
            .unwrap_or_else(|| t.text.lines().next().unwrap_or_default().to_owned());
        let title = cut(&title, EARLIER_TITLE);
        match out.iter_mut().find(|(d, _)| *d == to) {
            Some((_, titles)) if titles.len() >= EARLIER => {}
            Some((_, titles)) => titles.push(title),
            None => out.push((to, vec![title])),
        }
    }
    Ok(out)
}

/// The projects of `projects` whose earlier tasks the capture's words are
/// like, the likest first: two meaningful words or more shared with their
/// titles ([`names::fit`], [`clearly`]).
fn like_earlier(
    text: &str,
    projects: &[Named],
    earlier: &[(Destination, Vec<String>)],
) -> Vec<Destination> {
    let docs: Vec<String> = (projects.iter())
        .map(|p| {
            let titles = earlier.iter().find(|(to, _)| *to == p.to);
            titles.map(|(_, t)| t.join(". ")).unwrap_or_default()
        })
        .collect();
    let agents = agent_words();
    let mut like: Vec<(Destination, f64)> = (names::fit(text, &docs).iter().enumerate())
        .filter_map(|(i, (score, shared))| {
            let meant: Vec<&String> = shared.iter().filter(|x| meaningful(x, &agents)).collect();
            clearly(&meant).then_some((projects[i].to, *score))
        })
        .collect();
    like.sort_by(|a, b| b.1.total_cmp(&a.1));
    like.into_iter().map(|(to, _)| to).collect()
}

/// The names at the top of a folder, in order, hidden ones left out; none
/// when it cannot be read.
fn heads(folder: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    let entries = (entries.filter_map(Result::ok)).take(TOP_READ).map(|e| {
        let folder = e.file_type().is_ok_and(|t| t.is_dir());
        (e.file_name().to_string_lossy().into_owned(), folder)
    });
    top_of(entries)
}

/// Most entries of a project's folder read for its top.
const TOP_READ: usize = 2000;

/// Files that say what a project is, by name alone: the only files at a
/// project's top a model is told of.
const KNOWN_FILES: &[&str] = &[
    "package.json",
    "cargo.toml",
    "pyproject.toml",
    "setup.py",
    "requirements.txt",
    "go.mod",
    "gemfile",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "composer.json",
    "mix.exs",
    "deno.json",
    "pubspec.yaml",
    "package.swift",
    "cmakelists.txt",
    "makefile",
    "dockerfile",
    "docker-compose.yml",
    "readme",
    "readme.md",
    "readme.rst",
    "readme.txt",
    "license",
    "claude.md",
    "agents.md",
    "gemini.md",
];

/// Files known by a name with no dot in it: what the routing lab's corpus
/// lists at a project's top without saying it is a file ([`folder_named`]).
const DOTLESS: &[&str] = &[
    "gradlew",
    "mvnw",
    "makefile",
    "gnumakefile",
    "dockerfile",
    "containerfile",
    "vagrantfile",
    "brewfile",
    "procfile",
    "jenkinsfile",
    "snakefile",
    "gemfile",
    "rakefile",
    "podfile",
    "cartfile",
    "pipfile",
    "justfile",
    "guardfile",
    "capfile",
    "berksfile",
    "dangerfile",
    "fastfile",
    "appfile",
    "cname",
    "license",
    "licence",
    "copying",
    "notice",
    "authors",
    "contributors",
    "changelog",
    "readme",
    "version",
    "codeowners",
    "artisan",
    "project",
    "_redirects",
    "_headers",
];

/// Whether a name the routing lab's corpus lists at a project's top, which
/// does not say what each is, stands for a folder: one without a dot that
/// is no well-known file (`gradlew`, `Brewfile`, `LICENSE`), so the lab's
/// top is the one [`tops`] reads from the disk.
pub fn folder_named(name: &str) -> bool {
    !name.contains('.') && !DOTLESS.contains(&name.to_lowercase().as_str())
}

/// The names at a project's top a model is told of, from its entries
/// (`name`, whether a folder): its folders and the well-known project
/// files ([`KNOWN_FILES`]), none hidden, in order, at most [`TOP`]. No
/// other file's name.
pub fn top_of(entries: impl IntoIterator<Item = (String, bool)>) -> Vec<String> {
    let mut names: Vec<String> = (entries.into_iter())
        .filter(|(n, folder)| {
            !n.starts_with('.') && (*folder || KNOWN_FILES.contains(&n.to_lowercase().as_str()))
        })
        .map(|(n, _)| n)
        .collect();
    names.sort();
    names.truncate(TOP);
    names
}

/// The tops of the projects a model is given (`(place, folder)`), read
/// off the core's thread ([`top_of`]); a folder that does not answer
/// within `within` is sent without names, and placing goes on.
pub fn tops(
    folders: Vec<(Destination, String)>,
    within: std::time::Duration,
) -> Vec<(Destination, Vec<String>)> {
    tops_by(folders, within, heads)
}

/// The folders whose read has not returned yet ([`tops_by`]).
static READING: std::sync::Mutex<std::collections::BTreeSet<String>> =
    std::sync::Mutex::new(std::collections::BTreeSet::new());

/// [`tops`], each folder read by `read`. A folder whose read has not
/// returned yet, as one that hangs inside the system, is never read again
/// meanwhile: one reading thread per folder at most, and the folder is sent
/// without names until its read returns.
pub fn tops_by<R>(
    folders: Vec<(Destination, String)>,
    within: std::time::Duration,
    read: R,
) -> Vec<(Destination, Vec<String>)>
where
    R: Fn(&str) -> Vec<String> + Clone + Send + 'static,
{
    let reading = || READING.lock().unwrap_or_else(|e| e.into_inner());
    let (tell, told) = std::sync::mpsc::channel();
    for (to, folder) in folders {
        if !reading().insert(folder.clone()) {
            continue;
        }
        let (tell, read) = (tell.clone(), read.clone());
        std::thread::spawn(move || {
            let names = read(&folder);
            reading().remove(&folder);
            drop(tell.send((to, names)));
        });
    }
    drop(tell);
    let until = std::time::Instant::now() + within;
    let mut out = Vec::new();
    while let Ok(top) =
        told.recv_timeout(until.saturating_duration_since(std::time::Instant::now()))
    {
        if !top.1.is_empty() {
            out.push(top);
        }
    }
    out
}

/// `all` with those that are `first` before the others, each in their order.
fn first<T>(all: Vec<T>, first: impl Fn(&T) -> bool) -> Vec<T> {
    let (mut front, back): (Vec<T>, Vec<T>) = all.into_iter().partition(first);
    front.extend(back);
    front
}

/// The first `chars` characters of `text` on one line.
pub fn cut(text: &str, chars: usize) -> String {
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
    format!("{INSTRUCTIONS}\n{}", asked(r))
}

/// What follows the instructions in [`question`]: the request as JSON,
/// between tags. ChatGPT takes the instructions in a field of their own.
pub fn asked(r: &Request) -> String {
    let project = |id: ProjectId| key(r, Destination::New(id));
    let session = |id: SessionId| key(r, Destination::Session(id));
    // Every text a word at a time: what looks like a secret is left out.
    let plain = |text: &str| redact(text);
    let of = |list: &[(Destination, Vec<String>)], to: Destination| -> Vec<String> {
        let all = list
            .iter()
            .find(|(d, _)| *d == to)
            .map(|(_, l)| l.as_slice());
        all.unwrap_or_default().iter().map(|t| redact(t)).collect()
    };
    let projects: Vec<_> = (r.projects.iter())
        .map(|p| {
            let aliases: Vec<_> = (p.aliases.iter().take(3))
                .map(|a| redact(&cut(a, 60)))
                .collect();
            json!({ "id": key(r, p.to), "name": redact(&cut(&p.name, 100)), "aliases": aliases,
                    "about": plain(&cut(&p.about, 160)), "earlier": of(&r.earlier, p.to),
                    "top": of(&r.top, p.to) })
        })
        .collect();
    let sessions: Vec<_> = (r.sessions.iter())
        .map(|s| {
            let state = match s.state {
                _ if s.asks => "waiting",
                SessionState::Starting | SessionState::Working => "working",
                SessionState::Idle | SessionState::Ended => "finished",
            };
            json!({ "id": session(s.id),
                    "name": s.name.as_deref().map(|n| redact(&cut(n, 140))),
                    "first": plain(&s.first), "task": plain(&s.task),
                    "project": project(s.project), "agent": s.agent, "state": state,
                    "ago": s.ago.map(ago), "summary": plain(&s.summary) })
        })
        .collect();
    let recent: Vec<_> = (r.recent.iter())
        .map(|e| {
            json!({ "session": session(e.session), "request": plain(&e.request),
                    "status": word(&e.status), "result": plain(&e.result) })
        })
        .collect();
    let request = json!({
        "thought": redact(&r.text),
        "current": r.current.and_then(session),
        "view": r.view.and_then(project),
        "picked": r.picked.and_then(|to| key(r, to)),
        "projects": projects,
        "sessions": sessions,
        "recent": recent,
    });
    format!("<request>\n{request}\n</request>\n")
}

/// How long ago, in the words a model reads: "now", "12 min", "3 h", "2 days".
fn ago(ms: u64) -> String {
    let minutes = ms / 60_000;
    match minutes {
        0 => "now".into(),
        1..60 => format!("{minutes} min"),
        60..2880 => format!("{} h", minutes / 60),
        _ => format!("{} days", minutes / 1440),
    }
}

/// What stands in a text sent to a model where a word looked like a secret.
pub const LEFT_OUT: &str = "[left out]";

/// A text as a model is sent it: each word that looks like a secret (a
/// key, a token, a password) replaced by [`LEFT_OUT`], the rest as it is,
/// so a task or a session keeps the words that place it. A wrong match
/// costs a few words, so it leans towards leaving out, but never an
/// everyday word of a coding task ("the key handler", "the token count",
/// "the password field"):
///
/// - after a password word (password, Passwort, passphrase; pass, pw and
///   pin too) joined by "is", "to", "ist", "lautet", ":" or "=", every word
///   to the end of the sentence or the line, six at most; right after one,
///   a word with a digit or a sign in it ("password hunter2"); after one
///   and "for", "of" and the like, the joiner up to five words on in the
///   same sentence ("the password for staging is hunter2"), never a noun
///   it names ("the password reset email is broken");
/// - after `-u` or `--user` on a command line, a `user:password`;
/// - after key, token or secret, only a word that looks like a secret by
///   itself; after Bearer, also a long one; after a "/" standing alone
///   ("admin / hunter2"), one with a digit or a sign;
/// - a value given to a name of a secret, written in capitals or of parts
///   (`PGPASSWORD=…`, `DB_PASS=…`, `x-api-key: …`, `token=…`, `pw: …`);
///   a word that names a secret itself is never taken for the value
///   ("ssh key passphrase: …");
/// - in a web address, a user's password, and the value of a query's
///   parameter that names a secret (key, token, secret, pass, pwd, sig,
///   auth, code) or looks like one by its shape; `?q=invoice+export` and
///   `?page=2` stay; a webhook's address whole;
/// - a word with a known key's beginning (`sk-`, `ghp_`, `xoxb-`, `AKIA`,
///   `eyJ`, …), also inside it;
/// - a long run of letters and digits, or of letters in mixed case.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    // What the words before said follows.
    let mut after: Option<Want> = None;
    let mut rest = text;
    while !rest.is_empty() {
        let space = rest
            .find(|c: char| !c.is_whitespace())
            .unwrap_or(rest.len());
        // A line ends what a password word said, once it took a word, and
        // the search for its joiner.
        let ended = matches!(after, Some(Want::Rest(n)) if n < REST)
            || matches!(after, Some(Want::Seek(_)));
        if rest[..space].contains('\n') && ended {
            after = None;
        }
        out.push_str(&rest[..space]);
        rest = &rest[space..];
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        if end == 0 {
            break;
        }
        let word = &rest[..end];
        rest = &rest[end..];
        let edge = |c: char| "\"'`()[]{}<>,;.!?".contains(c);
        let bare = word.trim_matches(edge);
        // A web address: its query's values and a user's password go, the
        // rest stays to place the task; a webhook's goes whole.
        if bare.contains("://") && !shaped(bare) {
            let start = word.len() - word.trim_start_matches(edge).len();
            out.push_str(&word[..start]);
            out.push_str(&address(bare));
            out.push_str(&word[start + bare.len()..]);
            after = None;
            continue;
        }
        let lower = bare.to_lowercase();
        let (name, value, joined) = match bare.split_once(['=', ':']) {
            Some((n, v)) => (n, v, true),
            None => (bare, "", false),
        };
        // What the word says of the next. A label ("passphrase:", "key")
        // is never taken for the value: it says the next word is.
        let own = (value.is_empty()).then(|| wants(name, joined)).flatten();
        let plain = [PASSWORD, PASS, MAYBE, &["bearer", "/", "-u", "--user"]]
            .iter()
            .any(|l| l.contains(&lower.as_str()));
        let label = own.is_some() && (joined || plain);
        let connects = CONNECT.contains(&lower.as_str());
        // "pass to", "pin to": verbs too, so joined by the other words only.
        let joins = |of: Of| connects && !(of == Of::Pass && lower == "to");
        // A user's password given to `--user=`.
        let user = name == "--user" && value.contains(':');
        let secret = shaped(bare)
            || user
            || (!value.is_empty() && holds(name))
            || match after {
                _ if label => false,
                Some(Want::Seek(_)) => false,
                Some(Want::User) => bare.contains(':'),
                Some(Want::Rest(_)) => true,
                Some(Want::Next) => !connects,
                Some(Want::Long) => !connects && (looks(bare) || bare.chars().count() >= 16),
                Some(Want::Looks(of)) => !joins(of) && looks(bare),
                None => false,
            };
        out.push_str(if secret { LEFT_OUT } else { word });
        let ends = word
            .trim_end_matches(['"', '\'', '`', ')', ']'])
            .ends_with(['.', '!', '?']);
        // A key's or a token's word does not stop the search for the joiner
        // ("the passphrase for the gpg key is …"); a password's does.
        let passes = matches!(
            own,
            None | Some(Want::Looks(Of::Key) | Want::Next | Want::Long)
        );
        let colon = joined && value.is_empty();
        after = match after {
            Some(Want::Seek(_)) if passes && (connects || colon) => Some(Want::Rest(REST)),
            Some(Want::Seek(n)) if passes && n > 1 && !ends => Some(Want::Seek(n - 1)),
            Some(Want::Seek(_)) if passes => None,
            _ if label || (own.is_some() && !secret) => own,
            // "password is", "Passwort lautet": the rest of the sentence.
            Some(Want::Looks(of @ (Of::Password | Of::Pass))) if joins(of) => {
                Some(Want::Rest(REST))
            }
            // "the password for staging is …": the joiner a few words on.
            Some(Want::Looks(Of::Password)) if FOR.contains(&lower.as_str()) && !ends => {
                Some(Want::Seek(SEEK))
            }
            Some(Want::Rest(n)) if secret && n > 1 && !ends => Some(Want::Rest(n - 1)),
            Some(w @ (Want::Looks(Of::Key) | Want::Next | Want::Long)) if connects => Some(w),
            _ => None,
        };
    }
    out
}

/// What the words before a word said of it ([`redact`]).
#[derive(Clone, Copy, PartialEq)]
enum Want {
    /// A word that looks like a secret by itself (a digit or a sign in
    /// it), after the word [`Of`] says; after a password word a joining
    /// word turns it into [`Want::Rest`].
    Looks(Of),
    /// After Bearer: also a long one.
    Long,
    /// After a name of a secret given its value (`API_TOKEN: …`): the next
    /// word, whatever it is.
    Next,
    /// After a password word and a joining word: every word to the end of
    /// the sentence or the line, this many at most.
    Rest(u8),
    /// After a password word and "for", "of" and the like: a joining word
    /// within this many words more, in the same sentence, turns it into
    /// [`Want::Rest`].
    Seek(u8),
    /// After `-u` or `--user`: a `user:password`.
    User,
}

/// The word a [`Want::Looks`] came after.
#[derive(Clone, Copy, PartialEq)]
enum Of {
    /// password, Passwort, passphrase, a password's name (`DB_PASS`).
    Password,
    /// pass, pw, pin, credentials: a password's words, and verbs or nouns
    /// of every task too ("pass to", "pin to"), so "to" does not join them.
    Pass,
    /// key, token, secret, a "/" alone: words of every task.
    Key,
}

/// How many words a password word and a joining word leave out at most.
const REST: u8 = 6;
/// How many words after "password for" a joining word is looked for: up
/// to five after the password word.
const SEEK: u8 = 4;
/// Words after a password word that say which one it is, before its
/// joiner: "the password for staging is …", "das Passwort für …".
const FOR: &[&str] = &[
    "for", "of", "on", "in", "at", "from", "für", "von", "vom", "zu", "zum", "bei", "auf",
];

/// Words that say a password follows them, and those that may say a key
/// or a token does.
const PASSWORD: &[&str] = &[
    "password",
    "passwords",
    "passwort",
    "passphrase",
    "passwd",
    "kennwort",
];
const PASS: &[&str] = &["pass", "pw", "pin", "credentials"];
const MAYBE: &[&str] = &[
    "secret", "secrets", "token", "tokens", "key", "keys", "apikey",
];
/// Words between the one that says a secret follows and the secret.
const CONNECT: &[&str] = &["is", "to", "ist", "lautet", "=", ":"];

/// What a word says of the word after it, `joined` where it ends in ":" or
/// "=" ("Passwort:", `API_TOKEN=`): a password word, a key's word, Bearer,
/// a "/" alone, or a name of a secret ([`named`]).
fn wants(name: &str, joined: bool) -> Option<Want> {
    let lower = name.to_lowercase();
    let password = PASSWORD.contains(&lower.as_str());
    let pass = PASS.contains(&lower.as_str());
    match named(name) {
        _ if (password || pass) && joined => Some(Want::Rest(REST)),
        _ if password => Some(Want::Looks(Of::Password)),
        _ if pass => Some(Want::Looks(Of::Pass)),
        _ if MAYBE.contains(&lower.as_str()) || name == "/" => Some(Want::Looks(Of::Key)),
        _ if !joined && (name == "-u" || name == "--user") => Some(Want::User),
        _ if lower == "bearer" => Some(Want::Long),
        Some(true) if joined => Some(Want::Rest(REST)),
        Some(true) => Some(Want::Looks(Of::Password)),
        Some(false) if joined => Some(Want::Next),
        Some(false) => Some(Want::Looks(Of::Key)),
        None => None,
    }
}

/// Whether a name given a value right after it (`token=…`, `PGPASSWORD=…`)
/// is one of a secret.
fn holds(name: &str) -> bool {
    let lower = name.to_lowercase();
    [PASSWORD, PASS, MAYBE]
        .iter()
        .any(|l| l.contains(&lower.as_str()))
        || named(name).is_some()
}

/// Whether a name is one of a secret, written as a name is: in capitals
/// with pass, pwd, secret, token or key anywhere in it (`PGPASSWORD`,
/// `SMTPPASS`), or of parts one of which is one (`db_pass`, `x-api-key`,
/// never `blue-monkey`); `true` where it is a password's (pass, pwd, pw,
/// pin).
fn named(name: &str) -> Option<bool> {
    let lower = name.to_lowercase();
    let parts: Vec<&str> = (lower.split(['_', '-', '.']))
        .filter(|p| !p.is_empty())
        .collect();
    let caps =
        name.chars().any(|c| c.is_ascii_uppercase()) && !name.chars().any(char::is_lowercase);
    if parts.len() < 2 && !caps {
        return None;
    }
    let has = |stems: &[&str]| {
        (parts.iter()).any(|p| {
            (stems.iter()).any(|s| match caps {
                true => p.contains(s),
                false => p.starts_with(s) || (*s == "key" && p.ends_with("apikey")),
            })
        })
    };
    if has(&["pass", "pwd"]) || parts.iter().any(|p| matches!(*p, "pw" | "pin")) {
        Some(true)
    } else if has(&["secret", "token", "key"]) || parts.contains(&"auth") {
        Some(false)
    } else {
        None
    }
}

/// A web address as a model is sent it: a user's password and the values
/// of its query that name or look like a secret left out, the rest as it
/// is.
fn address(word: &str) -> String {
    let Some(at) = word.find("://") else {
        return word.to_owned();
    };
    let (scheme, rest) = word.split_at(at + 3);
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (host, tail) = rest.split_at(end);
    let mut out = scheme.to_owned();
    match host.rfind('@') {
        Some(i) if host[..i].contains(':') => {
            out.push_str(LEFT_OUT);
            out.push_str(&host[i..]);
        }
        _ => out.push_str(host),
    }
    let (path, query) = match tail.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (tail, None),
    };
    out.push_str(path);
    if let Some(query) = query {
        let (query, fragment) = query.split_at(query.find('#').unwrap_or(query.len()));
        // Only what names a secret, or looks like one by its shape: a
        // search's words and a page's number place the task.
        const NAMES: &[&str] = &[
            "key", "token", "secret", "pass", "pwd", "sig", "auth", "code",
        ];
        let values: Vec<String> = (query.split('&'))
            .map(|pair| match pair.split_once('=') {
                Some((name, value))
                    if !value.is_empty()
                        && (NAMES.iter().any(|n| name.to_lowercase().contains(n))
                            || shaped(value)) =>
                {
                    format!("{name}={LEFT_OUT}")
                }
                _ => pair.to_owned(),
            })
            .collect();
        out.push('?');
        out.push_str(&values.join("&"));
        out.push_str(fragment);
    }
    out
}

/// Whether a word looks like a secret by itself, beside a word that says
/// one may follow: a digit or a sign in it (an apostrophe is none:
/// "handler's", nor a label's ":"), or the shape of one.
fn looks(word: &str) -> bool {
    let word = word.trim_end_matches([':', '=']);
    word.chars()
        .any(|c| !c.is_alphabetic() && !matches!(c, '\'' | '\u{2019}'))
        || shaped(word)
}

/// Whether a word looks like a secret by its shape alone ([`redact`]).
fn shaped(word: &str) -> bool {
    // A key's beginning, at the word's start.
    const START: &[&str] = &[
        "sk-", "sk_", "pk_live_", "rk_live_", "whsec_", "npm_", "pypi-", "hf_", "dop_v1_",
    ];
    // One that is a key's wherever it stands in a word, as written.
    const INSIDE: &[&str] = &[
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
        "glpat-",
        "xoxb-",
        "xoxp-",
        "xoxa-",
        "xapp-",
        "shpat_",
        "AKIA",
        "ASIA",
        "AIza",
        "eyJ",
    ];
    const HOOKS: &[&str] = &[
        "hooks.slack.com/",
        "discord.com/api/webhooks/",
        "discordapp.com/api/webhooks/",
        "webhook.office.com/",
        "outlook.office.com/webhook",
    ];
    let lower = word.to_lowercase();
    if HOOKS.iter().any(|h| lower.contains(h)) || lower.contains("-----begin") {
        return true;
    }
    let long = |from: usize| word.len() - from >= 8;
    let started = START.iter().any(|k| lower.starts_with(k) && long(k.len()));
    let inside = INSIDE
        .iter()
        .any(|k| word.match_indices(k).any(|(at, _)| long(at + k.len())));
    let count = word.chars().count();
    let digits = word.chars().any(|c| c.is_ascii_digit());
    let letters = word.chars().any(|c| c.is_ascii_alphabetic());
    let mixed = word.chars().any(|c| c.is_ascii_uppercase())
        && word.chars().any(|c| c.is_ascii_lowercase());
    let plain = word
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "_-+=".contains(c));
    let base64 = word
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "+/=".contains(c));
    started
        || inside
        || (plain && digits && letters && count >= 24)
        || (plain && mixed && count >= 32)
        || (base64 && digits && mixed && count >= 40)
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
    folder: String,
    title: String,
}

enum Confidence {
    Clear,
    New,
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
        // An answer to the terms before this one has no folder.
        let folder = match fields.remove("folder") {
            None => String::new(),
            Some(Value::String(folder)) => folder,
            Some(_) => return Err(wrong("folder is no text")),
        };
        let mut text = |key: &str| match fields.remove(key) {
            Some(Value::String(text)) => Ok(text),
            _ => Err(wrong(&format!("{key} is no text"))),
        };
        let (quote, to, brief) = (text("quote")?, text("to")?, text("brief")?);
        let title = text("title")?;
        let confidence = match text("confidence")?.as_str() {
            "clear" => Confidence::Clear,
            "new" => Confidence::New,
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
                folder,
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
            n if n > most => Err("its brief is longer than the task allows".to_owned()),
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
            // Also to the session in view: the view tells which, not whether.
            let follows = matches!(to, Destination::Session(_));
            if follows && !quoted {
                return Err("the words it quotes for a follow-up are not in the task".into());
            }
            let brief = brief()?;
            let said = None;
            Ok((
                Route::Clear { to, brief, said },
                found(quoted.then_some(quote)),
            ))
        }
        Confidence::New => {
            // A name that ends up empty is no new project: the question.
            let Some(name) = folder_name(&a.folder) else {
                return Ok((Route::Unknown, found(None)));
            };
            let route = Route::Create {
                prompt: WHERE.into(),
                project: NewProject {
                    name,
                    place: String::new(),
                    folder: String::new(),
                    exists: false,
                },
                candidates: Vec::new(),
                brief: Some(brief()?),
            };
            Ok((route, found(None)))
        }
        Confidence::Ambiguous => {
            let quote = a.quote.trim();
            let quoted = quote.chars().count() >= 3 && says(&r.text, quote);
            let mut candidates: Vec<Candidate> = Vec::new();
            for key in &a.candidates {
                let mut choice = offered(key)?;
                // A follow-up needs the task's words that lean on its
                // session, as a sure one does; without, a new run there.
                if let (Destination::Session(id), false) = (choice.to, quoted) {
                    let Some(run) = run_in(r, id) else { continue };
                    choice = run;
                }
                if !candidates.iter().any(|c| c.to == choice.to) {
                    candidates.push(choice);
                }
            }
            if candidates.is_empty() {
                return Err("it is unsure and names no choice".into());
            }
            // One alone is a decision that waits for a key too. At most three
            // choices, the likeliest first as it gave them.
            candidates.truncate(CHOICES);
            let route = Route::Torn {
                candidates,
                brief: Some(brief()?),
            };
            Ok((route, found(quoted.then_some(quote))))
        }
    }
}

/// A new run in the project of a session the request offers, as a choice.
fn run_in(r: &Request, session: SessionId) -> Option<Candidate> {
    let s = r.sessions.iter().find(|s| s.id == session)?;
    let p = (r.projects.iter()).find(|p| p.to == Destination::New(s.project))?;
    Some(Candidate {
        label: p.name.clone(),
        to: p.to,
        why: String::new(),
    })
}

/// A folder name as a model proposes one for a new project, made safe for
/// a folder on every system: lower-case ASCII letters and digits, words
/// joined by single dashes, beginning and ending with a letter or a digit,
/// at most 40 characters, and no name Windows keeps for a device; none
/// when nothing is left.
pub fn folder_name(proposed: &str) -> Option<String> {
    const KEPT: &[&str] = &["con", "prn", "aux", "nul"];
    let lower = proposed.trim().to_ascii_lowercase();
    let words = lower.split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()));
    let joined = words
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let name: String = joined.chars().take(40).collect();
    let name = name.trim_end_matches('-').to_owned();
    let device = |n: &str| {
        KEPT.contains(&n)
            || ((n.starts_with("com") || n.starts_with("lpt"))
                && n.len() == 4
                && n.as_bytes()[3].is_ascii_digit())
    };
    (!name.is_empty() && !device(&name)).then_some(name)
}

/// Where a new project goes: the folder that holds the most of the
/// projects the request knows, the one worked on most recently where two
/// hold as many; none when it knows no project with a folder.
pub fn home(r: &Request) -> Option<std::path::PathBuf> {
    let mut held: Vec<(std::path::PathBuf, usize, Option<Time>)> = Vec::new();
    for p in r.projects.iter().filter(|p| !p.folder.is_empty()) {
        let Some(up) = std::path::Path::new(&p.folder).parent() else {
            continue;
        };
        match held.iter_mut().find(|(f, ..)| f == up) {
            Some((_, n, used)) => (*n, *used) = (*n + 1, (*used).max(p.used)),
            None => held.push((up.to_path_buf(), 1, p.used)),
        }
    }
    held.into_iter()
        .max_by_key(|(_, n, used)| (*n, *used))
        .map(|(f, ..)| f)
}

/// The other vehicle for a thought placed at `to`, when there is one: for a
/// follow-up to a session, a new run in its project; for a new run in a
/// project, a follow-up to the session there whose last turn is the most
/// recent. The decision line offers it on a key of its own.
pub fn vehicle(r: &Request, to: Destination) -> Option<Destination> {
    match to {
        Destination::Session(id) => {
            let s = r.sessions.iter().find(|s| s.id == id)?;
            let project = Destination::New(s.project);
            r.projects
                .iter()
                .any(|p| p.to == project)
                .then_some(project)
        }
        Destination::New(project) => (r.sessions.iter())
            .filter(|s| s.project == project)
            .min_by_key(|s| s.ago.unwrap_or(u64::MAX))
            .map(|s| Destination::Session(s.id)),
        Destination::Card(_) => None,
    }
}

/// A new project a model proposed, as the person is asked about it,
/// completed where the core decides it: in the folder where most of their
/// projects are (`home`), first in the question the names ask (`unsure`,
/// whose places follow it). Where that folder is there already it is
/// offered only as the project Tasktap knows there (`known`); a folder
/// Tasktap knows as no project is never offered, and no project row is.
/// Without a home, that question alone.
pub fn create(
    route: Route,
    home: Option<&std::path::Path>,
    unsure: &Route,
    known: impl FnOnce(&std::path::Path) -> bool,
) -> Route {
    let (
        Route::Create {
            mut project, brief, ..
        },
        Some(home),
        Route::Ambiguous {
            prompt, candidates, ..
        },
    ) = (route, home, unsure)
    else {
        return unsure.clone();
    };
    let folder = home.join(&project.name);
    let exists = folder.exists();
    if exists && !known(&folder) {
        return unsure.clone();
    }
    project.place = as_known(home);
    project.folder = folder.to_string_lossy().into_owned();
    project.exists = exists;
    Route::Create {
        prompt: prompt.clone(),
        project,
        candidates: candidates.clone(),
        brief,
    }
}

/// A folder as the person writes it: their home as `~`.
fn as_known(folder: &std::path::Path) -> String {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    let rest = home.and_then(|h| {
        folder
            .strip_prefix(h)
            .ok()
            .map(std::path::Path::to_path_buf)
    });
    match rest {
        Some(rest) if rest.as_os_str().is_empty() => "~".into(),
        Some(rest) => format!("~{}{}", std::path::MAIN_SEPARATOR, rest.display()),
        None => folder.display().to_string(),
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
        false => Err(format!("the task is longer than {MAX_THOUGHT} characters")),
    }
}

/// Whether an agreement names what this core would ask: these terms, and
/// each agent once, one this core has, whose tool it would ask for the
/// model agreed to. ChatGPT, while signed in (`chatgpt`: the model the
/// sign-in chose), for that model; while not, it is asked nothing, and its
/// row stands as it is.
pub fn valid(by: &RouteBy, chatgpt: Option<&str>) -> Result<(), String> {
    if by.terms != TERMS {
        return Err(AGAIN.into());
    }
    for (i, placer) in by.agents.iter().enumerate() {
        if by.agents[..i].iter().any(|p| p.agent == placer.agent) {
            return Err(format!("{} is listed twice", placer.agent));
        }
        // ChatGPT signed out keeps its row as it is.
        if placer.agent != crate::chatgpt::ID || chatgpt.is_some() {
            covered(placer, chatgpt)?;
        }
    }
    Ok(())
}

/// Who is asked about a thought: an agent's tool, headless, or ChatGPT on
/// the person's plan, for the model its sign-in chose.
pub enum Asker {
    Agent(&'static dyn Agent, Headless),
    ChatGpt(String),
}

impl Asker {
    /// Its id, as an agreement names it.
    pub fn id(&self) -> &'static str {
        match self {
            Asker::Agent(agent, _) => agent.id(),
            Asker::ChatGpt(_) => crate::chatgpt::ID,
        }
    }

    pub fn model(&self) -> &str {
        match self {
            Asker::Agent(_, how) => how.model,
            Asker::ChatGpt(model) => model,
        }
    }

    /// Its name, as the person reads it.
    pub fn name(&self) -> &'static str {
        match self {
            Asker::Agent(agent, _) => agent.name(),
            Asker::ChatGpt(_) => "ChatGPT",
        }
    }
}

/// Why an agreement to the terms before these covers nothing.
const AGAIN: &str = "the agreement was to what was sent before: \
     placing now sends more about your projects and sessions, and asks you again";

/// The agent an agreement names and how its tool is asked, when the
/// agreement covers what this core would ask: that tool, with that model;
/// or ChatGPT, signed in for that model.
fn covered(placer: &Placer, chatgpt: Option<&str>) -> Result<Asker, String> {
    if placer.agent == crate::chatgpt::ID {
        return match chatgpt {
            Some(model) if model == placer.model => Ok(Asker::ChatGpt(model.into())),
            Some(model) => Err(format!(
                "the agreement is for ChatGPT with {}, and Tasktap now asks {model}",
                placer.model
            )),
            None => Err("ChatGPT is not signed in".into()),
        };
    }
    let agent = agents::live(&placer.agent);
    let agent = agent.ok_or(format!("Tasktap has no agent {}", placer.agent))?;
    let how = agent
        .headless()
        .ok_or(format!("{} cannot be asked to place tasks", agent.name()))?;
    match how.model == placer.model {
        true => Ok(Asker::Agent(agent, how)),
        false => Err(format!(
            "the agreement is for {} with {}, and Tasktap now asks {}",
            agent.name(),
            placer.model,
            how.model
        )),
    }
}

/// The agents an agreement lets Tasktap ask about a thought, in the
/// person's order, each with how its tool is asked: those switched on that
/// the agreement covers, ChatGPT among them while it is signed in for the
/// model agreed to (`chatgpt`). Why there are none, where there are none.
pub fn agreed(by: &RouteBy, chatgpt: Option<&str>) -> Result<Vec<Asker>, String> {
    if by.terms != TERMS {
        return Err(AGAIN.into());
    }
    let mut why = Vec::new();
    let on = by.agents.iter().filter(|p| p.on);
    let tools: Vec<_> = on
        .filter_map(|p| covered(p, chatgpt).map_err(|e| why.push(e)).ok())
        .collect();
    match (tools.is_empty(), why.is_empty()) {
        (false, _) => Ok(tools),
        (true, true) => Err("no agent is switched on for placing".into()),
        (true, false) => Err(why.join("; ")),
    }
}

/// What Tasktap proposes its order by (design §8, the owner's decision of
/// 2026-11-19), for each agent that can place: what placing a thought with
/// it costs the person when it is signed in as it usually is, and how long
/// it took to place a spoken thought (the median of 14, measured on
/// 2026-11-17 and 18). The model each asks is its adapter's
/// (`Headless::model`). An agent not here is billed by its provider, its
/// time unknown.
const COSTS: &[(&str, Pays, u32)] = &[
    // Haiku is included in a Claude subscription's usage.
    ("claude", Pays::Plan, 3700),
    // gpt-6-luna is included in a ChatGPT plan's Codex usage.
    ("codex", Pays::Plan, 4700),
    // Its flash model is included with the Google account it signs in with.
    ("agy", Pays::Plan, 5600),
    // gpt-6.2-sol on the person's ChatGPT plan, one direct call with no
    // agent started (`chatgpt.rs`): 4.0 s, measured on 2026-11-21.
    ("chatgpt", Pays::Plan, 4000),
    #[cfg(feature = "fixtures")]
    ("fixture", Pays::Plan, 900),
    #[cfg(feature = "fixtures")]
    ("fixture-silent", Pays::Plan, 600),
    #[cfg(feature = "fixtures")]
    ("fixture-probed", Pays::Billed, 500),
];

/// How long placing waits for the person's agents, asked one after another,
/// before the thought is placed by name, or asked about (design §8): the
/// slowest of the three placed a spoken thought in 6.7 s at most.
pub const BUDGET: std::time::Duration = std::time::Duration::from_secs(8);

/// About how long `agent` takes to place a thought, in milliseconds.
pub fn typical(agent: &str) -> Option<u32> {
    COSTS.iter().find(|c| c.0 == agent).map(|c| c.2)
}

/// What placing a thought with `agent` costs the person, signed in as
/// `identity` says: as the table says, unless it is signed in with a key,
/// which its provider bills for each use.
pub fn pays(agent: &str, identity: Option<&str>) -> Pays {
    let who = identity.unwrap_or_default().to_ascii_lowercase();
    let keyed = ["api key", "api_key", "apikey"]
        .iter()
        .any(|k| who.contains(k));
    match COSTS.iter().find(|c| c.0 == agent) {
        Some(&(_, pays, _)) if !keyed => pays,
        _ => Pays::Billed,
    }
}

/// Tasktap's order: ChatGPT first, which starts no agent; then what costs
/// the person nothing more, then the fastest, one whose time is unknown
/// last; else in the order given.
pub fn proposed(mut tools: Vec<PlaceTool>) -> Vec<PlaceTool> {
    tools.sort_by_key(|t| {
        let first = t.agent != crate::chatgpt::ID;
        (first, t.pays != Pays::Plan, t.ms.unwrap_or(u32::MAX))
    });
    tools
}

/// `route.terms`: what placing by a model sends and to whom, the agents
/// that can be asked in Tasktap's order. A tool that was found not to
/// offer its model any more is not among them. ChatGPT always is, with the
/// model its sign-in chose, or the one it would choose before one did.
pub fn terms(cx: &mut Cx, _: tasktap_proto::Empty) -> Result<RouteTerms, Error> {
    let chatgpt = effects::read(cx.core, crate::chatgpt::model)?;
    let offered = |a: &&&dyn Agent| !cx.core.seams.gone(a.id());
    let all = agents::all();
    let tools = all.iter().filter(offered).filter_map(|a| {
        let identity = cx.core.detected(a.id()).and_then(|h| h.identity.as_deref());
        Some(PlaceTool {
            agent: a.id().into(),
            model: a.headless()?.model.into(),
            pays: pays(a.id(), identity),
            ms: typical(a.id()),
        })
    });
    let chatgpt = PlaceTool {
        agent: crate::chatgpt::ID.into(),
        model: chatgpt.unwrap_or_else(|| crate::chatgpt::MODEL.into()),
        pays: Pays::Plan,
        ms: typical(crate::chatgpt::ID),
    };
    Ok(RouteTerms {
        instructions: INSTRUCTIONS.into(),
        sends: SENDS.iter().map(|s| (*s).into()).collect(),
        cuts: CUTS.into(),
        terms: TERMS,
        tools: proposed(tools.chain([chatgpt]).collect()),
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
/// nothing (the capture then asks). `unknown` too wherever `effects::route`
/// asks a model: one the person agreed to that this core can still ask,
/// with a project known, and the Scratchpad not said as the place. Said in
/// Tasktap's window (a workspace or a session in view) the chip says what
/// it said before a model decided every task: where the names send it when
/// they are sure ([`sure`]), else `unknown`, and the page names the place
/// in view. It stores nothing and starts nothing.
pub fn hint(cx: &mut Cx, args: Hint) -> Result<tasktap_proto::Route, Error> {
    let (request, by, chatgpt) = effects::read(cx.core, |tx| {
        let by = match tx.pref(tasktap_proto::PrefKey::RouteBy)?.map(|p| p.value) {
            Some(tasktap_proto::PrefValue::RouteBy(by)) => by,
            _ => None,
        };
        let chatgpt = crate::chatgpt::model(tx)?;
        Ok((request(tx, &args.text, args.current)?, by, chatgpt))
    })?;
    let names = by_names(&request);
    let pad = matches!(&names, Some(Route::Clear { to: Destination::New(p), .. }) if Some(*p) == request.scratch);
    // In Tasktap's window, as released: the names when sure.
    if args.current.is_some() || args.view.is_some() {
        let agreed = |by: RouteBy| agreed(&by, chatgpt.as_deref()).is_ok();
        let model = by.is_some_and(agreed) && !sure(&request);
        return Ok(match model {
            true => tasktap_proto::Route::Unknown,
            false => wire(names.unwrap_or(Route::Unknown)),
        });
    }
    let tools = by.filter(|_| !pad && !request.projects.is_empty());
    let tools = tools.and_then(|by| agreed(&by, chatgpt.as_deref()).ok());
    let model = tools.is_some_and(|tools| tools.iter().any(|t| !cx.core.seams.gone(t.id())));
    Ok(match model {
        true => tasktap_proto::Route::Unknown,
        false => wire(names.unwrap_or(Route::Unknown)),
    })
}

/// A route as the protocol says it.
pub fn wire(route: Route) -> tasktap_proto::Route {
    match route {
        Route::Clear { to, brief, said } => tasktap_proto::Route::Clear {
            to: to.into(),
            brief,
            said: said.and_then(|said| match said {
                state::Said::As(words) => Some(words),
                state::Said::Leads { words, .. } => words,
            }),
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
        Route::Torn { .. } | Route::Create { .. } => unreachable!("only a model answers so"),
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
            said: said.map(state::Said::As),
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
