#!/bin/bash
# Builds "Tasktap Review.app": the app build.sh makes, under another name and identity, to try beside Tasktap Next
# while it runs. The same pages, core and speech helper; the host built with its `review` feature (src/main.rs, REVIEW:
# its data, core and socket in ~/Library/Application Support/Tasktap Review, no notch, no global keys until one is
# recorded in its Settings) and with tauri.review.conf.json over tauri.conf.json (its name and bundle identifier), in a
# target folder of its own, so that build.sh's app and what it is built from are left as they are. With --open it then
# launches it. The app lives in host/target/review/release/bundle/macos/.
set -euo pipefail
host="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$host/.." && pwd)"
cd "$root/ui"
[ -d node_modules ] || npm ci --no-audit --no-fund
npm run --silent build
# The core keeps its keys under a service of its own, never the real app's.
TASKTAP_KEY_SERVICE="Tasktap Review" "$host/scripts/build-core.sh"
"$host/scripts/build-speech.sh"
cd "$host"
CARGO_TARGET_DIR="$host/target/review" "$root/ui/node_modules/.bin/tauri" build --bundles app \
  --config tauri.review.conf.json --features review
app="$host/target/review/release/bundle/macos/Tasktap Review.app"
echo "Built $app"
if [ "${1:-}" = --open ]; then open "$app"; fi
