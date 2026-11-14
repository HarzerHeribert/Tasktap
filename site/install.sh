#!/bin/bash
# Download this file, inspect it, then run: bash install.sh VERSION
set -euo pipefail
version="${1:?Usage: bash install.sh VERSION (for example 0.3.0)}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid version'; exit 2; }
[ "$(uname -s)" = Darwin ] || { echo 'Tasktap requires macOS.'; exit 1; }
[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 26 ] || { echo 'Tasktap requires macOS 26 or later.'; exit 1; }
arch="$(uname -m)"
[ "$arch" = arm64 ] || { echo 'This community release supports Apple silicon.'; exit 1; }
if pgrep -x Tasktap >/dev/null; then echo 'Quit Tasktap before installing. Terminal agents can keep running.'; exit 1; fi
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
archive="Tasktap-$version-$arch.zip"
base="https://github.com/HarzerHeribert/Tasktap/releases/download/v$version"
curl --fail --location --proto '=https' --tlsv1.2 "$base/$archive" -o "$tmp/$archive"
curl --fail --location --proto '=https' --tlsv1.2 "$base/SHA256SUMS" -o "$tmp/checksums"
(cd "$tmp" && awk -v name="$archive" '$2==name {print}' checksums > selected && test -s selected && shasum -a 256 -c selected)
ditto -x -k "$tmp/$archive" "$tmp/extracted"
app="$tmp/extracted/Tasktap.app"
codesign --verify --deep --strict "$app"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" = io.github.harzerheribert.tasktap ]
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")" = "$version" ]
mkdir -p "$HOME/Applications"
dest="$HOME/Applications/Tasktap.app"
backup="$HOME/Applications/Tasktap.previous.app"
if [ -e "$backup" ]; then echo "Move $backup aside before installing again."; exit 1; fi
if [ -e "$dest" ]; then mv "$dest" "$backup"; fi
if ! ditto "$app" "$dest"; then
  echo 'Installation failed. Your previous app is retained as Tasktap.previous.app.'; exit 1
fi
printf 'Installed %s. Open it in Finder. If blocked, use Privacy & Security → Open Anyway.\nPython 3 and a signed-in agent CLI are required for agent sessions.\n' "$dest"
