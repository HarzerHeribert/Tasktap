#!/usr/bin/env bash
# The experiment of docs/projects-design.md ("Experiments"), run through the
# real placing code: every project of core/scripts/place-eval.json as a project
# Tasktap knows, every thought placed as a capture is with no model agreed to,
# at 36, 100 and 306 projects. Invented names only; it asks nobody and writes
# nothing.
#
#   core/scripts/place-eval.sh           the table
#   core/scripts/place-eval.sh --each    every thought's outcome at 306 too
set -euo pipefail
cd "$(dirname "$0")/.."
exec cargo run --quiet --release --example place-eval -- scripts/place-eval.json "$@"
