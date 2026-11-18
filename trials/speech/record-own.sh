#!/bin/bash
# trials/speech/record-own.sh [folder]: records the trial's sentences in a person's own voice, one at a time, so
# the engines can be scored on a real voice with score.py as they were on the system's voices. It shows a sentence,
# records from the default microphone between two presses of Return, and keeps it as <id>.own.wav (16 kHz, mono,
# 16-bit). After the sentences come a few thoughts said freely, kept in free/: nothing to score them against, so
# what each engine heard is read side by side. Run again, it goes on where it stopped.
#
# The recordings go to ~/tasktap-voice-samples unless a folder is named: outside the repository, never committed.
# Needs ffmpeg. MIC=<name or number> picks another microphone (ffmpeg -f avfoundation -list_devices true -i "").
set -u
here="$(cd "$(dirname "$0")" && pwd)"
to="${1:-$HOME/tasktap-voice-samples}"
command -v ffmpeg >/dev/null || { echo "This needs ffmpeg: brew install ffmpeg"; exit 1; }
mkdir -p "$to/free"
list="$(mktemp)"
pid=
trap '[ -n "$pid" ] && kill "$pid" 2>/dev/null; rm -f "$list" "$list.err"' EXIT

python3 -c 'import json, re, sys
for s in json.load(open(sys.argv[1])):
    print(s["id"] + ".own.wav\tRead it the way you would say it, not carefully.\t" + re.sub(r"[{}]", "", s["say"]))' "$here/sentences.json" > "$list"
free="Say it freely, in your own words. Nothing to read."
{
  printf 'free/free-1.own.wav\t%s\t%s\n' "$free" "German, about half a minute: a bug you would hand to an agent, English terms and all."
  printf 'free/free-2.own.wav\t%s\t%s\n' "$free" "English, about half a minute: the same kind of thought."
  printf 'free/free-3.own.wav\t%s\t%s\n' "$free" "Start in German, change to English halfway, end in German."
  printf 'free/free-4.own.wav\t%s\t%s\n' "$free" "About a minute: think aloud about a feature, with pauses, an \"ähm\" or two, and one correction (\"nein, warte\")."
} >> "$list"

# One key: k is empty for Return. With nobody at the keys it stops.
key() { IFS= read -r -s -n 1 k || k=q; }

# Records to $1 until Return. Says so only once sound is arriving, so the first word is not lost.
record() {
  rm -f "$1"
  ffmpeg -nostdin -loglevel error -f avfoundation -i ":${MIC:-default}" -ac 1 -ar 16000 -c:a pcm_s16le -flush_packets 1 -y "$1" 2> "$list.err" &
  pid=$!
  for _ in $(seq 1 80); do
    [ "$(stat -f %z "$1" 2>/dev/null || echo 0)" -gt 1000 ] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if [ "$(stat -f %z "$1" 2>/dev/null || echo 0)" -le 1000 ]; then
    kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; pid=
    printf '\nThe microphone gave nothing. %s\n' "$(head -2 "$list.err")"
    echo "Allow it for this terminal in System Settings, Privacy & Security, Microphone, then run this again."
    return 1
  fi
  printf '\n\033[31m●\033[0m Recording. Speak, then press Return.\n'
  key
  sleep 0.3
  kill -TERM "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; pid=
  python3 -c 'import array, sys, wave
w = wave.open(sys.argv[1]); a = array.array("h", w.readframes(w.getnframes()))
loud = max(map(abs, a)) if a else 0
print("%.1f s kept%s" % (len(a) / w.getframerate(), "" if loud > 500 else ", but it is silent: check the microphone, then press r"))' "$1"
}

n=0
total=$(wc -l < "$list" | tr -d ' ')
while IFS=$'\t' read -r file what text <&3; do
  n=$((n + 1))
  [ -s "$to/$file" ] && continue
  while :; do
    printf '\033[2J\033[H%s of %s   %s\n\n\033[1m%s\033[0m\n\n' "$n" "$total" "$what" "$text"
    echo "Return: start recording    s: skip    q: stop here"
    key
    case "$k" in q) break 2 ;; s) continue 2 ;; esac
    record "$to/$file" || exit 1
    echo "Return: keep it and go on    r: say it again    q: keep it and stop here"
    key
    case "$k" in r) rm -f "$to/$file" ;; q) break 2 ;; *) break ;; esac
  done
done 3< "$list"
have=$(find "$to" -name '*.own.wav' | wc -l | tr -d ' ')
printf '\n%s of %s recorded, in %s\n' "$have" "$total" "$to"
[ "$have" -lt "$total" ] && echo "Run this again to go on where you stopped."
exit 0
