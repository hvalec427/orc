import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import type { OrcConfig } from '../src/types.js';

// A top-level parent agent plus a child (subagent) nested under it. Children share the parent's
// worktree/branch, so integrating them makes no sense: `m` must be inert and the help bar must not
// advertise it while the child is highlighted.
type Rec = { id: string; name: string; status: string; branch?: string; parentId?: string };

function session(rec: Rec) {
  const info = { parentId: undefined, template: 'feature', ...rec };
  return {
    id: rec.id,
    name: rec.name,
    parentId: rec.parentId,
    project: 'proj',
    pendingApproval: undefined,
    getInfo: () => info,
    getEvents: () => [{ kind: 'text', text: rec.name, done: true }],
    eventsVersion: () => 0,
    retry: () => {},
    send: () => {},
    _info: info,
  } as any;
}

function makeManager() {
  const parent = session({ id: 'p1', name: 'parent-one', status: 'done', branch: 'agent/p1' });
  const child = session({ id: 'c1', name: 'child-one', status: 'done', branch: 'agent/p1', parentId: 'p1' });
  const ordered = [parent, child];
  const byId = new Map(ordered.map((s) => [s.id, s]));

  const m = new EventEmitter() as any;
  m.calls = { mergeAgent: [] as string[] };
  m.list = () => ordered;
  m.active = () => ordered.filter((s: any) => !s.getInfo().archived);
  m.archived = () => [];
  m.projects = () => [{ name: 'proj', repo: '/tmp' }];
  m.get = (id: string) => byId.get(id);
  m.stopAll = async () => {};
  m.firstWaiting = () => undefined;
  m.mergeChildOf = () => undefined;
  m.firstChildOf = () => undefined;
  m.firstActiveChildOf = () => undefined;
  m.childrenOf = (id: string) => ordered.filter((s: any) => s.getInfo().parentId === id);
  m.activeChildrenOf = (id: string) => m.childrenOf(id);
  m.groupRootOf = (id: string) => byId.get(byId.get(id)?.getInfo().parentId ?? id);
  m.topLevel = () => ordered.filter((s: any) => !s.getInfo().parentId);
  m.topLevelSibling = (id: string) => byId.get(id);
  m.siblingOf = () => undefined;
  m.archive = async () => {};
  m.unarchive = async () => {};
  m.mergeAgent = async (id: string) => {
    m.calls.mergeAgent.push(id);
    return byId.get(id);
  };
  m.remove = async () => {};
  return m;
}

const config: OrcConfig = { projects: [{ name: 'proj', repo: '/tmp' }] } as unknown as OrcConfig;
const delay = () => new Promise((r) => setTimeout(r, 50));

test('m is refused while a child agent is highlighted', async () => {
  const manager = makeManager();
  const { stdin, unmount } = render(React.createElement(App, { manager, config }));
  await delay();

  stdin.write('j'); // move selection from parent down to the child
  await delay();

  stdin.write('m');
  await delay();

  assert.deepEqual(manager.calls.mergeAgent, [], 'integrate is not invoked for a child agent');

  unmount();
});

test('the help bar hides m:integrate while a child agent is highlighted', async () => {
  const manager = makeManager();
  const { stdin, lastFrame, unmount } = render(React.createElement(App, { manager, config }));
  await delay();

  // Parent selected first: m:integrate is offered.
  assert.match(lastFrame() ?? '', /m:integrate/, 'parent offers integrate');

  stdin.write('j'); // select the child
  await delay();

  assert.doesNotMatch(lastFrame() ?? '', /m:integrate/, 'child does not offer integrate');

  unmount();
});
