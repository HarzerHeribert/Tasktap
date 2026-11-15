"""Opt-in discovery must never touch provider stores during a managed-only scan."""
from contextlib import ExitStack, redirect_stdout
import fcntl
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from unittest.mock import Mock, patch
import uuid

import cmux_sessions
import desktop_sessions
import session_lifecycle
from visible_session import save


def forbidden(*args, **kwargs):
    raise AssertionError("A managed-only scan reached an external provider")


with tempfile.TemporaryDirectory(prefix="tasktap-discovery-") as temp, ExitStack() as stack:
    base=Path(temp).resolve(); root=base/"projects"; project=root/"Project"; project.mkdir(parents=True)
    extra=base/"Selected elsewhere"; extra.mkdir()
    ignored=base/"Not selected"; ignored.mkdir()
    runs=base/"Runs"; runs.mkdir()

    def owned(agent, confirmed=False, thread=False, host="tasktap"):
        folder=runs/str(uuid.uuid4());folder.mkdir()
        lock=stack.enter_context((folder/"surface.lock").open("wb"));fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        save(folder/"surface.json",{"open":True})
        job=dict(agent=agent,host=host,mode="ask",delivery="interactive",session=folder.name,folder=str(project),task="Reviewed task",instructions="Review",outgoing="Known prompt")
        save(folder/"1.job",job);save(folder/"1.receipt",{"state":"Opened"})
        if confirmed:(folder/"claude-turn-started").touch()
        if thread:
            save(folder/"thread.json",{"id":str(uuid.uuid4())})
            save(folder/"2.job",dict(job,mode="nudge"));save(folder/"2.receipt",{"state":"Delivered"})
        return folder

    pending=owned("claude");confirmed=owned("claude",confirmed=True);unbound=owned("codex");bound=owned("codex",thread=True)
    owned("claude",host="claude-desktop")
    # Force every external route to fail loudly, even if no actual provider is
    # installed. Only the app's run metadata and locks are legitimate here.
    with patch.dict(os.environ,{"TASKTAP_DISCOVER_EXTERNAL":"0"}), \
         patch.object(Path,"home",side_effect=forbidden), \
         patch.object(cmux_sessions.subprocess,"run",side_effect=forbidden), \
         patch.object(sqlite3,"connect",side_effect=forbidden), \
         patch.object(session_lifecycle,"recover_codex_followups",side_effect=forbidden), \
         patch.object(cmux_sessions,"approved_projects",side_effect=forbidden), \
         patch.object(desktop_sessions,"approved_projects",side_effect=forbidden):
        assert cmux_sessions.sessions(root)==[]
        assert cmux_sessions.claude_sessions(root)==[]
        assert desktop_sessions.sessions(root,base/"cache.json")==[]
        rows=list(cmux_sessions.owned_rows(root,runs,[]))
        assert len(rows)==5
        by_id={row["id"]:row for row in rows}
        assert by_id[pending.name]["state"]=="Connected" and by_id[pending.name]["startup"]=="pending"
        assert by_id[confirmed.name]["startup"]=="confirmed"
        assert not by_id[unbound.name]["conversation"]
        assert by_id[bound.name]["conversation"]
        output=io.StringIO()
        with patch("sys.argv",["cmux-sessions","list",str(root),str(base/"cache.json"),str(runs)]),redirect_stdout(output):
            cmux_sessions.main()
        assert len(json.loads(output.getvalue()))==5,"full list command keeps owned sessions without invoking providers"

    # A missing, false, or malformed opt-in never grants access.
    for value in ("", "0", "false", "true", "yes"):
        with patch.dict(os.environ,{"TASKTAP_DISCOVER_EXTERNAL":value}),patch.object(cmux_sessions.subprocess,"run",side_effect=forbidden):
            assert cmux_sessions.sessions(root)==[] and cmux_sessions.claude_sessions(root)==[]

    record=dict(agent="claude",cwd=str(extra),session_id=str(uuid.uuid4()),surface_id=str(uuid.uuid4()),stored_pid_exists=True,active_for_surface=True,title="Approved session")
    excluded=dict(record,cwd=str(ignored),session_id=str(uuid.uuid4()),surface_id=str(uuid.uuid4()))
    scope={"TASKTAP_DISCOVER_EXTERNAL":"1","TASKTAP_WORKSPACE_FOLDERS_JSON":json.dumps([str(project),str(extra)])}
    with patch.dict(os.environ,scope),patch.object(cmux_sessions,"cmux_cli",return_value="cmux"), \
         patch.object(cmux_sessions.subprocess,"run",return_value=Mock(stdout=json.dumps({"sessions":[record,excluded]}))), \
         patch.object(cmux_sessions,"excerpt",return_value=""):
        rows=cmux_sessions.sessions(root)
        assert len(rows)==1 and rows[0]["folder"]==str(extra),"explicitly selected folders are included; unselected folders are excluded"
    claude=[dict(cwd=str(extra),sessionId=str(uuid.uuid4()),name="Selected",state="working"),dict(cwd=str(ignored),id="excluded")]
    with patch.dict(os.environ,scope),patch.object(cmux_sessions.subprocess,"run",return_value=Mock(stdout=json.dumps(claude))):
        assert [row["folder"] for row in cmux_sessions.claude_sessions(root)]==[str(extra)]

    # Test actual read-only SQLite discovery against a synthetic provider store.
    codex=base/"fixture-codex";codex.mkdir()
    with sqlite3.connect(codex/"state_5.sqlite") as db:
        db.execute("CREATE TABLE threads (id TEXT,cwd TEXT,name TEXT,title TEXT,rollout_path TEXT,originator TEXT,archived INTEGER,source TEXT,updated_at INTEGER)")
        for folder in (extra,ignored):
            db.execute("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?)",(str(uuid.uuid4()),str(folder),"Synthetic title","", "","Codex Desktop",0,"appServer",1))
    with patch.dict(os.environ,{**scope,"CODEX_HOME":str(codex)}):
        assert [row["folder"] for row in desktop_sessions.sessions(root,None)]==[str(extra)]
    for invalid in ("invalid", "{}", '"/tmp"', "[]"):
        with patch.dict(os.environ,{**scope,"TASKTAP_WORKSPACE_FOLDERS_JSON":invalid}),patch.object(cmux_sessions.subprocess,"run",side_effect=forbidden),patch.object(sqlite3,"connect",side_effect=forbidden):
            assert cmux_sessions.sessions(root)==[] and cmux_sessions.claude_sessions(root)==[] and desktop_sessions.sessions(root,None)==[]

print("Session discovery passed: default-off provider access, managed rows preserved, explicit opt-in, exact approved folders, and malformed scope fails closed.")
