//! Records (design §1): `sub`, `put`, `delete`, `history`, the collections
//! kept in memory, and the fan-out of every committed change.
//!
//! Nothing can fall between a snapshot and the first change because both
//! happen on the core's one thread: `sub` reads the snapshot at revision R,
//! queues it with its reply and marks the connection subscribed in one
//! step, and every commit is published in the step that made it. A change
//! is therefore either in the snapshot (at or below R) or sent after it.
//! The snapshot goes out as the connection drains, and what is queued for
//! the connection meanwhile waits behind it, in order (`Link::snapshot`).

use crate::calls::Cx;
use crate::conn::Link;
use crate::serve::Core;
use crate::store::{self, Tx};
use serde::Serialize;
use std::collections::HashMap;
use std::rc::Rc;
use tasktap_proto::call::{Code, Error};
use tasktap_proto::{
    AgentHealth, Change, Collection, Control, Delete, Glance, History, HistoryPage, Layout,
    NotePatch, PrefValue, ProjectPatch, Put, PutTarget, Rev, Revision, Rows, SessionId, Set,
    Subscribe, Thought, ThoughtId, encode_control, json_len,
};

/// Most bytes of JSON in one snapshot chunk (design §1).
pub const CHUNK: usize = 256 << 10;
/// Room a chunk keeps for its envelope, and each set in it for `{"c":…,"put":[]}`.
const ENVELOPE: usize = 64;
const SET: usize = 32;
/// Most bytes a row may take, so that it fits one chunk and its change one
/// frame. The store refuses a transaction that writes a larger one.
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
        Set::Agents(_) => Collection::Agents,
    }
}

/// The collections that are not stored (Phase 1: `glance`), and the fields
/// of stored rows that are not (a session's `activity`). Their changes take
/// revisions from the store's counter, so they order with stored ones; they
/// start over at every run of the core.
pub struct Memory {
    glance: Glance,
    /// Each agent as last detected, in the order the core lists its agents.
    agents: Vec<AgentHealth>,
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
                failed: 0,
                question: None,
                retiring: false,
            },
            agents: Vec::new(),
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
            Collection::Agents => Some(Set::Agents(Rows {
                put: self.agents.clone(),
                del: Vec::new(),
            })),
            _ => None,
        }
    }
}

impl Core {
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
            more: false,
            sets,
        }));
        Ok(())
    }

    /// Puts the agents just detected in the `agents` collection, each
    /// stamped with the change's revision and the time, and sends them as
    /// one change. Returns the rows as put.
    pub fn set_agents(&mut self, found: Vec<AgentHealth>) -> store::Result<Vec<AgentHealth>> {
        if found.is_empty() {
            return Ok(found);
        }
        let rev = self.store.take_rev()?;
        let checked = self.seams.now();
        let found: Vec<AgentHealth> = (found.into_iter())
            .map(|a| AgentHealth { rev, checked, ..a })
            .collect();
        let agents = &mut self.memory.agents;
        for a in &found {
            match agents.iter_mut().find(|row| row.id == a.id) {
                Some(row) => *row = a.clone(),
                None => agents.push(a.clone()),
            }
        }
        let order = |id: &str| crate::agents::all().iter().position(|a| a.id() == id);
        agents.sort_by_key(|a| order(&a.id));
        let sets = vec![Set::Agents(Rows {
            put: found.clone(),
            del: Vec::new(),
        })];
        self.publish(Some(Change {
            rev,
            snap: false,
            more: false,
            sets,
        }));
        Ok(found)
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
            more: false,
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
                    more: false,
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
        cx.link.snapshot(chunks(rev, true, sets));
    }
    Ok(Revision { rev })
}

/// Cuts sets into changes at revision `rev` of at most [`CHUNK`] bytes of
/// JSON each, in order: each set's rows, then its deletions, every change
/// but the last marked `more`. A row is never split; one larger than a
/// chunk goes alone. There is always one change, so a client sees even an
/// empty snapshot begin.
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
            Devices, Agents
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
            let len = json_len(&row) + 1;
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
        if let Some(last) = self.done.last_mut() {
            last.more = true;
        }
        let sets = std::mem::take(&mut self.sets);
        let (rev, snap) = (self.rev, self.snap);
        self.done.push(Change {
            rev,
            snap,
            more: false,
            sets,
        });
        self.size = ENVELOPE;
    }
}

/// `put`: writes plain data and names the revision of the change.
pub fn put(cx: &mut Cx, args: Put) -> Result<Revision, Error> {
    let Put { target, if_rev } = args;
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
            // A consent names what this core would really ask (design §8).
            if let PrefValue::RouteBy(Some(by)) = &value {
                crate::route::consented(by).map_err(|why| Error::new(Code::Invalid, why))?;
            }
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
            tx.update_project(&p)
        }
        PutTarget::Thoughts { id, patch } => {
            let mut t = plain(&tx, id)?;
            check(Some(t.rev))?;
            let NotePatch { text, strokes } = patch;
            // A brief was written from the words it had: other words have none yet.
            if text.as_ref().is_some_and(|text| *text != t.text) {
                (t.brief, t.route) = (None, None);
            }
            t.text = text.unwrap_or(t.text);
            t.strokes = strokes.unwrap_or(t.strokes);
            t.updated = core.seams.now();
            tx.update_thought(&t)
        }
    }
    .map_err(fail)?;
    let change = tx.commit().map_err(fail)?;
    Ok(published(core, change))
}

/// `delete`: removes plain data, and a terminal that is not running with
/// its history. A preference or layout that is not stored is already at its
/// default, so deleting it again changes nothing.
pub fn delete(cx: &mut Cx, args: Delete) -> Result<Revision, Error> {
    let core = &mut *cx.core;
    let mut tx = core.store.begin().map_err(fail)?;
    match args {
        Delete::Prefs { id } => tx.delete_pref(id),
        Delete::Layouts { id } => tx.delete_layout(id),
        Delete::Thoughts { id } => {
            plain(&tx, id)?;
            match tx.delete_thought(id) {
                Err(store::Error::Reference) => {
                    let why = "a session works on this thought";
                    return Err(Error::new(Code::Conflict, why));
                }
                deleted => deleted,
            }
        }
        Delete::Terminals { id } => {
            if core.terminals.running(id) {
                let why = "the terminal is running: stop it first";
                return Err(Error::new(Code::Conflict, why));
            }
            match tx.delete_terminal(id) {
                Err(store::Error::Reference) => {
                    let why = "a session refers to this terminal";
                    return Err(Error::new(Code::Conflict, why));
                }
                deleted => deleted,
            }
        }
    }
    .map_err(fail)?;
    let change = tx.commit().map_err(fail)?;
    if let Delete::Terminals { id } = args {
        crate::terminal::forget(core, id);
    }
    Ok(published(core, change))
}

/// `history`: finished thoughts that left the live set, newest first, with
/// their questions and results, in pages whose rows fit one chunk, so a
/// reply stays far below the frame limit however long the texts are and
/// however many questions a thought has.
pub fn history(cx: &mut Cx, args: History) -> Result<HistoryPage, Error> {
    let tx = cx.core.store.begin().map_err(fail)?;
    tx.history(args.before, args.after, args.limit, CHUNK)
        .map_err(fail)
}

/// A thought `put` and `delete` may touch: one the state machine says is
/// plain data, captured and never launched. Every other thought is its.
fn plain(tx: &Tx, id: ThoughtId) -> Result<Thought, Error> {
    let t = tx.thought(id).map_err(fail)?.ok_or_else(|| gone(id))?;
    if !crate::state::plain(tx, &t).map_err(fail)? {
        let why = "only a thought that is captured and never started is plain data";
        return Err(invalid(why.into()));
    }
    Ok(t)
}

/// Publishes a write's change and names its revision. A write that changed
/// nothing names the current one, which already holds what was asked.
fn published(core: &mut Core, change: Option<Change>) -> Revision {
    let rev = change.as_ref().map_or_else(|| core.store.rev(), |c| c.rev);
    crate::effects::published(core, change);
    Revision { rev }
}

fn fail(e: store::Error) -> Error {
    let code = match e {
        // The row named, or the project a layout belongs to, is not there.
        store::Error::NotFound | store::Error::Reference => Code::Gone,
        store::Error::TooLarge(_) => Code::Invalid,
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

/// `fixture.records`: rows only the state machine writes otherwise, written
/// and published as a `put`'s are, so `glance` follows them.
#[cfg(feature = "fixtures")]
pub fn fixture(cx: &mut Cx, args: tasktap_proto::FixtureRecords) -> Result<Revision, Error> {
    let core = &mut *cx.core;
    let mut tx = core.store.begin().map_err(fail)?;
    for set in args.sets {
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
            Set::Questions(rows) => {
                for q in rows.put {
                    let key = format!("fixture {}", q.id.uuid());
                    tx.insert_question(&q, &key).map_err(fail)?;
                    if let Some(answer) = &q.answer {
                        tx.insert_answer(q.id, answer).map_err(fail)?;
                    }
                }
            }
            Set::Results(rows) => {
                for r in rows.put {
                    tx.insert_result(&r, "").map_err(fail)?;
                }
            }
            _ => return Err(invalid("not a fixture collection".into())),
        }
    }
    let change = tx.commit().map_err(fail)?;
    Ok(published(core, change))
}
