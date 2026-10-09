//! The orc TUI: requests on the left, the selected agent's conversation on the
//! right, an input line at the bottom. A client of orcd; quitting it leaves
//! the agents running.

use crate::client;
use crate::config;
use crate::proto::{Cmd, Ev, Item, PermState, Request, Status};
use anyhow::Result;
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use std::collections::HashMap;
use std::process::Command;
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

enum Mode {
    Normal,
    Input(String),
    New(NewForm),
    ConfirmDown,
}

struct NewForm {
    projects: Vec<String>,
    project: usize,
    title: String,
    prompt: String,
    field: usize, // 0 project, 1 title, 2 prompt
}

struct App {
    requests: Vec<Request>,
    sel: usize,
    convos: HashMap<String, Vec<Item>>,
    partial: HashMap<String, String>,
    scroll: usize, // lines up from the bottom of the conversation
    mode: Mode,
    flash: Option<(String, Instant)>,
    rx: Receiver<Ev>,
    session: String,
    quit: bool,
}

/// Outside tmux: start (or attach to) the orc session with the TUI in window 0.
/// Inside tmux: run here.
pub fn run() -> Result<()> {
    let session = config::load_config()?.tmux_session();
    if std::env::var("TMUX").map_or(true, |t| t.is_empty()) {
        let exe = std::env::current_exe()?.display().to_string();
        let has = Command::new("tmux").args(["has-session", "-t", &session]).output()?.status.success();
        if !has {
            Command::new("tmux").args(["new-session", "-d", "-s", &session, "-n", "orc", &exe]).status()?;
        } else {
            let windows = String::from_utf8_lossy(&Command::new("tmux").args(["list-windows", "-t", &session, "-F", "#{window_name}"]).output()?.stdout).to_string();
            if !windows.lines().any(|w| w == "orc") {
                // Window 0 if it's free, else the next one.
                let ok = Command::new("tmux").args(["new-window", "-t", &format!("{session}:0"), "-n", "orc", &exe]).output()?.status.success();
                if !ok {
                    Command::new("tmux").args(["new-window", "-t", &format!("{session}:"), "-n", "orc", &exe]).status()?;
                }
            }
        }
        let err = std::os::unix::process::CommandExt::exec(Command::new("tmux").args(["attach", "-t", &format!("{session}:orc")]));
        return Err(err.into());
    }
    let events = client::subscribe()?;
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        for ev in events {
            if tx.send(ev).is_err() {
                break;
            }
        }
    });
    let mut app = App { requests: Vec::new(), sel: 0, convos: HashMap::new(), partial: HashMap::new(), scroll: 0, mode: Mode::Normal, flash: None, rx, session, quit: false };
    let mut term = ratatui::init();
    let res = app.main_loop(&mut term);
    ratatui::restore();
    res
}

impl App {
    fn main_loop(&mut self, term: &mut ratatui::DefaultTerminal) -> Result<()> {
        loop {
            while let Ok(ev) = self.rx.try_recv() {
                self.on_event(ev);
            }
            self.load_selected();
            if self.flash.as_ref().is_some_and(|(_, t)| t.elapsed() > Duration::from_secs(5)) {
                self.flash = None;
            }
            term.draw(|f| render(self, f))?;
            if event::poll(Duration::from_millis(80))? {
                if let Event::Key(k) = event::read()? {
                    if k.kind == KeyEventKind::Press {
                        self.on_key(k);
                    }
                }
            }
            if self.quit {
                return Ok(());
            }
        }
    }

    fn selected(&self) -> Option<&Request> {
        self.requests.get(self.sel)
    }

    fn set_flash(&mut self, s: impl Into<String>) {
        self.flash = Some((s.into(), Instant::now()));
    }

    /// Fetch the selected request's history the first time it's shown.
    fn load_selected(&mut self) {
        let Some(id) = self.selected().map(|r| r.id.clone()) else {
            return;
        };
        if self.convos.contains_key(&id) {
            return;
        }
        match client::request(&Cmd::History { id: id.clone() }) {
            Ok(Ev::History { items, .. }) => {
                self.convos.insert(id, items);
            }
            Ok(_) => {}
            Err(e) => {
                self.convos.insert(id, Vec::new());
                self.set_flash(format!("{e:#}"));
            }
        }
    }

    fn on_event(&mut self, ev: Ev) {
        match ev {
            Ev::Requests { list } => {
                let cur = self.selected().map(|r| r.id.clone());
                self.requests = list;
                self.requests.sort_by_key(|r| (r.status == Status::Stopped, std::cmp::Reverse(r.created)));
                if let Some(c) = cur {
                    if let Some(i) = self.requests.iter().position(|r| r.id == c) {
                        self.sel = i;
                    }
                }
                self.sel = self.sel.min(self.requests.len().saturating_sub(1));
            }
            Ev::Item { id, item } => {
                if matches!(item, Item::Assistant { .. } | Item::Turn { .. } | Item::Tool { .. }) {
                    self.partial.remove(&id);
                }
                // Only keep it if the history is loaded; otherwise it arrives with it.
                if let Some(c) = self.convos.get_mut(&id) {
                    c.push(item);
                }
            }
            Ev::Delta { id, text } => self.partial.entry(id).or_default().push_str(&text),
            _ => {}
        }
    }

    fn do_request(&mut self, cmd: Cmd) {
        match client::request(&cmd) {
            Ok(Ev::Ok { message: Some(m) }) => self.set_flash(m),
            Ok(_) => {}
            Err(e) => self.set_flash(format!("{e:#}")),
        }
    }

    /// The oldest unanswered permission prompt of the selected request.
    fn pending_perm(&self) -> Option<String> {
        let id = &self.selected()?.id;
        let items = self.convos.get(id)?;
        let mut state: Vec<(String, PermState)> = Vec::new();
        for i in items {
            if let Item::Permission { id, state: s, .. } = i {
                match state.iter_mut().find(|(p, _)| p == id) {
                    Some(e) => e.1 = *s,
                    None => state.push((id.clone(), *s)),
                }
            }
        }
        state.into_iter().find(|(_, s)| *s == PermState::Pending).map(|(p, _)| p)
    }

    fn on_key(&mut self, k: KeyEvent) {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        match &mut self.mode {
            Mode::Input(buf) => {
                match k.code {
                    KeyCode::Esc => self.mode = Mode::Normal,
                    KeyCode::Enter if k.modifiers.contains(KeyModifiers::ALT) || k.modifiers.contains(KeyModifiers::SHIFT) => buf.push('\n'),
                    KeyCode::Enter => {
                        let text = buf.trim().to_string();
                        self.mode = Mode::Normal;
                        if let (false, Some(id)) = (text.is_empty(), self.selected().map(|r| r.id.clone())) {
                            self.scroll = 0;
                            self.do_request(Cmd::Send { id, text });
                        }
                    }
                    KeyCode::Backspace => {
                        buf.pop();
                    }
                    KeyCode::Char('u') if ctrl => buf.clear(),
                    KeyCode::Char(c) => buf.push(c),
                    _ => {}
                }
                return;
            }
            Mode::New(f) => {
                match k.code {
                    KeyCode::Esc => self.mode = Mode::Normal,
                    KeyCode::Tab | KeyCode::Down => f.field = (f.field + 1) % 3,
                    KeyCode::BackTab | KeyCode::Up => f.field = (f.field + 2) % 3,
                    KeyCode::Left if f.field == 0 => f.project = (f.project + f.projects.len().max(1) - 1) % f.projects.len().max(1),
                    KeyCode::Right if f.field == 0 => f.project = (f.project + 1) % f.projects.len().max(1),
                    KeyCode::Enter if f.field < 2 => f.field += 1,
                    KeyCode::Enter => {
                        let (project, title, prompt) = (f.projects.get(f.project).cloned(), f.title.trim().to_string(), f.prompt.trim().to_string());
                        match project {
                            Some(project) if !title.is_empty() && !prompt.is_empty() => {
                                self.mode = Mode::Normal;
                                self.do_request(Cmd::New { project, title, prompt });
                                self.sel = 0; // newest first
                            }
                            _ => self.set_flash("project, title and prompt are all needed"),
                        }
                    }
                    KeyCode::Backspace => {
                        match f.field {
                            1 => f.title.pop(),
                            2 => f.prompt.pop(),
                            _ => None,
                        };
                    }
                    KeyCode::Char(c) => match f.field {
                        1 => f.title.push(c),
                        2 => f.prompt.push(c),
                        _ => {}
                    },
                    _ => {}
                }
                return;
            }
            Mode::ConfirmDown => {
                if let (KeyCode::Char('y'), Some(r)) = (k.code, self.selected()) {
                    let id = r.id.clone();
                    if r.status == Status::Stopped {
                        self.convos.remove(&id);
                        self.do_request(Cmd::Remove { id });
                    } else {
                        self.do_request(Cmd::Teardown { id });
                    }
                }
                self.mode = Mode::Normal;
                return;
            }
            Mode::Normal => {}
        }
        let id = self.selected().map(|r| r.id.clone());
        match k.code {
            KeyCode::Char('q') => self.quit = true,
            KeyCode::Char('c') if ctrl => match id {
                Some(id) => self.do_request(Cmd::Interrupt { id }),
                None => self.quit = true,
            },
            KeyCode::Char('j') | KeyCode::Down => {
                self.sel = (self.sel + 1).min(self.requests.len().saturating_sub(1));
                self.scroll = 0;
            }
            KeyCode::Char('k') | KeyCode::Up => {
                self.sel = self.sel.saturating_sub(1);
                self.scroll = 0;
            }
            KeyCode::Char('u') if ctrl => self.scroll += 10,
            KeyCode::Char('d') if ctrl => self.scroll = self.scroll.saturating_sub(10),
            KeyCode::PageUp => self.scroll += 20,
            KeyCode::PageDown => self.scroll = self.scroll.saturating_sub(20),
            KeyCode::Char('G') => self.scroll = 0,
            KeyCode::Enter | KeyCode::Char('i') if id.is_some() => self.mode = Mode::Input(String::new()),
            KeyCode::Char('n') => match client::request(&Cmd::Projects) {
                Ok(Ev::Projects { list }) if !list.is_empty() => self.mode = Mode::New(NewForm { projects: list, project: 0, title: String::new(), prompt: String::new(), field: 1 }),
                Ok(_) => self.set_flash(format!("no projects — add one to {}", config::config_path().display())),
                Err(e) => self.set_flash(format!("{e:#}")),
            },
            KeyCode::Char('y') | KeyCode::Char('d') => match (self.pending_perm(), id) {
                (Some(perm), Some(id)) => self.do_request(Cmd::Answer { id, perm, allow: k.code == KeyCode::Char('y') }),
                _ => self.set_flash("no permission prompt waiting"),
            },
            KeyCode::Char('g') => {
                if let Some(id) = id {
                    let target = format!("{}:{id}", self.session);
                    match Command::new("tmux").args(["switch-client", "-t", &target]).output() {
                        Ok(o) if o.status.success() => {}
                        _ => self.set_flash(format!("no tmux window {target}")),
                    }
                }
            }
            KeyCode::Char('x') if id.is_some() => self.mode = Mode::ConfirmDown,
            _ => {}
        }
    }
}

fn status_style(s: Status) -> Style {
    Style::default().fg(match s {
        Status::Setup => Color::Blue,
        Status::Working => Color::Cyan,
        Status::Waiting => Color::Green,
        Status::Approval => Color::Yellow,
        Status::Error => Color::Red,
        Status::Stopped => Color::DarkGray,
    })
}

fn render(app: &mut App, f: &mut Frame) {
    let [main, input_area, status] = Layout::vertical([Constraint::Min(3), Constraint::Length(3), Constraint::Length(1)]).areas(f.area());
    let [left, right] = Layout::horizontal([Constraint::Percentage(30), Constraint::Percentage(70)]).areas(main);

    // Requests
    let mut lines = Vec::new();
    if app.requests.is_empty() {
        lines.push(Line::styled(" no requests — n to start one", Style::default().fg(Color::DarkGray)));
    }
    for (i, r) in app.requests.iter().enumerate() {
        let sel = i == app.sel;
        let name = Style::default().add_modifier(if sel { Modifier::REVERSED } else { Modifier::empty() });
        lines.push(Line::from(vec![Span::styled("● ", status_style(r.status)), Span::styled(r.id.clone(), name)]));
        let mut meta = vec![Span::styled(format!("  {}", r.status.label()), status_style(r.status))];
        if let Some(p) = r.port {
            meta.push(Span::styled(format!(" · :{p}"), Style::default().fg(Color::DarkGray)));
        }
        if let Some(a) = &r.app {
            let c = if a.ends_with("failed") { Color::Red } else { Color::DarkGray };
            meta.push(Span::styled(format!(" · {a}"), Style::default().fg(c)));
        }
        lines.push(Line::from(meta));
    }
    let block = Block::default().borders(Borders::ALL).title(" Requests ");
    f.render_widget(Paragraph::new(lines).block(block), left);

    // Conversation
    let title = app.selected().map(|r| format!(" {} — {} ", r.id, r.title)).unwrap_or_else(|| " orc ".into());
    let block = Block::default().borders(Borders::ALL).title(title);
    let inner = block.inner(right);
    f.render_widget(block, right);
    let width = inner.width.max(1) as usize;
    let mut out: Vec<Line> = Vec::new();
    if let Some(r) = app.selected() {
        let items = app.convos.get(&r.id).cloned().unwrap_or_default();
        conversation_lines(&items, app.partial.get(&r.id), width, &mut out);
    }
    let h = inner.height as usize;
    let max_scroll = out.len().saturating_sub(h);
    app.scroll = app.scroll.min(max_scroll);
    let start = out.len().saturating_sub(h + app.scroll);
    let visible: Vec<Line> = out.into_iter().skip(start).take(h).collect();
    f.render_widget(Paragraph::new(visible), inner);

    // Input
    let (text, style, title) = match &app.mode {
        Mode::Input(b) => (format!("{b}█"), Style::default(), " message · ⏎ send · alt-⏎ newline · esc "),
        _ => ("".to_string(), Style::default().fg(Color::DarkGray), " ⏎ write a message "),
    };
    let tail: String = {
        let w = input_area.width.saturating_sub(2) as usize;
        let chars: Vec<char> = text.replace('\n', " ⏎ ").chars().collect();
        chars[chars.len().saturating_sub(w)..].iter().collect()
    };
    f.render_widget(Paragraph::new(tail).style(style).block(Block::default().borders(Borders::ALL).title(title)), input_area);

    // Status bar
    let pending = app.pending_perm().is_some();
    let text = if let Some((m, _)) = &app.flash {
        format!(" {m}")
    } else if pending {
        " permission requested — y allow · d deny".into()
    } else {
        " n new · ⏎ message · j/k select · g metroctl window · ^c interrupt · x tear down/remove · ^u/^d scroll · q quit (agents keep running)".into()
    };
    let bg = if pending && app.flash.is_none() { Color::Yellow } else { Color::Rgb(59, 66, 82) };
    let fg = if pending && app.flash.is_none() { Color::Black } else { Color::White };
    f.render_widget(Paragraph::new(text).style(Style::default().bg(bg).fg(fg)), status);

    match &app.mode {
        Mode::New(form) => render_new(form, f),
        Mode::ConfirmDown => {
            let r = centered(f.area(), 72, 6);
            f.render_widget(Clear, r);
            let (id, stopped) = app.selected().map(|r| (r.id.clone(), r.status == Status::Stopped)).unwrap_or_default();
            let (title, lines) = if stopped {
                (" Remove ", vec![Line::raw(""), Line::raw(format!("  Remove {id} from the list?")), Line::raw("  Its conversation is deleted; the branch stays in git."), Line::raw("  y remove · any key cancel")])
            } else {
                (" Tear down ", vec![Line::raw(""), Line::raw(format!("  Tear down {id}?")), Line::raw("  Stops the agent, deletes its simulator and worktree; keeps the branch."), Line::raw("  y tear down · any key cancel")])
            };
            f.render_widget(Paragraph::new(lines).block(Block::default().borders(Borders::ALL).border_style(Style::default().fg(Color::Yellow)).title(title)), r);
        }
        _ => {}
    }
}

fn wrap_push(out: &mut Vec<Line<'static>>, text: &str, width: usize, indent: &str, style: Style) {
    let w = width.saturating_sub(indent.chars().count()).max(10);
    for raw in text.lines() {
        // Tabs (e.g. in Read output) would desync ratatui's cell widths.
        let chars: Vec<char> = raw.replace('\t', "  ").chars().filter(|c| !c.is_control()).collect();
        if chars.is_empty() {
            out.push(Line::raw(""));
            continue;
        }
        for chunk in chars.chunks(w) {
            out.push(Line::styled(format!("{indent}{}", chunk.iter().collect::<String>()), style));
        }
    }
}

fn conversation_lines(items: &[Item], partial: Option<&String>, width: usize, out: &mut Vec<Line<'static>>) {
    // Permission prompts are logged again when answered; show the latest state once.
    let mut latest: HashMap<&str, PermState> = HashMap::new();
    for i in items {
        if let Item::Permission { id, state, .. } = i {
            latest.insert(id.as_str(), *state);
        }
    }
    let mut shown: Vec<&str> = Vec::new();
    let dim = Style::default().fg(Color::DarkGray);
    // Parallel tool calls finish in any order: show each result under its call.
    let results: HashMap<&str, (bool, &str)> = items
        .iter()
        .filter_map(|i| if let Item::ToolResult { id, ok, preview } = i { Some((id.as_str(), (*ok, preview.as_str()))) } else { None })
        .collect();
    let result_lines = |out: &mut Vec<Line<'static>>, ok: bool, preview: &str| {
        let style = if ok { dim } else { Style::default().fg(Color::Red) };
        wrap_push(out, preview, width, "    ", style);
    };
    for i in items {
        match i {
            Item::User { text } => {
                out.push(Line::raw(""));
                wrap_push(out, text, width, "› ", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD));
            }
            Item::Assistant { text } => {
                out.push(Line::raw(""));
                wrap_push(out, text, width, "", Style::default());
            }
            Item::Tool { id, name, summary } => {
                wrap_push(out, &format!("⚙ {name} {summary}"), width, "  ", Style::default().fg(Color::Magenta));
                if let Some((ok, preview)) = results.get(id.as_str()) {
                    result_lines(out, *ok, preview);
                }
            }
            Item::ToolResult { .. } => {} // shown under its call
            Item::System { text } => wrap_push(out, &format!("· {text}"), width, "", Style::default().fg(Color::Blue)),
            Item::Permission { id, tool, summary, .. } => {
                if shown.contains(&id.as_str()) {
                    continue;
                }
                shown.push(id);
                let (mark, style) = match latest.get(id.as_str()) {
                    Some(PermState::Allowed) => ("✓ allowed", Style::default().fg(Color::Green)),
                    Some(PermState::Denied) => ("✗ denied", Style::default().fg(Color::Red)),
                    _ => ("? waiting — y allow · d deny", Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
                };
                wrap_push(out, &format!("{tool} {summary}  {mark}"), width, "  ⚠ ", style);
            }
            Item::Turn { cost, error } => {
                let t = match error {
                    Some(e) => format!("— turn failed: {e}"),
                    None => format!("— done{}", cost.map(|c| format!(" · ${c:.2}")).unwrap_or_default()),
                };
                wrap_push(out, &t, width, "", if error.is_some() { Style::default().fg(Color::Red) } else { dim });
            }
        }
    }
    if let Some(p) = partial.filter(|p| !p.is_empty()) {
        out.push(Line::raw(""));
        wrap_push(out, p, width, "", Style::default());
    }
}

fn render_new(form: &NewForm, f: &mut Frame) {
    let r = centered(f.area(), 80, 12);
    f.render_widget(Clear, r);
    let field = |i: usize, label: &str, value: String| {
        let active = form.field == i;
        Line::from(vec![
            Span::styled(format!("  {label:<9}"), if active { Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD) } else { Style::default().fg(Color::DarkGray) }),
            Span::raw(if active { format!("{value}█") } else { value }),
        ])
    };
    let project = form.projects.get(form.project).cloned().unwrap_or_default();
    let prompt: String = {
        let chars: Vec<char> = form.prompt.chars().collect();
        let w = r.width.saturating_sub(16) as usize * 4;
        chars[chars.len().saturating_sub(w)..].iter().collect()
    };
    let lines = vec![
        Line::raw(""),
        field(0, "project", format!("‹ {project} ›")),
        Line::raw(""),
        field(1, "title", form.title.clone()),
        Line::raw(""),
        field(2, "prompt", prompt),
        Line::raw(""),
        Line::styled("  ⇥ next field · ←/→ project · ⏎ start · esc cancel", Style::default().fg(Color::DarkGray)),
    ];
    let p = Paragraph::new(lines).wrap(ratatui::widgets::Wrap { trim: false });
    f.render_widget(p.block(Block::default().borders(Borders::ALL).border_style(Style::default().fg(Color::Cyan)).title(" New request ")), r);
}

fn centered(area: Rect, w: u16, h: u16) -> Rect {
    let w = w.min(area.width);
    let h = h.min(area.height);
    Rect { x: area.x + (area.width - w) / 2, y: area.y + (area.height - h) / 2, width: w, height: h }
}
