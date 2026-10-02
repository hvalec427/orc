import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import type { OrcConfig } from '../src/types.js';

// A single top-level feature agent on a branch + worktree, so the `C` cleanup command is offered.
// We assert that pressing C invokes manager.cleanupAgent with the agent's id, and that an agent
// without a worktree gets neither the hint nor the action.
type Rec = { id: string; name: string; status: string; branch?: string; worktree?: string };

function session(rec: Rec) {
  const info = { parentId: undefined, template: 'feature', ...rec };
  return {
    id: rec.id,
    name: rec.name,
    parentId: undefined,
    project: 'proj',
    pendingApproval: undefined,
    getInfo: () => info,
    getEvents: () => [{ kind: 'text', text: rec.name, done: true }],
    retry: () => {},
    send: () => {},
    _info: info,
  } as any;
}

function makeManager(rec: Rec) {
  const a = session(rec);
  const ordered = [a];
  const byId = new Map(ordered.map((s) => [s.id, s]));

  const m = new EventEmitter() as any;
  m.calls = { cleanupAgent: [] as string[] };
  m.list = () => ordered;
  m.active = () => ordered;
  m.archived = () => [];
  m.projects = () => [{ name: 'proj', repo: '/tmp' }];
  m.get = (id: string) => byId.get(id);
  m.stopAll = async () => {};
  m.firstWaiting = () => undefined;
  m.mergeChildOf = () => undefined;
  m.cleanupChildOf = () => undefined;
  m.firstChildOf = () => undefined;
  m.childrenOf = () => [];
  m.groupRootOf = (id: string) => byId.get(id);
  m.topLevel = () => ordered;
  m.topLevelSibling = (id: string) => byId.get(id);
  m.siblingOf = () => undefined;
  m.cleanupAgent = async (id: string) => {
    m.calls.cleanupAgent.push(id);
    return byId.get(id);
  };
  return m;
}

const config: OrcConfig = { projects: [{ name: 'proj', repo: '/tmp' }] } as unknown as OrcConfig;
const delay = () => new Promise((r) => setTimeout(r, 50));

test('C spawns a cleanup agent for an agent that has a worktree', async () => {
  const manager = makeManager({
    id: 'a1',
    name: 'agent-one',
    status: 'working',
    branch: 'agent/a1',
    worktree: '/tmp/wt/a1',
  });
  const { stdin, lastFrame, unmount } = render(React.createElement(App, { manager, config }));
  await delay();

  assert.match(lastFrame() ?? '', /C:cleanup/, 'the cleanup hint is shown when a worktree exists');

  stdin.write('C');
  await delay();

  assert.deepEqual(manager.calls.cleanupAgent, ['a1'], 'C calls cleanupAgent with the agent id');

  unmount();
});

test('C is inert for an agent with no worktree', async () => {
  const manager = makeManager({ id: 'a1', name: 'agent-one', status: 'done' });
  const { stdin, lastFrame, unmount } = render(React.createElement(App, { manager, config }));
  await delay();

  assert.doesNotMatch(lastFrame() ?? '', /C:cleanup/, 'no cleanup hint without a worktree');

  stdin.write('C');
  await delay();

  assert.deepEqual(manager.calls.cleanupAgent, [], 'C does nothing without a worktree');

  unmount();
});
