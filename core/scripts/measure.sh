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
KEYS=500
TERMINALS=10
COMMITS=500

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

# p95: the value 95 % of the lines are at or below.
p95() {
    sort -n | awk '{ a[NR] = $1 } END { i = int(NR * 0.95); if (i < NR * 0.95) i++; if (i < 1) i = 1; print a[i] }'
}

# footprint_of <pid>: bytes, as macOS counts a process's memory, or its RSS elsewhere.
footprint_of() {
    if [ "$os" = Darwin ]; then
        footprint -p "$1" -f bytes 2>/dev/null | sed -n 's/.*Footprint: \([0-9]*\) B.*/\1/p' | head -1
    else
        echo $(($(awk '/^VmRSS:/ { print $2 }' "/proc/$1/status") * 1024))
    fi
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

# A build without the test fixtures has no fixture role, and refuses one as a usage error; the fixtures build runs it.
# (The probe was once the text of a fixture call's name, but whether such a text stays in a binary is the
# optimizer's to decide: it compares short names as numbers.)
code=0
"$BIN" fixture-terminal </dev/null >/dev/null 2>&1 || code=$?
[ "$code" -eq 64 ] || die "the normal release binary does not refuse the fixture role as a usage error (exit $code, not 64)"
"$FBIN" fixture-terminal </dev/null >/dev/null 2>&1 || die "the fixtures binary lacks its fixtures"

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
# The core lists the agents as it starts, by their programs on the PATH and
# with no program of theirs run; that is start-up work too, not part of the window.
wait_for "$tmp/hold1.log" '^detected$' || die "the agents were not listed: $(cat "$tmp/hold1.log")"
sleep 2 # let the start-up work end; it is not part of the window
# And over the socket: the release core refuses a fixture call as one it does not have.
said=$("$EX" fixtures "$tmp/data") || die "the fixture call client failed"
[ "$said" = "refused unknown" ] || die "the normal release core answers a fixture call: $said"

# --- memory, with the same two clients connected and no terminal ----------------

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

# A terminal that writes nothing, a client attached, is part of the idle window.
"$EX" quiet "$tmp/data" >"$tmp/quiet.log" 2>&1 </dev/null &
pids="$pids $!"
wait_for "$tmp/quiet.log" '^open$' || die "the quiet terminal did not open: $(cat "$tmp/quiet.log")"
sleep 1

say "idle window of $WINDOW s; leave the machine alone meanwhile"
# The window counts the core alone: its terminal's threads sleep in the kernel too.
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
said=$("$EX" fixtures "$tmp/fdata") || die "the fixture call client failed"
[ "$said" = "answered" ] || die "the fixtures core refuses a fixture call: $said"
"$EX" stream "$tmp/fdata" "$STREAM_MIB" "$STREAM_RUNS" >"$tmp/stream.out" || die "the stream client failed"
down=$(awk '$1 == "down" { print $2 }' "$tmp/stream.out" | median)
up=$(awk '$1 == "up" { print $2 }' "$tmp/stream.out" | median)
kill $pids 2>/dev/null || true
wait $pids 2>/dev/null || true
pids=""

# --- typing delay through a real terminal -------------------------------------
#
# A key goes in on the stream and its echo comes back on it; the terminal runs
# cat, so the system's terminal echoes it. What the core adds is that round
# trip less the same through a bare pseudo-terminal with no core. Measured
# alone, while another client commits to the store all along, and beside a
# second client attached to the same terminal that reads almost nothing.

say "typing $KEYS keys into a terminal: alone, while the store commits, beside a slow client"
mkdir "$tmp/kdata"
"$BIN" serve --data "$tmp/kdata" >"$tmp/kserve.log" 2>&1 </dev/null &
pids=$!
wait_for "$tmp/kserve.log" '^ready$' || die "the service did not report ready"
for load in none commits slow; do
    "$EX" keys "$tmp/kdata" "$KEYS" "$load" >"$tmp/keys-$load.out" 2>"$tmp/keys-$load.err" ||
        die "the typing client failed ($load): $(cat "$tmp/keys-$load.err")"
done
"$EX" pty "$KEYS" >"$tmp/keys-pty.out" || die "the bare terminal client failed"
commits_during=$(awk '/^load:/ { print $2 }' "$tmp/keys-commits.err")
bare_median=$(median <"$tmp/keys-pty.out")
bare_p95=$(p95 <"$tmp/keys-pty.out")
# typing_row <load> <label>: the row for one way of typing.
typing_row() {
    local m p am ap
    m=$(median <"$tmp/keys-$1.out")
    p=$(p95 <"$tmp/keys-$1.out")
    am=$(awk -v a="$m" -v b="$bare_median" 'BEGIN { printf "%.3f", (a - b) / 1000 }')
    ap=$(awk -v a="$p" -v b="$bare_p95" 'BEGIN { printf "%.3f", (a - b) / 1000 }')
    local ok
    ok=$(awk -v m="$am" -v p="$ap" 'BEGIN { print (m < 0.3 && p < 0.3) ? "PASS" : "FAIL" }')
    echo "Keystroke delay the core adds, $2|median $am ms, p95 $ap ms (echo $m/$p µs, bare terminal $bare_median/$bare_p95 µs)|< 0.3 ms|$ok"
}
kill $pids 2>/dev/null || true
wait $pids 2>/dev/null || true
pids=""

# --- memory per running terminal, its history full ----------------------------
#
# What one more terminal costs: the footprint that $TERMINALS more terminals
# add once $TERMINALS already run. The first ones also pay once for what the
# allocator and the system set up for any terminal, which the row shows too.

say "$TERMINALS terminals with a full history each, then $TERMINALS more"
mkdir "$tmp/mdata"
"$BIN" serve --data "$tmp/mdata" >"$tmp/mserve.log" 2>&1 </dev/null &
core_pid=$!
pids=$core_pid
wait_for "$tmp/mserve.log" '^ready$' || die "the service did not report ready"
"$EX" hold "$tmp/mdata" >"$tmp/mhold.log" 2>&1 </dev/null &
pids="$pids $!"
wait_for "$tmp/mhold.log" '^subscribed$' || die "the holding client did not subscribe"
sleep 1
mem_before=$(footprint_of "$core_pid")
"$EX" terminals "$tmp/mdata" "$TERMINALS" >"$tmp/terminals.out" 2>&1 || die "the terminals client failed: $(cat "$tmp/terminals.out")"
sleep 1
mem_first=$(footprint_of "$core_pid")
"$EX" terminals "$tmp/mdata" "$TERMINALS" >"$tmp/terminals.out" 2>&1 || die "the terminals client failed: $(cat "$tmp/terminals.out")"
sleep 1
mem_after=$(footprint_of "$core_pid")
first_terminal=$(((mem_first - mem_before) / TERMINALS))
per_terminal=$(((mem_after - mem_first) / TERMINALS))
kill $pids 2>/dev/null || true
wait $pids 2>/dev/null || true
pids=""

# --- what a commit costs, for the durability setting of design section 3 -------

if [ "$os" = Darwin ]; then
    say "$COMMITS commits with synchronous=FULL, then as many with F_FULLFSYNC too"
    "$EX" commits "$tmp/commits" "$COMMITS" 0 >"$tmp/commits-full.out" || die "the commit client failed"
    "$EX" commits "$tmp/commits" "$COMMITS" 1 >"$tmp/commits-fullfsync.out" || die "the commit client failed"
    full_median=$(median <"$tmp/commits-full.out")
    full_p95=$(p95 <"$tmp/commits-full.out")
    ffs_median=$(median <"$tmp/commits-fullfsync.out")
    ffs_p95=$(p95 <"$tmp/commits-fullfsync.out")
    ms() { awk -v u="$1" 'BEGIN { printf "%.3f", u / 1000 }'; }
    # Section 3 keeps F_FULLFSYNC off because it costs far more than a key may
    # wait; should it ever cost less than that, the choice is to be made again.
    cost=$(awk -v a="$ffs_median" -v b="$full_median" 'BEGIN { print (a - b) / 1000 }')
    durability=$(awk -v c="$cost" 'BEGIN { print (c >= 0.3) ? "PASS" : "FAIL" }')
    durability_row="Commit: synchronous=FULL, F_FULLFSYNC off (section 3)|median $(ms "$full_median") ms, p95 $(ms "$full_p95") ms; with F_FULLFSYNC median $(ms "$ffs_median") ms, p95 $(ms "$ffs_p95") ms|F_FULLFSYNC costs >= 0.3 ms|$durability"
fi

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

# F_FULLFSYNC exists on macOS only, so only there is there anything to choose.
durability_row=${durability_row:-"Commit: durability setting (section 3)|nothing to choose: F_FULLFSYNC is a macOS call|-|PASS"}

rows=$(
    cat <<EOF
Idle wakeups, $WINDOW s, 2 clients subscribed, a quiet terminal open|$wake_value|0|$wake
Processor use while idle|$cpu %|0.0 %|$cpu_result
Memory, no terminals ($mem_kind)|$(mb "$mem_bytes") MB|<= 8 MB|$(le "$mem_bytes" 8000000)
Start to accepting connections|median $cold_median ms of $COLD_RUNS (min $cold_min, max $cold_max)|<= 30 ms|$(le "$cold_median" 30)
Stream rate, core to client|median $down MB/s of $STREAM_RUNS ($STREAM_MIB MiB)|>= 200 MB/s|$(ge "$down" 200)
Stream rate, client to core|median $up MB/s of $STREAM_RUNS ($STREAM_MIB MiB)|>= 200 MB/s|$(ge "$up" 200)
$(typing_row none "alone, $KEYS keys")
$(typing_row commits "while the store commits ($commits_during commits)")
$(typing_row slow "beside a client that reads 80 bytes/s")
Memory per running terminal, full history|$(awk -v b="$per_terminal" 'BEGIN { printf "%.2f", b / 1048576 }') MiB each for $TERMINALS more ($(awk -v b="$first_terminal" 'BEGIN { printf "%.2f", b / 1048576 }') each for the first $TERMINALS)|<= 2.2 MiB|$(le "$per_terminal" 2306867)
$durability_row
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
