import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  buildDriverScript,
  encodeRunLine,
  writeRunLine,
  waitForDone,
  capOutput,
  decidePaneVsFallback,
} from './paneRun.js';

const execFileAsync = promisify(execFile);

/** Runs a tmux subcommand (argv after the `tmux` binary) and yields its captured output. */
export type TmuxRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

// --- Pure helpers (unit-tested; no side effects) -----------------------------------------------

/** A filesystem-safe slug for an agent id: lowercased, non `[a-z0-9_-]` chars folded to `-`. */
export function paneSlug(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

/** Where an agent's rendered pane log lives inside the panes directory. */
export function paneLogPath(logsDir: string, id: string): string {
  return join(logsDir, paneSlug(id) + '.log');
}

/** The named-pipe the pane driver reads commands from, for an agent. */
export function paneFifoPath(logsDir: string, id: string): string {
  return join(logsDir, paneSlug(id) + '.fifo');
}

/** The directory the pane driver writes per-command done-files (exit codes) into. */
export function paneDoneDir(logsDir: string, id: string): string {
  return join(logsDir, paneSlug(id) + '.done');
}

/** The directory the pane driver writes per-command captured output into. */
export function paneIdsDir(logsDir: string, id: string): string {
  return join(logsDir, paneSlug(id) + '.ids');
}

/** Capture a pane's output to a shell command (`-o` = only while a program is running). */
export function argvPipePane(paneId: string, cmd: string): string[] {
  return ['pipe-pane', '-o', '-t', paneId, cmd];
}

/** Send Ctrl+C to a pane (cancels only the command currently running in it). */
export function argvSendInterrupt(paneId: string): string[] {
  return ['send-keys', '-t', paneId, 'C-c'];
}

export function argvHasSession(name: string): string[] {
  return ['has-session', '-t', name];
}

export function argvKillSession(name: string): string[] {
  return ['kill-session', '-t', name];
}

export function argvNewSession(name: string, reexecArgv: string[]): string[] {
  return ['new-session', '-d', '-s', name, ...reexecArgv];
}

export function argvSplitRight(target: string): string[] {
  return ['split-window', '-h', '-t', target];
}

/** Like argvSplitRight, but prints the new pane's id (`-P -F '#{pane_id}'`) so we can capture it. */
export function argvSplitRightPrint(target: string): string[] {
  return ['split-window', '-h', '-P', '-F', '#{pane_id}', '-t', target];
}

/** Ask tmux to print a value for a target (or the current client when target is omitted). */
export function argvDisplayMessage(format: string, target?: string): string[] {
  return target
    ? ['display-message', '-p', '-t', target, format]
    : ['display-message', '-p', format];
}

export function argvStatusOff(name: string): string[] {
  return ['set', '-t', name, 'status', 'off'];
}

export function argvListPanes(target: string): string[] {
  return ['list-panes', '-t', target, '-F', '#{pane_id} #{pane_index}'];
}

export function argvRespawnViewer(paneId: string, cmd: string): string[] {
  return ['respawn-pane', '-k', '-t', paneId, cmd];
}

export function argvKillPane(paneId: string): string[] {
  return ['kill-pane', '-t', paneId];
}

export function argvSelectPane(target: string): string[] {
  return ['select-pane', '-t', target];
}

export function argvAttach(name: string): string[] {
  return ['attach-session', '-t', name];
}

/** Parse `list-panes -F '#{pane_id} #{pane_index}'` output into {paneId, index} rows. */
export function parsePanes(stdout: string): { paneId: string; index: number }[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      const [paneId, index] = l.split(/\s+/);
      return { paneId, index: Number(index) };
    });
}

/**
 * Decide how orc should drive tmux: 'off' (disabled, non-TTY, or no binary → today's plain UI),
 * 'inside' (already in a tmux client — adopt the current window), or 'bootstrap' (launch our own
 * tmux session and re-exec into it).
 */
export function detectMode(opts: {
  disabled: boolean;
  isTTY: boolean;
  binaryAvailable: boolean;
  inTmux: boolean;
  isChild: boolean;
}): 'off' | 'bootstrap' | 'inside' {
  if (opts.disabled || !opts.isTTY || !opts.binaryAvailable) return 'off';
  if (opts.inTmux) return 'inside';
  return 'bootstrap';
}

/** Build the argv that re-execs orc inside the bootstrapped tmux session (with the child guard). */
export function buildReexecArgv(argv: string[], entry: string): string[] {
  const userArgs = argv.slice(2).filter((a) => a !== '--tmux-child');
  return [process.execPath, entry, ...userArgs, '--tmux-child'];
}

// --- Controller --------------------------------------------------------------------------------

/** The tmux surface AgentManager drives. Inert (undefined) when tmux is off or in tests. */
export interface Tmux {
  registerAgent(id: string, name: string, template: string): void;
  unregisterAgent(id: string): void;
  showAgent(id?: string): void;
  /**
   * Run a command live in the agent's viewer pane. Resolves to the captured output + exit code, or
   * null when the command can't be driven in-pane (agent not selected / no viewer pane / FIFO not
   * writable), signalling the caller to use its in-process fallback instead.
   */
  runInPane(
    agentId: string,
    cmd: string,
    signal: AbortSignal,
  ): Promise<{ output: string; rc: number } | null>;
}

const SESSION_NAME = 'orc';

export class TmuxController implements Tmux {
  private readonly run: TmuxRunner;
  private readonly logsDir: string;
  private readonly sessionName = SESSION_NAME;
  /** The agents whose FIFO + done/ids dirs we created, so we only tear down what we own. */
  private readonly registered = new Set<string>();

  private orcPaneId?: string;
  private viewPaneId?: string;
  /** The agent currently shown in the viewer pane — only it can run commands live in the pane. */
  private selectedId?: string;

  constructor(opts?: { run?: TmuxRunner; logsDir?: string }) {
    this.run = opts?.run ?? ((args) => execFileAsync('tmux', args));
    this.logsDir = opts?.logsDir ?? join(homedir(), '.orc', 'panes');
    mkdirSync(this.logsDir, { recursive: true });
  }

  /** Is tmux present and new enough (≥1.9) to drive? Never throws. */
  static async isAvailable(run?: TmuxRunner): Promise<boolean> {
    const r = run ?? ((args: string[]) => execFileAsync('tmux', args));
    try {
      const { stdout } = await r(['-V']);
      const m = stdout.match(/(\d+)\.(\d+)/);
      if (!m) return false;
      const major = Number(m[1]);
      const minor = Number(m[2]);
      return major > 1 || (major === 1 && minor >= 9);
    } catch {
      return false;
    }
  }

  /** Provision an agent's pane IPC: a FIFO the driver reads from, plus done/ids output dirs. */
  registerAgent(id: string, _name: string, _template: string): void {
    const fifo = paneFifoPath(this.logsDir, id);
    const doneDir = paneDoneDir(this.logsDir, id);
    const idsDir = paneIdsDir(this.logsDir, id);
    try {
      mkdirSync(doneDir, { recursive: true });
      mkdirSync(idsDir, { recursive: true });
      // mkfifo via the system binary (node has no direct API). Remove any stale node first.
      rmSync(fifo, { force: true });
      execFileSync('mkfifo', [fifo]);
    } catch {
      // Best-effort: a disk/mkfifo error here must not throw out of the AgentManager create path;
      // runInPane will simply fall back to the in-process runner when the FIFO isn't writable.
    }
    this.registered.add(id);
  }

  /** Remove an agent's FIFO and its done/ids dirs. */
  unregisterAgent(id: string): void {
    for (const p of [paneFifoPath(this.logsDir, id), paneDoneDir(this.logsDir, id), paneIdsDir(this.logsDir, id)]) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // Best-effort: a missing path is fine.
      }
    }
    this.registered.delete(id);
  }

  /**
   * Point the single viewer pane at the selected agent by respawning it running that agent's driver
   * loop (which services the agent's FIFO). No-op until the viewer pane is known.
   */
  showAgent(id?: string): void {
    this.selectedId = id;
    if (!this.viewPaneId || !id) return;
    const cmd = buildDriverScript({
      fifo: paneFifoPath(this.logsDir, id),
      doneDir: paneDoneDir(this.logsDir, id),
      idsDir: paneIdsDir(this.logsDir, id),
    });
    void this.run(argvRespawnViewer(this.viewPaneId, cmd)).catch(() => {});
  }

  /**
   * Run a command live in the selected agent's viewer pane: hand it to the pane driver via the FIFO,
   * then wait for the driver's done-file and read back the captured output. Returns null when the
   * command can't be driven in-pane (not selected / no viewer / FIFO not writable) so the caller
   * uses its in-process fallback.
   */
  async runInPane(
    agentId: string,
    cmd: string,
    signal: AbortSignal,
  ): Promise<{ output: string; rc: number } | null> {
    const fifo = paneFifoPath(this.logsDir, agentId);
    const where = decidePaneVsFallback({
      tmuxOn: Boolean(this.viewPaneId),
      isSelected: this.selectedId === agentId,
      fifoWritable: existsSync(fifo),
    });
    if (where === 'fallback') return null;

    const runId = randomUUID();
    const wrote = writeRunLine(fifo, encodeRunLine(runId, cmd));
    if (!wrote) return null; // No driver reading the FIFO → fall back.

    let rc: number;
    try {
      rc = await waitForDone(paneDoneDir(this.logsDir, agentId), runId, signal);
    } catch {
      // Aborted (or watch failure) → signal a cancel via the pane, then report a non-zero rc.
      if (this.viewPaneId) await this.run(argvSendInterrupt(this.viewPaneId)).catch(() => {});
      const output = this.readPaneOutput(agentId, runId);
      this.cleanupRunFiles(agentId, runId);
      return { output, rc: 130 };
    }
    const output = this.readPaneOutput(agentId, runId);
    this.cleanupRunFiles(agentId, runId);
    return { output, rc };
  }

  /** Read (and cap) a finished command's captured output from its per-id file. */
  private readPaneOutput(agentId: string, runId: string): string {
    try {
      return capOutput(readFileSync(join(paneIdsDir(this.logsDir, agentId), runId), 'utf8'));
    } catch {
      return '';
    }
  }

  /** Best-effort removal of a command's per-id output + done files; they only bridge one command. */
  private cleanupRunFiles(agentId: string, runId: string): void {
    const doneDir = paneDoneDir(this.logsDir, agentId);
    const paths = [
      join(paneIdsDir(this.logsDir, agentId), runId),
      join(doneDir, runId),
      join(doneDir, `.${runId}.tmp`),
    ];
    for (const p of paths) {
      try {
        rmSync(p, { force: true });
      } catch {
        // Best-effort: a missing file is fine.
      }
    }
  }

  /**
   * BOOTSTRAP-CHILD case: the session is the one orc created (named `orc`), already split by
   * bootstrapAndReexec into left = orc's TUI at index 0 and right = the viewer at index 1. Discover
   * those pane ids so showAgent() knows which pane to respawn. Best-effort; leaves the ids unset on
   * any failure. The `orc:0` default only holds for the session orc owns — true inside mode (a
   * pre-existing session with any name) must use adoptInside() instead.
   */
  async adopt(target: string = this.sessionName + ':0'): Promise<void> {
    try {
      const { stdout } = await this.run(argvListPanes(target));
      const panes = parsePanes(stdout);
      const orc = panes.find((p) => p.index === 0);
      const view = panes.find((p) => p.index === 1);
      if (orc) this.orcPaneId = orc.paneId;
      if (view) this.viewPaneId = view.paneId;
    } catch {
      // Best-effort discovery; a tmux hiccup must never crash orc.
    }
  }

  /**
   * TRUE INSIDE case: orc was launched inside the user's own tmux (any session name). We must not
   * assume the `orc:0` window nor ever respawn a pane the user owns. Instead: take the current pane
   * ($TMUX_PANE) as orc's own pane, then split OUR OWN viewer pane to its right and capture the new
   * pane id — that is the only pane showAgent() may respawn. On any failure (no $TMUX_PANE, split
   * fails, no pane id returned) we leave viewPaneId unset so showAgent() stays a safe no-op.
   */
  async adoptInside(currentPane: string | undefined = process.env.TMUX_PANE): Promise<void> {
    try {
      // Resolve orc's own pane: prefer $TMUX_PANE, else ask tmux for the active pane id.
      let orcPane = currentPane;
      if (!orcPane) {
        const { stdout } = await this.run(argvDisplayMessage('#{pane_id}'));
        orcPane = stdout.trim() || undefined;
      }
      if (!orcPane) return; // Can't identify our pane → stay a no-op; never touch unknown panes.

      // Split OUR OWN viewer pane off orc's pane and capture the brand-new pane's id.
      const { stdout } = await this.run(argvSplitRightPrint(orcPane));
      const viewPane = stdout.trim();
      if (!viewPane) return; // No pane created → leave viewPaneId unset (safe no-op).

      this.orcPaneId = orcPane;
      this.viewPaneId = viewPane;
    } catch {
      // Best-effort discovery; a tmux hiccup must never crash orc and must not leave a half-set
      // viewPaneId pointing at a pane orc doesn't own.
    }
  }

  /**
   * From a plain TTY: create (or recreate) the orc tmux session, split a viewer pane to the right,
   * hide the status bar, select the left pane, and attach — re-execing orc as the --tmux-child in
   * the left pane. Replaces the current process via attach; never returns on success.
   */
  async bootstrapAndReexec(reexecArgv: string[]): Promise<never> {
    try {
      await this.run(argvHasSession(this.sessionName));
      await this.run(argvKillSession(this.sessionName));
    } catch {
      // No stale session — nothing to kill.
    }
    await this.run(argvNewSession(this.sessionName, reexecArgv));
    await this.run(argvSplitRight(this.sessionName + ':0'));
    await this.run(argvStatusOff(this.sessionName));
    await this.run(argvSelectPane(this.sessionName + ':0.0'));
    // Attach inherits the terminal so the human sees the tmux session; blocks until detach/exit.
    execFileSync('tmux', argvAttach(this.sessionName), { stdio: 'inherit' });
    process.exit(0);
  }

  /** Tear down what we own: the whole session when we bootstrapped, else just our viewer pane. */
  async shutdown(): Promise<void> {
    this.cleanupPaneIpc();
    if (this.orcPaneId || this.viewPaneId) {
      if (this.viewPaneId) await this.run(argvKillPane(this.viewPaneId)).catch(() => {});
    } else {
      await this.run(argvKillSession(this.sessionName)).catch(() => {});
    }
  }

  /** Synchronous teardown for signal handlers (a never-attached controller is a no-op). */
  shutdownSync(): void {
    this.cleanupPaneIpc();
    try {
      if (this.viewPaneId) {
        execFileSync('tmux', argvKillPane(this.viewPaneId), { stdio: 'ignore' });
      } else if (this.orcPaneId) {
        execFileSync('tmux', argvKillSession(this.sessionName), { stdio: 'ignore' });
      }
    } catch {
      // Best-effort on exit.
    }
  }

  /** Remove every agent's FIFO + done/ids dirs we created. Best-effort. */
  private cleanupPaneIpc(): void {
    for (const id of [...this.registered]) this.unregisterAgent(id);
  }
}
