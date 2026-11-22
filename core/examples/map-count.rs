//! What the map makes of this machine, in counts only: never a folder's or
//! a project's name, so its output can be shared. It reads as a look does
//! (`map::read`), with both agents' histories on and, with `--in <folder>`,
//! that folder as a place to look; it reads only within the map's bounds,
//! writes nothing outside a temporary folder of its own, and keeps nothing.
//!
//!     map-count [--in <folder>]... [--thought <text>]...
//!
//! Then, over the projects found, how placing by name does: a thought that
//! writes each name, one that says it as separate words, and how many
//! names another name contains or a word of a thought could be mistaken for;
//! how many a clear leader starts, and a thought that nearly says each name
//! with a word only its own line has, or only another's. `--thought` says
//! how one thought of the person's ends: started or asked, and whether by
//! its name; never where.

use std::collections::BTreeMap;
use std::time::Instant;

use tasktap_core::map::{self, Input, Rule};
use tasktap_core::route::{self, Named, Request};
use tasktap_core::state::{Destination, Route, Said};
use tasktap_proto::{CardId, Evidence, Look, LookId, LookKind, LookState, Rev, Time};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let places: Vec<String> = (args.windows(2))
        .filter(|w| w[0] == "--in")
        .map(|w| w[1].clone())
        .collect();
    let home = map::home().expect("a home folder");
    let data = std::env::temp_dir().join(format!("tasktap-map-count-{}", std::process::id()));
    std::fs::create_dir_all(&data).unwrap();
    let look = |agent: Option<&str>, folder: Option<String>| Look {
        id: LookId::mint(),
        rev: Rev::ZERO,
        kind: if agent.is_some() {
            LookKind::Agent
        } else {
            LookKind::Folder
        },
        agent: agent.map(str::to_owned),
        folder,
        on: true,
        state: LookState::New,
        found: 0,
        looked: None,
        note: None,
        stamp: None,
    };
    let mut looks = vec![look(Some("claude"), None), look(Some("codex"), None)];
    for p in &places {
        let p = std::fs::canonicalize(p).unwrap();
        looks.push(look(None, Some(p.to_string_lossy().into_owned())));
    }
    // With --derived, also the folders Tasktap would suggest from the histories: one that holds two projects or more.
    if args.iter().any(|a| a == "--derived") {
        let first = map::read(Input {
            rule: Rule::new(&home, &data),
            data: data.clone(),
            looks: looks.clone(),
            opened: Vec::new(),
            known: BTreeMap::new(),
        });
        let mut by: BTreeMap<std::path::PathBuf, usize> = BTreeMap::new();
        for m in first.cards.iter().filter(|m| m.inside.is_none()) {
            let parent = std::path::Path::new(&m.folder).parent();
            if let Some(p) = parent.filter(|p| *p != home && p.starts_with(&home)) {
                *by.entry(p.to_owned()).or_default() += 1;
            }
        }
        let derived: Vec<_> = by.into_iter().filter(|(_, n)| *n >= 2).collect();
        println!(
            "Folders suggested from the histories (holding two projects or more): {}",
            derived.len()
        );
        for (p, _) in derived {
            looks.push(look(None, Some(p.to_string_lossy().into_owned())));
        }
    }
    let input = Input {
        rule: Rule::new(&home, &data),
        data: data.clone(),
        looks: looks.clone(),
        opened: Vec::new(),
        known: BTreeMap::new(),
    };
    let began = Instant::now();
    let out = map::read(input);
    let cold = began.elapsed();
    let input = Input {
        rule: Rule::new(&home, &data),
        data: data.clone(),
        looks,
        opened: Vec::new(),
        known: out
            .cards
            .iter()
            .map(|m| (m.folder.clone(), m.root.clone()))
            .collect(),
    };
    let began = Instant::now();
    let again = map::read(input);
    let warm = began.elapsed();
    // What the root rule made of each folder the histories name, by kind.
    let rule = Rule::new(&home, &data);
    let mut kinds: BTreeMap<String, usize> = BTreeMap::new();
    let mut folders = std::collections::BTreeSet::new();
    for id in ["claude", "codex"] {
        let history = tasktap_core::agents::find(id).and_then(|a| a.history());
        let mut within = map::Within::new(map::HISTORY_TIME, map::HISTORY_FILES);
        for w in history
            .map(|h| h.read(&home, &mut within).unwrap_or_default())
            .unwrap_or_default()
        {
            folders.insert(w.folder);
        }
    }
    for f in &folders {
        let kind = match rule.kind(f) {
            map::Kind::Never if !f.starts_with(&home) => {
                "never: outside the home folder".to_owned()
            }
            map::Kind::Never => "never: home-like, hidden, temporary or Tasktap's".to_owned(),
            map::Kind::Gone => "gone".to_owned(),
            map::Kind::Copy(_) => "a worktree or submodule: its repository counted".to_owned(),
            map::Kind::Inside(_) => "inside a project".to_owned(),
            map::Kind::Top {
                git,
                package,
                signs,
            } => format!("top: git {git}, package {package}, signs {signs}"),
            map::Kind::Bare => "no mark".to_owned(),
        };
        *kinds.entry(kind).or_default() += 1;
    }
    println!("Distinct folders in the histories: {}", folders.len());
    for (k, n) in &kinds {
        println!("  {k}: {n}");
    }
    let _ = std::fs::remove_dir_all(&data);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let day = 86_400_000u64;
    println!(
        "Looked: {} ms the first time (git asked for each first commit), {} ms again with those kept.",
        cold.as_millis(),
        warm.as_millis()
    );
    for (id, state, found, ..) in &out.looks {
        let which = if *id == out.looks[0].0 {
            "Claude Code"
        } else if out.looks.get(1).map(|l| l.0) == Some(*id) {
            "Codex"
        } else {
            "a folder to look in"
        };
        println!("  {which}: {state:?}, {found} projects");
    }
    println!(
        "Folders an agent worked in that the root rule refused (gone, home-like, temporary, another tool's): {}",
        out.refused
    );

    // Copies folded, as the map does it.
    let mut by_repo: BTreeMap<&str, Vec<&map::Made>> = BTreeMap::new();
    for m in &out.cards {
        if let Some(r) = &m.repo {
            by_repo.entry(r).or_default().push(m);
        }
    }
    let copies: usize = by_repo.values().map(|v| v.len() - 1).sum();
    let inside = out.cards.iter().filter(|m| m.inside.is_some()).count();
    let projects: Vec<&map::Made> = (out.cards.iter())
        .filter(|m| m.inside.is_none())
        .filter(|m| match &m.repo {
            Some(r) => {
                let group = &by_repo[r.as_str()];
                group
                    .iter()
                    .max_by_key(|g| (g.used, std::cmp::Reverse(g.folder.len())))
                    .map(|g| &g.folder)
                    == Some(&m.folder)
            }
            None => true,
        })
        .collect();
    let count = |e: Evidence| {
        projects
            .iter()
            .filter(|m| m.why.first() == Some(&e))
            .count()
    };
    let with = |e: Evidence| projects.iter().filter(|m| m.why.contains(&e)).count();
    println!(
        "Projects: {} (copies folded under them: {copies}; folders inside a project kept under it: {inside})",
        projects.len()
    );
    println!(
        "  by evidence: an agent worked there {}, of which Git {}, a package file {}, an agent's files {}, nothing else {}",
        count(Evidence::Agent),
        with(Evidence::Git),
        with(Evidence::Package),
        with(Evidence::Signs),
        projects
            .iter()
            .filter(|m| m.why == [Evidence::Agent])
            .count()
    );
    let remote = projects
        .iter()
        .filter(|m| m.repo.as_deref().is_some_and(|r| r.starts_with("remote ")))
        .count();
    let root = projects
        .iter()
        .filter(|m| m.repo.as_deref().is_some_and(|r| r.starts_with("root ")))
        .count();
    println!(
        "  known by remote {remote}, by first commit {root}, no Git {}",
        projects.len() - remote - root
    );
    let recent = |days: u64| {
        projects
            .iter()
            .filter(|m| m.used.is_some_and(|u| now.saturating_sub(u) < days * day))
            .count()
    };
    println!(
        "  worked on in the last 7 days {}, 30 days {}, 90 days {}",
        recent(7),
        recent(30),
        recent(90)
    );
    let about = projects
        .iter()
        .filter(|m| !m.facts.about.is_empty())
        .count();
    println!("  with a line about them {about}");
    println!("  stable between two looks: {}", same(&out, &again));

    // Placing by name over the real names, as cards.
    let named: Vec<Named> = (projects.iter())
        .map(|m| Named {
            to: Destination::Card(CardId::mint()),
            name: m.name.clone(),
            aliases: m.facts.names.clone(),
            about: m.facts.about.clone(),
            folder: m.folder.clone(),
            used: m.used.and_then(Time::new),
        })
        .collect();
    let place = |text: String| {
        route::local(&Request {
            text,
            projects: named.clone(),
            ..Request::default()
        })
    };
    // Each name in the review's sentences, as typed and, for a name of
    // several words, said as separate words; how each ends.
    #[derive(Default)]
    struct Ends {
        right: usize,
        first: usize,
        among: usize,
        without: usize,
        wrong: usize,
        led: usize,
        led_wrong: usize,
        n: usize,
    }
    impl Ends {
        fn add(&mut self, route: Route, want: Destination) {
            self.n += 1;
            match route {
                Route::Torn { .. } | Route::Create { .. } => unreachable!("a model's answer"),
                Route::Clear { to, said, .. } if to == want => {
                    self.right += 1;
                    self.led += usize::from(matches!(said, Some(Said::Leads { .. })));
                }
                Route::Clear { said, .. } => {
                    self.wrong += 1;
                    self.led_wrong += usize::from(matches!(said, Some(Said::Leads { .. })));
                }
                Route::Ambiguous { candidates, .. } => {
                    match candidates.iter().position(|c| c.to == want) {
                        Some(0) => self.first += 1,
                        Some(_) => self.among += 1,
                        None => self.without += 1,
                    }
                }
                Route::Unknown => self.without += 1,
            }
        }
    }
    type Say = fn(&str) -> String;
    let forms: [(&str, Say); 3] = [
        ("fix the login in <name>", |n| {
            format!("fix the login in {n}")
        }),
        ("<name>: fix the login", |n| format!("{n}: fix the login")),
        ("the <name> login is broken", |n| {
            format!("the {n} login is broken")
        }),
    ];
    let mut ends: Vec<(String, Ends)> = Vec::new();
    for apart in [false, true] {
        for (form, say) in &forms {
            let mut e = Ends::default();
            for p in &named {
                let parts = route::parts(&p.name);
                if apart && parts.len() < 2 {
                    continue;
                }
                let name = match apart {
                    true => parts.join(" "),
                    false => p.name.clone(),
                };
                e.add(place(say(&name)), p.to);
            }
            let how = match apart {
                true => "said as separate words",
                false => "as written",
            };
            ends.push((format!("\"{form}\", {how}"), e));
        }
    }
    // Each name nearly said (its last word one for many, or many for one),
    // with a word only its own line has: started there or asked, never
    // started elsewhere; and with a word only another's line has: asked.
    let words = |text: &str| -> Vec<String> {
        (text.split(|c: char| !c.is_alphanumeric()))
            .filter(|w| w.chars().count() >= 5 && w.chars().all(char::is_alphabetic))
            .map(str::to_lowercase)
            .collect()
    };
    let theirs: Vec<Vec<String>> = (named.iter())
        .map(|p| [words(&p.about), route::parts(&p.name)].concat())
        .collect();
    let own: Vec<Option<String>> = (0..named.len())
        .map(|k| {
            // Not its own name either: that would name it.
            let mine = route::parts(&named[k].name);
            let only = |w: &String| {
                !mine.contains(w) && (0..named.len()).all(|o| o == k || !theirs[o].contains(w))
            };
            words(&named[k].about).into_iter().find(only)
        })
        .collect();
    let near = |name: &str| {
        let mut parts = route::parts(name);
        let last = parts.pop()?;
        let flipped = match last.strip_suffix('s') {
            Some(one) if one.chars().count() >= 3 => one.to_owned(),
            _ => format!("{last}s"),
        };
        parts.push(flipped);
        Some(parts.join(" "))
    };
    let (mut mine, mut other) = (Ends::default(), Ends::default());
    for (k, p) in named.iter().enumerate() {
        let (Some(near), Some(word)) = (near(&p.name), own[k].as_ref()) else {
            continue;
        };
        mine.add(place(format!("look into the {near} {word}")), p.to);
        let next = (1..named.len())
            .map(|i| (k + i) % named.len())
            .find(|o| own[*o].is_some());
        if let Some(o) = next {
            let word = own[o].as_ref().unwrap();
            let route = place(format!("look into the {near} {word}"));
            // Any start is wrong here: another's line has a word of it.
            if let Route::Clear { to, said, .. } = &route
                && *to == p.to
            {
                other.n += 1;
                other.wrong += 1;
                other.led_wrong += usize::from(matches!(said, Some(Said::Leads { .. })));
                continue;
            }
            other.add(route, p.to);
        }
    }
    ends.push((
        "\"look into the <name, nearly> <a word only its line has>\"".into(),
        mine,
    ));
    ends.push((
        "\"look into the <name, nearly> <a word only another's line has>\" (any start is wrong)"
            .into(),
        other,
    ));
    let contained = (named.iter())
        .filter(|a| {
            named.iter().any(|b| {
                b.to != a.to
                    && route::parts(&b.name).len() > 1
                    && route::parts(&b.name).contains(&route::parts(&a.name).concat())
            })
        })
        .count();
    let same_name = (named.iter())
        .filter(|a| {
            named
                .iter()
                .any(|b| b.to != a.to && b.name.eq_ignore_ascii_case(&a.name))
        })
        .count();
    println!("Placing by name over these {} projects:", named.len());
    for (what, e) in &ends {
        println!(
            "  {what} ({}): {} placed right, {} asked with it first, {} asked with it among, {} asked without it, {} placed wrong; started by a clear leader: {} right, {} wrong",
            e.n, e.right, e.first, e.among, e.without, e.wrong, e.led, e.led_wrong
        );
    }
    // The person's own thoughts, given on the command line: how each ends,
    // never where.
    let thoughts: Vec<String> = (args.windows(2))
        .filter(|w| w[0] == "--thought")
        .map(|w| w[1].clone())
        .collect();
    for (i, text) in thoughts.iter().enumerate() {
        let ends = match place(text.clone()) {
            Route::Torn { .. } | Route::Create { .. } => unreachable!("a model's answer"),
            Route::Clear {
                said: Some(Said::Leads { why, words }),
                ..
            } => format!(
                "started by a clear leader, by {} pieces, its name among them: {}",
                why.matches(" and ").count() + why.matches(", ").count() + 1,
                words.is_some()
            ),
            Route::Clear { .. } => "started by a name said".into(),
            Route::Ambiguous { candidates, .. } => format!(
                "asked, {} choices, the first by its name nearly said: {}",
                candidates.len(),
                candidates
                    .first()
                    .is_some_and(|c| c.why.starts_with("its name"))
            ),
            Route::Unknown => "kept for later".into(),
        };
        println!("  thought {}: {ends}", i + 1);
    }
    println!(
        "  names another project's name contains as a word: {contained}; names two projects share: {same_name}"
    );
}

/// Whether two looks found the same projects with the same identities.
fn same(a: &map::Output, b: &map::Output) -> bool {
    let key = |o: &map::Output| -> Vec<(String, Option<String>)> {
        o.cards
            .iter()
            .map(|m| (m.folder.clone(), m.repo.clone()))
            .collect()
    };
    key(a) == key(b)
}
