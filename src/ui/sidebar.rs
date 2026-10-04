//! The left sidebar: the roster of agents grouped by project, with the selected one highlighted.

use crate::types::{AgentInfo, AgentStatus};
use crate::ui::layout::{block_height, scroll_offset};
use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Paragraph};

/// A short human label for a status.
pub fn status_label(status: AgentStatus) -> &'static str {
    match status {
        AgentStatus::Booting => "booting",
        AgentStatus::Working => "working",
        AgentStatus::NeedsInput => "needs input",
        AgentStatus::NeedsApproval => "needs approval",
        AgentStatus::NeedsLogin => "needs login",
        AgentStatus::Paused => "paused",
        AgentStatus::Done => "done",
        AgentStatus::Error => "error",
        AgentStatus::Stopped => "stopped",
    }
}

/// The accent color for a status.
pub fn status_style(status: AgentStatus) -> Style {
    let color = match status {
        AgentStatus::Booting => Color::Yellow,
        AgentStatus::Working => Color::Cyan,
        AgentStatus::NeedsInput => Color::Magenta,
        AgentStatus::NeedsApproval => Color::Yellow,
        AgentStatus::NeedsLogin => Color::Red,
        AgentStatus::Paused => Color::Gray,
        AgentStatus::Done => Color::Green,
        AgentStatus::Error => Color::Red,
        AgentStatus::Stopped => Color::DarkGray,
    };
    Style::default().fg(color)
}

/// Render the sidebar into `area`.
pub fn render(f: &mut Frame, area: Rect, infos: &[AgentInfo], selected: usize) {
    let block = Block::default()
        .borders(Borders::ALL)
        .title(format!(" Agents ({}) ", infos.len()));
    let inner = block.inner(area);
    f.render_widget(block, area);

    if infos.is_empty() {
        let hint = Paragraph::new("No agents yet.\n\nPress 'n' to start one.")
            .style(Style::default().fg(Color::DarkGray));
        f.render_widget(hint, inner);
        return;
    }

    let mut lines: Vec<Line> = Vec::new();
    let mut block_heights: Vec<u16> = Vec::new();
    let mut prev_project: Option<&str> = None;

    for (i, info) in infos.iter().enumerate() {
        let new_header = prev_project != Some(info.project.as_str());
        if new_header {
            lines.push(Line::from(Span::styled(
                format!("{}", info.project),
                Style::default()
                    .fg(Color::Blue)
                    .add_modifier(Modifier::BOLD),
            )));
        }
        prev_project = Some(info.project.as_str());
        block_heights.push(block_height(false, new_header));

        let selected_row = i == selected;
        let marker = if selected_row { "▸ " } else { "  " };
        let mut name_style = Style::default();
        if selected_row {
            name_style = name_style.add_modifier(Modifier::BOLD).bg(Color::Indexed(236));
        }
        lines.push(Line::from(vec![
            Span::styled(format!("{marker}{}", i + 1), Style::default().fg(Color::DarkGray)),
            Span::styled(format!(" {}", info.name), name_style),
        ]));

        let mut status_span = status_label(info.status).to_string();
        if let Some(cost) = info.total_cost_usd {
            status_span = format!("{status_span}  ${cost:.2}");
        }
        lines.push(Line::from(vec![
            Span::raw("   "),
            Span::styled(status_span, status_style(info.status)),
        ]));
    }

    let offset = scroll_offset(&block_heights, selected, inner.height);
    let para = Paragraph::new(lines).scroll((offset, 0));
    f.render_widget(para, inner);
}
