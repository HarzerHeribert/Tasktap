// A workspace on screen: panes placed from the layout tree, each a tab bar over its terminal, with the question or
// the result its session has in a strip under the terminal; dividers that resize and balance; tabs that drag to
// another pane or to one's edge. Nothing else: no per-pane toolbar, no status strip, no outline. Its menus are the
// system's (menu.ts), and the window's menu and keys carry the rest.
import type { Question, Thought } from '../../../core/proto/protocol.ts';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { next, pending, running, settle, settling, Status, Told } from '../changes.tsx';
import { Ask } from '../question.tsx';
import { Answer, I, Mark, Ring, ago, madeAt, when } from '../ui.tsx';
import { tip } from '../keys.ts';
import { shownPath } from '../system.ts';
import { placed } from '../way.ts';
import * as L from './layout.ts';
import { type Item, popup } from './menu.ts';
import {
  LOOSE, agentName, attach, call, closeTab, copy, cue, details, fail, focusTerminal, keepInBackground, label, layout, newTerminal, open, paste, questionOf,
  readSoon, records, redraw, resultOf, runs, sessionOf, setLayout, store, textSize, textSizeBy, thoughtOf, ui,
} from './model.ts';
import { Preview, focusPreview, openedBy, previewMenu } from './preview.tsx';
import { engine, engines, flushFits, queueFit } from './terminal.ts';

/** An agent started as a person starts it: its name typed into a new shell of the workspace, where
 *  the core's shim of that name runs it and adopts it as a session (design §4). */
export const startAgent = (project: string, agent: string, into?: string) =>
  newTerminal(project, { into, title: agentName(agent), type: agent });

/** New terminal and the installed agents, as a menu's items. */
const starts = (project: string, into?: string): Item[] => [
  { text: 'New Terminal', key: '⌘T', do: () => newTerminal(project, { into }) },
  ...(project === LOOSE ? [] : [...records.agents.values()].filter(runs)
    .map((a) => ({ text: `New ${agentName(a.id)} Session`, do: () => void startAgent(project, a.id, into) }))),
];

/** What a tab offers on a right-click: the pane's commands, from the menu and the keys as well. */
function tabMenu(project: string, id: string): Item[] {
  const t = records.terminals.get(id), shows = records.previews.get(id);
  const several = L.panes(layout(project)).length > 1;
  if (shows) return previewMenu(project, shows, several, () => open({ kind: 'move', project, id }));
  return [
    ...(sessionOf(id) ? [{ text: 'Session Details…', key: '⌘I', do: () => void details(id) }, '-' as const] : []),
    { text: 'Find…', key: '⌘F', do: () => open({ kind: 'find', id }) },
    { text: 'Copy', key: '⌘C', do: () => void copy(id), off: !engines.get(id)?.term.hasSelection() },
    { text: 'Paste', key: '⌘V', do: () => void paste(id) },
    '-',
    { text: 'Larger Text', key: '⌘=', do: () => textSizeBy(id, 1) },
    { text: 'Smaller Text', key: '⌘-', do: () => textSizeBy(id, -1) },
    { text: 'Actual Size', key: '⌘0', do: () => textSizeBy(id, 0) },
    { text: 'Release Mouse Capture', do: () => engines.get(id)?.release() },
    '-',
    ...(several ? [{ text: 'Move Tab To…', do: () => open({ kind: 'move', project, id }) }] : []),
    ...(t?.state === 'running' ? [
      { text: 'Keep Running in Background', do: () => keepInBackground(project, id) },
      { text: 'Stop Session…', do: () => open({ kind: 'stop', project, id }) },
    ] : []),
    { text: 'Close Tab', key: '⌘W', do: () => closeTab(project, id) },
  ];
}

export function Deck({ project }: { project: string }) {
  const l = layout(project);
  const area = useRef<HTMLDivElement>(null);
  // Measured before a pane is drawn: a terminal is opened at the size its pane has, and a pane with no size yet
  // would be measured as no room at all (terminal.ts FLOOR).
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const take = (w: number, h: number) => setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    take(area.current!.clientWidth, area.current!.clientHeight);
    const observer = new ResizeObserver(([entry]) => entry && take(entry.contentRect.width, entry.contentRect.height));
    observer.observe(area.current!);
    return () => observer.disconnect();
  }, []);
  const g = L.geometry(l, size?.w ?? 0, size?.h ?? 0);
  const all = size ? L.panes(l) : [];
  return (
    <div class="deck" ref={area}>
      {!l.tree && (
        <div class="deck-empty">
          <Answer k="⌘T" label="New terminal" onClick={() => newTerminal(project)} />
        </div>
      )}
      {all.map((pane, i) => <Pane key={pane.id} project={project} pane={pane} index={i} rect={g.panes.get(pane.id)} focused={pane.id === l.selected || all.length === 1} />)}
      {g.dividers.map((d) => <Divider key={d.id} project={project} d={d} />)}
    </div>
  );
}

function Pane({ project, pane, index, rect, focused }: { project: string; pane: L.Pane; index: number; rect?: L.Rect; focused: boolean }) {
  const surface = useRef<HTMLDivElement>(null);
  const id = pane.active;
  // A tab is a terminal or a preview (preview.tsx): a preview is drawn in the terminals' place while it is in front.
  const shows = id ? records.previews.get(id) : undefined;
  const s = id ? sessionOf(id) : undefined;
  // The tabs' terminals live in this surface: moved here, never rebuilt; only the active one shows.
  useLayoutEffect(() => {
    // A terminal that left this pane (to the background, or closed) leaves its surface too.
    for (const el of [...surface.current!.children]) {
      const owner = [...engines].find(([, e]) => e.element === el)?.[0];
      if (owner && !pane.tabs.includes(owner)) el.remove();
    }
    for (const tab of pane.tabs) {
      if (records.previews.has(tab)) continue;
      const e = engine(tab);
      if (e.element.parentElement !== surface.current) surface.current!.append(e.element);
      e.element.hidden = tab !== pane.active;
      if (e.size !== textSize(tab)) e.setSize(textSize(tab));
      if (!e.attached) void attach(tab);
      if (tab === pane.active) queueFit(e);
    }
  });
  // The tab in front is in view, however many tabs the pane has.
  useLayoutEffect(() => surface.current?.parentElement?.querySelector('.tabw.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }), [id]);
  const select = () => {
    const l = layout(project);
    if (l.selected !== pane.id) setLayout(project, L.select(l, pane.id));
  };
  // A result shown in the selected pane of the window in use is read.
  const th = thoughtOf(s);
  useEffect(() => void (focused && readSoon(th)), [focused, th?.id, th?.read, th?.status, ui.active]);
  const style = rect ? { left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' } : undefined;
  const q = questionOf(s);
  const full = id ? ui.full.get(id) : undefined, refused = id ? ui.refused.get(id) : undefined;
  return (
    <section class={`pane${focused ? ' focus' : ''}`} hidden={!rect} style={style} data-pane={pane.id} aria-label={`Pane ${index + 1}`}
      onPointerDownCapture={select} onFocusIn={select}>
      <div class="tabs" role="tablist" aria-label={`Pane ${index + 1}`}>
        {pane.tabs.map((tab) => <Tab key={tab} project={project} pane={pane} id={tab} />)}
        <button type="button" class="tab-add ib" title={tip('New terminal', '⌘T')} aria-label="New terminal"
          onClick={() => newTerminal(project, { into: pane.id })} onContextMenu={(e) => popup(e, starts(project, pane.id))}>
          <I n="plus" />
        </button>
      </div>
      <div class="surface" ref={surface} role="tabpanel" hidden={!!shows} />
      {shows && <Preview key={shows.id} p={shows} project={project} select={select} />}
      {refused && id ? (
        // What the core would not show beside this terminal: said here, in its words, with the way it can be opened.
        <div class="strip" role="status" data-refused={id}>
          <p class="meta"><b>No preview</b></p>
          <p class="said">{refused.said}</p>
          <div class="qa">
            <button type="button" class="btn" onClick={() => (ui.refused.delete(id), redraw(), void call('host.open', { target: refused.target, cwd: refused.cwd }).catch(fail))}>Open It Instead</button>
            <button type="button" class="btn" onClick={() => (ui.refused.delete(id), redraw())}>Dismiss</button>
          </div>
        </div>
      ) : full && id ? (
        // One more view than the core allows of a terminal: said where it would have opened.
        <div class="strip" role="status" data-full={id}>
          <p class="meta"><b>Not shown here</b></p>
          <p class="qp">{full} Close it in one of them, then try again.</p>
          <div class="qa"><button type="button" class="btn" onClick={() => void attach(id, true)}>Try again</button></div>
        </div>
      ) : q ? <QuestionStrip q={q} terminal={id} /> : pending(th) ? <ResultStrip t={th} /> : null}
    </section>
  );
}

/** A question under its terminal: who asks and when, the question in full, the answers. Its keys act while the strip
 *  has the keyboard; Escape gives it back to the terminal. */
function QuestionStrip({ q, terminal }: { q: Question; terminal?: string | null }) {
  const s = q.session_id ? records.sessions.get(q.session_id) : undefined;
  const who = agentName(s?.agent);
  return (
    <div class="strip attn" onKeyDown={(e) => e.key === 'Escape' && terminal && (e.preventDefault(), focusTerminal(terminal))}>
      <p class="meta"><b>{q.reply_via === 'terminal' ? `${who} asks in its terminal` : q.source === 'permission' ? `${who} asks permission` : `${who} asks`}</b>
        <time>{ago(madeAt(q.id))}</time></p>
      <Ask q={q} size="pane" who={who} terminal={terminal ? () => focusTerminal(terminal) : undefined} />
    </div>
  );
}

/** A result with changes pending, under the terminal that made them: its diffstat and summary, then Keep, Discard and
 *  Review changes. */
export function ResultStrip({ t }: { t: Thought & { workdir: NonNullable<Thought['workdir']> } }) {
  const r = resultOf(t);
  const s = settling.get(t.id);
  const busy = s?.step === 'stopping' || s?.step === 'settling';
  const main = next(t);
  const discard = () => open({ kind: 'settle', thought: t.id, keep: false });
  const keep = () => (!main.keep ? discard() : running(t) ? open({ kind: 'settle', thought: t.id, keep: true }) : void settle(t, true));
  const review = () => open({ kind: 'review', thought: t.id });
  return (
    <div class="strip" data-result={t.id} tabIndex={-1} onKeyDown={(e) => {
      if ((e.target as HTMLElement).matches('input') || e.metaKey || e.ctrlKey || e.altKey || busy) return;
      const k = e.key.toLowerCase();
      if (k === 'enter' && !(e.target as HTMLElement).closest('button')) keep();
      else if (k === 'd' && main.keep) discard();
      else if (k === 'r' && main.keep) review();
      else return;
      e.preventDefault();
    }}>
      <p class="meta"><b>Result</b><time>{when(t.updated)}</time><span class="end"><Status t={t} /></span></p>
      {r?.summary && <p class="qp">{r.summary}</p>}
      <Told t={t} />
      {!busy && (
        <div class="qa">
          <Answer k="↩" label={main.label} primary onClick={keep} />
          {main.keep && <Answer k="D" label="Discard" onClick={discard} />}
          {main.keep && <Answer k="R" label="Review changes" onClick={review} />}
        </div>
      )}
    </div>
  );
}

function Tab({ project, pane, id }: { project: string; pane: L.Pane; id: string }) {
  const active = pane.active === id;
  // A preview's tab says what it shows, and by its mark who opened it: the agent's own mark when the agent did.
  const shows = records.previews.get(id);
  const c = shows ? { s: 'shell' as const, words: [shows.kind === 'web' ? shows.target : shownPath(shows.target), openedBy(shows)].filter(Boolean).join('\n') } : cue(id);
  const name = shows ? shows.title : label(id);
  // How the session's thought found its way here, said quietly with its name.
  const th = thoughtOf(sessionOf(id)), how = th && placed(th, agentName);
  return (
    <div class={`tabw${active ? ' on' : ''}${c.s === 'shell' && !shows ? ' shl' : ''}`}>
      <button type="button" role="tab" class="tab" data-id={id} aria-selected={active} tabIndex={active ? 0 : -1}
        title={[name, c.words, how].filter(Boolean).join('\n')} aria-description="Drag to move it to another pane. Right-click for its commands"
        onPointerDown={(e) => grab(e, project, pane.id, id)}
        onClick={() => {
          if (dragged) return;
          setLayout(project, L.select(layout(project), pane.id, id));
          if (shows) focusPreview(id);
          else focusTerminal(id);
        }}
        onContextMenu={(e) => popup(e, tabMenu(project, id))}
        onKeyDown={(e) => {
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) return void popup(e, tabMenu(project, id));
          const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
          if (!step) return;
          e.preventDefault();
          const next = pane.tabs[(pane.tabs.indexOf(id) + step + pane.tabs.length) % pane.tabs.length]!;
          setLayout(project, L.select(layout(project), pane.id, next));
          requestAnimationFrame(() => document.querySelector<HTMLElement>(`.tab[data-id="${next}"]`)?.focus());
        }}>
        {shows ? <i class="st by" data-by={shows.by} role="img" aria-label={openedBy(shows) || 'Preview'}>{shows.by !== 'agent' ? <I n="view" /> : sessionOf(shows.terminal_id) ? <Ring agent={sessionOf(shows.terminal_id)!.agent} s="" /> : <I n="term" />}</i>
          : <Mark s={c.s} label={c.words} />}<span class="lbl">{name}</span>
      </button>
      <button type="button" class="x" title={tip('Close tab', '⌘W')} aria-label={`Close ${name}`} onClick={() => closeTab(project, id)}><I n="x" /></button>
    </div>
  );
}

// ——— Dragging a tab ———

let dragged = false;
type Target = { pane: string; before?: string; edge?: L.Edge; box: { left: number; top: number; width: number; height: number } };

function dropTarget(project: string, from: string, x: number, y: number): Target | null {
  for (const el of document.querySelectorAll<HTMLElement>('.pane')) {
    if (el.hidden) continue;
    const r = el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const pane = el.dataset.pane!;
    const strip = el.querySelector<HTMLElement>('.tabs')!;
    const bar = strip.getBoundingClientRect();
    if (y <= bar.bottom) {
      if (x < bar.left + 24) strip.scrollLeft -= 12;
      else if (x > bar.right - 24) strip.scrollLeft += 12;
      const wraps = [...strip.querySelectorAll('.tabw')];
      const next = wraps.find((w) => {
        const b = w.getBoundingClientRect();
        return x < b.left + b.width / 2;
      });
      const end = wraps.at(-1)?.getBoundingClientRect().right ?? bar.left;
      const left = Math.max(bar.left, Math.min(bar.right, next?.getBoundingClientRect().left ?? end));
      return { pane, before: next?.querySelector<HTMLElement>('.tab')?.dataset.id, box: { left: left - 1, top: bar.top, width: 2, height: bar.height } };
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
      ghost.className = 'drag-ghost';
      ghost.textContent = label(id);
      marker = document.createElement('div');
      marker.className = 'drop';
      document.body.append(marker, ghost);
      document.body.classList.add('dragging');
    }
    ghost.style.left = Math.min(innerWidth - ghost.offsetWidth - 8, m.clientX + 14) + 'px';
    ghost.style.top = Math.min(innerHeight - ghost.offsetHeight - 8, m.clientY + 14) + 'px';
    target = dropTarget(project, from, m.clientX, m.clientY);
    marker!.hidden = !target;
    if (target) {
      for (const [k, v] of Object.entries(target.box)) marker!.style.setProperty(k, v + 'px');
      marker!.classList.toggle('at-tab', target.box.width === 2);
    }
  };
  const end = (u: PointerEvent) => {
    tab.removeEventListener('pointermove', move);
    tab.removeEventListener('pointerup', end);
    tab.removeEventListener('pointercancel', end);
    ghost?.remove();
    marker?.remove();
    document.body.classList.remove('dragging');
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
    <div class="divider" data-axis={d.axis} role="separator" tabIndex={0} style={style}
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
        el.classList.add('held');
        document.body.dataset.resize = d.axis;
        const move = (m: PointerEvent) => set(L.ratioAt(d, { x: m.clientX - origin.left, y: m.clientY - origin.top }), false);
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          el.classList.remove('held');
          delete document.body.dataset.resize;
          store(project);
          flushFits();
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      }} />
  );
}
