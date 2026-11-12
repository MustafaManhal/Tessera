//! Shell discovery, non-invasive startup injection, and streaming OSC 133/7 parsing.

pub mod detect;
pub mod integration;
pub mod parser;

pub use detect::{DetectionEnv, ShellInfo, ShellKind, detect_shells, discover_shells};
pub use integration::{
    ShellError, integration_args, integration_env, prepare_installed_launch, prepare_launch, write_scripts,
};
pub use parser::{ShellEvent, ShellParser};
