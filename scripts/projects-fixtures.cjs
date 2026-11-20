// Fixture records for what Tasktap knows of a person's projects (ui/src/workspace/projects.tsx), rendered without the
// host by motion-pages.cjs: the first run on Home (the agents' history offered, what was found filling in, the folder
// most of them are in suggested, a person with no agent history) and Settings › Projects (every project, one opened
// with its copies and a folder inside it, a folder that is gone, one with too many folders, the ones set aside).
// Built on instrument-fixtures.cjs `scene`. Invented names only: the world of core/scripts/place-eval.json, in folders
// under /Users/someone. `projects(name, {now})` returns the records for one state; `ids` in them names the cards.
const { scene } = require('./instrument-fixtures.cjs');

const HOME = '/Users/someone';
const MIN = 60000, DAY = 864e5;
const hex = (n, w = 12) => n.toString(16).padStart(w, '0');
const cid = (n) => `019a8b6c-7d10-7000-a000-${hex(n)}`;
const lid = (n) => `019a8b6c-7d10-7000-b000-${hex(n)}`;

// The world: name, the line its README or package file gives, where it is kept, who worked there and how many days ago.
const WORLD = [
  ['cuegrid', 'Cue sheets and a rehearsal timer for stage managers', 'projects', ['claude'], 2],
  ['ledgerline', 'Invoicing for freelancers: invoices, reminders and PDF export', 'projects', ['codex'], 1],
  ['fieldnotes', 'Offline-first notes for field biologists, with photo attachments and sync', 'projects', ['claude', 'codex'], 0],
  ['kiln', 'A static site generator with incremental builds', 'projects', ['claude'], 4],
  ['pyrite', 'Property-based testing helpers for Python', 'projects', ['codex'], 6],
  ['tidepool', 'Self-hosted photo library with face grouping', 'projects', ['claude'], 9],
  ['harbormaster', 'Deploys containers to a small fleet over SSH', 'work', ['claude'], 12],
  ['lumenbox', 'DMX lighting control for small venues', 'projects', ['claude'], 17],
  ['quaycast', 'Podcast hosting: feeds, episode uploads and download statistics', 'work', ['codex'], 23],
  ['wrenmail', 'A mail client for the terminal', 'projects', ['claude'], 30],
  ['parcelpath', 'Tracks shipments across carriers and warns about delays', 'projects', ['codex'], 41],
  ['orbitdeck', 'Dashboard for satellite pass predictions and antenna scheduling', 'projects', ['claude'], 55],
  ['penny-budget', 'Household budget with bank statement import and monthly reports', 'projects', ['claude'], 61],
  ['glyphsmith', 'A font editor for pixel typefaces', 'projects', ['claude'], 66],
  ['thermalog', 'Logs temperatures from greenhouse sensors and draws charts', 'projects', [], 70],
  ['recipebox', 'Recipes with scaling of ingredients and a shopping list', 'projects', ['codex'], 74],
  ['sprocket', 'Bike workshop bookings and repair tickets', 'work', ['claude'], 80],
  ['vellum', 'Converts Markdown manuscripts to print-ready PDF books', 'projects', ['claude'], 88],
  ['hexwatch', 'Watches the network for new devices and alerts by mail', 'projects', [], 95],
  ['choirbook', 'Sheet music library and attendance for choirs', 'projects', ['claude'], 101],
  ['cuegrid-web', 'Marketing site and documentation of cuegrid', 'projects', ['claude'], 3],
  ['ledger-api', 'Public HTTP API for ledgerline: customers, invoices, payments', 'work', ['codex'], 5],
  ['fieldkit', 'Hardware test rig for the fieldnotes GPS logger', 'projects', [], 110],
  ['tidepool-mobile', 'Phone app that uploads photos to tidepool', 'projects', ['claude'], 14],
  ['kiln-themes', 'Themes and templates for kiln sites', 'projects', [], 120],
  ['lumenbox-firmware', 'Firmware of the lumenbox DMX interface', 'projects', ['claude'], 20],
  ['mosaic-ui', 'A component library: buttons, tables, dialogs, date pickers', 'projects', ['codex'], 130],
  ['sidecar-auth', 'Single sign-on proxy that sits in front of internal tools', 'work', ['claude'], 140],
  ['tallyho', 'Counts visitors with door sensors for small museums', 'projects', [], 150],
  ['ferrywise', 'Timetables and live delays for island ferries', 'projects', ['claude'], 160],
  ['quillfeather', 'A distraction-free writing app with chapters and word goals', 'projects', ['claude'], 170],
  ['snowline', 'Avalanche bulletin reader with offline maps', 'projects', [], 180],
  ['mapstitch', 'Stitches drone photos into one orthophoto map', 'projects', ['codex'], 190],
  ['barometer', 'Uptime checks and a public status page', 'projects', [], 200],
  ['dotfiles', '', 'projects', ['claude'], 7],
];

/** A card as the core keeps it (core/proto/protocol.ts Card). */
function card(n, now, [name, about, at, agents, days], o = {}) {
  const git = !['dotfiles', 'thermalog'].includes(name);
  return {
    id: cid(n), rev: 1, folder: o.folder ?? `${HOME}/${at}/${name}`, name, names: o.names ?? [], about,
    about_from: about ? (o.from ?? (n % 3 === 1 ? 'package.json' : 'README.md')) : null,
    why: o.why ?? [...(agents.length ? ['agent'] : []), ...(git ? ['git'] : []), ...(about && n % 3 === 1 ? ['package'] : [])],
    agents, repo: git ? `root ${hex(n * 7919, 40)}` : null, copy_of: o.copy_of ?? null, inside: o.inside ?? null, project_id: o.project_id ?? null,
    used: days == null ? null : now - days * DAY - (n % 5) * 47 * MIN, looks: o.looks ?? [], hidden: !!o.hidden, main: !!o.main, available: o.available ?? true, isolate: o.isolate ?? 'busy',
  };
}
const look = (n, now, o) => ({ id: lid(n), rev: 1, kind: o.agent ? 'agent' : 'folder', agent: o.agent ?? null, folder: o.folder ?? null, on: o.on ?? true,
  state: o.state ?? 'ready', found: o.found ?? 0, looked: o.looked === undefined ? now - 2 * MIN : o.looked, note: o.note ?? null });

const AGENTS = [{ agent: 'claude', name: 'Claude Code' }, { agent: 'codex', name: 'Codex' }];

/** A Home with nothing on it yet: no folder open, nothing sent. */
function bare(now) {
  const r = scene('first', { now });
  return { ...r, thoughts: [], projects: r.projects.filter((p) => p.kind === 'scratch'), cards: [], looks: [] };
}

function projects(name, { now = Date.now() } = {}) {
  // ——— The first run ———
  if (name === 'first-agents' || name === 'first-found') {
    // Nine projects in the agents' history, each card arriving 90 ms after the last once the person allows it.
    return { ...bare(now), offer: { agents: AGENTS, places: [{ folder: `${HOME}/code`, projects: 0 }] },
      found: WORLD.slice(0, 9).map((w, i) => card(i + 1, now, w)) };
  }
  if (name === 'first-many') {
    // Thirty-five, most kept in ~/projects, which Tasktap has not looked in: it is suggested once they are in.
    const found = WORLD.map((w, i) => card(i + 1, now, w));
    return { ...bare(now), offer: { agents: AGENTS, places: [{ folder: `${HOME}/projects`, projects: found.filter((c) => c.folder.startsWith(`${HOME}/projects/`)).length }] }, found };
  }
  if (name === 'first-folders') {
    // No agent's history on this Mac: where are your projects? The usual folders that are there, ticked.
    return { ...bare(now), offer: { agents: [], places: ['projects', 'code', 'Developer'].map((f) => ({ folder: `${HOME}/${f}`, projects: 0 })) },
      found: WORLD.filter((w) => w[2] === 'projects').slice(0, 12).map((w, i) => card(i + 1, now, w, { why: ['git'], agents: [] })) };
  }
  // ——— Settings › Projects, over a Home with work on it ———
  const base = scene('normal', { now });
  const P = base.ids.projects;
  // The open workspaces are three of the projects, in the same folders.
  const where = { [P.cuegrid]: `${HOME}/projects/cuegrid`, [P.fieldnotes]: `${HOME}/projects/fieldnotes`, [P.ledger]: `${HOME}/work/ledger-api` };
  base.projects = base.projects.map((p) => (where[p.id] ? { ...p, folder: where[p.id] } : p));
  const L = {
    claude: look(1, now, { agent: 'claude', found: 27 }), codex: look(2, now, { agent: 'codex', found: 11 }),
    projects: look(3, now, { folder: `${HOME}/projects`, found: 29 }),
    archive: look(4, now, { folder: '/Volumes/archive/projects', state: 'gone', looked: now - 3 * DAY }),
    downloads: look(5, now, { folder: `${HOME}/Downloads`, state: 'many' }),
    src: look(6, now, { folder: `${HOME}/src` }),
  };
  const cards = WORLD.map((w, i) => card(i + 1, now, w, {
    looks: [...(w[3].includes('claude') ? [L.claude.id] : []), ...(w[3].includes('codex') ? [L.codex.id] : []), ...(w[2] === 'projects' ? [L.projects.id] : [])],
    project_id: { cuegrid: P.cuegrid, fieldnotes: P.fieldnotes, 'ledger-api': P.ledger }[w[0]] ?? null,
    names: w[0] === 'cuegrid' ? ['queue grid'] : w[0] === 'pyrite' ? ['pie right'] : [],
  }));
  const byName = Object.fromEntries(cards.map((c) => [c.name, c]));
  let n = 100;
  const extra = (w, o) => (cards.push(card(++n, now, w, o)), cards.at(-1));
  // Two other copies of cuegrid's repository, and a folder inside it where an agent was started.
  extra(['cuegrid', '', 'work', [], 40], { folder: `${HOME}/work/cuegrid-old`, copy_of: byName.cuegrid.id, why: ['git'] }).repo = byName.cuegrid.repo;
  extra(['cuegrid', 'Cue sheets and a rehearsal timer for stage managers', 'clones', ['codex'], 26], { folder: `${HOME}/clones/cuegrid`, copy_of: byName.cuegrid.id, looks: [L.codex.id] }).repo = byName.cuegrid.repo;
  extra(['web', '', 'projects', ['claude'], 3], { folder: `${HOME}/projects/cuegrid/web`, inside: byName.cuegrid.id, why: ['agent'], looks: [L.claude.id] });
  // What the gone volume held: kept, and not there now.
  for (const [i, w] of ['saltmarsh', 'basalt', 'inkwell', 'northwind-site', 'glyphsmith-2', 'vellum-old', 'tallyho-v1', 'kiln-2019'].entries())
    extra([w, '', 'archive', [], 200 + i * 30], { folder: `/Volumes/archive/projects/${w}`, looks: [L.archive.id], available: false, why: ['git'] });
  // Two the person said are no projects.
  extra(['scratchpad', '', 'projects', ['claude'], 1], { hidden: true, looks: [L.claude.id], why: ['agent'] });
  extra(['old-notes', '', 'projects', [], 300], { hidden: true, looks: [L.projects.id], why: ['package'] });
  const offer = { agents: AGENTS, places: [{ folder: `${HOME}/work`, projects: 6 }, { folder: `${HOME}/code`, projects: 0 }] };
  const looks = name === 'settings' || name === 'settings-open' || name === 'settings-hidden' ? [L.claude, L.codex, L.projects]
    : [L.claude, { ...L.codex, on: false, state: 'ready' }, L.projects, L.archive, L.downloads, L.src];
  return { ...base, cards, looks, offer, ids: { ...base.ids, cards: Object.fromEntries(cards.map((c) => [c.folder.replace(/^.*\//, ''), c.id])) } };
}

module.exports = { projects, HOME };
