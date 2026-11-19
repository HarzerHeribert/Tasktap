//! Names as written and as speech writes them (docs/projects-design.md,
//! "Placing"), and the words a thought shares with a line about a project.
//!
//! A project's name is its parts (`tidepool-mobile`: tidepool, mobile;
//! `ledgerAPI`: ledger, api) and those parts joined (`tidepoolmobile`).
//! A stretch of one to five words of a thought says a name:
//!
//! | How | When | Example |
//! | --- | --- | --- |
//! | written | its words are the name's parts | "tidepool mobile", "tidepool-mobile" |
//! | joined | its words joined are the parts joined | "cue grid", "ledger A P I", "tidepoolmobile" |
//! | sounds | two or more words, not opening on a small word, joined sound as the name does by a rough English key, of about its length | "queue grid", "pie right", "key cast" |
//! | near | one word one letter from a one-part name of five letters or more | "carrier" for `farrier` |
//!
//! A near name is never a start: it is asked about. Nothing here knows
//! the projects; `route.rs` decides with what it finds.
//!
//! Where no name is said for certain, [`evidence`] gives each project what
//! only it has of a thought's words: its whole name nearly said ("vexa widget"
//! for `vexa-widgets`), a word only its name has, a word only its line has;
//! `route.rs` starts in one that clearly leads.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

/// How a name was said, the weakest first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum How {
    Near,
    Sounds,
    Joined,
    Written,
}

/// Where a thought says a name, and how.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Said {
    pub how: How,
    /// The words, by their place among the thought's words.
    pub at: Range<usize>,
    /// The same words as bytes of the thought.
    pub span: Range<usize>,
    /// Characters of the name's parts joined: the longer name wins.
    pub len: usize,
}

/// A thought's words, lower-cased, and where each is in it.
#[derive(Clone, Debug, Default)]
pub struct Words {
    pub words: Vec<String>,
    pub spans: Vec<Range<usize>>,
    /// Whether a word is joined to the next by an underscore alone: then
    /// the two are one word of the text (`tidepool_v2`), and no name is
    /// said by one of them without the other.
    pub glued: Vec<bool>,
}

pub fn words(text: &str) -> Words {
    let mut w = Words::default();
    let mut start = None;
    for (i, c) in text
        .char_indices()
        .chain(std::iter::once((text.len(), ' ')))
    {
        match (c.is_alphanumeric(), start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                w.words.push(text[s..i].to_lowercase());
                w.spans.push(s..i);
                let rest = &text[i..];
                let glue = rest.starts_with('_') && rest[1..].starts_with(char::is_alphanumeric);
                w.glued.push(glue);
                start = None;
            }
            _ => {}
        }
    }
    w
}

/// A name's parts: split at what is not a letter or digit, where a small
/// letter meets a capital, and where letters meet digits; lower-cased.
pub fn parts(name: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut part = String::new();
    let mut last: Option<char> = None;
    for c in name.chars() {
        if !c.is_alphanumeric() {
            if !part.is_empty() {
                parts.push(std::mem::take(&mut part));
            }
            last = None;
            continue;
        }
        let split = last.is_some_and(|l| {
            (l.is_lowercase() && c.is_uppercase()) || (l.is_alphabetic() != c.is_alphabetic())
        });
        if split && !part.is_empty() {
            parts.push(std::mem::take(&mut part));
        }
        part.extend(c.to_lowercase());
        last = Some(c);
    }
    if !part.is_empty() {
        parts.push(part);
    }
    parts
}

/// A rough key of how a word sounds in English: its first sound, then its
/// consonants, with the spellings of one sound made one.
pub fn sound(word: &str) -> String {
    let mut s: String = word
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    for (from, to) in [
        ("wr", "r"),
        ("kn", "n"),
        ("wh", "w"),
        ("ps", "s"),
        ("gn", "n"),
    ] {
        if let Some(rest) = s.strip_prefix(from) {
            s = format!("{to}{rest}");
        }
    }
    for (from, to) in [
        ("tch", "ch"),
        ("sch", "sk"),
        ("ph", "f"),
        ("gh", ""),
        ("ck", "k"),
        ("qu", "k"),
        ("q", "k"),
        ("x", "ks"),
        ("dg", "j"),
        ("z", "s"),
    ] {
        s = s.replace(from, to);
    }
    let chars: Vec<char> = s.chars().collect();
    let mut key = String::new();
    for (i, &c) in chars.iter().enumerate() {
        let c = match c {
            'c' if matches!(chars.get(i + 1), Some('e' | 'i' | 'y')) => 's',
            'c' => 'k',
            c => c,
        };
        let vowel = matches!(c, 'a' | 'e' | 'i' | 'o' | 'u' | 'y');
        let c = match (i, vowel) {
            (0, true) => 'a',
            (_, true) => continue,
            (_, false) if i > 0 && matches!(c, 'h' | 'w') => continue,
            _ => c,
        };
        if !key.ends_with(c) {
            key.push(c);
        }
    }
    key
}

/// Whether two words are one edit apart: a letter added, dropped, changed,
/// or two side by side swapped.
pub fn one_off(a: &str, b: &str) -> bool {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a == b || a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    let first = a
        .iter()
        .zip(&b)
        .position(|(x, y)| x != y)
        .unwrap_or(a.len().min(b.len()));
    match a.len().cmp(&b.len()) {
        std::cmp::Ordering::Equal => {
            a[first + 1..] == b[first + 1..]
                || (first + 1 < a.len()
                    && a[first] == b[first + 1]
                    && a[first + 1] == b[first]
                    && a[first + 2..] == b[first + 2..])
        }
        std::cmp::Ordering::Less => a[first..] == b[first + 1..],
        std::cmp::Ordering::Greater => a[first + 1..] == b[first..],
    }
}

/// Small words a stretch said as a name never opens on.
const SMALL: &[&str] = &[
    "a", "an", "the", "in", "on", "to", "of", "for", "my", "and", "is", "it", "at", "by", "with",
    "from", "this", "that", "or", "be", "as", "so", "up", "i",
];

/// Everywhere the words say `name`.
pub fn said(w: &Words, name: &str) -> Vec<Said> {
    let p = parts(name);
    if p.is_empty() {
        return Vec::new();
    }
    let joined: String = p.concat();
    let len = joined.chars().count();
    let key = sound(&joined);
    let mut found = Vec::new();
    for start in 0..w.words.len() {
        for k in 1..=5.min(w.words.len() - start) {
            let win = &w.words[start..start + k];
            let cat: String = win.concat();
            let n = cat.chars().count();
            if n > len + 4 {
                break;
            }
            // Never part of one word of the text.
            if (start > 0 && w.glued[start - 1]) || w.glued[start + k - 1] {
                continue;
            }
            let how = if win == p.as_slice() {
                Some(How::Written)
            } else if cat == joined {
                Some(How::Joined)
            } else if k >= 2
                && len >= 5
                && key.chars().count() >= 3
                && n.abs_diff(len) <= 2.max(len / 4)
                && !SMALL.contains(&win[0].as_str())
                && sound(&cat) == key
            {
                Some(How::Sounds)
            } else if k == 1 && p.len() == 1 && len >= 5 && n >= 4 && one_off(&cat, &joined) {
                Some(How::Near)
            } else {
                None
            };
            if let Some(how) = how {
                let span = w.spans[start].start..w.spans[start + k - 1].end;
                found.push(Said {
                    how,
                    at: start..start + k,
                    span,
                    len,
                });
            }
        }
    }
    found
}

/// Where the words of the language are: the system's dictionary (on a Mac
/// Webster's word list and its list of word groups, elsewhere
/// `/usr/share/dict/words`), or the files `TASKTAP_WORDS` names (`:`
/// between them). Read when a name written apart, or a word of a name a
/// thought nearly says, asks whether its words are ordinary words: a few
/// milliseconds, and never kept; only its answers for the words asked are,
/// a few thousand at most.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lexicon(pub Vec<std::path::PathBuf>);

impl Default for Lexicon {
    fn default() -> Lexicon {
        if let Some(named) = std::env::var_os("TASKTAP_WORDS") {
            return Lexicon(std::env::split_paths(&named).collect());
        }
        let mac = ["/usr/share/dict/web2", "/usr/share/dict/web2a"];
        let paths = match std::path::Path::new(mac[0]).is_file() {
            true => mac.to_vec(),
            false => vec!["/usr/share/dict/words"],
        };
        Lexicon(paths.into_iter().map(std::path::PathBuf::from).collect())
    }
}

/// Names of well-known tools, services and agents: ordinary words of a
/// person's work, which a thought says of the tool as often as of a
/// project named after it ("jira tickets", "the figma file", "tmux key
/// bindings"). Never made up for a name, whatever an old dictionary lacks.
const TOOLS: &[&str] = &[
    "ableton",
    "aider",
    "airtable",
    "alacritty",
    "android",
    "angular",
    "ansible",
    "anthropic",
    "antigravity",
    "arduino",
    "asana",
    "aws",
    "azure",
    "bitbucket",
    "bitwarden",
    "blender",
    "bluesky",
    "chatgpt",
    "chromium",
    "claude",
    "cline",
    "cloudflare",
    "codex",
    "confluence",
    "copilot",
    "cursor",
    "cypress",
    "datadog",
    "davinci",
    "debian",
    "deepseek",
    "deno",
    "devin",
    "discord",
    "django",
    "docker",
    "dropbox",
    "eslint",
    "evernote",
    "facebook",
    "fastapi",
    "fedora",
    "figma",
    "firebase",
    "firefox",
    "flutter",
    "framer",
    "gcp",
    "gemini",
    "ghostty",
    "github",
    "gitlab",
    "gmail",
    "godot",
    "golang",
    "goodreads",
    "grafana",
    "grok",
    "heroku",
    "homebrew",
    "homekit",
    "hubspot",
    "icloud",
    "instagram",
    "intellij",
    "ios",
    "ipados",
    "iterm",
    "javascript",
    "jellyfin",
    "jenkins",
    "jira",
    "jupyter",
    "kafka",
    "keynote",
    "kibana",
    "kotlin",
    "kubectl",
    "kubernetes",
    "laravel",
    "lastfm",
    "lastpass",
    "letterboxd",
    "lightroom",
    "linkedin",
    "linux",
    "llama",
    "macos",
    "mailchimp",
    "mastodon",
    "minecraft",
    "miro",
    "mistral",
    "mongodb",
    "mysql",
    "netflix",
    "netlify",
    "neovim",
    "nextjs",
    "nginx",
    "nixos",
    "nodejs",
    "notion",
    "npm",
    "nuxt",
    "nvim",
    "obsidian",
    "ollama",
    "onenote",
    "openai",
    "opencode",
    "openvpn",
    "outlook",
    "paypal",
    "perplexity",
    "photoshop",
    "playwright",
    "plex",
    "pnpm",
    "postgres",
    "postgresql",
    "postman",
    "powerpoint",
    "prettier",
    "prometheus",
    "puppeteer",
    "pycharm",
    "python",
    "qwen",
    "raycast",
    "redis",
    "reddit",
    "retool",
    "roblox",
    "rustc",
    "safari",
    "salesforce",
    "sentry",
    "shopify",
    "slack",
    "soundcloud",
    "spotify",
    "sqlite",
    "steam",
    "storybook",
    "strava",
    "stripe",
    "substack",
    "supabase",
    "svelte",
    "sveltekit",
    "swiftui",
    "synology",
    "tailscale",
    "tailwind",
    "tauri",
    "telegram",
    "terraform",
    "tiktok",
    "tmux",
    "todoist",
    "traefik",
    "trello",
    "twitch",
    "twitter",
    "typescript",
    "ubuntu",
    "vercel",
    "vim",
    "vite",
    "vscode",
    "webflow",
    "webpack",
    "webstorm",
    "whatsapp",
    "windsurf",
    "wireguard",
    "wordpress",
    "xcode",
    "youtube",
    "zapier",
    "zendesk",
    "zsh",
];

/// Ordinary words an old dictionary lacks.
const NEWER: &[&str] = &[
    "app",
    "apps",
    "backend",
    "blog",
    "codebase",
    "dashboard",
    "database",
    "dataset",
    "doc",
    "docs",
    "download",
    "email",
    "firmware",
    "frontend",
    "homepage",
    "inbox",
    "internet",
    "laptop",
    "login",
    "online",
    "password",
    "plugin",
    "podcast",
    "repo",
    "sidebar",
    "smartphone",
    "software",
    "toolbar",
    "upload",
    "username",
    "webhook",
    "website",
    "wiki",
    "workflow",
];

impl Lexicon {
    /// Whether every one of `words` (lower-cased) is an ordinary word, as
    /// it is or with a common ending taken off ("notes", "files"). With no
    /// dictionary to read, every word is taken for one: a name then asks.
    pub fn ordinary(&self, words: &[&str]) -> bool {
        self.each(words).into_iter().all(|o| o)
    }

    /// For each of `words`, whether it is an ordinary word ([`Lexicon::ordinary`]).
    pub fn each(&self, words: &[&str]) -> Vec<bool> {
        let forms = |w: &str| -> Vec<String> {
            let mut all = vec![w.to_owned()];
            for (end, to) in [("ies", "y"), ("es", ""), ("s", ""), ("ed", ""), ("ing", "")] {
                if let Some(head) = w.strip_suffix(end)
                    && head.chars().count() >= 2
                {
                    all.push(format!("{head}{to}"));
                }
            }
            all
        };
        let mut found: Vec<bool> = (words.iter())
            .map(|w| NEWER.contains(w) || COMMON.contains(w) || TOOLS.contains(w))
            .collect();
        // What was read for these files already answers.
        let open: Vec<usize> = ANSWERED.with(|a| {
            let mut a = a.borrow_mut();
            if a.0 != self.0 || a.1.len() > 4096 {
                *a = (self.0.clone(), Default::default());
            }
            let mut open = Vec::new();
            for i in 0..words.len() {
                match a.1.get(words[i]) {
                    _ if found[i] => {}
                    Some(known) => found[i] = *known,
                    None => open.push(i),
                }
            }
            open
        });
        let mut wanted: std::collections::HashMap<String, Vec<usize>> = Default::default();
        for i in open.iter().copied() {
            for f in forms(words[i]) {
                wanted.entry(f).or_default().push(i);
            }
        }
        if wanted.is_empty() {
            return found;
        }
        let mut read = false;
        for path in &self.0 {
            let Ok(text) = std::fs::read_to_string(path) else {
                continue;
            };
            read = true;
            // A word, or each word of a word group ("box spring"), in lower case.
            for entry in text.lines().flat_map(|l| l.split([' ', '-'])) {
                if let Some(at) = wanted.get(entry) {
                    for i in at {
                        found[*i] = true;
                    }
                }
            }
        }
        if !read {
            return vec![true; words.len()];
        }
        ANSWERED.with(|a| {
            let mut a = a.borrow_mut();
            for i in open {
                a.1.insert(words[i].to_owned(), found[i]);
            }
        });
        found
    }
}

thread_local! {
    /// The answers the dictionary gave, for the files they were read from:
    /// a thought is weighed several times while it is placed, and a field's
    /// hint at every key. Words only, at most a few thousand; never the
    /// dictionary.
    static ANSWERED: std::cell::RefCell<(Vec<std::path::PathBuf>, std::collections::HashMap<String, bool>)> =
        Default::default();
}

/// The forms a word may take as a name's near form: it, and it singular
/// ("kits": kit, "boxes": box, "stories": story), never shorter than three
/// letters.
fn singulars(word: &str) -> Vec<String> {
    let mut all = vec![word.to_owned()];
    for (end, to) in [("ies", "y"), ("es", ""), ("s", "")] {
        if let Some(head) = word.strip_suffix(end) {
            let form = format!("{head}{to}");
            if form.chars().count() >= 3 && !all.contains(&form) {
                all.push(form);
            }
        }
    }
    all
}

/// Whether two words are one in a name's near form: the same, or one the
/// other's plural ("kit" and "kits").
pub fn alike(a: &str, b: &str) -> bool {
    let fa = singulars(a);
    singulars(b).iter().any(|f| fa.contains(f))
}

/// A project as a thought's evidence weighs it: its names and its line.
pub struct Known<'a> {
    pub names: Vec<&'a str>,
    pub about: &'a str,
}

/// One piece of evidence a thought gives a project and no other.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Piece {
    /// Its whole name, nearly: as written, joined, or a part singular for
    /// plural ("vexa widget" for `vexa-widgets`), with a word made up for it.
    Name,
    /// A word of its name no other project's name has, made up for it
    /// ("zentrix" for `zentrix-sync`).
    Word,
    /// A word of its line that no other project's line or name has
    /// ("widgetpack").
    About,
}

/// A piece of evidence, and the words of the thought that give it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Evidence {
    pub piece: Piece,
    pub at: Range<usize>,
}

/// Where the words say `name` whole, nearly: each word alike each of its
/// parts, or the words joined alike its parts joined ([`alike`]: "vexa
/// widget" and "vexawidget" for `vexa-widgets`); never part of one word of
/// the text.
pub fn nearly(w: &Words, name: &str) -> Vec<Range<usize>> {
    let parts = parts(name);
    let joined: String = parts.concat();
    let n = w.words.len();
    let mut found = Vec::new();
    if joined.chars().count() < 3 {
        return found;
    }
    for start in 0..n {
        for len in 1..=5.min(n - start) {
            if (start > 0 && w.glued[start - 1]) || w.glued[start + len - 1] {
                continue;
            }
            let win = &w.words[start..start + len];
            let each = len == parts.len() && win.iter().zip(&parts).all(|(a, b)| alike(a, b));
            if each || alike(&win.concat(), &joined) {
                found.push(start..start + len);
            }
        }
    }
    found
}

/// For each project, the pieces of evidence the thought's words give it and
/// no other project: its whole name nearly said, words only its name has,
/// words only its line has; each word of the thought in one piece at most,
/// and each piece once however often it is said. A word for which `none`
/// is true counts for nothing (an everyday word, an agent's name), and so
/// does one that is in more than one project's names or lines. A name
/// said only in ordinary words of the language ([`Lexicon`]) is no
/// evidence: "harbor master" is as often meant as words.
pub fn evidence(
    w: &Words,
    known: &[Known],
    lexicon: &Lexicon,
    none: &dyn Fn(&str) -> bool,
) -> Vec<Vec<Evidence>> {
    let n = w.words.len();
    let word = |i: usize| w.words[i].as_str();
    let alpha = |x: &str| x.chars().count() >= 3 && x.chars().all(char::is_alphabetic);
    let counts = |x: &str| alpha(x) && !none(x) && !COMMON.contains(&x) && !SMALL.contains(&x);
    let mut names: Vec<Vec<Range<usize>>> = (known.iter())
        .map(|p| p.names.iter().flat_map(|name| nearly(w, name)).collect())
        .collect();
    // The words of each project's name, by the forms they take, and the
    // projects whose names have each.
    let mut by_part: BTreeMap<String, BTreeSet<usize>> = BTreeMap::new();
    for (k, p) in known.iter().enumerate() {
        for part in p.names.iter().flat_map(|n| parts(n)) {
            for f in singulars(&part) {
                by_part.entry(f).or_default().insert(k);
            }
        }
    }
    let whose_part = |x: &str| -> BTreeSet<usize> {
        (singulars(x).iter())
            .filter_map(|f| by_part.get(f))
            .flatten()
            .copied()
            .collect()
    };
    // Which words are made up: asked of the dictionary once.
    let mut wanted: Vec<&str> = Vec::new();
    for at in names.iter().flatten() {
        wanted.extend(w.words[at.clone()].iter().map(String::as_str));
    }
    wanted.extend((0..n).map(word).filter(|x| whose_part(x).len() == 1));
    wanted.retain(|x| counts(x));
    wanted.sort_unstable();
    wanted.dedup();
    let known_words = match wanted.is_empty() {
        true => Vec::new(),
        false => lexicon.each(&wanted),
    };
    let made_up = |x: &str| {
        counts(x) && (wanted.iter().position(|y| *y == x)).is_some_and(|i| !known_words[i])
    };
    // A name counts said with a word made up for it; one said in the same
    // words as another's is neither's.
    for at in names.iter_mut() {
        at.retain(|at| w.words[at.clone()].iter().any(|x| made_up(x)));
    }
    let overlap = |a: &Range<usize>, b: &Range<usize>| a.start < b.end && b.start < a.end;
    let shared = |k: usize, a: &Range<usize>| {
        (0..known.len()).any(|o| o != k && names[o].iter().any(|b| overlap(a, b)))
    };
    // The stems of each project's line, and of its line and names together:
    // a word of a line counts only where no other project has it.
    let lines: Vec<BTreeSet<String>> = (known.iter())
        .map(|p| telling(p.about).into_keys().collect())
        .collect();
    let mut owners: BTreeMap<String, BTreeSet<usize>> = BTreeMap::new();
    for (k, p) in known.iter().enumerate() {
        let own = (p.names.iter())
            .flat_map(|n| parts(n))
            .map(|x| stem(&x))
            .chain(lines[k].iter().cloned());
        for s in own {
            owners.entry(s).or_default().insert(k);
        }
    }
    let mut out: Vec<Vec<Evidence>> = vec![Vec::new(); known.len()];
    for k in 0..known.len() {
        let mut used: Vec<usize> = Vec::new();
        let mut said: Vec<String> = Vec::new();
        let take = |at: &Range<usize>, used: &mut Vec<usize>, said: &mut Vec<String>| {
            used.extend(at.clone());
            said.extend(w.words[at.clone()].iter().map(|x| stem(x)));
        };
        // Its name, once: the first place it is said.
        if let Some(at) = names[k].iter().find(|at| !shared(k, at)) {
            take(at, &mut used, &mut said);
            out[k].push(Evidence {
                piece: Piece::Name,
                at: at.clone(),
            });
        }
        let mut parts_said: Vec<String> = Vec::new();
        for i in 0..n {
            let x = word(i);
            let mine = whose_part(x);
            if !used.contains(&i) && mine.len() == 1 && mine.contains(&k) && made_up(x) {
                let one = singulars(x).pop().unwrap_or_default();
                if !parts_said.contains(&one) {
                    parts_said.push(one);
                    take(&(i..i + 1), &mut used, &mut said);
                    out[k].push(Evidence {
                        piece: Piece::Word,
                        at: i..i + 1,
                    });
                }
            }
        }
        for i in 0..n {
            let x = word(i);
            let s = stem(x);
            let only = owners
                .get(&s)
                .is_some_and(|o| o.len() == 1 && o.contains(&k));
            if !used.contains(&i)
                && x.chars().count() >= 4
                && counts(x)
                && lines[k].contains(&s)
                && only
                && !said.contains(&s)
            {
                take(&(i..i + 1), &mut used, &mut said);
                out[k].push(Evidence {
                    piece: Piece::About,
                    at: i..i + 1,
                });
            }
        }
        out[k].sort_by_key(|e| e.at.start);
    }
    out
}

/// Common words that say nothing of where work belongs.
const COMMON: &[&str] = &[
    "about", "add", "after", "again", "all", "also", "an", "and", "any", "are", "as", "at", "be",
    "been", "but", "by", "can", "change", "check", "could", "do", "does", "done", "fix", "for",
    "from", "get", "has", "have", "how", "if", "in", "into", "is", "it", "its", "just", "let",
    "like", "look", "make", "me", "more", "my", "need", "needs", "new", "not", "now", "of", "on",
    "one", "or", "our", "out", "please", "put", "should", "show", "so", "some", "than", "that",
    "the", "their", "them", "then", "there", "these", "they", "this", "to", "too", "try", "two",
    "up", "use", "want", "was", "way", "we", "what", "when", "where", "which", "while", "who",
    "why", "will", "with", "would", "you", "your", "work", "working", "thing", "things", "bug",
    "wrong", "right", "instead", "first", "last", "time", "only", "same", "still", "very",
];

/// A word as a description compares it: lower-cased, without a common
/// ending, so "invoices" meets "invoice" and "exporting" meets "export".
pub fn stem(word: &str) -> String {
    let w = word.to_lowercase();
    for end in ["ing", "ers", "ies", "es", "ed", "er", "s"] {
        if let Some(head) = w.strip_suffix(end)
            && head.chars().count() >= 4
        {
            return match end {
                "ies" => format!("{head}y"),
                _ => head.to_owned(),
            };
        }
    }
    w
}

/// The words of a text a description compares: stems of words of three
/// letters or more that are not common, each with its first form.
pub fn telling(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for w in words(text).words {
        if w.chars().count() >= 3
            && !COMMON.contains(&w.as_str())
            && !w.chars().all(char::is_numeric)
        {
            out.entry(stem(&w)).or_insert(w);
        }
    }
    out
}

/// How well each description fits a thought: the rarer a shared word among
/// the descriptions, the more it counts. Returns each description's score
/// and the thought's words it shares, in the thought's order.
pub fn fit(thought: &str, descriptions: &[String]) -> Vec<(f64, Vec<String>)> {
    let asked = telling(thought);
    let docs: Vec<BTreeSet<String>> = (descriptions.iter())
        .map(|d| telling(d).into_keys().collect())
        .collect();
    let n = docs.len().max(1) as f64;
    let order: Vec<String> = words(thought).words.iter().map(|w| stem(w)).collect();
    (docs.iter())
        .map(|doc| {
            let mut shared: Vec<&String> = asked.keys().filter(|s| doc.contains(*s)).collect();
            shared.sort_by_key(|s| order.iter().position(|o| o == *s));
            let score = (shared.iter())
                .map(|s| {
                    let df = docs.iter().filter(|d| d.contains(*s)).count().max(1) as f64;
                    (1.0 + n / df).ln()
                })
                .sum();
            let first = shared.iter().filter_map(|s| asked.get(*s).cloned());
            (score, first.collect())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spoken_names_sound_alike() {
        for (heard, name) in [
            ("queue grid", "cuegrid"),
            ("pie right", "pyrite"),
            ("key cast", "quaycast"),
            ("ren mail", "wrenmail"),
            ("harbour master", "harbormaster"),
        ] {
            let found = said(&words(heard), name);
            assert!(
                found.iter().any(|s| s.how >= How::Sounds),
                "{heard} for {name}: {found:?}"
            );
        }
        for (heard, name) in [
            ("the part", "pyrite"),
            ("make the build", "kiln"),
            ("a cue", "cuegrid"),
        ] {
            let found = said(&words(heard), name);
            assert!(found.is_empty(), "{heard} is not {name}: {found:?}");
        }
    }

    #[test]
    fn a_tools_name_is_an_ordinary_word() {
        let fixture =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/words.txt");
        let words = Lexicon(vec![fixture]);
        // Neither is in the dictionary; the tool's name is still no word
        // made up for a name.
        assert_eq!(
            words.each(&["jira", "tmux", "zentrix"]),
            [true, true, false]
        );
        // With no dictionary to read, every word is ordinary: nothing leads.
        let none = Lexicon(vec!["/nonexistent/words".into()]);
        assert_eq!(none.each(&["zentrix", "vexa"]), [true, true]);
    }

    #[test]
    fn a_near_form_of_a_name_is_it_one_or_many() {
        for (a, b) in [
            ("kit", "kits"),
            ("boxes", "box"),
            ("stories", "story"),
            ("caches", "cache"),
        ] {
            assert!(alike(a, b) && alike(b, a), "{a} {b}");
        }
        for (a, b) in [("kit", "kite"), ("bus", "bu"), ("kiln", "kilt")] {
            assert!(!alike(a, b), "{a} {b}");
        }
    }

    #[test]
    fn names_split_as_written_and_joined() {
        assert_eq!(parts("tidepool-mobile"), ["tidepool", "mobile"]);
        assert_eq!(parts("ledgerAPI"), ["ledger", "api"]);
        assert_eq!(parts("pyrite2"), ["pyrite", "2"]);
        let joined = said(&words("ledger A P I returns 404"), "ledger-api");
        assert!(
            joined
                .iter()
                .any(|s| s.how == How::Joined && s.at == (0..4))
        );
        let near = said(&words("the carrier page"), "farrier");
        assert_eq!(near.first().map(|s| s.how), Some(How::Near));
        assert!(one_off("ab", "ba") && one_off("kiln", "kilns") && !one_off("kiln", "kiln"));
    }
}
