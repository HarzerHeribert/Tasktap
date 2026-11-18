#!/bin/bash
# The align, type and composer checks at every text size (the core's `text_size`: small, default, large) and at window
# widths 720, 1180 and 1800: nothing may clip, wrap badly or come out of line at any of them. The align check measures
# at its own widths (720, 1180, 1480, 1800) in one run. The three sizes run side by side; ui/dist must be built, and
# must not be built again while this runs. Prints each check's last line; exits non-zero when any failed.
# usage: scripts/text-sizes.sh
cd "$(dirname "$0")/.." || exit 1
out="$(mktemp -d)"
for text in small default large; do
  (
    TEXT=$text node scripts/align-check.cjs > "$out/$text-align" 2>&1
    for width in 720 1180 1800; do
      TEXT=$text WIDTH=$width node scripts/type-check.cjs > "$out/$text-type-$width" 2>&1
      TEXT=$text WIDTH=$width node scripts/composer-check.cjs > "$out/$text-composer-$width" 2>&1
    done
  ) &
done
wait
fails=0
for log in "$out"/*; do
  last="$(tail -1 "$log")"
  case "$last" in PASS*) ;; *) fails=$((fails + 1)); grep '^FAIL' "$log" | sed "s/^/  /" ;; esac
  echo "$(basename "$log"): $(echo "$last" | cut -c1-90)"
done
rm -rf "$out"
[ "$fails" = 0 ] && echo "PASS  the align, type and composer checks at small, default and large text, at 720, 1180 and 1800 px" || echo "FAIL  text sizes: $fails runs failed"
exit "$fails"
