//! Port of native/NotchGeometry.swift, from trials/tauri-notch. AppKit global points, origin
//! bottom left. The one addition is the glance's wings: the tab widens by `wing` on each side.

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
    fn inset(&self, dx: f64, dy: f64) -> Rect {
        Rect { x: self.x + dx, y: self.y + dy, w: self.w - 2.0 * dx, h: self.h - 2.0 * dy }
    }
}

pub const GLOW_MARGIN: f64 = 16.0;
pub const SHOULDER: f64 = 13.0;

pub struct Geometry {
    pub screen: Rect,
    pub visible: Rect,
    pub tab: Rect,
    pub pixel: f64,
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
        Geometry { screen: frame, visible, tab, pixel }
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
    pub fn rim_offset(&self) -> f64 {
        (self.corner() / (3.0 * self.pixel)).ceil() * self.pixel + self.pixel
    }
    pub fn available(&self) -> f64 {
        1f64.max(self.tab.y - self.visible.y - 12.0)
    }

    pub fn panel_frame(&self, collapsed: bool, requested_h: f64) -> Rect {
        let content: f64 = if self.compact() { 400.0 } else { 432.0 };
        let width = self.screen.w.min((if collapsed { self.tab.w } else { content.max(self.tab.w) }) + 2.0 * SHOULDER);
        let height = if collapsed {
            self.tab.h + GLOW_MARGIN
        } else {
            self.tab.h.max(requested_h).min(self.tab.h + self.available())
        };
        let x = self.screen.x.max((self.screen.max_x() - width).min(self.tab.mid_x() - width / 2.0));
        Rect { x, y: self.tab.max_y() - height, w: width, h: height }
    }

    pub fn contains(&self, px: f64, py: f64, frame: Rect, collapsed: bool) -> bool {
        if !frame.contains(px, py) {
            return false;
        }
        if py >= self.tab.y {
            return true;
        }
        if collapsed {
            let o = self.rim_offset();
            self.tab.inset(-o, -o).contains(px, py)
        } else {
            frame.inset(SHOULDER, 0.0).contains(px, py)
        }
    }
}
