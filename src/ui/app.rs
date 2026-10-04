//! The top-level ratatui application: terminal setup, the event loop, key handling, and drawing.

use crate::agent::manager::{AgentManager, CreateAgentParams};
use crate::types::{AgentStatus, AgentTemplate};
use crate::ui::forms::{FormStep, NewAgentForm};
use crate::ui::input_bar::TextInput;
use crate::ui::layout::sidebar_width;
use crate::ui::{agent_view, input_bar, sidebar};
use ratatui::crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use std::time::Duration;

/// Which modal/overlay is active.
enum Mode {
    Normal,
    NewAgent(NewAgentForm),
    Reply(TextInput),
    ConfirmQuit,
    ConfirmRemove,
}

/// UI-only state (the agents themselves live in the [`AgentManager`]).
pub struct App {
    selected: usize,
    scroll: Option<usize>, // None = follow tail
    mode: Mode,
    status_msg: Option<String>,
    should_quit: bool,
    view_top: usize,
    view_max: usize,
}

impl App {
    pub fn new() -> Self {
        Self {
            selected: 0,
            scroll: None,
            mode: Mode::Normal,
            status_msg: None,
            should_quit: false,
            view_top: 0,
            view_max: 0,
        }
    }
}

impl Default for App {
    fn default() -> Self {
        Self::new()
    }
}

/// Set up the terminal, run the event loop, and restore the terminal on exit.
pub fn run(manager: &mut AgentManager) -> anyhow::Result<()> {
    use std::io::IsTerminal;
    if !std::io::stdout().is_terminal() {
        anyhow::bail!("orc needs an interactive terminal (TTY); run it directly in your shell.");
    }
    let mut terminal = ratatui::init();
    let result = event_loop(&mut terminal, manager);
    ratatui::restore();
    result
}

fn event_loop(terminal: &mut ratatui::DefaultTerminal, manager: &mut AgentManager) -> anyhow::Result<()> {
    let mut app = App::new();
    loop {
        // Keep the selection in range as agents come and go.
        let n = manager.len();
        if n == 0 {
            app.selected = 0;
        } else if app.selected >= n {
            app.selected = n - 1;
        }

        terminal.draw(|f| app.draw(f, manager))?;

        if event::poll(Duration::from_millis(80))? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    app.on_key(key.code, key.modifiers, manager);
                }
            }
        }
        if app.should_quit {
            break;
        }
    }
    Ok(())
}

impl App {
    fn selected_question(&self, manager: &AgentManager) -> Option<String> {
        manager
            .session(self.selected)
            .and_then(|s| s.info().question)
    }

    fn selected_name(&self, manager: &AgentManager) -> String {
        manager
            .session(self.selected)
            .map(|s| s.info().name)
            .unwrap_or_else(|| "agent".to_string())
    }

    fn on_key(&mut self, code: KeyCode, mods: KeyModifiers, manager: &mut AgentManager) {
        self.status_msg = None;
        match &mut self.mode {
            Mode::Normal => self.on_key_normal(code, mods, manager),
            Mode::NewAgent(_) => self.on_key_newagent(code, manager),
            Mode::Reply(_) => self.on_key_reply(code, manager),
            Mode::ConfirmQuit => match code {
                KeyCode::Char('y') | KeyCode::Enter => self.should_quit = true,
                _ => self.mode = Mode::Normal,
            },
            Mode::ConfirmRemove => match code {
                KeyCode::Char('y') | KeyCode::Enter => {
                    manager.remove(self.selected);
                    self.scroll = None;
                    self.mode = Mode::Normal;
                }
                _ => self.mode = Mode::Normal,
            },
        }
    }

    fn on_key_normal(&mut self, code: KeyCode, _mods: KeyModifiers, manager: &mut AgentManager) {
        let n = manager.len();
        match code {
            KeyCode::Char('q') => self.mode = Mode::ConfirmQuit,
            KeyCode::Char('n') => {
                let projects: Vec<String> =
                    manager.projects().iter().map(|p| p.name.clone()).collect();
                if projects.is_empty() {
                    self.status_msg = Some("No projects in config.".into());
                } else {
                    self.mode = Mode::NewAgent(NewAgentForm::new(projects));
                }
            }
            KeyCode::Char('i') | KeyCode::Enter => {
                if n > 0 {
                    self.mode = Mode::Reply(TextInput::new());
                }
            }
            KeyCode::Char('r') => {
                if n > 0 {
                    manager.resume(self.selected);
                    self.scroll = None;
                }
            }
            KeyCode::Char('x') => {
                if n > 0 {
                    manager.stop(self.selected);
                }
            }
            KeyCode::Char('d') => {
                if n > 0 {
                    self.mode = Mode::ConfirmRemove;
                }
            }
            KeyCode::Up | KeyCode::Char('k') => self.select(self.selected.wrapping_sub(1), n),
            KeyCode::Down | KeyCode::Char('j') | KeyCode::Tab => self.select(self.selected + 1, n),
            KeyCode::Char(c @ '1'..='9') => {
                let idx = (c as u8 - b'1') as usize;
                self.select(idx, n);
            }
            KeyCode::Char('w') => self.jump_to_waiting(manager),
            KeyCode::Char('K') => {
                let base = self.scroll.unwrap_or(self.view_top);
                self.scroll = Some(base.saturating_sub(3));
            }
            KeyCode::Char('J') => {
                let base = self.scroll.unwrap_or(self.view_top);
                let next = base + 3;
                self.scroll = if next >= self.view_max { None } else { Some(next) };
            }
            KeyCode::Char('G') => self.scroll = None,
            KeyCode::Char('m') | KeyCode::Char('p') | KeyCode::Char('h') | KeyCode::Char('l') => {
                self.status_msg = Some("Not available in this build yet.".into());
            }
            _ => {}
        }
    }

    fn select(&mut self, idx: usize, n: usize) {
        if n == 0 {
            return;
        }
        self.selected = idx.min(n - 1);
        self.scroll = None;
    }

    fn jump_to_waiting(&mut self, manager: &AgentManager) {
        let n = manager.len();
        for off in 1..=n {
            let idx = (self.selected + off) % n;
            if let Some(s) = manager.session(idx) {
                if s.info().status == AgentStatus::NeedsInput {
                    self.select(idx, n);
                    return;
                }
            }
        }
        self.status_msg = Some("No agents waiting on you.".into());
    }

    fn on_key_reply(&mut self, code: KeyCode, manager: &mut AgentManager) {
        let Mode::Reply(input) = &mut self.mode else {
            return;
        };
        match code {
            KeyCode::Esc => self.mode = Mode::Normal,
            KeyCode::Enter => {
                let text = input.value();
                if !text.trim().is_empty() {
                    manager.answer(self.selected, text);
                    self.scroll = None;
                }
                self.mode = Mode::Normal;
            }
            KeyCode::Backspace => input.backspace(),
            KeyCode::Delete => input.delete(),
            KeyCode::Left => input.left(),
            KeyCode::Right => input.right(),
            KeyCode::Home => input.home(),
            KeyCode::End => input.end(),
            KeyCode::Char(c) => input.insert(c),
            _ => {}
        }
    }

    fn on_key_newagent(&mut self, code: KeyCode, manager: &mut AgentManager) {
        let Mode::NewAgent(form) = &mut self.mode else {
            return;
        };
        match code {
            KeyCode::Esc => self.mode = Mode::Normal,
            KeyCode::Up if form.step == FormStep::Project => form.project_up(),
            KeyCode::Down if form.step == FormStep::Project => form.project_down(),
            KeyCode::Enter => {
                let ready = form.advance();
                if ready {
                    self.submit_new_agent(manager);
                }
            }
            KeyCode::Backspace => {
                if let Some(input) = form.active_input() {
                    input.backspace();
                } else {
                    // on the project step, Backspace is a no-op
                }
            }
            KeyCode::Left => {
                if let Some(input) = form.active_input() {
                    input.left();
                }
            }
            KeyCode::Right => {
                if let Some(input) = form.active_input() {
                    input.right();
                }
            }
            KeyCode::Char(c) => {
                if let Some(input) = form.active_input() {
                    input.insert(c);
                }
            }
            _ => {}
        }
    }

    fn submit_new_agent(&mut self, manager: &mut AgentManager) {
        let Mode::NewAgent(form) = &self.mode else {
            return;
        };
        let Some(project) = form.selected_project().map(str::to_string) else {
            self.status_msg = Some("Pick a project first.".into());
            return;
        };
        let params = CreateAgentParams {
            project,
            name: form.name.value(),
            ticket: form.ticket.value(),
            prompt: form.prompt.value(),
            template: AgentTemplate::Feature,
        };
        match manager.create_agent(params) {
            Ok(idx) => {
                self.selected = idx;
                self.scroll = None;
                self.mode = Mode::Normal;
            }
            Err(e) => {
                self.status_msg = Some(format!("Could not create agent: {e}"));
                self.mode = Mode::Normal;
            }
        }
    }

    fn draw(&mut self, f: &mut Frame, manager: &AgentManager) {
        let area = f.area();
        let reply_rows: u16 = if matches!(self.mode, Mode::Reply(_)) { 5 } else { 1 };
        let chunks = Layout::vertical([
            Constraint::Length(1),
            Constraint::Min(3),
            Constraint::Length(reply_rows),
        ])
        .split(area);
        let (header, body, bottom) = (chunks[0], chunks[1], chunks[2]);

        self.draw_header(f, header, manager);

        // body: sidebar | agent view
        let sw = sidebar_width(body.width);
        let cols = Layout::horizontal([Constraint::Length(sw), Constraint::Min(10)]).split(body);
        let infos = manager.infos();
        sidebar::render(f, cols[0], &infos, self.selected);

        let snapshot = manager.session(self.selected).map(|s| s.snapshot());
        let (top, max) = agent_view::render(f, cols[1], snapshot.as_ref(), self.scroll);
        self.view_top = top;
        self.view_max = max;

        // bottom bar
        match &self.mode {
            Mode::Reply(input) => {
                let name = self.selected_name(manager);
                let q = self.selected_question(manager);
                input_bar::render(f, bottom, &name, q.as_deref(), input);
            }
            _ => self.draw_help(f, bottom),
        }

        // overlays
        match &self.mode {
            Mode::NewAgent(form) => crate::ui::forms::render(f, body, form),
            Mode::ConfirmQuit => {
                draw_confirm(f, body, "Quit orc? This stops all agents. (y/n)");
            }
            Mode::ConfirmRemove => {
                let name = self.selected_name(manager);
                draw_confirm(
                    f,
                    body,
                    &format!("Remove agent \"{name}\" and its worktree? (y/n)"),
                );
            }
            _ => {}
        }
    }

    fn draw_header(&self, f: &mut Frame, area: Rect, manager: &AgentManager) {
        let waiting = manager
            .infos()
            .iter()
            .filter(|i| i.status == AgentStatus::NeedsInput)
            .count();
        let mut spans = vec![
            Span::styled("orc", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
            Span::raw(format!("  {} agents", manager.len())),
        ];
        if waiting > 0 {
            spans.push(Span::styled(
                format!("  · {waiting} waiting", ),
                Style::default().fg(Color::Magenta),
            ));
        }
        f.render_widget(Paragraph::new(Line::from(spans)), area);
    }

    fn draw_help(&self, f: &mut Frame, area: Rect) {
        if let Some(msg) = &self.status_msg {
            f.render_widget(
                Paragraph::new(Line::from(Span::styled(
                    msg.clone(),
                    Style::default().fg(Color::Yellow),
                ))),
                area,
            );
            return;
        }
        let help = "n new · i reply · r resume · x stop · d remove · w waiting · J/K scroll · G live · q quit";
        f.render_widget(
            Paragraph::new(Line::from(Span::styled(
                help,
                Style::default().fg(Color::DarkGray),
            ))),
            area,
        );
    }
}

fn draw_confirm(f: &mut Frame, area: Rect, text: &str) {
    let w = (text.len() as u16 + 6).min(area.width.saturating_sub(2)).max(20);
    let h = 5u16.min(area.height);
    let x = area.x + (area.width.saturating_sub(w)) / 2;
    let y = area.y + (area.height.saturating_sub(h)) / 2;
    let rect = Rect::new(x, y, w, h);
    f.render_widget(Clear, rect);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Red))
        .title(" Confirm ");
    let inner = block.inner(rect);
    f.render_widget(block, rect);
    f.render_widget(
        Paragraph::new(text.to_string()).wrap(ratatui::widgets::Wrap { trim: true }),
        inner,
    );
}
