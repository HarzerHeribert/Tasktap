#!/bin/bash
# host/scripts/update-check.sh <updater key file>: the updater end to end on this Mac, with a throwaway key pair and a
# feed served on this machine. Needs the app built as the release workflow builds it, with the throwaway key's public
# half in place of tauri.conf.json's:
#   ui/node_modules/.bin/tauri signer generate --ci -w <scratch>/throwaway.key
#   TASKTAP_UPDATES=1 TASKTAP_UPDATE_KEY="$(cat <scratch>/throwaway.key.pub)" host/scripts/build.sh
#   host/scripts/sign-mac.sh host/target/release/bundle/macos/Tasktap.app
# A copy of that app runs passive on a temporary data folder; a second copy, called 2.0.1 and signed with the key, is
# what the feed offers. Then: a look finds 2.0.1 and the rail says so; nothing is installed until install is asked;
# asked, the download is checked and the copy is replaced in place, and the new version starts. PASS or FAIL lines.
set -u
host="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$host/.." && pwd)"
key="${1:?usage: update-check.sh <updater key file (its password empty)>}"
built="$host/target/release/bundle/macos/Tasktap.app"
[ -d "$built" ] || { echo "Build the app first (see the head of this script)"; exit 1; }
# Its real path: the updater refuses to run from a path that passes through a link (/var is one).
tmp="$(cd "$(mktemp -d -t ttup)" && pwd -P)"
fails=0
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; fails=$((fails + 1)); }
cleanup() {
  trap '' PIPE
  kill "$server" 2>/dev/null
  pkill -f "$tmp/" 2>/dev/null
  sleep 1
  pkill -9 -f "$tmp/" 2>/dev/null
  if [ "$fails" = 0 ]; then rm -rf "$tmp"; else echo "Kept for a look: $tmp"; fi
}
trap cleanup EXIT

mkdir -p "$tmp/apps" "$tmp/new" "$tmp/feed"
ditto "$built" "$tmp/apps/Tasktap.app"
ditto "$built" "$tmp/new/Tasktap.app"
/usr/libexec/PlistBuddy -c 'Set :CFBundleShortVersionString 2.0.1' -c 'Set :CFBundleVersion 2.0.1' "$tmp/new/Tasktap.app/Contents/Info.plist"
"$host/scripts/sign-mac.sh" "$tmp/new/Tasktap.app" > /dev/null
pack="$tmp/feed/Tasktap_2.0.1_aarch64.app.tar.gz"
COPYFILE_DISABLE=1 tar -czf "$pack" -C "$tmp/new" Tasktap.app
TAURI_SIGNING_PRIVATE_KEY="$(tr -d '[:space:]' < "$key")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
  "$root/ui/node_modules/.bin/tauri" signer sign "$pack" > /dev/null 2>&1 || { echo "FAIL the pack could not be signed"; exit 1; }
port=$((20000 + RANDOM % 20000))
python3 - "$pack.sig" "$port" > "$tmp/feed/latest.json" <<'PY'
import json, sys, datetime
sig = open(sys.argv[1]).read().strip()
url = f"http://127.0.0.1:{sys.argv[2]}/Tasktap_2.0.1_aarch64.app.tar.gz"
print(json.dumps({"version": "2.0.1", "notes": "A version made by the check.", "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                  "platforms": {"darwin-aarch64": {"signature": sig, "url": url}}}))
PY
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$tmp/feed" > "$tmp/server.log" 2>&1 &
server=$!

mkfifo "$tmp/in"
log="$tmp/app.log"
TASKTAP_DEBUG=1 TASKTAP_PASSIVE=1 TASKTAP_DATA="$tmp/data" TASKTAP_UPDATE_FEED="http://127.0.0.1:$port/latest.json" \
  "$tmp/apps/Tasktap.app/Contents/MacOS/tasktap-app" < "$tmp/in" >> "$log" 2>&1 &
exec 3>"$tmp/in"
send() { echo "$1" >&3; }
waitfor() { for _ in $(seq 1 "$2"); do grep -q "$1" "$log" && return 0; sleep 0.2; done; return 1; }
reports() { grep -c '"event":"report","label":"workspace"' "$log"; }
# The value of a page expression in the workspace, as its last report says.
ask() {
  local before; before=$(reports)
  send "eval workspace $1"
  for _ in $(seq 1 50); do
    [ "$(reports)" -gt "$before" ] && { grep '"event":"report","label":"workspace"' "$log" | tail -1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"])'; return; }
    sleep 0.2
  done
}
host_update() { ask "window.__TAURI_INTERNALS__.invoke('bridge_host',{frame:JSON.stringify({id:1,name:'host.update',args:$1})})"; }

waitfor '"event":"ready"' 100 && pass "the app started" || fail "the app did not start: $(tail -3 "$log")"
waitfor '"event":"window"' 100
sleep 2
grep -q 'GET /latest.json' "$tmp/server.log" && fail "it looked at start" || pass "nothing was asked of the feed at start"
said="$(host_update '{}')"
case "$said" in *'"state":"unknown"'*) pass "before a look it knows nothing ($said)" ;; *) fail "before a look: $said" ;; esac
host_update '{"look":true}' > /dev/null
for _ in $(seq 1 50); do said="$(host_update '{}')"; case "$said" in *available*|*failed*|*current*) break ;; esac; sleep 0.2; done
case "$said" in *'"state":"available"'*'"version":"2.0.1"'*) pass "a look finds 2.0.1" ;; *) fail "after a look: $said" ;; esac
line="$(ask "document.querySelector('.rail .newer')?.textContent ?? null")"
[ "$line" = "Version 2.0.1 is ready" ] && pass "the rail says so in one line: $line" || fail "the rail says: $line"
sleep 3
grep -q 'GET /Tasktap_2.0.1' "$tmp/server.log" && fail "it downloaded before it was asked" || pass "nothing is downloaded until install is asked"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$tmp/apps/Tasktap.app/Contents/Info.plist")" = 2.0.0 ] && pass "the app is still 2.0.0" || fail "the app changed before it was asked"
host_update '{"install":true}' > /dev/null
# The new version starts in the old one's place and says it is ready a second time.
for _ in $(seq 1 150); do [ "$(grep -c '"event":"ready"' "$log")" -ge 2 ] && break; sleep 0.2; done
grep -q 'GET /Tasktap_2.0.1_aarch64.app.tar.gz' "$tmp/server.log" && pass "asked, it downloaded the pack" || fail "nothing was downloaded"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$tmp/apps/Tasktap.app/Contents/Info.plist")" = 2.0.1 ] && pass "the app in its place is now 2.0.1" || fail "the app was not replaced"
[ "$(grep -c '"event":"ready"' "$log")" -ge 2 ] && pass "the new version started by itself" || fail "the new version did not start: $(tail -3 "$log")"
codesign --verify --deep --strict "$tmp/apps/Tasktap.app" 2>/dev/null && pass "the app in its place verifies" || fail "the app in its place does not verify"
send quit
sleep 2
echo "$fails failed"
[ "$fails" = 0 ]
