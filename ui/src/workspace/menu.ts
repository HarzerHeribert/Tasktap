// Context menus are the system's own, drawn by the host (Tauri's menu API), never by the page.
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';

export type Item = { text: string; do: () => void; key?: string; off?: boolean } | '-';

/** For the checks, which never open a system menu (`dry`): the last menu asked for, by its items' words. */
export const shown: { items: Item[]; dry: boolean } = { items: [], dry: false };

/** Shows a system menu at the pointer, or under the element a key opened it from. */
export async function popup(e: Event, items: Item[]) {
  e.preventDefault();
  e.stopPropagation();
  shown.items = items;
  if (shown.dry) return;
  try {
    const built = await Promise.all(items.map((i) =>
      i === '-' ? PredefinedMenuItem.new({ item: 'Separator' }) : MenuItem.new({ text: i.text, enabled: !i.off, accelerator: i.key, action: () => i.do() })));
    const menu = await Menu.new({ items: built });
    await menu.popup();
  } catch {
    // No host to draw it (the pages rendered without one): nothing to show.
  }
}

/** Runs the item of the last menu whose words are `text`, as choosing it would (debug channel). */
export function choose(text: string) {
  const i = shown.items.find((x) => x !== '-' && x.text === text);
  if (i && i !== '-') i.do();
  return !!i;
}
