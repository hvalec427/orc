import type { AgentTemplate, RoleTemplate } from './types.js';
import { needsWorktree } from './types.js';

/** Sentinels the orchestrator parses out of an agent's final turn text. */
export const NEEDS_INPUT = '@@NEEDS_INPUT@@';
export const DONE = '@@DONE@@';

/** The in-process MCP tool the launcher agent uses to spawn feature agents. */
export const LAUNCH_TOOL = 'mcp__orc__launch_feature_agents';

/** The in-process MCP tool the pipeline agent uses to run ONE role step at a time. */
export const RUN_STEP_TOOL = 'mcp__orc__run_pipeline_step';

/** The group coordination MCP tools every agent gets (orchestrator-side + subagent-side). */
export const LIST_SUBAGENTS_TOOL = 'mcp__orc__list_subagents';
export const ASK_SUBAGENT_TOOL = 'mcp__orc__ask_subagent';
export const ANSWER_SUBAGENT_TOOL = 'mcp__orc__answer_subagent';
export const ASK_ORCHESTRATOR_TOOL = 'mcp__orc__ask_orchestrator';

/**
 * The full set of group coordination tool names. They only pass messages between agents in the same
 * group (never touch the codebase), so AgentSession auto-allows them in every permission mode — a
 * read-only agent may still coordinate, and a full-access agent isn't prompted for approval on them.
 */
export const ORCHESTRATION_TOOLS: ReadonlySet<string> = new Set<string>([
  LIST_SUBAGENTS_TOOL,
  ASK_SUBAGENT_TOOL,
  ANSWER_SUBAGENT_TOOL,
  ASK_ORCHESTRATOR_TOOL,
]);

/**
 * Human-facing, one-line responsibility for each role. Reused verbatim in the standalone role
 * prompt (so the agent knows its identity) and summarized into the pipeline prompt (so the
 * pipeline agent knows what each step produces). Kept here as the single source of truth.
 */
export const ROLE_RESPONSIBILITIES: Record<RoleTemplate, string> = {
  architect:
    'own the high-level technical direction: understand the requirements, the existing architecture ' +
    'and the constraints, then make and record the architectural decisions the rest of the work follows',
  explorer:
    'investigate the existing codebase: find the relevant files, trace the flows and dependencies, and ' +
    'explain how the current implementation actually works',
  planner:
    'turn the architectural understanding into a concrete implementation plan: the files to touch, the ' +
    'changes to make, new dependencies, the tests to add, and the risks to watch',
  implementer:
    'execute the plan: write the code, build the app, run the relevant checks, and fix implementation ' +
    'issues until it works',
  tester:
    'verify the implementation: write and run unit, integration and Maestro E2E tests, and report any ' +
    'failures or missing coverage',
  reviewer:
    'review the completed changes for correctness, bugs, architecture, edge cases, security, ' +
    'maintainability and project conventions — without blindly rewriting them',
  refactorer:
    'take the reviewed implementation and clean it up: remove duplication, simplify, and improve ' +
    'structure and readability while preserving behavior',
};

/**
 * The canonical pipeline order (the product spec). Note `tester` appears twice: once up front to
 * write the tests BEFORE the implementation exists (red), and once at the end to run the full suite
 * again after the refactor. Encoded in the pipeline prompt so the pipeline agent runs steps in order.
 */
export const PIPELINE_ORDER: readonly RoleTemplate[] = [
  'architect',
  'explorer',
  'planner',
  'tester',
  'implementer',
  'reviewer',
  'refactorer',
  'tester',
];

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

/**
 * Pick the right orchestration addendum for the agent's template, then append the group-coordination
 * section every agent shares. The coordination tools (ask/answer/list subagent, ask orchestrator) are
 * available to EVERY agent — a top-level agent orchestrates the subagents the human attaches to it
 * with `c`, and any subagent can ask its orchestrator — so the guidance is appended uniformly rather
 * than duplicated into each template builder.
 */
export function buildAppendPrompt(params: PromptParams): string {
  return `${buildTemplatePrompt(params)}\n\n${COORDINATION_SECTION}`;
}

/** The template-specific body of the append prompt (before the shared coordination section). */
function buildTemplatePrompt(params: PromptParams): string {
  switch (params.template) {
    case 'question':
      return buildQuestionPrompt(params);
    case 'merge':
      return buildMergePrompt(params);
    case 'launcher':
      return buildLauncherPrompt(params);
    case 'pipeline':
      return buildPipelinePrompt(params);
    // The seven role templates all share one parameterized builder; it switches between the
    // read-only and full-access guidance based on needsWorktree(role).
    case 'architect':
    case 'explorer':
    case 'planner':
    case 'implementer':
    case 'tester':
    case 'reviewer':
    case 'refactorer':
      return buildRolePrompt(params.template, params);
    default:
      return buildFeaturePrompt(params);
  }
}

/**
 * The group-coordination section appended to EVERY agent's prompt. It explains the two directions of
 * the in-process coordination channel so a group works together without the human relaying messages:
 *   - As an ORCHESTRATOR (you may have subagents attached to you): list them, ask one for its result
 *     (blocks until it finishes its turn), and answer one that is waiting on you.
 *   - As a SUBAGENT (you may have been launched under an orchestrator): ask your orchestrator for a
 *     decision/context and block until it answers.
 * Deliberately phrased so it reads correctly whether or not the agent currently has subagents/parent
 * (the tools are inert no-ops otherwise), since attachment happens dynamically via the TUI's `c`.
 */
const COORDINATION_SECTION = `### Coordinating with your group

You belong to a group: one top-level orchestrator plus the subagents attached to it (the human can
attach a subagent to any agent with \`c\`; subagents share the group's one worktree/branch). You have
in-process tools to coordinate directly, so the group works together without the human relaying every
message. Use them instead of ending your turn when another agent in your group can unblock you.

As an ORCHESTRATOR (when you have subagents):
- \`${LIST_SUBAGENTS_TOOL}\` — list your subagents with their status and latest hand-off summary.
- \`${ASK_SUBAGENT_TOOL}\` — ask ONE subagent (by id) a question or give it an instruction and WAIT for
  its result. Use this to coordinate siblings, gather what another agent produced, or sequence
  editing work (only one agent should edit the shared worktree at a time; read-only agents can run in
  parallel).
- \`${ANSWER_SUBAGENT_TOOL}\` — answer a subagent that is waiting on you (it used ${ASK_ORCHESTRATOR_TOOL});
  provide its id and your answer so it can continue. If a subagent's question needs a human decision,
  ask the human (end your turn with ${NEEDS_INPUT}) and relay their answer back via this tool.

As a SUBAGENT (when you were launched under an orchestrator):
- \`${ASK_ORCHESTRATOR_TOOL}\` — ask your orchestrator a question and WAIT for its answer. Use this when
  you need a decision, context, or data your orchestrator or a sibling has, rather than guessing or
  stopping for the human. If you have no orchestrator, it tells you so and you decide yourself.

These coordination tools only pass messages within your group; they never modify the codebase, so you
may use them even when you are a read-only agent.`;

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

/** The "- Your dedicated port is …" identity line shared by every full-access (worktree) agent. */
function portLine(metroPort?: number): string {
  return metroPort !== undefined
    ? `\n- Your dedicated port is ${metroPort} (env: METRO_PORT and AGENT_PORT). Use it for Metro / your dev server / any local service.`
    : `\n- No port was allocated for you. If your task genuinely needs a local port (dev server, Metro, etc.), stop and ask the human to add a \`portRange\` for this project in the orc config, using the ${NEEDS_INPUT} sentinel.`;
}

/** The "- Your ticket reference is …" line, or empty when no ticket was supplied. */
function ticketLine(ticket?: string): string {
  return ticket
    ? `\n- Your ticket reference is "${ticket}". Reference it in your commit message(s).`
    : '';
}

/** The optional "### Signing in" section, present only when a magic link is available. */
function magicSection(magicLink?: string): string {
  return magicLink
    ? `

### Signing in

A magic sign-in link is available in the MAGIC_LINK env var. Use it to authenticate before verifying
any signed-in views. See your project's CLAUDE.md for how to open a link on your target (e.g.
\`xcrun simctl openurl\` on iOS, or opening it in the browser).`
    : '';
}

/**
 * The full-access human protocol: same NEEDS_INPUT contract as HUMAN_PROTOCOL, but the DONE line
 * carries the commit hash (full-access agents commit their work). Shared by the feature agent and
 * the three full-access roles (implementer/tester/refactorer) so the DONE contract stays identical.
 */
const FEATURE_HUMAN_PROTOCOL = `### Talking to the human

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
for autonomy: investigate and fix problems yourself before asking anything.`;

/**
 * The shared worktree-identity bullets every full-access agent needs: its name/simulator identity,
 * its port, the "stay inside your worktree" rule and the "don't merge/delete your own branch" rule.
 * Factored out so the feature agent and the full-access roles don't copy-paste the whole block.
 */
function featureIdentityBullets({ name, metroPort, ticket }: PromptParams): string {
  return `- Your unique agent name is "${name}". Use it when creating your iOS simulator.${portLine(metroPort)}
- You are in your own git worktree. Never touch files, branches, worktrees, or simulators outside it.
- Do NOT merge your branch into master, delete your own branch, or remove your own worktree. Merging is the orchestrator's job, run from the main repo — doing it yourself would delete the directory you're running in and break your session. Just commit and report ${DONE}; the human merges you.${ticketLine(ticket)}`;
}

/**
 * Default "feature" agent: the original orchestration addendum appended to the worktree's own
 * CLAUDE.md (which carries the mobile/simulator/Maestro instructions). Injects per-agent identity
 * and the human-in-the-loop protocol the TUI depends on.
 */
function buildFeaturePrompt(params: PromptParams): string {
  return `
## Orchestration context (injected by orc)

You are agent "${params.name}", running under an orchestrator that supervises several agents in parallel.

${featureIdentityBullets(params)}${magicSection(params.magicLink)}

${FEATURE_HUMAN_PROTOCOL}
`.trim();
}

/**
 * The structured hand-off summary every role ends its final turn with (just before its DONE/pause).
 * The pipeline agent cannot read a child's transcript, so each role must restate — in plain text —
 * what it produced and what the next role should build on. This keeps the hand-off purely
 * prompt-driven (no IPC/event bus) while giving the pipeline agent something concrete to read.
 */
function roleHandoffSection(role: RoleTemplate): string {
  return `### Hand-off summary (required)

Before you finish, end your final turn with a concise, structured summary titled
"## ${role} summary" so the next role (and the pipeline that supervises you) can build on your work
without reading your transcript. Cover:
- What you produced (decisions, findings, the plan, the code/tests you wrote, the review notes, etc.).
- Anything the next role must know, assumptions you made, and open questions or risks.
- If something you needed from an earlier role was missing or wrong, say so explicitly so the
  pipeline can decide to go back and re-run that earlier role.`;
}

/**
 * Parameterized builder for all seven role templates. Read-only roles
 * (architect/explorer/planner/reviewer) get the question-style "you MUST NOT modify anything"
 * guardrail; full-access roles (implementer/tester/refactorer) get the feature-style worktree
 * identity + DONE <hash> protocol. Both end with the required hand-off summary so they slot into a
 * pipeline. Driven off {@link needsWorktree} and {@link ROLE_RESPONSIBILITIES} so adding/moving a
 * role here stays in one place.
 */
function buildRolePrompt(role: RoleTemplate, params: PromptParams): string {
  const { name } = params;
  const responsibility = ROLE_RESPONSIBILITIES[role];
  const handoff = roleHandoffSection(role);

  if (needsWorktree(role)) {
    // Full-access role: same powers and protocol as a feature agent, scoped to its one responsibility.
    return `
## Orchestration context (injected by orc)

You are agent "${name}", a ${role.toUpperCase()} role agent running under an orchestrator that
supervises several agents in parallel. Your single responsibility is to ${responsibility}.

- Stay focused on the ${role} role: do that job well and do not drift into the other roles' work.
${featureIdentityBullets(params)}
- If you are part of a pipeline, you share a worktree/branch with the other role agents — build on
  the work already there (do not reset it or start a fresh branch).${magicSection(params.magicLink)}

${handoff}

${FEATURE_HUMAN_PROTOCOL}
`.trim();
  }

  // Read-only role: reuse the question agent's hard guardrail language verbatim so the "orchestrator
  // denies mutating tools" contract is identical across every read-only template.
  return `
## Orchestration context (injected by orc)

You are agent "${name}", a READ-ONLY ${role.toUpperCase()} role agent running under an orchestrator.
Your single responsibility is to ${responsibility}.

- You MUST NOT modify anything: do not edit, create, or delete files; do not run commands that change
  state (no writes, installs, migrations, git commits, checkouts, or pushes). Even if asked to make a
  change, decline and explain that this is a read-only ${role} agent — a full-access role (implementer/
  tester/refactorer) should do the editing. The orchestrator also denies file-mutating tools, so edits
  will fail.
- Investigate with read-only tools (read files, search, inspect git history) and deliver your ${role}
  output clearly and concisely. If you are part of a pipeline you are pointed at the shared worktree,
  so you can see the in-progress work of the other roles.

${handoff}

${HUMAN_PROTOCOL}
`.trim();
}

/**
 * "Pipeline" agent: a read-only orchestrator that runs the seven role agents SEQUENTIALLY on ONE
 * shared worktree/branch, handing each role's summary to the next and able to GO BACK and re-run an
 * earlier role when something is missing. Modeled on the launcher: it is read-only except for its
 * single ${RUN_STEP_TOOL} power, which spawns one role agent (nested beneath it) per step. It cannot
 * read a child's transcript, so it relies on each role's required hand-off summary (which each role
 * prompt emits) to decide what the next role should build on.
 */
function buildPipelinePrompt({ name, project }: PromptParams): string {
  const projectLine = project
    ? `You run the pipeline inside the project "${project}" (every role you spawn lands there).`
    : 'You run the pipeline inside this project.';
  // Render the canonical order as a numbered list, annotating the two tester passes so the model
  // understands why tester appears twice (tests-first, then full-suite rerun).
  const orderList = PIPELINE_ORDER.map((role, i) => {
    const note =
      role === 'tester' && i < PIPELINE_ORDER.length - 1
        ? ' (write the tests FIRST, before any implementation exists — they should fail)'
        : role === 'tester'
          ? ' (run the FULL suite again and confirm everything passes after the refactor)'
          : role === 'implementer'
            ? ' (make the tester\u2019s failing tests pass)'
            : '';
    return `  ${i + 1}. ${role}${note}`;
  }).join('\n');

  return `
## Orchestration context (injected by orc)

You are agent "${name}", a read-only PIPELINE orchestrator running under a higher-level orchestrator.
${projectLine}

You drive a fixed sequence of specialist ROLE agents, one at a time, each on the SAME shared
worktree/branch so the tester's tests, the implementer's code and the refactorer's cleanup all build
on each other. You run exactly one role per \`${RUN_STEP_TOOL}\` call and wait for it to finish before
deciding the next step.

Required order (run strictly in this order unless you deliberately go back):
${orderList}

How to run each step:
1. Call \`${RUN_STEP_TOOL}\` with:
   - \`role\`: the role to run (one of architect, explorer, planner, implementer, tester, reviewer,
     refactorer).
   - \`prompt\`: COMPLETE, self-contained instructions for that role. The role agent does NOT see the
     human's original message or any previous role's transcript, so fold in everything it needs —
     especially the hand-off summary text from the previous role(s). Tell it exactly what to build on.
   - \`ticket\`: the ticket reference IF the human gave one; otherwise leave it empty.
2. When the step finishes, read the role's hand-off summary (each role ends its turn with a
   "## <role> summary"). Briefly summarize that hand-off yourself before moving on.
3. Decide the next step:
   - If the result is sufficient, proceed to the next role in the order above.
   - If a role reveals that an earlier role's output was missing, wrong, or insufficient, GO BACK:
     re-run that earlier role with corrected instructions (explain what was missing), then resume the
     sequence from there. Do not plough ahead on a broken foundation.

Rules:
- You are READ-ONLY. The ONLY action you take is calling \`${RUN_STEP_TOOL}\`; you never edit code,
  run builds, or touch git yourself — the role agents do that on the shared worktree.
- Run ONE role per call and wait; never fan out multiple roles in parallel (this is a sequence, not a
  launcher).
- All role agents you spawn share the pipeline's single worktree/branch — do not try to create new
  branches or worktrees per role.
- After the final step passes, summarize the whole run (what each role produced and any go-backs you
  made), then finish. The shared branch is left for the human to merge.

${HUMAN_PROTOCOL}
`.trim();
}
