// Previews: what an agent made or serves, shown beside its terminal instead of in another app (design §9, "Previews").
// A preview is the core's record and a tab of the layout like a terminal's (layout.ts beside). This file is what a
// link in a terminal does, what the page keeps of each preview while it runs, how it stays current, and how each kind
// is drawn. What may be shown is the core's to say (`preview.open`, `file.read`) and what a frame may do is the host's
// (host/src/frames.rs): nothing here is trusted with either.
//
// - A picture is an image, fitted, at its real size on a click. A drawing (SVG) is shown the same way: as an image it
//   runs nothing and loads nothing.
// - Markdown and text are drawn by this page as text: Markdown from the plain data of markdown.ts, in the type roles,
//   so raw HTML in it is words; text as it is. Both up to `MOST`, and said to be cut where they are.
// - A page (HTML), a PDF and a local web address are shown in a frame whose address is not the app's: a file from the
//   host's own server, an address as it is. The frame is sandboxed (it cannot reach the window around it or open
//   another), except a PDF's, which WebKit draws in no sandboxed frame; the host holds every frame to this machine
//   whatever its attributes say.
//
// Nothing runs while nothing happens: a preview asks whether its file changed (`file.read` with the stamp it has)
// when its terminal has printed something and gone quiet, when the window comes back into use, and on Reload.
import type { FileKind, FileRead, Preview as Row } from '../../../core/proto/protocol.ts';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { CallError, type Stream } from '../client.ts';
import { I, Key } from '../ui.tsx';
import { FILES, HERE, asAddress, shownPath } from '../system.ts';
import * as L from './layout.ts';
import { type Block, type Inline, parse } from './markdown.ts';
import { type Item } from './menu.ts';
import { agentName, call, client, closeTab, current, fail, focus, focusTerminal, layout, projectOf, records, redraw, sentence, sessionOf, setLayout, ui } from './model.ts';
import { hooks } from './terminal.ts';

/** What a ⌘-click previews, by its name: a person can tell before they click. Everything else on disk is the
 *  editor's or Finder's, as before; every web address is asked for, and only this machine's own are shown. */
const SHOWN = /\.(png|jpe?g|gif|webp|svg|pdf|html?|md|markdown)$/i;
/** How much text is drawn: enough for any report, and no page of a hundred thousand lines. */
const MOST = 256 << 10;
const WINDOW = 1 << 20;
const PICTURES: Partial<Record<FileKind, string>> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const TEXTS: FileKind[] = ['text', 'markdown', 'html', 'svg'];
const SANDBOX = 'allow-scripts allow-forms allow-same-origin';

/** What the page keeps of a preview while it runs. */
type View = {
  /** What the core last said the file is; its stamp is handed back to ask whether it changed. */
  file?: FileRead;
  text?: string;
  /** A picture, as an address of this page's own. */
  picture?: string;
  size?: string;
  real?: boolean;
  /** Where a frame loads a file from, and whether a web address is answered. */
  base?: string;
  listens?: boolean;
  /** Counted up to load a frame anew. */
  turn: number;
  /** Why there is nothing to show, in the core's or the host's sentence; `gone`: the file is no longer there. */
  said?: string;
  gone?: boolean;
  busy?: boolean;
};
const views = new Map<string, View>();
const view = (id: string) => views.get(id) ?? views.set(id, { turn: 0 }).get(id)!;
/** Where a frame tried to go that is not this machine: offered to the person, never opened by itself. */
let stopped = '';
export const stop = (url: string) => ((stopped = url), redraw());

/** Reads a preview: all of it the first time and on Reload (`again`), and otherwise only if it changed. */
export async function load(id: string, again = false) {
  for (const [old, v] of views) if (!records.previews.has(old)) (v.picture && URL.revokeObjectURL(v.picture), views.delete(old));
  const p = records.previews.get(id), v = view(id);
  if (!p || v.busy || (p.kind === 'web' && v.listens && !again)) return;
  v.busy = true;
  try {
    if (p.kind === 'web') {
      const f = await call('host.frame', { listens: p.target });
      if (again && v.listens) v.turn++;
      Object.assign(v, { base: f.base, listens: !!f.listens });
    } else {
      const chunks: Uint8Array[] = [];
      let ended = () => {};
      const all = new Promise<void>((ok) => (ended = ok));
      const { file, stream } = await client.read({ path: p.target, credit: WINDOW, unless: again ? null : (v.file?.stamp ?? null) }, {
        ondata(this: Stream, bytes: Uint8Array) {
          chunks.push(bytes);
          this.consumed(bytes.length);
        },
        onclose: ended,
      });
      if (stream || file.kind === 'other' || file.stamp !== v.file?.stamp) {
        if (file.kind === 'html' || file.kind === 'pdf') {
          // A frame loads the file itself: its bytes are not wanted here.
          stream?.close();
          v.file = file;
          v.base = (await call('host.frame', {})).base;
          v.turn++;
        } else if (stream) {
          await all;
          if (PICTURES[file.kind]) {
            if (v.picture) URL.revokeObjectURL(v.picture);
            v.picture = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: PICTURES[file.kind]! }));
          } else v.text = new TextDecoder(file.encoding ?? 'utf-8').decode(await new Blob(chunks as BlobPart[]).arrayBuffer());
        }
        v.file = file;
      }
    }
    v.said = undefined;
  } catch (e) {
    Object.assign(v, { said: sentence(e instanceof Error ? e.message : String(e)), gone: e instanceof CallError && e.code === 'gone' });
  }
  v.busy = false;
  redraw();
}

/** The previews in front in the workspace shown, of one terminal or of all: each asks whether it changed. */
export function refresh(terminal?: string) {
  if (!records.previews.size || !layout(ui.view).tree) return;
  for (const pane of L.panes(layout(ui.view))) {
    const p = records.previews.get(pane.active ?? '');
    if (p && (!terminal || p.terminal_id === terminal)) void load(p.id);
  }
}
// A terminal that printed something and has been quiet for a moment: what it wrote may be what is shown beside it.
// The one timer here, and it exists only while output arrives in a terminal that has a preview.
const quiet = new Map<string, number>();
hooks.output = (terminal) => {
  if (!records.previews.size || ![...records.previews.values()].some((p) => p.terminal_id === terminal)) return;
  clearTimeout(quiet.get(terminal));
  quiet.set(terminal, window.setTimeout(() => (quiet.delete(terminal), refresh(terminal)), 400));
};

/** Shows a preview in its pane, without taking the keyboard or the selection: the person asked to see it. */
function bring(id: string) {
  const project = projectOf(records.previews.get(id)?.terminal_id ?? id), l = layout(project), pane = L.paneOf(l, id);
  if (!pane) return;
  setLayout(project, { ...L.select(l, pane.id, id), selected: l.selected, focus: false });
  if (views.has(id)) void load(id);
}

/** A link followed: in a terminal with ⌘, in a preview with a click. What can be shown is shown beside the terminal
 *  (a web address of this machine; a picture, a PDF, a page or Markdown by its name), and everything else goes where
 *  it went before: a remote address to the browser, a file of text to the editor, the rest to Finder. ⌥ does the
 *  other of the two; ⇧ shows a file in Finder. What the core refuses is said under the terminal in its words. */
export async function follow(terminal: string, to: { kind: 'web' | 'path'; target: string }, cwd: string, e: { shiftKey?: boolean; altKey?: boolean }) {
  const elsewhere = () => call('host.open', { target: to.target, cwd, reveal: !!e.shiftKey }).catch(fail);
  if (e.shiftKey || (to.kind === 'web' || SHOWN.test(to.target)) === !!e.altKey) return void elsewhere();
  try {
    const id = await call('preview.open', { terminal, target: to.target, cwd });
    ui.refused.delete(terminal);
    bring(id);
  } catch (err) {
    // An address that is not this machine's own is the browser's: that is the rule, not a failure.
    if (to.kind === 'web' && err instanceof CallError && err.code === 'invalid') return void elsewhere();
    ui.refused.set(terminal, { said: sentence(err instanceof Error ? err.message : String(err)), target: to.target, cwd });
    redraw();
  }
}
hooks.follow = (terminal, to, cwd, e) => void follow(terminal, to, cwd, e);

const body = (id: string) => document.querySelector<HTMLElement>(`[data-preview="${id}"] :is(iframe, .pv-b)`);
/** The keyboard to a preview once it is on screen. */
export const focusPreview = (id: string) => requestAnimationFrame(() => focus(body(id)));
/** The preview a command means: the one in front in the selected pane, else the first beside the terminal there. */
const meant = () => {
  const c = current();
  return c?.preview ?? L.tabs(layout(c?.project ?? '')).find((t) => c?.id && records.previews.get(t)?.terminal_id === c.id);
};
/** ⌘R. */
export const reload = (id = meant()) => id && void load(id, true);
/** ⌘P: the keyboard goes from a terminal to the preview beside it, and from a preview back to its terminal. */
export function swap() {
  const c = current();
  if (!c) return;
  const l = layout(c.project), to = c.preview ? records.previews.get(c.preview)!.terminal_id : meant();
  const pane = to && L.paneOf(l, to);
  if (!pane) return;
  // The preview in front there, when it is this terminal's; else its first.
  const at = !c.preview && records.previews.get(pane.active ?? '')?.terminal_id === c.id ? pane.active! : to;
  setLayout(c.project, { ...L.select(l, pane.id, at), focus: false });
  if (c.preview) focusTerminal(at);
  else focusPreview(at);
}

/** Where a preview's target can also be opened, in the host's terms: a web address in the browser, a file of text in
 *  the editor, anything else shown in Finder. */
/** Shows a file among its neighbours, in the system's words. */
const REVEAL = `Show in ${FILES}`;
const elsewhere = (p: Row, kind?: FileKind) => (p.kind === 'web' ? 'Open in Browser' : kind && TEXTS.includes(kind) ? 'Open in Editor' : REVEAL);
const open = (p: Row, reveal = false) => void call('host.open', { target: p.target, reveal }).catch(fail);
const tilde = (path: string) => shownPath(path);
/** Who opened it, when it was the agent in its terminal. */
export const openedBy = (p: Row) => (p.by !== 'agent' ? '' : sessionOf(p.terminal_id) ? `Opened by ${agentName(sessionOf(p.terminal_id)!.agent)}` : 'Opened from its terminal');

/** What a preview's tab offers on a right-click. */
export function previewMenu(project: string, p: Row, several: boolean, move: () => void): Item[] {
  const how = elsewhere(p, views.get(p.id)?.file?.kind);
  return [
    { text: 'Reload', key: '⌘R', do: () => reload(p.id) },
    { text: how, do: () => open(p, how === REVEAL) },
    ...(p.kind === 'file' && how !== REVEAL ? [{ text: REVEAL, do: () => open(p, true) }] : []),
    '-',
    ...(several ? [{ text: 'Move Tab To…', do: move }] : []),
    { text: 'Close Tab', key: '⌘W', do: () => closeTab(project, p.id) },
  ];
}

// ——— Markdown, drawn from its data ———

function Words({ s, to }: { s: Inline[]; to: (target: string, e: MouseEvent | KeyboardEvent) => void }): ComponentChildren {
  return s.map((x) =>
    typeof x === 'string' ? x
      : x.t === 'code' ? <code>{x.s}</code>
        : x.t === 'a' ? <a role="link" tabIndex={0} title={x.to} onClick={(e) => to(x.to, e)} onKeyDown={(e) => e.key === 'Enter' && to(x.to, e)}><Words s={x.s} to={to} /></a>
          : x.t === 'b' ? <b><Words s={x.s} to={to} /></b> : <i><Words s={x.s} to={to} /></i>);
}
function Blocks({ blocks, to }: { blocks: Block[]; to: (target: string, e: MouseEvent | KeyboardEvent) => void }): ComponentChildren {
  return blocks.map((b) => {
    if (b.t === 'h') return b.n === 1 ? <h1><Words s={b.s} to={to} /></h1> : b.n === 2 ? <h2><Words s={b.s} to={to} /></h2> : <h3><Words s={b.s} to={to} /></h3>;
    if (b.t === 'p') return <p><Words s={b.s} to={to} /></p>;
    if (b.t === 'code') return <pre>{b.s}</pre>;
    if (b.t === 'hr') return <hr />;
    if (b.t === 'quote') return <blockquote><Blocks blocks={b.blocks} to={to} /></blockquote>;
    if (b.t === 'table')
      return (
        <div class="md-t">
          <table>
            <thead><tr>{b.head.map((c) => <th><Words s={c} to={to} /></th>)}</tr></thead>
            <tbody>{b.rows.map((r) => <tr>{r.map((c) => <td><Words s={c} to={to} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    // A list: each item under its mark (a dot, its number, or its box), set in by its depth.
    let n = b.from - 1;
    return (
      <ul>
        {b.items.map((it) => (
          <li style={{ marginLeft: `${it.depth * 18}px` }}>
            <span class="md-m">{it.done !== undefined ? (it.done ? '☑' : '☐') : b.t === 'ol' && !it.depth ? `${++n}.` : '•'}</span>
            <span><Words s={it.s} to={to} /></span>
          </li>
        ))}
      </ul>
    );
  });
}

// ——— The pane ———

/** A preview in its pane: under the tabs, what it shows and what can be done with it; then the thing itself. */
export function Preview({ p, project, select }: { p: Row; project: string; select: () => void }) {
  const v = view(p.id), frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => void load(p.id), [p.id]);
  // A click into a frame is not this page's to see: the frame having the keyboard says the pane is in use.
  useEffect(() => {
    const entered = () => document.activeElement === frame.current && select();
    addEventListener('blur', entered);
    return () => removeEventListener('blur', entered);
  }, []);
  const kind = v.file?.kind, web = p.kind === 'web', how = elsewhere(p, kind);
  const framed = web ? v.listens : kind === 'html' || kind === 'pdf';
  const text = v.text !== undefined && kind && TEXTS.includes(kind) ? v.text.slice(0, MOST) : undefined;
  const cut = text !== undefined && (v.file!.cut || v.text!.length > MOST);
  // A link in what is shown follows the rule a link in the terminal does, from the folder its file is in.
  const to = (target: string, e: MouseEvent | KeyboardEvent) => {
    e.preventDefault();
    if (target.startsWith('#')) return;
    const web = /^https?:\/\//i.test(target);
    let path = target.replace(/#.*$/, '');
    try {
      path = decodeURI(path);
    } catch {
      // Not escaped as an address is: it is taken as it is written.
    }
    void follow(p.terminal_id, { kind: web ? 'web' : 'path', target: web ? target : path }, p.target.replace(/\/[^/]*$/, ''), e);
  };
  const act = (label: string, f: () => void, k?: string) => <button type="button" class="btn" onClick={f}><span>{label}</span>{k && <Key k={k} />}</button>;
  const shut = () => closeTab(project, p.id);
  return (
    <div class="pv" data-preview={p.id} data-kind={v.said ? 'said' : web ? 'web' : (kind ?? 'loading')} role="tabpanel" aria-label={p.title}>
      <div class="pv-h">
        {p.by === 'agent' && <span class="pv-by">{openedBy(p)}</span>}
        <span class="pv-at" title={p.target}><bdi>{web ? p.target : tilde(p.target)}</bdi></span>
        {v.size && v.picture && <span class="pv-n">{v.size}</span>}
        <span class="pv-do">
          {v.picture && !v.said && act(v.real ? 'Fit' : 'Real Size', () => ((v.real = !v.real), redraw()))}
          {act('Reload', () => reload(p.id), '⌘R')}
          {act(how, () => open(p, how === REVEAL))}
        </span>
      </div>
      {v.said ? (
        <div class="pv-b pv-s" tabIndex={-1} role="status">
          <b>{v.gone ? 'It is gone' : 'Not shown'}</b>
          <p>{v.said}</p>
          <div class="qa">{v.gone && act('Reload', () => reload(p.id))}{act('Close', shut)}</div>
        </div>
      ) : web && v.listens === false ? (
        <div class="pv-b pv-s" tabIndex={-1} role="status">
          <b>Nothing answers yet</b>
          <p>No server answers at {p.title}. It is asked again when this terminal has printed something and gone quiet, when you come back to this window, and with Reload; once one answers, it is shown here.</p>
          <div class="qa">{act('Reload', () => reload(p.id))}{act('Close', shut)}</div>
        </div>
      ) : framed && v.base ? (
        <iframe key={v.turn} ref={frame} class="pv-f" title={p.title} referrerpolicy="no-referrer" sandbox={kind === 'pdf' ? undefined : SANDBOX}
          src={web ? p.target : v.base + encodeURI(asAddress(p.target)).replace(/[?#]/g, encodeURIComponent)} />
      ) : v.picture ? (
        <div class={`pv-b pv-p${v.real ? ' real' : ''}`} tabIndex={-1}>
          <img src={v.picture} alt={p.title} draggable={false} title={v.real ? 'Click to fit it' : 'Click for its real size'}
            onClick={() => ((v.real = !v.real), redraw())}
            onLoad={(e) => ((v.size = `${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`), redraw())} />
        </div>
      ) : text !== undefined ? (
        <div class={`pv-b ${kind === 'markdown' ? 'md' : 'pv-t'}`} tabIndex={-1}>
          {kind === 'markdown' ? <Blocks blocks={parse(text)} to={to} /> : <pre>{text}</pre>}
          {cut && <p class="pv-cut"><span>It goes on: only its beginning is shown here.</span>{act('Open in Editor', () => open(p))}</p>}
        </div>
      ) : kind === 'other' ? (
        <div class="pv-b pv-s" tabIndex={-1} role="status">
          <b>No preview</b>
          <p>A file of this kind is not shown here.</p>
          <div class="qa">{act(REVEAL, () => open(p, true))}{act('Close', shut)}</div>
        </div>
      ) : <div class="pv-b pv-s" tabIndex={-1} role="status"><p>Opening…</p></div>}
      {stopped && framed && (
        <div class="strip" role="status">
          <p class="meta"><b>Stopped</b></p>
          <p class="said">What is shown here asked for <b>{stopped}</b>, which is not on {HERE}. A preview goes nowhere else.</p>
          <div class="qa">{act('Open in Browser', () => (void call('host.open', { target: stopped }).catch(fail), stop('')))}{act('Dismiss', () => stop(''))}</div>
        </div>
      )}
    </div>
  );
}
