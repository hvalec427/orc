import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAppendPrompt,
  LAUNCH_TOOL,
  RUN_STEP_TOOL,
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
  READ_ONLY_TEMPLATES,
  WORKTREE_TEMPLATES,
} from '../src/types.js';

const ALL_TEMPLATES: AgentTemplate[] = [
  'feature',
  'fix',
  'question',
  'merge',
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
