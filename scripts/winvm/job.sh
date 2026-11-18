# Sourced by test.sh and host.sh: which Windows machine a run goes to, and how a job gets there.
# The VM is the default. The tower (--tower) is a person's PC that may be in use: a run there
# takes half the cores at low priority unless --no-polite is given (--polite asks the VM for
# the same). Both keep the same folders: C:\tasktap\repo.git, checkout and target.
machine=vm polite=''
machine_option() {
  case $1 in
    --vm) machine=vm ;;
    --tower) machine=tower ;;
    --polite) polite=1 ;;
    --no-polite) polite=0 ;;
    *) return 1 ;;
  esac
}

# submit SCRIPT.ps1 COMMIT [name=value ...] [-- arguments...]: pushes the commit to the machine
# and runs the script there with those values as its job.
submit() {
  local script=$1 sha=$2 host remote
  shift 2
  if [[ $machine == tower ]]; then
    host=tasktap-tower remote=tasktap-tower:C:/tasktap/repo.git
    : "${polite:=1}"
  else
    host=tasktap-win remote=winvm
    : "${polite:=0}"
    "$here/up.sh"
  fi
  # Immutable refs let several worktrees submit jobs without racing on a branch.
  git push --no-follow-tags "$remote" "$sha:refs/tasktap/tests/$sha"
  python3 - "$script" "commit=$sha" "polite=$polite" "$@" <<'PY' | ssh -T -o BatchMode=yes "$host" '$j = [Console]::In.ReadToEnd() | ConvertFrom-Json; & ([scriptblock]::Create($j.script)) $j; exit $LASTEXITCODE'
import json, pathlib, sys
script, *rest = sys.argv[1:]
cut = rest.index('--') if '--' in rest else len(rest)
job = dict(pair.split('=', 1) for pair in rest[:cut])
job = {k: int(v) if v.isdigit() and k != 'commit' else v for k, v in job.items()}
script = pathlib.Path(script)
text = script.with_name('checkout.ps1').read_text() + script.read_text()
print(json.dumps(dict(job, script=text, args=rest[cut + 1:])))
PY
}
