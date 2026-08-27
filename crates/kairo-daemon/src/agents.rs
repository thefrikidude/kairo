use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        mpsc::{Receiver, SyncSender, sync_channel},
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use kairo_core::{Agent, AgentStatus, KairoError, Result};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};

use crate::{storage::Storage, transcript::Transcript};

pub struct AgentManager {
    storage: Storage,
    agents: Vec<Agent>,
    indexes_by_name: HashMap<String, usize>,
    sessions_by_name: HashMap<String, PtySession>,
    outputs_by_name: HashMap<String, Arc<Mutex<AgentOutput>>>,
    next_id: u64,
}

impl AgentManager {
    pub fn load(storage: Storage) -> Result<Self> {
        let mut manager = Self {
            storage,
            agents: Vec::new(),
            indexes_by_name: HashMap::new(),
            sessions_by_name: HashMap::new(),
            outputs_by_name: HashMap::new(),
            next_id: 0,
        };

        for mut agent in manager.storage.load_agents()? {
            if is_active(&agent.status) {
                agent.status = AgentStatus::Interrupted;
                agent.pid = None;
                agent.updated_at_ms = now_millis();
                manager.storage.save_agent(&agent)?;
            }
            let mut transcript = Transcript::default();
            transcript.append(&manager.storage.events(&agent.id)?);
            manager.indexes_by_name.insert(agent.name.clone(), manager.agents.len());
            manager
                .outputs_by_name
                .insert(agent.name.clone(), Arc::new(Mutex::new(AgentOutput::new(transcript))));
            manager.next_id += 1;
            manager.agents.push(agent);
        }

        Ok(manager)
    }

    #[cfg(test)]
    pub fn create(&mut self, name: String, workspace: PathBuf) -> Result<Agent> {
        self.create_with_adapter(name, "shell".to_owned(), workspace)
    }

    pub fn create_with_adapter(
        &mut self,
        name: String,
        adapter: String,
        workspace: PathBuf,
    ) -> Result<Agent> {
        let name = name.trim().to_owned();
        let adapter = adapter.trim().to_ascii_lowercase();
        if name.is_empty() {
            return Err(KairoError::InvalidArguments("agent name cannot be empty".to_owned()));
        }
        if !workspace.is_absolute() {
            return Err(KairoError::InvalidArguments(
                "agent workspace must be an absolute path".to_owned(),
            ));
        }
        if !matches!(adapter.as_str(), "shell" | "codex") {
            return Err(KairoError::InvalidArguments(
                "agent adapter must be `shell` or `codex`".to_owned(),
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
            title: name.clone(),
            adapter,
            command: None,
            workspace,
            status: AgentStatus::Stopped,
            pid: None,
            created_at_ms: timestamp,
            updated_at_ms: timestamp,
        };

        self.indexes_by_name.insert(name, self.agents.len());
        self.outputs_by_name.insert(
            agent.name.clone(),
            Arc::new(Mutex::new(AgentOutput::new(Transcript::default()))),
        );
        self.agents.push(agent.clone());
        self.storage.save_agent(&agent)?;
        Ok(agent)
    }

    pub fn list(&self) -> Vec<Agent> {
        self.agents.clone()
    }

    pub fn open_terminal(&mut self, workspace: PathBuf) -> Result<Agent> {
        let sequence = self.next_id.saturating_add(1);
        let name = format!("terminal-{}-{}", now_millis(), sequence);
        let mut agent = self.create_with_adapter(name.clone(), "shell".to_owned(), workspace)?;
        agent.title = format!("Terminal {sequence}");
        self.replace_agent(&agent)?;
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned());
        self.start(&name, vec![shell])
    }

    pub fn set_title(&mut self, name: &str, title: String) -> Result<Agent> {
        let title = title.trim().to_owned();
        if title.is_empty() {
            return Err(KairoError::InvalidArguments("terminal title cannot be empty".to_owned()));
        }
        let agent = self.agent_mut(name)?;
        agent.title = title;
        agent.updated_at_ms = now_millis();
        let snapshot = agent.clone();
        self.storage.save_agent(&snapshot)?;
        Ok(snapshot)
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
        let mut pty_command = CommandBuilder::new(program);
        pty_command.args(arguments);
        pty_command.cwd(workspace);
        let child = pair.slave.spawn_command(pty_command).map_err(runtime_error)?;
        drop(pair.slave);
        let pid = child.process_id().ok_or_else(|| {
            KairoError::Runtime("PTY child started without a process ID".to_owned())
        })?;

        let output = Arc::new(Mutex::new(AgentOutput::new(Transcript::default())));
        let agent = &mut self.agents[index];
        agent.command = Some(command);
        agent.pid = Some(pid);
        agent.status = AgentStatus::Working;
        agent.updated_at_ms = now_millis();
        let snapshot = agent.clone();
        self.storage.clear_events(&snapshot.id)?;
        self.storage.save_agent(&snapshot)?;
        let reader_output = Arc::clone(&output);
        let reader_storage = self.storage.clone();
        let agent_id = snapshot.id.clone();
        thread::spawn(move || capture_output(reader, reader_output, reader_storage, agent_id));
        self.outputs_by_name.insert(name.to_owned(), output);
        self.sessions_by_name
            .insert(name.to_owned(), PtySession { child, master: pair.master, writer });
        Ok(snapshot)
    }

    pub fn start_configured(&mut self, name: &str) -> Result<Agent> {
        let adapter = self.agents[self.agent_index(name)?].adapter.clone();
        let command = command_for_adapter(&adapter)?;
        self.start(name, command)
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
        let snapshot = agent.clone();
        self.storage.save_agent(&snapshot)?;
        Ok(snapshot)
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
            let snapshot = agent.clone();
            self.storage.save_agent(&snapshot)?;
        }
        Ok(())
    }

    pub fn logs(&self, name: &str) -> Result<String> {
        self.agent_index(name)?;
        let output = self
            .outputs_by_name
            .get(name)
            .ok_or_else(|| KairoError::Runtime(format!("agent `{name}` has no transcript")))?;
        output
            .lock()
            .map_err(|_| KairoError::Runtime(format!("agent `{name}` transcript lock is poisoned")))
            .map(|output| output.transcript.text())
    }

    pub fn send_input(&mut self, name: &str, input: &str) -> Result<()> {
        self.refresh()?;
        if !self.sessions_by_name.contains_key(name) {
            return Err(KairoError::InvalidArguments(format!("agent `{name}` is not running")));
        }
        let agent_id = self.agents[self.agent_index(name)?].id.clone();
        let mut recorded_input = input.as_bytes().to_vec();
        recorded_input.extend_from_slice(b"\r\n");
        self.storage.append_event(&agent_id, &recorded_input)?;
        if let Some(output) = self.outputs_by_name.get(name) {
            output
                .lock()
                .map_err(|_| {
                    KairoError::Runtime(format!("agent `{name}` transcript lock is poisoned"))
                })?
                .transcript
                .append(&recorded_input);
        }
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

    pub fn send_raw_input(&mut self, name: &str, input: &[u8]) -> Result<()> {
        self.refresh()?;
        let session = self.sessions_by_name.get_mut(name).ok_or_else(|| {
            KairoError::InvalidArguments(format!("agent `{name}` is not running"))
        })?;
        session.writer.write_all(input)?;
        session.writer.flush()?;
        Ok(())
    }

    pub fn resize(&mut self, name: &str, rows: u16, cols: u16) -> Result<()> {
        if rows == 0 || cols == 0 {
            return Ok(());
        }
        let session = self.sessions_by_name.get_mut(name).ok_or_else(|| {
            KairoError::InvalidArguments(format!("agent `{name}` is not running"))
        })?;
        session
            .master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(runtime_error)
    }

    pub fn attach(&mut self, name: &str) -> Result<Attachment> {
        self.refresh()?;
        if !self.sessions_by_name.contains_key(name) {
            return Err(KairoError::InvalidArguments(format!("agent `{name}` is not running")));
        }
        let output = self
            .outputs_by_name
            .get(name)
            .ok_or_else(|| KairoError::Runtime(format!("agent `{name}` has no transcript")))?;
        let mut output = output.lock().map_err(|_| {
            KairoError::Runtime(format!("agent `{name}` transcript lock is poisoned"))
        })?;
        if output.subscriber.is_some() {
            return Err(KairoError::InvalidArguments(format!(
                "agent `{name}` is already attached"
            )));
        }
        let (sender, receiver) = sync_channel(64);
        let initial_output = output.transcript.bytes();
        output.subscriber = Some(sender);
        Ok(Attachment { initial_output, receiver })
    }

    pub fn detach(&mut self, name: &str) {
        if let Some(output) = self.outputs_by_name.get(name)
            && let Ok(mut output) = output.lock()
        {
            output.subscriber = None;
        }
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

    fn replace_agent(&mut self, agent: &Agent) -> Result<()> {
        let index = self.agent_index(&agent.name)?;
        self.agents[index] = agent.clone();
        self.storage.save_agent(agent)
    }
}

#[cfg(test)]
impl Default for AgentManager {
    fn default() -> Self {
        Self::load(Storage::in_memory().expect("in-memory storage opens"))
            .expect("agent manager loads from in-memory storage")
    }
}

struct PtySession {
    child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

pub struct Attachment {
    pub initial_output: Vec<u8>,
    pub receiver: Receiver<Vec<u8>>,
}

struct AgentOutput {
    transcript: Transcript,
    subscriber: Option<SyncSender<Vec<u8>>>,
}

impl AgentOutput {
    fn new(transcript: Transcript) -> Self {
        Self { transcript, subscriber: None }
    }
}

fn capture_output(
    mut reader: Box<dyn Read + Send>,
    output: Arc<Mutex<AgentOutput>>,
    storage: Storage,
    agent_id: String,
) {
    let mut buffer = [0_u8; 4096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let subscriber = if let Ok(mut output) = output.lock() {
                    output.transcript.append(&buffer[..count]);
                    output.subscriber.clone()
                } else {
                    break;
                };
                if storage.append_event(&agent_id, &buffer[..count]).is_err() {
                    break;
                }
                if let Some(sender) = subscriber
                    && sender.send(buffer[..count].to_vec()).is_err()
                    && let Ok(mut output) = output.lock()
                {
                    output.subscriber = None;
                }
            }
        }
    }
}

fn is_active(status: &AgentStatus) -> bool {
    matches!(
        status,
        AgentStatus::Starting
            | AgentStatus::Working
            | AgentStatus::Waiting
            | AgentStatus::Idle
            | AgentStatus::Blocked
    )
}

fn command_for_adapter(adapter: &str) -> Result<Vec<String>> {
    match adapter {
        "codex" => Ok(vec!["codex".to_owned()]),
        "shell" => Err(KairoError::InvalidArguments(
            "shell agents need a command: `kairo agent start <name> -- <command>`".to_owned(),
        )),
        _ => Err(KairoError::Runtime(format!("unknown agent adapter `{adapter}`"))),
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

    use crate::{storage::Storage, transcript::TRANSCRIPT_CAPACITY};

    use super::{AgentManager, command_for_adapter, now_millis};

    #[test]
    fn opens_a_shell_terminal_with_a_persisted_title() {
        let mut manager = AgentManager::default();
        let terminal = manager.open_terminal(std::env::temp_dir()).expect("terminal opens");

        assert_eq!(terminal.adapter, "shell");
        assert_eq!(terminal.title, "Terminal 1");
        assert_eq!(terminal.status, AgentStatus::Working);
        manager.stop(&terminal.name).expect("terminal stops");
    }

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

    #[test]
    fn reload_marks_an_active_agent_interrupted_and_retains_history() {
        let storage = Storage::in_memory().expect("storage opens");
        let mut manager = AgentManager::load(storage.clone()).expect("manager loads");
        let created =
            manager.create("coder".to_owned(), std::env::temp_dir()).expect("agent is created");
        let mut active = created.clone();
        active.status = AgentStatus::Working;
        active.pid = Some(42);
        active.updated_at_ms = now_millis();
        storage.save_agent(&active).expect("active agent saves");
        storage.append_event(&created.id, b"build the project\r\n").expect("prompt saves");
        storage.append_event(&created.id, b"finished\r\n").expect("output saves");

        let restored = AgentManager::load(storage).expect("manager restores");
        assert_eq!(restored.list()[0].status, AgentStatus::Interrupted);
        assert_eq!(restored.list()[0].pid, None);
        assert_eq!(
            restored.logs("coder").expect("logs restore"),
            "build the project\r\nfinished\r\n"
        );
    }

    #[test]
    fn starting_an_agent_replaces_its_old_persisted_history() {
        let storage = Storage::in_memory().expect("storage opens");
        let mut manager = AgentManager::load(storage.clone()).expect("manager loads");
        let agent =
            manager.create("coder".to_owned(), std::env::temp_dir()).expect("agent is created");
        storage.append_event(&agent.id, b"old output\r\n").expect("history saves");

        manager
            .start("coder", vec!["/bin/sh".to_owned(), "-c".to_owned(), "printf new".to_owned()])
            .expect("agent starts");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while std::time::Instant::now() < deadline {
            if manager.logs("coder").expect("logs are readable").contains("new") {
                assert!(!manager.logs("coder").expect("logs are readable").contains("old output"));
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        panic!("new session output was not captured before the deadline");
    }

    #[test]
    fn persisted_history_remains_bounded() {
        let storage = Storage::in_memory().expect("storage opens");
        let mut manager = AgentManager::load(storage.clone()).expect("manager loads");
        let agent =
            manager.create("coder".to_owned(), std::env::temp_dir()).expect("agent is created");
        let old = vec![b'a'; TRANSCRIPT_CAPACITY / 2 + 1];
        let newest = vec![b'b'; TRANSCRIPT_CAPACITY / 2 + 1];
        storage.append_event(&agent.id, &old).expect("old output saves");
        storage.append_event(&agent.id, &newest).expect("new output saves");

        let restored = AgentManager::load(storage).expect("manager restores");
        let logs = restored.logs("coder").expect("logs restore");
        assert!(logs.len() <= TRANSCRIPT_CAPACITY);
        assert!(logs.chars().all(|character| character == 'b'));
    }

    #[test]
    fn allows_only_one_attachment_per_running_agent() {
        let mut manager = AgentManager::default();
        manager.create("coder".to_owned(), std::env::temp_dir()).expect("agent is created");
        manager.start("coder", vec!["/bin/sh".to_owned()]).expect("shell starts");

        let first = manager.attach("coder").expect("first attachment succeeds");
        assert!(manager.attach("coder").is_err());
        drop(first);
        manager.detach("coder");
        let second = manager.attach("coder").expect("attachment succeeds after detach");
        drop(second);
        manager.detach("coder");
        manager.stop("coder").expect("shell stops");
    }

    #[test]
    fn creates_a_codex_agent_with_its_configured_command() {
        let mut manager = AgentManager::default();
        let agent = manager
            .create_with_adapter("coder".to_owned(), "codex".to_owned(), std::env::temp_dir())
            .expect("agent is created");

        assert_eq!(agent.adapter, "codex");
        assert_eq!(command_for_adapter(&agent.adapter).expect("command resolves"), ["codex"]);
    }

    #[test]
    fn rejects_unknown_agent_adapters() {
        let mut manager = AgentManager::default();
        assert!(
            manager
                .create_with_adapter("coder".to_owned(), "claude".to_owned(), std::env::temp_dir())
                .is_err()
        );
    }
}
