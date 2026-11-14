#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
version="${1:?Usage: package-release.sh VERSION BUILD_NUMBER}"
number="${2:?A monotonically increasing build number is required}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$number" =~ ^[0-9]+$ ]] || exit 2
out="$root/build/releases/$version"
mkdir -p "$out"
bash "$root/scripts/build-mac.sh" "$out"
app="$out/Tasktap.app"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $version" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $number" "$app/Contents/Info.plist"
codesign --force --sign - --identifier io.github.harzerheribert.tasktap "$app"
codesign --verify --deep --strict "$app"
archive="Tasktap-$version-$(uname -m).zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$out/$archive"
(cd "$out" && shasum -a 256 "$archive" > SHA256SUMS)
feed="$(mktemp -d "$out/feed.XXXXXX")"
trap 'rm -rf "$feed"' EXIT
cp "$out/$archive" "$feed/$archive"
"$root/build/sparkle/bin/generate_appcast" --account io.github.harzerheribert.tasktap --download-url-prefix "https://github.com/HarzerHeribert/Tasktap/releases/download/v$version/" "$feed"
cp "$feed/appcast.xml" "$out/appcast.xml"
python3 "$root/scripts/verify-release.py" "$out"
printf 'Release prepared in %s. Publish the ZIP and SHA256SUMS before deploying appcast.xml to Pages.\n' "$out"
