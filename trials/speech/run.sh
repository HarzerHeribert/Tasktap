#!/bin/bash
# The whole trial: builds the tools, makes the recordings, fetches Whisper's model in both forms (627 MB and 574 MB,
# once) and scores every engine on every recording, the last as the app runs it: the app's own helper, fed as the
# host feeds it. Everything it makes goes into the folder given, none of it into the repository. (whisper.cpp's own
# command-line tool, whose numbers the design gives as "whole", is scored by whispercpp.py once it is built.)
#   trials/speech/run.sh <folder>
# Apple's German and English models must be installed by the system first: `<folder>/apple install speech de-DE`.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
to="${1:?a folder for the recordings, the model and the results}"
mkdir -p "$to/out"
swiftc -O -swift-version 5 -parse-as-library "$here/apple.swift" -o "$to/apple" 2>/dev/null
swift build -c release --package-path "$here/whisperkit" --scratch-path "$to/wk-build" >/dev/null
whisper="$to/wk-build/release/whisperkit-trial"
[ -d "$to/rec" ] || python3 "$here/recordings.py" "$to/rec"
python3 "$here/fetch.py" whisperkit "$to/models/whisperkit" >/dev/null
model="$to/models/whisperkit"
score() { name="$1"; only="$2"; shift 2; python3 "$here/score.py" "$to/rec" "$to/out/$name.json" --only "$only" -- "$@" > "$to/out/$name.txt" 2>&1; tail -12 "$to/out/$name.txt" | grep -E 'WER' | sed "s/^/$name  /"; }
german="de-,mix-,mixs-,ten-de,ten-mix,sixty-de,sixty-mix"
english="en-,ten-en,sixty-en"
score apple-speech-de "$german" "$to/apple" speech de-DE {wav} fast
score apple-speech-en "$english" "$to/apple" speech en-US {wav} fast
score apple-speech-both "" "$to/apple" speech de-DE,en-US {wav} fast
score apple-dictation-de "$german" "$to/apple" dictation de-DE {wav} fast
score apple-dictation-en "$english" "$to/apple" dictation en-US {wav} fast
score whisper-auto "" "$whisper" "$model/model" "$model/tokenizer" auto {wav}
score whisper-de "$german" "$whisper" "$model/model" "$model/tokenizer" de {wav}
score whisper-en "$english" "$whisper" "$model/model" "$model/tokenizer" en {wav}
"$here/../../host/scripts/build-speech.sh" >/dev/null 2>&1
python3 "$here/fetch.py" whispercpp "$to/models/wcpp" >/dev/null
helper="$(ls "$here"/../../host/binaries/tasktap-speech-* | head -1)"
# Both orders of the person's languages: the helper must write the same for either (design §8, "Languages").
score helper-de-en "" python3 "$here/helper.py" "$helper" "$to/models/wcpp/ggml-large-v3-turbo-q5_0.bin" de,en {wav} fast
score helper-en-de "" python3 "$here/helper.py" "$helper" "$to/models/wcpp/ggml-large-v3-turbo-q5_0.bin" en,de {wav} fast
