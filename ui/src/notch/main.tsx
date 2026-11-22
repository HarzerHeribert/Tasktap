// The notch page: the glance when collapsed, capture, a question or a result when open. It holds only what is on
// screen; every record comes from the core, and the host places the panel.
import '../tokens.css';
import '../parts.css';
import './notch.css';
import '../way.css';
import '../scroll.ts';
import '../motion/paced.ts';
import { listen } from '@tauri-apps/api/event';
import { render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Answer, FIRST } from './answer.tsx';
import { Art, look, place } from './art.tsx';
import { Home } from './home.tsx';
import { atComposer, cap, followSpeech, going, invite, toAsk, typedPast } from '../capture.tsx';
import { waits } from '../way.ts';
import { live, talk } from '../speech/record.ts';
import { effectsOf, lookOf, power } from '../motion/motion.tsx';
import { stops } from '../motion/palette.ts';
import { Brand, Mark } from '../ui.tsx';
import { agentName, asksHere, call, client, fail, heardWhere, onRedraw, openQuestions, page, pref, records, recordsFailed, recordsIn, redraw, settleFocus, title, ui, unheard, watchHeld, where } from './model.ts';
import { fold, reveal } from './panel.ts';
import { watchLayout } from '../keys.ts';
import type { Where } from '../client.ts';

/** How long a notch that opened by itself for a question stays open untouched before it folds (docs/rebuild-plan.md,
 *  "Where Tasktap shows itself", rule 4). The pointer over it holds it; a click or a key makes it the person's. Its
 *  amber glow stays until the question is answered. */
const UNTOUCHED = 10_000;
let idle = 0;
function untouched() {
  clearTimeout(idle);
  if (ui.auto && !ui.touched && !ui.inside) idle = window.setTimeout(() => ui.auto && !ui.touched && !ui.inside && fold(), UNTOUCHED);
}
/** The host said where Tasktap is: the window coming in front folds the notch (rule 3), what was typed staying for
 *  the next time; going behind, the glance is back, glowing while a question waits, and opens nothing by itself. */
function followWhere(w: Partial<Where>) {
  if (!heardWhere(w)) return;
  if (!where.notch && ui.mode !== 'closed') fold();
  redraw();
}

const body = document.body;
const root = document.documentElement.style;
/** The line under a collapsed notch with a cutout that says who asks and what. */
const LINE = 24;

const host = {
  geometry(m: Record<string, number | boolean>) {
    ui.geometry = m;
    const vars: Record<string, unknown> = { '--tab-w': m.width, '--tab-h': m.height, '--tab-x': m.offset, '--sheet-w': m.surfaceWidth, '--sheet-x': m.surfaceOffset, '--avail': m.available };
    for (const [k, v] of Object.entries(vars)) if (typeof v === 'number') root.setProperty(k, v + 'px');
    body.classList.toggle('cutout', m.cutout === true);
    redraw();
  },
  'hover-enter'() {
    ui.inside = true;
    clearTimeout(idle);
    // While Tasktap's window is in front the notch is put away, and the pointer opens nothing (rule 1).
    if (ui.mode !== 'closed' || !where.notch) return;
    clearTimeout(ui.timer);
    ui.timer = window.setTimeout(() => ui.inside && reveal('hover', openQuestions().length ? 'answer' : 'home'), 170);
  },
  'hover-exit'() {
    ui.inside = false;
    untouched();
    if (ui.mode !== 'hover' || document.hasFocus()) return;
    clearTimeout(ui.timer);
    ui.timer = window.setTimeout(() => !ui.inside && ui.mode === 'hover' && fold(), 320);
  },
  capture() {
    // Straight to the field; with a question open, under it.
    ui.capturing = true;
    reveal('pinned', openQuestions().length ? 'answer' : 'home', '#capture-input');
  },
  answer() {
    if (openQuestions().length) reveal('pinned', 'answer', FIRST);
    else reveal('pinned', 'home', '#capture-input');
  },
  /** The keyboard was in the open notch and has gone to another window, by a click there or a key (Windows): the
   *  notch folds, as it does on Escape, and what was typed stays for the next time. */
  away() {
    fold();
  },
};

/** Questions that were open at the last change: a new one opens the notch by itself. So does a task that newly waits
 *  for the person's key (a model was torn, way.ts `waits`): it calls the person as a question does. */
const known = new Set<string>(), waiting = new Set<string>();
records.onchange = () => {
  followSpeech();
  const open = openQuestions();
  // The question about the thought just sent from the open notch's capture line is asked there, under its field, as at
  // every Composer (capture.tsx atComposer): it opens nothing else.
  // So is it while the next thought is typed there (capture.tsx typedPast): nothing typed moves the keyboard.
  const fresh = open.some((q) => !known.has(q.id) && !(ui.mode !== 'closed' && ui.view === 'home' && (toAsk(q) || typedPast(q))));
  known.clear();
  for (const q of open) known.add(q.id);
  const now = going().filter((t) => waits(t)).map((t) => t.id), called = now.some((id) => !waiting.has(id));
  waiting.clear();
  for (const id of now) waiting.add(id);
  // Where nothing else is open in the notch: on its capture line, whose decision line takes Return and the keys. Also
  // in a notch that a question opened by itself and that is about to fold after its answer (`ui.auto`), as a question
  // that comes then keeps it open (below): the fold is cancelled by revealing it.
  if (called && !fresh && asksHere('notch') && (ui.mode === 'closed' || ui.auto)) {
    ui.capturing = true;
    reveal('pinned', 'home', '#capture-input');
    ui.auto = true;
    ui.touched = false;
    untouched();
  }
  // A notch the last question opened by itself is still its own to fold: a new question that
  // arrives while that fold is pending keeps it open. Only where the notch is where Tasktap is (presence.rs): with
  // Tasktap's window in front the window shows the question, in full screen a notification does (rules 1 and 6).
  if (fresh && asksHere('notch') && (ui.mode === 'closed' || ui.auto)) {
    reveal('pinned', 'answer');
    ui.auto = true;
    ui.touched = false;
    untouched();
  } else if (fresh && ui.mode !== 'closed' && ui.view === 'home') {
    // Open on the capture line: the question comes first and the line moves under it, the
    // person's typing and its focus with it.
    ui.view = 'answer';
    ui.capturing = true;
    if (document.activeElement?.id === 'capture-input') page.focus = '#capture-input';
  } else if (!open.length && ui.view === 'answer' && ui.mode !== 'closed') {
    // One pending fold however many changes arrive meanwhile, so a new question can cancel it.
    if (ui.auto) {
      clearTimeout(ui.timer);
      ui.timer = window.setTimeout(fold, 500);
    } else ui.view = 'home';
  }
  redraw();
};

/** The glance on the collapsed tab. Without a camera cutout it is one line, centred as a whole on the tab's centre line
 *  in every state: Tasktap's mark when idle; else working, who asks and what, then needs you, new and failed. The tab
 *  is as wide as that line needs and widens evenly about its centre. With a cutout the centre is the camera's, so the
 *  line is split about it: working in the left wing from its outer edge, the rest in the right wing from its outer edge,
 *  each wing as wide as the wider side, and a line under the camera that says who asks and what. */
const PAD = 14, GAP = 8, CLEAR = 6;
function Glance() {
  const g = records.glance;
  const left = useRef<HTMLSpanElement>(null);
  const right = useRef<HTMLSpanElement>(null);
  const q = openQuestions().find((x) => x.id === g?.question) ?? openQuestions()[0];
  const cutout = ui.geometry?.cutout === true;
  const any = !!g && g.working + g.needs_you + g.done + g.failed > 0;
  // Of what the core counts as done, the thoughts an agent of the plain tier ran have only ended (page.ts unheard):
  // they are counted apart, under the quiet mark, never as a result that is ready.
  const ended = Math.min(g?.done ?? 0, [...records.thoughts.values()].filter((x) => !x.read && unheard(x)).length);
  const s = q?.session_id ? records.sessions.get(q.session_id) : undefined;
  const t = q?.thought_id ? records.thoughts.get(q.thought_id) : undefined;
  const asks = q && <span class="peek"><b>{q.source === 'router' ? 'Where to?' : `${agentName(s?.agent ?? t?.agent)} asks`}</b> {q.source === 'router' ? title(t) : q.prompt}</span>;
  useLayoutEffect(() => {
    // Asked once the host has said what the tab is: its width here is the tab's own, without the wings.
    if (!ui.geometry) return;
    const [l, r] = [left.current?.scrollWidth ?? 0, right.current?.scrollWidth ?? 0];
    const parts = [l, r, !cutout && asks ? Math.min(260, document.querySelector<HTMLElement>('.tab .peek')?.scrollWidth ?? 0) : 0].filter(Boolean);
    const needs = parts.reduce((sum, w) => sum + w, 0) + GAP * Math.max(0, parts.length - 1) + 2 * PAD;
    const own = Number(ui.geometry.width) - 2 * ui.wing;
    const wing = !any ? 0 : cutout ? Math.ceil(Math.max(l, r)) + PAD + CLEAR : Math.max(0, Math.ceil((needs - own) / 2));
    const line = cutout && asks ? LINE : 0;
    if (wing === ui.wing && line === ui.line) return;
    [ui.wing, ui.line] = [wing, line];
    void call('host.notch', { wing, line }).catch(fail);
  });
  if (!g) return null;
  return (
    <>
      <span class="wing l" ref={left}>{g.working > 0 && <><Mark s="working" label="" /><b>{g.working}</b></>}</span>
      {!cutout && (asks || (!any && <Brand />))}
      <span class="wing r" ref={right}>
        {g.needs_you > 0 && <span class="n asks"><Mark s="asks" label="" /><b>{g.needs_you}</b></span>}
        {g.done - ended > 0 && <span class="n"><Mark s="ready" label="" /><b>{g.done - ended}</b></span>}
        {ended > 0 && <span class="n"><Mark s="ended" label="" /><b>{ended}</b></span>}
        {g.failed > 0 && <span class="n fail"><Mark s="failed" label="" /><b>{g.failed}</b></span>}
      </span>
      {cutout && asks && <span class="line">{asks}</span>}
    </>
  );
}

function label() {
  const g = records.glance;
  if (!g) return 'Tasktap';
  const parts = [g.needs_you && `${g.needs_you} need you`, g.working && `${g.working} working`, g.done && `${g.done} new`, g.failed && `${g.failed} failed`];
  return 'Tasktap: ' + (parts.filter(Boolean).join(', ') || 'nothing running');
}

function App() {
  const [, tick] = useState(0);
  onRedraw(() => tick((n) => n + 1));
  const open = ui.mode !== 'closed';
  const shown = open || ui.retracting;
  // The question about the thought just sent from the capture line is asked there, under its field (capture.tsx
  // atComposer): the notch's own view of questions leaves it out while it is, and while the next thought is typed
  // after it (typedPast): it shows once the field is empty again, so the keyboard stays in the field (the review's N1).
  const here = open && ui.view === 'home' ? atComposer() : undefined;
  const questions = openQuestions().filter((q) => q !== here && !(open && ui.view === 'home' && typedPast(q)));
  // Whenever a question is open the notch shows it, never a line that only says one waits.
  const answering = shown && questions.length > 0;
  const g = records.glance;
  // The sheet carries no chrome form; with Lumen on, the light behind the notch takes the motion's colours.
  const motion = lookOf(records.prefs);
  // The effects control, as in the window: at Still the glow is a picture and the marks of work hold a pose (parts.css,
  // notch.css); at Off there is no glow, and the tab's amber count says that a question waits.
  const fx = effectsOf(pref('motion_ambient'));

  useLayoutEffect(() => {
    document.documentElement.dataset.text = pref('text_size');
    document.documentElement.dataset.effects = fx;
    // The sheet's bottom sizes the panel and the black shape that grows out of the housing.
    const sheet = document.getElementById('sheet');
    if (open && sheet) {
      const bottom = Math.ceil(sheet.getBoundingClientRect().bottom);
      if (bottom !== ui.height) {
        ui.height = bottom;
        void call('host.notch', { height: bottom }).catch(fail);
      }
    }
    place(open, ui.height, ui.line);
    requestAnimationFrame(() => body.classList.toggle('open', ui.mode !== 'closed'));
    settleFocus();
  });

  return (
    <div onPointerDown={() => (touch(), ui.mode === 'hover' && (ui.mode = 'pinned'))}>
      <Art glowing={!!g?.needs_you && fx !== 'off'} tint={motion.lumen ? stops(motion.palette, motion.hue) : undefined} />
      <button id="tab" class="tab" type="button" aria-expanded={open} aria-label={label()}
        onClick={() => (open ? fold() : reveal('pinned', questions.length ? 'answer' : 'home'))}>
        {!open && <Glance />}
      </button>
      <section id="sheet" class={`sheet${ui.retracting ? ' retracting' : ''}`} aria-label={answering ? 'Question' : 'Tasktap'} hidden={!shown} inert={!open}>
        {shown && (answering ? <Answer questions={questions} /> : <Home />)}
        {page.error && <p class="error" role="alert">{page.error}</p>}
      </section>
    </div>
  );
}

// Escape folds the notch and the keyboard returns to the app in use; inside a list or a
// reply it only leaves that.
/** A click or a key in the open notch: it is the person's now, and does not fold by itself. */
function touch() {
  ui.touched = true;
  clearTimeout(idle);
}
document.addEventListener('keydown', (e) => {
  if (ui.mode !== 'closed') touch();
  if (e.key !== 'Escape' || ui.mode === 'closed' || e.defaultPrevented) return;
  e.preventDefault();
  if (cap.choosing || (ui.capturing && openQuestions().length)) {
    if (!cap.choosing) ui.capturing = false;
    cap.choosing = false;
    page.focus = openQuestions().length ? FIRST : '#capture-input';
    redraw();
  } else fold();
});
void listen<{ do: keyof typeof host | 'where' | 'power' } & Record<string, number | boolean>>('ui', ({ payload }) => {
  if (payload.do === 'geometry') host.geometry(payload);
  else if (payload.do === 'where') followWhere(payload as unknown as Partial<Where>);
  // Low Power Mode began or ended: the effects follow it, here as in the window.
  else if (payload.do === 'power') (power.low = !!payload.low), redraw();
  else host[payload.do]?.();
});
void call('host.where', {}).then(followWhere, () => {});
void call('host.power', {}).then((low) => ((power.low = !!low), redraw()), () => {});
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', redraw);
// Keys bound by their place are named as the person's keyboard prints them (keys.ts).
watchLayout(() => call('host.layout', {}), redraw);
// A key cap shows only while its keys act: here, only while the notch itself has the keyboard (page.ts markHeld).
watchHeld(true);
render(<App />, body);
// For the debug channel's checks (host/scripts/smoke.sh), which read the records the page holds.
Object.assign(window, { __records: records, __where: where, __speech: { talk, live, cap }, __lines: invite, __look: (l: Partial<typeof look>) => (Object.assign(look, l), redraw(), look) });
void client
  .sub(['glance', 'thoughts', 'questions', 'results', 'sessions', 'projects', 'cards', 'prefs', 'agents', 'terminals', 'dictations'], records)
  .then(() => (recordsIn(), redraw(), call('host.notch', {})))
  .catch((e) => (recordsFailed(e), fail(e)));
