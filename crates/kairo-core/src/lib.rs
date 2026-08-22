//! Shared protocol and runtime configuration for Kairo clients and the daemon.

pub mod error;
pub mod paths;
pub mod protocol;

pub use error::{KairoError, Result};
pub use paths::RuntimePaths;
pub use protocol::{Request, Response};
