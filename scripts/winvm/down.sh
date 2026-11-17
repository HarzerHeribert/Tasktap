#!/bin/bash
set -eu
# shellcheck source=common.sh
source "$(dirname "$0")/common.sh"
if running; then
  "$vmrun" suspend "$vmx" soft
else
  [[ $? == 1 ]]
fi
