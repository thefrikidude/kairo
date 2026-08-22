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
        _ => Err(KairoError::InvalidArguments(
            "use `kairo daemon start`, `kairo daemon status`, or `kairo daemon stop`".to_owned(),
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
