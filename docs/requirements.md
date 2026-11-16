# Tasktap 1.0 requirements

The linked [interaction design](interaction-design.md) describes the resident Mac app. The [browser prototype](../prototype/index.html) uses fictional session activity for reproducible review.

## Product purpose

Give the user one integrated working surface for local projects, agents, terminals and previews. Let them capture a thought from another app, review where it will go, answer a supported agent question, and return to the exact task. The installed agents own planning, tool use and execution. Tasktap owns workspace layout, reviewed routing, explicit delivery state and attention.

These are behavioral contracts and acceptance criteria, not a claim that every adapter or live-provider scenario has passed. The [implementation gap plan](implementation-gap-plan.md) records remaining work and separates browser fixtures, native fixtures and actual provider evidence.

## Requirements and acceptance

| ID | Requirement | Acceptance example |
| --- | --- | --- |
| C1 | A deliberate shortcut or button begins a capture. Support voice, typed input, and a sketch in one capture. Allow review, edit, cancel, and retry. | Canceling a capture produces no agent message. Loss of microphone access leaves typing and drawing available. |
| C2 | Preserve the original transcript and drawing alongside an editable handoff. Separate facts, ideas for later, questions, instructions, and constraints within a single ramble. | “Remember this curve, maybe animate it later, ask Claude where it lives” saves a note and sends an investigation request. The optional animation remains an idea. |
| R1 | Keep an explicit default workspace folder, initially ~/projects, and folders chosen by the user. Preserve exact folder identity and aliases. Keep the project catalog separate from open sidebar membership. | An alias resolves to its registered folder. A missing folder stays unavailable; choosing a new location is explicit, and changing the default never moves existing projects. |
| R2 | Resolve project, session, agent, and app independently. Rank exact names and aliases first, then task text and recent activity. Resolve against known local IDs. | “Ask Claude about lighting and show me the file in Xcode” has a project, agent, question, and separate result viewer. Xcode does not become the workspace. |
| R3 | A unique eligible match may route directly with a visible destination. Multiple plausible matches require a choice. | Two sessions doing lighting in different worktrees prompt a choice showing project, task, and agent. A note can be filed without dispatching an agent. |
| R4 | Offer a folder picker, a new project, or a scratch idea when no workspace fits. Confirm the destination before creating a folder. Keep project-linked notes outside the repo by default. | The user can keep an idea in the assistant’s scratch area today and assign it to a real project later. A missing workspace never silently becomes a newly created directory. |
| R5 | Configure a fixed model or a difficulty curve for fresh sessions. Let the user set tier thresholds and model IDs per provider, inspect the estimated scope, and override the proposed model before launch. | A small edit can use a quick model. A migration can use the complex tier. An existing conversation uses its recorded model for a nudge. |
| R6 | Show observable routing activity and a streaming draft during an on-device model call. Keep the final routing evidence readable with narration off. | Review now or closing the card cancels the model request. Late output cannot change another capture. Unavailable inference shows local matching as the source. |
| R7 | Resolve an explicit reference such as “this website” or “this file” from the capture’s source app. Display the exact reference and permit change or removal before sending. | A supported browser provides its page URL. Finder provides one selected path. Missing access or ambiguous selection offers manual entry. A file inside a known project can suggest that destination. |
| A1 | Start Claude Code, Codex, Antigravity (agy), Cursor CLI, or Pi in the exact selected worktree. Use their existing interfaces and authentication. Record the returned session ID and adapter. | Two sessions in the same repo stay individually addressable. Unavailable or unsigned-in providers expose a recovery action and preserve the brief. |
| A2 | A nudge follows up in the existing conversation. Track app-launched and discoverable external sessions with known delivery transports. | “Tell the session working on lighting to check reflections” reaches its stored session ID. A session visible but unreachable offers reconnect, open, or keep the draft. |
| A3 | Distinguish queued, delivered, active, needs input, completed, interrupted, and failed from adapter evidence. Persist request IDs and deduplicate reconnects or retries. | Queueing a nudge does not claim delivery. A permission prompt stays bound to the original session, turn, request, and action. Dismissing the UI leaves it pending. |
| A4 | Show a capture-specific light on the chosen provider’s rail. Advance on submission, queue acceptance and runner receipts. | A stalled receipt holds its position. A failed submission can be retried. A note has no agent relay. Reduce Motion snaps to the observed state. |
| N1 | Surface decisions in a compact notch-adjacent panel. Show project, session, question, choices, and consequence. Click and deliberate voice reply resolve the same request. | With two pending decisions “use the existing shader” answers only the visible one. If the question expires, it cannot apply to another request. |
| N2 | Completion offers a concise result, a link back to the session or artifact, optional speech, and a follow-up. | A failed run shows what stopped. Speech is off by default. A completion summary distinguishes an agent’s report from a verified test result. |
| N3 | Support Macs or displays without a notch, keyboard-only use, and reduced motion. | The same decision is reachable through the menu-bar control, without taking focus during ordinary progress. |
| N4 | The workspace and notch are complementary. Capture, review, routing, nudge, decisions and completion summaries must work with the workspace window closed. | First-run capture can use the notch. Later Dock/app reopen returns to Workspace; reopening during a capture preserves that card. Closing the workspace leaves the notch available. |
| N5 | Keep a persistent macOS status item. Offer capture, pending requests, workspace, Micro controls, notification settings and quit. | The same commands work on an external monitor without a camera cutout. The compact panel stays inside its visible frame. |
| N6 | Support opt-in macOS notifications for requests and completions with exact-ID actions. Honor system authorization and Focus. | “Review in notch” opens the named request. Dismissal defers. A closed request produces a stale notice and leaves the next request alone. |
| N7 | Start collapsed. Reveal the black notch by a deliberate hover; retain the active app, keyboard responder, pointer position, and open work. Allow click, touch and keyboard opening. | Crossing the camera while dragging leaves the panel closed. Leaving a passive peek retracts it, while leaving a capture or decision keeps it open. Reduce Motion presents a still activity cue. |
| K1 | Register global capture and decision shortcuts; expose conflicts in the menu. Deliberate input can focus the panel; passive updates leave the foreground app alone. | From another app, invoke capture, or open a pending request and navigate to the desired answer with the keyboard. Holding Confirm cannot repeat a decision. |
| H1 | A separate Codex Micro layer must operate the pending decision queue through global shortcuts. Show the question, project, agent, outcome and current selection on the Mac. | From another app, use only physical controls to open, navigate, confirm or defer a request, including approve/decline and multi-choice. When several requests are pending, deferring cycles the queue. |
| H2 | Route Micro, keyboard, pointer and voice to the same request and session IDs. Track the active request across changes; require a new selection for a different request. | A confirmed or expired request cannot approve a later request. An unplugged Micro leaves every pending decision available through the notch and menu. |
| H3 | All choice and freeform reply flows work with the Mac alone. The Micro adds direct, request-scoped Yes, No and Reply actions. | Unplugging the pad or disabling native lighting preserves the question, reply draft and keyboard controls. A late key event carrying an old request ID has no effect. |
| H4 | Size the amber rim to the active display’s reported camera exclusion. Expand at both sides of the camera and below it, keeping all questions, labels and fields on usable pixels. | Two different cutout widths produce different rim widths. Changing displays updates the geometry. A screen without a cutout has a reachable top-edge tab. The rim remains visible while Workspace is open. Resolving or withdrawing the last actionable request clears it. |
| H5 | Offer opt-in green and red cues on two independently lit Agent Keys. Clear them whenever their direct actions are unavailable. | Opening Reply, dismissing, resolving or quitting clears the pair. The menu-bar count and visible labels convey decisions independently of color or connected devices. |
| N8 | Present agent-originated questions and ask for missing routing information automatically. Offer one Reply action for typing or speech and keep its draft bound to the original session and decision. | Sending a choice or freeform reply settles that request. The agent interprets freeform intent and asks a new question if needed; it is not blanket authorization. Unsent drafts and pending questions survive relaunch. Legacy discussion events remain supported. |
| N9 | Offer separate opt-ins for routing narration and completion narration using the selected available voice. | Routing narration reads a short progress update and the reviewable handoff. Muting it leaves every written status and reference available. |
| N10 | Draw the voice glyphs from level samples from the active dictation recorder. | Silence settles to a baseline. Transcription, cancellation and microphone errors clear the meter. Late samples cannot animate another field. |
| P1 | Keep capture and routing local by default; send only the approved handoff and selected attachments to the chosen agent. | A scratch note stays local. Cloud-backed agents receive their selected content under the agent’s own settings. No continuous screen capture is needed. |
| P2 | Preserve local notes and unresolved work across relaunch. Allow deletion of captures and drawings. Store contact with external agents separately from local notes. | Relaunch can reattach to a known session or truthfully show its last known state. Reopening a capture does not re-send it. |

### Integrated workspace acceptance

| ID | Requirement | Acceptance example |
| --- | --- | --- |
| W1 | Sidebar membership is explicit and persistent. | + opens or creates a workspace; close removes it from navigation while saving its layout. Discovery does not add it back. |
| W2 | One sidebar reflects open surfaces grouped by pane across all app screens. | A closed view disappears; selecting an existing terminal focuses its input without spawning another process. Long titles stay on one line with full-title access. |
| W3 | Nested splits support both axes, independent resizing, focus and tab movement. | ⌘D/⇧⌘D opens a new terminal in the requesting pane, even when launches return out of order. Focus restores the original tree. |
| W4 | Views and processes have separate lifetimes. | Close tab/pane/workspace preserves the process; Stop session requires explicit confirmation. Reconnect and app relaunch never rerun a command automatically. |
| W5 | Terminal content fits its actual pane. | Prompt and final TUI row remain visible across split, font, padding and window changes. Input during replay stays ordered and targets the exact session. |
| W6 | Preview supported local media and web content without access to the native command bridge. | Markdown/HTML Source toggles preserve source; local HTML network access and nested frames are blocked; related-resource paths cannot escape their allowed directory. |
| W7 | Apply one application theme while keeping shell configuration independent. | Preferences, dialogs, sidebar and terminals share a palette. Follow Ghostty imports appearance only; Starship/Oh My Zsh load through shell startup. Reduce Transparency overrides native blur. |
| W8 | Preserve the original host of external sessions. | Opt-in discovery shows host and real available actions. Focusing an external session never silently migrates it to Tasktap. |
| W9 | Keep task review understandable without disclosures. | Your request, Destination, Reference and consequential notices are visible. Focused edits preserve other choices; pending submission locks editing; failures preserve the draft. |
| W10 | Keep report and diagnostic actions truthful. | Read full report retains exact agent text. Export summary exports a report, not an inferred artifact. Diagnostics copy/export redact recognizable credentials and exclude connection secrets. |

The project catalog is available through All projects and the workspace chooser. Its activity filter is separate from sidebar membership. A folder can be available for new work while its agent activity is unknown. Missing folders cannot be selected as a new handoff destination.

New tasks open an interactive agent in the reviewed host. Tasktap is the default for new installations; saved external-host choices remain respected. A follow-up addresses the existing conversation or explicitly offers manual copy/paste. First-run setup installs no global agent hooks. External observations retain the capabilities and uncertainty of their source.

## Current implementation

The resident AppKit/WKWebView app combines an embedded xterm.js workspace with Apple Speech, local matching and available Apple Foundation Models. A private PTY service keeps processes separate from views. Native file handling provides constrained previews; application themes and native backdrop settings apply consistently. Tasktap delegates execution to installed CLIs and keeps ordered handoffs and receipts on disk. Notes and sketches can stay in Scratch or be linked to a project. See the [implementation and setup guide](../README.md) for transport and storage details.

The standalone browser preview uses fixtures for reproducible design and interaction tests. The [controller guide](controls.md) includes the hands-on checks for physical lighting, notification delivery and shortcut conflicts. Open work includes broader routing evaluation, live mid-turn steering for managed agents and native permission forwarding across all providers.

## Work packages

| Package | Implemented | Remaining scope |
| --- | --- | --- |
| Integrated workspace | Explicit lifecycle, nested panes, persistent terminal sessions, media previews, one sidebar and application themes | Sustained daily-use feedback; renderer/platform performance benchmarks |
| Session integration | Interactive terminal delivery, scoped question and completion tools, read-only external status discovery | Universal external reply transport and native permission forwarding |
| Models | Fixed or adaptive settings, per-provider models, review override, recorded-model resumes | Broader difficulty evaluation and provider model availability checks |
| Routing feedback | On-device draft streaming, source evidence, cancellation, optional voice | Continuous task execution explanation beyond provider receipts |
| Source context | Capture-time reference snapshot, provenance/freshness, explicit refresh and manual recovery | Screenshot/OCR, selected text, visual regions and unsaved editor buffers |
| Review and reading | Your request / Destination / Reference review, focused editors, redacted diagnostics, exact-report reading and export | Structured outcome and validated artifact contracts |
| Visual identity | Shared palettes, native translucency, selectable artwork, native icon and reduced-motion stills | Further motion states as new product interactions require them |
