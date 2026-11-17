"""The session list reads only Tasktap's own run folders and never touches provider stores."""
from contextlib import ExitStack, redirect_stdout
import fcntl
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
from unittest.mock import patch
import uuid

import session_rows
from visible_session import save


def forbidden(*args, **kwargs):
    raise AssertionError("The session list reached an external provider")


with tempfile.TemporaryDirectory(prefix="tasktap-rows-") as temp, ExitStack() as stack:
    base=Path(temp).resolve(); project=base/"projects"/"Project"; project.mkdir(parents=True)
    runs=base/"Runs"; runs.mkdir()

    def owned(agent, confirmed=False, thread=False):
        folder=runs/str(uuid.uuid4());folder.mkdir()
        lock=stack.enter_context((folder/"surface.lock").open("wb"));fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        save(folder/"surface.json",{"open":True})
        job=dict(agent=agent,mode="ask",delivery="interactive",session=folder.name,folder=str(project),task="Reviewed task",instructions="Review",outgoing="Known prompt")
        save(folder/"1.job",job);save(folder/"1.receipt",{"state":"Opened"})
        if confirmed:(folder/"claude-turn-started").touch()
        if thread:
            save(folder/"thread.json",{"id":str(uuid.uuid4())})
            save(folder/"2.job",dict(job,mode="nudge"));save(folder/"2.receipt",{"state":"Delivered"})
        return folder

    pending=owned("claude");confirmed=owned("claude",confirmed=True);unbound=owned("codex");bound=owned("codex",thread=True)
    # Only the app's run metadata and locks are legitimate here.
    with patch.object(Path,"home",side_effect=forbidden), \
         patch.object(subprocess,"run",side_effect=forbidden), \
         patch.object(sqlite3,"connect",side_effect=forbidden):
        rows=session_rows.rows(runs)
        assert len(rows)==4
        by_id={row["id"]:row for row in rows}
        assert by_id[pending.name]["state"]=="Connected" and by_id[pending.name]["startup"]=="pending"
        assert by_id[confirmed.name]["startup"]=="confirmed"
        assert not by_id[unbound.name]["conversation"] and by_id[unbound.name]["inbox"]=="manual"
        assert by_id[bound.name]["conversation"] and by_id[bound.name]["inbox"]=="codex"

print("Session list passed: Tasktap sessions only, conversation binding from their own receipts, no provider access.")
