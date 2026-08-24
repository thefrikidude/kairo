use std::{
    collections::HashMap,
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use kairo_core::{Agent, AgentStatus, KairoError, Result};

#[derive(Default)]
pub struct AgentManager {
    agents: Vec<Agent>,
    indexes_by_name: HashMap<String, usize>,
    children_by_name: HashMap<String, Child>,
    next_id: u64,
}

impl AgentManager {
    pub fn create(&mut self, name: String, workspace: PathBuf) -> Result<Agent> {
        let name = name.trim().to_owned();
        if name.is_empty() {
            return Err(KairoError::InvalidArguments("agent name cannot be empty".to_owned()));
        }
        if !workspace.is_absolute() {
            return Err(KairoError::InvalidArguments(
                "agent workspace must be an absolute path".to_owned(),
            ));
        }
        if self.indexes_by_name.contains_key(&name) {
            return Err(KairoError::InvalidArguments(format!(
                "an agent named `{name}` already exists"
            )));
        }

        self.next_id += 1;
        let timestamp = now_millis();
        let agent = Agent {
            id: format!("agent-{timestamp}-{}", self.next_id),
            name: name.clone(),
            adapter: "shell".to_owned(),
            command: None,
            workspace,
            status: AgentStatus::Stopped,
            pid: None,
            created_at_ms: timestamp,
            updated_at_ms: timestamp,
        };

        self.indexes_by_name.insert(name, self.agents.len());
        self.agents.push(agent.clone());
        Ok(agent)
    }

    pub fn list(&self) -> Vec<Agent> {
        self.agents.clone()
    }

    pub fn start(&mut self, name: &str, command: Vec<String>) -> Result<Agent> {
        self.refresh()?;
        if command.is_empty() {
            return Err(KairoError::InvalidArguments("agent command cannot be empty".to_owned()));
        }
        if self.children_by_name.contains_key(name) {
            return Err(KairoError::InvalidArguments(format!("agent `{name}` is already running")));
        }

        let index = self.agent_index(name)?;
        let workspace = self.agents[index].workspace.clone();
        let program = &command[0];
        let arguments = &command[1..];
        let child = Command::new(program)
            .args(arguments)
            .current_dir(workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        let pid = child.id();

        let agent = &mut self.agents[index];
        agent.command = Some(command);
        agent.pid = Some(pid);
        agent.status = AgentStatus::Working;
        agent.updated_at_ms = now_millis();
        let snapshot = agent.clone();
        self.children_by_name.insert(name.to_owned(), child);
        Ok(snapshot)
    }

    pub fn stop(&mut self, name: &str) -> Result<Agent> {
        self.refresh()?;
        let mut child = self.children_by_name.remove(name).ok_or_else(|| {
            KairoError::InvalidArguments(format!("agent `{name}` is not running"))
        })?;
        child.kill()?;
        let _ = child.wait()?;

        let agent = self.agent_mut(name)?;
        agent.pid = None;
        agent.status = AgentStatus::Stopped;
        agent.updated_at_ms = now_millis();
        Ok(agent.clone())
    }

    pub fn shutdown(&mut self) -> Result<()> {
        let names = self.children_by_name.keys().cloned().collect::<Vec<_>>();
        for name in names {
            self.stop(&name)?;
        }
        Ok(())
    }

    pub fn refresh(&mut self) -> Result<()> {
        let mut finished = Vec::new();
        for (name, child) in &mut self.children_by_name {
            if let Some(exit_status) = child.try_wait()? {
                finished.push((name.clone(), exit_status.success()));
            }
        }

        for (name, succeeded) in finished {
            self.children_by_name.remove(&name);
            let agent = self.agent_mut(&name)?;
            agent.pid = None;
            agent.status = if succeeded { AgentStatus::Completed } else { AgentStatus::Failed };
            agent.updated_at_ms = now_millis();
        }
        Ok(())
    }

    fn agent_index(&self, name: &str) -> Result<usize> {
        self.indexes_by_name
            .get(name)
            .copied()
            .ok_or_else(|| KairoError::InvalidArguments(format!("agent `{name}` does not exist")))
    }

    fn agent_mut(&mut self, name: &str) -> Result<&mut Agent> {
        let index = self.agent_index(name)?;
        Ok(&mut self.agents[index])
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use kairo_core::AgentStatus;

    use super::AgentManager;

    #[test]
    fn creates_a_stopped_shell_agent() {
        let mut manager = AgentManager::default();

        let agent = manager
            .create("coder".to_owned(), PathBuf::from("/tmp/kairo"))
            .expect("agent is created");

        assert!(agent.id.starts_with("agent-"));
        assert_eq!(agent.adapter, "shell");
        assert_eq!(agent.status, AgentStatus::Stopped);
    }

    #[test]
    fn rejects_duplicate_names() {
        let mut manager = AgentManager::default();
        manager
            .create("coder".to_owned(), PathBuf::from("/tmp/kairo"))
            .expect("first agent is created");

        assert!(
            manager.create("coder".to_owned(), PathBuf::from("/tmp/another-workspace")).is_err()
        );
    }

    #[test]
    fn lists_agents_in_creation_order() {
        let mut manager = AgentManager::default();
        manager
            .create("coder".to_owned(), PathBuf::from("/tmp/kairo"))
            .expect("first agent is created");
        manager
            .create("reviewer".to_owned(), PathBuf::from("/tmp/kairo"))
            .expect("second agent is created");

        let names = manager.list().into_iter().map(|agent| agent.name).collect::<Vec<_>>();
        assert_eq!(names, ["coder", "reviewer"]);
    }

    #[test]
    fn starts_and_marks_a_successful_process_completed() {
        let mut manager = AgentManager::default();
        let workspace = std::env::temp_dir();
        manager.create("coder".to_owned(), workspace).expect("agent is created");

        let started = manager
            .start("coder", vec!["/bin/sh".to_owned(), "-c".to_owned(), "exit 0".to_owned()])
            .expect("process starts");
        assert_eq!(started.status, AgentStatus::Working);
        assert!(started.pid.is_some());

        std::thread::sleep(std::time::Duration::from_millis(20));
        manager.refresh().expect("process state refreshes");
        assert_eq!(manager.list()[0].status, AgentStatus::Completed);
        assert_eq!(manager.list()[0].pid, None);
    }

    #[test]
    fn stops_a_running_process() {
        let mut manager = AgentManager::default();
        let workspace = std::env::temp_dir();
        manager.create("coder".to_owned(), workspace).expect("agent is created");
        manager
            .start("coder", vec!["/bin/sh".to_owned(), "-c".to_owned(), "sleep 10".to_owned()])
            .expect("process starts");

        let stopped = manager.stop("coder").expect("process stops");
        assert_eq!(stopped.status, AgentStatus::Stopped);
        assert_eq!(stopped.pid, None);
    }
}
