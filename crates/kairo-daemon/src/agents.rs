use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use kairo_core::{Agent, AgentStatus, KairoError, Result};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};

use crate::transcript::Transcript;

#[derive(Default)]
pub struct AgentManager {
    agents: Vec<Agent>,
    indexes_by_name: HashMap<String, usize>,
    sessions_by_name: HashMap<String, PtySession>,
    transcripts_by_name: HashMap<String, Arc<Mutex<Transcript>>>,
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
        self.transcripts_by_name
            .insert(agent.name.clone(), Arc::new(Mutex::new(Transcript::default())));
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
        if self.sessions_by_name.contains_key(name) {
            return Err(KairoError::InvalidArguments(format!("agent `{name}` is already running")));
        }

        let index = self.agent_index(name)?;
        let workspace = self.agents[index].workspace.clone();
        let program = &command[0];
        let arguments = &command[1..];
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .map_err(runtime_error)?;
        let reader = pair.master.try_clone_reader().map_err(runtime_error)?;
        let writer = pair.master.take_writer().map_err(runtime_error)?;
        let transcript = Arc::new(Mutex::new(Transcript::default()));
        let reader_transcript = Arc::clone(&transcript);
        thread::spawn(move || capture_output(reader, reader_transcript));

        let mut pty_command = CommandBuilder::new(program);
        pty_command.args(arguments);
        pty_command.cwd(workspace);
        let child = pair.slave.spawn_command(pty_command).map_err(runtime_error)?;
        drop(pair.slave);
        let pid = child.process_id().ok_or_else(|| {
            KairoError::Runtime("PTY child started without a process ID".to_owned())
        })?;

        let agent = &mut self.agents[index];
        agent.command = Some(command);
        agent.pid = Some(pid);
        agent.status = AgentStatus::Working;
        agent.updated_at_ms = now_millis();
        let snapshot = agent.clone();
        self.transcripts_by_name.insert(name.to_owned(), transcript);
        self.sessions_by_name
            .insert(name.to_owned(), PtySession { child, _master: pair.master, writer });
        Ok(snapshot)
    }

    pub fn stop(&mut self, name: &str) -> Result<Agent> {
        self.refresh()?;
        let mut session = self.sessions_by_name.remove(name).ok_or_else(|| {
            KairoError::InvalidArguments(format!("agent `{name}` is not running"))
        })?;
        session.child.kill().map_err(runtime_error)?;
        let _ = session.child.wait().map_err(runtime_error)?;

        let agent = self.agent_mut(name)?;
        agent.pid = None;
        agent.status = AgentStatus::Stopped;
        agent.updated_at_ms = now_millis();
        Ok(agent.clone())
    }

    pub fn shutdown(&mut self) -> Result<()> {
        let names = self.sessions_by_name.keys().cloned().collect::<Vec<_>>();
        for name in names {
            self.stop(&name)?;
        }
        Ok(())
    }

    pub fn refresh(&mut self) -> Result<()> {
        let mut finished = Vec::new();
        for (name, session) in &mut self.sessions_by_name {
            if let Some(exit_status) = session.child.try_wait().map_err(runtime_error)? {
                finished.push((name.clone(), exit_status.success()));
            }
        }

        for (name, succeeded) in finished {
            self.sessions_by_name.remove(&name);
            let agent = self.agent_mut(&name)?;
            agent.pid = None;
            agent.status = if succeeded { AgentStatus::Completed } else { AgentStatus::Failed };
            agent.updated_at_ms = now_millis();
        }
        Ok(())
    }

    pub fn logs(&self, name: &str) -> Result<String> {
        self.agent_index(name)?;
        let transcript = self
            .transcripts_by_name
            .get(name)
            .ok_or_else(|| KairoError::Runtime(format!("agent `{name}` has no transcript")))?;
        transcript
            .lock()
            .map_err(|_| KairoError::Runtime(format!("agent `{name}` transcript lock is poisoned")))
            .map(|transcript| transcript.text())
    }

    pub fn send_input(&mut self, name: &str, input: &str) -> Result<()> {
        self.refresh()?;
        let session = self.sessions_by_name.get_mut(name).ok_or_else(|| {
            KairoError::InvalidArguments(format!("agent `{name}` is not running"))
        })?;
        session.writer.write_all(input.as_bytes())?;
        session.writer.write_all(b"\r")?;
        session.writer.flush()?;
        Ok(())
    }

    pub fn interrupt(&mut self, name: &str) -> Result<()> {
        self.refresh()?;
        let session = self.sessions_by_name.get_mut(name).ok_or_else(|| {
            KairoError::InvalidArguments(format!("agent `{name}` is not running"))
        })?;
        session.writer.write_all(&[3])?;
        session.writer.flush()?;
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

struct PtySession {
    child: Box<dyn Child + Send + Sync>,
    _master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

fn capture_output(mut reader: Box<dyn Read + Send>, transcript: Arc<Mutex<Transcript>>) {
    let mut buffer = [0_u8; 4096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                if let Ok(mut transcript) = transcript.lock() {
                    transcript.append(&buffer[..count]);
                } else {
                    break;
                }
            }
        }
    }
}

fn runtime_error(error: impl std::fmt::Display) -> KairoError {
    KairoError::Runtime(error.to_string())
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

    #[test]
    fn captures_output_after_a_process_completes() {
        let mut manager = AgentManager::default();
        manager.create("coder".to_owned(), std::env::temp_dir()).expect("agent is created");
        manager
            .start(
                "coder",
                vec![
                    "/bin/sh".to_owned(),
                    "-c".to_owned(),
                    "printf 'hello from pty\\n'".to_owned(),
                ],
            )
            .expect("process starts");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while std::time::Instant::now() < deadline {
            manager.refresh().expect("process state refreshes");
            if manager.logs("coder").expect("logs are readable").contains("hello from pty") {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        panic!("PTY output was not captured before the deadline");
    }

    #[test]
    fn sends_input_to_an_interactive_shell() {
        let mut manager = AgentManager::default();
        manager.create("coder".to_owned(), std::env::temp_dir()).expect("agent is created");
        manager.start("coder", vec!["/bin/sh".to_owned()]).expect("shell starts");

        manager.send_input("coder", "printf 'hello from input\\n'").expect("input is sent");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while std::time::Instant::now() < deadline {
            if manager.logs("coder").expect("logs are readable").contains("hello from input") {
                manager.stop("coder").expect("shell stops");
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        manager.stop("coder").expect("shell stops after failed assertion");
        panic!("PTY input did not produce output before the deadline");
    }

    #[test]
    fn rejects_input_for_a_non_running_agent() {
        let mut manager = AgentManager::default();
        manager.create("coder".to_owned(), std::env::temp_dir()).expect("agent is created");

        assert!(manager.send_input("coder", "echo hello").is_err());
        assert!(manager.interrupt("coder").is_err());
    }

    #[test]
    fn interrupt_marks_a_foreground_process_failed() {
        let mut manager = AgentManager::default();
        manager.create("coder".to_owned(), std::env::temp_dir()).expect("agent is created");
        manager
            .start("coder", vec!["/bin/sh".to_owned(), "-c".to_owned(), "exec sleep 30".to_owned()])
            .expect("process starts");

        manager.interrupt("coder").expect("interrupt is sent");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while std::time::Instant::now() < deadline {
            manager.refresh().expect("process state refreshes");
            if manager.list()[0].status == AgentStatus::Failed {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        panic!("foreground process did not exit after Ctrl-C");
    }
}
