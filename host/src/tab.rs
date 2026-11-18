//! Where the tab sits on a Windows display (plan, "The notch on Windows"). Windows has no camera
//! housing, so every display is the Mac's display without one: the tab hangs from the top edge,
//! centred, and opens into the same sheet. This is only the arithmetic between what Windows says
//! about a display (pixels, origin at the primary display's top-left corner, y downwards) and
//! the notch's own geometry (points, y upwards); the window itself is not built yet.
use crate::geometry::{Geometry, Rect};

/// A display as Windows describes it (`Monitor::position`, `size`, `work_area`, `scale_factor`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Display {
    /// The whole display in pixels: left, top, width, height.
    pub area: [f64; 4],
    /// What the taskbar and docked bars leave free, in pixels.
    pub work: [f64; 4],
    /// Pixels per point: 1.0 at 100 %, 1.5 at 150 %.
    pub scale: f64,
}

const NONE: Rect = Rect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 };

impl Display {
    fn scale(&self) -> f64 {
        self.scale.max(0.25)
    }

    /// How many pixels a taskbar docked at the top takes: the tab hangs below it, never over it.
    fn top_bar(&self) -> f64 {
        (self.work[1] - self.area[1]).clamp(0.0, self.area[3] / 2.0)
    }

    /// The display in the notch's terms: points, origin at its own bottom-left corner, y
    /// upwards, with no cutout. Its top is the display's top edge, or the lower edge of a
    /// taskbar docked there; the room for the open sheet ends where the work area ends.
    pub fn geometry(&self) -> Geometry {
        let s = self.scale();
        let [_, top, w, h] = self.area;
        let frame = Rect { x: 0.0, y: 0.0, w: w / s, h: (h - self.top_bar()) / s };
        let work_bottom = (self.work[1] + self.work[3]).clamp(top, top + h);
        let visible = Rect {
            x: (self.work[0] - self.area[0]) / s,
            y: (top + h - work_bottom) / s,
            w: self.work[2] / s,
            h: self.work[3] / s,
        };
        Geometry::new(frame, visible, 0.0, NONE, NONE, s)
    }

    /// A rectangle of that geometry as Windows places a window: left, top, width and height in
    /// whole pixels of the virtual screen.
    pub fn place(&self, r: Rect) -> [i32; 4] {
        let s = self.scale();
        let [left, top, _, h] = self.area;
        let height = (h - self.top_bar()) / s;
        let x = (left + r.x * s).round();
        let y = (top + self.top_bar() + (height - r.max_y()) * s).round();
        [x as i32, y as i32, (r.w * s).round() as i32, (r.h * s).round() as i32]
    }

    /// Whether a point of the virtual screen, in pixels, is on this display.
    pub fn contains(&self, x: f64, y: f64) -> bool {
        let [left, top, w, h] = self.area;
        x >= left && x < left + w && y >= top && y < top + h
    }
}

/// The display the tab belongs on: the one that holds the point (the pointer, when a shortcut
/// asks for the tab where the person is), else the primary one, which Windows puts at the origin.
pub fn anchor(displays: &[Display], at: Option<(f64, f64)>) -> Option<&Display> {
    at.and_then(|(x, y)| displays.iter().find(|d| d.contains(x, y)))
        .or_else(|| displays.iter().find(|d| d.contains(0.0, 0.0)))
        .or(displays.first())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{BLOOM, FLARE, SHEET};

    fn display(area: [f64; 4], taskbar: f64, scale: f64) -> Display {
        Display { area, work: [area[0], area[1], area[2], area[3] - taskbar], scale }
    }

    #[test]
    fn the_tab_hangs_centred_from_the_top_edge_of_a_full_hd_display() {
        let d = display([0.0, 0.0, 1920.0, 1080.0], 48.0, 1.0);
        let g = d.geometry();
        assert!(!g.cutout);
        assert_eq!(d.place(g.tab), [908, 0, 104, 16]);
        // The sheet may open down to 12 points above the taskbar.
        assert_eq!(g.available(), 1080.0 - 48.0 - 16.0 - 12.0);
    }

    #[test]
    fn a_scaled_display_gets_the_same_tab_in_points_and_more_pixels() {
        // 2560 x 1440 at 150 % is 1706.67 x 960 points: the tab of a smaller display, 120 x 20.
        let d = display([0.0, 0.0, 2560.0, 1440.0], 72.0, 1.5);
        let g = d.geometry();
        assert_eq!((g.tab.w, g.tab.h), (120.0, 20.0));
        assert_eq!(d.place(g.tab), [1190, 0, 180, 30]);
        assert_eq!(g.pixel, 1.0 / 1.5);
    }

    #[test]
    fn a_display_left_of_and_above_the_primary_one_has_negative_coordinates() {
        let d = display([-1920.0, -200.0, 1920.0, 1080.0], 0.0, 1.0);
        let g = d.geometry();
        assert_eq!(d.place(g.tab), [-1920 + 908, -200, 104, 16]);
    }

    #[test]
    fn a_taskbar_docked_at_the_top_pushes_the_tab_below_it() {
        let d = Display { area: [0.0, 0.0, 1920.0, 1080.0], work: [0.0, 48.0, 1920.0, 1032.0], scale: 1.0 };
        let g = d.geometry();
        assert_eq!(d.place(g.tab), [908, 48, 104, 16]);
        assert_eq!(g.available(), 1032.0 - 16.0 - 12.0);
    }

    #[test]
    fn a_taskbar_at_the_side_leaves_the_tab_on_the_display_s_centre() {
        let d = Display { area: [0.0, 0.0, 1920.0, 1080.0], work: [64.0, 0.0, 1856.0, 1080.0], scale: 1.0 };
        assert_eq!(d.place(d.geometry().tab), [908, 0, 104, 16]);
    }

    #[test]
    fn the_collapsed_and_the_open_window_stay_on_their_display() {
        for (area, scale) in [
            ([0.0, 0.0, 1920.0, 1080.0], 1.0),
            ([1920.0, 0.0, 3840.0, 2160.0], 2.0),
            ([0.0, 0.0, 1366.0, 768.0], 1.25),
            ([-1280.0, 56.0, 1280.0, 1024.0], 1.0),
        ] {
            let d = display(area, 48.0, scale);
            let g = d.geometry();
            for frame in [g.panel_frame(true, 0.0), g.panel_frame(false, 260.0), g.panel_frame(false, 5000.0)] {
                let [x, y, w, h] = d.place(frame);
                assert!(x >= area[0] as i32 && x + w <= (area[0] + area[2]) as i32, "{area:?} {frame:?}");
                assert_eq!(y, area[1] as i32, "the window's top is the display's top: {area:?}");
                // The sheet ends above the taskbar; only the room for its light may reach over it.
                let sheet_bottom = y + h - (BLOOM * scale).round() as i32;
                assert!(sheet_bottom <= (area[1] + area[3] - 48.0) as i32, "{area:?} {frame:?}");
            }
            // Open, the window is the sheet with room for its flare and light on both sides.
            let open = d.place(g.panel_frame(false, 260.0));
            assert_eq!(open[2], ((SHEET + 2.0 * (FLARE + BLOOM)) * scale).round() as i32);
            assert_eq!(open[3], ((260.0 + BLOOM) * scale).round() as i32);
        }
    }

    #[test]
    fn the_tab_goes_to_the_display_under_the_pointer_else_to_the_primary_one() {
        let left = display([-1920.0, 0.0, 1920.0, 1080.0], 48.0, 1.0);
        let primary = display([0.0, 0.0, 2560.0, 1440.0], 72.0, 1.5);
        let all = [left, primary];
        assert_eq!(anchor(&all, Some((-10.0, 500.0))), Some(&left));
        assert_eq!(anchor(&all, Some((10.0, 500.0))), Some(&primary));
        assert_eq!(anchor(&all, Some((9000.0, 9000.0))), Some(&primary));
        assert_eq!(anchor(&all, None), Some(&primary));
        assert_eq!(anchor(&[], None), None);
    }
}
