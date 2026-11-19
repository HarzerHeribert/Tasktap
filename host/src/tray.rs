//! The notification-area icon on Windows (plan, "The notch on Windows"): the anchor that is always there, also
//! while the tab is hidden or switched off. Windows keeps a new icon in the overflow until the person drags it
//! out, so it is not the glance by itself: its picture says what waits, its tooltip the counts, a click opens the
//! sheet, and a right click a small menu the system draws. The picture is the app's own state mark, five bars,
//! drawn here at the size the notification area asks for: nothing of the app's icon reads at 16 pixels.
//!
//! The picture and the tooltip are plain arithmetic, tested on every system; what talks to the shell is below.

/// What waits for the person, as the icon shows it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Waits {
    /// Nothing: the wave at rest, in the taskbar's own text colour.
    Nothing,
    /// A result not read yet, or a run that failed: the wave and a dot.
    Result,
    /// A question: the wave risen, in the colour of "needs you".
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

/// The colours, as red, green, blue: the pages' `--fg` and `--asks` on a dark taskbar; on a light one ink, and an
/// amber dark enough to read there (5 : 1 on Windows' light taskbar).
fn colour(light: bool, waits: Waits) -> [u8; 3] {
    match (waits == Waits::Question, light) {
        (true, false) => [0xea, 0xb6, 0x76],
        (true, true) => [0x9a, 0x5b, 0x0a],
        (false, false) => [0xf2, 0xf2, 0xf3],
        (false, true) => [0x1a, 0x1a, 0x1c],
    }
}

/// The icon's picture: `size` by `size` points of four bytes (blue, green, red, alpha; colour already multiplied by
/// alpha, as Windows wants an icon's), top row first. Drawn on a grid of sixteenths of the icon: five bars two wide
/// with one between, centred on the middle line, and for a result a dot in the top right corner with a clear ring
/// round it. Each point is sampled sixteen times, so the picture is as even at 20 and 24 pixels as at 16 and 32.
pub fn picture(size: usize, light: bool, waits: Waits) -> Vec<u8> {
    const BARS: [[f64; 5]; 2] = [[4.0, 8.0, 12.0, 8.0, 4.0], [8.0, 12.0, 14.0, 12.0, 8.0]];
    let heights = BARS[usize::from(waits == Waits::Question)];
    let dot = (waits == Waits::Result).then_some((13.0, 3.0, 2.5));
    let [r, g, b] = colour(light, waits);
    let unit = size as f64 / 16.0;
    let inked = |x: f64, y: f64| {
        if let Some((cx, cy, radius)) = dot {
            let far = (x - cx).hypot(y - cy);
            if far <= radius {
                return true;
            }
            if far <= radius + 1.0 {
                return false;
            }
        }
        // Bar `i` spans x from 1 + 3i to 3 + 3i.
        let i = ((x - 1.0) / 3.0).floor();
        (0.0..5.0).contains(&i) && x - 1.0 - 3.0 * i < 2.0 && (y - 8.0).abs() <= heights[i as usize] / 2.0
    };
    let mut out = Vec::with_capacity(size * size * 4);
    for py in 0..size {
        for px in 0..size {
            let mut hits = 0u32;
            for sy in 0..4 {
                for sx in 0..4 {
                    let at = |p: usize, s: usize| (p as f64 + (s as f64 + 0.5) / 4.0) / unit;
                    hits += u32::from(inked(at(px, sx), at(py, sy)));
                }
            }
            let part = |c: u8| (u32::from(c) * hits / 16) as u8;
            out.extend([part(b), part(g), part(r), (255 * hits / 16) as u8]);
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
    fn at_sixteen_pixels_the_mark_is_five_whole_bars_and_nothing_between() {
        let p = picture(16, false, Waits::Nothing);
        assert_eq!(p.len(), 16 * 16 * 4);
        // Five bars two wide: 4, 8, 12, 8 and 4 high.
        assert_eq!(drawn(&p), (72, 72));
        let at = |x: usize, y: usize| &p[(y * 16 + x) * 4..][..4];
        assert_eq!(at(7, 8), [0xf3, 0xf2, 0xf2, 0xff], "the middle bar, in the pages' text colour");
        assert_eq!(at(9, 8), [0, 0, 0, 0], "between two bars");
        assert_eq!(at(0, 8), [0, 0, 0, 0], "the margin");
        assert_eq!(at(7, 1), [0, 0, 0, 0], "above the tallest bar");
    }

    #[test]
    fn what_waits_changes_the_picture_and_the_taskbar_its_colour() {
        let (rest, result, question) = (
            picture(16, false, Waits::Nothing),
            picture(16, false, Waits::Result),
            picture(16, false, Waits::Question),
        );
        assert_ne!(rest, result);
        assert_ne!(rest, question);
        assert_ne!(result, question);
        // A question's bars are taller, and amber.
        assert_eq!(drawn(&question), (108, 108));
        assert_eq!(&question[(8 * 16 + 7) * 4..][..4], [0x76, 0xb6, 0xea, 0xff]);
        // A result's dot is in the top right corner, with nothing touching it.
        let dot = &result[(3 * 16 + 13) * 4..][..4];
        assert_eq!(dot[3], 255);
        assert_eq!(rest[(6 * 16 + 11) * 4 + 3], 255);
        assert!(result[(6 * 16 + 11) * 4 + 3] < 255, "the bar beside the dot is cut back: a clear ring round the dot");
        // On a light taskbar the same shapes in ink.
        let light = picture(16, true, Waits::Nothing);
        assert_eq!(drawn(&light), drawn(&rest));
        assert_eq!(&light[(8 * 16 + 7) * 4..][..4], [0x1c, 0x1a, 0x1a, 0xff]);
    }

    #[test]
    fn the_picture_is_whole_at_every_size_the_notification_area_asks_for() {
        for size in [16, 20, 24, 32, 40, 48] {
            for waits in [Waits::Nothing, Waits::Result, Waits::Question] {
                let p = picture(size, true, waits);
                assert_eq!(p.len(), size * size * 4);
                let (some, whole) = drawn(&p);
                // About the same share of the icon at every size, and never a colour stronger than its alpha.
                let share = some as f64 / (size * size) as f64;
                assert!((0.25..0.6).contains(&share), "{size} {waits:?}: {share}");
                assert!(whole > 0);
                assert!(p.chunks(4).all(|p| p[0] <= p[3] && p[1] <= p[3] && p[2] <= p[3]), "{size} {waits:?}");
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
