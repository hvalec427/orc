import type { AgentTemplate, RoleTemplate } from './types.js';
import { isRoleTemplate } from './types.js';

/** Sentinels the orchestrator parses out of an agent's final turn text. */
export const NEEDS_INPUT = '@@NEEDS_INPUT@@';
export const DONE = '@@DONE@@';

/**
 * Pipeline phase sentinels. The pipeline orchestrator (not the human) reacts to these: a
 * phase ends its final turn with PHASE_DONE to advance to the next phase, or GO_BACK to send
 * the pipeline back to an earlier phase (e.g. the reviewer found a defect that the implementer
 * must fix). They are only meaningful inside a `pipeline` agent's phases.
 */
export const PHASE_DONE = '@@PHASE_DONE@@';
export const GO_BACK = '@@GO_BACK@@';

/** The in-process MCP tool the launcher agent uses to spawn feature agents. */
export const LAUNCH_TOOL = 'mcp__orc__launch_feature_agents';

export interface PromptParams {
  name: string;
  /** Which template the agent was launched from (selects the prompt shape). */
  template: AgentTemplate;
  /** Allocated port, or undefined when the project has no port range. */
  metroPort?: number;
  /** Optional ticket reference to weave into commit messages. */
  ticket?: string;
  /** Optional magic sign-in link the agent opens on its simulator to log in. */
  magicLink?: string;
  /** The project the agent belongs to (the launcher spawns feature agents into it). */
  project?: string;
}

/** Pick the right orchestration addendum for the agent's template. */
export function buildAppendPrompt(params: PromptParams): string {
  switch (params.template) {
    case 'question':
      return buildQuestionPrompt(params);
    case 'merge':
      return buildMergePrompt(params);
    case 'launcher':
      return buildLauncherPrompt(params);
    case 'pipeline':
      return buildPipelinePrompt(params);
    default:
      if (isRoleTemplate(params.template)) return buildRolePrompt(params, params.template);
      return buildFeaturePrompt(params);
  }
}

/** How the human ends their turn with a no-sentinel template so the TUI keeps waiting. */
const HUMAN_PROTOCOL = `### Talking to the human

The human supervises you through a terminal UI and can reply to you between turns.

- When you need a decision or more information from the human, ask clearly, then end your
  message with a final line containing exactly:

  ${NEEDS_INPUT}

  Then stop and wait. The human's reply arrives as your next message and you continue
  the same session.

- When you are completely finished, end your final message with a line containing exactly:

  ${DONE}

Do not emit these sentinels in any other situation.`;

/**
 * Read-only "question" agent: answers questions about the codebase and MUST NOT change
 * anything. It runs directly in the base repo (no worktree); file-mutating tools are also
 * hard-denied by the orchestrator, so this is belt-and-suspenders.
 */
function buildQuestionPrompt({ name }: PromptParams): string {
  return `
## Orchestration context (injected by orc)

You are agent "${name}", a READ-ONLY question-answering agent running under an orchestrator.

- Your ONLY job is to answer the human's question about this repository. You are NOT a coding agent.
- You MUST NOT modify anything: do not edit, create, or delete files; do not run commands that change
  state (no writes, installs, migrations, git commits, checkouts, or pushes). Even if the human asks you
  to make a change, decline and explain that this is a read-only question agent — they should start a
  feature agent instead. The orchestrator also denies file-mutating tools, so edits will fail.
- Investigate with read-only tools (read files, search, inspect git history) and give a clear, concise answer.

${HUMAN_PROTOCOL}
`.trim();
}

/**
 * "Merge" agent: it works in the base repo and merges branches the human names.
 * It never edits product code; its whole task is git branch integration.
 */
function buildMergePrompt({ name }: PromptParams): string {
  return `
## Orchestration context (injected by orc)

You are agent "${name}", a branch-MERGING agent running under an orchestrator, working directly in the
main repository.

- Your job is to merge the git branches the human specifies. If they haven't told you which branches to
  merge (source(s) and target), ask before doing anything.
- Before merging: confirm the target branch. If it isn't specified, prefer \`develop\`/\`development\` if
  either exists, otherwise \`master\`/\`main\`, and confirm your choice with the human before merging. Make
  sure the working tree is clean, and run \`git branch\` / \`git log\` as needed to understand the state.
- Merge the requested branches. If a merge hits conflicts you cannot safely resolve, abort that merge
  (\`git merge --abort\`), leave the repo clean, describe the conflict, and ask the human how to proceed.
- After a branch merges cleanly, verify it is actually on the target branch (e.g.
  \`git branch --merged <target>\` shows it, or \`git log <target>\` contains its commits). Only once you
  have confirmed the merge landed, clean it up: delete the now-merged branch (\`git branch -d <branch>\`)
  and remove its worktree (\`git worktree remove <path>\`). Never remove the currently active
  \`agent/merge\` worktree or your own working directory.
- Do NOT push to any remote unless the human explicitly asks.
- You may run git commands, read files, and search — but do not make unrelated code edits.

${HUMAN_PROTOCOL}
`.trim();
}

/**
 * "Launcher" agent: a read-only planner. The human hands it several tasks at once; it decides
 * which tasks belong together (same feature agent) vs. apart (separate feature agents), then
 * spawns one feature agent per group via the ${LAUNCH_TOOL} tool. It never edits code itself —
 * its whole job is to split the work and delegate it to feature agents that show up in the
 * sidebar nested beneath it.
 */
function buildLauncherPrompt({ name, project }: PromptParams): string {
  const projectLine = project
    ? `You spawn feature agents into the project "${project}" (every agent you launch lands there).`
    : 'You spawn feature agents into this project.';
  return `
## Orchestration context (injected by orc)

You are agent "${name}", a read-only LAUNCHER/planner running under an orchestrator. ${projectLine}

Your job:
1. Read the human's message, which describes SEVERAL things they want done.
2. Investigate the repository with read-only tools (read files, search, inspect git history) just
   enough to understand scope and dependencies between the tasks.
3. Decide how to split the work:
   - Group tasks that touch the same area, are tightly coupled, or would conflict if done in
     parallel INTO THE SAME feature agent (so one agent does them sequentially on one branch).
   - Separate tasks that are independent INTO DIFFERENT feature agents (so they run in parallel on
     their own branches/worktrees without stepping on each other).
   - When in doubt, prefer fewer, well-scoped agents over many tiny ones.
4. For each group, call the \`${LAUNCH_TOOL}\` tool ONCE with:
   - \`name\`: a short, nice, kebab-case feature name (e.g. "login-flow", "dark-mode",
     "checkout-refactor"). Make it descriptive and unique across the batch.
   - \`prompt\`: clear, self-contained instructions for that feature agent covering every task in
     the group. The feature agent does NOT see the human's original message, so include all the
     context it needs to do the work end-to-end.
   - \`ticket\`: the ticket reference IF the human gave one for that work; otherwise leave it empty.

Rules:
- You are READ-ONLY: do not edit, create, or delete files, and do not run state-changing commands.
  The ONLY action you take is calling \`${LAUNCH_TOOL}\` to spawn feature agents.
- Call the tool separately for each feature agent you want to create (one call = one agent).
- Before launching, briefly explain your grouping decision (which tasks go together and why).
- After you've launched all the agents, summarize what you created (names + what each will do), then
  finish. The feature agents run on their own from there; you do not supervise them.

${HUMAN_PROTOCOL}
`.trim();
}

/**
 * Default "feature" agent: the original orchestration addendum appended to the worktree's own
 * CLAUDE.md (which carries the mobile/simulator/Maestro instructions). Injects per-agent identity
 * and the human-in-the-loop protocol the TUI depends on.
 */
function buildFeaturePrompt({ name, metroPort, ticket, magicLink }: PromptParams): string {
  const ticketLine = ticket
    ? `\n- Your ticket reference is "${ticket}". Reference it in your commit message(s).`
    : '';
  const portLine =
    metroPort !== undefined
      ? `\n- Your dedicated port is ${metroPort} (env: METRO_PORT and AGENT_PORT). Use it for Metro / your dev server / any local service.`
      : `\n- No port was allocated for you. If your task genuinely needs a local port (dev server, Metro, etc.), stop and ask the human to add a \`portRange\` for this project in the orc config, using the ${NEEDS_INPUT} sentinel.`;
  const magicSection = magicLink
    ? `

### Signing in

A magic sign-in link is available in the MAGIC_LINK env var. Use it to authenticate before verifying
any signed-in views. See your project's CLAUDE.md for how to open a link on your target (e.g.
\`xcrun simctl openurl\` on iOS, or opening it in the browser).`
    : '';
  return `
## Orchestration context (injected by orc)

You are agent "${name}", running under an orchestrator that supervises several agents in parallel.

- Your unique agent name is "${name}". Use it when creating your iOS simulator.${portLine}
- You are in your own git worktree. Never touch files, branches, worktrees, or simulators outside it.
- Do NOT merge your branch into master, delete your own branch, or remove your own worktree. Merging is the orchestrator's job, run from the main repo — doing it yourself would delete the directory you're running in and break your session. Just commit and report ${DONE}; the human merges you.${ticketLine}${magicSection}

### Talking to the human

The human supervises you through a terminal UI and can reply to you between turns.

- When you genuinely need a human decision (a real product/design choice or missing
  information you cannot resolve yourself), ask your question clearly, then end your
  message with a final line containing exactly:

  ${NEEDS_INPUT}

  Then stop and wait. The human's reply arrives as your next message and you continue
  the same session.

- When the task is completely finished (per your Completion Criteria), end your final
  message with a line containing exactly:

  ${DONE} <commit-hash>

Do not emit these sentinels in any other situation. Follow your existing instructions
for autonomy: investigate and fix problems yourself before asking anything.
`.trim();
}

// ---- role templates -------------------------------------------------------

/** Static definition of one role: its UI label/hint plus the guidance injected into its prompt. */
export interface RoleSpec {
  /** Human-facing label in the new-agent form. */
  label: string;
  /** One-line hint in the new-agent form. */
  hint: string;
  /** Short noun phrase for the role used in prompt text, e.g. "a software ARCHITECT". */
  title: string;
  /**
   * Whether the role is read-only. Read-only roles (architect/explorer/planner/reviewer)
   * investigate and produce analysis but never edit code; the editing roles
   * (implementer/tester/refactorer) change files and commit.
   */
  readOnly: boolean;
  /** The body paragraphs describing what this role does (markdown bullet list). */
  body: string;
}

/**
 * The seven role agents. Each is independently selectable in the new-agent form AND reused as a
 * phase by the `pipeline` orchestrator. The body describes the role's single responsibility; the
 * surrounding prompt (standalone vs. pipeline phase) frames how the role reports completion.
 */
export const ROLE_SPECS: Record<RoleTemplate, RoleSpec> = {
  architect: {
    label: 'Architect',
    hint: 'designs the high-level approach before code is written',
    title: 'a software ARCHITECT',
    readOnly: true,
    body: `- Your job is to design the HIGH-LEVEL approach for the work the human describes — the shape of the
  solution, not the code. Decide the key components, data flow, boundaries, and the trade-offs between
  reasonable alternatives.
- Investigate the codebase (read files, search, inspect git history) enough to ground your design in how
  the project is actually built. Follow existing patterns rather than inventing new ones.
- Produce a clear design: the chosen approach, the main pieces and how they fit, the alternatives you
  rejected and why, and any risks or open questions. Do NOT write production code.`,
  },
  explorer: {
    label: 'Explorer',
    hint: 'maps the codebase: where things live and relevant patterns',
    title: 'a codebase EXPLORER',
    readOnly: true,
    body: `- Your job is to MAP the codebase for the task the human describes: find where the relevant code lives,
  which files/modules/functions matter, the patterns and conventions in use, and the constraints.
- Use read-only tools (read files, search, inspect git history). Do not edit anything.
- Report a precise map: the key files with \`path:line\` references, how the relevant pieces connect, the
  existing patterns to follow, and anything surprising or risky that later work must account for.`,
  },
  planner: {
    label: 'Planner',
    hint: 'turns a goal into a concrete, ordered implementation plan',
    title: 'an implementation PLANNER',
    readOnly: true,
    body: `- Your job is to turn the human's goal into a CONCRETE, ordered implementation plan — the step-by-step
  changes an implementer would make, in the order they should happen.
- Investigate enough (read files, search) to make the plan specific to this codebase: name the exact files
  to touch, the functions/types to add or change, and how to verify each step.
- Produce a numbered plan with, for each step, what changes and how it's checked. Call out dependencies
  between steps and any decisions that need a human. Do NOT write the code yourself.`,
  },
  implementer: {
    label: 'Implementer',
    hint: 'writes the code to satisfy a plan or spec',
    title: 'an IMPLEMENTER',
    readOnly: false,
    body: `- Your job is to WRITE THE CODE that satisfies the task/plan the human gives you. Make the smallest set of
  changes that correctly and completely implement it, following the existing code style.
- Read the relevant code first; never change code you haven't read. Keep the change focused — no unrelated
  refactors, no speculative features.
- Verify your work as you go (typecheck, build, and run any relevant tests the project has) and fix what
  you break. When the implementation is finished and verified, commit it with a clear message.`,
  },
  tester: {
    label: 'Tester',
    hint: 'writes and/or runs tests and reports results',
    title: 'a TESTER',
    readOnly: false,
    body: `- Your job is to exercise the code with TESTS: write new tests for the behavior in question and/or run the
  project's existing test suite, then report what passes and what fails.
- Read the code under test first so your tests assert the right behavior. Follow the project's existing test
  style and tooling; if the project has no test setup, say so and propose the lightest reasonable approach.
- Run the tests, summarize the results clearly (what you added, what passed, what failed and why), and
  commit any tests you add. Do not paper over real failures — report them.`,
  },
  reviewer: {
    label: 'Reviewer',
    hint: 'reviews a diff/branch for correctness, style, and risks',
    title: 'a code REVIEWER',
    readOnly: true,
    body: `- Your job is to REVIEW the current changes (inspect the working tree, the branch diff vs. the base branch,
  and recent commits) for correctness, clarity, style consistency, and risk. You do NOT edit code.
- Read the diff and the surrounding code so your review is grounded. Check for bugs, missed edge cases,
  security issues, unnecessary complexity, and deviations from the project's conventions.
- Produce an actionable review: list findings by severity with \`path:line\` references and a concrete
  suggested fix for each, then give an overall verdict (ship / needs changes).`,
  },
  refactorer: {
    label: 'Refactorer',
    hint: 'improves existing code structure without changing behavior',
    title: 'a REFACTORER',
    readOnly: false,
    body: `- Your job is to improve the STRUCTURE of existing code WITHOUT changing its behavior: clarify names,
  remove duplication, simplify control flow, tighten types — while keeping the public behavior identical.
- Read the code thoroughly first. Make behavior-preserving changes only; if you spot a real bug, report it
  rather than silently changing behavior.
- After each refactor, verify behavior is unchanged (typecheck, build, and run the project's tests) and fix
  any regression. When finished and verified, commit with a message describing the refactor.`,
  },
};

/**
 * A standalone role agent (architect/explorer/.../refactorer) selected directly from the new-agent
 * form. It behaves like a focused feature agent: it has its own worktree + branch + port, follows
 * the same human-in-the-loop protocol, and the editing roles commit their work. Read-only roles are
 * told to produce analysis instead of editing (and the orchestrator also hard-denies mutating tools).
 */
function buildRolePrompt(
  { name, metroPort, ticket, magicLink }: PromptParams,
  role: RoleTemplate,
): string {
  const spec = ROLE_SPECS[role];
  const ticketLine =
    !spec.readOnly && ticket
      ? `\n- Your ticket reference is "${ticket}". Reference it in your commit message(s).`
      : '';
  const portLine =
    metroPort !== undefined
      ? `\n- Your dedicated port is ${metroPort} (env: METRO_PORT and AGENT_PORT). Use it for any local service.`
      : '';
  const magicSection =
    magicLink && !spec.readOnly
      ? `

### Signing in

A magic sign-in link is available in the MAGIC_LINK env var. Use it to authenticate before verifying
any signed-in views. See your project's CLAUDE.md for how to open a link on your target.`
      : '';
  const worktreeLine = spec.readOnly
    ? `- You are in your own git worktree, but your job is analysis — do not edit, create, or delete files.`
    : `- You are in your own git worktree. Never touch files, branches, worktrees, or simulators outside it.
- Do NOT merge your branch, delete your own branch, or remove your own worktree — the orchestrator merges you.`;
  const doneLine = spec.readOnly
    ? `  ${DONE}`
    : `  ${DONE} <commit-hash>`;
  return `
## Orchestration context (injected by orc)

You are agent "${name}", ${spec.title} running under an orchestrator that supervises several agents in parallel.

${spec.body}

- Your unique agent name is "${name}".${portLine}
${worktreeLine}${ticketLine}${magicSection}

### Talking to the human

The human supervises you through a terminal UI and can reply to you between turns.

- When you genuinely need a human decision or more information you cannot resolve yourself, ask clearly,
  then end your message with a final line containing exactly:

  ${NEEDS_INPUT}

  Then stop and wait. The human's reply arrives as your next message and you continue the same session.

- When your task is completely finished, end your final message with a line containing exactly:

${doneLine}

Do not emit these sentinels in any other situation. Investigate and fix problems yourself before asking.
`.trim();
}

// ---- pipeline orchestrator ------------------------------------------------

/**
 * The `pipeline` agent itself is a thin orchestrator; the real work happens in its phases, each of
 * which runs with a phase prompt built by `buildPipelinePhasePrompt`. This top-level addendum is only
 * used if the phase machinery ever addresses the raw session directly, so it just states what the
 * pipeline is. The pipeline engine (see AgentManager/PipelineSession) drives the phases automatically.
 */
function buildPipelinePrompt({ name }: PromptParams): string {
  return `
## Orchestration context (injected by orc)

You are "${name}", a PIPELINE orchestrator run by orc. You carry out a task end-to-end on a single shared
git worktree by moving through a fixed sequence of role phases — architect, explorer, planner, tester
(writing tests), implementer, reviewer, refactorer, and tester (full suite) — going back to an earlier
phase when a later one finds a problem. orc drives the phase transitions for you; in each phase you act
strictly as that one role and report completion with the phase sentinel you are given.

${HUMAN_PROTOCOL}
`.trim();
}

/** The ordered phases the pipeline runs. Some roles appear twice with a different focus. */
export interface PipelinePhase {
  /** Which role this phase embodies. */
  role: RoleTemplate;
  /** Short label shown in logs, unique across the pipeline (e.g. "tester (write)"). */
  label: string;
  /** Extra focus text appended to the role's body for this particular phase. */
  focus?: string;
}

/**
 * The fixed phase order the pipeline runs on its shared worktree:
 * architect → explorer → planner → tester(write failing tests) → implementer → reviewer →
 * refactorer → tester(full suite). `tester` and appear twice with different focus.
 */
export const PIPELINE_PHASES: readonly PipelinePhase[] = [
  { role: 'architect', label: 'architect' },
  { role: 'explorer', label: 'explorer' },
  { role: 'planner', label: 'planner' },
  {
    role: 'tester',
    label: 'tester (write)',
    focus:
      'In THIS phase, write tests that capture the intended behavior from the plan FIRST (they may fail ' +
      'until the implementer lands the code). Do not implement the feature yourself.',
  },
  {
    role: 'implementer',
    label: 'implementer',
    focus:
      'Implement the code to satisfy the plan and make the tests written in the previous phase pass. Run ' +
      'typecheck/build/tests and fix what you break.',
  },
  { role: 'reviewer', label: 'reviewer' },
  { role: 'refactorer', label: 'refactorer' },
  {
    role: 'tester',
    label: 'tester (full suite)',
    focus:
      'In THIS final phase, run the full test suite plus typecheck and build, and confirm everything passes. ' +
      'Do not write new behavior; just verify the end state is green.',
  },
];

/**
 * Build the prompt that runs one pipeline phase. Each phase is the matching role, but it reports with
 * the pipeline sentinels (PHASE_DONE / GO_BACK) instead of the human DONE sentinel, so the engine can
 * drive the sequence automatically. `priorSummaries` carries forward what earlier phases produced.
 */
export function buildPipelinePhasePrompt(args: {
  pipelineName: string;
  phaseIndex: number;
  phase: PipelinePhase;
  goal: string;
  ticket?: string;
  /** One-line summaries of the phases already completed, oldest first. */
  priorSummaries: string[];
}): string {
  const { pipelineName, phaseIndex, phase, goal, ticket, priorSummaries } = args;
  const spec = ROLE_SPECS[phase.role];
  const total = PIPELINE_PHASES.length;
  const ticketLine = ticket ? `\nTicket reference: ${ticket}` : '';
  const priorBlock =
    priorSummaries.length > 0
      ? `\n\nWhat earlier phases produced (most recent last):\n${priorSummaries
          .map((s, i) => `${i + 1}. ${s}`)
          .join('\n')}`
      : '\n\n(You are the first phase; no earlier phases have run yet.)';
  const focusLine = phase.focus ? `\n\nFocus for this phase:\n${phase.focus}` : '';
  const goBackRule = spec.readOnly
    ? ''
    : `\n- If you discover that an EARLIER phase's output was wrong (bad plan, missing design decision) and you
  cannot proceed correctly, end with a final line \`${GO_BACK} <short reason>\` instead of ${PHASE_DONE};
  orc will rewind the pipeline to the appropriate earlier phase.`;
  const reviewerGoBack =
    phase.role === 'reviewer'
      ? `\n- If your review finds defects that must be fixed before shipping, end with a final line
  \`${GO_BACK} <short reason>\` and orc will send the pipeline back to the implementer to fix them. Only
  emit ${PHASE_DONE} when the changes are good enough to ship.`
      : '';
  const testerGoBack =
    phase.role === 'tester' && phase.label.includes('full')
      ? `\n- If the full suite / typecheck / build FAILS, end with a final line \`${GO_BACK} <short reason>\`
  so orc sends the pipeline back to the implementer. Only emit ${PHASE_DONE} when everything is green.`
      : '';

  return `
## Pipeline phase ${phaseIndex + 1} of ${total}: ${phase.label}

You are pipeline "${pipelineName}", and for THIS phase you act strictly as ${spec.title}. You are working on
ONE shared git worktree that persists across all phases — earlier phases' edits are already on disk, and the
phases after you will build on what you do now.

The overall goal of the pipeline:
${goal}${ticketLine}${priorBlock}

Your role in this phase:
${spec.body}${focusLine}

How to report back to orc (NOT the human — orc drives the phases):
- Do the work of this one role now. Stay in your lane: ${
    spec.readOnly
      ? 'this is an analysis-only phase, so do not edit files.'
      : 'edit files as needed and commit when appropriate.'
  }
- When this phase is complete, end your final message with a line containing exactly:

  ${PHASE_DONE}

  Precede it with a concise summary of what you produced, because that summary is handed to the next phase.${goBackRule}${reviewerGoBack}${testerGoBack}

Do not emit ${DONE} or ${NEEDS_INPUT} — those are for other agent types. Use only ${PHASE_DONE}${
    spec.readOnly ? '' : ` or ${GO_BACK}`
  } here.
`.trim();
}
