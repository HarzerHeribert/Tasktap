# Placing on the person's own ChatGPT plan: a trial

**Tasktap has it now (2026-11-21).** The app signs in with ChatGPT and places a task by one direct call as this trial does, as one more row of "Finding the project for a task": `core/src/chatgpt.rs`, and `docs/core-design.md` §8 ("ChatGPT, on the person's own plan"). This folder stays as the trial that decided it.

The question: can Tasktap's placing call (the thought and up to 8 likely projects in; a destination, or "unsure", and a brief out) be one direct call on the person's own ChatGPT plan, through OpenAI's "Sign in with ChatGPT", instead of starting their coding tool headless? This folder answers it on the 14 made-up thoughts the app's placing was proved on. Nothing in the app changes.

## The two commands

From the repository's folder, with Node 22 (nothing to install):

```
node trials/siwc/signin.mjs
node trials/siwc/measure.mjs
```

### 1. `signin.mjs`, once

**What you see.** Your browser opens on OpenAI's sign-in page (auth.openai.com). You sign in, choose the workspace, and approve an app called "Tasktap trial" (you may rename it there) and its use of your ChatGPT plan. The browser then lands on a page this command serves on your own computer (127.0.0.1), saying you can close the tab. The terminal says whether plan use was granted. If no browser opens, the terminal shows the address to open; after 5 minutes without an answer it gives up.

**What it sends to OpenAI.** The app's name, "Tasktap trial". A random number made once that stands for this computer (the "host id", `urn:uuid:…`; nothing in it comes from you or the machine). The permissions it asks for: who you are (`openid profile email`), staying signed in (`offline_access`), using your plan (`resource.invoke chatgpt.tokens.use.direct`). One-time check values. After you approve, the one-time code goes back to OpenAI for the sign-in, and OpenAI's public signing keys are fetched to check that the answer really comes from OpenAI and from this attempt.

**What it stores, and where.** One file, `~/.config/tasktap-test/siwc.json`, outside the repository, readable by your user only (mode 600), written whole or not at all. It holds the sign-in (an access token good for an hour, a refresh token good for 30 days, the ID token), the client id OpenAI issued to the app, the host id, OpenAI's opaque id for your account, and when it was saved. Not your email (only inside the ID token, as OpenAI sends it). Nothing of it is ever printed.

If the folder `~/.config/tasktap-test` is open to others (mode 755 rather than 700), other users of the computer can see which files are in it, though not read the record; the command then says so, and `chmod 700 ~/.config/tasktap-test` closes it.

`--dry-run` shows the address it would open, part by part; it opens, sends and stores nothing.

### 2. `measure.mjs`, as often as you like

**What happens.** It renews the sign-in if it has less than 10 minutes left, and writes the renewed one back into the same file (OpenAI replaces the refresh token at every renewal). It asks OpenAI which models your account is offered and prints what the list says of each. It takes the two or three whose names say small or cheap, and asks each to place the 14 thoughts of `core/scripts/route-eval.json`, one call at a time, as the app asks Claude Code or Codex today. A minute or two.

**What it sends.** Per thought: the app's instructions (`core/src/route/instructions.md`, as committed), and the evaluation's made-up state: the thought, five made-up projects (tasktap, folio, ledgerly, dotfiles, kiln), four sessions and three recent exchanges. Nothing of your own projects, files or settings. The question is exactly the app's (the tests compare all 14 with what the app sends); only where the instructions go differs, since this endpoint takes them in a field of their own instead of a system message.

**How much.** At most 60 requests in all; about 45 in a normal run (the model list, 14 per model, a retry or two while it learns what the endpoint accepts). It counts against your plan like any use of it; on Plus the five-hour limit is shared with every app that uses your plan (Pro has none). It stops at the first "limit reached" (429) or "not allowed" (403), and at a refused sign-in (401) or OpenAI being down (5xx), and says which.

**What it writes.** `results.md` (the table) and `results.json` (every call: outcome, brief, title, times, tokens, headers), in this folder. Neither is committed (`.gitignore`), and neither holds a token, an account id or an email.

**Options.** `--list-only`: only the model list, one request. `--models a,b`: choose the models. `--effort minimal`: another reasoning effort than `low` (the one the app asks Codex for); `--effort default` sends none. `--refresh`: renew the sign-in now, to see renewal work against OpenAI. `--question NAME`: show what one thought would send, sending nothing.

### Reading the table

- **Right**: as the evaluation wants it. **Wrong**: placed somewhere else, or asked between the wrong projects. **Unsure**: asked you, or kept it for later, where it should have placed it; nothing went to a wrong place. **Refused**: an answer the app would not take (it would then place by names).
- **Every fact** and **Nothing invented** judge the brief as the evaluation does.
- **First byte**: when the answer started to arrive; **whole answer**: when it was complete. Today's numbers to compare with: Claude Code 3.7 s, Codex 4.7 s, Antigravity 5.6 s (medians), each 14 of 14 right.
- **Answer format**: whether OpenAI accepted the fixed JSON format the app asks for. Below the table: every header that came, and those whose names speak of usage, limits, credits or cost.

## Ending it

1. `node trials/siwc/signin.mjs --forget` asks OpenAI to end the sign-in and deletes `~/.config/tasktap-test/siwc.json`. (Deleting the file yourself also works: `rm ~/.config/tasktap-test/siwc.json`.)
2. The app stays registered in your ChatGPT account until you remove it there: ChatGPT, Settings, Usage (https://chatgpt.com/settings/usage), which OpenAI names as the place where each app's access to your plan is managed. Remove "Tasktap trial". OpenAI's pages do not name the button.

If the file ever leaked, disconnecting the app there is what makes it useless (OpenAI's advice).

## If it became real in the app

- **Who may.** OpenAI offers plan use to open-source and locally run apps without an application; paid or hosted apps fill in an interest form. Tasktap is both open source and local. OpenAI's cookbook names Plus and Pro as the plans that can use it.
- **Where the sign-in lives.** In the system's secret store, where the core already keeps keys (Keychain on the Mac, Credential Manager on Windows), not in a file; one per ChatGPT account the person connects; with a host id made once per installation and kept for good, even through signing out. Only the core touches it. It renews the access token near its hourly end, one renewal at a time, and stores the replacement refresh token at once (an old one is refused if used again). After 30 days unused, the person signs in again.
- **Consent.** The consent screen would name OpenAI, with the person's ChatGPT sign-in, as where the thought goes. What is sent stays what it is today.
- **Model.** Chosen from the account's list when it is asked, never written into the app (names age: the app already has `gpt-6-luna` written in for Codex).
- **The words OpenAI's interface rules ask for** (https://developers.openai.com/siwc/ui-ux-guidelines):
  - the button that starts it: **Continue with ChatGPT**, in OpenAI's approved button formats;
  - offering it in settings: **Use your ChatGPT plan**, with "Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance.";
  - once, after the first sign-in: **You're using your ChatGPT plan**, "Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.", and **Got it**;
  - while it is in use: **Using ChatGPT plan** near where the model is chosen, with **Manage usage** opening https://chatgpt.com/settings/usage;
  - when a limit is reached: **Usage limit reached**, "Review your plan or this app's limit in ChatGPT settings.", with **Manage usage** as the main action.
- **When the cap is hit** (HTTP 429 `subscription_sharing_usage_limit_exceeded`, which can also arrive in the middle of an answer): stop asking the plan, show the limit message above, and place by names as the app does without a model, asking the person when unsure. Never guess when it resets (OpenAI says not to), and never switch to another way of paying. Other refusals: 403 not eligible: say so, do not retry; 401: check the sign-in, and ask to sign in again only when a renewal confirms it is gone; 503: try later. OpenAI does not tell the app when the person disconnects it; the next refused renewal does.

## What only your run can tell

- Whether the sign-in completes, what ChatGPT shows, and whether plan use is granted.
- Which models your account is offered, and what the list says of each.
- Whether the fixed answer format and the reasoning effort are accepted (the table says either way).
- Right, wrong, unsure, the times and the tokens.
- Whether any header or field tells what a call cost of the plan.
- Renewal against OpenAI itself: only when the token has under 10 minutes left, or with `--refresh`.

## What was checked without your sign-in

`node --test trials/siwc/test.mjs` (22 tests, about a second; nothing reaches OpenAI) checks: the PKCE values (RFC 7636's own example) and the address's every part; the listener on 127.0.0.1 taking only its own attempt's answer and giving up in time; the whole sign-in, a second sign-in, declining, and `--forget` against a local stand-in for OpenAI (`standin.mjs`) that refuses a wrong parameter; the ID token's checks (signature, issuer, client, expiry, nonce); renewal, the replacement refresh token written back with mode 600, and the old one refused; the stream reader on OpenAI's documented events (`fixtures/`), whole, cut byte by byte, with other line ends and cut short; the stop at the first 429, 403 or limit inside an answer; a refused answer format dropped and said; the limit of 60 requests; no token, id or email in anything printed or written; and the question and judgement against the app's own (`route.rs`, and `core/scripts/route-eval.sh --question` for all 14 thoughts once `cargo build --example route-eval` has run in `core/`).

## Sources

OpenAI's pages, read on 2026-11-19; the code is written from them, and nothing of OpenAI's sample kit is copied. It never uses Codex's sign-in or its files, and never calls chatgpt.com.

- https://developers.openai.com/siwc/token-sharing-open-source (who may, the host id)
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in (the address, the callback, the exchange, the record)
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions (renewal, signing out, usage)
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference (the model list, the call, the stream)
- https://developers.openai.com/siwc/token-sharing-open-source/token-reference (lifetimes, rotation)
- https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery (the codes and what to do)
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations (the fields the endpoint refuses)
- https://developers.openai.com/siwc/ui-ux-guidelines (the words)
- https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt (plans, availability)
- https://auth.openai.com/.well-known/openid-configuration (signing keys, the revocation address)
- https://developers.openai.com/api/reference/resources/responses/streaming-events (the events in `fixtures/`)
