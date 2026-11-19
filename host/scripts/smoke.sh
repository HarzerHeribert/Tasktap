#!/bin/bash
# host/scripts/smoke.sh: builds Tasktap with a core that has the fixture agent, runs it on a
# temporary data folder and drives it through its debug channel: the notch (a thought saved for
# later before any folder is open and sent to one, capture, Undo, a run, a trust prompt, a question,
# affirm, the result; where Tasktap shows itself: the notch put away while the window is in front, a question in
# the strip, Needs you or a line in the title bar, the capture key and the answer keys by the rule, the notch that folds
# untouched or at a click elsewhere, the notification over a full-screen app), Home (first run, the agents' rings, the question in full, the Folds, Earlier,
# For later), the sidebar's slide, scrolling without bars, and the workspace (a run's
# terminal, a question in its pane's strip, a shell typed into, splits, a moved tab, a divider,
# the sheets, Keep running in background and restore, Stop, text size, Keep and Discard of a run
# that worked in its own copy of the project, placing by a model: offered, allowed, a thought placed and
# briefed by the core's fixture router, Undo during its hold, the router's question answered, placing by
# name when the model fails; voice: a speech service allowed, a thought spoken, words spoken into a field
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
fails=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1${2:+: $2}"; fails=$((fails + 1)); }

echo "== Building the pages, the cores and the host"
(cd "$root/ui" && npm run --silent build >/dev/null) || { echo "FAIL  ui build"; exit 1; }
"$host/scripts/build-core.sh" >/dev/null && FIXTURES=1 "$host/scripts/build-core.sh" >/dev/null || { echo "FAIL  core build"; exit 1; }
"$host/scripts/build-speech.sh" >/dev/null 2>&1 || { echo "FAIL  speech helper build"; exit 1; }
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

echo "== The Composer's field is the person's while a thought is sent (headless, real keys, a core that answers late or refuses)"
if out="$(node "$root/scripts/composer-check.cjs" 2>&1)"; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "the Composer's field"; fi

echo "== Links in terminals (headless, a real pointer and real keys, a host that keeps what it is asked to open)"
if out="$(node "$root/scripts/links-check.cjs" 2>&1)"; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "links in terminals"; fi

echo "== Voice, recorded by the page (headless, a microphone that is a file)"
if out="$(node "$root/scripts/voice-check.cjs" 2>&1)"; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "voice in the page"; fi

echo "== Speech on this Mac, in the page (headless, a microphone that is a file, a helper the check plays)"
if out="$(node "$root/scripts/speech-check.cjs" 2>&1)"; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "speech on this Mac in the page"; fi

echo "== Speech on this Mac, in the app (a short launch of its own; a tone and generated recordings, never the microphone)"
out="$(node "$root/scripts/speech-app-check.cjs" ${SPEECH_MODEL:+--model "$SPEECH_MODEL"} 2>&1)"
if [ $? = 0 ]; then echo "$out" | grep -E '^(PASS|NOTE)' | sed '$d'; pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "speech on this Mac in the app"; fi

if [ -n "${SPEECH_MODEL:-}" ]; then
  echo "== Speech on this Mac is written in the language it is said in (the real helper and model; the Mac's voices in files)"
  if out="$(node "$root/scripts/speech-language-check.cjs" "$SPEECH_MODEL" 2>&1)"; then pass "$(echo "$out" | tail -1 | sed 's/^PASS  //')"; else echo "$out" | grep '^FAIL' | sed 's/^FAIL  /  /'; fail "the language of speech on this Mac"; fi
fi

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

# Starts the app on the same data folder each time; its input is a new pipe on descriptor 3.
launch() {
  rm -f "$tmp/in"
  mkfifo "$tmp/in"
  env PATH="$tmp/agents:$PATH" TASKTAP_DEBUG=1 TASKTAP_PASSIVE=1 TASKTAP_DATA="$tmp/data" TASKTAP_PICK="$tmp/project" TASKTAP_OPEN="$tmp/opener" \
    TASKTAP_CORE_EXE="$host/binaries/fixtures/tasktap" TASKTAP_CORE_BUILD="$(cat "$host/binaries/fixtures/build.txt")" \
    "$host/target/debug/tasktap-app" < "$tmp/in" >> "$log" 2>&1 &
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
# First run is one composition: the Composer a little above the middle of the content, and on its own edges the one
# thing to do first, which is the key while the Composer is empty.
edges="((c, a, k, h) => [Math.abs(c.left + c.width / 2 - (h.left + h.width / 2)) < 1, a.left >= c.left && a.right <= c.right, Math.abs(k.right - document.querySelector('.home .cap-row .key').getBoundingClientRect().right) < 1, c.top + c.height / 2 < h.top + h.height / 2 && c.top > h.top + h.height * 0.2].join(' '))(document.querySelector('.home .cap').getBoundingClientRect(), document.querySelector('.attach').getBoundingClientRect(), document.querySelector('.attach .key').getBoundingClientRect(), document.querySelector('#main').getBoundingClientRect())"
until_has workspace "text .attach" 5 "Open a folder" && ! ask workspace "text .hx" | grep -q "Agents" \
  && [ "$(js workspace "[...document.querySelectorAll('#dest-chip > b, #dest-chip > span')].map(e => e.textContent).join(' · ')")" = "No folder yet · saved for later" ] \
  && [ "$(js workspace "(b => b.textContent + ' ' + b.disabled)(document.querySelector('.home .cap-row .key'))")" = "Save for later true" ] \
  && [ "$(js workspace "$edges")" = "true true true true" ] \
  && pass "with no folder open, Home is one composition: the Composer centred a little above the middle, its place saying No folder yet, saved for later, and its key that Return saves for later; under it, on its edges, Open a folder as the one key" || fail "Home on first run" "$(js workspace "$edges")"
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
# band moves and the light with it; once the loop is at its pace the compositor carries it, and the page draws
# keyframes and no frames; back at rest it stops.
if [ "$(js workspace "String(document.hidden)")" = true ]; then
  pass "the loop while agents work: the window is covered, so nothing is drawn yet"
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
    && [ "$(js workspace "__ws.records.prefs.get('agent').value + ' ' + __speech.cap.agent")" = "fixture $other" ] \
    && pass "a click on another ring picks that agent for the thought being written; the default, the core's preference, stays as it was" || fail "picking an agent by its ring"
  js workspace "(document.querySelector('.home .ring[data-agent=fixture]').click(), 1)" >/dev/null
  until_has workspace "eval document.querySelector('.home .ring[aria-checked=true]').dataset.agent + ' ' + __speech.cap.agent" 3 "fixture undefined" || fail "the usual agent is chosen again"
fi

echo "== A thought saved for later before a folder is open, then sent to one"
send capture
until_has notch "text #sheet" 5 "Save for later" && [ "$(js notch "[...document.querySelectorAll('#dest-chip > b, #dest-chip > span')].map(e => e.textContent).join(' · ')")" = "No folder yet · saved for later" ] \
  && pass "the capture shortcut opens the field; with no folder yet its place says No folder yet, saved for later, and its key that Return saves for later" \
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
until_has notch "eval [...document.querySelectorAll('#dest-chip > b, #dest-chip > span')].map(e => e.textContent).join(' · ')" 3 "project · the only folder open" \
  || fail "with one folder open, the chip says it is where a thought goes"
send "type notch Undo me" "key notch Enter"
until_has notch "text .way" 5 "project" && pass "with one folder open, the chip says it is where a thought goes, and Enter sends the thought there; it shows on its way" || fail "Enter sends"
ask notch "text .way" | grep -q "Undo" && [ "$(js notch "(b => b.textContent + ' ' + b.disabled)(document.querySelector('.cap-row .key'))")" = "Start false" ] \
  && [ "$(js notch "String((h => !!h && !h.hasAttribute('data-open') && parseFloat(getComputedStyle(h).getPropertyValue('--ms')) > 500)(document.querySelector('.way-hold')))")" = true ] \
  && pass "while it is held it offers Undo, the Composer's key says that Return starts it, and its hold is a line that runs out by the clock" || fail "the thought on its way offers Undo" "$(ask notch "text .way")"
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

echo "== Where Tasktap shows itself: the window or the notch, one place at a time"
# The system never puts a passive run's window in front, so the check says where it is as the system would
# (`where front|behind`, `where full on|off`), and brings the window forward for those steps (`front`, `back`) so that
# it is drawn; the keyboard stays where it is throughout. `hotkey` is a key from any app as the system tells of it.
hstate() { send state; sleep 0.5; grep '"event":"state"' "$log" | tail -1 | python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
closed="String(document.querySelector('#sheet').inert)"
glows="String(!!document.querySelector('#notch-art .glow-set'))"
open_q() { echo "eval [...__records.questions.values()].filter(q=>q.state==='open'&&q.prompt==='$1').length"; }
js workspace "(__ws.show('$project'), 1)" >/dev/null
send front "where front"
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
send "where behind" back
until_has notch "eval String(__where.notch)" 3 "true" && [ "$(hstate 'd["notch"]["hidden"]')" = False ] && sleep 1 \
  && [ "$(js notch "$closed")" = true ] && [ "$(js notch "$glows")" = true ] \
  && pass "rule 3: the window going behind with the question unanswered brings the glance back, glowing, and opens nothing" || fail "the window behind with a question waiting"
send answer
until_has notch "text #sheet" 5 "Rule one?" || fail "the answer key opens the notch on the question"
send front "where front"
until_has notch "eval $closed" 3 "true" && [ "$(hstate 'd["notch"]["hidden"]')" = True ] \
  && pass "rule 3: the window coming in front folds the open notch: the question is in one place" || fail "the window in front folds the notch"
send "where behind" back
send "hotkey y"
until_has notch "$(open_q 'Rule one?')" 10 "0" && until_has workspace "$(screen)" 5 "answer:yes" \
  && pass "rule 5: ⌃⌥Y from another app answers a yes-or-no question through the core" || fail "Yes from another app"
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
js workspace "(__ws.open({ kind: 'settings', at: 'about' }), 1)" >/dev/null
more="document.querySelector('.set-pane').dataset.more"
[ -z "$(js workspace "$bars")" ] && [ -z "$(js notch "$bars")" ] && until_has workspace "eval $more" 3 "down" \
  && js workspace "(document.querySelector('.set-pane').scrollTop = 9999, 1)" >/dev/null && until_has workspace "eval $more" 3 "up" \
  && pass "no scroller in either page shows a bar; one with more beyond an edge says which, for its content to dissolve there" || fail "scrolling without bars" "$(js workspace "$bars") $(js notch "$bars") $(js workspace "$more")"
# Settings is one sheet with its sections at its left: a section by its key, the arrows in the list, and it is the
# window's: on the window's centre with the sidebar open. ⌘W closes it, as it closes whatever is in front.
at="__ws.ui.sheet?.at + ' ' + document.querySelector('.set-nav [aria-selected=true]')?.textContent.replace(/[^A-Za-z]/g, '') + ' ' + document.activeElement?.id"
press workspace ".sheet" 3 true >/dev/null
until_has workspace "eval $at" 3 "agents Agents" && js workspace "(document.querySelector('#set-tab-agents').focus(), 1)" >/dev/null && press workspace "#set-tab-agents" ArrowDown >/dev/null \
  && until_has workspace "eval $at" 3 "appearance Appearance set-tab-appearance" \
  && [ "$(js workspace "(s => String(__ws.ui.sidebar && Math.abs((s.left + s.right) / 2 - innerWidth / 2) <= 0.5 && !document.querySelector('.wake canvas')))(document.querySelector('.sheet').getBoundingClientRect())")" = true ] \
  && pass "Settings is one sheet on the window's centre, the sidebar open: ⌘3 shows Agents, the arrows move through its sections with the keyboard, and no glyphs are shed as it comes" || fail "Settings' sections" "$(js workspace "$at")"
shot settings-appearance workspace
js workspace "(__ws.command('close-tab'), 1)" >/dev/null
until_has workspace "eval String(__ws.ui.sheet)" 3 "null" && pass "⌘W closes the sheet in front" || fail "⌘W with a sheet open"
echo "== Settings: what Return does, the two keys on one recorder, how long thoughts are kept, the terminal's switches, text size"
# A key pressed on the recorder in row `$1`, as the keyboard would: `$2` its code, then which modifiers are held.
setting() { echo "[...document.querySelectorAll('.set-pane .set')].find((r) => r.querySelector('.t').textContent === '$1')"; }
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
until_has workspace "text .set-pane" 5 "Return in a thought" || fail "the Thoughts section shows its rows"
# Return: as set, the Composer's key says what sends, and the field does it.
choose_in "Return in a thought" "Starts a new line"
until_has workspace "$(pref return_sends)" 3 "false" && until_has workspace "eval document.querySelector('.home .capture .key .sends').textContent + ' ' + $(setting "Return in a thought").querySelector('.hint').textContent" 3 "⌘ Command-Return sends it." \
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
until_has workspace "eval String(document.querySelector('.home .capture .key .sends').textContent)" 3 "" || fail "Return sends again"
js workspace "(__speech.cap.dest = undefined, (t => t && __ws.call('delete', { c: 'thoughts', id: t.id }).catch(() => 0))([...__ws.records.thoughts.values()].find((t) => t.text === 'see whether return sends')))" >/dev/null
# The capture key: recorded, refused by the rule in its own sentence, registered with the system, and back to the default.
js workspace "(__ws.open({ kind: 'settings', at: 'thoughts' }), 1)" >/dev/null
until_has workspace "$(key_row "From any app")" 5 "| false |" || fail "the capture key's row"
at_start="$(ask workspace "$(key_row "From any app")")"
record "From any app" KeyK
bare="$(ask workspace "$(key_row "From any app")")"
record "From any app" Space false false false true
kept="$(ask workspace "$(key_row "From any app")")"
case "$bare|$kept" in *"A shortcut needs Control, Option (Alt) or Command (the Windows key) held with its key."*"|"*"The system keeps that combination for itself."*) pass "a bare key and a combination the system keeps are refused under the recorder in the rule's own sentences, and the key in use stays (${at_start%% |*})" ;; *) fail "the recorder's refusals" "$bare || $kept" ;; esac
shot settings-key-refused workspace
js workspace "(r => (r.querySelector('.rec').click(), 1))($(setting "From any app"))" >/dev/null
sleep 0.3
js workspace "(r => (r.querySelector('.rec').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })), 1))($(setting "From any app"))" >/dev/null
until_has workspace "eval $(setting "From any app").querySelector('.rec').getAttribute('aria-pressed') + ' ' + __ws.ui.sheet?.kind" 3 "false settings" \
  && pass "Escape leaves the recorder and changes nothing; the sheet stays" || fail "Escape in the recorder"
record "From any app" F9 true true true
until_has workspace "$(key_row "From any app")" 5 "⌃⌥⇧F9 | false | " && until_has workspace "$(pref capture_key)" 3 '"code":"F9"' \
  && [ "$(js workspace "__ws.call('host.capture_key', {}).then((r) => r.key?.code)")" = F9 ] && grep -q '"event":"capture-key".*"code":"F9".*"ok":true\|"event":"capture-key".*"ok":true.*"code":"F9"' "$log" \
  && pass "a combination pressed in the recorder is asked of the system through the host, registered, stored as the preference and shown as the key in use (⌃⌥⇧F9)" || fail "a capture key of the person's own" "$(ask workspace "$(key_row "From any app")")"
shot settings-key-own workspace
js workspace "(r => ([...r.querySelectorAll('.btn')].find((b) => b.textContent === 'Use the default').click(), 1))($(setting "From any app"))" >/dev/null
sleep 1
back="$(ask workspace "$(key_row "From any app")")"
case "$back" in
  "⌃⌥Space | false | ") [ "$(ask workspace "$(pref capture_key)")" = null ] && pass "Use the default registers the system's own key again and removes the preference" || fail "back to the default key" "$back" ;;
  *"That key is taken by the system or another app."*) [ "$(js workspace "__ws.call('host.capture_key', {}).then((r) => r.key?.code)")" = F9 ] \
    && pass "the default key is held by another app on this Mac: the recorder says so in the host's words, and the key that was registered goes on working (⌃⌥⇧F9)" || fail "a taken key leaves the old one" "$back" ;;
  *) fail "back to the default key" "$back" ;;
esac
shot settings-key-default workspace
# How long finished thoughts are kept.
choose_in "Finished thoughts are kept" "30 days"
until_has workspace "$(pref keep_days)" 3 "30" && ask workspace "text .set-pane" | grep -q "Applies from the next start, or within a day. Nothing that waits for you is ever removed." \
  && choose_in "Finished thoughts are kept" "For ever" && until_has workspace "$(pref keep_days)" 3 "0" \
  && pass "how long finished thoughts are kept is one choice, with when it applies and that nothing waiting is removed" || fail "keep_days"
# The hold-to-talk key: the same recorder, a plain preference the core holds to the rule; every hint follows it.
js workspace "(__ws.open({ kind: 'settings', at: 'voice' }), 1)" >/dev/null
until_has workspace "$(key_row "Hold to talk")" 5 "⌥Space | false | " || fail "the hold-to-talk row"
record "Hold to talk" Space
until_has workspace "$(key_row "Hold to talk")" 3 "A shortcut needs Control" || fail "a bare talk key is refused by the core"
record "Hold to talk" KeyT true
until_has workspace "$(key_row "Hold to talk")" 3 "⌃T | false | " && until_has workspace "eval document.querySelector('.home .capture .mic kbd')?.textContent + ' ' + $(setting "Turned into text").innerText.includes('Hold ⌃T in a thought')" 3 "⌃T " \
  && pass "the hold-to-talk key is recorded the same way and stored as its preference; a bare key is refused in the core's sentence; the Composer's microphone and Settings name the new key at once" || fail "the hold-to-talk key" "$(ask workspace "$(key_row "Hold to talk")")"
shot settings-voice workspace
js workspace "(r => ([...r.querySelectorAll('.btn')].find((b) => b.textContent === 'Use the default').click(), 1))($(setting "Hold to talk"))" >/dev/null
until_has workspace "$(key_row "Hold to talk")" 3 "⌥Space | false | " && [ "$(ask workspace "$(pref talk_key)")" = null ] || fail "the talk key's default"
# The terminal's two switches, taken by open terminals at once.
js workspace "(__ws.open({ kind: 'settings', at: 'terminal' }), 1)" >/dev/null
opts="(e => e.term.options.drawBoldTextInBrightColors + ' ' + e.term.options.minimumContrastRatio)([...__ws.engines.values()][0])"
until_has workspace "eval $opts" 3 "true 4.5" || fail "the terminals' defaults"
js workspace "(document.querySelectorAll('.set-pane .switch').forEach((s) => s.click()), 1)" >/dev/null
until_has workspace "eval $opts" 3 "false 1" && js workspace "(document.querySelectorAll('.set-pane .switch').forEach((s) => s.click()), 1)" >/dev/null && until_has workspace "eval $opts" 3 "true 4.5" \
  && pass "the terminal's two switches (bold text in bright colours, text kept readable) reach every open terminal at once, and back" || fail "the terminal's switches" "$(js workspace "$opts")"
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
# Not allowed yet: Tasktap decides by a thought's words, so one that names no folder is saved for later, and that is
# the moment placing by a model is offered, once.
chip="[...document.querySelectorAll('.home #dest-chip > b, .home #dest-chip > span')].map(e => e.textContent).join(' · ')"
[ "$(js workspace "String(__ws.records.prefs.has('route_by'))")" = false ] && [ "$(js workspace "$chip")" = "Tasktap decides · by its words" ] \
  || fail "before it is allowed, Tasktap decides by a thought's words" "$(js workspace "$chip")"
home_says "Tidy the changelog a little"
until_has workspace "text .home .offer" 5 "Thoughts can find their own folder" && ask workspace "text .home .ways" | grep -q "It named no folder; saved for later" \
  && pass "the first thought that names no folder is saved for later, and placing by a model is offered under it, in one line" || fail "placing is offered"
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
# The thought it was offered under waits in For later; it is dropped.
js workspace "(__ws.call('delete', { c: 'thoughts', id: [...__ws.records.thoughts.values()].find(t => t.text === 'Tidy the changelog a little').id }), 1)" >/dev/null
until_has workspace "eval String([...__ws.records.thoughts.values()].some(t => t.text === 'Tidy the changelog a little'))" 3 "false" || fail "the offered thought is dropped"
[ "$(js workspace "document.querySelector('.home #dest-chip b').textContent")" = "Tasktap decides" ] \
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
  && echo "$going" | grep -q "project" && echo "$going" | grep -q "You said" && echo "$going" | grep -q "so the header thing" && echo "$going" | grep -q "Brief by Fixture agent · fixture-small" && ! echo "$going" | grep -q "Placed by" \
  && [ "$(js workspace "(b => b.textContent + ' ' + b.disabled)(document.querySelector('.home .cap-row .key'))")" = "Start false" ] \
  && pass "answered, it is on its way to that folder: the brief in full, the person's own words under it, who wrote the brief and not that anything placed it, since the person did, Undo, and the Composer's key Start" || fail "the answered thought on its way" "$(echo "${going:-}" | tr '\n' '|' | cut -c1-240)"
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
# (A moment for the sheet to listen: behind a locked screen the page is hidden, and a hidden page takes its time.)
until_has workspace "eval __ws.ui.sheet?.at" 3 "appearance" && sleep 1 && press workspace ".sheet" 1 true >/dev/null
until_has workspace "text .settings" 3 "By Fixture agent · fixture-small" && pass "Settings opens where it was last shown, and under Thoughts says who places them" || fail "Settings, Thoughts"
shot settings-flows workspace
js workspace "([...document.querySelectorAll('.settings .btn')].find(b => b.textContent.startsWith('What it is sent')).click(), 1)" >/dev/null
until_has workspace "text .sheet .sh-f" 3 "Turn off" && press workspace ".sheet" Backspace true >/dev/null
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
until_has workspace "text .home .ways" 3 "Voice needs setting up first" && js workspace "(document.querySelector('.home .ways .btn').click(), 1)" >/dev/null \
  && until_has workspace "eval __ws.ui.sheet?.kind + ' ' + __ws.ui.sheet?.at" 3 "settings voice" && ask workspace "text .settings" | grep -q "Needs a model first: Whisper large-v3 turbo, 574 MB" \
  && pass "with nothing to turn speech into text the microphone says so in one line and leads to Voice in Settings, which says what on this Mac needs" || fail "voice with nothing set up"
js workspace "([...document.querySelectorAll('.settings .seg button')].find(b => b.textContent === 'A speech service').click(), 1)" >/dev/null
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

echo "== An agent for one thought; what the host opens; links in a terminal; a session's details; a terminal open in 8 places"
# The ring picked goes with the thought written under it, and with no other: the next is the default's again.
other="$(js workspace "document.querySelector('.home .ring[data-agent^=fixture-]:not([data-s=off])')?.dataset.agent ?? ''")"
if [ -n "$other" ]; then
  js workspace "(document.querySelector('.home .ring[data-agent=$other]').click(), __speech.cap.dest = 'later', 1)" >/dev/null
  home_says "Let the other agent have this one"
  until_has workspace "$(thought 'Let the other agent have this one' agent) + ' ' + __ws.records.prefs.get('agent').value + ' ' + __speech.cap.agent + ' ' + document.querySelector('.home .ring[aria-checked=true]').dataset.agent" 5 "$other fixture undefined fixture" \
    && pass "a thought sent under a picked ring is that agent's ($other); the default stays, and the ring of the next thought is the default's again" || fail "an agent picked for one thought" "$(js workspace "JSON.stringify([__speech.cap.agent, __speech.cap.refused])")"
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

echo "== Previews beside a terminal: what a link opens, each kind, what a frame is held to, an agent's own, staying current"
# A web server of the check's own on this machine, and a project with one file of each kind.
python3 "$host/scripts/frame-fixture.py" "$tmp/frames.log" "$host/scripts/frame-probe.html" > "$tmp/frames.port" &
for _ in $(seq 1 50); do [ -s "$tmp/frames.port" ] && break; sleep 0.1; done
read -r fport remote < "$tmp/frames.port"
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
sleep 1
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
until_has workspace "eval __ws.records.previews.size + ' ' + document.querySelectorAll('.pane:not([hidden]) > .pv').length" 5 "$previews 1" \
  && pass "the previews outlive the app and its core: after quit and relaunch they are beside their terminal again" || fail "previews after a relaunch" "$(js workspace "__ws.records.previews.size")"
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
