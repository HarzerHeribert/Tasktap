// The one client every page uses for the core (design §1, §12): the handshake's answer, typed
// calls, records kept from a snapshot and the ordered changes after it, and streams with
// credit. It knows only the Bridge, so it runs the same in a page and in a test.
import type {
  AgentHealth, Calls, Change, Close, CloseWhy, Code, Collection, Control, Credit, Device, Dictation, Diff, FileRead, Glance, Layout, Listening, Mark, Opened,
  Pref, Preview,
  Project, Question, Session, SessionId, Set as RowSet, Shortcut, Terminal, Thought, TurnResult, Welcome,
} from '../../core/proto/protocol.ts';
import { MAX_DATA, VERSION } from '../../core/proto/protocol.ts';

/** What the host gives each page (design §12). */
export interface Bridge {
  send(frame: string | Uint8Array): void;
  host(frame: string): void;
  onframe: (frame: string | Uint8Array) => void;
}

/** The host's abilities this slice has. */
export type HostCalls = {
  'host.notch': { args: { open?: boolean; key?: boolean; height?: number; wing?: number; line?: number; hit?: number[] }; result: null };
  /** The workspace window, in front, showing a session's or terminal's tab when `at` names one. */
  'host.show': { args: { surface: 'workspace'; at?: SessionId }; result: null };
  'host.pick': { args: { folder: true }; result: string | null };
  /** Reads the clipboard's text, or with `text` writes it. */
  'host.clipboard': { args: { text?: string }; result: string | null };
  /** The workspace page has drawn: its window may show. */
  'host.ready': { args: Record<string, never>; result: null };
  /** The window minimised, maximised or put back, or closed: for the page's own caption buttons and menu (Windows);
   *  `quit` ends the app, which closing its window does not. */
  'host.window': { args: { do: 'minimize' | 'maximize' | 'close' | 'quit' }; result: null };
  /** What the capture key opens from another app: the notch with the keyboard in its field, on Windows the tab,
   *  and New Task where there is neither. The workspace asks for it when the key is pressed with its window in
   *  front and no field for a thought in view. */
  'host.capture': { args: Record<string, never>; result: null };
  /** Windows: the display the tab at the top of the screen hangs on: `main`, `pointer` (where it was last
   *  opened), a display's own name, or `off` for no tab. With `display` the host keeps the choice, in its own
   *  file since a display belongs to this machine, and carries it out. The reply is the choice and the displays
   *  there are. A Mac's host has no such call. */
  'host.tab': { args: { display?: string }; result: { display: string; displays: { name: string; primary: boolean; width: number; height: number }[] } };
  /** Has the system open a web address, or a path inside a folder the person opened (a file of text in the default
   *  text editor; anything else, and with `reveal`, shown in Finder). The host refuses everything else. `probe`:
   *  nothing is opened, and the reply is what would be, or null. A path is taken from `cwd` unless it is whole. */
  'host.open': { args: { target: string; cwd?: string; reveal?: boolean; probe?: boolean }; result: string | null };
  /** Whether the Mac is in Low Power Mode; the host says when that changes (the `ui` event `power`). */
  'host.power': { args: Record<string, never>; result: boolean };
  /** The capture key. With `key`, a shortcut or null for the system's own: the host asks the system for it and only
   *  then stores the preference; refused, by the rule of a shortcut or because another app holds it, the error says
   *  so and the old key goes on working. The reply, and the reply to a call with no `key`, is the key registered
   *  now, or null when none is. */
  'host.capture_key': { args: { key?: Shortcut | null }; result: { key: Shortcut | null } };
  /** What a preview's frame is given (host/src/frames.rs): `base`, the address of this machine a file's whole path
   *  is added to for a frame to load it; and with `listens`, a local web address, whether anything answers there
   *  now. Refused, in a sentence, by a host that cannot hold a frame to this machine. */
  'host.frame': { args: { listens?: string }; result: { base: string; listens?: boolean } };
};
type AllCalls = { [K in keyof Calls]: { args: Calls[K]['args']; result: Calls[K]['result'] } } & HostCalls;
export type Name = keyof AllCalls;
export type Args<N extends Name> = AllCalls[N]['args'];
export type Result<N extends Name> = AllCalls[N]['result'];

export class CallError extends Error {
  readonly code: Code;
  constructor(code: Code, message: string) {
    super(message);
    this.code = code;
  }
}

/** Every collection a page can hold, each row by its id; `glance` is one row. */
export class Records {
  thoughts = new Map<string, Thought>();
  projects = new Map<string, Project>();
  sessions = new Map<string, Session>();
  terminals = new Map<string, Terminal>();
  questions = new Map<string, Question>();
  results = new Map<string, TurnResult>();
  layouts = new Map<string, Layout>();
  prefs = new Map<string, Pref>();
  devices = new Map<string, Device>();
  /** What is shown beside a terminal (design §9, "Previews"). */
  previews = new Map<string, Preview>();
  /** In the order the core lists its agents. */
  agents = new Map<string, AgentHealth>();
  /** Speech under way or failed; none is kept across a restart of the core. */
  dictations = new Map<string, Dictation>();
  glance: Glance | null = null;
  rev = 0;
  /** Called once per transaction applied, with the snapshot first. */
  onchange: () => void = () => {};

  apply(change: Change, sets: RowSet[]): void {
    if (change.snap) {
      for (const map of [this.thoughts, this.projects, this.sessions, this.terminals, this.questions, this.results,
        this.layouts, this.prefs, this.devices, this.previews, this.agents, this.dictations]) map.clear();
    }
    for (const set of sets) {
      if (set.c === 'glance') {
        this.glance = set.put.at(-1) ?? this.glance;
        continue;
      }
      const map = this[set.c] as Map<string, { id: string }>;
      for (const row of (set.put ?? []) as { id: string }[]) map.set(row.id, row);
      for (const id of set.del ?? []) map.delete(id);
    }
    this.rev = change.rev;
    this.onchange();
  }
}

/** A byte stream the core opened as the reply to a call. */
export class Stream {
  ondata: (bytes: Uint8Array) => void = () => {};
  onmark: (mark: Mark) => void = () => {};
  onclose: (why: CloseWhy | null) => void = () => {};
  closed = false;
  private queue: Uint8Array[] = [];
  private owed = 0;
  private readonly client: Client;
  readonly s: number;
  /** Bytes this page may still send. */
  credit: number;
  private readonly window: number;
  /** Where in the source the stream starts (a terminal's output offset). */
  readonly from: number | null;

  constructor(client: Client, s: number, credit: number, window: number, from: number | null) {
    this.client = client;
    this.s = s;
    this.credit = credit;
    this.window = window;
    this.from = from;
  }

  /** Sends what the core's credit allows now and the rest as more is granted. */
  write(bytes: Uint8Array): void {
    if (this.closed) return;
    this.queue.push(bytes);
    this.flush();
  }

  /** The page has dealt with `n` bytes: the core may send them again, in batches of half the window. */
  consumed(n: number): void {
    this.owed += n;
    if (this.closed || this.owed < this.window / 2) return;
    this.client.control({ t: 'credit', s: this.s, n: this.owed });
    this.owed = 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.client.control({ t: 'close', s: this.s });
  }

  /** @internal */
  flush(): void {
    while (this.queue.length && this.credit > 0) {
      const head = this.queue[0]!;
      const n = Math.min(head.length, this.credit, MAX_DATA);
      const frame = new Uint8Array(4 + n);
      new DataView(frame.buffer).setUint32(0, this.s, true);
      frame.set(head.subarray(0, n), 4);
      this.client.bridge.send(frame);
      this.credit -= n;
      if (n === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(n);
    }
  }
}

export class Client {
  /** The core's answer to the host's hello on this connection. */
  readonly welcome: Promise<Welcome>;
  private greeted?: { ok: (w: Welcome) => void; no: (e: Error) => void };
  private next = 0;
  private readonly waiting = new Map<number, { ok: (v: unknown) => void; no: (e: CallError) => void }>();
  private readonly streams = new Map<number, Stream>();
  /** Frames of a transaction marked `more`, applied whole with its last. */
  private partial: RowSet[] = [];
  private records: Records | null = null;

  readonly bridge: Bridge;

  constructor(bridge: Bridge) {
    this.bridge = bridge;
    this.welcome = new Promise((ok, no) => (this.greeted = { ok, no }));
    bridge.onframe = (frame) => this.receive(frame);
  }

  call<N extends Name>(name: N, args: Args<N>): Promise<Result<N>> {
    return this.request(name, args, (v) => v as Result<N>);
  }

  /** Subscribes `records` to `collections`: the snapshot, then every change in order. */
  sub(collections: Collection[], records: Records): Promise<number> {
    this.records = records;
    return this.call('sub', { collections }).then((r) => r.rev);
  }

  /** Makes a call that opens a stream, granting the core `credit` bytes, kept topped up by
   *  `consumed`. The handlers are in place when the reply arrives: bytes can follow it at once. */
  open(
    name: 'terminal.open' | 'fixture.stream',
    args: Args<'terminal.open'> | Args<'fixture.stream'>,
    on: Partial<Pick<Stream, 'ondata' | 'onmark' | 'onclose'>>,
  ): Promise<Stream> {
    return this.request(name, args, (v) => this.stream(v as Opened, args.credit, on));
  }

  /** `thought.changes`: the files in the reply, and the diff on the stream it opens. */
  changes(args: Args<'thought.changes'>, on: Partial<Pick<Stream, 'ondata' | 'onclose'>>): Promise<{ diff: Diff; stream: Stream }> {
    return this.request('thought.changes', args, (v) => ({ diff: v as Diff, stream: this.stream((v as Diff).stream, args.credit, on) }));
  }

  /** `file.read`: what the file is in the reply, and its bytes on the stream the reply opens, where it opens one
   *  (none for a file that still has the stamp `unless` names, and for one of a kind nothing shows). */
  read(args: Args<'file.read'>, on: Partial<Pick<Stream, 'ondata' | 'onclose'>>): Promise<{ file: FileRead; stream: Stream | null }> {
    return this.request('file.read', args, (v) => {
      const file = v as FileRead;
      return { file, stream: file.stream ? this.stream(file.stream, args.credit, on) : null };
    });
  }

  /** `dictation.start`: the stream the recording goes on, within the credit the core gives it, when the core
   *  transcribes; and the longest a recording lasts. */
  dictate(args: Args<'dictation.start'>, on: Partial<Pick<Stream, 'onclose'>>): Promise<{ stream: Stream | null; seconds: number }> {
    return this.request('dictation.start', args, (v) => {
      const l = v as Listening;
      return { seconds: l.seconds, stream: l.stream ? this.stream(l.stream, 0, on) : null };
    });
  }

  private stream(opened: Opened, window: number, on: Partial<Pick<Stream, 'ondata' | 'onmark' | 'onclose'>>) {
    const stream = Object.assign(new Stream(this, opened.s, opened.credit, window, opened.from ?? null), on);
    this.streams.set(opened.s, stream);
    return stream;
  }

  /** A call whose reply `map` turns into its result as it arrives, before any later frame. */
  private async request<T>(name: Name, args: unknown, map: (ok: unknown) => T): Promise<T> {
    await this.welcome;
    const id = (this.next = (this.next + 1) >>> 0);
    const frame = JSON.stringify({ t: 'call', id, name, args });
    const reply = new Promise<T>((ok, no) => this.waiting.set(id, { ok: (v: unknown) => ok(map(v)), no }));
    if (name.startsWith('host.')) this.bridge.host(frame);
    else this.bridge.send(frame);
    return reply;
  }

  /** @internal */
  control(frame: Control): void {
    this.bridge.send(JSON.stringify(frame));
  }

  private receive(frame: string | Uint8Array): void {
    if (typeof frame !== 'string') {
      const s = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, true);
      this.streams.get(s)?.ondata(frame.subarray(4));
      return;
    }
    const c = JSON.parse(frame) as Control;
    switch (c.t) {
      case 'welcome':
        if (c.v === VERSION) this.greeted?.ok(c);
        else this.greeted?.no(new Error(`the core speaks version ${c.v}, this page ${VERSION}`));
        return;
      case 'refuse':
        this.greeted?.no(new Error(`the core refused this device: ${c.why}`));
        return;
      case 'reply': {
        const waiter = this.waiting.get(c.id);
        this.waiting.delete(c.id);
        if ('err' in c) waiter?.no(new CallError(c.err.code, c.err.message));
        else waiter?.ok(c.ok);
        return;
      }
      case 'change':
        this.partial.push(...c.sets);
        if (c.more) return;
        this.records?.apply(c, this.partial);
        this.partial = [];
        return;
      case 'credit':
        return this.credit(c);
      case 'mark':
        this.streams.get(c.s)?.onmark(c);
        return;
      case 'close':
        return this.closeStream(c);
      case 'call':
        // Pages offer no abilities.
        this.control({ t: 'reply', id: c.id, err: { code: 'unknown', message: `this page has no ${c.name}` } });
        return;
    }
  }

  private credit(c: Credit): void {
    const stream = this.streams.get(c.s);
    if (!stream) return;
    stream.credit += c.n;
    stream.flush();
  }

  private closeStream(c: Close): void {
    const stream = this.streams.get(c.s);
    this.streams.delete(c.s);
    if (!stream) return;
    stream.closed = true;
    stream.onclose(c.why ?? null);
  }
}

/** A UUID v7, as the core expects for every id a client mints. */
export function uuid7(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const ms = Date.now();
  for (let i = 0; i < 6; i++) b[i] = Math.floor(ms / 2 ** (8 * (5 - i))) & 0xff;
  b[6] = 0x70 | (b[6]! & 0x0f);
  b[8] = 0x80 | (b[8]! & 0x3f);
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
