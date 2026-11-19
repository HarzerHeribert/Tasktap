// Setup: everything Tasktap offers or needs once, in one place (design/ui-directions/NOTES.md §13). The owner, of the
// first start, 2026-11-19: "First thing is this humongous text field nobody reads", and of offers and tips under the
// Composer: "they pop up under an unbundled thing. It should be under a thing like 'setup' or 'tips'."
//
// On Home it is one quiet fold under the Composer, "Setup · 1 of 3": a line a step (finding the projects, placing by a
// model, speech), each with one quiet action that drops its sheet, and a done step says so. It is there while a step
// is not done, open unless something needs the person, and the person can fold it or hide it; hidden, or all done,
// it is gone from Home and stays in Settings › About, where "Show on Home" brings it back. On the very first start
// the first step comes down by itself, once, unless the person is already typing.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { cap } from '../capture.tsx';
import { keyName } from '../keys.ts';
import { talkKey } from '../page.ts';
import { local, model } from '../speech/local.ts';
import { voiced } from '../speech/record.ts';
import { HERE } from '../system.ts';
import { I, Mark } from '../ui.tsx';
import { placing } from '../way.ts';
import { Row } from './form.tsx';
import { agentName, call, dismiss, fail, open, placers, pref, records, redraw, ui } from './model.ts';
import { Details, ProjectsSheet, projectsStep } from './projects.tsx';
import { type Act, Frame } from './sheets.tsx';
import { serviceName } from './consent.tsx';

type Step = { id: 'projects' | 'placing' | 'speech'; label: string; says: string; done: boolean; act: string; go: () => void };

const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);
const share = (have: number, of: number) => `${Math.floor((100 * have) / Math.max(1, of))} %`;

/** The steps, each with what its line says and the one thing it does. Placing is a step only where an agent that is
 *  signed in could place, or the person already answered. */
function useSteps(): Step[] {
  const p = projectsStep();
  const by = pref('route_by'), answered = records.prefs.has('route_by'), placers_ = placers();
  const l = local.now, speaks = voiced(), service = pref('speech_by');
  const steps: Step[] = [{
    id: 'projects', label: 'Find your projects', says: p.says, done: p.done, act: p.done ? 'See…' : 'Look…',
    go: () => open({ kind: 'setup', step: 'projects' }),
  }];
  if (placers_.length || answered)
    steps.push({
      id: 'placing', label: 'Let a model place thoughts',
      says: placing(by, placers_) === 'on' ? `By ${agentName(by!.agent)} · ${by!.model}` : answered ? 'By name only' : 'For thoughts that name no project',
      done: answered, act: answered ? 'Change…' : 'Choose…',
      // The entry point placing has today (consent.tsx), as it is.
      go: () => open({ kind: 'placing' }),
    });
  steps.push({
    id: 'speech', label: 'Talk instead of typing',
    says: service ? `By ${serviceName(service.server)}` : l?.model === 'ready' ? `On ${HERE}` : l?.model === 'fetching' ? `Downloading · ${share(l.have, l.of)}` : l?.supported ? `On ${HERE}, ${size(l.of)} to download once` : 'With a speech service',
    done: speaks, act: speaks ? 'See…' : l?.model === 'fetching' ? 'See…' : 'Set up…',
    go: () => open({ kind: 'setup', step: 'speech' }),
  });
  return steps;
}

/** What Setup knows of itself in this page's life: it opened its first step by itself once; it was finished here (so it
 *  stays, all done, until the page is opened again); the person folded it. */
const setup = { opened: false, unfinished: false, shut: false as boolean | null };
/** When a key was last pressed in the page: a sheet never comes down by itself while the person types. */
let typed = -Infinity;
addEventListener('keydown', () => (typed = performance.now()), true);

/** Setup on Home, under the Composer. `quiet`: nothing needs the person, so it is open unless they folded it. */
export function Setup({ quiet }: { quiet: boolean }) {
  const steps = useSteps(), p = projectsStep();
  const done = steps.filter((s) => s.done).length, all = done === steps.length;
  // Unfinished as the page knows it, once what each step stands on has been said (the offer, speech on this Mac).
  if (!all && p.ready && local.now) setup.unfinished = true;
  // The first start: the first step comes down by itself, once, and only into a still page: no sheet up, nothing in the
  // Composer, no key pressed in the last second.
  useEffect(() => {
    if (!p.due || setup.opened || ui.sheet || cap.draft.trim() || performance.now() - typed < 1000) return;
    setup.opened = true;
    open({ kind: 'setup', step: 'projects', auto: true });
  });
  if (pref('setup_hidden') || (all && !setup.unfinished)) return null;
  const isOpen = setup.shut === null ? quiet : !setup.shut;
  const toggle = () => ((setup.shut = isOpen), redraw());
  const hide = () => void call('put', { c: 'prefs', id: 'setup_hidden', patch: true }).catch(fail);
  return (
    <section class={`setup${isOpen ? ' open' : ''}`} aria-label="Setup">
      <div class="setup-h">
        <button type="button" class="fold-h" data-nav aria-expanded={isOpen} onClick={toggle}
          onKeyDown={(e) => ((e.key === 'ArrowRight' && !isOpen) || (e.key === 'ArrowLeft' && isOpen)) && (e.preventDefault(), toggle())}>
          <I n="chev" /><b>Setup</b><span class="fold-c"><i>{all ? 'All done' : `${done} of ${steps.length}`}</i></span>
          {!isOpen && !all && <span class="fold-p">{steps.find((s) => !s.done)?.label}</span>}
        </button>
        <button type="button" class="act" title="Setup stays in Settings › About" onClick={hide}><span>Hide</span></button>
      </div>
      {isOpen && (
        <div class="setup-b">
          {steps.map((s) => (
            <div class="line st" data-step={s.id} data-done={s.done || undefined}>
              {s.done ? <I n="check" /> : <i class="todo" />}
              <span class="t">{s.label}</span>
              <span class="x">{s.says}</span>
              <span class="acts"><button type="button" class="btn" onClick={s.go}>{s.act}</button></span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
setup.shut = null;

/** Settings › About: where Setup stays once it is hidden or done. */
export function SetupRow() {
  const steps = useSteps(), done = steps.filter((s) => s.done).length;
  const shown = !pref('setup_hidden') && done < steps.length;
  const show = () => void call('put', { c: 'prefs', id: 'setup_hidden', patch: false }).then(() => ((setup.unfinished = true), (setup.shut = false), dismiss()), fail);
  return (
    <Row name="Setup" hint={`${steps.map((s) => s.label).join(', ')}.`}>
      <span class="v">{done === steps.length ? 'All done' : `${done} of ${steps.length} done`}{shown ? ', on Home' : ''}</span>
      {!shown && <button type="button" class="btn" onClick={show}>Show on Home</button>}
    </Row>
  );
}

/** The sheets of Setup's own steps (placing has its own, consent.tsx). */
export function SetupSheet({ step, auto }: { step: 'projects' | 'speech'; auto?: boolean }) {
  return step === 'projects' ? <ProjectsSheet auto={auto} /> : <SpeechSetup />;
}

/** Speech, as Setup's step: what it does, in three facts, what is heard behind one line, and the download on this
 *  Mac as its key; a speech service is the other way, its own sheet. */
function SpeechSetup() {
  const l = local.now, service = pref('speech_by');
  const [err, say] = useState('');
  useEffect(() => void model().catch(() => {}), []);
  const act = (what: 'install' | 'stop') => (say(''), void model(what).catch((e: unknown) => say(e instanceof Error ? e.message : String(e))));
  const other: Act = { k: 'S', label: service ? 'The speech service…' : 'Use a speech service…', do: () => open({ kind: 'speech' }) };
  const hold = `Hold ${keyName(talkKey())}, or the microphone, and say the thought.`;
  const here = !!l?.supported;
  const facts: ComponentChildren[] = [
    hold,
    service ? `What you say goes to ${serviceName(service.server)} and comes back as text.` : here ? `It is written down on ${HERE}; nothing is sent.` : `On ${HERE} it needs a speech service.`,
    here && !service && l?.model !== 'ready' ? `Needs ${size(l!.of)}, downloaded once.` : 'Tasktap keeps no recording.',
  ];
  const acts: Act[] = !here || service ? [other, { k: '↩', label: 'Done', kind: 'primary', do: dismiss }]
    : l?.model === 'ready' ? [other, { k: '↩', label: 'Done', kind: 'primary', do: dismiss }]
      : l?.model === 'fetching' ? [other, { k: 'esc', label: 'Close', do: dismiss }, { k: '↩', label: 'Done', kind: 'primary', do: dismiss }]
        : [other, { k: 'esc', label: 'Not now', do: dismiss }, { k: '↩', label: l?.model === 'failed' ? 'Try again' : l && l.have > 0 ? 'Continue' : 'Download', kind: 'primary', do: () => act('install') }];
  return (
    <Frame size="md" title="Talk instead of typing" acts={acts}>
      <ul class="facts">{facts.map((f) => <li>{f}</li>)}</ul>
      {l?.model === 'fetching' && (
        <p class="got-l" role="status"><Mark s="working" label="" /><span>Downloading · {share(l.have, l.of)} of {size(l.of)}</span><button type="button" class="btn" onClick={() => act('stop')}>Stop</button><progress class="got" max={l.of} value={l.have} aria-label="Download" /></p>
      )}
      {l?.model === 'ready' && !service && <p class="got-l" role="status"><I n="check" /><span>Ready on {HERE}</span></p>}
      {l?.model === 'failed' && <p class="warn" role="alert">{l.error}</p>}
      {err && <p class="warn" role="alert">{err}</p>}
      <Details label="What exactly is heard" text={here && !service
        ? `The model (Whisper large-v3 turbo, ${size(l!.of)}) is downloaded once from huggingface.co and kept in Tasktap's data folder. While you hold to talk, the microphone is recorded and turned into text on ${HERE}; the recording is sent nowhere and kept nowhere.`
        : 'While you hold to talk, the microphone is recorded. When you let go, the recording goes to the speech service you choose and comes back as text. Nothing is recorded at any other time, and Tasktap keeps no recording.'} />
    </Frame>
  );
}
