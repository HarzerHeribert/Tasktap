//! The Tasktap core: the one service that owns everything that is not pixels.
//!
//! It grows one module per work package of `docs/core-design.md` §14.
// Denied rather than forbidden so that the one Windows module in `sys` can
// call the system; nothing else may.
#![deny(unsafe_code)]

pub mod agents;
mod calls;
mod chatgpt;
pub mod client;
mod command;
mod conn;
mod effects;
pub mod files;
mod handshake;
mod http;
mod isolate;
mod launch;
pub mod map;
pub mod own;
pub mod placings;
mod questions;
mod records;
pub mod relocate;
pub mod roles;
pub mod route;
pub mod secrets;
pub mod serve;
mod shim;
mod speech;
pub mod state;
pub mod store;
pub mod stream;
mod sys;
mod terminal;

/// The test role that stands in for a program in a terminal (design §13),
/// and the lines it prints.
#[cfg(feature = "fixtures")]
pub use terminal::fixture::{fold as fixture_fold, line as fixture_line, run as fixture_terminal};
