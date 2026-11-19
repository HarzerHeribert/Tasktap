#!/usr/bin/env bash
# Live runs of the real agents through the core (design §14 D).
#
# Each run starts the real agent, installed and signed in on this computer,
# for a few short turns on the person's own subscription, so this is never
# part of the automated suite: the tests in core/tests/live.rs are ignored
# by default and run only from here.
#
#   claude  a new run whose question is answered from the core, a follow-up
#           whose question is answered in the terminal, a resume (3 turns)
#   codex   a new run, a follow-up, a resume (3 turns)
#   agy     Antigravity: a new run whose question is answered in the terminal,
#           a follow-up, a resume (3 turns, on its smallest model)
#   pi      Pi: a new run whose question, asked in the dialog of an extension
#           the test gives it, is answered in the terminal, a follow-up, a
#           resume (3 turns). Pi runs on whichever provider it is signed in
#           with, so this one is told: TASKTAP_LIVE_PI_MODEL=provider/model,
#           with that provider's key in the environment; skipped without
#   opencode  a new run whose question is answered from the core, a follow-up
#           whose approval is given from the core, a resume whose approval is
#           given in the terminal (3 turns, on a model that costs nothing)
#   qwen    Qwen Code: a new run whose request to run a command is shown and
#           answered in its terminal, a follow-up, a resume (3 turns)
#   goose   Goose: a run of one task, and a follow-up that goes on in a new
#           run (2 turns)
#   crush   Crush: the same (2 turns)
#   droid   Droid: the same, the end of its turn read from its transcript (2 turns)
#           These four run in a home of their own that the test makes, never
#           in the person's, and only when told where the program is and
#           given a service's key in the environment; none is among the runs
#           without a name:
#             qwen   TASKTAP_LIVE_QWEN=<program> TASKTAP_LIVE_QWEN_MODEL=<model>
#                    OPENAI_API_KEY and OPENAI_BASE_URL (an OpenAI-compatible service)
#             goose  TASKTAP_LIVE_GOOSE=<program> GOOSE_PROVIDER GOOSE_MODEL and
#                    that provider's key
#             crush  TASKTAP_LIVE_CRUSH=<program> TASKTAP_LIVE_CRUSH_MODEL=<provider/model>
#                    and that provider's key
#             droid  TASKTAP_LIVE_DROID=<program> TASKTAP_LIVE_DROID_MODEL=<model id>
#                    TASKTAP_LIVE_DROID_SETTINGS=<a settings.json with that model>, and its key
#   alone   a Codex run with no client attached to its terminal (1 turn)
#   trust   Claude Code in a folder it has not seen asks, through the core, to be
#           trusted there; left unanswered (no turn)
#   loop    the loop check with Claude Code as its agent (1 turn)
#
# Usage: core/scripts/live-agents.sh [claude] [codex] [agy] [pi] [opencode] [qwen] [goose] [crush] [droid] [alone] [trust] [loop]
#        (none: the eight that run on this computer's own accounts)
#
# Tasktap writes nothing to ~/.claude, ~/.codex or ~/.gemini: hooks and
# settings go on each run's command line. Antigravity keeps each run's
# conversation in the person's history, as it does for every run, and so
# does OpenCode (`opencode session list` in the project, `opencode session
# delete <id>`); its runs have a server of their own, which is told here, for
# these runs alone, to ask before a shell command and which model to use
# (TASKTAP_LIVE_OPENCODE_MODEL, one of `opencode models`). Pi runs
# with a temporary home, so it keeps its sessions there and reads none of
# the person's settings or skills. The project is a throwaway git repository at
# $TMPDIR/tasktap-live-agents/project (TASKTAP_LIVE_PROJECT moves it), made
# anew each time at the same place, so that Claude Code, which asks once
# whether to trust a folder, asks about that one only. Each run's core has a
# new temporary data folder and is stopped at the end.
set -euo pipefail
cd "$(dirname "$0")/.."

# name -> test, agent, turns
run_of() {
  case "$1" in
    claude) echo "claude_runs_asks_follows_up_and_resumes claude 3" ;;
    codex) echo "codex_runs_follows_up_and_resumes codex 3" ;;
    agy) echo "antigravity_runs_asks_follows_up_and_resumes agy 3" ;;
    pi) echo "pi_runs_asks_follows_up_and_resumes pi 3" ;;
    opencode) echo "opencode_runs_asks_follows_up_and_resumes opencode 3" ;;
    qwen) echo "qwen_runs_asks_follows_up_and_resumes qwen 3" ;;
    goose) echo "goose_runs_one_task_and_goes_on_in_a_new_run goose 2" ;;
    crush) echo "crush_runs_one_task_and_goes_on_in_a_new_run crush 2" ;;
    droid) echo "droid_runs_one_task_and_goes_on_in_a_new_run droid 2" ;;
    alone) echo "codex_runs_with_no_window codex 1" ;;
    trust) echo "claude_in_a_new_folder_asks_to_be_trusted_there claude 0" ;;
    loop) echo "the_loop_on_claude claude 1" ;;
    *) return 1 ;;
  esac
}

[ $# -eq 0 ] && set -- claude codex agy pi opencode alone trust loop
for name in "$@"; do
  run_of "$name" >/dev/null || { echo "live-agents: no run called $name (claude, codex, agy, pi, opencode, qwen, goose, crush, droid, alone, trust, loop)" >&2; exit 64; }
done

echo "live-agents: the agents on this computer"
for agent in claude codex agy pi opencode; do
  if command -v "$agent" >/dev/null; then
    echo "  $agent $("$agent" --version 2>&1 | head -1)"
  else
    echo "  $agent: not installed"
  fi
done

cargo test --quiet --test live --no-run
logs=$(mktemp -d "${TMPDIR:-/tmp}/tasktap-live-logs.XXXXXX")
failed=0
for name in "$@"; do
  read -r test agent turns <<<"$(run_of "$name")"
  # A tool run in a home of its own is found where its variable says.
  own=
  case "$name" in
    qwen) own=TASKTAP_LIVE_QWEN ;;
    goose) own=TASKTAP_LIVE_GOOSE ;;
    crush) own=TASKTAP_LIVE_CRUSH ;;
    droid) own=TASKTAP_LIVE_DROID ;;
  esac
  if [ -n "$own" ] && [ -z "${!own:-}" ]; then
    echo "live-agents: $name skipped, $own names no program"
    continue
  fi
  if [ -z "$own" ] && ! command -v "$agent" >/dev/null; then
    echo "live-agents: $name skipped, $agent is not installed"
    continue
  fi
  if [ "$name" = pi ] && [ -z "${TASKTAP_LIVE_PI_MODEL:-}" ]; then
    echo "live-agents: pi skipped, TASKTAP_LIVE_PI_MODEL names no model"
    continue
  fi
  log="$logs/$name.log"
  echo
  echo "live-agents: $name runs $agent for $turns short turn(s); the full log is $log"
  start=$SECONDS
  if [ "$name" = opencode ] && [ -z "${OPENCODE_CONFIG_CONTENT:-}" ]; then
    model=${TASKTAP_LIVE_OPENCODE_MODEL:-opencode/deepseek-v4.1-flash-free}
    export OPENCODE_CONFIG_CONTENT="{\"model\":\"$model\",\"permissions\":[{\"action\":\"shell\",\"resource\":\"*\",\"effect\":\"ask\"}]}"
  fi
  if cargo test --quiet --test live -- --ignored --nocapture --exact "$test" >"$log" 2>&1; then
    result=passed
  else
    result=FAILED
    failed=1
  fi
  grep '^live: ' "$log" | sed 's/^live: /  /' | cut -c1-240 || true
  grep -E 'panicked|assertion' "$log" | sed 's/^/  /' | cut -c1-400 || true
  echo "live-agents: $name $result in $((SECONDS - start)) s"
done
exit $failed
