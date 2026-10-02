import type { LogKind } from '../types.js';

/**
 * Per-kind Ink styling for a rendered log line. Kept identical to the map AgentView renders with so
 * the two agree on how each kind looks (the logFormat test deep-equals this against AgentView's copy).
 */
export const LOG_KIND_COLOR: Record<LogKind, { color?: string; dim?: boolean }> = {
  text: {},
  thinking: { color: 'gray', dim: true },
  tool: { color: 'cyan' },
  tool_result: { color: 'white', dim: true },
  system: { color: 'gray', dim: true },
  result: { color: 'green' },
  error: { color: 'red' },
  input: { color: 'yellow' },
  // Cross-agent messages (a subagent's report/question) — magenta so they stand apart from the
  // human's yellow "you: …" input and from dim-gray system lines.
  subagent: { color: 'magenta' },
};
