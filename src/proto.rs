//! Types shared by orcd and its clients, and the wire format between them:
//! JSON lines over `~/.config/orc/orcd.sock`. A client sends one `Cmd` per
//! line; orcd answers with `Ev` lines (a `subscribe`d client keeps receiving
//! them).

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Setup,    // creating the worktree etc.
    Working,  // the agent is on a turn
    Waiting,  // turn finished: your move
    Approval, // a permission prompt is open
    Error,
    Stopped, // torn down
}

impl Status {
    pub fn label(self) -> &'static str {
        match self {
            Status::Setup => "setup",
            Status::Working => "working",
            Status::Waiting => "waiting",
            Status::Approval => "approve?",
            Status::Error => "error",
            Status::Stopped => "stopped",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Request {
    pub id: String, // slug; also the branch and tmux window name
    pub project: String,
    pub title: String,
    pub branch: String,
    pub worktree: String,
    #[serde(default)]
    pub session_id: Option<String>,
    pub status: Status,
    pub created: u64,
    /// Metro port / simulator, once metroctl wrote its session file.
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub udid: Option<String>,
    /// metroctl session status (building, running, build_failed…).
    #[serde(default)]
    pub app: Option<String>,
}

/// One entry in a request's conversation.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Item {
    User { text: String },
    Assistant { text: String },
    Tool { id: String, name: String, summary: String },
    ToolResult { id: String, ok: bool, preview: String },
    System { text: String },
    Permission { id: String, tool: String, summary: String, state: PermState },
    Turn { cost: Option<f64>, error: Option<String> },
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermState {
    Pending,
    Allowed,
    Denied,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Cmd {
    /// Requests list, then every event until the connection closes.
    Subscribe,
    List,
    Projects,
    History { id: String },
    New { project: String, title: String, prompt: String },
    Send { id: String, text: String },
    Interrupt { id: String },
    Answer { id: String, perm: String, allow: bool },
    Teardown { id: String },
    /// Forget a torn-down request (its conversation log too).
    Remove { id: String },
    /// From `orc perm-mcp`: blocks until the user answers in the TUI.
    PermRequest { id: String, tool: String, input: serde_json::Value },
    Shutdown,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "ev", rename_all = "snake_case")]
pub enum Ev {
    Requests { list: Vec<Request> },
    Projects { list: Vec<String> },
    History { id: String, items: Vec<Item> },
    Item { id: String, item: Item },
    /// Streaming assistant text, not persisted (the full `assistant` item follows).
    Delta { id: String, text: String },
    Decision { allow: bool, message: Option<String> },
    Ok { message: Option<String> },
    Error { message: String },
}
