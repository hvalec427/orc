import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  paneSlug,
  paneLogPath,
  viewerTailCommand,
  argvHasSession,
  argvKillSession,
  argvNewSession,
  argvSplitRight,
  argvSplitRightPrint,
  argvDisplayMessage,
  argvStatusOff,
  argvListPanes,
  argvRespawnViewer,
  argvKillPane,
  parsePanes,
  detectMode,
  buildReexecArgv,
  TmuxController,
} from '../src/tmux/TmuxController.js';
import { formatLogLineAnsi } from '../src/ui/logFormat.js';
import type { LogEntry } from '../src/types.js';

/** A fake tmux runner that records every argv and returns canned stdout per call. */
function fakeRunner(stdouts: string[] = []) {
  const calls: string[][] = [];
  let i = 0;
  const run = async (args: string[]) => {
    calls.push(args);
    const stdout = i < stdouts.length ? stdouts[i] : '';
    i++;
    return { stdout, stderr: '' };
  };
  return { run, calls };
}

function tmpLogsDir(): string {
  return mkdtempSync(join(tmpdir(), 'orc-tmux-'));
}

function entry(over: Partial<LogEntry> & { id: number }): LogEntry {
  return { kind: 'text', text: '', done: true, ...over };
}

describe('paneSlug', () => {
  test('lowercases and strips characters outside [a-z0-9_-]', () => {
    const slug = paneSlug("Foo Bar; rm -rf / $x 'q\"");
    assert.match(slug, /^[a-z0-9_-]*$/);
    assert.doesNotMatch(slug, /[ ;$'"/]/);
  });

  test('keeps allowed characters', () => {
    assert.equal(paneSlug('abc-123_xyz'), 'abc-123_xyz');
  });

  test('uppercase is folded to lowercase', () => {
    assert.equal(paneSlug('ABC'), 'abc');
  });
});

describe('paneLogPath', () => {
  test('joins logsDir with the slug and a .log suffix', () => {
    assert.equal(paneLogPath('/logs', 'My Agent'), join('/logs', 'my-agent.log'));
  });
});

describe('viewerTailCommand', () => {
  test('is an exec tail -F on the single-quoted path', () => {
    assert.equal(
      viewerTailCommand('/logs/a.log'),
      "exec tail -n +1 -F '/logs/a.log'",
    );
  });

  test("escapes an embedded single quote as '\\'' so the path can't break out of the quotes", () => {
    assert.equal(
      viewerTailCommand("/logs/o'brien.log"),
      "exec tail -n +1 -F '/logs/o'\\''brien.log'",
    );
  });
});

describe('argv builders', () => {
  test('argvHasSession', () => {
    assert.deepEqual(argvHasSession('orc'), ['has-session', '-t', 'orc']);
  });

  test('argvKillSession', () => {
    assert.deepEqual(argvKillSession('orc'), ['kill-session', '-t', 'orc']);
  });

  test('argvNewSession starts with the detached-session prefix and includes the reexec argv', () => {
    const reexec = ['/usr/bin/node', '/x/index.js', 'run', '--tmux-child'];
    const argv = argvNewSession('orc', reexec);
    assert.deepEqual(argv.slice(0, 4), ['new-session', '-d', '-s', 'orc']);
    for (const part of reexec) assert.ok(argv.includes(part), `includes ${part}`);
  });

  test('argvSplitRight begins with the horizontal split targeting the pane', () => {
    assert.deepEqual(argvSplitRight('orc:0.0').slice(0, 4), ['split-window', '-h', '-t', 'orc:0.0']);
  });

  test('argvSplitRightPrint splits horizontally and prints the new pane id', () => {
    assert.deepEqual(argvSplitRightPrint('%7'), [
      'split-window', '-h', '-P', '-F', '#{pane_id}', '-t', '%7',
    ]);
  });

  test('argvDisplayMessage prints the format for the current client when no target is given', () => {
    assert.deepEqual(argvDisplayMessage('#{pane_id}'), ['display-message', '-p', '#{pane_id}']);
  });

  test('argvDisplayMessage targets a pane when one is given', () => {
    assert.deepEqual(argvDisplayMessage('#{pane_id}', '%3'), [
      'display-message', '-p', '-t', '%3', '#{pane_id}',
    ]);
  });

  test('argvStatusOff is session-scoped (not -g)', () => {
    assert.deepEqual(argvStatusOff('orc'), ['set', '-t', 'orc', 'status', 'off']);
  });

  test('argvListPanes requests pane id + index in a resilient format', () => {
    const argv = argvListPanes('orc');
    assert.ok(argv.includes('list-panes'));
    assert.ok(argv.includes('-t'));
    assert.ok(argv.includes('orc'));
    assert.ok(argv.includes('-F'));
    const fmt = argv.find((a) => a.includes('#{pane_id}'));
    assert.ok(fmt, 'a format string with #{pane_id} is present');
    assert.match(fmt!, /#\{pane_index\}/);
  });

  test('argvRespawnViewer kills + respawns the target pane with the command', () => {
    assert.deepEqual(
      argvRespawnViewer('%2', "exec tail -n +1 -F '/logs/a.log'"),
      ['respawn-pane', '-k', '-t', '%2', "exec tail -n +1 -F '/logs/a.log'"],
    );
  });

  test('argvKillPane', () => {
    assert.deepEqual(argvKillPane('%2'), ['kill-pane', '-t', '%2']);
  });
});

describe('parsePanes', () => {
  test('parses "<paneId> <index>" lines, ignoring blanks', () => {
    assert.deepEqual(parsePanes('%3 0\n%4 1'), [
      { paneId: '%3', index: 0 },
      { paneId: '%4', index: 1 },
    ]);
  });

  test('blank lines are skipped', () => {
    assert.deepEqual(parsePanes('\n%7 0\n\n'), [{ paneId: '%7', index: 0 }]);
  });
});

describe('detectMode', () => {
  const base = { disabled: false, isTTY: true, binaryAvailable: true, inTmux: false, isChild: false };

  test('disabled → off', () => {
    assert.equal(detectMode({ ...base, disabled: true }), 'off');
  });

  test('not a TTY → off', () => {
    assert.equal(detectMode({ ...base, isTTY: false }), 'off');
  });

  test('tmux binary unavailable → off', () => {
    assert.equal(detectMode({ ...base, binaryAvailable: false }), 'off');
  });

  test('plain enabled TTY, not in tmux → bootstrap', () => {
    assert.equal(detectMode(base), 'bootstrap');
  });

  test('already inside tmux → inside', () => {
    assert.equal(detectMode({ ...base, inTmux: true }), 'inside');
  });

  test('inside tmux AND the re-exec child → inside (fork-bomb guard)', () => {
    assert.equal(detectMode({ ...base, inTmux: true, isChild: true }), 'inside');
  });

  test('off dominates even when inTmux is true', () => {
    assert.equal(detectMode({ ...base, disabled: true, inTmux: true }), 'off');
  });
});

describe('buildReexecArgv', () => {
  test('re-execs node on the entry with the original user args plus --tmux-child', () => {
    const argv = ['node', '/x/index.js', 'run', '--foo'];
    const out = buildReexecArgv(argv, '/x/index.js');
    assert.equal(out[0], process.execPath);
    assert.equal(out[1], '/x/index.js');
    assert.ok(out.includes('run'));
    assert.ok(out.includes('--foo'));
    assert.equal(out[out.length - 1], '--tmux-child');
    // Appended exactly once.
    assert.equal(out.filter((a) => a === '--tmux-child').length, 1);
  });
});

describe('TmuxController file mirroring (fake runner)', () => {
  test('registerAgent creates the pane-log file', () => {
    const logsDir = tmpLogsDir();
    try {
      const { run } = fakeRunner();
      const c = new TmuxController({ run, logsDir });
      c.registerAgent('a1', 'alpha', 'feature');
      assert.ok(existsSync(paneLogPath(logsDir, 'a1')), 'the pane-log file exists after register');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  test('unregisterAgent deletes the pane-log file', () => {
    const logsDir = tmpLogsDir();
    try {
      const { run } = fakeRunner();
      const c = new TmuxController({ run, logsDir });
      c.registerAgent('a1', 'alpha', 'feature');
      c.unregisterAgent('a1');
      assert.ok(!existsSync(paneLogPath(logsDir, 'a1')), 'the pane-log file is gone after unregister');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  test('mirror appends the formatted log, growing the file and never duplicating', () => {
    const logsDir = tmpLogsDir();
    try {
      const { run } = fakeRunner();
      const c = new TmuxController({ run, logsDir });
      c.registerAgent('a1', 'alpha', 'feature');

      c.mirror('a1', [entry({ id: 0, kind: 'text', text: 'one', done: true })]);
      const afterFirst = readFileSync(paneLogPath(logsDir, 'a1'), 'utf8');
      assert.equal(afterFirst, formatLogLineAnsi(entry({ id: 0, kind: 'text', text: 'one', done: true })) + '\n');

      // A growing event list: the old entry plus a new one. Only the new line is appended.
      c.mirror('a1', [
        entry({ id: 0, kind: 'text', text: 'one', done: true }),
        entry({ id: 1, kind: 'tool', text: 'two', done: true }),
      ]);
      const afterSecond = readFileSync(paneLogPath(logsDir, 'a1'), 'utf8');
      const expected =
        formatLogLineAnsi(entry({ id: 0, kind: 'text', text: 'one', done: true })) +
        '\n' +
        formatLogLineAnsi(entry({ id: 1, kind: 'tool', text: 'two', done: true })) +
        '\n';
      assert.equal(afterSecond, expected, 'file is the concatenation of both appends, no duplication');

      // A repeat call with the SAME events appends nothing.
      c.mirror('a1', [
        entry({ id: 0, kind: 'text', text: 'one', done: true }),
        entry({ id: 1, kind: 'tool', text: 'two', done: true }),
      ]);
      assert.equal(readFileSync(paneLogPath(logsDir, 'a1'), 'utf8'), expected, 'idempotent re-mirror');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });
});

describe('TmuxController.showAgent (fake runner)', () => {
  test('respawns the viewer pane tailing the selected agent log', async () => {
    const logsDir = tmpLogsDir();
    try {
      // The controller discovers panes first; the fake returns the orc pane (%1 index 0) and the
      // viewer pane (%2 index 1). Then showAgent must respawn %2 with the tail command.
      const { run, calls } = fakeRunner(['%1 0\n%2 1']);
      const c = new TmuxController({ run, logsDir }) as unknown as {
        adopt?: () => Promise<void> | void;
        attach?: () => Promise<void> | void;
        discoverPanes?: () => Promise<void> | void;
        showAgent(id?: string): Promise<void> | void;
        registerAgent(id: string, name: string, template: string): void;
      };
      c.registerAgent('a1', 'alpha', 'feature');

      // Drive whatever discovery entry point the controller exposes to learn the pane ids.
      const discover = c.adopt ?? c.attach ?? c.discoverPanes;
      if (discover) await discover.call(c);

      await c.showAgent('a1');

      const tail = viewerTailCommand(paneLogPath(logsDir, 'a1'));
      // The respawn-pane call must target the viewer pane (%2) with the tail command as its last arg.
      const respawn = calls.find((a) => a[0] === 'respawn-pane' && a.includes('-k'));
      assert.ok(respawn, 'a respawn-pane -k call was issued');
      assert.equal(respawn![respawn!.length - 1], tail, 'the viewer tails the agent log');
      assert.ok(respawn!.includes('%2'), 'the respawn targets the discovered viewer pane');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });
});

describe('TmuxController.adoptInside (fake runner)', () => {
  test('splits its own viewer pane off the current pane and respawns only that pane', async () => {
    const logsDir = tmpLogsDir();
    try {
      // The split-window -P prints the brand-new viewer pane id (%9). adoptInside must capture it,
      // and showAgent must then respawn %9 — the pane orc created, never the user's pane (%5).
      const { run, calls } = fakeRunner(['%9\n']);
      const c = new TmuxController({ run, logsDir });
      c.registerAgent('a1', 'alpha', 'feature');

      await c.adoptInside('%5');

      // The discovery split targets orc's own pane (%5) and asks for the new pane id.
      const split = calls.find((a) => a[0] === 'split-window');
      assert.deepEqual(split, argvSplitRightPrint('%5'));

      await c.showAgent('a1');
      const tail = viewerTailCommand(paneLogPath(logsDir, 'a1'));
      const respawn = calls.find((a) => a[0] === 'respawn-pane' && a.includes('-k'));
      assert.ok(respawn, 'a respawn-pane -k call was issued');
      assert.equal(respawn![respawn!.length - 1], tail, 'the viewer tails the agent log');
      assert.ok(respawn!.includes('%9'), 'the respawn targets the pane orc created, not %5');
      assert.ok(!respawn!.includes('%5'), "orc never respawns the user's own pane");
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  test('resolves the current pane via display-message when $TMUX_PANE is absent', async () => {
    const logsDir = tmpLogsDir();
    // Pass the pane explicitly as undefined AND clear the env so the default can't pick up an
    // ambient $TMUX_PANE from a tmux the test happens to run inside.
    const savedPane = process.env.TMUX_PANE;
    delete process.env.TMUX_PANE;
    try {
      // First call answers display-message with the active pane (%2); second is the split (%9).
      const { run, calls } = fakeRunner(['%2\n', '%9\n']);
      const c = new TmuxController({ run, logsDir });

      await c.adoptInside();

      assert.deepEqual(calls[0], argvDisplayMessage('#{pane_id}'));
      const split = calls.find((a) => a[0] === 'split-window');
      assert.deepEqual(split, argvSplitRightPrint('%2'));
    } finally {
      if (savedPane === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = savedPane;
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  test('leaves the viewer unset (showAgent stays a no-op) when the split yields no pane id', async () => {
    const logsDir = tmpLogsDir();
    try {
      // The split returns empty stdout → no pane id captured → viewPaneId stays unset.
      const { run, calls } = fakeRunner(['']);
      const c = new TmuxController({ run, logsDir });
      c.registerAgent('a1', 'alpha', 'feature');

      await c.adoptInside('%5');
      await c.showAgent('a1');

      assert.ok(!calls.some((a) => a[0] === 'respawn-pane'), 'no respawn without a known viewer pane');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });
});
