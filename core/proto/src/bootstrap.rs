//! The bootstrap contract (design §2).
//!
//! **This can never change.** Any app must be able to ask any core what it is
//! and ask it to retire, whatever either side's version. Frozen forever: the
//! frame layout below, `hello.v`, `welcome.v` and `welcome.build`, `refuse`,
//! and the arguments and results of `core.status` and `core.retire`. The other
//! `hello` and `welcome` fields may only gain additions, because an old core
//! still has to decode a new app's `hello` to read `v` from it.
//!
//! So every closed set of words in these frames decodes a word it does not
//! know as `Unknown` instead of failing: an old core still welcomes an app
//! with a new role or a new way to prove itself, and an old app still reads
//! a new core's welcome. `Unknown` is never sent and is not in protocol.ts.

use crate::ids::{CoreId, DeviceId, Secret};
use serde::{Deserialize, Serialize};

/// Bytes before every payload: a `u32` little-endian length that counts the
/// kind byte and the payload, then the kind byte.
pub const HEADER: usize = 5;
/// Kind 0: one JSON object in UTF-8.
pub const KIND_CONTROL: u8 = 0;
/// Kind 1: a `u32` little-endian stream id, then raw bytes.
pub const KIND_DATA: u8 = 1;
/// In `welcome.v`: no version is shared, so only `core.status` and `core.retire` work.
pub const NO_SHARED_VERSION: u32 = 0;

/// `[min, max]`, both inclusive.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Versions(pub u32, pub u32);

impl Versions {
    /// The highest version both ranges hold, or [`NO_SHARED_VERSION`].
    pub fn shared(self, other: Versions) -> u32 {
        let (low, high) = (self.0.max(other.0), self.1.min(other.1));
        if low <= high { high } else { NO_SHARED_VERSION }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Hello {
    pub v: Versions,
    pub role: Role,
    /// Free text naming the program, for logs.
    pub client: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<Auth>,
    /// The `host.*` calls a host answers.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub abilities: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Role {
    Page,
    Host,
    Cli,
    /// A role from a newer app.
    #[serde(other)]
    #[cfg_attr(test, ts(skip))]
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Auth {
    Device {
        device: DeviceId,
        key: Secret,
        /// Present when a local peer registers this device on first contact.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        register: Option<Register>,
    },
    Session {
        token: Secret,
    },
    /// A scheme from a newer app, or a known one that does not parse. The
    /// core treats it as no identity, so the bootstrap calls still work.
    #[cfg_attr(test, ts(skip))]
    Unknown(serde_json::Value),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Register {
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Welcome {
    /// The highest shared version, or 0 when none is shared.
    pub v: u32,
    pub core: CoreId,
    pub build: String,
    #[serde(rename = "as")]
    pub identity: Identity,
    /// Names rather than typed calls: a newer core lists calls this crate does not know.
    pub calls: Vec<String>,
}

/// Who the core took the connection to be.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Identity {
    Device,
    Session,
    /// A local peer with neither a device key nor a session token.
    #[serde(rename = "none")]
    Anonymous,
    /// An identity from a newer core.
    #[serde(other)]
    #[cfg_attr(test, ts(skip))]
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Refuse {
    pub why: RefuseWhy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum RefuseWhy {
    Auth,
    Revoked,
    /// A reason from a newer core.
    #[serde(other)]
    #[cfg_attr(test, ts(skip))]
    Unknown,
}

/// The result of `core.status`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CoreStatus {
    pub build: String,
    pub v: Versions,
    /// Live terminals, which retiring now would end.
    pub terminals: u32,
}

/// The arguments of `core.retire`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Retire {
    pub when: When,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum When {
    /// Exit now, ending every terminal.
    Now,
    /// Exit when the last terminal ends.
    Idle,
}
