//! Shared domain types for orc.

use serde::{Deserialize, Serialize};

/// The kind of agent to launch (13 variants).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTemplate {
    Feature,
    Fix,
    Merge,
    Worker,
    Launcher,
    Pipeline,
    Architect,
    Explorer,
    Planner,
    Implementer,
    Tester,
    Reviewer,
    Refactorer,
}

/// The seven role templates a pipeline chains, in canonical order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoleTemplate {
    Architect,
    Explorer,
    Planner,
    Implementer,
    Tester,
    Reviewer,
    Refactorer,
}

/// Lifecycle status of an agent (9 variants). Serializes snake_case to match the TS wire values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Booting,
    Working,
    NeedsInput,
    NeedsApproval,
    NeedsLogin,
    Paused,
    Done,
    Error,
    Stopped,
}

/// Kind of a rendered log entry (9 variants).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogKind {
    Text,
    Thinking,
    Tool,
    ToolResult,
    System,
    Result,
    Error,
    Input,
    Subagent,
}

/// Project kind — selects which CLAUDE.md template is installed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectType {
    ReactNative,
    Web,
    Orc,
}

/// How a merge agent integrates a feature branch. Wire values are kebab-case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MergeStrategy {
    Merge,
    Rebase,
    SquashMerge,
    SquashRebase,
}

/// Permission mode for agent sessions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    BypassPermissions,
    Default,
    AcceptEdits,
}

/// A single setting source for the CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SettingSource {
    User,
    Project,
    Local,
}

/// Inclusive port range agents in a project allocate from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortRange {
    pub start: u16,
    pub end: u16,
}

/// Maestro MCP server config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaestroMcp {
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::HashMap<String, String>>,
}

/// Resolved config for a single project (global defaults overlaid with per-project overrides).
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectConfig {
    pub name: String,
    pub project_type: ProjectType,
    pub repo: String,
    pub model: String,
    pub worktree_dir: String,
    pub permission_mode: PermissionMode,
    pub setting_sources: Vec<SettingSource>,
    pub base_branch: Option<String>,
    pub merge_strategy: MergeStrategy,
    pub port_range: Option<PortRange>,
    pub maestro_mcp: Option<MaestroMcp>,
    pub magic_link: Option<String>,
}

/// Global orc config: the list of projects agents can be launched into.
#[derive(Debug, Clone, PartialEq)]
pub struct OrcConfig {
    pub projects: Vec<ProjectConfig>,
    pub tmux: Option<bool>,
}

/// A single rendered log entry for an agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogEntry {
    pub id: u64,
    pub kind: LogKind,
    pub text: String,
    pub tool_name: Option<String>,
    pub tool_use_id: Option<String>,
    pub done: bool,
}

/// A pending tool approval request awaiting the human's decision.
#[derive(Debug, Clone)]
pub struct PendingApproval {
    pub tool_name: String,
    pub input: serde_json::Value,
    pub reason: Option<String>,
}

/// Runtime info about one agent, shown in the sidebar / persisted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub template: AgentTemplate,
    pub parent_id: Option<String>,
    pub project: String,
    pub ticket: String,
    pub branch: Option<String>,
    pub worktree: Option<String>,
    pub owns_worktree: Option<bool>,
    pub metro_port: Option<u16>,
    pub simulator_udid: Option<String>,
    pub status: AgentStatus,
    pub question: Option<String>,
    pub session_id: Option<String>,
    pub total_cost_usd: Option<f64>,
    pub archived: Option<bool>,
}

/// Whether a template's agent runs read-only (no mutating tools).
pub fn is_read_only_template(template: AgentTemplate) -> bool {
    use AgentTemplate::*;
    matches!(
        template,
        Launcher | Pipeline | Architect | Explorer | Planner | Reviewer
    )
}

/// Whether a template's agent needs its own worktree/branch/port when created standalone.
pub fn needs_worktree(template: AgentTemplate) -> bool {
    use AgentTemplate::*;
    matches!(template, Feature | Fix | Implementer | Tester | Refactorer)
}

/// Whether a template is the special general-purpose `worker` (neither read-only nor worktree).
pub fn is_worker_template(template: AgentTemplate) -> bool {
    matches!(template, AgentTemplate::Worker)
}

/// Whether a status is a terminal / dead state (no live subprocess expected).
pub fn is_dead(status: AgentStatus) -> bool {
    use AgentStatus::*;
    matches!(status, Done | Error | Stopped | NeedsLogin)
}

/// Whether the agent's turn has ended (dead states plus needs_input).
pub fn turn_ended(status: AgentStatus) -> bool {
    is_dead(status) || matches!(status, AgentStatus::NeedsInput)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_TEMPLATES: [AgentTemplate; 13] = [
        AgentTemplate::Feature,
        AgentTemplate::Fix,
        AgentTemplate::Merge,
        AgentTemplate::Worker,
        AgentTemplate::Launcher,
        AgentTemplate::Pipeline,
        AgentTemplate::Architect,
        AgentTemplate::Explorer,
        AgentTemplate::Planner,
        AgentTemplate::Implementer,
        AgentTemplate::Tester,
        AgentTemplate::Reviewer,
        AgentTemplate::Refactorer,
    ];

    const ALL_STATUSES: [AgentStatus; 9] = [
        AgentStatus::Booting,
        AgentStatus::Working,
        AgentStatus::NeedsInput,
        AgentStatus::NeedsApproval,
        AgentStatus::NeedsLogin,
        AgentStatus::Paused,
        AgentStatus::Done,
        AgentStatus::Error,
        AgentStatus::Stopped,
    ];

    #[test]
    fn needs_worktree_exact_set() {
        use AgentTemplate::*;
        let expected = [Feature, Fix, Implementer, Tester, Refactorer];
        for t in ALL_TEMPLATES {
            let want = expected.contains(&t);
            assert_eq!(needs_worktree(t), want, "needs_worktree({t:?})");
        }
    }

    #[test]
    fn is_read_only_exact_set() {
        use AgentTemplate::*;
        let expected = [Launcher, Pipeline, Architect, Explorer, Planner, Reviewer];
        for t in ALL_TEMPLATES {
            let want = expected.contains(&t);
            assert_eq!(
                is_read_only_template(t),
                want,
                "is_read_only_template({t:?})"
            );
        }
    }

    #[test]
    fn no_template_is_both_read_only_and_worktree() {
        for t in ALL_TEMPLATES {
            assert!(
                !(is_read_only_template(t) && needs_worktree(t)),
                "{t:?} is both read-only and worktree"
            );
        }
    }

    #[test]
    fn worker_template_classification() {
        assert!(is_worker_template(AgentTemplate::Worker));
        assert!(!is_read_only_template(AgentTemplate::Worker));
        assert!(!needs_worktree(AgentTemplate::Worker));
    }

    #[test]
    fn is_dead_exact_set() {
        use AgentStatus::*;
        let expected = [Done, Error, Stopped, NeedsLogin];
        for s in ALL_STATUSES {
            let want = expected.contains(&s);
            assert_eq!(is_dead(s), want, "is_dead({s:?})");
        }
    }

    #[test]
    fn turn_ended_is_dead_plus_needs_input() {
        use AgentStatus::*;
        let expected = [Done, Error, Stopped, NeedsLogin, NeedsInput];
        for s in ALL_STATUSES {
            let want = expected.contains(&s);
            assert_eq!(turn_ended(s), want, "turn_ended({s:?})");
        }
        // Explicit false checks for the live, mid-turn states.
        assert!(!turn_ended(Booting));
        assert!(!turn_ended(Working));
        assert!(!turn_ended(NeedsApproval));
        assert!(!turn_ended(Paused));
    }

    #[test]
    fn merge_strategy_serde_kebab() {
        let json = serde_json::to_string(&MergeStrategy::SquashMerge).unwrap();
        assert_eq!(json, "\"squash-merge\"");
        let back: MergeStrategy = serde_json::from_str("\"squash-merge\"").unwrap();
        assert_eq!(back, MergeStrategy::SquashMerge);
    }

    #[test]
    fn agent_status_serde_snake() {
        let json = serde_json::to_string(&AgentStatus::NeedsInput).unwrap();
        assert_eq!(json, "\"needs_input\"");
        let back: AgentStatus = serde_json::from_str("\"needs_input\"").unwrap();
        assert_eq!(back, AgentStatus::NeedsInput);
    }

    #[test]
    fn project_type_serde_kebab() {
        let json = serde_json::to_string(&ProjectType::ReactNative).unwrap();
        assert_eq!(json, "\"react-native\"");
        let back: ProjectType = serde_json::from_str("\"react-native\"").unwrap();
        assert_eq!(back, ProjectType::ReactNative);
    }
}
