//! The notification-area icon on Windows (plan, "The notch on Windows"): the anchor that is always there, also
//! while the tab is hidden or switched off. Windows keeps a new icon in the overflow until the person drags it
//! out, so it is not the glance by itself: its picture says what waits, its tooltip the counts, a click opens the
//! sheet, and a right click a small menu the system draws. The picture is Tasktap's mark, the chrome slab the pages
//! show, drawn once from the app's motion engine at the four sizes the notification area asks for at 100, 125, 150
//! and 200 percent, for a dark taskbar and a light one (icons/tray, scripts/mark-pictures.cjs); what waits is a dot
//! beside it.
//!
//! The picture and the tooltip are plain arithmetic, tested on every system; what talks to the shell is below.

/// What waits for the person, as the icon shows it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Waits {
    /// Nothing: the mark alone.
    Nothing,
    /// A result not read yet, or a run that failed: the mark and a dot in the taskbar's own text colour.
    Result,
    /// A question: the mark and a larger dot in the colour of "needs you".
    Question,
}

impl Waits {
    pub fn of(needs_you: u32, done: u32, failed: u32) -> Waits {
        match (needs_you, done + failed) {
            (1.., _) => Waits::Question,
            (0, 1..) => Waits::Result,
            _ => Waits::Nothing,
        }
    }
}

/// The tooltip: the counts, in the words the notch's own label has.
pub fn says(working: u32, needs_you: u32, done: u32, failed: u32) -> String {
    let parts: Vec<String> = [(needs_you, "need you"), (working, "working"), (done, "new"), (failed, "failed")]
        .into_iter()
        .filter(|(n, _)| *n > 0)
        .map(|(n, what)| format!("{n} {what}"))
        .collect();
    format!("Tasktap: {}", if parts.is_empty() { "nothing running".to_owned() } else { parts.join(", ") })
}

/// The dot's colour, as red, green, blue: the pages' `--fg` and `--asks` on a dark taskbar; on a light one ink, and
/// an amber dark enough to read there (5 : 1 on Windows' light taskbar).
fn colour(light: bool, waits: Waits) -> [u8; 3] {
    match (waits == Waits::Question, light) {
        (true, false) => [0xea, 0xb6, 0x76],
        (true, true) => [0x9a, 0x5b, 0x0a],
        (false, false) => [0xf2, 0xf2, 0xf3],
        (false, true) => [0x1a, 0x1a, 0x1c],
    }
}

/// The mark at each size it is drawn at: for a dark taskbar, and for a light one (its face turned from the light, so
/// it reads by its darker face there rather than by its rim).
const MARKS: [(usize, &[u8], &[u8]); 4] = [
    (16, include_bytes!("../icons/tray/dark-16.png"), include_bytes!("../icons/tray/light-16.png")),
    (20, include_bytes!("../icons/tray/dark-20.png"), include_bytes!("../icons/tray/light-20.png")),
    (24, include_bytes!("../icons/tray/dark-24.png"), include_bytes!("../icons/tray/light-24.png")),
    (32, include_bytes!("../icons/tray/dark-32.png"), include_bytes!("../icons/tray/light-32.png")),
];

/// One of the mark's pictures: its points as red, green, blue and alpha (not multiplied), top row first.
fn decoded(file: &[u8], side: usize) -> Vec<u8> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(file));
    decoder.set_transformations(png::Transformations::EXPAND);
    let mut reader = decoder.read_info().expect("the mark's pictures are PNGs made by scripts/mark-pictures.cjs");
    let mut points = vec![0; reader.output_buffer_size().expect("a small picture")];
    let info = reader.next_frame(&mut points).expect("the mark's pictures are whole");
    assert_eq!((info.width as usize, info.height as usize, info.color_type), (side, side, png::ColorType::Rgba));
    points.truncate(info.buffer_size());
    points
}

/// The mark for a taskbar, `size` points square, its colour multiplied by its alpha: the picture drawn at that size
/// where there is one; otherwise the next larger (or the largest) resampled to it, each point the average of sixteen
/// samples read between its points, so a size the notification area asks for between them (28 at 175 percent, 40
/// and 48 above 200) is as even and as large in its square.
fn mark(size: usize, light: bool) -> Vec<[u32; 4]> {
    let (side, dark, pale) = MARKS.iter().find(|(side, ..)| *side >= size).unwrap_or(&MARKS[3]);
    let points: Vec<[u32; 4]> = decoded(if light { pale } else { dark }, *side)
        .chunks(4)
        .map(|p| {
            let a = u32::from(p[3]);
            [u32::from(p[0]) * a / 255, u32::from(p[1]) * a / 255, u32::from(p[2]) * a / 255, a]
        })
        .collect();
    if *side == size {
        return points;
    }
    let (n, k) = (*side as isize, *side as f64 / size as f64);
    let at = |x: isize, y: isize| {
        if (0..n).contains(&x) && (0..n).contains(&y) {
            points[(y * n + x) as usize]
        } else {
            [0; 4]
        }
    };
    let mut out = Vec::with_capacity(size * size);
    for py in 0..size {
        for px in 0..size {
            let mut sum = [0f64; 4];
            for s in 0..16 {
                let (u, v) = (
                    (px as f64 + (f64::from(s % 4) + 0.5) / 4.0) * k - 0.5,
                    (py as f64 + (f64::from(s / 4) + 0.5) / 4.0) * k - 0.5,
                );
                let (x, y) = (u.floor(), v.floor());
                let (fx, fy) = (u - x, v - y);
                for (dx, dy, w) in
                    [(0, 0, (1.0 - fx) * (1.0 - fy)), (1, 0, fx * (1.0 - fy)), (0, 1, (1.0 - fx) * fy), (1, 1, fx * fy)]
                {
                    let p = at(x as isize + dx, y as isize + dy);
                    for c in 0..4 {
                        sum[c] += w * f64::from(p[c]) / 16.0;
                    }
                }
            }
            out.push(sum.map(|c| c.round() as u32));
        }
    }
    out
}

/// The icon's picture: `size` by `size` points of four bytes (blue, green, red, alpha; colour already multiplied by
/// alpha, as Windows wants an icon's), top row first. The mark; and for what waits a dot in the bottom right corner,
/// which the slab leaves free, with a clear ring round it. The dot is drawn on a grid of sixteenths of the icon, each
/// point sampled sixteen times, so it is as even at 20 and 24 pixels as at 16 and 32.
pub fn picture(size: usize, light: bool, waits: Waits) -> Vec<u8> {
    let points = mark(size, light);
    let dot = (waits != Waits::Nothing).then_some((12.75, 12.75, if waits == Waits::Question { 3.0 } else { 2.5 }));
    let [r, g, b] = colour(light, waits);
    let unit = size as f64 / 16.0;
    let mut out = Vec::with_capacity(size * size * 4);
    for py in 0..size {
        for px in 0..size {
            let (mut inked, mut clear) = (0u32, 0u32);
            if let Some((cx, cy, radius)) = dot {
                for sy in 0..4 {
                    for sx in 0..4 {
                        let at = |p: usize, s: usize| (p as f64 + (s as f64 + 0.5) / 4.0) / unit;
                        let far = (at(px, sx) - cx).hypot(at(py, sy) - cy);
                        inked += u32::from(far <= radius);
                        clear += u32::from(far > radius && far <= radius + 1.0);
                    }
                }
            }
            // The mark's own point, less what the dot and its clear ring take of it, and the dot.
            let left = 16 - inked - clear;
            let part = |dot: u8, mark: u32| ((u32::from(dot) * inked + mark * left) / 16).min(255) as u8;
            let [mr, mg, mb, ma] = points[py * size + px];
            out.extend([part(b, mb), part(g, mg), part(r, mr), part(255, ma)]);
        }
    }
    out
}

#[cfg(windows)]
pub use shell::*;

#[cfg(windows)]
mod shell {
    use super::{picture, says, Waits};
    use std::ptr::{null, null_mut};
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Gdi::{CreateBitmap, DeleteObject};
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
    use windows_sys::Win32::UI::Shell::{
        Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_SHOWTIP, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY,
        NIM_SETVERSION, NOTIFYICONDATAW, NOTIFYICON_VERSION_4,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CreateIconIndirect, CreatePopupMenu, DestroyIcon, DestroyMenu, GetSystemMetrics, PostMessageW,
        SetForegroundWindow, TrackPopupMenuEx, HICON, ICONINFO, MF_SEPARATOR, MF_STRING, SM_CXSMICON, SM_CYSCREEN,
        TPM_BOTTOMALIGN, TPM_NONOTIFY, TPM_RETURNCMD, TPM_RIGHTBUTTON, TPM_TOPALIGN, WM_NULL,
    };

    /// The icon's number among this window's icons: it has one.
    pub const ID: u32 = 1;

    struct Tray {
        /// The window the shell tells about the icon; none until `add`.
        window: isize,
        /// The message it tells it with.
        message: u32,
        /// Whether the shell has the icon.
        added: bool,
        counts: [u32; 4],
        icon: isize,
    }
    static TRAY: Mutex<Tray> = Mutex::new(Tray { window: 0, message: 0, added: false, counts: [0; 4], icon: 0 });

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain([0]).collect()
    }

    /// Whether the taskbar is the light one (Windows Settings, Personalisation, Colours, "Choose your mode"); dark
    /// where the system does not say.
    pub fn light_taskbar() -> bool {
        let (mut light, mut size) = (0u32, size_of::<u32>() as u32);
        // SAFETY: both names are NUL-terminated, and `light` is as large as `size` says.
        let read = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                wide(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize").as_ptr(),
                wide("SystemUsesLightTheme").as_ptr(),
                RRF_RT_REG_DWORD,
                null_mut(),
                (&raw mut light).cast(),
                &mut size,
            )
        };
        read == 0 && light != 0
    }

    /// An icon of the picture: colour with its own alpha, and a mask of nothing, which Windows asks for beside it.
    fn icon(size: usize, light: bool, waits: Waits) -> HICON {
        let colour = picture(size, light, waits);
        let mask = vec![0u8; size.div_ceil(16) * 2 * size];
        // SAFETY: both bitmaps are made from buffers of the sizes their formats need, the icon copies them, and
        // they are freed here.
        unsafe {
            let (n, colours) = (size as i32, CreateBitmap(size as i32, size as i32, 1, 32, colour.as_ptr().cast()));
            let masks = CreateBitmap(n, n, 1, 1, mask.as_ptr().cast());
            let info = ICONINFO { fIcon: 1, xHotspot: 0, yHotspot: 0, hbmMask: masks, hbmColor: colours };
            let icon = CreateIconIndirect(&info);
            DeleteObject(colours);
            DeleteObject(masks);
            icon
        }
    }

    /// What the shell is told: the picture for what waits now, at the notification area's size, and the counts.
    fn data(tray: &mut Tray) -> NOTIFYICONDATAW {
        let [working, needs_you, done, failed] = tray.counts;
        let window = tray.window as HWND;
        // SAFETY: the window is this app's own and open; the metric is asked for its display's scale.
        let size = unsafe { GetSystemMetricsForDpi(SM_CXSMICON, GetDpiForWindow(window).max(96)) }.clamp(16, 64);
        let old = std::mem::replace(
            &mut tray.icon,
            icon(size as usize, light_taskbar(), Waits::of(needs_you, done, failed)) as isize,
        );
        if old != 0 {
            // SAFETY: an icon this file made, which the shell has copied.
            unsafe { DestroyIcon(old as HICON) };
        }
        // SAFETY: a structure of numbers and arrays; all zero is "nothing".
        let mut data: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
        data.cbSize = size_of::<NOTIFYICONDATAW>() as u32;
        data.hWnd = window;
        data.uID = ID;
        data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP;
        data.uCallbackMessage = tray.message;
        data.hIcon = tray.icon as HICON;
        for (to, from) in data.szTip.iter_mut().zip(says(working, needs_you, done, failed).encode_utf16().take(127)) {
            *to = from;
        }
        data
    }

    /// Puts the icon into the notification area, telling `window` about it with `message`; again after Explorer
    /// started anew, which forgets every icon. False where there is no notification area (no desktop).
    pub fn add(window: isize, message: u32) -> bool {
        let mut tray = TRAY.lock().unwrap();
        (tray.window, tray.message) = (window, message);
        let mut data = data(&mut tray);
        // SAFETY: `data` is whole and names a window of this app.
        tray.added = unsafe { Shell_NotifyIconW(NIM_ADD, &data) } != 0;
        if tray.added {
            data.Anonymous.uVersion = NOTIFYICON_VERSION_4;
            // SAFETY: as above.
            unsafe { Shell_NotifyIconW(NIM_SETVERSION, &data) };
        }
        tray.added
    }

    /// The counts changed, or the taskbar's colour or the display's scale: the picture and the tooltip follow.
    pub fn set(counts: Option<[u32; 4]>) {
        let mut tray = TRAY.lock().unwrap();
        if let Some(counts) = counts {
            if tray.counts == counts {
                return;
            }
            tray.counts = counts;
        }
        if tray.added {
            let data = data(&mut tray);
            // SAFETY: `data` is whole and names the icon this app added.
            unsafe { Shell_NotifyIconW(NIM_MODIFY, &data) };
        }
    }

    /// Takes the icon away: at quit, or it stays until the pointer passes it.
    pub fn remove() {
        let mut tray = TRAY.lock().unwrap();
        if std::mem::take(&mut tray.added) {
            // SAFETY: a structure of numbers and arrays; the shell reads the window and the number.
            let mut data: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
            data.cbSize = size_of::<NOTIFYICONDATAW>() as u32;
            data.hWnd = tray.window as HWND;
            data.uID = ID;
            // SAFETY: as above.
            unsafe { Shell_NotifyIconW(NIM_DELETE, &data) };
        }
    }

    /// What a check may know of the icon: whether the shell has it, and what it shows.
    pub fn state() -> serde_json::Value {
        let tray = TRAY.lock().unwrap();
        let [working, needs_you, done, failed] = tray.counts;
        serde_json::json!({"added": tray.added, "window": tray.window, "id": ID, "light": light_taskbar(),
            "waits": format!("{:?}", Waits::of(needs_you, done, failed)), "says": says(working, needs_you, done, failed)})
    }

    /// The icon's menu, drawn by the system, at a point of the screen: the number of what was chosen (1 the
    /// workspace, 2 Settings, 3 quit), or 0 when it was closed. It runs a loop of its own until then, so it is
    /// called from the event loop only. `window` is made the one in front for as long as the menu is open, which
    /// is what makes Windows close the menu at a click elsewhere.
    pub fn menu(window: isize, x: i32, y: i32) -> u32 {
        let window = window as HWND;
        // SAFETY: the menu is made, shown and destroyed here; its texts are NUL-terminated and outlive the calls.
        unsafe {
            let menu = CreatePopupMenu();
            if menu.is_null() {
                return 0;
            }
            for (id, text) in [(1usize, "Open Tasktap"), (2, "Settings"), (0, ""), (3, "Quit Tasktap")] {
                match id {
                    0 => AppendMenuW(menu, MF_SEPARATOR, 0, null()),
                    _ => AppendMenuW(menu, MF_STRING, id, wide(text).as_ptr()),
                };
            }
            SetForegroundWindow(window);
            // Up from an icon in the lower half of the screen and down from one in the upper half, as the
            // notification area's own menus open; the system keeps the menu on the screen.
            let up = if y > GetSystemMetrics(SM_CYSCREEN) / 2 { TPM_BOTTOMALIGN } else { TPM_TOPALIGN };
            let chosen =
                TrackPopupMenuEx(menu, TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON | up, x, y, window, null());
            PostMessageW(window, WM_NULL, 0, 0);
            DestroyMenu(menu);
            chosen as u32
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// How many points of a picture are drawn at all, and how many fully.
    fn drawn(picture: &[u8]) -> (usize, usize) {
        let alpha: Vec<u8> = picture.chunks(4).map(|p| p[3]).collect();
        (alpha.iter().filter(|a| **a > 0).count(), alpha.iter().filter(|a| **a == 255).count())
    }

    #[test]
    fn at_each_size_it_is_drawn_at_the_picture_is_the_mark_itself() {
        for (side, dark, pale) in MARKS {
            for light in [false, true] {
                let points = decoded(if light { pale } else { dark }, side);
                let p = picture(side, light, Waits::Nothing);
                assert_eq!(p.len(), side * side * 4);
                // Point for point the picture made from the engine, its colour multiplied by its alpha.
                for (got, want) in p.chunks(4).zip(points.chunks(4)) {
                    let a = u32::from(want[3]);
                    let pre = |c: u8| (u32::from(c) * a / 255) as u8;
                    assert_eq!(got, [pre(want[2]), pre(want[1]), pre(want[0]), want[3]]);
                }
            }
        }
    }

    #[test]
    fn what_waits_is_a_dot_beside_the_mark_and_the_taskbar_chooses_its_colours() {
        let (rest, result, question) = (
            picture(16, false, Waits::Nothing),
            picture(16, false, Waits::Result),
            picture(16, false, Waits::Question),
        );
        assert_ne!(rest, result);
        assert_ne!(rest, question);
        assert_ne!(result, question);
        // The dot is in the bottom right corner, which the slab leaves free.
        let at = |p: &[u8], x: usize, y: usize| -> [u8; 4] { p[(y * 16 + x) * 4..][..4].try_into().unwrap() };
        for (x, y) in [(12, 12), (13, 13), (14, 12), (12, 14)] {
            assert_eq!(at(&rest, x, y)[3], 0, "the slab leaves the corner free at {x},{y}");
        }
        assert_eq!(at(&result, 12, 12), [0xf3, 0xf2, 0xf2, 0xff], "a result's dot, in the pages' text colour");
        assert_eq!(at(&question, 12, 12), [0x76, 0xb6, 0xea, 0xff], "a question's, in the colour of needs you");
        // The mark itself is the same picture whatever waits.
        assert_eq!(at(&rest, 8, 4), at(&question, 8, 4));
        assert!(at(&rest, 8, 4)[3] > 0);
        // On a light taskbar: the mark for it, and the dot in ink.
        let light = picture(16, true, Waits::Result);
        assert_ne!(light, result);
        assert_eq!(at(&light, 12, 12), [0x1c, 0x1a, 0x1a, 0xff]);
    }

    #[test]
    fn the_picture_is_whole_at_every_size_the_notification_area_asks_for() {
        for size in [16, 20, 24, 32, 40, 48] {
            for waits in [Waits::Nothing, Waits::Result, Waits::Question] {
                for light in [false, true] {
                    let p = picture(size, light, waits);
                    assert_eq!(p.len(), size * size * 4);
                    let (some, whole) = drawn(&p);
                    // The slab stands in the middle at every size, and no colour is stronger than its alpha.
                    let share = some as f64 / (size * size) as f64;
                    assert!((0.15..0.6).contains(&share), "{size} {waits:?}: {share}");
                    assert!(whole > 0);
                    assert!(p.chunks(4).all(|p| p[0] <= p[3] && p[1] <= p[3] && p[2] <= p[3]), "{size} {waits:?}");
                    let middle = &p[((size / 2) * size + size / 2) * 4..][..4];
                    assert!(middle[3] > 200, "{size}: the slab crosses the middle");
                }
            }
        }
    }

    #[test]
    fn the_tooltip_says_the_counts_in_the_notch_s_words() {
        assert_eq!(says(0, 0, 0, 0), "Tasktap: nothing running");
        assert_eq!(says(2, 1, 0, 0), "Tasktap: 1 need you, 2 working");
        assert_eq!(says(0, 0, 3, 1), "Tasktap: 3 new, 1 failed");
        assert_eq!(Waits::of(1, 4, 0), Waits::Question);
        assert_eq!(Waits::of(0, 0, 1), Waits::Result);
        assert_eq!(Waits::of(0, 0, 0), Waits::Nothing);
    }
}
