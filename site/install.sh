#!/bin/sh
# Installs Tasktap on a Mac with Apple silicon from the newest release on GitHub. In Terminal:
#   curl -fsSL https://harzerheribert.github.io/Tasktap/install.sh | sh
# It downloads the disk image and the release's list of SHA-256 sums over HTTPS and checks the image against the list;
# asks macOS whether Apple notarised the image and whether it is signed with a Developer ID of Tasktap's team; copies
# the app out of it and asks the same of the copy; and only then puts the copy in place: where a Tasktap.app already
# is, else in /Applications, or in ~/Applications when /Applications is not yours to write. Then it starts Tasktap.
# It never asks for an administrator, and refuses to run as root. The disk image on the release page is the same app;
# this is the way for people who live in a terminal.
#
#   TASKTAP_INSTALL_FROM=<https address or folder>  where the release's files are (default: the newest release)
#   TASKTAP_INSTALL_TO=<folder>                     where Tasktap.app goes instead
#   TASKTAP_INSTALL_NO_START=1                      do not start Tasktap afterwards
# The tools whose verdict matters are called by their full paths. uname, sysctl, sw_vers and pgrep, which only describe
# this Mac, are found on PATH, where scripts/install-check.sh puts its stand-ins for them. One install at a time: a
# second one finds the first one's lock in the folder and stops.
# All of it is one { } block, so that a download cut short runs nothing.
{
set -eu

# The team whose Developer ID signs Tasktap. While it is empty, this script installs nothing.
TEAM_ID=""
IMAGE=Tasktap_aarch64.dmg

say() { printf '%s\n' "$*"; }
refuse() { printf 'Tasktap was not installed: %s\n' "$*" >&2; exit 1; }

# A folder .tasktap-install.* in the place of the app is a replacement under way, or one cut short: the copy it moved
# away goes back where none stands now, and the folder goes. Only a real folder of this person's is touched.
tidy() {
  [ -d "$1" ] && [ ! -L "$1" ] && [ "$(stat -f %u "$1")" = "$(/usr/bin/id -u)" ] || return 0
  if [ -d "$1/previous.app" ] && [ ! -e "$dir/Tasktap.app" ]; then
    mv "$1/previous.app" "$dir/Tasktap.app" || { say "The Tasktap.app that was in $dir is in $1/previous.app; move it back."; return 0; }
  fi
  rm -rf "$1" || say "The folder $1 could not be removed; move it to the Trash."
}

cleanup() {
  if [ -n "$mounted" ]; then /usr/bin/hdiutil detach -quiet "$mounted" || /usr/bin/hdiutil detach -quiet -force "$mounted" || true; fi
  if [ -n "$stage" ]; then tidy "$stage"; fi
  if [ -n "$locked" ]; then rmdir "$locked" || true; fi
  if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
}

fetch() {
  case "$from" in
    https://*) ;;
    *) [ -f "$from/$1" ] || refuse "this release does not have $1 (there is no $from/$1)."
       cp "$from/$1" "$tmp/$1"; return 0 ;;
  esac
  if [ "$1" = "$IMAGE" ]; then show=--progress-bar; else show=--silent; fi
  status=0
  code="$(/usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location --show-error "$show" \
    --connect-timeout 20 --speed-limit 1000 --speed-time 60 --retry 2 \
    --write-out '%{http_code}' --output "$tmp/$1" "$from/$1")" || status=$?
  [ "$status" != 0 ] || return 0
  case "$code" in
    404) refuse "this release does not have $1 ($from/$1 answers 404); it may be older than this line." ;;
    [1-9][0-9][0-9]) refuse "$from/$1 answers HTTP $code, so $1 was not downloaded; try again later." ;;
  esac
  case "$status" in
    6) why="the server's name could not be found" ;;
    7) why="no connection could be made" ;;
    28) why="it was too slow, or timed out" ;;
    35 | 51 | 53 | 54 | 58 | 59 | 60 | 66 | 77 | 80 | 83 | 90 | 91) why="the secure connection (TLS) failed" ;;
    *) why="curl stopped with exit code $status" ;;
  esac
  refuse "$1 could not be downloaded from $from: $why. Check the connection and try again."
}

notarised() { # <verdict of spctl>
  case "$1" in *"source=Notarized Developer ID"*) return 0 ;; *) return 1 ;; esac
}

main() {
  tmp="" stage="" mounted="" dir="" old="" locked="" apps=/Applications
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM
  [ -n "$TEAM_ID" ] || refuse "this line does not name the team that signs Tasktap yet; download the disk image from https://github.com/HarzerHeribert/Tasktap/releases instead."
  [ "$(/usr/bin/id -u)" != 0 ] || refuse "it was run as root (with sudo); paste the line into Terminal as it is, without sudo, so that Tasktap is installed as you."
  [ "$(uname -s)" = Darwin ] || refuse "this line is for a Mac; on Windows, use the line for PowerShell on https://harzerheribert.github.io/Tasktap/"
  [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ] || refuse "Tasktap is built for Macs with Apple silicon only, and this Mac has an Intel processor."
  version="$(sw_vers -productVersion)"
  [ "${version%%.*}" -ge 13 ] || refuse "Tasktap needs macOS 13 or later, and this Mac has macOS $version."
  if pgrep -U "$(/usr/bin/id -u)" -f '/Tasktap\.app/Contents/MacOS/' >/dev/null 2>&1; then
    refuse "Tasktap is running; quit it first, or update it from Settings > About."
  fi
  from="${TASKTAP_INSTALL_FROM:-https://github.com/HarzerHeribert/Tasktap/releases/latest/download}"
  from="${from%/}"
  case "$from" in https://* | /*) ;; *) refuse "TASKTAP_INSTALL_FROM must be an https:// address or a folder." ;; esac
  # Apple's chain to a Developer ID Application certificate of Tasktap's team.
  req='anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "'"$TEAM_ID"'"'

  if [ -n "${TASKTAP_INSTALL_TO:-}" ]; then dir="${TASKTAP_INSTALL_TO%/}"
  elif [ -e "$apps/Tasktap.app" ] && [ -e "$HOME/Applications/Tasktap.app" ]; then
    refuse "there is a Tasktap.app in $apps and another in $HOME/Applications; move one of them to the Trash, then run the line again."
  elif [ -e "$HOME/Applications/Tasktap.app" ]; then dir="$HOME/Applications"
  elif [ -e "$apps/Tasktap.app" ] || [ -w "$apps" ]; then dir="$apps"
  else dir="$HOME/Applications"; fi
  for mine in "$dir" "$dir/Tasktap.app"; do
    if [ -e "$mine" ] && [ ! -w "$mine" ]; then
      refuse "$mine belongs to $(stat -f %Su "$mine") and is not yours to change; update Tasktap from Settings > About, or ask an administrator of this Mac to replace it."
    fi
  done
  mkdir -p "$dir" || refuse "the folder $dir could not be made."
  if [ -n "$(find "$dir/.tasktap-install.lock" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then rmdir "$dir/.tasktap-install.lock" || true; fi
  mkdir "$dir/.tasktap-install.lock" 2>/dev/null ||
    refuse "another install of Tasktap into $dir is running; wait for it to finish (or, if none runs, remove $dir/.tasktap-install.lock)."
  locked="$dir/.tasktap-install.lock"
  for old in "$dir"/.tasktap-install.*; do
    if [ "$old" != "$locked" ]; then tidy "$old"; fi
  done

  tmp="$(mktemp -d "${TMPDIR:-/tmp}/tasktap-install.XXXXXX")"
  say "Downloading Tasktap's disk image ($IMAGE) and the release's SHA256SUMS from $from"
  fetch SHA256SUMS
  fetch "$IMAGE"
  want="$(awk -v n="$IMAGE" '$2 == n || $2 == "*" n { print $1 }' "$tmp/SHA256SUMS")"
  have="$(/usr/bin/shasum -a 256 "$tmp/$IMAGE" | awk '{ print $1 }')"
  [ -n "$want" ] && [ "$want" = "$have" ] ||
    refuse "the disk image's SHA-256 is not the one SHA256SUMS lists, so it was not opened; try again later."
  say "Checked: the disk image's SHA-256 is the one the release lists ($have)."
  verdict="$(/usr/sbin/spctl --assess --type open --context context:primary-signature -vv "$tmp/$IMAGE" 2>&1)" || verdict=""
  notarised "$verdict" || refuse "macOS does not accept the disk image as notarised by Apple, so it was not opened."
  /usr/bin/codesign --verify --strict -R="$req" "$tmp/$IMAGE" 2>/dev/null ||
    refuse "the disk image is not signed with a Developer ID of Tasktap's team ($TEAM_ID), so it was not opened."
  say "Checked: macOS accepts the disk image as notarised by Apple, signed with a Developer ID of Tasktap's team ($TEAM_ID)."

  mkdir "$tmp/image"
  /usr/bin/hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$tmp/image" "$tmp/$IMAGE" </dev/null ||
    refuse "the disk image could not be opened."
  mounted="$tmp/image"
  [ -d "$tmp/image/Tasktap.app" ] || refuse "the disk image holds no Tasktap.app."
  mkdir -p "$dir"
  stage="$(mktemp -d "$dir/.tasktap-install.XXXXXX")"
  /usr/bin/ditto "$tmp/image/Tasktap.app" "$stage/Tasktap.app" || refuse "the app could not be copied into $dir."
  if /usr/bin/hdiutil detach -quiet "$mounted"; then mounted=""; fi
  /usr/bin/codesign --verify --deep --strict -R="$req" "$stage/Tasktap.app" 2>/dev/null ||
    refuse "the copied app's signature does not hold, or is not a Developer ID of Tasktap's team ($TEAM_ID), so it was not installed."
  verdict="$(/usr/sbin/spctl --assess --type exec -vv "$stage/Tasktap.app" 2>&1)" || verdict=""
  notarised "$verdict" || refuse "macOS does not accept the copied app as notarised by Apple, so it was not installed."
  say "Checked: the copy's signature holds, it is a Developer ID of Tasktap's team, and macOS accepts it as notarised."

  # The copy there before is moved away only now, after the new one has passed every check; if anything stops the
  # replacement, cleanup puts it back.
  if [ -e "$dir/Tasktap.app" ]; then
    mv "$dir/Tasktap.app" "$stage/previous.app" ||
      refuse "the Tasktap.app in $dir could not be replaced. Update it from Settings > About in Tasktap, or allow Terminal under System Settings > Privacy & Security > App Management and run the line again."
  fi
  [ ! -e "$dir/Tasktap.app" ] || refuse "another Tasktap.app appeared in $dir while this one was being put there; run the line again."
  mv "$stage/Tasktap.app" "$dir/Tasktap.app" || refuse "Tasktap.app could not be put into $dir."
  tidy "$stage"
  stage=""

  say "Installed: $dir/Tasktap.app. To remove it, quit Tasktap and move it to the Trash."
  if [ "${TASKTAP_INSTALL_NO_START:-}" = 1 ]; then
    say "Start Tasktap from Launchpad or Spotlight, or with: open \"$dir/Tasktap.app\""
  else
    /usr/bin/open "$dir/Tasktap.app"
    say "Tasktap is starting. Next time, start it from Launchpad or Spotlight."
  fi
}

main "$@"
}
