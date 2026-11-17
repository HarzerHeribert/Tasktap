#!/bin/bash
# Resolve each connection independently. SSH verifies the VM's pinned host key.
set -eu
vmx=${TASKTAP_VMX:-"$HOME/Virtual Machines.localized/tasktap-win.vmwarevm/tasktap-win.vmx"}
ip=$("$HOME/.ssh/tasktap-win-fusion" getGuestIPAddress "$vmx") || {
  # Tools can be unavailable while Windows replaces a driver or awaits reboot.
  ip=$(python3 - "$vmx" <<'PY'
import pathlib, re, sys
vmx = pathlib.Path(sys.argv[1]).read_text()
mac = re.search(r'^ethernet0.generatedAddress = "([^"]+)"', vmx, re.M)[1].lower()
leases = pathlib.Path('/var/db/vmware/vmnet-dhcpd-vmnet8.leases').read_text().lower()
for address, body in reversed(re.findall(r'lease ([\d.]+) \{([^}]+)', leases)):
    if f'hardware ethernet {mac};' in body:
        print(address)
        break
else:
    sys.exit("Fusion has no NAT lease for the VM's network adapter")
PY
)
}
exec /usr/bin/nc -G 5 "$ip" 22
