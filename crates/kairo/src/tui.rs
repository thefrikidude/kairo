use std::{
    io,
    time::{Duration, Instant},
};

use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{self, EnterAlternateScreen, LeaveAlternateScreen},
};
use kairo_core::{Agent, AgentStatus, KairoError, Request, Response, Result};
use ratatui::{
    Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::Line,
    widgets::{Block, Borders, Paragraph, Tabs, Wrap},
};

use crate::send_request;

const REFRESH_INTERVAL: Duration = Duration::from_millis(300);

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
        terminal.draw(|frame| render(frame, &app)).map_err(KairoError::Io)?;
        let timeout = REFRESH_INTERVAL.saturating_sub(last_refresh.elapsed());
        if event::poll(timeout)?
            && let Event::Key(key) = event::read()?
            && key.kind == KeyEventKind::Press
        {
            match key.code {
                KeyCode::Char('q') | KeyCode::Esc => return Ok(()),
                KeyCode::Right | KeyCode::Char('l') | KeyCode::Tab => app.next(),
                KeyCode::Left | KeyCode::Char('h') | KeyCode::BackTab => app.previous(),
                KeyCode::Char('r') => app.refresh(),
                _ => {}
            }
        }
        if last_refresh.elapsed() >= REFRESH_INTERVAL {
            app.refresh();
            last_refresh = Instant::now();
        }
    }
}

#[derive(Default)]
struct App {
    agents: Vec<Agent>,
    selected: usize,
    logs: String,
    error: Option<String>,
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
        self.logs.clear();
        self.error = None;
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
            self.refresh();
        }
    }

    fn previous(&mut self) {
        if !self.agents.is_empty() {
            self.selected = (self.selected + self.agents.len() - 1) % self.agents.len();
            self.refresh();
        }
    }

    fn set_error(&mut self, message: String) {
        self.error = Some(message);
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

    let (title, content) = if let Some(error) = &app.error {
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
    let log = Paragraph::new(content)
        .block(Block::default().borders(Borders::ALL).title(title))
        .wrap(Wrap { trim: false });
    frame.render_widget(log, areas[1]);

    let footer = Paragraph::new(" q: quit   ←/→ or h/l: switch tabs   r: refresh ")
        .style(Style::default().fg(Color::DarkGray));
    frame.render_widget(footer, areas[2]);
}

#[allow(dead_code)]
fn status_color(status: &AgentStatus) -> Color {
    match status {
        AgentStatus::Working => Color::Green,
        AgentStatus::Blocked | AgentStatus::Failed | AgentStatus::Interrupted => Color::Red,
        AgentStatus::Completed => Color::Blue,
        _ => Color::Yellow,
    }
}
