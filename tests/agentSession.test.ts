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
    template: 'explorer',
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

// Reach the private PreToolUse guard for AskUserQuestion without the real SDK.
function guardAsk(session: AgentSession, toolName: string): Promise<unknown> {
  return (
    session as unknown as { guardAskUserQuestion(i: unknown): Promise<unknown> }
  ).guardAskUserQuestion({ tool_name: toolName, tool_input: {}, cwd: '/tmp/demo' });
}

// Reach the private turnEnded() routing predicate without the real SDK. It decides whether a reply
// relaunches the session (resume) or is pushed onto the live input queue.
function turnEnded(session: AgentSession): boolean {
  return (session as unknown as { turnEnded(): boolean }).turnEnded();
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

test('AskUserQuestion is denied and redirected to the NEEDS_INPUT sentinel', async () => {
  const session = makeSession();
  const out = (await guardAsk(session, 'AskUserQuestion')) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput?.permissionDecisionReason ?? '', /@@NEEDS_INPUT@@/);
});

test('the AskUserQuestion guard leaves other tools untouched', async () => {
  const session = makeSession();
  const out = (await guardAsk(session, 'Read')) as { continue?: boolean };
  assert.equal(out.continue, true);
});

test('a question-ending turn flips to needs_input and routes replies through resume', () => {
  const session = makeSession();
  // A turn that ends without a sentinel is the agent asking the human something.
  feed(session, successResult('which database should I use?'));
  assert.equal(session.getInfo().status, 'needs_input');
  // The turn has ended, so a reply must relaunch (resume) rather than push onto a dead queue —
  // this is the bug where answering silently dropped the reply unless the human did stop+retry.
  assert.equal(turnEnded(session), true);
});

test('a mid-turn approval pause keeps the live path for replies', () => {
  const session = makeSession();
  feed(session, successResult('need to run a command'));
  // Simulate the SDK pausing mid-turn for tool approval: the subprocess is still alive and reading
  // the input queue, so replies must stay on the live push path, not relaunch.
  (session as unknown as { setStatus(s: string): void }).setStatus('needs_approval');
  assert.equal(turnEnded(session), false);
});
