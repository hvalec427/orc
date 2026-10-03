import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Sidebar } from '../src/ui/Sidebar.js';
import type { AgentInfo } from '../src/types.js';

function makeAgents(n: number): AgentInfo[] {
  const out: AgentInfo[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `a${i}`,
      name: `agent-${i}`,
      parentId: undefined,
      project: 'proj',
      template: 'feature',
      status: 'working',
      totalCostUsd: 0,
    } as AgentInfo);
  }
  return out;
}

/**
 * Is the selected agent's WHOLE block visible — both its `›`-marked name row AND the
 * `template · cost` line directly beneath it? Checking only the caret line is too weak: a
 * mis-scrolled block can show its caret on the last visible row with the cost line clipped.
 */
function selectedVisible(frame: string, name: string): boolean {
  const lines = frame.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('›') && lines[i].includes(name)) {
      const below = lines[i + 1] ?? '';
      // The cost line must be present and not the box's bottom border.
      return below.includes('·') && !below.includes('╰');
    }
  }
  return false;
}

test('selected agent stays visible when it is below the fold', () => {
  const active = makeAgents(20);
  // Small body height so most agents are off-screen.
  const height = 12;
  for (let sel = 0; sel < active.length; sel++) {
    const { lastFrame, unmount } = render(
      React.createElement(Sidebar, {
        active,
        archived: [],
        showDone: false,
        selectedIndex: sel,
        height,
      }),
    );
    const frame = lastFrame() ?? '';
    assert.ok(
      selectedVisible(frame, `agent-${sel}`),
      `selected agent-${sel} should be visible in the frame but was not:\n${frame}`,
    );
    unmount();
  }
});

test('selected archived agent stays visible with Done section expanded', () => {
  const active = makeAgents(10).map((a, i) => ({ ...a, id: `act${i}`, name: `active-${i}` }));
  const archived = makeAgents(10).map((a, i) => ({ ...a, id: `arc${i}`, name: `archived-${i}` }));
  const height = 12;
  const total = active.length + archived.length;
  for (let sel = 0; sel < total; sel++) {
    const name = sel < active.length ? `active-${sel}` : `archived-${sel - active.length}`;
    const { lastFrame, unmount } = render(
      React.createElement(Sidebar, {
        active,
        archived,
        showDone: true,
        selectedIndex: sel,
        height,
      }),
    );
    const frame = lastFrame() ?? '';
    assert.ok(
      selectedVisible(frame, name),
      `selected ${name} (index ${sel}) should be visible but was not:\n${frame}`,
    );
    unmount();
  }
});
