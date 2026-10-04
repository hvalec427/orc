//! Persisting + restoring agents across orc restarts. (Stub milestone.)

use crate::types::AgentInfo;

/// Save the set of agents to disk. (Stub.)
pub fn save_agents(_agents: &[AgentInfo]) -> anyhow::Result<()> {
    todo!("save_agents")
}

/// Load persisted agents from disk. (Stub.)
pub fn load_agents() -> anyhow::Result<Vec<AgentInfo>> {
    todo!("load_agents")
}
