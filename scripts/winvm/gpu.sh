#!/bin/bash
# What Tasktap costs the graphics processor, measured on the tower as a person runs it (README.md, "What the graphics
# processor costs"): the app's window on the screen, a minute in each state, the card watched every second and the
# round stopped at once when it is pressed (gpu.ps1 says how). It builds the app at the commit (host.sh --tower), has
# gpu.ps1 run there in the test account's desktop through the tower's desktop helper, and fetches the table and the
# second-by-second samples into a folder outside the repository.
#   scripts/winvm/gpu.sh [ref] [--out DIR] [--no-build] [--size window|full] [--effects full,still,off]
#                        [--lumen on,off] [--states rest,working,...] [--seconds 60]
#   scripts/winvm/gpu.sh --rest        the proof alone: the floor and the app at rest on Home, a minute each; fails
#                                      when the app at rest uses the graphics processor at all
#   scripts/winvm/gpu.sh --dry-run     over SSH alone: whether the screen shows the test account's unlocked desktop,
#                                      whether the card and the counters can be read, what the round would measure;
#                                      starts nothing
#   scripts/winvm/gpu.sh --rehearse    in the VM, over SSH, with no desktop: every state driven for a few seconds, to
#                                      prove the round's mechanics (its figures mean nothing there)
# A round stays under a quarter of an hour; gpu.ps1 refuses one that would not.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
ref='' out='' build=1 dry=0 rehearse=0 args=''
usage() { echo 'usage: gpu.sh [ref] [--out DIR] [--no-build] [--size window|full] [--effects full,still,off] [--lumen on,off] [--states rest,working,...] [--seconds 60] [--rest] [--dry-run|--rehearse]' >&2; exit 2; }
while (($#)); do
  case $1 in
    --out) [[ $# -ge 2 ]] || usage; out=$2; shift ;;
    --size) [[ $# -ge 2 && $2 =~ ^(window|full)$ ]] || usage; args+=" -Size $2"; shift ;;
    --effects) [[ $# -ge 2 && $2 =~ ^(full|still|off)(,(full|still|off))*$ ]] || usage; args+=" -Effects ${2//,/:}"; shift ;;
    --lumen) [[ $# -ge 2 && $2 =~ ^(on|off)(,(on|off))?$ ]] || usage; args+=" -Lumen ${2//,/:}"; shift ;;
    --states) [[ $# -ge 2 && $2 =~ ^[a-z,-]+$ ]] || usage; args+=" -States ${2//,/:}"; shift ;;
    --seconds) [[ $# -ge 2 && $2 =~ ^[0-9]+$ ]] || usage; args+=" -Seconds $2"; shift ;;
    --rest) args+=' -States rest' ;;
    --no-build) build=0 ;;
    --dry-run) dry=1 ;;
    --rehearse) rehearse=1 ;;
    -*) usage ;;
    *) [[ -z $ref ]] || usage; ref=$1 ;;
  esac
  shift
done
stamp=$(date +%Y%m%d-%H%M%S)
out=${out:-${TMPDIR:-/tmp}/tasktap-gpu-round}
script='C:\tasktap\checkout\scripts\winvm\gpu.ps1'
run="pwsh -NoProfile -File $script -Out C:\\tasktap\\gpu-rounds\\$stamp$args"
host=tasktap-tower
status=0
if ((dry)); then
  # This worktree's copy, beside the checkout (which may be at a commit that has none, and is not changed for this),
  # asked about the app the checkout last built.
  dry='C:\tasktap\gpu-rounds\dry-run'
  ssh -T -o BatchMode=yes "$host" "New-Item -ItemType Directory -Force $dry | Out-Null"
  scp -q "$here/gpu.ps1" "$here/sounds.ps1" "$host:${dry//\\//}/"
  ssh -T -o BatchMode=yes "$host" "pwsh -NoProfile -File $dry\\gpu.ps1 -Checkout C:\\tasktap\\checkout -Out C:\\tasktap\\gpu-rounds\\$stamp$args -DryRun" || status=$?
elif ((rehearse)); then
  # The VM: nobody uses it and it has no desktop for a script. Its x64 build, run emulated: its ARM64 host does not
  # build there (ring wants clang for aarch64-pc-windows-msvc, which the VM lacks; seen 2026-11-19).
  host=tasktap-win
  "$here/host.sh" ${ref:+"$ref"} --vm --x64 --gpu "$stamp" --gpu-args "$args -Target x86_64 -Rehearse" || status=$?
elif ((build)); then
  # One job builds and then runs the round, holding the checkout throughout: other worktrees send jobs there too.
  "$here/host.sh" ${ref:+"$ref"} --tower --gpu "$stamp" ${args:+--gpu-args "$args"} || status=$?
else
  # The app the checkout last built, and the round's own lock; it refuses a checkout another job has moved meanwhile.
  run+=" -Commit $(git rev-parse --verify --end-of-options "${ref:-HEAD}^{commit}")"
  ssh -T -o BatchMode=yes "$host" "C:\\tasktap\\desk.ps1 -TimeoutSeconds 1200 -CommandLine '$run'" || status=$?
fi
mkdir -p "$out"
scp -q -r "$host:C:/tasktap/gpu-rounds/$stamp" "$out/" || echo "Nothing to fetch from gpu-rounds\\$stamp" >&2
[[ -f $out/$stamp/table.txt ]] && cat "$out/$stamp/table.txt"
echo "The table and the samples: $out/$stamp"
exit $status
