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
| What stands in a row is on one weight, one centre line and one baseline (2026-11-19) | Yes | Every stroke of an icon or a seat is `--i-w` on the screen at any size (1.2 px, times the text size); what leads a row is centred on the capitals of its words; words of different sizes on a line share a baseline; figures are monospace, right edges on one line. `scripts/align-check.cjs` measures all four in every state at 1x and 2x, and `scripts/text-sizes.sh` at the three text sizes |
| State in words wherever there is room | Yes | The rail ("2 need you", "4 working", "2 new results"), Home's section names, every state mark's tooltip and accessible name |
| Sentence-first wording | Yes | "2 need you", "Saved for later, until a folder is open", "No folder matched; saved for later" |
| New York for question text | **No** | The owner does not like the other styles; Instrument stays one family plus mono |
| Capsules, blur, floating panels (Native); margin-column page (Ledger) | No | Against Instrument's surfaces |

## 2. Home: a dashboard in layers

**The test for the first layer:** does the person need to see it or act on it the moment the window opens? Three things pass, in this order of weight:

1. **What needs you.** Questions, question first. The first one is open: its folder, agent and thought on one quiet line, the question in full at 17 px, its answers as key caps. Any further question is a single line (wave, folder, agent, thought, the question cut to fit) and opens when chosen; opening one closes the other. The section has the page's only lit rule, so it is the first thing the eye lands on. When nothing needs you the section is absent, not empty.
2. **What is running.** One line each: the moving wave, the folder, the thought, the one fact that matters (the step it is on), the elapsed time. Sessions in the background are dimmed and sort last. No buttons: the row itself opens the terminal. At most four rows; more than that collapse into a last line, "3 more running", which opens in place (specified here, not drawn in the mock-up, which never has more than four).
3. **The capture field.** Always the first thing on the page, so it is always in the same place. The owner chose the Composer (2026-11-17, of three variants; the other two are gone): the **surface** material (section 5): opaque graphite with a hairline, the room's light gathered around it and never through it (the owner, 2026-11-19: lit from behind through a translucent surface it "looks too blueish and should be more in theme with the rest of the app"; its colour is now its lit rim and, with the effects on, the palette chosen in Appearance: the light behind it and the rim follow it, and have no colour with the default palette), 20 px corners (`--r4`), centred and 720 px wide (`--cap-w`). The thought is on lines of its own at 20 px (the placeholder an invitation in `--fg-field`, the caret `--accent`), growing a line at a time up to six (Shift-Return for a new line). Under it, inside the surface, one row:
   - at its left, where the thought will go: "→ folder", a follow-up's session, "For later", or, before any folder is open, "No folder yet";
   - then the agents as **rings** (section 5): the lit one runs the thought, a click on another picks it (the core's `agent` preference), one that is not signed in is an open ring that leads to where it is signed in;
   - at its right, the **key** that says what Return does: "Start", "Send" for a follow-up, "Save for later" when the thought has no folder to go to. It is metal whenever Return does something and quiet when it does nothing. With a thought in the field it sends that thought. With the field empty and a thought held under it, it says "Start" and starts that one now: it is the one thing in view that says Start. A thought leaves the field the moment it is sent, so the next can be typed while it is on its way to the core: the field is never locked, what is typed meanwhile is the beginning of the next thought, the key shows the wave until the core has the last one, and a second Return sends nothing twice. If the core refuses a thought its words are back in the field, before what was typed since.

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

**The light** (as built, replacing the backdrop after the owner rejected a chrome object in leftover space). Home's content is one column, centred, at most 1040 px of rows (`--home-w`) with 36 px gutters, so the rows use the window's width without over-long lines; where Home is 1480 px wide or more and both sides have something, it becomes two columns: what needs you, changes waiting and what is running at the left, Results and For later (open) at the right (while the sidebar slides, by the width Home will have when the slide is over, so nothing reflows on the way). Behind it, one integrated layer of light (`ui/src/workspace/light.tsx`):
- Three large, soft pools of the person's motion palette, deep enough that the dimmest text (`--fg3`) keeps 4.5 : 1 over their brightest point (measured by `scripts/light-sheet.cjs`), dithered against banding, strongest by the capture line; and one low band of chrome across the window, the motion's form far larger than the band, drawn at half size and kept out from under every word, as if a large chrome form were out of focus behind the page.
- The same state function as the motion and the notch's glow. Needs you tints it toward `--asks` and makes it a little stronger; failed adds a dim red; done lifts it briefly; idle is quietest. The chrome dims as the page fills: full when quiet, 75 % with something running, 45 % when something needs you, 30 % on Earlier.
- **When it moves** (the owner's rule, 2026-11-18, replacing the one of the day before, that it moves whenever its surface is shown in the window in use). **At rest the ambient layer is still**: with nothing going on, Home's light and band and the sidebar's glyphs are a picture, and the app's processes use nothing, in front or behind. **While something goes on it is a loop** that runs for as long as that lasts, on its own clock, whether or not the core says anything new: agents thinking or working (the band drifts and pulses, the light breathes, the glyphs sway); a question waiting (a gentler insistence until it is answered: two slow beats in the band every eight seconds, the light and the glyphs at half the amount, no pulse); the voice. **A change of state blends one loop into the next** from the pose and pace on screen, beginning small; only the latest state counts, nothing is queued or replayed, and nothing freezes afterwards. **A moment is an accent over whatever is running**: a result arriving (the light lifts, and light passes once along the band at a quarter of the lab's pace, in about five seconds, turning a face about as far as a pulse does: the pass changes the picture from one frame to the next 1.3 times as much as a pulse at its peak, 1.7 times with Lumen on, where at the lab's strength and half its pace it was nine to thirteen times; the state's form still comes in as every change of state does), a failure, a region taking focus (below). **Rest is the only stillness**: idle; the window not the one in use, hidden, minimised or covered; Home not the view shown (beside terminals only the sidebar's glyphs move, on the same rule); and Effects (the core's `motion_ambient`) below Full: Still is the picture with nothing moving by itself, Off draws none of it and makes no canvas; Reduce Motion and Low Power Mode hold Full at Still.
- **How it moves.** One tempo, `--t-ambient`, a breath of 12 s (the first build's pulled the eye; the 24 s after it could not be seen to move), and one amount, `--ambient`, for how far everything travels (1, the owner's "calmer" of three). The test is by eye: a few seconds of looking show it is alive, and it never draws the eye from a row being read. Two things carry it. The compositor carries opacity and transform from one end of their travel to the other and back, at the display's own rate, pausing only where they turn: each pool's opacity falls and rises about its resting level in its own time; each glyph at the sidebar's foot sways (a drift, a tilt, a rock about its upright axis of at most 16°), each out of step with the others. The shader draws the band. Through a change (states blending, a result's moment, the voice, a clearing coming in under new words) **it is drawn at one even cadence from the first frame of the movement to its last**, in every frame the page is given, up to about 60 a second (a web view gives a page about 60 a second on a 240 Hz display and about 75 on a 144 Hz one; a variable-rate panel gives what it likes), never fewer because the movement is slow, which is what made a slow swell look like single frames (the build before drew it 12 times a second rising and 6 settling, and not at all between a state's moment and the next state, so it waited and then lurched). Nothing asks what the display's rate is: every frame given is drawn except one that comes within 10 ms of the last drawn (every second frame of 120 or 144 a second, every third of 240, all of an uneven 60: the built-in panel hands the page frames 13 to 19 ms apart), and everything moves by the time that passed between the two, by no more than 50 ms at once, so after a stall it goes on from where it was (`scripts/cadence-check.cjs` hands the page frames 60, 120, 144 and 240 to a second and at intervals that jump between 4 and 33 ms, and holds the motion to the time passed). Its own motion gathers way and loses it over most of a second; a state comes in through two eased stages, so it starts from the pace on screen. No pace depends on a timer: a web view slows chains of timers down the longer they run. A lasting loop of the band is not drawn in every frame but carried by the compositor between keyframes, at the display's own rate (below); a timer only says when the next keyframe is drawn, a whole interval early.
- **The band** (the owner, 2026-11-17 and 18). It stands in the icon's S in every state, never on a level row, and stays there: nothing slides along it. While agents think or work its form drifts in its own slow way (the hump wanders, the faces turn) and, every breath or so, at uneven intervals and strengths, a pulse swells its heights from the centre outward and settles, the form's own way of showing loudness, its faces turning a little as it passes, so their reflections flick. A pulse rises in a second, falls in a little over four (gathering way from the top, then losing it evenly) and is at rest: no tail that never ends. One that begins while the last settles joins it. A travelling sine along the row was tried and rejected. A slat stays upright: its column leaves it under two degrees of lean, which at the band's size only breaks its edges into steps. Glyphs and Resonator take the same S and pulse, since all three stand on the one wave. Its edges cover a pixel by the share of it they reach, and nothing in the metal is finer than a pixel: a light's reflection is as soft as the metal turns under one pixel (a slat's shoulder, a glyph's chamfer and creases), and a light's falloff no longer runs below zero in a soft reflection, where it drew white fringes with black hairlines that hopped from pixel to pixel. So a height changes in hundredths of a pixel and no pixel jumps: moved a hundredth of a pixel, the most one pixel changes is 16 levels of 255 for Slats, 20 for Glyphs and 18 for Resonator, where it was 112, 249 and 157 (`scripts/subpixel-check.cjs`, on the GPU, which bounds it at 30); its canvas is one pixel to two CSS pixels each way (593 × 380 shown at 1185 × 760), which is its look, and is not blurred (the canvas blur the first build asked for never applied in the app's web view, and is gone).
- **The lasting loop is carried by the compositor** (built 2026-11-18; `ui/src/motion/engine.ts`, `View.carry`). What the loop cost before, in the built app: at rest nothing; with agents working on Home in the window in use 9 to 18 % of one processor core (9 % in two short runs, as host 2.9, page 4.0 and graphics process 2.2; 18 % over a minute), with a question waiting 15.9 %; and most of that was not the drawing: a page that is given frames at all costs this web view about 6 % of a core between the host, the page's process and the graphics process (cutting the shader from 60 drawings a second to 15 only took 9 % to 6 %), while what the compositor carries by itself (the pools, the glyphs) costs about 1 %. So while agents work or a question waits, once the band is at its pace, the page is given no frames. It draws keyframes of the band only: the form as it will be a little later, each into one of three layers (three canvases, each with a WebGL context of its own: a style's program takes this web view a quarter of a second to build the first time and 5 to 9 ms in each further context, and is built off the page's thread, so the first picture waits for none), and the compositor fades the layer on screen out and the next in over exactly the time between the two, by opacity animations set to begin at the moment the last keyframe is whole (the document's timeline, so none is late), the layers adding up (`mix-blend-mode: plus-lighter` inside the view, which is isolated; two half-clear pictures laid over each other would dip in the middle of a fade). Each keyframe is drawn a whole interval before its fade begins, so a timer that fires late shows nowhere; if the page is held up for longer, the last keyframe stands, as a loop drawn by the page would stand, and the page goes on from there by no more than 50 ms. A keyframe is due when an edge of the form would have gone 0.4 of a drawn pixel (`STEP`) by its own drift, its pulses and a question's beats, never sooner than a thirtieth of a second or later than a quarter, and exactly when the next pulse begins: the pulses' uneven times and strengths come from the generator they came from before, and a pulse begins when it was due, not when a drawing finds it so. That is about 20 keyframes a second with agents working and 16 with a question waiting. Whatever changes the band (its state, a kick, the look, its size, words coming or going, the window, another view drawing) brings it back to the page at the clocks of that moment, its layers holding what they show until the page's next frame; the page then draws every frame as before, until the band is steady again. Thinking stays the page's (its packet crosses the form at hundreds of pixels a second, which no fade can follow, and it lasts a moment), and so do a result's moment and the voice. **That the picture is the same** is held by `scripts/carry-check.cjs`: the engine as shipped runs beside one that draws every refresh of a 120 Hz display itself, on one clock, and every pixel of every refresh is compared, for each of the three forms, with and without Lumen, working and with a question waiting. The carried picture is off the exact one by 0.06 to 1.5 of 255 levels on average and, at the 99.9th percentile of pixels, by 4 to 124 (Slats working: 0.22 and 23), in the band's own canvas, which Home shows at 15 to 50 %; in every case that is as far as the exact picture itself moves from one refresh to the next, so no further than a loop drawn 60 times a second is off at every second refresh of this panel. Its clocks stay within two frames of the exact ones through changes of state, a kick and a result, what is shown never steps by more than three refreshes' worth, and the layers' real opacities add up to one in every frame. With keyframes further apart the difference grows in step (Slats working: 0.8 px, 9 a second, twice as far off; 1.2 px, 6 a second, three times), which is the one dial if the cost must come down further. **What it costs in the built app is not measured yet**: the screen was locked from the hour it was built. `node scripts/cost-check.cjs --minutes 5 --steps 0.8,1.2` measures each loop as carried and as drawn by the page, per process, from the system's own counts (processor time, the share of it on the fast cores, instructions, wakeups, power), and says each half minute, which will also say why a minute read twice what twelve seconds did.
- The sidebar's foot carries the same light with a few large chrome glyphs (plus 100 px, slash 64, equals 76), there only where the rows leave them room. Each is a picture the motion's chrome shader draws once; the compositor sways it (a drift of a few pixels, a tilt, a rock about its upright axis of at most 16°, so it is never near edge-on) and, every eight seconds, draws it again as it then faces and brings that in evenly over the whole eight, so its reflections follow all the time and never in a step (a drawing reads a picture back from the graphics card, which is all the glyphs cost). They arrive and leave by fading and settling, one after another, and step back while the window is not in use.
- **A region answers when it takes focus** (the owner, 2026-11-17: he liked the glyphs answering a tap into the sidebar and asked for the same of the main panel). When focus enters the sidebar, by the pointer or the keyboard, its glyphs step forward as they do when the window comes back into use. When it enters the main panel: on Home the light lifts a little and a pulse passes through its chrome at once; among terminals one glint runs along the lit edge of the focused tab, over no text. When the window comes back into use, the region that has focus answers once. Once per entry: never for typing, scrolling or a click inside the region it is in, never restarted while it runs, at most once a second for a region; none with Effects below Full.
- **The wake.** (Since 2026-11-18 the sidebar's only: no sheet sheds one, section 11.) When the sidebar opens or closes, or a sheet drops, the moving edge sheds two to five of the same glyphs (28 to 40 px, never smaller) one after another as it passes their places. A wake is what an edge leaves behind it, so it lies where the edge has just been, by one rule taken from the way the edge travels: left of the sidebar's edge as it opens, right of it as it closes, above a sheet's edge as it drops. Each trails the edge a little way, with a slight turn, and is gone within half a second. The sidebar sheds them along its foot only, where no row is, so they cross none of its words; closing, when that place has become the main panel's, they lie behind Home's rows, in its light, and there are none over a terminal, which is text from edge to edge; the first is shed once a whole glyph fits behind the edge and the rest through its way, on a curve that gathers and settles (`--ease-slide`), so the sequence is seen at full speed. None with Effects below Full. `scripts/align-check.cjs` holds every glyph to the trailing side of its edge.

**The four states** (`Z`):

| State | First layer |
| --- | --- |
| Busy day | Capture (quiet). Needs you 2: one open, one line. Running 4. Entry to results (1 new, 1 failed) and For later (2) |
| Normal | Capture (invitation). Running 1. Entry to results (1 new) and For later (1) |
| Quiet | Capture (invitation). The last two finished thoughts. Entry to the rest |
| First run | One composition, centred in the content: the Composer a little above the middle, its place reading "No folder yet", its key "Save for later", the agents as its rings. Under it, on its own edges, one line: "A thought starts in a folder. Until one is open, it is saved for later." and Open a folder… (⌘O), which is the key while the Composer is empty and quiet once it holds a thought (then the Composer's key is the one key). What is saved lands under it in For later, on the same edges, with Send to a folder… showing on the one just saved. The composition is for a Home with nothing on it yet (no folder open, nothing asked, running or done), and the line speaks only while it is true: while no folder is open and the next thought has nowhere to start. Once a thought runs in Scratch, Home is the usual page and says nothing under the Composer (the owner's picture of 2026-11-19 showed the line beside a thought that had started in Scratch). Where a thought started is said under the Composer for six seconds and then by its row alone |

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
  --fg-field:#c4c5cb;  /* secondary words on the Composer's surface: 10 : 1 on it with the keyboard */
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
     Surface: the Composer: opaque graphite of the ground's own family with a hairline round it, brighter along its
       top. The room's light stands around it and never shows through it, so it has no colour of its own.
     Metal: the key, the one primary action in view, and the caps that show a key. A flat, evenly lit face its label
       always reads on (--ink on it is 15 : 1); the metal is at its edges: a bright top edge, the chromatic glint along
       its lower edge, a soft shadow beneath. Never a band behind the words.
     Quiet: every other control: text, a fill only under the pointer (--hover, --sel), a hairline round a button.
     Edge: --lit, the chromatic lit edge, for what has the keyboard and what is live. Never text, never decoration. */
  --surface:var(--fill);
  --surface-lit:var(--sel);
  --surface-edge:inset 0 1px 0 var(--line2),inset 0 0 0 1px var(--line),0 30px 60px -28px rgb(0 0 0/.85);
  --key:linear-gradient(180deg,#eceef1,#dde0e5);
  --key-edge:inset 0 1px 0 #fff,0 1px 0 #000,0 3px 7px -2px rgb(0 0 0/.75);
  --key-down:inset 0 1px 2px rgb(0 0 0/.28);
  --lit:linear-gradient(90deg,#b98a5e,#edcda6 18%,#f7f8fa 40%,#a9c0df 62%,#7b92c4 82%,#a58aa6);
  --lit-v:linear-gradient(180deg,#f7f8fa,#a9c0df 55%,#b98a5e);
  --bloom:#c46f3c,#dc9a52 16%,#dfe4ec 33%,#8fb2d8 50%,#5f7fc0 66%,#a7789a 83%,#c46f3c;
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
  --f-num:400 11px/14px var(--mono);     /* figures: times, counts, paths, a diffstat */
  --f-key:500 12px/18px var(--ui);       /* a key, on a cap or as a hint beside a label: never smaller (ui.tsx Key) */
  --f-code:400 12px/18px var(--mono);    /* code, and a shell's name */
  --f-term:400 13px/18px var(--mono);    /* a terminal's default; the person's terminal settings win */
  --ls-thought:-.014em; --ls-question:-.008em;  /* the two large roles are set a hair tighter; every other role at 0 */
  /* measure: a 4 px grid */
  --sp1:4px; --sp2:8px; --sp3:12px; --sp4:16px; --sp5:24px; --sp6:32px;
  --side-w:224px; --bar-h:38px; --tab-h:30px; --row-h:28px; --rail-h:26px; --ctl-h:24px; --ctl-l:34px; --key-h:18px;
  --fade:24px;         /* how far content dissolves at an edge it scrolls beyond */
  --home-w:1040px; --home-wide:1520px; --home-row:36px; --home-gutter:36px; --cap-w:720px;
  --notch-w:420px;
  --sheet-s:480px; --sheet-m:640px; --sheet-l:900px;  /* a sheet: a quick decision, a form or a list, a view to read */
  /* radii */
  --r1:3px;   /* controls, key caps */
  --r2:6px;   /* host-drawn panels */
  --r3:10px;  /* bottom corners of sheets and of the notch */
  --r4:20px;  /* the Composer's surface */
  --r-in:8px; /* a control standing 12 px inside that surface */
  /* icons: one owned set on a 16 px grid, and one weight: every stroke of an icon and of an agent's ring is this wide on
     the screen whatever size it is shown at (parts.css), which is the weight of the text beside it at each text size */
  --i-w:calc(1.2px * var(--ts));
  --i-w-key:calc(1.35px * var(--ts));  /* the one heavier stroke: Return's arrow on the metal key, beside its word in 600 */
  --i-cap:butt; --i-join:miter;
  /* time */
  --t-fast:120ms; --t-sheet:220ms; --t-side:280ms; --t-notch-open:510ms; --t-notch-fold:320ms; --t-bloom:12s;
  --t-ambient:12s;     /* one breath of the ambient light; its glyphs sway and its chrome drifts in the same time */
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
| `num` | mono 11/14, 400 | Figures: times, counts, paths, a diffstat |
| `key` | 12/18, 500, in the system face | A key, wherever one is shown: on a cap, or as a hint after a label (section 11) |
| `code` | mono 12/18, 400 | Code in a diff, the router's instructions, a shell's name |

  Merged, since no reason could be stated for the difference: the three question sizes into one; the key's own 12 px bold into `title`; a shell's 11.5 px into `code`; the 15 px find field into `question`; key hints inside a key or a button, which were in the text face, into `num`.
- **The title bar says where you are only where nothing beside it does.** With the sidebar open on Home it carries nothing: the selected row a few pixels away says Home, and the bar is no strip there (section 6), only the window's handle. With the sidebar away it says "Home". In a workspace it carries the workspace's name with its folder, and on Earlier the way back.
- **Checked** by `scripts/type-check.cjs` (in `host/scripts/smoke.sh`): it renders both pages in every fixture state, reads the computed family, width, size, weight and letter spacing of every element that shows text of its own, fails on any that is no role's or whose width is not normal, and prints the roles with where each is used. A terminal's text is left out: its font is the person's.
- **What it changed in Settings' Appearance part**, whose controls are frozen: nothing in its controls; its heading "Appearance", like "Terminal", is now the section role at the normal width instead of the expanded one.

## 5. Components and their states

**Materials** (the owner's round of 2026-11-17: one material system, so every control looks as if it belongs to the same instrument). There are four, on one ground, and every control is one of them; `tokens.css` names them and `parts.css` draws them once.

| Material | What it is for | How it is drawn |
| --- | --- | --- |
| **Ground** | The window, the sidebar, the tab bar, the rail (`--bg`); sheets and the notch (`--sheet`) | One black. Hairlines divide it |
| **Surface** | The Composer on Home | Opaque graphite, the family of the app's other fills (`--surface` is `--fill`), with a hairline that is brighter along its top (`--surface-edge`), 20 px corners. A shade brighter (`--surface-lit`, which is `--sel`) with the keyboard or a thought. The room's light stands around it: with the effects on, a soft light of the palette's first colour behind it and the lit rim in the palette's two; no colour with the default palette; with the effects off, the surface and its hairline only |
| **Metal** | The key: the one primary action in view. And the caps that show a key | A machined key, not a pipe: a flat, evenly lit face (`--key`) its label always reads on (`--ink` on it is 15 : 1; the check holds every key to 7 : 1), with the metal at its edges only: a bright top edge, the chromatic glint along its lower edge, a soft shadow beneath (`--key-edge`). Never a band behind the words. Two sizes of key, 24 px and 34 px (Home's Composer and what is attached to it); the cap is 18 px. Under the pointer it brightens; pressed, it travels a pixel and its shadow goes (`--key-down`); with nothing to do it is quiet; while its work is on its way it shows the wave |
| **Quiet** | Every other control: an answer (a cap and its label), a button among words, an icon button, the Composer's place, a ring, a row | Text. A fill only under the pointer (`--hover`), deeper while pressed (`--sel`); a button among words has a hairline round it (`--line2`). On the surface the same rule in the surface's own tones |
| **Edge** | What has the keyboard, and what is live: the focused tab, the selected row, a field with the keyboard, the Composer with the keyboard or a thought, the top of a sheet, the rule over what needs you, the ring of the agent that runs the next thought | `--lit`, one pixel (two on a tab), never text, never decoration |

Only one key is metal in a view: where the Composer holds a thought its key is, and Open a folder… beside it steps down to quiet. The Settings sheet is the one exception to the system, by the owner's order of the same day: it keeps the look it had (its switch, its fields, its button), and nothing in it follows a later change.

Every interactive component has: rest, hover, pressed, keyboard focus (a 1.5 px `--accent` outline, 1 px off; inset on full-bleed rows), disabled (38 %; a key with nothing to do is quiet instead). A focus ring is shown for keyboard focus only. Text fields always match `:focus-visible`, so theirs is the lit edge under them instead.

| Component | What it is | States beyond the five |
| --- | --- | --- |
| **State mark** | Five 2 px bars in 14 × 14 | working (moving), asks (tall, copper, lit), ready (bright dotted line), failed (red line with one spike), ended (dim dotted line), any of them in background (45 %). A shell shows a prompt glyph instead. Tooltip and accessible name say the state in words |
| **Sidebar row** | 28 px, full-bleed. Workspace: chevron, name in 600. Session: its seat (below), title, time in mono, the words on one baseline | selected (fill plus a 2 px lit edge at the left), ended and background (dimmed), shell (title in mono) |
| **Tab** | 30 px, flat text on `--bg`, hairline at the right | active (bright text, 2 px grey edge on top), active in the focused pane (the edge is `--lit`), hover or focus (the cross replaces the mark, at the left), shell (mono) |
| **Divider** | 1 px `--seam`; 7 px hit area | hover (a 35 % `--accent` band) |
| **Question strip** | Under its terminal, on `--bg`: lit hairline, "Codex asks", the question at 15/21, answers | with attention (the hairline is `--lit`, a faint bloom rises 28 px into the terminal), result (plain hairline, Keep as default) |
| **Answer** | A key cap and a label, 28 px, no box | default action (label in 600) |
| **Key cap** | 18 px high, metal, dark mono glyph; Return is the icon set's own arrow, as large as the letters beside it | pressed (travels 1 px) |
| **Key** | The metal button: 24 px, or 34 px on Home's Composer; Return's arrow and what it does | under the pointer (brighter), pressed (travels), nothing to do (quiet), on its way (the state mark, turning) |
| **Button** | Quiet: 24 px, 12 px text, a hairline round it | under the pointer (fill), pressed |
| **Reply field** | Key cap `T`, placeholder, no box | hover (fill), focused (fill and the lit edge under it) |
| **Ring** | An agent: its mark in a fine circle, 22 px (24 on Home). Whole when the agent can run; lit for the one that runs the next thought; open, in the attention colour, when it is not signed in, with "Sign in" beside it under the pointer or the keyboard, or always if it is the one chosen. Its name, version and state are its tooltip and its accessible name | working (a short arc turns, the count of its sessions beside it), asks (the attention colour). The circle is `--arc` of a turn, so it can show a share of something later; the core gives no usage, so nothing is shown |
| **Scroller** | No scroller shows a bar, in either page. Where there is more beyond an edge the content dissolves at that edge over `--fade`, and only there, so the cue says which way one can go (`scroll.ts` marks each scroller; a sheet's content dissolves under its own black, at its foot and under a list's head). What takes the keyboard is scrolled clear of it. A terminal scrolled back shows a pill at its foot, "↓ 240 lines ⌘↓", that returns to the end, and a hair-thin mark of where the person is only while they scroll | more above, more below, both |
| **Composer** | One component (section 2, item 3): the thought on its own lines, then a row with where it goes, the agents' rings and the key that says what Return does. Home: the surface. Sheet and notch: bare, the wave beside the thought | empty (key quiet), with the keyboard or a thought (brighter surface, lit rim), typing (grows by lines, six at most on Home and three elsewhere; key metal), empty over a thought that is held (key metal, "Start": Return starts it now), choosing (the row is the choice), no folder ("No folder yet", "Save for later"), sending (the field is free for the next thought; the key shows the wave until it holds one) |
| **List** | Rows of one kind in one set of columns. Leading marks in one fixed column, centred in it; labels on one left edge; secondary text on one left edge; a mark and its label on one centred line. Checked by `scripts/align-check.cjs` (in `host/scripts/smoke.sh`) on both pages | every list on Home, in folds and sheets, the sidebar, the notch |
| **Sheet** | Hangs from the title bar: `--sheet`, `--lit` top edge, 10 px bottom corners, hairline outline, the window dimmed 50 % behind it | dialog (420 px; three rows of key cap and label: ↩ default, ⌘⌫ destructive in `--fail`, esc cancel), capture (460 px), list (640 px: Agents, each line led by its ring; Settings) |
| **Rail** | 26 px at the window's foot, mono | left: the glance in words. Right: Agents, Settings |
| **Home question** | See section 2 | open, collapsed (one 36 px line) |
| **Seat** | A session's leading mark wherever a session is shown (a row on Home, a sidebar row, a tab): its agent's ring, 20 px on Home and 16 px elsewhere, its circle at the icons' weight | working (the ring's arc turns), asks (the attention colour, glowing), result new (the ring is the lit edge), failed (the failure colour), seen or ended (quiet), in background (dimmed). A shell keeps the terminal icon, a thought saved for later its small circle |
| **Home row** | An object of two lines that keeps its shape at every width (the owner, 2026-11-19: the table's parts drifted apart, and the mark was heavier than the words beside it): the seat, the thought (13/500) and the time on one baseline; under them, quietly, folder · agent · the one fact, in that order, so that what gives way is the end of the fact. A question that is not open is the same row with the question where the thought would be. Rows stand two abreast where the column is at least 872 px wide, a lone row takes the whole width; every word in a section, its heading included, starts on one edge (`--lead`, 32 px), and what leads a row (a seat, a mark, a chevron) is centred in the column before it | running, background, result new, result failed, result seen (dimmed), with actions (a line of buttons under it), with changes (the diffstat at the right of the second line), saved for later (actions beside its words on hover or focus, and on the one just saved) |
| **Fold** | A 36 px line: chevron, name, count, newest title, time | closed, open (chevron turned, peek hidden, rows below, "All results" last) |
| **Notch** | Section 3 | collapsed idle, collapsed with counts, collapsed with attention (bloom and the line that says what), open on a question, on capture, on a result |
| **Mark** | Tasktap's mark: a slab of the chrome set (`ui/src/motion/mark.ts`), pictures drawn once from the motion engine by `scripts/mark-pictures.cjs` (the pages at 14, 24 and 28 px, the site's header and favicon, the notification area on Windows). It replaced the chrome bars on 2026-11-19: the owner found them cheap beside the chromatic render | at rest (still), at work (the light slides down its face and back, a picture of its face turned fading in and out), as loud as the voice (the light behind it swells with the level and its face turns into it). The state mark is a seat with no agent in it: the ring, turning while it works, else a pip of the state's colour |

## 6. Implementation brief

### The window

A grid: sidebar (224 px) and main, over a full-width rail (26 px). The window is 1180 × 760 by default. Below 800 px wide the sidebar hides and its toggle and the window buttons move into the title bar.

**Sidebar.** It slides in and out (⌃⌘S) in 280 ms (`--t-side`, `--ease-slide`), and what is beside it moves with its edge for the whole of the way, on the same curve: it is the window's own column that narrows or widens, so nothing is left to jump at the end, and the title makes room for the window's buttons as it goes. A terminal keeps its size while it slides and is fitted once when the slide is over. Top strip 38 px (window buttons, hide-sidebar). Then Home (with the count of things that need you, in copper, absent at zero), the label "Workspaces" with ＋ (Open a folder, ⌘O; shown on hover of the sidebar and always on first run), then each workspace: a row with a chevron that folds its sessions, and its sessions indented under a guide line. A session row is mark, title, time. Sessions order: asks, working, ready, failed, ended; background ones dimmed with the background glyph. Shells are rows too, in mono. Nothing else is in the sidebar.

**Title bar.** 38 px in every view, so nothing moves when the view changes or the sidebar slides, and all of it that is not a control drags the window. Where it carries something that is not the view itself it is a strip with a hairline below. In a workspace: its name (the title role), its path (mono, dim), then at the right Split right (⌘D), Split down (⇧⌘D), and New task (⌘N). On Earlier: a way back and the name. On Home it is no strip (the owner, 2026-11-18: with the sidebar open it was an empty band): it draws no hairline, and the room's light dissolves into the window's black under it over `--fade`, as a scroller's content does at an edge, so Home begins at the window's top edge. It holds nothing while the sidebar is open, and the way back to the sidebar and "Home" beside the window's buttons while it is away. Its hairline shows for as long as a sheet hangs from it.

**Deck.** Nested splits of panes. A pane is a 30 px tab bar on `--bg` and, below it, the terminal, padded 12 × 14. As built: one terminal look, Default, on Instrument's black, in Hack 14 with the Nerd Fonts symbols, at the nearest size whose cells are whole pixels wide (13.3 px in cells of 8), every colour kept at 4.5 : 1 on what it is drawn over (both shipped with the app); its palette is the owner's own terminal's. Settings › Terminal sets another family, the size and the line height. Following Ghostty was removed. Tabs: mark, title, cross on hover at the left; ＋ at the end. There is no per-pane toolbar, no status strip, no outline round a pane. Copy, paste and text size are menu commands with their standard shortcuts. Panes are separated by a 1 px seam; a pane below another needs none, its tab bar is the separation. The unfocused panes' terminals draw at 84 %.

**A question in its pane.** A strip under the terminal (the terminal shrinks; nothing floats): "Codex asks" and the time, the question in full, then the answers in a row and the reply field. One key per answer (1 to 9), `T` for a free reply. A result is the same strip: "Result", time, diffstat, the summary, then Keep (↩), Discard, Review changes. The tab and the sidebar row carry the mark; nothing else announces it.

**Rail.** Left: the mark of the most urgent state, then "2 need you", "4 working", "2 new results" (each absent at zero; "Nothing running" when all are). Right: Settings (the agents are a section of it: section 11).

**Sheets.** One mechanism for every interruption inside the window. A sheet hangs from the title bar's lower edge (which shows while one does, on Home too), centred on the window, whatever the sidebar does (section 11), comes down a short way in 160 ms, dims the window behind it, takes keyboard focus and keeps it until dismissed. Esc, a click on the dimmed area, or the sheet's cancel closes it. Uses: the tab-close dialog ("Close 'thought'?" with Keep running in background ↩, Stop session ⌘⌫, Cancel esc), any other confirmation, capture (⌘N: the notch's capture panel, the same component), Agents, Settings.

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
| Settings › Agents | Settings in the rail, then Agents (⌘3); the ring of an agent that is not signed in | Esc; ⌘W; click outside | Each agent's ring, name, version, sign-in state, Sign in when needed, and which is the default |
| Settings sheet | Settings in the rail; ⌘, | Esc; ⌘W; click outside | Six sections at its left: Thoughts, Voice, Agents, Appearance, Terminal, About (section 11) |

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
- Once allowed, the Composer's place reads **Tasktap decides** unless the person picks a folder or the text names one, and Return leaves the placing to the router.

**A thought on its way** (`capture.tsx`, `way.ts`). Under the Composer's row, on Home, in the capture sheet and in the notch, every thought that is being placed or held shows as one block, whoever captured it, so one captured in the notch can be undone on Home:
- **Placing…** with Undo, while a model is asked and it has no place yet.
- Then where it goes (→ folder, or Follow-up: its session), with **Undo** (⌘Z). The block has no key of its own (the owner, 2026-11-18: "Start" stood twice, on the block and on the Composer): starting it now is what Return does on the empty field, so the Composer's key says so and does it, the one metal key and the one Start in view. Where several wait it starts the newest; each starts by itself when its hold is over. With a new thought typed the key is that thought's, and the one that waits starts when its hold is over. ⌘Z pressed while a thought is still on its way to the core takes it back once it has arrived.
- Under it, for the newest: **Brief**, with what the model called the work beside the word, and the brief in full; then **You said**, the person's own words, set off by a hairline, since they are what the agent also receives. Both show whenever the brief says the words differently or the thought was spoken; a short typed thought that goes on as it is shows its first line alone. Nothing in it is cut short. Last, how it was placed: "Placed by Claude Code · haiku", with the quoted words for a follow-up, or "Placed by name." and the core's reason as it gave it.
- **The hold is the block's top edge**: a lit line that runs out with the time that is left, from the share that is left, by the clock. No number counts down. It follows the record: when the core moves the hold's end because a brief arrived, the line starts again from the new share; while a brief is still being written ("Writing the brief…") the end is open and the line stands whole and dim.
- A thought that is held is no longer listed under Running; it is on its way until it starts.
- **How it was placed** stays with the thought afterwards, quietly: in its row's and its tab's tooltip; and as a second line on its row where a model was asked and could not be used, the core's sentence in full. A thought in For later says why it is there: "You saved it for later", "It named no folder", "Claude Code found no folder for it", "You kept it for later".

**When it could not decide.** The router's question is a question like any other, first and in full on Home, in the notch and in a sheet: "Where should this go?", the thought under **You said**, the **Brief so far**, the folders and sessions it could mean on their keys (a folder or a terminal mark before each) and **L Keep for later**. It has no reply field: a place is one of these. The collapsed notch says "Where to?" and the thought.

**The agents' rings.** The one that runs the next thought is *seated*: the selected fill and hairline of a chosen segment in Settings, its ring lit and a little heavier, its name beside it where the row has room (Home; in the notch and the capture sheet the seat alone). The seat is where the click landed, and the ring that takes it settles into it over 420 ms, so the choice is seen made and can be read at rest without hovering. The figure beside a ring is what its agent is working on; a session that asks is the ring's attention colour, not part of the count.

**Voice** (`ui/src/speech/`). The page records, so it is the same on every system: the microphone is asked for when voice is first used and never before, heard through an audio worklet (`public/pcm-worklet.js`), turned into 16 kHz mono 16-bit little-endian samples (`pcm.ts`) and sent on the stream `dictation.start` opens, within its credit. It stops at once when the person lets go, cancels, the page loses the window, the core closes the stream, or the 300 seconds are up; the page keeps no audio.
- **The gesture: hold ⌥Space** in the Composer or a reply field, or **press and hold the microphone control**; a hold shorter than 150 ms starts nothing. A short click on the control keeps it on until the next click or Return, for hands that cannot hold. The control shows the microphone and its key, ⌥Space, on Home; in the notch and the capture sheet the Composer's invitation says it instead: "Type, or hold ⌥Space and talk". The capture shortcut (⌃⌥Space) opens the Composer as before.
- **While recording** the Composer's row is the recording: Tasktap's mark as loud as the voice (on Home in the row; in the notch and the sheet the mark beside the thought, which was there already, follows the voice), "Listening", the time once it passes five seconds ("0:07"), the limit once it is half a minute away ("4:41 of 5:00"), "Let go to send" or "Let go to add it", and Esc Cancel; kept on by a click, the key reads ↩ Done. Then "Writing it down…". The light behind the mark follows the `level` of the `dictations` row, eased between the core's ten reports a second by the clock.
- **Into an empty Composer** it is a new thought: captured as typing and Return would have, so it is placed, shows on its way with its words under You said, and has its hold and Undo. **Into a field that holds text, or a reply**, the words arrive at the caret and nothing is sent until Return.
- **A failure** shows the core's sentence as it is, whatever was heard under "Heard" with Use these words, and Dismiss; Escape cancels at any point.
- **Without a speech service** the control says so in one line, "Voice needs a speech service to turn it into text.", with Choose one…, which opens Settings at Speech.
- **Settings, Speech**: *Turned into text*: "Voice is off" with Use a speech service… and the plain statement that on this Mac is not built yet; or "By OpenAI · gpt-transcribe" with Change…. *Key*: a field that is only ever written, then "A key is stored" and Remove. *Languages you speak*: up to four, German and English first. The service's sheet shows, before anything is stored: OpenAI, Groq or another server; the address and the model; the key; exactly what is sent (the core's `speech.terms`); where; the five-minute limit; and a warning for an address that is not https. Return is Allow.
- **The motion listens** while any dictation records: the workspace hands the motion a voice made from the row's level (`speech/level.ts`), so Home's chrome answers the person speaking.

**Checked.** `scripts/align-check.cjs` holds the new lists and sheets to their columns, every icon and label pair to one centred line, what is read before a thought starts to being whole, and the Composer to one metal key and one Start; `scripts/composer-check.cjs` types into the Composer with real keys against a core that answers late or refuses: no key refused or lost while a capture is on its way, a thought sent once, ⌘Z and a refusal bringing the words back, and the field measured only when its words or its width change, a line at a time, on Home, in the sheet and in the notch (`scripts/flow-check.cjs` fails on a refused key as well); `scripts/voice-check.cjs` runs the real recorder in headless Chromium against a microphone that is a file; `ui/src/way.test.ts` and `ui/src/speech/pcm.test.ts` prove the mapping from records to what is shown and the bytes of the conversion; `host/scripts/smoke.sh` drives all of it in the real app against the real core, its fixture router and a speech service of its own on this machine, with a tone made in the page in place of a microphone.

**Alternatives that were drawn and not chosen** (pictures only): the terms as a switch in Settings that allows at the flick (it allows before it is read, and cannot be offered where a thought is); the brief beside the words in two columns (the eye zig-zags, and the notch has no room for two); the candidates as the Composer's list of places (a second kind of question beside the one card); the recording as a full overlay with a large waveform (it hides where the thought goes and has no place in a reply); the speech service set up inline in Settings rows (two ways of allowing something, and nothing to return to from the notch).

## 10. What the core now says, links, and a session's details (2026-11-18)

Where this section and an earlier one differ, this one is how it is built.

**How a thought came by its place** is the core's own word for it (`Thought.placed`), and the pages no longer work it out from who is named in its route or from what they sent themselves. "Placed by Claude Code · haiku" and "Placed by name" stand only where a model or the match on names placed it. Where the person decided (a pick, a follow-up to the session they were in, an answer to "Where should this go?") the line says at most who wrote the brief: "Brief by Claude Code · haiku". For later says why from the four reasons: "You saved it for later", "You kept it for later", "It named no folder", "Claude Code found no folder for it". The mapping is `way.ts` `placed` and `laterWhy`, proven in `way.test.ts`.

**The choices of "Where should this go?"** are shown as what the question says they are (`Question.places`): a folder by its mark and name; a session by its state mark, its own name, and its agent and folder after it. Nothing is guessed from a label.

**The agents' rings choose for one thought.** The seated ring is the agent of the thought being written: the default (the core's `agent` preference) until a click seats another, for this thought only; once it is sent the seat is the default's again. A follow-up shows its session's agent alone, with no choice. The default is changed in one place, the Agents sheet (Default, Make default). A thought the core refuses, for its agent or anything else, says why under the field in the core's sentence, and its words, its place and its agent are back in the field.

**Speak, then edit.** While a new thought is spoken the listening line says what letting go does and names one more key: **E, Edit first**. It ends the recording there and then as its words, in the field, with nothing captured or placed. It is a key and a button, so it is seen and can be clicked; it is not on the way of letting go, so it cannot be hit by accident. In the notch and the capture sheet the thought's own line says "Listening", beside the wave that follows the voice, and the row keeps the time and the keys.

**The Composer's row where it is narrow** (the notch, the capture sheet, Home in a narrow window) is two lines, so nothing in it is squeezed or cut: where the thought goes and the key that sends it; under them the rings, the seated one by name, and the microphone with its key. The Composer's word for placing by a model is **Tasktap decides** (it was "Where it belongs"). An agent with no mark of its own shows two letters, so agents whose names begin alike are told apart.

**Links in terminals.** A web address, a path that exists (taken from the folder the terminal is in; with `:line` and `:line:column`) and a hyperlink a program prints itself are links while ⌘ is held, as in Mac terminals: underlined under the pointer, ⌘-click opens, ⇧⌘-click shows a file in Finder. A plain click is always the program's. Where a link's text is not what it opens (a relative path, a program's hyperlink) the real target stands at the terminal's foot while it is pointed at. A file of text opens in the default text editor, at its start: the system's way of opening carries no line. Anything that is not text, and any folder, is shown in Finder. The rule is the host's (`host/src/open.rs`): only web addresses, and only what exists inside a folder the person opened or a copy Tasktap made of one; nothing is ever run.

**A session's details** (⌘I; a tab's and a sidebar row's menu; I on a row of Home) are one sheet to read: its agent and state, the folder or the copy it runs in with what became of the copy's changes, what can be done (Open its terminal ↩, Follow up F, Review changes R, Stop ⌘⌫), then its turns, newest first. A turn is the thought that began it in the person's words, the brief if one was written, how it came by its place, and under it, in their order and with their times, what was asked and how that was answered, and what came back. One set of columns for every line: the time, the mark, the words. Turns that left the live set are read from the core's history.

**A terminal open in as many places as the core allows** says so in the pane where one more view would open, in the core's words, with Try again.

**Drawn and not chosen** (pictures only): ending a spoken thought as words by holding ⇧ while letting go (a chord at the moment of release is not seen and cannot be clicked); the link's target as a label at the pointer (it floats over the terminal's text); a session's history as one flat list of events, newest first (a turn's thought, its question and its result no longer read as one thing, and the order runs against reading).

## 11. Settings, the sheets and the keys, as one family (2026-11-18)

The owner, of Settings: "It does not need its animation with glyphs, and its structure is poor, and it's not even centred due to the sidebar." Of the other sheets: "surfaces which act like a notch, but on the actual application screen … I want those to be done properly as well." Of the keys: "Some buttons which show actions with Command plus something are unreadable due to size." Where this section and an earlier one differ, this one is how it is built.

**One frame for every sheet** (`sheets.tsx` `Frame`). Sixteen sheets had grown one at a time: four widths, two kinds of head, the way out sometimes a word in the head and sometimes a row at the foot, the actions a column of key caps in one and a row of buttons in another. Now:

| Size | Width | For | Sheets |
| --- | --- | --- | --- |
| A quick decision | 480 px | One question, answered with a key | Close a tab, Stop, Close a workspace, Keep and Discard, Move, Send to a folder, a reply, Find, New task |
| A form or a list | 640 px | Something to fill in or to read before agreeing | Open a folder, placing by a model, a speech service, a session's details |
| A view to read | 900 px | A place with parts, or code | Settings, Review changes |

- **Layout.** The lit seam; the title at the left (it wraps, it is never cut); the body, which is the only part that scrolls and dissolves at the edge there is more beyond, with a hairline under the title while it is scrolled; the foot. A sheet is as tall as what it holds, up to the window less 40 px.
- **The foot.** The way out (Esc: "Cancel" where something is given up, "Not now" where No is an answer, "Close" otherwise) and the answer are at the right, the answer last. The answer Return gives is the one metal key in view. A destructive choice (⌘⌫, in the failure colour) is never Return's; beside another answer it stands at the left, alone it is the answer. Anything else is at the left. Where the foot has no room for one line the answer goes under the rest, at the right.
- **Answers that are a list** (where to move a tab, where to send a thought, an agent's choices) are rows of the body, one key each; the foot then holds only the way out and what is beside the list (Open a folder…).
- **The Composer in a sheet** (New task) is the one sheet with no title and no foot: its body is the Composer, the same on Home and in the notch, with its own key.
- **Where it hangs.** From the title bar's lower edge, which runs the whole width of the window while a sheet hangs, sidebar included. **Centred on the window**, whatever the sidebar does: a sheet belongs to the window. (Before, the wide sheets were centred on the content area: 112 px right of the window's centre with the sidebar open, and they jumped by that much when it closed. The narrow ones were already on the window's centre, so two sheets in a row stood in two places.) `scripts/align-check.cjs` measures every size at 720, 1180, 1480 and 1800 px with the sidebar open, closed, and over every frame of its slide.
- **How it comes.** A short drop from behind the bar, 14 px, as it and the dimming fade in, in 160 ms; one that replaces another is there at once; it goes at once. **No sheet sheds glyphs.** The rule: a wake lies only where there are no words. The sidebar's lies at its foot, under its rows; a sheet is all words, so it comes down plainly. (`wake.ts` is the sidebar's alone now.)
- **Behind it** the window is dimmed by half, title bar and sidebar too, and the ambient layer rests: with a sheet open nothing behind it moves, though agents work.
- **The keyboard.** Return is the metal key; ⌘⌫ the destructive choice; Esc the way out, as is a click on the dimmed window, and ⌘W. The keyboard lands on the first thing a person would use (a field, the first answer, Settings' open section), else on the sheet, whose keys then act. Tab stays inside. Put away, a sheet gives the keyboard back to what had it, unless what put it away sends it elsewhere (a terminal, the Composer).

**Settings is one sheet with its sections at its left**, one shown at a time, the sheet of one height whichever is shown: as tall as the window allows, up to 720 px (Appearance, the tallest section that must not scroll, is 705), and a longer section (About) scrolls inside it and dissolves at its foot. (It was as tall as the section, so its lower edge jumped by up to 700 px from one section to the next; `scripts/align-check.cjs` now goes through every section at four sizes of window and holds the sheet's box still.) Three containers were drawn on the same fixtures: a single scrolling column with a section index (2000 px of scroll; the index only moves you about in it), a view of its own in the content area (two lists of places side by side, nothing of the work left in sight, no meaning for Esc), and this. The sections are what a person comes to do, the most frequent and consequential first:

| Section | Key | Rows |
| --- | --- | --- |
| Thoughts | ⌘1 | A sent thought starts (`hold`). Placing: by name or by a model, with what it is sent behind one button (`route_by`). Return in a thought: sends it, or starts a new line (`return_sends`). From any app: the capture key, recorded (`capture_key`). Finished thoughts are kept: for ever, 30 days, 90 days, a year (`keep_days`) |
| Voice | ⌘2 | Where speech becomes text: on this Mac (what its model needs, how far its download is, ready, failed, Remove) or by a service (`speech_by`), the service's key (`keys`), the languages (`speech_languages`). Hold to talk: its key, recorded (`talk_key`) |
| Agents | ⌘3 | Each agent: its ring, version, sign-in, Sign in, and which is the default (`agent`). Before, a sheet of its own behind a second button in the rail |
| Appearance | ⌘4 | Text size: small, default, large (`text_size`). Then the form itself, live; Form, Colour with its hue, Lumen, Effects, and the trial with the voice. The controls are the frozen ones, unchanged; only their place is new |
| Terminal | ⌘5 | Font, Size, Line height. Bold text in bright colours (`terminal_bold_bright`). Keep text readable (`terminal_contrast`) |
| About | ⌘6 | The version. What leaves this Mac, line by line, each with the way to the section that decides it. What is kept on this Mac. The licences of the bundled fonts and of what turns speech into text on this Mac, their words behind one line |

One row component for every setting and for the forms that ask before something leaves the Mac (`form.tsx` `Row`): the question at the left, the answer readable at a glance at the right, and under it what the choice means only where that matters. Settings opens where it was last, or at the section a link asks for (the Composer's ring, the microphone, the notch: `settings:voice`, `settings:agents`). In the list the arrows move; ⌘1 to ⌘6 reach a section from anywhere in the sheet.

**Settings the core lacks.** Five were left out at first because the core had no preference for them, rather than shown dead. The core has them now (core design §5, "Settings"), and each is a row where a person looks for it:

- **What Return does** (Thoughts): Sends it, or Starts a new line, with the other key said under it in words (Shift-Return; Command-Return). The Composer follows at once, on Home, in the capture sheet and in the notch: its key shows ⌘ before the Return arrow when Command-Return sends.
- **The capture key** (Thoughts, "From any app") and **the hold-to-talk key** (Voice) are one recorder (`form.tsx` `Recorder`): the key in use on a cap, in a Mac's order; a click, Return or Space listens, and the next combination pressed is tried. Whoever keeps the key says whether it may be one, in their own sentence under the key, and the key that was in use stays: the host for the capture key (`host.capture_key`: the rule of a shortcut, then the system, which may say another app holds it), the core for the talk key (a plain preference, held to the same rule). Escape stops listening and changes nothing, as does leaving the control. A key of the person's own has "Use the default" beside it. The capture key shown is the one the system registered: where the stored one was refused at start, the row says so, and that the one shown, or none, is in use. Every hint that names the talk key reads the preference. A key is named as the US keyboard prints it; the page does not know the keyboard's layout.
- **How long finished thoughts are kept** (Thoughts): For ever, 30 days, 90 days, A year; any other number the core holds is shown as one more choice. Under a number: "Applies from the next start, or within a day. Nothing that waits for you is ever removed."
- **A terminal's colours** stay Default's. The two places Default changes what a program painted are two switches (Terminal), taken by every open terminal at once.
- **Text size** (Appearance, above the form: it is how the app looks, and it is not the form's): one number, `--ts` in the token file (.92, 1, 1.15), by which every role's size and line height is multiplied and rounded to whole pixels; the key cap's height and the Composer's most lines follow it. The key is the one role with a floor (2026-11-19): at the small size, .92 made every key 11 px, under the 12 px the role promises, so no size sets a key or its cap under 12 px on 18, and a hint a row then has no room for is dropped, as everywhere, never shrunk. `scripts/type-check.cjs` measures every key, on a cap and as a hint, in both pages at all three sizes. A terminal keeps its own size. `scripts/text-sizes.sh` runs the align, type and composer checks at the three sizes and at 720, 1180 and 1800 px.

What remains without a preference: a terminal theme other than Default; the keys of the workspace's own commands; the choice of 30, 90 or 365 days as the only numbers offered (the core takes any from 1 to 3650). A notices file for the libraries the app is built from is not bundled; About names them, and shows the words of the two licences that are.

**One key, one role** (`ui.tsx` `Key`). Keys were shown in three ways (a metal cap in the monospace face at 11 px bold; a hint inside a button in the monospace face at 11 px, at 62 % on metal; "esc" as a dim word), and ⌘, ⌥, ⇧ and ⌫ at 11 px in that face were a few pixels of loops. Both faces were set side by side at 11, 12 and 13 px, at one pixel to a point and at two: the system face draws the modifiers larger and clearer at the same size, as the menus of a Mac do. So:

- The `key` role is the system face, 12 px, 500, on an 18 px line: for the cap and the hint alike, and nothing is set in it but keys. Nothing shows a key smaller. Digits are tabular, so a column of keys is one column.
- **A cap** (metal) is the key that answers: beside its answer, before the label. **A hint** is the key of a button that is clicked as often as pressed: after the label, at one distance, in the secondary colour (4.5 : 1 or better on what is behind it; on a metal key, the ink at 70 %).
- **A hint never shrinks and never squeezes its label.** Where a row has no room for both the hint goes (it wraps out of the button and is cut off there) and stays in the tooltip and the menu.
- Modifiers stand in a Mac's order, ⌃⌥⇧⌘, then the key; the component orders them, so it cannot be written otherwise.
- `scripts/align-check.cjs` holds every key in both pages, in every fixture state, to the role's size and weight, to 4.5 : 1, to the order, and to being whole; `scripts/type-check.cjs` holds the role to keys and keys to the role.

## 12. Previews beside a terminal (2026-11-18)

What an agent made or serves is seen beside its session instead of in another app: it says "open http://localhost:5173", or writes a picture, a PDF, a report or its notes, and the person looks to the right.

**What a ⌘-click does now** (a rule a person can tell before clicking, by the link's own text):

| The link is | ⌘-click | ⌥⌘-click (the other of the two) | ⇧⌘-click |
| --- | --- | --- | --- |
| A web address of this machine (`localhost`, `127.…`, `[::1]`) | Shown beside the terminal | The browser | The browser |
| Any other web address | The browser | The browser (the core shows none) | The browser |
| A file named `.png .jpg .jpeg .gif .webp .svg .pdf .html .htm .md .markdown` | Shown beside the terminal | The editor if it is text, else Finder | Finder |
| Any other file | The editor if it is text, else Finder, as before | Shown beside the terminal (text as text) | Finder |

A link inside a Markdown preview follows the same rule with a plain click, from the folder its file is in. What the core will not show (a file that is not there, one outside the folders the person opened, the ninth beside one terminal) is said in its own sentence in a strip under the terminal, with "Open It Instead" and "Dismiss". An agent opens one itself with `tasktap preview <file or address>` in its terminal: it appears beside that terminal, nothing is selected and the keyboard stays where it was, also in focus mode.

**Where it lives.** A preview is a tab like a terminal's, and the layout places it (`layout.ts` `beside`): the first beside a pane of terminals splits that pane and takes its right half; every later one of the terminals in that pane is a tab of the same preview pane, the newest in front. **Tabs, not a pane each**: the core allows eight beside one terminal, and eight panes beside one terminal at 1180 px are 60 px each; one pane of previews beside one pane of terminals is also what the eye pairs. Its tab carries an eye, or, opened by an agent, the agent's own mark (a terminal's mark where no agent's session is in it); its close button and ⌘W close it for good (`delete {c: previews}`). A tab drags like any other. Under the tabs one line says what is shown (opened by whom; the path, cut at its start, or the address; a picture's size) and holds what can be done: Real Size or Fit for a picture, Reload ⌘R, and the one place it also opens: Open in Browser, Open in Editor, Show in Finder. That line is one line, as the tabs over it are, however narrow the pane (it wrapped onto two and three lines before 2026-11-19): who opened it and the path shorten with an ellipsis, and the actions that do not fit go on past its edge, which they dissolve at, as tabs do, the hint going first; under 480 px who opened it is left to the tab's mark and tooltip, under 360 px a picture's size too. `scripts/align-check.cjs` holds it to one line at every width. A terminal sent to the background takes its previews out of the layout and brings them back with it.

**How each kind is drawn**, with what an agent wrote treated as not the app's:

| Kind | Drawn by | Why it is safe |
| --- | --- | --- |
| Picture (PNG, JPEG, GIF, WebP) and drawing (SVG) | The page, as an image from the bytes `file.read` gave: fitted, real size on a click | An image runs nothing and loads nothing, an SVG included |
| Markdown | The page, from plain data (`markdown.ts`, about 110 lines, no dependency) into the type roles: a title in `question`, headings in `title` and `label`, the rest `text`, code in `code` | No markup is ever made from the file: raw HTML in it is the words it is |
| Text | The page, as it is, in `code` | Text |
| A page (HTML), a local web address | A frame, sandboxed (scripts and forms; no way to the window around it, no new windows) | The frame's address is never the app's: a file comes from the host's own server on this machine, an address is loaded as it is. The host answers no command from any address but the app's, blocks every load that is not this machine's, and stops every navigation elsewhere (`host/src/frames.rs`) |
| PDF | The web view's own viewer, in a frame from the host's server | Chosen over "show it in Preview.app": the point is not to leave. WebKit draws no PDF in a sandboxed frame (tried with each of the sandbox's permissions), so this one frame has no sandbox; it is held by the host's three rules like every frame, and the host's server calls a file a PDF by its first bytes, so that frame is never handed a page |
| Anything else | Not shown: "A file of this kind is not shown here", with Show in Finder | |

Text and Markdown are drawn up to 256 KiB (the core cuts text at 2 MiB); where either cut it, the foot says "It goes on: only its beginning is shown here" with Open in Editor. A frame that tries to leave this machine is stopped by the host, and the pane says where it wanted to go, with Open in Browser and Dismiss: nothing is opened by itself.

**A page in a frame, on the dark ground** (2026-11-19). Until its page is there (the frame's load, or 2.5 s at most, for a page that loads something for ever) a frame shows the pane's dark ground; then the page, on the white a page without a ground of its own is given. Before, the frame was that white from the first moment, a white flash each time a page opened or reloaded. Its scrollers show no bar, as nothing in the app does: the host gives every frame a style for that as it starts (`frames.rs` `BARS`, on both systems). A page's own document is not the app's, so that style stands in a layer every rule of the page outranks, and where it cannot reach the bar stays: a page that sets `scrollbar-width` itself, one that draws a bar of its own, and a PDF, which the web view's own viewer draws. `scripts/frame-check.cjs` holds both in headless Chromium; `host/scripts/smoke.sh` reads in the app that WebKit takes the style.

**Staying current, with nothing running.** A preview asks whether its file changed (`file.read` with the stamp it has: one `stat` in the core) when its terminal has printed something and been quiet for 400 ms, when the window comes back into use, and on Reload. A local address nothing answers at says so, is asked again at the same moments (one attempt to connect, by the host), and is shown once its server answers; a page that is shown is reloaded only by Reload, since its own server keeps it current.

**Keys**, in the View menu: ⌘P moves the keyboard from a terminal to the preview beside it and back; ⌘R reloads the preview in front, or the one beside the terminal in use; ⌘W closes it.

**Drawn and not chosen:** a pane for every preview (above); the preview as a strip under its terminal (a page or a picture wants height, and the strip is the question's and the result's); selecting the preview's pane when the person opens one (they clicked in a terminal they are typing in; the pointer scrolls a preview without the keyboard).

