#!/bin/bash
# The desktop round on the tower: what README.md, "At the desktop", asks for and a script can
# do, run unattended in the test account's signed-in desktop once its owner has switched the
# screen to that account. It builds the app at the commit (host.sh --tower), has desktop.ps1 run
# there through the tower's desktop helper, and fetches the results and the pictures of the
# app's own window into a folder outside the repository.
#   scripts/winvm/desktop.sh [ref] [--out DIR] [--no-build] [--rows 3,14]
#   scripts/winvm/desktop.sh --dry-run    over SSH alone: says what each row would do, starts nothing,
#                                         and fetches that as the round's results would be fetched
# --rows runs those rows alone. The round makes no sound (desktop.ps1 says how).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
ref='' out='' build=1 dry=0 rows=''
usage() { echo 'usage: desktop.sh [ref] [--out DIR] [--no-build] [--rows 3,14] [--dry-run]' >&2; exit 2; }
while (($#)); do
  case $1 in
    --out) [[ $# -ge 2 ]] || usage; out=$2; shift ;;
    --rows) [[ $# -ge 2 && $2 =~ ^[0-9+,]+$ ]] || usage; rows=$2; shift ;;
    --no-build) build=0 ;;
    --dry-run) dry=1 ;;
    -*) usage ;;
    *) [[ -z $ref ]] || usage; ref=$1 ;;
  esac
  shift
done
script='C:\tasktap\checkout\scripts\winvm\desktop.ps1'
stamp=$(date +%Y%m%d-%H%M%S)
out=${out:-${TMPDIR:-/tmp}/tasktap-desktop-round}
run="pwsh -NoProfile -File $script -Out C:\\tasktap\\desktop-rounds\\$stamp${rows:+ -Rows $rows}"
status=0
if ((dry)); then
  # The checkout's copy, as the round would run it: of the commit last built or tested there.
  ssh -T -o BatchMode=yes tasktap-tower "$run -DryRun" || status=$?
else
  ((build)) && "$here/host.sh" ${ref:+"$ref"} --tower
  ssh -T -o BatchMode=yes tasktap-tower "C:\\tasktap\\desk.ps1 -TimeoutSeconds 1500 -CommandLine '$run'" || status=$?
fi
mkdir -p "$out"
scp -q -r "tasktap-tower:C:/tasktap/desktop-rounds/$stamp" "$out/" || echo "Nothing to fetch from the tower's desktop-rounds\\$stamp" >&2
echo "Results and pictures: $out/$stamp"
exit $status
