// A shortcut as the core keeps it (design §5, "Settings"): the modifiers held and the key by its place on the keyboard.
// Here it is written out as a Mac shows it, compared with a key press, and read from one. Whether a combination may
// be a shortcut is the core's rule and the host's, never the page's: a recorder tries what was pressed and shows the
// sentence that comes back.
import type { Shortcut } from '../../core/proto/protocol.ts';
import { pref } from './page.ts';

const NAMES: Record<string, string> = {
  Enter: '↩', Tab: '⇥', Escape: 'esc', Backspace: '⌫', Delete: '⌦', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Home: '↖', End: '↘',
  PageUp: '⇞', PageDown: '⇟', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`',
  Comma: ',', Period: '.', Slash: '/',
};
/** The modifiers of a shortcut or a key press, in a Mac's order. */
const mods = (s: { control: boolean; alt: boolean; shift: boolean; meta: boolean }) => (s.control ? '⌃' : '') + (s.alt ? '⌥' : '') + (s.shift ? '⇧' : '') + (s.meta ? '⌘' : '');
/** A shortcut as ui.tsx `Key` takes it: "⌃⌥Space". A key is named as the US keyboard prints it. */
export const keyName = (s: Shortcut) => mods(s) + (NAMES[s.code] ?? s.code.replace(/^(Key|Digit)/, ''));
/** What a key press is as a shortcut, and the modifiers alone while only they are held. */
export const pressed = (e: KeyboardEvent): Shortcut => ({ control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, code: e.code });
export const heldNow = (e: KeyboardEvent) => mods(pressed(e));
export const isModifier = (e: KeyboardEvent) => ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key);
export const holds = (e: KeyboardEvent, s: Shortcut) => e.code === s.code && e.ctrlKey === s.control && e.altKey === s.alt && e.shiftKey === s.shift && e.metaKey === s.meta;

/** The key held to talk: the `talk_key` preference, else Option-Space. */
export const talkKey = (): Shortcut => pref('talk_key') ?? { control: false, alt: true, shift: false, meta: false, code: 'Space' };
/** A recorder is listening for a combination: every key is its own until it has one, so nothing else acts on them. */
export const recorder = { on: false };
