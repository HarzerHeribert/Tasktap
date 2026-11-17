#!/bin/bash
# host/scripts/measure.sh [runs]: idle cost of Tasktap Next with the notch collapsed, measured as
# the rebuild plan's 1.2 baseline was: top over 60 s (processor use, idle wakeups, context
# switches) and physical footprint, for the host, its WebKit processes and its core. Launches the
# built app on a temporary data folder, passive (it never takes the keyboard), and quits it.
set -u
host="$(cd "$(dirname "$0")/.." && pwd)"
exe="$host/target/release/bundle/macos/Tasktap Next.app/Contents/MacOS/tasktap-next"
[ -x "$exe" ] || { echo "Build the app first: host/scripts/build.sh"; exit 1; }
webkit() { pgrep -f 'com.apple.WebKit' | sort; }
for run in $(seq 1 "${1:-3}"); do
  tmp="$(mktemp -d)"
  before="$(webkit)"
  TASKTAP_PASSIVE=1 TASKTAP_DATA="$tmp/data" "$exe" > "$tmp/log" 2>&1 &
  app=$!
  sleep 20
  core=$(pgrep -f "$tmp/data/bin/" | head -1)
  pages=$(comm -13 <(echo "$before") <(webkit) | tr '\n' ' ')
  pids="$app $core $pages"
  top -c d -l 2 -s 60 -stats pid,cpu,idlew,csw $(for p in $pids; do printf -- '-pid %s ' "$p"; done) > "$tmp/top" 2>/dev/null
  echo "== run $run"
  printf '%-34s %8s %8s %8s %10s\n' process cpu% idlew csw footprint
  total=0
  for p in $pids; do
    name=$(basename "$(ps -o comm= -p "$p")")
    read -r cpu idlew csw < <(awk -v p="$p" '$1 == p { r = $2 " " $3 " " $4 } END { print r }' "$tmp/top")
    fp=$(footprint "$p" 2>/dev/null | awk '/phys_footprint:/ { print ($3 == "KB" ? $2 / 1024 : $3 == "GB" ? $2 * 1024 : $2); exit }')
    total=$(echo "$total + ${fp:-0}" | bc)
    printf '%-34s %8s %8s %8s %8.1f MB\n' "$name" "$cpu" "${idlew//[^0-9]/}" "${csw//[^0-9]/}" "${fp:-0}"
  done
  printf '%-34s %35.1f MB\n' "all" "$total"
  kill "$app"; sleep 1; kill "$core" 2>/dev/null; rm -rf "$tmp"
done
