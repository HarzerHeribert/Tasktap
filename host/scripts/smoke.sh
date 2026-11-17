#!/bin/bash
# host/scripts/smoke.sh: builds Tasktap Next with a core that has the fixture agent, runs it on a
# temporary data folder and drives it through its debug channel: the notch (capture, Undo, a run,
# a trust prompt, a question, affirm, the result) and the workspace (a run's terminal, a question
# in its pane, a shell typed into, splits, a moved tab, a divider, Keep running in background and
# restore, Stop, text size, then quit and relaunch with the layout restored and nothing rerun).
# It never sends keys or clicks to the system: every step is a line on the app's standard input,
# and the app is passive (its windows never take the keyboard). Prints PASS or FAIL per promise;
# exits non-zero on any FAIL. SHOTS=<folder> also saves captures of the app's own windows (needs
# screen recording permission for the terminal).
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
# The fixture agent as a person types it into a shell, under its own name (the shim's).
ln "$host/binaries/fixtures/tasktap" "$tmp/agents/fixture"
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
# A page expression, for the workspace's debug handle `__ws`: `js workspace "__ws.ui.view"`.
js() { ask "$1" "eval $2"; }
shot() {
  [ -n "${SHOTS:-}" ] || return 0
  mkdir -p "$SHOTS"; send state; sleep 0.5
  local line id; line=$(grep '"event":"state"' "$log" | tail -1)
  if [ "${2:-notch}" = notch ]; then id=$(echo "$line" | sed 's/.*"window":\([0-9]*\).*/\1/'); else id=$(echo "$line" | sed 's/.*"workspace":\([0-9]*\).*/\1/'); fi
  screencapture -x -o -l "$id" "$SHOTS/$1.png" 2>/dev/null
}
# A line typed into the workspace's shown terminal.
term_line() { js workspace "__ws.type('$1')" >/dev/null; sleep 0.4; }
screen() { echo "eval __ws.text()"; }

echo "== Driving the app on $tmp/data"
launch
for _ in $(seq 1 100); do grep -q '"event":"ready"' "$log" && break; sleep 0.1; done
grep -q '"event":"ready"' "$log" && pass "the app starts and reaches its own core" || { fail "the app starts" "$(tail -3 "$log")"; exit 1; }
until_has workspace "text #main" 10 "Home" && grep -q '"event":"window"' "$log" \
  && pass "the workspace window opens at launch, on Home, once its page has drawn" || fail "the workspace window opens"
# A core built with its fixtures detects its agents when asked, as a normal one does at start.
send 'call put {"c":"prefs","id":"agent","patch":"fixture"}' 'call put {"c":"prefs","id":"hold","patch":2}' 'call agents.detect {}'
sleep 1
shot collapsed-idle
shot home workspace

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
until_has workspace "text #sidebar" 5 "project" && pass "the workspace lists the project the run started in" || fail "the sidebar lists the project"

send "hover in"
until_has notch "text .notch-work" 10 "Open" || fail "the working row offers Open"
ask notch "click .notch-work-row" >/dev/null
until_has workspace "$(screen)" 10 "fixture-agent" && pass "Open shows the agent's terminal in the workspace" || fail "Open shows the terminal"
# The fixture agent, like Claude Code in a folder it does not trust yet, asks in its terminal first.
term_line "print:Do you trust the files in this folder?"
until_has notch "text #notch" 10 "trust this folder" && ask notch "text #notch" | grep -q "Answer in its terminal" \
  && pass "a folder-trust prompt in a starting agent's terminal opens the notch with the action that opens its terminal" \
  || fail "the trust prompt shows in the notch"
shot trust
until_has workspace "text .deck-question" 5 "Respond in this terminal" \
  && pass "the trust prompt shows in its pane, which sends the keyboard to the terminal" || fail "the trust prompt shows in its pane"
term_line "event:ready"
until_has notch "eval String(document.querySelector('#notch')?.open)" 5 "false" \
  && pass "the agent starting closes the trust question as answered in its terminal" || fail "the trust question closes"
term_line "event:turn_started"
term_line "ask:Deploy to staging?"
until_has notch "text #notch" 10 "Deploy to staging?" && pass "a question opens the notch by itself on its answer card" \
  || fail "the notch opens itself with the question"
ask notch "text #notch" | grep -q "Hello from the smoke" && pass "the card names the thought and project it belongs to" || fail "the card's context"
shot answer
until_has workspace "text .deck-question" 5 "Deploy to staging?" && ask workspace "text .deck-question" | grep -q "Yes" \
  && pass "the same question shows in its pane with the notch's answers" || fail "the question shows in its pane"
shot pane-question workspace
send affirm
until_has workspace "$(screen)" 10 "answer:yes" && pass "affirm, as its global shortcut sends it, answers the agent" \
  || fail "affirm answers the question"
term_line "ask:Ship it too?"
until_has workspace "text .deck-question" 10 "Ship it too?" || fail "a second question shows in the pane"
ask workspace "click .deck-question .primary" >/dev/null
until_has workspace "$(screen)" 10 "answer:yes" && [ "$(ask workspace "$(screen)" | grep -c 'answer:yes')" = 2 ] \
  && pass "Yes in the pane answers the agent" || fail "the pane's Yes answers"
term_line "event:turn_finished:All green."
until_has notch "text .glance-right" 10 "1" && pass "the collapsed glance counts the result as done and unread" || fail "the glance counts the result"
until_has workspace "text .deck-session-status" 5 "Answer ready" && ask workspace "eval document.querySelector('.nav-workspace')?.dataset.status" | grep -q complete \
  && pass "the pane and the sidebar mark the unread result" || fail "the result marks"
shot collapsed-done
shot pane-result workspace
send "hover in"
until_has notch "text #notch-home" 5 "All green." && pass "the open notch shows the result's summary" || fail "the result shows"
ask notch "text .notch-work" | grep -q "Open" && pass "the result offers Open" || fail "the result offers Open"
shot result
sleep 2
send "key notch Escape"
until_has notch "eval document.querySelector('.glance-right')?.innerText || 'none'" 5 "none" \
  && pass "a result seen in the notch is marked read and leaves the glance" || fail "seen results are marked read"

echo "== The workspace"
project=$(js workspace "__ws.ui.view")
js workspace "(__ws.command('new-terminal'), 1)" >/dev/null
until_has workspace "$(screen)" 10 "project" || fail "a new terminal shows its shell"
shell=$(js workspace "__ws.current().id")
term_line "echo smoke-\$((6*7))"
until_has workspace "$(screen)" 5 "smoke-42" && pass "a new terminal runs a shell that is typed into and answers" || fail "type and read a shell"
js workspace "(__ws.command('split-right'), 1)" >/dev/null
sleep 1
js workspace "(__ws.command('split-down'), 1)" >/dev/null
until_has workspace "eval JSON.stringify(__ws.layout('$project').tree).match(/\"axis\"/g)?.length" 5 "2" \
  && [ "$(ask workspace "eval document.querySelectorAll('.deck-group:not([hidden])').length")" = 3 ] \
  && pass "split right then split down nest two splits, each with a fresh terminal" || fail "nested splits"
shot splits workspace
sleep 1
until_has workspace "eval String([...__ws.engines].every(([id,e])=>!e.element.isConnected||e.element.hidden||(__ws.records.terminals.get(id).cols===e.term.cols&&__ws.records.terminals.get(id).rows===e.term.rows)))" 5 "true" \
  && pass "each shown terminal's size is its process's, after the splits resized it" || fail "terminal sizes follow the panes"
js workspace "(__ws.command('focus'), 1)" >/dev/null
until_has workspace "eval document.querySelectorAll('.deck-group:not([hidden])').length + ' ' + document.body.classList.contains('deck-focus')" 3 "1 true" \
  && js workspace "(__ws.command('focus'), 1)" >/dev/null \
  && until_has workspace "eval String(document.querySelectorAll('.deck-group:not([hidden])').length)" 3 "3" \
  && pass "Focus surface shows the selected pane alone, and again all of them" || fail "focus surface"
# Drag the agent's tab onto the bottom edge of the last pane.
js workspace "(()=>{const tab=document.querySelector('.deck-tab');const panes=document.querySelectorAll('.deck-group');const r=panes[panes.length-1].getBoundingClientRect();const t=tab.getBoundingClientRect();const ev=(k,x,y)=>tab.dispatchEvent(new PointerEvent(k,{bubbles:true,pointerId:7,isPrimary:true,button:0,clientX:x,clientY:y}));ev('pointerdown',t.x+10,t.y+10);ev('pointermove',t.x+30,t.y+30);ev('pointermove',r.x+r.width/2,r.bottom-8);ev('pointerup',r.x+r.width/2,r.bottom-8);return 1})()" >/dev/null
until_has workspace "eval JSON.stringify(__ws.layout('$project').tree).match(/\"axis\"/g)?.length" 5 "3" \
  && pass "dragging a tab to a pane's edge moves it into a new pane there" || fail "drag a tab"
divider=".deck-divider"
ask workspace "eval (document.querySelector('$divider').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})),1)" >/dev/null
r1=$(ask workspace "eval document.querySelector('$divider').getAttribute('aria-valuenow')")
ask workspace "eval (document.querySelector('$divider').dispatchEvent(new MouseEvent('dblclick',{bubbles:true})),1)" >/dev/null
r2=$(ask workspace "eval document.querySelector('$divider').getAttribute('aria-valuenow')")
[ "$r1" = 52 ] && [ "$r2" = 50 ] && pass "a divider resizes and a double-click balances it" || fail "divider" "$r1 then $r2"
shot moved workspace
js workspace "(__ws.focusSession('$shell'), 1)" >/dev/null
js workspace "(__ws.command('find'), 1)" >/dev/null
until_has workspace "text #modal" 3 "Find in terminal" || fail "the find dialog opens"
ask workspace "eval (document.querySelector('#deck-find-text').value='smoke-42', document.querySelector('#modal form').requestSubmit(), 1)" >/dev/null
until_has workspace "text #deck-find-state" 3 "Match highlighted" && pass "Find in terminal finds text in its scrollback" || fail "find"
ask workspace "click #modal .icon-btn" >/dev/null
# Copy and Paste go through a pasteboard of the check's own: the person's clipboard is never touched.
js workspace "(__ws.engines.get('$shell').term.selectAll(), 1)" >/dev/null
ask workspace "click .deck-group.selected .deck-pane-tools .deck-icon[title^='Copy']" >/dev/null
until_has workspace "eval await __ws.call('host.clipboard', {})" 3 "smoke-42" && pass "Copy puts the terminal's selection on the clipboard" || fail "copy"
js workspace "(await __ws.call('host.clipboard', {text: 'echo pasted-one\\necho pasted-two'}), 1)" >/dev/null
ask workspace "click .deck-group.selected .deck-pane-tools .deck-icon[title^='Paste']" >/dev/null
until_has workspace "$(screen)" 5 "echo pasted-two" && ! ask workspace "$(screen)" | grep -qx "pasted-one" \
  && pass "Paste is a bracketed paste: both lines reach the prompt and nothing runs" || fail "paste"
js workspace "(__ws.engines.get('$shell').term.input('\\x03', true), 1)" >/dev/null
# An agent chosen from the agents collection starts in a shell of the workspace, which the core adopts.
until_has workspace "eval [...__ws.records.agents.keys()].join(',')" 10 "fixture" || fail "the agents collection lists the fixture agent"
ask workspace "eval ([...document.querySelectorAll('.deck-tools-actions .deck-menu-item')].find(b=>b.textContent.includes('Fixture agent')).click(), 1)" >/dev/null
adopted=$(js workspace "__ws.current().id")
until_has workspace "eval String([...__ws.records.sessions.values()].some(s=>s.adopted&&s.terminal_id==='$adopted'))" 10 "true" \
  && pass "New session with an installed agent runs it in a shell of the workspace, where the core adopts it" || fail "an agent session"
# A terminal that belongs to no project, for signing an agent in.
js workspace "(__ws.newTerminal(__ws.LOOSE, {title: 'Sign in'}), 1)" >/dev/null
loose=$(js workspace "__ws.current().id")
until_has workspace "eval String(__ws.records.terminals.get('$loose')?.project_id)" 5 "null" \
  && ask workspace "text #sidebar" | grep -q "Sign-in terminals" && pass "a sign-in terminal runs with no project and is listed apart" || fail "a sign-in terminal"
js workspace "(__ws.show('home'), 1)" >/dev/null
until_has workspace "text #main" 5 "Hello from the smoke" && pass "Home lists the run among the recent results" || fail "Home lists the run"
ask workspace "click .home-result-row" >/dev/null
until_has workspace "$(screen)" 5 "fixture-agent --hook" && [ "$(js workspace "__ws.ui.view")" = "$project" ] \
  && pass "a Home row opens its session's terminal" || fail "a Home row opens its terminal"
js workspace "(__ws.command('new-task'), 1)" >/dev/null
until_has workspace "eval document.querySelector('#modal #dest-chip')?.textContent" 3 "project" \
  && pass "New task opens the capture line with its destination chip on this workspace" || fail "New task"
ask workspace "click #modal .icon-btn" >/dev/null
js workspace "(__ws.focusSession('$shell'), __ws.command('bigger'), __ws.command('bigger'), 1)" >/dev/null
until_has workspace "eval String(__ws.layout('$project').sizes['$shell'] === __ws.engines.get('$shell').term.options.fontSize && __ws.layout('$project').sizes['$shell'] > 0)" 3 "true" \
  && pass "⌘+ enlarges the terminal's text, remembered in its layout" \
  || fail "text size"
js workspace "(__ws.command('close-tab'), 1)" >/dev/null
until_has workspace "text #modal" 3 "Keep running in background" && pass "closing a live terminal's tab offers Keep running, Stop and Cancel" \
  || fail "the close dialog"
ask workspace "click #modal .stack .btn" >/dev/null
until_has workspace "text .nav-background" 3 "zsh" && pass "Keep running in background lists the session under its workspace" \
  || fail "the background row"
js workspace "(window.__kept = __ws.engines.get('$shell'), 1)" >/dev/null
shot background workspace
ask workspace "click .nav-background-session" >/dev/null
until_has workspace "$(screen)" 5 "smoke-42" \
  && [ "$(ask workspace "eval __ws.records.terminals.get('$shell').state")" = running ] \
  && pass "restoring it from the sidebar shows its terminal with its history, the same process" || fail "restore from the sidebar"
[ "$(js workspace "String(__ws.engines.get('$shell') === window.__kept && __ws.engines.get('$shell').resumed > 0 && __ws.engines.get('$shell').gaps === 0)")" = true ] \
  && pass "the restored tab continued from where its stream stopped, with no reset" || fail "continue without a reset"
terminals=$(ask workspace "eval __ws.records.terminals.size")
js workspace "(__ws.command('close-tab'), 1)" >/dev/null
until_has workspace "text #modal" 3 "Stop session" || fail "the close dialog again"
ask workspace "click #modal .stack .btn:nth-child(2)" >/dev/null
until_has workspace "eval __ws.records.terminals.get('$shell').state" 5 "exited" && pass "Stop session ends the process" || fail "stop"
# Closing the window leaves the notch; showing it again comes back to the same workspace.
panes=$(ask workspace "eval __ws.L.panes(__ws.layout('$project')).length")
send "close workspace"
sleep 1
until_has notch "text #islandToggle" 3 "" && [ "$(ask workspace "eval 1")" = None ] || fail "the workspace window closes"
send "show"
until_has workspace "eval __ws.ui.ready" 10 "True" && js workspace "(__ws.show('$project'), 1)" >/dev/null \
  && until_has workspace "eval document.querySelectorAll('.deck-group:not([hidden])').length" 5 "$panes" \
  && pass "closing the workspace window leaves the notch; it comes back with its workspace" || fail "close and show the window"
layout=$(ask workspace "eval JSON.stringify(__ws.layout('$project'))")
panes=$(ask workspace "eval __ws.L.panes(__ws.layout('$project')).length")
running=$(ask workspace "eval [...__ws.records.terminals.values()].filter(t=>t.state==='running').length")
sleep 1
quit && pass "the app quits on request" || fail "the app quits on request"

echo "== Relaunched"
launch
until_has workspace "eval __ws.ui.ready" 10 "True" || fail "the relaunched page reaches the core"
js workspace "(__ws.show('$project'), 1)" >/dev/null
[ "$(ask workspace "eval JSON.stringify(__ws.layout('$project'))")" = "$layout" ] \
  && pass "after quit and relaunch the workspace's layout is restored as it was" || fail "the layout is restored"
until_has workspace "eval document.querySelectorAll('.deck-group:not([hidden])').length" 5 "$panes" || fail "its panes are shown"
[ "$(ask workspace "eval __ws.records.terminals.size")" = "$terminals" ] \
  && [ "$(ask workspace "eval [...__ws.records.terminals.values()].filter(t=>t.state==='running').length")" = "$running" ] \
  && pass "nothing is started again: the same terminals, still running" || fail "nothing reruns"
until_has workspace "eval [...document.querySelectorAll('.deck-tab span')].map(s=>s.textContent).join('|')" 5 "Hello from the smoke" \
  && pass "the run's tab is back with its name" || fail "the run's tab"
shot relaunched workspace
until_has workspace "text #sidebar" 5 "Sign-in terminals" && pass "a sign-in terminal still running is listed again" || fail "the sign-in terminal is listed again"
js workspace "(document.querySelector('.nav-workspace-close').click(), 1)" >/dev/null
until_has workspace "text #modal" 3 "Close workspace and stop" && pass "closing a workspace with running sessions asks first" || fail "close workspace asks"
ask workspace "click #modal .form-actions .primary" >/dev/null
until_has workspace "eval String(__ws.records.projects.get('$project').open) + ' ' + [...__ws.records.terminals.values()].filter(t=>t.project_id==='$project'&&t.state==='running').length" 10 "false 0" \
  && pass "it closes the workspace and stops its sessions" || fail "close workspace"
js workspace "(__ws.command('open-workspace'), 1)" >/dev/null
until_has workspace "text #modal" 3 "Closed workspaces" || fail "the picker lists closed workspaces"
ask workspace "click .workspace-picker-row" >/dev/null
until_has workspace "eval __ws.ui.view" 5 "$project" && [ "$(ask workspace "eval JSON.stringify(__ws.layout('$project').tree)")" != null ] \
  && [ "$(ask workspace "eval __ws.records.terminals.size")" = "$terminals" ] \
  && pass "reopening it restores its layout and history and starts nothing" || fail "reopen a workspace"
quit && pass "the app quits on request again" || fail "the second quit"

echo
[ "$fails" = 0 ] && echo "PASS  smoke" || echo "FAIL  smoke: $fails failed"
exit "$fails"
