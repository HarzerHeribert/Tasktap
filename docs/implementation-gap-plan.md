# Tasktap implementation gap plan

Turn Tasktap into a conversation with the work happening on your Mac: ask naturally, confirm a clear destination, answer when needed, and receive a short useful outcome.

This checklist began before the integrated workspace overhaul. It now records the second review against the current application. A checked item has evidence below; partial implementation remains unchecked. Existing capture, launch, question and completion plumbing is reused.

## 1.0.2 interface and documentation update

The release replaces the earlier review presentation with flat **Your request**, **Destination**, and **Reference** sections, labeled icon controls and a wider compact review. A question now offers one **Reply** action for typing or speech. Sending it returns the original words as `answerKind: freeform` and settles that request; the agent interprets the intent and can ask a new question. Earlier references below to discussion describe the prior UI; legacy adapter discussion events still remain supported.

Automatic update checks now show a quiet sidebar badge and menu-bar indicator. Clicking opens Sparkle’s confirmation; installation remains user initiated and retains restart guards.

The product page explains capture, preparation, routing, reply and return, with the embedded terminal workspace shown separately. Its native screenshot contains real Claude Code and Codex panes in an isolated example project. This capture demonstrates terminal rendering; it does not establish the entire capture-to-completion provider loop. The README, published guide, interaction design, requirements and question protocol describe the current behavior. Release validation and its limits are recorded in [releases.md](releases.md).

## Second review after the workspace overhaul

The original audit is historical evidence. Its central rule still applies: show the task, destination, attached context and required decision first. Keep configuration focused, diagnostics separate, and routine explanations out of the confirmation path.

This pass preserves the new multiplexer, explicit workspace membership, application themes, and compact surface navigation. It addresses review hierarchy, reading size, cramped forms, mismatched action rows, source-context timing, and result presentation. The original proposal for automatic broad machine discovery is **not** treated as permission to scan other applications; external-session discovery remains opt-in.

| Finding | Current direction | Evidence |
| --- | --- | --- |
| Task hidden among delivery instructions | Task, Destination and Context are separate review groups; diagnostics have their own view | UX01–UX05 below |
| Tiny Preferences text and uneven controls | Readable form text, aligned control heights, deliberate stacking and a single category navigation row | Shared settings and setup verification |
| Small columns filled with result prose | An explicitly labeled excerpt, followed by a comfortable full-report reading view | `scripts/verify-result-presentation.cjs` |
| Export action implies an actual generated file | **Export summary** names what is exported; unvalidated paths never become artifact actions | DONE04 remains partial |
| Source app remembered, tab read too late | Capture-time reference snapshot with visible provenance and deliberate refresh | CTX01 below |
| UI screenshots assumed to prove integration | Browser, native fixtures and actual provider runs remain separate evidence | QA01–QA04 below |

The refreshed screenshot gallery is `output/ui-audit/second-pass/index.html`. It covers current screens at desktop and narrow widths, a viewport equivalent to 200% zoom, light and dark themes, and Reduce Motion. It complements interaction checks; it does not prove live provider delivery or model accuracy.

### Layout principles for subsequent changes

- Use 16px for reading and editable prose, and readable 14px labels in settings. Compact workspace tabs and secondary metadata may remain smaller; essential instructions and choices may not.
- Keep labels, controls and buttons on deliberate grid rows. Buttons sharing a row share height; narrow layouts stack instead of creating uneven wrapped rows.
- Use visible named actions for changing a task, destination or context. Reserve disclosures for optional history and diagnostics, never a required decision.
- Give long prose a comfortable reading width. Show an honest excerpt in overview surfaces and preserve the exact full report.
- Retain keyboard focus, unsent edits and the original conversation across navigation and failures.
- Verify both themes and geometry. A screenshot, absence of horizontal overflow, or a browser fixture alone is insufficient evidence of a complete interaction.

## How an agent should use this plan

Claim a task by adding your name after its ID. Record blockers beneath that task. Check a box only after its acceptance condition passes, then add a short evidence line with the changed files and test or screenshot. Preserve other agents’ work and checklist state. A browser fixture is not proof that a native integration works.

The repository checklist is the implementation record. The browser edition saves ticks locally and can export an updated Markdown copy; it does not write back to the repository or synchronize the separate document automatically.

## Delivery order

| Order | Work | Dependency |
| --- | --- | --- |
| 1 | Redesign review and move diagnostics out | Can start immediately |
| 2 | Capture a consistent context snapshot and expose it | Can start alongside review |
| 3 | Add opt-in discovery of tabs, processes, servers and project activity | Build on the snapshot and source records |
| 4 | Evaluate routing and connect a bounded classifier | Baseline tests can start now; context-aware routing needs context retrieval |
| 5 | Improve results, notifications and continuation | Reuse existing completion channels |
| 6 | Verify the complete native experience | Required before declaring the loop complete |

## Review screen redesign

The pictured screen mixes three different audiences: the person deciding what to do, the agent receiving instructions, and the developer investigating delivery. Nested arrows and a taller column will not solve that information problem.

The review should answer four questions without opening anything: **What will happen? Where? What context will be used? What do I need to decide?**

### Where the current content belongs

| Current content | Classification | New home |
| --- | --- | --- |
| User request and constraints | Essential | Editable task area, visible immediately |
| Project and new or existing conversation | Essential | Destination area with clear Change action |
| Chosen agent | Essential | Alongside the destination |
| Attached page, file or sketch | Essential | Context area with source, meaningful label and Remove action |
| Missing destination or unclear reference | Decision required | Visible choice or question before sending |
| Copy and paste required for a nudge | Essential limitation | Beside the send action, before confirmation |
| Folder trust or a meaningful permission change | Decision required | Plain explanation and explicit control beside confirmation |
| Terminal and model | Secondary configuration | Compact destination labels; Change opens focused settings |
| Preparation account and execution account | Conditional | Brief account/billing notice when a choice changes processing or charges; persistent defaults in Settings |
| Other workers in the same checkout | Conditional | Human-readable activity summary; relevant overlaps visible, session list in Workspace |
| Ready for Codex artwork | Supporting status | Small status indicator; no large band competing with the request |
| Full worker instructions and Git guidance | Agent configuration | Agent settings; exact effective instructions available in Diagnostics |
| Peer-session JSON, tool names and receipt UUIDs | Diagnostics | Separate Diagnostics destination |
| Routing traces, scope evidence and raw outgoing payload | Diagnostics | Separate Diagnostics destination with copy/export |
| Repeated sandbox and no-cloud boilerplate | Setup information | Explain defaults in Settings; surface a notice only when it affects this decision |

### Proposed layout

Use the available width in the workspace review. Put the editable **Task** on the left and **Destination** plus **Context** on the right. Keep one clearly labeled primary action in a stable footer. The notch uses a compact summary of those same facts, with Edit task and Change destination actions. On narrow displays, use short labeled groups in a deliberate order; do not squeeze the desktop columns or reproduce the current text dump.

Examples should read “Fix the mobile layout” and “Glasshouse · Codex · New conversation,” with a recognizable page or file reference. Raw protocol text never substitutes for those labels. Important choices are visible; optional editing is reached through named actions, not unlabeled disclosure arrows.

- [x] UX01 — **Owner: surface_navigation.** Separate the review data into task, destination, context, required decisions, configuration and diagnostics. **Done when:** worker instructions remain in the sent request but cannot leak into ordinary review text. Files: `prototype/app.js`, `prototype/live.js`.

**Evidence — surface_navigation:** `prototype/handoff-review.js`, `handoff-review.css`, `app.js` and `live.js` separate the displayed task from effective worker instructions and raw routing data. `scripts/verify-review.cjs` passes ordinary, long, follow-up and concurrent-work fixtures, including exclusion of worker/receipt text from the ordinary review.

- [x] UX02 — **Owner: surface_navigation.** Build the workspace layout and compact notch version described above. **Done when:** the request, project, agent, conversation, attached context and send action are identifiable without expanding a section; long text wraps without clipped controls.

**Evidence — surface_navigation:** The workspace uses separate Task, Destination and Context groups; compact notch and narrow windows stack them. The send footer retains manual-delivery and failure notices. `scripts/verify-review.cjs` passes narrow and effective 200% layouts. Screens: `output/ui-audit/second-pass/review-desktop.png`, `notch-review-narrow.png`, `manual-followup-zoom.png`.

- [x] UX03 — **Owner: surface_navigation.** Replace nested disclosures with focused Edit task, Change destination and Context actions. **Done when:** changing one item preserves the draft and other choices; defaults do not require repeatedly completing a large form.

**Evidence — surface_navigation:** Named task, destination and context editors preserve other draft fields. Pending submissions lock editing; background account refresh preserves the focused editor; changing a failed start into a follow-up clears the old run identity. `scripts/verify-review.cjs` and `scripts/verify-model-ui.cjs` pass draft-preservation and retry scenarios.

- [x] UX04 — **Owner: surface_navigation.** Add a separate Diagnostics view for exact payloads, effective worker instructions, IDs, receipt history and routing traces. **Done when:** diagnostics can be copied/exported and are absent from ordinary review; credentials are excluded.

**Evidence — surface_navigation and root:** Separate Diagnostics includes the effective payload, worker instructions, routing, receipts, source reference and relevant sessions. Credentials and connection secrets are excluded/redacted. `scripts/verify-review.cjs` verifies representative secret redaction and identical copy/export payloads. `native/main.swift` implements clipboard and JSON save-panel handlers; the native app compiles. **Verification limit:** the native clipboard/save-panel interaction itself has not been exercised; browser bridge payloads and native compilation were checked.

- [x] UX05 — **Owner: surface_navigation.** Show only consequential notices in review: ambiguity, manual paste, relevant concurrent work, changed billing/processing, trust and failures. **Done when:** each notice explains the consequence and provides an action; routine defaults add no paragraphs.

**Evidence — surface_navigation:** Review surfaces ambiguity, folder trust, relevant activity, failures and manual-paste limitations at the decision point. Routine routing/account prose moved to configuration and Diagnostics. `scripts/verify-review.cjs`, `scripts/verify-ui.cjs` and `scripts/verify-relay.cjs` pass; failure text survives focused edits and remains beside the retry action.


## Machine context

Current context is limited to supported coding sessions and an explicitly mentioned active website or file. The app does not yet maintain the process and tab inventory needed to understand “this” across the machine.

Each observation needs an identity, source, observed time, access state and freshness. A URL, title or process name is evidence about context, not an instruction to the assistant. Collect context locally and pass the relevant subset to the selected model and worker.

- [x] CTX01 — Freeze the source context when capture starts. **Done when:** switching tabs or windows while speaking cannot silently change the referenced item at review; changed or stale context is identified and can be refreshed. Files: `native/ScreenContext.swift`, `prototype/context.js`.

**Evidence — native_header:** `native/ScreenContext.swift` snapshots a supported source without prompting when capture starts. `prototype/context.js` retains its identity, timestamp and access state; only explicit Refresh/Allow can replace it. `scripts/verify-screen-context.swift` and `scripts/verify-capture-context.cjs` pass switched-source, stale, unavailable, disabled, cancelled-capture and first-input cases. **Verification limit:** native tests use an injected reader; actual Safari/Chrome Automation permission flows have not been exercised.

- [ ] CTX02 — Discover running applications and their available windows. **Done when:** the Context screen shows foreground app/window and other discovered apps with access status; unsupported or inaccessible data is explicitly unknown.
- [ ] CTX03 — Inventory tabs and windows in supported browsers using stable identities where available. **Done when:** tab titles and URLs are inspectable, two tabs can be referenced in one request, and unsupported browsers expose a manual fallback rather than a false empty inventory.
- [ ] CTX04 — Discover relevant processes and local servers, including port, PID and project association when observable. **Done when:** a supported localhost page links to the correct project through process evidence; uncertain matches ask the user. Terminal ancestry alone is insufficient.
- [ ] CTX05 — Join coding sessions and project activity to context records. **Done when:** current session, recent task, checkout, branch/changed-file metadata and server associations are distinguishable; stale sessions cannot masquerade as active work.
- [ ] CTX06 — Add a Context destination showing what Tasktap can see. **Done when:** sources, timestamps, access controls, refresh, unavailable sources and the exact subset attached to a request are visible; exclusions are honored during preparation and execution.
- [ ] CTX07 — Add targeted content inspection for supported page text, selected text and document/editor content, with optional screen capture when needed. **Done when:** “this button” or “the selected text” either resolves to visible evidence or asks a specific clarification; unsupported and unsaved content is never invented.

## Routing and model evaluation

Today Apple’s local model helps with wording and difficulty; project/session routing remains largely lexical. Treat classification quality and missing observations as separate problems. Do not select a stronger model as a substitute for gathering context.

- [ ] ROUTE01 — Build a labeled evaluation set of 100–200 realistic requests. **Done when:** English, German, mixed speech, paraphrases, ambiguous sessions, pronouns, corrections, speech mistakes and mixed note/task requests have expected intent, targets and clarification behavior. Keep a held-out release set. Baseline: `output/ui-audit/matcher-probes.json`.
- [ ] ROUTE02 — Retrieve a small relevant set of project, session and context candidates. **Done when:** candidates retain their real IDs and evidence; synonyms and current activity help retrieval; full machine inventories are not dumped into the prompt.
- [ ] ROUTE03 — Evaluate Apple as a bounded intent/target classifier with validated output. **Done when:** it returns only allowed IDs or asks for clarification; explicit user choices take precedence; context limits, unavailable models and interrupted requests have fallbacks. Files: `native/HandoffRouter.swift`, `prototype/live.js`.
- [ ] ROUTE04 — Improve multilingual intent and ambiguous-reference handling. **Done when:** the German note and agent-selection failures and payment-screen/checkout paraphrase from the audit are covered; a correction or an unrelated shared word cannot silently pick the wrong session.
- [ ] ROUTE05 — Compare existing rules, Apple with relevant candidates and a stronger configured preparation model on the same set. **Done when:** wrong destinations, useful clarifications, missed matches, preserved constraints and response latency are reported separately, with model/OS version and reproducible inputs. Adopt a release gate of no wrong automatic destination in the held-out set; this is a finite test gate, not a claim of universal accuracy.

Apple’s documentation describes classification as a suitable task, but that is not Tasktap accuracy evidence. Use the documented on-device context limit when budgeting candidate records. References: [classification guidance](https://developer.apple.com/documentation/FoundationModels/generating-content-and-performing-tasks-with-foundation-models), [context window](https://developer.apple.com/documentation/Technotes/tn3193-managing-the-on-device-foundation-model-s-context-window).

## Completion and continuation

Keep the existing completion and question channels. Improve their output contract and make capabilities explicit per session. A sent request, an idle agent, a closed terminal and a successfully completed task are different states.

- [ ] DONE01 — Store a structured outcome with a short summary, reported checks, changed files/artifacts, blockers and follow-up destination. **Done when:** the primary summary is at most three short bullets or 80 words; full agent text remains available in session history and failures are not summarized as success.
- [ ] DONE02 — Make completion reporting and missing-report recovery dependable. **Done when:** reports stay tied to their exact request, duplicate events produce one result, and a missing/unsupported result says where to check instead of claiming completion. Files: `scripts/agent-tools`, `scripts/session_lifecycle.py`, `prototype/live.js`.
- [ ] DONE03 — Present a compact result with clear notification and speech settings. **Done when:** a newly recognized completion can generate one macOS notification and optional short narration; notification clicks open the exact task, Focus/permission denial is represented, and relaunch does not replay old results as new.
- [ ] DONE04 — Open actual outputs when the agent supplies validated artifact references. **Done when:** Open file targets the supplied file, View changes opens the relevant change view, and a summary-only fallback is labeled as such. Do not infer file paths from arbitrary prose.
- [ ] DONE05 — Keep questions and follow-ups in the original conversation across interruption and relaunch. **Done when:** automatic delivery, manual paste, terminal-only approvals and unavailable connections are visibly different; the draft survives failure and no reply is sent to a different question.

## Verification and delivery

These checks finish the implementation; updating the screenshot gallery alone does not complete a work package.

- [ ] QA01 — Run the native round trip with actual supported agents: capture, review, launch, question, discussion, answer, completion, notification, optional speech and follow-up. **Done when:** native results are recorded separately from fixtures, with the provider and terminal used and any unsupported steps.
- [ ] QA02 — Verify the redesign in both notch and workspace: ordinary task, long request, multiple references, ambiguity, manual nudge, concurrent work, result and failure. **Done when:** keyboard use, narrow screens, 200% zoom and reduced motion retain readable labels and usable actions; no required decision sits inside a disclosure.
- [ ] QA03 — Exercise stale context, tab switching, two projects on different ports, similar session names, duplicate receipts and permission denial. **Done when:** no wrong destination, false completion, duplicate notification or cross-session answer occurs in these cases.
- [ ] QA04 — Update the published guide, requirements and screenshot tree to the shipped behavior. **Done when:** `site/docs/index.html`, relevant repository docs and screenshots agree about implemented, conditional and unsupported capabilities; each checked task includes evidence.

### Evidence from the second review

- **Shared presentation — app_themes and root:** `prototype/settings.css`, `setup.css`, `appearance.css` and `content-layout.css` use readable form text, aligned controls, deliberate narrow-screen stacking and theme-consistent workspace decisions. Settings navigation reveals the active category; setup steps reset their scroll position. `scripts/verify-settings-layout.cjs`, `verify-appearance.cjs`, `verify-setup.cjs` and `verify-style.py` pass, including all eight application palettes, narrow screens and an effective 200% viewport.
- **Results and continuation — root:** `prototype/result-presentation.js` and CSS provide a clearly labeled excerpt (at most 80 words), safe Markdown in a full reading view, and copy/export/narration of the exact selected report. History and Notebook rows clamp long prose while detail views retain it. Renamed sessions now refresh correctly on completion. `scripts/verify-result-presentation.cjs`, `verify-session-detail.cjs` and `verify-relay.cjs` pass. **DONE01 remains open:** excerpts are not a structured, provider-supplied outcome contract. **DONE04 remains open:** Export summary is honest; validated generated-file/change-view actions still need implementation.
- **Notification availability — native_header and root:** Preferences refreshes macOS authorization, banner and Notification Center status; Tasktap enablement is shown separately. Denials link to settings, enqueue failures are surfaced, and Focus/delivery remain explicitly uncertain. `scripts/verify-notifications.cjs` passes exact-request routing, duplicate suppression and silence for recovered results. **DONE02/DONE03 remain open:** native delivery and speech with actual providers have not been demonstrated by these fixtures.
- **Source scope:** external session discovery remains disabled by default. `scripts/verify-session-discovery.py` and `scripts/verify-visible-session.py --pty` pass. This change does not implement CTX02–CTX07 or ROUTE01–ROUTE05; those items require a separate capability/evaluation effort.
- **UI evidence:** `scripts/audit-interface.cjs` produced 72 current screenshots (24 screens across desktop, narrow and effective 200% layouts), with no horizontal overflow or script errors. The gallery uses fictional data and an intercepted bridge. `scripts/verify-review.cjs`, `verify-capture-context.cjs`, `verify-workspace-deck.cjs`, `verify-workspace-navigation.cjs` and `verify-home-overview.cjs` cover the associated interactions. QA02/QA03 remain partial: multiple-source context, port-to-project matching and actual provider flows are not established by this pass.
- **Native evidence:** `bash scripts/build-mac.sh build/workspace-dev` succeeds. `Tasktap --verify-interface` passes native window/dialog/notch transitions, keyboard behavior, question/discussion inbox round trips and decision lighting. `Tasktap --verify-workspace` also passes real PTY output/replay, final-row visibility after resize and nested splits, Markdown/HTML security boundaries, native text/image/PDF/audio/video previews, titlebar tint and system appearance changes. Screenshot: `output/ui-audit/second-pass/workspace-native.png`. The signed development bundle matches all 89 prototype files. These checks use fixtures, not a live coding agent; QA01 remains open.
- **Documentation:** `docs/interaction-design.md`, `README.md` and `site/docs/index.html` now describe the revised review, explicit context refresh, report actions and notification limits. `python3 scripts/build-site.py` passes. The original audit is retained; this checklist and its HTML edition record current evidence. QA04 remains partial until publication and the broader unfinished capabilities are resolved.

### Tasktap 1.0 documentation pass

- **Owner: surface_navigation.** The README and published guide now lead with embedded workspaces, explicit open/close membership, true nested splits, media previews, and task-based capture/review. The guide keeps upstream grouped/collapsible contents, active-section navigation, installer choices and troubleshooting, and adds a neutral reading palette. Anchors for workspaces, media, capture, agents, themes and notification limits are preserved for the rebuilt product page.
- **Changed:** `README.md`, `site/docs/index.html`, `site/docs/docs.css`, `site/docs/docs.js`, `docs/requirements.md`, `docs/interaction-design.md`, `docs/integrated-workspaces.md`. Requirements distinguish behavioral contracts from verified integrations; the interaction tree reflects open surfaces and focused review, not the old session-list workspace.
- **Verified:** local Chromium check at 1440, 850, 390 and 320px widths, plus a 640×450 viewport equivalent to 200% in a 1280×900 window. Section anchors, keyboard-operated contents, current-section tracking, native disclosures, no-JavaScript navigation and horizontal bounds pass without script errors. `python3 scripts/verify-style.py` passes. Reviewed guide screenshots: `/tmp/tasktap-1-guide-top-1440.png`, `/tmp/tasktap-1-guide-top-320.png` and workspace-section captures.
- **Scope:** documentation preserves community-build/not-notarized status, Python 3 and agent dependencies, exact-report export semantics, renderer/shell/theme boundaries, opt-in external discovery, preview isolation, notification uncertainty and the remaining provider validation. This release-documentation pass does not complete QA01–QA03, structured outcomes or validated artifact actions. QA04 remains subject to the parent release’s final site/build/publication checks.

### Evidence format

Under each completed task, add: **Owner:** name. **Changed:** paths. **Verified:** command or native scenario and result. **Screenshots:** paths when behavior is visible. **Remaining limitation:** only if material. Leave partially complete tasks unchecked and record the remaining work.

### Starting points

- Review content: `prototype/app.js` (`review`), `prototype/live.js` (`deliveryAudit`), `prototype/routing-activity.js`.
- Shared layout: `prototype/style.css`; native host: `native/main.swift`.
- Context: `native/ScreenContext.swift`, `native/LiveWorkspace.swift`, `prototype/context.js`, session discovery scripts.
- Existing audit and 57-screen tree: `output/ui-audit/index.html`.
- Preserve the original audit and add evidence for current behavior. Do not mark unrelated context, model evaluation, or provider integration work complete because the interface has improved.
