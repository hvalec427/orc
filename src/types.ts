/** Shared domain types for orc. */

/**
 * The kind of agent to launch, chosen in the new-agent form:
 * - `feature`  — the default: a task agent in its own git worktree + branch.
 * - `fix`      — a full-access bug-fix agent in its own worktree + branch: given a problem, it
 *                reproduces it, finds the root cause, lands a minimal surgical fix, and proves it.
 * - `merge`    — an agent whose job is to merge branches in the base repo.
 * - `worker`   — a general-purpose "does anything asked" agent. It starts with NO worktree/branch/
 *                port in the base repo (so tasks that change nothing — answering, deleting a branch,
 *                inspecting — need no worktree), and cuts+adopts its own worktree ON DEMAND (via the
 *                `create_worktree` tool) the moment it needs to edit code, then commits like a
 *                feature agent. Neither read-only nor a WORKTREE_TEMPLATE: see the worker handling
 *                in AgentManager/AgentSession.
 * - `launcher` — a read-only planner that takes several tasks at once, decides which belong
 *                together vs. apart, picks the right template for each group (feature/fix/
 *                explorer/pipeline) and spawns one agent per group (nested beneath it).
 * - `pipeline` — a read-only orchestrator that runs the seven role agents below SEQUENTIALLY
 *                on one shared worktree (architect → explorer → planner → tester → implementer
 *                → reviewer → refactorer → tester), handing each role's summary to the next and
 *                able to "go back" to an earlier role when something is missing.
 *
 * The seven ROLE templates are the focused specialists a pipeline chains together. The pipeline
 * spawns them internally; `explorer` is also offered standalone for read-only investigation. They
 * split into read-only investigators and full-access workers; see {@link READ_ONLY_TEMPLATES} and
 * {@link WORKTREE_TEMPLATES}.
 * - `architect`   — owns high-level technical direction/decisions (READ-ONLY).
 * - `explorer`    — investigates the codebase: finds files, traces flows/deps (READ-ONLY).
 * - `planner`     — turns understanding into a concrete implementation plan (READ-ONLY).
 * - `implementer` — executes the plan: writes code, builds, runs checks (FULL ACCESS).
 * - `tester`      — writes/runs unit, integration and Maestro E2E tests (FULL ACCESS).
 * - `reviewer`    — reviews completed changes; does not blindly rewrite (READ-ONLY).
 * - `refactorer`  — cleans up the reviewed implementation, preserving behavior (FULL ACCESS).
 */
export type AgentTemplate =
  | 'feature'
  | 'fix'
  | 'merge'
  | 'worker'
  | 'launcher'
  | 'pipeline'
  | 'architect'
  | 'explorer'
  | 'planner'
  | 'implementer'
  | 'tester'
  | 'reviewer'
  | 'refactorer';

/** The seven role templates a pipeline chains, in the canonical order the pipeline runs them. */
export type RoleTemplate =
  | 'architect'
  | 'explorer'
  | 'planner'
  | 'implementer'
  | 'tester'
  | 'reviewer'
  | 'refactorer';

/**
 * Templates whose agents run read-only: they investigate with read tools but are denied all
 * mutating tools (Edit/Write/Bash/…) by the orchestrator. `launcher`/`pipeline` are read-only too
 * but each additionally get their own spawn/run-step MCP tool allowed through explicitly.
 */
export const READ_ONLY_TEMPLATES: ReadonlySet<AgentTemplate> = new Set<AgentTemplate>([
  'launcher',
  'pipeline',
  'architect',
  'explorer',
  'planner',
  'reviewer',
]);

/**
 * Templates whose agents need their own git worktree + branch + port (full file/Bash access):
 * the original `feature` agent plus the three full-access roles. Centralized here so worktree,
 * port allocation and the "ensure worktree" paths all agree on exactly which templates get one.
 * (Pipeline role agents reuse their pipeline's SHARED worktree rather than cutting a new one —
 * see AgentManager.create's `sharedWorktree` param — so this set drives standalone creation.)
 */
export const WORKTREE_TEMPLATES: ReadonlySet<AgentTemplate> = new Set<AgentTemplate>([
  'feature',
  'fix',
  'implementer',
  'tester',
  'refactorer',
]);

/** Whether a template's agent runs read-only (no mutating tools). */
export function isReadOnlyTemplate(template: AgentTemplate): boolean {
  return READ_ONLY_TEMPLATES.has(template);
}

/** Whether a template's agent needs its own worktree/branch/port when created standalone. */
export function needsWorktree(template: AgentTemplate): boolean {
  return WORKTREE_TEMPLATES.has(template);
}

/**
 * The general-purpose `worker` is its own category: NOT read-only (it may edit/run Bash once it has
 * a worktree) and NOT a {@link WORKTREE_TEMPLATES} member (it does not get a worktree up front).
 * Instead it starts in the base repo and cuts+adopts a worktree ON DEMAND the first time it needs to
 * change code (see the `create_worktree` tool wired in AgentManager/AgentSession). Centralized here
 * so every call site agrees on the one template that behaves this way.
 */
export function isWorkerTemplate(template: AgentTemplate): boolean {
  return template === 'worker';
}

export type AgentStatus =
  | 'booting' // session created, first turn not yet complete
  | 'working' // actively processing a turn
  | 'needs_input' // turn ended asking the human a question
  | 'needs_approval' // a tool is waiting for human approval (canUseTool)
  | 'done' // agent reported the task finished
  | 'error' // the session errored
  | 'stopped'; // interrupted/closed by the human

export type LogKind =
  | 'text'
  | 'thinking'
  | 'tool'
  | 'system'
  | 'result'
  | 'error'
  | 'input'
  // A message from another agent in the same group (a subagent's progress report, or a question
  // it is asking its orchestrator). Rendered distinctly so the human never mistakes it for their
  // own 'input' ("you: …") line.
  | 'subagent';

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
  /** Git branch, or undefined for no-worktree templates (merge/read-only roles). */
  branch?: string;
  /** Worktree path, or undefined for no-worktree templates (merge/read-only roles). */
  worktree?: string;
  /**
   * Whether this agent owns its worktree's lifecycle (recreate on launch, remove on delete). False
   * for a child sharing its group's worktree. Persisted so a restored agent keeps the right rule.
   */
  ownsWorktree?: boolean;
  /** Allocated port, or undefined when the project has no port range. */
  metroPort?: number;
  status: AgentStatus;
  /** The agent's last question (when status === 'needs_input'). */
  question?: string;
  /** SDK session id, captured from the init/result messages. */
  sessionId?: string;
  /** Accumulated USD cost, or undefined until the SDK has reported a cost. */
  totalCostUsd?: number;
  /** When true, the agent is hidden in the sidebar's "Done" section and excluded from integrate. */
  archived?: boolean;
}

/** Project kind — selects which CLAUDE.md template the `p` action installs. */
export type ProjectType = 'react-native' | 'web' | 'orc';

/**
 * How a merge agent integrates a feature branch into the base branch:
 * - `merge`         — a standard merge commit.
 * - `rebase`        — rebase the feature branch onto the target, preserving its individual commits.
 * - `squash-merge`  — collapse the branch to a single commit via `git merge --squash`.
 * - `squash-rebase` — collapse the branch to a single commit via an (auto)squash rebase.
 */
export type MergeStrategy = 'merge' | 'rebase' | 'squash-merge' | 'squash-rebase';

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
  /** How a merge agent integrates this project's branches. Resolved; defaults to `rebase`. */
  mergeStrategy: MergeStrategy;
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
