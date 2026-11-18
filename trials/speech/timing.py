#!/usr/bin/env python3
"""Times one engine on one recording, three runs, with nothing else of the trial running.

    timing.py [--also <process name>] -- <command ...>

Prints, per run, what the command reported ("after": milliseconds from the end of the audio to the transcript, "load")
and the most memory it held: the process's own peak footprint as /usr/bin/time -l measures it, and with --also the
largest footprint of the newest process of that name while the command ran (Apple's recognition runs in a service of
the system, localspeechrecognition, started for the client and gone with it), sampled twice a second with `footprint`.
"""
import json, re, subprocess, sys, threading, time

cut = sys.argv.index("--")
also = sys.argv[sys.argv.index("--also") + 1] if "--also" in sys.argv[:cut] else None
command = sys.argv[cut + 1:]


def newest(name: str, since: set[str]) -> str | None:
    pids = subprocess.run(["pgrep", "-n", name], capture_output=True, text=True).stdout.split()
    return pids[0] if pids and pids[0] not in since else None


def footprint(pid: str) -> float:
    out = subprocess.run(["footprint", "-p", pid], capture_output=True, text=True).stdout
    m = re.search(r"Footprint:\s*([\d.]+)\s*(KB|MB|GB)", out) or re.search(r"phys_footprint:\s*([\d.]+)\s*(KB|MB|GB)", out)
    return float(m.group(1)) * {"KB": 1 / 1024, "MB": 1, "GB": 1024}[m.group(2)] if m else 0


for run in range(3):
    before = set(subprocess.run(["pgrep", also], capture_output=True, text=True).stdout.split()) if also else set()
    peak, done = [0.0], threading.Event()

    def watch():
        while not done.wait(0.5):
            if pid := newest(also, before):
                peak[0] = max(peak[0], footprint(pid))

    if also:
        threading.Thread(target=watch, daemon=True).start()
    t = time.time()
    out = subprocess.run(["/usr/bin/time", "-l", *command], capture_output=True, text=True)
    done.set()
    last = {}
    for line in out.stdout.splitlines():
        try:
            e = json.loads(line)
            if "final" in e or "error" in e:
                last = e
        except ValueError:
            pass
    own = re.search(r"(\d+)\s+peak memory footprint", out.stderr)
    print(json.dumps({"run": run + 1, "after": last.get("after"), "load": last.get("load"), "wall": round(1000 * (time.time() - t)),
                      "own_mb": round(int(own.group(1)) / 1048576) if own else None, **({"service_mb": round(peak[0])} if also else {}),
                      "words": len(last.get("final", "").split()), "error": last.get("error")}), flush=True)
