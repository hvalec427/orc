import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, readRawConfig, writeRawConfig, type RawConfig } from '../src/config.js';
import {
  emptyDraft,
  draftFromProject,
  draftFromGlobals,
  draftToRawProject,
  overridableFromDraft,
  upsertProject,
  applyGlobals,
  validatePortRange,
  parseEnvLines,
  type Draft,
} from '../src/setupEdit.js';

/** Run `fn` with a temp config path seeded with `doc`, cleaning up afterwards. */
function withTempConfig(doc: RawConfig, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'orc-setup-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(doc));
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function filled(overrides: Partial<Draft>): Draft {
  return { ...emptyDraft(), ...overrides };
}

test('draftToRawProject omits blank optional fields', () => {
  const entry = draftToRawProject(filled({ name: 'A', path: '/tmp/a' }));
  assert.deepEqual(entry, { name: 'A', path: '/tmp/a' });
});

test('draftToRawProject writes set scalar/enum fields', () => {
  const entry = draftToRawProject(
    filled({ name: 'A', path: '/tmp/a', model: 'claude-x', mergeStrategy: 'squash-merge', portRange: '8000-8099' }),
  );
  assert.deepEqual(entry, {
    name: 'A',
    path: '/tmp/a',
    model: 'claude-x',
    mergeStrategy: 'squash-merge',
    portRange: '8000-8099',
  });
});

test('settingSources is written only when explicitly set', () => {
  const unset = overridableFromDraft(filled({ settingSources: ['user'], settingSourcesSet: false }));
  assert.ok(!('settingSources' in unset), 'unset should be omitted');
  const set = overridableFromDraft(filled({ settingSources: ['user', 'local'], settingSourcesSet: true }));
  assert.deepEqual(set.settingSources, ['user', 'local']);
  const cleared = overridableFromDraft(filled({ settingSources: [], settingSourcesSet: true }));
  assert.deepEqual(cleared.settingSources, []);
});

test('maestroMcp is assembled from command/args/env and omitted when command blank', () => {
  const none = overridableFromDraft(filled({ maestroArgs: 'mcp', maestroEnv: 'A=1' }));
  assert.ok(!('maestroMcp' in none), 'no command => no maestroMcp');
  const full = overridableFromDraft(
    filled({ maestroCommand: 'maestro', maestroArgs: 'mcp --flag', maestroEnv: 'A=1\nB=two' }),
  );
  assert.deepEqual(full.maestroMcp, {
    command: 'maestro',
    args: ['mcp', '--flag'],
    env: { A: '1', B: 'two' },
  });
  const bare = overridableFromDraft(filled({ maestroCommand: 'maestro' }));
  assert.deepEqual(bare.maestroMcp, { command: 'maestro' });
});

test('parseEnvLines ignores blanks and malformed lines', () => {
  assert.deepEqual(parseEnvLines('A=1\n\n  B = two \nnope\n=bad'), { A: '1', B: 'two' });
});

test('validatePortRange accepts blank and valid, rejects malformed/backwards', () => {
  assert.equal(validatePortRange(''), null);
  assert.equal(validatePortRange('8000-8099'), null);
  assert.match(validatePortRange('abc')!, /8000-8099/);
  assert.match(validatePortRange('9-1')!, /start <= end/);
});

test('upsertProject appends a new project', () => {
  const res = upsertProject({ projects: [] }, null, filled({ name: 'A', path: '/tmp/a' }));
  assert.ok(res.ok);
  assert.deepEqual(res.config!.projects, [{ name: 'A', path: '/tmp/a' }]);
});

test('upsertProject rejects duplicate name on add', () => {
  const res = upsertProject({ projects: [{ name: 'A', path: '/tmp/a' }] }, null, filled({ name: 'A', path: '/tmp/b' }));
  assert.equal(res.ok, false);
  assert.match(res.error!, /already exists/);
});

test('upsertProject requires name and path', () => {
  assert.match(upsertProject({ projects: [] }, null, filled({ path: '/tmp/a' })).error!, /name is required/);
  assert.match(upsertProject({ projects: [] }, null, filled({ name: 'A' })).error!, /path is required/);
});

test('upsertProject edits in place, preserves unknown keys, drops cleared managed keys', () => {
  const current: RawConfig = {
    projects: [{ name: 'A', path: '/tmp/a', model: 'old', futureKey: 42 } as never],
  };
  // Edit: keep name, change path, clear model (leave blank).
  const res = upsertProject(current, 'A', filled({ name: 'A', path: '/tmp/new' }));
  assert.ok(res.ok);
  assert.deepEqual(res.config!.projects[0], { futureKey: 42, name: 'A', path: '/tmp/new' });
});

test('upsertProject allows renaming to a non-conflicting name', () => {
  const current: RawConfig = { projects: [{ name: 'A', path: '/tmp/a' }, { name: 'B', path: '/tmp/b' }] };
  const ok = upsertProject(current, 'A', filled({ name: 'C', path: '/tmp/a' }));
  assert.ok(ok.ok);
  assert.deepEqual(ok.config!.projects.map((p) => p.name), ['C', 'B']);
  const clash = upsertProject(current, 'A', filled({ name: 'B', path: '/tmp/a' }));
  assert.equal(clash.ok, false);
});

test('applyGlobals sets top-level keys and preserves projects + unknown keys', () => {
  const current: RawConfig = { $schema: 'x', projects: [{ name: 'A', path: '/tmp/a' }] } as RawConfig;
  const res = applyGlobals(current, filled({ model: 'claude-x', mergeStrategy: 'rebase' }));
  assert.ok(res.ok);
  assert.equal(res.config!.model, 'claude-x');
  assert.equal(res.config!.mergeStrategy, 'rebase');
  assert.equal((res.config as RawConfig).$schema, 'x');
  assert.deepEqual(res.config!.projects, [{ name: 'A', path: '/tmp/a' }]);
});

test('applyGlobals removes a managed global key when cleared', () => {
  const current: RawConfig = { model: 'old', projects: [{ name: 'A', path: '/tmp/a' }] } as RawConfig;
  const res = applyGlobals(current, filled({})); // model blank => removed
  assert.ok(res.ok);
  assert.ok(!('model' in res.config!), 'cleared model should be removed');
});

test('round-trip: a project authored via the wizard loads cleanly', () => {
  withTempConfig({ projects: [] }, (path) => {
    const current = readRawConfig(path);
    const res = upsertProject(
      current,
      null,
      filled({
        name: 'Acme iOS',
        path: '/tmp/acme',
        type: 'react-native',
        mergeStrategy: 'squash-rebase',
        portRange: '8000-8099',
        settingSources: ['user', 'project'],
        settingSourcesSet: true,
        maestroCommand: 'maestro',
        maestroArgs: 'mcp',
      }),
    );
    assert.ok(res.ok);
    writeRawConfig(path, res.config!);

    const loaded = loadConfig({ config: path });
    const p = loaded.projects[0];
    assert.equal(p.name, 'Acme iOS');
    assert.equal(p.mergeStrategy, 'squash-rebase');
    assert.deepEqual(p.portRange, { start: 8000, end: 8099 });
    assert.deepEqual(p.settingSources, ['user', 'project']);
    assert.deepEqual(p.maestroMcp, { command: 'maestro', args: ['mcp'] });
  });
});

test('round-trip: editing then loading reflects the change', () => {
  withTempConfig({ projects: [{ name: 'A', path: '/tmp/a', model: 'old' }] }, (path) => {
    const res = upsertProject(
      readRawConfig(path),
      'A',
      draftFromProject({ name: 'A', path: '/tmp/a', model: 'new' }),
    );
    assert.ok(res.ok);
    writeRawConfig(path, res.config!);
    assert.equal(loadConfig({ config: path }).projects[0].model, 'new');
  });
});

test('draftFromGlobals reads existing top-level defaults', () => {
  const d = draftFromGlobals({ model: 'claude-x', mergeStrategy: 'merge', projects: [] } as RawConfig);
  assert.equal(d.model, 'claude-x');
  assert.equal(d.mergeStrategy, 'merge');
});
