import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LOG_KIND_COLOR } from '../src/ui/logFormat.js';
import type { LogKind } from '../src/types.js';

// The ANSI-mirroring machinery (formatLogLineAnsi, computeMirrorAppend, INITIAL_MIRROR_STATE,
// MirrorState, SGR) was removed with the tmux-as-real-terminal change: the viewer pane runs the
// command driver instead of tailing a mirrored transcript. Only the LOG_KIND_COLOR map survives.

describe('LOG_KIND_COLOR', () => {
  test('deep-equals the color map AgentView renders with', () => {
    // Copied verbatim from src/ui/AgentView.tsx (the COLOR map, lines 6-17).
    const expected: Record<LogKind, { color?: string; dim?: boolean }> = {
      text: {},
      thinking: { color: 'gray', dim: true },
      tool: { color: 'cyan' },
      tool_result: { color: 'white', dim: true },
      system: { color: 'gray', dim: true },
      result: { color: 'green' },
      error: { color: 'red' },
      input: { color: 'yellow' },
      subagent: { color: 'magenta' },
    };
    assert.deepEqual(LOG_KIND_COLOR, expected);
  });
});
