//! orc — orchestrate many `claude` CLI agents in parallel from a ratatui TUI.
//!
//! This is the Rust rewrite skeleton. Most logic is stubbed with `todo!()` so the tests-first
//! suite compiles and fails (red) until the implementer fills the bodies in.

pub mod agent;
pub mod config;
pub mod persist;
pub mod ports;
pub mod simulators;
pub mod tmux;
pub mod types;
pub mod ui;
pub mod worktree;

fn main() {
    // Real CLI wiring (clap) comes later; keeping main trivial so the crate builds.
}
