import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession, summarizeTool, type AgentSessionInit } from '../src/agent/AgentSession.js';
import type { AgentStatus, LogEntry, ProjectConfig } from '../src/types.js';

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

/** The private internals the pause/kill/tool-result tests reach into via casts. */
type SessionPrivates = {
  handle(m: unknown): void;
  status: AgentStatus;
  pausing: boolean;
  query: { interrupt: () => Promise<void> } | null;
  abortController: AbortController | null;
  queue: unknown;
  pause(): Promise<void>;
  resume(): void;
};

function privates(session: AgentSession): SessionPrivates {
  return session as unknown as SessionPrivates;
}

/** Build a synthetic SDK 'user' message carrying tool_result content blocks. */
function userMessage(blocks: unknown[]) {
  return {
    type: 'user' as const,
    session_id: 's1',
    message: { role: 'user' as const, content: blocks },
  };
}

/** The last recorded log entry (newest event the session appended). */
function lastEvent(session: AgentSession): LogEntry {
  const events = session.getEvents();
  return events[events.length - 1];
}

/**
 * Inject a fake `query` (counting interrupt() calls) and a spied `abortController` (recording
 * abort()) onto the never-launched session, so pause()/stop() have something to act on.
 */
function injectFakes(session: AgentSession): {
  calls: { interrupt: number };
  wasAborted: () => boolean;
} {
  const p = privates(session);
  const calls = { interrupt: 0 };
  p.query = {
    interrupt: async () => {
      calls.interrupt++;
    },
  };
  const ac = new AbortController();
  let aborted = false;
  ac.abort = () => {
    aborted = true;
  };
  p.abortController = ac;
  return { calls, wasAborted: () => aborted };
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

test('an auth-failure result flips to needs_login instead of a generic error', () => {
  const session = makeSession();
  feed(session, errorResult('error_during_execution', ['API Error: 401 Unauthorized']));
  assert.equal(session.getInfo().status, 'needs_login');
});

test('a "not logged in" result is detected as needs_login', () => {
  const session = makeSession();
  feed(session, errorResult('error_during_execution', ['Error: not logged in. Run `claude login`.']));
  assert.equal(session.getInfo().status, 'needs_login');
});

test('an invalid-api-key result is detected as needs_login', () => {
  const session = makeSession();
  feed(session, errorResult('error', ['authentication_error: invalid API key']));
  assert.equal(session.getInfo().status, 'needs_login');
});

test('an ordinary task error is NOT mistaken for a login problem', () => {
  const session = makeSession();
  feed(session, errorResult('error_during_execution', ['TypeError: cannot read property of undefined']));
  assert.equal(session.getInfo().status, 'error');
});

test('a needs_login turn has ended, so a reply/retry resumes the session', () => {
  const session = makeSession();
  feed(session, errorResult('error_during_execution', ['401 Unauthorized']));
  assert.equal(session.getInfo().status, 'needs_login');
  // The CLI exited on the auth failure, so there is no live loop — continuing must relaunch
  // (resume) rather than push onto a dead queue.
  assert.equal(turnEnded(session), true);
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

// --- summarizeTool for mcp__orc__run (NEW intent line) ---------------------------------------------
// Expected RED until the implementer adds a dedicated mcp__orc__run branch to summarizeTool that
// prints the BARE command (`▸ mcp__orc__run <command>`), not the generic `key=value` rendering
// (today a mcp__* tool renders as `▸ mcp__orc__run command=<command>`).

test('summarizeTool renders mcp__orc__run as a bare command intent line', () => {
  const out = summarizeTool('mcp__orc__run', JSON.stringify({ command: 'ls -la' }));
  assert.match(out, /mcp__orc__run/);
  assert.match(out, /ls -la/);
  // The dedicated branch shows the command verbatim, with no `command=` key prefix.
  assert.doesNotMatch(out, /command=/, 'no generic key=value rendering for mcp__orc__run');
  assert.equal(out, '▸ mcp__orc__run ls -la');
});

test('summarizeTool truncates a very long mcp__orc__run command with an ellipsis', () => {
  const longCmd = 'echo ' + 'x'.repeat(400);
  const out = summarizeTool('mcp__orc__run', JSON.stringify({ command: longCmd }));
  assert.ok(out.includes('…'), 'long command is truncated with an ellipsis');
  assert.ok(out.length < longCmd.length, 'output is shorter than the raw command');
});

// --- buildOptions sets disallowedTools including Bash ----------------------------------------------
// Expected RED until the implementer makes buildOptions set opts.disallowedTools to include 'Bash'
// (the built-in Bash tool is disabled in favour of the custom mcp__orc__run pane tool).

// Reach the private buildOptions() without the real SDK, mirroring the decide()/feed() pattern.
function buildOptions(session: AgentSession): { disallowedTools?: string[] } {
  return (session as unknown as { buildOptions(resume?: string): { disallowedTools?: string[] } }).buildOptions();
}

test("buildOptions disables the built-in Bash tool via disallowedTools", () => {
  const session = makeSession();
  const opts = buildOptions(session);
  assert.ok(Array.isArray(opts.disallowedTools), 'disallowedTools is set');
  assert.ok(opts.disallowedTools!.includes('Bash'), "'Bash' is disallowed (replaced by mcp__orc__run)");
});

// ---- (a) tool_result capture: string content ----------------------------------------------
test('a tool_result with string content is captured verbatim (multi-line preserved)', () => {
  const session = makeSession();
  feed(session, userMessage([{ type: 'tool_result', tool_use_id: 't1', content: 'hello\nworld' }]));
  const entry = lastEvent(session);
  assert.equal(entry.kind, 'tool_result');
  assert.equal(entry.text, 'hello\nworld');
  assert.equal(entry.toolUseId, 't1');
});

// ---- (b) tool_result capture: array content ------------------------------------------------
test('a tool_result with array content joins its text blocks', () => {
  const session = makeSession();
  feed(
    session,
    userMessage([
      {
        type: 'tool_result',
        tool_use_id: 't2',
        content: [
          { type: 'text', text: 'line1' },
          { type: 'text', text: 'line2' },
        ],
      },
    ]),
  );
  const entry = lastEvent(session);
  assert.equal(entry.kind, 'tool_result');
  assert.equal(entry.text, 'line1line2');
});

// ---- (c) error flag ------------------------------------------------------------------------
test('a tool_result with is_error is logged as an error entry', () => {
  const session = makeSession();
  feed(
    session,
    userMessage([{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: 'boom' }]),
  );
  assert.equal(lastEvent(session).kind, 'error');
});

// ---- (d) large output truncation -----------------------------------------------------------
test('a huge tool_result is truncated into a single bounded entry', () => {
  const session = makeSession();
  const before = session.getEvents().length;
  feed(
    session,
    userMessage([{ type: 'tool_result', tool_use_id: 't4', content: 'x'.repeat(20_000) }]),
  );
  const added = session.getEvents().length - before;
  assert.equal(added, 1, 'exactly one event added');
  const entry = lastEvent(session);
  assert.ok(
    entry.text.length < 20_000,
    `expected truncated length well under 20000, got ${entry.text.length}`,
  );
  assert.match(entry.text, /truncated/);
});

// ---- (e) pause interrupts but does NOT kill ------------------------------------------------
test('pause() interrupts the turn but keeps the subprocess alive', async () => {
  const session = makeSession();
  const p = privates(session);
  p.status = 'working';
  const { calls, wasAborted } = injectFakes(session);
  const queueBefore = p.queue;

  await p.pause();

  assert.equal(calls.interrupt, 1, 'interrupt called exactly once');
  assert.equal(wasAborted(), false, 'must NOT abort the subprocess');
  assert.equal(p.status, 'paused');
  assert.notEqual(p.query, null, 'query must stay non-null (alive)');
  assert.equal(p.queue, queueBefore, 'queue identity unchanged (not re-created)');
});

// ---- (f) a non-success result while pausing becomes paused, not error ----------------------
test('an error result arriving while pausing resolves to paused, not error', () => {
  const session = makeSession();
  const p = privates(session);
  p.status = 'working';
  p.pausing = true;

  feed(session, errorResult('error_during_execution', ['interrupted']));

  assert.equal(p.status, 'paused');
  assert.equal(p.pausing, false, 'pausing flag cleared');
});

// ---- (g) resume pushes to the LIVE queue (no relaunch) -------------------------------------
test('resume() continues the live session without re-creating the queue or query', () => {
  const session = makeSession();
  const p = privates(session);
  p.status = 'paused';
  injectFakes(session);
  const queueBefore = p.queue;
  const queryBefore = p.query;

  p.resume();

  assert.equal(p.status, 'working');
  assert.equal(p.queue, queueBefore, 'queue identity unchanged (pushed to live queue)');
  assert.equal(p.query, queryBefore, 'query identity unchanged (no relaunch/resumeWith)');
});

// ---- (h) hard-kill still aborts + closes ----------------------------------------------------
test('stop() hard-kills: interrupts, aborts and drops the query', async () => {
  const session = makeSession();
  const p = privates(session);
  p.status = 'working';
  const { calls, wasAborted } = injectFakes(session);

  await session.stop();

  assert.equal(calls.interrupt, 1, 'interrupt called');
  assert.equal(wasAborted(), true, 'subprocess aborted');
  assert.equal(p.query, null, 'query nulled');
  assert.equal(p.status, 'stopped');
});
