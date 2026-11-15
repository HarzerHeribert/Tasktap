# Community releases

Tasktap uses Sparkle 2.10.1, pinned by SHA-256 in `scripts/fetch-sparkle.sh`.
The public update key is committed in Info.plist. Its private key is in the
maintainer's login Keychain under account `io.github.harzerheribert.tasktap`.
Back up that key securely using Sparkle's generate_keys export command; never
commit it or put it on Pages. Losing it can strand community installations.

Prepare on an Apple silicon Mac with the macOS 26 SDK:

```sh
bash scripts/package-release.sh 1.0.0 7
```

Packaging verifies the archive checksum, bundled code signature, feed metadata,
and Ed25519 signature using the public key in the app. It also checks that
modified or truncated archives fail signature verification. To repeat:

```sh
python3 scripts/verify-release.py build/releases/1.0.0
```

The build number must increase for every published update. Publish the generated
ZIP, SHA256SUMS and appcast.xml as assets of GitHub release `v1.0.0`, then copy its appcast.xml
to `site/appcast.xml` and deploy Pages through the existing workflow. Publish
assets first; do not advertise a missing download. Keep old release assets.
No release is published by the packaging command. GitHub credentials and the
update private key are not required for ordinary builds or verification CI.

The optional `site/install.sh` downloads the latest stable release when called without
an argument, or accepts an explicit version such as `1.0.0`. It installs into
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
