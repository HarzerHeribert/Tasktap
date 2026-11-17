#!/bin/bash
# Builds "Tasktap Next.app": the pages, the core it bundles, and the host. With --open it then
# launches it. The app lives in host/target/release/bundle/macos/.
set -euo pipefail
host="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$host/.." && pwd)"
cd "$root/ui"
[ -d node_modules ] || npm ci --no-audit --no-fund
npm run --silent build
"$host/scripts/build-core.sh"
cd "$host"
"$root/ui/node_modules/.bin/tauri" build --bundles app
app="$host/target/release/bundle/macos/Tasktap Next.app"
echo "Built $app"
if [ "${1:-}" = --open ]; then open "$app"; fi
