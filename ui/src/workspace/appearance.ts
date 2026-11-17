// The terminals' look: one built-in look, Default, and the person's own font, size and line height from the Settings
// sheet. Default takes its colours from a terminal the owner likes (a GitHub-dark palette) on Instrument's black, and is
// set in Hack with the Nerd Fonts symbols, both shipped with the app (fonts.css), so it looks the same everywhere.

export type TerminalTheme = Record<string, string> & { background: string; foreground: string };
export type Look = {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorBlink: boolean;
  padding: string;
  theme: TerminalTheme;
};

/** Default's colours. Every colour but black keeps 4.5 : 1 on the background (bright black was lifted to do so);
 *  black stays dark, as programs paint backgrounds with it. */
export const DEFAULT: TerminalTheme = {
  background: '#0a0a0b', foreground: '#c9d1d9', cursor: '#c9d1d9', cursorAccent: '#93dbff', selectionBackground: '#30363d', selectionForeground: '#f0f3f6',
  black: '#545d68', red: '#f47067', green: '#57ab5a', yellow: '#c69026', blue: '#539bf5', magenta: '#b083f0', cyan: '#39c5cf', white: '#909dab',
  brightBlack: '#768390', brightRed: '#ff938a', brightGreen: '#6bc46d', brightYellow: '#daaa3f', brightBlue: '#6cb6ff', brightMagenta: '#dcbdfb',
  brightCyan: '#56d4dd', brightWhite: '#cdd9e5',
};
/** Default's faces: the bundled Hack, the bundled symbols for prompt icons, then the system's monospace face. */
export const DEFAULT_FONT = '"Hack", "Symbols Nerd Font Mono", ui-monospace, Menlo, monospace';

/** The person's own terminal settings. The core has no preferences for them yet, so the page keeps them; the keys it
 *  needs are `terminal_font` (text, empty for Default), `terminal_size` (number, 14) and `terminal_line_height` (number, 1). */
export type Own = { font: string; size: number; lineHeight: number };
const KEY = 'tasktap.terminal';
export function own(): Own {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Own>;
    return { font: typeof v.font === 'string' ? v.font : '', size: Number(v.size) || 14, lineHeight: Number(v.lineHeight) || 1 };
  } catch {
    return { font: '', size: 14, lineHeight: 1 };
  }
}
export function setOwn(o: Own) {
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    // Kept for this page's life only.
  }
}

/** The look the terminals take now. A family the person names comes first, with the symbols behind it. */
export function look(o = own()): Look {
  const family = o.font.trim() ? `${JSON.stringify(o.font.trim())}, "Symbols Nerd Font Mono", ${DEFAULT_FONT}` : DEFAULT_FONT;
  return { fontFamily: family, fontSize: o.size, lineHeight: o.lineHeight, cursorStyle: 'bar', cursorBlink: false, padding: '12px 14px', theme: { ...DEFAULT } };
}

/** Puts a look on the terminals' surroundings: their background, text colour and padding. */
export function apply(l: Look) {
  const root = document.documentElement.style;
  root.setProperty('--deck-bg', l.theme.background);
  root.setProperty('--deck-fg', l.theme.foreground);
  root.setProperty('--deck-padding', l.padding);
}

/** What xterm.js takes from a look: the theme over a clear background, so the pane's own shows. */
export const terminalOptions = (l: Look, fontSize: number) => ({
  fontFamily: l.fontFamily, fontSize, lineHeight: l.lineHeight, cursorStyle: l.cursorStyle, cursorBlink: l.cursorBlink,
  theme: { ...l.theme, background: l.theme.background + '00' },
});

/** The face the terminals measure their cells with, loaded before the first one opens. Bold, italic and the symbols
 *  are read when text first needs them: their widths are the cell's. */
export const fontsReady = () => document.fonts.load('14px Hack').catch(() => []);
