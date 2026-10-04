//! Custom MCP tools exposed to agents (orchestrator + launcher tools). (Stub milestone.)

/// Marker for the as-yet-unimplemented tool registry.
pub struct ToolRegistry;

impl ToolRegistry {
    /// Create an empty registry (stub).
    pub fn new() -> Self {
        todo!("ToolRegistry::new")
    }
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}
