// New versions, as the host tells them (host/src/update.rs): a row in Settings › About, which looks when it is shown,
// and one quiet line in the rail while a new version waits. Nothing is installed but from About, at the person's word;
// nothing interrupts.
import { useEffect } from 'preact/hooks';
import type { HostUpdate } from '../client.ts';
import { mac } from '../system.ts';
import { Row } from './form.tsx';
import { call, fail, redraw } from './model.ts';

export const update = { now: { state: 'unknown' } as HostUpdate };

/** What the host said, by its `ui` event or a reply. */
export function heard(said: HostUpdate | null) {
  // A host without the call (a check's stand-in) answers nothing: nothing changes.
  if (!said?.state) return;
  update.now = said;
  redraw();
}

/** Where things stand; with `look`, the host looks now. */
export const askUpdate = (look = false) => call('host.update', look ? { look } : {}).then(heard, () => {});

const install = () => void call('host.update', { install: true }).then(heard, fail);

/** The newest the host found, while it waits for the person: the rail's line. */
export const waiting = () => (update.now.state === 'available' ? update.now.version : null);

/** About's row: where things stand, in words, and the one thing to do now. */
export function UpdateRow() {
  useEffect(() => void askUpdate(true), []);
  const u = update.now;
  const restarts = mac ? 'Tasktap restarts to finish; your sessions keep running.' : 'Tasktap closes while it installs and opens again; your sessions keep running.';
  switch (u.state) {
    case 'off':
      return <Row name="Updates" hint="This copy was built on this computer and does not look for new versions."><span class="v">Not for this copy</span></Row>;
    case 'unknown':
    case 'looking':
      return <Row name="Updates"><span class="v">Looking for a new version…</span></Row>;
    case 'current':
      return <Row name="Updates" hint={`Version ${u.version} is the newest.`}><span class="v">Up to date</span></Row>;
    case 'available':
      return (
        <Row name="Updates" hint={<>{u.notes && <>{u.notes.length > 400 ? `${u.notes.slice(0, 400)}…` : u.notes} </>}{restarts}</>}>
          <span class="v">Version {u.version} is ready</span>
          <button type="button" class="btn" onClick={install}>{mac ? 'Install and restart' : 'Install'}</button>
        </Row>
      );
    case 'downloading':
      return <Row name="Updates" hint={restarts}><span class="v">Downloading version {u.version}{u.percent == null ? '…' : `, ${u.percent} %`}</span></Row>;
    case 'installing':
      return <Row name="Updates" hint="Tasktap opens again by itself."><span class="v">Installing version {u.version}…</span></Row>;
    case 'failed':
      return (
        <Row name="Updates" hint={`${u.why}.`}>
          <span class="v">{u.version ? `Version ${u.version} was not installed` : 'Could not look for a new version'}</span>
          <button type="button" class="btn" onClick={() => void askUpdate(true)}>Try again</button>
        </Row>
      );
  }
}
