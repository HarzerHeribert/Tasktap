// New versions, as the host tells them (host/src/update.rs): a row in Settings › About, which asks when it is shown,
// and one quiet line in the rail while a new version waits. Nothing is installed but from About, at the person's word;
// nothing interrupts.
import { useEffect } from 'preact/hooks';
import type { HostUpdate } from '../client.ts';
import { mac } from '../system.ts';
import { Row } from './form.tsx';
import { call, fail, redraw } from './model.ts';

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

/** Where things stand; with `look`, the host asks GitHub now. */
export const askUpdate = (look = false) => call('host.update', look ? { look } : {}).then(heard, () => {});

const install = () => void call('host.update', { install: true }).then(heard, fail);

/** The newest the host found, while it waits for the person: the rail's line. */
export const waiting = () => (update.now.state === 'available' ? update.now.version : null);

const NAME = 'New versions';

/** About's row: where things stand, in words, and the one thing to do now. */
export function UpdateRow() {
  useEffect(() => void askUpdate(true), []);
  const u = update.now;
  const restarts = mac ? 'Tasktap restarts to finish; your agents keep working.' : 'Tasktap closes while it installs and opens again; your agents keep working.';
  switch (u.state) {
    case 'off':
      return <Row name={NAME} hint="This copy was built on this computer, so it never asks for new versions."><span class="v">Not checked for this copy</span></Row>;
    case 'unknown':
    case 'looking':
      return <Row name={NAME} hint={`Tasktap asks GitHub ${ASKS}, and installs one only when you say.`}><span class="v">Checking…</span></Row>;
    case 'current':
      return <Row name={NAME} hint={`Version ${u.version} is the newest; Tasktap asks GitHub again ${ASKS}.`}><span class="v">Up to date</span></Row>;
    case 'available':
      return (
        <Row name={NAME} hint={<>{u.notes && <>{u.notes.length > 400 ? `${u.notes.slice(0, 400)}…` : u.notes} </>}{restarts}</>}>
          <span class="v">Version {u.version} is ready</span>
          <button type="button" class="btn" onClick={install}>{mac ? 'Install and restart' : 'Install'}</button>
        </Row>
      );
    case 'downloading':
      return <Row name={NAME} hint={restarts}><span class="v">Downloading version {u.version}{u.percent == null ? '…' : `, ${u.percent} %`}</span></Row>;
    case 'installing':
      return <Row name={NAME} hint="Tasktap opens again by itself."><span class="v">Installing version {u.version}…</span></Row>;
    case 'failed':
      return (
        <Row name={NAME} hint={`${u.why}.`}>
          <span class="v">{u.version ? `Version ${u.version} was not installed` : 'Could not ask for a new version'}</span>
          <button type="button" class="btn" onClick={() => void askUpdate(true)}>Try again</button>
        </Row>
      );
  }
}
