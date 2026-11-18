#!/bin/bash
# host/scripts/measure.sh [runs]: the cost of Tasktap Next, measured as the rebuild plan measured
# 1.2's baseline: the workspace open on one idle shell terminal, the notch collapsed. Per run:
# launch to the window on screen; top over 60 s (processor use, context switches; wakeups a second)
# and physical footprint for the host, its WebKit processes and its core. In the first run, after
# the idle measure: typing delay (30 keys) and a 1.3 MB burst in that terminal. Launches the built
# app on a temporary data folder, passive (it never takes the keyboard) and driven by its debug
# channel, then quits it and its core. Then, as 1.2 was measured, launch to window again after
# that full quit, on the same data folder.
#
# MOTION=1 host/scripts/measure.sh measures the effects instead (scripts/cost-check.cjs): the whole app at rest behind
# other windows and in front (nothing may move, and it must cost nothing), then, held through the debug channel as it
# is in the window in use, agents working on Home (the loop, over a minute), a question waiting, the same behind other
# windows, at Still and at Off, and beside a terminal (the sidebar's glyphs alone, over a minute); then the app's
# memory started at each level of the effects, and that Off makes no canvas and no WebGL context.
# FLOW=1 host/scripts/measure.sh times the capture flow (scripts/flow-check.cjs --app): frames and keys while a
# thought is typed, sent, placed, worked on and answered, at each level of the effects, with the fixture agent.
# CADENCE=1 host/scripts/measure.sh records the band frame by frame (scripts/cadence-check.cjs --app).
# Each says which display its window is on and that display's refresh rate, and refuses a sleeping, locked or
# covered screen; DISPLAY_HZ=144 puts the window on the display of that rate.
set -u
host="$(cd "$(dirname "$0")/.." && pwd)"
exe="$host/target/release/bundle/macos/Tasktap Next.app/Contents/MacOS/tasktap-next"
[ -x "$exe" ] || { echo "Build the app first: host/scripts/build.sh"; exit 1; }
root="$(cd "$host/.." && pwd)"
on=${DISPLAY_HZ:+--display $DISPLAY_HZ}
[ -n "${MOTION:-}" ] && exec node "$root/scripts/cost-check.cjs" $on
[ -n "${FLOW:-}" ] && exec node "$root/scripts/flow-check.cjs" --app $on
[ -n "${CADENCE:-}" ] && exec node "$root/scripts/cadence-check.cjs" --app $on
webkit() { pgrep -f 'com.apple.WebKit' | sort; }
for run in $(seq 1 "${1:-3}"); do
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/project"
  mkfifo "$tmp/in"
  before="$(webkit)"
  TASKTAP_DEBUG=1 TASKTAP_PASSIVE=1 TASKTAP_DATA="$tmp/data" TASKTAP_PICK="$tmp/project" "$exe" < "$tmp/in" > "$tmp/log" 2>&1 &
  app=$!
  exec 3>"$tmp/in"
  # The value of a page expression in the workspace, awaited.
  ask() {
    local n; n=$(grep -c '"event":"report","label":"workspace"' "$tmp/log")
    echo "eval workspace $1" >&3
    for _ in $(seq 1 1200); do
      [ "$(grep -c '"event":"report","label":"workspace"' "$tmp/log")" -gt "$n" ] && {
        grep '"event":"report","label":"workspace"' "$tmp/log" | tail -1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"])'
        return
      }
      sleep 0.1
    done
  }
  for _ in $(seq 1 100); do grep -q '"event":"window"' "$tmp/log" && break; sleep 0.1; done
  window=$(grep '"event":"window"' "$tmp/log" | sed 's/.*"ms":\([0-9]*\).*/\1/')
  sleep 1
  ask "(__ws.command('open-workspace'), 1)" >/dev/null
  sleep 0.5
  echo "click workspace .sheet .sh-f .key" >&3
  for _ in $(seq 1 100); do case "$(ask "__ws.text()")" in *project*) break ;; esac; sleep 0.2; done
  sleep 20
  core=$(pgrep -f "$tmp/data/bin/" | head -1)
  pages=$(comm -13 <(echo "$before") <(webkit) | tr '\n' ' ')
  pids="$app $core $pages"
  # Wakeups from the system's own count for each process, read at both ends (top's own column reads 0 between two samples).
  swift "$root/scripts/usage.swift" $pids > "$tmp/used0" 2>/dev/null
  top -c d -l 2 -s 60 -stats pid,cpu,idlew,csw $(for p in $pids; do printf -- '-pid %s ' "$p"; done) > "$tmp/top" 2>/dev/null
  swift "$root/scripts/usage.swift" $pids > "$tmp/used1" 2>/dev/null
  echo "== run $run: launch to window $window ms"
  printf '%-34s %8s %8s %8s %10s\n' process cpu% idlew csw footprint
  total=0 cpus=0 wakes=0
  for p in $pids; do
    name=$(basename "$(ps -o comm= -p "$p")")
    read -r cpu idlew csw < <(awk -v p="$p" '$1 == p { r = $2 " " $3 " " $4 } END { print r }' "$tmp/top")
    idlew=$(python3 -c 'import json,sys; a,b=(json.load(open(f)) for f in sys.argv[1:3]); p=sys.argv[3]; print(round((b.get(p,{}).get("wakeups",0)-a.get(p,{}).get("wakeups",0))/60))' "$tmp/used0" "$tmp/used1" "$p" 2>/dev/null)
    fp=$(footprint "$p" 2>/dev/null | awk '/phys_footprint:/ { print ($3 == "KB" ? $2 / 1024 : $3 == "GB" ? $2 * 1024 : $2); exit }')
    total=$(echo "$total + ${fp:-0}" | bc)
    cpus=$(echo "$cpus + ${cpu:-0}" | bc)
    w=${idlew//[^0-9]/}
    wakes=$((wakes + ${w:-0}))
    printf '%-34s %8s %8s %8s %8.1f MB\n' "$name" "$cpu" "${idlew//[^0-9]/}" "${csw//[^0-9]/}" "${fp:-0}"
  done
  printf '%-34s %8s %8s %8s %8.1f MB\n' "all" "$cpus" "$wakes" "" "$total"
  if [ "$run" = 1 ]; then
    echo "typing delay, 30 keys: $(ask "JSON.stringify(await __ws.echo(__ws.current().id, 30))")"
    echo "1.3 MB burst: $(ask "JSON.stringify(await __ws.burst(__ws.current().id, 1300000))")"
    echo "10 MB burst:  $(ask "JSON.stringify(await __ws.burst(__ws.current().id, 10000000))")"
  fi
  echo quit >&3
  sleep 1
  kill "$app" 2>/dev/null
  pkill -f "$tmp/data/bin/" 2>/dev/null
  exec 3>&-
  sleep 2
  TASKTAP_PASSIVE=1 TASKTAP_DATA="$tmp/data" "$exe" > "$tmp/log2" 2>&1 &
  app=$!
  for _ in $(seq 1 100); do grep -q '"event":"window"' "$tmp/log2" && break; sleep 0.1; done
  echo "launch to window after a full quit: $(grep '"event":"window"' "$tmp/log2" | sed 's/.*"ms":\([0-9]*\).*/\1/') ms"
  sleep 1
  kill "$app" 2>/dev/null
  wait "$app" 2>/dev/null
  pkill -f "$tmp/data/bin/" 2>/dev/null
  rm -rf "$tmp"
done
