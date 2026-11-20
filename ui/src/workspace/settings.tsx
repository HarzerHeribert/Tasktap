// Settings: one sheet, its sections listed at its left, one section shown at a time, each on its key, ⌘1 to ⌘7. The
// sections are what a person comes here to do, the most frequent and the most consequential first: what happens to a
// thought, which agents run the work, the projects and how a thought finds one, how voice becomes text, how the app
// looks, how a terminal reads, and what the app is and sends. Each row is one decision (form.tsx Row): a label that
// reads by itself and names what the person decides, the answer readable at a glance with its options completing the
// label's sentence, and one sentence under it of what changes for them, in plain words; a problem says what to do.
// Every choice the core keeps is a preference (`prefs`), written at once, so the notch and the workspace both follow;
// nothing is shown that the core cannot keep.
import { getVersion } from '@tauri-apps/api/app';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import type { MotionAmbient, MotionPalette, MotionStyle, Shortcut, TextSize } from '../../../core/proto/protocol.ts';
import type { HostLogin } from '../client.ts';
import { routing } from '../capture.tsx';
import { type Answering, TALK, answerUsual, hit, keyName, recorder } from '../keys.ts';
import { talkKey } from '../page.ts';
import { CALM, HERE, KEPT, KEYS_KEPT, MICROPHONE, mac } from '../system.ts';
import { setVoice } from '../motion/engine.ts';
import { Motion, lookOf } from '../motion/motion.tsx';
import { stops } from '../motion/palette.ts';
import { ready as hearsHere } from '../speech/local.ts';
import { motionState } from '../motion/state.ts';
import { Voice } from '../motion/voice.ts';
import { I, Key } from '../ui.tsx';
import { placing } from '../way.ts';
import { AgentsPane } from './agents.tsx';
import { ProjectsPane } from './projects.tsx';
import { ASKS, UpdateRow, checks, update } from './update.tsx';
import { SetupRow } from './setup.tsx';
import { FINDING, Finding, Speech, serviceName } from './consent.tsx';
import { Choice, Recorder, Row, Switch, setPref } from './form.tsx';
import { agent, agentName, call, fail, loadTerms, openQuestions, page, placers, pref, records, redraw, sentence, ui } from './model.ts';

export const SECTIONS = [['thoughts', 'Thoughts'], ['agents', 'Agents'], ['projects', 'Projects'], ['voice', 'Voice'], ['appearance', 'Appearance'], ['terminal', 'Terminal'], ['about', 'About']] as const;
export type Section = (typeof SECTIONS)[number][0];
/** The section last shown: Settings opens there again unless a link asks for another. */
export const shown = { at: 'thoughts' as Section };
/** Shows a section. The keyboard goes to its place in the list: what had it may be a control of the section left. */
function go(at: Section) {
  ui.sheet = { kind: 'settings', at };
  // Once it has rendered, not in the next frame: a window that is not drawn (a locked screen, a runner) has none.
  page.focus = `#set-tab-${at}`;
  redraw();
}

const styles: [MotionStyle, string][] = [['slats', 'Slats'], ['glyphs', 'Glyphs'], ['resonator', 'Resonator']];
const palettes: [MotionPalette, string][] = [['chrome', 'Chrome'], ['chromatic', 'Chromatic'], ['warm', 'Warm'], ['cool', 'Cool'], ['custom', 'Custom']];
const effects: [MotionAmbient, string][] = [['off', 'Off'], ['still', 'Still'], ['breathing', 'Full']];
const holds: [number, string][] = [[0, 'No wait'], [3, '3 seconds'], [5, '5 seconds'], [10, '10 seconds']];
// Sizes whose cells differ by a whole pixel in the Default face.
const sizes: [number, string][] = [12, 14, 15, 16, 18].map((n) => [n, String(n)]);
const heights: [number, string][] = [[100, '1.0'], [110, '1.1'], [120, '1.2'], [130, '1.3']];
const FONTS = ['Hack Nerd Font Mono', 'JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo'];
const returns: [boolean, string][] = [[true, 'Sends the thought'], [false, 'Starts a new line']];
const keeps: [number, string][] = [[0, 'Never'], [30, '30 days'], [90, '90 days'], [365, 'A year']];
const texts: [TextSize, string][] = [['small', 'Small'], ['default', 'Default'], ['large', 'Large']];
/** The days finished thoughts are kept, as a person says them. */
const daysName = (days: number) => keeps.find(([n]) => n === days)?.[1].toLowerCase() ?? `${days} days`;

/** The capture key while the person has chosen none, as the core has it (records.rs `Shortcut::capture`): Control-
 *  Option-Space on a Mac, Alt-Shift-Space elsewhere. */
const USUAL: Shortcut = { control: mac, alt: true, shift: !mac, meta: false, code: 'Space' };
/** Who else may hold a key: another app, or the system, in its own name. */
const SYSTEM = mac ? 'macOS' : 'Windows';
/** The key that takes a thought on its way back, and the key that ends a line. */
const UNDO = mac ? '⌘Z' : 'Ctrl+Z';
const RETURN = mac ? 'Return' : 'Enter';

/** The capture key as the host has it: the one the system registered, which is not the stored one when the system
 *  refused that at start. Asked for when the section is shown, and told by every change made here. */
let capture: Shortcut | null | undefined;
/** Whether this copy takes keys from other apps at all, as the host says: a review build takes none. */
let takes = true;
const askCapture = () => call('host.capture_key', {}).then((r) => ((capture = r.key), (takes = r.takes !== false), redraw()), () => {});
const setCapture = (key: Shortcut | null) => call('host.capture_key', { key }).then((r) => ((capture = r.key), redraw()));
/** What a row of a global key says in a copy that takes none, in place of its recorder. */
const NO_KEYS = 'This copy is Tasktap Review, which takes no keys from other apps, so they stay your own Tasktap’s.';
/** Whether Tasktap opens when the computer starts, as the host reads it from the system each time (login.rs): the
 *  system's own login item on a Mac, the person's Run entry on Windows; never a guess kept here. Null: a host without
 *  the call. */
let login: HostLogin | null | undefined;
const askLogin = () => call('host.login', {}).then((r) => ((login = r ?? null), redraw()), () => {});
const LOGIN = 'Open Tasktap when the computer starts';
/** Why a copy cannot be opened at login, in the person's words. */
const NOT_HERE: Record<Extract<HostLogin, { state: 'unavailable' }>['why'], string> = {
  review: 'This copy is Tasktap Review, which never opens by itself; your own Tasktap can.',
  check: 'This copy runs for a check, so it never opens by itself.',
  unsigned: 'Only a signed Tasktap app can open when you log in, and this copy is not one; the Tasktap you install can.',
  uninstalled: 'Only the Tasktap its installer put in place can open when you sign in, and this copy is not that one.',
};
/** The row: a switch, read back from the system after every change; on a Mac, macOS may first ask the person to allow
 *  it in Login Items, which the row opens. What the system refuses is said under it. */
function LoginRow() {
  const [said, say] = useState('');
  if (!login) return null;
  const set = (on: boolean) => void call('host.login', { on }).then((r) => ((login = r), say(''), redraw()), (e: unknown) => say(sentence(e instanceof Error ? e.message : String(e))));
  const err = said && <p class="hint err" role="alert">{said}</p>;
  if (login.state === 'unavailable') return <Row name={LOGIN} hint={NOT_HERE[login.why]}><span class="v">Not for this copy</span>{err}</Row>;
  const toggle = <Switch on={login.state !== 'off'} name={LOGIN} set={set} />;
  if (login.state === 'approve') {
    return (
      <Row name={LOGIN} hint="macOS opens Tasktap when you log in once you allow it under Login Items in System Settings.">
        {toggle}<span class="v">Waiting for you to allow it</span>
        <button type="button" class="btn" onClick={() => void call('host.login', { open: true }).then((r) => ((login = r), redraw()), fail)}>Open Login Items</button>{err}
      </Row>
    );
  }
  const only = mac ? 'only the notch' : tab?.display === 'off' ? 'only its icon' : 'only its tab and icon';
  const hint = mac ? `When you log in, Tasktap opens without a window, ${only}, so its keys work at once; System Settings lists it under Login Items.`
    : `When you sign in, Tasktap opens without a window, ${only}, so its keys work at once; Windows lists it under Startup apps.`;
  return <Row name={LOGIN} hint={hint}>{toggle}{err}</Row>;
}

/** The keys that answer a waiting question from any app, as the host has them (keys.rs): the person's, or this
 *  system's own, registered only while a question waits. Asked for when the section is shown, and told by every change
 *  made here. */
let answers: Record<Answering, Shortcut | null> | undefined;
const askAnswers = () => call('host.answer_key', {}).then((r) => ((answers = r), redraw()), () => {});
const setAnswer = (which: Answering) => (key: Shortcut | null) => call('host.answer_key', { which, key }).then((r) => ((answers = r), redraw()));
const ANSWER_ROWS: [Answering, string, string][] = [
  ['question', 'Key to go to an agent’s question, from any app', 'While an agent waits for you, it shows the question from any app, with the keyboard on its answers; Tasktap takes the key only then.'],
  ['yes', 'Key to answer Yes, from any app', 'While an agent asks yes or no, it answers Yes from any app; Tasktap takes the key only while a question waits.'],
  ['no', 'Key to answer No, from any app', 'While an agent asks something, it answers No from any app; Tasktap takes the key only while a question waits.'],
];
/** Windows: where the tab at the top of the screen hangs, as the host has it, and the displays there are. Kept by
 *  the host: a display belongs to this machine. Undefined on a Mac, whose notch is where its camera is. */
let tab: { display: string; displays: { name: string; primary: boolean; width: number; height: number }[] } | undefined;
const askTab = () => call('host.tab', {}).then((r) => ((tab = r), redraw()), () => {});
const setTab = (display: string) => call('host.tab', { display }).then((r) => ((tab = r), redraw()), fail);
/** A display as Windows numbers it: its own name there is `\\.\DISPLAY2`. */
const displayName = (name: string) => name.replace(/^\\\\\.\\DISPLAY(\d+)$/, 'Display $1');
const same = (a: Shortcut | null, b: Shortcut | null) => JSON.stringify(a && [a.control, a.alt, a.shift, a.meta, a.code]) === JSON.stringify(b && [b.control, b.alt, b.shift, b.meta, b.code]);

// The microphone, only between the person's two clicks and only while Appearance is shown. Nothing is recorded.
let trial: Voice | null = null;
let asking = false;
let said = '';
function stopTrial() {
  trial?.close();
  trial = null;
  setVoice(null);
  ui.voice = false;
  redraw();
}
async function toggleTrial() {
  if (trial) return stopTrial();
  if (asking) return;
  asking = true;
  said = '';
  redraw();
  try {
    const v = await Voice.microphone();
    if (ui.sheet?.kind !== 'settings' || ui.sheet.at !== 'appearance') v.close();
    else {
      trial = v;
      v.onend = stopTrial;
      setVoice(v);
      ui.voice = true;
    }
  } catch (e) {
    said = e instanceof DOMException && e.name === 'NotAllowedError'
      ? `The microphone was not allowed. Tasktap can be allowed in ${MICROPHONE}.`
      : e instanceof Error ? e.message : String(e);
  }
  asking = false;
  redraw();
}

/** How a thought gets in and what happens to it once it is sent: the key from any app first, whether Tasktap opens when
 *  the computer starts (the key does nothing until it runs), the keys that answer a question from any app, then where
 *  the tab hangs (Windows), what Return does, how long a sent thought waits, and when finished ones are deleted. */
function ThoughtsPane() {
  const hold = records.prefs.get('hold');
  const sends = pref('return_sends'), days = pref('keep_days'), stored = pref('capture_key');
  // (One effect, as before the tab: the sections are called inside Settings, so their hooks are its own, in order.)
  useEffect(() => void (askCapture(), askLogin(), askAnswers(), mac || askTab()), []);
  const places: [string, string][] = !tab ? [] : [['main', 'Main display'], ['pointer', 'Where you last opened it'],
    ...(tab.displays.length > 1 || !['main', 'pointer', 'off'].includes(tab.display)
      ? [...new Set([...tab.displays.map((d) => d.name), ...(['main', 'pointer', 'off'].includes(tab.display) ? [] : [tab.display])])].map((name): [string, string] => [name, displayName(name)])
      : []),
    ['off', 'None']];
  // The stored key is not the one in use: the system refused it when the app started.
  const lost = capture !== undefined && stored && !same(stored, capture);
  const KEY = 'Key to put a thought in, from any app', TAB = 'Display that shows Tasktap’s tab', ENDS = `${RETURN} key when writing a thought`;
  const WAIT = 'Wait before an agent starts a thought', DELETE = 'Delete finished thoughts after';
  const held = hold?.id === 'hold' ? hold.value : 5;
  return (
    <>
      {!takes ? <Row name={KEY} hint={NO_KEYS}><span class="v">None for this copy</span></Row> : <Row name={KEY} hint={lost ? `${keyName(stored!)} is taken by another app or ${SYSTEM}, so ${capture ? `${keyName(capture)} still opens Tasktap; record a different one.` : `no key opens Tasktap; record a different one, or use ${keyName(USUAL)}.`}`
        : capture === null ? `${keyName(USUAL)} is taken by another app or ${SYSTEM}, so no key opens Tasktap; record a different one.`
          : mac ? 'Press it in any app and the notch opens with a field for your thought.'
            : tab?.display === 'off' ? 'Press it in any app and Tasktap’s window comes forward with a field for your thought.' : 'Press it in any app and the tab at the top of the screen opens for your thought.'}>
        {capture !== undefined && <Recorder name={KEY} value={capture} own={!!stored} usual={USUAL} set={setCapture} />}
      </Row>}
      <LoginRow />
      {answers && ANSWER_ROWS.map(([which, name, hint]) => (
        takes ? (
          <Row key={which} name={name} hint={hint}>
            <Recorder name={name} value={answers![which]} own={!!pref(`${which}_key`)} usual={answerUsual(which)} set={setAnswer(which)} />
          </Row>
        ) : <Row key={which} name={name} hint={NO_KEYS}><span class="v">None for this copy</span></Row>
      ))}
      {tab && (
        <Row name={TAB} hint={tab.display === 'off' ? 'No tab: the key brings Tasktap’s window forward, and its icon stays in the notification area.'
          : tab.display === 'main' ? 'The tab hangs at the top of the main display, and the key opens it on the display the pointer is on.'
            : tab.display === 'pointer' ? 'The tab stays on the display where the key last opened it.'
              : `The tab hangs on ${displayName(tab.display)}, and on the main display while that one is not connected.`}>
          <Choice name={TAB} value={tab.display} all={places} set={setTab} />
        </Row>
      )}
      <Row name={ENDS} hint={`${sends ? `Shift${mac ? '-' : '+'}${RETURN} starts a new line instead` : `${mac ? 'Command-Return' : 'Ctrl+Enter'} sends it`}; in a reply to an agent, ${RETURN} always sends.`}>
        <Choice name={ENDS} value={sends} all={returns} set={(v) => setPref({ id: 'return_sends', patch: v })} />
      </Row>
      <Row name={WAIT} hint={held ? `It waits at least this long, longer while its project is still being found, and ${UNDO} takes it back until it starts.`
        : 'The agent starts as soon as the project is found, so there is no moment to take it back.'}>
        <Choice name={WAIT} value={held} all={holds} set={(v) => setPref({ id: 'hold', patch: v })} />
      </Row>
      <Row name={DELETE} hint={days ? 'Thoughts you have read go that long after they finish, with their answers and terminal history; anything waiting for you stays.'
        : 'Every finished thought stays, with its answers and the history of the terminal its agent ran in.'}>
        <Choice name={DELETE} value={days} all={keeps.some(([n]) => n === days) ? keeps : [...keeps, [days, `${days} days`]]} set={(v) => setPref({ id: 'keep_days', patch: v })} />
      </Row>
    </>
  );
}

/** How voice becomes text (consent.tsx), and the key held to talk: stored as the preference it is, which the core
 *  holds to the rule of a shortcut. It is the page's own key, heard only while Tasktap has the keyboard. */
function VoicePane() {
  // Through the host, as every key a person records: one another app holds would never reach Tasktap (keys.rs).
  const setTalk = (key: Shortcut | null) => call('host.talk_key', { key });
  const TALKS = 'Key to hold while you talk', set = !!pref('speech_by') || hearsHere();
  return (
    <>
      <Speech />
      <Row name={TALKS} hint={set ? 'In Tasktap only: in an empty field, letting go sends the thought (E first keeps it to edit); in any other field, your words are typed.'
        : 'Voice is not set up yet: choose above where your speech becomes text.'}>
        <Recorder name={TALKS} value={talkKey()} own={!!pref('talk_key')} usual={TALK} set={setTalk} />
      </Row>
    </>
  );
}

/** The chrome and its light, with the form itself to look at, and how much of it moves. The owner froze these
 *  controls: their look, their words and what they do are as they were; only their place is new. */
function AppearancePane() {
  const look = lookOf(records.prefs);
  const state = motionState({
    thoughts: records.thoughts.values(), sessions: records.sessions.values(), questions: openQuestions().length, routing: routing(), voice: ui.voice,
  });
  // Leaving the section, or the sheet, ends the trial there and then (not after the next frame, which a window not
  // drawn may be long without).
  useLayoutEffect(() => () => void (trial && stopTrial()), []);
  return (
    <>
      <Row name="Text size" hint="Of everything but a terminal, which has its own.">
        <Choice name="Text size" value={pref('text_size')} all={texts} set={(v) => setPref({ id: 'text_size', patch: v })} />
      </Row>
      {/* As Home shows it: drawn at full size, never as a small thumbnail, where the metal stops reading as metal. */}
      <Motion class="preview" look={look} state={state} pace="calm" />
      <Row name="Form"><Choice name="Form" value={look.style} all={styles} set={(v) => setPref({ id: 'motion_style', patch: v })} /></Row>
      <Row name="Colour">
        <div class="seg" role="radiogroup" aria-label="Colour">
          {palettes.map(([id, name]) => (
            <button type="button" role="radio" aria-checked={look.palette === id} onClick={() => setPref({ id: 'motion_palette', patch: id })}>
              <i class="sw" style={{ background: `linear-gradient(90deg,${stops(id, look.hue)})` }} />{name}
            </button>
          ))}
        </div>
        {look.palette === 'custom' && (
          <input class="hue" type="range" min={0} max={359} aria-label="Hue" defaultValue={String(look.hue)} style={{ '--hue': look.hue }}
            onInput={(e) => setPref({ id: 'motion_hue', patch: Number(e.currentTarget.value) })} />
        )}
      </Row>
      <Row name="Lumen" hint={`Coloured light behind the form and a beam across it.${mac ? ' The light behind the notch takes the same colours.' : ''}`}>
        <Switch on={look.lumen} name="Lumen" set={(on) => setPref({ id: 'motion_lumen', patch: on })} />
      </Row>
      <Row name="Effects" hint={`The light, the chrome and everything that moves by itself. Still keeps the picture and stops the motion; Off draws none of it, which takes the least power and memory. ${CALM}, Full behaves as Still.`}>
        <Choice name="Effects" value={pref('motion_ambient')} all={effects} set={(v) => setPref({ id: 'motion_ambient', patch: v })} />
      </Row>
      <Row name="Microphone" hint="The form listens while this is on and this sheet is open. Nothing is recorded or sent anywhere.">
        <button type="button" class="btn" aria-pressed={!!trial} disabled={asking} onClick={() => void toggleTrial()}>
          {trial ? 'Stop listening' : asking ? 'Asking…' : 'Try with the microphone'}
        </button>
        {said && <p class="hint" role="status">{said}</p>}
      </Row>
    </>
  );
}

/** How a terminal reads: applied at once, to every terminal in every window (main.tsx loadLook). */
function TerminalPane() {
  const FONT = 'Font in terminals', SIZE = 'Text size in terminals', LINES = 'Space between lines in terminals';
  const BOLD = 'Show bold text in brighter colours', READABLE = 'Adjust text that is hard to read';
  return (
    <>
      <Row name={FONT} hint={`Any fixed-width font installed on ${HERE}; the symbols in prompts show with whichever you choose.`}>
        <input class="text" list="fonts" placeholder="Hack (built in)" aria-label={FONT} spellcheck={false} maxLength={100} defaultValue={pref('terminal_font')}
          onChange={(e) => setPref({ id: 'terminal_font', patch: e.currentTarget.value.trim() })} />
        <datalist id="fonts">{FONTS.map((f) => <option value={f} />)}</datalist>
      </Row>
      <Row name={SIZE} hint="Every terminal changes at once, the agents’ and your own; the rest of Tasktap has its size under Appearance.">
        <Choice name={SIZE} value={pref('terminal_size')} all={sizes} set={(v) => setPref({ id: 'terminal_size', patch: v })} />
      </Row>
      <Row name={LINES} hint="More space makes long output easier to read, and fewer lines fit.">
        <Choice name={LINES} value={pref('terminal_line_height')} all={heights} set={(v) => setPref({ id: 'terminal_line_height', patch: v })} />
      </Row>
      <Row name={BOLD} hint="As most terminals draw it; off, bold text keeps the colour its program gave it.">
        <Switch on={pref('terminal_bold_bright')} name={BOLD} set={(on) => setPref({ id: 'terminal_bold_bright', patch: on })} />
      </Row>
      <Row name={READABLE} hint="A colour too close to what is behind it is changed until it reads; off, every colour is as its program asked.">
        <Switch on={pref('terminal_contrast')} name={READABLE} set={(on) => setPref({ id: 'terminal_contrast', patch: on })} />
      </Row>
    </>
  );
}

/** A licence shipped with the app (ui/public/licenses), its words behind one quiet line. */
function Licence({ name, what, file }: { name: string; what: string; file: string }) {
  const [text, setText] = useState<string | null>(null);
  const [reads, setReads] = useState(false);
  const read = () => {
    setReads(!reads);
    if (text === null) void fetch(`licenses/${file}`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText)))).then(setText, () => setText('This licence could not be read.'));
  };
  return (
    <Row name={name}>
      <span class="v">{what}</span>
      <button type="button" class="disc" aria-expanded={reads} onClick={read}><I n="chev" /><span>The licence</span></button>
      {reads && text !== null && <pre class="instr" tabIndex={0}>{text}</pre>}
    </Row>
  );
}
const To = ({ at, children }: { at: Section; children: ComponentChildren }) => <button type="button" class="btn" onClick={() => go(at)}>{children}<I n="chev" /></button>;

/** What the app is, and an honest account of what leaves this Mac, each line leading to the section that decides it. */
let version = '';
function AboutPane() {
  useEffect(() => void (version || getVersion().then((v) => ((version = v ?? ''), redraw()), () => {})), []);
  const tools = placers(), by = pref('route_by'), speech = pref('speech_by'), usual = agent(), days = pref('keep_days'), keys = pref('keys').length > 0;
  // The agents that find a thought's project now, in the person's order.
  const readers = placing(by, tools) !== 'on' ? [] : by!.agents.filter((p) => p.on && tools.some((t) => t.agent === p.agent && t.model === p.model));
  const names = readers.map((p) => agentName(p.agent));
  // A build made here never asks for a new version, nor one whose switch the person turned off; until the host has
  // said, this one may.
  const asks = update.now.state !== 'off' && checks();
  const kept = `${KEYS_KEPT[0]!.toLowerCase()}${KEYS_KEPT.slice(1)}`;
  return (
    <>
      <Row name="Tasktap version"><span class="v">{version || 'This copy has none'}</span></Row>
      <UpdateRow />
      <SetupRow />
      <h3>What leaves {HERE}</h3>
      <Row name="Your thoughts" hint={`Each goes to the agent that runs it${usual ? ` (${agentName(usual.id)} unless you choose another)` : ''}, in a terminal on ${HERE} under that agent’s own sign-in.`}>
        <span class="v">To the agent that runs them</span><To at="agents">Agents</To>
      </Row>
      <Row name={FINDING} hint={names.length
        ? `${names[0]}’s model reads each thought naming no single project, and each long one for its summary, with likely projects’ names${names.length > 1 ? `; if it cannot, ${names.slice(1).join(', then ')}` : ''}.`
        : `Your words are matched to your projects’ names on ${HERE}, and nothing is sent.`}>
        <span class="v">{names.length ? `To ${names.join(', ')}` : 'Nothing'}</span><To at="projects">Projects</To>
      </Row>
      <Row name="Your voice" hint={speech ? 'Each recording goes when you let go, and Tasktap keeps none.' : hearsHere() ? `What you say becomes text on ${HERE}; only its model came once, from huggingface.co.` : 'Voice is not set up, so nothing is recorded.'}>
        <span class="v">{speech ? `To ${serviceName(speech.server)}` : 'Nothing'}</span><To at="voice">Voice</To>
      </Row>
      <Row name="Anything else" hint={asks ? `Tasktap asks GitHub for a new version ${ASKS}; it has no account and reports nothing else.` : 'Tasktap has no account and reports nothing about what you do.'}>
        <span class="v">{asks ? 'A check for new versions' : 'Nothing'}</span>
      </Row>
      <h3>Kept on {HERE}</h3>
      <Row name="Your thoughts and history" hint={`Kept ${KEPT}; ${days ? `a finished thought goes ${daysName(days)} after it ends` : 'finished ones stay until you choose a time under Thoughts'}.`}>
        <span class="v">In Tasktap’s folder</span><To at="thoughts">Thoughts</To>
      </Row>
      <Row name="Speech service key" hint={keys ? 'Tasktap reads it only to send a recording, and never shows it again.' : `A key you give a speech service is kept ${kept} and never shown again.`}>
        <span class="v">{keys ? KEYS_KEPT : 'None saved'}</span>
      </Row>
      <h3>Licences</h3>
      <Licence name="Hack" what="The terminal's font · MIT and Bitstream Vera" file="Hack-3.003-LICENSE.md" />
      <Licence name="Nerd Fonts symbols" what="Symbols in terminal prompts · MIT" file="NerdFonts-3.4.0-LICENSE.txt" />
      <Licence name="Whisper" what={`The model for speech on ${HERE} · MIT`} file="Whisper-model-LICENSE.txt" />
      <Licence name="whisper.cpp" what="What runs that model · MIT" file="whisper.cpp-1.9.5-LICENSE.txt" />
      <Row name="Libraries" hint="Open source, under the MIT and Apache 2.0 licences; SQLite is in the public domain."><span class="v">xterm.js, Preact, Tauri, Tokio, SQLite</span></Row>
    </>
  );
}

const PANES: Record<Section, () => ComponentChildren> = {
  thoughts: () => <ThoughtsPane />, agents: () => <AgentsPane />, projects: () => <><Finding /><ProjectsPane /></>, voice: () => <VoicePane />,
  appearance: () => <AppearancePane />, terminal: () => <TerminalPane />, about: () => <AboutPane />,
};

export function Settings({ at }: { at: Section }) {
  shown.at = at;
  useEffect(() => void loadTerms(), []);
  // A section by its key, ⌘1 to ⌘7 in the order of the list, from anywhere in the sheet, and only while it is up: the
  // keys go with it the moment it goes (a key pressed right after ⌘W would bring it back).
  useLayoutEffect(() => {
    const keys = (e: KeyboardEvent) => {
      // While a key is recorded every combination is the recorder's.
      const to = !recorder.on ? SECTIONS.find((_, i) => hit(`⌘${i + 1}`, e)) : undefined;
      if (to) (e.preventDefault(), go(to[0]));
    };
    document.addEventListener('keydown', keys, true);
    return () => document.removeEventListener('keydown', keys, true);
  }, []);
  // In the list the arrows move, as in any list of sections; the section follows the keyboard.
  const arrows = (e: KeyboardEvent) => {
    const i = SECTIONS.findIndex(([id]) => id === at);
    const to = e.key === 'ArrowDown' ? SECTIONS[i + 1] : e.key === 'ArrowUp' ? SECTIONS[i - 1] : e.key === 'Home' ? SECTIONS[0] : e.key === 'End' ? SECTIONS[SECTIONS.length - 1] : undefined;
    if (!to) return;
    e.preventDefault();
    go(to[0]);
  };
  return (
    // A press of any button here takes the keyboard to it, as `taking` does (form.tsx): WebKit gives none to a button
    // it clicked, so the keys after a click would start from the sheet.
    <div class="settings" onClickCapture={(e) => (e.detail > 0 && (e.target as HTMLElement).closest?.('button')?.focus())}>
      <div class="set-nav" role="tablist" aria-label="Settings" aria-orientation="vertical" onKeyDown={arrows}>
        {SECTIONS.map(([id, name], i) => (
          <button type="button" role="tab" id={`set-tab-${id}`} aria-selected={id === at} aria-controls="set-pane" tabIndex={id === at ? 0 : -1} onClick={() => go(id)}>
            <span>{name}</span><Key k={`⌘${i + 1}`} />
          </button>
        ))}
      </div>
      <div class="set-pane" id="set-pane" role="tabpanel" aria-labelledby={`set-tab-${at}`} key={at}>{PANES[at]()}</div>
    </div>
  );
}
