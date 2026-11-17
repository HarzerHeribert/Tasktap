//! Line-for-line port of native/NotchGeometry.swift. AppKit global points, origin bottom left.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect { pub x: f64, pub y: f64, pub w: f64, pub h: f64 }

impl Rect {
    pub fn max_x(&self) -> f64 { self.x + self.w }
    pub fn max_y(&self) -> f64 { self.y + self.h }
    pub fn mid_x(&self) -> f64 { self.x + self.w / 2.0 }
    fn empty(&self) -> bool { self.w <= 0.0 || self.h <= 0.0 }
    pub fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && px < self.max_x() && py >= self.y && py < self.max_y()
    }
    fn inset(&self, dx: f64, dy: f64) -> Rect { Rect { x: self.x + dx, y: self.y + dy, w: self.w - 2.0 * dx, h: self.h - 2.0 * dy } }
    pub fn text(&self) -> String { format!("{:.3},{:.3},{:.3},{:.3}", self.x, self.y, self.w, self.h) }
}

pub const GLOW_MARGIN: f64 = 16.0;
pub const SHOULDER: f64 = 13.0;

pub struct Geometry { pub screen: Rect, pub visible: Rect, pub tab: Rect, pub has_cutout: bool, pub pixel: f64 }

impl Geometry {
    pub fn new(frame: Rect, visible: Rect, safe_top: f64, left: Rect, right: Rect, scale: f64) -> Self {
        let pixel = 1.0 / scale.max(1.0);
        let cutout = !left.empty() && !right.empty() && safe_top > 0.0 && safe_top < frame.h
            && left.max_x() >= frame.x && right.x <= frame.max_x() && left.max_x() < right.x
            && (left.max_y() - frame.max_y()).abs() <= pixel && (right.max_y() - frame.max_y()).abs() <= pixel;
        let tab = if cutout {
            let x = (left.max_x() / pixel).floor() * pixel;
            let right_edge = (right.x / pixel).ceil() * pixel;
            let depth = (safe_top / pixel).ceil() * pixel;
            Rect { x, y: frame.max_y() - depth, w: right_edge - x, h: depth }
        } else {
            let large = frame.w >= 1920.0 || frame.w >= 1680.0 && frame.h >= 1000.0;
            let (w, h) = (f64::min(if large { 104.0 } else { 120.0 }, frame.w), f64::min(if large { 16.0 } else { 20.0 }, frame.h));
            Rect { x: frame.mid_x() - w / 2.0, y: frame.max_y() - h, w, h }
        };
        Geometry { screen: frame, visible, tab, has_cutout: cutout, pixel }
    }
    pub fn compact(&self) -> bool { self.screen.w >= 1920.0 || self.screen.w >= 1680.0 && self.screen.h >= 1000.0 }
    pub fn corner(&self) -> f64 { 1f64.max(10f64.min((self.tab.h / (4.0 * self.pixel)).round() * self.pixel)) }
    pub fn rim_offset(&self) -> f64 { (self.corner() / (3.0 * self.pixel)).ceil() * self.pixel + self.pixel }
    pub fn available(&self) -> f64 { 1f64.max(self.tab.y - self.visible.y - 12.0) }

    pub fn panel_frame(&self, collapsed: bool, requested_h: f64, requested_w: f64) -> Rect {
        let request = if requested_w.is_finite() { requested_w } else { 432.0 };
        let content = if self.compact() { 400f64.max(640f64.min(request - 32.0)) } else { 432f64.max(680f64.min(request)) };
        let width = self.screen.w.min((if collapsed { self.tab.w } else { content.max(self.tab.w) }) + 2.0 * SHOULDER);
        let height = if collapsed { self.tab.h + GLOW_MARGIN } else { self.tab.h.max(requested_h).min(self.tab.h + self.available()) };
        let x = self.screen.x.max((self.screen.max_x() - width).min(self.tab.mid_x() - width / 2.0));
        Rect { x, y: self.tab.max_y() - height, w: width, h: height }
    }

    pub fn contains(&self, px: f64, py: f64, frame: Rect, collapsed: bool) -> bool {
        if !frame.contains(px, py) { return false; }
        if py >= self.tab.y { return true; }
        if collapsed { let o = self.rim_offset(); self.tab.inset(-o, -o).contains(px, py) } else { frame.inset(SHOULDER, 0.0).contains(px, py) }
    }

    /// One comparable line; trials/tauri-notch/tool prints the same line from the Swift original.
    pub fn line(&self, name: &str) -> String {
        format!("{name} tab={} cut={} compact={} corner={:.3} rim={:.3} collapsed={} open={} review={} wide={} tall={}",
            self.tab.text(), self.has_cutout as u8, self.compact() as u8, self.corner(), self.rim_offset(),
            self.panel_frame(true, 200.0, 432.0).text(), self.panel_frame(false, 260.0, 432.0).text(),
            self.panel_frame(false, 540.0, 560.0).text(), self.panel_frame(false, 260.0, 10_000.0).text(),
            self.panel_frame(false, 10_000.0, 432.0).text())
    }
}

/// The synthetic displays from scripts/verify-notch-geometry.swift.
pub fn cases() -> Vec<(String, Geometry)> {
    fn cutout(f: Rect, width: f64, depth: f64, inset: f64, scale: f64) -> Geometry {
        let (x, y) = (f.x + inset, f.max_y() - depth);
        Geometry::new(f, Rect { x: f.x, y: f.y + depth, w: f.w, h: f.h - 2.0 * depth }, depth,
            Rect { x: f.x, y, w: inset, h: depth }, Rect { x: x + width, y, w: f.max_x() - x - width, h: depth }, scale)
    }
    let none = Rect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 };
    let r = |x, y, w, h| Rect { x, y, w, h };
    let mut out = vec![
        ("laptop".into(), cutout(r(0.0, 0.0, 1800.0, 1169.0), 220.0, 38.0, 790.0, 2.0)),
        ("offset".into(), cutout(r(-1512.0, 900.0, 1512.0, 982.0), 180.0, 32.0, 666.0, 2.0)),
        ("asym".into(), cutout(r(1800.0, -600.0, 1440.0, 900.0), 134.3, 29.1, 30.2, 2.0)),
        ("external".into(), Geometry::new(r(1800.0, 350.0, 1920.0, 1080.0), r(1800.0, 400.0, 1920.0, 1006.0), 0.0, none, none, 1.0)),
        ("sidedock".into(), Geometry::new(r(1800.0, 350.0, 1920.0, 1080.0), r(1880.0, 400.0, 1840.0, 1006.0), 0.0, none, none, 1.0)),
    ];
    for (i, f) in [r(0.0, 0.0, 1440.0, 900.0), r(-2560.0, -1440.0, 2560.0, 1440.0), r(0.0, 1080.0, 3840.0, 2160.0)].iter().enumerate() {
        for top in [0.0, 24.0, 38.0] {
            let visible = r(f.x, f.y + 40.0, f.w, f.h - 40.0 - top);
            out.push((format!("plain{i}-{top}"), Geometry::new(*f, visible, 0.0, none, none, 2.0)));
        }
    }
    out
}
