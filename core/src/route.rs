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
//! (`agents::Headless`) one after another in the order the person agreed
//! to ([`agreed`]; Tasktap proposes one, [`proposed`]), within [`BUDGET`]:
//! one question, [`question`], carries the [`INSTRUCTIONS`] and what the
//! core's records offer, and an answer is taken only as [`accept`] allows.
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
//! | names nothing, and projects are known | `ambiguous`: at most three, the one its words point at most by what only it has first, then those whose line about them shares the rarest words, then where the last thought went, then the most recently worked on |
//! | names nothing, and no project is known | `unknown`: it stays an idea |
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
//! scratchpad", "in scratch"; never "from scratch"). The brief is the
//! person's text unchanged.
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
    Collection, Error, Hint, Pays, PlaceTool, Placer, ProjectId, ProjectKind, RouteBy, RouteTerms,
    Routing, SessionId, SessionState, Set, Status, ThoughtId, Time,
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
    r#""required":["quote","confidence","to","candidates","brief","title"],"#,
    r#""properties":{"quote":{"type":"string"},"#,
    r#""confidence":{"type":"string","enum":["clear","ambiguous","unknown"]},"#,
    r#""to":{"type":"string"},"candidates":{"type":"array","items":{"type":"string"}},"#,
    r#""brief":{"type":"string"},"title":{"type":"string"}}}"#,
);

/// What routing by a model sends, as `route.terms` lists it.
const SENDS: &[&str] = &[
    "the task, as you said or typed it",
    "of up to 8 of your projects, those this Mac ranks likeliest: the name, the other names it goes by and one line about it",
    "of up to 8 sessions in them: the name, the last request (180 characters), the agent and whether it is working",
    "of up to 3 recent exchanges: the request (320 characters), how it ended and the first line of the result (160 characters)",
];

/// The version of what is sent and to whom, which an agreement names
/// (`RouteBy::terms`): 3 since it lists the person's agents, asked one
/// after another until one answers; 2 since a model is given a line about
/// each project, and projects that are not open. An agreement to another
/// version covers nothing.
pub const TERMS: u32 = 3;

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
/// decide where it goes: then the match is sure and no model is asked. A
/// question the names alone would ask (two projects named alike) is sure
/// too; one they ask only because a name may not be meant (said only as it
/// sounds, a letter off, an everyday word, words written apart) is not: a
/// model the person agreed to is asked first, given those projects first.
pub fn sure(r: &Request) -> bool {
    match by_names(r) {
        Some(Route::Ambiguous { .. }) => {
            let named = hits(r);
            let sessions = r.sessions.iter().any(|s| follows(&r.text, s));
            sessions || named.iter().any(decides)
        }
        // One project only leads: a model is asked first, given it first.
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
                        why: "its name, nearly".into(),
                    },
                    Candidate {
                        label: h.p.name.clone(),
                        to: h.p.to,
                        why: why_named(r, h),
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

/// Words before the Scratchpad said as a place: "on the scratchpad".
const ON_PAD: &[&str] = &["in", "into", "inside", "on", "to"];

/// Whether the capture says the Scratchpad as a place: "scratchpad" or
/// "scratch pad" after one of [`ON_PAD`], "the" between or not; the bare
/// "scratch" so only after a word other than "to", which makes it the verb.
/// Never "from scratch", "scratch that", or "a scratchpad".
fn scratchpad(text: &str) -> bool {
    let w = names::words(text).words;
    let word = |i: usize| w.get(i).map(String::as_str);
    (0..w.len()).any(|i| {
        let bare = word(i) == Some("scratch") && word(i + 1) != Some("pad");
        let pad = word(i) == Some("scratchpad") || (word(i) == Some("scratch") && !bare);
        let the = usize::from(i > 0 && word(i - 1) == Some("the"));
        let before = i.checked_sub(1 + the).and_then(word);
        before.is_some_and(|b| ON_PAD.contains(&b) && (pad || (bare && b != "to")))
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
    let agents: Vec<String> = (agents::all().into_iter())
        .flat_map(|a| [parts(a.id()), parts(a.name())].concat())
        .collect();
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
/// those it points at by its own words ([`likely`]); then where the last
/// thought went; then the most recently worked on. Recency orders and
/// never adds a reason of its own beyond that.
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
            let follows = matches!(to, Destination::Session(id) if Some(id) != r.current);
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
        false => Err(format!("the task is longer than {MAX_THOUGHT} characters")),
    }
}

/// Whether an agreement names what this core would ask: these terms, and
/// each agent once, one this core has, whose tool it would ask for the
/// model agreed to.
pub fn valid(by: &RouteBy) -> Result<(), String> {
    if by.terms != TERMS {
        return Err(AGAIN.into());
    }
    for (i, placer) in by.agents.iter().enumerate() {
        if by.agents[..i].iter().any(|p| p.agent == placer.agent) {
            return Err(format!("{} is listed twice", placer.agent));
        }
        covered(placer)?;
    }
    Ok(())
}

/// Why an agreement to the terms before these covers nothing.
const AGAIN: &str = "the agreement was to what was sent before: \
     placing now asks your agents one after another, and asks you again";

/// The agent an agreement names and how its tool is asked, when the
/// agreement covers what this core would ask: that tool, with that model.
fn covered(placer: &Placer) -> Result<(&'static dyn Agent, Headless), String> {
    let agent = agents::live(&placer.agent);
    let agent = agent.ok_or(format!("Tasktap has no agent {}", placer.agent))?;
    let how = agent
        .headless()
        .ok_or(format!("{} cannot be asked to place tasks", agent.name()))?;
    match how.model == placer.model {
        true => Ok((agent, how)),
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
/// the agreement covers. Why there are none, where there are none.
pub fn agreed(by: &RouteBy) -> Result<Vec<(&'static dyn Agent, Headless)>, String> {
    if by.terms != TERMS {
        return Err(AGAIN.into());
    }
    let mut why = Vec::new();
    let on = by.agents.iter().filter(|p| p.on);
    let tools: Vec<_> = on
        .filter_map(|p| covered(p).map_err(|e| why.push(e)).ok())
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

/// Tasktap's order: what costs the person nothing more first, then the
/// fastest, one whose time is unknown last; else in the order given.
pub fn proposed(mut tools: Vec<PlaceTool>) -> Vec<PlaceTool> {
    tools.sort_by_key(|t| (t.pays != Pays::Plan, t.ms.unwrap_or(u32::MAX)));
    tools
}

/// `route.terms`: what placing by a model sends and to whom, the agents
/// that can be asked in Tasktap's order. A tool that was found not to
/// offer its model any more is not among them.
pub fn terms(cx: &mut Cx, _: tasktap_proto::Empty) -> Result<RouteTerms, Error> {
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
    Ok(RouteTerms {
        instructions: INSTRUCTIONS.into(),
        sends: SENDS.iter().map(|s| (*s).into()).collect(),
        terms: TERMS,
        tools: proposed(tools.collect()),
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
    let (request, by) = effects::read(cx.core, |tx| {
        let by = match tx.pref(tasktap_proto::PrefKey::RouteBy)?.map(|p| p.value) {
            Some(tasktap_proto::PrefValue::RouteBy(by)) => by,
            _ => None,
        };
        Ok((request(tx, &args.text, args.current)?, by))
    })?;
    // A question the names ask only because a name may not be meant goes
    // to the models the person agreed to: the chip says it decides.
    let model = by.is_some_and(|by| agreed(&by).is_ok()) && !sure(&request);
    Ok(match model {
        true => tasktap_proto::Route::Unknown,
        false => wire(by_names(&request).unwrap_or(Route::Unknown)),
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
