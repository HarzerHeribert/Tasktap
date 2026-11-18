# Windows test machines

Two machines run the Windows checks, through the same scripts and the same folders (`C:\tasktap\repo.git`, `checkout`, `target`):

| | The VM (the default) | The tower (`--tower`) |
| --- | --- | --- |
| What it is | Windows 11 ARM64 in VMware Fusion on this Mac; x64 programs run emulated | A person's PC: Windows 11 x64 on real hardware, reached as `tasktap-tower` |
| Good for | Both architectures; snapshots to go back to; nobody to disturb; an administrator account | Native x64 and its timing; a standard account, as most people have; a real desktop when its owner hands it over |
| Cannot | Show a desktop to a script; time x64 as hardware does | Build or run ARM64; run when it is switched off; be changed (no administrator) |
| Manners | None needed | Shared with a person: half the cores at low priority, nothing on the screen (below) |

Run these commands from the worktree containing the commit you want to test. Until the scripts are committed, use the absolute path to the original checkout’s `scripts/winvm/test.sh` when calling it from another worktree. It resolves `HEAD` in the caller’s current directory.

```sh
scripts/winvm/up.sh
scripts/winvm/test.sh
scripts/winvm/test.sh --arm64
scripts/winvm/test.sh --arm64 --batch-agents
scripts/winvm/test.sh HEAD~1 -- --test launch
scripts/winvm/test.sh --x64 --repeat 40 two_thoughts_launched_at_once_in_one_project_each_get_their_own_terminal -- --test launch
scripts/winvm/host.sh --arm64
scripts/winvm/host.sh --x64 --run
scripts/winvm/test.sh --tower
scripts/winvm/test.sh --tower --batch-agents --system-console
scripts/winvm/host.sh --tower --run
scripts/winvm/desktop.sh --dry-run
scripts/winvm/shell.sh
scripts/winvm/status.sh
scripts/winvm/down.sh
```

`test.sh` sends a committed revision to the machine's bare repository over SSH. It runs the Windows CI sequence in `core` with stable Rust, rustfmt, Clippy and Cargo; the suite runs with `--no-fail-fast`, so a failing test file never keeps the ones after it from running. The default target is `x86_64-pc-windows-msvc`. Windows runs the resulting binaries under emulation. Use `--arm64` for native ARM64. The guest kernel and scheduler are ARM64 on both runs. A GitHub x64 runner still provides independent native-x64 coverage.

The checkout is `C:\tasktap\checkout`. Both architectures reuse `C:\tasktap\target`, with Cargo's target-specific subdirectories. Test runs and interactive shells acquire the same exclusive checkout lock. Close the active shell or finish the active test before starting another. Local edits on the Windows checkout block automated switches. Commit Mac worktree changes before testing. Plain `git push winvm my-branch` transfers a branch, and `test.sh my-branch` selects it for testing.

`host.sh` does for the host what `test.sh` does for the core: format, the pages, the core and the host by `host/scripts/build.ps1`, Clippy, the host's tests, and the runnable folder `C:\tasktap\checkout\host\target\<target>-pc-windows-msvc\release\Tasktap Next` with its zip. It builds inside the checkout (`host\target`, `ui\node_modules`), not in `C:\tasktap\target`. With `--run` it then starts the app for a few seconds through `host/scripts/smoke.ps1`. Over SSH that gets surprisingly far (2026-11-18, both architectures): the core starts, the host reaches it over its pipe, WebView2 runs the workspace page, a folder becomes a workspace, New Terminal starts `cmd.exe` in it and `set /a 6*7` typed into it answers 42. Two things differ from a desktop there. The capture shortcut cannot be registered (`{"event":"capture-key","ok":false}`). And the app does not end when told to quit or when its window closes: it takes the request (`{"event":"quitting"}`) and its event loop never finishes, so the script ends it and says so in a `NOTE` line. Whether that is the missing desktop or a defect is the first thing to look at in row 1 below.

`--batch-agents` runs the core's suite with the tests' agents installed the way npm installs a tool on Windows, as a batch file around the program (`TASKTAP_TEST_BATCH_AGENTS`, `core/tests/common`): finding, launching, adopting, asking and stopping them then all go through the command prompt.

Both scripts put Microsoft's console (`conpty.dll`, `OpenConsole.exe`; `core/scripts/conpty.ps1` downloads the pinned package from nuget.org into `core\target\conpty` and checks it) beside the core they test or bundle, and `test.sh` takes it out of the shared build folder again when it is done. `--system-console` leaves it out: the terminals of that run are in the console Windows came with.

## The tower

`--tower` sends a job to the PC instead of the VM (`job.sh` holds the difference: the SSH alias, where the commit is pushed, and the manners). The Mac's SSH configuration has to know `tasktap-tower`; the scripts name nothing else of that machine, and its own notes are in `C:\tasktap\README.md` there. What is different from the VM:

- **A person uses it.** A job there runs at priority BelowNormal, which every process it starts inherits, and on half the logical cores (`CARGO_BUILD_JOBS` and `RUST_TEST_THREADS`). `--no-polite` lifts both, for when the machine is free; `--polite` asks the VM for the same. Over SSH nothing can appear on the screen: the session has no desktop. Never start anything there through `C:\tasktap\desk.ps1` unless its owner has handed the desktop over, never change its settings, and never leave a build looping.
- **The account is a standard one**, and signed in over SSH it is refused by Windows Management Instrumentation: `taskkill`, `tasklist`, `Get-CimInstance Win32_Process` and `Get-Process -IncludeUserName` all answer "Access denied". Nothing in the core, the tests or the scripts may need them. That refusal is what the tower found on its first day: a shim ended its agent with `taskkill`, which the VM's administrator account never noticed (13 failures of 13 runs of one test there, none since the shim ends its agent through a job). A process's own path, start time and parent are still readable for the account's own processes, and only for those.
- **x64 only.** Its Build Tools have no ARM64 compiler or linker, so `--arm64` stops with "C++ Build Tools (ARM64) missing"; adding them needs an administrator.
- **The checkout is a clone** of the bare repository, not a worktree of it, so a job fetches its commit; it is left detached at the last commit tested, as in the VM. `C:\tasktap\target\x86_64-pc-windows-msvc` is the scripts' build folder; `C:\tasktap\target\debug` belongs to the commands in the tower's own notes.
- **No snapshots.** What a run leaves behind stays: look for processes after a run that was cut short (`Get-Process | Where-Object StartTime` lists the account's own).

## At the desktop

An SSH session runs in session 0: no window can be shown there and the credential store refuses. What follows needs a person signed in at the VM's desktop (the Fusion window, account `tasktap`, password in the Mac's login Keychain under **Tasktap Windows VM local administrator**). First, from the Mac, build the app at the commit to try, and make sure no test run is active while you are at the desktop:

```sh
scripts/winvm/host.sh --arm64
```

Then, in PowerShell 7 at the desktop, in order. `$app` is used throughout:

```powershell
$app = 'C:\tasktap\checkout\host\target\aarch64-pc-windows-msvc\release\Tasktap Next'
```

| # | What | Run | A pass looks like |
| --- | --- | --- | --- |
| 1 | The app starts and shows its window | `& "$app\Tasktap Next.exe"` | Within two seconds one window titled Tasktap with a menu bar (Tasktap, File, Edit, View, Window) and Home in it. No console window opens, at the start or later. The window's backdrop is Windows 11's Mica, not the desktop showing through. Task Manager shows `Tasktap Next.exe`, `tasktap.exe` and `msedgewebview2.exe`. Its data is in `%LOCALAPPDATA%\Tasktap Next`. Closing the window quits the app: `Tasktap Next.exe` is gone from Task Manager within a second or two (over SSH it stays, see above; if it stays here too, that is a defect to report), while `tasktap.exe` stays for a minute, or as long as a terminal runs. |
| 2 | The smoke script | `pwsh C:\tasktap\checkout\host\scripts\smoke.ps1 -Target aarch64` | Only `PASS` lines and `all passed`, among them "the app quits when told". It opens the window behind your own for a few seconds and closes it. It uses the app's own WebView2 profile (`%LOCALAPPDATA%\io.github.harzerheribert.tasktap.next`) and a data folder of its own. |
| 3 | The tab at the top edge | Look at the top edge of the primary display while the app runs | **Not built yet**: today there is none, and that is the expected result. Once it is built (plan, "The notch on Windows"): a tab of 104 × 16 points centred at the top edge that shows the counts, lets clicks through, never takes the keyboard when it appears, sits below a taskbar docked at the top, stays put at 100 % and 150 % scale, and hides while a video plays full-screen. |
| 4 | The global shortcut | With another program in front (Notepad), press Ctrl+Alt+Space | The Tasktap window comes to the front with New Task open and the caret in its field. Until the tab is built this is the shortcut's whole effect. Started with `$env:TASKTAP_DEBUG=1` from a console, the app prints `{"event":"capture-key","ok":true}`; `false` means another program holds the combination. On a German layout check that AltGr+Q still types @ in Notepad while the app runs. With a question waiting, Ctrl+Alt+Y and Ctrl+Alt+N answer it from any program. |
| 5 | A terminal with a real shell | File › New Terminal; type `echo hello`; then `powershell`, and in it `Get-Date`; `ping -t localhost` and Ctrl+C; drag the window larger and run `mode con` (in cmd) or `$Host.UI.RawUI.WindowSize` (in PowerShell) | The prompt of `cmd.exe` appears at once; every line typed is echoed and run without a second key press, also one typed the moment output ends; Ctrl+C ends `ping`; after the resize the shell reports the new columns and rows and the prompt is redrawn without stray characters. In Task Manager the terminal's console is `OpenConsole.exe` under `tasktap.exe`, not `conhost.exe`. The menu's commands have no keys on Windows yet, on purpose. |
| 6 | The credential store | `cd C:\tasktap\checkout\core; cargo test -p tasktap-core --test secrets -- --ignored` | `test result: ok` with no test failed (over SSH it fails with error 1312). Credential Manager › Windows Credentials shows no entry left by the test. |
| 7 | WebView2 grants the microphone | In the app: View › Settings…, Appearance, start the trial of the motion with the microphone | No prompt from the app; the form moves with sound. If Windows' own setting blocks it (Settings › Privacy & security › Microphone › Let desktop apps access your microphone), the page says so and nothing crashes. The VM needs a sound card with an input in Fusion's settings for this. |
| 8 | Text of the bundled fonts | In a terminal: `chcp 65001` then `echo ┌─┬─┐ │ █▀▄ ░▒▓`; look at Home and Settings | Terminal text is Hack with the box lines and blocks joining without gaps, at 100 % and at 150 % scale (Settings › System › Display › Scale); interface text is sharp, with no fallback serif face anywhere. |
| 9 | Opening a folder | File › Open Workspace… | **Not built yet**: the page is told "choosing a folder is not available on Windows yet". Start the app with `$env:TASKTAP_PICK = 'C:\tasktap\checkout'` to give it that folder instead. |

**On the tower, by script.** Once the tower's owner has switched its screen to the test account, one command from the Mac runs what a script can do of the table, in order and unattended:

```sh
scripts/winvm/desktop.sh            # builds the app at HEAD there (host.sh --tower), then runs the round
scripts/winvm/desktop.sh --dry-run  # over SSH alone: says what each row would do and starts nothing
```

`desktop.ps1` then runs in that desktop through the tower's helper (`C:\tasktap\desk.ps1`) and refuses to start unless the test account's desktop is the one on the screen and unlocked. For each check it writes `PASS` or `FAIL` with its evidence to `results.txt`; `LOOK` lines name pictures of the app's own window (taken from the window, never from the screen) for a person to judge. Everything stays in `C:\tasktap\desktop-rounds\<time>` and is copied to a folder outside the repository (`--out`, by default under `$TMPDIR/tasktap-desktop-round`). It takes about five minutes. What it does:

| Row | By script | Left for a person |
| --- | --- | --- |
| 1 | Starts the app as Explorer would; times the window; reads the menu bar's names; looks for a new console window; finds the core and the web view; checks `%LOCALAPPDATA%\Tasktap Next`; closes the window and times the app's end; watches the core leave by itself | The picture `row1-window.png`: Home in the window, Mica behind it |
| 2 | `smoke.ps1` at the desktop, where "the app quits when told" counts and the capture key must register | |
| 4 | The default key registers and is Alt-Shift-Space; Control-Alt-T registers when asked for and the default again when cleared (`host.capture_key`); Alt-Shift-Space pressed over Notepad brings the window to the front | Whether New Task is open with the caret in it (`row4-shortcut.png`); AltGr on a German layout; whether Alt-Shift-Space also switches the keyboard layout where Windows has two; Ctrl+Alt+Y and N with a question waiting |
| 5 | A terminal answers in cmd, Control-C ends `ping`, PowerShell answers; the console is `OpenConsole.exe` under the core and no `conhost.exe` | Dragging the window larger and `mode con`; a line typed the moment output ends; `row5-terminal.png` |
| 6 | The credential test, and that it leaves no entry | |
| 8 | The terminal is set in Hack and the page loaded it; box and block characters typed | The pictures `row8-terminal.png`, `row8-home.png`, `row8-settings.png` at 100 % and, by hand, at 150 % |
| + | Whether Windows Management Instrumentation answers the account at the desktop (it refuses it over SSH); quitting through the debug channel, timed | |

Rows 3, 7 and 9 are not run: the tab and the folder panel are not built, and the microphone is for a person. **The round has not run yet** (2026-11-18): only its dry run has, which checks that the helpers compile and that the app, the fixture core and the helper's task are there. The window checks, the pictures and the pressed key are untested until a desktop is handed over.

**The smoke script.** `host/scripts/smoke.sh` cannot run on Windows as it is. Mac-only in it: bash and the `ln` links it makes of the fixture agent; the app's path inside the bundle; the speech fixture, which is Python (the VM has none); `snapshot`, which asks WKWebView for a picture; every step on the notch (hover, capture, the answer card, its frame and keyboard), which needs the tab; the lines it types into zsh; and its checks of the Dock, the menu bar and the pasteboard. `host/scripts/smoke.ps1` is the start of a Windows variant and covers what exists there: the core starting, the host reaching it over the pipe, the page running and having the core's records, New Terminal starting the shell, quitting with nothing left. To grow into the whole of smoke.sh it needs the tab, a `snapshot` on WebView2 (`CapturePreview`), the speech fixture in Node, and the typed lines in cmd's or PowerShell's words.

**Without a person (a proposal for the owner; nothing of it is configured).** Agents could run rows 1, 2, 5, 6 and 8 themselves if the VM kept a signed-in desktop that SSH can start programs in. That needs, in the guest: (1) automatic sign-in of `tasktap` at boot (Sysinternals Autologon, which keeps the password as an LSA secret, or `AutoAdminLogon` under `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon`, which keeps it readable in the registry); (2) no lock and no sleep: `powercfg /change monitor-timeout-ac 0`, `powercfg /change standby-timeout-ac 0`, the screen saver off, and the lock screen disabled by policy; (3) one scheduled task, `schtasks /Create /TN TasktapDesktop /SC ONCE /ST 00:00 /IT /RU tasktap /TR "pwsh -NoProfile -File C:\tasktap\desktop\run.ps1"`, which runs only in the signed-in session, reads the command to run from `C:\tasktap\desktop\job.json` and writes what it printed to a file; an SSH session starts it with `schtasks /Run /TN TasktapDesktop` and reads the file; (4) a new `tools` snapshot taken with all that in place. The price: the account's password is kept in the guest, and the guest's desktop is unlocked to whoever opens the Fusion window. Fusion started with `nogui` still gives the guest a display, so windows are drawn; whether pictures of them are good enough to judge rows 3 and 8 by is not known.

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
