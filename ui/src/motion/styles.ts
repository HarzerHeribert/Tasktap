// The forms the motion draws, as the lab has them: each its fragment shader after the shared head (head.ts), how
// many elements it draws at each kind of size, and eight parameters for each of the seven states.
//   p0 how much the voice moves it      p4 gather to the centre and beat (needs you)
//   p1 how fast its own motion runs     p5 resolve to an even, quiet form (done)
//   p2 size of the resting wave         p6 slump (failed)
//   p3 a packet shuttling (thinking)    p7 the style's own extra
import { glyph, glyphs } from './glyphs.ts';
import { resonator } from './resonator.ts';
import { slats } from './slats.ts';

export type Size = 'hero' | 'icon' | 'box' | 'strip';
export type Style = { id: string; n: Record<Size, number>; p: number[][]; frag: string };

/** The forms a person chooses between, and the single glyph the window's foot and its wake are made of. */
export const STYLES = { slats, glyphs, resonator, glyph };
export type StyleId = keyof typeof STYLES;
