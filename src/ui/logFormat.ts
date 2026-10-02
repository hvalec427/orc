import type { LogEntry, LogKind } from '../types.js';

/**
 * Per-kind Ink styling for a rendered log line. Kept identical to the map AgentView renders with so
 * the tmux pane mirror and the Ink view agree on how each kind looks (the logFormat test deep-equals
 * this against AgentView's copy).
 */
export const LOG_KIND_COLOR: Record<LogKind, { color?: string; dim?: boolean }> = {
  text: {},
  thinking: { color: 'gray', dim: true },
  tool: { color: 'cyan' },
  system: { color: 'gray', dim: true },
  result: { color: 'green' },
  error: { color: 'red' },
  input: { color: 'yellow' },
  // Cross-agent messages (a subagent's report/question) — magenta so they stand apart from the
  // human's yellow "you: …" input and from dim-gray system lines.
  subagent: { color: 'magenta' },
};

/** The ANSI SGR open code for each kind, for the raw (ANSI-colored) tmux pane mirror. */
export const SGR: Record<LogKind, string> = {
  text: '',
  thinking: '\x1b[2m',
  tool: '\x1b[36m',
  system: '\x1b[2m',
  result: '\x1b[32m',
  error: '\x1b[31m',
  input: '\x1b[33m',
  subagent: '\x1b[35m',
};

const RESET = '\x1b[0m';

/** Wrap one physical line in the kind's SGR code (leaving bare when the kind has no color). */
function colorLine(kind: LogKind, line: string): string {
  const open = SGR[kind];
  return open ? open + line + RESET : line;
}

/**
 * Render a single log entry as ANSI-colored text for the pane mirror. Empty text becomes a streaming
 * placeholder ('…') while the block is live, or an empty string once done. Multiline text wraps each
 * physical line in the kind's color and joins with '\n'. No glyphs are added.
 */
export function formatLogLineAnsi(entry: LogEntry): string {
  if (entry.text === '') {
    return entry.done ? '' : colorLine(entry.kind, '…');
  }
  return entry.text
    .split('\n')
    .map((line) => colorLine(entry.kind, line))
    .join('\n');
}

/** How far a given agent's pane mirror has progressed, keyed on log-entry ids (ring-drop safe). */
export interface MirrorState {
  lastDoneId: number;
  tailId: number;
}

export const INITIAL_MIRROR_STATE: MirrorState = { lastDoneId: -1, tailId: -1 };

/**
 * Compute the incremental text to append to an agent's pane mirror given its previous mirror state
 * and the session's current event buffer. Every newly-done entry (id > prev.lastDoneId) is emitted
 * in ascending id order; the final entry, if still streaming and not already mirrored, is emitted
 * once. Idempotent: feeding the returned state the same events yields ''. Keyed strictly on ids, so
 * ring-buffer drops never duplicate or skip lines.
 */
export function computeMirrorAppend(
  prev: MirrorState,
  events: readonly LogEntry[],
): { text: string; state: MirrorState } {
  let text = '';
  let newLastDoneId = prev.lastDoneId;
  let newTailId = prev.tailId;

  // Newly-finalized lines, in ascending id order.
  const done = events
    .filter((e) => e.done && e.id > prev.lastDoneId)
    .sort((a, b) => a.id - b.id);
  for (const e of done) {
    text += formatLogLineAnsi(e) + '\n';
    if (e.id > newLastDoneId) newLastDoneId = e.id;
  }

  // A trailing streaming (not-done) entry: emit it once, keyed on its id.
  const last = events[events.length - 1];
  if (last && !last.done && last.id !== prev.tailId) {
    text += formatLogLineAnsi(last) + '\n';
    newTailId = last.id;
  }

  return { text, state: { lastDoneId: newLastDoneId, tailId: newTailId } };
}
