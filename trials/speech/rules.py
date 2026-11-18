#!/usr/bin/env python3
"""Scores rules for choosing the language of a stretch without running them: from what probe.cpp wrote for every
recording (each stretch's odds for German and English by window, and its transcript told either), it puts together
what each rule would have written and scores it as score.py does.

    for f in <recordings>/*.wav; do probe <model.bin> "$f" de en > <probes>/"$(basename "$f" .wav)".jsonl; done
    rules.py <probes>

The recordings are named as recordings.py names them; a person's own reading of a language's eight sentences in one
go is all-de.own.wav, all-mix.own.wav (design §8, "How the rule was found"). Per kind of recording and rule: the word
error rate, and how many stretches were written in the other language than the recording's with other words for it.
"""
import glob, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import score

LANGS = ("de", "en")
odds = lambda st, window, a, b: st[window][a] / max(st[window][b], 1e-12)
likelier = lambda st, window: max(LANGS, key=lambda l: st[window][l])


def before(first, second):
    """Until 2026-11-18: the first language unless the other is a thousand times as likely in the first three
    seconds, decided once."""
    return lambda sts: [second if odds(sts[0], "p3", second, first) > 1000 else first] * len(sts)


def window(w):
    """The likelier language of each stretch, by its first seconds (p0: by all of it)."""
    return lambda sts: [likelier(st, w) for st in sts]


def now(sts):
    """engine.cpp: the likelier language in a stretch's first four seconds; a shorter stretch as the one before it,
    the first by all of it."""
    out = []
    for st in sts:
        long = st["to"] - st["from"] - st["lead"] >= 4
        out.append(likelier(st, "p4") if long else out[-1] if out else likelier(st, "p0"))
    return out


RULES = {"before, de first": before("de", "en"), "before, en first": before("en", "de"), "told de": lambda sts: ["de"] * len(sts), "told en": lambda sts: ["en"] * len(sts),
         "2 s": window("p2"), "3 s": window("p3"), "4 s": window("p4"), "5 s": window("p5"), "all of it": window("p0"), "now": now}
by = {s["id"]: s for s in json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "sentences.json")))}
table = {}
for f in sorted(glob.glob(os.path.join(sys.argv[1], "*.jsonl"))):
    sts = [json.loads(line) for line in open(f)]
    rid, voice = os.path.basename(f)[:-6].split(".")
    kind, lang = rid.split("-") if rid.split("-")[0] in ("ten", "sixty", "all") else ("one", rid.split("-")[0])
    ids = [f"{lang.rstrip('s')}-{i}" for i in range(1, 9)]
    ref = [by[rid.replace("mixs", "mix")]] if kind == "one" else [by[i] for i in (ids[:2] if kind == "ten" else ids if kind == "all" else ids + ids[:4])]
    spoken = "en" if lang == "en" else "de"
    for name, rule in RULES.items():
        told = rule(sts) if sts else []
        cell = table.setdefault(f"{lang} {'natural' if voice in ('anna', 'samantha', 'daniel') else voice}", {}).setdefault(name, {"errors": 0, "words": 0, "turned": 0, "stretches": 0})
        r = score.score(" ".join(st[l].strip() for st, l in zip(sts, told)), ref)
        cell["errors"] += r["errors"]
        cell["words"] += r["words"]
        cell["stretches"] += len(sts)
        cell["turned"] += sum(1 for st, l in zip(sts, told) if l != spoken and score.words(st[l]) != score.words(st[spoken]))
print(f"{'':16}" + "".join(f"{name:>18}" for name in RULES))
for group in sorted(table):
    print(f"{group:16}" + "".join(f"{f'{100 * c['errors'] / max(1, c['words']):.1f}% {c['turned']}/{c['stretches']}':>18}" for c in table[group].values()))
