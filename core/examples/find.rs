//! `projects.find` as the core answers it, for the page checks: the pages'
//! fake core (`scripts/motion-pages.cjs`) asks this rather than matching on
//! its own, so what a check sees the list's field find is what the core
//! finds. One request a line on standard input, one answer a line out:
//!
//!     {"text": "harb", "limit": 3, "thought": false,
//!      "projects": [{"to": {"card": "…"}, "name": "harbormaster",
//!                    "aliases": [], "about": "…", "folder": "…", "used": 0}]}
//!
//! answered `{"found": [{"to": {"card": "…"}, "name": …, "folder": …,
//! "why": …}]}`, as `map::find` makes it.

use std::io::{BufRead, Write};

use serde::Deserialize;
use tasktap_core::route::{self, Named, Request};
use tasktap_core::state::Destination;
use tasktap_proto::{Finds, Found, Place, Time};

#[derive(Deserialize)]
struct Asked {
    text: String,
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    thought: bool,
    projects: Vec<Project>,
}

#[derive(Deserialize)]
struct Project {
    to: Place,
    name: String,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    about: String,
    #[serde(default)]
    folder: String,
    #[serde(default)]
    used: Option<u64>,
}

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let answer = match serde_json::from_str::<Asked>(&line) {
            Ok(asked) => serde_json::to_string(&find(asked)).unwrap(),
            Err(e) => serde_json::json!({ "error": e.to_string() }).to_string(),
        };
        let _ = writeln!(out, "{answer}");
        let _ = out.flush();
    }
}

fn find(asked: Asked) -> Finds {
    let projects = (asked.projects.into_iter())
        .filter_map(|p| {
            let to = match p.to {
                Place::Project(id) => Destination::New(id),
                Place::Card(id) => Destination::Card(id),
                Place::Session(_) => return None,
            };
            Some(Named {
                to,
                name: p.name,
                aliases: p.aliases,
                about: p.about,
                folder: p.folder,
                used: p.used.and_then(Time::new),
            })
        })
        .collect();
    let request = Request {
        text: asked.text,
        projects,
        ..Request::default()
    };
    let limit = asked.limit.unwrap_or(3).clamp(1, 8) as usize;
    let found = match asked.thought {
        true => route::likely(&request, limit),
        false => route::typed(&request, limit),
    };
    Finds {
        found: (found.into_iter())
            .map(|(named, why)| Found {
                to: Place::from(named.to),
                name: named.name.clone(),
                folder: named.folder.clone(),
                why,
            })
            .collect(),
    }
}
