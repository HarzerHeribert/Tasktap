// Settings › Agents: the agents this Mac has, however many. The ones that are installed stand first, each one line:
// its ring, its name, what its own commands said of it and when, what of it the notch cannot do, and the one thing a
// person does with it here (sign in, make it the default, change one of their own). What an agent does only when let
// is a switch under its line, off until turned on, with what it allows. The ones that are not installed are folded
// into one line at the end, and with them the person's own that they removed: such an agent is kept, so that what it
// ran still says who ran it, until it is added back or forgotten. Last, an agent of the person's own: a name and a
// command line. Under each agent Tasktap brings, the command that starts it, where the person starts it their own way
// (a program of theirs around it, arguments of theirs): empty, Tasktap starts it as always. One whose command does not
// start it stays in sight and says why in the core's words, as one of the person's own does.
//
// No agent's program runs as the app starts. Opening this section has the core ask those it has not asked in its
// life whether they are signed in, as giving an agent its first thought does (calls.rs `look`); "Check now" asks
// every one.
import { useEffect, useState } from 'preact/hooks';
import type { AgentHealth, OwnAgent } from '../../../core/proto/protocol.ts';
import { HERE, mac } from '../system.ts';
import { I, Ring, ago } from '../ui.tsx';
import { agentState, ownAgentLacks } from '../way.ts';
import { Row, Switch, setPref } from './form.tsx';
import { LOOSE, agent, call, commandOf, dismiss, fail, newTerminal, pref, records, redraw, runs, sentence } from './model.ts';

/** What is typed into a terminal to sign an agent in: after the person's command for it, where they start it their own
 *  way, in place of its program. */
const signIn: Record<string, string> = { claude: '', codex: ' login', agy: '', pi: '', opencode: ' auth login' };
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

/** Writes the person's own agents as they are now; the core says in a sentence what one of them lacks. */
const keepOwn = (all: OwnAgent[]) => call('put', { c: 'prefs', id: 'own_agents', patch: all });

/** Writes the command of `a` as typed, or none for an empty field: the core's sentence for one it refuses, else none. Its
 *  length is counted in bytes, as the core counts it. */
function keepCommand(a: AgentHealth, typed: string): Promise<string> {
  const command = typed.trim(), rest = pref('agent_commands').filter((c) => c.agent !== a.id);
  if (new TextEncoder().encode(command).length > 2000) return Promise.resolve(sentence(`The command of ${a.name} is too long, or not one line`));
  return call('put', { c: 'prefs', id: 'agent_commands', patch: command ? [...rest, { agent: a.id, command }] : rest })
    .then(() => '', (e: Error) => sentence(e.message));
}
/** The row under an agent Tasktap brings: the command that starts it, with its program in the empty field, and in one
 *  sentence an example of a start of the person's own (on Windows an argument of Claude Code's; none for Codex, which
 *  has no such harmless one to show). A refusal belongs to what the field holds: it goes with the next command kept,
 *  and when the field shows the one kept again, as the section is left. */
function Start({ a }: { a: AgentHealth }) {
  const [why, say] = useState('');
  const name = `Command that starts ${a.name}`, p = a.program;
  const example = mac ? `caffeinate -i ${p}` : a.id === 'claude' ? `${p} --verbose` : '';
  const hint = <>Write how you start {a.name}{example && <>, such as <code>{example}</code></>}, without shell aliases; leave the field empty for Tasktap's own start.</>;
  return (
    <Row name={name} hint={why ? undefined : hint}>
      <input class="text wide" aria-label={name} placeholder={p} spellcheck={false} autocomplete="off" maxLength={2000} defaultValue={commandOf(a.id)}
        onChange={(e) => void keepCommand(a, e.currentTarget.value).then(say)} />
      {why && <p class="hint err" role="alert">{why}</p>}
    </Row>
  );
}

const NAME = 'Name shown in Tasktap', COMMAND = 'Command that runs it';
/** The form for an agent of the person's own, new (`at` null) or one of theirs to change or remove. */
function Own({ at, done }: { at: OwnAgent | null; done: () => void }) {
  const [name, setName] = useState(at?.name ?? ''), [command, setCommand] = useState(at?.command ?? ''), [error, say] = useState('');
  const own = pref('own_agents');
  const keep = (all: OwnAgent[]) => keepOwn(all).then(done, (e: Error) => say(sentence(e.message)));
  const save = () => {
    const lacks = ownAgentLacks(name, command);
    if (lacks) return say(sentence(lacks));
    void keep(at ? own.map((o) => (o.id === at.id ? { ...o, name, command } : o)) : [...own, { id: mint(), name, command, removed: false }]);
  };
  const enter = (e: KeyboardEvent) => e.key === 'Enter' && (e.preventDefault(), save());
  // Opened by a click on Add or Change, the keyboard is in its first field: the button that had it is gone.
  useEffect(() => document.getElementById('own-name')?.focus(), []);
  return (
    <div class="own" role="group" aria-label={at ? `Change ${at.name}` : 'Add an agent'}>
      <Row name={NAME} hint="Shown wherever you choose who runs a task, and on the work the agent has done.">
        <input class="text" id="own-name" aria-label={NAME} spellcheck={false} autocomplete="off" maxLength={40} value={name} onInput={(e) => (setName(e.currentTarget.value), say(''))} onKeyDown={enter} />
      </Row>
      <Row name={COMMAND} hint={error ? undefined : <>Put <code>{'{prompt}'}</code> where the task goes; Tasktap learns the work is done only when the program exits, with 0 for success.</>}>
        <input class="text wide" aria-label={COMMAND} placeholder="goose run -t {prompt}" spellcheck={false} autocomplete="off" maxLength={2000} value={command}
          onInput={(e) => (setCommand(e.currentTarget.value), say(''))} onKeyDown={enter} />
        {error && <p class="hint err" role="alert">{error}</p>}
      </Row>
      <Row name="">
        <button type="button" class="btn" onClick={save}>{at ? 'Save' : 'Add'}</button>
        <button type="button" class="btn" onClick={done}>Cancel</button>
        {at && <button type="button" class="btn" onClick={() => void keep(own.map((o) => (o.id === at.id ? { ...o, removed: true } : o)))}>Remove</button>}
      </Row>
    </div>
  );
}

export function AgentsPane() {
  useEffect(() => look(), []);
  // The form: closed, open for a new agent (''), or for one of the person's own by its id.
  const [form, setForm] = useState<string | null>(null), [folded, fold] = useState(true);
  const agents = [...records.agents.values()];
  if (!agents.length) return <p class="note">Finding your agents…</p>;
  const usual = agent()?.id, allowed = pref('agent_options'), own = pref('own_agents');
  // Here, or the person's own, or started their own way: such a one stays in sight where its program is missing, to be
  // changed.
  const mine = (a: AgentHealth) => a.own || (a.supported && !!commandOf(a.id));
  const here = agents.filter((a) => runs(a) || mine(a)), rest = agents.filter((a) => !runs(a) && !mine(a));
  // The person's own that they removed: no agents any more, and kept by name for what they ran.
  const gone = own.filter((o) => o.removed);
  const line = (a: AgentHealth) => {
    const off = runs(a) && a.signed_in === false, on = runs(a) && !off;
    // Of one of the person's own that is here there is nothing to check: only what Tasktap hears of it is said. Of one
    // started the person's way whose command does not start it, why, in the core's words.
    const fails = a.supported && a.command_fails ? sentence(a.command_fails) : '';
    const state = a.own && runs(a) ? '' : fails || agentState(a, looking.on, ago(a.checked));
    const says = [a.version, state, ...about(a), a.identity].filter(Boolean).join(' · ');
    // What wants the person: one that is signed out, one of their own whose program is missing. One that is simply
    // not here is said quietly.
    const s = on ? undefined : off || mine(a) ? 'off' : 'none';
    return (
      <>
        <div class="line ag" data-s={s} data-agent={a.id}>
          <Ring agent={a.id} s={on ? '' : 'off'} />
          <span class="t">{a.name}</span>
          <span class="x" title={says}>{says}</span>
          <span class="acts">
            {off && a.id in signIn && (
              <button type="button" class="btn" onClick={() => (dismiss(), newTerminal(LOOSE, { title: `Sign in to ${a.name}`, type: (commandOf(a.id) || a.program) + signIn[a.id] }))}>Sign in</button>
            )}
            {a.own && <button type="button" class="btn" onClick={() => setForm(a.id)}>Change</button>}
            {a.id === usual ? <span class="x def">Runs new tasks</span> : on && <button type="button" class="btn" onClick={() => setPref({ id: 'agent', patch: a.id })}>Use for new tasks</button>}
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
        {!a.own && a.supported && <Start key={a.id} a={a} />}
      </>
    );
  };
  return (
    <>
      <div class="list">
        {here.map(line)}
        {rest.length + gone.length > 0 && (
          <button type="button" class="line fold-l" aria-expanded={!folded} onClick={() => fold(!folded)}>
            <I n="chev" />
            <span class="t">{rest.length ? `Not on ${HERE}` : 'Removed'}</span>
            <span class="x">{[...rest.map((a) => a.name), ...gone.map((o) => `${o.name} (removed)`)].join(', ')}</span>
          </button>
        )}
        {!folded && rest.map(line)}
        {!folded && gone.map((o) => (
          <div class="line ag" data-s="none" data-agent={o.id}>
            <Ring agent={o.id} s="off" />
            <span class="t">{o.name}</span>
            <span class="x">Removed: its name stays on its past work</span>
            <span class="acts">
              <button type="button" class="btn" onClick={() => void keepOwn(own.map((x) => (x.id === o.id ? { ...x, removed: false } : x))).catch(fail)}>Add back</button>
              <button type="button" class="btn" onClick={() => void keepOwn(own.filter((x) => x.id !== o.id)).catch(fail)}>Forget</button>
            </span>
          </div>
        ))}
        {form === '' ? <Own key="new" at={null} done={() => setForm(null)} /> : (
          <button type="button" class="line fold-l" onClick={() => setForm('')}>
            <I n="plus" />
            <span class="t">Add your own agent</span>
            <span class="x">Any command-line program that ends when the work is done</span>
          </button>
        )}
      </div>
      <p class="note">New tasks go to the agent that says “Runs new tasks”; for a single task, choose a different agent where you write the task.</p>
      <Row name="Check which agents are signed in" hint="Each agent is asked once after Tasktap starts, when you first open Agents or give an agent a task; Check now asks all again.">
        <button type="button" class="btn" disabled={looking.on} onClick={() => look(true)}>{looking.on ? 'Checking…' : 'Check now'}</button>
      </Row>
    </>
  );
}
