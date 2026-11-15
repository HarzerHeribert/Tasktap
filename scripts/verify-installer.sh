#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
source "$root/site/install.sh"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/source/Contents"
printf old > "$fixture/source/Contents/fixture"
install_tasktap "$fixture/source" "$fixture/apps" "$fixture/backups"
printf new > "$fixture/source/Contents/fixture"
install_tasktap "$fixture/source" "$fixture/apps" "$fixture/backups"
[ "$(cat "$fixture/apps/Tasktap.app/Contents/fixture")" = new ]
[ "$(find "$fixture/apps" -name '*.app' | wc -l | tr -d ' ')" = 1 ]
archive="$(find "$fixture/backups" -name Tasktap.zip)"
[ "$(unzip -p "$archive" Tasktap.app/Contents/fixture)" = old ]
[ ! -e "$fixture/apps/Tasktap.previous.app" ]
printf 'Fresh install and replacement retain one app; the old version is recoverable from ZIP.\n'

# Resolve once via GitHub's stable-release redirect; explicit versions need no network.
curl() { printf '%s' "${TEST_RELEASE_URL}"; }
export TEST_RELEASE_URL='https://github.com/HarzerHeribert/Tasktap/releases/tag/v0.3.2'
[ "$(resolve_version)" = 0.3.2 ]
[ "$(resolve_version latest)" = 0.3.2 ]
[ "$(resolve_version 0.3.1)" = 0.3.1 ]
for TEST_RELEASE_URL in 'https://github.com/HarzerHeribert/Tasktap/releases/latest' 'https://example.com/v0.3.2' 'https://github.com/HarzerHeribert/Tasktap/releases/tag/v0.3.2-beta'; do
  if resolve_version >/dev/null 2>&1; then echo 'Accepted invalid release redirect'; exit 1; fi
done
if resolve_version '../bad' >/dev/null 2>&1; then exit 1; fi
curl() { return 22; }
if resolve_version >/dev/null 2>&1; then echo 'Ignored download failure'; exit 1; fi
[ "$(resolve_version 0.3.1)" = 0.3.1 ]
printf 'Latest stable, explicit versions, invalid redirects and network failures verified.\n'
