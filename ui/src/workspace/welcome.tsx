// The welcome: what Tasktap asks once, as the window's first picture. On a first start (no step done or skipped before)
// the main window shows it by itself in place of Home: one step in view, centred, one headline, at most one sentence,
// one primary action and a quiet Skip, with quiet marks for where the person is. Four steps: the projects (the search
// starts as the step appears), the agents, who finds the project for a task (the agreement, the same call as the
// switch in Settings › Placing), and talking instead of typing. Return takes the primary action, Escape leaves. After the last
// step Home shows with the cursor in the Composer. A step left open stays open: Home then has one quiet line, "Finish
// setup", that comes back to the first open one; Settings › About shows the welcome again. Nothing of it is kept by the
// page but where it is: what was answered is in the records (a look, `route_by`, speech), and that the first start was
// seen is the `setup_hidden` preference, written as the welcome first shows.
import type { AgentHealth } from '../../../core/proto/protocol.ts';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { cap } from '../capture.tsx';
import { keyName } from '../keys.ts';
import { Voice } from '../motion/voice.ts';
import { keyTimes, talkKey } from '../page.ts';
import { local, model } from '../speech/local.ts';
import { voiced } from '../speech/record.ts';
import { HERE, shownPath } from '../system.ts';
import { Glyph, I, Key, Level, Mark } from '../ui.tsx';
import { chatgptRow, placing } from '../way.ts';
import { canSignIn, signInTo } from './agents.tsx';
import { OLLAMA, OwnFields, PLACING_SAYS, PLACING_TITLE, Sent, foundOllama, openOwn, serviceName, signInWithChatGPT, useFound, useRanks } from './consent.tsx';
import { Choice, Row, Switch, setPref } from './form.tsx';
import { Light, useLight } from './light.tsx';
import { CHATGPT, OWN, agent, agentName, call, core, dismiss, fail, loadTerms, page, placers, pref, records, redraw, runs, ui } from './model.ts';
import { searchInFolder, seen, useFirstSearch } from './projects.tsx';
import './welcome.css';

export type Step = 'projects' | 'agents' | 'placing' | 'voice';
const STEPS: Step[] = ['projects', 'agents', 'placing', 'voice'];

/** Whether the welcome is up, and at which step. */
export const welcome = { on: false, step: 'projects' as Step, decided: false };

/** The steps still open, as the records say: no look is on, no agent can run now, nobody was asked to find the project
 *  (an answer of No counts), speech is neither on this Mac nor at a service. */
export function openSteps(): Step[] {
  const by = pref('route_by');
  return STEPS.filter((s) => s === 'projects' ? ![...records.looks.values()].some((l) => l.on)
    : s === 'agents' ? ![...records.agents.values()].some((a) => runs(a) && a.signed_in !== false)
      : s === 'placing' ? !records.prefs.has('route_by') || placing(by, placers()) === 'again'
        : !voiced());
}

/** Shows the welcome, at the first step still open (or the one asked for). */
export function showWelcome(step?: Step) {
  dismiss();
  welcome.on = true;
  welcome.step = step ?? openSteps()[0] ?? 'projects';
  ui.view = 'home';
  redraw();
}
function leave() {
  stopTrial();
  welcome.on = false;
  page.focus = '#capture-input';
  redraw();
}
function next() {
  const at = STEPS.indexOf(welcome.step);
  if (at === STEPS.length - 1) return leave();
  welcome.step = STEPS[at + 1]!;
  page.focus = '.wc';
  redraw();
}

/** A click anywhere in the page before Home's first picture with the records: the person is already at work. */
let clicked = false;
addEventListener('pointerdown', () => (clicked = true), true);
/** The first start, decided once, from what is stored, as the records first arrive and before Home is drawn with them:
 *  nothing says a step was seen (projects.tsx `seen`), Home is shown, nothing else is open, and the person has neither
 *  clicked nor typed (a key anywhere, or words in the Composer). Then the welcome is the first picture, and it does
 *  not come by itself again. Otherwise it never comes by itself in this page's life. */
export function firstStart() {
  if (welcome.decided) return;
  welcome.decided = true;
  if (seen() || ui.view !== 'home' || ui.sheet || clicked || keyTimes.last > -Infinity || cap.draft.trim()) return;
  welcome.on = true;
  welcome.step = 'projects';
  void call('put', { c: 'prefs', id: 'setup_hidden', patch: false }).catch(fail);
}

/** On Home, one quiet line while a step is open: it comes back to the first. */
export function Finish() {
  if (!core.in || welcome.on || !openSteps().length) return null;
  return <button type="button" class="finish" data-nav onClick={() => showWelcome()}>Finish setup</button>;
}

/** Settings › About: the welcome again, from the first step. */
export function WelcomeRow() {
  return <Row name="Welcome"><button type="button" class="btn" onClick={() => showWelcome('projects')}>Show again</button></Row>;
}

// ——— The page of a step ———

type Act = { label: string; do: () => void; off?: boolean; card?: boolean };
/** One step on one panel: its headline (with `aside`, quiet data beside it), at most a sentence, what it shows, its one
 *  primary action, the quiet ones, and at the foot where the person is and Skip. Return takes the primary action (unless
 *  a control has it), Escape leaves, Skip goes on and leaves the step open. */
function Page({ title, aside, says, primary, other, children }: { title: string; aside?: string; says?: string; primary?: Act; other?: Act; children?: ComponentChildren }) {
  const at = STEPS.indexOf(welcome.step);
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Escape') return (e.preventDefault(), leave());
    if (e.key === 'Enter' && !e.isComposing && primary && !primary.off && !(e.target as HTMLElement).closest('button, input, a')) (e.preventDefault(), primary.do());
  };
  return (
    <div class="wc" id="wc" tabIndex={-1} onKeyDown={keys}>
      <div class="wc-i" key={welcome.step}>
        <h1>{title}{aside && <span class="wc-k">{aside}</span>}</h1>
        {says && <p class="wc-s">{says}</p>}
        <div class="wc-b">{children}</div>
        <div class="wc-a">
          {primary && !primary.card && <button type="button" class="key" id="wc-go" disabled={primary.off} onClick={primary.do}><I n="ret" /><span>{primary.label}</span></button>}
          {other && <button type="button" class="btn lg" onClick={other.do}>{other.label}</button>}
        </div>
        <footer class="wc-f">
          <ol class="wc-m" aria-label={`Step ${at + 1} of ${STEPS.length}`}>{STEPS.map((s, i) => <li key={s} data-on={i === at || undefined} data-done={i < at || undefined} />)}</ol>
          <button type="button" class="wc-skip" onClick={next}>Skip</button>
        </footer>
      </div>
    </div>
  );
}

// ——— 1. Projects ———

/** Rows shown before "and N more". */
const ROWS = 8;
function Projects() {
  const { all, busy, none, why } = useFirstSearch();
  const [more, showMore] = useState(false);
  const shown = more ? all : all.slice(0, ROWS);
  const title = none ? (why && !/^No projects found/.test(why.title) ? why.title : 'No projects found in your home folder') : 'Your projects';
  return (
    <Page title={title} aside={all.length ? `${all.length} found` : undefined}
      primary={none ? { label: 'Search in a folder…', do: () => void searchInFolder() } : { label: 'Continue', do: next, off: !all.length }}
      other={none ? undefined : { label: 'Search in a folder…', do: () => void searchInFolder() }}>
      {busy && !all.length && <p class="wc-n" role="status"><Mark s="working" label="" />Searching…</p>}
      {none && why?.line && <p class="wc-n">{why.line}</p>}
      {all.length > 0 && (
        <div class={`wc-l${more ? ' all' : ''}`} role="group" aria-label="Projects" aria-busy={busy}>
          {shown.map((c) => (
            <div class="wc-r" key={c.id} data-off={c.hidden || undefined}>
              <I n="folder" /><span class="t">{c.name}</span><span class="x">{shownPath(c.folder)}</span>
              <Switch on={!c.hidden} name={`${c.name} is a project`} set={(on) => void call('put', { c: 'cards', id: c.id, patch: { hidden: !on } }).catch(fail)} />
            </div>
          ))}
        </div>
      )}
      {!more && all.length > ROWS && <button type="button" class="wc-more" onClick={() => showMore(true)}>and {all.length - ROWS} more</button>}
    </Page>
  );
}

// ——— 2. Agents ———

function Agents() {
  const here = [...records.agents.values()].filter((a) => runs(a));
  const usual = agent()?.id, can = here.filter((a) => a.signed_in !== false);
  return (
    <Page title="Your agents" primary={{ label: 'Continue', do: next }}>
      <div class="wc-l">
        {here.map((a: AgentHealth) => (
          <div class="wc-r" key={a.id}>
            <Glyph agent={a.id} size={20} tone={a.signed_in === false ? 'quiet' : undefined} /><span class="t">{a.name}</span><span class="x">{a.version}</span>
            {a.signed_in === false && canSignIn(a) && <button type="button" class="btn" onClick={() => signInTo(a)}>Sign in</button>}
          </div>
        ))}
      </div>
      {can.length > 0 && (
        <div class="wc-c"><span>New tasks start with</span>
          <Choice name="New tasks start with" value={usual ?? ''} all={can.map((a): [string, string] => [a.id, a.name])} set={(id) => setPref({ id: 'agent', patch: id })} />
        </div>
      )}
    </Page>
  );
}

// ——— 3. Placing ———

/** One way to have tasks placed: the whole card is the one target, the action's words at its foot. `primary`: the one
 *  Return takes (the page's key stands in the card). */
function Card({ id, title, off, go, primary, action, children }: { id?: string; title: string; off?: boolean; go: () => void; primary?: boolean; action: string; children: ComponentChildren }) {
  return (
    <button type="button" class="wc-card" id={id} disabled={off} onClick={go}>
      <span class="wc-t">{title}</span>
      <span class="wc-c2">{children}</span>
      <span class={primary ? 'key lg' : 'btn lg'}>{primary && <I n="ret" />}<span>{action}</span></span>
    </button>
  );
}

function Placing() {
  const { t, rows, write, tools } = useRanks();
  useEffect(() => void loadTerms(), []);
  const c = pref('chatgpt')?.state, signed = c === 'signed_in', waiting = c === 'waiting', says = chatgptRow(pref('chatgpt')).says;
  const agree = (only: (agent: string) => boolean) => void write(rows.map((r) => ({ ...r, on: only(r.agent) }))).then(next, fail);
  const asked = rows.filter((r) => r.agent !== CHATGPT && r.agent !== OWN && tools.some((x) => x.agent === r.agent));
  useFound();
  const here = foundOllama();
  return (
    <Page title={PLACING_TITLE} says={PLACING_SAYS}
      primary={{ ...(signed ? { label: 'Use ChatGPT', do: () => agree((a) => a === CHATGPT), off: !t } : { label: 'Sign in with ChatGPT', do: signInWithChatGPT, off: waiting }), card: true }}>
      <div class="wc-o" role="group" aria-label="Who finds the project" data-n={here ? 3 : 2}>
        <Card id="wc-go" title="ChatGPT" off={signed ? !t : waiting} go={signed ? () => agree((a) => a === CHATGPT) : signInWithChatGPT} primary action={signed ? 'Use ChatGPT' : 'Sign in with ChatGPT'}>
          <Glyph agent={CHATGPT} size={40} />
          {(signed || waiting) && <span class="x">{signed ? 'Signed in' : 'Waiting for your browser'}</span>}
        </Card>
        <Card title="Your agents" off={!t || !asked.length} go={() => agree((a) => a !== CHATGPT && a !== OWN)} action="Use my agents">
          <span class="wc-q">{asked.slice(0, 4).map((r) => <Glyph key={r.agent} agent={r.agent} size={32} />)}</span>
          <span class="x">{asked.map((r) => agentName(r.agent)).join(', ')}</span>
        </Card>
        {here && (
          <Card title={`On ${HERE}`} go={() => openOwn(OLLAMA)} action="Use Ollama">
            <Glyph agent="ollama" size={40} />
          </Card>
        )}
      </div>
      <OwnFields then={next} />
      {says && <p class={`wc-n${c === 'failed' || c === 'no_plan' || c === 'no_model' ? ' warn' : ''}`} role="status">{says}</p>}
      <Sent rows={rows} />
    </Page>
  );
}

// ——— 4. Voice ———

/** The microphone, between the person's two clicks (and for eight seconds at most): its level is shown, nothing is
 *  recorded or sent. */
let trial: Voice | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let said = '';
function stopTrial() {
  trial?.close();
  trial = null;
  clearInterval(timer);
}
async function tryIt() {
  if (trial) return (stopTrial(), redraw());
  said = '';
  try {
    const v = await Voice.microphone();
    trial = v;
    v.onend = () => (stopTrial(), redraw());
    const until = Date.now() + 8000;
    timer = setInterval(() => (Date.now() > until ? (stopTrial(), redraw()) : redraw()), 100);
  } catch (e) {
    said = e instanceof Error ? e.message : String(e);
  }
  redraw();
}
const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);

function Voice4() {
  useEffect(() => (void model().catch(() => {}), stopTrial), []);
  const [err, say] = useState('');
  const l = local.now, service = pref('speech_by');
  const install = () => (say(''), void model('install').catch((e: unknown) => say(e instanceof Error ? e.message : String(e))));
  const state = service ? `By ${serviceName(service.server)}` : l?.model === 'ready' ? 'Ready' : l?.model === 'fetching' ? 'Downloading' : l?.model === 'failed' ? 'Failed' : l?.supported ? 'Not downloaded' : 'Needs a speech service';
  return (
    <Page title="Talk instead of typing" primary={{ label: 'Done', do: next }}>
      <dl class="wc-d">
        <dt>Hold to talk</dt><dd><Key k={keyName(talkKey())} /></dd>
        <dt>Try it</dt>
        <dd>
          <button type="button" class="btn" onClick={() => void tryIt()}>{trial ? 'Stop' : 'Listen'}</button>
          {trial && <Level l={trial.level} size={24} />}
          {said && <span class="warn" role="alert">{said}</span>}
        </dd>
        <dt>Speech recognition</dt>
        <dd>
          <span>{state}</span>
          {l?.model === 'fetching' && <><span class="x">{share(l.have, l.of)}</span><progress class="got" max={l.of} value={l.have} aria-label="Download" /></>}
          {!service && l?.supported && l.model !== 'ready' && l.model !== 'fetching' && <button type="button" class="btn" onClick={install}>Download {size(l.of)}</button>}
          {l?.model === 'fetching' && <button type="button" class="btn" onClick={() => void model('stop').catch(fail)}>Stop</button>}
          {l?.model === 'failed' && <span class="warn" role="alert">{l.error}</span>}
          {err && <span class="warn" role="alert">{err}</span>}
        </dd>
      </dl>
    </Page>
  );
}
const share = (have: number, of: number) => `${Math.floor((100 * have) / Math.max(1, of))} %`;

// ——— The window ———

export function Welcome() {
  const light = useLight();
  useEffect(() => void (page.focus = '.wc'), []);
  const Step = { projects: Projects, agents: Agents, placing: Placing, voice: Voice4 }[welcome.step];
  return (
    <div class="room" style={light.vars}>
      <Light load="quiet" />
      <div class="welcome" id="main"><Step /></div>
    </div>
  );
}
