//! The live target (design §8): while a task is written or spoken, where it
//! would go. Two answers. `route.guess` is the core's ranking alone, which
//! asks and sends no one. `route.preview` asks the model that places tasks,
//! with the words so far, as it asks about a task that was sent but makes no
//! task and starts nothing; its answer is kept, and when the person presses
//! Return on what they saw (`Capture::taken`), that answer places the task
//! with no second question.
//!
//! A preview is sent only where a task would be placed by ChatGPT or the
//! person's own model (an agent started for each preview would be too heavy),
//! with the agreement to these terms and the switch on, for a task not said
//! in Tasktap's window, and at most [`PREVIEWS`] times for one task. What it
//! sends is what a sent task sends, through the same filter for secrets. A
//! newer preview of a task drops the answer of an older.

use crate::calls::Cx;
use crate::effects;
use crate::route::{
    self, Asker, BUDGET, Direct, Request, accept, agreed, askable, narrow, on_pad, request,
};
use crate::state::{Destination, Route};
use std::time::{Duration, Instant};
use tasktap_proto::call::{self, Call, Error};
use tasktap_proto::{
    Control, Guess, Hint, PREVIEWS, Place, PrefKey, PrefValue, PreviewWords, Previewed, ThoughtId,
};

/// Tasks whose previews are remembered at once: the person writes one at a
/// time, and the oldest is forgotten first.
const TASKS: usize = 16;

/// What a model answered about the words of a task, and where that places it.
#[derive(Clone)]
pub struct Confirmed {
    pub text: String,
    pub answer: String,
    pub asker: &'static str,
    pub model: String,
    /// The places its first choice and the others it was torn between are.
    pub choices: Vec<Destination>,
    pub ms: u32,
}

#[derive(Clone, Default)]
struct Task {
    /// The number of the question whose answer counts; none after a task is sent.
    latest: u64,
    sent: usize,
    confirmed: Option<Confirmed>,
}

/// The previews of the tasks being written, by the id each will have.
#[derive(Default)]
pub struct Previews {
    next: u64,
    tasks: Vec<(ThoughtId, Task)>,
}

impl Previews {
    fn at(&mut self, id: ThoughtId) -> &mut Task {
        let at = match self.tasks.iter().position(|(t, _)| *t == id) {
            Some(at) => at,
            None => {
                if self.tasks.len() == TASKS {
                    self.tasks.remove(0);
                }
                self.tasks.push((id, Task::default()));
                self.tasks.len() - 1
            }
        };
        &mut self.tasks[at].1
    }

    fn get(&self, id: ThoughtId) -> Option<&Task> {
        self.tasks.iter().find(|(t, _)| *t == id).map(|(_, t)| t)
    }

    /// How many previews were sent for the task.
    pub fn sent(&self, id: ThoughtId) -> usize {
        self.get(id).map_or(0, |t| t.sent)
    }

    /// The answer to a preview of exactly these words.
    pub fn confirmed(&self, id: ThoughtId, text: &str) -> Option<Confirmed> {
        let c = self.get(id)?.confirmed.as_ref();
        c.filter(|c| c.text == text).cloned()
    }

    /// No answer to a preview still asked for the task counts any more.
    pub fn drop_pending(&mut self, id: ThoughtId) {
        if let Some((_, t)) = self.tasks.iter_mut().find(|(t, _)| *t == id) {
            t.latest = 0;
        }
    }

    /// The task is placed: what was kept of it goes.
    pub fn forget(&mut self, id: ThoughtId) {
        self.tasks.retain(|(t, _)| *t != id);
    }
}

/// Where a route puts the task, its first choice first: none for what is for
/// the person to say.
pub fn places(route: &Route) -> Vec<Destination> {
    match route {
        Route::Clear { to, .. } => vec![*to],
        Route::Torn { candidates, .. } => candidates.iter().map(|c| c.to).collect(),
        _ => Vec::new(),
    }
}

/// `route.guess`: where the words would go by the ranking alone.
pub fn guess(cx: &mut Cx, args: Hint) -> Result<Guess, Error> {
    let found = effects::read(cx.core, |tx| request(tx, &args.text, args.current))?;
    Ok(Guess {
        to: route::guess(found).map(Place::from),
    })
}

/// What a preview is asked with, once every rule lets it be sent.
struct Asking {
    asked: Request,
    asker: Asker,
    limit: Duration,
}

/// Whether a preview of these words may be sent at all, and with what.
fn allowed(core: &mut crate::serve::Core, args: &PreviewWords) -> Option<Asking> {
    let (found, by, direct, shown) = effects::read(core, |tx| {
        let by = match tx.pref(PrefKey::RouteBy)?.map(|p| p.value) {
            Some(PrefValue::RouteBy(by)) => by,
            _ => None,
        };
        let shown = tx.pref(PrefKey::ShowTarget)?.map(|p| p.value);
        let shown = !matches!(shown, Some(PrefValue::ShowTarget(false)));
        Ok((
            request(tx, &args.text, args.current)?,
            by,
            Direct::read(tx)?,
            shown,
        ))
    })
    .ok()?;
    // Said in Tasktap's window, the names decide: no model is asked.
    if !shown || args.current.is_some() || args.view.is_some() || found.text.trim().is_empty() {
        return None;
    }
    if on_pad(&found) || found.projects.is_empty() || askable(&found.text).is_err() {
        return None;
    }
    // The agreement is to these terms, and its first placer is one that makes
    // a direct call: ChatGPT or the own model.
    let asker = agreed(&by?, &direct).ok()?.into_iter().next()?;
    let limit = match &asker {
        Asker::ChatGpt(_) => crate::chatgpt::LIMIT,
        Asker::Own(own) if core.own.left_out(&own.address) => return None,
        Asker::Own(own) => core.own.limit(&own.address),
        Asker::Agent(..) => return None,
    };
    if core.seams.previews.sent(args.task) >= PREVIEWS as usize {
        return None;
    }
    let now = core.seams.now();
    let asked = effects::read(core, |tx| narrow(tx, found, now)).ok()?;
    Some(Asking {
        asked,
        asker,
        limit: limit.min(BUDGET),
    })
}

/// `route.preview`: asks the model about the words so far, off the core's
/// thread, and answers with where it puts the task, or with none where there
/// is nothing to show: no preview is sent, the model had no answer it could
/// use, or the words were asked about again meanwhile. Nothing is stored but
/// the answer, for the task's own placing.
pub fn preview(cx: &mut Cx, args: PreviewWords) -> Option<Control> {
    let (link, id) = (cx.link.clone(), cx.id);
    let reply = move |choices: Vec<Place>| {
        link.send(&call::RoutePreview::reply(id, Ok(Previewed { choices })));
    };
    let Some(Asking {
        mut asked,
        asker,
        limit,
    }) = allowed(cx.core, &args)
    else {
        return Some(call::RoutePreview::reply(
            id,
            Ok(Previewed {
                choices: Vec::new(),
            }),
        ));
    };
    let task = args.task;
    cx.core.seams.previews.next += 1;
    let number = cx.core.seams.previews.next;
    cx.core.seams.previews.at(task).latest = number;
    let folders: Vec<_> = (asked.projects.iter())
        .map(|p| (p.to, p.folder.clone()))
        .collect();
    crate::calls::aside(
        cx.core,
        move || route::tops(folders, effects::TOPS_WITHIN),
        move |core, tops| {
            asked.top = tops.unwrap_or_default();
            // Asked again, or the task sent, while the folders were read; or
            // the cap was reached by then.
            let t = core.seams.previews.at(task);
            if t.latest != number || t.sent >= PREVIEWS as usize {
                return reply(Vec::new());
            }
            t.sent += 1;
            let text = route::asked(&asked);
            let call = effects::direct(core, &asker, text, limit, None);
            let began = Instant::now();
            crate::calls::aside(core, call, move |core, answer| {
                core.events.notify_one();
                let latest = core.seams.previews.at(task).latest == number;
                let answer = answer.and_then(Result::ok).filter(|_| latest);
                let found = answer.as_deref().and_then(|a| accept(&asked, a).ok());
                let choices = found.as_ref().map(|(r, _)| places(r)).unwrap_or_default();
                if let (Some(answer), false) = (answer, choices.is_empty()) {
                    let ms = u32::try_from(began.elapsed().as_millis()).unwrap_or(u32::MAX);
                    core.seams.previews.at(task).confirmed = Some(Confirmed {
                        text: asked.text.clone(),
                        answer,
                        asker: asker.id(),
                        model: asker.model().into(),
                        choices: choices.clone(),
                        ms,
                    });
                }
                reply(choices.into_iter().map(Place::from).collect());
            });
        },
    );
    None
}
