import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import {
  query,
  type Query,
  type Options,
  type SDKMessage,
  type PreToolUseHookInput,
  type HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentInfo, AgentStatus, AgentTemplate, LogEntry, ProjectConfig, PendingApproval } from '../types.js';
import { isReadOnlyTemplate } from '../types.js';
import { isReadOnlyBashCommand } from './readOnlyCommands.js';
import { InputQueue } from './InputQueue.js';
import {
  buildAppendPrompt,
  LAUNCH_TOOL,
  RUN_STEP_TOOL,
  ORCHESTRATION_TOOLS,
  NEEDS_INPUT,
  DONE,
} from '../agentPrompt.js';
import {
  buildLauncherTools,
  buildPipelineTools,
  buildWorkerTools,
  type LaunchFeature,
  type RunPipelineStep,
  type EnsureWorktree,
} from './launcherTools.js';
import {
  buildOrchestratorTools,
  buildSubagentTools,
  buildSpawnSubagentTool,
  buildRunTool,
  buildOrcServer,
  type AskOrchestrator,
  type AskSubagent,
  type AnswerSubagent,
  type ListSubagents,
  type ReportToOrchestrator,
  type SpawnSubagent,
} from './orchestratorTools.js';
import { createWorktree, type Worktree } from '../worktree.js';

const MAX_EVENTS = 800;

/**
 * The SDK aborts the whole session (not just the turn) when a `Read` returns more than
 * ~25 000 tokens: its file reader throws a `MaxFileReadTokenExceededError` that escapes the
 * turn loop and kills the streaming query. It estimates tokens as `chars / 4`, so the fatal
 * threshold is ~100 000 characters. We guard reads *before* they hit that path (see
 * `guardLargeRead`) and deny unbounded ones a bit below the limit, turning a session-killing
 * crash into ordinary tool feedback the agent can recover from.
 */
const READ_TOKEN_LIMIT = 25_000;
const CHARS_PER_TOKEN = 4;
/** Deny unbounded reads at 90% of the limit to leave headroom over the chars/4 estimate. */
const MAX_UNBOUNDED_READ_BYTES = Math.floor(READ_TOKEN_LIMIT * CHARS_PER_TOKEN * 0.9);

/**
 * Collapse arbitrary (possibly multi-line) text into a single, length-capped line.
 * Diagnostic strings from the SDK — a subprocess crash, a stderr chunk — can be full
 * multi-line stack traces. Logged verbatim they inject vertical whitespace into the TUI,
 * which pushes total output past the terminal height and corrupts Ink's redraw. Error and
 * stderr entries are short one-liners anyway, so we flatten and cap them here.
 */
function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/**
 * Patterns that mark an SDK/CLI failure as "the Claude Code login is gone" rather than an
 * ordinary task error. When the underlying `claude` CLI has no valid credentials (the OAuth
 * token expired, the user logged out, or the API key was revoked) the subprocess fails before
 * the agent can do any work, surfacing as an authentication error in the result's `errors`
 * (or as a thrown error in the run loop). These need a different remedy from a normal error —
 * the human must re-authenticate the CLI and only then is a retry meaningful — so we detect
 * them and flip to the dedicated 'needs_login' status instead of the generic 'error'.
 */
const LOGIN_REQUIRED_PATTERNS: readonly RegExp[] = [
  /\bunauthorized\b/i,
  /\b401\b/,
  /authentication[_\s-]?error/i,
  /invalid\s+api\s+key/i,
  /\bnot\s+logged\s+in\b/i,
  /\b(?:please\s+)?log\s*in\b/i,
  /\blogin\s+required\b/i,
  /\bsession\s+expired\b/i,
  /\b(?:oauth\s+)?token\s+(?:expired|revoked|invalid)\b/i,
  /credentials?\s+(?:expired|invalid|missing|not\s+found)/i,
  /run\s+`?claude\s+login`?/i,
];

/** Whether a diagnostic string indicates the Claude CLI needs the human to re-authenticate. */
function isLoginRequired(detail: string): boolean {
  return LOGIN_REQUIRED_PATTERNS.some((re) => re.test(detail));
}

/** Loose shape of the raw Anthropic stream events we care about. */
type StreamEvent =
  | {
      type: 'content_block_start';
      index: number;
      content_block: { type: string; name?: string; input?: unknown };
    }
  | {
      type: 'content_block_delta';
      index: number;
      delta: { type: string; text?: string; partial_json?: string; thinking?: string };
    }
  | { type: 'content_block_stop'; index: number }
  | { type: string };

export interface AgentSessionInit {
  id: string;
  name: string;
  /** Which template the agent was launched from (selects prompt shape + tool policy). */
  template: AgentTemplate;
  /** Parent agent id, for a nested child session (e.g. a merge agent under its feature agent). */
  parentId?: string;
  /** Short ticket reference (for commit messages / display). May be empty. */
  ticket: string;
  /** The actual task instructions — the agent's first message. */
  prompt: string;
  /** Optional magic sign-in link (already resolved: per-agent override or project default). */
  magicLink?: string;
  /** Git branch, or undefined for no-worktree templates (merge/read-only). */
  branch?: string;
  /** Worktree path, or undefined for no-worktree templates (they run in the base repo). */
  worktree?: string;
  /**
   * Whether this agent OWNS its worktree (and is therefore responsible for recreating/removing it).
   * False for a pipeline role child that merely shares its pipeline's worktree — it must never
   * recreate or delete it. Defaults to true when a worktree is present.
   */
  ownsWorktree?: boolean;
  /** Allocated port, or undefined when the project has no port range. */
  metroPort?: number;
  /** UDID of the dedicated iOS Simulator orc provisioned for this agent, or undefined when none. */
  simulatorUdid?: string;
  config: ProjectConfig;
  /**
   * For `launcher` agents only: the callback the launch tool uses to spawn a feature agent.
   * The manager supplies this so the tool can create feature agents nested under the launcher.
   */
  launchFeature?: LaunchFeature;
  /**
   * For `pipeline` agents only: the callback the run-step tool uses to spawn ONE role agent on the
   * pipeline's shared worktree. The manager supplies this so the tool can create role agents nested
   * under the pipeline.
   */
  runStep?: RunPipelineStep;
  /**
   * For `worker` agents only: the callback the `create_worktree` tool uses to cut+adopt an isolated
   * worktree on demand. The manager supplies it (it cuts the worktree, allocates a port and calls
   * {@link AgentSession.adoptWorktree}); the session relaunches into the new worktree so subsequent
   * edits land there instead of the base repo.
   */
  cutWorktreeOnDemand?: EnsureWorktree;
  /**
   * The group orchestration callbacks (supplied by the manager, scoped to this agent's id) that back
   * the in-process `mcp__orc__*` coordination tools: spawn a subagent into this agent's group; as a
   * parent, list/ask/answer this agent's subagents; as a child, ask this agent's orchestrator. Every
   * agent gets these — they're inert for an agent with no subagents and no parent.
   */
  orchestration?: {
    listSubagents: ListSubagents;
    askSubagent: AskSubagent;
    answerSubagent: AnswerSubagent;
    askOrchestrator: AskOrchestrator;
    reportToOrchestrator: ReportToOrchestrator;
    spawnSubagent: SpawnSubagent;
    /**
     * Run a shell command on this agent's behalf, backing the `mcp__orc__run` tool. Runs live in the
     * agent's tmux viewer pane when it's selected, else in-process; resolves to the captured output
     * and the command's exit code.
     */
    runInPane?: (cmd: string, signal: AbortSignal) => Promise<{ output: string; rc: number }>;
  };
}

/**
 * File-mutating tools a read-only agent is never allowed to use, no matter what. Bash is handled
 * separately ({@link isReadOnlyBashCommand}) because read-only agents legitimately need to run
 * investigation commands (git log/diff, ls, grep, tests) — denying Bash wholesale was the single
 * biggest reason these agents couldn't do their jobs.
 */
const READONLY_DENIED_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/**
 * One Claude Code agent = one streaming query() session.
 * Emits 'update' (throttled) whenever status/events/cost change, and 'approval'
 * when a tool needs human sign-off (only in 'default' permission mode).
 */
export class AgentSession extends EventEmitter {
  readonly id: string;
  readonly name: string;
  readonly template: AgentTemplate;
  /** Parent agent id, for a nested child session (e.g. a merge agent under its feature agent). */
  readonly parentId?: string;
  readonly ticket: string;
  private readonly prompt: string;
  private readonly magicLink?: string;
  // Git branch / worktree / port / ownership. Mutable behind getters: a worktree-less orchestrator
  // parent can ADOPT a worktree the first time it gains a subagent (adoptWorktree), so the whole
  // group works on one branch.
  private _branch?: string;
  private _worktree?: string;
  private _ownsWorktree: boolean;
  private _metroPort?: number;
  /** UDID of the dedicated iOS Simulator orc provisioned for this agent, or undefined when none. */
  private _simulatorUdid?: string;
  /** Whether the human archived this agent (hidden in the Done section; excluded from integrate). */
  private _archived = false;

  /** Git branch, or undefined for no-worktree templates (merge/read-only). */
  get branch(): string | undefined {
    return this._branch;
  }
  /** Worktree path, or undefined for no-worktree templates (they run in the base repo). */
  get worktree(): string | undefined {
    return this._worktree;
  }
  /**
   * Whether this agent owns its worktree's lifecycle (recreate on launch, remove on delete). False
   * for a child sharing its group's worktree, so it never clobbers or deletes it.
   */
  get ownsWorktree(): boolean {
    return this._ownsWorktree;
  }
  get metroPort(): number | undefined {
    return this._metroPort;
  }
  /** UDID of the dedicated iOS Simulator orc provisioned for this agent, or undefined when none. */
  get simulatorUdid(): string | undefined {
    return this._simulatorUdid;
  }
  /** Whether the human archived this agent (hidden in the Done section; excluded from integrate). */
  get archived(): boolean {
    return this._archived;
  }
  /** Set the archived flag and notify listeners so the sidebar re-renders. */
  setArchived(v: boolean): void {
    if (this._archived === v) return;
    this._archived = v;
    this.emitNow();
  }
  /** Nice name of the project this agent belongs to. */
  readonly project: string;
  /** Absolute path to the project's base repo (for worktree cleanup). */
  readonly repo: string;

  private readonly config: ProjectConfig;
  /** Launcher-only: spawns a feature agent (set by the manager). Undefined for other templates. */
  private readonly launchFeature?: LaunchFeature;
  /** Pipeline-only: runs ONE role step on the shared worktree (set by the manager). */
  private readonly runStep?: RunPipelineStep;
  /** Worker-only: cuts+adopts an isolated worktree on demand (set by the manager). */
  private readonly cutWorktreeOnDemand?: EnsureWorktree;
  /** Group orchestration callbacks backing the in-process `mcp__orc__*` coordination tools. */
  private readonly orchestration?: AgentSessionInit['orchestration'];
  private queue = new InputQueue();
  private query: Query | null = null;
  /** Aborts the current SDK subprocess. Recreated on every launch. */
  private abortController: AbortController | null = null;

  private status: AgentStatus = 'booting';
  private question?: string;
  private sessionId?: string;
  /** Accumulated USD cost, or undefined until the first SDK result reports one. */
  private totalCostUsd: number | undefined;
  /**
   * The agent's most recent final turn text: its hand-off summary when it finished (DONE), or its
   * question when it paused (NEEDS_INPUT / sentinel-less turn end). A pipeline reads this (via
   * {@link waitUntilFinished}) to learn what a role step produced without the child's transcript.
   */
  private lastResultText = '';

  private events: LogEntry[] = [];
  private nextEventId = 1;
  private blockEntries = new Map<number, LogEntry>();
  private toolJson = new Map<number, string>();

  pendingApproval?: PendingApproval;

  private emitScheduled = false;

  constructor(init: AgentSessionInit) {
    super();
    this.id = init.id;
    this.name = init.name;
    this.template = init.template;
    this.parentId = init.parentId;
    this.ticket = init.ticket;
    this.prompt = init.prompt;
    this.magicLink = init.magicLink;
    this._branch = init.branch;
    this._worktree = init.worktree;
    // An agent with a worktree owns it unless told otherwise (a child shares its group's one).
    this._ownsWorktree = init.ownsWorktree ?? init.worktree !== undefined;
    this._metroPort = init.metroPort;
    this._simulatorUdid = init.simulatorUdid;
    this.config = init.config;
    this.launchFeature = init.launchFeature;
    this.runStep = init.runStep;
    this.cutWorktreeOnDemand = init.cutWorktreeOnDemand;
    this.orchestration = init.orchestration;
    this.project = init.config.name;
    this.repo = init.config.repo;
  }

  // ---- public API ---------------------------------------------------------

  /**
   * Adopt a worktree the manager created for this agent.
   *
   * Two callers, two behaviors, selected by `relaunch`:
   *  - An orchestrator parent adopting a SHARED worktree the first time it gains a subagent
   *    (`relaunch` omitted/false): it becomes the OWNER of the shared worktree/branch (children share
   *    it without owning it). The change takes effect on the parent's NEXT launch; the current turn
   *    keeps running where it is, because the SUBAGENTS do the editing, not the parent.
   *  - A general-purpose `worker` cutting its own worktree on demand (`relaunch` true): the worker
   *    itself is the editor, so it must move INTO the worktree before it edits. We adopt the
   *    worktree/port, then relaunch the session so its cwd (and port env) become the worktree's from
   *    the next turn — the worker's `create_worktree` tool told it edits land there "from your next
   *    turn". `port` is the freshly allocated port (if any) so METRO_PORT/AGENT_PORT are set on relaunch,
   *    and `simulatorUdid` is the on-demand simulator (if any) so SIMULATOR_UDID is set on relaunch.
   *
   * No-op if this agent already has a worktree.
   */
  adoptWorktree(wt: Worktree, port?: number, relaunch = false, simulatorUdid?: string): void {
    if (this._worktree) return;
    this._branch = wt.branch;
    this._worktree = wt.path;
    this._ownsWorktree = true;
    if (port !== undefined) this._metroPort = port;
    if (simulatorUdid !== undefined) this._simulatorUdid = simulatorUdid;
    const portNote = port !== undefined ? ` (port ${port})` : '';
    this.addLog(
      'system',
      relaunch
        ? `adopted worktree on ${wt.branch}${portNote} — relaunching inside it`
        : `adopted shared worktree on ${wt.branch} for its subagents`,
    );
    this.emitNow();
    // Worker path: relaunch into the new worktree so the model's subsequent edits run there, not in
    // the base repo. Deferred to a microtask so the in-flight `create_worktree` tool call can return
    // its result to the model first; resumeWith() then interrupts and restarts the query in the new
    // cwd, continuing the same Claude session.
    if (relaunch) {
      queueMicrotask(() => {
        if (this.isDead()) return;
        void this.stop().then(() => {
          this.setStatus('working');
          this.resumeWith(
            'Your worktree is ready and this session is now running inside it. Continue the task — ' +
              'make your edits, build, run checks and commit here.',
          );
        });
      });
    }
  }

  /**
   * Reconstruct a session from persisted state instead of launching it. Seeds the prior Claude
   * `sessionId` so a later send()/retry() resumes that session (via `resume: sessionId`), and parks
   * the agent as 'stopped' (resumable) — NOT 'working', even if orc was killed mid-turn. Does NOT
   * start a turn or resend the original prompt: the human resumes it explicitly. A one-line system
   * entry marks it as restored. Idempotent-ish; intended to be called once right after construction.
   */
  hydrate(state: { sessionId?: string }): void {
    this.sessionId = state.sessionId;
    this.status = 'stopped';
    this.addLog('system', '↻ restored from previous session (press retry/send to resume)');
    this.emitNow();
  }

  /** Start the session with the prompt as the first user message. */
  start(): void {
    this.queue.push(this.prompt);
    const ref = this.ticket ? ` [${this.ticket}]` : '';
    const portNote = this.metroPort !== undefined ? ` (port ${this.metroPort})` : '';
    const where = this.branch ? ` on ${this.branch}` : ` in ${this.repo}`;
    this.addLog(
      'system',
      `▶ launching ${this.template} agent "${this.name}"${ref}${where}${portNote}`,
    );
    void this.launch(this.buildOptions());
  }

  /**
   * Ensure the worktree exists, then open the query() stream and run the loop.
   * Kept async so a missing worktree can be recreated before the SDK spawns its
   * subprocess (which would otherwise die in a nonexistent cwd).
   */
  private async launch(options: Options): Promise<void> {
    if (!(await this.ensureWorktree())) return;
    this.query = query({ prompt: this.queue, options });
    void this.runLoop();
  }

  /**
   * Make sure the agent's worktree exists before we launch the SDK subprocess in it.
   * If it's gone (e.g. the agent merged/removed its own worktree, or a human ran `d`),
   * recreate it on the existing `agent/<slug>` branch — which restores the agent's prior
   * commits — rather than silently running on the main checkout, where the tools would
   * mutate master. Returns false (and sets 'error') when recreation fails, so we never
   * launch in the wrong directory.
   */
  private async ensureWorktree(): Promise<boolean> {
    // No-worktree templates (merge/read-only) run in the base repo — nothing to ensure.
    if (!this.worktree) return true;
    if (existsSync(this.worktree)) return true;
    // A shared worktree we don't own (a pipeline role child) must not be recreated here: its path
    // and branch belong to the pipeline, and createWorktree() would cut one keyed off THIS agent's
    // id instead. If the pipeline's worktree is gone, surface it rather than diverging.
    if (!this.ownsWorktree) {
      this.addLog(
        'error',
        `shared worktree ${this.worktree} is gone — it belongs to this agent's pipeline. ` +
          `Retry or restart the pipeline rather than this role agent.`,
      );
      this.setStatus('error');
      this.queue.close();
      return false;
    }
    this.addLog('system', `worktree ${this.worktree} is gone — recreating it on ${this.branch}`);
    try {
      await createWorktree(this.repo, this.config.worktreeDir, this.id);
      this.addLog('system', `↻ recreated worktree at ${this.worktree}`);
      return true;
    } catch (err) {
      this.addLog(
        'error',
        `could not recreate worktree ${this.worktree}: ${(err as Error).message}. ` +
          `Fix it manually or remove the agent.`,
      );
      this.setStatus('error');
      this.queue.close();
      return false;
    }
  }

  /**
   * Send a human reply. If the session is live, it continues the same turn stream.
   * If it has ended (done/error/stopped), it resumes the underlying Claude session
   * (via `resume: sessionId`) so a crash or a finished agent can be picked back up.
   */
  send(text: string): void {
    const trimmed = text.trim();

    // Slash commands. Control-style ones (/stop, /model, /commands) map to the SDK's
    // streaming control API and are handled here without starting a turn. Everything else
    // — custom .claude/commands and prompt-expanding built-ins like /compact — is forwarded
    // verbatim as prompt text; the SDK expands it inside the turn. (The SDK rejects any
    // non-prompt message pushed onto the input stream with "only prompt commands are
    // supported in streaming mode", so control commands must never be enqueued.)
    if (trimmed.startsWith('/') && this.handleSlashCommand(trimmed)) return;

    this.deliver(text, { kind: 'input', log: `you: ${text}` });
  }

  /**
   * Feed a message into this agent's turn and log it. Human replies log as 'input' ("you: …"); a
   * cross-agent injection (a subagent's question driving its orchestrator) logs as 'subagent' so it
   * is never mistaken for the human having typed it. If the session is live it continues the current
   * turn; if it has ended it resumes the prior Claude session so a finished/crashed agent picks back
   * up. `log` is the exact text to show; `kind` its colour/attribution.
   */
  private deliver(text: string, entry: { kind: LogEntry['kind']; log: string }): void {
    this.question = undefined;
    // If the turn has ended, the SDK subprocess is no longer consuming the input queue — for
    // 'needs_input' the turn resolved to a 'result' and the CLI typically exits — so pushing the
    // reply onto the live queue would be silently dropped and the agent would never pick it up.
    // Relaunch the session (resume: sessionId) instead, the same path a human retry takes, so the
    // answer reliably starts a fresh turn. Only a genuinely mid-turn session (working /
    // needs_approval) still has a live loop to receive a pushed message.
    if (this.turnEnded()) {
      this.resumeWith(text, entry);
      return;
    }
    this.addLog(entry.kind, entry.log);
    this.setStatus('working');
    this.queue.push(text);
  }

  /**
   * Route the control-style slash commands to the SDK's streaming control API. Returns true
   * if the command was handled here (caller should stop), false to let it fall through and
   * be sent as an ordinary prompt command (custom commands, /compact, etc.).
   */
  private handleSlashCommand(text: string): boolean {
    const [command, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (command.toLowerCase()) {
      case 'stop':
      case 'interrupt':
        this.addLog('input', `you: /${command}`);
        void this.stop();
        return true;
      case 'model':
        this.addLog('input', `you: ${text}`);
        void this.runControl(
          () => this.query?.setModel(arg || undefined),
          arg ? `model set to ${arg}` : 'model reset to default',
        );
        return true;
      case 'commands':
        this.addLog('input', 'you: /commands');
        void this.runControl(async () => {
          const cmds = (await this.query?.supportedCommands()) ?? [];
          const names = cmds.map((c) => `/${c.name}`).join(', ');
          this.addLog('system', names ? `available commands: ${names}` : 'no commands available');
        });
        return true;
      default:
        // Not a control command — forward as a prompt command.
        return false;
    }
  }

  /**
   * Run an SDK control request against the live query. These only work in streaming input
   * mode on a running session; if the session is dead or the call fails, surface it as a
   * log line instead of letting the rejection bubble into an unhandled rejection.
   */
  private async runControl(fn: () => Promise<unknown> | undefined, okMessage?: string): Promise<void> {
    if (!this.query || this.isDead()) {
      this.addLog('error', 'command needs a running session — retry the agent first');
      return;
    }
    try {
      await fn();
      if (okMessage) this.addLog('system', okMessage);
    } catch (err) {
      this.addLog('error', oneLine(`command failed: ${(err as Error).message}`));
    }
  }

  /** Resume a finished/crashed/paused agent (or one waiting for input) and nudge it to continue. */
  retry(): void {
    if (!this.turnEnded()) return;
    this.resumeWith(
      'Please continue the task where you left off. If the previous step failed, investigate the error and fix it.',
    );
  }

  /**
   * Terminal states: the session has fully ended and can only be picked back up by resuming.
   * 'needs_login' belongs here — the CLI exited and closed the queue on an auth failure, so once
   * the human re-authenticates a retry()/send() must relaunch (resume) rather than push.
   */
  private isDead(): boolean {
    return (
      this.status === 'done' ||
      this.status === 'error' ||
      this.status === 'stopped' ||
      this.status === 'needs_login'
    );
  }

  /**
   * The current turn has finished, so no live loop is reading the input queue. This is every
   * terminal state plus 'needs_input' — where the turn resolved to a 'result' and the SDK
   * subprocess has gone idle (and often exited) waiting for the human. Continuing from any of
   * these requires relaunching the session (resume: sessionId), not pushing onto the live queue.
   * 'needs_approval' is NOT included: that pauses mid-turn with the subprocess still alive.
   */
  private turnEnded(): boolean {
    return this.isDead() || this.status === 'needs_input';
  }

  /**
   * Start a fresh query, resuming the prior Claude session if we have its id. `entry` controls how
   * the nudge text is logged: a human retry/reply logs as 'input' ("you: …"); a cross-agent
   * injection logs as 'subagent' so it isn't mistaken for the human.
   */
  private resumeWith(
    text: string,
    entry: { kind: LogEntry['kind']; log: string } = { kind: 'input', log: `you: ${text}` },
  ): void {
    this.queue = new InputQueue();
    this.queue.push(text);
    this.addLog(entry.kind, entry.log);
    this.addLog(
      'system',
      this.sessionId ? `↻ resuming session ${this.sessionId.slice(0, 8)}` : '↻ restarting session',
    );
    this.setStatus('working');
    void this.launch(this.buildOptions(this.sessionId));
  }

  /** Resolve a pending tool-approval request. */
  resolveApproval(approved: boolean): void {
    const pending = this.pendingApproval;
    if (!pending) return;
    this.pendingApproval = undefined;
    pending.resolve(approved);
    this.addLog('system', approved ? `✓ approved ${pending.toolName}` : `✗ denied ${pending.toolName}`);
    this.setStatus('working');
  }

  /**
   * Fully stop the session: interrupt the current turn, then abort the SDK subprocess.
   * interrupt() alone only ends the current turn but leaves the CLI subprocess running;
   * aborting the controller tears the process down (the SDK sends SIGTERM/SIGKILL) so the
   * agent is actually stopped, not just paused. A later retry()/send() relaunches cleanly.
   */
  async stop(): Promise<void> {
    try {
      await this.query?.interrupt();
    } catch {
      /* already ending */
    }
    this.abortController?.abort();
    this.abortController = null;
    this.query = null;
    this.queue.close();
    if (this.status !== 'done' && this.status !== 'error') this.setStatus('stopped');
  }

  getInfo(): AgentInfo {
    return {
      id: this.id,
      name: this.name,
      template: this.template,
      parentId: this.parentId,
      project: this.project,
      ticket: this.ticket,
      branch: this.branch,
      worktree: this.worktree,
      ownsWorktree: this._ownsWorktree,
      metroPort: this.metroPort,
      simulatorUdid: this._simulatorUdid,
      status: this.status,
      question: this.question,
      sessionId: this.sessionId,
      totalCostUsd: this.totalCostUsd,
      archived: this._archived,
    };
  }

  getEvents(): readonly LogEntry[] {
    return this.events;
  }

  /**
   * Resolve once this session reaches a terminal state — finished (done), paused for the human
   * (needs_input), or dead (error/stopped) — returning that status and the agent's final turn text.
   * A pipeline awaits this so its run-step tool call only returns after the role actually finished,
   * giving it the role's hand-off summary to decide the next step. If the session is already terminal
   * it resolves immediately. ('needs_approval' is NOT terminal: the human is mid-turn, so we keep
   * waiting until the approval resolves and the turn ends one way or the other.)
   */
  waitUntilFinished(): Promise<{ status: AgentStatus; text: string }> {
    const isTerminal = (s: AgentStatus) =>
      s === 'done' ||
      s === 'error' ||
      s === 'stopped' ||
      s === 'needs_input' ||
      s === 'needs_login';
    if (isTerminal(this.status)) {
      return Promise.resolve({ status: this.status, text: this.lastResultText });
    }
    return new Promise((resolve) => {
      const onUpdate = () => {
        if (!isTerminal(this.status)) return;
        this.off('update', onUpdate);
        resolve({ status: this.status, text: this.lastResultText });
      };
      this.on('update', onUpdate);
    });
  }

  /**
   * This agent's most recent final-turn text: its hand-off summary (DONE) or its last question
   * (NEEDS_INPUT / sentinel-less turn end). Exposed so a parent's `list_subagents` tool can show each
   * subagent's latest hand-off without reading its transcript. Empty until the first turn ends.
   */
  lastSummary(): string {
    return this.lastResultText;
  }

  /**
   * A subagent asked this (orchestrator) agent a question via `ask_orchestrator` and is blocked on
   * the answer. Surface it so the orchestrator's next turn sees it and can call `answer_subagent`,
   * and so the human watching the TUI knows a child is waiting. The subagent's id is included so the
   * orchestrator knows exactly which `answer_subagent` call to make. This does NOT pause the parent —
   * it is informational; the child blocks until answered (by the parent's tool or the human).
   */
  receiveSubagentQuestion(childName: string, childId: string, question: string): void {
    const q = oneLine(question, 400);
    const driver =
      `A subagent you launched, "${childName}" (id: ${childId}), is waiting on you and asked:\n` +
      `${question}\n\n` +
      `Answer it by calling answer_subagent(childId: "${childId}", answer: …). If you need the ` +
      `human to decide, ask them (ending your turn with ${NEEDS_INPUT}) and relay their answer.`;
    // Inject the question to drive the orchestrator's next turn (continuing a live turn or resuming
    // a finished one), logging it as a 'subagent' entry — NOT 'you: …' — so the human never mistakes
    // a child's question for something they typed. The child stays blocked until answered (by the
    // orchestrator's tool or the human).
    this.deliver(driver, {
      kind: 'subagent',
      log:
        `✉ subagent "${childName}" (id: ${childId}) is asking you: ${q} — answer it with ` +
        `answer_subagent(childId: "${childId}", answer: …).`,
    });
  }

  /**
   * A subagent posted a fire-and-forget progress note via `report_to_orchestrator`. Surface it in
   * this orchestrator's log (as a 'subagent' entry, distinct from the human's 'you: …' input) so the
   * human can track the whole group by watching only the orchestrator. Unlike a question, this does
   * NOT drive the orchestrator's turn — it is purely informational and never resumes/interrupts it.
   */
  receiveSubagentReport(childName: string, childId: string, note: string): void {
    this.addLog('subagent', `↪ subagent "${childName}" (id: ${childId}): ${oneLine(note, 400)}`);
  }

  // ---- session options ----------------------------------------------------

  private buildOptions(resume?: string): Options {
    // Read-only templates (launcher, pipeline and the read-only roles) never edit code.
    // The launcher and pipeline each additionally get exactly one write-ish power: their own MCP
    // tool (spawn feature agents / run one role step), allowed explicitly below.
    const readOnly = isReadOnlyTemplate(this.template);
    // A fresh controller per launch. stop() aborts it to tear down the SDK subprocess;
    // a later retry()/send() builds new options with a new controller.
    this.abortController = new AbortController();
    const opts: Options = {
      abortController: this.abortController,
      // No-worktree templates (merge/read-only) run in the project's base repo. For
      // worktree templates, ensureWorktree() runs before every launch and guarantees the
      // path exists (recreating it if needed), so the SDK never spawns in a dead cwd.
      cwd: this.worktree ?? this.repo,
      env: {
        ...process.env,
        // Silence the SDK's 1P telemetry/error-reporting exporter. Its background export
        // failures ("1P event logging: N events failed to export") otherwise surface as
        // unhandled rejections. This one switch disables both telemetry and error reporting.
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        AGENT_NAME: this.name,
        ...(this.metroPort !== undefined
          ? { METRO_PORT: String(this.metroPort), AGENT_PORT: String(this.metroPort) }
          : {}),
        ...(this._simulatorUdid ? { SIMULATOR_UDID: this._simulatorUdid } : {}),
        ...(this.magicLink ? { MAGIC_LINK: this.magicLink } : {}),
      },
      model: this.config.model,
      includePartialMessages: true,
      settingSources: this.config.settingSources,
      permissionMode: this.config.permissionMode,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: buildAppendPrompt({
          name: this.name,
          template: this.template,
          metroPort: this.metroPort,
          simulatorUdid: this._simulatorUdid,
          ticket: this.ticket,
          magicLink: this.magicLink,
          project: this.project,
          mergeStrategy: this.config.mergeStrategy,
          baseBranch: this.config.baseBranch,
        }),
      },
      stderr: (data) => {
        const line = oneLine(data);
        if (line) this.addLog('system', `stderr: ${line}`);
      },
      // Runs for every tool call in every permission mode (even bypassPermissions, where
      // canUseTool is skipped). We use it to stop an oversized unbounded Read from reaching
      // the SDK's file reader (which would otherwise throw and kill the session), and to
      // block the built-in AskUserQuestion tool, which orc doesn't service — orc's only
      // human-input channel is the @@NEEDS_INPUT@@ sentinel, so AskUserQuestion would
      // otherwise resolve with empty answers and the agent would continue without pausing.
      hooks: {
        PreToolUse: [
          {
            hooks: [
              (input) => this.guardLargeRead(input as PreToolUseHookInput),
              (input) => this.guardAskUserQuestion(input as PreToolUseHookInput),
            ],
          },
        ],
      },
    };

    if (readOnly) {
      // A read-only agent is read-only no matter the project's permission mode: never bypass
      // permissions. It can investigate freely (read tools auto-allowed, plus read-only Bash such as
      // git log/diff, ls, grep, and tests) but every file-mutating tool and any state-changing Bash
      // command is denied. The launcher/pipeline additionally get their own orchestration tool, and
      // the group coordination tools are always allowed — they only pass messages between agents.
      opts.permissionMode = 'default';
      opts.canUseTool = (toolName, input) =>
        Promise.resolve(this.decideReadOnlyTool(toolName, input));
    } else if (this.config.permissionMode === 'bypassPermissions') {
      opts.allowDangerouslySkipPermissions = true;
    } else if (this.config.permissionMode === 'default') {
      opts.canUseTool = (toolName, input, options) => {
        // The group coordination tools only pass messages between agents in the same group — they
        // never touch the codebase — so auto-allow them instead of prompting the human for each one.
        if (ORCHESTRATION_TOOLS.has(toolName)) {
          return Promise.resolve({ behavior: 'allow', updatedInput: input });
        }
        return new Promise((resolve) => {
          this.pendingApproval = {
            toolName,
            input,
            reason: options.decisionReason,
            resolve: (approved) =>
              approved
                ? resolve({ behavior: 'allow', updatedInput: input })
                : resolve({ behavior: 'deny', message: 'Denied by supervisor' }),
          };
          this.setStatus('needs_approval');
        });
      };
    }

    if (resume) opts.resume = resume;

    const mcpServers: NonNullable<Options['mcpServers']> = {};
    if (this.config.maestroMcp) {
      mcpServers.maestro = {
        type: 'stdio',
        command: this.config.maestroMcp.command,
        args: this.config.maestroMcp.args,
        // Point Maestro at this agent's dedicated simulator so it never drives a shared/"booted"
        // device. MAESTRO_DEVICE is Maestro's device selector; SIMULATOR_UDID is passed too for
        // tooling that reads it. A configured env wins if it set these explicitly.
        env: this._simulatorUdid
          ? {
              MAESTRO_DEVICE: this._simulatorUdid,
              SIMULATOR_UDID: this._simulatorUdid,
              ...this.config.maestroMcp.env,
            }
          : this.config.maestroMcp.env,
      };
    }
    // Every agent gets the in-process "orc" MCP server. It always carries the group coordination
    // tools (list/ask/answer_subagent as the orchestrator, ask_orchestrator as a subagent) so any
    // agent can work with the rest of its group. Launcher and pipeline agents ADD their one
    // spawn/run-step tool onto the same server: the launcher spawns feature agents (LAUNCH_TOOL);
    // the pipeline runs one role step at a time (RUN_STEP_TOOL). All live on server "orc", so the
    // fully-qualified names stay `mcp__orc__*`.
    if (this.orchestration) {
      // Build the tool list as a SINGLE array literal: a mixed-shape literal is inferred as the
      // union of all element types, which is assignable to buildOrcServer's SdkMcpToolDefinition<any>[]
      // param. Using Array.push instead would fail — push is invariant in the element type, so the
      // launcher/pipeline tool's distinct schema shape isn't accepted into the inferred union.
      const orcTools = [
        ...buildOrchestratorTools({
          listSubagents: this.orchestration.listSubagents,
          askSubagent: this.orchestration.askSubagent,
          answerSubagent: this.orchestration.answerSubagent,
        }),
        ...buildSubagentTools(
          this.orchestration.askOrchestrator,
          this.orchestration.reportToOrchestrator,
        ),
        // Every agent can spawn its own subagent (when the human asks, or when a task suits a
        // different kind of agent). The spawned subagent is itself permission-constrained by its own
        // template, so this is safe to give even to read-only agents (auto-allowed via ORCHESTRATION_TOOLS).
        ...buildSpawnSubagentTool(this.orchestration.spawnSubagent),
        // The custom run tool replaces the built-in Bash tool (disabled above): it runs each shell
        // command live in the agent's tmux viewer pane. For read-only agents it refuses
        // state-changing commands (same gate as Bash). Only wired when the manager supplied a runner.
        ...(this.orchestration.runInPane
          ? buildRunTool(this.orchestration.runInPane, readOnly)
          : []),
        ...(this.template === 'launcher' && this.launchFeature
          ? buildLauncherTools(this.launchFeature)
          : []),
        ...(this.template === 'pipeline' && this.runStep
          ? buildPipelineTools(this.runStep)
          : []),
        ...(this.template === 'worker' && this.cutWorktreeOnDemand
          ? buildWorkerTools(this.cutWorktreeOnDemand)
          : []),
      ];
      mcpServers.orc = buildOrcServer(orcTools);
    }
    if (Object.keys(mcpServers).length > 0) opts.mcpServers = mcpServers;

    // Disable the built-in Bash tool: agents run shell commands through the custom in-process
    // mcp__orc__run tool instead, so the command executes live in the agent's tmux viewer pane.
    opts.disallowedTools = [...(opts.disallowedTools ?? []), 'Bash'];

    return opts;
  }

  /**
   * Decide whether a read-only agent may use a tool. Read/Grep/Glob/Task and the group coordination
   * tools (plus the launcher/pipeline's own spawn/run-step tool) are auto-allowed. File-mutating
   * tools are always denied. Bash is allowed only for provably read-only commands (git log/diff, ls,
   * grep, tests, …) via {@link isReadOnlyBashCommand}; a state-changing command is denied with a hint
   * to spawn a full-access subagent for that part.
   */
  private decideReadOnlyTool(
    toolName: string,
    input: Record<string, unknown>,
  ): { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string } {
    const ownTool =
      this.template === 'launcher' ? LAUNCH_TOOL : this.template === 'pipeline' ? RUN_STEP_TOOL : undefined;
    if ((ownTool && toolName === ownTool) || ORCHESTRATION_TOOLS.has(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }
    if (READONLY_DENIED_TOOLS.has(toolName)) {
      return {
        behavior: 'deny',
        message: `"${toolName}" is disabled: this is a read-only ${this.template} agent that cannot modify the codebase. If you need to change files, spawn a full-access "feature"/"fix"/"worker" subagent to do that part.`,
      };
    }
    // Bash and the custom mcp__orc__run pane tool are gated identically: a read-only agent may only
    // run provably read-only commands; a state-changing command is denied with a delegation hint.
    if (toolName === 'Bash' || toolName === 'mcp__orc__run') {
      const command = typeof input.command === 'string' ? input.command : '';
      if (!isReadOnlyBashCommand(command)) {
        return {
          behavior: 'deny',
          message: `This command isn't allowed for a read-only ${this.template} agent: it may change state. You can run read-only commands (git log/diff/show/status/blame, ls, cat, grep/rg, find, and test/lint/typecheck scripts). To run a state-changing command, spawn a full-access "feature"/"fix"/"worker" subagent.`,
        };
      }
    }
    return { behavior: 'allow', updatedInput: input };
  }

  /**
   * PreToolUse guard: deny an unbounded `Read` of a file large enough to trip the SDK's
   * 25k-token file-read limit. Without this, the SDK's reader throws a
   * MaxFileReadTokenExceededError that escapes the turn loop and kills the whole session
   * (surfacing as "turn ended: error_during_execution" then "process exited with code 1").
   * Denying with guidance keeps the session alive and nudges the agent to page the file
   * with offset/limit or search it with Grep. Reads that already pass `limit` are left
   * alone — the SDK bounds those itself — as are non-Read tools.
   */
  private guardLargeRead(input: PreToolUseHookInput): Promise<HookJSONOutput> {
    const allow: HookJSONOutput = { continue: true };
    if (input.tool_name !== 'Read') return Promise.resolve(allow);
    const toolInput = (input.tool_input ?? {}) as { file_path?: unknown; limit?: unknown };
    // A bounded read (limit set) is safe: the SDK caps how much it returns.
    if (toolInput.limit !== undefined && toolInput.limit !== null) return Promise.resolve(allow);
    const filePath = toolInput.file_path;
    if (typeof filePath !== 'string' || !filePath) return Promise.resolve(allow);

    let bytes: number;
    try {
      const abs = isAbsolute(filePath) ? filePath : resolvePath(input.cwd, filePath);
      const stat = statSync(abs);
      if (!stat.isFile()) return Promise.resolve(allow);
      bytes = stat.size;
    } catch {
      // Can't stat it (missing/permission) — let the SDK handle the real error.
      return Promise.resolve(allow);
    }
    if (bytes <= MAX_UNBOUNDED_READ_BYTES) return Promise.resolve(allow);

    const estTokens = Math.round(bytes / CHARS_PER_TOKEN);
    const deny: HookJSONOutput = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `File is ~${estTokens.toLocaleString()} tokens, over the ${READ_TOKEN_LIMIT.toLocaleString()}-token ` +
          `read limit. Reading it whole would abort the session. Re-read a portion with the ` +
          `\`offset\` and \`limit\` parameters, or use Grep to search for the content you need.`,
      },
    };
    this.addLog('system', oneLine(`blocked oversized Read of ${filePath} (~${estTokens} tokens)`));
    return Promise.resolve(deny);
  }

  /**
   * PreToolUse guard: deny the SDK's built-in `AskUserQuestion` tool. orc has no handler for
   * it — the only way an agent reaches the human is by ending its turn with the
   * `@@NEEDS_INPUT@@` sentinel (see handleResult), which flips the agent to 'needs_input' and
   * opens the reply box. Left to the SDK, `AskUserQuestion` resolves with empty answers in this
   * non-interactive harness, so the agent "sees" a blank answer and barrels on without ever
   * pausing. Denying it with guidance redirects the agent onto orc's real human-input flow.
   * Runs in every permission mode (even bypassPermissions, where canUseTool is skipped).
   */
  private guardAskUserQuestion(input: PreToolUseHookInput): Promise<HookJSONOutput> {
    if (input.tool_name !== 'AskUserQuestion') return Promise.resolve({ continue: true });
    const deny: HookJSONOutput = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `AskUserQuestion isn't supported here — it returns no answer and your turn would ` +
          `continue as if the human said nothing. To ask the human, write your question (with ` +
          `the options) as plain text and end your turn with ${NEEDS_INPUT}. The session pauses ` +
          `and the human's reply arrives as your next message.`,
      },
    };
    this.addLog('system', 'blocked AskUserQuestion — use the @@NEEDS_INPUT@@ sentinel instead');
    return Promise.resolve(deny);
  }

  // ---- main loop ----------------------------------------------------------

  private async runLoop(): Promise<void> {
    try {
      for await (const msg of this.query!) {
        this.handle(msg);
      }
    } catch (err) {
      // A deliberate stop() aborts the SDK subprocess, which surfaces here as an
      // AbortError. That's expected teardown, not a failure — stop() has already set the
      // 'stopped' status and closed the queue, so don't log it as an error or clobber it.
      // Likewise, once a turn resolved to 'done' we closed the input queue, and the SDK
      // subprocess often exits non-zero on its way down ("Claude Code process exited with
      // code 1"); that's post-completion teardown, not a failure, so keep the 'done' status.
      if (this.status === 'stopped' || this.status === 'done') return;
      const message = (err as Error).message;
      // A logged-out CLI surfaces here too (the subprocess exits reporting an auth failure).
      // Flag it distinctly so the human re-authenticates rather than treating it as a task error.
      if (isLoginRequired(message)) {
        this.flagLoginRequired(message);
      } else {
        this.addLog('error', oneLine(`session error: ${message}`));
        this.setStatus('error');
      }
      // The SDK session is gone; close our side so the input queue and its async iterator
      // are released. A human can still pick the agent back up via retry()/send(), which
      // starts a fresh query() resuming the prior session id.
      this.queue.close();
    }
  }

  private handle(msg: SDKMessage): void {
    // Once a turn has resolved to 'done', the SDK subprocess is tearing down (we closed the
    // input queue). During that teardown it can emit a stray 'result' with subtype
    // 'error_during_execution' ("only prompt commands are supported in streaming mode") and
    // then exit non-zero. That's post-completion noise, not a real failure — ignore anything
    // that arrives after we've already finished so it can't clobber the 'done' status.
    if (this.status === 'done') return;
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          if (this.status === 'booting') this.setStatus('working');
          this.addLog('system', `session ready · model ${msg.model}`);
        }
        break;
      case 'stream_event':
        this.handleStream(msg.event as unknown as StreamEvent);
        break;
      case 'result':
        this.handleResult(msg);
        break;
      default:
        break;
    }
  }

  private handleStream(event: StreamEvent): void {
    switch (event.type) {
      case 'content_block_start': {
        const e = event as Extract<StreamEvent, { type: 'content_block_start' }>;
        const cb = e.content_block;
        if (cb.type === 'tool_use') {
          const entry = this.addLog('tool', `▸ ${cb.name ?? 'tool'}…`, cb.name);
          this.blockEntries.set(e.index, entry);
          // Some transports deliver the full input upfront; most stream it via input_json_delta.
          const seed =
            cb.input && typeof cb.input === 'object' && Object.keys(cb.input).length > 0
              ? JSON.stringify(cb.input)
              : '';
          this.toolJson.set(e.index, seed);
        } else if (cb.type === 'text') {
          this.blockEntries.set(e.index, this.addLog('text', ''));
        } else if (cb.type === 'thinking') {
          this.blockEntries.set(e.index, this.addLog('thinking', ''));
        }
        break;
      }
      case 'content_block_delta': {
        const e = event as Extract<StreamEvent, { type: 'content_block_delta' }>;
        const entry = this.blockEntries.get(e.index);
        if (!entry) break;
        if (e.delta.type === 'text_delta' && e.delta.text) {
          entry.text += e.delta.text;
          this.scheduleEmit();
        } else if (e.delta.type === 'thinking_delta' && e.delta.thinking) {
          entry.text += e.delta.thinking;
          this.scheduleEmit();
        } else if (e.delta.type === 'input_json_delta' && e.delta.partial_json) {
          this.toolJson.set(e.index, (this.toolJson.get(e.index) ?? '') + e.delta.partial_json);
        }
        break;
      }
      case 'content_block_stop': {
        const e = event as Extract<StreamEvent, { type: 'content_block_stop' }>;
        const entry = this.blockEntries.get(e.index);
        if (entry) {
          entry.done = true;
          if (entry.kind === 'tool') {
            entry.text = summarizeTool(entry.toolName, this.toolJson.get(e.index) ?? '');
          }
        }
        this.blockEntries.delete(e.index);
        this.toolJson.delete(e.index);
        this.scheduleEmit();
        break;
      }
      case 'message_stop':
        this.blockEntries.clear();
        this.toolJson.clear();
        break;
      default:
        break;
    }
  }

  private handleResult(msg: Extract<SDKMessage, { type: 'result' }>): void {
    this.sessionId = msg.session_id;
    this.totalCostUsd = (this.totalCostUsd ?? 0) + (msg.total_cost_usd ?? 0);

    if (msg.subtype !== 'success') {
      const detail = msg.errors.join('; ');
      // Distinguish a logged-out CLI from an ordinary turn failure: it needs the human to
      // re-authenticate before any retry can succeed, so surface it as 'needs_login'.
      if (isLoginRequired(`${msg.subtype} ${detail}`)) {
        this.flagLoginRequired(detail);
        return;
      }
      this.addLog('error', oneLine(`turn ended: ${msg.subtype} — ${detail}`));
      this.setStatus('error');
      return;
    }

    const text = (msg.result ?? '').trim();
    if (text.includes(DONE)) {
      // Keep the whole final message (sans the DONE sentinel) as the hand-off text a pipeline reads.
      this.lastResultText = text.slice(0, text.indexOf(DONE)).trim();
      const commit = text.slice(text.indexOf(DONE) + DONE.length).trim().split(/\s+/)[0] ?? '';
      this.addLog('result', `✓ done${commit ? ` · ${commit}` : ''}`);
      this.setStatus('done');
      this.queue.close();
      return;
    }

    // Either an explicit NEEDS_INPUT, or a turn that ended without a sentinel.
    // In streaming mode the session is now idle and waiting for the human either way.
    this.question = text.replace(NEEDS_INPUT, '').trim();
    this.lastResultText = this.question;
    this.addLog('result', '⏸ waiting for your input');
    this.setStatus('needs_input');
  }

  /**
   * The Claude CLI reported it is logged out. Park the agent in 'needs_login' and tell the human
   * exactly how to recover: re-authenticate the CLI (`claude login`), then press retry. We keep
   * the prior sessionId, so retry()/send() resumes the same session once credentials are restored.
   */
  private flagLoginRequired(detail: string): void {
    this.addLog('error', oneLine(`login required — ${detail}`));
    this.addLog(
      'system',
      '🔑 Claude login expired. Re-authenticate the CLI (run `claude login`), then press r to retry.',
    );
    this.setStatus('needs_login');
  }

  // ---- helpers ------------------------------------------------------------

  private addLog(kind: LogEntry['kind'], text: string, toolName?: string): LogEntry {
    const entry: LogEntry = { id: this.nextEventId++, kind, text, toolName, done: kind !== 'text' && kind !== 'thinking' && kind !== 'tool' };
    this.events.push(entry);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.scheduleEmit();
    return entry;
  }

  private setStatus(status: AgentStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emitNow();
  }

  /** Coalesce frequent updates (token deltas) into ~15fps emits. */
  private scheduleEmit(): void {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    setTimeout(() => {
      this.emitScheduled = false;
      this.emit('update');
    }, 66);
  }

  private emitNow(): void {
    this.emit('update');
  }
}

/** Build a one-line summary of a tool call from its (possibly partial) JSON input. */
export function summarizeTool(name: string | undefined, rawJson: string): string {
  const label = name ?? 'tool';
  let input: Record<string, unknown> = {};
  try {
    input = rawJson ? (JSON.parse(rawJson) as Record<string, unknown>) : {};
  } catch {
    /* partial/unparseable input */
  }
  const s = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));
  let detail = '';
  if (name === 'Bash') detail = s(input.command);
  else if (name === 'mcp__orc__run') detail = s(input.command);
  else if (name === 'Read' || name === 'Edit' || name === 'Write') detail = s(input.file_path);
  else if (name === 'Glob' || name === 'Grep') detail = s(input.pattern);
  else if (name === 'Task') detail = s(input.description);
  else if (name?.startsWith('mcp__')) detail = Object.keys(input).slice(0, 3).map((k) => `${k}=${s(input[k])}`).join(' ');
  else detail = Object.keys(input).length ? s(input[Object.keys(input)[0]]) : '';

  detail = detail.replace(/\s+/g, ' ').trim();
  if (detail.length > 140) detail = detail.slice(0, 137) + '…';
  return `▸ ${label}${detail ? ` ${detail}` : ''}`;
}
