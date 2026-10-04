import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import type { OrcConfig } from '../src/types.js';

// ===================================================================================================
// Core measurable flicker test (planned — per-slice subscriptions + React.memo).
//
// The flicker bug: EVERY global `manager.emit('update')` drives App's single `setTick`, repainting
// the whole React tree (~15fps from AgentSession.scheduleEmit's 66ms coalescer). The fix routes each
// pane to its own slice via useSyncExternalStore so a background update to a NON-selected agent does
// NOT repaint the selected AgentView.
//
// What we measure:
//   1. (authoritative) The selected pane's rendered frame is BYTE-IDENTICAL before and after a
//      background content update to a non-selected agent.
//   2. (render signal) A React.Profiler wraps <App> and counts React COMMITS. Today a non-selected
//      'update' fires App's global setTick → a top-level commit (count increases). After the fix the
//      selected pane subscribes to its own slice, so a non-selected content update must NOT commit
//      the tree. We assert ZERO additional commits across the background update.
//
// Why a Profiler (not a render-counter prop): the production AgentView takes no test-only counter
// prop and this suite must not change production code. React.Profiler's `onRender` is the only
// non-invasive way to observe commits through ink-testing-library. If Profiler proves unreliable in
// this harness the byte-identity assertion still encodes the behaviour; the commit count is the
// extra signal that makes the test meaningfully FAIL today (a global setTick commit) and PASS once
// the selected pane no longer subscribes to unrelated updates.
//
// Expected RED until the implementer replaces the global setTick subscription with per-slice
// useSyncExternalStore subscriptions + React.memo on the panes.
// ===================================================================================================

type Rec = { id: string; name: string; parentId?: string; template: string; status: string };

/**
 * Duck-typed mock session matching the shape the existing ink tests use (see tests/sidebarNav.test.ts
 * / tests/frameHeight.test.ts). Its events live in a mutable array so a background update can change a
 * NON-selected agent's content without touching the selected one. Forward-compatible with the fix:
 * exposes `eventsVersion()` (bumped whenever its events change) — the one-liner the plan requires on
 * every mock; the implementer migrates the other 8 mock files in their own step, not here.
 */
function session(rec: Rec) {
  const info = { branch: undefined, ticket: '', ...rec };
  let version = 0;
  const events: Array<{ kind: string; text: string; done: boolean }> = [
    { kind: 'text', text: rec.name, done: true },
  ];
  return {
    id: rec.id,
    name: rec.name,
    parentId: rec.parentId,
    project: 'proj',
    pendingApproval: undefined,
    getInfo: () => info,
    getEvents: () => events,
    eventsVersion: () => version,
    /** Test helper: append a log line and bump the version, as a real content update would. */
    pushEvent(text: string) {
      events.push({ kind: 'text', text, done: true });
      version += 1;
    },
  } as any;
}

function makeManager() {
  // Two top-level agents; a1 is selected by default (first in the list), a2 is the background one.
  const a1 = session({ id: 'a1', name: 'alpha-one', template: 'feature', status: 'working' });
  const a2 = session({ id: 'a2', name: 'beta-two', template: 'feature', status: 'working' });
  const ordered = [a1, a2];
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
  m.activeChildrenOf = (id: string) =>
    ordered.filter((s) => s.getInfo().parentId === id && !s.getInfo().archived);
  m.firstActiveChildOf = (id: string) =>
    ordered.find((s) => s.getInfo().parentId === id && !s.getInfo().archived);
  m.topLevel = () => ordered.filter((s) => !s.getInfo().parentId);
  m.topLevelSibling = (id: string, delta: number) => {
    const tops = m.topLevel();
    const root = m.groupRootOf(id);
    const idx = tops.findIndex((s: any) => s.id === root.id);
    return tops[Math.max(0, Math.min(idx + delta, tops.length - 1))];
  };
  m.siblingOf = () => undefined;
  return { manager: m, a1, a2 };
}

const config: OrcConfig = { projects: [{ name: 'proj', repoPath: '/tmp' }] } as unknown as OrcConfig;
const delay = () => new Promise((r) => setTimeout(r, 60));

/**
 * Extract the AgentView (right-hand log) pane region of a frame so the assertion focuses on the
 * SELECTED agent's pane, not the sidebar. The selected pane always carries the selected agent's name
 * on its header line; the sidebar rows are short. We key off the agent name being present on the
 * header line and return the whole frame when we cannot isolate (byte-identity of the whole frame is
 * a strict superset of pane identity anyway).
 */
function selectedPaneFrame(frame: string): string {
  return frame; // whole-frame identity is strictly stronger; keep it simple and robust.
}

test('a background update to a non-selected agent does NOT repaint the selected pane', async () => {
  const { manager, a1, a2 } = makeManager();

  // Count React commits of the whole App tree via a Profiler wrapper.
  let commits = 0;
  const onRender = () => {
    commits += 1;
  };
  const element = React.createElement(
    React.Profiler,
    { id: 'app', onRender },
    React.createElement(App, { manager, config }),
  );

  const { lastFrame, unmount } = render(element);
  await delay();

  // a1 ("alpha-one") is selected by default. Snapshot its pane frame and the commit count.
  const beforeFrame = selectedPaneFrame(lastFrame() ?? '');
  assert.match(beforeFrame, /alpha-one/, 'alpha-one should be the selected agent');
  const commitsBefore = commits;

  // Background update: change the NON-selected agent's (beta-two) content, then emit the global
  // 'update' the manager fires after any session changes. The selected agent (alpha-one) is
  // untouched, so its pane must not change.
  a2.pushEvent('beta made progress');
  manager.emit('update');
  await delay();

  const afterFrame = selectedPaneFrame(lastFrame() ?? '');

  // (1) Authoritative: the selected pane's rendered bytes are identical.
  assert.equal(
    afterFrame,
    beforeFrame,
    'the selected pane must be byte-identical after a background (non-selected) update',
  );

  // (2) Render signal: no extra commit was needed for a non-selected content update. Today App's
  // global setTick forces a top-level commit here (RED); after the per-slice subscription fix the
  // selected pane subscribes only to its own slice, so this stays at zero.
  assert.equal(
    commits - commitsBefore,
    0,
    'a non-selected content update must not commit the selected pane (expected RED before the fix)',
  );

  // Sanity: a2's event really did change, so the test is exercising a real background update.
  assert.equal(a2.eventsVersion(), 1, 'the background agent recorded its content change');

  unmount();
});

test('an update that changes the SELECTED agent DOES repaint its pane', async () => {
  // Guards against a trivially-passing fix that never repaints: a change to the selected agent must
  // still surface in its pane. This should pass both before and after the fix.
  const { manager, a1 } = makeManager();
  const { lastFrame, unmount } = render(React.createElement(App, { manager, config }));
  await delay();

  const before = lastFrame() ?? '';
  assert.match(before, /alpha-one/, 'alpha-one should be selected');
  assert.doesNotMatch(before, /alpha advanced/, 'the new line is not present yet');

  a1.pushEvent('alpha advanced');
  manager.emit('update');
  await delay();

  const after = lastFrame() ?? '';
  assert.match(after, /alpha advanced/, 'a change to the SELECTED agent must appear in its pane');

  unmount();
});
