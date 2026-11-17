# Mac controls

The resident Mac app is built by running `./scripts/build-mac.sh`. Open the resulting app in `build/`. The collapsed camera housing stays blank. A thin amber edge pulses on the adjacent display pixels while a decision needs an answer. Reduce Motion keeps the edge steady. The menu-bar item carries the pending count. Pause over the camera housing or its tab to peek while continuing to type in the current app. Move away to retract the peek; click the tab to pin it. The detailed workspace opens through **Workspace**. Its return button restores the notch. The Mac app discovers folders under `~/projects`. The browser preview has its own sample data.

## Application menu

When Tasktap is active, the macOS application menu provides **File**, **Edit**, **View**, **Window** and **Help**. Use **⌘N** for a capture, **⌘O** to open a workspace, **⌘T** for a terminal in the selected pane, **⌥⌘T** for a browser preview, and **⌘D / ⇧⌘D** to split right or down. Pane commands are disabled outside a project or while a dialog is open. **⌘1–4** open Home, Notebook, Session History and Activity; **⌘B** toggles the sidebar, and **⌘,** opens Settings. The standard Edit commands follow the focused editor. Closing a view with **⌘W** keeps its terminal session running.

## Writing text in a terminal

Choose **Edit → Compose Text…** or **Tab actions → Compose text…** to draft prose for any CLI. The editor enables autocorrection and shows replacements with **Undo correction**. **Insert text** pastes into the chosen terminal at its cursor without sending Enter. Cancel keeps the draft for that terminal during the current app session. Multiline text requires the CLI to enable bracketed paste; otherwise use a single line.

Raw terminal input keeps autocorrection off and rejects native replacements of previously typed text with a visible notice. Tasktap does not infer whether a terminal prompt contains prose, a password or a shell command. Normal keyboard editing and IME composition remain available, and screen-reader support stays enabled.

## Keyboard shortcuts

The shortcuts below work from any app while Tasktap runs. Everything they do is also available with the pointer and voice.

| Control | Global shortcut | Effect |
| --- | --- | --- |
| Capture | Control + Option + Space | Tap to type. Hold to dictate in the notch and release to stop. Press ⌘ Return to review the draft. |
| Open pending | Control + Option + J | Reveal the first pending question. |
| Previous | Control + Option + K | Highlight the previous visible answer or routing target. |
| Next | Control + Option + L | Highlight the next visible answer or routing target. |
| Confirm | Control + Option + Return | Submit the highlighted choice, or send the text in Reply. |
| Defer / back | Control + Option + Escape | Dismiss the current card. A pending agent question remains in the queue. |
| Yes | Control + Option + Y | Answer the open yes/no question. |
| No | Control + Option + N | Answer the open yes/no question. |
| Reply | Control + Option + T | Focus Reply. Type or hold the microphone control to speak, then send. The same agent interprets the reply. Back returns to the unanswered card. |

The native app registers the six navigation shortcuts while running and registers Y, N and T only while the binary answers are visible. Close the app to release them. A registration conflict appears in its status menu. In the browser, chords work only while the page is active. VoiceOver, keyboard utilities and existing shortcuts can consume a chord even if registration succeeds.

## Narration

**Preferences → Voice → Read aloud → Narration voice** lists locally exposed Siri voices by language. Completion narration is opt-in. The local alternative is **Kokoro / Heart** for English. Choose **Set up Kokoro** to install the local voice (121 MB of model and voices plus the Python runtime). Setup uses uv or Python 3.10–3.12. Select **Local Kokoro / Heart** and **Preview voice** to test playback. The installed voice runs offline on demand. If you already run Kokoro-FastAPI on port 8880, Tasktap can use it without installing the model. The browser preview lists local Siri voices when available. [Kokoro ONNX](https://github.com/thewh1teagle/kokoro-onnx)

## Dictation setup

Open **Preferences → Voice → Dictation**, choose **Download & set up**, then allow microphone access. Test with **Try dictation**; the test never launches a coding agent. Apple dictation is the initial recommendation. **More options** offers Apple SpeechTranscriber and downloadable Whisper large-v3 Turbo, plus language overrides. Recommended follows future defaults, while explicit selections remain pinned. Apple engines use the Mac language by default and show live text; Whisper detects language by default and transcribes after release.

**Use a cloud provider instead** connects OpenAI, Deepgram, or ElevenLabs with a separate speech API key stored in macOS Keychain. Provider billing applies; recordings are sent only when cloud dictation is selected and the shortcut is released. Local dictation never silently falls back to cloud. Cancelled and completed recordings are removed. Speech recording is limited to five minutes. Reply language is independently configured under **Agents & connections → Reply language**; requests are preserved without automatic translation.

## System notifications

Choose **Notifications → Enable notifications** in the native status menu. macOS handles the initial permission dialog, presentation and Focus. Requests offer **Review in notch** and completions offer **View result**. Dismissing an alert leaves the agent decision pending. A resolved request withdraws its delivered alert. Turning off app alerts retains the notch and menu-bar queue. The browser shows a local notification preview. [Apple actionable notifications](https://developer.apple.com/documentation/usernotifications/declaring-your-actionable-notification-types)

## Hands-on acceptance check

| Check | Expected outcome |
| --- | --- |
| Browser closed, Finder active, app running | The capture shortcut opens the notch. |
| Choose a material with Previous, Next and Confirm | The highlight moves visibly and exactly one session log entry records the answer. |
| Two pending approvals | Defer the first, reopen, and answer the second; the first remains pending. |
| Deliver a notification under the current Focus settings | The alert opens the same ID; dismissal or a stale action cannot answer another question. |

The scripted native smoke test dispatches the same actions that registered shortcut events use. Physical key presses and local notification delivery need a hands-on check with the user's configuration.
