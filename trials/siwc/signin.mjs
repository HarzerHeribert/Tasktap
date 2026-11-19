#!/usr/bin/env node
// Signs in with ChatGPT as a desktop app does (OpenAI's "Registration and sign-in" page): a listener on
// 127.0.0.1, the authorisation page in the system browser, the code exchanged with PKCE, the ID token checked,
// and the sign-in stored outside the repository, readable by its owner only. It never prints a token.
//
//   node trials/siwc/signin.mjs              sign in (the first time, the app is registered in your account)
//   node trials/siwc/signin.mjs --dry-run    print the address it would open; opens nothing, stores nothing
//   node trials/siwc/signin.mjs --no-open    print the address and wait, without opening a browser
//   node trials/siwc/signin.mjs --forget     end the sign-in at OpenAI and delete the stored record
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  AGENT_NAME, AuthError, PLAN_SCOPE, USAGE_PAGE, attempt, authorizeUrl, discover, folderNote, listen, network,
  newHostId, readRecord, scrubber, settings, tokenRequest, verifyIdToken, writeRecord, RESOURCE,
} from './siwc.mjs';

/** Opens the address in the system browser, as an argument, never through a shell. */
export function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

/**
 * The whole sign-in. `open` is how the address reaches a browser (the tests give a stand-in's);
 * returns what happened, in words, with nothing secret in it.
 */
export async function signIn({ s, net, open, log, timeoutMs, now = () => Date.now() }) {
  const old = await readRecord(s.record);
  const again = Boolean(old?.client_id && old?.access_token);
  // The host id is chosen and kept before the first sign-in (overview, "Host-ID").
  const hostId = old?.ext_agent_host_id ?? newHostId();
  if (!old?.ext_agent_host_id) await writeRecord(s.record, { ...(old ?? {}), ext_agent_host_id: hostId });
  // A registration that got its client id but no tokens keeps that id: a new attempt does not register again.
  const clientId = old?.client_id ?? null;

  const config = await discover(s, net);
  const a = attempt();
  const listener = await listen({ state: a.state, timeoutMs });
  const url = authorizeUrl(s, { clientId, hostId, redirectUri: listener.redirectUri, state: a.state, nonce: a.nonce, challenge: a.challenge });
  log(clientId
    ? 'Signing in again with the registration you made before.'
    : `Signing in. Your browser will ask you to approve an app called "${AGENT_NAME}" and its use of your ChatGPT plan.`);
  log(`If no browser opens, open this address yourself:\n\n${url}\n`);
  log('Waiting for the browser (at most 5 minutes)...');
  open(url);

  let q;
  try {
    q = await listener.result;
  } finally {
    listener.close();
  }
  if (q.error) {
    return { ok: false, said: q.error === 'access_denied'
      ? 'You declined in the browser. Nothing was stored but the computer\'s host id.'
      : `The browser came back with "${q.error}". Nothing was stored but the computer's host id.` };
  }
  if (!q.code) return { ok: false, said: 'The browser came back without a code. Nothing was stored.' };

  // The client id the sign-in is issued under: the callback's on a first registration; the saved one after.
  let issued = clientId;
  if (q.client_id && clientId && q.client_id !== clientId) {
    return { ok: false, said: 'The browser came back with another registration than the stored one; nothing was changed.' };
  }
  if (!clientId) {
    if (!q.client_id || q.client_id === 'dynamic_agent_client') {
      return { ok: false, said: 'The registration did not complete: the browser came back without the app\'s client id.' };
    }
    issued = q.client_id;
    // Kept before the code is exchanged, so a failed exchange does not register the app a second time.
    await writeRecord(s.record, { ...(old ?? {}), ext_agent_host_id: hostId, client_id: issued });
  }

  let data;
  try {
    data = await tokenRequest(net, s.token, {
      grant_type: 'authorization_code',
      client_id: issued,
      code: q.code,
      code_verifier: a.verifier,
      redirect_uri: listener.redirectUri,
      resource: RESOURCE,
    });
  } catch (e) {
    if (e instanceof AuthError && e.code === 'invalid_grant') {
      return { ok: false, said: 'OpenAI did not take the one-time code (invalid_grant). Run this command again; the registration is kept.' };
    }
    throw e;
  }
  if (typeof data.id_token !== 'string') return { ok: false, said: 'OpenAI answered without an ID token; nothing was stored.' };
  const claims = await verifyIdToken(s, net, data.id_token, { jwksUri: config.jwks_uri, clientId: issued, nonce: a.nonce, now: now() });
  if (again && old.subject && old.subject !== claims.sub) {
    return { ok: false, said: 'You signed in to another ChatGPT account than the stored one; nothing was changed. Use --forget first to switch.' };
  }
  const scopes = typeof data.scope === 'string' ? data.scope.split(' ').filter(Boolean) : [];
  const record = {
    issuer: s.issuer,
    subject: claims.sub,
    client_id: issued,
    ext_agent_host_id: hostId,
    id_token: data.id_token,
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? null,
    token_type: data.token_type ?? 'Bearer',
    expires_in: data.expires_in ?? 3600,
    earliest_refresh_at: data.earliest_refresh_at ?? null,
    scopes,
    saved_at: new Date(now()).toISOString(),
  };
  await writeRecord(s.record, record);
  const plan = scopes.includes(PLAN_SCOPE);
  return {
    ok: true,
    plan,
    said: [
      `Signed in. Stored at ${s.record} (readable by you only).`,
      plan ? 'ChatGPT plan use is allowed for this app.'
        : 'ChatGPT plan use was NOT granted, so measure.mjs will not ask anything. Run this again and allow it.',
      data.refresh_token ? 'It can renew itself for 30 days.' : 'OpenAI gave no refresh token: after an hour you will need to sign in again.',
      plan ? 'Next: node trials/siwc/measure.mjs' : '',
    ].filter(Boolean).join('\n'),
  };
}

/** What `--dry-run` shows: the address and its parts. It reads the record only to tell which sign-in it would be. */
export async function dryRun({ s }) {
  const old = await readRecord(s.record);
  const a = attempt();
  const listener = await listen({ state: a.state, timeoutMs: 1000 });
  listener.close();
  const url = authorizeUrl(s, {
    clientId: old?.client_id ?? null,
    hostId: old?.ext_agent_host_id ?? newHostId(),
    redirectUri: listener.redirectUri,
    state: a.state,
    nonce: a.nonce,
    challenge: a.challenge,
  });
  const parts = [...new URL(url).searchParams].map(([k, v]) => `  ${k.padEnd(22)} ${v}`).join('\n');
  return [
    'Dry run: nothing is opened, sent or stored. The values that change on every attempt (state, nonce,',
    'code_challenge) and the port are fresh here, as they would be in a real run.',
    old?.ext_agent_host_id ? '' : 'There is no stored host id yet, so this one is made up for the dry run and not kept.',
    '',
    url,
    '',
    parts,
  ].join('\n');
}

/** Ends the sign-in at OpenAI (the revocation endpoint OpenAI publishes) and deletes the stored record. */
export async function forget({ s, net }) {
  const rec = await readRecord(s.record);
  if (!rec) return `Nothing is stored at ${s.record}.`;
  let ended = 'There was no sign-in to end at OpenAI.';
  if (rec.refresh_token && rec.client_id) {
    try {
      const config = await discover(s, net);
      const res = await net.fetch(config.revocation_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: rec.refresh_token, token_type_hint: 'refresh_token', client_id: rec.client_id }).toString(),
      });
      ended = res.status === 200 ? 'OpenAI confirmed the sign-in is ended.'
        : `OpenAI did not confirm that the sign-in is ended (HTTP ${res.status}).`;
    } catch (e) {
      ended = `OpenAI could not be reached to end the sign-in (${e.message}).`;
    }
  }
  await fs.rm(s.record, { force: true });
  return [
    ended,
    `Deleted ${s.record}.`,
    `The app "${AGENT_NAME}" stays registered in your ChatGPT account until you remove it there:`,
    `open ${USAGE_PAGE} (ChatGPT, Settings, Usage), where each app's access to your plan is managed.`,
  ].join('\n');
}

async function main(argv) {
  const s = settings();
  const net = network();
  if (argv.includes('--dry-run')) return console.log(await dryRun({ s }));
  if (argv.includes('--forget')) return console.log(await forget({ s, net }));
  const scrub = scrubber(null);
  const log = (text) => console.log(text);
  try {
    const open = argv.includes('--no-open') ? () => {} : openBrowser;
    const result = await signIn({ s, net, open, log, timeoutMs: 5 * 60_000 });
    const note = await folderNote(s.record);
    console.log(result.said);
    if (note) console.log(note);
    process.exitCode = result.ok && result.plan ? 0 : 1;
  } catch (e) {
    console.error(`Sign-in failed: ${scrub(e.message)}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main(process.argv.slice(2));
