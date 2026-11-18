//! `host.open`: what a page may have the system open, and nothing else. The rule is here, not in
//! the page, which only passes on what a terminal printed:
//!
//! - a web address, `http` or `https`: in the default browser;
//! - something that exists inside a folder the person opened in Tasktap, or inside a copy of one
//!   that Tasktap made for a run, after every link on the way to it is followed: a file of text
//!   in the default text editor; anything else, any folder, and anything with `reveal`, shown in
//!   Finder.
//!
//! Everything else is refused in a sentence. Nothing is ever run: a file is opened as text or
//! shown, never handed to the application that would launch it.
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq)]
pub enum Target {
    Web(String),
    Text(PathBuf),
    Show(PathBuf),
}

/// What `target` is under the rule above. A path is taken from `cwd` unless it is whole, and
/// from `home` when it begins with `~/`.
pub fn target(
    target: &str,
    cwd: Option<&str>,
    reveal: bool,
    roots: &[PathBuf],
    home: Option<&Path>,
) -> Result<Target, String> {
    let lower = target.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")) {
        let whole = target.len() <= 2048 && !rest.is_empty() && !rest.starts_with('/');
        return match whole && !target.chars().any(|c| c.is_whitespace() || c.is_control()) {
            true => Ok(Target::Web(target.to_owned())),
            false => Err("That is not a web address Tasktap can open".into()),
        };
    }
    if target.is_empty() || target.contains("://") || target.chars().any(char::is_control) {
        return Err("Tasktap opens web addresses and what is in a folder you opened: this is neither".into());
    }
    let named = match (target.strip_prefix("~/"), home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(target),
    };
    let whole = match (named.is_absolute(), cwd.map(Path::new)) {
        (true, _) => named,
        (false, Some(cwd)) if cwd.is_absolute() => cwd.join(named),
        _ => return Err(format!("{target} is not a whole path, and its terminal's folder is not known")),
    };
    let found = whole.canonicalize().map_err(|_| format!("{} does not exist", whole.display()))?;
    let inside = roots.iter().filter_map(|r| r.canonicalize().ok()).any(|r| found.starts_with(r));
    if !inside {
        return Err(format!("{} is outside the folders you opened in Tasktap", found.display()));
    }
    Ok(if reveal || found.is_dir() || !text(&found) { Target::Show(found) } else { Target::Text(found) })
}

/// Whether a file reads as text: its first 8 KiB hold no zero byte and are UTF-8.
fn text(file: &Path) -> bool {
    let mut head = Vec::new();
    let read = std::fs::File::open(file).and_then(|f| f.take(8 << 10).read_to_end(&mut head));
    read.is_ok() && !head.contains(&0) && std::str::from_utf8(&head).map_or_else(|e| e.error_len().is_none(), |_| true)
}

/// The call. With `probe` nothing is opened: the reply is what would be, or nothing. Otherwise the
/// reply is what was opened, and a refusal is the error. `quiet`: a check runs the app, so
/// without an opener of the check's own (`TASKTAP_OPEN`) nothing leaves it.
pub fn open(args: &Value, roots: &[PathBuf], quiet: bool) -> Result<Value, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let (probe, reveal) = (args["probe"].as_bool() == Some(true), args["reveal"].as_bool() == Some(true));
    let found =
        target(args["target"].as_str().unwrap_or_default(), args["cwd"].as_str(), reveal, roots, home.as_deref());
    let found = match (found, probe) {
        (Err(_), true) => return Ok(Value::Null),
        (found, _) => found?,
    };
    let (flag, what) = match &found {
        Target::Web(address) => ("-u", address.clone()),
        Target::Text(path) => ("-t", path.display().to_string()),
        Target::Show(path) => ("-R", path.display().to_string()),
    };
    let opener = std::env::var_os("TASKTAP_OPEN");
    if !probe && (opener.is_some() || !quiet) {
        let mut child = std::process::Command::new(opener.unwrap_or_else(|| "/usr/bin/open".into()))
            .args([flag, &what])
            .spawn()
            .map_err(|e| format!("The system could not open it: {e}"))?;
        std::thread::spawn(move || drop(child.wait()));
    }
    Ok(json!(what))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn folders() -> (PathBuf, PathBuf, PathBuf) {
        let base =
            std::env::temp_dir().join(format!("tasktap-open-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = fs::remove_dir_all(&base);
        let (project, outside) = (base.join("project"), base.join("outside"));
        fs::create_dir_all(project.join("src")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(project.join("src/timer.css"), ".timer { }\n").unwrap();
        fs::write(project.join("logo.png"), [0x89, b'P', b'N', b'G', 0, 0, 0]).unwrap();
        fs::write(outside.join("secret.txt"), "no").unwrap();
        (base, project.canonicalize().unwrap(), outside)
    }

    #[test]
    fn a_web_address_is_http_or_https_and_whole() {
        let web = |t: &str| target(t, None, false, &[], None);
        assert_eq!(web("https://example.com/a?b=1#c"), Ok(Target::Web("https://example.com/a?b=1#c".into())));
        assert_eq!(web("HTTP://example.com"), Ok(Target::Web("HTTP://example.com".into())));
        for no in [
            "https://",
            "https:///etc/passwd",
            "https://exa mple.com",
            "https://example.com/\n",
            "file:///etc/passwd",
            "ftp://example.com",
            "javascript:alert(1)",
            "x-apple.systempreferences://",
            "",
        ] {
            assert!(web(no).is_err(), "{no}");
        }
    }

    #[test]
    fn a_path_must_exist_inside_a_folder_the_person_opened() {
        let (base, project, outside) = folders();
        let roots = [project.clone()];
        let at = |t: &str, cwd: Option<&str>, reveal: bool| target(t, cwd, reveal, &roots, Some(&base));
        let css = project.join("src/timer.css");
        // Whole, from the terminal's folder, from the home folder, and through `..` that stays inside.
        assert_eq!(at(css.to_str().unwrap(), None, false), Ok(Target::Text(css.clone())));
        assert_eq!(at("src/timer.css", project.to_str(), false), Ok(Target::Text(css.clone())));
        assert_eq!(at("./src/../src/timer.css", project.to_str(), false), Ok(Target::Text(css.clone())));
        assert_eq!(at("~/project/src/timer.css", None, false), Ok(Target::Text(css.clone())));
        // Shown in Finder: on request, a folder, and a file that is not text.
        assert_eq!(at("src/timer.css", project.to_str(), true), Ok(Target::Show(css)));
        assert_eq!(at("src", project.to_str(), false), Ok(Target::Show(project.join("src"))));
        assert_eq!(at("logo.png", project.to_str(), false), Ok(Target::Show(project.join("logo.png"))));
        // Refused: what does not exist, what is outside, by name or through `..`, and a path with no folder to start from.
        assert!(at("src/missing.css", project.to_str(), false).unwrap_err().ends_with("does not exist"));
        assert!(at(outside.join("secret.txt").to_str().unwrap(), None, false)
            .unwrap_err()
            .contains("outside the folders"));
        assert!(at("../outside/secret.txt", project.to_str(), false).unwrap_err().contains("outside the folders"));
        assert!(at("/etc/hosts", None, false).is_err());
        assert!(at("src/timer.css", None, false).is_err());
        assert!(at("src/timer.css", Some("project"), false).is_err());
        // A link inside the folder that leads out of it is followed first, and so refused.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.join("secret.txt"), project.join("link.txt")).unwrap();
            assert!(at("link.txt", project.to_str(), false).unwrap_err().contains("outside the folders"));
        }
        // With no folder opened nothing on disk is.
        assert!(target("src/timer.css", project.to_str(), false, &[], None).is_err());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn a_probe_opens_nothing_and_a_refusal_is_said() {
        let (base, project, _) = folders();
        let roots = [project.clone()];
        let ask = |v: Value| open(&v, &roots, true);
        assert_eq!(
            ask(json!({"target": "src/timer.css", "cwd": project, "probe": true})),
            Ok(json!(project.join("src/timer.css")))
        );
        assert_eq!(ask(json!({"target": "src/none.css", "cwd": project, "probe": true})), Ok(Value::Null));
        assert_eq!(ask(json!({"target": "file:///etc/passwd", "probe": true})), Ok(Value::Null));
        assert!(ask(json!({"target": "/etc/passwd"})).is_err());
        let _ = fs::remove_dir_all(base);
    }
}
