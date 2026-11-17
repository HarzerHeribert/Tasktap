//! Port of native/NotchGeometry.swift, from trials/tauri-notch. AppKit global points, origin
//! bottom left. Additions: the glance's wings (the tab widens by `wing` on each side), and room
//! around the shape for the light that leaks past it. The shape itself is the page's
//! (ui/src/notch/shape.ts); the host tests the pointer against the outline the page sends.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn max_x(&self) -> f64 {
        self.x + self.w
    }
    pub fn max_y(&self) -> f64 {
        self.y + self.h
    }
    pub fn mid_x(&self) -> f64 {
        self.x + self.w / 2.0
    }
    fn empty(&self) -> bool {
        self.w <= 0.0 || self.h <= 0.0
    }
    pub fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && px < self.max_x() && py >= self.y && py < self.max_y()
    }
    /// The smallest rectangle holding both.
    pub fn union(&self, o: Rect) -> Rect {
        let (x, y) = (self.x.min(o.x), self.y.min(o.y));
        Rect { x, y, w: self.max_x().max(o.max_x()) - x, h: self.max_y().max(o.max_y()) - y }
    }
}

/// How far the shape may reach past its tab where it meets the top edge: the lean of its sides
/// and the easing where they leave the edge.
pub const FLARE: f64 = 24.0;
/// Transparent room beside and below the shape for its light to fade out in before the window's
/// edge. It never takes the pointer: the panel ignores the mouse outside the outline.
pub const BLOOM: f64 = 40.0;

#[derive(Clone, Copy)]
pub struct Geometry {
    pub screen: Rect,
    pub visible: Rect,
    pub tab: Rect,
    pub pixel: f64,
    /// The tab is the camera housing; otherwise it hangs from a display without one.
    pub cutout: bool,
}

impl Geometry {
    pub fn new(frame: Rect, visible: Rect, safe_top: f64, left: Rect, right: Rect, scale: f64) -> Self {
        let pixel = 1.0 / scale.max(1.0);
        let cutout = !left.empty()
            && !right.empty()
            && safe_top > 0.0
            && safe_top < frame.h
            && left.max_x() >= frame.x
            && right.x <= frame.max_x()
            && left.max_x() < right.x
            && (left.max_y() - frame.max_y()).abs() <= pixel
            && (right.max_y() - frame.max_y()).abs() <= pixel;
        let tab = if cutout {
            let x = (left.max_x() / pixel).floor() * pixel;
            let right_edge = (right.x / pixel).ceil() * pixel;
            let depth = (safe_top / pixel).ceil() * pixel;
            Rect { x, y: frame.max_y() - depth, w: right_edge - x, h: depth }
        } else {
            let large = frame.w >= 1920.0 || frame.w >= 1680.0 && frame.h >= 1000.0;
            let (w, h) = (
                f64::min(if large { 104.0 } else { 120.0 }, frame.w),
                f64::min(if large { 16.0 } else { 20.0 }, frame.h),
            );
            Rect { x: frame.mid_x() - w / 2.0, y: frame.max_y() - h, w, h }
        };
        Geometry { screen: frame, visible, tab, pixel, cutout }
    }

    /// The tab widened by the glance's wings, kept on the screen.
    pub fn widen(mut self, wing: f64) -> Self {
        let w = (self.tab.w + 2.0 * wing).min(self.screen.w);
        self.tab.x = self.tab.mid_x() - w / 2.0;
        self.tab.w = w;
        self
    }

    pub fn compact(&self) -> bool {
        self.screen.w >= 1920.0 || self.screen.w >= 1680.0 && self.screen.h >= 1000.0
    }
    pub fn corner(&self) -> f64 {
        1f64.max(10f64.min((self.tab.h / (4.0 * self.pixel)).round() * self.pixel))
    }
    pub fn available(&self) -> f64 {
        1f64.max(self.tab.y - self.visible.y - 12.0)
    }

    pub fn panel_frame(&self, collapsed: bool, requested_h: f64) -> Rect {
        let content: f64 = if self.compact() { 400.0 } else { 432.0 };
        let shape = if collapsed { self.tab.w } else { content.max(self.tab.w) };
        let width = self.screen.w.min(shape + 2.0 * (FLARE + BLOOM));
        let height =
            BLOOM + if collapsed { self.tab.h } else { self.tab.h.max(requested_h).min(self.tab.h + self.available()) };
        let x = self.screen.x.max((self.screen.max_x() - width).min(self.tab.mid_x() - width / 2.0));
        Rect { x, y: self.tab.max_y() - height, w: width, h: height }
    }
}

/// Whether a point lies inside a closed outline (even-odd), both in the same coordinates.
pub fn inside(outline: &[(f64, f64)], x: f64, y: f64) -> bool {
    let mut inside = false;
    let mut j = outline.len().wrapping_sub(1);
    for (i, &(xi, yi)) in outline.iter().enumerate() {
        let (xj, yj) = outline[j];
        if (yi > y) != (yj > y) && x < xj + (y - yj) * (xi - xj) / (yi - yj) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_outline_takes_the_pointer_and_its_surroundings_do_not() {
        // A tab with leaning sides, as the page sends it: x from the tab's centre, y down.
        let tab = [(-70.0, -4.0), (-70.0, 0.0), (-52.0, 16.0), (52.0, 16.0), (70.0, 0.0), (70.0, -4.0)];
        assert!(inside(&tab, 0.0, 0.0), "the top row at the centre");
        assert!(inside(&tab, -60.0, 4.0), "where a side leans out");
        assert!(!inside(&tab, -60.0, 14.0), "beside the bottom, past the lean");
        assert!(!inside(&tab, 0.0, 20.0), "below it, where its light is");
        assert!(!inside(&[], 0.0, 0.0));
    }

    #[test]
    fn the_window_leaves_room_for_the_light_on_both_kinds_of_display() {
        let screen = Rect { x: 0.0, y: 0.0, w: 2560.0, h: 1440.0 };
        let none = Rect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 };
        let g = Geometry::new(screen, screen, 0.0, none, none, 1.0);
        assert!(!g.cutout);
        let f = g.panel_frame(true, 0.0);
        assert_eq!((f.w, f.h, f.max_y()), (104.0 + 2.0 * (FLARE + BLOOM), 16.0 + BLOOM, 1440.0));
        let laptop = Rect { x: 0.0, y: 0.0, w: 1800.0, h: 1169.0 };
        let left = Rect { x: 0.0, y: 1131.0, w: 790.0, h: 38.0 };
        let right = Rect { x: 1010.0, y: 1131.0, w: 790.0, h: 38.0 };
        let g = Geometry::new(laptop, laptop, 38.0, left, right, 2.0);
        assert!(g.cutout);
        assert_eq!((g.tab.w, g.tab.h), (220.0, 38.0));
        let open = g.panel_frame(false, 300.0);
        assert_eq!((open.w, open.h, open.mid_x()), (400.0 + 2.0 * (FLARE + BLOOM), 300.0 + BLOOM, 900.0));
    }
}
