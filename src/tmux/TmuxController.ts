import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  encodeInjectedCommand,
  waitForCapture,
  capOutput,
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

/**
 * The file `tmux pipe-pane` mirrors a shell's output into (for run capture). Each agent shell has its
 * own capture file keyed by a shell index; shell 0 keeps the historical `<slug>.cap` name.
 */
export function paneCapturePath(logsDir: string, id: string, shellIdx = 0): string {
  const base = paneSlug(id);
  return join(logsDir, shellIdx === 0 ? base + '.cap' : `${base}.${shellIdx}.cap`);
}

/** The tmux window name that hosts an agent's long-lived interactive shell. */
export function agentWindowName(id: string): string {
  return 'orc-agent-' + paneSlug(id);
}

// --- argv builders --------------------------------------------------------------------------------

/** Capture a pane's output to a shell command (`-o` = only while a program is running). */
export function argvPipePane(paneId: string, cmd: string): string[] {
  return ['pipe-pane', '-o', '-t', paneId, cmd];
}

/** Send Ctrl+C to a pane (cancels only the command currently running in it). */
export function argvSendInterrupt(paneId: string): string[] {
  return ['send-keys', '-t', paneId, 'C-c'];
}

/** Send a literal string to a pane (tmux does not interpret it as key names). */
export function argvSendKeysLiteral(paneId: string, text: string): string[] {
  return ['send-keys', '-t', paneId, '-l', text];
}

/** Press Enter in a pane (submit the current input line). */
export function argvSendKeysEnter(paneId: string): string[] {
  return ['send-keys', '-t', paneId, 'Enter'];
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

/**
 * Create a detached background window running `cmd` in `cwd`, printing the new window's pane id so we
 * can drive it later. This is where each agent's long-lived interactive shell lives until it is
 * joined beside the TUI on selection.
 */
export function argvNewWindow(session: string, name: string, cwd: string, cmd: string): string[] {
  return ['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', session, '-n', name, '-c', cwd, cmd];
}

/** Break a pane out of its current window into its own (detached) window — preserves the process. */
export function argvBreakPane(srcPaneId: string): string[] {
  return ['break-pane', '-d', '-s', srcPaneId];
}

/**
 * Break a pane out into its own detached window with a given name — preserves the process and keeps
 * the window name stable so later kill-window / join-pane calls can find the agent's window again.
 */
export function argvBreakPaneNamed(srcPaneId: string, windowName: string): string[] {
  return ['break-pane', '-d', '-s', srcPaneId, '-n', windowName];
}

/** Join a pane horizontally to the right of a target pane — moves the live pane, never restarts it. */
export function argvJoinPane(srcPaneId: string, dstPaneId: string): string[] {
  return ['join-pane', '-h', '-s', srcPaneId, '-t', dstPaneId];
}

/** Split a pane horizontally and print the new pane's id (`-P -F '#{pane_id}'`) so we can capture it. */
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

export function argvKillPane(paneId: string): string[] {
  return ['kill-pane', '-t', paneId];
}

export function argvKillWindow(target: string): string[] {
  return ['kill-window', '-t', target];
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
  registerAgent(id: string, name: string, template: string, cwd: string): void;
  unregisterAgent(id: string): void;
  showAgent(id?: string): void;
  /**
   * Run a command live in the agent's interactive shell pane. Resolves to the captured output + exit
   * code, or null when the command can't be driven in-pane (agent not selected / not on the stage /
   * no capture), signalling the caller to use its in-process fallback instead.
   */
  runInPane(
    agentId: string,
    cmd: string,
    signal: AbortSignal,
  ): Promise<{ output: string; rc: number } | null>;
}

const SESSION_NAME = 'orc';

/** One interactive shell of an agent: its tmux pane, its capture file, and whether a run holds it. */
interface Shell {
  paneId: string;
  idx: number;
  capturePath: string;
  busy: boolean;
}

export class TmuxController implements Tmux {
  private readonly run: TmuxRunner;
  private readonly logsDir: string;
  private readonly sessionName = SESSION_NAME;

  /** orc's own TUI pane — the stage's left anchor; agent shells join to its right. */
  private orcPaneId?: string;
  /**
   * Each agent owns ONE tmux window that may hold SEVERAL interactive shells (panes). An agent can
   * run commands concurrently: each run reuses an idle shell or, when all are busy, splits a new one.
   * The whole window is joined/broken onto the stage so all of an agent's shells show together.
   */
  private readonly agentPanes = new Map<string, { window: string; shells: Shell[] }>();
  /** Most shells an agent may open, to bound runaway `split-window`s. */
  private readonly maxShellsPerAgent = 4;
  /** The agent whose shells are currently joined beside the TUI (occupies the stage). */
  private stageOccupantId?: string;
  /** The agent currently selected in the TUI. */
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

  /**
   * Provision an agent's first long-lived interactive shell: a detached background window running
   * `zsh -if` in the agent's worktree, plus a pipe-pane capture of that shell's output (so runInPane
   * can read back a command's result). Additional shells are split on demand by acquireShell. zsh is
   * launched with `-f` (skip rc files) so there's no startup banner or user-config noise.
   * Best-effort — any failure leaves the agent paneless and runInPane falls back to the in-process
   * runner.
   */
  registerAgent(id: string, _name: string, _template: string, cwd: string): void {
    const capture = paneCapturePath(this.logsDir, id, 0);
    try {
      // Start the capture file empty so a prior run's leftovers never match a new run's sentinels.
      writeFileSync(capture, '');
    } catch {
      /* best-effort */
    }
    const window = agentWindowName(id);
    void (async () => {
      try {
        const { stdout } = await this.run(
          argvNewWindow(this.sessionName, window, cwd, 'exec zsh -if'),
        );
        const paneId = stdout.trim();
        if (!paneId) return;
        this.agentPanes.set(id, {
          window,
          shells: [{ paneId, idx: 0, capturePath: capture, busy: false }],
        });
        // Mirror the shell's output into the capture file so runInPane can find a command's frame.
        await this.run(argvPipePane(paneId, `cat >> ${shq(capture)}`)).catch(() => {});
        // If this agent is already the selected one (fast create+select), reveal it now.
        if (this.selectedId === id) this.showAgent(id);
      } catch {
        /* best-effort: no window → runInPane falls back in-process */
      }
    })();
  }

  /**
   * Return an idle shell for the agent, or split a new one when all are busy (up to maxShellsPerAgent).
   * The new pane is split inside the agent's window and gets its own capture file + pipe-pane. Returns
   * null when the agent has no window yet or the shell cap is reached with every shell busy.
   */
  private async acquireShell(agentId: string): Promise<Shell | null> {
    const entry = this.agentPanes.get(agentId);
    if (!entry) return null;
    // Reserve the shell by marking it busy BEFORE any await, so two concurrent runs can't grab the
    // same idle shell across a microtask boundary.
    const idle = entry.shells.find((s) => !s.busy);
    if (idle) {
      idle.busy = true;
      return idle;
    }
    if (entry.shells.length >= this.maxShellsPerAgent) return null;
    // All shells busy and under the cap → split a new pane beside the agent's last shell.
    const anchor = entry.shells[entry.shells.length - 1];
    try {
      const { stdout } = await this.run(argvSplitRightPrint(anchor.paneId));
      const paneId = stdout.trim();
      if (!paneId) return null;
      const idx = entry.shells.length;
      const capturePath = paneCapturePath(this.logsDir, agentId, idx);
      try {
        writeFileSync(capturePath, '');
      } catch {
        /* best-effort */
      }
      await this.run(argvPipePane(paneId, `cat >> ${shq(capturePath)}`)).catch(() => {});
      const shell: Shell = { paneId, idx, capturePath, busy: true };
      entry.shells.push(shell);
      // A fresh split steals focus; pull it back to the TUI so the human keeps driving orc.
      if (this.orcPaneId) await this.run(argvSelectPane(this.orcPaneId)).catch(() => {});
      return shell;
    } catch {
      return null;
    }
  }

  /** Kill an agent's shell window (all its panes) and remove every per-shell capture file. */
  unregisterAgent(id: string): void {
    const entry = this.agentPanes.get(id);
    if (entry) {
      // If it's currently on the stage, it will be killed with its window; clear the slot first.
      if (this.stageOccupantId === id) this.stageOccupantId = undefined;
      void this.run(argvKillWindow(entry.window)).catch(() => {});
      for (const shell of entry.shells) {
        try {
          rmSync(shell.capturePath, { force: true });
        } catch {
          /* best-effort */
        }
      }
      this.agentPanes.delete(id);
    }
    // Also remove the primary capture file in case the window never finished registering.
    try {
      rmSync(paneCapturePath(this.logsDir, id, 0), { force: true });
    } catch {
      /* best-effort */
    }
  }

  /**
   * Reveal the selected agent's shell beside the TUI without stealing focus. Breaks the previous
   * occupant back to its own (detached) window — preserving its shell + scrollback — then joins the
   * selected agent's live shell to the right of orc's pane and re-selects orc's pane so the human
   * keeps driving the TUI. No-op until orc's pane is known or the agent has no shell yet.
   */
  showAgent(id?: string): void {
    this.selectedId = id;
    if (!this.orcPaneId || !id) return;
    const entry = this.agentPanes.get(id);
    if (!entry) return; // shell not created yet; registerAgent re-calls showAgent once it exists
    if (this.stageOccupantId === id) {
      // Already shown — just make sure focus is on the TUI.
      void this.run(argvSelectPane(this.orcPaneId)).catch(() => {});
      return;
    }
    const prev = this.stageOccupantId ? this.agentPanes.get(this.stageOccupantId) : undefined;
    const orcPane = this.orcPaneId;
    void (async () => {
      try {
        // Break the previous occupant's shells back to its own window (preserved, not killed). The
        // first break re-creates the window; the rest rejoin it so all its shells stay grouped.
        if (prev) {
          for (let i = 0; i < prev.shells.length; i++) {
            const s = prev.shells[i];
            if (i === 0) {
              await this.run(argvBreakPaneNamed(s.paneId, prev.window)).catch(() => {});
            } else {
              await this.run(argvJoinPane(s.paneId, prev.shells[0].paneId)).catch(() => {});
            }
          }
        }
        // Join this agent's shells beside orc: the first anchors the stage region, the rest tile
        // within it (joined to the first shell, not to orc, so they stack beside each other).
        for (let i = 0; i < entry.shells.length; i++) {
          const s = entry.shells[i];
          const target = i === 0 ? orcPane : entry.shells[0].paneId;
          await this.run(argvJoinPane(s.paneId, target));
        }
        this.stageOccupantId = id;
        // join-pane focuses the joined pane; pull focus back to the TUI (requirement: focus on orc).
        await this.run(argvSelectPane(orcPane)).catch(() => {});
      } catch {
        /* a tmux hiccup must never crash orc */
      }
    })();
  }

  /**
   * Run a command live in one of the selected agent's interactive shells: acquire an idle shell (or
   * split a new one when all are busy), inject the framed command via send-keys, wait for its frame
   * to appear in that shell's capture file, and read back the captured output + exit code. Multiple
   * concurrent calls use distinct shells, so an agent can run e.g. `yarn start` and `yarn ios` at the
   * same time. Returns null when the command can't be driven in-pane (agent not selected / not on the
   * stage / no shell free) so the caller uses its in-process fallback.
   */
  async runInPane(
    agentId: string,
    cmd: string,
    signal: AbortSignal,
  ): Promise<{ output: string; rc: number } | null> {
    const entry = this.agentPanes.get(agentId);
    if (!entry || this.selectedId !== agentId || this.stageOccupantId !== agentId) return null;

    const shell = await this.acquireShell(agentId);
    if (!shell) return null; // all shells busy and at the cap → fall back in-process (acquire marks it busy)

    const fromOffset = this.fileSize(shell.capturePath);
    const runId = randomUUID();
    const line = encodeInjectedCommand(runId, cmd);
    try {
      await this.run(argvSendKeysLiteral(shell.paneId, line));
      await this.run(argvSendKeysEnter(shell.paneId));
    } catch {
      shell.busy = false;
      return null; // couldn't inject → fall back
    }

    try {
      const res = await waitForCapture(shell.capturePath, runId, fromOffset, signal);
      return { output: capOutput(res.output), rc: res.rc };
    } catch {
      // Aborted (or watch failure) → interrupt the running command, report cancel.
      await this.run(argvSendInterrupt(shell.paneId)).catch(() => {});
      return { output: '', rc: 130 };
    } finally {
      shell.busy = false;
    }
  }

  /** Current byte length of a file, or 0 when it doesn't exist. */
  private fileSize(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  /**
   * BOOTSTRAP-CHILD case: the session is the one orc created (named `orc`). bootstrapAndReexec left
   * orc's TUI as the only pane of window 0; discover its pane id so showAgent knows the stage anchor.
   * Best-effort; leaves orcPaneId unset on any failure (showAgent stays a no-op).
   */
  async adopt(target: string = this.sessionName + ':0'): Promise<void> {
    try {
      const { stdout } = await this.run(argvListPanes(target));
      const panes = parsePanes(stdout);
      const orc = panes.find((p) => p.index === 0);
      if (orc) this.orcPaneId = orc.paneId;
    } catch {
      // Best-effort discovery; a tmux hiccup must never crash orc.
    }
  }

  /**
   * TRUE INSIDE case: orc was launched inside the user's own tmux (any session name). We take the
   * current pane ($TMUX_PANE) as orc's own pane — the stage anchor agent shells join beside. We do NOT
   * split or respawn anything the user owns; agent shells live in their own windows and are joined on
   * demand. On failure (no $TMUX_PANE) we leave orcPaneId unset so showAgent stays a safe no-op.
   */
  async adoptInside(currentPane: string | undefined = process.env.TMUX_PANE): Promise<void> {
    try {
      let orcPane = currentPane;
      if (!orcPane) {
        const { stdout } = await this.run(argvDisplayMessage('#{pane_id}'));
        orcPane = stdout.trim() || undefined;
      }
      if (!orcPane) return; // Can't identify our pane → stay a no-op.
      this.orcPaneId = orcPane;
    } catch {
      // Best-effort discovery; a tmux hiccup must never crash orc.
    }
  }

  /**
   * From a plain TTY: create (or recreate) the orc tmux session with the TUI as window 0's only pane,
   * hide the status bar, and attach — re-execing orc as the --tmux-child in that pane. Agent shells
   * are joined beside it on demand. Replaces the current process via attach; never returns on success.
   */
  async bootstrapAndReexec(reexecArgv: string[]): Promise<never> {
    try {
      await this.run(argvHasSession(this.sessionName));
      await this.run(argvKillSession(this.sessionName));
    } catch {
      // No stale session — nothing to kill.
    }
    await this.run(argvNewSession(this.sessionName, reexecArgv));
    await this.run(argvStatusOff(this.sessionName));
    // Attach inherits the terminal so the human sees the tmux session; blocks until detach/exit.
    execFileSync('tmux', argvAttach(this.sessionName), { stdio: 'inherit' });
    process.exit(0);
  }

  /** Tear down what we own: the whole session when we bootstrapped, else just our agent windows. */
  async shutdown(): Promise<void> {
    for (const id of [...this.agentPanes.keys()]) this.unregisterAgent(id);
    // When we bootstrapped the session, kill it outright; inside the user's tmux we only owned the
    // agent windows (just removed) and must never kill the user's session.
    await this.run(argvHasSession(this.sessionName))
      .then(() => this.run(argvKillSession(this.sessionName)))
      .catch(() => {});
  }

  /** Synchronous teardown for signal handlers (a never-attached controller is a no-op). */
  shutdownSync(): void {
    for (const entry of this.agentPanes.values()) {
      try {
        execFileSync('tmux', argvKillWindow(entry.window), { stdio: 'ignore' });
      } catch {
        /* best-effort */
      }
      for (const shell of entry.shells) {
        try {
          rmSync(shell.capturePath, { force: true });
        } catch {
          /* best-effort */
        }
      }
    }
    this.agentPanes.clear();
  }
}

/** Single-quote a path for safe embedding in a pipe-pane shell command. */
function shq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}
