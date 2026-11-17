#!/bin/bash
# Morning check for the Tauri notch trial: trials/tauri-notch/check.sh
# Needs an unlocked screen. Prints PASS, FAIL or NEEDS-EYES per item and saves captures in captures/.
# It never touches /Applications/Tasktap.app or its data. It launches only the trial, the 1.2 reference
# helper (build/trialtool) and, if present, build/Tasktap Dev.app, and quits each of them.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
caps="$here/captures" build="$here/build"
app="$here/src-tauri/target/release/tauri-notch-trial" tool="$build/trialtool"
log="$caps/trial.log" fifo="$build/trial.fifo"
mkdir -p "$caps" "$build"
dry="${TRIAL_DRY:-0}"   # TRIAL_DRY=1 runs the flow on a locked screen: no prompts, no posted input, no captures.
pause() { [ "$dry" = 1 ] || read -r _; }
# Pressing Enter here gives this terminal the keyboard, so the script hands it
# back to TextEdit itself before a step that needs TextEdit in front.
textedit_front() { [ "$dry" = 1 ] || { open -a TextEdit; sleep 2; }; }
summary=()
mark() { summary+=("$(printf '%-11s %s' "$1" "$2")"); printf '\n%-11s %s\n' "$1" "$2"; }
note() { printf '            %s\n' "$*"; }
js() { python3 -c "import json,sys; $1" "${@:2}"; }   # small JSON helpers below use python3 from macOS
last() { grep "\"event\":\"$1\"" "$log" | tail -1; }
count() { grep -c "\"event\":\"$1\"" "$log"; }
wait_for() { for _ in $(seq 1 "${2:-50}"); do [ "$(count "$1")" -gt "${3:-0}" ] && return 0; sleep 0.1; done; return 1; }

echo "== Building the trial and the 1.2 reference helper"
cargo build --release --quiet --manifest-path "$here/src-tauri/Cargo.toml" || { echo "FAIL: trial build"; exit 1; }
swiftc -O -target "$(uname -m)-apple-macosx26.0" -module-cache-path "${TMPDIR:-/tmp}/trial-module-cache" "$here/tool/main.swift" \
  "$root/native/NotchGeometry.swift" "$root/native/WorkspaceDecisionRim.swift" "$root/native/WorkspaceBackdrop.swift" -o "$tool" || { echo "FAIL: helper build"; exit 1; }

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

echo "== Item 1: placement"
if diff <("$tool" geometry) <("$app" --geometry) >/dev/null; then mark PASS "1a geometry: Rust port equals NotchGeometry.swift on all $("$tool" geometry | wc -l | tr -d ' ') synthetic displays"
else mark FAIL "1a geometry: Rust port differs from NotchGeometry.swift"; diff <("$tool" geometry) <("$app" --geometry) | head -6; fi
before_ptr="$("$tool" pointer)"
rm -f "$fifo"; mkfifo "$fifo"
"$app" --backdrop < "$fifo" > "$log" 2>&1 &
pid=$!
exec 3>"$fifo"
send() { printf '%s\n' "$1" >&3; }
cleanup() { send quit 2>/dev/null; exec 3>&-; sleep 0.5; kill "$pid" 2>/dev/null; rm -f "$fifo"; }
trap cleanup EXIT
wait_for ready 150 || { echo "FAIL: the trial did not start; see $log"; exit 1; }
sleep 0.5
ready="$(last ready)"
diff <("$tool" screens) <(js 'print("\n".join(json.loads(sys.argv[1])["screens"]))' "$ready") >/dev/null \
  && mark PASS "1b live screens: the trial computes the same tab and frames as NotchGeometry.swift for every connected display" \
  || mark FAIL "1b live screens differ from NotchGeometry.swift"
"$tool" windows "$pid" > "$build/windows.json"
verdict=$(js '
import json
r=json.loads(sys.argv[1]); p=r["panel"]; wins=[json.loads(l) for l in open(sys.argv[2]) if l.strip()]
w=[x for x in wins if x["id"]==p["windowNumber"]]
ok=p["class"].endswith("TrialNotchPanel") and p["preventsActivationPrivateDiagnostic"] is not False and p["level"]==26 and p["collectionBehavior"]&257==257 and p["nonactivating"] and w and w[0]["layer"]==26 and w[0]["onscreen"]
print(("PASS" if ok else "FAIL")+" class=%s level=%s (window server layer %s) collectionBehavior=%s nonactivating=%s frame=%s"%(p["class"],p["level"],w[0]["layer"] if w else "?",p["collectionBehavior"],p["nonactivating"],p["frame"]))' "$ready" "$build/windows.json")
mark "${verdict%% *}" "1c panel: ${verdict#* }"
mark NEEDS-EYES "1d all Spaces: switch to another Space and to a full-screen app; the notch tab must stay at the camera"

# Tab centre and collapsed frame of the display the notch is on, in AppKit points.
read -r tabx taby fx fy fw fh <<<"$(js '
import json
p=json.loads(sys.argv[1])["panel"]; x,y,w,h=map(float,p["frame"].split(","))
print(x+w/2, y+h-8, x, y, w, h)' "$ready")"
top=$(js 'print(json.loads(sys.argv[1])["top"])' "$before_ptr")
region="$(js 'x,y,w,h,t=map(float,sys.argv[1:]); print("%d,%d,%d,%d"%(x-30,t-(y+h)-0,w+60,h+30))' "$fx" "$fy" "$fw" "$fh" "$top")"
openregion="$(js 'x,w=map(float,sys.argv[1:3]); print("%d,0,%d,330"%(x+w/2-260,520))' "$fx" "$fw")"

echo "== Item 2: reveal without stealing focus"
echo "Open a new empty TextEdit document, then come back here, press Enter and keep your hands off for 20 s."
echo "(The script brings TextEdit back to the front itself, and types only after the trial's panel reports that it holds keyboard focus.)"
pause
textedit_front
front="$("$tool" frontmost)"
n=$(count hover)
"$tool" warp "$tabx" "$taby"
wait_for hover 30 "$n"; sleep 0.8
hover="$(last hover)"; after="$("$tool" frontmost)"
shot -R"$openregion" "$caps/trial-open.png"
v=$(js '
import json
h=json.loads(sys.argv[1]); a=json.loads(sys.argv[2]); b=json.loads(sys.argv[3]); f=h["focus"]
same=a.get("bundle")==b.get("bundle") and a.get("focusedElement")==b.get("focusedElement") and a.get("focusedWindow")==b.get("focusedWindow")
ok=h["inside"] and not f["appActive"] and not f["panelKey"] and same
print(("PASS" if ok else "FAIL")+" hover opened=%s trialActive=%s panelKey=%s frontmost %s -> %s, focused element unchanged=%s"%(h["inside"],f["appActive"],f["panelKey"],a.get("bundle"),b.get("bundle"),same))' "$hover" "$front" "$after")
mark "${v%% *}" "2a hover: ${v#* }"

echo "== Item 2: a deliberate click focuses the field without activating the trial"
n=$(count typed)
if [ "$ax" = 1 ]; then
  sleep 0.3
  field="$(last open)"
  "$tool" windows "$pid" > "$build/windows.json"
  read -r cx cy <<<"$(js '
import json
o=json.loads(sys.argv[1])["data"]; p=json.loads(sys.argv[2])["panel"]["windowNumber"]; t=float(sys.argv[4])
w=[json.loads(l) for l in open(sys.argv[3]) if l.strip() and json.loads(l)["id"]==p][0]["bounds"]
x,y,fw,fh=o["field"]; print(w["X"]+x+fw/2, t-(w["Y"]+y+fh/2))' "$field" "$ready" "$build/windows.json" "$top")"
  "$tool" click "$cx" "$cy"; sleep 0.3
  # Type only when the trial's panel holds keyboard focus, so nothing lands in another app.
  n_probe=$(count probe); send probe; wait_for probe 20 "$n_probe"
  if js 'sys.exit(0 if json.loads(sys.argv[1])["focus"]["panelKey"] else 1)' "$(last probe)"; then "$tool" type tasktap
  else echo "The click did not give the panel keyboard focus; nothing was typed."; fi
else
  echo "By hand now: hover the notch, click its text field, type tasktap and press Enter (20 s)."
fi
if wait_for typed 200 "$n"; then
  v=$(js '
import json
t=json.loads(sys.argv[1]); f=t["focus"]
print(("PASS" if t["text"]=="tasktap" and not f["appActive"] else "FAIL")+" text=%r trialActive=%s panelKey=%s frontmost=%s"%(t["text"],f["appActive"],f["panelKey"],f["frontmost"]))' "$(last typed)")
  mark "${v%% *}" "2b click focus: ${v#* }"
else mark FAIL "2b click focus: no text reached the trial"; fi
"$tool" warp "$tabx" "$((${taby%.*} - 400))"; sleep 0.8
mark NEEDS-EYES "2c after the notch closes, type in the app you were using: keystrokes must go there without clicking it first"

echo "== Shortcut path (1.2 opens the capture line with focus from a global shortcut)"
echo "Press Enter here; the script brings the TextEdit document back to the front."
pause
textedit_front
n=$(count typed)
send capture; sleep 0.6
cap="$(last capture)"
if [ "$ax" = 1 ] && js 'sys.exit(0 if json.loads(sys.argv[1])["focus"]["panelKey"] else 1)' "$cap"; then "$tool" type hello
elif [ "$ax" = 1 ]; then echo "The panel did not take keyboard focus; nothing was typed."; else echo "By hand now: type hello and press Enter without clicking anything (20 s)."; fi
if wait_for typed 200 "$n"; then
  v=$(js '
import json
c=json.loads(sys.argv[1])["focus"]; t=json.loads(sys.argv[2]); f=t["focus"]
ok=t["text"]=="hello" and c["panelKey"] and not c["appActive"] and not f["appActive"]
print(("PASS" if ok else "FAIL")+" panelKey=%s trialActive=%s typed=%r frontmost=%s"%(c["panelKey"],f["appActive"],t["text"],f["frontmost"]))' "$cap" "$(last typed)")
  mark "${v%% *}" "2d key panel without activation: ${v#* }"
else mark FAIL "2d key panel without activation: typed text never reached the trial"; fi
sleep 0.6

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
"$tool" backdrop 660 160 6 >/dev/null & bp=$!; sleep 1.5
shot -R100,140,1100,360 "$caps/backdrop-compare.png"
echo "Look now: two windows at the top left, Tauri on the left, Swift 1.2 on the right (6 s)."
wait "$bp" 2>/dev/null
mark NEEDS-EYES "4 backdrop: compare left and right in captures/backdrop-compare.png; both should show the same blurred, tinted desktop"

echo "== Item 5: content"
shot -o -l"$(js 'print(json.loads(sys.argv[1])["panel"]["windowNumber"])' "$ready")" "$caps/trial-collapsed-window.png"
mark NEEDS-EYES "5 content: captures/trial-open.png shows the card and text field with the prototype notch styles; compare with captures/dev-open.png"

echo "== Idle cost"
sleep 5
ps -o rss=,%cpu= -p "$pid" | awk '{printf "trial host process: %.1f MB resident, %s%% CPU\n",$1/1024,$2}'
cleanup; trap - EXIT

dev="$root/build/Tasktap Dev.app"
[ -d "$dev" ] || [ "$dry" = 1 ] || dev="$(git -C "$root" worktree list --porcelain | awk '/^worktree/{print $2; exit}')/build/Tasktap Dev.app"
if [ "$dry" != 1 ] && [ -d "$dev" ]; then
  echo "== Reference: $dev"
  open -g -n "$dev"; sleep 6
  devpid=$(pgrep -f "$dev/Contents/MacOS/Tasktap" | head -1)
  shot -R"$region" "$caps/dev-collapsed.png"
  "$tool" warp "$tabx" "$taby"; sleep 1.2; shot -R"$openregion" "$caps/dev-open.png"
  "$tool" warp "$tabx" "$((${taby%.*} - 400))"; sleep 0.8
  [ -n "$devpid" ] && ps -o rss=,%cpu= -p "$devpid" | awk '{printf "Tasktap Dev host process: %.1f MB resident, %s%% CPU\n",$1/1024,$2}'
  [ -n "$devpid" ] && kill "$devpid"
  mark NEEDS-EYES "reference captures: captures/dev-collapsed.png and dev-open.png from Tasktap Dev 1.2"
else
  mark NEEDS-EYES "no build/Tasktap Dev.app; build it with TASKTAP_DEV=1 ./scripts/build-mac.sh for reference captures"
fi
read -r px py <<<"$(js 'p=json.loads(sys.argv[1]); print(p["x"],p["y"])' "$before_ptr")"; "$tool" warp "$px" "$py"

echo "== Item 6: pass-through measurements with the screen unlocked (about 2 minutes)"
"$app" --bench < /dev/null 2>/dev/null | grep '"bench"' > "$caps/bench-tauri.json"
"$tool" bench "$here/ui/bench.html" 2>/dev/null | grep '"bench"' > "$caps/bench-swift.json"
js '
import json
for f in sys.argv[1:]:
    try: d=json.load(open(f))["data"]
    except Exception: print("no result in",f); continue
    for p in d["push"]: print("  %-45s %6d B %9s MB/s"%(p["name"],p["size"],p.get("mbps",p.get("error"))))
    for k in d["keys"]: print("  %-52s mean %.3f ms, p95 %.3f ms"%(k["name"],k["meanMs"],k["p95Ms"]))' "$caps/bench-tauri.json" "$caps/bench-swift.json"
mark NEEDS-EYES "6 numbers: compare the table above with RESULT.md (measured while the screen was locked)"

echo; echo "== Summary"; printf '%s\n' "${summary[@]}"
echo; echo "Captures: $caps   Trial log: $log"
