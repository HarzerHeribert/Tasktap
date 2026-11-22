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
//! started; then how many wrong starts were by a project's whole name that
//! is an ordinary word. `--each` prints every thought's outcome too, at
//! each size, and every wrong start is listed.
//!
//! It fails (exit 1) when a clear leader starts any thought of a kind that
//! means no project, or one meant for a project in another. A start where
//! more than one may be meant, not on a careful pick, is counted wrong and
//! listed as debatable, and does not fail it.

use serde::Deserialize;
use tasktap_core::route::{self, Lexicon, Named, Request};
use tasktap_core::state::{Destination, Route, Said};
use tasktap_proto::{CardId, Time};

#[derive(Deserialize)]
struct Fixture {
    projects: Vec<Project>,
    /// Projects only the rows of a clear leader are meant for: among the
    /// others at every size, for those rows (and the review's set B) alone.
    #[serde(default)]
    more: Vec<Project>,
    /// Projects named after well-known tools: among the others, with
    /// `more`, for the review's set B alone.
    #[serde(default)]
    tools: Vec<Project>,
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
    /// For a thought that may be meant for more than one: the projects a
    /// start in would be no mistake.
    #[serde(default)]
    careful: Vec<String>,
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
    (
        "blind-a",
        "mean one project without its exact name (held out: the review's blind set, a)",
    ),
    (
        "blind-b",
        "may mean more than one; a start is right only on a careful pick (held out: blind, b)",
    ),
    ("blind-c", "mean no project (held out: blind, c)"),
    (
        "setb-a",
        "mean one project, many named after a tool (held out: the review's set B, a)",
    ),
    ("setb-b", "may mean more than one (held out: set B, b)"),
    (
        "setb-c",
        "mean no project, with a tool's name or a project's words in them (held out: set B, c)",
    ),
];

/// The kinds of thought whose projects include the fixture's `more`.
const MORE: &[&str] = &["lead", "near-miss", "setb-a", "setb-b", "setb-c"];
/// The kinds whose projects include the fixture's `tools` too.
const TOOLS: &[&str] = &["setb-a", "setb-b", "setb-c"];
/// The kinds where any start is wrong.
const NOWHERE: &[&str] = &["none", "decoy", "near-miss", "blind-c", "setb-c"];

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
    let tools: Vec<Named> = fixture.tools.iter().map(card).collect();
    let words = Lexicon::default();
    let sizes = [36, 100, 306];
    let mut tallies = vec![vec![Tally::default(); KINDS.len()]; sizes.len()];
    let mut ordinary = vec![0u32; sizes.len()];
    let mut ms = vec![0f64; sizes.len()];
    let mut wrong: Vec<String> = Vec::new();
    let mut failed = 0;
    for (s, size) in sizes.iter().enumerate() {
        for t in &fixture.thoughts {
            let kind = t.kind.as_str();
            let projects: Vec<Named> = (all.iter().take(*size))
                .chain(more.iter().filter(|_| MORE.contains(&kind)))
                .chain(tools.iter().filter(|_| TOOLS.contains(&kind)))
                .cloned()
                .collect();
            let request = Request {
                text: t.text.clone(),
                projects: projects.clone(),
                ..Request::default()
            };
            let name_of = |to: &Destination| {
                (projects.iter())
                    .find(|p| p.to == *to)
                    .map_or("?", |p| p.name.as_str())
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
                .position(|(known, _)| *known == kind)
                .expect("a known kind");
            let tally = &mut tallies[s][k];
            tally.n += 1;
            if target.is_some_and(|to| eight.contains(&to)) {
                tally.in_eight += 1;
            }
            let led = matches!(
                &route,
                Route::Clear {
                    said: Some(Said::Leads { .. }),
                    ..
                }
            );
            tally.led += u32::from(led);
            let nowhere = NOWHERE.contains(&kind);
            let outcome = match (&route, target) {
                // What a model alone answers; the match on names never does.
                (Route::Torn { .. } | Route::Create { .. }, _) => unreachable!("a model's answer"),
                (Route::Clear { to, .. }, Some(want)) if *to == want && !nowhere => {
                    tally.right += 1;
                    "right"
                }
                (Route::Clear { to, .. }, None)
                    if !nowhere && t.careful.iter().any(|c| c == name_of(to)) =>
                {
                    tally.right += 1;
                    "right, a careful pick"
                }
                (Route::Clear { to, .. }, _) => {
                    tally.wrong += 1;
                    let name = name_of(to);
                    let by = if led { "a lead" } else { "a name" };
                    let parts = route::parts(name);
                    let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
                    if !led && words.ordinary(&parts) {
                        ordinary[s] += 1;
                    }
                    // Where more than one may be meant and none is named
                    // careful, a start is open to debate: told, not failed.
                    let debatable = !nowhere && target.is_none();
                    if led && !debatable {
                        failed += 1;
                    }
                    let note = if debatable {
                        " (more than one may be meant: debatable)"
                    } else {
                        ""
                    };
                    wrong.push(format!(
                        "{size:3} {kind:16} started in {name} by {by}{note}  ← {}",
                        t.text
                    ));
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
                    Route::Torn { .. } | Route::Create { .. } => unreachable!("a model's answer"),
                    Route::Ambiguous { candidates, .. } => {
                        let c: Vec<String> = candidates
                            .iter()
                            .map(|c| format!("{} ({})", c.label, c.why))
                            .collect();
                        c.join(", ")
                    }
                    Route::Clear { to, said, .. } => {
                        let how = match said {
                            Some(Said::As(words)) => format!(" said as “{words}”"),
                            Some(Said::Leads { why, .. }) => format!(" by a lead: {why}"),
                            None => String::new(),
                        };
                        format!("{}{how}", name_of(to))
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
    let cell = |v: Vec<u32>| match v.iter().all(|x| *x == v[0]) {
        true => v[0].to_string(),
        false => v.iter().map(u32::to_string).collect::<Vec<_>>().join(" / "),
    };
    for (k, (_, what)) in KINDS.iter().enumerate() {
        let n = tallies[0][k].n;
        if n == 0 {
            continue;
        }
        let of = |f: fn(&Tally) -> u32| cell((0..sizes.len()).map(|s| f(&tallies[s][k])).collect());
        println!(
            "| {n} that {what} | {} | {} | {} | {} | {} | {} | {} | {} |",
            of(|t| t.right),
            of(|t| t.wrong),
            of(|t| t.first),
            of(|t| t.among),
            of(|t| t.without),
            of(|t| t.kept),
            of(|t| t.in_eight),
            of(|t| t.led),
        );
    }
    println!(
        "| Of the wrong starts above: by a project's whole name that is an ordinary word (\"buy a new kiln\" in `kiln`; the owner's open question) | – | {} | – | – | – | – | – | – |",
        cell(ordinary.clone())
    );
    let thoughts = fixture.thoughts.len() as f64;
    let per: Vec<String> = ms.iter().map(|m| format!("{:.2}", m / thoughts)).collect();
    println!();
    println!(
        "Where figures differ: at 36 / 100 / 306 projects. Milliseconds a thought: {}.",
        per.join(" / ")
    );
    if !wrong.is_empty() {
        println!();
        println!("Wrong starts:");
        for w in &wrong {
            println!("  {w}");
        }
    }
    if failed > 0 {
        println!();
        println!(
            "FAIL: a clear leader started {failed} thoughts where no project is meant, or in a wrong one."
        );
        std::process::exit(1);
    }
}
