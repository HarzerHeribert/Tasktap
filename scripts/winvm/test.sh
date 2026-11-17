#!/bin/bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
ref='' target=x86_64 repeat=0 test_name=''
usage() { echo 'usage: test.sh [ref] [--x64|--arm64] [--repeat N exact-test-name] [-- cargo-test-args...]' >&2; exit 2; }
while (($#)); do
  case $1 in
    --arm64) target=aarch64 ;;
    --x64) target=x86_64 ;;
    --repeat)
      [[ $# -ge 3 && $2 =~ ^[1-9][0-9]*$ && -n $3 ]] || usage
      repeat=$2; test_name=$3; shift 2 ;;
    --) shift; break ;;
    -*) usage ;;
    *) [[ -z $ref ]] || usage; ref=$1 ;;
  esac
  shift
done
sha=$(git rev-parse --verify --end-of-options "${ref:-HEAD}^{commit}")
"$here/up.sh"
# Immutable refs let several worktrees submit jobs without racing on a branch.
git push --no-follow-tags winvm "$sha:refs/tasktap/tests/$sha"
python3 - "$here/run.ps1" "$sha" "$target" "$repeat" "$test_name" "$@" <<'PY' | ssh -T -o BatchMode=yes tasktap-win '$j = [Console]::In.ReadToEnd() | ConvertFrom-Json; & ([scriptblock]::Create($j.script)) $j; exit $LASTEXITCODE'
import json, pathlib, sys
script, commit, target, repeat, name, *args = sys.argv[1:]
print(json.dumps(dict(script=pathlib.Path(script).read_text(), commit=commit, target=target,
                      repeat=int(repeat), name=name, args=args)))
PY
