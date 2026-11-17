# Sourced by the Fusion lifecycle scripts.
vmrun="$(dirname "$0")/vmrun.py"
vmx=${TASKTAP_VMX:-"$HOME/Virtual Machines.localized/tasktap-win.vmwarevm/tasktap-win.vmx"}
running() {
  local list
  list=$("$vmrun" list) || return 2
  grep -Fxq "$vmx" <<< "$list"
}
