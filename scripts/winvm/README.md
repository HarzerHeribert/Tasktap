# Windows test VM

Run these commands from the worktree containing the commit you want to test. Until the scripts are committed, use the absolute path to the original checkout’s `scripts/winvm/test.sh` when calling it from another worktree. It resolves `HEAD` in the caller’s current directory.

```sh
scripts/winvm/up.sh
scripts/winvm/test.sh
scripts/winvm/test.sh --arm64
scripts/winvm/test.sh HEAD~1 -- --test launch
scripts/winvm/test.sh --x64 --repeat 40 two_thoughts_launched_at_once_in_one_project_each_get_their_own_terminal -- --test launch
scripts/winvm/shell.sh
scripts/winvm/status.sh
scripts/winvm/down.sh
```

`test.sh` sends a committed revision to the VM's bare repository over SSH. It runs the Windows CI sequence in `core` with stable Rust, rustfmt, Clippy and Cargo. The default target is `x86_64-pc-windows-msvc`. Windows runs the resulting binaries under emulation. Use `--arm64` for native ARM64. The guest kernel and scheduler are ARM64 on both runs. A GitHub x64 runner still provides independent native-x64 coverage.

The checkout is `C:\tasktap\checkout`. Both architectures reuse `C:\tasktap\target`, with Cargo's target-specific subdirectories. Test runs and interactive shells acquire the same exclusive checkout lock. Close the active shell or finish the active test before starting another. Local edits on the Windows checkout block automated switches. Commit Mac worktree changes before testing. Plain `git push winvm my-branch` transfers a branch, and `test.sh my-branch` selects it for testing.

## Host and media

Use VMware Fusion on an Apple Silicon Mac with at least 100 GB of free space **before** fetching media. Keep the VM in `~/Virtual Machines.localized/tasktap-win.vmwarevm` and the private staging directory in its sibling `tasktap-win-media`. The VM uses six vCPUs, NAT, USB 3, an 80 GB sparse NVMe disk, and up to 12 GiB RAM capped at half the host's memory. Snapshots, suspend files, Cargo targets and installer caches consume additional host space.

On a fresh Mac, generate the dedicated key. Keep the private key and the rendered answer file outside Git.

```sh
umask 077
mkdir -p ~/.ssh
ssh-keygen -t ed25519 -f ~/.ssh/tasktap-winvm -C tasktap-winvm -N ''
```

For the original installation Fusion 26.0.0 selected Microsoft's en-US Windows 11 Pro ARM64 image, build 26100.4349. Its ESD SHA-256 was `c01b6f474c772093159b63fb3a168d2666556b223d288f67efc37c4fbaeddd25`. Fusion's catalog may select a newer refresh on a rebuild. Check its catalog digest and retain a SHA-256 manifest alongside the media.

```sh
lib='/Applications/VMware Fusion.app/Contents/Library'
here=$(cd scripts/winvm && pwd)
media="$HOME/Virtual Machines.localized/tasktap-win-media"
mkdir -p "$media" && cd "$media"
"$lib/vmw_esd2iso" getesdurl --edition Professional --lang en-us
"$lib/vmw_esd2iso" getesd --edition Professional --lang en-us
# Compare this SHA-1 with the catalog output before converting.
shasum ./*.esd
shasum -a 256 ./*.esd > SHA256SUMS
unzip -q "$lib/isoimages/arm64/drivers-arm64.zip" 'vmxnet3/*' 'wddmvideo/*'
"$lib/vmw_esd2iso" generateiso --esd "$(ls "$PWD"/*.esd)" \
  --drivers "$PWD/vmxnet3/Win10_1709/ARM64,$PWD/wddmvideo/Win10_1709/ARM64"
mkdir -p install-mount
image=$(ls "$PWD"/[0-9]*.iso)
shasum -a 256 "$image" >> SHA256SUMS
hdiutil attach -readonly -nobrowse -mountpoint "$PWD/install-mount" "$image"
python3 "$here/boot-iso.py" "$image" install-mount/efi/microsoft/boot/efisys_noprompt.bin unattended-boot.iso
hdiutil detach "$PWD/install-mount"
python3 "$here/make-seed.py" "$PWD"
"$here/create.sh"
```

The boot ISO uses Microsoft's no-keypress EFI loader. The seed disc contains the public SSH key, bootstrap script and rendered answer file. Windows Setup wipes disk 0 and creates the local administrator `tasktap`. Attach these discs only to the new, empty VM. The account password is stored under **Tasktap Windows VM local administrator** in the Mac login Keychain. The Fusion encryption password is a separate Keychain item. Windows is installed without a product key. The owner is responsible for a Windows licence.

Before first boot, enable **Settings → Encryption → Only the files needed to support a virtual TPM**, save the password in the login Keychain, then choose **Add Device → Trusted Platform Module → Add**. Start the VM. Windows installs itself, signs in once, installs VMware Tools and enables OpenSSH Server with public-key authentication. Bootstrap writes its log to `C:\Windows\Temp\tasktap-bootstrap.log`.

## SSH and Git

Install `vmrun.py` as `~/.ssh/tasktap-win-fusion` and `proxy.sh` as `~/.ssh/tasktap-win-proxy`, both mode 700. The proxy asks VMware Tools for the current NAT address at connection time. If Tools is restarting, it looks up this VM’s generated MAC in Fusion’s NAT DHCP leases. The helper reads the Fusion encryption password from Keychain and supplies it through a private terminal. Permit `/usr/bin/security` to read this VM's encryption item for unattended starts.

Place the following host entry before wildcard settings in `~/.ssh/config`.

```sshconfig
Host tasktap-win
  User tasktap
  HostKeyAlias tasktap-win
  IdentityFile ~/.ssh/tasktap-winvm
  IdentitiesOnly yes
  UserKnownHostsFile ~/.ssh/tasktap-win-known-hosts
  StrictHostKeyChecking yes
  ProxyCommand ~/.ssh/tasktap-win-proxy
```

The bootstrap publishes the Windows-generated **public** SSH host key through Fusion. Read it with `vmrun.py readVariable "$vmx" runtimeConfig guestinfo.tasktap.hostkey`, verify it is an ed25519 public key, and put `tasktap-win` followed by that key on one line in `~/.ssh/tasktap-win-known-hosts`. The stable alias keeps the host identity valid across DHCP changes.

The Git remote URL is `tasktap-win:C:/tasktap/repo.git`. The original Mac uses a conditional Git include for this repository's common Git directory and its linked worktrees. On a fresh clone, `git remote add winvm tasktap-win:C:/tasktap/repo.git` also makes the remote available to its worktrees.

## Provisioning and snapshots

Once SSH is available, detach installation media and remove the private seed ISO after powering off the guest. Take the powered-off `clean` snapshot before installing development tools. From the Mac, install the tools over SSH and reboot so Windows can finish the driver and SDK installations.

```sh
scp scripts/winvm/provision.ps1 tasktap-win:provision.ps1
ssh tasktap-win 'powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File provision.ps1'
ssh tasktap-win 'shutdown.exe /r /t 5'
```

Run a full build, then take the powered-off `tools` snapshot. Use Windows shutdown for a disk-only snapshot. Use `down.sh` for normal suspend between test runs.

```sh
vmx="$HOME/Virtual Machines.localized/tasktap-win.vmwarevm/tasktap-win.vmx"
scripts/winvm/vmrun.py listSnapshots "$vmx" showTree
scripts/winvm/vmrun.py snapshot "$vmx" tools
# Restore only after saving work. This discards later guest changes.
scripts/winvm/vmrun.py revertToSnapshot "$vmx" tools
scripts/winvm/up.sh
```

Restoring a snapshot rewinds the guest bare repository, checkout and build cache together. The next test pushes the requested Mac commit again.

The original `clean` snapshot predates the development tools and a later account password change. Its credential is stored in login Keychain under **Tasktap Windows VM local administrator (clean snapshot)**. After restoring that specific snapshot, sign in once and approve the staged local-subnet SSH firewall rule. Allow Windows to process its sign-in startup items. Newly created VMs apply this rule during bootstrap.

## Installed versions on the original VM

| Component | Verified version |
| --- | --- |
| Windows 11 Pro ARM64 | 24H2, build 26100.4349 |
| Fusion / VMware Tools | 26.0.0 / 13.1.0.0 |
| OpenSSH Server / PowerShell | 9.5p1 / 7.7.0 |
| WinGet / Git for Windows | 1.9.25200 / 2.56.0.windows.4 |
| Visual Studio Build Tools 2022 | 17.14.45, installation 17.14.37906.3 |
| MSVC toolset / cl.exe product version | 14.44.35207 / 14.44.35230.0 for ARM64 and x64 |
| Windows SDK include directory | 10.0.26100.0 |
| rustup / rustc / Cargo | 1.29.3 / 1.100.0 / 1.100.0 |
| Node.js LTS / WebView2 Runtime | 26.13.1 / 157.0.4341.60 |

`SHA256SUMS` in the private media folder records the Microsoft ESD and Fusion-generated Windows ISO. The same folder contains the local boot ISO and bundled Fusion driver checksums in `local-media.sha256` and `fusion-media.sha256`. Rustup's release manifest with component checksums is saved at `C:\tasktap\rust-toolchain-manifest.toml`. Cargo package checksums are in the tested commit's `core/Cargo.lock`.

## Smoke test results

These are wall times for the complete `test.sh` command at commit `4b6408f` on the original VM. The x64 cold run started with an empty Cargo target and registry cache. The branch had already been pushed. The first ARM64 run shared downloaded crates with x64.

| Target and run | Wall time | Result |
| --- | --- | --- |
| x64 cold | 5m 32s | 313 passed, 8 ignored |
| x64 warm | 2m 39s | 313 passed, 8 ignored |
| ARM64 first build | 4m 00s | 313 passed, 8 ignored |
| ARM64 warm | 4m 07s | 290 passed, 1 failed, 8 ignored before Cargo stopped |

The x64 launch test `two_thoughts_launched_at_once_in_one_project_each_get_their_own_terminal` passed all 40 isolated runs in 20.4 seconds total. The ARM64 warm failure was in `tens_of_megabytes_arrive_intact_through_a_slow_client_and_a_reconnect`. Its watchdog killed the core after 60 seconds and the reader reported an unexpected EOF at offset 6062289. The script returned Cargo's exit code 101. An immediate isolated rerun passed in 10.5 seconds end to end (1.35 seconds in the test harness). Full logs and timings are in the private media folder.
