#!/bin/bash
# host/scripts/smoke.sh: builds Tasktap Next with a core that has the fixture agent, runs it on a
# temporary data folder and drives it through its debug channel: the notch (a thought saved for
# later before any folder is open and sent to one, capture, Undo, a run, a trust prompt, a question,
# affirm, the result), Home (first run, the agents' rings, the question in full, the Folds, Earlier,
# For later), the sidebar's slide, scrolling without bars, and the workspace (a run's
# terminal, a question in its pane's strip, a shell typed into, splits, a moved tab, a divider,
# the sheets, Keep running in background and restore, Stop, text size, Keep and Discard of a run
# that worked in its own copy of the project, placing by a model: offered, allowed, a thought placed and
# briefed by the core's fixture router, Undo during its hold, the router's question answered, placing by
# name when the model fails; voice: a speech service allowed, a thought spoken, words spoken into a field
# and into a question's reply, a failure and cancel, with a tone made in the page in place of a microphone
# and a speech service of the check's own on this machine; then quit and relaunch with the layout restored
# and nothing rerun). It never sends keys or clicks to the system: every step is a line on the app's
# standard input, and the app is passive (its windows never take the keyboard; no system menu is
# ever opened). Prints PASS or FAIL per promise; exits non-zero on any FAIL. SHOTS=<folder> also
# saves pictures of the app's own pages, taken by the app itself (`snapshot`), so no permission is involved.
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

echo "== Lists keep their columns (headless, fixture records)"
if out="$(node "$root/scripts/align-check.cjs" 2>&1)"; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "list alignment"; fi

echo "== The ambient layer holds steady (headless, two and a half minutes)"
if out="$(node "$root/scripts/soak-check.cjs" 2>&1)"; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "the ambient layer holds steady"; fi

echo "== The capture flow keeps its pace (the built app with the fixture agent, in a short launch of its own)"
out="$(node "$root/scripts/flow-check.cjs" --app --debug --short ${FRONT:+--front} 2>&1)"
if [ $? = 0 ]; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"
elif echo "$out" | grep -q "nothing can be measured\|nothing drawn on it can be measured"; then pass "the capture flow was not timed: $(echo "$out" | grep -o 'The [^:]*: nothing[^.]*' | head -1)"
else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "the capture flow keeps its pace"; fi

echo "== One type system (headless, every state of both pages)"
if out="$(node "$root/scripts/type-check.cjs" 2>&1)"; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "the type scale"; fi

echo "== Voice, recorded by the page (headless, a microphone that is a file)"
if out="$(node "$root/scripts/voice-check.cjs" 2>&1)"; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "voice in the page"; fi

tmp="$(mktemp -d)"
log="$tmp/log"
mkdir -p "$tmp/agents" "$tmp/project"
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

# Starts the app on the same data folder each time; its input is a new pipe on descriptor 3.
launch() {
  rm -f "$tmp/in"
  mkfifo "$tmp/in"
  env PATH="$tmp/agents:$PATH" TASKTAP_DEBUG=1 TASKTAP_PASSIVE=1 TASKTAP_DATA="$tmp/data" TASKTAP_PICK="$tmp/project" \
    TASKTAP_CORE_EXE="$host/binaries/fixtures/tasktap" TASKTAP_CORE_BUILD="$(cat "$host/binaries/fixtures/build.txt")" \
    "$host/target/debug/tasktap-next" < "$tmp/in" >> "$log" 2>&1 &
  app=$!
  exec 3>"$tmp/in"
}
quit() {
  send quit
  for _ in $(seq 1 30); do kill -0 "$app" 2>/dev/null || return 0; sleep 0.1; done
  return 1
}

send() { for line in "$@"; do echo "$line" >&3; done; }
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

echo "== Driving the app on $tmp/data"
launch
for _ in $(seq 1 100); do grep -q '"event":"ready"' "$log" && break; sleep 0.1; done
# FRONT=1: the app's window in front of the other apps' for the run (the keyboard stays where it is), so that what a
# covered window would not draw is checked too.
[ -n "${FRONT:-}" ] && send front
grep -q '"event":"ready"' "$log" && pass "the app starts and reaches its own core" || { fail "the app starts" "$(tail -3 "$log")"; exit 1; }
until_has workspace "eval __ws.ui.view + ' ' + !!document.querySelector('.home .capture')" 10 "home true" && grep -q '"event":"window"' "$log" \
  && pass "the workspace window opens at launch, on Home, once its page has drawn" || fail "the workspace window opens"
# A core built with its fixtures detects its agents when asked, as a normal one does at start.
send 'call put {"c":"prefs","id":"agent","patch":"fixture"}' 'call put {"c":"prefs","id":"hold","patch":2}' 'call agents.detect {}'
# A context menu is the system's: the check never lets one open on the screen, and runs its items itself.
js workspace "(__ws.menu.dry = true)" >/dev/null
sleep 1
shot collapsed-idle
shot home workspace
# First run is one composition: the Composer a little above the middle of the content, and on its own edges the one
# thing to do first, which is the key while the Composer is empty.
edges="((c, a, k, h) => [Math.abs(c.left + c.width / 2 - (h.left + h.width / 2)) < 1, a.left >= c.left && a.right <= c.right, Math.abs(k.right - document.querySelector('.home .cap-row .key').getBoundingClientRect().right) < 1, c.top + c.height / 2 < h.top + h.height / 2 && c.top > h.top + h.height * 0.2].join(' '))(document.querySelector('.home .cap').getBoundingClientRect(), document.querySelector('.attach').getBoundingClientRect(), document.querySelector('.attach .key').getBoundingClientRect(), document.querySelector('#main').getBoundingClientRect())"
until_has workspace "text .attach" 5 "Open a folder" && ! ask workspace "text .hx" | grep -q "Agents" \
  && [ "$(js workspace "document.querySelector('#dest-chip')?.textContent")" = "No folder yet" ] \
  && [ "$(js workspace "(b => b.textContent + ' ' + b.disabled)(document.querySelector('.home .cap-row .key'))")" = "Save for later true" ] \
  && [ "$(js workspace "$edges")" = "true true true true" ] \
  && pass "with no folder open, Home is one composition: the Composer centred a little above the middle, its place saying No folder yet and its key that Return saves for later; under it, on its edges, Open a folder as the one key" || fail "Home on first run" "$(js workspace "$edges")"
# The light: Home's chrome is drawn once and then nothing while nothing happens, the notch draws no form at all, and
# the person's choice reaches both pages at once.
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
# band is drawn frame after frame and the light moves; back at rest it stops.
if [ "$(js workspace "String(document.hidden)")" = true ]; then
  pass "the loop while agents work: the window is covered, so nothing is drawn yet"
else
  js workspace "(Object.assign(__motion.debug, { state: 'working', active: true }), __motion.redraw(), 1)" >/dev/null; sleep 1
  frames=$(js workspace "__motion.stats.frames"); sleep 2
  moving="$(js workspace "String(__motion.stats.frames - $frames > 40) + ' ' + document.querySelector('.light').dataset.moves")"
  js workspace "(Object.assign(__motion.debug, { state: null, active: null }), __motion.redraw(), 1)" >/dev/null; sleep 2.5
  frames=$(js workspace "__motion.stats.frames"); sleep 1
  [ "$moving" = "true true" ] && [ "$(js workspace "__motion.stats.frames")" = "$frames" ] \
    && pass "while agents work in the window in use the band is drawn in every frame and the light moves; back at rest it is still within a moment" || fail "the loop while agents work" "$moving"
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
  && until_has workspace "eval String(!!document.querySelector('.light') && localStorage.length === 0) + ' ' + document.documentElement.dataset.effects" 3 "true full" \
  && js workspace "(__motion.debug.saving = true, __motion.redraw(), 1)" >/dev/null \
  && until_has workspace "eval document.documentElement.dataset.effects + ' ' + document.querySelector('.light')?.dataset.moves" 3 "still false" \
  && pass "the effects are the core's preference: at Still the light is a picture while agents work, Off takes the light and the glyphs away at once, Low Power Mode holds Full at Still, and nothing is kept in the page" || fail "the effects preference"
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

# The agents are rings in the Composer, not a list: each its mark in a circle, the one that runs the next thought lit.
ring="document.querySelector('.home .ring[data-agent=fixture]')"
until_has workspace "eval String($ring?.getAttribute('aria-checked') === 'true' && !!$ring.querySelector('.ring-o circle') && /Fixture agent.*runs the next thought/.test($ring.title) && !document.querySelector('.hx .list, .rail .off'))" 5 "true" \
  && pass "the agents are rings in the Composer: each its mark in a circle, named in its tooltip and for VoiceOver, the one that runs the next thought lit; no list of agents on Home, no names in the rail" || fail "the agents' rings" "$(js workspace "$ring?.outerHTML.slice(0, 200)")"
other="$(js workspace "document.querySelector('.home .ring:not([data-agent=fixture]):not([data-s=off])')?.dataset.agent ?? ''")"
if [ -n "$other" ]; then
  js workspace "(document.querySelector('.home .ring[data-agent=$other]').click(), 1)" >/dev/null
  until_has workspace "eval document.querySelector('.home .ring[aria-checked=true]').dataset.agent" 3 "$other" \
    && pass "a click on another ring picks that agent for the next thought, as the core's preference" || fail "picking an agent by its ring"
  send 'call put {"c":"prefs","id":"agent","patch":"fixture"}'
  until_has workspace "eval document.querySelector('.home .ring[aria-checked=true]').dataset.agent" 3 "fixture" || fail "the fixture agent is chosen again"
fi

echo "== A thought saved for later before a folder is open, then sent to one"
send capture
until_has notch "text #sheet" 5 "Save for later" && [ "$(js notch "document.querySelector('#dest-chip').textContent")" = "No folder yet" ] \
  && pass "the capture shortcut opens the field; with no folder yet its place says No folder yet and its key that Return saves for later" \
  || fail "capture opens"
send "type notch Hello from the smoke" "key notch Enter"
until_has notch "text .cap-said" 5 "Saved for later" && [ "$(js notch "[...__records.thoughts.values()].find(t=>t.text==='Hello from the smoke')?.mode")" = note ] \
  && pass "Enter saves it for later, and says so" || fail "a thought is saved for later"
send "key notch Escape"
until_has workspace "text .hx .hsec" 5 "Hello from the smoke" && ask workspace "text .hx .hsec" | grep -q "For later" && js workspace "document.querySelector('.hr.later').textContent" | grep -q "Send to a folder" \
  && pass "it lands on Home in a For later line of its own, with Send to a folder on it" || fail "Home lists what was saved for later"
# Typed on Home instead: the Composer's key becomes the one key, and what is saved lands under it with its way on shown.
js workspace "(document.querySelector('.home #capture-input').focus(), document.execCommand('insertText', false, 'Later, from Home'), 1)" >/dev/null
until_has workspace "eval document.querySelector('.home .cap-row .key').disabled + ' ' + document.querySelector('.attach button').className" 3 "false btn lg" \
  && send "key workspace Enter" && until_has workspace "text .home .cap-said" 5 "Saved for later" \
  && until_has workspace "eval getComputedStyle(document.querySelector('.hr.later.new .hr-a')).visibility" 3 "visible" \
  && pass "typed on Home, Return saves it for later: the Composer's key is then the one key, the receipt says so, and the thought lands in For later with Send to a folder showing" || fail "save for later on Home"
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

echo "== Capture and Undo"
send capture
until_has notch "eval document.activeElement?.id" 5 "capture-input" || fail "capture opens again"
until_has notch "eval (r => r?.dataset.s + ' ' + r?.querySelector('b')?.textContent + ' ' + !!r?.querySelector('.turn'))(document.querySelector('.ring[data-agent=fixture]'))" 5 "working 1 true" \
  && pass "while its session works an agent's ring turns, with the count beside it" || fail "a working agent's ring"
send "type notch Undo me" "key notch Enter"
until_has notch "text .way" 5 "project" && pass "with a folder open, Enter sends the thought there, and it shows on its way" || fail "Enter sends"
ask notch "text .way" | grep -q "Undo" && ask notch "text .way .key" | grep -q "Start" \
  && [ "$(js notch "String((h => !!h && !h.hasAttribute('data-open') && parseFloat(getComputedStyle(h).getPropertyValue('--ms')) > 500)(document.querySelector('.way-hold')))")" = true ] \
  && pass "while it is held it offers Undo and Start, and its hold is a line that runs out by the clock" || fail "the thought on its way offers Undo" "$(ask notch "text .way")"
ask notch "click .way .act" >/dev/null
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

echo "== The run, its questions and its result"
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
[ "$(js notch "document.querySelector('.ring[data-agent=fixture]')?.dataset.s")" = asks ] \
  && pass "while one of its sessions asks, the agent's ring takes the attention colour" || fail "an asking agent's ring"
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
until_has workspace "$(screen)" 10 "answer:yes" && [ "$(ask workspace "$(screen)" | grep -c 'answer:yes')" = 2 ] \
  && pass "the strip's key 1, pressed while it has the keyboard, answers the agent" || fail "the strip's keys answer"
term_line "event:turn_finished:All green."
until_has notch "text .tab .wing.r" 10 "1" && pass "the collapsed glance counts the result as new" || fail "the glance counts the result"
until_has workspace "eval document.querySelector('.tabw.on .st')?.dataset.s + ' ' + document.querySelector('.row.s.sel .st')?.dataset.s" 5 "ready ready" \
  && pass "the tab and the sidebar row mark the unread result" || fail "the result marks"
shot collapsed-done
shot pane-result workspace
send "hover in"
until_has notch "text #sheet" 5 "All green." && pass "the open notch shows the result's summary" || fail "the result shows"
ask notch "text #sheet .result" | grep -q "Open" && pass "the result offers Open" || fail "the result offers Open"
shot result
sleep 2
send "key notch Escape"
until_has notch "eval document.querySelector('.tab .wing.r')?.innerText || 'none'" 5 "none" \
  && pass "a result seen in the notch is marked read and leaves the glance" || fail "seen results are marked read"

echo "== The workspace"
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
js workspace "(__ws.command('close-tab'), 1)" >/dev/null
until_has workspace "text .sheet" 3 "Keep running in background" && ask workspace "text .sheet" | grep -q "Stop session" \
  && pass "closing a live terminal's tab offers Keep running, Stop and Cancel in a sheet" || fail "the close sheet"
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
terminals=$(ask workspace "eval __ws.records.terminals.size")

# The terminal's font, size and line height are the core's preferences: every terminal takes them at once.
send 'call put {"c":"prefs","id":"terminal_size","patch":16}' 'call put {"c":"prefs","id":"terminal_line_height","patch":120}'
other="[...__ws.engines.values()].find(e => e.id !== '$shell')"
until_has workspace "eval String((e => !!e && Math.abs(e.term.options.fontSize * 0.60205 - 10) < 0.01 && e.term.options.lineHeight === 1.2)($other))" 3 "true" \
  && send 'call delete {"c":"prefs","id":"terminal_size"}' 'call delete {"c":"prefs","id":"terminal_line_height"}' \
  && until_has workspace "eval String((e => Math.abs(e.term.options.fontSize * 0.60205 - 8) < 0.01 && e.term.options.lineHeight === 1)($other))" 3 "true" \
  && pass "the terminal's size and line height are the core's preferences, taken at once in cells of whole pixels, and deleting them restores Default" || fail "the terminal preferences"

echo "== The sidebar's slide, and scrolling without bars"
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
if [ "$(js workspace "String(document.hidden)")" = true ]; then
  pass "the sidebar's slide: the window is covered, so nothing moves to judge"
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
js workspace "(__ws.command('settings'), 1)" >/dev/null
more="document.querySelector('.sheet').dataset.more"
[ -z "$(js workspace "$bars")" ] && [ -z "$(js notch "$bars")" ] && until_has workspace "eval $more" 3 "down" \
  && js workspace "(document.querySelector('.sheet').scrollTop = 9999, 1)" >/dev/null && until_has workspace "eval $more" 3 "up" \
  && pass "no scroller in either page shows a bar; one with more beyond an edge says which, for its content to dissolve there" || fail "scrolling without bars" "$(js workspace "$bars") $(js notch "$bars") $(js workspace "$more")"
press workspace ".sheet" Escape >/dev/null
# The terminal: scrolled back, a pill says how many lines are below and returns to the end.
js workspace "(__ws.show('$project'), 1)" >/dev/null
pill="document.querySelector('.term:not([hidden]) .term-more')"
js workspace "(t => new Promise(done => t.write(Array.from({ length: 300 }, (_, i) => 'line ' + i).join('\r\n'), () => (t.scrollLines(-120), done(1)))))(__ws.engines.get(__ws.current().id).term)" >/dev/null
until_has workspace "eval $pill.hidden + ' ' + $pill.textContent" 3 "false ↓ 120 lines⌘↓" && js workspace "($pill.click(), 1)" >/dev/null \
  && until_has workspace "eval String($pill.hidden && (b => b.viewportY === b.baseY)(__ws.engines.get(__ws.current().id).term.buffer.active))" 3 "true" \
  && pass "a terminal scrolled back shows no bar: a pill says how many lines are below, and a click on it returns to the end" || fail "the terminal's scrollback" "$(js workspace "$pill.hidden + ' ' + $pill.textContent")"

echo "== Keep and Discard"
send "call put {\"c\":\"projects\",\"id\":\"$project\",\"patch\":{\"isolate\":\"always\"}}"
sleep 0.5
# A run that writes a file and exits: its changes come back pending, with nothing still running.
send "call thought.capture {\"id\":\"$(python3 -c 'import uuid,time;t=int(time.time()*1000);b=t.to_bytes(6,"big")+uuid.uuid4().bytes[6:];b=bytearray(b);b[6]=0x70|(b[6]&15);b[8]=0x80|(b[8]&63);print(uuid.UUID(bytes=bytes(b)))')\",\"text\":\"write:kept.txt:hello\",\"strokes\":[],\"source\":\"typed\",\"project_id\":\"$project\"}"
until_has workspace "$(thought 'write:kept.txt:hello' 'workdir?.changes')" 30 "pending" || fail "a run's changes come back pending"
js workspace "(__ws.show('home'), 1)" >/dev/null
until_has workspace "text .waiting" 5 "1 file +1 −0" && ask workspace "text .waiting" | grep -q "Keep" \
  && pass "Home lists a result whose changes wait under Changes waiting, with its diffstat and Keep, Discard and Review changes" || fail "Changes waiting on Home"
shot changes-waiting workspace
ask workspace "click .waiting .key" >/dev/null
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
ask workspace "click .waiting .key" >/dev/null
until_has workspace "text .waiting .told" 30 "Not kept" && ask workspace "text .waiting .told" | grep -q "conflict with this thought's in kept.txt" && ask workspace "text .waiting .told" | grep -q "tasktap/" \
  && pass "a refused Keep says the branch is as it was and shows the core's reason in full: the file in conflict and the branch to merge by hand" || fail "Keep refused" "$(ask workspace "text .waiting")"
# What the core says when it stops short is shown as what it is. A file of the person's in the way: git's own words
# name it, in full; once it is moved away, Keep goes through.
run() { send "call thought.capture {\"id\":\"$(python3 -c 'import uuid,time;t=int(time.time()*1000);b=t.to_bytes(6,"big")+uuid.uuid4().bytes[6:];b=bytearray(b);b[6]=0x70|(b[6]&15);b[8]=0x80|(b[8]&63);print(uuid.UUID(bytes=bytes(b)))')\",\"text\":\"$1\",\"strokes\":[],\"source\":\"typed\",\"project_id\":\"$project\"}"; }
row() { echo ".waiting [data-thought='$(js workspace "[...__ws.records.thoughts.values()].find(t=>t.text==='$1')?.id")']"; }
run "write:way.txt:agent"
until_has workspace "$(thought 'write:way.txt:agent' 'workdir?.changes')" 30 "pending" || fail "a fourth run's changes come back pending"
echo "mine" > "$tmp/project/way.txt"
way="$(row 'write:way.txt:agent')"
ask workspace "click $way .key" >/dev/null
until_has workspace "text $way .told" 30 "Not kept" && ask workspace "text $way .told" | grep -q "way.txt" && [ "$(cat "$tmp/project/way.txt")" = mine ] \
  && pass "a Keep that git refuses, a file of the person's being in the way, names the file in git's own words and touches nothing" || fail "Keep refused by git" "$(ask workspace "text $way")"
rm "$tmp/project/way.txt"
ask workspace "click $way .key" >/dev/null
until_has workspace "$(thought 'write:way.txt:agent' 'workdir?.changes')" 30 "kept" && [ "$(cat "$tmp/project/way.txt")" = agent ] \
  && pass "with the file moved away, Keep again brings the changes in" || fail "Keep after a refusal"
# The changes are in, but git will not remove the copy: said as kept with one thing left, with Tidy up as the action;
# Discard then removes what is left and the result reads as kept, not discarded.
run "write:locked.txt:n"
until_has workspace "$(thought 'write:locked.txt:n' 'workdir?.changes')" 30 "pending" || fail "a fifth run's changes come back pending"
git -C "$tmp/project" worktree lock "$(js workspace "[...__ws.records.thoughts.values()].find(t=>t.text==='write:locked.txt:n').workdir.path")"
locked="$(row 'write:locked.txt:n')"
ask workspace "click $locked .key" >/dev/null
until_has workspace "text $locked .told" 30 "Kept, with one thing left" && [ "$(cat "$tmp/project/locked.txt")" = n ] \
  && [ "$(js workspace "document.querySelector(\"$locked .key\").textContent + ' ' + document.querySelector(\"$locked .told\").getAttribute('role')")" = "Tidy up status" ] \
  && pass "a Keep whose changes are in while its copy stays says so as a success with one thing left, and offers Tidy up" || fail "Keep with the copy left" "$(ask workspace "text $locked")"
ask workspace "click $locked .btn:nth-of-type(2)" >/dev/null
until_has workspace "text .sheet" 3 "The changes stay in main" || fail "the discard sheet after a Keep"
press workspace ".sheet" Backspace true >/dev/null
until_has workspace "$(thought 'write:locked.txt:n' 'workdir?.changes')" 30 "kept" && [ "$(cat "$tmp/project/locked.txt")" = n ] \
  && js workspace "(__ws.ui.fold = 'results', __motion.redraw(), 1)" >/dev/null \
  && until_has workspace "text [data-thought='$(js workspace "[...__ws.records.thoughts.values()].find(t=>t.text==='write:locked.txt:n').id")']" 3 "Kept in main" \
  && pass "Discard then removes what is left, and the result reads Kept in main, not discarded" || fail "Discard after a Keep"
# A run that left only an ignored file: its copy cannot be removed by itself and waits, with nothing in it to keep.
run "write:out.log:built"
until_has workspace "$(thought 'write:out.log:built' 'workdir?.changes')" 30 "pending" || fail "a sixth run's copy is left over"
left="$(row 'write:out.log:built')"
until_has workspace "text $left" 5 "Copy left over" && ask workspace "text $left" | grep -q "A copy of the project is left over" \
  && [ "$(js workspace "[...document.querySelectorAll(\"$left :is(.key,.btn)\")].map(b => b.textContent).join('|')")" = "Remove the copy" ] && ! ask workspace "text $left" | grep -q "0 files" \
  && pass "a copy left over with nothing in it to keep says so, with Remove the copy as its one action" || fail "a leftover copy" "$(ask workspace "text $left")"
ask workspace "click $left .key" >/dev/null
until_has workspace "text .sheet" 3 "Remove the copy left by" || fail "the sheet for a leftover copy"
press workspace ".sheet" Backspace true >/dev/null
until_has workspace "$(thought 'write:out.log:built' 'workdir?.changes')" 30 "discarded" && pass "⌘⌫ removes the leftover copy" || fail "removing a leftover copy"
send "call put {\"c\":\"projects\",\"id\":\"$project\",\"patch\":{\"isolate\":\"busy\"}}"
js workspace "(__ws.show('$project'), 1)" >/dev/null
terminals=$(ask workspace "eval __ws.records.terminals.size")

echo "== Placing by a model: offered, allowed, briefed, undone, asked, and by name when the model fails"
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
# Not allowed yet: a thought that names no folder goes to the usual one, and that is the moment it is offered, once.
usual="$(js workspace "document.querySelector('.home #dest-chip b').textContent")"
[ "$(js workspace "String(__ws.records.prefs.has('route_by'))")" = false ] && [ -n "$usual" ] || fail "before it is allowed, the usual folder is where a thought goes"
home_says "Tidy the changelog a little"
until_has workspace "text .home .offer" 5 "Thoughts can find their own folder" && ask workspace "text .home .way" | grep -q "$usual" \
  && pass "the first thought that names no folder goes to the usual one, and placing by a model is offered under it, in one line" || fail "placing is offered"
js workspace "(document.querySelector('.home .offer .btn').click(), 1)" >/dev/null
terms="$(ask workspace "text .sheet")"
until_has workspace "text .sheet" 5 "Who reads them" && terms="$(ask workspace "text .sheet")" \
  && echo "$terms" | grep -q "the thought, as you said or typed it" && echo "$terms" | grep -q "names and aliases of up to 8" \
  && [ "$(js workspace "(r => r.querySelector('.t').textContent + ' ' + /fixture-small/.test(r.querySelector('.x').textContent))(document.querySelector('.line.tool[aria-checked=true]'))")" = "Fixture agent true" ] \
  && [ "$(js workspace "String(!document.querySelector('.instr'))")" = true ] \
  && pass "its sheet says what the person gets, which signed-in agent would read the thoughts and with which model, and exactly what is sent; nothing is stored yet" || fail "the placing sheet" "$(echo "$terms" | tr '\n' '|' | cut -c1-200)"
js workspace "(document.querySelector('.sheet .disc').click(), 1)" >/dev/null
until_has workspace "text .sheet .instr" 3 "You are the router of Tasktap" && pass "the instructions the model follows are there to read in full, behind one quiet line" || fail "the instructions"
shot placing-terms workspace
press workspace ".sheet" Enter >/dev/null
until_has workspace "eval JSON.stringify(__ws.records.prefs.get('route_by')?.value) + String(!!__ws.ui.sheet)" 5 '{"agent":"fixture","model":"fixture-small"}false' \
  && pass "Allow writes the preference for that agent and its model, and the sheet goes" || fail "Allow"
# The thought that was on its way is taken back, and its words return to the field.
ask workspace "click .home .way .act" >/dev/null
until_has workspace "eval $field.value" 3 "Tidy the changelog a little" && clear_field \
  && until_has workspace "eval String([...__ws.records.thoughts.values()].some(t => t.text === 'Tidy the changelog a little'))" 3 "false" || fail "the offered thought is taken back"
[ "$(js workspace "document.querySelector('.home #dest-chip b').textContent")" = "Where it belongs" ] \
  && pass "once allowed, a thought with no folder named goes where it belongs: the Composer says so before Return" || fail "the Composer's place once allowed"
# The model cannot decide between two folders: it asks, first and in full, on Home and in the notch.
before=$(thoughts)
says 'print:{"quote":"","confidence":"ambiguous","to":"","candidates":["p1","p2"],"brief":"Keep the header on one line.","title":""}'
home_says "so the header thing, I think it should stay on one line"
until_has workspace "text .home .needs .hq.open" 10 "Where should this go?" && asked="$(ask workspace "text .home .needs .hq.open")" \
  && echo "$asked" | grep -q "so the header thing, I think it should stay on one line" && echo "$asked" | grep -q "Brief so far" && echo "$asked" | grep -q "Keep the header on one line." \
  && echo "$asked" | grep -q "Keep for later" && [ "$(js workspace "[...document.querySelectorAll('.hq.open .ans span')].map(s => s.textContent).sort().join('|')")" = "Keep for later|other|project" ] \
  && pass "a thought the model could not place is a question, first on Home and in full: the thought, its brief so far, the folders it could mean on their keys, and Keep for later" || fail "the router's question on Home" "$(echo "${asked:-}" | tr '\n' '|' | cut -c1-240)"
until_has notch "text #sheet" 5 "Where should this go?" && ask notch "text #sheet" | grep -q "so the header thing" && ask notch "text #sheet" | grep -q "Keep for later" \
  && pass "the notch opens on the same question by itself, in full" || fail "the router's question in the notch"
shot router-question
shot router-question-home workspace
key="$(route_key project)"
js workspace "([...document.querySelectorAll('.hq.open .ans')].find(b => b.querySelector('span').textContent === 'project').click(), 1)" >/dev/null
until_has workspace "text .home .way" 5 "Keep the header on one line." && going="$(ask workspace "text .home .way")" \
  && echo "$going" | grep -q "project" && echo "$going" | grep -q "You said" && echo "$going" | grep -q "so the header thing" && echo "$going" | grep -q "Placed by Fixture agent · fixture-small" \
  && [ "$(js workspace "document.querySelector('.home .way .key')?.textContent")" = "Start" ] \
  && pass "answered, it is on its way to that folder: the brief in full, the person's own words under it, how it was placed, Undo and the key Start" || fail "the answered thought on its way" "$(echo "${going:-}" | tr '\n' '|' | cut -c1-240)"
shot held-brief workspace
ask workspace "click .home .way .act" >/dev/null
until_has workspace "eval $field.value + ' ' + [...__ws.records.thoughts.values()].find(t => t.text.startsWith('so the header thing'))?.phase" 3 "so the header thing, I think it should stay on one line captured" \
  && clear_field && until_has workspace "eval String(__ws.records.thoughts.size)" 3 "$before" \
  && pass "Undo during the hold stops it before anything starts and returns its words to the field" || fail "Undo during the hold"
# From the notch, placed by the model: Placing… with Undo while it is asked, then where it goes, what the work is called and the brief.
send "key notch Escape"
says "sleep:1500" "print:{\"quote\":\"\",\"confidence\":\"clear\",\"to\":\"$key\",\"candidates\":[],\"brief\":\"Make the footer half as tall. Leave the links in it as they are.\",\"title\":\"Shorter footer\"}"
send capture
until_has notch "eval document.activeElement?.id" 5 "capture-input" || fail "capture opens for a placed thought"
send "type notch okay the footer, it is way too tall, make it like half, but leave the links" "key notch Enter"
until_has notch "text #sheet .way" 3 "Placing…" && ask notch "text #sheet .way" | grep -q "Undo" \
  && pass "while the model is asked the thought says Placing…, with Undo" || fail "Placing…"
until_has notch "text #sheet .way" 10 "Make the footer half as tall." && going="$(ask notch "text #sheet .way")" \
  && echo "$going" | grep -q "project" && echo "$going" | grep -q "Shorter footer" && echo "$going" | grep -q "okay the footer, it is way too tall" \
  && [ "$(js notch "String((h => !!h && !h.hasAttribute('data-open') && parseFloat(getComputedStyle(h).getPropertyValue('--ms')) > 1000)(document.querySelector('.way-hold')))")" = true ] \
  && pass "placed by the model, it shows where it goes, what the work is called and the brief for the length of its hold, which is a line that runs out" || fail "the placed thought in the notch" "$(echo "${going:-}" | tr '\n' '|' | cut -c1-240)"
until_has workspace "text .home .way" 3 "Make the footer half as tall." && pass "Home shows the same thought on its way, whoever captured it" || fail "Home shows a thought the notch captured"
shot held-brief-notch
ask notch "click #sheet .way .act" >/dev/null
until_has notch "eval document.querySelector('#capture-input').value" 3 "okay the footer" && clear_field notch \
  && until_has workspace "eval String(__ws.records.thoughts.size)" 3 "$before" || fail "the placed thought is taken back"
send "key notch Escape"
# The model fails: the thought is placed by name, and the row says so with the core's reason as it is.
says "print:error:the model is overloaded"
home_says "the footer in project is still too tall for my taste, I said it before and I say it again, please make it a good deal shorter than it is now, about half, and leave everything else on the page exactly as it is"
until_has workspace "text .home .way" 10 "Placed by name." && ask workspace "text .home .way" | grep -q "the model is overloaded" \
  && pass "when the model could not be used the thought is placed by name, and says so with the reason as the core gave it" || fail "the fallback note" "$(ask workspace "text .home .way" | tr '\n' '|' | cut -c1-240)"
ask workspace "click .home .way .act" >/dev/null
until_has workspace "eval $field.value" 3 "the footer in project" && clear_field && until_has workspace "eval String(__ws.records.thoughts.size)" 3 "$before" || fail "the thought placed by name is taken back"
# Settings says what is on, and turns it off.
js workspace "(__ws.command('settings'), 1)" >/dev/null
until_has workspace "text .settings" 3 "By Fixture agent · fixture-small" && pass "Settings says who places the thoughts" || fail "Settings, Thoughts"
shot settings-flows workspace
js workspace "([...document.querySelectorAll('.settings .btn')].find(b => b.textContent.startsWith('What it is sent')).click(), 1)" >/dev/null
until_has workspace "text .sheet .acts" 3 "Turn off" && press workspace ".sheet" Backspace true >/dev/null
until_has workspace "eval JSON.stringify(__ws.records.prefs.get('route_by')?.value) + ' ' + __ws.ui.sheet?.kind" 3 "null settings" && ask workspace "text .settings" | grep -q "By name" \
  && pass "Turn off ends it: the preference holds No, so it is not offered again, and Settings says thoughts go by name" || fail "turning placing off"
js workspace "(__ws.dismiss(), 1)" >/dev/null

echo "== Voice: a speech service chosen, a thought spoken, a failure, and cancel (a tone made in the page; no microphone)"
tone() { js "${1:-workspace}" "(__speech.talk.source = 'tone')" >/dev/null; }
mic_down() { js workspace "(document.querySelector('.home .mic').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1 })), 1)" >/dev/null; }
mic_up() { js workspace "(document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })), 1)" >/dev/null; }
quiet() { until_has "${1:-workspace}" "eval String(__speech.live()) + ' ' + __records_size()" 5 "false 0"; }
js workspace "(window.__records_size = () => __ws.records.dictations.size, 1)" >/dev/null
send 'call delete {"c":"prefs","id":"speech_by"}'
until_has workspace "eval String(__ws.records.prefs.has('speech_by'))" 3 "false" || fail "no speech service is chosen"
# Without a service the microphone says why in one line, and leads to where one is chosen.
js workspace "(__ws.show('home'), document.querySelector('.home .mic').click(), 1)" >/dev/null
until_has workspace "text .home .ways" 3 "Voice needs a speech service" && js workspace "(document.querySelector('.home .ways .btn').click(), 1)" >/dev/null \
  && until_has workspace "eval __ws.ui.sheet?.kind + ' ' + __ws.ui.sheet?.at" 3 "settings speech" && ask workspace "text .settings" | grep -q "On this Mac is not built yet" \
  && pass "without a speech service the microphone says so in one line and leads to Speech in Settings, which says plainly that on this Mac is not built yet" || fail "voice without a service"
js workspace "([...document.querySelectorAll('.settings .btn')].find(b => b.textContent.startsWith('Use a speech service')).click(), 1)" >/dev/null
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
  && until_has workspace "text .settings" 3 "By 127.0.0.1:$port · fixture-speech" && pass "Allow writes the preference for that server and model, and Settings says where speech is turned into text" || fail "allowing a speech service"
# A key is only ever written: once stored, all that shows is that one is, and Remove.
js workspace "((k) => (k.focus(), document.execCommand('insertText', false, 'fixture-key-not-real'), k.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), 1))(document.querySelector('.settings input[type=password]'))" >/dev/null
until_has workspace "text .settings" 5 "A key is stored" && [ "$(js workspace "String(document.body.innerHTML.includes('fixture-key-not-real')) + ' ' + JSON.stringify(__ws.records.prefs.get('keys')?.value)")" = "false [\"http://127.0.0.1:$port\"]" ] \
  && js workspace "([...document.querySelectorAll('.settings .btn')].find(b => b.textContent === 'Remove').click(), 1)" >/dev/null \
  && until_has workspace "eval JSON.stringify(__ws.records.prefs.get('keys')?.value ?? [])" 5 "[]" \
  && pass "a key is written and never shown: Settings says one is stored, and Remove takes it away" || fail "the key field"
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
  && until_has workspace "text .home .way" 3 "You said" \
  && pass "letting go stops the recording at once; what was said becomes a thought on its way, with its hold and Undo, its words there to read" || fail "a spoken thought" "$(js workspace "JSON.stringify([[...__ws.records.dictations.values()], __speech.talk])" | cut -c1-300)"
heard="$(tail -1 "$tmp/speech.log")"
echo "$heard" | python3 -c 'import sys; p, rate, ch, bits, s, peak, hz = sys.stdin.read().split(); sys.exit(0 if (p, rate, ch, bits) == ("/v1/audio/transcriptions", "16000", "1", "16") and 1.0 < float(s) < 6 and int(peak) > 3000 and 200 < float(hz) < 240 else 1)' \
  && pass "the service was sent what the page recorded: 16 kHz, one channel, 16 bits, as long as it was held, with the tone in it ($heard)" || fail "the recording as the service got it" "$heard"
shot spoken-thought workspace
ask workspace "click .home .way .act" >/dev/null
until_has workspace "eval $field.value" 3 "Make the header stay on one line in project" && clear_field && until_has workspace "eval String(__ws.records.thoughts.size)" 3 "$before" || fail "the spoken thought is taken back"
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
js workspace "(__ws.show('$project'), 1)" >/dev/null

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
quit && pass "the app quits on request" || fail "the app quits on request"

echo "== Relaunched"
launch
until_has workspace "eval __ws.ui.ready" 10 "True" || fail "the relaunched page reaches the core"
js workspace "(__ws.menu.dry = true)" >/dev/null
js workspace "(__ws.show('$project'), 1)" >/dev/null
[ "$(ask workspace "eval JSON.stringify(__ws.layout('$project'))")" = "$layout" ] \
  && pass "after quit and relaunch the workspace's layout is restored as it was" || fail "the layout is restored"
until_has workspace "eval document.querySelectorAll('.pane:not([hidden])').length" 5 "$panes" || fail "its panes are shown"
[ "$(ask workspace "eval __ws.records.terminals.size")" = "$terminals" ] \
  && [ "$(ask workspace "eval [...__ws.records.terminals.values()].filter(t=>t.state==='running').length")" = "$running" ] \
  && pass "nothing is started again: the same terminals, still running" || fail "nothing reruns"
until_has workspace "eval [...document.querySelectorAll('.tab .lbl')].map(s=>s.textContent).join('|')" 5 "Hello from the smoke" \
  && pass "the run's tab is back with its name" || fail "the run's tab"
shot relaunched workspace
until_has workspace "text #sidebar" 5 "Sign-in terminals" && pass "a sign-in terminal still running is listed again" || fail "the sign-in terminal is listed again"
# The workspace's own menu is the system's; the check runs its item as choosing it would.
js workspace "(document.querySelector('[data-workspace=\"$project\"] .row.w').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})), 1)" >/dev/null
js workspace "__ws.choose('Close Workspace…')" >/dev/null
until_has workspace "text .sheet" 3 "and stop" && pass "closing a workspace with running sessions asks first" || fail "close workspace asks"
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

echo
[ "$fails" = 0 ] && echo "PASS  smoke" || echo "FAIL  smoke: $fails failed"
exit "$fails"
