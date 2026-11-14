# Interaction design

Use [requirements](requirements.md) for behavior and [the prototype](../prototype/index.html) to try the states. The initial view is the resident notch panel. The workspace opens on demand. A browser desktop illustrates the same interaction as the packaged Mac host.

## Implementation brief

Anchor a choice of typographic speech waves, refracted phase contours, routed signals or a scanning globe beside the workspace heading and in the notch miniature. Animate each within a fixed frame. The compact layout uses its own crop and Reduce Motion shows a still. The original brass-and-jade Resonator remains available.

While preparing a handoff, the selected artwork plays beside the activity label while the draft grows below. Session detail uses that same band for the observed state and workspace path. Finished sessions use the still image.

Leave the camera housing blank and trace its sides and lower edge on visible pixels while someone needs to answer. On hover, the black surface opens to both sides of the housing and joins the controls below it. Take the bounds from the active display’s safe top inset and auxiliary areas. Reduce Motion uses a steady outline.

The ink sidebar holds persistent destinations. The light work surface holds the latest spoken handoff and session rows. An amber waveform marks recorded speech. Colored status marks always appear with words. The desktop background is a deterministic abstract landscape made from layered contour lines. The light rests when idle, breathes slowly during agent work, and quickens for listening, speech or a queued handoff. Pending decisions remain identifiable by text. The workspace starts hidden and the notch starts collapsed. The template supports controls at the top of displays without a physical notch.

## UX flows

| Trigger | User journey | End or recovery |
| --- | --- | --- |
| Hover over the camera area | Pause for 170 ms → see a passive peek → move down into the panel to read or act → leave for 320 ms to collapse | The foreground app keeps the keyboard. Click the tab or use Return to pin. A touch tap pins directly. An open sheet stays available when the pointer leaves. |
| Invoke from any app | ⌃⌥Space or status item → compact capture at the notch → type, add a sketch, or dictate → review and route | The full workspace stays closed. Capture remains reachable when notification alerts are off. |
| Incoming question | Adapter emits a question → subtle attention cue → review in the notch | Talk it through returns the follow-up to the originating session. Yes or No resolves that request. |
| Controller-only decision | On the assistant layer, open pending → read the question in the notch → previous/next to highlight an answer → confirm or defer | Confirmation resolves the displayed request once. Deferral keeps it pending; with several requests it moves behind the others. |
| Notification | Opt in from the status menu → decision or completion arrives → use Review in notch or View result | The exact request or session opens, including when already using another app. A stale action leaves other requests untouched. |
| Capture an idea | New capture → type, dictate, and/or draw → review the inferred destination and brief → Save note | Notebook holds the note and sketch; reopen to read it. Cancel returns to the current view. |
| Ask a project question | Capture → Ask an agent → match project or choose folder → choose agent and optional result app → start | A new session appears in the selected workspace. Results can open in the requested app in the native product. |
| Nudge ongoing work | Capture → Nudge a session → resolve task and workspace to a session → send | Record queued and delivered separately. The existing session holds the message. Show delivery failure and preserve draft when the adapter is unreachable. |
| Mix a fact with a request | Capture → use the mixed voice example → keep the original and sketch → review the agent brief and separate note → send | The notebook and session share a capture. The note is independently editable; tentative ideas do not become tasks. |
| Resolve ambiguity | Say “lighting” with multiple matching sessions → show project, task, and provider per choice → choose by click or deliberate voice reply in native app | Route the handoff once to the selected ID. Cancel leaves the draft available for editing. |
| Unknown workspace | Review → no match → select a registered folder, choose a new project, or keep scratch | Explicit new-project choice previews a folder under the configured root. Scratch can be promoted later. |
| Agent needs a decision | Notch marks a pending request → expand → see task, consequence, and choices → click or request a voice reply | Decision applies to that request once. Close defers. A stale request is discarded. The next pending decision has its own card. |
| Receive or explain a result | Open completed session → read outcome → optionally hear explanation or select the preferred result viewer → follow up | The result stays silent until requested, unless completion narration is enabled. Follow-up keeps the agent’s session context. |
| Refer to the current app | Say “this website” or “this file” → resolve the source app’s URL or document → review exact reference → send | Enter or choose the reference when access is unavailable. Change or remove it at review. |
| Choose a model policy | Preferences → Session models → fixed model or difficulty curve → adjust thresholds and provider models → save | Fresh sessions show the proposed model before launch. Existing conversations retain their recorded model. |
| Change artwork | Preferences → Artwork → compare labeled thumbnails → select a study | The selection appears immediately in the open screen and persists on relaunch. Reduce Motion shows the matching poster. |
| Inspect routing | Review capture → observe local matching or on-device draft stream → inspect final destination, scope and model | Review now cancels inference. How this was routed exposes source evidence. Routing narration is independently optional. |

## UI trees

~~~text
Mac desktop
├── Resident notch / top-edge panel
│   ├── Collapsed → blank silhouette / amber edge when input is needed
│   ├── Home → new capture / pending question / open workspace
│   ├── Capture → sketch and transcript / review / route / receipt
│   ├── Decision → task and consequence / Yes / No / Talk it through / other choices
│   │   └── Discussion → type or dictate / send follow-up / return to pending decision
│   └── Session → outcome / read aloud / follow up
├── Persistent status item
│   └── Show notch / capture / decisions / workspace / alerts / Micro controls / quit
├── Notification Center
│   ├── Decision → Review in notch → original request ID
│   └── Completion → View result → original session ID
├── Codex Micro extra layer and global keyboard commands
│   ├── Capture / open pending / previous / next / confirm / defer
│   └── Visible yes/no decision → green Yes / red No / Talk → discussion
└── Workspace window
    ├── Navigation
    │   ├── Overview / Sessions / Notebook
    │   ├── Projects → active projects / show idle projects → sessions / start session / notes
    │   └── Preferences → session models / artwork / narration / source context / workspace root
    ├── Workspace toolbar → return to notch / new capture / toggle sidebar
    └── Current view
        ├── Overview → latest capture / waveform / destination / active sessions
        ├── Sessions → running, waiting, completed → session detail
        ├── Notebook → project-linked and scratch notes → note detail
        └── Project → folder / sessions / notes
~~~

~~~text
New capture
├── Capture editor → transcript / dictation / drawing pad / cancel
├── Reference when mentioned → URL or document / change / remove / manual entry
├── Preparing handoff → activity cue / streaming draft / review now
└── Review → inferred destination / brief / confirm / optional Adjust
    ├── Proposed model → fixed or estimated tier / override in Adjust
    ├── How this was routed → source / destination evidence / scope cue
    ├── Save note → project / scratch → notebook
    ├── Ask an agent → workspace / agent / result viewer → new session
    ├── Nudge → matching live session → existing conversation
    ├── Unmatched → choose folder / new project / scratch
    └── Optional separate note → shared capture reference

Session detail
├── Project, worktree, provider, task and current state
├── Activity including handoff receipts and decisions
├── Pending request → open notch
├── Completed → outcome / read aloud / open result
└── Follow up → capture with session preselected
~~~

~~~text
Preferences
├── Artwork → Glyph wave / Phase field / Relay / Signal globe / Resonator
├── Session models
│   ├── Default agent
│   ├── Fixed model per provider
│   └── Difficulty curve → Quick / Standard / Complex
│       ├── Standard and Complex thresholds from 1 to 10
│       └── Model ID for each tier and provider
├── Narration voice → exposed Siri voice / local Kokoro
│   ├── Routing updates and final handoff
│   └── Completion summaries
└── Source context → resolve explicit website or file references
~~~

## Interaction and review criteria

Place Yes and No side by side beneath the question, with a quieter discussion action below. Keep the black surface still as the focused text field opens and use the same labels on small screens and with reduced motion.

- Use a parent grid for repeated session rows. Give icon, text, count, and status their own tracks. Essential labels wrap with the row. Provide identical column starts for headings and rows, including when an icon is missing.
- Group padding, stack gaps, typography, and radii use named CSS tokens. One parent owns spacing. Independent controls keep their radius. The waveform is deterministic illustrative data.
- Escape dismisses the topmost surface. Return or Space activates a focused control. Dialogs manage and restore focus. Audio and microphone simulations require an explicit user action. Full input paths remain available through the keyboard.
- Test desktop, narrow display, effective 200% zoom, keyboard and touch, wrapped German labels, optional icons, right-aligned numeric values, and reduced motion. A generated geometry fixture uses the real row component. The captured desktop image is a review candidate; approve it visually before using it as a regression baseline.
