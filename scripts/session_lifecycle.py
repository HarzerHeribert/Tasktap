"""Verify a completed handoff against the provider's saved conversation before closing its CLI."""
import json
import fcntl
import os
from datetime import datetime
from pathlib import Path
import sqlite3
import uuid


def conversation_path(folder, job):
    if job['agent'] == 'claude':
        session = str(uuid.UUID(job['session']))
        root = Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home()/'.claude')
        return next((root/'projects').glob('*/'+session+'.jsonl'), None)
    if job['agent'] == 'codex' and (folder/'thread.json').is_file():
        session = str(uuid.UUID(json.loads((folder/'thread.json').read_text())['id']))
        root = Path(os.environ.get('CODEX_HOME') or Path.home()/'.codex').resolve()
        with sqlite3.connect((root/'state_5.sqlite').as_uri()+'?mode=ro', uri=True, timeout=.5) as db:
            row = db.execute('SELECT cwd,rollout_path FROM threads WHERE id=?', (session,)).fetchone()
        if row and row[1] and Path(row[0]).resolve() == Path(job['folder']).resolve():
            path = Path(row[1]).resolve()
            if root in path.parents and path.is_file():
                return path
    return None


def recent_events(path):
    # Inspect a bounded tail. Ambiguous, incomplete or missing evidence keeps the worker open.
    with path.open('rb') as stream:
        start = max(0, stream.seek(0, 2) - 2*1024*1024)
        stream.seek(start)
        if start:
            stream.readline()
        tail = stream.read()
    if not tail.endswith(b'\n'):
        return
    for line in reversed(tail.splitlines()):
        if line:
            yield json.loads(line)


def report_turn_finished(path, job, reported):
    finished = None
    for event in recent_events(path):
        kind = event.get('type')
        if job['agent'] == 'codex':
            entry = event.get('payload', {})
            if kind != 'event_msg' or entry.get('type') not in ('task_complete','task_started','turn_failed','turn_aborted'):
                continue
            if entry['type'] != 'task_complete' or entry.get('started_at') is None:
                return False
            started = float(entry['started_at'])
            ended = datetime.fromisoformat(event['timestamp'].replace('Z','+00:00')).timestamp()
            return started <= reported <= ended
        if event.get('isSidechain') or event.get('sessionId') != job['session'] or event.get('cwd') != job['folder']:
            continue
        if kind == 'assistant':
            if finished is None:
                if event.get('message', {}).get('stop_reason') != 'end_turn':
                    return False
                finished = datetime.fromisoformat(event['timestamp'].replace('Z','+00:00')).timestamp()
                if finished < reported:
                    return False
        elif kind == 'user' and not event.get('isMeta'):
            content = event.get('message', {}).get('content')
            if isinstance(content, list) and any(part.get('type') == 'tool_result' for part in content if isinstance(part, dict)):
                continue
            return finished is not None and datetime.fromisoformat(event['timestamp'].replace('Z','+00:00')).timestamp() <= reported
    return False


def recover_codex_followup(folder, owner, latest):
    """Older queued nudges had no report ID. Match the exact user turn and its final answer."""
    from visible_session import load, save
    receipt = latest.with_suffix('.receipt')
    if owner['agent'] != 'codex' or latest == min(folder.glob('*.job')) or not receipt.exists():
        return
    if load(receipt).get('state') != 'Delivered':
        return
    job = load(latest)
    if (job.get('mode') != 'nudge' or job.get('external') or job.get('session') != owner['session']
            or job.get('folder') != owner['folder'] or not job.get('outgoing')):
        return
    path = conversation_path(folder, owner)
    if not path:
        return
    completion = None
    matched = False
    for event in recent_events(path):
        entry = event.get('payload', {})
        kind = entry.get('type')
        if event.get('type') == 'event_msg' and kind in ('task_complete','task_started','turn_aborted','turn_failed'):
            if completion is None:
                if kind != 'task_complete' or not entry.get('last_agent_message'):
                    return
                ended = datetime.fromisoformat(event['timestamp'].replace('Z','+00:00')).timestamp()
                if ended < receipt.stat().st_mtime:
                    return
                completion = entry
            else:
                if not matched or kind != 'task_started' or not entry.get('turn_id') or entry['turn_id'] != completion.get('turn_id'):
                    return
                with (folder/'.lock').open('a') as guard:
                    fcntl.flock(guard, fcntl.LOCK_EX)
                    if load(receipt).get('state') == 'Delivered':
                        save(receipt, dict(state='Complete', message=completion['last_agent_message'][:32000],
                                           turnFinishedAt=str(ended)))
                return
        elif completion and event.get('type') == 'response_item' and kind == 'message' and entry.get('role') == 'user':
            content = entry.get('content', [])
            if len(content)==1 and content[0].get('text') == job['outgoing']:
                matched = True


def completed_handoff(folder, job, keep_through=''):
    if (job.get('mode') != 'ask' or job.get('delivery') != 'interactive' or job.get('external')
            or job.get('session') != folder.name or job['agent'] not in ('codex','claude')):
        return None
    try:
        jobs = sorted(folder.glob('*.job'))
        if not jobs or jobs[-1].name <= keep_through:
            return None
        latest = jobs[-1].with_suffix('.receipt')
        if not latest.is_file():
            return None
        result = json.loads(latest.read_text())
        if result['state'] != 'Complete':
            return None
        # A receipt for one capture alone cannot settle the other turns in its queue.
        for item in jobs[:-1]:
            if json.loads(item.with_suffix('.receipt').read_text())['state'] not in ('Complete','Failed'):
                return None
        inbox = folder.parent.parent/'Agent Inbox'
        for request in (inbox/'requests').glob('*.json'):
            if json.loads(request.read_text()).get('sessionId') == job['session']:
                response = inbox/'responses'/request.name
                if not response.is_file() or json.loads(response.read_text()).get('status') != 'answered':
                    return None
        path = conversation_path(folder, job)
        if path and report_turn_finished(path, job, float(result.get('turnFinishedAt',latest.stat().st_mtime))):
            return jobs[-1].name
    except (OSError, ValueError, TypeError, KeyError, sqlite3.Error):
        pass
    return None
