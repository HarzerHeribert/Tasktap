#!/usr/bin/env bash
# The evaluation of model routing (design §8, "Proof before default").
#
# Each thought of core/scripts/route-eval.json is routed and briefed as the
# core does it for a capture: one headless call of the agent installed and
# signed in on this computer, on the person's own subscription. So this is
# never part of the automated suite, and a run costs as many short calls as
# the fixture has thoughts (14), times --runs.
#
#   core/scripts/route-eval.sh --tool claude [--runs N] [--only NAME,NAME] [--briefs]
#   core/scripts/route-eval.sh --tool codex
#   core/scripts/route-eval.sh --question NAME     the question as it is sent; asks nobody
#
# Per thought it prints: the destination, right or wrong; how many of the
# facts a good brief must have are in it; what it has that the person never
# said; the time the call took. --briefs prints the briefs as well, which is
# how they are judged in the end: by reading them.
#
# The tool runs in a temporary folder with the environment the core gives
# it; nothing is written to ~/.claude or ~/.codex, and no session is saved.
set -euo pipefail
cd "$(dirname "$0")/.."
exec cargo run --quiet --example route-eval -- scripts/route-eval.json "$@"
