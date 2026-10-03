import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  beginSentinel,
  endSentinelRe,
  buildSetupScript,
  encodeInjectedCall,
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

describe('result-file framing → parseCapturedRun round-trip', () => {
  // __orc_run writes only the BEGIN/END sentinels and the command's output into the result file; we
  // simulate that file for tricky commands and confirm the parser recovers exactly the output + rc.
  const CASES: Array<[string, string]> = [
    ['id1', 'hi'],
    ['id2', 'with spaces and quotes'],
    ['id3', 'single quoted $VAR'],
    ['id6', 'café 日本語 🚀'],
  ];
  for (const [id, out] of CASES) {
    test(`frames id=${id} out=${JSON.stringify(out)}`, () => {
      // Build a result file exactly as __orc_run's `print -r --` statements would write it.
      const buf = `${beginSentinel(id)}\n${out}\n<<<ORC-END ${id} 0>>>\n`;
      const res = parseCapturedRun(buf, id);
      assert.deepEqual(res, { output: out, rc: 0 });
    });
  }
});

describe('buildSetupScript installs a quiet pane protocol', () => {
  test('blanks the prompt, records the run dir, and defines the __orc_run helper', () => {
    const setup = buildSetupScript('/run/dir');
    // No prompt noise: PROMPT/RPROMPT are blanked.
    assert.match(setup, /PROMPT=''/);
    assert.match(setup, /RPROMPT=''/);
    // The run directory is recorded so the per-run call can stay a bare token.
    assert.ok(setup.includes("__ORC_DIR='/run/dir'"), 'records the run dir in $__ORC_DIR');
    // The helper the per-run call invokes, with paths derived from $__ORC_DIR + token.
    assert.match(setup, /__orc_run\(\)/);
    assert.ok(setup.includes('$__ORC_DIR/$__orc_tok.cmd'), 'derives the cmd path from dir + token');
    assert.ok(setup.includes('$__ORC_DIR/$__orc_tok.res'), 'derives the result path from dir + token');
    // Sentinels + rc are written to the RESULT FILE, never the pane.
    assert.match(setup, /<<<ORC-BEGIN /);
    assert.match(setup, /<<<ORC-END /);
    assert.match(setup, /\$\{pipestatus\[1\]\}/, 'captures the command rc, not tee rc');
    // Erases the single echoed call line before printing the clean banner.
    assert.ok(setup.includes('\\033[A'), 'moves the cursor up to erase the echoed call');
    assert.match(setup, /\$ \$__orc_cmd/, 'prints a "$ <cmd>" banner');
  });

  test("single-quotes in the run dir are escaped so $__ORC_DIR stays one safe token", () => {
    const setup = buildSetupScript("/it's/dir");
    assert.ok(setup.includes(`__ORC_DIR='/it'\\''s/dir'`), 'embedded quote is escaped');
  });
});

describe('encodeInjectedCall is a short, bare token call', () => {
  test('calls __orc_run with just the single-quoted run token', () => {
    assert.equal(encodeInjectedCall('abc123'), "__orc_run 'abc123'");
  });

  test('no command text or file paths pass through the injected line', () => {
    const line = encodeInjectedCall('abc123');
    assert.ok(!line.includes('/'), 'no file paths in the injected call');
    assert.ok(!line.includes('echo'), 'no command text in the injected call');
  });
});

describe('the result file contains no banner or prompt noise', () => {
  test('parses output + rc from a clean result file (no "$ cmd" banner line)', () => {
    // __orc_run prints the banner to the PANE, not the result file, so the file is sentinels + output.
    const buf = `${beginSentinel('r1')}\nhi\n<<<ORC-END r1 0>>>\n`;
    const res = parseCapturedRun(buf, 'r1');
    assert.deepEqual(res, { output: 'hi', rc: 0 });
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
