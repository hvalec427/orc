import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import type { OrcConfig } from '../src/types.js';

// A single top-level feature agent, done and on a branch so `m` would be offered. We mutate its
// `archived` flag through the mock manager's archive()/unarchive() and assert the UI reacts.
type Rec = { id: string; name: string; status: string; branch?: string; archived?: boolean };

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

function makeManager() {
  const a = session({ id: 'a1', name: 'agent-one', status: 'done', branch: 'agent/a1' });
  const ordered = [a];
  const byId = new Map(ordered.map((s) => [s.id, s]));

  const m = new EventEmitter() as any;
  m.calls = { archive: [] as string[], unarchive: [] as string[], mergeAgent: [] as string[], remove: [] as string[] };
  m.list = () => ordered;
  m.active = () => ordered.filter((s: any) => !s.getInfo().archived);
  m.archived = () => ordered.filter((s: any) => s.getInfo().archived);
  m.projects = () => [{ name: 'proj', repo: '/tmp' }];
  m.get = (id: string) => byId.get(id);
  m.stopAll = async () => {};
  m.firstWaiting = () => undefined;
  m.mergeChildOf = () => undefined;
  m.firstChildOf = () => undefined;
  m.firstActiveChildOf = () => undefined;
  m.childrenOf = () => [];
  m.activeChildrenOf = () => [];
  m.groupRootOf = (id: string) => byId.get(id);
  m.topLevel = () => m.active();
  m.topLevelSibling = (id: string) => byId.get(id);
  m.siblingOf = () => undefined;
  m.archive = async (id: string) => {
    m.calls.archive.push(id);
    byId.get(id)._info.archived = true;
    m.emit('update');
  };
  m.unarchive = async (id: string) => {
    m.calls.unarchive.push(id);
    byId.get(id)._info.archived = false;
    m.emit('update');
  };
  m.mergeAgent = async (id: string) => {
    m.calls.mergeAgent.push(id);
    return byId.get(id);
  };
  m.remove = async (id: string) => {
    m.calls.remove.push(id);
  };
  return m;
}

const config: OrcConfig = { projects: [{ name: 'proj', repo: '/tmp' }] } as unknown as OrcConfig;
const delay = () => new Promise((r) => setTimeout(r, 50));

test('d archives the selected agent (non-destructive) and shows the Done section', async () => {
  const manager = makeManager();
  const { stdin, lastFrame, unmount } = render(React.createElement(App, { manager, config }));
  await delay();

  stdin.write('d');
  await delay();

  assert.deepEqual(manager.calls.archive, ['a1'], 'd calls archive');
  assert.deepEqual(manager.calls.remove, [], 'd does NOT destructively remove');
  assert.match(lastFrame() ?? '', /Done \(1\)/, 'the Done section header appears with a count');

  unmount();
});

test('t toggles the Done section open, revealing the archived agent', async () => {
  const manager = makeManager();
  const { stdin, lastFrame, unmount } = render(React.createElement(App, { manager, config }));
  await delay();

  stdin.write('d'); // archive it first
  await delay();
  // Collapsed: the name is not shown, only the header.
  assert.doesNotMatch(lastFrame() ?? '', /agent-one/, 'archived name hidden while collapsed');

  stdin.write('t'); // expand Done
  await delay();
  assert.match(lastFrame() ?? '', /agent-one/, 'archived name shown once Done is expanded');

  unmount();
});

test('Shift+D destructively deletes', async () => {
  const manager = makeManager();
  const { stdin, unmount } = render(React.createElement(App, { manager, config }));
  await delay();

  stdin.write('D');
  await delay();

  assert.deepEqual(manager.calls.remove, ['a1'], 'D calls remove');
  assert.deepEqual(manager.calls.archive, [], 'D does not archive');

  unmount();
});

test('m is refused for an archived agent', async () => {
  const manager = makeManager();
  const { stdin, unmount } = render(React.createElement(App, { manager, config }));
  await delay();

  stdin.write('d'); // archive it
  await delay();
  // Selection moved off it, so reselect by expanding Done and navigating is not wired in this mock;
  // instead archive leaves selection on the (now archived) agent since it's the only one.
  stdin.write('t');
  await delay();

  stdin.write('m');
  await delay();

  assert.deepEqual(manager.calls.mergeAgent, [], 'integrate is not invoked for an archived agent');

  unmount();
});

test('sending a message to an archived agent unarchives it', async () => {
  const manager = makeManager();
  const { stdin, unmount } = render(React.createElement(App, { manager, config }));
  await delay();

  stdin.write('d'); // archive
  await delay();
  stdin.write('t'); // expand Done so the archived agent is selectable/visible
  await delay();
  stdin.write('i'); // open the ask/reply input
  await delay();
  stdin.write('follow up');
  await delay();
  stdin.write('\r'); // submit
  await delay();

  assert.deepEqual(manager.calls.unarchive, ['a1'], 'sending a message calls unarchive');

  unmount();
});

test('u is no longer a command (does not unarchive)', async () => {
  const manager = makeManager();
  const { stdin, unmount } = render(React.createElement(App, { manager, config }));
  await delay();

  stdin.write('d'); // archive
  await delay();
  stdin.write('t'); // expand Done
  await delay();
  stdin.write('u'); // former unarchive key — should be inert now
  await delay();

  assert.deepEqual(manager.calls.unarchive, [], 'u does nothing');

  unmount();
});
