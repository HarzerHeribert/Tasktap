#!/usr/bin/env python3
"""Makes the recordings the speech trial and the smoke check are fed: every sentence of sentences.json said by two of
the Mac's own voices into a file (never aloud, never a microphone), as 16 kHz mono 16-bit WAV with a header of 44
bytes, which is what a dictation is on its way to an engine (design §8). Each language also gets two longer ones for
the time measures: `ten`, its first two sentences (about ten seconds), and `sixty`, its eight sentences and the first
four again (about a minute).

    recordings.py <folder> [id ...]   # writes <folder>/<id>.<voice>.wav, ten-<lang>.<voice>.wav, sixty-<lang>.<voice>.wav

A mixed sentence marks its English words with braces. It is recorded twice: as `mix`, all of it by the German voice,
which says the English words the German way ("Pulriquest"), worse than a German speaker does; and as `mixs`, spliced,
the marked words by an English voice (for Sandy the same voice in English), which has the right sounds and joins no
person makes. A person's mixed speech lies between the two.

Synthetic speech is easier than a person's: no room, no breath, no restarts, one even pace. What is measured on it
is an upper bound, and a ranking of engines, not what a person will get.
"""
import json, os, re, subprocess, sys, tempfile, wave

HERE = os.path.dirname(os.path.abspath(__file__))
# A natural voice and one of the plainer synthesiser voices per language, both shipped with macOS.
GERMAN = ["Anna", "Sandy (German (Germany))"]
VOICES = {"de": GERMAN, "mix": GERMAN, "mixs": GERMAN, "en": ["Samantha", "Daniel"]}
ENGLISH = {"Anna": "Samantha", "Sandy (German (Germany))": "Sandy (English (US))"}
RATE = 16000


def said(voice: str, text: str) -> bytes:
    """The samples of `text` in `voice`: 16 kHz, one channel, signed 16-bit little-endian."""
    with tempfile.TemporaryDirectory() as tmp:
        aiff, wav = os.path.join(tmp, "a.aiff"), os.path.join(tmp, "a.wav")
        subprocess.run(["say", "-v", voice, "-o", aiff, text], check=True)
        subprocess.run(["afconvert", "-f", "WAVE", "-d", f"LEI16@{RATE}", "-c", "1", aiff, wav], check=True)
        with wave.open(wav, "rb") as w:
            assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (RATE, 1, 2)
            return w.readframes(w.getnframes())


def trimmed(samples: bytes, keep: float = 0.03) -> bytes:
    """Without the silence a voice puts before and after what it says, but for `keep` seconds."""
    loud = [i for i in range(0, len(samples) - 1, 2) if abs(int.from_bytes(samples[i:i + 2], "little", signed=True)) > 300]
    pad = 2 * int(RATE * keep)
    return samples[max(0, loud[0] - pad):loud[-1] + 2 + pad] if loud else b""


def spliced(voice: str, text: str) -> bytes:
    """`text` with its {marked} words said by the English voice that goes with `voice`."""
    parts = [p for p in re.split(r"(\{[^}]*\})", text) if p.strip(" .,?")]
    return b"".join(trimmed(said(ENGLISH[voice], p[1:-1]) if p.startswith("{") else said(voice, p)) for p in parts)


def write(path: str, samples: bytes):
    with wave.open(path, "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(RATE)
        w.writeframes(samples)


def main(folder: str, only: set[str]):
    os.makedirs(folder, exist_ok=True)
    sentences = json.load(open(os.path.join(HERE, "sentences.json")))
    pause = bytes(2 * int(RATE * 0.4))
    for lang, voices in VOICES.items():
        for voice in voices:
            name, long = voice.split(" ")[0].lower(), []
            for s in (s for s in sentences if s["lang"] == lang.rstrip("s")):
                rid = s["id"].replace("mix-", lang + "-")
                if only and rid not in only:
                    continue
                samples = spliced(voice, s["say"]) if lang == "mixs" else said(voice, re.sub(r"[{}]", "", s["say"]))
                write(os.path.join(folder, f"{rid}.{name}.wav"), samples)
                long.append(samples)
            if long and not only:
                write(os.path.join(folder, f"ten-{lang}.{name}.wav"), pause.join(long[:2]))
                write(os.path.join(folder, f"sixty-{lang}.{name}.wav"), pause.join(long + long[:4]))
    print(f"{len(os.listdir(folder))} recordings in {folder}")


if __name__ == "__main__":
    main(sys.argv[1], set(sys.argv[2:]))
