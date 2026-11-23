//! The placing record: a private list, kept on this machine in the data
//! folder and sent nowhere, of every task a model placed and what the person
//! then did with the decision. It holds the [`KEPT`] newest entries, and
//! helps Tasktap learn where the person's tasks go (`route-lab` reads it, so
//! placings can be replayed and scored).
//!
//! One JSON object a line, appended: an entry when a model's answer is taken,
//! and a line of what the person did when they do it. Reading folds the
//! second into the first. Nothing here may fail a placing: a record that
//! cannot be written is left unwritten.

use crate::calls::Cx;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use tasktap_proto::Empty;
use tasktap_proto::call::Error;

/// Most entries kept; the oldest go first.
pub const KEPT: usize = 5000;

const FILE: &str = "placings.jsonl";

/// The file of the record in a data folder.
pub fn file(data: &Path) -> PathBuf {
    data.join(FILE)
}

/// What the person did with a decision a model made.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Did {
    /// The decision stood: the task started where the model put it.
    Stood,
    /// Another choice, by the key it was on (2 is the first of the others).
    Other(usize),
    /// The start was undone.
    Undone,
    /// The task was placed by hand afterwards.
    Hand,
}

impl Did {
    fn line(self, id: &str) -> Value {
        let (did, choice) = match self {
            Did::Stood => ("stood", None),
            Did::Other(key) => ("other", Some(key)),
            Did::Undone => ("undone", None),
            Did::Hand => ("hand", None),
        };
        json!({ "k": "did", "id": id, "did": did, "choice": choice })
    }
}

/// How many lines the file has, once counted: it is rewritten with only the
/// newest entries when it has grown to twice what is kept.
#[derive(Default)]
pub struct Record {
    lines: Option<usize>,
}

impl Record {
    /// An entry: a model placed the task `id`. `entry` holds the fields the
    /// record keeps (`at`, `placer`, `model`, `words`, `candidates`,
    /// `answer`, `previews`).
    pub fn placed(&mut self, data: &Path, id: &str, mut entry: Value) {
        entry["k"] = "placed".into();
        entry["id"] = id.into();
        self.append(data, &entry);
    }

    /// What the person did with the decision about the task `id`.
    pub fn did(&mut self, data: &Path, id: &str, did: Did) {
        self.append(data, &did.line(id));
    }

    /// Empties the record.
    pub fn clear(&mut self, data: &Path) {
        let _ = std::fs::remove_file(file(data));
        self.lines = Some(0);
    }

    fn append(&mut self, data: &Path, line: &Value) {
        let path = file(data);
        let mut open = std::fs::OpenOptions::new();
        open.create(true).append(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
        let Ok(mut f) = open.open(&path) else { return };
        let lines = self.lines.unwrap_or_else(|| lines_of(&path));
        if writeln!(f, "{line}").is_err() {
            return;
        }
        self.lines = Some(lines + 1);
        if lines + 1 > 2 * KEPT {
            drop(f);
            self.trim(&path);
        }
    }

    /// Rewrites the file with the newest [`KEPT`] entries, what was done
    /// with each folded in.
    fn trim(&mut self, path: &Path) {
        let text = std::fs::read_to_string(path).unwrap_or_default();
        let entries = fold(&text);
        let mut out = String::new();
        for entry in &entries {
            out.push_str(&entry.to_string());
            out.push('\n');
        }
        let next = path.with_extension("tmp");
        if std::fs::write(&next, out).is_ok() && std::fs::rename(&next, path).is_ok() {
            self.lines = Some(entries.len());
        }
    }
}

fn lines_of(path: &Path) -> usize {
    std::fs::read_to_string(path).map_or(0, |t| t.lines().count())
}

/// The entries of a record's text, oldest first and at most [`KEPT`], each
/// with what the person did (`did`, and `choice` for another choice): the
/// last of what was done, except that letting the decision stand is only
/// what is said when nothing else was.
fn fold(text: &str) -> Vec<Value> {
    let mut entries: Vec<Value> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for line in text.lines() {
        // A line cut short by a crash is no entry.
        let Ok(mut line) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let id = line["id"].as_str().unwrap_or_default().to_owned();
        match line["k"].as_str() {
            Some("placed") => {
                // A rewritten file holds what was done already.
                if line.get("did").is_none() {
                    line["did"] = Value::Null;
                }
                at.insert(id, entries.len());
                entries.push(line);
            }
            Some("did") => {
                let Some(&i) = at.get(&id) else { continue };
                let entry = &mut entries[i];
                if line["did"] == "stood" && !entry["did"].is_null() {
                    continue;
                }
                entry["did"] = line["did"].clone();
                entry["choice"] = line["choice"].clone();
            }
            _ => {}
        }
    }
    let over = entries.len().saturating_sub(KEPT);
    entries.drain(..over);
    entries
}

/// `placings.count`: how many entries the record holds.
pub fn count(cx: &mut Cx, _: Empty) -> Result<u32, Error> {
    Ok(u32::try_from(read(cx.core.terminals.data()).len()).unwrap_or(u32::MAX))
}

/// `placings.clear`: empties the record.
pub fn clear(cx: &mut Cx, _: Empty) -> Result<(), Error> {
    let data = cx.core.terminals.data().to_owned();
    cx.core.seams.record.clear(&data);
    Ok(())
}

/// The entries of the record in a data folder, oldest first.
pub fn read(data: &Path) -> Vec<Value> {
    fold(&std::fs::read_to_string(file(data)).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_keeps_the_newest_five_thousand_entries_and_folds_what_was_done() {
        let data = std::env::temp_dir().join(format!("tasktap-placings-{}", std::process::id()));
        std::fs::create_dir_all(&data).unwrap();
        let mut record = Record::default();
        for n in 0..(2 * KEPT + 100) {
            record.placed(&data, &n.to_string(), json!({ "words": "x" }));
            record.did(&data, &n.to_string(), Did::Other(2));
        }
        let all = read(&data);
        assert_eq!(all.len(), KEPT);
        assert_eq!(all[0]["id"], (2 * KEPT + 100 - KEPT).to_string());
        assert_eq!(all[KEPT - 1]["id"], (2 * KEPT + 99).to_string());
        assert_eq!(
            (&all[0]["did"], &all[0]["choice"]),
            (&json!("other"), &json!(2))
        );
        // The file itself was rewritten to what is kept, not left to grow.
        assert!(lines_of(&file(&data)) <= 2 * KEPT + 1);
        record.did(&data, &(2 * KEPT + 99).to_string(), Did::Stood);
        assert_eq!(read(&data)[KEPT - 1]["did"], "other");
        record.clear(&data);
        assert!(read(&data).is_empty());
        let _ = std::fs::remove_dir_all(&data);
    }
}
