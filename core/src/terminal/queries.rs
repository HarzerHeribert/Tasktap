//! The questions a program asks its terminal (design §9), answered by the
//! core while nobody else would. A program may ask its terminal what it is
//! (device attributes), where the cursor is, and which colors it draws with,
//! and wait for the answer before it goes on. A client attached to the
//! terminal answers what it sees live, as a terminal does, and mutes what it
//! replays; so while no client is attached nobody would answer, and the core
//! does, with the answers a terminal gives. Once a client is attached,
//! everything after its `live` mark is its to answer, and the core is quiet,
//! so an answer is never given twice. The core keeps no screen: the cursor
//! is said to be at the top left, where it is when a program starts.
//!
//! The same scan answers the one question the Windows console asks itself
//! before it shows anything (where the cursor is, since portable-pty asks
//! it to inherit the cursor), always, and takes it out of the output, so no
//! client sees it.

use std::ops::Range;

/// The colors the core says a terminal draws with: the dark theme's.
const FOREGROUND: &str = "rgb:e4e4/e6e6/eded";
const BACKGROUND: &str = "rgb:1111/1313/1818";
/// What the core says it is, as xterm says it: a VT220 with color.
const PRIMARY: &[u8] = b"\x1b[?62;22c";
const SECONDARY: &[u8] = b"\x1b[>0;276;0c";
const CURSOR: &[u8] = b"\x1b[1;1R";
/// No question the core answers is longer; a longer sequence is none.
const LONGEST: usize = 16;
/// Bytes of output within which the Windows console asks its own question.
#[cfg(windows)]
const CONSOLE: u64 = 64;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;

/// Where the scan is: in plain output, or inside a sequence since its ESC.
#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Ground,
    Escape,
    Csi,
    Osc,
    /// An ESC inside an OSC: `\` ends it.
    OscEscape,
}

/// The scan of one terminal's output, which carries across chunks.
pub struct Queries {
    state: State,
    /// The sequence so far, from its ESC, while it may still be a question.
    seq: Vec<u8>,
    /// Bytes scanned.
    offset: u64,
    /// The offset of the sequence's ESC.
    #[cfg(windows)]
    at: u64,
    /// The console's own question is still to come.
    #[cfg(windows)]
    console: bool,
}

/// What a chunk of output asked.
#[derive(Default)]
pub struct Found {
    /// The answers to type, in order.
    pub answers: Vec<u8>,
    /// Where in the chunk the console's own question is, to be taken out.
    pub hidden: Option<Range<usize>>,
}

impl Queries {
    pub fn new() -> Queries {
        Queries {
            state: State::Ground,
            seq: Vec::new(),
            offset: 0,
            #[cfg(windows)]
            at: 0,
            #[cfg(windows)]
            console: true,
        }
    }

    /// Scans the next chunk of output. `attended` when a client is
    /// attached: it answers the program's questions, and the core does not.
    /// `room` is how many bytes of answers the core may still type: a
    /// question whose answer is longer than what is left of it gets none.
    pub fn scan(&mut self, chunk: &[u8], attended: bool, room: usize) -> Found {
        let mut found = Found::default();
        let base = self.offset;
        let mut i = 0;
        while i < chunk.len() {
            if self.state == State::Ground {
                // Plain output: on to the next escape.
                match chunk[i..].iter().position(|&b| b == ESC) {
                    Some(n) => i += n,
                    None => break,
                }
            }
            #[cfg(windows)]
            if chunk[i] == ESC && self.state != State::Osc {
                self.at = base + i as u64;
            }
            if let Some(question) = self.step(chunk[i]) {
                self.answer(question, attended, room, base, i + 1, &mut found);
            }
            i += 1;
        }
        self.offset += chunk.len() as u64;
        found
    }

    /// Takes one byte; a question once its last byte has come.
    fn step(&mut self, b: u8) -> Option<Question> {
        if b == ESC && self.state != State::Osc {
            self.state = State::Escape;
            self.seq.clear();
            self.seq.push(b);
            return None;
        }
        self.seq.push(b);
        let (state, question) = match (self.state, b) {
            (State::Escape, b'[') => (State::Csi, None),
            (State::Escape, b']') => (State::Osc, None),
            (State::Csi, 0x20..=0x3f) => (State::Csi, None),
            (State::Csi, 0x40..=0x7e) => (State::Ground, csi(&self.seq[2..])),
            (State::Osc, ESC) => (State::OscEscape, None),
            (State::Osc, BEL) => (State::Ground, osc(&self.seq[2..self.seq.len() - 1], BEL)),
            (State::Osc, _) => (State::Osc, None),
            (State::OscEscape, b'\\') => {
                let body = &self.seq[2..self.seq.len() - 2];
                (State::Ground, osc(body, ESC))
            }
            _ => (State::Ground, None),
        };
        // Too long to be a question: whatever it is, it is not the core's.
        self.state = match self.seq.len() > LONGEST {
            true => State::Ground,
            false => state,
        };
        question
    }

    /// Answers a question that ended at `end` in the chunk starting at
    /// `base`, while its answer is within `room`. The console's own is
    /// always answered: it asks once.
    #[cfg_attr(not(windows), expect(unused_variables))]
    fn answer(
        &mut self,
        q: Question,
        attended: bool,
        room: usize,
        base: u64,
        end: usize,
        found: &mut Found,
    ) {
        #[cfg(windows)]
        if q == Question::Cursor && self.console && self.at < CONSOLE {
            self.console = false;
            found.answers.extend_from_slice(CURSOR);
            // Out of the output when it is all in this chunk; otherwise a
            // client may see it too, as before the core answered it.
            if let Some(start) = self.at.checked_sub(base) {
                found.hidden = Some(start as usize..end);
            }
            return;
        }
        if attended {
            return;
        }
        let color;
        let answer = match q {
            Question::Primary => PRIMARY,
            Question::Secondary => SECONDARY,
            Question::Cursor => CURSOR,
            Question::Color { which, end } => {
                let rgb = if which == 10 { FOREGROUND } else { BACKGROUND };
                let end = if end == BEL { "\x07" } else { "\x1b\\" };
                color = format!("\x1b]{which};{rgb}{end}");
                color.as_bytes()
            }
        };
        // More than the core may still type: the program goes on as with a
        // terminal that does not answer.
        if found.answers.len() + answer.len() <= room {
            found.answers.extend_from_slice(answer);
        }
    }
}

/// A question the core answers.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Question {
    /// Primary device attributes: `CSI c`.
    Primary,
    /// Secondary device attributes: `CSI > c`.
    Secondary,
    /// The cursor position: `CSI 6 n`.
    Cursor,
    /// The default foreground (10) or background (11) color: `OSC 10 ; ?`,
    /// answered with the same end it was asked with.
    Color { which: u8, end: u8 },
}

/// The question a CSI sequence asks, from its parameters and final byte.
fn csi(body: &[u8]) -> Option<Question> {
    match body {
        b"c" | b"0c" => Some(Question::Primary),
        b">c" | b">0c" => Some(Question::Secondary),
        b"6n" => Some(Question::Cursor),
        _ => None,
    }
}

/// The question an OSC sequence asks, from what lies between `ESC ]` and its end.
fn osc(body: &[u8], end: u8) -> Option<Question> {
    match body {
        b"10;?" => Some(Question::Color { which: 10, end }),
        b"11;?" => Some(Question::Color { which: 11, end }),
        _ => None,
    }
}
