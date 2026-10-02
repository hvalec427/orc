import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';

/** Write a config.json into a throwaway dir and load it, cleaning up afterwards. */
function withConfig(doc: unknown, fn: (load: () => ReturnType<typeof loadConfig>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'orc-config-tmux-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(doc));
  try {
    fn(() => loadConfig({ config: path }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('config tmux flag', () => {
  test('"tmux": false loads to config.tmux === false', () => {
    withConfig({ tmux: false, projects: [{ name: 'Plain', path: '/tmp/a' }] }, (load) => {
      assert.equal(load().tmux, false);
    });
  });

  test('"tmux": true loads to config.tmux === true', () => {
    withConfig({ tmux: true, projects: [{ name: 'Plain', path: '/tmp/a' }] }, (load) => {
      assert.equal(load().tmux, true);
    });
  });

  test('absent tmux leaves config.tmux === undefined', () => {
    withConfig({ projects: [{ name: 'Plain', path: '/tmp/a' }] }, (load) => {
      assert.equal(load().tmux, undefined);
    });
  });

  test('an unknown top-level key is still rejected by the strict schema', () => {
    withConfig({ bogusKey: 1, projects: [{ name: 'Plain', path: '/tmp/a' }] }, (load) => {
      assert.throws(load, /Invalid config/);
    });
  });
});
