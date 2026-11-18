(() => {
  // 1. Studio View Tabs (Landing Page vs GitHub README vs Design Audit)
  const viewBtns = document.querySelectorAll('[data-view-btn]');
  const views = document.querySelectorAll('[data-view-panel]');
  viewBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.viewBtn;
      viewBtns.forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
      views.forEach((v) => { v.hidden = v.dataset.viewPanel !== target; });
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
  });

  // 2. Responsive Viewport Frame Switcher
  const frame = document.getElementById('viewport-frame');
  const vpBtns = document.querySelectorAll('[data-vp-btn]');
  vpBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      frame.dataset.vp = btn.dataset.vpBtn;
      vpBtns.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    });
  });

  // 3. Install Command Modes (Hero & Download section stay in sync)
  const commands = {
    quick: "curl -fL --proto '=https' --tlsv1.2 https://harzerheribert.github.io/Tasktap/install.sh -o tasktap-install.sh && bash tasktap-install.sh",
    inspect: "curl -fL --proto '=https' --tlsv1.2 https://harzerheribert.github.io/Tasktap/install.sh -o tasktap-install.sh\nless tasktap-install.sh\nbash tasktap-install.sh",
    pin: "curl -fL --proto '=https' --tlsv1.2 https://harzerheribert.github.io/Tasktap/install.sh -o tasktap-install.sh && bash tasktap-install.sh 1.0.0",
  };
  const heroCmd = document.getElementById('hero-cmd-text');
  const dlCmd = document.getElementById('dl-cmd-text');
  document.querySelectorAll('[data-cmd-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.cmdMode;
      document.querySelectorAll('[data-cmd-mode]').forEach((b) => {
        b.setAttribute('aria-selected', String(b.dataset.cmdMode === mode));
      });
      if (heroCmd) heroCmd.textContent = commands[mode];
      if (dlCmd) dlCmd.textContent = commands[mode];
    });
  });

  // 4. Universal Copy Buttons
  document.querySelectorAll('[data-copy-from]').forEach((btn) => {
    const original = btn.textContent;
    btn.addEventListener('click', async () => {
      const el = document.getElementById(btn.dataset.copyFrom);
      if (!el) return;
      try {
        await navigator.clipboard.writeText(el.textContent.trim());
        btn.textContent = 'Copied ✓';
        setTimeout(() => { btn.textContent = original; }, 1800);
      } catch {
        btn.textContent = 'Select command';
      }
    });
  });

  // 5. Simulate Terminal Run Output Toggle
  const simBtn = document.getElementById('toggle-sim-output');
  const simBox = document.getElementById('sim-output');
  if (simBtn && simBox) {
    simBtn.addEventListener('click', () => {
      simBox.hidden = !simBox.hidden;
      simBtn.textContent = simBox.hidden ? 'Preview terminal output ▾' : 'Hide terminal output ▴';
    });
  }

  // 6. Inspect install.sh Source Modal
  const dialog = document.getElementById('install-source-dialog');
  document.querySelectorAll('[data-open-source]').forEach((trigger) => {
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      if (dialog && dialog.showModal) dialog.showModal();
    });
  });
  const closeDialog = document.getElementById('close-source-dialog');
  if (closeDialog && dialog) {
    closeDialog.addEventListener('click', () => dialog.close());
  }

  // 7. GitHub README Rendered vs Raw Markdown Toggle
  const ghRenderedBtn = document.getElementById('gh-mode-rendered');
  const ghRawBtn = document.getElementById('gh-mode-raw');
  const ghRendered = document.getElementById('gh-rendered-pane');
  const ghRaw = document.getElementById('gh-raw-pane');
  if (ghRenderedBtn && ghRawBtn) {
    ghRenderedBtn.addEventListener('click', () => {
      ghRenderedBtn.setAttribute('aria-pressed', 'true');
      ghRawBtn.setAttribute('aria-pressed', 'false');
      ghRendered.hidden = false;
      ghRaw.hidden = true;
    });
    ghRawBtn.addEventListener('click', () => {
      ghRawBtn.setAttribute('aria-pressed', 'true');
      ghRenderedBtn.setAttribute('aria-pressed', 'false');
      ghRendered.hidden = true;
      ghRaw.hidden = false;
    });
  }

  // 8. 60fps Glyph Wave Video Controller
  const video = document.querySelector('.wave-field video');
  const waveBtn = document.getElementById('wave-toggle-btn');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  if (video && !reduced.matches) {
    video.src = video.dataset.source;
    video.play().catch(() => {});
  }
  if (waveBtn && video) {
    waveBtn.addEventListener('click', () => {
      if (video.paused) {
        if (!video.src) video.src = video.dataset.source;
        video.play().catch(() => {});
        waveBtn.textContent = 'Ⅱ';
        waveBtn.setAttribute('aria-label', 'Pause artwork');
      } else {
        video.pause();
        waveBtn.textContent = '▶';
        waveBtn.setAttribute('aria-label', 'Play artwork');
      }
    });
  }
})();
