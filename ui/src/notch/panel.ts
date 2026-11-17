// Opening and folding the notch. The page decides; the host moves the panel and the keyboard.
import { cap, holding } from '../capture.tsx';
import { call, fail, page, redraw, ui, type View } from './model.ts';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

export function reveal(mode: 'hover' | 'pinned', view: View, focus = '') {
  clearTimeout(ui.timer);
  ui.mode = ui.mode === 'pinned' ? 'pinned' : mode;
  ui.view = view;
  ui.retracting = false;
  page.focus = focus;
  page.error = '';
  void call('host.notch', { open: true, height: ui.height }).catch(fail);
  redraw();
}

export function fold() {
  if (ui.mode === 'closed') return;
  clearTimeout(ui.timer);
  Object.assign(ui, { mode: 'closed', retracting: true, replying: false, auto: false });
  cap.choosing = false;
  page.error = '';
  // A receipt whose hold is over is done; one still holding keeps its Undo for the next open.
  if (!holding()) cap.sent = null;
  void call('host.notch', { open: false }).catch(fail);
  redraw();
  ui.timer = window.setTimeout(() => {
    ui.retracting = false;
    ui.seen.clear();
    redraw();
  }, reduceMotion.matches ? 0 : 320);
}

/** The workspace, showing a session's terminal; the notch folds. */
export function peek(session: string) {
  void call('host.show', { surface: 'workspace', at: session }).then(fold, fail);
}
