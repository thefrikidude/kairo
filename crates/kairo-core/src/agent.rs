use std::{fmt, path::PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub adapter: String,
    pub command: Option<Vec<String>>,
    pub workspace: PathBuf,
    pub status: AgentStatus,
    pub pid: Option<u32>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Starting,
    Working,
    Waiting,
    Idle,
    Blocked,
    Failed,
    Completed,
    Stopped,
}

impl fmt::Display for AgentStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let status = match self {
            Self::Starting => "starting",
            Self::Working => "working",
            Self::Waiting => "waiting",
            Self::Idle => "idle",
            Self::Blocked => "blocked",
            Self::Failed => "failed",
            Self::Completed => "completed",
            Self::Stopped => "stopped",
        };
        formatter.write_str(status)
    }
}
