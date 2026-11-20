//! Files for previews (design §9, "Previews"): what `file.read` reads, and
//! the file a `preview.open` names. Everything here runs on a thread of
//! its own, since the file system may block; the rule of what may be read
//! is the protocol crate's (`inside`), which the host applies to what it
//! opens, and it is applied here to every path, whatever the page says.

use std::fs::{File, Metadata};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use tasktap_proto::{
    Code, Encoding, Error, FileKind, MAX_FILE, MAX_FILE_TEXT, Outside, inside, whole,
};

/// Bytes of a file its kind is decided from.
const HEAD: usize = 8 << 10;

/// What a file is. Its first bytes say so for the pictures and PDF,
/// whatever it is called. Otherwise it is text when its first 8 KiB hold
/// no zero byte and are UTF-8, or begin with a UTF-16 byte order mark, and
/// then its name says which text: a page, Markdown, a drawing, or plain.
/// Everything else is `other`.
pub fn kind(head: &[u8], name: &str) -> (FileKind, Option<Encoding>) {
    use FileKind as K;
    let magic: [(&[u8], K); 5] = [
        (b"\x89PNG\r\n\x1a\n", K::Png),
        (b"\xff\xd8\xff", K::Jpeg),
        (b"GIF87a", K::Gif),
        (b"GIF89a", K::Gif),
        (b"%PDF-", K::Pdf),
    ];
    if let Some((_, kind)) = magic.iter().find(|(magic, _)| head.starts_with(magic)) {
        return (*kind, None);
    }
    if head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WEBP") {
        return (K::Webp, None);
    }
    // A character cut off where the 8 KiB end is still text.
    let utf8 = || std::str::from_utf8(head).map_or_else(|e| e.error_len().is_none(), |_| true);
    let encoding = if head.starts_with(&[0xff, 0xfe]) {
        Encoding::Utf16le
    } else if head.starts_with(&[0xfe, 0xff]) {
        Encoding::Utf16be
    } else if !head.contains(&0) && utf8() {
        Encoding::Utf8
    } else {
        return (K::Other, None);
    };
    let extension = Path::new(name).extension().and_then(|e| e.to_str());
    let kind = match extension.map(str::to_ascii_lowercase).as_deref() {
        Some("html" | "htm") => K::Html,
        Some("md" | "markdown") => K::Markdown,
        Some("svg") => K::Svg,
        _ => K::Text,
    };
    (kind, Some(encoding))
}

/// What `file.read` found.
pub struct Found {
    /// The bytes to stream; none when the file still has the stamp the
    /// caller named, or is of a kind no preview shows.
    pub bytes: Option<Vec<u8>>,
    pub size: u64,
    pub kind: FileKind,
    pub encoding: Option<Encoding>,
    pub cut: bool,
    pub stamp: String,
}

fn refused(code: Code, why: String) -> Error {
    Error::new(code, why)
}

/// Why a path is not one to read, as a call's error: what is not there is
/// `gone`, what is outside the person's folders `denied`.
fn outside(why: Outside, asked: &Path) -> Error {
    let code = match why {
        Outside::Missing => Code::Gone,
        Outside::Outside(_) => Code::Denied,
    };
    refused(code, why.sentence(asked))
}

/// Changes whenever the file does: when it was last written, and its size.
fn stamp(meta: &Metadata) -> String {
    let written = meta.modified().ok();
    let written = written.and_then(|at| at.duration_since(UNIX_EPOCH).ok());
    format!("{:x}-{:x}", written.map_or(0, |d| d.as_nanos()), meta.len())
}

/// Reads a file for `file.read`: the whole of it into memory, so that what
/// is streamed is the file as it was at one moment, whatever happens to it
/// while a slow client takes it. Text beyond [`MAX_FILE_TEXT`] is cut
/// between two characters; anything else beyond [`MAX_FILE`] is refused.
pub fn read(path: &str, roots: &[PathBuf], unless: Option<&str>) -> Result<Found, Error> {
    let asked = Path::new(path);
    if !asked.is_absolute() {
        let why = format!("{path} is not a whole path");
        return Err(refused(Code::Invalid, why));
    }
    let found = inside(asked, roots).map_err(|why| outside(why, asked))?;
    let failed = |e: io::Error| {
        let why = format!("{} could not be read: {e}", found.display());
        refused(Code::Failed, why)
    };
    let no_file = || {
        let why = format!("{} is not a file: a preview shows files", found.display());
        refused(Code::Invalid, why)
    };
    // A folder is no file, and neither is a pipe or a device, which would
    // be waited on for as long as nobody writes to it: looked at before
    // it is opened, and again once it is.
    if !std::fs::metadata(&found).map_err(failed)?.is_file() {
        return Err(no_file());
    }
    let mut file = File::open(&found).map_err(failed)?;
    let meta = file.metadata().map_err(failed)?;
    if !meta.is_file() {
        return Err(no_file());
    }
    let (size, stamp) = (meta.len(), stamp(&meta));
    let mut bytes = Vec::new();
    let head = (&mut file).take(HEAD as u64).read_to_end(&mut bytes);
    head.map_err(failed)?;
    let name = found.file_name().unwrap_or_default().to_string_lossy();
    let (kind, encoding) = kind(&bytes, &name);
    let mut found = Found {
        bytes: None,
        size,
        kind,
        encoding,
        cut: false,
        stamp,
    };
    if unless == Some(found.stamp.as_str()) || kind == FileKind::Other {
        return Ok(found);
    }
    let most = match encoding {
        Some(_) => MAX_FILE_TEXT as u64,
        None if size > MAX_FILE as u64 => {
            let why = format!(
                "{name} is {} MB: a preview shows a picture or a PDF of up to {} MB",
                size >> 20,
                MAX_FILE >> 20
            );
            return Err(refused(Code::Invalid, why));
        }
        None => MAX_FILE as u64,
    };
    // Never beyond the size it had when it was opened, however it grows.
    let most = most.min(size);
    let rest = most.saturating_sub(bytes.len() as u64);
    file.take(rest).read_to_end(&mut bytes).map_err(failed)?;
    bytes.truncate(most as usize);
    found.cut = size > most;
    if found.cut {
        match encoding {
            Some(Encoding::Utf8) => {
                // Half a character at the cut goes; bytes that are no text stay.
                if let Err(e) = std::str::from_utf8(&bytes)
                    && e.error_len().is_none()
                {
                    bytes.truncate(e.valid_up_to());
                }
            }
            _ => bytes.truncate(bytes.len() & !1),
        }
    }
    found.bytes = Some(bytes);
    Ok(found)
}

/// The file a `preview.open` names, by its real path: whole, from the
/// home folder, or from `cwd`; there, inside a folder the person opened,
/// and a file. A folder has no preview: it is shown in the system's own
/// file browser (`host.open`).
pub fn resolve(target: &str, cwd: Option<&str>, roots: &[PathBuf]) -> Result<PathBuf, Error> {
    let invalid = |why: String| refused(Code::Invalid, why);
    if target.is_empty() || target.contains("://") || target.chars().any(char::is_control) {
        let why = "A preview shows a file in a folder you opened, or a web address of this machine: this is neither";
        return Err(invalid(why.into()));
    }
    // `~` is the home folder the system names: on Windows the profile's,
    // as the host reads it.
    let home = crate::map::home();
    let Some(asked) = whole(target, cwd, home.as_deref()) else {
        let why = format!("{target} is not a whole path, and its terminal's folder is not known");
        return Err(invalid(why));
    };
    let found = inside(&asked, roots).map_err(|why| outside(why, &asked))?;
    if !found.is_file() {
        let why = format!("{} is not a file: a preview shows files", found.display());
        return Err(invalid(why));
    }
    Ok(found)
}
