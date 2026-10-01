import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAppendPrompt,
  LAUNCH_TOOL,
  RUN_STEP_TOOL,
  CREATE_WORKTREE_TOOL,
  PIPELINE_ORDER,
  ROLE_RESPONSIBILITIES,
  NEEDS_INPUT,
  DONE,
  LIST_SUBAGENTS_TOOL,
  ASK_SUBAGENT_TOOL,
  ANSWER_SUBAGENT_TOOL,
  ASK_ORCHESTRATOR_TOOL,
  ORCHESTRATION_TOOLS,
} from '../src/agentPrompt.js';
import {
  type AgentTemplate,
  type RoleTemplate,
  needsWorktree,
  isReadOnlyTemplate,
  isWorkerTemplate,
  READ_ONLY_TEMPLATES,
  WORKTREE_TEMPLATES,
} from '../src/types.js';

const ALL_TEMPLATES: AgentTemplate[] = [
  'feature',
  'fix',
  'question',
  'merge',
  'worker',
  'launcher',
  'pipeline',
  'architect',
  'explorer',
  'planner',
  'implementer',
  'tester',
  'reviewer',
  'refactorer',
];

const READ_ONLY_ROLES: RoleTemplate[] = ['architect', 'explorer', 'planner', 'reviewer'];
const FULL_ACCESS_ROLES: RoleTemplate[] = ['implementer', 'tester', 'refactorer'];

test('needsWorktree is true only for feature + fix + the three full-access roles', () => {
  const expected = new Set<AgentTemplate>(['feature', 'fix', 'implementer', 'tester', 'refactorer']);
  for (const t of ALL_TEMPLATES) {
    assert.equal(needsWorktree(t), expected.has(t), `needsWorktree(${t})`);
  }
  // The exported set must agree with the helper.
  assert.deepEqual(new Set(WORKTREE_TEMPLATES), expected);
});

test('isReadOnlyTemplate covers question/launcher/pipeline + the four read-only roles', () => {
  const expected = new Set<AgentTemplate>([
    'question',
    'launcher',
    'pipeline',
    'architect',
    'explorer',
    'planner',
    'reviewer',
  ]);
  for (const t of ALL_TEMPLATES) {
    assert.equal(isReadOnlyTemplate(t), expected.has(t), `isReadOnlyTemplate(${t})`);
  }
  assert.deepEqual(new Set(READ_ONLY_TEMPLATES), expected);
});

test('a template is never both read-only and worktree (mutually exclusive)', () => {
  for (const t of ALL_TEMPLATES) {
    assert.ok(!(isReadOnlyTemplate(t) && needsWorktree(t)), `${t} must not be both`);
  }
});

test('worker is its own category: neither read-only nor a WORKTREE_TEMPLATE', () => {
  assert.ok(isWorkerTemplate('worker'), 'isWorkerTemplate should be true for worker');
  assert.ok(!isReadOnlyTemplate('worker'), 'worker must not be read-only (it can edit once it adopts a worktree)');
  assert.ok(!needsWorktree('worker'), 'worker must not get a worktree up front');
  // Only the worker template satisfies isWorkerTemplate.
  for (const t of ALL_TEMPLATES) {
    assert.equal(isWorkerTemplate(t), t === 'worker', `isWorkerTemplate(${t})`);
  }
});

test('worker prompt is general-purpose, references the on-demand create_worktree tool, commits', () => {
  const prompt = buildAppendPrompt({ name: 'odd-job', template: 'worker', project: 'demo' });
  assert.match(prompt, /general-purpose WORKER agent/, 'worker prompt missing identity');
  assert.ok(prompt.includes(CREATE_WORKTREE_TOOL), 'worker prompt must reference the create_worktree tool');
  // It starts with no worktree and only cuts one when it must edit code.
  assert.match(prompt, /NO git worktree/, 'worker prompt should say it starts with no worktree');
  // It commits when it does make changes (feature-style DONE <hash>), and can also finish with a bare DONE.
  assert.ok(prompt.includes(`${DONE} <commit-hash>`), 'worker prompt missing commit protocol');
  assert.ok(prompt.includes(NEEDS_INPUT), 'worker prompt missing NEEDS_INPUT');
});

test('buildAppendPrompt produces a non-empty prompt for every template', () => {
  for (const t of ALL_TEMPLATES) {
    const prompt = buildAppendPrompt({ name: `agent-${t}`, template: t, project: 'demo' });
    assert.ok(prompt.length > 0, `empty prompt for ${t}`);
    assert.ok(prompt.includes(`agent "agent-${t}"`), `prompt for ${t} omits the agent name`);
  }
});

test('read-only roles carry the "MUST NOT modify" guardrail and no DONE <hash> protocol', () => {
  for (const role of READ_ONLY_ROLES) {
    const prompt = buildAppendPrompt({ name: 'ro', template: role });
    assert.match(prompt, /MUST NOT modify anything/, `${role} missing guardrail`);
    assert.match(prompt, new RegExp(`READ-ONLY ${role.toUpperCase()}`), `${role} missing identity`);
    assert.ok(prompt.includes(NEEDS_INPUT), `${role} missing NEEDS_INPUT`);
    // Read-only roles finish with the plain DONE, never DONE <commit-hash>.
    assert.ok(!prompt.includes(`${DONE} <commit-hash>`), `${role} should not commit`);
  }
});

test('full-access roles carry the feature worktree identity + DONE <hash> protocol', () => {
  for (const role of FULL_ACCESS_ROLES) {
    const prompt = buildAppendPrompt({ name: 'fa', template: role, metroPort: 4100 });
    assert.match(prompt, new RegExp(`${role.toUpperCase()} role agent`), `${role} missing identity`);
    assert.match(prompt, /your own git worktree/, `${role} missing worktree language`);
    assert.ok(prompt.includes(`${DONE} <commit-hash>`), `${role} missing commit protocol`);
    assert.match(prompt, /port is 4100/, `${role} missing port line`);
  }
});

test('fix prompt is full-access (worktree identity + DONE <hash>) with a surgical workflow', () => {
  const prompt = buildAppendPrompt({ name: 'bugfix', template: 'fix', metroPort: 4100 });
  // Full-access worktree identity + commit protocol, like a feature agent.
  assert.match(prompt, /BUG-FIX agent/, 'fix prompt missing identity');
  assert.match(prompt, /your own git worktree/, 'fix prompt missing worktree language');
  assert.ok(prompt.includes(`${DONE} <commit-hash>`), 'fix prompt missing commit protocol');
  assert.match(prompt, /port is 4100/, 'fix prompt missing port line');
  // Opinionated bug-fix workflow: reproduce, root-cause, minimal change, verify.
  assert.match(prompt, /REPRODUCE/, 'fix prompt missing reproduce step');
  assert.match(prompt, /root cause/i, 'fix prompt missing root-cause step');
  assert.match(prompt, /smallest change/, 'fix prompt missing minimal-change guidance');
});

test('every role prompt requires a hand-off summary', () => {
  for (const role of [...READ_ONLY_ROLES, ...FULL_ACCESS_ROLES]) {
    const prompt = buildAppendPrompt({ name: 'r', template: role });
    assert.match(prompt, /Hand-off summary \(required\)/, `${role} missing hand-off`);
    assert.ok(prompt.includes(`## ${role} summary`), `${role} missing summary title`);
  }
});

test('launcher prompt references the launch tool; pipeline prompt references the run-step tool', () => {
  const launcher = buildAppendPrompt({ name: 'l', template: 'launcher', project: 'demo' });
  assert.ok(launcher.includes(LAUNCH_TOOL), 'launcher missing LAUNCH_TOOL');
  assert.ok(!launcher.includes(RUN_STEP_TOOL), 'launcher should not mention RUN_STEP_TOOL');

  const pipeline = buildAppendPrompt({ name: 'p', template: 'pipeline', project: 'demo' });
  assert.ok(pipeline.includes(RUN_STEP_TOOL), 'pipeline missing RUN_STEP_TOOL');
  assert.ok(!pipeline.includes(LAUNCH_TOOL), 'pipeline should not mention LAUNCH_TOOL');
});

test('launcher prompt tells it to choose a template per group', () => {
  const launcher = buildAppendPrompt({ name: 'l', template: 'launcher', project: 'demo' });
  assert.match(launcher, /template/i, 'launcher prompt should mention choosing a template');
  for (const t of ['feature', 'fix', 'question', 'pipeline']) {
    assert.ok(launcher.includes(`\`${t}\``), `launcher prompt missing ${t} template option`);
  }
});

test('launcher prompt forbids splitting same-file work across parallel agents', () => {
  const launcher = buildAppendPrompt({ name: 'l', template: 'launcher', project: 'demo' });
  assert.match(launcher, /same files/i, 'launcher prompt should warn about editing the same files');
  assert.match(launcher, /parallel/i, 'launcher prompt should note agents run in parallel');
  assert.match(launcher, /DISJOINT/, 'launcher prompt should require disjoint file sets to split');
});

test('coordination section tells shared-worktree subagents to check in before editing', () => {
  const prompt = buildAppendPrompt({ name: 'a', template: 'feature', project: 'demo' });
  assert.match(prompt, /Avoiding collisions on shared code/, 'missing collision-avoidance guidance');
  assert.match(prompt, /only ONE agent may edit it at a time/i, 'missing one-editor-at-a-time rule');
  assert.match(prompt, /BEFORE you start editing/i, 'missing check-in-before-editing rule');
});

test('every template prompt carries the group-coordination section with all four tools', () => {
  for (const t of ALL_TEMPLATES) {
    const prompt = buildAppendPrompt({ name: `agent-${t}`, template: t, project: 'demo' });
    assert.match(prompt, /Coordinating with your group/, `${t} missing coordination section`);
    assert.ok(prompt.includes(LIST_SUBAGENTS_TOOL), `${t} missing list_subagents`);
    assert.ok(prompt.includes(ASK_SUBAGENT_TOOL), `${t} missing ask_subagent`);
    assert.ok(prompt.includes(ANSWER_SUBAGENT_TOOL), `${t} missing answer_subagent`);
    assert.ok(prompt.includes(ASK_ORCHESTRATOR_TOOL), `${t} missing ask_orchestrator`);
  }
});

test('ORCHESTRATION_TOOLS is exactly the four fully-qualified coordination tool names', () => {
  assert.deepEqual(
    new Set(ORCHESTRATION_TOOLS),
    new Set([LIST_SUBAGENTS_TOOL, ASK_SUBAGENT_TOOL, ANSWER_SUBAGENT_TOOL, ASK_ORCHESTRATOR_TOOL]),
  );
  // Every coordination tool is namespaced on the in-process "orc" MCP server.
  for (const name of ORCHESTRATION_TOOLS) {
    assert.match(name, /^mcp__orc__/, `${name} not on the orc server`);
  }
});

test('merge prompt defaults to rebase and bakes in the chosen strategy', () => {
  const dflt = buildAppendPrompt({ name: 'm', template: 'merge' });
  assert.match(dflt, /strategy for this project is \*\*rebase\*\*/, 'merge default is not rebase');
  assert.ok(dflt.includes('git rebase --abort'), 'rebase default missing rebase abort');

  const cases: Array<[Parameters<typeof buildAppendPrompt>[0]['mergeStrategy'], string]> = [
    ['merge', 'git merge --abort'],
    ['rebase', 'git rebase --abort'],
    ['squash-merge', 'git merge --squash'],
    ['squash-rebase', '--autosquash'],
  ];
  for (const [strategy, marker] of cases) {
    const prompt = buildAppendPrompt({ name: 'm', template: 'merge', mergeStrategy: strategy });
    assert.match(
      prompt,
      new RegExp(`strategy for this project is \\*\\*${strategy}\\*\\*`),
      `merge prompt missing strategy label for ${strategy}`,
    );
    assert.ok(prompt.includes(marker), `merge prompt for ${strategy} missing "${marker}"`);
  }
});

test('merge prompt integrates straight into a configured baseBranch without asking', () => {
  const configured = buildAppendPrompt({ name: 'm', template: 'merge', baseBranch: 'master' });
  assert.ok(
    configured.includes('The target branch is `master`'),
    'merge prompt should name the configured base branch',
  );
  assert.ok(
    configured.includes('do NOT ask the human which branch to integrate into'),
    'merge prompt should tell the agent not to ask when a base branch is configured',
  );
  assert.ok(
    !configured.includes('confirm the target branch'),
    'merge prompt must not ask to confirm the target when a base branch is configured',
  );

  const unset = buildAppendPrompt({ name: 'm', template: 'merge' });
  assert.ok(
    unset.includes('confirm the target branch'),
    'merge prompt should still confirm the target when no base branch is configured',
  );
});

test('pipeline prompt encodes the canonical order (tests-first, tester twice)', () => {
  assert.deepEqual(
    [...PIPELINE_ORDER],
    ['architect', 'explorer', 'planner', 'tester', 'implementer', 'reviewer', 'refactorer', 'tester'],
  );
  const pipeline = buildAppendPrompt({ name: 'p', template: 'pipeline', project: 'demo' });
  // All seven distinct roles must be named in the rendered order list.
  for (const role of Object.keys(ROLE_RESPONSIBILITIES)) {
    assert.ok(pipeline.includes(role), `pipeline order omits ${role}`);
  }
});
