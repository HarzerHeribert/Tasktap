// The workspace's look, as prototype/appearance.js and workspace-deck.js set it in 1.2: one
// palette for the chrome and the terminals, Midnight by default, or Follow Ghostty, which takes
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

/** The neutral look of 1.2's deck: Menlo 14, block cursor, 8 px padding, 0.93 opacity. */
export const neutral = (): Look => ({
  ghostty: false, fontFamily: '"Menlo", "Monaco", monospace', fontSize: 14, cursorStyle: 'block', cursorBlink: false,
  padding: '8px 8px 8px 8px', opacity: 0.93, theme: { ...midnight },
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

const channels = (v: string) => [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
const mix = (a: string, b: string, r: number) =>
  '#' + channels(a).map((v, i) => Math.round(v + (channels(b)[i]! - v) * r).toString(16).padStart(2, '0')).join('');
const luminance = (v: string) =>
  channels(v).map((c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
function legible(v: string, bg: string, ratio = 4.5) {
  const target = luminance(bg) < 0.25 ? '#ffffff' : '#111318';
  for (let i = 0; i <= 20; i++) {
    const c = mix(v, target, i / 20);
    if (contrast(c, bg) >= ratio) return c;
  }
  return target;
}

/** The chrome palette appearance.js derives from a terminal theme, as `--app-*` values. */
export function palette(theme: TerminalTheme): Record<string, string> {
  const bg = theme.background;
  const fg = legible(theme.foreground, bg, 7);
  const dark = luminance(bg) < 0.25;
  const accent = legible(theme.blue ?? '#a4bbef', bg);
  return {
    bg, fg, surface: mix(bg, fg, 0.025), raised: mix(bg, fg, dark ? 0.055 : 0.025), sidebar: mix(bg, fg, dark ? 0.035 : 0.025),
    overlay: mix(bg, fg, dark ? 0.065 : 0.018), input: dark ? mix(bg, fg, 0.035) : '#ffffff',
    muted: legible(mix(bg, fg, 0.67), mix(bg, fg, 0.12)), subtle: legible(mix(bg, fg, 0.52), mix(bg, fg, 0.12)),
    edge: mix(bg, fg, dark ? 0.15 : 0.17), 'edge-strong': mix(bg, fg, 0.3), hover: mix(bg, fg, 0.07), selected: mix(bg, fg, 0.105),
    accent, 'accent-ink': contrast(accent, '#111318') > contrast(accent, '#ffffff') ? '#111318' : '#ffffff',
    'accent-soft': mix(bg, accent, 0.13), positive: legible(theme.green ?? '#9bcba7', bg), warning: legible(theme.yellow ?? '#e9c387', bg),
    negative: legible(theme.red ?? '#f18b93', bg), shadow: dark ? '#00000066' : '#17203424',
  };
}

/** Puts a look on the page: the palette, the deck's colours and padding, and the window's tint. */
export function apply(look: Look) {
  const root = document.documentElement;
  const dark = luminance(look.theme.background) < 0.25;
  root.dataset.appearance = look.ghostty ? 'ghostty' : 'dark';
  root.dataset.appearanceMode = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
  for (const [k, v] of Object.entries(palette(look.theme))) root.style.setProperty('--app-' + k, v);
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
