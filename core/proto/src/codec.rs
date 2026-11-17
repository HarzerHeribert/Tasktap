//! The binary frame codec (design §2): `u32` length, `u8` kind, payload.

use crate::bootstrap::{HEADER, KIND_CONTROL, KIND_DATA};
use crate::frame::{Control, Data, Frame};
use crate::ids::StreamId;
use std::fmt;

/// Most a length field may say for a control frame: 1 MiB.
pub const MAX_FRAME: usize = 1 << 20;
/// Most a length field may say for a data frame: 64 KiB.
pub const MAX_DATA_FRAME: usize = 64 << 10;
/// Most stream bytes one data frame carries; the length also counts the kind
/// byte and the stream id.
pub const MAX_DATA: usize = MAX_DATA_FRAME - 1 - 4;

/// Why bytes are not a frame. Any of these ends the connection: after one, the
/// byte stream can no longer be trusted to line up with frame boundaries.
#[derive(Debug)]
pub enum FrameError {
    /// A length of 0 leaves no room for the kind byte.
    Empty,
    UnknownKind(u8),
    /// The length is over the limit for its kind.
    TooLarge {
        kind: u8,
        len: usize,
    },
    /// A data frame too short to hold its stream id.
    NoStream,
    /// A control payload that is not one valid control frame.
    Json(serde_json::Error),
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("frame length is 0"),
            Self::UnknownKind(kind) => write!(f, "unknown frame kind {kind}"),
            Self::TooLarge { kind, len } => {
                write!(f, "kind {kind} frame of {len} bytes is over the limit")
            }
            Self::NoStream => f.write_str("data frame without a stream id"),
            Self::Json(e) => write!(f, "malformed control frame: {e}"),
        }
    }
}

impl std::error::Error for FrameError {}

fn limit(kind: u8) -> Result<usize, FrameError> {
    match kind {
        KIND_CONTROL => Ok(MAX_FRAME),
        KIND_DATA => Ok(MAX_DATA_FRAME),
        other => Err(FrameError::UnknownKind(other)),
    }
}

/// Appends one frame to `out`; on error `out` is left as it was.
pub fn encode(frame: &Frame, out: &mut Vec<u8>) -> Result<(), FrameError> {
    match frame {
        Frame::Control(control) => encode_control(control, out),
        Frame::Data(data) => encode_data(data.s, &data.bytes, out),
    }
}

pub fn encode_control(control: &Control, out: &mut Vec<u8>) -> Result<(), FrameError> {
    let start = out.len();
    out.extend_from_slice(&[0, 0, 0, 0, KIND_CONTROL]);
    // Written in place and measured after, so the JSON is never copied.
    if let Err(e) = serde_json::to_writer(&mut *out, control) {
        out.truncate(start);
        return Err(FrameError::Json(e));
    }
    let len = out.len() - start - 4;
    if len > MAX_FRAME {
        out.truncate(start);
        return Err(FrameError::TooLarge {
            kind: KIND_CONTROL,
            len,
        });
    }
    out[start..start + 4].copy_from_slice(&(len as u32).to_le_bytes());
    Ok(())
}

/// Encodes stream bytes straight from a borrowed slice, so terminal output is
/// copied once, into `out`.
pub fn encode_data(s: StreamId, bytes: &[u8], out: &mut Vec<u8>) -> Result<(), FrameError> {
    let len = 1 + 4 + bytes.len();
    if len > MAX_DATA_FRAME {
        return Err(FrameError::TooLarge {
            kind: KIND_DATA,
            len,
        });
    }
    out.reserve(4 + len);
    out.extend_from_slice(&(len as u32).to_le_bytes());
    out.push(KIND_DATA);
    out.extend_from_slice(&s.0.to_le_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}

/// Turns bytes, cut anywhere, back into frames.
///
/// Push what arrived, then take frames until [`Decoder::next_frame`] says
/// `None`. The buffer holds at most one partial frame beyond what was pushed,
/// and a length is checked against its kind's limit before any of the payload
/// is awaited, so a peer cannot make the decoder reserve memory by claiming a
/// large frame.
#[derive(Debug, Default)]
pub struct Decoder {
    buf: Vec<u8>,
    at: usize,
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, bytes: &[u8]) {
        // Compacting here, not per frame, moves each partial frame once.
        if self.at > 0 {
            self.buf.drain(..self.at);
            self.at = 0;
        }
        self.buf.extend_from_slice(bytes);
    }

    pub fn next_frame(&mut self) -> Result<Option<Frame>, FrameError> {
        let rest = &self.buf[self.at..];
        let Some(&[a, b, c, d]) = rest.get(..4) else {
            return Ok(None);
        };
        let len = u32::from_le_bytes([a, b, c, d]) as usize;
        if len == 0 {
            return Err(FrameError::Empty);
        }
        let Some(&kind) = rest.get(4) else {
            return Ok(None);
        };
        if len > limit(kind)? {
            return Err(FrameError::TooLarge { kind, len });
        }
        let Some(payload) = rest.get(HEADER..4 + len) else {
            return Ok(None);
        };
        let frame = match kind {
            KIND_CONTROL => {
                Frame::Control(serde_json::from_slice(payload).map_err(FrameError::Json)?)
            }
            _ => match payload {
                [a, b, c, d, bytes @ ..] => Frame::Data(Data {
                    s: StreamId(u32::from_le_bytes([*a, *b, *c, *d])),
                    bytes: bytes.to_vec(),
                }),
                _ => return Err(FrameError::NoStream),
            },
        };
        self.at += 4 + len;
        Ok(Some(frame))
    }
}
