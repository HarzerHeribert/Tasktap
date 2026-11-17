// Home, as 1.2's work overview: what needs you, what is in progress and what finished, from
// the same records the notch shows; a row opens its session's terminal. Below them, the agents
// this computer has and a terminal to sign in to one that is not signed in.
import type { Thought } from '../../../core/proto/protocol.ts';
import { routing } from '../capture.tsx';
import { Icon } from '../icons.tsx';
import { Backdrop, lookOf } from '../motion/motion.tsx';
import { motionState } from '../motion/state.ts';
import {
  LOOSE, agentName, call, fail, focusSession, newTerminal, open, openQuestions, projectName, records, resultOf, title, ui, why,
} from './model.ts';

/** How a person signs an agent in, typed into a shell that belongs to no project: its own
 *  command, which asks to sign in when it is not. */
const signIn: Record<string, string> = { claude: 'claude', codex: 'codex login' };

function Row({ t, kind }: { t: Thought; kind: 'attention' | 'progress' | 'results' }) {
  const q = openQuestions().find((x) => x.thought_id === t.id);
  const result = resultOf(t);
  const session = t.session_id ? records.sessions.get(t.session_id) : undefined;
  const state = ({
    captured: ['Captured', 'offline'], routed: ['Starting soon', 'running'], working: ['Working', 'running'],
    needs_you: [q?.reply_via === 'terminal' ? 'Waiting in its terminal' : 'Needs input', 'waiting'],
    done: ['Answer ready', 'complete'], failed: ['Failed', 'offline'],
  } satisfies Record<Thought['status'], [string, string]>)[t.status];
  const headline = kind === 'attention' && q ? q.prompt : title(t);
  const detail = t.status === 'failed' ? why(t) : kind === 'results' ? result?.summary : session?.activity.at(-1);
  const when = new Date(t.updated);
  const go = () => {
    if (q && !q.session_id) return open({ kind: 'reply', question: q.id });
    if (t.session_id && focusSession(t.session_id) && (t.status === 'done' || t.status === 'failed') && !t.read)
      void call('thought.read', { id: t.id }).catch(fail);
  };
  return (
    <button type="button" class={`session-row home-session-row${kind === 'attention' ? ' is-question' : ''}${kind === 'results' ? ' home-result-row' : ''}`}
      title={[t.text, detail].filter(Boolean).join('\n')} disabled={!q && !t.session_id} onClick={go}>
      <span class={`agent-mark ${t.agent ?? ''}`}><Icon name={t.agent ?? 'sessions'} /></span>
      <span class="home-row-body">
        <span class="row-title">{headline}</span>
        <span class="row-sub home-row-meta">
          <span class="home-row-project">{projectName(t.project_id)}</span>
          <span class="home-row-agent">{agentName(t.agent)}</span>
          {detail && <span class="home-row-host">{detail}</span>}
        </span>
      </span>
      <span class="home-row-end">
        {kind === 'results'
          ? <time class="home-result-time" dateTime={when.toISOString()}>{when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
          : <span class={`row-state ${state[1]}`}><i class="state-dot" aria-hidden="true" /><span>{state[0]}</span></span>}
        <Icon name="right" />
      </span>
    </button>
  );
}

function Section({ name, kind, rows }: { name: string; kind: 'attention' | 'progress' | 'results'; rows: Thought[] }) {
  if (!rows.length) return null;
  return (
    <section class="block home-session-section" data-home-section={kind}>
      <div class="home-section-heading"><h2>{name}<span class="home-section-count">{rows.length}</span></h2></div>
      <div class="session-list home-session-list">{rows.map((t) => <Row key={t.id} t={t} kind={kind} />)}</div>
    </section>
  );
}

function Agents() {
  const agents = [...records.agents.values()];
  if (!agents.length) return null;
  return (
    <section class="block home-session-section" data-home-section="agents">
      <div class="home-section-heading"><h2>Agents<span class="home-section-count">{agents.length}</span></h2></div>
      <div class="session-list home-session-list">
        {agents.map((a) => {
          const state = !a.installed ? 'Not installed' : a.signed_in === false ? 'Not signed in' : a.signed_in ? 'Signed in' : 'Installed';
          const command = signIn[a.id];
          return (
            <div class="session-row home-session-row" key={a.id}>
              <span class={`agent-mark ${a.id}`}><Icon name={a.id} /></span>
              <span class="home-row-body">
                <span class="row-title">{agentName(a.id)}</span>
                <span class="row-sub home-row-meta">
                  <span class="home-row-project">{a.version ? `Version ${a.version}` : 'Version unknown'}</span>
                  {a.identity && <span class="home-row-host">{a.identity}</span>}
                </span>
              </span>
              <span class="home-row-end">
                {a.installed && a.signed_in !== true && command ? (
                  <button type="button" class="btn" onClick={() => newTerminal(LOOSE, { title: `Sign in to ${agentName(a.id)}`, type: command })}>
                    <Icon name="terminal" /><span>Sign in…</span>
                  </button>
                ) : (
                  <span class={`row-state ${a.signed_in ? 'complete' : 'offline'}`}><i class="state-dot" aria-hidden="true" /><span>{state}</span></span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function Home() {
  // The motion behind Home, in the person's look and the product's state; the engine draws it only while it is seen.
  const backdrop = (
    <Backdrop look={lookOf(records.prefs)} clear=".work > .toolbar, #main" state={motionState({
      thoughts: records.thoughts.values(), sessions: records.sessions.values(), questions: openQuestions().length, routing: routing(), voice: ui.voice,
    })} />
  );
  const thoughts = [...records.thoughts.values()].filter((t) => t.mode !== 'note');
  const by = (f: (t: Thought) => boolean, order: (a: Thought, b: Thought) => number) => thoughts.filter(f).sort(order);
  const attention = by((t) => t.status === 'needs_you', (a, b) => a.created - b.created);
  const progress = by((t) => t.status === 'routed' || t.status === 'working', (a, b) => b.created - a.created);
  const results = by((t) => t.status === 'done' || t.status === 'failed', (a, b) => b.updated - a.updated).slice(0, 5);
  const date = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  return (
    <>
      {backdrop}
      <main id="main" tabIndex={-1}>
        <div class="resonator-stage">
          <div class="page-heading"><div class="eyebrow">{date}</div><h1>Home</h1></div>
          <button type="button" class="home-art-toggle" title="Appearance" aria-label="Appearance" onClick={() => open({ kind: 'appearance' })}>
            <Icon name="settings" />
          </button>
        </div>
        <div class="overview-content">
          <Section name="Needs your attention" kind="attention" rows={attention} />
          <Section name="In progress" kind="progress" rows={progress} />
          <Section name="Recent results" kind="results" rows={results} />
          {!attention.length && !progress.length && !results.length && <p class="empty">No active sessions.</p>}
          <Agents />
        </div>
      </main>
    </>
  );
}

export { ui };
