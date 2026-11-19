# How Tasktap knows a person's projects

A design (2026-11-19); stages 1 and 2 are built, as the section "Built" at the end says, which with the owner's decisions above it overrides what the design proposed. It answers one question of the owner's: how does Tasktap come to know which folders are a person's projects, so that a thought can find where it belongs without each folder being opened by hand first. The pictures are on a private page for the owner; the experiments were run on invented names and generated folders, never on anyone's real ones.

## Summary

Tasktap keeps **a map of the person's projects, on their machine and nowhere else**: for each project a small **card** (what it is called and how it is said, a line about what it is, how alive it is, what the person has sent there). The person names the folders they keep projects in, once ("Where are your projects?"); Tasktap looks directly inside those, reads a short fixed list of files of each project, and keeps the result. A thought is then placed on the machine first: by a name as written or as a speech recogniser writes it, with no model at all. Where the words only describe the work, the cards give a short list for one question, or, with the person's agreement, the few best cards go to their own agent's small model, never the map.

- **A card is not a workspace.** It gives Tasktap no right to read, show or open anything. A project becomes a workspace, in the sidebar and with those rights, when a thought starts there.
- **Measured on 300 invented projects:** every thought that names its project, typed or as spoken ("queue grid" for `cuegrid`), was placed right on the machine (38 of 38, none wrong, 0.2 ms each). Today's matching places 15 of those 38 right and 3 wrong.
- **Nothing runs when idle.** One `stat` of each named folder when a thought is sent or the list is opened tells whether to look again. 300 projects are listed in 1.5 ms and their cards made in 26 ms once the disk's caches are warm.
- **The Composer's folder chip is part of the problem** and has defects that can be fixed at once (below, "What is there today").
- **Smallest version worth shipping:** the defect fixes, the folders to look in, cards from names and package files, placing by names as said, the visible list in Settings.

## What is there today

A project exists only when the person opens its folder (`project.add`; "Open a folder…", ⌘O). The router sees the open projects only (`core/src/route.rs`, `request`), matches a name as whole words (`mentions`), and a model is given at most 8 projects by name. A new person has nothing, and a thought that names no open folder is saved for later.

**Defects found while reading the Composer (owner: "it has been hard to actually choose a folder for a workspace; it defaulted to scratch"). Each can be fixed without this design.**

| # | Where | What happens | Proof |
| --- | --- | --- | --- |
| 1 | `ui/src/workspace/main.tsx:54`, `ui/src/capture.tsx` `destination` | `cap.usual`, "the folder the person was in", is set when ⌘N is pressed in a workspace and is never cleared: on Home the old value is kept. It outranks everything but a pick. So after one ⌘N in any workspace, Scratch included (Scratch is a workspace while something runs in it, and an agent started by hand in a loose shell is adopted into Scratch, `core/src/state.rs` `adopt`), every later thought on Home defaults there. A pick lasts one thought by design, so the chip "goes back" each time. | Rendered on the unchanged build: the chip says "Scratch". |
| 2 | `ui/src/capture.tsx` `destination` | The next fallback is the folder of the newest thought, of any open project: also Scratch. In the notch, which never sets `usual`, this is the default. So one thought that reached Scratch (by defect 5, or typed in an agent adopted there) makes Scratch the default of the next, and so on. | Read. |
| 3 | `ui/src/capture.tsx` (the list shows `kind === 'folder'` only) | When the chip says Scratch the list has no Scratch and no row is marked, so the person cannot see what is chosen or why. | Rendered. |
| 4 | the same list | One wrapped row of names by alphabet. No search, no order by use, no folder that is not already open. Twelve folders are three rows. It is reached by Tab and then an arrow; there is no key from the field. | Rendered. |
| 5 | `core/src/route.rs` `request` (filter: `open && available`) | Scratch is offered to both routers as a project called "Scratch". The name match then sends "start from scratch on the landing page" to it as a clear route. | `route::local` run on those candidates: both thoughts with the word in them were placed in Scratch. |
| 6 | `core/src/route.rs` `local` | With `tidepool` and `tidepool-mobile` both open, "tidepool mobile drains the battery" is a clear route to `tidepool`: the shorter name is a whole word of the thought and the longer is not. | 3 of 8 such thoughts placed wrong, at every list size. |

Fixes: clear `usual` when the Composer is not opened from a workspace (1); never default to Scratch and never to "the newest thought's folder" without saying so (2, 3); leave Scratch out of the router's candidates (5); the longest name wins (6). The list (4) is replaced by this design.

## Words

One word per thing, everywhere. Nothing says scanning, indexing or profile.

| Word | Is | Said as |
| --- | --- | --- |
| folder | A folder on the disk. | "Open another folder…" |
| project | A folder Tasktap knows as a place where work happens. | "53 projects", "Find a project" |
| workspace | A project that is open in Tasktap: in the sidebar, with terminals and sessions. As today. | "Workspaces" |
| looks in | What Tasktap does with a folder the person named. No noun: the row is the folder's path. | "Tasktap looks in ~/projects" |
| card | Design word only, for what Tasktap knows of one project. The interface needs no noun: a project's row opens to show it. | – |
| the map | Design word only, for all cards. In the interface it is "Projects". | Settings › Projects |
| place | Stays the verb for a thought ("Placed by name"). Never a noun for a folder: `Question.places` and "placing" already mean where a thought goes. | "Placed by name: you said “queue grid”" |

On Windows: "this PC" for "this Mac", `C:\Users\…\source\repos`, Ctrl for ⌘. Nothing else differs.

## The model

Three kinds of folder, kept apart. The starting view held; the change is that "known" is not a quiet workspace but a record of its own.

| Kind | Record | In the sidebar | May be read, shown, opened | Can be placed into |
| --- | --- | --- | --- | --- |
| Workspace | `projects` row, as today, and its card | yes | yes (`rules::inside`) | yes |
| Known project | a card only | no | **no** | yes: it becomes a workspace when the thought starts |
| Everything else | none | – | no | by "Open another folder…" only |

**Why a record of its own, not a flag on `projects`.** Every `projects` row is a root of `rules::inside`, a candidate of the router and a row of the sidebar. A flag would have to be checked in each of those places, and one miss gives a folder the person never opened the rights of one they did. A card is additive: nothing that reads `projects` changes.

**Records.**

| Record | Fields | Notes |
| --- | --- | --- |
| `looks` | `id`, `folder` (canonical, unique), `any` (count every folder in it, not only marked ones), `listed` (when), `stamp` (the modified time of the folder and of its group folders), `state` (ok, gone, none, many), `count` | A folder the person named. Never one Tasktap chose. |
| `cards` | `id`, `folder` (canonical, unique), `file` (the volume and file number of the folder), `look_id` or none, `project_id` or none, `name`, `names` (the package file's name; names the person gave), `about`, `about_from`, `kind`, `languages`, `marks`, `branch`, `changed`, `worked`, `sent`, `terms` (at most 24 words learned from use), `hidden`, `stamp` | About 390 bytes each, measured. One card per folder, whether it came from a look, from "Open a folder…" or from an agent's list. |

**Rules, as rows the core could implement.**

| Case | Rule |
| --- | --- |
| What marks a project | A `.git` **folder**, or one of: `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `Package.swift`, `*.xcodeproj`, `*.sln`, `Gemfile`, `pom.xml`, `build.gradle`, `build.gradle.kts`, `composer.json`, `pubspec.yaml`, `deno.json`, `mix.exs`, `CMakeLists.txt`. A folder with neither is counted and not listed; "Count every folder in it" turns that off for one look (`any`). |
| How deep | Directly inside the named folder; and one level into a folder there that is not itself a project (`~/work/clients/acme`). Never deeper, never into a project. |
| Never listed | A name that begins with a dot; `node_modules`, `target`, `vendor`, `dist`, `build`; anything under Tasktap's data folder; a folder whose `.git` is a **file** (a linked worktree or a submodule: Tasktap's own copies under `<data>/worktrees` are these, and so are a person's own worktrees); when the named folder is the home folder, the system's own (`Library`, `Applications`, `Desktop`, `Documents`, `Downloads`, `Movies`, `Music`, `Pictures`, `Public`). |
| What may be named | A folder inside the person's home, or on another volume. `/`, `/Users`, a volume's root and another user's home are refused in a sentence. |
| Too many | More than 2,000 folders directly inside: the look is `many`, lists nothing, and says "Name the folder inside it that holds them". 5,000 cards in all. |
| Monorepo | The repository's root is the project. Its packages are not cards. (Later: the names of its members, from the package file, as extra names of the root's card.) |
| A repository inside a repository | Not found: nothing looks into a project. It can be opened by hand. |
| Symlink | An entry that is a link is followed once and its card is the real folder's, so a project reached twice is one card. Nothing is followed at the second level. |
| Another volume, a network drive | Allowed when named. Listed on a thread of its own with a limit of 2 s; a volume that is not local is looked at only when the person opens the list or presses "Look again", never at a capture. |
| A named folder that is gone | `state: gone`. Its cards are kept and marked not available; nothing is forgotten until the person removes the look. Zed does the same for a week; here there is no clock. |
| Renamed or moved | A card is found again by `file`, the folder's file number on its volume, which a rename or a move within the volume keeps (the Windows file id likewise). A known project follows silently and keeps what was learned. A **workspace** that moved is a question ("cuegrid is now at ~/work/cuegrid. Use it there?"), since sessions and the agents' own histories are kept by path. |
| The same repository cloned twice | Two cards with one name. Never placed by name alone: the person is asked, each shown with its parent folder. `.git/config` is never read to compare them: it can hold tokens. |
| Two different names, one inside the other | The longest name wins (`cuegrid-web` over `cuegrid`). |
| Removing a look | Its cards that are workspaces stay, as if opened by hand. The others go, with what was learned. The confirmation says how many of each. |

## What is read, what is kept, what is never read

The bounds are a table the core enforces in one function that takes no path from a page.

| | Read | At most |
| --- | --- | --- |
| The named folder | the names of its entries, and of the entries of its folders that are not projects | 2,000 entries |
| Per entry | whether `.git` or a package file exists (`stat`) | 17 names or patterns |
| Per project | the names at its top level (one listing, nothing opened) | – |
| | the package file: its name and description | first 8 KiB |
| | `README.md`, `README`, `readme.md`, `README.rst`, `README.txt`: the first heading and the first paragraph | first 2 KiB, 240 characters kept |
| | `.git/HEAD`: the branch | 256 bytes |
| | when `.git/logs/HEAD` and `.git/index` last changed (`stat`) | – |

Measured: 1.9 KiB read and 2.5 files opened per project. No `git` process: asking git costs 4.4 to 5.4 ms a repository, the `stat` 0.001 ms.

**Never read:** any source file or document; any file not named above; `.env`, keys, `.git/config`; anything outside the named folders; another user's files; a file's later bytes. **Kept:** the cards, in the core's database on the machine. **Sent:** nothing, unless the person agreed to placing by a model: then the cards of at most 8 projects (name, spoken names, the line about it), for that one thought (below).

**The sentence when Tasktap asks to look** (first run and Settings; as built, which also reads each repository's remote and asks Git for its first commit, see "Built"): "Tasktap reads the names of the folders in there and, of each project, the first lines of its README and its package file and its Git remote, and asks Git for its first commit. It keeps all of that on this Mac. Only if you let a model place your thoughts does that model get the name and one-line description of up to 8 likely projects. It opens nothing until a thought goes there."

**The row in About**, under "Kept on this Mac": "Your projects: for each, its folder, its name, a line about it and when it was last worked on. Settings › Projects shows all of it and forgets any of it."

**The agents' own lists** are a separate tick, off until the person turns it on: "Where your agents have worked. The folders Claude Code and Codex list on this Mac, and when. Never what was said in them." What that reads, from documentation only (nothing of the owner's was looked at):

| Agent | Read | Not read |
| --- | --- | --- |
| Claude Code | The names and modified times of the folders in `~/.claude/projects` (one per working folder; the name is the path with every character but letters and digits made `-`, so it is matched against the cards' own paths, or walked back with `stat`). No file is opened. | Transcripts, `history.jsonl` (every prompt), `~/.claude.json` (account details). Transcripts are removed after 30 days by default, so this knows about a month. |
| Codex | The keys of `[projects."<path>"]` in `~/.codex/config.toml` (documented), and for dates the first line of a session file (`session_meta`, which has `cwd` and no prompt). | The rest of each session, `history.jsonl`, the state database (its name changes with versions). |

The shapes are application data, not interfaces: each belongs in its agent's adapter, gives nothing when it does not parse, and Tasktap works without it (its own sessions say where work happened).

## Rights

**A card gives no right.** The roots of `rules::inside` stay exactly what they are: the folders of `projects` rows and Tasktap's copies. `file.read`, `preview.open` and `host.open` therefore refuse every path inside a known project, with today's sentence. A card is made by the one function above; no call takes a path and a card together.

A known project becomes a workspace, and its folder a root, at one of two moments: the person opens it, or a thought **starts** there (launch, not placing). Undo during the hold therefore leaves no project and no right behind. A test states the rule: a path inside a looked-in folder is `denied` before a thought starts there and readable after.

## Placing

**On the machine first.** Each row is decided in order; the first that applies wins.

| The capture | Who places | What happens |
| --- | --- | --- |
| The person chose a project in the Composer | nobody | As today. A known project opens at launch. |
| Made in a session, and names no other project | the match | A follow-up, as today. |
| Names one project: as written, with spaces and hyphens taken out ("ledger A P I"), or as it sounds ("queue grid", "pie right"); the longest name wins | the match, on the machine | Placed. `placed: name`, and `route.quote` holds the words that named it, so the notch can say "you said “queue grid”". |
| Names several equally, or one name that two projects have | the person | "Where should this go?" with those, each with its parent folder. |
| A name one letter off (a typo) | the person | A question with that project first. Never a start: "carrier" is one letter from `farrier`. |
| Names none; placing by a model is agreed | the model | It is given the 8 cards the machine ranks first (workspaces and known projects alike) and the sessions as today. Its answer passes `route::accept` unchanged. A list it asks with is cut to 4, in the machine's order. |
| Names none; no model; the cards' lines point clearly at one | the person | A question with that project first, so Return takes it. (Owner's decision 5: or place it.) |
| Names none; nothing points anywhere | the person | A question: the project of the last thought first, then the most recently alive, "Another project…", "Keep for later". |
| Not work for an agent | – | For later, as today. |

Scratch is never a candidate. The workspace in front and how recently a project was alive order a list; they never decide alone. One exception is visible before sending: a Composer opened inside a workspace says that workspace on its chip ("you are in it").

**The ranking** (the experiment's prototype, about 100 lines): every stretch of one to four words of the thought is compared with each name, as written, joined, and by a rough key of how it sounds; then the words of the thought are compared with each card's line, a rarer shared word counting more. 0.2 ms for one thought over 300 cards.

**What a model is given** changes from "the names and aliases of up to 8 of your open folders" to "of up to 8 of your projects, those ranked likeliest on this Mac: the name, the names you use for it and one line about it". Paths, branches, dates and learned words never go. `route.terms` shows this word for word before the person agrees, and a stored agreement to the old terms no longer covers it, as §8 of the core design already rules.

**Undo and Move.** During the hold the place is itself a control: "cuegrid · new here ⌄" opens the list and places the thought again without retyping. Undo takes the thought back; a project that was only going to be opened for it was never opened. After the start, "Move…" stops the run and starts the thought in another project; a workspace that was opened for that one thought and has nothing else closes again.

**Learning without creeping.**

| Learned | From | Kept | Undone |
| --- | --- | --- | --- |
| A name for a project | The person adds one in Settings ("Add a name for it…"). | In the card's `names`. | Removed there. |
| Words that mean a project | A thought that named nothing and that the person placed by hand, by answering, or by Move: its rarest words, at most 6, go to that card's `terms` (at most 24, the oldest out). A thought moved away takes its words back from the card it left. | In the card. Shown in Settings, "From you". | "Forget what you said about it"; "Forget all projects…". |
| How alive | When a thought last started there; the count of thoughts sent. | In the card. | With the card. |

Never kept in a card: the text of a thought (the thought is its own record, with its own retention), anything from a terminal or a file's contents, anything about the person's hours or habits. Never inferred: who the person works for, what a project is worth, anything from a folder that is not a project.

**Where the person puts things** (later stage). "Start a new project called X" proposes a place from what the looks already show: the named folder with the most recently created project, and the way names are written there. It is a proposal in a question, never a folder made unasked.

## Cost

Nothing runs when idle: no timer, no watcher.

| When | What runs | Measured (Apple M4 Pro) |
| --- | --- | --- |
| "Look there", "Look again", adding a look | The listing and every card, on a thread of its own | Below |
| A thought is sent; the list or Settings › Projects opens | One `stat` per look and per group folder. If a modified time changed, the look is listed again after the placing, not before: a capture is placed on what is kept. | 0.001 ms a look |
| The same, for the cards in view or ranked first (at most 8 at a capture; all in Settings) | Three `stat`s a card; a card whose files changed is made again | 0.96 ms for 300 |
| Otherwise | Nothing | – |

| Projects | Listing, cold / warm | Cards, cold / warm | Stored |
| --- | --- | --- | --- |
| 30 | 6.4 / 0.10 ms | 9.7 / 1.9 ms | 12 KB |
| 300 | 150 / 1.5 ms | 197 / 26 ms | 117 KB |
| 300 in ten group folders | 108 / 1.1 ms | 147 / 26 ms | 120 KB |
| 3,000 | 1,703 / 28 ms | 1,882 / 257 ms (127 ms on 8 threads) | 1.2 MB |

Generated folders on a disk image, cold meaning the image was detached and attached again; the warm figure for the cards of 3,000 is from the internal disk (985 ms on the image, an artifact of the image). Peak memory 4.9 MB at 3,000.

**How change is noticed.** Adding, removing or renaming a folder directly inside a named folder changes that folder's modified time (tested on APFS). A change inside a project does not, and need not. A project added inside a group folder changes the group's time only, so each group is one more `stat`. The price, as with previews: a project cloned while nothing is sent and no list is opened is unknown until the next of either, which is exactly when it is first needed.

## The interface

Pictures of every state, at one and two pixels to a point, are on the owner's page. In words:

**The first run.** Under the Composer, where "A thought starts in a folder" stands today: "Where are your projects?", with the common folders that exist ticked (`~/projects`, `~/code`, `~/Developer`, `~/src`; on Windows `source\repos`), each found with one `stat` and not looked into; "Where your agents have worked", not ticked; "Another folder…"; the sentence of what is read; "Look there" on Return and "Not now". After it, the same place shows the projects found, the most recently alive first, and says that none is open yet. "Open a folder…" stays as "Open another folder…".

**The chip** always says where the thought will go and why.

| State | Chip |
| --- | --- |
| Nothing typed, on Home or in the notch | "Tasktap decides · by its words" (or "· Claude Code reads it") |
| Composer opened in a workspace | "cuegrid · you are in it" |
| The thought names a project | "cuegrid · named in it" |
| … as speech writes it | "cuegrid · said as “queue grid”" |
| … one that is not open | "pyrite · said as “pie right” · not open yet" |
| It names two | "ledgerline or ledger-api · you will be asked which" |
| The person chose | "ledgerline · your choice · opens it" |
| For later | "For later · your choice" |
| No project is known | "No projects yet" |

Never Scratch, never an arbitrary first, never a folder the chip does not name. With exactly one project known, that project is the default and the chip says so.

**The list** opens from the chip, with ⌘K from the field, and replaces the row: a field to find a project (it narrows by name, by sound and by the line about it), "Tasktap decides", then **Open** (workspaces, most recent first), then **Not open yet** (five, most recent first, and "45 more. Type to find one."), then "Open another folder…" and "For later". Two projects with one name show their parent folders. Nothing found says so and offers "Open another folder…". In the notch the rows are one line each and three known projects are shown.

**The notch's line** for a thought on its way: "→ cuegrid · new here ⌄ … Undo"; once started: "Started in cuegrid · new here · Placed by name: you said “queue grid” … Move…".

**The question** is the existing router question: at most four projects, each with why it is there ("invoices, export · not open yet"), "Another project…" (O) and "Keep for later" (L).

**Settings › Projects**, a new section after Thoughts: "Tasktap looks in" (each folder with what it found and when, "Look again", "Remove", "Add a folder…", and the sentence of what is read); "Where your agents have worked" (a switch); the projects, with a field to find one, each row opening to its card (Folder, Called, About and which file said so, Kind, Last worked on, From you) with "Add a name for it…", "Not a project" and "Forget what you said about it"; "Forget all projects…".

**States that are not the happy one.** A named folder that is gone: "Not there now. Its 8 projects are kept for when it is back." Nothing found: "No project in it. A folder counts when it has Git or a package file in it." with "Count every folder in it". Too many: "4,120 folders in it: too many to be a folder of projects. Name the folder inside it that holds them."

## Calls and records the core would need

| Call | Does |
| --- | --- |
| `looks.suggest {}` | The common parent folders that exist, by `stat`. Reads nothing inside. |
| `look.add {id, folder, any?}` | Checks the folder may be named, lists it off the core's thread, writes the look and its cards. Idempotent by `id`, as `project.add`. |
| `look.again {id?}` | Lists one look, or every look whose stamp changed. |
| `delete {c: looks, id}` | Removes the look and its cards that are not workspaces. |
| `put {c: cards, id, patch}` | `names` and `hidden` only. |
| `card.forget {id?}` | Empties `terms` and the learned names of one card, or of all. |
| `route.hint` | Answers with a card as well as a project: `to: {card}`, and the words that named it. Still no model call per keystroke. |
| `thought.capture {card_id?}` | The person's choice of a known project. |
| `thought.move {id, to}` | After the start: stops, starts elsewhere, teaches the cards. |
| `agents.worked {on}` (later) | The agents' own lists, through each adapter. |

Collections `looks` and `cards` are live, so every page follows. `thoughts` gains `card_id`, filled when a thought is placed into a known project and replaced by `project_id` at launch. `prefs` gains `worked_from` (the agents whose lists may be read). Schema version +1; no import of anything.

## Experiments

All on invented names. The set: 300 projects (60 with a name, a line, a language and a kind as a package file or README would give them, a fifth of them with no line; 240 near-duplicates such as `-api`, `-docs`, `2`, `old-`), and 63 thoughts whose targets are among the first 30. The same thoughts were run against the first 30, the first 100 and all 300. The fixture is `core/scripts/place-eval.json`. The ranker's rules were adjusted once after a first pass on this same set, so its figures are in-sample and the set is small: they show what kind of thought works, not a rate to promise.

**Placing on the machine** (right / wrong / asked with the right one first / asked with it in the list / asked without it / kept), the same at 30, 100 and 300 unless given as three figures:

| Thoughts | Today (`route::local`) | Cards, on the machine |
| --- | --- | --- |
| 14 that name the project as typed | 14 right | 14 right |
| 16 that name it as speech writes it | 16 kept, none placed | 16 right |
| 8 whose name has near-duplicates | 1 right, **3 wrong**, 1 asked, 3 kept | 8 right |
| 16 that only describe the work | 16 kept | none placed; 10 asked with the right one first, 3 / 2 / 2 with it in the list, 1 / 3 / 3 asked without it, 2 / 1 / 1 kept |
| 3 that describe work in a project whose card says nothing | 3 kept | none placed |
| 6 that name and mean no project | 6 kept | none placed |

If a clear description were allowed to place by itself, 10 of the 16 would be placed right and none wrong on this set. The right card is among the first 8 of the ranking for 14 of 16 described thoughts at every size.

**Live placing calls: 18 made**, of 20 allowed, with the owner's Claude Code on `haiku`, through the core's own path (`checks::ask`, `route::accept`), on the hardest thoughts only. 3.0 to 5.2 s each; the two with 300 names took 5.8 and 7.2 s.

| Given to the model | Thoughts | Result |
| --- | --- | --- |
| 8 cards (name and line), the machine's first 8 | 5 that describe the work | 5 placed right |
| 24 cards | 1 whose project was 23rd on the machine | placed right |
| 8 names only, as today | the same 3 of those | 3 asked, with all 8 as choices |
| 8 or 24 cards | 3 whose project's card says nothing or was not among those given | 3 asked, none placed |
| 8 names, and 8 cards | "start from scratch on the landing page" (with a project called Scratch among them) and "fix the flaky test" | 4 asked, none placed |
| all 300 names | "pie right", "key cast" | 2 asked (the right one first), none placed |

Six placed, all right; none wrong; twelve asked. A model given names alone cannot place described work; with one line a card it can. A model given 300 names does not settle a misheard name; the machine's match does, in 0.2 ms.

**A small model for meaning, on the machine** (one trial; 16 described thoughts; right one first / among the first three, at 300 projects):

| | Described | Size | Per thought | Licence |
| --- | --- | --- | --- | --- |
| Words alone (this design) | 10 / 12 | nothing | 0.2 ms | – |
| all-MiniLM-L6-v2, 8-bit | 14 / 14 | 23 MB and a 16 to 35 MB runtime | 0.7 ms | Apache 2.0 |
| gte-small | 15 / 16 | 134 MB | 2 ms | MIT |
| potion-base-32M (no runtime) | 12 / 15 | 131 MB (about 32 MB as 8-bit, untested) | 0.05 ms | MIT |
| potion-multilingual-128M | 15 / 15 | 531 MB (about 147 MB as 8-bit) | 0.05 ms | MIT |
| Apple's own sentence embedding | 4 / 7 | nothing | 3 to 6 ms | – |

Three findings decide its use. It ranks, and cannot decide: in every model the scores of thoughts that mean no project lie inside the range of right answers ("make the build faster" lands on `kiln` with a wide lead), so no threshold separates "place it" from "ask". It is bad at names once near-duplicates exist (1 to 8 of 14 right at 300, by model), so it must never overrule a name. And German thoughts against English cards fail in every English model; only the multilingual one holds (9 of 16 first, 12 of 16 in three). Windows offers nothing on every PC, and Apple's is worse than words.

**Is placing with nothing leaving the machine reachable?** For every thought that names its project, yes, today, with no model. For a thought that only describes the work: on the machine it ends in one question with the right project usually first; with a local model the list gets better, not the certainty; the person's own agent with 8 cards placed every such thought right. So the honest claim is: "A thought that names its project is placed on your Mac. One that does not is asked about, or, if you agree, read by your own agent with the names and one line of the few likeliest projects." A local model is worth a later, optional download, mostly for German.

**Listing** is under "Cost".

## What others do

| Pattern | Who | Taken |
| --- | --- | --- |
| Recents only | VS Code, JetBrains, Zed | Nothing: it knows only what was opened, which is today's gap. Zed keeps a missing folder for a week instead of dropping it: taken, without the clock. |
| One by one | GitHub Desktop, T3 Code, Conductor, Claude's desktop app, Superset | "Open another folder…" stays. GitHub Desktop's "Can't find … Locate / Remove" for a missing repository: taken. |
| Named folders and a depth | VS Code's Project Manager (depth 4, a cache, ignored folders), VS Code git (depth 1), Raycast Git Repos (depth 3), Projectile (per-folder depth; marks are version control and package files), tmux-sessionizer (depth 1, any folder), GitKraken | **This design.** Every tool for people with many repositories does it. Depth 2 with "never into a project" is at the careful end. |
| Scan the disk | Tower, Sourcetree | Not taken: slow on a home folder by their own users' reports, and it reads where nobody pointed. |
| From use | Codex's app (projects from its CLI and extension appear by themselves), zoxide, Warp | The agents' lists, as a separate tick. |

No tool found places by a name as spoken, or keeps a line about each project to place by.

## Alternatives not chosen

| Alternative | Why not |
| --- | --- |
| A flat list the person ticks, after a scan | It needs the scan first, and a new clone never appears. |
| Known projects as rows of `projects` with a flag | Rights, router and sidebar would each need the flag checked (above). |
| An empty start, no suggestions | The suggestions cost one `stat` each and need no permission; without them the first minute is a folder dialog. |
| The agents' lists ticked by default | They are other programs' files. Asked separately, in its own words. |
| All names, or all cards, to the model | Slower than the hold (5.8 to 7.2 s at 300), it asked instead of placing, and it sends the map. |
| The system's own embeddings | Apple's are worse than words; Windows has none for every PC. |
| A watcher or a timer for new folders | Against "never polls"; one `stat` when it matters is enough. |
| A popover for the list | The list takes the Composer's row, as the choice does today; one pattern. |
| Placing on a description alone, on the machine | No wrong one in this set, but the set is small and a wrong start is the product's first risk. Left to the owner (decision 5). |

## Decisions for the owner

| # | Question | Suggested |
| --- | --- | --- |
| 1 | You said Tasktap should build its knowledge of your projects "locally". Read as: it is built and kept on the machine and never sent anywhere. Is that the meaning? | Yes. Only with your agreement to placing by a model do a few cards (name and one line) go, for one thought. |
| 2 | May Tasktap read the first lines of each project's README and package file, or only folder names? | Both. Without the line, described work cannot be placed or even listed well. |
| 3 | May it read the lists of folders Claude Code and Codex keep? | As its own tick, off until you turn it on. |
| 4 | A thought that names nothing, with no model: ask, or send it to the last project used? | Ask, with the last project first, so Return takes it. |
| 5 | A thought whose description clearly points at one project, with no model: start there, or ask with it first? | Ask for now; decide again on your real thoughts. |
| 6 | Inside a named folder, does a folder without Git or a package file count? | No; one button per folder says "Count every folder in it". |
| 7 | May Tasktap learn words from where you send things (at most 24 a project, shown, forgettable)? | Yes. |
| 8 | The section is called "Projects", and there is no word for "map" or "card" in the interface. | Yes. |
| 9 | A local model for meaning, as an optional download (23 to 150 MB)? | Not in the first version. |
| 10 | ⌘K opens the list from the field. | Yes. |
| 11 | Removing a folder from "looks in" forgets its projects that are not open. | Yes, said in the confirmation. |

## Build plan

Sizes: S about a day of one worker, M two to three days, L a week.

| Stage | What | Size | Depends on |
| --- | --- | --- | --- |
| 0 | The defects: `usual` no longer sticks; Scratch is never a default and never a router's candidate; the longest name wins. With tests. | S | – |
| 1 | `looks` and `cards`; listing and cards within the bounds; `look.add`, `look.again`, removal; the rights test; the first-run question; Settings › Projects (looks, list, card, hide, forget). | M | – |
| 2 | Placing on the machine by names as written and as said; a known project opens at launch; Undo; the chip's states, the list with ⌘K, "new here", the question's short list with reasons. The experiment becomes `core/scripts/place-eval.sh`. | M | 1 |
| 3 | A model is given the 8 best cards; `route.terms` and the instructions say so; a model's list is cut to 4. One evaluation pass (about 20 calls). | S | 2 |
| 4 | Move…; learning words from corrections; names by hand. | S | 2 |
| 5 | "Where your agents have worked", in each adapter. | S | 1, and the agents work under way |
| 6 | "A new project called X": where it would go. | S | 1 |
| 7 | A local model for meaning as an optional download. Only if real use shows the questions are too many. | M | 2 |

**Smallest version worth shipping: stages 0 to 2.** Stage 0 alone removes what the owner hit.

## Verify when reached

- macOS asks for permission when an app first reads Documents, Desktop, Downloads or a removable or network volume. A `stat` for a suggestion should not ask; a listing will. Confirm on a signed build, and word the look's row for a refusal.
- The file number as identity on Windows (the volume serial and file index) and on a network volume.
- The folder names in `~/.claude/projects` and Codex's `config.toml`, on the owner's agreement and his own machine, before stage 5 is built.
- Names in other scripts and languages: the sound key is English. German names matched as written and joined; "as it sounds" was not tried on German.
- The ranker on the owner's real project names, by him, before the thresholds are fixed.

## The owner's decisions, 2026-11-19

These override anything above that says otherwise.

- **The app does the housekeeping, not the person.** The map is what Tasktap knows; it is not a list to read. Normally no list is shown: the chip says where a thought goes and why.
- **The picker shows only what is in use** ("Tasktap decides", the folders open, "For later") and a field to find a project. Projects not open appear only as answers: to what is typed, or as two to four candidates when Tasktap asks. No "Not open yet" section, no "n more". A row of every folder, wrapped over several lines, is forbidden (today's chip list goes).
- **The question "Where should this go?" is right** when Tasktap is unsure: at most three candidates, "Another project…", "Keep for later". Tasktap never guesses to avoid asking.
- **"Where your agents have worked" is the preferred way in.** The folders Claude Code and Codex list, and when each was last used, are offered first at first run (asked once, since they are another tool's files; never what was said). The folders a person keeps projects in are derived from them and suggested, rather than asked for.
- **The central question is whether a folder is a project's root**, answered by evidence in this order: an agent was started there (the agents' lists, Tasktap's own history); it is the top of a Git repository (not a worktree, not a submodule, not Tasktap's own copy); it has a package file and no project above it. A folder with none of these is not a project until the person opens it. A folder inside a project is its own entry only when an agent was started there. The home folder, Desktop, Downloads and Documents are never projects by themselves.
- **The full list is in Settings › Projects only**, to see and correct what Tasktap knows; and once at first run, as the sign that looking worked.
- Open: the shapes of the agents' lists are from documentation; verify them on runs in a home of their own before building.

## Built: stages 1 and 2 (2026-11-19)

What follows is what the code does now. Where it differs from the design above, this section and the owner's decisions win.

### Done when (for the reviewer)

Each promise the build makes, and what proves it. "Test" names are in `core/tests/map.rs` unless another file is named; every check runs as the brief of this work says (`cargo test`, `npm run check`, `scripts/composer-check.cjs`, the align and type checks, `scripts/projects-shots.cjs --check`, `core/scripts/measure.sh`, `host/scripts/smoke.sh`). The review of 2026-11-19 found what is marked "since the review"; each of those has a test that failed before its fix and passes after.

| # | Promise | Proved by |
| --- | --- | --- |
| 1 | A project Tasktap knows gives no right: a file in it is refused (`denied`) until a thought starts there; Undo during the hold leaves no workspace and no right behind; once a thought starts there it is a workspace and its files read. A folder the person said is no project, or one not there when Tasktap last looked, is never opened (since the review). | `a_known_project_gives_no_right_until_a_thought_starts_there`, through a real core: `file.read` denied, placed, undone, denied, started, read. `a_name_the_person_gives_keeps_its_project_and_one_taken_away_stays_away` (a card hidden after a thought was picked for it: the start is refused, nothing opens). |
| 2 | The root rule: an agent's start, the top of a Git repository, a package file with no project above, an agent's files. A worktree, a submodule, and any folder inside either, count for their repository, also in an agent's hidden worktree folder; a bare repository with its worktrees beside it (`proj/.bare`, `proj/.git` naming it) and a git folder kept elsewhere (`--separate-git-dir`) leave the folder the repository's top (since the review). A folder inside a project only under it, a package inside a workspace of packages under the workspace. Home, Desktop, Documents, Downloads never by themselves; temporary folders, Tasktap's data, another tool's hidden folders and a build's output never. The same holds on other volumes (`/Volumes/<v>/…`, `/mnt/<v>/…`, `/media/<person>/<v>/…`, a Windows drive), a volume's root never (since the review). | `the_root_rule_says_which_folder_is_a_project` (a fixture home with each case, Desktop, Downloads and a repository in a temporary folder among them), `a_folder_in_a_worktree_a_submodule_or_a_bare_layout_counts_for_its_repository` (real `git worktree`, `git submodule`, `git clone --bare`, `git init --separate-git-dir`), `the_root_rule_holds_on_other_volumes`. |
| 3 | One repository is one project however many copies: known by its remote's address (no user, no password), else by its first commit; a clone of a folder on this machine, whose remote is that folder, joins the repository it was made from by their first commit, whether or not that one has a remote (since the review); two repositories that share a first commit and have different remotes stay two. The copy beside other projects is it, unless the person chose another; the others are shown under it and never offered. | `a_repository_is_one_project_whatever_its_copies` (real `git`, copies by `cp` and by `git clone` of a local folder, a project started from another's history with a remote of its own; Windows paths read as no remote); on the owner's machine, below. |
| 4 | Of an agent's history only the folder each session started in and when its file last changed are kept and returned, within fixed bounds; never what was said. Reading stops at the field it looks for: for Claude Code that can be past a session's first lines, which are then in the core's memory while the field is looked for (at most 128 KiB a file), and never kept. Codex: the first line only. A FIFO or a device under a session's name is never opened (since the review). | `an_agents_history_says_where_and_when_and_nothing_more_is_read` (a session's words are never returned; a folder named past 128 KiB is not found; Codex's second line is not read; no file past the count); `a_fifo_is_never_read_and_a_look_that_hangs_is_let_go`. |
| 5 | Schema 3 keeps every record of schema 2 and backs the file up first. | `a_schema_2_store_keeps_every_record_as_it_takes_the_map`; the store's migration tests (`tests/store.rs`). |
| 6 | A thought is placed by a name as written; the longest name wins; equal names ask. A name said only as it sounds ("pie right"), one a letter off, an everyday word that is a project's name ("app", "test", "notes", "docs"), or a name whose words are written apart with spaces and are all ordinary words of the language ("harbor master" for `harbormaster`, "snow line" for `snow-line`, "cue grid" for `cuegrid`) or are another project's name as well ("tidepool mobile", with `tidepool` there too) never places by itself unless it is used as a name: it is asked about, first among the choices (since the review; words written apart since the review's follow-up, the owner's rule that a question is better than a wrong place). A name written apart with a word made up for it ("tasktap api") places: no one says it by accident (the second follow-up). Ordinary words are those of the system's dictionary (on a Mac Webster's list and its word groups, else `/usr/share/dict/words`, or `TASKTAP_WORDS`), with a few newer ones; with none to read, every word counts as ordinary, so such a name asks. Words are used as a name after "in", "into", "to", "for", "from", "inside" or "at" (not "to" before a name that is also a verb, "remember to test", unless something is moved to it), before "project", "repo", "repository", "workspace" or "codebase", in backticks or quotes, in a path to the project or one that begins with it (`~/code/app`, `app/src/main.rs`; not `src/app/page.tsx`), written with what joins the name's parts (`harbormaster`, `snow-line`), or beside another project's name ("folio and app"). Letters said one by one ("ledger A P I") and numbers are no words of their own. Scratch is never a choice; with no name it asks, with at most three choices, never guessing; with no project known it is kept for later. | `tests/route.rs` (the table, the longest name, Scratch), `placing_finds_names_as_written_and_as_said_and_asks_when_unsure`, `a_name_said_only_as_it_sounds_or_an_everyday_word_is_asked_about` (with "the harbor master called…", "remember to test the export", "time to deploy…", "src/app/page.tsx…" and "the cuegrid web login…" asked; "in harbor master…", "the harbor master project…", `` `snow line` ``, `snow-line`, "move the fixtures to test", "app/src/…", "~/code/app…" and "the tasktap api login…" placed; with a fixed list of ordinary words), `core/scripts/place-eval.sh` (below, with two held-out sets). |
| 7 | With a model agreed to, it is given the 8 projects this Mac ranks likeliest with one line each, never the map; a consent to the earlier terms covers nothing and is asked again. A thought whose names only may be meant (as it sounds, a letter off, an everyday word, words written apart) goes to that model first, those projects first among the 8, and the person is asked only if the model is unsure too; the chip says the model decides (the second follow-up). | `tests/store.rs` `a_model_is_given_at_most_8_projects_8_sessions_and_3_exchanges`, `tests/route.rs` (consent, keys, `a_name_that_may_not_be_meant_goes_to_the_model_agreed_to_first_among_its_projects`), `core/proto/tests/wire.rs` (`terms`), `ui/src/way.test.ts`. |
| 8 | The chip's list shows only what is in use (Tasktap decides, the open folders, Scratch, For later) and a field to find any project. What is typed there finds the projects whose names it matches (the beginning, the beginnings of its parts, joined or split, anywhere in it, the line about it), by sound only when nothing else matches, and nothing when nothing matches: "No project by that name." With a thought already written, the list first shows only the places its own words name or describe, never one because it was worked on lately (since the review). A project not open appears only as such an answer; ⌘K opens the list; a known project picked is sent by its card and opens at its start. "The only folder open" is said only of the one folder the person opened, the only place there is, never of a project Tasktap only knows (since the review). | `a_field_finds_a_project_by_what_is_typed_and_a_thought_by_its_own_words` (a real core); `scripts/composer-check.cjs` (real pointer and keys, the list's field answered by the core's own code, `core/examples/find.rs`, at three text sizes by `scripts/text-sizes.sh`). |
| 9 | "Where should this go?" offers at most three projects, each with why, then Another project… (O, a field that finds as the list's does) and Keep for later (L); it shows where the shared rule says a waiting question shows (`asksHere`, `ui/src/page.ts`): the notch opens by itself only where the notch is where Tasktap is. | `tests/route.rs` (`notes`), `host/scripts/smoke.sh` (the question on Home and in the notch, its answers), the pictures (`scripts/placing-shots.cjs`). |
| 10 | Nothing runs when idle: no timer, no watcher. A look runs when asked (first run, Settings, a look switched on) and when a capture or the list finds what a look reads changed: one `stat` of each folder it watches and of the folders directly in it, compared with what that look saw when it last read, which is kept with it (`Look::stamp`), so a core that starts again does not look again for nothing; Codex is watched down to its newest day's folder (since the review). A look that has not ended in 30 s is let go: whoever waits is told, and the core idles out (since the review). The look it waited on is marked failed, "It did not answer in 30 s…", and is read again only when what it reads changes, or when the person asks once the thread waiting on it has ended; a capture's check of the stamps runs one at a time, so no more than one thread ever waits (the second follow-up). | `a_look_reads_again_only_when_what_it_reads_changed_also_after_the_core_starts_again` (a real core stopped and started again; a Codex session in a day's folder it already had); `a_fifo_is_never_read_and_a_look_that_hangs_is_let_go`; `core/scripts/measure.sh`: 0 idle wakeups. `map.rs` has no timer but the one a running look sets for itself. |
| 11 | The first run offers the agents' history first and says what is read in plain words (the first lines of each project's README and package file, its Git remote, Git asked for its first commit; and that a model, if allowed, gets the line of up to 8 likely projects); it shows every project found, most recent first, never "and N more"; Settings › Projects shows every project too and corrects all of it (since the review). Since the owner's first trial (design/ui-directions/NOTES.md §13) all of it is Setup's first step: a sheet that comes down by itself once, three facts with the full sentence behind "What exactly is read", and what was found in the same sheet, never on Home. | `scripts/projects-shots.cjs --check` (its `promises`: every project a row, nothing "more", nothing of it on Home, at most three facts and "What exactly is read", the sentences naming what is read; at three text sizes with `--sizes`), the align and type checks (Settings › Projects and Setup's sheets among their sections), `scripts/composer-check.cjs` (no key in its first 600 ms, never over a thought being typed), the pictures. |
| 12 | A look that cannot read (its folder gone, a volume unplugged, a failure) keeps its projects, marked not there, and they are there again with the same identity when it is back; a look removed or switched off while it reads keeps nothing it alone found, then or when that read ends (since the review). | `a_look_that_cannot_read_keeps_its_projects_and_one_taken_away_while_it_reads_keeps_none`. |
| 13 | A name the person gives a project keeps it as choosing it does; a name taken away from it stays away when a look finds it again in its package file (since the review). | `a_name_the_person_gives_keeps_its_project_and_one_taken_away_stays_away` (a real core). |
| 14 | The review copy (`host/scripts/build-review.sh`) has its own identity, data folder, core, socket, device key and key service (`Tasktap Review`); no notch, no global key until one is recorded; it never updates and never takes over another folder. | `host/src/keys.rs` `a_review_build_takes_no_key_until_one_is_chosen`; `update::configure` refuses for `REVIEW`; `takeover` acts only for a folder named "Tasktap"; `presence::System::this` has no notch for it. |

### What was built

**Core** (`core/src/map.rs`, records in `core/proto/src/records.rs`, schema 3 in `core/src/store.rs`).

- Records `looks` (an agent's history, or a folder to look in: `on`, `state`, `found`, `looked`, `note`, `stamp`) and `cards` (one per folder: `name`, `names` with `given` and `dropped`, `about` and `about_from`, `why` as evidence, `agents`, `repo`, `root`, `copy_of`, `inside`, `project_id`, `used`, `looks`, `hidden`, `main`, `available`). Schema 3 adds the two tables and touches nothing else. `thoughts` gain `card_id`; router questions gain `notes` (why each choice).
- Calls: `look.add`, `projects.offer` (by `stat` only), `projects.look`, `projects.find` (`thought`: for a whole thought, the places its words point at; else what is typed, by name); `put` and `delete` on `cards` (names, not a project, this copy) and `looks` (on, off, remove a folder).
- The agents' histories through one optional method of the agent trait, `Agent::history`, answered by Claude Code and Codex (`core/src/agents/claude.rs`, `codex.rs`). Claude Code: `<config>/projects/<folder>/`, the `cwd` of the newest of the newest three session files, read 16 KiB at a time up to 128 KiB until the field, dated by the file. `~/.claude.json` is not read (it holds the account). Codex: `<home>/sessions/<y>/<m>/<d>/`, newest first, the first line's `cwd` within 4 KiB, dated by the file; `config.toml` is not read. 5,000 files and 3 s per agent at most. Only regular files are opened, without waiting.
- The root rule follows a `.git` file to its repository (a worktree's `commondir`, a submodule's `.git/modules`), walking up from any folder in it; outside the home folder it holds below a volume's root.
- Identity: the remote from the repository's own `config` (8 KiB, `origin` else the first, no user or password, a local path or a drive's path counts as none), and for every repository `git rev-list --max-parents=0 HEAD` once per folder, kept on the card (`root`). Copies group by remote; one without a remote joins the one remote that shares its first commit; else by first commit. Git is run as the core runs it for worktrees (no hooks, no fsmonitor, its own environment).
- Places to look: directly inside and one level into a folder that is no project; 2,000 entries, else `many`. The usual names that exist, and folders that hold two projects or more, are suggested (`projects.offer`).
- A card's line: the package file's description (8 KiB), else the README's first paragraph past headings, badges and code (2 KiB), 240 characters.
- Refreshing: `projects.look` reads every look that is on; a capture and `projects.find` compare each look's `stamp` with the folders it watches, off the core's thread, and look again when one changed or never read. One look at a time, let go after 30 s; a look keeps the core from idling out until it ends or is let go.

**Placing** (`core/src/route.rs`, `core/src/route/names.rs`, `core/src/state.rs`).

- The request has every open workspace and every known project that is offered (not a copy, not inside another, not hidden, there), each with its names, line and when it was last worked on, and where the last thought went.
- Names: every stretch of one to five words against each name's parts, joined, and a rough English sound key (two words or more, not opening on a small word, of about the name's length); a single word one letter from a name of five letters or more is "near". Written or joined decides when used as a name; a sound alike, a near name, an everyday-word name, and a name whose words are written apart with spaces, all ordinary words or another project's name as well, are asked about, first among the choices, unless used as a name; with a model agreed to, the model is asked first. A name inside a longer one of another project is not said, unless the longer is said more weakly (a sound alike); a longer name said apart still takes the shorter inside it ("tidepool mobile" asks about `tidepool-mobile`, never places in `tidepool`). Underscores keep a word whole.
- Unsure: up to three choices: what its words name or describe (`route::likely`: rarer shared words count more), then where the last thought went, then the most recently worked on, then the workspaces newest first. `route.hint` says only what names decide, so the chip says "asks you if unsure" rather than three guesses.
- `Destination::Card`: a thought placed into a known project keeps `card_id` and no project until it starts; `launch` opens the card's folder as a workspace (or reopens an older row of it) and names it on the card; never a hidden card or one not there. "new here" follows the thought.
- A model: the 8 ranked likeliest, each with `about` (160 characters), never all; at most three choices taken from its list. `route.terms` says so; its version (`RouteBy::terms`, 2) must match a stored consent.

**Pages** (`ui/src/capture.tsx`, `ui/src/question.tsx`, `ui/src/workspace/projects.tsx`, `ui/src/workspace/home.tsx`).

- The chip: "cuegrid · said as “cue grid”" ("in cue grid …"), "harbormaster · said as “harbor master” · not open yet" ("… in harbor master"), "pyrite or kiln · you will be asked which" (only sounding like a name, or words written apart not used as a name), "harbormaster · your choice · opens it", "Tasktap decides · asks you if unsure", "No projects yet · saved for later", "cuegrid · the only folder open" (one folder opened, nothing else).
- The list: the field "Find a project" first (⌘K from the Composer's field), then the places a written thought's words point at (none when they point at none), Tasktap decides, the open folders most recently used first (six on Home, three in the notch and the sheet), Scratch, Open another folder…, For later. Typing in the field shows only what it finds, or "No project by that name."
- The question: 1 to 3 with why, O Another project… (a field: what is typed finds by name; with nothing typed, the places the thought's words point at), L Keep for later; on Home, a pane, a sheet and the notch alike.
- First run: Setup's first step (`ui/src/workspace/setup.tsx`, NOTES §13), a sheet: the agents' history first, in the words of #11; then every project found, in the same sheet. The question "Where should this go?" about a thought just sent is asked at the Composer itself. Settings › Projects: every project, drawn again only where one changed, so thousands stay quick.

**The review build** (`host/scripts/build-review.sh`): "Tasktap Review", its own bundle identifier, data folder (`~/Library/Application Support/Tasktap Review`), core, socket, device key and key service; no notch window and no global key until one is recorded in its own Settings; it never updates and never takes over another app's folder.

### The experiment, through the real code

`core/scripts/place-eval.sh` runs `core/scripts/place-eval.json` through `route::local` with every project a known one, at 36, 100 and 306 projects (figures that differ are given in that order). Six of the first 36 projects are named with everyday words (app, test, notes, docs, site, scripts).

| Thoughts | Right | Wrong | Asked, right one first | Asked, it among the choices | Asked without it | Kept | Right one in the 8 a model gets |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 14 that name the project as typed | 13 | 0 | 1 | 0 | 0 | 0 | 14 |
| 16 that name it as speech writes it | 4 | 0 | 12 | 0 | 0 | 0 | 16 |
| 8 that name one with near-duplicates | 4 | 0 | 4 | 0 | 0 | 0 | 8 |
| 16 that only describe the work | 0 | 0 | 10 / 8 / 8 | 3 / 4 / 4 | 3 / 4 / 4 | 0 | 13 |
| 3 in a project whose card says nothing | 0 | 0 | 0 | 0 | 3 | 0 | 1 |
| 6 that name and mean no project | 0 | 0 | 0 | 0 | 6 | 0 | 0 |
| 5 that use an everyday-word project's name as a name (held out) | 5 | 0 | 0 | 0 | 0 | 0 | 5 |
| 24 that mean no project, with an everyday name or a name's sound or words in them (held out) | 0 | 0 | 0 | 0 | 24 | 0 | 0 |
| 4 the review found placed wrongly (in-sample) | 1 | 0 | 0 | 0 | 3 | 0 | 1 |

3.1 / 4.2 / 5.6 ms a thought (the dictionary is read whenever a name is written apart: a few milliseconds, nothing kept). Nothing is placed wrongly. The first seven rows and the last are in-sample: the rules were changed on them (a sound alike may not knock out a written name; a name a letter off comes after a line that shares two words; since the review, a sound alike, an everyday word and words written apart, not used as a name, ask). The two held-out rows were written before the rules for everyday words and words written apart and not used to change them; after the follow-up, all 24 thoughts that mean no project are asked about, none placed (the 7 that were placed by two everyday words written apart, "harbor master", "snow line" and the like, and "the scripts folder", which the word "folder" no longer makes a name). What placing gave up for that: of the 38 named thoughts, 21 are placed and 17 asked with the right one first, none placed wrongly. The one typed name asked is "my dotfiles" (`dotfiles` is an everyday word, "my" no sign of a name); the 12 spoken ones asked are the 5 said only as they sound and 7 written apart without a sign of a name ("ledger line sends the reminder mails twice"); the 4 twins asked are names written apart ("tidepool mobile drains the battery"), each with the right one first. The right one is among the 8 a model gets for every named thought.

### On the owner's machine, in counts only

`core/examples/map-count.rs` reads as a look does and prints counts only (run read-only, 2026-11-19, after the review's fixes).

- The histories name 327 distinct folders: 61 are gone, 229 are home-like, hidden, temporary or Tasktap's (all copies of the one repository found 151 times were a benchmark tool's under a hidden folder of the home), 20 are temporary folders outside the home, 3 are inside a project, 12 are project tops, 2 have no mark.
- From the histories alone: 14 projects (11 from Claude Code, 8 from Codex), 9 by Git; worked on in the last 7 days 9, in 30 days 14. With the one folder suggested from them looked in too: 60 projects, 2 copies folded under them, 3 folders kept inside their project; known by remote 37, by first commit 15, without Git 8; 49 with a line about them. No clone of a local folder and no folder in a worktree on his machine changed these counts.
- Identity held: grouped by remote-else-first-commit, by first commit alone and by the first entry of `.git/logs/HEAD`, the repositories in the histories fall into the same 35 groups; no remote's copies disagree on their first commit, and no first commit is shared by two remotes. 1 repository had no commit.
- Placing over his 60 names, in the review's sentences (after its second follow-up; `map-count` reads the system's dictionary): "fix the login in <name>" 60 placed right; "<name>: fix the login" and "the <name> login is broken" 59 right and 1 asked with it first (`dotfiles`, an everyday word). Of the 35 names of several words said as separate words: "fix the login in <name>" 35 right; the other two sentences 22 right and 13 asked with it first, each, where every word is an ordinary word or another project's name is said too. None placed wrongly. 4 names are a word of another project's name; none is shared by two.
- Cost: a look of both histories and that folder took 440 to 800 ms the first time (git now asked for the first commit of every repository, 52) and 47 ms after, in a process of 3.7 MB footprint at its peak. The core: 0 idle wakeups, 3.1 MB, start 4.2 ms. Its release binary was 5,366,144 bytes on the branch this work began from and 5,944,000 with it (of the 537 KB more code: 124 KB the map, 96 KB placing, 98 KB serde for the new records and calls, the rest spread through the core); built as one unit of code generation optimised across crates (`core/Cargo.toml`, `codegen-units = 1`, `lto = "fat"`) it is 5,414,480 bytes, and `measure.sh` measures it as fast (start 4.2 ms, streams 1,144 and 1,125 MB/s against 1,159 and 1,089, keystrokes within the spread of runs). The limit is 6 MB.

### Not built (next steps)

GitHub and GitLab as looks (a `LookKind` word and a row of the table of kinds); learning words from corrections and Move… after the start; names by hand beyond Settings' "Add a name for it…"; "a new project called X"; a local model for meaning; reading `~/.claude.json` and Codex's `config.toml` (folders without dates); Cursor, OpenCode, Antigravity and Copilot histories (the trait method is there for them); a card's line for a folder found by looking only, dated by its Git activity.

### Questions that are the owner's

1. A folder an agent was started in that has no mark at all (2 on his machine) counts as a project by the evidence order. Keep it, or ask for a mark too?
2. Copies beside each other in one folder (`ledger`, `ledger-old`): the shorter path is the project until he chooses. Right default?
3. Every thought that names nothing is asked about when no model is agreed to. On his own thoughts, is that too often? (Keep for later is L.)
4. Decided (the review's follow-ups): a name written apart asks unless it is used as a name or has a word made up for it; so does "my dotfiles". Is "my" before a name a sign of one? It would place "clean up my notes about the migration" in `notes` too.
5. A thought already written whose words match the line about a project not open (its README's) lists that project among the list's first rows, with why. Keep it, or show only open folders until the person types or asks?
