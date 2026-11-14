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


def recover_codex_followups(folder, owner, jobs):
    """Recover queue receipts only from unique user prompts inside matching, completed turns."""
    from visible_session import load, save
    if owner['agent'] != 'codex' or len(jobs) < 2:
        return
    by_prompt = {}
    for path in jobs[1:]:
        job = load(path)
        if (job.get('mode') == 'nudge' and not job.get('external') and job.get('agent') == 'codex'
                and job.get('folder') == owner['folder'] and job.get('session') == owner['session'] and job.get('outgoing')):
            by_prompt.setdefault(job['outgoing'], []).append(path.with_suffix('.receipt'))
    pending = {prompt: items[0] for prompt, items in by_prompt.items() if len(items) == 1
               and items[0].is_file() and load(items[0]).get('state') == 'Delivered'}
    if not pending:
        return
    transcript = conversation_path(folder, owner)
    if not transcript:
        return
    completed = None
    prompt = None
    matches = {}
    for event in recent_events(transcript):
        entry = event.get('payload', {})
        kind = entry.get('type')
        if event.get('type') == 'event_msg':
            if kind == 'task_complete':
                completed = (entry, event['timestamp'])
                prompt = None
            elif kind in ('task_started', 'turn_failed', 'turn_aborted'):
                if (kind == 'task_started' and completed and prompt in pending and entry.get('turn_id')
                        and entry['turn_id'] == completed[0].get('turn_id') and completed[0].get('last_agent_message')):
                    end = datetime.fromisoformat(completed[1].replace('Z','+00:00')).timestamp()
                    if end >= pending[prompt].stat().st_mtime:
                        matches.setdefault(prompt, []).append((end, completed[0]['last_agent_message']))
                completed = prompt = None
        elif completed and event.get('type') == 'response_item' and kind == 'message' and entry.get('role') == 'user':
            content = entry.get('content', [])
            if len(content) == 1 and content[0].get('text') in pending:
                prompt = content[0]['text']
    if matches:
        with (folder/'.lock').open('a') as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            for prompt, turns in matches.items():
                receipt = pending[prompt]
                if len(turns) == 1 and load(receipt).get('state') == 'Delivered':
                    end, message = turns[0]
                    save(receipt, dict(state='Complete', message=message[:32000], turnFinishedAt=str(end)))


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
