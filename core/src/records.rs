//! Records (design §1): `sub`, `put`, `delete`, `history`, the collections
//! kept in memory, and the fan-out of every committed change.
//!
//! Nothing can fall between a snapshot and the first change because both
//! happen on the core's one thread: `sub` reads the snapshot at revision R,
//! queues it with its reply and marks the connection subscribed in one
//! step, and every commit is published in the step that made it. A change
//! is therefore either in the snapshot (at or below R) or sent after it.

use crate::calls::Cx;
use crate::conn::Link;
use crate::serve::Core;
use crate::store::{self, Tx};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io;
use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};
use tasktap_proto::call::{self, Call, Code, Error};
use tasktap_proto::{
    Change, Collection, Control, Delete, Glance, History, HistoryPage, Layout, LayoutPatch, Mode,
    NotePatch, PrefValue, ProjectPatch, Put, PutTarget, Rev, Revision, Rows, SessionId, Set,
    Subscribe, Thought, ThoughtId, Time, encode_control,
};

/// Most bytes of JSON in one snapshot chunk (design §1).
pub const CHUNK: usize = 256 << 10;
/// Room a chunk keeps for its envelope, and each set in it for `{"c":…,"put":[]}`.
const ENVELOPE: usize = 64;
const SET: usize = 32;
/// Most bytes a row written by `put` may take, so that it fits one chunk
/// and its change fits one frame.
pub const MAX_ROW: usize = CHUNK - ENVELOPE - SET;
/// Activity lines a session keeps, and characters of each (design §5).
const ACTIVITY: usize = 40;
const ACTIVITY_LINE: usize = 200;

/// The collections a connection subscribed to, one bit each.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Subs(u32);

impl Subs {
    fn with(self, c: Collection) -> Subs {
        Subs(self.0 | (1 << c as u32))
    }

    fn has(self, c: Collection) -> bool {
        self.0 & (1 << c as u32) != 0
    }

    fn and(self, other: Subs) -> Subs {
        Subs(self.0 & other.0)
    }

    fn is_empty(self) -> bool {
        self.0 == 0
    }
}

fn collection(set: &Set) -> Collection {
    match set {
        Set::Thoughts(_) => Collection::Thoughts,
        Set::Projects(_) => Collection::Projects,
        Set::Sessions(_) => Collection::Sessions,
        Set::Terminals(_) => Collection::Terminals,
        Set::Questions(_) => Collection::Questions,
        Set::Results(_) => Collection::Results,
        Set::Layouts(_) => Collection::Layouts,
        Set::Prefs(_) => Collection::Prefs,
        Set::Devices(_) => Collection::Devices,
        Set::Glance { .. } => Collection::Glance,
    }
}

/// The collections that are not stored (Phase 1: `glance`), and the fields
/// of stored rows that are not (a session's `activity`). Their changes take
/// revisions from the store's counter, so they order with stored ones; they
/// start over at every run of the core.
pub struct Memory {
    glance: Glance,
    activity: HashMap<SessionId, Vec<String>>,
}

impl Default for Memory {
    fn default() -> Self {
        Memory {
            glance: Glance {
                rev: Rev::ZERO,
                working: 0,
                needs_you: 0,
                done: 0,
                question: None,
                retiring: false,
            },
            activity: HashMap::new(),
        }
    }
}

impl Memory {
    /// Fills in the memory-only fields of the rows about to be sent, and
    /// forgets those of sessions that left the live set.
    pub fn overlay(&mut self, sets: &mut [Set]) {
        for set in sets {
            if let Set::Sessions(rows) = set {
                for s in &mut rows.put {
                    s.activity = self.activity.get(&s.id).cloned().unwrap_or_default();
                }
                for id in &rows.del {
                    self.activity.remove(id);
                }
            }
        }
    }

    fn rows(&self, c: Collection) -> Option<Set> {
        match c {
            Collection::Glance => Some(Set::Glance {
                put: vec![self.glance.clone()],
            }),
            _ => None,
        }
    }
}

impl Core {
    pub fn glance(&self) -> &Glance {
        &self.memory.glance
    }

    /// Adds a line to a session's memory-only activity, and sends the
    /// session with it in a change at the next revision. The row keeps the
    /// revision of its last stored write, which is what `rev` names.
    pub fn add_activity(&mut self, session: SessionId, text: String) -> store::Result<()> {
        let lines = self.memory.activity.entry(session).or_default();
        if lines.len() == ACTIVITY {
            lines.remove(0);
        }
        lines.push(text.chars().take(ACTIVITY_LINE).collect());
        let tx = self.store.begin()?;
        let Some(row) = tx.session(session)? else {
            return Ok(());
        };
        drop(tx);
        let rev = self.store.take_rev()?;
        let put = vec![row];
        let sets = vec![Set::Sessions(Rows {
            put,
            del: Vec::new(),
        })];
        self.publish(Some(Change {
            rev,
            snap: false,
            sets,
        }));
        Ok(())
    }

    /// Replaces the `glance` row; its `rev` is stamped here. Subscribers get
    /// it as a change at the next revision, like a stored row. An unchanged
    /// value takes no revision and sends nothing.
    pub fn set_glance(&mut self, glance: Glance) -> store::Result<()> {
        let glance = Glance {
            rev: self.memory.glance.rev,
            ..glance
        };
        if glance == self.memory.glance {
            return Ok(());
        }
        let rev = self.store.take_rev()?;
        self.memory.glance = Glance { rev, ..glance };
        let put = vec![self.memory.glance.clone()];
        let sets = vec![Set::Glance { put }];
        self.publish(Some(Change {
            rev,
            snap: false,
            sets,
        }));
        Ok(())
    }
}

/// Sends a committed change to every connection subscribed to a collection
/// it touches, cut to those collections. Each distinct cut is encoded once,
/// in chunks when it is over the frame limit.
/// A connection over its bound is dropped by its link: nothing here waits.
pub fn publish(links: &[Rc<Link>], change: Change) {
    let touched = change
        .sets
        .iter()
        .fold(Subs::default(), |s, set| s.with(collection(set)));
    let mut cuts: Vec<Subs> = Vec::new();
    for link in links {
        let cut = link.subs.get().and(touched);
        if !cut.is_empty() && !cuts.contains(&cut) {
            cuts.push(cut);
        }
    }
    let mut frames: Vec<(Subs, Option<Vec<Vec<u8>>>)> = cuts
        .iter()
        .filter(|&&cut| cut != touched)
        .map(|&cut| {
            let sets = change.sets.iter().filter(|s| cut.has(collection(s)));
            let rev = change.rev;
            let sets = sets.cloned().collect();
            (
                cut,
                encode(Change {
                    rev,
                    snap: false,
                    sets,
                }),
            )
        })
        .collect();
    // The whole change, the usual case, is encoded without a copy.
    if cuts.contains(&touched) {
        frames.push((touched, encode(change)));
    }
    for link in links {
        let cut = link.subs.get().and(touched);
        match frames.iter().find(|(c, _)| *c == cut) {
            Some((_, Some(frames))) => frames.iter().for_each(|frame| link.push(frame)),
            // A row over the frame limit: no peer could read it.
            Some((_, None)) => link.close(false),
            None => {}
        }
    }
}

/// A change as frames: one when it fits, the usual case; otherwise cut into
/// chunks at its revision as a snapshot is. `None` when one row is over the
/// frame limit.
fn encode(change: Change) -> Option<Vec<Vec<u8>>> {
    let frame = |control: &Control| {
        let mut out = Vec::new();
        encode_control(control, &mut out).ok().map(|()| out)
    };
    let control = Control::Change(change);
    if let Some(one) = frame(&control) {
        return Some(vec![one]);
    }
    let Control::Change(Change { rev, sets, .. }) = control else {
        return None;
    };
    let chunks = chunks(rev, false, sets).into_iter();
    chunks.map(|c| frame(&Control::Change(c))).collect()
}

/// `sub`: replaces the connection's subscription; an empty list ends it.
pub fn sub(cx: &mut Cx, args: Subscribe) -> Result<Revision, Error> {
    let core = &mut *cx.core;
    let rev = core.store.rev();
    let mut subs = Subs::default();
    let mut sets = Vec::new();
    let tx = core.store.begin().map_err(fail)?;
    for c in args.collections {
        if subs.has(c) {
            continue;
        }
        subs = subs.with(c);
        if let Some(set) = tx.live(c).map_err(fail)?.or_else(|| core.memory.rows(c)) {
            sets.push(set);
        }
    }
    drop(tx);
    core.memory.overlay(&mut sets);
    cx.link.subs.set(subs);
    if !subs.is_empty() {
        for change in chunks(rev, true, sets) {
            cx.link.send(&Control::Change(change));
        }
    }
    Ok(Revision { rev })
}

/// Cuts sets into changes at revision `rev` of at most [`CHUNK`] bytes of
/// JSON each, in order: each set's rows, then its deletions. A row is never
/// split; one larger than a chunk goes alone. There is always one change, so
/// a client sees even an empty snapshot begin.
fn chunks(rev: Rev, snap: bool, sets: Vec<Set>) -> Vec<Change> {
    let mut chunk = Chunk {
        rev,
        snap,
        sets: Vec::new(),
        size: ENVELOPE,
        done: Vec::new(),
    };
    macro_rules! split {
        ($set:expr, $($c:ident),*) => {
            match $set {
                $(Set::$c(rows) => {
                    chunk.rows(rows.put, |put| Set::$c(Rows { put, del: Vec::new() }));
                    chunk.rows(rows.del, |del| Set::$c(Rows { put: Vec::new(), del }));
                })*
                Set::Glance { put } => chunk.rows(put, |put| Set::Glance { put }),
            }
        };
    }
    for set in sets {
        split!(
            set, Thoughts, Projects, Sessions, Terminals, Questions, Results, Layouts, Prefs,
            Devices
        );
    }
    if !chunk.sets.is_empty() || chunk.done.is_empty() {
        chunk.cut();
    }
    chunk.done
}

struct Chunk {
    rev: Rev,
    snap: bool,
    sets: Vec<Set>,
    /// Bytes of JSON in this chunk so far, counting the rows not yet in `sets`.
    size: usize,
    done: Vec<Change>,
}

impl Chunk {
    fn rows<R: Serialize>(&mut self, rows: Vec<R>, wrap: fn(Vec<R>) -> Set) {
        let mut part = Vec::new();
        for row in rows {
            let len = measure(&row) + 1;
            if self.size + len + SET > CHUNK && self.size > ENVELOPE {
                if !part.is_empty() {
                    self.sets.push(wrap(std::mem::take(&mut part)));
                }
                self.cut();
            }
            self.size += len + if part.is_empty() { SET } else { 0 };
            part.push(row);
        }
        if !part.is_empty() {
            self.sets.push(wrap(part));
        }
    }

    fn cut(&mut self) {
        let sets = std::mem::take(&mut self.sets);
        let (rev, snap) = (self.rev, self.snap);
        self.done.push(Change { rev, snap, sets });
        self.size = ENVELOPE;
    }
}

/// `put`: writes plain data and names the revision of the change.
pub fn put(cx: &mut Cx, args: Value) -> Result<Revision, Error> {
    plain(&args)?;
    let Put { target, if_rev } = call::Put::args(args)?;
    // A row that does not exist yet is at revision 0.
    let check = |rev: Option<Rev>| match if_rev {
        Some(want) if want != rev.unwrap_or(Rev::ZERO) => Err(Error::new(
            Code::Conflict,
            format!("the row is at revision {}", rev.unwrap_or(Rev::ZERO).get()),
        )),
        _ => Ok(()),
    };
    let core = &mut *cx.core;
    let mut tx = core.store.begin().map_err(fail)?;
    match target {
        PutTarget::Prefs(patch) => {
            let value = PrefValue::from(patch);
            check(tx.pref(value.key()).map_err(fail)?.map(|p| p.rev))?;
            tx.put_pref(&value)
        }
        PutTarget::Layouts { id, patch } => {
            check(tx.layout(id).map_err(fail)?.map(|l| l.rev))?;
            let tree = patch.tree;
            let layout = Layout {
                id,
                rev: Rev::ZERO,
                tree,
            };
            fits(&layout)?;
            tx.put_layout(&layout)
        }
        PutTarget::Projects { id, patch } => {
            let mut p = tx.project(id).map_err(fail)?.ok_or_else(|| gone(id))?;
            check(Some(p.rev))?;
            let ProjectPatch {
                name,
                color,
                aliases,
                isolate,
            } = patch;
            p.name = name.unwrap_or(p.name);
            p.color = color.unwrap_or(p.color);
            p.aliases = aliases.unwrap_or(p.aliases);
            p.isolate = isolate.unwrap_or(p.isolate);
            fits(&p)?;
            tx.update_project(&p)
        }
        PutTarget::Thoughts { id, patch } => {
            let mut t = note(&tx, id)?;
            check(Some(t.rev))?;
            let NotePatch { text, strokes } = patch;
            t.text = text.unwrap_or(t.text);
            t.strokes = strokes.unwrap_or(t.strokes);
            t.updated = now();
            fits(&t)?;
            tx.update_thought(&t)
        }
    }
    .map_err(fail)?;
    let change = tx.commit().map_err(fail)?;
    Ok(published(core, change))
}

/// Refuses a patch that names a field the collection cannot be put. Serde
/// would skip it silently, and the caller would believe it wrote a field
/// the state machine owns.
fn plain(args: &Value) -> Result<(), Error> {
    let Some(patch) = args.get("patch").and_then(Value::as_object) else {
        return Ok(());
    };
    let c = args.get("c").and_then(Value::as_str).unwrap_or_default();
    let editable = match c {
        "projects" => serde_json::to_value(ProjectPatch::default()),
        "thoughts" => serde_json::to_value(NotePatch::default()),
        "layouts" => serde_json::to_value(LayoutPatch { tree: Value::Null }),
        _ => return Ok(()),
    }
    .unwrap_or_default();
    match patch
        .keys()
        .find(|field| editable.get(field.as_str()).is_none())
    {
        Some(field) => Err(invalid(format!(
            "{field} is not plain data; {c} may put {}",
            editable.as_object().map_or(String::new(), |e| {
                e.keys().map(String::as_str).collect::<Vec<_>>().join(", ")
            })
        ))),
        None => Ok(()),
    }
}

/// `delete`: removes plain data. A preference or layout that is not stored
/// is already at its default, so deleting it again changes nothing.
pub fn delete(cx: &mut Cx, args: Delete) -> Result<Revision, Error> {
    let core = &mut *cx.core;
    let mut tx = core.store.begin().map_err(fail)?;
    match args {
        Delete::Prefs { id } => tx.delete_pref(id),
        Delete::Layouts { id } => tx.delete_layout(id),
        Delete::Thoughts { id } => {
            note(&tx, id)?;
            match tx.delete_thought(id) {
                Err(store::Error::Reference) => {
                    let why = "a session works on this note";
                    return Err(Error::new(Code::Conflict, why));
                }
                deleted => deleted,
            }
        }
    }
    .map_err(fail)?;
    let change = tx.commit().map_err(fail)?;
    Ok(published(core, change))
}

/// `history`: finished thoughts that left the live set, newest first, with
/// their questions and results. The page is cut to the newest thoughts
/// whose rows fit one chunk, at least one, so the reply stays far below the
/// frame limit however long the texts are: a short page is not the end,
/// an empty one is.
pub fn history(cx: &mut Cx, args: History) -> Result<HistoryPage, Error> {
    let tx = cx.core.store.begin().map_err(fail)?;
    let mut page = tx.history(args.before, args.limit).map_err(fail)?;
    let (mut size, mut keep) = (0, 0);
    for t in &page.thoughts {
        let questions = page.questions.iter().filter(|q| q.thought_id == Some(t.id));
        let results = page.results.iter().filter(|r| r.thought_id == t.id);
        let len = measure(t)
            + questions.map(measure).sum::<usize>()
            + results.map(measure).sum::<usize>();
        if keep > 0 && size + len > CHUNK {
            break;
        }
        (size, keep) = (size + len, keep + 1);
    }
    if keep < page.thoughts.len() {
        page.thoughts.truncate(keep);
        let kept = |id: ThoughtId| page.thoughts.iter().any(|t| t.id == id);
        page.questions.retain(|q| q.thought_id.is_some_and(kept));
        page.results.retain(|r| kept(r.thought_id));
    }
    Ok(page)
}

/// A thought `put` and `delete` may touch: a note. Every other thought
/// belongs to the state machine.
fn note(tx: &Tx, id: ThoughtId) -> Result<Thought, Error> {
    let t = tx.thought(id).map_err(fail)?.ok_or_else(|| gone(id))?;
    if t.mode != Mode::Note {
        return Err(invalid("only a note is plain data".into()));
    }
    Ok(t)
}

/// Publishes a write's change and names its revision. A write that changed
/// nothing names the current one, which already holds what was asked.
fn published(core: &mut Core, change: Option<Change>) -> Revision {
    let rev = change.as_ref().map_or_else(|| core.store.rev(), |c| c.rev);
    core.publish(change);
    Revision { rev }
}

fn fits(row: &impl Serialize) -> Result<(), Error> {
    match measure(row) {
        len if len > MAX_ROW => Err(invalid(format!(
            "the row would take {len} bytes; a row is at most {MAX_ROW}"
        ))),
        _ => Ok(()),
    }
}

/// The length of a value's JSON, without keeping the JSON.
fn measure(value: &impl Serialize) -> usize {
    struct Count(usize);
    impl io::Write for Count {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count(0);
    // Protocol types always serialize; see `call::to_value`.
    let _ = serde_json::to_writer(&mut count, value);
    count.0
}

fn fail(e: store::Error) -> Error {
    let code = match e {
        // The row named, or the project a layout belongs to, is not there.
        store::Error::NotFound | store::Error::Reference => Code::Gone,
        _ => Code::Failed,
    };
    Error::new(code, e.to_string())
}

fn gone(id: impl Serialize) -> Error {
    let id = serde_json::to_value(id).unwrap_or_default();
    Error::new(Code::Gone, format!("no row {id}"))
}

fn invalid(message: String) -> Error {
    Error::new(Code::Invalid, message)
}

fn now() -> Time {
    let since = SystemTime::now().duration_since(UNIX_EPOCH);
    Time::new(since.map_or(0, |d| d.as_millis() as u64)).unwrap_or(Time::ZERO)
}

/// The name of the test-only call that writes rows the state machine would
/// otherwise write, so records can be proven before it exists (design §13).
#[cfg(feature = "fixtures")]
pub const FIXTURE: &str = "fixture.records";

/// `fixture.records {sets}`: inserts or replaces the thoughts and projects
/// given and inserts the results, in one transaction, then sets the glance
/// row if one is given. Replies like `put`.
#[cfg(feature = "fixtures")]
pub fn fixture(core: &mut Core, id: tasktap_proto::CallId, args: Value) -> Control {
    #[derive(serde::Deserialize)]
    struct Args {
        sets: Vec<Set>,
    }
    let write = |core: &mut Core| -> Result<Revision, Error> {
        let Args { sets } = serde_json::from_value(args).map_err(|e| invalid(e.to_string()))?;
        let mut tx = core.store.begin().map_err(fail)?;
        let mut glance = None;
        for set in sets {
            match set {
                Set::Thoughts(rows) => {
                    for t in rows.put {
                        match tx.thought(t.id).map_err(fail)? {
                            Some(_) => tx.update_thought(&t),
                            None => tx.insert_thought(&t),
                        }
                        .map_err(fail)?;
                    }
                }
                Set::Projects(rows) => {
                    for p in rows.put {
                        match tx.project(p.id).map_err(fail)? {
                            Some(_) => tx.update_project(&p),
                            None => tx.insert_project(&p),
                        }
                        .map_err(fail)?;
                    }
                }
                Set::Results(rows) => {
                    for r in rows.put {
                        tx.insert_result(&r, "").map_err(fail)?;
                    }
                }
                Set::Glance { put } => glance = put.into_iter().last(),
                _ => return Err(invalid("not a fixture collection".into())),
            }
        }
        let change = tx.commit().map_err(fail)?;
        core.publish(change);
        if let Some(glance) = glance {
            core.set_glance(glance).map_err(fail)?;
        }
        Ok(Revision {
            rev: core.store.rev(),
        })
    };
    call::Put::reply(id, write(core))
}
