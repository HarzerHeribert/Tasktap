# Tasktap

Tasktap is a voice-first macOS menu-bar app for working with coding agents in your local projects. Press **Control + Option + Space**, speak, then press it again to finish. Review the proposed workspace, instruction and agent in the notch. Confirm to start the work.

![The decision rim expands around the Mac camera housing](design/notch-hover.gif)

## Build and run

Use macOS 26 or later, Xcode or the Command Line Tools with the macOS 26 SDK or newer, Python 3, and at least one signed-in agent CLI on your PATH. The build creates a locally signed app.

```sh
git clone https://github.com/HarzerHeribert/Tasktap.git
cd Tasktap
./scripts/build-mac.sh
open build/Tasktap.app
```

Install and sign into the providers you want to use. The commands are `claude` for Claude Code, `codex` for Codex, and `agy` for Antigravity. Tasktap uses their existing CLI credentials. You can also run the app for local notes without an agent. macOS asks for microphone access on first dictation. Apple may download a speech asset for your preferred language.

## Try it

1. **Start work.** Say “Ask Codex to explain the lighting setup in Glasshouse,” substituting a folder from your own `~/projects`. Tasktap shows the brief and destination. **Adjust** lets you correct either. If the destination is unclear, choose an existing folder, create one, or use Scratch.
2. **Nudge the same conversation.** Say “Tell the session working on lighting to check the reflections too.” Tasktap uses the task and project to find the conversation and asks you to choose when several match. Managed sessions run follow-ups in order after the current turn, using the provider’s conversation ID.
3. **Answer an agent.** The edge of the notch glows when someone needs you. Hover to peek or press **Control + Option + J**. Pick Yes, No, a named option, or **Talk it through**. The answer returns to the requesting session. The optional Codex Micro maps Yes and No to green and red keys directly. Every decision also works on the Mac.
4. **Get the result.** Read the agent’s report in the session or open it in Finder, Preview, or Xcode. Enable completion notifications or choose an exposed local Siri voice in Preferences. For offline English narration, choose **Set up Kokoro** in Preferences, then select Heart and preview the voice.
5. **Keep an idea.** File a note or drawing without starting an agent. Scratch notes can be assigned to a project later.

## How it works

The native AppKit host owns the nonactivating notch panel, menu-bar item, global shortcuts, microphone, notifications and USB HID controls. The workspace and compact review share a WKWebView interface. Apple Speech transcribes audio locally. Straightforward requests use local name and intent matching. For unstructured captures, Tasktap can use Apple’s on-device Foundation Models framework when available. The review works with either path. Notes, sketches, routing and narration stay on the Mac. Confirming an agent handoff gives your chosen CLI the brief, attached sketch coordinates and access to the selected workspace under its own settings.

Tasktap runs Claude Code and Codex through their structured CLI output and Antigravity over ACP. An owner-private on-disk queue stores each turn and its receipt under `~/Library/Application Support/Tasktap/Runs`. Each managed session gets a scoped MCP tool for questions. Provider-specific permissions can still require the provider’s own interface. Local notes are stored in the sibling `Notes` and `Scratch` folders. Temporary microphone recordings are removed after transcription.

Tasktap also discovers live, locally registered Claude Code and Codex surfaces in cmux under `~/projects`. It can send a confirmed nudge through the agent inbox when cmux permits the connection and the receiving agent supports messages. With cmux-only access, launch the built executable directly from a cmux terminal using `./build/Tasktap.app/Contents/MacOS/Tasktap`. A delivery receipt means cmux accepted the message. External sessions need their own question integration and do not stream completion reports to Tasktap. [cmux agent messaging](https://cmux.com/docs/changelog/0.65.0)

The workspace has native Mac window controls. Close it to return to the notch. Open **Projects** to see folders with a queued or running session, or a session waiting for input. **Show idle projects** includes the rest of your folders and remembers your choice. Open any available project and choose **Start session**, describe the task, then review the handoff. Voice routing can still find an idle folder by name. Preferences is also available directly in the menu bar.

Completed Claude Code and Codex sessions have **Resume in Terminal** and **Copy resume command**. These reopen the provider’s saved conversation in its working folder. Tasktap keeps the headless runner as its default and cmux as an optional integration.

### Model selection and live routing

Open **Preferences → Session models** to choose a default agent and a fixed model for each provider. Enable **Choose models by task difficulty** to map Quick, Standard and Complex tasks to your preferred models. Adjust the two thresholds on the 1–10 scale. Empty fields use the provider’s configured default. Adaptive selection starts off until you enable it.

The review shows the proposed model and estimated difficulty. **Adjust** accepts a model override for this launch. When available, Apple’s on-device model estimates the task scope. Local scope cues provide a fallback. Estimates are advisory and use the capture rather than a codebase inspection. Existing-session nudges use the conversation’s recorded model. Available model IDs depend on the installed CLI and account.

During an on-device call, the brief appears progressively beside an activity cue. **How this was routed** shows the source, destination evidence and model-selection explanation. **Review now** cancels the call and opens the locally prepared handoff. Preferences has separate switches for reading routing updates and completion summaries aloud. The written view remains available with speech off. [Apple response streaming](https://developer.apple.com/documentation/foundationmodels/languagemodelsession/responsestream)

### Referencing the foreground app

Say “this website” or “this file” during a capture. Tasktap remembers the source app and resolves the reference when you review. Supported Safari and Chromium browsers provide their active page URL. Finder provides one selected file. Other apps can provide a document URL through macOS Accessibility when access is available. An exact path inside a known project can suggest the destination.

The review displays the URL or path, its source, and **Change reference** and **Remove reference**. A blocked lookup or ambiguous selection offers manual entry or a file picker. macOS Automation access is requested through the explicit **Allow source app access** button. Preferences can turn reference lookups off.

This implementation captures reference metadata. Screenshot analysis, OCR, page contents, selected text and unsaved editor buffers remain future work. The selected agent can inspect the reviewed reference under its own permissions.

### What Tasktap can observe without installing hooks

| Session | Available signal | Where to act |
| --- | --- | --- |
| Started by Tasktap | Queue, current turn, final reply or failure, and questions submitted to the session’s question tool. Antigravity can also send supported one-time permission choices over ACP. | Review in the notch or workspace. |
| Existing Claude Code terminal or background session | Supported versions expose working, idle or waiting status and sometimes the reason through `claude agents --json`. | Answer in the original session. A waiting indicator alone carries no reply channel. |
| Existing Codex terminal or local Codex chat in ChatGPT | Tasktap checks recent indexed conversations in project folders and their recorded turn boundaries. A stale open turn shows **Last seen**. | Use the original terminal, or **Open in ChatGPT** for a desktop chat. Local storage formats vary by version. |
| Existing cmux surface | Tasktap uses existing cmux records and merges provider status when available. An open surface alone shows **Connected**. | A nudge requires a working cmux agent inbox. |
| Independently launched Antigravity session | Tasktap currently gets live ACP updates from sessions it launches. | Use the existing client for sessions it owns. |

Tasktap’s launcher passes its question tool in the arguments for that session. There is no global hook installation step. Project filtering and agent discovery are separate. A folder can be available for new work while its session activity is unknown. [Claude Code agent status](https://code.claude.com/docs/en/agent-view#list-sessions-as-json) · [Desktop chat links](https://learn.chatgpt.com/docs/app/commands) · [Antigravity ACP](https://antigravity.google/docs/cli/acp/)

## Design and verification

- During dictation, the glyph wave draws recent loudness from the active microphone recorder. Silence settles the glyphs onto a baseline. The wave clears when dictation ends. Each agent handoff uses Relay automatically. An illuminated carriage follows the reviewed provider’s rail when the handoff is submitted, queued, picked up by the runner and completed or delivered. A failure stops the light. The positions represent receipts. Reduce Motion uses steady states. [Dictation preview](design/voice-wave.png)
- A pending question lights the camera rim, including while Workspace is open. Answering or withdrawing the last question extinguishes it. A session waiting in an external terminal has its own status in Workspace.
- Choose the workspace and settings artwork under **Preferences → Artwork**. Glyph wave unfolds in traveling crests. A twist moves along the Phase field ribbon. Relay sends three carriages along braced chrome guides, and Signal globe rotates eight shell panels beneath a segmented gimbal and an orbiting lens. The original Blender Resonator is also available. Each choice includes a compact notch composition and a Reduce Motion poster. [Compare the four new studies](design/motion-studies.mp4)
- On a display with a camera housing, the rim follows the gap between the two top auxiliary areas and the safe top inset reported by macOS. The expanded panel reaches into the space on both sides, with controls below the camera. Displays without a cutout use a compact top-edge tab. [Apple’s screen geometry](https://developer.apple.com/documentation/AppKit/NSScreen/auxiliaryTopRightArea-gr2n)
- [Interaction flows and UI trees](docs/interaction-design.md) · [Requirements](docs/requirements.md) · [Keyboard, Micro and narration setup](docs/controls.md) · [Agent question protocol](docs/agent-questions.md)
- [Interactive browser demo](prototype/index.html) runs from disk with fictional data. Use the Mac app for dictation, real folders and agent execution.
- `python3 scripts/verify-style.py` checks design tokens. With Playwright and Chromium installed, `node scripts/verify-ui.cjs` exercises the interaction flows and regenerates the design screenshots. Set `BROWSER_EXECUTABLE` to use an existing Chromium installation.
- `node scripts/verify-model-policy.cjs` and `python3 scripts/verify-agent-models.py` check selection and resume invariants. `node scripts/verify-model-ui.cjs` checks saved preferences, review overrides and handoff payloads in the browser.
- `node scripts/render-motion.cjs` regenerates the four procedural studies using Playwright, Chromium and FFmpeg. The runtime plays bundled loops and posters offline. The Blender Resonator, posters and app icon ship in `prototype/assets/resonator`. `scripts/render-resonator.py` reproduces the Blender scene. Visible activity plays the miniature, and hidden or covered media pauses. Reduce Motion displays the still render.
- `node scripts/verify-voice-wave.cjs`, `node scripts/verify-relay.cjs` and `node scripts/verify-decision-rim.cjs` exercise the three live signals in Chromium with deterministic inputs.
- `build/Tasktap.app/Contents/MacOS/Tasktap --verify-interface` checks native hover, focus, shortcut dispatch and a question round trip using temporary data.
- `build/Tasktap.app/Contents/MacOS/Tasktap --verify-live` uses an authenticated Codex CLI to run a synthetic end-to-end capture in a temporary workspace. It consumes a real agent turn.
