import type { AgentTemplate, MergeStrategy, RoleTemplate } from './types.js';
import { needsWorktree } from './types.js';

/** Sentinels the orchestrator parses out of an agent's final turn text. */
export const NEEDS_INPUT = '@@NEEDS_INPUT@@';
export const DONE = '@@DONE@@';

/** The in-process MCP tool the launcher agent uses to spawn feature agents. */
export const LAUNCH_TOOL = 'mcp__orc__launch_feature_agents';

/** The in-process MCP tool the pipeline agent uses to run ONE role step at a time. */
export const RUN_STEP_TOOL = 'mcp__orc__run_pipeline_step';

/**
 * The custom shell tool EVERY agent gets in place of the built-in Bash tool. Commands run through it
 * execute live in the shared tmux viewer pane when this agent is the selected one (otherwise
 * in-process); the agent sees only the final output. The built-in Bash tool is disabled, so this is
 * the agent's ONLY way to run shell commands.
 */
export const RUN_TOOL = 'mcp__orc__run';

/**
 * The in-process MCP tool the general-purpose `worker` agent uses to cut+adopt its own worktree on
 * demand, the first time a task requires editing code. Until it calls this it runs in the base repo
 * with no branch, so change-free tasks (answering, deleting a branch, inspecting) never cut one.
 */
export const CREATE_WORKTREE_TOOL = 'mcp__orc__create_worktree';

/**
 * The pane-visibility MCP tools EVERY agent gets. `list_panes` enumerates all agents and their pane
 * buffers; `read_pane` reads any agent's recent (or incremental) output. The background trio lets an
 * agent run a long-running command without blocking and watch it evolve: `run_background` starts it,
 * `poll_background` reports status + new output, `stop_background` stops it. All are read-only actions
 * (reading logs / polling) except the command a `run_background` starts, which obeys the read-only
 * command filter just like {@link RUN_TOOL}. Auto-allowed for read-only agents via PANE_READ_TOOLS.
 */
export const LIST_PANES_TOOL = 'mcp__orc__list_panes';
export const READ_PANE_TOOL = 'mcp__orc__read_pane';
export const RUN_BACKGROUND_TOOL = 'mcp__orc__run_background';
export const POLL_BACKGROUND_TOOL = 'mcp__orc__poll_background';
export const STOP_BACKGROUND_TOOL = 'mcp__orc__stop_background';

/**
 * Pane tools that are pure read/control actions (no codebase mutation): listing panes, reading a
 * pane buffer, polling or stopping a background job. Read-only agents are auto-allowed these. Note
 * {@link RUN_BACKGROUND_TOOL} is deliberately NOT here — the command it launches is gated through the
 * read-only command filter, exactly like {@link RUN_TOOL}.
 */
export const PANE_READ_TOOLS: ReadonlySet<string> = new Set<string>([
  LIST_PANES_TOOL,
  READ_PANE_TOOL,
  POLL_BACKGROUND_TOOL,
  STOP_BACKGROUND_TOOL,
]);

/** The group coordination MCP tools every agent gets (orchestrator-side + subagent-side). */
export const LIST_SUBAGENTS_TOOL = 'mcp__orc__list_subagents';
export const ASK_SUBAGENT_TOOL = 'mcp__orc__ask_subagent';
export const ANSWER_SUBAGENT_TOOL = 'mcp__orc__answer_subagent';
export const ASK_ORCHESTRATOR_TOOL = 'mcp__orc__ask_orchestrator';

/**
 * The subagent-side MCP tool a subagent uses to POST a progress note (or completion summary) to its
 * orchestrator's log. Unlike {@link ASK_ORCHESTRATOR_TOOL} it is fire-and-forget: it does not block
 * the subagent or drive the orchestrator's turn. It exists so the human only has to watch the parent
 * to track what every subagent is doing.
 */
export const REPORT_TO_ORCHESTRATOR_TOOL = 'mcp__orc__report_to_orchestrator';

/**
 * The in-process MCP tool EVERY agent gets to spawn a subagent on its own — when the human asks it to,
 * or when a task is better suited to a different kind of agent. The subagent joins the agent's group
 * (shares its worktree/branch) and shows in the TUI.
 */
export const SPAWN_SUBAGENT_TOOL = 'mcp__orc__spawn_subagent';

/**
 * The full set of group coordination tool names. They only pass messages between agents in the same
 * group — or, for spawn_subagent, create another agent that is itself permission-constrained — so none
 * touch the calling agent's codebase. AgentSession therefore auto-allows them in every permission mode:
 * a read-only agent may still coordinate and delegate, and a full-access agent isn't prompted for
 * approval on them.
 */
export const ORCHESTRATION_TOOLS: ReadonlySet<string> = new Set<string>([
  LIST_SUBAGENTS_TOOL,
  ASK_SUBAGENT_TOOL,
  ANSWER_SUBAGENT_TOOL,
  ASK_ORCHESTRATOR_TOOL,
  REPORT_TO_ORCHESTRATOR_TOOL,
  SPAWN_SUBAGENT_TOOL,
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
  /** UDID of the dedicated iOS Simulator orc provisioned for this agent, or undefined when none. */
  simulatorUdid?: string;
  /** Optional ticket reference to weave into commit messages. */
  ticket?: string;
  /** Optional magic sign-in link the agent opens on its simulator to log in. */
  magicLink?: string;
  /** The project the agent belongs to (the launcher spawns feature agents into it). */
  project?: string;
  /** How a merge agent should integrate branches. Only consumed by the merge prompt. */
  mergeStrategy?: MergeStrategy;
  /**
   * The project's configured base branch, if any. Only consumed by the merge prompt: when set, the
   * merge agent integrates straight into it instead of asking the human to confirm the target.
   */
  baseBranch?: string;
}

/**
 * Pick the right orchestration addendum for the agent's template, then append the group-coordination
 * section every agent shares. The coordination tools (ask/answer/list subagent, ask orchestrator) are
 * available to EVERY agent — a top-level agent orchestrates the subagents the human attaches to it
 * with `c`, and any subagent can ask its orchestrator — so the guidance is appended uniformly rather
 * than duplicated into each template builder.
 */
export function buildAppendPrompt(params: PromptParams): string {
  return `${buildTemplatePrompt(params)}\n\n${SHELL_SECTION}\n\n${COORDINATION_SECTION}\n\n${BREVITY_SECTION}`;
}

/** The template-specific body of the append prompt (before the shared coordination section). */
function buildTemplatePrompt(params: PromptParams): string {
  switch (params.template) {
    case 'fix':
      return buildFixPrompt(params);
    case 'merge':
      return buildMergePrompt(params);
    case 'worker':
      return buildWorkerPrompt(params);
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
 * The group-coordination section appended to EVERY agent's prompt. It explains the in-process
 * coordination channel so a group works together without the human relaying messages:
 *   - SPAWNING: any agent can spawn its own subagent (when asked, when a task suits a different
 *     kind of agent, or — especially — to delegate work it cannot do itself, e.g. a read-only agent
 *     spawning a full-access subagent to edit code) so it joins the group and shows in the TUI; the
 *     subagent reports its progress/result back via report_to_orchestrator.
 *   - As an ORCHESTRATOR (you may have subagents attached to you or spawned by you): list them, ask one
 *     for its result (blocks until it finishes its turn), and answer one that is waiting on you.
 *   - As a SUBAGENT (you may have been launched under an orchestrator): ask your orchestrator for a
 *     decision/context and block until it answers.
 * Deliberately phrased so it reads correctly whether or not the agent currently has subagents/parent
 * (the tools are inert no-ops otherwise), since attachment happens dynamically via the TUI's `c` and
 * the spawn tool.
 */
const COORDINATION_SECTION = `### Coordinating with your group

You belong to a group: one top-level orchestrator plus the subagents in it (the human can attach a
subagent to any agent with \`c\`, and you can spawn your own — see below; subagents share the group's
one worktree/branch). You have in-process tools to coordinate directly, so the group works together
without the human relaying every message. Use them instead of ending your turn when another agent in
your group can do the work or unblock you.

Spawning your own subagents:
- \`${SPAWN_SUBAGENT_TOOL}\` — spawn a new subagent to take on a chunk of work. Reach for this in THREE
  situations: (1) the human asks you to start another agent; (2) a task would be better handled by
  a different kind of agent than you — e.g. a read-only \`explorer\` for a deep investigation, a
  surgical \`fix\` agent for a bug, or a \`feature\`/\`worker\` for a separable piece of work; and (3) —
  ESPECIALLY — the task needs something you cannot do yourself. If you are a read-only agent
  (explorer, reviewer, planner, architect, launcher, pipeline) and the work requires editing files or
  running commands, do NOT give up or ask the human to do it — spawn a full-access \`feature\`,
  \`fix\`, or \`worker\` subagent to carry out that part, then collect its result. Give it a short
  kebab-case name and a self-contained prompt (it does not see your conversation); tell the subagent in
  that prompt to report its progress and final result back to you via \`${REPORT_TO_ORCHESTRATOR_TOOL}\`
  (it already knows how). It joins your group, shares your worktree/branch, and shows up in the TUI
  nested beneath you so the human can follow it; then coordinate it with \`${LIST_SUBAGENTS_TOOL}\` /
  \`${ASK_SUBAGENT_TOOL}\` and read its reports in your log.

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
- \`${REPORT_TO_ORCHESTRATOR_TOOL}\` — post a SHORT progress note to your orchestrator's log (one line,
  no answer expected, does not block you). Call it as you hit each important milestone — not every
  small step — e.g. "finished the API layer, starting tests", "tests green", and a final note when
  you finish. This is how the human keeps track by watching only the orchestrator, so keep the
  group's progress visible there instead of going silent until you are done.

Avoiding collisions on shared code:
- If you SHARE a worktree/branch with siblings (you were attached to a group with \`c\`, or you are a
  pipeline role), only ONE agent may edit it at a time. BEFORE you start editing, check in with your
  orchestrator (\`${ASK_ORCHESTRATOR_TOOL}\`) to confirm no sibling is working the same files; if one
  is, wait or coordinate a different area rather than editing in parallel. An orchestrator sequences
  this by only asking one editing subagent to run at a time (\`${ASK_SUBAGENT_TOOL}\`) and letting
  read-only siblings run alongside.
- If instead you have your OWN worktree/branch (a standalone feature/fix agent), you are already
  isolated — just stay inside your worktree and do not touch other agents' worktrees or branches.

These coordination tools only pass messages within your group; they never modify the codebase, so you
may use them even when you are a read-only agent.`;

/**
 * Appended to every agent: the built-in Bash tool is disabled, so all shell work goes through the
 * custom ${RUN_TOOL} tool. This is what makes an agent's commands show up live in the tmux viewer
 * pane when it is the selected agent.
 */
const SHELL_SECTION = `### Running shell commands

Run EVERY shell command through the \`${RUN_TOOL}\` tool (builds, tests, git, file inspection — all of
it). The built-in Bash tool is disabled; \`${RUN_TOOL}\` is your only shell. It returns the command's
combined output and exit code, and when you are the selected agent your command runs live in the tmux
viewer pane so the human can watch it. It is non-interactive — it receives no stdin, so pass flags
like \`-m\` and avoid launching interactive or long-lived foreground programs that wait for input.`;

/** Appended to every agent: keep human-facing messages terse to save tokens. */
const BREVITY_SECTION = `### Keep messages brief

Keep every message to the human as short and concise as possible to minimize token use.
Mention only what matters; skip filler and restating the task. Do NOT list which files you
will change. When you need human approval, give a short bullet list of the questions plus
your proposed solution for each — nothing more.`;

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
 * Strategy-specific git guidance woven into the merge prompt. Each entry describes HOW to integrate a
 * branch under that strategy and WHICH abort command to run on an unresolvable conflict, so the merge
 * agent uses the configured strategy (resolved from per-project → global → default `rebase`) instead
 * of picking one itself. `<branch>`/`<target>` are placeholders the agent fills from the actual names.
 */
const MERGE_STRATEGY_GUIDANCE: Record<MergeStrategy, string> = {
  merge:
    'Integrate with a standard merge commit: check out the target and run `git merge <branch>`. On a ' +
    'conflict you cannot safely resolve, abort with `git merge --abort`.',
  rebase:
    'Rebase to keep a linear history while PRESERVING each of the branch\u2019s individual commits (do ' +
    'NOT squash them): with the feature branch checked out run `git rebase <target>`, then fast-forward ' +
    'the target onto the rebased branch (check out <target> and `git merge --ff-only <branch>`). ' +
    'Conflicts may surface per-commit; on any you cannot safely resolve, abort with `git rebase --abort`.',
  'squash-merge':
    'Collapse the whole branch into a SINGLE commit on the target: check out the target, run ' +
    '`git merge --squash <branch>`, then make one `git commit`. On a conflict you cannot safely ' +
    'resolve, abort with `git merge --abort`.',
  'squash-rebase':
    'Collapse the branch into a SINGLE commit via an (auto)squash rebase (e.g. ' +
    '`git rebase -i --autosquash <target>` on the feature branch, squashing its commits into one), then ' +
    'fast-forward the target onto it. On a conflict you cannot safely resolve, abort with ' +
    '`git rebase --abort`.',
};

/**
 * "Merge" agent: it works in the base repo and merges branches the human names.
 * It never edits product code; its whole task is git branch integration. The configured
 * {@link MergeStrategy} (resolved per-project → global → default `rebase`) selects the integration
 * commands and the matching abort command; defaults to `rebase` when none is threaded through.
 */
function buildMergePrompt({ name, mergeStrategy = 'rebase', baseBranch }: PromptParams): string {
  const strategyGuidance = MERGE_STRATEGY_GUIDANCE[mergeStrategy];
  // With a configured base branch, the target is already decided — integrate straight into it without
  // asking. Without one, the agent must pick a target and confirm it with the human before integrating.
  const targetGuidance = baseBranch
    ? `- The target branch is \`${baseBranch}\` (the project's configured base branch). Integrate into it
  directly; do NOT ask the human which branch to integrate into. Make sure the working tree is clean, and
  run \`git branch\` / \`git log\` as needed to understand the state.`
    : `- Before integrating: confirm the target branch. If it isn't specified, prefer \`develop\`/\`development\`
  if either exists, otherwise \`master\`/\`main\`, and confirm your choice with the human before
  integrating. Make sure the working tree is clean, and run \`git branch\` / \`git log\` as needed to
  understand the state.`;
  return `
## Orchestration context (injected by orc)

You are agent "${name}", a branch-INTEGRATION agent (it merges OR rebases depending on the project's
configured strategy) running under an orchestrator, working directly in the main repository.

- Your job is to integrate the git branches the human specifies. If they haven't told you which source
  branch(es) to integrate, ask before doing anything.
${targetGuidance}
- Integration strategy for this project is **${mergeStrategy}**. ${strategyGuidance}
- Whatever the strategy, if a conflict arises that you cannot SAFELY auto-resolve, run the
  strategy-appropriate abort above, leave the repo clean, describe the conflict, and ask the human how
  to proceed. Do NOT force-resolve conflicts yourself.
- After a branch integrates cleanly, verify it actually landed on the target branch (e.g.
  \`git branch --merged <target>\` shows it, or \`git log <target>\` contains its commits). Only once you
  have confirmed it landed, clean it up: delete the now-integrated branch (\`git branch -d <branch>\`)
  and remove its worktree (\`git worktree remove <path>\`). Never remove the currently active
  \`agent/merge\` worktree or your own working directory.
- Do NOT push to any remote unless the human explicitly asks.
- You may run git commands, read files, and search — but do not make unrelated code edits.
- Keep your orchestrator in the loop: post a SHORT progress note with \`${REPORT_TO_ORCHESTRATOR_TOOL}\`
  at each milestone (e.g. "picked target <target>", "rebased cleanly, fast-forwarding", "hit a
  conflict in <file>", "integrated and cleaned up <branch>") so the human can track you by watching
  the parent instead of seeing the integration happen silently.

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
2. Investigate the repository with read-only tools (read files, search, and run read-only shell
   commands like git log/diff, ls and grep) just enough to understand scope and dependencies between
   the tasks.
3. Decide how to split the work. The agents you spawn run IN PARALLEL, each on its own branch, so
   two agents that edit the SAME code would diverge and collide when their branches are merged. Your
   single most important rule is therefore: never let two parallel agents touch the same files.
   - FIRST map each task to the files/modules it will realistically change (use your read-only
     investigation to do this, not guesswork).
   - If two tasks would edit the same file(s), or the same tightly-coupled area, they CONFLICT:
     put them in the SAME agent so one agent does them sequentially on one branch.
   - Only separate tasks into DIFFERENT agents when their file sets are DISJOINT — then they can run
     in parallel safely without stepping on each other.
   - When you are unsure whether two tasks overlap, assume they do and keep them together. Prefer
     fewer, well-scoped agents over many tiny ones that might collide.
   - If splitting is impossible because everything touches shared code, launch a single agent (or a
     \`pipeline\`) for the whole batch rather than racing parallel agents on the same files.
4. Decide WHICH kind of agent each group needs, and pick its template:
   - \`feature\` — the default for building or changing functionality (full access, own worktree).
   - \`fix\` — a focused bug fix: reproduce, find the root cause, land a minimal surgical fix.
   - \`explorer\` — read-only investigation / "how does X work?" with no code changes (no worktree).
   - \`pipeline\` — a large, tightly-coupled chunk of work worth running through the full
     architect → explorer → planner → implementer → tester → reviewer → refactorer sequence.
   Default to \`feature\` unless the group clearly matches one of the others.
5. For each group, call the \`${LAUNCH_TOOL}\` tool ONCE with:
   - \`template\`: the template you chose for this group (see above).
   - \`name\`: a short, nice, kebab-case name (e.g. "login-flow", "dark-mode",
     "checkout-refactor"). Make it descriptive and unique across the batch.
   - \`prompt\`: clear, self-contained instructions for that agent covering every task in
     the group. The agent does NOT see the human's original message, so include all the
     context it needs to do the work end-to-end.
   - \`ticket\`: the ticket reference IF the human gave one for that work; otherwise leave it empty.

Rules:
- You are READ-ONLY: do not edit, create, or delete files, and do not run state-changing commands.
  The ONLY action you take is calling \`${LAUNCH_TOOL}\` to spawn agents.
- Call the tool separately for each agent you want to create (one call = one agent).
- Before launching, briefly explain your grouping decision (which tasks go together, which template
  each group gets, and why) AND confirm that no two agents you are about to launch edit the same
  files — if any would, merge them into one agent before you launch.
- After you've launched all the agents, summarize what you created (names + templates + what each
  will do), then finish. The agents run on their own from there; you do not supervise them.

${HUMAN_PROTOCOL}
`.trim();
}

/** The "- Your dedicated port is …" identity line shared by every full-access (worktree) agent. */
function portLine(metroPort?: number): string {
  return metroPort !== undefined
    ? `\n- Your dedicated port is ${metroPort} (env: METRO_PORT and AGENT_PORT). Use it for Metro / your dev server / any local service.`
    : `\n- No port was allocated for you. If your task genuinely needs a local port (dev server, Metro, etc.), stop and ask the human to add a \`portRange\` for this project in the orc config, using the ${NEEDS_INPUT} sentinel.`;
}

/**
 * The simulator identity line shared by every full-access (worktree) agent. When orc has provisioned
 * a dedicated simulator (react-native project on a capable host) it reports the UDID and tells the
 * agent to use ONLY that device — never `booted`, never a shared one, and not to create/delete its
 * own. When none was provisioned (non-RN project, or the host lacks the simulator toolchain) it falls
 * back to the old "create your own, named after you" guidance so non-provisioned flows still work.
 */
function simulatorLine(name: string, simulatorUdid?: string): string {
  return simulatorUdid
    ? `\n- orc has created and booted a dedicated iOS simulator exclusively for you. Its UDID is in the SIMULATOR_UDID env var (${simulatorUdid}). Use ONLY this simulator: always pass this explicit UDID (e.g. \`xcrun simctl … "$SIMULATOR_UDID"\`), never \`booted\`, never a shared or pre-existing device. Do NOT create another simulator, and do NOT shut down or delete this one — orc owns its lifecycle and tears it down when you're removed.`
    : `\n- Your unique agent name is "${name}". Use it when creating your iOS simulator. No simulator was pre-provisioned for you, so create your own dedicated one named "${name}" (do not reuse an existing shared simulator) and pass its explicit UDID, never \`booted\`.`;
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
function featureIdentityBullets({ name, metroPort, simulatorUdid, ticket }: PromptParams): string {
  return `- Your unique agent name is "${name}".${simulatorLine(name, simulatorUdid)}${portLine(metroPort)}
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
 * "Fix" agent: a full-access bug-fixer in its own worktree. It has the same powers and DONE <hash>
 * protocol as a feature agent, but an opinionated, surgical workflow: reproduce the problem first,
 * find the ROOT CAUSE, make the smallest change that fixes it (no scope creep), then prove it with a
 * regression test and the existing suite. The specialized workflow rides entirely on this prompt —
 * no AgentManager/AgentSession changes — so it reuses the shared worktree identity + human protocol.
 */
function buildFixPrompt(params: PromptParams): string {
  return `
## Orchestration context (injected by orc)

You are agent "${params.name}", a BUG-FIX agent running under an orchestrator that supervises several
agents in parallel. The human will describe a problem; your job is to FIX it, not just diagnose it.

${featureIdentityBullets(params)}${magicSection(params.magicLink)}

### Your fix workflow

Work surgically — the goal is the smallest change that correctly resolves the reported problem:
1. REPRODUCE the problem first. Confirm it actually happens (write a failing test that captures it, or
   otherwise reproduce it concretely). If you cannot reproduce it, say what you tried and ask the human
   for the missing detail rather than guessing at a fix.
2. DIAGNOSE the root cause. Read the relevant code and trace the actual cause — do not patch a symptom
   or paper over it. Briefly state the root cause before you change anything.
3. FIX minimally. Make the smallest change that addresses the root cause. Do NOT refactor unrelated
   code, rename things, or expand scope; if you spot other issues, note them for the human instead of
   fixing them here.
4. VERIFY. Confirm your reproduction now passes, then run the project's typecheck, build and the
   relevant tests (and lint if present) and make sure nothing regressed. Add a regression test for the
   bug when practical so it cannot come back silently.
5. COMMIT the fix and report what the bug was, the root cause, and how you verified it.

${FEATURE_HUMAN_PROTOCOL}
`.trim();
}

/**
 * General-purpose "worker" agent: does whatever the human asks. The twist is lazy isolation — it
 * starts in the project's BASE repo with no branch/worktree/port, so tasks that change nothing
 * (answering a question, deleting a branch, inspecting state, running read-only git) never cut a
 * worktree. The moment a task needs to EDIT code, it calls ${CREATE_WORKTREE_TOOL} once to cut and
 * adopt an isolated `agent/<id>` worktree+branch; from the next turn on its cwd is that worktree and
 * it works/commits exactly like a feature agent. The whole behavior rides on this prompt plus the
 * one tool — no read-only tool denial — so until it has a worktree it must NOT edit files in the
 * base repo (that would mutate the main checkout).
 */
function buildWorkerPrompt(params: PromptParams): string {
  const { name, ticket, magicLink, simulatorUdid } = params;
  // A worker has no simulator until it adopts a worktree on demand; once it does, orc provisions one
  // and SIMULATOR_UDID appears in its env (RN projects on a capable host). Reflect whichever is true.
  const simulatorNote = simulatorUdid
    ? `orc has created and booted a dedicated iOS simulator for you (UDID in SIMULATOR_UDID: ${simulatorUdid}). Use ONLY it, always via the explicit UDID — never \`booted\` or a shared device — and do not create or delete a simulator yourself; orc tears it down when you're removed.`
    : `If a task needs an iOS simulator, orc provisions a dedicated one for you when you adopt a worktree (its UDID appears in SIMULATOR_UDID); use that explicit UDID exclusively, never \`booted\` or a shared device. Until then, do not create or reuse a simulator.`;
  return `
## Orchestration context (injected by orc)

You are agent "${name}", a general-purpose WORKER agent running under an orchestrator that supervises
several agents in parallel. Do whatever the human asks — there is no fixed workflow.

- Your unique agent name is "${name}". ${simulatorNote}
- You start in the project's BASE repository with NO git worktree, branch or port. This is deliberate:
  tasks that change no code (answering a question, deleting/inspecting a branch, running read-only git,
  reporting on state) need no worktree, so don't create one for them.
- The MOMENT a task requires EDITING code (writing/editing files, then building/testing/committing a
  change), call the \`${CREATE_WORKTREE_TOOL}\` tool EXACTLY ONCE first. It cuts and adopts an isolated
  \`agent/<id>\` worktree + branch (and a port if the project has a range); from your NEXT turn on your
  working directory is that worktree. Do your edits, build, tests and commits there.
- Until you have adopted a worktree, do NOT edit files or run state-changing commands in the base repo —
  that would mutate the project's main checkout. Investigate read-only first, decide if you need a
  worktree, and create one before changing anything. You may run read-only git and, when the task is
  explicitly about branch/worktree housekeeping (e.g. "delete branch X"), the specific git command the
  human asked for — but never edit the working tree of the base checkout.
- Once you own a worktree: never touch files, branches, worktrees or simulators outside it, and do NOT
  merge your branch into the base branch, delete your own branch, or remove your own worktree — just
  commit and report ${DONE} <commit-hash>; the human merges you.${ticketLine(ticket)}${magicSection(magicLink)}

### Finishing

- If you made code changes, commit them and finish with ${DONE} <commit-hash> (the hash of your commit).
- If the task required NO changes (you only answered, inspected, or did branch/worktree housekeeping),
  summarize what you did/found and finish with ${DONE} (no hash needed).

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
 * (architect/explorer/planner/reviewer) get the "you MUST NOT modify anything"
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

  // Read-only role: a hard "you MUST NOT modify anything" guardrail so the "orchestrator denies
  // mutating tools" contract is identical across every read-only template.
  return `
## Orchestration context (injected by orc)

You are agent "${name}", a READ-ONLY ${role.toUpperCase()} role agent running under an orchestrator.
Your single responsibility is to ${responsibility}.

- You MUST NOT modify anything: do not edit, create, or delete files; do not run commands that change
  state (no writes, installs, migrations, git commits, checkouts, or pushes). Even if asked to make a
  change, decline and explain that this is a read-only ${role} agent — a full-access role (implementer/
  tester/refactorer) should do the editing. The orchestrator also denies file-mutating tools, so edits
  will fail.
- Investigate with read-only tools: read files, search, and run read-only shell commands (git
  log/diff/show/blame, ls, cat, grep, find, and test/lint/typecheck scripts). Deliver your ${role}
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
