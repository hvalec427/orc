import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { RoleTemplate } from '../types.js';

/**
 * The agent templates a launcher may spawn for a group of tasks. These are the standalone,
 * top-level templates that make sense to kick off from a prompt — a full-access `feature` agent
 * for new work, a surgical `fix` agent for a bug, a read-only `question` agent for research, or a
 * `pipeline` orchestrator to run the seven roles sequentially on tightly-coupled work. (Merge and
 * the individual role templates are not launchable this way.)
 */
const LAUNCH_TEMPLATES = ['feature', 'fix', 'question', 'pipeline'] as const;

/** One of the templates a launcher may spawn; the `template` arg of its launch tool. */
export type LaunchTemplate = (typeof LAUNCH_TEMPLATES)[number];

/**
 * Result the launcher's spawn callback returns for one feature agent, so the tool can report
 * back to the launcher what actually got created (its final, uniquified name).
 */
export interface LaunchResult {
  id: string;
  name: string;
}

/** Spawns one agent of the chosen template; supplied by the AgentSession so the tool can call back into the manager. */
export type LaunchFeature = (args: {
  template: LaunchTemplate;
  name: string;
  prompt: string;
  ticket: string;
}) => Promise<LaunchResult>;

/** The seven role names the pipeline's run-step tool accepts, matching {@link RoleTemplate}. */
const ROLE_NAMES = [
  'architect',
  'explorer',
  'planner',
  'implementer',
  'tester',
  'reviewer',
  'refactorer',
] as const satisfies readonly RoleTemplate[];

/**
 * Result of running one pipeline role step: the spawned role agent's id/name plus how it finished,
 * so the run-step tool can report the outcome back to the pipeline agent in the same turn.
 */
export interface RunStepResult extends LaunchResult {
  /** The role's terminal status when the step returned: 'done', 'needs_input', 'error' or 'stopped'. */
  status: string;
  /**
   * The role's final turn text (its hand-off summary, or its question when it paused for input).
   * This is how the pipeline — which can't read the child's transcript — learns what the role
   * produced and decides whether to proceed or go back.
   */
  summary: string;
}

/**
 * Runs ONE pipeline role step; supplied by the AgentSession so the tool can call back into the
 * manager. The manager spawns the role agent nested under the pipeline, on the pipeline's shared
 * worktree/branch, WAITS for it to finish, and returns its final name, status and hand-off text.
 */
export type RunPipelineStep = (args: {
  role: RoleTemplate;
  prompt: string;
  ticket: string;
}) => Promise<RunStepResult>;

/** Outcome of a worker cutting+adopting its worktree on demand, reported back to the worker. */
export interface EnsureWorktreeResult {
  /** The adopted branch name (e.g. `agent/<id>`). */
  branch: string;
  /** The worktree's absolute path — the worker's cwd from its next turn on. */
  path: string;
  /** The allocated port, if the project defines a range; undefined otherwise. */
  port?: number;
  /** True when a worktree already existed (idempotent repeat call) rather than being freshly cut. */
  alreadyHad: boolean;
}

/**
 * Cuts and adopts a worktree for a general-purpose `worker` agent on demand; supplied by the
 * AgentSession so the tool can call back into the manager. Idempotent: a second call just reports the
 * worktree the worker already has. The new cwd takes effect on the worker's NEXT turn (adoptWorktree
 * changes where the session relaunches), so the tool tells the worker its edits land there from then.
 */
export type EnsureWorktree = () => Promise<EnsureWorktreeResult>;

/**
 * Build the in-process MCP server that backs the launcher agent's single power: spawning feature
 * agents. The tool name is `launch_feature_agents` on server `orc`, so the fully-qualified tool the
 * model calls is `mcp__orc__launch_feature_agents` (see LAUNCH_TOOL in agentPrompt.ts). Each call
 * creates exactly one feature agent via the supplied `launch` callback and returns its final name.
 */
export function buildLauncherMcpServer(launch: LaunchFeature) {
  return createSdkMcpServer({
    name: 'orc',
    version: '0.1.0',
    tools: buildLauncherTools(launch),
  });
}

/** The launcher's spawn tool(s), as a composable array for sharing one "orc" server with other tools. */
export function buildLauncherTools(launch: LaunchFeature) {
  return [
    tool(
        'launch_feature_agents',
        'Spawn ONE agent to carry out a group of tasks. Call this once per agent you want to ' +
          'create, choosing the template that best fits the group\u2019s work. Each agent runs ' +
          'independently. The prompt must be self-contained: the agent does not see the human\u2019s ' +
          'original message.',
        {
          template: z
            .enum(LAUNCH_TEMPLATES)
            .default('feature')
            .describe(
              'Which kind of agent fits this group: "feature" (full-access task agent in its own ' +
                'worktree+branch, the default for new work), "fix" (surgical bug-fix agent in its own ' +
                'worktree+branch), "question" (read-only research/Q&A agent, no worktree) or ' +
                '"pipeline" (read-only orchestrator that runs the 7 roles sequentially on one shared ' +
                'worktree for large, tightly-coupled work).',
            ),
          name: z
            .string()
            .min(1)
            .describe(
              'Short, nice, kebab-case agent name (e.g. "login-flow", "dark-mode"). ' +
                'Becomes the agent name and its git branch. Keep it unique across this batch.',
            ),
          prompt: z
            .string()
            .min(1)
            .describe(
              'Complete, self-contained instructions for this agent covering every task in ' +
                'the group. Include all context needed to do the work end-to-end.',
            ),
          ticket: z
            .string()
            .default('')
            .describe(
              'Ticket reference for this work (e.g. "PROJ-123") if the human provided one; ' +
                'otherwise an empty string.',
            ),
        },
        async (args) => {
          const template = args.template ?? 'feature';
          try {
            const res = await launch({
              template,
              name: args.name,
              prompt: args.prompt,
              ticket: args.ticket ?? '',
            });
            return {
              content: [
                {
                  type: 'text',
                  text: `Launched ${template} agent "${res.name}" (id: ${res.id}).`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Failed to launch ${template} agent "${args.name}": ${(err as Error).message}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
  ];
}

/**
 * Build the in-process MCP server that backs the pipeline agent's single power: running ONE role
 * step at a time. The tool name is `run_pipeline_step` on server `orc`, so the fully-qualified tool
 * the model calls is `mcp__orc__run_pipeline_step` (see RUN_STEP_TOOL in agentPrompt.ts). Each call
 * spawns exactly one role agent (nested under the pipeline, on its shared worktree/branch) via the
 * supplied `runStep` callback and returns the child's final name. The pipeline is expected to call
 * this strictly one role at a time and wait — the tool itself does not enforce ordering; ordering and
 * go-back logic live in the pipeline prompt.
 */
export function buildPipelineMcpServer(runStep: RunPipelineStep) {
  return createSdkMcpServer({
    name: 'orc',
    version: '0.1.0',
    tools: buildPipelineTools(runStep),
  });
}

/** The pipeline's run-step tool(s), as a composable array for sharing one "orc" server with other tools. */
export function buildPipelineTools(runStep: RunPipelineStep) {
  return [
    tool(
        'run_pipeline_step',
        'Run ONE role agent as the next step of the pipeline, on the pipeline\u2019s shared ' +
          'worktree/branch. Call this once per step and wait for it to finish before deciding the ' +
          'next step. The role agent does not see the human\u2019s original message or prior roles\u2019 ' +
          'transcripts, so the prompt must be self-contained (fold in the previous role\u2019s hand-off).',
        {
          role: z
            .enum(ROLE_NAMES)
            .describe(
              'Which role to run this step: architect, explorer, planner, implementer, tester, ' +
                'reviewer, or refactorer.',
            ),
          prompt: z
            .string()
            .min(1)
            .describe(
              'Complete, self-contained instructions for this role. Include the context it needs — ' +
                'especially the previous role\u2019s hand-off summary and exactly what to build on.',
            ),
          ticket: z
            .string()
            .default('')
            .describe(
              'Ticket reference for this work (e.g. "PROJ-123") if the human provided one; ' +
                'otherwise an empty string.',
            ),
        },
        async (args) => {
          try {
            const res = await runStep({
              role: args.role,
              prompt: args.prompt,
              ticket: args.ticket ?? '',
            });
            // The step ran to a terminal state; report its status + hand-off text so the pipeline can
            // decide whether to proceed to the next role or go back and re-run an earlier one.
            const header =
              res.status === 'done'
                ? `The ${args.role} step (agent "${res.name}") finished.`
                : res.status === 'needs_input'
                  ? `The ${args.role} step (agent "${res.name}") paused to ask the human a question ` +
                    `— relay or resolve it before continuing.`
                  : `The ${args.role} step (agent "${res.name}") ended with status "${res.status}".`;
            return {
              content: [
                {
                  type: 'text',
                  text:
                    `${header}\n\nIts hand-off summary / final message:\n${res.summary || '(no summary text)'}`,
                },
              ],
              isError: res.status === 'error',
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Failed to run ${args.role} step: ${(err as Error).message}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
  ];
}

/**
 * The worker's on-demand worktree tool(s), as a composable array sharing the one "orc" server. The
 * tool name is `create_worktree`, so the fully-qualified tool the model calls is
 * `mcp__orc__create_worktree` (see CREATE_WORKTREE_TOOL in agentPrompt.ts). It takes no arguments:
 * the worker calls it once when a task needs code changes, and the supplied `ensureWorktree` callback
 * cuts+adopts an isolated `agent/<id>` worktree/branch (and allocates a port). The new cwd takes
 * effect on the worker's NEXT turn, so the result text tells the worker to do its edits from there.
 */
export function buildWorkerTools(ensureWorktree: EnsureWorktree) {
  return [
    tool(
      'create_worktree',
      'Cut and adopt your OWN isolated git worktree + branch so you can safely edit code. Call this ' +
        'ONCE, before you make any file changes, when a task requires editing the codebase. Until you ' +
        'call it you run in the project\u2019s base repo with no branch and must NOT edit files there. ' +
        'Takes no arguments. Your working directory becomes the new worktree from your NEXT turn on; ' +
        'make your edits, build, tests and commits there. Calling it again when you already have a ' +
        'worktree is a safe no-op that just reports your existing branch.',
      {},
      async () => {
        try {
          const res = await ensureWorktree();
          const portNote =
            res.port !== undefined
              ? ` A port (${res.port}) is allocated (env METRO_PORT / AGENT_PORT).`
              : '';
          const text = res.alreadyHad
            ? `You already have a worktree on branch "${res.branch}" at ${res.path}. Keep working there.${portNote}`
            : `Created and adopted worktree on branch "${res.branch}" at ${res.path}. From your NEXT ` +
              `turn your working directory is this worktree — make all edits, builds, tests and ` +
              `commits there, and stay inside it.${portNote}`;
          return { content: [{ type: 'text', text }] };
        } catch (err) {
          return {
            content: [
              { type: 'text', text: `Failed to create worktree: ${(err as Error).message}` },
            ],
            isError: true,
          };
        }
      },
    ),
  ];
}
