# Community releases

Tasktap uses Sparkle 2.10.1, pinned by SHA-256 in `scripts/fetch-sparkle.sh`.
The public update key is committed in Info.plist. Its private key is in the
maintainer's login Keychain under account `io.github.harzerheribert.tasktap`.
Back up that key securely using Sparkle's generate_keys export command; never
commit it or put it on Pages. Losing it can strand community installations.

Prepare on an Apple silicon Mac with the macOS 26 SDK:

```sh
bash scripts/package-release.sh 0.3.0 3
```

Packaging verifies the archive checksum, bundled code signature, feed metadata,
and Ed25519 signature using the public key in the app. It also checks that
modified or truncated archives fail signature verification. To repeat:

```sh
python3 scripts/verify-release.py build/releases/0.3.0
```

The build number must increase for every published update. Publish the generated
ZIP and SHA256SUMS as assets of GitHub release `v0.3.0`, then copy its appcast.xml
to `site/appcast.xml` and deploy Pages through the existing workflow. Publish
assets first; do not advertise a missing download. Keep old release assets.
No release is published by the packaging command. GitHub credentials and the
update private key are not required for ordinary builds or verification CI.

The optional `site/install.sh` downloads an explicit version into ~/Applications.
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

## 0.3.0 verification

On 2026-11-14, an isolated installed copy with version 0.2.0/build 2 fetched
0.3.0/build 3 from a loopback feed using the production signed archive. Sparkle
showed the update, downloaded and extracted it, installed it, and relaunched
Tasktap. The installed plist reported build 3, its code signature verified,
and the workspace reopened with its sessions present. This used a test older
bundle, not a previously published release. A separate fresh-Mac Gatekeeper
and microphone-permission test is still required for broader distribution.
