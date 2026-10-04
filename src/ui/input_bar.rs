//! A single-line text input primitive and the "reply to agent" input bar.

use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Paragraph};

/// A minimal single-line text editor (char-indexed cursor).
#[derive(Debug, Clone, Default)]
pub struct TextInput {
    chars: Vec<char>,
    cursor: usize,
}

impl TextInput {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with(value: &str) -> Self {
        let chars: Vec<char> = value.chars().collect();
        let cursor = chars.len();
        Self { chars, cursor }
    }

    pub fn value(&self) -> String {
        self.chars.iter().collect()
    }

    pub fn is_empty(&self) -> bool {
        self.chars.is_empty()
    }

    pub fn clear(&mut self) {
        self.chars.clear();
        self.cursor = 0;
    }

    pub fn insert(&mut self, c: char) {
        self.chars.insert(self.cursor, c);
        self.cursor += 1;
    }

    pub fn backspace(&mut self) {
        if self.cursor > 0 {
            self.cursor -= 1;
            self.chars.remove(self.cursor);
        }
    }

    pub fn delete(&mut self) {
        if self.cursor < self.chars.len() {
            self.chars.remove(self.cursor);
        }
    }

    pub fn left(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub fn right(&mut self) {
        if self.cursor < self.chars.len() {
            self.cursor += 1;
        }
    }

    pub fn home(&mut self) {
        self.cursor = 0;
    }

    pub fn end(&mut self) {
        self.cursor = self.chars.len();
    }

    /// The value as a `Line` with a block cursor rendered at the insertion point.
    pub fn as_line(&self) -> Line<'static> {
        let mut spans = Vec::new();
        let before: String = self.chars[..self.cursor].iter().collect();
        spans.push(Span::raw(before));
        let cursor_style = Style::default().add_modifier(Modifier::REVERSED);
        if self.cursor < self.chars.len() {
            spans.push(Span::styled(self.chars[self.cursor].to_string(), cursor_style));
            let after: String = self.chars[self.cursor + 1..].iter().collect();
            spans.push(Span::raw(after));
        } else {
            spans.push(Span::styled(" ", cursor_style));
        }
        Line::from(spans)
    }
}

/// Render the reply input bar. `question` is the agent's pending question, if any.
pub fn render(f: &mut Frame, area: Rect, agent_name: &str, question: Option<&str>, input: &TextInput) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Yellow))
        .title(format!(" reply to {agent_name}  (Enter: send · Esc: cancel) "));
    let inner = block.inner(area);
    f.render_widget(block, area);

    let mut lines = Vec::new();
    if let Some(q) = question {
        lines.push(Line::from(Span::styled(
            format!("? {q}"),
            Style::default().fg(Color::Magenta),
        )));
    }
    lines.push(input.as_line());
    f.render_widget(Paragraph::new(lines), inner);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_and_backspace() {
        let mut t = TextInput::new();
        for c in "abc".chars() {
            t.insert(c);
        }
        assert_eq!(t.value(), "abc");
        t.backspace();
        assert_eq!(t.value(), "ab");
    }

    #[test]
    fn cursor_movement_inserts_midword() {
        let mut t = TextInput::with("ac");
        t.left();
        t.insert('b');
        assert_eq!(t.value(), "abc");
    }
}
