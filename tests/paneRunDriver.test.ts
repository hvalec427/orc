import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  encodeInjectedCommand,
  parseCapturedRun,
  waitForCapture,
} from '../src/tmux/paneRun.js';

// These tests exercise the capture protocol WITHOUT tmux: a real bash evaluates the exact line orc
// would type into an agent's interactive shell (encodeInjectedCommand), redirecting its output into a
// capture file just as `tmux pipe-pane` would. waitForCapture then reads back the framed result.

interface Fixture {
  dir: string;
  capture: string;
  child?: ChildProcess;
}
const fixtures: Fixture[] = [];

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'orc-cap-'));
  const capture = join(dir, 'a1.cap');
  writeFileSync(capture, '');
  const fx: Fixture = { dir, capture };
  fixtures.push(fx);
  return fx;
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

/** Run the injected line in a real bash, appending its output to the capture file (like pipe-pane). */
function runInjected(fx: Fixture, runId: string, cmd: string): ChildProcess {
  const line = encodeInjectedCommand(runId, cmd);
  const child = spawn('bash', ['-c', `{ ${line} ; } >> ${JSON.stringify(fx.capture)} 2>&1`], {
    stdio: 'ignore',
  });
  fx.child = child;
  return child;
}

describe('encodeInjectedCommand', () => {
  test('frames the command with BEGIN/END sentinels and the run id', () => {
    const line = encodeInjectedCommand('abc', 'echo hi');
    assert.match(line, /<<<ORC-BEGIN abc>>>/);
    assert.match(line, /<<<ORC-END/);
    assert.match(line, /echo hi/);
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

describe('capture protocol end-to-end (real bash, no tmux)', () => {
  test('a simple echo is framed, captured, and read back with rc 0', async () => {
    const fx = makeFixture();
    runInjected(fx, 'r1', 'echo hi');
    const res = await withTimeout(
      waitForCapture(fx.capture, 'r1', 0, new AbortController().signal),
      5000,
      'waitForCapture r1',
    );
    assert.equal(res.rc, 0);
    assert.match(res.output, /hi/);
  });

  test('a non-zero exit is reported via the END sentinel', async () => {
    const fx = makeFixture();
    runInjected(fx, 'r1', 'echo boom; exit 7');
    const res = await withTimeout(
      waitForCapture(fx.capture, 'r1', 0, new AbortController().signal),
      5000,
      'waitForCapture r1',
    );
    assert.equal(res.rc, 7);
    assert.match(res.output, /boom/);
  });

  test('a second run after the first is parsed independently from its own offset', async () => {
    const fx = makeFixture();
    runInjected(fx, 'r1', 'echo first');
    await withTimeout(waitForCapture(fx.capture, 'r1', 0, new AbortController().signal), 5000, 'r1');
    const offset = (await import('node:fs')).statSync(fx.capture).size;
    // Reuse the fixture's capture file for a second injected run.
    const line2 = encodeInjectedCommand('r2', 'echo second');
    fx.child = spawn('bash', ['-c', `{ ${line2} ; } >> ${JSON.stringify(fx.capture)} 2>&1`], {
      stdio: 'ignore',
    });
    const res = await withTimeout(
      waitForCapture(fx.capture, 'r2', offset, new AbortController().signal),
      5000,
      'waitForCapture r2',
    );
    assert.equal(res.rc, 0);
    assert.match(res.output, /second/);
    assert.doesNotMatch(res.output, /first/);
  });

  test('waitForCapture rejects promptly when the AbortController is aborted', async () => {
    const fx = makeFixture();
    // No frame is ever written for r1, so only the abort can settle it.
    const ac = new AbortController();
    const p = waitForCapture(fx.capture, 'r1', 0, ac.signal);
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
    appendFileSync(fx.capture, '<<<ORC-BEGIN r1>>>\npartial\n');
    const p = waitForCapture(fx.capture, 'r1', 0, new AbortController().signal);
    setTimeout(() => appendFileSync(fx.capture, '<<<ORC-END r1 0>>>\n'), 150);
    const res = await withTimeout(p, 2000, 'late END');
    assert.equal(res.rc, 0);
    assert.match(res.output, /partial/);
  });
});
