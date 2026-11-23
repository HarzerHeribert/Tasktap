// What every page has: its one connection to the core, the records it holds, one redraw, the
// element to focus next, and the words the records are shown in. Each page's bundle has its own.
import { type AgentHealth, PREF_DEFAULTS, type PlaceTool, type Question, type RouteTerms, type SpeechTerms, type Thought, type TurnResult } from '../../core/proto/protocol.ts';
import { tauriBridge } from './bridge.ts';
import { CallError, Client, Records, type Name, type Where } from './client.ts';
import { type Answering, TALK, answerUsual } from './keys.ts';

export const client = new Client(tauriBridge());
export const records = new Records();
/** Whether the core has answered and this page holds its first records (each page's first `sub`). Until then the page
 *  claims nothing it does not know yet (where a task goes, what is set up, what runs), and a task started meanwhile
 *  waits for it (`coreIn`): the window can be up before the core is, which on a first start can take a while. */
export const core = { in: false };
let came = () => {}, failed: (e: unknown) => void = () => {};
export const coreIn = new Promise<void>((ok, no) => ((came = ok), (failed = no)));
// (Nobody may be waiting when the core fails: that is no error of the page's.)
coreIn.catch(() => {});
/** The page's first records are in (each page calls it once its `sub` has answered). */
export const recordsIn = () => ((core.in = true), came());
/** The page's records will not come (its `sub` failed): what waits for them is given back, never held for ever. */
export const recordsFailed = (e: unknown) => failed(e);
export const call: typeof client.call = (name, args) => client.call(name, args);
/** Whether the core in use answers `name` (client.ts `offers`): a control for what it cannot do is not shown. */
export const serves = (name: Name) => client.offers(name);
/** A preference as the core keeps it, or the protocol's default while none is stored. */
export const pref = <K extends keyof typeof PREF_DEFAULTS>(k: K) => (records.prefs.get(k)?.value ?? PREF_DEFAULTS[k]) as (typeof PREF_DEFAULTS)[K];
/** The key held to talk: the `talk_key` preference, else the system's usual one (keys.ts TALK). */
export const talkKey = () => pref('talk_key') ?? TALK;
const ANSWER_PREFS = { question: 'question_key', yes: 'yes_key', no: 'no_key' } as const;
/** Whether this copy takes keys from other apps, as the host said (host/src/keys.rs `TAKES`): a review build takes
 *  none, so names none. Until the host says, it does. */
export const globalKeys = { takes: true };
/** Asks the host once whether this copy takes keys from other apps; `told` runs when it does not. */
export const askGlobalKeys = (told: () => void) => void call('host.answer_key', {}).then((r) => r?.takes === false && ((globalKeys.takes = false), told()), () => {});
/** A key that answers a waiting question from any app: its preference, else this system's own (keys.ts); none in a
 *  copy that takes no keys from other apps. */
export const answerKey = (which: Answering) => (globalKeys.takes ? (pref(ANSWER_PREFS[which]) ?? answerUsual(which)) : null);

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
  // A call the core in use does not answer (an earlier build's, after an update) is nothing to say.
  if (e instanceof CallError && e.code === 'unknown') return;
  page.error = e instanceof Error ? e.message : String(e);
  redraw();
};

/** Where Tasktap shows itself (docs/rebuild-plan.md, "Where Tasktap shows itself"), as the host last said it to both
 *  pages at once (the `ui` event `where`, and the reply to `host.where`). Until it has said, the notch is where
 *  Tasktap is, as it is with the window behind. */
export const where: Where = { front: false, full: false, notch: true, place: null, question: null, window: '' };
/** Takes what the host said; the answer is whether anything changed. A host that says nothing (a page shown without
 *  the app, as the headless checks show it) changes nothing. */
export function heardWhere(w: Partial<Where> | null | undefined) {
  if (!w || typeof w !== 'object') return false;
  const before = JSON.stringify(where);
  Object.assign(where, { front: !!w.front, full: !!w.full, notch: !!w.notch, place: w.place ?? null, question: w.question ?? null, window: w.window ?? '' });
  return JSON.stringify(where) !== before;
}
/** Whether a waiting question is shown by this page now, the rule both pages and their question sheets follow: the
 *  window while it is in front, the notch otherwise, and never both (rule 3). The notch opens by itself only where
 *  this holds; the window's sheets come down for a question only where it holds. */
export const asksHere = (here: 'notch' | 'window') => (here === 'window' ? where.front : where.notch && !where.front);

/** The core's words, shown as they are, as a sentence: begun with a capital and ended with a stop. */
export const sentence = (s: string) => s.replace(/^./, (c) => c.toUpperCase()).replace(/([^.!?…])$/, '$1.');

/** A focus move made by script never shows the keyboard ring (rebuild plan, Phase 0 findings). A sheet of the window
 *  is over all else and holds the keyboard: what is named is the one in it (the New Task sheet's field, not Home's
 *  behind it), and nothing behind it is given the keyboard by name while it is up. */
export function focus(target: string | HTMLElement | null | undefined) {
  const sheet = typeof target === 'string' ? document.querySelector('.sheet[role=dialog]') : null;
  if (sheet && typeof target === 'string') {
    const el = [...sheet.querySelectorAll<HTMLElement>(target)][0];
    el?.focus({ preventScroll: true, focusVisible: false });
    return true;
  }
  const el = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target;
  el?.focus({ preventScroll: true, focusVisible: false });
  return !!el;
}
/** Focuses what `page.focus` names, once it has rendered. */
export function settleFocus() {
  if (page.focus && focus(page.focus)) page.focus = '';
  markHeld();
}

/** A key cap is shown only where pressing its key does something now (design/ui-directions/NOTES.md §13). An element
 *  whose own keys act while the keyboard is inside it is marked `data-keys`, and is `data-held` while the keyboard is
 *  in it; a cap inside one that is not held is not shown (parts.css). `data-keys="window"`: keys the window answers
 *  wherever its keyboard is (⌃⌥J, ⌘T). `strict`: the page's own window must have the keyboard too, as the notch must,
 *  which opens by itself without it. */
let strict = false;
export function markHeld() {
  const on = !strict || document.hasFocus(), at = on ? document.activeElement : null;
  for (const el of document.querySelectorAll<HTMLElement>('[data-keys]'))
    el.toggleAttribute('data-held', el.dataset.keys === 'window' ? on : !!at && at !== document.body && (el.contains(at)
      // `field`: the keys act from the Composer's field it stands under too (a question asked at the Composer).
      || (el.dataset.keys === 'field' && at.id === 'capture-input' && !!el.closest('form')?.contains(at))));
}

/** When keys were pressed in this page, anywhere: `last` is the key being handled now, `prev` the one before it. A
 *  Return within `QUIET` ms of what it would answer appearing is held back (sheets.tsx Frame). */
export const keyTimes = { last: -Infinity, prev: -Infinity };
// A modifier pressed alone is not a key here: ⌘ before O is one press, ⌘O.
const MODIFIERS = new Set(['Shift', 'Meta', 'Control', 'Alt', 'AltGraph', 'CapsLock', 'Fn', 'OS']);
addEventListener('keydown', (e) => MODIFIERS.has(e.key) || ((keyTimes.prev = keyTimes.last), (keyTimes.last = performance.now())), true);
export const QUIET = 600;
/** Whether what changes now is the person's own doing: it is drawn while their key, click or typing is being handled
 *  (the browser's event of the moment, which a render in its handler's microtasks still sees), not by a timer or the
 *  core's answer. What Return would do that changes by itself counts again only `QUIET` ms later (NOTES §13). */
export const byPerson = () => /^(key|pointer|mouse|click|input|beforeinput|composition|paste|drop|touch)/.test(window.event?.type ?? '');
/** Keeps `data-held` as the keyboard moves, in this page and between its window and others. */
export function watchHeld(notch = false) {
  strict = notch;
  const soon = () => queueMicrotask(markHeld);
  document.addEventListener('focusin', soon, true);
  document.addEventListener('focusout', soon, true);
  addEventListener('focus', soon);
  addEventListener('blur', soon);
}
/** Whether the person is at this page now: the workspace's window while it is in front, as the host says it for both
 *  pages (presence.rs), the notch's while it is open with the keyboard; in either, with this page's own keyboard. */
export const inFront = () => document.hasFocus() && (strict || where.front);

/** The agent a new run uses: the `agent` preference, else the first the core lists. */
export function agent(): AgentHealth | undefined {
  const pref = records.prefs.get('agent');
  const id = pref?.id === 'agent' ? pref.value : null;
  const all = [...records.agents.values()];
  return all.find((a) => a.id === id) ?? (id ? undefined : all[0]);
}

/** The name of an agent the person added, also of one they have removed since: their `own_agents` preference keeps
 *  it, so what such an agent ran still says who ran it. */
export const ownName = (id: string | null | undefined) => pref('own_agents').find((o) => o.id === id)?.name;
/** ChatGPT's id where an agreement and a thought's route name who placed it (core chatgpt.rs): one of placing's rows,
 *  which starts no agent. */
export const CHATGPT = 'chatgpt';
/** The own model's id likewise (core own.rs): the model at an address the person names. */
export const OWN = 'own';
/** An agent's name, as the core says it: its row of the agents carries it, so no page keeps a list of its own. ChatGPT,
 *  which is no agent and has no row, by its own name. */
export const agentName = (id: string | null | undefined) =>
  (id ? (id === CHATGPT ? 'ChatGPT' : id === OWN ? 'Your own model' : (records.agents.get(id)?.name ?? ownName(id) ?? id)) : 'Agent');
/** Whether a thought was run by an agent Tasktap hears nothing of but its end (the plain tier: Aider, and the ones
 *  the person added). Such a thought is not done, it has ended: nothing says whether the work was done, so no page
 *  calls it a result, and where its outcome would stand is the one sentence that says so (`endedSays`). */
export const unheard = (t: Pick<Thought, 'agent' | 'status'>) => {
  const a = records.agents.get(t.agent ?? '');
  return t.status === 'done' && (a ? !a.events : !!ownName(t.agent));
};
export const endedSays = (t: Pick<Thought, 'agent'>) =>
  records.agents.get(t.agent ?? '')?.note ?? 'Its terminal says what it did: Tasktap heard only that it ended.';
/** Whether an agent can be picked to run something: its program is here, and it runs on this system. */
export const runs = (a: AgentHealth | undefined) => !!a?.installed && a.supported;
/** What a project is called: a workspace, or a project Tasktap knows that is not open (ids never meet). */
export const projectName = (id: string | null | undefined) => (id && (records.projects.get(id)?.name ?? records.cards.get(id)?.name)) || 'For later';
/** How a capture or a move names a destination: a workspace by `project_id`, a project Tasktap knows by `card_id`. */
export const placeArgs = (id: string) => (records.projects.has(id) ? { project_id: id } : { card_id: id });
export const title = (t: Thought | undefined) => {
  const line = t?.text.trim().split('\n')[0] ?? '';
  return line.length > 90 ? line.slice(0, 89) + '…' : line;
};

/** What the core says is sent when a model places thoughts and when a speech service hears them, for the person to
 *  read before they allow either: asked for once the page has its records, and again when Settings opens. */
export const terms = { route: null as RouteTerms | null, speech: null as SpeechTerms | null };
export const loadTerms = () =>
  Promise.all([call('route.terms', {}).then((t) => (terms.route = t)), call('speech.terms', {}).then((t) => (terms.speech = t))]).then(redraw, () => {});
/** An agent that can place thoughts, with the version of the terms it would be asked under. */
export type Placeable = PlaceTool & { terms: number };
/** The agents whose model can place thoughts, in Tasktap's order: those the core would ask that are installed and
 *  signed in, ChatGPT while it is signed in, with the model its sign-in chose, and the own model once it is set up. */
export const placers = (): Placeable[] =>
  (terms.route?.tools ?? []).filter((t) => {
    if (t.agent === CHATGPT) return pref('chatgpt')?.state === 'signed_in';
    if (t.agent === OWN) return !!pref('own_model');
    const a = records.agents.get(t.agent);
    return runs(a) && a!.signed_in !== false;
  }).map((t) => ({ ...t, model: (t.agent === CHATGPT && pref('chatgpt')?.model) || t.model, terms: terms.route!.terms }));

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

/** What a session is called: its name, else the thought of its turn. */
export const sessionName = (id: string | null | undefined) => {
  const s = id ? records.sessions.get(id) : undefined;
  return s?.name || title(records.thoughts.get(s?.thought_id ?? '')) || 'its session';
};

const reasons: Record<string, string> = {
  launch: 'It could not start',
  turn_failed: 'The agent reported a failure',
  interrupted: 'It was interrupted',
  exited: 'The agent exited before it finished',
  stopped: 'It was stopped',
};
export const why = (t: Thought) => reasons[t.reason ?? ''] ?? 'It failed';
