"""Read local Codex desktop chat metadata and the most recent turn boundary."""
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import uuid

EVENT = re.compile(rb'"type":"event_msg","payload":\{"type":"(task_started|task_complete|turn_aborted|turn_failed)"')


def turn_state(path, cache):
    try:
        info = path.stat()
        entry = cache.get(str(path), {})
        offset = entry.get("offset", 0)
        state = entry.get("state", "Recent")
        if entry.get("inode") != info.st_ino or offset > info.st_size:
            offset, state = 0, "Recent"
        with path.open("rb") as stream:
            # Read back from the end on first discovery. On subsequent scans only
            # inspect events appended since the last complete line.
            end = info.st_size
            if offset != end:
                block_end = end
                suffix = b""
                while block_end > offset:
                    start = max(offset, block_end - 131072)
                    stream.seek(start)
                    chunk = stream.read(block_end - start) + suffix
                    matches = list(EVENT.finditer(chunk))
                    if matches:
                        state = "Running" if matches[-1][1] == b"task_started" else "Idle"
                        break
                    suffix = chunk[:128]
                    block_end = start
                stream.seek(max(0, end - 1))
                if stream.read(1) == b"\n":
                    cache[str(path)] = dict(inode=info.st_ino, offset=end, state=state)
        if state == "Running" and time.time() - info.st_mtime > 600:
            return "Last seen"
        return state
    except OSError:
        return "Recent"


def sessions(root, cache_path):
    home = Path(os.environ.get("CODEX_HOME") or Path.home()/".codex").resolve()
    db_path = home/"state_5.sqlite"
    if not db_path.is_file():
        return []
    try:
        cache = json.loads(cache_path.read_text())
    except (OSError, ValueError):
        cache = {}
    rows = []
    projects = {str(p.resolve()) for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")}
    if not projects:
        return []
    placeholders = ",".join("?" for _ in projects)
    db = sqlite3.connect(db_path.as_uri()+"?mode=ro", uri=True, timeout=1)
    try:
        query = f"""SELECT id,cwd,coalesce(nullif(name,''),title),rollout_path FROM threads
                    WHERE archived=0 AND originator IN ('Codex Desktop','ChatGPT Desktop')
                    AND source IN ('vscode','appServer','cli') AND cwd IN ({placeholders})
                    ORDER BY updated_at DESC LIMIT 64"""
        for sid, cwd, name, rollout in db.execute(query, sorted(projects)):
            try:
                conversation = str(uuid.UUID(sid))
            except (ValueError, TypeError):
                continue
            path = Path(rollout or "").resolve()
            state = turn_state(path, cache) if home in path.parents else "Recent"
            rows.append(dict(id=conversation, conversation=conversation, source="desktop", folder=cwd,
                             task=(name or Path(cwd).name).splitlines()[0][:112], agent="codex", state=state))
    finally:
        db.close()
    try:
        temp = cache_path.with_suffix(".tmp")
        temp.write_text(json.dumps(cache))
        temp.replace(cache_path)
    except OSError:
        pass
    return rows
