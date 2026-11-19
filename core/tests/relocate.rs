//! Moving a data folder whole (`tasktap move-data`, `relocate`): on a
//! fixture folder made by the store, never a person's.

use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::Connection;
use tasktap_core::relocate::{self, Refused};
use tasktap_core::store::Store;
use tasktap_proto::Time;

/// A fresh folder under the system's temporary folder, removed afterwards.
struct Dir(PathBuf);

impl Dir {
    fn new(name: &str) -> Dir {
        let path = std::env::temp_dir().join(format!("tasktap-move-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        // Canonical, as the core names the copies of projects; on Windows as a person writes it, without `\\?\`.
        let path = fs::canonicalize(&path).unwrap();
        let text = path.to_str().unwrap();
        Dir(PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(text)))
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A data folder at `data` with a database the store made, and records that
/// name places inside the folder and one place outside it.
fn fixture(data: &Path) {
    fs::create_dir_all(data.join("worktrees")).unwrap();
    let (store, _) = Store::open(&data.join("core.db"), Time::new(1).unwrap()).unwrap();
    drop(store);
    let db = Connection::open(data.join("core.db")).unwrap();
    let inside = data.join("worktrees").join("0123456789abcdef");
    let doc = serde_json::json!({
        "workdir": { "path": inside.to_str().unwrap(), "branch": "tasktap/0123456789abcdef" },
        "folder": data.to_str().unwrap(),
        "elsewhere": format!("{} Older/x", data.to_str().unwrap()),
        "outside": "/somewhere/else",
    });
    db.execute(
        "INSERT INTO prefs (id, rev, data) VALUES ('fixture', 1, ?1)",
        [doc.to_string()],
    )
    .unwrap();
}

fn read(data: &Path) -> serde_json::Value {
    let db = Connection::open(data.join("core.db")).unwrap();
    let text: String = db
        .query_row("SELECT data FROM prefs WHERE id = 'fixture'", [], |r| {
            r.get(0)
        })
        .unwrap();
    serde_json::from_str(&text).unwrap()
}

#[test]
fn a_folder_moves_whole_with_its_records_rewritten_and_a_copy_of_its_database_kept() {
    let dir = Dir::new("whole");
    let (from, to) = (dir.0.join("Tasktap Next"), dir.0.join("Tasktap"));
    fixture(&from);
    fs::write(from.join("host-device.json"), "{}").unwrap();
    let moved = relocate::run(&from, &to).unwrap();
    assert!(!from.exists(), "the old folder is gone");
    assert!(
        to.join("host-device.json").is_file(),
        "everything in it came along"
    );
    assert_eq!(
        moved.backup.as_deref(),
        Some(to.join("core.before-move.db").as_path())
    );
    // The fixture's record, and the scratch project the store made, whose folder is in the data folder.
    assert_eq!(moved.records, 2);
    let db = Connection::open(to.join("core.db")).unwrap();
    let scratch: String = db
        .query_row(
            "SELECT folder FROM projects WHERE data ->> 'kind' = 'scratch'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(Path::new(&scratch), to.join("scratch"));
    let doc = read(&to);
    let path = |v: &serde_json::Value| PathBuf::from(v.as_str().unwrap());
    assert_eq!(
        path(&doc["workdir"]["path"]),
        to.join("worktrees").join("0123456789abcdef")
    );
    assert_eq!(path(&doc["folder"]), to);
    // A path that only begins with the folder's name is another place.
    assert_eq!(
        doc["elsewhere"],
        format!("{} Older/x", from.to_str().unwrap())
    );
    assert_eq!(doc["outside"], "/somewhere/else");
    // The copy is the database as it was before the move.
    let before = Connection::open(to.join("core.before-move.db")).unwrap();
    let text: String = before
        .query_row("SELECT data FROM prefs WHERE id = 'fixture'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(text.contains("Tasktap Next"), "{text}");
    // The store opens what was moved.
    Store::open(&to.join("core.db"), Time::new(1).unwrap()).unwrap();
}

#[test]
fn nothing_moves_while_a_core_holds_the_folder_or_is_starting_there() {
    let dir = Dir::new("held");
    let (from, to) = (dir.0.join("Tasktap Next"), dir.0.join("Tasktap"));
    fixture(&from);
    for lock in ["core.lock", "start.lock"] {
        let held = File::options()
            .create(true)
            .truncate(false)
            .write(true)
            .open(from.join(lock))
            .unwrap();
        held.lock().unwrap();
        assert!(
            matches!(relocate::run(&from, &to), Err(Refused::Running)),
            "{lock}"
        );
        assert!(
            from.join("core.db").is_file() && !to.exists(),
            "{lock}: nothing changed"
        );
        assert!(
            !from.join("core.before-move.db").exists(),
            "{lock}: not even the copy"
        );
        drop(held);
    }
    // Let go, the folder moves. (A process another test starts at that moment may hold a copy of the lock until it
    // has started its program: a lock belongs to the open file, which a child shares until then.)
    let mut tries = 0;
    let moved = loop {
        match relocate::run(&from, &to) {
            Err(Refused::Running) if tries < 50 => tries += 1,
            other => break other,
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    moved.unwrap();
}

#[test]
fn nothing_moves_onto_a_folder_that_exists_or_from_one_that_does_not() {
    let dir = Dir::new("there");
    let (from, to) = (dir.0.join("Tasktap Next"), dir.0.join("Tasktap"));
    fixture(&from);
    fs::create_dir_all(&to).unwrap();
    assert!(matches!(relocate::run(&from, &to), Err(Refused::Failed(_))));
    assert!(from.join("core.db").is_file());
    fs::remove_dir(&to).unwrap();
    assert!(matches!(
        relocate::run(&dir.0.join("nothing"), &to),
        Err(Refused::Failed(_))
    ));
    assert!(!to.exists());
}

#[test]
fn a_folder_without_a_database_moves_too() {
    let dir = Dir::new("empty");
    let (from, to) = (dir.0.join("Tasktap Next"), dir.0.join("Tasktap"));
    fs::create_dir_all(from.join("models")).unwrap();
    let moved = relocate::run(&from, &to).unwrap();
    assert!(to.join("models").is_dir() && moved.backup.is_none() && moved.records == 0);
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn the_copies_of_projects_are_found_by_their_projects_at_their_new_place() {
    let dir = Dir::new("worktrees");
    let (from, to) = (dir.0.join("Tasktap Next"), dir.0.join("Tasktap"));
    fixture(&from);
    let repo = dir.0.join("project");
    fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    fs::write(repo.join("a.txt"), "a").unwrap();
    git(&repo, &["add", "a.txt"]);
    git(
        &repo,
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "-m",
            "a",
        ],
    );
    let copy = from.join("worktrees").join("0123456789abcdef");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "tasktap/0123456789abcdef",
            copy.to_str().unwrap(),
        ],
    );
    let moved = relocate::run(&from, &to).unwrap();
    assert_eq!(
        (moved.worktrees, moved.repaired),
        (1, 1),
        "{:?}",
        moved.unrepaired
    );
    let list = git(&repo, &["worktree", "list", "--porcelain"]);
    let at = to.join("worktrees").join("0123456789abcdef");
    let shown = list.lines().any(|l| {
        l.strip_prefix("worktree ")
            .is_some_and(|p| Path::new(p) == at)
    });
    assert!(shown, "{list}");
    assert!(!list.contains("prunable"), "{list}");
    assert_eq!(git(&at, &["status", "--porcelain"]), "");
}
