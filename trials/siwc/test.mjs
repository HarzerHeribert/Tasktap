// What can be proved without the owner's sign-in: the URL and PKCE, the loopback listener, the sign-in, renewal and
// rotation against a local stand-in (standin.mjs), the stream reader on the documented events, the stops, the limit
// of 60 requests, the copy of the product's question and judgement, and that nothing identifying is printed or
// written. Nothing here reaches OpenAI.
//
//   node --test trials/siwc/test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { measure } from './measure.mjs';
import { SCHEMA, accept, fixture, instructions, judge, productQuestion, rustSchema } from './route.mjs';
import { dryRun, forget, signIn } from './signin.mjs';
import {
  FIRST_CLIENT, HERE, REPO, SCOPES, attempt, authorizeUrl, challengeOf, events, fresh, listen, network, readRecord,
  readStream, settings, verifyIdToken, writeRecord,
} from './siwc.mjs';
import { standIn } from './standin.mjs';

const fx = fixture();
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'siwc-test-'));

/** A project's name or a session's key as the key the request offers it under. */
function key(name) {
  const s = fx.sessions.findIndex((x) => x.key === name);
  return s >= 0 ? `s${s + 1}` : `p${fx.projects.findIndex((p) => p.name === name) + 1}`;
}

/** The answer route-eval counts right, written as a model would. */
function answerFor(t, change = {}) {
  const e = t.expect;
  const a = { quote: '', confidence: e.confidence, to: '', candidates: [], brief: t.text, title: 'A title' };
  if (e.confidence === 'clear') Object.assign(a, { to: key(e.to[0]), quote: t.text.split(/\s+/).slice(0, 3).join(' ') });
  if (e.confidence === 'ambiguous') a.candidates = (e.among.length ? e.among : ['folio', 'kiln']).map(key);
  if (e.confidence === 'unknown') Object.assign(a, { brief: '', title: '' });
  return JSON.stringify({ ...a, ...change });
}

/** The stand-in answers each thought right, finding it by the request in the call. */
function rightAnswers(body) {
  const req = JSON.parse(body.input[0].content.slice('<request>\n'.length, -'\n</request>\n'.length));
  return answerFor(fx.thoughts.find((t) => t.text === req.thought));
}

async function signedIn(options = {}) {
  const si = await standIn({ answer: rightAnswers, ...options });
  const dir = await tmp();
  const s = settings(si.env(path.join(dir, 'config', 'siwc.json')));
  const logs = [];
  const open = (url) => { fetch(url).catch(() => {}); };
  const result = await signIn({ s, net: network(), open, log: (x) => logs.push(x), timeoutMs: 10_000 });
  return { si, s, dir, logs, result };
}

function secretsOf(rec, si) {
  return [rec.access_token, rec.refresh_token, rec.id_token, rec.client_id, rec.subject, rec.ext_agent_host_id, si.st.email]
    .filter(Boolean);
}

test('PKCE: the RFC 7636 example, and fresh values of the right shape', () => {
  assert.equal(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const a = attempt();
  const b = attempt();
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.challenge, challengeOf(a.verifier));
  assert.doesNotMatch(a.challenge, /[=+/]/);
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.nonce, b.nonce);
});

test('the authorisation URL: a first registration, and signing in again', () => {
  const s = settings({});
  const a = attempt();
  const common = { hostId: 'urn:uuid:4b1c2f7e-9a51-4d0e-8f3c-2a6b9e1d7c50', redirectUri: 'http://127.0.0.1:54321/auth/callback', state: a.state, nonce: a.nonce, challenge: a.challenge };
  const first = new URL(authorizeUrl(s, { clientId: null, ...common }));
  assert.equal(`${first.origin}${first.pathname}`, 'https://auth.openai.com/api/accounts/authorize');
  assert.deepEqual(Object.fromEntries(first.searchParams), {
    client_id: FIRST_CLIENT,
    agent_name_hint: 'Tasktap trial',
    ext_agent_host_id: common.hostId,
    response_type: 'code',
    redirect_uri: common.redirectUri,
    scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    resource: 'https://api.openai.com/v1',
    state: a.state,
    nonce: a.nonce,
    code_challenge_method: 'S256',
    code_challenge: a.challenge,
  });
  const raw = authorizeUrl(s, { clientId: null, ...common });
  assert.match(raw, /scope=openid%20profile%20email%20offline_access%20resource\.invoke%20chatgpt\.tokens\.use\.direct&/);
  assert.match(raw, /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A54321%2Fauth%2Fcallback&/);
  assert.doesNotMatch(raw, /localhost|id_token_hint|login_hint/);
  const again = new URL(authorizeUrl(s, { clientId: 'oaiapp_issued', ...common }));
  assert.equal(again.searchParams.get('client_id'), 'oaiapp_issued');
  assert.equal(again.searchParams.has('agent_name_hint'), false);
  assert.equal(again.searchParams.get('ext_agent_host_id'), common.hostId);
});

test('settings: the record outside the repository, and only OpenAI or a loopback stand-in', () => {
  assert.throws(() => settings({ SIWC_RECORD: path.join(REPO, 'siwc.json') }), /outside the repository/);
  assert.throws(() => settings({ SIWC_RECORD: path.join(HERE, 'siwc.json') }), /outside the repository/);
  assert.throws(() => settings({ SIWC_API_BASE: 'https://chatgpt.com/backend-api' }), /not an address/);
  assert.throws(() => settings({ SIWC_API_BASE: 'http://localhost:9/v1' }), /not an address/);
  assert.throws(() => settings({ SIWC_AUTH_BASE: 'http://auth.openai.com' }), /not an address/);
  assert.equal(settings({}).record, path.join(os.homedir(), '.config', 'tasktap-test', 'siwc.json'));
});

test('the listener: 127.0.0.1, its own callback only, then closed', async () => {
  const l = await listen({ state: 'the-state', timeoutMs: 5000 });
  assert.match(l.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  const at = new URL(l.redirectUri);
  assert.equal((await fetch(new URL('/callback?state=the-state', at))).status, 404);
  assert.equal((await fetch(`${l.redirectUri}?code=x&state=another`)).status, 400);
  const answered = await fetch(`${l.redirectUri}?code=the-code&state=the-state&client_id=oaiapp_x&scope=openid`);
  assert.equal(answered.status, 200);
  assert.match(await answered.text(), /close this tab/);
  assert.deepEqual(await l.result, { code: 'the-code', state: 'the-state', client_id: 'oaiapp_x', scope: 'openid' });
  await assert.rejects(fetch(`${l.redirectUri}?code=again&state=the-state`));
});

test('the listener gives up when no browser comes back', async () => {
  const l = await listen({ state: 's', timeoutMs: 50 });
  await assert.rejects(l.result, /no answer from the browser/);
});

test('sign-in against the stand-in: registered, exchanged, checked, stored 600, nothing secret printed', async () => {
  const { si, s, logs, result } = await signedIn();
  try {
    assert.deepEqual(si.st.problems, []);
    assert.equal(result.ok, true);
    assert.equal(result.plan, true);
    const rec = await readRecord(s.record);
    assert.equal(rec.client_id, si.st.issued);
    assert.equal(rec.subject, si.st.subject);
    assert.match(rec.ext_agent_host_id, /^urn:uuid:/);
    assert.deepEqual([...rec.scopes].sort(), [...SCOPES].sort());
    assert.ok(rec.access_token && rec.refresh_token && rec.id_token);
    const { id_token: _, ...plain } = rec;
    assert.equal(JSON.stringify(plain).includes(si.st.email), false);
    assert.equal((await fs.stat(s.record)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(s.record))).mode & 0o777, 0o700);
    const printed = [...logs, result.said].join('\n');
    for (const secret of [rec.access_token, rec.refresh_token, rec.id_token, rec.subject, si.st.email]) {
      assert.equal(printed.includes(secret), false);
    }

    // Again: the issued client id and the same host id, no name, the tokens replaced.
    const again = await signIn({ s, net: network(), open: (u) => { fetch(u).catch(() => {}); }, log: () => {}, timeoutMs: 10_000 });
    assert.equal(again.ok, true);
    assert.deepEqual(si.st.problems, []);
    const rec2 = await readRecord(s.record);
    assert.equal(rec2.client_id, rec.client_id);
    assert.equal(rec2.ext_agent_host_id, rec.ext_agent_host_id);
    assert.notEqual(rec2.access_token, rec.access_token);

    // --forget ends the session at the revocation endpoint and deletes the record.
    const said = await forget({ s, net: network() });
    assert.match(said, /OpenAI confirmed/);
    assert.deepEqual(si.st.revoked, [rec2.refresh_token]);
    assert.equal(existsSync(s.record), false);
  } finally {
    await si.close();
  }
});

test('the ID token: a wrong nonce, client, issuer or signature is refused', async () => {
  const si = await standIn();
  try {
    const s = settings(si.env(path.join(await tmp(), 'r.json')));
    const now = Math.floor(Date.now() / 1000);
    const good = { iss: si.base, aud: 'oaiapp_a', sub: 'u', iat: now, exp: now + 3600, nonce: 'n' };
    const check = (claims, over = {}) => verifyIdToken(s, network(), si.idToken(claims), { jwksUri: `${si.base}/.well-known/jwks.json`, clientId: 'oaiapp_a', nonce: 'n', ...over });
    assert.equal((await check(good)).sub, 'u');
    await assert.rejects(check({ ...good, nonce: 'other' }), /another sign-in attempt/);
    await assert.rejects(check({ ...good, aud: 'oaiapp_b' }), /another client/);
    await assert.rejects(check({ ...good, iss: 'https://elsewhere.example' }), /another issuer/);
    await assert.rejects(check({ ...good, exp: now - 3600 }), /expired/);
    const [h, , sig] = si.idToken(good).split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...good, sub: 'someone else' })).toString('base64url')}.${sig}`;
    await assert.rejects(verifyIdToken(s, network(), forged, { jwksUri: `${si.base}/.well-known/jwks.json`, clientId: 'oaiapp_a', nonce: 'n' }), /signature/);
  } finally {
    await si.close();
  }
});

test('declining in the browser stores nothing but the host id', async () => {
  const { si, s, result } = await signedIn({ deny: true });
  try {
    assert.equal(result.ok, false);
    assert.match(result.said, /declined/);
    assert.deepEqual(Object.keys(await readRecord(s.record)), ['ext_agent_host_id']);
  } finally {
    await si.close();
  }
});

test('renewal: near expiry it renews, writes the replacement back, and the old refresh token is dead', async () => {
  const { si, s } = await signedIn();
  try {
    const first = await readRecord(s.record);
    const r0 = await fresh(s, network());
    assert.equal(r0.refreshed, false);
    await writeRecord(s.record, { ...first, saved_at: new Date(Date.now() - 55 * 60_000).toISOString() });
    const r1 = await fresh(s, network());
    assert.equal(r1.refreshed, true);
    assert.equal(r1.rotated, true);
    const stored = await readRecord(s.record);
    assert.equal(stored.refresh_token, r1.record.refresh_token);
    assert.notEqual(stored.refresh_token, first.refresh_token);
    assert.notEqual(stored.access_token, first.access_token);
    assert.equal(stored.id_token, first.id_token);
    assert.equal(stored.client_id, first.client_id);
    assert.equal((await fs.stat(s.record)).mode & 0o777, 0o600);
    assert.equal(existsSync(`${s.record}.lock`), false);
    const r2 = await fresh(s, network(), { force: true });
    assert.equal(r2.refreshed, true);
    assert.deepEqual(si.st.problems, []);
    // The replaced token, used again, is refused: the person is told to sign in again.
    await writeRecord(s.record, { ...(await readRecord(s.record)), refresh_token: first.refresh_token });
    await assert.rejects(fresh(s, network(), { force: true }), (e) => e.code === 'refresh_token_reused' && e.signInAgain);
  } finally {
    await si.close();
  }
});

test('renewal waits for earliest_refresh_at when it is not needed yet', async () => {
  const { si, s } = await signedIn({ earliestRefreshAt: Math.floor(Date.now() / 1000) + 1800 });
  try {
    const r = await fresh(s, network(), { force: true });
    assert.equal(r.refreshed, false);
    assert.match(r.why, /not to renew before/);
  } finally {
    await si.close();
  }
});

test('the stream reader: the documented events, whole, cut byte by byte, with CRLF, and cut short', async () => {
  const doc = await fs.readFile(path.join(HERE, 'fixtures', 'completed.sse'));
  const text = "In a shimmering forest under a sky full of stars, a lonely unicorn named Lila discovered a hidden pond that glowed with moonlight. Every night, she would leave sparkling, magical flowers by the water's edge, hoping to share her beauty with others. One enchanting evening, she woke to find a group of friendly animals gathered around, eager to be friends and share in her magic.";
  async function* chunks(buf, size) {
    for (let i = 0; i < buf.length; i += size) yield new Uint8Array(buf.subarray(i, i + size));
  }
  for (const [label, buf, size] of [['whole', doc, doc.length], ['byte by byte', doc, 1], ['CRLF', Buffer.from(doc.toString().replace(/\n/g, '\r\n')), 7]]) {
    const r = await readStream(chunks(buf, size), { started: 0, clock: () => 5 });
    assert.equal(r.status, 'completed', label);
    assert.equal(r.text, text, label);
    assert.deepEqual(r.usage.output_tokens_details, { reasoning_tokens: 0 }, label);
    assert.equal(r.seen['response.output_text.delta'], 5, label);
    assert.equal(r.firstByteMs, 5);
  }
  const all = [];
  for await (const e of events(chunks(doc, 13))) all.push(e.event);
  assert.deepEqual(all, ['response.created', ...Array(5).fill('response.output_text.delta'), 'response.output_text.done', 'response.completed']);
  const cut = doc.subarray(0, doc.indexOf('event: response.completed'));
  const short = await readStream(chunks(cut, 64), { started: 0 });
  assert.equal(short.status, 'interrupted');
  assert.equal(short.text, text);
  const limit = await readStream(chunks(await fs.readFile(path.join(HERE, 'fixtures', 'usage-limit.sse')), 50), { started: 0 });
  assert.equal(limit.status, 'failed');
  assert.equal(limit.error.code, 'subscription_sharing_usage_limit_exceeded');
});

test('measure: the smallest listed models, 14 thoughts each, as the product asks, and no identifier in its files', async () => {
  const { si, s, dir } = await signedIn();
  try {
    const out = await measure({ s, net: network({ budget: 60 }), outDir: path.join(dir, 'out'), log: () => {} });
    assert.equal(out.stopped, null);
    assert.deepEqual(out.chosen.slugs, ['gpt-6-nano', 'gpt-6-luna']);
    assert.equal(out.requests, 1 + 28);
    assert.equal(si.st.inference, 28);
    assert.deepEqual(si.st.problems, []);
    for (const m of out.measured) {
      assert.equal(m.format_accepted, true);
      assert.equal(m.cases.length, 14);
      assert.deepEqual(m.cases.map((c) => c.outcome), Array(14).fill('right'));
      assert.equal(m.cases[0].tokens.input, 2400);
      assert.equal(m.cases[0].cost_headers['x-ratelimit-remaining-requests'], '97');
    }
    const want = instructions();
    for (const b of si.st.bodies) {
      assert.equal(b.instructions, want);
      assert.deepEqual(b.text.format.schema, SCHEMA);
      assert.equal(b.text.format.strict, true);
      assert.deepEqual(b.reasoning, { effort: 'low' });
      assert.equal(b.input.length, 1);
      assert.equal(b.input[0].role, 'user');
    }
    const rec = await readRecord(s.record);
    const written = (await fs.readFile(path.join(dir, 'out', 'results.json'), 'utf8')) + (await fs.readFile(path.join(dir, 'out', 'results.md'), 'utf8'));
    for (const secret of secretsOf(rec, si)) assert.equal(written.includes(secret), false);
    assert.match(written, /\| gpt-6-nano \| accepted \| 14 of 14 \| 0 \| 0 \| 0 \|/);
  } finally {
    await si.close();
  }
});

for (const [what, plan, status] of [
  ['429 before the stream', (n) => (n === 3 ? '429' : 'ok'), 429],
  ['403 before the stream', (n) => (n === 3 ? '403' : 'ok'), 403],
  ['the plan\'s limit inside the stream', (n) => (n === 3 ? 'limit-in-stream' : 'ok'), 'in the stream (failed)'],
]) {
  test(`measure stops at the first ${what} and asks nothing more`, async () => {
    const { si, s, dir } = await signedIn({ plan });
    try {
      const out = await measure({ s, net: network({ budget: 60 }), outDir: dir, log: () => {} });
      assert.equal(si.st.inference, 3);
      assert.equal(out.requests, 4);
      assert.equal(out.stopped.status, status);
      assert.match(out.stopped.code, /^subscription_sharing_/);
      assert.equal(out.measured[0].cases.length, 2);
      assert.match(await fs.readFile(path.join(dir, 'results.md'), 'utf8'), /Stopped at gpt-6-nano, [\w-]+: /);
    } finally {
      await si.close();
    }
  });
}

test('measure: a refused answer format is dropped, said, and the rest still measured', async () => {
  const { si, s, dir } = await signedIn({ plan: () => 'refuse-format' });
  try {
    const out = await measure({ s, net: network({ budget: 60 }), args: { models: ['gpt-6-luna'] }, outDir: dir, log: () => {} });
    const m = out.measured[0];
    assert.equal(m.format_accepted, false);
    assert.match(m.format_refused_with, /subscription_sharing_unsupported_capability/);
    assert.equal(si.st.inference, 15);
    assert.deepEqual(m.cases.map((c) => c.outcome), Array(14).fill('right'));
    assert.match(await fs.readFile(path.join(dir, 'results.md'), 'utf8'), /refused: subscription_sharing_unsupported_capability/);
  } finally {
    await si.close();
  }
});

test('measure: a stream that ends early counts as refused for that thought only', async () => {
  const { si, s, dir } = await signedIn({ plan: (n) => (n === 2 ? 'cut' : 'ok') });
  try {
    const out = await measure({ s, net: network({ budget: 60 }), args: { models: ['gpt-6-luna'] }, outDir: dir, log: () => {} });
    assert.equal(out.stopped, null);
    assert.equal(out.measured[0].cases[1].outcome, 'refused');
    assert.match(out.measured[0].cases[1].why, /interrupted/);
    assert.equal(out.measured[0].cases.filter((c) => c.outcome === 'right').length, 13);
  } finally {
    await si.close();
  }
});

test('measure never sends more than 60 requests', async () => {
  const { si, s, dir } = await signedIn();
  try {
    const net = network({ budget: 60 });
    const out = await measure({ s, net, args: { models: ['a', 'b', 'c', 'd', 'e'] }, outDir: dir, log: () => {} });
    assert.equal(net.used, 60);
    assert.equal(si.st.inference, 59);
    assert.match(out.stopped.message, /limit of 60 requests/);
  } finally {
    await si.close();
  }
});

test('measure without a sign-in says so and sends nothing', async () => {
  const s = settings({ SIWC_RECORD: path.join(await tmp(), 'none.json') });
  const net = network({ budget: 60 });
  const out = await measure({ s, net, outDir: await tmp(), log: () => {} });
  assert.equal(net.used, 0);
  assert.match(out.stopped.message, /run signin\.mjs first/);
});

test('the copy holds to the product: the schema of route.rs and the 14 questions route-eval prints', (t) => {
  assert.deepEqual(rustSchema(), SCHEMA);
  const built = path.join(REPO, 'core', 'target', 'debug', 'examples', 'route-eval');
  if (!existsSync(built)) return t.skip('build it with `cargo build --example route-eval` in core/ to compare the questions');
  for (const thought of fx.thoughts) {
    const product = execFileSync(built, [path.join(REPO, 'core', 'scripts', 'route-eval.json'), '--question', thought.name], { encoding: 'utf8' });
    assert.equal(productQuestion(fx, thought), product, thought.name);
  }
});

test('the judgement: right, wrong, unsure and refused as route-eval tells them', () => {
  const by = (name) => fx.thoughts.find((t) => t.name === name);
  for (const t of fx.thoughts) assert.equal(judge(fx, t, accept(fx, t, answerFor(t))).outcome, 'right', t.name);
  const ledgerly = by('ramble-restart');
  assert.equal(judge(fx, ledgerly, accept(fx, ledgerly, answerFor(ledgerly, { to: 'p2' }))).outcome, 'wrong');
  assert.equal(judge(fx, ledgerly, accept(fx, ledgerly, answerFor(ledgerly, { confidence: 'ambiguous', candidates: ['p3', 'p2'] }))).outcome, 'unsure');
  assert.equal(judge(fx, ledgerly, accept(fx, ledgerly, answerFor(ledgerly, { confidence: 'unknown' }))).outcome, 'unsure');
  assert.equal(judge(fx, ledgerly, accept(fx, ledgerly, answerFor(ledgerly, { to: 'p9' }))).outcome, 'refused');
  assert.equal(judge(fx, ledgerly, accept(fx, ledgerly, '```json\n{}\n```')).outcome, 'refused');
  assert.equal(judge(fx, ledgerly, accept(fx, ledgerly, answerFor(ledgerly, { extra: 1 }))).outcome, 'refused');
  const two = by('ambiguous-two');
  assert.equal(judge(fx, two, accept(fx, two, answerFor(two, { candidates: ['p2', 'p5'] }))).outcome, 'wrong');
  assert.equal(judge(fx, two, accept(fx, two, answerFor(two, { candidates: ['p3'] }))).outcome, 'refused');
  const before = by('reference-before');
  assert.match(accept(fx, before, answerFor(before, { quote: 'words never said' })).refused, /quotes for a follow-up/);
  const note = by('not-for-an-agent');
  assert.equal(judge(fx, note, accept(fx, note, answerFor(note, { confidence: 'clear', to: 'p1', brief: 'x' }))).outcome, 'wrong');
  const typo = by('short-typo');
  assert.deepEqual(judge(fx, typo, accept(fx, typo, answerFor(typo, { brief: 'Fix the footer.' }))).invented, ['changed']);
});

test('signin --dry-run prints the address and stores nothing', async () => {
  const record = path.join(await tmp(), 'never', 'siwc.json');
  const printed = execFileSync(process.execPath, [path.join(HERE, 'signin.mjs'), '--dry-run'], { env: { ...process.env, SIWC_RECORD: record }, encoding: 'utf8' });
  assert.match(printed, /^https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?client_id=dynamic_agent_client&agent_name_hint=Tasktap%20trial&ext_agent_host_id=urn%3Auuid%3A/m);
  assert.match(printed, /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fauth%2Fcallback/);
  assert.equal(existsSync(path.dirname(record)), false);
  assert.match(await dryRun({ s: settings({ SIWC_RECORD: record }) }), /code_challenge_method\s+S256/);
});
