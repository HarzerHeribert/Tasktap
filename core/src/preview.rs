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
//! in Tasktap's window, and under limits the core holds, whatever the page
//! does: at most [`PREVIEWS`] for one task, at most [`PER_MINUTE`] a minute
//! from one page, none for [`QUIET`] after one failed, and one in flight at a
//! time. A preview has a limit of its own and no effect on a placer's
//! standing (own.rs `preview`). A newer preview, and a task that is sent,
//! stop the one in flight and drop its answer. What it sends is what a sent
//! task sends, through the same filter for secrets, less a last word that is
//! still being written and looks like the start of a key.

use crate::agents::checks::Asked;
use crate::calls::Cx;
use crate::effects;
use crate::route::{
    self, Asker, BUDGET, Direct, Request, accept, agreed, askable, narrow, on_pad, request,
};
use crate::state::{Destination, Route};
use std::collections::VecDeque;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tasktap_proto::call::{self, Call, Error};
use tasktap_proto::{
    Control, Guess, Hint, PREVIEWS, Place, PrefKey, PrefValue, PreviewWords, Previewed, ThoughtId,
};

/// Tasks whose previews are remembered at once.
const TASKS: usize = 64;
/// Most previews one page sends in a minute, whatever the tasks.
const PER_MINUTE: usize = 8;
const MINUTE: Duration = Duration::from_secs(60);
/// How long no preview is sent after one failed: offline, refused, or the
/// placer at its limit.
const QUIET: Duration = Duration::from_secs(60);
/// The longest a preview waits for its answer.
const LIMIT: Duration = Duration::from_secs(6);

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
    sent: usize,
    confirmed: Option<Confirmed>,
}

/// The previews of the tasks being written, by the id each will have.
#[derive(Default)]
pub struct Previews {
    next: u64,
    /// The number of the one preview whose answer counts: a newer one, and a
    /// task that is sent, make an older not count.
    live: u64,
    /// What stops the preview in flight.
    inflight: Option<mpsc::Sender<Asked>>,
    tasks: Vec<(ThoughtId, Task)>,
    /// When each page sent its previews of the last minute.
    pages: Vec<(usize, VecDeque<Instant>)>,
    quiet: Option<Instant>,
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

    /// The preview in flight is stopped and no answer counts: a task is sent,
    /// or a newer preview is.
    pub fn drop_pending(&mut self) {
        self.live = 0;
        if let Some(stop) = self.inflight.take() {
            let _ = stop.send(Asked::Stop);
        }
    }

    /// The task is placed: what was kept of it goes.
    pub fn forget(&mut self, id: ThoughtId) {
        self.tasks.retain(|(t, _)| *t != id);
    }

    /// What the page sent in the last minute.
    fn lately(&mut self, page: usize) -> &mut VecDeque<Instant> {
        let at = match self.pages.iter().position(|(p, _)| *p == page) {
            Some(at) => at,
            None => {
                self.pages.push((page, VecDeque::new()));
                self.pages.len() - 1
            }
        };
        let times = &mut self.pages[at].1;
        while times.front().is_some_and(|t| t.elapsed() > MINUTE) {
            times.pop_front();
        }
        times
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

/// `route.guess`: where the words would go by the ranking alone. Said in
/// Tasktap's window (a session or a workspace in view) the names decide, and
/// nothing is guessed.
pub fn guess(cx: &mut Cx, args: Hint) -> Result<Guess, Error> {
    if args.current.is_some() || args.view.is_some() {
        return Ok(Guess { to: None });
    }
    let found = effects::read(cx.core, |tx| request(tx, &args.text, args.current))?;
    Ok(Guess {
        to: route::guess(found).map(Place::from),
    })
}

/// Whether a word looks like a key, a token or a password, or the start of
/// one: one of the openings keys are known by, or 12 characters or more with
/// both a letter and a digit and neither a slash nor a dot (so a path, a
/// version or a name is not taken for one).
fn looks_like_key(word: &str) -> bool {
    const OPENINGS: [&str; 6] = ["sk-", "ghp_", "gho_", "xox", "AKIA", "eyJ"];
    OPENINGS.iter().any(|o| word.starts_with(o))
        || (word.chars().count() >= 12
            && word.chars().any(char::is_alphabetic)
            && word.chars().any(|c| c.is_ascii_digit())
            && !word.contains(['/', '.']))
}

/// The words without a last word that is still being written and looks like
/// the start of a key (`looks_like_key`). The filter for secrets then judges
/// whole words only; what is withheld is not sent, and the answer to the rest
/// is said not to be for the whole (`Previewed::whole`).
fn withheld(text: &str) -> &str {
    if text.ends_with(char::is_whitespace) {
        return text;
    }
    let Some(last) = text.split_whitespace().next_back() else {
        return text;
    };
    match looks_like_key(last) {
        true => text[..text.len() - last.len()].trim_end(),
        false => text,
    }
}

/// What a preview is asked with, once every rule lets it be sent.
struct Asking {
    asked: Request,
    asker: Asker,
    limit: Duration,
}

/// Whether a preview of these words may be sent at all, and with what.
fn allowed(core: &mut crate::serve::Core, args: &PreviewWords, page: usize) -> Option<Asking> {
    let (found, by, direct, shown) = effects::read(core, |tx| {
        let by = match tx.pref(PrefKey::RouteBy)?.map(|p| p.value) {
            Some(PrefValue::RouteBy(by)) => by,
            _ => None,
        };
        let shown = tx.pref(PrefKey::ShowTarget)?.map(|p| p.value);
        let shown = !matches!(shown, Some(PrefValue::ShowTarget(false)));
        Ok((
            request(tx, withheld(&args.text), args.current)?,
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
        Asker::ChatGpt(_) => LIMIT,
        Asker::Own(own) if core.own.left_out(&own.address) => return None,
        Asker::Own(own) => LIMIT.min(core.own.limit(&own.address)),
        Asker::Agent(..) => return None,
    };
    // The core's own limits, whatever the page does.
    let p = &mut core.seams.previews;
    if p.quiet.is_some_and(|until| Instant::now() < until)
        || p.sent(args.task) >= PREVIEWS as usize
        || p.lately(page).len() >= PER_MINUTE
    {
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

/// \`route.preview\`: asks the model about the words so far, off the core's
/// thread, and answers with where it puts the task, or with none where there
/// is nothing to show: no preview is sent, the model had no answer it could
/// use, or the words were asked about again meanwhile. Nothing is stored but
/// the answer, for the task's own placing.
pub fn preview(cx: &mut Cx, args: PreviewWords) -> Option<Control> {
    let (link, id) = (cx.link.clone(), cx.id);
    let page = std::rc::Rc::as_ptr(cx.link) as usize;
    let reply = move |choices: Vec<Place>, whole: bool| {
        link.send(&call::RoutePreview::reply(
            id,
            Ok(Previewed { choices, whole }),
        ));
    };
    let Some(Asking {
        mut asked,
        asker,
        limit,
    }) = allowed(cx.core, &args, page)
    else {
        return Some(call::RoutePreview::reply(
            id,
            Ok(Previewed {
                choices: Vec::new(),
                whole: true,
            }),
        ));
    };
    let (task, whole) = (args.task, asked.text == args.text);
    let p = &mut cx.core.seams.previews;
    p.drop_pending();
    p.next += 1;
    let number = p.next;
    p.live = number;
    let folders: Vec<_> = (asked.projects.iter())
        .map(|p| (p.to, p.folder.clone()))
        .collect();
    crate::calls::aside(
        cx.core,
        move || route::tops(folders, effects::TOPS_WITHIN),
        move |core, tops| {
            asked.top = tops.unwrap_or_default();
            // Asked again, or a task sent, while the folders were read.
            if core.seams.previews.live != number {
                return reply(Vec::new(), whole);
            }
            let p = &mut core.seams.previews;
            let sent_at = Instant::now();
            p.at(task).sent += 1;
            p.lately(page).push_back(sent_at);
            let (hear, heard) = mpsc::channel();
            p.inflight = Some(hear);
            let text = route::asked(&asked);
            let call = effects::direct(core, &asker, text, limit, (Some(heard), true));
            let began = Instant::now();
            crate::calls::aside(core, call, move |core, answer| {
                core.events.notify_one();
                let p = &mut core.seams.previews;
                // Stopped, or asked again since: nobody waits for this answer,
                // and a call that was stopped failed for no one's fault.
                if p.live != number {
                    // It counts toward no limit.
                    let t = p.at(task);
                    t.sent = t.sent.saturating_sub(1);
                    p.lately(page).retain(|at| *at != sent_at);
                    return reply(Vec::new(), whole);
                }
                (p.live, p.inflight) = (0, None);
                let answer = answer.and_then(Result::ok);
                if answer.is_none() {
                    p.quiet = Some(Instant::now() + QUIET);
                }
                let found = answer.as_deref().and_then(|a| accept(&asked, a).ok());
                let choices = found.as_ref().map(|(r, _)| places(r)).unwrap_or_default();
                if let (Some(answer), false) = (answer, choices.is_empty()) {
                    let ms = u32::try_from(began.elapsed().as_millis()).unwrap_or(u32::MAX);
                    // An answer to words less a withheld last word is for
                    // those words, not for the whole.
                    let text = if whole {
                        asked.text.clone()
                    } else {
                        String::new()
                    };
                    core.seams.previews.at(task).confirmed = Some(Confirmed {
                        text,
                        answer,
                        asker: asker.id(),
                        model: asker.model().into(),
                        choices: choices.clone(),
                        ms,
                    });
                }
                reply(choices.into_iter().map(Place::from).collect(), whole);
            });
        },
    );
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_what_looks_like_a_key_is_held_back_never_a_path_a_version_or_a_name() {
        let held = |text: &str| withheld(text) != text;
        // A key's opening, or a long word of letters and digits.
        for word in [
            "sk-proj-Zq81mXp0",
            "ghp_abcdef",
            "gho_x",
            "xoxb-1",
            "AKIAIOSFODNN7EXAMPLE",
            "eyJhbGciOi",
            "Zq81mXp0aLd7TeSt",
        ] {
            assert!(held(&format!("fix the build with {word}")), "{word}");
        }
        // A path, a version, a name: sent whole. And a finished word is the filter's to judge.
        for word in [
            "src/capture.tsx",
            "v2.14.1-beta.3",
            "harbormaster-customer-portal",
            "refactor_the_authentication",
            "capture.tsx",
        ] {
            assert!(!held(&format!("fix the build in {word}")), "{word}");
        }
        assert!(!held("fix the build with sk-proj-Zq81mXp0 "));
        assert_eq!(
            withheld("fix the build with sk-proj-Zq81mXp0"),
            "fix the build with"
        );
    }
}
