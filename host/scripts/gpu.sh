#!/bin/bash
# host/scripts/gpu.sh: what Tasktap costs the graphics processor on this Mac (README.md, "What the graphics processor
# costs"), as scripts/winvm/gpu.sh measures it on Windows: the built app run as a person runs it, its window in front
# and uncovered, a minute in each state, read each second; a floor with no app before and after. It takes over the
# screen for about a quarter of an hour; nobody may touch the Mac meanwhile. scripts/gpu-round.cjs runs it.
#   host/scripts/gpu.sh [--seconds 60] [--effects full,still,off] [--size window|full] [--states rest,working,...]
#                       [--app PATH] [--core PATH] [--out DIR] [--force]
#   host/scripts/gpu.sh --print-powermetrics   the command the owner starts first in a second window, with his
#                                              password: the graphics power
#   host/scripts/gpu.sh --rest                 the proof alone: the floor and the app at rest (Home with and without
#                                              the caret, the notch); fails when the app at rest draws
#   host/scripts/gpu.sh --dry-run              starts nothing: whether a round could start now, the floor for five
#                                              seconds, what it would measure and for how long
#   host/scripts/gpu.sh --rehearse             every state for five seconds, to prove the round's mechanics on a Mac in
#                                              use (its figures mean nothing; what would refuse a round is only said)
#   host/scripts/gpu.sh --states rest,rest-unfocused,working --effects still,off --seconds 20
#                                              Still and Off at rest and working, about 5 minutes
#   host/scripts/gpu.sh --self-test            reads host/scripts/powermetrics-fixture.txt as it reads the log, holds
#                                              made-up rows to the guards and proves, with a made-up sampler, that
#                                              every way out ends the round (no screen, no app); and that another
#                                              program's WebKit (Playwright's) is not counted as the app's
# --app measures another build (its core with the fixture agent is found beside it, or named with --core), so that
# two builds can be compared. The table, samples.csv and what the app said go to --out/<time>
# (~/Library/Logs/tasktap-gpu-rounds by default), never into the repository.
set -u
root="$(cd "$(dirname "$0")/../.." && pwd)"
exec node "$root/scripts/gpu-round.cjs" "$@"
