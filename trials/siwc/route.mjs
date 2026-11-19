// The placing question as the product asks it, and its answer as the product takes it: a copy in JavaScript of
// `route::question`, `route::SCHEMA` and `route::accept` (core/src/route.rs) for the state of
// core/scripts/route-eval.json, and the judgement of core/examples/route-eval.rs. The instructions are read
// from core/src/route/instructions.md as they are committed. test.mjs holds the copy to the original: the
// schema to route.rs, every question to what `core/scripts/route-eval.sh --question` prints.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO } from './siwc.mjs';

export const FILES = {
  instructions: path.join(REPO, 'core', 'src', 'route', 'instructions.md'),
  fixture: path.join(REPO, 'core', 'scripts', 'route-eval.json'),
  rust: path.join(REPO, 'core', 'src', 'route.rs'),
};

export const instructions = () => readFileSync(FILES.instructions, 'utf8');
export const fixture = () => JSON.parse(readFileSync(FILES.fixture, 'utf8'));

/** `route::SCHEMA`: every field required, none added, as the strictest answer formats want. */
export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['quote', 'confidence', 'to', 'candidates', 'brief', 'title'],
  properties: {
    quote: { type: 'string' },
    confidence: { type: 'string', enum: ['clear', 'ambiguous', 'unknown'] },
    to: { type: 'string' },
    candidates: { type: 'array', items: { type: 'string' } },
    brief: { type: 'string' },
    title: { type: 'string' },
  },
};

/** The schema as route.rs writes it, for the test that holds the copy to it. */
export function rustSchema() {
  const src = readFileSync(FILES.rust, 'utf8');
  const body = src.match(/pub const SCHEMA: &str = concat!\(([\s\S]*?)\);/)?.[1];
  if (!body) throw new Error('route.rs has no SCHEMA to compare with');
  return JSON.parse([...body.matchAll(/r#"([\s\S]*?)"#/g)].map((m) => m[1]).join(''));
}

/** `cut`: the first `n` characters, on one line. */
const cut = (text, n) => [...text.split(/\s+/).filter(Boolean).join(' ')].slice(0, n).join('');

/** serde_json's objects are ordered maps: keys sorted, as the core writes them. */
const sorted = (v) => (Array.isArray(v) ? v.map(sorted)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);

/** The request of one thought: projects `p1`… and sessions `s1`… by their place in the fixture. */
export function request(fx, t) {
  const project = (name) => `p${fx.projects.findIndex((p) => p.name === name) + 1}`;
  const session = (key) => `s${fx.sessions.findIndex((s) => s.key === key) + 1}`;
  const place = (name) => (fx.sessions.some((s) => s.key === name) ? session(name) : project(name));
  return sorted({
    thought: t.text,
    current: t.current ? session(t.current) : null,
    picked: t.picked ? place(t.picked) : null,
    projects: fx.projects.map((p, i) => ({
      id: `p${i + 1}`,
      name: cut(p.name, 100),
      aliases: (p.aliases ?? []).slice(0, 3).map((a) => cut(a, 60)),
      about: cut(p.about ?? '', 160),
    })),
    sessions: fx.sessions.map((s, i) => ({
      id: `s${i + 1}`,
      name: s.name == null ? null : cut(s.name, 140),
      task: s.task,
      project: project(s.project),
      agent: s.agent,
      state: s.state,
    })),
    recent: fx.recent.map((e) => ({ session: session(e.session), request: e.request, status: e.status, result: e.result })),
  });
}

/** What follows the instructions in the product's one message. */
export const requestText = (fx, t) => `<request>\n${JSON.stringify(request(fx, t))}\n</request>\n`;

/** `route::question`: the instructions, then the request, as the product sends it to a coding CLI. */
export const productQuestion = (fx, t, text = instructions()) => `${text}\n${requestText(fx, t)}`;

/**
 * The same question for this endpoint, which takes no system message: the instructions go in `instructions`,
 * the request is the one user message. `format` asks for the schema as a fixed answer format.
 */
export function body(fx, t, { model, effort, format, text = instructions() }) {
  return {
    model,
    instructions: text,
    input: [{ role: 'user', content: requestText(fx, t) }],
    ...(effort ? { reasoning: { effort } } : {}),
    ...(format ? { text: { format: { type: 'json_schema', name: 'placing', schema: SCHEMA, strict: true } } } : {}),
    store: false,
    stream: true,
  };
}

/** `words`: lower-cased, one space between them, whatever the punctuation. */
const words = (text) => text.toLowerCase().split(/[^\p{Alphabetic}\p{N}]+/u).filter(Boolean).join(' ');
const says = (text, part) => {
  const p = words(part);
  return p !== '' && ` ${words(text)} `.includes(` ${p} `);
};
export const same = (brief, text) => words(brief) === words(text);
const chars = (text) => [...text].length;

class Refused extends Error {}

/** `Answer::read`: the one object, each field there and of its kind, and no other. */
function read(answer) {
  const wrong = (what) => new Refused(`its answer is not the JSON it was asked for: ${what}`);
  let fields;
  try {
    fields = JSON.parse(answer);
  } catch {
    throw wrong('it is no JSON object');
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw wrong('it is no JSON object');
  fields = { ...fields };
  const take = (key) => {
    const v = fields[key];
    delete fields[key];
    if (typeof v !== 'string') throw wrong(`${key} is no text`);
    return v;
  };
  const a = { quote: take('quote'), to: take('to'), brief: take('brief'), title: take('title') };
  a.confidence = take('confidence');
  if (!['clear', 'ambiguous', 'unknown'].includes(a.confidence)) throw wrong(`its confidence is ${JSON.stringify(a.confidence)}`);
  const list = fields.candidates;
  delete fields.candidates;
  if (!Array.isArray(list)) throw wrong('candidates is no list');
  if (list.some((k) => typeof k !== 'string')) throw wrong('candidates holds what is no text');
  a.candidates = list;
  const more = Object.keys(fields)[0];
  if (more !== undefined) throw wrong(`it has ${more}, which was not asked for`);
  return a;
}

/** `place`: the key a model names, as the key it was offered under, or null. */
function offeredKey(req, key) {
  const m = /^([ps])\+?(\d+)$/.exec(key);
  if (!m) return null;
  const at = Number(m[2]);
  const list = m[1] === 'p' ? req.projects : req.sessions;
  return at >= 1 && at <= list.length ? `${m[1]}${at}` : null;
}

/**
 * `route::accept`: the route an answer gives (`clear` to a key, `ambiguous` among keys, `unknown`), the words
 * it quoted and its title; or `{ refused }`, why the product would not use it.
 */
export function accept(fx, t, answer) {
  try {
    if (answer.length > 64 << 10) throw new Refused('its answer is too large');
    const req = request(fx, t);
    const a = read(answer);
    const offered = (key) => offeredKey(req, key) ?? (() => { throw new Refused(`it names ${JSON.stringify(key)}, which it was not offered`); })();
    const brief = () => {
      const b = a.brief.trim();
      if (!chars(b)) throw new Refused('it wrote no brief');
      if (chars(b) > 2 * chars(t.text) + 400) throw new Refused('its brief is longer than the thought allows');
      return b;
    };
    const title = a.title.trim();
    const plain = title !== '' && chars(title) <= 60 && !/\p{Cc}/u.test(title);
    const found = (quote) => ({ quote, title: plain ? title : null });
    if (req.picked) return { route: { kind: 'clear', to: req.picked, brief: brief() }, ...found(null) };
    if (a.confidence === 'unknown') return { route: { kind: 'unknown' }, quote: null, title: null };
    if (a.confidence === 'clear') {
      const to = offered(a.to);
      const quote = a.quote.trim();
      const quoted = chars(quote) >= 3 && says(t.text, quote);
      if (to.startsWith('s') && to !== req.current && !quoted) {
        throw new Refused('the words it quotes for a follow-up are not in the thought');
      }
      return { route: { kind: 'clear', to, brief: brief() }, ...found(quoted ? quote : null) };
    }
    const candidates = [];
    for (const key of a.candidates) {
      const c = offered(key);
      if (!candidates.includes(c)) candidates.push(c);
    }
    if (candidates.length < 2) throw new Refused('it is unsure and names fewer than two choices');
    return { route: { kind: 'ambiguous', candidates: candidates.slice(0, 3), brief: brief() }, ...found(null) };
  } catch (e) {
    if (e instanceof Refused) return { refused: e.message };
    throw e;
  }
}

/**
 * route-eval's judgement, in four outcomes: `right`; `wrong` (placed where it does not belong, or asked between
 * the wrong choices); `unsure` (asked the person or kept it where it should have placed it, or asked about a
 * note to self: nothing goes to a wrong place); `refused` (an answer the product would not take, so it would
 * place by names). Then the brief, as route-eval reads it: the facts it must have, what it must not invent.
 */
export function judge(fx, t, got) {
  const name = (key) => (key.startsWith('s') ? fx.sessions[Number(key.slice(1)) - 1].key : fx.projects[Number(key.slice(1)) - 1].name);
  const want = t.expect;
  const briefed = want.confidence !== 'unknown';
  if (got.refused) {
    return { outcome: 'refused', went: null, why: got.refused, brief: '', title: null, quote: null,
      missing: briefed ? t.must?.map((m) => m[0]) ?? [] : [], invented: [] };
  }
  const { route } = got;
  let right;
  let went;
  let brief = '';
  if (route.kind === 'clear') {
    went = name(route.to);
    brief = route.brief;
    right = want.confidence === 'clear' && want.to.includes(went);
  } else if (route.kind === 'ambiguous') {
    const names = route.candidates.map(name);
    went = `asks: ${names.join(' | ')}`;
    brief = route.brief;
    right = want.confidence === 'ambiguous' && (want.among ?? []).every((n) => names.includes(n));
  } else {
    went = 'kept for later';
    right = want.confidence === 'unknown';
  }
  const outcome = right ? 'right'
    : route.kind === 'clear' || (route.kind === 'ambiguous' && want.confidence === 'ambiguous') ? 'wrong' : 'unsure';
  const lower = brief.toLowerCase();
  const has = (spelling) => lower.includes(spelling.toLowerCase());
  const missing = (t.must ?? []).filter((fact) => briefed && !fact.some(has)).map((fact) => fact[0]);
  const invented = (t.must_not ?? []).filter(has);
  if (t.unchanged && !same(brief, t.text)) invented.push('changed');
  return { outcome, went, brief, title: got.title, quote: got.quote, missing, invented };
}
