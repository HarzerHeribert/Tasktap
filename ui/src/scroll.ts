// Scrolling without bars. No scroller in either page shows one (parts.css); each says instead, as `data-more`, which
// way there is more ("up", "down", "up down"; "left", "right" for the tabs), and the styles dissolve its content at
// that edge only, so the cue itself says which way one can go. One mechanism for every scroller: they are marked
// after anything is drawn, as they scroll, and when the window is resized.
import { options } from 'preact';

const SCROLLERS = '.room > .home, .tree, .sh-b, .set-pane, .tabs, .cap textarea, .pv-b, .md-t';
function mark(el: Element) {
  const more = [
    el.scrollTop > 1 && 'up', el.scrollTop + el.clientHeight < el.scrollHeight - 1 && 'down',
    el.scrollLeft > 1 && 'left', el.scrollLeft + el.clientWidth < el.scrollWidth - 1 && 'right',
  ].filter(Boolean).join(' ');
  if ((el.getAttribute('data-more') ?? '') !== more) el.setAttribute('data-more', more);
}
let due = false;
function marks() {
  if (due) return;
  due = true;
  queueMicrotask(() => {
    due = false;
    document.querySelectorAll(SCROLLERS).forEach(mark);
  });
}
const drawn = options.diffed;
options.diffed = (v) => (drawn?.(v), marks());
document.addEventListener('scroll', (e) => e.target instanceof Element && e.target.matches(SCROLLERS) && mark(e.target), { capture: true, passive: true });
addEventListener('resize', marks);
