//! The one notification Tasktap sends (plan, "Where Tasktap shows itself", rule 6): a question, or a task a model
//! was torn about that waits for the person's key, while a full-screen app or a presentation is in front and nothing
//! of Tasktap's can be seen. The core says that a question opened or a task waits (`host.notify`, design §12); the
//! rule (presence.rs) says whether it is shown; a click on it brings the window forward at that question, or at Home,
//! where the waiting task's decision is. On the Mac the system is asked for permission when the first such question comes,
//! never at start; on Windows it is a notification of the icon in the notification area, which needs no installer.
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::AppHandle;

/// The questions a notification was posted for and not taken back yet.
static POSTED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// `host.notify {question | thought, title, body, session}` from the core: shown where the rule says, and otherwise
/// nothing. A waiting task's notification is named `thought:<id>`; only a question's is taken back by `settle`.
pub fn asked(args: &Value) {
    let id = match (args["question"].as_str(), args["thought"].as_str()) {
        (Some(question), _) => question.to_owned(),
        (None, Some(thought)) => format!("thought:{thought}"),
        (None, None) => return,
    };
    let question = id.as_str();
    let (Some(title), Some(body)) = (args["title"].as_str(), args["body"].as_str()) else {
        return;
    };
    let shown = crate::presence::situation().notifies();
    // A check's run never shows anything on the person's screen and never asks the system for anything: it says
    // what would have been shown.
    let passive = crate::notch::NOTCH.lock().unwrap().passive;
    let posted = shown && !passive && post(question, title, body);
    if posted && !question.starts_with("thought:") {
        POSTED.lock().unwrap().push(question.to_owned());
    }
    crate::log(json!({"event": "notify", "question": question, "title": title, "body": body, "shown": shown,
        "posted": posted}));
}

/// A notification was clicked: the window comes forward at its question, which Home or its terminal shows, or at
/// Home for a waiting task (`thought:<id>`).
pub fn clicked(app: &AppHandle, question: &str) {
    crate::log(json!({"event": "notify", "clicked": question}));
    let at = match question.starts_with("thought:") {
        true => question.to_owned(),
        false => format!("question:{question}"),
    };
    let _ = crate::workspace::show(app, Some(&at));
}

/// The questions open now: a notification of one that no longer waits is taken out of the system's list.
pub fn settle(open: &[String]) {
    let gone: Vec<String> = {
        let mut posted = POSTED.lock().unwrap();
        let gone = posted.iter().filter(|q| !open.contains(q)).cloned().collect();
        posted.retain(|q| open.contains(q));
        gone
    };
    for question in gone {
        take_back(&question);
    }
}

#[cfg(target_os = "macos")]
use mac::{post, take_back};
#[cfg(windows)]
pub use windows::clicked_balloon;
#[cfg(windows)]
use windows::{post, take_back};

#[cfg(target_os = "macos")]
mod mac {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread};
    use objc2_foundation::{NSArray, NSBundle, NSError, NSObject, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest, UNNotificationResponse,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::sync::OnceLock;

    define_class!(
        // Hears the clicks on Tasktap's notifications.
        #[unsafe(super(NSObject))]
        #[name = "TasktapNotices"]
        struct Notices;

        unsafe impl NSObjectProtocol for Notices {}

        unsafe impl UNUserNotificationCenterDelegate for Notices {
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                done: &block2::DynBlock<dyn Fn()>,
            ) {
                let question = response.notification().request().identifier().to_string();
                if let Some(app) = crate::APP.get() {
                    let to = app.clone();
                    let _ = app.run_on_main_thread(move || super::clicked(&to, &question));
                }
                done.call(());
            }
        }
    );

    /// The delegate, made once and kept for as long as the app runs (the centre holds it weakly).
    static DELEGATE: OnceLock<usize> = OnceLock::new();

    /// The system's notification centre, only for an app that is a bundle: elsewhere (a check's bare program) it
    /// would end the app.
    fn center() -> Option<Retained<UNUserNotificationCenter>> {
        let bundle = NSBundle::mainBundle();
        let bundled = bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app");
        if !bundled {
            return None;
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let delegate = *DELEGATE.get_or_init(|| {
            let notices: Retained<Notices> = unsafe { msg_send![Notices::alloc(), init] };
            Retained::into_raw(notices) as usize
        });
        // SAFETY: the delegate lives as long as the app.
        let delegate: &Notices = unsafe { &*(delegate as *const Notices) };
        center.setDelegate(Some(ProtocolObject::from_ref(delegate)));
        Some(center)
    }

    /// Asks for permission the first time (the system asks the person once and remembers the answer), then posts.
    pub fn post(question: &str, title: &str, body: &str) -> bool {
        let Some(center) = center() else { return false };
        let (question, title, body) = (question.to_owned(), title.to_owned(), body.to_owned());
        let granted = RcBlock::new(move |granted: Bool, _: *mut NSError| {
            if !granted.as_bool() {
                crate::log(serde_json::json!({"event": "notify", "allowed": false}));
                return;
            }
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(&title));
            content.setBody(&NSString::from_str(&body));
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &NSString::from_str(&question),
                &content,
                None,
            );
            UNUserNotificationCenter::currentNotificationCenter()
                .addNotificationRequest_withCompletionHandler(&request, None);
        });
        center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert, &granted);
        true
    }

    pub fn take_back(question: &str) {
        if let Some(center) = center() {
            let ids = NSArray::from_retained_slice(&[NSString::from_str(question)]);
            center.removeDeliveredNotificationsWithIdentifiers(&ids);
        }
    }
}

#[cfg(windows)]
mod windows {
    use std::sync::Mutex;
    use windows_sys::Win32::UI::Shell::{Shell_NotifyIconW, NIF_INFO, NIIF_USER, NIM_MODIFY, NOTIFYICONDATAW};

    /// The question the icon's last notification is about: a click on it says only that it was clicked.
    static LAST: Mutex<Option<String>> = Mutex::new(None);

    fn icon() -> Option<NOTIFYICONDATAW> {
        let tray = crate::tray::state();
        if tray["added"] != true {
            return None;
        }
        // SAFETY: a structure of numbers and arrays; all zero is "nothing".
        let mut data: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
        data.cbSize = size_of::<NOTIFYICONDATAW>() as u32;
        data.hWnd = tray["window"].as_i64()? as isize as _;
        data.uID = crate::tray::ID;
        data.uFlags = NIF_INFO;
        Some(data)
    }

    pub fn post(question: &str, title: &str, body: &str) -> bool {
        let Some(mut data) = icon() else { return false };
        data.dwInfoFlags = NIIF_USER;
        for (to, from) in data.szInfoTitle.iter_mut().zip(title.encode_utf16().take(63)) {
            *to = from;
        }
        for (to, from) in data.szInfo.iter_mut().zip(body.encode_utf16().take(255)) {
            *to = from;
        }
        *LAST.lock().unwrap() = Some(question.to_owned());
        // SAFETY: `data` is whole and names the icon this app added.
        unsafe { Shell_NotifyIconW(NIM_MODIFY, &data) != 0 }
    }

    /// An empty notification takes the icon's last one away.
    pub fn take_back(question: &str) {
        let mut last = LAST.lock().unwrap();
        if last.as_deref() != Some(question) {
            return;
        }
        *last = None;
        if let Some(data) = icon() {
            // SAFETY: as above.
            unsafe { Shell_NotifyIconW(NIM_MODIFY, &data) };
        }
    }

    /// The icon's notification was clicked (`NIN_BALLOONUSERCLICK`).
    pub fn clicked_balloon(app: &tauri::AppHandle) {
        if let Some(question) = LAST.lock().unwrap().take() {
            super::clicked(app, &question);
        }
    }
}
