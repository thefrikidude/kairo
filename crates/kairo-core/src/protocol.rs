use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::Agent;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    Ping,
    Shutdown,
    CreateAgent { name: String, adapter: String, workspace: PathBuf },
    OpenTerminal { workspace: PathBuf },
    SetAgentTitle { name: String, title: String },
    ListAgents,
    StartAgent { name: String, command: Vec<String> },
    StartConfiguredAgent { name: String },
    StopAgent { name: String },
    GetAgentLogs { name: String },
    SendAgentInput { name: String, input: String },
    InterruptAgent { name: String },
    AttachAgent { name: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    Pong,
    Accepted,
    AgentCreated { agent: Agent },
    TerminalOpened { agent: Agent },
    AgentTitleUpdated { agent: Agent },
    AgentStarted { agent: Agent },
    AgentStopped { agent: Agent },
    Agents { agents: Vec<Agent> },
    AgentLogs { name: String, output: String },
    AgentInputSent { name: String },
    AgentInterrupted { name: String },
    AgentAttached { name: String },
    Error { message: String },
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use crate::{Agent, AgentStatus};

    use super::{Request, Response};

    #[test]
    fn protocol_messages_round_trip_as_json() {
        let request = serde_json::to_string(&Request::Ping).expect("request serializes");
        assert_eq!(serde_json::from_str::<Request>(&request).unwrap(), Request::Ping);

        let response = serde_json::to_string(&Response::Pong).expect("response serializes");
        assert_eq!(serde_json::from_str::<Response>(&response).unwrap(), Response::Pong);
    }

    #[test]
    fn agent_messages_round_trip_as_json() {
        let request = Request::CreateAgent {
            name: "coder".to_owned(),
            adapter: "shell".to_owned(),
            workspace: PathBuf::from("/tmp/kairo"),
        };
        let encoded_request = serde_json::to_string(&request).expect("request serializes");
        assert_eq!(serde_json::from_str::<Request>(&encoded_request).unwrap(), request);

        let agent = Agent {
            id: "agent-1".to_owned(),
            name: "coder".to_owned(),
            title: "coder".to_owned(),
            adapter: "shell".to_owned(),
            command: None,
            workspace: PathBuf::from("/tmp/kairo"),
            status: AgentStatus::Stopped,
            pid: None,
            created_at_ms: 1,
            updated_at_ms: 1,
        };
        let response = Response::AgentCreated { agent };
        let encoded_response = serde_json::to_string(&response).expect("response serializes");
        assert_eq!(serde_json::from_str::<Response>(&encoded_response).unwrap(), response);
    }
}
