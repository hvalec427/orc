import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentManager } from '../src/agent/AgentManager.js';
import type { AgentSession } from '../src/agent/AgentSession.js';
import { PortAllocator } from '../src/ports.js';
import { SimulatorAllocator } from '../src/simulators.js';
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
  portRange: { start: 4000, end: 4100 },
};

const CONFIG: OrcConfig = { projects: [PROJECT] };

const RN_PROJECT: ProjectConfig = { ...PROJECT, name: 'rn', type: 'react-native' };
const RN_CONFIG: OrcConfig = { projects: [RN_PROJECT] };

/** Shape of one persisted agent, loose enough to build test fixtures. */
type Persisted = Record<string, unknown>;

/** A manager whose loadState() returns the given persisted agents (no filesystem). */
function managerLoading(agents: Persisted[]): AgentManager {
  const manager = new AgentManager(CONFIG);
  (manager as unknown as { loadState(): { agents: Persisted[] } }).loadState = () => ({ agents });
  return manager;
}

/** A manager over the react-native config whose loadState() returns the given agents. */
function rnManagerLoading(agents: Persisted[]): AgentManager {
  const manager = new AgentManager(RN_CONFIG);
  (manager as unknown as { loadState(): { agents: Persisted[] } }).loadState = () => ({ agents });
  return manager;
}

const base = (over: Persisted = {}): Persisted => ({
  id: 'a1',
  name: 'alpha',
  template: 'feature',
  project: 'demo',
  ticket: '',
  branch: 'agent/a1',
  worktree: '/tmp/demo/.worktrees/a1',
  ownsWorktree: true,
  metroPort: 4000,
  sessionId: 'sess-a1',
  status: 'working',
  archived: false,
  ...over,
});

test('restore() reconstructs a persisted agent as a stopped, resumable session', () => {
  const manager = managerLoading([base()]);
  manager.restore();

  const restored = manager.get('a1');
  assert.ok(restored, 'the agent is registered');
  const info = restored!.getInfo();
  // Persisted as 'working' (orc killed mid-turn) but must come back resumable, not claiming to work.
  assert.equal(info.status, 'stopped', 'status is clamped to stopped');
  assert.equal(info.sessionId, 'sess-a1', 'prior Claude session id is seeded for resume');
  assert.equal(info.branch, 'agent/a1');
  assert.equal(info.worktree, '/tmp/demo/.worktrees/a1');
  assert.equal(info.metroPort, 4000);
});

test('restore() reserves the persisted port so a new agent cannot reuse it', async () => {
  const manager = managerLoading([base({ metroPort: 4000 })]);
  manager.restore();

  const allocator = (manager as unknown as { ports: Map<string, PortAllocator> }).ports.get('demo')!;
  const next = await allocator.allocate();
  assert.notEqual(next, 4000, 'the restored port is not handed out again');
});

test('restore() skips agents whose project is no longer configured', () => {
  const manager = managerLoading([base({ id: 'gone', project: 'removed-project' })]);
  manager.restore();
  assert.equal(manager.get('gone'), undefined, 'the orphaned agent is dropped, not crashed on');
});

test('restore() derives ownsWorktree when the field is absent (legacy state)', () => {
  const manager = managerLoading([
    base({ id: 'parent', ownsWorktree: undefined, parentId: undefined }),
    base({
      id: 'child',
      ownsWorktree: undefined,
      parentId: 'parent',
      template: 'merge',
      branch: undefined,
      worktree: undefined,
      metroPort: undefined,
    }),
  ]);
  manager.restore();

  // A top-level agent with a worktree owns it; a child has no worktree here so it owns nothing.
  assert.equal(manager.get('parent')!.ownsWorktree, true, 'top-level with worktree owns it');
  assert.equal(manager.get('child')!.ownsWorktree, false, 'child does not own a (missing) worktree');
});

test('restore() preserves sidebar order with parents before their children', () => {
  const manager = managerLoading([
    base({ id: 'p1', parentId: undefined }),
    base({ id: 'c1', parentId: 'p1', template: 'merge', branch: undefined, worktree: undefined, metroPort: undefined }),
  ]);
  manager.restore();

  const order = manager.list().map((s: AgentSession) => s.id);
  assert.deepEqual(order, ['p1', 'c1'], 'the parent precedes its nested child');
});

test('restore() does not auto-start any turn (no agent is left working)', () => {
  const manager = managerLoading([base({ id: 'x1', status: 'booting' })]);
  manager.restore();
  assert.equal(manager.get('x1')!.getInfo().status, 'stopped', 'restored agents stay paused');
});

test('restore() over an empty persisted list is a no-op (nothing registered)', () => {
  const manager = managerLoading([]);
  assert.doesNotThrow(() => manager.restore());
  assert.deepEqual(manager.list(), [], 'no agents are created');
});

test('restore() round-trips a persisted simulatorUdid back onto the session', () => {
  const manager = rnManagerLoading([
    base({ project: 'rn', branch: 'agent/a1', worktree: '/tmp/rn/.worktrees/a1', simulatorUdid: 'SIM-1' }),
  ]);
  manager.restore();
  assert.equal(manager.get('a1')!.getInfo().simulatorUdid, 'SIM-1', 'the UDID survives a restart');
});

test('restore() re-adopts the persisted simulator so release() will later tear it down', async () => {
  const manager = rnManagerLoading([base({ project: 'rn', simulatorUdid: 'SIM-OWN' })]);
  manager.restore();

  const sims = (manager as unknown as { simulators: Map<string, SimulatorAllocator> }).simulators;
  const allocator = sims.get('rn')!;
  const owned = (allocator as unknown as { owned: Set<string> }).owned;
  assert.ok(owned.has('SIM-OWN'), 'the restored UDID is re-adopted as owned');
});

test('the real loadState() never throws and returns an agents array', () => {
  // loadState reads ~/.orc/state.json; whether it exists, is missing, or is corrupt, it must
  // degrade to a well-formed empty/parsed result rather than throwing and crashing startup.
  const manager = new AgentManager(CONFIG);
  const load = (manager as unknown as { loadState(): { agents: unknown } }).loadState.bind(manager);
  let state: { agents: unknown } | undefined;
  assert.doesNotThrow(() => {
    state = load();
  });
  assert.ok(Array.isArray(state!.agents), 'loadState always yields an agents array');
});
