// The Composer's rings: the agents that can run the thought in the field (capture.tsx draws them in its row).
import { cap } from './capture.tsx';
import { agent, agentName, openQuestions, records, redraw, runs } from './page.ts';
import { Ring } from './ui.tsx';
import { ring } from './way.ts';

/** The agents this Mac has, each its mark in a ring. The one that runs the thought in the field is seated: on the
 *  selected fill, its ring lit, its name beside it where there is room. That is the usual agent (the `agent`
 *  preference) until a click on another ring picks that one for this thought alone; the seat moves there, the ring
 *  that takes it answers the click, and after the thought is sent the seat is the usual agent's again. A follow-up
 *  (`session`) is its session's agent's: that ring alone, and no choice. One that is not signed in is an open ring
 *  that says so and leads to where it is signed in. A ring turns while its agent works, beside the count of what it
 *  works on, and takes the attention colour when one of its sessions asks. */
export function Rings({ hooks, session }: { hooks: { agents?: () => void }; session?: string }) {
  const installed = [...records.agents.values()].filter(runs);
  const usual = agent()?.id, fixed = session ? records.sessions.get(session)?.agent : undefined;
  const all = fixed ? installed.filter((a) => a.id === fixed) : installed;
  const chosen = fixed ?? (all.some((a) => a.id === cap.agent) ? cap.agent : usual);
  const asking = new Set(openQuestions().map((q) => records.sessions.get(q.session_id ?? '')?.agent ?? records.thoughts.get(q.thought_id ?? '')?.agent));
  if (!all.length) return null;
  return (
    <span class="rings" role="radiogroup" aria-label="Agent">
      {all.map((a) => {
        const { n, s } = ring(a, records.thoughts.values(), (id) => asking.has(id));
        const off = s === 'off', on = a.id === chosen;
        const words = [
          `${agentName(a.id)}${a.version ? ` ${a.version}` : ''}`,
          off ? 'not signed in' : fixed ? 'runs this follow-up, as it runs its session' : !on ? 'click to use it for this thought' : a.id === usual ? 'runs the next thought' : 'runs this thought only',
          n > 0 && `${n} working`, s === 'asks' && 'one needs you',
        ].filter(Boolean).join(', ');
        return (
          <button type="button" class="ring" role="radio" aria-checked={on} data-s={s || undefined} data-agent={a.id} title={words} aria-label={words}
            onClick={() => (off ? hooks.agents?.() : !fixed && ((cap.agent = a.id === usual ? undefined : a.id), redraw()))}>
            {off && <span class="fix">Sign in</span>}
            <Ring agent={a.id} s={s} turns={n > 0} />
            {on && !off && <span class="nm">{agentName(a.id)}</span>}
            {n > 0 && <b>{n}</b>}
          </button>
        );
      })}
    </span>
  );
}
