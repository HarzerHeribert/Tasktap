# Tasktap

Tasktap is a voice-first macOS menu-bar app for working with coding agents in your local projects. Press **Control + Option + Space**, speak, then press it again to finish. Review the proposed workspace, instruction and agent in the notch. Confirm to start the work.

![A pending question expands below the Mac camera housing](design/notch-hover.gif)

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

The workspace has native Mac window controls. Close it to return to the notch. Open **Projects** to search the folder list. Preferences is also available directly in the menu bar.

Completed Claude Code and Codex sessions have **Resume in Terminal** and **Copy resume command**. These reopen the provider’s saved conversation in its working folder. Tasktap keeps the headless runner as its default and cmux as an optional integration.

Tasktap also lists recent local Codex chats from the ChatGPT desktop app in your projects. It reads the local desktop index and observes turn boundaries about every eight seconds. Chat titles and activity stay on this Mac. A stale open turn shows **Last seen**. **Open in ChatGPT** returns to the original chat for replies. This integration depends on the installed desktop version’s local file format. [Desktop chat links](https://learn.chatgpt.com/docs/app/commands)

## Design and verification

- [Interaction flows and UI trees](docs/interaction-design.md) · [Requirements](docs/requirements.md) · [Keyboard, Micro and narration setup](docs/controls.md) · [Agent question protocol](docs/agent-questions.md)
- [Interactive browser demo](prototype/index.html) runs from disk with fictional data. Use the Mac app for dictation, real folders and agent execution.
- `python3 scripts/verify-style.py` checks design tokens. With Playwright and Chromium installed, `node scripts/verify-ui.cjs` exercises the interaction flows and regenerates the design screenshots. Set `BROWSER_EXECUTABLE` to use an existing Chromium installation.
- `build/Tasktap.app/Contents/MacOS/Tasktap --verify-interface` checks native hover, focus, shortcut dispatch and a question round trip using temporary data.
- `build/Tasktap.app/Contents/MacOS/Tasktap --verify-live` uses an authenticated Codex CLI to run a synthetic end-to-end capture in a temporary workspace. It consumes a real agent turn.
