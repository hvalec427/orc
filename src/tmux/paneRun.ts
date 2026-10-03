import * as fs from 'node:fs';
import { dirname } from 'node:path';

/**
 * Pane command protocol + capture helpers.
 *
 * Each agent owns one or more long-lived INTERACTIVE shells (`zsh -if`) in its own tmux panes, so the
 * human can type into them directly. The agent's `mcp__orc__run` tool runs a command in one such shell
 * WITHOUT polluting the pane with wrapper/plumbing noise: the human sees only a clean `$ <cmd>` banner
 * followed by the command's own output, exactly as if they had typed it.
 *
 * How that is achieved — and why the obvious approaches don't work:
 *
 *   The pane runs an INTERACTIVE zsh. Its line editor (ZLE) echoes whatever `send-keys` injects and
 *   redraws the prompt around it — and ZLE's echo is NOT governed by `stty -echo`, so trying to mute
 *   the tty can't hide an injected wrapper line. Any long wrapper we type is therefore shown verbatim.
 *
 * So instead of typing a long wrapper, orc:
 *   1. Installs a tiny `__orc_run` shell function, blanks the prompt, and records the agent's run
 *      directory in `$__ORC_DIR` ONCE at shell startup (buildSetupScript). The only noise this leaves
 *      is its own one-time echo, which orc clears right after installing it.
 *   2. For each run, writes the command text to `<__ORC_DIR>/<token>.cmd` and injects only a SHORT
 *      call: `__orc_run <token>` (encodeInjectedCall). A bare short token NEVER wraps across terminal
 *      rows, so the function can reliably erase its single echoed line (cursor-up + clear) before
 *      printing the clean banner. Passing long file paths as args would wrap and defeat that erase.
 *   3. `__orc_run` derives the cmd/result paths from `$__ORC_DIR` + token, prints `$ <cmd>` to the
 *      PANE, runs the command so its output shows in the pane, and writes the framed result — BEGIN/END
 *      sentinels + the command's combined output — to the RESULT FILE orc reads. The sentinels never
 *      touch the pane, so the human never sees them.
 *
 * The result file is framed as:
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
 * The one-time setup orc types into a freshly created agent shell. It:
 *   - blanks the prompt (PROMPT/RPROMPT/PS2) and disables zsh's prompt CR/space padding, so no
 *     `host%`-style prompt noise ever appears in the pane;
 *   - records the agent's run directory in `$__ORC_DIR` so the per-run call can stay a bare token; and
 *   - defines the `__orc_run` function orc calls for every subsequent command.
 *
 * `__orc_run <token>` (paths derived as `$__ORC_DIR/<token>.cmd` and `.res`):
 *   - reads the command text from the cmd file (so the long/odd command text never goes through ZLE);
 *   - erases the single echoed line of its own call (cursor-up, CR, clear-to-EOL) — reliable because
 *     the call is a bare short token that never wraps — then prints a clean `$ <cmd>` banner to the pane;
 *   - runs the command via `eval` and tees its combined stdout/stderr to the result file AND the pane;
 *   - writes the BEGIN/END sentinels and the command's exit code to the result file ONLY (never the
 *     pane), bracketing the tee'd output so parseCapturedRun can recover exactly this run's output + rc.
 *
 * Sent to the shell with `send-keys -l` (literal). `eval` runs in the interactive shell itself (not a
 * subshell) so `cd`/env changes the human expects from typing a command persist; the shell is `-f` (no
 * rc files) so there's no banner. `dir` is single-quoted into the assignment of `$__ORC_DIR`.
 */
export function buildSetupScript(dir: string): string {
  // Kept to a single line so it is one submitted command. `${pipestatus[1]}` is the command's rc
  // (first element of the zsh pipe status array), not tee's. The cmd/result paths are derived inside
  // the function from `$__ORC_DIR` + the token, so the per-run call orc injects stays a bare token.
  return (
    `setopt no_prompt_cr no_prompt_sp 2>/dev/null; PROMPT='' RPROMPT='' PS2=''; ` +
    `__ORC_DIR=${shq(dir)}; ` +
    `__orc_run() { ` +
    `local __orc_tok=$1; ` +
    `local __orc_cmdf="$__ORC_DIR/$__orc_tok.cmd" __orc_resf="$__ORC_DIR/$__orc_tok.res"; ` +
    `local __orc_cmd; __orc_cmd=$(cat "$__orc_cmdf"); ` +
    `printf '\\033[A\\r\\033[K'; ` +
    `print -r -- "$ $__orc_cmd"; ` +
    `print -r -- "<<<ORC-BEGIN $__orc_tok>>>" >> "$__orc_resf"; ` +
    `{ eval "$__orc_cmd" } 2>&1 | tee -a "$__orc_resf"; ` +
    `local __orc_rc=\${pipestatus[1]}; ` +
    `print -r -- "<<<ORC-END $__orc_tok $__orc_rc>>>" >> "$__orc_resf"; ` +
    `}`
  );
}

/**
 * Build the SHORT line orc types into the agent's shell to run one command: a bare call to the
 * pre-installed `__orc_run` with just this run's token. Being a single short token it never wraps across
 * terminal rows, so `__orc_run` can reliably erase its one echoed line before printing the clean banner.
 * The command text and the cmd/result file paths live elsewhere (staged by orc, derived from
 * `$__ORC_DIR`), so nothing long or quoted ever passes through tmux or the line editor.
 */
export function encodeInjectedCall(token: string): string {
  return `__orc_run ${shq(token)}`;
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
