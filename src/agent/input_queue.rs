//! Serializes human/agent input to a session: queues messages while a turn is in flight and
//! releases the next once the turn ends.

/// A FIFO queue of pending input lines for one session.
pub struct InputQueue {
    pending: std::collections::VecDeque<String>,
    closed: bool,
}

impl InputQueue {
    /// Create an empty, open queue.
    pub fn new() -> Self {
        Self {
            pending: std::collections::VecDeque::new(),
            closed: false,
        }
    }

    /// Enqueue a line. No-op once closed.
    pub fn push(&mut self, line: String) {
        if self.closed {
            return;
        }
        self.pending.push_back(line);
    }

    /// Pop the next line, or `None` if empty.
    pub fn pop(&mut self) -> Option<String> {
        self.pending.pop_front()
    }

    /// Number of pending lines.
    pub fn len(&self) -> usize {
        self.pending.len()
    }

    /// Whether the queue is empty.
    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// Close the queue; further pushes are ignored.
    pub fn close(&mut self) {
        self.closed = true;
    }

    /// Whether the queue is closed.
    pub fn is_closed(&self) -> bool {
        self.closed
    }
}

impl Default for InputQueue {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_then_next_is_fifo() {
        let mut q = InputQueue::new();
        q.push("a".to_string());
        q.push("b".to_string());
        assert_eq!(q.len(), 2);
        assert_eq!(q.pop(), Some("a".to_string()));
        assert_eq!(q.pop(), Some("b".to_string()));
        assert_eq!(q.pop(), None);
    }

    #[test]
    fn close_ignores_further_pushes() {
        let mut q = InputQueue::new();
        q.close();
        assert!(q.is_closed());
        q.push("a".to_string());
        assert!(q.is_empty());
    }
}
