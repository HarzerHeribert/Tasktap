// What every page has: its one connection to the core, the records it holds, one redraw, the
// element to focus next, and the words the records are shown in. Each page's bundle has its own.
import type { AgentHealth, Question, Thought, TurnResult } from '../../core/proto/protocol.ts';
import { tauriBridge } from './bridge.ts';
import { Client, Records } from './client.ts';

export const client = new Client(tauriBridge());
export const records = new Records();
export const call: typeof client.call = (name, args) => client.call(name, args);

let redrawn = () => {};
export const redraw = () => redrawn();
export const onRedraw = (f: () => void) => (redrawn = f);

export const page = {
  /** The element to focus after the next render, by selector. */
  focus: '',
  /** The last call that failed, said once. */
  error: '',
};
export const fail = (e: unknown) => {
  page.error = e instanceof Error ? e.message : String(e);
  redraw();
};

/** A focus move made by script never shows the keyboard ring (rebuild plan, Phase 0 findings). */
export function focus(target: string | HTMLElement | null | undefined) {
  const el = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target;
  el?.focus({ preventScroll: true, focusVisible: false });
  return !!el;
}
/** Focuses what `page.focus` names, once it has rendered. */
export function settleFocus() {
  if (page.focus && focus(page.focus)) page.focus = '';
}

/** The agent a new run uses: the `agent` preference, else the first the core lists. */
export function agent(): AgentHealth | undefined {
  const pref = records.prefs.get('agent');
  const id = pref?.id === 'agent' ? pref.value : null;
  const all = [...records.agents.values()];
  return all.find((a) => a.id === id) ?? (id ? undefined : all[0]);
}

const agents: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', fixture: 'Fixture agent' };
export const agentName = (id: string | null | undefined) => (id ? (agents[id] ?? id) : 'Agent');
export const projectName = (id: string | null | undefined) => (id && records.projects.get(id)?.name) || 'Idea';
export const title = (t: Thought | undefined) => {
  const line = t?.text.trim().split('\n')[0] ?? '';
  return line.length > 90 ? line.slice(0, 89) + '…' : line;
};

/** Open questions, oldest first: their ids are time ordered. */
export const openQuestions = (): Question[] =>
  [...records.questions.values()].filter((q) => q.state === 'open').sort((a, b) => (a.id < b.id ? -1 : 1));

export const resultOf = (t: Thought): TurnResult | undefined =>
  [...records.results.values()].filter((r) => r.thought_id === t.id).sort((a, b) => b.rev - a.rev)[0];

/** The person's open projects by name, the built-in Scratch last. */
export const projects = () =>
  [...records.projects.values()]
    .filter((p) => p.open)
    .sort((a, b) => Number(a.kind === 'scratch') - Number(b.kind === 'scratch') || a.name.localeCompare(b.name));

const reasons: Record<string, string> = {
  launch: 'It could not start',
  turn_failed: 'The agent reported a failure',
  interrupted: 'It was interrupted',
  exited: 'The agent exited before it finished',
  stopped: 'It was stopped',
};
export const why = (t: Thought) => reasons[t.reason ?? ''] ?? 'It failed';
