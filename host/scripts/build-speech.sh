#!/bin/bash
# Builds the speech helper the Mac app bundles: host/binaries/tasktap-speech-<target>, from host/speech/engine.cpp and
# whisper.cpp (MIT), whose source is fetched once at a pinned version, checked against its SHA-256 and built as static
# libraries with Metal into host/target/speech/. Needs cmake; where there is none, a copy of it is put into
# host/target/speech/ with pip (the cmake project's own wheels), and nothing is installed on the system.
set -euo pipefail
host="$(cd "$(dirname "$0")/.." && pwd)"
version=1.9.5
sum=ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720
triple="$(rustc -vV | sed -n 's/^host: //p')"
out="$host/binaries/tasktap-speech-$triple"
work="$host/target/speech"
src="$work/whisper.cpp-$version"
# Nothing to do when the helper is newer than what it is made from.
if [ -x "$out" ] && [ "$out" -nt "$host/speech/engine.cpp" ] && [ "$out" -nt "$0" ]; then echo "speech helper up to date"; exit 0; fi
mkdir -p "$work" "$host/binaries"
if [ ! -d "$src" ]; then
  curl -q -fsSL -o "$work/whisper.tar.gz" "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v$version.tar.gz"
  [ "$(shasum -a 256 "$work/whisper.tar.gz" | cut -d' ' -f1)" = "$sum" ] || { echo "whisper.cpp $version: the checksum does not match" >&2; exit 1; }
  tar -xzf "$work/whisper.tar.gz" -C "$work"
  rm "$work/whisper.tar.gz"
fi
cmake="$(command -v cmake || true)"
if [ -z "$cmake" ]; then
  [ -x "$work/cmake/bin/cmake" ] || { python3 -m venv "$work/cmake" && "$work/cmake/bin/pip" install --quiet cmake; }
  cmake="$work/cmake/bin/cmake"
fi
if [ ! -f "$work/build/src/libwhisper.a" ]; then
  "$cmake" -S "$src" -B "$work/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
    -DWHISPER_BUILD_EXAMPLES=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 >/dev/null
  "$cmake" --build "$work/build" --target whisper -j "$(sysctl -n hw.ncpu)" >/dev/null
fi
libs="$(find "$work/build" -name '*.a' | tr '\n' ' ')"
# Never written onto the old file: macOS kills a program whose signed file changed in place.
rm -f "$out"
# shellcheck disable=SC2086
c++ -std=c++17 -O2 -mmacosx-version-min=13.0 -I "$src/include" -I "$src/ggml/include" "$host/speech/engine.cpp" $libs \
  -framework Accelerate -framework Metal -framework MetalKit -framework Foundation -o "$out"
strip "$out"
echo "speech helper $(basename "$out"), whisper.cpp $version, $(($(stat -f %z "$out") / 1024)) KB"
