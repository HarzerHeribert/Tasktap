#!/bin/bash
# What the Mac's install line (site/install.sh) does, tried on this Mac with stand-ins and piped into sh as a person runs
# it. Nothing is installed or started: the release's files come from folders here (TASKTAP_INSTALL_FROM), the app goes
# to a folder here (TASKTAP_INSTALL_TO), and TASKTAP_INSTALL_NO_START=1. The script has no switch that turns a check
# off; the stand-ins reach it in two ways only:
#   - uname, sysctl, pgrep and id, which describe this Mac, are found on its PATH, where the check puts its own;
#   - Apple's verdicts (spctl, codesign) are called by full path, so the cases after them run a copy of the script in
#     which those paths, and TEAM_ID, are replaced (the check proves the copy differs in nothing else). The stand-in
#     codesign still checks the signature itself with the real one; it stands in only for Apple's chain and the team.
# As shipped (TEAM_ID empty): refused before any download, and no prefix of the script runs anything.
# With TEAM_ID set and Apple's own tools: root, an Intel Mac, a running Tasktap, an address that is not https, a file
# the release does not have, a wrong SHA-256, an image that is not notarised, and an image Apple's tools find signed by
# another team (ad hoc) are each refused for their own reason, with nothing installed, no temporary folder left, and a
# folder named by an exported `stage` untouched; a replacement cut short before is put back.
# With Apple's verdicts stood in: an app of another team is refused, a copy macOS does not accept is refused, an
# existing Tasktap.app is replaced on success and kept when its replacement fails.
# Also: the requirement compiles and accepts a real Developer ID signature only under its own team (node's, where node
# is signed so), sh -n, shellcheck where installed, plain ASCII in both install scripts (Windows PowerShell 5.1 reads a
# script given without a character set as Latin-1), and the release's file names agree everywhere they are named.
# The accepting path with Apple's real verdicts needs an image Apple notarised: a signed run of release.yml tries it.
#   scripts/install-check.sh [install.sh]   (exit status 1 on a failure; the argument is for trying another version)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
script="${1:-$root/site/install.sh}"
work="$(mktemp -d "${TMPDIR:-/tmp}/tasktap-install-check.XXXXXX")"
trap 'chflags -R nouchg "$work" 2>/dev/null; rm -rf "$work"' EXIT
failed=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; failed=1; }

if sh -n "$script"; then pass "sh -n"; else fail "sh -n"; fi
if ! command -v shellcheck >/dev/null; then echo "NOTE: shellcheck is not installed, so it was not run"
elif shellcheck -s sh "$script" && shellcheck "$0"; then pass "shellcheck: the install script and this check"
else fail "shellcheck"; fi
if LC_ALL=C grep -n '[^[:print:][:space:]]' "$script" "$root/site/install.ps1"; then fail "the install scripts are not plain ASCII"
else pass "both install scripts are plain ASCII"; fi
names_agree() {
  local name file
  for name in Tasktap_aarch64.dmg Tasktap_x64-setup.exe SHA256SUMS; do
    for file in .github/workflows/release.yml site/install.sh site/install.ps1 scripts/verify-pages.cjs site/index.html; do
      case "$name:$file" in Tasktap_x64-setup.exe:site/install.sh | Tasktap_aarch64.dmg:site/install.ps1 | SHA256SUMS:scripts/verify-pages.cjs | SHA256SUMS:site/index.html) continue ;; esac
      grep -qF "$name" "$root/$file" || { echo "$file does not name $name"; return 1; }
    done
  done
}
if names_agree; then pass "the release's file names agree in release.yml, both install scripts, the page and its check"; else fail "the release's file names disagree"; fi

# The requirement the script holds the image and the app to, run by the real codesign.
req="$(sed -n "s/^  req='\(.*\)'\"\$TEAM_ID\"'\"'$/\1/p" "$script")"
adhoc="$work/adhoc.app"
mkdir -p "$adhoc/Contents/MacOS"
printf '#!/bin/sh\nexit 0\n' > "$adhoc/Contents/MacOS/t"
chmod +x "$adhoc/Contents/MacOS/t"
/usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string t' -c 'Add :CFBundleIdentifier string example.adhoc' "$adhoc/Contents/Info.plist" >/dev/null
codesign --sign - --force "$adhoc" 2>/dev/null
code=0; codesign --verify -R="${req}TESTTEAM01\"" "$adhoc" 2>/dev/null || code=$?
if [ -n "$req" ] && [ "$code" = 3 ]; then pass "the requirement compiles, and an ad hoc signature fails it"; else fail "the requirement (exit $code): ${req}TESTTEAM01\""; fi
node="$(command -v node || true)"
[ -z "$node" ] || node="$(readlink -f "$node")"
info="$( [ -n "$node" ] && codesign -dv --verbose=2 "$node" 2>&1 || true)"
team="$(sed -n 's/^TeamIdentifier=//p' <<<"$info")"
if [ -n "$team" ] && [ "$team" != "not set" ] && grep -q '^Authority=Developer ID Application' <<<"$info"; then
  ours=0; theirs=0
  codesign --verify --strict -R="${req}$team\"" "$node" 2>/dev/null || ours=$?
  codesign --verify --strict -R="${req}AAAAAAAAAA\"" "$node" 2>/dev/null || theirs=$?
  if [ "$ours" = 0 ] && [ "$theirs" = 3 ]; then pass "the requirement accepts a real Developer ID signature (node's, team $team) and refuses it under another team"
  else fail "the requirement on node's Developer ID signature: its own team exit $ours, another team exit $theirs"; fi
else
  echo "NOTE: no node signed with a Developer ID here, so the requirement was not tried on one"
fi

# Stand-ins for what describes this Mac, one folder for each kind of Mac.
shim() { mkdir -p "$work/$1"; printf '#!/bin/sh\n%s\n' "$3" > "$work/$1/$2"; chmod +x "$work/$1/$2"; }
arm='[ "$*" = "-n hw.optional.arm64" ] && { echo 1; exit 0; }; exec /usr/sbin/sysctl "$@"'
for kind in mac intel running root; do
  shim "$kind" sysctl "$arm"
  shim "$kind" pgrep 'exit 1'
  shim "$kind" id 'exec /usr/bin/id "$@"'
done
shim intel sysctl '[ "$*" = "-n hw.optional.arm64" ] && exit 1; exec /usr/sbin/sysctl "$@"'
shim running pgrep 'echo 4242'
shim root id '[ "$*" = "-u" ] && { echo 0; exit 0; }; exec /usr/bin/id "$@"'

# Stand-ins for Apple's verdicts, used only by the test copy below. spctl: notarised, unless the check has said the
# copied app is not. codesign: the real one checks the signature; the team is the one the check wrote for an image or an
# app, and it satisfies the requirement only if the requirement names it.
apple="$work/apple"
mkdir -p "$apple"
cat > "$apple/spctl" <<EOF
#!/bin/sh
case "\$*" in *exec*) [ -e "$apple/exec-rejected" ] && { echo "\$*: rejected"; exit 3; } ;; esac
echo accepted; echo "source=Notarized Developer ID"
EOF
cat > "$apple/codesign" <<EOF
#!/bin/sh
req=""; target=""
for a do shift; case "\$a" in -R=*) req="\${a#-R=}" ;; *) set -- "\$@" "\$a"; target="\$a" ;; esac; done
/usr/bin/codesign "\$@" || exit
[ -z "\$req" ] && exit 0
case "\$target" in *.app) f=app-team ;; *) f=team ;; esac
[ -e "$apple/\$f" ] || f=team
case "\$req" in *"[subject.OU] = \\"\$(cat "$apple/\$f")\\""*) exit 0 ;; esac
echo "\$target: test-requirement: code failed to satisfy specified code requirement(s)" >&2; exit 3
EOF
chmod +x "$apple/spctl" "$apple/codesign"
copy="$work/install-team.sh"; stood="$work/install-stood-in.sh"
sed 's/^TEAM_ID=""$/TEAM_ID="TESTTEAM01"/' "$script" > "$copy"
sed -e 's/^TEAM_ID=""$/TEAM_ID="TESTTEAM01"/' -e "s|/usr/sbin/spctl|$apple/spctl|g" -e "s|/usr/bin/codesign|$apple/codesign|g" "$script" > "$stood"
other="$(diff "$script" "$stood" | grep '^<' | grep -v -e '/usr/sbin/spctl' -e '/usr/bin/codesign' -e '^< TEAM_ID=""$' || true)"
if [ -z "$other" ] && grep -q '^TEAM_ID="TESTTEAM01"$' "$stood" && ! grep -q -e '/usr/sbin/spctl' -e '/usr/bin/codesign' "$stood"; then
  pass "the test copies differ from the script only in TEAM_ID and the paths of spctl and codesign"
else fail "the test copies: $other"; fi

# A disk image as the release makes it, from a stand-in app that does nothing, signed ad hoc: right in form, not
# notarised, of no team.
app="$work/stage/Tasktap.app"
mkdir -p "$app/Contents/MacOS" "$work/good" "$work/wrong" "$work/half" "$work/empty" "$work/to" "$work/tmp" "$work/precious"
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
cp "$work/good/SHA256SUMS" "$work/half/"
echo "kept" > "$work/precious/file"
old_app() { mkdir -p "$1/Contents"; echo "the copy there before" > "$1/Contents/old"; }

# Runs <script> as `curl ... | sh` does, from <from>, with the stand-ins of <kind>; sets $out and $code.
run() {
  local kind="$1" from="$2" file="$3"
  code=0
  out="$(PATH="$work/$kind:$PATH" TMPDIR="$work/tmp/" TASKTAP_INSTALL_FROM="$from" TASKTAP_INSTALL_TO="$work/to" \
    TASKTAP_INSTALL_NO_START=1 stage="$work/precious" sh < "$file" 2>&1)" || code=$?
}
staged() { local f; for f in "$work/to"/.tasktap-install.*; do [ -e "$f" ] && return 0; done; return 1; }
leftovers() { # what a run may not leave: a temporary folder, a stage, a mounted image, a lost folder of the caller's
  [ -z "$(ls -A "$work/tmp")" ] || { echo "a temporary folder is left: $(ls -A "$work/tmp")"; return; }
  if staged; then echo "a .tasktap-install folder is left"; return; fi
  [ -e "$work/precious/file" ] || { echo "the folder an exported stage named is gone"; return; }
  if hdiutil info | grep -qF "$work"; then echo "a disk image is still mounted"; fi
}
refused() { # <what> <kind> <from> <script> <reason>: refused for <reason>, nothing installed, nothing left
  run "$2" "$3" "$4"
  local left; left="$(leftovers)"
  if [ "$code" = 0 ]; then fail "$1: it was not refused"; echo "$out"
  elif ! grep -q "Tasktap was not installed: .*$5" <<<"$out"; then fail "$1: refused for another reason"; echo "$out"
  elif [ -n "$(ls -A "$work/to")" ]; then fail "$1: something was installed: $(ls -A "$work/to")"
  elif [ -n "$left" ]; then fail "$1: $left"
  else pass "$1 is refused, and nothing is installed or left: $(grep 'not installed' <<<"$out")"; fi
}

# As shipped.
refused 'the line while TEAM_ID is empty, before any download' mac "$work/empty" "$script" 'does not name the team'
cut=0; ran=""
size="$(wc -c < "$script")"
for n in $(awk '{ n += length($0) + 1; print n }' "$script") $(seq $((size - 40)) $((size - 2))); do
  [ "$n" -le $((size - 2)) ] || continue
  cut=$((cut + 1))
  said="$(head -c "$n" "$script" | PATH="$work/mac:$PATH" TMPDIR="$work/tmp/" TASKTAP_INSTALL_FROM="$work/good" \
    TASKTAP_INSTALL_TO="$work/to" TASKTAP_INSTALL_NO_START=1 sh 2>&1 || true)"
  if grep -q 'Tasktap' <<<"$said" || [ -n "$(ls -A "$work/to")" ] || [ -n "$(ls -A "$work/tmp")" ]; then ran="$ran $n"; fi
done
if [ -z "$ran" ]; then pass "$cut prefixes of the script, at every line and in its last 40 bytes, run nothing"
else fail "prefixes of these lengths ran something:$ran"; fi

# TEAM_ID set, Apple's own tools.
refused 'a run as root' root "$work/good" "$copy" 'without sudo'
refused 'an Intel Mac' intel "$work/good" "$copy" 'Apple silicon only'
refused 'a running Tasktap' running "$work/good" "$copy" 'Tasktap is running'
refused 'an address that is not https' mac "http://example.invalid/Tasktap" "$copy" 'must be an https:// address'
refused 'a release without the disk image' mac "$work/half" "$copy" 'this release does not have Tasktap_aarch64.dmg'
refused 'a disk image with the wrong SHA-256' mac "$work/wrong" "$copy" "SHA-256 is not the one SHA256SUMS lists"
refused 'a disk image with the right SHA-256 that is not notarised' mac "$work/good" "$copy" 'not accept the disk image as notarised'
echo OTHERTEAM1 > "$apple/team"
sed "s|/usr/sbin/spctl|$apple/spctl|g" "$copy" > "$work/install-notarised.sh"
refused 'a notarised disk image of no team (ad hoc), by the real codesign' mac "$work/good" "$work/install-notarised.sh" "not signed with a Developer ID of Tasktap's team (TESTTEAM01)"
mkdir -p "$work/to/.tasktap-install.cut/previous.app" "$work/to/.tasktap-install.empty"
echo "the copy there before" > "$work/to/.tasktap-install.cut/previous.app/old"
run mac "$work/wrong" "$copy"
if [ "$code" != 0 ] && [ -e "$work/to/Tasktap.app/old" ] && ! staged; then
  pass "a replacement cut short before is put back, and its folders go"
else fail "a replacement cut short before: $(ls -A "$work/to")"; echo "$out"; fi
rm -rf "${work:?}/to" && mkdir "$work/to"

# TEAM_ID set, Apple's verdicts stood in.
refused 'a disk image of another team' mac "$work/good" "$stood" "not signed with a Developer ID of Tasktap's team (TESTTEAM01)"
echo TESTTEAM01 > "$apple/team"; echo OTHERTEAM1 > "$apple/app-team"
old_app "$work/to/Tasktap.app"
run mac "$work/good" "$stood"
if [ "$code" != 0 ] && grep -q "copied app's signature does not hold, or is not a Developer ID of Tasktap's team" <<<"$out" && [ -e "$work/to/Tasktap.app/Contents/old" ] && [ -z "$(leftovers)" ]; then
  pass "an app of another team in the image is refused after it is copied, and the copy there before is kept"
else fail "an app of another team: $(leftovers)"; echo "$out"; fi
rm "$apple/app-team"; touch "$apple/exec-rejected"
run mac "$work/good" "$stood"
if [ "$code" != 0 ] && grep -q "not accept the copied app as notarised" <<<"$out" && [ -e "$work/to/Tasktap.app/Contents/old" ] && [ -z "$(leftovers)" ]; then
  pass "a copy macOS does not accept as notarised is refused, and the copy there before is kept"
else fail "a copy macOS does not accept: $(leftovers)"; echo "$out"; fi
rm "$apple/exec-rejected"
chflags uchg "$work/to/Tasktap.app"
run mac "$work/good" "$stood"
chflags nouchg "$work/to/Tasktap.app"
if [ "$code" != 0 ] && grep -q "App Management" <<<"$out" && [ -e "$work/to/Tasktap.app/Contents/old" ] && [ -z "$(leftovers)" ]; then
  pass "a copy there before that cannot be moved (as App Management refuses) is kept, and the refusal names App Management"
else fail "a copy there before that cannot be moved: $(leftovers)"; echo "$out"; fi
run mac "$work/good" "$stood"
if [ "$code" = 0 ] && grep -q '^Installed: ' <<<"$out" && [ -x "$work/to/Tasktap.app/Contents/MacOS/tasktap-app" ] && [ ! -e "$work/to/Tasktap.app/Contents/old" ] && [ -z "$(leftovers)" ]; then
  pass "with Apple's verdicts stood in, the copy there before is replaced, nothing is left, and nothing is started"
else fail "the replacement: $(leftovers)"; echo "$out"; fi

[ "$failed" = 0 ] || { echo "install-check: FAILED"; exit 1; }
echo "install-check: every case holds. Not tried here: the accepting path with Apple's real verdicts, which needs an image Apple notarised (release.yml tries it on a signed run)."
