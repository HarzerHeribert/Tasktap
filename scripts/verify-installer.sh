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
