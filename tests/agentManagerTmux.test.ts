import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AgentManager } from '../src/agent/AgentManager.js';
import type { Tmux } from '../src/tmux/TmuxController.js';
import type { LogEntry, OrcConfig, ProjectConfig } from '../src/types.js';

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

type Persisted = Record<string, unknown>;

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

/** A Tmux fake that records which hook was called with which args. */
function fakeTmux() {
  const calls = {
    register: [] as Array<{ id: string; name: string; template: string }>,
    unregister: [] as string[],
    mirror: [] as Array<{ id: string; events: readonly LogEntry[] }>,
    show: [] as Array<string | undefined>,
  };
  const tmux: Tmux = {
    registerAgent: (id: string, name: string, template: string) => {
      calls.register.push({ id, name, template });
    },
    unregisterAgent: (id: string) => {
      calls.unregister.push(id);
    },
    mirror: (id: string, events: readonly LogEntry[]) => {
      calls.mirror.push({ id, events });
    },
    showAgent: (id?: string) => {
      calls.show.push(id);
    },
  };
  return { tmux, calls };
}

/** A manager (optionally tmux-injected) whose loadState() returns the given agents. */
function managerLoading(agents: Persisted[], tmux?: Tmux): AgentManager {
  const manager = new AgentManager(CONFIG, tmux);
  (manager as unknown as { loadState(): { agents: Persisted[] } }).loadState = () => ({ agents });
  return manager;
}

describe('tmux is inert when no controller is injected', () => {
  test('new AgentManager(config) with no tmux restores an agent without throwing', () => {
    const manager = new AgentManager(CONFIG);
    (manager as unknown as { loadState(): { agents: Persisted[] } }).loadState = () => ({ agents: [base()] });
    assert.doesNotThrow(() => manager.restore());
    assert.ok(manager.get('a1'), 'the agent is registered with tmux off');
  });

  test('showAgentInPane? is a safe no-op (or absent) without a tmux controller', () => {
    const manager = new AgentManager(CONFIG);
    const show = (manager as unknown as { showAgentInPane?: (id?: string) => void }).showAgentInPane;
    if (typeof show === 'function') {
      assert.doesNotThrow(() => show.call(manager, 'a1'));
    }
  });
});

describe('tmux hooks fire when a controller is injected', () => {
  test('registerAgent is called as each persisted agent is rebuilt', () => {
    const { tmux, calls } = fakeTmux();
    const manager = managerLoading([base()], tmux);
    manager.restore();
    assert.ok(
      calls.register.some((c) => c.id === 'a1'),
      'registerAgent was invoked for the restored agent',
    );
  });

  test('unregisterAgent is called when an agent is removed', async () => {
    const { tmux, calls } = fakeTmux();
    const manager = managerLoading([base()], tmux);
    manager.restore();
    await manager.remove('a1');
    assert.deepEqual(calls.unregister, ['a1'], 'removing the agent unregisters its pane log');
  });

  test('showAgentInPane forwards to the controller when tmux is on', () => {
    const { tmux, calls } = fakeTmux();
    const manager = managerLoading([base()], tmux);
    manager.restore();
    (manager as unknown as { showAgentInPane(id?: string): void }).showAgentInPane('a1');
    assert.deepEqual(calls.show, ['a1'], 'the selected agent is shown in the viewer pane');
  });
});
