import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import type { OrcConfig } from '../src/types.js';

// ink-testing-library does not set stdout.rows, so App falls back to rows = 30 (see App.tsx).
// The invariant under test: the TOTAL rendered frame must never be taller than that budget, no
// matter how many agents the sidebar lists or whether a parent or a child is selected. Before the
// fix the sidebar grew the frame one block per agent, so with enough agents the frame exceeded the
// terminal height — the real terminal then scrolled and Ink's redraw walked the frame off the top
// (the "TUI moves up / out of the window when switching agents" bug).
const ROWS_FALLBACK = 30;

function session(rec: {
  id: string;
  name: string;
  parentId?: string;
  template: string;
  status: string;
}) {
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

// One parent with two children, plus many extra top-level agents so the sidebar is far taller than
// the terminal. This is the shape that triggered the overflow.
function makeManager(topLevelCount: number) {
  const ordered: any[] = [];
  ordered.push(session({ id: 'p1', name: 'parent-one', template: 'feature', status: 'working' }));
  ordered.push(session({ id: 'c1', name: 'child-one', parentId: 'p1', template: 'reviewer', status: 'done' }));
  ordered.push(session({ id: 'c2', name: 'child-two', parentId: 'p1', template: 'tester', status: 'done' }));
  for (let i = 2; i <= topLevelCount; i++) {
    ordered.push(session({ id: 'p' + i, name: 'parent-' + i, template: 'feature', status: 'working' }));
  }
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
    return tops[Math.max(0, Math.min(idx + delta, tops.length - 1))];
  };
  m.siblingOf = (id: string, delta: number) => {
    const a = byId.get(id);
    if (!a?.parentId) return undefined;
    const sibs = m.childrenOf(a.parentId);
    const idx = sibs.findIndex((s: any) => s.id === id);
    if (idx === -1) return undefined;
    return sibs[Math.max(0, Math.min(idx + delta, sibs.length - 1))];
  };
  return m;
}

const config: OrcConfig = { projects: [{ name: 'proj', repoPath: '/tmp' }] } as unknown as OrcConfig;
const delay = () => new Promise((r) => setTimeout(r, 60));
const frameHeight = (s: string | undefined) => (s ?? '').split('\n').length;

test('frame never exceeds the terminal height with many agents', async () => {
  const manager = makeManager(12); // sidebar would be ~46 rows tall before the fix
  const { lastFrame, unmount } = render(React.createElement(App, { manager, config }));
  await delay();

  assert.ok(
    frameHeight(lastFrame()) <= ROWS_FALLBACK,
    `frame (${frameHeight(lastFrame())} rows) must fit within the terminal (${ROWS_FALLBACK} rows)`,
  );

  unmount();
});

test('frame height stays constant when switching between a parent and its child', async () => {
  const manager = makeManager(12);
  const { stdin, lastFrame, unmount } = render(React.createElement(App, { manager, config }));
  await delay();

  const parentHeight = frameHeight(lastFrame());

  stdin.write('l'); // descend into the first child
  await delay();
  const childHeight = frameHeight(lastFrame());

  assert.equal(childHeight, parentHeight, 'frame height must not change when entering a subagent');
  assert.ok(childHeight <= ROWS_FALLBACK, 'frame must still fit within the terminal');

  stdin.write('h'); // back up to the parent
  await delay();
  assert.equal(frameHeight(lastFrame()), parentHeight, 'frame height must not change when leaving a subagent');

  unmount();
});

test('the selected agent stays visible in the sidebar after scrolling down the list', async () => {
  // With a long list the sidebar must scroll to keep the caret in view rather than growing the frame.
  const manager = makeManager(12);
  const { stdin, lastFrame, unmount } = render(React.createElement(App, { manager, config }));
  await delay();

  // Walk to the last top-level agent; its caret row must be present in the clipped sidebar.
  for (let i = 0; i < 11; i++) {
    stdin.write('j');
    await delay();
  }
  const frame = lastFrame() ?? '';
  assert.ok(frame.includes('›'), 'a selection caret must remain visible after scrolling');
  assert.ok(frame.includes('parent-12'), 'the selected agent must be scrolled into view');
  assert.ok(frameHeight(frame) <= ROWS_FALLBACK, 'frame must still fit within the terminal');

  unmount();
});
