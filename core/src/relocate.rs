//! Moving a data folder whole to another place (`tasktap move-data --from
//! <folder> --data <folder>`): what the app does once, when Tasktap takes
//! over the folder of the build that came before it under another name.
//!
//! Only while no core runs in the folder and none can start there: the
//! move holds `start.lock` and `core.lock` as a core does, and refuses at
//! once when either is held. Before anything changes the database is copied
//! beside itself as the store copies it before a migration (`VACUUM INTO`),
//! to `core.before-move.db`. Then the folder is renamed (one step, on one
//! volume), and every record that names a place inside it is rewritten to
//! name the same place in the new folder: the records keep whole paths, the
//! copies of projects' (`<data>/worktrees/<name>`) above all, which the core
//! proves by their place. If that fails the folder is renamed back. Last,
//! git is told where each copy now is (`git worktree repair`, run in it),
//! so that the project it belongs to finds it again; a copy git cannot
//! repair is said, and the move stands.

use std::ffi::OsStr;
use std::fs::{self, File, TryLockError};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use rusqlite::Connection;

/// Why a move did not happen.
#[derive(Debug)]
pub enum Refused {
    /// A core runs in the folder, or one is starting: nothing was changed.
    Running,
    /// Anything else, said in a sentence; nothing was changed, or what was
    /// changed was put back.
    Failed(String),
}

/// What a move did.
#[derive(Debug, Default, serde::Serialize)]
pub struct Moved {
    /// Where the copy of the database made before the move is now.
    pub backup: Option<PathBuf>,
    /// Records rewritten to name the new folder.
    pub records: usize,
    /// Copies of projects in the folder, and of those, the ones git now
    /// finds at their new place.
    pub worktrees: usize,
    pub repaired: usize,
    /// A sentence for each copy git could not repair.
    pub unrepaired: Vec<String>,
}

const BACKUP: &str = "core.before-move.db";

/// Moves the folder `from` to `to`, which must not exist yet.
pub fn run(from: &Path, to: &Path) -> Result<Moved, Refused> {
    let failed = |what: &str, e: &dyn std::fmt::Display| Refused::Failed(format!("{what}: {e}"));
    if to.symlink_metadata().is_ok() {
        return Err(Refused::Failed(format!("{} exists already", to.display())));
    }
    if !from.symlink_metadata().is_ok_and(|m| m.is_dir()) {
        return Err(Refused::Failed(format!(
            "{} is not a folder",
            from.display()
        )));
    }
    // As a core takes them: `start.lock` first, so none starts meanwhile,
    // then `core.lock`, which a running core holds for life.
    let mut held = Vec::new();
    for name in ["start.lock", "core.lock"] {
        let file = File::options()
            .create(true)
            .truncate(false)
            .write(true)
            .open(from.join(name))
            .map_err(|e| failed("the folder cannot be locked", &e))?;
        match file.try_lock() {
            Ok(()) => held.push(file),
            Err(TryLockError::WouldBlock) => return Err(Refused::Running),
            Err(TryLockError::Error(e)) => return Err(failed("the folder cannot be locked", &e)),
        }
    }
    let db = from.join("core.db");
    let mut moved = Moved::default();
    if db.exists() {
        let conn =
            Connection::open(&db).map_err(|e| failed("the database cannot be opened", &e))?;
        crate::store::copy(&conn, &from.join(BACKUP))
            .map_err(|e| failed("the database cannot be copied", &e))?;
        moved.backup = Some(to.join(BACKUP));
    }
    // The places as the records may name them: as given, and canonical (the
    // copies of projects are named canonically), each with its new name.
    let canonical = |p: &Path| -> Option<PathBuf> {
        Some(fs::canonicalize(p.parent()?).ok()?.join(p.file_name()?))
    };
    let mut pairs = vec![(from.to_path_buf(), to.to_path_buf())];
    if let (Some(a), Some(b)) = (canonical(from), canonical(to))
        && a != from
    {
        pairs.push((a, b));
    }
    // Windows renames no folder with a file open in it; elsewhere the locks
    // are kept until the folder is in its new place.
    if cfg!(windows) {
        held.clear();
    }
    fs::rename(from, to).map_err(|e| failed("the folder cannot be moved", &e))?;
    if to.join("core.db").exists() {
        match rewrite(&to.join("core.db"), &pairs) {
            Ok(n) => moved.records = n,
            Err(e) => {
                drop(held);
                let back = fs::rename(to, from);
                let why = format!("the records cannot be rewritten: {e}");
                return Err(Refused::Failed(match back {
                    Ok(()) => why,
                    Err(b) => format!("{why}; and the folder could not be put back: {b}"),
                }));
            }
        }
    }
    drop(held);
    repair(&to.join(crate::isolate::FOLDER), &mut moved);
    Ok(moved)
}

/// Rewrites every record's document that names a place inside an old folder
/// of `pairs` to name it inside the new one, in one transaction. A path is
/// matched whole: the folder itself, or the folder and a separator, as JSON
/// writes them.
fn rewrite(db: &Path, pairs: &[(PathBuf, PathBuf)]) -> Result<usize, String> {
    let mut conn = Connection::open(db).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let tables: Vec<String> = tx
        .prepare(
            "SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) c \
             WHERE m.type = 'table' AND c.name = 'data' ORDER BY m.name",
        )
        .and_then(|mut s| s.query_map([], |r| r.get(0))?.collect())
        .map_err(|e| e.to_string())?;
    let json = |p: &Path| -> Result<String, String> {
        let text = p.to_str().ok_or("a path is not UTF-8")?;
        serde_json::to_string(text).map_err(|e| e.to_string())
    };
    let separator = serde_json::to_string(std::path::MAIN_SEPARATOR_STR).unwrap();
    let separator = &separator[1..separator.len() - 1];
    let mut changed = 0;
    for (old, new) in pairs {
        let (old, new) = (json(old)?, json(new)?);
        // `"<old>"` whole, and `"<old>/` before more of a path.
        let (old_open, new_open) = (&old[..old.len() - 1], &new[..new.len() - 1]);
        let (old_prefix, new_prefix) = (
            format!("{old_open}{separator}"),
            format!("{new_open}{separator}"),
        );
        for table in &tables {
            let sql = format!(
                "UPDATE \"{table}\" SET data = replace(replace(data, ?1, ?2), ?3, ?4) \
                 WHERE instr(data, ?1) > 0 OR instr(data, ?3) > 0"
            );
            changed += tx
                .execute(&sql, [&old_prefix, &new_prefix, &old, &new])
                .map_err(|e| format!("{table}: {e}"))?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(changed)
}

/// Tells git where each copy in `worktrees` now is: `git worktree repair`,
/// run in the copy, rewrites its project's note of where it lives.
fn repair(worktrees: &Path, moved: &mut Moved) {
    let Ok(entries) = fs::read_dir(worktrees) else {
        return;
    };
    let git = crate::terminal::find("git");
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.join(".git").is_file() {
            continue;
        }
        moved.worktrees += 1;
        let name = path
            .file_name()
            .unwrap_or(OsStr::new(""))
            .to_string_lossy()
            .into_owned();
        let Some(git) = &git else {
            moved
                .unrepaired
                .push(format!("{name}: git is not installed"));
            continue;
        };
        let ran = Command::new(git)
            .args(["worktree", "repair"])
            .current_dir(&path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .stdin(Stdio::null())
            .output();
        match ran {
            Ok(out) if out.status.success() => moved.repaired += 1,
            Ok(out) => {
                let said = String::from_utf8_lossy(&out.stderr);
                moved.unrepaired.push(format!("{name}: {}", said.trim()));
            }
            Err(e) => moved.unrepaired.push(format!("{name}: {e}")),
        }
    }
}
