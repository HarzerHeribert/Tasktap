//! Web calls (design §8, "Web calls"): one request through the system's own
//! `curl`, started for that call and given everything on its standard
//! input as a configuration, so a key is in no argument, no file and no
//! process list. It uses the system's certificates and the environment's
//! proxy, which is what a laptop at work needs, and adds nothing to the
//! binary. A call blocks, so the core makes it on a thread of its own.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::command::{self, Wait};

/// Most bytes of an answer; more is no answer.
pub const MAX_ANSWER: usize = 1 << 20;
/// Seconds a connection may take to come about, within the call's limit.
const CONNECT: u64 = 10;

/// A form posted to an address: text fields and one file.
pub struct Post<'a> {
    pub url: &'a str,
    /// Sent as `Authorization: Bearer`.
    pub key: Option<&'a str>,
    pub fields: &'a [(&'a str, &'a str)],
    /// The form's `file`: a file of `folder` by its name there, the name
    /// the server is told, and its type.
    pub file: (&'a Path, &'a str, &'a str, &'a str),
    /// The longest the whole call takes.
    pub limit: Duration,
}

/// An answer, whatever its status.
#[derive(Debug, PartialEq, Eq)]
pub struct Answer {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Why a call has no answer; a text is curl's own reason, in one line.
#[derive(Debug, PartialEq, Eq)]
pub enum Failed {
    /// This system has no curl.
    Missing,
    /// It was stopped: nobody waits for the answer.
    Stopped,
    /// No answer within the limit.
    Slow,
    /// No such host, no route, or the connection was refused.
    Unreachable(String),
    /// The server's certificate, or the secure connection, was not accepted.
    Untrusted(String),
    Other(String),
}

/// The system's curl: its own on the Mac and on Windows, where it reads
/// the system's certificates, and the PATH's elsewhere.
fn curl() -> PathBuf {
    if cfg!(target_os = "macos") {
        return "/usr/bin/curl".into();
    }
    match std::env::var_os("SystemRoot").filter(|_| cfg!(windows)) {
        Some(root) => Path::new(&root).join("System32").join("curl.exe"),
        None => "curl".into(),
    }
}

/// A value in curl's configuration: in quotes, a quote and a backslash
/// escaped. None for a value with a control character, which no
/// configuration line can hold.
fn quoted(value: &str) -> Option<String> {
    if value.chars().any(char::is_control) {
        return None;
    }
    Some(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

/// What curl is told: one option a line, as its `--config` reads them.
/// Every option is older than the curl of Windows 10.
fn configuration(post: &Post) -> Option<String> {
    let (_, name, sent_as, kind) = post.file;
    // Inside a form's value `;`, `,` and quotes have a meaning of their own.
    let simple = |text: &str| {
        let fits = |c: char| c.is_ascii_alphanumeric() || "._-/".contains(c);
        !text.is_empty() && text.chars().all(fits)
    };
    if ![name, sent_as, kind].into_iter().all(simple) {
        return None;
    }
    let mut lines = vec![
        format!("url = {}", quoted(post.url)?),
        // Only these, and no redirect is followed: a key goes nowhere else.
        "proto = \"=http,https\"".to_owned(),
        format!("max-time = {:.3}", post.limit.as_secs_f64()),
        format!("connect-timeout = {CONNECT}"),
        "silent".to_owned(),
        "show-error".to_owned(),
        // The status is the last line of what it prints.
        "write-out = \"\\n%{http_code}\"".to_owned(),
        format!("form = \"file=@{name};filename={sent_as};type={kind}\""),
    ];
    if let Some(key) = post.key {
        let header = format!("Authorization: Bearer {key}");
        lines.push(format!("header = {}", quoted(&header)?));
    }
    for (name, value) in post.fields {
        lines.push(format!(
            "form-string = {}",
            quoted(&format!("{name}={value}"))?
        ));
    }
    Some(lines.join("\n") + "\n")
}

/// Makes the call and returns the server's answer. `wait` is what a
/// [`command::Signal::Stop`] is sent on to end it.
pub fn post(post: &Post, wait: Wait) -> Result<Answer, Failed> {
    let unusable = || Failed::Other("the request cannot be written for curl".into());
    let configuration = configuration(post).ok_or_else(unusable)?;
    let mut curl = Command::new(curl());
    // `-q` first: no `.curlrc` changes the call.
    curl.args(["-q", "--config", "-"]).current_dir(post.file.0);
    // curl's own limit ends the call; this one only ends a curl that hangs.
    let limit = post.limit + Duration::from_secs(5);
    let most = MAX_ANSWER + 16;
    let ran = command::run(curl, configuration.into_bytes(), limit, most, wait);
    let ran = ran.map_err(|e| match e {
        command::Failed::Missing => Failed::Missing,
        command::Failed::Stopped => Failed::Stopped,
        command::Failed::Slow => Failed::Slow,
        command::Failed::Large => Failed::Other("the answer is too large".into()),
        command::Failed::Start(why) => Failed::Other(format!("curl could not run: {why}")),
    })?;
    // "curl: (6) Could not resolve host: …" is its reason.
    let said = (ran.err.lines())
        .find(|line| !line.trim().is_empty())
        .unwrap_or("curl gave no reason");
    let why = said.trim().trim_start_matches("curl: ").to_owned();
    match ran.code {
        Some(0) => {
            let cut = ran.out.iter().rposition(|&b| b == b'\n');
            let status = cut.and_then(|at| std::str::from_utf8(&ran.out[at + 1..]).ok());
            match (cut, status.and_then(|s| s.trim().parse().ok())) {
                (Some(at), Some(status)) => Ok(Answer {
                    status,
                    body: ran.out[..at].to_vec(),
                }),
                _ => Err(Failed::Other("curl printed no status".into())),
            }
        }
        Some(5..=7) => Err(Failed::Unreachable(why)),
        Some(28) => Err(Failed::Slow),
        Some(35 | 51 | 58 | 60 | 77) => Err(Failed::Untrusted(why)),
        _ => Err(Failed::Other(why)),
    }
}
