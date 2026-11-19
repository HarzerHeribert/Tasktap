// Settings › Agents: the agents this Mac has, however many. The ones that are installed stand first, each one line:
// its ring, its name, what its own commands said of it and when, what of it the notch cannot do, and the one thing a
// person does with it here (sign in, make it the default, change one of their own). What an agent does only when let
// is a switch under its line, off until turned on, with what it allows. The ones that are not installed are folded
// into one line at the end. Last, an agent of the person's own: a name and a command line.
//
// No agent's program runs as the app starts. Opening this section has the core ask those it has not asked in its
// life whether they are signed in; "Check again" asks every one.
import { useEffect, useState } from 'preact/hooks';
import type { AgentHealth, OwnAgent } from '../../../core/proto/protocol.ts';
import { HERE } from '../system.ts';
import { I, Ring, ago } from '../ui.tsx';
import { agentState, ownAgentLacks } from '../way.ts';
import { Row, Switch, setPref } from './form.tsx';
import { LOOSE, agent, call, dismiss, newTerminal, pref, records, redraw, runs, sentence } from './model.ts';

/** What is typed into a terminal to sign an agent in. */
const signIn: Record<string, string> = { claude: 'claude', codex: 'codex login', agy: 'agy', pi: 'pi', opencode: 'opencode auth login' };
/** What a row adds about its agent: whose models it runs, where its name does not say, and what of it the notch
 *  cannot do, in the words of what the core says its runs can (its row's `events`, `permissions`, `questions`): of
 *  one that reports nothing Tasktap hears only when it ends, and what one asks where nothing outside its terminal
 *  can answer is answered there. Nothing is said of what the notch does answer. */
const family: Record<string, string> = { agy: 'Gemini' };
const about = (a: AgentHealth) => {
  const [p, q] = [a.permissions === 'terminal', a.questions === 'terminal'];
  return [family[a.id], !a.events ? 'Tasktap hears only when it ends' : p && q ? 'asks in its terminal' : p ? 'approvals in its terminal' : q && 'questions in its terminal'];
};

const looking = { on: false };
function look(again = false) {
  looking.on = true;
  call('agents.detect', { unchecked: !again }).catch(() => {}).then(() => ((looking.on = false), redraw()));
  redraw();
}

/** An id for an agent the person adds: `own-` and ten letters and digits, never changed afterwards. */
const mint = () => `own-${[...crypto.getRandomValues(new Uint8Array(10))].map((b) => (b % 36).toString(36)).join('')}`;

/** The form for an agent of the person's own, new (`at` null) or one of theirs to change or remove. */
function Own({ at, done }: { at: OwnAgent | null; done: () => void }) {
  const [name, setName] = useState(at?.name ?? ''), [command, setCommand] = useState(at?.command ?? ''), [error, say] = useState('');
  const own = pref('own_agents');
  const keep = (all: OwnAgent[]) => call('put', { c: 'prefs', id: 'own_agents', patch: all }).then(done, (e: Error) => say(sentence(e.message)));
  const save = () => {
    const lacks = ownAgentLacks(name, command);
    if (lacks) return say(sentence(lacks));
    void keep(at ? own.map((o) => (o.id === at.id ? { ...o, name, command } : o)) : [...own, { id: mint(), name, command }]);
  };
  const enter = (e: KeyboardEvent) => e.key === 'Enter' && (e.preventDefault(), save());
  return (
    <div class="own" role="group" aria-label={at ? `Change ${at.name}` : 'Add an agent'}>
      <Row name="Name"><input class="text" id="own-name" aria-label="Name" spellcheck={false} autocomplete="off" maxLength={40} value={name} onInput={(e) => (setName(e.currentTarget.value), say(''))} onKeyDown={enter} /></Row>
      <Row name="Command" hint={error ? undefined : <>The program and its arguments, with <code>{'{prompt}'}</code> where the thought goes. It should do the work and exit: Tasktap hears only when it ends, and takes exit 0 as done.</>}>
        <input class="text wide" aria-label="Command" placeholder="goose run -t {prompt}" spellcheck={false} autocomplete="off" maxLength={2000} value={command}
          onInput={(e) => (setCommand(e.currentTarget.value), say(''))} onKeyDown={enter} />
        {error && <p class="hint err" role="alert">{error}</p>}
      </Row>
      <Row name="">
        <button type="button" class="btn" onClick={save}>{at ? 'Save' : 'Add'}</button>
        <button type="button" class="btn" onClick={done}>Cancel</button>
        {at && <button type="button" class="btn" onClick={() => void keep(own.filter((o) => o.id !== at.id))}>Remove</button>}
      </Row>
    </div>
  );
}

export function AgentsPane() {
  useEffect(() => look(), []);
  // The form: closed, open for a new agent (''), or for one of the person's own by its id.
  const [form, setForm] = useState<string | null>(null), [folded, fold] = useState(true);
  const agents = [...records.agents.values()];
  if (!agents.length) return <p class="note">Looking for agents…</p>;
  const usual = agent()?.id, allowed = pref('agent_options'), own = pref('own_agents');
  // Here, or the person's own: one of theirs stays in sight where its program is missing, to be changed.
  const here = agents.filter((a) => runs(a) || a.own), rest = agents.filter((a) => !runs(a) && !a.own);
  const line = (a: AgentHealth) => {
    const off = runs(a) && a.signed_in === false, on = runs(a) && !off;
    // Of one of the person's own that is here there is nothing to check: only what Tasktap hears of it is said.
    const state = a.own && runs(a) ? '' : agentState(a, looking.on, ago(a.checked));
    const says = [a.version, state, ...about(a), a.identity].filter(Boolean).join(' · ');
    // What wants the person: one that is signed out, one of their own whose program is missing. One that is simply
    // not here is said quietly.
    const s = on ? undefined : off || a.own ? 'off' : 'none';
    return (
      <>
        <div class="line ag" data-s={s} data-agent={a.id}>
          <Ring agent={a.id} s={on ? '' : 'off'} />
          <span class="t">{a.name}</span>
          <span class="x" title={says}>{says}</span>
          <span class="acts">
            {off && signIn[a.id] && (
              <button type="button" class="btn" onClick={() => (dismiss(), newTerminal(LOOSE, { title: `Sign in to ${a.name}`, type: signIn[a.id] }))}>Sign in</button>
            )}
            {a.own && <button type="button" class="btn" onClick={() => setForm(a.id)}>Change</button>}
            {a.id === usual ? <span class="x def">Default</span> : on && <button type="button" class="btn" onClick={() => setPref({ id: 'agent', patch: a.id })}>Make default</button>}
          </span>
        </div>
        {form === a.id && <Own key={a.id} at={own.find((o) => o.id === a.id) ?? null} done={() => setForm(null)} />}
        {on && a.note && <p class="line-n">{a.note}</p>}
        {on && a.options.map((o) => {
          const id = `${a.id}.${o.id}`;
          return (
            <div class="line opt">
              <span />
              <span class="t">{o.name}</span>
              <span class="x">{o.allows}</span>
              <Switch on={allowed.includes(id)} name={`${a.name}: ${o.name}`} set={(to) => setPref({ id: 'agent_options', patch: to ? [...allowed, id] : allowed.filter((x) => x !== id) })} />
            </div>
          );
        })}
      </>
    );
  };
  return (
    <>
      <div class="list">
        {here.map(line)}
        {rest.length > 0 && (
          <button type="button" class="line fold-l" aria-expanded={!folded} onClick={() => fold(!folded)}>
            <I n="chev" />
            <span class="t">Not on {HERE}</span>
            <span class="x">{rest.map((a) => a.name).join(', ')}</span>
          </button>
        )}
        {!folded && rest.map(line)}
        {form === '' ? <Own key="new" at={null} done={() => setForm(null)} /> : (
          <button type="button" class="line fold-l" onClick={() => setForm('')}>
            <I n="plus" />
            <span class="t">Add an agent</span>
            <span class="x">Any program that takes a thought as an argument and exits when the work is done</span>
          </button>
        )}
      </div>
      <p class="note">The default runs your thoughts. For one thought, pick another by its ring where you write it.</p>
      <Row name="Sign-in" hint="Each agent is asked when you look here and when it first runs a thought, not when Tasktap starts.">
        <button type="button" class="btn" disabled={looking.on} onClick={() => look(true)}>{looking.on ? 'Checking…' : 'Check again'}</button>
      </Row>
    </>
  );
}
