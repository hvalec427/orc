import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeRunLine,
  decodeRunLine,
  buildDriverScript,
  capOutput,
  parseDoneRc,
  decidePaneVsFallback,
} from '../src/tmux/paneRun.js';

// These target the NOT-YET-IMPLEMENTED src/tmux/paneRun.ts. They are expected to be RED until the
// implementer writes that module. Red reason: the import resolves nothing / functions are missing.

describe('encodeRunLine / decodeRunLine round-trip', () => {
  const CASES: Array<[string, string]> = [
    ['id1', 'echo hi'],
    ['id2', 'echo "with spaces and quotes"'],
    ['id3', "echo 'single quoted $VAR'"],
    ['id4', 'echo $(date) && ls -la'],
    ['id5', 'printf "a\nb\nc\n"'], // command text itself contains newlines
    ['id6', 'echo "café 日本語 🚀"'], // unicode
    ['id7', 'cat a | grep b | head -n 3'],
    ['id8', 'foo && bar || baz ; qux'],
  ];

  for (const [id, cmd] of CASES) {
    test(`round-trips id=${id} cmd=${JSON.stringify(cmd)}`, () => {
      const line = encodeRunLine(id, cmd);
      const decoded = decodeRunLine(line.replace(/\n$/, '')); // decode the payload line, sans trailing \n
      assert.ok(decoded, 'decodeRunLine returned a value');
      assert.equal(decoded!.id, id);
      assert.equal(decoded!.cmd, cmd);
    });
  }
});

describe('encodeRunLine format', () => {
  test('ends with a single trailing newline', () => {
    const line = encodeRunLine('id1', 'echo hi');
    assert.ok(line.endsWith('\n'), 'ends with \\n');
    assert.equal(line.indexOf('\n'), line.length - 1, 'the ONLY newline is the trailing one');
  });

  test('exactly one space separates id from the base64 payload', () => {
    const line = encodeRunLine('id1', 'echo hi').replace(/\n$/, '');
    const firstSpace = line.indexOf(' ');
    assert.ok(firstSpace > 0, 'there is a space');
    const payload = line.slice(firstSpace + 1);
    // The payload is valid single-line base64 (no interior space, no newline).
    assert.doesNotMatch(payload, /\s/, 'base64 payload has no whitespace');
    assert.equal(Buffer.from(payload, 'base64').toString('utf8'), 'echo hi');
  });

  test('base64 is single-line even for multi-line commands', () => {
    const line = encodeRunLine('id1', 'line1\nline2\nline3').replace(/\n$/, '');
    const payload = line.slice(line.indexOf(' ') + 1);
    assert.doesNotMatch(payload, /\n/, 'no interior newline in the base64');
    assert.equal(Buffer.from(payload, 'base64').toString('utf8'), 'line1\nline2\nline3');
  });
});

describe('decodeRunLine malformed input', () => {
  test('blank line → null', () => {
    assert.equal(decodeRunLine(''), null);
    assert.equal(decodeRunLine('   '), null);
  });

  test('no-space line (id only, no payload) → null', () => {
    assert.equal(decodeRunLine('idonly'), null);
  });
});

describe('buildDriverScript invariants', () => {
  const script = buildDriverScript({
    fifo: '/tmp/orc/a1.fifo',
    doneDir: '/tmp/orc/a1.done',
    idsDir: '/tmp/orc/a1.ids',
  });

  test("ignores SIGINT in the driver loop (trap '' INT)", () => {
    assert.ok(script.includes("trap '' INT"), "contains trap '' INT");
  });

  test('has an outer infinite loop (while :)', () => {
    assert.ok(script.includes('while :'), 'contains while :');
  });

  test('uses a PLAIN read (read -r id b64), NOT IFS= read', () => {
    assert.ok(script.includes('read -r id b64 < "$FIFO"'), 'plain read of id + b64 from the FIFO');
    assert.ok(!script.includes('IFS= read'), 'must NOT strip IFS (that would merge/eat fields)');
  });

  test('runs the child in a subshell that restores INT and execs bash -c', () => {
    assert.ok(
      script.includes('( trap - INT; exec bash -c "$cmd" )'),
      'child subshell restores INT and execs the command',
    );
  });

  test('tees the child output to the pane AND the per-id file', () => {
    // Output must reach the pane (driver stdout) so the human sees it live, while still being
    // captured to $IDS/$id for readPaneOutput. A bare `> "$IDS/$id"` would hide it from the pane.
    assert.ok(script.includes('2>&1 | tee "$IDS/$id"'), 'child stdout+stderr tee to the pane and $IDS/$id');
    assert.ok(!script.includes('> "$IDS/$id" 2>&1'), 'must NOT redirect output solely to the file');
  });

  test('captures the command exit code via PIPESTATUS, not tee', () => {
    assert.ok(script.includes('rc=${PIPESTATUS[0]}'), 'rc comes from the command, not the tee pipe');
  });

  test('writes the done-file atomically (temp + mv -f)', () => {
    assert.ok(script.includes('mv -f'), 'atomic rename via mv -f');
  });

  test("prints a command intent line before running (printf '$ %s\\n')", () => {
    assert.ok(script.includes("printf '$ %s\\n'") || script.includes("printf '$ %s\n'"), 'intent line printed');
  });

  test('single-quote-escapes the provided paths', () => {
    // The literal paths (or their single-quoted forms) appear in the script.
    assert.ok(script.includes('/tmp/orc/a1.fifo'), 'fifo path present');
    assert.ok(script.includes('/tmp/orc/a1.done'), 'done dir present');
    assert.ok(script.includes('/tmp/orc/a1.ids'), 'ids dir present');
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
    // Bounded length: cap plus a reasonable marker allowance.
    assert.ok(out.length <= 2000 + 200, `capped length ${out.length} within cap+marker`);
    // Head and tail survive.
    assert.ok(out.startsWith('A'), 'keeps the head');
    assert.ok(out.endsWith('B'), 'keeps the tail');
    // Some elision marker sits in the middle (… or "truncated" or "omitted").
    assert.match(out, /(…|\.\.\.|omitted|truncated)/i, 'has an elision marker');
  });
});

describe('parseDoneRc', () => {
  test('"0" → 0', () => {
    assert.equal(parseDoneRc('0'), 0);
  });

  test('"130\\n" → 130 (trims)', () => {
    assert.equal(parseDoneRc('130\n'), 130);
  });

  test('non-numeric → a negative failure sentinel', () => {
    assert.ok(parseDoneRc('abc') < 0, 'non-numeric yields a negative sentinel');
  });
});

describe('decidePaneVsFallback truth table', () => {
  const T = true;
  const F = false;
  // All 8 combinations of (tmuxOn, isSelected, fifoWritable).
  const rows: Array<{ tmuxOn: boolean; isSelected: boolean; fifoWritable: boolean; expect: 'pane' | 'fallback' }> = [
    { tmuxOn: T, isSelected: T, fifoWritable: T, expect: 'pane' },
    { tmuxOn: F, isSelected: T, fifoWritable: T, expect: 'fallback' },
    { tmuxOn: T, isSelected: F, fifoWritable: T, expect: 'fallback' },
    { tmuxOn: T, isSelected: T, fifoWritable: F, expect: 'fallback' },
    { tmuxOn: F, isSelected: F, fifoWritable: T, expect: 'fallback' },
    { tmuxOn: F, isSelected: T, fifoWritable: F, expect: 'fallback' },
    { tmuxOn: T, isSelected: F, fifoWritable: F, expect: 'fallback' },
    { tmuxOn: F, isSelected: F, fifoWritable: F, expect: 'fallback' },
  ];
  for (const r of rows) {
    test(`tmuxOn=${r.tmuxOn} isSelected=${r.isSelected} fifoWritable=${r.fifoWritable} → ${r.expect}`, () => {
      assert.equal(
        decidePaneVsFallback({ tmuxOn: r.tmuxOn, isSelected: r.isSelected, fifoWritable: r.fifoWritable }),
        r.expect,
      );
    });
  }
});
