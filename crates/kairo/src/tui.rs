use std::{
    io,
    net::Shutdown,
    os::unix::net::UnixStream,
    sync::mpsc::{self, Receiver},
    thread,
    time::{Duration, Instant},
};

use crossterm::{
    event::{
        self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind, KeyModifiers,
    },
    execute,
    terminal::{self, EnterAlternateScreen, LeaveAlternateScreen},
};
use kairo_core::{
    Agent, AttachFrame, KairoError, Request, Response, Result, read_attach_frame,
    write_attach_frame,
};
use ratatui::{
    Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::Line,
    widgets::{Block, Borders, Paragraph, Tabs, Wrap},
};

use crate::{connect_attachment, key_to_bytes, send_request};

const REFRESH_INTERVAL: Duration = Duration::from_millis(300);
const SCROLLBACK_ROWS: usize = 2_000;

pub fn run() -> Result<()> {
    let mut terminal = setup_terminal()?;
    let result = run_app(&mut terminal);
    restore_terminal(&mut terminal)?;
    result
}

type KairoTerminal = Terminal<CrosstermBackend<io::Stdout>>;

fn setup_terminal() -> Result<KairoTerminal> {
    terminal::enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    Terminal::new(CrosstermBackend::new(stdout)).map_err(KairoError::Io)
}

fn restore_terminal(terminal: &mut KairoTerminal) -> Result<()> {
    terminal::disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen, DisableMouseCapture)?;
    terminal.show_cursor().map_err(KairoError::Io)
}

fn run_app(terminal: &mut KairoTerminal) -> Result<()> {
    let mut app = App::default();
    app.refresh();
    let mut last_refresh = Instant::now();

    loop {
        app.drain_live_output();
        sync_live_size(terminal, &mut app);
        terminal.draw(|frame| render(frame, &app)).map_err(KairoError::Io)?;

        let timeout = REFRESH_INTERVAL.saturating_sub(last_refresh.elapsed());
        if event::poll(timeout)?
            && let event = event::read()?
        {
            handle_event(&mut app, event)?;
        }
        if last_refresh.elapsed() >= REFRESH_INTERVAL {
            app.refresh();
            last_refresh = Instant::now();
        }
        if app.should_quit {
            return Ok(());
        }
    }
}

fn handle_event(app: &mut App, event: Event) -> Result<()> {
    if app.live.is_some() {
        match event {
            Event::Key(key)
                if key.kind == KeyEventKind::Press && is_detach_key(key.code, key.modifiers) =>
            {
                app.detach_live();
            }
            Event::Key(key) if key.kind == KeyEventKind::Press => {
                if let Some(bytes) = key_to_bytes(key.code, key.modifiers) {
                    app.send_live(AttachFrame::Input(bytes));
                }
            }
            Event::Paste(text) => app.send_live(AttachFrame::Input(text.into_bytes())),
            Event::Resize(_, _) => {}
            _ => {}
        }
        return Ok(());
    }

    if let Event::Key(key) = event
        && key.kind == KeyEventKind::Press
    {
        match key.code {
            KeyCode::Char('q') | KeyCode::Esc => app.should_quit = true,
            KeyCode::Right | KeyCode::Char('l') | KeyCode::Tab => app.next(),
            KeyCode::Left | KeyCode::Char('h') | KeyCode::BackTab => app.previous(),
            KeyCode::Enter => app.attach_selected(),
            KeyCode::Char('r') => app.refresh(),
            _ => {}
        }
    }
    Ok(())
}

fn is_detach_key(code: KeyCode, modifiers: KeyModifiers) -> bool {
    (code == KeyCode::Char(']') && modifiers.contains(KeyModifiers::CONTROL))
        // Unix terminals encode Ctrl-] as byte 0x1d. Crossterm represents that
        // legacy control byte as Ctrl-5 on macOS and other Unix terminals.
        || (code == KeyCode::Char('5') && modifiers.contains(KeyModifiers::CONTROL))
}

fn sync_live_size(terminal: &KairoTerminal, app: &mut App) {
    let Ok(size) = terminal.size() else {
        return;
    };
    let rows = size.height.saturating_sub(6).max(1);
    let cols = size.width.saturating_sub(2).max(1);
    app.resize_live(rows, cols);
}

#[derive(Default)]
struct App {
    agents: Vec<Agent>,
    selected: usize,
    logs: String,
    error: Option<String>,
    live: Option<LiveTerminal>,
    should_quit: bool,
}

impl App {
    fn refresh(&mut self) {
        let agents = match send_request(Request::ListAgents) {
            Ok(Response::Agents { agents }) => agents,
            Ok(Response::Error { message }) => return self.set_error(message),
            Ok(unexpected) => {
                return self.set_error(format!("unexpected daemon response: {unexpected:?}"));
            }
            Err(error) => return self.set_error(error.to_string()),
        };
        self.agents = agents;
        self.selected = self.selected.min(self.agents.len().saturating_sub(1));
        self.error = None;
        if self.live.is_none() {
            self.load_selected_logs();
        }
    }

    fn load_selected_logs(&mut self) {
        self.logs.clear();
        if let Some(agent) = self.agents.get(self.selected) {
            match send_request(Request::GetAgentLogs { name: agent.name.clone() }) {
                Ok(Response::AgentLogs { output, .. }) => self.logs = output,
                Ok(Response::Error { message }) => self.set_error(message),
                Ok(unexpected) => {
                    self.set_error(format!("unexpected daemon response: {unexpected:?}"))
                }
                Err(error) => self.set_error(error.to_string()),
            }
        }
    }

    fn next(&mut self) {
        if !self.agents.is_empty() {
            self.selected = (self.selected + 1) % self.agents.len();
            self.load_selected_logs();
        }
    }

    fn previous(&mut self) {
        if !self.agents.is_empty() {
            self.selected = (self.selected + self.agents.len() - 1) % self.agents.len();
            self.load_selected_logs();
        }
    }

    fn attach_selected(&mut self) {
        let Some(agent) = self.agents.get(self.selected) else {
            self.set_error("create and start an agent first".to_owned());
            return;
        };
        match LiveTerminal::connect(&agent.name) {
            Ok(live) => {
                self.live = Some(live);
                self.error = None;
            }
            Err(error) => self.set_error(error.to_string()),
        }
    }

    fn detach_live(&mut self) {
        if let Some(live) = self.live.take() {
            live.close();
        }
        self.load_selected_logs();
    }

    fn send_live(&mut self, frame: AttachFrame) {
        if let Some(live) = &mut self.live
            && let Err(error) = write_attach_frame(&mut live.stream, &frame)
        {
            self.set_error(error.to_string());
        }
    }

    fn resize_live(&mut self, rows: u16, cols: u16) {
        if let Some(live) = &mut self.live {
            live.resize(rows, cols);
        }
    }

    fn drain_live_output(&mut self) {
        let Some(live) = &mut self.live else {
            return;
        };
        while let Ok(output) = live.output.try_recv() {
            live.parser.process(&output);
        }
    }

    fn set_error(&mut self, message: String) {
        self.error = Some(message);
    }
}

struct LiveTerminal {
    stream: UnixStream,
    output: Receiver<Vec<u8>>,
    reader: thread::JoinHandle<()>,
    parser: vt100::Parser,
    rows: u16,
    cols: u16,
}

impl LiveTerminal {
    fn connect(name: &str) -> Result<Self> {
        let stream = connect_attachment(name)?;
        let mut output_stream = stream.try_clone()?;
        let (sender, output) = mpsc::channel();
        let reader = thread::spawn(move || {
            while let Ok(frame) = read_attach_frame(&mut output_stream) {
                if let AttachFrame::Output(bytes) = frame
                    && sender.send(bytes).is_err()
                {
                    break;
                }
            }
        });
        Ok(Self {
            stream,
            output,
            reader,
            parser: vt100::Parser::new(24, 80, SCROLLBACK_ROWS),
            rows: 24,
            cols: 80,
        })
    }

    fn resize(&mut self, rows: u16, cols: u16) {
        if self.rows == rows && self.cols == cols {
            return;
        }
        self.rows = rows;
        self.cols = cols;
        self.parser.screen_mut().set_size(rows, cols);
        let _ = write_attach_frame(&mut self.stream, &AttachFrame::Resize { rows, cols });
    }

    fn close(mut self) {
        let _ = write_attach_frame(&mut self.stream, &AttachFrame::Detach);
        let _ = self.stream.shutdown(Shutdown::Write);
        let _ = self.reader.join();
    }

    fn contents(&self) -> String {
        self.parser.screen().rows(0, self.cols).collect::<Vec<_>>().join("\n")
    }
}

fn render(frame: &mut ratatui::Frame, app: &App) {
    let areas = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(3), Constraint::Min(3), Constraint::Length(1)])
        .split(frame.area());

    let titles = if app.agents.is_empty() {
        vec![Line::from("No agents")]
    } else {
        app.agents
            .iter()
            .map(|agent| Line::from(format!(" {} · {} ", agent.name, agent.status)))
            .collect()
    };
    let tabs = Tabs::new(titles)
        .block(Block::default().borders(Borders::ALL).title(" Kairo "))
        .select(app.selected)
        .highlight_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD));
    frame.render_widget(tabs, areas[0]);

    let (title, content) = if let Some(live) = &app.live {
        let agent = app.agents.get(app.selected);
        let name = agent.map_or("agent", |agent| agent.name.as_str());
        (format!(" {name} · live terminal "), live.contents())
    } else if let Some(error) = &app.error {
        (" Daemon error ".to_owned(), error.clone())
    } else if let Some(agent) = app.agents.get(app.selected) {
        (
            format!(" {} · {} · {} ", agent.name, agent.adapter, agent.status),
            if app.logs.is_empty() {
                "No retained output yet.".to_owned()
            } else {
                app.logs.clone()
            },
        )
    } else {
        (" Kairo ".to_owned(), "Create and start an agent from the CLI, then press r.".to_owned())
    };
    let terminal = Paragraph::new(content)
        .block(Block::default().borders(Borders::ALL).title(title))
        .wrap(Wrap { trim: false });
    frame.render_widget(terminal, areas[1]);

    let footer = if app.live.is_some() {
        " Live agent input · Ctrl-]: return to Kairo controls "
    } else {
        " Enter: open selected agent   q: quit   ←/→ or h/l: switch tabs   r: refresh "
    };
    frame.render_widget(
        Paragraph::new(footer).style(Style::default().fg(Color::DarkGray)),
        areas[2],
    );
}

impl Drop for App {
    fn drop(&mut self) {
        self.detach_live();
    }
}
