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
scripts/winvm/gpu.sh --dry-run
scripts/winvm/shell.sh
scripts/winvm/status.sh
scripts/winvm/down.sh
```

`test.sh` sends a committed revision to the machine's bare repository over SSH. It runs the Windows CI sequence in `core` with stable Rust, rustfmt, Clippy and Cargo; the suite runs with `--no-fail-fast`, so a failing test file never keeps the ones after it from running. The default target is `x86_64-pc-windows-msvc`. Windows runs the resulting binaries under emulation. Use `--arm64` for native ARM64. The guest kernel and scheduler are ARM64 on both runs. A GitHub x64 runner still provides independent native-x64 coverage.

The checkout is `C:\tasktap\checkout`. Both architectures reuse `C:\tasktap\target`, with Cargo's target-specific subdirectories. Test runs and interactive shells acquire the same exclusive checkout lock. A job that finds it held waits for it, a quarter of an hour at most: several worktrees send their jobs to one machine. Close the active shell before starting a job. Local edits on the Windows checkout block automated switches; a file that differs from its commit in its line endings alone is not one. Commit Mac worktree changes before testing. Plain `git push winvm my-branch` transfers a branch, and `test.sh my-branch` selects it for testing.

`host.sh` does for the host what `test.sh` does for the core: format, the pages, the core and the host by `host/scripts/build.ps1`, Clippy, the host's tests, and the runnable folder `C:\tasktap\checkout\host\target\<target>-pc-windows-msvc\release\Tasktap` with its zip. It builds inside the checkout (`host\target`, `ui\node_modules`), not in `C:\tasktap\target`. With `--run` it then starts the app for some three minutes through `host/scripts/smoke.ps1`. Over SSH that gets surprisingly far (2026-11-18, both architectures): the core starts, the host reaches it over its pipe, WebView2 runs the workspace page, a folder becomes a workspace, New Terminal starts `cmd.exe` in it and `set /a 6*7` typed into it answers 42; since the second desktop round a thought also runs end to end there with the fixture agent, runs are kept and discarded, and a preview's frame is tried against what it is held to ("The smoke script", below). Two things differ from a desktop there. The capture shortcut cannot be registered (`{"event":"capture-key","ok":false}`). And the app does not end when told to quit or when its window closes: it takes the request (`{"event":"quitting"}`) and its event loop never finishes, so the script ends it and says so in a `NOTE` line. That is the missing desktop and no defect: at a desktop the app is gone 25 to 44 ms after its window closes and 11 to 69 ms after it is told to quit (the tower's rounds, 2026-11-18).

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
$app = 'C:\tasktap\checkout\host\target\aarch64-pc-windows-msvc\release\Tasktap'
```

| # | What | Run | A pass looks like |
| --- | --- | --- | --- |
| 1 | The app starts and shows its window | `& "$app\tasktap-app.exe"` | Within two seconds one window, dark from the first moment and as a whole: no title bar or menu bar of the system's, no light frame; the page's top row is the title bar, with a menu button at its left and Minimize, Maximize and Close at its right, and Home under it. No console window opens, at the start or later. Task Manager shows `tasktap-app.exe`, `tasktap.exe` and `msedgewebview2.exe`. Its data is in `%LOCALAPPDATA%\Tasktap`. Closing the window leaves the app running, as it leaves the notch on a Mac: `tasktap-app.exe` stays in Task Manager, the tab stays at the top edge and the icon in the notification area (behind the arrow, until it is dragged out). Quit Tasktap in the icon's menu, or Exit in the window's own menu, ends it: `tasktap-app.exe` is gone within a second or two (over SSH it stays, see above; if it stays here too, that is a defect to report), while `tasktap.exe` stays for a minute, or as long as a terminal runs. |
| 2 | The smoke script | `pwsh C:\tasktap\checkout\host\scripts\smoke.ps1 -Target aarch64` | Only `PASS` lines and `all passed`, among them "the app quits when told". It opens the window behind your own for a few seconds and closes it. It uses the app's own WebView2 profile (`%LOCALAPPDATA%\io.github.harzerheribert.tasktap.next`) and a data folder of its own. |
| 3 | The tab at the top edge | Look at the top edge of the main display while the app runs; move the pointer onto the tab and away; click beside it; right-click the icon in the notification area (behind the arrow); play a video full screen | A black tab of 104 × 16 points (120 × 20 on a display narrower than 1680 points) hangs centred from the top edge, below a taskbar docked there, with the wave at rest in it, or the counts of what runs and what waits. It never takes the keyboard by appearing, has no taskbar button and is not in Alt+Tab. The pointer on it opens the sheet (the same as the Mac's notch on a display without a camera housing: a plain rectangle 420 points wide) and the pointer away folds it; a click beside the tab, or under it where nothing is drawn, reaches the window below. The icon shows five bars, in amber while a question waits and with a dot while a result does; a click on it opens the sheet with the caret in its field, a right click a menu: Open Tasktap, Settings, Quit Tasktap. While a window fills the whole display (a film, a game, a presentation) the tab is gone, and back when that ends. At 150 % scale (Settings › System › Display › Scale) it is the same tab in more pixels, sharp. In the app's Settings, Thoughts, "Tab at the top of the screen" moves it to another display or switches it off. |
| 4 | The global shortcut | With another program in front (Notepad), press Alt+Shift+Space; type; press Esc. Then with Tasktap's window in front showing Home, press it again | Over Notepad the tab's sheet opens on the display the pointer is on, with the caret in its field, and what is typed lands there; the Tasktap window stays where it is. Esc folds it and Notepad has the keyboard again; so does a click elsewhere. With Home in front the caret goes to Home's own field and nothing opens over it (plan, "The capture key on Home"). With the tab switched off the key brings the Tasktap window forward instead. Started with `$env:TASKTAP_DEBUG=1` from a console, the app prints `{"event":"capture-key","ok":true}`; `false` means another program holds the combination. On a German layout check that AltGr+Q still types @ in Notepad while the app runs. With a question waiting, the tab opens on it by itself, and Ctrl+Alt+Y and Ctrl+Alt+N answer it from any program. |
| 5 | A terminal with a real shell | The menu button › File › New Terminal (Ctrl+Shift+T); type `echo hello`; then `powershell`, and in it `Get-Date`; `ping -t localhost` and Ctrl+C; drag the window larger and run `mode con` (in cmd) or `$Host.UI.RawUI.WindowSize` (in PowerShell) | The prompt of `cmd.exe` appears at once, once and on one line; every line typed is echoed and run without a second key press, also one typed the moment output ends; Ctrl+C ends `ping`; after the resize the shell reports the new columns and rows and the prompt is redrawn without stray characters. In Task Manager the terminal's console is `OpenConsole.exe` under `tasktap.exe`, not `conhost.exe`. The commands' keys are Windows' own (`docs/rebuild-plan.md`, "Keys on Windows"): Ctrl+Shift with a letter, so Ctrl+C and the like stay the program's. |
| 6 | The credential store | `cd C:\tasktap\checkout\core; cargo test -p tasktap-core --test secrets -- --ignored` | `test result: ok` with no test failed (over SSH it fails with error 1312). Credential Manager › Windows Credentials shows no entry left by the test. |
| 7 | WebView2 grants the microphone | In the app: View › Settings…, Appearance, start the trial of the motion with the microphone | No prompt from the app; the form moves with sound. If Windows' own setting blocks it (Settings › Privacy & security › Microphone › Let desktop apps access your microphone), the page says so and nothing crashes. The VM needs a sound card with an input in Fusion's settings for this. |
| 8 | Text of the bundled fonts | In a terminal: `chcp 65001` then `echo ┌─┬─┐ │ █▀▄ ░▒▓`; look at Home and Settings | Terminal text is Hack with the box lines and blocks joining without gaps, at 100 % and at 150 % scale (Settings › System › Display › Scale); interface text is sharp, with no fallback serif face anywhere. |
| 9 | Opening a folder | File › Open Workspace… (Ctrl+Shift+O), then Return on the sheet (Choose a folder…) | The system's own folder dialog, in Windows' own colours (light where Windows is set to light for apps, whatever the app is), in front of the app's window, which takes no input until it is closed. It starts where Windows keeps for this dialog: in the folder last chosen from, and the first time in your own folder. Select Folder makes the folder a workspace, shown as you know it (no `\\?\` in front); Cancel closes it and nothing else happens. `$env:TASKTAP_PICK = 'C:\tasktap\checkout'` still gives the app a folder without the dialog, for a check. |
| 10 | The window as Windows users know one | Drag it by its top row; double-click the top row; right-click it; Alt+Space; hover Maximize; drag an edge and a corner; Win+arrows; Alt alone and F10 | It moves, maximises and comes back, shows the window's own menu, offers the Snap layouts under Maximize, resizes, snaps, and opens the app's menu under its button, each command with its Windows key. Maximised it is dark to the screen's edges; restored it has round corners and its shadow. |

**On the tower, by script.** Once the tower's owner has switched its screen to the test account, one command from the Mac runs what a script can do of the table, in order and unattended:

```sh
scripts/winvm/desktop.sh            # builds the app at HEAD there (host.sh --tower), then runs the round
scripts/winvm/desktop.sh --rows 3,14 # the same, for those rows alone (with 4, name + too: it ends the app rows 4 to 12 share)
scripts/winvm/desktop.sh --dry-run  # over SSH alone: says what each row would do and starts nothing
```

The build and the round are one job, which holds the checkout from the first to the last: no other worktree's job can put another commit there in between. `desktop.ps1` then runs in that desktop through the tower's helper (`C:\tasktap\desk.ps1`) and refuses to start unless the test account's desktop is the one on the screen and unlocked. For each check it writes `PASS` or `FAIL` with its evidence to `results.txt`; `LOOK` lines name pictures of the app's own window for a person to judge: as the system draws the window for a program that asks and, where the frame, the corners, a menu, the folder dialog or the backdrop matter, as it stands on the screen (`*-screen.png`: the screen's own points inside the window's edges and nowhere else, taken only while the window is the one in front). The pictures are read straight from the system's memory (`[Tasktap.Desk]::Bits`), never through System.Drawing's `Graphics`, which loses every point a window has in one colour (below, "The dark points"). Rows 9, 10 and 14 use the pointer or the keyboard, on the app's window, the folder dialog and the round's own Notepad only, and put the pointer back. Everything stays in `C:\tasktap\desktop-rounds\<time>` and is copied to a folder outside the repository (`--out`, by default under `$TMPDIR/tasktap-desktop-round`). It takes about seven minutes after the build. What it does:

| Row | By script | Left for a person |
| --- | --- | --- |
| 1 | Starts the app as Explorer would; times the window; measures how light its first twelve pictures are; expects no menu bar; counts single black points in Home's picture (none: the faint light is drawn whole) and in the same picture taken through System.Drawing (hundreds: that library's holes); looks for a new console window; finds the core and the web view; checks `%LOCALAPPDATA%\Tasktap`; finds the tab and the icon; closes the window, after which the app runs on with both; chooses Quit in the icon's menu and times the app's end; watches the core leave by itself | The pictures `row1-window.png` and `row1-window-screen.png`: Home in one dark window |
| 2 | `smoke.ps1` at the desktop, where "the app quits when told" counts and the capture key must register: a folder as a workspace, a terminal, a thought end to end with the fixture agent, runs kept and discarded, previews and what a frame is held to (below, "The smoke script") | |
| 3 | The tab's window hangs centred from the top edge of the main display's work area at the size the arithmetic gives for what Windows reports, the page draws the tab at the Mac's size in it, and it is above every window, has no taskbar button and took the keyboard from nobody; with the script's Notepad and the app's own window under it: a point beside the tab and under it belongs to the window below and a click there reaches it; the pointer on the tab opens the sheet while Notepad keeps the keyboard, and the pointer away folds it and ends the reading of the pointer (the pointer moves over the tab and the app's window only and is put back); Alt-Shift-Space over Notepad opens the sheet with the caret in its field and what is typed lands there, Escape folds it and Notepad has the keyboard again, and so does a click elsewhere; the icon is in the notification area and its menu, asked for as the shell asks for it, says Open Tasktap, Settings, Quit Tasktap; the app's own window over the whole display hides the tab, and it shows again after; at rest the window does not move, the pointer is not read, and processor time and context switches of the app and its web views over half a minute are no more with the tab than with it switched off | The pictures `row3-tab-collapsed-screen.png`, `row3-tab-open-screen.png`, `row3-tab-capture-screen.png` (the tab over the app's window and Notepad, as on the screen) and `row3-icon-menu-screen.png`; the icon itself, which sits in the overflow; a second display, a second scale, a taskbar at the top |
| 4 | The default key registers and is Alt-Shift-Space; Control-Alt-T registers when asked for and the default again when cleared (`host.capture_key`); Alt-Shift-Space pressed over Notepad opens the tab's sheet with the caret in its field while the Tasktap window stays where it is, and Escape gives Notepad the keyboard back; pressed with Home in front it puts the caret in Home's own field and opens nothing; with the tab switched off it brings the Tasktap window forward, the caret in Home's field | `row4-shortcut-screen.png`, the sheet over another program, and `row4-home.png`; AltGr on a German layout; whether Alt-Shift-Space also switches the keyboard layout where Windows has two |
| 5 | The terminal's size is the one its pane has room for, in the core, on the page and by `mode con`, and its first prompt is drawn once; New Task opened over it and closed again leaves that size alone; a terminal answers in cmd, Control-C ends `ping`, PowerShell answers; the console is `OpenConsole.exe` under the core and no `conhost.exe` | A line typed the moment output ends; `row5-terminal.png` |
| 6 | The credential test, and that it leaves no entry | |
| 8 | The terminal is set in Hack and the page loaded it; box and block characters typed | The pictures `row8-terminal.png`, `row8-home.png`, `row8-settings.png` at 100 % and, by hand, at 150 % |
| 10 | With the pointer, on the app's window only (put back afterwards): the points where the page draws Minimize, Maximize and Close answer as those buttons, the edges and a corner as places to resize by; hovering Maximize lights it and opens the Snap layouts; a click maximises and puts back; a double click on the top row does too; a right click there and Alt-Space open the window's menu; Alt alone and F10 open the app's menu; F5 and Ctrl+R do not load the page anew; Minimize minimises | The pictures `row10-*.png`: restored, maximised, Maximize under the pointer, the menu open, and with another window in front. Dragging, Win+arrows, a second display scale |
| 11 | Reads every key hint and tooltip in a workspace, on Home, in New Task and in each section of Settings and expects none of the Mac's signs; reads the folder in the header | The six pictures of Settings, `row11-settings-*.png` |
| 12 | Makes the window larger with the terminal in front: the terminal, the core and `mode con` agree on the larger size, and on the first again after | `row12-larger.png`; `row12-backdrop-screen.png`, the page let through to a third to show the backdrop behind it |
| 9 | With real keys on the app's window: Ctrl+Shift+O and Return open the system's folder dialog; it is the window's own and modal to it; its Cancel is pressed, after which there is no workspace, nothing is said and the window has the keyboard again; opened once more, a folder's path is put into its field and its button pressed, and that folder is the workspace, kept as written | `row9-dialog-screen.png`: the dialog as it stands on the screen (the system's, dark). Where it starts is said in an `INFO` line |
| 14 | With the core that has the fixture agent: Alt-Shift-Space over Notepad opens the tab, a thought is typed into it with the keyboard and sent with Return; it is placed in the open folder and starts, and the tab folds by itself and leaves Notepad the keyboard; the fixture agent runs in a terminal of the workspace and asks, and the tab opens on the question by itself while Notepad keeps the keyboard; Ctrl+Alt+Y pressed over Notepad answers it while Notepad stays in front, and the tab folds; the turn's end marks the result in the window, on the tab and on the icon; the pointer on the tab shows the result, which then counts as read; nothing is left running | `row14-tab-working-screen.png`, `row14-tab-question-screen.png`, `row14-tab-result-screen.png`, `row14-tab-result-open-screen.png`: the tab with a thought running, on a question, with a result, and open on it; `row14-result.png` |
| 13 | Starts the app with the system's own title bar in the page's colours (`TASKTAP_CHROME=native`) for one picture | `row13-native-screen.png` beside `row10-restored-screen.png` |
| + | Whether Windows Management Instrumentation answers the account at the desktop (it refuses it over SSH); quitting through the debug channel, timed | |

Row 7 is not run: the microphone is for a person. The round makes no sound: for as long as it runs, the test account's sounds for the system's events and its warning beep are off, and both are put back when it ends (`desktop.ps1`, `Sounds-Off`).

**The rounds of 2026-11-18** (the tower: Windows 11 Pro 25H2, one display at 100 %). The first gave 23 passes and 2 failures; the last, at the commit that fixed what it found, 50 passes and none, with 20 pictures.

- **What the first round found.** A terminal was started 2 columns by 1 row and told its real size a tenth of a second later, so `cmd.exe` drew its first prompt two characters to a line and the console kept that on screen (the page measured a pane that had no size yet: `ui/src/workspace/terminal.ts` FLOOR, `scripts/terminal-size-check.cjs`; the Mac did the same and hid it better). Control-C ended nothing in a terminal: the core is started in a process group of its own, which Windows takes as "ignore Control-C" and hands on to what the core starts (`core/src/sys.rs`, `control_c_ends_what_runs_in_a_shell_and_the_shell_reads_on`). Keys were named as the Mac names them, the window had a light title bar and menu bar on a dark page, and a folder was shown as `\\?\C:\…`. The round itself left New Task open over everything after row 4.
- **What stays proven.** The window in under half a second (472 to 475 ms) and dark from its first picture; quit 25 to 44 ms after the window closes and 11 to 69 ms after being told (so the app that never ends over SSH is the missing desktop, closed); the capture key registering as Alt-Shift-Space and bringing the window forward over Notepad; the credential store; `OpenConsole.exe` as the console; Hack loaded; a terminal at the size of its pane (114 × 42, and 144 × 50 in a larger window, by `mode con` too); Control-C; PowerShell; every key hint in Windows' words; the window's buttons, edges, menus and the Snap layouts.
- **The dark points were holes in the pictures, not on the screen** (found in the round of the same evening). The first rounds showed a speckle of dark points in the page's faint light, at the foot of Home, at the sidebar's foot and under a dimmed sheet, and took it for a fault of WebView2 on that machine's graphics card. It was the rounds' own way of taking a picture. System.Drawing lets the system draw into a picture through a device context (`Graphics.GetHdc`, and `CopyFromScreen`, which uses it); before it does, it fills its scratch memory with one colour, rgb 13 11 12, and afterwards copies back only the points that are no longer that colour. A point the window really has in rgb 13 11 12 is taken for "not drawn" and stays as the new picture was: black and transparent. The page's light passes through that colour in rings, and its noise scatters it. The evidence, all on the tower: a page of a thousand colours had one hole, the cell that is rgb 13 11 12, under every way WebView2 can be made to draw (GPU and software raster and compositing, Direct Composition on and off, ANGLE on Direct3D 11, on 11on12 and on WARP, Skia Graphite on and off, sRGB and scRGB forced); a plain opaque gradient with no transparency at all had 30,920 holes; a picture first filled with magenta showed magenta at every one of them; and the same window read straight from the system's memory has none, with rgb 13 11 12 at each of the 1,252 points where the old picture of Home had a hole, in the window's picture and in the screen's own points alike. The display there runs with Windows' advanced colour on at 8 bits a channel (SDR white at 180 nits), on an Nvidia card; neither is involved. The page was never changed. The round now takes its pictures from the system's memory and counts single black points in Home's picture (row 1); a second display scale, dragging the window and Win+arrows are still not tried by script.
- **Widened since** (the round of the same evening): the folder dialog (row 9), a thought sent from another program and its question answered from there (row 14), and in the smoke script a thought end to end with the fixture agent, runs kept and discarded, and previews beside a terminal with what a frame is held to.
- **The last round of that evening**, at the commit with all of this: 62 passes and no failure, with 22 pictures; the smoke script inside it 37 passes. The window in 349 ms; the app gone 20 ms after its window closes and 61 ms after being told to quit. The folder dialog there is light: it is the system's, and follows Windows' own setting for apps, not the app's dark look.
- **The round of 2026-11-19, at night**, with the tab built, the tower's monitor switched off and its owner asleep: 96 passes and no failure with 32 pictures to look at, the smoke script inside it 40 passes. Windows reported its display as ever (2560 × 1440 at 100 %) and every picture is real. The window in 353 ms, the tab's page made seven tenths of a second after it; the tab's window at 1164,0 and 232 × 56 pixels, the tab 104 × 16 in it; Quit in the icon's menu ends the app in 313 ms. At rest, with the tab collapsed and the pointer elsewhere, the app and its web views used 31 to 109 ms of processor time in 31 s over six runs (in the last, 94 ms) and were let run 3.6 to 8.5 times a second, in 8 processes with some 362 MB of their own; with the tab switched off, 0 to 62 ms (in the last, 16 ms) and 5 to 6 times a second, in 7 processes with some 318 MB. The tab is one more web view process and some 44 MB; in processor time it is at most a thousandth of one core, in how often the app is let run nothing that shows, and nothing of the host's runs: no timer, no hook, no polling. With the sheet open and the keyboard in it the same processes used 2.5 s of processor time in half a minute (the wave moves, and the pointer is read sixty times a second). What the round found on the way is in `docs/rebuild-plan.md`, "The tab on Windows": the app hung at the first press of the capture key, a click elsewhere did not fold the sheet, the notch's page opened beside Home's field because every page hears what the host tells any page, and the window was white for a moment in one start of five until the tab's window was made later. The pictures of the tab are `row3-tab-*-screen.png`, `row4-shortcut-screen.png` and `row14-tab-*-screen.png`: the screen's own points inside the tab's window, over the app's window and the round's Notepad.

**The smoke script.** `host/scripts/smoke.sh` cannot run on Windows as it is. Mac-only in it: bash and the `ln` links it makes of the fixture agent; the app's path inside the bundle; the speech fixture and the web server for frames, which are Python (the Windows machines have none); every step on the notch (hover, capture, the answer card, its frame and keyboard), which needs the tab; the lines it types into zsh; and its checks of the Dock, the menu bar and the pasteboard. `host/scripts/smoke.ps1` is the Windows variant, and covers: the core starting, the host reaching it over the pipe, the page running and having the core's records, New Terminal starting the shell (`set /a 6*7`), the fixture agent found on the terminal's PATH (the fixture core copied as `fixture-agent.exe` and `fixture.exe` into a folder at the front of the app's PATH); a thought typed on Home and sent, placed in the open folder and started, the agent's folder-trust prompt and its question in the pane's strip and on Home, the question answered as the global shortcut answers it, the result's marks; a run in a copy of the project whose changes wait and are kept, and one that is reviewed and discarded with Ctrl+Backspace (these need git); a page of the project and a local web address in a sandboxed frame, and what a frame is held to, tried by the Mac's own probe page (`frame-probe.html`, served by `frame-fixture.cjs` in Node, which the machines have); the capture key; quitting with nothing left. `snapshot` works there too (WebView2's `CapturePreview`). Since 2026-11-19 also the tab: its window made with the notch's own page in it, opened and folded as the pointer and the capture key would, told through the debug channel as smoke.sh tells the notch (what the real pointer and keys do is the desktop round's). Still only in smoke.sh: most of the notch (a thought sent from it, a question answered in it, a result kept), speech (its fixture would have to be in Node), splits and moved tabs, the sheets and Settings, the kinds of preview that are not frames, links typed into a real terminal, Keep refused, and the relaunch.

**Without a person (a proposal for the owner; nothing of it is configured).** Agents could run rows 1, 2, 5, 6 and 8 themselves if the VM kept a signed-in desktop that SSH can start programs in. That needs, in the guest: (1) automatic sign-in of `tasktap` at boot (Sysinternals Autologon, which keeps the password as an LSA secret, or `AutoAdminLogon` under `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon`, which keeps it readable in the registry); (2) no lock and no sleep: `powercfg /change monitor-timeout-ac 0`, `powercfg /change standby-timeout-ac 0`, the screen saver off, and the lock screen disabled by policy; (3) one scheduled task, `schtasks /Create /TN TasktapDesktop /SC ONCE /ST 00:00 /IT /RU tasktap /TR "pwsh -NoProfile -File C:\tasktap\desktop\run.ps1"`, which runs only in the signed-in session, reads the command to run from `C:\tasktap\desktop\job.json` and writes what it printed to a file; an SSH session starts it with `schtasks /Run /TN TasktapDesktop` and reads the file; (4) a new `tools` snapshot taken with all that in place. The price: the account's password is kept in the guest, and the guest's desktop is unlocked to whoever opens the Fusion window. Fusion started with `nogui` still gives the guest a display, so windows are drawn; whether pictures of them are good enough to judge rows 3 and 8 by is not known.

## What the graphics processor costs

The tower's card (an RTX 4090 its owner also plays on) is measured as a person runs the app: the app's window on the screen and not covered, a minute in each state, by `gpu.ps1` in the test account's desktop. Like the desktop round it needs the owner to have switched the screen to that account, and it is one job with the build:

```sh
scripts/winvm/gpu.sh --dry-run                       # over SSH alone: is the screen this account's and unlocked, the card and its idle figures; starts nothing
scripts/winvm/gpu.sh                                 # builds at HEAD there, then the round: every state at the window's size, effects Full
scripts/winvm/gpu.sh --no-build --effects still,off --seconds 30
scripts/winvm/gpu.sh --no-build --size full          # the window over the whole display (2560 x 1440 there)
scripts/winvm/gpu.sh --no-build --lumen on,off --states listening,working,question,tab-question
scripts/winvm/gpu.sh --no-build --rest               # the proof alone (checklist item 35): the floor, then the app at rest, in front and behind
scripts/winvm/gpu.sh --rehearse                      # in the VM, over SSH: every state for a few seconds, to prove the round's mechanics
```

The dry run sends this worktree's `gpu.ps1` beside the checkout (`C:\tasktap\gpu-rounds\dry-run`) and asks it about the app the checkout last built. Over SSH a standard account may not read the counters' names (PDH `0xc0000bc8`: they are read only by an account signed in at the screen), so the dry run says that and the round reads them at the desktop. `--no-build` runs the round on the app the checkout last built, and refuses when another worktree's job has moved the checkout since (`-Commit`); a commit that changed `gpu.ps1` needs a build.

**What a round does.** First the floor: a minute with no app, which is the card idle (its utilisation and power, with their spread, its performance state and memory clock) and the compositor's own use; a round refuses to start when the card is busy already (more than 25 % in use, or another program over 15 % of an engine: a game). Then the built app as a person runs it, on a data folder of its own with the core that has the fixture agent, as the smoke script starts it, and its window in front. Not passive: a passive app's host never watches for the window in front, so its light rests whatever it shows (the first round measured that). Before anything else the round takes the microphone away from both of the app's pages (`getUserMedia` refuses there, and the recorder's source is the checks' tone): nothing in the round asks for it, and nothing can. Each state is entered, settled (the pulse that focus sends lasts 7.2 s; ten seconds at rest, three at a state's later levels), and measured for `--seconds` (60), at each level of `--effects` and, for the states Lumen changes, each of `--lumen`. In order: `rest` (Home, nothing running, the caret in Home's field as it opens), `rest-unfocused` (the same with the caret taken out of the field), `rest-behind` (the caret in the field, and the round's own Notepad, small in the display's lower left corner beside the window, in front: Tasktap on the screen but not in front), `tab-rest` and `tab-open` (the window minimised, the tab folded, then open as the capture key opens it), `sidebar` (on Home, one slide a second), `terminal` (cmd counting lines as fast as it prints them), `listening` (the level the checks' tone gives a recording, put where the core's report of a recording goes, ten times a second: no microphone and no sound), `thinking` (a thought placed and held before it starts), `working` (the fixture agent in its turn), `question` (its question waiting, on Home) and `tab-question` (the tab folded and glowing for it, the window minimised). Minimised, the host must know by itself that the window is not in front (`edge.rs` hears of minimising since 2026-11-19; before, in the test account's empty desktop no other window took the front and the host learnt of the window in front only when another came there, below): the round asks it, and where it does not know, says so in the row's notes and tells it (`where behind`). At `--size full` the tab's three states are left out. Last the floor again for half a minute, the app gone: the card's idle power is not one figure. A round stays under a quarter of an hour and refuses one that would not (the default round is about 13 minutes); the full set is four rounds: each size with `--effects full` and with `--effects still,off --seconds 30`.

**What it reads.** Each second, from Windows' counters (`\GPU Engine(*)\Utilization Percentage` and `\GPU Process Memory(*)\Dedicated Usage`, read through PDH): the share of the second in which each engine of the card ran work of the app's processes, summed over the app, every process under it (its WebView2 processes, among them the one that draws for both pages) and its core, by kind of engine (3D, copy, video, compute), and their memory on the card; the same for the compositor (`dwm.exe`); and the busiest other process. A value outside 0 to 100 is left out (a process that has just come can read 10^14 % once). From the card (`nvml.dll`, or `nvidia-smi` where that does not answer): its utilisation, power, temperature, fan, clocks and performance state. The app's processor time, of one core. Per state also the frames the page's light drew (`__motion.stats.frames`), the size of its canvas, the light's state and what has the keyboard, as the page says. Not read: what WebView2 presents a second (that needs ETW, so an administrator), and the desktop's composed frames (Windows 11 answers `DwmGetCompositionTimingInfo`, but its counts do not follow the screen: 2 to 3 in a second at 240 Hz). A process that gives the card no work reads exactly 0.000 % in the counters; that, and the floor's spread for the card's own figures, is the measurement's floor. The card's utilisation (`card %`) is the share of time any work ran: at the idle clocks the app keeps it at, a few per cent of the 3D engine read as about 38 %, so power is the card's figure to go by.

**The card's safety.** A watch on a thread of its own reads the card every second from the moment the round starts, whatever the round is doing, and ends the app (its whole tree) at once, and with it the round, when the card passes 70 °C, draws more than 120 W over the floor, or stays more than 40 % busier than at the floor for ten seconds; the round's own second also ends it when the app's processes keep an engine over 40 % for ten seconds, or another program uses the card over 25 % for ten (someone started a game). Without the card's temperature nothing is measured. `table.txt` ends with the highest temperature, power and fan of the round beside the floor's.

**Item 35.** At rest with Tasktap not in front, or with no caret, the app's figure is exactly zero; with the caret blinking in Home's field and Tasktap in front, at most 0.01 % of the 3D engine. In `rest-unfocused`, `rest-behind` and `tab-rest` the round says `PASS` only when in every second the app's processes used no engine of the card at all and the page drew no frame; in `rest` when they used at most 0.01 % on average and the page drew no frame. `--rest` runs the floor and those alone (`--states rest,rest-unfocused,rest-behind,tab-rest`) and fails the command otherwise. It is not in the smoke script: over SSH no window is on the screen, and there even agents working drew no frame, so it would pass whatever the app does.

**What stays where.** Everything is in `C:\tasktap\gpu-rounds\<time>` on the tower (`table.txt`, `results.txt`, `samples.csv` with every second, `app.txt` with what the app said) and is copied to `--out` (by default `$TMPDIR/tasktap-gpu-round`), never into the repository. The round makes no sound (`sounds.ps1`, shared with the desktop round: the account's event sounds and warning beep are off while it runs and put back after). `--rehearse` runs the same script in the VM over SSH with `-Rehearse`, on its x64 build run emulated (the VM's ARM64 host build stops at `ring`, which wants clang there): no desktop, no card, five seconds a state; its figures mean nothing, it proves that every state is entered and left and the table written.

**The rounds of 2026-11-19, at night** (the tower: one display, 2560 × 1440 at 240 Hz and 100 %; the window at its size, 1180 × 760, and over the whole display; no safety stop in any round). The share of the 4090's 3D engine the app's processes used, mean over the state; the page draws its light 80 times a second there (every third frame of 240 Hz):

| State | Window: Full | Still | Off | Whole display: Full | Still | Off |
| --- | --- | --- | --- | --- | --- | --- |
| At rest on Home, the caret in its field | 0.007 % | 0.007 % | 0.011 % | 0.007 % | 0.007 % | 0.007 % |
| The same, the caret out of the field | 0.000 to 0.002 % | 0.000 % | 0.000 % | 0.000 % | 0.000 % | 0.000 % |
| The tab at rest | 0.000 % | 0.000 % | 0.000 % | | | |
| The tab open | 0.017 % | 0.048 % | 0.026 % | | | |
| The sidebar, a slide a second | 4.3 % | 3.9 % | 1.6 % | 4.8 % | 4.5 % | 1.5 % |
| A terminal printing 7,500 lines a second | 6.2 % | 6.2 % | 7.5 % | 9.9 % | 10.2 % | 11.3 % |
| Listening | 3.7 % | 0.03 % | 0.03 % | 4.1 % | 0.01 % | 0.01 % |
| A thought on its way | 3.6 % | 1.2 % | 1.2 % | 4.1 % | 1.1 % | 1.2 % |
| Agents working | 5.9 % | 0.9 % | 0.9 % | 8.6 % | 0.9 % | 0.9 % |
| A question waiting, on Home | 7.9 % | 4.8 % | 4.8 % | 10.0 % | 4.6 % | 4.8 % |
| The tab glowing for the question | 4.2 % | 4.6 % | 4.8 % | | | |

- **Power and heat.** The loops at Full keep the card in its idle state (P8, 210 to 300 MHz) at the window's size, 3 to 4 W over the floor; over the whole display it leaves it (P3, its memory at 5 GHz), 21 to 22 W over. The sidebar's slides send it to P0 in bursts of about three seconds (up to 92 W over the whole display, 36 W over the floor on average with a slide a second; 13 to 16 W at the window's size, at Still too). The highest of all five rounds: 53 °C, 92.1 W, the fan at 33 % (it stood still in three rounds). The floor: 29 W in P8 or P5 in four rounds, 13 W in the first; the card returns to its 30 W idle after a round, so the floor holds within the round. P0 bursts of the same size come with no app too.
- **Zero at rest (item 35).** The tab at rest: zero in every second of every round. Home at rest is not: the caret in Home's field blinks, which costs 0.007 % in almost every second at every level of the effects. With the caret out of the field, zero but for one second in a minute (0.001 to 0.123 %, cause not found; the page drew no frame).
- **What costs.** The band's shader at Full (3.6 to 4 % on its own; over the whole display it takes the card out of idle). The tab's glow for a question (4.2 to 4.8 % at every level of the effects: the notch's page has no Effects, and its blurred layers move at the display's rate). The breathing pools and the glyphs while agents work (about 2.3 % at the window's size, 4.4 % over the whole display, above a thought on its way). The sidebar's slide (redrawing the band and reallocating its canvas in every frame, at Still too). Something that moves while a thought is on its way and while agents work at Still and Off too (1.2 % and 0.9 %; not found). The terminal is text: under a percent per 1,000 lines a second at the window's size, and about four cores of the main processor.
- **What the first round found.** A passive app's light never moves (its host does not watch for the window in front), so the round runs the app as a person does. And the host takes a minimised window for the one in front when no other window comes there (the test account's desktop is empty): with a question waiting the page went on drawing its light 80 times a second unseen, 9.9 % of the 3D engine (`host/src/edge.rs`, FRONT is asked only when another window comes in front). The round now tells the host where the window is when it minimises it.

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

## Results on both machines, 2026-11-18

Wall times of the complete command from the Mac at commit `d553b3a` (383 tests; 10 more are ignored, which need a real agent, a key or a desktop). The tower ran at its manners: 8 of 16 logical cores, priority BelowNormal, its owner using it meanwhile. Windows 11 Pro 25H2 (build 26200) there, 24H2 in the VM.

| Machine and run | Wall time | Result |
| --- | --- | --- |
| Tower, `test.sh --tower`, build folder empty | 2m 35s | 383 passed |
| Tower, the same again | 1m 44s | 383 passed |
| Tower, `--system-console` | 1m 37s | 383 passed, twice |
| Tower, `--batch-agents`, with either console | 1m 49s to 1m 57s | 383 passed, four times |
| Tower, `host.sh --tower --run`, dependencies built before | 1m 47s | Clippy clean, 19 tests, folder and zip, smoke all passed |
| VM, `test.sh --x64` (emulated), core rebuilt | 5m 29s | 383 passed |
| VM, `test.sh --arm64`, core rebuilt | 4m 05s | 383 passed |
| VM, `test.sh --arm64 --batch-agents` | 2m 17s | 383 passed |
| VM, `host.sh --arm64 --run`, dependencies built before | 2m 44s | as on the tower |

The suite alone, without building, takes 93 to 111 s on the tower, 127 s in the VM natively and 224 s there emulated: most of it is waiting for timers, which faster hardware does not shorten. The tower compiles the core and its tests from nothing in 38 s on its eight cores.

`a_shim_killed_ends_its_session_and_stopping_one_never_ends_the_shell` (`tests/roles.rs`) failed 13 runs of 13 on the tower before the shim ended its agent through a job, and none of 40 after (`--repeat 10`, plain and `--batch-agents`, each with either console); in the VM it passed 10 of 10 on each architecture after the change, as it did before. Over SSH the app behaves on the tower as in the VM: the smoke script passes, the capture key cannot be registered ("This operation requires an interactive window station", error 1459), and told to quit the app says `quitting`, never `quit`, and sits idle at no processor time until the script ends it.
