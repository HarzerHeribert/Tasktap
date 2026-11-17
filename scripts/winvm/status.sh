#!/bin/bash
set -eu
# shellcheck source=common.sh
source "$(dirname "$0")/common.sh"
if running; then
  echo 'Running'
  "$vmrun" checkToolsState "$vmx"
  ssh -o BatchMode=yes -o ConnectTimeout=4 tasktap-win 'Write-Output "SSH ready"'
elif [[ $? == 2 ]]; then
  exit 1
elif [[ -f "${vmx%.vmx}.vmss" ]] || compgen -G "$(dirname "$vmx")/*.vmss" >/dev/null; then
  echo 'Suspended'
elif [[ -f "$vmx" ]]; then
  echo 'Powered off'
else
  echo 'VM configuration missing' >&2
  exit 1
fi
