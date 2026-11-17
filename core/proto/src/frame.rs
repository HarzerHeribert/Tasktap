//! The ten frame kinds (design §1): nine JSON control frames and stream bytes.

use crate::bootstrap::{Hello, Refuse, Welcome};
use crate::call::Error;
use crate::ids::{CallId, Offset, Rev, StreamId};
use crate::records::Set;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub enum Frame {
    Control(Control),
    Data(Data),
}

/// A kind 0 frame. Unknown fields are ignored, so a newer peer may add fields
/// without bumping the version.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Control {
    Hello(Hello),
    Welcome(Welcome),
    Refuse(Refuse),
    Call(Request),
    Reply(Reply),
    Change(Change),
    Credit(Credit),
    Mark(Mark),
    Close(Close),
}

/// A `call` frame. The name stays text so that a name this side does not know
/// still gets a `reply` with `unknown` instead of ending the connection.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Request {
    pub id: CallId,
    pub name: String,
    #[cfg_attr(test, ts(type = "object"))]
    pub args: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Reply {
    pub id: CallId,
    #[serde(flatten)]
    pub outcome: Outcome,
}

/// Exactly one of `ok` and `err`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Outcome {
    Ok(#[cfg_attr(test, ts(type = "unknown"))] Value),
    Err(Error),
}

/// One committed transaction, or one chunk of a snapshot.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Change {
    pub rev: Rev,
    #[serde(default, skip_serializing_if = "is_false")]
    pub snap: bool,
    pub sets: Vec<Set>,
}

/// The reply of a call that opens a stream; that call's args carry the
/// credit the caller grants toward it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Opened {
    pub s: StreamId,
    /// Bytes the core lets the caller send on this stream.
    pub credit: u32,
}

/// Grants `n` more bytes on stream `s`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Credit {
    pub s: StreamId,
    pub n: u32,
}

/// Something that happened at byte offset `at` of stream `s`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Mark {
    pub s: StreamId,
    pub at: Offset,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<Size>,
    /// Replay is over; bytes from here on are live.
    #[serde(default, skip_serializing_if = "is_false")]
    pub live: bool,
    /// The reader fell out of the ring; a replay follows.
    #[serde(default, skip_serializing_if = "is_false")]
    pub gap: bool,
    /// Present once the process exited: its code, or null when it has none.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    #[cfg_attr(test, ts(type = "number | null"))]
    pub exit: Option<Option<u32>>,
}

/// A terminal size: `[cols, rows]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Size(pub u16, pub u16);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Close {
    pub s: StreamId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<CloseWhy>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum CloseWhy {
    Done,
    Overflow,
    Gone,
    Denied,
}

/// A kind 1 frame: raw bytes on a stream.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Data {
    pub s: StreamId,
    pub bytes: Vec<u8>,
}

fn is_false(b: &bool) -> bool {
    !b
}

// Tells a present `null` (Some(None)) from an absent field (None).
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}
