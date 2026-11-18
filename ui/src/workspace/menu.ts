// Context menus are the system's own, drawn by the host (Tauri's menu API), never by the page.
import { LogicalPosition } from '@tauri-apps/api/dpi';
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu';
import { accelerator } from '../keys.ts';

/** An item, a group of items under one name, or a line between items. `key`: the item's key, written as the Mac
 *  has it (keys.ts); the menu shows this system's key for it. */
export type Item = { text: string; do: () => void; key?: string; off?: boolean } | { text: string; items: Item[] } | '-';

/** For the checks, which never open a system menu (`dry`): the last menu asked for, by its items' words. */
export const shown: { items: Item[]; dry: boolean } = { items: [], dry: false };

const build = async (i: Item): Promise<MenuItem | PredefinedMenuItem | Submenu> =>
  i === '-' ? PredefinedMenuItem.new({ item: 'Separator' })
    : 'items' in i ? Submenu.new({ text: i.text, items: await Promise.all(i.items.map(build)) })
      : MenuItem.new({ text: i.text, enabled: !i.off, accelerator: i.key && accelerator(i.key), action: () => i.do() });

/** Shows a system menu at the pointer, or under `under`: the control a key or a click opened it from. */
export async function popup(e: Event, items: Item[], under?: Element) {
  e.preventDefault();
  e.stopPropagation();
  shown.items = items;
  if (shown.dry) return;
  try {
    const menu = await Menu.new({ items: await Promise.all(items.map(build)) });
    const r = under?.getBoundingClientRect();
    await menu.popup(r && new LogicalPosition(r.left, r.bottom + 2));
  } catch {
    // No host to draw it (the pages rendered without one): nothing to show.
  }
}

/** Every item that does something, the groups' own among them. */
const flat = (items: Item[]): Exclude<Item, '-' | { items: Item[] }>[] => items.flatMap((i) => (i === '-' ? [] : 'items' in i ? flat(i.items) : [i]));
/** Runs the item of the last menu whose words are `text`, as choosing it would (debug channel). */
export function choose(text: string) {
  const i = flat(shown.items).find((x) => x.text === text);
  i?.do();
  return !!i;
}
