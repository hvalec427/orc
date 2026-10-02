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

test('firstWaiting() excludes archived agents', async () => {
  const a = makeSession('a1');
  const b = makeSession('b1');
  const manager = managerWith([a, b]);

  // Mark both as waiting for input so firstWaiting would otherwise return one.
  (a as unknown as { status: string }).status = 'needs_input';
  (b as unknown as { status: string }).status = 'needs_input';

  await manager.archive('a1');

  assert.equal(manager.firstWaiting()?.id, 'b1', 'firstWaiting skips the archived agent');
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
