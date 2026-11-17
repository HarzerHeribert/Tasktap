#!/bin/bash
# Create a new, powered-off VM after both installation discs have been prepared.
set -euo pipefail
lib='/Applications/VMware Fusion.app/Contents/Library'
root="$HOME/Virtual Machines.localized"
media="$root/tasktap-win-media"
vm="$root/tasktap-win.vmwarevm"
[[ $(uname -m) == arm64 && -f "$media/unattended-boot.iso" && -f "$media/seed.iso" ]] || { echo 'ARM Mac and both installation discs required' >&2; exit 1; }
[[ $(df -k "$root" | awk 'END {print $4}') -ge 97656250 ]] || { echo 'Less than 100 GB free' >&2; exit 1; }
memory=$(( $(sysctl -n hw.memsize) / 1048576 / 2 ))
(( memory <= 12288 )) || memory=12288
(( memory >= 4096 )) || { echo 'Half of host RAM is below the Windows minimum' >&2; exit 1; }
umask 077
mkdir "$vm"   # Refuse to replace an existing VM.
"$lib/vmcli" VM Create -n tasktap-win -d "$vm" -c arm-windows11-64
cd "$vm"
"$lib/vmware-vdiskmanager" -x 80GB tasktap-win.vmdk
sed -i '' -e 's/^numvcpus = .*/numvcpus = "6"/' -e "s/^memsize = .*/memsize = \"$memory\"/" tasktap-win.vmx
cat >> tasktap-win.vmx <<VMX
displayName = "tasktap-win"
firmware = "efi"
uefi.secureBoot.enabled = "TRUE"
cpuid.coresPerSocket = "6"
usb_xhci.present = "TRUE"
nvme0.present = "TRUE"
nvme0:0.present = "TRUE"
nvme0:0.fileName = "tasktap-win.vmdk"
ethernet0.present = "TRUE"
ethernet0.virtualDev = "vmxnet3"
ethernet0.connectionType = "nat"
ethernet0.addressType = "generated"
sata0.present = "TRUE"
sata0:0.present = "TRUE"
sata0:0.deviceType = "cdrom-image"
sata0:0.fileName = "$media/unattended-boot.iso"
sata0:1.present = "TRUE"
sata0:1.deviceType = "cdrom-image"
sata0:1.fileName = "$media/seed.iso"
sata0:2.present = "TRUE"
sata0:2.deviceType = "cdrom-image"
sata0:2.fileName = "$lib/isoimages/arm64/windows.iso"
bios.bootOrder = "hdd,cdrom"
isolation.tools.hgfs.disable = "TRUE"
VMX
echo 'In Fusion settings, enable partial encryption, save it in Keychain, and add a Trusted Platform Module before booting.'
