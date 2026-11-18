// The Composer, the same in the notch, the capture sheet and on Home: the thought on lines of its own; under it, inside
// the field, where it will go (the person's pick, else where the router says, else wherever a model places it or the
// default), the agents as rings (the seated one runs this thought: the usual one, or another picked for it alone), the
// microphone, and the key that says what Return does.
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
import { cancel, control, end, follow, mine, needs, place, setAim, talk, voiced } from './speech/record.ts';
import { I, Level, Mark, Ring, Wave, madeAt } from './ui.tsx';
import { agent, agentName, call, fail, focus, openQuestions, page, placers, pref, projectName, projects, records, redraw, sentence, sessionName, why } from './page.ts';
import { back, briefOf, clock, hold, laterWhy, leave, onWay, placed, ring, step } from './way.ts';

/** What was just sent, for what is said of it once it is no longer on its way. `pick`: the place the person chose for
 *  it, which Undo gives back with its words. How it came by its place is the thought's own to say (`placed`). */
export type Sent = { id: string; text: string; to: string | 'later'; pick?: string; agent?: string };

export const cap = {
  draft: '',
  /** The person's own pick of destination for the thought in the field: a project id or 'later'. It goes with that
   *  thought, so one saved for later, or sent to a folder by hand, does not decide where the next goes. */
  dest: undefined as string | undefined,
  /** The agent the person picked for the thought in the field, by its ring. It goes with that thought and no further:
   *  the next is the usual agent's again (the `agent` preference, which only the Agents sheet changes). */
  agent: undefined as string | undefined,
  /** The folder the person was in when they began the thought: where it goes when nobody says otherwise. Not a pick. */
  usual: undefined as string | undefined,
  /** Where the router would send the text typed now (route.hint), for the chip. */
  hint: null as { text: string; route: Route } | null,
  /** The session the person is in, which the router may send a follow-up to. */
  current: null as string | null,
  choosing: false,
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
export const picked = () => (cap.dest === 'later' || (cap.dest && records.projects.get(cap.dest)?.open) ? cap.dest : undefined);

/** Where the router would send the text typed now, when it knows (route.hint): then Enter
 *  leaves the routing to it rather than picking for the person. */
export function hinted(): Route | undefined {
  const r = cap.hint?.text === cap.draft.trim() ? cap.hint.route : undefined;
  return !picked() && r && r.confidence !== 'unknown' ? r : undefined;
}

/** Where the next capture goes when neither the person nor the router says: the folder they were in,
 *  else the project of the newest thought, else their first project. None until they have one: the chip offers to add it. */
export function destination(): string | undefined {
  const pick = picked();
  if (pick) return pick;
  if (cap.usual && records.projects.get(cap.usual)?.open) return cap.usual;
  const newest = [...records.thoughts.values()]
    .filter((t) => t.project_id && records.projects.get(t.project_id)?.open)
    .sort((a, b) => b.created - a.created)[0];
  return newest?.project_id ?? projects().find((p) => p.kind === 'folder')?.id;
}

/** Where the next capture goes, and who says so: the router (the text names its place, or the person allowed a model
 *  to place what names none), the person's pick or the default, or nowhere yet. */
function where(): { to: string; by: 'router' | 'pick' | 'later' } {
  const route = hinted();
  if (route) return { to: routedProject(route) ?? '', by: 'router' };
  if (!picked() && pref('route_by') && projects().some((p) => p.kind === 'folder')) return { to: '', by: 'router' };
  const to = destination();
  return !to || to === 'later' ? { to: 'later', by: 'later' } : { to, by: 'pick' };
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
  cap.choosing = false;
  try {
    const chosen = await call('host.pick', { folder: true });
    if (chosen) cap.dest = await call('project.add', { id: uuid7(), folder: chosen });
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
    // A thought that named no place and went to the usual one: the moment to offer placing by a model, once.
    const offer = w.by === 'pick' && !pick && !cap.offered && !!hooks.terms && offerable();
    Object.assign(cap, { sent: { id, text, to: w.to, pick, agent: by }, offer, offered: cap.offered || offer });
    page.error = '';
  });
  Object.assign(cap, { hint: null, dest: undefined, agent: undefined, undone: null, refused: '' });
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
    t = going()[0] ?? (cap.sent?.to === 'later' ? 'later' : undefined);
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
  // The destination chosen now, else the first.
  page.focus = open ? '.cap-list [aria-selected=true], .cap-list:not(:has([aria-selected=true])) button' : '#capture-input';
  redraw();
}

function pick(dest: string) {
  Object.assign(cap, { dest: dest || undefined, choosing: false });
  page.focus = '#capture-input';
  redraw();
}

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
  Object.assign(cap, { sent: { id, text: '', to: w.to, pick: picked(), agent: by }, spoken: id, offer: false, dest: undefined, agent: undefined, refused: '' });
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
      {!writing && d && talk.kind === 'thought' && <button type="button" class="act" onClick={() => end(true)}><kbd>E</kbd><span>Edit first</span></button>}
      <button type="button" class="act" onClick={cancel}><kbd>esc</kbd><span>Cancel</span></button>
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
        <button type="button" class="act" onClick={() => void undo(t)}><kbd>⌘Z</kbd><span>Undo</span></button>
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
        <button type="button" class="act" onClick={dismiss}><kbd>esc</kbd><span>Dismiss</span></button>
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
  // Why it waits for later; where the person did not put it there themselves, that it does.
  const later = t ? `${laterWhy(t, agentName)}${t.placed === 'kept' || t.placed === 'kept_answer' ? '' : '; saved for later'}` : '';
  return (
    <div class={`ways${raised ? ' under' : ''}`}>
      {failed.map((d) => <Failed key={d.id} d={d} />)}
      {cap.refused && <section class="way failed" role="alert"><p class="way-h"><Mark s="failed" label="" /><b>{cap.refused}</b></p></section>}
      {talk.said === 'service' && line(needs(), hooks.speech && <button type="button" class="btn" onClick={() => (cancel(), hooks.speech!())}>Set up…</button>)}
      {talk.said && talk.said !== 'service' && line(talk.said)}
      {all.map((x, i) => <Going key={x.id} t={x} open={i === 0} />)}
      {sent?.to === 'later' && t && line(projects().some((p) => p.kind === 'folder') ? 'Saved for later' : 'Saved for later, until a folder is open',
        <button type="button" class="act" onClick={() => void undo('later')}><kbd>⌘Z</kbd><span>Undo</span></button>)}
      {sent && sent.to !== 'later' && t && !onWay(t) && (
        at === 'asked' ? line('Where should it go? Its question is open.')
          : at === 'later' ? line(later)
            : at === 'failed' ? line(`${why(t)} in ${projectName(t.project_id)}.`)
              : at === 'started' ? line(<>Started in <b>{projectName(t.project_id)}</b>{note && <i>{note}</i>}</>) : null
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
  const installed = [...records.agents.values()].filter((a) => a.installed);
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
  const later = w.by === 'later', model = w.by === 'router' && !route;
  const session = route?.confidence === 'clear' && 'session' in route.to ? route.to.session : undefined;
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
        <textarea id="capture-input" ref={area} rows={1} autocomplete="off" spellcheck={false} aria-label="New task" placeholder={said ? hears(d) : service && !raised ? 'Type, or hold ⌥Space and talk' : 'Put a thought in'}
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
            // Return sends, once however long it is held; Shift-Return starts a new line.
            if (e.key === 'Enter' && !e.isComposing && !e.shiftKey) e.repeat ? e.preventDefault() : void send(e, hooks);
            else if (e.key === 'z' && e.metaKey && !cap.draft && (cap.sending || going().length || cap.sent?.to === 'later')) {
              e.preventDefault();
              void undo();
            }
          }} />
        {cap.choosing ? (
          // The choice has the field's row to itself, so it covers nothing the person is reading: the folders, a new
          // one, and for later. Return then picks, so the key that sends is away until one is picked.
          <div class="cap-row cap-list" role="listbox" aria-label="Where it goes" onKeyDown={arrows}
            onFocusOut={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && cap.choosing && ((cap.choosing = false), redraw())}>
            {pref('route_by') && folders.length > 0 && option('', model, <I n="arrow" />, 'Tasktap decides')}
            {folders.map((p) => option(p.id, !model && p.id === (w.to || routedProject(route)), <I n="folder" />, p.name))}
            <button type="button" onClick={() => void addProject(hooks)}><I n="plus" /><span>Open a folder…</span></button>
            {option('later', later, <Mark s="later" label="" />, 'For later')}
          </div>
        ) : hearing ? <Hearing d={d} raised={raised} said={said} /> : (
          <div class="cap-row">
            <button type="button" class="cap-to" id="dest-chip" aria-haspopup="listbox" aria-expanded={false}
              title={!folders.length ? 'No folder is open yet: a thought is saved for later until one is. Click to open one' : later ? 'Saved for later: nothing starts. Click to change'
                : model ? `${agentName(pref('route_by')?.agent)} reads the thought and places it. Click to choose the place yourself` : 'Where it goes. Click to change'}
              onClick={() => choose(true)}
              onKeyDown={(e) => (e.key === 'ArrowDown' || e.key === 'ArrowUp') && (e.preventDefault(), e.stopPropagation(), choose(true))}>
              {!later ? <I n={session ? 'term' : 'arrow'} /> : folders.length ? <Mark s="later" label="" /> : <I n="folder" />}
              <b>{route ? routeLabel(route) : model ? 'Tasktap decides' : !later ? projectName(folder(w.to)) : folders.length ? 'For later' : 'No folder yet'}</b>
              {route?.confidence === 'ambiguous' && <span>you will be asked which</span>}
              <I n="chev" />
            </button>
            <Rings hooks={hooks} session={session} />
            <button type="button" class="mic" data-off={!service || undefined} aria-label="Talk"
              title={service ? 'Hold to talk, or hold ⌥Space. A click keeps it on until the next' : 'Voice needs setting up first'}
              onPointerDown={(e) => control.down(e, area.current)} onClick={(e) => control.key(e, area.current)}>
              <I n="mic" /><kbd>⌥Space</kbd>
            </button>
            <button type="submit" class={`key${raised ? ' lg' : ''}`} disabled={!has && !now && !busy} aria-busy={busy || undefined} title={now ? 'Start it now' : undefined}>
              {busy ? <Mark s="working" label="" /> : <I n="ret" />}<span>{does}</span>
            </button>
          </div>
        )}
      </div>
      <Way hooks={hooks} raised={raised} offer={offer} />
    </form>
  );
}
