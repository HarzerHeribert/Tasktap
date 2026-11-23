#!/bin/bash
# host/scripts/smoke.sh: builds Tasktap with a core that has the fixture agent, runs it on a
# temporary data folder and drives it through its debug channel: a core ten seconds slow to start (the window shown
# before it is there, and a quit while it starts leaving nothing running), the notch (a thought saved for
# later before any folder is open and sent to one, capture, Undo, a run, a trust prompt, a question,
# affirm, the result; where Tasktap shows itself: the notch put away while the window is in front, a question in
# the strip, Needs you or a line in the title bar, the capture key and the answer keys by the rule, the notch that folds
# untouched or at a click elsewhere, the notification over a full-screen app), Home (first run, the agents' rings, the question in full, the Folds, Earlier,
# For later), the sidebar's slide, scrolling without bars, and the workspace (a run's
# terminal, a question in its pane's strip, a shell typed into, splits, a moved tab, a divider,
# the sheets, Keep running in background and restore, Stop, text size, Keep and Discard of a run
# that worked in its own copy of the project, placing by a model: offered, allowed, a thought placed and
# briefed by the core's fixture router, Undo during its hold, a task the router is torn about waiting on its line for a key, the question
# asked when the model fails; voice: a speech service allowed, a thought spoken, words spoken into a field
# and into a question's reply, a failure and cancel, with a tone made in the page in place of a microphone
# and a speech service of the check's own on this machine; a ring picked for one thought, a spoken thought ended as
# words, what the host opens and refuses to (with an opener of the check's own: nothing is opened on this Mac), links in
# a real terminal, a session's details, a terminal open in as many places as it may be; Settings' new rows (what Return
# does, the capture key and the hold-to-talk key on the recorder with their refusals, how long thoughts are kept, the
# terminal's switches, text size in both pages); previews beside a terminal (what a link opens, each kind, what a frame
# is held to by a page that tries everything it may not, the core's tool run as an agent runs it, staying current,
# a file that went away, a server that starts later, the keys, the ninth, a restart); speech on this Mac: Settings, the download, a thought
# and words for a field through the helper, in a short launch of its own, with the real helper and model too when
# SPEECH_MODEL names the model's file, and then German, English and thoughts that change between them written as they
# were said in either order of the person's languages; then quit and relaunch with the layout restored
# and nothing rerun). It never sends keys or clicks to the system: every step is a line on the app's
# standard input, and the app is passive (its windows never take the keyboard; no system menu is
# ever opened). Prints PASS or FAIL per promise; exits non-zero on any FAIL. SHOTS=<folder> also
# saves pictures of the app's own pages, taken by the app itself (`snapshot`), so no permission is involved.
set -u
host="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$host/.." && pwd)"
# --only <words>[,<words>…]: the build, the app's start and of the app's steps only the sections whose names hold one
# of these; the headless checks are left out. For a step that fails now and then, run in a loop: `--only Settings`.
only=""
case "${1:-}" in
  --only) only="${2:-}"; [ -n "$only" ] || { echo "--only takes words of a section's name, as the run prints it after ==" >&2; exit 2; } ;;
  "") ;;
  *) echo "usage: smoke.sh [--only <words of a section's name>[,<words of another's>]]" >&2; exit 2 ;;
esac
fails=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1${2:+: $2}"; fails=$((fails + 1)); }
# Each section says how long the one before it took, and the end lists them all, longest first: where a run's time
# goes, on a runner as at a desk.
section_name="" section_at=$SECONDS timings=""
section() {
  if [ -n "$section_name" ]; then
    echo "   ($((SECONDS - section_at)) s)"
    timings="$timings$((SECONDS - section_at)) s  $section_name"$'\n'
  fi
  section_name="$1" section_at=$SECONDS
  [ -z "$1" ] || echo "== $1"
}
# A section of the app's steps, which --only may leave out: `if part "…"; then … fi`.
part() {
  local word words
  if [ -n "$only" ]; then
    IFS=, read -ra words <<< "$only"
    for word in "${words[@]}"; do case "$1" in *"$word"*) section "$1"; return 0 ;; esac; done
    return 1
  fi
  section "$1"
}

section "Building the pages, the cores and the host"
(cd "$root/ui" && npm run --silent build >/dev/null) || { echo "FAIL  ui build"; exit 1; }
"$host/scripts/build-core.sh" >/dev/null && FIXTURES=1 "$host/scripts/build-core.sh" >/dev/null || { echo "FAIL  core build"; exit 1; }
"$host/scripts/build-speech.sh" >/dev/null 2>&1 || { echo "FAIL  speech helper build"; exit 1; }
cargo build --quiet --manifest-path "$host/Cargo.toml" || { echo "FAIL  host build"; exit 1; }

# (The headless checks: none with --only.)
if [ -z "$only" ]; then
section "Lists keep their columns (headless, fixture records)"
# The workflow's Interface job runs this same check on the same commit and the same Mac image (ALIGNED=elsewhere): in
# the host job it would only take its seven minutes again.
if [ "${ALIGNED:-}" = elsewhere ]; then echo "NOTE  run by the workflow's Interface job on this commit, on the same Mac image: not again here"
elif out="$(node "$root/scripts/align-check.cjs" 2>&1)"; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "list alignment"; fi

section "The ambient layer holds steady (headless, two and a half minutes)"
if out="$(node "$root/scripts/soak-check.cjs" 2>&1)"; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "the ambient layer holds steady"; fi

section "The capture flow keeps its pace (the built app with the fixture agent, in a short launch of its own)"
out="$(node "$root/scripts/flow-check.cjs" --app --debug --short ${FRONT:+--front} 2>&1)"
if [ $? = 0 ]; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"
elif echo "$out" | grep -q "nothing can be measured\|nothing drawn on it can be measured"; then pass "the capture flow was not timed: $(echo "$out" | grep -o 'The [^:]*: nothing[^.]*' | head -1)"
else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "the capture flow keeps its pace" "$(echo "$out" | grep -q '^FAIL' || echo "$out" | tail -4 | tr '\n' '|' | cut -c1-400)"; fi

section "One type system (headless, every state of both pages)"
if out="$(node "$root/scripts/type-check.cjs" 2>&1)"; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "the type scale"; fi

section "Settings' words: a label that reads by itself and one sentence of help on every row, none of the words a person does not use (headless)"
if out="$(node "$root/scripts/words-check.cjs" 2>&1)"; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "Settings' words"; fi

section "The Composer's field is the person's while a thought is sent (headless, real keys, a core that answers late or refuses)"
if out="$(node "$root/scripts/composer-check.cjs" 2>&1)"; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "the Composer's field"; fi

section "Links in terminals (headless, a real pointer and real keys, a host that keeps what it is asked to open)"
if out="$(node "$root/scripts/links-check.cjs" 2>&1)"; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "links in terminals"; fi
if out="$(node "$root/scripts/frame-check.cjs" 2>&1)"; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "a page in a preview's frame"; fi

section "Voice, recorded by the page (headless, a microphone made in the page)"
if out="$(node "$root/scripts/voice-check.cjs" 2>&1)"; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "voice in the page"; fi

section "Speech on this Mac, in the page (headless, a microphone made in the page, a helper the check plays)"
if out="$(node "$root/scripts/speech-check.cjs" 2>&1)"; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "speech on this Mac in the page"; fi

section "Speech on this Mac, in the app (a short launch of its own; a tone and generated recordings, never the microphone)"
out="$(node "$root/scripts/speech-app-check.cjs" ${SPEECH_MODEL:+--model "$SPEECH_MODEL"} 2>&1)"
if [ $? = 0 ]; then echo "$out" | grep -E '^(PASS|NOTE)' | sed '$d'; pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "speech on this Mac in the app" "$(echo "$out" | grep -q '^FAIL' || echo "$out" | tail -4 | tr '\n' '|' | cut -c1-400)"; fi

if [ -n "${SPEECH_MODEL:-}" ]; then
  section "Speech on this Mac is written in the language it is said in (the real helper and model; the Mac's voices in files)"
  if out="$(node "$root/scripts/speech-language-check.cjs" "$SPEECH_MODEL" 2>&1)"; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "the language of speech on this Mac"; fi
fi
fi

tmp="$(mktemp -d)"
log="$tmp/log"
mkdir -p "$tmp/agents" "$tmp/project" "$tmp/home"
# The shells the app starts, typed into here, are the person's shell in a home of the check's own (an empty
# configuration, which zsh would otherwise offer to write): none of them reads or writes the person's files.
: > "$tmp/home/.zshrc"
# A speech service of the check's own, on this machine: it answers a recording with the words in $tmp/says.
echo "nothing yet" > "$tmp/says"
python3 "$host/scripts/speech-fixture.py" "$tmp/says" "$tmp/speech.log" > "$tmp/port" &
for _ in $(seq 1 30); do [ -s "$tmp/port" ] && break; sleep 0.1; done
port="$(cat "$tmp/port")"
ln "$host/binaries/fixtures/tasktap" "$tmp/agents/fixture-agent"
# The fixture agent as a person types it into a shell, under its own name (the shim's).
ln "$host/binaries/fixtures/tasktap" "$tmp/agents/fixture"
# The project is a git repository with one commit, so a run can work in a copy of it (Keep and Discard).
printf '[user]\n\tname = Smoke\n\temail = smoke@example.com\n[init]\n\tdefaultBranch = main\n' > "$tmp/gitconfig"
export GIT_CONFIG_GLOBAL="$tmp/gitconfig" GIT_CONFIG_NOSYSTEM=1
git -C "$tmp/project" init -q && echo "smoke" > "$tmp/project/README" && echo "*.log" > "$tmp/project/.gitignore" && git -C "$tmp/project" add README .gitignore && git -C "$tmp/project" commit -qm "Start" \
  || { echo "FAIL  the project's repository"; exit 1; }
# What the host would have the system open goes to a file instead: nothing is opened on this Mac.
printf '#!/bin/sh\necho "$@" >> "%s"\n' "$tmp/opened" > "$tmp/opener" && chmod +x "$tmp/opener" && : > "$tmp/opened"
app=0
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

# A core slow to start, as a first start's can be (its new copy looked at by the system or a virus scanner, a slow
# disk): a stand-in that waits SMOKE_CORE_DELAY seconds (none unless a launch sets it) and then becomes the fixture
# core. The app copies it into its data folder and starts it from there, as it does the core it bundles. What it becomes
# is a copy, as the app's own core is: the fixture agent is the fixture core under another name, and the agents' shims,
# links to the core, pass over a file that is the core itself.
cp "$host/binaries/fixtures/tasktap" "$tmp/fixture-core"
printf '#!/usr/bin/perl\n# A core that starts late: it waits, then becomes the fixture core.\nsleep($ENV{SMOKE_CORE_DELAY} || 0);\nexec("%s", @ARGV) or die "$!";\n' \
  "$tmp/fixture-core" > "$tmp/slow-core" && chmod +x "$tmp/slow-core"

# Starts the app on the same data folder each time (or on $1, its core $2 seconds late, its lines in $3); its input is a
# new pipe on descriptor 3.
launch() {
  rm -f "$tmp/in"
  mkfifo "$tmp/in"
  env HOME="$tmp/home" PATH="$tmp/agents:$PATH" TASKTAP_DEBUG=1 TASKTAP_PASSIVE=1 TASKTAP_DATA="${1:-$tmp/data}" TASKTAP_PICK="$tmp/project" TASKTAP_OPEN="$tmp/opener" \
    CLAUDE_CONFIG_DIR="$tmp/no-history/claude" CODEX_HOME="$tmp/no-history/codex" SMOKE_CORE_DELAY="${2:-0}" \
    TASKTAP_CORE_EXE="$tmp/slow-core" TASKTAP_CORE_BUILD="$(cat "$host/binaries/fixtures/build.txt")" \
    "$host/target/debug/tasktap-app" < "$tmp/in" >> "${3:-$log}" 2>&1 &
  app=$!
  exec 3>"$tmp/in"
}
quit() {
  send quit
  for _ in $(seq 1 30); do kill -0 "$app" 2>/dev/null || return 0; sleep 0.1; done
  return 1
}

# (Its loop's variable is its own: a step's `line` kept the command last sent, and "the answered thought on its way"
# failed on that, in every run, with every read answered.)
send() { local line; for line in "$@"; do echo "$line" >&3; done; }
reports() { grep -c "\"event\":\"report\",\"label\":\"$1\"" "$log"; }
# The data of the next report from page $1 after sending it $2: `ask notch "text #sheet"`.
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
# A page expression, for the workspace's debug handle `__ws`: `js workspace "__ws.ui.view"`.
js() { ask "$1" "eval $2"; }
shot() {
  [ -n "${SHOTS:-}" ] || return 0
  mkdir -p "$SHOTS"; send "snapshot ${2:-notch} $SHOTS/$1.png"; sleep 0.5
}
# A line typed into the workspace's shown terminal.
term_line() { js workspace "__ws.type('$1')" >/dev/null; sleep 0.4; }
screen() { echo "eval __ws.text()"; }
# A key pressed on the element `$2` of page $1 (the strip's or a sheet's keys act on what has the keyboard).
press() { js "$1" "(()=>{const t=document.querySelector('$2');t?.focus();t?.dispatchEvent(new KeyboardEvent('keydown',{key:'$3',bubbles:true,cancelable:true,metaKey:${4:-false}}));return !!t})()"; }
thought() { echo "eval [...__ws.records.thoughts.values()].find(t=>t.text==='$1')?.$2"; }
# The Settings row named $1, as the sheet shows it.
setting() { echo "[...document.querySelectorAll('.set-pane .set')].find((r) => r.querySelector('.t').textContent === '$1')"; }
# What the foot of Settings says of the row named $1, as it does while the row has the keyboard (the page is told as focus tells it:
# a passive window is not given the keyboard by the system).
foot_of() { js workspace "(r => (r.dispatchEvent(new FocusEvent('focusin', { bubbles: true })), 1))($(setting "$1"))" >/dev/null; sleep 0.3; ask workspace "text .sheet .sh-hint"; }

if part "Quit while the core starts (a short launch of its own, its core ten seconds slow)"; then
# Quit two seconds in, the core still starting: the app ends, the core is ended with it, and none starts after it has
# gone (by then the stand-in would have become the core). A folder of its own, so that a core is started, not found.
early="$tmp/quit-early"
launch "$early" 10 "$tmp/quit-early.log"
sleep 2
quit && ended=at-once || ended="not within 3 s"
sleep 9
left="$(pgrep -fl "$early" | cut -c1-120 | tr '\n' ';')"
[ "$ended" = at-once ] && [ -z "$left" ] \
  && pass "quit two seconds into a core's ten-second start: the app ends at once, and no core is left behind or starts after it" \
  || fail "quit while the core starts" "the app ended $ended; running from its folder 12 s after launch: ${left:-nothing}"
kill "$app" 2>/dev/null; pkill -f "$early" 2>/dev/null
fi

if part "A core that cannot start (a short launch of its own)"; then
# A core that ends before it listens: the app says why on its standard error and ends with 101 through its own exit,
# as a quit does (it says "quitting" and "quit"; the window's frame is kept, on Windows the icon taken away), not from
# the thread that waited for the core.
printf '#!/bin/sh\nexit 3\n' > "$tmp/no-core" && chmod +x "$tmp/no-core"
env HOME="$tmp/home" TASKTAP_DEBUG=1 TASKTAP_PASSIVE=1 TASKTAP_DATA="$tmp/no-core-data" CLAUDE_CONFIG_DIR="$tmp/no-history/claude" CODEX_HOME="$tmp/no-history/codex" \
  TASKTAP_CORE_EXE="$tmp/no-core" TASKTAP_CORE_BUILD="$(cat "$host/binaries/fixtures/build.txt")" \
  "$host/target/debug/tasktap-app" < /dev/null > "$tmp/no-core.log" 2>&1 &
failing=$!
for _ in $(seq 1 100); do kill -0 "$failing" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$failing" 2>/dev/null; then kill "$failing"; code="still running after 10 s"; else wait "$failing"; code=$?; fi
said="$(grep -c 'Tasktap failed to start: the core ended before it listened' "$tmp/no-core.log") $(grep -c '"event":"quitting"' "$tmp/no-core.log") $(grep -c '"event":"quit"}' "$tmp/no-core.log")"
[ "$code" = 101 ] && [ "$said" = "1 1 1" ] \
  && pass "a core that cannot start: the app says why and ends with 101 through its own exit, as a quit does" \
  || fail "a core that cannot start" "exit $code; why, quitting, quit said: $said; $(grep -v '"event":"report"' "$tmp/no-core.log" | tail -3 | tr '\n' '|' | cut -c1-300)"
fi

section "Driving the app on $tmp/data"
# Its first start's core is slow too: ten seconds pass before it listens. Neither the window nor the page's word that
# it has drawn waits for it (host.ready goes out before the core's welcome). Judged by cause, not by the clock, which
# runs slower on some Macs than on others: the window is shown before the core is there, by the page's word or by the
# host's fallback 3 s after the window is made (on a slow Mac the page itself takes longer than that), and the page's
# word reaches the host before the core is there. 5 s is only a net for the window. The page has the core once it is
# there, for all that follows.
launch "$tmp/data" 10
# Until the window and the page's word are both said, or the core is there.
for _ in $(seq 1 120); do
  if grep -q '"event":"ready"' "$log" || { grep -q '"event":"window"' "$log" && grep -q '"event":"page-ready"' "$log"; }; then break; fi
  sleep 0.1
done
shot core-starting workspace
# Where each was said first in the app's lines; one said before the core is before its line, or the core not yet there.
at() { grep -n "\"event\":\"$1\"" "$log" | head -1 | cut -d: -f1; }
core_at="$(at ready)"
first() { [ -n "$1" ] && { [ -z "$core_at" ] || [ "$1" -lt "$core_at" ]; }; }
window="$(grep -m1 '"event":"window"' "$log")"
shown="$(echo "$window" | grep -o '"ms":[0-9]*' | grep -o '[0-9]*$')"
by="$(echo "$window" | grep -o '"by":"[a-z]*"' | cut -d'"' -f4)"
said="$(grep -m1 '"event":"page-ready"' "$log" | grep -o '"ms":[0-9]*' | grep -o '[0-9]*$')"
first "$(at window)" && window_first=yes || window_first=no
first "$(at page-ready)" && page_first=yes || page_first=no
window_said="not shown"; [ -n "$shown" ] && window_said="shown by the $by at $shown ms"
page_said="never"; [ -n "$said" ] && page_said="at $said ms"
[ "$window_first" = yes ] && [ "$page_first" = yes ] && [ "${shown:-99999}" -le 5000 ] \
  && pass "with a core ten seconds slow to start, the window is shown before it is there ($shown ms after the launch, by the $by), and the page said it had drawn before it too ($said ms)" \
  || fail "the window does not wait for the core" "the window: $window_said, before the core: $window_first; the page said it had drawn: $page_said, before the core: $page_first"
for _ in $(seq 1 200); do grep -q '"event":"ready"' "$log" && break; sleep 0.1; done
# FRONT=1: the app's window in front of the other apps' for the run (the keyboard stays where it is), so that what a
# covered window would not draw is checked too.
[ -n "${FRONT:-}" ] && send front
grep -q '"event":"ready"' "$log" && pass "the app starts and reaches its own core" || { fail "the app starts" "$(tail -3 "$log")"; exit 1; }
# The host shows the window a moment after the first picture with the records is laid out: its line is waited for. On this
# first start (an empty data folder, no agent's history) the first picture is the welcome, in place of Home.
until_has workspace "eval __ws.ui.view + ' ' + !!document.querySelector('.welcome .wc')" 10 "home true" \
  && for _ in $(seq 1 100); do grep -q '"event":"window"' "$log" && break; sleep 0.1; done && grep -q '"event":"window"' "$log" \
  && pass "the workspace window opens at launch, on the welcome, once its page has drawn" || fail "the workspace window opens"
# A core built with its fixtures lists its agents when asked, as a normal one does at start, and runs their commands then.
send 'call put {"c":"prefs","id":"agent","patch":"fixture"}' 'call put {"c":"prefs","id":"hold","patch":2}' 'call agents.detect {}'
# Every agent on this Mac answers in its own time, and one asks its servers first: what follows waits for them all,
# since their rows redraw the pages, which is no rest.
for _ in $(seq 1 100); do grep -q '"name":"agents.detect"' "$log" && break; sleep 0.1; done
# A context menu is the system's: the check never lets one open on the screen, and runs its items itself.
js workspace "(__ws.menu.dry = true)" >/dev/null
sleep 1
shot collapsed-idle
shot home workspace
# First start (ui/src/workspace/welcome.tsx): with no agent's history to offer (the app is given empty folders for Claude
# Code's and Codex's, so this is the same on every machine), the welcome comes by itself in place of Home, one step in
# view: the projects, the agents, who finds the project for a task, talking instead of typing. Each can be skipped; after
# the last Home shows, with "Finish setup" under the Composer, which comes back to the first step left open; Escape
# leaves the welcome for Home, the keyboard in the Composer.
welcome="document.querySelector('.welcome .wc')"
stepnow="eval (w => w ? w.querySelector('.wc-m').getAttribute('aria-label') + '|' + w.querySelector('h1').childNodes[0].textContent : 'none')($welcome)"
until_has workspace "eval (w => w ? w.querySelector('.wc-m').getAttribute('aria-label') + ' ' + /^(Your projects|No projects found)/.test(w.querySelector('h1').textContent) + ' ' + !document.querySelector('.home:not(.row)') + ' ' + String(__ws.ui.sheet) + ' ' + __ws.records.prefs.get('setup_hidden')?.value : 'none')($welcome)" 10 "Step 1 of 4 true true null false" \
  && pass "with no agent's history, the first start shows the welcome by itself in place of Home: its first step, the projects, no sheet over it, and that the first start was seen is written down" || fail "the first start's welcome" "$(ask workspace "$stepnow")"
walked=yes
for want in "Step 2 of 4|Your agents" "Step 3 of 4|Let Tasktap find the project for each task" "Step 4 of 4|Talk instead of typing"; do
  js workspace "(document.querySelector('.welcome .wc-skip').click(), 1)" >/dev/null
  until_has workspace "$stepnow" 5 "$want" || { walked="it did not reach: $want"; break; }
done
[ "$walked" = yes ] && js workspace "(document.querySelector('.welcome .wc-skip').click(), 1)" >/dev/null \
  && until_has workspace "eval String(!document.querySelector('.welcome')) + ' ' + document.querySelector('.home .finish')?.textContent" 5 "true Finish setup" \
  && pass "the welcome's four steps are walked, the agents, who finds the project and talking instead of typing, and after the last Home shows with Finish setup" || fail "walking the welcome" "$walked"
js workspace "(document.querySelector('.home .finish')?.click(), 1)" >/dev/null
until_has workspace "eval String(!!document.querySelector('.welcome .wc')) + ' ' + String(!document.querySelector('.home:not(.row)'))" 5 "true true" \
  && js workspace "(document.querySelector('.welcome .wc').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })), 1)" >/dev/null \
  && until_has workspace "eval String(!document.querySelector('.welcome')) + ' ' + document.activeElement?.id + ' ' + document.querySelector('.home .finish')?.textContent" 5 "true capture-input Finish setup" \
  && pass "Finish setup brings the welcome back at a step still open, and Escape leaves it for Home: the keyboard in the Composer, Finish setup still under it" || fail "Escape leaves the welcome for Home"
edges="((c, f, h, x, s) => [Math.abs(c.left + c.width / 2 - (x.left + x.width / 2)) < 1 && Math.abs(x.left - Math.max((innerWidth - x.width) / 2, s + 36)) < 1, Math.abs(f.left + f.width / 2 - (c.left + c.width / 2)) < 2 && f.top >= c.bottom - 1, c.top + c.height / 2 < h.top + h.height / 2 && c.top > h.top + h.height * 0.2].join(' '))(document.querySelector('.home .cap').getBoundingClientRect(), document.querySelector('.home .finish').getBoundingClientRect(), document.querySelector('#main').getBoundingClientRect(), document.querySelector('.hx').getBoundingClientRect(), document.querySelector('.side')?.getBoundingClientRect().right ?? 0)"
metal="(k => /linear-gradient/.test(getComputedStyle(k).backgroundImage) && getComputedStyle(k).color === 'rgb(13, 13, 14)')(document.querySelector('.home .cap-row .key'))"
until_has workspace "eval String(!__ws.ui.sheet && !!document.querySelector('.home .finish'))" 5 "true" && ! ask workspace "text .hx" | grep -q "Agents" \
  && [ "$(js workspace "[...document.querySelectorAll('#dest-chip > b, #dest-chip > span')].map(e => e.textContent).join(' ')")" = "Auto" ] \
  && [ "$(js workspace "(b => b.textContent + ' ' + b.disabled)(document.querySelector('.home .cap-row .key'))")" = "Start true" ] && [ "$(js workspace "String($metal)")" = true ] \
  && [ "$(js workspace "String(!document.querySelector('.hx.first > :not(.capture, .finish, .cols)'))")" = true ] \
  && [ "$(js workspace "$edges")" = "true true true" ] \
  && pass "after the welcome, Home is one composition: the Composer a little above the middle, centred on the window as far as the sidebar lets it, its place saying Auto, its key the metal key that Return starts with; under it Finish setup, and nothing else loose" || fail "Home on first start" "$(js workspace "$edges")"
# The light: Home's chrome is drawn once and then nothing while nothing happens, the notch draws no form at all, and
# the person's choice reaches both pages at once.
# A Mac may ask for reduced motion (Accessibility, Reduce motion; GitHub's Mac runners have it on): then the light is
# held still at every level and the sidebar does not slide, as the person asked, and the steps hold the app to that.
reduced="$(js workspace "String(matchMedia('(prefers-reduced-motion: reduce)').matches)")"
[ "$reduced" = true ] && echo "NOTE  this Mac asks for reduced motion: the light and the sidebar are held to staying still"
usual="$([ "$reduced" = true ] && echo still || echo full)"
# A window the person has covered draws nothing (WebKit reports it hidden), so a covered window is said, not failed.
if until_has workspace "eval String(!!document.querySelector('.light .motion canvas') && __motion.stats.frames > 0)" 10 "true"; then
  pass "Home's light draws its chrome as a canvas"
elif [ "$(js workspace "String(document.hidden)")" = true ]; then
  pass "Home's light: the window is covered, so nothing is drawn yet"
else
  fail "Home's light draws" "$(js workspace "[document.hidden, __motion.stats.frames, !!document.querySelector('.light .motion'), document.querySelector('.light .motion')?.hasAttribute('data-small')].join(' ')")"
fi
frames=$(js workspace "__motion.stats.frames")
sleep 2
[ "$(js workspace "__motion.stats.frames")" = "$frames" ] && [ "$(js notch "document.querySelectorAll('canvas').length")" = 0 ] \
  && [ "$(js workspace "document.querySelector('.light')?.dataset.moves")" = false ] \
  && pass "at rest nothing is drawn and nothing moves: Home holds its still light, and the notch has no canvas at all" || fail "nothing draws at rest"
# While agents work, in the window in use (which a passive window is only when told so), the layer is a loop: the
# band moves and the light with it; once the loop is at its pace the compositor carries it, and the page draws
# keyframes and no frames; back at rest it stops.
if [ "$(js workspace "String(document.hidden)")" = true ]; then
  pass "the loop while agents work: the window is covered, so nothing is drawn yet"
elif [ "$reduced" = true ]; then
  drawn="__motion.stats.frames + __motion.stats.keys"
  js workspace "(Object.assign(__motion.debug, { state: 'working', active: true }), __motion.redraw(), 1)" >/dev/null; sleep 1
  was=$(js workspace "$drawn"); sleep 2
  held="$(js workspace "document.documentElement.dataset.effects + ' ' + document.querySelector('.light')?.dataset.moves + ' ' + ($drawn - $was)")"
  js workspace "(Object.assign(__motion.debug, { state: null, active: null }), __motion.redraw(), 1)" >/dev/null; sleep 1
  [ "$held" = "still false 0" ] && pass "while agents work on a Mac that asks for reduced motion the light is held still: the effects are Still, nothing moves and nothing is drawn" \
    || fail "the loop while agents work, with reduced motion" "$held"
else
  drawn="__motion.stats.frames + __motion.stats.keys"
  js workspace "(Object.assign(__motion.debug, { state: 'working', active: true }), __motion.redraw(), 1)" >/dev/null; sleep 1
  was=$(js workspace "$drawn"); sleep 2
  moving="$(js workspace "String($drawn - $was > 20) + ' ' + document.querySelector('.light').dataset.moves")"
  sleep 1.5
  frames=$(js workspace "__motion.stats.frames"); keys=$(js workspace "__motion.stats.keys"); sleep 1.5
  # The loop is drawn in the page, frame by frame: carried by the compositor it flickered in the app (stats.carry is off).
  carried="$(js workspace "String(__motion.stats.frames - $frames > 20 && __motion.stats.keys === $keys)")"
  js workspace "(Object.assign(__motion.debug, { state: null, active: null }), __motion.redraw(), 1)" >/dev/null; sleep 2.5
  was=$(js workspace "$drawn"); sleep 1
  [ "$moving" = "true true" ] && [ "$carried" = true ] && [ "$(js workspace "$drawn")" = "$was" ] \
    && pass "while agents work in the window in use the band and the light move, and the loop goes on being drawn in the page for as long as they work; back at rest it is still within a moment" || fail "the loop while agents work" "$moving $carried"
fi
# The sidebar's glyphs: a few, large, each a picture drawn once (no view of the motion's own), still while idle.
glyphs="[...document.querySelectorAll('.spark .glyph.in')]"
if [ "$(js workspace "String(document.hidden)")" = true ]; then
  pass "the sidebar's glyphs: the window is covered, so nothing is drawn yet"
else
  until_has workspace "eval String((g => g.length >= 2 && g.every(x => x.offsetWidth >= 56 && x.querySelector('.turn canvas')) && !document.querySelector('.spark .motion'))($glyphs))" 5 "true" \
    && a="$(js workspace "$glyphs.map(x => getComputedStyle(x.querySelector('.turn')).transform + getComputedStyle(x.querySelector('.turn')).translate).join('|')")" && sleep 1.5 \
    && [ "$(js workspace "$glyphs.map(x => getComputedStyle(x.querySelector('.turn')).transform + getComputedStyle(x.querySelector('.turn')).translate).join('|')")" = "$a" ] \
    && pass "the sidebar's foot shows a few large chrome glyphs, each a picture drawn once, at rest while idle" || fail "the sidebar's glyphs" "$(js workspace "$glyphs.length")"
fi
# The effects are the core's preference: Still holds the light as a picture whatever goes on, Off removes the light
# and the glyphs, Low Power Mode holds Full at Still, and the page keeps nothing itself.
send 'call put {"c":"prefs","id":"motion_ambient","patch":"still"}'
js workspace "(Object.assign(__motion.debug, { state: 'working', active: true }), __motion.redraw(), 1)" >/dev/null
until_has workspace "eval document.documentElement.dataset.effects + ' ' + document.querySelector('.light')?.dataset.moves" 3 "still false" \
  && frames=$(js workspace "__motion.stats.frames") && sleep 1.5 && [ "$(js workspace "__motion.stats.frames")" = "$frames" ] \
  && send 'call put {"c":"prefs","id":"motion_ambient","patch":"off"}' \
  && until_has workspace "eval String(!document.querySelector('.light') && !document.querySelector('.spark .glyph') && !document.querySelector('.room canvas'))" 3 "true" \
  && send 'call delete {"c":"prefs","id":"motion_ambient"}' \
  && until_has workspace "eval String(!!document.querySelector('.light') && localStorage.length === 0) + ' ' + document.documentElement.dataset.effects" 3 "true $usual" \
  && js workspace "(__motion.debug.saving = true, __motion.redraw(), 1)" >/dev/null \
  && until_has workspace "eval document.documentElement.dataset.effects + ' ' + document.querySelector('.light')?.dataset.moves" 3 "still false" \
  && pass "the effects are the core's preference: at Still the light is a picture while agents work, Off takes the light and the glyphs away at once, Low Power Mode holds Full at Still, and nothing is kept in the page (with none chosen: $usual)" || fail "the effects preference"
js workspace "(Object.assign(__motion.debug, { state: null, active: null, saving: null }), __motion.redraw(), 1)" >/dev/null
send 'call put {"c":"prefs","id":"motion_style","patch":"glyphs"}' 'call put {"c":"prefs","id":"motion_lumen","patch":true}'
until_has workspace "eval document.querySelector('.light .motion').dataset.style" 3 "glyphs" \
  && until_has notch "eval document.querySelector('#notch-art').dataset.glow" 3 "motion" \
  && [ "$(js workspace "String(__motion.stats.frames > $frames || document.hidden || document.querySelector('.light .motion').hasAttribute('data-small'))")" = true ] \
  && pass "a preference changes Home's light at once (redrawn unless the window is covered), and Lumen gives the notch's glow its colours" \
  || fail "a preference reaches both pages"
send 'call delete {"c":"prefs","id":"motion_style"}' 'call delete {"c":"prefs","id":"motion_lumen"}'
# The Settings sheet's microphone trial needs a secure page that offers getUserMedia; nothing here asks for it.
[ "$(js workspace "String(isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function')")" = true ] \
  && pass "the workspace page may ask for the microphone (secure, with getUserMedia)" || fail "the workspace page offers getUserMedia"

# Who runs a thought is one control in the Composer's foot: the ring and name of the agent that runs it and a chevron,
# which opens a list in the chip's style; no row of rings, no system menu (NOTES §13).
agentc="document.querySelector('.home .cap-agent')"
until_has workspace "eval String($agentc?.dataset.agent === 'fixture' && !!$agentc.querySelector('.ring-o circle') && /Fixture agent.*runs the next task/.test($agentc.title) && !document.querySelector('.hx .list, .rail .off, .home .rings, .home .cap-row select'))" 5 "true" \
  && pass "who runs a thought is one control: the agent's ring and name with a chevron, named in its tooltip and for VoiceOver; no row of rings, no list of agents on Home, no names in the rail" || fail "the agent control" "$(js workspace "$agentc?.outerHTML.slice(0, 200)")"
js workspace "($agentc.click(), 1)" >/dev/null
until_has workspace "eval String(!!document.querySelector('.home .agent-list'))" 3 "true" || fail "the agent control opens its list"
other="$(js workspace "document.querySelector('.home .agent-list [role=option]:not([data-agent=fixture]):not([data-s=off])')?.dataset.agent ?? ''")"
if [ -n "$other" ]; then
  js workspace "(document.querySelector('.home .agent-list [data-agent=$other]').click(), 1)" >/dev/null
  until_has workspace "eval $agentc.dataset.agent" 3 "$other" \
    && [ "$(js workspace "__ws.records.prefs.get('agent').value + ' ' + __speech.cap.agent")" = "fixture $other" ] \
    && pass "the control's list picks another agent for the thought being written; the default, the core's preference, stays as it was" || fail "picking an agent from the list"
  # The list comes in the page's next frame: the row is clicked once it is there.
  js workspace "($agentc.click(), 1)" >/dev/null
  until_has workspace "eval String(!!document.querySelector('.home .agent-list [data-agent=fixture]'))" 3 "true" \
    && js workspace "(document.querySelector('.home .agent-list [data-agent=fixture]').click(), 1)" >/dev/null
  until_has workspace "eval $agentc?.dataset.agent + ' ' + __speech.cap.agent" 3 "fixture undefined" || fail "the usual agent is chosen again"
else
  js workspace "(document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 1)" >/dev/null
fi

# Tab reaches every control of the Composer's foot in the app's own web view, as it does in a browser (the host turns on
# the web view's tabFocusesLinks; the review's R6): from the field with a thought in it, the chip, the agent control,
# the microphone and the key, pressed as the keyboard presses Tab there (`tabkey`).
js workspace "(document.querySelector('.home #capture-input').focus(), document.execCommand('insertText', false, 'Tab through the foot'), 1)" >/dev/null
order=""
for _ in 1 2 3 4; do send "tabkey workspace"; sleep 0.4; order="$order $(js workspace "(a => a.id || String(a.className).split(' ')[0] || a.tagName)(document.activeElement)")"; done
[ "$order" = " dest-chip cap-agent mic key" ] && pass "Tab from the field reaches the chip, the agent control, the microphone and the key in the app's own web view" || fail "Tab through the Composer's foot" "$order"
js workspace "(document.querySelector('.home #capture-input').focus(), document.execCommand('selectAll'), document.execCommand('delete'), 1)" >/dev/null

if part "A thought saved for later before a folder is open, then sent to one"; then
send capture
until_has notch "eval [...document.querySelectorAll('#dest-chip > b, #dest-chip > span')].map(e => e.textContent).join(' ') + ' ' + document.querySelector('.cap-row .key')?.textContent" 5 "Auto Start" \
  && pass "the capture shortcut opens the field; with no folder yet its place says Auto, and its key that Return starts the task" \
  || fail "capture opens"
# With no project at all, Return sends the task and Tasktap asks where the agent should work (the owner, 2026-11-21):
# a folder to open or create, the Scratchpad, or keeping it for later, which the person chooses here.
send "type notch Hello from the smoke" "key notch Enter"
until_has notch "eval [...document.querySelectorAll('[data-question] .q-asks, [data-question] .ans > span')].map(e => e.textContent).join('|')" 5 "Where should the agent work?|Open or create a folder…|Scratchpad|Keep for later" \
  && js notch "([...document.querySelectorAll('[data-question] .ans')].find(b => b.textContent.includes('Keep for later')).click(), 1)" >/dev/null \
  && until_has notch "eval (t => t?.mode + ' ' + t?.placed)([...__records.thoughts.values()].find(t=>t.text==='Hello from the smoke'))" 5 "note kept_answer" \
  && pass "Enter sends it, and with no project Tasktap asks where the agent should work; Keep for later saves it for later" || fail "a thought is saved for later"
send "key notch Escape"
until_has workspace "text .hx .hsec" 5 "Hello from the smoke" && ask workspace "text .hx .hsec" | grep -q "For later" && js workspace "document.querySelector('.hr.later').textContent" | grep -q "Send to a folder" \
  && pass "it lands on Home in a For later line of its own, with Send to a folder on it" || fail "Home lists what was saved for later"
# Typed on Home instead, For later chosen in the chip's list: the Composer's key does something now, still the metal
# one, and what is saved lands under it with its way on shown.
js workspace "(document.querySelector('.home #capture-input').focus(), document.execCommand('insertText', false, 'Later, from Home'), document.querySelector('.home #dest-chip').click(), 1)" >/dev/null
until_has workspace "eval String(!!document.querySelector('.home .cap-list button[data-to=later]'))" 3 "true" \
  && js workspace "(document.querySelector('.home .cap-list button[data-to=later]').click(), 1)" >/dev/null
until_has workspace "eval document.querySelector('.home .cap-row .key').disabled + ' ' + $metal + ' ' + document.querySelector('.home .cap-row .key').textContent" 3 "false true Save for later" \
  && send "key workspace Enter" && until_has workspace "text .home .cap-said" 5 "Saved for later" \
  && until_has workspace "eval getComputedStyle(document.querySelector('.hr.later.new .hr-a')).visibility" 3 "visible" \
  && pass "typed on Home with For later chosen, Return saves it for later: the Composer's key is the metal key, the receipt says so, and the thought lands in For later with Send to a folder showing" || fail "save for later on Home"
js workspace "([...document.querySelectorAll('.hr.later')].find(r=>r.textContent.includes('Later, from Home')).querySelectorAll('.btn')[1].click(), 1)" >/dev/null
until_has workspace "eval String(document.querySelectorAll('.hr.later').length)" 3 "1" || fail "the thought saved on Home is dropped"
ask workspace "click .hr.later .btn" >/dev/null
until_has workspace "text .sheet" 3 "Open a folder" && pass "Send to a folder opens a sheet hanging from the title bar" || fail "the send sheet"
shot send-sheet workspace
press workspace ".sheet" o true >/dev/null
until_has workspace "text #sidebar" 10 "project" && pass "choosing a folder there opens it as a workspace" || fail "the folder opens"
project=$(js workspace "[...__ws.records.projects.values()].find(p=>p.kind==='folder')?.id")
until_has workspace "$(thought 'Hello from the smoke' phase)" 10 "working" && pass "it is sent there and starts after its hold" || fail "the saved thought starts"
until_has notch "text .tab .wing.l" 10 "1" && pass "the collapsed glance counts it working" || fail "the collapsed glance shows it working"
shot collapsed-working
fi

if part "Capture and Undo"; then
send capture
until_has notch "eval document.activeElement?.id" 5 "capture-input" || fail "capture opens again"
until_has notch "eval (r => r?.dataset.s + ' ' + !!r?.querySelector('.turn'))(document.querySelector('.cap-agent[data-agent=fixture]'))" 5 "working true" \
  && pass "while its session works the agent control's ring turns" || fail "a working agent's ring"
until_has notch "eval document.querySelector('#dest-chip b')?.textContent + ': ' + document.querySelector('#dest-chip')?.title" 3 "project: project is the only folder open" \
  || fail "with one folder open, the chip says it is where a thought goes"
send "type notch Undo me" "key notch Enter"
until_has notch "text .way" 5 "project" && pass "with one folder open, the chip says it is where a thought goes, and Enter sends the thought there; it shows on its way" || fail "Enter sends"
ask notch "text .way" | grep -q "Undo" && [ "$(js notch "(b => b.textContent + ' ' + b.disabled)(document.querySelector('.cap-row .key'))")" = "Start false" ] \
  && [ "$(js notch "String((h => !!h && !h.hasAttribute('data-open') && parseFloat(getComputedStyle(h).getPropertyValue('--ms')) > 500)(document.querySelector('.way-hold')))")" = true ] \
  && pass "while it is held it offers Undo, the Composer's key says that Return starts it, and its hold is a line that runs out by the clock" || fail "the thought on its way offers Undo" "$(ask notch "text .way")"
ask notch "click .way .act:not([data-offer])" >/dev/null
until_has notch "eval document.querySelector('#capture-input').value" 3 "Undo me" \
  && pass "Undo stops the thought before it starts and returns its text to the field" || fail "Undo"
# Retyped and saved for later this time: the undone thought leaves no stale copy, and one saved for later can be dropped.
js notch "(__records && document.querySelector('#dest-chip').click(), 1)" >/dev/null
# The choice is a list of its own, one place a line, with the key that sends away while it is open.
until_has notch "text .cap-list" 3 "For later" && [ "$(js notch "String(new Set([...document.querySelectorAll('.cap-list button')].map(b => b.getBoundingClientRect().left)).size === 1 && !document.querySelector('.cap-row .key'))")" = true ] \
  && pass "in the notch the places to send it are one list, a line each, and never wrap" || fail "the destination list"
ask notch "eval ([...document.querySelectorAll('.cap-list button')].find(b=>b.textContent==='For later').click(), 1)" >/dev/null
send "eval notch (document.querySelector('#capture-input').focus(),document.execCommand('selectAll'),document.execCommand('insertText',false,'Drop me'))" "key notch Enter"
until_has notch "eval [...__records.thoughts.values()].map(t=>t.text).join('|')" 3 "Drop me" \
  && ask notch "eval [...__records.thoughts.values()].map(t=>t.text).join('|')" | grep -qv "Undo me" \
  && pass "the undone thought, retyped and saved for later, leaves no stale copy" || fail "Undo and retyping leave one thought"
shot capture-receipt
send "key notch Escape"
js workspace "(__ws.ui.fold = 'later', __motion.redraw(), 1)" >/dev/null
until_has workspace "text .fold-b" 3 "Drop me" || fail "the For later fold lists it"
js workspace "([...document.querySelectorAll('.hr.later')].find(r=>r.textContent.includes('Drop me')).querySelectorAll('.btn')[1].click(), 1)" >/dev/null
until_has workspace "eval String([...__ws.records.thoughts.values()].some(t=>t.text==='Drop me'))" 3 "false" \
  && pass "Drop removes a thought saved for later" || fail "drop a saved thought"
fi

if part "The run, its questions and its result"; then
send "hover in"
until_has notch "eval String(!document.querySelector('#sheet').inert && !!document.querySelector('#sheet .rows .row'))" 10 "true" \
  || fail "the notch opens to its rows"
[ "$(js notch "document.querySelectorAll('canvas').length")" = 0 ] && pass "the open notch carries no chrome form" || fail "the open notch carries no form"
ask notch "click #sheet .rows .row" >/dev/null
until_has workspace "$(screen)" 10 "fixture-agent" && pass "a row in the notch shows the agent's terminal in the workspace" || fail "Open shows the terminal"
# The fixture agent, like Claude Code in a folder it does not trust yet, asks in its terminal first.
term_line "print:Do you trust the files in this folder?"
until_has notch "text #sheet" 10 "trust this folder" && ask notch "text #sheet" | grep -q "Answer in its terminal" \
  && pass "a folder-trust prompt in a starting agent's terminal opens the notch on the prompt, with the action that opens its terminal" \
  || fail "the trust prompt shows in the notch"
shot trust
until_has workspace "text .strip" 5 "asks in its terminal" \
  && pass "the trust prompt shows in its pane's strip, which sends the keyboard to the terminal" || fail "the trust prompt shows in its pane"
# The answer keys always do something (plan, "Where Tasktap shows itself", rule 5): on a question only its terminal
# answers, ⌃⌥Y, ⌃⌥N and ⌃⌥J each bring the window forward at that terminal, and none asks the core to answer it.
inputs=$(grep -c '"event":"input"' "$log")
moved=0
for k in y n j; do
  js workspace "(__ws.show('home'), 1)" >/dev/null
  until_has workspace "eval __ws.ui.view" 3 "home" >/dev/null && send "hotkey $k" && until_has workspace "eval __ws.ui.view" 5 "$project" >/dev/null && moved=$((moved + 1))
done
[ "$moved" = 3 ] && [ "$(grep -c '"event":"input"' "$log")" = "$inputs" ] && [ "$(grep -c '"event":"key","goes":"Question(' "$log")" -ge 3 ] \
  && pass "rule 5: on a question only its terminal answers, ⌃⌥Y, ⌃⌥N and ⌃⌥J each bring the window to that terminal, and none answers for the person" \
  || fail "the answer keys on a terminal question" "$moved of 3"
term_line "event:ready"
until_has notch "eval String(!!document.querySelector('#sheet [data-question]'))" 5 "false" \
  && pass "the agent starting closes the trust question as answered in its terminal" || fail "the trust question closes"
term_line "event:turn_started"
term_line "ask:Deploy to staging?"
until_has notch "text #sheet" 10 "Deploy to staging?" && pass "a question opens the notch by itself on its answer" \
  || fail "the notch opens itself with the question"
ask notch "text #sheet" | grep -q "Hello from the smoke" && ask notch "text .band" | grep -q "project" \
  && pass "it names the thought and the project it belongs to" || fail "the question's context"
# With a question open the notch shows it, never a line that only says one waits; the capture
# shortcut goes to the field under it, and Escape leaves the field with the question still there.
send capture
until_has notch "eval document.activeElement?.id" 5 "capture-input" && ask notch "text #sheet" | grep -q "Deploy to staging?" \
  && ! ask notch "eval document.body.innerText" | grep -qi "question needs you\|questions need you" \
  && pass "with a question open, the capture shortcut opens the field under the question, which stays first" \
  || fail "capture with a question open"
[ "$(js notch "document.querySelector('.cap-agent[data-agent=fixture]')?.dataset.s")" = asks ] \
  && pass "while one of its sessions asks, the agent control's ring takes the attention colour" || fail "an asking agent's ring"
send "key notch Escape"
until_has notch "eval String(!!document.activeElement?.closest('[data-question]'))" 3 "true" && [ "$(js notch "String(!!document.querySelector('#sheet [data-question]'))")" = true ] \
  && pass "Escape leaves the capture line and keeps the question open" || fail "Escape from capture under a question"
shot answer
until_has workspace "text .strip" 5 "Deploy to staging?" && ask workspace "text .strip" | grep -q "Yes" \
  && pass "the same question shows in its pane's strip with the same answers" || fail "the question shows in its pane"
js workspace "(__ws.show('home'), 1)" >/dev/null
until_has workspace "text .needs" 5 "Deploy to staging?" && ask workspace "text .needs" | grep -q "Yes" \
  && pass "Home shows it under Needs you, in full, with its answers" || fail "Home shows the question"
js workspace "(__ws.show('$project'), 1)" >/dev/null
shot pane-question workspace
send affirm
until_has workspace "$(screen)" 10 "answer:yes" && pass "affirm, as its global shortcut sends it, answers the agent" \
  || fail "affirm answers the question"
term_line "ask:Ship it too?"
until_has workspace "text .strip" 10 "Ship it too?" || fail "a second question shows in the pane"
# Speech into the question's reply: the words arrive in the field, and nothing is sent before Return. The voice is a
# tone made in the page, so no microphone is opened; the service is the check's own.
send "call put {\"c\":\"prefs\",\"id\":\"speech_by\",\"patch\":{\"server\":\"http://127.0.0.1:$port\",\"model\":\"fixture-speech\"}}"
echo "yes, and tag the release" > "$tmp/says"
reply="document.querySelector('.strip .reply input')"
until_has workspace "eval String(!!__ws.records.prefs.get('speech_by')?.value)" 3 "true" \
  && js workspace "(__speech.talk.source = 'tone', $reply.focus(), $reply.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', altKey: true, bubbles: true, cancelable: true })), 1)" >/dev/null
until_has workspace "eval document.querySelector('.strip .reply')?.dataset.hears + ' ' + !!document.querySelector('.strip .reply .lvl')" 5 "true true" \
  && pass "⌥Space held in a question's reply field records for that field: its wave shows in the field's own row" || fail "the reply field listens"
sleep 1
js workspace "(document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true })), 1)" >/dev/null
until_has workspace "eval $reply.value + ' ' + __speech.live() + ' ' + __ws.records.dictations.size" 10 "yes, and tag the release false 0" \
  && [ "$(js workspace "String(!!document.querySelector('.strip [data-question]'))")" = true ] && [ "$(ask workspace "$(screen)" | grep -c 'answer:')" = 1 ] \
  && pass "what was said arrives in the reply field as words; the question is still open and nothing was sent to the agent; no microphone and no row is left" || fail "speech into a reply field" "$(js workspace "$reply.value + ' ' + JSON.stringify(__speech.talk)")"
js workspace "($reply.value = '', 1)" >/dev/null
send 'call delete {"c":"prefs","id":"speech_by"}'
press workspace ".strip [data-question]" 1 >/dev/null
# (An earlier answer already printed one "answer:yes", so the first wait is met before this key's own is there: the count
# is waited for, not read once.)
yes_count() { ask workspace "$(screen)" | grep -c 'answer:yes'; }
for _ in $(seq 1 30); do [ "$(yes_count)" = 2 ] && break; sleep 0.3; done
[ "$(yes_count)" = 2 ] \
  && pass "the strip's key 1, pressed while it has the keyboard, answers the agent" || fail "the strip's keys answer"
fi

if part "Where Tasktap shows itself: the window or the notch, one place at a time"; then
# The system never puts a passive run's window in front, so the check says where it is as the system would
# (`where front|behind`, `where full on|off`); nothing here needs the window drawn, so it stays where it is, behind,
# and the keyboard stays where it is throughout. `hotkey` is a key from any app as the system tells of it.
hstate() { send state; sleep 0.5; grep '"event":"state"' "$log" | tail -1 | python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
closed="String(document.querySelector('#sheet').inert)"
glows="String(!!document.querySelector('#notch-art .glow-set'))"
open_q() { echo "eval [...__records.questions.values()].filter(q=>q.state==='open'&&q.prompt==='$1').length"; }
js workspace "(__ws.show('$project'), 1)" >/dev/null
send "where front"
until_has notch "eval __where.front + ' ' + __where.notch" 3 "true false" && [ "$(hstate 'd["notch"]["hidden"]')" = True ] \
  && until_has workspace "eval String(__ws.ui.active)" 3 "true" \
  && pass "rule 1: with Tasktap's window in front the notch is put away, and both pages hear it from the host at once" || fail "the window in front puts the notch away" "$(hstate 'd["where"]')"
term_line "ask:Rule one?"
until_has workspace "text .strip" 10 "Rule one?" && sleep 1 && [ "$(js notch "$closed")" = true ] && [ "$(js workspace "__where.place")" = strip ] \
  && pass "rule 1: a question asked while the window shows its terminal is in the strip under it, and the notch does not open" || fail "a question with the window in front" "$(js workspace "JSON.stringify(__where)")"
js workspace "(__ws.command('settings'), 1)" >/dev/null
until_has workspace "text .asks-line" 5 "Rule one?" && [ "$(js workspace "__where.place")" = line ] \
  && pass "rule 1: elsewhere in the window (Settings) one quiet line in the title bar says who asks and what" || fail "the line that leads to the question" "$(js workspace "JSON.stringify(__where)")"
shot where-line workspace
send "hotkey capture"
until_has workspace "eval __ws.ui.sheet?.kind" 3 "capture" && [ "$(js notch "$closed")" = true ] \
  && pass "rule 1: the capture key over Settings opens New Task in the window, not the notch" || fail "the capture key over a sheet" "$(js workspace "__ws.ui.sheet?.kind")"
js workspace "(__ws.dismiss(), __ws.show('home'), document.activeElement?.blur(), 1)" >/dev/null
until_has workspace "eval __where.place" 3 "needs-you" || fail "on Home the question is in Needs you" "$(js workspace "JSON.stringify(__where)")"
send "hotkey capture"
until_has workspace "eval document.activeElement?.id + ' ' + __ws.ui.sheet" 3 "capture-input null" && [ "$(js notch "$closed")" = true ] \
  && pass "rule 1: on Home the capture key puts the caret in Home's own field and opens nothing" || fail "the capture key on Home"
send "hotkey j"
until_has workspace "eval __ws.ui.view + ' ' + !!document.activeElement?.closest('.strip [data-question]')" 5 "$project true" \
  && pass "rule 5: ⌃⌥J with the window in front goes to the question under its terminal, with the keyboard on its answers" || fail "the answer key in the window"
send "where behind"
until_has notch "eval String(__where.notch)" 3 "true" && [ "$(hstate 'd["notch"]["hidden"]')" = False ] && sleep 1 \
  && [ "$(js notch "$closed")" = true ] && [ "$(js notch "$glows")" = true ] \
  && pass "rule 3: the window going behind with the question unanswered brings the glance back, glowing, and opens nothing" || fail "the window behind with a question waiting"
send answer
until_has notch "text #sheet" 5 "Rule one?" || fail "the answer key opens the notch on the question"
send "where front"
until_has notch "eval $closed" 3 "true" && [ "$(hstate 'd["notch"]["hidden"]')" = True ] \
  && pass "rule 3: the window coming in front folds the open notch: the question is in one place" || fail "the window in front folds the notch"
send "where behind"
send "hotkey y"
until_has notch "$(open_q 'Rule one?')" 10 "0" && until_has workspace "$(screen)" 5 "answer:yes" \
  && pass "rule 5: ⌃⌥Y from another app answers a yes-or-no question through the core" || fail "Yes from another app"
# The pointer is not on the notch: the check's own hover above left it there as far as the page knows.
send "hover out"
term_line "ask:Rule four?"
until_has notch "text #sheet" 10 "Rule four?" && pass "rule 2: with the window behind a question opens the notch by itself" || fail "a question opens the notch"
sleep 8
[ "$(js notch "$closed")" = false ] || fail "the notch stays open for its ten seconds"
until_has notch "eval $closed" 5 "true" && [ "$(js notch "$glows")" = true ] \
  && pass "rule 4: a notch that opened by itself folds after ten seconds untouched; its glow stays while the question waits" || fail "the untouched notch folds"
send answer
until_has notch "eval $closed" 5 "false" && send elsewhere && until_has notch "eval $closed" 3 "true" \
  && pass "rule 6: a click elsewhere folds the open notch, as on Windows" || fail "a click elsewhere folds the notch"
send "hotkey n"
until_has notch "$(open_q 'Rule four?')" 10 "0" && pass "rule 5: ⌃⌥N from another app answers no through the core" || fail "No from another app"
send "where full on"
term_line "ask:Rule six?"
until_has notch "$(open_q 'Rule six?')" 10 "1" && sleep 1 && [ "$(js notch "$closed")" = true ] \
  && grep '"event":"notify"' "$log" | grep '"body":"Rule six?"' | grep -q '"shown":true' \
  && pass "rule 6: over a full-screen app the notch does not open, and the question is the one system notification (said, not posted, by a check)" \
  || fail "a question over a full-screen app" "$(grep '"event":"notify"' "$log" | tail -1)"
send "where full off" "where system"
send "hotkey y"
until_has notch "$(open_q 'Rule six?')" 10 "0" || fail "the last question is answered"
grep '"event":"notify"' "$log" | grep '"body":"Rule one?"' | grep -q '"shown":false' \
  && pass "rule 6: a question while the window or the notch can show it sends no notification" || fail "no notification without full screen"
js workspace "(__ws.show('$project'), 1)" >/dev/null
term_line "event:turn_finished:All green."
until_has notch "text .tab .wing.r" 10 "1" && pass "the collapsed glance counts the result as new" || fail "the glance counts the result"
until_has workspace "eval document.querySelector('.tabw.on .st')?.dataset.s + ' ' + document.querySelector('.row.s.sel .st')?.dataset.s" 5 "ready ready" \
  && pass "the tab and the sidebar row mark the unread result" || fail "the result marks"
shot collapsed-done
shot pane-result workspace
send "hover in"
until_has notch "text #sheet" 5 "All green." && pass "the open notch shows the result's summary" || fail "the result shows"
until_has notch "text #sheet .result" 5 "Open" && pass "the result offers Open" || fail "the result offers Open" "$(ask notch "text #sheet .result" | head -c 200)"
shot result
sleep 2
send "key notch Escape"
until_has notch "eval document.querySelector('.tab .wing.r')?.innerText || 'none'" 5 "none" \
  && pass "a result seen in the notch is marked read and leaves the glance" || fail "seen results are marked read"
fi

if part "The workspace"; then
js workspace "(__ws.command('new-terminal'), 1)" >/dev/null
until_has workspace "$(screen)" 10 "project" || fail "a new terminal shows its shell"
shell=$(js workspace "__ws.current().id")
term_line "echo smoke-\$((6*7))"
until_has workspace "$(screen)" 5 "smoke-42" && pass "a new terminal runs a shell that is typed into and answers" || fail "type and read a shell"
js workspace "(__ws.command('split-right'), 1)" >/dev/null
sleep 1
js workspace "(__ws.command('split-down'), 1)" >/dev/null
until_has workspace "eval JSON.stringify(__ws.layout('$project').tree).match(/\"axis\"/g)?.length" 5 "2" \
  && [ "$(ask workspace "eval document.querySelectorAll('.pane:not([hidden])').length")" = 3 ] \
  && pass "split right then split down nest two splits, each with a fresh terminal" || fail "nested splits"
[ "$(js workspace "String(document.querySelectorAll('.pane.focus').length === 1 && !document.querySelector('.deck-pane-tools, .pane-tools, .toolbar'))")" = true ] \
  && pass "one pane has the keyboard, and no pane carries a toolbar" || fail "the panes' chrome"
shot splits workspace
sleep 1
until_has workspace "eval String([...__ws.engines].every(([id,e])=>!e.element.isConnected||e.element.hidden||(__ws.records.terminals.get(id).cols===e.term.cols&&__ws.records.terminals.get(id).rows===e.term.rows)))" 5 "true" \
  && pass "each shown terminal's size is its process's, after the splits resized it" || fail "terminal sizes follow the panes"
js workspace "(__ws.command('focus'), 1)" >/dev/null
until_has workspace "eval String(document.querySelectorAll('.pane:not([hidden])').length)" 3 "1" \
  && js workspace "(__ws.command('focus'), 1)" >/dev/null \
  && until_has workspace "eval String(document.querySelectorAll('.pane:not([hidden])').length)" 3 "3" \
  && pass "Focus surface shows the selected pane alone, and again all of them" || fail "focus surface"
# Drag the agent's tab onto the bottom edge of the last pane.
js workspace "(()=>{const tab=document.querySelector('.tab');const panes=document.querySelectorAll('.pane');const r=panes[panes.length-1].getBoundingClientRect();const t=tab.getBoundingClientRect();const ev=(k,x,y)=>tab.dispatchEvent(new PointerEvent(k,{bubbles:true,pointerId:7,isPrimary:true,button:0,clientX:x,clientY:y}));ev('pointerdown',t.x+10,t.y+10);ev('pointermove',t.x+30,t.y+30);ev('pointermove',r.x+r.width/2,r.bottom-8);ev('pointerup',r.x+r.width/2,r.bottom-8);return 1})()" >/dev/null
until_has workspace "eval JSON.stringify(__ws.layout('$project').tree).match(/\"axis\"/g)?.length" 5 "3" \
  && pass "dragging a tab to a pane's edge moves it into a new pane there" || fail "drag a tab"
divider=".divider"
ask workspace "eval (document.querySelector('$divider').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})),1)" >/dev/null
r1=$(ask workspace "eval document.querySelector('$divider').getAttribute('aria-valuenow')")
ask workspace "eval (document.querySelector('$divider').dispatchEvent(new MouseEvent('dblclick',{bubbles:true})),1)" >/dev/null
r2=$(ask workspace "eval document.querySelector('$divider').getAttribute('aria-valuenow')")
[ "$r1" = 52 ] && [ "$r2" = 50 ] && pass "a divider resizes and a double-click balances it" || fail "divider" "$r1 then $r2"
shot moved workspace
js workspace "(__ws.focusSession('$shell'), 1)" >/dev/null
js workspace "(__ws.command('find'), 1)" >/dev/null
until_has workspace "text .sheet" 3 "Find in" && pass "Find opens as a sheet that hangs from the title bar and has the keyboard" || fail "the find sheet opens"
ask workspace "eval (document.querySelector('#find-text').value='smoke-42', document.querySelector('#find-text').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})), 1)" >/dev/null
ask workspace "eval (document.querySelector('#find-text').value='no-such-text-here', document.querySelector('#find-text').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})), 1)" >/dev/null
until_has workspace "text #find-state" 3 "Not in the scrollback" && js workspace "String(__ws.engines.get('$shell').search.findNext('smoke-42'))" | grep -q true \
  && pass "Find in terminal finds text in its scrollback and says when it does not" || fail "find"
press workspace ".sheet" Escape >/dev/null
until_has workspace "eval String(!document.querySelector('.sheet'))" 3 "true" && pass "Escape dismisses a sheet" || fail "a sheet dismisses"
# Copy and Paste go through a pasteboard of the check's own: the person's clipboard is never touched.
js workspace "(__ws.engines.get('$shell').term.selectAll(), 1)" >/dev/null
js workspace "(__ws.command('copy'), 1)" >/dev/null
until_has workspace "eval await __ws.call('host.clipboard', {})" 3 "smoke-42" && pass "Copy puts the terminal's selection on the clipboard" || fail "copy"
js workspace "(await __ws.call('host.clipboard', {text: 'echo pasted-one\\necho pasted-two'}), 1)" >/dev/null
js workspace "(__ws.command('paste'), 1)" >/dev/null
until_has workspace "$(screen)" 5 "echo pasted-two" && ! ask workspace "$(screen)" | grep -qx "pasted-one" \
  && pass "Paste is a bracketed paste: both lines reach the prompt and nothing runs" || fail "paste"
js workspace "(__ws.engines.get('$shell').term.input('\\x03', true), 1)" >/dev/null
# An agent chosen from the agents collection starts in a shell of the workspace, which the core adopts.
until_has workspace "eval [...__ws.records.agents.keys()].join(',')" 10 "fixture" || fail "the agents collection lists the fixture agent"
js workspace "(__ws.startAgent('$project', 'fixture'), 1)" >/dev/null
adopted=$(js workspace "__ws.current().id")
until_has workspace "eval String([...__ws.records.sessions.values()].some(s=>s.adopted&&s.terminal_id==='$adopted'))" 10 "true" \
  && pass "a new session with an installed agent runs it in a shell of the workspace, where the core adopts it" || fail "an agent session"
# A terminal that belongs to no project, for signing an agent in.
js workspace "(__ws.newTerminal(__ws.LOOSE, {title: 'Sign in'}), 1)" >/dev/null
loose=$(js workspace "__ws.current().id")
until_has workspace "eval String(__ws.records.terminals.get('$loose')?.project_id)" 5 "null" \
  && ask workspace "text #sidebar" | grep -q "Sign-in terminals" && pass "a sign-in terminal runs with no project and is listed apart" || fail "a sign-in terminal"
js workspace "(__ws.show('home'), 1)" >/dev/null
until_has workspace "text .folds" 5 "Results" || fail "Home has its Results line"
# With nothing running Home opens Results itself; the adopted agent may be at work, so start from it closed.
js workspace "(document.querySelector('.fold-b') && document.querySelector('.folds .fold-h').click(), 1)" >/dev/null
until_has workspace "eval String(!document.querySelector('.fold-b'))" 3 "true" || fail "the Results fold starts closed"
ask workspace "click .folds .fold-h" >/dev/null
until_has workspace "text .fold-b" 3 "Hello from the smoke" && ask workspace "text .fold-b" | grep -q "All results" \
  && pass "a click on Results opens it in place, with the run and All results last" || fail "the Results fold opens"
ask workspace "click .folds .fold-h" >/dev/null
until_has workspace "eval String(!document.querySelector('.fold-b'))" 3 "true" && pass "a second click folds it away" || fail "the Results fold closes"
ask workspace "click .folds .fold-h" >/dev/null
ask workspace "click .fold-b .more" >/dev/null
until_has workspace "text .bar" 3 "Earlier" && ask workspace "text .hx" | grep -q "Hello from the smoke" \
  && pass "All results leads to Earlier, which lists the run by day" || fail "Earlier"
press workspace "#find-thought" Escape >/dev/null
until_has workspace "eval __ws.ui.view" 3 "home" && ! ask workspace "text .bar" | grep -q "Earlier" && pass "Escape goes back to Home" || fail "back from Earlier"
js workspace "(document.querySelector('.home #capture-input').focus(), document.execCommand('insertText', false, 'A thought typed on Home that runs long enough to need a second line of the field, which grows to hold it'), 1)" >/dev/null
until_has workspace "eval String(document.querySelector('.home #capture-input').clientHeight > 44 && !!document.querySelector('.home .capture #dest-chip'))" 3 "true" \
  && [ "$(js workspace "(b => b.textContent + ' ' + b.disabled)(document.querySelector('.home .cap-row .key'))")" = "Start false" ] \
  && pass "Home's capture field grows a line for a longer thought, its destination a chip inside it, its key saying that Return starts it" || fail "Home's capture field"
# Choosing a destination opens in the field's own row: nothing under the field is covered.
js workspace "(document.querySelector('.home #dest-chip').click(), 1)" >/dev/null
inside="((l, f) => l.top >= f.top && l.bottom <= f.bottom && l.left >= f.left && l.right <= f.right)(document.querySelector('.home .cap-list').getBoundingClientRect(), document.querySelector('.home .cap').getBoundingClientRect())"
until_has workspace "text .home .cap-list" 3 "project" && [ "$(js workspace "String($inside)")" = true ] \
  && press workspace ".home .cap-list [aria-selected=true]" Escape >/dev/null \
  && until_has workspace "eval String(!document.querySelector('.cap-list') && document.activeElement.id === 'capture-input')" 3 "true" \
  && pass "the destinations open inside the field, covering no row, and Escape returns to the thought" || fail "choosing a destination on Home"
# "Open another folder…" in that list, pressed as WebKit presses a button (design/ui-directions/NOTES.md §13): the
# press takes no keyboard, and before, the field lost it, the list closed under the pointer and the click never
# landed. Here the press is the app's web view's own event (not a real pointer, which this check never moves): the list
# keeps the keyboard where it is, the click reaches the row, and the folder panel's answer (TASKTAP_PICK) is chosen.
js workspace "(document.querySelector('.home #dest-chip').click(), 1)" >/dev/null
pressed="(b => { const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true }); b.dispatchEvent(down); if (!down.defaultPrevented) document.activeElement?.blur(); return new Promise(r => setTimeout(() => { const row = [...document.querySelectorAll('.home .cap-list button')].find(x => x.textContent.includes('Open another folder')); if (row) (row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })), row.click()); r(String(down.defaultPrevented) + ' ' + !!row); }, 50)); })([...document.querySelectorAll('.home .cap-list button')].find(x => x.textContent.includes('Open another folder')))"
until_has workspace "text .home .cap-list" 3 "Open another folder" && [ "$(js workspace "$pressed")" = "true true" ] \
  && until_has workspace "eval document.querySelector('.home #dest-chip b')?.textContent + ' ' + document.activeElement?.id" 5 "project capture-input" \
  && pass "a press on Open another folder… in the chip's list keeps the keyboard, its click lands, and the folder the panel gives is where the thought goes" || fail "Open another folder… from the chip's list" "$(js workspace "document.querySelector('.home #dest-chip')?.textContent")"
js workspace "(__speech.cap.dest = undefined, __motion.redraw(), 1)" >/dev/null
js workspace "(document.execCommand('selectAll'), document.execCommand('delete'), 1)" >/dev/null
js workspace "(document.querySelector('.fold-b') || document.querySelector('.folds .fold-h').click(), 1)" >/dev/null
ask workspace "click .fold-b .hr" >/dev/null
until_has workspace "$(screen)" 5 "fixture-agent --hook" && [ "$(js workspace "__ws.ui.view")" = "$project" ] \
  && pass "a Home row opens its session's terminal" || fail "a Home row opens its terminal"
js workspace "(__ws.command('new-task'), 1)" >/dev/null
until_has workspace "eval document.querySelector('.sheet #dest-chip')?.textContent" 3 "project" \
  && pass "New task opens the capture line in a sheet, its destination this workspace" || fail "New task"
press workspace ".sheet" Escape >/dev/null
js workspace "(__ws.focusSession('$shell'), __ws.command('bigger'), __ws.command('bigger'), 1)" >/dev/null
cell="(e => e.term.options.fontSize * 0.60205)(__ws.engines.get('$shell'))"
until_has workspace "eval String(__ws.layout('$project').sizes['$shell'] === __ws.engines.get('$shell').size && __ws.layout('$project').sizes['$shell'] > 14 && Math.abs($cell - 10) < 0.01)" 3 "true" \
  && pass "⌘+ enlarges the terminal's text by a whole pixel of cell width each time (8 to 10 in Hack), remembered in its layout" \
  || fail "text size"
# A program in front in the shell: closing its tab asks, naming it (the core's `terminal.runs`).
js workspace "(__ws.engines.get('$shell').term.input('sleep 600\\r', true), 1)" >/dev/null
until_has workspace "eval (await __ws.call('terminal.runs', {id: '$shell'})).what.join(',')" 5 "sleep 600" || fail "the core says what runs in the shell"
js workspace "(__ws.command('close-tab'), 1)" >/dev/null
until_has workspace "text .sheet" 3 "Keep running in background" && ask workspace "text .sheet" | grep -q "Stop session" \
  && ask workspace "text .sheet" | grep -q "sleep 600 is running in it." \
  && pass "closing the tab of a shell where a program runs offers Keep running, Stop and Cancel in a sheet that names the program" || fail "the close sheet" "$(ask workspace "text .sheet")"
shot close-sheet workspace
press workspace ".sheet" Enter >/dev/null
until_has workspace "eval document.querySelector('.row.s.bg')?.innerText" 3 "zsh" && pass "Return keeps it running in the background, listed under its workspace" \
  || fail "the background row"
js workspace "(window.__kept = __ws.engines.get('$shell'), 1)" >/dev/null
[ "$(js workspace "String(!__ws.engines.get('$shell').element.isConnected && [...document.querySelectorAll('.surface')].every(s => s.querySelectorAll('.term:not([hidden])').length <= 1))")" = true ] \
  && pass "its terminal leaves the screen, and each pane shows one terminal" || fail "a backgrounded terminal stays on screen"
shot background workspace
ask workspace "click .row.s.bg" >/dev/null
until_has workspace "$(screen)" 5 "smoke-42" \
  && [ "$(ask workspace "eval __ws.records.terminals.get('$shell').state")" = running ] \
  && pass "restoring it from the sidebar shows its terminal with its history, the same process" || fail "restore from the sidebar"
[ "$(js workspace "String(__ws.engines.get('$shell') === window.__kept && __ws.engines.get('$shell').resumed > 0 && __ws.engines.get('$shell').gaps === 0)")" = true ] \
  && pass "the restored tab continued from where its stream stopped, with no reset" || fail "continue without a reset"
terminals=$(ask workspace "eval __ws.records.terminals.size")
js workspace "(__ws.command('close-tab'), 1)" >/dev/null
until_has workspace "text .sheet" 3 "Stop session" || fail "the close sheet again"
press workspace ".sheet" Backspace true >/dev/null
until_has workspace "eval __ws.records.terminals.get('$shell').state" 5 "exited" && pass "⌘⌫ stops the session" || fail "stop"
sleep 1.5
gone="(l => !__ws.L.tabs(l).includes('$shell') && !l.background.includes('$shell'))"
[ "$(js workspace "String($gone(__ws.layout('$project')) && $gone(__ws.records.layouts.get('$project').tree))")" = true ] \
  && pass "a stopped session leaves the layout, in the page and in the core's record" || fail "the stopped session left the layout"
# A shell with nothing running in it closes at once, by its key and by its row's cross in the sidebar, and ends.
for how in key cross; do
  idle=$(js workspace "__ws.newTerminal('$project')")
  until_has workspace "eval (await __ws.call('terminal.runs', {id: '$idle'})).state" 8 "idle" || fail "the core says a new shell is idle"
  if [ "$how" = key ]; then js workspace "(__ws.focusSession('$idle'), __ws.command('close-tab'), 1)" >/dev/null
  else ask workspace "click .srow[data-id='$idle'] > .x" >/dev/null; fi
  sleep 0.5
  [ "$(js workspace "String(!__ws.ui.sheet && !__ws.L.tabs(__ws.layout('$project')).includes('$idle') && !__ws.layout('$project').background.includes('$idle'))")" = true ] \
    && until_has workspace "eval __ws.records.terminals.get('$idle').state" 5 "exited" \
    && pass "closing a shell with nothing running in it by its $how asks nothing, takes its tab away and ends it" || fail "closing an idle shell by its $how" "$(ask workspace "text .sheet")"
done
terminals=$(ask workspace "eval __ws.records.terminals.size")

# The terminal's font, size and line height are the core's preferences: every terminal takes them at once.
send 'call put {"c":"prefs","id":"terminal_size","patch":16}' 'call put {"c":"prefs","id":"terminal_line_height","patch":120}'
other="[...__ws.engines.values()].find(e => e.id !== '$shell')"
until_has workspace "eval String((e => !!e && Math.abs(e.term.options.fontSize * 0.60205 - 10) < 0.01 && e.term.options.lineHeight === 1.2)($other))" 3 "true" \
  && send 'call delete {"c":"prefs","id":"terminal_size"}' 'call delete {"c":"prefs","id":"terminal_line_height"}' \
  && until_has workspace "eval String((e => Math.abs(e.term.options.fontSize * 0.60205 - 8) < 0.01 && e.term.options.lineHeight === 1)($other))" 3 "true" \
  && pass "the terminal's size and line height are the core's preferences, taken at once in cells of whole pixels, and deleting them restores Default" || fail "the terminal preferences"
fi

if part "The sidebar's slide, and scrolling without bars"; then
# Judged from the page's own frames: the content's left edge and the title move the whole way with the sidebar's edge
# and end where they rest; the terminal beside it keeps its columns until the slide is over and is fitted once.
judge() { python3 -c '
import json, sys
d = json.loads(sys.argv[1]); f = d["frames"]; xs = [a[0] for a in f]; ts = [a[1] for a in f]; way = 1 if xs[-1] > xs[0] else -1
steps = [way * (b - a) for a, b in zip(xs, xs[1:])]
ok = len(f) >= 6 and abs(xs[-1] - xs[0]) > 200 and min(steps) > -0.6 and abs(xs[-1] - d["rest"][0]) < 0.6 and abs(ts[-1] - d["rest"][1]) < 0.6 and max(steps[len(steps) * 2 // 3:] or [0]) < 24
print("ok" if ok else "frames %d, from %s to %s, rests at %s, title %s rests %s, last steps %s" % (len(f), xs[0], xs[-1], d["rest"][0], ts[-1], d["rest"][1], steps[-4:]))' "$1"; }
js workspace "(__ws.show('$project'), 1)" >/dev/null
sleep 0.5
# With reduced motion the sidebar does not slide: the content stands where it rests from the first frame.
still() { python3 -c '
import json, sys
d = json.loads(sys.argv[1]); x, t = d["frames"][0]
print("ok" if [x, t] == d["rest"] else "first at %s, title %s; rests at %s" % (x, t, d["rest"]))' "$1"; }
if [ "$(js workspace "String(document.hidden)")" = true ]; then
  pass "the sidebar's slide: the window is covered, so nothing moves to judge"
elif [ "$reduced" = true ]; then
  cols="$(js workspace "__ws.engines.get(__ws.current().id).term.cols")"
  shut="$(still "$(js workspace "JSON.stringify(await __ws.slide())")")"
  sleep 0.4
  wider="$(js workspace "__ws.engines.get(__ws.current().id).term.cols")"
  open="$(still "$(js workspace "JSON.stringify(await __ws.slide())")")"
  sleep 0.4
  [ "$shut" = ok ] && [ "$open" = ok ] && [ "$wider" -gt "$cols" ] && [ "$(js workspace "__ws.engines.get(__ws.current().id).term.cols")" = "$cols" ] \
    && [ "$(js workspace "String(__ws.ui.sidebar && !__ws.ui.slide && !!document.querySelector('.side'))")" = true ] \
    && pass "with reduced motion the sidebar shuts and opens at once, the content and the title where they rest from the first frame, and the terminal beside it is fitted after" \
    || fail "the sidebar without its slide" "shut: $shut; open: $open; columns $cols, $wider"
else
  cols="$(js workspace "__ws.engines.get(__ws.current().id).term.cols")"
  out="$(js workspace "JSON.stringify(await __ws.slide())")"; shut="$(judge "$out")"
  sleep 0.4
  wider="$(js workspace "__ws.engines.get(__ws.current().id).term.cols")"
  back="$(js workspace "JSON.stringify(await __ws.slide())")"; open="$(judge "$back")"
  sleep 0.4
  [ "$shut" = ok ] && [ "$open" = ok ] && [ "$wider" -gt "$cols" ] && [ "$(js workspace "__ws.engines.get(__ws.current().id).term.cols")" = "$cols" ] \
    && [ "$(js workspace "String(__ws.ui.sidebar && !__ws.ui.slide && !!document.querySelector('.side'))")" = true ] \
    && pass "the sidebar slides shut and open with the content and the title moving with its edge the whole way and ending where they rest, and the terminal beside it is fitted once the slide is over" \
    || fail "the sidebar's slide" "shut: $shut; open: $open; columns $cols, $wider"
fi
# No scroller shows a bar, in either page: none has a width for one, and each says which way there is more instead.
bars="[...document.querySelectorAll('*')].filter(e => { const s = getComputedStyle(e); return /auto|scroll/.test(s.overflowY + s.overflowX) && (s.scrollbarWidth !== 'none' || e.offsetWidth - e.clientWidth - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth) > 0.5); }).map(e => e.tagName + '.' + e.className).join(' ')"
js workspace "(__ws.show('home'), __ws.ui.fold = 'results', __motion.redraw(), 1)" >/dev/null
sleep 0.3
# A sheet taller than the window: it says there is more below, then, scrolled to its end, more above.
js workspace "(__ws.open({ kind: 'settings', at: 'about' }), 1)" >/dev/null
more="document.querySelector('.set-pane').dataset.more"
[ -z "$(js workspace "$bars")" ] && [ -z "$(js notch "$bars")" ] && until_has workspace "eval $more" 3 "down" \
  && js workspace "(document.querySelector('.set-pane').scrollTop = 9999, 1)" >/dev/null && until_has workspace "eval $more" 3 "up" \
  && pass "no scroller in either page shows a bar; one with more beyond an edge says which, for its content to dissolve there" || fail "scrolling without bars" "$(js workspace "$bars") $(js notch "$bars") $(js workspace "$more")"
# Settings is one sheet with its sections at its left: a section by its key, the arrows in the list, and it is the
# window's: on the window's centre with the sidebar open. ⌘W closes it, as it closes whatever is in front.
at="__ws.ui.sheet?.at + ' ' + document.querySelector('.set-nav [aria-selected=true]')?.textContent.replace(/[^A-Za-z]/g, '') + ' ' + document.activeElement?.id"
press workspace ".sheet" 2 true >/dev/null
until_has workspace "eval $at" 3 "agents Agents" && js workspace "(document.querySelector('#set-tab-agents').focus(), 1)" >/dev/null && press workspace "#set-tab-agents" ArrowDown >/dev/null \
  && until_has workspace "eval $at" 3 "placing Placing set-tab-placing" \
  && [ "$(js workspace "(s => String(__ws.ui.sidebar && Math.abs((s.left + s.right) / 2 - innerWidth / 2) <= 0.5 && !document.querySelector('.wake canvas')))(document.querySelector('.sheet').getBoundingClientRect())")" = true ] \
  && pass "Settings is one sheet on the window's centre, the sidebar open: ⌘2 shows Agents, the arrows move through its sections with the keyboard (Placing follows), and no glyphs are shed as it comes" || fail "Settings' sections" "$(js workspace "$at")"
shot settings-projects workspace
js workspace "(__ws.command('close-tab'), 1)" >/dev/null
until_has workspace "eval String(__ws.ui.sheet)" 3 "null" && pass "⌘W closes the sheet in front" || fail "⌘W with a sheet open"
fi

if part "Settings: what Return does, the two keys on one recorder, how long thoughts are kept, the terminal's switches, text size"; then
# A key pressed on the recorder in row `$1`, as the keyboard would: `$2` its code, then which modifiers are held.
record() {
  js workspace "(r => (r.querySelector('.rec[aria-pressed=false]')?.click(), 1))($(setting "$1"))" >/dev/null
  sleep 0.3
  js workspace "(r => (r.querySelector('.rec').dispatchEvent(new KeyboardEvent('keydown', { key: '${2#Key}', code: '$2', ctrlKey: ${3:-false}, altKey: ${4:-false}, shiftKey: ${5:-false}, metaKey: ${6:-false}, bubbles: true, cancelable: true })), 1))($(setting "$1"))" >/dev/null
  sleep 0.6
}
key_row() { echo "eval (r => [r.querySelector('.rec kbd')?.textContent ?? 'no key', r.querySelector('.rec').getAttribute('aria-pressed'), r.querySelector('.hint.err')?.textContent ?? ''].join(' | '))($(setting "$1"))"; }
choose_in() { js workspace "(r => ([...r.querySelectorAll('.seg button')].find((b) => b.textContent === '$2').click(), 1))($(setting "$1"))" >/dev/null; }
pref() { echo "eval JSON.stringify(__ws.records.prefs.get('$1')?.value ?? null)"; }
js workspace "(__ws.show('home'), __ws.open({ kind: 'settings', at: 'thoughts' }), 1)" >/dev/null
until_has workspace "text .set-pane" 5 "Return key when writing a task" || fail "the Thoughts section shows its rows"
# Return: as set, the Composer's key says what sends, and the field does it.
choose_in "Return key when writing a task" "Starts a new line"
until_has workspace "$(pref return_sends)" 3 "false" && foot_of "Return key when writing a task" >/dev/null \
  && until_has workspace "eval document.querySelector('.home .capture .key .key-ret').textContent + ' ' + (document.querySelector('.sheet .sh-hint')?.textContent ?? '')" 3 "⌘ Command-Return sends it; in a reply to an agent, Return always sends." \
  || fail "Return starts a new line, once chosen"
# (Saved for later, so that nothing is placed or started by the check of a key.)
js workspace "(__ws.dismiss(), __speech.cap.dest = 'later', __motion.redraw(), document.querySelector('.home #capture-input').focus(), document.execCommand('insertText', false, 'see whether return sends'), 1)" >/dev/null
before=$(js workspace "__ws.records.thoughts.size")
press workspace ".home #capture-input" Enter >/dev/null
sleep 0.6
held="$(js workspace "document.querySelector('.home #capture-input').value + ' ' + (__ws.records.thoughts.size - $before)")"
press workspace ".home #capture-input" Enter true >/dev/null
until_has workspace "eval document.querySelector('.home #capture-input').value + '|' + (__ws.records.thoughts.size - $before)" 5 "|1" && [ "$held" = "see whether return sends 0" ] \
  && pass "with Return set to start a new line, Return sends nothing and ⌘Return sends the thought; the Composer's key shows ⌘ with Return" || fail "Return as a preference" "$held"
send 'call delete {"c":"prefs","id":"return_sends"}'
until_has workspace "eval String(document.querySelector('.home .capture .key .key-ret').textContent)" 3 "" || fail "Return sends again"
js workspace "(__speech.cap.dest = undefined, (t => t && __ws.call('delete', { c: 'thoughts', id: t.id }).catch(() => 0))([...__ws.records.thoughts.values()].find((t) => t.text === 'see whether return sends')))" >/dev/null
# The keyboard's own names: a Mac's web view cannot say what a key prints, so the host does, from the layout in use.
layout="$(js workspace "__ws.call('host.layout', {}).then((m) => [[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].every((c) => [...(m['Key' + c] ?? '')].length === 1), [...'0123456789'].every((d) => m['Digit' + d]), Object.keys(m).length].join(' '))")"
case "$layout" in "true true "*) pass "the host says what each key prints in the keyboard layout in use, by its place ($(echo "$layout" | cut -d' ' -f3) keys): the names of keys bound by their place" ;; *) fail "the keyboard layout from the host" "$layout" ;; esac
# The capture key: recorded, refused by the rule in its own sentence, registered with the system, and back to the default.
js workspace "(__ws.open({ kind: 'settings', at: 'thoughts' }), 1)" >/dev/null
until_has workspace "$(key_row "Key to start a task, from any app")" 5 "| false |" || fail "the capture key's row"
at_start="$(ask workspace "$(key_row "Key to start a task, from any app")")"
record "Key to start a task, from any app" KeyK
bare="$(ask workspace "$(key_row "Key to start a task, from any app")")"
record "Key to start a task, from any app" Space false false false true
kept="$(ask workspace "$(key_row "Key to start a task, from any app")")"
case "$bare|$kept" in *"A shortcut needs Control, Option (Alt) or Command (the Windows key) held with its key."*"|"*"The system keeps that combination for itself."*) pass "a bare key and a combination the system keeps are refused under the recorder in the rule's own sentences, and the key in use stays (${at_start%% |*})" ;; *) fail "the recorder's refusals" "$bare || $kept" ;; esac
shot settings-key-refused workspace
js workspace "(r => (r.querySelector('.rec').click(), 1))($(setting "Key to start a task, from any app"))" >/dev/null
sleep 0.3
js workspace "(r => (r.querySelector('.rec').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })), 1))($(setting "Key to start a task, from any app"))" >/dev/null
until_has workspace "eval $(setting "Key to start a task, from any app").querySelector('.rec').getAttribute('aria-pressed') + ' ' + __ws.ui.sheet?.kind" 3 "false settings" \
  && pass "Escape leaves the recorder and changes nothing; the sheet stays" || fail "Escape in the recorder"
record "Key to start a task, from any app" F9 true true true
until_has workspace "$(key_row "Key to start a task, from any app")" 5 "⌃⌥⇧F9 | false | " && until_has workspace "$(pref capture_key)" 3 '"code":"F9"' \
  && [ "$(js workspace "__ws.call('host.capture_key', {}).then((r) => r.key?.code)")" = F9 ] && grep -q '"event":"capture-key".*"code":"F9".*"ok":true\|"event":"capture-key".*"ok":true.*"code":"F9"' "$log" \
  && pass "a combination pressed in the recorder is asked of the system through the host, registered, stored as the preference and shown as the key in use (⌃⌥⇧F9)" || fail "a capture key of the person's own" "$(ask workspace "$(key_row "Key to start a task, from any app")")"
shot settings-key-own workspace
js workspace "(r => ([...r.querySelectorAll('.btn')].find((b) => b.textContent === 'Use ⌃⌥Space').click(), 1))($(setting "Key to start a task, from any app"))" >/dev/null
sleep 1
back="$(ask workspace "$(key_row "Key to start a task, from any app")")"
case "$back" in
  "⌃⌥Space | false | ") [ "$(ask workspace "$(pref capture_key)")" = null ] && pass "Use ⌃⌥Space registers the system's own key again and removes the preference" || fail "back to the default key" "$back" ;;
  *"That key is taken by the system or another app."*) [ "$(js workspace "__ws.call('host.capture_key', {}).then((r) => r.key?.code)")" = F9 ] \
    && pass "the default key is held by another app on this Mac: the recorder says so in the host's words, and the key that was registered goes on working (⌃⌥⇧F9)" || fail "a taken key leaves the old one" "$back" ;;
  *) fail "back to the default key" "$back" ;;
esac
shot settings-key-default workspace
# Opening at login: a check's run never asks the system, and its row says so.
until_has workspace "eval (r => r ? r.querySelector('.v')?.textContent + ' | ' + r.querySelectorAll('[role=switch]').length : 'none')($(setting "Open Tasktap when the computer starts"))" 5 \
  "Not for this copy | 0" && foot_of "Open Tasktap when the computer starts" | grep -q "This copy runs for a check, so it never opens by itself." && [ "$(js workspace "__ws.call('host.login', { on: true }).then(() => 'took it', (e) => e.message)")" = "A check's run never opens by itself" ] \
  && ! grep -q '"event":"login"' "$log" \
  && pass "opening at login: the host never asks the system in a check's run, refuses to be set, and the row says why with no switch" || fail "opening at login in a check's run" "$(js workspace "__ws.call('host.login', {}).then(JSON.stringify)")"
# The keys that answer a question from any app: recorded through the host as the capture key is, refused when one
# would be another of Tasktap's keys, and back to the system's own. (No, whose key is N on the usual layouts, where Y
# is Z on a German one.)
until_has workspace "$(key_row "Key to answer No, from any app")" 5 "⌃⌥N | false | " || fail "the No key's row"
# (The capture key as it is now: the system's own, or ⌃⌥⇧F9 where another app on this Mac holds that.)
read -r code control alt shift meta <<< "$(js workspace "__ws.call('host.capture_key', {}).then((r) => [r.key.code, r.key.control, r.key.alt, r.key.shift, r.key.meta].join(' '))")"
record "Key to answer No, from any app" "$code" "$control" "$alt" "$shift" "$meta"
until_has workspace "$(key_row "Key to answer No, from any app")" 3 "Tasktap already uses that combination to start a task." || fail "the capture key refused as the No key" "$(ask workspace "$(key_row "Key to answer No, from any app")")"
record "Key to answer No, from any app" F8 true true true
until_has workspace "$(key_row "Key to answer No, from any app")" 5 "⌃⌥⇧F8 | false | " && until_has workspace "$(pref no_key)" 3 '"code":"F8"' \
  && [ "$(js workspace "__ws.call('host.answer_key', {}).then((r) => r.no?.code + ' ' + r.question?.code + ' ' + r.yes?.code)")" = "F8 KeyJ KeyY" ] \
  && grep -q '"event":"answer-keys".*"code":"F8"' "$log" \
  && pass "an answer key pressed in its recorder is asked of the system through the host, stored as its preference and in use at once (⌃⌥⇧F8 for No)" || fail "a No key of the person's own" "$(ask workspace "$(key_row "Key to answer No, from any app")")"
shot settings-answer-key workspace
js workspace "(r => ([...r.querySelectorAll('.btn')].find((b) => b.textContent === 'Use ⌃⌥N').click(), 1))($(setting "Key to answer No, from any app"))" >/dev/null
sleep 1
back="$(ask workspace "$(key_row "Key to answer No, from any app")")"
case "$back" in
  "⌃⌥N | false | ") [ "$(ask workspace "$(pref no_key)")" = null ] && pass "Use ⌃⌥N gives No the system's own key again and removes the preference" || fail "the No key's default" "$back" ;;
  *"That key is taken by the system or another app."*) [ "$(ask workspace "$(pref no_key)")" != null ] \
    && pass "⌃⌥N is held by another app on this Mac now (the person's own Tasktap holds it while its question waits): the recorder says so, and ⌃⌥⇧F8 stays" || fail "a taken No key" "$back" ;;
  *) fail "the No key's default" "$back" ;;
esac
# Checking for new versions: a build made here never does, says so and has no switch; nothing else leaves for it.
js workspace "(__ws.open({ kind: 'settings', at: 'about' }), 1)" >/dev/null
until_has workspace "eval (r => r.querySelector('.v').textContent + ' | ' + r.querySelectorAll('[role=switch]').length)($(setting "Check for new versions"))" 5 "Not for this copy | 0" \
  && until_has workspace "eval $(setting "Anything else").querySelector('.v').textContent" 3 "Nothing" \
  && pass "a build made here never checks for new versions, says so with no switch, and About's Anything else says Nothing" || fail "Check for new versions in a build made here"
js workspace "(__ws.open({ kind: 'settings', at: 'thoughts' }), 1)" >/dev/null
# When finished thoughts are deleted.
choose_in "Delete finished tasks after" "30 days"
until_has workspace "$(pref keep_days)" 3 "30" && foot_of "Delete finished tasks after" | grep -q "Tasks you have read go that long after they finish, with their answers and terminal history; anything waiting for you stays." \
  && choose_in "Delete finished tasks after" "Never" && until_has workspace "$(pref keep_days)" 3 "0" \
  && pass "when finished thoughts are deleted is one choice, which says that their answers and terminal history go too and that nothing waiting goes" || fail "keep_days"
# The hold-to-talk key: the same recorder, a plain preference the core holds to the rule; every hint follows it.
js workspace "(__ws.open({ kind: 'settings', at: 'voice' }), 1)" >/dev/null
until_has workspace "$(key_row "Key to hold while you talk")" 5 "⌥Space | false | " || fail "the hold-to-talk row"
record "Key to hold while you talk" Space
until_has workspace "$(key_row "Key to hold while you talk")" 3 "A shortcut needs Control" || fail "a bare talk key is refused by the core"
record "Key to hold while you talk" KeyT true
until_has workspace "$(key_row "Key to hold while you talk")" 3 "⌃T | false | " && until_has workspace "eval document.querySelector('.home .capture .mic kbd')?.textContent + ' ' + $(setting "Key to hold while you talk").querySelector('.rec kbd')?.textContent" 3 "⌃T ⌃T" \
  && pass "the hold-to-talk key is recorded the same way and stored as its preference; a bare key is refused in the core's sentence; the Composer's microphone and Settings name the new key at once" || fail "the hold-to-talk key" "$(ask workspace "$(key_row "Key to hold while you talk")")"
shot settings-voice workspace
js workspace "(r => ([...r.querySelectorAll('.btn')].find((b) => b.textContent === 'Use ⌥Space').click(), 1))($(setting "Key to hold while you talk"))" >/dev/null
until_has workspace "$(key_row "Key to hold while you talk")" 3 "⌥Space | false | " && [ "$(ask workspace "$(pref talk_key)")" = null ] || fail "the talk key's default"
# The terminal's two switches, taken by open terminals at once. (A run of --only that opened none has none to take them.)
js workspace "(__ws.open({ kind: 'settings', at: 'terminal' }), 1)" >/dev/null
if [ -n "$only" ] && [ -z "${shell:-}" ]; then echo "NOTE  no terminal is open in this run of --only: the terminal's switches and its scrollback are not tried"; else
opts="(e => e.term.options.drawBoldTextInBrightColors + ' ' + e.term.options.minimumContrastRatio)([...__ws.engines.values()][0])"
until_has workspace "eval $opts" 3 "true 4.5" || fail "the terminals' defaults"
js workspace "(document.querySelectorAll('.set-pane .switch').forEach((s) => s.click()), 1)" >/dev/null
until_has workspace "eval $opts" 3 "false 1" && js workspace "(document.querySelectorAll('.set-pane .switch').forEach((s) => s.click()), 1)" >/dev/null && until_has workspace "eval $opts" 3 "true 4.5" \
  && pass "the terminal's two switches (bold text in bright colours, text kept readable) reach every open terminal at once, and back" || fail "the terminal's switches" "$(js workspace "$opts")"
fi
# Text size: a scale on the type roles of both pages.
js workspace "(__ws.open({ kind: 'settings', at: 'appearance' }), 1)" >/dev/null
sizes="[getComputedStyle(document.body).fontSize, getComputedStyle(document.body).lineHeight, document.documentElement.dataset.text].join(' ')"
choose_in "Text size" "Large"
until_has workspace "eval $sizes" 3 "15px 21px large" && until_has notch "eval $sizes" 3 "15px 21px large" || fail "large text in both pages" "$(js workspace "$sizes") | $(js notch "$sizes")"
shot settings-large workspace
choose_in "Text size" "Small"
until_has workspace "eval $sizes" 3 "12px 17px small" && until_has notch "eval $sizes" 3 "12px 17px small" && choose_in "Text size" "Default" \
  && until_has workspace "eval $sizes" 3 "13px 18px default" && until_has notch "eval $sizes" 3 "13px 18px default" \
  && pass "text size scales the type roles of the workspace and the notch at once: small, default, large" || fail "text size" "$(js workspace "$sizes") | $(js notch "$sizes")"
js workspace "(__ws.dismiss(), 1)" >/dev/null
# The terminal: scrolled back, a pill says how many lines are below and returns to the end.
if [ -z "$only" ] || [ -n "${shell:-}" ]; then
js workspace "(__ws.show('$project'), 1)" >/dev/null
pill="document.querySelector('.term:not([hidden]) .term-more')"
js workspace "(t => new Promise(done => t.write(Array.from({ length: 300 }, (_, i) => 'line ' + i).join('\r\n'), () => (t.scrollLines(-120), done(1)))))(__ws.engines.get(__ws.current().id).term)" >/dev/null
until_has workspace "eval $pill.hidden + ' ' + $pill.textContent" 3 "false ↓ 120 lines⌘↓" && js workspace "($pill.click(), 1)" >/dev/null \
  && until_has workspace "eval String($pill.hidden && (b => b.viewportY === b.baseY)(__ws.engines.get(__ws.current().id).term.buffer.active))" 3 "true" \
  && pass "a terminal scrolled back shows no bar: a pill says how many lines are below, and a click on it returns to the end" || fail "the terminal's scrollback" "$(js workspace "$pill.hidden + ' ' + $pill.textContent")"
fi
fi

if part "Keep and Discard"; then
send "call put {\"c\":\"projects\",\"id\":\"$project\",\"patch\":{\"isolate\":\"always\"}}"
sleep 0.5
# A run that writes a file and exits: its changes come back pending, with nothing still running.
send "call thought.capture {\"id\":\"$(python3 -c 'import uuid,time;t=int(time.time()*1000);b=t.to_bytes(6,"big")+uuid.uuid4().bytes[6:];b=bytearray(b);b[6]=0x70|(b[6]&15);b[8]=0x80|(b[8]&63);print(uuid.UUID(bytes=bytes(b)))')\",\"text\":\"write:kept.txt:hello\",\"strokes\":[],\"source\":\"typed\",\"project_id\":\"$project\"}"
until_has workspace "$(thought 'write:kept.txt:hello' 'workdir?.changes')" 30 "pending" || fail "a run's changes come back pending"
js workspace "(__ws.show('home'), 1)" >/dev/null
until_has workspace "text .waiting" 5 "1 file +1 −0" && ask workspace "text .waiting" | grep -q "Keep" \
  && pass "Home lists a result whose changes wait under Changes waiting, with its diffstat and Keep, Discard and Review changes" || fail "Changes waiting on Home"
shot changes-waiting workspace
ask workspace "click .waiting .hr-a .btn" >/dev/null
until_has workspace "$(thought 'write:kept.txt:hello' 'workdir?.changes')" 30 "kept" && [ -f "$tmp/project/kept.txt" ] \
  && pass "Keep brings the changes into the project's branch" || fail "Keep"
# A run whose agent is still running when its changes come back: Discard stops it first, once confirmed.
before=$(js workspace "__ws.records.terminals.size")
send "call thought.capture {\"id\":\"$(python3 -c 'import uuid,time;t=int(time.time()*1000);b=t.to_bytes(6,"big")+uuid.uuid4().bytes[6:];b=bytearray(b);b[6]=0x70|(b[6]&15);b[8]=0x80|(b[8]&63);print(uuid.UUID(bytes=bytes(b)))')\",\"text\":\"Write a scratch file\",\"strokes\":[],\"source\":\"typed\",\"project_id\":\"$project\"}"
until_has workspace "$(thought 'Write a scratch file' phase)" 15 "working" || fail "the second isolated run starts"
until_has workspace "eval String(__ws.focusSession([...__ws.records.thoughts.values()].find(t=>t.text==='Write a scratch file').session_id))" 10 "true" || fail "its terminal shows"
until_has workspace "$(screen)" 10 "fixture-agent" || fail "its agent runs"
term_line "event:ready"
term_line "event:turn_started"
term_line "write:dropped.txt:bye"
term_line "event:turn_finished:Wrote it."
until_has workspace "text .strip" 30 "1 file +1 −0" && ask workspace "text .strip" | grep -q "Review changes" \
  && pass "the pane shows the result's diffstat with Keep, Discard and Review changes" || fail "the result strip"
press workspace ".strip" r >/dev/null
until_has workspace "text .sheet .files" 5 "dropped.txt" && until_has workspace "text .sheet .code" 5 "bye" \
  && pass "Review changes opens the changed files and the diff in a sheet" || fail "review"
shot review workspace
press workspace ".sheet" d >/dev/null
until_has workspace "text .sheet" 3 "Discard the changes" && ask workspace "text .sheet" | grep -q "Its session is stopped first" \
  && ask workspace "text .sheet" | grep -q "tasktap/" && pass "Discard asks first, says the session is stopped first and what is lost" || fail "the discard sheet"
press workspace ".sheet" Backspace true >/dev/null
until_has workspace "$(thought 'Write a scratch file' 'workdir?.changes')" 30 "discarded" && [ ! -f "$tmp/project/dropped.txt" ] \
  && pass "⌘⌫ stops the session, then discards its changes" || fail "discard"
# Keep refused: the project changed the same line meanwhile; the core's reason and the branch are shown.
send "call thought.capture {\"id\":\"$(python3 -c 'import uuid,time;t=int(time.time()*1000);b=t.to_bytes(6,"big")+uuid.uuid4().bytes[6:];b=bytearray(b);b[6]=0x70|(b[6]&15);b[8]=0x80|(b[8]&63);print(uuid.UUID(bytes=bytes(b)))')\",\"text\":\"write:kept.txt:theirs\",\"strokes\":[],\"source\":\"typed\",\"project_id\":\"$project\"}"
until_has workspace "$(thought 'write:kept.txt:theirs' 'workdir?.changes')" 30 "pending" || fail "a third run's changes come back pending"
echo "mine" > "$tmp/project/kept.txt" && git -C "$tmp/project" commit -qam "Mine"
js workspace "(__ws.show('home'), 1)" >/dev/null
until_has workspace "text .waiting" 5 "Keep" || fail "the third run waits"
ask workspace "click .waiting .hr-a .btn" >/dev/null
until_has workspace "text .waiting .told" 30 "Not kept" && ask workspace "text .waiting .told" | grep -q "conflict with this task's in kept.txt" && ask workspace "text .waiting .told" | grep -q "tasktap/" \
  && pass "a refused Keep says the branch is as it was and shows the core's reason in full: the file in conflict and the branch to merge by hand" || fail "Keep refused" "$(ask workspace "text .waiting")"
# What the core says when it stops short is shown as what it is. A file of the person's in the way: git's own words
# name it, in full; once it is moved away, Keep goes through.
run() { send "call thought.capture {\"id\":\"$(python3 -c 'import uuid,time;t=int(time.time()*1000);b=t.to_bytes(6,"big")+uuid.uuid4().bytes[6:];b=bytearray(b);b[6]=0x70|(b[6]&15);b[8]=0x80|(b[8]&63);print(uuid.UUID(bytes=bytes(b)))')\",\"text\":\"$1\",\"strokes\":[],\"source\":\"typed\",\"project_id\":\"$project\"}"; }
row() { echo ".waiting [data-thought='$(js workspace "[...__ws.records.thoughts.values()].find(t=>t.text==='$1')?.id")']"; }
run "write:way.txt:agent"
until_has workspace "$(thought 'write:way.txt:agent' 'workdir?.changes')" 30 "pending" || fail "a fourth run's changes come back pending"
echo "mine" > "$tmp/project/way.txt"
way="$(row 'write:way.txt:agent')"
ask workspace "click $way .hr-a .btn" >/dev/null
until_has workspace "text $way .told" 30 "Not kept" && ask workspace "text $way .told" | grep -q "way.txt" && [ "$(cat "$tmp/project/way.txt")" = mine ] \
  && pass "a Keep that git refuses, a file of the person's being in the way, names the file in git's own words and touches nothing" || fail "Keep refused by git" "$(ask workspace "text $way")"
rm "$tmp/project/way.txt"
ask workspace "click $way .hr-a .btn" >/dev/null
until_has workspace "$(thought 'write:way.txt:agent' 'workdir?.changes')" 30 "kept" && [ "$(cat "$tmp/project/way.txt")" = agent ] \
  && pass "with the file moved away, Keep again brings the changes in" || fail "Keep after a refusal"
# The changes are in, but git will not remove the copy: said as kept with one thing left, with Tidy up as the action;
# Discard then removes what is left and the result reads as kept, not discarded.
run "write:locked.txt:n"
until_has workspace "$(thought 'write:locked.txt:n' 'workdir?.changes')" 30 "pending" || fail "a fifth run's changes come back pending"
git -C "$tmp/project" worktree lock "$(js workspace "[...__ws.records.thoughts.values()].find(t=>t.text==='write:locked.txt:n').workdir.path")"
locked="$(row 'write:locked.txt:n')"
ask workspace "click $locked .hr-a .btn" >/dev/null
until_has workspace "text $locked .told" 30 "Kept, with one thing left" && [ "$(cat "$tmp/project/locked.txt")" = n ] \
  && [ "$(js workspace "document.querySelector(\"$locked .hr-a .btn\").textContent + ' ' + document.querySelector(\"$locked .told\").getAttribute('role')")" = "Tidy up status" ] \
  && pass "a Keep whose changes are in while its copy stays says so as a success with one thing left, and offers Tidy up" || fail "Keep with the copy left" "$(ask workspace "text $locked")"
ask workspace "click $locked .btn:nth-of-type(2)" >/dev/null
until_has workspace "text .sheet" 3 "The changes stay in main" || fail "the discard sheet after a Keep"
press workspace ".sheet" Backspace true >/dev/null
until_has workspace "$(thought 'write:locked.txt:n' 'workdir?.changes')" 30 "kept" && [ "$(cat "$tmp/project/locked.txt")" = n ] \
  && js workspace "(__ws.ui.fold = 'results', __ws.call('thought.read', { id: [...__ws.records.thoughts.values()].find(t=>t.text==='write:locked.txt:n').id }), __motion.redraw(), 1)" >/dev/null \
  && until_has workspace "text [data-thought='$(js workspace "[...__ws.records.thoughts.values()].find(t=>t.text==='write:locked.txt:n').id")']" 3 "Kept in main" \
  && pass "Discard then removes what is left, and the result reads Kept in main, not discarded" || fail "Discard after a Keep"
# (A result not yet opened is a card, which says what the task did; opened, it is a row, which says where its changes ended.)
# A run that left only an ignored file: its copy cannot be removed by itself and waits, with nothing in it to keep.
run "write:out.log:built"
until_has workspace "$(thought 'write:out.log:built' 'workdir?.changes')" 30 "pending" || fail "a sixth run's copy is left over"
left="$(row 'write:out.log:built')"
until_has workspace "text $left" 5 "Copy left over" && ask workspace "text $left" | grep -q "A copy of the project is left over" \
  && [ "$(js workspace "[...document.querySelectorAll(\"$left :is(.key,.btn)\")].map(b => b.textContent).join('|')")" = "Remove the copy" ] && ! ask workspace "text $left" | grep -q "0 files" \
  && pass "a copy left over with nothing in it to keep says so, with Remove the copy as its one action" || fail "a leftover copy" "$(ask workspace "text $left")"
ask workspace "click $left .hr-a .btn" >/dev/null
until_has workspace "text .sheet" 3 "Remove the copy left by" || fail "the sheet for a leftover copy"
press workspace ".sheet" Backspace true >/dev/null
until_has workspace "$(thought 'write:out.log:built' 'workdir?.changes')" 30 "discarded" && pass "⌘⌫ removes the leftover copy" || fail "removing a leftover copy"
send "call put {\"c\":\"projects\",\"id\":\"$project\",\"patch\":{\"isolate\":\"busy\"}}"
js workspace "(__ws.show('$project'), 1)" >/dev/null
terminals=$(ask workspace "eval __ws.records.terminals.size")
fi

if part "Placing by a model: offered, allowed, briefed, undone, asked, and by name when the model fails"; then
# The model is the fixture agent's: asked as a real one is, it runs the steps written for it and prints its answer.
mkdir -p "$tmp/data/route" "$tmp/other"
says() { printf '%s\n' "$@" > "$tmp/data/route/ask"; }
route_key() { python3 -c 'import json,sys; r=json.loads(open(sys.argv[1]).read().split("<request>\n")[1].rsplit("</request>",1)[0]); print(next(p["id"] for p in r["projects"] if p["name"]==sys.argv[2]))' "$tmp/data/route/asked" "$1"; }
field="document.querySelector('.home #capture-input')"
# Types a thought on Home and sends it; `clear_field` empties the field, which drops a thought that was taken back.
home_says() { js workspace "($field.focus(), document.execCommand('selectAll'), document.execCommand('insertText', false, '$1'), 1)" >/dev/null; send "key workspace Enter"; }
clear_field() { js "${1:-workspace}" "(document.querySelector('#capture-input').focus(), document.execCommand('selectAll'), document.execCommand('delete'), 1)" >/dev/null; }
thoughts() { js workspace "__ws.records.thoughts.size"; }
send 'call put {"c":"prefs","id":"hold","patch":10}'
js workspace "(__ws.call('project.add', { id: __ws.uuid7(), folder: '$tmp/other' }), __ws.show('home'), 1)" >/dev/null
until_has workspace "eval String([...__ws.records.projects.values()].filter(p => p.open && p.kind === 'folder').length) + ' ' + __ws.records.prefs.get('hold')?.value" 5 "2 10" || fail "a second folder is open"
# Not allowed yet: Auto places by a thought's words, so one that names no folder is asked about (never a guess),
# at the Composer, where it was typed, holding the keyboard; nothing else stands under the Composer, and placing by a
# model is one of the welcome's steps.
chip="[...document.querySelectorAll('.home #dest-chip > b, .home #dest-chip > span')].map(e => e.textContent).join(' ')"
[ "$(js workspace "String(__ws.records.prefs.has('route_by'))")" = false ] && [ "$(js workspace "$chip")" = "Auto" ] \
  || fail "before it is allowed, Auto places by a thought's words" "$(js workspace "$chip")"
home_says "Tidy the changelog a little"
until_has workspace "text .home .cap-ask" 5 "Which project is this task for?" && [ "$(js workspace "String(document.activeElement?.id === 'capture-input' && !!document.querySelector('.home .capture .cap-ask') && !document.querySelector('.home .needs [data-question]') && !/(Thoughts|Tasks) can find|Its question is open/.test(document.querySelector('.home .ways').textContent))")" = true ] \
  && pass "the first thought that names no folder is asked about at the Composer, the field keeping the keyboard and its keys answering, not also in Needs you, and nothing else stands under the Composer" || fail "the question at the Composer" "$(ask workspace "text .home .capture" | tr '\n' '|' | cut -c1-200)"
# Who finds the project for a task is agreed to in the welcome's third step, and in Settings, Placing (⌘3, after Agents): its
# switch is the agreement, the placers are rows under it, and what is sent and the instructions open in place.
js workspace "(__ws.open({ kind: 'settings', at: 'placing' }), 1)" >/dev/null
master="[...document.querySelectorAll('.settings [role=switch]')].find((s) => s.getAttribute('aria-label') === 'Find the project for each task')"
until_has workspace "text .set-pane" 5 "Find the project for each task" || fail "Settings has a section Placing with the switch that finds the project for each task"
js workspace "([...document.querySelectorAll('.settings .disc')].find((d) => d.textContent.includes('What is sent')).click(), 1)" >/dev/null
# The signed-in agents in Tasktap's order: what costs nothing more first, the fastest first among those; none on before the switch is.
ranks="[...document.querySelectorAll('.sheet .rank:not(.sign)')].map(r => r.querySelector('.t').textContent + (r.querySelector('.switch').getAttribute('aria-checked') === 'true' ? '' : ' off')).join('|')"
until_has workspace "text .sheet" 5 "goes to the first agent below that answers" && terms="$(ask workspace "text .sheet")" \
  && echo "$terms" | grep -q "Give a task without choosing its place, and one of your own agents decides where the task belongs: which project, and whether an agent already at work there continues" \
  && echo "$terms" | grep -q "the task in your words, and the project or session open in Tasktap's window" && echo "$terms" | grep -q "up to 8 likely projects" \
  && [ "$(js workspace "$ranks")" = "fixture-silent off|Fixture agent off|fixture-probed off" ] \
  && [ "$(js workspace "String([...document.querySelectorAll('.sheet .rank:not(.sign)')].some(r => r.querySelector('.x.m')?.textContent === 'fixture-small' && /about 1 s/.test(r.textContent)))")" = true ] \
  && [ "$(js workspace "String(!document.querySelector('.instr') && $master.getAttribute('aria-checked') === 'false')")" = true ] && [ "$(js workspace "String(__ws.records.prefs.has('route_by'))")" = false ] \
  && pass "Settings, Placing, says what the person gets, which signed-in agents would place the thoughts in Tasktap's order and why, with which model, and exactly what is sent, in place; the switch is off and nothing is stored yet" || fail "the placing section" "$(js workspace "$ranks") $(echo "${terms:-}" | tr '\n' '|' | cut -c1-200)"
js workspace "([...document.querySelectorAll('.settings .disc')].find((d) => d.textContent.includes('The instructions they follow')).click(), 1)" >/dev/null
until_has workspace "text .sheet .instr" 3 "You are the router of Tasktap" && pass "the instructions the model follows are there to read in full, behind one quiet line" || fail "the instructions"
shot placing-terms workspace
# The switch is the agreement, written in Tasktap's order; then the person's own order, by the keyboard, each change written at
# once: the fixture agent up to the first place, the two others switched off.
js workspace "($master.click(), 1)" >/dev/null
until_has workspace "eval $ranks" 5 "fixture-silent|Fixture agent|fixture-probed" || fail "the switch turns every placer on, in Tasktap's order" "$(js workspace "$ranks")"

row_key() { js workspace "(()=>{const r=[...document.querySelectorAll('.sheet .rank:not(.sign)')].find(r=>r.querySelector('.t').textContent==='$1');r?.focus();r?.dispatchEvent(new KeyboardEvent('keydown',{key:'$2',altKey:${3:-false},bubbles:true,cancelable:true}));return !!r})()" >/dev/null; }
row_key "Fixture agent" ArrowUp true
until_has workspace "eval $ranks" 3 "Fixture agent|fixture-silent|fixture-probed" && row_key fixture-silent " "
until_has workspace "eval $ranks" 3 "Fixture agent|fixture-silent off|fixture-probed" && row_key fixture-probed " "
until_has workspace "eval $ranks" 3 "Fixture agent|fixture-silent off|fixture-probed off" || fail "the order by the keyboard" "$(js workspace "$ranks")"
until_has workspace "eval JSON.stringify(__ws.records.prefs.get('route_by')?.value) + String(__ws.ui.sheet?.kind)" 5 '{"agents":[{"agent":"fixture","model":"fixture-small","on":true},{"agent":"fixture-silent","model":"fixture-small","on":false},{"agent":"fixture-probed","model":"fixture-small","on":false}],"terms":5}settings' \
  && pass "the switch writes the agreement, and each change of order and each switch is written at once, with its model and switch, while Settings stays where it is" || fail "the agreement"
js workspace "(__ws.dismiss(), 1)" >/dev/null
# The thought sent before is asked about at the Composer: kept for later by its row's number in the field, then dropped.
press workspace ".home #capture-input" "$(js workspace "String([...document.querySelectorAll('.home .cap-ask .ans span')].findIndex(s => s.textContent === 'Keep for later') + 1)")" >/dev/null
until_has workspace "eval String([...__ws.records.questions.values()].some(q => q.state === 'open'))" 3 "false" || fail "the offered thought is kept for later"
js workspace "(__ws.call('delete', { c: 'thoughts', id: [...__ws.records.thoughts.values()].find(t => t.text === 'Tidy the changelog a little').id }), 1)" >/dev/null
until_has workspace "eval String([...__ws.records.thoughts.values()].some(t => t.text === 'Tidy the changelog a little'))" 3 "false" || fail "the offered thought is dropped"
[ "$(js workspace "document.querySelector('.home #dest-chip b').textContent")" = "Auto" ] \
  && pass "once allowed, a thought with no folder named goes where it belongs: the Composer says so before Return" || fail "the Composer's place once allowed"
# The model is torn between two folders: it answers "ask" with the two. The task is decided to the first and waits on its
# line, Return's key first, the other folder on key 2; nothing starts by itself, and the question card is not asked. The
# person is called as a question calls them (a notification for the task, said by the host, not posted by a check, and
# taken back once the task is decided).
before=$(thoughts)
says 'print:{"quote":"","confidence":"ambiguous","to":"","candidates":["p1","p2"],"brief":"Keep the header on one line.","title":""}'
home_says "so the header thing, I think it should stay on one line"
torn="(w => String(!!w && w.dataset.step === 'held' && w.querySelector('.way-hold')?.hasAttribute('data-open') && !!w.querySelector('.way-h > kbd') && !document.querySelector('.home .cap-ask') && !document.querySelector('.home .needs [data-question]') && ![...__ws.records.questions.values()].some(q => q.state === 'open')))(document.querySelector('.home .way'))"
offers="[...document.querySelectorAll('.home .way [data-offer]')].map(b => b.dataset.offer + ' ' + b.getAttribute('aria-label')).join('|')"
until_has workspace "text .home .way-h" 10 "project new run" && [ "$(js workspace "$torn")" = true ] && [ "$(js workspace "$offers")" = "2 other" ] \
  && [ "$(js workspace "document.querySelector('.home .way .way-to').textContent")" = "project new run" ] \
  && pass "a task the model is torn about is decided to its first choice on one line under the field, waiting for a key with no time running, Return's key first and the other folder on key 2; no question card is asked" || fail "the torn decision on Home" "$(js workspace "$torn") $(js workspace "$offers") $(ask workspace "text .home .way" | tr '\n' '|' | cut -c1-240)"
# The notch: closed, it opens on the same task's line, where Return and the keys decide it (before it folds untouched, ten seconds on).
until_has notch "text #sheet .way-h" 5 "project new run" && [ "$(js notch "String(!document.querySelector('#sheet').inert && !!document.querySelector('#capture-input') && !!document.querySelector('#sheet .way .way-hold[data-open]') && !!document.querySelector('#sheet .way-h > kbd'))")" = true ] \
  && pass "the notch opens by itself on the torn task's line under its capture field, the line waiting for a key, Return's first (the field's keyboard is the page check's: a passive run takes none)" || fail "the torn task in the notch" "$(js notch "JSON.stringify(__where) + ' inert ' + document.querySelector('#sheet').inert + ' hold ' + document.querySelector('#sheet .way .way-hold')?.outerHTML + ' kbd ' + !!document.querySelector('#sheet .way-h > kbd')")  $(ask notch "text #sheet" | tr '\n' '|' | cut -c1-240)"
sleep 4
thought_id="$(js workspace "[...__ws.records.thoughts.values()].find(t => t.text.startsWith('so the header thing'))?.id")"
[ "$(js workspace "(t => t.phase + ' ' + String(!!document.querySelector('.home .way[data-step=held]')))([...__ws.records.thoughts.values()].find(t => t.text.startsWith('so the header thing')))")" = "routed true" ] \
  && pass "four seconds on, past the three a model's sure decision is held, the torn task has not started: it waits for a key" || fail "the torn task waits" "$(js workspace "[...__ws.records.thoughts.values()].find(t => t.text.startsWith('so the header thing'))?.phase")"
grep '"event":"notify"' "$log" | grep "\"question\":\"thought:$thought_id\"" | grep '"title":"Which project is this task for?"' | grep -q '"body":"so the header thing, I think it should stay on one line"' \
  && ! grep '"event":"notify"' "$log" | grep -q "\"withdrawn\":\"thought:$thought_id\"" \
  && pass "the person is called for the torn task as for a question: a system notification with the question and the task's words, still there while it waits" || fail "the torn task's notification" "$(grep '"event":"notify"' "$log" | grep thought: | tail -1)"
shot torn-decision
shot torn-decision-home workspace
js workspace "(document.querySelector('.home .way-more').click(), 1)" >/dev/null
until_has workspace "text .home .way" 3 "Keep the header on one line." && going="$(ask workspace "text .home .way")" && ! echo "$going" | grep -q "[·,]  *new run" \
  && echo "$going" | grep -q "You said" && echo "$going" | grep -q "so the header thing" && echo "$going" | grep -q "Placed by Fixture agent, fixture-small" \
  && [ "$(js workspace "(b => b ? b.textContent + ' ' + b.disabled : 'no key')(document.querySelector('.home .cap-row .key'))")" = "Start false" ] \
  && pass "behind its disclosure the torn task's brief in full, the person's own words and who placed it; the Composer's key Start" || fail "the torn task's brief" "$(echo "${going:-}" | tr '\n' '|' | cut -c1-240)"
shot held-brief workspace
# Key 2 places it anew in the other folder, with the person's hold from then, and the notification is taken back.
press workspace ".home #capture-input" 2 >/dev/null
until_has workspace "text .home .way-h" 5 "other new run" && [ "$(js workspace "String(!document.querySelector('.home .way .way-hold')?.hasAttribute('data-open') && !!document.querySelector('.home .way[data-step=held]'))")" = true ] \
  && grep '"event":"notify"' "$log" | grep -q "\"withdrawn\":\"thought:$thought_id\"" \
  && pass "key 2 places the torn task in the other folder at once, its hold runs from then, and its notification is taken back" || fail "key 2 on the torn task" "$(ask workspace "text .home .way-h" | tr '\n' '|' | cut -c1-200)"
ask workspace "click .home .way .act:not([data-offer])" >/dev/null
until_has workspace "eval $field.value + ' ' + [...__ws.records.thoughts.values()].find(t => t.text.startsWith('so the header thing'))?.phase" 3 "so the header thing, I think it should stay on one line captured" \
  && clear_field && until_has workspace "eval String(__ws.records.thoughts.size)" 3 "$before" \
  && pass "Undo during the hold stops it before anything starts and returns its words to the field" || fail "Undo during the hold"
key="$(route_key project)"
# From the notch, placed by the model: Placing… with Undo while it is asked, then where it goes, what the work is called and the brief.
send "key notch Escape"
says "sleep:1500" "print:{\"quote\":\"\",\"confidence\":\"clear\",\"to\":\"$key\",\"candidates\":[],\"brief\":\"Make the footer half as tall. Leave the links in it as they are.\",\"title\":\"Shorter footer\"}"
send capture
until_has notch "eval document.activeElement?.id" 5 "capture-input" || fail "capture opens for a placed thought"
send "type notch okay the footer, it is way too tall, make it like half, but leave the links" "key notch Enter"
until_has notch "text #sheet .way" 3 "Placing…" && ask notch "text #sheet .way" | grep -q "Undo" \
  && pass "while the model is asked the thought says Placing…, with Undo" || fail "Placing…"
until_has notch "eval String(!!document.querySelector('#sheet .way-more') && !/Placing/.test(document.querySelector('#sheet .way').textContent))" 10 "true" && ask notch "click #sheet .way-more" >/dev/null \
  && until_has notch "text #sheet .way" 3 "Make the footer half as tall." && going="$(ask notch "text #sheet .way")" \
  && echo "$going" | grep -q "project" && echo "$going" | grep -q "Shorter footer" && echo "$going" | grep -q "okay the footer, it is way too tall" \
  && [ "$(js notch "String((h => !!h && !h.hasAttribute('data-open') && parseFloat(getComputedStyle(h).getPropertyValue('--ms')) > 1000)(document.querySelector('.way-hold')))")" = true ] \
  && pass "placed by the model, it shows where it goes in one line for the length of its hold, which is a line that runs out; behind its disclosure what the work is called and the brief" || fail "the placed thought in the notch" "$(echo "${going:-}" | tr '\n' '|' | cut -c1-240)"
until_has workspace "text .home .way" 3 "project " && pass "Home shows the same thought on its way, whoever captured it" || fail "Home shows a thought the notch captured"
shot held-brief-notch
ask notch "click #sheet .way .act:not([data-offer])" >/dev/null
until_has notch "eval document.querySelector('#capture-input').value" 3 "okay the footer" && clear_field notch \
  && until_has workspace "eval String(__ws.records.thoughts.size)" 3 "$before" || fail "the placed thought is taken back"
send "key notch Escape"
# The model fails: nothing places the thought by name while a model is there; the person is asked where it goes, the
# folder its words name first. Answered, it is taken back.
says "print:error:the model is overloaded"
home_says "the footer in project is still too tall for my taste, I said it before and I say it again, please make it a good deal shorter than it is now, about half, and leave everything else on the page exactly as it is"
# The question card is what is asked when no model could decide (here, one that failed): the person's words first, then the
# question, the folder the words name first with the others one under another, Another project…, the Scratchpad and Keep
# for later, every row on its number, as the question stands at the Composer; not also in Needs you, nor a decision line.
until_has workspace "text .home .cap-ask" 10 "Which project is this task for?" && asked="$(ask workspace "text .home .cap-ask")" \
  && echo "$asked" | grep -q "the footer in project is still too tall for my taste" && echo "$asked" | grep -q "Keep for later" \
  && [ "$(js workspace "[...document.querySelectorAll('.cap-ask .ans span')].map(s => s.textContent).join('|')")" = "project|Another project…|Scratchpad|Keep for later" ] \
  && [ "$(js workspace "[...document.querySelectorAll('.cap-ask kbd.keycap')].filter(k => k.offsetParent).map(k => k.textContent).join(' ')")" = "1 2 3 4" ] \
  && [ "$(js workspace "(q => String(!!(q.querySelector('.q-words').compareDocumentPosition(q.querySelector('.q-asks')) & 4) && q.getAttribute('aria-label').startsWith('Which project is this task for? the footer in project')))(document.querySelector('.cap-ask'))")" = true ] \
  && [ "$(js workspace "String(!document.querySelector('.home .way') && !document.querySelector('.home .needs [data-question]') && document.activeElement?.id === 'capture-input')")" = true ] \
  && pass "when the model could not be used nothing is placed by name and no decision is shown: the person is asked at the Composer, its keys the field's, the words first, then the question, the folder the task names, Another project…, the Scratchpad and Keep for later, every row on its number" || fail "the question after the model failed" "$(js workspace "JSON.stringify([[...document.querySelectorAll('.cap-ask .ans span')].map(s => s.textContent), [...document.querySelectorAll('.cap-ask kbd.keycap')].filter(k => k.offsetParent).map(k => k.textContent), document.querySelector('.cap-ask')?.getAttribute('aria-label'), !!document.querySelector('.home .way'), !!document.querySelector('.home .needs [data-question]'), document.activeElement?.id])")"
until_has notch "text #sheet" 5 "Which project is this task for?" && ask notch "text #sheet" | grep -q "the footer in project is still too tall" && ask notch "text #sheet" | grep -q "Keep for later" \
  && pass "the notch opens on the same question by itself, in full" || fail "the question in the notch" "$(ask notch "text #sheet" | tr '\n' '|' | cut -c1-200)"
shot router-question
shot router-question-home workspace
js workspace "(document.querySelector('.cap-ask .ans').click(), 1)" >/dev/null
until_has workspace "eval String(!!document.querySelector('.home .way-more'))" 5 "true" && ask workspace "click .home .way .act:not([data-offer])" >/dev/null
until_has workspace "eval $field.value" 3 "the footer in project" && clear_field && until_has workspace "eval String(__ws.records.thoughts.size)" 3 "$before" || fail "the thought asked about is taken back"
# Settings says what is on, and turns it off. (About, shown last: Settings opens there again; ⌘3 goes to Placing.)
js workspace "(__ws.open({ kind: 'settings', at: 'about' }), 1)" >/dev/null
until_has workspace "text .set-pane" 3 "Show again" || fail "Settings, About, shows the welcome again"
js workspace "(__ws.dismiss(), __ws.command('settings'), 1)" >/dev/null
# (A moment for the sheet to listen: behind a locked screen the page is hidden, and a hidden page takes its time.)
until_has workspace "eval __ws.ui.sheet?.at" 3 "about" && sleep 1 && press workspace ".sheet" 3 true >/dev/null
until_has workspace "eval __ws.ui.sheet?.at" 3 "placing" && foot_of "Find the project for each task" | grep -q "Tasks you do not place go where they belong: Fixture agent decides from earlier tasks and what your agents last answered." && ask workspace "text .settings .ranks" | grep -q "fixture-small" \
  && pass "Settings opens where it was last shown, and under Placing (⌘3) lists who decides where a task you do not place goes, in the person's order, and says in its foot what they decide from" || fail "Settings, Placing" "$(ask workspace "text .sheet .sh-hint")"
shot settings-flows workspace
js workspace "($master.click(), 1)" >/dev/null
until_has workspace "eval JSON.stringify(__ws.records.prefs.get('route_by')?.value) + ' ' + __ws.ui.sheet?.kind" 3 "null settings" && foot_of "Find the project for each task" | grep -q "A task that names its project goes there" \
  && pass "Turning the switch off ends it: the preference holds No, so it is not offered again, and Settings says only tasks that name their project are placed" || fail "turning placing off"
js workspace "(__ws.dismiss(), 1)" >/dev/null
fi

if part "Voice: a speech service chosen, a thought spoken, a failure, and cancel (a tone made in the page; no microphone)"; then
tone() { js "${1:-workspace}" "(__speech.talk.source = 'tone')" >/dev/null; }
mic_down() { js workspace "(document.querySelector('.home .mic').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1 })), 1)" >/dev/null; }
mic_up() { js workspace "(document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })), 1)" >/dev/null; }
quiet() { until_has "${1:-workspace}" "eval String(__speech.live()) + ' ' + __records_size()" 5 "false 0"; }
js workspace "(window.__records_size = () => __ws.records.dictations.size, 1)" >/dev/null
send 'call delete {"c":"prefs","id":"speech_by"}'
until_has workspace "eval String(__ws.records.prefs.has('speech_by'))" 3 "false" || fail "no speech service is chosen"
# Without a service the microphone brings the welcome's last step (nothing of it under the Composer), which says what on this
# Mac needs, as Voice in Settings does; Escape leaves it for Home.
js workspace "(__ws.show('home'), document.querySelector('.home .mic').click(), 1)" >/dev/null
until_has workspace "$stepnow" 3 "Step 4 of 4|Talk instead of typing" && until_has workspace "text .welcome" 5 "Download 574 MB" \
  && ! ask workspace "text .home .ways" | grep -q "Voice needs" \
  && js workspace "(document.querySelector('.welcome .wc').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })), 1)" >/dev/null \
  && until_has workspace "eval String(!document.querySelector('.welcome') && !!document.querySelector('.home .mic'))" 3 "true" \
  && js workspace "(__ws.open({ kind: 'settings', at: 'voice' }), 1)" >/dev/null \
  && until_has workspace "eval __ws.ui.sheet?.kind + ' ' + __ws.ui.sheet?.at" 3 "settings voice" && ask workspace "text .settings" | grep -q "Needs a model first: Whisper large-v3 turbo, 574 MB" \
  && pass "with nothing to turn speech into text the microphone brings the welcome's speech step, which says what on this Mac needs, as Voice in Settings does" || fail "voice with nothing set up"
js workspace "([...document.querySelectorAll('.settings .seg button')].find(b => b.textContent === 'At a speech service').click(), 1)" >/dev/null
until_has workspace "text .sheet" 3 "What it is sent" || fail "the speech sheet opens"
js workspace "(document.querySelectorAll('.terms .seg button')[2].click(), 1)" >/dev/null
sleep 0.3
js workspace "((a, m) => (a.focus(), document.execCommand('insertText', false, 'http://127.0.0.1:$port'), m.focus(), document.execCommand('insertText', false, 'fixture-speech'), 1))(...document.querySelectorAll('.terms input.wide'))" >/dev/null
until_has workspace "text .sheet" 3 "is not https" && sheet="$(ask workspace "text .sheet")" \
  && echo "$sheet" | grep -q "The recording: what the microphone heard" && echo "$sheet" | grep -q "http://127.0.0.1:$port/v1/audio/transcriptions" && echo "$sheet" | grep -q "at most 5 minutes" \
  && [ "$(js workspace "String(__ws.records.prefs.has('speech_by'))")" = false ] \
  && pass "choosing a service shows its address and model, exactly what is sent and where, the five-minute limit, and a warning for an address that is not https, before anything is stored" || fail "the speech sheet" "$(echo "${sheet:-}" | tr '\n' '|' | cut -c1-300)"
shot speech-terms workspace
press workspace ".sheet" Enter >/dev/null
until_has workspace "eval JSON.stringify(__ws.records.prefs.get('speech_by')?.value)" 5 "{\"server\":\"http://127.0.0.1:$port\",\"model\":\"fixture-speech\"}" \
  && until_has workspace "text .settings" 3 "By 127.0.0.1:$port, fixture-speech" && pass "Allow writes the preference for that server and model, and Settings says where speech is turned into text" || fail "allowing a speech service"
# A key is only ever written: once stored, all that shows is that one is, and Remove.
js workspace "((k) => (k.focus(), document.execCommand('insertText', false, 'fixture-key-not-real'), k.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), 1))(document.querySelector('.settings input[type=password]'))" >/dev/null
until_has workspace "text .settings" 5 "Saved in the keychain" && [ "$(js workspace "String(document.body.innerHTML.includes('fixture-key-not-real')) + ' ' + JSON.stringify(__ws.records.prefs.get('keys')?.value)")" = "false [\"http://127.0.0.1:$port\"]" ] \
  && js workspace "([...document.querySelectorAll('.settings .btn')].find(b => b.textContent === 'Remove').click(), 1)" >/dev/null \
  && until_has workspace "eval JSON.stringify(__ws.records.prefs.get('keys')?.value ?? [])" 5 "[]" \
  && pass "a key is written and never shown: Settings says it is saved in the keychain, and Remove takes it away" || fail "the key field"
language() { js workspace "([...document.querySelectorAll('.settings .seg [role=checkbox]')].find(b => b.textContent === '$1').click(), 1)" >/dev/null; }
language German
until_has workspace "eval JSON.stringify(__ws.records.prefs.get('speech_languages')?.value)" 3 '["de"]' && language English
until_has workspace "eval JSON.stringify(__ws.records.prefs.get('speech_languages')?.value)" 3 '["de","en"]' && pass "the languages spoken are a small choice, German and English first" || fail "the languages"
js workspace "(__ws.dismiss(), __ws.show('home'), 1)" >/dev/null
# A thought spoken into the empty Composer: the wave follows the level the core hears, and letting go sends it.
before=$(thoughts)
tone
echo "Make the header stay on one line in project" > "$tmp/says"
: > "$tmp/speech.log"
js workspace "($field.focus(), 1)" >/dev/null
mic_down
until_has workspace "text .home .hear" 5 "Listening" && until_has workspace "eval String(__speech.live() && [...__ws.records.dictations.values()][0]?.level > 20 && __ws.ui.voice && parseFloat(document.querySelector('.home .hear .lvl').style.getPropertyValue('--l')) > 0.2)" 5 "true" \
  && pass "holding the microphone records: the row says Listening, its wave follows the level the core hears, and the motion listens" || fail "recording" "$(js workspace "JSON.stringify([__speech.live(), [...__ws.records.dictations.values()], __ws.ui.voice, __speech.talk])" | cut -c1-300)"
shot recording workspace
sleep 1.2
mic_up
until_has workspace "eval [...__ws.records.thoughts.values()].find(t => t.source === 'voice')?.text + ' ' + __speech.live() + ' ' + __ws.records.dictations.size" 10 "Make the header stay on one line in project false 0" \
  && until_has workspace "eval String(!!document.querySelector('.home .way-more'))" 3 "true" && ask workspace "click .home .way-more" >/dev/null && until_has workspace "text .home .way" 3 "You said" \
  && pass "letting go stops the recording at once; what was said becomes a thought on its way, with its hold and Undo, its words there to read" || fail "a spoken thought" "$(js workspace "JSON.stringify([[...__ws.records.dictations.values()], __speech.talk])" | cut -c1-300)"
heard="$(tail -1 "$tmp/speech.log")"
echo "$heard" | python3 -c 'import sys; p, rate, ch, bits, s, peak, hz = sys.stdin.read().split(); sys.exit(0 if (p, rate, ch, bits) == ("/v1/audio/transcriptions", "16000", "1", "16") and 1.0 < float(s) < 6 and int(peak) > 3000 and 200 < float(hz) < 240 else 1)' \
  && pass "the service was sent what the page recorded: 16 kHz, one channel, 16 bits, as long as it was held, with the tone in it ($heard)" || fail "the recording as the service got it" "$heard"
shot spoken-thought workspace
ask workspace "click .home .way .act:not([data-offer])" >/dev/null
until_has workspace "eval $field.value" 3 "Make the header stay on one line in project" && clear_field && until_has workspace "eval String(__ws.records.thoughts.size)" 3 "$before" || fail "the spoken thought is taken back"
# E while a new thought records ends it as its words: they are in the field to be edited, and nothing is captured.
js workspace "($field.focus(), 1)" >/dev/null
mic_down
until_has workspace "text .home .hear" 5 "Edit first" && [ "$(js workspace "document.querySelector('.home .hear kbd').textContent + ' ' + __speech.talk.kind")" = "E thought" ] \
  && pass "while a new thought is spoken the listening line says what letting go does and names the key that ends it as words: E, Edit first" || fail "the listening line names Edit first" "$(ask workspace "text .home .hear")"
sleep 1
js workspace "($field.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e', altKey: true, bubbles: true, cancelable: true })), 1)" >/dev/null
until_has workspace "eval $field.value + ' ' + __speech.live() + ' ' + __ws.records.dictations.size + ' ' + __ws.records.thoughts.size + ' ' + !document.querySelector('.home .way')" 10 "Make the header stay on one line in project false 0 $before true" \
  && pass "E ends a spoken thought as its words: they are in the field to edit, nothing was captured or placed, and no microphone or row is left" || fail "a spoken thought ended as words" "$(js workspace "$field.value + ' ' + JSON.stringify(__speech.talk) + ' ' + __ws.records.thoughts.size")"
mic_up
clear_field
# Into a field that holds text: the words arrive at the caret and nothing is sent.
js workspace "($field.focus(), document.execCommand('insertText', false, 'First this, then'), 1)" >/dev/null
echo "the header on one line" > "$tmp/says"
js workspace "($field.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', altKey: true, bubbles: true, cancelable: true })), 1)" >/dev/null
until_has workspace "text .home .hear" 5 "Let go to add it" || fail "holding ⌥Space in a field that holds text records for the field"
sleep 1
js workspace "(document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true })), 1)" >/dev/null
until_has workspace "eval $field.value + ' ' + __speech.live() + ' ' + __ws.records.dictations.size + ' ' + __ws.records.thoughts.size" 10 "First this, then the header on one line false 0 $before" \
  && pass "⌥Space held in a field that holds text puts the words at its caret; nothing is sent, and no microphone or row is left" || fail "speech into a field" "$(js workspace "$field.value + ' ' + JSON.stringify(__speech.talk)")"
clear_field
# Escape cancels at any point: nothing is captured.
mic_down
until_has workspace "text .home .hear" 5 "Listening" && js workspace "(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })), 1)" >/dev/null
quiet && [ "$(thoughts)" = "$before" ] && [ "$(js workspace "String(!document.querySelector('.home .hear'))")" = true ] \
  && pass "Escape while recording cancels it: nothing is captured, and the microphone is off" || fail "cancel"
mic_up
# The service fails: the core's sentence as it is, and a way to dismiss it.
send "call put {\"c\":\"prefs\",\"id\":\"speech_by\",\"patch\":{\"server\":\"http://127.0.0.1:$port\",\"model\":\"fixture-fail\"}}"
until_has workspace "eval __ws.records.prefs.get('speech_by')?.value.model" 3 "fixture-fail" || fail "the failing service is chosen"
js workspace "($field.focus(), 1)" >/dev/null
mic_down
until_has workspace "text .home .hear" 5 "Listening" && sleep 1 && mic_up
until_has workspace "text .home .way.failed" 10 "The speech service failed (500)" && ask workspace "text .home .way.failed" | grep -q "The model is on fire" && [ "$(js workspace "String(__speech.live())")" = false ] \
  && pass "a failed dictation shows the core's sentence as it is, with the microphone off" || fail "a failed dictation" "$(ask workspace "text .home .ways" | tr '\n' '|' | cut -c1-200)"
shot speech-failed workspace
js workspace "([...document.querySelectorAll('.home .way.failed .act')].at(-1).click(), 1)" >/dev/null
quiet && [ "$(thoughts)" = "$before" ] && pass "Dismiss removes it, and nothing was captured" || fail "dismissing a failed dictation"
send 'call delete {"c":"prefs","id":"speech_by"}' 'call delete {"c":"prefs","id":"speech_languages"}' 'call put {"c":"prefs","id":"hold","patch":2}'
fi

if part "An agent for one thought; what the host opens; links in a terminal; a session's details; a terminal open in 8 places"; then
# The agent picked goes with the thought written under it, and with no other: the next is the default's again.
js workspace "(document.querySelector('.home .cap-agent').click(), 1)" >/dev/null
until_has workspace "eval String(!!document.querySelector('.home .agent-list'))" 3 "true" || fail "the agent control opens its list"
other="$(js workspace "document.querySelector('.home .agent-list [data-agent^=fixture-]:not([data-s=off])')?.dataset.agent ?? ''")"
if [ -n "$other" ]; then
  js workspace "(document.querySelector('.home .agent-list [data-agent=$other]').click(), __speech.cap.dest = 'later', 1)" >/dev/null
  home_says "Let the other agent have this one"
  until_has workspace "$(thought 'Let the other agent have this one' agent) + ' ' + __ws.records.prefs.get('agent').value + ' ' + __speech.cap.agent + ' ' + document.querySelector('.home .cap-agent').dataset.agent" 5 "$other fixture undefined fixture" \
    && pass "a thought sent with an agent picked from the list is that agent's ($other); the default stays, and the control shows the default again for the next thought" || fail "an agent picked for one thought" "$(js workspace "JSON.stringify([__speech.cap.agent, __speech.cap.refused])")"
  js workspace "(__ws.call('delete', { c: 'thoughts', id: [...__ws.records.thoughts.values()].find(t => t.text === 'Let the other agent have this one').id }), 1)" >/dev/null
else
  fail "an agent picked for one thought" "the fixture core lists no second agent"
fi
# An agent the core will not run a thought with: its sentence is under the field, and the words are back in it.
js workspace "(__speech.cap.agent = 'nobody', __speech.cap.dest = 'later', 1)" >/dev/null
home_says "Nobody can run this"
until_has workspace "text .home .way.failed" 5 "Tasktap has no agent nobody." && [ "$(js workspace "$field.value + ' ' + __speech.cap.agent")" = "Nobody can run this nobody" ] \
  && pass "a thought the core refuses for its agent says why under the field, in the core's sentence, and its words and its agent are back" || fail "a refused agent" "$(ask workspace "text .home .ways" | cut -c1-200)"
js workspace "(__speech.cap.agent = undefined, __speech.cap.dest = undefined, 1)" >/dev/null
clear_field
js workspace "(__ws.show('$project'), 1)" >/dev/null

# The host's rule for opening, asked as a page asks: a web address, or what exists inside a folder the person opened.
real="$(cd "$tmp/project" && pwd -P)"
echo "not yours" > "$tmp/outside.txt" && ln -s "$tmp/outside.txt" "$tmp/project/way-out.txt"
host_open() { js workspace "__ws.call('host.open', $1)"; }
: > "$tmp/opened"
o1="$(host_open "{ target: '.gitignore', cwd: '$tmp/project' }")"
o2="$(host_open "{ target: 'https://example.com/docs?a=1' }")"
o3="$(host_open "{ target: '$tmp/project/.gitignore', reveal: true }")"
o4="$(host_open "{ target: '.', cwd: '$tmp/project' }")"
sleep 0.6
opened="$(sort "$tmp/opened" | tr '\n' '|')"
if [ "$o1|$o2|$o3|$o4" = "$real/.gitignore|https://example.com/docs?a=1|$real/.gitignore|$real" ] && [ "$opened" = "-R $real|-R $real/.gitignore|-t $real/.gitignore|-u https://example.com/docs?a=1|" ]; then
  pass "the host opens a web address in the browser and a file of text inside an opened folder in the text editor, and shows a file on request, and a folder, in Finder (to the check's own opener: nothing was opened here)"
else
  fail "what the host opens" "$o1|$o2|$o3|$o4 || $opened"
fi
refused=""
for no in "{ target: '/etc/hosts' }" "{ target: 'file:///etc/hosts' }" "{ target: '../outside.txt', cwd: '$tmp/project' }" "{ target: 'way-out.txt', cwd: '$tmp/project' }" "{ target: 'no-such-file.txt', cwd: '$tmp/project' }" \
  "{ target: 'x-apple.systempreferences://general' }" "{ target: 'https://' }" "{ target: '.gitignore' }"; do
  case "$(host_open "$no")" in error:*) ;; *) refused="$refused $no" ;; esac
done
sleep 0.3
count="$(wc -l < "$tmp/opened" | tr -d ' ')"
probe="$(host_open "{ target: '/etc/hosts', probe: true }")"
[ -z "$refused" ] && [ "$count" = 4 ] && [ "$probe" = None ] \
  && host_open "{ target: '../outside.txt', cwd: '$tmp/project' }" | grep -q "outside the folders you opened in Tasktap" \
  && pass "the host refuses, in a sentence, a path outside the opened folders (by name, through .., through a link that leads out), one that does not exist, one with no folder to start from, and any address that is not http or https; nothing was opened" \
  || fail "what the host refuses" "$refused | $count | $probe"

# In a real terminal: what it prints is found, a path only where the host says it exists inside the folder.
shell="$(js workspace "__ws.newTerminal('$project')")"
until_has workspace "eval __ws.records.terminals.get('$shell')?.state + ' ' + __ws.engines.get('$shell')?.attached" 10 "running true" || fail "a shell for the links"
sleep 1
term_line "echo see .gitignore:1 and https://example.com/docs, not /etc/hosts or missing.txt"
links="(async () => { const e = __ws.engines.get('$shell'), out = []; for (let y = 1; y <= e.term.buffer.active.length; y++) out.push(...(await e.links(y))); return out; })()"
found="$links.then((l) => (t => [t.includes('.gitignore:1'), t.includes('https://example.com/docs'), t.some((x) => x.includes('/etc/hosts') || x.includes('missing.txt'))].join(' '))(l.map((x) => x.text)))"
until_has workspace "eval $found" 8 "true true false" \
  && pass "a real terminal's links are the web address and the path that exists in its folder, with its line; a path outside the folder and one that does not exist are none" || fail "links in a real terminal" "$(js workspace "$links.then((l) => l.map((x) => x.text).join('|'))")"
: > "$tmp/opened"
js workspace "$links.then((l) => { const f = l.find((x) => x.text === '.gitignore:1'); f.activate({ metaKey: false, shiftKey: false }, f.text); f.activate({ metaKey: true, shiftKey: false }, f.text); f.activate({ metaKey: true, shiftKey: true }, f.text); return 1; })" >/dev/null
sleep 0.6
[ "$(sort "$tmp/opened" | tr '\n' '|')" = "-R $real/.gitignore|-t $real/.gitignore|" ] \
  && pass "a plain click on a link opens nothing; with ⌘ the host opens the file, and with ⇧⌘ shows it in Finder" || fail "a link followed" "$(tr '\n' '|' < "$tmp/opened")"

# A session's details: what it is, and its turns, from the records and the core's history.
sid="$(js workspace "[...__ws.records.sessions.values()].filter((s) => __ws.records.terminals.has(s.terminal_id ?? '')).sort((a, b) => b.turn - a.turn)[0]?.id ?? ''")"
if [ -n "$sid" ]; then
  js workspace "(__ws.focusSession('$sid'), __ws.command('session'), 1)" >/dev/null
  said="$(js workspace "(s => [...__ws.records.thoughts.values()].find(t => t.session_id === s.id)?.text ?? '')(__ws.records.sessions.get('$sid'))")"
  until_has workspace "eval String(__ws.ui.sheet?.kind === 'session' && document.querySelectorAll('.sheet .sx .line').length === 2 && document.querySelectorAll('.sheet .tn').length >= 1 && !!document.querySelector('.sheet .sh-f .key') && document.querySelectorAll('.sheet .sh-f .act').length >= 2)" 5 "true" \
    && ask workspace "text .sheet" | grep -q "Fixture agent" && { [ -z "$said" ] || ask workspace "text .sheet .sx" | grep -qF "$said"; } \
    && pass "⌘I shows a session's details in one sheet: its agent and state, its folder, what can be done, and each turn as the thought that began it ($(js workspace "document.querySelectorAll('.sheet .tn').length") of $(js workspace "__ws.records.sessions.get('$sid').turn") turns)" || fail "a session's details" "$(ask workspace "text .sheet" | tr '\n' '|' | cut -c1-300)"
  shot session-details workspace
  press workspace ".sheet" Escape >/dev/null
  until_has workspace "eval String(__ws.ui.sheet)" 3 "null" || fail "the session sheet closes"
else
  fail "a session's details" "no session with a terminal"
fi

# One more view than a terminal allows: the pane says so in the core's words, and nothing is asked for again by itself.
js workspace "(__ws.focusSession('$shell') || __ws.show('$project'), 1)" >/dev/null
# (The eight are the host's own: it holds their streams open and reads nothing from them.)
js workspace "(__ws.engines.get('$shell').detach(), 1)" >/dev/null
for _ in 1 2 3 4 5 6 7 8; do send "call terminal.open {\"id\":\"$shell\",\"cols\":80,\"rows\":24,\"credit\":0}"; done
sleep 0.5
js workspace "(__motion.redraw(), 1)" >/dev/null
until_has workspace "text .pane .strip[data-full]" 5 "This terminal is open in 8 places already." \
  && pass "a terminal that is open in 8 places says so, in the core's words, in the pane where a ninth view would open" || fail "a terminal open in 8 places" "$(js workspace "JSON.stringify([...__ws.ui.full])")"
shot terminal-full workspace
js workspace "(__ws.call('terminal.stop', { id: '$shell' }), 1)" >/dev/null
until_has workspace "eval __ws.records.terminals.get('$shell')?.state" 8 "exited" && js workspace "(__ws.focusSession('$shell'), __ws.command('close-tab'), 1)" >/dev/null
rm -f "$tmp/project/way-out.txt"
fi

if part "Previews beside a terminal: what a link opens, each kind, what a frame is held to, an agent's own, staying current"; then
# A web server of the check's own on this machine, and a project with one file of each kind.
# It says its port once it has tried how this machine reaches it by another name: `localhost.` asks the resolver,
# which on a runner takes seconds. Its line is waited for, up to half a minute, not for a moment.
python3 "$host/scripts/frame-fixture.py" "$tmp/frames.log" "$host/scripts/frame-probe.html" > "$tmp/frames.port" &
for _ in $(seq 1 300); do [ -s "$tmp/frames.port" ] && break; sleep 0.1; done
read -r fport remote < "$tmp/frames.port"
[ -n "$fport" ] || fail "the check's own web server for frames said no port in half a minute"
real="$(cd "$tmp/project" && pwd -P)"
printf '# Smoke notes\n\nWritten by **the agent**. See [the log](plain.txt) and https://example.com/docs.\n\n<script>document.title = "ran"</script>\n\n- [x] one\n- [ ] two\n' > "$tmp/project/notes.md"
echo "plain words" > "$tmp/project/plain.txt"
echo "beside" > "$tmp/project/beside.txt"
python3 -c "
import zlib, struct, sys
w, h = 320, 200
raw = b''.join(b'\x00' + b''.join(bytes((40 + x * 200 // w, 60 + y * 150 // h, 190, 255)) for x in range(w)) for y in range(h))
chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
open(sys.argv[1], 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
open(sys.argv[2], 'wb').write(b'%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 40 100 Td (Fixture PDF) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
open(sys.argv[3], 'w').write('a line of the log that goes on and on\n' * 70000)
open(sys.argv[4], 'wb').write(bytes(range(256)) * 8)
" "$tmp/project/shot.png" "$tmp/project/paper.pdf" "$tmp/project/big.log" "$tmp/project/data.bin"
echo '<!doctype html><title>Report</title><body style="font:16px system-ui;margin:24px"><h1>Report</h1><p>Written by the agent.</p><img src="shot.png" width="160">' > "$tmp/project/report.html"
js workspace "(__ws.show('$project'), 1)" >/dev/null
pshell="$(js workspace "__ws.newTerminal('$project')")"
until_has workspace "eval __ws.records.terminals.get('$pshell')?.state + ' ' + __ws.engines.get('$pshell')?.attached" 10 "running true" || fail "a shell for the previews"
sleep 1
term_line "echo notes.md plain.txt shot.png paper.pdf report.html big.log data.bin http://127.0.0.1:$fport/ https://example.com/docs"
plinks="(async () => { const e = __ws.engines.get('$pshell'), out = []; for (let y = 1; y <= e.term.buffer.active.length; y++) out.push(...(await e.links(y))); return out; })()"
# A link of the terminal, followed as a ⌘-click follows it; `$2`: with ⌥ or ⇧ as well.
click() { js workspace "$plinks.then((l) => { const f = l.find((x) => x.text === '$1'); f?.activate({ metaKey: true, shiftKey: '${2:-}' === 'shiftKey', altKey: '${2:-}' === 'altKey' }, f.text); return !!f; })" >/dev/null; }
shown() { echo "eval [...__ws.records.previews.values()].filter((p) => p.terminal_id === '$pshell').map((p) => p.title + ':' + p.kind + ':' + p.by).join(' ')"; }
# What the preview in front shows: its kind, and its words.
front="(p => p ? p.dataset.kind + ' ' + p.querySelector('.pv-b, .pv-f')?.tagName + ' ' + (p.querySelector('.pv-b')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 300) : 'none')(document.querySelector('.pane:not([hidden]) > .pv'))"
until_has workspace "eval $plinks.then((l) => ['shot.png', 'data.bin', 'https://example.com/docs'].every((t) => l.some((x) => x.text === t)))" 8 "True" || fail "the links of the previews' terminal" "$(js workspace "$plinks.then((l) => l.map((x) => x.text).join('|'))")"
selected="$(js workspace "__ws.layout('$project').selected")"
panes_before=$(js workspace "__ws.L.panes(__ws.layout('$project')).length")
: > "$tmp/opened"
click notes.md
until_has workspace "$(shown)" 5 "notes.md:file:person" && until_has workspace "eval $front" 5 "markdown DIV Smoke notes" \
  && [ "$(js workspace "__ws.L.panes(__ws.layout('$project')).length - $panes_before")" = 1 ] \
  && [ "$(js workspace "String(__ws.layout('$project').selected === '$selected' && __ws.current().id === '$pshell')")" = true ] \
  && pass "⌘-click on a Markdown file's path shows it beside its terminal, in a pane of its own at the terminal's right, and the terminal keeps the keyboard" || fail "a Markdown preview" "$(js workspace "$front")"
[ "$(js workspace "(p => String(p.innerText.includes('<script>document.title = \"ran\"</script>') && !p.querySelector('script, iframe') && document.title !== 'ran' && !!p.querySelector('h1') && p.querySelectorAll('li').length === 2 && p.querySelectorAll('a').length === 2))(document.querySelector('.pv .md'))")" = true ] \
  && pass "Markdown is drawn by the page as text in its roles: a heading, a list, links; raw HTML in it is shown as the words it is and nothing of it runs" || fail "Markdown as text" "$(js workspace "document.querySelector('.pv .md')?.innerHTML.slice(0, 400)")"
shot preview-markdown workspace
click plain.txt
click notes.md altKey
click notes.md shiftKey
click https://example.com/docs
sleep 0.8
[ "$(sort "$tmp/opened" | tr '\n' '|')" = "-R $real/notes.md|-t $real/notes.md|-t $real/plain.txt|-u https://example.com/docs|" ] && [ "$(js workspace "__ws.records.previews.size")" = 1 ] \
  && pass "a file of text still goes to the editor and a web address that is not this machine's to the browser; ⌥⌘-click opens a previewed file in the editor instead, ⇧⌘-click shows it in Finder (to the check's own opener)" || fail "what still opens elsewhere" "$(tr '\n' '|' < "$tmp/opened")"
click plain.txt altKey
until_has workspace "eval $front" 5 "text DIV plain words" && pass "⌥⌘-click on a file of text shows it beside the terminal instead, as text" || fail "a text preview" "$(js workspace "$front")"
click big.log altKey
until_has workspace "eval $front.slice(0, 40) + ' ' + document.querySelector('.pv .pv-cut')?.innerText" 8 "It goes on" && [ "$(js workspace "String(document.querySelector('.pv pre').textContent.length <= 262144)")" = true ] \
  && pass "text longer than the page draws says that only its beginning is shown, and offers the editor" || fail "cut text" "$(js workspace "$front.slice(0, 80)")"
shot preview-cut workspace
click shot.png
until_has workspace "eval $front + ' ' + (i => i && i.naturalWidth + 'x' + i.naturalHeight + ' ' + (i.getBoundingClientRect().width <= i.parentElement.clientWidth))(document.querySelector('.pv-p img')) + ' ' + document.querySelector('.pv-n')?.textContent" 8 "320x200 true 320 × 200" \
  && js workspace "(document.querySelector('.pv-p img').click(), 1)" >/dev/null \
  && until_has workspace "eval String(document.querySelector('.pv-p.real img')?.getBoundingClientRect().width)" 3 "320" \
  && pass "a picture is shown fitted, with its size said, and at its real size on a click" || fail "a picture preview" "$(js workspace "$front")"
shot preview-picture workspace
click data.bin altKey
until_has workspace "eval $front" 5 "other DIV No preview" && pass "a file of a kind nothing shows says so, and offers Finder" || fail "a file of another kind" "$(js workspace "$front")"

# Frames: a page and a PDF from the host's own server, a local address as it is; each held to this machine.
frame="(f => f ? [f.getAttribute('sandbox'), new URL(f.src).host, f.src.split('/').pop()].join(' ') : 'no frame')(document.querySelector('.pane:not([hidden]) .pv iframe'))"
base="$(js workspace "__ws.call('host.frame', {}).then((f) => f.base)")"
fhost="$(echo "$base" | sed 's|http://||; s|/.*||')"
click report.html
until_has workspace "eval $frame" 8 "allow-scripts allow-forms allow-same-origin $fhost report.html" \
  && pass "a page is shown in a sandboxed frame that loads it from the host's own server, at an address that is not the app's" || fail "a page preview" "$(js workspace "$frame") | $base"
sleep 1
shot preview-page workspace
click paper.pdf
until_has workspace "eval $frame" 8 "$fhost paper.pdf" && [ "$(js workspace "String(document.querySelector('.pane:not([hidden]) .pv iframe').hasAttribute('sandbox'))")" = false ] \
  && pass "a PDF is shown by the web view's own viewer, in a frame from the host's server (the one frame with no sandbox: WebKit draws no PDF in one)" || fail "a PDF preview" "$(js workspace "$frame")"
sleep 1.5
shot preview-pdf workspace
click "http://127.0.0.1:$fport/"
until_has workspace "eval $frame" 8 "allow-scripts allow-forms allow-same-origin 127.0.0.1:$fport" && until_has workspace "$(shown)" 3 "127.0.0.1:$fport:web:person" \
  && grep -q "^127.0.0.1:$fport /\$" "$tmp/frames.log" \
  && pass "a web address of this machine is shown in a sandboxed frame, loaded as it is" || fail "a local address" "$(js workspace "$frame")"
sleep 1
shot preview-web workspace

# What a frame may not do, tried by a page that tries all of it: as a local address, and as a file of the project.
# (Room for them first: a terminal has eight previews beside it at most.)
for title in plain.txt big.log data.bin shot.png; do js workspace "(p => p && __ws.call('delete', { c: 'previews', id: p.id }))([...__ws.records.previews.values()].find((p) => p.title === '$title'))" >/dev/null; done
js workspace "(window.__probe = [], addEventListener('message', (e) => e.data?.probe && window.__probe.push(e.data.probe)), 1)" >/dev/null
echo "outside" > "$tmp/outside-frame.txt"
sed "s|<p id=\"said\">|<script>history.replaceState(null, '', '?remote=$remote\&inside=beside.txt\&outside=$base$tmp/outside-frame.txt\&local=http://127.0.0.1:$fport/self')</script><p id=\"said\">|" "$host/scripts/frame-probe.html" > "$tmp/project/probe.html"
follow() { js workspace "(__ws.follow('$pshell', { kind: '$1', target: '$2' }, '$tmp/project', {}), 1)" >/dev/null; }
follow web "http://127.0.0.1:$fport/probe.html?remote=$remote&local=http://localhost:$fport/self&outside=$base$tmp/outside-frame.txt"
until_has workspace "eval window.__probe.length" 15 "1" || fail "the probe as a local address answered"
follow path probe.html
until_has workspace "eval window.__probe.length" 15 "2" || fail "the probe as a file answered"
probes="$(js workspace "JSON.stringify(window.__probe)")"
api="window.__probe.every((p) => p.internals === 'undefined' && p.parent === 'refused' && p.records === 'refused' && p.protocol !== '200' && p.protocol !== 'loaded')"
[ "$remote" != none ] || fail "no address that reaches this machine is remote by the rule: what a frame may load cannot be told here"
[ "$(js workspace "String($api)")" = true ] && ! grep -q "REACHED" "$log" \
  && pass "a frame has nothing of the app: no bridge object, no way to the page around it or its records, and the host answers no command from it (tried through the web view's message handler and the app's own protocol)" || fail "a frame and the app's interface" "$probes"
[ "$(js workspace "String(window.__probe.every((p) => p.top === 'refused' && p.window === 'refused'))")" = true ] \
  && pass "a frame cannot move the window around it, and no window opens for it" || fail "a frame, the top window and new windows" "$probes"
[ "$(js workspace "String(window.__probe.every((p) => p.bars === '0 none none'))")" = true ] \
  && pass "a page in a frame shows no scrollbar: the host's style for frames reaches its scrollers, as a local address and as a file" || fail "scrollbars in a frame" "$probes"
[ "$(js workspace "String(window.__probe.every((p) => p.picture === 'refused' && p.request === 'refused'))")" = true ] && ! grep -q "/leak" "$tmp/frames.log" \
  && grep -q "\"stopped\":\"http://$remote/leak-frame\"" "$log" \
  && pass "a frame loads nothing from an address that is not this machine's: a picture, a request and a frame inside it were each refused, and none reached the server ($remote)" || fail "a frame and the network" "$probes | $(grep -c /leak "$tmp/frames.log")"
[ "$(js workspace "(p => String(!!p && p.inside === '200' && p.outside === '403' && p.local === 'refused'))(window.__probe.find((p) => 'inside' in p))")" = true ] \
  && [ "$(js workspace "(p => String(!!p && p.local === 'loaded' && p.outside !== '200' && p.outside !== 'loaded'))(window.__probe.find((p) => !('inside' in p)))")" = true ] \
  && pass "a page of the project reads the file beside it and no file outside the folders the person opened (the host's server answers 403), and nothing of another server; a local address reads nothing from the host's server" || fail "a frame and files" "$probes"
# Leaving for the web, by a link and by a redirect: stopped by the host, and offered to the person.
: > "$tmp/opened"
follow web "http://127.0.0.1:$fport/probe.html?remote=$remote&go=away"
until_has workspace "text .pv .strip" 15 "http://$remote/leak-away" && grep -q "\"stopped\":\"http://$remote/leak-away\"" "$log" \
  && js workspace "(document.querySelector('.pv .strip .btn').click(), 1)" >/dev/null && sleep 0.6 \
  && [ "$(cat "$tmp/opened")" = "-u http://$remote/leak-away" ] && ! grep -q "/leak" "$tmp/frames.log" \
  && pass "a frame that tries to go to an address that is not this machine's is stopped by the host; the page says where it wanted to go and the person may open that in the browser" || fail "a frame leaving for the web" "$(ask workspace "text .pv .strip") | $(cat "$tmp/opened")"
shot preview-stopped workspace
follow web "http://127.0.0.1:$fport/probe.html?remote=$remote&go=redirect"
for _ in $(seq 1 60); do grep -q "\"stopped\":\"http://$remote/leak-redirect\"" "$log" && break; sleep 0.2; done
grep -q "\"stopped\":\"http://$remote/leak-redirect\"" "$log" && ! grep -q "/leak" "$tmp/frames.log" \
  && pass "a local address that redirects to one that is not is stopped at the redirect" || fail "a redirect out of this machine"
js workspace "(document.querySelector('.pv .strip .btn:last-child')?.click(), 1)" >/dev/null

# An agent shows what it made with the core's own tool, run in its terminal with that terminal's token; it takes
# nothing from the person. (The fixture agent has no step that runs a program, so the check types what an agent runs.)
aterm="$(js workspace "__ws.newTerminal('$project')")"
until_has workspace "eval __ws.records.terminals.get('$aterm')?.state + ' ' + __ws.engines.get('$aterm')?.attached" 10 "running true" || fail "a shell for the agent's preview"
sleep 1
echo "# Made by the agent" > "$tmp/project/made.md"
selected="$(js workspace "__ws.layout('$project').selected")"
term_line "tasktap preview made.md"
ashown="eval [...__ws.records.previews.values()].filter((p) => p.terminal_id === '$aterm').map((p) => p.title + ':' + p.kind + ':' + p.by).join(' ')"
until_has workspace "$ashown" 8 "made.md:file:agent" \
  && until_has workspace "eval String(!!document.querySelector('.tab .st.by[data-by=agent]')) + ' ' + [...document.querySelectorAll('.pv .pv-by')].map((b) => b.textContent).join()" 5 "true Opened from its terminal" \
  && [ "$(js workspace "String(__ws.layout('$project').selected === '$selected' && __ws.current().id === '$aterm')")" = true ] \
  && pass "tasktap preview, run in a terminal as an agent runs it, shows the file beside that terminal, marked on its tab and in its head as opened by the agent, and the terminal keeps the selection" || fail "a preview an agent opens" "$(ask workspace "$ashown") | $(ask workspace "$(screen)" | tail -3 | tr '\n' '|')"
shot preview-agent workspace
term_line "tasktap preview /etc/hosts; tasktap preview https://example.com/"
until_has workspace "eval __ws.text().replace(/\n/g, '')" 8 "outside the folders you opened in Tasktap" && until_has workspace "eval __ws.text().replace(/\n/g, '')" 3 "this one opens in the browser" \
  && pass "what the core will not show for an agent is said in the agent's terminal, in the core's words" || fail "the tool's refusals"

# Staying current with no timer: after its terminal has printed and gone quiet, and on Reload.
js workspace "(__ws.focusSession('$pshell'), 1)" >/dev/null
click notes.md
until_has workspace "eval $front" 5 "markdown DIV Smoke notes" || fail "the notes are in front again"
echo "A line added later." >> "$tmp/project/notes.md"
term_line "echo wrote the notes"
until_has workspace "eval $front" 6 "A line added later." && pass "a preview follows its file once its terminal has printed something and gone quiet" || fail "a preview follows its file" "$(js workspace "$front")"
echo "And one more." >> "$tmp/project/notes.md"
sleep 1.5
[ "$(js workspace "String(document.querySelector('.pv .md').innerText.includes('And one more.'))")" = false ] && js workspace "(__ws.command('reload-preview'), 1)" >/dev/null \
  && until_has workspace "eval $front" 5 "And one more." && pass "nothing watches the file while nothing happens; Reload (⌘R) reads it anew" || fail "Reload"
mv "$tmp/project/notes.md" "$tmp/notes.away" && js workspace "(__ws.command('reload-preview'), 1)" >/dev/null
until_has workspace "eval $front" 5 "said DIV It is gone" && ask workspace "text .pv .pv-s" | grep -q "notes.md does not exist" \
  && mv "$tmp/notes.away" "$tmp/project/notes.md" && js workspace "(__ws.command('reload-preview'), 1)" >/dev/null && until_has workspace "eval $front" 5 "markdown DIV Smoke notes" \
  && pass "a file that went away is said so in the core's sentence, and is shown again once it is back" || fail "a file that went away" "$(js workspace "$front")"
# A local address nothing listens at yet: said, and shown once its server answers and the terminal has gone quiet.
for _ in 1 2 3 4; do js workspace "(p => p && __ws.call('delete', { c: 'previews', id: p.id }))([...__ws.records.previews.values()].find((p) => p.target.includes('probe.html')))" >/dev/null; done
quietport="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
follow web "http://127.0.0.1:$quietport/"
until_has workspace "eval $front" 8 "web DIV Nothing answers yet" || fail "nothing listening is said" "$(js workspace "$front")"
shot preview-nothing workspace
python3 -m http.server "$quietport" --bind 127.0.0.1 --directory "$tmp/project" >/dev/null 2>&1 &
late=$!
# The terminal speaks once the server answers, which a busy machine's Python takes its time to start.
for _ in $(seq 1 100); do curl -s -o /dev/null "http://127.0.0.1:$quietport/" && break; sleep 0.1; done
term_line "echo the server is up"
until_has workspace "eval $frame" 8 "allow-scripts allow-forms allow-same-origin 127.0.0.1:$quietport" && pass "a local address that nothing answers says so, and is shown once its server does and its terminal has gone quiet" || fail "a server that starts later" "$(js workspace "$front")"
kill "$late" 2>/dev/null

# The keys: from the terminal to its preview and back, and ⌘W on a preview closes it for good.
js workspace "(__ws.focusSession('$pshell'), __ws.command('preview'), 1)" >/dev/null
until_has workspace "eval String(!!__ws.current().preview && !__ws.current().id)" 3 "true" && js workspace "(__ws.command('preview'), 1)" >/dev/null \
  && until_has workspace "eval String(__ws.current().id)" 3 "$pshell" \
  && pass "⌘P moves between a terminal and the preview beside it" || fail "the key between a terminal and its preview"
count=$(js workspace "__ws.records.previews.size")
js workspace "(__ws.command('preview'), __ws.command('close-tab'), 1)" >/dev/null
until_has workspace "eval __ws.records.previews.size" 5 "$((count - 1))" && pass "⌘W on a preview closes it: its record is gone" || fail "closing a preview"
# The ninth beside one terminal: the core's sentence, under the terminal.
for n in 1 2 3 4 5 6 7 8 9; do echo "# Note $n" > "$tmp/project/n$n.md"; done
for _ in $(seq 1 12); do
  [ "$(js workspace "[...__ws.records.previews.values()].filter((p) => p.terminal_id === '$pshell').length")" -le 0 ] && break
  js workspace "(p => p && __ws.call('delete', { c: 'previews', id: p.id }))([...__ws.records.previews.values()].find((p) => p.terminal_id === '$pshell'))" >/dev/null
done
for n in 1 2 3 4 5 6 7 8; do js workspace "__ws.call('preview.open', { terminal: '$pshell', target: '$tmp/project/n$n.md' })" >/dev/null; done
js workspace "(__ws.focusSession('$pshell'), 1)" >/dev/null
follow path n9.md
until_has workspace "text .pane .strip[data-refused]" 5 "No preview" && [ "$(js workspace "[...__ws.records.previews.values()].filter((p) => p.terminal_id === '$pshell').length")" = 8 ] \
  && pass "a ninth preview beside one terminal is refused in the core's words, under that terminal: $(ask workspace "text .pane .strip[data-refused] .said")" || fail "the ninth preview" "$(ask workspace "text .pane .strip")"
shot preview-ninth workspace
js workspace "(document.querySelector('.strip[data-refused] .btn:last-child').click(), 1)" >/dev/null
previews=$(js workspace "__ws.records.previews.size")
# The top frame: sent anywhere but to the app's own pages, the host brings it back.
js workspace "(setTimeout(() => (location.href = 'http://127.0.0.1:$fport/'), 50), 1)" >/dev/null
for _ in $(seq 1 50); do grep -q "\"top\":\"http://127.0.0.1:$fport/\"" "$log" && break; sleep 0.2; done
until_has workspace "eval __ws.ui.ready + ' ' + location.protocol" 15 "true tauri:" && grep -q "\"top\":\"http://127.0.0.1:$fport/\"" "$log" \
  && pass "a top frame sent to an address that is not the app's own page is brought back to it by the host" || fail "the top frame stays on the app's pages" "$(js workspace "location.href")"
js workspace "(__ws.menu.dry = true)" >/dev/null
js workspace "(__ws.show('$project'), 1)" >/dev/null
until_has workspace "eval __ws.records.previews.size + ' ' + document.querySelectorAll('.pane:not([hidden]) > .pv').length" 8 "$previews 1" \
  && pass "the previews are back after the page starts again, beside their terminal" || fail "previews after the page restarts"
js workspace "(__ws.show('$project'), 1)" >/dev/null
terminals=$(ask workspace "eval __ws.records.terminals.size")

# Closing the window leaves the notch; showing it again comes back to the same workspace.
panes=$(ask workspace "eval __ws.L.panes(__ws.layout('$project')).length")
send "close workspace"
sleep 1
until_has notch "eval String(!!document.querySelector('#tab'))" 3 "true" && [ "$(ask workspace "eval 1")" = None ] || fail "the workspace window closes"
send "show"
until_has workspace "eval __ws.ui.ready" 10 "True" && js workspace "(__ws.show('$project'), 1)" >/dev/null \
  && until_has workspace "eval document.querySelectorAll('.pane:not([hidden])').length" 5 "$panes" \
  && pass "closing the workspace window leaves the notch; it comes back with its workspace" || fail "close and show the window"
layout=$(ask workspace "eval JSON.stringify(__ws.layout('$project'))")
panes=$(ask workspace "eval __ws.L.panes(__ws.layout('$project')).length")
running=$(ask workspace "eval [...__ws.records.terminals.values()].filter(t=>t.state==='running').length")
sleep 1
# A workspace in a window of its own: out of the main window with its panes, back when that window closes, and out again
# for the relaunch below. The window has a label of its own, so the page in it is asked as `ws-<project>`.
# What a terminal of the workspace shows, to be found again where the workspace goes: the first line of its screen, in base64 (it
# may hold any character), asked of whichever page shows it.
cur="$(js workspace "[...__ws.engines].find(([id, e]) => e.element.isConnected && !e.element.hidden && __ws.records.terminals.get(id)?.project_id === '$project')?.[0] ?? ''")"
# (A terminal is as wide as the pane of the window that shows it, and wraps its lines there: the words are compared with
# their spaces and line ends left out, a wrapped line joined to the one it continues.)
words="(id => { const b = __ws.engines.get(id)?.term.buffer.active; if (!b) return null; let out = ''; for (let i = 0; i < b.length; i++) out += (b.getLine(i)?.isWrapped ? '' : ' ') + b.getLine(i)?.translateToString(true); return out.replace(/\\s+/g, ''); })"
want="$(js workspace "btoa(unescape(encodeURIComponent(($words('$cur')?.slice(0, 40)) ?? '')))")"
screen_has() { echo "eval String((w => ($words('$cur') ?? '').includes(decodeURIComponent(escape(atob(w)))))('$want'))"; }
[ -n "$cur" ] && [ -n "$want" ] || fail "a terminal shown in the workspace has words on its screen" "terminal '$cur', its first line '$want'"
js workspace "(__ws.call('host.window', { do: 'pop', project: '$project', w: 900, h: 600 }), 1)" >/dev/null
until_has workspace "eval JSON.stringify([...__ws.ui.out])" 15 "$project" \
  && until_has "ws-$project" "eval __ws.ui.only + ' ' + document.querySelectorAll('.side').length + ' ' + document.querySelectorAll('.pane:not([hidden])').length" 10 "$project 0 $panes" \
  && [ "$(hstate "'ws-$project' in d['windows']")" = True ] \
  && pass "a workspace taken out has a window of its own, with no sidebar and its panes, and the main window lets go of it" || fail "a workspace in a window of its own" "$(js workspace "JSON.stringify([...__ws.ui.out])")"
[ "$(js workspace "__ws.ui.view")" != "$project" ] && until_has "ws-$project" "$(screen_has)" 10 "true" \
  && pass "the workspace has left the main window, which shows another view, and its window shows the terminal's screen as it was" || fail "the workspace shows in its window" "main shows $(js workspace "__ws.ui.view"); the window: $(js "ws-$project" "__ws.text('$cur')" | head -c 200)"
send "close ws-$project"
until_has workspace "eval JSON.stringify([...__ws.ui.out]) + ' ' + __ws.ui.view" 10 "[] $project" \
  && pass "closing a workspace's window puts the workspace back into the main window, in view" || fail "closing a workspace's window"
until_has workspace "$(screen_has)" 10 "true" && until_has workspace "eval document.querySelectorAll('.pane:not([hidden])').length" 5 "$panes" \
  && until_has workspace "eval (e => String(e.term.cols === e.fit.proposeDimensions()?.cols && e.term.cols === __ws.records.terminals.get('$cur').cols))(__ws.engines.get('$cur'))" 10 "true" \
  && pass "back in the main window the workspace shows its panes and the terminal's screen as it was, the terminal the size of its pane again" || fail "the workspace's terminal after its window closed" "$(js workspace "__ws.text('$cur')" | head -c 200)"
js workspace "(__ws.call('host.window', { do: 'pop', project: '$project', w: 900, h: 600 }), 1)" >/dev/null
until_has workspace "eval JSON.stringify([...__ws.ui.out])" 15 "$project" || fail "the workspace is out again before the quit"
quit && pass "the app quits on request" || fail "the app quits on request"
fi

if part "Relaunched"; then
launch
until_has workspace "eval __ws.ui.ready" 10 "True" || fail "the relaunched page reaches the core"
until_has workspace "eval JSON.stringify([...__ws.ui.out])" 20 "$project" && until_has "ws-$project" "eval __ws.ui.only" 10 "$project" \
  && pass "a workspace that was out at the quit is out again in its window after the relaunch" || fail "a workspace's window comes back after a relaunch"
send "close ws-$project"
until_has workspace "eval JSON.stringify([...__ws.ui.out])" 10 "[]" || fail "the restored window closes"
js workspace "(__ws.menu.dry = true)" >/dev/null
js workspace "(__ws.show('$project'), 1)" >/dev/null
[ "$(ask workspace "eval JSON.stringify(__ws.layout('$project'))")" = "$layout" ] \
  && pass "after quit and relaunch the workspace's layout is restored as it was" || fail "the layout is restored"
until_has workspace "eval document.querySelectorAll('.pane:not([hidden])').length" 5 "$panes" || fail "its panes are shown"
[ "$(ask workspace "eval __ws.records.terminals.size")" = "$terminals" ] \
  && [ "$(ask workspace "eval [...__ws.records.terminals.values()].filter(t=>t.state==='running').length")" = "$running" ] \
  && pass "nothing is started again: the same terminals, still running" || fail "nothing reruns"
until_has workspace "eval __ws.records.previews.size + ' ' + document.querySelectorAll('.pane:not([hidden]) > .pv').length" 5 "$previews 1" \
  && pass "the previews outlive the app and its core: after quit and relaunch they are beside their terminal again" || fail "previews after a relaunch" "$(js workspace "__ws.records.previews.size")"
until_has workspace "eval [...document.querySelectorAll('.tab .lbl')].map(s=>s.textContent).join('|')" 5 "Hello from the smoke" \
  && pass "the run's tab is back with its name" || fail "the run's tab"
shot relaunched workspace
until_has workspace "text #sidebar" 5 "Sign-in terminals" && pass "a sign-in terminal still running is listed again" || fail "the sign-in terminal is listed again"
# The workspace's own menu is the system's; the check runs its item as choosing it would.
js workspace "(document.querySelector('[data-workspace=\"$project\"] .row.w').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})), 1)" >/dev/null
js workspace "__ws.choose('Close Workspace…')" >/dev/null
until_has workspace "text .sheet" 3 "Still running:" && ask workspace "text .sheet" | grep -q "Close project?" \
  && pass "closing a workspace where something runs asks once, naming what runs where" || fail "close workspace asks" "$(ask workspace "text .sheet")"
press workspace ".sheet" Backspace true >/dev/null
until_has workspace "eval String(__ws.records.projects.get('$project').open) + ' ' + [...__ws.records.terminals.values()].filter(t=>t.project_id==='$project'&&t.state==='running').length" 10 "false 0" \
  && pass "it closes the workspace and stops its sessions" || fail "close workspace"
js workspace "(__ws.command('open-workspace'), 1)" >/dev/null
until_has workspace "text .sheet" 3 "Open again" || fail "the folder sheet lists closed workspaces"
ask workspace "click .sheet button.line" >/dev/null
until_has workspace "eval __ws.ui.view" 5 "$project" && [ "$(ask workspace "eval JSON.stringify(__ws.layout('$project').tree)")" != null ] \
  && [ "$(ask workspace "eval __ws.records.terminals.size")" = "$terminals" ] \
  && pass "reopening it restores its layout and history and starts nothing" || fail "reopen a workspace"
quit && pass "the app quits on request again" || fail "the second quit"
fi

section ""
echo "== Where the time went ($SECONDS s in all)"
printf '%s' "$timings" | sort -rn | sed 's/^/   /'
echo
[ "$fails" = 0 ] && echo "PASS  smoke" || echo "FAIL  smoke: $fails failed"
exit "$fails"
