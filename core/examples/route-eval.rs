//! The evaluation of model routing (design §8, "Proof before default"):
//! `scripts/route-eval.sh` runs it; it is never part of the automated suite,
//! since every thought is one headless call of the person's own agent.
//!
//!     route-eval <fixture.json> --tool <agent> [--runs N] [--only NAME,NAME] [--briefs]
//!     route-eval <fixture.json> --question NAME
//!
//! The fixture holds one state (projects, sessions, recent exchanges) and
//! the thoughts, each with where it must go and what a good brief of it
//! must say and must not invent. Each thought goes through what the core
//! does with a capture: the question `route::question` writes, the tool as
//! its adapter runs it headless, the answer as `route::accept` takes it.
//! Per thought it prints whether the destination is right, how many of the
//! required facts the brief has, what it invented, the title it gave the
//! work (in brackets) and the time taken;
//! with `--briefs`, the briefs too. `--question` prints the question a
//! thought is asked with, and asks nobody.

use std::sync::mpsc;
use std::time::Instant;

use serde::Deserialize;
use tasktap_core::agents::{self, checks};
use tasktap_core::route::{self, Exchange, Followed, Named, Request};
use tasktap_core::state::{Destination, Route};
use tasktap_proto::{ProjectId, Routing, SessionId, SessionState, Status};

#[derive(Deserialize)]
struct Fixture {
    projects: Vec<Project>,
    sessions: Vec<Session>,
    recent: Vec<Recent>,
    thoughts: Vec<Thought>,
}

#[derive(Deserialize)]
struct Project {
    name: String,
    #[serde(default)]
    aliases: Vec<String>,
}

#[derive(Deserialize)]
struct Session {
    /// What the thoughts call it.
    key: String,
    name: Option<String>,
    project: String,
    agent: String,
    state: SessionState,
    task: String,
}

#[derive(Deserialize)]
struct Recent {
    session: String,
    request: String,
    status: Status,
    result: String,
}

#[derive(Deserialize)]
struct Thought {
    name: String,
    text: String,
    /// The session the person was in, by its key.
    current: Option<String>,
    /// The destination the person picked, a project's name or a session's key.
    picked: Option<String>,
    expect: Expect,
    /// Each entry is one fact: the brief must have at least one of its spellings.
    #[serde(default)]
    must: Vec<Vec<String>>,
    /// What the person did not say: none may be in the brief.
    #[serde(default)]
    must_not: Vec<String>,
    /// The brief must be the thought, word for word.
    #[serde(default)]
    unchanged: bool,
}

#[derive(Deserialize)]
#[serde(tag = "confidence", rename_all = "snake_case")]
enum Expect {
    /// Any one of these, each a project's name or a session's key.
    Clear {
        to: Vec<String>,
    },
    /// At least two choices, these among them.
    Ambiguous {
        among: Vec<String>,
    },
    Unknown,
}

fn main() {
    let mut args = std::env::args().skip(1);
    let (mut path, mut tool, mut runs, mut only, mut briefs, mut print) =
        (None, None, 1, None, false, None);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--tool" => tool = args.next(),
            "--runs" => runs = args.next().and_then(|n| n.parse().ok()).unwrap_or(1),
            "--only" => only = args.next(),
            "--question" => print = args.next(),
            "--briefs" => briefs = true,
            _ => path = Some(arg),
        }
    }
    let usage =
        "usage: route-eval <fixture.json> --tool <agent> [--runs N] [--only NAME,NAME] [--briefs]";
    let path = path.unwrap_or_else(|| panic!("{usage}"));
    let fixture: Fixture = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let world = World::new(&fixture);
    if let Some(name) = print {
        let t = (fixture.thoughts.iter()).find(|t| t.name == name);
        print!(
            "{}",
            route::question(&world.request(t.expect("no such thought")))
        );
        return;
    }
    let tool = tool.unwrap_or_else(|| panic!("{usage}"));
    let agent = agents::find(&tool).expect("no such agent");
    let how = agent
        .headless()
        .expect("the agent answers no question headless");
    let folder = std::env::temp_dir().join(format!("tasktap-route-eval-{}", std::process::id()));
    println!("tool {tool}, model {}, {runs} run(s)", how.model);
    println!(
        "{:<22} {:<5} {:<7} {:<9} {:>6}  note",
        "thought", "dest", "facts", "invented", "ms"
    );
    let (mut right, mut whole, mut clean, mut asked, mut times) = (0, 0, 0, 0, Vec::new());
    for run in 0..runs {
        for t in &fixture.thoughts {
            if only
                .as_ref()
                .is_some_and(|names| !names.split(',').any(|name| name == t.name))
            {
                continue;
            }
            let request = world.request(t);
            let began = Instant::now();
            let (hear, heard) = mpsc::channel();
            let question = route::question(&request);
            let answer = checks::ask(agent, &how, question, route::SCHEMA, &folder, (hear, heard));
            let ms = began.elapsed().as_millis();
            let answer = answer.map_err(|failed| match failed {
                checks::Failed::Gone => route::gone(agent.name()),
                checks::Failed::SignedOut => "it is signed out".into(),
                checks::Failed::Limit(_, why) | checks::Failed::Why(why) => why,
            });
            let accepted = answer.and_then(|answer| route::accept(&request, &answer));
            let row = world.judge(t, &accepted);
            asked += 1;
            right += usize::from(row.right);
            whole += usize::from(row.missing.is_empty());
            clean += usize::from(row.invented.is_empty());
            times.push(ms);
            println!(
                "{:<22} {:<5} {:<7} {:<9} {:>6}  {}",
                t.name,
                if row.right { "ok" } else { "WRONG" },
                format!("{}/{}", t.must.len() - row.missing.len(), t.must.len()),
                if row.invented.is_empty() {
                    "none".into()
                } else {
                    row.invented.join(",")
                },
                ms,
                row.note
            );
            if briefs {
                println!("    run {run}: {}", row.brief.replace('\n', "\n    "));
            }
        }
    }
    times.sort_unstable();
    let median = times.get(times.len() / 2).copied().unwrap_or(0);
    let slowest = times.last().copied().unwrap_or(0);
    let late = times.iter().filter(|ms| **ms > 5000).count();
    println!(
        "destination {right}/{asked}, every fact {whole}/{asked}, nothing invented {clean}/{asked}; \
         median {median} ms, slowest {slowest} ms, over the 5 s hold {late}/{asked}"
    );
    let _ = std::fs::remove_dir_all(folder);
}

/// The fixture's state as the core's records would hold it.
struct World {
    projects: Vec<Named>,
    sessions: Vec<(String, Followed)>,
    recent: Vec<Exchange>,
}

struct Row {
    right: bool,
    missing: Vec<String>,
    invented: Vec<String>,
    note: String,
    brief: String,
}

/// The project a named project is, by its destination.
fn project_id(p: &Named) -> ProjectId {
    match p.to {
        Destination::New(id) => id,
        _ => unreachable!("a project is a new destination"),
    }
}

impl World {
    fn new(f: &Fixture) -> World {
        let projects: Vec<Named> = (f.projects.iter())
            .map(|p| Named {
                to: Destination::New(ProjectId::mint()),
                name: p.name.clone(),
                aliases: p.aliases.clone(),
                about: String::new(),
                folder: String::new(),
                used: None,
            })
            .collect();
        let project = |name: &str| projects.iter().find(|p| p.name == name).expect("project");
        let sessions: Vec<(String, Followed)> = (f.sessions.iter())
            .map(|s| {
                let p = project(&s.project);
                let followed = Followed {
                    id: SessionId::mint(),
                    name: s.name.clone(),
                    project: project_id(p),
                    label: format!("The {} session in {}", s.agent, p.name),
                    agent: s.agent.clone(),
                    state: s.state,
                    thought: None,
                    task: s.task.clone(),
                };
                (s.key.clone(), followed)
            })
            .collect();
        let session = |key: &str| {
            sessions
                .iter()
                .find(|(k, _)| k == key)
                .expect("session")
                .1
                .id
        };
        let recent = (f.recent.iter())
            .map(|e| Exchange {
                session: session(&e.session),
                request: e.request.clone(),
                status: e.status,
                result: e.result.clone(),
            })
            .collect();
        World {
            projects,
            sessions,
            recent,
        }
    }

    /// A project by its name, or a session by its key.
    fn place(&self, name: &str) -> Destination {
        let session = self.sessions.iter().find(|(key, _)| key == name);
        let project = self.projects.iter().find(|p| p.name == name);
        match (session, project) {
            (Some((_, s)), _) => Destination::Session(s.id),
            (_, Some(p)) => Destination::New(project_id(p)),
            _ => panic!("the fixture names {name}, which it does not have"),
        }
    }

    fn named(&self, to: Destination) -> String {
        match to {
            Destination::New(id) => {
                let p = self.projects.iter().find(|p| project_id(p) == id);
                p.map(|p| p.name.clone()).unwrap_or_default()
            }
            Destination::Session(id) => {
                let s = self.sessions.iter().find(|(_, s)| s.id == id);
                s.map(|(key, _)| key.clone()).unwrap_or_default()
            }
            Destination::Card(_) => String::new(),
        }
    }

    fn request(&self, t: &Thought) -> Request {
        Request {
            last: None,
            text: t.text.clone(),
            current: t.current.as_deref().map(|key| match self.place(key) {
                Destination::Session(id) => id,
                Destination::New(_) | Destination::Card(_) => panic!("current is a session"),
            }),
            picked: t.picked.as_deref().map(|name| self.place(name)),
            projects: self.projects.clone(),
            sessions: self.sessions.iter().map(|(_, s)| s.clone()).collect(),
            recent: self.recent.clone(),
            words: Default::default(),
        }
    }

    fn judge(&self, t: &Thought, got: &Result<(Route, Routing), String>) -> Row {
        let (route, quote, title) = match got {
            Ok((route, found)) => (route, found.quote.clone(), found.title.clone()),
            Err(why) => {
                return Row {
                    right: false,
                    missing: t.must.iter().map(|m| m[0].clone()).collect(),
                    invented: Vec::new(),
                    note: format!("not accepted: {why}"),
                    brief: String::new(),
                };
            }
        };
        let (right, went, brief) = match (route, &t.expect) {
            (Route::Clear { to, brief, .. }, Expect::Clear { to: wanted }) => {
                let right = wanted.iter().any(|name| self.place(name) == *to);
                (right, self.named(*to), brief.clone())
            }
            (Route::Clear { to, brief, .. }, _) => (false, self.named(*to), brief.clone()),
            (
                Route::Ambiguous {
                    candidates, brief, ..
                },
                expect,
            ) => {
                let has = |name: &String| candidates.iter().any(|c| c.to == self.place(name));
                let right = matches!(expect, Expect::Ambiguous { among } if among.iter().all(has));
                let went: Vec<_> = candidates.iter().map(|c| self.named(c.to)).collect();
                let brief = brief.clone().unwrap_or_default();
                (right, format!("asks: {}", went.join(" | ")), brief)
            }
            (Route::Unknown, expect) => {
                let right = matches!(expect, Expect::Unknown);
                (right, "an idea".into(), String::new())
            }
        };
        let lower = brief.to_lowercase();
        let has = |spelling: &String| lower.contains(&spelling.to_lowercase());
        let briefed = !matches!(t.expect, Expect::Unknown);
        let missing: Vec<String> = (t.must.iter())
            .filter(|fact| briefed && !fact.iter().any(has))
            .map(|fact| fact[0].clone())
            .collect();
        let mut invented: Vec<String> = t.must_not.iter().filter(|w| has(w)).cloned().collect();
        if t.unchanged && !route::same(&brief, &t.text) {
            invented.push("changed".into());
        }
        let mut note = format!("→ {went}");
        if let Some(title) = title {
            note.push_str(&format!(" [{title}]"));
        } else if briefed {
            note.push_str(" [no title]");
        }
        if let Some(quote) = quote {
            note.push_str(&format!(" (“{quote}”)"));
        }
        if !missing.is_empty() {
            note.push_str(&format!("; missing: {}", missing.join(", ")));
        }
        Row {
            right,
            missing,
            invented,
            note,
            brief,
        }
    }
}
