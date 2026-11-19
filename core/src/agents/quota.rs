//! When an agent's tool, asked to place a thought, says the person's plan
//! or key has reached its usage limit, and when it says it is back (design
//! §8). Each adapter knows its own tool's words (`Headless::quota`); these
//! read the time in them, in the forms the tools write it:
//!
//! | Tool | The time |
//! | --- | --- |
//! | Claude Code | `· resets 4pm (Europe/Berlin)`, `· resets 4:30pm`, `· resets Nov 21, 4pm (…)`, `· resets Nov 21, 2027, 4pm`; before 2.1 `usage limit reached\|1760000000` (seconds since 1970) |
//! | Codex | `try again at 4:05 PM.`, `try again at Nov 20th, 2026 4:05 PM.`, `Try again later.` |
//! | Gemini's tools | `reset after 2h30m5s`, `resets in 45 minutes` |
//!
//! A time on a clock is the person's local time, as each tool writes it.
//! A tool that names no time, or one that cannot be read, is asked again
//! in an hour; so is one whose time has passed or lies more than eight
//! days ahead, which no plan's window does.

use tasktap_proto::Time;

/// When a tool said it can be asked again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Back {
    /// It named no time.
    Unsaid,
    /// A moment, in seconds since 1970 (UTC).
    At(i64),
    /// After this many seconds from now.
    After(i64),
    /// A time on the person's clock, in minutes after midnight, on the day
    /// it named (year where it said one, month, day), or else the next
    /// time the clock shows it.
    Clock {
        date: Option<(Option<i64>, u32, u32)>,
        minutes: u32,
    },
}

/// How long a tool that named no time is passed over.
pub const HOUR: i64 = 3600;
/// The latest a tool is passed over until, from now.
const LATEST: i64 = 8 * 86_400;
const DAY: i64 = 86_400;

/// Where a tool's words name the time it is back: before a clock or a date.
const AT: &[&str] = &[
    "resets at ",
    "reset at ",
    "try again at ",
    "retry at ",
    "available at ",
    "resets ",
];
/// Before a length of time.
const IN: &[&str] = &[
    "reset after ",
    "resets after ",
    "reset in ",
    "resets in ",
    "try again in ",
    "retry in ",
    "available in ",
];

/// The time `text` says the tool is back, as any of the tools write it.
pub fn back(text: &str) -> Back {
    // Byte for byte as long as the text, so a place in one is one in the other.
    let lower = text.to_ascii_lowercase();
    if let Some(at) = epoch(&lower) {
        return Back::At(at);
    }
    for marker in AT {
        for (i, _) in lower.match_indices(marker) {
            let rest = &lower[i + marker.len()..];
            if let Some(found) = clock(rest).or_else(|| length(rest).map(Back::After)) {
                return found;
            }
        }
    }
    for marker in IN {
        for (i, _) in lower.match_indices(marker) {
            if let Some(secs) = length(&lower[i + marker.len()..]) {
                return Back::After(secs);
            }
        }
    }
    Back::Unsaid
}

/// When the tool is asked again: the time it named, as of `now` on a clock
/// `offset` seconds ahead of UTC; else in an hour.
pub fn until(back: Back, now: Time, offset: i64) -> Time {
    let now_s = i64::try_from(now.get() / 1000).unwrap_or(i64::MAX / 2);
    let at = match back {
        Back::Unsaid => None,
        Back::At(at) => Some(at),
        Back::After(secs) => Some(now_s + secs),
        Back::Clock {
            date: None,
            minutes,
        } => {
            let midnight = (now_s + offset).div_euclid(DAY) * DAY - offset;
            let at = midnight + i64::from(minutes) * 60;
            Some(if at <= now_s { at + DAY } else { at })
        }
        Back::Clock {
            date: Some((year, month, day)),
            minutes,
        } => {
            let today = (now_s + offset).div_euclid(DAY);
            let on = |year| days(year, month, day) * DAY + i64::from(minutes) * 60 - offset;
            let this = year.unwrap_or_else(|| year_of(today));
            // A date without a year that has passed is next year's.
            Some(match (year, on(this)) {
                (None, at) if at < now_s - DAY => on(this + 1),
                (_, at) => at,
            })
        }
    };
    let at = at.filter(|&at| at > now_s && at <= now_s + LATEST);
    let at = at.unwrap_or(now_s + HOUR);
    Time::new(u64::try_from(at).unwrap_or(0).saturating_mul(1000)).unwrap_or(now)
}

/// Claude Code's words before 2.1: `…usage limit reached|1760000000`.
fn epoch(text: &str) -> Option<i64> {
    let (_, after) = text.split_once("limit reached|")?;
    let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
    (9..=11)
        .contains(&digits.len())
        .then(|| digits.parse().ok())?
}

/// The words of a text, split at spaces (a narrow one too) and commas,
/// each with what follows it.
fn tokens(text: &str) -> Vec<&str> {
    let gap = |c: char| c.is_whitespace() || c == ',' || c == '\u{202f}';
    text.split(gap).filter(|t| !t.is_empty()).take(8).collect()
}

/// A clock time at the start of `text`, with the day before it where one is
/// named: `4pm`, `4:30 pm`, `16:00`, `nov 21 4pm`, `nov 20th 2026 4:05 pm`.
fn clock(text: &str) -> Option<Back> {
    let words = tokens(text);
    let mut at = 0;
    let mut date = None;
    if let Some(month) = words.first().and_then(|w| month(w)) {
        let day = words
            .get(1)
            .and_then(|w| number(w.trim_end_matches(['s', 't', 'n', 'd', 'r', 'h'])));
        let day = day.filter(|d| (1..=31).contains(d))?;
        at = 2;
        let year = words.get(2).and_then(|w| number(w)).filter(|y| *y >= 1970);
        if year.is_some() {
            at = 3;
        }
        if words.get(at) == Some(&"at") {
            at += 1;
        }
        date = Some((year.map(i64::from), month, day));
    }
    let time = words.get(at)?;
    // "4:30pm", or "4:30" with "pm" as the next word.
    let (time, half) = match time.find(['a', 'p']) {
        Some(i) => (&time[..i], Some(&time[i..])),
        None => (*time, words.get(at + 1).copied()),
    };
    let half = half.map(|h| h.trim_end_matches(['.', ')', ';']));
    let half = match half {
        Some("am" | "a.m") => Some(false),
        Some("pm" | "p.m") => Some(true),
        _ => None,
    };
    let time = time.trim_end_matches('.');
    let (hour, minute) = match time.split_once(':') {
        Some((h, m)) => (number(h)?, number(m.get(..2)?)?),
        None => (number(time)?, 0),
    };
    let hour = match half {
        Some(pm) if (1..=12).contains(&hour) => hour % 12 + if pm { 12 } else { 0 },
        // A clock of 24 hours always writes the minutes.
        None if hour < 24 && time.contains(':') => hour,
        _ => return None,
    };
    (minute < 60).then_some(Back::Clock {
        date,
        minutes: hour * 60 + minute,
    })
}

/// A length of time at the start of `text`: `2h30m5s`, `2 hours 5 minutes`,
/// `45 min`, in seconds.
fn length(text: &str) -> Option<i64> {
    let mut total = 0;
    let mut found = false;
    let mut rest = text.trim_start();
    loop {
        let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        if digits == 0 {
            break;
        }
        let n: i64 = rest[..digits].parse().ok()?;
        let after = rest[digits..].trim_start();
        let unit = after.len()
            - after
                .trim_start_matches(|c: char| c.is_ascii_alphabetic())
                .len();
        let secs = match &after[..unit] {
            "d" | "day" | "days" => DAY,
            "h" | "hr" | "hrs" | "hour" | "hours" => 3600,
            "m" | "min" | "mins" | "minute" | "minutes" => 60,
            "s" | "sec" | "secs" | "second" | "seconds" => 1,
            _ => break,
        };
        total += n.checked_mul(secs)?;
        found = true;
        rest = after[unit..]
            .trim_start_matches([' ', ','])
            .trim_start_matches("and ");
    }
    found.then_some(total)
}

/// A month by its name or the first three letters of it, 1 to 12.
fn month(word: &str) -> Option<u32> {
    const MONTHS: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let word = word.trim_end_matches('.');
    let at = MONTHS
        .iter()
        .position(|m| word.len() >= 3 && word.starts_with(m))?;
    u32::try_from(at + 1).ok()
}

fn number(word: &str) -> Option<u32> {
    (!word.is_empty() && word.len() <= 4 && word.bytes().all(|b| b.is_ascii_digit()))
        .then(|| word.parse().ok())?
}

/// Days since 1970-01-01 of a date in the proleptic Gregorian calendar.
fn days(year: i64, month: u32, day: u32) -> i64 {
    let (m, d) = (i64::from(month), i64::from(day));
    let y = if m <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

/// The year of a day counted from 1970-01-01.
fn year_of(day: i64) -> i64 {
    let z = day + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let march = (5 * doy + 2) / 153;
    yoe + era * 400 + i64::from(march >= 10)
}
