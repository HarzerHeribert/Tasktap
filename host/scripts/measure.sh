#!/bin/bash
# host/scripts/measure.sh [runs]: the cost of Tasktap Next, measured as the rebuild plan measured
# 1.2's baseline: the workspace open on one idle shell terminal, the notch collapsed. Per run:
# launch to the window on screen; top over 60 s (processor use, idle wakeups, context switches)
# and physical footprint for the host, its WebKit processes and its core. In the first run, after
# the idle measure: typing delay (30 keys) and a 1.3 MB burst in that terminal. Launches the built
# app on a temporary data folder, passive (it never takes the keyboard) and driven by its debug
# channel, then quits it and its core. Then, as 1.2 was measured, launch to window again after
# that full quit, on the same data folder.
#
# MOTION=1 host/scripts/measure.sh measures the light instead, in one short launch: the whole app idle with the
# workspace on Home and the notch collapsed; then, in a state held through the debug channel once its moment is over,
# Home's light breathing (the pools: opacity and transform on the compositor), the sidebar's glyphs turning (10 a
# second) beside it, and both beside a workspace's terminal; each over 10 s. The system's window compositor
# (WindowServer) is reported beside the app, since breathing is its work.
set -u
host="$(cd "$(dirname "$0")/.." && pwd)"
exe="$host/target/release/bundle/macos/Tasktap Next.app/Contents/MacOS/tasktap-next"
[ -x "$exe" ] || { echo "Build the app first: host/scripts/build.sh"; exit 1; }
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
  if [ -n "${MOTION:-}" ]; then
    # Processor use and idle wakeups of the whole app over $1 seconds, as one line.
    phase() {
      local core pages pids ws; core=$(pgrep -f "$tmp/data/bin/" | head -1); pages=$(comm -13 <(echo "$before") <(webkit) | tr '\n' ' ')
      pids="$app $core $pages"; ws=$(pgrep -x WindowServer | head -1)
      top -c d -l 2 -s "$1" -stats pid,cpu,idlew $(for p in $pids $ws; do printf -- '-pid %s ' "$p"; done) > "$tmp/top" 2>/dev/null
      awk -v n="$(echo $pids | wc -w)" -v ws="$ws" 'NR > 1 && /^[0-9]+ / { p[++i] = $1; c[i] = $2; w[i] = $3 } END { m = n + 1; for (k = i - m + 1; k <= i; k++) { if (p[k] == ws) { s = c[k]; continue } cpu += c[k]; wake += w[k] } printf "%5.1f%% cpu  %5d wakeups/s   WindowServer %5.1f%%\n", cpu, wake, s }' "$tmp/top"
    }
    sleep 15
    printf '%-52s %s\n' "idle: Home shown, notch collapsed" "$(phase 20)"
    for run in "home working 1 calm" "home working 1 breathe" "home needs 1 calm" "terminal working 1 breathe" "terminal working 0 calm"; do
      set -- $run
      [ "$1" = terminal ] && ask "(__ws.command('open-workspace'), 1)" >/dev/null && echo "click workspace .sheet .act.primary" >&3 && sleep 3
      ask "(__motion.debug.state='$2', __motion.debug.breathe=$3===1, __motion.debug.pace='$4', __motion.redraw(), 1)" >/dev/null
      sleep 8
      printf '%-52s %s\n' "$1, $2, breathing $3, glyphs $4" "$(phase 10)"
    done
    echo quit >&3
    sleep 1
    kill "$app" 2>/dev/null
    pkill -f "$tmp/data/bin/" 2>/dev/null
    exec 3>&-
    rm -rf "$tmp"
    break
  fi
  ask "(__ws.command('open-workspace'), 1)" >/dev/null
  sleep 0.5
  echo "click workspace .sheet .act.primary" >&3
  for _ in $(seq 1 100); do case "$(ask "__ws.text()")" in *project*) break ;; esac; sleep 0.2; done
  sleep 20
  core=$(pgrep -f "$tmp/data/bin/" | head -1)
  pages=$(comm -13 <(echo "$before") <(webkit) | tr '\n' ' ')
  pids="$app $core $pages"
  top -c d -l 2 -s 60 -stats pid,cpu,idlew,csw $(for p in $pids; do printf -- '-pid %s ' "$p"; done) > "$tmp/top" 2>/dev/null
  echo "== run $run: launch to window $window ms"
  printf '%-34s %8s %8s %8s %10s\n' process cpu% idlew csw footprint
  total=0 cpus=0 wakes=0
  for p in $pids; do
    name=$(basename "$(ps -o comm= -p "$p")")
    read -r cpu idlew csw < <(awk -v p="$p" '$1 == p { r = $2 " " $3 " " $4 } END { print r }' "$tmp/top")
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
