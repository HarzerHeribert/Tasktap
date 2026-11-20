// Renders Home after the owner's first trial of the project map (design/ui-directions/NOTES.md §13), from ui/dist in
// headless Chromium on fixture records (instrument-fixtures.cjs, projects-fixtures.cjs), no host: the first start
// (the projects step's sheet opening by itself, and what it found), Setup with none, one and all of its steps done and
// hidden, a thought placed, a thought asked about at the Composer with the keyboard and without it, the agent control
// and its list with 2, 6 and 11 agents, the Composer's foot at 720, 1180 and 1800 px, the Start key up close, the
// notch's capture row, and the chip's "Open another folder…" clicked with a real pointer (in WebKit with --engine
// webkit, the Mac's engine, where a click there was lost). Each owner's picture has a state of the same name, so the
// build before this work (--dist) and after it render side by side. The text size is TEXT's; --sizes renders all three.
// usage: node scripts/home-shots.cjs <outdir> [dpr...] [--only a,b] [--dist <folder>] [--engine webkit] [--sizes]
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { serve, open, TEXT } = require('./motion-pages.cjs');
const { scene, flow } = require('./instrument-fixtures.cjs');
const { projects } = require('./projects-fixtures.cjs');

const NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', aider: 'Aider', goose: 'Goose', qwen: 'Qwen Code', crush: 'Crush', cursor: 'Cursor', gemini: 'Gemini CLI', amp: 'Amp', copilot: 'Copilot' };
/** `n` agents, as the core lists them: the first two as the scene has them, then more, one that answers in its
 *  terminal (Aider: it reports by exiting) and one signed out (Qwen Code), and two at work in the scene's thoughts. */
function agents(r, n) {
  const base = r.agents[0];
  const all = Object.keys(NAMES).slice(0, n).map((id, i) => i < 2 ? r.agents[i] : ({ ...base, id, name: NAMES[id], version: `1.${i}.0`, identity: null,
    signed_in: id === 'qwen' ? false : true, events: id !== 'aider', questions: id === 'aider' ? 'terminal' : 'core', permissions: id === 'aider' ? 'terminal' : 'core' }));
  r.agents = all;
  if (n > 2) for (const t of r.thoughts.filter((x) => x.status === 'working').slice(0, 2)) t.agent = 'opencode';
  return r;
}
/** Placing by a model already answered (No), so Setup's second step is done and nothing offers it. */
const answered = (r, value = null) => ((r.prefs = [...(r.prefs || []).filter((p) => p.id !== 'route_by'), { id: 'route_by', value, rev: 9 }]), r);
/** Speech on this Mac, as the host says it (`speech_model`): ready, or still to download. */
const speech = (r, model = 'none') => ((r.speech = { supported: true, model, have: model === 'ready' ? 1.6e9 : 0, of: 1.6e9, error: null }), r);
/** What the projects step found, as if the person allowed it long ago. */
const looked = (r) => {
  const p = projects('settings');
  return { ...r, cards: p.cards, looks: p.looks.slice(0, 2), offer: { agents: [], places: [] } };
};
const wait = (ms) => (page) => page.waitForTimeout(ms);
const both = (...fs) => async (page) => { for (const f of fs) if (f) await f(page); };
const type = (text) => async (page) => (await page.focus('#capture-input'), await page.keyboard.type(text));
const send = (text) => both(type(text), (p) => p.keyboard.press('Enter'));
const click = (sel) => (page) => page.click(sel);
const press = (key) => (page) => page.keyboard.press(key);
const NARROW = { width: 720, height: 540 }, WIDE = { width: 1800, height: 900 };
/** The window up close, at a key: a picture of the region, at the page's own scale. */
const near = (sel, pad = 24) => ({ sel, pad });

/** Every state: its records, what is done to the page, the window, and (`clip`) the part of it that is the picture. */
function shots() {
  const s = {
    // ——— 1. The first start ———
    'first-start': { records: speech(projects('first-agents')), act: wait(1200) },
    'first-start-narrow': { records: speech(projects('first-agents')), act: wait(1200), viewport: NARROW },
    'first-found': { records: speech(projects('first-many')), act: both(wait(900), press('Enter'), wait(4200)) },
    'first-found-narrow': { records: speech(projects('first-many')), act: both(wait(900), press('Enter'), wait(4200)), viewport: NARROW },
    'first-folders': { records: speech(projects('first-folders')), act: wait(1200) },
    'first-details': { records: speech(projects('first-agents')), act: both(wait(900), click('.sheet .more-l'), wait(200)) },
    // ——— Setup on Home ———
    'setup-none': { records: speech(projects('first-agents')), act: both(wait(900), press('Escape'), wait(300)) },
    'setup-one': { records: speech(looked(scene('normal'))), act: wait(400) },
    'setup-two': { records: speech(answered(looked(scene('normal')))), act: wait(400) },
    // Agreed to placing under older terms: Setup's placing step says Agree again, and no thought carries a note of it.
    'setup-again': { records: (() => {
      const r = speech(looked(flow(scene('normal'), 'held')));
      r.prefs = [...r.prefs.filter((p) => p.id !== 'route_by'), { id: 'route_by', value: { agents: [{ agent: 'claude', model: 'haiku', on: true }], terms: 2 }, rev: 9 }];
      for (const t of r.thoughts) if (t.route) t.route = { ...t.route, by: 'local', fallback: 'the agreement was to what was sent before: placing now asks your agents one after another, and asks you again' };
      return r;
    })(), act: wait(400) },
    'setup-done': { records: speech(answered(looked(scene('normal'))), 'ready'), act: wait(400) },
    'setup-hidden': { records: speech({ ...looked(scene('normal')), prefs: [{ id: 'setup_hidden', value: true, rev: 9 }] }), act: wait(400) },
    'setup-closed': { records: speech(looked(scene('normal'))), act: both(wait(300), click('.setup .fold-h'), wait(200)) },
    'setup-placing': { records: speech(looked(scene('normal'))), act: both(wait(300), click('.setup [data-step=placing] :is(.btn,.act)'), wait(300)) },
    'setup-speech': { records: speech(answered(looked(scene('normal')))), act: both(wait(300), click('.setup [data-step=speech] :is(.btn,.act)'), wait(300)) },
    'settings-about': { records: speech({ ...answered(looked(scene('normal'))), prefs: [{ id: 'setup_hidden', value: true, rev: 9 }, { id: 'route_by', value: null, rev: 9 }] }),
      act: (p) => p.evaluate(() => ((window.__ws.ui.sheet = { kind: 'settings', at: 'about' }), window.__motion.redraw())) },
    // ——— 2 and 3. A thought sent: where it went, or its question ———
    'sent-asked': { records: speech({ ...looked(scene('normal')), asks: { notes: ['named in it', 'where your last thought went', 'worked on last'] } }), act: both(send('make the export faster'), wait(900)) },
    'sent-asked-key-1': { records: speech({ ...looked(scene('normal')), asks: { notes: ['named in it', 'where your last thought went', 'worked on last'] } }), act: both(send('make the export faster'), wait(900), press('1'), wait(500)) },
    'sent-asked-typing': { records: speech({ ...looked(scene('normal')), asks: { ms: 900, notes: ['named in it', 'where your last thought went', 'worked on last'] } }),
      act: both(send('make the export faster'), wait(150), type('1 more thing'), wait(1200)) },
    'sent-asked-given-back': { records: speech({ ...looked(scene('normal')), asks: { notes: ['named in it', 'where your last thought went', 'worked on last'] } }), act: both(send('make the export faster'), wait(900), press('Escape'), wait(300)) },
    'sent-asked-arrows': { records: speech({ ...looked(scene('normal')), asks: { notes: ['named in it', 'where your last thought went', 'worked on last'] } }), act: both(send('make the export faster'), wait(900), press('ArrowDown'), press('ArrowDown'), wait(200)) },
    // A thought placed: where it goes, the brief and the person's words, and Undo for its hold; nothing else under.
    'sent-placed': { records: speech(answered(looked(flow(scene('normal'), 'held')))), act: wait(300) },
    // ——— 4. The Composer's foot and the agent control ———
    'foot-2': { records: agents(answered(looked(scene('normal'))), 2), act: both(type('tidy the export menu'), wait(300)), clip: near('.home .capture') },
    'foot-6': { records: agents(answered(looked(scene('normal'))), 6), act: both(type('tidy the export menu'), wait(300)), clip: near('.home .capture') },
    'foot-11': { records: agents(answered(looked(scene('normal'))), 11), act: both(type('tidy the export menu'), wait(300)), clip: near('.home .capture') },
    'agents-2': { records: agents(answered(looked(scene('normal'))), 2), act: both(type('tidy the export menu'), click('.cap-agent'), wait(300)), clip: near('.home .capture') },
    'agents-6': { records: agents(answered(looked(scene('normal'))), 6), act: both(type('tidy the export menu'), click('.cap-agent'), wait(300)), clip: near('.home .capture') },
    'agents-11': { records: agents(answered(looked(scene('normal'))), 11), act: both(type('tidy the export menu'), click('.cap-agent'), wait(300)), clip: near('.home .capture') },
    'agents-11-find': { records: agents(answered(looked(scene('normal'))), 11), act: both(type('tidy the export menu'), click('.cap-agent'), wait(200), (p) => p.keyboard.type('co'), wait(300)), clip: near('.home .capture') },
    'agents-picked': { records: agents(answered(looked(scene('normal'))), 6), act: both(type('tidy the export menu'), click('.cap-agent'), wait(200), press('ArrowDown'), press('ArrowDown'), press('Enter'), wait(500)), clip: near('.home .capture') },
    // ——— 5. The Start key ———
    'key-empty': { records: answered(looked(scene('normal'))), act: wait(300), clip: near('.home .cap-row .key', 16), dpr: 4 },
    'key-typed': { records: answered(looked(scene('normal'))), act: both(type('tidy the export menu'), wait(300)), clip: near('.home .cap-row .key', 16), dpr: 4 },
    'key-later': { records: { ...projects('first-agents'), looks: [{ id: 'x', rev: 1, kind: 'agent', agent: 'claude', folder: null, on: false, state: 'ready', found: 0, looked: null, note: null }] }, act: both(type('tidy the export menu'), wait(300)), clip: near('.home .cap-row .key', 16), dpr: 4 },
    'home-busy': { records: answered(looked(scene('busy'))), act: wait(400) },
    // On Windows (the page told so: its keys are Windows' words), the foot and its key up close.
    'foot-windows': { system: 'windows', records: agents(answered(looked(scene('normal'))), 6), act: both(type('tidy the export menu'), wait(300)), clip: near('.home .capture') },
    'key-windows': { system: 'windows', records: answered(looked(scene('normal'))), act: both(type('tidy the export menu'), wait(300)), clip: near('.home .cap-row .key', 16), dpr: 4 },
    // ——— 6. "Open another folder…", clicked ———
    'folder-list': { records: { ...answered(looked(scene('normal'))), pick: '/Users/example/projects/inkwell' }, act: both(click('#capture-input'), click('#dest-chip'), wait(300)) },
    'folder-clicked': { records: { ...answered(looked(scene('normal'))), pick: '/Users/example/projects/inkwell' }, act: both(click('#capture-input'), click('#dest-chip'), wait(300), async (p) => {
      const b = await p.locator('.cap-list button:has-text("Open another folder")').boundingBox();
      await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      await p.waitForTimeout(500);
    }) },
  };
  // The foot at three widths of window, and in the notch.
  for (const [w, h] of [[720, 540], [1180, 760], [1800, 900]]) s[`foot-at-${w}`] = { records: agents(answered(looked(scene('normal'))), 6), act: both(type('tidy the export menu'), wait(300)), viewport: { width: w, height: h }, clip: near('.home .capture') };
  for (const [w, h] of [[720, 540], [1180, 760], [1800, 900]]) s[`foot-empty-at-${w}`] = { records: agents(answered(looked(scene('normal'))), 6), act: wait(300), viewport: { width: w, height: h }, clip: near('.home .capture') };
  s['notch-capture'] = { label: 'notch', records: agents(answered(looked(scene('normal'))), 6), act: async (p) => {
    await p.evaluate(() => window.__fake.emit({ do: 'geometry', width: 104, height: 16, cutout: false, surfaceWidth: 420, surfaceOffset: 0, span: 560, pixel: 1, corner: 10, offset: 0, available: 700, collapsed: false }));
    await p.evaluate(() => window.__fake.emit({ do: 'capture' }));
    await p.waitForTimeout(700);
    await p.keyboard.type('tidy the export menu');
    await p.waitForTimeout(300);
  } };
  s['notch-agents'] = { ...s['notch-capture'], act: both(s['notch-capture'].act, click('.cap-agent'), wait(300)) };
  // A question opens the notch by itself, without the keyboard: no caps. Clicked into, it has it, and shows them.
  const asks = async (p) => {
    await p.evaluate(() => window.__fake.emit({ do: 'geometry', width: 104, height: 16, cutout: false, surfaceWidth: 420, surfaceOffset: 0, span: 560, pixel: 1, corner: 10, offset: 0, available: 700, collapsed: false }));
    await p.waitForTimeout(900);
  };
  // ——— The review's findings (docs/trial-checklist.md R1–R15), each in the state it was found in ———
  const NOTES = ['named in it', 'where your last thought went', 'worked on last'];
  const asked = (o = {}) => speech({ ...looked(scene('normal')), asks: { notes: NOTES, ...o } });
  Object.assign(s, {
    // R1: typed at the first start's sheet: the letters are the Composer's, the sheet put away as Not now.
    'first-typed': { records: speech(projects('first-agents')), act: both(wait(900), (p) => p.keyboard.type('fix the export menu', { delay: 40 }), wait(300)) },
    // R1: Return 300 ms after another key: held back, and said so.
    'first-held': { records: speech(projects('first-agents')), act: both(wait(900), press('ArrowLeft'), wait(300), press('Enter'), wait(200)) },
    // R2: letters typed after the question came: all of them in the field, the question in Needs you.
    'sent-asked-typed-after': { records: asked(), act: both(send('make the export faster'), wait(900), (p) => p.keyboard.type('look at the logs', { delay: 30 }), wait(300)) },
    // R3: sent from New Task: the question in the sheet only, its keys there.
    'sheet-asked': { records: asked(), act: both((p) => p.focus('#capture-input'), press('Meta+n'), wait(300), (p) => p.keyboard.type('make the export faster'), press('Enter'), wait(900)) },
    // R4: the first step put away by a click beside it: Not now, and Setup says Skipped.
    'first-clicked-away': { records: speech(projects('first-agents')), act: both(wait(900), (p) => { const v = p.viewportSize(); return p.mouse.click(v.width - 20, v.height - 40); }, wait(500)) },
    // R5: Home left for a workspace and back with the question at the Composer.
    'back-home': { records: asked(), act: both(send('make the export faster'), wait(900),
      (p) => p.evaluate(() => (window.__ws.show([...window.__ws.records.projects.values()].find((x) => x.open).id), window.__motion.redraw())), wait(300),
      (p) => p.evaluate(() => (window.__ws.show('home'), window.__motion.redraw())), wait(400)) },
    // R6: Tab from the field to the agent control, its key beside it.
    'foot-tab': { records: agents(answered(looked(scene('normal'))), 6), act: both(type('tidy the export menu'), press('Tab'), press('Tab'), wait(200)), clip: near('.home .capture') },
    // R7: the usual agent signed out: the list opens, signing in a row of it.
    'agents-signed-out': { records: (() => { const r = agents(answered(looked(scene('normal'))), 6); r.agents[0].signed_in = false; return r; })(), act: both(type('tidy the export menu'), click('.cap-agent'), wait(300)), clip: near('.home .capture') },
    // R11: Setup hidden a moment ago: its place says where it went.
    'setup-hidden-now': { records: speech(looked(scene('normal'))), act: both(wait(300), click('.home .setup-h .act'), wait(400)) },
    // R12: a thought placed, its disclosure opened.
    'sent-placed-open': { records: speech(answered(looked(flow(scene('normal'), 'held')))), act: both(wait(300), click('.home .way-more, .home .way-h + .way-b'), wait(200)) },
  });
  // R3: a thought sent from the notch's capture line, asked about there.
  s['notch-asked'] = { label: 'notch', records: asked(), act: both(s['notch-capture'].act, press('Enter'), wait(900)) };
  // R8: the foot at the narrow widths where the reason was cut.
  for (const w of [540, 600, 660]) s[`foot-at-${w}`] = { records: agents(answered(looked(scene('normal'))), 6), act: both(type('tidy the export menu'), wait(300)), viewport: { width: w, height: 600 }, clip: near('.home .capture') };
  // Home at four windows, the sidebar open and closed (checklist item 36): the column and its place are the window's.
  const sidebar = (on) => (p) => p.evaluate((on) => ((window.__ws.ui.sidebar = on), window.__motion.redraw()), on);
  for (const w of [1512, 1728, 2560, 3440])
    for (const on of [true, false]) {
      s[`layout-${w}-${on ? 'open' : 'closed'}`] = { records: answered(looked(scene('busy'))), act: both(sidebar(on), wait(400)), viewport: { width: w, height: 900 }, dpr: 1 };
      s[`layout-quiet-${w}-${on ? 'open' : 'closed'}`] = { records: answered(looked(scene('normal'))), act: both(sidebar(on), wait(400)), viewport: { width: w, height: 900 }, dpr: 1 };
    }
  s['notch-question'] = { label: 'notch', records: scene('busy'), act: asks };
  s['notch-question-held'] = { label: 'notch', records: scene('busy'), act: both(asks, (p) => p.focus('#sheet [data-question] .ans'), wait(200)) };
  return s;
}

async function main(out, dprs, only, engine) {
  const pw = require('playwright');
  fs.mkdirSync(out, { recursive: true });
  const dist = process.argv.includes('--dist') ? process.argv[process.argv.indexOf('--dist') + 1] : path.join(__dirname, '../ui/dist');
  const server = await serve(path.resolve(dist));
  const browser = await pw[engine].launch({ headless: true });
  const failures = [];
  try {
    for (const dpr0 of dprs) {
      for (const [name, s] of Object.entries(shots())) {
        if (only && !only.some((o) => name === o || (o.endsWith('*') && name.startsWith(o.slice(0, -1))))) continue;
        const dpr = s.dpr ?? dpr0;
        const page = await open(browser, { label: s.label ?? 'workspace', records: structuredClone(s.records), url: server.url, dpr, viewport: s.viewport, system: s.system });
        if ((s.label ?? 'workspace') === 'workspace')
          await page.addStyleTag({ content: 'body::after{content:"";position:fixed;z-index:99;left:14px;top:13px;width:12px;height:12px;border-radius:50%;background:#ff5f57;box-shadow:20px 0 #febc2e,40px 0 #28c840;pointer-events:none}' });
        try {
          if (s.act) await s.act(page);
        } catch (e) {
          failures.push(`${name}: ${String(e.message || e).split('\n')[0]}`);
        }
        await page.waitForTimeout(s.settle ?? 400);
        await page.evaluate(() => document.fonts.ready);
        const file = `home-${name}-${TEXT}${engine === 'chromium' ? '' : `-${engine}`}@${dpr}x.png`;
        let clip;
        if (s.clip) {
          const b = await page.locator(s.clip.sel).first().boundingBox().catch(() => null);
          const vp = page.viewportSize();
          if (b) clip = { x: Math.max(0, b.x - s.clip.pad), y: Math.max(0, b.y - s.clip.pad), width: Math.min(vp.width, b.width + 2 * s.clip.pad), height: Math.min(vp.height - Math.max(0, b.y - s.clip.pad), b.height + 2 * s.clip.pad) };
        }
        await page.screenshot({ path: path.join(out, file), ...(clip ? { clip } : {}) });
        for (const e of page.errors) failures.push(`${name}: the page said ${e}`);
        await page.context().close();
        console.log(file);
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  for (const f of [...new Set(failures)]) console.log('NOTE  ' + f);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (f) => (args.includes(f) ? (args.splice(args.indexOf(f), 1), true) : false);
  const value = (f) => { const i = args.indexOf(f); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const sizes = flag('--sizes'), only = value('--only')?.split(','), engine = value('--engine') ?? 'chromium';
  const di = args.indexOf('--dist'), dist = di >= 0 ? args.splice(di, 2) : [];
  const [out, ...d] = args;
  if (!out) (console.error('usage: node scripts/home-shots.cjs <outdir> [dpr...] [--only a,b] [--dist <folder>] [--engine webkit] [--sizes]'), process.exit(2));
  if (sizes) {
    const runs = ['small', 'default', 'large'].map((text) => new Promise((done) => {
      const p = spawn(process.execPath, [__filename, out, ...d, ...(only ? ['--only', only.join(',')] : []), '--engine', engine, ...dist], { env: { ...process.env, TEXT: text }, stdio: 'inherit' });
      p.on('exit', (code) => done(code));
    }));
    Promise.all(runs).then((codes) => (process.exitCode = codes.some(Boolean) ? 1 : 0));
  } else main(path.resolve(out), d.length ? d.map(Number) : [2], only, engine).catch((e) => (console.error(e), process.exit(1)));
}
module.exports = { shots, agents };
