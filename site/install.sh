#!/bin/bash
# Download this file, inspect it, then run: bash install.sh VERSION
set -euo pipefail
install_tasktap() {
  local source="$1" install_dir="$2" backups="$3" staged dest archive_dir
  dest="$install_dir/Tasktap.app"
  mkdir -p "$install_dir" "$backups"
  staged="$(mktemp -d "$install_dir/.tasktap-install.XXXXXX")" || return 1
  if ! ditto "$source" "$staged/new.app"; then rm -rf "$staged"; return 1; fi
  if [ -e "$dest" ]; then
    archive_dir="$(mktemp -d "$backups/Tasktap-backup.XXXXXX")" || { rm -rf "$staged"; return 1; }
    if ! ditto -c -k --sequesterRsrc --keepParent "$dest" "$archive_dir/Tasktap.zip" || ! /usr/bin/unzip -tq "$archive_dir/Tasktap.zip" >/dev/null; then
      rm -rf "$staged"; return 1
    fi
    if ! mv "$dest" "$staged/previous.app"; then rm -rf "$staged"; return 1; fi
  fi
  if ! mv "$staged/new.app" "$dest"; then
    if [ -e "$staged/previous.app" ]; then
      mv "$staged/previous.app" "$dest" || { echo "Restore the previous app from $staged/previous.app"; return 1; }
    fi
    rm -rf "$staged"; return 1
  fi
  rm -rf "$staged"
}
# Sourcing exposes the installation transaction for isolated filesystem tests.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then return 0; fi
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
if [ -d /Applications/Tasktap.app ] && [ -d "$HOME/Applications/Tasktap.app" ]; then
  echo 'Two Tasktap installations already exist. Keep one in Applications before updating.'; exit 1
fi
install_dir="$HOME/Applications"
if [ -d /Applications/Tasktap.app ]; then install_dir=/Applications; fi
if [ -d "$install_dir" ] && [ ! -w "$install_dir" ]; then
  echo "Replace Tasktap in $install_dir using Finder; no second copy was installed."; exit 1
fi
dest="$install_dir/Tasktap.app"
install_tasktap "$app" "$install_dir" "$HOME/Library/Application Support/Tasktap/Backups"
printf 'Installed %s. Open it in Finder. If blocked, use Privacy & Security → Open Anyway.\nPython 3 and a signed-in agent CLI are required for agent sessions.\n' "$dest"
