import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import type { OrcConfig } from '../src/types.js';

// Two top-level agents, the first with two subagents. The ordering mirrors AgentManager.list():
// top-level newest-first, each parent's children nested immediately beneath it, oldest-first.
//
//   p1  (parent, selected first)
//     c1
//     c2
//   p2  (parent)
//
// We select by id, so navigation assertions check which name is bold/marked in the frame.
type Rec = {
  id: string;
  name: string;
  parentId?: string;
  template: string;
  status: string;
};

function session(rec: Rec) {
  const info = { branch: undefined, ...rec };
  return {
    id: rec.id,
    name: rec.name,
    parentId: rec.parentId,
    project: 'proj',
    pendingApproval: undefined,
    getInfo: () => info,
    getEvents: () => [{ kind: 'text', text: rec.name, done: true }],
  } as any;
}

function makeManager() {
  const p1 = session({ id: 'p1', name: 'parent-one', template: 'feature', status: 'working' });
  const c1 = session({ id: 'c1', name: 'child-one', parentId: 'p1', template: 'reviewer', status: 'done' });
  const c2 = session({ id: 'c2', name: 'child-two', parentId: 'p1', template: 'tester', status: 'done' });
  const p2 = session({ id: 'p2', name: 'parent-two', template: 'feature', status: 'working' });

  // list() order: p1, c1, c2, p2 (as AgentManager.list would produce for this tree).
  const ordered = [p1, c1, c2, p2];
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
  m.groupRootOf = (id: string) => {
    const a = byId.get(id);
    return a?.parentId ? byId.get(a.parentId) : a;
  };
  m.firstChildOf = (id: string) => ordered.find((s) => s.getInfo().parentId === id);
  m.childrenOf = (id: string) => ordered.filter((s) => s.getInfo().parentId === id);
  m.topLevel = () => ordered.filter((s) => !s.getInfo().parentId);
  m.topLevelSibling = (id: string, delta: number) => {
    const tops = m.topLevel();
    const root = m.groupRootOf(id);
    const idx = tops.findIndex((s: any) => s.id === root.id);
    const next = Math.max(0, Math.min(idx + delta, tops.length - 1));
    return tops[next];
  };
  m.siblingOf = (id: string, delta: number) => {
    const a = byId.get(id);
    if (!a?.parentId) return undefined;
    const sibs = m.childrenOf(a.parentId);
    const idx = sibs.findIndex((s: any) => s.id === id);
    if (idx === -1) return undefined;
    const next = Math.max(0, Math.min(idx + delta, sibs.length - 1));
    return sibs[next];
  };
  return m;
}

const config: OrcConfig = { projects: [{ name: 'proj', repoPath: '/tmp' }] } as unknown as OrcConfig;
const delay = () => new Promise((r) => setTimeout(r, 50));

/** The selected row is the one the sidebar marks with the `›` caret. */
function selectedName(frame: string): string | undefined {
  for (const line of frame.split('\n')) {
    if (line.includes('›')) {
      const m = line.match(/›.*?([a-z-]+-(?:one|two))/);
      if (m) return m[1];
    }
  }
  return undefined;
}

test('j/k move only between top-level agents when a parent is selected', async () => {
  const manager = makeManager();
  const { stdin, lastFrame, unmount } = render(React.createElement(App, { manager, config }));
  await delay();

  // Defaults to the first agent in the list (parent-one).
  assert.equal(selectedName(lastFrame() ?? ''), 'parent-one');

  // j skips the children and lands on the next PARENT.
  stdin.write('j');
  await delay();
  assert.equal(selectedName(lastFrame() ?? ''), 'parent-two');

  // j at the end clamps (no wrap).
  stdin.write('j');
  await delay();
  assert.equal(selectedName(lastFrame() ?? ''), 'parent-two');

  // k goes back up to the previous parent.
  stdin.write('k');
  await delay();
  assert.equal(selectedName(lastFrame() ?? ''), 'parent-one');

  unmount();
});

test('l enters subagents and j/k then navigate within the group; h returns to the parent', async () => {
  const manager = makeManager();
  const { stdin, lastFrame, unmount } = render(React.createElement(App, { manager, config }));
  await delay();
  assert.equal(selectedName(lastFrame() ?? ''), 'parent-one');

  // l descends into the first child.
  stdin.write('l');
  await delay();
  assert.equal(selectedName(lastFrame() ?? ''), 'child-one');

  // j moves to the next sibling, not out to parent-two.
  stdin.write('j');
  await delay();
  assert.equal(selectedName(lastFrame() ?? ''), 'child-two');

  // j at the last sibling clamps inside the group (does NOT jump to parent-two).
  stdin.write('j');
  await delay();
  assert.equal(selectedName(lastFrame() ?? ''), 'child-two');

  // k goes back to the first child.
  stdin.write('k');
  await delay();
  assert.equal(selectedName(lastFrame() ?? ''), 'child-one');

  // h exits back to the parent (the main list).
  stdin.write('h');
  await delay();
  assert.equal(selectedName(lastFrame() ?? ''), 'parent-one');

  unmount();
});

test('launching a subagent keeps focus on the parent, not the new child', async () => {
  const manager = makeManager();

  // Model createSubagent: append a new child under the parent, announce the change, and resolve
  // with the new session — mirroring AgentManager so App's onSubmit handler runs its real path.
  let created: any;
  manager.ordered = manager.list();
  manager.createSubagent = async (parentId: string) => {
    created = session({ id: 'c3', name: 'child-new', parentId, template: 'feature', status: 'working' });
    manager.ordered.push(created);
    manager.list = () => manager.ordered;
    manager.active = () => manager.ordered.filter((s: any) => !s.getInfo().archived);
    manager.childrenOf = (id: string) => manager.ordered.filter((s: any) => s.getInfo().parentId === id);
    manager.emit('update');
    return created;
  };

  const { stdin, lastFrame, unmount } = render(React.createElement(App, { manager, config }));
  await delay();
  assert.equal(selectedName(lastFrame() ?? ''), 'parent-one');

  // c opens the new-agent form scoped to the selected agent's group.
  stdin.write('c');
  await delay();

  // Drive the form: choose the first template, reuse the parent name, skip ticket, add a prompt.
  stdin.write('\r'); // template
  await delay();
  stdin.write('\r'); // name (reuse parent)
  await delay();
  stdin.write('\r'); // ticket (skip)
  await delay();
  stdin.write('do the thing');
  await delay();
  stdin.write('\r'); // submit
  await delay();

  assert.ok(created, 'createSubagent should have been invoked');
  // Focus must remain on the parent; it must NOT jump to the freshly launched child.
  assert.equal(selectedName(lastFrame() ?? ''), 'parent-one', 'focus stays on the parent after launching a subagent');

  unmount();
});

test('integrating an agent (m) keeps focus on the source, not the merge child', async () => {
  const manager = makeManager();

  // The source agent must be mergeable: it has a branch and its turn has ended (not working/booting).
  const src = session({ id: 'p1', name: 'parent-one', template: 'feature', status: 'done' });
  (src.getInfo() as any).branch = 'feat/x';
  const c1 = session({ id: 'c1', name: 'child-one', parentId: 'p1', template: 'reviewer', status: 'done' });
  const c2 = session({ id: 'c2', name: 'child-two', parentId: 'p1', template: 'tester', status: 'done' });
  const p2 = session({ id: 'p2', name: 'parent-two', template: 'feature', status: 'working' });
  const ordered = [src, c1, c2, p2];
  manager.list = () => ordered;
  manager.active = () => ordered.filter((s: any) => !s.getInfo().archived);
  manager.get = (id: string) => ordered.find((s: any) => s.id === id);
  manager.childrenOf = (id: string) => ordered.filter((s: any) => s.getInfo().parentId === id);

  // Model mergeAgent: spawn a merge subagent nested under the source and resolve with it, mirroring
  // AgentManager so App's `m` handler runs its real path.
  let created: any;
  manager.mergeAgent = async (id: string) => {
    created = session({ id: 'm1', name: 'merge-child', parentId: id, template: 'merge', status: 'working' });
    ordered.push(created);
    manager.emit('update');
    return created;
  };

  const { stdin, lastFrame, unmount } = render(React.createElement(App, { manager, config }));
  await delay();
  assert.equal(selectedName(lastFrame() ?? ''), 'parent-one');

  stdin.write('m');
  await delay();

  assert.ok(created, 'mergeAgent should have been invoked');
  // Focus must remain on the source; it must NOT jump to the freshly spawned merge child.
  assert.equal(selectedName(lastFrame() ?? ''), 'parent-one', 'focus stays on the source after integrating');

  unmount();
});

test('l does nothing on a parent with no subagents', async () => {
  const manager = makeManager();
  const { stdin, lastFrame, unmount } = render(React.createElement(App, { manager, config }));
  await delay();

  // Move to parent-two, which has no children.
  stdin.write('j');
  await delay();
  assert.equal(selectedName(lastFrame() ?? ''), 'parent-two');

  stdin.write('l');
  await delay();
  assert.equal(selectedName(lastFrame() ?? ''), 'parent-two', 'l is inert with no subagents');

  unmount();
});
