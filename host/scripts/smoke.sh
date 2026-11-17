#!/bin/bash
# host/scripts/smoke.sh: builds Tasktap Next with a core that has the fixture agent, runs it on a
# temporary data folder and drives it through its debug channel: capture, Undo, run, Peek, a
# question, affirm, the result. It never sends keys or clicks to the system: every step is a line
# on the app's standard input, and the app is passive (its windows never take the keyboard).
# Prints PASS or FAIL per promise; exits non-zero on any FAIL. SHOTS=<folder> also saves captures
# of the app's own windows (needs screen recording permission for the terminal).
set -u
host="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$host/.." && pwd)"
fails=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1${2:+: $2}"; fails=$((fails + 1)); }

echo "== Building the pages, the cores and the host"
(cd "$root/ui" && npm run --silent build >/dev/null) || { echo "FAIL  ui build"; exit 1; }
"$host/scripts/build-core.sh" >/dev/null && FIXTURES=1 "$host/scripts/build-core.sh" >/dev/null || { echo "FAIL  core build"; exit 1; }
cargo build --quiet --manifest-path "$host/Cargo.toml" || { echo "FAIL  host build"; exit 1; }

tmp="$(mktemp -d)"
log="$tmp/log"
mkdir -p "$tmp/agents" "$tmp/project"
ln "$host/binaries/fixtures/tasktap" "$tmp/agents/fixture-agent"
mkfifo "$tmp/in"
cleanup() {
  # Writing to the app's input once it has quit would end this script with SIGPIPE.
  trap '' PIPE
  kill -0 "$app" 2>/dev/null && echo quit >&3 && sleep 1
  kill "$app" 2>/dev/null
  # The core idles out a minute after its last client; this one is ours, so it goes now.
  pkill -f "$tmp/" 2>/dev/null
  sleep 1
  pkill -9 -f "$tmp/" 2>/dev/null
  if [ "$fails" = 0 ]; then rm -rf "$tmp"; else echo "The app's log is in $log"; fi
}
trap cleanup EXIT

env PATH="$tmp/agents:$PATH" TASKTAP_DEBUG=1 TASKTAP_PASSIVE=1 TASKTAP_DATA="$tmp/data" TASKTAP_PICK="$tmp/project" \
  TASKTAP_CORE_EXE="$host/binaries/fixtures/tasktap" TASKTAP_CORE_BUILD="$(cat "$host/binaries/fixtures/build.txt")" \
  "$host/target/debug/tasktap-next" < "$tmp/in" > "$log" 2>&1 &
app=$!
exec 3>"$tmp/in"

send() { for line in "$@"; do echo "$line" >&3; done; }
reports() { grep -c "\"event\":\"report\",\"label\":\"$1\"" "$log"; }
# The data of the next report from page $1 after sending it $2: `ask notch "text #notch-home"`.
ask() {
  local before; before=$(reports "$1")
  send "${2%% *} $1 ${2#* }"
  for _ in $(seq 1 50); do
    [ "$(reports "$1")" -gt "$before" ] && {
      grep "\"event\":\"report\",\"label\":\"$1\"" "$log" | tail -1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"])'
      return
    }
    sleep 0.1
  done
}
# Waits up to $3 seconds until what `ask $1 $2` returns contains $4.
until_has() {
  local deadline=$((SECONDS + $3)) got=""
  while [ $SECONDS -le $deadline ]; do
    got="$(ask "$1" "$2")"
    case "$got" in *"$4"*) return 0 ;; esac
    sleep 0.3
  done
  echo "      last: $(echo "$got" | tr '\n' '|' | cut -c1-200)"
  return 1
}
shot() {
  [ -n "${SHOTS:-}" ] || return 0
  mkdir -p "$SHOTS"; send state; sleep 0.5
  local id; id=$(grep '"event":"state"' "$log" | tail -1 | sed 's/.*"window":\([0-9]*\).*/\1/')
  screencapture -x -o -l "$id" "$SHOTS/$1.png" 2>/dev/null
}
peek_line() { send "type peek $1" "key peek Enter"; sleep 0.4; }

echo "== Driving the app on $tmp/data"
for _ in $(seq 1 100); do grep -q '"event":"ready"' "$log" && break; sleep 0.1; done
grep -q '"event":"ready"' "$log" && pass "the app starts and reaches its own core" || { fail "the app starts" "$(tail -3 "$log")"; exit 1; }
send 'call put {"c":"prefs","id":"agent","patch":"fixture"}' 'call put {"c":"prefs","id":"hold","patch":2}'
sleep 1
shot collapsed-idle

send capture
until_has notch "text #notch-home" 5 "Add a project" && pass "the capture shortcut opens one line; with no project yet it offers to add one" \
  || fail "capture opens"
send "type notch Undo me" "key notch Enter"
until_has notch "text #notch-home" 5 "Sent to project" && pass "Enter adds the picked folder as a project and sends the thought there" \
  || fail "Enter sends"
ask notch "text .notch-destination" | grep -q "Undo" && pass "the receipt offers Undo during the hold" || fail "the receipt offers Undo"
ask notch "click .notch-destination .text-btn" >/dev/null
until_has notch "eval document.querySelector('#guide-input').value" 3 "Undo me" \
  && pass "Undo stops the thought before it starts and returns its text to the field" || fail "Undo"
send "eval notch (document.execCommand('selectAll'),document.execCommand('insertText',false,'Hello from the smoke'))" "key notch Enter"
until_has notch "text #notch-home" 5 "Sent to project" || fail "the second capture is sent"
until_has notch "eval [...__records.thoughts.values()].map(t=>t.text).join('|')" 3 "Hello from the smoke" \
  && ask notch "eval [...__records.thoughts.values()].map(t=>t.text).join('|')" | grep -qv "Undo me" \
  && pass "the undone thought goes out again with its new text and leaves no stale copy" || fail "Undo and retyping leave one thought"
shot capture-receipt
until_has notch "text .glance-left" 10 "1" && pass "the thought starts after its hold and the collapsed glance counts it working" \
  || fail "the collapsed glance shows it working"
shot collapsed-working

send "hover in"
until_has notch "text .notch-work" 10 "Open" || fail "the working row offers Open"
ask notch "click .notch-work-row" >/dev/null
until_has peek "text .xterm-rows" 10 "fixture-agent" && pass "Open shows the agent's terminal in Peek" || fail "Peek shows the terminal"
# The fixture agent, like Claude Code in a folder it does not trust yet, asks in its terminal first.
peek_line "print:Do you trust the files in this folder?"
until_has notch "text #notch" 10 "trust this folder" && ask notch "text #notch" | grep -q "Answer in its terminal" \
  && pass "a folder-trust prompt in a starting agent's terminal opens the notch with the action that opens its terminal" \
  || fail "the trust prompt shows in the notch"
shot trust
peek_line "event:ready"
until_has notch "eval String(document.querySelector('#notch')?.open)" 5 "false" \
  && pass "the agent starting closes the trust question as answered in its terminal" || fail "the trust question closes"
peek_line "event:turn_started"
peek_line "ask:Deploy to staging?"
until_has notch "text #notch" 10 "Deploy to staging?" && pass "a question opens the notch by itself on its answer card" \
  || fail "the notch opens itself with the question"
ask notch "text #notch" | grep -q "Hello from the smoke" && pass "the card names the thought and project it belongs to" || fail "the card's context"
shot answer
send affirm
until_has peek "text .xterm-rows" 10 "answer:yes" && pass "affirm, as its global shortcut sends it, answers the agent" \
  || fail "affirm answers the question"
peek_line "event:turn_finished:All green."
until_has notch "text .glance-right" 10 "1" && pass "the collapsed glance counts the result as done and unread" || fail "the glance counts the result"
shot collapsed-done
send "hover in"
until_has notch "text #notch-home" 5 "All green." && pass "the open notch shows the result's summary" || fail "the result shows"
ask notch "text .notch-work" | grep -q "Open" && pass "the result offers Open" || fail "the result offers Open"
shot result
sleep 2
send "key notch Escape"
until_has notch "eval document.querySelector('.glance-right')?.innerText || 'none'" 5 "none" \
  && pass "a result seen in the notch is marked read and leaves the glance" || fail "seen results are marked read"
send quit
for _ in $(seq 1 30); do kill -0 "$app" 2>/dev/null || break; sleep 0.1; done
kill -0 "$app" 2>/dev/null && fail "the app quits on request" || pass "the app quits on request"

echo
[ "$fails" = 0 ] && echo "PASS  smoke" || echo "FAIL  smoke: $fails failed"
exit "$fails"
