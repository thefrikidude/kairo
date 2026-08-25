mod agents;
mod storage;
mod transcript;

use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::{UnixListener, UnixStream},
    process::ExitCode,
};

use kairo_core::{KairoError, Request, Response, Result, RuntimePaths};

use agents::AgentManager;
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
    let _socket_guard = SocketGuard { path: socket_path };
    let storage = Storage::open(&paths.database_path())?;
    let mut agents = AgentManager::load(storage)?;

    for connection in listener.incoming() {
        let stream = connection?;
        if handle_client(stream, &mut agents)? {
            break;
        }
    }

    Ok(())
}

fn handle_client(mut stream: UnixStream, agents: &mut AgentManager) -> Result<bool> {
    let mut request_line = String::new();
    BufReader::new(stream.try_clone()?).read_line(&mut request_line)?;

    let (response, should_shutdown) = match serde_json::from_str::<Request>(request_line.trim_end())
    {
        Ok(request) => dispatch(request, agents),
        Err(error) => {
            (Response::Error { message: format!("could not decode request: {error}") }, false)
        }
    };
    let encoded = serde_json::to_string(&response)
        .map_err(|error| KairoError::Protocol(format!("could not encode response: {error}")))?;
    writeln!(stream, "{encoded}")?;
    stream.flush()?;

    Ok(should_shutdown)
}

fn dispatch(request: Request, agents: &mut AgentManager) -> (Response, bool) {
    if let Err(error) = agents.refresh() {
        return (Response::Error { message: error.to_string() }, false);
    }

    match request {
        Request::Ping => (Response::Pong, false),
        Request::Shutdown => match agents.shutdown() {
            Ok(()) => (Response::Accepted, true),
            Err(error) => (Response::Error { message: error.to_string() }, false),
        },
        Request::CreateAgent { name, workspace } => match agents.create(name, workspace) {
            Ok(agent) => (Response::AgentCreated { agent }, false),
            Err(error) => (Response::Error { message: error.to_string() }, false),
        },
        Request::ListAgents => (Response::Agents { agents: agents.list() }, false),
        Request::StartAgent { name, command } => match agents.start(&name, command) {
            Ok(agent) => (Response::AgentStarted { agent }, false),
            Err(error) => (Response::Error { message: error.to_string() }, false),
        },
        Request::StopAgent { name } => match agents.stop(&name) {
            Ok(agent) => (Response::AgentStopped { agent }, false),
            Err(error) => (Response::Error { message: error.to_string() }, false),
        },
        Request::GetAgentLogs { name } => match agents.logs(&name) {
            Ok(output) => (Response::AgentLogs { name, output }, false),
            Err(error) => (Response::Error { message: error.to_string() }, false),
        },
        Request::SendAgentInput { name, input } => match agents.send_input(&name, &input) {
            Ok(()) => (Response::AgentInputSent { name }, false),
            Err(error) => (Response::Error { message: error.to_string() }, false),
        },
        Request::InterruptAgent { name } => match agents.interrupt(&name) {
            Ok(()) => (Response::AgentInterrupted { name }, false),
            Err(error) => (Response::Error { message: error.to_string() }, false),
        },
    }
}

struct SocketGuard {
    path: std::path::PathBuf,
}

impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
