// Settings: one sheet, its sections listed at its left, one section shown at a time. The sections are what a person
// comes here to do, the most frequent and the most consequential first: what happens to a thought, how voice becomes
// text, which agents run the work, how the app looks, how a terminal reads, and what the app is and sends. Each row is
// one question with its answer readable at a glance (form.tsx Row). Every choice the core keeps is a preference
// (`prefs`), written at once, so the notch and the workspace both follow; nothing is shown that the core cannot keep.
import { getVersion } from '@tauri-apps/api/app';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { MotionAmbient, MotionPalette, MotionStyle } from '../../../core/proto/protocol.ts';
import { routing } from '../capture.tsx';
import { setVoice } from '../motion/engine.ts';
import { Motion, lookOf } from '../motion/motion.tsx';
import { stops } from '../motion/palette.ts';
import { ready as hearsHere } from '../speech/local.ts';
import { motionState } from '../motion/state.ts';
import { Voice } from '../motion/voice.ts';
import { I, Key, Ring } from '../ui.tsx';
import { placing } from '../way.ts';
import { Speech, Thoughts, serviceName } from './consent.tsx';
import { Choice, Row, Switch, setPref } from './form.tsx';
import { LOOSE, agent, agentName, dismiss, focus, loadTerms, newTerminal, openQuestions, placers, pref, records, redraw, ui } from './model.ts';

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
      ? 'The microphone was not allowed. Tasktap Next can be allowed in System Settings, Privacy & Security, Microphone.'
      : e instanceof Error ? e.message : String(e);
  }
  asking = false;
  redraw();
}

/** What happens to a thought once it is sent: when it starts, and how it finds its folder. */
function ThoughtsPane() {
  const hold = records.prefs.get('hold');
  return (
    <>
      <Row name="A sent thought starts" hint="Until it starts, Undo takes it back.">
        <Choice name="A sent thought starts" value={hold?.id === 'hold' ? hold.value : 5} all={holds} set={(v) => setPref({ id: 'hold', patch: v })} />
      </Row>
      <Thoughts />
      <Row name="From any app" hint="Opens the notch for a thought, whatever is in front."><Key k="⌃⌥Space" cap /></Row>
    </>
  );
}

/** The agents this Mac has, with how each is signed in, and a terminal to sign in to one that is not. One of them is
 *  the default: it runs a thought unless another ring was picked for that thought in the Composer. Only here is the
 *  default changed (the `agent` preference). */
const signIn: Record<string, string> = { claude: 'claude', codex: 'codex login' };
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
              <span class="x">{[a.version, state, a.identity].filter(Boolean).join(' · ')}</span>
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
      <Row name="Lumen" hint="Coloured light behind the form and a beam across it. The light behind the notch takes the same colours.">
        <Switch on={look.lumen} name="Lumen" set={(on) => setPref({ id: 'motion_lumen', patch: on })} />
      </Row>
      <Row name="Effects" hint="The light, the chrome and everything that moves by itself. Still keeps the picture and stops the motion; Off draws none of it, which takes the least power and memory. While Reduce Motion or Low Power Mode is on in System Settings, Full behaves as Still.">
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
      <h3>What leaves this Mac</h3>
      <Row name="Your thoughts" hint={`Each goes to the agent that runs it${usual ? `, ${agentName(usual.id)} unless you pick another` : ''}, in a terminal on this Mac, under that agent's own sign-in.`}>
        <span class="v">To the agent</span><To at="agents">Agents</To>
      </Row>
      <Row name="Placing" hint={places ? `Each thought that names no folder, with the names of your folders and sessions, is read by ${agentName(by!.agent)}'s ${by!.model}.` : 'Thoughts are placed by name, on this Mac.'}>
        <span class="v">{places ? `To ${agentName(by!.agent)}` : 'Nothing'}</span><To at="thoughts">Thoughts</To>
      </Row>
      <Row name="Voice" hint={speech ? 'Each recording, when you let go. Tasktap keeps none.' : hearsHere() ? 'What you say is turned into text on this Mac. Its model was downloaded once, from huggingface.co.' : 'Voice is not set up.'}>
        <span class="v">{speech ? `To ${serviceName(speech.server)}` : 'Nothing'}</span><To at="voice">Voice</To>
      </Row>
      <Row name="Anything else" hint="Tasktap has no account and reports nothing about what you do."><span class="v">Nothing</span></Row>
      <h3>Kept on this Mac</h3>
      <Row name="Thoughts and history" hint="With these settings, in Tasktap's own folder in your Library."><span class="v">In a file</span></Row>
      <Row name="A service's key" hint="Written once and never shown again."><span class="v">In the keychain</span></Row>
      <h3>Licences</h3>
      <Licence name="Hack" what="The terminal's font · MIT and Bitstream Vera" file="Hack-3.003-LICENSE.md" />
      <Licence name="Nerd Fonts symbols" what="Prompt symbols · MIT" file="NerdFonts-3.4.0-LICENSE.txt" />
      <Licence name="Whisper" what="The model for speech on this Mac · MIT" file="Whisper-model-LICENSE.txt" />
      <Licence name="whisper.cpp" what="What runs that model · MIT" file="whisper.cpp-1.9.5-LICENSE.txt" />
      <Row name="Libraries" hint="Open source, under the MIT and Apache 2.0 licences; SQLite is in the public domain."><span class="v">xterm.js, Preact, Tauri, Tokio, SQLite</span></Row>
    </>
  );
}

const PANES: Record<Section, () => ComponentChildren> = {
  thoughts: () => <ThoughtsPane />, voice: () => <Speech />, agents: () => <AgentsPane />, appearance: () => <AppearancePane />, terminal: () => <TerminalPane />, about: () => <AboutPane />,
};

export function Settings({ at }: { at: Section }) {
  shown.at = at;
  useEffect(() => void loadTerms(), []);
  // A section by its key, ⌘1 to ⌘6, from anywhere in the sheet.
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      const to = e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey ? SECTIONS[Number(e.key) - 1] : undefined;
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
