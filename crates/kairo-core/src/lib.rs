//! Shared protocol and runtime configuration for Kairo clients and the daemon.

pub mod agent;
pub mod attach;
pub mod error;
pub mod paths;
pub mod protocol;

pub use agent::{Agent, AgentStatus};
pub use attach::{AttachFrame, read_attach_frame, write_attach_frame};
pub use error::{KairoError, Result};
pub use paths::RuntimePaths;
pub use protocol::{Request, Response};
