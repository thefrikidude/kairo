use std::{
    env,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    process::{Command, ExitCode, Stdio},
    thread,
    time::Duration,
};

use kairo_core::{KairoError, Request, Response, Result, RuntimePaths};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("kairo: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<()> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    match arguments.as_slice() {
        [command, action] if command == "daemon" && action == "start" => start_daemon(),
        [command, action] if command == "daemon" && action == "status" => daemon_status(),
        [command, action] if command == "daemon" && action == "stop" => stop_daemon(),
        [command, action, name, flag, workspace]
            if command == "agent" && action == "create" && flag == "--workspace" =>
        {
            create_agent(name.to_owned(), PathBuf::from(workspace))
        }
        [command, action] if command == "agent" && action == "list" => list_agents(),
        [command, action, name, separator, command_parts @ ..]
            if command == "agent"
                && action == "start"
                && separator == "--"
                && !command_parts.is_empty() =>
        {
            start_agent(name.to_owned(), command_parts.to_vec())
        }
        [command, action, name] if command == "agent" && action == "stop" => {
            stop_agent(name.to_owned())
        }
        [command, action, name] if command == "agent" && action == "logs" => {
            show_agent_logs(name.to_owned())
        }
        _ => Err(KairoError::InvalidArguments(
            "use `kairo daemon start|status|stop`, `kairo agent create <name> --workspace <path>`, `kairo agent start <name> -- <command> [args...]`, `kairo agent stop <name>`, `kairo agent logs <name>`, or `kairo agent list`".to_owned(),
        )),
    }
}

fn start_daemon() -> Result<()> {
    if send_request(Request::Ping).is_ok() {
        println!("Kairo daemon is already running.");
        return Ok(());
    }

    let daemon = daemon_binary_path()?;
    Command::new(daemon)
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;

    for _ in 0..30 {
        thread::sleep(Duration::from_millis(50));
        if matches!(send_request(Request::Ping), Ok(Response::Pong)) {
            println!("Kairo daemon started.");
            return Ok(());
        }
    }

    Err(KairoError::DaemonUnavailable)
}

fn daemon_status() -> Result<()> {
    match send_request(Request::Ping)? {
        Response::Pong => {
            println!("Kairo daemon is running.");
            Ok(())
        }
        Response::Error { message } => Err(KairoError::Protocol(message)),
        unexpected => {
            Err(KairoError::Protocol(format!("unexpected response to ping: {unexpected:?}")))
        }
    }
}

fn stop_daemon() -> Result<()> {
    match send_request(Request::Shutdown)? {
        Response::Accepted => {
            println!("Kairo daemon is stopping.");
            Ok(())
        }
        Response::Error { message } => Err(KairoError::Protocol(message)),
        unexpected => {
            Err(KairoError::Protocol(format!("unexpected response to shutdown: {unexpected:?}")))
        }
    }
}

fn create_agent(name: String, workspace: PathBuf) -> Result<()> {
    match send_request(Request::CreateAgent { name, workspace })? {
        Response::AgentCreated { agent } => {
            println!("Created agent `{}` ({})", agent.name, agent.id);
            Ok(())
        }
        Response::Error { message } => Err(KairoError::Protocol(message)),
        unexpected => Err(KairoError::Protocol(format!(
            "unexpected response to create agent: {unexpected:?}"
        ))),
    }
}

fn list_agents() -> Result<()> {
    match send_request(Request::ListAgents)? {
        Response::Agents { agents } if agents.is_empty() => {
            println!("No agents registered.");
            Ok(())
        }
        Response::Agents { agents } => {
            for agent in agents {
                println!(
                    "{}\t{}\t{}\t{}",
                    agent.name,
                    agent.status,
                    agent.adapter,
                    agent.workspace.display()
                );
            }
            Ok(())
        }
        Response::Error { message } => Err(KairoError::Protocol(message)),
        unexpected => {
            Err(KairoError::Protocol(format!("unexpected response to list agents: {unexpected:?}")))
        }
    }
}

fn start_agent(name: String, command: Vec<String>) -> Result<()> {
    match send_request(Request::StartAgent { name, command })? {
        Response::AgentStarted { agent } => {
            let pid = agent.pid.ok_or_else(|| {
                KairoError::Protocol("daemon started an agent without a process ID".to_owned())
            })?;
            println!("Started agent `{}` (PID {pid})", agent.name);
            Ok(())
        }
        Response::Error { message } => Err(KairoError::Protocol(message)),
        unexpected => {
            Err(KairoError::Protocol(format!("unexpected response to start agent: {unexpected:?}")))
        }
    }
}

fn stop_agent(name: String) -> Result<()> {
    match send_request(Request::StopAgent { name })? {
        Response::AgentStopped { agent } => {
            println!("Stopped agent `{}`", agent.name);
            Ok(())
        }
        Response::Error { message } => Err(KairoError::Protocol(message)),
        unexpected => {
            Err(KairoError::Protocol(format!("unexpected response to stop agent: {unexpected:?}")))
        }
    }
}

fn show_agent_logs(name: String) -> Result<()> {
    match send_request(Request::GetAgentLogs { name })? {
        Response::AgentLogs { output, .. } => {
            print!("{output}");
            Ok(())
        }
        Response::Error { message } => Err(KairoError::Protocol(message)),
        unexpected => {
            Err(KairoError::Protocol(format!("unexpected response to agent logs: {unexpected:?}")))
        }
    }
}

fn send_request(request: Request) -> Result<Response> {
    let paths = RuntimePaths::discover()?;
    let mut stream =
        UnixStream::connect(paths.socket_path()).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused => {
                KairoError::DaemonUnavailable
            }
            _ => KairoError::Io(error),
        })?;

    let encoded = serde_json::to_string(&request)
        .map_err(|error| KairoError::Protocol(format!("could not encode request: {error}")))?;
    writeln!(stream, "{encoded}")?;
    stream.flush()?;

    let mut response_line = String::new();
    BufReader::new(stream).read_line(&mut response_line)?;
    serde_json::from_str(response_line.trim_end())
        .map_err(|error| KairoError::Protocol(format!("could not decode response: {error}")))
}

fn daemon_binary_path() -> Result<PathBuf> {
    if let Some(path) = env::var_os("KAIRO_DAEMON_BIN") {
        return Ok(PathBuf::from(path));
    }

    let current_binary = env::current_exe()?;
    let daemon =
        current_binary.parent().ok_or(KairoError::DaemonBinaryNotFound)?.join("kairo-daemon");
    daemon.exists().then_some(daemon).ok_or(KairoError::DaemonBinaryNotFound)
}
