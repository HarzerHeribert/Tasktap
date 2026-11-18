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
  - *A thought with no folder to go to* is **saved for later**: one the router could not place, one captured before a folder is open, or one the person chose to save. It waits in **For later** on Home, with "Send to a folder…" and "Drop". The Composer says so before it happens (its key reads "Save for later") and after ("Saved for later"). One word, "later", everywhere: the place, the key, the receipt, the fold, Earlier, the notch.
  - *The history of finished thoughts* lives in **Results**: every thought that ended, newest first, failed ones included. The newest few are one step from Home; "All results" leads to **Earlier**, the full list by day with a find field. A row opens that thought's session, whose terminal keeps its history. That replaces Session history; Needs you, Running and Results together replace Activity.

Grafts from the directions not chosen:

| Graft | Applied | Where |
| --- | --- | --- |
| Close on the left of a tab, on hover, where a Mac hand expects it | Yes | The cross replaces the state mark while the pointer or keyboard focus is on the tab |
| Unfocused panes step back, as Ghostty | Yes | Their terminal draws at 84 % |
| The system's own context menus | Yes | Menus are drawn by the host, not the page. The menu styles and the specimen's menu are removed |
| State in words wherever there is room | Yes | The rail ("2 need you", "4 working", "2 new results"), Home's section names, every state mark's tooltip and accessible name |
| Sentence-first wording | Yes | "2 need you", "Saved for later, until a folder is open", "No folder matched; saved for later" |
| New York for question text | **No** | The owner does not like the other styles; Instrument stays one family plus mono |
| Capsules, blur, floating panels (Native); margin-column page (Ledger) | No | Against Instrument's surfaces |

## 2. Home: a dashboard in layers

**The test for the first layer:** does the person need to see it or act on it the moment the window opens? Three things pass, in this order of weight:

1. **What needs you.** Questions, question first. The first one is open: its folder, agent and thought on one quiet line, the question in full at 17 px, its answers as key caps. Any further question is a single line (wave, folder, agent, thought, the question cut to fit) and opens when chosen; opening one closes the other. The section has the page's only lit rule, so it is the first thing the eye lands on. When nothing needs you the section is absent, not empty.
2. **What is running.** One line each: the moving wave, the folder, the thought, the one fact that matters (the step it is on), the elapsed time. Sessions in the background are dimmed and sort last. No buttons: the row itself opens the terminal. At most four rows; more than that collapse into a last line, "3 more running", which opens in place (specified here, not drawn in the mock-up, which never has more than four).
3. **The capture field.** Always the first thing on the page, so it is always in the same place. The owner chose the Composer (2026-11-17, of three variants; the other two are gone): the **surface** material (section 5), raised, with no border, lit from behind by the room's light gathered under it, 20 px corners (`--r4`), centred and 720 px wide (`--cap-w`). The thought is on lines of its own at 20 px (the placeholder an invitation in `--fg-field`, the caret `--accent`), growing a line at a time up to six (Shift-Return for a new line). Under it, inside the surface, one row:
   - at its left, where the thought will go: "→ folder", a follow-up's session, "For later", or, before any folder is open, "No folder yet";
   - then the agents as **rings** (section 5): the lit one runs the thought, a click on another picks it (the core's `agent` preference), one that is not signed in is an open ring that leads to where it is signed in;
   - at its right, the **key** that says what Return does: "Start", "Send" for a follow-up, "Save for later" when the thought has no folder to go to. It is metal once there is a thought and quiet before; while the thought is on its way it shows the wave and cannot be sent twice.

   Choosing where it goes turns that row into the choice (the folders, Open a folder…, For later): a line of options on Home, a list of one place a line on a sheet and in the notch, so it never wraps and covers none of the rows under the field; arrows move, Return picks, Esc leaves it. With the keyboard, or holding a thought, the surface brightens and its rim is the lit edge (`--lit`), brightest along the top, as on the focused tab: that is the Composer's chromatic character, with its key; its body is never decorated. The capture sheet (⌘N) and the notch show the same component bare on their own black: the wave beside the thought at 17 px (up to three lines), a rule that is the lit edge on the same terms, and the same row.

Everything else is second layer and appears on the first only as one quiet line, or not at all:

| Item | Where it lives | Why |
| --- | --- | --- |
| Results and history | Second layer (see the layerings) | Wanted often, never urgent. A new result is announced by the notch; Home shows the count and the newest title |
| For later | Second layer, beside Results | Rare, never urgent |
| Agents and their sign-in | The rings in the Composer (section 5); "Agents" in the rail drops the **Agents** sheet | Seen where a thought starts, as status and as the choice of who runs it; never a table on Home. An agent that is not signed in is an open ring in the attention colour |
| Workspace management | The sidebar (＋, and the host's context menu on a workspace) | It is already there. Home shows "Open a folder" only on first run, when the sidebar is empty |
| Appearance and other settings | "Settings" at the rail's end and ⌘, drop the **Settings** sheet | Set once |

**Never bare.** The first layer always holds something, by this rule: what needs you; else what is running; else the last two finished thoughts. So on a quiet day Home is the capture line as an invitation, two lines of proof that work was done, and the backdrop with room to play.

**Never a flood.** On the busiest day shown (two questions, four running, five results, two saved for later) the first layer is the capture line, one open question, one more as a line, four running lines and the entry to the rest. Nothing on it has a button except the question that is open.

**The light** (as built, replacing the backdrop after the owner rejected a chrome object in leftover space). Home's content is one column, centred, at most 1040 px of rows (`--home-w`) with 36 px gutters, so the rows use the window's width without over-long lines; where Home is 1480 px wide or more and both sides have something, it becomes two columns: what needs you, changes waiting and what is running at the left, Results and For later (open) at the right. Behind it, one integrated layer of light (`ui/src/workspace/light.tsx`):
- Three large, soft pools of the person's motion palette, deep enough that the dimmest text (`--fg3`) keeps 4.5 : 1 over their brightest point (measured by `scripts/light-sheet.cjs`), dithered against banding, strongest by the capture line; and one low band of chrome across the window, the motion's form far larger than the band, drawn at half size, softened once and kept out from under every word, as if a large chrome form were out of focus behind the page.
- The same state function as the motion and the notch's glow. Needs you tints it toward `--asks` and makes it a little stronger; failed adds a dim red; done lifts it briefly; idle is quietest. The chrome dims as the page fills: full when quiet, 75 % with something running, 45 % when something needs you, 30 % on Earlier.
- **When it moves** (the owner's rule, 2026-11-17): the ambient layer moves while its surface is shown in the window in use, whether or not agents work, so a Tasktap he is looking at is alive; it is a still frame that costs nothing while the window is not the one in use, is hidden, minimised or covered, while Home is not the view shown (beside terminals only the sidebar's glyphs remain, on the same rule), under Reduce Motion, and with Ambient light (the core's `motion_ambient`) at Still. Off removes it. A change of state still plays its moment.
- **How it moves.** One tempo, `--t-ambient`, a breath of 12 s (the first build's pulled the eye; the 24 s after it could not be seen to move), and one amount, `--ambient`, for how far everything travels (1, the owner's "calmer" of three). The test is by eye: a few seconds of looking show it is alive, and it never draws the eye from a row being read. Whatever moves continuously is opacity and transform carried by the compositor from one end of its travel to the other, so it never stops and starts and costs the page nothing: each pool's opacity rises and falls about its resting level in its own time; the band's picture floats a slow round of a few pixels, never further than the room its words are given; each glyph at the sidebar's foot sways (a drift, a tilt, a rock about its upright axis of at most 16°), each out of step with the others. No pace depends on a timer: a web view slows chains of timers down the longer they run (the first build of this stepped poses and frames by timers, and stuttered more the longer it ran).
- **The band** (the owner, 2026-11-17 and 18). It stands in the icon's S in every state, never on a level row, and stays there: nothing slides along it. What moves is its heights: every breath or so, at uneven intervals and strengths, a pulse swells them from the centre outward and settles (a rise of a second, a long fall), the form's own way of showing loudness, and its faces turn a little as the pulse passes, so their reflections flick. It is drawn only while a pulse passes, twelve times a second as it rises (under a pixel a frame) and six as it settles, paced by the display's own frames; between pulses it is a picture. A travelling sine along the row was tried and rejected. A slat stays upright: its column leaves it under two degrees of lean, which at the band's size only breaks its edges into steps. Glyphs and Resonator take the same S and pulse, since all three stand on the one wave.
- The sidebar's foot carries the same light with a few large chrome glyphs (plus 100 px, slash 64, equals 76), there only where the rows leave them room. Each is a picture the motion's chrome shader draws once; the compositor sways it (a drift of a few pixels, a tilt, a rock about its upright axis of at most 16°, so it is never near edge-on) and, every eight seconds, draws it again as it then faces, so its reflections follow (a drawing reads a picture back from the graphics card, which is all the glyphs cost). They arrive and leave by fading and settling, one after another, and step back while the window is not in use.
- **A region answers when it takes focus** (the owner, 2026-11-17: he liked the glyphs answering a tap into the sidebar and asked for the same of the main panel). When focus enters the sidebar, by the pointer or the keyboard, its glyphs step forward as they do when the window comes back into use. When it enters the main panel: on Home the light lifts a little and a pulse passes through its chrome at once; among terminals one glint runs along the lit edge of the focused tab, over no text. When the window comes back into use, the region that has focus answers once. Once per entry: never for typing, scrolling or a click inside the region it is in, never restarted while it runs, at most once a second for a region; none under Reduce Motion or with Ambient light at Still or Off.
- **The wake.** When the sidebar opens or closes, or a sheet drops, the moving edge sheds two to five of the same glyphs (28 to 40 px, never smaller) one after another as it passes their places. A wake is what an edge leaves behind it, so it lies where the edge has just been, by one rule taken from the way the edge travels: left of the sidebar's edge as it opens, right of it as it closes, above a sheet's edge as it drops. Each trails the edge a little way, with a slight turn, and is gone within half a second. The sidebar sheds them along its foot only, where no row is, so they cross none of its words; the first is shed once a whole glyph fits behind the edge and the rest through its way, on a curve that gathers and settles (`--ease-slide`), so the sequence is seen at full speed. None under Reduce Motion or with Ambient light off. `scripts/align-check.cjs` holds every glyph to the trailing side of its edge.

**The four states** (`Z`):

| State | First layer |
| --- | --- |
| Busy day | Capture (quiet). Needs you 2: one open, one line. Running 4. Entry to results (1 new, 1 failed) and For later (2) |
| Normal | Capture (invitation). Running 1. Entry to results (1 new) and For later (1) |
| Quiet | Capture (invitation). The last two finished thoughts. Entry to the rest |
| First run | One composition, centred in the content: the Composer a little above the middle, its place reading "No folder yet", its key "Save for later", the agents as its rings. Under it, on its own edges, one line: "A thought starts in a folder. Until one is open, it is saved for later." and Open a folder… (⌘O), which is the key while the Composer is empty and quiet once it holds a thought (then the Composer's key is the one key). What is saved lands under it in For later, on the same edges, with Send to a folder… showing on the one just saved |

**Three layerings** (`X`, all twelve on `G`). The first layer is the same in all three; they differ in how finished and unplaced thoughts are reached.

- **Folds.** Results and For later are two single lines under what is happening now, each showing its count and its newest title. A line opens in place to its newest five rows and closes again; the last row is "All results", which goes to Earlier. On a quiet day Results opens itself to its last two, so the proof of life and the entry are the same object.
- **Sheets.** Home shows only now. Results and For later sit in the title bar with their counts and drop a sheet from it, the same sheet capture and dialogs use. The page is the barest and the backdrop has the most room.
- **Pages.** Home shows only now, and one line, Earlier, leads to a second page with a find field, For later, then results by day. The title bar gains a way back.

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

The app's one design-token file, `ui/src/tokens.css`, as built. Nothing else in the app names a colour, a size or a radius, unless it is truly local to one component.

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
  --scrim:rgb(0 0 0/.5);
  /* text */
  --fg:#f2f2f3;        /* 17.7 : 1 on --bg */
  --fg2:#a3a4aa;       /*  8.0 : 1 */
  --fg3:#7c7d84;       /*  4.8 : 1; times, hints, disabled */
  --fg-field:#c4c5cb;  /* secondary words on a raised field, lit from behind: 4.5 : 1 at the strongest light */
  --ink:#0d0d0e;       /* text on metal */
  /* lines */
  --line:#1f2024; --line2:#33343a;
  /* meaning */
  --accent:#dfe4ec;    /* keyboard focus ring only */
  --asks:#eab676;      /* needs you */
  --fail:#f0716e;      /* failed */
  --plus:var(--fg2); --minus:var(--fg3);              /* a diffstat's counts */
  --add:rgb(155 203 167/.09); --del:rgb(240 113 110/.09);  /* a diff's lines, under the sign that marks them */
  /* Materials (NOTES §5): every control is one of four, on the ground above.
     Surface: the Composer, raised and lit from behind by the room's light.
     Metal: the key, the one primary action in view, and the caps that show a key. A flat, evenly lit face its label
       always reads on (--ink on it is 15 : 1); the metal is at its edges: a bright top edge, the chromatic glint along
       its lower edge, a soft shadow beneath. Never a band behind the words.
     Quiet: every other control: text, a fill only under the pointer (--hover, --sel), a hairline round a button.
     Edge: --lit, the chromatic lit edge, for what has the keyboard and what is live. Never text, never decoration. */
  --surface:linear-gradient(180deg,rgb(255 255 255/.075),rgb(255 255 255/.04));
  --surface-lit:linear-gradient(180deg,rgb(255 255 255/.095),rgb(255 255 255/.05));
  --surface-edge:inset 0 1px 0 rgb(255 255 255/.09),0 1px 0 rgb(0 0 0/.5),0 30px 60px -28px rgb(0 0 0/.85);
  --key:linear-gradient(180deg,#eceef1,#dde0e5);
  --key-edge:inset 0 1px 0 #fff,0 1px 0 #000,0 3px 7px -2px rgb(0 0 0/.75);
  --key-down:inset 0 1px 2px rgb(0 0 0/.28);
  --lit:linear-gradient(90deg,#b98a5e,#edcda6 18%,#f7f8fa 40%,#a9c0df 62%,#7b92c4 82%,#a58aa6);
  --lit-v:linear-gradient(180deg,#f7f8fa,#a9c0df 55%,#b98a5e);
  --bloom:#c46f3c,#dc9a52 16%,#dfe4ec 33%,#8fb2d8 50%,#5f7fc0 66%,#a7789a 83%,#c46f3c;
  --bar-silver:linear-gradient(90deg,#4a4d53,#eef0f3 38%,#fff 47%,#a2a7af 68%,#3c3f44);
  --bar-copper:linear-gradient(90deg,#5a3a22,#e9b683 40%,#ffe6c8 48%,#b07a4c 70%,#4a2f1c);
  --bar-graphite:linear-gradient(90deg,#26282c,#7b7f87 42%,#9a9ea6 48%,#4a4d53 70%,#1c1d20);
  --sheet-shadow:0 0 0 1px var(--line),0 30px 70px rgb(0 0 0/.7);
  /* type. One family at its normal width for everything said in words; the monospace face for figures, keys, counts
     and code only. Hierarchy is size, weight and colour. Each role is one size, weight, line height and letter
     spacing, and nothing in either page sets a font outside these (scripts/type-check.cjs holds both pages to it). */
  --ui:system-ui,-apple-system,"Segoe UI Variable","Segoe UI",sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,"Cascadia Mono",Consolas,monospace;
  --f-thought:400 20px/28px var(--ui);   /* the Composer's thought on Home */
  --f-question:500 16px/22px var(--ui);  /* a question, wherever it is asked; the thought in the notch and the capture sheet; a find field */
  --f-title:600 13px/18px var(--ui);     /* where you are: the window's and a sheet's title; and the word on a key and on the default answer */
  --f-label:500 13px/18px var(--ui);     /* a row's label: a thought, a workspace, a setting */
  --f-text:400 13px/18px var(--ui);      /* running text: a brief, an answer, a summary */
  --f-small:400 12px/16px var(--ui);     /* secondary text: a session, a tab, a fact, a quiet button */
  --f-section:600 11px/14px var(--ui);   /* a section's label: Workspaces, Running, Results, For later, Terminal */
  --f-cap:400 11px/14px var(--ui);       /* fine print: a hint, the word over a brief */
  --f-num:400 11px/14px var(--mono);     /* figures: times, counts, key hints, paths, a diffstat */
  --f-key:600 11px/18px var(--mono);     /* the glyph on a key cap */
  --f-code:400 12px/18px var(--mono);    /* code, and a shell's name */
  --f-term:400 13px/18px var(--mono);    /* a terminal's default; the person's terminal settings win */
  --ls-thought:-.014em; --ls-question:-.008em;  /* the two large roles are set a hair tighter; every other role at 0 */
  /* measure: a 4 px grid */
  --sp1:4px; --sp2:8px; --sp3:12px; --sp4:16px; --sp5:24px; --sp6:32px;
  --side-w:224px; --bar-h:38px; --tab-h:30px; --row-h:28px; --rail-h:26px; --ctl-h:24px; --ctl-l:34px; --key-h:18px;
  --fade:24px;         /* how far content dissolves at an edge it scrolls beyond */
  --home-w:1040px; --home-wide:1520px; --home-row:36px; --home-gutter:36px; --cap-w:720px;
  --notch-w:420px; --sheet-w:420px; --cap-sheet-w:460px; --list-sheet-w:640px;
  /* radii */
  --r1:3px;   /* controls, key caps */
  --r2:6px;   /* host-drawn panels */
  --r3:10px;  /* bottom corners of sheets and of the notch */
  --r4:20px;  /* the Composer's surface */
  --r-in:8px; /* a control standing 12 px inside that surface */
  /* icons: one owned set on a 16 px grid */
  --i-w:1.2px; --i-cap:butt; --i-join:miter;
  /* time */
  --t-fast:120ms; --t-sheet:220ms; --t-side:280ms; --t-notch-open:510ms; --t-notch-fold:320ms; --t-wave:900ms; --t-bloom:12s;
  --t-ambient:12s;     /* one breath of the ambient light; its glyphs sway and its chrome floats in the same time */
  --ambient:1;         /* how far everything ambient travels: the owner's "calmer" (1.5 was calm, .6 calmest) */
  --ease:cubic-bezier(.19,.76,.19,1);
  --ease-fold:cubic-bezier(.45,0,.5,1);
  --ease-slide:cubic-bezier(.4,0,.2,1);  /* the sidebar: it gathers way, then settles, so its whole travel is seen */
  color-scheme:dark;
}
```

The terminal's own colours come from the person's theme and are not tokens of ours. Instrument never derives a colour from them.

### Type: one family, one width, a scale of roles

The owner, on the first real window (2026-11-18): the title bar's "Home" in the expanded width sat a few pixels from the sidebar's "Home" in the regular width and read as a stretched font; the "Workspaces" label was a third style and the Composer a fourth. The expanded width gave the mock-ups character and broke the window. So the type is one system:

- **One family at its normal width** for everything said in words, the system face. The expanded width is gone everywhere, with its tokens. **The monospace face** is for figures, keys, counts, paths and code only.
- **Hierarchy is size, weight and colour**, on eleven roles, each exactly one size, weight, line height and letter spacing. Nothing in either page sets a font size, weight or family outside them; a `<b>` carries no weight of its own.

| Role | Set in | Used for |
| --- | --- | --- |
| `thought` | 20/28, 400, -0.014em | The Composer's thought on Home |
| `question` | 16/22, 500, -0.008em | A question, wherever it is asked (Home, a pane's strip, the notch, a sheet: they were 17, 15 and 16); the thought in the notch and the capture sheet; a find field |
| `title` | 13/18, 600 | Where you are: the title bar, a sheet's title. And the word on a key and on the default answer |
| `label` | 13/18, 500 | A row's label: a thought, a workspace, Home in the sidebar, a setting, an agent |
| `text` | 13/18, 400 | Running text: a brief, an answer, a summary, a result already seen |
| `small` | 12/16, 400 | Secondary text: a session, a tab, a fact, a folder, a quiet button, a choice |
| `section` | 11/14, 600 | A section's label, one style everywhere, in `--fg2`: Workspaces in the sidebar; Needs you, Running, Results and For later on Home; Thoughts, Speech, Terminal and Appearance in Settings; who asks, in the notch's head |
| `cap` | 11/14, 400 | Fine print: a hint, the word over a brief, a note on how a thought was placed |
| `num` | mono 11/14, 400 | Figures: times, counts, key hints, paths, a diffstat |
| `key` | mono 11/18, 600 | The glyph on a key cap |
| `code` | mono 12/18, 400 | Code in a diff, the router's instructions, a shell's name |

  Merged, since no reason could be stated for the difference: the three question sizes into one; the key's own 12 px bold into `title`; a shell's 11.5 px into `code`; the 15 px find field into `question`; key hints inside a key or a button, which were in the text face, into `num`.
- **The title bar says where you are only where nothing beside it does.** With the sidebar open on Home it carries nothing: the selected row a few pixels away says Home. With the sidebar away it says "Home". In a workspace it carries the workspace's name with its folder, and on Earlier the way back.
- **Checked** by `scripts/type-check.cjs` (in `host/scripts/smoke.sh`): it renders both pages in every fixture state, reads the computed family, width, size, weight and letter spacing of every element that shows text of its own, fails on any that is no role's or whose width is not normal, and prints the roles with where each is used. A terminal's text is left out: its font is the person's.
- **What it changed in Settings' Appearance part**, whose controls are frozen: nothing in its controls; its heading "Appearance", like "Terminal", is now the section role at the normal width instead of the expanded one.

## 5. Components and their states

**Materials** (the owner's round of 2026-11-17: one material system, so every control looks as if it belongs to the same instrument). There are four, on one ground, and every control is one of them; `tokens.css` names them and `parts.css` draws them once.

| Material | What it is for | How it is drawn |
| --- | --- | --- |
| **Ground** | The window, the sidebar, the tab bar, the rail (`--bg`); sheets and the notch (`--sheet`) | One black. Hairlines divide it |
| **Surface** | The Composer on Home | Raised and lit from behind by the room's light: `--surface`, `--surface-edge`, 20 px corners, no border. Brighter (`--surface-lit`) with the keyboard or a thought |
| **Metal** | The key: the one primary action in view. And the caps that show a key | A machined key, not a pipe: a flat, evenly lit face (`--key`) its label always reads on (`--ink` on it is 15 : 1; the check holds every key to 7 : 1), with the metal at its edges only: a bright top edge, the chromatic glint along its lower edge, a soft shadow beneath (`--key-edge`). Never a band behind the words. Two sizes of key, 24 px and 34 px (Home's Composer and what is attached to it); the cap is 18 px. Under the pointer it brightens; pressed, it travels a pixel and its shadow goes (`--key-down`); with nothing to do it is quiet; while its work is on its way it shows the wave |
| **Quiet** | Every other control: an answer (a cap and its label), a button among words, an icon button, the Composer's place, a ring, a row | Text. A fill only under the pointer (`--hover`), deeper while pressed (`--sel`); a button among words has a hairline round it (`--line2`). On the surface the same rule in the surface's own tones |
| **Edge** | What has the keyboard, and what is live: the focused tab, the selected row, a field with the keyboard, the Composer with the keyboard or a thought, the top of a sheet, the rule over what needs you, the ring of the agent that runs the next thought | `--lit`, one pixel (two on a tab), never text, never decoration |

Only one key is metal in a view: where the Composer holds a thought its key is, and Open a folder… beside it steps down to quiet. The Settings sheet is the one exception to the system, by the owner's order of the same day: it keeps the look it had (its switch, its fields, its button), and nothing in it follows a later change.

Every interactive component has: rest, hover, pressed, keyboard focus (a 1.5 px `--accent` outline, 1 px off; inset on full-bleed rows), disabled (38 %; a key with nothing to do is quiet instead). A focus ring is shown for keyboard focus only. Text fields always match `:focus-visible`, so theirs is the lit edge under them instead.

| Component | What it is | States beyond the five |
| --- | --- | --- |
| **State mark** | Five 2 px bars in 14 × 14 | working (moving), asks (tall, copper, lit), ready (bright dotted line), failed (red line with one spike), ended (dim dotted line), any of them in background (45 %). A shell shows a prompt glyph instead. Tooltip and accessible name say the state in words |
| **Sidebar row** | 28 px, full-bleed. Workspace: chevron, name in 600. Session: mark, title, time in mono | selected (fill plus a 2 px lit edge at the left), ended and background (dimmed), shell (title in mono) |
| **Tab** | 30 px, flat text on `--bg`, hairline at the right | active (bright text, 2 px grey edge on top), active in the focused pane (the edge is `--lit`), hover or focus (the cross replaces the mark, at the left), shell (mono) |
| **Divider** | 1 px `--seam`; 7 px hit area | hover (a 35 % `--accent` band) |
| **Question strip** | Under its terminal, on `--bg`: lit hairline, "Codex asks", the question at 15/21, answers | with attention (the hairline is `--lit`, a faint bloom rises 28 px into the terminal), result (plain hairline, Keep as default) |
| **Answer** | A key cap and a label, 28 px, no box | default action (label in 600) |
| **Key cap** | 18 px high, metal, dark mono glyph; Return is the icon set's own arrow, as large as the letters beside it | pressed (travels 1 px) |
| **Key** | The metal button: 24 px, or 34 px on Home's Composer; Return's arrow and what it does | under the pointer (brighter), pressed (travels), nothing to do (quiet), on its way (the wave) |
| **Button** | Quiet: 24 px, 12 px text, a hairline round it | under the pointer (fill), pressed |
| **Reply field** | Key cap `T`, placeholder, no box | hover (fill), focused (fill and the lit edge under it) |
| **Ring** | An agent: its mark in a fine circle, 22 px (24 on Home). Whole when the agent can run; lit for the one that runs the next thought; open, in the attention colour, when it is not signed in, with "Sign in" beside it under the pointer or the keyboard, or always if it is the one chosen. Its name, version and state are its tooltip and its accessible name | working (a short arc turns, the count of its sessions beside it), asks (the attention colour). The circle is `--arc` of a turn, so it can show a share of something later; the core gives no usage, so nothing is shown |
| **Scroller** | No scroller shows a bar, in either page. Where there is more beyond an edge the content dissolves at that edge over `--fade`, and only there, so the cue says which way one can go (`scroll.ts` marks each scroller; a sheet's content dissolves under its own black, at its foot and under a list's head). What takes the keyboard is scrolled clear of it. A terminal scrolled back shows a pill at its foot, "↓ 240 lines ⌘↓", that returns to the end, and a hair-thin mark of where the person is only while they scroll | more above, more below, both |
| **Composer** | One component (section 2, item 3): the thought on its own lines, then a row with where it goes, the agents' rings and the key that says what Return does. Home: the surface. Sheet and notch: bare, the wave beside the thought | empty (key quiet), with the keyboard or a thought (brighter surface, lit rim), typing (grows by lines; key metal), choosing (the row is the choice), no folder ("No folder yet", "Save for later"), sending (the key shows the wave) |
| **List** | Rows of one kind in one set of columns. Leading marks in one fixed column, centred in it; labels on one left edge; secondary text on one left edge; a mark and its label on one centred line. Checked by `scripts/align-check.cjs` (in `host/scripts/smoke.sh`) on both pages | every list on Home, in folds and sheets, the sidebar, the notch |
| **Sheet** | Hangs from the title bar: `--sheet`, `--lit` top edge, 10 px bottom corners, hairline outline, the window dimmed 50 % behind it | dialog (420 px; three rows of key cap and label: ↩ default, ⌘⌫ destructive in `--fail`, esc cancel), capture (460 px), list (640 px: Agents, each line led by its ring; Settings) |
| **Rail** | 26 px at the window's foot, mono | left: the glance in words. Right: Agents, Settings |
| **Home question** | See section 2 | open, collapsed (one 36 px line) |
| **Home row** | 36 px: mark, folder (96 px), thought (13/500), fact, time | running, background, result new, result failed, result seen (dimmed), with actions (a second line of buttons), saved for later (actions appear on hover or focus, and on the one just saved) |
| **Fold** | A 36 px line: chevron, name, count, newest title, time | closed, open (chevron turned, peek hidden, rows below, "All results" last) |
| **Notch** | Section 3 | collapsed idle, collapsed with counts, collapsed with attention (bloom and the line that says what), open on a question, on capture, on a result |
| **Wave** | Chrome bars; the brand mark at work | resting, live (the voice-reactive version from `design/motion-lab` replaces the bars), backdrop |

## 6. Implementation brief

### The window

A grid: sidebar (224 px) and main, over a full-width rail (26 px). The window is 1180 × 760 by default. Below 800 px wide the sidebar hides and its toggle and the window buttons move into the title bar.

**Sidebar.** It slides in and out (⌃⌘S) in 280 ms (`--t-side`, `--ease-slide`), and what is beside it moves with its edge for the whole of the way, on the same curve: it is the window's own column that narrows or widens, so nothing is left to jump at the end, and the title makes room for the window's buttons as it goes. A terminal keeps its size while it slides and is fitted once when the slide is over. Top strip 38 px (window buttons, hide-sidebar). Then Home (with the count of things that need you, in copper, absent at zero), the label "Workspaces" with ＋ (Open a folder, ⌘O; shown on hover of the sidebar and always on first run), then each workspace: a row with a chevron that folds its sessions, and its sessions indented under a guide line. A session row is mark, title, time. Sessions order: asks, working, ready, failed, ended; background ones dimmed with the background glyph. Shells are rows too, in mono. Nothing else is in the sidebar.

**Title bar.** 38 px, hairline below. In a workspace: its name (the title role), its path (mono, dim), then at the right Split right (⌘D), Split down (⇧⌘D), and New task (⌘N). On Home: nothing while the sidebar is open, "Home" while it is away (in the Sheets layering, Results and For later with counts; on Earlier, a way back and the name).

**Deck.** Nested splits of panes. A pane is a 30 px tab bar on `--bg` and, below it, the terminal, padded 12 × 14. As built: one terminal look, Default, on Instrument's black, in Hack 14 with the Nerd Fonts symbols, at the nearest size whose cells are whole pixels wide (13.3 px in cells of 8), every colour kept at 4.5 : 1 on what it is drawn over (both shipped with the app); its palette is the owner's own terminal's. Settings › Terminal sets another family, the size and the line height. Following Ghostty was removed. Tabs: mark, title, cross on hover at the left; ＋ at the end. There is no per-pane toolbar, no status strip, no outline round a pane. Copy, paste and text size are menu commands with their standard shortcuts. Panes are separated by a 1 px seam; a pane below another needs none, its tab bar is the separation. The unfocused panes' terminals draw at 84 %.

**A question in its pane.** A strip under the terminal (the terminal shrinks; nothing floats): "Codex asks" and the time, the question in full, then the answers in a row and the reply field. One key per answer (1 to 9), `T` for a free reply. A result is the same strip: "Result", time, diffstat, the summary, then Keep (↩), Discard, Review changes. The tab and the sidebar row carry the mark; nothing else announces it.

**Rail.** Left: the mark of the most urgent state, then "2 need you", "4 working", "2 new results" (each absent at zero; "Nothing running" when all are). Right: Agents, which drops the Agents sheet, and Settings.

**Sheets.** One mechanism for every interruption inside the window. A sheet hangs from the title bar's lower edge, centred on the window (list sheets: centred on the main area), slides down in 220 ms, dims the window behind it, takes keyboard focus and keeps it until dismissed. Esc, a click on the dimmed area, or the sheet's cancel closes it. Uses: the tab-close dialog ("Close 'thought'?" with Keep running in background ↩, Stop session ⌘⌫, Cancel esc), any other confirmation, capture (⌘N: the notch's capture panel, the same component), Agents, Settings.

### Home

Structure, top to bottom, in one centred column of at most 1040 px (two columns from 1480 px, see section 2), over the light:

1. Capture line.
2. Needs you (only if any): head with the copper wave and the count on a `--lit` rule; the first question open; the rest collapsed.
3. Running (only if any): head with count; up to four rows; then "n more running".
4. If neither 2 nor 3 and there is at least one workspace: the last two finished thoughts (in Folds this is the Results fold, opened to two).
5. First run only (no workspace): the composition of section 2: the Composer a little above the middle, under it on its edges the line and Open a folder…, then For later if anything was saved.
6. Folds: Results, then For later (each only if it has something). A thought just saved for later opens the fold it landed in.

**Layers and how they open and close** (Folds, recommended):

| Second layer | Opens | Closes | Notes |
| --- | --- | --- | --- |
| Results fold | Click its line; `→` or Return with it focused | Click again; `←`; Esc | Shows the newest five. New results first, failed among them. A new result that came back from an isolated run shows Keep, Discard, Review; a failed one shows Open terminal, Try again. Seen results are single dimmed lines. Opening marks nothing as seen; acting on a row or opening its terminal does |
| For later fold | Same | Same | Each row: the thought, "Not sent anywhere yet", the time. Send to a folder… and Drop appear on hover or focus, and on the one just saved; Return on the row is Send |
| Earlier page | "All results" at the end of the Results fold | Back in the title bar; ⌘[; Esc | Find a thought (⌘F), For later, then results grouped Today, Yesterday, weekday names, then dates. The rail and the sidebar stay |
| Agents sheet | Agents in the rail; the ring of an agent that is not signed in | Esc; click outside | Each agent's ring, name, version, sign-in state, and Sign in when needed |
| Settings sheet | Settings in the rail; ⌘, | Esc; click outside | Terminal theme, text size, capture shortcut, start without review, notch on this display |

Only one fold is open at a time. The page scrolls when an open fold makes it taller than the window; the capture line scrolls with it.

**Focus on arrival.** If something needs you, the open question has focus, so `1`, `2` and `T` work at once. Otherwise the capture line has focus and typing starts a thought.

**Keys on Home.** `↓` `↑` move through: capture line, questions, running rows, fold lines, and the rows of an open fold. On a collapsed question, Return or Space opens it. On an open question, `1` to `9` answer, `T` goes to the reply field, Return in the field sends. On a running row, Return opens its terminal. On a fold line, `→` or Return opens, `←` closes. In a fold's row, Return opens the thought's terminal; on a new result `K` keeps, `D` discards, `R` reviews. Esc steps out one level: reply field, then open fold, then back to the capture line.

### The notch

A separate page that shares the tokens and these components: state mark, answer, key cap, reply field, capture line, wave, bloom.

- **Geometry.** Collapsed on a cutout display: the hardware's own shape (190 × 32) when idle; with counts, 322 px wide, the counts in the wings beside the camera and, when something asks, a 24 px line below that says who and what. Collapsed without a cutout: a tab 24 px high with sides leaning 9 px and 10 px bottom corners; idle 92 px wide with the wave at rest; with counts as wide as its line needs, up to 440 px. Open: 420 px wide, as tall as its content, 10 px bottom corners; with a cutout the top 32 px is the band beside the camera (folder and agent at the left, "1 of 2" or the time at the right); without a cutout it is a plain rectangle (section 3) with the same band 30 px high.
- **Question.** The thought (caption), the question in full at 16/22, answers as ruled rows of key cap and label, then the reply row with `T` and "or hold ⌥Space to talk".
- **Capture.** The Composer, bare: the live wave, the thought at 17 px, then its row: where it goes, the agents' rings, the key. Under a question, choosing where it goes is a list of its own, a line a place.
- **Result.** "Result", the thought at 16/22, the summary, the diffstat, then Keep (↩), Discard (D), Open (O).
- **Keys.** `1` to `9`, `T`, Return, Esc; `←` `→` between waiting questions; the existing global shortcuts stay.
- **Light.** The bloom is the shape itself, filled with `--bloom`, blurred 9 px, scaled 2 % wider and 7 % taller from the top edge, drifting over 12 s, behind the black shape. Nothing is stroked.

### Keys in the window

⌘N capture sheet. ⌘O open a folder. ⌘T new tab, ⌘W close tab (the dialog if the session is running). ⌘D split right, ⇧⌘D split down. ⌘, settings. ⌘[ back from Earlier. ⌘↓ returns a terminal scrolled back to its end. In a sheet: Return default, ⌘⌫ destructive, Esc cancel. The existing shortcuts for moving between panes, tabs and workspaces, for the sidebar, and the global capture and answer shortcuts stay as they are; this design adds none beyond those listed.

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

## 9. Routing and speech, as built

The two things that make Tasktap what it is: a thought is spoken or typed, a model works out where it belongs and writes the brief, and an agent starts. Both leave the Mac only once the person has allowed them, so each has a place where it is allowed, and both use one mechanism for "something is on its way". The pictures of every state are made by `scripts/flow-shots.cjs` from fixture records (`instrument-fixtures.cjs`, `flow`), in English and German, with a long thought and brief.

**Allowing a model to place thoughts** (`ui/src/workspace/consent.tsx`, the core's `route.terms` and `route_by`).
- A sheet from the title bar, in the list sheet's measure: what the person gets, in three lines (a thought with no folder named goes where it belongs; a brief written from rambling speech, with nothing they did not say; their own words always sent along); *Who reads them*, one line an agent that is installed and signed in, with the model it would ask, the chosen one a selected row; *What it is sent with each thought*, the core's list as it is; and *The instructions it follows* behind one quiet line that opens them in full. Return is Allow and writes `route_by {agent, model}`; Esc is Not now.
- It is offered, never pushed: one quiet line under the Composer ("Thoughts can find their own folder, and get a brief, with your own agent." See what it sends… Not now) at two moments only: once a folder is open and an agent signed in, before the first thought; and under the first thought of a run that named no folder and went to the usual one. Not now and Turn off both store No (`route_by: null`), and a stored answer is never asked again. To the core a null is no consent, as an absent preference is.
- Settings has a part *Thoughts*: when a sent thought starts, the capture shortcut, and *Placing*: "By name: a thought goes to the folder or session it names" with Let a model place them…, or "By Claude Code · haiku" with What it is sent…, where the same sheet turns it off; or "Needs agreeing again" when the stored model is no longer the one this Tasktap would ask.
- Once allowed, the Composer's place reads **Where it belongs** unless the person picks a folder or the text names one, and Return leaves the placing to the router.

**A thought on its way** (`capture.tsx`, `way.ts`). Under the Composer's row, on Home, in the capture sheet and in the notch, every thought that is being placed or held shows as one block, whoever captured it, so one captured in the notch can be undone on Home:
- **Placing…** with Undo, while a model is asked and it has no place yet.
- Then where it goes (→ folder, or Follow-up: its session), with **Undo** (⌘Z) and **Start**. Start is the one metal key while the Composer's own key has nothing to do, and Return on the empty field presses it; with a new thought typed, the Composer's key is the metal one and Start steps down to quiet.
- Under it, for the newest: **Brief**, with what the model called the work beside the word, and the brief in full; then **You said**, the person's own words, set off by a hairline, since they are what the agent also receives. Both show whenever the brief says the words differently or the thought was spoken; a short typed thought that goes on as it is shows its first line alone. Nothing in it is cut short. Last, how it was placed: "Placed by Claude Code · haiku", with the quoted words for a follow-up, or "Placed by name." and the core's reason as it gave it.
- **The hold is the block's top edge**: a lit line that runs out with the time that is left, from the share that is left, by the clock. No number counts down. It follows the record: when the core moves the hold's end because a brief arrived, the line starts again from the new share; while a brief is still being written ("Writing the brief…") the end is open and the line stands whole and dim.
- A thought that is held is no longer listed under Running; it is on its way until it starts.
- **How it was placed** stays with the thought afterwards, quietly: in its row's and its tab's tooltip; and as a second line on its row where a model was asked and could not be used, the core's sentence in full. A thought in For later says why it is there: "You saved it for later", "It named no folder", "Claude Code found no folder for it", "You kept it for later".

**When it could not decide.** The router's question is a question like any other, first and in full on Home, in the notch and in a sheet: "Where should this go?", the thought under **You said**, the **Brief so far**, the folders and sessions it could mean on their keys (a folder or a terminal mark before each) and **L Keep for later**. It has no reply field: a place is one of these. The collapsed notch says "Where to?" and the thought.

**The agents' rings.** The one that runs the next thought is *seated*: the selected fill and hairline of a chosen segment in Settings, its ring lit and a little heavier, its name beside it where the row has room (Home; in the notch and the capture sheet the seat alone). The seat is where the click landed, and the ring that takes it settles into it over 420 ms, so the choice is seen made and can be read at rest without hovering. The figure beside a ring is what its agent is working on; a session that asks is the ring's attention colour, not part of the count.

**Voice** (`ui/src/speech/`). The page records, so it is the same on every system: the microphone is asked for when voice is first used and never before, heard through an audio worklet (`public/pcm-worklet.js`), turned into 16 kHz mono 16-bit little-endian samples (`pcm.ts`) and sent on the stream `dictation.start` opens, within its credit. It stops at once when the person lets go, cancels, the page loses the window, the core closes the stream, or the 300 seconds are up; the page keeps no audio.
- **The gesture: hold ⌥Space** in the Composer or a reply field, or **press and hold the microphone control**; a hold shorter than 150 ms starts nothing. A short click on the control keeps it on until the next click or Return, for hands that cannot hold. The control shows the microphone and its key, ⌥Space, on Home; in the notch and the capture sheet the Composer's invitation says it instead: "Type, or hold ⌥Space and talk". The capture shortcut (⌃⌥Space) opens the Composer as before.
- **While recording** the Composer's row is the recording: the wave as loud as the voice (five bars on Home; in the notch and the sheet the wave beside the thought, which was there already, follows the voice), "Listening", the time once it passes five seconds ("0:07"), the limit once it is half a minute away ("4:41 of 5:00"), "Let go to send" or "Let go to add it", and Esc Cancel; kept on by a click, the key reads ↩ Done. Then "Writing it down…". The wave's height is the `level` of the `dictations` row, eased between the core's ten reports a second by the clock.
- **Into an empty Composer** it is a new thought: captured as typing and Return would have, so it is placed, shows on its way with its words under You said, and has its hold and Undo. **Into a field that holds text, or a reply**, the words arrive at the caret and nothing is sent until Return.
- **A failure** shows the core's sentence as it is, whatever was heard under "Heard" with Use these words, and Dismiss; Escape cancels at any point.
- **Without a speech service** the control says so in one line, "Voice needs a speech service to turn it into text.", with Choose one…, which opens Settings at Speech.
- **Settings, Speech**: *Turned into text*: "Voice is off" with Use a speech service… and the plain statement that on this Mac is not built yet; or "By OpenAI · gpt-transcribe" with Change…. *Key*: a field that is only ever written, then "A key is stored" and Remove. *Languages you speak*: up to four, German and English first. The service's sheet shows, before anything is stored: OpenAI, Groq or another server; the address and the model; the key; exactly what is sent (the core's `speech.terms`); where; the five-minute limit; and a warning for an address that is not https. Return is Allow.
- **The motion listens** while any dictation records: the workspace hands the motion a voice made from the row's level (`speech/level.ts`), so Home's chrome answers the person speaking.

**Checked.** `scripts/align-check.cjs` holds the new lists and sheets to their columns, every icon and label pair to one centred line, what is read before a thought starts to being whole, and the Composer to one metal key; `scripts/voice-check.cjs` runs the real recorder in headless Chromium against a microphone that is a file; `ui/src/way.test.ts` and `ui/src/speech/pcm.test.ts` prove the mapping from records to what is shown and the bytes of the conversion; `host/scripts/smoke.sh` drives all of it in the real app against the real core, its fixture router and a speech service of its own on this machine, with a tone made in the page in place of a microphone.

**Alternatives that were drawn and not chosen** (pictures only): the terms as a switch in Settings that allows at the flick (it allows before it is read, and cannot be offered where a thought is); the brief beside the words in two columns (the eye zig-zags, and the notch has no room for two); the candidates as the Composer's list of places (a second kind of question beside the one card); the recording as a full overlay with a large waveform (it hides where the thought goes and has no place in a reply); the speech service set up inline in Settings rows (two ways of allowing something, and nothing to return to from the notch).
