<img src="site/assets/tasktap-icon.png" width="112" height="112" alt="Tasktap: a metallic voice wave on a dark square">

# Tasktap 1.0.3

A Mac workspace that turns a thought into a reviewed task in the right project and conversation. Speak or type, refine the prompt, then work with your coding agents in Tasktap’s embedded terminal multiplexer. Keep sessions, documents and previews together, and answer an agent from the notch while using another app.

[Get Tasktap for Mac](https://github.com/HarzerHeribert/Tasktap/releases/latest) / [Product page](https://harzerheribert.github.io/Tasktap/) / [User guide](https://harzerheribert.github.io/Tasktap/docs/)

- **Work inside Tasktap.** Real terminal sessions, tabs, nested splits in either direction, and a shared sidebar containing the surfaces you choose to open.
- **Bring the output alongside it.** Render Markdown, local HTML, images, PDFs, text, audio, video, and web previews in the same workspace.
- **Keep the agent within reach.** Capture by voice or typing, review the task and destination, and answer supported agent questions in the notch. Results remain tied to their original request.
- **Make the whole app familiar.** Choose an application theme or follow Ghostty’s colors, with optional native translucency. Your shell still loads its own prompt and plugins.

## Get started

The prebuilt community release requires **macOS 26 or later on Apple silicon**. Agent sessions also require **Python 3** and an installed, signed-in agent CLI. Local notes work without an agent. Xcode is needed only to build from source.

**Recommended: install with Terminal.** Copy and paste this command. The installer checks the download, chooses the installation folder, and backs up an existing copy.

```sh
curl -fL --proto '=https' --tlsv1.2 https://harzerheribert.github.io/Tasktap/install.sh -o tasktap-install.sh && bash tasktap-install.sh
```

[Read the installer](site/install.sh), or download the ZIP from [GitHub Releases](https://github.com/HarzerHeribert/Tasktap/releases/latest), unzip it, and move **Tasktap.app** to **Applications**. Community builds are locally signed and **not Apple notarized**; macOS may require **System Settings → Privacy & Security → Open Anyway** for the first launch. From 1.0.2 onward, automatic checks show an **Update available** badge above Preferences and an arrow in the menu bar. Click to review and confirm the signed update, then install and relaunch. Disable automatic checks in Preferences if desired; **Check for Updates…** remains available. Earlier versions need that manual check or the installer to receive 1.0.2. See [release and update instructions](docs/releases.md).

1. Open Tasktap and complete setup, or choose **Set up later**. Your request-preparation connection and the agent doing project work are separate choices.
2. Use **+** beside **Workspaces** to open a folder or create a workspace. Set the location for new folders under **Preferences → Workspaces**; the initial default is `~/projects`.
3. Choose **New task**, type what you want, and review **Your request**, **Destination**, and **Reference**. **Start session** opens the agent in that workspace. Use **New terminal** for an ordinary shell.

Tasktap appears in the Dock and menu bar. Closing its workspace window leaves the notch available. Reopen the workspace from the Dock or menu bar; enable **Launch at Login** there if desired.

## Arrange your workspace

A workspace contains surfaces, each holding panes in tabs. Every surface has **New terminal**, **New browser**, **Split right**, and **Split down** controls. Split buttons act on their own surface; **⌘D** and **⇧⌘D** split the focused surface. Every split opens a fresh terminal. Drag a divider to resize, or double-click to balance it. Right-click a tab (or press **Shift+F10**) for **Move tab to…** and other tab actions. **Focus surface** temporarily expands the selected surface.

The sidebar shows one row per workspace. An attention mark pulses when an agent needs input; a checkmark indicates an unread reported result. Reduce Motion disables the pulse. Opening the workspace acknowledges result markers; pending decisions stay visible until resolved. **Home**, **Notebook**, **Session history**, and **Activity** remain available through the same navigation.

| Action | What happens |
| --- | --- |
| Close a tab | Its view closes. Closing or moving the final tab also removes its surface. There is no close-all control on a surface; terminal processes remain available in Session history. |
| Close a workspace | Its tabs and layout are saved. Restore it with **+ → Closed workspaces**. |
| Quit Tasktap | Running embedded sessions continue while the private local terminal service remains alive. |
| **Session details → Stop session…** | Explicitly ends that process after confirmation. |
| Reboot the Mac or lose the terminal service | Processes end. Tasktap never automatically reruns their commands. Supported conversations can be resumed explicitly. |

Terminal scrollback is bounded, not a permanent transcript archive. Agent reports and handoff history remain in Tasktap’s local store. Changing the default workspace folder never moves existing projects. Discovery does not automatically add workspaces to the sidebar.

## Open files and previews

The workspace toolbar’s **+** menu contains **Open file…**, **Web preview…**, and **Project files**. Originals stay in place; Project files reopens previously chosen previews.

| Surface | Available behavior |
| --- | --- |
| Markdown | Rendered headings, lists, tables, task lists, code, and local images; **Source** shows the original text. |
| Local HTML | Self-contained interactive pages with scripts and nearby assets; **Source / Preview** preserves the live page. |
| Images, PDF, text | Image fit/zoom, PDF page navigation, and UTF-8 text/code previews. |
| Audio and video | Playback controls for formats supported by macOS WebKit. |
| Web preview | Local development servers or embeddable websites, with **Open in browser** as a fallback. |

**Ask agent** attaches the selected file or website to a reviewed task. It does not dispatch a task on its own. **Refresh preview** rereads changed content.

Local HTML runs in an isolated frame without Tasktap’s native command bridge; its network requests and nested frames are blocked. Use a development server or browser for pages that need remote libraries. Markdown does not execute embedded HTML or load remote images automatically. Previews are not a replacement for a signed-in browser. [Preview boundaries and architecture](docs/integrated-workspaces.md#media-surfaces)

## Capture, review, and follow up

Tap **Control + Option + Space** to type from any app. Hold it to dictate and release to stop. Type, speak, or add a sketch, then press **⌘ Return** to review. Microphone and speech permissions are requested when needed.

- **Your request** contains the instruction. Its pencil button, **Edit task**, changes the wording without resetting the destination. Request preparation may suggest clearer wording; choose **Review suggested wording → Use this wording → Save task** to accept it, or keep your original request.
- **Destination** identifies the workspace, agent, host, model, and whether this is a new or existing conversation. **Change destination** edits those choices.
- **Reference** shows an attached path, URL, or sketch. Its pencil button opens **Edit context**. Source references are frozen when capture begins. **Refresh source** deliberately reads the current source; unavailable access offers manual entry.
- Consequential notices explain folder trust, concurrent work, remote preparation, manual paste, or failure. One footer contains the confirmation action. Submission locks editing until a response arrives; a failed handoff preserves the draft.

**Diagnostics** separately exposes effective instructions, routing evidence, payloads, and receipt IDs. Copy and JSON export exclude connection secrets and redact recognizable credentials in text.

Choose **Follow up** on a session, or name it in a capture. A nudge keeps that conversation’s identity and agent. Where automatic delivery is unavailable, **Copy nudge & open session** explicitly asks you to paste into the original prompt and press Return. A queue receipt is not a completed task.

## Agents, accounts, and other applications

Tasktap launches installed **Claude Code**, **Codex**, **Antigravity (`agy`)**, **Cursor CLI (`cursor-agent`)**, and **Pi (`pi`)**. Each worker uses its own CLI authentication and settings. Configure the default agent, fixed or adaptive models, and terminal under **Preferences → Agents → Session models**. Agent routing can use available usage estimates; a review override changes one handoff.

New installations use Tasktap’s embedded terminal. Existing terminal preferences remain respected. External options include Terminal, cmux, Ghostty, iTerm2, Warp, WezTerm, and kitty; their ability to reopen, focus, or deliver follow-ups varies. **Change destination → Open this session in** chooses a host for one new session.

**Request preparation** is separate from project work. The default **On this Mac** uses local matching and the available Apple model. Other configured routes include a model server, the installed Codex login, interactive Claude Code, provider API keys, and eligible ChatGPT sign-in. A local server or gateway may forward to a paid upstream. Before remote preparation, Tasktap shows what it proposes to send and offers local preparation instead. The worker then uses its own account. Routing API keys are stored in Keychain; audio, sketch points, and resolved reference attachments are not part of the remote preparation payload. Explicitly typed or dictated text may itself contain a path or URL.

A fresh Codex handoff offers an exact-folder trust choice. Project settings can run code. Codex uses its approval reviewer with the workspace-write sandbox; Claude Code requests Auto mode where supported. Agents may still ask for trust or permissions in their own terminals. Follow-ups retain the conversation’s existing permissions. Tasktap gives workers default Git guidance but does not create branches/worktrees or make commits itself.

**Find sessions in other apps** is off by default in **Preferences → Workspaces**. Opt in to read supported apps’ local session metadata. **Other apps** shows the original host and offers focus or available session actions; it never silently migrates an external conversation into an embedded terminal. Saved external sessions remain available when discovery is off. Unsupported approvals and missing completion reports must be handled in the original client. Automatic session naming can send a short excerpt of public conversation messages to the selected preparation connection, excluding tool output and reasoning; unavailable naming keeps the existing title.

## Decisions, results, and notifications

Tasktap-managed Claude Code and Codex sessions can use session-scoped question and result tools. A pane, the notch, and a notification all address the same request. Closing a decision defers it; answering one cannot answer a later request. Ordinary terminal output does not generate alerts, and a successful process exit is not treated as task completion.

Choose a displayed answer or use **Reply** to type or dictate. **Send reply** returns your words to that agent, which interprets whether you answered, asked a question, or added a constraint. Both choices and freeform replies settle the displayed request; the agent can ask a new question if it needs clarification. A freeform reply is not blanket authorization.

**Home** and **Activity** show reported results and failures. Session details show a labeled excerpt; **Read full report** preserves the complete report. **Export summary** exports the report document, not an inferred generated file. Copy, narration, export, and older Activity entries retain the selected receipt’s result.

Enable alerts in **Preferences → Voice & alerts → Notification settings**. Tasktap’s switch, macOS authorization, banners, and Notification Center availability are shown separately. Focus or macOS may suppress a banner even when permission is granted; Tasktap cannot confirm that it appeared. Restored results are not announced again. Spoken completions are a separate opt-in. Available local Siri voices and optional Kokoro narration work independently of the terminal.

The optional Codex Micro provides request-scoped decision controls. Everything also works with the Mac’s keyboard and pointer. [Keyboard and controller guide](docs/controls.md)

## Appearance: which layer owns what?

| Layer | Controls |
| --- | --- |
| **Preferences → Appearance** | One application palette: Follow Ghostty, Midnight, Daylight, Ocean, Dusk, Ember, Rose, or System; window translucency and blur. |
| **Workspace actions → Terminal preferences** | Shell, text-size override, Ghostty font/cursor import, and **Reload Ghostty settings**. |
| Your shell configuration | zsh/bash/fish startup, aliases, Oh My Zsh plugins, and Starship or other prompt themes. |

Tasktap uses **xterm.js**, not libghostty. Follow Ghostty imports supported appearance fields from the installed Ghostty configuration; keybindings, shaders, and identical font shaping do not carry over. A neutral fallback is used when Ghostty settings are unavailable. One native macOS backdrop supplies optional blur; text stays opaque, and **Reduce Transparency** takes precedence. GPU cost has not been benchmarked.

Artwork is a separate preference. Its pause state is remembered, hidden artwork pauses, and **Reduce Motion** uses still images and steady activity states. The physical notch retains a dark camera housing with readable controls in every application theme.

Paid plan usage appears in the workspace toolbar, collapsed notch and task review. Weekly usage is the outer ring; five-hour usage is the inner ring. Click for reset times. Google/Gemini uses `agy`; Cursor, Grok and GLM require an existing authenticated paid account. Unknown usage stays unavailable.

## Build and verify

Install Git, Python 3, and Xcode or Command Line Tools with the macOS 26 SDK or newer:

```sh
git clone https://github.com/HarzerHeribert/Tasktap.git
cd Tasktap
./scripts/build-mac.sh
open build/Tasktap.app
```

The build creates a locally signed app. For browser checks, run `npm ci` and install Playwright’s Chromium, or set `BROWSER_EXECUTABLE` to an existing Chromium executable.

```sh
python3 scripts/verify-style.py
node scripts/verify-review.cjs
node scripts/verify-workspace-splits.cjs
node scripts/verify-workspace-documents.cjs
python3 scripts/verify-workspace-terminals.py
python3 scripts/build-site.py
```

The [browser preview](prototype/index.html) uses fictional data. Native `--verify-interface` and `--verify-workspace` checks exercise actual Mac UI/PTY behavior with fixtures; they do not prove provider delivery, notification display, or speech with real accounts. `--verify-live` uses an authenticated Codex CLI and consumes a real turn. See the [implementation and QA plan](docs/implementation-gap-plan.md) for completed evidence and remaining work.

[Requirements](docs/requirements.md) / [Interaction design](docs/interaction-design.md) / [Workspace architecture and verification](docs/integrated-workspaces.md) / [Agent question protocol](docs/agent-questions.md) / [Release maintenance](docs/releases.md)

The public site lives in `site/`; `scripts/build-site.py` assembles it into `build/pages/`. Pull requests and main pushes run the applicable browser, native, and site checks. App changes must update the published guide when behavior changes.

## License

Tasktap is source-available under Apache License 2.0 with the Commons Clause. Use, modification, and free redistribution are permitted under those terms; selling Tasktap or a service whose value comes substantially from it requires separate permission. Third-party tools retain their own terms. [Full license](LICENSE)
