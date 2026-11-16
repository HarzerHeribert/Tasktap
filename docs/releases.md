# Community releases

Tasktap uses Sparkle 2.10.1, pinned by SHA-256 in `scripts/fetch-sparkle.sh`.
The public update key is committed in Info.plist. Its private key is in the
maintainer's login Keychain under account `io.github.harzerheribert.tasktap`.
Back up that key securely using Sparkle's generate_keys export command; never
commit it or put it on Pages. Losing it can strand community installations.

Prepare on an Apple silicon Mac with the macOS 26 SDK:

```sh
bash scripts/package-release.sh 1.0.4 11
```

Packaging verifies the archive checksum, bundled code signature, feed metadata,
and Ed25519 signature using the public key in the app. It also checks that
modified or truncated archives fail signature verification. To repeat:

```sh
python3 scripts/verify-release.py build/releases/1.0.4
```

The build number must increase for every published update. Publish the generated
ZIP, SHA256SUMS and appcast.xml as assets of GitHub release `v1.0.4`, then copy its appcast.xml
to `site/appcast.xml` and deploy Pages through the existing workflow. Publish
assets first; do not advertise a missing download. Update the homepage release
badge and guide examples to match the new version before deploying Pages. Keep
old release assets.
No release is published by the packaging command. GitHub credentials and the
update private key are not required for ordinary builds or verification CI.

The optional `site/install.sh` downloads the latest stable release when called without
an argument, or accepts an explicit version such as `1.0.4`. It installs into
`~/Applications`, or replaces an existing copy in `/Applications` when writable.
It verifies transport checksums and the bundle, preserves a previous installation,
and does not alter Gatekeeper. Checksums are integrity checks, not an independent
publisher identity check. Sparkle updates additionally verify Ed25519 signatures.

Before each release, test a real older installed build updating to the new one,
a rejected/tampered archive, an interrupted download, and a running agent across
relaunch. Verify microphone and Automation permissions on a separate Mac.
Community builds are ad hoc signed, not notarized; do not promise permission
continuity across releases. Python 3 and agent CLIs remain external dependencies.

Helpers are copied into content-addressed Application Support/Tasktap/Helpers
folders. Do not delete these while agents are running. Settings and session data
are separate from the app. Updates preserve request text; unfinished setup and
other transient UI selections should be completed before updating.

## 1.0.5 release scope

Version 1.0.5 uses build **12**. The below-camera usage row is visible only
while the notch is active. It fades with the sheet and is hidden/inert when
collapsed. The native collapsed frame and pointer hit area return to the
original camera footprint. Workspace usage remains visible.

Release notes: [releases/1.0.5.md](releases/1.0.5.md).

## 1.0.4 release scope

Version 1.0.4 uses build **11**. It places the provider row directly beneath
the physical cutout. No provider icon occupies the menu-bar band. The row fits
within the cutout width, stays anchored during opening/closing, and is included
in the native collapsed panel height and pointer hit area. Capture and review
content start below the row. Workspace toolbar indicators remain available.

The 1.0.3 side placement was marked prerelease after live user feedback, and its
update feed was withheld. Version 1.0.4 is the stable release of plan usage.

Live account checks confirmed Claude Max, Codex Pro and Google AI Ultra through
agy. Cursor/Grok/GLM paid states use fixtures because those subscriptions are not
available locally. Provider positions are checked through animation, and native
geometry checks include the below-cutout row and its click area.

Release notes: [releases/1.0.4.md](releases/1.0.4.md).

The signed 1.0.4 package passed checksum, full bundled-source matching, helper
signatures, Ed25519 verification and rejection of altered/truncated archives.
Native interface checks confirmed six meters below the camera with no menu-bar
footprint, and the native workspace PTY/media checks passed. Browser review,
notch, workspace and theme checks passed. The verified package replaced the
local 1.0.3 installation with a recoverable backup.

## 1.0.3 release scope

Version 1.0.3 uses build **10**. It adds compact provider usage rings in the
workspace toolbar, collapsed notch and task review. Paid-account checks cover
Claude Code, Codex, Google/Gemini through Antigravity (`agy`), Cursor, Grok and
GLM. A free login or API balance does not establish a subscription. Unknown
and expired results are hidden or show unavailable quota, never sample values.

The current `agy` paid tier is read from its explicit account-tier marker in a
bounded, isolated PTY startup, then `/usage` supplies the Gemini model pool.
No model prompt is sent. This avoids the retired consumer Gemini CLI path and
the CSRF-protected local agy server. Cursor uses existing app/CLI credentials;
encrypted app storage is read only when its Keychain item is already accessible.
Grok uses existing CLI OAuth, and GLM requires a positive Coding Plan response.

Release notes: [releases/1.0.3.md](releases/1.0.3.md).

Live checks on the maintainer's Mac confirmed Google AI Ultra through agy and
ChatGPT Pro through Codex, with actual quota windows. Claude Code's existing CLI
quota reader returned its weekly window. Cursor, Grok and GLM paid/free states,
expired accounts, malformed responses and network failures use fixtures; paid
accounts for those providers were not purchased or exercised live. Application
browser regressions and subscription/geometry checks passed. The native interface check passed with six actual WebKit provider meters outside
the camera, and the native workspace PTY/media check passed. Animation captures
assert identical provider positions through opening and closing.

## 1.0.2 release scope

Version 1.0.2 uses build **9**. It adds flat request review, a wider compact
review, a single typed/spoken Reply action, and automatic update reminders.
The product page explains preparation and routing alongside the embedded
terminal workspace, using a high-resolution native capture of actual agents.

Sparkle starts when the normal app interface is ready. Automatic checks are on
by default on its daily schedule, respecting an existing saved preference.
Scheduled availability shows a sidebar badge and menu-bar arrow without opening
an update window. Clicking opens Sparkle's standard confirmation and signed
installation flow. Silent installation remains disabled. A pending restart is
blocked during recording, setup, review edits or submission and can be confirmed later from
the badge. Previous app versions need a manual check or installer to get 1.0.2.

Release notes: [releases/1.0.2.md](releases/1.0.2.md).

### Verification record

On November 16, 2026, the app browser suites and responsive product-page/guide
checks passed, including the new reminder, automatic-check preference, reply
handling and review layout. Session, routing, provider, PTY, installer, update
recovery and five standalone Swift fixtures passed. Both native interface and
workspace checks passed against the packaged 1.0.2/build 9 app.

The archive passed checksums, full bundled-resource matching, architecture,
code signing and Ed25519 verification; altered and truncated archives were
rejected. The installer replaced an untouched published 1.0.1 app with 1.0.2 in
an isolated Applications folder and preserved its backup. The installed 1.0.2
app showed its enabled automatic-check setting, and its manual Sparkle check
successfully read the public feed. The update badge and deferred-restart state
were exercised with browser bridge fixtures. Fresh-Mac permissions and the full
Sparkle download/install/relaunch sequence remain unverified for 1.0.2; the
native fixtures do not establish a complete live-provider round trip.


## 1.0.1 release scope

Version 1.0.1 uses build **8**, following 1.0.0/build 7. It simplifies the
workspace sidebar and puts terminal, browser and split controls on each surface.
Closing or moving a surface's last tab now removes that surface. Pending launches
have closable tabs; late replies never reopen a closed surface or replace a tab
selected while the terminal was starting. Explicit agent requests and reported
results drive compact workspace indicators, with Reduce Motion support.

Existing workspace tabs and processes are retained. Empty surfaces left by older
versions collapse when their saved layout loads. Closing the final tab leaves an
empty workspace, and terminal sessions can be reopened through Session history.
Tab context actions are available by right-click or Shift+F10.

Release notes: [releases/1.0.1.md](releases/1.0.1.md). Workspace layout, navigation,
lifecycle and renderer browser checks and the native PTY/WebKit workspace check
passed locally on November 16, 2026. The production 1.0.1/build 8 bundle also
passed its native workspace check and package verification: checksum, full source
and helper matching, code signature, Ed25519 signature, and rejection of tampered
or truncated archives. Installer replacement and backup checks passed.
The native check covers closing/reopening,
terminal geometry, media previews and appearance. Fresh-Mac permission checks,
Sparkle installation/relaunch and live-provider round trips are not established
by these fixtures; the community-release limitations remain unchanged.

## 1.0.0 release scope

Version 1.0.0 uses build **7**, following the published 0.3.3/build 6 release.
The integrated workspace is the primary working surface: embedded terminals,
persisted layouts, nested splits, local previews, explicit workspace membership,
application themes, and the revised capture/review/result workflow. The notch
remains available when the workspace window closes.

Existing external-terminal preferences, notes and session history are retained.
New installations default to Tasktap's built-in terminal. Changing the default
workspace folder does not move existing folders. Closing a workspace or terminal
view does not stop its process; **Stop session** does. A reboot ends terminal
processes. Users should finish an active capture or submission before updating.

The release requires Apple silicon, macOS 26 or later, and Python 3 for terminal
sessions. Coding agents need their separately installed CLI and existing sign-in.
The app is ad hoc signed and the update archive is Ed25519 signed; it is not Apple
notarized. Do not describe update signatures as notarization or promise unchanged
macOS permission grants.

Release notes live in [releases/1.0.0.md](releases/1.0.0.md). The product page and
user guide are deployed from the same source revision through the checked Pages
workflow. Packaging checks every bundled interface resource and helper against
source, includes dependency license notices, verifies the architecture and bundle
signature, and rejects altered or truncated update archives.

### Verification record

The following 1.0.0 checks passed on November 15, 2026.
Browser fixtures, native fixtures, provider runs and tests on a separate Mac are
different evidence; none may silently stand in for another.

- 29 application browser suites passed, covering workspace lifecycle, nested splits,
  terminal viewport sizing, preview isolation, theme consistency, focused review
  editing, exact-request receipts and report actions.
- Both `--verify-interface` and `--verify-workspace` passed against the signed
  1.0.0/build 7 bundle. They use real local PTYs and WebKit/media rendering with
  disposable projects. Five standalone Swift fixtures cover context, folders,
  geometry, naming and terminal prerequisites.
- Python/session/provider/PTY checks and installer replacement/backup tests
  passed. The production archive passed checksum, full-resource, helper,
  license-notice and signature checks; altered and truncated copies were rejected.
- The production installer replaced an untouched, published 0.3.3/build 6 app
  with the exact 1.0.0/build 7 archive in an isolated Applications folder. Both
  signatures and executable hashes passed; the old app was restored successfully
  from its ZIP backup. No user installation, preferences or updater cache changed.
  Sparkle installation and relaunch itself remains unverified for 1.0.0.
- Fresh-Mac Gatekeeper/microphone/Automation checks and a live-provider round trip
  are not established by these fixtures. These remain documented verification
  limits for this community release.

## 0.3.0 verification

On 2026-11-14, an isolated installed copy with version 0.2.0/build 2 fetched
0.3.0/build 3 from a loopback feed using the production signed archive. Sparkle
showed the update, downloaded and extracted it, installed it, and relaunched
Tasktap. The installed plist reported build 3, its code signature verified,
and the workspace reopened with its sessions present. This used a test older
bundle, not a previously published release. A separate fresh-Mac Gatekeeper
and microphone-permission test is still required for broader distribution.
