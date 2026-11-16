#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
package="$root/native/SpeechRuntime"
scratch="$root/build/speech-runtime"
swift build --package-path "$package" --scratch-path "$scratch" --disable-sandbox --configuration release --product tasktap-speech
bin="$(swift build --package-path "$package" --scratch-path "$scratch" --disable-sandbox --configuration release --show-bin-path)"
cp "$bin/tasktap-speech" "$root/build/tasktap-speech"
mkdir -p "$root/build/speech-runtime-resources"
for resource in "$bin"/*.bundle; do
  if [ -d "$resource" ]; then ditto "$resource" "$root/build/speech-runtime-resources/$(basename "$resource")"; fi
done
# Keep the dependency's notices beside the redistributed helper.
mkdir -p "$root/build/speech-notices"
for dependency in "$scratch"/checkouts/*; do
  for name in LICENSE LICENSE.md LICENSE.txt; do
    if [ -f "$dependency/$name" ]; then cp -f "$dependency/$name" "$root/build/speech-notices/$(basename "$dependency")-$name"; break; fi
  done
done
