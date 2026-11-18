#!/bin/bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=job.sh
source "$here/job.sh"
ref='' target=x86_64 repeat=0 test_name='' batch=0 console=1
usage() { echo 'usage: test.sh [ref] [--tower] [--no-polite|--polite] [--x64|--arm64] [--batch-agents] [--system-console] [--repeat N exact-test-name] [-- cargo-test-args...]' >&2; exit 2; }
while (($#)); do
  case $1 in
    --arm64) target=aarch64 ;;
    --x64) target=x86_64 ;;
    # The agents of the tests installed as npm installs a tool: a batch file around the program.
    --batch-agents) batch=1 ;;
    # Terminals in the console Windows came with: Microsoft's is not put beside the test core.
    --system-console) console=0 ;;
    --repeat)
      [[ $# -ge 3 && $2 =~ ^[1-9][0-9]*$ && -n $3 ]] || usage
      repeat=$2; test_name=$3; shift 2 ;;
    --) shift; break ;;
    -*) machine_option "$1" || usage ;;
    *) [[ -z $ref ]] || usage; ref=$1 ;;
  esac
  shift
done
sha=$(git rev-parse --verify --end-of-options "${ref:-HEAD}^{commit}")
submit "$here/run.ps1" "$sha" "target=$target" "repeat=$repeat" "name=$test_name" "batch=$batch" "console=$console" -- "$@"
