"""Documented Claude Desktop Code composer handoff; never claims execution."""
from urllib.parse import urlencode
import subprocess


def brief_url(job):
    if job.get("agent") != "claude" or job.get("mode") != "ask":
        raise ValueError("Claude Desktop accepts new Claude Code briefs only.")
    prompt = job["outgoing"]
    if len(prompt) > 14000:
        raise ValueError("The Claude Desktop brief exceeds 14,000 characters. Shorten it or choose a terminal host.")
    return "claude://code/new?" + urlencode({"q": prompt, "folder": job["folder"]})


def open_brief(job):
    subprocess.run(["/usr/bin/open", brief_url(job)], check=True, capture_output=True, timeout=15)


def prepare(path, job):
    from visible_session import save
    open_brief(job)
    save(path.parent / "surface.json", {"host": "claude-desktop", "open": False})
    save(path.with_suffix(".receipt"), {"state": "Prepared", "message":
         "Brief prepared in Claude Desktop. Confirm the folder and send it there; activity and replies stay in Claude."})
