// One terminal on screen: xterm.js on the core's stream (design §9). The engine outlives its
// tab's moves between panes (its element is moved, never rebuilt) and a close to the background
// (its stream closes, the process runs on); reopened, it continues from the offset it has, so
// nothing is redrawn when nothing was missed. xterm.js follows the size marks, so the screen and
// the process agree at every byte; the page only asks for a size (terminal.resize).
import type { Mark, StartTerminal } from '../../../core/proto/protocol.ts';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import type { Stream } from '../client.ts';
import { call, client, records, redraw } from '../page.ts';
import { type Look, neutral, terminalOptions } from './appearance.ts';

/** Bytes the core may send ahead of what xterm.js has parsed. */
const WINDOW = 1 << 20;
const encoder = new TextEncoder();
const empty = new Uint8Array(0);
const RELEASE = '\x1b[?9;1000;1002;1003;1004;1005;1006;1015;1016;2004;2026l\x1b[?1l\x1b>\x1b[<u\x1b[=0u\x1b[>4;0m\x1b[?47l\x1b[0m\x1b[?25h';
/** The renderer: WebGL, falling back to the DOM when it cannot start or loses its context. */
const renderer = new URLSearchParams(location.search).get('renderer') === 'dom' ? 'dom' : 'webgl';
let look: Look = neutral();

export class Engine {
  readonly id: string;
  /** `.deck-terminal`, moved between panes' surfaces as its tab moves. */
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
  /** Typed once the stream is live. */
  private queued = '';
  size: number | null = null;

  constructor(id: string) {
    this.id = id;
    this.element.className = 'deck-terminal';
    // FitAddon measures its parent: give it the content box inside the padding.
    const viewport = document.createElement('div');
    viewport.className = 'deck-terminal-viewport';
    this.element.append(viewport);
    this.term = new Terminal({ ...terminalOptions(look, look.fontSize), scrollback: 10000, allowTransparency: true });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.open(viewport);
    if (renderer === 'webgl') {
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => gl.dispose());
        this.term.loadAddon(gl);
      } catch {
        // The DOM renderer stays.
      }
    }
    this.mute();
    this.term.onData((data) => this.reply || this.write(encoder.encode(data)));
    this.term.onBinary((data) => this.write(Uint8Array.from(data, (c) => c.charCodeAt(0))));
    // ⌘ shortcuts are the application menu's and the page's, never input.
    this.term.attachCustomKeyEventHandler((e) => !e.metaKey);
    this.term.onScroll(() => {
      this.element.classList.add('is-scrolling');
      clearTimeout(this.scrollTimer);
      this.scrollTimer = window.setTimeout(() => this.element.classList.remove('is-scrolling'), 900);
    });
    new ResizeObserver(() => queueFit(this)).observe(viewport);
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
    this.term.options.fontSize = size;
    this.size = size;
    queueFit(this);
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
