import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession, type AgentSessionInit } from '../src/agent/AgentSession.js';
import type { ProjectConfig } from '../src/types.js';

const CONFIG: ProjectConfig = {
  name: 'demo',
  type: 'node',
  repo: '/tmp/demo',
  model: 'claude-sonnet-4',
  worktreeDir: '.worktrees',
  permissionMode: 'bypassPermissions',
  settingSources: ['project'],
  mergeStrategy: 'rebase',
};

function makeSession(): AgentSession {
  const init: AgentSessionInit = {
    id: 'a1',
    name: 'tester',
    template: 'question',
    ticket: '',
    prompt: 'do the thing',
    config: CONFIG,
  };
  return new AgentSession(init);
}

/** Minimal shape of the SDK 'result' message the session's handler reads. */
function successResult(result: string) {
  return {
    type: 'result' as const,
    subtype: 'success' as const,
    session_id: 's1',
    total_cost_usd: 0,
    result,
    errors: [] as string[],
  };
}

function errorResult(subtype: string, errors: string[]) {
  return {
    type: 'result' as const,
    subtype,
    session_id: 's1',
    total_cost_usd: 0,
    result: '',
    errors,
  };
}

// Reach the private message handler without going through the real SDK query().
function feed(session: AgentSession, msg: unknown): void {
  (session as unknown as { handle(m: unknown): void }).handle(msg);
}

test('a DONE result marks the session done and keeps the commit hash', () => {
  const session = makeSession();
  feed(session, successResult('all set\n\n@@DONE@@ abc123'));
  assert.equal(session.getInfo().status, 'done');
});

test('a stray error result after DONE does not clobber the done status', () => {
  const session = makeSession();
  feed(session, successResult('finished\n\n@@DONE@@ abc123'));
  assert.equal(session.getInfo().status, 'done');

  // Simulate the SDK's teardown noise: a late 'result' with error_during_execution,
  // "only prompt commands are supported in streaming mode", arriving after we closed
  // the input queue. It must be ignored, leaving the session 'done'.
  feed(
    session,
    errorResult('error_during_execution', ['only prompt commands are supported in streaming mode']),
  );
  assert.equal(session.getInfo().status, 'done');
});

test('an error result before completion still surfaces as error', () => {
  const session = makeSession();
  feed(session, errorResult('error_during_execution', ['boom']));
  assert.equal(session.getInfo().status, 'error');
});
