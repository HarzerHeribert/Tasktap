"""Locate a provider's saved conversation and read its recent events."""
import json
import os
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
