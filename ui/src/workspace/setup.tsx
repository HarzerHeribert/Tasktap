// Setup: everything Tasktap offers or needs once, in one place (design/ui-directions/NOTES.md §13). The owner, of the
// first start, 2026-11-19: "First thing is this humongous text field nobody reads", and of offers and tips under the
// Composer: "they pop up under an unbundled thing. It should be under a thing like 'setup' or 'tips'."
//
// On Home it is one quiet fold under the Composer, "Setup · 1 of 3 done": a quiet line a step (finding the projects,
// placing by a model, speech), each with one quiet word on the right edge that drops its sheet, and a done step says
// so. It is there while a step is not done, open unless something needs the person, and the person can fold it or
// hide it; hidden, or all done, it is gone from Home and stays in Settings › About, where "Show on Home" brings it
// back (and its place says so for a moment). At the very first start
// the first step's sheet is part of Home's first picture, decided from what is stored before it is drawn (`firstStart`);
// it never comes down later over a field in use.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { cap } from '../capture.tsx';
import { keyName } from '../keys.ts';
import { talkKey } from '../page.ts';
import { local, model } from '../speech/local.ts';
import { voiced } from '../speech/record.ts';
import { HERE } from '../system.ts';
import { I, Mark } from '../ui.tsx';
import { first, placing } from '../way.ts';
import { Row } from './form.tsx';
import { agentName, call, dismiss, fail, keyTimes, open, page, placers, pref, records, redraw, ui } from './model.ts';
import { Details, ProjectsSheet, projectsStep, seen } from './projects.tsx';
import { type Act, Frame } from './sheets.tsx';
import { serviceName } from './consent.tsx';

type Step = { id: 'projects' | 'placing' | 'speech'; label: string; says: string; done: boolean; act: string; go: () => void };

const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);
const share = (have: number, of: number) => `${Math.floor((100 * have) / Math.max(1, of))} %`;

/** The steps, each with what its line says and the one thing it does. Placing is a step only where an agent that is
 *  signed in could place, or the person already answered; an agreement to terms this Tasktap no longer asks under is
 *  not done, and says so here, in the one place it is said ("Agree again"), and not on every thought. */
function useSteps(): Step[] {
  const p = projectsStep();
  const by = pref('route_by'), answered = records.prefs.has('route_by'), placers_ = placers();
  const l = local.now, speaks = voiced(), service = pref('speech_by');
  const steps: Step[] = [{
    id: 'projects', label: 'Find your projects', says: p.says, done: p.done, act: p.done ? 'See' : 'Search',
    go: () => open({ kind: 'setup', step: 'projects' }),
  }];
  const state = placing(by, placers_), asks = first(by, placers_), more = by ? by.agents.filter((x) => x.on).length - 1 : 0;
  if (placers_.length || answered)
    steps.push({
      id: 'placing', label: 'Let an agent choose the project',
      says: state === 'on' && asks ? `By ${agentName(asks)}${more > 0 ? `, then ${more} more` : ''}` : state === 'again' ? 'The terms changed. Agree again to keep it on.'
        : answered ? 'Skipped' : 'For thoughts that name no project',
      done: answered && state !== 'again', act: state === 'again' ? 'Agree again' : answered ? 'Change' : 'Choose',
      // The entry point placing has today (consent.tsx), as it is.
      go: () => open({ kind: 'placing' }),
    });
  steps.push({
    id: 'speech', label: 'Talk instead of typing',
    says: service ? `By ${serviceName(service.server)}` : l?.model === 'ready' ? `On ${HERE}` : l?.model === 'fetching' ? `Downloading · ${share(l.have, l.of)}` : l?.supported ? `On ${HERE}, ${size(l.of)} to download once` : 'With a speech service',
    done: speaks, act: speaks ? 'See' : l?.model === 'fetching' ? 'See' : 'Set up',
    go: () => open({ kind: 'setup', step: 'speech' }),
  });
  return steps;
}

/** What Setup knows of itself in this page's life: whether the first start was decided; it was finished here (so it
 *  stays, all done, until the page is opened again); the person folded it; when it was hidden from Home. */
const setup = { decided: false, unfinished: false, shut: null as boolean | null, hid: 0 };
/** A click anywhere in the page before Home's first picture with the records: the person is already at work. */
let clicked = false;
addEventListener('pointerdown', () => (clicked = true), true);
/** How long Setup's place says where it went once it is hidden. */
const GONE_FOR = 5000;

/** The first start, decided once, from what is stored, as the records first arrive and before Home is drawn with them:
 *  nothing says the first step was seen (projects.tsx `seen`), Home is shown, nothing else is open, and the person has
 *  neither clicked nor typed (a key anywhere, or words in the Composer). Then the first step's sheet is up, part of
 *  that first picture, its facts filling in as the core says what there is. Otherwise no sheet comes by itself in this
 *  page's life: Setup shows the step. (The owner's trial, the review's R1: a sheet dropped over a field in use took
 *  the letters being typed and answered Allow.) */
export function firstStart() {
  if (setup.decided) return;
  setup.decided = true;
  if (seen() || ui.view !== 'home' || ui.sheet || clicked || keyTimes.last > -Infinity || cap.draft.trim()) return;
  ui.sheet = { kind: 'setup', step: 'projects', auto: true };
}

/** Setup on Home, under the Composer. `quiet`: nothing needs the person, so it is open unless they folded it. */
export function Setup({ quiet }: { quiet: boolean }) {
  const steps = useSteps(), p = projectsStep();
  const done = steps.filter((s) => s.done).length, all = done === steps.length;
  // Unfinished as the page knows it, once what each step stands on has been said (the offer, speech on this Mac).
  if (!all && p.ready && local.now) setup.unfinished = true;
  // Hidden a moment ago: its place says where it went, for a few seconds (the review's R11).
  const gone = pref('setup_hidden') && Date.now() - setup.hid < GONE_FOR;
  useEffect(() => {
    if (!gone) return undefined;
    const timer = setTimeout(redraw, setup.hid + GONE_FOR - Date.now() + 20);
    return () => clearTimeout(timer);
  }, [gone]);
  if (gone) return <p class="setup-gone" role="status">Setup is in Settings › About.</p>;
  if (pref('setup_hidden') || (all && !setup.unfinished)) return null;
  // While a step's sheet is up, Setup under it is its header line only, so nothing is said twice at once.
  const stepUp = ui.sheet?.kind === 'setup' || ui.sheet?.kind === 'placing';
  const isOpen = !stepUp && (setup.shut === null ? quiet : !setup.shut);
  const toggle = () => ((setup.shut = isOpen), redraw());
  // Hidden, the field has the keyboard again.
  const hide = () => {
    setup.hid = Date.now();
    page.focus = '#capture-input';
    void call('put', { c: 'prefs', id: 'setup_hidden', patch: true }).catch(fail);
  };
  return (
    <section class={`setup${isOpen ? ' open' : ''}`} aria-label="Setup">
      <div class="setup-h">
        <button type="button" class="fold-h" data-nav aria-expanded={isOpen} onClick={toggle}
          onKeyDown={(e) => ((e.key === 'ArrowRight' && !isOpen) || (e.key === 'ArrowLeft' && isOpen)) && (e.preventDefault(), toggle())}>
          <I n="chev" /><b>Setup</b><span class="setup-n">{all ? 'All done' : `${done} of ${steps.length} done`}</span>
          {!isOpen && !all && !stepUp && <span class="fold-p">{steps.find((s) => !s.done)?.label}</span>}
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
              <button type="button" class="act" onClick={s.go}><span>{s.act}</span></button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Settings › About: where Setup stays once it is hidden or done. */
export function SetupRow() {
  const steps = useSteps(), done = steps.filter((s) => s.done).length;
  const shown = !pref('setup_hidden') && done < steps.length;
  const show = () => void call('put', { c: 'prefs', id: 'setup_hidden', patch: false }).then(() => ((setup.unfinished = true), (setup.shut = false), (setup.hid = 0), dismiss()), fail);
  return (
    <Row name="Setup" hint="What Tasktap asks once: where your projects are, whether an agent chooses the project, and whether you talk instead of typing.">
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
    service ? `What you say goes to ${serviceName(service.server)} and comes back as text.` : here ? `It is written down on ${HERE}; nothing is sent.` : `${HERE.replace(/^t/, 'T')} can't turn speech into text by itself: choose a speech service.`,
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
