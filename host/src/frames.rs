//! What a preview's frame is held to (design §12, "What may be read, shown and opened"). What an agent wrote or
//! serves is not the app's: it is shown in a frame of the workspace page that the host gives nothing of the app, and
//! the three rules here are the host's, whatever the page does:
//!
//! - **What a frame is.** A local web address, loaded as it is; or a file inside a folder the person opened (a page, a
//!   PDF), served by this module to that frame alone from an address of this machine. Either way the frame's origin
//!   is `http://…`, never the app's own, and Tauri refuses every command from an origin that is not the app's: a
//!   frame has no bridge, no `host.*` and no core connection. (A scheme of the app's own would have been less code
//!   than a server, and Tauri counts every scheme an app registers as the app's own origin.)
//! - **What it may load.** Nothing but this machine's own addresses: a content rule list on the web view blocks every
//!   other `http`, `https`, `ws` and `wss` load, of any kind, in any frame, before it leaves the Mac (`RULES`).
//! - **Where it may go.** `allowed` is the web view's navigation policy: the app's own pages and local addresses, in
//!   any frame; anything else is stopped, and an address of the web is offered to the person, who may open it in the
//!   browser. A window a frame asks for is never opened. A top frame that turns up anywhere but on the app's own
//!   pages is sent back to them (`workspace.rs`).
//!
//! On Windows the web view is WebView2, which has no rule list, and the same three are held by its own means
//! (`windows.rs`, `confine`; `BROWSER`): it asks the host about every request before it is sent and about every
//! frame's navigation, and its browser is started resolving nothing but this machine. Two things differ there and
//! are said where they are: WebView2 runs the app's start-up scripts in every frame, so a frame has the app's own
//! object and call, and the whole of the first rule is Tauri's refusal of a command from an origin that is not the
//! app's (the check tries the call itself); and a frame never goes to one of the app's own pages, which there would
//! be the app a second time (`goes`).
//!
//! The server reads nothing the rule of `rules.rs` does not let `host.open` open: a file that exists, inside a folder
//! the person opened or a copy Tasktap made of one, every link on the way followed. It answers `GET` for a path under
//! a token made anew at each start, on the loopback interface only, and nothing runs while nothing asks.
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use tasktap_proto::{inside, web, Outside, Web};

/// The content rule list (WebKit's format): every load over the network is blocked, then those to this machine's
/// own addresses are let through again. Its expressions have no alternation, so each form is a rule of its own;
/// they read the address as the web view has made it canonical, so a port is digits and a path follows. Every kind
/// of load but a document's: where a frame goes is `allowed`'s to say, which WebKit would not ask about an address
/// this list had already blocked, and then the person could not be offered it.
#[cfg_attr(windows, allow(dead_code))]
pub const RULES: &str = r#"[
{"trigger":{"url-filter":"^https?://","resource-type":["image","style-sheet","script","font","raw","svg-document","media","popup","ping","fetch","websocket","other"]},"action":{"type":"block"}},
{"trigger":{"url-filter":"^wss?://"},"action":{"type":"block"}},
{"trigger":{"url-filter":"^[a-z]+://localhost(:[0-9]+)?[/?#]"},"action":{"type":"ignore-previous-rules"}},
{"trigger":{"url-filter":"^[a-z]+://127\\.[0-9]+\\.[0-9]+\\.[0-9]+(:[0-9]+)?[/?#]"},"action":{"type":"ignore-previous-rules"}},
{"trigger":{"url-filter":"^[a-z]+://\\[::1\\](:[0-9]+)?[/?#]"},"action":{"type":"ignore-previous-rules"}}
]"#;

/// What WebView2's browser is started with (Windows). Its first three words are what Tauri would have given it;
/// the rule after them is the wall under everything else here: the browser resolves no name and no address but
/// this machine's own three, so nothing it is asked to load, by any means, leaves the machine. It is what stops a
/// socket (`ws`, `wss`), which WebView2 does not ask the host about as it asks about every other load; it also
/// stops whatever a browser does on its own account. A preview at a loopback address other than these three
/// (`127.0.0.2`) therefore stays empty on Windows.
#[cfg_attr(not(windows), allow(dead_code))]
pub const BROWSER: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
    --autoplay-policy=no-user-gesture-required \
    --host-resolver-rules=\"MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]\"";

/// Whether the web view may go to `url`, in any frame: the app's own pages (`tauri://` on a Mac,
/// `http://tauri.localhost` on Windows), an empty frame, and this machine's own web addresses.
pub fn allowed(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let own = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]
        .iter()
        .any(|app| lower.strip_prefix(app).is_some_and(|rest| rest.is_empty() || rest.starts_with(['/', '?', '#'])));
    own || lower == "about:blank" || lower == "about:srcdoc" || web(url) == Web::Local
}

/// Whether `url` is one of the app's own pages: the only place a top frame may be.
pub fn own(url: &str) -> bool {
    allowed(url) && web(url) != Web::Local && !url.starts_with("about:")
}

/// Whether a frame inside the page may go to `url`, where the web view asks about a frame apart from the top one
/// (WebView2): this machine's own web addresses and an empty frame. Not the app's own pages: WebView2 runs the
/// app's start-up scripts in every frame, so one of the app's pages inside a frame would be the app a second time.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn goes(url: &str) -> bool {
    allowed(url) && !own(url)
}

/// Whether the web view may load `url`, as anything, in any frame: what `RULES` says to WebKit, for a web view that
/// asks the host about each request instead (WebView2). Every `http`, `https`, `ws` and `wss` load is refused but
/// those to this machine's own addresses and to the two names the app's own pages and calls have on Windows.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn loads(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let address = match lower.split_once("://") {
        Some(("http" | "https", _)) => lower.clone(),
        Some(("ws", rest)) => format!("http://{rest}"),
        Some(("wss", rest)) => format!("https://{rest}"),
        _ => return true,
    };
    let app = ["http://tauri.localhost", "https://tauri.localhost", "http://ipc.localhost", "https://ipc.localhost"]
        .iter()
        .any(|own| address.strip_prefix(own).is_some_and(|rest| rest.is_empty() || rest.starts_with(['/', '?', '#'])));
    app || web(&address) == Web::Local
}

/// Whether anything answers at a local web address now: one attempt to connect, to this machine only, so a
/// preview can say that its server is not up yet instead of showing an empty frame. Anything the rule does not
/// call local is not asked.
pub fn listens(address: &str) -> bool {
    use std::net::ToSocketAddrs;
    if web(address) != Web::Local {
        return false;
    }
    let lower = address.to_ascii_lowercase();
    let (secure, rest) = match lower.strip_prefix("https://") {
        Some(rest) => (true, rest),
        None => (false, lower.strip_prefix("http://").unwrap_or_default()),
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) if !port.ends_with(']') => (host, port.parse().unwrap_or(0)),
        _ => (authority, if secure { 443 } else { 80 }),
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    (host, port)
        .to_socket_addrs()
        .is_ok_and(|mut all| all.any(|at| TcpStream::connect_timeout(&at, Duration::from_millis(250)).is_ok()))
}

/// The largest file a frame is given, the core's bound for a picture or a PDF (`MAX_FILE`).
const MAX_FILE: u64 = 16 << 20;

/// What a file is served as. Only what a frame draws or a page loads has a type; anything else is bytes.
fn kind(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "woff2" => "font/woff2",
        "txt" | "md" | "csv" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// The path a request names: what follows the token, with its escapes undone. None for anything else.
fn asked(head: &str, token: &str) -> Option<PathBuf> {
    let mut words = head.lines().next()?.split(' ');
    let (method, target) = (words.next()?, words.next()?);
    let rest = target.strip_prefix('/')?.strip_prefix(token)?;
    let path = rest.split(['?', '#']).next()?;
    if method != "GET" || !path.starts_with('/') {
        return None;
    }
    let mut bytes = Vec::with_capacity(path.len());
    let mut raw = path.bytes();
    while let Some(b) = raw.next() {
        match b {
            b'%' => {
                let hex = [raw.next()?, raw.next()?];
                bytes.push(u8::from_str_radix(std::str::from_utf8(&hex).ok()?, 16).ok()?);
            }
            _ => bytes.push(b),
        }
    }
    let path = String::from_utf8(bytes).ok()?;
    (!path.contains('\0')).then(|| PathBuf::from(drive(&path)))
}

/// A whole path as an address has it, as this system reads one. On Windows a path begins with a drive, and the
/// address has a slash before it and slashes throughout (`/C:/Users/…`, as the page writes it: preview.tsx), so that
/// what a page names beside itself is asked for beside it; the slash before the drive goes. Anywhere else, and for a
/// path without a drive, the path is as it was asked.
fn drive(path: &str) -> &str {
    match path.as_bytes() {
        [b'/', letter, b':', b'/', ..] if cfg!(windows) && letter.is_ascii_alphabetic() => &path[1..],
        _ => path,
    }
}

/// The answer to a request: the status line's end, the type, and the body. A file is read only when the request is
/// for this server at its own address under its token, and the rule lets it be shown.
fn answer(head: &str, token: &str, host: &str, roots: &[PathBuf]) -> (&'static str, &'static str, Vec<u8>) {
    let no = |status, why: String| (status, "text/plain; charset=utf-8", why.into_bytes());
    // A page elsewhere that learnt the port cannot reach this by a name of its own: the request must be for this address.
    let named = head.lines().skip(1).any(|line| {
        line.split_once(':').is_some_and(|(k, v)| k.eq_ignore_ascii_case("host") && v.trim().eq_ignore_ascii_case(host))
    });
    let Some(path) = asked(head, token).filter(|_| named) else {
        return no("404 Not Found", "Nothing is here".into());
    };
    let found = match inside(&path, roots) {
        Ok(found) => found,
        Err(why @ Outside::Missing) => return no("404 Not Found", why.sentence(&path)),
        Err(why) => return no("403 Forbidden", why.sentence(&path)),
    };
    match std::fs::metadata(&found) {
        Ok(file) if file.is_file() && file.len() <= MAX_FILE => match std::fs::read(&found) {
            // A PDF is one by its first bytes, as the core decides it, whatever it is called: the frame a PDF is
            // shown in has no sandbox (WebKit draws none in one), so it must never be handed a page instead.
            Ok(bytes) if bytes.starts_with(b"%PDF-") => ("200 OK", "application/pdf", bytes),
            Ok(bytes) => ("200 OK", kind(&found), bytes),
            Err(e) => no("404 Not Found", format!("{} could not be read: {e}", found.display())),
        },
        Ok(file) if file.is_file() => no("413 Content Too Large", format!("{} is too large to show", found.display())),
        _ => no("404 Not Found", format!("{} is not a file", found.display())),
    }
}

/// One request on a connection, then the connection ends. A page it serves may load its own sibling files and
/// nothing else (the policy in the reply), may be loaded by no page of another origin, and says to no one where it
/// came from.
fn serve(mut stream: TcpStream, token: &str, host: &str, roots: &[PathBuf]) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut head = Vec::new();
    let mut buf = [0u8; 2048];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") && head.len() < (16 << 10) {
        match stream.read(&mut buf) {
            Ok(n @ 1..) => head.extend_from_slice(&buf[..n]),
            _ => return,
        }
    }
    let (status, kind, body) = answer(&String::from_utf8_lossy(&head), token, host, roots);
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\
         X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nCross-Origin-Resource-Policy: same-origin\r\n\
         Content-Security-Policy: default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; base-uri 'self'; form-action 'self'\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(&body));
}

/// Where frames load files from: `http://127.0.0.1:<port>/<token>`, to which a file's whole path is added. The server
/// starts when the first frame needs it. `roots` says, at each request, which folders the person has opened.
pub fn base(roots: impl Fn() -> Vec<PathBuf> + Send + 'static) -> Result<String, String> {
    static BASE: OnceLock<Result<String, String>> = OnceLock::new();
    BASE.get_or_init(|| {
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("Previews of pages cannot start: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        // Two words of the system's randomness: the standard library seeds every hasher's keys from it.
        let word = || std::collections::hash_map::RandomState::new().build_hasher().finish();
        let (token, host) = (format!("{:016x}{:016x}", word(), word()), format!("127.0.0.1:{port}"));
        let base = format!("http://{host}/{token}");
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (token, host, roots) = (token.clone(), host.clone(), roots());
                std::thread::spawn(move || serve(stream, &token, &host, &roots));
            }
        });
        Ok(base)
    })
    .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::fs;

    #[test]
    fn a_frame_goes_to_the_apps_pages_and_to_this_machine_and_nowhere_else() {
        for yes in [
            "tauri://localhost/workspace.html",
            "tauri://localhost/workspace.html?focus=1",
            "http://tauri.localhost/workspace.html",
            "about:blank",
            "about:srcdoc",
            "http://localhost:5173/",
            "http://127.0.0.1:8000/a/report.html?x=1#top",
            "http://[::1]:3000/",
        ] {
            assert!(allowed(yes), "{yes}");
        }
        for no in [
            "https://example.com/",
            "http://localhost.example.com/",
            "http://localhost@example.com/",
            "http://0.0.0.0:8000/",
            "http://192.168.1.10:3000/",
            "tauri://localhost.example.com/",
            "tauri://elsewhere/workspace.html",
            "http://tauri.localhost.example.com/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>1</script>",
            "blob:tauri://localhost/1",
            "x-apple.systempreferences:",
            "mailto:someone@example.com",
            "ipc://localhost/bridge_host",
            "",
        ] {
            assert!(!allowed(no), "{no}");
        }
        // A top frame belongs on the app's own pages only: a local address is a frame's.
        assert!(own("tauri://localhost/workspace.html") && own("http://tauri.localhost/notch.html"));
        assert!(!own("http://localhost:5173/") && !own("about:blank") && !own("https://example.com/"));
    }

    /// Where WebView2 asks about a frame and about each load: a frame goes to this machine and never to the app's
    /// own pages; a load is refused when it would leave this machine, whatever it is a load of.
    #[test]
    fn a_frame_asked_about_apart_goes_to_this_machine_only_and_no_load_leaves_it() {
        for yes in [
            "http://localhost:5173/",
            "http://127.0.0.1:8000/a.html",
            "http://[::1]:3000/",
            "about:blank",
            "about:srcdoc",
        ] {
            assert!(goes(yes), "{yes}");
        }
        for no in [
            "http://tauri.localhost/workspace.html",
            "tauri://localhost/workspace.html",
            "https://example.com/",
            "http://localhost./",
            "",
        ] {
            assert!(!goes(no), "{no}");
        }
        for yes in [
            "http://tauri.localhost/assets/a.js",
            "http://ipc.localhost/bridge_host",
            "http://127.0.0.1:8000/x.png",
            "ws://localhost:5173/hmr",
            "wss://[::1]:3000/",
            "data:image/png;base64,AA==",
            "blob:http://127.0.0.1:8000/1",
            "about:blank",
        ] {
            assert!(loads(yes), "{yes}");
        }
        for no in [
            "https://example.com/a.png",
            "http://localhost.:8000/leak",
            "http://0.0.0.0:8000/leak",
            "ws://example.com/socket",
            "WSS://example.com/socket",
            "http://tauri.localhost.example.com/",
            "http://ipc.localhost@example.com/",
            "http://192.168.1.10/",
        ] {
            assert!(!loads(no), "{no}");
        }
    }

    /// The table the core and the pages share: what it calls local is where a frame may go, and nothing else is.
    #[test]
    fn the_policy_agrees_with_the_shared_table_of_addresses() {
        let table: Vec<(String, String)> =
            serde_json::from_str(include_str!("../../core/proto/tests/addresses.json")).unwrap();
        assert!(table.len() > 40);
        // (An empty frame, which is no web address, is the one thing the policy lets through besides.)
        for (address, kind) in table.into_iter().filter(|(address, _)| !address.starts_with("about:")) {
            assert_eq!(allowed(&address), kind == "local", "{address} is {kind}");
        }
    }

    #[test]
    fn a_local_address_is_asked_whether_anything_answers_and_no_other_is_asked_at_all() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(listens(&format!("http://127.0.0.1:{port}/rehearsal?x=1")));
        assert!(listens(&format!("http://localhost:{port}")));
        // A port nothing listens on, and that stays so while it is asked: the one a connection of this test leaves
        // from, which the system gives to nobody else meanwhile. The port a listener has just let go of is no such
        // port: the system hands it to the next that asks for any, and on a busy machine another test or program was
        // listening there before the look (72 of 312 runs, beside processes that bind ports).
        let held = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let quiet = held.local_addr().unwrap().port();
        assert!(!listens(&format!("http://127.0.0.1:{quiet}/")));
        assert!(!listens(&format!("http://[::1]:{quiet}/")));
        drop((held, listener));
        for remote in ["https://example.com/", "http://192.168.1.10:80/", "http://localhost.:80/", "not an address"] {
            assert!(!listens(remote), "{remote}");
        }
    }

    #[cfg(unix)]
    fn get(base: &str, path: &str, host: Option<&str>) -> String {
        let (address, token) = base.strip_prefix("http://").unwrap().split_once('/').unwrap();
        let mut stream = TcpStream::connect(address).unwrap();
        let host = host.unwrap_or(address);
        write!(stream, "GET /{token}{path} HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
        let mut reply = String::new();
        let _ = stream.read_to_string(&mut reply);
        reply
    }

    // (On a Mac, where frames are given: a path on Windows has no place in an address yet.)
    #[cfg(unix)]
    #[test]
    fn the_server_gives_a_frame_what_is_inside_an_opened_folder_and_nothing_else() {
        let dir = std::env::temp_dir().join(format!("tasktap-frames-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (project, outside) = (dir.join("my project"), dir.join("outside"));
        fs::create_dir_all(project.join("assets")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(project.join("report.html"), "<p>report</p>").unwrap();
        fs::write(project.join("assets/chart.svg"), "<svg/>").unwrap();
        fs::write(project.join("paper.html"), "%PDF-1.4 <script>1</script>").unwrap();
        fs::write(project.join("page.pdf"), "<script>1</script>").unwrap();
        fs::write(outside.join("secret.txt"), "the secret").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), project.join("link.txt")).unwrap();
        let project = project.canonicalize().unwrap();
        let roots = vec![project.clone()];
        let base = base(move || roots.clone()).unwrap();
        let at = |file: &str| format!("{}/{file}", project.display()).replace(' ', "%20");

        // A page, and a file beside it, each as what it is, with the policy that keeps it to its own files.
        let page = get(&base, &at("report.html"), None);
        assert!(page.starts_with("HTTP/1.1 200 OK\r\n") && page.ends_with("<p>report</p>"), "{page}");
        assert!(page.contains("Content-Type: text/html") && page.contains("default-src 'self'"), "{page}");
        assert!(
            page.contains("Cross-Origin-Resource-Policy: same-origin") && page.contains("Referrer-Policy: no-referrer")
        );
        assert!(get(&base, &at("assets/chart.svg"), None).contains("Content-Type: image/svg+xml"));
        // A PDF by its first bytes is served as one whatever its name says, and a page named as a PDF is never a page.
        assert!(get(&base, &at("paper.html"), None).contains("Content-Type: application/pdf\r\n"));
        let named = get(&base, &at("page.pdf"), None);
        assert!(
            named.contains("Content-Type: application/pdf\r\n") && named.contains("X-Content-Type-Options: nosniff")
        );
        // Refused: what is outside by name, by `..` and through a link; what is not there; a folder.
        let secret = format!("{}/secret.txt", outside.display());
        for (path, status) in [
            (secret.as_str(), "403"),
            (at("../outside/secret.txt").as_str(), "403"),
            (at("link.txt").as_str(), "403"),
            ("/etc/passwd", "403"),
            (at("missing.html").as_str(), "404"),
            (at("assets").as_str(), "404"),
        ] {
            let reply = get(&base, path, None);
            assert!(
                reply.starts_with(&format!("HTTP/1.1 {status} ")) && !reply.contains("the secret"),
                "{path}: {reply}"
            );
        }
        // Refused whatever is asked for: another token, no token, a request for another name, another method.
        let (address, token) = base.strip_prefix("http://").unwrap().split_once('/').unwrap();
        let wrong = format!("http://{address}/{}", "0".repeat(token.len()));
        assert!(get(&wrong, &at("report.html"), None).starts_with("HTTP/1.1 404 "));
        assert!(get(&format!("http://{address}/"), &at("report.html"), None).starts_with("HTTP/1.1 404 "));
        assert!(get(&base, &at("report.html"), Some("example.com")).starts_with("HTTP/1.1 404 "));
        let mut stream = TcpStream::connect(address).unwrap();
        write!(stream, "POST /{token}{} HTTP/1.1\r\nHost: {address}\r\n\r\n", at("report.html")).unwrap();
        let mut reply = String::new();
        let _ = stream.read_to_string(&mut reply);
        assert!(reply.starts_with("HTTP/1.1 404 "), "{reply}");
        // The token is this run's own, and long enough not to be guessed.
        assert_eq!(token.len(), 32);
        let _ = fs::remove_dir_all(dir);
    }
}
