// The terminals' look: one built-in look, Default, and the person's own font, size and line height from the Settings
// sheet. Default takes its colours from a terminal the owner likes (a GitHub-dark palette) on Instrument's black, and is
// set in Hack with the Nerd Fonts symbols, both shipped with the app (fonts.css), so it looks the same everywhere.
import { pref } from '../page.ts';

export type TerminalTheme = Record<string, string> & { background: string; foreground: string };
export type Look = {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorBlink: boolean;
  /** Bold text in the bright colours; a colour lifted until it reads on what is behind it (the two preferences). */
  boldBright: boolean;
  contrast: boolean;
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

/** The look the terminals take now, from the core's preferences: a family the person names comes first, with the
 *  symbols behind it; the size; the line height, kept in hundredths of the font's own. In rows taller than the font,
 *  blocks and box lines come from the face stretched to that height (fonts.css), so they still fill the row. */
export function look(): Look {
  const font = pref('terminal_font').trim(), height = pref('terminal_line_height');
  const blocks = height > 100 ? `"Blocks ${Math.min(130, Math.round(height / 10) * 10)}", ` : '';
  const family = blocks + (font ? `${JSON.stringify(font)}, "Symbols Nerd Font Mono", ${DEFAULT_FONT}` : DEFAULT_FONT);
  return { fontFamily: family, fontSize: pref('terminal_size'), lineHeight: height / 100, cursorStyle: 'bar', cursorBlink: false, boldBright: pref('terminal_bold_bright'), contrast: pref('terminal_contrast'), padding: '12px 14px', theme: { ...DEFAULT } };
}

/** Puts a look on the terminals' surroundings: their background, text colour and padding. */
export function apply(l: Look) {
  const root = document.documentElement.style;
  root.setProperty('--deck-bg', l.theme.background);
  root.setProperty('--deck-fg', l.theme.foreground);
  root.setProperty('--deck-padding', l.padding);
}

/** The size nearest to `size` at which a cell of the face is a whole number of pixels wide, as a native terminal
 *  sets its cells. A cell that ends between pixels blurs every letter differently and leaves a seam between the blocks
 *  and lines a full-screen program draws side by side. Default's 14 is then 13.3 px in cells of 8. */
export function snap(family: string, size: number) {
  const g = document.createElement('canvas').getContext('2d');
  if (!g) return size;
  g.font = `100px ${family}`;
  const advance = g.measureText('M').width / 100;
  return advance > 0.3 ? Math.max(4, Math.round(size * advance)) / advance : size;
}

/** What xterm.js takes from a look: its face at a size that fills whole pixels; the theme over a clear background, so
 *  the pane's own shows; and, unless the person turned it off, every colour a program asks for kept legible on whatever
 *  it is drawn over, as the system's own terminals and editors do (black text on a green badge stays readable). */
export const terminalOptions = (l: Look, fontSize: number) => ({
  fontFamily: l.fontFamily, fontSize: snap(l.fontFamily, fontSize), lineHeight: l.lineHeight, cursorStyle: l.cursorStyle, cursorBlink: l.cursorBlink,
  drawBoldTextInBrightColors: l.boldBright, minimumContrastRatio: l.contrast ? 4.5 : 1, theme: { ...l.theme, background: l.theme.background + '00' },
});

/** The face the terminals measure their cells with, loaded before the first one opens. Bold, italic and the symbols
 *  are read when text first needs them: their widths are the cell's. */
export const fontsReady = () => document.fonts.load('14px Hack').catch(() => []);
