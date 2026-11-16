#!/usr/bin/env python3
"""Discover local cmux agent surfaces and address a follow-up to the same session."""
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import uuid
from session_activity import excerpt
from desktop_sessions import discovery_enabled, approved_projects

# Discovery runs from the signed app bundle as well as the source checkout.
sys.dont_write_bytecode = True


def cmux_cli():
    from cmux_host import installed
    return installed()[0]


def sessions(root, *, allow_external=None):
    if not discovery_enabled(allow_external):
        return []
    projects = approved_projects(root)
    if not projects:
        return []
    result = subprocess.run([cmux_cli(), "sessions", "--json"], capture_output=True, text=True, timeout=8, check=True)
    rows = []
    for record in json.loads(result.stdout).get("sessions", []):
        # Launch-backed sessions can have no hook-selected active session even
        # while their process and original pane still exist. Keep their host and
        # focus address; inbox delivery still requires an active registration.
        active = record.get("active_for_surface")
        launch = record.get("launch_backed") and not record.get("active_surface_session_id")
        if record.get("agent") not in ("claude", "codex") or not (active or launch) or not record.get("stored_pid_exists"):
            continue
        folder = Path(record.get("cwd") or "").resolve()
        if str(folder) not in projects:
            continue
        try:
            surface = str(uuid.UUID(record["surface_id"]))
            conversation = str(uuid.UUID(record["session_id"]))
        except (KeyError, TypeError, ValueError):
            continue
        task = record.get("title") or record.get("session_name") or ""
        # Only inspect the local conversation title or its first user prompt.
        transcript = Path(record.get("transcript_path") or "")
        if not task and transcript.is_file():
            try:
                with transcript.open(encoding="utf-8") as source:
                    for _ in range(18):
                        line = source.readline(65536)
                        if not line or not line.endswith("\n"):
                            break
                        item = json.loads(line)
                        prompt = item.get("customTitle")
                        if item.get("type") == "user":
                            prompt = (item.get("message") or {}).get("content")
                            if isinstance(prompt, list):
                                prompt = " ".join(part.get("text", "") for part in prompt if part.get("type") == "text")
                        if item.get("type") == "event_msg" and item.get("payload", {}).get("type") == "user_message":
                            prompt = item["payload"].get("message")
                        if isinstance(prompt, str) and prompt.strip() and not prompt.lstrip().startswith(("<", "#")):
                            task = " ".join(prompt.split())[:96]
                            break
            except (OSError, ValueError, UnicodeError):
                pass
        identifier = uuid.uuid5(uuid.NAMESPACE_URL, "cmux:"+surface+":"+conversation)
        rows.append(dict(id=str(identifier), surface=surface, conversation=conversation, agent=record["agent"],
                         folder=str(folder), host="cmux", workspace=record.get("workspace_id") or "",
                         inbox="cmux" if active else "manual",
                         task=task or folder.name+" · "+record["agent"], state="Connected", activity=excerpt(transcript)))
    return rows


def claude_sessions(root, *, allow_external=None):
    if not discovery_enabled(allow_external):
        return []
    projects = approved_projects(root)
    if not projects:
        return []
    result = subprocess.run(["claude", "agents", "--json"], capture_output=True, text=True,
                            stdin=subprocess.DEVNULL, timeout=5, check=True)
    rows = []
    for record in json.loads(result.stdout):
        if not isinstance(record, dict) or not record.get("cwd"):
            continue
        folder = Path(record["cwd"]).resolve()
        if str(folder) not in projects:
            continue
        # Interactive sessions can be visible before they receive a conversation ID.
        conversation = record.get("sessionId") or ""
        identity = conversation or record.get("id")
        if not identity and record.get("pid") and record.get("startedAt"):
            identity = f"{record['pid']}/{record['startedAt']}"
        if not identity:
            continue
        state = {"working":"Running", "blocked":"Needs input", "done":"Idle",
                 "failed":"Failed", "stopped":"Stopped"}.get(record.get("state"))
        if not state:
            state = {"busy":"Running", "waiting":"Needs input", "idle":"Idle"}.get(record.get("status"), "Connected")
        ident = uuid.uuid5(uuid.NAMESPACE_URL, f"tasktap/claude/{folder}/{identity}")
        rows.append(dict(id=str(ident), conversation=conversation, source="claude", folder=str(folder),
                         agent="claude", task=record.get("name") or folder.name+" · Claude Code", state=state,
                         waitingFor=record.get("waitingFor") or ""))
    return rows


def send_inbox(target, text):
    if target.get("inbox") == "manual":
        raise ValueError("Open the original cmux session to send this follow-up.")
    current = subprocess.run([cmux_cli(),"agent","message",target["surface"],"--from","Tasktap","--json","--","-"],
                             input=text, capture_output=True, text=True, timeout=15)
    if current.returncode:
        raise ValueError(current.stderr.strip() or "cmux could not accept the message.")
    return "Accepted by the agent’s cmux inbox."


def focus_external(job):
    if job['host']=='desktop':
        conversation=str(uuid.UUID(job['session']))
        subprocess.run(['/usr/bin/open','codex://threads/'+conversation],check=True,capture_output=True,timeout=10)
    else:
        from visible_session import focus_cmux
        target=next((r for r in sessions(Path(job['folder']).parent,allow_external=True) if r['id']==job['session'] and r['folder']==job['folder'] and r['agent']==job['agent']),None)
        if not target:raise ValueError('The cmux session is no longer available.')
        focus_cmux(target)


def deliver(job):
    if job.get("host")=="desktop":
        from desktop_sessions import sessions as indexed
        # Refresh ownership at delivery time. Never use --resume to wake a background worker.
        desktop=next((r for r in indexed(Path(job["folder"]).parent, None,allow_external=True)
                      if r["id"]==job["session"] and r["source"]=="desktop" and r["folder"]==job["folder"]),None)
        if not desktop:
            raise ValueError("This chat is no longer available in ChatGPT.")
        subprocess.run(["codex","queue","--thread",desktop["conversation"],"--message",job["outgoing"]],
                       cwd=job["folder"],check=True,capture_output=True,timeout=15)
        return "Accepted by the original Codex thread’s queue."

    root = Path(job["folder"]).parent.resolve()
    target = next((r for r in sessions(root,allow_external=True) if r["id"] == job["session"] and r["folder"] == job["folder"] and r["agent"] == job["agent"]), None)
    if not target:
        raise ValueError("This cmux conversation is no longer active.")
    return send_inbox(target,job["brief"])


def claude_turn_started(folder, job, *, allow_external=None):
    # A TTY and a Claude process both exist while the folder-trust dialog is up.
    # Confirm the exact conversation's first assistant turn, including after an app restart.
    import os
    marker=folder/"claude-turn-started"
    if marker.is_file():
        return True
    if not discovery_enabled(allow_external):
        return False
    config=Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home()/".claude")
    session=str(uuid.UUID(job["session"]))
    for transcript in (config/"projects").glob("*/"+session+".jsonl"):
        try:
            with transcript.open("rb") as source:
                for _ in range(128):
                    line=source.readline(262144)
                    if not line or not line.endswith(b"\n"):
                        break
                    if b'"assistant"' not in line:
                        continue
                    event=json.loads(line)
                    if (event.get("type")=="assistant" and event.get("sessionId")==session
                        and event.get("cwd")==job["folder"] and event.get("message",{}).get("model") not in (None,"","<synthetic>")):
                        marker.touch(mode=0o600)
                        return True
        except (OSError, ValueError, AttributeError):
            continue
    return False


def owned_rows(root, runs, observed, *, allow_external=None):
    import visible_session as visible
    import os
    discover=discovery_enabled(allow_external)
    for folder in runs.iterdir():
        surface_path=folder/"surface.json"
        if not surface_path.exists(): continue
        try:
            surface=visible.load(surface_path)
            jobs=sorted(folder.glob("*.job"))
            path=next(p for p in jobs if visible.load(p)["mode"]=="ask")
            job=visible.load(path)
            row=dict(id=job["session"],agent=job["agent"],host=job["host"],folder=job["folder"],owned="yes",source="interactive",
                     task=job["task"],inbox="manual",state="Connected",available="yes",scratch="yes" if Path(job["folder"])==runs.parent/"Scratch" else "no")
            if job.get("host") == "claude-desktop":
                row.update(state="Ready to send", available="yes", startup="pending", inbox="manual")
                yield row
                continue
            alive=surface.get("open") and visible.locked(folder)
            if not alive:
                row.update(state="Closed",available="no")
            thread=job["session"] if job["agent"]=="claude" else ""
            thread_file=folder/"thread.json"
            if discover and job["agent"]=="codex" and alive and not thread_file.exists():
                try:
                    home=Path(os.environ.get("CODEX_HOME") or Path.home()/".codex")
                    with sqlite3.connect((home/"state_5.sqlite").as_uri()+"?mode=ro",uri=True,timeout=0.5) as db:
                        # Bind only the unique first user message for this reviewed launch, never a recently active project.
                        legacy_prompt=job["instructions"]+"\n\n"+job["outgoing"]
                        matches=db.execute("SELECT id FROM threads WHERE cwd=? AND source='cli' AND first_user_message IN (?,?) LIMIT 2",
                                           (job["folder"],visible.codex_prompt(job),legacy_prompt)).fetchall()
                    if len(matches)==1:visible.save(thread_file,{"id":str(uuid.UUID(matches[0][0]))})
                except (OSError,ValueError,sqlite3.Error): pass
            if thread_file.exists(): thread=str(uuid.UUID(visible.load(thread_file)["id"]))
            row["conversation"]=thread
            if not alive and visible.resume_id(folder, job):
                row["resumable"]="yes"
            latest = jobs[-1]
            receipt = latest.with_suffix(".receipt")
            if discover and len(jobs)>1 and thread and job["agent"]=="codex":
                from session_lifecycle import recover_codex_followups
                try: recover_codex_followups(folder,job,jobs)
                except (OSError, sqlite3.Error, KeyError, TypeError, ValueError): pass
            row["updatedAt"] = str(int(max(latest.stat().st_mtime, receipt.stat().st_mtime if receipt.exists() else 0)*1000))
            if not alive and receipt.is_file() and visible.load(receipt).get("state")=="Complete":
                row["state"]="Complete"
            sibling=next((r for r in observed if r.get("conversation")==thread and thread and r["agent"]==row["agent"] and r["folder"]==row["folder"]),None)
            if sibling:
                if sibling.get("activity"): row["activity"] = sibling["activity"]
                if alive: row["state"]=sibling["state"]
                if alive and isinstance(sibling.get("waitingFor"),str):row["waitingFor"]=sibling["waitingFor"]
                if sibling.get("surface")==surface.get("surface") and surface.get("surface") and sibling.get("inbox")!="manual" and job["agent"]=="claude": row["inbox"]="cmux"
            if alive and job["agent"]=="claude":
                confirmed=claude_turn_started(folder,job,allow_external=discover) or (path.with_suffix(".receipt").is_file() and visible.load(path.with_suffix(".receipt")).get("state")=="Complete")
                row["startup"]="confirmed" if confirmed else "pending"
                # With discovery disabled, process presence is all we know.
                # Do not mislabel a running terminal as stuck at a trust prompt.
                if discover and not confirmed and row["state"]!="Needs input":row["state"]="Awaiting agent"
            if thread and job["agent"]=="codex":row["inbox"]="codex"
            if job.get('observer') is True and job.get('host') == 'tasktap':
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
            yield row
        except (OSError,ValueError,KeyError,StopIteration):continue


def main():
    if sys.argv[1] == "list":
        from desktop_sessions import sessions as desktop_sessions
        root = Path(sys.argv[2]).resolve()
        try:
            rows = sessions(root)
        except (OSError, ValueError, subprocess.SubprocessError):
            rows = []
        try:
            observed = claude_sessions(root)
        except (OSError, ValueError, subprocess.SubprocessError):
            observed = []
        if len(sys.argv) > 3:
            try:
                observed.extend(desktop_sessions(root, Path(sys.argv[3])))
            except (OSError, ValueError, sqlite3.Error):
                pass
        # Retain cmux's address for nudges while using the provider's turn state.
        surfaces = {(r["agent"], r["conversation"]):r for r in rows}
        for item in observed:
            surface = surfaces.get((item["agent"], item["conversation"]))
            if surface:
                surface["task"] = item["task"]
                surface["state"] = item["state"]
                surface["waitingFor"] = item.get("waitingFor", "")
                if item.get("activity"): surface["activity"] = item["activity"]
            else:
                rows.append(item)
        if len(sys.argv)>4 and Path(sys.argv[4]).is_dir():
            from project_sessions import save_project_activity
            runs = Path(sys.argv[4])
            owned=list(owned_rows(root,runs,rows))
            try:
                save_project_activity(runs, owned)
            except OSError:
                pass
            handled={(r["agent"],r["conversation"]) for r in owned if r.get("conversation")}
            rows=[r for r in rows if (r["agent"],r["conversation"]) not in handled]+owned
        print(json.dumps(rows))
    elif sys.argv[1]=="focus":
        import visible_session
        try:
            target=next(r for r in sessions(Path(sys.argv[2]).resolve(),allow_external=True) if r["id"]==sys.argv[3])
            visible_session.focus_cmux(target)
        except (OSError,ValueError,StopIteration,subprocess.SubprocessError):
            sys.exit("This cmux agent surface is no longer available.")
    else:
        try:
            print(deliver(json.load(sys.stdin)))
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            sys.exit(str(exc))
