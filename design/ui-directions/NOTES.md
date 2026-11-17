# Tasktap UI: Instrument

The owner chose **Instrument**. This file is the record of that choice and the brief for building it. The page beside it (`index.html`, no build step, no network) shows every screen described here as a working mock-up at the app's real sizes.

| Key | Does |
| --- | --- |
| `2` / `0` | Instrument / the app as built today. `←` `→` flip between them |
| `W` `H` `N` `S` | Workspace, Home, Notch, Specimen |
| `G` | Home × 12: the three layerings of Home in the four states. Click one to open it |
| `X` | Home layering: Folds, Sheets, Pages |
| `Z` | State of the day: busy, normal, quiet, first run |
| `E` | Open or close Home's second layer |
| `B` | The chrome backdrop on Home, on or off |
| `T` | Terminal theme: Tokyo Night, Gruvbox Dark, Solarized Light (the person's, not ours) |
| `M` | Window at 1180 × 760 or 720 × 540 |
| `D` | The tab-close dialog (also: hover a tab and click its cross) |
| `K` | Capture sheet. `O` opens the notch on the mock desktop. `esc` closes anything |
| `C` | Side by side with the current app |

Native and Ledger, the two directions not chosen, are behind "Not chosen" in the switcher (`1`, `3` still work). Every view has a link: the state is in the URL hash.

Fonts: opened from disk, the page loads SF Mono from `/System/Library/Fonts` by file. Served over http that is not allowed, and figures fall back to Menlo. In the app's web view `ui-monospace` gives SF Mono and nothing is bundled.

## 1. What was decided

- **Instrument is the app's look.** Black, hairlines, polished metal; the wave is the state; the window and the notch are one object. Dark only.
- **Home becomes a dashboard in layers** (section 2). Three layerings are on the page for the owner to choose from; the recommendation is Folds.
- **The open notch on a display without a camera cutout is a plain rectangle** (section 3). The collapsed tab keeps its sloped sides.
- **The 1.2 views are gone.** There is no Notebook, no Session history, no Activity. The sidebar holds Home and the workspaces, nothing else. What they held now lives here:
  - *An idea with no destination* lives in **Ideas**: a thought the router could not place (or any thought captured before a folder is open) is kept there, with "Send to a folder…" and "Drop". The capture line says so when it happens ("Kept as an idea").
  - *The history of finished thoughts* lives in **Results**: every thought that ended, newest first, failed ones included. The newest few are one step from Home; "All results" leads to **Earlier**, the full list by day with a find field. A row opens that thought's session, whose terminal keeps its history. That replaces Session history; Needs you, Running and Results together replace Activity.

Grafts from the directions not chosen:

| Graft | Applied | Where |
| --- | --- | --- |
| Close on the left of a tab, on hover, where a Mac hand expects it | Yes | The cross replaces the state mark while the pointer or keyboard focus is on the tab |
| Unfocused panes step back, as Ghostty | Yes | Their terminal draws at 84 % |
| The system's own context menus | Yes | Menus are drawn by the host, not the page. The menu styles and the specimen's menu are removed |
| State in words wherever there is room | Yes | The rail ("2 need you", "4 working", "2 new results"), Home's section names, every state mark's tooltip and accessible name |
| Sentence-first wording | Yes | "2 need you", "Kept as an idea until a folder is open", "No folder matched" |
| New York for question text | **No** | The owner does not like the other styles; Instrument stays one family plus mono |
| Capsules, blur, floating panels (Native); margin-column page (Ledger) | No | Against Instrument's surfaces |

## 2. Home: a dashboard in layers

**The test for the first layer:** does the person need to see it or act on it the moment the window opens? Three things pass, in this order of weight:

1. **What needs you.** Questions, question first. The first one is open: its folder, agent and thought on one quiet line, the question in full at 17 px, its answers as key caps. Any further question is a single line (wave, folder, agent, thought, the question cut to fit) and opens when chosen; opening one closes the other. The section has the page's only lit rule, so it is the first thing the eye lands on. When nothing needs you the section is absent, not empty.
2. **What is running.** One line each: the moving wave, the folder, the thought, the one fact that matters (the step it is on), the elapsed time. Sessions in the background are dimmed and sort last. No buttons: the row itself opens the terminal. At most four rows; more than that collapse into a last line, "3 more running", which opens in place (specified here, not drawn in the mock-up, which never has more than four).
3. **The capture line.** Always the first line of the page, so it is always in the same place. When something needs you it is quiet (17 px, grey). When nothing does it is the invitation: 20 px Expanded, a larger wave, the hint to hold ⌥Space.

Everything else is second layer and appears on the first only as one quiet line, or not at all:

| Item | Where it lives | Why |
| --- | --- | --- |
| Results and history | Second layer (see the layerings) | Wanted often, never urgent. A new result is announced by the notch; Home shows the count and the newest title |
| Ideas | Second layer, beside Results | Rare, never urgent |
| Agents and their sign-in | The rail's two names; a click drops the **Agents** sheet | Almost never needed. If an agent is signed out its name turns copper in the rail, and on first run it is on the page |
| Workspace management | The sidebar (＋, and the host's context menu on a workspace) | It is already there. Home shows "Open a folder" only on first run, when the sidebar is empty |
| Appearance and other settings | "Settings" at the rail's end and ⌘, drop the **Settings** sheet | Set once |

**Never bare.** The first layer always holds something, by this rule: what needs you; else what is running; else the last two finished thoughts. So on a quiet day Home is the capture line as an invitation, two lines of proof that work was done, and the backdrop with room to play.

**Never a flood.** On the busiest day shown (two questions, four running, five results, two ideas) the first layer is the capture line, one open question, one more as a line, four running lines and the entry to the rest. Nothing on it has a button except the question that is open.

**The backdrop.** Home is built so the chrome motion can sit behind it: the content is a column 824 px wide at the left; the right side and everything below the last row are free. The mock-up's backdrop is a stand-in (the icon's wave, large, with a slow sweep of light); the real one comes from the motion lab. Rules for whoever builds it:
- It is strongest where there is no text. Under the text column it passes through a 95 % black scrim, which holds it below `#121212`; the dimmest text (`--fg3`) then keeps 4.5 : 1.
- Its presence falls as the load rises: full when quiet or on first run, 75 % with something running, 40 % when something needs you, 30 % on Earlier.
- It stops under Reduce Motion and is absent in the narrow window.

**The four states** (`Z`):

| State | First layer |
| --- | --- |
| Busy day | Capture (quiet). Needs you 2: one open, one line. Running 4. Entry to results (1 new, 1 failed) and ideas (2) |
| Normal | Capture (invitation). Running 1. Entry to results (1 new) and ideas (1) |
| Quiet | Capture (invitation). The last two finished thoughts. Entry to the rest |
| First run | Capture ("Kept as an idea until a folder is open"). To start: ⌘O Open a folder; Claude Code, signed in; Codex, not signed in, with Sign in. No entries, since there is nothing behind them |

**Three layerings** (`X`, all twelve on `G`). The first layer is the same in all three; they differ in how finished and unplaced thoughts are reached.

- **Folds.** Results and Ideas are two single lines under what is happening now, each showing its count and its newest title. A line opens in place to its newest five rows and closes again; the last row is "All results", which goes to Earlier. On a quiet day Results opens itself to its last two, so the proof of life and the entry are the same object.
- **Sheets.** Home shows only now. Results and Ideas sit in the title bar with their counts and drop a sheet from it, the same sheet capture and dialogs use. The page is the barest and the backdrop has the most room.
- **Pages.** Home shows only now, and one line, Earlier, leads to a second page with a find field, Ideas, then results by day. The title bar gains a way back.

**Recommendation: Folds.**
- It is the only one where the second layer is visible as a fact before it is opened: "1 new, 1 failed, Export the cue sheet as PDF, 15:21" is information, not a door. That is what keeps a quiet Home from feeling empty.
- Opening it keeps what needs you and what is running on screen. A sheet covers them; a page replaces them.
- It adds no mechanism the eye has to learn: a line with a chevron that opens.
- It takes one thing from Pages, because a long history needs a real page: "All results" at the end of the open fold goes to Earlier. And it uses the sheet only for what a sheet is right for: Agents and Settings, things you set and dismiss.

So the mechanisms are three, each with one job: a **fold** for lists of thoughts, a **sheet** for settings and decisions, and one **page** behind "All results".

## 3. The notch

- **Displays without a camera cutout.** Collapsed, the notch is a tab with sloped sides and no concave corners, as before. Open, it is a plain rectangle hanging from the top edge: vertical sides, square where it meets the edge, 10 px radius on the two bottom corners, no lean anywhere. The opening is shown in five steps at the foot of the Notch screen: the tab keeps its slope; in the first third of the travel the sides stand up while the shape widens to 420 px; then the rectangle drops to its height; the content fades in over the last quarter. Folding runs the same in reverse. Use the app's existing durations (unfold 510 ms, fold 320 ms).
- **Displays with a cutout.** Unchanged from the first round: the sheet hugs the camera housing, with the hardware's own small shoulders.
- **Unchanged rules.** No stroke round the notch; attention is the bloom from behind. Collapsed with something asking, a line under the counts says who asks and what. Open, the question comes first and in full; folder and agent sit in the band beside the camera; "1 of 2" when several wait.

## 4. The token file

Ready to become the app's one design-token file. Nothing else in the app should name a colour, a size or a radius.

```css
:root{
  /* surfaces */
  --bg:#0a0a0b;        /* window, sidebar, tab bar, rail: one black, the notch's */
  --raised:#111113;    /* nothing floats in the window; kept for host-drawn panels */
  --sheet:#000;        /* sheets and the notch */
  --hover:#141416;     /* a row or control under the pointer */
  --sel:#1a1a1d;       /* selected row, pressed row */
  --fill:#17171a;      /* quiet button, answer under the pointer */
  --fill-hover:#222226;
  --seam:#000;         /* the one-pixel divider between terminals */
  /* text */
  --fg:#f2f2f3;        /* 17.7 : 1 on --bg */
  --fg2:#a3a4aa;       /*  8.0 : 1 */
  --fg3:#7c7d84;       /*  4.8 : 1; times, hints, disabled */
  /* lines */
  --line:#1f2024; --line2:#33343a;
  /* meaning */
  --accent:#dfe4ec;    /* keyboard focus ring only */
  --asks:#eab676;      /* needs you */
  --fail:#f0716e;      /* failed */
  /* chrome: key caps, the default button, lit edges, the wave, the bloom. Never text, never a border round content */
  --metal:linear-gradient(180deg,#fbfbfc,#c9cdd3 40%,#8f949c 54%,#c6cad1 68%,#eef0f2);
  --lit:linear-gradient(90deg,#b98a5e,#edcda6 18%,#f7f8fa 40%,#a9c0df 62%,#7b92c4 82%,#a58aa6);
  --bloom:linear-gradient(100deg,#c46f3c,#dc9a52 16%,#dfe4ec 33%,#8fb2d8 50%,#5f7fc0 66%,#a7789a 83%,#c46f3c);
  /* type. Expanded is the system font's width axis; if the web view ignores it the names fall back to regular width */
  --ui:system-ui,-apple-system,"Segoe UI Variable","Segoe UI",sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,"Cascadia Mono",Consolas,monospace;
  --f-display:600 expanded 20px/26px var(--ui);  /* the capture line as invitation */
  --f-question:500 17px/24px var(--ui);          /* a question on Home; 16/22 in the notch, 15/21 under a terminal */
  --f-title:600 expanded 13px/18px var(--ui);    /* workspace name, sheet title */
  --f-head:600 expanded 11px/14px var(--ui);     /* section names on Home */
  --f-strong:600 13px/18px var(--ui);
  --f-body:400 13px/18px var(--ui);
  --f-small:400 12px/16px var(--ui);             /* sidebar rows, tabs, secondary */
  --f-cap:400 11px/14px var(--ui);
  --f-num:400 11px/14px var(--mono);             /* times, counts, versions, diffstat, key caps */
  --f-term:400 13px/18px var(--mono);            /* default; the person's terminal settings win */
  /* measure: a 4 px grid */
  --sp1:4px; --sp2:8px; --sp3:12px; --sp4:16px; --sp5:24px; --sp6:32px;
  --side-w:224px; --bar-h:38px; --tab-h:30px; --row-h:28px; --rail-h:26px;
  --home-w:824px; --home-row:36px; --home-gutter:36px;
  --notch-w:420px; --sheet-w:420px; --list-sheet-w:640px;
  /* radii */
  --r1:3px;   /* controls, key caps */
  --r2:6px;   /* host-drawn panels */
  --r3:10px;  /* bottom corners of sheets and of the notch */
  /* icons: one owned set on a 16 px grid */
  --i-w:1.2px; --i-cap:butt; --i-join:miter;
  /* time */
  --t-fast:120ms; --t-sheet:220ms; --t-notch-open:510ms; --t-notch-fold:320ms;
  --ease:cubic-bezier(.19,.76,.19,1);
}
```

The terminal's own colours come from the person's theme and are not tokens of ours. Instrument never derives a colour from them.

## 5. Components and their states

Every interactive component has: rest, hover, pressed, keyboard focus (a 1.5 px `--accent` outline, 1 px off; inset on full-bleed rows), disabled (38 %). A focus ring is shown for keyboard focus only. Text fields always match `:focus-visible`, so their ring is tied to the last input device (see the end of `app.js`). The Specimen screen shows each of these.

| Component | What it is | States beyond the five |
| --- | --- | --- |
| **State mark** | Five 2 px bars in 14 × 14 | working (moving), asks (tall, copper, lit), ready (bright dotted line), failed (red line with one spike), ended (dim dotted line), any of them in background (45 %). A shell shows a prompt glyph instead. Tooltip and accessible name say the state in words |
| **Sidebar row** | 28 px, full-bleed. Workspace: chevron, name in 600. Session: mark, title, time in mono | selected (fill plus a 2 px lit edge at the left), ended and background (dimmed), shell (title in mono) |
| **Tab** | 30 px, flat text on `--bg`, hairline at the right | active (bright text, 2 px grey edge on top), active in the focused pane (the edge is `--lit`), hover or focus (the cross replaces the mark, at the left), shell (mono) |
| **Divider** | 1 px `--seam`; 7 px hit area | hover (a 35 % `--accent` band) |
| **Question strip** | Under its terminal, on `--bg`: lit hairline, "Codex asks", the question at 15/21, answers | with attention (the hairline is `--lit`, a faint bloom rises 28 px into the terminal), result (plain hairline, Keep as default) |
| **Answer** | A key cap and a label, 28 px, no box | default action (label in 600) |
| **Key cap** | 18 px high, `--metal`, dark mono glyph | pressed (drops 1 px) |
| **Button** | 24 px, `--fill`, 12 px text | default (`--metal`, dark text, 600) |
| **Reply field** | Key cap `T`, placeholder, no box | hover (fill), focused (fill and a 1 px `--accent` underline) |
| **Capture line** | Wave, field, destination, agent, hint, on a `--line2` rule | focused (the rule becomes `--lit`), invitation (20 px Expanded, larger wave), first run (no destination) |
| **Sheet** | Hangs from the title bar: `--sheet`, `--lit` top edge, 10 px bottom corners, hairline outline, the window dimmed 50 % behind it | dialog (420 px; three rows of key cap and label: ↩ default, ⌘⌫ destructive in `--fail`, esc cancel), capture (460 px), list (640 px: Agents, Settings, and in the Sheets layering Results and Ideas) |
| **Rail** | 26 px at the window's foot, mono | left: the glance in words. Right: agent names (signed out: copper, hollow dot), Settings |
| **Home question** | See section 2 | open, collapsed (one 36 px line) |
| **Home row** | 36 px: mark, folder (96 px), thought (13/500), fact, time | running, background, result new, result failed, result seen (dimmed), with actions (a second line of buttons), idea (actions appear on hover or focus) |
| **Fold** | A 36 px line: chevron, name, count, newest title, time | closed, open (chevron turned, peek hidden, rows below, "All results" last) |
| **Notch** | Section 3 | collapsed idle, collapsed with counts, collapsed with attention (bloom and the line that says what), open on a question, on capture, on a result |
| **Wave** | Chrome bars; the brand mark at work | resting, live (the voice-reactive version from `design/motion-lab` replaces the bars), backdrop |

## 6. Implementation brief

### The window

A grid: sidebar (224 px) and main, over a full-width rail (26 px). The window is 1180 × 760 by default. Below 800 px wide the sidebar hides and its toggle and the window buttons move into the title bar.

**Sidebar.** Top strip 38 px (window buttons, hide-sidebar). Then Home (with the count of things that need you, in copper, absent at zero), the label "Workspaces" with ＋ (Open a folder, ⌘O; shown on hover of the sidebar and always on first run), then each workspace: a row with a chevron that folds its sessions, and its sessions indented under a guide line. A session row is mark, title, time. Sessions order: asks, working, ready, failed, ended; background ones dimmed with the background glyph. Shells are rows too, in mono. Nothing else is in the sidebar.

**Title bar.** 38 px, hairline below. In a workspace: its name (Expanded), its path (mono, dim), then at the right Split right (⌘D), Split down (⇧⌘D), and New task (⌘N). On Home: "Home" and nothing else (in the Sheets layering, Results and Ideas with counts; on Earlier, a way back and the name).

**Deck.** Nested splits of panes. A pane is a 30 px tab bar on `--bg` and, below it, the terminal in the person's theme, padded 10 × 14. Tabs: mark, title, cross on hover at the left; ＋ at the end. There is no per-pane toolbar, no status strip, no outline round a pane. Copy, paste and text size are menu commands with their standard shortcuts. Panes are separated by a 1 px seam; a pane below another needs none, its tab bar is the separation. The unfocused panes' terminals draw at 84 %.

**A question in its pane.** A strip under the terminal (the terminal shrinks; nothing floats): "Codex asks" and the time, the question in full, then the answers in a row and the reply field. One key per answer (1 to 9), `T` for a free reply. A result is the same strip: "Result", time, diffstat, the summary, then Keep (↩), Discard, Review changes. The tab and the sidebar row carry the mark; nothing else announces it.

**Rail.** Left: the mark of the most urgent state, then "2 need you", "4 working", "2 new results" (each absent at zero; "Nothing running" when all are). Right: the installed agents by name, each a button that drops the Agents sheet, and Settings.

**Sheets.** One mechanism for every interruption inside the window. A sheet hangs from the title bar's lower edge, centred on the window (list sheets: centred on the main area), slides down in 220 ms, dims the window behind it, takes keyboard focus and keeps it until dismissed. Esc, a click on the dimmed area, or the sheet's cancel closes it. Uses: the tab-close dialog ("Close 'thought'?" with Keep running in background ↩, Stop session ⌘⌫, Cancel esc), any other confirmation, capture (⌘N: the notch's capture panel, the same component), Agents, Settings.

### Home

Structure, top to bottom, in a column 824 px wide with 36 px gutters, over the backdrop:

1. Capture line.
2. Needs you (only if any): head with the copper wave and the count on a `--lit` rule; the first question open; the rest collapsed.
3. Running (only if any): head with count; up to four rows; then "n more running".
4. If neither 2 nor 3 and there is at least one workspace: the last two finished thoughts (in Folds this is the Results fold, opened to two).
5. First run only (no workspace): "To start": Open a folder, then the agents with their sign-in state.
6. Folds: Results, then Ideas (each only if it has something).

**Layers and how they open and close** (Folds, recommended):

| Second layer | Opens | Closes | Notes |
| --- | --- | --- | --- |
| Results fold | Click its line; `→` or Return with it focused | Click again; `←`; Esc | Shows the newest five. New results first, failed among them. A new result that came back from an isolated run shows Keep, Discard, Review; a failed one shows Open terminal, Try again. Seen results are single dimmed lines. Opening marks nothing as seen; acting on a row or opening its terminal does |
| Ideas fold | Same | Same | Each row: the thought, "No folder matched", the time. Send to a folder… and Drop appear on hover or focus; Return on the row is Send |
| Earlier page | "All results" at the end of the Results fold | Back in the title bar; ⌘[; Esc | Find a thought (⌘F), Ideas, then results grouped Today, Yesterday, weekday names, then dates. The rail and the sidebar stay |
| Agents sheet | An agent's name in the rail | Esc; click outside | Name, version, sign-in state, Sign in when needed, Add an agent… |
| Settings sheet | Settings in the rail; ⌘, | Esc; click outside | Terminal theme, text size, capture shortcut, start without review, notch on this display |

Only one fold is open at a time. The page scrolls when an open fold makes it taller than the window; the capture line scrolls with it.

**Focus on arrival.** If something needs you, the open question has focus, so `1`, `2` and `T` work at once. Otherwise the capture line has focus and typing starts a thought.

**Keys on Home.** `↓` `↑` move through: capture line, questions, running rows, fold lines, and the rows of an open fold. On a collapsed question, Return or Space opens it. On an open question, `1` to `9` answer, `T` goes to the reply field, Return in the field sends. On a running row, Return opens its terminal. On a fold line, `→` or Return opens, `←` closes. In a fold's row, Return opens the thought's terminal; on a new result `K` keeps, `D` discards, `R` reviews. Esc steps out one level: reply field, then open fold, then back to the capture line.

### The notch

A separate page that shares the tokens and these components: state mark, answer, key cap, reply field, capture line, wave, bloom.

- **Geometry.** Collapsed on a cutout display: the hardware's own shape (190 × 32) when idle; with counts, 322 px wide, the counts in the wings beside the camera and, when something asks, a 24 px line below that says who and what. Collapsed without a cutout: a tab 24 px high with sides leaning 9 px and 10 px bottom corners; idle 92 px wide with the wave at rest; with counts as wide as its line needs, up to 440 px. Open: 420 px wide, as tall as its content, 10 px bottom corners; with a cutout the top 32 px is the band beside the camera (folder and agent at the left, "1 of 2" or the time at the right); without a cutout it is a plain rectangle (section 3) with the same band 30 px high.
- **Question.** The thought (caption), the question in full at 16/22, answers as ruled rows of key cap and label, then the reply row with `T` and "or hold ⌥Space to talk".
- **Capture.** The live wave, the line at 17 px with a chrome caret, then the destination (arrow and folder), the agent, and "↩ start · hold ⌥Space to talk".
- **Result.** "Result", the thought at 16/22, the summary, the diffstat, then Keep (↩), Discard (D), Open (O).
- **Keys.** `1` to `9`, `T`, Return, Esc; `←` `→` between waiting questions; the existing global shortcuts stay.
- **Light.** The bloom is the shape itself, filled with `--bloom`, blurred 9 px, scaled 2 % wider and 7 % taller from the top edge, drifting over 12 s, behind the black shape. Nothing is stroked.

### Keys in the window

⌘N capture sheet. ⌘O open a folder. ⌘T new tab, ⌘W close tab (the dialog if the session is running). ⌘D split right, ⇧⌘D split down. ⌘, settings. ⌘[ back from Earlier. In a sheet: Return default, ⌘⌫ destructive, Esc cancel. The existing shortcuts for moving between panes, tabs and workspaces, for the sidebar, and the global capture and answer shortcuts stay as they are; this design adds none beyond those listed.

A question strip acts on `1` to `9` and `T` only while it has keyboard focus, never while the terminal does. The existing "answer it" shortcut moves focus to the oldest waiting question's strip; Tab or Esc returns focus to the terminal.

### What is removed

- Views: Notebook, Session history, Activity, and the Home title card with its date and artwork.
- From panes: the seven-icon toolbar, the status strip, the amber or green outline, the bottom bar that repeats the question.
- Toasts (a session sent to the background is shown where it went, in the sidebar), the floating round button on the sidebar's edge, the centred web modal.
- The agents list on Home (the rail and its sheet), the word "Tasktap" in the title bar, the tracked capital label.
- The blue accent everywhere. Page-drawn menus.
- From the stylesheets: the 11 legacy sheets the workspace loads and the three the notch loads (95 KB, about 980 rules, 150 colour literals), replaced by the token file and component styles of about 35 to 40 KB. `d2.css` and `mock.css` here are the reference: copy values from them, not structure. About 180 `class=` uses in nine `.tsx` files change, and the checks tied to the old markup need the same pass.

This **changes a requirement** of `docs/rebuild-plan.md`, "Keep the look": the 1.2 palette, layout and class names do not carry over. The chrome motion, the voice wave, the decision glow (now the bloom), Reduce Motion and the tools that render them stay.

### Open points for the owner

- Which Home layering (recommended: Folds).
- Whether the rail earns its 26 px, or the notch alone should carry the glance.
- Whether shells belong in the sidebar.

## 7. Why the current interface read as generated

Kept for the record; the cut-outs are under Current → Diagnosis.

1. A title card that says where you already are: "Home" at 44 px in a bordered box, named three times, with the date in tracked mono capitals and chrome artwork as decoration.
2. Twenty-one identical toolbar icons across three panes, at the weight of the tab titles; one tab glyph for every tab.
3. A question stated three times (tab, strip, bottom bar) inside a one-pixel amber box round the terminal.
4. Accent as decoration: a web-default blue on New task, Yes and every link; three button styles in one row.
5. One grey, one size, one weight; a tracked capital kicker; empty states that explain the obvious.
6. Lists made of bordered tiles with "Version" and "Signed in" repeated on every row; two left edges.
7. Web furniture: a toast over the terminals, a floating round button, a centred modal.
8. A notch that says "A question needs you" and truncates the question, among six boxed key caps.
9. Nothing that could only be Tasktap.

## 8. The directions not chosen

**Native** (system materials, the deck coloured from the terminal theme, capsules) and **Ledger** (thoughts in the system serif, state as words, paper and ink) remain on the page behind "Not chosen", with their styles in `d1.css` and `d3.css`. Their tokens are the first block of each of those files; what was worth keeping from them is in the graft table above.
