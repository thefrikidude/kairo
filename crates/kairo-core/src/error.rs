use std::{fmt, io};

#[derive(Debug)]
pub enum KairoError {
    Io(io::Error),
    Protocol(String),
    InvalidArguments(String),
    DaemonUnavailable,
    DaemonAlreadyRunning,
    DaemonBinaryNotFound,
}

impl fmt::Display for KairoError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "I/O error: {error}"),
            Self::Protocol(message) => write!(formatter, "protocol error: {message}"),
            Self::InvalidArguments(message) => write!(formatter, "invalid arguments: {message}"),
            Self::DaemonUnavailable => write!(formatter, "Kairo daemon is not running"),
            Self::DaemonAlreadyRunning => write!(formatter, "Kairo daemon is already running"),
            Self::DaemonBinaryNotFound => write!(
                formatter,
                "could not find kairo-daemon next to the kairo binary; run `cargo build --workspace`"
            ),
        }
    }
}

impl std::error::Error for KairoError {}

impl From<io::Error> for KairoError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub type Result<T> = std::result::Result<T, KairoError>;
