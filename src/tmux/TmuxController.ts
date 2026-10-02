import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { LogEntry } from '../types.js';
import {
  type MirrorState,
  INITIAL_MIRROR_STATE,
  computeMirrorAppend,
} from '../ui/logFormat.js';

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

/** The shell command the viewer pane runs to follow an agent's pane log from the top. */
export function viewerTailCommand(logPath: string): string {
  return `exec tail -n +1 -F '${logPath}'`;
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
  mirror(id: string, events: readonly LogEntry[]): void;
  showAgent(id?: string): void;
}

const SESSION_NAME = 'orc';

export class TmuxController implements Tmux {
  private readonly run: TmuxRunner;
  private readonly logsDir: string;
  private readonly sessionName = SESSION_NAME;
  private readonly mirrorStates = new Map<string, MirrorState>();

  private orcPaneId?: string;
  private viewPaneId?: string;

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

  /** Create/truncate an agent's pane-log file so the viewer always has something to tail. */
  registerAgent(id: string, _name: string, _template: string): void {
    const path = paneLogPath(this.logsDir, id);
    // Create/truncate to an empty file so the viewer has something to tail and a relaunch starts
    // the mirror fresh. (Kept empty so the mirror's appends are the file's entire content.)
    writeFileSync(path, '');
    this.mirrorStates.set(id, { ...INITIAL_MIRROR_STATE });
  }

  /** Remove an agent's pane-log file and drop its mirror state. */
  unregisterAgent(id: string): void {
    const path = paneLogPath(this.logsDir, id);
    try {
      rmSync(path, { force: true });
    } catch {
      // Best-effort: a missing file is fine.
    }
    this.mirrorStates.delete(id);
  }

  /** Append the newly-rendered tail of an agent's events to its pane log (idempotent per id). */
  mirror(id: string, events: readonly LogEntry[]): void {
    const prev = this.mirrorStates.get(id) ?? { ...INITIAL_MIRROR_STATE };
    const { text, state } = computeMirrorAppend(prev, events);
    if (text) appendFileSync(paneLogPath(this.logsDir, id), text);
    this.mirrorStates.set(id, state);
  }

  /** Re-point the single viewer pane at the selected agent's pane log. No-op until panes are known. */
  showAgent(id?: string): void {
    if (!this.viewPaneId) return;
    const path = id ? paneLogPath(this.logsDir, id) : join(this.logsDir, '_none.log');
    if (!id) {
      try {
        writeFileSync(path, '');
      } catch {
        // Placeholder is best-effort.
      }
    }
    const cmd = viewerTailCommand(path);
    void this.run(argvRespawnViewer(this.viewPaneId, cmd)).catch(() => {});
  }

  /**
   * Discover orc's window panes (left = orc's TUI at index 0, right = the viewer at index 1) so
   * showAgent() knows which pane to respawn. Best-effort; leaves the ids unset on any failure.
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
    if (this.orcPaneId || this.viewPaneId) {
      if (this.viewPaneId) await this.run(argvKillPane(this.viewPaneId)).catch(() => {});
    } else {
      await this.run(argvKillSession(this.sessionName)).catch(() => {});
    }
  }

  /** Synchronous teardown for signal handlers (a never-attached controller is a no-op). */
  shutdownSync(): void {
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
}
