/** Shared domain types for orc. */

export type AgentStatus =
  | 'booting' // session created, first turn not yet complete
  | 'working' // actively processing a turn
  | 'needs_input' // turn ended asking the human a question
  | 'needs_approval' // a tool is waiting for human approval (canUseTool)
  | 'done' // agent reported the task finished
  | 'error' // the session errored
  | 'stopped'; // interrupted/closed by the human

export type LogKind = 'text' | 'thinking' | 'tool' | 'system' | 'result' | 'error' | 'input';

export interface LogEntry {
  id: number;
  kind: LogKind;
  /** Rendered text. For tool entries this is a one-line summary. */
  text: string;
  /** Tool name, for kind === 'tool'. */
  toolName?: string;
  /** Whether the streaming block has finished. */
  done: boolean;
}

export interface PendingApproval {
  toolName: string;
  input: Record<string, unknown>;
  reason?: string;
  /** Resolve with the human's decision. */
  resolve: (approved: boolean) => void;
}

export interface AgentInfo {
  id: string;
  name: string;
  /** Nice name of the project this agent belongs to. */
  project: string;
  ticket: string;
  branch: string;
  worktree: string;
  metroPort: number;
  status: AgentStatus;
  /** The agent's last question (when status === 'needs_input'). */
  question?: string;
  /** SDK session id, captured from the init/result messages. */
  sessionId?: string;
  totalCostUsd: number;
}

/** Project kind — selects which CLAUDE.md template the `p` action installs. */
export type ProjectType = 'react-native' | 'web' | 'orc';

/** Resolved config for a single project (global defaults overlaid with per-project overrides). */
export interface ProjectConfig {
  /** Nice, human-facing project name (also selected in the new-agent form). */
  name: string;
  /** Project kind; only used to choose the CLAUDE.md template. */
  type: ProjectType;
  /** Absolute path to the base git repository worktrees are cut from. */
  repo: string;
  /** Model id passed to every agent session for this project. */
  model: string;
  /** Directory (relative to repo) where worktrees are created. */
  worktreeDir: string;
  /** Permission mode for agent sessions. */
  permissionMode: 'bypassPermissions' | 'default' | 'acceptEdits';
  /** settingSources so the worktree CLAUDE.md is loaded. */
  settingSources: Array<'user' | 'project' | 'local'>;
  /** Maestro MCP server command, attached to every agent. Omit to disable. */
  maestroMcp?: { command: string; args?: string[]; env?: Record<string, string> };
  /** Magic sign-in link the agent opens on the simulator to log in. Omit to disable. */
  magicLink?: string;
}

/** Global orc config: a list of projects plus the machine-wide Metro port base. */
export interface OrcConfig {
  /** First METRO_PORT to hand out; allocation scans upward from here (machine-wide). */
  basePort: number;
  /** The projects agents can be launched into. */
  projects: ProjectConfig[];
}
