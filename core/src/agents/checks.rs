//! The checks that run an agent's own program, as its adapter describes
//! them (design §7): whether it is installed and signed in, and the probe a
//! run of some agents needs before it starts. Each blocks, so the core runs
//! them on threads of their own; each ends its program when its time is up.
//! The programs get the environment the core's terminals get, without the
//! core's own variables, and are found on the same PATH.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use tasktap_proto::AgentHealth;

use super::{Agent, Headless, Probe, Schema, fit, line};

/// Longest one detection command runs.
pub const LIMIT: Duration = Duration::from_secs(4);
/// Longest a probe runs (1.2 allowed Codex's app server 12 s).
pub const PROBE_LIMIT: Duration = Duration::from_secs(12);
/// Most bytes read from a check's output.
const MAX_OUTPUT: u64 = 4 << 20;
/// Most bytes of an answer to a headless question; more is no answer.
const MAX_ANSWER: u64 = 64 << 10;

/// Why a headless question got no answer.
#[derive(Debug, PartialEq, Eq)]
pub enum Failed {
    /// Its tool no longer offers the model it is asked for.
    Gone,
    /// Its tool said the person's plan or key has reached its usage limit,
    /// and when it is back where it said; with its words.
    Limit(super::quota::Back, String),
    Why(String),
}

impl From<String> for Failed {
    fn from(why: String) -> Failed {
        Failed::Why(why)
    }
}

/// What ends the wait for a headless question's answer.
pub enum Asked {
    /// Everything it printed on standard output.
    Printed(Vec<u8>),
    /// Nobody wants the answer any more.
    Stop,
}

/// Whether `agent` is installed and signed in, as its own commands say.
/// A core runs them when the person looks at their agents, picks this one
/// or asks, and the first time it gives the agent a thought: never as it
/// starts, since some agents write to their own files each time they run
/// and one asks its service.
pub fn detect(agent: &dyn Agent) -> AgentHealth {
    let mut health = found(agent);
    // Started as the person starts it, their command then its arguments.
    let start = super::started(agent).ok().filter(|_| health.supported);
    let Some(start) = start else {
        return health;
    };
    // A command it has not got is not run: the program alone would start it.
    let checks = agent.detect();
    let asked = |args: &'static [&'static str]| match args.is_empty() {
        true => Err(String::new()),
        false => output(&start, args),
    };
    // A version only where it looks like one, with a number in it; through
    // the person's command, only where that ended well.
    let printed = asked(checks.version);
    let version = printed.as_ref().ok().and_then(|(code, out)| {
        let version = (checks.version_of)(out)?;
        let ended = !start.theirs || *code == Some(0);
        (ended && version.contains(|c: char| c.is_ascii_digit())).then_some(version)
    });
    health.version = version.as_deref().map(|v| fit(v, 200));
    // Their command did not start the agent: it says so, and nothing of a
    // sign-in, which its program would have answered in the agent's place.
    if start.theirs && !checks.version.is_empty() && version.is_none() {
        let said = match &printed {
            Ok((_, out)) => out.lines().map(str::trim).find(|l| !l.is_empty()),
            Err(why) => Some(why.as_str()),
        };
        let name = agent.name();
        let said = super::line(said.unwrap_or("it printed nothing"), 200);
        health.command_fails = Some(format!(
            "The command of {name} did not start {name}: {said}"
        ));
        return health;
    }
    if let Ok((code, out)) = asked(checks.account) {
        let (signed_in, identity) = (checks.account_of)(code, &out);
        health.signed_in = signed_in;
        health.identity = identity.map(|i| fit(&i, 200));
    }
    health
}

/// What is known of `agent` with no command of its own run: its name, what
/// its runs can do, and whether its program is on the PATH, or the first
/// word of the person's command for it, where they start it their own
/// way ([`super::started`]). A core puts
/// this as it starts, with what its commands last said ([`Said`]), so a
/// page names its agents and shows their rings at once.
pub fn found(agent: &dyn Agent) -> AgentHealth {
    let caps = agent.caps();
    let mut health = AgentHealth {
        id: agent.id().into(),
        name: agent.name().into(),
        program: agent.program().into(),
        supported: agent.supported(),
        own: agent.own(),
        note: agent.note().map(Into::into),
        checks: !agent.detect().account.is_empty(),
        options: (agent.options().iter())
            .map(|o| tasktap_proto::AgentOption {
                id: o.id.into(),
                name: o.name.into(),
                allows: o.allows.into(),
            })
            .collect(),
        stale: false,
        // Stamped once the collection takes the row.
        rev: tasktap_proto::Rev::ZERO,
        checked: tasktap_proto::Time::ZERO,
        installed: false,
        command_fails: None,
        version: None,
        signed_in: None,
        identity: None,
        limited: None,
        events: caps.events,
        resume: caps.resume,
        permissions: caps.permissions,
        questions: caps.questions,
    };
    let start = super::started(agent);
    health.installed = start.is_ok();
    // Their command, refused as it is stored, or one that cannot start.
    let theirs = !super::command(agent).is_empty();
    let fails = start.err().filter(|_| theirs);
    health.command_fails = super::command_refused(agent).or(fails);
    health
}

/// What an agent's commands said when a core last ran them, kept in the
/// data folder so that the next core knows it without running them: whether
/// it is signed in, and when that was said, and until when its tool said
/// the person's plan or key is out of quota. Whom it is signed in as is not kept.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Said {
    pub id: String,
    pub checked: tasktap_proto::Time,
    /// None where only the limit is kept.
    pub signed_in: Option<bool>,
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limited: Option<tasktap_proto::Time>,
}

impl Said {
    /// What `row` says that the next core should know: nothing while its
    /// commands never said whether it is signed in and its tool never
    /// spoke of a limit.
    pub fn of(row: &AgentHealth) -> Option<Said> {
        let signed_in = row.signed_in.filter(|_| row.installed);
        (signed_in.is_some() || row.limited.is_some()).then(|| Said {
            id: row.id.clone(),
            checked: row.checked,
            signed_in,
            version: row.version.clone(),
            limited: row.limited,
        })
    }

    /// `found` with what its agent's commands last said, marked as said
    /// then (`stale`); as it is for an agent that is not here any more.
    pub fn onto(&self, found: AgentHealth) -> AgentHealth {
        let found = AgentHealth {
            limited: self.limited,
            ..found
        };
        match found.installed && found.supported && self.signed_in.is_some() {
            true => AgentHealth {
                checked: self.checked,
                signed_in: self.signed_in,
                version: self.version.clone(),
                stale: true,
                ..found
            },
            false => found,
        }
    }
}

/// What is to be kept next: the newest rows, until a write has taken them.
pub type ToKeep = std::sync::Arc<std::sync::Mutex<Option<Vec<Said>>>>;

/// The file of [`Said`] in the data folder.
fn said_file(data: &Path) -> std::path::PathBuf {
    data.join("agents.json")
}

/// What the agents' commands last said, as a core before this one kept it;
/// nothing when none did or the file is not as this build writes it.
pub fn said(data: &Path) -> Vec<Said> {
    let kept = std::fs::read(said_file(data)).ok();
    kept.and_then(|text| serde_json::from_slice(&text).ok())
        .unwrap_or_default()
}

/// Keeps what the agents' commands said, whole or not at all.
pub fn keep_said(data: &Path, said: &[Said]) -> std::io::Result<()> {
    whole(&said_file(data), &serde_json::to_vec(said)?)
}

/// Writes `content` to `file` whole or not at all: to a file of its own
/// first, then put in place, so what reads it now finds the old or the new.
/// That file is this write's alone, named for the process and the write:
/// two runs of one agent launched at once write its files at once, on two
/// threads of one core, and with one name for both the second's rename
/// found the file gone, moved by the first's, and its run failed.
pub(crate) fn whole(file: &Path, content: &[u8]) -> std::io::Result<()> {
    static WRITES: AtomicU64 = AtomicU64::new(0);
    let new = temporary(file, WRITES.fetch_add(1, Ordering::Relaxed));
    let written = std::fs::write(&new, content).and_then(|()| std::fs::rename(&new, file));
    if written.is_err() {
        let _ = std::fs::remove_file(&new);
    }
    written
}

/// Where write `n` of this process puts `file` before it is in place.
fn temporary(file: &Path, n: u64) -> PathBuf {
    let mut name = file.file_name().unwrap_or_default().to_owned();
    name.push(format!(".{}.{n}.new", std::process::id()));
    file.with_file_name(name)
}

/// [`detect`] for each of `agents`, all at once, each on a thread of its own.
pub fn detect_all(agents: &[&'static dyn Agent]) -> Vec<AgentHealth> {
    std::thread::scope(|scope| {
        let checks: Vec<_> = (agents.iter())
            .map(|agent| scope.spawn(|| detect(*agent)))
            .collect();
        let found = checks.into_iter().filter_map(|c| c.join().ok());
        found.collect()
    })
}

/// Writes an agent's files ([`Agent::files`]) below `home`, its folder in
/// the data folder: each whole or not at all, since a run may read it now,
/// and only when it is not there as it should be. A name that would leave
/// the folder is refused.
pub fn keep(home: &Path, files: &[(&'static str, String)]) -> Result<(), String> {
    use std::path::Component;
    for (name, content) in files {
        let inside = Path::new(name)
            .components()
            .all(|part| matches!(part, Component::Normal(_)));
        if name.is_empty() || !inside {
            return Err(format!("{name:?} is no file of the agent's own folder"));
        }
        let file = home.join(name);
        if std::fs::read_to_string(&file).ok().as_deref() == Some(content.as_str()) {
            continue;
        }
        let folder = file.parent().unwrap_or(home);
        std::fs::create_dir_all(folder)
            .and_then(|()| whole(&file, content.as_bytes()))
            .map_err(|e| format!("{} could not be written: {e}", file.display()))?;
    }
    Ok(())
}

/// Runs a probe in `cwd` and returns the arguments it adds to the run;
/// `theirs` as [`super::Start`] has it.
pub fn probe(mut probe: Probe, cwd: &Path, theirs: bool) -> Result<Vec<String>, String> {
    let Some((name, args)) = probe.argv.split_first() else {
        return Err("the check names no program".into());
    };
    // A shim names the agent it found itself.
    let program = match Path::new(name).is_absolute() {
        true => Some(Path::new(name).to_owned()),
        false => crate::terminal::find(name),
    };
    let program =
        program.ok_or_else(|| format!("{name} is not installed: no folder of the PATH has it"))?;
    let spawned = crate::sys::Tree::spawn(
        command(&program, args, theirs)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null()),
    );
    let (mut child, tree) = spawned.map_err(|e| format!("{name} could not run: {e}"))?;
    // Kept open until the end: a server may take its input's end as the
    // sign to stop before it answered.
    let mut input = child.stdin.take();
    if let Some(stdin) = &mut input {
        let _ = stdin.write_all(probe.input.as_bytes());
        let _ = stdin.flush();
    }
    let (lines, read) = mpsc::channel();
    let out = child.stdout.take();
    std::thread::spawn(move || {
        let Some(out) = out else { return };
        for line in BufReader::new(out.take(MAX_OUTPUT)).lines() {
            if lines.send(line).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + PROBE_LIMIT;
    let result = loop {
        match read.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Ok(line)) => {
                if let Some(done) = (probe.read)(&line) {
                    break done;
                }
            }
            Ok(Err(e)) => break Err(format!("{name} could not be read: {e}")),
            Err(RecvTimeoutError::Timeout) => {
                let secs = PROBE_LIMIT.as_secs();
                break Err(format!("{name} did not answer within {secs} s"));
            }
            Err(RecvTimeoutError::Disconnected) => {
                break Err(format!("{name} ended without an answer"));
            }
        }
    };
    drop(input);
    end(&mut child, &tree, theirs);
    result
}

/// Asks `agent`'s tool one question (design §8): `question` on its standard
/// input, in `folder`, which is made if it is not there and holds nothing
/// but the schema's file, within the time its adapter gives it. The answer
/// is the JSON text its adapter reads from what it printed. A `Stop` sent
/// to `heard`, whose other end is `hear`, ends the tool at once.
pub fn ask(
    agent: &dyn Agent,
    how: &Headless,
    question: String,
    schema: &str,
    folder: &Path,
    (hear, heard): (mpsc::Sender<Asked>, mpsc::Receiver<Asked>),
) -> Result<String, Failed> {
    let name = agent.program();
    // Started as the person starts it, without their arguments.
    let start = super::started(agent)?;
    let file = folder.join("schema.json");
    // Written whole or not at all, since another question may read it now.
    if std::fs::read_to_string(&file).ok().as_deref() != Some(schema) {
        std::fs::create_dir_all(folder)
            .and_then(|()| whole(&file, schema.as_bytes()))
            .map_err(|e| format!("its folder could not be written: {e}"))?;
    }
    let schema = Schema {
        text: schema,
        file: &file,
    };
    let spawned = crate::sys::Tree::spawn(
        command(
            &start.program,
            &[&start.head[..], &(how.args)(&schema)].concat(),
            start.theirs,
        )
        .current_dir(folder)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped()),
    );
    let (mut child, tree) = spawned.map_err(|e| format!("{name} could not run: {e}"))?;
    let (input, mut out, err) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let question = (how.stdin)(&question);
    // The question is written beside the reading, so a tool that prints
    // before it has read everything never stops both.
    std::thread::spawn(move || {
        if let Some(mut input) = input {
            let _ = input.write_all(question.as_bytes());
        }
    });
    // The answer is taken as soon as it is whole: a tool may stay on long
    // after it printed it (Claude Code was seen to, for 8 minutes).
    let whole = how.answer;
    std::thread::spawn(move || {
        let (mut printed, mut chunk) = (Vec::new(), [0; 8192]);
        while let Some(Ok(n @ 1..)) = out.as_mut().map(|out| out.read(&mut chunk)) {
            printed.extend_from_slice(&chunk[..n]);
            let large = printed.len() as u64 > MAX_ANSWER;
            if large || whole(&String::from_utf8_lossy(&printed)).is_ok() {
                break;
            }
        }
        let _ = hear.send(Asked::Printed(printed));
    });
    // What it says beside its answer is read to its end, and only the end
    // of it kept: the last line says why a tool gave no answer.
    let said = std::thread::spawn(move || {
        let mut tail = Vec::new();
        if let Some(err) = err {
            for line in BufReader::new(err.take(MAX_OUTPUT))
                .lines()
                .map_while(Result::ok)
            {
                if !line.trim().is_empty() {
                    tail = line.into_bytes();
                }
            }
        }
        String::from_utf8_lossy(&tail).into_owned()
    });
    let printed = match heard.recv_timeout(how.limit) {
        Ok(Asked::Printed(printed)) => Ok(printed),
        Ok(Asked::Stop) | Err(RecvTimeoutError::Disconnected) => {
            Err("it was not waited for".to_owned())
        }
        // In whole seconds: what was left of the time placing waits is a
        // moment short of them.
        Err(RecvTimeoutError::Timeout) => Err(format!(
            "it did not answer within {} s",
            how.limit.as_millis().div_ceil(1000)
        )),
    };
    // It has printed everything or is no longer wanted: either way it ends.
    end(&mut child, &tree, start.theirs);
    let printed = printed?;
    if printed.len() as u64 > MAX_ANSWER {
        return Err("its answer is too large".to_owned().into());
    }
    let printed = String::from_utf8_lossy(&printed);
    (how.answer)(&printed).map_err(|why| {
        let said = said.join().unwrap_or_default();
        // A limit is told in its own words, which say until when.
        match (said.trim(), (how.quota)(&printed, &said)) {
            _ if (how.gone)(&printed, &said) => Failed::Gone,
            ("", Some(back)) => Failed::Limit(back, why),
            (last, Some(back)) => Failed::Limit(back, line(last, 200)),
            ("", None) => Failed::Why(why),
            (last, None) => Failed::Why(format!("{why} ({})", line(last, 200))),
        }
    })
}

/// `program` with `args` in the checks' environment. One that is the
/// person's command (`theirs`) leads a process group of its own on Mac and
/// Linux, which [`end`] ends whole: the agent its program started with it.
fn command(program: &Path, args: &[impl AsRef<std::ffi::OsStr>], theirs: bool) -> Command {
    let mut command = Command::new(program);
    command
        .args(args)
        .env_clear()
        .envs(crate::terminal::environment_of_checks());
    #[cfg(unix)]
    if theirs {
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
    }
    #[cfg(windows)]
    let _ = theirs;
    command
}

/// Runs what starts the agent with `args`, and returns its exit code and
/// what it printed on either output, within [`LIMIT`].
fn output(start: &super::Start, args: &[&str]) -> Result<(Option<i32>, String), String> {
    let args = start
        .head
        .iter()
        .map(String::as_str)
        .chain(args.iter().copied());
    let spawned = crate::sys::Tree::spawn(
        command(&start.program, &args.collect::<Vec<_>>(), start.theirs)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    );
    let (mut child, tree) = spawned.map_err(|e| e.to_string())?;
    let (done, ended) = mpsc::channel();
    for out in [
        child
            .stdout
            .take()
            .map(|o| Box::new(o) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|e| Box::new(e) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let done = done.clone();
        std::thread::spawn(move || {
            let mut text = Vec::new();
            let _ = out.take(MAX_OUTPUT).read_to_end(&mut text);
            let _ = done.send(text);
        });
    }
    drop(done);
    let deadline = Instant::now() + LIMIT;
    let mut text = Vec::new();
    for _ in 0..2 {
        match ended.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(part) => text.extend(part),
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {
                end(&mut child, &tree, start.theirs);
                return Err(format!("it did not answer within {} s", LIMIT.as_secs()));
            }
        }
    }
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                end(&mut child, &tree, start.theirs);
                break None;
            }
        }
    };
    Ok((code, String::from_utf8_lossy(&text).into_owned()))
}

/// Ends the program and, on Windows, what it started: a tool installed as
/// a batch file is the command prompt running the tool. Elsewhere so does a
/// program of the person's (`theirs`), by its process group.
fn end(child: &mut Child, tree: &crate::sys::Tree, theirs: bool) {
    tree.kill();
    #[cfg(unix)]
    if theirs {
        crate::sys::signal_group(child.id(), true);
    }
    #[cfg(windows)]
    let _ = theirs;
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two writes of one file never share the file they write first.
    #[test]
    fn two_writes_of_one_file_have_files_of_their_own() {
        let file = Path::new("/agents/fixture/kept/note.txt");
        let (one, two) = (temporary(file, 1), temporary(file, 2));
        assert_ne!(one, two);
        assert_eq!(one.parent(), file.parent());
    }

    /// An agent's files, written by as many runs as start at once, from
    /// nothing each time: every write succeeds and leaves them whole.
    #[test]
    fn runs_launched_at_once_all_keep_their_agents_files() {
        let home = std::env::temp_dir().join(format!("tt-keep-{}", std::process::id()));
        let files = [("kept/note.txt", "kept for the fixture agent\n".to_owned())];
        let at_once = std::sync::Barrier::new(8);
        for _ in 0..50 {
            let _ = std::fs::remove_dir_all(&home);
            std::thread::scope(|scope| {
                let runs: Vec<_> = (0..8)
                    .map(|_| {
                        scope.spawn(|| {
                            at_once.wait();
                            keep(&home, &files)
                        })
                    })
                    .collect();
                for run in runs {
                    assert_eq!(run.join().unwrap(), Ok(()));
                }
            });
            let kept = std::fs::read_to_string(home.join("kept/note.txt")).unwrap();
            assert_eq!(kept, files[0].1);
            let left = std::fs::read_dir(home.join("kept")).unwrap().count();
            assert_eq!(left, 1, "a write left its own file behind");
        }
        let _ = std::fs::remove_dir_all(&home);
    }
}
