# Tasktap

[Tasktap for Mac](https://harzerheribert.github.io/Tasktap/) · [User guide](https://harzerheribert.github.io/Tasktap/docs/)

Tasktap is a voice-first macOS menu-bar app for working with coding agents in your local projects. Type a request in the notch, or hold **Control + Option + Space** to dictate and release to finish. Review the proposed workspace, instruction and agent in the notch. Confirm to start the work.

![The decision rim expands around the Mac camera housing](design/notch-hover.gif)

## Build and run

Prebuilt community packaging and signed in-app updates are supported. Use **Check for Updates…** in the menu bar. Release maintainers: see [release instructions](docs/releases.md). The optional [installer](site/install.sh) accepts an explicit published version. Community builds are not Apple notarized; Python 3 and agent CLIs remain runtime requirements.

Use macOS 26 or later, Xcode or the Command Line Tools with the macOS 26 SDK or newer, Python 3, and at least one signed-in agent CLI on your PATH. The build creates a locally signed app.

```sh
git clone https://github.com/HarzerHeribert/Tasktap.git
cd Tasktap
./scripts/build-mac.sh
open build/Tasktap.app
```

Install and sign into the providers you want to use. Tasktap supports `claude` (Claude Code), `codex`, `agy` (Antigravity), `cursor-agent` (Cursor CLI) and `pi` (Pi coding agent). Tasktap uses their existing CLI credentials. You can also run the app for local notes without an agent. macOS asks for microphone access on first dictation. Apple may download a speech asset for your preferred language.

## Try it

On a new install, setup lets you configure file and website references, who prepares your requests, your default agent and terminal, notch artwork, and spoken results. Preparation can use your Mac, your Codex login, Ollama, or another configured provider. The agent that runs the reviewed task uses its own account. Choose **Save & try capture** or **Set up later** to open the notch. Revisit your choices from the Tasktap menu bar icon → **Run Setup…** or **Preferences → Run setup…**. The notch offers a project discovered in `~/projects`. Click its name to change folders. Type your request and click **Review** (or press **⌘ Return**). Examples roll inside the empty text box and disappear as you type. The review identifies a new session or a follow-up. **Back to capture** in the project chooser preserves your text. From any app, tap **Control + Option + Space** to type in the notch, or hold it to dictate. Words appear as you speak. Release to stop, then edit or press **⌘ Return** to review. You can also hold the **Hold to talk** button with the pointer or focus it and hold Space. **New Capture** in the menu bar opens the editor for typing. **Start session** launches the agent. The receipt offers **Open in [terminal]** and **Nudge session** for that same conversation. If the agent uses clipboard delivery, paste the reviewed follow-up at its prompt and press Return. Choose **Done** to finish. Later app launches open Workspace. Replay from **Preferences → Capture → Reopen guided capture**.

1. **Start work.** Say “Ask Codex to explain the lighting setup in Glasshouse,” substituting a folder from your own `~/projects`. Tasktap shows the brief and destination. **Adjust** lets you correct either. If the destination is unclear, choose an existing folder, create one, or use Scratch.
2. **Nudge the same conversation.** Say “Tell the session working on lighting to check the reflections too.” Tasktap uses the task and project to find the conversation and asks you to choose when several match. Tasktap uses the original conversation’s inbox when available. For a session without an inbox, choose **Copy nudge & open session**, paste into the agent prompt, and press Return.
3. **Answer an agent.** The edge of the notch glows when someone needs you. Hover to peek or press **Control + Option + J**. Pick Yes, No, a named option, or **Talk it through**. The answer returns to the requesting session. The optional Codex Micro maps Yes and No to green and red keys directly. Every decision also works on the Mac.
4. **Get the result.** Read the agent’s report in the session or open it in Finder, Preview, or Xcode. Enable completion notifications or choose an exposed local Siri voice in Preferences. For offline English narration, choose **Set up Kokoro** in Preferences, then select Heart and preview the voice.
5. **Keep an idea.** File a note or drawing without starting an agent. Scratch notes can be assigned to a project later.

### Working on one project together

When other sessions are working in the same checkout, expand the session count in review to see their tasks. You can open those sessions from session details. A new worker receives a snapshot of nearby work. Tasktap-managed Claude Code and Codex workers can also ask for an updated list of active Tasktap workers in that checkout.

New sessions start in the selected folder. Tasktap asks workers to use its current branch and commit their own changes in focused checkpoints, following your instructions and the repository's conventions. You can give a worker different Git instructions in the brief. Tasktap creates no branches or worktrees and leaves staging and commits to the worker.

## How it works

The native AppKit host owns the nonactivating notch panel, menu-bar item, global shortcuts, microphone, notifications and USB HID controls. The workspace and compact review share a WKWebView interface. Apple Speech transcribes audio locally. Straightforward requests use local name and intent matching. For unstructured captures, Tasktap can use Apple’s on-device Foundation Models framework when available. The review works with either path. With the default routing setting, capture preparation, notes and narration stay on the Mac. Confirming an agent handoff gives your chosen CLI the brief, attached sketch coordinates and access to the selected workspace under its own settings.

Tasktap opens your selected coding agent as an interactive CLI in the reviewed folder. Use **Preferences → Session models → Open new sessions in** to select Terminal (default), cmux, Ghostty, iTerm2, Warp, WezTerm or kitty. Tasktap reads installed app icons from macOS and marks missing choices. **Adjust → Terminal for this session** changes one handoff. Open **Sessions**, choose the task and use **Open in …** to take over while it works. Closing Tasktap leaves the terminal under your control. The provider handles approvals in its own UI. [Codex interactive CLI](https://learn.chatgpt.com/docs/codex/cli)

[Preview the terminal picker](design/terminal-picker.png)

For a new Codex session, **Trust this folder for this Codex session** carries your decision from the handoff review into the visible terminal. Review shows the folder because its project settings can run code. Clear the checkbox to let Codex apply its saved trust decision or ask in the terminal. Tasktap applies this choice to one launch. Codex uses its automatic approval reviewer with the workspace-write sandbox. Claude Code requests Auto mode, subject to model availability and organization policy. Follow-ups keep the original session’s permissions.

When Claude opens a folder for the first time, answer its trust prompt in the terminal. The notch offers **Open in Terminal** during startup and **Nudge session** once Tasktap observes a Claude turn. Apple Terminal may ask for Automation permission on first launch. Its dedicated Tasktap window closes after a clean CLI exit. A failure or a window with additional tabs stays open.

On Warp, **Reattach in Warp** opens another tab on the same agent using the copy of GNU screen included with macOS. Ghostty and iTerm2 address the original surface or session, and WezTerm and kitty address the recorded pane or window. Each host runs the same interactive worker. Closing Warp’s last attached view ends the worker. [Ghostty scripting](https://ghostty.org/docs/features/applescript) · [WezTerm pane activation](https://wezterm.org/cli/cli/activate-pane.html) · [kitty remote control](https://sw.kovidgoyal.net/kitty/remote-control/)

The private queue under `~/Library/Application Support/Tasktap/Runs` records the reviewed text, routing evidence and delivery receipts. **Opened** means the terminal launched the agent, **Delivered** means its inbox accepted a nudge, and **Copied** means you still need to paste it. Claude Code and Codex can use Tasktap’s session-scoped question and completion tools. A **Complete** result comes from an agent report or from the saved final answer to an exactly matched Codex follow-up. Antigravity, Cursor CLI and Pi show decisions and replies in their terminals. For follow-ups, Tasktap copies your reviewed nudge and opens the original terminal. If there is no report, read the outcome in the original session. Local notes are stored in the sibling `Notes` and `Scratch` folders.

Tasktap also discovers live, locally registered Claude Code and Codex surfaces in cmux under `~/projects`. It can send a confirmed nudge through the agent inbox when cmux permits the connection and the receiving agent supports messages. With cmux-only access, launch the built executable directly from a cmux terminal using `./build/Tasktap.app/Contents/MacOS/Tasktap`. A delivery receipt means cmux accepted the message. External sessions need their own question integration and do not stream completion reports to Tasktap. The cmux CLI uses the same socket API and access rules as a direct JSON client. Tasktap creates a named workspace and addresses the specific surface on return. Standalone Ghostty uses its own macOS integration. [cmux API](https://cmux.com/docs/api) · [cmux agent messaging](https://cmux.com/docs/changelog/0.65.0)

The workspace has native Mac window controls. Close it to return to the notch. Open **Projects** to see folders with a queued or running session, or a session waiting for input. **Show idle projects** includes the rest of your folders and remembers your choice. Open any available project and choose **Start session**, describe the task, then review the handoff. Voice routing can still find an idle folder by name. Preferences is also available directly in the menu bar.

Earlier Tasktap sessions keep their capture history. Eligible completed Claude Code and Codex conversations from earlier builds offer **Resume in Terminal** and **Copy resume command**.

Tasktap closes its Codex and Claude Code workers after their handoffs are settled and the saved conversation confirms the last turn finished. A pending follow-up or question keeps the worker open. In **Workspace → Sessions**, search for a project, task, agent or result. Select the matching run to read its handoffs and use **Resume in** to reopen the same conversation in its original terminal. A conversation you explicitly reopen stays open for you.

### License

Tasktap is source-available under the Apache License 2.0 with the Commons Clause. You can use it at work, modify it and share free forks with the license and notices. Selling Tasktap or charging for a service whose value comes substantially from Tasktap requires separate permission. Third-party tools retain their own terms. [Full license](LICENSE)

### Request preparation and project work

Open **Preferences → Agents → Request preparation**. **Prepare requests with** controls who interprets a request. **Session models** controls which coding agent then does the work. A local capture can go to a paid worker. A cloud-prepared note can consume routing allowance even if you never start a worker.

| Preparation route | Account used |
| --- | --- |
| On this Mac (default) | Apple’s available on-device model and local matching. No cloud inference charge. |
| Model server | Choose Ollama, vLLM, LiteLLM or a custom compatible endpoint. The review shows the server and model. The server operator determines any upstream processing and charges. |
| ChatGPT plan | **Continue with ChatGPT** opens OpenAI’s consent screen. OpenAI lists personal local projects, open-source projects and approved apps. Public source alone does not establish eligibility for a distributed Tasktap build. [Sign-in and eligibility](https://developers.openai.com/siwc/token-sharing-open-source) |
| Claude Code (interactive) | Copy the request and open Claude Code in Terminal. Submit it using the account signed in there, then return to Tasktap for the finished brief. A personal Claude plan can cover this conversation. The project agent is chosen separately. |
| Installed Codex | Uses the standard CLI login from `codex login`. A ChatGPT login and a platform API key have different billing. The routing invocation skips custom user configuration and runs in a temporary directory. [Codex authentication](https://learn.chatgpt.com/docs/auth) |
| OpenAI API key or Anthropic API key | Enter your key and use the suggested routing model or replace its ID. Tasktap saves the key in Mac Keychain. The provider bills the project or organization that issued it. |
| Claude Code with cloud billing | Uses the installed Claude CLI in bare mode with Bedrock, Google Cloud or Microsoft Foundry. Configure one provider in Tasktap’s launch environment (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` or `CLAUDE_CODE_USE_FOUNDRY`) plus that provider’s credentials. A Finder launch may have a different environment from Terminal. [Claude cloud integrations](https://code.claude.com/docs/en/third-party-integrations) |

When a capture needs remote preparation, the app shows the connection and the text and matching labels it would send. **Prepare on this Mac** uses local matching. The remote request excludes audio, sketch points and resolved reference attachments. Text you explicitly dictate or type can itself contain a link or path. Simple captures and explicit session nudges can skip remote preparation altogether. A failed or interrupted request may consume allowance. Tasktap offers local recovery and never fails over to a different paid connection automatically.

The final review names **Preparation** and **On confirm**. Worker credentials come from the selected CLI. Open **Preferences → Agents → Agent setup** to check installed agents. A missing installation links to its guide. A signed-out agent offers its own sign-in flow. CLI login information is a setup signal. Organization policy, custom provider configuration and credentials available to the process determine the actual bill. External cmux sessions use their original client’s account.

Tasktap’s ChatGPT registration, routing API keys and model-server settings apply only to preparing a capture. The worker uses the agent’s own login. In the workspace, **View handoff** shows the request and any reported result. When the handoff wording changed, **Original wording** preserves the original capture.

Claude subscription workers run Anthropic’s installed, unmodified Claude Code with the user’s direct login. A Tasktap-managed Anthropic routing call uses API or cloud credentials. [Claude Code credential terms](https://code.claude.com/docs/en/legal-and-compliance)

### Connect a model server

In **Preferences → Agents → Request preparation**, choose **Model server** under **Prepare requests with**. Pick a preset, check the base URL and click **Find models**. Choose a chat-capable model, then **Save connection**. If a gateway hides its model catalog, choose **Enter model ID** and enter the configured alias. Listing models sends no capture text.

[Preview the model server wizard](design/model-server-setup.png)

| Preset | Default base URL | Credentials |
| --- | --- | --- |
| Ollama | `http://localhost:11434/v1` | A stock local installation accepts an empty key. A hosted installation or proxy may require one. [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility) |
| vLLM | `http://localhost:8000/v1` | Supply the real bearer key if the serving operator configured one. Choose a served model with a chat template. [vLLM serving quickstart](https://docs.vllm.ai/en/stable/getting_started/quickstart/) |
| LiteLLM | `http://localhost:4000/v1` | Enter a virtual key when required and select the proxy’s model alias. The proxy can forward locally or to a paid upstream. [LiteLLM proxy](https://docs.litellm.ai/docs/simple_proxy) · [Virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys) |
| Other | Your server’s base URL | Use a server implementing `GET models` and `POST chat/completions` under its API base, or enter the model manually when listing is unavailable. |

A bare host with a port such as `localhost:11434` resolves to the versioned base. For another machine, enter its full URL including the scheme and any gateway prefix. Tasktap adds the operation path and sends an Authorization header only when a key is supplied. Saved keys live in Mac Keychain and are bound to the exact base URL and preset. To remove a saved key, edit that connection, clear **Use the key saved for this address**, and save.

The capture review shows the endpoint and model before sending. A loopback address identifies the first hop. Downloaded Ollama models can run on the Mac, while cloud models and proxy aliases can forward requests. **Prepare on this Mac** still uses Tasktap’s built-in local matching. The model-server setting applies to capture preparation. Coding sessions continue through the selected worker.

### Model selection and live routing

Open **Preferences → Agents → Agent routing** to enable **Choose by remaining usage** for fresh sessions. Check the agents Tasktap may use, rank them and set a reserve (initially 10%). The first eligible agent that meets the reserve wins. If none qualifies, an enabled agent with unreported quota can be suggested. If all available ranked agents are below reserve, review asks you to choose. By default, Tasktap keeps your chosen agent. Naming an agent explicitly takes precedence over ranking.

**Agent & model** in the handoff review lets you pick a different worker or model. With ranking enabled you can also change the reserve just for this handoff. Nudges keep the original worker and model. The reserve guides selection at review time and does not cap how much a running task spends.

Tasktap reads Claude and Codex plan windows using their installed CLIs, without a model turn or a global hook. It uses the tightest reported account-wide window, discards expired readings and checks again after two minutes. Model-specific allowances, paid overage and multi-account quota switching are outside this estimate. Some Claude versions lack the experimental usage request. Agents without a usable reading show **Quota unavailable**. [Codex app-server rate limits](https://learn.chatgpt.com/docs/app-server) · [Claude Code usage](https://code.claude.com/docs/en/commands) · [Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters) · [Pi CLI](https://docs.pi.dev/latest/cli)

Open **Preferences → Session models** to choose a default agent and a fixed model for each provider. Enable **Choose models by task difficulty** to map Quick, Standard and Complex tasks to your preferred models. Adjust the two thresholds on the 1–10 scale. Empty fields use the provider’s configured default. Adaptive selection starts off until you enable it.

The review shows the proposed model and estimated difficulty. **Adjust** accepts a model override for this launch. When available, the selected routing model estimates the task scope. Local scope cues provide a fallback. Estimates are advisory and use the capture rather than a codebase inspection. Existing-session nudges use the conversation’s recorded model. Available model IDs depend on the installed CLI and account.

During an on-device call, the brief appears progressively beside an activity cue. **How this was routed** shows the source, destination evidence and model-selection explanation. **Review now** cancels the call and opens the locally prepared handoff. Preferences has separate switches for reading routing updates and completion summaries aloud. The written view remains available with speech off. [Apple response streaming](https://developer.apple.com/documentation/foundationmodels/languagemodelsession/responsestream)

The on-device model provides optional wording and, when enabled, a scope estimate. Local matching handles the folder, session and worker. Review keeps your instruction unless you choose **Suggested wording → Use this wording**. With a selected conversation, “build it” reviews a nudge to that conversation. From a fresh capture, it asks which session you mean or asks for the missing task. For a longer request that relies on previous work, choose **Continue an existing session** in the workspace chooser or handoff review.

### Referencing the foreground app

Say “this website” or “this file” during a capture. Tasktap remembers the source app and resolves the reference when you review. Supported Safari and Chromium browsers provide their active page URL. Finder provides one selected file. Other apps can provide a document URL through macOS Accessibility when access is available. An exact path inside a known project can suggest the destination.

The review displays the URL or path, its source, and **Change reference** and **Remove reference**. A blocked lookup or ambiguous selection offers manual entry or a file picker. macOS Automation access is requested through the explicit **Allow source app access** button. Preferences can turn reference lookups off.

This implementation captures reference metadata. Screenshot analysis, OCR, page contents, selected text and unsaved editor buffers remain future work. The selected agent can inspect the reviewed reference under its own permissions.

### What Tasktap can observe without installing hooks

| Session | Available signal | Where to act |
| --- | --- | --- |
| Started by Tasktap | Terminal delivery, independently observed provider activity when available, and questions or summaries the agent reports through its scoped tools. | Open the original session from Sessions. Review reported questions in the notch or workspace. |
| Existing Claude Code terminal or background session | Supported versions expose working, idle or waiting status and sometimes the reason through `claude agents --json`. | Answer in the original session. A waiting indicator alone carries no reply channel. |
| Existing Codex terminal or local Codex chat in ChatGPT | Tasktap checks recent indexed conversations in project folders and their recorded turn boundaries. A stale open turn shows **Last seen**. | Use the original terminal, or **Open in ChatGPT** for a desktop chat. Local storage formats vary by version. |
| Existing cmux surface | Tasktap uses existing cmux records and merges provider status when available. An open surface alone shows **Connected**. | A nudge requires a working cmux agent inbox. |
| Independently launched Antigravity session | Tasktap tracks the terminal it opened. Independently started sessions may lack an activity signal. | Use the existing client for sessions it owns. |

Tasktap’s launcher passes its question tool in the arguments for that session. There is no global hook installation step. Project filtering and agent discovery are separate. A folder can be available for new work while its session activity is unknown. [Claude Code agent status](https://code.claude.com/docs/en/agent-view#list-sessions-as-json) · [Desktop chat links](https://learn.chatgpt.com/docs/app/commands) · [Antigravity ACP](https://antigravity.google/docs/cli/acp/)

## Design and verification

- During dictation, the glyph wave draws recent loudness from the active microphone recorder. Silence settles the glyphs onto a baseline. The wave clears when dictation ends. Each agent handoff uses Relay automatically. An illuminated carriage follows the reviewed provider’s rail when the handoff is submitted, queued, picked up by the runner and completed or delivered. A failure stops the light. The positions represent receipts. Reduce Motion uses steady states. [Dictation preview](design/voice-wave.png)
- A pending question lights the camera rim, including while Workspace is open. Answering or withdrawing the last question extinguishes it. A session waiting in an external terminal has its own status in Workspace.
- Choose the workspace and settings artwork under **Preferences → Appearance → Artwork**. Glyph wave unfolds in traveling crests. A twist moves along the Phase field ribbon. Relay sends three carriages along braced chrome guides, and Signal globe rotates eight shell panels beneath a segmented gimbal and an orbiting lens. The original Blender Resonator is also available. Each choice includes a compact notch composition and a Reduce Motion poster. [Compare the four new studies](design/motion-studies.mp4)
- On a display with a camera housing, the rim follows the gap between the two top auxiliary areas and the safe top inset reported by macOS. The expanded panel reaches into the space on both sides, with controls below the camera. Displays without a cutout use a compact top-edge tab. [Apple’s screen geometry](https://developer.apple.com/documentation/AppKit/NSScreen/auxiliaryTopRightArea-gr2n)
- [Interaction flows and UI trees](docs/interaction-design.md) · [Requirements](docs/requirements.md) · [Keyboard, Micro and narration setup](docs/controls.md) · [Agent question protocol](docs/agent-questions.md)
- [Interactive browser demo](prototype/index.html) runs from disk with fictional data. Use the Mac app for dictation, real folders and agent execution.
- `python3 scripts/verify-style.py` checks design tokens. With Playwright and Chromium installed, `node scripts/verify-ui.cjs` exercises the interaction flows and regenerates the design screenshots. Set `BROWSER_EXECUTABLE` to use an existing Chromium installation.
- `python3 scripts/verify-visible-session.py` exercises a real interactive pseudo-terminal with a synthetic CLI. Add `--terminal` or `--cmux` for an actual window and focus check.
- `node scripts/verify-model-policy.cjs` and `python3 scripts/verify-agent-models.py` check selection and resume invariants. `node scripts/verify-model-ui.cjs` checks saved preferences, review overrides and handoff payloads in the browser.
- `node scripts/render-motion.cjs` regenerates the four procedural studies using Playwright, Chromium and FFmpeg. The runtime plays bundled loops and posters offline. The Blender Resonator, posters and app icon ship in `prototype/assets/resonator`. `scripts/render-resonator.py` reproduces the Blender scene. Visible activity plays the miniature, and hidden or covered media pauses. Reduce Motion displays the still render.
- `node scripts/verify-voice-wave.cjs`, `node scripts/verify-relay.cjs` and `node scripts/verify-decision-rim.cjs` exercise the three live signals in Chromium with deterministic inputs.
- `build/Tasktap.app/Contents/MacOS/Tasktap --verify-interface` checks native hover, focus, shortcut dispatch and a question round trip using temporary data.
- `build/Tasktap.app/Contents/MacOS/Tasktap --verify-live` uses an authenticated Codex CLI to run a synthetic end-to-end capture in a temporary workspace. It consumes a real agent turn.

### Public pages and checks

The landing page and user guide live in `site/`. Run `python3 scripts/build-site.py` to assemble `build/pages/`. A wide glyph wave flows behind the stationary Tasktap name and shifts slightly on scroll, while the example’s black notch grows from the top edge of a fixed desktop frame. Narrow screens use a tighter crop, and Reduce Motion uses the poster and instant notch states. The example opens once when it comes into view and can be folded or reopened with the caption control.

Pull requests and pushes to main run design-token lint, responsive and keyboard checks, motion and session regressions, and a signed macOS build. App changes must include a reader-visible update to the published guide in `site/docs/index.html`. The check detects a changed guide; reviewers check that the explanation describes the behavior. GitHub Pages deploys the tested site from main after both jobs pass.
