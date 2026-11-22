// What the Composer's place chooser says (capture.tsx draws it): Auto, a folder, or the Scratchpad, in plain names
// (the owner's decision of 2026-11-21). The chip, closed, is one name; why the task goes there is its tooltip, one
// sentence each. The list, opened, offers the same three, each row's few dim words set apart by a gap, never a dot.
// And the rows of the question Tasktap asks when Auto cannot place a task (question.tsx draws them).
import { SCRATCHPAD } from './client.ts';

/** Why the task in the field goes where it goes (capture.tsx `where`). */
export type Why = 'chosen' | 'follows' | 'named' | 'said' | 'asked' | 'in' | 'model' | 'only' | 'words' | 'ask' | 'starting';
/** What a place is: a folder (open, or a project Tasktap knows), the Scratchpad, a session followed up, or For later. */
export type Is = 'folder' | 'scratch' | 'session' | 'later';
/** The icon a row or the chip shows (ui.tsx), or For later's mark. */
export type Icon = 'arrow' | 'folder' | 'pad' | 'term' | 'plus' | 'search' | 'later';
const ICON: Record<Is, Icon> = { folder: 'folder', scratch: 'pad', session: 'term', later: 'later' };

export type Chip = { mark: Icon; name: string; auto: boolean; title: string };
/** What the chip says. `place`: the project's or the session's name; `fresh`: a project not open yet, which sending the
 *  task opens; `agent`: the one that reads a task that names no project, where placing by a model is agreed to; `back`:
 *  the task before had a place of its own; `key`: ⌘K as this system spells it. `auto`: the place Auto found, which
 *  the chip follows with the word Auto in the dim tone. */
export function says(why: Why, f: { place: string; is: Is; fresh?: boolean; agent?: string; back?: boolean; key: string }): Chip {
  const click = `Click (or ${f.key}) to`, opens = f.fresh ? ` Sending the task opens ${f.place}.` : '';
  let c: Chip;
  switch (why) {
    case 'follows':
    case 'named':
    case 'said':
      c = { mark: ICON[f.is], name: f.is === 'session' ? `Follow-up: ${f.place}` : f.place, auto: true,
        title: `Auto: the task ${f.is === 'session' ? 'continues' : 'names'} ${f.place}.${opens} ${click} choose another place.` };
      break;
    case 'chosen':
    case 'in':
    case 'only':
      c = { mark: ICON[f.is], name: f.place, auto: false, title: `${
        f.is === 'later' ? 'For later: the task waits on Home, and nothing starts.'
          : f.is === 'scratch' ? 'Scratchpad: the agent works in Tasktap’s own empty folder, for a task that belongs to no project.'
            : why === 'only' ? `${f.place} is the only folder open, so a task that names no other project goes to ${f.place}.`
              : `The task goes to ${f.place}.${opens}`} ${click} change the place.` };
      break;
    case 'asked':
      c = { mark: 'arrow', name: 'Auto', auto: false, title: `Auto: the task names more than one project, so Tasktap asks you which. ${click} choose the place yourself.` };
      break;
    default:
      // Nothing known yet ('starting' is hidden, and keeps the place these words take).
      // With a model, the model decides every task the person does not place, a project named among what it reads.
      c = { mark: 'arrow', name: 'Auto', auto: false, title: f.agent
        ? `Auto: ${f.agent} reads the task and chooses its project, and whether an agent at work there continues. ${click} choose the place yourself.`
        : `Auto: Tasktap sends the task to the project the task names, and asks you when the task names none. ${click} choose the place yourself.` };
  }
  return f.back ? { ...c, name: `Back to ${c.name}`, title: `Your choice was for the task before. ${c.title}` } : c;
}

/** A row of the list: `to` is what choosing it picks ('' Auto, 'later', or a project), or 'add' to open a folder. */
export type Row = { to: string; mark: Icon; name: string; dim: string[] };
/** The list's rows under its field, top to bottom: what the field or the task's words found; Auto; the open folders,
 *  `most` at most; the Scratchpad, also when it was put away; Open another folder…; For later. While something is typed
 *  in the field, only what it found; sending a task kept for later, never Auto or For later. With no project known Auto
 *  is there still: it asks where the agent should work. */
export function rows(o: { found: { id: string; name: string; why: string; fresh: boolean }[]; open: { id: string; name: string; kind: string }[]; typed: boolean; moving: boolean; most: number }): Row[] {
  const all = !o.typed, row = (to: string, mark: Icon, name: string, ...dim: string[]): Row => ({ to, mark, name, dim });
  return [
    ...o.found.map((f) => row(f.id, 'folder', f.name, ...[f.why, f.fresh ? 'not open yet' : ''].filter(Boolean))),
    ...(all && !o.moving ? [row('', 'arrow', 'Auto', 'finds the project')] : []),
    ...(all ? o.open.filter((p) => p.kind !== 'scratch').slice(0, o.most).map((p) => row(p.id, 'folder', p.name)) : []),
    ...(all ? o.open.filter((p) => p.kind === 'scratch').map((p) => row(p.id, 'pad', SCRATCHPAD, 'no project needed')) : []),
    row('add', 'plus', 'Open another folder…'),
    ...(all && !o.moving ? [row('later', 'later', 'For later')] : []),
  ];
}

/** A task's words where a name or a tooltip carries them: the first 300 characters, then an ellipsis. */
export const short = (text: string) => ([...text].length <= 300 ? text : `${[...text].slice(0, 300).join('')}…`);

/** A row of the question Tasktap asks when Auto cannot place a task: `at` is a place's index among the question's own
 *  (`places`, `notes`), which answering with it chooses; the person's own answers have none. `dim`: why it is
 *  offered, in the dim tone after its name (nothing for a name the task says); `title`: what sending it there does. */
export type Asked = { does: 'create' | 'place' | 'session' | 'folder' | 'scratch' | 'other' | 'later'; name: string; mark: Icon; dim: string; title?: string; at?: number };
/** The question's rows, each on its number from 1 (NOTES §13). A new project a model proposed (`create`) leads, with
 *  its place in the dim tone: "New project tide-notes", or the folder by its name where that is there already. With
 *  places its words name or clearly describe (the core's, three at most): those, then Another project…, the
 *  Scratchpad and Keep for later. With none: Open or create a folder… first, then the Scratchpad, Another project…
 *  where Tasktap knows any project (`known`), and Keep for later. Whether a project is open in Tasktap is no reason to
 *  choose it: only its tooltip says that sending opens it. */
export function asked(o: { places: { name: string; why: string; fresh: boolean; session: boolean }[]; known: boolean; create?: { name: string; place: string; exists: boolean } | null }): Asked[] {
  const other: Asked = { does: 'other', name: 'Another project…', mark: 'search', dim: '' };
  const own: Asked[] = [{ does: 'scratch', name: SCRATCHPAD, mark: 'pad', dim: '' }, { does: 'later', name: 'Keep for later', mark: 'later', dim: '' }];
  const c = o.create;
  const lead: Asked[] = c ? [{ does: 'create', name: c.exists ? c.name : `New project ${c.name}`, mark: c.exists ? 'folder' : 'plus', dim: `in ${c.place}`,
    title: c.exists ? `Sending the task opens the folder ${c.name} in ${c.place}.` : `Sending the task makes the folder ${c.name} in ${c.place} and starts the task there.` }] : [];
  if (!o.places.length) return [...lead, { does: 'folder', name: 'Open or create a folder…', mark: 'plus', dim: '' }, own[0]!, ...(o.known ? [other] : []), own[1]!];
  const places = o.places.map((p, at): Asked => ({ does: p.session ? 'session' : 'place', name: p.name, mark: p.session ? 'term' : 'folder', dim: p.why, at,
    ...(p.fresh ? { title: `Sending the task opens ${p.name}.` } : {}) }));
  return [...lead, ...places.slice(0, 6 - lead.length), other, ...own];
}
