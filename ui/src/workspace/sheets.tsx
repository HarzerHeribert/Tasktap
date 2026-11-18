// Sheets: the one mechanism for every interruption inside the window. A sheet hangs from the title bar's lower edge,
// dims the window behind it, takes the keyboard and keeps it until it is dismissed: Return is its default, ⌘⌫ its
// destructive choice, Esc cancels, and so does a click on the dimmed window.
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Capture, cap } from '../capture.tsx';
import { uuid7 } from '../client.ts';
import { type Review, Told, lost, next, pending, review, running, settle } from '../changes.tsx';
import { Ask } from '../question.tsx';
import { Answer, Diffstat, I, Ring } from '../ui.tsx';
import * as L from './layout.ts';
import {
  LOOSE, agentName, call, dismiss, fail, finishClose, focus, focusTerminal, keepInBackground, label, layout, newTerminal, open, openWorkspace,
  pickFolder, projectName, projects, records, setLayout, stop, title, ui,
} from './model.ts';
import { wakeLook } from './light.tsx';
import { Settings } from './settings.tsx';

/** A sheet replaced by another (Review, then Discard) is not dropped again. */
let wasOpen = false;
import { engines } from './terminal.ts';
import { wake } from './wake.ts';

type Act = { k: string; label: string; do: () => void; kind?: 'primary' | 'danger' };

/** The sheet's frame: title, words, and its choices as rows of key cap and label. */
function Frame({ title: name, children, acts = [], wide }: { title: ComponentChildren; children?: ComponentChildren; acts?: Act[]; wide?: 'list' | 'capture' | 'review' }) {
  const ref = useRef<HTMLDivElement>(null);
  const keys = (e: KeyboardEvent) => {
    const typing = (e.target as HTMLElement).matches('input, textarea');
    const act = acts.find((a) => matches(a.k, e, typing));
    if (e.key === 'Escape' && !act) return (e.preventDefault(), dismiss());
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    act.do();
  };
  return (
    <div class={`sheet${wide ? ' ' + wide : ''}`} role="dialog" aria-modal="true" aria-labelledby="sheet-title" ref={ref} tabIndex={-1} onKeyDown={keys}>
      <header><h2 id="sheet-title">{name}</h2>{wide && wide !== 'capture' && <kbd class="esc">esc</kbd>}</header>
      {children}
      {acts.length > 0 && (
        <div class="acts">
          {acts.map((a) => <Answer cls="act" k={a.k} label={a.label} primary={a.kind === 'primary'} danger={a.kind === 'danger'} onClick={a.do} />)}
        </div>
      )}
    </div>
  );
}
const cancel: Act = { k: 'esc', label: 'Cancel', do: dismiss };
/** Whether a key press is the one a choice's key cap shows. Return never presses a choice while a button or a field
 *  has the keyboard: those take it themselves. */
function matches(k: string, e: KeyboardEvent, typing: boolean) {
  if (e.isComposing) return false;
  const on = (e.target as HTMLElement).closest('button');
  if (k === 'esc') return e.key === 'Escape';
  if (k === '↩') return e.key === 'Enter' && !e.shiftKey && !e.metaKey && !on && !typing;
  if (k === '⇧↩') return e.key === 'Enter' && e.shiftKey && !typing;
  if (k === '⌘⌫') return e.key === 'Backspace' && e.metaKey;
  if (k.startsWith('⌘')) return e.metaKey && e.key.toLowerCase() === k.slice(1).toLowerCase();
  return !typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === k.toLowerCase();
}
const quote = (s: string) => `“${s.length > 60 ? s.slice(0, 59) + '…' : s}”`;

function Find({ id }: { id: string }) {
  const [said, say] = useState('');
  const find = (back: boolean) => {
    const text = document.querySelector<HTMLInputElement>('#find-text')?.value ?? '';
    if (!text) return;
    const s = engines.get(id)?.search;
    const found = back ? s?.findPrevious(text) : s?.findNext(text);
    say(found ? '' : 'Not in the scrollback');
  };
  return (
    <Frame title={`Find in ${label(id)}`} acts={[{ k: '↩', label: 'Next', do: () => find(false), kind: 'primary' }, { k: '⇧↩', label: 'Previous', do: () => find(true) }, { k: 'esc', label: 'Close', do: () => (dismiss(), focusTerminal(id)) }]}>
      <label class="field"><I n="search" />
        <input id="find-text" type="search" autocomplete="off" spellcheck={false} placeholder="Find" aria-label="Find"
          onKeyDown={(e) => e.key === 'Enter' && !e.isComposing && (e.preventDefault(), find(e.shiftKey))} />
        <span id="find-state" role="status">{said}</span>
      </label>
    </Frame>
  );
}

function Picker() {
  const [query, setQuery] = useState('');
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const all = [...records.projects.values()].filter((p) => !p.open && p.kind === 'folder');
  const closed = all.filter((p) => words.every((w) => `${p.name} ${p.folder}`.toLocaleLowerCase().includes(w)));
  return (
    <Frame wide="list" title="Open a folder" acts={[{ k: '↩', label: 'Choose a folder…', do: () => void pickFolder(), kind: 'primary' }, cancel]}>
      <p>It becomes a workspace. A thought goes to the folder it belongs to.</p>
      {all.length > 0 && (
        <>
          {all.length > 6 && (
            <label class="field"><I n="search" />
              <input type="search" placeholder="Find a closed workspace" autocomplete="off" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
            </label>
          )}
          <h3>Open again</h3>
          <div class="list">
            {closed.map((p) => (
              <button type="button" class="line" title={p.folder} onClick={() => void openWorkspace(p.folder)}>
                <span class="t">{p.name}</span><span class="x mono">{p.available ? p.folder.replace(/^\/Users\/[^/]+/, '~') : 'Folder unavailable'}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </Frame>
  );
}

/** The changes of a thought: its files, then the diff, each line marked by its sign as well as its shade. */
function ReviewSheet({ id }: { id: string }) {
  const t = records.thoughts.get(id);
  const [r, setR] = useState<Review | null>(null);
  const [error, setError] = useState('');
  useEffect(() => void review(id, setR).catch((e) => setError(e instanceof Error ? e.message : String(e))), [id]);
  if (!t) return null;
  const changes = pending(t) ? t : null;
  const go = (path: string) => document.getElementById(`diff-${path}`)?.scrollIntoView({ block: 'start' });
  const main = changes && next(changes);
  const discard = () => open({ kind: 'settle', thought: id, keep: false });
  const acts: Act[] = [
    ...(main ? [{ k: '↩', label: main.label, kind: 'primary' as const, do: () => (!main.keep ? discard() : running(changes) ? open({ kind: 'settle', thought: id, keep: true }) : (dismiss(), void settle(changes, true))) }] : []),
    ...(main?.keep ? [{ k: 'D', label: 'Discard', do: discard }] : []),
    { k: 'esc', label: 'Close', do: dismiss },
  ];
  return (
    <Frame wide="review" title={<>{title(t)} {changes && <Diffstat w={changes.workdir} />}</>} acts={acts}>
      <div class="review">
        {changes && <Told t={changes} />}
        {error && <p class="said">{error}</p>}
        {!r && !error && <p class="said">Reading the changes…</p>}
        {r && (
          <>
            <div class="files">
              {r.files.map((f) => (
                <button type="button" class="file" onClick={() => go(f.path)}>
                  <span class="ch">{f.change === 'added' ? 'A' : f.change === 'deleted' ? 'D' : f.change === 'type' ? 'T' : 'M'}</span>
                  <span class="path">{f.path}</span>
                  <span class="diff">{f.insertions === null ? 'binary' : <><i class="p">+{f.insertions}</i> <i class="m">−{f.deletions}</i></>}</span>
                </button>
              ))}
              {r.more > 0 && <p class="said">and {r.more} more {r.more === 1 ? 'file' : 'files'}</p>}
            </div>
            <div class="code">
              {r.parsed.map((f) => (
                <section id={`diff-${f.path}`}>
                  <h4>{f.path}{f.change !== 'modified' && <span> {f.change}</span>}</h4>
                  {f.binary ? <p class="said">A binary file: no lines to show.</p> : (
                    <table>
                      {f.lines.map((l) => l.k === '@' ? <tr class="h"><td colSpan={3}>{l.t || '⋯'}</td></tr> : (
                        <tr class={l.k === '+' ? 'add' : l.k === '-' ? 'del' : ''}>
                          <td class="n">{l.k === '+' ? '' : l.a}</td><td class="n">{l.k === '-' ? '' : l.b}</td>
                          <td class="t"><span class="sign">{l.k === ' ' ? ' ' : l.k === '+' ? '+' : '−'}</span>{l.t}</td>
                        </tr>
                      ))}
                    </table>
                  )}
                </section>
              ))}
              {r.total > r.shown && <p class="said cut">Showing the first {r.shown.toLocaleString()} of {r.total.toLocaleString()} lines. All of it is on the branch <code>{t.workdir?.branch}</code>.</p>}
              {r.cut && <p class="said cut">The diff is larger than this view reads; it stops here. All of it is on the branch <code>{t.workdir?.branch}</code>.</p>}
            </div>
          </>
        )}
      </div>
    </Frame>
  );
}

function Body() {
  const d = ui.sheet;
  if (!d) return null;
  switch (d.kind) {
    case 'close-tab': {
      const name = label(d.id);
      const words = records.terminals.get(d.id)?.kind === 'shell' ? 'It can keep running in the sidebar, under its workspace, or stop now.'
        : 'It can keep running under its workspace in the sidebar, or stop now. Its history stays either way.';
      return (
        <Frame title={`Close ${quote(name)}?`} acts={[
          { k: '↩', label: 'Keep running in background', kind: 'primary', do: () => keepInBackground(d.project, d.id) },
          { k: '⌘⌫', label: 'Stop session', kind: 'danger', do: () => stop(d.project, d.id) },
          cancel,
        ]}><p>{words}</p></Frame>
      );
    }
    case 'stop':
      return (
        <Frame title={`Stop ${quote(label(d.id))}?`} acts={[{ k: '⌘⌫', label: 'Stop session', kind: 'danger', do: () => stop(d.project, d.id) }, cancel]}>
          <p>This ends its process. Its history stays in the terminal.</p>
        </Frame>
      );
    case 'close-workspace':
      return (
        <Frame title={`Close ${projectName(d.project)} and stop ${d.count === 1 ? 'its session' : `${d.count} sessions`}?`}
          acts={[{ k: '⌘⌫', label: 'Stop and close', kind: 'danger', do: () => void finishClose(d.project, true) }, cancel]}>
          <p>Its terminals end, those in the background too. The files, the history and the layout stay.</p>
        </Frame>
      );
    case 'open-workspace':
      return <Picker />;
    case 'find':
      return <Find id={d.id} />;
    case 'move': {
      const l = layout(d.project);
      const from = L.paneOf(l, d.id);
      const others = L.panes(l).filter((p) => p !== from);
      return (
        <Frame title={`Move ${quote(label(d.id))} to`} acts={[
          ...others.slice(0, 9).map((p, i) => ({ k: String(i + 1), label: p.active ? `Beside ${label(p.active)}` : 'An empty pane', do: () => {
            setLayout(d.project, L.move(layout(d.project), d.id, p.id));
            dismiss();
            focusTerminal(d.id);
          } })),
          cancel,
        ]} />
      );
    }
    case 'capture':
      return (
        <Frame wide="capture" title="New task">
          <Capture started={dismiss} agents={() => open({ kind: 'agents' })} />
        </Frame>
      );
    case 'settings':
      return <Frame wide="list" title="Settings"><Settings /></Frame>;
    case 'agents':
      return <Frame wide="list" title="Agents"><Agents /></Frame>;
    case 'reply': {
      const q = records.questions.get(d.question);
      if (!q || q.state !== 'open') return <Frame title="Answered" acts={[{ k: 'esc', label: 'Close', do: dismiss }]} />;
      const t = q.thought_id ? records.thoughts.get(q.thought_id) : undefined;
      return (
        <Frame title={t ? quote(title(t)) : 'A question'} acts={[cancel]}>
          <Ask q={q} size="notch" />
        </Frame>
      );
    }
    case 'review':
      return <ReviewSheet id={d.thought} />;
    case 'settle': {
      const t = records.thoughts.get(d.thought);
      if (!pending(t)) return <Frame title="Settled" acts={[{ k: 'esc', label: 'Close', do: dismiss }]}><p>{t?.workdir?.changes === 'kept' ? `Its changes are in ${t.workdir.destination ?? 'their branch'}.` : 'Its changes were discarded.'}</p></Frame>;
      const live = running(t);
      const go = () => (dismiss(), void settle(t, d.keep));
      const s = t.session_id ? records.sessions.get(t.session_id) : undefined;
      return d.keep ? (
        <Frame title="Stop the session and keep?" acts={[{ k: '↩', label: 'Stop and keep', kind: 'primary', do: go }, cancel]}>
          <p>{agentName(s?.agent ?? t.agent)} is still running in its terminal. Its changes can be kept once it has stopped; its history stays.</p>
        </Frame>
      ) : (
        <Frame title={next(t).keep ? `Discard the changes of ${quote(title(t))}?` : `Remove the copy left by ${quote(title(t))}?`} acts={[{ k: '⌘⌫', label: live ? 'Stop and discard' : next(t).keep ? 'Discard' : 'Remove the copy', kind: 'danger', do: go }, cancel]}>
          <p>{live ? 'Its session is stopped first. ' : ''}{lost(t)}</p>
        </Frame>
      );
    }
    case 'send': {
      const t = records.thoughts.get(d.thought);
      const folders = projects().filter((p) => p.kind === 'folder');
      const to = (project: string) => {
        dismiss();
        void call('thought.update', { id: d.thought, project_id: project }).catch(fail);
      };
      return (
        <Frame title={t ? `Send ${quote(title(t))} to` : 'Send to'} acts={[
          ...folders.slice(0, 9).map((p, i) => ({ k: String(i + 1), label: p.name, do: () => to(p.id) })),
          { k: '⌘O', label: 'Open a folder…', do: async () => {
            const folder = await call('host.pick', { folder: true }).catch(fail);
            if (!folder) return;
            const id = await call('project.add', { id: uuid7(), folder }).catch(fail);
            if (id) to(id);
          } },
          cancel,
        ]}><p>It starts there with the agent you use, as a new task would.</p></Frame>
      );
    }
  }
}

/** The agents this Mac has, with how each is signed in, and a terminal to sign in to one that is not. */
const signIn: Record<string, string> = { claude: 'claude', codex: 'codex login' };
export function Agents() {
  const agents = [...records.agents.values()];
  if (!agents.length) return <p>Looking for agents…</p>;
  return (
    <div class="list">
      {agents.map((a) => {
        const off = a.installed && a.signed_in === false;
        const state = !a.installed ? 'not installed' : a.signed_in === false ? 'not signed in' : a.signed_in ? 'signed in' : 'installed';
        return (
          <div class="line ag" data-s={off || !a.installed ? 'off' : undefined}>
            <Ring agent={a.id} s={off || !a.installed ? 'off' : ''} />
            <span class="t">{agentName(a.id)}</span>
            <span class="x">{[a.version, state, a.identity].filter(Boolean).join(' · ')}</span>
            {off && signIn[a.id] && (
              <button type="button" class="btn" onClick={() => (dismiss(), newTerminal(LOOSE, { title: `Sign in to ${agentName(a.id)}`, type: signIn[a.id] }))}>Sign in</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function Sheets() {
  const d = ui.sheet;
  const key = d ? JSON.stringify(d) : '';
  useLayoutEffect(() => {
    if (!d) return;
    // The sheet takes the keyboard at once, without the ring a key press would show.
    const sheet = document.querySelector<HTMLElement>('.sheet');
    // As it drops, its edge sheds a short wake of glyphs on the sheet it reveals.
    if (sheet && !wasOpen) wake(sheet, 'y', wakeLook());
    wasOpen = true;
    focus(sheet?.querySelector<HTMLElement>('#capture-input, #find-text, .field input, .ask-notch .ans, .reply input') ?? sheet);
  }, [key]);
  // Tab stays inside the sheet.
  useEffect(() => {
    if (!d) return undefined;
    const trap = (e: KeyboardEvent) => {
      const sheet = document.querySelector<HTMLElement>('.sheet');
      if (e.key !== 'Tab' || !sheet) return;
      const all = [...sheet.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]')].filter((x) => !x.hidden);
      const at = all.indexOf(document.activeElement as HTMLElement);
      if (at === -1 || (e.shiftKey ? at === 0 : at === all.length - 1)) {
        e.preventDefault();
        all[e.shiftKey ? all.length - 1 : 0]?.focus();
      }
    };
    document.addEventListener('keydown', trap, true);
    return () => document.removeEventListener('keydown', trap, true);
  }, [key]);
  if (!d) return ((wasOpen = false), null);
  return (
    <>
      <div class="scrim" onPointerDown={() => (cap.choosing = false, dismiss())} />
      <Body />
    </>
  );
}
