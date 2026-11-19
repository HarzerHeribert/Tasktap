# Tasktap

Tasktap is a Mac app for working with coding agents: Claude Code and Codex first, and with them Antigravity, Copilot, Pi, OpenCode, Qwen Code, Goose, Crush, Droid and Aider, eleven in all, and any command-line agent you add yourself. Put a thought in: Tasktap works out where it belongs, starts the work, and comes back only when it needs you or has a result. Its main record is the thought (what was said, where it went, what is running, what it asked, what came back); a terminal is where a thought happens to be running.

That is the idea this code is built to. What works today, and what is deliberately missing, is listed in [host/README.md](host/README.md).

**This branch is the rebuild.** The released Tasktap 1.2 is a different program (a Swift shell, web pages and a Python service). It is not in this tree: it lives on `main` until the cutover is merged, and at the tag `v1.2.0` afterwards. Nothing here reads, imports or stays compatible with 1.2's data. The app built here is called "Tasktap Next" for now, with its own identifier (`io.github.harzerheribert.tasktap.next`) and its own data folder (`~/Library/Application Support/Tasktap Next`), so it can run beside an installed 1.2 without touching it.

## The three parts

| Folder | What it is |
| --- | --- |
| [`core/`](core/README.md) | One Rust service, `tasktap`, that owns everything that is not pixels: the data (SQLite), every terminal process, the agents, questions and answers, routing. It serves one data folder on a private local socket (a named pipe on Windows) and keeps running when the windows close. |
| `ui/` | The interface, in strict TypeScript with Preact and Vite: two pages, the notch and the workspace, on one shared client for the core. It holds no durable data; its types come from `core/proto/protocol.ts`, which the core generates. |
| [`host/`](host/README.md) | The Mac host, Tauri v2: the workspace window, the notch panel, the menu, the global shortcuts. It bundles the core and the built pages, starts the core on demand, and gives each page a pass-through channel to it. |

The host is the only part tied to the Mac. The core is tested on Linux, macOS and Windows; a Windows host is planned and not built.

## Build, test and run

Needs Rust (stable), Node 22 and macOS 13 or later.

    # The core: format, lint, tests against the real service
    (cd core && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test --workspace)

    # The interface: types and tests
    (cd ui && npm ci && npm run check)

    # The app: builds the pages, the core and the host
    host/scripts/build.sh
    open "host/target/release/bundle/macos/Tasktap Next.app"      # or: host/scripts/build.sh --open

    # The host: format, lint and the notch geometry tests (after a build, which makes what it embeds)
    (cd host && cargo fmt --check && cargo clippy -- -D warnings && cargo test)

    # The headless browser the page checks use (once)
    npm ci && npx playwright install chromium

    # The pages on fixture records, with no app: every list keeps its columns
    node scripts/align-check.cjs

    # The real app on a fixture agent, in a temporary data folder: PASS or FAIL per promise
    host/scripts/smoke.sh

Quit an installed Tasktap 1.2 before opening the app: its notch sits in the same place and uses the same shortcuts. `smoke.sh` runs the app passive (no window takes the keyboard, nothing shows in the Dock), so it is safe to run while you work. It needs a desktop session and expects your shell to be zsh, the Mac's default. CI runs all of the above on every push except `open`.

More, each described at the top of its file: `host/scripts/measure.sh` (idle cost, launch, typing delay), `core/scripts/measure.sh`, `core/scripts/live-agents.sh` and `core/scripts/route-eval.sh` (the real agents, on your own accounts; never part of CI), and under `scripts/` the page renderers `motion-pages.cjs`, `instrument-shots.cjs`, `light-sheet.cjs` and `motion-fidelity.cjs`.

## Where things are decided

- [docs/rebuild-plan.md](docs/rebuild-plan.md): why the rebuild, what was decided and cut, the phases and their state.
- [docs/core-design.md](docs/core-design.md): the specification of the core and its protocol.
- [docs/rebuild-inventory.md](docs/rebuild-inventory.md): what 1.2 did, as the design cites it. History, not a guide.
- [design/ui-directions/](design/ui-directions/NOTES.md): the chosen look, Instrument, with its mock-ups, tokens and build brief. [design/motion-lab/](design/motion-lab/NOTES.md): the lab the live motion came from.
- [trials/tauri-notch/RESULT.md](trials/tauri-notch/RESULT.md): the trial that decided on one host.

## The public site

`site/` is the product page and a short guide at <https://harzerheribert.github.io/Tasktap/>, in the app's own look, published from `main` only. What it takes from the app is in `site/app/` and is committed: the notch page that plays at its top, the motion engine, the token file and the pictures, all made by `node scripts/render-site.cjs` on a Mac after `(cd ui && npm run build)`. `python3 scripts/build-site.py` assembles the site into `build/pages/` and refuses anything incomplete or private, and `node scripts/verify-pages.cjs` exercises the result. That build script is the only Python left; the app needs none.

## License

Tasktap is source-available under Apache License 2.0 with the Commons Clause. Use, modification, and free redistribution are permitted under those terms; selling Tasktap or a service whose value comes substantially from it requires separate permission. Third-party tools retain their own terms. [Full license](LICENSE)

The terminal's typefaces ship with the app under their own licences, in `ui/public/licenses/`.
