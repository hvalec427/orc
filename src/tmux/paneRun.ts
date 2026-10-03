import * as fs from 'node:fs';
import { dirname } from 'node:path';

/**
 * Pane command protocol + capture helpers.
 *
 * Each agent owns one or more long-lived INTERACTIVE shells (`zsh -if`) in its own tmux panes, so the
 * human can type into them directly. The agent's `mcp__orc__run` tool injects a command into one such
 * shell via
 * `tmux send-keys`, wrapping it in unique sentinel lines so orc can later find exactly that command's
 * combined output and exit code in the pane's capture stream — without disturbing the human's own
 * typing, which simply interleaves as ordinary shell input.
 *
 * The pane's output is mirrored to a per-agent capture file via `tmux pipe-pane`. A run is framed as:
 *
 *   <<<ORC-BEGIN runId>>>
 *   ...the command's combined stdout/stderr...
 *   <<<ORC-END runId rc>>>
 *
 * parseCapturedRun() extracts the text between the BEGIN/END markers and the rc from the END marker.
 */

const BEGIN_PREFIX = '<<<ORC-BEGIN ';
const BEGIN_SUFFIX = '>>>';

/** The exact BEGIN sentinel line (no newline) for a run id. */
export function beginSentinel(runId: string): string {
  return `${BEGIN_PREFIX}${runId}${BEGIN_SUFFIX}`;
}

/** A regex matching this run's END sentinel line and capturing its rc: `<<<ORC-END runId rc>>>`. */
export function endSentinelRe(runId: string): RegExp {
  // runId is a UUID (safe chars), but escape defensively so a odd id can't alter the pattern.
  const esc = runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<<<ORC-END ${esc} (-?\\d+)>>>`);
}

/**
 * Build the single shell line orc types into the agent's interactive shell to run `cmd`. The shell
 * echoes this whole line back, which would be noisy, so the line first erases that echoed input
 * (`\r\033[K`) and prints a clean `$ <cmd>` banner for the human to read. It then prints the BEGIN
 * sentinel, runs the command in a subshell (so a bare `exit`/`cd` can't wreck the long-lived shell),
 * and prints the END sentinel with the command's exit code. The sentinels remain in the capture
 * stream so parseCapturedRun can find the output; stripControl drops the erase sequence from the
 * captured text. Sent to tmux with `send-keys -l` (literal), so none of these characters are
 * interpreted by tmux itself.
 */
export function encodeInjectedCommand(runId: string, cmd: string): string {
  const begin = beginSentinel(runId);
  // `\r\033[K` returns to column 0 and clears the echoed wrapper line; then a clean `$ <cmd>` banner.
  // The leading newlines on the sentinel printfs keep each sentinel on its own line even if the human
  // left a half-typed line in the prompt.
  return (
    `printf '\\r\\033[K$ %s\\n' ${shq(cmd)}; ` +
    `printf '%s\\n' ${shq(begin)}; ` +
    `( ${cmd} ); __orc_rc=$?; ` +
    `printf '\\n<<<ORC-END %s %s>>>\\n' ${shq(runId)} "$__orc_rc"`
  );
}

/** Single-quote a string for safe embedding in a bash command line. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Strip terminal control sequences a `pipe-pane` capture can contain (CR, ANSI/CSI escapes) so the
 * extracted output reads like plain text. Best-effort: leaves ordinary text untouched.
 */
function stripControl(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI escapes
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '') // OSC escapes
    .replace(/\r/g, '');
}

/**
 * Find this run's framed output in a capture buffer. Returns the text between the BEGIN and END
 * sentinels (control sequences stripped) plus the parsed rc, or null when the END sentinel for this
 * run has not been captured yet. `fromOffset` ignores anything before a known starting point (a prior
 * run's identical-id frame can't exist — ids are unique — but a stale partial can, so we honor it).
 */
export function parseCapturedRun(
  buf: string,
  runId: string,
  fromOffset = 0,
): { output: string; rc: number } | null {
  const hay = fromOffset > 0 ? buf.slice(fromOffset) : buf;
  const begin = beginSentinel(runId);
  const bIdx = hay.indexOf(begin);
  if (bIdx < 0) return null;
  const afterBegin = bIdx + begin.length;
  const endRe = endSentinelRe(runId);
  const m = endRe.exec(hay.slice(afterBegin));
  if (!m) return null; // command still running (no END captured yet)
  const rc = parseRc(m[1]);
  const between = hay.slice(afterBegin, afterBegin + m.index);
  // Drop the leading newline left by the BEGIN printf and any trailing newline before END.
  const output = stripControl(between).replace(/^\n/, '').replace(/\n$/, '');
  return { output, rc };
}

/** Parse an rc token; non-numeric → -1 sentinel. */
export function parseRc(raw: string): number {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isNaN(n) ? -1 : n;
}

/** Cap captured output: under `max` unchanged, over → head + elision marker + tail. */
export function capOutput(text: string, max = 32768): string {
  if (text.length <= max) return text;
  const marker = '\n…[output truncated]…\n';
  const keep = Math.floor(max / 2);
  const head = text.slice(0, keep);
  const tail = text.slice(text.length - keep);
  return head + marker + tail;
}

/**
 * Slice an agent's pane-log buffer for a reader. `full` is the whole current buffer; `size` is its
 * length. When `sinceOffset` is given, return only the bytes after it (incremental polling); a stale
 * offset past the end yields empty text. Otherwise return the last `tailBytes` (a recent snapshot).
 * Always reports `nextOffset = size` so the caller can poll again from where this read ended.
 */
export function slicePaneText(
  full: string,
  opts: { tailBytes?: number; sinceOffset?: number } = {},
): { text: string; size: number; nextOffset: number } {
  const size = full.length;
  if (opts.sinceOffset !== undefined) {
    const from = Math.max(0, Math.min(opts.sinceOffset, size));
    return { text: full.slice(from), size, nextOffset: size };
  }
  const tail = opts.tailBytes ?? 8192;
  const text = tail >= size ? full : full.slice(size - tail);
  return { text, size, nextOffset: size };
}

/**
 * Resolve with a run's `{ output, rc }` once its END sentinel appears in the capture file, rejecting
 * with an AbortError when `signal` aborts. Watches the capture file's directory plus a ~100ms poll as
 * a safety net. `fromOffset` is where in the (growing) capture file this run's frame begins.
 */
export function waitForCapture(
  capturePath: string,
  runId: string,
  fromOffset: number,
  signal: AbortSignal,
): Promise<{ output: string; rc: number }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let watcher: fs.FSWatcher | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      if (watcher) {
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
      }
      if (poll) clearInterval(poll);
      signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    };

    const check = () => {
      if (settled) return;
      let buf: string;
      try {
        buf = fs.readFileSync(capturePath, 'utf8');
      } catch {
        return; // capture file not there yet
      }
      const res = parseCapturedRun(buf, runId, fromOffset);
      if (!res) return; // END not captured yet
      settled = true;
      cleanup();
      resolve(res);
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort);

    try {
      // Watch the containing dir: the capture file may not exist at the first instant.
      watcher = fs.watch(dirname(capturePath), () => check());
    } catch {
      /* dir may not be watchable everywhere; poll covers it */
    }
    poll = setInterval(check, 100);
    check(); // catch the case where the frame is already complete
  });
}
