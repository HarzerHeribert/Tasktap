//! The experiment of docs/projects-design.md ("Experiments"), run through
//! the real code: `scripts/place-eval.sh` runs it. Every project of
//! `scripts/place-eval.json` is a project Tasktap knows (a card, with its
//! line and how long ago it was worked on); every thought goes through
//! `route::local`, as a capture does with no model agreed to, at 36, 100
//! and 306 projects. Nothing is asked of anyone and nothing is written.
//!
//!     place-eval <fixture.json> [--each]
//!
//! Per kind of thought it prints how many were placed right, placed wrong,
//! asked with the right one first, asked with it among the choices, asked
//! without it, and kept for later; and how many times the right one is
//! among the 8 a model would be given, and how many a clear leader
//! started. `--each` prints every thought's outcome too, at each size.

use serde::Deserialize;
use tasktap_core::route::{self, Named, Request};
use tasktap_core::state::{Destination, Route, Said};
use tasktap_proto::{CardId, Time};

#[derive(Deserialize)]
struct Fixture {
    projects: Vec<Project>,
    /// Projects only the rows of a clear leader are meant for: among the
    /// others at every size, for those rows alone.
    #[serde(default)]
    more: Vec<Project>,
    thoughts: Vec<Thought>,
}

#[derive(Deserialize)]
struct Project {
    name: String,
    about: String,
    /// Days since something happened there.
    quiet: u64,
}

#[derive(Deserialize)]
struct Thought {
    kind: String,
    #[serde(default)]
    to: String,
    text: String,
}

#[derive(Default, Clone, Copy)]
struct Tally {
    right: u32,
    wrong: u32,
    first: u32,
    among: u32,
    without: u32,
    kept: u32,
    in_eight: u32,
    led: u32,
    n: u32,
}

const KINDS: &[(&str, &str)] = &[
    ("named", "name the project as typed"),
    ("spoken", "name it as speech writes it"),
    ("twin", "name one with near-duplicates"),
    ("described", "only describe the work"),
    (
        "described-blind",
        "describe work in a project whose card says nothing",
    ),
    ("none", "name and mean no project"),
    (
        "everyday",
        "use an everyday-word project's name as a name (held out)",
    ),
    (
        "decoy",
        "mean no project, with an everyday name or a name's sound or words in them (held out)",
    ),
    ("seen", "the review found placed wrongly (in-sample)"),
    (
        "lead",
        "name no project for certain, one clearly leading (in-sample)",
    ),
    (
        "near-miss",
        "come near a lead and must be asked; any start is wrong (in-sample)",
    ),
];

/// The kinds of thought whose projects include the fixture's `more`.
const LEADS: &[&str] = &["lead", "near-miss"];

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = args.first().expect("place-eval <fixture.json> [--each]");
    let each = args.iter().any(|a| a == "--each");
    let fixture: Fixture = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let now: u64 = 1_800_000_000_000;
    let card = |p: &Project| Named {
        to: Destination::Card(CardId::mint()),
        name: p.name.clone(),
        aliases: Vec::new(),
        about: p.about.clone(),
        folder: format!("/Users/someone/projects/{}", p.name),
        used: Time::new(now - p.quiet * 86_400_000),
    };
    let all: Vec<Named> = fixture.projects.iter().map(card).collect();
    let more: Vec<Named> = fixture.more.iter().map(card).collect();
    let sizes = [36, 100, 306];
    let mut tallies = vec![vec![Tally::default(); KINDS.len()]; sizes.len()];
    let mut ms = vec![0f64; sizes.len()];
    for (s, size) in sizes.iter().enumerate() {
        for t in &fixture.thoughts {
            let lead = LEADS.contains(&t.kind.as_str());
            let projects: Vec<Named> = (all.iter().take(*size))
                .chain(more.iter().filter(|_| lead))
                .cloned()
                .collect();
            let request = Request {
                text: t.text.clone(),
                projects: projects.clone(),
                ..Request::default()
            };
            let target = projects.iter().find(|p| p.name == t.to).map(|p| p.to);
            let began = std::time::Instant::now();
            let route = route::local(&request);
            ms[s] += began.elapsed().as_secs_f64() * 1000.0;
            let eight: Vec<Destination> = route::ranked(&request, 8)
                .iter()
                .map(|(p, _)| p.to)
                .collect();
            let k = KINDS
                .iter()
                .position(|(kind, _)| *kind == t.kind)
                .expect("a known kind");
            let tally = &mut tallies[s][k];
            tally.n += 1;
            if target.is_some_and(|to| eight.contains(&to)) {
                tally.in_eight += 1;
            }
            if let Route::Clear {
                said: Some(Said::Leads { .. }),
                ..
            } = &route
            {
                tally.led += 1;
            }
            let ask = t.kind == "near-miss";
            let outcome = match (&route, target) {
                (Route::Clear { to, .. }, Some(want)) if *to == want && !ask => {
                    tally.right += 1;
                    "right"
                }
                (Route::Clear { .. }, _) => {
                    tally.wrong += 1;
                    "WRONG"
                }
                (Route::Ambiguous { candidates, .. }, Some(want))
                    if candidates.first().map(|c| c.to) == Some(want) =>
                {
                    tally.first += 1;
                    "asked, right first"
                }
                (Route::Ambiguous { candidates, .. }, Some(want))
                    if candidates.iter().any(|c| c.to == want) =>
                {
                    tally.among += 1;
                    "asked, among"
                }
                (Route::Ambiguous { .. }, _) => {
                    tally.without += 1;
                    "asked without it"
                }
                (Route::Unknown, _) => {
                    tally.kept += 1;
                    "kept"
                }
            };
            if each {
                let label = |r: &Route| match r {
                    Route::Ambiguous { candidates, .. } => {
                        let c: Vec<String> = candidates
                            .iter()
                            .map(|c| format!("{} ({})", c.label, c.why))
                            .collect();
                        c.join(", ")
                    }
                    Route::Clear { to, said, .. } => {
                        let name = projects
                            .iter()
                            .find(|p| p.to == *to)
                            .map_or("?", |p| p.name.as_str());
                        let how = match said {
                            Some(Said::As(words)) => format!(" said as “{words}”"),
                            Some(Said::Leads { why, .. }) => format!(" by a lead: {why}"),
                            None => String::new(),
                        };
                        format!("{name}{how}")
                    }
                    Route::Unknown => String::new(),
                };
                println!(
                    "{:3} {:16} {:20} {:22} {}  ← {}",
                    size,
                    t.kind,
                    t.to,
                    outcome,
                    label(&route),
                    t.text
                );
            }
        }
    }
    println!();
    println!(
        "| Thoughts | Right | Wrong | Asked, right one first | Asked, it among the choices | Asked without it | Kept | Right one in the 8 a model gets | Started by a lead |"
    );
    println!("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (k, (_, what)) in KINDS.iter().enumerate() {
        let n = tallies[0][k].n;
        let cell = |f: fn(&Tally) -> u32| {
            let v: Vec<u32> = (0..sizes.len()).map(|s| f(&tallies[s][k])).collect();
            match v.iter().all(|x| *x == v[0]) {
                true => v[0].to_string(),
                false => v.iter().map(u32::to_string).collect::<Vec<_>>().join(" / "),
            }
        };
        println!(
            "| {n} that {what} | {} | {} | {} | {} | {} | {} | {} | {} |",
            cell(|t| t.right),
            cell(|t| t.wrong),
            cell(|t| t.first),
            cell(|t| t.among),
            cell(|t| t.without),
            cell(|t| t.kept),
            cell(|t| t.in_eight),
            cell(|t| t.led),
        );
    }
    let thoughts = fixture.thoughts.len() as f64;
    let per: Vec<String> = ms.iter().map(|m| format!("{:.2}", m / thoughts)).collect();
    println!();
    println!(
        "Where figures differ: at 36 / 100 / 306 projects. Milliseconds a thought: {}.",
        per.join(" / ")
    );
}
