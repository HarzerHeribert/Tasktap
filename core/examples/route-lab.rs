//! The question a model is asked about one task of the routing lab's
//! made-up corpus (`scripts/lab/corpus.json`, from the `routing-lab`
//! branch: invented persons, their projects and the sessions open when
//! they speak), built by the product's own code: the person's projects and
//! sessions as a `route::Request`, `route::order` for the 8 of each a model
//! is given and their order, and `route::question` for the words, the same
//! for ChatGPT and for a placing agent. Nothing is asked of anyone.
//!
//!     route-lab <corpus.json> <task id>       e.g. pa-t0, or pa-x0-0 for one said with sessions open
//!
//! A project's earlier tasks are its commit subjects (the corpus has no
//! earlier tasks of its own), cut as the product cuts a task's title
//! (`route::cut`); the names at its top go through the product's own
//! filter and order (`route::top_of`), a name with no dot taken for a
//! folder unless it is a well-known file (`route::folder_named`: gradlew,
//! Brewfile, LICENSE), as the corpus does not say; a session's first and last request
//! are the one the corpus gives it.

use serde::Deserialize;
use tasktap_core::route::{self, Exchange, Followed, Named, Request};
use tasktap_core::state::Destination;
use tasktap_proto::{ProjectId, SessionId, SessionState, Status};

#[derive(Deserialize)]
struct Corpus {
    persons: Vec<Person>,
}

#[derive(Deserialize)]
struct Person {
    projects: Vec<Project>,
    tasks: Vec<Task>,
    #[serde(default)]
    states: Vec<State>,
}

#[derive(Deserialize)]
struct Project {
    name: String,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    about: String,
    #[serde(default)]
    history: Vec<serde_json::Value>,
    #[serde(default)]
    top: Vec<String>,
}

#[derive(Deserialize)]
struct Task {
    id: String,
    text: String,
}

#[derive(Deserialize)]
struct State {
    current: Option<String>,
    sessions: Vec<Open>,
    tasks: Vec<Task>,
}

#[derive(Deserialize)]
struct Open {
    key: String,
    project: String,
    title: String,
    request: String,
    #[serde(default)]
    result: String,
    state: String,
    #[serde(default)]
    ago_ms: Option<u64>,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [file, id] = args.as_slice() else {
        eprintln!("usage: route-lab <corpus.json> <task id>");
        std::process::exit(2);
    };
    let corpus: Corpus = serde_json::from_slice(&std::fs::read(file).expect("the corpus"))
        .expect("the corpus as JSON");
    for person in &corpus.persons {
        let plain = person.tasks.iter().map(|t| (t, None));
        let said = (person.states.iter()).flat_map(|s| s.tasks.iter().map(move |t| (t, Some(s))));
        if let Some((task, state)) = plain.chain(said).find(|(t, _)| t.id == *id) {
            print!("{}", route::question(&request(person, &task.text, state)));
            return;
        }
    }
    eprintln!("no task {id} in {file}");
    std::process::exit(1);
}

/// The request for a task of a person, as the core would make it: every
/// project of theirs, every session open, ordered and cut by `route::order`.
fn request(person: &Person, text: &str, state: Option<&State>) -> Request {
    let ids: Vec<ProjectId> = person.projects.iter().map(|_| ProjectId::mint()).collect();
    let id_of = |name: &str| {
        let at = person.projects.iter().position(|p| p.name == name);
        ids[at.unwrap_or_else(|| panic!("no project {name}"))]
    };
    let projects: Vec<Named> = (person.projects.iter().zip(&ids))
        .map(|(p, id)| Named {
            about: p.about.clone(),
            ..Named::open(
                *id,
                &p.name,
                &p.aliases.iter().map(String::as_str).collect::<Vec<_>>(),
            )
        })
        .collect();
    let to = |id: &ProjectId| Destination::New(*id);
    let earlier = (person.projects.iter().zip(&ids))
        .map(|(p, id)| (to(id), p.history.iter().filter_map(title).take(5).collect()))
        .collect();
    let top = (person.projects.iter().zip(&ids))
        .map(|(p, id)| {
            let entries = p.top.iter().map(|n| (n.clone(), route::folder_named(n)));
            (to(id), route::top_of(entries))
        })
        .collect();
    let open: Vec<(&Open, SessionId)> = (state.map(|s| s.sessions.as_slice()).unwrap_or_default())
        .iter()
        .map(|o| (o, SessionId::mint()))
        .collect();
    let sessions = (open.iter())
        .map(|(o, id)| Followed {
            id: *id,
            name: Some(o.title.clone()),
            project: id_of(&o.project),
            label: format!("The session in {}", o.project),
            agent: "claude".into(),
            state: match o.state.as_str() {
                "running" => SessionState::Working,
                _ => SessionState::Idle,
            },
            thought: None,
            task: o.request.clone(),
            first: o.request.clone(),
            summary: o.result.clone(),
            ago: o.ago_ms,
            asks: false,
        })
        .collect();
    let current = state.and_then(|s| s.current.as_deref());
    let current = (open.iter()).find(|(o, _)| Some(o.key.as_str()) == current);
    let mut r = route::order(Request {
        text: text.into(),
        current: current.map(|(_, id)| *id),
        picked: None,
        recent: Vec::new(),
        scratch: None,
        projects,
        sessions,
        last: None,
        words: Default::default(),
        view: None,
        earlier,
        top,
    });
    // The latest exchanges with the sessions given: those that answered.
    for s in &r.sessions {
        let Some((o, _)) = open.iter().find(|(_, id)| *id == s.id) else {
            continue;
        };
        if !o.result.is_empty() && r.recent.len() < 3 {
            r.recent.push(Exchange {
                session: s.id,
                request: o.request.clone(),
                status: match o.state.as_str() {
                    "running" => Status::Working,
                    _ => Status::Done,
                },
                result: o.result.clone(),
            });
        }
    }
    r
}

/// An earlier work's title as the corpus writes it: a commit subject, or
/// an object with its text.
fn title(item: &serde_json::Value) -> Option<String> {
    let text = item.as_str().or_else(|| item.get("text")?.as_str())?;
    Some(route::cut(text, route::EARLIER_TITLE))
}
