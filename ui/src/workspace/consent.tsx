// The two things that leave this Mac only once the person has allowed them: a model that places each task they did not
// place by hand, and writes its brief (the `route_by` preference: which placers, in the order they are asked), and a
// speech service that turns what they say into text (`speech_by`). Placing is a section of Settings of its own, with
// the switch that is the agreement, the placers as rows, and what is sent and the instructions in place (`Placing`);
// the welcome's cards agree to the same. Speech is a sheet that shows, in the core's own words (`speech.terms`), what is
// sent and to whom before anything is stored; Allow writes the preference, and its section of Settings says what is on,
// changes it and turns it off. Nothing here is kept by the page.
//
// A third placer is the model at an address the person names, in the chat-completions form that Ollama, LM Studio,
// llama.cpp, vLLM and most hosted services speak (core own.rs): its row sits under ChatGPT's, three fields open in place
// (address, model, key), and setting it up is the agreement for its row, as signing in is for ChatGPT's.
//
// Speech has a second way that sends nothing: on this Mac, by a model the person downloads once (speech/local.ts).
// Its row says what it needs, how far the download is, that it is ready and how large, or why it failed, and removes
// it. Which of the two is in use is the `speech_by` preference alone: with it the service, without it this Mac.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { type Local, local, model, watch } from '../speech/local.ts';
import { Glyph, I } from '../ui.tsx';
import { AGAIN, type Rank, ownMark, agreement, chatgptOffer, chatgptRow, moved, ownOffer, placeWhy, places, placing, ranked } from '../way.ts';
import { CHATGPT, OWN, agentName, call, fail, loadTerms, open, placers, pref, records, redraw, terms } from './model.ts';
import { Row, Switch, setPref } from './form.tsx';
import { toPlacing } from '../question.tsx';
import { type Act, Frame } from './sheets.tsx';
import { HERE, KEYS_KEPT, mac } from '../system.ts';

const said = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ——— Placing thoughts ———

/** A time as the person's clock shows it. */
const at = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** The agents that place thoughts, in the person's order: a row each, with its place among those switched on, its
 *  ring, its name, the model it is asked for (ChatGPT's by its name) and why it stands there (or until when it is
 *  passed over), and its switch. ↑ ↓ go from row to row, ⌥↑ ⌥↓ move the one in focus, Space switches it; a row is
 *  dragged by any part but its switch. `set` is given the rows after each change. `lead`: the rows of the placers
 *  not set up, first, which are none of those. ChatGPT's row, signed in, has the way to sign out where an agent's has
 *  its time. */
export function Ranks({ rows, set, lead }: { rows: Rank[]; set: (rows: Rank[]) => void; lead?: ComponentChildren }) {
  const list = useRef<HTMLDivElement>(null);
  const [held, hold] = useState<number | null>(null);
  const n = places(rows), tools = terms.route?.tools ?? [];
  const row = (i: number) => list.current?.querySelectorAll<HTMLElement>('.rank:not(.sign)')[i];
  const toggle = (i: number) => set(rows.map((r, j) => (j === i ? { ...r, on: !r.on } : r)));
  const keys = (i: number) => (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('.btn')) return;
    const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0, plain = !e.metaKey && !e.ctrlKey && !e.shiftKey;
    if (step && plain && e.altKey) {
      const to = i + step;
      if (to < 0 || to >= rows.length) return e.preventDefault();
      set(moved(rows, i, to));
      requestAnimationFrame(() => row(to)?.focus());
    } else if (step && plain) row(i + step)?.focus();
    else if (e.key === ' ' && plain && !e.altKey) toggle(i);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  // Picked up where it is pressed, it goes where the pointer is over another row, and stays where it is let go.
  const press = (i: number) => (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.switch, .btn')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    hold(i);
  };
  const drag = (e: PointerEvent) => {
    if (held === null) return;
    const to = [...(list.current?.querySelectorAll<HTMLElement>('.rank:not(.sign)') ?? [])].findIndex((el) => {
      const b = el.getBoundingClientRect();
      return e.clientY >= b.top && e.clientY < b.bottom;
    });
    if (to >= 0 && to !== held) (set(moved(rows, held, to)), hold(to));
  };
  const drop = () => held !== null && (row(held)?.focus(), hold(null));
  return (
    <div class="ranks" role="list" aria-label="Who finds the project, the first asked first" ref={list}>
      {lead}
      {rows.map((r, i) => {
        const t = tools.find((x) => x.agent === r.agent);
        const limited = records.agents.get(r.agent)?.limited;
        const why = t ? placeWhy(t, limited, Date.now(), at) : '';
        const model = (r.agent === CHATGPT && chatgptRow(pref('chatgpt')).name) || r.model;
        return (
          <div key={r.agent} class={`line rank${held === i ? ' held' : ''}${r.on ? '' : ' off'}`} role="listitem" tabIndex={0}
            aria-label={`${n[i] ? `${n[i]}, ` : ''}${agentName(r.agent)}, ${r.on ? 'on' : 'off'}, ${why}`}
            onKeyDown={keys(i)} onPointerDown={press(i)} onPointerMove={drag} onPointerUp={drop} onPointerCancel={drop}>
            <span class="n">{n[i] ?? ''}</span>
            <Glyph agent={r.agent === OWN ? ownMark(pref('own_model')?.address ?? '') : r.agent} tone={r.on ? undefined : 'quiet'} />
            <span class="t">{agentName(r.agent)}</span>
            <span class="x m" title={model}>{model}</span>
            {r.agent === OWN ? <span class="x"><button type="button" class="btn" onClick={() => openOwn()}>Change</button></span>
              : r.agent === CHATGPT ? <span class="x"><button type="button" class="btn" onClick={signOut}>Sign out</button></span>
              : <span class={`x${limited && limited > Date.now() ? ' warn' : ''}`} title={why}>{why}</span>}
            <button type="button" role="switch" class="switch" tabIndex={-1} aria-checked={r.on} aria-label={`${agentName(r.agent)} helps find the project`} onClick={() => toggle(i)}><span /></button>
          </div>
        );
      })}
    </div>
  );
}

/** The agreement for ChatGPT's row (core chatgpt.rs `agree`), with what is sent and to whom one line away in its
 *  section. Once: a second press while the first is on its way does nothing. */
export const signInWithChatGPT = () => {
  if (signing) return;
  signing = true;
  void call('chatgpt.sign_in', {}).then((target) => call('host.open', { target })).catch(fail).finally(() => (signing = false));
};
const signOut = () => void call('chatgpt.sign_out', {}).catch(fail);
/** A sign-in with ChatGPT asked for and not answered yet. */
let signing = false;

/** ChatGPT's row while it is not signed in: its name and the button that signs in with ChatGPT, or Cancel while the
 *  browser is waited for, and why the last sign-in did not finish, in the row itself. */
export function SignIn() {
  const c = chatgptRow(pref('chatgpt'));
  if (c.state === 'in') return null;
  return (
    <div class="line rank sign off" role="listitem" aria-label={`ChatGPT, not signed in${c.says ? `. ${c.says}` : ''}`}>
      <span class="n" />
      <Glyph agent={CHATGPT} tone="quiet" />
      <span class="t wide">ChatGPT</span>
      <span />
      {c.state === 'waiting' ? <button type="button" class="btn" onClick={signOut}>Cancel</button>
        : <button type="button" class="btn" onClick={signInWithChatGPT}>Sign in with ChatGPT</button>}
      {c.says && <span class={`x says${c.state === 'out' ? ' warn' : ''}`}>{c.says}</span>}
    </div>
  );
}

// ——— The own model ———

/** Ollama's usual address on this machine, where a server is looked for without being told. */
export const OLLAMA = 'http://127.0.0.1:11434/v1';
/** The three fields while they are open, what the server at the address lists of models (none while it has not
 *  answered: then the model is typed), the models of a server found on this machine, and why the last try failed. */
const own = { open: false, address: '', model: '', key: '', models: null as string[] | null, found: null as string[] | null, err: '' };
const trimmed = () => own.address.trim().replace(/\/+$/, '');
let timer: ReturnType<typeof setTimeout> | undefined;

/** Asks the server at the address typed for its models, once the typing has paused. A server that does not answer is
 *  no error: the model is typed instead. */
function look(wait = 400) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const address = trimmed();
    if (!address) return ((own.models = null), redraw());
    const gone = () => address !== trimmed();
    void call('own_model.list', { address }).then(
      ({ models }) => !gone() && ((own.models = models), !own.model && models[0] && (own.model = models[0]), redraw()),
      () => !gone() && ((own.models = null), redraw()));
  }, wait);
}

/** Looks for a server on this machine at Ollama's usual address; one that does not answer costs nothing and says nothing. */
const detect = () => void call('own_model.list', { address: OLLAMA }).then(({ models }) => ((own.found = models), redraw()), () => own.found && ((own.found = null), redraw()));

/** Opens the three fields: with `address` (a server found), else the own model's, else empty. */
export function openOwn(address?: string) {
  const set = pref('own_model');
  Object.assign(own, { open: true, address: address ?? set?.address ?? '', model: address ? '' : (set?.model ?? ''), key: '', models: null, err: '' });
  look(0);
  redraw();
}

/** A server answers on this machine at Ollama's usual address, and no own model is set up. */
export const foundOllama = () => !pref('own_model') && !!own.found;
/** Looks for one, once, as the page that offers it appears. */
export const useFound = () => useEffect(() => void (pref('own_model') || detect()), [!!pref('own_model')]);

const setUp = (then?: () => void) => {
  const address = trimmed(), model = own.model.trim();
  if (!address || !model) return (own.err = 'Your own model needs an address and a model.', redraw());
  void call('own_model.set', { address, model, key: own.key.trim() || undefined }).then(() => ((own.open = false), (own.key = ''), void loadTerms(), redraw(), then?.()), (e) => ((own.err = said(e)), redraw()));
};
const takeAway = () => void call('own_model.remove', {}).then(() => ((own.open = false), void loadTerms(), redraw()), fail);

/** The three fields, in place: the address, the model (a chooser once the server has answered with its models, else
 *  typed) and the key, if the server wants one, shown as dots. `then` runs once the model is set up. */
export function OwnFields({ then }: { then?: () => void }) {
  if (!own.open) return null;
  const set = pref('own_model'), keyed = pref('keys').includes(trimmed());
  const type = (what: 'address' | 'model' | 'key') => (e: Event) => ((own[what] = (e.currentTarget as HTMLInputElement).value), (own.err = ''), what === 'address' ? look() : redraw());
  const enter = (e: KeyboardEvent) => e.key === 'Enter' && !e.isComposing && (e.preventDefault(), e.stopPropagation(), setUp(then));
  const models = own.models?.length ? (own.models.includes(own.model) || !own.model ? own.models : [own.model, ...own.models]) : null;
  return (
    <div class="own" role="group" aria-label="Your own model">
      <label for="own-address">Address</label>
      <input id="own-address" class="text" spellcheck={false} autocomplete="off" maxLength={200} placeholder="https://" value={own.address} onInput={type('address')} onKeyDown={enter} />
      <label for="own-model">Model</label>
      {models ? <select id="own-model" class="text" value={own.model} onChange={type('model')}>{models.map((m) => <option value={m}>{m}</option>)}</select>
        : <input id="own-model" class="text" spellcheck={false} autocomplete="off" maxLength={200} value={own.model} onInput={type('model')} onKeyDown={enter} />}
      <label for="own-key">Key</label>
      <input id="own-key" class="text" type="password" autocomplete="off" spellcheck={false} maxLength={512} placeholder={keyed ? '••••••••' : 'Optional'} value={own.key} onInput={type('key')} onKeyDown={enter} />
      {own.err && <p class="warn" role="alert">{own.err}</p>}
      <div class="rank-f">
        <button type="button" class="btn" onClick={() => setUp(then)}>Use</button>
        <button type="button" class="btn" onClick={() => ((own.open = false), redraw())}>Cancel</button>
        {set && <button type="button" class="btn" onClick={takeAway}>Remove</button>}
      </div>
    </div>
  );
}

/** The own model's row while it is not set up, under ChatGPT's: its name and the button that opens the fields; where a
 *  server answers on this machine, "Ollama on this Mac" and "Use…" with its address already there. Set up, it is a row
 *  of the list like the others (`Ranks`). The fields open under it. */
export function OwnRow({ then }: { then?: () => void }) {
  useFound();
  const found = foundOllama();
  return (
    <>
      {!pref('own_model') && (
        <div class="line rank sign mine" role="listitem" aria-label={found ? `Ollama on ${HERE}, not used` : 'Your own model, not set up'} onClick={() => openOwn(found ? OLLAMA : undefined)}>
          <span class="n" />
          <Glyph agent={found ? 'ollama' : OWN} />
          {found ? <span class="t wide">Ollama on {HERE}</span> : <><span class="t">Your own model</span><span /></>}
          <span />
          <button type="button" class="btn">{found ? 'Use…' : 'Set up…'}</button>
        </div>
      )}
      <OwnFields then={then} />
    </>
  );
}

/** The rows of the placing group, in the person's agreement where there is one to these terms, else as Tasktap
 *  proposes them, and the write of rows as the agreement (`write`). A sign-in with ChatGPT or an own model set up
 *  agrees by itself (the core). */
export function useRanks() {
  const t = terms.route, tools = placers(), by = pref('route_by');
  const agreed = !!by && !!t && by.terms === t.terms;
  const write = (next: Rank[]) => call('put', { c: 'prefs', id: 'route_by', patch: agreement(next, by, t?.tools ?? [], t?.terms ?? 0) });
  return { t, tools, rows: ranked(agreed ? by : null, tools), write, state: placing(by, tools) };
}

/** What a row-moving list is moved by, said in the foot of Settings while the list has focus or the pointer. */
export const MOVES = `${mac ? '⌥↑ ⌥↓' : 'Alt+↑ Alt+↓'} or a drag moves a row, Space switches it.`;

/** What the group is called, in Settings › Placing and About. */
export const FINDING = 'Finding the project for a task';
const MASTER = 'Find the project for each task';

/** Settings › Placing: the switch that is the agreement (on, a model finds the project of each task the person did not
 *  place; off, Tasktap asks), under it the placers as rows, always, and what is sent and the instructions in place.
 *  What it says is what the core does: a model, once agreed to, decides every task the person did not place, from what
 *  more it is sent since the terms of smart placing (route.rs `TERMS`); without one, names on this machine. Off, every
 *  row is shown off, and a switch turned on is the agreement for that row alone. */
export function Placing() {
  const { tools, rows, write, state } = useRanks();
  const on = state === 'on', shown = on ? rows : rows.map((r) => ({ ...r, on: false }));
  const names = rows.filter((r) => r.on).map((r) => agentName(r.agent));
  const put = (next: Rank[]) => void write(next).catch(fail);
  const turn = (to: boolean) => (to ? rows.length && put(rows.map((r) => ({ ...r, on: true }))) : void call('put', { c: 'prefs', id: 'route_by', patch: null }).catch(fail));
  return (
    <>
      <Row name={MASTER} hint={on ? `Tasks you do not place go where they belong: ${names.length > 1 ? 'the first of these to answer' : names[0]} decides from earlier tasks and what your agents last answered.`
        : state === 'again' ? 'Until you agree again, only tasks that name their project are placed; Tasktap asks you about the rest.'
          : `A task that names its project goes there; for the rest Tasktap asks you${tools.length ? ', until you turn placing on' : terms.route ? ', until you sign in with ChatGPT, set up your own model, or set up an agent under Agents' : ''}.`}>
        <Switch on={on} name={MASTER} set={turn} />
        {state === 'again' && <span class="v warn">{AGAIN}</span>}
      </Row>
      <Row name="Who finds the project" hint={MOVES}>
        <Ranks rows={shown} set={put} lead={<><SignIn /><OwnRow /></>} />
      </Row>
      <Targeting />
      <Recorded />
      <Row name="Details">
        <Sent rows={shown} />
        <Instructions />
      </Row>
    </>
  );
}

// A question about a task a model would have placed, now that the agreement is to what was sent before, leads here.
toPlacing.go = () => open({ kind: 'settings', at: 'placing' });

/** Settings › Placing, under the placers, once placing is agreed to: whether the words of a task are sent to find
 *  its target while the person writes or speaks it (core preview.rs, `route.preview`). Off, no preview is sent and
 *  only the target Tasktap works out on this Mac shows. */
export function Targeting() {
  const { state } = useRanks();
  if (state !== 'on') return null;
  const name = 'Show the target while you write';
  return (
    <Row name={name} hint={`While you write or speak a task, the words so far are sent to find the target before you send the task. Off: only the target Tasktap works out on ${HERE} shows, and nothing is sent.`}>
      <Switch on={pref('show_target')} name={name} set={(on) => setPref({ id: 'show_target', patch: on })} />
    </Row>
  );
}

/** Settings › Placing, under the placers: how many placings the private record holds (core placings.rs), and
 *  the way to clear it. */
export function Recorded() {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => void call('placings.count', {}).then(setN, () => {}), []);
  const clear = () => void call('placings.clear', {}).then(() => setN(0), fail);
  return (
    <Row name="Placing record" hint={`The placing record stays on ${HERE} and helps Tasktap learn where your tasks go.`}>
      <span class="v">{n === null ? '' : n === 1 ? '1 entry' : `${n.toLocaleString('en-US')} entries`}</span>
      <button type="button" class="btn" disabled={!n} onClick={clear}>Clear</button>
    </Row>
  );
}

/** The one sentence of placing, under its headline, in the welcome and in the sheet. */
export const PLACING_TITLE = 'Let Tasktap find the project for each task';
export const PLACING_SAYS = 'A task you do not place yourself is sent with the names of your projects and sessions to the model you choose here.';

/** "What is sent", behind one quiet line: what placing is for, the core's own list of what goes to the model, and to
 *  which agent, word for word, and what ChatGPT's sign-in asks. */
export function Sent({ rows }: { rows: Rank[] }) {
  const [shown, show] = useState(false);
  const t = terms.route, c = chatgptRow(pref('chatgpt')), asks = t?.tools.find((x) => x.agent === CHATGPT)?.model, mine = pref('own_model');
  useEffect(() => void loadTerms(), []);
  return (
    <>
      <button type="button" class="disc" aria-expanded={shown} onClick={() => show(!shown)}><I n="chev" /><span>What is sent</span></button>
      {shown && (!t ? <p>Asking what is sent…</p> : (
        <div class="terms sent">
          <p>Give a task without choosing its place, and one of your own agents decides where the task belongs: which project, and whether an agent already at work there continues. Your own words always go along.</p>
          <p>Each such task goes to the first agent below that answers, one task at a time, under that agent's own sign-in. That agent is sent:</p>
          <ul class="sends">{t.sends.map((x) => <li>{x}</li>)}</ul>
          {c.state !== 'in' && asks && <p>{chatgptOffer(asks)}</p>}
          {mine && rows.some((r) => r.agent === OWN && r.on) && <p>{ownOffer(mine.address, HERE)}</p>}
          <p class="hint">A task you send to a place yourself is placed on {HERE} and sent nowhere; a long task is sent too, for its summary.{rows.some((r) => r.agent === 'agy' && r.on) && ' Antigravity keeps each task it is asked about as a conversation in its history.'}</p>
        </div>
      ))}
    </>
  );
}

/** The instructions each model follows, in full, behind one quiet line, with what the core cuts from each task. */
export function Instructions() {
  const [reads, setReads] = useState(false), t = terms.route;
  return (
    <>
      <button type="button" class="disc" aria-expanded={reads} onClick={() => setReads(!reads)}><I n="chev" /><span>The instructions they follow</span></button>
      {reads && (t ? <><p class="hint">{t.cuts}</p><pre class="instr" tabIndex={0}>{t.instructions}</pre></> : <p>Asking what is sent…</p>)}
    </>
  );
}

// ——— Speech ———

const SERVICES = [
  { name: 'OpenAI', server: 'https://api.openai.com', model: 'gpt-transcribe' },
  { name: 'Groq', server: 'https://api.groq.com/openai', model: 'whisper-large-v3-turbo' },
] as const;
const LANGUAGES: [string, string][] = [['de', 'German'], ['en', 'English'], ['fr', 'French'], ['es', 'Spanish'], ['it', 'Italian'], ['nl', 'Dutch'], ['pl', 'Polish'], ['pt', 'Portuguese']];
export const serviceName = (server: string) => SERVICES.find((s) => s.server === server)?.name ?? server.replace(/^https?:\/\//, '');
const setKey = (server: string, key: string) => call('key.set', { server, key });

/** A key is only ever written: once stored, all that shows is that one is, and the way to remove it. */
function Key({ server, value, onInput }: { server: string; value?: string; onInput?: (v: string) => void }) {
  const [err, say] = useState('');
  if (pref('keys').includes(server))
    return <><span class="v">Saved {KEYS_KEPT[0]!.toLowerCase()}{KEYS_KEPT.slice(1)}</span><button type="button" class="btn" onClick={() => void call('key.remove', { server }).catch(fail)}>Remove</button></>;
  return (
    <>
      <input class="text" type="password" aria-label="Key" autocomplete="off" spellcheck={false} maxLength={512} placeholder={onInput ? 'Paste a key, if the service wants one' : `Paste the key, then press ${mac ? 'Return' : 'Enter'}`}
        value={value} onInput={(e) => (say(''), onInput?.(e.currentTarget.value))}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || onInput || !e.currentTarget.value.trim()) return;
          const field = e.currentTarget;
          void setKey(server, field.value.trim()).then(() => (field.value = ''), (x) => say(said(x)));
        }} />
      {err && <p class="hint warn" role="alert">{err}</p>}
    </>
  );
}

const useLocal = () => void call('delete', { c: 'prefs', id: 'speech_by' }).catch(fail);
// Once its model is here, this Mac is what turns speech into text: the service the person used until then is let go.
watch((now, was) => was?.model === 'fetching' && now.model === 'ready' && pref('speech_by') && useLocal());
/** Which of the two the person is looking at, when it is not the one in use: this Mac while it is being set up. */
let shown: 'local' | '' = '';
const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
const MODEL = 'Whisper large-v3 turbo';
const WHERE = 'Where your speech becomes text', SPOKEN = 'Languages you speak';

/** "On this Mac": what it needs, how far that is, that it is ready and what it takes, or why it failed. */
function OnThisMac({ l, used }: { l: Local | null; used: boolean }) {
  const [err, say] = useState('');
  const act = (what: 'install' | 'stop' | 'remove') => (say(''), void model(what).catch((e) => say(said(e))));
  if (!l) return <span class="v dim">Checking…</span>;
  if (!l.supported) return <span class="v dim">Not available on this system. Voice needs a speech service here.</span>;
  const part = l.have > 0 && l.have < l.of;
  return (
    <>
      {l.model === 'ready' && <><span class="v">{used ? 'Ready' : 'Ready, not in use'}, {MODEL}, {mb(l.of)} on {HERE}</span><button type="button" class="btn" onClick={() => act('remove')}>Remove</button></>}
      {l.model === 'fetching' && (
        <>
          <span class="v" role="status">Downloading {Math.floor((100 * l.have) / l.of)} % of {mb(l.of)}</span>
          <button type="button" class="btn" onClick={() => act('stop')}>Stop</button>
          <progress class="got" max={l.of} value={l.have} aria-label="Download" />
        </>
      )}
      {l.model === 'none' && (
        <>
          <span class="v">{part ? `Stopped at ${Math.floor((100 * l.have) / l.of)} % of ${mb(l.of)}` : `Needs a model first: ${MODEL}, ${mb(l.of)}`}</span>
          <button type="button" class="btn" onClick={() => act('install')}>{part ? 'Continue' : 'Download'}</button>
          {part && <button type="button" class="btn" onClick={() => act('remove')}>Remove</button>}
        </>
      )}
      {l.model === 'failed' && (
        <>
          <span class="v warn" role="alert">{l.error}</span>
          <button type="button" class="btn" onClick={() => act('install')}>Try again</button>
          {l.have > 0 && <button type="button" class="btn" onClick={() => act('remove')}>Remove</button>}
        </>
      )}
      {err && <p class="hint warn" role="alert">{err}</p>}
    </>
  );
}

/** Settings, "Speech": where what the person says is turned into text, on this Mac or by a service, what each needs,
 *  and the languages they speak. */
export function Speech() {
  const by = pref('speech_by'), languages = pref('speech_languages'), l = local.now;
  const here = !by || shown === 'local', fetched = l?.model === 'ready';
  // Asked again whenever Settings opens: the host looks at the file.
  useEffect(() => void model().catch(() => {}), []);
  const toggle = (code: string) => {
    const next = languages.includes(code) ? languages.filter((x) => x !== code) : [...languages, code].slice(0, 4);
    void call('put', { c: 'prefs', id: 'speech_languages', patch: next }).catch(fail);
  };
  // This Mac is chosen by having its model; until then choosing it only shows what it needs.
  const choose = (where: 'local' | 'service') => {
    shown = where === 'local' ? 'local' : '';
    if (where === 'service' && !by) open({ kind: 'speech' });
    else if (where === 'local' && by && fetched) useLocal();
    else redraw();
  };
  // What changes for the person, in the state they are in: where their speech goes, or what it waits for.
  const svc = by ? serviceName(by.server) : '';
  const hint = !here ? `Each recording goes to ${svc} when you let go, and comes back as text.`
    : fetched ? `What you say becomes text on ${HERE} and is sent nowhere.`
      : l?.model === 'failed' ? `The download did not finish: try again${by ? `; until then ${svc} goes on turning your speech into text` : ', or choose a speech service meanwhile'}.`
        : l?.supported ? `Its model is downloaded once from huggingface.co; ${by ? `until it is here, ${svc} goes on turning your speech into text` : `after that, what you say becomes text on ${HERE} and is sent nowhere`}.`
          : l ? 'Choose At a speech service to use your voice; it is sent a recording only while you hold the key.'
            : `Tasktap is checking what ${HERE} needs to turn your speech into text.`;
  return (
    <>
      <Row name={WHERE} hint={hint}>
        <div class="seg" role="radiogroup" aria-label={WHERE}>
          <button type="button" role="radio" aria-checked={here} onClick={() => choose('local')}>On {HERE}</button>
          <button type="button" role="radio" aria-checked={!here} onClick={() => choose('service')}>At a speech service</button>
        </div>
        {here ? <OnThisMac l={l} used={!by} /> : <><span class="v">By {svc}, {by.model}</span><button type="button" class="btn" onClick={() => open({ kind: 'speech' })}>Change…</button></>}
      </Row>
      {by && !here && <Row name={`Key for ${svc}`} hint={`Sent only to ${svc}, with each recording, and never shown again.`}><Key server={by.server} /></Row>}
      <Row name={SPOKEN} hint={!languages.length ? 'Any language is listened for; choosing yours, up to four, helps Tasktap write down the right words.'
        : `What you say is written in whichever of these you speak${languages.length >= 4 ? '; turn one off to choose another' : ', up to four'}.`}>
        <div class="seg" role="group" aria-label={SPOKEN}>
          {LANGUAGES.map(([code, name]) => <button type="button" role="checkbox" aria-checked={languages.includes(code)} disabled={!languages.includes(code) && languages.length >= 4} onClick={() => toggle(code)}>{name}</button>)}
        </div>
      </Row>
    </>
  );
}

/** Choosing a speech service: which, its address and model, its key, exactly what is sent and where, before anything
 *  is stored. Allow writes the preference, and the key if one was typed. */
export function SpeechSheet() {
  const by = pref('speech_by'), t = terms.speech;
  const [server, setServer] = useState<string>(by?.server ?? SERVICES[0].server);
  const [model, setModel] = useState<string>(by?.model ?? SERVICES[0].model);
  const [other, setOther] = useState(!!by && !SERVICES.some((s) => s.server === by.server));
  const [key, typeKey] = useState('');
  const [err, say] = useState('');
  useEffect(() => void loadTerms(), []);
  const at = server.trim().replace(/\/+$/, ''), asks = model.trim();
  const done = () => open({ kind: 'settings', at: 'voice' });
  const same = !!by && by.server === at && by.model === asks && !key.trim();
  const allow = async () => {
    if (!at || !asks) return say('A speech service needs an address and a model.');
    try {
      await call('put', { c: 'prefs', id: 'speech_by', patch: { server: at, model: asks } });
      if (key.trim()) await setKey(at, key.trim());
      done();
    } catch (e) {
      say(said(e));
    }
  };
  const acts: Act[] = same
    ? [{ k: '⌘⌫', label: 'Turn off', kind: 'danger', do: () => void call('delete', { c: 'prefs', id: 'speech_by' }).then(done, fail) }, { k: 'esc', label: 'Close', do: done }]
    : [{ k: '↩', label: by ? 'Use this service' : 'Allow', kind: 'primary', do: () => void allow() }, { k: 'esc', label: by ? 'Close' : 'Not now', do: done }];
  const enter = (e: KeyboardEvent) => e.key === 'Enter' && !e.isComposing && (e.preventDefault(), void allow());
  return (
    <Frame size="md" title={by ? 'The speech service' : 'Use a speech service'} acts={acts}>
      <div class="terms">
        <p>While you hold to talk, the microphone is recorded. When you let go, the recording goes to the service you choose here and comes back as text. Nothing is recorded at any other time, and Tasktap keeps no recording.</p>
        <Row name="Service">
          <div class="seg" role="radiogroup" aria-label="Service">
            {SERVICES.map((s) => <button type="button" role="radio" aria-checked={!other && at === s.server} onClick={() => (setOther(false), setServer(s.server), setModel(s.model), say(''))}>{s.name}</button>)}
            <button type="button" role="radio" aria-checked={other || !SERVICES.some((s) => s.server === at)}
              onClick={() => (setOther(true), SERVICES.some((s) => s.server === at) && (setServer(''), setModel('')), say(''))}>Another server</button>
          </div>
        </Row>
        <Row name="Address">
          <input class="text wide" aria-label="Address" spellcheck={false} autocomplete="off" maxLength={200} placeholder="https://" value={server} readOnly={!other && SERVICES.some((s) => s.server === at)}
            onInput={(e) => (setServer(e.currentTarget.value), say(''))} onKeyDown={enter} />
          {/^http:/.test(at) && <p class="hint warn" role="alert">This address is not https: the recording, and a key, would travel unencrypted.</p>}
        </Row>
        <Row name="Model"><input class="text wide" aria-label="Model" spellcheck={false} autocomplete="off" maxLength={100} value={model} onInput={(e) => (setModel(e.currentTarget.value), say(''))} onKeyDown={enter} /></Row>
        <Row name="Key"><Key server={at} value={key} onInput={typeKey} /></Row>
        {err && <p class="warn" role="alert">{err}</p>}
        <h3>What it is sent</h3>
        <ul class="sends">{(t?.sent ?? []).map((s) => <li>{s}</li>)}</ul>
        {t && <p>Sent to <code>{at || 'the address above'}{t.path}</code>. One recording is at most {t.seconds % 60 ? `${t.seconds} seconds` : `${t.seconds / 60} minutes`}.</p>}
      </div>
    </Frame>
  );
}
