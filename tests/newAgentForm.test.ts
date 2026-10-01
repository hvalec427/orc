import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { NewAgentForm } from '../src/ui/NewAgentForm.js';
import type { ProjectConfig } from '../src/types.js';

const delay = () => new Promise((r) => setTimeout(r, 50));
const ENTER = '\r';

// Single project so the project-chooser step is skipped and the flow is deterministic.
const projects = [{ name: 'proj', repo: '/tmp' }] as unknown as ProjectConfig[];

type SubmitArgs = [string, string, string, string, string, string | undefined];

/** Render the form, pick the Feature template, and return a helper to drive it. */
function renderForm(opts: { parentName?: string; parentTicket?: string }) {
  const submissions: SubmitArgs[] = [];
  const r = render(
    React.createElement(NewAgentForm, {
      projects,
      parentName: opts.parentName,
      parentTicket: opts.parentTicket,
      onSubmit: (...args: SubmitArgs) => submissions.push(args),
      onCancel: () => {},
    }),
  );
  return { ...r, submissions };
}

test('subagent may leave the name blank to reuse the parent name', async () => {
  const { stdin, lastFrame, submissions, unmount } = renderForm({
    parentName: 'parent-agent',
  });
  await delay();

  // Template picker starts on "Feature" (first entry); select it.
  stdin.write(ENTER);
  await delay();

  // On the name step the placeholder should offer to reuse the parent name.
  assert.match(lastFrame() ?? '', /Enter to reuse "parent-agent"/);

  // Submit a blank name — allowed for subagents.
  stdin.write(ENTER);
  await delay();

  // Feature parent had no ticket, so the ticket step shows; skip it.
  stdin.write(ENTER);
  await delay();

  // Fill the prompt and create.
  stdin.write('do the thing');
  await delay();
  stdin.write(ENTER);
  await delay();

  assert.equal(submissions.length, 1, 'form should submit once');
  const [, , name] = submissions[0];
  assert.equal(name, 'parent-agent', 'blank name must default to the parent name');

  unmount();
});

test('subagent skips the ticket step and inherits the parent ticket', async () => {
  const { stdin, lastFrame, submissions, unmount } = renderForm({
    parentName: 'parent-agent',
    parentTicket: 'PROJ-123',
  });
  await delay();

  stdin.write(ENTER); // choose Feature
  await delay();

  stdin.write('child-name');
  await delay();
  stdin.write(ENTER); // submit name -> should jump straight to prompt
  await delay();

  // The ticket field must not be prompted for when inherited.
  assert.doesNotMatch(lastFrame() ?? '', /ticket :/, 'ticket step must be skipped');

  stdin.write('do the thing');
  await delay();
  stdin.write(ENTER);
  await delay();

  assert.equal(submissions.length, 1, 'form should submit once');
  const [, , name, ticket] = submissions[0];
  assert.equal(name, 'child-name');
  assert.equal(ticket, 'PROJ-123', 'subagent must inherit the parent ticket');

  unmount();
});

test('top-level feature agent still requires a name and prompts for a ticket', async () => {
  const { stdin, lastFrame, submissions, unmount } = renderForm({});
  await delay();

  stdin.write(ENTER); // choose Feature
  await delay();

  // Blank name must NOT advance for a top-level agent.
  stdin.write(ENTER);
  await delay();
  assert.match(lastFrame() ?? '', /name   :/, 'name step should remain on blank submit');
  assert.equal(submissions.length, 0);

  stdin.write('login-flow');
  await delay();
  stdin.write(ENTER);
  await delay();

  // Ticket step should be shown for a top-level feature agent.
  assert.match(lastFrame() ?? '', /ticket :/, 'top-level feature agent should prompt for a ticket');

  unmount();
});
