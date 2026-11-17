# Tasktap 1.2 contract inventory

Input for the rebuild protocol and data model (`docs/rebuild-plan.md`). It records what the code on branch `rebuild-phase-0` does on 2026-11-17. It contains no recommendations.

Conventions:

- References are `path:line` from the repository root; `main` means `native/main.swift`. "(inferred)" marks a reading that no single line states; "Not determined" means the code read did not settle it.
- `appData` is `~/Library/Application Support/<CFBundleName>`: `Tasktap`, or `Tasktap Dev` for `TASKTAP_DEV=1` builds (`native/LiveWorkspace.swift:25`, `scripts/build-mac.sh:20`). Swift exports it to every child as `TASKTAP_DATA` (main:1794); the Python helpers fall back to `…/Tasktap` when it is missing.
- `web` is the workspace web view and `notch` the notch web view. Both load `prototype/index.html` with the same scripts. Production runs "independent windows" mode with both views (main:81). A single-view mode, which moves one view between panel and window, runs only under `--verify-*` flags.
- Class column: **L** logic (belongs in a core), **H** host ability, **U** plumbing between the two pages.

## 0. Processes and channels

| From → to | Channel | Format | Ref |
| --- | --- | --- | --- |
| JS → Swift | `webkit.messageHandlers.workspace.postMessage({type,…})`, fire and forget | object | `prototype/live.js:4`, `prototype/surfaces.js:2-3` |
| JS → Swift | `webkit.messageHandlers.terminalClipboard`, reply handler, `web` only | `{op}` → value | main:190,592-603 |
| Swift → JS | `callAsyncJavaScript` named expressions; helper `js()` runs on both pages | argument object | main:141-145 |
| Swift ↔ terminal bridge | `python3 -u workspace_terminal.py bridge`, stdin/stdout | JSON lines | `native/WorkspaceTerminals.swift:22-58` |
| bridge, run-agent, observers ↔ terminal service | Unix socket `<appData>/Terminals/session.sock` | JSON lines, bytes as base64, no version | `scripts/workspace_terminal.py:343-350` |
| Swift → agent runner | `<appData>/Helpers/<sha256>/run-agent <Runs/id>`; `run-agent rows <Runs>` every 8 s; `run-agent reopen <run>` | files, stdout JSON | `native/LiveWorkspace.swift:19-50,219-266` |
| agent CLI → Tasktap | hooks and plugins → `session_observer.py ingest` → run-folder files + socket `observe` | JSON | `scripts/session_observer.py:123-214` |
| agent CLI → Tasktap (legacy) | MCP stdio `agent-tools` → `ask-user` → `Agent Inbox/requests/` | JSON files | `scripts/agent-tools`, `scripts/ask-user` |
| Swift → helpers | `RouterCLI.call(cmd, json)` → `router-provider <cmd>`, stdin JSON, stdout `{value}` or `{error}` | JSON | `native/RouterConnection.swift:119-149` |
| Swift → speech helper | `tasktap-speech` | NDJSON | `native/SpeechRuntime/Sources/tasktap-speech/main.swift:28-61` |

## 1. UI to host messages

The `workspace` handler switches on **92** `type` values (main:609-1091; `default: break` ignores unknown types). The `terminalClipboard` handler adds 2 ops, and `workspace-terminal` carries 9 ops (§4.6). Swift accepts a message only from the main frame whose URL equals the bundled `index.html` (main:605-607). Most host and helper cases do nothing under `--verify-*` (`!verifying, !liveTest` guards). JS sends with `postLive` (throws without the handler, `live.js:4`), `postHost` (safe, `surfaces.js:2-3`), direct calls (`app.js:263,270,380`, `shared-state.js:25`) and `terminalClipboard` (`workspace-deck.js:75-82`). Every type string the JS sends has a Swift case; the one payload value that does not match is in §12.

### 1.1 Windows, notch, menus (19 types)

| type | payload | host does | reply / event | ref host / JS | class |
| --- | --- | --- | --- | --- | --- |
| `ready` | – | **web:** position panel, push folder config, connect terminal bridge, load Ghostty look, start 80 ms hover timer, wire runtime callbacks, start receipt polling and 8 s session scan, start question inbox, `configureVoices`, flush queued commands (else send `open-app`), show window, bootstrap notch, start Sparkle, send connections, detect CLIs. **notch:** `notchReady`, `bootstrapNotch` (web state snapshot, config, connections, usage, speech, queued notch commands) | many | main:647-698,314-322 / `surfaces.js:512` | L+H |
| `layout` | `workspace` bool, `height`, `width` (432 or 560), `collapsed` | notch only: store, recompute panel frame. Single-view mode moves the view between panel and window | `updateNotchGeometry` | main:867-899 / `surfaces.js:393` | H |
| `show-workspace` / `hide-workspace` | – | show and focus / hide window and rim | – | main:620,637 / `surfaces.js:36,420` | H |
| `show-notch` | `open` | deliver `home` (or `collapse` if `open:false`) to notch | workspaceCommand | main:639 / `surfaces.js:47` | H |
| `notch-onboarding` | – | deliver to notch, arrives as `open-app` | workspaceCommand | main:638,337 / `surfaces.js:490` | H |
| `focus-capture` | – | panel key; focus `#modal[open] #transcript` | – | main:916-925 / `surfaces.js:297` | H |
| `workspace-view` / `preferences-open` | `view` / `group` | show window; `go(view)` / `prefs(group)` on web | – | main:640,635 / `app.js:228`, `preferences.js:42` | U |
| `workspace-open` | `key`, `project`, `activate` | `workspaceDeck.open(…)` on web | – | main:642 / `workspace-deck.js:371` | U |
| `workspace-open-terminal` / `-result` | `id` | show window; `workspaceDeck.openTerminal` / `openResult` | – | main:645 / `workspace-deck.js:854,878` | U |
| `shared-state` | `patch` (§3.4) | relay to the other page's `sharedState.apply` (independent mode only) | – | main:616-619 / `shared-state.js:25` | U |
| `application-menu-state` | `workspace` bool | enable `menu-pane-*` items (web only) | – | main:609,443 / `application-menu.js:28` | H |
| `workspace-cursor` | `axis`: x, y or null | resize cursor | – | main:611 / `workspace-deck.js:507` | H |
| `workspace-drag` | – | window drag; double click zooms | – | main:614,39-43 / `workspace-navigation.js:95` | H |
| `workspace-chrome` | `background` #rrggbb, `opacity` 0–1, `followSystem`, `blur` | configure backdrop (web only) | – | main:711, `WorkspaceBackdrop.swift:27-34` / `workspace-deck.js:99` | H |
| `status` | `count` (decisions + observer input/permission) | menu title and tooltip, decision rim (web only) | – | main:1042-1049 / `surfaces.js:247` | H |
| `binary` | `id` of the visible yes/no card, or `''` | register/unregister ⌃⌥Y/N/T (notch only) | later `hw-yes/no/discuss` | main:1050,507-520 / `surfaces.js:258` | H |

### 1.2 Settings, updates, notifications (11 types, all H)

| type | payload | host does | reply / event | ref |
| --- | --- | --- | --- | --- |
| `application-settings` | – | read `SMAppService.mainApp.status` | `preferencesPanel.receiveApplicationSettings({launchAtLogin,requiresApproval})` | main:621,124 |
| `launch-at-login` | `enabled` | register/unregister; open Login Items if approval needed | same; `toast` on error | main:622-634 |
| `check-updates` | – | Sparkle check, or confirm install of a downloaded update | `appUpdates.receive` | main:782, `AppUpdates.swift:28-38` |
| `automatic-updates` | `enabled` | Sparkle `automaticallyChecksForUpdates` | `appUpdates.receive` | main:784-787 |
| `open-docs` | `section` | open `…/Tasktap/docs/#<section>` only for agents, capture, voice, appearance, install | `live-error` on failure | main:788-792 / `app.js:601` |
| `notification-status` | – | read notification settings | `notificationStatus({authorization,alerts,center})` | main:1057,1761-1777 |
| `notification-settings` | – | open the Notifications pane | `toast` fallback | main:1058-1064 |
| `authorize` | – | request alert + sound | `workspaceCommand('notification-granted'/'-denied')` or `notificationDeliveryFailed('', 'settings', msg)` | main:1065-1074 |
| `notify` | `id`, `kind` (request, complete, answer, failure, attention), `title`, `body` | post identifier `kind.id`; category `decision` (request), `failure` (failure), `result` (others) | `notificationDeliveryFailed(id,kind,msg)` on error | main:1075-1084 / `surfaces.js:232`, `workspace-deck.js:131,164` |
| `clear` / `disableNotifications` | `id`, `kind` / – | remove `kind.id` pending and delivered / remove all | – | main:1085-1091 |

### 1.3 Folders, files, previews (11 types)

| type | payload | host does | reply / event | ref | class |
| --- | --- | --- | --- | --- | --- |
| `workspace-open-folder` | – | folder picker → `WorkspaceFolders.authorize` → rediscover | `workspaceSettings.opened(row)` or `live-error` | main:699,127-140 | H+L |
| `workspace-choose-root` | – | picker → `setRoot` → rediscover | `workspaceSettings.receive(config)` | main:701 | H+L |
| `workspace-create-folder` | `name` | `WorkspaceFolders.create` under the root | `opened(row {folder,name,checkout,available:"true"})` / `failed(message)` | main:703-707 | L |
| `workspace-file` | `project` (folder) | multi-file picker → register preview ids | `workspaceDeck.addFiles(project,files)` | main:721-726 | H |
| `workspace-open-relative` | `id`, `href`, `project` | resolve a link inside a preview: same folder only, symlinks resolved | `addFiles` / `live-error` | main:727-731, `WorkspaceMedia.swift:47-68` | L |
| `workspace-open-link` | `href`, `project`, `cwd`, `external` | `WorkspaceLinks.resolve`. web → browser, or `openWeb` inside a project. App schemes (mailto, tel, sms, vscode, vscode-insiders, cursor, zed, xcode, obsidian, slack) → system. file with `:line:col` or `#LnCn` → Finder for folders, executables and scripts; system app if not previewable; else preview with `sourceLine`/`sourceColumn` | `openWeb` / `addFiles` / `live-error` | main:732-764, `WorkspaceLinks.swift:10-40` | L+H |
| `workspace-pdf-page` | `id`, `page` | render the page as PNG 1400 px wide, ≤2400 high | `workspaceDeck.pdfLoaded(id,{image,page,pages,text≤20000} or {error})` | main:765, `WorkspaceMedia.swift:69-85` | L |
| `workspace-read-text` | `id` | read ≤2 MiB; reject NUL and non-UTF-8 | `workspaceDeck.textLoaded(id,text)`; errors arrive as the text | main:769, `WorkspaceMedia.swift:86-99` | L |
| `workspace-reveal` | `id` | reveal in Finder | – | main:773 | H |
| `workspace-open-url` | `url` (http/https only) | open in browser | – | main:775-777 | H |
| `open-result` | `id` (UUID), `text`, `viewer` (Finder, Xcode, Preview) | write `Runs/<id>/Result.txt`, or `Result.pdf` (A4, CoreText) for Preview; open it | `live-error` | main:1031-1041, `ResultDocument.swift` | L+H |

### 1.4 Terminals (3 types + clipboard handler)

| type | payload | host does | reply / event | ref | class |
| --- | --- | --- | --- | --- | --- |
| `workspace-terminal` | `op` + fields, 9 ops (§4.6) | `WorkspaceTerminals.handle` gate → bridge | `workspaceDeck.receive(events)`; Swift errors as `{event:'error',id,cwd,op,error}` | main:712-715 | L |
| `workspace-appearance` | – | run `ghostty +show-config` (4 s) | `workspaceDeck.appearanceLoaded(profile)` | main:708,585-590 | L |
| `terminal-input-trace` | `events[]` | append to diagnostics if tracing is on | – | main:709-710 | L |
| `terminalClipboard` | `{op:'copy', text ≤4,000,000 B}` / `{op:'paste'}` | general pasteboard (private one in verify runs) | reply `true` / string | main:592-603 | H |

### 1.5 Sessions, agents, questions (15 types)

| type | payload | host does | reply / event | ref host / JS | class |
| --- | --- | --- | --- | --- | --- |
| `refresh` | – | project discovery + `run-agent rows` | `projectsDiscovered(rows)`, `sessionRows(rows)` | main:943 / `app.js:390`, `surfaces.js:298,412` | L |
| `enqueue` | `job` (§5.2) | expand `~/`, write `.job`, launch runner | `acceptLive({capture,folder,name,task} or {capture,error})`, then `agentReceipt(e)` stream | main:979-988 / `live.js:134` | L |
| `reopen-session` | `id` | `run-agent reopen` | `workspaceCommand('session-focused',id)` / `live-error` | main:989-994 / `app.js:603` | L |
| `resume-terminal`, `copy-resume` | `id` | build resume command (needs `conversation.json`); write `Runs/<id>/Resume.command` and open it in Terminal.app, or copy | `live-error` text | main:995-1011 | L+H |
| `review-failed-handoff` | `session`, `capture` | load a retryable job (§5.4) | `reviewFailedHandoff(job)` | main:975-978 | L |
| `assign-note` | `id`, `capture`, `folder` | move `Scratch/<capture>.json` to `Notes/`, set `workspace` | `noteAssigned(id, folder)` | main:971-974 | L |
| `observer-answer` | `id`, `turn` | read `Runs/<id>/answer-NNNN.txt` | `sessionObservation.showAnswer(id,turn,text)` | main:716-720 | L |
| `questionUpdated` | – | rescan the question inbox (§6) | `receiveAgentQuestion` per request | main:1051 / `app.js:380` | L |
| `copy-report` | `text` ≤1 MB | pasteboard | `live-error` "Report copied." | main:1012-1015 | H |
| `copy-diagnostics`, `export-diagnostics` | `text` (valid JSON ≤1 MB) | pasteboard / save panel `tasktap-diagnostics.json` | `live-error` | main:1016-1030 | H |
| `ai-refresh` | – | `router-provider status` (CLI detection) | `aiConnections.receive(…)`, `aiConnections.checked()` | main:778,574-583 | L |
| `worker-usage` | – | `router-provider usage`, cached 120 s | `workerRouting.receive(data)` | main:780,556-572 | L |
| `worker-install` | `agent` | open that agent's install guide URL (6 agents) | – | main:793-796 | H |
| `worker-login` | `agent`: claude, codex, cursor-agent | `router-provider worker-login` → login command in Terminal.app, then CLI detection | `aiConnections.receive` / `live-error` | main:797-804 | L+H |

### 1.6 Routing, AI connections, capture context (17 types)

| type | payload | host does | reply / event | ref | class |
| --- | --- | --- | --- | --- | --- |
| `route` | `id`, `input` (§7.1), `provider`, `confirmed`, `server?` | cancel previous route; `local` → Apple model; other providers require `confirmed` | `routingProgress(id,event)` (local only), `finishRouting(id,r)` | main:944-964 / `live.js:214` | L |
| `cancel-route` | `id` | cancel if current | – | main:965-970 | L |
| `prepare-open` | `id` (UUID), `prompt` ≤65536 | only when route is `claude-session`: copy prompt to pasteboard, open Claude in Terminal.app | `claudeBrief.receive(id,true,result)` | main:807-822 | L+H |
| `prepare-reply` | `id` (must equal the last `prepare-open` id) | read the brief from that Claude transcript | `claudeBrief.receive(id,false,{brief} or {error})` | main:807-822 | L |
| `ai-settings` | – | – | `aiConnections.receive(state,…)` | main:805 | L |
| `ai-save` | `route`, `model`, `key`, `server? {kind,url,useSaved}`, `account?`, `request?` | validate; key → keychain, preferences → UserDefaults | `aiConnections.receive(value,note,finished:true,success,request,account)` | main:839-864 | L |
| `ai-login` | `account`, `request` | ChatGPT OAuth (§7.4) | same, `account` = client id | main:854-856 | L |
| `ai-account` / `ai-disconnect` / `ai-remove` | `account` / – / `route` | select / revoke and delete / delete key | same | main:857-859 | L |
| `ai-model-list` | `id`, `kind`, `url`, `useSaved`, `key` | GET `<base>/models` | `serverSetup.receive(id,{models} or {error})` | main:830-838 | L |
| `ai-codex-identity` | `id` | `codex app-server` `account/read` | `setupPreparation.identity(id,label)` | main:823-829 | L |
| `ai-usage` | – | open `chatgpt.com/settings/usage` | – | main:865 | H |
| `context-begin` | `id` | freeze the source app, read its reference in the background | – | main:900-901 | H |
| `context-resolve` | `id`, `request`, `kind` (file/website), `allowPermission`, `refresh` | return frozen reference with freshness, or re-read | `captureContext.receive(request,result)` (§7.5) | main:902-907 | H |
| `context-file` | `request` (JS also sends `id`) | open panel, file or folder | `captureContext.receive(request,{kind:'file',value,app:'Chosen file'})`; nothing on cancel | main:908-915 | H |

The `ai-save/login/account/disconnect/remove` messages run one at a time and never during a route; otherwise they fail at once with "Finish the current connection or capture…" (main:842-844).

### 1.7 Speech (16 types)

| type | payload | host does | reply / event | ref |
| --- | --- | --- | --- | --- |
| `dictation-start` | `id`, `shortcut` | start with the configuration frozen at press; if `shortcut` and `id` ≠ current hotkey press, reply `stopped` | `dictationEvent`, `dictationLevel` | main:926-930 / `live.js:269` |
| `dictation-finish` / `dictation-cancel` | `id` / `id?` | stop and transcribe / discard | `dictationEvent` | main:931-932 |
| `speech-status` | – | publish snapshot | `voiceSettings.receive(snapshot)` | main:933 |
| `speech-save` | `configuration` (§8) | validate, write `Speech/preferences.json`; refused during setup | same | main:934 |
| `speech-install` / `speech-cancel-install` / `speech-remove-model` | – | Apple assets or Whisper model; removal refused while dictating | same, with progress | main:935-940 |
| `speech-connect` / `speech-disconnect` | `provider`, `key` / `provider` | keychain account `speech.<provider>` | same | main:938-939 |
| `speech-microphone` / `speech-microphone-settings` | – | request microphone permission / open Privacy pane | same | main:937,941-942 |
| `speak` / `stopSpeech` | `text`, `voice` / – | Siri voice or Kokoro / stop | `workspaceCommand('narration-status',phase)` | main:1052-1056 / `app.js:263,270` |
| `check-kokoro` / `install-kokoro` | – | probe / install Kokoro | `updateKokoro(status,detail)` | main:1054-1055 |

## 2. Host to UI events

- **`js(name,args)`** (main:141-145) runs on `web`, and on `notch` once ready, so every `js()` event runs in **both** pages.
- **`deliver(action,id,reveal)`** (main:323-358) queues until `web` is ready, then calls `window.workspaceCommand(action,id)` (`surfaces.js:488`). In independent mode these go to the notch (held in `notchQueue` until it is ready): home, collapse, capture, requests, notice-request, hover-enter, hover-exit, hw-capture, hw-capture-end, hw-yes, hw-no, hw-discuss, hw-previous, hw-next, hw-confirm, hw-back, notch-onboarding (main:326). Everything else goes to `web`. `reveal` shows the panel on the pointer's screen, or the workspace window.
- **User scripts at document start:** `window.tasktapSurface` = `'workspace'`/`'notch'` (main:186,216); `window.tasktapScreenReaderEnabled` (:187); `window.tasktapInputTraceUntil` on `web` only (:188); `window.fixtureMode` in verify runs only (:184,217).

### 2.1 Named entry points (through `js()` unless a target page is given)

| entry point | payload | fires when | ref Swift / JS |
| --- | --- | --- | --- |
| `updateNotchGeometry(metrics)` → notch | `{width,height,shoulder,compact 0/1,surfaceWidth,surfaceOffset,pixel,corner,rimOffset,offset,available}` | every `position()` after ready (layout, screen change, pending count) | main:264-274 / `surfaces.js:361` |
| `sharedState.snapshot(value)` → notch; `sharedState.apply(patch)` → other page | web's whole `state` / patch | notch ready / each `shared-state` message | main:314-317,619 / `shared-state.js:27,51` |
| `window.workspaceCommand(action,id)` | strings (§2.2) | `deliver()` | main:337,354 / `surfaces.js:488` |
| `workspaceDeck.receive(events)` → web, awaited | terminal events (§4.1) | each bridge read batch; Swift blocks the reader ≤15 s until the promise resolves | main:652-655 / `workspace-deck.js:177` |
| `workspaceDeck.clipboardCommand(action,true)` → key page | `copy`/`paste`, returns bool handled | Edit ▸ Copy/Paste; `false` falls back to WebKit editing | main:393-401 / `workspace-deck.js:67` |
| `prepareForAppUpdate()` → each page in turn | returns bool | Sparkle postpones relaunch; `false` shows "Finish your capture…" | main:458-473 / `app.js:652` |
| `prefs(group)`, `go(view)`, `workspaceDeck.open(key,project,activate)`, `.openTerminal(id)`, `.openResult(id)`, `.openWeb(project,url)` → web | – | relayed notch requests, link opening | main:636-646,744 |
| `workspaceDeck.addFiles(project,files)` | `[{id,title,path,kind,url,sourceLine?,sourceColumn?}]`; `kind` image, video, audio, pdf, web, markdown, text; `url` `tasktap-preview://<id>/<name>` | picker, relative link, file link | main:725,730,761, `WorkspaceMedia.swift:31-44` |
| `workspaceDeck.pdfLoaded(id,result)`, `.textLoaded(id,text)`, `.appearanceLoaded(value)`, `.accessibilityChanged(enabled)` | §1.3, §4.6, bool | replies; VoiceOver toggled | main:767,771,589,197-200 |
| `workspaceSettings.receive(config)`, `.opened(row)`, `.failed(message)` | `config` = `WorkspaceFolders.configuration` (`root`, `rootAvailable`, …) | ready, folder actions | main:122,137,706-707 |
| `preferencesPanel.receiveApplicationSettings(c)`, `appUpdates.receive(s)` | `{launchAtLogin,requiresApproval}` / `{available,version,automatic,readyToRestart}` | request, app activation / Sparkle change | main:125,1781,455 |
| `aiConnections.receive(value,note,finished,success,request,account)`, `aiConnections.checked()`, `workerRouting.receive(data)` | §7.4 | ready, `ai-*`, CLI detection, usage | main:549,581,570 |
| `setupPreparation.identity`, `serverSetup.receive`, `claudeBrief.receive`, `routingProgress`, `finishRouting`, `captureContext.receive` | §7 | replies correlated by id | main:828,837,821,954,963,904-913 |
| `dictationEvent(id,phase,text)`, `dictationLevel(id,level)` | §8; levels only while a window is visible, one call in flight | dictation | main:660-668 |
| `voiceSettings.receive`, `updateKokoro(status,detail)`; `configureVoices(voices)` → web | §8 | speech changes; ready | main:650,228,687 |
| `projectsDiscovered(rows)`, `sessionRows(rows)`, `agentReceipt(e)`, `sessionNameChanged(id,name,fingerprint)` | §5.5 | runtime callbacks | main:670-682 |
| `acceptLive(data)`, `reviewFailedHandoff(job)`, `noteAssigned(id,project)`, `sessionObservation.showAnswer(id,turn,text)` | §1.5 | replies | main:987,977,973,719 |
| `receiveAgentQuestion(event,prior)`, `reconcileAgentQuestions(keys)` → web | §6 | inbox scan | `QuestionInbox.swift:67,79` |
| `notificationStatus(s)`, `notificationDeliveryFailed(id,kind,msg)`, `toast(msg)`; inline focus and `postHost('notification-status')` | §1.2 | replies; app activation | main:1775,1083,633,919,1782 |

### 2.2 `workspaceCommand` actions sent by Swift

| action | id | source |
| --- | --- | --- |
| `open-app` | – | `web` ready with an empty queue (main:689); Dock reopen in single-view mode (:253); `notch-onboarding` on the notch (:337) |
| `home`, `collapse` | – | status menu, `show-notch`, window close (main:366,639,1758) |
| `capture`, `requests`, `workspace`, `prefs`, `run-setup`, `notifications` | – | status menu and app menu (main:364-381, `ApplicationMenu.swift`) |
| `menu-*` (14) | – | app menu (`ApplicationMenu.swift:43-74`): `menu-home`, `-notebook`, `-history`, `-activity`, `-open-workspace`, `-sidebar`, `menu-pane-terminal`, `-browser`, `-compose`, `-split-right`, `-split-down`, `-text-increase`, `-text-decrease`, `-text-reset` |
| `close-front` | – | ⌘W, File ▸ Close View (main:44-51,69,408) |
| `hw-capture`, `hw-capture-end` | press UUID | ⌃⌥Space press / release (main:521-538) |
| `hw-yes`, `hw-no`, `hw-discuss` | decision id | ⌃⌥Y/N/T while a binary card is shown (main:540-541) |
| `hw-requests`, `hw-previous`, `hw-next`, `hw-confirm`, `hw-back` | – | ⌃⌥J/K/L/Return/Escape (main:544-545) |
| `hover-enter`, `hover-exit` | – | hover timer (main:294) |
| `notice-request`, `-answer`, `-session`, `-result` | notification id | notification click: request → request, answer → answer, failure/attention → session, else result (main:1720) |
| `notification-granted`, `notification-denied` | – | `authorize` (main:1072) |
| `session-focused` | session id | successful reopen (main:993) |
| `narration-status` | `idle`, `preparing`, `speaking` or error text | Narration (main:227) |
| `live-error` | message, also success notes like "Report copied." | about 25 call sites (main:138-1740) |

The JS also handles `hotkey-conflict`, `guide-*`, `notify-*` and `dismiss-notice` (`surfaces.js:405-505`); Swift never sends them, and in-page buttons call the same `command()`.

## 3. State model

The global is `let state` (`app.js:41`); each page holds its own full copy. `persist()` writes the whole object as JSON to localStorage, on the workspace page only (`app.js:48`). There is no schema version field.

### 3.1 Top-level keys

| key | type / values | main writers | how it is shared |
| --- | --- | --- | --- |
| `projects`, `sessions`, `captures`, `notes`, `decisions` | arrays of records (§3.2) | `live.js:10-22,147-171`, `questions.js:20-30`, `workspace-settings.js:36`, `workspace-deck.js:137,175` | row deltas by `id` |
| `speak`, `alerts`, `speakRouting`, `showIdleProjects`, `setupSeen` | bool | `voice-settings.js:75`, `surfaces.js:425-426`, `routing-activity.js:97`, `app.js:211`, `setup.js:9` | whole value |
| `useScreenContext` | bool; absent means on (`!==false`) | `context.js:141`, `setup.js:137` | value |
| `voiceEngine` | `''` (off), Siri voice id, `'kokoro'` | `voice-settings.js:73`, `setup.js:141` | value |
| `agentReplyLanguage` | `request` or `english` | `preferences.js:55` | value |
| `sessionModels` | `{adaptive, defaultAgent ('claude'), standardAt 2–9 (4), complexAt ≥standardAt+1 ≤10, agents:{agent:{fixed,quick,standard,complex}}}` | `model-policy.js:12-30,131` | value |
| `workerRouting` | `{automatic, reserve 0–100 (10), ranked:[agent]}` | `worker-routing.js:7-12,127` | value |
| `firstRun` | `{done:true}`, `{session,capture}` or `{session,nudge}` | `first-run.js:20-98` | value |
| `appearanceTheme` | ghostty, dark, light, system, ocean, dusk, ember, rose; unknown → `ghostty` | `appearance.js:4-12,54,94` | value |
| `preferencesCategory` | general, agents, workspaces, capture, voice, notifications, appearance | `preferences.js:43` | value |
| `notificationFailure` | `{id,kind,message≤2000,time}` | `surfaces.js:195,429` | value |
| `workspaceView` | `overview`, `sessions`, `notes`, `projects` or a project id | `app.js:228` | value |
| `workspaceConfiguration` | `{root ('~/projects'), rootAvailable, …}` from the host | `workspace-settings.js:9` | value |
| `workspaceDeck` | §3.2 | `workspace-deck.js` (many), `workspace-navigation.js`, `session-observation.js:55,88`, `appearance.js:128-130` | workspace → notch whole value; notch → workspace only `.preferences`, as `workspacePreferences` |

In memory only: `view`, `draft`, `openedSession`, `spoken` (`app.js:47`); AI connection config (`connections.js:13`); usage snapshot (`worker-routing.js:3`); voice snapshot (`voice-settings.js:5`); update snapshot (`updates.js:3` declares a local `state` that shadows the global); observation cache (`session-observation.js:5`); terminal maps (`workspace-deck.js:13,23`).

### 3.2 Records

| record | fields |
| --- | --- |
| Project | `id`, `name`, `folder`, `color` (`#a8c3ae`), `aliases[]` (live: name with `-`/`_` → spaces), `available`, `checkout`, plus every host row field (`Object.assign`, `live.js:11`). `id` = folder for discovered, opened and terminal projects; `uid()` when created by `questions.js:19` or `app.js:537`. `@scratch` is a virtual project, never stored |
| Session | `id`, `project` (project id, `@scratch` or a folder), `agent` (six providers or `unknown`), `task` (≤78 characters when JS creates it), `sessionName`, `namedAt`, `nameFingerprint`, `nameHistory[{name,at}]`, `state`, `log[]` (never trimmed), `result`, `viewer`, `interactive`, `host:'tasktap'`, `managed`, `available`, `inbox`, `conversation`, `resumable`, `updatedAt` (ms), `startup` (pending/confirmed, claude), `nudgeFailed`, `planAccount`, `model`, `capture`, `producerKey` = `JSON.stringify([agent,folder,sessionId])`, `answeredDecisions[{id,question,detail,choices,producerKey,answer,answerKind,discussion}]`, `monitoring`, `observation`, `observedAnswers[{turn,text,time}]` (last 20) |
| Session.state | Running, Needs input, Complete, Queued, Opening, Opened, Awaiting agent, Connected, Ready, Closed, Failed, Interrupted, Last seen, Delivered, Copied. Host rows, receipts, decisions and observations all write this one field (`live.js:29-33,182-186`, `session-observation.js:8-9,20`) |
| Observation | `state` (starting, working, needsInput, needsPermission, ready, interrupted, failed, ended), `sequence`, `launchId`, `updatedAt`, `agent`, `providerSession`, `turn`, `finalAnswer`, `answers[{turn,time}]`, `history[{at,kind,activity}]`, `question`, `error`, `activity`, `event`. Higher `sequence` wins within a `launchId`; across launches the newer `updatedAt` wins (`session-observation.js:13-37`) |
| Capture | `id`, `kind` (Agent question, Session nudge, Note), `text`, `brief`, `project`, `session`, `time` (`HH:MM` or `''`), `duration` (Voice/Text), `receipt` (Saved, Queued, Opening, Opened, Running, Complete, Failed, Closed, Copied, Delivered), `result`, `quiet`, `reference {kind,value,app,observedAt,origin,freshness,sourceID,explicit}`, `strokes [[[x,y]…]]` on a 600×176 canvas, `routingEvidence`, `routingPayload`, `outgoing`, `instructions`, `accounts` (`live.js:148,171`, `context.js:81,88`) |
| Note | `{id, title ≤64, text, project ('' = unassigned), capture}` (`live.js:156`) |
| Decision | `{id, session, q, detail, choices[] (binary → ['No','Yes']), kind ('choice'/'binary'), producerKey = JSON.stringify([sessionKey,requestId]), discussion[], discussionDraft}`; the draft is persisted on every keystroke (`questions.js:28`, `app.js:341`) |
| deck `layouts` | `{projectId: {groups:[{id,tabs:[TabKey],active}], selected, tree, focus}}`; `tree` is a leaf `{group}` or a node `{id, axis x/y, ratio, first, second}`; TabKey is `terminal:<id>`, `media:<id>` or `result:<id>` (`workspace-layout.js:18-22,90`) |
| deck `media`, `preferences` | media `{id: {id,kind,title,url,path?,project,sourceLine?,sourceColumn?,sourceView?}}`; preferences `{shell (default, zsh, bash, fish), font? 12–20, followGhostty?, appearanceVersion:1, translucent?, blur?}` |
| deck other fields | `activity [{kind complete/failure/answer, id, capture?, turn?, title, body?, project, agent, time, read}]` (≤60); `seen {token: ms}` (≤500); `observerReads {answerKey: ms}`; `appearance` (Ghostty profile, §4.6); `background {sessionId: projectId}`; `closedWorkspaces {projectId: true}`; `openProjects [projectId]`; `navigationExpanded`; `sidebarHidden`; `terminalFontSizes {id: 8–40}` (`workspace-deck.js:5-14,122-157`) |
| Draft (memory) | `mode` (ask, nudge, note), `text`, `brief`, `note`, `project` (id, `@new`, `@scratch`), `session`, `agent`, `viewer`, `strokes`, `keep`, `hasVoice`, `contextID`, `reference`, `routing{id,input,projects,sessions,lockedProject,provider}`, `remoteAttempts[]`, `routingSource`, `modelEstimate`, `captureId`, `runId`, `submitting`, `handoffError`, `agentChoice`, `modelOverride`, `noPick`, `workerReason`, `peerTasks`, `preparedBrief`, `suggestedBrief`, `guide`, `retryOf`, `retryCapture` (`app.js:385-386`) |

Routing `source` values: local-match, apple, claude-session, estimate, unavailable, fallback, skipped, error, or a provider id (`routing-activity.js:51-59`). Relay phases: review, submitting, queued, opening, opened, copied, closed, running, complete, delivered, failed (`relay.js:5,16`); `relay.js` and `relay-path.js` only draw the handoff animation.

### 3.3 Persistence

| localStorage key | contents | writer / reader |
| --- | --- | --- |
| `tasktap-live-v1` | whole `state` as JSON (live mode) | `persist()` `app.js:48` (not on the notch), `sharedState.apply` `shared-state.js:46` (workspace only) / `app.js:42` on both pages |
| `workspace-assistant-demo-v1` | the same, in demo mode | same |
| `tasktap-update-draft` | `{text,project,strokes}` | `prepareForAppUpdate` `app.js:656`; restored only on a non-workspace surface 1.2 s after load, then removed (`:658-660`) |
| `tasktap-art`, `tasktap-home-motion` | glyph/phase/relay/orbit/resonator; `paused`/`playing` | `motion.js:19-25,48` |

No sessionStorage or IndexedDB. Migrations are ad hoc load-time fixes, not versioned steps: drop sessions with `external` (`app.js:46`); repair layouts, fill defaults, delete `preferences.font` when `appearanceVersion` is missing (`workspace-deck.js:7-12`); derive `openProjects` (`workspace-navigation.js:7-9`); coerce the theme (`appearance.js:54`); handle old jobs and log lines (`live.js:53-55,63-68`). Live mode is `!!messageHandlers.workspace && !window.fixtureMode` (`live.js:2`); otherwise the state is seeded from demo data (`app.js:44`).

### 3.4 How the notch gets its copy (`prototype/shared-state.js`)

- Enabled only when `tasktapSurface` is `workspace` or `notch` (`:3-4`). A deep-copy baseline is taken at load and after each publish or apply.
- **`publish()`** (`:8-26`, from `persist()`) diffs each top-level key: collections send `{upsert:[changed rows], remove:[ids]}`, other keys `{value}` or `{remove:true}`. The notch never sends `workspaceDeck`, only `workspacePreferences`. Posted as `shared-state`, relayed by Swift.
- **`apply(patch)`** (`:27-50`): new rows first, existing rows replaced whole; `workspaceDeck` merged shallowly, other keys replaced; then the workspace writes localStorage, the theme is re-applied and `render()` runs. Writes during `apply` are not published.
- **`snapshot(value)`** (`:51-56`) wraps everything as upserts plus removals; Swift sends it once, at notch ready.
- **Conflicts:** none detected; each key and each whole row is last writer wins.

## 4. Terminal service protocol

Topology: JS ↔ Swift (`workspace-terminal` / `workspaceDeck.receive`) ↔ **bridge** (stdin/stdout JSON lines) ↔ **service** (`workspace_terminal.py serve`, Unix socket, JSON lines). `run-agent` and `visible_session.py` call the socket directly for `start` and `focus` (`visible_session.py:109-111,237-238`), observers for `observe` (`session_observer.py:42-53`).

### 4.1 Socket operations

Every reply echoes the request's `request` field (`workspace_terminal.py:202`) and goes only to the requester unless marked broadcast.

| op | request fields | reply / events | ref |
| --- | --- | --- | --- |
| `watch` | – | sets `watch`; `{event:'sessions', sessions:[meta]}`. The bridge sends it itself on connect and adds `resizeEvents:true` | `:207-209,433,445` |
| `list` | – | `{sessions:[meta]}`; no caller found | `:205-206` |
| `start` | `id` (UUID), `cwd`, `argv[]`, `title?`, `kind?` (`agent` or shell), `rows?`, `cols?`, `restart?` | `{event:'session', session:meta}` + `session` broadcast | `:154-195,235` |
| `attach` | `id` | subscribe; `{event:'replay', id, data(b64), seq, truncated, session, cols, rows}`; the bridge adds `geometry:[{offset,cols,rows}]` | `:249-253,435-437` |
| `detach` / `input` | `id` / `id`, `data` (b64) | `{id}`, no event | `:254-263` |
| `resize` | `id`, `rows`, `cols` | `{id}`; the bridge rewrites it to `{event:'resized', id, cols, rows}` | `:264-269,439-442` |
| `stop` | `id` | `{id, event:'session-stopping'}`; unknown id → added to `cancelled`, `{event:'session-cancelled', id}` | `:240-245,270-273` |
| `focus` | `id` | `{id}` + `{event:'focus', id}` broadcast | `:274-275` |
| `observe` | `id`, `runDir`, `token` | `{id}` + `{event:'observation', id, observation}` broadcast | `:276-294` |
| `open-workspace` | `cwd` | remove `cwd` from the closed set; `{event:'workspace-opened', cwd}` | `:210-218` |
| `stop-workspace` | `cwd`, `ids[]` (≤10000) | close `cwd`, stop its PTYs; `{event:'workspace-stopping', cwd}`; later `workspace-closed` broadcast | `:219-234,415-418` |
| failures | – | `{event:'error', id, cwd, op, error}` | `:298-299,382-383` |

Pushed: `output {id, seq, data}` to attached clients (`:333-334`); `session {meta}` on start and exit; `observation` on `observe` and exit; `focus`; `workspace-closed`. `meta` = `{id, cwd, title, kind, running, exit, created, restored, stopped, observation}` (`:92`); for a session that is not running the observation is rewritten as `ended` without bumping `sequence` (`:93-94`).

### 4.2 Handshake, token, security

| item | fact | ref |
| --- | --- | --- |
| Socket access | **No handshake, token, version or peer-credential check.** ROOT must be a 0700 non-symlink directory owned by the user with no group/other bits, checked in `connect()` and `serve`; socket chmod 0600 after bind | `:33-38,42,346,475` |
| Single instance | `flock(ROOT/service.lock, LOCK_EX|LOCK_NB)`; a second `serve` exits 0 | `:476-480` |
| `observe` token | `secrets.token_hex(16)` per launch in `Runs/<id>/observer-config.json`; checked with `compare_digest` against the client-named `runDir`. Also requires: session running, folder name = id, first `*.job` has `observer:true` and matching session, job folder = session cwd, `observer.json.launch` = token | `session_observer.py:255-259`, `:279-290` |
| `start` validation | canonical UUID id; `cwd` absolute, a directory, not closed; `argv` 1–100 strings, no NUL, `argv[0]` absolute and executable, ≤262144 characters total; `title` ≤180; rows 2–500, cols 10–500, default 24×80 | `:29-30,164-199` |
| Child process | `pty.fork` + `execve`, no shell; env = the service's whole env + `PWD`, `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=Tasktap`; nothing scrubbed | `:177-186` |
| Limits | client inbound >2 MiB or outbound >4 MiB drops the client; parsing pauses at ≥64 KiB outbound; `input` ≤65536 decoded bytes per op, ≤2 MiB pending | `:135-137,260,370-374` |
| Swift gate | relays only the 9 ops of §4.6; `start`/`open-workspace` need `folders.allowsExisting(cwd)` (a direct child of the root, or an approved canonical path, `WorkspaceFolders.swift:91-99`); UUID ids; shell zsh→`/bin/zsh`, bash→`/bin/bash`, fish→`/opt/homebrew/bin/fish`, else `$SHELL`, else `/bin/zsh`. JS never supplies argv: Swift sends `[python3, <Helpers>/tasktap_shell.py, 'shell', shell, id, <Runs>]`, `kind:'shell'`, `title:'Terminal'`, 100×30. `input` >90000 characters or invalid base64 is dropped silently | `WorkspaceTerminals.swift:81-126` |
| JS | terminal query replies (CSI n, c, $p, t, DCS $q, OSC 4/10/11/12) are suppressed while a replay parses; OSC 7 accepts only local `file:` URLs and only sets the link-resolution cwd | `terminal-protocol.js:10-20`, `workspace-deck.js:281` |

### 4.3 Files in the service root

ROOT = `$TASKTAP_TERMINAL_ROOT`, else `<TASKTAP_DATA or ~/Library/Application Support/Tasktap>/Terminals` (`workspace_terminal.py:25`).

| file | format / fields | writer |
| --- | --- | --- |
| `session.sock`, `service.lock` | socket 0600, unlinked at bind and idle exit; empty flock file | service (`:343-346,422,476`) |
| `sessions.json` (+ `.tmp`) | JSON array of `meta`, 0600, atomic replace; written on start/stop/exit/stop-workspace, `observe` throttled to 2 s | `:97-101,292-293` |
| `lifecycle.json` | `{closed:[cwd], cancelled:[id]}`, 0600 | `:103-107` |
| `Replay/<id>.json` | `{data b64 ≤2 MiB, geometry:[{offset,cols,rows}] ≤2048, seq, created}`, 0600; files >4 MiB rejected on load | bridge (`terminal_replay.py:63-69`), on resize and bridge exit |
| `Shells/<id>/` | `bin/{claude,codex,pi,opencode}` shims that exec `tasktap_shell.py cli <agent>`; zsh rc files or a bash `bashrc` | `tasktap_shell.py:74-103` |

### 4.4 Lifecycle and what survives

| topic | behavior | ref |
| --- | --- | --- |
| Start | lazy: `connect()` spawns `serve` detached (`start_new_session`) on the first failed connect, retries 60 × 50 ms; `request()` has a 10 s timeout | `:41-67` |
| Stop | SIGTERM to the child's process group and the terminal's foreground group; SIGKILL after 2 s | `:109-126,390-397` |
| Exit | `waitpid(WNOHANG)` each loop; drain, `running:false`, `exit`, observation `ended` with `exitCode`, persist, broadcast. Sessions are never removed from memory or `sessions.json` | `:398-414` |
| Restart | `start` on a known id returns its meta; restarts only with `restart:true` and not running; ids in `cancelled` need `restart`. Only reopen sends `restart:true`. Nothing reruns automatically | `:157-161`, `visible_session.py:110` |
| Workspace fence | `stop-workspace` closes `cwd`, cancels unstarted ids, stops running ones; `start` fails in a closed cwd; `open-workspace` fails while closing; `cancelled` is never cleared | `:216-232` |
| App quit | Swift owns only the bridge; PTYs keep running. The service exits after 60 s with no clients and no running/stopping session | `WorkspaceTerminals.swift:3-4`, `:419-423` |
| Service restart / reboot | rows reload as `running:false, restored:true` with an empty buffer, `seq=0`; JS shows "Not running". (inferred) The bridge's `reconcile` then replaces the saved replay with the empty buffer | `:86-89`, `workspace-deck.js:115`, `terminal_replay.py:41-53` |

### 4.5 Replay, resize, input, output

- **History:** 2 MiB per session; on overflow cut at the first newline after the excess and set `truncated`. `seq` +1 per 16384-byte PTY read; each read is one `output` event, no coalescing (`:316-334`).
- **Bridge replay:** same 2 MiB plus geometry segments and `seq`; `append` ignores old `seq`. `reconcile` keeps old data if it is a prefix, else searches a 4096-byte anchor up to 64 times, else resets; a different `created` resets (`terminal_replay.py:33-53`).
- **JS replay:** `reset()`, then per geometry segment `resize(cols,rows)` and write the slice; writes `[Earlier scrollback is no longer available.]` first if `truncated`; input typed meanwhile is queued. xterm scrollback is 10000 lines (`workspace-deck.js:209-224,273`).
- **Output and backpressure:** dropped if not attached or `seq` is old; writes serialized per terminal; `receive()` resolves after parsing and Swift waits for it, the only backpressure (`:229-265`; `WorkspaceTerminals.swift:37-58`).
- **Resize:** ResizeObserver → 100 ms debounce → measure all panes. With `resizeEvents` and attached, xterm changes only on `resized`; otherwise locally, then send. The service drains output, then `TIOCSWINSZ` (`workspace-deck.js:30-43,244-251`, `workspace_terminal.py:264-269`).
- **Input:** `onData` UTF-8 → base64, `onBinary` `btoa`. Caps: JS 87000 b64 characters, Swift 90000, service 65536 bytes, compose/paste 64000 UTF-8 bytes; no chunking anywhere. An IME guard reverts replacement edits that would rewrite already-sent text (`workspace-deck.js:257`, `terminal-input.js:28-80,116-123`).

### 4.6 Host ⇄ bridge ⇄ JS

- **Swift `connect()`:** first `python3` on the `cliEnvironment` PATH (`~/.local/bin`, `~/.opencode/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, then `$PATH`), `-u <Bundle>/workspace_terminal.py bridge`, stderr discarded; called at `web` ready; ≤100 messages queued before connecting. A reader buffer >6 MiB or a 15 s JS wait ends the bridge and emits `[{event:'disconnected', error}]` (`WorkspaceTerminals.swift:12-74`). The bridge exits on socket EOF, stdin EOF or a >4 MiB buffer and saves replays on exit (`workspace_terminal.py:451-470`).
- **JS → Swift ops** (`workspace-deck.js:47`): `start {id,cwd,shell}` (no size), `attach {id}`, `detach {id}`, `input {id,data}`, `resize {id,cols,rows}`, `stop {id}`, `open-workspace {cwd}`, `stop-workspace {cwd,ids}`, `reconnect {}` (Swift reconnects and sends `watch`).
- **JS events** (`workspace-deck.js:177-239`): `sessions` adopts rows, stops rows in closed workspaces, re-attaches; `session` on exit sets Closed/Failed (a shell exit ≠0 that was not stopped raises a failure notice); `observation` → `sessionObservation`; `workspace-opened` resolves `prepareLaunch` (10 s timeout); `replay`, `resized`, `output`; `focus` opens the tab; `disconnected` detaches all; `error` rejects pending opens.
- **Ghostty look:** first `ghostty` found, `+show-config --no-pager`, killed after 4 s, output ≤512 KiB → `{source:'Ghostty', fontSize 6–72, fontFamilies[], cursorStyle, cursorBlink, padding[4], opacity, name?, theme{background, foreground, cursor, cursorAccent, selection*, 16 ANSI, extendedAnsi[240]?}}`, or `{source:'Tasktap', note}` on failure (`GhosttyAppearance.swift:6-76`).
- **Input trace:** JS records event type, timing, lengths, flags and key class (no text), flushed every 400 ms while `tasktapInputTraceUntil` is in the future; Swift whitelists fields, keeps 512 rows, writes only while `Diagnostics/input-trace-until` holds an epoch between now and now + 3600 s (`terminal-input.js:21-49`, `TerminalInputDiagnostics.swift:9-37`).

## 5. Agent sessions

**Flow.**
1. JS `enqueue {job}`. Swift `LiveWorkspace.enqueue` validates, writes `Runs/<session>/<µs-epoch>-<capture>.job` (folder 0700) and launches `<appData>/Helpers/<sha256>/run-agent <run>` with `cliEnvironment` + `WORKSPACE_ASSISTANT_INBOX` (`LiveWorkspace.swift:122-245`). Helpers is a content-addressed copy of the bundled scripts and `observers/` (`SessionHelpers.swift:6-37`).
2. `run-agent drain` holds an flock on `.lock` and walks `*.job` in sorted order (`run-agent:14-56`). **ask:** receipt `Opening`, socket `start {id:session, cwd:folder, argv:[python, run-agent, 'present', <job>, <cli>], title:task, kind:'agent'}`, then `focus`. **nudge:** receipt `Running`; manual → `pbcopy` → `Copied`; else `codex queue --thread <id> --message …` (15 s) → `Delivered`; errors → `Failed`. Notes never create jobs.
3. In the PTY, `present` holds `surface.lock` (LOCK_EX|NB) for the CLI's life; refuses if `surface.json` exists or the receipt is not `Opening` (unless it holds a reopen ticket); starts the CLI with `Popen` (no shell); writes `surface.json {open:true,tty,pid}` and receipt `Opened`; on exit writes `surface.json {open:false}`, emits `process_exited`, sets `Closed` (exit 0) or `Failed` (`visible_session.py:155-232`).
4. Swift polls receipts every 0.7 s → `agentReceipt(e)` and runs `run-agent rows` every 8 s → `sessionRows(rows)` (`LiveWorkspace.swift:19-50,82,267-290`).

### 5.1 Per-agent contract

CLI path from `shutil.which(agent)`. `--model M` on new runs only (≤250 characters, printable, not starting with `-`, `session_models.py:9-12`). cwd = `reviewedFolder` or `folder`. PTY title `Tasktap · <task[:70]>`. `observer` is true for claude, codex, pi, opencode (`LiveWorkspace.swift:6,180`); observed launches get PATH as `cliEnvironment`, `WORKSPACE_ASSISTANT_INBOX`, `TASKTAP_OBSERVER_CONFIG/PYTHON/SCRIPT` (`visible_session.py:175-185`).

| agent | new run argv (`visible_session.py:52-97`) | resume argv | observer | completion |
| --- | --- | --- | --- | --- |
| claude | `claude [--model M] --settings '{"hooks":…}' --session-id <session> --permission-mode auto -- <outgoing>` | `… --settings … --resume <handle> --permission-mode auto` | `--settings` command hooks (3 s): SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop, SessionEnd, Notification, StopFailure, PostToolUseFailure → `session_observer.py ingest <run> <token> claude` (`session_observer.py:260-270`) | Stop → `turn_finished`, StopFailure → `turn_failed`, exit → `ended` |
| codex | `codex --no-daemon -c hooks.state={…} [-c projects={"<dir>"={trust_level="trusted"}}] [--model M] -c hooks.<8>=… --approve-for-me -- <outgoing>` | `… --approve-for-me resume <handle>` | 7 shared hooks + `Interrupt`; trust probe `codex app-server --listen stdio://` → `hooks/list` (12 s) must find exactly 8 trusted hooks or the launch fails (`session_observer.py:56-106,271-277`) | as claude + `turn_interrupted`; nudges via `codex queue` |
| pi | `pi [--model M] -e <Helpers>/observers/pi.mjs --approve -- <outgoing>` | none | extension: session_start, before_agent_start, agent_start, tool_execution_*, message_end, agent_settled, ui_prompt_*, session_shutdown → `emit.mjs` (`observers/pi.mjs:6-33`) | observer |
| opencode | `opencode [--model M] --auto --prompt <outgoing>`; `OPENCODE_CONFIG_CONTENT` + `plugin:[file://…/observers/opencode]` | none | plugin: session.created, session.status, message.updated, message.part.updated (500 ms throttle), permission.asked, question.asked, session.error (`observers/opencode/index.mjs:11-50`) | observer |
| cursor-agent | `cursor-agent [--model M] --auto-review agent -- <outgoing>` | none | none (adapter at `session_observer.py:279-289` unreachable: `observer` false) | process exit |
| agy | `agy [--model M] --mode auto --prompt-interactive <outgoing>` | none | none (`agy_session.py` is test-only and removed from the bundle, `build-mac.sh:11`) | process exit |

**Legacy path** (`observer` not true, `visible_session.py:70-96`): claude, codex and pi attach the MCP server `workspace_assistant` (`agent-tools`) with `--append-system-prompt` or instructions appended to the prompt. (inferred) Jobs written by this build never take it for claude, codex or pi; agy and cursor-agent take it but get no MCP server. **Shell launch:** in a Tasktap shell PTY, `claude`, `codex`, `pi`, `opencode` are shims for `tasktap_shell.py cli`; on an interactive TTY they add hooks and the default approval flag and write `shell.job` and `shell.receipt {state:'Opened'}`; if `surface.lock` is busy the nested CLI runs unobserved (`tasktap_shell.py:19-141`).

### 5.2 Run-folder files (`<appData>/Runs/<session-uuid>/`)

| file | writer | fields / format |
| --- | --- | --- |
| `<µs>-<capture>.job` | `LiveWorkspace.enqueue` (atomic, once) | from JS (`live.js:122-128`): `delivery:'interactive'`, `manual`, `outgoing`, `instructions`, `routingEvidence`, `routingPayload`, `transcript`, `accounts`, `session`, `capture`, `task`, `agent`, `folder`, `brief`, `reference`, `strokes`, `note`, `mode` (ask/nudge), `keep`, `create`, `model?`, `reviewedFolder?`, `retryOf?`; Swift sets `folder` (standardized), `resume` (never read), `observer`, `reviewedFolder` |
| `<same>.receipt` | run-agent, present, agent-tools, LiveWorkspace | `{state, message?}` (§5.3) |
| `shell.job` / `shell.receipt` | `tasktap_shell.py:130-134` | `{agent, mode:'ask', delivery:'interactive', observer:true, shellLaunch:true, session, capture, folder, terminalFolder, task, outgoing:'', instructions:''}` / `{state:'Opened'}`, never updated |
| `.lock`, `surface.lock`, `.reopen.lock` | drain + report_result / present + shell / reopen | flock only; `surface.lock` held = alive |
| `surface.json`; `reopen.json` | present, tasktap_shell; `visible.reopen` | `{open, tty, pid, shellLaunch?}`; `{ticket}`, busy for 90 s |
| `observer-config.json` | `prepare` (0600) | `{token, session, agent, turnBase, answers, hookArgs, command, trustedArgs?}` |
| `observer.json` (+ `.lock`) | `ingest` | `{launch, session, agent, state, turn, sequence, seen[≤128], answers[≤20 {turn,file,time}], history[≤40 {kind,state,turn,at,activity}], isWorking, event, updatedAt, providerSession, providerTurn, activity≤500, question≤2000, assistantText, finalAnswer, answerFile, error≤500, lastTurnState, exitCode}`; public form adds `launchId` = sha256(token)[:16] (`session_observer.py:35-39`) |
| `observer-events.jsonl` (→ `.previous.jsonl` at 2 MiB) | `ingest` | `{sequence, at, kind, state, turn, activity}`; no reader found |
| `answer-NNNN.txt` | `ingest` on `turn_finished` (0600) | raw final answer; Swift reads ≤2 MiB (`LiveWorkspace.swift:198-204`) |
| `thread.json`; `claude-turn-started` | `ingest` (codex), agent-tools (`CODEX_THREAD_ID`); agent-tools on claude `ask_user` | `{id}`; empty marker |
| `observer-cursor/…` | `prepare` (cursor) | plugin manifest + `hooks.json` v1; unreachable |
| `Resume.command`, `Result.txt`, `Result.pdf` | main:1003-1005, `ResultDocument` | zsh 0700; text; PDF |
| `conversation.json` | **no writer found** | read by `resumeCommand` (`LiveWorkspace.swift:300`) |
| `Runs/active-project-sessions.json` | `project_sessions.save_project_activity`, no production caller | `[{session, folder, agent, task, state}]` |

`enqueue` also writes `<appData>/Notes/<capture>.json` (or `Scratch/`) as `{workspace, text, strokes, saved (ISO 8601)}` for a note or `keep` (`LiveWorkspace.swift:167-172`).

### 5.3 Lifecycle states

| receipt state | set by | trigger | next |
| --- | --- | --- | --- |
| (none) | – | job written | Opening / Running |
| Opening | `run-agent:29` | ask drained | Opened; Failed (open error, or Swift watchdog after 90 s without `surface.json`, `LiveWorkspace.swift:270-275`) |
| Opened | `present` | CLI spawned | Closed / Failed / Complete (legacy `report_result`) |
| Closed | `present` | CLI exit 0 | – |
| Running | `run-agent:32` | nudge drained | Copied / Delivered / Failed; found again on a later drain → Failed "Delivery was interrupted" |
| Copied / Delivered | `run-agent:42,46` | manual copy / `codex queue` ok | – |
| Complete | `agent-tools:52-54` | MCP `report_result {capture, summary ≤32000}` | – |
| Failed | run-agent, present, LiveWorkspace | errors; a runner exit ≠0 overwrites any receipt that is not Complete/Failed (`LiveWorkspace.swift:236-241`) | – |

Swift treats Complete, Failed, Delivered, Opened, Copied, Opening, Closed as finished; at app start it relaunches drain for folders whose receipt is missing or `Running` (`LiveWorkspace.swift:61-81`). JS adds `Queued` and `Saved` (`live.js:144`).

**Observer states** (`session_observer.py:22-30,129-181`): `launch_started`→starting; `cli_started`, `session_started`, `turn_finished`→ready; `turn_started`, `activity`, `continued`→working; `permission_requested`→needsPermission; `input_requested`→needsInput; `turn_failed`→failed; `turn_interrupted`→interrupted; `process_exited`→ended (terminal). Guards: a new token resets; `cli_started` only from starting; subagent events and mismatched session/turn ids ignored; event ids deduplicated. `process_exited` has three sources: `present`/shell `finally`, the service `waitpid`, and the `session_rows` scan.

**Row state** (`session_rows.py:17-54`): `Connected` while alive (`surface.json.open` and `surface.lock` held); otherwise `Complete` if the latest receipt is Complete, else `Closed`; with an observer its label (Awaiting agent, Ready, Running, Needs input, Failed, Interrupted, Closed). Row fields: `id, agent, folder, owned, task, inbox (manual/codex), state, available, scratch, conversation, resumable?, updatedAt (ms string), startup?, activity, observerState, observation (JSON string)`; Swift strips `activity` before JS (main:680).

### 5.4 Resume, reopen, retry

| topic | behavior | ref |
| --- | --- | --- |
| `resume_id` | only interactive ask jobs whose `session` = folder name, never shell launches. Observed claude/codex: `observer.json.providerSession`; codex: `thread.json.id`; claude: `job.session` if `claude-turn-started` exists or a receipt is Complete. pi, opencode, cursor-agent, agy cannot resume | `visible_session.py:114-130` |
| Reopen | shown when `resumable && !available`. Swift checks the folder, runs `run-agent reopen`; under `.reopen.lock`: alive → only `focus`; else needs `resume_id`, refuses within 90 s of the last ticket, writes `reopen.json`, sends `start` with `restart:true` and argv `… present <job> <cli> --reopen <ticket>`. `present` consumes the ticket; receipt unchanged; observer `turnBase`/`answers` carry over | `app.js:291`, `visible_session.py:133-152`, `LiveWorkspace.swift:246-266` |
| Resume in Terminal / copy | requires all receipts Complete/Failed, empty `planAccount`, claude or codex, and `conversation.json`; builds `cd -- '<cwd>' && claude --resume <id>` or `codex resume <id>`. UI offers it only for non-interactive sessions | `LiveWorkspace.swift:291-307`, `app.js:297` |
| Failed handoff retry | exactly one `.job`; receipt `Failed`; mode ask; delivery interactive; no `thread.json` or `claude-turn-started`; `surface.lock` not held | `LiveWorkspace.swift:88-109` |
| Shared vs agent-specific | shared: job/receipt/surface/observer files, the service, `ingest`, the row scan. Agent-specific: argv, hook injection, codex trust probe/`thread.json`/`queue`, claude marker, opencode plugin env, pi extension | – |

### 5.5 Supporting calls and payloads

- **Session naming** (`SessionNames.swift:33-64`): a 20 s loop picks the next Running/Needs input row with new `activity`, at most once per session per 180 s; calls `routingProviders.nameSession({originalRequest:task[:200], recentMessages:activity})`; a result of 8–140 characters without `<` or triple backticks → `sessionNameChanged(id,name,fingerprint)`.
- **CLI detection** (`router-provider:144-200`): `which` for the six CLIs plus `codex login status`, `claude auth status --json`, `cursor-agent status --format json` (4 s each) → `{workers{agent:label}, workerHealth{agent: missing|unknown|installed|signedIn|signedOut|configured}, cloud}`.
- **Usage** (`worker_usage.py:14-111`): claude/codex when `signedIn` with plan login. Codex `codex app-server --listen stdio://` → `initialize` → `account/rateLimits/read`; claude `claude … -p --input-format stream-json --output-format stream-json` with control request `get_usage`; 10 s, 1 MiB → `{checkedAt, agents:{agent:[{remaining 0–100, resetsAt, minutes}]}}`. **Login:** `osascript` Terminal.app `<cli> auth login`/`login` (60 s) (`router-provider:203-223`).
- **To JS:** `agentReceipt(e)` = `{capture, session, folder, scratch, delivery, planAccount, model, agent, task, accounts, brief, transcript, routingEvidence, routingPayload, outgoing, instructions, mode, state, message, recovered}` (`live.js:164`); `projectsDiscovered(rows)` = `[{folder, name, available, checkout, …}]`, upserted by folder, missing → unavailable (`live.js:6`); `acceptLive` applies only if `draft.captureId` matches (`live.js:140`).

## 6. Questions and answers

Two paths: **(A)** a file inbox with MCP tool `ask_user`, used by legacy non-observer launches and external adapters (`docs/agent-questions.md:7`); **(B)** observer lifecycle events, display only, answered in the agent's terminal.

### 6.1 Inbox path (A)

| step | actor | action | ref |
| --- | --- | --- | --- |
| 1 | agent CLI | MCP `ask_user {request*, question*, detail, choices[2..12], after≥0}` on stdio server `agent-tools` (`workspace-assistant` 0.3, protocol 2024-11-05…2025-11-25) | `agent-tools:18-24,69-72,117-121` |
| 2 | agent-tools | spawns `ask-user --agent --session --workspace --task --request --question --detail --after --choice…`, returns its first stdout line as the tool text; `notifications/cancelled` kills it | `agent-tools:81-115` |
| 3 | ask-user | writes an immutable request (temp file + `os.link`); identical content = retry, different content fails | `ask-user:23-46` |
| 4 | QuestionInbox | file watcher on `requests/` → `scan()` → `receiveAgentQuestion(event, prior)` in `web` → result written to `responses/<same name>` | `QuestionInbox.swift:23-28,44-81` |
| 5 | JS | creates project, session (`Needs input`) and decision if missing; persists | `questions.js:17-31` |
| 6 | person | choice (`answerKind:'choice'`) or text/voice reply (`'freeform'`); decision moves to `session.answeredDecisions`; JS posts `questionUpdated` | `app.js:362-382` |
| 7 | Swift | `inbox.scan()`; JS returns `status:'answered'`; Swift writes the response and marks it settled | main:1051, `QuestionInbox.swift:71-72` |
| 8 | ask-user | polls every 0.2 s; prints `{request,session,type:'discussion',cursor,text}` lines, then `{request,session,type:'answer',answer,answerKind}`, exits | `ask-user:47-58` |

| file (`<appData>/Agent Inbox/`, dirs 0700, umask 077) | writer | fields |
| --- | --- | --- |
| `requests/<uuid>.json` | ask-user, never modified | `agent` (codex, claude, agy), `sessionId`, `requestId`, `question`, `detail`, `workspace` (resolved absolute), `task` (default sessionId), `choices?` (2–12 distinct); ≤64 KiB; name `UUID(sha256(json([agent,workspace,sessionId,requestId]))[:16])` (`ask-user:16-36`) |
| `responses/<uuid>.json` | Swift, atomic, sorted keys, rewritten only on change | `id` (decision id), `status` (pending/answered), `discussion[]`, `answer?`, `answerKind?`; `producerKey` stripped (`QuestionInbox.swift:68,83-89`) |

Swift reads only `*.json` with a UUID stem, skipping hidden files, symlinks, non-regular files and files >65536 bytes, in sorted order (`QuestionInbox.swift:49-65`). Inbox location: `WORKSPACE_ASSISTANT_INBOX`, else `TASKTAP_DATA/Agent Inbox` (`ask-user:32`).

### 6.2 Identity, states, restart, expiry

- **Keys:** session key `JSON.stringify([agent,workspace,sessionId])`, request key `JSON.stringify([sessionKey,requestId])`; Tasktap launches pre-set `producerKey = JSON.stringify([agent,folder,runId])` (`questions.js:7-8`, `live.js:153,169`). JS requires one of the six providers and throws on a known id with different content (`questions.js:5-14`). Kind `binary` when there are no choices (No/Yes), else `choice`.
- **States:** session Running → Needs input → Running; on withdrawal the last capture receipt or `Last seen` (`questions.js:42-47`).
- **Restart:** the stored response is passed as `prior` on first sight per process; pending restores the same decision id; answered is settled and never re-sent (`QuestionInbox.swift:58-63`). **Reconcile:** only when every file evaluated cleanly, `reconcileAgentQuestions(activeKeys)` removes decisions whose request file is gone (`QuestionInbox.swift:78-80`, `questions.js:36-51`).
- **Expiry:** none; no timeout in ask-user, agent-tools or the inbox, and nothing deletes inbox files.
- **Hotkeys:** see `binary` (§1.1); `hw-yes`/`hw-no` pick the Yes/No index, `hw-discuss` opens the reply field (`surfaces.js:323-328`).
- **`report_result {capture, summary}`** (legacy): takes the run `.lock`, needs the matching interactive job, writes receipt `{state:'Complete', message}`, returns "Already reported." on repeat (`agent-tools:34-55`).

### 6.3 Observer path (B)

| step | detail | ref |
| --- | --- | --- |
| Hook mapping | `PreToolUse` of `AskUserQuestion`/`request_user_input` → `input_requested` with the joined questions (≤2000); `Notification` `permission_prompt` → `permission_requested`, `elicitation_dialog` → `input_requested`; `PermissionRequest` → `permission_requested` ("Permission is required in the agent terminal for <tool>.") | `session_observer.py:216-239` |
| State | needsInput / needsPermission; `question` cleared by activity, continued, turn_started | `session_observer.py:22-28,164-181` |
| Delivery | `ingest` writes `observer.json`, sends `observe {id, runDir, token}` (0.2 s timeout); service broadcasts `observation` → `workspaceDeck.receive` → `sessionObservation.receive` | `session_observer.py:42-52`, `workspace-deck.js:202` |
| UI | cue `?` (input) or `◇` (permission); "Questions and permissions shown by the CLI are answered in its terminal."; no reply API | `session-observation.js:22-30,80` |
| Answers | `observer-answer {id, turn 0..999999}` → `answer-%04d.txt` → `sessionObservation.showAnswer` | main:716-720 |

## 7. Routing and request preparation

### 7.1 Request `route.input` (`capture-preparation.js:12-27`)

| field | contents |
| --- | --- |
| `capture`, `estimateDifficulty`, `currentWorkspace` | text; true for ask with the adaptive model policy; visible project index or −1 |
| `projects[≤8]` | `{index, name ≤100, aliases[≤3] ≤60}` |
| `sessions[≤8]` | `{index, name ≤140, originalTask ≤180, project idx, agent, state, delivery manual/automatic}`; only eligible sessions (not Closed, Failed or Awaiting, and nudgeable) |
| `recentCaptures[≤3]`, `selection` | `{session idx, request ≤320, state, result ≤160}`; `{project, session, mode}` |
| order, `server`, consent | ranked by score; `server` `{kind, url, model, hasKey}` sent alongside; a non-local provider first shows the payload and `routingInstructions` to the person (`live.js:203-224`) |

### 7.2 Result `r` and progress

- **Progress** (local only): `{phase:'generating'}`, `{phase:'brief', brief}` at most every 90 ms, `{phase:'matching'}` (`HandoffRouter.swift:48-66`).
- **Result fields:** `source` (apple, local-match, unavailable, fallback, error + `message`, or provider id); `brief` ≤16000; `mode` ask/note/nudge; `project`/`session` index or −1; `routeConfidence` `clear`/`ambiguous`/`unknown`; `routeEvidence`, `routeQuote`, `sessionCandidates[≤8]`, `projectCandidates[≤8]`; `difficulty` 1–10 and `scopeEvidence` only with `estimateDifficulty`; `constraints[≤12]`, `agent`, `viewer`, `note` from remote providers only; `routeFallback:true` when the Apple brief succeeded but matching threw. All properties required, `additionalProperties:false` (`RoutingProviders.swift:114-125,188-190`).
- **Acceptance in JS** (`capture-preparation.js:30-86`, `live.js:227-246`): `source:'error'` offers "Continue on this Mac". `session N`/`project N` in the brief become names; constraints of 3–1000 characters found verbatim in the capture but missing from the brief are appended as `• quote`. A session is chosen only if `routeConfidence=='clear'`, `routeQuote` (≥3 characters) appears in the capture or a related text, `routeEvidence` names the session, and the session is still eligible. Difficulty is accepted only for ask, as an integer 1–10, with `scopeEvidence` in the capture.

### 7.3 Providers (`RoutingProviders.Route`: claude-session, local, chatgpt, openai, anthropic, codex, cloud, server; `RoutingProviders.swift:4-7`)

| route | how it is called | ref |
| --- | --- | --- |
| local | Apple FoundationModels `SystemLanguageModel.default`. Stage 1 brief: temperature 0, ≤1000 tokens, dynamic schema. Stage 2 match: ≤700 tokens, names constrained to enums; duplicate names → −1 and `ambiguous`. Model unavailable → regex for "X, not the Y session" (`local-match`/`unavailable`) | `HandoffRouter.swift:18-167` |
| claude-session | not routed. `prepare-open` → `osascript` Terminal.app `cd <TASKTAP_DATA>/Preparation && exec claude --session-id <id> --name 'Tasktap · Draft a brief' --tools '' --strict-mcp-config --safe-mode`; the person pastes the prompt (`claude-brief.js:4-6`). `prepare-reply` reads the transcript through `session_lifecycle` and returns the last `end_turn` assistant message, 1–16000 characters | `router-provider:213-260` |
| codex | `codex --ask-for-approval never exec --ignore-user-config --ephemeral --disable shell_tool --disable unified_exec --disable plugins --disable hooks -c project_doc_max_bytes=0 -c web_search="disabled" --sandbox read-only --skip-git-repo-check --output-schema <tmp>/handoff.json -o <tmp>/result.json [--model M] -`; prompt on stdin, temp cwd, 85 s | `router-provider:82-130` |
| cloud | `claude --bare -p --tools '' --strict-mcp-config --no-session-persistence --output-format json --json-schema <schema> [--model M]`; exactly one of `CLAUDE_CODE_USE_BEDROCK/_VERTEX/_FOUNDRY` must be set | `router-provider:75-127` |
| server | OpenAI-compatible POST `<base>/chat/completions {model, stream:false, messages}`, optional Bearer; needs `finish_reason=='stop'`, ≤64 KiB. Discovery GET `<base>/models`. Loopback, `.local`, dotless, `10.*`, `192.168.*` hosts use http, others https; default path `/v1`; reviewed `kind/url/model` must match the saved profile | `ModelServer.swift:11-95`, `RoutingProviders.swift:139-146` |
| anthropic | POST `api.anthropic.com/v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`, `max_tokens:1800`; needs `end_turn` | `RoutingProviders.swift:147-154` |
| openai | POST `api.openai.com/v1/responses {model, instructions, store:false, stream:true, input}` (SSE): `response.output_text.delta`, `response.completed`; `failed`/`incomplete`/`error` throw; ≤64000 B | `RoutingProviders.swift:155-183,103-113` |
| chatgpt | as openai with an OAuth Bearer; with no saved model, the first `visibility=='list'` slug from `/v1/models` | `RoutingProviders.swift:158-165` |

- **Instructions:** remote prompts = `HandoffRouter.instructions` + "Return only JSON matching this schema." + schema; codex and cloud append the input. The same text reaches the UI as `routingInstructions` (`HandoffRouter.swift:6-15`, `RoutingProviders.swift:52,133-138`).
- **HTTP:** ephemeral session, no cookies, redirects refused, 45 s request / 90 s resource timeouts (`RouterConnection.swift:46-80`); ModelServer 12 s GET / 120 s POST. Limits: model ≤160 characters, no whitespace (server ≤256); key ≤4096 B. UI default models `gpt-5.4-mini` (openai), `claude-haiku-5-5` (anthropic) (`connections.js:137`). Session naming reuses `suggest(sessionName:true)` (`RoutingProviders.swift:193-199`).
- **UI-only choices:** worker = first healthy ranked agent with quota ≥ `reserve`, else the first with unknown quota (`worker-routing.js:7-35`); model tier by difficulty vs `standardAt`/`complexAt`, presets claude haiku/sonnet/opus, codex gpt-6-luna/gpt-6.1-sol/gpt-6-astra, agy gemini-3.8-flash/gemini-4-hydrogen/gemini-4-carbon (`model-policy.js:2-72`).

### 7.4 Accounts and keys

- **ChatGPT OAuth** (`RouterConnection.swift:182-282`, `router-provider:21-72`): loopback callback `127.0.0.1:<random>/auth/callback` (≤180 s); authorize at `auth.openai.com/api/accounts/authorize` with PKCE S256, state, nonce, scope `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, resource `https://api.openai.com/v1`, `ext_agent_host_id` = `router.chatgpt.host`; token from `/oauth/token`; `id_token` RS256 via JWKS (iss, aud/azp, exp, nonce); refresh within 30 s of expiry; sign-out revokes at the discovered endpoint, then deletes the keychain item.
- **State to the UI** (`RoutingProviders.swift:50-55`): `{routingInstructions, serverKind, serverProfiles, choice, models{route:id}, accounts[{id,label,status}], account, workers, workerHealth, cloud, keys{openai,anthropic}}`. Secrets never reach JS.

### 7.5 Capture context (`captureContext.receive` result)

Fields: `value` (URL or path), `kind` (file/website), `app`, `sourceID` (`bundle:pid`), `observedAt` (ISO), `origin` (capture/refresh), `freshness` (current, stale >300 s, changed, unavailable, refreshed), `message`, `permission:'automation'`. Read via the AX focused window's `AXDocument` when trusted, else Apple Events: Finder selection, Safari `cTab pURL`, Chromium family `acTa URL` (2 s without prompt, 60 s with consent when `allowPermission`). Source = frontmost app, or the previous app if left within 300 s (`ScreenContext.swift:50-153`). JS falls back to manual entry after 5.5 s (65 s with permission) (`context.js:73`).

## 8. Speech

| engine | runs | model / location | behavior | ref |
| --- | --- | --- | --- | --- |
| `apple-dictation` (recommended) | local | `DictationTranscriber` `.progressiveLongDictation`; assets via `AssetInventory` (system location, not determined) | streams `partial`, then `text` | `Dictation.swift:119-121`, `SpeechService.swift:103-118` |
| `apple-speech` | local | `SpeechTranscriber` `.progressiveTranscription` | same | `Dictation.swift:122-125` |
| `whisper-turbo` | local helper `tasktap-speech` (WhisperKit 0.18.0) | `large-v3-v20240930_626MB` in `<appData>/Speech/Whisper/<model>/`, marker `ready.json {model,folder,tokenizer}`; download source not stated in code | records, transcribes after release | `SpeechRuntime/Package.swift:7-11`, `SpeechRuntime/…/main.swift:22-58` |
| cloud openai | HTTP | POST `api.openai.com/v1/audio/transcriptions`, Bearer, multipart `model, language?, response_format=json, file`; gpt-transcribe, gpt-4o-transcribe, gpt-4o-mini-transcribe | upload after release | `CloudSpeech.swift:4-53` |
| cloud deepgram | HTTP | POST `api.deepgram.com/v1/listen?model&language&smart_format=true`, `Token`, raw wav; nova-3 | same | same |
| cloud elevenlabs | HTTP | POST `api.elevenlabs.io/v1/speech-to-text`, `xi-api-key`, multipart `model_id, language_code?, file`; scribe_v3, scribe_v2 | same | same |
| narration Siri | local | `AVSpeechSynthesizer`, voices with id prefix `com.apple.siri.` | – | `Narration.swift:77-79,105-109` |
| narration Kokoro | local Python | `<appData>/Kokoro/venv/bin/python kokoro-voice <txt> <wav>` (kokoro-onnx 0.4.9, voice af_heart, en-us); without an install it falls back to `http://127.0.0.1:8880/v1/audio/speech` (45 s) | – | `Narration.swift:16-103`, `scripts/kokoro-voice:12-69` |

- **Audio:** `$TMPDIR/tasktap-dictation-<uuid>/dictation.wav`, 16 kHz mono Int16, ≤300 s, 0600, deleted afterwards; cloud uploads ≤20 MB, 90 s (`CloudSpeech.swift:58-106`). Level `(dB+55)/49` clamped 0–1 (`Dictation.swift:16-48`). `auto` language = first preferred language (Apple) or detection (Whisper).
- **Kokoro install:** venv via uv or python3.12/3.11/3.10; fetches `kokoro-v1.0.int8.onnx` and `voices-v1.0.bin` from GitHub releases with SHA-256 checks; marker `ready-v1`; lock `.install.lock`.
- **UI interface:** in, the 16 messages of §1.7; `speech-save` takes `configuration {mode local|cloud, localEngine recommended|apple-dictation|apple-speech|whisper-turbo, provider, language auto|^[a-z]{2,3}(-[A-Za-z]{2,4})?$, models{provider:'recommended' or id}}` (`SpeechPreferences.swift:42-56`). Out: `dictationEvent` phases recording, partial (whole replaceable string), processing, text, stopped, error; `voiceSettings.receive {configuration, recommendedEngine, engineNames, recommendedModels, models, supported, ready, phase idle|downloading|error, detail, progress, microphone allowed|denied|unknown, appleLanguage}` (`SpeechService.swift:36-55`); `updateKokoro` installing/ready/missing; `narration-status`.
- **Whisper helper NDJSON:** `{phase:downloading,progress}`, `{phase:preparing}`, `{phase:ready}`, `{phase:text,text}`, `{phase:error,message}` (`SpeechRuntime/…/main.swift:28-61`).
- **Hotkey hold:** ⌃⌥Space press → `hw-capture`; JS starts dictation after 150 ms held (`surfaces.js:308`); release → Swift `dictation.finish` + `hw-capture-end`.

## 9. Data on disk outside the repository

| location | owner | format |
| --- | --- | --- |
| `<appData>/Terminals/` | terminal service, bridge, `tasktap_shell` | §4.3 |
| `<appData>/Runs/<id>/`, `Runs/active-project-sessions.json` | LiveWorkspace, run-agent, present, ingest, agent-tools | §5.2 |
| `<appData>/Notes/<capture>.json`, `<appData>/Scratch/` | LiveWorkspace (`:146,167-172,205-224`) | `{workspace, text, strokes, saved}` |
| `<appData>/Agent Inbox/{requests,responses}/` | ask-user, QuestionInbox | §6.1 |
| `<appData>/Helpers/<sha256>/` (+ staging `<uuid>`) | SessionHelpers (`:21-35`) | copies of `*.py`, run-agent, agent-tools, ask-user, router-provider, kokoro-voice, `observers/`; 0700 |
| `<appData>/WorkspaceFolders.json` | `WorkspaceFolders.swift:51-58` (0600) | `{root, rootCheckout, approved:[{name,folder,checkout}], known:[…]}` |
| `<appData>/WorkspaceMedia.json` | `WorkspaceMedia.swift:16-42` (dir 0700) | `{previewId: absolutePath}`; grows with every opened file, never pruned |
| `<appData>/Diagnostics/terminal-input-events.json`, `input-trace-until` | `TerminalInputDiagnostics.swift` | `{events:[…≤512]}`; epoch seconds |
| `<appData>/Speech/preferences.json` (0600), `Speech/Whisper/…` | SpeechPreferenceStore, `tasktap-speech` | `{mode, localEngine, provider, language, models}`; model + `ready.json` |
| `<appData>/Kokoro/` | kokoro-voice | venv, `*.onnx`, `*.bin`, `ready-v1`, `.install.lock` |
| `<appData>/Preparation/` | router-provider | cwd of the Claude brief session; transcript under `~/.claude/projects/` (inferred from `session_lifecycle.py:9-13`) |
| `$TMPDIR/tasktap-dictation-*`, `$TMPDIR/<uuid>/speech.{txt,wav}`, `$TMPDIR/tasktap-router-*` | Dictation, Narration, router-provider | temporary |
| Keychain service `<bundleId>.routing`, WhenUnlockedThisDeviceOnly (`RouterConnection.swift:14`) | RouterSecrets | accounts `openai`, `anthropic` (API keys), `chatgpt.<client>` (token JSON with `expires`), `server.<kind>.<sha256(baseURL)>`, `speech.openai`, `speech.deepgram`, `speech.elevenlabs` |
| UserDefaults (app domain) | RoutingProviders, ChatGPTConnection, AppKit, Sparkle | `router.choice`, `router.model.<route>`, `router.server.profiles {kind:{url,model,hasKey}}`, `router.server.kind`, `router.key.openai`/`.anthropic` (bool), `router.chatgpt.selected`, `router.chatgpt.registrations {client:{sub,email,plan}}`, `router.chatgpt.host` (`urn:uuid:…`); window frame autosave `TasktapWorkspace` (main:68); Sparkle `SU*` keys |
| WebKit localStorage (default data store, origin `file://`, shared by both views) | JS | §3.3 |
| SMAppService login item; notification permission; TCC grants (microphone, speech, Apple Events, Accessibility) | macOS | per bundle id |
| General pasteboard | prepare-open, copy-*, run-agent `pbcopy`, terminal copy | text |

**Environment variables.** Set by Swift: `TASKTAP_DATA` (main:1794), `PATH` and `WORKSPACE_ASSISTANT_INBOX` (`LiveWorkspace.swift:26-30,230`). Read: `TASKTAP_TERMINAL_ROOT`, `SHELL`; observers `TASKTAP_OBSERVER_CONFIG/PYTHON/SCRIPT`, `OPENCODE_CONFIG_CONTENT`; Tasktap shell `TASKTAP_TERMINAL_ID`, `TASKTAP_RUNS`, `TASKTAP_TERMINAL_FOLDER`, `TASKTAP_CLI_BIN`, `TASKTAP_USER_ZDOTDIR`, `TASKTAP_ZDOTDIR_WAS_SET`, `TASKTAP_BOOTSTRAP_ZDOTDIR`; agents `CODEX_THREAD_ID`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`; providers `CLAUDE_CODE_USE_BEDROCK/_VERTEX/_FOUNDRY`, `ANTHROPIC_BASE_URL/_AUTH_TOKEN/_API_KEY`, `GEMINI_API_KEY`; verify runs `TASKTAP_WORKSPACE_SNAPSHOT`.

## 10. Periodic work

Recurring (wakes while idle):

| where | period | purpose |
| --- | --- | --- |
| `main.swift:300-305` | Timer 80 ms (tolerance 25 ms), always on after ready | pointer position for notch hover and click-through |
| `LiveWorkspace.swift:82` | Timer 0.7 s | poll run-folder receipts → `agentReceipt` |
| `LiveWorkspace.swift:21` | Timer 8 s | spawns a Python process (`run-agent rows`) → `sessionRows`; the scan also writes `observer.json` and publishes for dead sessions (`session_rows.py:44-47`) |
| `SessionNames.swift:39` | `Task.sleep` loop, 20 s | session naming, at most once per session per 180 s |
| `workspace_terminal.py:350` | `select` timeout 50 ms | service loop: I/O, `waitpid` poll, kill escalation, workspace-closed check, idle exit; runs whenever the service is up |
| `ask-user:48-58` | sleep 0.2 s, unbounded | poll for the response file |
| Sparkle (`native/Info.plist` `SUScheduledCheckInterval` 86400) | 24 h | update check, if automatic checks are on |

Event-driven or bounded:

| where | period / trigger | purpose |
| --- | --- | --- |
| `QuestionInbox.swift:25` | DispatchSource watcher (write, rename) on `requests/` | rescan |
| `LiveWorkspace.swift:272` | 90 s | Opening watchdog → Failed |
| `WorkspaceTerminals.swift:57` | semaphore ≤15 s per batch | JS backpressure; a timeout kills the bridge |
| `workspace_terminal.py:391,421,43-55,292` | 2 s / 60 s / 60 × 50 ms / 2 s | SIGKILL escalation / idle exit / connect retry / `sessions.json` throttle |
| `workspace_terminal.py:451` | blocking `select` | bridge loop (no timeout) |
| `GhosttyAppearance.swift:64` | asyncAfter 4 s | kill `ghostty +show-config` |
| `main.swift:559,564` | 120 s staleness, on demand | CLI detection and usage cache |
| `visible_session.py:143,246` | 90 s / 15 s | reopen ticket window / `codex queue` timeout |
| `session_observer.py:48,66,84,265`; `observers/emit.mjs:12`; `observers/opencode/index.mjs:39` | 0.2 s / 12 s / 2 s / 3 s; 3 s; 500 ms | publish timeout / codex trust probe / app-server stop / hook timeout; ingest spawn; text throttle |
| `router-provider:28,63-66,119,147,221`; `worker_usage.py:57,82` | 180 s OAuth wait (1 s loop), 85 s, 4 s, 60 s; 10 s, 1 s | OAuth callback, CLI route, status probes, osascript; usage protocol |
| `RouterConnection.swift:55-56`, `ModelServer.swift:55`, `CloudSpeech.swift:49`, `Narration.swift:23,92` | 45/90 s, 12/120 s, 90 s, 2/45 s | HTTP timeouts |
| `HandoffRouter.swift:58` | 90 ms throttle | brief progress events |
| `ScreenContext.swift:52,103,201` | 300 s / 300 s / 2 s or 60 s | previous-app window / stale reference / Apple Event timeout |
| `main.swift:661-668` | one in flight, only while a window is visible | dictation level events |
| `voice-wave.js:72`, `relay.js:118` | requestAnimationFrame loops | waveform while recording; relay animation |
| `surfaces.js:401`, `workspace-navigation.js:112`, `workspace-deck.js:375,383,598,838` | rAF, coalesced | `layout` posts, sidebar sync, focus, fit |
| `workspace-deck.js:35,134,169,285,343` | 100 ms / 70 ms / 1.25 s / 900 ms / 10 s | fit debounce / persist + render debounce / acknowledge answer / scroll class / open-workspace timeout |
| `terminal-input.js:25,55,62,70,75` | 400 ms; `setTimeout 0` | trace flush; IME settle |
| `surfaces.js:64,86-91,308` | 3.2 s; 170–320 ms; 150 ms | receipt fold; hover peek; hold-to-dictate |
| `worker-routing.js:52,55`; `context.js:73` | ≥120 s throttle, 40 s timeout; 5.5 s or 65 s | usage request; reference fallback |
| `app.js:227,547,550,584,643,660` | 3 s; 1.4 s (demo); 650 ms (demo); 1.2 s | toast; demo delivery; demo sample; update-draft restore |
| `connections.js:74-76`, `workspace-deck.js:173` | window `focus` | `ai-refresh` if setup is showing; acknowledge focused terminal |
| `visibilitychange`: `workspace-deck.js:174,501,516`, `surfaces.js:28`, `motion.js:142`, `relay.js:54`, `voice-wave.js:102` | event | acknowledge, end drags, fold notch, pause animation |
| Mutation/ResizeObserver: `surfaces.js:477-487`, `application-menu.js:30-31`, `motion.js:138-141`, `workspace-deck.js:30-43` | event | bounds → `layout`; menu state; film playback; terminal fit |
| `main.swift:174,246`; `main.swift:1095-1700` | asyncAfter 12/60 s; many `Task.sleep` | verify-run timeouts and waits only |

There is no `setInterval` in `prototype/*.js`, and the JS never polls the host on a timer.

## 11. Host-only abilities today

| ability | how it works | ref |
| --- | --- | --- |
| Notch panel | borderless non-activating `NSPanel` (`canBecomeKey`) at status-bar level + 1, all Spaces and full screen, clear, no shadow; web view accepts the first mouse click | main:16-21,201-210 |
| Notch geometry | `auxiliaryTopLeftArea`/`RightArea` + `safeAreaInsets.top`, pixel-snapped; without a camera housing the tab is 104×16, or 120×20 on smaller screens. Content width 400–640 compact, else 432–680, plus 13 pt shoulders; collapsed height = tab + 16 pt glow margin | `NotchGeometry.swift:21-62` |
| Hover and screens | the 80 ms timer toggles `ignoresMouseEvents` and sends hover-enter/exit; the notch moves to a screen when the pointer enters its collapsed tab; re-anchors on screen changes | main:230-238,277-306 |
| Decision glow | separate click-through panel: metallic gradient stroke around the tab, halo and bloom pulsing twice (0.6 s autoreverse), shown while the workspace window is visible and `status.count > 0`; respects Reduce Motion. The notch page draws its own glow in CSS | `WorkspaceDecisionRim.swift`, main:263 |
| Translucent backdrop | `NSVisualEffectView` (behind window) + tint from `workspace-chrome`; respects Reduce Transparency; appearance aqua/darkAqua by tint luminance unless `followSystem` | `WorkspaceBackdrop.swift` |
| Global shortcuts | Carbon `RegisterEventHotKey`, ⌃⌥ + Space, J, K, L, Return, Escape always; Y, N, T only while a binary card is shown; press and release (Space is hold-to-talk); conflicts listed in the status menu | main:8-14,481-546 |
| Screen context | workspace activation observer; Accessibility `AXDocument`; Apple Events to Finder, Safari, Chromium browsers | `ScreenContext.swift` |
| Notifications | `UNUserNotificationCenter` categories decision/result/failure with actions review/open/inspect; banners also while frontmost; click → `notice-*` | main:1702-1721 |
| Launch at login | `SMAppService.mainApp` register/unregister; opens Login Items when approval is needed | main:418-438,622-634 |
| Updater | Sparkle 2, EdDSA key, feed from Info.plist (absent in Dev builds, so the updater never starts), gentle scheduled reminders (badge only); relaunch waits until both pages' `prepareForAppUpdate()` return true | `AppUpdates.swift`, main:449-480 |
| Menus | status item: Show Notch, New Capture, Review Decisions (n), Open Workspace, Preferences, Launch at Login, Updates, Automatic updates, Run Setup, Notifications, conflicts, Quit; title shows count and ↑. App menu bar in `ApplicationMenu.swift`; Copy/Paste try `clipboardCommand` first; ⌘W → `close-front` | main:360-447 |
| Media previews | `tasktap-preview://<id>/<name>` scheme handler on both views; serves only registered files, plus HTML sibling assets and Markdown local images, after resolving symlinks; Range requests, 64 KiB chunks, CSP sandbox with no connect, `no-store` | `WorkspaceMedia.swift:109-157` |
| Navigation policy | main frame may load only `index.html`; subframes tasktap-preview, http(s), about, blob; activated links and `window.open` go to the system via `WorkspaceLinks` | main:1722-1748 |
| Other | single instance (a second launch activates the first and quits, main:157-163); VoiceOver flag injected and observed (:187,197-200); window 1280×820, minimum 560×400 (:58-71); file/folder/save panels; PDF rendering; pasteboards; Terminal.app launches for resume, login and brief | – |

## 12. Hazards

**Identity and stored formats**
1. No stored format carries a schema version: localStorage `tasktap-live-v1` (only the key name says v1), `sessions.json`, `lifecycle.json`, `Replay/*.json`, jobs, receipts, `observer*.json`, inbox files, `WorkspaceFolders.json`, `WorkspaceMedia.json`, `Speech/preferences.json`, UserDefaults dictionaries, the keychain token blob. Only `Kokoro/ready-v1` is versioned.
2. Project identity is mixed: an id is the folder path or a `uid()`, and `session.project` may hold either or a folder. `noteAssigned` receives a folder and stores it as a project id (main:973, `app.js:579`), which works only when id = folder.
3. Host values arrive as strings: booleans as `'yes'`/`'true'`/`'false'`, `updatedAt` as a string (`live.js:11-28`).
4. `Session.state` is one field with four writers (host rows, receipts, decisions, observations). Receipt, observer, row and JS label vocabularies are each duplicated across Swift, Python and JS (`LiveWorkspace.swift:69-74,221`, `session_rows.py`, `session-observation.js:8-9`). Swift's "finished" set includes `Opening`.
5. Unbounded growth: sessions, captures, notes and `session.log` are never trimmed; terminal `sessions.json` rows, `cancelled` ids, replay files, `WorkspaceMedia.json` and inbox files are never pruned.
6. Job ownership relies on file name order (`sorted(*.job)[0]` over `<µs>-<capture>.job`); `shell.job` sorts after numeric names (inferred mismatch if a nudge targets a shell run).
7. The Python data-path fallback is `…/Tasktap`, so helpers started outside the app use the release app's data even for a Dev build (`ask-user:32`, `workspace_terminal.py:25`).

**Ordering and timing**
8. Every `js()` event runs in both pages, each mutating its own copy, so side effects such as narration and `workspaceDeck.notify` can run twice (inferred race). Page sync is whole-row last writer wins, row order is not synced, and notch `workspaceDeck` writes other than `preferences` are lost (`shared-state.js:12-41`).
9. The notch starts from the shared localStorage copy and only then gets the web snapshot; only the workspace page persists, so a notch change is durable only after Swift relays it (`shared-state.js:46`, main:314-317).
10. Question answers are pulled, not pushed: `questionUpdated` has no payload, and Swift re-evaluates `receiveAgentQuestion` in `web` only, so a notch answer must arrive via `shared-state` first (`app.js:378-380`, `QuestionInbox.swift:67`). JS errors are only logged and the agent's `ask-user` waits forever.
11. Terminal backpressure is the awaited `workspaceDeck.receive`; a page busy for more than 15 s kills the bridge (`WorkspaceTerminals.swift:57`).
12. App start relaunches drain for any job without a receipt, which can open an agent window with no user action (inferred); `present` refuses already-opened jobs.
13. Scrollback is lost when the service restarts; replay is saved only on resize and bridge exit (`terminal_replay.py:41-61`).
14. Accidental behaviors: `resized` comes from the bridge rewriting replies, so it fires even for stopped sessions; each `input` reply line is relayed to JS and ignored; the service inherits the environment of whichever process started it first (bridge or run-agent), and two script copies (bundle vs Helpers) can drive one socket across app updates (inferred).

**Disagreements between layers**
15. `open-docs`: JS sends `section:'workspaces'` (`app.js:601`), which Swift's allowlist drops silently (main:790).
16. JS handles `hotkey-conflict` (`surfaces.js:505`) and dictation phase `preparing` (`live.js:300`); Swift never sends either.
17. Terminal size: JS `start` sends none, Swift uses 100×30, the service defaults to 80×24.
18. Input caps: JS 87000 b64 characters, Swift 90000 (silent drop), service 65536 bytes, compose 64000 B.
19. `ask-user` and `agent-tools` accept codex, claude, agy; JS accepts all six providers. `ask-user` resolves symlinks in the workspace path; launches use the folder as given.
20. Remote routing returns `agent`, `viewer`, `note`, which the UI never reads; the UI reads `result.question`, which no schema defines.
21. `hw-requests` is not in the notch action set, so ⌃⌥J goes to the workspace page and reveals the workspace window (main:326,545).
22. `status` is accepted only from `web`; `binary` and `layout` only from the notch (main:617-619,868-875,1043,1050). `terminalClipboard` exists only on `web`, so the notch uses `navigator.clipboard`.

**Unreachable or still present**
23. `conversation.json` has no writer, so resume-in-Terminal and copy-resume always fail; `save_project_activity` has no caller, so `list_project_sessions` is always empty; the cursor observer adapter and `agy_session.py` are unreachable; the job field `resume` is never read. `session_lifecycle.py` is used only by `router-provider prepare-reply`.
24. Items on the plan's cut list remain on this branch: plan usage (`worker-usage`, `worker_usage.py`, `workerRouting`) and Terminal.app launches (resume, worker login, Claude brief session).
25. Swift verification code (main:1095-1700) drives page internals as an implicit API: `state`, `persist`, `render`, `workspaceLayout.split`, `workspaceDeck.terminalText`/`terminalMetrics`, `appAppearance.setTheme`, `sessionObservation.openAnswer`, `dismissCard`, `showWorkspace`.

**Security facts**
26. The terminal socket has no authentication beyond file permissions: any process of the same user can `start` any absolute executable in an open folder; `observe` trusts a client-named `runDir`; PTY environments are not scrubbed.
27. The Kokoro fallback trusts any process on `127.0.0.1:8880`; the server model provider allows plain http to local-network hosts.

**Not determined**
- The full set of host project-row fields from `WorkspaceFolders` discovery beyond `folder`, `name`, `checkout`, `available`.
- Where Apple speech assets and the WhisperKit download come from.
- Whether WebKit keeps `callAsyncJavaScript` order across the two web views.
- The effect of ModelServer's 120 s POST timeout under the 90 s session resource timeout (probably capped at 90 s, inferred).
