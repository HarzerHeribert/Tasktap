# Trial checklist

What the owner found when he first tried the build with the project map (2026-11-19), and what follows from it. A box is ticked only when the fix is merged, its check passes, and it was seen in a rendered picture or the built app. The last column says what proved it.

## What the owner said

| # | Done | Finding | Decided fix | Proof |
| --- | --- | --- | --- | --- |
| 1 | [ ] | The first start shows a long paragraph nobody reads | A short sheet: a headline, at most three facts, the full sentence behind "What exactly is read" | |
| 2 | [ ] | It can be clicked away, or allowed, without reading | The sheet takes no key for its first 600 ms, and nothing typed into the Composer can land on Allow. No reading timer (Claude's advice; the owner may overrule) | |
| 3 | [ ] | "Open another folder…" does nothing | Find the cause and fix it | |
| 4 | [ ] | The Composer's lower row is "a bit wild" | Four things in a fixed order: folder, agent, microphone, Start | |
| 5 | [ ] | The Return sign on the Start key is white on white | The sign in the key's own dark ink | |
| 6 | [ ] | Pressing 1 at "Where should this go?" types a 1 into the field | The question for a thought just sent is asked at the Composer and holds the keyboard | |
| 7 | [ ] | It is not clear that the question needs him | The question sits where he just typed, in the colour of "needs you" | |
| 8 | [ ] | The agents' rings with "+3" | One agent control that opens a list in the app's own style | |
| 9 | [ ] | The Start key turns black | On Home the Composer's key is always the bright key | |
| 10 | [x] | Placing by a model should be chosen by the app: the cheapest that works, and one with quota left | Tasktap proposes the order among his agents: included in a subscription first, then the fastest | core test of the default order; `scripts/placing-check.cjs`; picture placing-proposed |
| 11 | [x] | He wants to rank them 1, 2, 3 | A ranked list he can reorder, each agent on or off | `scripts/placing-check.cjs` (move by keys and drag, switches, saved on Return); smoke |
| 12 | [ ] | Offers and tips appear loose under the Composer | One place for them, "Setup", on Home | |

## What follows from it

| # | Done | Consequence | Proof |
| --- | --- | --- | --- |
| 13 | [ ] | Under the Composer is only for the thought just sent: where it went with Undo, or its question. No pile of sentences | |
| 14 | [ ] | A key is shown only where pressing it works right now, on Home and in the notch | |
| 15 | [ ] | The question's choices stand one under another and are never cut off at the window's edge | |
| 16 | [ ] | A waiting question is in one place only: at the Composer, or in Needs you, never both | |
| 17 | [ ] | "Found n projects" and its list are shown in the setup sheet, not loose on Home | |
| 18 | [ ] | Setup can be hidden and found again | |
| 19 | [x] | If the first agent cannot place (signed out, out of quota, no answer), the next is asked; if none can, Tasktap asks him. The thought says who placed it | core tests: the next agent places, none can so the person is asked, a limit skips an agent until its time, the 8 s budget |
| 20 | [x] | An agreement given to the old wording is asked again | store test (old agreement read as a list of one and refused), `placing-check` "Agree again"; the Setup row for it is still open with item 12 |
| 21 | [ ] | The notch's capture row follows the same rules (agent control, keys, the bright key) | |
| 22 | [ ] | The same on Windows: the key's ink, the keys' names | |
| 23 | [ ] | Each finding has a check that would have caught it | |
| 24 | [ ] | An independent review of both pieces before the owner sees them | |
| 25 | [ ] | A new review build, and the owner tries his six pictures again | |

## Closing terminals (owner, same evening)

| # | Done | Finding | Decided fix | Proof |
| --- | --- | --- | --- | --- |
| 26 | [x] | Closing an empty shell asks "Close zsh?" | A shell with nothing running in it closes at once. Tasktap asks only when a program or an agent is running there | core tests on real terminals (`core/tests/terminals.rs`), `scripts/closing-check.cjs`, smoke; the Windows path is built but not yet run there |
| 27 | [x] | Panels in the sidebar have no close button | Every session and terminal row in the sidebar has one | `scripts/closing-check.cjs` at 1x and 2x with a real pointer and Tab; pictures sidebar-rest, -hover, -focus |
| 28 | [x] | (follows) The same rule wherever a terminal is closed: its key, its tab, the sidebar, closing a workspace | `scripts/closing-check.cjs` and four smoke steps: one function closes everywhere, a workspace asks once |
| 29 | [x] | (follows) A session that has ended closes without a question | core test `when_any_agent_ends_its_terminal_is_a_usable_shell_again` |
| 30 | [x] | After `/exit` in Codex the shell's prompt does not come back; after Claude Code it does | Find the cause and fix it; when any agent ends, its terminal is a usable shell again | the same core test: after the agent ends a command is typed and its output read; a signed-in Codex run by the owner is still to confirm it |
| 31 | [x] | (follows) The same proved for every agent Tasktap starts, with a stand-in that ends as each tool does | the same core test for each agent's way of ending; Pi and Qwen Code by approximation |

## Settings' words (owner, same evening)

| # | Done | Finding | Decided fix | Proof |
| --- | --- | --- | --- | --- |
| 32 | [ ] | "From any app" does not say what it sets; Settings in general do not say what a setting does for the person | Every setting has a label that can be read by itself and one sentence saying what changes for the person | |
| 33 | [ ] | (follows) The same words in the guide's Settings chapter and wherever a sheet or Setup names a setting | | |

Decisions for 32 and 33 (Claude, 2026-11-19; applied once Home and the placing list are merged). A worker listed all 46 rows with proposed words; the rules: a label reads alone and names what the person decides, one sentence says what changes for them, options complete the label's sentence, a problem is said with what to do.

- Take the proposal's words, with the app's own phrase where there is one: "Key to put a thought in, from any app"; "Finding the project for a thought" (no "Placing:" in front); "Wait before an agent starts a thought" (No wait, 3, 5, 10 seconds; "at least", since placing can take longer); "Key to hold while you talk"; "Delete finished thoughts after" (Never, 30 days, 90 days, A year; says that the terminal's history goes too); "Where your speech becomes text".
- Appearance keeps its words: the owner froze that section. Only its "Microphone" row, which reads like the real microphone setting, is the owner's to rename.
- Words that say something the app does not do are corrected first: About says nothing else is sent, but a released build asks GitHub for a new version; the placing row says only thoughts naming no folder are read by the model, but long ones that name their project are read too, for their summary; "each agent is asked when you look here" is true only of agents never asked before; hold to talk says letting go ends it, where in an empty field it sends the thought, and the key works only while Tasktap is in front.
- Order: Thoughts, Agents, Projects, Voice, Appearance, Terminal, About; the capture key first in Thoughts; finding the project moves to Projects.

| # | Done | Missing settings a person would look for (proposed by Claude, each needs the owner's yes) |
| --- | --- | --- |
| P2 | [ ] | Open Tasktap when the computer starts |
| P3 | [ ] | Per project: the agent works on its own copy, or in the project itself (exists in the core, shown nowhere) |
| P4 | [ ] | The keys that answer a question from any app can be recorded (also ends the AltGr clash on German Windows keyboards) |
| P5 | [ ] | Look for new versions: on or off |
| later | | Which microphone; which display shows the notch; a switch for the one notification |
| P6 | [ ] | The owner's idea: "Sign in with ChatGPT", so that finding the project is one direct call on the person's own subscription, with no agent's program started. Researched 2026-11-19 (a worker's reading of OpenAI's pages, not yet tried): it is an official preview, open to open-source apps that run on the person's own machine without an application; the app registers itself, the person signs in in the browser, and calls go to the Responses endpoint on their plan. Unknown until tried: how fast it is, whether a small model is offered, whether a fixed answer format works, what a call costs of the plan. Borrowing Codex's own sign-in is not the official way and is not used. Anthropic and Google do not allow the equivalent; GitHub Copilot has a kit for it. Next: a trial outside the product that measures those unknowns on the owner's own sign-in; then decide whether it becomes a row in the ranked list |

## Graphics cost (owner, same evening)

| # | Done | Finding | Decided fix | Proof |
| --- | --- | --- | --- | --- |
| 34 | [ ] | What the app costs the graphics processor was never measured; only the main processor, memory and wake-ups were | Measure it in every state (at rest, agents working, listening, the sidebar moving, effects Off, Still and Full) with the window on screen, on the Mac and on the Windows tower, and set a limit for each | |
| 35 | [ ] | (follows) At rest the figure is zero, and a check keeps it so | At rest with Tasktap not in front, or with no caret, exactly zero; with the caret in Home's field, at most 0.01 % (its blink, which stays while the person is in the field with Tasktap in front; when Tasktap is not in front nothing blinks). The host knows a minimised window is not in front (edge.rs), so nothing draws unseen | `scripts/winvm/gpu.sh --rest` asserts exactly that, in front with the caret and without, behind another program, and minimised |

## Layout (owner, same evening)

| # | Done | Finding | Decided fix | Proof |
| --- | --- | --- | --- | --- |
| 36 | [ ] | In full screen the content is not in the centre. Should it move with the sidebar, or stay centred whether the sidebar is open or closed? | Being researched: measured on the app, compared with how well-made apps do it, three alternatives rendered; then decided | |
| 37 | [ ] | (the owner asked) Other practices of interface designers that would lift the app | A ranked list of findings on this app, each with a picture, from the same research | |

## Proposed by Claude

| # | Done | Proposal | The owner's answer |
| --- | --- | --- | --- |
| P1 | [x] | When one project clearly leads (its name nearly said and a second word of its own matching, the others matching one common word), start there with Undo instead of asking. The owner's trial thought about a "claude mod" for the "modpack" was such a case | Yes, if it is accurate: "it has not been too great, but if you can get it to greatness then why not". It ships only if a set of thoughts the builder never saw, written and scored by the reviewer, and the owner's own projects show no thought started in a wrong project; otherwise Tasktap keeps asking. Result: as first built it failed the reviewer's gate (thoughts about a tool started in the project named after it); narrowed to a whole name nearly said, it starts nothing wrongly in either of the reviewer's sets or on the owner's projects. Both sets are in `core/scripts/place-eval.json`, and `place-eval.sh` fails if a thought that means no project is ever started this way |
