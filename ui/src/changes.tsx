// Keep and Discard: a thought that ran in its own copy of the project comes back with its changes pending. Keeping
// brings them into the branch the project was on; discarding deletes the copy and its branch. Either waits until the
// session that made them has ended, so a session still running is stopped first, once the person has said so. The
// core answers `conflict` while the session runs and a few seconds after; that is waited out, never shown. What the
// core says when it could not do all of it is shown in its own words, in full: the changes are in and one thing is
// left (said as that, with the one action that finishes it), they went somewhere else, or nothing was done and why.
import { MAX_CREDIT, type Thought } from '../../core/proto/protocol.ts';
import { CallError, uuid7 } from './client.ts';
import { call, client, fail, records, redraw } from './page.ts';
import { Diffstat } from './ui.tsx';

type Changed = Thought & { workdir: NonNullable<Thought['workdir']> };
export const pending = (t: Thought | undefined): t is Changed =>
  !!t && t.workdir?.changes === 'pending' && (t.status === 'done' || t.status === 'failed');
/** A copy with nothing in it to keep: it could not be removed by itself and waits to be. */
export const leftover = (t: Changed) => t.workdir.files + t.workdir.insertions + t.workdir.deletions === 0;

/** What is under way for a thought (stopping its session, settling), or what the core said when it stopped short. */
export type Settling = { keep: boolean; step: 'stopping' | 'settling' } | { keep: boolean; step: 'said'; why: string };
export const settling = new Map<string, Settling>();
const said = (t: Thought) => {
  const s = settling.get(t.id);
  return s?.step === 'said' ? s : undefined;
};
/** The changes are in their branch and only tidying is left: the core says so first. */
const landed = (t: Thought) => !!said(t)?.why.startsWith('The changes are in ');

/** The terminal a thought's session still runs in, if it runs. */
export function running(t: Thought) {
  const s = t.session_id ? records.sessions.get(t.session_id) : undefined;
  const term = s?.terminal_id ? records.terminals.get(s.terminal_id) : undefined;
  return s && s.state !== 'ended' && term?.state === 'running' ? term : undefined;
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const set = (id: string, s: Settling | null) => (s ? settling.set(id, s) : settling.delete(id), redraw());

/** Keeps or discards. The person has already confirmed stopping a running session and any discard. */
export async function settle(t: Thought, keep: boolean) {
  if (settling.get(t.id)?.step === 'stopping' || settling.get(t.id)?.step === 'settling') return;
  const term = running(t);
  if (term) {
    set(t.id, { keep, step: 'stopping' });
    await call('terminal.stop', { id: term.id }).catch(() => {});
    for (let i = 0; i < 50 && records.terminals.get(term.id)?.state === 'running'; i++) await sleep(200);
  }
  set(t.id, { keep, step: 'settling' });
  // The core answers once its git work is done; `conflict` while the session's terminal lets go of the copy.
  for (let i = 0, again = true; ; i++) {
    try {
      await call('thought.settle', { id: t.id, attempt: uuid7(), keep });
      return set(t.id, null);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (e instanceof CallError && e.code === 'conflict' && i < 30) {
        await sleep(i < 5 ? 500 : 1000);
        continue;
      }
      // Just after an agent stops, a process of its own may still be in the copy: once its terminal has ended, once more.
      if (again && why.includes('in use by a process working there')) {
        again = false;
        const id = records.sessions.get(t.session_id ?? '')?.terminal_id;
        for (let n = 0; n < 25 && id && records.terminals.get(id)?.state === 'running'; n++) await sleep(200);
        await sleep(1500);
        continue;
      }
      return set(t.id, { keep, step: 'said', why });
    }
  }
}

/** The main action on changes that wait: Keep; Tidy up, once the changes are in and only that is left; Remove the
 *  copy, where nothing in it is there to keep. */
export const next = (t: Changed) => (leftover(t) ? { label: 'Remove the copy', keep: false } : { label: landed(t) ? 'Tidy up' : 'Keep', keep: true });

/** The words for what Discard deletes. */
export function lost(t: Changed) {
  const w = t.workdir;
  if (leftover(t)) return `The copy of the project that was left over is removed, with whatever is still in it and its branch ${w.branch}. Nothing in it differs from where it started. This cannot be undone.`;
  if (landed(t)) return `The changes stay in ${w.destination}. What is left of the copy is removed, with the branch ${w.branch}.`;
  return `${w.files} ${w.files === 1 ? 'file' : 'files'} with ${w.insertions} lines added and ${w.deletions} removed are deleted, with the branch ${w.branch}. This cannot be undone.`;
}

/** One line for a result's changes: what is under way, the diffstat while they wait, or where they ended. */
export function Status({ t }: { t: Changed }) {
  const s = settling.get(t.id), w = t.workdir;
  if (s?.step === 'stopping') return <span class="said">Stopping the session…</span>;
  if (s?.step === 'settling') return <span class="said">{s.keep ? `Bringing the changes into ${w.destination ?? 'its branch'}…` : 'Discarding…'}</span>;
  if (w.changes === 'kept') return <span class="said">Kept{w.destination ? ` in ${w.destination}` : ''}</span>;
  if (w.changes === 'discarded') return <span class="said">Discarded</span>;
  if (w.changes !== 'pending') return null;
  if (leftover(t)) return <span class="said">Copy left over</span>;
  return (
    <>
      <Diffstat w={w} />
      {w.left_out && <span class="said" title="The project folder had uncommitted changes when this run started; they were left where they are.">Started without your uncommitted changes</span>}
    </>
  );
}

/** The files git names in a refusal, or the core in a conflict, and where that run of names starts and ends. */
function named(text: string) {
  const git = /would be overwritten by \w+: (.+?) (?=Please |Aborting)/.exec(text), core = /conflict with this thought's in (.+?)(?= and \d+ more|\. |$)/.exec(text);
  const m = git ?? core;
  return m && { at: m.index + m[0].length - m[1]!.length - (git ? 1 : 0), names: m[1]!.split(git ? /\s+/ : ', '), length: m[1]!.length };
}
/** The core's words as they are: a command between backticks can be selected and copied; the files are a list. */
function Words({ text }: { text: string }) {
  const files = named(text);
  const plain = (part: string) => part.split('`').map((x, i) => (i % 2 ? <code>{x}</code> : x));
  const command = /`([^`]+)`/.exec(text)?.[1];
  return (
    <>
      {files && files.names.length > 1
        ? <>{plain(text.slice(0, files.at))}<ul>{files.names.map((n) => <li><code>{n}</code></li>)}</ul>{plain(text.slice(files.at + files.length).trimStart())}</>
        : plain(text)}
      {command && <button type="button" class="btn" onClick={() => void call('host.clipboard', { text: command }).catch(fail)}>Copy the command</button>}
    </>
  );
}

/** What the person needs to read before acting, in full, where the core stopped short or a copy was left over. */
export function Told({ t }: { t: Changed }) {
  const s = said(t), w = t.workdir;
  if (settling.get(t.id) && !s) return null;
  if (!s) return leftover(t) ? <p class="told">A copy of the project is left over: it could not be removed by itself. Nothing in it differs from where it started.</p> : null;
  const why = s.why.replace(/^./, (c) => c.toUpperCase()).replace(/([^.])$/, '$1.');
  if (landed(t)) return <p class="told" role="status"><b>Kept, with one thing left.</b> <Words text={why} /></p>;
  if (s.why.includes('when git merged there')) return <p class="told warn" role="alert"><b>The changes went into another branch.</b> <Words text={why} /></p>;
  return <p class="told" role="alert"><b>{s.keep ? `Not kept: ${w.destination ?? 'the project'} is as it was.` : 'Not discarded.'}</b> <Words text={why} /></p>;
}
// ——— The diff: the files in the reply, the text on its stream ———

export type Line = { k: ' ' | '+' | '-' | '@'; t: string; a?: number; b?: number };
export type FileDiff = { path: string; change: string; lines: Line[]; binary: boolean };
export type Review = { files: { path: string; change: string; insertions: number | null; deletions: number | null }[]; more: number; cut: boolean; parsed: FileDiff[]; shown: number; total: number };

/** Lines a review draws at most; the rest is said, not drawn. */
export const MAX_LINES = 3000;

/** Reads a thought's changes: the list at once, then the diff once its stream has ended, parsed into files and lines.
 *  The whole diff fits the credit granted at once (MAX_DIFF is MAX_CREDIT), so none is granted later. */
export async function review(id: string, update: (r: Review) => void) {
  const chunks: Uint8Array[] = [];
  let ended = () => {};
  const end = new Promise<void>((ok) => (ended = ok));
  const { diff } = await client.changes({ id, credit: MAX_CREDIT }, { ondata: (b) => chunks.push(b.slice()), onclose: () => ended() });
  const base = { files: diff.files, more: diff.more, cut: diff.cut, parsed: [], shown: 0, total: 0 };
  update(base);
  await end;
  update({ ...base, ...parse(new TextDecoder().decode(concat(chunks))) });
}

const concat = (cs: Uint8Array[]) => {
  const out = new Uint8Array(cs.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of cs) (out.set(c, at), (at += c.length));
  return out;
};

/** `git diff` text into files and numbered lines, up to MAX_LINES drawn. */
export function parse(text: string): { parsed: FileDiff[]; shown: number; total: number } {
  const parsed: FileDiff[] = [];
  let f: FileDiff | null = null, a = 0, b = 0, shown = 0, total = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = / b\/(.*)$/.exec(raw);
      parsed.push((f = { path: m?.[1] ?? raw.slice(11), change: 'modified', lines: [], binary: false }));
      continue;
    }
    if (!f) continue;
    if (raw.startsWith('new file')) f.change = 'added';
    else if (raw.startsWith('deleted file')) f.change = 'deleted';
    else if (raw.startsWith('Binary files')) f.binary = true;
    else if (raw.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw);
      [a, b] = [Number(m?.[1] ?? 0), Number(m?.[2] ?? 0)];
      total++;
      if (shown < MAX_LINES) (f.lines.push({ k: '@', t: raw.replace(/^@@[^@]*@@ ?/, '') }), shown++);
    } else if (/^[ +-]/.test(raw) && !raw.startsWith('+++') && !raw.startsWith('---')) {
      const k = raw[0] as ' ' | '+' | '-';
      total++;
      if (shown < MAX_LINES) {
        f.lines.push({ k, t: raw.slice(1), a: k === '+' ? undefined : a, b: k === '-' ? undefined : b });
        shown++;
      }
      if (k !== '+') a++;
      if (k !== '-') b++;
    }
  }
  return { parsed, shown, total };
}
