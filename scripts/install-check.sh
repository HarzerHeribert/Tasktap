#!/bin/bash
# What the Mac's install line (site/install.sh) refuses, tried on this Mac with stand-ins, piped into sh as a person
# runs it: an Intel Mac, a running Tasktap, an address that is not https, a disk image whose SHA-256 is not the one
# SHA256SUMS lists, and one whose sum is right but which is not notarised (made here from a tiny stand-in app, signed
# ad hoc; never the real app). Each must be refused with its own reason, with nothing installed and its temporary
# folder gone. The release's files come from a folder here (TASKTAP_INSTALL_FROM), the app would go to a folder here
# (TASKTAP_INSTALL_TO) and would not be started (TASKTAP_INSTALL_NO_START=1). The processor and a running Tasktap are
# told to the script by stand-ins for sysctl and pgrep put first on its PATH; the script has no switch that turns a
# check off. Also: sh -n and, where it is installed, shellcheck; both install scripts are plain ASCII, which Windows
# PowerShell 5.1 needs from a script it is given without a character set.
# The accepting path needs an image Apple notarised: a signed run of release.yml tries it ("The Mac line installs the
# disk image just notarised").
#   scripts/install-check.sh   (exit status 1 on a failure)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
script="$root/site/install.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/tasktap-install-check.XXXXXX")"
trap 'rm -rf "$work"' EXIT
failed=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; failed=1; }

sh -n "$script" && pass "sh -n site/install.sh"
if command -v shellcheck >/dev/null; then
  shellcheck -s sh "$script" && shellcheck "$0" && pass "shellcheck: site/install.sh and this check"
else
  echo "NOTE: shellcheck is not installed, so it was not run"
fi
if LC_ALL=C grep -n '[^[:print:][:space:]]' "$script" "$root/site/install.ps1"; then fail "the install scripts are not plain ASCII"; else pass "both install scripts are plain ASCII"; fi

# Stand-ins for the commands the script asks about this Mac, one folder for each case.
shim() { mkdir -p "$work/$1"; printf '#!/bin/sh\n%s\n' "$3" > "$work/$1/$2"; chmod +x "$work/$1/$2"; }
shim mac sysctl '[ "$*" = "-n hw.optional.arm64" ] && { echo 1; exit 0; }; exec /usr/sbin/sysctl "$@"'
shim mac pgrep 'exit 1'
shim intel sysctl '[ "$*" = "-n hw.optional.arm64" ] && exit 1; exec /usr/sbin/sysctl "$@"'
shim intel pgrep 'exit 1'
shim running sysctl '[ "$*" = "-n hw.optional.arm64" ] && { echo 1; exit 0; }; exec /usr/sbin/sysctl "$@"'
shim running pgrep 'echo 4242'

# A disk image as the release makes it, from a stand-in app that does nothing, signed ad hoc: right in form, not
# notarised.
app="$work/stage/Tasktap.app"
mkdir -p "$app/Contents/MacOS" "$work/good" "$work/wrong" "$work/to" "$work/tmp"
printf '#!/bin/sh\nexit 0\n' > "$app/Contents/MacOS/tasktap-app"
chmod +x "$app/Contents/MacOS/tasktap-app"
/usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string tasktap-app' -c 'Add :CFBundleIdentifier string example.install-check' \
  -c 'Add :CFBundlePackageType string APPL' "$app/Contents/Info.plist" >/dev/null
codesign --sign - --force "$app" 2>/dev/null
hdiutil create -quiet -volname Tasktap -srcfolder "$work/stage" -fs HFS+ -format UDZO "$work/good/Tasktap_aarch64.dmg"
codesign --sign - "$work/good/Tasktap_aarch64.dmg" 2>/dev/null
(cd "$work/good" && shasum -a 256 Tasktap_aarch64.dmg > SHA256SUMS)
cp "$work/good/Tasktap_aarch64.dmg" "$work/wrong/"
printf '%064d  Tasktap_aarch64.dmg\n' 0 > "$work/wrong/SHA256SUMS"

# Runs the script as `curl ... | sh` does, from <folder>, with <case>'s stand-ins; it must refuse saying <reason>.
refused() {
  local case="$1" from="$2" reason="$3" out code=0
  out="$(PATH="$work/$case:$PATH" TMPDIR="$work/tmp/" TASKTAP_INSTALL_FROM="$from" TASKTAP_INSTALL_TO="$work/to" \
    TASKTAP_INSTALL_NO_START=1 sh < "$script" 2>&1)" || code=$?
  if [ "$code" = 0 ]; then fail "$4: it was not refused"; echo "$out"; return; fi
  if ! grep -q "Tasktap was not installed: .*$reason" <<<"$out"; then fail "$4: refused for another reason"; echo "$out"; return; fi
  if [ -n "$(ls -A "$work/to")" ]; then fail "$4: something was installed: $(ls -A "$work/to")"; return; fi
  if [ -n "$(ls -A "$work/tmp")" ]; then fail "$4: its temporary folder is left: $(ls -A "$work/tmp")"; return; fi
  pass "$4 is refused, nothing is installed, its temporary folder is gone: $(grep 'not installed' <<<"$out")"
}
refused intel "$work/good" 'Apple silicon only' 'an Intel Mac'
refused running "$work/good" 'Tasktap is running' 'a running Tasktap'
refused mac "http://example.invalid/Tasktap" 'must be an https:// address' 'an address that is not https'
refused mac "$work/wrong" "SHA-256 is not the one SHA256SUMS lists" 'a disk image with the wrong SHA-256'
refused mac "$work/good" 'not accept the disk image as notarised' 'a disk image with the right SHA-256 that is not notarised'
if hdiutil info | grep -qF "$work"; then fail "a disk image of this check is still mounted"; fi

[ "$failed" = 0 ] || { echo "install-check: FAILED"; exit 1; }
echo "install-check: every refusal holds. Not tried here: the accepting path, which needs an image Apple notarised (release.yml tries it on a signed run)."
