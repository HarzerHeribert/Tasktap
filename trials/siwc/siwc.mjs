// What signin.mjs and measure.mjs share: the sign-in's values and URL, the loopback listener, the token
// endpoint, the ID token's checks, the record on disk, its renewal, a counted network and the stream reader.
// Written from OpenAI's documentation (README.md names the pages); nothing of OpenAI's sample kit is used.
// It never talks to Codex's sign-in, reads ~/.codex, or calls chatgpt.com.
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');

/** Identity scopes, then the scopes that let the app use the person's ChatGPT plan (sign-in, step 2). */
export const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
/** Without this one granted, nothing may be asked on the person's plan (errors and recovery). */
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const RESOURCE = 'https://api.openai.com/v1';
/** The first-registration entry point; never saved, never used to exchange a code. */
export const FIRST_CLIENT = 'dynamic_agent_client';
/** What the person sees the app called while approving it, and in ChatGPT's settings after. */
export const AGENT_NAME = 'Tasktap trial';
export const CALLBACK = '/auth/callback';
export const USAGE_PAGE = 'https://chatgpt.com/settings/usage';

/** Where everything is. The SIWC_* variables exist for the tests' local stand-in, nothing else. */
export function settings(env = process.env) {
  const auth = base(env.SIWC_AUTH_BASE ?? 'https://auth.openai.com');
  const api = base(env.SIWC_API_BASE ?? 'https://api.openai.com/v1');
  const record = path.resolve(env.SIWC_RECORD ?? path.join(os.homedir(), '.config', 'tasktap-test', 'siwc.json'));
  if (record === REPO || record.startsWith(REPO + path.sep)) {
    throw new Error(`the sign-in must be stored outside the repository, not at ${record}`);
  }
  return {
    auth,
    api,
    issuer: auth,
    authorize: `${auth}/api/accounts/authorize`,
    token: `${auth}/api/accounts/oauth/token`,
    discovery: `${auth}/.well-known/openid-configuration`,
    models: `${api}/models`,
    responses: `${api}/responses`,
    record,
  };
}

/** OpenAI over https, or a stand-in on this computer's loopback; never ChatGPT's own backend. */
function base(url) {
  const u = new URL(url);
  const local = u.protocol === 'http:' && u.hostname === '127.0.0.1';
  const openai = u.protocol === 'https:' && (u.hostname === 'auth.openai.com' || u.hostname === 'api.openai.com');
  if (!(local || openai) || u.pathname.includes('backend-api')) throw new Error(`not an address this trial talks to: ${url}`);
  return url.replace(/\/+$/, '');
}

// ---- One attempt's values (PKCE S256, state, nonce) and the host id ----

export const base64url = (bytes) => Buffer.from(bytes).toString('base64url');
export const challengeOf = (verifier) => base64url(createHash('sha256').update(verifier, 'ascii').digest());

/** Fresh for every attempt: 32 random bytes make a 43-character verifier, as RFC 7636 asks. */
export function attempt() {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: challengeOf(verifier), state: base64url(randomBytes(24)), nonce: base64url(randomBytes(24)) };
}

/** One per installation, kept for good: "urn:uuid:" and a version 4 UUID (the overview's accepted formats). */
export const newHostId = () => `urn:uuid:${randomUUID()}`;

/**
 * The authorisation URL, every value URL-encoded. A first registration sends `dynamic_agent_client` and the
 * app's name; signing in again sends the issued client id and no name. No token is ever part of it: the
 * optional `id_token_hint` is left out on purpose, so the URL can be printed.
 */
export function authorizeUrl(s, { clientId, hostId, redirectUri, state, nonce, challenge }) {
  const first = !clientId;
  const params = [
    ['client_id', first ? FIRST_CLIENT : clientId],
    ...(first ? [['agent_name_hint', AGENT_NAME]] : []),
    ['ext_agent_host_id', hostId],
    ['response_type', 'code'],
    ['redirect_uri', redirectUri],
    ['scope', SCOPES.join(' ')],
    ['resource', RESOURCE],
    ['state', state],
    ['nonce', nonce],
    ['code_challenge_method', 'S256'],
    ['code_challenge', challenge],
  ];
  return `${s.authorize}?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

// ---- The loopback listener ----

/**
 * Listens on 127.0.0.1 at a port the system picks, before the browser is opened. Takes the first callback
 * whose state matches; one that does not match is answered 400 and does not end the wait. Resolves with the
 * callback's parameters, rejects when nothing came within `timeoutMs`.
 */
export function listen({ state, timeoutMs = 5 * 60_000 }) {
  return new Promise((ready, failed) => {
    let settle;
    const result = new Promise((resolve, reject) => (settle = { resolve, reject }));
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== CALLBACK) return page(res, 404, 'Nothing here.');
      const q = Object.fromEntries(url.searchParams);
      if (q.state !== state) {
        return page(res, 400, 'This answer does not belong to the sign-in that is waiting. Nothing was done.');
      }
      const said = q.error
        ? `Not signed in (${q.error}). You can close this tab.`
        : 'Signed in to the Tasktap trial. You can close this tab and go back to the terminal.';
      res.on('finish', close);
      page(res, 200, said);
      settle.resolve(q);
    });
    const timer = setTimeout(() => {
      close();
      settle.reject(new Error(`no answer from the browser within ${Math.round(timeoutMs / 60_000)} minutes`));
    }, timeoutMs);
    function close() {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
    }
    server.on('error', failed);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      ready({ redirectUri: `http://127.0.0.1:${port}${CALLBACK}`, result, close });
    });
  });
}

function page(res, status, text) {
  const safe = text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><title>Tasktap trial</title><p style="font:16px system-ui">${safe}</p>`);
}

// ---- The token endpoint and the ID token ----

export class AuthError extends Error {
  constructor(status, code, description) {
    super(`${code}${description ? `: ${description}` : ''} (HTTP ${status})`);
    this.status = status;
    this.code = code;
  }
}

/** A form-encoded POST to the token endpoint; its error code as the OAuth body gives it. */
export async function tokenRequest(net, url, fields) {
  const res = await net.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const code = typeof body?.error === 'string' ? body.error : (body?.error?.code ?? `http_${res.status}`);
    throw new AuthError(res.status, code, body?.error_description ?? body?.error?.message ?? '');
  }
  if (typeof body?.access_token !== 'string') throw new AuthError(res.status, 'no_tokens', 'no access token in the answer');
  return body;
}

/** The provider's published endpoints; only those on its own address are taken. */
export async function discover(s, net) {
  const res = await net.fetch(s.discovery, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`OpenAI's sign-in configuration did not load (HTTP ${res.status})`);
  const d = await res.json();
  const own = (u) => typeof u === 'string' && new URL(u).origin === new URL(s.auth).origin;
  if (d.issuer !== s.issuer || !own(d.jwks_uri) || !own(d.revocation_endpoint)) {
    throw new Error('OpenAI\'s sign-in configuration names another issuer or address');
  }
  return d;
}

export function decodeJwt(token) {
  const [h, p, sig, ...rest] = String(token).split('.');
  if (!h || !p || !sig || rest.length) throw new Error('the ID token is not a signed token');
  const json = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  return { header: json(h), claims: json(p), signed: `${h}.${p}`, signature: Buffer.from(sig, 'base64url') };
}

/**
 * Sign-in, step 4: the signature against OpenAI's published keys, then issuer, audience (the issued client
 * id), expiry and this attempt's nonce. Returns the claims; the caller keeps only the subject.
 */
export async function verifyIdToken(s, net, idToken, { jwksUri, clientId, nonce, now = Date.now() }) {
  const t = decodeJwt(idToken);
  if (t.header.alg !== 'RS256') throw new Error('the ID token is not signed with RS256');
  const res = await net.fetch(jwksUri, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`OpenAI's signing keys did not load (HTTP ${res.status})`);
  const { keys = [] } = await res.json();
  const jwk = keys.find((k) => k.kid === t.header.kid);
  if (!jwk) throw new Error('the ID token is signed with a key OpenAI does not publish');
  const key = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
  if (!verify('RSA-SHA256', Buffer.from(t.signed), key, t.signature)) throw new Error('the ID token\'s signature is wrong');
  const c = t.claims;
  const seconds = Math.floor(now / 1000);
  if (c.iss !== s.issuer) throw new Error('the ID token comes from another issuer');
  if (!(Array.isArray(c.aud) ? c.aud : [c.aud]).includes(clientId)) throw new Error('the ID token is for another client');
  if (typeof c.exp !== 'number' || c.exp < seconds - 60) throw new Error('the ID token has expired');
  if (c.nonce !== nonce) throw new Error('the ID token belongs to another sign-in attempt');
  if (typeof c.sub !== 'string' || !c.sub) throw new Error('the ID token names nobody');
  return c;
}

// ---- The record on disk ----

export async function readRecord(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** Written whole or not at all: a new file of mode 600 beside it, renamed over it (sign-in, step 5). */
export async function writeRecord(file, record) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}`);
  const h = await fs.open(tmp, 'wx', 0o600);
  try {
    await h.writeFile(`${JSON.stringify(record, null, 2)}\n`);
    await h.sync();
  } finally {
    await h.close();
  }
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

/** Said, not changed: a folder others may list. The record itself is readable by its owner only. */
export async function folderNote(file) {
  if (process.platform === 'win32') return null;
  const st = await fs.stat(path.dirname(file)).catch(() => null);
  if (!st || !(st.mode & 0o077)) return null;
  const mode = (st.mode & 0o777).toString(8);
  return `Note: the folder ${path.dirname(file)} has mode ${mode}, so other users of this computer can see which files are in it (not what is in them: the record is mode 600). \`chmod 700\` on it closes that.`;
}

/** One renewal at a time, so two runs never race a refresh token that rotates (accounts and sessions). */
export async function withLock(file, fn) {
  const lock = `${file}.lock`;
  let h;
  try {
    h = await fs.open(lock, 'wx', 0o600);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const st = await fs.stat(lock).catch(() => null);
    if (st && Date.now() - st.mtimeMs < 120_000) throw new Error('another run is renewing the sign-in; try again in a minute');
    await fs.rm(lock, { force: true });
    h = await fs.open(lock, 'wx', 0o600);
  }
  try {
    return await fn();
  } finally {
    await h.close();
    await fs.rm(lock, { force: true });
  }
}

export const expiresAt = (r) => Date.parse(r.saved_at) + Number(r.expires_in ?? 0) * 1000;

/** `earliest_refresh_at` as milliseconds, whether the server writes seconds, milliseconds or a date. */
export function moment(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** A refresh token that can never be used again: the person signs in again (errors and recovery). */
export const DEAD = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
  'refresh_token_invalidated', 'refresh_token_reused']);

/**
 * The record with an access token that has more than `within` left: renewed with the refresh token when it
 * has less (or when `force`), and the replacement written back at once, access token, expiry, scopes and
 * refresh token together. A forced renewal waits for `earliest_refresh_at` if the server gave one.
 */
export async function fresh(s, net, { force = false, within = 10 * 60_000, now = () => Date.now() } = {}) {
  return withLock(s.record, async () => {
    const rec = await readRecord(s.record);
    if (!rec?.access_token) throw new Error(`no sign-in is stored at ${s.record}; run signin.mjs first`);
    const left = expiresAt(rec) - now();
    if (!force && left > within) return { record: rec, refreshed: false, why: `${Math.round(left / 60_000)} minutes left on the access token` };
    const earliest = moment(rec.earliest_refresh_at);
    if (left > 60_000 && earliest && now() < earliest) {
      return { record: rec, refreshed: false, why: `OpenAI asked not to renew before ${new Date(earliest).toISOString()}` };
    }
    if (!rec.refresh_token || !rec.client_id) throw new Error('the stored sign-in cannot be renewed; run signin.mjs again');
    let data;
    try {
      data = await tokenRequest(net, s.token, {
        grant_type: 'refresh_token',
        client_id: rec.client_id,
        refresh_token: rec.refresh_token,
        resource: RESOURCE,
      });
    } catch (e) {
      if (e instanceof AuthError && DEAD.has(e.code)) e.signInAgain = true;
      throw e;
    }
    const next = {
      ...rec,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? rec.refresh_token,
      token_type: data.token_type ?? rec.token_type,
      expires_in: data.expires_in ?? rec.expires_in,
      scopes: typeof data.scope === 'string' ? data.scope.split(' ').filter(Boolean) : rec.scopes,
      earliest_refresh_at: data.earliest_refresh_at ?? null,
      id_token: data.id_token ?? rec.id_token,
      saved_at: new Date(now()).toISOString(),
    };
    await writeRecord(s.record, next);
    return { record: next, refreshed: true, rotated: typeof data.refresh_token === 'string' && data.refresh_token !== rec.refresh_token };
  });
}

// ---- A network that counts ----

export class BudgetError extends Error {}

/** Every request to OpenAI goes through here and counts; past `budget` none is sent. Redirects are not followed. */
export function network({ budget = Infinity, fetchImpl = globalThis.fetch } = {}) {
  const net = {
    used: 0,
    budget,
    async fetch(url, init = {}) {
      if (net.used >= net.budget) throw new BudgetError(`the limit of ${net.budget} requests is reached`);
      net.used += 1;
      return fetchImpl(url, { redirect: 'manual', ...init });
    },
  };
  return net;
}

// ---- The stream ----

/** Server-sent events from a byte stream: `event:` and `data:` lines, a blank line ends one, `:` is a comment. */
export async function* events(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let name = '';
  let data = [];
  function* lines(final) {
    for (;;) {
      const at = buffer.search(/\r\n|\r|\n/);
      if (at < 0) return;
      // A chunk may end between a CR and its LF: wait for the next one.
      if (buffer[at] === '\r' && at === buffer.length - 1 && !final) return;
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + (buffer.startsWith('\r\n', at) ? 2 : 1));
      yield line;
    }
  }
  function* take(final) {
    for (const line of lines(final)) {
      if (line === '') {
        if (data.length) yield { event: name || 'message', data: data.join('\n') };
        name = '';
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') name = value;
      else if (field === 'data') data.push(value);
    }
  }
  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    yield* take(false);
  }
  buffer += decoder.decode();
  yield* take(true);
  // An event the stream ended in the middle of is dropped, as the SSE standard says.
}

const TERMINAL = new Set(['response.completed', 'response.failed', 'response.incomplete']);

/**
 * Reads a Responses stream to its terminal event (models and inference, step 3): only `response.completed`
 * is success; `response.failed`, `response.incomplete`, an `error` event and a stream that just ends are
 * told apart. Times are milliseconds after `started`: the first byte of the body, the first text, the end.
 */
export async function readStream(body, { started, clock = () => performance.now() }) {
  const out = { status: 'interrupted', firstByteMs: null, firstTextMs: null, doneMs: null, text: '', usage: null, error: null, model: null, responseKeys: [], seen: {} };
  let deltas = '';
  async function* timed() {
    for await (const chunk of body) {
      out.firstByteMs ??= clock() - started;
      yield chunk;
    }
  }
  for await (const ev of events(timed())) {
    let payload;
    try {
      payload = JSON.parse(ev.data);
    } catch {
      continue;
    }
    const type = payload.type ?? ev.event;
    out.seen[type] = (out.seen[type] ?? 0) + 1;
    if (type === 'response.output_text.delta') {
      out.firstTextMs ??= clock() - started;
      deltas += payload.delta ?? '';
    } else if (TERMINAL.has(type)) {
      const r = payload.response ?? {};
      out.status = type.slice('response.'.length);
      out.doneMs = clock() - started;
      out.usage = r.usage ?? null;
      out.model = r.model ?? null;
      out.responseKeys = Object.keys(r);
      out.error = r.error ?? (type === 'response.incomplete' ? { code: r.incomplete_details?.reason ?? 'incomplete' } : null);
      out.text = outputText(r) ?? deltas;
      return out;
    } else if (type === 'error') {
      out.status = 'failed';
      out.doneMs = clock() - started;
      out.error = { code: payload.code ?? payload.error?.code ?? null, message: payload.message ?? payload.error?.message ?? '' };
      return out;
    }
  }
  out.text = deltas;
  return out;
}

function outputText(r) {
  const parts = (r.output ?? []).filter((o) => o?.type === 'message').flatMap((o) => o.content ?? [])
    .filter((c) => c?.type === 'output_text').map((c) => c.text ?? '');
  return parts.length ? parts.join('') : null;
}

// ---- Keeping identifiers out of what is printed and written ----

/** Replaces the record's tokens and identifiers, and anything shaped like a token, an email or an id, with [redacted]. */
export function scrubber(record) {
  const known = [record?.access_token, record?.refresh_token, record?.id_token, record?.client_id, record?.subject,
    record?.ext_agent_host_id].filter((v) => typeof v === 'string' && v.length >= 6);
  return (value) => {
    let t = String(value);
    for (const v of known) t = t.split(v).join('[redacted]');
    return t
      .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]')
      .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[redacted]')
      .replace(/oaiapp_[\w-]+/g, '[redacted]')
      .replace(/urn:uuid:[0-9a-f-]{36}/gi, '[redacted]');
  };
}
