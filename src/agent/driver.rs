//! The `ClaudeDriver` seam: an abstraction over spawning a `claude` CLI session and streaming its
//! events. Implementations will be `CliDriver` (the real subprocess) and `MockDriver` (tests).

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// A single event streamed from a running Claude session.
#[derive(Debug, Clone, PartialEq)]
pub enum DriverEvent {
    /// The SDK reported the session id.
    SessionId(String),
    /// The model id in use.
    Model(String),
    /// A chunk of assistant text.
    TextDelta(String),
    /// A chunk of thinking/reasoning text.
    ThinkingDelta(String),
    /// The assistant invoked a tool.
    ToolUse {
        id: String,
        name: String,
        input_json: String,
    },
    /// The result of a tool invocation.
    ToolResult {
        tool_use_id: String,
        text: String,
        is_error: bool,
    },
    /// The assistant message finished streaming.
    MessageStop,
    /// The turn completed with a final result.
    TurnResult {
        subtype: String,
        text: String,
        cost_usd: Option<f64>,
        is_error: bool,
        session_id: Option<String>,
        errors: Vec<String>,
    },
}

/// Options for starting a session.
#[derive(Debug, Clone, Default)]
pub struct SessionOpts {
    pub model: String,
    pub cwd: Option<String>,
    pub resume_session_id: Option<String>,
    pub system_prompt: Option<String>,
    pub permission_mode: Option<String>,
}

/// A handle to a started session: its event stream, a stdin sender, and a cancel token.
pub struct DriverHandle {
    pub events: mpsc::Receiver<DriverEvent>,
    pub stdin: mpsc::Sender<String>,
    pub cancel: CancellationToken,
}

/// The seam over a Claude CLI session.
#[async_trait::async_trait]
pub trait ClaudeDriver: Send + Sync {
    /// Start a session, returning a handle to its event stream + stdin + cancel token.
    async fn start(&self, opts: SessionOpts) -> anyhow::Result<DriverHandle>;
}
