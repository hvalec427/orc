import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPreviewInstructions } from '../src/previewInstructions.js';
import type { AgentInfo, ProjectConfig } from '../src/types.js';

function project(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: 'Demo',
    type: 'web',
    repo: '/repo',
    model: 'claude',
    worktreeDir: '.worktrees',
    permissionMode: 'bypassPermissions',
    settingSources: ['project'],
    mergeStrategy: 'rebase',
    ...over,
  };
}

function info(over: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'a1',
    name: 'cool-feature',
    template: 'feature',
    project: 'Demo',
    ticket: 'T-1',
    branch: 'agent/cool-feature',
    worktree: '/repo/.worktrees/cool-feature',
    metroPort: 8042,
    status: 'done',
    ...over,
  };
}

test('web preview includes cd, dev command and localhost URL on the allocated port', () => {
  const out = buildPreviewInstructions(info(), project({ type: 'web' }));
  assert.match(out, /cd "\/repo\/\.worktrees\/cool-feature"/);
  assert.match(out, /npm run dev/);
  assert.match(out, /http:\/\/localhost:8042/);
});

test('web preview includes the magic link when configured', () => {
  const out = buildPreviewInstructions(info(), project({ type: 'web', magicLink: 'https://x/login' }));
  assert.match(out, /https:\/\/x\/login/);
});

test('react-native preview names the simulator after the agent and reports the Metro port', () => {
  const out = buildPreviewInstructions(info(), project({ type: 'react-native' }));
  assert.match(out, /Metro runs on port 8042/);
  assert.match(out, /simulator named "cool-feature"/);
});

test('react-native preview uses simctl openurl with the magic link when configured', () => {
  const out = buildPreviewInstructions(
    info(),
    project({ type: 'react-native', magicLink: 'myapp://login' }),
  );
  assert.match(out, /xcrun simctl openurl "cool-feature" "myapp:\/\/login"/);
});

test('web preview without a port falls back to the printed dev-server URL', () => {
  const out = buildPreviewInstructions(info({ metroPort: undefined }), project({ type: 'web' }));
  assert.doesNotMatch(out, /http:\/\/localhost/);
  assert.match(out, /dev server URL printed by/);
});

test('an agent with no worktree has nothing to preview', () => {
  const out = buildPreviewInstructions(
    info({ worktree: undefined, branch: undefined }),
    project({ type: 'web' }),
  );
  assert.match(out, /no worktree/i);
  assert.doesNotMatch(out, /npm run dev/);
});
