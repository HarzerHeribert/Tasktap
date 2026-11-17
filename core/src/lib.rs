//! The Tasktap core: the one service that owns everything that is not pixels.
//!
//! It grows one module per work package of `docs/core-design.md` §14.
#![forbid(unsafe_code)]

pub mod state;
pub mod store;
