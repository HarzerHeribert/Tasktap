// The Composer's rings: the agents that can run the thought in the field (capture.tsx draws them in its row).
import { cap } from './capture.tsx';
import { agent, agentName, call, openQuestions, records, redraw, runs } from './page.ts';
import { Ring } from './ui.tsx';
import { offered, ring } from './way.ts';

/** Most rings in the row. However many agents a person has, the row is this many rings and "+n" wide, so what
 *  stands beside it in the Composer's foot always has the same room. */
export const RINGS = 3;

/** The agents that can run a thought, each its mark in a ring: those that are installed and not known to be signed
 *  out (way.ts `offered`). The one that runs the thought in the field is seated: on the selected fill, its ring lit,
 *  its name beside it. That is the usual agent (the `agent` preference) until a click on another ring picks that one
 *  for this thought alone; the seat moves there, the ring that takes it answers the click, and after the thought is
 *  sent the seat is the usual agent's again. With more agents than rings, the rest are behind "+n", the system's own
 *  menu, from where each can be picked; the one picked then has a ring. A follow-up (`session`) is its session's
 *  agent's: that ring alone, and no choice. The usual agent, when it is not signed in, is an open ring that says so
 *  and leads to where it is signed in. A ring turns while its agent works, beside the count of what it works on, and
 *  takes the attention colour when one of its sessions asks.
 *
 *  Picking an agent has the core ask it, once in the core's life, whether it is signed in: nothing asks it before. */
export function Rings({ hooks, session }: { hooks: { agents?: () => void }; session?: string }) {
  const agents = [...records.agents.values()];
  const usual = agent()?.id, fixed = session ? records.sessions.get(session)?.agent : undefined;
  const asking = new Set(openQuestions().map((q) => records.sessions.get(q.session_id ?? '')?.agent ?? records.thoughts.get(q.thought_id ?? '')?.agent));
  const says = new Map(agents.map((a) => [a.id, ring(a, records.thoughts.values(), (id) => asking.has(id))]));
  const picked = agents.some((a) => a.id === cap.agent && runs(a) && a.signed_in !== false) ? cap.agent : undefined;
  const { rings, more } = fixed ? { rings: agents.filter((a) => runs(a) && a.id === fixed), more: [] } : offered(agents, usual, picked, (id) => !!says.get(id)?.s, RINGS);
  const chosen = fixed ?? picked ?? usual;
  if (!rings.length) return null;
  const pick = (id: string) => {
    cap.agent = id === usual ? undefined : id;
    void call('agents.detect', { agents: [id], unchecked: true }).catch(() => {});
    redraw();
  };
  return (
    <span class="rings">
      <span role="radiogroup" aria-label="Agent">
        {rings.map((a) => {
          const { n, s } = says.get(a.id)!;
          const off = s === 'off', on = a.id === chosen;
          const words = [
            `${agentName(a.id)}${a.version ? ` ${a.version}` : ''}`,
            off ? 'not signed in' : fixed ? 'runs this follow-up, as it runs its session' : !on ? 'click to use it for this thought' : a.id === usual ? 'runs the next thought' : 'runs this thought only',
            n > 0 && `${n} working`, s === 'asks' && 'one needs you',
          ].filter(Boolean).join(', ');
          return (
            <button type="button" class="ring" role="radio" aria-checked={on} data-s={s || undefined} data-agent={a.id} title={words} aria-label={words}
              onClick={() => (off ? hooks.agents?.() : !fixed && pick(a.id))}>
              {off && <span class="fix">Sign in</span>}
              <Ring agent={a.id} s={s} turns={n > 0} />
              {on && !off && <span class="nm">{agentName(a.id)}</span>}
              {n > 0 && <b>{n}</b>}
            </button>
          );
        })}
      </span>
      {more.length > 0 && (
        <label class="ring more" title={`${more.length} more: ${more.map((a) => agentName(a.id)).join(', ')}`}>
          +{more.length}
          <select aria-label={`${more.length} more agents: use one for this thought`} value="" onChange={(e) => (pick(e.currentTarget.value), (e.currentTarget.value = ''))}>
            <option value="" disabled>Use for this thought</option>
            {more.map((a) => <option value={a.id}>{agentName(a.id)}{says.get(a.id)!.n > 0 ? ` · ${says.get(a.id)!.n} working` : ''}</option>)}
          </select>
        </label>
      )}
    </span>
  );
}
