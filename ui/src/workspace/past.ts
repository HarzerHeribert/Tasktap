// Thoughts that left the live set, read from the core a page at a time (`history`), each with its questions and
// results: Earlier's rows and a session's older turns. Held while the page runs; nothing is stored. A page is cut
// where its rows stop fitting, also among one thought's questions and results: then the next is asked for from there
// (`after`). A short page is not the end; an empty one is.
import type { Question, Thought } from '../../../core/proto/protocol.ts';
import { call, fail, records, redraw } from '../page.ts';

export const past = { thoughts: [] as Thought[], questions: new Map<string, Question>(), more: true, loading: false };
let before: string | null = null, after: string | undefined;

/** Reads the next page, older than everything read so far. */
export async function older() {
  if (past.loading || !past.more) return;
  past.loading = true;
  redraw();
  try {
    const p = await call('history', { before, ...(after !== undefined && { after }), limit: 100 });
    const have = new Set(past.thoughts.map((t) => t.id));
    past.thoughts.push(...p.thoughts.filter((t) => !have.has(t.id)));
    for (const q of p.questions) past.questions.set(q.id, q);
    for (const r of p.results) records.results.set(r.id, r);
    past.more = p.thoughts.length + p.questions.length + p.results.length > 0;
    before = p.thoughts.at(-1)?.id ?? before;
    after = p.after;
  } catch (e) {
    fail(e);
  } finally {
    past.loading = false;
    redraw();
  }
}
