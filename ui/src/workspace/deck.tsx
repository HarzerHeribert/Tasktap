// A workspace on screen, as prototype/workspace-deck.js drew it: the toolbar, then surfaces
// (panes) with tab strips, placed from the layout tree; dividers that resize and balance; tabs
// that drag to another surface or to one's edge; a pane's session state and its question.
import type { AnswerQuestion, Question } from '../../../core/proto/protocol.ts';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '../icons.tsx';
import * as L from './layout.ts';
import {
  LOOSE, agentName, attach, call, closeTab, closeWorkspace, copy, cue, fail, focusTerminal, label, layout, newTerminal,
  open, page, paste, questionOf, readSoon, records, redraw, sessionOf, setLayout, store, textSize, textSizeBy, thoughtOf, ui,
} from './model.ts';
import { engine, engines, flushFits, queueFit } from './terminal.ts';

type Response = AnswerQuestion extends infer A ? (A extends { id: string } ? Omit<A, 'id'> : never) : never;

/** An agent started as a person starts it: its name typed into a new shell of the workspace, where
 *  the core's shim of that name runs it and adopts it as a session (design §4). */
export const startAgent = (project: string, agent: string, into?: string) =>
  newTerminal(project, { into, title: agentName(agent), type: agent });

/** A small menu: `<details class="deck-menu">`, its list placed under its button inside the window. */
export function Menu({ label: name, icon, children, class: extra = '' }: { label: string; icon?: string; children: ComponentChildren; class?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const place = () => {
    const d = ref.current;
    if (!d?.open) return;
    const r = d.querySelector('summary')!.getBoundingClientRect();
    const list = d.querySelector<HTMLElement>('.deck-menu-list')!;
    const w = list.offsetWidth;
    d.style.setProperty('--menu-top', r.bottom + 4 + 'px');
    d.style.setProperty('--menu-left', Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px');
    d.style.setProperty('--menu-height', innerHeight - r.bottom - 12 + 'px');
  };
  return (
    <details class={`deck-menu ${extra}`} ref={ref} onToggle={place} onClick={(e) => (e.target as HTMLElement).closest('.deck-menu-item') && ref.current?.removeAttribute('open')}>
      <summary title={name} aria-label={name}>{icon ? <Icon name={icon} /> : <span aria-hidden="true">⋯</span>}</summary>
      <div class="deck-menu-list">{children}</div>
    </details>
  );
}
// A click outside an open menu, or Escape, closes it.
document.addEventListener('pointerdown', (e) => {
  for (const m of document.querySelectorAll('.deck-menu[open]')) if (!m.contains(e.target as Node)) m.removeAttribute('open');
});
document.addEventListener('keydown', (e) => {
  const m = document.querySelector<HTMLDetailsElement>('.deck-menu[open]');
  if (e.key !== 'Escape' || !m) return;
  e.preventDefault();
  m.open = false;
  m.querySelector('summary')?.focus();
});

const Item = ({ icon, children, onClick }: { icon?: string; children: ComponentChildren; onClick: () => void }) => (
  <button type="button" class="deck-menu-item" onClick={onClick}>{icon && <Icon name={icon} />}<span>{children}</span></button>
);
const Tool = ({ icon, name, onClick }: { icon: string; name: string; onClick: () => void }) => (
  <button type="button" class="deck-icon" title={name} aria-label={name} onClick={onClick}><Icon name={icon} /></button>
);

/** New terminal and the installed agents, as a menu's items. */
function Starts({ project, into }: { project: string; into?: string }) {
  return (
    <>
      <Item icon="terminal" onClick={() => newTerminal(project, { into })}>New terminal</Item>
      {project !== LOOSE && [...records.agents.values()].filter((a) => a.installed).map((a) => (
        <Item icon={a.id} onClick={() => startAgent(project, a.id, into)}>New {agentName(a.id)} session</Item>
      ))}
    </>
  );
}

export function Deck({ project }: { project: string }) {
  const l = layout(project);
  const p = records.projects.get(project);
  const area = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => entry && setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(area.current!);
    return () => observer.disconnect();
  }, []);
  const g = L.geometry(l, size.w, size.h);
  const all = L.panes(l);
  return (
    <div class="deck-project">
      <header class="deck-tools" data-tauri-drag-region>
        <div class="deck-project-name" data-tauri-drag-region>
          <Tool icon="side" name="Toggle sidebar" onClick={() => ((ui.sidebar = !ui.sidebar), redraw())} />
          <Icon name={project === LOOSE ? 'terminal' : 'folder'} />
          <strong title={p?.folder}>{p?.name ?? 'Sign-in terminals'}</strong>
        </div>
        <div class="deck-tools-actions">
          <button type="button" class="deck-new" onClick={() => open({ kind: 'capture' })}>New task</button>
          <Menu label="New session" icon="plus"><Starts project={project} /></Menu>
          <button type="button" class="deck-icon" title={l.focus ? 'Exit focus' : 'Focus surface'} aria-label={l.focus ? 'Exit focus' : 'Focus surface'}
            aria-pressed={l.focus} disabled={!l.tree} onClick={() => setLayout(project, L.toggleFocus(l))}><Icon name="grid" /></button>
          {project !== LOOSE && (
            <Menu label="Workspace actions">
              <Item icon="x" onClick={() => closeWorkspace(project)}>Close workspace</Item>
            </Menu>
          )}
        </div>
      </header>
      <div class="deck-groups" ref={area}>
        {!l.tree && (
          <div class="deck-empty deck-workspace-empty">
            <h2>No open panes</h2>
            <div class="inline"><button type="button" class="btn" onClick={() => newTerminal(project)}><Icon name="terminal" /><span>New terminal</span></button></div>
          </div>
        )}
        {all.map((pane, i) => {
          const rect = g.panes.get(pane.id);
          return <Pane key={pane.id} project={project} pane={pane} index={i} rect={rect} selected={pane.id === l.selected} several={all.length > 1} />;
        })}
        {g.dividers.map((d) => <Divider key={d.id} project={project} d={d} />)}
      </div>
    </div>
  );
}

function Pane({ project, pane, index, rect, selected, several }: {
  project: string; pane: L.Pane; index: number; rect?: L.Rect; selected: boolean; several: boolean;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const id = pane.active;
  const c = id ? cue(id) : null;
  const s = id ? sessionOf(id) : undefined;
  const t = id ? records.terminals.get(id) : undefined;
  // The tabs' terminals live in this surface: moved here, never rebuilt; only the active one shows.
  useLayoutEffect(() => {
    // A terminal that left this pane (to the background, or closed) leaves its surface too.
    for (const el of [...surface.current!.children]) {
      const owner = [...engines].find(([, e]) => e.element === el)?.[0];
      if (owner && !pane.tabs.includes(owner)) el.remove();
    }
    for (const tab of pane.tabs) {
      const e = engine(tab);
      if (e.element.parentElement !== surface.current) surface.current!.append(e.element);
      e.element.hidden = tab !== pane.active;
      if (e.size !== textSize(tab)) e.setSize(textSize(tab));
      if (!e.attached) void attach(tab);
      if (tab === pane.active) queueFit(e);
    }
  });
  const select = () => {
    const l = layout(project);
    if (l.selected !== pane.id) setLayout(project, L.select(l, pane.id));
  };
  // A result shown in the selected pane of the window in use is read.
  const th = thoughtOf(s);
  useEffect(() => void (selected && readSoon(th)), [selected, th?.id, th?.read, th?.status, ui.active]);
  const style = rect ? { left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' } : undefined;
  const status = !!id && (!!s || t?.kind === 'agent');
  return (
    <section class={`deck-group${selected ? ' selected' : ''}${rect && rect.w < 260 ? ' is-narrow' : ''}`} hidden={!rect} style={style}
      data-group-id={pane.id} data-session-state={c?.kind ?? 'none'} aria-label={`Surface ${index + 1}`} tabIndex={-1}
      onPointerDownCapture={select} onFocusIn={select}>
      <div class="deck-pane-bar">
        <div class="deck-tabs" role="tablist" aria-label={`Surface ${index + 1}`}>
          {pane.tabs.map((tab) => <Tab key={tab} project={project} pane={pane} id={tab} />)}
        </div>
        <div class="deck-pane-tools">
          {id && <Tool icon="copy" name="Copy selection / ⌘C" onClick={() => void copy(id)} />}
          {id && <Tool icon="paste" name="Paste / ⌘V" onClick={() => void paste(id)} />}
          {id && <Tool icon="textSmaller" name="Decrease text size / ⌘−" onClick={() => textSizeBy(id, -1)} />}
          {id && <Tool icon="textLarger" name="Increase text size / ⌘+" onClick={() => textSizeBy(id, 1)} />}
          <Tool icon="terminal" name="New terminal" onClick={() => newTerminal(project, { into: pane.id })} />
          <Tool icon="splitRight" name="Split right / ⌘D" onClick={() => newTerminal(project, { into: pane.id, axis: 'x' })} />
          <Tool icon="splitDown" name="Split down / ⇧⌘D" onClick={() => newTerminal(project, { into: pane.id, axis: 'y' })} />
          <Menu label="Tab actions" class="deck-tab-menu">
            <div class="deck-menu-heading">{id ? [s ? agentName(s.agent) : 'Shell', c?.label, `${textSize(id)} pt`].join(' / ') : `Surface ${index + 1}`}</div>
            {id && <Item onClick={() => open({ kind: 'find', id })}>Find in terminal</Item>}
            {id && <Item onClick={() => engines.get(id)?.release()}>Release mouse capture</Item>}
            {id && <Item onClick={() => textSizeBy(id, 1)}>Increase text size / ⌘+</Item>}
            {id && <Item onClick={() => textSizeBy(id, -1)}>Decrease text size / ⌘−</Item>}
            {id && <Item onClick={() => textSizeBy(id, 0)}>Reset text size / ⌘0</Item>}
            {id && several && <Item onClick={() => open({ kind: 'move', project, id })}>Move tab to…</Item>}
            {id && t?.state === 'running' && <Item icon="stop" onClick={() => open({ kind: 'stop', project, id })}>Stop session…</Item>}
            {id && <Item icon="copy" onClick={() => void copy(id)}>Copy selection / ⌘C</Item>}
            {id && <Item icon="paste" onClick={() => void paste(id)}>Paste / ⌘V</Item>}
            <Starts project={project} into={pane.id} />
            <Item icon="splitRight" onClick={() => newTerminal(project, { into: pane.id, axis: 'x' })}>Split right / ⌘D</Item>
            <Item icon="splitDown" onClick={() => newTerminal(project, { into: pane.id, axis: 'y' })}>Split down / ⇧⌘D</Item>
          </Menu>
        </div>
      </div>
      {status && c && (
        <button type="button" class="deck-session-status" title={[c.label, c.activity].filter(Boolean).join(' · ')}
          aria-label={`${c.label}. Focus terminal`} onClick={() => focusTerminal(id!)}>
          <span class="deck-state-dot" aria-hidden="true" />
          <span class="deck-state-symbol" aria-hidden="true">{c.kind === 'permission' ? <Icon name="shield" /> : c.symbol}</span>
          <span class="deck-state-label" aria-live="polite">{c.label}</span>
          <span class="deck-state-activity">{c.activity ?? ''}</span>
        </button>
      )}
      <div class="deck-surface" ref={surface} role="tabpanel">
        {id && !records.terminals.has(id) && <div class="deck-empty"><p role="status">Opening terminal…</p></div>}
      </div>
      <QuestionBar q={questionOf(s)} terminal={id} />
      <svg class="deck-session-ring" aria-hidden="true"><rect pathLength={100} /></svg>
    </section>
  );
}

/** A session's question in its pane, with the notch's answers: Yes and No, the choices, a reply
 *  in the person's own words; one only its terminal can answer sends the keyboard there. */
function QuestionBar({ q, terminal }: { q?: Question; terminal?: string | null }) {
  if (!q) return <div class="deck-question" hidden />;
  const s = q.session_id ? records.sessions.get(q.session_id) : undefined;
  const answer = (r: Response) => void call('question.answer', { id: q.id, ...r } as AnswerQuestion).catch(fail);
  const replying = ui.replying === q.id || q.kind === 'text';
  if (q.reply_via === 'terminal')
    return (
      <div class="deck-question">
        <div><strong>{q.prompt}</strong><span class="hint">Respond in this terminal.</span></div>
        {terminal && <button type="button" class="btn" onClick={() => focusTerminal(terminal)}><Icon name="terminal" /><span>Focus terminal</span></button>}
      </div>
    );
  return (
    <div class="deck-question">
      <div><strong>{q.prompt}</strong><span class="hint">{q.detail || `${agentName(s?.agent)} needs your decision`}</span></div>
      {replying ? (
        <form class="inline deck-reply" onSubmit={(e) => {
          e.preventDefault();
          const text = (e.currentTarget.querySelector('input')?.value ?? '').trim();
          if (text) answer({ kind: 'text', text });
        }}>
          <input aria-label="Reply" placeholder="Answer in your own words…" />
          <button class="primary"><span>Send reply</span></button>
        </form>
      ) : (
        <span class="inline deck-answers">
          {q.kind === 'confirm' && <button type="button" class="primary" onClick={() => answer({ kind: 'affirm' })}><Icon name="check" /><span>Yes</span></button>}
          {q.kind === 'confirm' && <button type="button" class="btn" onClick={() => answer({ kind: 'deny' })}><Icon name="x" /><span>No</span></button>}
          {q.kind === 'choice' && q.choices.map((c, k) => <button type="button" class="btn" onClick={() => answer({ kind: 'choice', choice: k })}><span>{c}</span></button>)}
          <button type="button" class="text-btn" onClick={() => {
            ui.replying = q.id;
            page.focus = '.deck-question .deck-reply input';
            redraw();
          }}><span>Reply</span></button>
        </span>
      )}
    </div>
  );
}

function Tab({ project, pane, id }: { project: string; pane: L.Pane; id: string }) {
  const active = pane.active === id;
  const c = cue(id);
  const name = label(id);
  return (
    <div class={`deck-tab-wrap${active ? ' active' : ''}`}>
      <button type="button" role="tab" class="deck-tab" data-id={id} aria-selected={active} tabIndex={active ? 0 : -1}
        data-status={c.kind} title={`${name} / ${c.label}`}
        aria-description="Drag to reorder or move between surfaces. Right-click or press Shift+F10 for tab actions"
        onPointerDown={(e) => grab(e, project, pane.id, id)}
        onClick={() => {
          if (dragged) return;
          setLayout(project, L.select(layout(project), pane.id, id));
          focusTerminal(id);
        }}
        onContextMenu={(e) => tabMenu(e)}
        onKeyDown={(e) => {
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) tabMenu(e);
          const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
          if (!step) return;
          e.preventDefault();
          const next = pane.tabs[(pane.tabs.indexOf(id) + step + pane.tabs.length) % pane.tabs.length]!;
          setLayout(project, L.select(layout(project), pane.id, next));
          requestAnimationFrame(() => document.querySelector<HTMLElement>(`.deck-tab[data-id="${next}"]`)?.focus());
        }}>
        <Icon name="sessions" /><span>{name}</span>
        <small class="deck-tab-status" aria-label={c.label} title={c.label}>{c.symbol}</small>
      </button>
      <button type="button" class="deck-tab-close" aria-label={`Close ${name} view`} onClick={() => closeTab(project, id)}><Icon name="x" /></button>
    </div>
  );
}

/** Right-click or Shift+F10 on a tab opens its pane's Tab actions. */
function tabMenu(e: Event) {
  e.preventDefault();
  const menu = (e.target as HTMLElement).closest('.deck-group')?.querySelector<HTMLDetailsElement>('.deck-tab-menu');
  if (!menu) return;
  menu.open = true;
  menu.querySelector<HTMLElement>('.deck-menu-item')?.focus();
}

// ——— Dragging a tab (workspace-deck.js: tabDropTarget) ———

let dragged = false;
type Target = { pane: string; before?: string; edge?: L.Edge; box: { left: number; top: number; width: number; height: number } };

function dropTarget(project: string, from: string, x: number, y: number): Target | null {
  for (const el of document.querySelectorAll<HTMLElement>('.deck-group')) {
    if (el.hidden) continue;
    const r = el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const pane = el.dataset.groupId!;
    const bar = el.querySelector('.deck-pane-bar')!.getBoundingClientRect();
    if (y <= bar.bottom) {
      const strip = el.querySelector<HTMLElement>('.deck-tabs')!;
      const bounds = strip.getBoundingClientRect();
      if (x < bounds.left + 24) strip.scrollLeft -= 12;
      else if (x > bounds.right - 24) strip.scrollLeft += 12;
      const wraps = [...strip.querySelectorAll('.deck-tab-wrap')];
      const next = wraps.find((w) => {
        const b = w.getBoundingClientRect();
        return x < b.left + b.width / 2;
      });
      const end = wraps.at(-1)?.getBoundingClientRect().right ?? bounds.left;
      const left = Math.max(bounds.left, Math.min(bounds.right, next?.getBoundingClientRect().left ?? end));
      return { pane, before: next?.querySelector<HTMLElement>('.deck-tab')?.dataset.id, box: { left: left - 1, top: bar.top, width: 3, height: bar.height } };
    }
    const content = { left: r.left, top: bar.bottom, width: r.width, height: r.bottom - bar.bottom };
    const reach = (n: number) => Math.min(72, n * 0.23);
    const near = ([['left', (x - r.left) / reach(r.width)], ['right', (r.right - x) / reach(r.width)], ['top', (y - bar.bottom) / reach(content.height)],
      ['bottom', (r.bottom - y) / reach(content.height)]] as [L.Edge, number][]).sort((a, b) => a[1] - b[1])[0]!;
    const edge = near[1] < 1 ? near[0] : undefined;
    if (edge && pane === from && L.panes(layout(project)).find((p) => p.id === pane)?.tabs.length === 1) return null;
    const box = { ...content };
    if (edge === 'left' || edge === 'right') (box.width /= 2, edge === 'right' && (box.left += box.width));
    if (edge === 'top' || edge === 'bottom') (box.height /= 2, edge === 'bottom' && (box.top += box.height));
    return { pane, edge, box };
  }
  return null;
}

function grab(e: PointerEvent, project: string, from: string, id: string) {
  if (e.button !== 0 || !e.isPrimary) return;
  const tab = e.currentTarget as HTMLElement;
  const start = { x: e.clientX, y: e.clientY };
  let ghost: HTMLElement | null = null;
  let marker: HTMLElement | null = null;
  let target: Target | null = null;
  dragged = false;
  try {
    tab.setPointerCapture(e.pointerId);
  } catch {
    // A pointer the system does not know (a check's synthetic one) is followed without capture.
  }
  const move = (m: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(m.clientX - start.x, m.clientY - start.y) < 6) return;
      dragged = true;
      ghost = document.createElement('div');
      ghost.className = 'deck-drag-ghost';
      ghost.textContent = label(id);
      marker = document.createElement('div');
      marker.className = 'deck-drop-marker';
      document.body.append(marker, ghost);
      document.body.classList.add('deck-dragging');
    }
    ghost.style.left = Math.min(innerWidth - ghost.offsetWidth - 8, m.clientX + 14) + 'px';
    ghost.style.top = Math.min(innerHeight - ghost.offsetHeight - 8, m.clientY + 14) + 'px';
    target = dropTarget(project, from, m.clientX, m.clientY);
    marker!.hidden = !target;
    if (target) {
      for (const [k, v] of Object.entries(target.box)) marker!.style.setProperty(k, v + 'px');
      marker!.classList.toggle('tab-insertion', target.box.width === 3);
    }
  };
  const end = (u: PointerEvent) => {
    tab.removeEventListener('pointermove', move);
    tab.removeEventListener('pointerup', end);
    tab.removeEventListener('pointercancel', end);
    ghost?.remove();
    marker?.remove();
    document.body.classList.remove('deck-dragging');
    if (ghost && target && u.type === 'pointerup') {
      setLayout(project, L.move(layout(project), id, target.pane, { before: target.before, edge: target.edge }));
      focusTerminal(id);
    }
    setTimeout(() => (dragged = false));
  };
  tab.addEventListener('pointermove', move);
  tab.addEventListener('pointerup', end);
  tab.addEventListener('pointercancel', end);
}

/** A divider: drag to resize, double-click to balance, arrows and Home and End from the keyboard. */
function Divider({ project, d }: { project: string; d: ReturnType<typeof L.geometry>['dividers'][number] }) {
  const set = (ratio: number, keep: boolean) => setLayout(project, L.resize(layout(project), d.id, ratio), keep);
  const style = { left: d.rect.x + 'px', top: d.rect.y + 'px', width: d.rect.w + 'px', height: d.rect.h + 'px' };
  return (
    <div class="deck-divider" data-axis={d.axis} role="separator" tabIndex={0} style={style}
      aria-orientation={d.axis === 'x' ? 'vertical' : 'horizontal'} aria-label={d.axis === 'x' ? 'Pane width balance' : 'Pane height balance'}
      aria-valuemin={10} aria-valuemax={90} aria-valuenow={d.ratio}
      onDblClick={() => (set(50, true), flushFits())}
      onKeyDown={(e) => {
        const back = d.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
        const forward = d.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
        if (![back, forward, 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        set(e.key === 'Home' ? 10 : e.key === 'End' ? 90 : d.ratio + (e.key === back ? -2 : 2), true);
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget as HTMLElement;
        const origin = el.parentElement!.getBoundingClientRect();
        el.setPointerCapture(e.pointerId);
        el.classList.add('is-resizing');
        document.body.dataset.deckResize = d.axis;
        const move = (m: PointerEvent) => set(L.ratioAt(d, { x: m.clientX - origin.left, y: m.clientY - origin.top }), false);
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          el.classList.remove('is-resizing');
          delete document.body.dataset.deckResize;
          store(project);
          flushFits();
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      }} />
  );
}
