"""Read the last provider-recorded model without changing agent configuration."""
import json
import os
from pathlib import Path
import sqlite3
import uuid


def model_id(value):
    if not isinstance(value, str) or len(value) > 250 or value.startswith('-') or (value and not value.isprintable()):
        raise ValueError('Choose a valid model ID in Tasktap Preferences.')
    return value


def last_transcript_model(path, provider):
    # Walk complete lines backwards. Conversations can exceed hundreds of MB.
    try:
        with path.open('rb') as stream:
            stream.seek(0, 2)
            end = stream.tell()
            suffix = b''
            while end:
                start = max(0, end - 65536)
                stream.seek(start)
                lines = (stream.read(end - start) + suffix).split(b'\n')
                suffix = lines.pop(0) if start else b''
                for line in reversed(lines):
                    if b'"model"' not in line:
                        continue
                    try:
                        event = json.loads(line)
                        if provider == 'codex' and event.get('type') == 'turn_context':
                            return model_id(event.get('payload', {}).get('model', ''))
                        if provider == 'claude' and event.get('type') == 'assistant':
                            value = event.get('message', {}).get('model', '')
                            if value and value != '<synthetic>':
                                return model_id(value)
                    except (ValueError, AttributeError):
                        continue
                end = start
    except OSError:
        pass
    return ''


def conversation_model(provider, session):
    try:
        uuid.UUID(session)
    except (ValueError, TypeError):
        return ''
    if provider == 'claude':
        root = Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home()/'.claude')
        for path in (root/'projects').glob('*/'+session+'.jsonl'):
            model = last_transcript_model(path, provider)
            if model:
                return model
    if provider == 'codex':
        root = Path(os.environ.get('CODEX_HOME') or Path.home()/'.codex').resolve()
        try:
            with sqlite3.connect((root/'state_5.sqlite').as_uri()+'?mode=ro', uri=True, timeout=1) as db:
                columns = {row[1] for row in db.execute('PRAGMA table_info(threads)')}
                if 'model' in columns:
                    row = db.execute('SELECT model FROM threads WHERE id=?', (session,)).fetchone()
                    if row and row[0]:
                        return model_id(row[0])
                row = db.execute('SELECT rollout_path FROM threads WHERE id=?', (session,)).fetchone()
                if row and row[0]:
                    path = Path(row[0]).resolve()
                    if root in path.parents:
                        return last_transcript_model(path, provider)
        except (sqlite3.Error, OSError, ValueError):
            pass
        for path in (root/'sessions').glob('*/*/*/*'+session+'.jsonl'):
            model = last_transcript_model(path, provider)
            if model:
                return model
    return ''
