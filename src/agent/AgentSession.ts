import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { query, type Query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentInfo, AgentStatus, AgentTemplate, LogEntry, ProjectConfig, PendingApproval } from '../types.js';
import { InputQueue } from './InputQueue.js';
import { buildAppendPrompt, LAUNCH_TOOL, NEEDS_INPUT, DONE } from '../agentPrompt.js';
import { buildLauncherMcpServer, type LaunchFeature } from './launcherTools.js';
import { createWorktree } from '../worktree.js';

const MAX_EVENTS = 800;

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
  /** Git branch, or undefined for no-worktree templates (question/merge). */
  branch?: string;
  /** Worktree path, or undefined for no-worktree templates (they run in the base repo). */
  worktree?: string;
  /** Allocated port, or undefined when the project has no port range. */
  metroPort?: number;
  config: ProjectConfig;
  /**
   * For `launcher` agents only: the callback the launch tool uses to spawn a feature agent.
   * The manager supplies this so the tool can create feature agents nested under the launcher.
   */
  launchFeature?: LaunchFeature;
}

/**
 * Tools a read-only "question" agent is never allowed to use. Covers the file-mutating
 * tools plus Bash (which can run arbitrary state-changing commands). The agent can still
 * investigate with Read/Grep/Glob/Task and other read-only tools.
 */
const READONLY_DENIED_TOOLS = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
  'MultiEdit',
  'Bash',
  'BashOutput',
  'KillShell',
  'KillBash',
]);

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
  /** Git branch, or undefined for no-worktree templates (question/merge). */
  readonly branch?: string;
  /** Worktree path, or undefined for no-worktree templates (they run in the base repo). */
  readonly worktree?: string;
  readonly metroPort?: number;
  /** Nice name of the project this agent belongs to. */
  readonly project: string;
  /** Absolute path to the project's base repo (for worktree cleanup). */
  readonly repo: string;

  private readonly config: ProjectConfig;
  /** Launcher-only: spawns a feature agent (set by the manager). Undefined for other templates. */
  private readonly launchFeature?: LaunchFeature;
  private queue = new InputQueue();
  private query: Query | null = null;
  /** Aborts the current SDK subprocess. Recreated on every launch. */
  private abortController: AbortController | null = null;

  private status: AgentStatus = 'booting';
  private question?: string;
  private sessionId?: string;
  private totalCostUsd = 0;

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
    this.branch = init.branch;
    this.worktree = init.worktree;
    this.metroPort = init.metroPort;
    this.config = init.config;
    this.launchFeature = init.launchFeature;
    this.project = init.config.name;
    this.repo = init.config.repo;
  }

  // ---- public API ---------------------------------------------------------

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
    // No-worktree templates (question/merge) run in the base repo — nothing to ensure.
    if (!this.worktree) return true;
    if (existsSync(this.worktree)) return true;
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
    this.question = undefined;
    if (this.isDead()) {
      this.resumeWith(text);
      return;
    }
    this.addLog('input', `you: ${text}`);
    this.setStatus('working');
    this.queue.push(text);
  }

  /** Resume a dead/finished agent and nudge it to continue. */
  retry(): void {
    if (!this.isDead()) return;
    this.resumeWith(
      'Please continue the task where you left off. If the previous step failed, investigate the error and fix it.',
    );
  }

  private isDead(): boolean {
    return this.status === 'done' || this.status === 'error' || this.status === 'stopped';
  }

  /** Start a fresh query, resuming the prior Claude session if we have its id. */
  private resumeWith(text: string): void {
    this.queue = new InputQueue();
    this.queue.push(text);
    this.addLog('input', `you: ${text}`);
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
      metroPort: this.metroPort,
      status: this.status,
      question: this.question,
      sessionId: this.sessionId,
      totalCostUsd: this.totalCostUsd,
    };
  }

  getEvents(): readonly LogEntry[] {
    return this.events;
  }

  // ---- session options ----------------------------------------------------

  private buildOptions(resume?: string): Options {
    // Question and launcher agents are both read-only investigators — they never edit code. The
    // launcher additionally gets exactly one write-ish power: the launch tool that spawns feature
    // agents (allowed explicitly below).
    const readOnly = this.template === 'question' || this.template === 'launcher';
    // A fresh controller per launch. stop() aborts it to tear down the SDK subprocess;
    // a later retry()/send() builds new options with a new controller.
    this.abortController = new AbortController();
    const opts: Options = {
      abortController: this.abortController,
      // No-worktree templates (question/merge) run in the project's base repo. For
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
          ticket: this.ticket,
          magicLink: this.magicLink,
          project: this.project,
        }),
      },
      stderr: (data) => {
        const line = oneLine(data);
        if (line) this.addLog('system', `stderr: ${line}`);
      },
    };

    if (readOnly) {
      // A question/launcher agent is read-only no matter the project's permission mode: never bypass
      // permissions, and hard-deny every mutating tool. Read-only tools are auto-allowed so the
      // agent can still investigate without pestering the human for approval on each read. The
      // launcher is additionally allowed its own spawn tool so it can actually create feature agents.
      const allowLaunch = this.template === 'launcher';
      opts.permissionMode = 'default';
      opts.canUseTool = (toolName, input) =>
        Promise.resolve(
          allowLaunch && toolName === LAUNCH_TOOL
            ? { behavior: 'allow', updatedInput: input }
            : READONLY_DENIED_TOOLS.has(toolName)
              ? {
                  behavior: 'deny',
                  message: `"${toolName}" is disabled: this is a read-only ${this.template} agent that cannot modify the codebase.`,
                }
              : { behavior: 'allow', updatedInput: input },
        );
    } else if (this.config.permissionMode === 'bypassPermissions') {
      opts.allowDangerouslySkipPermissions = true;
    } else if (this.config.permissionMode === 'default') {
      opts.canUseTool = (toolName, input, options) =>
        new Promise((resolve) => {
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
    }

    if (resume) opts.resume = resume;

    const mcpServers: NonNullable<Options['mcpServers']> = {};
    if (this.config.maestroMcp) {
      mcpServers.maestro = {
        type: 'stdio',
        command: this.config.maestroMcp.command,
        args: this.config.maestroMcp.args,
        env: this.config.maestroMcp.env,
      };
    }
    // Launcher agents get an in-process MCP server exposing the single tool that spawns feature
    // agents. Its server name is "orc", so the tool is exposed as LAUNCH_TOOL to the model.
    if (this.template === 'launcher' && this.launchFeature) {
      mcpServers.orc = buildLauncherMcpServer(this.launchFeature);
    }
    if (Object.keys(mcpServers).length > 0) opts.mcpServers = mcpServers;

    return opts;
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
      if (this.status === 'stopped') return;
      this.addLog('error', oneLine(`session error: ${(err as Error).message}`));
      this.setStatus('error');
      // The SDK session is gone; close our side so the input queue and its async iterator
      // are released. A human can still pick the agent back up via retry()/send(), which
      // starts a fresh query() resuming the prior session id.
      this.queue.close();
    }
  }

  private handle(msg: SDKMessage): void {
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
    this.totalCostUsd += msg.total_cost_usd ?? 0;

    if (msg.subtype !== 'success') {
      const detail = msg.errors.join('; ');
      this.addLog('error', oneLine(`turn ended: ${msg.subtype} — ${detail}`));
      this.setStatus('error');
      return;
    }

    const text = (msg.result ?? '').trim();
    if (text.includes(DONE)) {
      const commit = text.slice(text.indexOf(DONE) + DONE.length).trim().split(/\s+/)[0] ?? '';
      this.addLog('result', `✓ done${commit ? ` · ${commit}` : ''}`);
      this.setStatus('done');
      this.queue.close();
      return;
    }

    // Either an explicit NEEDS_INPUT, or a turn that ended without a sentinel.
    // In streaming mode the session is now idle and waiting for the human either way.
    this.question = text.replace(NEEDS_INPUT, '').trim();
    this.addLog('result', '⏸ waiting for your input');
    this.setStatus('needs_input');
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
function summarizeTool(name: string | undefined, rawJson: string): string {
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
  else if (name === 'Read' || name === 'Edit' || name === 'Write') detail = s(input.file_path);
  else if (name === 'Glob' || name === 'Grep') detail = s(input.pattern);
  else if (name === 'Task') detail = s(input.description);
  else if (name?.startsWith('mcp__')) detail = Object.keys(input).slice(0, 3).map((k) => `${k}=${s(input[k])}`).join(' ');
  else detail = Object.keys(input).length ? s(input[Object.keys(input)[0]]) : '';

  detail = detail.replace(/\s+/g, ' ').trim();
  if (detail.length > 140) detail = detail.slice(0, 137) + '…';
  return `▸ ${label}${detail ? ` ${detail}` : ''}`;
}
