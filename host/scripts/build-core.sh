#!/bin/bash
# Builds the core the host bundles: host/binaries/tasktap-<target> and its build name in
# host/binaries/build.txt. FIXTURES=1 builds a second core with the core's test fixtures
# (the fixture agent) into host/binaries/fixtures/ for smoke.sh; the app never bundles it.
set -euo pipefail
host="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$host/.." && pwd)"
triple="$(rustc -vV | sed -n 's/^host: //p')"
build="0.1.0+$(git -C "$root" rev-parse --short HEAD:core 2>/dev/null || echo local)"
mkdir -p "$host/binaries"
if [ "${FIXTURES:-0}" = 1 ]; then
  build="$build.fixtures"
  TASKTAP_BUILD="$build" cargo build --release --quiet --manifest-path "$root/core/Cargo.toml" \
    --features fixtures --target-dir "$host/target/core-fixtures"
  mkdir -p "$host/binaries/fixtures"
  # Never copied onto the old file: macOS kills a program whose signed file changed in place.
  rm -f "$host/binaries/fixtures/tasktap"
  cp "$host/target/core-fixtures/release/tasktap" "$host/binaries/fixtures/tasktap"
  printf '%s' "$build" > "$host/binaries/fixtures/build.txt"
else
  TASKTAP_BUILD="$build" cargo build --release --quiet --manifest-path "$root/core/Cargo.toml" \
    --target-dir "$host/target/core"
  rm -f "$host/binaries/tasktap-$triple"
  cp "$host/target/core/release/tasktap" "$host/binaries/tasktap-$triple"
  printf '%s' "$build" > "$host/binaries/build.txt"
fi
echo "core $build"
