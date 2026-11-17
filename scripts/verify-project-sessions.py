"""Exercise the session-scoped MCP interface with real presenter locks and receipt changes."""
from contextlib import ExitStack
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

from project_sessions import CACHE_NAME, save_project_activity
from visible_session import save


def verify(base):
    runs = base / "Runs"
    runs.mkdir()
    project = base / "Show"
    project.mkdir()
    other = base / "Other"
    other.mkdir()
    scratch = base / "Scratch"
    scratch.mkdir()

    def create(stack, checkout, state=None):
        folder = runs / str(uuid.uuid4())
        folder.mkdir()
        lock = stack.enter_context((folder / "surface.lock").open("wb"))
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        save(folder / "surface.json", {"open": True})
        job = folder / "1-test.job"
        save(job, dict(agent="claude", session=folder.name, folder=str(checkout), mode="ask", delivery="interactive",
                       task="design " * 24, observer=state is not None))
        save(job.with_suffix(".receipt"), {"state": "Opened"})
        if state:
            save(folder / "observer.json", {"state": state})
        return folder, lock

    def discover():
        # The same scan the app runs for its session list.
        runner = Path(__file__).resolve().with_name("run-agent")
        subprocess.run([str(runner), "rows", str(runs)], check=True, capture_output=True)

    def start_server(stack, owner, checkout):
        bridge = Path(__file__).resolve().with_name("agent-tools")
        server = stack.enter_context(subprocess.Popen(
            [str(bridge), "--workspace", str(checkout), "--session", owner.name, "--agent", "claude", "--run-dir", str(owner)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True))
        stack.callback(server.stdin.close)

        def call(method, params):
            server.stdin.write(json.dumps(dict(jsonrpc="2.0", id=1, method=method, params=params)) + "\n")
            server.stdin.flush()
            return json.loads(server.stdout.readline())["result"]
        tools = call("tools/list", {})["tools"]
        assert any(t["name"] == "list_project_sessions" and t["annotations"]["readOnlyHint"] for t in tools)
        return call

    def snapshot(call):
        result = call("tools/call", {"name":"list_project_sessions", "arguments":{}})
        return json.loads(result["content"][0]["text"])

    with ExitStack() as stack:
        owner, _ = create(stack, project, "working")
        call = start_server(stack, owner, project)
        assert snapshot(call) == {"sessions":[], "total":0}
        alias = base / "alias"
        alias.symlink_to(project)
        worker, lock = create(stack, alias, "working")
        create(stack, other, "working")
        create(stack, project, "ready")
        create(stack, project)
        scratch_owner, _ = create(stack, scratch, "working")
        discover()
        peers = snapshot(call)
        assert peers["total"] == 1
        peer = peers["sessions"][0]
        assert set(peer) == {"state","agent","task"} and peer["state"] == "Running" and len(peer["task"]) == 112
        assert snapshot(start_server(stack, scratch_owner, scratch))["total"] == 0
        assert call("tools/call", {"name":"list_project_sessions","arguments":{"folder":str(other)}})["isError"]
        receipt = worker / "1-test.receipt"
        save(receipt, {"state":"Complete"})
        assert snapshot(call)["total"] == 0
        past = time.time() - 2
        os.utime(receipt, (past, past))
        discover()  # a fresh provider-observed manual turn
        assert snapshot(call)["total"] == 1
        past = time.time() - 120
        os.utime(runs / CACHE_NAME, (past, past))
        assert snapshot(call)["total"] == 0
        discover()
        lock.close()  # stale surface.json after presenter death
        assert snapshot(call)["total"] == 0
        save_project_activity(runs, [])
        assert not (runs / CACHE_NAME).exists()


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as folder:
        verify(Path(folder))
    print("Project session MCP checks passed.")
