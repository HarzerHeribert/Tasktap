// A stand-in for OpenAI's sign-in and Responses endpoints on 127.0.0.1, for test.mjs only. It holds each request
// to what the documentation asks and writes down what it finds wrong in `problems`, so a test fails on a wrong
// parameter as the real server would. Its tokens, ids and email are made up.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import http from 'node:http';
import { RESOURCE, SCOPES } from './siwc.mjs';

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const rand = (prefix) => `${prefix}${randomBytes(12).toString('hex')}`;

/**
 * `plan(n, body)` decides the n-th inference call: 'ok', '429', '403', 'limit-in-stream', 'refuse-format'
 * (a 400 when an answer format is asked for), or 'cut' (the stream ends before it is complete).
 * `answer(body)` is the text an 'ok' call answers with.
 */
export async function standIn({ plan = () => 'ok', answer = () => '{}', models, deny = false, earliestRefreshAt = null } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'stand-in-key';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  const st = {
    issued: rand('oaiapp_'),
    subject: rand('user-'),
    email: 'person@example.com',
    codes: new Map(),
    refresh: new Map(),
    access: new Set(),
    seen: [],
    problems: [],
    inference: 0,
    bodies: [],
    revoked: [],
  };
  let base;
  const idToken = (claims) => {
    const head = b64({ alg: 'RS256', kid, typ: 'JWT' });
    const body = b64(claims);
    return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
  };
  const tokens = (clientId, nonce) => {
    const access = rand('at-');
    const refresh = rand('rt-');
    st.access.add(access);
    st.refresh.set(refresh, { clientId, used: false });
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: access,
      refresh_token: refresh,
      id_token: idToken({ iss: base, aud: clientId, sub: st.subject, email: st.email, iat: now, exp: now + 3600, nonce }),
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke',
      earliest_refresh_at: earliestRefreshAt,
    };
  };
  const json = (res, status, value, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(value));
  };
  const problem = (where, what) => st.problems.push(`${where}: ${what}`);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    let text = '';
    for await (const c of req) text += c;
    st.seen.push({ method: req.method, path: url.pathname });
    const q = Object.fromEntries(url.searchParams);
    const form = Object.fromEntries(new URLSearchParams(text));
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');

    if (url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/api/accounts/authorize`,
        token_endpoint: `${base}/api/accounts/oauth/token`,
        revocation_endpoint: `${base}/api/accounts/oauth/revoke`,
        jwks_uri: `${base}/.well-known/jwks.json`,
      });
    }
    if (url.pathname === '/.well-known/jwks.json') return json(res, 200, { keys: [jwk] });

    if (url.pathname === '/api/accounts/authorize') {
      const where = 'authorize';
      const first = q.client_id === 'dynamic_agent_client';
      if (!first && q.client_id !== st.issued) problem(where, `client_id ${q.client_id}`);
      if (first && !q.agent_name_hint) problem(where, 'no agent_name_hint on a first registration');
      if (!first && 'agent_name_hint' in q) problem(where, 'agent_name_hint when signing in again');
      if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(q.ext_agent_host_id ?? '')) problem(where, 'ext_agent_host_id');
      if (q.response_type !== 'code') problem(where, 'response_type');
      if (!/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(q.redirect_uri ?? '')) problem(where, `redirect_uri ${q.redirect_uri}`);
      if ((q.scope ?? '').split(' ').sort().join(' ') !== [...SCOPES].sort().join(' ')) problem(where, `scope ${q.scope}`);
      if (q.resource !== RESOURCE) problem(where, 'resource');
      if (!q.state || !q.nonce) problem(where, 'state or nonce');
      if (q.code_challenge_method !== 'S256' || !/^[\w-]{43}$/.test(q.code_challenge ?? '')) problem(where, 'code_challenge');
      if ('id_token_hint' in q) problem(where, 'a token in the address');
      const back = new URL(q.redirect_uri);
      back.searchParams.set('state', q.state);
      if (deny) {
        back.searchParams.set('error', 'access_denied');
      } else {
        const code = rand('code-');
        st.codes.set(code, { challenge: q.code_challenge, redirect: q.redirect_uri, nonce: q.nonce, used: false });
        back.searchParams.set('code', code);
        back.searchParams.set('scope', 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke');
        if (first) back.searchParams.set('client_id', st.issued);
      }
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (url.pathname === '/api/accounts/oauth/token' && req.method === 'POST') {
      const where = `token ${form.grant_type}`;
      if (!/application\/x-www-form-urlencoded/.test(req.headers['content-type'] ?? '')) problem(where, 'not form-encoded');
      if (form.client_id !== st.issued) problem(where, `client_id ${form.client_id}`);
      if (form.resource !== RESOURCE) problem(where, 'resource');
      if ('client_secret' in form) problem(where, 'a client secret');
      if (form.grant_type === 'authorization_code') {
        const c = st.codes.get(form.code);
        if (!c || c.used) return json(res, 400, { error: 'invalid_grant' });
        c.used = true;
        if (createHash('sha256').update(form.code_verifier ?? '').digest('base64url') !== c.challenge) problem(where, 'code_verifier');
        if (form.redirect_uri !== c.redirect) problem(where, 'redirect_uri');
        return json(res, 200, tokens(st.issued, c.nonce));
      }
      if (form.grant_type === 'refresh_token') {
        if ('scope' in form) problem(where, 'scope sent with a refresh');
        const r = st.refresh.get(form.refresh_token);
        if (!r) return json(res, 400, { error: 'invalid_grant' });
        if (r.used) return json(res, 400, { error: 'refresh_token_reused' });
        r.used = true;
        const { id_token: _, ...rest } = tokens(st.issued, null);
        return json(res, 200, rest);
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }

    if (url.pathname === '/api/accounts/oauth/revoke' && req.method === 'POST') {
      st.revoked.push(form.token);
      if (form.token_type_hint !== 'refresh_token' || form.client_id !== st.issued) problem('revoke', 'fields');
      res.writeHead(200);
      return res.end();
    }

    if (url.pathname.startsWith('/v1/') && !st.access.has(bearer)) return json(res, 401, { detail: 'not signed in' });
    if (url.pathname === '/v1/models') {
      return json(res, 200, { models: models ?? [
        { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2 Sol', visibility: 'list' },
        { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list' },
        { slug: 'gpt-6-nano', display_name: 'GPT-6 nano', visibility: 'list' },
        { slug: 'internal-mini', display_name: 'Internal mini', visibility: 'hide' },
      ] });
    }
    if (url.pathname === '/v1/responses' && req.method === 'POST') {
      st.inference += 1;
      const body = JSON.parse(text);
      st.bodies.push(body);
      const where = 'responses';
      if (body.store !== false || body.stream !== true) problem(where, 'store and stream');
      for (const f of ['max_output_tokens', 'temperature', 'top_p', 'previous_response_id', 'user', 'metadata']) if (f in body) problem(where, f);
      if ((body.input ?? []).some((m) => m.role === 'system')) problem(where, 'a system message');
      const what = plan(st.inference, body);
      const headers = { 'x-request-id': rand('req_'), 'x-ratelimit-remaining-requests': '97' };
      if (what === '429') return json(res, 429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Usage limit reached.' } }, headers);
      if (what === '403') return json(res, 403, { error: { code: 'subscription_sharing_user_not_eligible', message: 'Not eligible.' } }, headers);
      if (what === 'refuse-format' && body.text?.format) {
        return json(res, 400, { error: { code: 'subscription_sharing_unsupported_capability', param: 'text.format', message: 'Not supported.' } }, headers);
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
      const send = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
      send({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress', model: body.model }, sequence_number: 0 });
      if (what === 'limit-in-stream') {
        send({ type: 'response.failed', response: { id: 'resp_1', status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Usage limit reached.' } }, sequence_number: 1 });
        return res.end();
      }
      const out = answer(body);
      const third = Math.ceil(out.length / 3);
      for (let i = 0; i < out.length; i += third) {
        send({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: out.slice(i, i + third), sequence_number: 1 });
      }
      if (what === 'cut') return res.end();
      send({ type: 'response.completed', sequence_number: 9, response: {
        id: 'resp_1', status: 'completed', model: body.model,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: out }] }],
        usage: { input_tokens: 2400, input_tokens_details: { cached_tokens: 0 }, output_tokens: 90, output_tokens_details: { reasoning_tokens: 30 }, total_tokens: 2490 },
      } });
      return res.end();
    }
    return json(res, 404, { error: 'not here' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    st,
    idToken,
    env: (record) => ({ SIWC_AUTH_BASE: base, SIWC_API_BASE: `${base}/v1`, SIWC_RECORD: record }),
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}
