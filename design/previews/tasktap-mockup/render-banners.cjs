const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '../../..');
const mockupAssets = path.resolve(__dirname, 'assets');

function toDataURI(filePath, mime) {
  const bytes = fs.readFileSync(filePath);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

const studioStage = toDataURI(path.join(mockupAssets, 'studio-stage.jpg'), 'image/jpeg');
const terminalMonolith = toDataURI(path.join(mockupAssets, 'terminal-monolith.jpg'), 'image/jpeg');
const iconPng = toDataURI(path.join(root, 'site/assets/tasktap-icon.png'), 'image/png');
const workspacePng = toDataURI(path.join(root, 'site/assets/product/workspace.png'), 'image/png');
const questionPng = toDataURI(path.join(root, 'site/assets/product/question.png'), 'image/png');

const heroHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: transparent; margin: 0; }
  .canvas {
    width: 1280px;
    height: 690px;
    overflow: hidden;
    background: #0d0e10;
    color: #f2f0e9;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', sans-serif;
    position: relative;
    border-radius: 20px;
  }
  .bg {
    position: absolute;
    inset: 0;
    background: url('${studioStage}') center/cover no-repeat;
    filter: saturate(1.12) contrast(1.06) brightness(1.08);
  }
  .vignette {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(ellipse 76% 70% at 50% 58%, rgba(13,14,16,0.22) 0%, rgba(10,11,13,0.78) 100%),
      linear-gradient(180deg, rgba(10,11,13,0.82) 0%, rgba(10,11,13,0.22) 40%, rgba(10,11,13,0.86) 100%);
  }
  .frame-border {
    position: absolute;
    inset: 0;
    border: 1px solid rgba(221, 186, 145, 0.25);
    border-radius: 20px;
    pointer-events: none;
    z-index: 10;
  }
  .content {
    position: relative;
    z-index: 2;
    height: 100%;
    padding: 40px 52px 0;
    display: flex;
    flex-direction: column;
  }
  .top-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .brand img {
    width: 46px;
    height: 46px;
    border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.55);
  }
  .brand-name {
    font-size: 23px;
    font-weight: 620;
    letter-spacing: -0.04em;
    color: #f5f3ec;
  }
  .brand-tag {
    padding: 5px 12px;
    border-radius: 999px;
    background: rgba(221, 186, 145, 0.14);
    border: 1px solid rgba(221, 186, 145, 0.38);
    color: #e5c69f;
    font-size: 11.5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.05em;
  }
  .meta-pills {
    display: flex;
    gap: 8px;
  }
  .pill {
    padding: 6px 12px;
    border-radius: 999px;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.12);
    color: #c8cac6;
    font-size: 12px;
    letter-spacing: -0.01em;
    backdrop-filter: blur(12px);
  }
  .headline-block {
    margin-top: 22px;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 32px;
  }
  h1 {
    font-size: 54px;
    font-weight: 540;
    letter-spacing: -0.055em;
    line-height: 1.02;
    color: #f7f5ef;
  }
  h1 span {
    color: #ddba91;
  }
  .sub {
    max-width: 445px;
    font-size: 16px;
    line-height: 1.5;
    color: #bcbfba;
    padding-bottom: 3px;
  }
  .stage {
    position: relative;
    margin-top: 26px;
    flex: 1;
  }
  .mac-window {
    position: absolute;
    left: 0;
    right: 195px;
    top: 0;
    border-radius: 14px 14px 0 0;
    overflow: hidden;
    background: #111316;
    border: 1px solid rgba(255,255,255,0.18);
    border-bottom: none;
    box-shadow:
      0 30px 90px rgba(0,0,0,0.88),
      0 0 0 1px rgba(221,186,145,0.08);
  }
  .mac-window img {
    display: block;
    width: 100%;
    height: auto;
  }
  .notch-card {
    position: absolute;
    right: 0;
    top: 14px;
    width: 292px;
    border-radius: 16px;
    overflow: hidden;
    background: #08090a;
    border: 1px solid rgba(221, 186, 145, 0.42);
    box-shadow:
      0 28px 70px rgba(0,0,0,0.92),
      0 0 44px rgba(221, 186, 145, 0.14);
    padding-top: 16px;
  }
  .notch-cutout {
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 92px;
    height: 13px;
    background: #020203;
    border-radius: 0 0 8px 8px;
  }
  .notch-card img {
    display: block;
    width: 100%;
    height: auto;
  }
  .cli-pill {
    position: absolute;
    left: 20px;
    bottom: 18px;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 18px;
    border-radius: 12px;
    background: rgba(13, 14, 17, 0.94);
    border: 1px solid rgba(221, 186, 145, 0.44);
    box-shadow: 0 18px 48px rgba(0,0,0,0.88);
    backdrop-filter: blur(16px);
  }
  .cli-badge {
    padding: 5px 9px;
    border-radius: 6px;
    background: rgba(221, 186, 145, 0.18);
    color: #ebd0ad;
    font: 600 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .cli-cmd {
    font: 12.5px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #f2f0e9;
    white-space: nowrap;
  }
  .cli-cmd em {
    font-style: normal;
    color: #ddba91;
  }
</style>
</head>
<body>
  <div class="canvas" id="target">
    <div class="bg"></div>
    <div class="vignette"></div>
    <div class="frame-border"></div>
    <div class="content">
      <div class="top-row">
        <div class="brand">
          <img src="${iconPng}" alt="">
          <span class="brand-name">Tasktap</span>
          <span class="brand-tag">v1.0 RELEASE</span>
        </div>
        <div class="meta-pills">
          <span class="pill">macOS 26+ · Apple silicon</span>
          <span class="pill">Claude · Codex · Antigravity · Cursor · Pi</span>
          <span class="pill">Ghostty-ready</span>
        </div>
      </div>

      <div class="headline-block">
        <h1>A place for <span>the whole task.</span></h1>
        <p class="sub">Split terminals, live previews, and coding agents in one Mac workspace — with the notch always ready to capture a thought or answer a question.</p>
      </div>

      <div class="stage">
        <div class="mac-window">
          <img src="${workspacePng}" alt="">
        </div>
        <div class="notch-card">
          <span class="notch-cutout"></span>
          <img src="${questionPng}" alt="">
        </div>
        <div class="cli-pill">
          <span class="cli-badge">Verified CLI Install</span>
          <span class="cli-cmd"><em>$</em> curl -fL https://harzerheribert.github.io/Tasktap/install.sh -o tasktap-install.sh &amp;&amp; bash tasktap-install.sh</span>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;

const installerHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: transparent; margin: 0; }
  .canvas {
    width: 1200px;
    height: 340px;
    overflow: hidden;
    background: #101113;
    color: #f2f0e9;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', sans-serif;
    position: relative;
    border-radius: 18px;
  }
  .art {
    position: absolute;
    right: -20px;
    top: -25px;
    width: 680px;
    height: 390px;
    background: url('${terminalMonolith}') center/cover no-repeat;
    opacity: 0.92;
    filter: brightness(1.12) contrast(1.06);
  }
  .fade {
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, #101113 0%, #101113 44%, rgba(16,17,19,0.58) 70%, rgba(16,17,19,0.22) 100%);
  }
  .ring {
    position: absolute;
    inset: 0;
    border: 1px solid rgba(221,186,145,0.28);
    border-radius: 18px;
    pointer-events: none;
  }
  .wrap {
    position: relative;
    z-index: 2;
    height: 100%;
    padding: 34px 42px;
    display: grid;
    grid-template-columns: 1fr 1.08fr;
    gap: 32px;
    align-items: center;
  }
  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: #ddba91;
    font: 600 11.5px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #ddba91;
  }
  h2 {
    margin-top: 12px;
    font-size: 33px;
    font-weight: 560;
    letter-spacing: -0.045em;
    line-height: 1.1;
  }
  p {
    margin-top: 12px;
    color: #b8bab6;
    font-size: 14.5px;
    line-height: 1.55;
    max-width: 460px;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #e8e5dc;
    font-size: 13px;
  }
  .chips {
    margin-top: 20px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .chip {
    padding: 6px 11px;
    border-radius: 7px;
    background: rgba(255,255,255,0.055);
    border: 1px solid rgba(255,255,255,0.11);
    font: 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #dedfd9;
  }
  .chip b {
    color: #9cd6a4;
    font-weight: 600;
  }
  .term {
    background: rgba(11, 12, 14, 0.86);
    border: 1px solid rgba(255,255,255,0.18);
    border-radius: 13px;
    box-shadow: 0 24px 60px rgba(0,0,0,0.82);
    backdrop-filter: blur(16px);
    overflow: hidden;
  }
  .term-head {
    height: 34px;
    padding: 0 14px;
    background: rgba(255,255,255,0.045);
    border-bottom: 1px solid rgba(255,255,255,0.08);
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .term-head i {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  .term-head i:nth-child(1) { background: #e06c60; }
  .term-head i:nth-child(2) { background: #dfba69; }
  .term-head i:nth-child(3) { background: #78b779; }
  .term-head span {
    margin-left: auto;
    font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #969996;
  }
  .term-body {
    padding: 16px 20px;
    font: 12.25px/1.72 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #d8d7d2;
  }
  .cmd { color: #f6f4ed; }
  .indent { padding-left: 18px; color: #f6f4ed; }
  .prompt { color: #ddba91; }
  .ok { color: #8fd19e; }
  .dim { color: #959895; }
</style>
</head>
<body>
  <div class="canvas" id="target">
    <div class="art"></div>
    <div class="fade"></div>
    <div class="ring"></div>
    <div class="wrap">
      <div>
        <span class="eyebrow"><span class="dot"></span>Fastest Setup · Inspectable Bash Script</span>
        <h2>Install or update from Terminal.</h2>
        <p>No blind <code>curl | sh</code> pipe. Download <code>install.sh</code> locally, verify cryptographic checksums and Apple bundle signatures, and keep an automatic rollback archive.</p>
        <div class="chips">
          <span class="chip"><b>✓</b> SHA256SUMS verified</span>
          <span class="chip"><b>✓</b> codesign --strict</span>
          <span class="chip"><b>✓</b> Auto ZIP backup</span>
        </div>
      </div>
      <div class="term">
        <div class="term-head"><i></i><i></i><i></i><span>zsh — tasktap-install.sh</span></div>
        <div class="term-body">
          <div class="cmd"><span class="prompt">$</span> curl -fL --proto '=https' --tlsv1.2 \\</div>
          <div class="indent">https://harzerheribert.github.io/Tasktap/install.sh -o tasktap-install.sh</div>
          <div class="cmd"><span class="prompt">$</span> bash tasktap-install.sh</div>
          <div class="dim">Installing Tasktap 1.0.0…</div>
          <div><span class="ok">✔</span> Tasktap-1.0.0-arm64.zip: OK (SHA-256)</div>
          <div><span class="ok">✔</span> Validated strict signature &amp; bundle v1.0.0</div>
          <div><span class="ok">✔</span> Installed ~/Applications/Tasktap.app</div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;

(async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 800 },
    deviceScaleFactor: 2,
  });

  const p1 = await context.newPage();
  await p1.setContent(heroHtml, { waitUntil: 'load' });
  await p1.locator('#target').screenshot({
    path: path.join(mockupAssets, 'readme-hero.png'),
    omitBackground: true,
  });

  const p2 = await context.newPage();
  await p2.setContent(installerHtml, { waitUntil: 'load' });
  await p2.locator('#target').screenshot({
    path: path.join(mockupAssets, 'readme-installer.png'),
    omitBackground: true,
  });

  await browser.close();
  console.log('Re-rendered crisp readme-hero.png and readme-installer.png');
})();
