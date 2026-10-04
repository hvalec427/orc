//! The new-agent form: pick a project, then enter name / ticket / prompt.

use crate::ui::input_bar::TextInput;
use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Clear, Paragraph};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormStep {
    Project,
    Name,
    Ticket,
    Prompt,
}

/// State for the multi-step new-agent form.
#[derive(Debug, Clone)]
pub struct NewAgentForm {
    pub step: FormStep,
    pub projects: Vec<String>,
    pub project_idx: usize,
    pub name: TextInput,
    pub ticket: TextInput,
    pub prompt: TextInput,
}

impl NewAgentForm {
    pub fn new(projects: Vec<String>) -> Self {
        Self {
            step: FormStep::Project,
            projects,
            project_idx: 0,
            name: TextInput::new(),
            ticket: TextInput::new(),
            prompt: TextInput::new(),
        }
    }

    /// The text input for the current step, if the step is a text field.
    pub fn active_input(&mut self) -> Option<&mut TextInput> {
        match self.step {
            FormStep::Project => None,
            FormStep::Name => Some(&mut self.name),
            FormStep::Ticket => Some(&mut self.ticket),
            FormStep::Prompt => Some(&mut self.prompt),
        }
    }

    pub fn project_up(&mut self) {
        if self.project_idx > 0 {
            self.project_idx -= 1;
        }
    }

    pub fn project_down(&mut self) {
        if self.project_idx + 1 < self.projects.len() {
            self.project_idx += 1;
        }
    }

    /// Advance to the next step. Returns `true` when the form is complete and ready to submit.
    /// Refuses to advance past required empty fields (project list / name / prompt).
    pub fn advance(&mut self) -> bool {
        match self.step {
            FormStep::Project => {
                if self.projects.is_empty() {
                    return false;
                }
                self.step = FormStep::Name;
                false
            }
            FormStep::Name => {
                if self.name.is_empty() {
                    return false;
                }
                self.step = FormStep::Ticket;
                false
            }
            FormStep::Ticket => {
                self.step = FormStep::Prompt;
                false
            }
            FormStep::Prompt => !self.prompt.is_empty(),
        }
    }

    /// Step back to the previous step; returns false if already at the first step.
    pub fn back(&mut self) -> bool {
        self.step = match self.step {
            FormStep::Project => return false,
            FormStep::Name => FormStep::Project,
            FormStep::Ticket => FormStep::Name,
            FormStep::Prompt => FormStep::Ticket,
        };
        true
    }

    pub fn selected_project(&self) -> Option<&str> {
        self.projects.get(self.project_idx).map(String::as_str)
    }
}

fn field_line(label: &str, value: &str, active: bool) -> Line<'static> {
    let label_style = if active {
        Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::DarkGray)
    };
    Line::from(vec![
        Span::styled(format!("{label:>9}: "), label_style),
        Span::raw(value.to_string()),
    ])
}

/// Render the form centered in `area`.
pub fn render(f: &mut Frame, area: Rect, form: &NewAgentForm) {
    // Center a box.
    let w = area.width.min(72);
    let h = area.height.min(16);
    let x = area.x + (area.width.saturating_sub(w)) / 2;
    let y = area.y + (area.height.saturating_sub(h)) / 2;
    let rect = Rect::new(x, y, w, h);
    f.render_widget(Clear, rect);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(" New agent  (Enter: next · Esc: cancel) ");
    let inner = block.inner(rect);
    f.render_widget(block, rect);

    let mut lines: Vec<Line> = Vec::new();

    // Project step: a pickable list.
    lines.push(Line::from(Span::styled(
        "  project:",
        if form.step == FormStep::Project {
            Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::DarkGray)
        },
    )));
    if form.projects.is_empty() {
        lines.push(Line::from(Span::styled(
            "    (no projects in config)",
            Style::default().fg(Color::Red),
        )));
    } else {
        for (i, p) in form.projects.iter().enumerate() {
            let sel = i == form.project_idx;
            let marker = if sel { "  ▸ " } else { "    " };
            let style = if sel && form.step == FormStep::Project {
                Style::default().fg(Color::White).bg(Color::Indexed(236))
            } else if sel {
                Style::default().fg(Color::White)
            } else {
                Style::default().fg(Color::Gray)
            };
            lines.push(Line::from(Span::styled(format!("{marker}{p}"), style)));
        }
    }
    lines.push(Line::from(""));

    // Name / ticket show their typed value; the active one shows a cursor.
    let name_val = render_value(&form.name, form.step == FormStep::Name);
    lines.push(field_line("name", &name_val, form.step == FormStep::Name));
    let ticket_val = render_value(&form.ticket, form.step == FormStep::Ticket);
    lines.push(field_line("ticket", &ticket_val, form.step == FormStep::Ticket));

    // Prompt gets its own labeled line + value line.
    lines.push(field_line("prompt", "", form.step == FormStep::Prompt));
    if form.step == FormStep::Prompt {
        lines.push(Line::from(vec![Span::raw("    "), span_cursor(&form.prompt)]));
    } else {
        lines.push(Line::from(Span::raw(format!("    {}", form.prompt.value()))));
    }

    f.render_widget(Paragraph::new(lines), inner);
}

fn render_value(input: &TextInput, active: bool) -> String {
    if active {
        format!("{}\u{2588}", input.value())
    } else {
        input.value()
    }
}

fn span_cursor(input: &TextInput) -> Span<'static> {
    Span::raw(format!("{}\u{2588}", input.value()))
}
