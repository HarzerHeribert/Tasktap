// Opening and folding the notch. The page decides; the host moves the panel and the keyboard.
import { call, fail, records, redraw, ui, type View } from './model.ts';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

export function reveal(mode: 'hover' | 'pinned', view: View, focus = '') {
  clearTimeout(ui.timer);
  ui.mode = ui.mode === 'pinned' ? 'pinned' : mode;
  ui.view = view;
  ui.retracting = false;
  ui.focus = focus;
  ui.error = '';
  void call('host.notch', { open: true, height: ui.height }).catch(fail);
  redraw();
}

export function fold() {
  if (ui.mode === 'closed') return;
  clearTimeout(ui.timer);
  Object.assign(ui, { mode: 'closed', retracting: true, choosing: false, replying: false, auto: false, error: '' });
  // A receipt whose hold is over is done; one still holding keeps its Undo for the next open.
  if (ui.sent && records.thoughts.get(ui.sent.id)?.phase !== 'routed') ui.sent = null;
  void call('host.notch', { open: false }).catch(fail);
  redraw();
  ui.timer = window.setTimeout(() => {
    ui.retracting = false;
    ui.seen.clear();
    redraw();
  }, reduceMotion.matches ? 0 : 320);
}

/** A script's focus move never shows the keyboard ring (rebuild plan, Phase 0 findings). */
export function focus(selector: string) {
  const el = document.querySelector<HTMLElement>(selector);
  el?.focus({ preventScroll: true, focusVisible: false });
  return !!el;
}

/** Peek on a session's terminal; the notch folds. */
export function peek(session: string) {
  void call('host.show', { surface: 'peek', at: session }).then(fold, fail);
}
