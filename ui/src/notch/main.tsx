// The notch page: glance when collapsed, capture and answer when open. It holds only what is
// on screen; every record comes from the core, and the host places the panel.
import '../../../prototype/style.css';
import '../../../prototype/appearance.css';
import '../../../prototype/workspace-activity.css';
// The icon and label rows of the answer card's context (`.decision-context>span`), linked before
// decision.css as 1.2 linked it.
import '../../../prototype/content-layout.css';
import '../../../prototype/decision.css';
import './notch.css';
// The capture line it shares with the workspace, after the styles it refines.
import '../capture.css';
import { listen } from '@tauri-apps/api/event';
import { render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Answer } from './answer.tsx';
import { Art, look, place } from './art.tsx';
import { Home } from './home.tsx';
import { cap } from '../capture.tsx';
import { lookOf } from '../motion/motion.tsx';
import { stops } from '../motion/palette.ts';
import { call, client, fail, onRedraw, openQuestions, page, records, redraw, settleFocus, ui } from './model.ts';
import { fold, reveal } from './panel.ts';

const body = document.body;

const host = {
  geometry(m: Record<string, number | boolean>) {
    ui.geometry = m;
    body.classList.toggle('notch-compact', m.compact === true);
    const vars: Record<string, unknown> = {
      '--native-tab-width': m.width, '--camera-height': m.height, '--camera-offset': m.offset,
      '--native-surface-width': m.surfaceWidth, '--surface-offset': m.surfaceOffset, '--notch-pixel': m.pixel,
      '--cutout-corner': m.corner, '--available-panel-height': m.available,
    };
    for (const [k, v] of Object.entries(vars)) if (typeof v === 'number') document.documentElement.style.setProperty(k, v + 'px');
    redraw();
  },
  'hover-enter'() {
    ui.inside = true;
    if (ui.mode !== 'closed') return;
    clearTimeout(ui.timer);
    ui.timer = window.setTimeout(() => ui.inside && reveal('hover', openQuestions().length ? 'answer' : 'home'), 170);
  },
  'hover-exit'() {
    ui.inside = false;
    if (ui.mode !== 'hover' || document.hasFocus()) return;
    clearTimeout(ui.timer);
    ui.timer = window.setTimeout(() => !ui.inside && ui.mode === 'hover' && fold(), 320);
  },
  capture() {
    // Straight to the field; with a question open, under it.
    ui.capturing = openQuestions().length > 0;
    reveal('pinned', ui.capturing ? 'answer' : 'home', '#guide-input');
  },
  answer() {
    if (openQuestions().length) reveal('pinned', 'answer', '#notch .decision-btn, #notch #comment');
    else reveal('pinned', 'home', '#guide-input');
  },
};

/** Questions that were open at the last change: a new one opens the notch by itself. */
const known = new Set<string>();
records.onchange = () => {
  const open = openQuestions();
  const fresh = open.some((q) => !known.has(q.id));
  known.clear();
  for (const q of open) known.add(q.id);
  // A notch the last question opened by itself is still its own to fold: a new question that
  // arrives while that fold is pending keeps it open.
  if (fresh && (ui.mode === 'closed' || ui.auto)) {
    reveal('pinned', 'answer');
    ui.auto = true;
  } else if (fresh && ui.view === 'home') {
    // Open on the capture line: the question comes first and the line moves under it, the
    // person's typing and its focus with it.
    ui.view = 'answer';
    ui.capturing = true;
    if (document.activeElement?.id === 'guide-input') page.focus = '#guide-input';
  } else if (!open.length && ui.view === 'answer' && ui.mode !== 'closed') {
    // One pending fold however many changes arrive meanwhile, so a new question can cancel it.
    if (ui.auto) {
      clearTimeout(ui.timer);
      ui.timer = window.setTimeout(fold, 500);
    }
    else ui.view = 'home';
  }
  redraw();
};

/** The glance on the collapsed tab: working on the left, needs you and done on the right. */
function Wings() {
  const g = records.glance;
  const failed = g?.failed ?? 0;
  const left = useRef<HTMLSpanElement>(null);
  const right = useRef<HTMLSpanElement>(null);
  const any = !!g && g.working + g.needs_you + g.done + failed > 0;
  useLayoutEffect(() => {
    const wing = any ? Math.ceil(Math.max(left.current?.scrollWidth ?? 0, right.current?.scrollWidth ?? 0)) + 4 : 0;
    if (wing === ui.wing) return;
    ui.wing = wing;
    void call('host.notch', { wing }).catch(fail);
  });
  if (!g) return null;
  return (
    <>
      <span class="glance-wing glance-left" ref={left} aria-hidden="true">
        {g.working > 0 && <span class="glance-count" data-status="working"><i />{g.working}</span>}
      </span>
      <span class="glance-wing glance-right" ref={right} aria-hidden="true">
        {g.needs_you > 0 && <span class="glance-count" data-status="needs_you"><i />{g.needs_you}</span>}
        {g.done > 0 && <span class="glance-count" data-status="done"><i />{g.done}</span>}
        {failed > 0 && <span class="glance-count" data-status="failed"><i />{failed}</span>}
      </span>
    </>
  );
}

function label() {
  const g = records.glance;
  if (!g) return 'Tasktap';
  const parts = [g.needs_you && `${g.needs_you} need you`, g.working && `${g.working} working`, g.done && `${g.done} done`,
    g.failed && `${g.failed} failed`];
  return 'Tasktap: ' + (parts.filter(Boolean).join(', ') || 'nothing running');
}

function App() {
  const [, tick] = useState(0);
  onRedraw(() => tick((n) => n + 1));
  const open = ui.mode !== 'closed';
  const shown = open || ui.retracting;
  const questions = openQuestions();
  // Whenever a question is open the notch shows it, never a line that only says one waits.
  const answering = shown && questions.length > 0;
  const g = records.glance;
  // The sheet carries no chrome form; with Lumen on, the light behind the notch takes the motion's colours.
  const motion = lookOf(records.prefs);

  useLayoutEffect(() => {
    // The sheet's bottom sizes the panel and the black silhouette that grows out of the housing.
    const sheet = document.querySelector<HTMLElement>(answering ? '#notch' : '#notch-home');
    if (open && sheet) {
      const bottom = Math.ceil(sheet.getBoundingClientRect().bottom);
      if (bottom !== ui.height) {
        ui.height = bottom;
        void call('host.notch', { height: bottom }).catch(fail);
      }
    }
    place(open, ui.height);
    requestAnimationFrame(() => body.classList.toggle('notch-open', ui.mode !== 'closed'));
    settleFocus();
  });

  return (
    <div onPointerDown={() => ui.mode === 'hover' && (ui.mode = 'pinned')}>
      <Art glowing={!!g?.needs_you} tint={motion.lumen ? stops(motion.palette, motion.hue) : undefined} />
      <div class="island" id="island">
        <button id="islandToggle" type="button" aria-expanded={open} aria-label={label()}
          onClick={() => (open ? fold() : reveal('pinned', questions.length ? 'answer' : 'home'))}>
          {!open && <Wings />}
        </button>
      </div>
      <section id="notch-home" aria-label="Tasktap notch" hidden={!shown || answering} class={ui.retracting ? 'retracting' : ''}
        inert={!open}>
        <div class="home-content">{shown && !answering && <Home />}</div>
      </section>
      <dialog id="notch" aria-label="Question" open={answering} class={ui.retracting ? 'retracting' : ''}>
        {answering && <Answer questions={questions} />}
      </dialog>
    </div>
  );
}

// Escape folds the notch and the keyboard returns to the app in use; inside a list or a
// reply it only leaves that.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || ui.mode === 'closed') return;
  e.preventDefault();
  if (cap.choosing || ui.replying || (ui.capturing && openQuestions().length)) {
    if (!cap.choosing) ui.capturing = false;
    cap.choosing = ui.replying = false;
    page.focus = openQuestions().length ? '#notch .decision-btn, #notch #comment' : '#guide-input';
    redraw();
  } else fold();
});
void listen<{ do: keyof typeof host } & Record<string, number | boolean>>('ui', ({ payload }) => {
  if (payload.do === 'geometry') host.geometry(payload);
  else host[payload.do]?.();
});
render(<App />, document.body);
// For the debug channel's checks (host/scripts/smoke.sh), which read the records the page holds.
Object.assign(window, { __records: records, __look: (l: Partial<typeof look>) => (Object.assign(look, l), redraw(), look) });
void client
  .sub(['glance', 'thoughts', 'questions', 'results', 'sessions', 'projects', 'prefs', 'agents'], records)
  .then(() => call('host.notch', {}))
  .catch(fail);
