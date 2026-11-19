// Keys, in one place: how a key is named, which keys a command has, and whether a key press is one of them.
//
// The code writes a key as the Mac has it ("⌘T", "⇧⌘D", "⌃⌘S", "⌘⌫", "⌥Space", "esc", "↩"), and `local` gives the
// key this system has for it. On a Mac that is the same key. On Windows (docs/rebuild-plan.md, "Keys on Windows"):
//   1. Control stands where the Mac has Command.
//   2. With a letter, Shift is held too (⌘T is Ctrl+Shift+T), wherever the keyboard is: Control with a letter alone
//      belongs to the program in the terminal (Ctrl+C, Ctrl+D, Ctrl+R), and one command has one key.
//   3. With anything else (a digit, a comma, =, -, Backspace, Return) it is Control alone: Ctrl+, opens Settings.
//   4. A few are as Windows itself has them: WINDOWS below.
// A key is shown as the system writes it: "⇧⌘D" on a Mac, the modifiers in its order and no sign between them;
// "Ctrl+Shift+E" on Windows.
//
// A shortcut a person records (design §5, "Settings") is kept by the core as the modifiers held and the key by its
// place on the keyboard, and is shown as exactly those keys. Whether a combination may be a shortcut is the core's
// rule and the host's, never the page's: a recorder tries what was pressed and shows the sentence that comes back.
import type { Shortcut } from '../../core/proto/protocol.ts';
import { mac } from './system.ts';

type Mods = { control: boolean; alt: boolean; shift: boolean; meta: boolean };
/** Modifiers and a key, the key as the code writes it: a letter, a digit, a sign, or one of the names in NAMED. */
export type Chord = Mods & { key: string };

/** The Mac's signs for the modifiers, in the order a Mac writes them. */
const MODS = '⌃⌥⇧⌘';
const chord = (key: string, held = ''): Chord => ({ control: held.includes('⌃'), alt: held.includes('⌥'), shift: held.includes('⇧'), meta: held.includes('⌘'), key });
const parse = (k: string): Chord => chord([...k].filter((c) => !MODS.includes(c)).join(''), [...k].filter((c) => MODS.includes(c)).join(''));

/** The keys that are not Control (and Shift with a letter) for Command on Windows, by the Mac's key in a Mac's order. */
const WINDOWS: Record<string, Chord> = {
  // ⌘D is Ctrl+Shift+D already: the split below it takes the key beside it.
  '⇧⌘D': chord('E', '⌃⇧'),
  // Back, as Windows has it; Ctrl+[ is Escape to a terminal.
  '⌘[': chord('←', '⌥'),
  // To the end, as Windows has it.
  '⌘↓': chord('End', '⌃'),
  // Undo is Ctrl+Z wherever text is typed.
  '⌘Z': chord('Z', '⌃'),
};

/** A key in a Mac's order: the modifiers ⌃⌥⇧⌘, then the key. */
const ordered = (k: string) => [...k].filter((c) => MODS.includes(c)).sort((a, b) => MODS.indexOf(a) - MODS.indexOf(b)).join('') + [...k].filter((c) => !MODS.includes(c)).join('');

/** The key this system has for one written as the Mac has it. */
export function local(k: string, onMac = mac): Chord {
  const c = parse(k);
  if (onMac || !c.meta) return c;
  return WINDOWS[ordered(k)] ?? { control: true, alt: c.alt, shift: c.shift || /^[a-z]$/i.test(c.key), meta: false, key: c.key };
}

/** The commands' keys, written as the Mac has them: the Mac's menu shows the same (host/src/workspace.rs), the
 *  Windows menu button shows this system's (workspace/chrome.tsx), and the page acts on them (workspace/main.tsx). */
export const COMMANDS: Record<string, string> = {
  'new-task': '⌘N', 'new-terminal': '⌘T', 'open-workspace': '⌘O', 'close-tab': '⌘W', find: '⌘F', sidebar: '⌃⌘S', 'split-right': '⌘D', 'split-down': '⇧⌘D',
  preview: '⌘P', 'reload-preview': '⌘R', bigger: '⌘=', smaller: '⌘-', reset: '⌘0', settings: '⌘,', back: '⌘[', session: '⌘I',
};

/** What Windows prints on a key the Mac has a sign for. Return keeps its arrow: ui.tsx `Key` draws it. */
const PRINTED: Record<string, string> = { esc: 'Esc', '⌫': 'Backspace', '⌦': 'Del', '⇥': 'Tab', '↖': 'Home', '↘': 'End', '⇞': 'PgUp', '⇟': 'PgDn' };
/** The modifiers as Windows writes them: Win, Ctrl, Alt, Shift. */
const words = (s: Mods) => [s.meta && 'Win', s.control && 'Ctrl', s.alt && 'Alt', s.shift && 'Shift'].filter(Boolean) as string[];
/** The modifiers in a Mac's order. */
const signs = (s: Mods) => (s.control ? '⌃' : '') + (s.alt ? '⌥' : '') + (s.shift ? '⇧' : '') + (s.meta ? '⌘' : '');

/** A key as this system writes it, from one written as the Mac has it: "⇧⌘D" stays so on a Mac and is "Ctrl+Shift+E"
 *  on Windows. A key already in the system's words (`keyName`, `heldNow`) is shown as it is. */
export function spell(k: string, onMac = mac): string {
  if (onMac) return ordered(k);
  const c = local(k, false);
  return [...words(c), PRINTED[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key)].filter(Boolean).join('+');
}
/** A control's tooltip: what it does, and its key. */
export const tip = (does: string, k: string) => `${does}  ${spell(k)}`;

/** What a key press says its key is (KeyboardEvent.key), for the keys written by a name or a sign. */
const PRESSED: Record<string, string> = {
  esc: 'Escape', '↩': 'Enter', '⌫': 'Backspace', '⌦': 'Delete', '⇥': 'Tab', '↑': 'ArrowUp', '↓': 'ArrowDown', '←': 'ArrowLeft', '→': 'ArrowRight',
  '↖': 'Home', '↘': 'End', '⇞': 'PageUp', '⇟': 'PageDown', Space: ' ',
};
type Press = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;
/** Whether a key press is this system's key for one written as the Mac has it: exactly its modifiers, and its key
 *  as the keyboard's layout says it. */
export function hit(k: string, e: Press, onMac = mac): boolean {
  const c = local(k, onMac);
  return e.ctrlKey === c.control && e.altKey === c.alt && e.shiftKey === c.shift && e.metaKey === c.meta && e.key.toLowerCase() === (PRESSED[c.key] ?? c.key).toLowerCase();
}
/** Whether the modifier that makes a key a command is held, and nothing that makes it another key: Command on a Mac,
 *  Control on Windows. Shift is the caller's to judge. */
export const commands = (e: Press, onMac = mac) => (onMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey;
/** Whether a key press in a terminal is the app's and never the program's: anything with Command on a Mac; Control
 *  and Shift with a letter on Windows (rule 2). */
export const ours = (e: Press, onMac = mac) => (onMac ? e.metaKey : e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && /^[a-z]$/i.test(e.key));
/** The modifier that makes what a terminal printed a link while it is held, and whether a click has it. */
export const LINK = mac ? 'Meta' : 'Control';
export const links = (e: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>, onMac = mac) => (onMac ? e.metaKey : e.ctrlKey);

/** A key as a menu item takes it (Tauri's accelerator: "CmdOrCtrl+Shift+D"), for the system's own menus. */
export function accelerator(k: string, onMac = mac): string {
  const c = local(k, onMac);
  const named: Record<string, string> = { '⌫': 'Backspace', '⌦': 'Delete', '↩': 'Enter', '⇥': 'Tab', esc: 'Escape', '↑': 'ArrowUp', '↓': 'ArrowDown', '←': 'ArrowLeft', '→': 'ArrowRight', '↖': 'Home', '↘': 'End' };
  return [c.control && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', c.meta && 'CmdOrCtrl', named[c.key] ?? c.key].filter(Boolean).join('+');
}

// ——— The person's own keyboard ———
//
// A key bound by its place (a shortcut a person recorded, the keys that answer from any app) is named as the
// person's keyboard prints it: on a German one the key a US keyboard calls Z says Y, the one right of P says Ü, the one
// right of 0 says ß. What each place prints comes from the browser's layout map where there is one (WebView2 on
// Windows), else from the host (a Mac's web view has none: `host.layout`), and the US names stand until either says.
// Only names change: such a key is still matched by its place (`holds`), as the system registers it. A command's key
// (`spell`) is matched by the character it types, so its name is that character on any keyboard.

/** What each key prints, by its place (`KeyboardEvent.code`), lower case, as the layout in use says. */
let printed: ReadonlyMap<string, string> = new Map();
/** The keys whose name is what they print: letters, digits and the signs, never a named key such as Space. */
const PRINTS = /^(Key[A-Z]|Digit\d|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash|Intl(Backslash|Ro|Yen))$/;
/** Takes the layout in use, a map of what each key prints by its place; whether any key's name changed. */
export function learnLayout(map: ReadonlyMap<string, string> | Record<string, string> | null | undefined): boolean {
  const next = new Map([...(map instanceof Map ? map : Object.entries(map ?? {}))].filter(([code, ch]) => PRINTS.test(code) && typeof ch === 'string' && ch.trim().length === 1));
  if (next.size === printed.size && [...next].every(([code, ch]) => printed.get(code) === ch)) return false;
  printed = next;
  return true;
}
type Layouts = { keyboard?: { getLayoutMap?: () => Promise<ReadonlyMap<string, string>> } };
/** Reads the layout in use, from the browser or else from `host`, now, whenever the window comes back into use, and
 *  at a plain key that types something else than the layout said (another layout was chosen meanwhile); `changed`
 *  runs when a key's name changed. */
export function watchLayout(host: (() => Promise<Record<string, string>>) | undefined, changed: () => void) {
  const read = async () => {
    const kb = (navigator as Navigator & Layouts).keyboard;
    let map: ReadonlyMap<string, string> | Record<string, string> | null = null;
    try {
      map = kb?.getLayoutMap ? await kb.getLayoutMap() : host ? await host() : null;
    } catch {
      // No layout to be had: the names stay as they were.
    }
    if (map && learnLayout(map)) changed();
  };
  void read();
  addEventListener('focus', () => void read());
  addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.key.length !== 1 || !printed.has(e.code)) return;
    if (printed.get(e.code) !== e.key.toLowerCase()) void read();
  }, { capture: true, passive: true });
}
/** A key by its place, as the layout in use prints it: a letter as a capital (ß stays ß), a dead key as its mark. */
function printedAs(code: string): string | undefined {
  const ch = printed.get(code);
  if (!ch) return undefined;
  const up = ch.toUpperCase();
  return up.length === 1 ? up : ch;
}

// ——— A shortcut a person recorded ———

const NAMES: Record<string, string> = {
  Enter: '↩', Tab: '⇥', Escape: 'esc', Backspace: '⌫', Delete: '⌦', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Home: '↖', End: '↘',
  PageUp: '⇞', PageDown: '⇟', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`',
  Comma: ',', Period: '.', Slash: '/',
};
/** A shortcut as ui.tsx `Key` takes it: "⌃⌥Space" on a Mac, "Ctrl+Alt+Space" on Windows. A key is named as the
 *  person's keyboard prints it (`learnLayout`), as the US keyboard does until the layout is known. These are the keys
 *  themselves: Command is the Windows key there, never Control. */
export function keyName(s: Shortcut, onMac = mac): string {
  const key = printedAs(s.code) ?? NAMES[s.code] ?? s.code.replace(/^(Key|Digit)/, '');
  return onMac ? signs(s) + key : [...words(s), PRINTED[key] ?? key].join('+');
}
/** The key that goes to a waiting question from any app (host/src/main.rs ANSWER_KEYS: Control-Option-J on both
 *  systems), by its place. */
export const ANSWER: Shortcut = { control: true, alt: true, shift: false, meta: false, code: 'KeyJ' };
/** What a key press is as a shortcut, and the modifiers alone while only they are held. */
export const pressed = (e: KeyboardEvent): Shortcut => ({ control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, code: e.code });
export const heldNow = (e: KeyboardEvent, onMac = mac) => (onMac ? signs(pressed(e)) : words(pressed(e)).join('+'));
export const isModifier = (e: KeyboardEvent) => ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key);
export const holds = (e: KeyboardEvent, s: Shortcut) => e.code === s.code && e.ctrlKey === s.control && e.altKey === s.alt && e.shiftKey === s.shift && e.metaKey === s.meta;

/** The key held to talk where none is chosen: Option-Space on a Mac. On Windows Control-Space: Alt-Space opens the
 *  window's own menu there, and Control-Alt is AltGr, which types on a German keyboard. */
export const TALK: Shortcut = { control: !mac, alt: mac, shift: false, meta: false, code: 'Space' };
/** A recorder is listening for a combination: every key is its own until it has one, so nothing else acts on them. */
export const recorder = { on: false };
