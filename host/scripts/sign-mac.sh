#!/bin/bash
# Seals a built Tasktap.app: every program in it signed with the hardened runtime, from the inside out, each with the
# entitlements it needs and no more, then the whole checked by check-signed.sh.
#   host/scripts/sign-mac.sh <app> [identity]
# identity: "-" (the default) signs ad hoc, which proves the bundle's structure and runs on this Mac only; the release
# workflow passes its "Developer ID Application: …" certificate, imported into a keychain of its own on the runner.
# Never run with a real identity on a person's Mac: signing is the release workflow's.
#
# Tauri's bundler can sign too, but it gives every program the same entitlements; here the core and the speech
# helper get none.
set -euo pipefail
host="$(cd "$(dirname "$0")/.." && pwd)"
app="${1:?usage: sign-mac.sh <app> [identity]}"
identity="${2:--}"
if [ "$identity" = - ]; then stamp=--timestamp=none; else stamp=--timestamp; fi
sign() { codesign --force --options runtime "$stamp" --sign "$identity" "$@"; }
# A copy's extended attributes (Finder information, quarantine) make codesign refuse the bundle.
xattr -cr "$app"
# The programs inside first. The core runs the terminals and the agents' hooks and asks macOS for nothing protected
# itself (what runs in its terminals is counted as the app's); the speech helper is handed the samples by the app and
# never opens the microphone. Neither gets entitlements.
for helper in tasktap tasktap-speech; do
  if [ -e "$app/Contents/MacOS/$helper" ]; then sign "$app/Contents/MacOS/$helper"; fi
done
# Then the app: its main program and the seal over the bundle, with the app's entitlements (host/entitlements/app.plist).
sign --entitlements "$host/entitlements/app.plist" "$app"
if [ "$identity" = - ]; then
  "$host/scripts/check-signed.sh" "$app"
else
  "$host/scripts/check-signed.sh" "$app" --developer-id
fi
