// What an open preview costs at rest, in the built app: processor use and wakeups from idle of the app's own
// processes (the host, its core, its web views) with a terminal alone, then with previews open beside it and nothing
// happening: Markdown and a picture, drawn by the page; then a page in a frame as well. A preview asks about its file
// only when its terminal has gone quiet after output, when the window comes back into use and on Reload, so at rest
// there is nothing to pay. Passive, on a temporary data folder, with files of the check's own.
// usage: node scripts/preview-cost.cjs [--exe file] [--seconds n]   (exit status 1 when previews at rest add 0.3 % of a core or more)
const fs = require('node:fs');
const path = require('node:path');
const { launch, sleep } = require('./app-driver.cjs');
const arg = (name, or) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : or);

async function main() {
  const seconds = Number(arg('--seconds', 30)), app = await launch(arg('--exe', '') ? { exe: arg('--exe') } : {});
  const ws = (e) => app.ask('workspace', e);
  try {
    await app.until('workspace', '__ws.ui.ready', 'true');
    const project = await ws(`__ws.call('host.pick', { folder: true }).then((folder) => __ws.call('project.add', { id: __ws.uuid7(), folder }))`);
    await sleep(500);
    const terminal = await ws(`(__ws.show(${JSON.stringify(project)}), __ws.newTerminal(${JSON.stringify(project)}))`);
    await app.until('workspace', `__ws.records.terminals.get('${terminal}')?.state + ' ' + __ws.engines.get('${terminal}')?.attached`, 'running true');
    fs.writeFileSync(path.join(app.project, 'notes.md'), '# Notes\n\n' + 'A line of the notes, with **strong** words and `code`.\n\n'.repeat(200));
    fs.writeFileSync(path.join(app.project, 'drawing.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#234"/><circle cx="320" cy="200" r="120" fill="#eab676"/></svg>');
    fs.writeFileSync(path.join(app.project, 'report.html'), '<!doctype html><title>Report</title><h1>Report</h1><p>A page that does nothing by itself.</p>');
    const measure = async (name) => {
      await sleep(5000);
      const c = await app.cost(seconds);
      console.log(`  ${name}: ${c.cpu} % of a core, ${c.wakeups} wakeups a second (${Object.entries(c.by).map(([who, x]) => `${who} ${x.cpu} %`).join(', ')})`);
      return c;
    };
    const show = async (file) => {
      await ws(`(__ws.follow('${terminal}', { kind: 'path', target: ${JSON.stringify(file)} }, ${JSON.stringify(app.project)}, {}), 1)`);
      if (!(await app.until('workspace', `[...__ws.records.previews.values()].map((p) => p.title).join()`, file))) throw new Error(`${file} was not shown`);
    };
    console.log(`At rest, over ${seconds} s each:`);
    const alone = await measure('a terminal alone');
    await show('notes.md');
    await show('drawing.svg');
    const drawn = await measure('with Markdown and a picture beside it');
    await show('report.html');
    const framed = await measure('with a page in a frame as well');
    const added = Math.max(drawn.cpu, framed.cpu) - alone.cpu;
    console.log(added < 0.3 ? `PASS  previews at rest add ${Math.max(0, Math.round(added * 10) / 10)} % of a core (${alone.cpu} % with a terminal alone, ${drawn.cpu} % with two drawn by the page, ${framed.cpu} % with a frame as well)`
      : `FAIL  previews at rest add ${Math.round(added * 10) / 10} % of a core`);
    process.exitCode = added < 0.3 ? 0 : 1;
  } finally {
    await app.quit();
  }
}
main().catch((e) => (console.error(e), process.exit(1)));
