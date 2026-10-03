import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  paneSlug,
  paneLogPath,
  paneCapturePath,
  agentWindowName,
  argvHasSession,
  argvKillSession,
  argvNewSession,
  argvSplitRightPrint,
  argvDisplayMessage,
  argvStatusOff,
  argvListPanes,
  argvNewWindow,
  argvBreakPane,
  argvBreakPaneNamed,
  argvJoinPane,
  argvKillWindow,
  argvSendKeysLiteral,
  argvSendKeysEnter,
  argvPipePane,
  argvSendInterrupt,
  parsePanes,
  detectMode,
  buildReexecArgv,
  TmuxController,
} from '../src/tmux/TmuxController.js';

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

/** Let the fire-and-forget async work in registerAgent/showAgent settle. */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
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

describe('path builders', () => {
  test('paneLogPath joins logsDir with the slug and a .log suffix', () => {
    assert.equal(paneLogPath('/logs', 'My Agent'), join('/logs', 'my-agent.log'));
  });

  test('paneCapturePath joins logsDir with the slug and a .cap suffix', () => {
    assert.equal(paneCapturePath('/logs', 'My Agent'), join('/logs', 'my-agent.cap'));
  });

  test('agentWindowName is a slug-based orc-agent window name', () => {
    assert.equal(agentWindowName('My Agent'), 'orc-agent-my-agent');
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

  test('argvNewWindow is detached, prints the pane id, sets name + cwd + command', () => {
    const argv = argvNewWindow('orc', 'orc-agent-a1', '/work/tree', 'exec zsh -if');
    assert.deepEqual(argv.slice(0, 2), ['new-window', '-d']);
    assert.ok(argv.includes('-P'));
    const fmtIdx = argv.indexOf('-F');
    assert.equal(argv[fmtIdx + 1], '#{pane_id}');
    const nameIdx = argv.indexOf('-n');
    assert.equal(argv[nameIdx + 1], 'orc-agent-a1');
    const cwdIdx = argv.indexOf('-c');
    assert.equal(argv[cwdIdx + 1], '/work/tree');
    assert.equal(argv[argv.length - 1], 'exec zsh -if');
  });

  test('argvBreakPane detaches a pane to its own window', () => {
    assert.deepEqual(argvBreakPane('%9'), ['break-pane', '-d', '-s', '%9']);
  });

  test('argvJoinPane joins a pane horizontally to a target', () => {
    assert.deepEqual(argvJoinPane('%9', '%5'), ['join-pane', '-h', '-s', '%9', '-t', '%5']);
  });

  test('argvKillWindow', () => {
    assert.deepEqual(argvKillWindow('orc-agent-a1'), ['kill-window', '-t', 'orc-agent-a1']);
  });

  test('argvSendKeysLiteral sends text literally with -l', () => {
    assert.deepEqual(argvSendKeysLiteral('%9', 'echo hi'), ['send-keys', '-t', '%9', '-l', 'echo hi']);
  });

  test('argvSendKeysEnter presses Enter', () => {
    assert.deepEqual(argvSendKeysEnter('%9'), ['send-keys', '-t', '%9', 'Enter']);
  });

  test('argvSendInterrupt sends C-c', () => {
    assert.deepEqual(argvSendInterrupt('%9'), ['send-keys', '-t', '%9', 'C-c']);
  });

  test('argvPipePane captures pane output to a command with -o', () => {
    assert.deepEqual(argvPipePane('%9', "cat >> '/tmp/x'"), [
      'pipe-pane', '-o', '-t', '%9', "cat >> '/tmp/x'",
    ]);
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
    const fmt = argv.find((a) => a.includes('#{pane_id}'));
    assert.ok(fmt, 'a format string with #{pane_id} is present');
    assert.match(fmt!, /#\{pane_index\}/);
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
    assert.equal(out.filter((a) => a === '--tmux-child').length, 1);
  });
});

describe('registerAgent / unregisterAgent shell-window lifecycle', () => {
  test('registerAgent opens a detached zsh -if window and starts pipe-pane capture', async () => {
    const logsDir = tmpLogsDir();
    try {
      // new-window prints the agent's shell pane id (%9).
      const { run, calls } = fakeRunner(['%9\n']);
      const c = new TmuxController({ run, logsDir });
      c.registerAgent('a1', 'alpha', 'feature', '/work/a1');
      await flush();

      const win = calls.find((a) => a[0] === 'new-window');
      assert.ok(win, 'a new-window call was issued');
      assert.equal(win![win!.length - 1], 'exec zsh -if', 'the window runs an interactive zsh');
      const cwdIdx = win!.indexOf('-c');
      assert.equal(win![cwdIdx + 1], '/work/a1', 'the shell starts in the agent cwd');

      const pipe = calls.find((a) => a[0] === 'pipe-pane');
      assert.ok(pipe, 'pipe-pane capture was started');
      assert.ok(pipe!.includes('%9'), 'capture targets the new shell pane');
      const capCmd = pipe![pipe!.length - 1] as string;
      assert.ok(capCmd.includes(paneCapturePath(logsDir, 'a1')), 'capture writes the agent capture file');

      // The empty capture file exists after register.
      assert.ok(existsSync(paneCapturePath(logsDir, 'a1')), 'capture file created');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  test('inside mode: agent windows target the current session, not the hardcoded orc session', async () => {
    const logsDir = tmpLogsDir();
    try {
      // adoptInside knows the current pane (%5) but still looks up its session name ("dotfiles");
      // new-window then prints the agent shell pane id (%9).
      const { run, calls } = fakeRunner(['dotfiles\n', '%9\n']);
      const c = new TmuxController({ run, logsDir });
      await c.adoptInside('%5');
      c.registerAgent('a1', 'alpha', 'feature', '/work/a1');
      await flush();

      const win = calls.find((a) => a[0] === 'new-window');
      assert.ok(win, 'a new-window call was issued');
      const tIdx = win!.indexOf('-t');
      assert.equal(win![tIdx + 1], 'dotfiles', 'agent window is created in the user current session');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  test('inside mode: shutdown removes agent windows but never kills the user session', async () => {
    const logsDir = tmpLogsDir();
    try {
      const { run, calls } = fakeRunner(['dotfiles\n', '%9\n']);
      const c = new TmuxController({ run, logsDir });
      await c.adoptInside('%5');
      c.registerAgent('a1', 'alpha', 'feature', '/work/a1');
      await flush();

      await c.shutdown();
      assert.ok(calls.some((a) => a[0] === 'kill-window'), 'agent window torn down');
      assert.ok(!calls.some((a) => a[0] === 'kill-session'), 'never kills the user session');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  test('bootstrap-child: shutdown kills the orc session it created', async () => {
    const logsDir = tmpLogsDir();
    try {
      // adopt lists panes (orc TUI %5), shutdown then has-session succeeds so kill-session runs.
      const { run, calls } = fakeRunner(['%5 0\n']);
      const c = new TmuxController({ run, logsDir });
      await c.adopt();
      await c.shutdown();
      assert.ok(calls.some((a) => a[0] === 'kill-session'), 'owns + kills the orc session');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  test('unregisterAgent kills the agent window and removes its capture file', async () => {
    const logsDir = tmpLogsDir();
    try {
      const { run, calls } = fakeRunner(['%9\n']);
      const c = new TmuxController({ run, logsDir });
      c.registerAgent('a1', 'alpha', 'feature', '/work/a1');
      await flush();
      assert.ok(existsSync(paneCapturePath(logsDir, 'a1')));

      c.unregisterAgent('a1');
      const kill = calls.find((a) => a[0] === 'kill-window');
      assert.ok(kill, 'kill-window issued');
      assert.ok(kill!.includes(agentWindowName('a1')), 'kills this agent window');
      assert.ok(!existsSync(paneCapturePath(logsDir, 'a1')), 'capture file removed');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });
});

describe('showAgent reveals the shell beside the TUI, keeping focus on orc', () => {
  test('joins the selected agent pane to orc, then re-selects orc last (no respawn)', async () => {
    const logsDir = tmpLogsDir();
    try {
      // adopt lists panes: orc TUI is %5 at index 0. new-window prints %9 for a1.
      const { run, calls } = fakeRunner(['%5 0\n', '%9\n']);
      const c = new TmuxController({ run, logsDir });
      await c.adopt();
      c.registerAgent('a1', 'alpha', 'feature', '/work/a1');
      await flush();

      c.showAgent('a1');
      await flush();

      // Never respawns a pane (that would wipe scrollback).
      assert.ok(!calls.some((a) => a[0] === 'respawn-pane'), 'no respawn-pane');

      const joinIdx = calls.findIndex((a) => a[0] === 'join-pane' && a.includes('%9') && a.includes('%5'));
      assert.ok(joinIdx >= 0, 'a1 shell (%9) is joined to orc (%5)');
      const selectIdx = calls.findIndex((a) => a[0] === 'select-pane' && a.includes('%5'));
      assert.ok(selectIdx >= 0, 'orc pane (%5) is re-selected to keep focus on the TUI');
      assert.ok(selectIdx > joinIdx, 'the re-select happens AFTER the join that stole focus');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  test('switching from A to B breaks A back to its window, then joins B (A preserved)', async () => {
    const logsDir = tmpLogsDir();
    try {
      // adopt → %5; a1 window → %9; a2 window → %11.
      const { run, calls } = fakeRunner(['%5 0\n', '%9\n', '%11\n']);
      const c = new TmuxController({ run, logsDir });
      await c.adopt();
      c.registerAgent('a1', 'alpha', 'feature', '/work/a1');
      c.registerAgent('a2', 'beta', 'feature', '/work/a2');
      await flush();

      c.showAgent('a1');
      await flush();
      const before = calls.length;
      c.showAgent('a2');
      await flush();

      const since = calls.slice(before);
      const breakIdx = since.findIndex((a) => a[0] === 'break-pane' && a.includes('%9'));
      const joinIdx = since.findIndex((a) => a[0] === 'join-pane' && a.includes('%11'));
      assert.ok(breakIdx >= 0, 'A (%9) is broken back to its own window (preserved, not killed)');
      assert.ok(joinIdx >= 0, 'B (%11) is joined onto the stage');
      assert.ok(breakIdx < joinIdx, 'break A before join B');
      assert.ok(!since.some((a) => a[0] === 'kill-pane' || a[0] === 'kill-window'), 'A is never killed on switch');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });
});

describe('runInPane injects a framed command and captures output', () => {
  test('returns null when the agent is not selected / has no shell', async () => {
    const logsDir = tmpLogsDir();
    try {
      const { run } = fakeRunner();
      const c = new TmuxController({ run, logsDir });
      // No window created, nothing selected → not drivable in-pane → null.
      const res = await c.runInPane('a1', 'echo hi', new AbortController().signal);
      assert.equal(res, null, 'not selected / no shell → null (caller uses in-process fallback)');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  test('sends the framed command then Enter when the agent is on the stage', async () => {
    const logsDir = tmpLogsDir();
    try {
      const { run, calls } = fakeRunner(['%5 0\n', '%9\n']);
      const c = new TmuxController({ run, logsDir });
      await c.adopt();
      c.registerAgent('a1', 'alpha', 'feature', '/work/a1');
      await flush();
      c.showAgent('a1');
      await flush();

      const ac = new AbortController();
      // Don't await — waitForCapture would hang (no real shell writes the capture). Abort quickly.
      const p = c.runInPane('a1', 'echo hi', ac.signal);
      await flush();
      ac.abort();
      const res = await p;

      const literal = calls.find((a) => a[0] === 'send-keys' && a.includes('-l'));
      assert.ok(literal, 'a literal send-keys carried the framed command');
      const framed = literal![literal!.length - 1] as string;
      assert.ok(framed.includes('<<<ORC-BEGIN'), 'the injected line prints the BEGIN sentinel');
      assert.ok(framed.includes('echo hi'), 'the injected line includes the command');
      const enter = calls.find((a) => a[0] === 'send-keys' && a.includes('Enter'));
      assert.ok(enter, 'Enter was pressed to submit the command');
      // Aborted → interrupt sent, rc 130.
      assert.ok(calls.some((a) => a[0] === 'send-keys' && a.includes('C-c')), 'abort sends C-c');
      assert.equal(res?.rc, 130);
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });
});

/**
 * A tmux runner that hands out a fresh pane id for every `new-window` / `split-window` and records
 * all calls. Lets us drive multi-shell scenarios without counting canned stdouts by index.
 */
function paneAllocRunner(firstPaneIds: { listPane?: string } = {}) {
  const calls: string[][] = [];
  let next = 9;
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'list-panes') return { stdout: (firstPaneIds.listPane ?? '%5') + ' 0\n', stderr: '' };
    if (args[0] === 'new-window' || args[0] === 'split-window') {
      const id = `%${next}`;
      next += 2;
      return { stdout: id + '\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('multiple concurrent shells per agent', () => {
  test('a second run while the first is busy splits a new shell pane', async () => {
    const logsDir = tmpLogsDir();
    try {
      const { run, calls } = paneAllocRunner();
      const c = new TmuxController({ run, logsDir });
      await c.adopt();
      c.registerAgent('a1', 'alpha', 'feature', '/work/a1');
      await flush();
      c.showAgent('a1');
      await flush();

      const ac1 = new AbortController();
      const ac2 = new AbortController();
      // First run grabs the idle shell 0 and blocks on capture (no real shell writes it).
      const p1 = c.runInPane('a1', 'yarn start', ac1.signal);
      await flush();
      // Second run finds shell 0 busy → must split a new pane for concurrency.
      const p2 = c.runInPane('a1', 'yarn ios', ac2.signal);
      await flush();

      assert.ok(
        calls.some((a) => a[0] === 'split-window'),
        'a new shell pane was split for the concurrent command',
      );
      // A per-shell capture file for shell index 1 is created.
      assert.ok(existsSync(paneCapturePath(logsDir, 'a1', 1)), 'shell 1 capture file created');

      ac1.abort();
      ac2.abort();
      await Promise.all([p1, p2]);
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  test('a run reuses an idle shell instead of splitting', async () => {
    const logsDir = tmpLogsDir();
    try {
      const { run, calls } = paneAllocRunner();
      const c = new TmuxController({ run, logsDir });
      await c.adopt();
      c.registerAgent('a1', 'alpha', 'feature', '/work/a1');
      await flush();
      c.showAgent('a1');
      await flush();

      // First run, then let it finish (abort) so shell 0 returns to idle.
      const ac1 = new AbortController();
      const p1 = c.runInPane('a1', 'echo one', ac1.signal);
      await flush();
      ac1.abort();
      await p1;

      const before = calls.length;
      const ac2 = new AbortController();
      const p2 = c.runInPane('a1', 'echo two', ac2.signal);
      await flush();
      ac2.abort();
      await p2;

      const since = calls.slice(before);
      assert.ok(!since.some((a) => a[0] === 'split-window'), 'idle shell reused, no new split');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  test('unregisterAgent removes every per-shell capture file', async () => {
    const logsDir = tmpLogsDir();
    try {
      const { run } = paneAllocRunner();
      const c = new TmuxController({ run, logsDir });
      await c.adopt();
      c.registerAgent('a1', 'alpha', 'feature', '/work/a1');
      await flush();
      c.showAgent('a1');
      await flush();

      const ac1 = new AbortController();
      const ac2 = new AbortController();
      const p1 = c.runInPane('a1', 'yarn start', ac1.signal);
      await flush();
      const p2 = c.runInPane('a1', 'yarn ios', ac2.signal);
      await flush();
      ac1.abort();
      ac2.abort();
      await Promise.all([p1, p2]);

      assert.ok(existsSync(paneCapturePath(logsDir, 'a1', 0)), 'shell 0 capture exists before');
      assert.ok(existsSync(paneCapturePath(logsDir, 'a1', 1)), 'shell 1 capture exists before');

      c.unregisterAgent('a1');
      assert.ok(!existsSync(paneCapturePath(logsDir, 'a1', 0)), 'shell 0 capture removed');
      assert.ok(!existsSync(paneCapturePath(logsDir, 'a1', 1)), 'shell 1 capture removed');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });
});

describe('argvBreakPaneNamed keeps the agent window name stable', () => {
  test('breaks a pane into a named detached window', () => {
    assert.deepEqual(argvBreakPaneNamed('%9', 'orc-agent-a1'), [
      'break-pane',
      '-d',
      '-s',
      '%9',
      '-n',
      'orc-agent-a1',
    ]);
  });
});
