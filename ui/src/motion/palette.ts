// The colour of the motion's lights, as the lab's palettes have it: a palette changes the lights, never the metal.
// Chromatic is the lab's iridescent palette; custom is its free hue.
export type PaletteId = 'chrome' | 'chromatic' | 'warm' | 'cool' | 'custom';
export type RGB = [number, number, number];
export type Lights = { a: RGB; b: RGB; irid: number };

export const PALETTES: Record<Exclude<PaletteId, 'custom'>, Lights> = {
  chrome: { a: [0.86, 0.93, 1], b: [1, 0.8, 0.58], irid: 0 },
  chromatic: { a: [0.8, 0.9, 1], b: [1, 0.82, 0.7], irid: 1 },
  warm: { a: [1, 0.72, 0.44], b: [1, 0.4, 0.22], irid: 0 },
  cool: { a: [0.4, 0.72, 1], b: [0.62, 0.48, 1], irid: 0 },
};

export const hsl = (h: number, s: number, l: number): RGB =>
  [0, 8, 4].map((n) => {
    const k = (n + h / 30) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  }) as RGB;

/** The two lights of a palette; a custom one takes its hue and one 42 degrees on. */
export function lights(palette: PaletteId, hue: number): Lights {
  if (palette !== 'custom') return PALETTES[palette] ?? PALETTES.chromatic;
  const h = ((hue % 360) + 360) % 360;
  return { a: hsl(h, 1, 0.64), b: hsl((h + 42) % 360, 1, 0.6), irid: 0 };
}

/** The shader's iridescence, `hue(t)` in head.ts. */
const iridescent = (t: number): RGB => [0, 0.33, 0.67].map((o) => 0.55 + 0.45 * Math.cos(6.2832 * (t + o))) as RGB;
const css = (c: RGB) => `rgb(${c.map((x) => Math.round(255 * Math.min(1, x))).join(' ')})`;

/** The palette as the stops of a gradient that repeats, for light drawn by CSS (the glow behind the notch). */
export function stops(palette: PaletteId, hue: number): string {
  const L = lights(palette, hue);
  const mid = L.a.map((v, i) => (v + L.b[i]!) / 2) as RGB;
  const colors = L.irid ? [0, 1, 2, 3, 4, 5, 6].map((k) => iridescent(k / 6)) : [L.a, mid, L.b, mid, L.a];
  return colors.map((c, i) => `${css(c)} ${Math.round((i / (colors.length - 1)) * 100)}%`).join(',');
}
