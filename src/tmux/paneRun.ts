import * as fs from 'node:fs';
import { join } from 'node:path';

/**
 * Pane command protocol + driver helpers.
 *
 * The tmux viewer pane runs a long-lived bash "driver" loop (buildDriverScript) that reads one
 * command per line from a FIFO. Each line is `<id> <base64-of-command>` so arbitrary command text
 * (newlines, quotes, unicode) survives transport. The driver runs the command, captures its combined
 * output to `$IDS/$id`, and writes the exit code atomically to `$DONE/$id`.
 */

/** Encode one command as a single FIFO line: `<id> <base64>\n`. */
export function encodeRunLine(id: string, cmd: string): string {
  return `${id} ${Buffer.from(cmd, 'utf8').toString('base64')}\n`;
}

/** Decode a single FIFO payload line (no trailing newline). Blank/malformed → null. */
export function decodeRunLine(line: string): { id: string; cmd: string } | null {
  if (!line || line.trim() === '') return null;
  const sp = line.indexOf(' ');
  if (sp <= 0) return null;
  const id = line.slice(0, sp);
  const b64 = line.slice(sp + 1);
  if (b64 === '') return null;
  try {
    const cmd = Buffer.from(b64, 'base64').toString('utf8');
    return { id, cmd };
  } catch {
    return null;
  }
}

/** Single-quote a path for safe embedding in the bash driver script. */
function shq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Build the long-lived bash driver loop that services the FIFO. */
export function buildDriverScript(opts: { fifo: string; doneDir: string; idsDir: string }): string {
  const fifo = shq(opts.fifo);
  const doneDir = shq(opts.doneDir);
  const idsDir = shq(opts.idsDir);
  return `#!/usr/bin/env bash
set +e
FIFO=${fifo}; DONE=${doneDir}; IDS=${idsDir}
trap '' INT
while :; do
  if read -r id b64 < "$FIFO"; then
    [ -z "$id" ] && continue
    cmd=$(printf '%s' "$b64" | base64 -d)
    printf '$ %s\\n' "$cmd"
    ( trap - INT; exec bash -c "$cmd" ) > "$IDS/$id" 2>&1
    rc=$?
    printf '%s' "$rc" > "$DONE/.$id.tmp"; mv -f "$DONE/.$id.tmp" "$DONE/$id"
  fi
done
`;
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

/** Parse a done-file's contents into an rc; non-numeric → -1 sentinel. */
export function parseDoneRc(raw: string): number {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isNaN(n) ? -1 : n;
}

/** Decide whether a command runs live in the pane or via the in-process fallback. */
export function decidePaneVsFallback(opts: {
  tmuxOn: boolean;
  isSelected: boolean;
  fifoWritable: boolean;
}): 'pane' | 'fallback' {
  return opts.tmuxOn && opts.isSelected && opts.fifoWritable ? 'pane' : 'fallback';
}

/**
 * Synchronous sleep (ms) so writeRunLine can briefly retry without going async. `Atomics.wait`
 * blocks the whole event loop — but only for the ENXIO driver-startup race, where the driver comes
 * up within milliseconds, so the real wait is tiny; a genuine no-reader returns false promptly
 * (ENXIO is retried only up to the ~1s budget). The synchronous form keeps writeRunLine callable
 * from non-async code, which is why we accept the brief block rather than rewriting to async.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write a line to the FIFO without blocking the pipe. A non-blocking open of a FIFO with no reader
 * fails with ENXIO; since the driver reopens the FIFO on each loop iteration there can be a brief
 * window with no reader (notably right after the driver starts), so we retry on ENXIO for a short,
 * bounded time before giving up. When there is genuinely no reader this returns false promptly
 * (well under the ~1s budget) and never blocks on a full/absent pipe.
 */
export function writeRunLine(fifo: string, line: string): boolean {
  const deadline = Date.now() + 1000;
  for (;;) {
    let fd: number | undefined;
    try {
      // eslint-disable-next-line no-bitwise
      fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      fs.writeSync(fd, line);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENXIO' && Date.now() < deadline) {
        sleepSync(25);
        continue;
      }
      // No reader within the window, or any other failure → caller falls back.
      return false;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* best effort */
        }
      }
    }
  }
}

/**
 * Resolve with the rc once `$doneDir/$id` exists (written atomically via rename). Rejects with an
 * AbortError when `signal` aborts. Uses fs.watch plus a ~100ms poll as a safety net.
 */
export function waitForDone(doneDir: string, id: string, signal: AbortSignal): Promise<number> {
  const donePath = join(doneDir, id);
  return new Promise<number>((resolve, reject) => {
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
      let raw: string;
      try {
        raw = fs.readFileSync(donePath, 'utf8');
      } catch {
        return; // not there yet
      }
      settled = true;
      cleanup();
      resolve(parseDoneRc(raw));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort);

    try {
      watcher = fs.watch(doneDir, () => check());
    } catch {
      /* dir may not be watchable everywhere; poll covers it */
    }
    poll = setInterval(check, 100);
    // Catch the case where the file already exists before the watcher was installed.
    check();
  });
}
