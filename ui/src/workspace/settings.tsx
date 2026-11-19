// Settings: one sheet, its sections listed at its left, one section shown at a time. The sections are what a person
// comes here to do, the most frequent and the most consequential first: what happens to a thought, how voice becomes
// text, which agents run the work, how the app looks, how a terminal reads, and what the app is and sends. Each row is
// one question with its answer readable at a glance (form.tsx Row). Every choice the core keeps is a preference
// (`prefs`), written at once, so the notch and the workspace both follow; nothing is shown that the core cannot keep.
import { getVersion } from '@tauri-apps/api/app';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { MotionAmbient, MotionPalette, MotionStyle, Shortcut, TextSize } from '../../../core/proto/protocol.ts';
import { routing } from '../capture.tsx';
import { hit, recorder } from '../keys.ts';
import { talkKey } from '../page.ts';
import { CALM, HERE, KEPT, KEYS_KEPT, MICROPHONE, mac } from '../system.ts';
import { setVoice } from '../motion/engine.ts';
import { Motion, lookOf } from '../motion/motion.tsx';
import { stops } from '../motion/palette.ts';
import { ready as hearsHere } from '../speech/local.ts';
import { motionState } from '../motion/state.ts';
import { Voice } from '../motion/voice.ts';
import { I, Key, Ring } from '../ui.tsx';
import { placing } from '../way.ts';
import { Speech, Thoughts, serviceName } from './consent.tsx';
import { Choice, Recorder, Row, Switch, setPref } from './form.tsx';
import { LOOSE, agent, agentName, call, dismiss, fail, focus, loadTerms, newTerminal, openQuestions, placers, pref, records, redraw, ui } from './model.ts';

export const SECTIONS = [['thoughts', 'Thoughts'], ['voice', 'Voice'], ['agents', 'Agents'], ['appearance', 'Appearance'], ['terminal', 'Terminal'], ['about', 'About']] as const;
export type Section = (typeof SECTIONS)[number][0];
/** The section last shown: Settings opens there again unless a link asks for another. */
export const shown = { at: 'thoughts' as Section };
/** Shows a section. The keyboard goes to its place in the list: what had it may be a control of the section left. */
function go(at: Section) {
  ui.sheet = { kind: 'settings', at };
  redraw();
  requestAnimationFrame(() => focus(`#set-tab-${at}`));
}

const styles: [MotionStyle, string][] = [['slats', 'Slats'], ['glyphs', 'Glyphs'], ['resonator', 'Resonator']];
const palettes: [MotionPalette, string][] = [['chrome', 'Chrome'], ['chromatic', 'Chromatic'], ['warm', 'Warm'], ['cool', 'Cool'], ['custom', 'Custom']];
const effects: [MotionAmbient, string][] = [['off', 'Off'], ['still', 'Still'], ['breathing', 'Full']];
const holds: [number, string][] = [[0, 'At once'], [3, 'After 3 s'], [5, 'After 5 s'], [10, 'After 10 s']];
// Sizes whose cells differ by a whole pixel in the Default face.
const sizes: [number, string][] = [12, 14, 15, 16, 18].map((n) => [n, String(n)]);
const heights: [number, string][] = [[100, '1.0'], [110, '1.1'], [120, '1.2'], [130, '1.3']];
const FONTS = ['Hack Nerd Font Mono', 'JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo'];
const returns: [boolean, string][] = [[true, 'Sends it'], [false, 'Starts a new line']];
const keeps: [number, string][] = [[0, 'For ever'], [30, '30 days'], [90, '90 days'], [365, 'A year']];
const texts: [TextSize, string][] = [['small', 'Small'], ['default', 'Default'], ['large', 'Large']];

/** The capture key as the host has it: the one the system registered, which is not the stored one when the system
 *  refused that at start. Asked for when the section is shown, and told by every change made here. */
let capture: Shortcut | null | undefined;
const askCapture = () => call('host.capture_key', {}).then((r) => ((capture = r.key), redraw()), () => {});
const setCapture = (key: Shortcut | null) => call('host.capture_key', { key }).then((r) => ((capture = r.key), redraw()));
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
      ? `The microphone was not allowed. Tasktap Next can be allowed in ${MICROPHONE}.`
      : e instanceof Error ? e.message : String(e);
  }
  asking = false;
  redraw();
}

/** What happens to a thought once it is sent: when it starts, and how it finds its folder. */
function ThoughtsPane() {
  const hold = records.prefs.get('hold');
  const sends = pref('return_sends'), days = pref('keep_days'), stored = pref('capture_key');
  // (One effect, as before the tab: the sections are called inside Settings, so their hooks are its own, in order.)
  useEffect(() => void (askCapture(), mac || askTab()), []);
  const places: [string, string][] = !tab ? [] : [['main', 'Main display'], ['pointer', 'Where it was last opened'],
    ...(tab.displays.length > 1 || !['main', 'pointer', 'off'].includes(tab.display)
      ? [...new Set([...tab.displays.map((d) => d.name), ...(['main', 'pointer', 'off'].includes(tab.display) ? [] : [tab.display])])].map((name): [string, string] => [name, displayName(name)])
      : []),
    ['off', 'Off']];
  // The stored key is not the one in use: the system refused it when the app started.
  const lost = capture !== undefined && stored && !same(stored, capture);
  return (
    <>
      <Row name="A sent thought starts" hint="Until it starts, Undo takes it back.">
        <Choice name="A sent thought starts" value={hold?.id === 'hold' ? hold.value : 5} all={holds} set={(v) => setPref({ id: 'hold', patch: v })} />
      </Row>
      <Thoughts />
      <Row name="Return in a thought" hint={sends ? `${mac ? 'Shift-Return' : 'Shift+Enter'} starts a new line.` : `${mac ? 'Command-Return' : 'Ctrl+Enter'} sends it.`}>
        <Choice name="Return in a thought" value={sends} all={returns} set={(v) => setPref({ id: 'return_sends', patch: v })} />
      </Row>
      <Row name="From any app" hint={lost ? `The key you chose is taken by the system or another app${capture ? ', so the one shown is in use' : ', so no key is in use'}. Choose another, or use the default.`
        : capture === null ? 'The usual key is taken by the system or another app, so no key is in use. Record one of your own.'
          : mac ? 'Opens the notch for a thought, whatever is in front.'
            : tab?.display === 'off' ? 'Brings Tasktap forward with a new thought, whatever is in front.' : 'Opens the tab at the top of the screen for a thought, whatever is in front.'}>
        {capture !== undefined && <Recorder name="From any app" value={capture} own={!!stored} set={setCapture} />}
      </Row>
      {tab && (
        <Row name="Tab at the top of the screen" hint={tab.display === 'off' ? 'No tab. The key above brings Tasktap forward instead, and its icon stays in the notification area.'
          : tab.display === 'main' ? 'Shows what runs and what waits, and opens under the pointer. The key above opens it on the display the pointer is on.'
            : tab.display === 'pointer' ? 'Stays on the display where the key above last opened it.'
              : 'On the main display while that one is not connected.'}>
          <Choice name="Tab at the top of the screen" value={tab.display} all={places} set={setTab} />
        </Row>
      )}
      <Row name="Finished thoughts are kept" hint={days ? 'Applies from the next start, or within a day. Nothing that waits for you is ever removed.' : undefined}>
        <Choice name="Finished thoughts are kept" value={days} all={keeps.some(([n]) => n === days) ? keeps : [...keeps, [days, `${days} days`]]} set={(v) => setPref({ id: 'keep_days', patch: v })} />
      </Row>
    </>
  );
}

/** How voice becomes text (consent.tsx), and the key held to talk: stored as the preference it is, which the core
 *  holds to the rule of a shortcut. */
function VoicePane() {
  const setTalk = (key: Shortcut | null) => (key ? call('put', { c: 'prefs', id: 'talk_key', patch: key }) : call('delete', { c: 'prefs', id: 'talk_key' }));
  return (
    <>
      <Speech />
      <Row name="Hold to talk" hint="Held in a thought or a reply. Letting go ends it.">
        <Recorder name="Hold to talk" value={talkKey()} own={!!pref('talk_key')} set={setTalk} />
      </Row>
    </>
  );
}

/** The agents this Mac has, with how each is signed in, and a terminal to sign in to one that is not. One of them is
 *  the default: it runs a thought unless another ring was picked for that thought in the Composer. Only here is the
 *  default changed (the `agent` preference). */
const signIn: Record<string, string> = { claude: 'claude', codex: 'codex login', agy: 'agy' };
/** What a row adds about its agent: whose models it runs, where its name does not say, and that what it asks is
 *  answered in its own terminal, where no hook of it lets the notch answer. */
const family: Record<string, string> = { agy: 'Gemini' };
const about = (a: { id: string; permissions: string | null }) => [family[a.id], a.permissions === 'terminal' && 'asks in its terminal'];
function AgentsPane() {
  const agents = [...records.agents.values()];
  if (!agents.length) return <p class="note">Looking for agents…</p>;
  const usual = agent()?.id;
  return (
    <>
      <div class="list">
        {agents.map((a) => {
          const off = a.installed && a.signed_in === false;
          const state = !a.installed ? 'not installed' : a.signed_in === false ? 'not signed in' : a.signed_in ? 'signed in' : 'installed';
          return (
            <div class="line ag" data-s={off || !a.installed ? 'off' : undefined}>
              <Ring agent={a.id} s={off || !a.installed ? 'off' : ''} />
              <span class="t">{agentName(a.id)}</span>
              <span class="x">{[a.version, state, a.identity, ...about(a)].filter(Boolean).join(' · ')}</span>
              {off && signIn[a.id] && (
                <button type="button" class="btn" onClick={() => (dismiss(), newTerminal(LOOSE, { title: `Sign in to ${agentName(a.id)}`, type: signIn[a.id] }))}>Sign in</button>
              )}
              {a.id === usual ? <span class="x def">Default</span> : a.installed && !off && (
                <button type="button" class="btn" onClick={() => setPref({ id: 'agent', patch: a.id })}>Make default</button>
              )}
            </div>
          );
        })}
      </div>
      <p class="note">The default runs your thoughts. For one thought, pick another by its ring where you write it.</p>
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
  // Leaving the section, or the sheet, ends the trial.
  useEffect(() => () => void (trial && stopTrial()), []);
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
  return (
    <>
      <Row name="Font" hint="Any installed monospace family. Prompt symbols come from the Nerd Fonts symbols either way.">
        <input class="text" list="fonts" placeholder="Default (Hack)" aria-label="Font" spellcheck={false} maxLength={100} defaultValue={pref('terminal_font')}
          onChange={(e) => setPref({ id: 'terminal_font', patch: e.currentTarget.value.trim() })} />
        <datalist id="fonts">{FONTS.map((f) => <option value={f} />)}</datalist>
      </Row>
      <Row name="Size"><Choice name="Size" value={pref('terminal_size')} all={sizes} set={(v) => setPref({ id: 'terminal_size', patch: v })} /></Row>
      <Row name="Line height"><Choice name="Line height" value={pref('terminal_line_height')} all={heights} set={(v) => setPref({ id: 'terminal_line_height', patch: v })} /></Row>
      <Row name="Bold text in bright colours" hint="As most terminals draw it. Off, bold text keeps the colour its program gave it.">
        <Switch on={pref('terminal_bold_bright')} name="Bold text in bright colours" set={(on) => setPref({ id: 'terminal_bold_bright', patch: on })} />
      </Row>
      <Row name="Keep text readable" hint="A colour too close to what is behind it is lifted until it reads. Off, every colour is exactly what its program asked for.">
        <Switch on={pref('terminal_contrast')} name="Keep text readable" set={(on) => setPref({ id: 'terminal_contrast', patch: on })} />
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
  const by = pref('route_by'), places = placing(by, placers()) === 'on', speech = pref('speech_by'), usual = agent();
  return (
    <>
      <Row name="Tasktap Next"><span class="v">{version ? `Version ${version}` : 'This build has no version number'}</span></Row>
      <h3>What leaves {HERE}</h3>
      <Row name="Your thoughts" hint={`Each goes to the agent that runs it${usual ? `, ${agentName(usual.id)} unless you pick another` : ''}, in a terminal on ${HERE}, under that agent's own sign-in.`}>
        <span class="v">To the agent</span><To at="agents">Agents</To>
      </Row>
      <Row name="Placing" hint={places ? `Each thought that names no folder, with the names of your folders and sessions, is read by ${agentName(by!.agent)}'s ${by!.model}.` : `Thoughts are placed by name, on ${HERE}.`}>
        <span class="v">{places ? `To ${agentName(by!.agent)}` : 'Nothing'}</span><To at="thoughts">Thoughts</To>
      </Row>
      <Row name="Voice" hint={speech ? 'Each recording, when you let go. Tasktap keeps none.' : hearsHere() ? `What you say is turned into text on ${HERE}. Its model was downloaded once, from huggingface.co.` : 'Voice is not set up.'}>
        <span class="v">{speech ? `To ${serviceName(speech.server)}` : 'Nothing'}</span><To at="voice">Voice</To>
      </Row>
      <Row name="Anything else" hint="Tasktap has no account and reports nothing about what you do."><span class="v">Nothing</span></Row>
      <h3>Kept on {HERE}</h3>
      <Row name="Thoughts and history" hint={`With these settings, ${KEPT}.`}><span class="v">In a file</span></Row>
      <Row name="A service's key" hint="Written once and never shown again."><span class="v">{KEYS_KEPT}</span></Row>
      <h3>Licences</h3>
      <Licence name="Hack" what="The terminal's font · MIT and Bitstream Vera" file="Hack-3.003-LICENSE.md" />
      <Licence name="Nerd Fonts symbols" what="Prompt symbols · MIT" file="NerdFonts-3.4.0-LICENSE.txt" />
      <Licence name="Whisper" what={`The model for speech on ${HERE} · MIT`} file="Whisper-model-LICENSE.txt" />
      <Licence name="whisper.cpp" what="What runs that model · MIT" file="whisper.cpp-1.9.5-LICENSE.txt" />
      <Row name="Libraries" hint="Open source, under the MIT and Apache 2.0 licences; SQLite is in the public domain."><span class="v">xterm.js, Preact, Tauri, Tokio, SQLite</span></Row>
    </>
  );
}

const PANES: Record<Section, () => ComponentChildren> = {
  thoughts: () => <ThoughtsPane />, voice: () => <VoicePane />, agents: () => <AgentsPane />, appearance: () => <AppearancePane />, terminal: () => <TerminalPane />, about: () => <AboutPane />,
};

export function Settings({ at }: { at: Section }) {
  shown.at = at;
  useEffect(() => void loadTerms(), []);
  // A section by its key, ⌘1 to ⌘6, from anywhere in the sheet.
  useEffect(() => {
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
    <div class="settings">
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
