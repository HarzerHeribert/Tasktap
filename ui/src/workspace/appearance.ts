// The terminals' look, as 1.2 set it: Midnight by default, or Follow Ghostty, which takes
// the colours, font, cursor, padding and opacity from Ghostty's own resolved configuration. The
// host runs `ghostty +show-config` and passes on only its appearance lines (host.appearance).

export type TerminalTheme = Record<string, string> & { background: string; foreground: string };
export type Look = {
  ghostty: boolean;
  fontFamily: string;
  fontSize: number;
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorBlink: boolean;
  padding: string;
  opacity: number;
  theme: TerminalTheme;
};

/** Midnight: the dark theme of 1.2 and the fallback when Ghostty says nothing. */
export const midnight: TerminalTheme = {
  background: '#111318', foreground: '#e4e6ed', cursor: '#e4e6ed', selectionBackground: '#38455d', selectionForeground: '#ffffff',
  black: '#23262e', red: '#f18b93', green: '#9bcba7', yellow: '#e9c387', blue: '#a4bbef', magenta: '#c8a8e9', cyan: '#8dcbd1', white: '#d9dce5',
  brightBlack: '#727989', brightRed: '#ffabb1', brightGreen: '#b3e0bc', brightYellow: '#f4d6a7', brightBlue: '#bdcefa',
  brightMagenta: '#dcc2f4', brightCyan: '#ace0e4', brightWhite: '#ffffff',
};
const ansi = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen',
  'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
const colorKeys: Record<string, string> = {
  background: 'background', foreground: 'foreground', 'cursor-color': 'cursor', 'cursor-text': 'cursorAccent',
  'selection-background': 'selectionBackground', 'selection-foreground': 'selectionForeground',
};

/** Midnight's look: Menlo 14, block cursor, padded 10 by 14 as Instrument pads a terminal, 0.93 opacity. */
export const neutral = (): Look => ({
  ghostty: false, fontFamily: '"Menlo", "Monaco", monospace', fontSize: 14, cursorStyle: 'block', cursorBlink: false,
  padding: '10px 14px 10px 14px', opacity: 0.93, theme: { ...midnight },
});

const hex = (v: string) => {
  const raw = v.replace(/^#/, '');
  return /^[\da-f]{6}$/i.test(raw) ? '#' + raw.toLowerCase() : null;
};
const pair = (v: string) => {
  const parts = v.split(',').map((p) => Number(p.trim()));
  return parts.length >= 1 && parts.length <= 2 && parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 128)
    ? [Math.round(parts[0]!), Math.round(parts.at(-1)!)] : null;
};

/** Reads `ghostty +show-config` lines as GhosttyAppearance.swift did. */
export function ghostty(text: string): Look {
  const look = neutral();
  look.ghostty = true;
  look.opacity = 1;
  const families: string[] = [];
  const palette = new Map<number, string>();
  let px = [8, 8];
  let py = [8, 8];
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at < 0 || line.trim().startsWith('#')) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim().replace(/^"|"$/g, '');
    const color = hex(value);
    if (colorKeys[key] && color) look.theme[colorKeys[key]] = color;
    const n = Number(value);
    if (key === 'font-family' && value && value.length < 160) families.push(value);
    else if (key === 'font-size' && Number.isFinite(n) && n >= 6 && n <= 72) look.fontSize = n;
    else if (key === 'background-opacity' && Number.isFinite(n) && n >= 0 && n <= 1) look.opacity = n;
    else if (key === 'cursor-style' && (value === 'bar' || value === 'block' || value === 'underline')) look.cursorStyle = value;
    else if (key === 'cursor-style-blink') look.cursorBlink = value === 'true';
    else if (key === 'window-padding-x') px = pair(value) ?? px;
    else if (key === 'window-padding-y') py = pair(value) ?? py;
    else if (key === 'palette') {
      const [i, c] = value.split('=');
      const index = Number(i);
      const parsed = hex((c ?? '').trim());
      if (Number.isInteger(index) && index >= 0 && index <= 255 && parsed) palette.set(index, parsed);
    }
  }
  ansi.forEach((name, i) => palette.has(i) && (look.theme[name] = palette.get(i)!));
  if (families.length) look.fontFamily = [...families.map((f) => JSON.stringify(f)), 'monospace'].join(', ');
  look.padding = `${py[0]}px ${px[1]}px ${py[1]}px ${px[0]}px`;
  return look;
}

/** Puts a look on the terminals: their colours, padding and opacity. The window around them is Instrument's and never
 *  takes a colour from them. */
export function apply(look: Look) {
  const root = document.documentElement;
  root.dataset.appearance = look.ghostty ? 'ghostty' : 'midnight';
  root.style.setProperty('--deck-bg', look.theme.background);
  root.style.setProperty('--deck-fg', look.theme.foreground);
  root.style.setProperty('--deck-padding', look.padding);
  root.style.setProperty('--window-opacity', String(look.opacity));
}

/** What xterm.js takes from a look: the theme over a clear background, so the window's tint shows. */
export const terminalOptions = (look: Look, fontSize: number) => ({
  fontFamily: look.fontFamily, fontSize, cursorStyle: look.cursorStyle, cursorBlink: look.cursorBlink,
  theme: { ...look.theme, background: look.theme.background + '00' },
});
