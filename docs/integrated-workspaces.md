# Tasktap 1.0 integrated workspaces

Tasktap owns the working surface: project navigation, terminal tabs, nested resizable panes, focused views, and previews. The notch remains the global entry point for capture and decisions. This is the architecture and lifecycle reference; the [user guide](https://harzerheribert.github.io/Tasktap/docs/#workspaces) gives the everyday steps. Home, Notebook, Session history, all project discovery, and the existing Preferences remain available.

## Session and view lifetime

- A terminal session has a stable UUID. Its process belongs to the private local PTY service, not to a tab or window.
- Closing a live terminal tab offers **Keep running in background**, **Stop session**, or Cancel. Background sessions stay under their workspace in the sidebar; clicking one restores its panel and attaches to the same process. Ended terminals and file previews close directly. Closing the native window or quitting Tasktap still leaves processes running; **Close workspace** explicitly stops all of that workspace’s Tasktap terminals.
- Stop session is a separate, confirmed action. A stopped session is never silently restarted. Supported agent resume uses a fresh, explicitly requested resume ticket.
- A machine reboot ends processes. A service restart restores terminal metadata as not running; it does not rerun commands. Provider conversation resume remains distinct from process restoration.
- Scrollback is bounded to 2 MiB per process in service memory and 10,000 lines in the renderer. It is not an unlimited archive. When the idle service exits after all sessions and clients have closed, terminal scrollback is released. Agent reports and capture history remain in Tasktap's existing store.
- New installations default to the embedded Tasktap host. Existing saved terminal preferences remain respected. Previously external sessions stay in their original hosts.

## Choosing and opening workspaces

A project folder and an open workspace are separate. **+** beside Workspaces opens an existing folder, creates a new one, or restores a closed workspace. The sidebar lists only workspaces you open, in opening order. Discovering a folder or a running session does not open it. On first migration, existing layouts with surfaces remain open; old empty layouts remain in the chooser. Closing a workspace confirms the number of running or opening sessions, stops all its Tasktap terminals (including background sessions), and saves its layout. The workspace stays visible until the terminal service confirms that its processes have ended. The service blocks late launches into a closed workspace until it is explicitly reopened. Reopening restores the layout and history; it never reruns a command automatically.

**Preferences → Workspaces → Default workspace folder** chooses where new folders are created. The initial default is `~/projects`, but it is not required or created at startup. Immediate child directories appear in the folder chooser. **Open folder…** also accepts a selected folder elsewhere. Changing the default preserves previously known workspaces and their locations. Missing folders remain identifiable and unavailable until the same location returns or the user chooses its current location. Choosing or creating a fresh workspace opens its first terminal; restoring a saved layout does not add another terminal.

External-session discovery is off by default. **Preferences → Workspaces → Find sessions in other apps**, also available in Other apps, explicitly enables reading supported apps’ local session metadata for the configured project folders. With discovery off, Tasktap reads its own managed-session records; it does not poll cmux or Claude, scan Claude transcript directories, read Codex databases, or recover provider transcripts. Previously saved external sessions remain accessible. With provider scanning disabled, managed Claude follow-up readiness waits for Tasktap’s own question or result event rather than reading Claude transcripts; direct terminal interaction remains available. macOS may separately restrict protected app data, including access by commands launched inside a terminal. Built-in workspaces do not require broad access to other apps’ data.

## Workspace interaction

The project surface fills the native window with thin project and tab bars. Panes have no permanent status rows or footer. One compact sidebar is shared across Home, Notebook, Session history, Activity and project workspaces. Its visibility carries between pages; Focus temporarily hides it.

### Navigation and layout

- The sidebar has one heading per workspace, with deliberately backgrounded sessions nested beneath it. Background rows show Working/Running, Needs input, Ready, Failed, or an ended state; each has a Stop control. The disclosure button collapses these rows while preserving attention on the workspace heading. A gently pulsing attention mark means an agent needs input; a checkmark means an unread reported result is ready. Pending input takes precedence, and Reduce Motion disables the pulse. Opening the workspace acknowledges visible result/failure markers; background markers stay unread until that session or its result is opened; pending decisions remain until answered or withdrawn.
- A workspace contains surfaces; each surface holds panes as tabs. Each surface’s tab bar has four controls, in order: **New terminal**, **New browser**, **Split right**, **Split down**. These act on that surface, even when another surface has focus.
- **Split right (⌘D)** and **Split down (⇧⌘D)** divide the selected surface and open a fresh terminal. Any surface can be split in either direction. The shortcuts target the focused surface.
- Drag dividers to resize. Keyboard arrows adjust the matching axis; Home/End set limits; double-click balances. **Focus surface** temporarily expands the selected surface without changing the saved split tree.
- Drag a pane's tab between tabs to reorder it, or onto the center of another surface to move it there. Drop at a surface's left, right, top, or bottom edge to split off that pane. The highlighted area previews the destination; Escape or dropping outside the workspace cancels. Moving preserves running terminals, live previews, and pending terminal launches without starting another process. Tab order and splits are saved.
- Right-click a tab, or focus it and press **Shift+F10**, for Follow up, preview controls, session details, and **Move tab to…**, as applicable. The workspace toolbar retains New task, Open file, Project files, and workspace actions.
- Close individual tabs with their **×** or **⌘W**. Closing or moving the final tab automatically removes its surface and collapses the adjacent divider. There is no close-all control on a surface. Closing the final tab in the workspace leaves an empty workspace where a terminal, file, or browser can be opened. Live terminals require an explicit background-or-stop choice. Background sessions remain visible beneath their workspace and in Session history.

### State invariants

Switching tabs, moving previews and navigating away preserve live view instances. A flat view layer keeps iframe documents mounted while a recursive split tree supplies geometry. Legacy two-pane layouts migrate in place. Closing a view explicitly disposes it; reopening the same session focuses an existing view rather than spawning another process.

Each pending launch has a closable tab and belongs to its requesting surface. Backgrounding it before the launch finishes keeps the panel closed and the session visible in the sidebar. Stopping a pending launch cancels its session ID before the process can start. A workspace close also fences its folder against late launches. Responses arriving out of order do not change that ownership or steal focus. Input received during initial terminal replay is bounded and delivered in order to the exact session after replay completes. Terminal fitting measures the unpadded inner content box, keeping PTY rows and columns inside visible bounds across font, padding and split changes.

Sessions discovered in external apps live in the searchable Other apps picker, with their original host shown. Open focuses an addressable session in its host. If the host cannot focus it directly, Details exposes the available explicit actions; Tasktap does not silently reattach, resume, or migrate it. Historical external conversations never become embedded surface rows.

Each pane’s Follow up action targets its own agent conversation. Ordinary shells do not masquerade as agent conversations. Capture and follow-up review continue to use the existing routing, model policy, and delivery contracts. Codex queue delivery remains supported; agents without a dependable inbox retain the explicit copy/paste handoff. Terminal text and OSC titles are never interpreted as instructions, notification requests, or proof of completion.

## Appearance and shell layers

Tasktap owns the workspace layout. The embedded xterm.js renderer draws terminal cells. The selected shell loads its normal startup files, so zsh configuration, Oh My Zsh plugins, and Starship continue to work independently of the workspace UI. Oh My Zsh can supply a prompt theme, but when its theme is disabled and Starship is initialized, Starship owns the prompt.

Preferences → Appearance offers Follow Ghostty (the default), Midnight, Daylight, Ocean, Dusk, Ember, Rose, and System. Ocean is deep blue, Dusk violet, Ember warm charcoal, and Rose a soft light palette. One selection controls navigation, workspace panes, terminals, forms, dialogs, and Preferences. The physical notch keeps its black housing and uses a dark companion palette for readable controls. System follows macOS appearance changes. Choices persist across restarts. Home uses a 124-point banner with a wide artwork composition and a persistent pause/play control. Glyph wave, Phase field, Relay, and Signal globe are rendered as 16-second, 60 fps Home loops and played at normal speed: slow movement is authored into each frame. The legacy Resonator uses its original clip at native speed. Hidden or covered artwork pauses, and Reduce Motion shows its poster. The notch miniature still reflects activity independently.

With Follow Ghostty selected, Tasktap asks the installed Ghostty executable to resolve its configuration with `+show-config --no-pager`, including theme files and overrides, then reads only appearance fields. It imports the font family (when installed locally), font size, ANSI palette, foreground/background, selection, cursor, padding, and background opacity. Commands and keybindings are not imported. Reload Ghostty settings in Terminal preferences applies changes to existing views without restarting processes. Terminal preferences control the shell, text-size override, and whether to use Ghostty typography; terminal colors always follow the selected application theme. If Ghostty cannot be read, Tasktap uses a neutral fallback and explains that in preferences.

A single native `NSVisualEffectView` supplies the window backdrop; a separate color tint applies the configured background opacity. Terminal text, controls, and media are not faded. No CSS backdrop filters, per-pane blur layers, or animation loops are used. The material and tint cover the full native window, including the titlebar; WebKit remains below the traffic-light area as the window resizes. Disable blur or use an opaque background in Preferences → Appearance. macOS Reduce Transparency forces an opaque backdrop. The native check verifies these controls; GPU cost has not been benchmarked. WebKit screenshots use an opaque base because they cannot capture the native backdrop.

This is appearance compatibility, not a libghostty renderer. Ghostty-specific keybindings, shaders, font shaping, and exact blur strength are not reproduced. See [Ghostty configuration](https://ghostty.org/docs/config), [Ghostty theme precedence](https://ghostty.org/docs/features/theme), and [Apple’s visual-effect view](https://developer.apple.com/documentation/appkit/nsvisualeffectview).

## Media surfaces

Open file uses the native file chooser. Originals stay in place. Project Files reopens previously chosen files and URLs. Supported previews are images (fit/zoom), rendered Markdown with a Source toggle, UTF-8 text/code, audio/video with native browser controls, PDFs rendered a page at a time through PDFKit, and local HTML or http/https web previews. Refresh rereads changed content. Finder remains available for original files. Formats without a useful text preview are labeled; text previews are capped at 2 MiB. Password-protected PDFs are opened in their usual app.

Markdown supports headings, lists, task lists, tables, block quotes, fenced code, local images, and heading links. Related local file links open another surface after a click. Raw HTML in Markdown is displayed as source, and remote images do not load automatically. Local HTML previews support inline scripts/styles and sibling assets inside an isolated frame; Preview/Source switching keeps the page mounted. Self-contained HTML works offline; pages relying on remote CDNs should use a development-server web preview or the regular browser.

Ask agent starts a task with the selected file or website attached as context. Its path or URL is visible in the composer and in the existing handoff review, where it can be changed or removed. Choosing a reference never sends a task by itself.

Local content is exposed only after explicit selection, through a private scheme handler. For HTML, relative assets may be loaded from its containing directory, while its network connections and nested frames are blocked. Markdown can load sibling images and explicitly open related files; canonical path checks prevent escaping that directory. Preview frames have an opaque sandbox origin and no access to the app's native command bridge. Main-frame message checks remain in the host. Web pages can refuse embedding, require a browser login, or depend on capabilities unavailable to sandboxed previews; Open in browser is the fallback. These previews are not a replacement for a full authenticated browser.

## Agent attention and notifications

Home lists work in compact rows with the project, agent, and host beneath each title. Recent results omit the repeated status column. Full titles remain available in tooltips and session details; decision questions can wrap so the choice stays understandable. Result dates are shown only when an actual matching completion event exists.

There are three meaningful events: a pending decision, an explicit reported result, and a failed task or unexpected process exit. Terminal output creates no alerts. A successful process exit is not treated as task completion.

Existing agent tools remain the authoritative question/result channel. A question shown in a pane opens the same request as the notch. Replies and withdrawn questions settle that original ID. Results open readable report tabs while embedded agents remain available for further interaction. Activity retains results and failures, independently of OS notification preference. Receipt IDs deduplicate events; restored historical receipts do not produce fresh notifications. Intentional stops do not generate failure alerts. System alerts are opt-in and point to the exact receipt’s result or failed session. Background results can notify even when Tasktap has focus; readiness comes only from explicit question/result events, never from quiet output. A decision notification surfaces a background session before opening its question. Preferences shows Tasktap enablement separately from macOS authorization, banner and Notification Center availability. Permission denial links to system settings; enqueue errors are visible. Focus can suppress an authorized banner, and Tasktap cannot verify that it appeared. Opening an older result from Activity or its notification keeps that report, even after the same agent completes a follow-up. Foreground work is not interrupted by a second system banner.

## Implementation boundaries

- `scripts/workspace_terminal.py`: private Unix-domain socket, PTYs, launch idempotence, bounded replay, resize/input/stop, reconnecting stdio bridge.
- `native/WorkspaceFolders.swift`: persisted default folder, explicit folder approvals, missing-folder metadata, and shared native launch validation.
- `prototype/workspace-settings.js`: folder selection, creation, and optional external discovery preferences.
- `native/WorkspaceTerminals.swift`: native validation and bounded asynchronous delivery to WebKit. Terminal parsing completion applies backpressure.
- `native/WorkspaceMedia.swift`: explicit file registry, isolated local resources, text loading, PDFKit rendering.
- `prototype/workspace-deck.js` and `.css`: persistent views, tabs/splits, focus, contextual follow-ups, media, Activity.
- `prototype/workspace-layout.js`: recursive pane geometry, stable group identities, legacy migration, and branch collapse.
- `prototype/workspace-documents.js` and `.css`: themed Markdown with bundled Marked parsing and DOMPurify sanitization; validated links and local-only image loading.
- `prototype/workspace-navigation.js` and `.css`: compact workspace sidebar, attention markers, and explicit external-host focus.
- `prototype/handoff-review.js` and `.css`: Task/Destination/Context review, focused edits, pending-mutation guard, persistent failure feedback and redacted diagnostics.
- `prototype/result-presentation.js` and `.css`: labeled report excerpts and exact-receipt reading/copy/narration/summary export.
- `prototype/appearance.js` and `.css`: persisted app palette, system appearance updates, semantic color tokens, and Appearance controls.
- `prototype/vendor`: pinned xterm.js 6.0.0 and official fit/search addons, bundled locally with MIT notices. No runtime CDN dependency.

## Verification and limits

These checks exercise different boundaries. Passing a browser or native fixture does not establish a successful handoff with a live provider.

| Boundary | Evidence scripts |
| --- | --- |
| Folder lifecycle and opt-in discovery | `verify-workspace-folders.swift`, `verify-workspace-lifecycle.cjs`, `verify-session-discovery.py` |
| Real PTY ownership, replay and stop | `verify-workspace-terminals.py` |
| Nested layout, ordering and view persistence | `verify-workspace-layout.cjs`, `verify-workspace-splits.cjs`, `verify-workspace-drag.cjs`, `verify-workspace-deck.cjs` |
| Terminal final-row and right-edge geometry | `verify-terminal-viewport.cjs` |
| Preview rendering and isolation | `verify-workspace-documents.cjs`, native `--verify-workspace` |
| Sidebar and external-host actions | `verify-workspace-navigation.cjs` |
| Themes, contrast and settings | `verify-appearance.cjs`, `verify-settings-layout.cjs` |
| Task review and exact report identity | `verify-review.cjs`, `verify-result-presentation.cjs`, `verify-session-detail.cjs` |
| Shared Mac window and notch behavior | native `--verify-interface` |

The packaged app’s `--verify-workspace` check uses actual PTYs and the native bridge, replay, resize geometry, text/image/PDF/audio/video loading, Markdown/HTML boundaries and backdrop controls. Set `TASKTAP_TERMINAL_ROOT` to a new private directory containing `tasktap-workspace-test` before running it; it does not use agent accounts. Native `--verify-interface` also covers titlebar geometry, resize/notch transitions and fixture question round trips.

Material limits remain: xterm.js does not reproduce every Ghostty rendering feature; backdrop GPU cost is not benchmarked; web embedding and codecs depend on WebKit; some agents need manual follow-up delivery or terminal-only approvals. Reports are exact agent text, not a structured verified outcome or validated artifact inventory. Live-provider round trips, actual notification display and speech need separate evidence in the [implementation gap plan](implementation-gap-plan.md).
