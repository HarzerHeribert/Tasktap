// What the Composer's place chooser says (capture.tsx draws it): Auto, a folder, or the Scratchpad, in plain names
// (the owner's decision of 2026-11-21). The chip, closed, is one name; why the task goes there is its tooltip, one
// sentence each. The list, opened, offers the same three, each row's few dim words set apart by a gap, never a dot.
import { SCRATCHPAD } from './client.ts';

/** Why the task in the field goes where it goes (capture.tsx `where`). */
export type Why = 'chosen' | 'follows' | 'named' | 'said' | 'asked' | 'in' | 'model' | 'only' | 'words' | 'ask' | 'none' | 'starting';
/** What a place is: a folder (open, or a project Tasktap knows), the Scratchpad, a session followed up, or For later. */
export type Is = 'folder' | 'scratch' | 'session' | 'later';
/** The icon a row or the chip shows (ui.tsx), or For later's mark. */
export type Icon = 'arrow' | 'folder' | 'pad' | 'term' | 'plus' | 'later';
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
    case 'none':
      c = { mark: 'folder', name: 'No project yet', auto: false, title: `No project is open yet, so the task is saved for later. ${click} open a folder.` };
      break;
    default:
      // Nothing known yet ('starting' is hidden, and keeps the place these words take).
      c = { mark: 'arrow', name: 'Auto', auto: false, title: `Auto: Tasktap sends the task to the project the task names${
        f.agent ? `. When the task names none, ${f.agent} reads the task and chooses the project.` : ', and asks you when the task names none.'} ${click} choose the place yourself.` };
  }
  return f.back ? { ...c, name: `Back to ${c.name}`, title: `Your choice was for the task before. ${c.title}` } : c;
}

/** A row of the list: `to` is what choosing it picks ('' Auto, 'later', or a project), or 'add' to open a folder. */
export type Row = { to: string; mark: Icon; name: string; dim: string[] };
/** The list's rows under its field, top to bottom: what the field or the task's words found; Auto; the open folders,
 *  `most` at most; the Scratchpad; Open another folder…; For later. While something is typed in the field, only what it
 *  found; sending a task kept for later, never Auto or For later; with no project known, no Auto. */
export function rows(o: { found: { id: string; name: string; why: string; fresh: boolean }[]; open: { id: string; name: string; kind: string }[]; typed: boolean; moving: boolean; auto: boolean; most: number }): Row[] {
  const all = !o.typed, row = (to: string, mark: Icon, name: string, ...dim: string[]): Row => ({ to, mark, name, dim });
  return [
    ...o.found.map((f) => row(f.id, 'folder', f.name, ...[f.why, f.fresh ? 'not open yet' : ''].filter(Boolean))),
    ...(all && !o.moving && o.auto ? [row('', 'arrow', 'Auto', 'finds the project')] : []),
    ...(all ? o.open.filter((p) => p.kind !== 'scratch').slice(0, o.most).map((p) => row(p.id, 'folder', p.name)) : []),
    ...(all ? o.open.filter((p) => p.kind === 'scratch').map((p) => row(p.id, 'pad', SCRATCHPAD, 'no project needed')) : []),
    row('add', 'plus', 'Open another folder…'),
    ...(all && !o.moving ? [row('later', 'later', 'For later')] : []),
  ];
}
