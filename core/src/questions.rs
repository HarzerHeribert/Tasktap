//! Questions (design §6): asked by an agent, answered by a device, handed to
//! the waiting asker and acknowledged by it, and the `glance` row a host
//! shows them with.
//!
//! An agent names its question by its own key, which the core keeps per
//! session, so a token can never reach another session's question: `ask
//! <session> <request>` for `question.ask`. A question the agent asked in
//! its terminal comes as a `session.event`, which the state machine keys
//! `hook <session> <turn> <request>` after the guards every event passes.
//! A `question.ask` call is its question's waiter: the reply is the answer.
//! A waiter whose connection ends withdraws its question at once; asking
//! again with the key while the turn is alive reopens it, or returns the
//! answer stored meanwhile. Every rule about which question may open,
//! reopen, be answered or close is the state machine's.

use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;

use serde_json::Value;
use tasktap_proto::call::{self, Call, Code, Error};
use tasktap_proto::{
    Action, AnswerQuestion, Ask, AskKey, CallId, Change, Collection, Control, Glance, Input,
    Question, QuestionId, QuestionSource, QuestionState as Q, Ref, ReplyVia, Response, Rev, Rows,
    Session, Set, Status, TerminalId, Thought, ThoughtId, When,
};

use crate::calls::{Caller, Cx};
use crate::conn::Link;
use crate::effects::{self, Refusal, refusal};
use crate::serve::Core;
use crate::state::{self, Event, Ignored};

/// The waiters, and what `glance` shows, kept from the rows each commit sends.
#[derive(Default)]
pub struct Questions {
    waits: Vec<Wait>,
    /// The thoughts `glance` counts, and how many there are of each kind.
    counted: HashMap<ThoughtId, Count>,
    counts: [u32; 4],
    /// Each open question with the revision it opened at: `glance` shows the
    /// oldest, whichever clock minted its id.
    open: BTreeMap<QuestionId, Rev>,
    /// Chosen with `question.focus`; while it is open it is the one affirm and deny act on.
    focus: Option<QuestionId>,
}

/// A pending `question.ask`.
struct Wait {
    question: QuestionId,
    link: Rc<Link>,
    call: CallId,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Count {
    Working,
    NeedsYou,
    /// Done and not read yet.
    Done,
    /// Failed and not read yet.
    Failed,
}

impl Questions {
    fn recount(&mut self, thought: &Thought) {
        let now = match thought.status {
            Status::Working => Some(Count::Working),
            Status::NeedsYou => Some(Count::NeedsYou),
            Status::Done if !thought.read => Some(Count::Done),
            Status::Failed if !thought.read => Some(Count::Failed),
            _ => None,
        };
        self.count(thought.id, now);
    }

    fn count(&mut self, thought: ThoughtId, now: Option<Count>) {
        let before = match now {
            Some(c) => self.counted.insert(thought, c),
            None => self.counted.remove(&thought),
        };
        if let Some(c) = before {
            self.counts[c as usize] -= 1;
        }
        if let Some(c) = now {
            self.counts[c as usize] += 1;
        }
    }
}

/// `question.ask`: waits, and the reply is the answer.
pub fn ask(cx: &mut Cx, args: Value) -> Option<Control> {
    let id = cx.id;
    let asked = call::QuestionAsk::args(args).and_then(|ask| {
        let session = session(cx.core, token(cx.who)?)?;
        let q = open(cx.core, &session, ask);
        q.map_err(|r| refuse("question.ask", r))
    });
    let reply = match asked {
        Ok(q) if q.state == Q::Open => {
            let link = cx.link.clone();
            cx.core.questions.waits.push(Wait {
                question: q.id,
                link,
                call: id,
            });
            return None;
        }
        Ok(q) => q.answer.ok_or_else(withdrawn),
        Err(e) => Err(e),
    };
    Some(call::QuestionAsk::reply(id, reply))
}

/// Opens the question an agent asks, or finds the one its key already
/// names, and returns it as it stands afterwards.
fn open(core: &mut Core, s: &Session, ask: Ask) -> Result<Question, Refusal> {
    let key = key(s, &ask.request);
    let tx = core.store.begin()?;
    let stored = tx.question_by_request(&key)?;
    drop(tx);
    let id = match stored {
        Some(q) => q.id,
        None => state::fresh(core.seams.now())?,
    };
    let question = Question {
        id,
        rev: Rev::ZERO,
        thought_id: s.thought_id,
        session_id: Some(s.id),
        turn: Some(s.turn),
        source: ask.source.unwrap_or(QuestionSource::Agent),
        kind: ask.kind,
        prompt: ask.prompt,
        detail: ask.detail,
        reply_via: ReplyVia::Core,
        state: Q::Open,
        answer: None,
    };
    match effects::run(core, Event::Ask { question, key }) {
        Ok(_) | Err(Refusal::State(state::Error::Ignored(Ignored::Repeat))) => {}
        Err(r) => return Err(r),
    }
    let tx = core.store.begin()?;
    Ok(tx.question(id)?.ok_or(state::Error::Gone)?)
}

/// `question.answer`, from a device.
pub fn answer(cx: &mut Cx, args: AnswerQuestion) -> Result<(), Error> {
    respond(cx, "question.answer", args.id, args.response)
}

/// `input`: affirm or deny, bound to the question the device showed.
pub fn input(cx: &mut Cx, args: Input) -> Result<(), Error> {
    let response = match args.action {
        Action::Affirm => Response::Affirm,
        Action::Deny => Response::Deny,
    };
    respond(cx, "input", args.question, response)
}

fn respond(cx: &mut Cx, name: &str, question: QuestionId, response: Response) -> Result<(), Error> {
    let by = match cx.who {
        Caller::Device(id) => Some(id),
        _ => None,
    };
    let event = Event::Answer {
        question,
        response,
        by,
    };
    match effects::run(cx.core, event) {
        Ok(_) => Ok(()),
        // Say how it was settled: the second of two devices answering learns it lost.
        Err(Refusal::State(state::Error::Gone)) => {
            let q = effects::read(cx.core, |tx| tx.question(question))?;
            let why = match q.map(|q| q.state) {
                Some(Q::Answered) => "the question was answered already",
                Some(Q::Withdrawn) => "the question was withdrawn",
                _ => "no such question",
            };
            Err(Error::new(Code::Gone, why))
        }
        Err(r) => refusal(name, r).map_or(Ok(()), Err),
    }
}

/// `question.withdraw`: the asker gives up on its question.
pub fn withdraw(cx: &mut Cx, args: AskKey) -> Result<(), Error> {
    let q = own(cx, &args)?;
    let event = Event::Withdraw { question: q.id };
    effects::call(cx.core, "question.withdraw", event)
}

/// `question.received`: the asker has the answer; the receipt says when.
pub fn received(cx: &mut Cx, args: AskKey) -> Result<(), Error> {
    let q = own(cx, &args)?;
    match (q.state, q.answer) {
        (Q::Answered, Some(answer)) if answer.delivered.is_some() => Ok(()),
        (Q::Answered, _) => {
            let now = cx.core.seams.now();
            effects::write(cx.core, |tx| {
                tx.set_delivered(q.id, now).map_err(effects::stored)
            })
        }
        (Q::Withdrawn, _) => Err(withdrawn()),
        (Q::Open, _) => Err(Error::new(Code::Conflict, "the question has no answer yet")),
    }
}

/// `question.focus`: the open question affirm and deny act on.
pub fn focus(cx: &mut Cx, args: Ref<QuestionId>) -> Result<(), Error> {
    let q = &mut cx.core.questions;
    if !q.open.contains_key(&args.id) {
        return Err(Error::new(Code::Gone, "the question is not open"));
    }
    q.focus = Some(args.id);
    refresh(cx.core);
    Ok(())
}

/// The session running in a token's terminal.
pub fn session(core: &mut Core, terminal: TerminalId) -> Result<Session, Error> {
    let session = effects::read(core, |tx| tx.terminal_session(terminal))?;
    session.ok_or_else(|| Error::new(Code::Gone, "no session runs in this terminal"))
}

/// The caller's own question with this key.
fn own(cx: &mut Cx, args: &AskKey) -> Result<Question, Error> {
    let s = session(cx.core, token(cx.who)?)?;
    let q = effects::read(cx.core, |tx| {
        tx.question_by_request(&key(&s, &args.request))
    })?;
    q.ok_or_else(|| Error::new(Code::Gone, "this session asked no question with that key"))
}

fn key(session: &Session, request: &str) -> String {
    state::ask_key(session.id, request)
}

fn token(who: Caller) -> Result<TerminalId, Error> {
    match who {
        Caller::Session(terminal) => Ok(terminal),
        _ => Err(Error::new(Code::Denied, "only a session token asks")),
    }
}

fn refuse(name: &str, r: Refusal) -> Error {
    // A repeat is never refused; every caller handles it first.
    refusal(name, r).unwrap_or_else(|| Error::new(Code::Conflict, format!("{name} repeated")))
}

fn withdrawn() -> Error {
    Error::new(Code::Gone, "the question was withdrawn")
}

/// Hands a stored answer to its waiters (the effect `Answer`).
/// The answer is stored first, so one that cannot be read back is not lost:
/// the waiter is told, and asking again with its key returns it.
pub fn deliver(core: &mut Core, question: QuestionId) {
    let reply = match effects::read(core, |tx| tx.question(question)) {
        Ok(Some(Question {
            answer: Some(answer),
            ..
        })) => Ok(answer),
        Ok(_) => return,
        Err(e) => Err(e),
    };
    core.questions.waits.retain(|w| {
        let waits = w.question != question;
        if !waits {
            w.link
                .send(&call::QuestionAsk::reply(w.call, reply.clone()));
        }
        waits
    });
}

/// Ends the wait of everyone waiting for a question that was withdrawn:
/// nothing waits forever (hazard 10).
pub fn release(core: &mut Core, withdrawn: &[QuestionId]) {
    core.questions.waits.retain(|w| {
        let waits = !withdrawn.contains(&w.question);
        if !waits {
            w.link
                .send(&call::QuestionAsk::reply(w.call, Err(self::withdrawn())));
        }
        waits
    });
}

/// A connection ended: each question only it was waiting for is withdrawn at once.
pub fn left(core: &mut Core, link: &Rc<Link>) {
    let mut mine = Vec::new();
    core.questions.waits.retain(|w| {
        let gone = Rc::ptr_eq(&w.link, link);
        if gone {
            mine.push(w.question);
        }
        !gone
    });
    for question in mine {
        if !core.questions.waits.iter().any(|w| w.question == question) {
            // An answered one stays answered: the answer waits for the asker to come back.
            let _ = effects::run(core, Event::Withdraw { question });
        }
    }
}

/// Takes in what a commit changed. Returns the questions it withdrew.
pub fn absorb(core: &mut Core, change: &Change) -> Vec<QuestionId> {
    let q = &mut core.questions;
    let mut withdrawn = Vec::new();
    for set in &change.sets {
        match set {
            Set::Thoughts(rows) => {
                for t in &rows.put {
                    q.recount(t);
                }
                for &id in &rows.del {
                    q.count(id, None);
                }
            }
            Set::Questions(rows) => {
                for row in &rows.put {
                    if row.state == Q::Open {
                        q.open.insert(row.id, row.rev);
                    } else {
                        q.open.remove(&row.id);
                    }
                    if row.state == Q::Withdrawn {
                        withdrawn.push(row.id);
                    }
                }
                for id in &rows.del {
                    q.open.remove(id);
                }
            }
            _ => {}
        }
    }
    withdrawn
}

/// Sets `glance` from the counts; an unchanged value sends nothing.
pub fn refresh(core: &mut Core) {
    let q = &mut core.questions;
    if q.focus.is_some_and(|f| !q.open.contains_key(&f)) {
        q.focus = None;
    }
    let [working, needs_you, done, failed] = q.counts;
    let glance = Glance {
        rev: Rev::ZERO,
        working,
        needs_you,
        done,
        failed,
        question: (q.focus).or_else(|| {
            q.open
                .iter()
                .min_by_key(|(_, rev)| **rev)
                .map(|(id, _)| *id)
        }),
        retiring: core.retire == Some(When::Idle),
    };
    // Memory only: a failure to take a revision leaves the old row.
    let _ = core.set_glance(glance);
}

/// Counts what is live once, at start; from then on every commit says what changed.
pub fn start(core: &mut Core) -> crate::store::Result<()> {
    let tx = core.store.begin()?;
    let thoughts = tx.live(Collection::Thoughts)?;
    let open = tx.open_questions()?;
    drop(tx);
    let mut sets: Vec<Set> = thoughts.into_iter().collect();
    sets.push(Set::Questions(Rows {
        put: open,
        del: Vec::new(),
    }));
    let rev = core.store.rev();
    absorb(
        core,
        &Change {
            rev,
            snap: true,
            more: false,
            sets,
        },
    );
    refresh(core);
    Ok(())
}
