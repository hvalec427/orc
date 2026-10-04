//! Formatting + styling agent log entries for display.

use crate::types::{LogEntry, LogKind};
use ratatui::style::{Color, Modifier, Style};

/// The ratatui style for a log line of the given kind. Kept in one place so the agent view and any
/// other renderer agree on how each kind looks.
pub fn log_kind_style(kind: LogKind) -> Style {
    match kind {
        LogKind::Text => Style::default(),
        LogKind::Thinking => Style::default().fg(Color::Gray).add_modifier(Modifier::DIM),
        LogKind::Tool => Style::default().fg(Color::Cyan),
        LogKind::ToolResult => Style::default().fg(Color::White).add_modifier(Modifier::DIM),
        LogKind::System => Style::default().fg(Color::Gray).add_modifier(Modifier::DIM),
        LogKind::Result => Style::default().fg(Color::Green),
        LogKind::Error => Style::default().fg(Color::Red),
        LogKind::Input => Style::default().fg(Color::Yellow),
        LogKind::Subagent => Style::default().fg(Color::Magenta),
    }
}

/// Render a log entry to a display string, prefixing tool lines with the tool name.
pub fn format_log_entry(entry: &LogEntry) -> String {
    match entry.kind {
        LogKind::Tool => {
            let name = entry.tool_name.as_deref().unwrap_or("tool");
            if entry.text.is_empty() {
                format!("⚙ {name}")
            } else {
                format!("⚙ {name} {}", entry.text)
            }
        }
        LogKind::ToolResult => {
            if entry.text.is_empty() {
                "  ↳ (done)".to_string()
            } else {
                format!("  ↳ {}", entry.text)
            }
        }
        LogKind::Thinking => format!("💭 {}", entry.text),
        _ => entry.text.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: LogKind, text: &str, tool: Option<&str>) -> LogEntry {
        LogEntry {
            id: 1,
            kind,
            text: text.to_string(),
            tool_name: tool.map(str::to_string),
            tool_use_id: None,
            done: false,
        }
    }

    #[test]
    fn tool_line_includes_name() {
        let e = entry(LogKind::Tool, "{\"path\":\"a\"}", Some("Read"));
        assert!(format_log_entry(&e).contains("Read"));
    }

    #[test]
    fn plain_text_passthrough() {
        let e = entry(LogKind::Text, "hello", None);
        assert_eq!(format_log_entry(&e), "hello");
    }

    #[test]
    fn styles_are_distinct_for_error_and_input() {
        assert_ne!(log_kind_style(LogKind::Error), log_kind_style(LogKind::Input));
    }
}
