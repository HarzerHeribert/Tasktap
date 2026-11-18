#!/usr/bin/env python3
"""The trial of whisper.cpp: runs its own command-line tool on one recording and prints what score.py reads.

    whispercpp.py <whisper-cli> <ggml model> <language | auto> <file.wav>

whisper.cpp 1.9.5 built with Metal (cmake -DGGML_METAL=ON -DBUILD_SHARED_LIBS=OFF, target whisper-cli) and the model
ggml-large-v3-turbo-q5_0.bin (574 MB, SHA-256 394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2) from
huggingface.co/ggerganov/whisper.cpp. "after" is the whole run, since Whisper hears a recording whole: loading the
model, which could be done while the person speaks ("load"), and the rest.
"""
import json, re, subprocess, sys, time

cli, model, language, wav = sys.argv[1:5]
t = time.time()
run = subprocess.run(["/usr/bin/time", "-l", cli, "-m", model, "-l", language, "-f", wav, "-nt"], capture_output=True, text=True)
wall = round(1000 * (time.time() - t))
number = lambda pattern: float(m.group(1)) if (m := re.search(pattern, run.stderr)) else 0
load = number(r"load time =\s*([\d.]+) ms")
print(json.dumps({"final": " ".join(run.stdout.split()), "load": round(load), "after": round(max(wall - load, 0)), "wall": wall,
                  "mb": round(number(r"(\d+)\s+peak memory footprint") / 1048576, 1), "rss": round(number(r"(\d+)\s+maximum resident set size") / 1048576, 1),
                  **({"error": run.stderr[-300:]} if run.returncode else {})}, ensure_ascii=False))
