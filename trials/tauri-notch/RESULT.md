# Tauri notch trial: result

**Kept as the record of the one-host decision.** The trial's code (`check.sh`, `src-tauri/`, `tool/`, `ui/`) compiled 1.2's Swift sources and loaded 1.2's stylesheets, so it was removed with them at the repository cutover; it is in the history at commit `4b6408f`. What it proved lives on in `host/src/notch.rs`, `native.rs` and `geometry.rs`. The measurements in `captures/` are the ones this result cites; the pictures it names were never committed.

Run on 2026-11-17 on a MacBook Pro (M4 Pro, built-in display 1800×1169 pt with a camera cutout), Darwin 27.0. Tauri 2.12.6 (wry 0.57.2, tao 0.37.2), objc2 0.6.5 and objc2-app-kit 0.3.2.

The first run had the screen locked. The owner then ran `check.sh` unlocked, and a follow-up the same day measured the two failed focus checks against Tasktap Dev 1.2 (see [Keyboard focus against 1.2](#keyboard-focus-against-12)). Both are folded in below.

## The six items

| # | Item | What Tauri needed | Status | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Placement at the cutout, above the menu bar, on all Spaces | Tauri has no API for window level 26, full-screen auxiliary, AppKit-point frames or the camera-housing rectangles. Those come from objc2. `NotchGeometry.swift` is ported line for line to Rust (52 lines). | PASS (API checks). NEEDS-EYES: other Spaces and full-screen apps | The Rust port prints the same tab and frames as `NotchGeometry.swift` for the 14 synthetic displays of `verify-notch-geometry.swift` and for the live display (the diff is empty). Panel level 26, window server layer 26, collection behavior 257 (all Spaces + full-screen auxiliary), frame 777,1115,246,54, which is 1.2's collapsed frame. |
| 2 | Reveal without stealing focus | A Tauri window cannot be a non-activating panel. objc2 creates a real `NSPanel` (borderless, non-activating from the start, plus a subclass that can become key) and moves Tauri's WKWebView into it. Tauri's own window stays hidden. Hover uses the same 80 ms pointer poll and `ignoresMouseEvents` rule as `main.swift`, through objc2. | PASS, unlocked, against 1.2 | Hover: the notch opened, the trial stayed inactive and TextEdit's focused element was unchanged. Drag: the pointer crossed the tab 5 times with a button held and the notch stayed closed. Click into the field and the shortcut path: text reached the field; TextEdit stayed frontmost, kept the menu bar and its active title bar; the trial never became the active application. Tasktap Dev 1.2 measured the same way gives identical values. After the notch closes, typing returns to TextEdit in the trial but goes into the closed notch in 1.2 (fixed in the trial, 5 lines). |
| 3 | Decision glow | No native code. An SVG in the page redraws the CoreAnimation layers with the values from `WorkspaceDecisionRim.swift`: metal gradient stroke at 0.1, halo, bloom, the 0.62 to 0.9 pulse (600 ms, twice) and Reduce Motion. | NEEDS-EYES | Captures from the unlocked run: `captures/trial-rim-*.png` against `captures/native-rim-*.png` (the native ones drawn by the real 1.2 class). The steady captures look the same to me; the owner decides. |
| 4 | Translucent backdrop | No native code: Tauri `windowEffects` (`underWindowBackground`, `followsWindowActiveState`) plus the CSS tint #0d1117 at 0.93. WebKit supports `prefers-reduced-transparency`, so the tint can follow Reduce Transparency. | NEEDS-EYES | `captures/backdrop-compare.png`: Tauri on the left, the real `WorkspaceBackdrop` on the right. Both show the same tint. Over the dark terminal behind them the blur can't be compared; look over a bright background. |
| 5 | Content | A custom protocol serves the page and the prototype styles from the repository. This is for the trial only; the app would bundle them. The page links `../../../prototype/style.css` and `decision.css` unchanged. | NEEDS-EYES | `captures/trial-open.png` shows the card and field on the same black sheet, type and rounding as 1.2's notch in `captures/dev-open.png`. The content differs on purpose: a test card against 1.2's home. |
| 6 | Pass-through measurements | Built-in commands, channels, events and an asynchronous custom protocol. | PASS (measured) | See [Pass-through numbers](#pass-through-numbers). |

## Lines of code

Lines below are non-blank and non-comment.

**The trial:**
- **Rust:** 383 lines.
  - `main.rs` has 219. About 125 are notch glue and about 95 are measurement and test scaffolding (bench commands, stdin commands, the file server).
  - `geometry.rs` has 82: 52 for the port and 30 for test cases and printing.
  - `native.rs` has 82 (see the next line).
- **Native code:** the 82 objc2 lines in `native.rs`: 60 for the panel, pointer, focus and handing the keyboard back, and 22 for diagnostics and the check. No Swift ships in the app. Only public API drives behavior. The diagnostic probe reads AppKit's private `_preventsActivation` getter to report the flag; nothing depends on it.
- **Config:** 40 lines (`Cargo.toml` 19, `tauri.conf.json` 13, capability 5, `build.rs` 3).
- **Page:** 86 lines (`notch.html` 34, `notch.css` 11, `notch.js` 41), plus `backdrop.html` 10 and the bench page 70.
- **Test tools:**
  - `tool/main.swift`, 239 lines: the 1.2 reference helper, built from the 1.2 sources, plus the outside focus measurements.
  - `tool/probe.m`, 32 lines: the inside focus probe, injected into both apps.
  - `check.sh`, 308 lines.

**The same surface in 1.2:** `NotchGeometry` 71 + `WorkspaceDecisionRim` 110 + `WorkspaceBackdrop` 64 + about 90 lines of panel, position and hover in `main.swift`, so about 335 Swift lines. One host would need about 235 Rust lines (60 of them objc2) plus about 50 lines of SVG, CSS and JS.

**Today's Swift against a single Tauri host.** These are rough figures from the files and from the sections of `main.swift`:

| Today (5,039 Swift lines: `native/` plus the speech helper) | Lines | In a single Tauri host |
| --- | --- | --- |
| Moves to the core under either option: sessions, routing, router connection, handoff, inbox, terminals, folders, cloud speech, model server, names, Ghostty colors, result documents, the logic of the UI message router, in-app verification | ~2,870 | not host code |
| Host abilities Tauri covers: windows and web view hosting, app menu and status item, global shortcuts (press and release), updater, launch at login, single instance, file panels, link policy, the preview scheme, the menu mark | ~900 | Tauri APIs and official plugins; the preview scheme becomes about 100 lines of Rust |
| Notch panel, geometry, glow, backdrop | ~335 | about 235 Rust lines (60 objc2) plus page SVG and CSS (this trial) |
| Local speech: `Dictation`, `SpeechService`, `SpeechPreferences`, `Narration`, the `tasktap-speech` helper | 685 | kept in Swift, because WhisperKit is Swift-only. It already runs partly as a separate helper. |
| Screen context (Accessibility, Apple Events) | 209 | kept: a Swift helper, or about 200 lines of objc2 |
| Notification action buttons | ~40 | probably kept native: as far as I can tell the official notification plugin offers actions only on mobile (not tested) |

So one host replaces about 1,200 lines of today's host Swift and keeps about 930 Swift lines plus 60 to 100 objc2 lines. With two hosts, the ~1,200 host lines are written and kept twice: once in Swift and once in Rust for Windows.

## Binary size and idle memory

Measured unlocked, 20 s after launch with nothing touched. Both apps have two web views: the trial's notch plus its backdrop window, and 1.2's notch plus its workspace.

| | Tauri trial | Tasktap Dev 1.2 |
| --- | --- | --- |
| Executable | 4.4 MB (release, LTO, stripped; Tauri, wry, tao and objc2 included) | 1.9 MB Swift host + 2.9 MB Sparkle framework. The whole bundle is 26 MB, mostly the 15 MB prototype folder and the 5.2 MB speech helper. |
| Host process, footprint | 27 MB | 31 MB |
| Host process, resident size | 97.5 MB | 100.5 MB |
| WebKit processes, footprint | WebContent 14 + 14 MB, GPU 13 MB, Networking 6 MB | WebContent 96 + 57 MB (full app pages), GPU 16 MB, Networking 8 MB |
| Total footprint | 74 MB | 208 MB |
| Idle CPU over 10 s | 0.02 s | 0.11 s |

After the focus steps of `check.sh`, the trial host was 27 to 29 MB footprint (108 MB resident) against 37 to 38 MB (117 to 119 MB resident) for 1.2. Idle CPU over 5 s was 0.1 to 0.6% against 1.8 to 2.3%. The locked run gave the same host footprints to within 5 MB.

The WebContent numbers compare pages, not hosts: the trial page is tiny, and 1.2 loads the whole app twice.

**Which measure is fair.** Footprint is fair; resident size is not.
- Resident size counts every resident page mapped into the process, including the shared system code (AppKit, WebKit, the dyld shared cache) that every app maps and the system holds only once. It also moves with what was touched and when the sample was taken.
- The owner's run sampled 1.2 just after launch and the trial at the end of a long sequence. That is why it printed 113.2 MB for the trial against 96.6 MB for 1.2.
- Footprint, the Memory column in Activity Monitor, counts only the process's own dirty and compressed memory. It is stable across runs, and it puts the trial host 4 to 10 MB below 1.2.
- The 0.1% and 1.3% CPU the owner saw came from `ps`, which averages over the whole process life including startup. `check.sh` now prints both measures and samples CPU over 5 s of idle with `top`.

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

Unlocked, the numbers hold to within about 15% (raw results of the follow-up run: `captures/bench-*.json`):

| | Owner's run | Follow-up run |
| --- | --- | --- |
| Tauri channel, raw bytes, 64 KiB | 663 MB/s | 711 MB/s |
| Tauri custom protocol, one streamed response | 2,909 MB/s | 2,667 MB/s |
| Tauri `invoke` round trip | 0.148 ms | 0.143 ms |
| Swift 1.2 path, awaited, 64 KiB | 634 MB/s | 653 MB/s |
| Swift 1.2 round trip | 0.099 ms | 0.112 ms |

Tauri's channels and events have no backpressure. A terminal would add an acknowledgement through `invoke`, about 0.15 ms per batch.

Neither number decides the question. Every mechanism except the JSON number array runs far faster than a terminal renders, and all round trips stay well under a millisecond against a 16 ms frame. The best Tauri choices for terminal output are a channel with raw bytes (for small frames, twice 1.2's awaited path) or base64 events.

## Keyboard focus against 1.2

**What failed and why.** The owner's run failed 2b (click into the field) and 2d (the shortcut path) with `trialActive=True` while TextEdit stayed frontmost. `trialActive` was `NSApp.isActive`, read inside the trial; "frontmost" was `NSWorkspace.frontmostApplication`, read in the same process. The check expected `NSApp.isActive` to stay false. 1.2 had never been measured that way.

**How it is measured now.** The same way for both apps, at each step:
- **Inside the process:** `tool/probe.m`, injected into both apps with `DYLD_INSERT_LIBRARIES`. It logs `NSApp.isActive`, `NSRunningApplication.currentApplication.isActive`, the key window and every activation notification. On "will become active" it also logs the call stack.
- **Outside, from `trialtool state`:**
  - `NSRunningApplication(pid).isActive`
  - `NSWorkspace.frontmostApplication`
  - `menuBarOwningApplication`
  - the system-wide accessibility "focused application", which is where keystrokes go
- **What the person sees:** whether TextEdit's document window still shows its red close button, meaning an active title bar.
- **After the notch closes:** a marker is typed and TextEdit's text is read back through accessibility.
- **The 1.2 steps:** 2b clicks 1.2's own notch field after a hover. 2d presses 1.2's real Ctrl-Option-Space. Nothing is ever submitted in 1.2.

Results of the final unlocked run (`captures/focus.jsonl`; earlier runs agree):

| Moment | Measure | Trial | 1.2 |
| --- | --- | --- | --- |
| Field focused by a click, or by the shortcut path | `NSApp.isActive` (inside) | true | true |
| | `NSRunningApplication.isActive` (outside) | false | false |
| | frontmost app and menu bar owner | TextEdit, TextEdit | TextEdit, TextEdit |
| | notch panel is key; typed text reaches the field | yes; yes | yes; yes |
| | TextEdit's title bar still active | yes | yes |
| After the notch closes | typed keys go to | TextEdit | the closed notch |

**The trial and 1.2 report the same, so the old expectation was wrong.** AppKit sets `NSApp.isActive` to true whenever one of the app's windows is key, including a non-activating panel. The app is not activated:
- no "will become active" or "did become active" notification is posted
- `NSRunningApplication.isActive` stays false
- the frontmost app and the menu bar do not change

A plain AppKit panel with no Tauri at all (`trialtool panelprobe`) behaves the same, with the accessory and the regular activation policy alike. Against the reference, 2b and 2d pass.

**Nothing activates the trial.** Across every run the trial's probe logged no "will become active" notification. AppKit posts it for every activation, whatever API causes it. Tauri's stack has only three activation calls:
- tao at launch, set to `activateIgnoringOtherApps(false)` by the trial
- tao's `Window::set_focus`, which the trial never calls
- wry, when a web view is created visible and focused; the trial creates it hidden and unfocused

**2c: an old 1.2 defect, fixed in the trial.**
- In 1.2 the notch panel stays key after it closes. Typing then goes into the closed notch until the person clicks their app again.
- The trial did the same at first. The fix: when the notch folds while its panel is key, the panel is ordered out and straight back in (`give_back_key` in `native.rs`, 5 lines, public API). The keyboard returns to the TextEdit document.
- `check.sh` now types a marker after each close: it lands in TextEdit for the trial and in the closed notch for 1.2. This is the only user-visible difference measured, and it favours the trial. The rebuild should keep the fix.

**Measurement notes.**
- The system "focused application" attribute lagged behind the trial's key panel in 2 of 4 samples, although the text always arrived; for 1.2 it never lagged. VoiceOver was not tested.
- The first title-bar capture, taken right after the test document opened, read inactive once for the trial.
- `./check.sh focus` reruns only this comparison, in about 2 minutes. It opens its own document in TextEdit and types only while the intended process holds the keyboard.

## Hard or fragile

1. **The non-activating panel.** This is the main finding. Tauri cannot create an `NSPanel`. The community route is tauri-nspanel, which re-classes Tauri's NSWindow as a panel. That does not give non-activating behavior. I tested it: AppKit's `_preventsActivation` stays false after `setStyleMask:`, both on a re-classed window and on a real `NSPanel` whose style changes after creation. Only a panel created non-activating gets the flag. tauri-nspanel 2.1.1 fixes this with the private `_setPreventsActivation:`.
   - The trial uses no private API instead. It creates the panel natively and moves Tauri's WKWebView into it.
   - The price is that the notch sits outside Tauri's window model. Tauri's window for it is a hidden shell, so Tauri's position, focus, effects and scale events do not apply to the notch; objc2 drives the panel.
   - This relies on wry not caring which NSWindow holds its WKWebView. That is true in 2.12.6 but is not documented. I rate it medium fragility: pin Tauri and keep this check.
2. **Transparency** needs `macOSPrivateApi: true`, because Tauri clears WKWebView's `drawsBackground` through key-value coding. 1.2 makes the same call (`setValue(false, forKey: "drawsBackground")`), so this adds no new risk.
3. **Placement** goes through AppKit points (objc2) and not through Tauri's position API, which uses physical, top-left coordinates. This was easy.
4. **The page-drawn glow** approximates CoreAnimation shadows with an SVG blur. It assumes the blur's standard deviation equals the CA shadow radius, so it may need tuning by eye. Reduce Motion is handled in CSS. The live Reduce Transparency switch for the material is not built; it would be about 10 lines of objc2 or rely on the system material.
5. **The locked screen** affected the first run. The window server reported window bounds scaled by 0.9 around the screen centre (the lock screen effect), while the AppKit frames were correct. Both benchmarks ran with hidden pages.
6. **`NSApp.isActive` is the wrong test for a non-activating panel**, in any host (see above). The right tests are `NSRunningApplication.isActive`, the frontmost app and the menu bar owner.
7. **The backdrop window** is created unfocused, so other windows can cover it. `check.sh` now orders it to the front without activating it before the capture.

## Recommendation

**One host (Tauri).**

Strongest reason: on the unlocked screen, the notch's focus behavior measures the same as 1.2 in every way the person can see, and better after closing. Everything that makes the notch special took about 60 lines of objc2, used only public API and gave identical geometry. The rest of the host is Tauri API on both platforms. Two hosts would mean writing and maintaining about 1,200 lines of host twice. They would gain nothing measurable: the pass-through is as fast and memory is lower.

What would still change this: the glow or backdrop captures cannot be matched by eye.

Still unverified:
- the glow, backdrop and content by eye
- other Spaces and full-screen apps
- whether the brief order-out and order-in at fold is visible on the collapsed tab
- VoiceOver focus
- live Reduce Motion and Reduce Transparency changes
- moving between displays
- Windows (not part of this trial)
- notification actions
- the updater migration from Sparkle's feed to Tauri's

## What is left for the owner

1. If the release Tasktap is running, quit it. Its notch sits in the same place.
2. Run `trials/tauri-notch/check.sh` if you want fresh captures. It takes about 5 minutes and asks for one Enter press. It drives the mouse and keyboard for about 2 minutes, so keep your hands off until it prints "Hands free again". Captures from the follow-up run are already in `captures/`; they stay local and are not committed.
3. Look at:
   - `captures/trial-rim-pulse.png` against `native-rim-pulse.png`, and the two `-steady` files
   - `backdrop-compare.png`
   - `trial-open.png` against `dev-open.png`
   - `trial-collapsed-window.png` against `dev-collapsed.png`
   - for the backdrop, judge it over a bright background
4. Check live:
   - 1d: the notch stays at the camera on another Space and over a full-screen app.
   - Whether the collapsed tab visibly blinks when the notch closes after you typed in it.
