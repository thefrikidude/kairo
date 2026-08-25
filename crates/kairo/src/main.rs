use std::{
    env,
    io::{BufRead, BufReader, Read, Write},
    os::unix::net::UnixStream,
    os::unix::process::CommandExt,
    path::PathBuf,
    process::{Command, ExitCode, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind, KeyModifiers},
    terminal,
};
use kairo_core::{
    AttachFrame, KairoError, Request, Response, Result, RuntimePaths, read_attach_frame,
    write_attach_frame,
};

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
        [command, action, name, separator, input_parts @ ..]
            if command == "agent"
                && action == "send"
                && separator == "--"
                && !input_parts.is_empty() =>
        {
            send_agent_input(name.to_owned(), input_parts.join(" "))
        }
        [command, action, name] if command == "agent" && action == "interrupt" => {
            interrupt_agent(name.to_owned())
        }
        [command, action, name] if command == "agent" && action == "attach" => {
            attach_agent(name.to_owned())
        }
        _ => Err(KairoError::InvalidArguments(
            "use `kairo daemon start|status|stop`, `kairo agent create <name> --workspace <path>`, `kairo agent start <name> -- <command> [args...]`, `kairo agent stop|logs|interrupt|attach <name>`, `kairo agent send <name> -- <text>`, or `kairo agent list`".to_owned(),
        )),
    }
}

fn start_daemon() -> Result<()> {
    if send_request(Request::Ping).is_ok() {
        println!("Kairo daemon is already running.");
        return Ok(());
    }

    let daemon = daemon_binary_path()?;
    let mut command = Command::new(daemon);
    command.arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.spawn()?;

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

fn send_agent_input(name: String, input: String) -> Result<()> {
    match send_request(Request::SendAgentInput { name, input })? {
        Response::AgentInputSent { name } => {
            println!("Sent input to agent `{name}`");
            Ok(())
        }
        Response::Error { message } => Err(KairoError::Protocol(message)),
        unexpected => Err(KairoError::Protocol(format!(
            "unexpected response to send agent input: {unexpected:?}"
        ))),
    }
}

fn interrupt_agent(name: String) -> Result<()> {
    match send_request(Request::InterruptAgent { name })? {
        Response::AgentInterrupted { name } => {
            println!("Interrupted agent `{name}`");
            Ok(())
        }
        Response::Error { message } => Err(KairoError::Protocol(message)),
        unexpected => Err(KairoError::Protocol(format!(
            "unexpected response to interrupt agent: {unexpected:?}"
        ))),
    }
}

fn attach_agent(name: String) -> Result<()> {
    let paths = RuntimePaths::discover()?;
    let mut stream =
        UnixStream::connect(paths.socket_path()).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused => {
                KairoError::DaemonUnavailable
            }
            _ => KairoError::Io(error),
        })?;
    let request = serde_json::to_string(&Request::AttachAgent { name: name.clone() })
        .map_err(|error| KairoError::Protocol(format!("could not encode request: {error}")))?;
    writeln!(stream, "{request}")?;
    stream.flush()?;

    match read_response_line(&mut stream)? {
        Response::AgentAttached { .. } => {}
        Response::Error { message } => return Err(KairoError::Protocol(message)),
        unexpected => {
            return Err(KairoError::Protocol(format!(
                "unexpected response to attach agent: {unexpected:?}"
            )));
        }
    }

    println!("Attached to `{name}`. Press Enter to send, Ctrl-C to interrupt, Ctrl-] to detach.");
    let output_stream = stream.try_clone()?;
    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    let output_stdout = Arc::clone(&stdout);
    let output_thread = thread::spawn(move || forward_agent_output(output_stream, output_stdout));
    let raw_mode = RawModeGuard::enable()?;
    let input_result = collect_attachment_input(&mut stream, stdout);
    drop(raw_mode);
    let _ = write_attach_frame(&mut stream, &AttachFrame::Detach);
    let _ = stream.shutdown(std::net::Shutdown::Write);
    let _ = output_thread.join();
    input_result
}

fn collect_attachment_input(
    stream: &mut UnixStream,
    stdout: Arc<Mutex<std::io::Stdout>>,
) -> Result<()> {
    let mut input = String::new();
    loop {
        match event::read()? {
            Event::Key(key) if key.kind == KeyEventKind::Press => match key.code {
                KeyCode::Char(']') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    return Ok(());
                }
                KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    write_attach_frame(stream, &AttachFrame::Interrupt)?;
                }
                KeyCode::Enter => {
                    write_stdout(&stdout, b"\r\n")?;
                    if !input.is_empty() {
                        write_attach_frame(
                            stream,
                            &AttachFrame::Input(std::mem::take(&mut input)),
                        )?;
                    }
                }
                KeyCode::Backspace => {
                    if input.pop().is_some() {
                        write_stdout(&stdout, b"\x08 \x08")?;
                    }
                }
                KeyCode::Char(character) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                    input.push(character);
                    write_stdout(&stdout, character.to_string().as_bytes())?;
                }
                _ => {}
            },
            _ => {}
        }
    }
}

fn forward_agent_output(mut stream: UnixStream, stdout: Arc<Mutex<std::io::Stdout>>) -> Result<()> {
    while let Ok(frame) = read_attach_frame(&mut stream) {
        if let AttachFrame::Output(output) = frame {
            write_stdout(&stdout, &output)?;
        }
    }
    Ok(())
}

fn write_stdout(stdout: &Arc<Mutex<std::io::Stdout>>, bytes: &[u8]) -> Result<()> {
    let mut stdout =
        stdout.lock().map_err(|_| KairoError::Runtime("stdout lock is poisoned".to_owned()))?;
    stdout.write_all(bytes)?;
    stdout.flush()?;
    Ok(())
}

struct RawModeGuard;

impl RawModeGuard {
    fn enable() -> Result<Self> {
        terminal::enable_raw_mode()?;
        Ok(Self)
    }
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        let _ = terminal::disable_raw_mode();
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

fn read_response_line(stream: &mut UnixStream) -> Result<Response> {
    let mut bytes = Vec::new();
    loop {
        let mut byte = [0_u8; 1];
        stream.read_exact(&mut byte)?;
        if byte[0] == b'\n' {
            return serde_json::from_slice(&bytes).map_err(|error| {
                KairoError::Protocol(format!("could not decode response: {error}"))
            });
        }
        bytes.push(byte[0]);
        if bytes.len() > 1024 * 1024 {
            return Err(KairoError::Protocol("response is too large".to_owned()));
        }
    }
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
