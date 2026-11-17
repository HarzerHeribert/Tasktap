// Measurements the debug channel runs in a live terminal (host/scripts/measure.sh): the time
// from a key's bytes leaving the page to its echo drawn, and the rate of a burst of output.
import { engines } from './terminal.ts';

const frame = () => new Promise<number>((ok) => requestAnimationFrame(() => ok(performance.now())));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;

/** Waits until the terminal's screen holds `text` (checked as each write is parsed). */
function until(id: string, seen: (screen: string) => boolean, limit = 60000) {
  const term = engines.get(id)!.term;
  const screen = () => {
    const b = term.buffer.active;
    return Array.from({ length: term.rows }, (_, i) => b.getLine(b.baseY + i)?.translateToString(true) ?? '').join('\n');
  };
  return new Promise<void>((ok, no) => {
    if (seen(screen())) return ok();
    const timer = setTimeout(() => (sub.dispose(), no(new Error('timed out'))), limit);
    const sub = term.onWriteParsed(() => {
      if (!seen(screen())) return;
      clearTimeout(timer);
      sub.dispose();
      ok();
    });
  });
}

/** Typing delay: `n` keys typed into a shell at its prompt, each timed from its bytes leaving
 *  this page to the frame that draws its echo. Milliseconds: median and worst. */
export async function echo(id: string, n = 30) {
  const e = engines.get(id)!;
  const drawn: number[] = [];
  const parsed: number[] = [];
  for (let i = 0; i < n; i++) {
    const before = e.term.buffer.active.cursorX;
    // Each key starts at a random point of the frame, as a person's keys do.
    await new Promise((ok) => setTimeout(ok, 20 + Math.random() * 17));
    const t0 = performance.now();
    e.term.input('x', true);
    await until(id, () => e.term.buffer.active.cursorX !== before, 5000);
    parsed.push(performance.now() - t0);
    drawn.push((await frame()) - t0);
  }
  e.term.input('\x15', true);
  const r = (x: number) => Math.round(x * 10) / 10;
  return { drawn: r(median(drawn)), worst: r(Math.max(...drawn)), parsed: r(median(parsed)), n };
}

/** A burst: `bytes` of output from the shell (base64 of random data, 76 columns a line), timed
 *  from Enter to the line after it drawn. Megabytes per second, and whether it all arrived. */
export async function burst(id: string, bytes = 1_300_000) {
  const e = engines.get(id)!;
  const mark = `done-${Date.now()}`;
  const raw = Math.floor((bytes * 3) / 4);
  e.term.input(`clear; head -c ${raw} /dev/urandom | base64 -b 76; echo ${mark.replace('-', '-""')}\r`, true);
  const t0 = performance.now();
  await until(id, (s) => s.includes(mark), 120000);
  const ms = (await frame()) - t0;
  return { ms: Math.round(ms), mbps: Math.round((bytes / 1e6 / (ms / 1000)) * 10) / 10, lines: Math.round(bytes / 77), gaps: e.gaps };
}
