#!/usr/bin/env bash
# Measures the core against the targets of design section 10 and prints each
# number beside its target.
#
#     core/scripts/measure.sh [--markdown]
#
# Builds the normal release binary (what ships) and, apart from it, one with
# the `fixtures` feature that only the stream measurement uses. The clients
# are `core/examples/measure.rs`; this script only starts things, waits and
# prints. Progress goes to stderr, the table to stdout.
#
# Exit status: 1 when idle wakeups are not zero, 0 otherwise. A missed target
# elsewhere is reported as FAIL and does not change the status.
#
# MEASURE_IDLE_SECONDS shortens the idle window for trying the script out; the
# table says so when it is not 60.

set -eu

markdown=0
case "${1:-}" in
    "") ;;
    --markdown) markdown=1 ;;
    *) echo "usage: measure.sh [--markdown]" >&2; exit 2 ;;
esac

os=$(uname -s)
case "$os" in
    Darwin | Linux) ;;
    *)
        echo "measure.sh: $os is not supported (macOS and Linux are); nothing was measured."
        exit 0
        ;;
esac

WINDOW=${MEASURE_IDLE_SECONDS:-60}
COLD_RUNS=25
STREAM_MIB=256
STREAM_RUNS=3

core=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d /tmp/tm.XXXXXX) # short: a socket path has a length limit
pids=""

cleanup() {
    # shellcheck disable=SC2086
    [ -n "$pids" ] && kill $pids 2>/dev/null || true
    rm -rf "$tmp"
}
trap cleanup EXIT

say() { echo "measure: $*" >&2; }
die() { echo "measure: $*" >&2; exit 2; }

# wait_for <file> <text>: up to 10 s, before any measuring starts.
wait_for() {
    local i=0
    while ! grep -q "$2" "$1" 2>/dev/null; do
        i=$((i + 1))
        [ "$i" -gt 200 ] && return 1
        sleep 0.05
    done
}

median() {
    sort -n | awk '{ a[NR] = $1 } END { if (NR % 2) print a[(NR + 1) / 2]; else print (a[NR / 2] + a[NR / 2 + 1]) / 2 }'
}

# --- builds ------------------------------------------------------------------

cd "$core"
say "building the release binary"
cargo build --release --bin tasktap >&2
cp target/release/tasktap "$tmp/tasktap"
say "building the fixtures binary and the clients"
cargo build --release --bin tasktap --features fixtures --target-dir target/fixtures >&2
cargo build --release --example measure >&2
cp target/fixtures/release/tasktap "$tmp/tasktap-fixtures"
BIN=$tmp/tasktap
FBIN=$tmp/tasktap-fixtures
EX=$core/target/release/examples/measure

grep -aq "fixture.stream" "$BIN" && die "the normal release binary contains the test fixtures"
grep -aq "fixture.stream" "$FBIN" || die "the fixtures binary lacks fixture.stream"

size=$(wc -c <"$BIN" | tr -d ' ')

# --- idle: two clients subscribed, nothing else -------------------------------

say "starting the service and two subscribed clients"
mkdir "$tmp/data"
"$BIN" serve --data "$tmp/data" >"$tmp/serve.log" 2>&1 </dev/null &
core_pid=$!
pids="$core_pid"
wait_for "$tmp/serve.log" '^ready$' || die "the service did not report ready"
for n in 1 2; do
    "$EX" hold "$tmp/data" >"$tmp/hold$n.log" 2>&1 </dev/null &
    pids="$pids $!"
    wait_for "$tmp/hold$n.log" '^subscribed$' || die "client $n did not subscribe: $(cat "$tmp/hold$n.log")"
done
sleep 2 # let the start-up work end; it is not part of the window

say "idle window of $WINDOW s; leave the machine alone meanwhile"
idlew=""
if [ "$os" = Darwin ]; then
    # Delta mode: the second sample counts what happened since the first,
    # $WINDOW seconds later. top is a separate process and the service does
    # not notice it.
    top -c d -l 2 -s "$WINDOW" -pid "$core_pid" -stats pid,idlew,csw,cpu >"$tmp/top.out"
    read -r idlew switches cpu < <(awk -v p="$core_pid" '$1 == p { r = $2 " " $3 " " $4 } END { print r }' "$tmp/top.out")
    [ -n "$cpu" ] || die "could not read top's output: $(cat "$tmp/top.out")"
    idlew=${idlew//[^0-9]/}
    switches=${switches//[^0-9]/}
else
    status() { awk '/^(voluntary|nonvoluntary)_ctxt_switches/ { n += $2 } END { print n }' "/proc/$core_pid/status"; }
    ticks() { awk '{ print $14 + $15 }' "/proc/$core_pid/stat"; }
    before_switches=$(status)
    before_ticks=$(ticks)
    sleep "$WINDOW"
    switches=$(($(status) - before_switches))
    cpu=$(awk -v t=$(($(ticks) - before_ticks)) -v hz="$(getconf CLK_TCK)" -v w="$WINDOW" 'BEGIN { printf "%.1f", t / hz / w * 100 }')
fi
kill -0 "$core_pid" 2>/dev/null || die "the service died during the window"

# --- memory, with the same two clients still connected ------------------------

if [ "$os" = Darwin ]; then
    fp=$(footprint -p "$core_pid" 2>/dev/null | sed -n 's/.*Footprint: \([0-9.]*\) \([KMG]*B\).*/\1 \2/p' | head -1)
fi
if [ "$os" = Darwin ] && [ -n "${fp:-}" ]; then
    mem_bytes=$(echo "$fp" | awk '{ u = ($2 == "KB") ? 1024 : ($2 == "MB") ? 1048576 : ($2 == "GB") ? 1073741824 : 1; printf "%d", $1 * u }')
    mem_kind="footprint"
elif [ "$os" = Darwin ]; then
    mem_bytes=$(($(ps -o rss= -p "$core_pid" | tr -d ' ') * 1024))
    mem_kind="RSS; footprint was not available"
else
    mem_bytes=$(($(awk '/^VmRSS:/ { print $2 }' "/proc/$core_pid/status") * 1024))
    mem_kind="RSS"
fi

# Done with the idle service.
# shellcheck disable=SC2086
kill $pids 2>/dev/null || true
# shellcheck disable=SC2086
wait $pids 2>/dev/null || true
pids=""

# --- start to accepting connections -------------------------------------------

say "$COLD_RUNS cold starts"
"$EX" cold "$BIN" "$COLD_RUNS" >"$tmp/cold.out" || die "the cold-start client failed"
cold_median=$(median <"$tmp/cold.out")
cold_min=$(sort -n "$tmp/cold.out" | head -1)
cold_max=$(sort -n "$tmp/cold.out" | tail -1)

# --- stream rate through fixture.stream ---------------------------------------

say "streaming $STREAM_MIB MiB each way, $STREAM_RUNS runs"
mkdir "$tmp/fdata"
"$FBIN" serve --data "$tmp/fdata" --idle-ms 600000 >"$tmp/fserve.log" 2>&1 </dev/null &
pids=$!
wait_for "$tmp/fserve.log" '^ready$' || die "the fixtures service did not report ready"
"$EX" stream "$tmp/fdata" "$STREAM_MIB" "$STREAM_RUNS" >"$tmp/stream.out" || die "the stream client failed"
down=$(awk '$1 == "down" { print $2 }' "$tmp/stream.out" | median)
up=$(awk '$1 == "up" { print $2 }' "$tmp/stream.out" | median)

# --- the table -----------------------------------------------------------------

mb() { awk -v b="$1" 'BEGIN { printf "%.1f", b / 1e6 }'; }
# le <value> <limit> / ge <value> <limit>: PASS or FAIL.
le() { awk -v v="$1" -v l="$2" 'BEGIN { print (v <= l) ? "PASS" : "FAIL" }'; }
ge() { awk -v v="$1" -v l="$2" 'BEGIN { print (v >= l) ? "PASS" : "FAIL" }'; }

if [ "$os" = Darwin ]; then
    wake_value="$idlew idle wakeups, $switches context switches"
    [ "$idlew" = 0 ] && [ "$switches" = 0 ] && wake=PASS || wake=FAIL
else
    wake_value="$switches context switches"
    [ "$switches" = 0 ] && wake=PASS || wake=FAIL
fi
[ "$cpu" = "0.0" ] && cpu_result=PASS || cpu_result=FAIL

rows=$(
    cat <<EOF
Idle wakeups, $WINDOW s, 2 clients subscribed|$wake_value|0|$wake
Processor use while idle|$cpu %|0.0 %|$cpu_result
Memory, no terminals ($mem_kind)|$(mb "$mem_bytes") MB|<= 8 MB|$(le "$mem_bytes" 8000000)
Start to accepting connections|median $cold_median ms of $COLD_RUNS (min $cold_min, max $cold_max)|<= 30 ms|$(le "$cold_median" 30)
Stream rate, core to client|median $down MB/s of $STREAM_RUNS ($STREAM_MIB MiB)|>= 200 MB/s|$(ge "$down" 200)
Stream rate, client to core|median $up MB/s of $STREAM_RUNS ($STREAM_MIB MiB)|>= 200 MB/s|$(ge "$up" 200)
Binary size, release build|$(mb "$size") MB|<= 6 MB|$(le "$size" 6000000)
EOF
)

if [ "$os" = Darwin ]; then
    machine="$(sysctl -n machdep.cpu.brand_string), macOS $(sw_vers -productVersion)"
else
    cpu_name=$(awk -F': ' '/^model name/ { print $2; exit }' /proc/cpuinfo)
    os_name=$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-Linux}" || echo Linux)
    machine="${cpu_name:-$(uname -m)}, $os_name, kernel $(uname -r)"
fi
commit=$(git -C "$core" rev-parse --short HEAD 2>/dev/null || echo unknown)
[ -n "$(git -C "$core" status --porcelain -- . 2>/dev/null)" ] && commit="$commit (with uncommitted changes in core/)"

if [ "$markdown" = 1 ]; then
    echo "| Measure | Measured | Target | Result |"
    echo "| --- | --- | --- | --- |"
    echo "$rows" | awk -F'|' '{ printf "| %s | %s | %s | %s |\n", $1, $2, $3, $4 }'
    echo
    echo "Machine: $machine. Commit: $commit."
else
    {
        echo "Measure|Measured|Target|Result"
        echo "$rows"
    } | awk -F'|' '{ printf "%-44s %-48s %-12s %s\n", $1, $2, $3, $4 }'
    echo
    echo "Machine: $machine. Commit: $commit."
fi

[ "$wake" = PASS ] || exit 1
exit 0
