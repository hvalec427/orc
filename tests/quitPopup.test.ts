import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import type { OrcConfig } from '../src/types.js';

function makeSession() {
  const info = {
    id: 'a1',
    name: 'agent-one',
    template: 'bug-fix',
    status: 'done',
    branch: 'agent/a1',
    parentId: undefined,
  };
  return {
    id: 'a1',
    name: 'agent-one',
    parentId: undefined,
    project: 'proj',
    pendingApproval: undefined,
    getInfo: () => info,
    getEvents: () => [{ kind: 'text', text: 'hello', done: true }],
  } as any;
}

/** Minimal AgentManager stand-in. `withAgent` controls whether an agent is selected. */
function makeManager(withAgent = false) {
  const m = new EventEmitter() as any;
  const sessions = withAgent ? [makeSession()] : [];
  m.list = () => sessions;
  m.active = () => sessions.filter((s: any) => !s.getInfo().archived);
  m.archived = () => sessions.filter((s: any) => s.getInfo().archived);
  m.projects = () => [{ name: 'proj', repoPath: '/tmp' }];
  m.get = (id: string) => sessions.find((s: any) => s.id === id);
  m.stopAll = async () => {};
  m.firstWaiting = () => undefined;
  m.firstChildOf = () => undefined;
  m.firstActiveChildOf = () => undefined;
  m.activeChildrenOf = () => [];
  m.groupRootOf = (id: string) => ({ id });
  m.mergeChildOf = () => undefined;
  m.create = async () => makeSession();
  return m;
}

// A project is configured so the new-agent form *could* open if `n` leaked through —
// that is exactly the bug this suite guards against.
const config: OrcConfig = {
  projects: [{ name: 'proj', repoPath: '/tmp' }],
} as unknown as OrcConfig;

const delay = () => new Promise((r) => setTimeout(r, 50));
const ESC = '\u001b';

test('Esc closes the quit confirmation popup', async () => {
  const manager = makeManager();
  const { stdin, lastFrame, unmount } = render(
    React.createElement(App, { manager, config }),
  );
  await delay();

  // Open the quit popup.
  stdin.write('q');
  await delay();
  assert.match(lastFrame() ?? '', /Quit orc\?/, 'popup should be open after q');

  // Press Esc to cancel.
  stdin.write(ESC);
  await delay();
  assert.doesNotMatch(
    lastFrame() ?? '',
    /Quit orc\?/,
    'popup should be closed after pressing Esc',
  );

  unmount();
});

test('n does not cancel the popup and does not open the new-agent form', async () => {
  // Regression: `n` used to cancel the quit popup, which collided with `n`=new-agent.
  // After cancelling, a second `n` immediately opened the new-agent form — so from the
  // user's view "n did nothing, then n opened the new agent flow". `n` must now be inert
  // while the popup is up, and Esc is the only way to cancel.
  const manager = makeManager(true);
  const { stdin, lastFrame, unmount } = render(
    React.createElement(App, { manager, config }),
  );
  await delay();

  stdin.write('q');
  await delay();
  assert.match(lastFrame() ?? '', /Quit orc\?/, 'popup should be open after q');

  // First n: must be swallowed — popup stays, form must not appear.
  stdin.write('n');
  await delay();
  assert.match(lastFrame() ?? '', /Quit orc\?/, 'popup should stay open after n');

  // Second n: still swallowed — must NOT open the new-agent form.
  stdin.write('n');
  await delay();
  assert.match(
    lastFrame() ?? '',
    /Quit orc\?/,
    'popup should still be open after a second n',
  );

  // Esc finally cancels, returning to the list (not the new-agent form).
  stdin.write(ESC);
  await delay();
  const frame = lastFrame() ?? '';
  assert.doesNotMatch(frame, /Quit orc\?/, 'Esc should close the popup');

  unmount();
});

test('y confirms quit and stops all agents', async () => {
  const manager = makeManager(true);
  let stopped = false;
  manager.stopAll = async () => {
    stopped = true;
  };
  const { stdin, lastFrame, unmount } = render(
    React.createElement(App, { manager, config }),
  );
  await delay();

  stdin.write('q');
  await delay();
  assert.match(lastFrame() ?? '', /Quit orc\?/, 'popup should be open after q');

  stdin.write('y');
  await delay();
  assert.equal(stopped, true, 'y should trigger stopAll');

  unmount();
});

test('opening and closing the popup does not change the frame height', async () => {
  // The popup ghosted on iTerm2's alt screen because the frame was one row TALLER while
  // the popup was up (overlayRows under-reserved the bordered box). Closing then shrank
  // the frame by a line, which Ink doesn't clear on the alt screen — so the box stayed
  // drawn. Lock the invariant: the rendered line count must be identical open vs closed.
  const manager = makeManager(true);
  const { stdin, lastFrame, unmount } = render(
    React.createElement(App, { manager, config }),
  );
  await delay();

  const linesOf = () => (lastFrame() ?? '').split('\n').length;
  const closedHeight = linesOf();

  stdin.write('q');
  await delay();
  assert.match(lastFrame() ?? '', /Quit orc\?/, 'popup should be open after q');
  assert.equal(
    linesOf(),
    closedHeight,
    'frame height must not change when the popup opens',
  );

  stdin.write(ESC);
  await delay();
  assert.doesNotMatch(lastFrame() ?? '', /Quit orc\?/, 'popup should be closed');
  assert.equal(
    linesOf(),
    closedHeight,
    'frame height must return to the original after closing',
  );

  unmount();
});
