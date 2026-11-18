#!/usr/bin/env python3
"""Feeds a recording to the app's own speech helper (host/speech/engine.cpp) the way the host does, a tenth of a
second at a time at the pace of speech (or `fast`), and prints what score.py and timing.py read.

    helper.py <tasktap-speech> <model.bin> <languages, comma separated, or -> <file.wav> [fast]

"after" is the time from the end of the audio to the transcript; "partials" are the moments, in seconds of speech,
at which the transcript so far grew; "ready" is how long the model took to load.
"""
import json, subprocess, sys, threading, time, wave

exe, model, languages, path = sys.argv[1:5]
fast = sys.argv[5:] == ["fast"]
with wave.open(path, "rb") as w:
    samples = w.readframes(w.getnframes())
t0 = time.time()
engine = subprocess.Popen(["/usr/bin/time", "-l", exe, model, *([] if languages == "-" else languages.split(","))], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
events, let_go = [], [0.0]


def read():
    for line in engine.stdout:
        events.append((time.time(), json.loads(line)))


reader = threading.Thread(target=read)
reader.start()
for at in range(0, len(samples), 3200):
    engine.stdin.write(samples[at:at + 3200])
    engine.stdin.flush()
    if not fast:
        time.sleep(max(0, t0 + (at + 3200) / 32000 - time.time()))
engine.stdin.close()
let_go = time.time()
reader.join()
err = engine.stderr.read().decode()
engine.wait()
final = next((e for _, e in events if "final" in e), None)
error = next((e["error"] for _, e in events if "error" in e), None)
ready = next((t for t, e in events if "ready" in e), t0)
peak = [int(line.split()[0]) for line in err.splitlines() if "peak memory footprint" in line]
print(json.dumps({"final": final["final"] if final else "", "after": round(1000 * (events[-1][0] - let_go)) if final else None, "ready": round(1000 * (ready - t0)),
                  "partials": [round(t - t0, 1) for t, e in events if "partial" in e], "seconds": round(len(samples) / 32000, 1),
                  "mb": round(peak[0] / 1048576) if peak else None, **({"error": error or err[-200:]} if not final else {})}, ensure_ascii=False))
