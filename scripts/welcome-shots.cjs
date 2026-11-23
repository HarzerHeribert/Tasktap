// The welcome (ui/src/workspace/welcome.tsx), the lean Placing section and the marks, as pictures and as checks, from ui/dist
// in headless Chromium on fixture records, dark, at 2x, no host: the welcome shows by itself on a first start and not on
// a later one (Home then has one quiet line, "Finish setup", that comes back to the first open step); each of its four
// steps, the first with nothing found, the third with "What is sent" open (the full list is one action away, and not
// there before); Return takes the primary action and Escape leaves it; a step skipped stays open; after the last step Home
// has the cursor in the Composer; Settings › Placing is lean; Settings › Agents with the agents' own marks;
// and no "·" and no ring anywhere in them.
// usage: node scripts/welcome-shots.cjs <outdir>   (ui/dist must be built; exit status 1 on a failure)
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { serve, open } = require('./motion-pages.cjs');
const { scene } = require('./instrument-fixtures.cjs');
const { projects } = require('./projects-fixtures.cjs');

const out = path.resolve(process.argv[2] || 'welcome');
fs.mkdirSync(out, { recursive: true });
const failures = [];
const expect = (ok, what) => (console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`), ok || failures.push(what));
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const sheet = (page, name) => page.locator('.sheet').screenshot({ path: path.join(out, `${name}.png`) });
const ready = (page) => page.waitForFunction(() => window.__ws?.ui.ready, null, { timeout: 15000 });
const speech = (r, model = 'none') => ((r.speech = { supported: true, model, have: model === 'ready' ? 1.6e9 : model === 'fetching' ? 6e8 : 0, of: 1.6e9, error: null }), r);
const state = (page) => page.evaluate(() => ({
  welcome: !!document.querySelector('.welcome .wc'), home: !!document.querySelector('.hx'), title: document.querySelector('.wc h1')?.firstChild?.textContent ?? '',
  finish: [...document.querySelectorAll('.finish')].map((b) => b.textContent), focus: document.activeElement?.id ?? '', marks: document.querySelectorAll('.wc-m li[data-on]').length,
  rings: document.querySelectorAll('.wc .ring-o, .sheet .ring-o').length, dots: (document.querySelector('.welcome, .finish')?.innerText ?? '').includes('·'),
}));
const settle = (page, ms = 700) => page.waitForTimeout(ms);

async function main() {
  const server = await serve(path.resolve(__dirname, '../ui/dist'));
  const browser = await chromium.launch({ headless: true });
  try {
    // ——— A first start: the welcome by itself, in place of Home ———
    let page = await open(browser, { label: 'workspace', records: speech(projects('first-agents')), url: server.url, dpr: 2 });
    await ready(page);
    await settle(page, 1500);
    let s = await state(page);
    expect(s.welcome && !s.home && s.title === 'Your projects', `a first start shows the welcome by itself, in place of Home: "${s.title}"`);
    expect(await page.locator('.wc-r').count() === 8 && await page.locator('.wc-r [role=switch][aria-checked=true]').count() === 8 && await page.locator('.wc-k').textContent() === '9 found' && await page.locator('.wc-more').textContent() === 'and 1 more', 'the search started by itself: nine found, the count beside the headline as data, eight rows and "and 1 more", all chosen');
    const order = await page.evaluate(() => ({ looks: [...window.__ws.records.looks.values()].map((l) => l.agent ?? l.folder) }));
    expect(order.looks.length > 0 && !order.looks.includes('~'), `the search went first to what the core offers (${order.looks.join(', ')}), not to the home folder`);
    const on = await page.evaluate(() => { const r = (e) => e.getBoundingClientRect(), p = r(document.querySelector('.wc-i')); return ['.wc h1', '.wc-b', '.wc-a', '.wc-f'].every((q) => { const b = r(document.querySelector(q)); return b.left >= p.left - 1 && b.right <= p.right + 1 && b.top >= p.top - 1 && b.bottom <= p.bottom + 1; }) && getComputedStyle(document.querySelector('.wc-i')).backgroundColor !== 'rgba(0, 0, 0, 0)'; });
    expect(on, 'the whole step stands on one panel of the raised material');
    await shot(page, '1-projects');
    await page.locator('.wc-r [role=switch]').first().click();
    expect(await page.locator('.wc-r [role=switch][aria-checked=false]').count() === 1, 'a project can be switched off');
    await page.locator('.wc-r [role=switch]').first().click();
    await page.locator('.wc-more').click();
    expect(await page.locator('.wc-r').count() === 9 && await page.locator('.wc-more').count() === 0, '"and 1 more" opens the full list in place');
    // Return takes the primary action: Continue.
    await page.locator('.wc').focus();
    await page.keyboard.press('Enter');
    await settle(page, 400);
    s = await state(page);
    expect(s.title === 'Your agents' && s.marks === 1, `Return takes the primary action: "${s.title}"`);
    await shot(page, '2-agents');
    expect(await page.getByRole('radiogroup', { name: 'New tasks start with' }).count() === 1, 'step 2 has the chooser "New tasks start with"');
    await page.locator('#wc-go').click();
    await settle(page, 400);
    s = await state(page);
    expect(s.title === 'Let Tasktap find the project for each task', `step 3: "${s.title}"`);
    expect(await page.locator('.wc-o > .wc-card').count() === 2 && await page.locator('#wc-go .key').textContent() === 'Sign in with ChatGPT', 'step 3 has two cards, ChatGPT and Your agents, and "Sign in with ChatGPT" is the primary action');
    expect(await page.locator('.wc .sends').count() === 0, 'what is sent is not on the surface before it is asked for');
    await shot(page, '3-placing');
    await page.getByRole('button', { name: 'What is sent' }).click();
    await settle(page, 300);
    const sends = await page.locator('.wc .sends li').allTextContents();
    expect(sends.length > 0 && /password/i.test(sends.join(' ')), `"What is sent" opens the core's full list, one action away (${sends.length} lines)`);
    await shot(page, '3-placing-what-is-sent');
    expect(!(await state(page)).dots && (await state(page)).rings === 0, 'no "·" and no ring in the welcome');
    // Return takes the primary action: the sign-in with ChatGPT is asked for.
    await page.locator('.wc').focus();
    await page.keyboard.press('Enter');
    await settle(page, 300);
    expect(await page.evaluate(() => JSON.stringify(window.__fake.calls).includes('chatgpt.sign_in')), 'Return asks for the sign-in with ChatGPT');
    // Skip leaves the step open.
    await page.getByRole('button', { name: 'Skip' }).click();
    await settle(page, 400);
    s = await state(page);
    expect(s.title === 'Talk instead of typing', `Skip goes on: "${s.title}"`);
    await shot(page, '4-voice');
    expect(await page.locator('.wc-d dd').first().textContent() !== '' && /Not downloaded|Ready|Downloading/.test(await page.locator('.wc-d').innerText()), 'step 4 shows the key and the state of speech recognition as data');
    // Esc leaves: Home, with the cursor in the Composer, and one quiet line to finish.
    await page.locator('.wc').focus();
    await page.keyboard.press('Escape');
    await settle(page, 500);
    s = await state(page);
    expect(!s.welcome && s.home && s.focus === 'capture-input', `Escape leaves the welcome: Home with the cursor in the Composer (${s.focus})`);
    expect(s.finish.length === 1 && s.finish[0] === 'Finish setup', `a step left open: one quiet line "${s.finish[0]}"`);
    await shot(page, '6-home-finish-setup');
    await page.locator('.finish').click();
    await settle(page, 400);
    s = await state(page);
    expect(s.welcome && s.title !== '', `"Finish setup" comes back to the first open step ("${s.title}")`);
    await page.context().close();

    // ——— Step 1 with 59 projects found ———
    const many = speech(projects('first-agents'));
    many.found = [...many.found, ...Array.from({ length: 50 }, (_, i) => ({ ...many.found[i % 9], id: `019a8b6c-7d10-7000-8000-9${String(i).padStart(11, '0')}`, name: `${many.found[i % 9].name}-${i + 2}`, folder: `${many.found[i % 9].folder}-${i + 2}` }))];
    page = await open(browser, { label: 'workspace', records: many, url: server.url, dpr: 2 });
    await ready(page);
    await settle(page, 9000);
    expect(await page.locator('.wc-k').textContent() === '59 found' && await page.locator('.wc-r').count() === 8 && await page.locator('.wc-more').textContent() === 'and 51 more', 'with 59 found: the count beside the headline, eight rows, "and 51 more"');
    await shot(page, '1-projects-59');
    await page.locator('.wc-more').click();
    await settle(page, 300);
    expect(await page.locator('.wc-r').count() === 59 && await page.evaluate(() => { const l = document.querySelector('.wc-l'); return l.scrollHeight > l.clientHeight; }), '"and 51 more" opens all 59 in place, in a list that scrolls');
    await shot(page, '1-projects-59-all');
    await page.context().close();

    // ——— A later start: no welcome by itself ———
    page = await open(browser, { label: 'workspace', records: speech(scene('normal')), url: server.url, dpr: 2 });
    await ready(page);
    await settle(page, 1200);
    s = await state(page);
    expect(!s.welcome && s.home, 'a later start shows Home, not the welcome');
    await page.context().close();

    // ——— Step 1 with nothing found ———
    page = await open(browser, { label: 'workspace', records: speech(projects('first-searched', { some: 0 })), url: server.url, dpr: 2 });
    await ready(page);
    await settle(page, 3500);
    s = await state(page);
    expect(s.title === 'No projects found in your home folder' && await page.locator('#wc-go').textContent() === 'Search in a folder…', `nothing found: "${s.title}" with "Search in a folder…" as the primary action`);
    await shot(page, '1-projects-none');
    await page.context().close();

    // ——— Step 3 with a server answering on this machine: a third card, and the same three fields in place ———
    const OLLAMA = 'http://127.0.0.1:11434/v1';
    page = await open(browser, { label: 'workspace', records: { ...speech(projects('first-agents')), servers: { [OLLAMA]: ['llama3.1:8b', 'qwen2.5-coder:7b', 'gemma3:4b'] } }, url: server.url, dpr: 2 });
    await ready(page);
    await settle(page, 1500);
    await page.locator('#wc-go').click();
    await settle(page, 400);
    await page.locator('#wc-go').click();
    await settle(page, 700);
    const cards = await page.locator('.wc-o > .wc-card .wc-t').allTextContents();
    expect(/^ChatGPT\|Your agents\|On this (Mac|PC)$/.test(cards.join('|')) && await page.locator('.wc-o > .wc-card', { hasText: 'Use Ollama' }).count() === 1, `with a server found on this machine step 3 has a third card with "Use Ollama": ${cards.join(', ')}`);
    const wide = await page.evaluate(() => { const o = document.querySelector('.wc-o'), i = document.querySelector('.wc-i'); return o.scrollWidth <= o.clientWidth + 1 && o.getBoundingClientRect().right <= i.getBoundingClientRect().right; });
    expect(wide, 'the three cards fit the panel');
    const built = await page.evaluate(() => [...document.querySelectorAll('.wc-o > .wc-card')].map((c) => { const r = (e) => e.getBoundingClientRect(), b = c.lastElementChild, t = c.querySelector(':scope > .wc-t'), m = c.querySelector('.wc-c2 svg'), k = [...c.children].map((e) => e.tagName + '.' + e.className.split(' ')[0]).join(' '); return { tag: c.tagName, top: Math.round(r(t).top), button: Math.round(r(b).bottom), height: Math.round(r(b).height), card: Math.round(r(c).bottom), mark: Math.round(r(m).width), kids: k }; }));
    expect(built.every((c) => c.tag === 'BUTTON' && c.top === built[0].top && c.button === built[0].button && c.height === built[0].height && c.card === built[0].card && /^SPAN\.wc-t SPAN\.wc-c2 SPAN\.(key|btn)$/.test(c.kids)), `the cards are built alike, each one button: title, mark, the action at the foot, on the same lines: ${JSON.stringify(built)}`);
    expect(built.every((c) => c.mark >= 32) && built[0].mark === 40, `the marks are large enough to read at a glance (${built.map((c) => c.mark)} px, ChatGPT's 40)`);
    expect(await page.locator('#wc-go').count() === 1 && await page.locator('.wc-o #wc-go').count() === 1 && await page.locator('.wc-a').locator('button').count() === 0, 'ChatGPT\'s card holds the primary key, and none stands under the cards');
    // The whole card is the target: its rim lights under the pointer and with the keyboard, and a click anywhere takes its action.
    const rim = (n) => page.evaluate((i) => { const c = document.querySelectorAll('.wc-o > .wc-card')[i]; return [getComputedStyle(c, '::after').opacity, getComputedStyle(c).backgroundColor, getComputedStyle(c).cursor]; }, n);
    await page.mouse.move(2, 2);
    await settle(page, 400);
    const rest = await rim(1);
    await shot(page, '5-welcome-step-3');
    await page.locator('.wc-o > .wc-card').nth(1).hover({ position: { x: 20, y: 20 } });
    await settle(page, 600);
    const under = await rim(1);
    expect(rest[0] === '0' && under[0] !== '0' && under[1] !== rest[1] && under[2] === 'pointer', `a card lights under the pointer, where it is touched anywhere: rim ${rest[0]} to ${under[0]}, ${rest[1]} to ${under[1]}, ${under[2]}`);
    await shot(page, '5-welcome-step-3-pointer');
    await page.mouse.move(2, 2);
    await page.locator('.wc-o > .wc-card').nth(1).focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await settle(page, 600);
    expect((await rim(1))[0] !== '0', 'and with the keyboard');
    await page.mouse.move(2, 2);
    await shot(page, '3-placing-third-card');
    await page.locator('.wc-o > .wc-card', { hasText: 'Use Ollama' }).click();
    await settle(page, 700);
    const open3 = await page.evaluate(() => ({ address: document.querySelector('#own-address')?.value, model: document.querySelector('#own-model')?.tagName, key: document.querySelector('#own-key')?.type, labels: [...document.querySelectorAll('.wc .own label')].map((l) => l.textContent).join() }));
    expect(open3.address === OLLAMA && open3.model === 'SELECT' && open3.key === 'password' && open3.labels === 'Address,Model,Key', `"Use Ollama" opens the three fields in place with the address filled: ${JSON.stringify(open3)}`);
    await shot(page, '3-placing-use-ollama');
    await page.locator('.wc .own .btn', { hasText: 'Use' }).first().click();
    await settle(page, 700);
    s = await state(page);
    expect(s.title === 'Talk instead of typing' && await page.evaluate(() => window.__fake.records.prefs.find((p) => p.id === 'own_model')?.value.address) === OLLAMA, `Use sets it up and goes on: "${s.title}"`);
    await page.context().close();

    // ——— Speech downloading, as data ———
    page = await open(browser, { label: 'workspace', records: speech(projects('first-agents'), 'fetching'), url: server.url, dpr: 2 });
    await ready(page);
    await settle(page, 1000);
    await page.evaluate(() => { window.__ws.show('home'); });
    await page.evaluate(() => document.querySelector('.wc-skip').click());
    await page.evaluate(() => document.querySelector('.wc-skip').click());
    await page.evaluate(() => document.querySelector('.wc-skip').click());
    await settle(page, 500);
    expect(/Downloading/.test(await page.locator('.wc-d').innerText()) && await page.locator('.wc-d progress').count() === 1, 'speech downloading is shown as a state and a progress, not a sentence');
    await shot(page, '4-voice-downloading');
    await page.context().close();

    // ——— Settings › Placing, lean ———
    page = await open(browser, { label: 'workspace', records: speech(scene('normal')), url: server.url, dpr: 2 });
    await ready(page);
    await page.evaluate(() => ((window.__ws.ui.sheet = { kind: 'settings', at: 'placing' }), window.__motion.redraw()));
    await settle(page, 800);
    const surface = await page.locator('.sheet').innerText();
    expect(!/included in your subscription|billed by your provider|drag moves a row|Antigravity keeps/.test(surface) && !surface.includes('·') && await page.locator('.sheet .sends').count() === 0, 'Settings › Placing has none of the five-line list, the subscription words, the key hints or the Antigravity paragraph on its surface');
    expect(/Tasks you do not place yourself/.test(surface) && /Sign in with ChatGPT/.test(surface) && /The instructions they follow/.test(surface) && /What is sent/.test(surface), 'it has the switch, "Sign in with ChatGPT", "What is sent" and "The instructions they follow"');
    await page.locator('.set-pane .rank[tabindex="0"]').first().focus();
    await settle(page, 200);
    expect(/moves a row/.test(await page.locator('.sh-hint').textContent()), 'the key hints are in the foot while a row has the keyboard');
    await sheet(page, '5-placing-section');
    await page.getByRole('button', { name: 'What is sent' }).click();
    await settle(page, 200);
    expect(await page.locator('.sheet .sends li').count() > 0, 'the full list is one action away');
    await page.context().close();

    // ——— Settings › Agents with the agents' own marks ———
    const r = scene('busy'), base = r.agents[0];
    for (const [id, name] of [['agy', 'Antigravity'], ['opencode', 'OpenCode'], ['copilot', 'Copilot'], ['cursor', 'Cursor'], ['gemini', 'Gemini CLI'], ['aider', 'Aider'], ['goose', 'Goose'], ['droid', 'Droid']]) r.agents.push({ ...base, id, name, program: id, version: '1.0.0', identity: null, rev: 6 });
    page = await open(browser, { label: 'workspace', records: r, url: server.url, dpr: 2 });
    await ready(page);
    await page.evaluate(() => ((window.__ws.ui.sheet = { kind: 'settings', at: 'agents' }), window.__motion.redraw()));
    await settle(page, 900);
    const lettered = await page.evaluate(() => [...document.querySelectorAll('.line.ag')].map((l) => [l.dataset.agent, l.querySelector('.amark text')?.textContent ?? null]).filter(([, t]) => t));
    console.log(`     lettered still: ${JSON.stringify(lettered)}`);
    await page.locator('.sheet').screenshot({ path: path.join(out, '7-agents-marks.png') });
    await page.evaluate(() => ((window.__ws.ui.sheet = { kind: 'settings', at: 'about' }), window.__motion.redraw()));
    await settle(page, 400);
    const about = await page.locator('.set-pane').innerText();
    expect(/Welcome/.test(about) && /Show again/.test(about) && about.includes('Product names and marks belong to their makers.') && !about.includes('·'), 'Settings › About has "Welcome" with "Show again" and the line on product names and marks');
    await page.locator('.set-pane .set:has(> .t:text-is("Welcome")) .btn').click();
    await settle(page, 400);
    s = await state(page);
    expect(s.welcome && !(await page.locator('.sheet').count()), '"Show again" shows the welcome');
    await page.context().close();
  } finally {
    await browser.close();
    await server.close();
  }
  for (const f of failures) console.log('FAIL  ' + f);
  console.log(failures.length ? `FAIL  ${failures.length} checks of the welcome` : `PASS  the welcome, Settings › Placing and the marks; pictures in ${out}`);
  process.exitCode = failures.length ? 1 : 0;
}
main().catch((e) => (console.error(e), process.exit(1)));
