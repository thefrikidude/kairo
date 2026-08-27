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
        MouseButton, MouseEventKind,
    },
    execute,
    terminal::{self, EnterAlternateScreen, LeaveAlternateScreen},
};
use kairo_core::{
    Agent, AgentStatus, AttachFrame, KairoError, Request, Response, Result, read_attach_frame,
    write_attach_frame,
};
use ratatui::{
    Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::Line,
    widgets::{Block, Borders, Paragraph, Wrap},
};

use crate::{connect_attachment, key_to_bytes, send_request};

const REFRESH_INTERVAL: Duration = Duration::from_millis(300);
const SCROLLBACK_ROWS: usize = 2_000;
const SIDEBAR_WIDTH: u16 = 28;

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
            handle_event(&mut app, event, terminal.size()?.into())?;
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

fn handle_event(app: &mut App, event: Event, size: Rect) -> Result<()> {
    if let Event::Mouse(mouse) = &event
        && mouse.kind == MouseEventKind::Down(MouseButton::Left)
        && let Some(index) =
            sidebar_agent_index(&app.agents, sidebar_area(size), mouse.column, mouse.row)
    {
        app.open_agent(index);
        return Ok(());
    }

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
            _ => {}
        }
        return Ok(());
    }

    if let Event::Key(key) = event
        && key.kind == KeyEventKind::Press
    {
        match key.code {
            KeyCode::Char('q') | KeyCode::Esc => app.should_quit = true,
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
    let rows = size.height.saturating_sub(3).max(1);
    let cols = size.width.saturating_sub(SIDEBAR_WIDTH).saturating_sub(2).max(1);
    app.resize_live(rows, cols);
}

#[derive(Default)]
struct App {
    agents: Vec<Agent>,
    error: Option<String>,
    live: Option<LiveTerminal>,
    should_quit: bool,
}

impl App {
    fn refresh(&mut self) {
        let agents = match send_request(Request::ListAgents) {
            Ok(Response::Agents { agents }) => running_agents(agents),
            Ok(Response::Error { message }) => return self.set_error(message),
            Ok(unexpected) => {
                return self.set_error(format!("unexpected daemon response: {unexpected:?}"));
            }
            Err(error) => return self.set_error(error.to_string()),
        };

        let live_agent_still_running = self
            .live
            .as_ref()
            .is_none_or(|live| agents.iter().any(|agent| agent.name == live.name));
        self.agents = agents;
        if !live_agent_still_running {
            self.detach_live();
        }
    }

    fn open_agent(&mut self, index: usize) {
        let Some(name) = self.agents.get(index).map(|agent| agent.name.clone()) else {
            return;
        };
        if self.live.as_ref().is_some_and(|live| live.name == name) {
            return;
        }
        self.detach_live();
        match LiveTerminal::connect(&name) {
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

fn running_agents(agents: Vec<Agent>) -> Vec<Agent> {
    agents.into_iter().filter(|agent| agent.status == AgentStatus::Working).collect()
}

struct LiveTerminal {
    name: String,
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
            name: name.to_owned(),
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
    let sidebar = sidebar_area(frame.area());
    let main = main_area(frame.area());
    let footer = footer_area(frame.area());
    render_sidebar(frame, app, sidebar);

    let (title, content) = if let Some(live) = &app.live {
        (format!(" {} ", live.name), live.contents())
    } else {
        (" Workspace ".to_owned(), String::new())
    };
    let terminal = Paragraph::new(content)
        .block(Block::default().borders(Borders::ALL).title(title))
        .wrap(Wrap { trim: false });
    frame.render_widget(terminal, main);

    let footer_text = if let Some(error) = &app.error {
        format!(" {error} ")
    } else if app.live.is_some() {
        " Live agent input · click an agent to switch · Ctrl-] for dashboard ".to_owned()
    } else {
        " Click an agent to open it · q: quit · r: refresh ".to_owned()
    };
    frame.render_widget(
        Paragraph::new(footer_text).style(Style::default().fg(Color::DarkGray)),
        footer,
    );
}

fn render_sidebar(frame: &mut ratatui::Frame, app: &App, area: Rect) {
    let active_name = app.live.as_ref().map(|live| live.name.as_str());
    let lines = if app.agents.is_empty() {
        vec![Line::styled(" No agents running", Style::default().fg(Color::DarkGray))]
    } else {
        app.agents
            .iter()
            .map(|agent| {
                let active = active_name == Some(agent.name.as_str());
                let style = if active {
                    Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(Color::Gray)
                };
                Line::styled(format!(" {} · {}", agent.name, agent.status), style)
            })
            .collect()
    };
    let sidebar =
        Paragraph::new(lines).block(Block::default().borders(Borders::ALL).title(" Agents "));
    frame.render_widget(sidebar, area);
}

fn sidebar_area(area: Rect) -> Rect {
    let content = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(1)])
        .split(area)[0];
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(SIDEBAR_WIDTH), Constraint::Min(1)])
        .split(content)[0]
}

fn main_area(area: Rect) -> Rect {
    let content = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(1)])
        .split(area)[0];
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(SIDEBAR_WIDTH), Constraint::Min(1)])
        .split(content)[1]
}

fn footer_area(area: Rect) -> Rect {
    Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(1)])
        .split(area)[1]
}

fn sidebar_agent_index(agents: &[Agent], sidebar: Rect, column: u16, row: u16) -> Option<usize> {
    let first_agent_row = sidebar.y.saturating_add(1);
    let content_right = sidebar.x.saturating_add(sidebar.width).saturating_sub(1);
    if column <= sidebar.x || column >= content_right || row < first_agent_row {
        return None;
    }
    let index = usize::from(row.saturating_sub(first_agent_row));
    let content_bottom = sidebar.y.saturating_add(sidebar.height).saturating_sub(1);
    (row < content_bottom && index < agents.len()).then_some(index)
}

impl Drop for App {
    fn drop(&mut self) {
        self.detach_live();
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use kairo_core::{Agent, AgentStatus};
    use ratatui::layout::Rect;

    use super::{running_agents, sidebar_agent_index};

    fn agent(name: &str, status: AgentStatus) -> Agent {
        Agent {
            id: name.to_owned(),
            name: name.to_owned(),
            adapter: "shell".to_owned(),
            command: None,
            workspace: PathBuf::from("/tmp"),
            status,
            pid: None,
            created_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    #[test]
    fn sidebar_shows_only_working_agents() {
        let agents = running_agents(vec![
            agent("working", AgentStatus::Working),
            agent("stopped", AgentStatus::Stopped),
            agent("completed", AgentStatus::Completed),
            agent("failed", AgentStatus::Failed),
            agent("interrupted", AgentStatus::Interrupted),
        ]);

        assert_eq!(agents.into_iter().map(|agent| agent.name).collect::<Vec<_>>(), ["working"]);
    }

    #[test]
    fn sidebar_click_maps_to_the_agent_row() {
        let agents =
            vec![agent("first", AgentStatus::Working), agent("second", AgentStatus::Working)];
        let sidebar = Rect::new(0, 0, 28, 10);

        assert_eq!(sidebar_agent_index(&agents, sidebar, 4, 1), Some(0));
        assert_eq!(sidebar_agent_index(&agents, sidebar, 4, 2), Some(1));
        assert_eq!(sidebar_agent_index(&agents, sidebar, 30, 1), None);
        assert_eq!(sidebar_agent_index(&agents, sidebar, 4, 0), None);
    }
}
