//! GitHub client for the connection flow and API reads (FR-54, TRD 4.8). The device flow is the same shape as
//! tessera-sync's (public OAuth client id O-4, no secret); the API helper records rate-limit headers and honours
//! ETag conditional GETs.

pub mod github;
pub mod issues;
pub mod pulls;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ForgeError {
    #[error("network error: {0}")]
    Network(String),
    #[error("GitHub refused: {0}")]
    Protocol(String),
    #[error("rate limited until {until}")]
    RateLimited { until: i64 },
    #[error("`gh` is not installed or has no GitHub login")]
    GhMissing,
    #[error("GitHub denied the sign-in")]
    Denied,
    #[error("the sign-in code expired")]
    Expired,
    #[error("not connected to GitHub")]
    NotConnected,
}
