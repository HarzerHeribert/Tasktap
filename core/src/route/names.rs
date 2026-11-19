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
