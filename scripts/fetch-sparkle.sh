#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/build/sparkle"
archive="$root/build/Sparkle-2.10.1.tar.xz"
mkdir -p "$dest"
if [ ! -f "$archive" ]; then
  curl --fail --location --proto '=https' --tlsv1.2 https://github.com/sparkle-project/Sparkle/releases/download/2.10.1/Sparkle-2.10.1.tar.xz -o "$archive"
fi
printf '%s  %s\n' 1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27 "$archive" | shasum -a 256 -c -
tar -xf "$archive" -C "$dest"
