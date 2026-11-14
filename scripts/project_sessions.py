"""Share the native discovery scan with session-scoped MCP clients."""
import time
import uuid
from pathlib import Path

from visible_session import endpoint, load, save


CACHE_NAME = "active-project-sessions.json"
ACTIVE = {"Running", "Needs input", "Awaiting agent"}


def save_project_activity(runs, rows):
    entries = []
    for row in rows:
        if (row.get("owned") == "yes" and row.get("available") == "yes"
                and row.get("scratch") != "yes" and row.get("state") in ACTIVE):
            entries.append({"session": row["id"], "folder": row["folder"], "agent": row["agent"],
                            "task": " ".join(row["task"].split())[:112], "state": row["state"]})
    cache = runs / CACHE_NAME
    if entries:
        save(cache, entries)
    else:
        cache.unlink(missing_ok=True)


def project_activity(folder, session, agent, workspace):
    if folder.name != session or str(uuid.UUID(session)) != session.lower():
        raise ValueError("Unknown Tasktap session.")
    first = next(iter(sorted(folder.glob("*.job"))), None)
    if first is None:
        raise ValueError("Session handoff is missing.")
    owner = load(first)
    if (owner.get("mode") != "ask" or owner.get("delivery") != "interactive"
            or (owner.get("session"), owner.get("agent"), owner.get("folder")) != (session, agent, workspace)):
        raise ValueError("Session handoff does not match.")
    project = Path(workspace).resolve(strict=True)
    runs = folder.parent
    if project == (runs.parent / "Scratch").resolve():
        return []
    cache = runs / CACHE_NAME
    try:
        # Discovery normally refreshes every eight seconds. Discard its observations
        # if the workspace app has stopped polling or gone to sleep.
        observed = cache.stat().st_mtime
        if not 0 <= time.time() - observed < 60:
            return []
        entries = load(cache)
    except FileNotFoundError:
        return []
    peers = []
    for row in entries:
        try:
            peer = str(uuid.UUID(row["session"]))
            if (peer == session.lower() or row["state"] not in ACTIVE
                    or Path(row["folder"]).resolve() != project):
                continue
            peer_folder = runs / row["session"]
            # A process can exit or report a result between two native scans.
            endpoint(peer_folder)
            latest = max(peer_folder.glob("*.job")).with_suffix(".receipt")
            # A later scan can observe a fresh turn typed directly in the same
            # terminal, even after the last Tasktap handoff was completed.
            if latest.exists() and latest.stat().st_mtime >= observed and load(latest).get("state") == "Complete":
                continue
            peers.append({k: row[k] for k in ("agent", "task", "state")})
        except (KeyError, OSError, ValueError, TypeError):
            continue
    return peers
