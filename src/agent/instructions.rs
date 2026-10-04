//! Per-template instruction / prompt assembly.
//!
//! orc injects an "orchestration context" addendum carrying the agent's identity and the
//! human-in-the-loop sentinel protocol the TUI depends on. The base repo's own `CLAUDE.md`
//! (loaded via `settingSources`) carries the project-specific instructions; this only adds the
//! per-agent identity and protocol on top, passed to `claude` via `--append-system-prompt`.

use crate::agent::prompt::{DONE, NEEDS_INPUT};
use crate::types::{is_read_only_template, AgentTemplate};

/// Identity + context used to build an agent's injected system prompt.
#[derive(Debug, Clone, Default)]
pub struct PromptParams {
    pub name: String,
    pub ticket: String,
    pub metro_port: Option<u16>,
    pub simulator_udid: Option<String>,
    pub magic_link: Option<String>,
    /// When true, the agent has a dedicated tmux shell pane and must run shell commands via the
    /// `mcp__orc__run` tool (the built-in `Bash` tool is disabled) so the human sees them run.
    pub pane_tool: bool,
}

/// A one-line role descriptor for the given template.
pub fn build_instructions(template: AgentTemplate) -> String {
    use AgentTemplate::*;
    let role = match template {
        Feature => "a feature agent building or changing functionality",
        Fix => "a bug-fix agent: reproduce the problem, find the root cause, make the smallest correct fix, prove it with a test",
        Merge => "a merge agent that integrates a feature branch into the base branch from the main repo",
        Worker => "a general-purpose worker agent",
        Launcher => "a launcher agent that spawns and coordinates feature agents (read-only itself)",
        Pipeline => "a pipeline agent that chains role agents through a task (read-only itself)",
        Architect => "an architect agent designing an approach (read-only)",
        Explorer => "an explorer agent investigating how the code works (read-only)",
        Planner => "a planner agent producing an implementation plan (read-only)",
        Implementer => "an implementer agent writing the planned code in its own worktree",
        Tester => "a tester agent writing and running tests in its own worktree",
        Reviewer => "a reviewer agent reviewing a change (read-only)",
        Refactorer => "a refactorer agent improving code structure in its own worktree",
    };
    format!("You are {role}.")
}

fn port_line(metro_port: Option<u16>) -> String {
    match metro_port {
        Some(p) => format!(
            "\n- Your dedicated port is {p} (env: METRO_PORT and AGENT_PORT). Use it for Metro / your dev server / any local service."
        ),
        None => format!(
            "\n- No port was allocated for you. If your task genuinely needs a local port, stop and ask the human to add a `portRange` for this project in the orc config, using the {NEEDS_INPUT} sentinel."
        ),
    }
}

fn simulator_line(name: &str, udid: &Option<String>) -> String {
    match udid {
        Some(udid) => format!(
            "\n- Your dedicated iOS simulator is named \"{name}\" (UDID {udid}); drive it via the Maestro MCP server."
        ),
        None => String::new(),
    }
}

fn ticket_line(ticket: &str) -> String {
    if ticket.trim().is_empty() {
        String::new()
    } else {
        format!("\n- Your ticket reference is \"{ticket}\". Reference it in your commit message(s).")
    }
}

/// The "### Running shell commands" section, present only when the agent has a tmux pane.
fn pane_section(pane_tool: bool) -> String {
    if !pane_tool {
        return String::new();
    }
    "\n\n### Running shell commands\n\n\
Run EVERY shell command with the `mcp__orc__run` tool (its `command` argument is the command line), \
never any other way. Your built-in `Bash` tool is disabled. `mcp__orc__run` runs the command in \
your own dedicated terminal pane so the human watches it run and can rerun it from the shell's \
history; it returns the command's combined output and exit code. One command per call."
        .to_string()
}

fn magic_section(magic_link: &Option<String>) -> String {
    match magic_link {
        Some(_) => "\n\n### Signing in\n\nA magic sign-in link is available in the MAGIC_LINK env var. Use it to authenticate before verifying any signed-in views. See your project's CLAUDE.md for how to open a link on your target.".to_string(),
        None => String::new(),
    }
}

/// The human-in-the-loop protocol for full-access agents (DONE carries a commit hash).
fn feature_human_protocol() -> String {
    format!(
        "### Talking to the human\n\n\
The human supervises you through a terminal UI and can reply to you between turns.\n\n\
- When you genuinely need a human decision (a real product/design choice or missing information you \
cannot resolve yourself), ask your question clearly, then end your message with a final line \
containing exactly:\n\n  {NEEDS_INPUT}\n\n  \
Then stop and wait. The human's reply arrives as your next message and you continue the same session.\n\n\
- When the task is completely finished (per your Completion Criteria), end your final message with a \
line containing exactly:\n\n  {DONE} <commit-hash>\n\n\
Do not emit these sentinels in any other situation. Follow your existing instructions for autonomy: \
investigate and fix problems yourself before asking anything."
    )
}

/// The read-only protocol: identical NEEDS_INPUT contract, but DONE carries no commit hash.
fn read_only_human_protocol() -> String {
    format!(
        "### Talking to the human\n\n\
The human supervises you through a terminal UI and can reply to you between turns.\n\n\
- When you genuinely need a human decision or missing information, ask clearly and end your message \
with a final line containing exactly:\n\n  {NEEDS_INPUT}\n\n  Then stop and wait.\n\n\
- When your task is completely finished, end your final message with a line containing exactly:\n\n  {DONE}\n\n\
You are a READ-ONLY agent: do not modify files, commit, or run mutating commands."
    )
}

/// Build the full "orchestration context" addendum injected as the agent's system prompt.
pub fn build_addendum(template: AgentTemplate, params: &PromptParams) -> String {
    let name = &params.name;
    let desc = build_instructions(template);

    if is_read_only_template(template) {
        return format!(
            "## Orchestration context (injected by orc)\n\n\
You are agent \"{name}\", running under an orchestrator that supervises several agents in parallel. {desc}\n\n\
- Your unique agent name is \"{name}\".{port}{pane}{magic}\n\n{protocol}",
            port = port_line(params.metro_port),
            pane = pane_section(params.pane_tool),
            magic = magic_section(&params.magic_link),
            protocol = read_only_human_protocol(),
        );
    }

    // Full-access (worktree) agents: feature/fix/worker/implementer/tester/refactorer/merge.
    let identity = format!(
        "- Your unique agent name is \"{name}\".{sim}{port}\n\
- You are in your own git worktree. Never touch files, branches, worktrees, or simulators outside it.\n\
- Do NOT merge your branch into the base branch, delete your own branch, or remove your own worktree. \
Merging is the orchestrator's job, run from the main repo — doing it yourself would delete the \
directory you're running in and break your session. Just commit and report {DONE}; the human merges you.{ticket}",
        sim = simulator_line(name, &params.simulator_udid),
        port = port_line(params.metro_port),
        ticket = ticket_line(&params.ticket),
    );

    format!(
        "## Orchestration context (injected by orc)\n\n\
You are agent \"{name}\", running under an orchestrator that supervises several agents in parallel. {desc}\n\n\
{identity}{pane}{magic}\n\n{protocol}",
        pane = pane_section(params.pane_tool),
        magic = magic_section(&params.magic_link),
        protocol = feature_human_protocol(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feature_addendum_has_identity_and_sentinels() {
        let p = PromptParams {
            name: "Alpha".into(),
            ticket: "PROJ-1".into(),
            metro_port: Some(8000),
            ..Default::default()
        };
        let out = build_addendum(AgentTemplate::Feature, &p);
        assert!(out.contains("agent \"Alpha\""));
        assert!(out.contains("8000"));
        assert!(out.contains("PROJ-1"));
        assert!(out.contains(NEEDS_INPUT));
        assert!(out.contains(DONE));
        assert!(out.contains("own git worktree"));
    }

    #[test]
    fn read_only_addendum_forbids_mutation() {
        let p = PromptParams {
            name: "Scout".into(),
            ..Default::default()
        };
        let out = build_addendum(AgentTemplate::Explorer, &p);
        assert!(out.contains("READ-ONLY"));
        assert!(!out.contains("own git worktree"));
    }

    #[test]
    fn no_port_line_when_unallocated() {
        let p = PromptParams {
            name: "A".into(),
            ..Default::default()
        };
        let out = build_addendum(AgentTemplate::Feature, &p);
        assert!(out.contains("No port was allocated"));
    }
}
