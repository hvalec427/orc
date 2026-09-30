import { EventEmitter } from 'node:events';
import { query, type Query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentInfo, AgentStatus, LogEntry, ProjectConfig, PendingApproval } from '../types.js';
import { InputQueue } from './InputQueue.js';
import { buildAppendPrompt, NEEDS_INPUT, DONE } from '../agentPrompt.js';

const MAX_EVENTS = 800;

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
  /** Short ticket reference (for commit messages / display). May be empty. */
  ticket: string;
  /** The actual task instructions — the agent's first message. */
  prompt: string;
  /** Optional magic sign-in link (already resolved: per-agent override or project default). */
  magicLink?: string;
  branch: string;
  worktree: string;
  metroPort: number;
  config: ProjectConfig;
}

/**
 * One Claude Code agent = one streaming query() session.
 * Emits 'update' (throttled) whenever status/events/cost change, and 'approval'
 * when a tool needs human sign-off (only in 'default' permission mode).
 */
export class AgentSession extends EventEmitter {
  readonly id: string;
  readonly name: string;
  readonly ticket: string;
  private readonly prompt: string;
  private readonly magicLink?: string;
  readonly branch: string;
  readonly worktree: string;
  readonly metroPort: number;
  /** Nice name of the project this agent belongs to. */
  readonly project: string;
  /** Absolute path to the project's base repo (for worktree cleanup). */
  readonly repo: string;

  private readonly config: ProjectConfig;
  private queue = new InputQueue();
  private query: Query | null = null;

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
    this.ticket = init.ticket;
    this.prompt = init.prompt;
    this.magicLink = init.magicLink;
    this.branch = init.branch;
    this.worktree = init.worktree;
    this.metroPort = init.metroPort;
    this.config = init.config;
    this.project = init.config.name;
    this.repo = init.config.repo;
  }

  // ---- public API ---------------------------------------------------------

  /** Start the session with the prompt as the first user message. */
  start(): void {
    this.queue.push(this.prompt);
    const ref = this.ticket ? ` [${this.ticket}]` : '';
    this.addLog('system', `▶ launching agent "${this.name}"${ref} on ${this.branch} (port ${this.metroPort})`);
    this.query = query({ prompt: this.queue, options: this.buildOptions() });
    void this.runLoop();
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
    this.query = query({ prompt: this.queue, options: this.buildOptions(this.sessionId) });
    void this.runLoop();
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

  /** Interrupt and end the session. */
  async stop(): Promise<void> {
    try {
      await this.query?.interrupt();
    } catch {
      /* already ending */
    }
    this.queue.close();
    if (this.status !== 'done' && this.status !== 'error') this.setStatus('stopped');
  }

  getInfo(): AgentInfo {
    return {
      id: this.id,
      name: this.name,
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
    const opts: Options = {
      cwd: this.worktree,
      env: {
        ...process.env,
        AGENT_NAME: this.name,
        METRO_PORT: String(this.metroPort),
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
          metroPort: this.metroPort,
          ticket: this.ticket,
          magicLink: this.magicLink,
        }),
      },
      stderr: (data) => {
        const line = data.trim();
        if (line) this.addLog('system', `stderr: ${line.slice(0, 200)}`);
      },
    };

    if (this.config.permissionMode === 'bypassPermissions') {
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

    if (this.config.maestroMcp) {
      opts.mcpServers = {
        maestro: {
          type: 'stdio',
          command: this.config.maestroMcp.command,
          args: this.config.maestroMcp.args,
          env: this.config.maestroMcp.env,
        },
      };
    }

    return opts;
  }

  // ---- main loop ----------------------------------------------------------

  private async runLoop(): Promise<void> {
    try {
      for await (const msg of this.query!) {
        this.handle(msg);
      }
    } catch (err) {
      this.addLog('error', `session error: ${(err as Error).message}`);
      this.setStatus('error');
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
      this.addLog('error', `turn ended: ${msg.subtype} — ${detail}`);
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
