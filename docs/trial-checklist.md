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
| 10 | [ ] | Placing by a model should be chosen by the app: the cheapest that works, and one with quota left | Tasktap proposes the order among his agents: included in a subscription first, then the fastest | |
| 11 | [ ] | He wants to rank them 1, 2, 3 | A ranked list he can reorder, each agent on or off | |
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
| 19 | [ ] | If the first agent cannot place (signed out, out of quota, no answer), the next is asked; if none can, Tasktap asks him. The thought says who placed it | |
| 20 | [ ] | An agreement given to the old wording is asked again | |
| 21 | [ ] | The notch's capture row follows the same rules (agent control, keys, the bright key) | |
| 22 | [ ] | The same on Windows: the key's ink, the keys' names | |
| 23 | [ ] | Each finding has a check that would have caught it | |
| 24 | [ ] | An independent review of both pieces before the owner sees them | |
| 25 | [ ] | A new review build, and the owner tries his six pictures again | |

## Closing terminals (owner, same evening)

| # | Done | Finding | Decided fix | Proof |
| --- | --- | --- | --- | --- |
| 26 | [ ] | Closing an empty shell asks "Close zsh?" | A shell with nothing running in it closes at once. Tasktap asks only when a program or an agent is running there | |
| 27 | [ ] | Panels in the sidebar have no close button | Every session and terminal row in the sidebar has one | |
| 28 | [ ] | (follows) The same rule wherever a terminal is closed: its key, its tab, the sidebar, closing a workspace | | |
| 29 | [ ] | (follows) A session that has ended closes without a question | | |
| 30 | [ ] | After `/exit` in Codex the shell's prompt does not come back; after Claude Code it does | Find the cause and fix it; when any agent ends, its terminal is a usable shell again | |
| 31 | [ ] | (follows) The same proved for every agent Tasktap starts, with a stand-in that ends as each tool does | | |

## Settings' words (owner, same evening)

| # | Done | Finding | Decided fix | Proof |
| --- | --- | --- | --- | --- |
| 32 | [ ] | "From any app" does not say what it sets; Settings in general do not say what a setting does for the person | Every setting has a label that can be read by itself and one sentence saying what changes for the person | |
| 33 | [ ] | (follows) The same words in the guide's Settings chapter and wherever a sheet or Setup names a setting | | |

## Graphics cost (owner, same evening)

| # | Done | Finding | Decided fix | Proof |
| --- | --- | --- | --- | --- |
| 34 | [ ] | What the app costs the graphics processor was never measured; only the main processor, memory and wake-ups were | Measure it in every state (at rest, agents working, listening, the sidebar moving, effects Off, Still and Full) with the window on screen, on the Mac and on the Windows tower, and set a limit for each | |
| 35 | [ ] | (follows) At rest the figure is zero, and a check keeps it so | | |

## Proposed by Claude

| # | Done | Proposal | The owner's answer |
| --- | --- | --- | --- |
| P1 | [ ] | When one project clearly leads (its name nearly said and a second word of its own matching, the others matching one common word), start there with Undo instead of asking. The owner's trial thought about a "claude mod" for the "modpack" was such a case | Yes, if it is accurate: "it has not been too great, but if you can get it to greatness then why not". It ships only if a set of thoughts the builder never saw, written and scored by the reviewer, and the owner's own projects show no thought started in a wrong project; otherwise Tasktap keeps asking |
