import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildSetupScript,
  encodeInjectedCall,
  parseCapturedRun,
  waitForCapture,
} from '../src/tmux/paneRun.js';

// These tests exercise the capture protocol WITHOUT tmux: a real zsh sources the setup script (which
// defines __orc_run) and then runs the exact short call orc would inject (encodeInjectedCall). __orc_run
// writes the framed output + rc to the per-run RESULT FILE (just as it does in a real pane), and
// waitForCapture then reads back the result. The command text lives in a cmd file, as orc stages it.

interface Fixture {
  dir: string;
  child?: ChildProcess;
}
const fixtures: Fixture[] = [];

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'orc-cap-'));
  const fx: Fixture = { dir };
  fixtures.push(fx);
  return fx;
}

/** Path of a run's result file inside a fixture (where __orc_run writes the framed output). */
function resultPath(fx: Fixture, token: string): string {
  return join(fx.dir, `${token}.res`);
}

afterEach(() => {
  for (const fx of fixtures.splice(0)) {
    if (fx.child && fx.child.pid) {
      try {
        fx.child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    try {
      rmSync(fx.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ]);
}

/**
 * Run a command the way a real agent shell does: a non-interactive zsh sources the setup script (which
 * defines __orc_run), then runs the exact short call orc injects. __orc_run writes the framed result to
 * the run's result file. The command text is staged in a cmd file first, as orc does. Returns the
 * result-file path so waitForCapture can read it back.
 */
function runInjected(fx: Fixture, token: string, cmd: string): { child: ChildProcess; res: string } {
  const cmdPath = join(fx.dir, `${token}.cmd`);
  const res = resultPath(fx, token);
  writeFileSync(cmdPath, cmd);
  writeFileSync(res, '');
  // -f: skip rc files, like the real agent shell. Source the setup (which records __ORC_DIR and defines
  // __orc_run), then run the exact bare-token call orc injects.
  const script = `${buildSetupScript(fx.dir)}\n${encodeInjectedCall(token)}\n`;
  const child = spawn('zsh', ['-fc', script], { stdio: 'ignore' });
  fx.child = child;
  return { child, res };
}

describe('encodeInjectedCall', () => {
  test('is a short bare __orc_run call carrying only the run token', () => {
    const line = encodeInjectedCall('abc');
    assert.equal(line, "__orc_run 'abc'");
  });
});

describe('parseCapturedRun (pure)', () => {
  test('returns null when the END sentinel is absent', () => {
    const buf = '<<<ORC-BEGIN r1>>>\nsome partial output\n';
    assert.equal(parseCapturedRun(buf, 'r1'), null);
  });

  test('extracts exactly the output between BEGIN and END and parses rc 0', () => {
    const buf = 'noise\n<<<ORC-BEGIN r1>>>\nhello\nworld\n<<<ORC-END r1 0>>>\ntrailing\n';
    const res = parseCapturedRun(buf, 'r1');
    assert.deepEqual(res, { output: 'hello\nworld', rc: 0 });
  });

  test('parses a non-zero rc', () => {
    const buf = '<<<ORC-BEGIN r1>>>\nboom\n<<<ORC-END r1 7>>>\n';
    assert.equal(parseCapturedRun(buf, 'r1')?.rc, 7);
  });

  test('respects fromOffset, ignoring earlier bytes', () => {
    const early = '<<<ORC-BEGIN r1>>>\nstale\n<<<ORC-END r1 0>>>\n';
    const later = '<<<ORC-BEGIN r2>>>\nfresh\n<<<ORC-END r2 3>>>\n';
    const buf = early + later;
    const res = parseCapturedRun(buf, 'r2', early.length);
    assert.deepEqual(res, { output: 'fresh', rc: 3 });
  });

  test('tolerates interleaved user typing inside the frame', () => {
    const buf = '<<<ORC-BEGIN r1>>>\nagent-out\nuser typed this\n<<<ORC-END r1 0>>>\n';
    const res = parseCapturedRun(buf, 'r1');
    assert.match(res!.output, /agent-out/);
    assert.match(res!.output, /user typed this/);
  });

  test('strips ANSI control sequences from the captured output', () => {
    const buf = '<<<ORC-BEGIN r1>>>\n\u001b[31mred\u001b[0m\n<<<ORC-END r1 0>>>\n';
    assert.equal(parseCapturedRun(buf, 'r1')?.output, 'red');
  });
});

describe('capture protocol end-to-end (real zsh, no tmux)', () => {
  test('a simple echo is framed, captured, and read back with rc 0', async () => {
    const fx = makeFixture();
    const { res } = runInjected(fx, 'r1', 'echo hi');
    const r = await withTimeout(
      waitForCapture(res, 'r1', 0, new AbortController().signal),
      5000,
      'waitForCapture r1',
    );
    assert.equal(r.rc, 0);
    assert.match(r.output, /hi/);
  });

  test('a non-zero exit is reported via the END sentinel', async () => {
    const fx = makeFixture();
    const { res } = runInjected(fx, 'r1', 'echo boom; exit 7');
    const r = await withTimeout(
      waitForCapture(res, 'r1', 0, new AbortController().signal),
      5000,
      'waitForCapture r1',
    );
    assert.equal(r.rc, 7);
    assert.match(r.output, /boom/);
  });

  test('the result file contains only the output — no banner, prompt, or sentinel noise', async () => {
    const fx = makeFixture();
    const { res } = runInjected(fx, 'r1', 'echo only-this');
    const r = await withTimeout(
      waitForCapture(res, 'r1', 0, new AbortController().signal),
      5000,
      'waitForCapture r1',
    );
    // The captured output is exactly the command's output: no "$ echo…" banner, no prompt.
    assert.equal(r.output, 'only-this');
  });

  test('two runs write independent result files parsed on their own', async () => {
    const fx = makeFixture();
    const a = runInjected(fx, 'r1', 'echo first');
    await withTimeout(waitForCapture(a.res, 'r1', 0, new AbortController().signal), 5000, 'r1');
    const b = runInjected(fx, 'r2', 'echo second');
    const r = await withTimeout(
      waitForCapture(b.res, 'r2', 0, new AbortController().signal),
      5000,
      'waitForCapture r2',
    );
    assert.equal(r.rc, 0);
    assert.match(r.output, /second/);
    assert.doesNotMatch(r.output, /first/);
  });

  test('waitForCapture rejects promptly when the AbortController is aborted', async () => {
    const fx = makeFixture();
    // No frame is ever written for r1, so only the abort can settle it.
    const res = resultPath(fx, 'r1');
    writeFileSync(res, '');
    const ac = new AbortController();
    const p = waitForCapture(res, 'r1', 0, ac.signal);
    setTimeout(() => ac.abort(), 100);
    await withTimeout(
      assert.rejects(() => p, (err: Error) => {
        assert.ok(/abort/i.test(err.name) || /abort/i.test(err.message), 'abort-shaped error');
        return true;
      }),
      1500,
      'waitForCapture abort',
    );
  });

  test('waitForCapture resolves as the END sentinel is appended after the fact', async () => {
    const fx = makeFixture();
    const res = resultPath(fx, 'r1');
    writeFileSync(res, '<<<ORC-BEGIN r1>>>\npartial\n');
    const p = waitForCapture(res, 'r1', 0, new AbortController().signal);
    setTimeout(() => appendFileSync(res, '<<<ORC-END r1 0>>>\n'), 150);
    const r = await withTimeout(p, 2000, 'late END');
    assert.equal(r.rc, 0);
    assert.match(r.output, /partial/);
  });
});
