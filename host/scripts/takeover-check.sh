#!/bin/bash
# host/scripts/takeover-check.sh: the first start after the rename, on a fixture. Makes a "Tasktap Next" data folder
# by running the app on it (its database, its scratch project, its copy of the core) and gives it a copy of a project
# (a git worktree) as a run would have; then, while that folder's core still runs, the app must refuse to take it over
# and make nothing; then, on a copy of the folder once its core has ended, the app must move it whole to "Tasktap",
# with the records naming the new place and git finding the copy there. Passive and on temporary folders only, with
# TASKTAP_TAKEOVER_FROM naming the fixture: a person's own folders are never involved. (The fixture itself is moved, not
# a copy of it: a copy's records would name the folder it was copied from.) PASS or FAIL lines.
# Needs the host built for debugging (cargo build in host/) and the core (build-core.sh).
set -u
host="$(cd "$(dirname "$0")/.." && pwd)"
exe="$host/target/debug/tasktap-app"
triple="$(rustc -vV | sed -n 's/^host: //p')"
core="$host/binaries/tasktap-$triple"
[ -x "$exe" ] && [ -x "$core" ] || { echo "Build first: (cd host && cargo build) and host/scripts/build-core.sh"; exit 1; }
# Short: a data folder's socket path must fit in 104 bytes.
tmp="$(mktemp -d -t tt)"
fails=0
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; fails=$((fails + 1)); }
cleanup() {
  # Only what this check started, by its own folder.
  pkill -f "$tmp/" 2>/dev/null
  sleep 1
  pkill -9 -f "$tmp/" 2>/dev/null
  if [ "$fails" = 0 ]; then rm -rf "$tmp"; else echo "Kept for a look: $tmp"; fi
}
trap cleanup EXIT

# Runs the app passive on data folder $1 taking over $2 (or nothing), sends it $3 seconds later `quit`; its log in $4.
run() {
  ( sleep "$3"; echo quit; sleep 2 ) | env TASKTAP_DEBUG=1 TASKTAP_PASSIVE=1 TASKTAP_DATA="$1" ${2:+TASKTAP_TAKEOVER_FROM="$2"} \
    TASKTAP_CORE_EXE="$core" TASKTAP_CORE_BUILD="$(cat "$host/binaries/build.txt")" "$exe" > "$4" 2>&1
}
# Whether a core runs in folder $1.
running() { pgrep -f "serve --data $1 " >/dev/null || pgrep -f "serve --data $1\$" >/dev/null; }
sql() { sqlite3 "$1/core.db" "$2"; }

old="$tmp/fixture/Tasktap Next"
run "$old" "" 4 "$tmp/make.log"
[ -f "$old/core.db" ] && grep -q '"event":"ready"' "$tmp/make.log" && pass "a Tasktap Next folder is made by running the app on it" || fail "the fixture was not made: $(tail -3 "$tmp/make.log")"
repo="$tmp/project"
mkdir -p "$repo"
git -C "$repo" init -q -b main && echo a > "$repo/a.txt" && git -C "$repo" add a.txt && git -C "$repo" -c user.name=t -c user.email=t@t commit -q -m a
name=0123456789abcdef
git -C "$repo" worktree add -q -b "tasktap/$name" "$old/worktrees/$name"
[ -f "$old/worktrees/$name/.git" ] && pass "the folder holds a copy of a project" || fail "no worktree in the fixture"

# The folder's core runs on for a while after the app quit: nothing may move now.
if running "$old"; then
  run "$tmp/fixture/Tasktap" "$old" 3 "$tmp/refused.log"
  if grep -q '"event":"takeover","stopped":"Tasktap Next'"'"'s sessions are still running"' "$tmp/refused.log" && [ ! -e "$tmp/fixture/Tasktap" ] && [ -f "$old/core.db" ] && ! grep -q '"event":"ready"' "$tmp/refused.log"; then
    pass "while Tasktap Next's core runs, the app says so, does not start and changes nothing"
  else
    fail "while its core runs: $(grep -o '"event":"[a-z]*"[^}]*' "$tmp/refused.log" | head -3)"
  fi
else
  fail "the fixture's core was not running to test the refusal"
fi
# Then it idles out (a minute after its last client).
for _ in $(seq 1 90); do running "$old" || break; sleep 1; done
running "$old" && fail "the fixture's core did not end" || pass "the fixture's core ended by itself"

# Now as at the first start of Tasktap.
home="$tmp/fixture"
run "$home/Tasktap" "$home/Tasktap Next" 4 "$tmp/moved.log"
new="$home/Tasktap"
grep -q '"event":"takeover","moved"' "$tmp/moved.log" && pass "the app says it took over" || fail "no word of a takeover: $(head -c 400 "$tmp/moved.log")"
grep '"event":"ready"' "$tmp/moved.log" | grep -q "\"data\":\"$new\"" && pass "the app started on the new folder" || fail "the app did not start on $new"
[ ! -e "$home/Tasktap Next" ] && [ -f "$new/core.db" ] && [ -f "$new/host-device.json" ] && pass "the folder moved whole" || fail "the folder did not move whole: $(ls "$home")"
[ -f "$new/core.before-move.db" ] && pass "a copy of the database as it was is kept" || fail "no copy of the database"
scratch="$(sql "$new" "SELECT folder FROM projects WHERE data ->> 'kind' = 'scratch'")"
real_new="$(cd "$new" && pwd -P)"
[ "$scratch" = "$real_new/scratch" ] && pass "the records name the new folder (the scratch project: $scratch)" || fail "the scratch project names $scratch"
[ "$(sql "$new" "SELECT count(*) FROM projects WHERE instr(data, 'Tasktap Next') > 0")" = 0 ] && pass "no record names the old folder" || fail "a record still names the old folder"
if git -C "$repo" worktree list --porcelain | grep -q "^worktree $real_new/worktrees/$name\$"; then pass "git finds the copy of the project in its new place"; else fail "git: $(git -C "$repo" worktree list)"; fi
run "$new" "$home/Tasktap Next" 3 "$tmp/again.log"
grep -q '"event":"takeover"' "$tmp/again.log" && fail "a second start took over again" || pass "the next start finds nothing to take over"
grep -q '"event":"ready"' "$tmp/again.log" && pass "and starts as usual" || fail "the next start did not start"
echo "$fails failed"
[ "$fails" = 0 ]
