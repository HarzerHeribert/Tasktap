#!/usr/bin/env bash
# Live runs of Claude Code, Codex, Antigravity and OpenCode through the core (design §14 D).
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
#   alone   a Codex run with no client attached to its terminal (1 turn)
#   trust   Claude Code in a folder it has not seen asks, through the core, to be
#           trusted there; left unanswered (no turn)
#   loop    the loop check with Claude Code as its agent (1 turn)
#
# Usage: core/scripts/live-agents.sh [claude] [codex] [agy] [pi] [opencode] [alone] [trust] [loop]   (none: all eight)
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
    alone) echo "codex_runs_with_no_window codex 1" ;;
    trust) echo "claude_in_a_new_folder_asks_to_be_trusted_there claude 0" ;;
    loop) echo "the_loop_on_claude claude 1" ;;
    *) return 1 ;;
  esac
}

[ $# -eq 0 ] && set -- claude codex agy pi opencode alone trust loop
for name in "$@"; do
  run_of "$name" >/dev/null || { echo "live-agents: no run called $name (claude, codex, agy, pi, opencode, alone, trust, loop)" >&2; exit 64; }
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
  if ! command -v "$agent" >/dev/null; then
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
