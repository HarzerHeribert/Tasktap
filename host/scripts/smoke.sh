#!/bin/bash
# host/scripts/smoke.sh: builds Tasktap Next with a core that has the fixture agent, runs it on a
# temporary data folder and drives it through its debug channel: the notch (an idea kept before
# any folder is open and sent to one, capture, Undo, a run, a trust prompt, a question, affirm, the
# result), Home (the question in full, the Folds, Earlier, Ideas) and the workspace (a run's
# terminal, a question in its pane's strip, a shell typed into, splits, a moved tab, a divider,
# the sheets, Keep running in background and restore, Stop, text size, Keep and Discard of a run
# that worked in its own copy of the project, then quit and relaunch with the layout restored and
# nothing rerun). It never sends keys or clicks to the system: every step is a line on the app's
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

tmp="$(mktemp -d)"
log="$tmp/log"
mkdir -p "$tmp/agents" "$tmp/project"
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
until_has workspace "text .hx" 5 "Open a folder" && ask workspace "text .hx" | grep -q "Agents" \
  && [ "$(js workspace "document.querySelector('#dest-chip')?.textContent")" = Idea ] \
  && [ "$(js workspace "(b => b.textContent + ' ' + b.disabled)(document.querySelector('.home .cap-go'))")" = "↩Keep as an idea true" ] \
  && pass "with no folder open, Home offers to open one, lists the agents apart; its field's chip says Idea and its button, with its key, that Return keeps an idea" || fail "Home on first run"
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
  && [ "$(js workspace "document.querySelector('.light')?.dataset.breathe")" = false ] \
  && pass "while idle nothing is drawn and nothing breathes: Home holds its still light, and the notch has no canvas at all" || fail "nothing draws while idle"
# The sidebar's glyphs: a few, large, each a picture drawn once (no view of the motion's own), still while idle.
glyphs="[...document.querySelectorAll('.spark .glyph.in')]"
if [ "$(js workspace "String(document.hidden)")" = true ]; then
  pass "the sidebar's glyphs: the window is covered, so nothing is drawn yet"
else
  until_has workspace "eval String((g => g.length >= 2 && g.every(x => x.offsetWidth >= 56 && x.querySelector('.turn canvas')) && !document.querySelector('.spark .motion'))($glyphs))" 5 "true" \
    && a="$(js workspace "$glyphs.map(x => x.querySelector('.turn').style.transform).join('|')")" && sleep 1.5 \
    && [ "$(js workspace "$glyphs.map(x => x.querySelector('.turn').style.transform).join('|')")" = "$a" ] \
    && pass "the sidebar's foot shows a few large chrome glyphs, each a picture drawn once, at rest while idle" || fail "the sidebar's glyphs" "$(js workspace "$glyphs.length")"
fi
# The ambient light is the core's preference: Off removes the light and the glyphs, and the page keeps nothing itself.
send 'call put {"c":"prefs","id":"motion_ambient","patch":"off"}'
until_has workspace "eval String(!document.querySelector('.light') && !document.querySelector('.spark .glyph'))" 3 "true" \
  && send 'call delete {"c":"prefs","id":"motion_ambient"}' \
  && until_has workspace "eval String(!!document.querySelector('.light') && localStorage.length === 0)" 3 "true" \
  && pass "Ambient light is the core's preference: Off takes the light and the glyphs away at once, and nothing is kept in the page" || fail "the ambient light preference"
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

echo "== An idea, kept before a folder is open, then sent to one"
send capture
until_has notch "text #sheet" 5 "Keep as an idea" && [ "$(js notch "(c => c.textContent + ': ' + c.title)(document.querySelector('#dest-chip'))")" = "Idea: Kept as an idea until a folder is open" ] \
  && pass "the capture shortcut opens the field; with no folder yet its chip says Idea and its button that Return keeps an idea" \
  || fail "capture opens"
send "type notch Hello from the smoke" "key notch Enter"
until_has notch "text .cap-said" 5 "Kept as an idea" && [ "$(js notch "[...__records.thoughts.values()].find(t=>t.text==='Hello from the smoke')?.mode")" = note ] \
  && pass "Enter keeps it as an idea, and says so" || fail "an idea is kept"
send "key notch Escape"
until_has workspace "text .hx" 5 "Hello from the smoke" && pass "Home lists the idea" || fail "Home lists the idea"
ask workspace "click .hr.idea .btn" >/dev/null
until_has workspace "text .sheet" 3 "Open a folder" && pass "Send to a folder opens a sheet hanging from the title bar" || fail "the send sheet"
shot send-sheet workspace
press workspace ".sheet" o true >/dev/null
until_has workspace "text #sidebar" 10 "project" && pass "choosing a folder there opens it as a workspace" || fail "the folder opens"
project=$(js workspace "[...__ws.records.projects.values()].find(p=>p.kind==='folder')?.id")
until_has workspace "$(thought 'Hello from the smoke' phase)" 10 "working" && pass "the idea is sent there and starts after its hold" || fail "the idea starts"
until_has notch "text .tab .wing.l" 10 "1" && pass "the collapsed glance counts it working" || fail "the collapsed glance shows it working"
shot collapsed-working

echo "== Capture and Undo"
send capture
until_has notch "eval document.activeElement?.id" 5 "capture-input" || fail "capture opens again"
send "type notch Undo me" "key notch Enter"
until_has notch "text .cap-said" 5 "Sent to project" && pass "with a folder open, Enter sends the thought there" || fail "Enter sends"
ask notch "text .cap-said" | grep -q "Undo" && pass "the receipt offers Undo during the hold" || fail "the receipt offers Undo"
ask notch "click .cap-said .act" >/dev/null
until_has notch "eval document.querySelector('#capture-input').value" 3 "Undo me" \
  && pass "Undo stops the thought before it starts and returns its text to the field" || fail "Undo"
# Retyped and kept as an idea this time: the undone thought leaves no stale copy, and an idea can be dropped.
js notch "(__records && document.querySelector('#dest-chip').click(), 1)" >/dev/null
until_has notch "text .cap-list" 3 "Idea" || fail "the destination list"
ask notch "eval ([...document.querySelectorAll('.cap-list button')].find(b=>b.textContent==='Idea').click(), 1)" >/dev/null
send "eval notch (document.querySelector('#capture-input').focus(),document.execCommand('selectAll'),document.execCommand('insertText',false,'Drop me'))" "key notch Enter"
until_has notch "eval [...__records.thoughts.values()].map(t=>t.text).join('|')" 3 "Drop me" \
  && ask notch "eval [...__records.thoughts.values()].map(t=>t.text).join('|')" | grep -qv "Undo me" \
  && pass "the undone thought, retyped and kept as an idea, leaves no stale copy" || fail "Undo and retyping leave one thought"
shot capture-receipt
send "key notch Escape"
js workspace "(__ws.ui.fold = 'ideas', __motion.redraw(), 1)" >/dev/null
until_has workspace "text .fold-b" 3 "Drop me" || fail "the Ideas fold lists the idea"
js workspace "([...document.querySelectorAll('.hr.idea')].find(r=>r.textContent.includes('Drop me')).querySelectorAll('.btn')[1].click(), 1)" >/dev/null
until_has workspace "eval String([...__ws.records.thoughts.values()].some(t=>t.text==='Drop me'))" 3 "false" \
  && pass "Drop removes an idea" || fail "drop an idea"

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
  && [ "$(js workspace "(b => b.textContent + ' ' + b.disabled)(document.querySelector('.home .cap-go'))")" = "↩Start false" ] \
  && pass "Home's capture field grows a line for a longer thought, its destination a chip inside it, its button saying that Return starts it" || fail "Home's capture field"
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
ask workspace "click .waiting .btn.primary" >/dev/null
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
ask workspace "click .waiting .btn.primary" >/dev/null
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
ask workspace "click $way .btn.primary" >/dev/null
until_has workspace "text $way .told" 30 "Not kept" && ask workspace "text $way .told" | grep -q "way.txt" && [ "$(cat "$tmp/project/way.txt")" = mine ] \
  && pass "a Keep that git refuses, a file of the person's being in the way, names the file in git's own words and touches nothing" || fail "Keep refused by git" "$(ask workspace "text $way")"
rm "$tmp/project/way.txt"
ask workspace "click $way .btn.primary" >/dev/null
until_has workspace "$(thought 'write:way.txt:agent' 'workdir?.changes')" 30 "kept" && [ "$(cat "$tmp/project/way.txt")" = agent ] \
  && pass "with the file moved away, Keep again brings the changes in" || fail "Keep after a refusal"
# The changes are in, but git will not remove the copy: said as kept with one thing left, with Tidy up as the action;
# Discard then removes what is left and the result reads as kept, not discarded.
run "write:locked.txt:n"
until_has workspace "$(thought 'write:locked.txt:n' 'workdir?.changes')" 30 "pending" || fail "a fifth run's changes come back pending"
git -C "$tmp/project" worktree lock "$(js workspace "[...__ws.records.thoughts.values()].find(t=>t.text==='write:locked.txt:n').workdir.path")"
locked="$(row 'write:locked.txt:n')"
ask workspace "click $locked .btn.primary" >/dev/null
until_has workspace "text $locked .told" 30 "Kept, with one thing left" && [ "$(cat "$tmp/project/locked.txt")" = n ] \
  && [ "$(js workspace "document.querySelector(\"$locked .btn.primary\").textContent + ' ' + document.querySelector(\"$locked .told\").getAttribute('role')")" = "Tidy up status" ] \
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
  && [ "$(js workspace "[...document.querySelectorAll(\"$left .btn\")].map(b => b.textContent).join('|')")" = "Remove the copy" ] && ! ask workspace "text $left" | grep -q "0 files" \
  && pass "a copy left over with nothing in it to keep says so, with Remove the copy as its one action" || fail "a leftover copy" "$(ask workspace "text $left")"
ask workspace "click $left .btn.primary" >/dev/null
until_has workspace "text .sheet" 3 "Remove the copy left by" || fail "the sheet for a leftover copy"
press workspace ".sheet" Backspace true >/dev/null
until_has workspace "$(thought 'write:out.log:built' 'workdir?.changes')" 30 "discarded" && pass "⌘⌫ removes the leftover copy" || fail "removing a leftover copy"
send "call put {\"c\":\"projects\",\"id\":\"$project\",\"patch\":{\"isolate\":\"busy\"}}"
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
