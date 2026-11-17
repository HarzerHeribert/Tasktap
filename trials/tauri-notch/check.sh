#!/bin/bash
# Morning check for the Tauri notch trial: trials/tauri-notch/check.sh [focus]
# Needs an unlocked screen. Prints PASS, FAIL or NEEDS-EYES per item and saves captures in captures/.
# "focus" runs only the keyboard-focus comparison (2b, 2c, 2d) for the trial and for Tasktap Dev 1.2.
# It never touches /Applications/Tasktap.app or its data. It launches only the trial, the 1.2 reference
# helper (build/trialtool) and, if present, build/Tasktap Dev.app, and quits each of them.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
caps="$here/captures" build="$here/build"
app="$here/src-tauri/target/release/tauri-notch-trial" tool="$build/trialtool" probe="$build/probe.dylib"
log="$caps/trial.log" fifo="$build/trial.fifo"
mkdir -p "$caps" "$build"
full=1; [ "${1:-}" = focus ] && full=0
dry="${TRIAL_DRY:-0}"   # TRIAL_DRY=1 runs the flow on a locked screen: no prompts, no posted input, no captures.
pause() { [ "$dry" = 1 ] || read -r _; }
summary=()
mark() { summary+=("$(printf '%-11s %s' "$1" "$2")"); printf '\n%-11s %s\n' "$1" "$2"; }
js() { python3 -c "import json,sys; $1" "${@:2}"; }   # small JSON helpers below use python3 from macOS
last() { grep "\"event\":\"$1\"" "$log" | tail -1; }
count() { grep -c "\"event\":\"$1\"" "$log"; }
wait_for() { for _ in $(seq 1 "${2:-50}"); do [ "$(count "$1")" -gt "${3:-0}" ] && return 0; sleep 0.1; done; return 1; }

echo "== Building the trial, the 1.2 reference helper and the focus probe"
cargo build --release --quiet --manifest-path "$here/src-tauri/Cargo.toml" || { echo "FAIL: trial build"; exit 1; }
swiftc -O -target "$(uname -m)-apple-macosx26.0" -module-cache-path "${TMPDIR:-/tmp}/trial-module-cache" "$here/tool/main.swift" \
  "$root/native/NotchGeometry.swift" "$root/native/WorkspaceDecisionRim.swift" "$root/native/WorkspaceBackdrop.swift" -o "$tool" || { echo "FAIL: helper build"; exit 1; }
clang -dynamiclib -fobjc-arc -framework AppKit "$here/tool/probe.m" -o "$probe" || { echo "FAIL: probe build"; exit 1; }

if [ "$dry" != 1 ] && [ "$("$tool" locked)" = 1 ]; then echo "The screen is locked. Unlock it and run this script again."; exit 1; fi
access="$("$tool" access)"
capture=$(js 'print(int(json.loads(sys.argv[1])["screenCapture"]))' "$access")
ax=$(js 'print(int(json.loads(sys.argv[1])["accessibility"]))' "$access")
[ "$capture" = 1 ] || echo "NOTE: Screen capture permission is missing for this terminal, so no captures will be saved. Grant it in System Settings > Privacy & Security > Screen & System Audio Recording, then rerun. Continuing."
[ "$ax" = 1 ] || echo "NOTE: Accessibility permission is missing for this terminal, so the click, typing and drag steps ask you to do them by hand. Continuing."
[ "$dry" = 1 ] && { ax=0; capture=0; }
shot() { [ "$capture" = 1 ] && screencapture -x "$@"; }
if pgrep -f "/Applications/Tasktap.app/Contents/MacOS/Tasktap" >/dev/null; then
  echo "Tasktap (release) is running. Its notch sits where the trial's will be. Quit it from its menu bar item now (this script will not touch it), then press Enter."
  pause
fi

# --- Keyboard focus (2b, 2c, 2d), measured the same way for the trial and for Tasktap Dev 1.2 ----------------
# Each row records, at one moment: from inside the process (build/probe.dylib) NSApp.isActive; from outside
# (build/trialtool state) NSRunningApplication.isActive, the frontmost app, the menu bar owner and whether the
# system's keyboard focus is in the notch's process; and whether TextEdit's window still has its active title bar.
focus="$caps/focus.jsonl"; : > "$focus"
doc="$build/notch-focus-$(date +%H%M%S).txt"; : > "$doc"   # a fresh file each run, never changed while TextEdit has it open
tw="" te="" textedit_before="$(pgrep -x TextEdit)"
te_front() { # TextEdit in front with build/notch-focus.txt as the key window, whatever held the keyboard before
  [ "$dry" = 1 ] && return
  open -a TextEdit "$doc"; sleep 1.2; [ -n "$tw" ] || sleep 1; te=$(pgrep -x TextEdit | head -1)
  [ -n "$tw" ] && [ "$tw" != 0 ] || tw=$("$tool" frontwindow "$te" "$(basename "$doc")")
  # A click into the document, below the notch's reach, as a person would click back into it.
  read -r cx cy <<<"$("$tool" windows "$te" | js '
for l in sys.stdin:
    w=json.loads(l)
    if w["id"]==int(sys.argv[1]): b=w["bounds"]; print(b["X"]+b["Width"]/2, float(sys.argv[2])-(b["Y"]+b["Height"]-50))' "$tw" "$top")"
  [ -n "${cx:-}" ] && "$tool" click "$cx" "$cy"; sleep 0.8
}
snap() { # snap APP PID PROBELOG STEP [EXTRA_JSON]
  local extra="${5:-}"; [ -n "$extra" ] || extra='{}'
  kill -USR1 "$2" 2>/dev/null; sleep 0.3
  js '
s=json.loads(sys.argv[1]); k=json.loads(sys.argv[2]); i=json.loads(sys.argv[3] or "{}")
row=dict(app=sys.argv[4],step=sys.argv[5],nsAppActive=i.get("nsAppActive"),notchKey="Panel" in i.get("keyWindow",""),runningActive=s["runningActive"],
         frontmost=s["frontmost"],menuBarOwner=s["menuBarOwner"],keyboardInNotchApp=s["keyboardFocusIsTarget"],textEditTitleBarActive=k.get("keyAppearance"))
row.update(json.loads(sys.argv[6])); print(json.dumps(row))' "$("$tool" state "$2")" "$("$tool" keylook "${tw:-0}")" \
    "$(grep '"event":"snapshot"' "$3" 2>/dev/null | tail -1)" "$1" "$4" "$extra" | tee -a "$focus" | cut -c1-230
}
type_into() { # type_into PID TEXT type|typeonly: types only while PID holds the keyboard focus
  js 'sys.exit(0 if json.loads(sys.argv[1])["keyboardFocusIsTarget"] else 1)' "$("$tool" state "$1")" \
    || { echo "  (the keyboard focus is not in the notch's process; nothing was typed)"; return 1; }
  "$tool" "$3" "$2"
}
key_into() { # key_into PID CODE [MODS]: one key press, only while PID holds the keyboard focus
  js 'sys.exit(0 if json.loads(sys.argv[1])["keyboardFocusIsTarget"] else 1)' "$("$tool" state "$1")" && "$tool" key "$2" "${3:-}"
}
keys_after_close() { # keys_after_close APP PID PROBELOG STEP: where do keystrokes go once the notch has closed?
  sleep 1
  local kf where marker="zq$1$RANDOM"
  kf=$(js 'print(json.loads(sys.argv[1])["keyboardFocusPid"])' "$("$tool" state "${te:-0}")")
  if [ "$kf" = "${te:-}" ]; then "$tool" typeonly "$marker"; sleep 0.4
    if "$tool" axvalue "$te" | grep -q "$marker"; then where=TextEdit; else where="not into TextEdit"; fi
  elif [ "$kf" = "$2" ]; then "$tool" typeonly "$marker"; where="the closed notch"
  else where="another app (pid $kf); not typed"; fi
  snap "$1" "$2" "$3" "$4" "{\"keysGoTo\": \"$where\"}"
}
row() { js '
for l in open(sys.argv[1]):
    r=json.loads(l)
    if r["app"]==sys.argv[2] and r["step"]==sys.argv[3]: print(l.strip())' "$focus" "$1" "$2" | tail -1; }

trial_focus() {
  local plog="$caps/probe-trial.log" n field cx cy got
  echo "== 2b: a deliberate click into the notch field (trial)"
  te_front; snap trial "$pid" "$plog" "2b before"
  n=$(count hover); "$tool" warp "$tabx" "$taby"; wait_for hover 30 "$n"; sleep 0.8
  field="$(last open)"; "$tool" windows "$pid" > "$build/windows.json"
  read -r cx cy <<<"$(js '
o=json.loads(sys.argv[1])["data"]; p=json.loads(sys.argv[2])["panel"]["windowNumber"]; t=float(sys.argv[4])
w=[json.loads(l) for l in open(sys.argv[3]) if l.strip() and json.loads(l)["id"]==p][0]["bounds"]
x,y,fw,fh=o["field"]; print(w["X"]+x+fw/2, t-(w["Y"]+y+fh/2))' "$field" "$ready" "$build/windows.json" "$top")"
  "$tool" click "$cx" "$cy"; sleep 1
  snap trial "$pid" "$plog" "2b field focused"
  n=$(count typed); got=""
  type_into "$pid" tasktap type && wait_for typed 50 "$n" && got=$(js 'print(json.loads(sys.argv[1])["text"])' "$(last typed)")
  snap trial "$pid" "$plog" "2b typed" "{\"textReached\": $([ "$got" = tasktap ] && echo true || echo false)}" >/dev/null
  "$tool" warp "$tabx" "$((${taby%.*} - 400))"
  keys_after_close trial "$pid" "$plog" "2c after click"
  echo "== 2d: the shortcut path opens the field with focus (trial; 1.2 does this on Ctrl-Option-Space)"
  te_front; snap trial "$pid" "$plog" "2d before"
  n=$(count typed); got=""
  send capture; sleep 0.8
  snap trial "$pid" "$plog" "2d field focused"
  type_into "$pid" hello type && wait_for typed 50 "$n" && got=$(js 'print(json.loads(sys.argv[1])["text"])' "$(last typed)")
  snap trial "$pid" "$plog" "2d typed" "{\"textReached\": $([ "$got" = hello ] && echo true || echo false)}" >/dev/null
  "$tool" warp "$tabx" "$((${taby%.*} - 400))"
  keys_after_close trial "$pid" "$plog" "2c after shortcut"
}

dev_focus() {
  local plog="$caps/probe-dev.log" cx cy got
  echo "== 2b: a deliberate click into the notch field (Tasktap Dev 1.2)"
  te_front; snap dev "$devpid" "$plog" "2b before"
  "$tool" warp "$tabx" "$taby"; sleep 1.5
  # WebKit fills in its accessibility tree lazily, so ask a few times.
  cx=""; for _ in 1 2 3 4 5 6 7 8; do
  read -r cx cy <<<"$("$tool" ax "$devpid" AXTextArea | js '
t=float(sys.argv[1]); mid=float(sys.argv[2])
e=[json.loads(l) for l in sys.stdin]; e=[x for x in e if x["w"]>0 and abs(x["x"]+x["w"]/2-mid)<260 and x["y"]<400][0]
print(e["x"]+e["w"]/2, t-(e["y"]+e["h"]/2))' "$top" "$tabx" 2>/dev/null)"
  [ -n "${cx:-}" ] && break; sleep 0.5; done
  got=""
  if [ -n "${cx:-}" ]; then
    "$tool" click "$cx" "$cy"; sleep 1
    snap dev "$devpid" "$plog" "2b field focused"
    # No Return here: in 1.2 that would send a capture. The text is checked, then cleared.
    if type_into "$devpid" tasktap typeonly; then sleep 0.3; got=$("$tool" axvalue "$devpid"); key_into "$devpid" 0 cmd && key_into "$devpid" 51 && key_into "$devpid" 53; fi
  else echo "  no text field found in the 1.2 notch"; fi
  snap dev "$devpid" "$plog" "2b typed" "{\"textReached\": $([[ "$got" == *tasktap* ]] && echo true || echo false)}" >/dev/null
  "$tool" warp "$tabx" "$((${taby%.*} - 400))"
  keys_after_close dev "$devpid" "$plog" "2c after click"
  echo "== 2d: Ctrl-Option-Space opens the capture line with focus (Tasktap Dev 1.2)"
  te_front; snap dev "$devpid" "$plog" "2d before"
  "$tool" key 49 ctrl,alt; sleep 1.2
  snap dev "$devpid" "$plog" "2d field focused"
  got=""
  if type_into "$devpid" hello typeonly; then sleep 0.3; got=$("$tool" axvalue "$devpid"); key_into "$devpid" 0 cmd && key_into "$devpid" 51 && key_into "$devpid" 53; fi
  snap dev "$devpid" "$plog" "2d typed" "{\"textReached\": $([[ "$got" == *hello* ]] && echo true || echo false)}" >/dev/null
  "$tool" warp "$tabx" "$((${taby%.*} - 400))"
  keys_after_close dev "$devpid" "$plog" "2c after shortcut"
}

focus_verdicts() {
  echo; echo "== Keyboard focus: trial against Tasktap Dev 1.2"
  js '
rows=[json.loads(l) for l in open(sys.argv[1])]
cols=["nsAppActive","notchKey","runningActive","frontmost","menuBarOwner","keyboardInNotchApp","textEditTitleBarActive","textReached","keysGoTo"]
steps=[]
for r in rows:
    if r["step"] not in steps: steps.append(r["step"])
for s in steps:
    print(s)
    for a in ("trial","dev"):
        r=[x for x in rows if x["app"]==a and x["step"]==s]
        if r: print("   %-6s "%("1.2" if a=="dev" else a)+"  ".join("%s=%s"%(c,r[-1][c]) for c in cols if c in r[-1]))' "$focus"
  local verdict
  for case in "2b:field focused:typed:click" "2d:field focused:typed:shortcut"; do
    IFS=: read -r id step typed what <<<"$case"
    verdict=$(js '
t=json.loads(sys.argv[1] or "{}"); d=json.loads(sys.argv[2] or "{}"); tt=json.loads(sys.argv[3] or "{}"); dt=json.loads(sys.argv[4] or "{}")
seen=lambda r:(r.get("nsAppActive"),r.get("notchKey"),r.get("runningActive"),r.get("frontmost"),r.get("menuBarOwner"))
ok=t.get("frontmost")=="com.apple.TextEdit" and t.get("menuBarOwner")=="com.apple.TextEdit" and not t.get("runningActive") and t.get("notchKey") and tt.get("textReached")
same=bool(d) and seen(t)==seen(d) and tt.get("textReached")==dt.get("textReached")
print(("PASS" if ok else "FAIL")+" text reached=%s, notch key=%s, TextEdit stays frontmost and owns the menu bar=%s, NSApp.isActive trial %s / 1.2 %s, same as 1.2=%s, TextEdit title bar active trial %s / 1.2 %s"%(
  tt.get("textReached"),t.get("notchKey"),t.get("frontmost")=="com.apple.TextEdit" and t.get("menuBarOwner")=="com.apple.TextEdit",
  t.get("nsAppActive"),d.get("nsAppActive","not measured"),same,t.get("textEditTitleBarActive"),d.get("textEditTitleBarActive","not measured")))' \
      "$(row trial "$id $step")" "$(row dev "$id $step")" "$(row trial "$id $typed")" "$(row dev "$id $typed")")
    mark "${verdict%% *}" "$id $what: ${verdict#* }"
    verdict=$(js '
t=json.loads(sys.argv[1] or "{}"); d=json.loads(sys.argv[2] or "{}")
print(("PASS" if t.get("keysGoTo")=="TextEdit" else "FAIL")+" keys typed after the notch closed went to: trial %s, 1.2 %s"%(t.get("keysGoTo"),d.get("keysGoTo","not measured")))' \
      "$(row trial "2c after $what")" "$(row dev "2c after $what")")
    mark "${verdict%% *}" "2c after the $what: ${verdict#* }"
  done
}
# -------------------------------------------------------------------------------------------------------------

if [ "$full" = 1 ]; then
  echo "== Item 1: placement"
  if diff <("$tool" geometry) <("$app" --geometry) >/dev/null; then mark PASS "1a geometry: Rust port equals NotchGeometry.swift on all $("$tool" geometry | wc -l | tr -d ' ') synthetic displays"
  else mark FAIL "1a geometry: Rust port differs from NotchGeometry.swift"; diff <("$tool" geometry) <("$app" --geometry) | head -6; fi
fi
before_ptr="$("$tool" pointer)"
rm -f "$fifo"; mkfifo "$fifo"
: > "$caps/probe-trial.log"
DYLD_INSERT_LIBRARIES="$probe" PROBE_LOG="$caps/probe-trial.log" "$app" --backdrop < "$fifo" > "$log" 2>&1 &
pid=$!
exec 3>"$fifo"
send() { printf '%s\n' "$1" >&3; }
cleanup() { send quit 2>/dev/null; exec 3>&-; sleep 0.5; kill "$pid" 2>/dev/null; rm -f "$fifo"; }
trap cleanup EXIT
wait_for ready 150 || { echo "FAIL: the trial did not start; see $log"; exit 1; }
sleep 0.5
ready="$(last ready)"
# Tab centre and collapsed frame of the display the notch is on, in AppKit points.
read -r tabx taby fx fy fw fh <<<"$(js '
p=json.loads(sys.argv[1])["panel"]; x,y,w,h=map(float,p["frame"].split(","))
print(x+w/2, y+h-8, x, y, w, h)' "$ready")"
top=$(js 'print(json.loads(sys.argv[1])["top"])' "$before_ptr")
region="$(js 'x,y,w,h,t=map(float,sys.argv[1:]); print("%d,%d,%d,%d"%(x-30,t-(y+h)-0,w+60,h+30))' "$fx" "$fy" "$fw" "$fh" "$top")"
openregion="$(js 'x,w=map(float,sys.argv[1:3]); print("%d,0,%d,330"%(x+w/2-260,520))' "$fx" "$fw")"

if [ "$full" = 1 ]; then
  diff <("$tool" screens) <(js 'print("\n".join(json.loads(sys.argv[1])["screens"]))' "$ready") >/dev/null \
    && mark PASS "1b live screens: the trial computes the same tab and frames as NotchGeometry.swift for every connected display" \
    || mark FAIL "1b live screens differ from NotchGeometry.swift"
  "$tool" windows "$pid" > "$build/windows.json"
  verdict=$(js '
r=json.loads(sys.argv[1]); p=r["panel"]; wins=[json.loads(l) for l in open(sys.argv[2]) if l.strip()]
w=[x for x in wins if x["id"]==p["windowNumber"]]
ok=p["class"].endswith("TrialNotchPanel") and p["preventsActivationPrivateDiagnostic"] is not False and p["level"]==26 and p["collectionBehavior"]&257==257 and p["nonactivating"] and w and w[0]["layer"]==26 and w[0]["onscreen"]
print(("PASS" if ok else "FAIL")+" class=%s level=%s (window server layer %s) collectionBehavior=%s nonactivating=%s frame=%s"%(p["class"],p["level"],w[0]["layer"] if w else "?",p["collectionBehavior"],p["nonactivating"],p["frame"]))' "$ready" "$build/windows.json")
  mark "${verdict%% *}" "1c panel: ${verdict#* }"
  mark NEEDS-EYES "1d all Spaces: switch to another Space and to a full-screen app; the notch tab must stay at the camera"
fi

echo "== Item 2: reveal and keyboard focus. The script opens build/notch-focus.txt in TextEdit and brings it to the front itself."
echo "Press Enter, then keep your hands off the mouse and keyboard until the script says so (about 1 minute)."
pause
if [ "$full" = 1 ]; then
  te_front
  front="$("$tool" frontmost)"
  n=$(count hover)
  "$tool" warp "$tabx" "$taby"
  wait_for hover 30 "$n"; sleep 0.8
  hover="$(last hover)"; after="$("$tool" frontmost)"
  shot -R"$openregion" "$caps/trial-open.png"
  v=$(js '
h=json.loads(sys.argv[1]); a=json.loads(sys.argv[2]); b=json.loads(sys.argv[3]); f=h["focus"]
same=a.get("bundle")==b.get("bundle") and a.get("focusedElement")==b.get("focusedElement") and a.get("focusedWindow")==b.get("focusedWindow")
ok=h["inside"] and not f["appActive"] and not f["panelKey"] and same
print(("PASS" if ok else "FAIL")+" hover opened=%s trialActive=%s panelKey=%s frontmost %s -> %s, focused element unchanged=%s"%(h["inside"],f["appActive"],f["panelKey"],a.get("bundle"),b.get("bundle"),same))' "$hover" "$front" "$after")
  mark "${v%% *}" "2a hover: ${v#* }"
  "$tool" warp "$tabx" "$((${taby%.*} - 400))"; sleep 0.8
fi
if [ "$ax" = 1 ]; then trial_focus; else echo "2b to 2d need Accessibility for the terminal; skipped."; fi

if [ "$full" = 1 ]; then
  echo "== Item 2: crossing the cutout while dragging"
  n=$(count hover); d=$(count drag-cross)
  if [ "$ax" = 1 ]; then
    # Press inside the trial's own backdrop window (text, nothing to move), drag through the tab, release back there.
    # Only if the press point really is inside the trial's backdrop window.
    if "$tool" windows "$pid" | js '
b=[json.loads(l)["bounds"] for l in sys.stdin if "Backdrop trial" in l][0]
sys.exit(0 if b["X"]<380<b["X"]+b["Width"] and b["Y"]+40<320<b["Y"]+b["Height"] else 1)' 2>/dev/null; then
      "$tool" drag 380 "$(js 'print(float(sys.argv[1])-320)' "$top")" "$tabx" "$taby"
    else echo "The backdrop window is not where expected; skipping the posted drag. Do it by hand instead (15 s)."; sleep 15; fi
  else
    echo "By hand now (15 s): press the mouse button on the desktop or in a window, drag across the notch, linger there a moment, release away from it."
    for _ in $(seq 1 150); do [ "$(count drag-cross)" -gt "$d" ] && break; sleep 0.1; done
  fi
  sleep 0.5
  opened=$(grep '"event":"hover"' "$log" | tail -n +"$((n+1))" | grep -c '"inside":true')
  crossed=$(( $(count drag-cross) - d ))
  if [ "$crossed" -gt 0 ] && [ "$opened" = 0 ]; then mark PASS "2e drag: pointer crossed the tab with a button held ($crossed times) and the notch stayed closed"
  elif [ "$crossed" = 0 ]; then mark NEEDS-EYES "2e drag: the drag never reached the tab; repeat by hand"
  else mark FAIL "2e drag: the notch opened during a drag"; fi
  "$tool" warp "$tabx" "$((${taby%.*} - 400))"; sleep 0.8

  echo "== Item 3: decision glow (trial SVG vs the real 1.2 CoreAnimation rim)"
  send "rim on"; sleep 0.35; shot -R"$region" "$caps/trial-rim-pulse.png"; sleep 2.6; shot -R"$region" "$caps/trial-rim-steady.png"; send "rim off"
  "$tool" rim 4 >/dev/null & rp=$!; sleep 0.35; shot -R"$region" "$caps/native-rim-pulse.png"; sleep 2.6; shot -R"$region" "$caps/native-rim-steady.png"; wait "$rp" 2>/dev/null
  send "glow on"; sleep 1.5; shot -R"$region" "$caps/trial-prototype-css-glow.png"; send "glow off"
  mark NEEDS-EYES "3 glow: compare captures/trial-rim-*.png with captures/native-rim-*.png (same region, same moment of the pulse); also watch it live: echo 'rim on' runs once more now"
  send "rim on"; sleep 3; send "rim off"

  echo "== Item 4: translucent backdrop (Tauri windowEffects vs the real WorkspaceBackdrop.swift)"
  send "backdrop front"   # created unfocused at launch, so other windows may cover it by now
  "$tool" backdrop 660 160 6 >/dev/null & bp=$!; sleep 1.5
  shot -R100,140,1100,360 "$caps/backdrop-compare.png"
  echo "Look now: two windows at the top left, Tauri on the left, Swift 1.2 on the right (6 s)."
  wait "$bp" 2>/dev/null
  mark NEEDS-EYES "4 backdrop: compare left and right in captures/backdrop-compare.png; both should show the same blurred, tinted desktop"

  echo "== Item 5: content"
  shot -o -l"$(js 'print(json.loads(sys.argv[1])["panel"]["windowNumber"])' "$ready")" "$caps/trial-collapsed-window.png"
  mark NEEDS-EYES "5 content: captures/trial-open.png shows the card and text field with the prototype notch styles; compare with captures/dev-open.png"
fi

# Footprint is what the process itself costs (Activity Monitor's Memory column); resident size also counts
# shared system pages that every process maps, so it overstates both hosts.
idle() { sleep 8; printf '%s host process: %s resident, %s footprint, %s%% CPU over the last 5 s\n' "$1" \
  "$(ps -o rss= -p "$2" | awk '{printf "%.1f MB",$1/1024}')" "$(footprint "$2" 2>/dev/null | awk '/phys_footprint:/{print $2,$3; exit}')" \
  "$(top -l 2 -s 5 -stats pid,cpu -pid "$2" | tail -1 | awk '{print $2}')"; }
echo "== Idle cost"
idle "trial" "$pid"
cleanup; trap - EXIT

dev="$root/build/Tasktap Dev.app"
[ -d "$dev" ] || [ "$dry" = 1 ] || dev="$(git -C "$root" worktree list --porcelain | awk '/^worktree/{print $2; exit}')/build/Tasktap Dev.app"
if [ "$dry" != 1 ] && [ -d "$dev" ]; then
  echo "== Reference: $dev (with the same focus probe)"
  helpers_before="$(pgrep -f "Tasktap Dev.app" | sort)"
  : > "$caps/probe-dev.log"
  DYLD_INSERT_LIBRARIES="$probe" PROBE_LOG="$caps/probe-dev.log" "$dev/Contents/MacOS/Tasktap" >/dev/null 2>&1 &
  devpid=$!
  sleep 6
  if [ "$full" = 1 ]; then
    shot -R"$region" "$caps/dev-collapsed.png"
    "$tool" warp "$tabx" "$taby"; sleep 1.2; shot -R"$openregion" "$caps/dev-open.png"
    "$tool" warp "$tabx" "$((${taby%.*} - 400))"; sleep 0.8
    mark NEEDS-EYES "reference captures: captures/dev-collapsed.png and dev-open.png from Tasktap Dev 1.2"
  fi
  [ "$ax" = 1 ] && dev_focus
  idle "Tasktap Dev 1.2" "$devpid"
  kill "$devpid"; sleep 1
  for p in $(comm -13 <(echo "$helpers_before") <(pgrep -f "Tasktap Dev.app" | sort)); do kill "$p" 2>/dev/null; done
else
  mark NEEDS-EYES "no build/Tasktap Dev.app; build it with TASKTAP_DEV=1 ./scripts/build-mac.sh for reference captures and the focus comparison"
fi
read -r px py <<<"$(js 'p=json.loads(sys.argv[1]); print(p["x"],p["y"])' "$before_ptr")"; "$tool" warp "$px" "$py"
[ "$ax" = 1 ] && focus_verdicts
if [ -n "$te" ]; then "$tool" closedoc "$te" "$doc" >/dev/null; [ -n "$textedit_before" ] || kill "$te" 2>/dev/null; fi
rm -f "$doc"
echo; echo "Hands free again."

if [ "$full" = 1 ]; then
  echo "== Item 6: pass-through measurements with the screen unlocked (about 2 minutes)"
  "$app" --bench < /dev/null 2>/dev/null | grep '"bench"' > "$caps/bench-tauri.json"
  "$tool" bench "$here/ui/bench.html" 2>/dev/null | grep '"bench"' > "$caps/bench-swift.json"
  js '
for f in sys.argv[1:]:
    try: d=json.load(open(f))["data"]
    except Exception: print("no result in",f); continue
    for p in d["push"]: print("  %-45s %6d B %9s MB/s"%(p["name"],p["size"],p.get("mbps",p.get("error"))))
    for k in d["keys"]: print("  %-52s mean %.3f ms, p95 %.3f ms"%(k["name"],k["meanMs"],k["p95Ms"]))' "$caps/bench-tauri.json" "$caps/bench-swift.json"
  mark NEEDS-EYES "6 numbers: compare the table above with RESULT.md"
fi

echo; echo "== Summary"; printf '%s\n' "${summary[@]}"
echo; echo "Captures: $caps   Trial log: $log   Focus rows: $focus"
