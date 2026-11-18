from pathlib import Path
import html

here = Path(__file__).resolve().parent
root = here.parents[2]

install_sh = html.escape((root / "site" / "install.sh").read_text())
raw_readme = html.escape((here / "README.mockup.md").read_text())

page = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tasktap 1.0 · Landing Page &amp; GitHub README Design Mockup</title>
  <link rel="icon" type="image/svg+xml" href="../../../site/assets/mark.svg">
  <link rel="stylesheet" href="mockup.css">
  <script defer src="mockup.js"></script>
</head>
<body>
  <header class="studio-bar" aria-label="Mockup Studio Controls">
    <div class="studio-title">
      <span class="studio-badge">Design Mockup</span>
      <span>Tasktap 1.0 · Live repo files untouched</span>
    </div>

    <div class="studio-tabs" role="tablist" aria-label="Mockup surfaces">
      <button type="button" role="tab" data-view-btn="landing" aria-selected="true">01 · Landing Page</button>
      <button type="button" role="tab" data-view-btn="github" aria-selected="false">02 · GitHub README</button>
      <button type="button" role="tab" data-view-btn="audit" aria-selected="false">03 · What Changed &amp; AI Art</button>
    </div>

    <div class="viewport-pills" aria-label="Preview viewport width">
      <button type="button" data-vp-btn="full" aria-pressed="true">Full</button>
      <button type="button" data-vp-btn="1440" aria-pressed="false">1440px</button>
      <button type="button" data-vp-btn="820" aria-pressed="false">820px</button>
      <button type="button" data-vp-btn="390" aria-pressed="false">390px</button>
    </div>
  </header>

  <div class="viewport-frame" id="viewport-frame" data-vp="full">
    <!-- ==================== VIEW 1: LANDING PAGE MOCKUP ==================== -->
    <div class="lp" data-view-panel="landing">
      <header class="mast shell">
        <div class="brand-lockup">
          <a class="home-link" href="#lp-top">
            <img class="brand-mark" src="../../../site/assets/tasktap-icon.webp" width="46" height="46" alt="Tasktap">
            <span class="wordmark">Tasktap</span>
          </a>
        </div>
        <nav aria-label="Landing navigation">
          <a class="hide-sm" href="#lp-workspace">Workspace</a>
          <a class="hide-sm" href="#lp-capture">Notch</a>
          <a class="hide-sm" href="../../../site/docs/index.html">Docs</a>
          <a class="nav-cta" href="#lp-download">Install Script <span aria-hidden="true">↙</span></a>
        </nav>
      </header>

      <main id="lp-top">
        <section class="hero shell">
          <div>
            <a class="eyebrow-pill" href="https://github.com/HarzerHeribert/Tasktap/releases/tag/v1.0.0">
              <span class="eyebrow-dot" aria-hidden="true"></span>
              <span>Tasktap 1.0 · Native Mac Workspace</span>
              <span aria-hidden="true" style="color:var(--accent)">↗</span>
            </a>
            <h1>A place for<br><em>the whole task.</em></h1>
            <p class="lede">Your coding agents, split terminals, and live previews in one calm workspace on your Mac — with the notch always ready when a thought arrives.</p>

            <!-- Promoted Above-the-Fold Verified Terminal Installer -->
            <div class="hero-install" aria-label="Quick Terminal Install">
              <div class="hero-install-top">
                <div class="install-modes" role="tablist" aria-label="Install mode">
                  <button type="button" data-cmd-mode="quick" aria-selected="true">$ Quick install</button>
                  <button type="button" data-cmd-mode="inspect" aria-selected="false">Inspect first</button>
                  <button type="button" data-cmd-mode="pin" aria-selected="false">Pin v1.0.0</button>
                </div>
                <div class="hero-install-actions">
                  <a class="link-subtle" href="../../../site/install.sh" data-open-source>Inspect install.sh ↗</a>
                  <button type="button" class="copy-pill" data-copy-from="hero-cmd-text">Copy</button>
                </div>
              </div>
              <pre class="hero-cmd-box"><span class="sigil">$</span><code id="hero-cmd-text">curl -fL --proto '=https' --tlsv1.2 https://harzerheribert.github.io/Tasktap/install.sh -o tasktap-install.sh &amp;&amp; bash tasktap-install.sh</code></pre>
              <div class="hero-install-foot">
                <span><b>✓</b> SHA256SUMS verified</span>
                <span><b>✓</b> codesign --strict</span>
                <span><b>✓</b> Auto ZIP backup on update</span>
              </div>
            </div>

            <div class="hero-cta-row">
              <a class="btn btn-primary" href="https://github.com/HarzerHeribert/Tasktap/releases/latest">Download App (.zip) <span aria-hidden="true">↓</span></a>
              <a class="btn btn-ghost" href="#lp-workspace">Explore workspace <span aria-hidden="true">↘</span></a>
            </div>
            <p class="compat-note">Apple silicon · macOS 26+ · <a href="#lp-download">See installer guarantees &amp; community signing note</a></p>
          </div>

          <div class="signature">
            <div class="wave-field" aria-hidden="true">
              <video muted loop playsinline preload="none" width="1200" height="240" poster="../../../prototype/assets/motion/glyph/home.jpg" data-source="../../../prototype/assets/motion/glyph/home.mp4"></video>
            </div>
            <div class="signature-caption">
              <span>A thought · A thread · A place</span>
              <button type="button" class="icon-circle" id="wave-toggle-btn" aria-label="Pause artwork">Ⅱ</button>
            </div>
          </div>
        </section>

        <div class="stack-strip shell" aria-label="Supported CLI ecosystem">
          <span class="stack-label">WORKS WITH YOUR SIGNED-IN CLI STACK</span>
          <ul class="stack-chips">
            <li>Claude Code</li>
            <li>Codex</li>
            <li>Antigravity <code>agy</code></li>
            <li>Cursor CLI</li>
            <li>Pi <code>pi</code></li>
            <li>Follow Ghostty</li>
            <li>Starship &amp; Oh My Zsh</li>
          </ul>
        </div>

        <section class="workspace-sec shell" id="lp-workspace">
          <div class="sec-head">
            <div>
              <span class="sec-index">01 / THE WORKSPACE</span>
              <h2>Less window juggling. More room to build.</h2>
            </div>
            <a class="arrow-link" href="../../../site/docs/index.html#workspaces">Workspaces &amp; session lifecycle <span>↗</span></a>
          </div>

          <figure style="margin:0">
            <div class="studio-stage">
              <img class="studio-stage-bg" src="assets/studio-stage.webp" alt="">
              <div class="studio-window">
                <img src="../../../site/assets/product/workspace.png" width="1440" height="900" alt="Tasktap actual workspace showing agent terminal beside localhost preview and Markdown notes.">
              </div>
            </div>
            <figcaption class="fig-cap">
              <span>Tasktap 1.0 · Actual macOS interface framed on bespoke smoked-glass studio stage</span>
              <a class="arrow-link" href="../../../site/assets/product/workspace.png">Open full resolution <span>↗</span></a>
            </figcaption>
          </figure>

          <div class="pillars">
            <article>
              <span class="pillar-num">01 · RECURSIVE SPLITS</span>
              <h3>Your layout, your focus.</h3>
              <p>Split right (<kbd>⌘D</kbd>) or down (<kbd>⇧⌘D</kbd>). Group tabs by pane, expand one surface temporarily with <strong>Focus pane</strong>, and snap back to your saved tree.</p>
            </article>
            <article>
              <span class="pillar-num">02 · SIDE-BY-SIDE MEDIA</span>
              <h3>The output beside the shell.</h3>
              <p>Render localhost servers, Markdown, isolated local HTML, PDFs, images, and audio/video right next to your terminal. Attach any view to a prompt via <strong>Ask agent</strong>.</p>
            </article>
            <article>
              <span class="pillar-num">03 · LIVE PERSISTENCE</span>
              <h3>Close a tab, keep the process.</h3>
              <p>Closing a pane or quitting the window leaves embedded PTY sessions alive in Tasktap’s local terminal service. Reopen any running thread from Session history.</p>
            </article>
          </div>
        </section>

        <section class="band-dark" id="lp-capture">
          <div class="shell story-grid">
            <div class="story-copy">
              <span class="sec-index">02 / THE NOTCH &amp; REVIEW</span>
              <h2>Catch the thought<br>before you lose focus.</h2>
              <p>Spot a layout bug in Safari or think of a refactor mid-call. Summon the notch from any app without switching windows.</p>
              <div class="keycap">
                <kbd>⌃ ⌥ Space</kbd>
                <span><strong>Tap</strong> to type · <strong>Hold</strong> to dictate<br>Press <strong>⌘ Return</strong> to review</span>
              </div>
              <ul class="check-list">
                <li><strong>Independent review editors</strong> — Tweak Task wording, Destination agent/model, or Context without resetting the others.</li>
                <li><strong>Frozen source snapshots</strong> — Binds the active URL or file when capture begins so switching tabs mid-sentence never swaps your reference.</li>
              </ul>
              <a class="arrow-link" href="../../../site/docs/index.html#capture">See how capture &amp; review work <span>↗</span></a>
            </div>
            <figure style="margin:0">
              <div class="notch-art-card">
                <img class="notch-art-bg" src="assets/notch-signal.webp" alt="">
                <div class="notch-inner-shot">
                  <img src="../../../site/assets/product/review.png" width="430" height="643" alt="Tasktap Review screen">
                </div>
              </div>
              <figcaption class="fig-cap" style="justify-content:center">Actual review card · Reviewed task, destination &amp; frozen URL</figcaption>
            </figure>
          </div>
        </section>

        <section class="band-open">
          <div class="shell story-grid">
            <figure style="margin:0">
              <div class="decision-stage">
                <span class="camera-cutout" aria-hidden="true"></span>
                <img src="../../../site/assets/product/question.png" width="430" height="455" alt="Tasktap Notch decision card">
              </div>
              <figcaption class="fig-cap" style="justify-content:center">Actual notch decision · Settle once across notch, pane &amp; notification</figcaption>
            </figure>
            <div class="story-copy">
              <span class="sec-index">03 / DECISIONS &amp; REPORTS</span>
              <h2>Let the agent run.<br>Keep the judgment calls.</h2>
              <p>Managed Claude Code and Codex sessions surface scoped questions in the notch, workspace pane, and macOS notifications at once. Answer in any one place and all three resolve.</p>
              <p>Reported completions and errors collect in <strong>Activity</strong> — never guessed from terminal scrollback or exit code 0. Read the full Markdown report, listen with local Siri or offline Kokoro voices, or nudge the exact conversation.</p>
              <a class="arrow-link" style="margin-top:1.2rem" href="../../../site/docs/index.html#notifications">Questions, reports &amp; Codex Micro <span>↗</span></a>
            </div>
          </div>
        </section>

        <section class="band-open">
          <div class="shell story-grid">
            <div class="story-copy">
              <span class="sec-index">04 / MAKE IT YOURS</span>
              <h2>Familiar from<br>the first prompt.</h2>
              <p>Your shell loads its real startup files — zsh, fish, aliases, Oh My Zsh, and Starship included. Choose one application palette or import your Ghostty theme automatically.</p>
              <div class="layer-grid">
                <div class="layer-row"><strong>Application Palette</strong><span>Follow Ghostty + 7 native dark/light themes</span></div>
                <div class="layer-row"><strong>Window Backdrop</strong><span>Optional macOS vibrancy &amp; blur, opaque crisp text</span></div>
                <div class="layer-row"><strong>Terminal Engine</strong><span>Embedded xterm.js or external Ghostty / iTerm2 / Warp</span></div>
              </div>
              <a class="arrow-link" href="../../../site/docs/index.html#appearance">Appearance &amp; terminal layers <span>↗</span></a>
            </div>
            <figure style="margin:0">
              <div class="palette-card">
                <img src="../../../site/assets/product/appearance.png" width="630" height="267" alt="Tasktap eight appearance choices">
              </div>
              <figcaption class="fig-cap" style="justify-content:center">One cohesive palette across workspaces, terminals, and preferences</figcaption>
            </figure>
          </div>
        </section>

        <section class="install-sec shell" id="lp-download">
          <div class="install-header">
            <span class="sec-index">05 / GET TASKTAP 1.0</span>
            <h2>Install in one command.</h2>
            <p>Use the inspectable Terminal installer for cryptographic verification and automatic rollback backups, or download the app bundle directly.</p>
          </div>

          <div class="install-cards">
            <!-- Featured Option A: Terminal Installer -->
            <div class="cli-spotlight">
              <div class="cli-banner">
                <img src="assets/terminal-monolith.webp" alt="">
                <div class="cli-banner-copy">
                  <span class="sec-index" style="margin:0">OPTION A · RECOMMENDED FOR CLI USERS</span>
                  <h3>Verified Terminal Installer</h3>
                  <p>Downloads <code>install.sh</code> locally first — no blind pipe — then checks SHA-256 digests and strict Apple code signatures before installing.</p>
                </div>
              </div>

              <div class="cli-body">
                <div class="install-modes" style="margin-bottom:10px">
                  <button type="button" data-cmd-mode="quick" aria-selected="true">Latest stable</button>
                  <button type="button" data-cmd-mode="inspect" aria-selected="false">Inspect in less</button>
                  <button type="button" data-cmd-mode="pin" aria-selected="false">Pin v1.0.0</button>
                </div>

                <div class="term-window">
                  <div class="term-bar"><i></i><i></i><i></i><span>zsh — tasktap-install.sh</span></div>
                  <pre class="term-code" id="dl-cmd-text">curl -fL --proto '=https' --tlsv1.2 https://harzerheribert.github.io/Tasktap/install.sh -o tasktap-install.sh &amp;&amp; bash tasktap-install.sh</pre>
                  <div class="term-output" id="sim-output">
                    <div>Installing Tasktap 1.0.0…</div>
                    <div><span class="ok">✔</span> Tasktap-1.0.0-arm64.zip: OK (SHA256SUMS matched)</div>
                    <div><span class="ok">✔</span> codesign --verify --deep --strict passed (v1.0.0)</div>
                    <div><span class="ok">✔</span> Previous app archived to ~/Library/Application Support/Tasktap/Backups</div>
                    <div><span class="ok">✔</span> Installed ~/Applications/Tasktap.app</div>
                  </div>
                </div>

                <div class="cli-toolbar">
                  <div class="cli-toolbar-left">
                    <button type="button" class="copy-pill" data-copy-from="dl-cmd-text">Copy command</button>
                    <button type="button" class="mini-btn" data-open-source>Read 69-line install.sh</button>
                  </div>
                  <button type="button" class="mini-btn" id="toggle-sim-output">Hide terminal output ▴</button>
                </div>

                <div class="trust-grid">
                  <div class="trust-item">
                    <strong>SHA-256 &amp; Strict Codesign</strong>
                    Verifies <code>SHA256SUMS</code>, bundle ID, version, and <code>codesign --strict</code> before staging.
                  </div>
                  <div class="trust-item">
                    <strong>Atomic Rollback Backup</strong>
                    Compresses any existing <code>Tasktap.app</code> into <code>Application Support/Tasktap/Backups</code>.
                  </div>
                  <div class="trust-item">
                    <strong>No Duplicate Copies</strong>
                    Installs to <code>~/Applications</code> or updates <code>/Applications</code> in place cleanly.
                  </div>
                  <div class="trust-item">
                    <strong>Zero Gatekeeper Bypass</strong>
                    Never strips macOS quarantine attributes; in-app Sparkle handles later updates.
                  </div>
                </div>
              </div>
            </div>

            <!-- Option B: Direct ZIP + Requirements -->
            <div class="zip-card">
              <span class="sec-index" style="margin:0">OPTION B · DIRECT ARCHIVE</span>
              <h3>macOS App Bundle (.zip)</h3>
              <p>Prefer Finder? Download the latest release ZIP from GitHub, unzip it, and move <strong>Tasktap.app</strong> into Applications.</p>
              <a class="btn btn-primary" href="https://github.com/HarzerHeribert/Tasktap/releases/latest">Get for Mac (.zip) <span aria-hidden="true">↓</span></a>

              <dl class="req-list">
                <h4>Before you begin</h4>
                <div class="req-row"><dt>Your Mac</dt><dd>Apple silicon (M-series) · macOS 26 or newer.</dd></div>
                <div class="req-row"><dt>Agent CLI</dt><dd>Python 3 + signed-in CLI (Claude Code, Codex, Antigravity, Cursor, or Pi). Local notes work without an agent.</dd></div>
                <div class="req-row"><dt>First launch</dt><dd>Community builds are locally signed, <strong>not Apple notarized</strong>. Use <strong>Privacy &amp; Security → Open Anyway</strong> on first open.</dd></div>
                <div class="req-row"><dt>Updates</dt><dd>Re-run <code>install.sh</code> or choose <strong>Check for Updates…</strong> (Sparkle signed archives).</dd></div>
              </dl>
            </div>
          </div>
        </section>
      </main>

      <footer class="lp-footer shell">
        <div><strong style="color:var(--ink)">Tasktap 1.0</strong> · A place for the whole task.</div>
        <nav aria-label="Footer">
          <a href="../../../site/install.sh" data-open-source>install.sh</a>
          <a href="../../../site/docs/index.html">User Guide</a>
          <a href="https://github.com/HarzerHeribert/Tasktap">GitHub ↗</a>
          <a href="https://github.com/HarzerHeribert/Tasktap/releases">Releases ↗</a>
        </nav>
      </footer>
    </div>

    <!-- ==================== VIEW 2: GITHUB REPO & README MOCKUP ==================== -->
    <div class="gh-page" data-view-panel="github" hidden>
      <div class="gh-shell">
        <div class="gh-repo-head">
          <div class="gh-crumb">
            <span>HarzerHeribert</span> / <strong>Tasktap</strong>
            <span class="gh-public">Public</span>
          </div>
          <div class="gh-head-actions">
            <button type="button" class="gh-btn" id="gh-mode-rendered" aria-pressed="true">Rendered README</button>
            <button type="button" class="gh-btn" id="gh-mode-raw" aria-pressed="false">Raw Markdown</button>
            <button type="button" class="gh-btn" data-copy-from="raw-readme-code">Copy README.md</button>
          </div>
        </div>

        <div class="gh-layout">
          <div>
            <div class="gh-files">
              <div class="gh-files-head">
                <span><b>HarzerHeribert</b> Redesign README &amp; spotlight verified Terminal installer</span>
                <span>main · v1.0.0</span>
              </div>
              <div class="gh-file-row"><span>📁 docs</span><span>Architecture, controls, agent questions &amp; QA plan</span><span>today</span></div>
              <div class="gh-file-row"><span>📁 native</span><span>Swift macOS 26 window, notch, PTY &amp; Sparkle host</span><span>today</span></div>
              <div class="gh-file-row"><span>📁 scripts</span><span>Build, packaging &amp; automated Playwright/Swift checks</span><span>today</span></div>
              <div class="gh-file-row highlight-file"><span>📁 site</span><span>Product landing page, docs &amp; verified install.sh</span><span>updated</span></div>
              <div class="gh-file-row highlight-file"><span>📄 README.md</span><span>Visual hero, 1-command installer &amp; structured guide</span><span>updated</span></div>
            </div>

            <div class="gh-readme-box">
              <div class="gh-readme-bar">
                <span>📖 README.md</span>
                <span style="color:#8b949e;font-weight:400;font-size:12px">GitHub Dark preview · 100% GFM-compatible</span>
              </div>

              <div class="md-body" id="gh-rendered-pane">
                <p style="text-align:center">
                  <img src="assets/readme-hero.png" alt="Tasktap 1.0 Hero Banner" style="border-radius:12px">
                </p>

                <div class="md-badges">
                  <span class="md-shield"><span>Tasktap</span><span style="background:#ddba91">v1.0.0</span></span>
                  <span class="md-shield"><span>macOS</span><span style="background:#b0b1ad">26+ · Apple Silicon</span></span>
                  <span class="md-shield"><span>Installer</span><span style="background:#8fd19e">SHA-256 + codesign</span></span>
                  <span class="md-shield"><span>License</span><span style="background:#8d908d">Apache 2.0 + Commons</span></span>
                </div>

                <p class="md-nav-links">
                  <strong><a href="#gh-install">Terminal Install</a></strong> ·
                  <a href="https://github.com/HarzerHeribert/Tasktap/releases/latest">Download App (.zip)</a> ·
                  <a href="#lp-top" onclick="document.querySelector('[data-view-btn=landing]').click();return false;">Product Page</a> ·
                  <a href="../../../site/docs/index.html">User Guide</a> ·
                  <a href="#gh-build">Build from Source</a>
                </p>

                <hr>

                <p><strong>Tasktap 1.0</strong> is a native Mac workspace for coding agents, real terminals, and the things you build. Keep an agent or shell beside a live preview or Markdown note, split panes recursively as you work, and use your MacBook’s notch (<code>⌃ ⌥ Space</code>) to capture a thought or answer an agent question from any app.</p>

                <ul>
                  <li><strong>One workspace for the whole task</strong> — Real PTY terminals, tabs, nested splits (<code>⌘D</code> / <code>⇧⌘D</code>), and a calm sidebar showing only open surfaces.</li>
                  <li><strong>Live output right beside the terminal</strong> — Render <code>localhost</code> previews, Markdown, isolated local HTML, PDFs, images, audio, and video side-by-side. Attach any preview to a reviewed prompt with <strong>Ask agent</strong>.</li>
                  <li><strong>The notch keeps agents within reach</strong> — Tap <code>⌃ ⌥ Space</code> to type or hold to dictate from any app. Review <strong>Task</strong>, <strong>Destination</strong>, and frozen <strong>Context</strong> before dispatch.</li>
                  <li><strong>Built for your existing CLI stack</strong> — Launches <strong>Claude Code</strong>, <strong>Codex</strong>, <strong>Antigravity (<code>agy</code>)</strong>, <strong>Cursor CLI (<code>cursor-agent</code>)</strong>, and <strong>Pi (<code>pi</code>)</strong> with your own shell, Starship prompt, and Ghostty color palette.</li>
                </ul>

                <h2 id="gh-install">Install in One Command</h2>

                <p><img src="assets/readme-installer.png" alt="Install or update Tasktap from Terminal" style="border-radius:10px"></p>

                <p>The fastest way to install or update Tasktap on <strong>macOS 26+ (Apple silicon)</strong> is the official inspectable Bash installer — no blind <code>curl | sh</code> pipe required:</p>

                <div class="md-pre-wrap">
                  <pre><code id="gh-install-snippet">curl -fL --proto '=https' --tlsv1.2 https://harzerheribert.github.io/Tasktap/install.sh -o tasktap-install.sh &amp;&amp; bash tasktap-install.sh</code></pre>
                  <button type="button" class="gh-copy-code" data-copy-from="gh-install-snippet">Copy</button>
                </div>

                <details open>
                  <summary>Inspect the script first, pin a specific version, or see what <code>install.sh</code> verifies</summary>
                  <div style="margin-top:12px">
                    <div class="md-pre-wrap">
                      <pre><code id="gh-pin-snippet">curl -fL --proto '=https' --tlsv1.2 https://harzerheribert.github.io/Tasktap/install.sh -o tasktap-install.sh
less tasktap-install.sh
bash tasktap-install.sh 1.0.0</code></pre>
                      <button type="button" class="gh-copy-code" data-copy-from="gh-pin-snippet">Copy</button>
                    </div>
                    <table class="md-table">
                      <thead><tr><th>Installer Guarantee</th><th>Behavior</th></tr></thead>
                      <tbody>
                        <tr><td><strong>Cryptographic &amp; bundle checks</strong></td><td>Verifies <code>SHA256SUMS</code> over TLS 1.2+, runs <code>codesign --verify --deep --strict</code>, and checks bundle ID + version.</td></tr>
                        <tr><td><strong>Smart Applications target</strong></td><td>Installs fresh copies into <code>~/Applications/Tasktap.app</code> or updates <code>/Applications/Tasktap.app</code> in place; prevents duplicates.</td></tr>
                        <tr><td><strong>Automatic rollback backup</strong></td><td>Saves your previous <code>Tasktap.app</code> as a verified <code>.zip</code> in <code>~/Library/Application Support/Tasktap/Backups</code>.</td></tr>
                        <tr><td><strong>Zero security bypasses</strong></td><td>Never removes quarantine flags or weakens Gatekeeper. <a href="../../../site/install.sh" data-open-source>Read source (<code>site/install.sh</code>)</a>.</td></tr>
                      </tbody>
                    </table>
                  </div>
                </details>

                <h3>Alternative: Direct <code>.zip</code> Download &amp; First Launch</h3>
                <ol>
                  <li><strong>Download:</strong> Grab the ZIP from <a href="https://github.com/HarzerHeribert/Tasktap/releases/latest">GitHub Releases</a>, unzip it, and move <strong>Tasktap.app</strong> to <strong>Applications</strong> (later updates work via Sparkle’s signed <strong>Check for Updates…</strong>).</li>
                  <li><strong>First launch note:</strong> Community builds are locally signed and <strong>not Apple notarized</strong>; macOS may require <strong>System Settings → Privacy &amp; Security → Open Anyway</strong> on first launch.</li>
                  <li><strong>Prerequisites:</strong> Agent sessions require <strong>Python 3</strong> and a signed-in agent CLI. Local notes work without an agent.</li>
                </ol>

                <h2>Inside the Workspace</h2>
                <p><img src="../../../site/assets/product/workspace.png" alt="Tasktap workspace screenshot" style="border-radius:8px;border:1px solid #30363d"></p>

                <div class="md-two-col">
                  <div class="md-col-card">
                    <h3>01 · Capture &amp; Review from Any App</h3>
                    <p>Tap <code>⌃ ⌥ Space</code> to type or hold to dictate, then press <code>⌘ Return</code> to inspect <strong>Task</strong>, <strong>Destination</strong>, and frozen <strong>Context</strong> before starting.</p>
                    <img src="../../../site/assets/product/review.png" width="290" alt="Review screen">
                  </div>
                  <div class="md-col-card">
                    <h3>02 · Notch Decisions &amp; Cohesive Themes</h3>
                    <p>Answer Claude Code &amp; Codex questions once from the notch or workspace, and unify your UI across 8 palettes including <strong>Follow Ghostty</strong>.</p>
                    <img src="../../../site/assets/product/question.png" width="270" alt="Question screen">
                    <img src="../../../site/assets/product/appearance.png" alt="Themes" style="margin-top:12px">
                  </div>
                </div>

                <h2>Workspace &amp; Preview Guarantees</h2>
                <table class="md-table">
                  <thead><tr><th>Action / Surface</th><th>What happens</th></tr></thead>
                  <tbody>
                    <tr><td><strong>Close a tab, pane, or window</strong></td><td>Views close; embedded PTY processes stay running in the local terminal service and reopen from <strong>Session history</strong>.</td></tr>
                    <tr><td><strong>Close a workspace</strong></td><td>Split tree and open tabs are saved; restore anytime via <strong>+ → Closed workspaces</strong>.</td></tr>
                    <tr><td><strong>Markdown &amp; Local HTML</strong></td><td>Sandboxed local previews with <strong>Source / Preview</strong> toggle and <strong>Ask agent</strong> attachment (no native command bridge or remote network leakage).</td></tr>
                    <tr><td><strong>Web, PDF, Image &amp; Media</strong></td><td>Localhost dev servers, zoomable images, PDF navigation, and WebKit media playback beside your shell.</td></tr>
                  </tbody>
                </table>

                <details>
                  <summary>Agents, Request Preparation Privacy, Notifications &amp; Appearance Layers</summary>
                  <div style="margin-top:10px">
                    <p>Preserves every technical detail from the current README in scannable collapsible sections: supported CLIs (Claude Code, Codex, Antigravity, Cursor CLI, Pi), local-default <strong>On this Mac</strong> preparation vs. reviewed remote payloads, opt-in external session discovery, scoped report exports, Siri/Kokoro narration, and xterm.js vs. Ghostty/shell layer boundaries.</p>
                  </div>
                </details>

                <h2 id="gh-build">Build and Verify from Source</h2>
                <div class="md-pre-wrap">
                  <pre><code>git clone https://github.com/HarzerHeribert/Tasktap.git
cd Tasktap
./scripts/build-mac.sh
open build/Tasktap.app</code></pre>
                </div>
              </div>

              <div id="gh-raw-pane" hidden>
                <pre class="raw-md"><code id="raw-readme-code">{raw_readme}</code></pre>
              </div>
            </div>
          </div>

          <aside>
            <div class="gh-side-section">
              <h4>About</h4>
              <p style="color:#e6edf3;margin:0 0 10px">A Mac workspace for coding agents, split terminals, live previews, and a thought-catching notch.</p>
              <div>🔗 <a href="#lp-top" style="color:#58a6ff" onclick="document.querySelector('[data-view-btn=landing]').click();return false;">harzerheribert.github.io/Tasktap/</a></div>
              <div class="gh-topics">
                <span>macos</span><span>coding-agents</span><span>terminal</span><span>claude-code</span><span>codex</span><span>ghostty</span><span>notch</span>
              </div>
            </div>
            <div class="gh-side-section">
              <h4>Releases</h4>
              <strong style="color:#e6edf3">Tasktap 1.0.0</strong> <span style="color:#3fb950;border:1px solid #2ea043;border-radius:999px;padding:1px 7px;font-size:11px">Latest</span>
              <div style="margin-top:6px">Includes <code>Tasktap-1.0.0-arm64.zip</code> + <code>SHA256SUMS</code> for verified Terminal installer.</div>
            </div>
            <div class="gh-side-section" style="border:0">
              <h4>Quick Install</h4>
              <code style="display:block;padding:10px;border-radius:6px;background:#161b22;border:1px solid #30363d;color:#e6edf3;font:11.5px/1.5 var(--mono);overflow-wrap:anywhere">curl -fL https://harzerheribert.github.io/Tasktap/install.sh -o tasktap-install.sh &amp;&amp; bash tasktap-install.sh</code>
            </div>
          </aside>
        </div>
      </div>
    </div>

    <!-- ==================== VIEW 3: DESIGN AUDIT & AI ARTWORK ==================== -->
    <div class="compare-page" data-view-panel="audit" hidden>
      <span class="sec-index">DESIGN CRITIQUE &amp; UPGRADE NOTES</span>
      <h2 style="margin:0;font-size:2.4rem;letter-spacing:-0.045em">What we elevated — and how we spotlighted <code>install.sh</code>.</h2>
      <p style="color:var(--muted);max-width:64ch;margin-top:10px">All changes live safely inside <code>design/previews/tasktap-mockup/</code> until you’re happy with every word, layout choice, and visual asset.</p>

      <div class="compare-grid">
        <div class="compare-card">
          <span class="sec-index" style="color:var(--quiet)">BEFORE · CURRENT LIVE SITE &amp; README</span>
          <h3>Hidden installer &amp; wall-of-text README</h3>
          <ul>
            <li><strong>Zero mention of <code>install.sh</code> in <code>README.md</code></strong> — GitHub visitors only saw manual ZIP instructions.</li>
            <li><strong>Buried on the Landing Page</strong> — Terminal install was hidden at the very bottom inside a closed <code>&lt;details&gt;</code> accordion (<em>"Prefer installing with Terminal?"</em>).</li>
            <li><strong>No product visuals in <code>README.md</code></strong> — Only a 112px icon followed by 130 lines of dense prose; none of the 4 product screenshots were shown.</li>
            <li><strong>Flat screenshot framing</strong> — Landing page screenshots sat on flat backgrounds without studio depth or CLI stack context, and the appearance card sat in a mismatched blue box.</li>
          </ul>
        </div>

        <div class="compare-card after">
          <span class="sec-index">AFTER · NEW MOCKUP DESIGN</span>
          <h3>Installer front-and-center + Studio hardware aesthetic</h3>
          <ul>
            <li><strong>Hero Quick-Install Dock on Landing Page</strong> — Interactive mode tabs (<em>Quick install / Inspect first / Pin v1.0.0</em>), 1-click Copy, inline <code>install.sh</code> source modal, and trust badges above the fold.</li>
            <li><strong>Featured Option A Spotlight Card in <code>#download</code></strong> — Side-by-side with Direct ZIP, complete with simulated terminal output and 4 cryptographic/rollback guarantees.</li>
            <li><strong>Headline <code>## Install in One Command</code> in <code>README.md</code></strong> — Retina composited Terminal banner + copyable Bash block + verification table right near the top.</li>
            <li><strong>Visual Tour + Collapsible Reference</strong> — Retina Hero Banner + 2-column screenshot tour in <code>README.md</code>, keeping 100% of Tasktap’s honest technical documentation neatly organized.</li>
          </ul>
        </div>
      </div>

      <h3 style="margin:40px 0 8px;font-size:1.4rem;letter-spacing:-0.03em">Bespoke Google AI Studio Artwork Generated for This Mockup</h3>
      <p style="margin:0;color:var(--muted);font-size:0.92rem">Generated under your subscription to match Tasktap’s obsidian, smoked optical glass, brushed titanium, and warm <code>#ddba91</code> champagne-brass palette — never faking UI text, always framing real app pixels:</p>

      <div class="art-gallery">
        <div class="art-tile">
          <img src="assets/studio-stage.webp" alt="Studio stage AI artwork">
          <div><strong>01 · Smoked Optical Glass Stage</strong>Frames <code>workspace.png</code> on the Landing Page and powers the Retina <code>readme-hero.png</code> composite.</div>
        </div>
        <div class="art-tile">
          <img src="assets/notch-signal.webp" alt="Notch signal AI artwork">
          <div><strong>02 · Space-Black Notch &amp; Wave</strong>Echoes Tasktap’s 19-bar metallic voice icon beneath a MacBook camera bezel in Section 02.</div>
        </div>
        <div class="art-tile">
          <img src="assets/terminal-monolith.webp" alt="Terminal monolith AI artwork">
          <div><strong>03 · CNC Anodized Keycap Monolith</strong>Anchors the Verified Terminal Installer card on both the Landing Page and GitHub README banner.</div>
        </div>
      </div>
    </div>
  </div>

  <dialog class="source-dialog" id="install-source-dialog">
    <div class="source-dialog-head">
      <strong>site/install.sh (69 lines · inspectable Bash source)</strong>
      <button type="button" class="mini-btn" id="close-source-dialog">Close ✕</button>
    </div>
    <pre><code>{install_sh}</code></pre>
  </dialog>
</body>
</html>
"""

(here / "index.html").write_text(page)
print("Built", here / "index.html")
