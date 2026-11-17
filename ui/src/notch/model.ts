// The notch page's connection, the records it shows, and what it holds only while it runs.
import type { AgentHealth, Question, Route, Thought, TurnResult } from '../../../core/proto/protocol.ts';
import { tauriBridge } from '../bridge.ts';
import { Client, Records } from '../client.ts';

export const client = new Client(tauriBridge());
export const records = new Records();

export type View = 'home' | 'answer';
/** What was just sent, for the receipt and Undo. */
export type Sent = { id: string; text: string; to: string | 'idea' };

export const ui = {
  /** closed; opened by the pointer (folds when it leaves); or pinned until dismissed. */
  mode: 'closed' as 'closed' | 'hover' | 'pinned',
  /** The fold animation is running; the content stays until it ends. */
  retracting: false,
  view: 'home' as View,
  inside: false,
  timer: 0,
  height: 260,
  wing: 0,
  /** Opened by a question rather than by the person. */
  auto: false,
  /** The element to focus after the next render. */
  focus: '',
  question: null as string | null,
  seen: new Set<string>(),
  /** The person's own pick of destination: a project id or 'idea'. */
  dest: undefined as string | undefined,
  /** Where the router would send the text typed now (route.hint), for the chip. */
  hint: null as { text: string; route: Route } | null,
  choosing: false,
  sent: null as Sent | null,
  undone: null as Sent | null,
  draft: '',
  replying: false,
  error: '',
  geometry: null as Record<string, number | boolean> | null,
};

let redrawn = () => {};
export const redraw = () => redrawn();
export const onRedraw = (f: () => void) => (redrawn = f);
export const fail = (e: unknown) => {
  ui.error = e instanceof Error ? e.message : String(e);
  redraw();
};
export const call: typeof client.call = (name, args) => client.call(name, args);

/** The agent a new run uses: the `agent` preference, else the first the core lists. */
export function agent(): AgentHealth | undefined {
  const pref = records.prefs.get('agent');
  const id = pref?.id === 'agent' ? pref.value : null;
  const all = [...records.agents.values()];
  return all.find((a) => a.id === id) ?? (id ? undefined : all[0]);
}

export const agents: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
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

/** The person's pick, while it can still be used. */
export const picked = () => (ui.dest === 'idea' || (ui.dest && records.projects.get(ui.dest)?.open) ? ui.dest : undefined);

/** Where the router would send the text typed now, when it knows (route.hint): then Enter
 *  leaves the routing to it rather than picking for the person. */
export function hinted(): Route | undefined {
  const r = ui.hint?.text === ui.draft.trim() ? ui.hint.route : undefined;
  return !picked() && r && r.confidence !== 'unknown' ? r : undefined;
}

/** Where the next capture goes when neither the person nor the router says: the project of the
 *  newest thought, else their first project. None until they have one: the chip offers to add it. */
export function destination(): string | undefined {
  const pick = picked();
  if (pick) return pick;
  const newest = [...records.thoughts.values()]
    .filter((t) => t.project_id && records.projects.get(t.project_id)?.open)
    .sort((a, b) => b.created - a.created)[0];
  return newest?.project_id ?? projects().find((p) => p.kind === 'folder')?.id;
}

const reasons: Record<string, string> = {
  launch: 'It could not start',
  turn_failed: 'The agent reported a failure',
  interrupted: 'It was interrupted',
  exited: 'The agent exited before it finished',
  stopped: 'It was stopped',
};
export const why = (t: Thought) => reasons[t.reason ?? ''] ?? 'It failed';
