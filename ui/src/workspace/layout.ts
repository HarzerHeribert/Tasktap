// A workspace's arrangement: surfaces (panes) holding tabs, in a tree of splits. This is the
// tree the page stores in the project's `layouts` record and reads back; the core never reads
// it. Every function is pure: it returns a new layout and leaves its argument as it was.

/** A surface: its tabs (terminal ids) and the one shown. */
export type Pane = { id: string; tabs: string[]; active: string | null };
/** Two parts side by side (`x`) or one above the other (`y`); `ratio` is the first's share in percent. */
export type Split = { id: string; axis: 'x' | 'y'; ratio: number; first: Node; second: Node };
export type Node = Pane | Split;
export type Layout = {
  tree: Node | null;
  /** The pane the keyboard and the toolbar act on. */
  selected: string | null;
  /** Only the selected pane is shown, at full size. */
  focus: boolean;
  /** Terminals the person closed with Keep running in background: listed in the sidebar, in no tab. */
  background: string[];
  /** Text size per terminal, in points, where the person changed it. */
  sizes: Record<string, number>;
};
export type Edge = 'left' | 'right' | 'top' | 'bottom';
export type Rect = { x: number; y: number; w: number; h: number };

export const MIN_RATIO = 10;
/** The seam between the parts of a split. */
export const SEAM = 1;
export const MAX_RATIO = 90;
export const isPane = (n: Node): n is Pane => 'tabs' in n;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
let counter = 0;
/** A fresh id for a pane or a split; tests pass their own. */
export const freshId = () => `p${Date.now().toString(36)}${(++counter).toString(36)}`;

export const empty = (): Layout => ({ tree: null, selected: null, focus: false, background: [], sizes: {} });

/** The panes in reading order: left to right, top to bottom. */
export function panes(l: Layout): Pane[] {
  const out: Pane[] = [];
  const walk = (n: Node | null) => {
    if (!n) return;
    if (isPane(n)) out.push(n);
    else (walk(n.first), walk(n.second));
  };
  walk(l.tree);
  return out;
}

export const paneOf = (l: Layout, tab: string) => panes(l).find((p) => p.tabs.includes(tab));
export const selectedPane = (l: Layout) => panes(l).find((p) => p.id === l.selected) ?? panes(l)[0];
export const tabs = (l: Layout) => panes(l).flatMap((p) => p.tabs);

/** Whatever was stored, as a layout this page can use: unknown shapes are dropped, a tab is in
 *  one pane only, empty panes go and their splits collapse, ratios stay in bounds. */
export function normalize(raw: unknown): Layout {
  const l = empty();
  if (!raw || typeof raw !== 'object') return l;
  const r = raw as Record<string, unknown>;
  const seen = new Set<string>();
  const ids = new Set<string>();
  const id = (v: unknown) => {
    const s = typeof v === 'string' && v && !ids.has(v) ? v : freshId();
    ids.add(s);
    return s;
  };
  const node = (v: unknown, depth: number): Node | null => {
    if (!v || typeof v !== 'object' || depth > 64) return null;
    const n = v as Record<string, unknown>;
    if (Array.isArray(n.tabs)) {
      const tabs: string[] = [];
      for (const t of n.tabs) if (typeof t === 'string' && t && !seen.has(t)) (seen.add(t), tabs.push(t));
      if (!tabs.length) return null;
      const active = typeof n.active === 'string' && tabs.includes(n.active) ? n.active : tabs[0]!;
      return { id: id(n.id), tabs, active };
    }
    const first = node(n.first, depth + 1);
    const second = node(n.second, depth + 1);
    if (!first || !second) return first ?? second;
    const ratio = typeof n.ratio === 'number' && Number.isFinite(n.ratio) ? clamp(n.ratio, MIN_RATIO, MAX_RATIO) : 50;
    return { id: id(n.id), axis: n.axis === 'y' ? 'y' : 'x', ratio, first, second };
  };
  l.tree = node(r.tree, 0);
  const all = panes(l);
  l.selected = all.some((p) => p.id === r.selected) ? (r.selected as string) : (all[0]?.id ?? null);
  l.focus = r.focus === true && !!l.tree;
  l.background = Array.isArray(r.background)
    ? [...new Set(r.background.filter((t): t is string => typeof t === 'string' && !seen.has(t)))]
    : [];
  if (r.sizes && typeof r.sizes === 'object')
    for (const [k, v] of Object.entries(r.sizes)) if (typeof v === 'number' && v >= 8 && v <= 40) l.sizes[k] = Math.round(v);
  return l;
}

/** A copy to change, and the pane with `id` in it. */
function edit(l: Layout): Layout {
  return structuredClone(l);
}
function findPane(l: Layout, id: string | null | undefined) {
  return panes(l).find((p) => p.id === id);
}
/** Replaces `target` in the tree with `by`. */
function replace(l: Layout, target: Node, by: Node | null) {
  if (l.tree === target) return void (l.tree = by);
  const walk = (n: Node): boolean => {
    if (isPane(n)) return false;
    if (n.first === target || n.second === target) {
      const sibling = n.first === target ? n.second : n.first;
      if (by) n[n.first === target ? 'first' : 'second'] = by;
      else replace(l, n, sibling);
      return true;
    }
    return walk(n.first) || walk(n.second);
  };
  if (l.tree) walk(l.tree);
}

/** Shows a tab: where it already is, else in pane `into` or the selected one (a new pane when
 *  there is none). The pane becomes selected; a backgrounded terminal is no longer listed so. */
export function open(l: Layout, tab: string, into?: string, id = freshId): Layout {
  const out = edit(l);
  out.background = out.background.filter((t) => t !== tab);
  let pane = paneOf(out, tab) ?? findPane(out, into) ?? selectedPane(out);
  if (!pane) out.tree = pane = { id: id(), tabs: [], active: null };
  if (!pane.tabs.includes(tab)) pane.tabs.push(tab);
  pane.active = tab;
  out.selected = pane.id;
  if (out.focus) out.focus = true;
  return out;
}

/** Splits pane `of` along `axis`; the new pane, holding `tab`, comes after it (right or below)
 *  or before it, and is selected. Focus mode ends so both can be seen. */
export function split(l: Layout, of: string, axis: 'x' | 'y', tab: string, before = false, id = freshId): Layout {
  const out = edit(l);
  const target = findPane(out, of);
  if (!target) return open(l, tab, undefined, id);
  // A tab moved to an edge of its own pane leaves it first.
  const from = paneOf(out, tab);
  if (from) {
    from.tabs = from.tabs.filter((t) => t !== tab);
    if (from.active === tab) from.active = from.tabs[0] ?? null;
  }
  const pane: Pane = { id: id(), tabs: [tab], active: tab };
  const branch: Split = { id: id(), axis, ratio: 50, first: before ? pane : target, second: before ? target : pane };
  replace(out, target, branch);
  if (from && !from.tabs.length) replace(out, from, null);
  out.background = out.background.filter((t) => t !== tab);
  out.selected = pane.id;
  out.focus = false;
  return out;
}

/** Removes a tab. Its pane shows the tab next to it; a pane left empty goes, its split
 *  collapsing into the other side, whose nearest pane is selected if it was the selected one. */
export function close(l: Layout, tab: string): Layout {
  const out = edit(l);
  out.background = out.background.filter((t) => t !== tab);
  const pane = paneOf(out, tab);
  if (!pane) return out;
  const at = pane.tabs.indexOf(tab);
  pane.tabs.splice(at, 1);
  if (pane.active === tab) pane.active = pane.tabs[Math.min(at, pane.tabs.length - 1)] ?? null;
  if (pane.tabs.length) return out;
  const order = panes(out);
  const index = order.indexOf(pane);
  replace(out, pane, null);
  if (out.selected === pane.id) out.selected = (order[index + 1] ?? order[index - 1])?.id ?? null;
  if (!out.tree) out.focus = false;
  return out;
}

/** Closes a terminal's tab and lists it under its workspace as running in the background. */
export function background(l: Layout, tab: string): Layout {
  const out = close(l, tab);
  out.background.push(tab);
  return out;
}

/** Moves a tab into pane `to`: before tab `before`, at the end, or into a new pane at one of
 *  its edges. Moving the last tab out of a pane removes that pane. */
export function move(l: Layout, tab: string, to: string, at: { before?: string; edge?: Edge } = {}, id = freshId): Layout {
  const from = paneOf(l, tab);
  const target = findPane(l, to);
  if (!from || !target) return l;
  if (at.edge) {
    if (from === target && from.tabs.length === 1) return l;
    return split(l, to, at.edge === 'left' || at.edge === 'right' ? 'x' : 'y', tab, at.edge === 'left' || at.edge === 'top', id);
  }
  if (at.before === tab) return l;
  const out = edit(l);
  const src = findPane(out, from.id)!;
  const dst = findPane(out, to)!;
  const index = src.tabs.indexOf(tab);
  src.tabs.splice(index, 1);
  if (src.active === tab) src.active = src.tabs[Math.min(index, src.tabs.length - 1)] ?? null;
  const before = at.before ? dst.tabs.indexOf(at.before) : -1;
  dst.tabs.splice(before < 0 ? dst.tabs.length : before, 0, tab);
  dst.active = tab;
  out.selected = dst.id;
  if (!src.tabs.length) replace(out, src, null);
  return out;
}

/** Sets a split's ratio, kept between 10 and 90 percent. 50 balances it. */
export function resize(l: Layout, split: string, ratio: number): Layout {
  const out = edit(l);
  const walk = (n: Node | null): void => {
    if (!n || isPane(n)) return;
    if (n.id === split) n.ratio = Math.round(clamp(ratio, MIN_RATIO, MAX_RATIO));
    walk(n.first);
    walk(n.second);
  };
  walk(out.tree);
  return out;
}

export function select(l: Layout, pane: string, tab?: string): Layout {
  const p = findPane(l, pane);
  if (!p || (l.selected === pane && (!tab || p.active === tab))) return l;
  const out = edit(l);
  out.selected = pane;
  if (tab && p.tabs.includes(tab)) findPane(out, pane)!.active = tab;
  return out;
}

export function toggleFocus(l: Layout): Layout {
  return { ...l, focus: !l.focus && !!l.tree };
}

export function textSize(l: Layout, tab: string, size: number | null): Layout {
  const sizes = { ...l.sizes };
  if (size === null) delete sizes[tab];
  else sizes[tab] = clamp(Math.round(size), 8, 40);
  return { ...l, sizes };
}

/** Keeps the layout in step with the terminals the core has: a running terminal neither in a
 *  tab nor in the background gets a place in the selected pane (a run the core started, say),
 *  and terminals the core no longer knows leave the tabs, the background and the sizes. */
export function reconcile(l: Layout, running: string[], known: Set<string>, id = freshId): Layout {
  let out = l;
  for (const t of tabs(out)) if (!known.has(t)) out = close(out, t);
  if (out.background.some((t) => !known.has(t)) || Object.keys(out.sizes).some((t) => !known.has(t))) {
    out = { ...out, background: out.background.filter((t) => known.has(t)), sizes: Object.fromEntries(Object.entries(out.sizes).filter(([t]) => known.has(t))) };
  }
  const placed = new Set([...tabs(out), ...out.background]);
  for (const t of running) if (!placed.has(t)) out = open(out, t, undefined, id);
  return out;
}

/** Where each pane and divider goes in an area `w` by `h`: a 1 px seam between the
 *  parts of a split, and a 7 px divider target over it. In focus mode only the selected
 *  pane shows, filling the area. */
export function geometry(l: Layout, w: number, h: number) {
  const out = { panes: new Map<string, Rect>(), dividers: [] as { id: string; axis: 'x' | 'y'; ratio: number; rect: Rect; area: Rect }[] };
  if (l.focus) {
    const p = selectedPane(l);
    if (p) out.panes.set(p.id, { x: 0, y: 0, w, h });
    return out;
  }
  const walk = (n: Node, x: number, y: number, w: number, h: number) => {
    if (isPane(n)) return void out.panes.set(n.id, { x, y, w: Math.max(0, w), h: Math.max(0, h) });
    const across = n.axis === 'x' ? w : h;
    const gap = Math.min(SEAM, across);
    const room = Math.max(0, across - gap);
    const first = (room * n.ratio) / 100;
    const hit = Math.min(7, across);
    const over = (hit - gap) / 2;
    const area = { x, y, w, h };
    if (n.axis === 'x') {
      out.dividers.push({ id: n.id, axis: 'x', ratio: n.ratio, rect: { x: x + first - over, y, w: hit, h }, area });
      walk(n.first, x, y, first, h);
      walk(n.second, x + first + gap, y, room - first, h);
    } else {
      out.dividers.push({ id: n.id, axis: 'y', ratio: n.ratio, rect: { x, y: y + first - over, w, h: hit }, area });
      walk(n.first, x, y, w, first);
      walk(n.second, x, y + first + gap, w, room - first);
    }
  };
  if (l.tree) walk(l.tree, 0, 0, w, h);
  return out;
}

/** The ratio a divider dragged to `at` (a pointer position inside the layout area) gives its split. */
export function ratioAt(d: { axis: 'x' | 'y'; area: Rect }, at: { x: number; y: number }) {
  const across = d.axis === 'x' ? d.area.w : d.area.h;
  const gap = Math.min(SEAM, across);
  const pos = d.axis === 'x' ? at.x - d.area.x : at.y - d.area.y;
  return ((pos - gap / 2) / Math.max(1, across - gap)) * 100;
}
