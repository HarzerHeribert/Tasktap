// Settings › Agents: the agents this Mac has, however many. First, which of those that can run now starts new tasks. Then
// the agents that are installed, each one line: its mark, its name and its version, and at the right only what wants the
// person (signed out, with Sign in; a start command that fails, and why; Change for one of their own). A chevron opens a
// row, closed to begin with and not remembered: its account, what of it the notch cannot do, the switches for what it
// does only when let (off until turned on), and the command that starts it where the person starts it their own way (a
// program of theirs around it, arguments of theirs): empty, Tasktap starts it as always. The ones that are not installed
// are folded into one line at the end, and with them the person's own that they removed: such an agent is kept, so that
// what it ran still says who ran it, until it is added back or forgotten. Last, an agent of the person's own: a name and
// a command line. What a row means is said in the foot of the window while the row has the pointer or the keyboard.
//
// No agent's program runs as the app starts. Opening this section has the core ask those it has not asked in its
// life whether they are signed in, as giving an agent its first thought does (calls.rs `look`); "Check now" asks
// every one.
import { useEffect, useState } from 'preact/hooks';
import type { AgentHealth, AgentWeight, OwnAgent, Weight } from '../../../core/proto/protocol.ts';
import { HERE, mac } from '../system.ts';
import { Glyph, I, ago } from '../ui.tsx';
import { agentState, ownAgentLacks } from '../way.ts';
import { WEIGHTS } from '../weights.tsx';
import { Choice, Row, Switch, setPref } from './form.tsx';
import { LOOSE, agent, call, dismiss, fail, newTerminal, pref, records, redraw, runs, sentence } from './model.ts';

/** What is typed into a terminal to sign an agent in. */
const signIn: Record<string, string> = { claude: 'claude', codex: 'codex login', agy: 'agy', pi: 'pi', opencode: 'opencode auth login' };
/** Signs in to an agent in a terminal of its own, where its row's Sign in goes; an agent with no sign-in of that kind has none. */
export const canSignIn = (a: AgentHealth) => !!signIn[a.id];
export const signInTo = (a: AgentHealth) => (dismiss(), newTerminal(LOOSE, { title: `Sign in to ${a.name}`, type: signIn[a.id] }));

/** What an opened row says about its agent, a line each: whose models it runs, where its name does not say, and what of it
 *  the notch cannot do, in the words of what the core says its runs can (its row's `events`, `permissions`,
 *  `questions`): of one that reports nothing Tasktap hears only when it ends, and what one asks where nothing outside
 *  its terminal can answer is answered there. Nothing is said of what the notch does answer. */
const family: Record<string, string> = { agy: 'Gemini' };
const about = (a: AgentHealth): [string, string][] => {
  const [p, q] = [a.permissions === 'terminal', a.questions === 'terminal'];
  return [family[a.id] && ['Models', family[a.id]!], !a.events && ['Progress', 'Tasktap hears only when it ends'], (p || q) && [p && q ? 'Asks' : p ? 'Approvals' : 'Questions', 'In its terminal']]
    .filter((x): x is [string, string] => !!x);
};
const up = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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

/** How the person starts one of Tasktap's agents their own way (`agent_commands`): empty where Tasktap starts it its own
 *  way. It applies to the starts the core makes itself; what is typed in a shell, Sign in's too, is the shell's. */
const commandOf = (id: string) => pref('agent_commands').find((c) => c.agent === id)?.command ?? '';
/** Writes the command of `a` as typed, or none for an empty field: the core's sentence for one it refuses, else none. Its
 *  length is counted in bytes, as the core counts it. */
function keepCommand(a: AgentHealth, typed: string): Promise<string> {
  const command = typed.trim(), rest = pref('agent_commands').filter((c) => c.agent !== a.id);
  if (new TextEncoder().encode(command).length > 2000) return Promise.resolve(sentence(`The command of ${a.name} is too long, or not one line`));
  return call('put', { c: 'prefs', id: 'agent_commands', patch: command ? [...rest, { agent: a.id, command }] : rest })
    .then(() => '', (e: Error) => sentence(e.message));
}
/** The line in an agent Tasktap brings: the command that starts it, with its program in the empty field, and an example of
 *  a start of the person's own in the foot while the field has the keyboard (on Windows an argument of Claude Code's;
 *  none for Codex, which has no such harmless one to show). A refusal belongs to what the field holds: it goes with the next command kept,
 *  and when the field shows the one kept again, as the section is left. */
function Start({ a }: { a: AgentHealth }) {
  const [why, say] = useState('');
  const name = `Command that starts ${a.name}`, p = a.program;
  const example = mac ? `caffeinate -i ${p}` : a.id === 'claude' ? `${p} --verbose` : '';
  const hint = <>Write how you start {a.name}{example && <>, such as <code>{example}</code></>}, without shell aliases; leave the field empty for Tasktap's own start.</>;
  return (
    <Row name="Start command" hint={why ? undefined : hint}>
      <input class="text wide" aria-label={name} placeholder={p} spellcheck={false} autocomplete="off" maxLength={2000} defaultValue={commandOf(a.id)}
        onChange={(e) => void keepCommand(a, e.currentTarget.value).then(say)} />
      {why && <p class="hint err" role="alert">{why}</p>}
    </Row>
  );
}

/** The aliases an agent keeps current by itself, offered as suggestions of its Model fields, where it has such: Claude Code's. Tasktap ships no other model name. The fields' placeholder says the agent's own is used. */
const ALIAS: Record<string, string[]> = { claude: ['haiku', 'sonnet', 'opus'] };
/** The ladder of an agent (`agent_weights`): what it starts a new task with at each weight, a model and an effort as the
 *  agent itself takes them; empty is the agent's own. Where the person's own start command already names a model or an
 *  effort, the foot says that one wins. A refusal belongs to the field it came from: it goes with the next line kept. */
function Ladder({ a }: { a: AgentHealth }) {
  const [bad, say] = useState<[Weight, string] | null>(null), p = a.passes!;
  const lines = (w: Weight) => pref('agent_weights').find((l) => l.agent === a.id && l.weight === w);
  const keep = (w: Weight, field: 'model' | 'effort', typed: string) => {
    const rest = pref('agent_weights').filter((l) => l.agent !== a.id || l.weight !== w);
    const line: AgentWeight = { agent: a.id, weight: w, model: lines(w)?.model ?? '', effort: lines(w)?.effort ?? '', [field]: typed.trim() };
    void call('put', { c: 'prefs', id: 'agent_weights', patch: line.model || line.effort ? [...rest, line] : rest }).then(() => say(null), (e: Error) => say([w, sentence(e.message)]));
  };
  const named = p.model_named && p.effort_named ? 'a model and an effort' : p.model_named ? 'a model' : p.effort_named ? 'an effort' : '';
  const own = `${a.name}'s own`;
  return (
    <>
      {ALIAS[a.id] && <datalist id={`${a.id}-models`}>{ALIAS[a.id]!.map((m) => <option value={m} />)}</datalist>}
      {WEIGHTS.map(([w, label]) => {
        const why = bad?.[0] === w ? bad[1] : '', hint = why ? undefined : named ? `The command that starts ${a.name} names ${named}, so ${a.name} runs on that at every weight.`
          : `The model and the effort ${a.name} starts a ${label.toLowerCase()} task with; leave a field empty for ${a.name}'s own.`;
        return (
          <Row key={w} name={label} hint={hint}>
            <label class="fld"><span>Model</span>
              <input class="text" aria-label={`${a.name}, ${label}: model`} list={ALIAS[a.id] ? `${a.id}-models` : undefined} placeholder={own} spellcheck={false} autocomplete="off" maxLength={250} defaultValue={lines(w)?.model ?? ''}
                onChange={(e) => keep(w, 'model', e.currentTarget.value)} />
            </label>
            {p.effort && (
              <label class="fld"><span>Effort</span>
                <input class="text short" aria-label={`${a.name}, ${label}: effort`} placeholder={own} spellcheck={false} autocomplete="off" maxLength={250} defaultValue={lines(w)?.effort ?? ''}
                  onChange={(e) => keep(w, 'effort', e.currentTarget.value)} />
              </label>
            )}
            {why && <p class="hint err" role="alert">{why}</p>}
          </Row>
        );
      })}
    </>
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
  // The form: closed, open for a new agent (''), or for one of the person's own by its id. The rows opened by their
  // chevron: none to begin with, and none remembered.
  const [form, setForm] = useState<string | null>(null), [folded, fold] = useState(true), [opened, openRows] = useState<string[]>([]);
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
    const off = runs(a) && a.signed_in === false, on = runs(a) && !off, open = opened.includes(a.id);
    // Of one of the person's own that is here there is nothing to check: only what Tasktap hears of it is said. Of one
    // started the person's way whose command does not start it, why, in the core's words.
    const fails = a.supported && a.command_fails ? sentence(a.command_fails) : '';
    const state = a.own && runs(a) ? '' : agentState(a, looking.on, ago(a.checked));
    // What wants the person: one that is signed out, one whose command fails, one of their own whose program is missing.
    // One that is simply not here is quiet.
    const wants = fails || (!on && !off && mine(a) ? up(state) : '');
    const command = a.own ? '' : commandOf(a.id);
    return (
      <>
        <div class="line ag" data-s={on || off || mine(a) ? undefined : 'none'} data-agent={a.id}>
          <Glyph agent={a.id} tone={on ? undefined : 'quiet'} />
          <span class="t">{a.name}</span>
          {command ? <span class="x mono" title={command}>{command}</span> : <span class="x">{a.version}</span>}
          <span class="acts">
            {off && <span class="x warn">Signed out</span>}
            {off && canSignIn(a) && <button type="button" class="btn" onClick={() => signInTo(a)}>Sign in</button>}
            {wants && <span class="x warn" title={wants}>{wants}</span>}
            {a.own && <button type="button" class="btn" onClick={() => setForm(a.id)}>Change</button>}
          </span>
          <button type="button" class="ib chev" aria-expanded={open} aria-label={`${a.name}, details`} onClick={() => openRows(open ? opened.filter((x) => x !== a.id) : [...opened, a.id])}><I n="chev" /></button>
        </div>
        {form === a.id && <Own key={a.id} at={own.find((o) => o.id === a.id) ?? null} done={() => setForm(null)} />}
        {open && (
          <div class="ag-d">
            {a.identity && <Row name="Account"><span class="v">{a.identity}</span></Row>}
            {about(a).map(([k, v]) => <Row name={k}><span class="v">{v}</span></Row>)}
            {on && a.options.map((o) => {
              const id = `${a.id}.${o.id}`;
              return (
                <Row name={o.name} hint={o.allows}>
                  <Switch on={allowed.includes(id)} name={`${a.name}: ${o.name}`} set={(to) => setPref({ id: 'agent_options', patch: to ? [...allowed, id] : allowed.filter((x) => x !== id) })} />
                </Row>
              );
            })}
            {on && a.note && <Row name="Note"><span class="v">{a.note}</span></Row>}
            {!a.own && a.supported && <Start key={a.id} a={a} />}
            {!a.own && a.supported && a.passes && <Ladder key={`${a.id}.ladder`} a={a} />}
          </div>
        )}
      </>
    );
  };
  const can = agents.filter((a) => runs(a) && a.signed_in !== false);
  return (
    <>
      <Row name="New tasks start with" hint="For a single task, choose a different agent where you write the task. Which model finds the project for a task is set under Placing.">
        <Choice name="New tasks start with" value={usual ?? ''} all={can.map((a): [string, string] => [a.id, a.name])} set={(id) => setPref({ id: 'agent', patch: id })} />
      </Row>
      <div class="list">
        {here.map(line)}
        {rest.length + gone.length > 0 && (
          <button type="button" class="line fold-l" aria-expanded={!folded} onClick={() => fold(!folded)}>
            <I n="chev" />
            <span class="t">{rest.length ? `Not on ${HERE}` : 'Removed'}</span>
            <span class="x">{rest.length + gone.length}</span>
          </button>
        )}
        {!folded && rest.map(line)}
        {!folded && gone.map((o) => (
          <div class="line ag" data-s="none" data-agent={o.id}>
            <Glyph agent={o.id} tone="quiet" />
            <span class="t">{o.name}</span>
            <span class="x">Removed</span>
            <span class="acts">
              <button type="button" class="btn" onClick={() => void keepOwn(own.map((x) => (x.id === o.id ? { ...x, removed: false } : x))).catch(fail)}>Add back</button>
              <button type="button" class="btn" onClick={() => void keepOwn(own.filter((x) => x.id !== o.id)).catch(fail)}>Forget</button>
            </span>
            <span />
          </div>
        ))}
        {form === '' ? <Own key="new" at={null} done={() => setForm(null)} /> : (
          <button type="button" class="line fold-l" onClick={() => setForm('')}>
            <I n="plus" />
            <span class="t">Add your own agent</span>
          </button>
        )}
      </div>
      <Row name="Check which agents are signed in" hint="Each agent is asked once after Tasktap starts, when you first open Agents or give an agent a task; Check now asks all again.">
        <button type="button" class="btn" disabled={looking.on} onClick={() => look(true)}>{looking.on ? 'Checking…' : 'Check now'}</button>
      </Row>
    </>
  );
}
