#!/usr/bin/env bash
# The last run of "Verify and publish Tasktap" on GitHub for this branch (or the one named): each job with how it
# ended and, for a job that failed, the steps that failed. Exits 0 when every job passed or was skipped, 1 when any
# failed or was cancelled, 2 while the run is still going or when there is none. A push is finished when this says 0
# for the commit that was pushed (it says when the run is of another commit). Each job says how long it took; with
# --steps, so does each of its steps.
# usage: scripts/ci.sh [--steps] [branch]
set -euo pipefail
steps=false
[ "${1:-}" = --steps ] && steps=true && shift
branch="${1:-$(git rev-parse --abbrev-ref HEAD)}"
run="$(gh run list --branch "$branch" --workflow verify-and-publish.yml --limit 1 \
  --json databaseId,headSha,status,conclusion,displayTitle,url --jq '.[0] // empty')"
if [ -z "$run" ]; then
  echo "no run of the workflow for $branch"
  exit 2
fi
field() { jq -r ".$1" <<< "$run"; }
id="$(field databaseId)" sha="$(field headSha)"
echo "run $id of ${sha:0:7} on $branch: $(field status) $(field conclusion) - $(field displayTitle)"
echo "$(field url)"
here="$(git rev-parse --verify --quiet "refs/remotes/origin/$branch" 2>/dev/null || git rev-parse HEAD)"
[ "$sha" = "$here" ] || echo "NOTE  this run is of ${sha:0:7}, not of ${here:0:7}, the branch as this checkout last saw it"
gh run view "$id" --json jobs | jq -r --argjson steps "$steps" '
  def took: if .startedAt and .completedAt and .completedAt != "0001-01-01T00:00:00Z"
    then " (" + (((.completedAt | fromdate) - (.startedAt | fromdate)) | tostring) + " s)" else "" end;
  .jobs[] |
  (if .conclusion == "success" then "PASS"
   elif .conclusion == "skipped" then "SKIP"
   elif .conclusion == "" or .conclusion == null then "...."
   else "FAIL" end) + "  " + .name + (if .status != "completed" then " (" + .status + ")" else took end),
  (.steps[] | select($steps or .conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out")
    | "        " + (if .conclusion == "success" then "" elif .conclusion == "skipped" then "skipped " else "step: " end) + .name + took)'
[ "$(field status)" = completed ] || exit 2
case "$(field conclusion)" in
  success|skipped) exit 0 ;;
  *) exit 1 ;;
esac
