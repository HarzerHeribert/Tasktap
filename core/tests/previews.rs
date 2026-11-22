//! Previews beside a terminal (design §9, "Previews"), through the real
//! binary: `file.read` for every kind of file and at each of its bounds,
//! the one rule of what may be read, and the `previews` records a device or
//! an agent opens. The terminal is the fixture shell, which has a record
//! and no process; nothing here starts one.

mod common;

use common::*;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tasktap_core::client::Client;
use tasktap_core::files;
use tasktap_proto::call::{self, Code, Error};
use tasktap_proto::{
    AddProject, Control, Data, Delete, Encoding, FileKind, FileRead, Frame, MAX_FILE,
    MAX_FILE_TEXT, MAX_PREVIEWS, OpenPreview, Outcome, Preview, PreviewBy, PreviewId, PreviewKind,
    ProjectId, ReadFile, Secret, StreamId, TerminalId,
};

/// The fixture shell's token.
const SHELL: Secret = Secret([7; 32]);

fn hex(token: &Secret) -> String {
    let token = serde_json::to_value(token).unwrap();
    token.as_str().unwrap().into()
}

/// A core, a folder the person opened in it whose name has a space and a
/// letter beyond ASCII, a folder beside it that they did not open, and the
/// fixture shell as the terminal previews are shown beside.
struct Bench {
    // Declared first, so the core ends before its folder is removed.
    core: Core,
    w: Watch,
    data: Folder,
    /// The opened folder, as it was given: through no link.
    app: PathBuf,
    other: PathBuf,
    shell: TerminalId,
}

impl Bench {
    fn new(prefix: &str) -> Bench {
        Self::on(Folder::new(prefix))
    }

    fn on(data: Folder) -> Bench {
        let core = Core::start_with(&data.0, &["--fixture-token", &hex(&SHELL)]);
        let (app, other) = (data.0.join("my äpp"), data.0.join("other"));
        fs::create_dir_all(app.join("out")).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("secret.txt"), "not yours").unwrap();
        let mut w = core.watch();
        let add = AddProject {
            id: ProjectId::mint(),
            folder: app.to_str().unwrap().into(),
            name: None,
            create: false,
        };
        w.ok::<call::ProjectAdd>(&add);
        let shell = *w.model.terminals.keys().next().expect("the fixture shell");
        Bench {
            core,
            w,
            data,
            app,
            other,
            shell,
        }
    }

    fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.app.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    fn open(&mut self, target: &str) -> Result<PreviewId, Error> {
        let open = OpenPreview {
            terminal: Some(self.shell),
            target: target.into(),
            cwd: self.app.to_str().map(Into::into),
        };
        self.w.call::<call::PreviewOpen>(&open)
    }

    fn preview(&self, id: PreviewId) -> &Preview {
        &self.w.model.previews[&id]
    }
}

/// Everything a stream carries until it is closed.
fn rest(c: &mut Client, s: StreamId) -> Vec<u8> {
    let mut bytes = Vec::new();
    loop {
        match c.recv().unwrap() {
            Frame::Data(Data { s: of, bytes: b }) if of == s => bytes.extend(b),
            Frame::Control(Control::Close(close)) if close.s == s => return bytes,
            _ => {}
        }
    }
}

fn ask(c: &mut Client, path: &Path, unless: Option<&str>) -> Result<(FileRead, Vec<u8>), Error> {
    let credit = 256 << 10;
    let read = ReadFile {
        path: path.to_str().unwrap().into(),
        credit,
        unless: unless.map(Into::into),
    };
    let reply = c.call::<call::FileRead>(&read).unwrap()?;
    let bytes = match &reply.stream {
        Some(opened) => {
            c.track(opened, credit, true);
            rest(c, opened.s)
        }
        None => Vec::new(),
    };
    Ok((reply, bytes))
}

fn read(c: &mut Client, path: &Path) -> (FileRead, Vec<u8>) {
    ask(c, path, None).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn refused(c: &mut Client, path: &Path) -> (Code, String) {
    match ask(c, path, None) {
        Err(e) => (e.code, e.message),
        Ok((reply, _)) => panic!("{} was read: {reply:?}", path.display()),
    }
}

#[test]
fn a_files_kind_is_its_first_bytes_and_then_its_name() {
    use Encoding::{Utf8, Utf16be, Utf16le};
    use FileKind::*;
    let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
    let cases: [(&[u8], &str, FileKind, Option<Encoding>); 22] = [
        (png, "shot.png", Png, None),
        // What it is called does not change what it is.
        (png, "shot.txt", Png, None),
        (png, "shot", Png, None),
        (b"\xff\xd8\xff\xe0\0\x10JFIF", "photo.jpg", Jpeg, None),
        (b"GIF89a\x01\0\x01\0", "loop.gif", Gif, None),
        (b"GIF87a\x01\0\x01\0", "old.gif", Gif, None),
        (b"RIFF\x24\0\0\0WEBPVP8 ", "pic.webp", Webp, None),
        (b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "report.pdf", Pdf, None),
        ("Größe: 3\n".as_bytes(), "notes.txt", Text, Some(Utf8)),
        (b"fn main() {}\n", "main.rs", Text, Some(Utf8)),
        (b"all: build\n", "Makefile", Text, Some(Utf8)),
        (b"", "empty", Text, Some(Utf8)),
        (b"\xef\xbb\xbfwith a mark", "bom.txt", Text, Some(Utf8)),
        (b"# Title\n", "README.md", Markdown, Some(Utf8)),
        (b"# Title\n", "notes.MARKDOWN", Markdown, Some(Utf8)),
        (b"<!doctype html><p>Hi", "report.html", Html, Some(Utf8)),
        (b"<p>Hi", "old.HTM", Html, Some(Utf8)),
        (
            b"<svg xmlns='http://www.w3.org/2000/svg'/>",
            "mark.svg",
            Svg,
            Some(Utf8),
        ),
        (b"\xff\xfeh\0i\0", "wide.txt", Text, Some(Utf16le)),
        (b"\xfe\xff\0h\0i", "wide.md", Markdown, Some(Utf16be)),
        // Neither a picture nor text: no preview shows it.
        (b"\x7fELF\x02\x01\x01\0", "tool", Other, None),
        (b"caf\xe9 au lait", "latin1.txt", Other, None),
    ];
    for (head, name, kind, encoding) in cases {
        assert_eq!(files::kind(head, name), (kind, encoding), "{name}");
    }
    // RIFF that is not WebP, and a file too short to say.
    assert_eq!(files::kind(b"RIFF\x24\0\0\0WAVEfmt ", "a.wav").0, Other);
    assert_eq!(files::kind(b"RIFF", "a.webp").0, Text);
    // A character cut where the first 8 KiB end is still text.
    let cut = "ö".repeat(4096);
    assert_eq!(files::kind(&cut.as_bytes()[..8191], "a.txt").0, Text);
}

#[test]
fn file_read_streams_each_kind_of_file_with_what_it_is() {
    let b = Bench::new("pk");
    let mut c = b.core.device();
    let wide: Vec<u8> = [0xff, 0xfe]
        .into_iter()
        .chain("Größe".encode_utf16().flat_map(u16::to_le_bytes))
        .collect();
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.extend((0..70_000u32).flat_map(u32::to_be_bytes));
    let cases: [(&str, &[u8], FileKind, Option<Encoding>); 9] = [
        (
            "größe 1.md",
            "# Größe\n\nEin Bericht.\n".as_bytes(),
            FileKind::Markdown,
            Some(Encoding::Utf8),
        ),
        (
            "out/report final.html",
            b"<!doctype html><title>R</title>",
            FileKind::Html,
            Some(Encoding::Utf8),
        ),
        (
            "notes.txt",
            b"plain\n",
            FileKind::Text,
            Some(Encoding::Utf8),
        ),
        ("wide.txt", &wide, FileKind::Text, Some(Encoding::Utf16le)),
        (
            "mark.svg",
            b"<svg xmlns='http://www.w3.org/2000/svg'/>",
            FileKind::Svg,
            Some(Encoding::Utf8),
        ),
        ("bild schön.png", &png, FileKind::Png, None),
        (
            "photo.jpg",
            b"\xff\xd8\xff\xe0\0\x10JFIF\0",
            FileKind::Jpeg,
            None,
        ),
        ("paper.pdf", b"%PDF-1.7\n1 0 obj\n", FileKind::Pdf, None),
        ("empty.txt", b"", FileKind::Text, Some(Encoding::Utf8)),
    ];
    for (name, bytes, kind, encoding) in cases {
        let path = b.write(name, bytes);
        let (reply, got) = read(&mut c, &path);
        assert_eq!((reply.kind, reply.encoding), (kind, encoding), "{name}");
        assert_eq!(
            (reply.size, reply.cut),
            (bytes.len() as u64, false),
            "{name}"
        );
        assert!(reply.stream.is_some(), "{name}");
        assert!(
            got == bytes,
            "{name}: {} bytes of {}",
            got.len(),
            bytes.len()
        );
    }
    // What no preview shows is said, and not sent.
    let tool = b.write("tool", b"\x7fELF\x02\x01\x01\0\0\0");
    let (reply, got) = read(&mut c, &tool);
    assert_eq!(
        (reply.kind, reply.size, reply.stream),
        (FileKind::Other, 10, None)
    );
    assert!(got.is_empty());
    // In one of the copies Tasktap made for a run, a file is read as in the folder.
    let copy = b.data.0.join("worktrees").join("0123456789ab");
    fs::create_dir_all(&copy).unwrap();
    fs::write(copy.join("a.txt"), "in a copy").unwrap();
    assert_eq!(read(&mut c, &copy.join("a.txt")).1, b"in a copy");
}

#[test]
fn file_read_refuses_whatever_is_not_a_file_inside_a_folder_the_person_opened() {
    let b = Bench::new("pr");
    let mut c = b.core.device();
    let inside = b.write("in.txt", b"yours");
    let ends = |(code, why): (Code, String), want: Code, end: &str| {
        assert_eq!(code, want, "{why}");
        assert!(why.ends_with(end), "{why}");
    };
    const OUTSIDE: &str = "is outside the folders you opened in Tasktap";
    // Beside the folder, by its name or by a way through the folder.
    ends(
        refused(&mut c, &b.other.join("secret.txt")),
        Code::Denied,
        OUTSIDE,
    );
    let around = b.app.join("..").join("other").join("secret.txt");
    ends(refused(&mut c, &around), Code::Denied, OUTSIDE);
    // The core's own files are not the person's folders.
    ends(
        refused(&mut c, &b.data.0.join("core.db")),
        Code::Denied,
        OUTSIDE,
    );
    // What is not there, a path that is not whole, a folder.
    ends(
        refused(&mut c, &b.app.join("none.txt")),
        Code::Gone,
        "does not exist",
    );
    ends(
        refused(&mut c, Path::new("in.txt")),
        Code::Invalid,
        "is not a whole path",
    );
    ends(
        refused(&mut c, &b.app.join("out")),
        Code::Invalid,
        "is not a file: a preview shows files",
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        // A link inside the folder that leads out of it, to a file or through a folder.
        symlink(b.other.join("secret.txt"), b.app.join("link.txt")).unwrap();
        symlink(&b.other, b.app.join("away")).unwrap();
        ends(
            refused(&mut c, &b.app.join("link.txt")),
            Code::Denied,
            OUTSIDE,
        );
        ends(
            refused(&mut c, &b.app.join("away").join("secret.txt")),
            Code::Denied,
            OUTSIDE,
        );
        // A link to nothing is nothing.
        symlink(b.app.join("gone"), b.app.join("dangling")).unwrap();
        ends(
            refused(&mut c, &b.app.join("dangling")),
            Code::Gone,
            "does not exist",
        );
        // A link from outside that leads in reads the file it leads to.
        symlink(&b.app, b.other.join("back")).unwrap();
        assert_eq!(
            read(&mut c, &b.other.join("back").join("in.txt")).1,
            b"yours"
        );
        // And one inside to a file inside.
        symlink(&inside, b.app.join("same.txt")).unwrap();
        assert_eq!(read(&mut c, &b.app.join("same.txt")).1, b"yours");
        // A pipe is no file: it is refused, not waited on.
        let made = Command::new("mkfifo").arg(b.app.join("pipe")).status();
        if made.is_ok_and(|status| status.success()) {
            ends(
                refused(&mut c, &b.app.join("pipe")),
                Code::Invalid,
                "a preview shows files",
            );
        }
    }
    // An agent's token reads nothing: the bytes go to a device.
    let mut agent = b.core.agent(&SHELL);
    let asked = agent.raw("file.read", json!({"path": inside, "credit": 1024}));
    assert_eq!(code(asked), Code::Denied);
    // And with no folder opened at all nothing is inside.
    let bare = Folder::new("pr");
    let core = Core::start(&bare.0);
    let file = bare.0.join("scratch.txt");
    fs::write(&file, "x").unwrap();
    ends(refused(&mut core.device(), &file), Code::Denied, OUTSIDE);
}

#[test]
fn file_read_cuts_long_text_between_characters_and_refuses_a_picture_too_large() {
    let b = Bench::new("pb");
    let mut c = b.core.device();
    // Text one byte over the bound, with a two-byte letter across it.
    let mut text = "a".repeat(MAX_FILE_TEXT - 1);
    text.push_str("ö and the rest");
    let long = b.write("long.md", text.as_bytes());
    let (reply, got) = read(&mut c, &long);
    assert_eq!((reply.size, reply.cut), (text.len() as u64, true));
    assert_eq!(got.len(), MAX_FILE_TEXT - 1, "the half letter is not sent");
    assert!(got == text.as_bytes()[..MAX_FILE_TEXT - 1]);
    // Exactly at the bound nothing is cut.
    let fits = b.write("fits.txt", "b".repeat(MAX_FILE_TEXT).as_bytes());
    let (reply, got) = read(&mut c, &fits);
    assert_eq!((reply.cut, got.len()), (false, MAX_FILE_TEXT));
    // UTF-16 is cut between two units.
    let wide: Vec<u8> = [0xff, 0xfe]
        .into_iter()
        .chain(std::iter::repeat_n([b'x', 0], MAX_FILE_TEXT / 2).flatten())
        .chain(*b"y")
        .collect();
    let (reply, got) = read(&mut c, &b.write("wide.txt", &wide));
    assert_eq!((reply.cut, got.len()), (true, MAX_FILE_TEXT));

    // A picture is sent whole or not at all.
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.resize(MAX_FILE, 0xab);
    let largest = b.write("largest.png", &png);
    let (reply, got) = read(&mut c, &largest);
    assert_eq!((reply.kind, reply.cut), (FileKind::Png, false));
    assert!(got == png, "{} bytes", got.len());
    png.push(0);
    let (code, why) = refused(&mut c, &b.write("too large.png", &png));
    assert_eq!(code, Code::Invalid);
    assert_eq!(
        why,
        "too large.png is 16 MB: a preview shows a picture or a PDF of up to 16 MB"
    );
    // What is neither is never read, whatever its size.
    let mut blob = vec![0u8; 64];
    blob.resize(MAX_FILE + 1, 1);
    let (reply, got) = read(&mut c, &b.write("blob.bin", &blob));
    assert_eq!(
        (reply.kind, reply.stream, got.len()),
        (FileKind::Other, None, 0)
    );
}

#[test]
fn a_file_that_changes_or_goes_while_it_is_streamed_arrives_as_it_was_and_its_stamp_tells() {
    let b = Bench::new("pc");
    let mut slow = b.core.device();
    let first = "first ".repeat(40_000);
    let path = b.write("report.md", first.as_bytes());
    // A client that takes 1 KiB and then stops.
    let open = ReadFile {
        path: path.to_str().unwrap().into(),
        credit: 1024,
        unless: None,
    };
    let was = slow.call::<call::FileRead>(&open).unwrap().unwrap();
    let s = was.stream.unwrap().s;
    slow.track(was.stream.as_ref().unwrap(), 1024, false);
    let mut got = Vec::new();
    while got.len() < 1024 {
        if let Frame::Data(Data { s: of, bytes }) = slow.recv().unwrap() {
            assert_eq!(of, s);
            got.extend(bytes);
        }
    }
    assert_eq!(got.len(), 1024, "no more than was granted");

    // The file is written anew meanwhile. A preview that asks hears so by
    // the stamp, and gets the new file; asked again, nothing is sent.
    let second = "second, and longer ".repeat(20_000);
    fs::write(&path, &second).unwrap();
    let mut c = b.core.device();
    let (now, bytes) = ask(&mut c, &path, Some(&was.stamp)).unwrap();
    assert_ne!(now.stamp, was.stamp);
    assert!(bytes == second.as_bytes());
    let (same, bytes) = ask(&mut c, &path, Some(&now.stamp)).unwrap();
    assert_eq!(
        (same.stream, same.stamp, same.size),
        (None, now.stamp.clone(), now.size)
    );
    assert_eq!((same.kind, bytes.len()), (FileKind::Markdown, 0));
    // A stamp the file never had is no reason to send nothing.
    assert!(ask(&mut c, &path, Some("0-0")).unwrap().0.stream.is_some());

    // Then it is deleted. The slow client still gets all of the file it asked for.
    fs::remove_file(&path).unwrap();
    assert_eq!(refused(&mut c, &path).0, Code::Gone);
    slow.grant(s, 1 << 20).unwrap();
    got.extend(rest(&mut slow, s));
    assert_eq!(was.size, first.len() as u64);
    assert!(got == first.as_bytes(), "{} bytes", got.len());
}

#[test]
fn four_files_are_held_at_once_and_the_fifth_waits_for_one_to_be_taken() {
    let b = Bench::new("pf");
    let mut c = b.core.device();
    let path = b.write("a.txt", b"held");
    let hold = ReadFile {
        path: path.to_str().unwrap().into(),
        credit: 0,
        unless: None,
    };
    let held: Vec<_> = (0..4)
        .map(|_| c.call::<call::FileRead>(&hold).unwrap().unwrap())
        .collect();
    let busy = c.call::<call::FileRead>(&hold).unwrap().unwrap_err();
    assert_eq!(
        (busy.code, busy.message.as_str()),
        (
            Code::Failed,
            "too many files are being sent; try again soon"
        )
    );
    // A stream the client closes, or takes to its end, makes room.
    let first = held[0].stream.unwrap();
    c.track(&first, 0, false);
    c.close(first.s).unwrap();
    let again = c.call::<call::FileRead>(&hold).unwrap().unwrap();
    assert!(c.call::<call::FileRead>(&hold).unwrap().is_err());
    let s = again.stream.as_ref().unwrap().s;
    c.track(again.stream.as_ref().unwrap(), 0, false);
    c.grant(s, 1024).unwrap();
    assert_eq!(rest(&mut c, s), b"held");
    // One that sends nothing, since the file is as it was, holds nothing.
    let unless = Some(held[0].stamp.clone());
    let same = ReadFile {
        unless,
        ..hold.clone()
    };
    assert_eq!(
        c.call::<call::FileRead>(&same).unwrap().unwrap().stream,
        None
    );
    assert!(c.call::<call::FileRead>(&hold).unwrap().is_ok());
    // And a client that leaves takes its streams with it, once the core has seen it go.
    assert!(c.call::<call::FileRead>(&hold).unwrap().is_err());
    drop(c);
    let mut c = b.core.device();
    let mut tries = 0;
    while c.call::<call::FileRead>(&hold).unwrap().is_err() {
        tries += 1;
        assert!(
            tries < 500,
            "the streams of a client that left are still held"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[test]
fn a_device_opens_a_file_or_an_address_of_this_machine_beside_a_terminal_and_nothing_else() {
    let mut b = Bench::new("po");
    let file = b.write("größe 1.md", "# Größe\n".as_bytes());
    let real = fs::canonicalize(&file).unwrap();
    // A path from the terminal's folder, as it was printed there.
    let id = b.open("größe 1.md").unwrap();
    let p = b.preview(id).clone();
    assert_eq!(
        (p.terminal_id, p.kind, p.by),
        (b.shell, PreviewKind::File, PreviewBy::Person)
    );
    assert_eq!(
        (p.target.as_str(), p.title.as_str()),
        (real.to_str().unwrap(), "größe 1.md")
    );
    // Its target is what `file.read` takes.
    let mut c = b.core.device();
    assert_eq!(read(&mut c, Path::new(&p.target)).1, "# Größe\n".as_bytes());
    // The same file again, however it is named, is the preview that is open.
    assert_eq!(b.open(file.to_str().unwrap()), Ok(id));
    assert_eq!(b.open("out/../größe 1.md"), Ok(id));
    assert_eq!(b.w.model.previews.len(), 1);

    // An address of this machine, on any port.
    let web = b.open("http://localhost:5173/report.html?tab=2").unwrap();
    let p = b.preview(web).clone();
    assert_eq!(
        (p.kind, p.title.as_str()),
        (PreviewKind::Web, "localhost:5173")
    );
    assert_eq!(p.target, "http://localhost:5173/report.html?tab=2");
    let other = b.open("http://127.0.0.1:8000").unwrap();
    assert_eq!(b.preview(other).title, "127.0.0.1:8000");
    assert_eq!(
        b.open("http://[::1]:3000/")
            .map(|id| b.preview(id).title.clone())
            .unwrap(),
        "[::1]:3000"
    );

    // Everything else is refused in a sentence, and nothing is written.
    let before = b.w.model.previews.clone();
    let mut refused = |target: &str| {
        let e = b.open(target).unwrap_err();
        (e.code, e.message)
    };
    const REMOTE: &str =
        "A preview shows web addresses of this machine only: this one opens in the browser";
    for remote in [
        "https://example.com/",
        "http://localhost.example.com/",
        "http://localhost@example.com/",
        "http://0.0.0.0:8000/",
        "http://192.168.1.10:3000/",
    ] {
        assert_eq!(refused(remote), (Code::Invalid, REMOTE.into()), "{remote}");
    }
    assert_eq!(refused("http://localhost:0/").0, Code::Invalid);
    for neither in ["file:///etc/passwd", "javascript:alert(1)//://", ""] {
        let (code, why) = refused(neither);
        assert_eq!(code, Code::Invalid, "{neither}");
        assert!(why.ends_with("this is neither"), "{why}");
    }
    let (code, why) = refused("../other/secret.txt");
    assert_eq!(code, Code::Denied);
    assert!(
        why.ends_with("is outside the folders you opened in Tasktap"),
        "{why}"
    );
    assert_eq!(refused("none.md").0, Code::Gone);
    // A folder has no preview.
    let (code, why) = refused("out");
    assert_eq!(code, Code::Invalid);
    assert!(
        why.ends_with("is not a file: a preview shows files"),
        "{why}"
    );
    b.w.sync();
    assert_eq!(b.w.model.previews, before);

    // The terminal is named, and is one the core knows. The fixture shell
    // has no folder of its own: a path that is not whole needs one.
    let mut open = OpenPreview {
        terminal: None,
        target: "größe 1.md".into(),
        cwd: None,
    };
    assert_eq!(b.w.refused::<call::PreviewOpen>(&open).code, Code::Invalid);
    open.terminal = Some(b.shell);
    let e = b.w.refused::<call::PreviewOpen>(&open);
    assert_eq!(e.code, Code::Invalid);
    assert!(
        e.message.ends_with("its terminal's folder is not known"),
        "{e}"
    );
    open.terminal = Some(TerminalId::mint());
    open.target = file.to_str().unwrap().into();
    assert_eq!(b.w.refused::<call::PreviewOpen>(&open).code, Code::Gone);
    open.target = "http://localhost:1/".into();
    assert_eq!(b.w.refused::<call::PreviewOpen>(&open).code, Code::Gone);
}

/// `tasktap preview`, run in the terminal as an agent runs it.
fn tool(b: &Bench, target: &str) -> std::process::Output {
    let mut c = Command::new(EXE);
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("TASKTAP_") {
            c.env_remove(name);
        }
    }
    c.args(["preview", target]).current_dir(&b.app);
    c.env("TASKTAP_SOCKET", b.data.0.join("core.sock"));
    c.env("TASKTAP_TOKEN", hex(&SHELL));
    c.stdin(Stdio::null()).output().unwrap()
}

#[test]
fn an_agent_shows_a_preview_beside_its_own_terminal_under_the_same_rule() {
    let mut b = Bench::new("pa");
    b.write("out/report.html", b"<!doctype html><p>Done");
    // With the tool, from the folder the agent works in.
    let ran = tool(&b, "out/report.html");
    assert!(
        ran.status.success(),
        "{}",
        String::from_utf8_lossy(&ran.stderr)
    );
    b.w.sync();
    let shown: Vec<Preview> = b.w.model.previews.values().cloned().collect();
    assert_eq!(shown.len(), 1);
    let p = &shown[0];
    assert_eq!(
        (p.terminal_id, p.kind, p.by),
        (b.shell, PreviewKind::File, PreviewBy::Agent)
    );
    assert_eq!(p.title, "report.html");
    assert!(tool(&b, "http://localhost:5173/").status.success());
    // The person opening the same is shown the agent's, not a second one.
    assert_eq!(b.open("out/report.html"), Ok(p.id));
    b.w.sync();
    assert_eq!(b.w.model.previews.len(), 2);

    // Refused as a device's would be, in the same words, on standard error.
    for (target, why) in [
        (
            "https://example.com/",
            "tasktap: A preview shows web addresses of this machine only: this one opens in the browser\n",
        ),
        (
            "http://169.254.169.254/latest/",
            "tasktap: A preview shows web addresses of this machine only: this one opens in the browser\n",
        ),
    ] {
        let ran = tool(&b, target);
        assert_eq!(ran.status.code(), Some(1), "{target}");
        assert_eq!(String::from_utf8_lossy(&ran.stderr), why);
    }
    let outside = tool(&b, "../other/secret.txt");
    assert_eq!(outside.status.code(), Some(1));
    let said = String::from_utf8_lossy(&outside.stderr).into_owned();
    assert!(
        said.trim_end()
            .ends_with("is outside the folders you opened in Tasktap"),
        "{said}"
    );
    assert_eq!(tool(&b, "/etc/hosts").status.code(), Some(1));
    let usage = Command::new(EXE).arg("preview").output().unwrap();
    assert_eq!(usage.status.code(), Some(64));

    // Its token names its terminal: beside another it shows nothing, and
    // it closes nothing, which is the person's to do.
    let mut agent = b.core.agent(&SHELL);
    let own = json!({"terminal": b.shell, "target": "http://localhost:1/"});
    assert!(matches!(agent.raw("preview.open", own), Outcome::Ok(_)));
    let other = json!({"terminal": TerminalId::mint(), "target": "http://localhost:2/"});
    assert_eq!(code(agent.raw("preview.open", other)), Code::Denied);
    let close = json!({"c": "previews", "id": p.id});
    assert_eq!(code(agent.raw("delete", close)), Code::Denied);
    // And a peer with neither a device's key nor a terminal's token shows nothing.
    let mut nobody = b.core.anonymous();
    let asked = raw(
        &mut nobody,
        "preview.open",
        json!({"terminal": b.shell, "target": "http://localhost:3/"}),
    );
    assert_eq!(code(asked), Code::Denied);
    b.w.sync();
    assert_eq!(b.w.model.previews.len(), 3);
}

#[test]
fn previews_outlive_the_core_are_closed_one_by_one_and_go_with_their_terminal() {
    let mut b = Bench::new("ps");
    b.write("a.md", b"# A\n");
    let file = b.open("a.md").unwrap();
    // Eight beside one terminal, and no more.
    let mut all = vec![file];
    for port in 1..MAX_PREVIEWS {
        all.push(b.open(&format!("http://localhost:{port}/")).unwrap());
    }
    let full = b.open("http://localhost:9000/").unwrap_err();
    assert_eq!(
        (full.code, full.message.as_str()),
        (
            Code::Conflict,
            "this terminal has 8 previews open already: close one first"
        )
    );
    // One that is open already is still found.
    assert_eq!(b.open("a.md"), Ok(file));
    let before = b.w.model.previews.clone();
    assert_eq!(before.len(), MAX_PREVIEWS);

    // The core stops and starts: the pages too, then. Every preview is as it was.
    let Bench { core, w, data, .. } = b;
    drop(w);
    core.stop();
    let mut b = Bench::on(data);
    assert_eq!(b.w.model.previews, before);

    // Closed, a preview is gone, and closing it again changes nothing.
    let web = all.pop().unwrap();
    b.w.ok::<call::Delete>(&Delete::Previews { id: web });
    assert!(!b.w.model.previews.contains_key(&web));
    let rev = b.w.ok::<call::Delete>(&Delete::Previews { id: web });
    assert_eq!(rev.rev.get(), b.w.model.rev);
    assert_eq!(b.w.model.previews.len(), MAX_PREVIEWS - 1);
    // And there is room for another.
    b.open("http://localhost:9000/").unwrap();

    // The terminal's record goes, and every preview beside it in the same step.
    let rev = b.w.ok::<call::Delete>(&Delete::Terminals { id: b.shell });
    assert_eq!(rev.rev.get(), b.w.model.rev);
    assert!(b.w.model.previews.is_empty() && b.w.model.terminals.is_empty());
    let Bench { core, w, data, .. } = b;
    drop(w);
    core.stop();
    let core = Core::start(&data.0);
    assert!(core.watch().model.previews.is_empty());
}
