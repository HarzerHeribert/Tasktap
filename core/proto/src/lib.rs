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
