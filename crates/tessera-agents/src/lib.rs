//! Data-driven agent catalog, discovery and launch construction.
pub mod definition;
pub use definition::*;
pub mod command;
pub mod detection;
pub use command::{CommandLine, LaunchProfile, command_line};
pub use detection::{Detection, Detector};
pub mod hooks;
pub mod status;
pub mod usage;
pub use usage::{Usage, UsageTracker};

pub mod mcp_config;

pub mod mcp_probe;
