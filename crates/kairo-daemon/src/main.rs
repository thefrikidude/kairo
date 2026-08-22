use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::{UnixListener, UnixStream},
    process::ExitCode,
};

use kairo_core::{KairoError, Request, Response, Result, RuntimePaths};

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

    for connection in listener.incoming() {
        let stream = connection?;
        if handle_client(stream)? {
            break;
        }
    }

    Ok(())
}

fn handle_client(mut stream: UnixStream) -> Result<bool> {
    let mut request_line = String::new();
    BufReader::new(stream.try_clone()?).read_line(&mut request_line)?;

    let request = serde_json::from_str::<Request>(request_line.trim_end())
        .map_err(|error| KairoError::Protocol(format!("could not decode request: {error}")))?;

    let (response, should_shutdown) = match request {
        Request::Ping => (Response::Pong, false),
        Request::Shutdown => (Response::Accepted, true),
    };
    let encoded = serde_json::to_string(&response)
        .map_err(|error| KairoError::Protocol(format!("could not encode response: {error}")))?;
    writeln!(stream, "{encoded}")?;
    stream.flush()?;

    Ok(should_shutdown)
}

struct SocketGuard {
    path: std::path::PathBuf,
}

impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
