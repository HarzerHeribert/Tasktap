#!/usr/bin/env python3
"""Feeds every recording of a folder to one engine and scores what it heard.

    score.py <recordings> <out.json> [--only de-,mix-] -- <command ... {wav} ...>

The command is run once per recording with {wav} replaced, and must print lines of JSON, the last with "final" (the
transcript); "after" (milliseconds from the end of the audio to that transcript) and "mb" (peak memory) are kept when
they are there. Scored per language:

- word error rate: substitutions, insertions and deletions over the words of the sentence, case and punctuation
  aside, against the sentence as it was said or as a person would write it (`want`: "14" for "vierzehn",
  "settings.tsx" for "settings Punkt T S X"), whichever is nearer;
- terms: how many of the sentence's marked terms (tool names, code words, file names, numbers) are in the transcript
  as written, spaces, hyphens and case aside.
"""
import json, os, re, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))


def words(text: str) -> list[str]:
    text = re.sub(r"[,;!?\"„“”‚‘’'()]", " ", text.lower().replace("-", " "))
    return [w.strip(".:") for w in text.split() if w.strip(".:")]


def distance(a: list[str], b: list[str]) -> int:
    row = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        last, row[0] = row[0], i
        for j, y in enumerate(b, 1):
            last, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, last + (x != y))
    return row[-1]


def squash(text: str) -> str:
    return "".join(words(text))


def score(heard: str, sentences: list[dict]) -> dict:
    plain = lambda t: re.sub(r"[{}]", "", t)
    said, want = " ".join(plain(s["say"]) for s in sentences), " ".join(plain(s.get("want", s["say"])) for s in sentences)
    h = words(heard)
    errors, n = min((distance(h, words(r)), len(words(r))) for r in (said, want))
    terms = [t for s in sentences for t in s["terms"]]
    return {"errors": errors, "words": n, "terms": len(terms), "hit": sum(squash(t) in squash(heard) for t in terms),
            "missed": [t for t in terms if squash(t) not in squash(heard)]}


def main():
    cut = sys.argv.index("--")
    folder, out, command = sys.argv[1], sys.argv[2], sys.argv[cut + 1:]
    only = sys.argv[sys.argv.index("--only") + 1].split(",") if "--only" in sys.argv[:cut] else [""]
    sentences = json.load(open(os.path.join(HERE, "sentences.json")))
    by = {s["id"]: s for s in sentences}
    rows = []
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".wav") or not any(name.startswith(o) for o in only):
            continue
        rid, voice = name[:-4].split(".")
        kind, lang = rid.split("-") if rid.split("-")[0] in ("ten", "sixty") else ("one", rid.split("-")[0])
        # The spliced recordings (`mixs`) are the mixed sentences.
        ids = [f"{lang.rstrip('s')}-{i}" for i in range(1, 9)]
        ref = [by[rid.replace("mixs", "mix")]] if kind == "one" else [by[i] for i in (ids[:2] if kind == "ten" else ids + ids[:4])]
        t = time.time()
        run = subprocess.run([c.replace("{wav}", os.path.join(folder, name)) for c in command], capture_output=True, text=True)
        last = {}
        for line in run.stdout.splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if "final" in event or "error" in event:
                last = event
        heard = last.get("final", "")
        row = {"id": rid, "voice": voice, "lang": lang, "kind": kind, "heard": heard, "after": last.get("after"), "mb": last.get("mb"),
               "wall": round(time.time() - t, 2), "error": last.get("error"), **score(heard, ref)}
        rows.append(row)
        print(f"{name:26} {row['errors']:3}/{row['words']:<3} {row['hit']}/{row['terms']}  {heard[:150]}", flush=True)
    json.dump(rows, open(out, "w"), ensure_ascii=False, indent=1)
    print()
    for lang in ("de", "en", "mix", "mixs"):
        for kind in ("one", "ten", "sixty"):
            part = [r for r in rows if r["lang"] == lang and r["kind"] == kind]
            if not part:
                continue
            e, n, hit, terms = (sum(r[k] for r in part) for k in ("errors", "words", "hit", "terms"))
            after = sorted(r["after"] for r in part if r["after"] is not None)
            print(f"{lang:4} {kind:6} WER {100 * e / n:5.1f} %   terms {hit}/{terms}   after {after[len(after) // 2] if after else '-'} ms   "
                  f"peak {max((r['mb'] or 0) for r in part):.0f} MB")


if __name__ == "__main__":
    main()
