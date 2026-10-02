import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  encodeRunLine,
  buildDriverScript,
  writeRunLine,
  waitForDone,
} from '../src/tmux/paneRun.js';

// Scripted bash integration (NO tmux): background buildDriverScript() and talk to the FIFO directly.
// Expected RED until src/tmux/paneRun.ts exists.

/** One isolated driver fixture: a tmp dir with fifo + done/ids dirs and a running bash driver. */
interface Fixture {
  dir: string;
  fifo: string;
  doneDir: string;
  idsDir: string;
  child?: ChildProcess;
}

const fixtures: Fixture[] = [];

function makeFixture(startDriver = true): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'orc-drv-'));
  const fifo = join(dir, 'cmd.fifo');
  const doneDir = join(dir, 'done');
  const idsDir = join(dir, 'ids');
  mkdirSync(doneDir, { recursive: true });
  mkdirSync(idsDir, { recursive: true });
  // mkfifo via the system binary (node has no direct API).
  execFileSync('mkfifo', [fifo]);
  const fx: Fixture = { dir, fifo, doneDir, idsDir };
  if (startDriver) {
    const script = buildDriverScript({ fifo, doneDir, idsDir });
    // Own process group so we can signal the whole driver + its child if needed.
    fx.child = spawn('bash', ['-c', script], { detached: true, stdio: 'ignore' });
  }
  fixtures.push(fx);
  return fx;
}

afterEach(() => {
  for (const fx of fixtures.splice(0)) {
    if (fx.child && fx.child.pid) {
      try {
        process.kill(-fx.child.pid, 'SIGKILL'); // kill the whole group
      } catch {
        try {
          fx.child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
    try {
      rmSync(fx.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** Reject if a promise doesn't settle within `ms` — turns a hang into a failing test. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ]);
}

describe('driver happy path', () => {
  test('a simple echo runs, output captured, rc 0', async () => {
    const fx = makeFixture();
    const ok = writeRunLine(fx.fifo, encodeRunLine('id1', 'echo hi'));
    assert.equal(ok, true, 'writeRunLine succeeded (reader present)');
    const rc = await withTimeout(
      waitForDone(fx.doneDir, 'id1', new AbortController().signal),
      5000,
      'waitForDone id1',
    );
    assert.equal(rc, 0);
    const out = readFileSync(join(fx.idsDir, 'id1'), 'utf8');
    assert.match(out, /hi/, 'captured stdout contains hi');
  });
});

describe('Ctrl+C interrupt + loop survival', () => {
  test('a long command is interrupted, and the driver loop survives for a second command', async () => {
    const fx = makeFixture();
    // Start a long-running command.
    writeRunLine(fx.fifo, encodeRunLine('slow', 'sleep 100'));
    // Give the driver a beat to spawn the child.
    await new Promise((r) => setTimeout(r, 300));
    // Emulate pane Ctrl+C: interrupt the driver's process GROUP. The driver ignores INT
    // (trap '' INT) but the foreground child restores and receives it → rc 130.
    if (fx.child?.pid) {
      try {
        process.kill(-fx.child.pid, 'SIGINT');
      } catch {
        /* if the group signal is awkward in this env, the survival check below still proves the loop */
      }
    }
    const rc = await withTimeout(
      waitForDone(fx.doneDir, 'slow', new AbortController().signal),
      6000,
      'waitForDone slow (interrupted)',
    );
    assert.equal(rc, 130, 'interrupted command reports rc 130');

    // The outer `while :` must have survived — a SECOND command still completes.
    const ok = writeRunLine(fx.fifo, encodeRunLine('after', 'echo survived'));
    assert.equal(ok, true, 'driver still has a reader (loop alive)');
    const rc2 = await withTimeout(
      waitForDone(fx.doneDir, 'after', new AbortController().signal),
      5000,
      'waitForDone after',
    );
    assert.equal(rc2, 0);
    assert.match(readFileSync(join(fx.idsDir, 'after'), 'utf8'), /survived/);
  });

  test('empty-writer EOF does not kill the loop (a later command still completes)', async () => {
    const fx = makeFixture();
    // Open+close the FIFO with no data (an empty writer). A naive `while read` loop would see EOF
    // and exit; the outer `while :` must survive this.
    try {
      // Opening for write and immediately closing delivers EOF to the reader.
      const fd = (await import('node:fs')).openSync(fx.fifo, 'w');
      (await import('node:fs')).closeSync(fd);
    } catch {
      /* ignore: if this can't open without a reader, the driver is the reader so it should be fine */
    }
    await new Promise((r) => setTimeout(r, 200));
    const ok = writeRunLine(fx.fifo, encodeRunLine('later', 'echo still-here'));
    assert.equal(ok, true, 'driver still reading after EOF');
    const rc = await withTimeout(
      waitForDone(fx.doneDir, 'later', new AbortController().signal),
      5000,
      'waitForDone later',
    );
    assert.equal(rc, 0);
    assert.match(readFileSync(join(fx.idsDir, 'later'), 'utf8'), /still-here/);
  });

  test('an interrupted pipeline also reports a non-zero rc and the loop survives', async () => {
    const fx = makeFixture();
    writeRunLine(fx.fifo, encodeRunLine('pipe', 'sleep 100 | cat'));
    await new Promise((r) => setTimeout(r, 300));
    if (fx.child?.pid) {
      try {
        process.kill(-fx.child.pid, 'SIGINT');
      } catch {
        /* best effort */
      }
    }
    const rc = await withTimeout(
      waitForDone(fx.doneDir, 'pipe', new AbortController().signal),
      6000,
      'waitForDone pipe (interrupted)',
    );
    assert.notEqual(rc, 0, 'interrupted pipeline is non-zero');
    // Loop survived.
    writeRunLine(fx.fifo, encodeRunLine('ok', 'echo ok'));
    const rc2 = await withTimeout(
      waitForDone(fx.doneDir, 'ok', new AbortController().signal),
      5000,
      'waitForDone ok',
    );
    assert.equal(rc2, 0);
  });
});

describe('writeRunLine ENXIO (no reader)', () => {
  test('returns false and does NOT hang when no driver is reading the FIFO', async () => {
    const fx = makeFixture(false); // FIFO exists but NO driver
    // Must return promptly; wrap in a timeout guard so a hang fails the test.
    const result = await withTimeout(
      Promise.resolve().then(() => writeRunLine(fx.fifo, encodeRunLine('x', 'echo nope'))),
      2000,
      'writeRunLine with no reader',
    );
    assert.equal(result, false, 'no reader → false (ENXIO), without blocking');
  });
});

describe('waitForDone abort', () => {
  test('rejects promptly when the AbortController is aborted', async () => {
    const fx = makeFixture();
    writeRunLine(fx.fifo, encodeRunLine('slow', 'sleep 100'));
    const ac = new AbortController();
    const p = waitForDone(fx.doneDir, 'slow', ac.signal);
    setTimeout(() => ac.abort(), 100);
    await withTimeout(
      assert.rejects(() => p, (err: Error) => {
        // AbortError-shaped.
        assert.ok(/abort/i.test(err.name) || /abort/i.test(err.message), 'rejects with an abort-shaped error');
        return true;
      }),
      1500,
      'waitForDone abort',
    );
  });
});

describe('waitForDone atomic done-file', () => {
  test('does not resolve on a .tmp file; resolves only after the rename into place', async () => {
    const fx = makeFixture(false); // no driver; we create the done-file by hand
    const tmp = join(fx.doneDir, '.x.tmp');
    const finalPath = join(fx.doneDir, 'x');
    writeFileSync(tmp, '0\n');

    const ac = new AbortController();
    let resolved = false;
    const p = waitForDone(fx.doneDir, 'x', ac.signal).then((rc) => {
      resolved = true;
      return rc;
    });

    // Give the watcher a moment — it must NOT resolve off the .tmp file.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(resolved, false, 'the temp file must not satisfy waitForDone');
    assert.ok(existsSync(tmp), 'temp still present');

    // Atomically move into place → now it resolves with the parsed rc.
    renameSync(tmp, finalPath);
    const rc = await withTimeout(p, 2000, 'waitForDone after rename');
    assert.equal(rc, 0);
  });
});
