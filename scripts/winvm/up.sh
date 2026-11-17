#!/bin/bash
set -eu
# shellcheck source=common.sh
source "$(dirname "$0")/common.sh"
if running; then
  :
elif [[ $? == 1 ]]; then
  "$vmrun" start "$vmx" nogui
else
  exit 1
fi
deadline=$((SECONDS + 240))
until ssh -o BatchMode=yes -o ConnectTimeout=4 tasktap-win 'exit 0' </dev/null 2>/dev/null; do
  if (( SECONDS >= deadline )); then
    echo 'Timed out waiting for key-authenticated SSH. Run status.sh.' >&2
    exit 1
  fi
  sleep 3
done
echo 'tasktap-win is ready over SSH.'
