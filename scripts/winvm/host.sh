#!/bin/bash
# Builds and checks the host in the Windows VM, as test.sh does for the core: pushes a commit,
# then runs host.ps1 there (format, the pages, the core and the host by host/scripts/build.ps1,
# Clippy, the host's tests, the runnable folder and its zip). With --run it then starts the
# built app there for a few seconds, driven through its debug channel; over SSH there is no
# desktop, so that says only how far the app gets without one (README, "At the desktop").
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
ref='' target=x86_64 run=0
usage() { echo 'usage: host.sh [ref] [--x64|--arm64] [--run]' >&2; exit 2; }
while (($#)); do
  case $1 in
    --arm64) target=aarch64 ;;
    --x64) target=x86_64 ;;
    --run) run=1 ;;
    -*) usage ;;
    *) [[ -z $ref ]] || usage; ref=$1 ;;
  esac
  shift
done
sha=$(git rev-parse --verify --end-of-options "${ref:-HEAD}^{commit}")
"$here/up.sh"
git push --no-follow-tags winvm "$sha:refs/tasktap/tests/$sha"
python3 - "$here/host.ps1" "$sha" "$target" "$run" <<'PY' | ssh -T -o BatchMode=yes tasktap-win '$j = [Console]::In.ReadToEnd() | ConvertFrom-Json; & ([scriptblock]::Create($j.script)) $j; exit $LASTEXITCODE'
import json, pathlib, sys
script, commit, target, run = sys.argv[1:]
print(json.dumps(dict(script=pathlib.Path(script).read_text(), commit=commit, target=target, run=int(run))))
PY
