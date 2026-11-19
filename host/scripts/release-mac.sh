#!/bin/bash
# Makes the Mac's release files from a built app, into host/target/release/dist/:
#   <Name>_<version>_<arch>.dmg               what a person downloads: the app and a link to Applications
#   <Name>_<version>_<arch>.app.tar.gz[.sig]  what the updater downloads, and its signature
# Steps: seal the app (sign-mac.sh), notarise it and staple the ticket to it, make the disk image from the stapled app,
# sign, notarise and staple that too, then pack the stapled app for the updater and sign the pack with the updater's key.
#   host/scripts/release-mac.sh [--build]
# --build first builds the app (build.sh; TASKTAP_VERSION sets its version).
#
# What it uses is in the environment, and each part that is missing is skipped and said so, so that a dry run (no
# secrets) still goes through every step that can run without them:
#   APPLE_SIGNING_IDENTITY                             the Developer ID certificate's name; without it, ad hoc
#   APPLE_API_ISSUER, APPLE_API_KEY, APPLE_API_KEY_PATH an App Store Connect API key, to notarise; without, not notarised
#   TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]               the updater's key; without it, the pack is not signed
# The release workflow sets them on its runner; nothing here reads or writes a keychain.
set -euo pipefail
host="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$host/.." && pwd)"
if [ "${1:-}" = --build ]; then "$host/scripts/build.sh"; fi
name="$(node -p "require('$host/tauri.conf.json').productName")"
app="$host/target/release/bundle/macos/$name.app"
[ -d "$app" ] || { echo "No $app: build it first (host/scripts/build.sh)" >&2; exit 1; }
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
case "$(uname -m)" in arm64) arch=aarch64 ;; *) arch="$(uname -m)" ;; esac
dist="$host/target/release/dist"
rm -rf "$dist"
mkdir -p "$dist"
base="$dist/${name}_${version}_${arch}"
identity="${APPLE_SIGNING_IDENTITY:--}"
notarise=0
if [ -n "${APPLE_API_ISSUER:-}" ] && [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_PATH:-}" ]; then notarise=1; fi
if [ "$notarise" = 1 ] && [ "$identity" = - ]; then echo "Notarising needs a Developer ID: APPLE_SIGNING_IDENTITY is not set" >&2; exit 1; fi

# Sends a file to Apple's notary service and waits for its verdict (minutes, usually); prints Apple's log if it is not
# accepted.
notarise() {
  local said status id
  said="$(xcrun notarytool submit "$1" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" \
    --wait --timeout 1h --output-format json)" || true
  status="$(node -p 'JSON.parse(process.argv[1]).status' "$said" 2>/dev/null || echo unknown)"
  id="$(node -p 'JSON.parse(process.argv[1]).id' "$said" 2>/dev/null || echo '')"
  echo "notarisation of $(basename "$1"): $status${id:+ ($id)}"
  if [ "$status" != Accepted ]; then
    echo "$said"
    if [ -n "$id" ]; then xcrun notarytool log "$id" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" || true; fi
    exit 1
  fi
}
staple() { xcrun stapler staple "$1" && xcrun stapler validate "$1"; }

echo "== Sealing $name $version ($arch) with ${identity/#-/an ad-hoc signature}"
"$host/scripts/sign-mac.sh" "$app" "$identity"

if [ "$notarise" = 1 ]; then
  echo "== Notarising the app"
  ditto -c -k --keepParent "$app" "$dist/notarise.zip"
  notarise "$dist/notarise.zip"
  rm "$dist/notarise.zip"
  staple "$app"
  "$host/scripts/check-signed.sh" "$app" --developer-id --notarised
else
  echo "== Not notarised: APPLE_API_ISSUER, APPLE_API_KEY and APPLE_API_KEY_PATH are not all set"
fi

echo "== The disk image"
stage="$dist/stage"
mkdir -p "$stage"
ditto "$app" "$stage/$name.app"
ln -s /Applications "$stage/Applications"
hdiutil create -quiet -volname "$name" -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$base.dmg"
rm -rf "$stage"
if [ "$identity" != - ]; then
  codesign --sign "$identity" --timestamp "$base.dmg"
  codesign --verify --strict "$base.dmg"
fi
if [ "$notarise" = 1 ]; then
  notarise "$base.dmg"
  staple "$base.dmg"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$base.dmg"
fi
# The image holds the app as sealed: mounted read-only where nothing else looks, checked, and let go.
mount="$(mktemp -d)"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mount" "$base.dmg"
check=0
"$host/scripts/check-signed.sh" "$mount/$name.app" >/dev/null || check=$?
hdiutil detach -quiet "$mount"
rmdir "$mount"
[ "$check" = 0 ] || { echo "The app in the disk image is not sealed" >&2; exit 1; }

echo "== The updater's pack"
# The updater unpacks <Name>.app from it in place of the running app (Tauri's own layout); no AppleDouble files.
COPYFILE_DISABLE=1 tar -czf "$base.app.tar.gz" -C "$(dirname "$app")" "$name.app"
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  # A line break after the key, as a secret set from a file may have, makes Tauri's signer refuse it.
  TAURI_SIGNING_PRIVATE_KEY="$(printf '%s' "$TAURI_SIGNING_PRIVATE_KEY" | tr -d '[:space:]')" \
    "$root/ui/node_modules/.bin/tauri" signer sign "$base.app.tar.gz" >/dev/null
  test -s "$base.app.tar.gz.sig"
  echo "signed for the updater"
else
  echo "Not signed for the updater: TAURI_SIGNING_PRIVATE_KEY is not set"
fi
ls -l "$dist"
