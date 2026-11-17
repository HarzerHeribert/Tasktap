//! The Tasktap core protocol: the wire types that exist in Phase 1.
//!
//! Three mechanisms on one channel (design §1): records a client watches,
//! calls any side can make, and streams of raw bytes. The specification is
//! `docs/core-design.md`. Peers ignore fields they do not know, which is how
//! additions arrive without a new version.
#![forbid(unsafe_code)]

/// A closed set of words on the wire, in snake_case.
macro_rules! words {
    ($(#[$meta:meta])* pub enum $name:ident { $($(#[$vmeta:meta])* $variant:ident),* $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
        #[serde(rename_all = "snake_case")]
        #[cfg_attr(test, derive(ts_rs::TS))]
        pub enum $name { $($(#[$vmeta])* $variant),* }

        impl $name {
            /// Every word, in order.
            pub const ALL: &'static [$name] = &[$($name::$variant),*];
        }
    };
}

mod args;
mod bootstrap;
pub mod call;
mod codec;
mod frame;
mod ids;
mod records;
#[cfg(test)]
mod typescript;

pub use args::*;
pub use bootstrap::*;
pub use call::{Access, Call, Code, Error, Name};
pub use codec::*;
pub use frame::*;
pub use ids::*;
pub use records::*;

/// The protocol version this crate speaks.
pub const VERSION: u32 = 1;
/// Most bytes granted and not yet received on one direction of a stream.
pub const MAX_CREDIT: u32 = 4 << 20;
/// Calls one caller may have pending on a connection.
pub const MAX_PENDING_CALLS: usize = 64;
/// Streams open at once on a connection.
pub const MAX_STREAMS: usize = 64;
/// Questions one session may have open at once. An agent asks one at a time,
/// or a few when its sub-steps ask together.
pub const MAX_SESSION_QUESTIONS: usize = 8;
/// Questions all sessions together may have open at once; a router's question
/// is one per captured thought and not counted.
pub const MAX_OPEN_QUESTIONS: usize = 64;

// The bounds of what a call may write into a row. A bounded value is counted
// in bytes of its JSON, quotes included: in a page, the length of
// `new TextEncoder().encode(JSON.stringify(value))`. A call with a value over
// its bound is `invalid` before anything is written. With every bounded field
// at its limit each row still fits one snapshot chunk (design §1), so no row
// can be too large to send.

/// A long text: a thought's text (captured, typed into an agent's terminal
/// or edited as a note), a question's detail, and a text answer.
pub const MAX_TEXT: usize = 64 << 10;
/// A short text: a question's prompt and its choices together, a router's
/// brief, a session's error, a project's name, color and folder and its
/// aliases together, and a device's name.
pub const MAX_LINE: usize = 8 << 10;
/// Points in a thought's strokes, an empty stroke counting as one.
pub const MAX_POINTS: usize = 2048;

/// The bytes of a value's JSON, counted without keeping the JSON.
pub fn json_len(value: &impl serde::Serialize) -> usize {
    struct Count(usize);
    impl std::io::Write for Count {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count(0);
    // Protocol types always serialize; see `call::to_value`.
    let _ = serde_json::to_writer(&mut count, value);
    count.0
}

// What follows bounds the arguments of calls only: a stored row always reads back.

/// Refuses a value of more than `N` bytes of JSON.
fn bounded<const N: usize, E: serde::de::Error>(value: &impl serde::Serialize) -> Result<(), E> {
    match json_len(value) {
        len if len > N => Err(E::custom(format_args!(
            "a value of {len} bytes of JSON, where {N} is the most"
        ))),
        _ => Ok(()),
    }
}

/// For `deserialize_with`: a value of at most `N` bytes of JSON.
fn within<'de, const N: usize, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de> + serde::Serialize,
{
    let value = T::deserialize(d)?;
    bounded::<N, _>(&value).map(|()| value)
}

/// For `deserialize_with`: a question's kind, its choices at most
/// [`MAX_LINE`] bytes of JSON together.
fn asked<'de, D: serde::Deserializer<'de>>(d: D) -> Result<QuestionKind, D::Error> {
    let kind: QuestionKind = serde::Deserialize::deserialize(d)?;
    if let QuestionKind::Choice { choices } = &kind {
        bounded::<MAX_LINE, _>(choices)?;
    }
    Ok(kind)
}

/// For `deserialize_with`: an answer, its text at most [`MAX_TEXT`] bytes of JSON.
fn answered<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Response, D::Error> {
    let response: Response = serde::Deserialize::deserialize(d)?;
    if let Response::Text { text } = &response {
        bounded::<MAX_TEXT, _>(text)?;
    }
    Ok(response)
}

/// For `deserialize_with`: strokes of at most [`MAX_POINTS`] points.
fn drawn<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de> + Points,
{
    let strokes = T::deserialize(d)?;
    match strokes.points() {
        n if n > MAX_POINTS => Err(serde::de::Error::custom(format_args!(
            "strokes of {n} points, where {MAX_POINTS} is the most"
        ))),
        _ => Ok(strokes),
    }
}

trait Points {
    fn points(&self) -> usize;
}

impl Points for Vec<Stroke> {
    fn points(&self) -> usize {
        self.iter().map(|s| s.len().max(1)).sum()
    }
}

impl<T: Points> Points for Option<T> {
    fn points(&self) -> usize {
        self.as_ref().map_or(0, T::points)
    }
}
