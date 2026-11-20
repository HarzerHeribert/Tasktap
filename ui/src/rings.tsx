// Who runs the thought in the Composer's field: one control in its foot, and the list it opens (capture.tsx draws
// both). The owner, of the row of rings with "+3" and its system menu, 2026-11-19: "make this a dropdown maybe but
// styled correctly" (design/ui-directions/NOTES.md §13).
import type { AgentHealth } from '../../core/proto/protocol.ts';
import { cap } from './capture.tsx';
import { agent, agentName, call, openQuestions, page, records, redraw, runs } from './page.ts';
import { spell } from './keys.ts';
import { I, Key, Ring } from './ui.tsx';
import { listed, ring } from './way.ts';

/** More agents than this, and the list has a field that narrows it by what is typed. */
export const FIND_FROM = 6;

/** What every agent's ring says now: how many of its sessions work, and whether one asks or it is signed out. */
function says() {
  const asking = new Set(openQuestions().map((q) => records.sessions.get(q.session_id ?? '')?.agent ?? records.thoughts.get(q.thought_id ?? '')?.agent));
  return new Map([...records.agents.values()].map((a) => [a.id, ring(a, records.thoughts.values(), (id) => asking.has(id))]));
}
/** The agent that runs the thought in the field: a follow-up's session's, else the one picked for this thought, else
 *  the usual one (the `agent` preference). */
export function chosen(session?: string): { a: AgentHealth | undefined; fixed: boolean } {
  const fixed = session ? records.sessions.get(session)?.agent : undefined;
  if (fixed) return { a: records.agents.get(fixed), fixed: true };
  const picked = cap.agent ? records.agents.get(cap.agent) : undefined;
  return { a: picked && runs(picked) && picked.signed_in !== false ? picked : agent(), fixed: false };
}
/** What an agent's row says of it after its name, in a few words. */
function facts(a: AgentHealth, s: { n: number; s: string }) {
  return [s.n > 0 && `${s.n} working`, s.s === 'asks' && 'one needs you', a.questions === 'terminal' && 'answers in its terminal', a.signed_in === false && 'signed out'].filter(Boolean).join(' · ');
}

/** The agent control's key, from anywhere in the Composer (a key no command and no field takes: keys.ts COMMANDS). */
export const AGENT_KEY = '⌘J';

/** The control: the ring of the agent that runs the thought, its name, a chevron and its key where there is room; a
 *  click, ↓ or ⌘J opens the list, always, also with the usual agent signed out (then its ring is open in the attention
 *  colour and it says so; signing in is a row of the list). A follow-up is its session's agent's, with no choice. Its
 *  name gives way where the foot is short of room. */
export function AgentControl({ session }: { session?: string }) {
  const { a, fixed } = chosen(session);
  if (!a) return null;
  const s = says().get(a.id) ?? { n: 0, s: '' as const };
  const off = s.s === 'off';
  const words = `${agentName(a.id)}${a.version ? ` ${a.version}` : ''}, ${fixed ? 'runs this follow-up, as it runs its session' : off ? 'not signed in. Click to choose another, or to sign in' : a.id === agent()?.id ? 'runs the next thought. Click to choose another for this one' : 'runs this thought only. Click to choose another'}`;
  return (
    <button type="button" class="cap-agent" data-agent={a.id} data-s={s.s || undefined} aria-haspopup={fixed ? undefined : 'listbox'} aria-expanded={fixed ? undefined : false} aria-disabled={fixed || undefined}
      title={fixed ? words : `${words}  ${spell(AGENT_KEY)}`} aria-label={words} aria-keyshortcuts={fixed ? undefined : AGENT_KEY.replace('⌘', 'Meta+')}
      onClick={() => !fixed && open(true)}
      onKeyDown={(e) => !fixed && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && (e.preventDefault(), e.stopPropagation(), open(true))}>
      <Ring agent={a.id} s={s.s} turns={s.n > 0} />
      <span class="nm">{agentName(a.id)}</span>
      {off && <span class="fix">signed out</span>}
      {!fixed && <I n="chev" />}
      {!fixed && <Key k={AGENT_KEY} />}
    </button>
  );
}

/** Opens or closes the list. Open, it has the keyboard: its field where it has one, else the row of the one chosen. */
export function open(on: boolean) {
  Object.assign(cap, { agents: on, findAgent: '' });
  if (on) cap.choosing = false;
  page.focus = on ? '#agent-find, .agent-list [aria-selected=true]' : '#capture-input';
  redraw();
}

function pick(id: string) {
  cap.agent = id === agent()?.id ? undefined : id;
  // The core asks an agent once in its life whether it is signed in: picking it is that moment.
  void call('agents.detect', { agents: [id], unchecked: true }).catch(() => {});
  open(false);
}

/** The arrows move from the field through the rows and back; Return in the field takes the first, the browser's
 *  Return and Space press a row; Escape leaves it as it was. */
function arrows(e: KeyboardEvent) {
  if (e.key === 'Escape') return (e.preventDefault(), e.stopPropagation(), open(false));
  const list = e.currentTarget as HTMLElement, field = list.querySelector<HTMLInputElement>('#agent-find');
  const rows = [...list.querySelectorAll<HTMLElement>('button')];
  if (e.target === field && e.key === 'Enter' && !e.isComposing) return (e.preventDefault(), e.stopPropagation(), rows[0]?.click());
  const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  e.stopPropagation();
  const all = field ? [field, ...rows] : rows, at = all.indexOf(document.activeElement as HTMLElement);
  all[(at + step + all.length) % all.length]?.focus({ focusVisible: true });
}

/** The list, in the Composer's foot where the row was, in the family of the chip's list: every usable agent a row (its
 *  ring, its name, what it is working on, that it answers in its terminal, that it is signed out), the one that runs
 *  the thought selected. With more than six a field narrows them by what is typed, a name that begins with it first.
 *  Picking one is for this thought alone; one signed out leads to where it is signed in, and so does the list's last
 *  row while one is. */
export function AgentList({ signIn }: { signIn?: () => void }) {
  const agents = [...records.agents.values()], name = (a: AgentHealth) => agentName(a.id);
  const all = listed(agents, name), shown = listed(agents, name, cap.findAgent), on = chosen().a?.id, said = says(), words = cap.findAgent.trim();
  const out = all.filter((a) => said.get(a.id)?.s === 'off');
  return (
    <div key="agents" class="cap-row cap-list agent-list" role="listbox" aria-label="Who runs this thought" data-keys onKeyDown={arrows}
      // A row pressed keeps the keyboard where it is: a WebKit button takes none, and the list would close under it.
      onMouseDown={(e) => !(e.target as HTMLElement).closest('input') && e.preventDefault()}
      onFocusOut={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && cap.agents && ((cap.agents = false), redraw())}>
      {all.length > FIND_FROM && (
        <label class="cap-find">
          <I n="search" />
          <input id="agent-find" autocomplete="off" spellcheck={false} aria-label="Find an agent" placeholder="Find an agent" value={cap.findAgent}
            onInput={(e) => ((cap.findAgent = e.currentTarget.value), redraw())} />
        </label>
      )}
      {shown.map((a) => {
        const s = said.get(a.id) ?? { n: 0, s: '' as const }, more = facts(a, s), off = s.s === 'off';
        return (
          <button type="button" role="option" aria-selected={a.id === on} data-agent={a.id} data-s={s.s || undefined}
            title={`${agentName(a.id)}${a.version ? ` ${a.version}` : ''}${more ? `: ${more}` : ''}`}
            onClick={() => (off ? (open(false), signIn?.()) : pick(a.id))}>
            <Ring agent={a.id} s={s.s} turns={s.n > 0} size={20} />
            <span>{agentName(a.id)}</span>
            {more && <em>{more}</em>}
          </button>
        );
      })}
      {words && !shown.length && <p class="cap-none">No agent by that name.</p>}
      {out.length > 0 && signIn && (
        <button type="button" class="sign" onClick={() => (open(false), signIn())}><I n="arrow" /><span>{out.some((a) => a.id === on) ? `Sign in to ${agentName(on)}…` : out.length === 1 ? `Sign in to ${agentName(out[0]!.id)}…` : 'Sign in to an agent…'}</span></button>
      )}
    </div>
  );
}
