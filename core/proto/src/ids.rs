//! Identifiers and integers that cross the wire.
//!
//! Every type here refuses a value the design forbids at the moment it is
//! decoded, so code past the codec never has to check again.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use uuid::Uuid;

/// A decoded value the protocol forbids; the text says which rule it broke.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Invalid(pub &'static str);

impl fmt::Display for Invalid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for Invalid {}

macro_rules! ids {
    ($($(#[$doc:meta])* $name:ident),* $(,)?) => {$(
        /// A UUID v7 in text, minted by whoever creates the record.
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(try_from = "Uuid", into = "Uuid")]
        #[cfg_attr(test, derive(ts_rs::TS), ts(type = "string"))]
        pub struct $name(Uuid);

        impl $name {
            /// Mints a new id; v7 ids sort by creation time.
            pub fn mint() -> Self {
                Self(Uuid::now_v7())
            }

            pub fn uuid(self) -> Uuid {
                self.0
            }
        }

        impl TryFrom<Uuid> for $name {
            type Error = Invalid;
            fn try_from(id: Uuid) -> Result<Self, Invalid> {
                // History pages by id, which only works when every id is time-ordered.
                if id.get_version_num() == 7 { Ok(Self(id)) } else { Err(Invalid("ids must be UUID v7")) }
            }
        }

        impl From<$name> for Uuid {
            fn from(id: $name) -> Uuid {
                id.0
            }
        }
    )*};
}

ids! {
    /// The core itself, named in `welcome` so a client can hold records from several cores.
    CoreId,
    ThoughtId,
    ProjectId,
    SessionId,
    TerminalId,
    QuestionId,
    ResultId,
    DeviceId,
    /// Names one attempt to start a process, so a repeated call never starts it twice.
    AttemptId,
}

/// Largest integer every JSON reader holds exactly (2^53 - 1).
pub const MAX_SAFE: u64 = (1 << 53) - 1;

macro_rules! safe_ints {
    ($($(#[$doc:meta])* $name:ident),* $(,)?) => {$(
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(try_from = "u64", into = "u64")]
        #[cfg_attr(test, derive(ts_rs::TS), ts(type = "number"))]
        pub struct $name(u64);

        impl $name {
            pub const ZERO: Self = Self(0);

            /// `None` at 2^53 and above, which a JavaScript client could not hold exactly.
            pub const fn new(n: u64) -> Option<Self> {
                if n <= MAX_SAFE { Some(Self(n)) } else { None }
            }

            pub const fn get(self) -> u64 {
                self.0
            }
        }

        impl TryFrom<u64> for $name {
            type Error = Invalid;
            fn try_from(n: u64) -> Result<Self, Invalid> {
                Self::new(n).ok_or(Invalid("integers on the wire must be below 2^53"))
            }
        }

        impl From<$name> for u64 {
            fn from(n: $name) -> u64 {
                n.0
            }
        }
    )*};
}

safe_ints! {
    /// Orders committed changes within one run of the core.
    Rev,
    /// A byte position in a stream since it opened.
    Offset,
    /// Milliseconds since the Unix epoch.
    Time,
}

/// A call id, unique among the caller's pending calls.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CallId(pub u32);

/// A stream id, never reused on its connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct StreamId(pub u32);

/// 32 random bytes as 64 hex digits: a device key or a session token.
#[derive(Clone, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS), ts(type = "string"))]
pub struct Secret(pub [u8; 32]);

impl fmt::Debug for Secret {
    // Keeps secrets out of logs and panic messages.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(..)")
    }
}

impl Serialize for Secret {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut text = String::with_capacity(64);
        for b in self.0 {
            text.push(HEX[usize::from(b >> 4)] as char);
            text.push(HEX[usize::from(b & 15)] as char);
        }
        s.serialize_str(&text)
    }
}

impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        let digit = |c: u8| (c as char).to_digit(16).map(|n| n as u8);
        let refuse = || serde::de::Error::custom("a secret is 64 hex digits");
        let (pairs, []) = text.as_bytes().as_chunks::<2>() else {
            return Err(refuse());
        };
        if pairs.len() != 32 {
            return Err(refuse());
        }
        let mut out = [0u8; 32];
        for (byte, &[hi, lo]) in out.iter_mut().zip(pairs) {
            *byte = digit(hi)
                .zip(digit(lo))
                .map(|(hi, lo)| hi << 4 | lo)
                .ok_or_else(refuse)?;
        }
        Ok(Secret(out))
    }
}
