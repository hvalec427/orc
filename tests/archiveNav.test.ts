import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import { AgentManager } from '../src/agent/AgentManager.js';
import type { OrcConfig } from '../src/types.js';

// Navigation WITHIN the Done section. Two former top-level agents, the first with one former
// subagent, plus one active agent so the active section is non-empty:
//
//   active-one           (active, selected first)
//   Done
//     arch-one           (archived, was a parent)
//     arch-child         (archived, was arch-one's child)
//     arch-two           (archived, was a parent)
//
// Once archived, former parent/child relationships don't matter: the Done section is a FLAT list.
// With it expanded (t), j/k step through EVERY archived agent by position (children included), and
// l/h are no-ops there — there's no group to enter or leave.
type Rec = {
  id: string;
  name: string;
  parentId?: string;
  template: string;
  status: string;
  archived?: boolean;
};

function session(rec: Rec) {
  const info = { branch: undefined, parentId: undefined, ...rec };
  return {
    id: rec.id,
    name: rec.name,
    parentId: rec.parentId,
    project: 'proj',
    pendingApproval: undefined,
    getInfo: () => info,
    getEvents: () => [{ kind: 'text', text: rec.name, done: true }],
    eventsVersion: () => 0,
  } as any;
}

function makeManager() {
  const active1 = session({ id: 'x1', name: 'active-one', template: 'feature', status: 'working' });
  const a1 = session({ id: 'a1', name: 'arch-one', template: 'feature', status: 'done', archived: true });
  const ac = session({ id: 'ac', name: 'arch-child', parentId: 'a1', template: 'reviewer', status: 'done', archived: true });
  const a2 = session({ id: 'a2', name: 'arch-two', template: 'feature', status: 'done', archived: true });

  // list() order: active first, then archived parents with children nested.
  const ordered = [active1, a1, ac, a2];
  const byId = new Map(ordered.map((s) => [s.id, s]));

  const m = new EventEmitter() as any;
  m.list = () => ordered;
  m.active = () => ordered.filter((s: any) => !s.getInfo().archived);
  m.archived = () => ordered.filter((s: any) => s.getInfo().archived);
  m.projects = () => [{ name: 'proj', repoPath: '/tmp' }];
  m.get = (id: string) => byId.get(id);
  m.stopAll = async () => {};
  m.firstWaiting = () => undefined;
  m.mergeChildOf = () => undefined;
  // Delegate the navigation helpers to the REAL AgentManager logic so the test exercises the fix.
  m.groupRootOf = (id: string) => AgentManager.prototype.groupRootOf.call({ agents: byId }, id);
  m.firstChildOf = (id: string) =>
    AgentManager.prototype.firstChildOf.call({ agents: byId }, id);
  m.childrenOf = (id: string) => AgentManager.prototype.childrenOf.call({ agents: byId }, id);
  m.activeChildrenOf = (id: string) =>
    AgentManager.prototype.activeChildrenOf.call(m, id);
  m.firstActiveChildOf = (id: string) =>
    AgentManager.prototype.firstActiveChildOf.call(m, id);
  m.topLevel = () => AgentManager.prototype.topLevel.call(m);
  m.topLevelSibling = (id: string, delta: number, includeArchived?: boolean) =>
    AgentManager.prototype.topLevelSibling.call(m, id, delta, includeArchived);
  m.siblingOf = (id: string, delta: number) =>
    AgentManager.prototype.siblingOf.call(m, id, delta);
  return m;
}

const config: OrcConfig = { projects: [{ name: 'proj', repoPath: '/tmp' }] } as unknown as OrcConfig;
const delay = () => new Promise((r) => setTimeout(r, 50));

function selectedName(frame: string): string | undefined {
  for (const line of frame.split('\n')) {
    if (line.includes('›')) {
      const m = line.match(/›.*?((?:active|arch)-(?:one|two|child))/);
      if (m) return m[1];
    }
  }
  return undefined;
}

test('j/k walk every archived agent flatly, including former children', async () => {
  const manager = makeManager();
  const { stdin, lastFrame, unmount } = render(React.createElement(App, { manager, config }));
  await delay();

  stdin.write('t'); // expand Done
  await delay();

  // Step down from the active agent onto the first archived agent.
  stdin.write('j');
  await delay();
  assert.equal(selectedName(lastFrame() ?? ''), 'arch-one');

  // j lands on the former CHILD (no longer skipped) — the Done section is flat.
  stdin.write('j');
  await delay();
  assert.equal(selectedName(lastFrame() ?? ''), 'arch-child');

  // j continues to the next archived agent.
  stdin.write('j');
  await delay();
  assert.equal(selectedName(lastFrame() ?? ''), 'arch-two');

  // k steps back up through the same flat list.
  stdin.write('k');
  await delay();
  assert.equal(selectedName(lastFrame() ?? ''), 'arch-child');

  unmount();
});

test('the expanded Done section renders the full hierarchy: project header + nested child', async () => {
  const manager = makeManager();
  const { stdin, lastFrame, unmount } = render(React.createElement(App, { manager, config }));
  await delay();

  stdin.write('t'); // expand Done
  await delay();
  const frame = lastFrame() ?? '';

  // Archived agents render with the SAME full AgentRow layout as active ones: a project header for
  // the archived group and the `└` connector for a former child nested under its parent.
  assert.match(frame, /proj/, 'the archived group shows its project header');
  assert.match(frame, /arch-one/, 'the archived parent is shown');
  assert.match(frame, /└ .*arch-child/, 'the former child is nested under its parent with a connector');
  assert.match(frame, /arch-two/, 'the second archived parent is shown');

  unmount();
});

