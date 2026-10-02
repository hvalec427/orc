import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentManager } from '../src/agent/AgentManager.js';
import { AgentSession, type AgentSessionInit } from '../src/agent/AgentSession.js';
import type { OrcConfig, ProjectConfig } from '../src/types.js';

const PROJECT: ProjectConfig = {
  name: 'demo',
  type: 'orc',
  repo: '/tmp/demo',
  model: 'claude-sonnet-4',
  worktreeDir: '.worktrees',
  permissionMode: 'bypassPermissions',
  settingSources: ['project'],
  mergeStrategy: 'rebase',
};

const CONFIG: OrcConfig = { projects: [PROJECT] };

/** A never-launched AgentSession we can drop straight into the manager's map. */
function makeSession(id: string, over: Partial<AgentSessionInit> = {}): AgentSession {
  const init: AgentSessionInit = {
    id,
    name: id,
    template: 'feature',
    ticket: '',
    prompt: 'do the thing',
    config: PROJECT,
    branch: `agent/${id}`,
    worktree: `/tmp/demo/.worktrees/${id}`,
    metroPort: 4000,
    ...over,
  };
  return new AgentSession(init);
}

/** Build a manager and register the given sessions directly (no real launch). */
function managerWith(sessions: AgentSession[]): AgentManager {
  const manager = new AgentManager(CONFIG);
  const map = (manager as unknown as { agents: Map<string, AgentSession> }).agents;
  for (const s of sessions) map.set(s.id, s);
  return manager;
}

test('archive() sets the flag, keeps the session, emits update, and does not stop it', async () => {
  const s = makeSession('a1');
  const manager = managerWith([s]);

  let stopped = false;
  (s as unknown as { stop: () => Promise<void> }).stop = async () => {
    stopped = true;
  };
  let updates = 0;
  manager.on('update', () => updates++);

  await manager.archive('a1');

  assert.equal(s.getInfo().archived, true, 'the flag is set');
  assert.equal(manager.get('a1'), s, 'the session stays in the map');
  assert.equal(stopped, false, 'archiving does not stop the session');
  assert.ok(updates >= 1, 'archiving emits an update');
});

test('archive() does not touch the worktree or release the port', async () => {
  const s = makeSession('a1');
  const manager = managerWith([s]);
  const ports = (manager as unknown as { ports: Map<string, { release: () => void }> }).ports;

  // Port allocator for this project would be the thing a destructive remove releases.
  let released = false;
  ports.set(PROJECT.name, { release: () => (released = true) } as never);

  await manager.archive('a1');

  assert.equal(s.worktree, '/tmp/demo/.worktrees/a1', 'worktree path is untouched');
  assert.equal(s.branch, 'agent/a1', 'branch is untouched');
  assert.equal(released, false, 'the port is not released');
});

test('archiving a parent cascades to its children', async () => {
  const parent = makeSession('p1');
  const child = makeSession('c1', { parentId: 'p1', template: 'merge', branch: undefined, worktree: undefined, metroPort: undefined });
  const manager = managerWith([parent, child]);

  await manager.archive('p1');

  assert.equal(parent.getInfo().archived, true, 'parent archived');
  assert.equal(child.getInfo().archived, true, 'child archived with its parent');
});

test('unarchive() clears the flag and leaves children alone', async () => {
  const parent = makeSession('p1');
  const child = makeSession('c1', { parentId: 'p1' });
  const manager = managerWith([parent, child]);

  await manager.archive('p1');
  await manager.unarchive('p1');

  assert.equal(parent.getInfo().archived, false, 'parent is back');
  assert.equal(child.getInfo().archived, true, 'unarchive does not cascade to children');
});

test('active()/archived() partition the agents', async () => {
  const a = makeSession('a1');
  const b = makeSession('b1');
  const manager = managerWith([a, b]);

  await manager.archive('b1');

  assert.deepEqual(manager.active().map((s) => s.id), ['a1'], 'active excludes archived');
  assert.deepEqual(manager.archived().map((s) => s.id), ['b1'], 'archived lists only archived');
});

test('topLevel() includes archived agents (so j/k can walk the Done section); firstWaiting() excludes them', async () => {
  const a = makeSession('a1');
  const b = makeSession('b1');
  const manager = managerWith([a, b]);

  // Mark both as waiting for input so firstWaiting would otherwise return one.
  (a as unknown as { status: string }).status = 'needs_input';
  (b as unknown as { status: string }).status = 'needs_input';

  await manager.archive('a1');

  assert.deepEqual(
    manager.topLevel().map((s) => s.id).sort(),
    ['a1', 'b1'],
    'archived agents stay in topLevel so navigation can reach the Done section',
  );
  // topLevelSibling gates archived agents behind includeArchived (the Done section's expanded state).
  assert.deepEqual(
    manager.topLevelSibling('b1', -1, false)?.id,
    'b1',
    'with the Done section collapsed, k off the only active agent stays put',
  );
  assert.deepEqual(
    manager.topLevelSibling('b1', 1, true)?.id,
    'a1',
    'with the Done section expanded, j steps onto the archived agent',
  );
  assert.equal(manager.firstWaiting()?.id, 'b1', 'firstWaiting skips the archived agent');
});

test('sidebar child navigation skips archived siblings', async () => {
  // Parent with three children added in order; the first two get archived, leaving only the newest
  // (c3) active under the parent. Navigation into the group must land on c3, not on an archived one.
  const parent = makeSession('p1');
  const c1 = makeSession('c1', { parentId: 'p1' });
  const c2 = makeSession('c2', { parentId: 'p1' });
  const c3 = makeSession('c3', { parentId: 'p1' });
  const manager = managerWith([parent, c1, c2, c3]);

  await manager.archive('c1');
  await manager.archive('c2');

  assert.deepEqual(
    manager.activeChildrenOf('p1').map((s) => s.id),
    ['c3'],
    'only the still-active child remains under the parent',
  );
  assert.equal(
    manager.firstActiveChildOf('p1')?.id,
    'c3',
    'entering the group (l) lands on the active child, not an archived one',
  );
  // j/k among siblings stays on c3 — it is the only active sibling, so there is nowhere to step.
  assert.equal(manager.siblingOf('c3', -1)?.id, 'c3', 'k off the only active child stays put');
  assert.equal(manager.siblingOf('c3', 1)?.id, 'c3', 'j off the only active child stays put');
});

test('getInfo() exposes the archived flag that persist() serializes', async () => {
  // persist() writes to a fixed path under the real home, so rather than hit the filesystem we
  // assert on getInfo(), the single source persist() serializes each agent from.
  const s = makeSession('a1');
  const manager = managerWith([s]);

  assert.equal(s.getInfo().archived, false, 'defaults to not archived');
  await manager.archive('a1');
  assert.equal(s.getInfo().archived, true, 'reflects the archive');
});
