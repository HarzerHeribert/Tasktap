// One terminal on screen: xterm.js on the core's stream (design §9). The engine outlives its
// tab's moves between panes (its element is moved, never rebuilt) and a close to the background
// (its stream closes, the process runs on); reopened, it continues from the offset it has, so
// nothing is redrawn when nothing was missed. xterm.js follows the size marks, so the screen and
// the process agree at every byte; the page only asks for a size (terminal.resize).
import type { Mark, StartTerminal } from '../../../core/proto/protocol.ts';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { type ILink, Terminal } from '@xterm/xterm';
import type { Stream } from '../client.ts';
import { call, client, fail, records, redraw } from '../page.ts';
import { type Look, look as ownLook, terminalOptions } from './appearance.ts';
import { type Found, find, lineAt, pointsAt, range } from './links.ts';

/** Bytes the core may send ahead of what xterm.js has parsed. */
const WINDOW = 1 << 20;
const encoder = new TextEncoder();
const empty = new Uint8Array(0);
const RELEASE = '\x1b[?9;1000;1002;1003;1004;1005;1006;1015;1016;2004;2026l\x1b[?1l\x1b>\x1b[<u\x1b[=0u\x1b[>4;0m\x1b[?47l\x1b[0m\x1b[?25h';
let look: Look = ownLook();

// Links. An address or a path a terminal prints is a link only while ⌘ is held, as in Mac terminals: then it is
// underlined under the pointer, ⌘-click opens it and ⇧⌘-click shows a file in Finder. A plain click is never a link's:
// it belongs to the program in the terminal. Whether ⌘ is held is said on the page's root, which the styles follow.
const held = (on: boolean) => document.documentElement.toggleAttribute('data-cmd', on);
addEventListener('keydown', (e) => e.key === 'Meta' && held(true), true);
addEventListener('keyup', (e) => e.key === 'Meta' && held(false), true);
addEventListener('blur', () => held(false));
/** What the host says a path is, asked once for a few seconds: null when it does not exist or may not be opened. */
const probes = new Map<string, { at: number; found: Promise<string | null> }>();
function probe(target: string, cwd: string) {
  const key = `${cwd}\n${target}`, had = probes.get(key);
  if (had && Date.now() - had.at < 5000) return had.found;
  if (probes.size > 400) probes.clear();
  const found = call('host.open', { target, cwd, probe: true }).catch(() => null);
  probes.set(key, { at: Date.now(), found });
  return found;
}

export class Engine {
  readonly id: string;
  /** `.term`, moved between panes' surfaces as its tab moves. */
  readonly element = document.createElement('div');
  readonly term: Terminal;
  readonly fit = new FitAddon();
  readonly search = new SearchAddon();
  private stream: Stream | null = null;
  private opening = false;
  /** Bytes this stream carried, and where in the terminal's output they start. */
  private received = 0;
  private base = { offset: 0, at: 0 };
  /** Where a reconnect continues: the terminal offset of the next byte. */
  private resume: number | null = null;
  /** Before the live mark the bytes are history: what they ask is not the program's to read. */
  private replaying = true;
  private reply = false;
  private asked = '';
  private scrollTimer = 0;
  /** While it is scrolled back: how many lines are below, and the way to the end. */
  private readonly more = document.createElement('button');
  private below = 0;
  /** Typed once the stream is live. */
  private queued = '';
  /** The folder its shell says it is in (OSC 7), when it says. */
  private cwd = '';
  /** What the link under the pointer opens, where that is not what its text says: shown at the terminal's foot. */
  private readonly tip = document.createElement('div');
  size: number | null = null;
  /** Times the core restarted this stream because it fell behind (measured, never expected). */
  gaps = 0;
  /** The terminal offset the last stream continued from; null when it replayed the ring. */
  resumed: number | null = null;

  constructor(id: string) {
    this.id = id;
    this.element.className = 'term';
    // FitAddon measures its parent: give it the content box inside the padding.
    const viewport = document.createElement('div');
    viewport.className = 'term-view';
    this.element.append(viewport);
    this.term = new Terminal({ ...terminalOptions(look, look.fontSize), scrollback: 10000, allowTransparency: true });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.open(viewport);
    // The DOM renderer: measured against WebGL on a 5 MB burst it was as fast (23.6 MB/s both),
    // used 7 % more processor time and 12 to 25 MB less memory, with no context to lose.
    this.mute();
    this.term.onData((data) => this.reply || this.write(encoder.encode(data)));
    this.term.onBinary((data) => this.write(Uint8Array.from(data, (c) => c.charCodeAt(0))));
    // ⌘ shortcuts are the application menu's and the page's, never input.
    this.term.attachCustomKeyEventHandler((e) => !e.metaKey);
    // No bar: while it is scrolled back a pill says how many lines are below and returns to the end (⌘↓ too), and
    // the hair-thin mark of where the person is shows only while they scroll.
    this.more.type = 'button';
    this.more.className = 'btn term-more';
    this.more.hidden = true;
    this.more.innerHTML = '<span></span><kbd>⌘↓</kbd>';
    this.more.onclick = () => (this.term.scrollToBottom(), this.term.focus());
    this.element.append(this.more);
    this.term.onScroll(() => {
      const b = this.term.buffer.active, below = b.baseY - b.viewportY;
      if (below !== this.below) {
        this.below = below;
        this.more.hidden = !below;
        this.more.firstElementChild!.textContent = `↓ ${below.toLocaleString()} ${below === 1 ? 'line' : 'lines'}`;
      }
      if (!below) return;
      this.element.classList.add('scrolling');
      clearTimeout(this.scrollTimer);
      this.scrollTimer = window.setTimeout(() => this.element.classList.remove('scrolling'), 500);
    });
    new ResizeObserver(() => queueFit(this)).observe(viewport);
    this.tip.className = 'term-link';
    this.tip.hidden = true;
    this.element.append(this.tip);
    this.term.registerLinkProvider({ provideLinks: (y, done) => void this.links(y).then((l) => done(l.length ? l : undefined)) });
    // A hyperlink the program printed itself (OSC 8), under the same rules; its target is shown where its text is not it.
    this.term.options.linkHandler = {
      allowNonHttpProtocols: true,
      activate: (e, uri) => this.follow(e, pointsAt(uri)),
      hover: (_e, uri, r) => this.point(pointsAt(uri), this.term.buffer.active.getLine(r.start.y - 1)?.translateToString(true, r.start.x - 1, r.end.x) ?? ''),
      leave: () => this.point(null),
    };
    this.term.parser.registerOscHandler(7, (data) => {
      const at = pointsAt(data);
      if (at?.kind === 'path') this.cwd = at.target;
      return true;
    });
  }

  /** The folder a path this terminal prints is taken from: where its shell says it is, else where its session runs
   *  (a copy of the project, for a run in one), else where the terminal started. */
  private folder() {
    const runs = [...records.sessions.values()].filter((s) => s.terminal_id === this.id && s.cwd).sort((a, b) => (a.id < b.id ? 1 : -1))[0];
    return this.cwd || runs?.cwd || records.terminals.get(this.id)?.cwd || '';
  }

  /** The links in the line that screen row `y` (from 1) is part of: every web address, and every path the host says
   *  exists where it may be opened. */
  async links(y: number): Promise<ILink[]> {
    const { text, cells } = lineAt(this.term.buffer.active, y - 1, this.term.cols), cwd = this.folder();
    const all = await Promise.all(find(text).map(async (f): Promise<ILink | null> => {
      const real = f.kind === 'web' ? f.target : await probe(f.target, cwd);
      return real === null ? null : {
        range: range(cells, f.start, f.end), text: text.slice(f.start, f.end),
        activate: (e) => this.follow(e, f), hover: () => this.point(f, f.target, real), leave: () => this.point(null),
      };
    }));
    return all.filter((l) => l !== null);
  }

  /** ⌘-click: the host opens it, or says why not. With ⇧ a file is shown in Finder. */
  private follow(e: Pick<MouseEvent, 'metaKey' | 'shiftKey'>, to: Pick<Found, 'kind' | 'target'> | null) {
    if (e.metaKey && to) void call('host.open', { target: to.target, cwd: this.folder(), reveal: e.shiftKey }).catch(fail);
  }

  /** Says what the link under the pointer opens, where its text does not: the whole path of a file, with the way to
   *  show it in Finder; the address behind a program's hyperlink. */
  private point(to: Pick<Found, 'kind' | 'target'> | null, shown = '', real?: string | null) {
    const at = (this.tip.dataset.at = to ? to.target : '');
    this.tip.hidden = true;
    if (!to) return;
    void (real !== undefined ? Promise.resolve(real) : to.kind === 'web' ? Promise.resolve(to.target) : probe(to.target, this.folder())).then((real) => {
      if (this.tip.dataset.at !== at || !real || real === shown.trim()) return;
      const path = document.createElement('b'), how = document.createElement('i');
      path.textContent = to.kind === 'web' ? real : real.replace(/^\/Users\/[^/]+/, '~');
      how.textContent = to.kind === 'web' ? '' : '⇧ shows it in Finder';
      this.tip.replaceChildren(path, how);
      this.tip.hidden = false;
    });
  }

  /** Replies xterm.js makes to queries in history are dropped (prototype/terminal-protocol.js):
   *  the core answered those while no window was attached. */
  private mute() {
    const query = () => {
      this.reply = this.replaying;
      if (this.reply) queueMicrotask(() => (this.reply = false));
      return false;
    };
    const p = this.term.parser;
    for (const id of [{ final: 'n' }, { prefix: '?', final: 'n' }, { final: 'c' }, { prefix: '>', final: 'c' },
      { intermediates: '$', final: 'p' }, { prefix: '?', intermediates: '$', final: 'p' }, { final: 't' }])
      p.registerCsiHandler(id, query);
    p.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => (params.includes(1004) ? query() : false));
    p.registerDcsHandler({ intermediates: '$', final: 'q' }, query);
    for (const id of [4, 10, 11, 12]) p.registerOscHandler(id, (data) => (data.split(';').includes('?') ? query() : false));
  }

  get attached() {
    return !!this.stream;
  }

  /** Opens the stream: from where this engine left off, else from the start of the ring; with
   *  `start`, the terminal is started first (the id is the attempt, so a repeat only attaches). */
  async attach(start?: StartTerminal) {
    if (this.stream || this.opening) return;
    this.opening = true;
    const row = records.terminals.get(this.id);
    const dims = this.measure();
    const cols = dims?.cols ?? row?.cols ?? this.term.cols;
    const rows = dims?.rows ?? row?.rows ?? this.term.rows;
    this.asked = `${cols}x${rows}`;
    this.replaying = true;
    this.received = 0;
    try {
      const from = this.resume;
      this.resumed = from;
      this.stream = await client.open('terminal.open', { id: this.id, ...(start ? { start } : {}), cols, rows, credit: WINDOW, ...(from !== null ? { from } : {}) }, {
        ondata: (bytes) => {
          const n = bytes.length;
          this.received += n;
          this.term.write(bytes, () => this.stream?.consumed(n));
        },
        onmark: (m) => this.mark(m),
        onclose: () => {
          this.resume = this.offset();
          this.stream = null;
          redraw();
        },
      });
      this.base = { offset: this.stream.from ?? 0, at: 0 };
    } finally {
      this.opening = false;
    }
  }

  /** Closes the stream; the process runs on and this engine keeps its screen. */
  detach() {
    if (!this.stream) return;
    this.resume = this.offset();
    this.stream.close();
    this.stream = null;
  }

  private offset() {
    return this.base.offset + (this.received - this.base.at);
  }

  private mark(m: Mark) {
    if (m.gap) {
      // The stream starts again from the ring's start: the old screen goes with it.
      this.gaps++;
      this.base = { offset: m.from ?? 0, at: m.at };
      this.term.write(empty, () => this.term.reset());
    }
    if (m.size) {
      const [cols, rows] = m.size;
      this.term.write(empty, () => this.term.resize(cols, rows));
    }
    if (m.live)
      this.term.write(empty, () => {
        this.replaying = false;
        const text = this.queued;
        this.queued = '';
        if (text) this.write(encoder.encode(text));
      });
    if (m.exit !== undefined) redraw();
  }

  write(bytes: Uint8Array) {
    if (this.stream && !this.replaying) this.stream.write(bytes);
  }

  /** Text as if typed, once the terminal is live. */
  type(text: string) {
    if (this.stream && !this.replaying) this.write(encoder.encode(text));
    else this.queued += text;
  }

  /** Text as a paste: bracketed when the program asked for it, with no Enter added. */
  paste(text: string) {
    if (this.stream) this.term.paste(text);
  }

  private measure() {
    if (!this.element.isConnected || !this.element.getClientRects().length) return undefined;
    return this.fit.proposeDimensions();
  }

  /** Asks for the size the pane has room for; xterm.js takes it when the mark comes back. A
   *  terminal that ended has no process to ask, so its screen is sized here. */
  fitNow() {
    const d = this.measure();
    if (!d || !d.cols || !d.rows) return;
    const want = `${d.cols}x${d.rows}`;
    if (records.terminals.get(this.id)?.state !== 'running' || !this.stream) {
      if (this.term.cols !== d.cols || this.term.rows !== d.rows) this.term.resize(d.cols, d.rows);
      return;
    }
    if (want === this.asked) return;
    this.asked = want;
    void call('terminal.resize', { id: this.id, cols: d.cols, rows: d.rows }).catch(() => {});
  }

  setLook(l: Look, size: number) {
    Object.assign(this.term.options, terminalOptions(l, size));
    this.size = size;
    queueFit(this);
  }

  setSize(size: number) {
    this.setLook(look, size);
  }

  /** Gives the pointer and the keyboard modes back after a program that left them captured
   *  (terminal-protocol.js: release). */
  release() {
    this.term.write(RELEASE, () => this.term.focus());
  }

  dispose() {
    this.detach();
    clearTimeout(this.scrollTimer);
    this.term.dispose();
    this.element.remove();
  }
}

// Reflow once the pointer pauses rather than on every frame of a drag (1.2's queueFit).
const pending = new Set<Engine>();
let fitTimer = 0;
export function queueFit(e: Engine) {
  pending.add(e);
  clearTimeout(fitTimer);
  fitTimer = window.setTimeout(flushFits, 100);
}
export function flushFits() {
  clearTimeout(fitTimer);
  const all = [...pending];
  pending.clear();
  for (const e of all) e.fitNow();
}

export const engines = new Map<string, Engine>();
export function engine(id: string): Engine {
  let e = engines.get(id);
  if (!e) engines.set(id, (e = new Engine(id)));
  return e;
}

/** The look every terminal takes; `size` gives each its own text size. */
export function setLook(l: Look, size: (id: string) => number) {
  look = l;
  for (const e of engines.values()) e.setLook(l, size(e.id));
}
export const currentLook = () => look;
