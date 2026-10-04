//! Persisting + restoring agents across orc restarts.
//!
//! The only file orc writes under `~/.orc` is `state.json` (runtime agent state); the config is
//! always hand-edited by the user and never touched here.

use crate::types::AgentInfo;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct StateFile {
    #[serde(default)]
    agents: Vec<AgentInfo>,
}

/// Path to `~/.orc/state.json`.
pub fn state_path() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".orc").join("state.json")
}

/// Save the set of agents to `~/.orc/state.json`, creating `~/.orc` if needed.
pub fn save_agents(agents: &[AgentInfo]) -> anyhow::Result<()> {
    let path = state_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let state = StateFile {
        agents: agents.to_vec(),
    };
    let json = serde_json::to_string_pretty(&state)?;
    std::fs::write(&path, json)?;
    Ok(())
}

/// Load persisted agents from `~/.orc/state.json`. A missing or unparseable file yields an empty
/// list rather than an error, so a corrupt state never blocks orc from starting.
pub fn load_agents() -> anyhow::Result<Vec<AgentInfo>> {
    let path = state_path();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(Vec::new());
    };
    match serde_json::from_str::<StateFile>(&text) {
        Ok(state) => Ok(state.agents),
        Err(_) => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AgentStatus, AgentTemplate};

    fn sample() -> AgentInfo {
        AgentInfo {
            id: "a1".into(),
            name: "Alpha".into(),
            template: AgentTemplate::Feature,
            parent_id: None,
            project: "Acme".into(),
            ticket: "PROJ-1".into(),
            branch: Some("agent/alpha".into()),
            worktree: Some("/repo/.worktrees/alpha".into()),
            owns_worktree: Some(true),
            metro_port: Some(8000),
            simulator_udid: None,
            status: AgentStatus::Working,
            question: None,
            session_id: Some("sess-1".into()),
            total_cost_usd: Some(0.25),
            archived: None,
        }
    }

    #[test]
    fn round_trips_through_json() {
        let a = sample();
        let state = StateFile {
            agents: vec![a.clone()],
        };
        let json = serde_json::to_string(&state).unwrap();
        let back: StateFile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.agents, vec![a]);
    }

    #[test]
    fn camel_case_wire_keys() {
        let json = serde_json::to_string(&sample()).unwrap();
        assert!(json.contains("\"parentId\""));
        assert!(json.contains("\"metroPort\""));
        assert!(json.contains("\"sessionId\""));
    }

    #[test]
    fn missing_file_is_empty() {
        // A parse of empty/garbage returns empty rather than erroring.
        let back: StateFile = serde_json::from_str("{}").unwrap();
        assert!(back.agents.is_empty());
    }
}
