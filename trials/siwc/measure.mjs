#!/usr/bin/env node
// Asks the models of the signed-in ChatGPT account to place the 14 made-up thoughts of
// core/scripts/route-eval.json, with the product's own instructions, and writes what came of it to
// results.md (the table) and results.json (each call) in this folder. Needs signin.mjs first.
//
//   node trials/siwc/measure.mjs                    list the models, then measure the two or three smallest
//   node trials/siwc/measure.mjs --list-only        list the models and stop (one request)
//   node trials/siwc/measure.mjs --models a,b       measure these models instead
//   node trials/siwc/measure.mjs --effort minimal   another reasoning effort than low (the product's for Codex);
//                                                   --effort default sends none
//   node trials/siwc/measure.mjs --refresh          renew the sign-in first even if it has time left
//   node trials/siwc/measure.mjs --question NAME    print what one thought would send; sends nothing
//
// At most 60 requests in all, one at a time. It stops at the first refusal for the plan's limit (429) or for
// permission (403), and at an unusable sign-in (401) or OpenAI being unavailable (5xx), and says so.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { body, accept, fixture, instructions, judge } from './route.mjs';
import { BudgetError, HERE, PLAN_SCOPE, USAGE_PAGE, fresh, network, readStream, scrubber, settings } from './siwc.mjs';

export const BUDGET = 60;
const PER_CALL_MS = 30_000;
const ALL_MS = 15 * 60_000;

/** Responses whose code means: ask nothing more of this plan now (errors and recovery). */
const STOP_CODES = new Set(['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable',
  'subscription_sharing_user_not_eligible', 'subscription_sharing_invalid_user', 'subscription_sharing_user_unavailable',
  'subscription_sharing_route_not_supported', 'chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context']);

/** Names that say a model is small, fast or cheap, likeliest first. */
const SMALL = [[/nano/i, 0], [/mini|luna/i, 1], [/flash|lite|small|tiny|haiku/i, 2], [/instant|fast|spark/i, 3]];

/** A header that might say what a call cost of the plan, or how much is left. */
const COSTLY = /ratelimit|rate-limit|usage|limit|credit|cost|plan|remaining|reset|quota|billing|subscription|token/i;

export function pickModels(models, most = 3) {
  const listed = models.filter((m) => (m.visibility ?? 'list') === 'list');
  const ranked = listed
    .map((m, i) => ({ m, i, rank: Math.min(99, ...SMALL.filter(([re]) => re.test(`${m.slug} ${m.display_name ?? ''}`)).map(([, r]) => r)) }))
    .filter((x) => x.rank < 99)
    .sort((a, b) => a.rank - b.rank || a.i - b.i);
  if (ranked.length) {
    return { slugs: ranked.slice(0, most).map((x) => x.m.slug), why: 'their names say small, fast or cheap (nano, mini, luna, flash, lite, instant)' };
  }
  return { slugs: listed.slice(-2).map((m) => m.slug), why: 'no name says small or cheap, so the last two the listing offers' };
}

function parseError(text) {
  try {
    const j = JSON.parse(text);
    return { code: j.error?.code ?? j.code ?? null, param: j.error?.param ?? null, message: j.error?.message ?? j.detail ?? j.message ?? '' };
  } catch {
    return { code: null, param: null, message: text.slice(0, 300) };
  }
}

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const worst = (xs) => (xs.length ? Math.max(...xs) : null);
const round = (x) => (x == null ? null : Math.round(x));

/**
 * The whole measurement. Everything it is given can be a stand-in: `s` (addresses and the record's path),
 * `net` (counted fetch), `outDir`, `log`. Returns the results it wrote.
 */
export async function measure({ s, net, args = {}, outDir = HERE, log = console.log, clock = () => performance.now() }) {
  const began = clock();
  const fx = fixture();
  const text = instructions();
  const out = {
    about: 'Placing by a model on the signed-in ChatGPT plan: the 14 thoughts of core/scripts/route-eval.json, with core/src/route/instructions.md as `instructions` and the request as the one user message (trials/siwc).',
    date: new Date().toISOString(),
    endpoint: s.responses,
    effort: args.effort === 'default' ? null : (args.effort ?? 'low'),
    sign_in: null,
    models_listed: null,
    models_listing_note: null,
    chosen: null,
    measured: [],
    stopped: null,
    requests: 0,
    headers_seen: [],
  };
  let scrub = scrubber(null);
  const say = (text) => log(scrub(text));
  const headerNames = new Set();
  const finish = async () => {
    out.requests = net.used;
    out.headers_seen = [...headerNames].sort();
    const table = render(out);
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, 'results.json'), `${scrub(JSON.stringify(out, null, 2))}\n`);
    await fs.writeFile(path.join(outDir, 'results.md'), `${scrub(table)}\n`);
    log(scrub(table));
    return JSON.parse(scrub(JSON.stringify(out)));
  };
  const stop = (fields) => {
    out.stopped = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === 'string' ? scrub(v) : v]));
  };

  // 1. The sign-in, renewed if it is near its end.
  let record;
  try {
    const f = await fresh(s, net, { force: Boolean(args.refresh) });
    record = f.record;
    out.sign_in = { renewed: f.refreshed, refresh_token_replaced: f.rotated ?? null, why: f.why ?? null };
  } catch (e) {
    stop({ at: 'renewing the sign-in', message: e.message, sign_in_again: Boolean(e.signInAgain) });
    return finish();
  }
  scrub = scrubber(record);
  if (!record.scopes?.includes(PLAN_SCOPE)) {
    stop({ at: 'the sign-in', message: `ChatGPT plan use (${PLAN_SCOPE}) was not granted; run signin.mjs again and allow it` });
    return finish();
  }
  const auth = { authorization: `Bearer ${record.access_token}` };

  // 2. The models the account is offered.
  let listing;
  try {
    const res = await net.fetch(s.models, { headers: { ...auth, accept: 'application/json' }, signal: AbortSignal.timeout(PER_CALL_MS) });
    for (const k of res.headers.keys()) headerNames.add(k);
    const raw = await res.text();
    if (!res.ok) {
      const err = parseError(raw);
      stop({ at: 'listing the models', status: res.status, code: err.code, message: err.message });
      return finish();
    }
    listing = JSON.parse(raw);
  } catch (e) {
    stop({ at: 'listing the models', message: e.message });
    return finish();
  }
  const models = Array.isArray(listing.models) ? listing.models : Array.isArray(listing.data) ? listing.data : [];
  if (!Array.isArray(listing.models)) out.models_listing_note = `the listing has no "models" array; its keys: ${Object.keys(listing).join(', ')}`;
  out.models_listed = models;
  say(`The account is offered ${models.length} models:`);
  for (const m of models) {
    const rest = Object.entries(m).filter(([k]) => !['slug', 'display_name', 'visibility'].includes(k));
    say(`  ${m.slug ?? m.id}  "${m.display_name ?? ''}"  visibility ${m.visibility ?? '?'}${rest.length ? `  ${JSON.stringify(Object.fromEntries(rest)).slice(0, 300)}` : ''}`);
  }
  const chosen = args.models?.length ? { slugs: args.models, why: 'named with --models' } : pickModels(models.map((m) => ({ ...m, slug: m.slug ?? m.id })));
  out.chosen = chosen;
  if (args.listOnly) return finish();
  say(`Measuring ${chosen.slugs.join(', ')}: ${chosen.why}.`);

  // 3. The placing call, every thought, one model after the other.
  for (const model of chosen.slugs) {
    const m = { model, format_accepted: null, format_refused_with: null, effort: out.effort, effort_refused_with: null, unusable: null, cases: [] };
    out.measured.push(m);
    const opts = { format: true, effort: out.effort };
    for (const t of fx.thoughts) {
      let r;
      for (;;) {
        if (clock() - began > ALL_MS) {
          stop({ at: `${model}, ${t.name}`, message: 'the whole run took longer than 15 minutes' });
          return finish();
        }
        try {
          r = await call(s, net, auth, body(fx, t, { model, effort: opts.effort, format: opts.format, text }), clock);
        } catch (e) {
          if (e instanceof BudgetError) {
            stop({ at: `${model}, ${t.name}`, message: `the limit of ${BUDGET} requests is reached` });
            return finish();
          }
          throw e;
        }
        r.headers.names.forEach((n) => headerNames.add(n));
        if (r.kind === 'http' && r.status === 400 && m.cases.length === 0) {
          // The first call tells what this endpoint takes for this model: a field it refuses is dropped and the
          // call made again, the answer format last (so that a refusal is put down to the right field).
          const about = `${r.error.param ?? ''} ${r.error.message ?? ''}`.toLowerCase();
          if (r.error.param === 'model' || /model/.test(r.error.param ?? '')) {
            m.unusable = scrub(`${r.error.code ?? 'HTTP 400'}: ${r.error.message}`);
            break;
          }
          if (opts.effort && /reasoning|effort/.test(about)) {
            m.effort_refused_with = scrub(`${r.error.code ?? 'HTTP 400'}: ${r.error.message}`);
            opts.effort = null;
            m.effort = null;
            continue;
          }
          if (opts.format) {
            m.format_refused_with = scrub(`${r.error.code ?? 'HTTP 400'}: ${r.error.message}`);
            opts.format = false;
            m.format_accepted = false;
            continue;
          }
          if (opts.effort) {
            m.effort_refused_with = scrub(`${r.error.code ?? 'HTTP 400'}: ${r.error.message}`);
            opts.effort = null;
            m.effort = null;
            continue;
          }
        }
        break;
      }
      if (m.unusable) break;
      const stops = r.kind === 'http' ? [401, 403, 429].includes(r.status) || r.status >= 500
        : r.status === 'failed' && (STOP_CODES.has(r.error?.code) || /usage_limit|quota/.test(r.error?.code ?? ''));
      if (stops) {
        stop({ at: `${model}, ${t.name}`, status: r.kind === 'http' ? r.status : `in the stream (${r.status})`, code: r.error?.code ?? null,
          message: r.error?.message ?? '', request_id: r.requestId ?? null,
          what_to_do: r.error?.code === 'subscription_sharing_usage_limit_exceeded'
            ? `the plan's limit for this app or for the plan is reached; see ${USAGE_PAGE}` : null });
        return finish();
      }
      if (r.kind === 'http') {
        m.unusable = scrub(`HTTP ${r.status} ${r.error.code ?? ''}: ${r.error.message}`);
        break;
      }
      if (m.format_accepted === null && opts.format && r.status === 'completed') m.format_accepted = true;
      const got = r.status === 'completed' ? accept(fx, t, r.text) : { refused: `the call ended ${r.status}${r.error?.code ? ` (${r.error.code})` : ''}` };
      const j = judge(fx, t, got);
      const u = r.usage ?? {};
      m.cases.push({
        thought: t.name,
        outcome: j.outcome,
        went: j.went,
        why: j.why ?? null,
        missing: j.missing,
        invented: j.invented,
        title: j.title,
        brief: j.brief,
        ms: { headers: round(r.headersMs), first_byte: round(r.firstByteMs), first_text: round(r.firstTextMs), done: round(r.doneMs) },
        tokens: { input: u.input_tokens ?? null, cached: u.input_tokens_details?.cached_tokens ?? null, output: u.output_tokens ?? null, reasoning: u.output_tokens_details?.reasoning_tokens ?? null },
        usage: r.usage,
        answered_by: r.model,
        response_fields: r.responseKeys,
        cost_headers: r.headers.costly,
        stream_events: r.seen,
      });
      say(`  ${model.padEnd(18)} ${t.name.padEnd(20)} ${j.outcome.padEnd(8)} ${String(round(r.doneMs) ?? '-').padStart(6)} ms  ${j.went ?? j.why ?? ''}`);
    }
  }
  return finish();
}

/** One placing call: the HTTP refusal before a stream opens, or the stream read to its end. */
async function call(s, net, auth, payload, clock) {
  const started = clock();
  const signal = AbortSignal.timeout(PER_CALL_MS);
  let res;
  try {
    res = await net.fetch(s.responses, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    if (e instanceof BudgetError) throw e;
    return { kind: 'stream', status: e.name === 'TimeoutError' ? 'timed out' : 'not sent', error: { code: e.name, message: e.message }, headers: { names: [], costly: {} } };
  }
  const headersMs = clock() - started;
  const headers = { names: [...res.headers.keys()], costly: Object.fromEntries([...res.headers].filter(([k]) => COSTLY.test(k) && k !== 'set-cookie')) };
  const requestId = res.headers.get('x-request-id');
  if (!res.ok) {
    const error = parseError((await res.text().catch(() => '')).slice(0, 4000));
    return { kind: 'http', status: res.status, error, headers, requestId };
  }
  try {
    return { kind: 'stream', headersMs, headers, requestId, ...(await readStream(res.body, { started, clock })) };
  } catch (e) {
    return { kind: 'stream', status: e.name === 'TimeoutError' ? 'timed out' : 'interrupted', headersMs, headers, requestId, error: { code: e.name, message: e.message } };
  }
}

/** The one table, and below it what stopped the run and which headers came. */
export function render(out) {
  const lines = [
    `# Placing on the ChatGPT plan, ${out.date.slice(0, 10)}`,
    '',
    `Sign-in: ${out.sign_in ? (out.sign_in.renewed ? `renewed${out.sign_in.refresh_token_replaced ? ', refresh token replaced and stored' : ''}` : `not renewed (${out.sign_in.why})`) : 'not used'}. Requests to OpenAI: ${out.requests} of at most ${BUDGET}. Reasoning effort asked: ${out.effort ?? 'none (the model\'s default)'}.`,
  ];
  if (out.models_listed) {
    lines.push(`Models offered: ${out.models_listed.map((m) => `${m.slug ?? m.id}${m.display_name ? ` ("${m.display_name}")` : ''}${m.visibility && m.visibility !== 'list' ? ` [${m.visibility}]` : ''}`).join(', ') || 'none'}.`);
  }
  if (out.models_listing_note) lines.push(`Note on the listing: ${out.models_listing_note}.`);
  if (out.chosen) lines.push(`Models measured: ${out.chosen.slugs.join(', ')} (${out.chosen.why}).`);
  lines.push('',
    '| Model | Answer format (JSON schema) | Right | Wrong | Unsure | Refused | Every fact | Nothing invented | First byte, median / worst | Whole answer, median / worst | Tokens in / out (of it reasoning), median |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const m of out.measured) {
    const c = m.cases;
    const n = (o) => c.filter((x) => x.outcome === o).length;
    const ms = (k) => c.map((x) => x.ms[k]).filter((v) => v != null);
    const tk = (k) => median(c.map((x) => x.tokens[k]).filter((v) => v != null));
    const format = m.format_accepted === true ? 'accepted' : m.format_accepted === false ? `refused: ${m.format_refused_with}` : 'not shown';
    const pair = (xs) => (xs.length ? `${(median(xs) / 1000).toFixed(1)} s / ${(worst(xs) / 1000).toFixed(1)} s` : '-');
    lines.push(m.unusable && !c.length
      ? `| ${m.model} | - | - | - | - | - | - | - | - | - | unusable: ${m.unusable} |`
      : `| ${m.model} | ${format} | ${n('right')} of ${c.length} | ${n('wrong')} | ${n('unsure')} | ${n('refused')} | ${c.filter((x) => !x.missing.length).length} of ${c.length} | ${c.filter((x) => !x.invented.length).length} of ${c.length} | ${pair(ms('first_byte'))} | ${pair(ms('done'))} | ${tk('input') ?? '-'} / ${tk('output') ?? '-'} (${tk('reasoning') ?? '-'}) |`);
  }
  lines.push('');
  for (const m of out.measured) {
    if (m.effort_refused_with) lines.push(`- ${m.model}: the reasoning effort was refused (${m.effort_refused_with}); asked without it.`);
    if (m.unusable) lines.push(`- ${m.model}: not measured further: ${m.unusable}`);
    for (const x of m.cases.filter((x) => x.outcome !== 'right')) lines.push(`- ${m.model}, ${x.thought}: ${x.outcome}, ${x.went ?? x.why}`);
  }
  if (out.stopped) lines.push(`- Stopped at ${out.stopped.at}: ${[out.stopped.status, out.stopped.code, out.stopped.message].filter((v) => v != null && v !== '').join(', ')}${out.stopped.what_to_do ? `; ${out.stopped.what_to_do}` : ''}`);
  const costly = new Map();
  for (const m of out.measured) for (const x of m.cases) for (const [k, v] of Object.entries(x.cost_headers ?? {})) costly.set(k, v);
  lines.push(costly.size
    ? `- Headers that may tell usage or cost (last value seen): ${[...costly].map(([k, v]) => `${k}: ${v}`).join('; ')}`
    : '- No header named for usage, limits, credits or cost came with any answer.');
  const usageKeys = new Set(out.measured.flatMap((m) => m.cases.flatMap((x) => Object.keys(x.usage ?? {}))));
  if (usageKeys.size) lines.push(`- What each answer's usage reports: ${[...usageKeys].join(', ')}.`);
  lines.push(`- Every header name that came: ${out.headers_seen.join(', ') || 'none'}.`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--list-only') args.listOnly = true;
    else if (a === '--refresh') args.refresh = true;
    else if (a === '--models') args.models = (argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--effort') args.effort = argv[++i];
    else if (a === '--question') args.question = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.question) {
    const fx = fixture();
    const t = fx.thoughts.find((x) => x.name === args.question);
    if (!t) throw new Error(`no thought is called ${args.question}`);
    const effort = args.effort === 'default' ? null : (args.effort ?? 'low');
    console.log(JSON.stringify(body(fx, t, { model: '<model>', effort, format: true }), null, 2));
    return;
  }
  const s = settings();
  const out = await measure({ s, net: network({ budget: BUDGET }), args });
  process.exitCode = out.stopped ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main(process.argv.slice(2));
