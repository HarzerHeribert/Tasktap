// New versions, as the host tells them (host/src/update.rs): a row in Settings › About, which asks when it is shown
// while the person lets Tasktap ask by itself (the `update_checks` preference, its switch), and one quiet line in the
// rail while a new version waits. With the switch off nothing asks but the person's own Check now. Nothing is
// installed but from About, at the person's word; nothing interrupts.
import { useEffect } from 'preact/hooks';
import type { HostUpdate } from '../client.ts';
import { mac } from '../system.ts';
import { Row, Switch, setPref } from './form.tsx';
import { call, fail, pref, redraw } from './model.ts';

export const update = { now: { state: 'unknown' } as HostUpdate };

/** When a released build asks GitHub for a new version (host/src/update.rs): when About is shown, and at the first
 *  capture of a day. A build made on a person's own machine never asks: the host says `off`. */
export const ASKS = 'when About opens and at the first thought of a day';

/** What the host said, by its `ui` event or a reply. */
export function heard(said: HostUpdate | null) {
  // A host without the call (a check's stand-in) answers nothing: nothing changes.
  if (!said?.state) return;
  update.now = said;
  redraw();
}

/** Where things stand; with `look`, the host asks GitHub now if the person lets it ask by itself; `now`: they asked. */
export const askUpdate = (look = false, now = false) => call('host.update', look ? { look, ...(now ? { now } : {}) } : {}).then(heard, () => {});

const install = () => void call('host.update', { install: true }).then(heard, fail);
/** Whether the person lets Tasktap ask by itself: on until they turn it off. */
export const checks = () => pref('update_checks');

/** The newest the host found, while it waits for the person: the rail's line. */
export const waiting = () => (update.now.state === 'available' ? update.now.version : null);

const NAME = 'Check for new versions';

/** Switched on, Tasktap asks at once: About is open. Off, it asks nothing more. */
const allow = (on: boolean) => {
  setPref({ id: 'update_checks', patch: on });
  if (on) void askUpdate(true, true);
};

/** About's row: the switch, where things stand in words, and the one thing to do now. Off, Check now asks once. */
export function UpdateRow() {
  const on = checks();
  useEffect(() => void askUpdate(checks()), []);
  const u = update.now;
  const restarts = mac ? 'Tasktap restarts to finish; your agents keep working.' : 'Tasktap closes while it installs and opens again; your agents keep working.';
  if (u.state === 'off') return <Row name={NAME} hint="This copy was built on this computer, so it never checks for new versions."><span class="v">Not for this copy</span></Row>;
  const toggle = <Switch on={on} name={NAME} set={allow} />;
  const now = <button type="button" class="btn" onClick={() => void askUpdate(true, true)}>Check now</button>;
  switch (u.state) {
    case 'unknown':
      return on ? <Row name={NAME} hint={`Tasktap asks GitHub ${ASKS}, and installs one only when you say.`}>{toggle}<span class="v">Checking…</span></Row>
        : <Row name={NAME} hint="Tasktap never asks GitHub by itself; Check now asks once, and nothing is installed unless you say.">{toggle}<span class="v">Off</span>{now}</Row>;
    case 'looking':
      return <Row name={NAME} hint={on ? `Tasktap asks GitHub ${ASKS}, and installs one only when you say.` : 'Tasktap asks GitHub this once, and installs a new version only when you say.'}>{toggle}<span class="v">Checking…</span></Row>;
    case 'current':
      return on ? <Row name={NAME} hint={`Version ${u.version} is the newest; Tasktap asks GitHub again ${ASKS}.`}>{toggle}<span class="v">Up to date</span></Row>
        : <Row name={NAME} hint={`Version ${u.version} is the newest; Tasktap asks GitHub again only when you check now.`}>{toggle}<span class="v">Up to date</span>{now}</Row>;
    case 'available':
      return (
        <Row name={NAME} hint={<>{u.notes && <>{u.notes.length > 400 ? `${u.notes.slice(0, 400)}…` : u.notes} </>}{restarts}</>}>
          {toggle}<span class="v">Version {u.version} is ready</span>
          <button type="button" class="btn" onClick={install}>{mac ? 'Install and restart' : 'Install'}</button>
        </Row>
      );
    case 'downloading':
      return <Row name={NAME} hint={restarts}>{toggle}<span class="v">Downloading version {u.version}{u.percent == null ? '…' : `, ${u.percent} %`}</span></Row>;
    case 'installing':
      return <Row name={NAME} hint="Tasktap opens again by itself.">{toggle}<span class="v">Installing version {u.version}…</span></Row>;
    case 'failed':
      return (
        <Row name={NAME} hint={`${u.why}.`}>
          {toggle}<span class="v">{u.version ? `Version ${u.version} was not installed` : 'Could not ask for a new version'}</span>
          <button type="button" class="btn" onClick={() => void askUpdate(true, true)}>Try again</button>
        </Row>
      );
  }
}
