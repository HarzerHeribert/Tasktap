// Sheets: the one mechanism for every interruption inside the window, and one family. A sheet hangs from the title
// bar's lower edge, centred on the window whatever the sidebar does, dims the window behind it, takes the keyboard and
// keeps it until it is dismissed. Every sheet is one frame in one of three sizes, by what it holds (a quick decision,
// a form or a list, a view to read), with one layout: its title, its body (the only part that scrolls), and a foot
// with the way out and the answer at the right, the answer last and in metal when Return gives it, and anything else
// at the left. Return is the metal key, ⌘⌫ the destructive choice, Esc the way out, and so is a click on the dimmed
// window. A sheet comes down plainly: a short drop from behind the bar. None sheds glyphs: a wake lies only where
// there are no words (wake.ts), and a sheet is all words.
import type { ComponentChildren } from 'preact';
import type { Runs } from '../../../core/proto/protocol.ts';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Capture, cap } from '../capture.tsx';
import { uuid7 } from '../client.ts';
import { type Review, Told, lost, next, pending, review, running, settle } from '../changes.tsx';
import { Ask } from '../question.tsx';
import { Answer, Diffstat, I, Key } from '../ui.tsx';
import { hit, spell } from '../keys.ts';
import { mac, plain, shownPath } from '../system.ts';
import * as L from './layout.ts';
import {
  agentName, call, dismiss, fail, finishClose, focus, focusTerminal, keepInBackground, label, layout, open, openWorkspace,
  pickFolder, projectName, projects, quiet, QUIET, byPerson, records, setLayout, stop, title, ui,
} from './model.ts';
import { PlacingSheet, SpeechSheet } from './consent.tsx';
import { SetupSheet } from './setup.tsx';
import { SessionSheet } from './session.tsx';
import { footing } from './form.tsx';
import { Settings } from './settings.tsx';

/** A sheet replaced by another (Review, then Discard) is not dropped again. */
let wasOpen = false;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
import { engines } from './terminal.ts';

export type Act = { k: string; label: string; do: () => void; kind?: 'primary' | 'danger' };

/** The frame of every sheet. `size`: a quick decision (the default), a form or a list (`md`), a view to read (`lg`).
 *  `choices`: answers that are a list of their own (where to move, where to send), each a row of the body with its
 *  key. `acts`: the foot. The way out (Esc) is always there, "Close" unless the sheet names it. `bare`: the body is
 *  the Composer, which has its own key, so there is no title to read and no foot. `guard`: the sheet came by itself
 *  (Setup's first step at the first start), so a key answers it only after 600 ms in which no key was pressed anywhere,
 *  and never one held down (page.ts quiet), so nothing the person was typing, and no Return pressed twice, lands on
 *  its answer; one it holds back is said in its foot, and a key it does not take at all is the Composer's, given to it
 *  by `typed`, never swallowed (NOTES §13). `hint`: the foot has a place of a fixed height at its left for a line that
 *  comes and goes (null: empty), which Settings fills with the hint of the row pointed at or focused (form.tsx `foot`). Escape, which only puts it away, and a click are the person's at once. */
export function Frame({ title: name, aside, children, choices = [], acts = [], size = 'sm', bare, guard = false, typed, hint }: {
  title: ComponentChildren; aside?: ComponentChildren; children?: ComponentChildren; choices?: Act[]; acts?: Act[]; size?: 'sm' | 'md' | 'lg'; bare?: boolean; guard?: boolean;
  typed?: () => void; hint?: ComponentChildren;
}) {
  const [held, hold] = useState('');
  // A sheet that came by itself is guarded whoever draws it, from the moment it came.
  const self = guard || (ui.sheet?.kind === 'setup' && !!ui.sheet.auto);
  const out = acts.find((x) => x.k === 'esc') ?? { k: 'esc', label: 'Close', do: dismiss };
  const rest = acts.filter((x) => x.k !== 'esc');
  // What Return gives, and since when: from the moment a sheet that came by itself came; and on every sheet, again from
  // the moment it appears or changes by itself (the core's answer turns "Searching…" into a question), never by the
  // person's own key or click. A Return within 600 ms of that is held back: one meant for what was there before, or
  // pressed twice, never answers what the person has not seen.
  const returns = [...choices, ...rest].find((x) => x.k === '↩')?.label ?? '';
  const since = useRef({ what: returns, at: self ? performance.now() : -Infinity });
  if (since.current.what !== returns) since.current = { what: returns, at: byPerson() ? since.current.at : performance.now() };
  // The answer: the one Return gives, else the only one there is, unless the answers are a list of their own.
  const main = rest.find((x) => x.kind === 'primary') ?? (rest.length === 1 && !choices.length ? rest[0] : undefined);
  // Escape does what the answer does (a sheet that only reports): one key is shown, the answer's; Escape still works.
  const one = !!main && main.do === out.do;
  /** `beside`: the key was pressed in the Composer's field, which keeps the keyboard while a sheet that came by itself
   *  is over it, so that whatever the person types, however (a dead key, an input method, a paste, a space), goes there:
   *  then Return with the field empty is the sheet's answer, and Escape and the sheet's ⌘ keys are the sheet's. */
  const keys = (e: KeyboardEvent, beside = false) => {
    if (beside && (e.isComposing || (e.target as HTMLTextAreaElement).value?.trim())) return;
    const typing = !beside && (e.target as HTMLElement).matches('input, textarea');
    const act = [...choices, ...rest, out].find((x) => (beside && x.k === '↩' ? e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey : matches(x.k, e, typing || (beside && x.k.length === 1))));
    // Return or Space on a button of it is the browser's press of that button, and held back the same.
    const press = !beside && !act && (e.key === 'Enter' || e.key === ' ') && !!(e.target as HTMLElement).closest('button');
    // Two clocks (the review's N3): no key in the sheet's first 600 ms, nor within 600 ms of the last key anywhere; and on
    // any sheet, no Return within 600 ms of its answer appearing or changing by itself.
    const early = self ? !quiet(e, since.current.at) : e.key === 'Enter' && performance.now() - since.current.at < QUIET;
    if (early && (act ? act !== out : press)) {
      e.preventDefault();
      e.stopPropagation();
      const k = act ? act.k : e.key === ' ' ? 'Space' : '↩';
      return hold(`You were typing: press ${said(k)} again${act ? ` to ${toDo(act.label)}` : ''}.`);
    }
    if (!act) {
      // Text, typed with the keyboard on the sheet (after Tab, or a click): the Composer's, with the keyboard, the
      // sheet put away (as Not now). A character with Option or AltGr, a dead key or an input method's first key too.
      const text = (e.key.length === 1 && !e.metaKey && !(e.ctrlKey && !e.altKey)) || e.key === 'Dead' || e.key === 'Process' || e.keyCode === 229;
      if (self && typed && !typing && !beside && !press && text) typed();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    hold('');
    act.do();
  };
  // While the keyboard is in the Composer under it, the sheet is not modal (a screen reader would hide the field that
  // has the keyboard): the field is described by the sheet's title and words, and the sheet's arrival is said once, in a
  // polite live region. With the keyboard in it (Tab), it is modal as any sheet.
  const [inside, setInside] = useState(false);
  useLayoutEffect(() => {
    const field = self && !inside ? document.querySelector<HTMLElement>('.home #capture-input') : null;
    field?.setAttribute('aria-describedby', 'sheet-title sheet-body');
    return () => field?.removeAttribute('aria-describedby');
  }, [self, inside]);
  useEffect(() => {
    if (!self) return undefined;
    const live = document.getElementById('sheet-said') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'sheet-said', className: 'sr' }));
    live.setAttribute('aria-live', 'polite');
    const t = setTimeout(() => (live.textContent = [document.getElementById('sheet-title')?.textContent, document.getElementById('sheet-body')?.textContent].filter(Boolean).join('. ')), 100);
    return () => (clearTimeout(t), (live.textContent = ''));
  }, []);
  // A sheet that came by itself leaves the keyboard in the Composer's field (Sheets): its keys are taken there, and
  // the first text that lands in the field (typed, composed, pasted, dropped) puts the sheet away as Not now.
  useLayoutEffect(() => {
    if (!self) return undefined;
    const inField = (e: Event) => (e.target as HTMLElement)?.id === 'capture-input' && !(e.target as HTMLElement).closest('.sheet');
    const down = (e: KeyboardEvent) => inField(e) && keys(e, true);
    // After the field's own handler has taken the text (so the render that puts the sheet away keeps it).
    const input = (e: Event) => inField(e) && (e.target as HTMLTextAreaElement).value && queueMicrotask(() => typed?.());
    document.addEventListener('keydown', down, true);
    document.addEventListener('input', input);
    return () => (document.removeEventListener('keydown', down, true), document.removeEventListener('input', input));
  });
  const answer = (x: Act) => <Answer cls="act" k={x.k} label={x.label} danger={x.kind === 'danger'} onClick={x.do} />;
  return (
    <div class={`sheet ${size}${bare ? ' bare' : ''}`} role="dialog" aria-modal={!self || inside ? 'true' : 'false'} aria-labelledby="sheet-title" aria-describedby="sheet-body" tabIndex={-1} data-keys={self ? 'composer' : true} onKeyDown={(e) => keys(e)}
      onFocusIn={() => setInside(true)} onFocusOut={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setInside(false)}>
      <header class="sh-h"><h2 id="sheet-title">{name}</h2>{aside}</header>
      <div class="sh-b" id="sheet-body">
        {children}
        {choices.length > 0 && <div class="choices">{choices.map(answer)}</div>}
      </div>
      {!bare && (
        <footer class="sh-f">
          {hint !== undefined && <p class="sh-hint"><span>{hint}</span></p>}
          {rest.filter((x) => x !== main).map(answer)}
          {held && <span class="sh-held" role="status">{held}</span>}
          <span class="sh-r">
            {!one && answer(out)}
            {main && (main.kind !== 'primary' ? answer(main)
              : <button type="button" class="key" onClick={main.do}>{main.k === '↩' && <I n="ret" />}<span>{main.label}</span>{main.k !== '↩' && <Key k={main.k} />}</button>)}
          </span>
        </footer>
      )}
    </div>
  );
}
const cancel: Act = { k: 'esc', label: 'Cancel', do: dismiss };
/** Whether a key press is the one a choice's key cap shows. Return never presses a choice while a button or a field
 *  has the keyboard: those take it themselves. */
/** What an answer does, as the end of "press Return again to …": its label as a verb, "close" for one that only
 *  puts the sheet away (Done, Close, OK). */
const toDo = (label: string) => (/^(Done|Close|OK)$/.test(label) ? 'close' : label.replace(/…$/, '').toLowerCase());
/** A key as a sentence says it: Return (Enter off the Mac), Space, Escape, else as its cap spells it. */
const said = (k: string) => (k === '↩' ? (mac ? 'Return' : 'Enter') : k === 'Space' ? 'Space' : k === 'esc' ? 'Escape' : spell(k));
function matches(k: string, e: KeyboardEvent, typing: boolean) {
  if (e.isComposing) return false;
  const on = (e.target as HTMLElement).closest('button');
  if (k === 'esc') return e.key === 'Escape';
  if (k === '↩') return e.key === 'Enter' && !e.shiftKey && !e.metaKey && !on && !typing;
  if (k === '⇧↩') return e.key === 'Enter' && e.shiftKey && !typing;
  // Control-Backspace takes a word out of a field on Windows: there it is the field's while one has the keyboard.
  if (k === '⌘⌫') return hit(k, e) && (mac || !typing);
  if (k.startsWith('⌘')) return hit(k, e);
  return !typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === k.toLowerCase();
}
const quote = (s: string) => `“${s.length > 60 ? s.slice(0, 59) + '…' : s}”`;

/** Names in a sentence: "a", "a and b", "a, b and c". */
const and = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
/** A program's command line, cut where a sentence would lose it. */
const program = (what: string) => (what.length > 48 ? what.slice(0, 47) + '…' : what);

/** What the core says runs in one terminal, as the sentence a close begins with. */
function runsWords(runs: Runs) {
  if (runs.state === 'unknown') return 'Tasktap cannot tell what runs in it.';
  const what = runs.what.map(program);
  return `${and(what)} ${what.length > 1 ? 'are' : 'is'} running in it.`;
}

/** What runs where in a workspace, in one sentence: "Still running: npm run dev in “zsh”, and Claude Code in “Fix
 *  the login”." */
function runsWhere(busy: { id: string; runs: Runs }[]) {
  const parts = busy.map(({ id, runs }) => `${runs.state === 'unknown' ? 'what Tasktap cannot name' : and(runs.what.map(program))} in ${quote(label(id))}`);
  const last = parts.length > 1 ? `, and ${parts.pop()}` : '';
  return `Still running: ${parts.join(', ')}${last}.`;
}

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
    <Frame size="md" title="Open a folder" acts={[{ k: '↩', label: 'Choose a folder…', do: () => void pickFolder(), kind: 'primary' }, cancel]}>
      <p>The folder you choose becomes a workspace. A task goes to the folder it belongs to.</p>
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
              <button type="button" class="line" title={plain(p.folder)} onClick={() => void openWorkspace(p.folder)}>
                <span class="t">{p.name}</span><span class="x mono">{p.available ? shownPath(p.folder) : 'Folder unavailable'}</span>
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
    <Frame size="lg" title={title(t)} aside={changes && <Diffstat w={changes.workdir} />} acts={acts}>
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
      const words = d.runs.session ? 'It can keep running under its workspace in the sidebar, or stop now. Its history stays either way.'
        : 'It can keep running in the sidebar, under its workspace, or stop now.';
      return (
        <Frame title={`Close ${quote(label(d.id))}?`} acts={[
          { k: '↩', label: 'Keep running in background', kind: 'primary', do: () => keepInBackground(d.project, d.id) },
          { k: '⌘⌫', label: 'Stop session', kind: 'danger', do: () => stop(d.project, d.id) },
          cancel,
        ]}><p>{runsWords(d.runs)} {words}</p></Frame>
      );
    }
    case 'stop':
      return (
        <Frame title={`Stop ${quote(label(d.id))}?`} acts={[{ k: '⌘⌫', label: 'Stop session', kind: 'danger', do: () => stop(d.project, d.id) }, cancel]}>
          <p>{d.runs ? `${runsWords(d.runs)} ` : ''}This ends its process. Its history stays in the terminal.</p>
        </Frame>
      );
    case 'close-workspace':
      return (
        <Frame title={`Close ${projectName(d.project)}?`}
          acts={[{ k: '⌘⌫', label: 'Stop and close', kind: 'danger', do: () => void finishClose(d.project, true) }, cancel]}>
          <p>{runsWhere(d.busy)} Closing it stops its terminals, those in the background too. The files, the history and the layout stay.</p>
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
        <Frame title={`Move ${quote(label(d.id))} to`} acts={[cancel]} choices={others.slice(0, 9).map((p, i) => ({ k: String(i + 1), label: p.active ? `Beside ${label(p.active)}` : 'An empty pane', do: () => {
          setLayout(d.project, L.move(layout(d.project), d.id, p.id));
          dismiss();
          focusTerminal(d.id);
        } }))} />
      );
    }
    case 'capture':
      return (
        <Frame bare title="New task">
          <Capture asks started={dismiss} agents={() => open({ kind: 'settings', at: 'agents' })} speech={() => open({ kind: 'setup', step: 'speech' })} />
        </Frame>
      );
    case 'settings':
      return <Frame size="lg" title="Settings" hint={footing()}><Settings at={d.at ?? 'thoughts'} /></Frame>;
    case 'placing':
      return <PlacingSheet back={d.back} />;
    case 'speech':
      return <SpeechSheet />;
    case 'setup':
      return <SetupSheet step={d.step} auto={d.auto} />;
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
    case 'session':
      return <SessionSheet id={d.id} />;
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
        <Frame title={t ? `Send ${quote(title(t))} to` : 'Send to'} choices={folders.slice(0, 9).map((p, i) => ({ k: String(i + 1), label: p.name, do: () => to(p.id) }))} acts={[
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

export function Sheets() {
  const d = ui.sheet;
  // Settings is one sheet whichever of its sections is shown.
  const key = !d ? '' : d.kind === 'settings' ? d.kind : JSON.stringify(d);
  useLayoutEffect(() => {
    if (!d) return;
    const sheet = document.querySelector<HTMLElement>('.sheet');
    // It comes down plainly, a short way from behind the bar, as the window dims; one that replaces another is there at once.
    if (sheet && !wasOpen && !reduced.matches && !(d.kind === 'setup' && d.auto)) {
      const drop = { duration: 160, easing: 'cubic-bezier(.19,.76,.19,1)' };
      sheet.animate({ opacity: [0, 1], transform: ['translate(-50%,-14px)', 'translate(-50%,0)'] }, drop);
      sheet.previousElementSibling?.animate({ opacity: [0, 1] }, drop);
    }
    wasOpen = true;
    // The sheet takes the keyboard at once, without the ring a key press would show: the first thing a person would
    // use where there is one (a field, the first answer, Settings' open section), else the sheet, whose keys then act.
    // One that came by itself leaves it in Home's Composer, where whatever the person types goes (Frame).
    const self = d.kind === 'setup' && d.auto ? document.querySelector<HTMLElement>('.home #capture-input') : null;
    focus(self ?? sheet?.querySelector<HTMLElement>('#capture-input, #find-text, .field input, .ask-notch .ans, .reply input, [role=tab][aria-selected=true]') ?? sheet);
  }, [key]);
  // Tab stays inside the sheet, from the moment it is there; the trap of the sheet before goes the same moment (one
  // that came by itself would give Shift-Tab to the Composer behind this one).
  useLayoutEffect(() => {
    if (!d) return undefined;
    const trap = (e: KeyboardEvent) => {
      const sheet = document.querySelector<HTMLElement>('.sheet');
      if (e.key !== 'Tab' || !sheet) return;
      const all = [...sheet.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]')].filter((x) => !x.hidden && x.tabIndex >= 0);
      const at = all.indexOf(document.activeElement as HTMLElement);
      // One that came by itself: Shift-Tab from its first control gives the keyboard back to the Composer under it.
      const field = d.kind === 'setup' && d.auto && e.shiftKey && at === 0 ? document.querySelector<HTMLElement>('.home #capture-input') : null;
      if (field) return (e.preventDefault(), field.focus());
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
