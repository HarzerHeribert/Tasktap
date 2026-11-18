#!/usr/bin/env python3
# A speech helper of the checks' own, in place of tasktap-speech (host/speech/engine.cpp), speaking its protocol: the
# model's path and the languages as arguments, the recording on standard input, one JSON object a line out. It says it
# is ready, says the first words of $SPEECH_FIXTURE_SAYS's file once it has heard a second, and when the recording ends
# all of them; and it notes in $SPEECH_FIXTURE_LOG what it was given: the languages, the recording's length in
# seconds, its loudest sample and the pitch its zero crossings give. A model whose file begins "damaged" it refuses.
import json, os, sys

model, languages = sys.argv[1], sys.argv[2:]
say = lambda **line: print(json.dumps(line), flush=True)
if open(model, "rb").read(7) == b"damaged":
    say(error="model")
    sys.exit(3)
say(ready=True)
words = open(os.environ["SPEECH_FIXTURE_SAYS"]).read().strip()
pcm, told = b"", False
while chunk := sys.stdin.buffer.read1(6400):
    pcm += chunk
    if not told and len(pcm) >= 32000:
        told = True
        say(partial=" ".join(words.split()[:3]))
s = [int.from_bytes(pcm[i:i + 2], "little", signed=True) for i in range(0, len(pcm) - 1, 2)]
crossings = sum(1 for a, b in zip(s, s[1:]) if (a < 0) != (b < 0))
seconds = len(s) / 16000
with open(os.environ["SPEECH_FIXTURE_LOG"], "a") as log:
    log.write(f"{','.join(languages) or '-'} {seconds:.2f} {max(map(abs, s), default=0)} {crossings / 2 / max(seconds, 0.001):.0f}\n")
say(final=words)
