//! The Tasktap core: the one service that owns everything that is not pixels.
//!
//! It grows one module per work package of `docs/core-design.md` §14.
// Denied rather than forbidden so that the one Windows module in `sys` can
// call the system; nothing else may.
#![deny(unsafe_code)]

mod calls;
pub mod client;
mod conn;
mod effects;
mod handshake;
mod questions;
mod records;
pub mod serve;
pub mod state;
pub mod store;
pub mod stream;
mod sys;
