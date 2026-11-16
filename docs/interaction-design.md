# Tasktap 1.0 interaction design

Tasktap has two connected surfaces: an integrated workspace for sustained work, and a resident notch for capture and attention from other applications. They share projects, conversations, requests, results and preferences. The [requirements](requirements.md) define behavior; the [QA plan](implementation-gap-plan.md) records evidence and remaining integration gaps. The [browser preview](../prototype/index.html) uses fictional activity.

## Product structure

```text
Workspace window
├── Shared navigation
│   ├── Home / Notebook / Session history / Activity
│   ├── Workspaces + → open folder / new workspace / restore closed workspace
│   │   └── Open workspace → pane groups → open terminal, report and media surfaces
│   ├── Other apps → original host / focus or session details
│   ├── All projects → project catalog and activity filter
│   └── Preferences
├── Project toolbar
│   ├── New task / New terminal
│   ├── + → Open file / Web preview / Project files
│   ├── Split right / Split down / Focus pane / Toggle sidebar
│   └── Workspace actions → notes / history / terminal preferences / close workspace
└── Recursive pane layout
    ├── Tabs → select, close, move to another pane
    ├── Terminal → live input, output, find, session details
    ├── Media → source/preview, refresh, ask agent, original file/browser
    └── Report → readable exact result, copy, narration and summary export

Resident notch / top-edge panel
├── Capture → type / hold to dictate / sketch / review
├── Pending decision → question, project, choices, Reply
├── Handoff receipt → observed delivery state / original conversation
└── Open workspace

Mac integration
├── Dock and menu bar → workspace / capture / decisions / setup / updates / quit
├── Global shortcuts → same request-scoped actions
└── Notifications → exact decision, receipt result, or failed session
```

A project folder is not an open workspace. A session is not a tab. A reported result is not proof that tests passed. These distinctions govern labels, navigation and persistence.

## Workspace lifecycle

| Intent | Interaction | State retained |
| --- | --- | --- |
| Open work | Sidebar +, then choose a folder, create one, or restore a closed workspace | Explicit ordered sidebar membership; a fresh workspace gets its first terminal |
| Arrange work | Split right/down, resize, move a tab, or focus one pane | Recursive split tree, stable pane IDs, active tabs and focus restoration |
| Focus a surface | Select its sidebar row or tab | Existing process/view receives focus; no duplicate launch |
| Close a view | Close tab or pane | Process continues; terminal can reopen through Session history |
| Close workspace | Row close control or Workspace actions | Layout persists; running sessions continue; workspace stays out of the sidebar until explicitly opened |
| Stop a process | Session details → Stop session… → confirm | Stopped state is explicit; no automatic restart |
| Reopen Tasktap | Dock/app reopen after first run | Workspace; an in-progress capture takes precedence and stays intact |

Closing the workspace window leaves the resident notch. Quitting Tasktap detaches from the private terminal service; a Mac reboot or service loss ends processes. Restoring saved metadata must not rerun a command.

The sidebar is compact navigation, not a transcript or archive. Titles are single-line with full-title tooltips. Pane labels communicate grouping without decorative guide lines. Home shows actionable questions, progress and recent results; Session history contains past conversations. Project discovery never opens sidebar workspaces by itself.

## Pane behavior

**⌘D** splits right and **⇧⌘D** splits down. The new pane appears immediately and owns its pending terminal launch. Replies arriving out of order must attach to their requesting pane, without stealing focus from a later user selection.

Dividers support pointer dragging, axis-appropriate arrow keys, Home/End limits and double-click balance. Focus temporarily expands the selected pane and hides navigation; exiting restores geometry and the shared sidebar preference. Moving a media tab preserves the live document. Closing a pane collapses the split tree without stopping any process.

Thin tab strips and contextual pane actions maximize working area. Narrow panes keep their tabs usable and move less-frequent actions into Pane actions. Terminal sizing measures the visible inner box, including current font and padding, so the last row and right edge remain reachable.

## Capture and review

First run offers setup and guided capture. **Control + Option + Space** opens typing when tapped and records when held; releasing ends dictation. **⌘ Return** reviews. A waveform uses live microphone levels; silence settles it. The capture keeps its original transcript and drawing alongside editable task wording.

```text
Capture
├── Optional source reference snapshot, bound when capture begins
├── Contextual on-device or reviewed remote preparation
│   └── Preparation progress / Review now / cancel; late output is ignored
├── Ambiguous destination → explicit project or conversation choice
└── Review
    ├── Your request → instruction / Edit task / optional separate note
    ├── Destination → workspace / agent / host / model / conversation
    ├── Reference → exact reference / provenance / freshness / sketch
    ├── Consequential notices → trust / concurrent work / processing / missing capability
    └── Stable footer → manual-paste or failure explanation / one confirm action
        └── Diagnostics → redacted effective payload, instructions, routing, IDs, copy/export
```

Preparation rewrites rambling captures into faithful work packages, preserving corrections, constraints and unresolved references. It runs for follow-ups as well as new work. Candidate context is bounded to eight projects, eight sessions and three recent Tasktap handoffs; terminal contents are not read. Remote consent shows the actual context before transport. Explicit destinations stay fixed; inferred destinations require a supported quote tied to a current candidate or its recent handoff. Invalid, contradictory and stale results cannot select a conversation.

The prepared task appears directly in review. **Original capture**, **Use original request**, and **Use prepared task** provide a reversible comparison. **Why this session?** shows matching evidence, actual state, original task and session ID. An unavailable selected conversation cannot be sent a follow-up.

Workspace review gives the request room beside its destination and reference. Compact review stacks the same facts, and the native notch widens for review within the display’s usable bounds. Flat sections use icons and accessible pencil buttons; short destination values stay on one line. Reading prose remains 16px; long requests wrap and scroll without pushing required controls out of reach. Raw Git guidance, worker protocol text, peer JSON and receipt IDs stay in Diagnostics while remaining in the actual outgoing request.

**Edit task**, **Change destination**, and **Edit context** each open a focused editor. Changing one preserves the other choices. Async quota updates must not erase an open editor. Unavailable destinations cannot launch work. Submitting locks mutation and duplicate confirmation; a failure restores editing, preserves the draft, and keeps its explanation beside retry. Changing a failed new session into a follow-up clears the cached delivery target before addressing the selected conversation.

A source snapshot belongs to one capture. Switching a browser tab while speaking does not substitute a later URL. Review shows provenance and changed/unavailable status. **Refresh source** is explicit; manual references remain available. This is reference capture, not screenshot/OCR or unrestricted inspection of the screen.

## Agent and session behavior

Fresh tasks use the reviewed folder and host. Worker authentication remains the installed CLI’s responsibility; request-preparation credentials are separate. A fresh Codex trust choice names the exact folder. Agent-native approvals remain in the terminal where an adapter cannot forward them.

A follow-up keeps its original agent and conversation. Automatic queue delivery, manual copy/paste, and unavailable transport have different labels. **Copy nudge & open session** keeps its paste instruction beside confirmation. Other apps never implies an embedded terminal; discovered sessions retain their original host and actual focus/resume capabilities.

Concurrent work is shown as a short consequence plus **View active work**. New workers receive the corresponding snapshot, and supported Tasktap agents can query current project sessions. Tasktap itself creates no branch or worktree and does not stage or commit files.

## Decisions and reported results

A question carries its request and session identity through the pane, notch, keyboard and notification. Choose an offered answer or use one **Reply** entry point for typing and speech. Sending either settles only the displayed request. Freeform words go unchanged to the same agent, which interprets their intent and can ask a new question with a new request ID. Closing without sending leaves the request pending and preserves the reply draft. Legacy discussion events remain supported by the adapter protocol. An expired or duplicate event cannot act on the next question.

Passive notch hover does not take keyboard focus or interrupt a drag. Deliberate click or shortcut can pin/focus the panel. Geometry follows the active display’s camera exclusion; a display without a camera uses a small tab attached to the actual top edge above the menu bar. Large logical displays use a compact panel profile without changing the camera exclusion geometry. Attention glows are subdued and disappear when their sheet opens. The last settled question clears the attention rim.

Activity prioritizes questions and failures, names current work, and separates handoffs in transit from running workers. It groups repeated reports by conversation with exact receipt links and expandable history. Reports are labeled as received; a forwarding acknowledgement is not implementation completion. The notch names active tasks and projects. Working workspace icons pulse based on actual session state, including exact project-folder matches; idle connections and unavailable sessions do not animate. Reduce Motion disables the pulse.

Home and history show compact rows, not report paragraphs. A result detail begins with a labeled excerpt and keeps Activity optional. **Read full report** displays exact agent text as safe Markdown. Copy, narration, export and old Activity entries retain the selected receipt. **Export summary** names the report document; generated files need a future validated artifact contract.

Ordinary terminal output and a zero exit code do not prove completion. Notifications are opt-in and deduplicated; restored results stay quiet. Tasktap enablement, macOS authorization, banner availability and actual banner display are distinct states. Focus can suppress a permitted banner. Result speech is independently optional.

## Media and appearance

Selected local files are exposed through constrained native resources. Local HTML supports scripts and nearby assets inside an opaque sandbox, with network requests and nested frames blocked. Markdown does not execute raw HTML or load remote images automatically. Related local resources are path-checked. Web previews can fail embedding or authentication; Open in browser is a visible fallback.

One application palette covers navigation, panes, forms, dialogs and Preferences. Follow Ghostty imports supported appearance fields, while xterm.js remains the renderer. Shell startup owns Oh My Zsh, Starship, aliases and plugins. A single native window backdrop supplies optional translucency and blur; Reduce Transparency overrides it. The notch retains a dark camera housing.

Artwork is subordinate to content. Home uses a slim banner, hidden/covered artwork pauses, pause state persists, and Reduce Motion uses stills. The microphone waveform and handoff relay convey measured level and receipt state respectively; they must never simulate progress.

## Preferences map

```text
Agents → Request preparation / Agent setup / Session models / Agent routing
Capture → source references / routing narration / guided capture
Workspaces → default new-folder location / optional external-session discovery
Voice & alerts → local voice / spoken completions / notification settings
Appearance → application theme / native backdrop / artwork
```

Changing the default workspace folder does not move projects. Changing theme or typography does not restart terminal processes. Existing sessions keep their startup model and permission context when defaults change.

## Review and verification criteria

- Use 16px controls and reading prose, readable settings labels, aligned actions, and shared spacing tokens. Preserve compact terminal chrome separately.
- Test desktop, 320–390px widths, a viewport equivalent to 200% zoom, keyboard navigation, long labels and text, missing metadata, failures, and Reduce Motion.
- Verify focus and state, not only geometry: exact session IDs, unchanged drafts, view lifetime, final TUI row, stale replies, and report identity matter.
- Inspect screenshots before accepting them. `output/ui-audit/second-pass/index.html` records the current screen tree; older screenshots are historical evidence.
- Keep browser fixtures, native fixtures, and live-provider runs separate. The 1.0 documentation describes capabilities and boundaries; it does not close the remaining live-agent, notification-display, or structured-outcome QA in the [gap plan](implementation-gap-plan.md).
