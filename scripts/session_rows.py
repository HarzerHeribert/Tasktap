"""List Tasktap's own terminal sessions for the workspace, from their run folders."""
import json
from pathlib import Path
import uuid
import visible_session as visible


def rows(runs):
    result = []
    for folder in runs.iterdir():
        if not (folder/'surface.json').exists():
            continue
        try:
            jobs = sorted(folder.glob('*.job'))
            path = next(p for p in jobs if visible.load(p)['mode'] == 'ask')
            job = visible.load(path)
            row = dict(id=job['session'], agent=job['agent'], folder=job['folder'], owned='yes', task=job['task'],
                       inbox='manual', state='Connected', available='yes',
                       scratch='yes' if Path(job['folder']) == runs.parent/'Scratch' else 'no')
            # Tasktap 1.2 also ran sessions in other apps' terminals. Those stay closed history.
            hosted = job.get('host', 'tasktap') == 'tasktap'
            alive = hosted and visible.load(folder/'surface.json').get('open') and visible.locked(folder)
            if not alive:
                row.update(state='Closed', available='no')
            thread = job['session'] if job['agent'] == 'claude' else ''
            if (folder/'thread.json').exists():
                thread = str(uuid.UUID(visible.load(folder/'thread.json')['id']))
            row['conversation'] = thread
            if not alive and hosted and visible.resume_id(folder, job):
                row['resumable'] = 'yes'
            latest = jobs[-1]
            receipt = latest.with_suffix('.receipt')
            row['updatedAt'] = str(int(max(latest.stat().st_mtime, receipt.stat().st_mtime if receipt.exists() else 0)*1000))
            if not alive and receipt.is_file() and visible.load(receipt).get('state') == 'Complete':
                row['state'] = 'Complete'
            if alive and job['agent'] == 'claude':
                confirmed = ((folder/'claude-turn-started').is_file() or
                             (path.with_suffix('.receipt').is_file() and visible.load(path.with_suffix('.receipt')).get('state') == 'Complete'))
                row['startup'] = 'confirmed' if confirmed else 'pending'
            if thread and job['agent'] == 'codex':
                row['inbox'] = 'codex'
            if job.get('observer') is True:
                from session_observer import read, ingest, public_state, LABELS
                observation = read(folder/'observer.json')
                if observation:
                    if not alive and observation.get('state') != 'ended':
                        token = read(folder/'observer-config.json').get('token', '')
                        ingest(folder, token, dict(kind='process_exited'))
                        observation = read(folder/'observer.json')
                    row['state'] = LABELS.get(observation.get('state'), row['state']) if alive else 'Closed'
                    row['activity'] = observation.get('activity', '')
                    row['observerState'] = observation.get('state', '')
                    row['observation'] = json.dumps(public_state(observation))
                    row['updatedAt'] = str(int(observation.get('updatedAt', 0)*1000))
                    if observation.get('providerSession'):
                        row['conversation'] = observation['providerSession']
            result.append(row)
        except (OSError, ValueError, KeyError, StopIteration):
            continue
    return result
