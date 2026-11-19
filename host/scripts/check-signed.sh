#!/bin/bash
# Checks that a Tasktap.app is sealed as sign-mac.sh seals it. Lists every program in the bundle (every Mach-O file and
# every file marked executable) and fails if one is unsigned, lacks the hardened runtime, carries entitlements other
# than its own, or is one this script does not know (a new program needs its entitlements decided in sign-mac.sh and
# here); then verifies the whole bundle as Gatekeeper does, deeply and strictly.
#   host/scripts/check-signed.sh <app> [--developer-id] [--notarised]
# --developer-id: each program is also signed by a Developer ID with a secure timestamp, all by one team.
# --notarised: the app's notarisation ticket is stapled and Gatekeeper accepts it as notarised.
# Reads only; asks no keychain.
set -uo pipefail
app="${1:?usage: check-signed.sh <app> [--developer-id] [--notarised]}"
shift
developer=0 notarised=0
for arg in "$@"; do
  case "$arg" in
    --developer-id) developer=1 ;;
    --notarised) notarised=1 ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done
failed=0
fail() { echo "FAIL $*"; failed=1; }
pass() { echo "PASS $*"; }
plist="$app/Contents/Info.plist"
main="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist" 2>/dev/null)" || { echo "FAIL $app has no Info.plist"; exit 1; }
# What each program must carry, by its name in Contents/MacOS: the app's own (host/entitlements/app.plist), none for
# the core and the speech helper.
expected() {
  case "$1" in
    "Contents/MacOS/$main") echo "com.apple.security.automation.apple-events com.apple.security.device.audio-input" ;;
    Contents/MacOS/tasktap | Contents/MacOS/tasktap-speech) echo "" ;;
    *) echo "unknown" ;;
  esac
}
teams=""
count=0
while IFS= read -r -d '' file; do
  rel="${file#"$app"/}"
  if ! file -b "$file" | grep -q 'Mach-O' && [ ! -x "$file" ]; then continue; fi
  count=$((count + 1))
  want="$(expected "$rel")"
  if [ "$want" = unknown ]; then fail "$rel is a program this check does not know: give it its entitlements in sign-mac.sh and here"; continue; fi
  if ! codesign --verify --strict "$file" 2>/dev/null; then fail "$rel is not signed, or its signature is broken"; continue; fi
  info="$(codesign -d --verbose=4 "$file" 2>&1)"
  if ! grep -q '^CodeDirectory.*flags=.*runtime' <<<"$info"; then fail "$rel lacks the hardened runtime ($(grep -o 'flags=[^ ]*' <<<"$info" | head -1))"; continue; fi
  if grep -q 'linker-signed' <<<"$info"; then fail "$rel carries only the linker's signature"; continue; fi
  got="$(codesign -d --entitlements - --xml "$file" 2>/dev/null | grep -o '<key>[^<]*</key>' | sed 's/<[^>]*>//g' | sort | tr '\n' ' ' | sed 's/ $//')"
  if [ "$got" != "$want" ]; then fail "$rel has the entitlements [${got}], not [${want}]"; continue; fi
  if [ "$developer" = 1 ]; then
    grep -q '^Authority=Developer ID Application: ' <<<"$info" || { fail "$rel is not signed by a Developer ID"; continue; }
    grep -q '^Timestamp=' <<<"$info" || { fail "$rel has no secure timestamp"; continue; }
    teams="$teams $(sed -n 's/^TeamIdentifier=//p' <<<"$info")"
  fi
  pass "$rel signed, hardened, entitlements [${want:-none}]"
done < <(find "$app" -type f -print0)
[ "$count" -ge 3 ] || fail "only $count programs found in $app; the app, the core and the speech helper are expected"
if [ "$developer" = 1 ] && [ "$(tr ' ' '\n' <<<"$teams" | sed '/^$/d' | sort -u | wc -l | tr -d ' ')" != 1 ]; then
  fail "the programs are signed by more than one team:$teams"
fi
# The team the release is meant to be signed by (the workflow's APPLE_TEAM_ID), when it is given.
if [ "$developer" = 1 ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ "$(tr ' ' '\n' <<<"$teams" | sed '/^$/d' | sort -u)" != "$APPLE_TEAM_ID" ]; then
  fail "the programs are not signed by the team APPLE_TEAM_ID names"
fi
for key in NSMicrophoneUsageDescription NSAppleEventsUsageDescription; do
  /usr/libexec/PlistBuddy -c "Print :$key" "$plist" >/dev/null 2>&1 || fail "Info.plist does not say why the app asks ($key)"
done
if codesign --verify --deep --strict --verbose=2 "$app" 2>/dev/null; then pass "the bundle verifies deeply and strictly"; else fail "the bundle does not verify: $(codesign --verify --deep --strict "$app" 2>&1 | tail -2)"; fi
if [ "$notarised" = 1 ]; then
  if xcrun stapler validate "$app" >/dev/null 2>&1; then pass "the notarisation ticket is stapled"; else fail "no notarisation ticket is stapled to the app"; fi
  verdict="$(spctl --assess --type execute --verbose=2 "$app" 2>&1)"
  if grep -q 'source=Notarized Developer ID' <<<"$verdict"; then pass "Gatekeeper accepts it as notarised"; else fail "Gatekeeper says: $verdict"; fi
fi
[ "$failed" = 0 ] && echo "all $count programs sealed" || exit 1
