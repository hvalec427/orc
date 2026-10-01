/** Shared domain types for orc. */

/**
 * The kind of agent to launch, chosen in the new-agent form:
 * - `feature`  — the default: a task agent in its own git worktree + branch.
 * - `question` — a read-only agent that answers a question and cannot edit anything;
 *                it runs in the base repo (no worktree) and is denied all mutating tools.
 * - `merge`    — an agent whose job is to merge branches in the base repo.
 * - `launcher` — a read-only planner that takes several tasks at once, decides which belong
 *                together vs. apart, and spawns a feature agent per group (nested beneath it).
 *
 * The seven ROLE templates below are focused, single-responsibility agents. Each is
 * independently selectable and runnable from the new-agent form (exactly like `feature`),
 * and each gets its own git worktree + branch + port so it can investigate and commit on
 * its own. They can also be chained together automatically by the `pipeline` orchestrator.
 * - `architect`   — designs the high-level approach/architecture before any code is written.
 * - `explorer`    — maps the codebase: where things live, relevant patterns, constraints.
 * - `planner`     — turns a goal into a concrete, ordered implementation plan.
 * - `implementer` — writes the code to satisfy a plan/spec.
 * - `tester`      — writes and/or runs tests and reports results.
 * - `reviewer`    — reviews a diff/branch for correctness, style, and risks (read-only).
 * - `refactorer`  — improves existing code structure without changing behavior.
 *
 * - `pipeline` — an orchestrator that runs the roles in a row on ONE shared worktree:
 *                architect → explorer → planner → tester(write) → implementer → reviewer →
 *                refactorer → tester(full suite), supporting go-back to an earlier phase when
 *                a later phase fails. It is the "all in a row" flow; `feature` is unchanged.
 */
export type AgentTemplate =
  | 'feature'
  | 'question'
  | 'merge'
  | 'launcher'
  | 'architect'
  | 'explorer'
  | 'planner'
  | 'implementer'
  | 'tester'
  | 'reviewer'
  | 'refactorer'
  | 'pipeline';

/** The seven standalone role templates, in their natural pipeline order. */
export const ROLE_TEMPLATES = [
  'architect',
  'explorer',
  'planner',
  'implementer',
  'tester',
  'reviewer',
  'refactorer',
] as const satisfies readonly AgentTemplate[];

export type RoleTemplate = (typeof ROLE_TEMPLATES)[number];

/** Is this template one of the seven focused role agents? */
export function isRoleTemplate(t: AgentTemplate): t is RoleTemplate {
  return (ROLE_TEMPLATES as readonly AgentTemplate[]).includes(t);
}

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
  /** Which template this agent was launched from. */
  template: AgentTemplate;
  /** Parent agent id, for a nested child (e.g. a merge agent spawned from a feature agent). */
  parentId?: string;
  /** Nice name of the project this agent belongs to. */
  project: string;
  ticket: string;
  /** Git branch, or undefined for no-worktree templates (question/merge/launcher/pipeline). */
  branch?: string;
  /** Worktree path, or undefined for no-worktree templates (question/merge/launcher/pipeline). */
  worktree?: string;
  /** Allocated port, or undefined when the project has no port range. */
  metroPort?: number;
  status: AgentStatus;
  /** The agent's last question (when status === 'needs_input'). */
  question?: string;
  /** SDK session id, captured from the init/result messages. */
  sessionId?: string;
  totalCostUsd: number;
}

/** Project kind — selects which CLAUDE.md template the `p` action installs. */
export type ProjectType = 'react-native' | 'web' | 'orc';

/** Inclusive port range agents in a project allocate from. */
export interface PortRange {
  start: number;
  end: number;
}

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
  /**
   * Branch merge agents integrate into (e.g. `master`, `main`, `develop`). Omit to let the merge
   * agent detect it (preferring `develop`/`development`, then `master`/`main`) and confirm with the
   * human before merging.
   */
  baseBranch?: string;
  /** Port range agents allocate from. Omit to give agents no port. */
  portRange?: PortRange;
  /** Maestro MCP server command, attached to every agent. Omit to disable. */
  maestroMcp?: { command: string; args?: string[]; env?: Record<string, string> };
  /** Magic sign-in link the agent opens on the simulator to log in. Omit to disable. */
  magicLink?: string;
}

/** Global orc config: the list of projects agents can be launched into. */
export interface OrcConfig {
  /** The projects agents can be launched into. */
  projects: ProjectConfig[];
}
