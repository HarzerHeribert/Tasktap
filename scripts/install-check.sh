#!/bin/bash
# What the Mac's install line (site/install.sh) does, tried on this Mac with stand-ins and piped into sh as a person runs
# it. Nothing is installed or started: the release's files come from folders here (TASKTAP_INSTALL_FROM), the app goes
# to a folder here (TASKTAP_INSTALL_TO, or ~/Applications with HOME a folder here), TASKTAP_INSTALL_NO_START=1, and
# every run inherits stage, tmp, mounted, dir and old naming a folder that must survive it. The script has no switch
# that turns a check off; the stand-ins reach it in two ways only:
#   - uname, sysctl, sw_vers and pgrep, which describe this Mac, are found on its PATH, where the check puts its own;
#   - Apple's verdicts (spctl, codesign), /usr/bin/id and /Applications are named by full path, so the cases that need
#     them stood in run a copy of the script in which exactly those, and TEAM_ID, are replaced (the check proves the
#     copies differ in nothing else). The stand-in codesign still checks the signature with the real one; it stands in
#     only for Apple's chain and the team.
# As shipped (TEAM_ID empty): refused before any download, and no prefix of the script runs anything.
# With TEAM_ID set and Apple's tools: an Intel Mac, a running Tasktap (stood in, and a real process in a Tasktap.app
# found by the real pgrep, while one in "Tasktap Review.app" is not), an address that is not https, a file the release
# does not have, a wrong SHA-256, an image that is not notarised, one of no team, a folder or app that is not the
# person's, and a second install while one runs are each refused for their own reason, with nothing installed and
# nothing left; a replacement cut short before is put back, an old lock is cleared, and a link among the leftovers is
# not followed.
# With Apple's verdicts stood in: root, an image or an app of another team, a copy macOS does not accept, an old copy
# that cannot be moved, a final move that fails after the old copy was moved away (it is put back), and a Tasktap.app
# that appears meanwhile are refused; the old copy is replaced on success; and without TASKTAP_INSTALL_TO, the place is
# where a copy is, never both, else /Applications if it is the person's to write, else ~/Applications.
# Also: the requirement is exactly the one expected, compiles, and accepts a real Developer ID signature only under its
# own team (node's, where node is signed so); sh -n; shellcheck where installed; plain ASCII in both install scripts
# (Windows PowerShell 5.1 reads a script given without a character set as Latin-1); the release's file names agree.
# The accepting path with Apple's real verdicts needs an image Apple notarised: release.yml tries it on a signed run,
# and verify-and-publish.yml with the real line on the real release when a release is published.
#   scripts/install-check.sh [install.sh]   (exit status 1 on a failure; the argument is for trying another version)
# The conditions and the stand-ins' bodies are in single quotes on purpose: they are evaluated later, by eval or sh.
# shellcheck disable=SC2016
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
script="${1:-$root/site/install.sh}"
work="$(mktemp -d "${TMPDIR:-/tmp}/tasktap-install-check.XXXXXX")"
procs=""
trap 'for p in $procs; do kill "$p" 2>/dev/null || true; done; chflags -R nouchg "$work" 2>/dev/null; chmod -R u+w "$work" 2>/dev/null; rm -rf "$work"' EXIT
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

# The requirement: Apple's anchor, the Developer ID intermediate, a Developer ID Application leaf, and the team.
expected='anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "'
if [ "$(grep -c "^  req=" "$script")" = 1 ] && grep -qxF "  req='$expected'\"\$TEAM_ID\"'\"'" "$script"; then pass "the requirement is exactly the one expected"
else fail "the requirement is not exactly: $expected<TEAM_ID>\""; fi
req="$expected"
adhoc="$work/adhoc.app"
mkdir -p "$adhoc/Contents/MacOS"
printf '#!/bin/sh\nexit 0\n' > "$adhoc/Contents/MacOS/t"
chmod +x "$adhoc/Contents/MacOS/t"
/usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string t' -c 'Add :CFBundleIdentifier string example.adhoc' "$adhoc/Contents/Info.plist" >/dev/null
codesign --sign - --force "$adhoc" 2>/dev/null
code=0; codesign --verify -R="${req}TESTTEAM01\"" "$adhoc" 2>/dev/null || code=$?
if [ "$code" = 3 ]; then pass "the requirement compiles, and an ad hoc signature fails it"; else fail "the requirement (exit $code)"; fi
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
for kind in mac intel running realpgrep race guarded gnustat; do shim "$kind" sysctl "$arm"; done
for kind in mac intel race guarded gnustat; do shim "$kind" pgrep 'exit 1'; done
# Homebrew's coreutils first on PATH: its stat reads -f as "the file system", and answers nothing a BSD stat would.
shim gnustat stat 'echo "stat: cannot read file system information for %u: No such file or directory" >&2; exit 1'
shim intel sysctl '[ "$*" = "-n hw.optional.arm64" ] && exit 1; exec /usr/sbin/sysctl "$@"'
shim running pgrep 'echo 4242'
# A second install putting a Tasktap.app in place just after this one moved the old copy away.
shim race mv '/bin/mv "$@" || exit; case "$2" in */previous.app) d="$(dirname "$1")"; mkdir -p "$d/Tasktap.app/Contents"; echo other > "$d/Tasktap.app/Contents/other" ;; esac'
# macOS's App Management, which lets the old copy look writable and refuses only its move.
shim guarded mv 'case "$2" in */previous.app) echo "mv: rename $1 to $2: Operation not permitted" >&2; exit 1 ;; esac; exec /bin/mv "$@"'

# Stand-ins for Apple's verdicts and for id, used only by the test copies below. spctl: notarised, unless the check has
# said the copied app is not, or has asked it to make the copy immovable. codesign: the real one checks the signature;
# the team is the one the check wrote for an image or an app. id: root when the check says so.
apple="$work/apple"
mkdir -p "$apple"
cat > "$apple/spctl" <<EOF
#!/bin/sh
case "\$*" in *exec*)
  [ -e "$apple/exec-rejected" ] && { echo "\$*: rejected"; exit 3; }
  if [ -e "$apple/lock-copy" ]; then for t do :; done; chflags uchg "\$t"; fi ;;
esac
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
cat > "$apple/id" <<EOF
#!/bin/sh
[ "\$*" = "-u" ] && [ -e "$apple/root" ] && { echo 0; exit 0; }
exec /usr/bin/id "\$@"
EOF
chmod +x "$apple/spctl" "$apple/codesign" "$apple/id"
copy="$work/install-team.sh"; notarised="$work/install-notarised.sh"; stood="$work/install-stood-in.sh"
sed 's/^TEAM_ID=""$/TEAM_ID="TESTTEAM01"/' "$script" > "$copy"
sed "s|/usr/sbin/spctl|$apple/spctl|g" "$copy" > "$notarised"
sed -e "s|/usr/sbin/spctl|$apple/spctl|g" -e "s|/usr/bin/codesign|$apple/codesign|g" -e "s|/usr/bin/id|$apple/id|g" \
  -e "s|apps=/Applications\$|apps=$work/Applications|" "$copy" > "$stood"
other="$(diff "$script" "$stood" | grep '^<' | grep -v -e '/usr/sbin/spctl' -e '/usr/bin/codesign' -e '/usr/bin/id' -e '^< TEAM_ID=""$' -e 'apps=/Applications$' || true)"
if [ -z "$other" ] && [ "$(diff "$script" "$copy" | grep -c '^<')" = 1 ] && grep -q '^TEAM_ID="TESTTEAM01"$' "$stood" &&
  ! grep -q -e '/usr/sbin/spctl' -e '/usr/bin/codesign' -e '/usr/bin/id' -e 'apps=/Applications$' "$stood"; then
  pass "the test copies differ from the script only in TEAM_ID, the paths of spctl, codesign and id, and /Applications"
else fail "the test copies: $other"; fi

# A disk image as the release makes it, from a stand-in app that does nothing, signed ad hoc: right in form, not
# notarised, of no team.
app="$work/stage/Tasktap.app"
precious="$work/precious"
mkdir -p "$app/Contents/MacOS" "$work/good" "$work/wrong" "$work/half" "$work/empty" "$work/tmp" "$precious"
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
echo "kept" > "$precious/file"
old_app() { mkdir -p "$1/Contents"; echo "the copy there before" > "$1/Contents/old"; }
places=("$work/to" "$work/Applications" "$work/home/Applications")
reset() {
  chflags -R nouchg "$work/to" "$work/Applications" "$work/home" 2>/dev/null || true
  chmod -R u+w "$work/to" "$work/Applications" "$work/home" 2>/dev/null || true
  rm -rf "${work:?}/to" "${work:?}/Applications" "${work:?}/home" "${apple:?}/root" "${apple:?}/exec-rejected" "${apple:?}/lock-copy" "${apple:?}/app-team"
  mkdir -p "$work/to" "$work/Applications" "$work/home"
  echo TESTTEAM01 > "$apple/team"
}
reset

# Runs <script> as `curl ... | sh` does, from <from>, with the stand-ins of <kind> and any NAME=value given after;
# sets $out and $code.
run() {
  local kind="$1" from="$2" file="$3"
  shift 3
  code=0
  out="$(env PATH="$work/$kind:$PATH" TMPDIR="$work/tmp/" HOME="$work/home" TASKTAP_INSTALL_FROM="$from" TASKTAP_INSTALL_TO="$work/to" \
    TASKTAP_INSTALL_NO_START=1 stage="$precious" tmp="$precious" mounted="$precious" dir="$precious" old="$precious" "$@" sh < "$file" 2>&1)" || code=$?
}
said() { grep -q -- "$1" <<<"$out"; }
leftovers() { # what no run may leave: a temporary folder, a stage or lock, a mounted image, a lost folder of the caller's
  local p f
  [ -z "$(ls -A "$work/tmp")" ] || { echo "a temporary folder is left: $(ls -A "$work/tmp")"; return; }
  for p in "${places[@]}"; do for f in "$p"/.tasktap-install*; do [ -e "$f" ] && { echo "$f is left"; return; }; done; done
  [ -e "$precious/file" ] || { echo "the folder the inherited stage, tmp, mounted, dir and old named is gone"; return; }
  if hdiutil info | grep -qF "$work"; then echo "a disk image is still mounted"; fi
}
installed() { local p; for p in "${places[@]}"; do [ ! -e "$p/Tasktap.app" ] || return 0; done; return 1; }
holds() { # <what> <condition, evaluated>: passes when it holds and nothing is left
  local left; left="$(leftovers)"
  if eval "$2" && [ -z "$left" ]; then pass "$1"; else fail "$1${left:+: $left}"; echo "$out"; fi
}
refused() { # <what> <kind> <from> <script> <reason> [NAME=value...]: refused for <reason>, nothing installed or left
  # shellcheck disable=SC2034 # read by the condition holds evaluates
  local what="$1" reason="$5"
  run "$2" "$3" "$4" "${@:6}"
  holds "$what is refused, and nothing is installed or left" '[ "$code" != 0 ] && said "Tasktap was not installed: .*$reason" && ! installed'
}

# As shipped.
refused 'the line while TEAM_ID is empty, before any download,' mac "$work/empty" "$script" 'does not name the team'
cut=0; ran=""
size="$(wc -c < "$script")"
for n in $(awk '{ n += length($0) + 1; print n }' "$script") $(seq $((size - 40)) $((size - 2))); do
  [ "$n" -le $((size - 2)) ] || continue
  cut=$((cut + 1))
  said="$(head -c "$n" "$script" | env PATH="$work/mac:$PATH" TMPDIR="$work/tmp/" HOME="$work/home" TASKTAP_INSTALL_FROM="$work/good" \
    TASKTAP_INSTALL_TO="$work/to" TASKTAP_INSTALL_NO_START=1 sh 2>&1 || true)"
  if grep -q 'Tasktap' <<<"$said" || [ -n "$(ls -A "$work/to")" ] || [ -n "$(ls -A "$work/tmp")" ]; then ran="$ran $n"; fi
done
if [ -z "$ran" ]; then pass "$cut prefixes of the script, at every line and in its last 40 bytes, run nothing"
else fail "prefixes of these lengths ran something:$ran"; fi

# TEAM_ID set, Apple's tools.
refused 'an Intel Mac' intel "$work/good" "$copy" 'Apple silicon only'
refused 'a running Tasktap (pgrep stood in)' running "$work/good" "$copy" 'Tasktap is running'
refused 'an address that is not https' mac "http://example.invalid/Tasktap" "$copy" 'must be an https:// address'
refused 'a release without the disk image' mac "$work/half" "$copy" 'this release does not have Tasktap_aarch64.dmg'
refused 'a disk image with the wrong SHA-256' mac "$work/wrong" "$copy" "SHA-256 is not the one SHA256SUMS lists"
refused 'a disk image with the right SHA-256 that is not notarised' mac "$work/good" "$copy" 'not accept the disk image as notarised'
refused 'a notarised disk image of no team (ad hoc), by the real codesign,' mac "$work/good" "$notarised" "not signed with a Developer ID of Tasktap's team (TESTTEAM01)"
if pgrep -U "$(id -u)" -f '/Tasktap\.app/Contents/MacOS/' >/dev/null; then
  echo "NOTE: a Tasktap of yours is running, so the real pgrep was not tried against a stand-in"
else
  for a in "x/Tasktap.app" "y/Tasktap Review.app"; do
    mkdir -p "$work/$a/Contents/MacOS"
    printf '#!/bin/sh\nwhile :; do sleep 1; done\n' > "$work/$a/Contents/MacOS/tasktap-app"
    chmod +x "$work/$a/Contents/MacOS/tasktap-app"
  done
  "$work/x/Tasktap.app/Contents/MacOS/tasktap-app" & p=$!; procs="$procs $p"
  refused 'a Tasktap.app running from anywhere, found by the real pgrep,' realpgrep "$work/good" "$copy" 'Tasktap is running'
  { kill "$p" && wait "$p"; } 2>/dev/null || true
  "$work/y/Tasktap Review.app/Contents/MacOS/tasktap-app" & p=$!; procs="$procs $p"
  refused 'with only "Tasktap Review.app" running, the real pgrep finds none, so a wrong SHA-256' realpgrep "$work/wrong" "$copy" 'SHA-256 is not the one'
  { kill "$p" && wait "$p"; } 2>/dev/null || true
fi
refused 'a folder of another'\''s (root'\''s /System), at once,' mac "$work/empty" "$copy" 'System belongs to root and is not yours to change; update Tasktap from Settings > About, or ask an administrator' TASKTAP_INSTALL_TO=/System
chmod 555 "$work/to"
refused 'a folder of the person'\''s that is read-only for them, at once,' mac "$work/empty" "$copy" 'is read-only for you; give yourself write access'
reset
old_app "$work/to/Tasktap.app"; chflags uchg "$work/to/Tasktap.app"
run mac "$work/empty" "$copy"
holds 'a Tasktap.app of the person'\''s that is locked is refused at once, saying so, and kept' \
  '[ "$code" != 0 ] && said "Tasktap.app is locked; unlock it in Finder" && [ -e "$work/to/Tasktap.app/Contents/old" ]'
reset
mkdir "$work/to/.tasktap-install.lock"
run mac "$work/wrong" "$copy"
if [ "$code" != 0 ] && said 'another install of Tasktap into .* is running' && [ -d "$work/to/.tasktap-install.lock" ]; then
  rmdir "$work/to/.tasktap-install.lock"
  holds 'a second install while one runs is refused, and the first one'\''s lock is left to it' true
else fail "a second install while one runs"; echo "$out"; fi
mkdir "$work/to/.tasktap-install.lock"; touch -t "$(date -v-2H +%Y%m%d%H%M)" "$work/to/.tasktap-install.lock"
run mac "$work/wrong" "$copy"
holds 'a lock older than an hour is cleared, and the run goes on (to a wrong SHA-256)' '[ "$code" != 0 ] && said "SHA-256 is not the one"'
mkdir -p "$work/to/.tasktap-install.cut/previous.app" "$work/to/.tasktap-install.empty"
echo "the copy there before" > "$work/to/.tasktap-install.cut/previous.app/old"
run mac "$work/wrong" "$copy"
holds 'a replacement cut short before is put back, and its folders go' '[ "$code" != 0 ] && [ -e "$work/to/Tasktap.app/old" ]'
reset
mkdir -p "$work/elsewhere/previous.app"
ln -s "$work/elsewhere" "$work/to/.tasktap-install.link"
run mac "$work/wrong" "$copy"
if [ "$code" != 0 ] && [ -L "$work/to/.tasktap-install.link" ] && [ -d "$work/elsewhere/previous.app" ] && [ ! -e "$work/to/Tasktap.app" ]; then
  rm "$work/to/.tasktap-install.link"
  holds 'a link among the leftovers is not followed, and what it points at is untouched' true
else fail "a link among the leftovers was followed"; echo "$out"; fi
reset

# TEAM_ID set, Apple's verdicts, id and /Applications stood in.
touch "$apple/root"
refused 'a run as root' mac "$work/good" "$stood" 'without sudo'
reset
echo OTHERTEAM1 > "$apple/team"
refused 'a disk image of another team' mac "$work/good" "$stood" "not signed with a Developer ID of Tasktap's team (TESTTEAM01)"
reset
echo OTHERTEAM1 > "$apple/app-team"; old_app "$work/to/Tasktap.app"
run mac "$work/good" "$stood"
holds 'an app of another team in the image is refused after it is copied, and the copy there before is kept' \
  '[ "$code" != 0 ] && said "copied app.s signature does not hold, or is not a Developer ID of Tasktap.s team" && [ -e "$work/to/Tasktap.app/Contents/old" ]'
reset
touch "$apple/exec-rejected"; old_app "$work/to/Tasktap.app"
run mac "$work/good" "$stood"
holds 'a copy macOS does not accept as notarised is refused, and the copy there before is kept' \
  '[ "$code" != 0 ] && said "not accept the copied app as notarised" && [ -e "$work/to/Tasktap.app/Contents/old" ]'
reset
old_app "$work/to/Tasktap.app"
run guarded "$work/good" "$stood"
holds 'a copy there before that cannot be moved (as App Management refuses) is kept, and the refusal names App Management' \
  '[ "$code" != 0 ] && said "App Management" && [ -e "$work/to/Tasktap.app/Contents/old" ]'
reset
old_app "$work/to/Tasktap.app"; touch "$apple/lock-copy"
run mac "$work/good" "$stood"
chflags -R nouchg "$work/to"
if [ "$code" != 0 ] && said "Tasktap.app could not be put into" && [ -e "$work/to/Tasktap.app/Contents/old" ]; then
  rm -rf "$work"/to/.tasktap-install.*
  holds 'when the final move fails after the old copy was moved away, the old copy is put back' true
else fail "a final move that fails: $(ls -A "$work/to")"; echo "$out"; fi
reset
old_app "$work/to/Tasktap.app"
run race "$work/good" "$stood"
kept=("$work"/to/.tasktap-install.*/previous.app/Contents/old)
if [ "$code" != 0 ] && said "another Tasktap.app appeared" && said "before is kept in $work/to/.tasktap-install" && [ -e "${kept[0]}" ] &&
  [ -e "$work/to/Tasktap.app/Contents/other" ] && [ ! -e "$work/to/Tasktap.app/Tasktap.app" ]; then
  rm -rf "$work"/to/.tasktap-install.*
  holds 'a Tasktap.app that appears while this one is put in place is refused and left as it is, and the old copy is kept, saying where' true
else fail "a Tasktap.app that appears meanwhile: $(ls -A "$work/to")"; echo "$out"; fi
reset
old_app "$work/to/Tasktap.app"
run mac "$work/good" "$stood"
holds 'with Apple'\''s verdicts stood in, the copy there before is replaced, and nothing is started' \
  '[ "$code" = 0 ] && said "^Installed: " && [ -x "$work/to/Tasktap.app/Contents/MacOS/tasktap-app" ] && [ ! -e "$work/to/Tasktap.app/Contents/old" ]'
reset
old_app "$work/to/Tasktap.app"
run gnustat "$work/good" "$stood"
holds 'with a GNU stat first on PATH, the copy there before is replaced and nothing of it is left' \
  '[ "$code" = 0 ] && [ -x "$work/to/Tasktap.app/Contents/MacOS/tasktap-app" ] && [ ! -e "$work/to/Tasktap.app/Contents/old" ]'
reset
old_app "$work/to/Tasktap.app"; touch "$apple/lock-copy"
run gnustat "$work/good" "$stood"
chflags -R nouchg "$work/to"
if [ "$code" != 0 ] && [ -e "$work/to/Tasktap.app/Contents/old" ]; then
  rm -rf "$work"/to/.tasktap-install.*
  holds 'with a GNU stat first on PATH, a final move that fails still puts the old copy back' true
else fail "a final move that fails, with a GNU stat: $(ls -A "$work/to")"; echo "$out"; fi
reset
old_app "$work/Applications/Tasktap.app"; old_app "$work/home/Applications/Tasktap.app"
run mac "$work/empty" "$stood" TASKTAP_INSTALL_TO=
holds 'without TASKTAP_INSTALL_TO, a copy in both /Applications and ~/Applications is refused, naming both' \
  '[ "$code" != 0 ] && said "in $work/Applications and another in $work/home/Applications" && [ -e "$work/Applications/Tasktap.app/Contents/old" ] && [ -e "$work/home/Applications/Tasktap.app/Contents/old" ]'
reset
old_app "$work/home/Applications/Tasktap.app"
run mac "$work/good" "$stood" TASKTAP_INSTALL_TO=
holds 'without TASKTAP_INSTALL_TO, the copy in ~/Applications is replaced where it is' \
  '[ "$code" = 0 ] && [ -x "$work/home/Applications/Tasktap.app/Contents/MacOS/tasktap-app" ] && [ ! -e "$work/Applications/Tasktap.app" ]'
reset
run mac "$work/good" "$stood" TASKTAP_INSTALL_TO=
holds 'without TASKTAP_INSTALL_TO and no copy anywhere, it goes to /Applications when that is the person'\''s to write' \
  '[ "$code" = 0 ] && [ -x "$work/Applications/Tasktap.app/Contents/MacOS/tasktap-app" ] && [ ! -e "$work/home/Applications/Tasktap.app" ]'
reset
chmod 555 "$work/Applications"
run mac "$work/good" "$stood" TASKTAP_INSTALL_TO=
holds 'without TASKTAP_INSTALL_TO and no copy anywhere, it goes to ~/Applications when /Applications is not the person'\''s' \
  '[ "$code" = 0 ] && [ -x "$work/home/Applications/Tasktap.app/Contents/MacOS/tasktap-app" ] && [ ! -e "$work/Applications/Tasktap.app" ]'
reset

[ "$failed" = 0 ] || { echo "install-check: FAILED"; exit 1; }
echo "install-check: every case holds. Not tried here: the accepting path with Apple's real verdicts, which needs an image Apple notarised (release.yml tries it on a signed run)."
