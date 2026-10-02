import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOG_KIND_COLOR,
  SGR,
  formatLogLineAnsi,
  INITIAL_MIRROR_STATE,
  computeMirrorAppend,
  type MirrorState,
} from '../src/ui/logFormat.js';
import type { LogEntry, LogKind } from '../src/types.js';

// IMPLEMENTER NOTE: the tmux-as-real-terminal plan DELETES the ANSI-mirroring machinery —
// formatLogLineAnsi, computeMirrorAppend, INITIAL_MIRROR_STATE, MirrorState and SGR — because the
// viewer pane no longer tails a mirrored transcript (it runs the command driver instead). When you
// remove those exports, delete the corresponding `describe` blocks below (SGR, formatLogLineAnsi,
// INITIAL_MIRROR_STATE, computeMirrorAppend) along with the now-unused imports. KEEP the
// LOG_KIND_COLOR describe block — that color map survives. These tests are left intact for now so the
// pre-implementation build stays green; do not treat their later removal as a regression.

/** Build a LogEntry with sensible defaults; override whatever the case needs. */
function entry(over: Partial<LogEntry> & { id: number }): LogEntry {
  return { kind: 'text', text: '', done: true, ...over };
}

describe('LOG_KIND_COLOR', () => {
  test('deep-equals the color map AgentView renders with', () => {
    // Copied verbatim from src/ui/AgentView.tsx (the COLOR map, lines 6-17).
    const expected: Record<LogKind, { color?: string; dim?: boolean }> = {
      text: {},
      thinking: { color: 'gray', dim: true },
      tool: { color: 'cyan' },
      system: { color: 'gray', dim: true },
      result: { color: 'green' },
      error: { color: 'red' },
      input: { color: 'yellow' },
      subagent: { color: 'magenta' },
    };
    assert.deepEqual(LOG_KIND_COLOR, expected);
  });
});

describe('SGR', () => {
  test('maps each kind to its ANSI SGR open code', () => {
    assert.equal(SGR.tool, '\x1b[36m');
    assert.equal(SGR.result, '\x1b[32m');
    assert.equal(SGR.error, '\x1b[31m');
    assert.equal(SGR.subagent, '\x1b[35m');
    assert.equal(SGR.thinking, '\x1b[2m');
    assert.equal(SGR.system, '\x1b[2m');
    assert.equal(SGR.input, '\x1b[33m');
    assert.equal(SGR.text, '');
  });
});

describe('formatLogLineAnsi', () => {
  test('a text-kind line is emitted bare (no SGR wrapping)', () => {
    assert.equal(formatLogLineAnsi(entry({ id: 1, kind: 'text', text: 'hello' })), 'hello');
  });

  test('a tool-kind line is wrapped in cyan + reset', () => {
    assert.equal(
      formatLogLineAnsi(entry({ id: 1, kind: 'tool', text: 'Read(foo)' })),
      '\x1b[36mRead(foo)\x1b[0m',
    );
  });

  test('an error-kind line is wrapped in red + reset', () => {
    assert.equal(formatLogLineAnsi(entry({ id: 1, kind: 'error', text: 'boom' })), '\x1b[31mboom\x1b[0m');
  });

  test('a multiline entry wraps each physical line and joins with \\n', () => {
    const out = formatLogLineAnsi(entry({ id: 1, kind: 'result', text: 'a\nb' }));
    assert.equal(out, '\x1b[32ma\x1b[0m\n\x1b[32mb\x1b[0m');
  });

  test('a multiline text entry joins bare lines with \\n', () => {
    assert.equal(formatLogLineAnsi(entry({ id: 1, kind: 'text', text: 'a\nb' })), 'a\nb');
  });

  test('empty text with done===false renders the streaming placeholder (colored)', () => {
    // tool kind → placeholder wrapped in cyan.
    assert.equal(formatLogLineAnsi(entry({ id: 1, kind: 'tool', text: '', done: false })), '\x1b[36m…\x1b[0m');
    // text kind → bare placeholder.
    assert.equal(formatLogLineAnsi(entry({ id: 1, kind: 'text', text: '', done: false })), '…');
  });

  test('empty text with done===true renders empty string', () => {
    assert.equal(formatLogLineAnsi(entry({ id: 1, kind: 'tool', text: '', done: true })), '');
    assert.equal(formatLogLineAnsi(entry({ id: 1, kind: 'text', text: '', done: true })), '');
  });
});

describe('INITIAL_MIRROR_STATE', () => {
  test('starts both ids at -1', () => {
    assert.deepEqual(INITIAL_MIRROR_STATE, { lastDoneId: -1, tailId: -1 });
  });
});

describe('computeMirrorAppend', () => {
  test('appends every newly-done entry in ascending order, advancing lastDoneId', () => {
    const events: LogEntry[] = [
      entry({ id: 0, kind: 'text', text: 'one', done: true }),
      entry({ id: 1, kind: 'tool', text: 'two', done: true }),
    ];
    const { text, state } = computeMirrorAppend(INITIAL_MIRROR_STATE, events);
    assert.equal(text, 'one\n' + '\x1b[36mtwo\x1b[0m\n');
    assert.equal(state.lastDoneId, 1);
  });

  test('is idempotent: feeding the returned state with the same events yields no text', () => {
    const events: LogEntry[] = [
      entry({ id: 0, kind: 'text', text: 'one', done: true }),
      entry({ id: 1, kind: 'text', text: 'two', done: true }),
    ];
    const first = computeMirrorAppend(INITIAL_MIRROR_STATE, events);
    const second = computeMirrorAppend(first.state, events);
    assert.equal(second.text, '');
  });

  test('text==="" when there is nothing new', () => {
    const { text } = computeMirrorAppend(INITIAL_MIRROR_STATE, []);
    assert.equal(text, '');
  });

  test('a trailing streaming (not-done) entry is emitted once', () => {
    const events: LogEntry[] = [entry({ id: 5, kind: 'text', text: 'partial', done: false })];
    const first = computeMirrorAppend(INITIAL_MIRROR_STATE, events);
    assert.equal(first.text, 'partial\n');
    assert.equal(first.state.tailId, 5);
    // Same events again → nothing new (tailId already 5).
    const second = computeMirrorAppend(first.state, events);
    assert.equal(second.text, '');
  });

  test('a streaming entry that later becomes done gets a finalized line', () => {
    const streaming: LogEntry[] = [entry({ id: 5, kind: 'text', text: 'partial', done: false })];
    const first = computeMirrorAppend(INITIAL_MIRROR_STATE, streaming);
    assert.equal(first.text, 'partial\n');
    // The same id flips to done with its final text.
    const finalized: LogEntry[] = [entry({ id: 5, kind: 'text', text: 'partial complete', done: true })];
    const second = computeMirrorAppend(first.state, finalized);
    assert.equal(second.text, 'partial complete\n');
    assert.equal(second.state.lastDoneId, 5);
  });

  test('ring-drop safety: ids are the key, not the array index', () => {
    // Older entries were spliced away; the buffer now starts at id 500. With lastDoneId -1, every
    // surviving entry must still be emitted — keying off ids, never array position.
    const events: LogEntry[] = [
      entry({ id: 500, kind: 'text', text: 'a', done: true }),
      entry({ id: 501, kind: 'text', text: 'b', done: true }),
    ];
    const { text, state } = computeMirrorAppend(INITIAL_MIRROR_STATE, events);
    assert.equal(text, 'a\nb\n');
    assert.equal(state.lastDoneId, 501);
  });

  test('only entries with id > prev.lastDoneId are appended', () => {
    const prev: MirrorState = { lastDoneId: 0, tailId: -1 };
    const events: LogEntry[] = [
      entry({ id: 0, kind: 'text', text: 'already', done: true }),
      entry({ id: 1, kind: 'text', text: 'fresh', done: true }),
    ];
    const { text, state } = computeMirrorAppend(prev, events);
    assert.equal(text, 'fresh\n');
    assert.equal(state.lastDoneId, 1);
  });
});
