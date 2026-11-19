#!/bin/bash
# Builds the app: the pages, the core and the speech helper it bundles, and the host. With --open it then launches it.
# The app lives in host/target/release/bundle/macos/. TASKTAP_VERSION=2.0.1 builds it as that version (the release
# workflow takes it from the tag); otherwise it is tauri.conf.json's. Nothing is signed here beyond the linker's
# ad-hoc signature: sealing is sign-mac.sh's (release-mac.sh's in a release).
set -euo pipefail
host="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$host/.." && pwd)"
cd "$root/ui"
[ -d node_modules ] || npm ci --no-audit --no-fund
npm run --silent build
"$host/scripts/build-core.sh"
"$host/scripts/build-speech.sh"
cd "$host"
config=()
if [ -n "${TASKTAP_VERSION:-}" ]; then config=(--config "{\"version\":\"$TASKTAP_VERSION\"}"); fi
"$root/ui/node_modules/.bin/tauri" build --bundles app --no-sign ${config[@]+"${config[@]}"}
app="$host/target/release/bundle/macos/$(node -p "require('$host/tauri.conf.json').productName").app"
echo "Built $app"
if [ "${1:-}" = --open ]; then open "$app"; fi
