// The ambient light's setting: Off, Still or Breathing. The core has no preference for it yet, so the page keeps it
// (`motion_ambient`, "off" | "still" | "breathing", default "breathing", is the key the core needs); a page that cannot
// read its storage uses the default.
export type Ambient = 'off' | 'still' | 'breathing';
const KEY = 'tasktap.motion_ambient';

let value: Ambient | null = null;
export function ambient(): Ambient {
  if (value) return value;
  try {
    const v = localStorage.getItem(KEY);
    value = v === 'off' || v === 'still' ? v : 'breathing';
  } catch {
    value = 'breathing';
  }
  return value;
}
export function setAmbient(v: Ambient) {
  value = v;
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // Kept for this page's life only.
  }
}
