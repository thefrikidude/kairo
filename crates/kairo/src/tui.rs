use std::{
    collections::HashSet,
    io,
    net::Shutdown,
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
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
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
};

use crate::{connect_attachment, key_to_bytes, send_request};

const REFRESH_INTERVAL: Duration = Duration::from_millis(300);
const SCROLLBACK_ROWS: usize = 2_000;
const SIDEBAR_WIDTH: u16 = 28;
const AGENT_COMMANDS: &[&str] = &["codex", "claude", "gemini", "aider", "opencode", "amp"];

pub fn run() -> Result<()> {
    let workspace = std::env::current_dir()?;
    let mut terminal = setup_terminal()?;
    let result = run_app(&mut terminal, workspace);
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

fn run_app(terminal: &mut KairoTerminal, workspace: PathBuf) -> Result<()> {
    let mut app = App::new(workspace);
    app.refresh();
    app.ensure_terminal();
    let mut last_refresh = Instant::now();

    loop {
        app.drain_output();
        app.resize_visible_panes(terminal.size()?.into());
        terminal.draw(|frame| render(frame, &app)).map_err(KairoError::Io)?;

        let timeout = REFRESH_INTERVAL.saturating_sub(last_refresh.elapsed());
        if event::poll(timeout)?
            && let event = event::read()?
        {
            handle_event(&mut app, event, terminal.size()?.into());
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

fn handle_event(app: &mut App, event: Event, area: Rect) {
    if app.rename_dialog.is_some() {
        app.handle_rename_event(event);
        return;
    }

    if let Some(name) = app.delete_confirmation.clone() {
        if let Event::Key(key) = event
            && key.kind == KeyEventKind::Press
        {
            match key.code {
                KeyCode::Char('y') | KeyCode::Enter => app.delete_terminal(&name),
                KeyCode::Char('n') | KeyCode::Esc => app.delete_confirmation = None,
                _ => {}
            }
        }
        return;
    }

    if let Event::Mouse(mouse) = &event
        && mouse.kind == MouseEventKind::Down(MouseButton::Left)
    {
        if sidebar_new_clicked(sidebar_area(area), mouse.column, mouse.row) {
            app.open_terminal();
            return;
        }
        if let Some(name) =
            sidebar_agent_name(&app.order, sidebar_area(area), mouse.column, mouse.row)
        {
            app.reveal_and_focus(name);
            return;
        }
        let names = app.visible_names();
        let panes = pane_areas(main_area(area), names.len());
        if let Some(index) = pane_index_at(&panes, mouse.column, mouse.row) {
            if let Some(name) = names.get(index) {
                app.select_and_focus(name.clone());
            }
            return;
        }
    }

    let Some(focused) = app.focused.clone() else {
        if let Event::Key(key) = event
            && key.kind == KeyEventKind::Press
        {
            match key.code {
                KeyCode::Char('q') | KeyCode::Esc => app.should_quit = true,
                KeyCode::Char('r') => app.request_rename(),
                KeyCode::Char('t') => app.open_terminal(),
                KeyCode::Char('h') => app.hide_selected(),
                KeyCode::Char('d') => app.request_delete(),
                KeyCode::Up => app.select_sidebar_session(true),
                KeyCode::Down => app.select_sidebar_session(false),
                KeyCode::Enter => app.open_selected(),
                _ => {}
            }
        }
        return;
    };

    match event {
        Event::Key(key)
            if key.kind == KeyEventKind::Press && is_unfocus_key(key.code, key.modifiers) =>
        {
            app.focused = None;
        }
        Event::Key(key) if key.kind == KeyEventKind::Press => {
            if let Some(bytes) = key_to_bytes(key.code, key.modifiers) {
                let submitted_command = app.record_key(&focused, key.code, key.modifiers);
                app.send_input(&focused, bytes, submitted_command);
            }
        }
        Event::Paste(text) => {
            let submitted_command = app.record_paste(&focused, &text);
            app.send_input(&focused, text.into_bytes(), submitted_command);
        }
        _ => {}
    }
}

fn is_unfocus_key(code: KeyCode, modifiers: KeyModifiers) -> bool {
    (code == KeyCode::Char(']') && modifiers.contains(KeyModifiers::CONTROL))
        || (code == KeyCode::Char('5') && modifiers.contains(KeyModifiers::CONTROL))
}

#[derive(Default)]
struct App {
    workspace: PathBuf,
    agents: Vec<Agent>,
    terminals: Vec<LiveTerminal>,
    order: Vec<String>,
    hidden: HashSet<String>,
    selected: Option<String>,
    focused: Option<String>,
    delete_confirmation: Option<String>,
    rename_dialog: Option<RenameDialog>,
    error: Option<String>,
    should_quit: bool,
}

struct RenameDialog {
    name: String,
    input: String,
    replace_existing: bool,
}

impl App {
    fn new(workspace: PathBuf) -> Self {
        Self {
            workspace,
            agents: Vec::new(),
            terminals: Vec::new(),
            order: Vec::new(),
            hidden: HashSet::new(),
            selected: None,
            focused: None,
            delete_confirmation: None,
            rename_dialog: None,
            error: None,
            should_quit: false,
        }
    }

    fn refresh(&mut self) {
        let agents = match send_request(Request::ListAgents) {
            Ok(Response::Agents { agents }) => running_agents(agents),
            Ok(Response::Error { message }) => return self.set_error(message),
            Ok(unexpected) => {
                return self.set_error(format!("unexpected daemon response: {unexpected:?}"));
            }
            Err(error) => return self.set_error(error.to_string()),
        };
        let names = agents.iter().map(|agent| agent.name.clone()).collect::<HashSet<_>>();
        self.agents = agents;
        self.order.retain(|name| names.contains(name));
        for agent in &self.agents {
            if !self.order.contains(&agent.name) {
                self.order.push(agent.name.clone());
            }
        }
        self.hidden.retain(|name| names.contains(name));
        self.selected = self.selected.take().filter(|name| names.contains(name));
        self.focused = self.focused.take().filter(|name| names.contains(name));
        self.remove_finished_terminals(&names);
        let to_attach = self
            .agents
            .iter()
            .filter(|agent| !self.terminals.iter().any(|terminal| terminal.name == agent.name))
            .map(|agent| agent.name.clone())
            .collect::<Vec<_>>();
        for name in to_attach {
            self.attach_terminal(&name);
        }
    }

    fn ensure_terminal(&mut self) {
        if self.agents.is_empty() {
            self.open_terminal();
        }
    }

    fn open_terminal(&mut self) {
        match send_request(Request::OpenTerminal { workspace: self.workspace.clone() }) {
            Ok(Response::TerminalOpened { agent }) => {
                self.agents.push(agent.clone());
                self.order.push(agent.name.clone());
                self.attach_terminal(&agent.name);
                self.reveal_and_focus(agent.name);
            }
            Ok(Response::Error { message }) => self.set_error(message),
            Ok(unexpected) => self.set_error(format!("unexpected daemon response: {unexpected:?}")),
            Err(error) => self.set_error(error.to_string()),
        }
    }

    fn attach_terminal(&mut self, name: &str) {
        match LiveTerminal::connect(name) {
            Ok(terminal) => self.terminals.push(terminal),
            Err(error) => self.set_error(error.to_string()),
        }
    }

    fn reveal_and_focus(&mut self, name: String) {
        self.hidden.remove(&name);
        if !self.order.contains(&name) {
            self.order.push(name.clone());
        }
        self.select_and_focus(name);
    }

    fn select_and_focus(&mut self, name: String) {
        self.selected = Some(name.clone());
        self.focused = Some(name);
    }

    fn hide_selected(&mut self) {
        let Some(name) = self.selected.clone() else {
            self.set_error("select a terminal before hiding it".to_owned());
            return;
        };
        if self.hidden.insert(name.clone()) {
            self.focused = None;
        }
    }

    fn select_sidebar_session(&mut self, previous: bool) {
        let names = self
            .order
            .iter()
            .filter(|name| self.agents.iter().any(|agent| agent.name == ***name))
            .cloned()
            .collect::<Vec<_>>();
        self.selected = adjacent_sidebar_name(&names, self.selected.as_deref(), previous);
    }

    fn open_selected(&mut self) {
        let Some(name) = self.selected.clone() else {
            self.set_error("select a terminal before opening it".to_owned());
            return;
        };
        self.reveal_and_focus(name);
    }

    fn request_delete(&mut self) {
        let Some(name) = self.selected.clone() else {
            self.set_error("select a terminal before deleting it".to_owned());
            return;
        };
        self.delete_confirmation = Some(name);
    }

    fn request_rename(&mut self) {
        let Some(name) = self.selected.clone() else {
            self.set_error("select a terminal before renaming it".to_owned());
            return;
        };
        let Some(agent) = self.agents.iter().find(|agent| agent.name == name) else {
            self.set_error("selected terminal no longer exists".to_owned());
            return;
        };
        self.rename_dialog =
            Some(RenameDialog { name, input: agent.title.clone(), replace_existing: true });
    }

    fn handle_rename_event(&mut self, event: Event) {
        match event {
            Event::Key(key) if key.kind == KeyEventKind::Press => match key.code {
                KeyCode::Esc => self.rename_dialog = None,
                KeyCode::Enter => self.save_rename(),
                KeyCode::Backspace => {
                    if let Some(dialog) = &mut self.rename_dialog {
                        if dialog.replace_existing {
                            dialog.input.clear();
                            dialog.replace_existing = false;
                        } else {
                            dialog.input.pop();
                        }
                    }
                }
                KeyCode::Char(character) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                    if let Some(dialog) = &mut self.rename_dialog {
                        if dialog.replace_existing {
                            dialog.input.clear();
                            dialog.replace_existing = false;
                        }
                        dialog.input.push(character);
                    }
                }
                _ => {}
            },
            Event::Paste(text) => {
                if let Some(dialog) = &mut self.rename_dialog {
                    if dialog.replace_existing {
                        dialog.input.clear();
                        dialog.replace_existing = false;
                    }
                    dialog.input.push_str(&text);
                }
            }
            _ => {}
        }
    }

    fn save_rename(&mut self) {
        let Some(dialog) = &self.rename_dialog else {
            return;
        };
        let name = dialog.name.clone();
        let title = dialog.input.trim().to_owned();
        if title.is_empty() {
            self.set_error("terminal title cannot be empty".to_owned());
            return;
        }
        if self.persist_title(&name, title) {
            self.rename_dialog = None;
        }
    }

    fn delete_terminal(&mut self, name: &str) {
        match send_request(Request::DeleteAgent { name: name.to_owned() }) {
            Ok(Response::AgentDeleted { .. }) => {
                if let Some(index) =
                    self.terminals.iter().position(|terminal| terminal.name == name)
                {
                    self.terminals.remove(index).close();
                }
                self.agents.retain(|agent| agent.name != name);
                self.order.retain(|terminal_name| terminal_name != name);
                self.hidden.remove(name);
                if self.selected.as_deref() == Some(name) {
                    self.selected = None;
                }
                if self.focused.as_deref() == Some(name) {
                    self.focused = None;
                }
                self.delete_confirmation = None;
            }
            Ok(Response::Error { message }) => self.set_error(message),
            Ok(unexpected) => self.set_error(format!("unexpected daemon response: {unexpected:?}")),
            Err(error) => self.set_error(error.to_string()),
        }
    }

    fn visible_names(&self) -> Vec<String> {
        self.order
            .iter()
            .filter(|name| !self.hidden.contains(*name))
            .filter(|name| self.terminals.iter().any(|terminal| terminal.name == **name))
            .cloned()
            .collect()
    }

    fn send_input(&mut self, name: &str, bytes: Vec<u8>, submitted_command: Option<String>) {
        let Some(terminal) = self.terminals.iter_mut().find(|terminal| terminal.name == name)
        else {
            return;
        };
        if let Err(error) = write_attach_frame(&mut terminal.stream, &AttachFrame::Input(bytes)) {
            self.set_error(error.to_string());
            return;
        }
        if let Some(command) = submitted_command {
            self.assign_initial_title(name, &command);
        }
    }

    fn assign_initial_title(&mut self, name: &str, command: &str) {
        let Some(agent) = self.agents.iter().find(|agent| agent.name == name) else {
            return;
        };
        let Some(title) = automatic_title(agent, command) else {
            return;
        };
        self.persist_title(name, title);
    }

    fn persist_title(&mut self, name: &str, title: String) -> bool {
        match send_request(Request::SetAgentTitle { name: name.to_owned(), title }) {
            Ok(Response::AgentTitleUpdated { agent }) => {
                if let Some(existing) = self.agents.iter_mut().find(|agent| agent.name == name) {
                    *existing = agent;
                }
                true
            }
            Ok(Response::Error { message }) => {
                self.set_error(message);
                false
            }
            Ok(unexpected) => {
                self.set_error(format!("unexpected daemon response: {unexpected:?}"));
                false
            }
            Err(error) => {
                self.set_error(error.to_string());
                false
            }
        }
    }

    fn record_key(&mut self, name: &str, code: KeyCode, modifiers: KeyModifiers) -> Option<String> {
        let terminal = self.terminals.iter_mut().find(|terminal| terminal.name == name)?;
        match code {
            KeyCode::Char(character) if !modifiers.contains(KeyModifiers::CONTROL) => {
                terminal.input_line.push(character);
                None
            }
            KeyCode::Backspace => {
                terminal.input_line.pop();
                None
            }
            KeyCode::Enter => submitted_command(&mut terminal.input_line),
            _ => None,
        }
    }

    fn record_paste(&mut self, name: &str, text: &str) -> Option<String> {
        let terminal = self.terminals.iter_mut().find(|terminal| terminal.name == name)?;
        let mut title = None;
        for character in text.chars() {
            if matches!(character, '\n' | '\r') {
                title = submitted_command(&mut terminal.input_line).or(title);
            } else {
                terminal.input_line.push(character);
            }
        }
        title
    }

    fn drain_output(&mut self) {
        for terminal in &mut self.terminals {
            while let Ok(output) = terminal.output.try_recv() {
                terminal.parser.process(&output);
            }
        }
    }

    fn resize_visible_panes(&mut self, area: Rect) {
        let names = self.visible_names();
        for (name, pane) in names.iter().zip(pane_areas(main_area(area), names.len())) {
            if let Some(terminal) =
                self.terminals.iter_mut().find(|terminal| terminal.name == *name)
            {
                terminal.resize(
                    pane.height.saturating_sub(2).max(1),
                    pane.width.saturating_sub(2).max(1),
                );
            }
        }
    }

    fn remove_finished_terminals(&mut self, names: &HashSet<String>) {
        let mut retained = Vec::new();
        for terminal in self.terminals.drain(..) {
            if names.contains(&terminal.name) {
                retained.push(terminal);
            } else {
                terminal.close();
            }
        }
        self.terminals = retained;
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
    input_line: String,
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
            input_line: String::new(),
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
    render_sidebar(frame, app, sidebar);
    let names = app.visible_names();
    let panes = pane_areas(main, names.len());
    for (name, area) in names.iter().zip(panes) {
        if let Some(terminal) = app.terminals.iter().find(|terminal| terminal.name == *name) {
            let focused = app.focused.as_deref() == Some(name.as_str());
            let title = app
                .agents
                .iter()
                .find(|agent| agent.name == *name)
                .map_or_else(|| name.clone(), |agent| agent.title.clone());
            let border = if focused { Color::Cyan } else { Color::DarkGray };
            let pane = Paragraph::new(terminal.contents())
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(border))
                        .title(format!(" {title} ")),
                )
                .wrap(Wrap { trim: false });
            frame.render_widget(pane, area);
        }
    }
    if names.is_empty() {
        frame.render_widget(
            Paragraph::new("No visible terminals. Click one in the sidebar or + Terminal.")
                .block(Block::default().borders(Borders::ALL).title(" Workspace ")),
            main,
        );
    }
    render_delete_confirmation(frame, app);
    render_rename_dialog(frame, app);
    let footer = if let Some(error) = &app.error {
        format!(" {error} ")
    } else if app.rename_dialog.is_some() {
        " Enter: save name · Esc: cancel ".to_owned()
    } else if app.delete_confirmation.is_some() {
        " y: permanently delete · n: cancel ".to_owned()
    } else if app.focused.is_some() {
        " Click another pane to focus · Ctrl-] opens Kairo shortcuts ".to_owned()
    } else {
        " ↑/↓: select · Enter: open · t: new · r: rename · h: hide · d: delete · q: quit "
            .to_owned()
    };
    frame.render_widget(
        Paragraph::new(footer).style(Style::default().fg(Color::DarkGray)),
        footer_area(frame.area()),
    );
}

fn render_sidebar(frame: &mut ratatui::Frame, app: &App, area: Rect) {
    let mut lines = vec![
        Line::styled(" + Terminal", Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)),
        Line::from(""),
    ];
    for name in &app.order {
        if let Some(agent) = app.agents.iter().find(|agent| agent.name == *name) {
            let focused = app.focused.as_deref() == Some(name.as_str());
            let selected = app.selected.as_deref() == Some(name.as_str());
            let hidden = app.hidden.contains(name);
            let marker = if hidden { "○" } else { "●" };
            let style = if focused || selected {
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::Gray)
            };
            lines.push(Line::styled(format!(" {marker} {}", agent.title), style));
        }
    }
    frame.render_widget(
        Paragraph::new(lines).block(Block::default().borders(Borders::ALL).title(" Terminals ")),
        area,
    );
}

fn render_delete_confirmation(frame: &mut ratatui::Frame, app: &App) {
    let Some(name) = &app.delete_confirmation else {
        return;
    };
    let title = app
        .agents
        .iter()
        .find(|agent| agent.name == *name)
        .map_or(name.as_str(), |agent| agent.title.as_str());
    let area = frame.area();
    let width = area.width.min(54);
    let height = area.height.min(7);
    let dialog = Rect::new(
        area.x.saturating_add(area.width.saturating_sub(width) / 2),
        area.y.saturating_add(area.height.saturating_sub(height) / 2),
        width,
        height,
    );
    frame.render_widget(Clear, dialog);
    frame.render_widget(
        Paragraph::new(format!(
            "Delete `{title}` permanently?\n\nThis stops it and erases its saved history.\n\ny: delete    n: cancel"
        ))
        .block(Block::default().borders(Borders::ALL).title(" Confirm deletion "))
        .wrap(Wrap { trim: false }),
        dialog,
    );
}

fn render_rename_dialog(frame: &mut ratatui::Frame, app: &App) {
    let Some(dialog) = &app.rename_dialog else {
        return;
    };
    let area = frame.area();
    let width = area.width.min(54);
    let height = area.height.min(5);
    let dialog_area = Rect::new(
        area.x.saturating_add(area.width.saturating_sub(width) / 2),
        area.y.saturating_add(area.height.saturating_sub(height) / 2),
        width,
        height,
    );
    frame.render_widget(Clear, dialog_area);
    frame.render_widget(
        Paragraph::new(format!("{}\n\nType to replace · Enter: save · Esc: cancel", dialog.input))
            .block(Block::default().borders(Borders::ALL).title(" Rename session "))
            .wrap(Wrap { trim: false }),
        dialog_area,
    );
}

fn content_area(area: Rect) -> Rect {
    Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(1)])
        .split(area)[0]
}
fn sidebar_area(area: Rect) -> Rect {
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(SIDEBAR_WIDTH), Constraint::Min(1)])
        .split(content_area(area))[0]
}
fn main_area(area: Rect) -> Rect {
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(SIDEBAR_WIDTH), Constraint::Min(1)])
        .split(content_area(area))[1]
}
fn footer_area(area: Rect) -> Rect {
    Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(1)])
        .split(area)[1]
}
fn pane_areas(area: Rect, count: usize) -> Vec<Rect> {
    if count == 0 {
        return Vec::new();
    }
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints(vec![Constraint::Fill(1); count])
        .split(area)
        .to_vec()
}
fn sidebar_new_clicked(area: Rect, column: u16, row: u16) -> bool {
    row == area.y.saturating_add(1)
        && column > area.x
        && column < area.x.saturating_add(area.width).saturating_sub(1)
}
fn sidebar_agent_name(names: &[String], area: Rect, column: u16, row: u16) -> Option<String> {
    if column <= area.x || column >= area.x.saturating_add(area.width).saturating_sub(1) {
        return None;
    }
    let index = usize::from(row.saturating_sub(area.y.saturating_add(3)));
    (row >= area.y.saturating_add(3) && index < names.len()).then(|| names[index].clone())
}
fn adjacent_sidebar_name(
    names: &[String],
    selected: Option<&str>,
    previous: bool,
) -> Option<String> {
    let current = selected.and_then(|selected| names.iter().position(|name| name == selected));
    let index = match (current, previous) {
        (Some(0), true) => names.len().checked_sub(1)?,
        (Some(index), true) => index.saturating_sub(1),
        (Some(index), false) => (index + 1) % names.len(),
        (None, true) => names.len().checked_sub(1)?,
        (None, false) => 0,
    };
    names.get(index).cloned()
}
fn pane_index_at(areas: &[Rect], column: u16, row: u16) -> Option<usize> {
    areas.iter().position(|area| {
        column >= area.x
            && column < area.x.saturating_add(area.width)
            && row >= area.y
            && row < area.y.saturating_add(area.height)
    })
}
fn submitted_command(input: &mut String) -> Option<String> {
    let command = input.split_whitespace().next().map(str::to_owned);
    input.clear();
    command
}

fn automatic_title(agent: &Agent, command: &str) -> Option<String> {
    if agent.title_locked {
        return None;
    }
    let command = command.split_whitespace().next()?;
    let command = Path::new(command).file_name().and_then(|name| name.to_str()).unwrap_or(command);
    if AGENT_COMMANDS.contains(&command) {
        return Some(command.to_owned());
    }
    Some(
        agent
            .workspace
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("/")
            .to_owned(),
    )
}

impl Drop for App {
    fn drop(&mut self) {
        for terminal in self.terminals.drain(..) {
            terminal.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use kairo_core::{Agent, AgentStatus};

    use super::{
        adjacent_sidebar_name, automatic_title, pane_areas, sidebar_agent_name, submitted_command,
    };
    use ratatui::layout::Rect;

    #[test]
    fn panes_share_the_main_area_equally() {
        let panes = pane_areas(Rect::new(0, 0, 90, 20), 3);
        assert_eq!(panes.len(), 3);
        assert_eq!(panes.iter().map(|pane| pane.width).collect::<Vec<_>>(), [30, 30, 30]);
    }

    #[test]
    fn pane_layout_expands_after_a_pane_is_hidden() {
        let panes = pane_areas(Rect::new(0, 0, 90, 20), 2);
        assert_eq!(panes.iter().map(|pane| pane.width).collect::<Vec<_>>(), [45, 45]);
    }

    #[test]
    fn submitted_command_uses_its_first_token() {
        let mut input = "codex --model gpt-5".to_owned();
        assert_eq!(submitted_command(&mut input).as_deref(), Some("codex"));
        assert!(input.is_empty());
    }

    #[test]
    fn first_command_uses_agent_name_or_workspace_folder() {
        let agent = test_agent(false, "/tmp/kairo");

        assert_eq!(automatic_title(&agent, "codex --model gpt-5").as_deref(), Some("codex"));
        assert_eq!(automatic_title(&agent, "git status").as_deref(), Some("kairo"));
    }

    #[test]
    fn locked_titles_are_not_overwritten_by_later_commands() {
        let agent = test_agent(true, "/tmp/kairo");

        assert_eq!(automatic_title(&agent, "gemini").as_deref(), None);
    }

    #[test]
    fn sidebar_clicks_only_select_terminal_rows_in_display_order() {
        let names = vec!["first".to_owned(), "second".to_owned()];
        let sidebar = Rect::new(0, 0, 28, 10);

        assert_eq!(sidebar_agent_name(&names, sidebar, 4, 3).as_deref(), Some("first"));
        assert_eq!(sidebar_agent_name(&names, sidebar, 4, 4).as_deref(), Some("second"));
        assert_eq!(sidebar_agent_name(&names, sidebar, 4, 2), None);
        assert_eq!(sidebar_agent_name(&names, sidebar, 0, 3), None);
    }

    #[test]
    fn arrow_selection_moves_through_sessions_and_wraps() {
        let names = vec!["first".to_owned(), "second".to_owned(), "third".to_owned()];

        assert_eq!(adjacent_sidebar_name(&names, None, false).as_deref(), Some("first"));
        assert_eq!(adjacent_sidebar_name(&names, Some("first"), true).as_deref(), Some("third"));
        assert_eq!(adjacent_sidebar_name(&names, Some("third"), false).as_deref(), Some("first"));
        assert_eq!(adjacent_sidebar_name(&names, Some("second"), false).as_deref(), Some("third"));
    }

    fn test_agent(title_locked: bool, workspace: &str) -> Agent {
        Agent {
            id: "agent-1".to_owned(),
            name: "terminal-1".to_owned(),
            title: "Terminal 1".to_owned(),
            title_locked,
            adapter: "shell".to_owned(),
            command: None,
            workspace: PathBuf::from(workspace),
            status: AgentStatus::Working,
            pid: None,
            created_at_ms: 1,
            updated_at_ms: 1,
        }
    }
}
