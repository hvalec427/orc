import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  beginSentinel,
  endSentinelRe,
  encodeInjectedCommand,
  ECHO_OFF_PRIMER,
  parseCapturedRun,
  parseRc,
  capOutput,
  slicePaneText,
} from '../src/tmux/paneRun.js';

describe('sentinels', () => {
  test('beginSentinel embeds the run id', () => {
    assert.equal(beginSentinel('abc'), '<<<ORC-BEGIN abc>>>');
  });

  test('endSentinelRe matches its own END line and captures the rc', () => {
    const m = endSentinelRe('abc').exec('x <<<ORC-END abc 7>>> y');
    assert.ok(m, 'matched');
    assert.equal(m![1], '7');
  });

  test('endSentinelRe captures a negative rc', () => {
    const m = endSentinelRe('abc').exec('<<<ORC-END abc -1>>>');
    assert.equal(m![1], '-1');
  });

  test('endSentinelRe does not match a different run id', () => {
    assert.equal(endSentinelRe('abc').exec('<<<ORC-END other 0>>>'), null);
  });
});

describe('encodeInjectedCommand → parseCapturedRun round-trip (framing only)', () => {
  // The injected line prints the sentinels; we simulate a shell that echoed the command's output
  // between them and confirm the parser recovers exactly that output + rc, for tricky commands.
  const CASES: Array<[string, string, string]> = [
    ['id1', 'echo hi', 'hi'],
    ['id2', 'echo "with spaces and quotes"', 'with spaces and quotes'],
    ['id3', "echo 'single quoted $VAR'", 'single quoted $VAR'],
    ['id6', 'echo "café 日本語 🚀"', 'café 日本語 🚀'],
  ];
  for (const [id, cmd, out] of CASES) {
    test(`frames id=${id} cmd=${JSON.stringify(cmd)}`, () => {
      const line = encodeInjectedCommand(id, cmd);
      assert.match(line, new RegExp(`<<<ORC-BEGIN ${id}>>>`));
      // Build a capture buffer as the shell would produce it.
      const buf = `\n${beginSentinel(id)}\n${out}\n<<<ORC-END ${id} 0>>>\n`;
      const res = parseCapturedRun(buf, id);
      assert.deepEqual(res, { output: out, rc: 0 });
    });
  }
});

describe('encodeInjectedCommand hides the wrapper and shows a clean command', () => {
  test('the echo-off primer is a standalone line sent before the wrapper', () => {
    // Echo must be disabled by its own already-complete line (ECHO_OFF_PRIMER), sent first, so the
    // terminal never echoes the long wrapper line back to the human.
    assert.ok(ECHO_OFF_PRIMER.includes('stty -echo'), 'the primer disables terminal echo');
  });

  test('prints a clean "$ <cmd>" banner and restores echo, without re-disabling it inline', () => {
    const line = encodeInjectedCommand('r1', 'echo hi');
    // The wrapper no longer carries `stty -echo`: disabling echo from inside this same line can't
    // suppress the echo of this very line, so that job moved to the standalone ECHO_OFF_PRIMER.
    assert.ok(!line.includes('stty -echo'), 'the wrapper does not re-disable echo inline');
    assert.ok(line.includes('stty echo'), 'the wrapper restores terminal echo afterwards');
    // A clean prompt-style banner shows just the command text to the human.
    assert.ok(line.includes('$ '), 'prints a "$ <cmd>" banner');
    assert.ok(line.includes('echo hi'), 'the banner carries the real command');
    // Sentinels are still present so orc can parse the output from the capture stream.
    assert.match(line, /<<<ORC-BEGIN r1>>>/);
    assert.match(line, /<<<ORC-END/);
  });

  test('the banner is excluded from captured OUTPUT', () => {
    // Simulate the capture: the banner line + sentinels + output, as the shell+pipe-pane would record.
    const buf = `$ echo hi\n${beginSentinel('r1')}\nhi\n<<<ORC-END r1 0>>>\n`;
    const res = parseCapturedRun(buf, 'r1');
    assert.deepEqual(res, { output: 'hi', rc: 0 }, 'output excludes the banner');
  });
});

describe('parseRc', () => {
  test('"0" → 0', () => {
    assert.equal(parseRc('0'), 0);
  });

  test('"130\\n" → 130 (trims)', () => {
    assert.equal(parseRc('130\n'), 130);
  });

  test('non-numeric → a negative failure sentinel', () => {
    assert.ok(parseRc('abc') < 0, 'non-numeric yields a negative sentinel');
  });
});

describe('capOutput', () => {
  test('under the cap is returned unchanged', () => {
    const s = 'hello world';
    assert.equal(capOutput(s, 1000), s);
  });

  test('empty input → empty output', () => {
    assert.equal(capOutput('', 1000), '');
  });

  test('over the cap keeps a head+tail slice with a middle elision marker', () => {
    const big = 'A'.repeat(5000) + 'B'.repeat(5000);
    const out = capOutput(big, 2000);
    assert.ok(out.length <= 2000 + 200, `capped length ${out.length} within cap+marker`);
    assert.ok(out.startsWith('A'), 'keeps the head');
    assert.ok(out.endsWith('B'), 'keeps the tail');
    assert.match(out, /(…|\.\.\.|omitted|truncated)/i, 'has an elision marker');
  });
});

describe('slicePaneText', () => {
  test('tailBytes returns the last N bytes and reports size', () => {
    const r = slicePaneText('0123456789', { tailBytes: 4 });
    assert.equal(r.text, '6789');
    assert.equal(r.size, 10);
    assert.equal(r.nextOffset, 10);
  });

  test('sinceOffset returns only the bytes after the offset', () => {
    const r = slicePaneText('0123456789', { sinceOffset: 7 });
    assert.equal(r.text, '789');
    assert.equal(r.nextOffset, 10);
  });

  test('a stale offset past the end yields empty text', () => {
    const r = slicePaneText('0123456789', { sinceOffset: 999 });
    assert.equal(r.text, '');
    assert.equal(r.nextOffset, 10);
  });
});
