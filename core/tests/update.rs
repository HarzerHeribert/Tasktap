//! The update from Tasktap 2.0.0: its data folder, as its own core left it,
//! opened by this core. `fixtures/v2.0.0/core.db` was made by the 2.0.0 core
//! through its test harness (two projects, a task done, one failed, one
//! whose changes were kept, one at work whose agent asks, one waiting on a
//! placing question, and the preferences a person sets), and the core was
//! then killed, as a crash or a power cut ends it (its write-ahead log then
//! folded into the file, which changes no row). `host.json` is the host's
//! file beside it, as 2.0.0 writes it.

mod common;

use common::*;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::Path;
use tasktap_proto::{
    Candidate, DeviceId, Identity, Outcome, Place, Placed, ProjectId, QuestionSource, Route,
    Status, ThoughtId,
};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/v2.0.0");
/// The schema 2.0.0 left.
const V2: usize = 4;

type Row = Map<String, Value>;
/// Every row of every table, by table and key, each column a value and the
/// document parsed.
type Rows = BTreeMap<String, BTreeMap<String, Row>>;

fn rows(db: &Path) -> Rows {
    let c = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut tables = c
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .unwrap();
    let tables: Vec<String> = (tables.query_map([], |r| r.get(0)).unwrap())
        .map(Result::unwrap)
        .collect();
    let mut all = Rows::new();
    for table in tables {
        let mut select = c.prepare(&format!("SELECT * FROM \"{table}\"")).unwrap();
        let names: Vec<String> = select.column_names().map(Into::into).collect();
        let mut found = select.query([]).unwrap();
        let mut rows = BTreeMap::new();
        while let Some(r) = found.next().unwrap() {
            let mut row = Row::new();
            for (i, name) in names.iter().enumerate() {
                let value = match r.get_ref(i).unwrap() {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => n.into(),
                    ValueRef::Real(f) => f.into(),
                    ValueRef::Text(t) if name == "data" => serde_json::from_slice(t).unwrap(),
                    ValueRef::Text(t) => String::from_utf8(t.to_vec()).unwrap().into(),
                    ValueRef::Blob(b) => b
                        .iter()
                        .map(|x| format!("{x:02x}"))
                        .collect::<String>()
                        .into(),
                };
                row.insert(name.clone(), value);
            }
            // By id where a table has one, else by its first two columns.
            let key = match row.get("id") {
                Some(id) => id.to_string(),
                None => format!("{}/{}", row[&names[0]], row[&names[1]]),
            };
            rows.insert(key, row);
        }
        all.insert(table, rows);
    }
    all
}

fn user_version(db: &Path) -> usize {
    let c = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let version: u32 = (c.pragma_query_value(None, "user_version", |r| r.get(0))).unwrap();
    version as usize
}

/// A start with no client, which idles out.
fn start_and_idle_out(data: &Path) {
    let mut core = Core::start_with(data, &["--idle-ms", "200"]);
    assert!(core.exited().success());
}

/// The backups of the database a migration made, by name.
fn backups(data: &Path) -> BTreeMap<String, Vec<u8>> {
    (std::fs::read_dir(data).unwrap())
        .map(|e| e.unwrap().path())
        .filter(|p| {
            let name = p.file_name().unwrap().to_string_lossy();
            name.starts_with("core.v") && name.ends_with(".db")
        })
        .map(|p| {
            (
                p.file_name().unwrap().to_string_lossy().into(),
                std::fs::read(p).unwrap(),
            )
        })
        .collect()
}

/// Whether `now` holds `was`: the same, or an object with every field of
/// it as it was, and perhaps fields added since.
fn holds(now: &Value, was: &Value) -> bool {
    match (now, was) {
        (Value::Object(now), Value::Object(was)) => {
            (was.iter()).all(|(k, v)| now.get(k).is_some_and(|n| holds(n, v)))
        }
        _ => now == was,
    }
}

/// Asserts that `after` holds every row of `before` as it was, but for the
/// columns and document fields in `changed`.
fn kept(table: &str, before: &Row, after: &Row, changed: &[&str]) {
    for (column, was) in before {
        if column == "data" {
            for (field, was) in was.as_object().unwrap() {
                if !changed.contains(&format!("data.{field}").as_str()) {
                    let now = &after["data"][field];
                    let id = &before["data"]["id"];
                    assert!(
                        holds(now, was),
                        "{table} {id}: data.{field} {now} was {was}"
                    );
                }
            }
        } else if !changed.contains(&column.as_str()) {
            assert_eq!(&after[column], was, "{table}: {column} of {before:?}");
        }
    }
}

/// What the first start may change, and changes, in a row the crash left:
/// what Tasktap 2.0.0's own start after a crash changes (`Tx::recover`). A
/// terminal that ran is lost, a session that had not ended ends, the task
/// at work fails as interrupted, its agent's open question is withdrawn.
fn recovered(table: &str, before: &Row, after: &Row) {
    let data = before.get("data").unwrap_or(&Value::Null);
    let (changed, now): (&[&str], &[(&str, Value)]) = match table {
        "meta" => {
            assert_eq!(after["boot"], before["boot"].as_i64().unwrap() + 1);
            (&["boot", "rev"], &[])
        }
        "terminals" if data["state"] == "running" => (
            &["rev", "boot", "state", "data.state"],
            &[("state", json!("lost"))],
        ),
        "sessions" if data["state"] != "ended" => (
            &["rev", "state", "data.state"],
            &[("state", json!("ended"))],
        ),
        "thoughts" if data["phase"] == "working" => (
            &[
                "rev",
                "phase",
                "data.phase",
                "data.status",
                "data.reason",
                "data.updated",
            ],
            &[
                ("phase", json!("failed")),
                ("status", json!("failed")),
                ("reason", json!("interrupted")),
            ],
        ),
        "questions" if data["state"] == "open" && !data["session_id"].is_null() => (
            &["rev", "state", "data.state"],
            &[("state", json!("withdrawn"))],
        ),
        _ => (&[], &[]),
    };
    kept(table, before, after, changed);
    for (field, value) in now {
        assert_eq!(&after["data"][field], value, "{table} {}", data["id"]);
    }
}

#[test]
fn a_person_who_updates_from_2_0_0_keeps_every_record_and_what_they_chose() {
    let data = Folder::new("upd");
    let db = data.0.join("core.db");
    std::fs::copy(Path::new(FIXTURE).join("core.db"), &db).unwrap();
    std::fs::copy(
        Path::new(FIXTURE).join("host.json"),
        data.0.join("host.json"),
    )
    .unwrap();
    let before = rows(&db);
    assert_eq!(user_version(&db), V2);
    let count = |table: &str| before[table].len();
    assert_eq!(
        ["projects", "thoughts", "sessions", "questions", "prefs"].map(count),
        [3, 5, 4, 2, 9],
        "the fixture as 2.0.0 left it"
    );

    // The first start migrates once, keeping the file as it was beside it.
    start_and_idle_out(&data.0);
    let migrations = tasktap_core::store::MIGRATIONS.len();
    assert_eq!(user_version(&db), migrations);
    let backup = data.0.join(format!("core.v{V2}.db"));
    assert_eq!(
        rows(&backup),
        before,
        "the backup is the database as it was"
    );
    assert_eq!(user_version(&backup), V2);
    let saved = backups(&data.0);
    assert_eq!(saved.len(), 1, "{:?}", saved.keys());

    // Every row is there as it was, but for what any start after a crash
    // changes; no table went, and the one new table is empty.
    let first = rows(&db);
    for (table, was) in &before {
        let now = &first[table];
        if table == "seen_events" {
            assert!(now.is_empty(), "the events of ended sessions go");
            continue;
        }
        assert_eq!(now.len(), was.len(), "{table}");
        for (key, row) in was {
            recovered(table, row, &now[key]);
        }
    }
    for (table, now) in &first {
        assert!(before.contains_key(table) || now.is_empty(), "{table}");
    }
    let status = |id: &str| first["thoughts"][&format!("\"{id}\"")]["data"]["status"].clone();
    let statuses: Vec<_> = (before["thoughts"].values())
        .map(|t| status(t["id"].as_str().unwrap()))
        .collect();
    assert_eq!(
        statuses,
        ["done", "failed", "done", "failed", "needs_you"].map(|s| json!(s)),
        "done, failed, kept, interrupted, and the one the placing question waits for"
    );

    // A second start changes nothing but the count of starts.
    start_and_idle_out(&data.0);
    let second = rows(&db);
    for (table, was) in &first {
        for (key, row) in was {
            let changed: &[&str] = if table == "meta" { &["boot"] } else { &[] };
            kept(table, row, &second[table][key], changed);
        }
        assert_eq!(second[table].len(), was.len(), "{table}");
    }
    assert_eq!(user_version(&db), migrations);
    assert_eq!(
        backups(&data.0),
        saved,
        "no second migration, no second backup"
    );

    // Every record reaches a page whole: each field 2.0.0 stored, as stored.
    let core = Core::start(&data.0);
    let device = (before["devices"].values().next().unwrap())["id"].clone();
    let device: DeviceId = serde_json::from_value(device).unwrap();
    let old = core
        .device_as(device, 1, None)
        .expect("a 2.0.0 device still gets in");
    assert_eq!(old.welcome.identity, Identity::Device);
    drop(old);
    let mut s = Scene::on(core, data);
    let m = &s.w.model;
    let seen = |table: &str| -> BTreeMap<String, Value> {
        let shown = match table {
            "projects" => serde_json::to_value(&m.projects),
            "thoughts" => serde_json::to_value(&m.thoughts),
            "sessions" => serde_json::to_value(&m.sessions),
            "terminals" => serde_json::to_value(&m.terminals),
            "questions" => serde_json::to_value(&m.questions),
            "results" => serde_json::to_value(&m.results),
            _ => unreachable!(),
        };
        let shown: Map<String, Value> = serde_json::from_value(shown.unwrap()).unwrap();
        shown
            .into_iter()
            .map(|(k, v)| (format!("\"{k}\""), v))
            .collect()
    };
    for table in [
        "projects",
        "thoughts",
        "sessions",
        "terminals",
        "questions",
        "results",
    ] {
        let shown = seen(table);
        for (key, row) in &first[table] {
            let record = shown
                .get(key)
                .unwrap_or_else(|| panic!("{table} {key} is shown"));
            for (field, stored) in row["data"].as_object().unwrap() {
                let shown = &record[field];
                assert!(
                    holds(shown, stored),
                    "{table} {key}: {field} {shown} stored {stored}"
                );
            }
        }
    }

    // What the person chose is what they have: each preference as stored.
    for row in before["prefs"].values() {
        let key: tasktap_proto::PrefKey = serde_json::from_value(row["id"].clone()).unwrap();
        let value = serde_json::to_value(&m.prefs[&key]).unwrap();
        assert_eq!(&value, &row["data"], "{key:?}");
    }

    // The agreement to place tasks was to 2.0.0's terms: it covers nothing
    // now, so no model is asked, and the page asks again ("Agree again" in
    // Setup's placing step, from Home's "Finish setup"). Placing goes on as
    // without one, each task saying why: one that names its project goes
    // there, one that names several is asked about (where the page offers
    // "Agree again" too), and one that names none is kept for later.
    let agreed = &before["prefs"]["\"route_by\""]["data"]["value"]["terms"];
    let terms = match s.w.raw("route.terms", json!({})) {
        Outcome::Ok(terms) => terms["terms"].clone(),
        other => panic!("{other:?}"),
    };
    assert_ne!(&terms, agreed, "these terms are other than the agreement's");
    assert_eq!(terms, json!(tasktap_core::route::TERMS));
    let again = |t: ThoughtId, s: &Scene| {
        let route = s.w.model.thought(t).route.clone().unwrap();
        let why = route.fallback.unwrap_or_default();
        assert!(why.starts_with("the agreement "), "{why}");
    };
    let project = |name: &str| -> ProjectId {
        let row = (first["projects"].values()).find(|p| p["data"]["name"] == name);
        serde_json::from_value(row.unwrap()["id"].clone()).unwrap()
    };
    let (harbor, tide) = (project("harbormaster"), project("tide-notes"));
    s.script(Route::Unknown, None);
    let later = s.capture("sort the buoy photos");
    s.w.sync();
    let t = s.w.model.thought(later);
    assert_eq!(
        (t.status, t.placed),
        (Status::Captured, Some(Placed::KeptName))
    );
    again(later, &s);
    let candidates = [(harbor, "harbormaster"), (tide, "tide-notes")]
        .map(|(to, label)| Candidate {
            label: label.into(),
            to: Place::Project(to),
            why: String::new(),
        })
        .to_vec();
    let both = Route::Ambiguous {
        prompt: "Which project?".into(),
        candidates,
    };
    s.script(both, None);
    let asked = s.capture("check the berths in harbormaster and tide-notes");
    s.w.until("it is asked about", |m| m.status(asked) == Status::NeedsYou);
    again(asked, &s);
    let q = (s.w.model.questions.values())
        .find(|q| q.thought_id == Some(asked))
        .unwrap();
    assert_eq!(q.source, QuestionSource::Router);
    let named = Route::Clear {
        to: Place::Project(tide),
        brief: "Add the spring tides".into(),
        said: None,
    };
    s.script(named, None);
    let placed = s.capture("tide-notes: add the spring tides");
    s.w.until("it is placed", |m| m.status(placed) == Status::Routed);
    assert_eq!(s.w.model.thought(placed).project_id, Some(tide));
    again(placed, &s);

    // The host's own file beside the database is left as it was.
    let host = std::fs::read(s.data.0.join("host.json")).unwrap();
    assert_eq!(
        host,
        std::fs::read(Path::new(FIXTURE).join("host.json")).unwrap()
    );
}
