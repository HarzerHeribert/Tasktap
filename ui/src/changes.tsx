// Keep and Discard: a thought that ran in its own copy of the project comes back with its changes pending. Keeping
// brings them into the branch the project was on; discarding deletes the copy and its branch. Either waits until the
// session that made them has ended, so a session still running is stopped first, once the person has said so. The
// core answers `conflict` while the session runs and a few seconds after; that is waited out, never shown.
import { MAX_CREDIT, type Thought } from '../../core/proto/protocol.ts';
import { CallError, uuid7 } from './client.ts';
import { call, client, records, redraw } from './page.ts';
import { Diffstat } from './ui.tsx';

export const pending = (t: Thought | undefined): t is Thought & { workdir: NonNullable<Thought['workdir']> } =>
  !!t && t.workdir?.changes === 'pending' && (t.status === 'done' || t.status === 'failed');

/** What is under way or came back for a thought: stopping its session, settling, or a refusal in the core's words. */
export type Settling = { keep: boolean; step: 'stopping' | 'settling' } | { keep: boolean; step: 'refused'; why: string };
export const settling = new Map<string, Settling>();

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
  for (let i = 0; ; i++) {
    try {
      await call('thought.settle', { id: t.id, attempt: uuid7(), keep });
      return set(t.id, null);
    } catch (e) {
      if (e instanceof CallError && e.code === 'conflict' && i < 30) {
        await sleep(i < 5 ? 500 : 1000);
        continue;
      }
      return set(t.id, { keep, step: 'refused', why: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** The words for what Discard deletes. */
export function lost(t: Thought & { workdir: NonNullable<Thought['workdir']> }) {
  const w = t.workdir;
  return `${w.files} ${w.files === 1 ? 'file' : 'files'} with ${w.insertions} lines added and ${w.deletions} removed are deleted, with the branch ${w.branch}. This cannot be undone.`;
}

/** What a result with changes says under its summary: the diffstat, what is under way, or why Keep was refused. */
export function Status({ t }: { t: Thought & { workdir: NonNullable<Thought['workdir']> } }) {
  const s = settling.get(t.id), w = t.workdir;
  if (s?.step === 'stopping') return <span class="said">Stopping the session…</span>;
  if (s?.step === 'settling') return <span class="said">{s.keep ? `Bringing the changes into ${w.destination ?? 'its branch'}…` : 'Discarding…'}</span>;
  if (s?.step === 'refused')
    return (
      <span class="said refused" role="alert">
        {s.keep ? 'Keep was refused' : 'Discard was refused'}: {s.why}{s.keep && <> The changes are on the branch <code>{w.branch}</code>; merge it by hand{w.destination ? ` into ${w.destination}` : ''}.</>}
      </span>
    );
  return (
    <>
      <Diffstat w={w} />
      {w.left_out && <span class="said" title="The project folder had uncommitted changes when this run started; they were left where they are.">Started without your uncommitted changes</span>}
    </>
  );
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
