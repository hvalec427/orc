//! Agent session: owns one driver handle, tracks status/logs, feeds input.
//!
//! The session keeps a long-lived `claude` process (streaming input + output). A background task
//! owns the event stream and mutates [`SessionState`] behind a mutex; the UI reads that state each
//! frame. Input from the human is pushed onto the live process's stdin; if the process has died
//! (crash / finished / restored from a previous run) the next input relaunches it with
//! `--resume <session_id>` so history is preserved.

use crate::agent::driver::{ClaudeDriver, DriverEvent, SessionOpts};
use crate::agent::prompt::{detect_turn_end, TurnEnd};
use crate::types::{is_dead, AgentInfo, AgentStatus, LogEntry, LogKind};
use std::sync::{Arc, Mutex};
use tokio::runtime::Handle;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Mutable, UI-visible state for one agent, guarded by a mutex.
#[derive(Debug, Clone)]
pub struct SessionState {
    pub info: AgentInfo,
    pub logs: Vec<LogEntry>,
    next_log_id: u64,
    /// The in-progress assistant text entry being appended to (coalesces text deltas).
    open_text_id: Option<u64>,
    open_thinking_id: Option<u64>,
}

impl SessionState {
    fn new(info: AgentInfo) -> Self {
        Self {
            info,
            logs: Vec::new(),
            next_log_id: 1,
            open_text_id: None,
            open_thinking_id: None,
        }
    }

    fn add_log(&mut self, kind: LogKind, text: impl Into<String>) -> u64 {
        let id = self.next_log_id;
        self.next_log_id += 1;
        self.logs.push(LogEntry {
            id,
            kind,
            text: text.into(),
            tool_name: None,
            tool_use_id: None,
            done: false,
        });
        id
    }

    fn append_text(&mut self, kind: LogKind, delta: &str) {
        let open = match kind {
            LogKind::Thinking => &mut self.open_thinking_id,
            _ => &mut self.open_text_id,
        };
        if let Some(id) = *open {
            if let Some(e) = self.logs.iter_mut().find(|e| e.id == id) {
                e.text.push_str(delta);
                return;
            }
        }
        let id = self.add_log(kind, delta);
        match kind {
            LogKind::Thinking => self.open_thinking_id = Some(id),
            _ => self.open_text_id = Some(id),
        }
    }

    fn close_open_entries(&mut self) {
        if let Some(id) = self.open_text_id.take() {
            if let Some(e) = self.logs.iter_mut().find(|e| e.id == id) {
                e.done = true;
            }
        }
        if let Some(id) = self.open_thinking_id.take() {
            if let Some(e) = self.logs.iter_mut().find(|e| e.id == id) {
                e.done = true;
            }
        }
    }
}

/// A single running (or resumable) agent session.
pub struct AgentSession {
    pub state: Arc<Mutex<SessionState>>,
    driver: Arc<dyn ClaudeDriver>,
    rt: Handle,
    opts: SessionOpts,
    input_tx: Option<mpsc::Sender<String>>,
    cancel: Option<CancellationToken>,
}

impl AgentSession {
    /// Create a session for `info` with a base `opts` (model/cwd/system_prompt/env/permission).
    /// Nothing is spawned until [`start`](Self::start).
    pub fn new(info: AgentInfo, driver: Arc<dyn ClaudeDriver>, rt: Handle, opts: SessionOpts) -> Self {
        Self {
            state: Arc::new(Mutex::new(SessionState::new(info))),
            driver,
            rt,
            opts,
            input_tx: None,
            cancel: None,
        }
    }

    /// A cheap snapshot of the agent's current info for the sidebar.
    pub fn info(&self) -> AgentInfo {
        self.state.lock().unwrap().info.clone()
    }

    pub fn status(&self) -> AgentStatus {
        self.state.lock().unwrap().info.status
    }

    /// A full clone of the current state for rendering (logs + info), taken under a brief lock.
    pub fn snapshot(&self) -> SessionState {
        self.state.lock().unwrap().clone()
    }

    /// Append a system note to the agent's log (e.g. an orc-side diagnostic).
    pub fn note(&self, msg: impl Into<String>) {
        self.state.lock().unwrap().add_log(LogKind::System, msg);
    }

    /// Launch the `claude` process and begin consuming its events, then deliver the initial prompt.
    pub fn start(&mut self, initial_prompt: String) {
        self.spawn_process(None);
        self.deliver(initial_prompt, LogKind::Input, true);
    }

    /// Deliver human/agent input to the session, relaunching (resume) first if the process is dead.
    pub fn send(&mut self, text: String) {
        let dead = {
            let st = self.state.lock().unwrap();
            is_dead(st.info.status) || self.input_tx.is_none()
        };
        if dead {
            let resume = self.state.lock().unwrap().info.session_id.clone();
            self.spawn_process(resume);
        }
        self.deliver(text, LogKind::Input, true);
    }

    /// Resume a finished/crashed agent without new input ("Continue.").
    pub fn resume(&mut self) {
        self.send("Continue.".to_string());
    }

    /// Stop the session: cancel the process and mark it stopped.
    pub fn stop(&mut self) {
        if let Some(c) = self.cancel.take() {
            c.cancel();
        }
        self.input_tx = None;
        let mut st = self.state.lock().unwrap();
        st.close_open_entries();
        if !is_dead(st.info.status) {
            st.info.status = AgentStatus::Stopped;
            st.add_log(LogKind::System, "■ stopped");
        }
    }

    fn deliver(&mut self, text: String, kind: LogKind, show: bool) {
        if show {
            let mut st = self.state.lock().unwrap();
            st.close_open_entries();
            st.add_log(kind, format!("you: {text}"));
            st.info.status = AgentStatus::Working;
            st.info.question = None;
        }
        if let Some(tx) = &self.input_tx {
            if tx.try_send(text).is_err() {
                // channel full/closed — mark error so the next send relaunches.
                let mut st = self.state.lock().unwrap();
                if !is_dead(st.info.status) {
                    st.info.status = AgentStatus::Error;
                }
                self.input_tx = None;
            }
        }
    }

    /// Spawn (or respawn with `resume`) the underlying process and its event-consumer task.
    fn spawn_process(&mut self, resume: Option<String>) {
        // tear down any prior process
        if let Some(c) = self.cancel.take() {
            c.cancel();
        }

        let mut opts = self.opts.clone();
        opts.resume_session_id = resume;

        let driver = self.driver.clone();
        let state = self.state.clone();

        // start() is async; block on it on the runtime to get the handle synchronously.
        let started = self.rt.block_on(async move { driver.start(opts).await });

        match started {
            Ok(handle) => {
                self.input_tx = Some(handle.stdin);
                self.cancel = Some(handle.cancel);
                {
                    let mut st = state.lock().unwrap();
                    if !is_dead(st.info.status) || st.info.status == AgentStatus::Error {
                        st.info.status = AgentStatus::Working;
                    }
                }
                let mut events = handle.events;
                let state_for_task = state.clone();
                self.rt.spawn(async move {
                    while let Some(evt) = events.recv().await {
                        apply_event(&state_for_task, evt);
                    }
                    // stream closed: if we were still live, the process died unexpectedly.
                    let mut st = state_for_task.lock().unwrap();
                    st.close_open_entries();
                    if !is_dead(st.info.status) {
                        st.info.status = AgentStatus::Error;
                        st.add_log(LogKind::Error, "⚠ session ended unexpectedly");
                    }
                });
            }
            Err(e) => {
                let mut st = state.lock().unwrap();
                st.info.status = AgentStatus::Error;
                st.add_log(LogKind::Error, format!("⚠ failed to start session: {e}"));
                self.input_tx = None;
            }
        }
    }
}

/// Apply a single driver event to the shared state.
fn apply_event(state: &Arc<Mutex<SessionState>>, evt: DriverEvent) {
    let mut st = state.lock().unwrap();
    match evt {
        DriverEvent::SessionId(id) => st.info.session_id = Some(id),
        DriverEvent::Model(_m) => {}
        DriverEvent::TextDelta(t) => st.append_text(LogKind::Text, &t),
        DriverEvent::ThinkingDelta(t) => st.append_text(LogKind::Thinking, &t),
        DriverEvent::ToolUse { name, input_json, id } => {
            st.close_open_entries();
            let log_id = st.add_log(LogKind::Tool, input_json);
            if let Some(e) = st.logs.iter_mut().find(|e| e.id == log_id) {
                e.tool_name = Some(name);
                e.tool_use_id = Some(id);
            }
        }
        DriverEvent::ToolResult { text, is_error, tool_use_id } => {
            let kind = if is_error { LogKind::Error } else { LogKind::ToolResult };
            let log_id = st.add_log(kind, text);
            if let Some(e) = st.logs.iter_mut().find(|e| e.id == log_id) {
                e.tool_use_id = Some(tool_use_id);
            }
        }
        DriverEvent::MessageStop => st.close_open_entries(),
        DriverEvent::TurnResult { text, cost_usd, is_error, session_id, errors, .. } => {
            st.close_open_entries();
            if let Some(sid) = session_id {
                st.info.session_id = Some(sid);
            }
            if let Some(cost) = cost_usd {
                st.info.total_cost_usd = Some(cost);
            }
            if is_error {
                let detail = if errors.is_empty() { text.clone() } else { errors.join("; ") };
                st.add_log(LogKind::Error, format!("⚠ {detail}"));
                st.info.status = AgentStatus::Error;
                return;
            }
            match detect_turn_end(&text) {
                TurnEnd::Done { hash } => {
                    if !hash.is_empty() {
                        st.add_log(LogKind::Result, format!("✓ done ({hash})"));
                    } else {
                        st.add_log(LogKind::Result, "✓ done");
                    }
                    st.info.status = AgentStatus::Done;
                    st.info.question = None;
                }
                TurnEnd::NeedsInput => {
                    // The last assistant text is the question.
                    let question = last_assistant_text(&st.logs);
                    st.info.question = question;
                    st.info.status = AgentStatus::NeedsInput;
                }
                TurnEnd::None => {
                    // Turn ended with no sentinel: treat as awaiting the human.
                    st.info.status = AgentStatus::NeedsInput;
                    st.info.question = last_assistant_text(&st.logs);
                }
            }
        }
    }
}

/// The text of the most recent assistant text entry, trimmed to a one-line-ish question.
fn last_assistant_text(logs: &[LogEntry]) -> Option<String> {
    logs.iter()
        .rev()
        .find(|e| e.kind == LogKind::Text && !e.text.trim().is_empty())
        .map(|e| {
            let t = e.text.trim();
            t.lines().last().unwrap_or(t).trim().to_string()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AgentTemplate;

    fn info() -> AgentInfo {
        AgentInfo {
            id: "a1".into(),
            name: "Alpha".into(),
            template: AgentTemplate::Feature,
            parent_id: None,
            project: "Acme".into(),
            ticket: String::new(),
            branch: None,
            worktree: None,
            owns_worktree: None,
            metro_port: None,
            simulator_udid: None,
            status: AgentStatus::Booting,
            question: None,
            session_id: None,
            total_cost_usd: None,
            archived: None,
        }
    }

    #[test]
    fn text_deltas_coalesce_into_one_entry() {
        let state = Arc::new(Mutex::new(SessionState::new(info())));
        apply_event(&state, DriverEvent::TextDelta("Hel".into()));
        apply_event(&state, DriverEvent::TextDelta("lo".into()));
        let st = state.lock().unwrap();
        let texts: Vec<_> = st.logs.iter().filter(|e| e.kind == LogKind::Text).collect();
        assert_eq!(texts.len(), 1);
        assert_eq!(texts[0].text, "Hello");
    }

    #[test]
    fn done_sentinel_sets_done_status() {
        let state = Arc::new(Mutex::new(SessionState::new(info())));
        apply_event(
            &state,
            DriverEvent::TurnResult {
                subtype: "success".into(),
                text: "finished\n@@DONE@@ abc123".into(),
                cost_usd: Some(0.1),
                is_error: false,
                session_id: Some("s1".into()),
                errors: vec![],
            },
        );
        let st = state.lock().unwrap();
        assert_eq!(st.info.status, AgentStatus::Done);
        assert_eq!(st.info.session_id.as_deref(), Some("s1"));
        assert_eq!(st.info.total_cost_usd, Some(0.1));
    }

    #[test]
    fn needs_input_sentinel_sets_question() {
        let state = Arc::new(Mutex::new(SessionState::new(info())));
        apply_event(&state, DriverEvent::TextDelta("Which database should I use?".into()));
        apply_event(&state, DriverEvent::MessageStop);
        apply_event(
            &state,
            DriverEvent::TurnResult {
                subtype: "success".into(),
                text: "Which database should I use?\n@@NEEDS_INPUT@@".into(),
                cost_usd: None,
                is_error: false,
                session_id: None,
                errors: vec![],
            },
        );
        let st = state.lock().unwrap();
        assert_eq!(st.info.status, AgentStatus::NeedsInput);
        assert!(st.info.question.as_deref().unwrap().contains("database"));
    }
}
