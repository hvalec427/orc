import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';

/** Write a config.json into a throwaway dir and load it, cleaning up afterwards. */
function withConfig(doc: unknown, fn: (load: () => ReturnType<typeof loadConfig>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'orc-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(doc));
  try {
    fn(() => loadConfig({ config: path }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('mergeStrategy resolves per-project over global over default rebase', () => {
  withConfig(
    {
      mergeStrategy: 'merge',
      projects: [
        { name: 'Override', path: '/tmp/a', mergeStrategy: 'squash-merge' },
        { name: 'InheritsGlobal', path: '/tmp/b' },
      ],
    },
    (load) => {
      const { projects } = load();
      const byName = Object.fromEntries(projects.map((p) => [p.name, p]));
      assert.equal(byName['Override'].mergeStrategy, 'squash-merge', 'per-project should win');
      assert.equal(byName['InheritsGlobal'].mergeStrategy, 'merge', 'should inherit global');
    },
  );
});

test('mergeStrategy defaults to rebase when unset anywhere', () => {
  withConfig({ projects: [{ name: 'Plain', path: '/tmp/a' }] }, (load) => {
    assert.equal(load().projects[0].mergeStrategy, 'rebase');
  });
});

test('an invalid mergeStrategy is rejected', () => {
  withConfig({ projects: [{ name: 'Bad', path: '/tmp/a', mergeStrategy: 'octopus' }] }, (load) => {
    assert.throws(load, /Invalid config/);
  });
});
