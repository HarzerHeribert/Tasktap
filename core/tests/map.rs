//! What Tasktap knows of a person's projects (docs/projects-design.md):
//! the root rule, a repository's identity, the agents' histories as their
//! adapters read them, the migration that adds the records, and the one
//! rule of rights: a project Tasktap knows gives none until a thought
//! starts there. Every folder here is made by the test under a home of its
//! own; the names are invented.

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;

use common::*;
use tasktap_core::map::{self, Input, Kind, Rule, Within};
use tasktap_core::route::{self, Named, Request};
use tasktap_core::state::{Destination, Route};
use tasktap_core::store::{MIGRATIONS, Store};
use tasktap_proto::call;
use tasktap_proto::*;

fn mkdir(p: &Path) {
    std::fs::create_dir_all(p).unwrap();
}

fn write(p: &Path, text: &str) {
    mkdir(p.parent().unwrap());
    std::fs::write(p, text).unwrap();
}

fn real(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap()
}

fn git(at: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .current_dir(at)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?}");
}

/// A repository with one commit, and a remote when one is given.
fn repo(at: &Path, about: &str, remote: Option<&str>) {
    mkdir(at);
    git(at, &["init", "-q", "-b", "main"]);
    write(
        &at.join("README.md"),
        &format!(
            "# {}\n\n{about}\n",
            at.file_name().unwrap().to_string_lossy()
        ),
    );
    git(at, &["add", "."]);
    git(
        at,
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-q",
            "-m",
            "first",
        ],
    );
    if let Some(remote) = remote {
        git(at, &["remote", "add", "origin", remote]);
    }
}

fn copy(from: &Path, to: &Path) {
    mkdir(to.parent().unwrap());
    let ok = Command::new("cp")
        .arg("-R")
        .arg(from)
        .arg(to)
        .status()
        .unwrap()
        .success();
    assert!(ok);
}

/// Sets a file's modified time, as an agent's last write would have.
fn touch(p: &Path, ms: u64) {
    let file = std::fs::File::options().write(true).open(p).unwrap();
    file.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms))
        .unwrap();
}

#[test]
fn the_root_rule_says_which_folder_is_a_project() {
    let t = Folder::new("root-rule");
    let (home, data) = (t.0.join("home"), t.0.join("data"));
    mkdir(&home);
    mkdir(&data);
    let home = real(&home);
    let p = |rel: &str| home.join(rel);
    repo(&p("projects/cuegrid"), "Cue sheets.", None);
    write(
        &p("projects/cuegrid/package.json"),
        r#"{"name": "@acme/cuegrid", "description": "Cue sheets"}"#,
    );
    mkdir(&p("projects/cuegrid/web"));
    repo(&p("projects/kiln"), "A static site generator.", None);
    git(
        &p("projects/kiln"),
        &["worktree", "add", "-q", "../kiln-fast", "-b", "fast"],
    );
    write(&p("projects/fieldnotes/AGENTS.md"), "notes for agents");
    mkdir(&p("projects/empty"));
    write(
        &p("Documents/recipes/Cargo.toml"),
        "[package]\nname = \"recipes\"\n",
    );
    repo(&p(".dotfiles"), "My settings.", None);
    mkdir(&p("Desktop"));
    mkdir(&p("Downloads"));
    repo(
        &t.0.join("scratch/run"),
        "A temporary folder's repository.",
        None,
    );
    repo(
        &p(".cache/bench/run-1/cuegrid"),
        "A benchmark's copy.",
        None,
    );
    repo(
        &p("projects/cuegrid/target/tmp/fixture"),
        "A test's repository.",
        None,
    );
    let rule = Rule::new(&home, &data);
    let kind = |rel: &str| rule.kind(&real(&p(rel)));
    let top = |git, package, signs| Kind::Top {
        git,
        package,
        signs,
    };
    assert_eq!(kind("projects/cuegrid"), top(true, true, false));
    assert_eq!(
        kind("projects/cuegrid/web"),
        Kind::Inside(real(&p("projects/cuegrid")))
    );
    assert_eq!(
        kind("projects/kiln-fast"),
        Kind::Copy(real(&p("projects/kiln")))
    );
    assert_eq!(kind("projects/fieldnotes"), top(false, false, true));
    assert_eq!(kind("projects/empty"), Kind::Bare);
    assert_eq!(kind("Documents/recipes"), top(false, true, false));
    assert_eq!(kind(".dotfiles"), top(true, false, false));
    // Never by itself: the home folder, Documents, another tool's hidden
    // folder, a build's output, Tasktap's own data.
    for never in [
        "",
        "Documents",
        "Desktop",
        "Downloads",
        ".cache/bench/run-1/cuegrid",
        "projects/cuegrid/target/tmp/fixture",
    ] {
        assert_eq!(kind(never), Kind::Never, "{never}");
    }
    assert_eq!(rule.kind(&real(&data)), Kind::Never);
    // A repository in a temporary folder, outside the home folder.
    assert_eq!(rule.kind(&real(&t.0.join("scratch/run"))), Kind::Never);
    assert_eq!(rule.kind(&p("projects/gone")), Kind::Gone);
}

#[test]
fn a_folder_in_a_worktree_a_submodule_or_a_bare_layout_counts_for_its_repository() {
    let t = Folder::new("root-links");
    let (home, data) = (t.0.join("home"), t.0.join("data"));
    mkdir(&home);
    mkdir(&data);
    let home = real(&home);
    let p = |rel: &str| home.join(rel);
    // A worktree, and a folder deep in it with a package file of its own.
    repo(&p("code/harbor"), "Ships.", None);
    git(
        &p("code/harbor"),
        &["worktree", "add", "-q", "../../wt/feature", "-b", "feature"],
    );
    write(&p("wt/feature/app/package.json"), r#"{"name": "app"}"#);
    mkdir(&p("wt/feature/app/src"));
    // An agent's worktree in its own hidden folder, and a folder in it.
    git(
        &p("code/harbor"),
        &[
            "worktree",
            "add",
            "-q",
            "../../.agent/worktrees/x",
            "-b",
            "x",
        ],
    );
    mkdir(&p(".agent/worktrees/x/src"));
    // A submodule, and a folder in it.
    repo(&p("code/lib"), "A library.", None);
    repo(&p("code/mono"), "Everything.", None);
    git(
        &p("code/mono"),
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            p("code/lib").to_str().unwrap(),
            "sub",
        ],
    );
    mkdir(&p("code/mono/sub/src"));
    // A bare repository with its worktrees beside it: `proj/.bare`, and
    // `proj/.git` saying `gitdir: ./.bare`.
    repo(&p("seed"), "Seed.", None);
    mkdir(&p("code/tide"));
    git(
        &p("code/tide"),
        &[
            "clone",
            "-q",
            "--bare",
            p("seed").to_str().unwrap(),
            ".bare",
        ],
    );
    write(&p("code/tide/.git"), "gitdir: ./.bare\n");
    git(&p("code/tide"), &["worktree", "add", "-q", "main", "main"]);
    mkdir(&p("code/tide/main/src"));
    // A repository whose git folder is kept elsewhere.
    mkdir(&p("code/kept"));
    mkdir(&p("gitdirs"));
    git(
        &p("code/kept"),
        &[
            "init",
            "-q",
            "--separate-git-dir",
            p("gitdirs/kept").to_str().unwrap(),
        ],
    );

    let rule = Rule::new(&home, &data);
    let kind = |rel: &str| rule.kind(&real(&p(rel)));
    let copy = |rel: &str| Kind::Copy(real(&p(rel)));
    for (folder, want) in [
        ("wt/feature", copy("code/harbor")),
        ("wt/feature/app", copy("code/harbor")),
        ("wt/feature/app/src", copy("code/harbor")),
        (".agent/worktrees/x/src", copy("code/harbor")),
        ("code/mono/sub", copy("code/mono")),
        ("code/mono/sub/src", copy("code/mono")),
        ("code/tide/main", copy("code/tide")),
        ("code/tide/main/src", copy("code/tide")),
    ] {
        assert_eq!(kind(folder), want, "{folder}");
    }
    let git_top = Kind::Top {
        git: true,
        package: false,
        signs: false,
    };
    assert_eq!(kind("code/tide"), git_top, "a bare layout's top");
    assert_eq!(kind("code/kept"), git_top, "a git folder kept elsewhere");
    assert_eq!(kind("code/mono"), git_top);

    // A look at the agent's history makes one card for harbor, none for its
    // worktree or a folder in it; tide's card reads its remote from `.bare`.
    git(
        &p("code/tide"),
        &[
            "remote",
            "set-url",
            "origin",
            "git@example.com:acme/tide.git",
        ],
    );
    let input = Input {
        rule: Rule::new(&home, &data),
        data: data.clone(),
        looks: vec![Look {
            id: LookId::mint(),
            rev: Rev::ZERO,
            kind: LookKind::Folder,
            agent: None,
            folder: Some(p("code").to_str().unwrap().into()),
            on: true,
            state: LookState::New,
            found: 0,
            looked: None,
            note: None,
            stamp: None,
        }],
        opened: Vec::new(),
        known: Default::default(),
    };
    let out = map::read(input);
    let tide = out.cards.iter().find(|m| m.name == "tide").unwrap();
    assert_eq!(tide.repo.as_deref(), Some("remote example.com/acme/tide"));
}

#[test]
fn the_root_rule_holds_on_other_volumes() {
    let t = Folder::new("root-volumes");
    let (home, data, volumes) = (t.0.join("home"), t.0.join("data"), t.0.join("Volumes"));
    mkdir(&home);
    mkdir(&data);
    mkdir(&volumes);
    let volumes = real(&volumes);
    let v = |rel: &str| volumes.join(rel);
    write(&v("disk/mono/package.json"), r#"{"name": "mono"}"#);
    write(
        &v("disk/mono/packages/web/package.json"),
        r#"{"name": "web"}"#,
    );
    mkdir(&v("disk/mono/packages/web/src"));
    repo(&v("disk/.cache/run/harbor"), "A tool's copy.", None);
    repo(&v("disk/code/harbor"), "Ships.", None);
    let rule = Rule::new(&real(&home), &data).with_volumes(&[(&volumes, 1)]);
    let kind = |rel: &str| rule.kind(&v(rel));
    // A package in a package: inside the outermost, the project.
    let mono = Kind::Inside(v("disk/mono"));
    assert_eq!(kind("disk/mono/packages/web"), mono);
    assert_eq!(kind("disk/mono/packages/web/src"), mono);
    assert_eq!(kind(".cache/run/harbor"), Kind::Gone);
    assert_eq!(kind("disk/.cache/run/harbor"), Kind::Never);
    assert_eq!(kind("disk"), Kind::Never, "a volume's root");
    assert_eq!(
        kind("disk/code/harbor"),
        Kind::Top {
            git: true,
            package: false,
            signs: false
        }
    );
    assert_eq!(rule.kind(&real(&t.0)), Kind::Never, "on no volume");
}

#[test]
fn a_repository_is_one_project_whatever_its_copies() {
    // Its remote's address, without user, password or `.git`.
    let cases = [
        (
            "git@github.com:Acme/Cuegrid.git",
            Some("github.com/acme/cuegrid"),
        ),
        (
            "https://someone:token@github.com/acme/cuegrid.git",
            Some("github.com/acme/cuegrid"),
        ),
        (
            "ssh://git@git.example.com:2222/acme/cuegrid",
            Some("git.example.com/acme/cuegrid"),
        ),
        ("/Users/someone/projects/cuegrid", None),
        ("file:///srv/cuegrid.git", None),
        ("C:/Users/someone/cuegrid", None),
        ("C:\\code\\cuegrid", None),
        ("\\\\server\\share\\cuegrid", None),
    ];
    for (url, want) in cases {
        assert_eq!(map::address(url).as_deref(), want, "{url}");
    }
    let config = "[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = git@github.com:acme/up.git\n[remote \"origin\"]\n\turl = https://x:y@gitlab.com/acme/ledger.git\n";
    assert_eq!(
        map::remote(config).as_deref(),
        Some("gitlab.com/acme/ledger")
    );

    // Without a remote, by its first commit: three full copies of one
    // repository and one other, in two folders to look in.
    let t = Folder::new("identity");
    let (home, data) = (t.0.join("home"), t.0.join("data"));
    mkdir(&data);
    repo(
        &home.join("projects/ledger"),
        "Invoicing for freelancers.",
        None,
    );
    repo(&home.join("projects/tidepool"), "A photo library.", None);
    copy(
        &home.join("projects/ledger"),
        &home.join("projects/ledger-old"),
    );
    copy(
        &home.join("projects/ledger"),
        &home.join("work/ledger-copy"),
    );
    repo(
        &home.join("projects/cuegrid"),
        "Cue sheets.",
        Some("git@github.com:acme/cuegrid.git"),
    );
    copy(&home.join("projects/cuegrid"), &home.join("work/cuegrid"));
    // A clone of a folder on this machine: its remote is that folder.
    git(
        &home.join("work"),
        &["clone", "-q", "../projects/cuegrid", "cuegrid-local"],
    );
    // A project started from another's history, with a remote of its own:
    // one first commit, two repositories.
    repo(
        &home.join("projects/starter"),
        "A starter.",
        Some("git@github.com:acme/starter.git"),
    );
    copy(&home.join("projects/starter"), &home.join("projects/kiln"));
    git(
        &home.join("projects/kiln"),
        &[
            "remote",
            "set-url",
            "origin",
            "git@github.com:acme/kiln.git",
        ],
    );
    let home = real(&home);
    let look = |folder: PathBuf| Look {
        id: LookId::mint(),
        rev: Rev::ZERO,
        kind: LookKind::Folder,
        agent: None,
        folder: Some(folder.to_str().unwrap().into()),
        on: true,
        state: LookState::New,
        found: 0,
        looked: None,
        note: None,
        stamp: None,
    };
    let looks = vec![look(home.join("projects")), look(home.join("work"))];
    let input = Input {
        rule: Rule::new(&home, &data),
        data: data.clone(),
        looks: looks.clone(),
        opened: Vec::new(),
        known: Default::default(),
    };
    let out = map::read(input);
    let repo_of = |name: &str| {
        let m = out.cards.iter().find(|m| m.folder.ends_with(name)).unwrap();
        m.repo.clone().unwrap()
    };
    assert!(repo_of("projects/ledger").starts_with("root "));
    assert_eq!(repo_of("projects/ledger"), repo_of("projects/ledger-old"));
    assert_eq!(repo_of("projects/ledger"), repo_of("work/ledger-copy"));
    assert_ne!(repo_of("projects/ledger"), repo_of("projects/tidepool"));
    assert_eq!(repo_of("work/cuegrid"), "remote github.com/acme/cuegrid");
    assert_eq!(
        out.cards
            .iter()
            .find(|m| m.name == "ledger")
            .unwrap()
            .facts
            .about,
        "Invoicing for freelancers."
    );

    let (mut store, _) = Store::open(&t.0.join("core.db"), time(wall_ms())).unwrap();
    let mut tx = store.begin().unwrap();
    for l in &looks {
        tx.put_look(l).unwrap();
    }
    let projects = map::merge(&mut tx, out, time(wall_ms())).unwrap();
    tx.commit().unwrap();
    let cards = store.begin().unwrap().cards().unwrap();
    let by = |rel: &str| {
        cards
            .iter()
            .find(|c| c.folder == home.join(rel).to_str().unwrap())
            .unwrap()
    };
    // One project per repository; the copy beside other projects is it.
    assert_eq!(projects, 5, "ledger, tidepool, cuegrid, starter, kiln");
    let ledger = by("projects/ledger");
    assert!(map::offered(ledger) || map::offered(by("projects/ledger-old")));
    let main = cards
        .iter()
        .filter(|c| c.repo == ledger.repo && c.copy_of.is_none())
        .count();
    assert_eq!(main, 1);
    let primary = cards
        .iter()
        .find(|c| c.repo == ledger.repo && c.copy_of.is_none())
        .unwrap();
    assert!(
        primary.folder.contains("/projects/"),
        "the copy among other projects"
    );
    assert_eq!(by("work/ledger-copy").copy_of, Some(primary.id));
    // Two copies each beside other projects: the shorter path is it, the
    // other under it, until the person chooses (`main`).
    let (a, b) = (by("work/cuegrid"), by("projects/cuegrid"));
    assert_eq!((a.copy_of, b.copy_of), (None, Some(a.id)));
    // The local clone joins them by its first commit; the project started
    // from their history, with its own remote, does not.
    assert_eq!(by("work/cuegrid-local").copy_of, Some(a.id));
    assert_eq!(by("projects/kiln").copy_of, None);
    assert_eq!(by("projects/starter").copy_of, None);
}

/// The words of the language as the checks know them: a few, so that a
/// check reads the same on every system.
fn words() -> route::Lexicon {
    route::Lexicon(vec![
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/words.txt"),
    ])
}

/// A look in `folder`, on.
fn folder_look(folder: &Path) -> Look {
    Look {
        id: LookId::mint(),
        rev: Rev::ZERO,
        kind: LookKind::Folder,
        agent: None,
        folder: Some(folder.to_str().unwrap().into()),
        on: true,
        state: LookState::New,
        found: 0,
        looked: None,
        note: None,
        stamp: None,
    }
}

/// What a look at `looks` reads, as the core would give it from `store`.
fn reads(store: &mut Store, home: &Path, data: &Path, looks: &[Look]) -> map::Output {
    let known = store.begin().unwrap().cards().unwrap();
    map::read(Input {
        rule: Rule::new(home, data),
        data: data.to_owned(),
        looks: looks.to_vec(),
        opened: Vec::new(),
        known: known.into_iter().map(|c| (c.folder, c.root)).collect(),
    })
}

/// Writes what a look read, as the core does when it ends.
fn merged(store: &mut Store, out: map::Output) -> u32 {
    let mut tx = store.begin().unwrap();
    let projects = map::merge(&mut tx, out, time(wall_ms())).unwrap();
    tx.commit().unwrap();
    projects
}

#[test]
fn a_look_that_cannot_read_keeps_its_projects_and_one_taken_away_while_it_reads_keeps_none() {
    let t = Folder::new("merge");
    let (home, data) = (t.0.join("home"), t.0.join("data"));
    mkdir(&data);
    repo(&home.join("disk/harbor"), "Ships.", None);
    repo(&home.join("disk/kiln"), "Sites.", None);
    repo(&home.join("code/tidepool"), "Photos.", None);
    let home = real(&home);
    let (disk, code) = (
        folder_look(&home.join("disk")),
        folder_look(&home.join("code")),
    );
    let looks = [disk.clone(), code.clone()];
    let (mut store, _) = Store::open(&t.0.join("core.db"), time(wall_ms())).unwrap();
    let mut tx = store.begin().unwrap();
    for l in &looks {
        tx.put_look(l).unwrap();
    }
    tx.commit().unwrap();
    let out = reads(&mut store, &home, &data, &looks);
    assert_eq!(merged(&mut store, out), 3);
    let card = |store: &mut Store, name: &str| {
        let cards = store.begin().unwrap().cards().unwrap();
        cards.into_iter().find(|c| c.name == name)
    };
    let harbor = card(&mut store, "harbor").unwrap();

    // The folder looked in is gone (a volume unplugged): its projects stay,
    // marked not there, and are there again when it is back.
    std::fs::rename(home.join("disk"), home.join("away")).unwrap();
    let out = reads(&mut store, &home, &data, &looks);
    assert_eq!(out.looks[0].1, LookState::Gone);
    assert_eq!(merged(&mut store, out), 1, "tidepool alone is offered");
    let away = card(&mut store, "harbor").expect("kept while its folder is gone");
    assert_eq!(
        (away.id, away.available, away.looks),
        (harbor.id, false, vec![disk.id])
    );
    std::fs::rename(home.join("away"), home.join("disk")).unwrap();
    let out = reads(&mut store, &home, &data, &looks);
    assert_eq!(merged(&mut store, out), 3);
    let back = card(&mut store, "harbor").unwrap();
    assert_eq!((back.id, back.available), (harbor.id, true));

    // A look removed while it reads: what only it found is not kept, now
    // or when that read ends; one switched off alike.
    repo(&home.join("code/pyrite"), "Testing helpers.", None);
    let out = reads(&mut store, &home, &data, &looks);
    let mut tx = store.begin().unwrap();
    tx.delete_look(code.id).unwrap();
    map::unlook(&mut tx, code.id).unwrap();
    tx.commit().unwrap();
    assert_eq!(merged(&mut store, out), 2, "harbor and kiln");
    assert!(card(&mut store, "pyrite").is_none());
    assert!(card(&mut store, "tidepool").is_none());
    let mut tx = store.begin().unwrap();
    tx.put_look(&code).unwrap();
    tx.commit().unwrap();
    let out = reads(&mut store, &home, &data, &looks);
    let mut tx = store.begin().unwrap();
    tx.put_look(&Look {
        on: false,
        ..code.clone()
    })
    .unwrap();
    map::unlook(&mut tx, code.id).unwrap();
    tx.commit().unwrap();
    assert_eq!(merged(&mut store, out), 2);
    assert!(card(&mut store, "pyrite").is_none());
}

#[test]
fn a_name_the_person_gives_keeps_its_project_and_one_taken_away_stays_away() {
    let t = Folder::new("names");
    let (home, data) = (t.0.join("home"), t.0.join("data"));
    mkdir(&data);
    repo(&home.join("projects/cuegrid"), "Cue sheets.", None);
    write(
        &home.join("projects/cuegrid/package.json"),
        r#"{"name": "@acme/cue-sheets"}"#,
    );
    let home_text = real(&home).to_str().unwrap().to_owned();
    let core = Core::start_env(&data, &[], &[("HOME", &home_text)]);
    let mut w = core.watch();
    let look = w.ok::<call::LookAdd>(&AddLook {
        id: LookId::mint(),
        folder: Some(format!("{home_text}/projects")),
        agent: None,
        on: None,
    });
    w.ok::<call::ProjectsLook>(&Empty {});
    w.sync();
    let card = w.model.cards.values().next().unwrap().clone();
    assert_eq!(card.names, ["cue-sheets"]);
    let name = |w: &mut Watch, names: &[&str]| {
        let patch = CardPatch {
            names: Some(names.iter().map(|n| (*n).into()).collect()),
            hidden: None,
            main: None,
        };
        let target = PutTarget::Cards { id: card.id, patch };
        w.ok::<call::Put>(&Put {
            target,
            if_rev: None,
        });
        w.ok::<call::ProjectsLook>(&Empty {});
        w.sync();
        w.model.cards.get(&card.id).map(|c| c.names.clone())
    };
    // Its package's name taken away, another given: a look keeps both so.
    assert_eq!(name(&mut w, &["rehearsal"]), Some(vec!["rehearsal".into()]));
    // The look that found it switched off: the name the person gave keeps it.
    let off = PutTarget::Looks {
        id: look,
        patch: LookPatch { on: Some(false) },
    };
    w.ok::<call::Put>(&Put {
        target: off,
        if_rev: None,
    });
    w.sync();
    let kept = w
        .model
        .cards
        .get(&card.id)
        .expect("a project the person named is kept");
    assert_eq!(kept.names, ["rehearsal"]);

    // Said to be no project after a thought was picked for it: the thought
    // does not start there, and nothing is opened.
    let id = ThoughtId::mint();
    w.ok::<call::ThoughtCapture>(&Capture {
        agent: Some("fixture".into()),
        card_id: Some(card.id),
        ..typed(id, "fix the countdown")
    });
    let hide = PutTarget::Cards {
        id: card.id,
        patch: CardPatch {
            names: None,
            hidden: Some(true),
            main: None,
        },
    };
    w.ok::<call::Put>(&Put {
        target: hide,
        if_rev: None,
    });
    let e = w.refused::<call::ThoughtStart>(&Start {
        id,
        attempt: AttemptId::mint(),
    });
    assert_eq!(e.code, Code::Invalid, "{e}");
    w.sync();
    assert!(!w.model.projects.values().any(|p| p.folder == card.folder));
}

#[test]
fn a_look_reads_again_only_when_what_it_reads_changed_also_after_the_core_starts_again() {
    let t = Folder::new("fresh");
    let (home, data) = (t.0.join("home"), t.0.join("data"));
    mkdir(&data);
    let (kiln, tidepool) = (home.join("projects/kiln"), home.join("projects/tidepool"));
    mkdir(&kiln);
    mkdir(&tidepool);
    let home = real(&home);
    let day = home.join(".codex/sessions/2026/11/18");
    let session = |name: &str, folder: &Path| {
        let cwd = serde_json::to_string(real(folder).to_str().unwrap()).unwrap();
        let first = format!(r#"{{"type":"session_meta","payload":{{"id":"x","cwd":{cwd}}}}}"#);
        write(&day.join(name), &format!("{first}\n"));
    };
    session("rollout-1.jsonl", &kiln);
    let (home_text, codex) = (
        home.to_str().unwrap().to_owned(),
        home.join(".codex").to_str().unwrap().to_owned(),
    );
    let env = [("HOME", home_text.as_str()), ("CODEX_HOME", codex.as_str())];
    let core = Core::start_env(&data, &[], &env);
    let mut w = core.watch();
    w.ok::<call::LookAdd>(&AddLook {
        id: LookId::mint(),
        folder: None,
        agent: Some("codex".into()),
        on: None,
    });
    assert_eq!(w.ok::<call::ProjectsLook>(&Empty {}).projects, 1);
    w.sync();
    let read = |w: &Watch| {
        let l = w.model.looks.values().next().unwrap();
        (l.looked, l.rev)
    };
    let first = read(&w);
    // What a capture or the list's field does: the cheap check, then a look if due.
    let find = |w: &mut Watch| {
        let text = Find {
            text: "tide".into(),
            limit: None,
            thought: false,
        };
        let found = w.ok::<call::ProjectsFind>(&text).found;
        std::thread::sleep(std::time::Duration::from_millis(400));
        w.sync();
        found
    };
    find(&mut w);
    assert_eq!(read(&w), first, "nothing changed: not read again");
    // The core starts again: what the last look saw is kept with it.
    drop(w);
    core.stop();
    let core = Core::start_env(&data, &[], &env);
    let mut w = core.watch();
    w.sync();
    find(&mut w);
    assert_eq!(
        read(&w),
        first,
        "started again, nothing changed: not read again"
    );
    // A session begins in the day's folder Codex already had: read again.
    session("rollout-2.jsonl", &tidepool);
    let since = std::time::Instant::now();
    while !w.model.cards.values().any(|c| c.name == "tidepool") {
        assert!(
            since.elapsed() < std::time::Duration::from_secs(5),
            "a new session in today's folder is not noticed"
        );
        find(&mut w);
    }
    assert_ne!(read(&w), first);
}

#[test]
fn an_agents_history_says_where_and_when_and_nothing_more_is_read() {
    let t = Folder::new("history");
    let home = t.0.join("home");
    let cuegrid = home.join("projects/cuegrid");
    let kiln = home.join("projects/kiln");
    mkdir(&cuegrid);
    mkdir(&kiln);
    // Claude Code: one folder per working folder; the path is the `cwd`
    // of the newest session file, its date the file's.
    let folder = home.join(".claude/projects/-home-projects-cuegrid");
    let older = folder.join("a.jsonl");
    let newer = folder.join("b.jsonl");
    let said = r#"{"type":"user","message":{"content":"secret words the person said"}}"#;
    write(&older, &format!("{said}\n{{\"cwd\":\"/elsewhere\"}}\n"));
    write(
        &newer,
        &format!(
            "{{\"type\":\"summary\"}}\n{{\"cwd\":{},\"sessionId\":\"x\"}}\n{said}\n",
            serde_json::to_string(cuegrid.to_str().unwrap()).unwrap()
        ),
    );
    touch(&older, 1_700_000_000_000);
    touch(&newer, 1_800_000_000_000);
    // A folder whose session names its folder only past the bound is not read further.
    let far = home.join(".claude/projects/-far/c.jsonl");
    write(
        &far,
        &format!("{}\n{{\"cwd\":\"/far\"}}\n", " ".repeat(map::HISTORY_BYTES)),
    );
    let claude = tasktap_core::agents::find("claude")
        .unwrap()
        .history()
        .unwrap();
    let mut within = Within::new(map::HISTORY_TIME, map::HISTORY_FILES);
    let worked = claude.read(&home, &mut within).unwrap();
    assert_eq!(
        worked,
        vec![map::Worked {
            folder: cuegrid.clone(),
            when: 1_800_000_000_000
        }]
    );

    // Codex: the dated folders, newest first; the first line's `cwd` only.
    let day = home.join(".codex/sessions/2026/11/18");
    let first = format!(
        r#"{{"timestamp":"2026-11-18T08:00:00Z","type":"session_meta","payload":{{"id":"x","cwd":{}}}}}"#,
        serde_json::to_string(kiln.to_str().unwrap()).unwrap()
    );
    write(&day.join("rollout-1.jsonl"), &format!("{first}\n{said}\n"));
    touch(&day.join("rollout-1.jsonl"), 1_790_000_000_000);
    write(
        &day.join("rollout-2.jsonl"),
        "{\"type\":\"session_meta\"}\n{\"cwd\":\"/second-line\"}\n",
    );
    let codex = tasktap_core::agents::find("codex")
        .unwrap()
        .history()
        .unwrap();
    let mut within = Within::new(map::HISTORY_TIME, map::HISTORY_FILES);
    let worked = codex.read(&home, &mut within).unwrap();
    assert_eq!(
        worked,
        vec![map::Worked {
            folder: kiln.clone(),
            when: 1_790_000_000_000
        }]
    );
    // Within its bounds: no file past the number allowed.
    let mut none = Within::new(map::HISTORY_TIME, 0);
    assert!(codex.read(&home, &mut none).unwrap().is_empty());
    assert!(codex.folder(&home).ends_with(".codex/sessions"));
}

#[test]
fn a_schema_2_store_keeps_every_record_as_it_takes_the_map() {
    let t = Folder::new("migrate-map");
    let db = t.0.join("core.db");
    let before = {
        let (mut store, _) = Store::open_with(&db, &MIGRATIONS[..2], time(wall_ms())).unwrap();
        let mut tx = store.begin().unwrap();
        let mut project = tx.scratch().unwrap().unwrap();
        project.id = ProjectId::mint();
        project.folder = "/home/someone/projects/cuegrid".into();
        project.name = "cuegrid".into();
        project.kind = ProjectKind::Folder;
        tx.insert_project(&project).unwrap();
        tx.commit().unwrap();
        let tx = store.begin().unwrap();
        tx.projects().unwrap()
    };
    let (mut store, _) = Store::open(&db, time(wall_ms())).unwrap();
    let tx = store.begin().unwrap();
    assert_eq!(
        tx.projects().unwrap(),
        before,
        "every record kept as it was"
    );
    assert!(tx.cards().unwrap().is_empty() && tx.looks().unwrap().is_empty());
    assert!(t.0.join("core.v2.db").exists(), "backed up first");
}

#[test]
fn placing_finds_names_as_written_and_as_said_and_asks_when_unsure() {
    let card = |name: &str, about: &str, used: u64| Named {
        to: Destination::Card(CardId::mint()),
        name: name.into(),
        aliases: Vec::new(),
        about: about.into(),
        folder: format!("/home/someone/projects/{name}"),
        used: Time::new(used),
    };
    let projects = vec![
        card("pyrite", "Property-based testing helpers for Python", 3),
        card(
            "ledgerline",
            "Invoicing for freelancers: invoices, reminders and PDF export",
            2,
        ),
        card("ledger-api", "HTTP API of ledgerline", 1),
        card("kiln", "A static site generator", 5),
        Named {
            folder: "/home/someone/work/kiln".into(),
            ..card("kiln", "", 4)
        },
    ];
    let place = |text: &str| {
        route::local(&Request {
            text: text.into(),
            projects: projects.clone(),
            ..Request::default()
        })
    };
    let to = |name: &str| projects.iter().find(|p| p.name == name).unwrap().to;
    // As it sounds: proposed and asked about, never placed by itself.
    match place("write a shrinker for date ranges in pie right") {
        Route::Ambiguous { candidates, .. } => {
            assert_eq!(candidates[0].to, to("pyrite"));
            assert_eq!(candidates[0].why, "said as “pie right”");
        }
        other => panic!("{other:?}"),
    }
    match place("ledger A P I should return 404") {
        Route::Clear { to: at, .. } => assert_eq!(at, to("ledger-api")),
        other => panic!("{other:?}"),
    }
    // One name two projects have: asked, with both.
    match place("kiln rebuilds every page") {
        Route::Ambiguous { candidates, .. } => assert_eq!(candidates.len(), 2),
        other => panic!("{other:?}"),
    }
    // Only described: asked, the fitting one first, at most three.
    match place("the invoice export is slow") {
        Route::Ambiguous { candidates, .. } => {
            assert!(candidates.len() <= route::CHOICES);
            assert_eq!(candidates[0].to, to("ledgerline"));
            assert!(candidates[0].why.contains("export"));
        }
        other => panic!("{other:?}"),
    }
    // With no project known, a thought is kept for later.
    let none = route::local(&Request {
        text: "make the build faster".into(),
        ..Request::default()
    });
    assert_eq!(none, Route::Unknown);
}

#[test]
fn a_field_finds_a_project_by_what_is_typed_and_a_thought_by_its_own_words() {
    let t = Folder::new("find");
    let (home, data) = (t.0.join("home"), t.0.join("data"));
    mkdir(&data);
    let made = [
        (
            "harbormaster",
            "Deploys containers to a small fleet over SSH.",
        ),
        ("cuegrid", "Cue sheets and a rehearsal timer."),
        ("tidepool", "A photo library."),
        ("kiln", "A static site generator with incremental builds."),
        ("pyrite", "Property-based testing helpers for Python."),
        ("ledger-api", "The HTTP API of a ledger for freelancers."),
    ];
    for (name, about) in made {
        repo(&home.join("projects").join(name), about, None);
    }
    let home_text = real(&home).to_str().unwrap().to_owned();
    let core = Core::start_env(&data, &[], &[("HOME", &home_text)]);
    let mut w = core.watch();
    w.ok::<call::LookAdd>(&AddLook {
        id: LookId::mint(),
        folder: Some(format!("{home_text}/projects")),
        agent: None,
        on: None,
    });
    let looked = w.ok::<call::ProjectsLook>(&Empty {});
    assert_eq!(looked.projects, 6);
    let find = |w: &mut Watch, text: &str, thought: bool| -> Vec<String> {
        let args = Find {
            text: text.into(),
            limit: Some(5),
            thought,
        };
        let found = w.ok::<call::ProjectsFind>(&args).found;
        found.into_iter().map(|f| f.name).collect()
    };
    // Typed into the field: what its names match, nothing else.
    for (typed, want) in [
        ("harbor", &["harbormaster"][..]),
        ("cue", &["cuegrid"]),
        ("tide", &["tidepool"]),
        ("master", &["harbormaster"]),
        ("led ap", &["ledger-api"]),
        ("ledger api", &["ledger-api"]),
        ("LedgerAPI", &["ledger-api"]),
        ("freelan", &["ledger-api"]),
        ("pirite", &["pyrite"]),
        ("farr", &[]),
        ("zebra", &[]),
        ("", &[]),
    ] {
        assert_eq!(find(&mut w, typed, false), want, "typed {typed:?}");
    }
    // A thought: the places its own words name or describe, never one
    // only because it was worked on lately.
    assert_eq!(
        find(&mut w, "the static site rebuilds every page", true),
        ["kiln"]
    );
    assert_eq!(
        find(&mut w, "ship the containers to the fleet tonight", true),
        ["harbormaster"]
    );
    assert!(find(&mut w, "rename the variables", true).is_empty());
}

#[test]
fn a_name_said_only_as_it_sounds_or_an_everyday_word_is_asked_about() {
    let card = |name: &str, about: &str| Named {
        to: Destination::Card(CardId::mint()),
        name: name.into(),
        aliases: Vec::new(),
        about: about.into(),
        folder: format!("/home/someone/projects/{name}"),
        used: None,
    };
    let projects = vec![
        card("tidepool", "A photo library"),
        card("cuegrid", "Cue sheets and a rehearsal timer"),
        card("pyrite", "Property-based testing helpers for Python"),
        card("test", ""),
        card("app", "The phone app"),
        card("notes", ""),
        card("my-app", ""),
        card("harbormaster", "Deploys containers to a small fleet"),
        card("snow-line", ""),
        card("scripts", ""),
        card("deploy", ""),
        card("tasktap-api", ""),
        card("cuegrid-web", ""),
    ];
    let place = |text: &str| {
        route::local(&Request {
            text: text.into(),
            projects: projects.clone(),
            words: words(),
            ..Request::default()
        })
    };
    let to = |name: &str| projects.iter().find(|p| p.name == name).unwrap().to;
    // Asked, with the one it sounds like or the everyday word first; also
    // words that are a name written apart, used as words.
    for (text, first) in [
        ("today pool party list", "tidepool"),
        ("queue grid timer is off by a second", "cuegrid"),
        ("write a test for the parser", "test"),
        ("make the app icon bigger", "app"),
        (
            "the harbor master called about the mooring fee",
            "harbormaster",
        ),
        ("the snow line is lower than last winter", "snow-line"),
        ("cue grid needs a bigger font", "cuegrid"),
        (
            "the scripts folder has two copies of the backup job",
            "scripts",
        ),
        // "to" before a name that is also a verb is the verb's.
        ("remember to test the export", "test"),
        ("time to deploy the new build on friday", "deploy"),
        // A folder of that name inside a path is no name.
        ("src/app/page.tsx has a typo", "app"),
        // Words written apart that are another project's name as well.
        ("the cuegrid web login is broken", "cuegrid-web"),
    ] {
        match place(text) {
            Route::Ambiguous { candidates, .. } => {
                assert_eq!(candidates[0].to, to(first), "{text}: {candidates:?}")
            }
            other => panic!("{text}: {other:?}"),
        }
    }
    // Placed: a name written, and everyday words used as a name.
    for (text, want) in [
        ("add notes to the readme of pyrite", "pyrite"),
        ("fix the login screen in app", "app"),
        ("the test project needs a new fixture", "test"),
        ("bump the version in `notes`", "notes"),
        ("my-app crashes at launch", "my-app"),
        ("in harbor master roll back the last deploy", "harbormaster"),
        (
            "the harbor master project needs a dry run flag",
            "harbormaster",
        ),
        ("`snow line` shows the wrong peak", "snow-line"),
        ("harbormaster needs a dry run flag", "harbormaster"),
        ("snow-line shows the wrong peak", "snow-line"),
        // Something moved to it; a path that begins with it or ends at it.
        ("move the shared fixtures to test", "test"),
        ("app/src/page.tsx has a typo", "app"),
        ("~/code/app has a stale readme", "app"),
        // Words written apart, one of them made up for the name: no one
        // says it by accident.
        ("the tasktap api login is broken", "tasktap-api"),
    ] {
        match place(text) {
            Route::Clear { to: at, .. } => assert_eq!(at, to(want), "{text}"),
            other => panic!("{text}: {other:?}"),
        }
    }
}

#[cfg(unix)]
#[test]
fn a_fifo_is_never_read_and_a_look_that_hangs_is_let_go() {
    let t = Folder::new("stuck");
    let (home, data) = (t.0.join("home"), t.0.join("data"));
    mkdir(&data);
    let fifo = |p: &Path| {
        mkdir(p.parent().unwrap());
        assert!(Command::new("mkfifo").arg(p).status().unwrap().success());
    };
    // Named as an agent's session, and as a project's package file and README.
    fifo(&home.join(".claude/projects/-x/s.jsonl"));
    fifo(&home.join("projects/app/package.json"));
    fifo(&home.join("projects/app/README.md"));
    let within = |what: &str, work: Box<dyn FnOnce() -> String + Send>| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || tx.send(work()));
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .unwrap_or_else(|_| panic!("{what} waits on a FIFO"))
    };
    let h = home.clone();
    let read = within(
        "reading the agent's history",
        Box::new(move || {
            let claude = tasktap_core::agents::find("claude").unwrap();
            let mut within = Within::new(map::HISTORY_TIME, map::HISTORY_FILES);
            format!("{:?}", claude.history().unwrap().read(&h, &mut within))
        }),
    );
    assert_eq!(read, "Ok([])");
    let app = home.join("projects/app");
    let facts = within(
        "reading a project's facts",
        Box::new(move || format!("{:?}", map::facts(&app, false).names)),
    );
    assert_eq!(facts, "[]");

    // A look that does not end in time (here every look waits a minute) is
    // let go: whoever waits for it is told, and the core idles out.
    let home_text = real(&home).to_str().unwrap().to_owned();
    let extra = [
        "--check-ms",
        "60000",
        "--second-ms",
        "10",
        "--idle-ms",
        "300",
    ];
    let mut core = Core::start_env(&data, &extra, &[("HOME", &home_text)]);
    let mut w = core.watch();
    let started = std::time::Instant::now();
    let e = w.refused::<call::ProjectsLook>(&Empty {});
    assert_eq!(e.code, Code::Failed, "{e}");
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
    drop(w);
    let gone = std::time::Instant::now();
    while core.running() {
        assert!(
            gone.elapsed() < std::time::Duration::from_secs(10),
            "a look that hangs keeps the core"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

#[test]
fn a_known_project_gives_no_right_until_a_thought_starts_there() {
    let t = Folder::new("rights");
    let (home, data) = (t.0.join("home"), t.0.join("data"));
    mkdir(&data);
    repo(
        &home.join("projects/cuegrid"),
        "Cue sheets and a rehearsal timer.",
        None,
    );
    let cuegrid = real(&home.join("projects/cuegrid"));
    let session = home.join(".claude/projects/-home-projects-cuegrid/s.jsonl");
    write(
        &session,
        &format!(
            "{{\"cwd\":{}}}\n",
            serde_json::to_string(cuegrid.to_str().unwrap()).unwrap()
        ),
    );
    let home_text = real(&home).to_str().unwrap().to_owned();
    let path = format!(
        "{}:{}",
        agents(&data).display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let core = Core::start_env(&data, &[], &[("HOME", &home_text), ("PATH", &path)]);
    let mut w = core.watch();
    w.ok::<call::FixtureClock>(&FixtureClock {
        now: time(wall_ms()),
    });

    // Offered by `stat` alone, then read once the person allows it.
    let offer = w.ok::<call::ProjectsOffer>(&Empty {});
    assert!(offer.agents.iter().any(|a| a.agent == "claude"));
    let look = w.ok::<call::LookAdd>(&AddLook {
        id: LookId::mint(),
        folder: None,
        agent: Some("claude".into()),
        on: None,
    });
    let looked = w.ok::<call::ProjectsLook>(&Empty {});
    assert_eq!(looked.projects, 1);
    w.sync();
    assert_eq!(w.model.looks[&look].found, 1);
    let card = w
        .model
        .cards
        .values()
        .find(|c| c.folder == cuegrid.to_str().unwrap())
        .unwrap()
        .clone();
    assert_eq!(
        (card.agents.as_slice(), card.about.as_str()),
        (
            &["claude".to_owned()][..],
            "Cue sheets and a rehearsal timer."
        )
    );
    assert!(card.why.starts_with(&[Evidence::Agent, Evidence::Git]));

    let readme = cuegrid.join("README.md");
    let file = |w: &mut Watch| {
        let read = ReadFile {
            path: readme.to_str().unwrap().into(),
            credit: 1 << 16,
            unless: None,
        };
        w.call::<call::FileRead>(&read).map(|_| ())
    };
    assert_eq!(
        file(&mut w).unwrap_err().code,
        Code::Denied,
        "a card gives no right"
    );

    // Named as speech writes it: placed into the known project, which is
    // not opened yet; Undo leaves nothing behind.
    let id = ThoughtId::mint();
    w.ok::<call::ThoughtCapture>(&Capture {
        agent: Some("fixture".into()),
        ..typed(id, "in cue grid make the timer readable")
    });
    w.until("placed", |m| m.thought(id).phase == Phase::Routed);
    let th = w.model.thought(id).clone();
    assert_eq!(
        (th.card_id, th.project_id, th.placed),
        (Some(card.id), None, Some(Placed::Name))
    );
    assert_eq!(th.route.unwrap().quote.as_deref(), Some("cue grid"));
    w.ok::<call::ThoughtStop>(&Ref { id });
    w.sync();
    assert!(
        !w.model.projects.values().any(|p| p.folder == card.folder),
        "undo opens nothing"
    );
    assert_eq!(file(&mut w).unwrap_err().code, Code::Denied);

    // Picked and started: now it is a workspace, with its rights.
    let id = ThoughtId::mint();
    w.ok::<call::ThoughtCapture>(&Capture {
        agent: Some("fixture".into()),
        card_id: Some(card.id),
        ..typed(id, "fix the countdown")
    });
    w.ok::<call::ThoughtStart>(&Start {
        id,
        attempt: AttemptId::mint(),
    });
    w.until("opened", |m| {
        m.projects
            .values()
            .any(|p| p.folder == card.folder && p.open)
    });
    let project = w
        .model
        .projects
        .values()
        .find(|p| p.folder == card.folder)
        .unwrap()
        .id;
    w.until("started there", |m| {
        m.thought(id).project_id == Some(project)
    });
    w.until("the card names it", |m| {
        m.cards[&card.id].project_id == Some(project)
    });
    file(&mut w).expect("a workspace's file reads");
}
