import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { RoleTemplate } from '../types.js';

/**
 * Result the launcher's spawn callback returns for one feature agent, so the tool can report
 * back to the launcher what actually got created (its final, uniquified name).
 */
export interface LaunchResult {
  id: string;
  name: string;
}

/** Spawns one feature agent; supplied by the AgentSession so the tool can call back into the manager. */
export type LaunchFeature = (args: {
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
    tools: [
      tool(
        'launch_feature_agents',
        'Spawn ONE feature agent to carry out a group of tasks. Call this once per feature agent ' +
          'you want to create. Each agent gets its own git worktree + branch and runs independently. ' +
          'The prompt must be self-contained: the feature agent does not see the human\u2019s original message.',
        {
          name: z
            .string()
            .min(1)
            .describe(
              'Short, nice, kebab-case feature name (e.g. "login-flow", "dark-mode"). ' +
                'Becomes the agent name and its git branch. Keep it unique across this batch.',
            ),
          prompt: z
            .string()
            .min(1)
            .describe(
              'Complete, self-contained instructions for this feature agent covering every task in ' +
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
          try {
            const res = await launch({
              name: args.name,
              prompt: args.prompt,
              ticket: args.ticket ?? '',
            });
            return {
              content: [
                {
                  type: 'text',
                  text: `Launched feature agent "${res.name}" (id: ${res.id}).`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Failed to launch feature agent "${args.name}": ${(err as Error).message}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    ],
  });
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
    tools: [
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
    ],
  });
}
