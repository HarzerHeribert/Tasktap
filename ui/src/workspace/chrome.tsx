// The window's own chrome on Windows (host/src/chrome.rs). The Mac has the app's commands in the system's menu bar
// and the window's three buttons over the page's top row; on Windows the top row is the title bar, and holds both:
// one quiet menu button at its left, which opens the same commands grouped as the Mac's menus are, each with its
// Windows key (Alt alone or F10 opens it from the keyboard), and the three caption buttons at its right.
import { COMMANDS, spell } from '../keys.ts';
import { call, fail, redraw } from '../page.ts';
import { I } from '../ui.tsx';
import { type Item, popup } from './menu.ts';
import { current, open } from './model.ts';
import { engines } from './terminal.ts';

type Run = (command: string) => void;
type Does = 'minimize' | 'maximize' | 'close';
const windowDoes = (what: Does) => void call('host.window', { do: what }).catch(fail);

/** What the host says of the caption buttons: the one under the pointer, the one held down, and whether the window
 *  is maximised. A window lies over them there, so that Windows offers its Snap layouts on Maximize; the pointer
 *  never reaches the page's buttons, and the keyboard does. */
export const caption = { over: '', down: '', max: false };
export function heard(said: { over?: string; down?: string; max?: boolean }) {
  Object.assign(caption, { over: said.over ?? '', down: said.down ?? '', max: !!said.max });
  redraw();
}

/** Edit's commands act on what has the keyboard: the terminal in front, or a field. */
function edit(what: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll', run: Run) {
  const at = document.activeElement;
  const term = at instanceof Element && at.closest('.xterm') ? engines.get(current()?.id ?? '')?.term : undefined;
  if (term) return what === 'copy' || what === 'paste' ? run(what) : what === 'selectAll' ? term.selectAll() : undefined;
  if (what === 'paste') return void call('host.clipboard', {}).then((text) => text && document.execCommand('insertText', false, text), fail);
  document.execCommand(what);
}

/** The app's commands, grouped as the Mac's menus are. */
export function menus(run: Run): Item[] {
  const does = (text: string, id: string): Item => ({ text, key: COMMANDS[id], do: () => run(id) });
  const edits = (text: string, key: string, what: Parameters<typeof edit>[0]): Item => ({ text, key, do: () => edit(what, run) });
  return [
    { text: 'File', items: [does('New Task', 'new-task'), does('New Terminal', 'new-terminal'), does('Open Workspace…', 'open-workspace'), '-', does('Close Tab', 'close-tab')] },
    { text: 'Edit', items: [edits('Undo', '⌃Z', 'undo'), edits('Redo', '⌃Y', 'redo'), '-', edits('Cut', '⌃X', 'cut'), edits('Copy', '⌃C', 'copy'), edits('Paste', '⌃V', 'paste'),
      edits('Select All', '⌃A', 'selectAll'), '-', does('Find in Terminal…', 'find')] },
    { text: 'View', items: [does('Toggle Sidebar', 'sidebar'), does('Focus Surface', 'focus'), does('Split Right', 'split-right'), does('Split Down', 'split-down'), '-',
      does('Switch Terminal and Preview', 'preview'), does('Reload Preview', 'reload-preview'), '-',
      does('Increase Text Size', 'bigger'), does('Decrease Text Size', 'smaller'), does('Reset Text Size', 'reset'), '-', does('Settings…', 'settings')] },
    { text: 'Window', items: [{ text: 'Minimize', do: () => windowDoes('minimize') }, { text: caption.max ? 'Restore' : 'Maximize', do: () => windowDoes('maximize') }] },
    '-',
    { text: 'About Tasktap', do: () => open({ kind: 'settings', at: 'about' }) },
    { text: 'Exit', key: '⌥F4', do: () => windowDoes('close') },
  ];
}

/** Opens the menu under its button, from a click or from the keyboard. */
export function openMenu(run: Run, e: Event = new Event('menu')) {
  const button = document.querySelector('#menu-button');
  if (button) void popup(e, menus(run), button);
}

/** The menu button. Pressing it leaves the keyboard where it is: Edit's commands act on what has it. */
export function MenuButton({ run }: { run: Run }) {
  return (
    <button type="button" class="ib" id="menu-button" title={`Menu  ${spell('⌥')}`} aria-label="Menu" aria-haspopup="menu"
      onPointerDown={(e) => e.preventDefault()} onClick={(e) => openMenu(run, e)}><I n="menu" /></button>
  );
}

/** The caption buttons, as Windows 11 draws its own: hairline glyphs ten pixels across, Close red under the pointer. */
export function Caps() {
  const cap = (what: Does, label: string, glyph: preact.JSX.Element) => (
    <button type="button" class={`cap ${what}${caption.over === what ? ' over' : ''}${caption.down === what ? ' down' : ''}`} aria-label={label} onClick={() => windowDoes(what)}>
      <svg viewBox="0 0 10 10" aria-hidden="true">{glyph}</svg>
    </button>
  );
  return (
    <span class="caps" role="group" aria-label="Window">
      {cap('minimize', 'Minimize', <path d="M0 5.5h10" />)}
      {cap('maximize', caption.max ? 'Restore' : 'Maximize', caption.max
        ? <><path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" /><rect x=".5" y="2.5" width="7" height="7" rx="1" /></>
        : <rect x=".5" y=".5" width="9" height="9" rx="1" />)}
      {cap('close', 'Close', <path d="M.5.5l9 9M9.5.5l-9 9" />)}
    </span>
  );
}
