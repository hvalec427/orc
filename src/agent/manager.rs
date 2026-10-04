//! Agent manager: creates/tracks/destroys agent sessions and their worktrees/ports.
//!
//! Owns the resolved [`OrcConfig`], a [`ClaudeDriver`], a per-project [`PortAllocator`], and the
//! live [`AgentSession`]s. The UI calls into the manager to create, answer, resume, stop, and
//! remove agents; the manager keeps `~/.orc/state.json` in sync.

use crate::agent::cli_driver::CliDriver;
use crate::agent::driver::{ClaudeDriver, SessionOpts};
use crate::agent::instructions::{build_addendum, PromptParams};
use crate::agent::session::AgentSession;
use crate::ports::PortAllocator;
use crate::types::{
    needs_worktree, AgentInfo, AgentStatus, AgentTemplate, OrcConfig, ProjectConfig, ProjectType,
};
use crate::worktree::{
    assert_git_repo, branch_for, git_worktree_add_argv, git_worktree_remove_argv, slugify,
    worktree_path,
};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::runtime::Handle;

/// Inputs for creating one agent (from the new-agent form).
#[derive(Debug, Clone)]
pub struct CreateAgentParams {
    pub project: String,
    pub name: String,
    pub ticket: String,
    pub prompt: String,
    pub template: AgentTemplate,
}

/// Owns the set of live agents and their resources.
pub struct AgentManager {
    config: OrcConfig,
    rt: Handle,
    driver: Arc<dyn ClaudeDriver>,
    sessions: Vec<AgentSession>,
    allocators: HashMap<String, PortAllocator>,
    tmux: Option<crate::tmux::controller::TmuxController>,
}

impl AgentManager {
    /// Create a manager over `config`, using the real `claude` CLI driver.
    pub fn new(config: OrcConfig, rt: Handle) -> Self {
        Self::with_driver(config, rt, Arc::new(CliDriver::default()))
    }

    /// Create a manager with an explicit driver (used by tests with a mock driver).
    pub fn with_driver(config: OrcConfig, rt: Handle, driver: Arc<dyn ClaudeDriver>) -> Self {
        let mut allocators = HashMap::new();
        for p in &config.projects {
            if let Some(range) = p.port_range {
                allocators.insert(p.name.clone(), PortAllocator::new(range));
            }
        }
        Self {
            config,
            rt,
            driver,
            sessions: Vec::new(),
            allocators,
            tmux: None,
        }
    }

    /// Attach a tmux controller (per-agent shell panes). `None` leaves orc in plain-TUI mode.
    pub fn set_tmux(&mut self, tmux: Option<crate::tmux::controller::TmuxController>) {
        self.tmux = tmux;
    }

    pub fn config(&self) -> &OrcConfig {
        &self.config
    }

    pub fn projects(&self) -> &[ProjectConfig] {
        &self.config.projects
    }

    /// Number of agents currently tracked.
    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    /// A snapshot of every agent's info, in sidebar order.
    pub fn infos(&self) -> Vec<AgentInfo> {
        self.sessions.iter().map(|s| s.info()).collect()
    }

    /// Access the session at `idx` (for reading its logs / status in the UI).
    pub fn session(&self, idx: usize) -> Option<&AgentSession> {
        self.sessions.get(idx)
    }

    fn project(&self, name: &str) -> Option<&ProjectConfig> {
        self.config.projects.iter().find(|p| p.name == name)
    }

    /// Create a new agent: cut its worktree/branch, allocate a port, spawn its session.
    pub fn create_agent(&mut self, params: CreateAgentParams) -> anyhow::Result<usize> {
        let project = self
            .project(&params.project)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("unknown project: {}", params.project))?;

        assert_git_repo(&project.repo)?;

        let slug = slugify(&params.name);
        let wants_worktree = needs_worktree(params.template);

        // Allocate a port if the project has a range and the template uses a worktree.
        let metro_port = if wants_worktree {
            self.allocators
                .get_mut(&project.name)
                .and_then(|a| a.allocate().ok())
        } else {
            None
        };

        let (branch, worktree, owns_worktree) = if wants_worktree {
            let branch = branch_for(&slug);
            let path = worktree_path(&project.repo, &project.worktree_dir, &slug);
            let owns = create_worktree(&project.repo, &path, &branch)?;
            (Some(branch), Some(path), Some(owns))
        } else {
            (None, None, None)
        };

        let id = uuid::Uuid::new_v4().to_string();
        let info = AgentInfo {
            id,
            name: params.name.clone(),
            template: params.template,
            parent_id: None,
            project: project.name.clone(),
            ticket: params.ticket.clone(),
            branch,
            worktree: worktree.clone(),
            owns_worktree,
            metro_port,
            simulator_udid: None,
            status: AgentStatus::Booting,
            question: None,
            session_id: None,
            total_cost_usd: None,
            archived: None,
        };

        let opts = self.session_opts(&project, &info, worktree.as_deref());
        let agent_id = info.id.clone();
        let tmux_cwd = worktree.clone().unwrap_or_else(|| project.repo.clone());

        let mut session = AgentSession::new(info, self.driver.clone(), self.rt.clone(), opts);
        session.start(params.prompt);
        self.sessions.push(session);
        let idx = self.sessions.len() - 1;

        if let Some(t) = &mut self.tmux {
            t.register_agent(&agent_id, &tmux_cwd);
            t.show_agent(Some(&agent_id));
        }
        self.persist();
        Ok(idx)
    }

    /// Reveal the agent at `idx` in its tmux pane (no-op when tmux is off).
    pub fn show_selected(&mut self, idx: usize) {
        let id = self.sessions.get(idx).map(|s| s.info().id);
        if let (Some(t), Some(id)) = (&mut self.tmux, id) {
            t.show_agent(Some(&id));
        }
    }

    /// Build the `claude` session options (prompt, cwd, env, mcp) for an agent.
    fn session_opts(
        &self,
        project: &ProjectConfig,
        info: &AgentInfo,
        cwd: Option<&str>,
    ) -> SessionOpts {
        let addendum = build_addendum(
            info.template,
            &PromptParams {
                name: info.name.clone(),
                ticket: info.ticket.clone(),
                metro_port: info.metro_port,
                simulator_udid: info.simulator_udid.clone(),
                magic_link: project.magic_link.clone(),
            },
        );

        let mut env = vec![("AGENT_NAME".to_string(), info.name.clone())];
        if let Some(port) = info.metro_port {
            env.push(("AGENT_PORT".to_string(), port.to_string()));
            env.push(("METRO_PORT".to_string(), port.to_string()));
        }
        if let Some(link) = &project.magic_link {
            env.push(("MAGIC_LINK".to_string(), link.clone()));
        }

        let mcp_config = if project.project_type == ProjectType::ReactNative {
            project.maestro_mcp.as_ref().map(|m| {
                serde_json::json!({
                    "mcpServers": { "maestro": m }
                })
                .to_string()
            })
        } else {
            None
        };

        SessionOpts {
            model: project.model.clone(),
            cwd: cwd.map(str::to_string),
            resume_session_id: None,
            system_prompt: Some(addendum),
            permission_mode: Some(
                serde_json::to_value(project.permission_mode)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_else(|| "default".to_string()),
            ),
            env,
            mcp_config,
        }
    }

    /// Answer / steer the agent at `idx`.
    pub fn answer(&mut self, idx: usize, text: String) {
        if let Some(s) = self.sessions.get_mut(idx) {
            s.send(text);
            self.persist();
        }
    }

    /// Resume a finished/crashed agent at `idx`.
    pub fn resume(&mut self, idx: usize) {
        if let Some(s) = self.sessions.get_mut(idx) {
            s.resume();
            self.persist();
        }
    }

    /// Stop (interrupt) the agent at `idx`.
    pub fn stop(&mut self, idx: usize) {
        if let Some(s) = self.sessions.get_mut(idx) {
            s.stop();
            self.persist();
        }
    }

    /// Remove the agent at `idx`: stop it, release its port, and remove its worktree if it owns one.
    pub fn remove(&mut self, idx: usize) {
        if idx >= self.sessions.len() {
            return;
        }
        let mut session = self.sessions.remove(idx);
        session.stop();
        let info = session.info();

        if let Some(t) = &mut self.tmux {
            t.unregister_agent(&info.id);
        }
        if let Some(port) = info.metro_port {
            if let Some(a) = self.allocators.get_mut(&info.project) {
                a.release(port);
            }
        }
        if info.owns_worktree == Some(true) {
            if let (Some(repo), Some(path)) =
                (self.project(&info.project).map(|p| p.repo.clone()), info.worktree.as_ref())
            {
                let _ = std::process::Command::new("git")
                    .args(git_worktree_remove_argv(&repo, path))
                    .output();
            }
        }
        self.persist();
    }

    /// Stop every agent (called on quit).
    pub fn stop_all(&mut self) {
        for s in &mut self.sessions {
            s.stop();
        }
        if let Some(t) = &mut self.tmux {
            t.shutdown();
        }
        self.persist();
    }

    /// Restore agents persisted by a previous run as stopped, resumable sessions.
    pub fn restore(&mut self) {
        let Ok(infos) = crate::persist::load_agents() else {
            return;
        };
        for mut info in infos {
            // reserve its port so a new agent won't collide
            if let Some(port) = info.metro_port {
                if let Some(a) = self.allocators.get_mut(&info.project) {
                    a.reserve(port);
                }
            }
            info.status = AgentStatus::Stopped;
            info.question = None;
            let project = self.project(&info.project).cloned();
            let opts = match &project {
                Some(p) => self.session_opts(p, &info, info.worktree.as_deref()),
                None => SessionOpts::default(),
            };
            let agent_id = info.id.clone();
            let tmux_cwd = info
                .worktree
                .clone()
                .or_else(|| project.as_ref().map(|p| p.repo.clone()));
            let session = AgentSession::new(info, self.driver.clone(), self.rt.clone(), opts);
            self.sessions.push(session);
            if let (Some(t), Some(cwd)) = (&mut self.tmux, tmux_cwd) {
                t.register_agent(&agent_id, &cwd);
            }
        }
    }

    fn persist(&self) {
        let _ = crate::persist::save_agents(&self.infos());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::driver::{ClaudeDriver, DriverEvent, DriverHandle, SessionOpts};
    use crate::types::{MergeStrategy, PermissionMode, PortRange, ProjectType};
    use std::time::{Duration, Instant};
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    /// A driver that scripts a fixed event sequence and then closes the stream.
    struct MockDriver {
        script: Vec<DriverEvent>,
    }

    #[async_trait::async_trait]
    impl ClaudeDriver for MockDriver {
        async fn start(&self, _opts: SessionOpts) -> anyhow::Result<DriverHandle> {
            let (event_tx, event_rx) = mpsc::channel(64);
            let (input_tx, mut input_rx) = mpsc::channel::<String>(16);
            let cancel = CancellationToken::new();
            let script = self.script.clone();
            tokio::spawn(async move {
                for evt in script {
                    if event_tx.send(evt).await.is_err() {
                        return;
                    }
                }
                // keep draining input so sends don't fail before we close
                while input_rx.recv().await.is_some() {}
            });
            Ok(DriverHandle {
                events: event_rx,
                stdin: input_tx,
                cancel,
            })
        }
    }

    fn git(repo: &std::path::Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .current_dir(repo)
            .args(args)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?} failed");
    }

    fn temp_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q", "-b", "main"]);
        std::fs::write(p.join("README.md"), "x").unwrap();
        git(p, &["add", "."]);
        git(
            p,
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-qm",
                "init",
            ],
        );
        dir
    }

    fn project(repo: &std::path::Path) -> ProjectConfig {
        ProjectConfig {
            name: "Test".into(),
            project_type: ProjectType::Web,
            repo: repo.to_string_lossy().into_owned(),
            model: "claude-sonnet-5".into(),
            worktree_dir: ".worktrees".into(),
            permission_mode: PermissionMode::BypassPermissions,
            setting_sources: vec![],
            base_branch: None,
            merge_strategy: MergeStrategy::Rebase,
            port_range: Some(PortRange { start: 59000, end: 59010 }),
            maestro_mcp: None,
            magic_link: None,
        }
    }

    #[test]
    fn create_agent_streams_to_done() {
        let repo = temp_repo();
        let cfg = OrcConfig {
            projects: vec![project(repo.path())],
            tmux: Some(false),
        };
        let rt = tokio::runtime::Runtime::new().unwrap();
        let driver = Arc::new(MockDriver {
            script: vec![
                DriverEvent::SessionId("s1".into()),
                DriverEvent::TextDelta("doing the work".into()),
                DriverEvent::MessageStop,
                DriverEvent::TurnResult {
                    subtype: "success".into(),
                    text: "all set\n@@DONE@@ deadbee".into(),
                    cost_usd: Some(0.42),
                    is_error: false,
                    session_id: Some("s1".into()),
                    errors: vec![],
                },
            ],
        });
        let mut mgr = AgentManager::with_driver(cfg, rt.handle().clone(), driver);

        let idx = mgr
            .create_agent(CreateAgentParams {
                project: "Test".into(),
                name: "Alpha".into(),
                ticket: "T-1".into(),
                prompt: "build it".into(),
                template: AgentTemplate::Feature,
            })
            .expect("create_agent");

        // The worktree was cut.
        assert!(repo.path().join(".worktrees/alpha").exists());
        let info = mgr.session(idx).unwrap().info();
        assert_eq!(info.metro_port, Some(59000));
        assert_eq!(info.branch.as_deref(), Some("agent/alpha"));

        // Wait for the scripted stream to drive the session to `done`.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let st = mgr.session(idx).unwrap().status();
            if st == AgentStatus::Done {
                break;
            }
            assert!(Instant::now() < deadline, "status stuck at {st:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
        let snap = mgr.session(idx).unwrap().snapshot();
        assert_eq!(snap.info.total_cost_usd, Some(0.42));
        assert_eq!(snap.info.session_id.as_deref(), Some("s1"));
        assert!(snap.logs.iter().any(|l| l.text.contains("doing the work")));

        mgr.remove(idx);
        assert!(!repo.path().join(".worktrees/alpha").exists());
    }
}

/// Create the worktree + branch for an agent. Returns whether orc created it (owns it).
/// If the worktree path already exists, adopts it (owns = false) rather than failing.
fn create_worktree(repo: &str, path: &str, branch: &str) -> anyhow::Result<bool> {
    if std::path::Path::new(path).exists() {
        return Ok(false);
    }
    let output = std::process::Command::new("git")
        .args(git_worktree_add_argv(repo, path, branch))
        .output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git worktree add failed: {}", stderr.trim());
    }
    Ok(true)
}
