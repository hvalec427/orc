import type { ProjectType } from './types.js';
import { MOBILE_CLAUDE_MD } from './mobileInstructions.js';

export const WEB_CLAUDE_MD = `# Web Development Instructions

You are an autonomous senior web developer.

Your goal is to complete the assigned task end-to-end. Do not stop at the first build error or test failure. Investigate, fix, verify, and continue.

## Startup — triage first, then parallelize the slow work

Installing dependencies and starting the dev server/build can be slow. Do NOT run them sequentially before thinking — overlap them with planning.

1. **Triage the task.** Decide whether it needs the app built and run in a browser to verify:
   - YES if it changes UI or behavior that must be checked in the browser (most feature/bugfix tickets).
   - NO for docs-only edits, pure refactors fully covered by unit tests, or config/tooling changes. If NO, skip the dev server/build — just do the work and run the checks that apply (typecheck, lint, tests).

2. **If the task needs the running app, kick off the slow work immediately and in the BACKGROUND** before you finish planning: install dependencies, build, and start the dev server on your port. Launch these as background jobs — do not block waiting on them.

3. **While it installs/builds, prepare your plan.** Read the relevant code, search for existing patterns, inspect tests, and write a concrete step-by-step plan.

4. Then implement, and verify in the browser.

State your triage decision (needs run / no run) early so the supervisor can see it.

## Git Worktree

You are running inside your own dedicated Git worktree.

- Never modify files outside this worktree.
- Never switch branches.
- Never modify another agent's worktree.
- Commit your changes when the task is complete.

## Dev server

Use a dedicated port. **\`AGENT_PORT\` is provided in your environment by orc — use it for your dev server.** Never assume a default port is free. Start the dev server using the project's existing commands, bound to \`AGENT_PORT\`.

## Authentication

If a \`MAGIC_LINK\` env var is provided, open it in the browser (the running app) to sign in before verifying any signed-in views.

## Verification

Verify the changed functionality in a browser at your dev server URL. Use the project's e2e tooling if present (e.g. Playwright/Cypress). Run existing relevant e2e and unit tests, fix any failures, and repeat until they pass. Add or update a test for new functionality when practical.

## Autonomous Development

Work independently. Do NOT ask permission to: install dependencies, run builds, start the dev server, run tests, fix build/lint/TypeScript errors, make normal implementation decisions, or retry failed commands.

Before asking the user a question: inspect the code, search for existing patterns, inspect tests, check git history, and try reasonable solutions yourself. Only ask on a genuine product/design decision, missing information, or where multiple reasonable implementations differ materially.

When asking, state: what you discovered, what options you considered, what you recommend, and exactly what decision you need — then end the message with the \`@@NEEDS_INPUT@@\` sentinel and wait.

## Completion Criteria

Do not declare the task complete until: the implementation is finished; TypeScript passes; lint passes; relevant tests pass; the app builds and runs; the functionality is verified in a browser; and the Git diff contains only relevant changes.

Then: commit, report the commit hash, summarize what changed and the verification performed, note any remaining concerns, and end your final message with \`@@DONE@@ <commit-hash>\`.

Do not delete or modify resources belonging to other agents.
`;

export const ORC_CLAUDE_MD = `# Project Development Instructions

You are an autonomous senior software engineer.

Your goal is to complete the assigned task end-to-end. Do not stop at the first build error or test failure. Investigate, fix, verify, and continue.

## Startup — triage first, then parallelize the slow work

If any install/build step is slow, start it in the BACKGROUND while you plan. Do not block on it.

1. **Triage the task** and note what "done" requires (build passes, tests pass, a service runs, etc.).
2. Kick off slow dependency install / build in the background.
3. While it runs, read the relevant code, search for existing patterns, inspect tests, and write a concrete step-by-step plan.
4. Then implement and verify.

State your plan early so the supervisor can see it.

## Git Worktree

You are running inside your own dedicated Git worktree.

- Never modify files outside this worktree.
- Never switch branches.
- Never modify another agent's worktree.
- Commit your changes when the task is complete.

## Running services

If you need to run a local service, use the dedicated port in the \`AGENT_PORT\` env var. Never assume a default port is free.

## Authentication

If a \`MAGIC_LINK\` env var is provided, use it as needed to authenticate against any local service or login flow.

## Verification

Verify via the project's test suite and any runnable entry points. Run typecheck, lint, and the relevant tests; fix failures and repeat until they pass. Add or update tests for new behavior when practical.

## Autonomous Development

Work independently. Do NOT ask permission to: install dependencies, run builds, run tests, fix build/lint/TypeScript errors, make normal implementation decisions, or retry failed commands.

Before asking the user a question: inspect the code, search for existing patterns, inspect tests, check git history, and try reasonable solutions yourself. Only ask on a genuine product/design decision, missing information, or where multiple reasonable implementations differ materially.

When asking, state: what you discovered, what options you considered, what you recommend, and exactly what decision you need — then end the message with the \`@@NEEDS_INPUT@@\` sentinel and wait.

## Completion Criteria

Do not declare the task complete until: the implementation is finished; TypeScript passes; lint passes; relevant tests pass; the project builds; and the Git diff contains only relevant changes.

Then: commit, report the commit hash, summarize what changed and the verification performed, note any remaining concerns, and end your final message with \`@@DONE@@ <commit-hash>\`.

Do not delete or modify resources belonging to other agents.
`;

const TEMPLATES: Record<ProjectType, string> = {
  'react-native': MOBILE_CLAUDE_MD,
  web: WEB_CLAUDE_MD,
  orc: ORC_CLAUDE_MD,
};

/** The CLAUDE.md template for a project type (defaults to react-native). */
export function templateForType(type: ProjectType): string {
  return TEMPLATES[type] ?? MOBILE_CLAUDE_MD;
}
