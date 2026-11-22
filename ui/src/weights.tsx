// How heavy the task in the Composer's field is: Light, Standard or Heavy, which the agent's ladder (Settings › Agents,
// `agent_weights`) turns into a model and an effort when the task starts. One small control beside the agent's, in its
// form and size, only while the agent that runs the task has a line of its ladder filled and the task is a new one (a
// follow-up goes on in the session it continues, on what that runs on); and the list it opens in the foot, as the
// agent's list does. The choice holds for the task in the field alone: after it is sent the control says Standard again.
// The notch's Composer has none: a task from there runs on Standard.
import type { Weight } from '../../core/proto/protocol.ts';
import { cap } from './capture.tsx';
import { spell } from './keys.ts';
import { agentName, page, pref, redraw } from './page.ts';
import { arrows, chosen } from './rings.tsx';
import { I, Key } from './ui.tsx';

/** The weights, in Tasktap's words, lightest first. */
export const WEIGHTS: [Weight, string][] = [['light', 'Light'], ['standard', 'Standard'], ['heavy', 'Heavy']];
const named = (w: Weight) => WEIGHTS.find(([id]) => id === w)![1];

/** The weight control's key, from anywhere in the Composer, beside the agent control's ⌘J. */
export const WEIGHT_KEY = '⌘L';

/** The weight of the task in the field: Standard until one is chosen. */
export const weight = (): Weight => cap.weight ?? 'standard';

/** The agent's lines of the ladder that say something (a model or an effort). */
const lines = (agent: string | undefined) => pref('agent_weights').filter((l) => l.agent === agent && (l.model || l.effort));

/** Whether the Composer has the control: the agent that runs the task has a line filled, and the task is no follow-up. */
export function shows(session?: string): boolean {
  const { a, fixed } = chosen(session);
  return !!a && !fixed && !!a.passes && lines(a.id).length > 0;
}

/** Three bars, as many lit as the weight is heavy: the control's mark, where the agent control has the agent's. */
function Bars({ w }: { w: Weight }) {
  const lit = WEIGHTS.findIndex(([id]) => id === w) + 1;
  return (
    <svg class="wmark" viewBox="0 0 24 24" aria-hidden="true">
      {[6, 11, 16].map((h, i) => <rect class={i < lit ? undefined : 'off'} x={4 + i * 6.5} y={20 - h} width="4" height={h} rx="1.25" />)}
    </svg>
  );
}

/** Opens or closes the list. Open, it has the keyboard on the row of the weight chosen. */
export function open(on: boolean) {
  Object.assign(cap, { weights: on, agents: false });
  if (on) cap.choosing = false;
  page.focus = on ? '.weight-list [aria-selected=true]' : '#capture-input';
  redraw();
}

/** The control: the bars, the weight's name, a chevron and its key where there is room (the agent control's rules, parts.css). */
export function WeightControl({ session }: { session?: string }) {
  if (!shows(session)) return null;
  const name = named(weight()), words = `The weight of this task: ${name}. Click to choose another weight, for this task only`;
  return (
    <button type="button" class="cap-agent cap-weight" data-weight={weight()} aria-haspopup="listbox" aria-expanded={false} title={`${words}  ${spell(WEIGHT_KEY)}`} aria-label={words}
      aria-keyshortcuts={WEIGHT_KEY.replace('⌘', 'Meta+')} onClick={() => open(true)}
      onKeyDown={(e) => (e.key === 'ArrowDown' || e.key === 'ArrowUp') && (e.preventDefault(), e.stopPropagation(), open(true))}>
      <Bars w={weight()} />
      <span class="nm">{name}</span>
      <I n="chev" />
      <Key k={WEIGHT_KEY} />
    </button>
  );
}

/** What the agent's ladder says of one weight, in quiet words: its model and its effort, or that the agent's own is used. */
function says(agent: string, w: Weight): string {
  const line = lines(agent).find((l) => l.weight === w);
  return line ? [line.model, line.effort && `${line.effort} effort`].filter(Boolean).join(', ') : `${agentName(agent)}'s own`;
}

/** The list, in the Composer's foot where the row was, in the family of the agent's list: each weight a row with its bars,
 *  its name and what the ladder gives it, the one chosen selected. Picking one is for this task alone. */
export function WeightList({ session }: { session?: string }) {
  const agent = chosen(session).a?.id ?? '', on = weight();
  return (
    <div key="weights" class="cap-row cap-list agent-list weight-list" role="listbox" aria-label="Weight of this task" data-keys onKeyDown={arrows}
      onMouseDown={(e) => e.preventDefault()}
      onFocusOut={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && cap.weights && ((cap.weights = false), redraw())}>
      {WEIGHTS.map(([w, name]) => (
        <button type="button" role="option" aria-selected={w === on} data-weight={w} title={`${name}: ${says(agent, w)}`}
          onClick={() => ((cap.weight = w === 'standard' ? undefined : w), open(false))}>
          <Bars w={w} />
          <span>{name}</span>
          <em>{says(agent, w)}</em>
        </button>
      ))}
    </div>
  );
}
