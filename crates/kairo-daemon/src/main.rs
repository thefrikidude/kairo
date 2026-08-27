mod agents;
mod storage;
mod transcript;

use std::{
    fs,
    io::{Read, Write},
    os::unix::net::{UnixListener, UnixStream},
    process::ExitCode,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

use kairo_core::{
    AttachFrame, KairoError, Request, Response, Result, RuntimePaths, read_attach_frame,
    write_attach_frame,
};

use agents::{AgentManager, Attachment};
use storage::Storage;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("kairo-daemon: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<()> {
    if std::env::args().nth(1).as_deref() != Some("serve") {
        return Err(KairoError::InvalidArguments("expected `kairo-daemon serve`".to_owned()));
    }
    let paths = RuntimePaths::discover()?;
    paths.ensure_exists()?;
    let socket_path = paths.socket_path();
    if socket_path.exists() {
        if UnixStream::connect(&socket_path).is_ok() {
            return Err(KairoError::DaemonAlreadyRunning);
        }
        fs::remove_file(&socket_path)?;
    }

    let listener = UnixListener::bind(&socket_path)?;
    listener.set_nonblocking(true)?;
    let _socket_guard = SocketGuard { path: socket_path };
    let agents = Arc::new(Mutex::new(AgentManager::load(Storage::open(&paths.database_path())?)?));
    let running = Arc::new(AtomicBool::new(true));

    while running.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false)?;
                let agents = Arc::clone(&agents);
                let running = Arc::clone(&running);
                thread::spawn(move || {
                    if let Err(error) = handle_client(stream, agents, running) {
                        eprintln!("kairo-daemon: client connection failed: {error}");
                    }
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn handle_client(
    mut stream: UnixStream,
    agents: Arc<Mutex<AgentManager>>,
    running: Arc<AtomicBool>,
) -> Result<()> {
    let request = read_json_line(&mut stream).and_then(|line| {
        serde_json::from_str::<Request>(&line)
            .map_err(|error| KairoError::Protocol(format!("could not decode request: {error}")))
    });
    let request = match request {
        Ok(request) => request,
        Err(error) => {
            write_response(&mut stream, &Response::Error { message: error.to_string() })?;
            return Ok(());
        }
    };
    if let Request::AttachAgent { name } = request {
        return attach_client(stream, agents, name);
    }

    let (response, should_shutdown) = dispatch(request, &agents);
    write_response(&mut stream, &response)?;
    if should_shutdown {
        running.store(false, Ordering::SeqCst);
    }
    Ok(())
}

fn attach_client(
    mut stream: UnixStream,
    agents: Arc<Mutex<AgentManager>>,
    name: String,
) -> Result<()> {
    let attachment = match agents.lock().map_err(lock_error)?.attach(&name) {
        Ok(attachment) => attachment,
        Err(error) => {
            write_response(&mut stream, &Response::Error { message: error.to_string() })?;
            return Ok(());
        }
    };
    write_response(&mut stream, &Response::AgentAttached { name: name.clone() })?;

    let writer_stream = stream.try_clone()?;
    let output_thread = thread::spawn(move || forward_output(writer_stream, attachment));
    loop {
        let frame = match read_attach_frame(&mut stream) {
            Ok(frame) => frame,
            Err(error) => {
                eprintln!("kairo-daemon: attachment `{name}` ended: {error}");
                break;
            }
        };
        match frame {
            AttachFrame::Input(input) => {
                if let Err(error) = agents.lock().map_err(lock_error)?.send_raw_input(&name, &input)
                {
                    break_with_error(&mut stream, error)?;
                    break;
                }
            }
            AttachFrame::Interrupt => {
                if let Err(error) = agents.lock().map_err(lock_error)?.interrupt(&name) {
                    break_with_error(&mut stream, error)?;
                    break;
                }
            }
            AttachFrame::Detach => break,
            AttachFrame::Resize { rows, cols } => {
                if let Err(error) = agents.lock().map_err(lock_error)?.resize(&name, rows, cols) {
                    break_with_error(&mut stream, error)?;
                    break;
                }
            }
            AttachFrame::Output(_) => break,
        }
    }
    agents.lock().map_err(lock_error)?.detach(&name);
    let _ = stream.shutdown(std::net::Shutdown::Both);
    let _ = output_thread.join();
    Ok(())
}

fn forward_output(mut stream: UnixStream, attachment: Attachment) -> Result<()> {
    write_attach_frame(&mut stream, &AttachFrame::Output(attachment.initial_output))?;
    for output in attachment.receiver {
        write_attach_frame(&mut stream, &AttachFrame::Output(output))?;
    }
    Ok(())
}

fn dispatch(request: Request, agents: &Arc<Mutex<AgentManager>>) -> (Response, bool) {
    let mut agents = match agents.lock().map_err(lock_error) {
        Ok(agents) => agents,
        Err(error) => return (Response::Error { message: error.to_string() }, false),
    };
    if let Err(error) = agents.refresh() {
        return (Response::Error { message: error.to_string() }, false);
    }
    match request {
        Request::Ping => (Response::Pong, false),
        Request::Shutdown => match agents.shutdown() {
            Ok(()) => (Response::Accepted, true),
            Err(error) => (Response::Error { message: error.to_string() }, false),
        },
        Request::CreateAgent { name, adapter, workspace } => agents
            .create_with_adapter(name, adapter, workspace)
            .map_or_else(error_response, |agent| (Response::AgentCreated { agent }, false)),
        Request::OpenTerminal { workspace } => agents
            .open_terminal(workspace)
            .map_or_else(error_response, |agent| (Response::TerminalOpened { agent }, false)),
        Request::SetAgentTitle { name, title } => agents
            .set_title(&name, title)
            .map_or_else(error_response, |agent| (Response::AgentTitleUpdated { agent }, false)),
        Request::DeleteAgent { name } => agents
            .delete(&name)
            .map_or_else(error_response, |_| (Response::AgentDeleted { name }, false)),
        Request::ListAgents => (Response::Agents { agents: agents.list() }, false),
        Request::StartAgent { name, command } => agents
            .start(&name, command)
            .map_or_else(error_response, |agent| (Response::AgentStarted { agent }, false)),
        Request::StartConfiguredAgent { name } => agents
            .start_configured(&name)
            .map_or_else(error_response, |agent| (Response::AgentStarted { agent }, false)),
        Request::StopAgent { name } => agents
            .stop(&name)
            .map_or_else(error_response, |agent| (Response::AgentStopped { agent }, false)),
        Request::GetAgentLogs { name } => agents
            .logs(&name)
            .map_or_else(error_response, |output| (Response::AgentLogs { name, output }, false)),
        Request::SendAgentInput { name, input } => agents
            .send_input(&name, &input)
            .map_or_else(error_response, |_| (Response::AgentInputSent { name }, false)),
        Request::InterruptAgent { name } => agents
            .interrupt(&name)
            .map_or_else(error_response, |_| (Response::AgentInterrupted { name }, false)),
        Request::AttachAgent { .. } => unreachable!("attach requests are handled before dispatch"),
    }
}

fn error_response(error: KairoError) -> (Response, bool) {
    (Response::Error { message: error.to_string() }, false)
}

fn read_json_line(stream: &mut UnixStream) -> Result<String> {
    let mut bytes = Vec::new();
    loop {
        let mut byte = [0_u8; 1];
        stream.read_exact(&mut byte)?;
        if byte[0] == b'\n' {
            return String::from_utf8(bytes)
                .map_err(|_| KairoError::Protocol("request is not valid UTF-8".to_owned()));
        }
        bytes.push(byte[0]);
        if bytes.len() > 1024 * 1024 {
            return Err(KairoError::Protocol("request is too large".to_owned()));
        }
    }
}

fn write_response(stream: &mut UnixStream, response: &Response) -> Result<()> {
    let encoded = serde_json::to_string(response)
        .map_err(|error| KairoError::Protocol(format!("could not encode response: {error}")))?;
    writeln!(stream, "{encoded}")?;
    stream.flush()?;
    Ok(())
}

fn break_with_error(stream: &mut UnixStream, error: KairoError) -> Result<()> {
    write_attach_frame(stream, &AttachFrame::Output(format!("\r\nkairo: {error}\r\n").into_bytes()))
}

fn lock_error<T>(_error: std::sync::PoisonError<T>) -> KairoError {
    KairoError::Runtime("agent manager lock is poisoned".to_owned())
}

struct SocketGuard {
    path: std::path::PathBuf,
}

impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
