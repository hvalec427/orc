//! Agent session: owns one driver handle, tracks status/logs, feeds input. (Stub milestone.)

/// A single running agent session.
pub struct AgentSession;

impl AgentSession {
    /// Create a session (stub).
    pub fn new() -> Self {
        todo!("AgentSession::new")
    }
}

impl Default for AgentSession {
    fn default() -> Self {
        Self::new()
    }
}
