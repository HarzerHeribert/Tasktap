#!/bin/bash
set -eu
"$(dirname "$0")/up.sh"
exec ssh -t tasktap-win '
  $ErrorActionPreference = "Stop"
  $lock = [IO.File]::Open("C:\tasktap\checkout.lock", "OpenOrCreate", "ReadWrite", "None")
  try { pwsh -NoLogo -WorkingDirectory C:\tasktap\checkout } finally { $lock.Dispose() }
'
