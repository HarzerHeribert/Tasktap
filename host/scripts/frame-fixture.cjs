// frame-fixture.py for a machine without Python (host/scripts/smoke.ps1): a web server of the check's own, on this
// machine, for what a preview's frame is held to (host/src/frames.rs). It serves frame-probe.html, a page that
// tries everything a frame may not do, at /probe.html; a plain page at /; and /away, which sends whoever asks to an
// address that is not this machine's by the rule. It notes every request it gets, a socket's among them, with the
// name it was asked under, in a log: the check reads there whether anything it must not see arrived. It prints its
// port, and the spelling of an address that reaches it and that the rule calls remote (`localhost.` with its stop,
// or `0.0.0.0`), or `none` when this machine reaches it by neither. Nothing here leaves the machine.
//   node frame-fixture.cjs <log> <frame-probe.html>
const fs = require('node:fs');
const http = require('node:http');
const [log, probe] = process.argv.slice(2);
let remote = 'none';
const note = (request) => fs.appendFileSync(log, `${request.headers.host ?? ''} ${request.url}\n`);
const server = http.createServer((request, response) => {
  note(request);
  const path = request.url.split('?')[0];
  const send = (body, kind) => {
    response.writeHead(200, { 'content-type': kind, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
    response.end(body);
  };
  if (path === '/away') {
    response.writeHead(302, { location: `http://${remote}/leak-redirect` });
    response.end();
  } else if (path.startsWith('/leak') || path === '/self') send('leaked', 'text/plain');
  else if (path === '/probe.html') send(fs.readFileSync(probe), 'text/html; charset=utf-8');
  else if (path === '/') send('<!doctype html><title>Fixture</title><body style="font:16px system-ui;margin:24px"><h1>It works</h1><p>Served on this machine.</p><a id="out" href="https://example.com/elsewhere">A link to the web</a>', 'text/html; charset=utf-8');
  else {
    response.writeHead(404);
    response.end();
  }
});
server.on('upgrade', (request, socket) => {
  note(request);
  socket.destroy();
});
const reaches = (name, port) => new Promise((done) => {
  const asked = http.get({ host: name, port, path: '/self', timeout: 2000 }, (answer) => {
    let body = '';
    answer.on('data', (part) => (body += part));
    answer.on('end', () => done(body === 'leaked'));
  });
  asked.on('timeout', () => asked.destroy());
  asked.on('error', () => done(false));
});
server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  for (const name of ['localhost.', '0.0.0.0']) {
    if (await reaches(name, port)) {
      remote = `${name}:${port}`;
      break;
    }
  }
  console.log(`${port} ${remote}`);
});
