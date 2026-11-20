#!/bin/sh
# Installs Tasktap on a Mac with Apple silicon from the newest release on GitHub. In Terminal:
#   curl -fsSL https://harzerheribert.github.io/Tasktap/install.sh | sh
# It downloads the disk image and the release's list of SHA-256 sums over HTTPS, checks the image against the list,
# asks macOS whether Apple notarised the image, checks the app's signature and the team that made it, copies the app
# to /Applications (or ~/Applications when /Applications is not yours to write) and starts it. It never asks for an
# administrator. The disk image on the release page is the same app; this is the way for people who live in a terminal.
#
#   TASKTAP_INSTALL_FROM=<https address or folder>  where the release's files are (default: the newest release)
#   TASKTAP_INSTALL_TO=<folder>                     where Tasktap.app goes instead
#   TASKTAP_INSTALL_NO_START=1                      do not start Tasktap afterwards
set -eu

# The team whose Developer ID signs Tasktap. While it is empty, this script installs nothing.
TEAM_ID=""
IMAGE=Tasktap_aarch64.dmg

say() { printf '%s\n' "$*"; }
refuse() { printf 'Tasktap was not installed: %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [ -n "${mounted:-}" ]; then hdiutil detach -quiet "$tmp/image" || hdiutil detach -quiet -force "$tmp/image" || true; fi
  if [ -n "${stage:-}" ]; then rm -rf "$stage"; fi
  if [ -n "${tmp:-}" ]; then rm -rf "$tmp"; fi
}

fetch() {
  case "$from" in
    https://*) curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --retry 2 -o "$tmp/$1" "$from/$1" ||
      refuse "$1 could not be downloaded from $from; check the connection and try again." ;;
    *) cp "$from/$1" "$tmp/$1" 2>/dev/null || refuse "there is no $1 in $from." ;;
  esac
}

# All in one function, so that the whole script has arrived before any of it runs when it is piped into sh.
main() {
  from="${TASKTAP_INSTALL_FROM:-https://github.com/HarzerHeribert/Tasktap/releases/latest/download}"
  from="${from%/}"
  [ "$(uname -s)" = Darwin ] || refuse "this line is for a Mac; on Windows, use the line for PowerShell on https://harzerheribert.github.io/Tasktap/"
  [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ] || refuse "Tasktap is built for Macs with Apple silicon only, and this Mac has an Intel processor."
  version="$(sw_vers -productVersion)"
  [ "${version%%.*}" -ge 13 ] || refuse "Tasktap needs macOS 13 or later, and this Mac has macOS $version."
  if pgrep -x tasktap-app >/dev/null 2>&1; then
    refuse "Tasktap is running; quit it first, or update it from Settings > About."
  fi
  case "$from" in https://* | /*) ;; *) refuse "TASKTAP_INSTALL_FROM must be an https:// address or a folder." ;; esac

  tmp="$(mktemp -d "${TMPDIR:-/tmp}/tasktap-install.XXXXXX")"
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM

  say "Downloading Tasktap's disk image ($IMAGE) and the release's SHA256SUMS from $from"
  fetch SHA256SUMS
  fetch "$IMAGE"
  want="$(awk -v n="$IMAGE" '$2 == n || $2 == "*" n { print $1 }' "$tmp/SHA256SUMS")"
  have="$(shasum -a 256 "$tmp/$IMAGE" | awk '{ print $1 }')"
  [ -n "$want" ] && [ "$want" = "$have" ] ||
    refuse "the disk image's SHA-256 is not the one SHA256SUMS lists, so it was not opened; try again later."
  say "Checked: the disk image's SHA-256 is the one the release lists ($have)."

  verdict="$(spctl --assess --type open --context context:primary-signature -vv "$tmp/$IMAGE" 2>&1)" || verdict=""
  case "$verdict" in
    *"source=Notarized Developer ID"*) ;;
    *) refuse "macOS does not accept the disk image as notarised by Apple, so it was not opened." ;;
  esac
  say "Checked: macOS accepts the disk image as notarised by Apple."

  mkdir "$tmp/image"
  hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$tmp/image" "$tmp/$IMAGE" </dev/null ||
    refuse "the disk image could not be opened."
  mounted=1
  app="$tmp/image/Tasktap.app"
  codesign --verify --deep --strict "$app" 2>/dev/null || refuse "the app's signature does not hold, so it was not installed."
  team="$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  [ -n "$TEAM_ID" ] || refuse "this script does not name Tasktap's team yet; download the disk image from https://github.com/HarzerHeribert/Tasktap/releases instead."
  [ "$team" = "$TEAM_ID" ] || refuse "the app is signed by the team $team, not by Tasktap's team $TEAM_ID, so it was not installed."
  say "Checked: the app's signature holds, and it is Tasktap's team's ($TEAM_ID)."

  if [ -n "${TASKTAP_INSTALL_TO:-}" ]; then dir="${TASKTAP_INSTALL_TO%/}"
  elif [ -w /Applications ]; then dir=/Applications
  else dir="$HOME/Applications"; fi
  say "Installing Tasktap.app into $dir"
  mkdir -p "$dir"
  stage="$(mktemp -d "$dir/.tasktap-install.XXXXXX")"
  ditto "$app" "$stage/Tasktap.app" || refuse "the app could not be copied into $dir."
  hdiutil detach -quiet "$tmp/image" && mounted=""
  # The copy there before is replaced only now, after the new one has passed every check.
  if [ -e "$dir/Tasktap.app" ]; then
    mv "$dir/Tasktap.app" "$stage/previous.app" ||
      refuse "the Tasktap.app already in $dir could not be replaced; update it from Settings > About instead."
  fi
  if ! mv "$stage/Tasktap.app" "$dir/Tasktap.app"; then
    if [ -e "$stage/previous.app" ]; then mv "$stage/previous.app" "$dir/Tasktap.app"; fi
    refuse "Tasktap.app could not be put into $dir."
  fi
  rm -rf "$stage"
  stage=""

  say "Installed: $dir/Tasktap.app. To remove it, quit Tasktap and move it to the Trash."
  if [ "${TASKTAP_INSTALL_NO_START:-}" = 1 ]; then
    say "Start Tasktap from Launchpad or Spotlight, or with: open \"$dir/Tasktap.app\""
  else
    open "$dir/Tasktap.app"
    say "Tasktap is starting. Next time, start it from Launchpad or Spotlight."
  fi
}

main "$@"
