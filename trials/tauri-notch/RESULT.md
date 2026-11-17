# Tauri notch trial: result

Run on 2026-11-17 on a MacBook Pro (M4 Pro, built-in display 1800×1169 pt with a camera cutout), Darwin 27.0. Tauri 2.12.6 (wry 0.57.2, tao 0.37.2), objc2 0.6.5 and objc2-app-kit 0.3.2. The screen was locked for the whole run, so nothing was seen and no real pointer or keyboard input happened. Everything that needs eyes or real input is in `check.sh`.

## The six items

| # | Item | What Tauri needed | Status | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Placement at the cutout, above the menu bar, on all Spaces | Tauri has no API for window level 26, full-screen auxiliary, AppKit-point frames or the camera-housing rectangles. Those come from objc2. `NotchGeometry.swift` is ported line for line to Rust (52 lines). | PASS (API checks). NEEDS-EYES: other Spaces and full-screen apps | The Rust port prints the same tab and frames as `NotchGeometry.swift` for the 14 synthetic displays of `verify-notch-geometry.swift` and for the live display (the diff is empty). Panel level 26, window server layer 26, collection behavior 257 (all Spaces + full-screen auxiliary), frame 777,1115,246,54, which is 1.2's collapsed frame. |
| 2 | Reveal without stealing focus | A Tauri window cannot be a non-activating panel. objc2 creates a real `NSPanel` (borderless, non-activating from the start, plus a subclass that can become key) and moves Tauri's WKWebView into it. Tauri's own window stays hidden. Hover uses the same 80 ms pointer poll and `ignoresMouseEvents` rule as `main.swift`, through objc2. | PASS for hover (API). NEEDS-EYES: click, keyboard, drag | With a warped pointer the notch opened and folded. The trial stayed inactive, the panel did not take key status and the frontmost app was unchanged. AppKit's activation-prevention flag is set on this panel. A re-classed Tauri window does not get that flag (see "Hard or fragile"). Click-to-type, shortcut-style focus and drag need an unlocked screen: `check.sh` items 2b to 2e. |
| 3 | Decision glow | No native code. An SVG in the page redraws the CoreAnimation layers with the values from `WorkspaceDecisionRim.swift`: metal gradient stroke at 0.1, halo, bloom, the 0.62 to 0.9 pulse (600 ms, twice) and Reduce Motion. | NEEDS-EYES | A headless Chromium render looks right. The real test is `captures/trial-rim-*.png` against `captures/native-rim-*.png`, both from `check.sh`. The native ones are drawn by the real 1.2 class. |
| 4 | Translucent backdrop | No native code: Tauri `windowEffects` (`underWindowBackground`, `followsWindowActiveState`) plus the CSS tint #0d1117 at 0.93. WebKit supports `prefers-reduced-transparency`, so the tint can follow Reduce Transparency. | NEEDS-EYES | `captures/backdrop-compare.png` shows the Tauri window on the left and the real `WorkspaceBackdrop` on the right. |
| 5 | Content | A custom protocol serves the page and the prototype styles from the repository. This is for the trial only; the app would bundle them. The page links `../../../prototype/style.css` and `decision.css` unchanged. | NEEDS-EYES | The page loaded inside the panel and reported ready. A Chromium render shows the decision-sheet card and the dark field. In the morning: `captures/trial-open.png` against `captures/dev-open.png`. |
| 6 | Pass-through measurements | Built-in commands, channels, events and an asynchronous custom protocol. | PASS (measured) | See [Pass-through numbers](#pass-through-numbers). |

## Lines of code

Lines below are non-blank and non-comment.

**The trial:**
- **Rust:** 372 lines.
  - `main.rs` has 215. About 125 are notch glue and about 90 are measurement and test scaffolding (bench commands, stdin commands, the file server).
  - `geometry.rs` has 82: 52 for the port and 30 for test cases and printing.
  - `native.rs` has 75 (see the next line).
- **Native code:** the 75 objc2 lines in `native.rs` (55 for the panel, pointer and focus, 20 for diagnostics). No Swift ships in the app. Only public API drives behavior. The diagnostic probe reads AppKit's private `_preventsActivation` getter to report the flag; nothing depends on it.
- **Config:** 40 lines (`Cargo.toml` 19, `tauri.conf.json` 13, capability 5, `build.rs` 3).
- **Page:** 86 lines (`notch.html` 34, `notch.css` 11, `notch.js` 41), plus `backdrop.html` 10 and the bench page 70.
- **Test tools:** `tool/main.swift` 159 (the 1.2 reference helper, built from the 1.2 sources) and `check.sh` 193.

**The same surface in 1.2:** `NotchGeometry` 71 + `WorkspaceDecisionRim` 110 + `WorkspaceBackdrop` 64 + about 90 lines of panel, position and hover in `main.swift`, so about 335 Swift lines. One host would need about 230 Rust lines (55 of them objc2) plus about 50 lines of SVG, CSS and JS.

**Today's Swift against a single Tauri host.** These are rough figures from the files and from the sections of `main.swift`:

| Today (5,039 Swift lines: `native/` plus the speech helper) | Lines | In a single Tauri host |
| --- | --- | --- |
| Moves to the core under either option: sessions, routing, router connection, handoff, inbox, terminals, folders, cloud speech, model server, names, Ghostty colors, result documents, the logic of the UI message router, in-app verification | ~2,870 | not host code |
| Host abilities Tauri covers: windows and web view hosting, app menu and status item, global shortcuts (press and release), updater, launch at login, single instance, file panels, link policy, the preview scheme, the menu mark | ~900 | Tauri APIs and official plugins; the preview scheme becomes about 100 lines of Rust |
| Notch panel, geometry, glow, backdrop | ~335 | about 230 Rust lines (55 objc2) plus page SVG and CSS (this trial) |
| Local speech: `Dictation`, `SpeechService`, `SpeechPreferences`, `Narration`, the `tasktap-speech` helper | 685 | kept in Swift, because WhisperKit is Swift-only. It already runs partly as a separate helper. |
| Screen context (Accessibility, Apple Events) | 209 | kept: a Swift helper, or about 200 lines of objc2 |
| Notification action buttons | ~40 | probably kept native: as far as I can tell the official notification plugin offers actions only on mobile (not tested) |

So one host replaces about 1,200 lines of today's host Swift and keeps about 930 Swift lines plus 55 to 100 objc2 lines. With two hosts, the ~1,200 host lines are written and kept twice: once in Swift and once in Rust for Windows.

## Binary size and idle memory

This is physical footprint after 20 s idle, with the screen locked.

| | Tauri trial | Tasktap Dev 1.2 |
| --- | --- | --- |
| Executable | 4.4 MB (release, LTO, stripped; Tauri, wry, tao and objc2 included) | 1.9 MB Swift host + 2.9 MB Sparkle framework. The whole bundle is 26 MB, mostly the 15 MB prototype folder and the 5.2 MB speech helper. |
| Host process | 22 MB (notch only), 27 MB (notch + backdrop window, two web views like 1.2) | 30 MB |
| WebKit processes | WebContent 14 MB per page, GPU 11 to 13 MB, Networking 6 MB | WebContent 50 + 35 MB (full app pages), GPU 16 MB, Networking 8 MB |
| Total | 54 MB / 74 MB | 139 MB |
| Idle CPU over 10 s | 0.02 s | 0.10 s |

The WebContent numbers compare pages, not hosts: the trial page is tiny, and 1.2 loads the whole app twice. Host process against host process, it is 22 to 27 MB against 30 MB.

## Pass-through numbers

The setup was identical for both hosts, so the numbers are comparable:
- The same page, `ui/bench.js`, ran in a notch-sized panel at level 26.
- Throttling was off in both: Tauri `background_throttling(Disabled)` and Swift `inactiveSchedulingPolicy = .none`.
- The Swift side copies 1.2's terminal path from `WorkspaceTerminals.swift` and `main.swift`: base64 inside JSON events, delivered with `callAsyncJavaScript("return await receive(events)")` and awaited per batch. That await is 1.2's backpressure.
- Each number is the median of 3 runs, with the screen locked and the pages "hidden". The raw runs are in `captures/locked-bench-*.json`. `check.sh` reruns both hosts unlocked. Its dry run, also on the locked screen, gave the same figures to within 10%.

Throughput, from the host to the page, counted when the bytes are decoded in the page:

| Mechanism | 512 B frames | 64 KiB frames |
| --- | --- | --- |
| Swift 1.2: `callAsyncJavaScript`, base64, awaited per frame | 7.1 MB/s (14.5k frames/s) | 571 MB/s |
| Swift: the same, not awaited | 51.9 MB/s | 1,753 MB/s |
| Tauri channel, raw bytes | 15.8 MB/s (32.4k frames/s) | 767 MB/s |
| Tauri event, bytes as a JSON number array | 13.2 MB/s | 22 MB/s |
| Tauri event, base64 string | 43.2 MB/s | 1,362 MB/s |
| Tauri custom protocol, one fetch per frame | 3.0 MB/s | 398 MB/s |
| Tauri custom protocol, one 128 MB response read as a stream | – | 3,556 MB/s |

Key round trip: from a keydown handler in the page, to the host, and back to the page. This is the mean of 1,000 trips. WKWebView clamps `performance.now()` to 1 ms, so each sample timed 10 trips.

| Path | Mean |
| --- | --- |
| Swift 1.2: `postMessage`, then a `callAsyncJavaScript` echo | 0.10 ms |
| Swift: `postMessage` with a reply handler | 0.06 ms |
| Tauri: `invoke` returning the key | 0.14 ms |
| Tauri: `invoke`, then an event echo | 0.15 ms |

Tauri's channels and events have no backpressure. A terminal would add an acknowledgement through `invoke`, about 0.15 ms per batch.

Neither number decides the question. Every mechanism except the JSON number array runs far faster than a terminal renders, and all round trips stay well under a millisecond against a 16 ms frame. The best Tauri choices for terminal output are a channel with raw bytes (for small frames, twice 1.2's awaited path) or base64 events.

## Hard or fragile

1. **The non-activating panel.** This is the main finding. Tauri cannot create an `NSPanel`. The community route is tauri-nspanel, which re-classes Tauri's NSWindow as a panel. That does not give non-activating behavior. I tested it: AppKit's `_preventsActivation` stays false after `setStyleMask:`, both on a re-classed window and on a real `NSPanel` whose style changes after creation. Only a panel created non-activating gets the flag. tauri-nspanel 2.1.1 fixes this with the private `_setPreventsActivation:`.
   - The trial uses no private API instead. It creates the panel natively and moves Tauri's WKWebView into it.
   - The price is that the notch sits outside Tauri's window model. Tauri's window for it is a hidden shell, so Tauri's position, focus, effects and scale events do not apply to the notch; objc2 drives the panel.
   - This relies on wry not caring which NSWindow holds its WKWebView. That is true in 2.12.6 but is not documented. I rate it medium fragility: pin Tauri and keep this check.
2. **Transparency** needs `macOSPrivateApi: true`, because Tauri clears WKWebView's `drawsBackground` through key-value coding. 1.2 makes the same call (`setValue(false, forKey: "drawsBackground")`), so this adds no new risk.
3. **Placement** goes through AppKit points (objc2) and not through Tauri's position API, which uses physical, top-left coordinates. This was easy.
4. **The page-drawn glow** approximates CoreAnimation shadows with an SVG blur. It assumes the blur's standard deviation equals the CA shadow radius, so it may need tuning by eye. Reduce Motion is handled in CSS. The live Reduce Transparency switch for the material is not built; it would be about 10 lines of objc2 or rely on the system material.
5. **The locked screen** affected the run. The window server reported window bounds scaled by 0.9 around the screen centre (the lock screen effect), while the AppKit frames were correct. Both benchmarks ran with hidden pages.

## Recommendation

**One host (Tauri), provided the morning checks pass.**

Strongest reason: everything that makes the notch special took about 55 lines of objc2, used only public API and gave identical geometry, and the rest of the host is Tauri API on both platforms. Two hosts would mean writing and maintaining about 1,200 lines of host twice. They would gain nothing measurable: the pass-through is as fast and memory is lower.

What would change this:
- `check.sh` 2b or 2d shows that a click or the shortcut path activates the trial, or that keys do not reach the field.
- The glow or backdrop captures cannot be matched.

Still unverified:
- real hover, click and keyboard focus
- other Spaces and full-screen apps
- how the glow and backdrop look
- live Reduce Motion and Reduce Transparency changes
- moving between displays
- Windows (not part of this trial)
- notification actions
- the updater migration from Sparkle's feed to Tauri's

## For the owner in the morning

1. If the release Tasktap is running, quit it. Its notch sits in the same place.
2. Run `trials/tauri-notch/check.sh`. It takes about 5 minutes and asks for three Enter presses. With Accessibility and Screen Recording granted to the terminal, the click, typing and drag steps are automatic. It types only after the trial's panel reports that it holds keyboard focus. Without those permissions it asks you to do the steps by hand.
3. Look at:
   - `captures/trial-rim-pulse.png` against `native-rim-pulse.png`, and the two `-steady` files
   - `backdrop-compare.png`
   - `trial-open.png` against `dev-open.png`
   - `trial-collapsed-window.png` against `dev-collapsed.png`
4. Check live:
   - 1d: the notch stays at the camera on another Space and over a full-screen app.
   - 2c: after the notch closes, typing goes back to TextEdit without a click.
