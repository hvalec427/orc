import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentManager } from '../src/agent/AgentManager.js';
import { AgentSession } from '../src/agent/AgentSession.js';
import type { OrcConfig, ProjectConfig } from '../src/types.js';

const PROJECT: ProjectConfig = {
  name: 'demo',
  type: 'node',
  repo: '/tmp/demo',
  model: 'claude-sonnet-4',
  worktreeDir: '.worktrees',
  permissionMode: 'bypassPermissions',
  settingSources: ['project'],
  mergeStrategy: 'rebase',
};

const CONFIG: OrcConfig = { projects: [PROJECT] };

function makeSession(id: string, name: string, parentId?: string): AgentSession {
  return new AgentSession({
    id,
    name,
    template: 'feature',
    parentId,
    ticket: '',
    prompt: 'do the thing',
    config: PROJECT,
  });
}

// Reach the private SDK message handler to drive a session into a given state without the real SDK.
function feed(session: AgentSession, msg: unknown): void {
  (session as unknown as { handle(m: unknown): void }).handle(msg);
}

// Reach the private askChild (what the orchestrator's ask_subagent resolves to).
function askChild(mgr: AgentManager, parentId: string, childId: string, question: string) {
  return (
    mgr as unknown as {
      askChild(p: string, c: string, q: string): Promise<{ status: string; answer: string }>;
    }
  ).askChild(parentId, childId, question);
}

// Inject sessions into the manager's private registry so we don't spawn real worktrees/SDK sessions.
function register(mgr: AgentManager, ...sessions: AgentSession[]): void {
  const agents = (mgr as unknown as { agents: Map<string, AgentSession> }).agents;
  for (const s of sessions) agents.set(s.getInfo().id, s);
}

function needsInputResult(question: string) {
  return {
    type: 'result' as const,
    subtype: 'success' as const,
    session_id: 's1',
    total_cost_usd: 0,
    result: `${question}\n\n@@NEEDS_INPUT@@`,
    errors: [] as string[],
  };
}

test('ask_subagent refuses a child that is waiting for human input (needs_input)', async () => {
  const mgr = new AgentManager(CONFIG);
  const parent = makeSession('p1', 'orchestrator');
  const child = makeSession('c1', 'login-flow', 'p1');
  register(mgr, parent, child);

  // Child ends its turn asking the human — that turn is reserved for the human.
  feed(child, needsInputResult('Which auth method should I use?'));
  assert.equal(child.getInfo().status, 'needs_input');

  await assert.rejects(
    () => askChild(mgr, 'p1', 'c1', 'what is your status?'),
    /waiting for human input/i,
  );

  // The refusal must not hijack the turn: the child stays in needs_input with its question intact.
  assert.equal(child.getInfo().status, 'needs_input');
  assert.match(child.getInfo().question ?? '', /Which auth method/);
});

test('ask_subagent includes the pending human question in the refusal so the orchestrator knows why', async () => {
  const mgr = new AgentManager(CONFIG);
  const parent = makeSession('p1', 'orchestrator');
  const child = makeSession('c1', 'login-flow', 'p1');
  register(mgr, parent, child);

  feed(child, needsInputResult('Which auth method should I use?'));

  await assert.rejects(
    () => askChild(mgr, 'p1', 'c1', 'status?'),
    /Which auth method should I use\?/,
  );
});
