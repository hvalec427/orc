//! The right pane: the selected agent's title + streaming log, scrollable and tail-following.

use crate::agent::session::SessionState;
use crate::types::LogEntry;
use crate::ui::log_format::{format_log_entry, log_kind_style};
use crate::ui::sidebar::{status_label, status_style};
use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Paragraph};

/// Hard-wrap a single logical line to `width` columns, preserving word boundaries where cheap.
fn wrap(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    if text.is_empty() {
        return vec![String::new()];
    }
    let mut out = Vec::new();
    for logical in text.split('\n') {
        if logical.chars().count() <= width {
            out.push(logical.to_string());
            continue;
        }
        let mut current = String::new();
        let mut col = 0usize;
        for word in logical.split_inclusive(' ') {
            let wlen = word.chars().count();
            if col + wlen > width && col > 0 {
                out.push(std::mem::take(&mut current));
                col = 0;
            }
            if wlen > width {
                // a single oversized token: hard split by chars
                for ch in word.chars() {
                    if col == width {
                        out.push(std::mem::take(&mut current));
                        col = 0;
                    }
                    current.push(ch);
                    col += 1;
                }
            } else {
                current.push_str(word);
                col += wlen;
            }
        }
        out.push(current);
    }
    out
}

/// Build the full set of display lines for the log, pre-wrapped to `width`.
fn log_lines(logs: &[LogEntry], width: usize) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    for entry in logs {
        let style = log_kind_style(entry.kind);
        let rendered = format_log_entry(entry);
        for piece in wrap(&rendered, width) {
            lines.push(Line::from(Span::styled(piece, style)));
        }
    }
    lines
}

/// Render the agent view. `scroll` is `None` to follow the tail, or `Some(top_line)` when the user
/// has scrolled up. Returns `(top, max_top)`: the clamped top line used and the maximum top (so the
/// app can drive scrolling and know when it has reached the live tail).
pub fn render(
    f: &mut Frame,
    area: Rect,
    state: Option<&SessionState>,
    scroll: Option<usize>,
) -> (usize, usize) {
    let Some(state) = state else {
        let block = Block::default().borders(Borders::ALL).title(" Agent ");
        let inner = block.inner(area);
        f.render_widget(block, area);
        f.render_widget(
            Paragraph::new("Select an agent, or press 'n' to start one.")
                .style(Style::default().fg(Color::DarkGray)),
            inner,
        );
        return (0, 0);
    };

    let info = &state.info;
    let mut title = format!(" {} · {} ", info.name, status_label(info.status));
    if let Some(cost) = info.total_cost_usd {
        title = format!("{title}· ${cost:.2} ");
    }
    let block = Block::default()
        .borders(Borders::ALL)
        .title(Span::styled(title, status_style(info.status)))
        .title_bottom(match info.question.as_deref() {
            Some(q) if info.status == crate::types::AgentStatus::NeedsInput => {
                Line::from(Span::styled(
                    format!(" ? {q} "),
                    Style::default().fg(Color::Magenta),
                ))
            }
            _ => Line::from(""),
        });
    let inner = block.inner(area);
    f.render_widget(block, area);

    let width = inner.width as usize;
    let height = inner.height as usize;
    let lines = log_lines(&state.logs, width);
    let total = lines.len();

    let max_top = total.saturating_sub(height);
    let top = match scroll {
        None => max_top,                 // follow tail
        Some(s) => s.min(max_top),       // clamp user scroll
    };

    let para = Paragraph::new(lines).scroll((top as u16, 0));
    f.render_widget(para, inner);
    (top, max_top)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_short_line_unchanged() {
        assert_eq!(wrap("hello", 20), vec!["hello".to_string()]);
    }

    #[test]
    fn wrap_breaks_on_width() {
        let out = wrap("aaaa bbbb cccc", 9);
        assert!(out.len() >= 2);
        assert!(out.iter().all(|l| l.chars().count() <= 9));
    }

    #[test]
    fn wrap_hard_splits_oversized_token() {
        let out = wrap(&"x".repeat(25), 10);
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn wrap_preserves_newlines() {
        let out = wrap("a\nb", 10);
        assert_eq!(out, vec!["a".to_string(), "b".to_string()]);
    }
}
