//! The rules both the core and the host apply to what a page asks them to
//! read, show or open (design §12, "What may be read, shown and opened"):
//! which web addresses are this machine's own, and which paths are inside
//! a folder the person opened. Each is stated once, here, and the core
//! enforces it itself wherever it reads: a page is never trusted with it.

use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};

/// What a target that may be a web address is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Web {
    /// Not `http://` or `https://`: a path, or nothing Tasktap opens.
    No,
    /// It begins as an address and is not a whole one.
    Broken,
    /// An address this machine answers itself, on any port: `localhost`,
    /// an IPv4 address in 127.0.0.0/8 or `[::1]`. The only kind a preview
    /// ever loads.
    Local,
    /// Any other address: the browser's, through `host.open`, and never
    /// loaded in a preview.
    Remote,
}

/// The longest web address Tasktap opens, in bytes.
pub const MAX_ADDRESS: usize = 2048;

/// Classifies a web address. Local is decided on the text alone and only
/// for the forms every web view reads as loopback: the name `localhost`
/// exactly, four decimal numbers beginning with 127, and `::1` in
/// brackets as the standard library reads it. Whatever else a web view
/// might take for this machine (`localhost.`, `127.1`, `0x7f.0.0.1`,
/// `0.0.0.0`, a name that resolves to it, an address with a user before
/// an `@`) is remote here, which errs on the side of the browser.
pub fn web(target: &str) -> Web {
    let lower = target.to_ascii_lowercase();
    let rest = (lower.strip_prefix("https://")).or_else(|| lower.strip_prefix("http://"));
    let Some(rest) = rest else {
        return Web::No;
    };
    let whole = target.len() <= MAX_ADDRESS && !rest.is_empty() && !rest.starts_with('/');
    if !whole || target.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Web::Broken;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    // A user before the host: whatever follows the `@`, it is not for a preview.
    if authority.contains('@') {
        return Web::Remote;
    }
    let (host, port) = match authority.strip_prefix('[') {
        Some(bracketed) => match bracketed.split_once(']') {
            Some((host, port)) => (host, port),
            None => return Web::Broken,
        },
        None => match authority.rfind(':') {
            Some(at) => authority.split_at(at),
            None => (authority, ""),
        },
    };
    let port = match port.strip_prefix(':') {
        Some(digits) => digits.parse::<u16>().is_ok_and(|port| port > 0),
        None => port.is_empty(),
    };
    if !port || host.is_empty() {
        return Web::Broken;
    }
    let local = match authority.starts_with('[') {
        true => host.parse().is_ok_and(|ip: Ipv6Addr| ip.is_loopback()),
        false => host == "localhost" || host.parse().is_ok_and(|ip: Ipv4Addr| ip.is_loopback()),
    };
    if local { Web::Local } else { Web::Remote }
}

/// The whole path a target names: itself when it is whole, from `home`
/// when it begins with `~/`, and otherwise from `cwd`, the folder of the
/// terminal that printed it, when that is whole. None when it is not whole
/// and there is no such folder to take it from.
pub fn whole(target: &str, cwd: Option<&str>, home: Option<&Path>) -> Option<PathBuf> {
    let named = match (target.strip_prefix("~/"), home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(target),
    };
    match (named.is_absolute(), cwd.map(Path::new)) {
        (true, _) => Some(named),
        (false, Some(cwd)) if cwd.is_absolute() => Some(cwd.join(named)),
        _ => None,
    }
}

/// A path under the rule of what Tasktap reads, shows and opens on disk:
/// it exists, and with every link on the way to it followed it is inside
/// one of `roots`, the folders the person opened in Tasktap and the copies
/// Tasktap made of them, their own links followed too. The path it really
/// is, or why not in a sentence.
pub fn inside(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, Outside> {
    let found = path.canonicalize().map_err(|_| Outside::Missing)?;
    let mut roots = roots.iter().filter_map(|root| root.canonicalize().ok());
    match roots.any(|root| found.starts_with(root)) {
        true => Ok(found),
        false => Err(Outside::Outside(found)),
    }
}

/// Why a path is not one Tasktap reads, shows or opens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outside {
    /// Nothing is there, or it cannot be reached.
    Missing,
    /// It is there, at this path once its links are followed, and in no
    /// folder the person opened.
    Outside(PathBuf),
}

impl Outside {
    /// The sentence for the person, about `path` as it was asked for.
    pub fn sentence(&self, path: &Path) -> String {
        match self {
            Outside::Missing => format!("{} does not exist", path.display()),
            Outside::Outside(found) => format!(
                "{} is outside the folders you opened in Tasktap",
                found.display()
            ),
        }
    }
}
