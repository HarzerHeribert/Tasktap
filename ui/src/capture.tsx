// The Composer, the same in the notch, the capture sheet and on Home: the thought on lines of its own; under it, inside
// the field, where it will go and why (`where`), the agents as rings (the seated one runs this thought: the usual one,
// or another picked for it alone), the microphone, and the key that says what Return does.
// A thought with no folder to go to is saved for later: it waits on Home until it is sent to one.
//
// Under the row is what is on its way, by one mechanism for typing and for voice (way.ts): speech being heard and
// written down, then the thought being placed, then where it goes with its brief, readable for the length of its hold,
// with Undo. Every Composer shows every thought on its way, whoever captured it. Return on an empty field starts the
// newest of them now, and the Composer's key says so: it is the one key that says Start.
import type { Capture as CaptureArgs, Dictation, DictationTarget, Route, Thought } from '../../core/proto/protocol.ts';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import { uuid7 } from './client.ts';
import { hit, keyName, spell } from './keys.ts';
import { talkKey } from './page.ts';
import { cancel, control, end, follow, mine, needs, place, setAim, talk, voiced } from './speech/record.ts';
import { I, Key, Level, Mark, Ring, Wave, madeAt } from './ui.tsx';
import { agent, agentName, call, fail, focus, openQuestions, page, placers, pref, projectName, projects, records, redraw, runs, sentence, sessionName, why } from './page.ts';
import { back, briefOf, clock, hold, laterWhy, leave, onWay, placed, ring, step } from './way.ts';

/** What was just sent, for what is said of it once it is no longer on its way. `pick`: the place the person chose for
 *  it, which Undo gives back with its words. How it came by its place is the thought's own to say (`placed`). */
export type Sent = { id: string; text: string; to: string | 'later'; pick?: string; agent?: string };

export const cap = {
  draft: '',
  /** The person's own pick of destination for the thought in the field: a project id, 'later', or '' for Tasktap
   *  decides. It goes with that thought, so one saved for later, or sent to a folder by hand, does not decide where the
   *  next goes. */
  dest: undefined as string | undefined,
  /** The agent the person picked for the thought in the field, by its ring. It goes with that thought and no further:
   *  the next is the usual agent's again (the `agent` preference, which only the Agents sheet changes). */
  agent: undefined as string | undefined,
  /** The folder of the workspace the capture sheet was opened in, for that opening only: the sheet clears it when it is
   *  put away, and Home's and the notch's Composers never have it. Not a pick, and never Scratch. */
  usual: undefined as string | undefined,
  /** The place chosen for the thought this Composer sent last: the chip says it is back from it, until a place is
   *  chosen again or the Composer is opened anew. */
  back: undefined as string | undefined,
  /** Where the router would send the text typed now (route.hint), for the chip. */
  hint: null as { text: string; route: Route } | null,
  /** The session the person is in, which the router may send a follow-up to. */
  current: null as string | null,
  choosing: false,
  /** A thought kept for later that the list, while open, sends to a folder, rather than choosing where the next goes. */
  moving: null as string | null,
  /** How many thoughts are on their way to the core, their call not back yet. The field is free for the next. */
  sending: 0,
  sent: null as Sent | null,
  undone: null as Sent | null,
  /** Why the core did not take the last thought, in its words, until the field changes. */
  refused: '',
  /** The thought a dictation is to become, until it has. */
  spoken: '',
  /** Placing by a model is offered under what was just sent; and it was, once, in this run. */
  offer: false,
  offered: false,
};

const folder = (dest: string | undefined) => (dest && dest !== 'later' ? dest : undefined);
/** Where the router would send it, when that is one project. */
const routedProject = (r: Route | undefined) => (r?.confidence === 'clear' && 'project' in r.to ? r.to.project : undefined);

/** The person's pick, while it can still be used. */
export const picked = () => (cap.dest === '' || cap.dest === 'later' || (cap.dest && records.projects.get(cap.dest)?.open) ? cap.dest : undefined);

/** Where the router would send the text typed now, when it knows (route.hint): then Enter
 *  leaves the routing to it rather than picking for the person. */
export function hinted(): Route | undefined {
  const r = cap.hint?.text === cap.draft.trim() ? cap.hint.route : undefined;
  return !picked() && r && r.confidence !== 'unknown' ? r : undefined;
}

/** Where the thought in the field goes, who places it (`to` '' is the router's to say), and why
 *  (docs/projects-design.md, "The chip"). The person's choice, for this thought alone; else a follow-up to the session
 *  its words name or the person is in; else the folder its words name, or a question when they name several (the
 *  match on names places these, with a model agreed to as without); else the folder of the workspace this Composer
 *  was opened in; else Tasktap decides with a model, where placing by one is agreed to; else the one folder open, when
 *  only one is; else Tasktap decides by its words, and one that names no folder is saved for later. Scratch is never a
 *  default: a thought goes there only when the person chooses it. */
export function where(): { to: string; by: 'router' | 'pick' | 'later'; why: 'chosen' | 'follows' | 'named' | 'asked' | 'in' | 'model' | 'only' | 'words' | 'none' } {
  const pick = picked(), route = hinted(), folders = projects().filter((p) => p.kind === 'folder');
  const usual = pick === undefined && cap.usual ? records.projects.get(cap.usual) : undefined;
  if (pick === 'later') return { to: pick, by: 'later', why: 'chosen' };
  if (pick) return { to: pick, by: 'pick', why: 'chosen' };
  if (route?.confidence === 'clear' && 'session' in route.to) return { to: '', by: 'router', why: 'follows' };
  if (route) return { to: routedProject(route) ?? '', by: 'router', why: route.confidence === 'clear' ? 'named' : 'asked' };
  if (usual?.open && usual.kind === 'folder') return { to: usual.id, by: 'pick', why: 'in' };
  if (folders.length && pref('route_by')) return { to: '', by: 'router', why: 'model' };
  if (pick === undefined && folders.length === 1) return { to: folders[0]!.id, by: 'pick', why: 'only' };
  return folders.length ? { to: '', by: 'router', why: 'words' } : { to: 'later', by: 'later', why: 'none' };
}
/** What the chip says: where the thought goes, and why, in a few words. */
function says(w: ReturnType<typeof where>, route: Route | undefined): [string, string] {
  const label = route ? routeLabel(route) : '';
  switch (w.why) {
    case 'chosen':
      return [projectName(folder(w.to)), 'your choice'];
    case 'follows':
      return [label, route?.confidence === 'clear' && 'session' in route.to && route.to.session === cap.current ? 'you are in it' : 'named in it'];
    case 'model':
      return ['Tasktap decides', `${agentName(pref('route_by')?.agent)} reads it`];
    case 'in':
      return [projectName(w.to), 'you are in it'];
    case 'only':
      return [projectName(w.to), 'the only folder open'];
    case 'named':
      return [label, 'named in it'];
    case 'asked':
      return [label, 'you will be asked which'];
    case 'words':
      return ['Tasktap decides', 'by its words'];
    case 'none':
      return ['No folder yet', 'saved for later'];
  }
}
const named = (w: ReturnType<typeof where>): Partial<CaptureArgs> => (w.by === 'router' ? { current: cap.current } : w.by === 'pick' ? { project_id: w.to } : { mode: 'note' });

/** The thoughts on their way, newest first: being placed, or placed and held. Undo still takes each back. */
export const going = () => [...records.thoughts.values()].filter((t) => onWay(t)).sort((a, b) => b.created - a.created);
/** Something is being placed, or a capture of this page has not come back yet: the motion thinks. */
export const routing = () => (!!cap.sent && cap.sent.to !== 'later' && !records.thoughts.has(cap.sent.id) && !cap.spoken) || going().some((t) => t.route?.pending);
/** What this page sent can still be undone. */
export const holding = () => {
  const t = cap.sent && records.thoughts.get(cap.sent.id);
  return !!cap.sent && cap.sent.to !== 'later' && (!t || onWay(t));
};

type Hooks = {
  /** After the folder panel: the notch takes the keyboard back. */
  picked?: () => void;
  /** The sent thought started; the page may put the capture away. */
  started?: () => void;
  /** An agent that cannot run was chosen: the page shows where it is signed in. */
  agents?: () => void;
  /** Voice has no speech service yet: the page leads to where one is chosen. */
  speech?: () => void;
  /** Shows what placing by a model sends, where the person can allow it. Without it the page never offers it. */
  terms?: () => void;
};

async function addProject(hooks: Hooks): Promise<string | undefined> {
  const moving = cap.moving;
  Object.assign(cap, { choosing: false, moving: null });
  try {
    const chosen = await call('host.pick', { folder: true });
    const added = chosen ? await call('project.add', { id: uuid7(), folder: chosen }) : undefined;
    if (added && moving) await call('thought.update', { id: moving, project_id: added });
    else if (added) cap.dest = added;
  } catch (e) {
    fail(e);
  }
  page.focus = '#capture-input';
  hooks.picked?.();
  redraw();
  return folder(cap.dest);
}

const start = (t: Thought) => void call('thought.start', { id: t.id, attempt: uuid7() }).catch(fail);
/** The thought Return on an empty field starts now: the newest on its way, once it has its place. None while one is
 *  still on its way to the core, so a second Return after the one that sent it starts nothing by surprise. */
const waiting = () => {
  const t = going()[0];
  return !cap.sending && t && step(t) !== 'placing' ? t : undefined;
};
/** The sends whose calls are not back yet, for Undo, which takes back what they bring. */
let flights: Promise<unknown> = Promise.resolve();

/** Return. The thought leaves the field at once (way.ts leave), and with it the place picked for it and the thought it
 *  was before Undo gave it back, so the next can be typed while it is on its way to the core. One the core refuses is
 *  back in the field with both. */
async function send(e: Event, hooks: Hooks) {
  e.preventDefault();
  if (!cap.draft.trim()) {
    const t = waiting();
    return void (t && start(t));
  }
  const w = where(), pick = picked(), { dest, undone, agent: by } = cap;
  const gone = leave(cap, async (text) => {
    let id = uuid7();
    // (An agent is a capture's to name: a thought that goes out again to another agent is captured anew.)
    if (undone && w.to && w.to !== 'later' && by === undone.agent) {
      // The thought Undo returned to the person goes out again, with what they changed, rather
      // than a copy of it that would stay behind.
      id = undone.id;
      if (undone.text !== text) await call('put', { c: 'thoughts', id, patch: { text } });
      await call('thought.update', { id, project_id: w.to });
    } else {
      if (undone) await call('delete', { c: 'thoughts', id: undone.id });
      await call('thought.capture', { id, text, strokes: [], source: 'typed', ...named(w), ...(by ? { agent: by } : {}) });
    }
    // A thought that went where nobody chose, to the workspace's folder or wherever its words lead: the moment to offer
    // placing by a model, once.
    const offer = (w.why === 'in' || w.why === 'only' || w.why === 'words') && !cap.offered && !!hooks.terms && offerable();
    Object.assign(cap, { sent: { id, text, to: w.to, pick, agent: by }, offer, offered: cap.offered || offer });
    page.error = '';
  });
  Object.assign(cap, { hint: null, dest: undefined, agent: undefined, undone: null, refused: '', back: pick });
  flights = Promise.allSettled([flights, gone]);
  redraw();
  // Refused: the words are back with their place and their agent, and the core's sentence is under them.
  await gone.catch((err) => {
    Object.assign(cap, { dest: cap.dest ?? dest, agent: cap.agent ?? by, undone: cap.undone ?? undone, refused: sentence(err instanceof Error ? err.message : String(err)) });
    askRoute();
  });
  redraw();
}

/** Takes a thought back before it starts: the core stops asking about it and holding it, and its words return to the
 *  field, before what was typed since, with the place the person had picked, if they had, still picked. `later`: the
 *  one just saved for later is removed instead. With none named it is the newest, once what is on its way to the
 *  core has arrived there. */
export async function undo(t?: Thought | 'later') {
  if (!t) {
    await flights;
    t = going()[0] ?? (kept() ? 'later' : undefined);
  }
  const sent = cap.sent;
  try {
    if (t === 'later' && sent) {
      const text = records.thoughts.get(sent.id)?.text ?? sent.text;
      await call('delete', { c: 'thoughts', id: sent.id });
      Object.assign(cap, { sent: null, draft: back(text, cap.draft), dest: sent.pick, agent: sent.agent });
    } else if (t && t !== 'later') {
      await call('thought.stop', { id: t.id });
      // The agent picked for it alone comes back with it, as the thought itself says.
      const by = t.agent && t.agent !== agent()?.id ? t.agent : undefined;
      Object.assign(cap, {
        undone: { id: t.id, text: t.text, to: t.project_id ?? '', agent: by }, sent: sent?.id === t.id ? null : sent, offer: false, dest: sent?.id === t.id ? sent.pick : cap.dest,
        agent: by, draft: back(t.text, cap.draft),
      });
      // Where it goes is asked again for the words that are back, as it was while they were typed.
      askRoute();
    } else return;
    page.focus = '#capture-input';
  } catch (e) {
    fail(e);
  }
  redraw();
}

/** What this page sent last waits in For later: saved there by choice, or kept there because its words named no
 *  folder. Undo takes it back. */
const kept = () => {
  const t = cap.sent && records.thoughts.get(cap.sent.id);
  return cap.sent?.to === 'later' || (!!t && step(t) === 'later');
};

/** An undone thought whose text the person cleared is gone: nothing stale stays behind. */
function drop() {
  const undone = cap.undone;
  cap.undone = null;
  if (undone) void call('delete', { c: 'thoughts', id: undone.id }).catch(fail);
}

let hintTimer = 0;
/** Asks the core where the text typed so far would go, a moment after typing stops. */
function askRoute() {
  clearTimeout(hintTimer);
  const text = cap.draft.trim();
  if (!text) {
    cap.hint = null;
    return redraw();
  }
  hintTimer = window.setTimeout(() => {
    void call('route.hint', { text, current: cap.current }).then((route) => {
      cap.hint = { text, route };
      redraw();
    }, () => {});
  }, 150);
}

function routeLabel(r: Route) {
  if (r.confidence === 'ambiguous') return r.candidates.map((c) => c.label).join(' or ');
  if (r.confidence !== 'clear') return '';
  return 'project' in r.to ? projectName(r.to.project) : `Follow-up: ${sessionName(r.to.session)}`;
}

export function choose(open: boolean) {
  cap.choosing = open;
  if (!open) cap.moving = null;
  // The destination chosen now, else the first.
  page.focus = open ? '.cap-list [aria-selected=true], .cap-list:not(:has([aria-selected=true])) button' : '#capture-input';
  redraw();
}

function pick(dest: string) {
  const moving = cap.moving;
  // The list was opened from a kept thought's line: it starts there, as from Home's For later.
  if (moving) void call('thought.update', { id: moving, project_id: dest }).catch(fail);
  else Object.assign(cap, { dest, back: undefined });
  Object.assign(cap, { choosing: false, moving: null });
  page.focus = '#capture-input';
  redraw();
}

/** Opens the list to send a thought kept for later to a folder. */
const sendOn = (id: string) => ((cap.moving = id), choose(true));

/** The arrows move through the destinations; the browser's Enter and Space press one; Escape leaves them as they were. */
function arrows(e: KeyboardEvent) {
  if (e.key === 'Escape') return (e.preventDefault(), e.stopPropagation(), choose(false));
  const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  e.stopPropagation();
  const items = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  items[(at + step + items.length) % items.length]?.focus({ focusVisible: true });
}

// ——— Voice ———

// A new thought when it is spoken into an empty Composer: captured as typing and Return would have, so it names its
// place the same way. Anything else is words for the field: one that holds text, a reply, a thought taken back.
setAim((field): DictationTarget => {
  if (field?.id !== 'capture-input' || field.value.trim() || cap.undone) return { kind: 'text' };
  const w = where(), id = uuid7();
  const by = cap.agent;
  Object.assign(cap, { sent: { id, text: '', to: w.to, pick: picked(), agent: by }, spoken: id, offer: false, dest: undefined, agent: undefined, refused: '', back: picked() });
  return { kind: 'thought', id, text: '', strokes: [], source: 'voice', ...named(w), ...(by ? { agent: by } : {}) };
});

/** After every change of the records (each page calls it): heard words go to their field, and a spoken thought that
 *  never came to be (cancelled, failed, or ended as words to edit first) leaves nothing said of it: the place and the
 *  agent picked for it are the field's again. */
export function followSpeech() {
  follow();
  if (!cap.spoken) return;
  if (records.thoughts.has(cap.spoken)) cap.spoken = '';
  else if (!talk.id && !talk.asking) {
    const was = cap.sent?.id === cap.spoken ? cap.sent : null;
    Object.assign(cap, { spoken: '', ...(was && { sent: null, dest: cap.dest ?? was.pick, agent: cap.agent ?? was.agent }) });
  }
}

/** Whether this page's dictation is for the Composer's field rather than a reply's. */
const here = () => !talk.field || talk.field.id === 'capture-input';

/** What a dictation is doing, in a word. */
const hears = (d: Dictation | undefined) => (d?.phase === 'transcribing' ? 'Writing it down…' : d ? 'Listening' : 'Opening the microphone…');

/** The row while the person speaks and while their words are written down: the wave as loud as the voice, how long it
 *  has run once that matters, what letting go does, the key that ends a new thought as words to edit first (E), the
 *  way out, and the key that ends a recording a click keeps on. */
function Hearing({ d, raised, said }: { d: Dictation | undefined; raised: boolean; said: boolean }) {
  const writing = d?.phase === 'transcribing';
  useEffect(() => {
    if (writing) return undefined;
    const timer = setInterval(redraw, 1000);
    return () => clearInterval(timer);
  }, [writing]);
  const time = d && !writing ? clock((Date.now() - madeAt(d.id)) / 1000, 300) : '';
  return (
    <div class="cap-row hear" role="status" data-phase={d?.phase ?? 'opening'}>
      {writing ? <Mark s="working" label="" /> : raised && <Level l={(d?.level ?? 0) / 100} />}
      {!said && <b>{hears(d)}</b>}
      {time && <time>{time}</time>}
      {/* What is written down while the person speaks on (speech on this Mac): the last of it. */}
      {!writing && d?.text && <span class="hear-t">{d.text.slice(-90)}</span>}
      <span class="hear-x">{!writing && !talk.latched && d && (talk.kind === 'thought' ? 'Let go to send' : 'Let go to add it')}</span>
      {!writing && d && talk.kind === 'thought' && <button type="button" class="act" onClick={() => end(true)}><Key k="E" cap /><span>Edit first</span></button>}
      <button type="button" class="act" onClick={cancel}><Key k="esc" cap /><span>Cancel</span></button>
      {!writing && talk.latched && <button type="button" class={`key${raised ? ' lg' : ''}`} onClick={() => end()}><I n="ret" /><span>Done</span></button>}
    </div>
  );
}

// ——— On its way ———

/** The hold as a line that runs out: as long as what is left, from the share that is left, by the clock and not by
 *  frames. It starts again when the core moves the hold's end, and stands whole while that end is still open. */
function Hold({ t }: { t: Thought }) {
  const h = useMemo(() => hold(t, Date.now()), [t.hold_until, t.route?.pending]);
  return <i class="way-hold" key={t.hold_until ?? 0} data-open={!h || undefined} style={h ? { '--from': String(h.share), '--ms': `${Math.round(h.ms)}ms` } : undefined} />;
}

/** A thought on its way, with the way to take it back. The newest is `open`: where it goes and what the work is
 *  called, the brief in full when it says the words differently, the person's own words under it, and how it was
 *  placed. Any other is its first line. */
function Going({ t, open }: { t: Thought; open: boolean }) {
  const at = step(t), brief = briefOf(t);
  const note = placed(t, agentName);
  return (
    <section class="way" data-step={at} data-thought={t.id} aria-label="On its way">
      <Hold t={t} />
      <p class="way-h">
        {at === 'placing' ? <><Mark s="working" label="" /><b>Placing…</b></> : (
          <><I n={t.session_id ? 'term' : 'arrow'} /><b>{t.session_id ? `Follow-up: ${sessionName(t.session_id)}` : projectName(t.project_id)}</b></>
        )}
        {at === 'briefing' && <em>Writing the brief…</em>}
        <button type="button" class="act" onClick={() => void undo(t)}><Key k="⌘Z" cap /><span>Undo</span></button>
      </p>
      {open && brief && <p class="way-b"><span>Brief{t.route?.title && <b>{t.route.title}</b>}</span>{brief}</p>}
      {open && (brief || t.source === 'voice') && <p class="way-w"><span>You said</span>{t.text}</p>}
      {open && note && at !== 'placing' && <p class="way-n">{note}</p>}
    </section>
  );
}

/** A dictation that failed: the core's sentence as it is, what was heard so it can be used, and the way out. */
function Failed({ d }: { d: Dictation }) {
  const dismiss = () => (d.id === talk.id ? cancel() : void call('dictation.cancel', { id: d.id }).catch(fail));
  return (
    <section class="way failed" role="alert" data-dictation={d.id}>
      <p class="way-h"><Mark s="failed" label="" /><b>{d.error ?? 'It could not be written down'}</b>
        {d.text && <button type="button" class="btn" onClick={() => (place(d.text), dismiss())}>Use these words</button>}
        <button type="button" class="act" onClick={dismiss}><Key k="esc" cap /><span>Dismiss</span></button>
      </p>
      {d.text && <p class="way-w"><span>Heard</span>{d.text}</p>}
    </section>
  );
}

/** Whether placing by a model can be offered: nobody was asked yet, and a signed-in agent could do it. */
export const offerable = () => !records.prefs.has('route_by') && placers().length > 0;
/** The offer, one quiet line: what it gives, the way to what it sends, and No. */
export function Offer({ terms }: { terms: () => void }) {
  const no = () => {
    cap.offer = false;
    void call('put', { c: 'prefs', id: 'route_by', patch: null }).catch(fail);
  };
  return (
    <p class="cap-said offer">
      <span>Thoughts can find their own folder, and get a brief, with your own agent.</span>
      <button type="button" class="btn" onClick={terms}>See what it sends…</button>
      <button type="button" class="act" onClick={no}><span>Not now</span></button>
    </p>
  );
}

/** How long the Composer says where a thought started, and which thought it last said it of. */
const SAID_FOR = 6000;
let told = { id: '', at: 0 };
function Way({ hooks, raised, offer }: { hooks: Hooks; raised: boolean; offer: boolean }) {
  const sent = cap.sent?.id === cap.spoken ? null : cap.sent;
  const t = sent ? records.thoughts.get(sent.id) : undefined;
  const all = going();
  const failed = [...records.dictations.values()].filter((d) => d.phase === 'failed');
  useEffect(() => {
    if (t?.phase !== 'working' || cap.draft || !hooks.started) return undefined;
    const timer = setTimeout(hooks.started, 1600);
    return () => clearTimeout(timer);
  });
  const line = (words: ComponentChildren, more?: ComponentChildren) => <p class="cap-said" role="status"><span>{words}</span>{more}</p>;
  const at = step(t), note = t && placed(t, agentName);
  // Where a thought started is said once, for a few seconds: after that its row says it, and nothing stands under the
  // Composer. (What still needs the person stays: a question, a failure, why it waits, and Undo while it can be undone.)
  const began = at === 'started' && sent ? (told.id === sent.id ? told : (told = { id: sent.id, at: Date.now() })).at : 0;
  const fresh = began > 0 && Date.now() - began < SAID_FOR;
  useEffect(() => {
    if (!fresh) return undefined;
    const timer = setTimeout(redraw, began + SAID_FOR - Date.now() + 20);
    return () => clearTimeout(timer);
  }, [fresh, began]);
  // Why it waits for later; where the person did not put it there themselves, that it does.
  const later = t ? `${laterWhy(t, agentName)}${t.placed === 'kept' || t.placed === 'kept_answer' ? '' : '; saved for later'}` : '';
  return (
    <div class={`ways${raised ? ' under' : ''}`}>
      {failed.map((d) => <Failed key={d.id} d={d} />)}
      {cap.refused && <section class="way failed" role="alert"><p class="way-h"><Mark s="failed" label="" /><b>{cap.refused}</b></p></section>}
      {talk.said === 'service' && line(needs(), hooks.speech && <button type="button" class="btn" onClick={() => (cancel(), hooks.speech!())}>Set up…</button>)}
      {talk.said && talk.said !== 'service' && line(talk.said)}
      {all.map((x, i) => <Going key={x.id} t={x} open={i === 0} />)}
      {sent?.to === 'later' && t && line(raised || projects().some((p) => p.kind === 'folder') ? 'Saved for later' : 'Saved for later, until a folder is open',
        <button type="button" class="act" onClick={() => void undo('later')}><Key k="⌘Z" cap /><span>Undo</span></button>)}
      {sent && sent.to !== 'later' && t && !onWay(t) && (
        at === 'asked' ? line('Where should it go? Its question is open.')
          : at === 'later' ? line(later, <>
            <button type="button" class="btn" onClick={() => sendOn(t.id)}>Send to a folder…</button>
            <button type="button" class="act" onClick={() => void undo('later')}><Key k="⌘Z" cap /><span>Undo</span></button>
          </>)
            : at === 'failed' ? line(`${why(t)} in ${projectName(t.project_id)}.`)
              : fresh ? line(<>Started in <b>{projectName(t.project_id)}</b>{note && <i>{note}</i>}</>) : null
      )}
      {(cap.offer || offer) && hooks.terms && offerable() && !talk.id && !talk.asking && <Offer terms={hooks.terms} />}
    </div>
  );
}

/** The agents this Mac has, each its mark in a ring. The one that runs the thought in the field is seated: on the
 *  selected fill, its ring lit, its name beside it where there is room. That is the usual agent (the `agent`
 *  preference) until a click on another ring picks that one for this thought alone; the seat moves there, the ring
 *  that takes it answers the click, and after the thought is sent the seat is the usual agent's again. A follow-up
 *  (`session`) is its session's agent's: that ring alone, and no choice. One that is not signed in is an open ring
 *  that says so and leads to where it is signed in. A ring turns while its agent works, beside the count of what it
 *  works on, and takes the attention colour when one of its sessions asks. */
function Rings({ hooks, session }: { hooks: Hooks; session?: string }) {
  const installed = [...records.agents.values()].filter(runs);
  const usual = agent()?.id, fixed = session ? records.sessions.get(session)?.agent : undefined;
  const all = fixed ? installed.filter((a) => a.id === fixed) : installed;
  const chosen = fixed ?? (all.some((a) => a.id === cap.agent) ? cap.agent : usual);
  const asking = new Set(openQuestions().map((q) => records.sessions.get(q.session_id ?? '')?.agent ?? records.thoughts.get(q.thought_id ?? '')?.agent));
  if (!all.length) return null;
  return (
    <span class="rings" role="radiogroup" aria-label="Agent">
      {all.map((a) => {
        const { n, s } = ring(a, records.thoughts.values(), (id) => asking.has(id));
        const off = s === 'off', on = a.id === chosen;
        const words = [
          `${agentName(a.id)}${a.version ? ` ${a.version}` : ''}`,
          off ? 'not signed in' : fixed ? 'runs this follow-up, as it runs its session' : !on ? 'click to use it for this thought' : a.id === usual ? 'runs the next thought' : 'runs this thought only',
          n > 0 && `${n} working`, s === 'asks' && 'one needs you',
        ].filter(Boolean).join(', ');
        return (
          <button type="button" class="ring" role="radio" aria-checked={on} data-s={s || undefined} data-agent={a.id} title={words} aria-label={words}
            onClick={() => (off ? hooks.agents?.() : !fixed && ((cap.agent = a.id === usual ? undefined : a.id), redraw()))}>
            {off && <span class="fix">Sign in</span>}
            <Ring agent={a.id} s={s} turns={n > 0} />
            {on && !off && <span class="nm">{agentName(a.id)}</span>}
            {n > 0 && <b>{n}</b>}
          </button>
        );
      })}
    </span>
  );
}

/** The Composer. `raised` is Home's: a surface of its own, the thought at 20 px, up to six lines; elsewhere it sits on
 *  its sheet with the wave beside the thought, up to three lines. */
export function Capture({ raised = false, offer = false, ...hooks }: Hooks & { raised?: boolean; offer?: boolean }) {
  const route = hinted(), w = where();
  const folders = projects().filter((p) => p.kind === 'folder');
  const later = w.by === 'later', model = w.why === 'model';
  const session = route?.confidence === 'clear' && 'session' in route.to ? route.to.session : undefined;
  // After a thought with a place of its own is sent, the next goes where nobody chose, and the chip says it is back.
  const [name, why] = says(w, route), back = cap.back !== undefined && !!cap.sent && cap.back !== w.to && (model || w.why === 'in' || w.why === 'only' || w.why === 'words');
  // What Return does, which the key says: with a thought in the field it sends that; with none it starts the one that
  // waits, if one does; and while the last is still on its way to the core and nothing new is typed, it shows the wave.
  const has = !!cap.draft.trim(), now = !has && !!waiting(), busy = !has && cap.sending > 0;
  const does = now ? 'Start' : later ? 'Save for later' : session ? 'Send' : 'Start';
  const d = mine(), service = voiced();
  const hearing = here() && (talk.asking || d?.phase === 'recording' || d?.phase === 'transcribing');
  // In the notch and the sheet the row is narrow, and a spoken new thought's own line is empty: that line says what
  // the dictation is doing, beside the wave that follows the voice, and the row keeps the time, the keys and the way out.
  const said = hearing && !raised && talk.kind === 'thought' && !cap.draft;
  // The field is as high as its words, a line at a time. It is measured when they change, typed or put there, or its
  // width does, and on no other render: a measure makes the page lay itself out there and then.
  const area = useRef<HTMLTextAreaElement>(null), fitted = useRef({ text: '', width: -1 });
  const fit = (width = fitted.current.width) => {
    const el = area.current!;
    if (el.value === fitted.current.text && width === fitted.current.width) return;
    fitted.current = { text: el.value, width };
    el.style.height = '0';
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(() => fit());
  // The foot where it is short of room: the chip's reason gives way first, by itself (parts.css); then the microphone's
  // key hint is dropped, once the reason is gone and only where that gives the chip's place room; then the place is cut
  // short. Measured when the foot's width, the rings or what the chip and the key say change, and on no other render.
  const foot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = foot.current;
    if (!row) return undefined;
    const room = () => {
      const place = row.querySelector<HTMLElement>('#dest-chip b'), reason = row.querySelector<HTMLElement>('#dest-chip span');
      if (!place || !reason || !row.querySelector('.mic kbd')) return;
      const wide = () => place.getBoundingClientRect().width + reason.getBoundingClientRect().width;
      row.removeAttribute('data-short');
      if (reason.getBoundingClientRect().width >= 1) return;
      const was = wide();
      row.setAttribute('data-short', '');
      if (wide() <= was) row.removeAttribute('data-short');
    };
    room();
    const watch = new ResizeObserver(room);
    watch.observe(row);
    const rings = row.querySelector('.rings');
    if (rings) watch.observe(rings);
    return () => watch.disconnect();
  }, [name, why, back, does, busy, hearing, cap.choosing]);
  useLayoutEffect(() => {
    const watch = new ResizeObserver(([e]) => fit(e!.contentRect.width));
    watch.observe(area.current!);
    return () => watch.disconnect();
  }, []);
  const option = (id: string, on: boolean, mark: ComponentChildren, name: string) => (
    <button type="button" role="option" aria-selected={on} onClick={() => pick(id)}>{mark}<span>{name}</span></button>
  );
  return (
    <form class={`capture${raised ? ' raised' : ''}${cap.draft ? ' has' : ''}`} aria-busy={cap.sending > 0} onSubmit={(e) => send(e, hooks)}>
      <div class="cap" onPointerDown={(e) => e.target === e.currentTarget && (e.preventDefault(), focus('#capture-input'))}>
        {!raised && (hearing && d?.phase === 'recording' ? <Level n={13} l={d.level / 100} /> : <Wave n={13} live={!!cap.draft} />)}
        <textarea id="capture-input" ref={area} rows={1} autocomplete="off" spellcheck={false} aria-label="New task" placeholder={said ? hears(d) : service && !raised ? `Type, or hold ${keyName(talkKey())} and talk` : 'Put a thought in'}
          value={cap.draft}
          onInput={(e) => {
            const first = !cap.draft.trim();
            cap.draft = e.currentTarget.value;
            if (!cap.draft.trim()) cap.refused = '';
            fit();
            if (cap.undone && !cap.draft.trim()) drop();
            askRoute();
            // The first of a thought: the key says at once what Return now does.
            if (first) redraw();
          }}
          onKeyDown={(e) => {
            // Return sends, once however long it is held, and Shift-Return starts a new line; or, as the person set it
            // (`return_sends`), Return starts a new line and Command-Return sends (Control-Return off the Mac).
            if (e.key === 'Enter' && !e.isComposing && (pref('return_sends') ? !e.shiftKey : e.metaKey || e.ctrlKey)) e.repeat ? e.preventDefault() : void send(e, hooks);
            else if (hit('⌘Z', e) && !cap.draft && (cap.sending || going().length || kept())) {
              e.preventDefault();
              void undo();
            }
          }} />
        {cap.choosing ? (
          // The choice has the field's row to itself, so it covers nothing the person is reading: the folders, a new
          // one, and for later. Return then picks, so the key that sends is away until one is picked.
          // An element of its own (`key`), never the chip's: the chip had the keyboard, and losing it as the list took the
          // chip's place would close the list again where the engine says so (Chromium, so Windows). The list takes the
          // keyboard; Escape and a choice give it back to the field. Opened from a kept thought's line, it sends that one.
          <div key="list" class="cap-row cap-list" role="listbox" aria-label={cap.moving ? 'Send it to' : 'Where it goes'} onKeyDown={arrows}
            onFocusOut={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && cap.choosing && ((cap.choosing = false), (cap.moving = null), redraw())}>
            {!cap.moving && folders.length > 0 && option('', w.by === 'router' && !w.to, <I n="arrow" />, 'Tasktap decides')}
            {projects().map((p) => option(p.id, !cap.moving && p.id === w.to, <I n="folder" />, p.name))}
            <button type="button" onClick={() => void addProject(hooks)}><I n="plus" /><span>Open a folder…</span></button>
            {!cap.moving && option('later', later, <Mark s="later" label="" />, 'For later')}
          </div>
        ) : hearing ? <Hearing d={d} raised={raised} said={said} /> : (
          <div key="foot" class="cap-row" ref={foot}>
            <button type="button" class="cap-to" id="dest-chip" aria-haspopup="listbox" aria-expanded={false}
              title={`${back ? 'Your choice was for the thought before. ' : ''}${!folders.length ? 'No folder is open yet: a thought is saved for later until one is. Click to open one' : later ? 'Saved for later: nothing starts. Click to change'
                : model ? `${agentName(pref('route_by')?.agent)} reads the thought and places it. Click to choose the place yourself`
                  : w.why === 'words' ? 'Tasktap places it in the folder its words name, and saves it for later when they name none. Click to choose the place yourself'
                    : w.why === 'only' ? 'The one folder open, so a thought that names no other place goes there. Click to change' : 'Where it goes. Click to change'}`}
              onClick={() => choose(true)}
              onKeyDown={(e) => (e.key === 'ArrowDown' || e.key === 'ArrowUp') && (e.preventDefault(), e.stopPropagation(), choose(true))}>
              {!later ? <I n={session ? 'term' : 'arrow'} /> : folders.length ? <Mark s="later" label="" /> : <I n="folder" />}
              <b>{back ? `Back to ${name}` : name}</b>
              <span>{why}</span>
              <I n="chev" />
            </button>
            <Rings hooks={hooks} session={session} />
            <button type="button" class="mic" data-off={!service || undefined} aria-label="Talk"
              title={service ? `Hold to talk, or hold ${keyName(talkKey())}. A click keeps it on until the next` : 'Voice needs setting up first'}
              onPointerDown={(e) => control.down(e, area.current)} onClick={(e) => control.key(e, area.current)}>
              <span><I n="mic" /></span><Key k={keyName(talkKey())} />
            </button>
            <button type="submit" class={`key${raised ? ' lg' : ''}`} disabled={!has && !now && !busy} aria-busy={busy || undefined} title={now ? 'Start it now' : undefined}>
              {busy ? <Mark s="working" label="" /> : <i class="sends">{!pref('return_sends') && spell('⌘↩').replace('↩', '')}<I n="ret" /></i>}<span>{does}</span>
            </button>
          </div>
        )}
      </div>
      <Way hooks={hooks} raised={raised} offer={offer} />
    </form>
  );
}
