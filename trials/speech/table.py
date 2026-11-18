#!/usr/bin/env python3
"""Prints the trial's results as one table from the files score.py wrote: per engine and kind of sentence, the word
error rate over both voices, over the natural voice alone (Anna for German, Samantha and Daniel for English), and the
terms written right.

    table.py <folder>/out
"""
import json, os, sys

RUNS = [("the system's SpeechTranscriber", ["apple-speech-de", "apple-speech-en"]), ("the same, German and English listening at once", ["apple-speech-both"]),
        ("the system's DictationTranscriber", ["apple-dictation-de", "apple-dictation-en"]), ("WhisperKit, language told", ["whisper-de", "whisper-en"]),
        ("WhisperKit, language detected", ["whisper-auto"]), ("whisper.cpp, whole recording", ["wcpp-de", "wcpp-en"]), ("the app's helper (whisper.cpp), German then English", ["helper-de-en"]),
        ("the app's helper, English then German", ["helper-en-de"])]
NATURAL = {"anna", "samantha", "daniel"}


def rate(rows):
    return f"{100 * sum(r['errors'] for r in rows) / max(1, sum(r['words'] for r in rows)):5.1f}"


folder = sys.argv[1]
print(f"{'':52} {'German':>18} {'English':>18} {'mixed':>18} {'mixed, spliced':>18}   sixty: de en mix mixs")
for name, files in RUNS:
    rows = [r for f in files if os.path.exists(os.path.join(folder, f + ".json")) for r in json.load(open(os.path.join(folder, f + ".json")))]
    if not rows:
        continue
    cells = []
    for lang in ("de", "en", "mix", "mixs"):
        one = [r for r in rows if r["lang"] == lang and r["kind"] == "one"]
        natural = [r for r in one if r["voice"] in NATURAL]
        cells.append(f"{rate(one)} ({rate(natural).strip()}) {sum(r['hit'] for r in one):>2}/{sum(r['terms'] for r in one)}" if one else "-")
    long = " ".join(rate([r for r in rows if r["lang"] == lang and r["kind"] == "sixty"]).strip() if any(r["lang"] == lang and r["kind"] == "sixty" for r in rows) else "-" for lang in ("de", "en", "mix", "mixs"))
    print(f"{name:52} " + " ".join(f"{c:>18}" for c in cells) + "   " + long)
