// The two things that leave this Mac only once the person has allowed them, and where they allow them: a model that
// places thoughts and writes their brief (the `route_by` preference), and a speech service that turns what they say
// into text (`speech_by`). Each is a sheet that shows, in the core's own words (`route.terms`, `speech.terms`), what is
// sent and to whom before anything is stored; Allow writes the preference, and its section of Settings says what is
// on and turns it off. Nothing here is kept by the page.
//
// Speech has a second way that sends nothing: on this Mac, by a model the person downloads once (speech/local.ts).
// Its row says what it needs, how far the download is, that it is ready and how large, or why it failed, and removes
// it. Which of the two is in use is the `speech_by` preference alone: with it the service, without it this Mac.
import { useEffect, useState } from 'preact/hooks';
import { cap } from '../capture.tsx';
import { keyName, talkKey } from '../keys.ts';
import { type Local, local, model, watch } from '../speech/local.ts';
import { I, Ring } from '../ui.tsx';
import { placing } from '../way.ts';
import { agent, agentName, call, dismiss, fail, focus, loadTerms, open, placers, pref, records, redraw, terms } from './model.ts';
import { Row } from './form.tsx';
import { type Act, Frame } from './sheets.tsx';

const said = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ——— Placing thoughts ———

/** Settings, "Thoughts": whether a model places them, whose, and the way to what it is sent. */
export function Thoughts() {
  const tools = placers(), by = pref('route_by'), state = placing(by, tools);
  const sheet = () => open({ kind: 'placing', back: true });
  return (
    <Row name="Placing" hint={state === 'on' ? 'It reads each thought that names no folder, and writes the brief from long ones. Your own words always go along.'
      : state === 'again' ? 'What Tasktap asks has changed. Until you agree again, thoughts go by name.'
        : `A thought goes to the folder or session it names.${!tools.length && terms.route ? ' A model can place them once an agent is signed in.' : ''}`}>
      {state === 'on' && <><span class="v">By {agentName(by!.agent)} · {by!.model}</span><button type="button" class="btn" onClick={sheet}>What it is sent…</button></>}
      {state === 'again' && <><span class="v warn">Needs agreeing again</span><button type="button" class="btn" onClick={sheet}>Look again…</button></>}
      {state === 'off' && <span class="v">By name</span>}
      {state === 'off' && tools.length > 0 && <button type="button" class="btn" onClick={sheet}>Let a model place them…</button>}
    </Row>
  );
}

/** What placing by a model gives, who would read the thoughts, exactly what is sent, and the instructions in full
 *  behind one quiet line. Allow writes the preference; while it is on, the same sheet turns it off. */
export function PlacingSheet({ back }: { back?: boolean }) {
  const t = terms.route, tools = placers(), by = pref('route_by'), state = placing(by, tools);
  const [pick, setPick] = useState('');
  const [reads, setReads] = useState(false);
  useEffect(() => void loadTerms(), []);
  // The agent already agreed to, else the one that runs the thoughts, else the first that can.
  const chosen = tools.find((x) => x.agent === pick) ?? tools.find((x) => x.agent === (state === 'on' ? by!.agent : agent()?.id)) ?? tools[0];
  const done = () => (back ? open({ kind: 'settings', at: 'thoughts' }) : dismiss());
  const put = (patch: typeof by) => void call('put', { c: 'prefs', id: 'route_by', patch }).then(done, fail);
  const no = () => {
    cap.offer = false;
    // Asked once: No is an answer, kept like Yes.
    if (records.prefs.has('route_by')) done();
    else put(null);
  };
  const same = state === 'on' && chosen?.agent === by!.agent;
  const acts: Act[] = !chosen ? [{ k: 'esc', label: 'Close', do: done }]
    // Turned off, the preference holds No rather than nothing, so what was answered is not offered again; to the core both are no consent.
    : same ? [{ k: '⌘⌫', label: 'Turn off', kind: 'danger', do: () => put(null) }, { k: 'esc', label: 'Close', do: done }]
      : [{ k: '↩', label: state === 'on' ? `Use ${agentName(chosen.agent)} instead` : 'Allow', kind: 'primary', do: () => put(chosen) }, { k: 'esc', label: state === 'off' ? 'Not now' : 'Close', do: state === 'off' ? no : done }];
  return (
    <Frame size="md" title={state === 'on' ? 'A model places your thoughts' : state === 'again' ? 'Placing needs agreeing again' : 'Let a model place your thoughts'} acts={acts}>
      <div class="terms">
        {state === 'again' && <p class="warn">You agreed to {agentName(by!.agent)} with {by!.model}. Tasktap now asks {tools.find((x) => x.agent === by!.agent)?.model ?? 'another agent'}, so thoughts go by name until you agree again.</p>}
        <ul class="gets">
          <li>Say a thought without naming a folder. It goes where it belongs.</li>
          <li>Ramble. The agent gets a brief written from what you said, and nothing you did not say.</li>
          <li>Your own words are always sent along with the brief.</li>
        </ul>
        {!t ? <p>Asking what is sent…</p> : !chosen ? <p>No agent that can do this is signed in yet. Sign one in under Settings, Agents, then come back.</p> : (
          <>
            <h3>Who reads them</h3>
            <div class="list" role="radiogroup" aria-label="Who reads them">
              {tools.map((x) => (
                <button type="button" class="line tool" role="radio" aria-checked={x === chosen}
                  onClick={(e) => (setPick(x.agent), focus(e.currentTarget.closest<HTMLElement>('.sheet')))}>
                  <Ring agent={x.agent} s="" /><span class="t">{agentName(x.agent)}</span><span class="x">its small model, {x.model}, under the sign-in it already has</span>
                </button>
              ))}
            </div>
            <h3>What it is sent with each thought</h3>
            <ul class="sends">{t.sends.map((s) => <li>{s}</li>)}</ul>
            <p>A short thought that names its folder is placed on this Mac and sent nowhere.</p>
            <button type="button" class="disc" aria-expanded={reads} onClick={() => setReads(!reads)}><I n="chev" /><span>The instructions it follows</span></button>
            {reads && <pre class="instr" tabIndex={0}>{t.instructions}</pre>}
          </>
        )}
      </div>
    </Frame>
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
    return <><span class="v">A key is stored</span><button type="button" class="btn" onClick={() => void call('key.remove', { server }).catch(fail)}>Remove</button></>;
  return (
    <>
      <input class="text" type="password" aria-label="Key" autocomplete="off" spellcheck={false} maxLength={512} placeholder={onInput ? 'Paste a key, if the service wants one' : 'Paste a key, then Return'}
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

/** "On this Mac": what it needs, how far that is, that it is ready and what it takes, or why it failed. */
function OnThisMac({ l, used }: { l: Local | null; used: boolean }) {
  const [err, say] = useState('');
  const act = (what: 'install' | 'stop' | 'remove') => (say(''), void model(what).catch((e) => say(said(e))));
  if (!l) return <span class="v dim">Asking…</span>;
  if (!l.supported) return <span class="v dim">Not available on this system. Voice needs a speech service here.</span>;
  const part = l.have > 0 && l.have < l.of;
  return (
    <>
      {l.model === 'ready' && <><span class="v">{used ? 'Ready' : 'Ready, not in use'} · {MODEL} · {mb(l.of)} on this Mac</span><button type="button" class="btn" onClick={() => act('remove')}>Remove</button></>}
      {l.model === 'fetching' && (
        <>
          <span class="v" role="status">Downloading · {Math.floor((100 * l.have) / l.of)} % of {mb(l.of)}</span>
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
  const hold = `Hold ${keyName(talkKey())} in a thought or a reply, or hold the microphone.`;
  const hint = !here ? `${hold} A recording is sent when you let go.`
    : fetched ? `${hold} What you say is turned into text on this Mac and sent nowhere.`
      : l?.supported ? `Downloaded once from huggingface.co and kept in Tasktap’s data folder. After that, what you say is turned into text on this Mac and sent nowhere.${by ? ` Until it is here, ${serviceName(by.server)} stays in use.` : ''}` : undefined;
  return (
    <>
      <Row name="Turned into text" hint={hint}>
        <div class="seg" role="radiogroup" aria-label="Turned into text">
          <button type="button" role="radio" aria-checked={here} onClick={() => choose('local')}>On this Mac</button>
          <button type="button" role="radio" aria-checked={!here} onClick={() => choose('service')}>A speech service</button>
        </div>
        {here ? <OnThisMac l={l} used={!by} /> : <><span class="v">By {serviceName(by.server)} · {by.model}</span><button type="button" class="btn" onClick={() => open({ kind: 'speech' })}>Change…</button></>}
      </Row>
      {by && !here && <Row name="Key"><Key server={by.server} /></Row>}
      <Row name="Languages you speak" hint="Up to four, in any order: what you say is written in the language you say it in. With none chosen, any language is listened for.">
        <div class="seg" role="group" aria-label="Languages you speak">
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
